/** Actual inert child processes + loopback sockets. No model or installed/user OpenClaw state. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { getEnrichedEnv, resetPlatformCache } from '../../../src/utils/platform';
import { buildOpenClawManagedConfig, OpenClawManagedRuntime, type OpenClawManagedRuntimeOptions,
  type OpenClawManagedRuntimeHandle } from '../../../src/providers/openclaw/OpenClawManagedRuntime';

const roots: string[] = [];
const handles: OpenClawManagedRuntimeHandle[] = [];
const descendants: number[] = [];
const require = createRequire(import.meta.url);
afterEach(async () => {
  vi.unstubAllEnvs();
  resetPlatformCache();
  await Promise.all(handles.splice(0).map(handle => handle.dispose()));
  for (const pid of descendants.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not settle');
}
async function fixture(mode = 'ready'): Promise<{ options: OpenClawManagedRuntimeOptions; root: string; journal: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-managed-runtime-'));
  roots.push(root);
  const installedRoot = path.join(root, 'installation');
  const pluginPath = path.join(root, 'plugin');
  const storageDir = path.join(root, 'storage');
  const workspaceDir = path.join(root, 'workspace');
  for (const directory of [installedRoot, pluginPath, storageDir, workspaceDir]) { await fs.mkdir(directory); }
  await fs.writeFile(path.join(installedRoot, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.6.34' }));
  await fs.writeFile(path.join(pluginPath, 'openclaw.plugin.json'), JSON.stringify({ id: 'mysti-policy', activation: { onStartup: true } }));
  const preloadPath = path.join(root, 'inert preload.mjs');
  await fs.writeFile(preloadPath, 'globalThis.mystiInertPreloaded = true;');
  const journal = path.join(root, 'journal.jsonl');
  const cliPath = path.join(installedRoot, 'openclaw.mjs');
  await fs.writeFile(cliPath, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ws from ${JSON.stringify(pathToFileURL(require.resolve('ws')).href)};
const { WebSocketServer } = ws;
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const journal = ${JSON.stringify(journal)};
const record = { args, pid:process.pid, config, cwd:process.cwd(), preloaded:globalThis.mystiInertPreloaded,
  configMode:fs.statSync(process.env.OPENCLAW_CONFIG_PATH).mode & 511, dirMode:fs.statSync(process.cwd()).mode & 511,
  env:Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(OPENCLAW_|CLAWDBOT_|LITECLAW_|PI_CODING_AGENT_DIR$|CODEX_HOME$|MYSTI_OPENCLAW_|MYSTI_INERT_MODEL_CREDENTIAL$|NODE_OPTIONS|HOME$|TMPDIR$)/.test(key))) };
fs.appendFileSync(journal, JSON.stringify(record) + '\\n');
if (args[0] === 'config') { process.exit(mode === 'invalid-config' ? 2 : 0); }
if (mode === 'descendant') {
  spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(path.join(root, 'descendant-started.json'))}, JSON.stringify({ pid: process.pid }));
setTimeout(() => { fs.writeFileSync(${JSON.stringify(path.join(root, 'descendant-effect.txt'))}, 'escaped'); process.exit(0); }, 1000);`)}], { stdio:'ignore', detached:false });
}
if (mode === 'exit') { process.exit(7); }
if (mode === 'silent') { setInterval(() => {}, 1000); }
else {
const server = new WebSocketServer({ host:'127.0.0.1', port:config.gateway.port });
server.on('connection', socket => {
  socket.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'inert'}}));
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.method !== 'connect') { process.exit(92); }
    socket.send(JSON.stringify({type:'res', id:frame.id, ok: frame.params.auth.token === config.gateway.auth.token,
      payload:{type:'hello-ok', protocol:mode === 'bad-protocol' ? 2 : 4, server:{version:mode === 'bad-version' ? 'future' : '2026.6.34'},
        auth:{role:'operator',scopes:mode === 'missing-scopes' ? [] : ['operator.write']},
        features:{methods:mode === 'missing-methods' ? ['agent'] : ['agent','sessions.abort']}}}));
  });
});
}
`, { mode: 0o700 });
  return { root, journal, options: { cliPath, installedRoot, storageDir, workspaceDir, pluginPath, preloadPath,
    baseConfig: { agents: { defaults: { model: 'openai/test-model' } } },
    broker: { url: 'ws://127.0.0.1:32145', token: 'a'.repeat(64), runtimeId: 'inert-runtime' }, startupTimeoutMs: 3000 } };
}
interface InertRecord {
  args: string[]; pid: number; cwd: string; preloaded: boolean; configMode: number; dirMode: number;
  env: Record<string, string>; config: { gateway: { port: number } };
}
async function readJournal(filename: string): Promise<InertRecord[]> {
  return (await fs.readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

describe('OpenClaw managed runtime config boundary', () => {
  it('rejects Windows before allocating owned state or spawning a process', async () => {
    const { options, journal } = await fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      await expect(OpenClawManagedRuntime.start(options)).rejects.toThrow('owned Job Object');
      await expect(fs.access(journal)).rejects.toThrow();
      expect(await fs.readdir(options.storageDir)).toEqual([]);
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it('preserves deliberate model/provider credentials and parameters, forces Pi at every precedence, and removes ambient services', async () => {
    const { options } = await fixture();
    options.baseConfig = { agents: { defaults: { model: { primary: 'openai/gpt-test', fallbacks: ['anthropic/other'] },
      models: { 'openai/gpt-test': { params: { temperature: 0.2 }, streaming: false } }, heartbeat: { every: '1s' } } },
      models: { providers: { openai: { apiKey: 'inert-key', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'gpt-test', name: 'test' }] } } },
      auth: { profiles: { 'openai:test': { provider: 'openai', mode: 'api_key' } } },
      gateway: { bind: 'lan', port: 1 }, channels: { telegram: { enabled: true } }, cron: { enabled: true },
      hooks: { enabled: true }, plugins: { allow: ['unrelated'], load: { paths: ['/unrelated'] } } };
    const before = JSON.stringify(options.baseConfig);
    const config = buildOpenClawManagedConfig(options, '/owned/state', 33133, 'owned-token');
    expect(config.agents).toMatchObject({ defaults: {
      model: { primary: 'openai/gpt-test', fallbacks: ['anthropic/other'] },
      models: {
        'openai/gpt-test': { params: { temperature: 0.2 }, streaming: false, agentRuntime: { id: 'openclaw' } },
        'anthropic/*': { agentRuntime: { id: 'openclaw' } },
      }, heartbeat: { every: '0m' },
    }, list: [{ id: 'main', default: true, runtime: { type: 'embedded' }, workspace: options.workspaceDir, agentDir: '/owned/state/agents/main/agent' }] });
    expect(config.models).toMatchObject({ providers: { openai: { apiKey: 'inert-key', agentRuntime: { id: 'openclaw' }, models: [{ agentRuntime: { id: 'openclaw' } }] } } });
    expect(config.auth).toEqual(options.baseConfig.auth);
    expect(config.gateway).toMatchObject({ bind: 'loopback', port: 33133, auth: { token: 'owned-token', mode: 'token' }, reload: { mode: 'off' } });
    expect(config.channels).toEqual({});
    expect(config.cron).toEqual({ enabled: false });
    expect(config.hooks).toEqual({ enabled: false, internal: { enabled: false } });
    expect(config.plugins).toEqual({ enabled: true, allow: ['mysti-policy'], slots: { memory: 'none' }, load: { paths: [options.pluginPath] }, entries: {
      'mysti-policy': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: false }, config: { broker: options.broker } },
      'memory-wiki': { enabled: false, config: { vault: { path: '/owned/state/wiki' } } },
    } });
    expect(config.tools).toEqual({ allow: ['read', 'write', 'edit', 'exec'], deny: ['process', 'apply_patch'], exec: { host: 'gateway', security: 'full', ask: 'off' } });
    expect(JSON.stringify(options.baseConfig)).toBe(before);
  });

  it.each([
    { agents: { defaults: { model: 'unqualified' } } },
    { agents: { defaults: { model: { fallbacks: ['openai/test'] } } } },
    { agents: { defaults: { model: 'openai/test' }, list: [{ id: 'other', runtime: { type: 'acp' } }] } },
    { agents: { defaults: { model: 'openai/test', models: { 'openai/test': { agentRuntime: { id: 'codex' } } } } } },
    { agents: { defaults: { model: 'openai/test' } }, models: { providers: { openai: { localService: { command: 'unsafe' } } } } },
    { agents: { defaults: { model: 'openai/test' } }, secrets: { providers: { x: { source: 'exec', command: 'unsafe' } } } },
    { agents: { defaults: { model: 'openai/test' } }, $include: '/outside/config' },
    { agents: { defaults: { model: 'openai/test' } }, env: { vars: { OPENAI_API_KEY: 'inert-config-key' } } },
  ])('rejects unsupported input before spawning: %j', async baseConfig => {
    const { options, journal } = await fixture();
    await expect(OpenClawManagedRuntime.start({ ...options, baseConfig })).rejects.toThrow(/OpenClaw/);
    await expect(fs.access(journal)).rejects.toThrow();
    expect(await fs.readdir(options.storageDir)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('OpenClaw managed runtime owned process lifecycle', () => {
  it('starts an env-node CLI from a minimal GUI PATH while preserving fresh process credentials', async () => {
    const { options, journal } = await fixture();
    resetPlatformCache();
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('MYSTI_INERT_MODEL_CREDENTIAL', 'old-inert-value');
    getEnrichedEnv();
    vi.stubEnv('MYSTI_INERT_MODEL_CREDENTIAL', 'fresh-inert-value');
    const handle = await OpenClawManagedRuntime.start(options);
    handles.push(handle);
    const records = await readJournal(journal);
    expect(records).toHaveLength(2);
    expect(records[1].preloaded).toBe(true);
    expect(records[1].env.MYSTI_INERT_MODEL_CREDENTIAL).toBe('fresh-inert-value');
  });

  it('preloads both native schema validation and gateway, authenticates readiness, and removes private state on idempotent disposal', async () => {
    const { options, journal } = await fixture();
    vi.stubEnv('PI_CODING_AGENT_DIR', '/unrelated/agent');
    vi.stubEnv('CLAWDBOT_STATE_DIR', '/unrelated/state');
    vi.stubEnv('LITECLAW_CONFIG_PATH', '/unrelated/config');
    vi.stubEnv('CODEX_HOME', '/unrelated/codex-credentials');
    vi.stubEnv('OPENCLAW_EXEC_SHELL_SNAPSHOT', '1');
    const handle = await OpenClawManagedRuntime.start(options);
    handles.push(handle);
    const records = await readJournal(journal);
    expect(records).toHaveLength(2);
    expect(records[0].args).toEqual(['config', 'validate', '--json']);
    expect(records[1].args.slice(0, 2)).toEqual(['gateway', 'run']);
    expect(records.every(record => record.preloaded && record.configMode === 0o600 && record.dirMode === 0o700)).toBe(true);
    expect(records[1].args).not.toContain(handle.token);
    expect(records[1].env).toMatchObject({ OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: '1',
      OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', MYSTI_OPENCLAW_OWNED_RUNTIME: '1', MYSTI_OPENCLAW_ROOT: await fs.realpath(options.installedRoot), HOME: process.env.HOME });
    expect(await fs.realpath(records[1].env.OPENCLAW_STATE_DIR)).toBe(path.join(records[1].cwd, 'state'));
    expect(await fs.realpath(records[1].env.OPENCLAW_HOME)).toBe(path.join(records[1].cwd, 'home'));
    expect(records[1].env.NODE_OPTIONS).toBe(`--import=${pathToFileURL(options.preloadPath).href}`);
    expect(records[1].env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(records[1].env.CLAWDBOT_STATE_DIR).toBeUndefined();
    expect(records[1].env.LITECLAW_CONFIG_PATH).toBeUndefined();
    expect(records[1].env.CODEX_HOME).toBeUndefined();
    expect(handle.gatewayUrl).toBe(`ws://127.0.0.1:${records[1].config.gateway.port}`);
    expect(handle.token).toMatch(/^[a-f0-9]{64}$/);
    await Promise.all([handle.dispose(), handle.dispose()]);
    expect(await fs.readdir(options.storageDir)).toEqual([]);
    expect(() => process.kill(records[1].pid, 0)).toThrow();
  });

  it.each(['dispose', 'crash'] as const)('kills a SIGTERM-ignoring group descendant after gateway %s', async mode => {
    const { options, journal, root } = await fixture('descendant');
    const handle = await OpenClawManagedRuntime.start(options);
    handles.push(handle);
    const started = path.join(root, 'descendant-started.json');
    await eventually(async () => { try { await fs.access(started); return true; } catch { return false; } });
    const { pid } = JSON.parse(await fs.readFile(started, 'utf8')) as { pid: number };
    descendants.push(pid);
    const gateway = (await readJournal(journal))[1];
    if (mode === 'crash') { process.kill(gateway.pid, 'SIGKILL'); }
    else { await handle.dispose(); }
    await eventually(async () => (await fs.readdir(options.storageDir)).length === 0);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await expect(fs.access(path.join(root, 'descendant-effect.txt'))).rejects.toThrow();
    expect(() => process.kill(gateway.pid, 0)).toThrow();
  });

  it('keeps simultaneous runtimes and credentials separate', async () => {
    const { options } = await fixture();
    const started = await Promise.all([OpenClawManagedRuntime.start(options), OpenClawManagedRuntime.start(options)]);
    handles.push(...started);
    expect(started[0].gatewayUrl).not.toBe(started[1].gatewayUrl);
    expect(started[0].token).not.toBe(started[1].token);
    await started[0].dispose();
    expect(await fs.readdir(options.storageDir)).toHaveLength(1);
  });

  it.each(['invalid-config', 'exit', 'bad-protocol', 'bad-version', 'missing-methods', 'missing-scopes'])('fails closed and cleans the child/state for %s', async mode => {
    const { options, journal } = await fixture(mode);
    await expect(OpenClawManagedRuntime.start(options)).rejects.toThrow(/OpenClaw/);
    const records = await readJournal(journal);
    expect(records).toHaveLength(mode === 'invalid-config' ? 1 : 2);
    expect(await fs.readdir(options.storageDir)).toEqual([]);
    records.forEach(record => expect(() => process.kill(record.pid, 0)).toThrow());
  });

  it('bounds silent startup and reaps its process', async () => {
    const { options, journal } = await fixture('silent');
    await expect(OpenClawManagedRuntime.start({ ...options, startupTimeoutMs: 500 })).rejects.toThrow('timed out');
    const records = await readJournal(journal);
    expect(records).toHaveLength(2);
    expect(() => process.kill(records[1].pid, 0)).toThrow();
    expect(await fs.readdir(options.storageDir)).toEqual([]);
  });

  it('cancels startup and later lifetime without orphaning processes or config', async () => {
    const { options, journal } = await fixture('silent');
    const controller = new AbortController();
    const pending = OpenClawManagedRuntime.start({ ...options, signal: controller.signal });
    const outcome = pending.then(() => new Error('Unexpected runtime readiness'), error => error as Error);
    await eventually(async () => {
      try { return (await readJournal(journal)).length === 2; } catch { return false; }
    });
    controller.abort();
    expect((await outcome).message).toContain('cancelled');
    expect(await fs.readdir(options.storageDir)).toEqual([]);

    const other = await fixture();
    const lifetime = new AbortController();
    const handle = await OpenClawManagedRuntime.start({ ...other.options, signal: lifetime.signal });
    handles.push(handle);
    lifetime.abort();
    await handle.dispose();
    expect(await fs.readdir(other.options.storageDir)).toEqual([]);
  });

  it('does not spawn after a pre-aborted signal, unsupported release, non-entrypoint executable, or missing startup plugin', async () => {
    const { options, journal } = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(OpenClawManagedRuntime.start({ ...options, signal: controller.signal })).rejects.toThrow('cancelled');
    await fs.writeFile(path.join(options.installedRoot, 'package.json'), '{"name":"openclaw","version":"future"}');
    await expect(OpenClawManagedRuntime.start(options)).rejects.toThrow('2026.6.34');
    await fs.writeFile(path.join(options.installedRoot, 'package.json'), '{"name":"openclaw","version":"2026.6.34"}');
    await expect(OpenClawManagedRuntime.start({ ...options, cliPath: process.execPath })).rejects.toThrow('entrypoint');
    await fs.writeFile(path.join(options.pluginPath, 'openclaw.plugin.json'), '{"id":"mysti-policy"}');
    await expect(OpenClawManagedRuntime.start(options)).rejects.toThrow('startup plugin');
    await expect(fs.access(journal)).rejects.toThrow();
  });
});
