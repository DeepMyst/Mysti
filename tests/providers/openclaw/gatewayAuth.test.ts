import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createPublicKey, verify } from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async original => {
  const actual = await original<typeof import('os')>();
  const homedir = () => fixture.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import { readOpenClawToken } from '../../../src/utils/platform';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';

const environmentKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
  'OPENCLAW_AGENT_DIR', 'OPENCLAW_TEST_FAST', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR',
  'PI_CODING_AGENT_DIR', 'OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const providers: TestableOpenClawProvider[] = [];
const configPath = () => path.join(fixture.home, '.openclaw/openclaw.json');
function config(token: unknown) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ gateway: { auth: { token } } }));
}
function provider() { const p = new TestableOpenClawProvider(); providers.push(p); return p; }
beforeEach(() => {
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-gateway-auth-'));
  for (const key of environmentKeys) vi.stubEnv(key, '');
  clearMockConfig();
});
afterEach(() => {
  providers.splice(0).forEach(p => p.dispose());
  vi.unstubAllEnvs(); clearMockConfig();
  fs.rmSync(fixture.home, { recursive: true, force: true }); fixture.home = '';
});

describe('OpenClaw gateway credential readiness', () => {
  it('recognizes a configured gateway token without local backend credentials', async () => {
    config('synthetic-config-token'); const p = provider();
    const connect = vi.spyOn((p as any)._gateway, 'connect');
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    expect((await p.checkAuthentication()).authenticated).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });
  it('recognizes a configured token added after provider creation, then its removal', async () => {
    const p = provider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    config('synthetic-new-token'); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    config(''); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  });
  it.each(['configuration', 'environment'])('ignores %s gateway credentials when gateway transport is disabled', async source => {
    if (source === 'configuration') config('synthetic-config-token');
    else vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'synthetic-env-token');
    setMockConfig('openclawUseGateway', false); const p = provider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    setMockConfig('openclawUseGateway', true);
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  });
  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'])('keeps local %s readiness when gateway is disabled', async key => {
    setMockConfig('openclawUseGateway', false); vi.stubEnv(key, 'synthetic-backend-key');
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it.each([undefined, null, '', ' \n\t', 123, {}, []])('rejects unavailable token %j', async token => {
    config(token);
    expect(readOpenClawToken()).toBeUndefined();
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
  });
  it('normalizes configured tokens and keeps their priority over the environment', () => {
    config('  synthetic-config-token \n'); vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'synthetic-env-token');
    expect(readOpenClawToken()).toBe('synthetic-config-token');
  });
  it('falls back to a normalized environment token when the configured token is blank', async () => {
    config('  '); vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', '  synthetic-env-token \n');
    expect(readOpenClawToken()).toBe('synthetic-env-token');
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it('rejects a blank environment token with no config', () => {
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', ' \n\t'); expect(readOpenClawToken()).toBeUndefined();
  });
});

async function loopback(run: (f: { url: string; frames: any[]; accept: (token: string | undefined) => void;
  dropConnections(): void }) => Promise<void>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const frames: any[] = [], errors: string[] = [];
  const sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let expectedToken: string | undefined, serverClosed = false;
  server.on('connection', socket => {
    const state = { closed: false, settled: Promise.resolve() };
    state.settled = new Promise(resolve => socket.once('close', () => { state.closed = true; resolve(); }));
    sockets.push(state);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); frames.push(frame);
        const ok = frame.method === 'connect' && frame.params?.auth?.token === expectedToken;
        socket.send(JSON.stringify({ type: 'res', id: frame.id, ok,
          ...(ok ? { payload: { type: 'hello-ok', protocol: 4 } } : { error: { code: 'AUTH_TOKEN_MISMATCH' } }),
        }));
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-auth-nonce' } }));
  });
  try {
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await run({ url, frames, accept: token => { expectedToken = token; },
      dropConnections: () => { for (const socket of server.clients) socket.close(); } });
    expect(errors).toEqual([]);
  } finally {
    providers.splice(0).forEach(p => p.dispose());
    for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => {
      serverClosed = true; if (error) reject(error); else resolve();
    })), ...sockets.map(socket => socket.settled)]);
    const receipt = process.env.PB07_GATEWAY_AUTH_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ methods: frames.map(frame => frame.method),
      serverClosed, allSocketsClosed: sockets.every(socket => socket.closed), errors, nativeGatewayRequests: 0 }) + '\n');
    expect(serverClosed).toBe(true); expect(sockets.every(socket => socket.closed)).toBe(true);
  }
}
function verifySignature(frame: any) {
  const { device, auth, scopes } = frame.params;
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(device.publicKey, 'base64url')]), type: 'spki', format: 'der' });
  const payload = ['v3', device.id, 'cli', 'cli', 'operator', scopes.join(','), device.signedAt,
    auth.token || '', device.nonce, process.platform, ''].join('|');
  expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(device.signature, 'base64url'))).toBe(true);
}
it('uses current credentials after construction, rotation and removal in actual handshakes', async () => {
  await loopback(async f => {
    setMockConfig('openclawGatewayUrl', f.url); config('synthetic-old-token');
    const p = provider(), gateway = (p as any)._gateway;
    // Fail before initialize if a configuration mock ever routes outside this fixture.
    expect(gateway._url).toBe(f.url);
    for (const token of ['synthetic-new-token', 'synthetic-rotated-token', undefined]) {
      config(token); f.accept(token); await p.initialize();
      expect(gateway.isConnected()).toBe(true);
      expect(f.frames.at(-1).params.auth.token).toBe(token); verifySignature(f.frames.at(-1));
      gateway.disconnect();
    }
    expect(f.frames).toHaveLength(3);
  });
}, 15000);

it('recognizes an established token-free connection only while gateway use is enabled', async () => {
  await loopback(async f => {
    setMockConfig('openclawGatewayUrl', f.url); const p = provider(), gateway = (p as any)._gateway;
    expect(gateway._url).toBe(f.url); f.accept(undefined);
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    await p.initialize(); expect(gateway.isConnected()).toBe(true);
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    setMockConfig('openclawUseGateway', false); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    setMockConfig('openclawUseGateway', true); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    gateway.disconnect(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  });
}, 15000);

it('reloads the token on automatic reconnect after the server drops the connection', async () => {
  await loopback(async f => {
    setMockConfig('openclawGatewayUrl', f.url); config('synthetic-initial-token'); f.accept('synthetic-initial-token');
    const p = provider(), gateway = (p as any)._gateway;
    expect(gateway._url).toBe(f.url);
    await p.initialize(); expect(gateway.isConnected()).toBe(true); expect(f.frames).toHaveLength(1);
    config('synthetic-reconnect-token'); f.accept('synthetic-reconnect-token'); f.dropConnections();
    await vi.waitFor(() => {
      expect(f.frames).toHaveLength(2); expect(gateway.isConnected()).toBe(true);
    }, { timeout: 5000, interval: 20 });
    expect(f.frames[1].params.auth.token).toBe('synthetic-reconnect-token'); verifySignature(f.frames[1]);
  });
}, 10000);

it('uses one token snapshot for both the async device signature and connect request', async () => {
  await loopback(async f => {
    let token = 'synthetic-before-signing'; f.accept(token);
    const signedTokens: Array<string | undefined> = [];
    const gateway = new OpenClawGateway(f.url, undefined, async challenge => {
      signedTokens.push(challenge.token); await Promise.resolve(); token = 'synthetic-after-signing';
      return { nonce: challenge.nonce, signature: 'synthetic-signature' };
    }, () => token);
    try {
      expect((gateway as any)._url).toBe(f.url);
      expect(await gateway.connect()).toBe(true);
      expect(signedTokens).toEqual(['synthetic-before-signing']);
      expect(f.frames[0].params.auth.token).toBe('synthetic-before-signing');
    } finally { gateway.disconnect(); }
  });
}, 15000);
