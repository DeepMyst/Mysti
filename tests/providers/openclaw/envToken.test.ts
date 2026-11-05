import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createPublicKey, verify } from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async original => {
  const actual = await original<typeof import('os')>();
  const homedir = () => fixture.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});
import { readOpenClawToken } from '../../../src/utils/platform';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

const environmentKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
  'OPENCLAW_AGENT_DIR', 'OPENCLAW_TEST_FAST', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR',
  'PI_CODING_AGENT_DIR', 'OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OWNED_GATEWAY_KEY'];
const providers: TestableOpenClawProvider[] = [];
let root: string;
let previousFolders: typeof vscode.workspace.workspaceFolders;
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
}
function provider() { const p = new TestableOpenClawProvider(); providers.push(p); return p; }
const defaultState = () => path.join(fixture.home, '.openclaw');
beforeEach(() => {
  previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-env-token-'));
  fixture.home = path.join(root, 'home'); fs.mkdirSync(fixture.home);
  for (const key of environmentKeys) vi.stubEnv(key, '');
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
});
afterEach(() => {
  (vscode.workspace as any).workspaceFolders = previousFolders;
  providers.splice(0).forEach(p => p.dispose()); vi.unstubAllEnvs();
  clearMockConfig();
  fixture.home = ''; fs.rmSync(root, { recursive: true, force: true });
});

function tokenConfig(value: unknown, secrets?: unknown) {
  const file = path.join(defaultState(), 'openclaw.json');
  write(file, JSON.stringify({ gateway: { auth: { token: value } }, ...(secrets ? { secrets } : {}) }));
}
const ref = { source: 'env', provider: 'default', id: 'OWNED_GATEWAY_KEY' };

it.each(['$OWNED_GATEWAY_KEY', '${OWNED_GATEWAY_KEY}', 'secretref-env:OWNED_GATEWAY_KEY', '__env__:OWNED_GATEWAY_KEY', ref,
  { source: 'env', id: 'OWNED_GATEWAY_KEY' }])('resolves the exported gateway reference %j', value => {
  vi.stubEnv('OWNED_GATEWAY_KEY', '  synthetic-resolved-token  '); tokenConfig(value);
  expect(readOpenClawToken()).toBe('synthetic-resolved-token');
});

it.each(['$OWNED_GATEWAY_KEY', '${OWNED_GATEWAY_KEY}', 'secretref-env:OWNED_GATEWAY_KEY', '__env__:OWNED_GATEWAY_KEY'])('does not send an unresolved reference %s as the actual credential', value => {
  tokenConfig(value); expect(readOpenClawToken()).toBeUndefined();
  vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'owned-fallback'); expect(readOpenClawToken()).toBe('owned-fallback');
});

it('uses an explicitly configured env provider alias and its allowlist', () => {
  vi.stubEnv('OWNED_GATEWAY_KEY', 'owned-allowed');
  tokenConfig({ ...ref, provider: 'shared' }, { providers: { shared: { source: 'env', allowlist: ['OWNED_GATEWAY_KEY'] } } });
  expect(readOpenClawToken()).toBe('owned-allowed');
});

it('uses the configured default env provider for shorthand and legacy objects', () => {
  vi.stubEnv('OWNED_GATEWAY_KEY', 'owned-default');
  for (const value of ['$OWNED_GATEWAY_KEY', { source: 'env', id: 'OWNED_GATEWAY_KEY' }]) {
    tokenConfig(value, { defaults: { env: 'local' }, providers: { local: { source: 'env', allowlist: ['OWNED_GATEWAY_KEY'] } } });
    expect(readOpenClawToken()).toBe('owned-default');
  }
});

it('resolves embedded config environment substitutions before reading the token', () => {
  vi.stubEnv('OWNED_GATEWAY_KEY', 'part'); tokenConfig('prefix-${OWNED_GATEWAY_KEY}-suffix');
  expect(readOpenClawToken()).toBe('prefix-part-suffix');
});

it('updates readiness on the same provider after reference rotation and removal', async () => {
  setMockConfig('openclawUseGateway', true); tokenConfig(ref); const p = provider();
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  vi.stubEnv('OWNED_GATEWAY_KEY', 'owned-first'); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  expect(readOpenClawToken()).toBe('owned-first');
  vi.stubEnv('OWNED_GATEWAY_KEY', 'owned-second'); expect(readOpenClawToken()).toBe('owned-second');
  vi.stubEnv('OWNED_GATEWAY_KEY', ''); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});


it.each([
  ['denied by allowlist', ref, { providers: { default: { source: 'env', allowlist: [] } } }],
  ['wrong provider source', ref, { providers: { default: { source: 'file', path: '/not-read' } } }],
  ['unknown alias', { ...ref, provider: 'unknown' }, undefined],
  ['invalid alias', { ...ref, provider: 'Bad Alias' }, undefined],
  ['invalid env id', { ...ref, id: '../SECRET' }, undefined],
  ['malformed allowlist', ref, { providers: { default: { source: 'env', allowlist: 'OWNED_GATEWAY_KEY' } } }],
  ['extra canonical fields', { ...ref, extra: true }, undefined],
  ['file secret provider', { source: 'file', provider: 'default', id: '/token' }, undefined],
  ['exec secret provider', { source: 'exec', provider: 'default', id: 'token' }, undefined],
])('does not resolve %s or borrow arbitrary credentials', (_name, value, secrets) => {
  vi.stubEnv('OWNED_GATEWAY_KEY', 'must-not-use'); tokenConfig(value, secrets);
  expect(readOpenClawToken()).toBeUndefined(); vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'owned-explicit-fallback');
  expect(readOpenClawToken()).toBe('owned-explicit-fallback');
});

it.each(['', ' ', '\t\n'])('treats missing/blank env material %j as unavailable', value => {
  vi.stubEnv('OWNED_GATEWAY_KEY', value); tokenConfig(ref);
  expect(readOpenClawToken()).toBeUndefined();
});

it('preserves literal token priority and never mutates the process environment or configuration', () => {
  vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'fallback'); vi.stubEnv('OWNED_GATEWAY_KEY', 'exported');
  tokenConfig('literal', { providers: { default: { source: 'env', allowlist: [] } } });
  const before = fs.readFileSync(path.join(defaultState(), 'openclaw.json'), 'utf8');
  expect(readOpenClawToken()).toBe('literal'); expect(process.env.OWNED_GATEWAY_KEY).toBe('exported');
  expect(fs.readFileSync(path.join(defaultState(), 'openclaw.json'), 'utf8')).toBe(before);
});

it('falls back instead of sending a partially expanded token with missing variables', () => {
  tokenConfig('prefix-${OWNED_GATEWAY_KEY}-suffix'); expect(readOpenClawToken()).toBeUndefined();
  vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'fallback'); expect(readOpenClawToken()).toBe('fallback');
});

it('keeps referenced gateway credentials out of local-only auth readiness', async () => {
  vi.stubEnv('OWNED_GATEWAY_KEY', 'owned-gateway-only'); tokenConfig(ref); setMockConfig('openclawUseGateway', false);
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
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
    const receipt = process.env.PB07_ENV_TOKEN_RECEIPT;
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

it('uses resolved references and rotated credentials in actual public provider handshakes and signatures', async () => {
  await loopback(async f => {
    setMockConfig('openclawUseGateway', true); setMockConfig('openclawGatewayUrl', f.url); tokenConfig(ref);
    const p = provider(), gateway = (p as any)._gateway; expect(gateway._url).toBe(f.url);
    for (const token of ['owned-env-first', 'owned-env-second']) {
      vi.stubEnv('OWNED_GATEWAY_KEY', token); f.accept(token); await p.initialize();
      expect(gateway.isConnected()).toBe(true); expect(f.frames.at(-1).params.auth.token).toBe(token);
      verifySignature(f.frames.at(-1)); gateway.disconnect();
    }
    vi.stubEnv('OWNED_GATEWAY_KEY', ''); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    expect(f.frames).toHaveLength(2);
  });
}, 15000);

it('reloads a referenced credential on automatic reconnect', async () => {
  await loopback(async f => {
    setMockConfig('openclawUseGateway', true); setMockConfig('openclawGatewayUrl', f.url); tokenConfig('$OWNED_GATEWAY_KEY');
    vi.stubEnv('OWNED_GATEWAY_KEY', 'owned-before-drop'); f.accept('owned-before-drop');
    const p = provider(), gateway = (p as any)._gateway; expect(gateway._url).toBe(f.url);
    await p.initialize(); expect(gateway.isConnected()).toBe(true);
    vi.stubEnv('OWNED_GATEWAY_KEY', 'owned-after-drop'); f.accept('owned-after-drop'); f.dropConnections();
    await vi.waitFor(() => { expect(f.frames).toHaveLength(2); expect(gateway.isConnected()).toBe(true); }, { timeout: 5000 });
    expect(f.frames[1].params.auth.token).toBe('owned-after-drop'); verifySignature(f.frames[1]);
  });
}, 10000);
