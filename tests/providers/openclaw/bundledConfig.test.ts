import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { runInNewContext } from 'vm';
import { inspect } from 'node:util';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import type { Configuration } from 'webpack';
import type { ChildProcess } from 'node:child_process';
import { applyStreamText } from '../../../src/utils/streamText';
import type { StreamChunk } from '../../../src/types';
import * as vscode from '../../helpers/mockVscode';

const requireLocal = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = requireLocal('webpack') as typeof import('webpack');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-bundled-openclaw-'));
const home = path.join(directory, 'home');
const configPath = path.join(home, '.openclaw/openclaw.json');
const agentDir = path.join(home, '.openclaw/agents/main/agent');
const fixtureEnv = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, '.openclaw'),
  OPENCLAW_HOME: home, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_AGENT_DIR: agentDir, OPENCLAW_TEST_FAST: '',
  LITECLAW_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
  OPENCLAW_GATEWAY_TOKEN: 'synthetic-environment-token', ANTHROPIC_API_KEY: '', ANTHROPIC_OAUTH_TOKEN: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' };
let readToken: () => string | undefined;
let Provider: new (context: unknown) => {
  initialize(): Promise<void>;
  enhancePrompt(prompt: string): Promise<string>;
  checkAuthentication(): Promise<{ authenticated: boolean; user?: string }>;
  dispose(): void;
};
let ProviderWithoutSqlite: typeof Provider;
let spawnEnhancementChild: ((command: string, args: string[], options: any) => ChildProcess) | undefined;

beforeAll(async () => {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'auth-profiles.json'), JSON.stringify({ profiles: {
    'owned:default': { type: 'api_key', provider: 'anthropic', key: 'synthetic-profile-token' },
  } }));
  // Production module resolution selects JSON5's ESM entry. Source-only tests
  // resolve its CommonJS entry, which also offers named exports.
  const base = requireLocal(path.join(process.cwd(), 'webpack.config.js'))[0] as Configuration;
  const config: Configuration = {
    ...base, mode: 'production', devtool: false,
    entry: { platform: path.join(process.cwd(), 'src/utils/platform.ts'),
      provider: path.join(process.cwd(), 'src/providers/openclaw/OpenClawProvider.ts') },
    output: { ...base.output, path: directory, filename: '[name].cjs' },
    module: { ...base.module, rules: base.module!.rules!.map(rule => {
      if (!rule || typeof rule !== 'object' || !Array.isArray(rule.use)) return rule;
      return { ...rule, use: rule.use.map(loader => typeof loader === 'object'
        ? { ...loader, options: { ...(loader.options as object), transpileOnly: true } } : loader) };
    }) },
  };
  await new Promise<void>((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => compiler.close(closeError => {
      if (error || closeError || stats?.hasErrors()) reject(error || closeError || new Error(stats?.toString({ all: false, errors: true })));
      else resolve();
    }));
  });
  const load = (name: string, sqliteAvailable = true) => {
    const module = { exports: {} as any };
    runInNewContext(fs.readFileSync(path.join(directory, name + '.cjs'), 'utf8'), {
      module, exports: module.exports,
      process: Object.create(process, { env: { value: fixtureEnv } }),
      Buffer, AbortController, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval,
      require: (id: string) => {
        if (id === 'node:sqlite' && !sqliteAvailable) throw new Error('Owned fixture: SQLite unavailable');
        if (id === 'child_process' || id === 'node:child_process') {
          const actual = requireLocal(id);
          return { ...actual, spawn: (command: string, args: string[], options: any) =>
            spawnEnhancementChild ? spawnEnhancementChild(command, args, options) : actual.spawn(command, args, options) };
        }
        return id === 'vscode' ? vscode
          : id === 'os' || id === 'node:os' ? { ...os, homedir: () => home } : requireLocal(id);
      },
    });
    return module.exports;
  };
  readToken = load('platform').readOpenClawToken;
  Provider = load('provider').OpenClawProvider;
  ProviderWithoutSqlite = load('provider', false).OpenClawProvider;
}, 60_000);
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
beforeEach(() => vscode.setMockConfig('openclawPath', path.join(directory, 'unavailable-fixture-cli')));

it('loads a JSON5 gateway token from the production bundle ahead of the environment fallback', () => {
  fs.writeFileSync(configPath, `{ // owned fixture\n gateway: { auth: { token: 'synthetic-config-token', }, }, endpoint: 'https://example.invalid/v1', }`);
  expect(readToken()).toBe('synthetic-config-token');
});

it('preserves the environment fallback for invalid or token-free configuration', () => {
  for (const text of ['{ invalid', '{ gateway: {} }']) {
    fs.writeFileSync(configPath, text);
    expect(readToken()).toBe('synthetic-environment-token');
  }
});

it('reads the configured account label with the production provider bundle', async () => {
  fs.writeFileSync(configPath, `{ // owned fixture\n email: 'owned@example.invalid', }`);
  const provider = new Provider({ subscriptions: [], secrets: {
    get: async () => undefined, store: async () => {}, delete: async () => {},
  } });
  try {
    expect(await provider.checkAuthentication()).toMatchObject({ authenticated: true, user: 'owned@example.invalid' });
  } finally { provider.dispose(); }
});

it('uses a relocated configuration for both token and account label in the production bundle', async () => {
  const selected = path.join(directory, 'selected/config.json5');
  fs.mkdirSync(path.dirname(selected), { recursive: true });
  fs.writeFileSync(selected, `{ email: 'relocated@example.invalid', gateway: { auth: { token: 'synthetic-relocated-token' } } }`);
  fixtureEnv.OPENCLAW_CONFIG_PATH = selected;
  const provider = new Provider({ subscriptions: [], secrets: {
    get: async () => undefined, store: async () => {}, delete: async () => {},
  } });
  try {
    expect(readToken()).toBe('synthetic-relocated-token');
    expect(await provider.checkAuthentication()).toMatchObject({ authenticated: true, user: 'relocated@example.invalid' });
  } finally { provider.dispose(); fixtureEnv.OPENCLAW_CONFIG_PATH = configPath; }
});

it('rejects metadata-only credentials and recovers after OAuth setup in the production bundle', async () => {
  const store = path.join(agentDir, 'auth-profiles.json');
  const previousStore = fs.readFileSync(store, 'utf8');
  const previousToken = fixtureEnv.OPENCLAW_GATEWAY_TOKEN;
  fixtureEnv.OPENCLAW_GATEWAY_TOKEN = '  ';
  fs.writeFileSync(configPath, '{ email: "owned@example.invalid" }');
  fs.writeFileSync(store, JSON.stringify({ version: 1, lastGood: { anthropic: 'owned' } }));
  const provider = new Provider({ subscriptions: [], secrets: {
    get: async () => undefined, store: async () => {}, delete: async () => {},
  } });
  try {
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
    fs.writeFileSync(store, JSON.stringify({ profiles: { owned: {
      type: 'oauth', provider: 'anthropic', refresh: 'synthetic-refresh', expires: 1,
    } } }));
    expect(await provider.checkAuthentication()).toMatchObject({ authenticated: true, user: 'owned@example.invalid' });
    fs.writeFileSync(store, JSON.stringify({ profiles: { owned: { type: 'oauth', provider: 'anthropic' } } }));
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
  } finally {
    provider.dispose(); fixtureEnv.OPENCLAW_GATEWAY_TOKEN = previousToken;
    fs.writeFileSync(store, previousStore);
  }
});

it('recognizes gateway-only credentials with the production provider bundle', async () => {
  const store = path.join(agentDir, 'auth-profiles.json');
  const previousStore = fs.readFileSync(store, 'utf8');
  const previousToken = fixtureEnv.OPENCLAW_GATEWAY_TOKEN;
  fixtureEnv.OPENCLAW_GATEWAY_TOKEN = '';
  fs.writeFileSync(store, JSON.stringify({ profiles: {} }));
  fs.writeFileSync(configPath, `{ gateway: { auth: { token: 'synthetic-gateway-only-token' } } }`);
  const provider = new Provider({ subscriptions: [], secrets: {
    get: async () => undefined, store: async () => {}, delete: async () => {},
  } });
  try {
    expect((await provider.checkAuthentication()).authenticated).toBe(true);
    vscode.setMockConfig('openclawUseGateway', false);
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
    vscode.setMockConfig('openclawUseGateway', true);
    fs.writeFileSync(configPath, '{ gateway: {} }');
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
  } finally {
    provider.dispose(); vscode.clearMockConfig();
    fixtureEnv.OPENCLAW_GATEWAY_TOKEN = previousToken; fs.writeFileSync(store, previousStore);
  }
});

it('reads a configured agent SQLite store in the production bundle and handles unavailable SQLite', async () => {
  const mainStore = path.join(agentDir, 'auth-profiles.json'), previousStore = fs.readFileSync(mainStore, 'utf8');
  const previousToken = fixtureEnv.OPENCLAW_GATEWAY_TOKEN;
  fixtureEnv.OPENCLAW_GATEWAY_TOKEN = ''; vscode.setMockConfig('openclawUseGateway', false);
  fs.writeFileSync(mainStore, JSON.stringify({ profiles: {} }));
  fs.writeFileSync(configPath, `{ agents: { list: [{ id: 'writer', default: true, agentDir: '~/configured-agent' }] } }`);
  const selected = path.join(home, 'configured-agent'); fs.mkdirSync(selected);
  const value = JSON.stringify({ profiles: { owned: { type: 'api_key', provider: 'anthropic', key: 'synthetic-sqlite-key' } } });
  fs.writeFileSync(path.join(selected, 'auth-profiles.json'), value);
  const database = new DatabaseSync(path.join(selected, 'openclaw-agent.sqlite'));
  database.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)');
  const update = database.prepare('INSERT OR REPLACE INTO auth_profile_store VALUES (?, ?)');
  update.run('primary', value);
  const context = { subscriptions: [], secrets: {
    get: async () => undefined, store: async () => {}, delete: async () => {},
  } };
  const provider = new Provider(context), unsupported = new ProviderWithoutSqlite(context);
  try {
    expect((await provider.checkAuthentication()).authenticated).toBe(true);
    expect((await unsupported.checkAuthentication()).authenticated).toBe(false);
    update.run('primary', JSON.stringify({ profiles: {} }));
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
  } finally {
    provider.dispose(); unsupported.dispose(); database.close(); vscode.clearMockConfig();
    fixtureEnv.OPENCLAW_GATEWAY_TOKEN = previousToken; fs.writeFileSync(mainStore, previousStore);
    fs.rmSync(selected, { recursive: true, force: true });
  }
});

it('keeps relative CLI readiness and gateway configuration in their respective directories in the production bundle', async () => {
  const workspace = path.join(directory, 'workspace');
  const relativeConfig = 'selected/openclaw.json';
  const selectedDir = path.join(workspace, 'selected-agent');
  fs.mkdirSync(path.join(workspace, 'selected'), { recursive: true });
  fs.mkdirSync(selectedDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, relativeConfig), JSON.stringify({
    email: 'workspace@example.invalid', agents: { list: [{ id: 'writer', agentDir: 'selected-agent' }] },
  }));
  fs.writeFileSync(path.join(selectedDir, 'auth-profiles.json'), JSON.stringify({ profiles: {
    owned: { type: 'api_key', provider: 'anthropic', key: 'synthetic-workspace-key' },
  } }));
  const previousFolders = vscode.workspace.workspaceFolders;
  const previousConfig = fixtureEnv.OPENCLAW_CONFIG_PATH, previousToken = fixtureEnv.OPENCLAW_GATEWAY_TOKEN;
  const mainStore = path.join(agentDir, 'auth-profiles.json'), previousStore = fs.readFileSync(mainStore);
  // The inherited main store must not mask a wrong relative agent path.
  fs.writeFileSync(mainStore, JSON.stringify({ profiles: {} }));
  fixtureEnv.OPENCLAW_CONFIG_PATH = relativeConfig; fixtureEnv.OPENCLAW_GATEWAY_TOKEN = '';
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'owned', index: 0 }];
  vscode.setMockConfig('openclawUseGateway', false);
  const provider = new Provider({ subscriptions: [], secrets: {
    get: async () => undefined, store: async () => {}, delete: async () => {},
  } });
  try {
    expect(await provider.checkAuthentication()).toMatchObject({ authenticated: true, user: 'workspace@example.invalid' });
    fs.writeFileSync(path.join(selectedDir, 'auth-profiles.json'), JSON.stringify({ profiles: {} }));
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
    // Gateway configuration still belongs to the extension client, including
    // its account label; enabling it must not adopt the workspace config.
    fixtureEnv.OPENCLAW_CONFIG_PATH = path.relative(process.cwd(), configPath);
    fs.writeFileSync(configPath, '{ email: "gateway@example.invalid", gateway: { auth: { token: "synthetic-gateway-token" } } }');
    vscode.setMockConfig('openclawUseGateway', true);
    expect(readToken()).toBe('synthetic-gateway-token');
    expect(await provider.checkAuthentication()).toMatchObject({ authenticated: true, user: 'gateway@example.invalid' });
  } finally {
    provider.dispose(); vscode.clearMockConfig();
    (vscode.workspace as any).workspaceFolders = previousFolders;
    fixtureEnv.OPENCLAW_CONFIG_PATH = previousConfig; fixtureEnv.OPENCLAW_GATEWAY_TOKEN = previousToken;
    fs.writeFileSync(mainStore, previousStore);
  }
});

it.each(['literal', 'shorthand', 'object'])('sends the latest configured %s token in a real loopback handshake through the bundled provider', async form => {
  fs.writeFileSync(configPath, `{ gateway: { auth: { token: 'synthetic-stale-token' } } }`);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const frames: any[] = [], errors: string[] = [];
  let serverClosed = false;
  const sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  server.on('connection', socket => {
    const state = { closed: false, settled: Promise.resolve() };
    state.settled = new Promise(resolve => socket.once('close', () => { state.closed = true; resolve(); }));
    sockets.push(state);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); frames.push(frame);
        socket.send(JSON.stringify({ type: 'res', id: frame.id,
          ok: frame.method === 'agent' || (frame.method === 'connect' && frame.params?.auth?.token === 'synthetic-config-token'),
          payload: frame.method === 'agent' ? { text: 'Owned bundled enhancement' } : { type: 'hello-ok', protocol: 4 },
        }));
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-bundle-challenge' } }));
  });
  const ownedGatewayUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', ownedGatewayUrl);
  vscode.setMockConfig('openclawUseGateway', true);
  const secrets = new Map<string, string>();
  const provider = new Provider({ subscriptions: [], secrets: {
    get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); },
  } });
  const env = fixtureEnv as NodeJS.ProcessEnv, previousKey = env.OWNED_BUNDLE_GATEWAY_KEY;
  try {
    // Assert the constructed destination before permitting any connection.
    expect((provider as any)._gateway._url).toBe(ownedGatewayUrl);
    env.OWNED_BUNDLE_GATEWAY_KEY = 'synthetic-config-token';
    const token = form === 'literal' ? 'synthetic-config-token' : form === 'shorthand' ? '$OWNED_BUNDLE_GATEWAY_KEY'
      : { source: 'env', provider: 'owned', id: 'OWNED_BUNDLE_GATEWAY_KEY' };
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token } },
      secrets: { providers: { owned: { source: 'env', allowlist: ['OWNED_BUNDLE_GATEWAY_KEY'] } } } }));
    await provider.initialize();
    expect(errors).toEqual([]); expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ method: 'connect', params: {
      auth: { token: 'synthetic-config-token' }, device: { nonce: 'owned-bundle-challenge' },
    } });
    expect(typeof frames[0].params.device.signature).toBe('string');
    expect(secrets.size).toBe(1);
    expect(await provider.enhancePrompt('Owned draft')).toBe('Owned bundled enhancement');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ method: 'agent', params: {
      modelRun: true, promptMode: 'none', cleanupBundleMcpOnRunEnd: true, thinking: 'off',
    } });
  } finally {
    provider.dispose();
    for (const socket of server.clients) socket.terminate();
    const closedServer = new Promise<void>((resolve, reject) => server.close(error => {
      serverClosed = true; if (error) reject(error); else resolve();
    }));
    await Promise.all([closedServer, ...sockets.map(socket => socket.settled)]);
    if (previousKey === undefined) delete env.OWNED_BUNDLE_GATEWAY_KEY; else env.OWNED_BUNDLE_GATEWAY_KEY = previousKey;
    vscode.clearMockConfig();
    const receipt = process.env.PB07_OPENCLAW_BUNDLE_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({
      tokenForm: form,
      methods: frames.map(frame => frame.method),
      configuredTokenUsed: frames[0]?.params?.auth?.token === 'synthetic-config-token',
      serverClosed, allSocketsClosed: sockets.every(socket => socket.closed), errors, nativeGatewayRequests: 0,
    }) + '\n');
  }
  expect(serverClosed).toBe(true); expect(sockets.every(socket => socket.closed)).toBe(true);
}, 15000);

function writePrivacyProfile(dir: string, source: string, key: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const store = { profiles: { 'owned:default': { type: 'api_key', provider: 'owned', key } } };
  if (source === 'sqlite-profile') {
    const db = new DatabaseSync(path.join(dir, 'openclaw-agent.sqlite'));
    try { db.exec('CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL)'); db.prepare('INSERT OR REPLACE INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify(store)); } finally { db.close(); }
  } else fs.writeFileSync(path.join(dir, 'auth-profiles.json'), JSON.stringify(store));
}

it.each(['environment', 'backend-config', 'json-profile', 'sqlite-profile'])('redacts a split rotated %s credential from public CLI diagnostics through the production bundle', async source => {
  const key = 'synthetic_bundled_openclaw_old_credential', replacement = 'synthetic_bundled_openclaw_new_credential';
  const stored = source.endsWith('-profile'), profileDir = path.join(directory, 'privacy-cli-' + source);
  const profileConfig = (value: string) => ({ agents: { list: [{ id: 'owned', default: true, agentDir: profileDir }] }, models: { providers: { owned: { apiKey: stored ? 'owned:default' : value } } } });
  const previousFolders = vscode.workspace.workspaceFolders;
  const env = fixtureEnv as NodeJS.ProcessEnv, previousKey = env.MYSTI_OPENCLAW_TEST_TOKEN;
  if (stored) writePrivacyProfile(profileDir, source, key);
  if (source === 'environment') env.MYSTI_OPENCLAW_TEST_TOKEN = key;
  else { delete env.MYSTI_OPENCLAW_TEST_TOKEN; fs.writeFileSync(configPath, JSON.stringify(profileConfig(key))); }
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  vscode.setMockConfig('openclawUseGateway', false);
  const logs = ['log', 'error', 'warn'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  const actual = requireLocal('child_process') as typeof import('child_process');
  let child: ChildProcess | undefined, close: unknown, closed: Promise<void> | undefined;
  spawnEnhancementChild = (_command, args, options) => {
    if (source !== 'environment') expect(Object.values(options.env)).not.toContain(key);
    const message = `HTTP 401 Unauthorized: ${key}; current ${replacement}`;
    const script = `const msg=${JSON.stringify(message)};process.stdout.write(JSON.stringify({type:'text',content:'Useful partial reply'})+'\\n');process.stderr.write(msg.slice(0,35));setTimeout(()=>process.stderr.write(msg.slice(35),()=>{process.exitCode=7}),25);`;
    child = actual.spawn(process.execPath, ['-e', script, '--', ...args], { ...options, env: { PATH: process.env.PATH } });
    closed = new Promise(resolve => child!.once('close', (code, signal) => { close = { code, signal }; resolve(); }));
    return child;
  };
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).getCliPath = () => '/owned/openclaw';
  (provider as any).buildPromptAsync = async () => 'Owned bundle privacy request';
  const tracker = { registerProcess: () => { env.MYSTI_OPENCLAW_TEST_TOKEN = replacement; if (source !== 'environment') fs.writeFileSync(configPath, JSON.stringify(profileConfig(replacement))); if (stored) writePrivacyProfile(profileDir, source, replacement); }, clearProcess() {} };
  const chunks: StreamChunk[] = [];
  const stream = (provider as any).sendMessage('Owned bundle privacy request', [], {
    provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual',
  }, null, undefined, 'owned-bundle-privacy', tracker) as AsyncGenerator<StreamChunk>;
  try {
    for await (const chunk of stream) chunks.push(chunk);
    await closed; expect(close).toEqual({ code: 7, signal: null });
    expect(chunks).toContainEqual({ type: 'text', content: 'Useful partial reply' });
    expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([{
      type: 'auth_error', content: 'OpenClaw exited with code 7.\nHTTP 401 Unauthorized: [REDACTED]; current [REDACTED]', authCommand: 'openclaw onboard', providerName: 'OpenClaw',
    }]);
    const visible = JSON.stringify([...logs.flatMap(log => log.mock.calls), chunks]);
    expect(visible).not.toContain(key); expect(visible).not.toContain(replacement);
    expect(visible).not.toContain(key.slice(0, 12));
  } finally {
    provider.dispose();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed; await stream.return(undefined as never);
    spawnEnhancementChild = undefined; logs.forEach(log => log.mockRestore()); vscode.clearMockConfig();
    (vscode.workspace as any).workspaceFolders = previousFolders;
    if (previousKey === undefined) delete env.MYSTI_OPENCLAW_TEST_TOKEN; else env.MYSTI_OPENCLAW_TEST_TOKEN = previousKey;
    const receipt = process.env.PB07_BUNDLE_PRIVACY_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ pid: child?.pid, close, allChildrenClosed: close !== undefined,
      nativeProviderCliInvocations: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it.each(['gateway-token', 'backend-key', 'json-profile', 'sqlite-profile'])('redacts %s failures through the public production bundle while preserving partial replies', async credential => {
  const oldToken = 'owned-bundle-gateway-🔑-old-token', newToken = 'owned-bundle-gateway-new-token';
  const privateData = 'owned-bundle-private-request';
  const stored = credential.endsWith('-profile'), profileDir = path.join(directory, 'privacy-gateway-' + credential);
  const oldSecret = credential !== 'gateway-token' ? 'owned-bundle-backend-secret-old' : oldToken;
  const newSecret = credential !== 'gateway-token' ? 'owned-bundle-backend-secret-new' : newToken;
  const configure = (token: string, secret: string) => {
    if (stored) writePrivacyProfile(profileDir, credential, secret);
    fs.writeFileSync(configPath, JSON.stringify({ agents: { list: [{ id: 'owned', default: true, agentDir: profileDir }] }, gateway: { auth: { token } }, models: { providers: { owned: { apiKey: stored ? 'owned:default' : secret } } } }));
  };
  configure(oldToken, oldSecret);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const frames: any[] = [], errors: string[] = [];
  const sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let serverClosed = false;
  server.on('connection', socket => {
    const state = { closed: false, settled: Promise.resolve() };
    state.settled = new Promise(resolve => socket.once('close', () => { state.closed = true; resolve(); }));
    sockets.push(state);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); frames.push(frame);
        if (frame.method === 'agent') {
          configure(newToken, newSecret);
          for (const payload of [
            { stream: 'assistant', data: { delta: 'Useful partial reply' } },
            { type: 'tool_result', is_error: true, content: { message: `Rejected ${oldSecret}`, request: privateData } },
          ]) socket.send(JSON.stringify({ type: 'event', event: 'agent', payload: { ...payload, sessionKey: frame.params.sessionKey } }));
          socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: false,
            error: { message: { message: `Unauthorized ${oldSecret}`, request: privateData } } }));
        } else socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: frame.params?.auth?.token === oldToken,
          payload: { type: 'hello-ok', protocol: 4 } }));
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-privacy-challenge' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', url); vscode.setMockConfig('openclawUseGateway', true);
  const logs = ['log', 'error', 'warn'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).buildPromptAsync = async () => 'Owned bundled gateway request';
  const gateway = (provider as any)._gateway;
  const chunks: StreamChunk[][] = [];
  const collect = async () => {
    const result: StreamChunk[] = [];
    for await (const chunk of (provider as any).sendMessage('Owned request', [], {
      provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual',
    }, null, undefined, 'owned-bundle-gateway-privacy')) result.push(chunk);
    chunks.push(result); return result;
  };
  try {
    expect(gateway._url).toBe(url); await provider.initialize();
    expect(gateway.isConnected()).toBe(true);
    const result = await collect();
    expect(result).toContainEqual({ type: 'text', content: 'Useful partial reply' });
    expect(result.find(c => c.type === 'tool_result')?.toolCall).toMatchObject({ output: 'Rejected [REDACTED]', status: 'failed' });
    expect(result.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([{
      type: 'auth_error', content: 'Unauthorized [REDACTED]', authCommand: 'openclaw onboard', providerName: 'OpenClaw',
    }]);
    expect(result.filter(c => c.type === 'done')).toHaveLength(1);
    expect(Object.keys(frames[1].params).sort()).toEqual(['idempotencyKey', 'message', 'sessionKey', 'thinking']);
    // Exercise the provider catch boundary with a raw exception from the same
    // issuing connection, without a second native or fixture request.
    gateway.sendAgentMessage = async function* () {
      yield { type: 'text', content: 'Second partial reply' };
      throw Object.assign(new Error(`Unauthorized ${credential !== 'gateway-token' ? newSecret : oldToken}`), { request: privateData });
    };
    const caught = await collect();
    expect(caught).toContainEqual({ type: 'text', content: 'Second partial reply' });
    expect(caught.filter(c => c.type === 'auth_error')).toEqual([{
      type: 'auth_error', content: 'Unauthorized [REDACTED]', authCommand: 'openclaw onboard', providerName: 'OpenClaw',
    }]);
    expect(caught.filter(c => c.type === 'done')).toHaveLength(1);
    const visible = inspect([logs.flatMap(log => log.mock.calls), chunks], { depth: 20 });
    for (const secret of [oldToken, newToken, oldSecret, newSecret, privateData]) expect(visible).not.toContain(secret);
    expect(errors).toEqual([]); expect(frames.map(f => f.method)).toEqual(['connect', 'agent']);
  } finally {
    provider.dispose();
    for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => {
      serverClosed = true; if (error) reject(error); else resolve();
    })), ...sockets.map(socket => socket.settled)]);
    logs.forEach(log => log.mockRestore()); vscode.clearMockConfig();
    if (process.env.PB07_BUNDLE_GATEWAY_PRIVACY_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_GATEWAY_PRIVACY_RECEIPT,
      JSON.stringify({ serverClosed, allSocketsClosed: sockets.every(s => s.closed), errors,
        methods: frames.map(f => f.method), nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
  expect(serverClosed).toBe(true); expect(sockets.every(s => s.closed)).toBe(true);
}, 15000);

it('completes simultaneous local enhancements through the production bundle with real owned children', async () => {
  const previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  vscode.setMockConfig('openclawUseGateway', false);
  const children: Array<{ proc: ChildProcess; args: string[]; cwd: string; closed: Promise<void>; close?: unknown }> = [];
  const actual = requireLocal('child_process') as typeof import('child_process');
  spawnEnhancementChild = (_command, args, options) => {
    const text = `Owned bundled enhancement ${children.length}: أهلاً 🌟`;
    const raw = JSON.stringify({ ok: true, capability: 'model.run', transport: 'local', outputs: [{ text }] });
    const script = `const bytes=Buffer.from(${JSON.stringify(raw)}),split=bytes.indexOf(Buffer.from('🌟'))+1;process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),75);`;
    const proc = actual.spawn(process.execPath, ['-e', script, '--', ...args], { ...options, env: { PATH: process.env.PATH } });
    const row = { proc, args, cwd: options.cwd, closed: Promise.resolve(), close: undefined as unknown };
    row.closed = new Promise(resolve => proc.once('close', (code, signal) => { row.close = { code, signal }; resolve(); }));
    children.push(row); return proc;
  };
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  const calls = [provider.enhancePrompt('Owned draft one'), provider.enhancePrompt('Owned draft two')];
  try {
    expect(await Promise.all(calls)).toEqual(['Owned bundled enhancement 0: أهلاً 🌟', 'Owned bundled enhancement 1: أهلاً 🌟']);
    expect(children).toHaveLength(2);
    await Promise.all(children.map(row => row.closed));
    for (const row of children) {
      expect(row.close).toEqual({ code: 0, signal: null }); expect(row.cwd).toBe(directory);
      expect(row.args.slice(0, 3)).toEqual(['infer', 'model', 'run']); expect(row.args).toContain('--local');
      expect(row.args).not.toContain('agent');
    }
  } finally {
    provider.dispose();
    for (const row of children) if (row.proc.exitCode === null && row.proc.signalCode === null) row.proc.kill('SIGKILL');
    await Promise.all(children.map(row => row.closed)); await Promise.allSettled(calls);
    spawnEnhancementChild = undefined; vscode.clearMockConfig(); (vscode.workspace as any).workspaceFolders = previousFolders;
    const receipt = process.env.PB07_BUNDLE_ENHANCEMENT_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ children: children.map(({ proc, args, cwd, close }) => ({ pid: proc.pid, args, cwd, close })),
      allChildrenClosed: children.every(row => row.close !== undefined), nativeCliInvocations: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it('receives native tools and final envelopes through the public bundle and classifies failed authentication', async () => {
  const token = 'owned-bundle-native-tools-token';
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token } } }));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const requests: any[] = [], errors: string[] = [], sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let requestCount = 0, serverClosed = false;
  server.on('connection', socket => {
    let caps: string[] = [];
    const row = { closed: false, settled: Promise.resolve() };
    row.settled = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        const reply = (payload: unknown) => socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
        if (frame.method === 'connect') { caps = frame.params.caps; reply({ type: 'hello-ok', protocol: 4 }); return; }
        const runId = `owned-bundle-run-${++requestCount}`;
        reply({ runId, status: 'accepted' });
        const event = (stream: string, data: unknown) => socket.send(JSON.stringify({ type: 'event', event: 'agent',
          payload: { runId, sessionKey: frame.params.sessionKey, stream, data } }));
        if (!frame.params.modelRun && caps.includes('tool-events')) {
          event('tool', { phase: 'start', toolCallId: 'same-tool', name: 'read', args: { path: 'owned.txt' } });
          event('tool', { phase: 'result', toolCallId: 'same-tool', isError: requestCount === 2,
            result: { content: [{ type: 'text', text: requestCount === 2 ? `Failed ${token}` : 'File contents' }] } });
        }
        if (requestCount === 2) event('lifecycle', { phase: 'error', error: `HTTP 401 Unauthorized: ${token}` });
        reply({ runId, status: 'ok', summary: 'completed', result: { payloads: requestCount === 2 ? []
          : [{ text: frame.params.modelRun ? 'Enhanced native draft' : 'Native final reply' }] } });
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-native-tools-challenge' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', url); vscode.setMockConfig('openclawUseGateway', true);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).buildPromptAsync = async () => 'Owned native protocol request';
  const collect = async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of (provider as any).sendMessage('Owned request', [], {
      provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual',
    }, null, undefined, 'owned-native-tools-panel')) chunks.push(chunk);
    return chunks;
  };
  try {
    expect((provider as any)._gateway._url).toBe(url); await provider.initialize();
    const first = await collect();
    expect(first.find(c => c.type === 'tool_use')?.toolCall).toMatchObject({ name: 'read', input: { path: 'owned.txt' }, status: 'running' });
    expect(first.find(c => c.type === 'tool_result')?.toolCall).toMatchObject({ name: 'read', input: { path: 'owned.txt' }, output: 'File contents', status: 'completed' });
    expect(first).toContainEqual({ type: 'text', content: 'Native final reply' });
    expect(first.filter(c => c.type === 'done')).toHaveLength(1);
    const second = await collect();
    expect(second.find(c => c.type === 'tool_result')?.toolCall).toMatchObject({ name: 'read', status: 'failed', output: 'Failed [REDACTED]' });
    expect(second.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([{
      type: 'auth_error', content: 'HTTP 401 Unauthorized: [REDACTED]', authCommand: 'openclaw onboard', providerName: 'OpenClaw',
    }]);
    expect(JSON.stringify(second)).not.toContain(token);
    expect(await provider.enhancePrompt('Owned draft')).toBe('Enhanced native draft');
    expect(requests[0].params.caps).toContain('tool-events');
    expect(requests.at(-1).params).toMatchObject({ modelRun: true, promptMode: 'none', cleanupBundleMcpOnRunEnd: true });
    expect(errors).toEqual([]); expect(requestCount).toBe(3);
  } finally {
    provider.dispose(); for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => {
      serverClosed = true; if (error) reject(error); else resolve();
    })), ...sockets.map(s => s.settled)]);
    vscode.clearMockConfig();
    if (process.env.PB07_BUNDLE_NATIVE_EVENTS_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_NATIVE_EVENTS_RECEIPT,
      JSON.stringify({ serverClosed, allSocketsClosed: sockets.every(s => s.closed), errors, methods: requests.map(r => r.method), nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it.each(['cli', 'gateway'])('preserves native usage and model metadata through the production %s bundle', async transport => {
  const previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  vscode.setMockConfig('openclawUseGateway', transport === 'gateway');
  const agentMeta = { provider: 'openai-codex', model: 'owned-model', sessionId: 'native-session-id', contextTokens: 128000,
    usage: { input: 20000, output: 1000, cacheRead: 180000, cacheWrite: 50000 },
    lastCallUsage: { input: 500, output: 60, cacheRead: 8000, cacheWrite: 1500 }, promptTokens: 10000 };
  const result = (count: number) => ({ payloads: [{ text: 'Owned bundled reply' }], ...(count === 1 ? { meta: { agentMeta } } : {}) });
  let server: WebSocketServer | undefined, serverClosed = transport === 'cli', requestCount = 0, url: string | undefined;
  const requests: any[] = [], errors: string[] = [], sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  const children: Array<{ proc: ChildProcess; closed: Promise<void>; close?: unknown }> = [];
  const actual = requireLocal('child_process') as typeof import('child_process');
  let provider: InstanceType<typeof Provider> | undefined;
  try {
    if (transport === 'gateway') {
      server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject); });
      url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      vscode.setMockConfig('openclawGatewayUrl', url);
      server.on('connection', socket => {
        const row = { closed: false, settled: Promise.resolve() };
        row.settled = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
        socket.on('message', data => {
          try {
            const frame = JSON.parse(data.toString()); requests.push(frame);
            const reply = (payload: unknown) => socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
            if (frame.method === 'connect') { reply({ type: 'hello-ok', protocol: 4 }); return; }
            expect(frame.method).toBe('agent');
            const runId = `owned-bundle-usage-${++requestCount}`;
            reply({ runId, status: 'accepted' }); reply({ runId, status: 'ok', result: result(requestCount) });
          } catch (error) { errors.push(String(error)); }
        });
        socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-usage-bundle' } }));
      });
    } else {
      spawnEnhancementChild = (_command, args, options) => {
        expect(args.slice(0, 2)).toEqual(['agent', '--json']);
        expect(fs.readFileSync(args[args.indexOf('--message-file') + 1], 'utf8')).toBe('Owned bundle usage request');
        const proc = actual.spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', JSON.stringify(result(++requestCount))],
          { ...options, env: { PATH: process.env.PATH } });
        const row = { proc, closed: Promise.resolve(), close: undefined as unknown };
        row.closed = new Promise(resolve => proc.once('close', (code, signal) => { row.close = { code, signal }; resolve(); })); children.push(row); return proc;
      };
    }
    provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
    (provider as any).buildPromptAsync = async () => 'Owned bundle usage request';
    if (transport === 'gateway') { expect((provider as any)._gateway._url).toBe(url); await provider.initialize(); }
    const collect = async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of (provider as any).sendMessage('Owned request', [], {
        provider: 'openclaw', model: 'unused-picker', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual',
      }, null, undefined, 'owned-usage-panel')) chunks.push(chunk);
      return chunks;
    };
    const first = await collect(), final = first.find(c => c.type === 'done')!;
    expect(first.filter(c => c.type === 'done')).toHaveLength(1); expect(first).toContainEqual({ type: 'text', content: 'Owned bundled reply' });
    expect(final.usage).toMatchObject({ input_tokens: 20000, output_tokens: 1000, cache_read_input_tokens: 180000, cache_creation_input_tokens: 50000, normalized: true });
    expect(final.contextUsage).toMatchObject({ input_tokens: 500, output_tokens: 60, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1500, normalized: true });
    expect(final.contextWindow).toBe(128000); expect(final.reportedModel).toBe('openai-codex/owned-model');
    const second = await collect();
    expect(second.find(c => c.type === 'done')).toEqual({ type: 'done', contextUsage: null });
    if (transport === 'gateway') {
      expect(requests[2].params.sessionKey).toBe(requests[1].params.sessionKey);
      expect(requests[2].params.sessionKey).not.toBe('native-session-id');
      expect(requests[1].params).not.toHaveProperty('onRunMetadata');
    }
    expect(requestCount).toBe(2); expect(errors).toEqual([]);
  } finally {
    provider?.dispose(); for (const socket of server?.clients || []) socket.terminate();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => { serverClosed = true; if (error) reject(error); else resolve(); }));
    await Promise.all(sockets.map(s => s.settled));
    for (const child of children) if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL');
    await Promise.all(children.map(c => c.closed));
    spawnEnhancementChild = undefined; vscode.clearMockConfig(); (vscode.workspace as any).workspaceFolders = previousFolders;
    if (process.env.PB07_BUNDLE_USAGE_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_USAGE_RECEIPT, JSON.stringify({ transport,
      serverClosed, allSocketsClosed: sockets.every(s => s.closed), allChildrenClosed: children.every(c => c.close !== undefined),
      children: children.map(c => ({ pid: c.proc.pid, close: c.close })), methods: requests.map(r => r.method), errors, nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it('recovers the public bundled provider after a native stream gap and gateway shutdown without replay', async () => {
  fs.writeFileSync(configPath, '{ gateway: { auth: { token: "owned-bundle-recovery-token" } } }');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const frames: any[] = [], errors: string[] = [], sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let serverClosed = false, count = 0;
  server.on('connection', socket => {
    const row = { closed: false, settled: Promise.resolve() };
    row.settled = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); frames.push(frame);
        const reply = (payload: unknown) => socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
        if (frame.method !== 'agent') { reply({ type: 'hello-ok', protocol: 4 }); return; }
        const runId = `owned-recovery-${++count}`;
        reply({ runId, status: 'accepted' });
        const event = (name: string, payload: object, seq?: number) => socket.send(JSON.stringify({ type: 'event', event: name, payload: { runId, sessionKey: frame.params.sessionKey, ...payload }, ...(seq === undefined ? {} : { seq }) }));
        if (count === 1) {
          event('agent', { stream: 'assistant', seq: 1, data: { delta: 'Bundled partial' } }, 10);
          event('tick', {}, 12);
          reply({ runId, status: 'ok', result: { payloads: [{ text: 'Late final' }] } });
        } else if (count === 2) event('shutdown', { reason: 'owned-bundle-recovery-token' });
        else reply({ runId, status: 'ok', result: { payloads: [{ text: 'Fresh bundled reply' }] } });
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-bundle-recovery' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', url); vscode.setMockConfig('openclawUseGateway', true);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).buildPromptAsync = async () => 'Owned recovery request';
  (provider as any).getCliPath = () => { throw new Error('Unexpected CLI replay'); };
  const calls: Promise<StreamChunk[]>[] = [];
  const collect = () => {
    const call = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of (provider as any).sendMessage('Owned request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' }, null, undefined, 'owned-recovery-panel')) chunks.push(chunk);
      return chunks;
    })(); calls.push(call); return call;
  };
  try {
    expect((provider as any)._gateway._url).toBe(url); await provider.initialize();
    const first = await collect(); expect(first).toContainEqual({ type: 'text', content: 'Bundled partial' });
    expect(first.filter(c => c.type === 'error')).toHaveLength(1); expect(first.filter(c => c.type === 'done')).toHaveLength(1);
    expect(first.find(c => c.type === 'error')?.content).toContain('incomplete'); expect(first.some(c => c.content === 'Late final')).toBe(false);
    const second = await collect(); expect(second.filter(c => c.type === 'error')).toHaveLength(1); expect(second.filter(c => c.type === 'done')).toHaveLength(1);
    expect(JSON.stringify(second)).not.toContain('owned-bundle-recovery-token');
    await provider.initialize();
    const third = await collect(); expect(third).toContainEqual({ type: 'text', content: 'Fresh bundled reply' }); expect(third.some(c => c.type === 'error')).toBe(false);
    expect(count).toBe(3); expect(frames.filter(f => f.method === 'chat.abort')).toHaveLength(1);
    expect(frames.find(f => f.method === 'chat.abort').params.runId).toBe('owned-recovery-1'); expect(errors).toEqual([]);
  } finally {
    provider.dispose(); for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); })), ...sockets.map(s => s.settled)]);
    await Promise.allSettled(calls); vscode.clearMockConfig();
    if (process.env.PB07_BUNDLE_RECOVERY_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_RECOVERY_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: sockets.every(s => s.closed), methods: frames.map(f => f.method), errors, nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it('cancels a pre-ack run precisely through the public bundle and keeps replacement work separate', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const requests: any[] = [], agents: any[] = [], errors: string[] = [], sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let serverClosed = false, stoppedOwned = false, stoppedForeign = false;
  server.on('connection', socket => {
    const row = { closed: false, settled: Promise.resolve() };
    row.settled = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        const reply = (id: string, payload: object) => socket.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
        if (frame.method === 'agent') {
          agents.push(frame);
          if (agents.length === 2) {
            const old = agents[0];
            reply(old.id, { status: 'accepted', runId: old.params.idempotencyKey });
            reply(old.id, { status: 'ok', text: 'Stale reply' });
            reply(frame.id, { status: 'accepted', runId: frame.params.idempotencyKey });
            reply(frame.id, { status: 'ok', result: { payloads: [{ text: 'Fresh bundled reply' }] } });
          }
        } else if (frame.method === 'chat.abort') {
          const owned = agents[0];
          stoppedOwned ||= frame.params.sessionKey === owned.params.sessionKey && (!frame.params.runId || frame.params.runId === owned.params.idempotencyKey);
          stoppedForeign ||= frame.params.sessionKey === owned.params.sessionKey && (!frame.params.runId || frame.params.runId === 'foreign-native-run');
          reply(frame.id, { ok: true, aborted: stoppedOwned });
        } else reply(frame.id, { type: 'hello-ok', protocol: 4 });
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-bundled-preack' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', url); vscode.setMockConfig('openclawUseGateway', true);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).buildPromptAsync = async () => 'Owned bundled cancellation';
  (provider as any).getCliPath = () => { throw new Error('Unexpected CLI replay'); };
  const calls: Promise<StreamChunk[]>[] = [];
  const collect = () => {
    const result = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of (provider as any).sendMessage('Owned request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' }, null, undefined, 'owned-preack-panel')) chunks.push(chunk);
      return chunks;
    })(); calls.push(result); return result;
  };
  try {
    expect((provider as any)._gateway._url).toBe(url); await provider.initialize();
    const first = collect(); await vi.waitFor(() => expect(agents).toHaveLength(1));
    (provider as any).cancelCurrentRequest('owned-preack-panel'); await first;
    await vi.waitFor(() => expect(stoppedOwned).toBe(true)); expect(stoppedForeign).toBe(false);
    const second = await collect(); expect(second).toContainEqual({ type: 'text', content: 'Fresh bundled reply' });
    expect(second.some(c => c.content === 'Stale reply' || c.type === 'error')).toBe(false); expect(second.filter(c => c.type === 'done')).toHaveLength(1);
    expect(agents).toHaveLength(2); expect(agents[0].params.idempotencyKey).not.toBe(agents[1].params.idempotencyKey);
    expect(requests.filter(r => r.method === 'chat.abort')).toHaveLength(1); expect(errors).toEqual([]);
  } finally {
    provider.dispose(); for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); })), ...sockets.map(s => s.settled)]);
    await Promise.allSettled(calls); vscode.clearMockConfig();
    if (process.env.PB07_BUNDLE_PREACK_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_PREACK_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: sockets.every(s => s.closed), methods: requests.map(r => r.method), stoppedOwned, stoppedForeign, errors,
      nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it('delivers native snapshots and applies retractions through the public bundle', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const requests: any[] = [], agents: any[] = [], errors: string[] = [], sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let serverClosed = false;
  server.on('connection', socket => {
    const row = { closed: false, settled: Promise.resolve() };
    row.settled = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        const reply = (id: string, payload: object) => socket.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
        if (frame.method === 'agent') {
          agents.push(frame);
          reply(frame.id, { status: 'accepted', runId: frame.params.idempotencyKey });
          const event = (stream: string, data: object) => socket.send(JSON.stringify({ type: 'event', event: 'agent',
            payload: { runId: frame.params.idempotencyKey, sessionKey: frame.params.sessionKey, stream, data } }));
          if (agents.length === 1) {
            event('assistant', { text: 'Before.' });
            event('tool', { phase: 'start', toolCallId: 'owned-tool', name: 'read', args: { path: 'owned.txt' } });
            event('tool', { phase: 'result', toolCallId: 'owned-tool', result: 'Owned output' });
            event('thinking', { text: 'Consider' }); event('thinking', { text: 'Consider carefully' });
            event('assistant', { text: 'After' }); event('assistant', { text: 'After.' }); event('assistant', { text: 'After.' });
          } else if (agents.length === 2) {
            event('assistant', { text: 'Partial', delta: 'Partial' });
            event('assistant', { text: 'Revised', delta: '', replace: true });
          } else if (agents.length === 3) {
            event('assistant', { text: 'Hello world', delta: ' world' });
            event('assistant', { text: 'Hello world!', delta: '!' });
          } else {
            event('assistant', { text: 'Earlier stable.', delta: 'Earlier stable.' });
            event('assistant', { text: 'Different complete message', delta: ' message' });
          }
          reply(frame.id, { status: 'ok', result: { payloads: [{ text: 'Late final must not duplicate or mask the stream' }] } });
        } else reply(frame.id, { type: 'hello-ok', protocol: 4 });
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-bundled-snapshots' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', url); vscode.setMockConfig('openclawUseGateway', true);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).buildPromptAsync = async () => 'Owned bundled snapshots';
  (provider as any).getCliPath = () => { throw new Error('Unexpected CLI replay'); };
  const calls: Promise<StreamChunk[]>[] = [];
  const collect = () => {
    const result = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of (provider as any).sendMessage('Owned request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' }, null, undefined, 'owned-snapshot-panel')) chunks.push(chunk);
      return chunks;
    })(); calls.push(result); return result;
  };
  try {
    expect((provider as any)._gateway._url).toBe(url); await provider.initialize();
    const first = await collect();
    expect(first.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('Before.After.');
    expect(first.filter(c => c.type === 'thinking').map(c => c.content).join('')).toBe('Consider carefully');
    expect(first.map(c => c.type)).toEqual(['session_active', 'text', 'tool_use', 'tool_result', 'thinking', 'thinking', 'text', 'text', 'done']);
    const second = await collect();
    expect(second.filter(c => c.type === 'text').reduce((value, chunk) => applyStreamText(value, chunk), '')).toBe('Revised');
    expect(second.find(c => c.replace)).toMatchObject({ replace: { start: 0, end: 7 }, content: 'Revised' });
    expect(second.filter(c => c.type === 'error')).toHaveLength(0); expect(second.filter(c => c.type === 'done')).toHaveLength(1);
    expect(requests.filter(r => r.method === 'chat.abort')).toHaveLength(0);
    const third = await collect();
    expect(third.filter(c => c.type === 'text').reduce((value, chunk) => applyStreamText(value, chunk), '')).toBe('Hello world!');
    expect(third.filter(c => c.type === 'error')).toHaveLength(0); expect(third.filter(c => c.type === 'done')).toHaveLength(1);
    const fourth = await collect();
    expect(fourth.filter(c => c.type === 'text').reduce((value, chunk) => applyStreamText(value, chunk), '')).toBe('Earlier stable.');
    expect(fourth.filter(c => c.type === 'error')).toHaveLength(1); expect(fourth.filter(c => c.type === 'done')).toHaveLength(1);
    await vi.waitFor(() => expect(requests.filter(r => r.method === 'chat.abort')).toHaveLength(1));
    expect(requests.find(r => r.method === 'chat.abort').params.runId).toBe(agents[3].params.idempotencyKey);
    expect(agents).toHaveLength(4); expect(errors).toEqual([]);
  } finally {
    provider.dispose(); for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); })), ...sockets.map(s => s.settled)]);
    await Promise.allSettled(calls); vscode.clearMockConfig();
    if (process.env.PB07_BUNDLE_SNAPSHOT_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_SNAPSHOT_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: sockets.every(s => s.closed), methods: requests.map(r => r.method), errors,
      nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it('keeps commentary separate and projects native final payloads through the public bundle', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const requests: any[] = [], agents: any[] = [], errors: string[] = [], sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let serverClosed = false;
  server.on('connection', socket => {
    const row = { closed: false, settled: Promise.resolve() };
    row.settled = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        const reply = (id: string, payload: object) => socket.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
        if (frame.method === 'agent') {
          agents.push(frame);
          reply(frame.id, { status: 'accepted', runId: frame.params.idempotencyKey });
          const event = (stream: string, data: object) => socket.send(JSON.stringify({ type: 'event', event: 'agent',
            payload: { runId: frame.params.idempotencyKey, sessionKey: frame.params.sessionKey, stream, data } }));
          event('item', { kind: 'preamble', phase: 'update', progressText: 'Checking files' });
          event('assistant', { text: 'Planning', phase: 'commentary' });
          if (agents.length === 2) event('assistant', { text: 'Draft', delta: 'Draft', replaceable: true });
          reply(frame.id, { status: 'ok', result: { payloads: [
            { text: 'Commentary only', phase: 'commentary' },
            { content: [{ type: 'text', text: 'Final answer', textSignature: '{"v":1,"phase":"final_answer"}' }] },
          ] } });
        } else reply(frame.id, { type: 'hello-ok', protocol: 4 });
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-bundled-commentary' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', url); vscode.setMockConfig('openclawUseGateway', true);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).buildPromptAsync = async () => 'Owned bundled commentary';
  (provider as any).getCliPath = () => { throw new Error('Unexpected CLI replay'); };
  const calls: Promise<StreamChunk[]>[] = [];
  const collect = () => {
    const result = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of (provider as any).sendMessage('Owned request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' }, null, undefined, 'owned-commentary-panel')) chunks.push(chunk);
      return chunks;
    })(); calls.push(result); return result;
  };
  try {
    expect((provider as any)._gateway._url).toBe(url); await provider.initialize();
    for (let i = 0; i < 2; i++) {
      const chunks = await collect();
      expect(chunks.filter(c => c.type === 'text').reduce((value, chunk) => applyStreamText(value, chunk), '')).toBe('Final answer');
      expect(chunks.filter(c => c.type === 'progress').map(c => c.content)).toEqual(['Checking files', 'Planning']);
      expect(chunks.filter(c => c.type === 'thinking' || c.toolCall || c.type === 'error')).toEqual([]);
      expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    }
    expect(requests.filter(r => r.method === 'chat.abort')).toHaveLength(0);
    expect(agents).toHaveLength(2); expect(errors).toEqual([]);
  } finally {
    provider.dispose(); for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); })), ...sockets.map(s => s.settled)]);
    await Promise.allSettled(calls); vscode.clearMockConfig();
    if (process.env.PB07_BUNDLE_COMMENTARY_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_COMMENTARY_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: sockets.every(s => s.closed), methods: requests.map(r => r.method), errors,
      nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);

it('distinguishes native completion states and ordinary RPC acknowledgements through the public bundle', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const requests: any[] = [], agents: any[] = [], errors: string[] = [], sockets: Array<{ closed: boolean; settled: Promise<void> }> = [];
  let serverClosed = false;
  server.on('connection', socket => {
    const row = { closed: false, settled: Promise.resolve() };
    row.settled = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        const reply = (id: string, payload: object) => socket.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
        if (frame.method === 'agent') {
          agents.push(frame);
          reply(frame.id, { status: 'accepted', runId: frame.params.idempotencyKey });
          const event = (stream: string, data: object) => socket.send(JSON.stringify({ type: 'event', event: 'agent',
            payload: { runId: frame.params.idempotencyKey, sessionKey: frame.params.sessionKey, stream, data } }));
          if (agents.length === 1) reply(frame.id, { status: 'in_flight' });
          else {
            event('assistant', { text: 'Useful partial', delta: 'Useful partial' });
            event('lifecycle', { phase: 'end', aborted: true });
            reply(frame.id, { status: 'ok', summary: 'completed', result: { payloads: [] } });
          }
        } else if (frame.method === 'chat.send') reply(frame.id, { status: frame.params.message === 'Owned abort' ? 'timeout' : 'accepted', summary: 'aborted' });
        else reply(frame.id, { type: 'hello-ok', protocol: 4 });
      } catch (error) { errors.push(String(error)); }
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-bundled-completion' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vscode.setMockConfig('openclawGatewayUrl', url); vscode.setMockConfig('openclawUseGateway', true);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  (provider as any).buildPromptAsync = async () => 'Owned bundled completion';
  (provider as any).getCliPath = () => { throw new Error('Unexpected CLI replay'); };
  const calls: Promise<StreamChunk[]>[] = [];
  const collect = () => {
    const result = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of (provider as any).sendMessage('Owned request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' }, null, undefined, 'owned-completion-panel')) chunks.push(chunk);
      return chunks;
    })(); calls.push(result); return result;
  };
  try {
    expect((provider as any)._gateway._url).toBe(url); await provider.initialize();
    const first = await collect();
    expect(first.find(c => c.type === 'error')?.content).toMatch(/already.*running/i);
    expect(first.filter(c => c.type === 'text')).toEqual([]);
    const second = await collect();
    expect(second.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'Useful partial' }]);
    expect(second.find(c => c.type === 'error')?.content).toMatch(/abort/i);
    expect(first.filter(c => c.type === 'done')).toHaveLength(1); expect(second.filter(c => c.type === 'done')).toHaveLength(1);
    const gateway = (provider as any)._gateway;
    // These are owned loopback receipts, never real outbound channel requests.
    expect(await gateway.sendAgentTask('Owned accepted')).toBe(true);
    expect(await gateway.sendAgentTask('Owned abort')).toBe(false);
    expect(requests.filter(r => r.method === 'chat.abort')).toHaveLength(0);
    expect(agents).toHaveLength(2); expect(errors).toEqual([]);
  } finally {
    provider.dispose(); for (const socket of server.clients) socket.terminate();
    await Promise.all([new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); })), ...sockets.map(s => s.settled)]);
    await Promise.allSettled(calls); vscode.clearMockConfig();
    if (process.env.PB07_BUNDLE_COMPLETION_RECEIPT) fs.appendFileSync(process.env.PB07_BUNDLE_COMPLETION_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: sockets.every(s => s.closed), methods: requests.map(r => r.method), errors,
      nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);


it('resolves exported gateway references and allowlists in the production bundle', () => {
  const env = fixtureEnv as Record<string, string | undefined>;
  const previous = env.OWNED_BUNDLE_GATEWAY_KEY;
  env.OWNED_BUNDLE_GATEWAY_KEY = '  owned-bundle-reference  ';
  try {
    for (const token of ['$OWNED_BUNDLE_GATEWAY_KEY', '${OWNED_BUNDLE_GATEWAY_KEY}',
      { source: 'env', provider: 'default', id: 'OWNED_BUNDLE_GATEWAY_KEY' }]) {
      fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token } } }));
      expect(readToken()).toBe('owned-bundle-reference');
    }
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: '$OWNED_BUNDLE_GATEWAY_KEY' } },
      secrets: { providers: { default: { source: 'env', allowlist: [] } } } }));
    expect(readToken()).toBe('synthetic-environment-token');
    env.OWNED_BUNDLE_GATEWAY_KEY = '';
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: '$OWNED_BUNDLE_GATEWAY_KEY' } } }));
    expect(readToken()).toBe('synthetic-environment-token');
  } finally { if (previous === undefined) delete env.OWNED_BUNDLE_GATEWAY_KEY; else env.OWNED_BUNDLE_GATEWAY_KEY = previous; }
});

it('recognizes configured backend env credentials and selection changes in the production bundle', async () => {
  const store = path.join(agentDir, 'auth-profiles.json'), previousStore = fs.readFileSync(store);
  const env = fixtureEnv as NodeJS.ProcessEnv;
  const previous = { OPENAI_API_KEY: env.OPENAI_API_KEY, GEMINI_API_KEY: env.GEMINI_API_KEY, GOOGLE_API_KEY: env.GOOGLE_API_KEY };
  env.OPENAI_API_KEY = 'owned-bundled-openai'; env.GEMINI_API_KEY = ''; env.GOOGLE_API_KEY = '';
  fs.writeFileSync(store, JSON.stringify({ profiles: {} })); vscode.setMockConfig('openclawUseGateway', false);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  const select = (model: string) => fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { model } } }));
  try {
    select('openai/owned'); expect((await provider.checkAuthentication()).authenticated).toBe(true);
    select('google/owned'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
    env.GEMINI_API_KEY = 'owned-bundled-google'; expect((await provider.checkAuthentication()).authenticated).toBe(true);
    env.GEMINI_API_KEY = '🙂'; expect((await provider.checkAuthentication()).authenticated).toBe(false);
    select('openai/owned@profile'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
  } finally {
    provider.dispose(); vscode.clearMockConfig(); fs.writeFileSync(store, previousStore);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete env[key]; else env[key] = value; }
  }
});

it('recognizes provider-config credentials and local no-auth readiness in the production bundle', async () => {
  const store = path.join(agentDir, 'auth-profiles.json'), previousStore = fs.readFileSync(store);
  const env = fixtureEnv as NodeJS.ProcessEnv, previousKey = env.OWNED_BUNDLE_CONFIG_KEY;
  fs.writeFileSync(store, JSON.stringify({ profiles: {} })); vscode.setMockConfig('openclawUseGateway', false);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  const configure = (apiKey: unknown, baseUrl = 'https://remote.example.invalid', model = 'owned/fixture') =>
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { model } }, models: { providers: {
      owned: { api: 'openai-completions', baseUrl, apiKey, models: [{ id: 'fixture', name: 'Owned fixture' }] },
    } } }));
  try {
    configure('owned-config-key'); expect((await provider.checkAuthentication()).authenticated).toBe(true);
    configure(''); expect((await provider.checkAuthentication()).authenticated).toBe(false);
    env.OWNED_BUNDLE_CONFIG_KEY = 'owned-env-key'; configure('$OWNED_BUNDLE_CONFIG_KEY');
    expect((await provider.checkAuthentication()).authenticated).toBe(true);
    delete env.OWNED_BUNDLE_CONFIG_KEY; expect((await provider.checkAuthentication()).authenticated).toBe(false);
    configure(undefined, 'http://localhost:9'); expect((await provider.checkAuthentication()).authenticated).toBe(true);
    configure('$OWNED_BUNDLE_CONFIG_KEY', 'http://localhost:9'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
    configure('owned-config-key', undefined, 'unselected/fixture'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
  } finally {
    provider.dispose(); vscode.clearMockConfig(); fs.writeFileSync(store, previousStore);
    if (previousKey === undefined) delete env.OWNED_BUNDLE_CONFIG_KEY; else env.OWNED_BUNDLE_CONFIG_KEY = previousKey;
  }
});

it('enforces selected stored profiles and runtime order in the production bundle', async () => {
  const store = path.join(agentDir, 'auth-profiles.json'), previousStore = fs.readFileSync(store);
  const databasePath = path.join(agentDir, 'openclaw-agent.sqlite');
  expect(fs.existsSync(databasePath)).toBe(false);
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT); CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT)');
  const profiles = { chosen: { type: 'token', provider: 'owned', token: 'owned-expired', expires: 1 },
    alternative: { type: 'api_key', provider: 'owned', key: 'owned-static-key' } };
  db.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify({ profiles }));
  db.prepare('INSERT INTO auth_profile_state VALUES (?, ?)').run('primary', JSON.stringify({ order: { owned: ['chosen'] } })); db.close();
  vscode.setMockConfig('openclawUseGateway', false);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  const select = (model: string) => fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { model } } }));
  try {
    select('owned/fixture'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
    select('owned/fixture@alternative'); expect((await provider.checkAuthentication()).authenticated).toBe(true);
    select('owned/fixture@missing'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
    select('other/fixture'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
    const update = new DatabaseSync(databasePath);
    update.prepare('UPDATE auth_profile_state SET state_json = ?').run(JSON.stringify({ order: { owned: ['alternative'] } })); update.close();
    select('owned/fixture'); expect((await provider.checkAuthentication()).authenticated).toBe(true);
  } finally {
    provider.dispose(); vscode.clearMockConfig(); fs.rmSync(databasePath); fs.writeFileSync(store, previousStore);
  }
});

it('follows a selected CLI upgrade from JSON to SQLite in the production bundle', async () => {
  const store = path.join(agentDir, 'auth-profiles.json'), previousStore = fs.readFileSync(store);
  const databasePath = path.join(agentDir, 'openclaw-agent.sqlite');
  expect(fs.existsSync(databasePath)).toBe(false);
  const install = path.join(directory, 'owned-install'); fs.mkdirSync(install);
  const entry = path.join(install, 'openclaw.mjs'); fs.writeFileSync(entry, '// Never executed');
  const version = (value: string) => fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'openclaw', version: value, bin: { openclaw: './openclaw.mjs' } }));
  version('2026.6.1');
  vscode.setMockConfig('openclawPath', entry); vscode.setMockConfig('openclawUseGateway', false);
  const profiles = { chosen: { type: 'api_key', provider: 'owned', key: 'owned-static-key' } };
  fs.writeFileSync(store, JSON.stringify({ profiles }));
  fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { model: 'owned/fixture' } } }));
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  try {
    expect((await provider.checkAuthentication()).authenticated).toBe(true);
    version('2026.6.34'); expect((await provider.checkAuthentication()).authenticated).toBe(false);
    expect(fs.existsSync(databasePath)).toBe(false);
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)');
      db.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify({ profiles }));
      expect((await provider.checkAuthentication()).authenticated).toBe(true);
      db.prepare('UPDATE auth_profile_store SET store_json = ?').run(JSON.stringify({ profiles: {} }));
      expect((await provider.checkAuthentication()).authenticated).toBe(false);
    } finally { db.close(); }
    version('2026.6.1'); expect((await provider.checkAuthentication()).authenticated).toBe(true);
  } finally {
    provider.dispose(); vscode.clearMockConfig(); fs.rmSync(databasePath, { force: true });
    fs.writeFileSync(store, previousStore);
  }
});

it('honors JSON store precedence and runtime order in the production bundle', async () => {
  const store = path.join(agentDir, 'auth-profiles.json'), previousStore = fs.readFileSync(store);
  const legacy = path.join(agentDir, 'auth.json'), state = path.join(agentDir, 'auth-state.json');
  expect(fs.existsSync(legacy)).toBe(false); expect(fs.existsSync(state)).toBe(false);
  const key = { type: 'api_key', provider: 'owned', key: 'owned-bundle-key' };
  fs.writeFileSync(legacy, JSON.stringify({ owned: key }));
  fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { model: 'owned/fixture' } } }));
  vscode.setMockConfig('openclawUseGateway', false);
  const provider = new Provider({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  try {
    fs.writeFileSync(store, JSON.stringify({ profiles: {} }));
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
    fs.writeFileSync(store, JSON.stringify({ version: 1 }));
    expect((await provider.checkAuthentication()).authenticated).toBe(true);
    fs.writeFileSync(store, JSON.stringify({ profiles: { chosen: { type: 'token', provider: 'owned', token: 'owned-expired', expires: 1 }, alternative: key }, order: { owned: ['alternative'] } }));
    fs.writeFileSync(state, JSON.stringify({ order: { owned: ['chosen'] } }));
    const before = [fs.readFileSync(store), fs.readFileSync(legacy), fs.readFileSync(state)];
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
    expect([fs.readFileSync(store), fs.readFileSync(legacy), fs.readFileSync(state)]).toEqual(before);
    fs.writeFileSync(state, JSON.stringify({ order: { owned: ['alternative'] } }));
    expect((await provider.checkAuthentication()).authenticated).toBe(true);
  } finally {
    provider.dispose(); vscode.clearMockConfig(); fs.rmSync(legacy); fs.rmSync(state, { force: true }); fs.writeFileSync(store, previousStore);
  }
});
