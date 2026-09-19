/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { terminateOwnedProcessGroup } from './OwnedProcessGroup';
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';
import { pathToFileURL } from 'url';
import WebSocket from 'ws';
import { killProcessTree } from '../../utils/processKill';
import { getEnrichedEnv } from '../../utils/platform';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../base/NativeCliVersions';

type JsonObject = Record<string, unknown>;
export interface OpenClawManagedRuntimeOptions {
  cliPath: string;
  installedRoot: string;
  storageDir: string;
  workspaceDir: string;
  /** Deliberately supplied settings only. This launcher never reads the user's config/auth stores. */
  baseConfig: JsonObject;
  pluginPath: string;
  preloadPath: string;
  broker: { url: string; token: string; runtimeId: string };
  signal?: AbortSignal;
  startupTimeoutMs?: number;
}
export interface OpenClawManagedRuntimeHandle {
  gatewayUrl: string;
  token: string;
  dispose(): Promise<void>;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function abortError(): Error { return new Error('OpenClaw managed runtime startup cancelled'); }
function assertActive(signal?: AbortSignal): void { if (signal?.aborted) { throw abortError(); } }
function cloneConfig(value: JsonObject): JsonObject {
  // Config includes and executable/file secret providers would escape owned state.
  const json = JSON.stringify(value, (key, entry: unknown) => {
    if (['__proto__', 'prototype', 'constructor', '$include'].includes(key)) {
      throw new Error('OpenClaw managed runtime does not support config includes or prototype keys');
    }
    if (entry && typeof entry === 'object' && ['file', 'exec'].includes(String(object(entry).source))) {
      throw new Error('OpenClaw managed runtime requires inline or environment credentials');
    }
    return entry;
  });
  return JSON.parse(json) as JsonObject;
}
function modelRefs(value: unknown): string[] {
  if (typeof value === 'string') { return [value]; }
  const selection = object(value);
  return [selection.primary, ...(Array.isArray(selection.fallbacks) ? selection.fallbacks : [])]
    .filter((entry): entry is string => typeof entry === 'string');
}
function enforcePi(entry: JsonObject): void {
  const id = object(entry.agentRuntime).id;
  if (id !== undefined && !['openclaw', 'pi', 'auto', 'default'].includes(String(id))) {
    throw new Error('OpenClaw managed approval runtime supports only the embedded OpenClaw/Pi harness');
  }
  entry.agentRuntime = { id: 'openclaw' };
}

/** Only the inspected 2026.6.34 schema is supported; CLI validation checks the final owned config. */
export function buildOpenClawManagedConfig(options: OpenClawManagedRuntimeOptions, stateDir: string, port: number, token: string): JsonObject {
  const base = cloneConfig(options.baseConfig);
  if (base.env !== undefined && (base.env === null || typeof base.env !== 'object' || Array.isArray(base.env) || Object.keys(base.env).length > 0)) {
    throw new Error('OpenClaw managed runtime does not support config.env; supply inline provider credentials or process environment credentials');
  }
  const agents = object(base.agents);
  const defaults = object(agents.defaults);
  if (object(base.acp).enabled === true || (Array.isArray(agents.list) && agents.list.length > 0)) {
    throw new Error('OpenClaw managed runtime requires default model settings without ACP or custom agent entries');
  }
  const refs = modelRefs(defaults.model);
  const primary = typeof defaults.model === 'string' ? defaults.model : object(defaults.model).primary;
  if (typeof primary !== 'string' || !refs.length || refs.some(ref => !/^[^/\s]+\/[^\s]+$/.test(ref))) {
    throw new Error('OpenClaw managed runtime requires an explicit provider/model primary and qualified fallbacks');
  }
  const modelMap = object(defaults.models);
  const providers = object(object(base.models).providers);
  for (const [id, value] of Object.entries(providers)) {
    const provider = object(value);
    if (provider.localService) { throw new Error('OpenClaw managed runtime does not launch provider localService commands'); }
    enforcePi(provider);
    if (Array.isArray(provider.models)) { provider.models.forEach(value => enforcePi(object(value))); }
    providers[id] = provider;
    modelMap[`${id}/*`] ??= {};
  }
  for (const ref of refs) {
    modelMap[ref] ??= {};
    modelMap[`${ref.slice(0, ref.indexOf('/'))}/*`] ??= {};
  }
  for (const [ref, value] of Object.entries(modelMap)) {
    if (!/^[^/\s]+\/[^\s]+$/.test(ref)) { throw new Error('OpenClaw managed model map requires provider-qualified keys'); }
    const entry = object(value);
    enforcePi(entry);
    modelMap[ref] = entry;
  }
  const keptDefaults: JsonObject = {};
  for (const key of ['model', 'thinkingDefault', 'reasoningDefault', 'verboseDefault', 'contextTokens', 'timeoutSeconds', 'params']) {
    if (defaults[key] !== undefined) { keptDefaults[key] = defaults[key]; }
  }
  return {
    ...(base.auth ? { auth: base.auth } : {}),
    ...(base.secrets ? { secrets: base.secrets } : {}),
    models: { mode: 'replace', providers },
    agents: {
      defaults: { ...keptDefaults, models: modelMap, workspace: options.workspaceDir, skipBootstrap: true,
        heartbeat: { every: '0m' }, memorySearch: { enabled: false } },
      list: [{ id: 'main', default: true, runtime: { type: 'embedded' }, workspace: options.workspaceDir,
        agentDir: path.join(stateDir, 'agents', 'main', 'agent') }],
    },
    plugins: { enabled: true, allow: ['mysti-policy'], slots: { memory: 'none' }, load: { paths: [options.pluginPath] },
      entries: {
        'mysti-policy': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: false }, config: { broker: options.broker } },
        // 2026.6.34 runs this bundled doctor's migrations even for disabled plugins.
        // Its default vault ignores OPENCLAW_HOME, so explicitly confine its path.
        'memory-wiki': { enabled: false, config: { vault: { path: path.join(stateDir, 'wiki') } } },
      } },
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token, allowTailscale: false },
      controlUi: { enabled: false }, tailscale: { mode: 'off' }, reload: { mode: 'off' }, channelHealthCheckMinutes: 0 },
    channels: {}, cron: { enabled: false }, hooks: { enabled: false, internal: { enabled: false } },
    // The verified final-execute guard owns these decisions in this process.
    // Excluding process also prevents exec from continuing after a background yield.
    tools: { allow: ['read', 'write', 'edit', 'exec'], deny: ['process', 'apply_patch'], exec: { host: 'gateway', security: 'full', ask: 'off' } },
    acp: { enabled: false }, browser: { enabled: false },
    discovery: { mdns: { mode: 'off' }, wideArea: { enabled: false } },
    update: { checkOnStart: false, auto: { enabled: false } },
    crestodian: { rescue: { enabled: false } },
    logging: { level: 'warn', consoleLevel: 'warn', file: path.join(stateDir, 'gateway.log'), redactSensitive: 'tools' },
  };
}

function childEnvironment(options: OpenClawManagedRuntimeOptions, runDir: string, configPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(OPENCLAW_|CLAWDBOT_|LITECLAW_|PI_CODING_AGENT_DIR$|CODEX_HOME$|MYSTI_OPENCLAW_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)) { env[key] = value; }
  }
  return { ...env,
    PATH: getEnrichedEnv().PATH,
    OPENCLAW_HOME: path.join(runDir, 'home'), OPENCLAW_STATE_DIR: path.join(runDir, 'state'),
    OPENCLAW_CONFIG_PATH: configPath, TMPDIR: path.join(runDir, 'tmp'), TMP: path.join(runDir, 'tmp'), TEMP: path.join(runDir, 'tmp'),
    OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1',
    OPENCLAW_SKIP_GMAIL_WATCHER: '1', OPENCLAW_SKIP_CANVAS_HOST: '1', OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: '1',
    // Native shell snapshots spawn detached helpers outside the gateway group.
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    MYSTI_OPENCLAW_OWNED_RUNTIME: '1', MYSTI_OPENCLAW_ROOT: options.installedRoot,
    NODE_OPTIONS: `--import=${pathToFileURL(options.preloadPath).href}`,
  };
}
async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No owned gateway port')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function helloProbe(url: string, token: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024 });
    let settled = false;
    const finish = (result: boolean, error?: Error) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.terminate();
      if (error) { reject(error); } else { resolve(result); }
    };
    const abort = () => finish(false, abortError());
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    let sent = false;
    socket.on('message', data => {
      let frame: JsonObject;
      try { frame = object(JSON.parse(data.toString())); } catch { return; }
      if (frame.type === 'event' && frame.event === 'connect.challenge' && !sent) {
        sent = true;
        socket.send(JSON.stringify({ type: 'req', id: 'mysti-runtime-readiness', method: 'connect', params: {
          minProtocol: 3, maxProtocol: 4, client: { id: 'gateway-client', version: '1.0.0', platform: process.platform, mode: 'backend' },
          role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'], caps: [], auth: { token },
        } }));
      } else if (frame.type === 'res' && frame.id === 'mysti-runtime-readiness' && sent) {
        const payload = object(frame.payload);
        const methods = object(payload.features).methods;
        const scopes = object(payload.auth).scopes;
        if (frame.ok !== true || payload.type !== 'hello-ok' || ![3, 4].includes(payload.protocol as number) ||
            object(payload.server).version !== VERIFIED_NATIVE_CLI_VERSIONS.openclaw || !Array.isArray(methods) ||
            !methods.includes('agent') || !methods.includes('sessions.abort') ||
            object(payload.auth).role !== 'operator' || !Array.isArray(scopes) || !scopes.includes('operator.write')) {
          finish(false, new Error('Owned OpenClaw gateway rejected the required version/protocol handshake'));
        } else { finish(true); }
      }
    });
    if (signal.aborted) { abort(); }
  });
}

/** Owns only an ephemeral private gateway; native policy attestation remains the caller's submission gate. */
export class OpenClawManagedRuntime {
  static async start(options: OpenClawManagedRuntimeOptions): Promise<OpenClawManagedRuntimeHandle> {
    assertActive(options.signal);
    if (process.platform === 'win32') {
      throw new Error('OpenClaw owned native approvals require POSIX process groups; Windows requires an owned Job Object before it can be supported');
    }
    options = { ...options, baseConfig: cloneConfig(options.baseConfig), broker: { ...options.broker } };
    if (options.startupTimeoutMs !== undefined && (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 1 || options.startupTimeoutMs > 120000)) {
      throw new Error('OpenClaw managed startup timeout must be between 1 and 120000 milliseconds');
    }
    for (const location of [options.cliPath, options.installedRoot, options.storageDir, options.workspaceDir, options.pluginPath, options.preloadPath]) {
      if (!path.isAbsolute(location)) { throw new Error('OpenClaw managed runtime requires absolute paths'); }
    }
    const brokerUrl = new URL(options.broker.url);
    if (brokerUrl.protocol !== 'ws:' || brokerUrl.hostname !== '127.0.0.1' || !brokerUrl.port || brokerUrl.username || brokerUrl.password ||
        !/^[a-f0-9]{64}$/.test(options.broker.token) || !options.broker.runtimeId || options.broker.runtimeId.length > 256) {
      throw new Error('OpenClaw approval broker must use an authenticated owned loopback endpoint');
    }
    const root = await fs.realpath(options.installedRoot);
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as JsonObject;
    if (metadata.name !== 'openclaw' || metadata.version !== VERIFIED_NATIVE_CLI_VERSIONS.openclaw) {
      throw new Error(`OpenClaw managed runtime requires verified OpenClaw ${VERIFIED_NATIVE_CLI_VERSIONS.openclaw}`);
    }
    if (await fs.realpath(options.cliPath) !== await fs.realpath(path.join(root, 'openclaw.mjs'))) {
      throw new Error('OpenClaw CLI must resolve to the verified installation entrypoint');
    }
    await fs.access(options.preloadPath);
    const manifest = JSON.parse(await fs.readFile(path.join(options.pluginPath, 'openclaw.plugin.json'), 'utf8')) as JsonObject;
    if (manifest.id !== 'mysti-policy' || object(manifest.activation).onStartup !== true) {
      throw new Error('OpenClaw managed runtime requires the mysti-policy startup plugin');
    }
    // Validate unsupported settings before allocating storage or spawning any process.
    buildOpenClawManagedConfig(options, options.storageDir, 1, 'preflight');
    await fs.mkdir(options.storageDir, { recursive: true, mode: 0o700 });
    const runDir = await fs.mkdtemp(path.join(options.storageDir, 'openclaw-owned-'));
    await fs.chmod(runDir, 0o700);
    const controller = new AbortController();
    const children = new Set<ChildProcess>();
    const cleanupErrors: unknown[] = [];
    const groupCleanup = new Map<ChildProcess, Promise<void>>();
    const retireGroup = (child: ChildProcess): Promise<void> => {
      const existing = groupCleanup.get(child);
      if (existing) { return existing; }
      const cleanup = (async () => {
        try {
          if (typeof child.pid === 'number') { await terminateOwnedProcessGroup(child.pid); }
        } catch (error) { cleanupErrors.push(error); }
        finally { children.delete(child); }
      })();
      groupCleanup.set(child, cleanup);
      return cleanup;
    };
    let ready = false;
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (disposal) { return disposal; }
      controller.abort();
      options.signal?.removeEventListener('abort', onAbort);
      disposal = (async () => {
        await Promise.all([...children].map(async child => {
          await killProcessTree(child, 1000, { useProcessGroup: process.platform !== 'win32' });
          // The leader may be exiting while its group still exists. Share the
          // exit listener's cleanup and wait for actual group disappearance.
          await retireGroup(child);
        }));
        if (cleanupErrors.length > 0) { throw new Error('OpenClaw owned process group cleanup failed', { cause: cleanupErrors[0] }); }
        await fs.rm(runDir, { recursive: true, force: true });
      })();
      return disposal;
    };
    const onAbort = () => {
      controller.abort();
      // During provisioning, start owns cleanup so an abort cannot remove its directory mid-write.
      if (ready) { void dispose().catch(() => { /* explicit dispose can observe cleanup failures */ }); }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = options.startupTimeoutMs ?? 60000;
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const run = (args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; completed: Promise<void> } => {
      assertActive(controller.signal);
      const child = spawn(options.cliPath, args, { cwd: runDir, env, stdio: ['ignore', 'ignore', 'ignore'],
        detached: process.platform !== 'win32', windowsHide: true });
      children.add(child);
      const completed = new Promise<void>((resolve, reject) => {
        child.once('error', () => { children.delete(child); reject(new Error('OpenClaw managed CLI could not start')); });
        child.once('exit', (code, signal) => {
          void retireGroup(child).then(() => {
            if (cleanupErrors.length > 0) { reject(new Error('OpenClaw owned process group cleanup failed', { cause: cleanupErrors[0] })); }
            else if (code === 0) { resolve(); }
            else { reject(new Error(`OpenClaw managed CLI exited (${code ?? signal ?? 'unknown'})`)); }
          });
        });
      });
      // A gateway may exit while readiness is awaiting a socket; always observe it.
      void completed.catch(() => undefined);
      return { child, completed };
    };
    try {
      if (options.signal?.aborted) { controller.abort(); }
      for (const name of ['state', 'home', 'tmp']) { await fs.mkdir(path.join(runDir, name), { mode: 0o700 }); }
      const port = await freeLoopbackPort();
      const token = randomBytes(32).toString('hex');
      const configPath = path.join(runDir, 'openclaw.json');
      const config = buildOpenClawManagedConfig(options, path.join(runDir, 'state'), port, token);
      await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
      const env = childEnvironment({ ...options, installedRoot: root }, runDir, configPath);
      const preflight = run(['config', 'validate', '--json'], env);
      await withAbort(preflight.completed, controller.signal);
      const gateway = run(['gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], env);
      const gatewayUrl = `ws://127.0.0.1:${port}`;
      let exited = false;
      gateway.child.once('exit', () => { exited = true; });
      gateway.child.once('error', () => { exited = true; });
      void gateway.completed.then(() => { exited = true; }, () => { exited = true; });
      while (Date.now() < deadline) {
        assertActive(controller.signal);
        if (exited) { throw new Error('Owned OpenClaw gateway exited before readiness'); }
        if (await helloProbe(gatewayUrl, token, controller.signal, Math.min(750, Math.max(1, deadline - Date.now())))) {
          if (exited) { throw new Error('Owned OpenClaw gateway exited during readiness'); }
          clearTimeout(timer);
          // Unexpected exit revokes this ephemeral runtime and its credentials.
          gateway.child.once('exit', onAbort);
          assertActive(controller.signal);
          ready = true;
          return { gatewayUrl, token, dispose };
        }
        await withAbort(new Promise(resolve => setTimeout(resolve, 50)), controller.signal);
      }
      throw new Error('OpenClaw managed runtime startup timed out');
    } catch (error) {
      clearTimeout(timer);
      await dispose();
      if (Date.now() >= deadline && !options.signal?.aborted) { throw new Error('OpenClaw managed runtime startup timed out'); }
      throw error;
    }
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
    if (signal.aborted) { abort(); }
  });
}
