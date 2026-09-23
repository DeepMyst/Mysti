/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import fs from 'fs/promises';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import type { Settings, ToolCall, UsageStats } from '../../types';
import type { AcpNativeLaunch, AcpNativeLaunchContext, AcpObject } from '../base/AcpNativeTypes';
import { isRecord } from '../../utils/valueGuards';
import { toolKind } from '../../utils/toolNames';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../base/NativeCliVersions';

/** Audited against upstream tag v1.18.29, commit 16747470f976aca3d362ad730bcd3fe82ecc2c9a. */
export const OPENCODE_ACP_VERSION = VERIFIED_NATIVE_CLI_VERSIONS.opencode;
export const OPENCODE_HOST_AGENT = 'mysti-host';
export const OPENCODE_ENV_AUTH: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ['ANTHROPIC_API_KEY'], openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'], deepseek: ['DEEPSEEK_API_KEY'], mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'], togetherai: ['TOGETHER_API_KEY'], fireworks: ['FIREWORKS_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'], cerebras: ['CEREBRAS_API_KEY'], nvidia: ['NVIDIA_API_KEY'],
});

function openCodeRestricted(settings: Pick<Settings, 'mode' | 'accessLevel'>): boolean {
  return settings.accessLevel === 'read-only' || settings.mode === 'quick-plan' || settings.mode === 'detailed-plan';
}

/**
 * Shell is offered only in unrestricted tiers, only through the shell gate
 * plugin below, and only where the gate and Stop were verified against the
 * native release (macOS). Elsewhere shell stays removed and V1 plugins off.
 */
export function openCodeShellEnabled(settings: Pick<Settings, 'mode' | 'accessLevel'>, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && !openCodeRestricted(settings);
}

export function openCodePermissionPolicy(settings: Pick<Settings, 'mode' | 'accessLevel'>): Record<string, string> {
  const restricted = openCodeRestricted(settings);
  // A wildcard deny removes unsupported tools from the native executable map
  // (Permission.disabled -> LLMRequestPrep.resolveTools). Shell starts denied
  // here too; only the registered shell gate plugin can turn it into `ask`.
  return { '*': 'deny', read: 'ask', glob: 'ask', grep: 'ask', edit: restricted ? 'deny' : 'ask', webfetch: restricted ? 'deny' : 'ask' };
}

/**
 * OpenCode's shell tool (1.18.29-1.18.32, tool/shell.ts `ask`) skips its
 * permission request when its parser yields no command pattern, e.g. a bare
 * `> file`. This plugin closes that gap without a second approval channel:
 *
 * - `config` runs only for hooks already in the instance's registered list; it
 *   is the only thing that changes `bash` from deny to ask, so the tool exists
 *   only where these hooks exist. It then writes the startup attestation.
 * - Event listeners run synchronously inside `publish`, so `permission.asked`
 *   and `permission.replied` (published before the waiting tool resumes) are
 *   recorded before the shell can continue.
 * - `shell.env` runs after the permission step and immediately before every
 *   spawn. It allows a call only after this call's own bash request was
 *   answered `once`. No request, a rejection, `always`, a reused or duplicate
 *   call id all throw, which aborts the spawn. So does the `stopped` file, which
 *   Mysti writes the moment Stop begins: an approval answered just before Stop
 *   cannot start its command while OpenCode has yet to read the cancel.
 */
export function openCodeShellGatePlugin(nonce: string, attestation: string, stopped: string): string {
  return `import { existsSync, writeFileSync } from "node:fs";
const NONCE = ${JSON.stringify(nonce)}, ATTESTATION = ${JSON.stringify(attestation)}, STOPPED = ${JSON.stringify(stopped)}, AGENT = ${JSON.stringify(OPENCODE_HOST_AGENT)};
export default {
  id: "mysti-shell-gate",
  server: async (input) => {
    const calls = new Map(), requests = new Map();
    const key = (session, call) => typeof session === "string" && session && typeof call === "string" && call ? session + "\\u0000" + call : undefined;
    return {
      config: async (cfg) => {
        const agent = cfg && cfg.agent && cfg.agent[AGENT];
        if (!cfg || !cfg.permission || !agent || !agent.permission) return;
        cfg.permission.bash = "ask"; agent.permission.bash = "ask";
        writeFileSync(ATTESTATION, JSON.stringify({ nonce: NONCE, directory: input.directory,
          plugins: (cfg.plugin_origins || []).map((origin) => origin.spec) }), { mode: 0o600 });
      },
      event: async ({ event }) => {
        const properties = event && event.properties;
        if (!properties) return;
        if (event.type === "permission.asked" && properties.permission === "bash") {
          const call = key(properties.sessionID, properties.tool && properties.tool.callID);
          if (call === undefined) return;
          if (calls.get(call) === "started" && typeof properties.id === "string" && !requests.has(properties.id)) {
            calls.set(call, "asked"); requests.set(properties.id, call);
          } else calls.set(call, "refused");
        } else if (event.type === "permission.replied") {
          const call = requests.get(properties.requestID);
          if (call === undefined) return;
          requests.delete(properties.requestID);
          if (calls.get(call) !== "asked") return;
          if (properties.reply === "once") calls.set(call, "approved"); else calls.delete(call);
        }
      },
      "tool.execute.before": async (call) => {
        if (call.tool !== "bash") return;
        const id = key(call.sessionID, call.callID);
        if (id !== undefined) calls.set(id, calls.has(id) ? "refused" : "started");
      },
      "shell.env": async (call) => {
        const id = key(call.sessionID, call.callID);
        const state = id === undefined ? undefined : calls.get(id);
        if (id !== undefined) calls.delete(id);
        if (state !== "approved") throw new Error("Mysti refused a shell command that OpenCode did not submit for approval.");
        if (existsSync(STOPPED)) throw new Error("Mysti refused a shell command after Stop.");
      },
    };
  },
};
`;
}

export function openCodeNativeConfig(settings: Pick<Settings, 'mode' | 'accessLevel'>, model: string, plugin?: string): AcpObject {
  const permission = openCodePermissionPolicy(settings);
  return {
    $schema: 'https://opencode.ai/config.json', model, small_model: model,
    enabled_providers: [model.split('/')[0]], default_agent: OPENCODE_HOST_AGENT,
    permission, subagent_depth: 0, snapshot: false, share: 'disabled', autoupdate: false,
    formatter: false, lsp: false, plugin: plugin ? [plugin] : [], mcp: {}, command: {}, instructions: [],
    compaction: { auto: false, prune: false },
    agent: {
      [OPENCODE_HOST_AGENT]: { mode: 'primary', permission, description: 'Mysti approval-controlled file, search, fetch, and shell tools.' },
      build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true },
      title: { permission: { '*': 'deny' } }, summary: { permission: { '*': 'deny' } }, compaction: { permission: { '*': 'deny' } },
    },
  };
}

/** Sources outside XDG isolation are rejected without reading their contents. */
export function openCodeExternalAuthorityPaths(env: NodeJS.ProcessEnv, platform = process.platform, userDirectory = os.homedir(), username = os.userInfo().username): string[] {
  const paths = [path.join(userDirectory, '.opencode')];
  const managed = platform === 'darwin' ? '/Library/Application Support/opencode'
    : platform === 'win32' ? path.join(env.ProgramData || 'C:\\ProgramData', 'opencode') : '/etc/opencode';
  paths.push(managed);
  if (platform === 'darwin') {
    paths.push(path.join('/Library/Managed Preferences', username, 'ai.opencode.managed.plist'), '/Library/Managed Preferences/ai.opencode.managed.plist');
  }
  return paths;
}

/** Core V2 discovers these even when V1 project configuration/pure flags deny it. */
export async function openCodeWorkspaceAuthorityPaths(cwd: string): Promise<string[]> {
  const roots = new Set<string>();
  for (const initial of [path.resolve(cwd), await fs.realpath(cwd)]) {
    for (let directory = initial;; directory = path.dirname(directory)) {
      roots.add(directory);
      if (path.dirname(directory) === directory) { break; }
    }
  }
  return [...roots].flatMap(directory => ['opencode.json', 'opencode.jsonc', '.opencode'].map(name => path.join(directory, name)));
}

export async function assertOpenCodeAuthorityAbsent(paths: readonly string[]): Promise<void> {
  for (const candidate of paths) {
    try { await fs.lstat(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
      throw new Error(`OpenCode native approvals cannot inspect configuration authority at ${candidate}.`);
    }
    throw new Error(`OpenCode native approvals cannot isolate configuration at ${candidate}. Use an environment without this OpenCode configuration; Mysti will not start an unguarded run.`);
  }
}

/** Only ordinary process settings and the selected provider's API key enter the child. */
export function openCodeIsolatedEnv(parent: NodeJS.ProcessEnv, directory: string, config: AcpObject, provider: string, pure = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'ProgramData', ...(OPENCODE_ENV_AUTH[provider] ?? [])]) {
    if (parent[key] !== undefined) { env[key] = parent[key]; }
  }
  for (const [key, subdir] of Object.entries({ XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache' })) {
    env[key] = path.join(directory, subdir);
  }
  Object.assign(env, {
    TMPDIR: directory, TEMP: directory, TMP: directory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PERMISSION: JSON.stringify(config.permission),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOCOMPACT: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_FFF: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
    OPENCODE_SERVER_USERNAME: 'mysti', OPENCODE_SERVER_PASSWORD: randomBytes(32).toString('hex'),
    // Native config initialization tries a background dependency check even in
    // --pure mode. It may write only private runtime state and must not fetch
    // packages or execute lifecycle scripts.
    npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
    npm_config_userconfig: path.join(directory, 'empty.npmrc'), npm_config_globalconfig: path.join(directory, 'empty-global.npmrc'),
    npm_config_cache: path.join(directory, 'npm-cache'),
  });
  // Pure mode skips every V1 server plugin, including the shell gate. Without
  // it, V1 loads only the configured gate: project configuration is disabled,
  // the XDG directories are private, and the remaining global/managed sources
  // are rejected before launch and attested absent after startup.
  if (pure) { env.OPENCODE_PURE = 'true'; }
  return env;
}

export async function prepareOpenCodeNativeLaunch(context: AcpNativeLaunchContext, model: string | undefined, platform: NodeJS.Platform = process.platform): Promise<AcpNativeLaunch> {
  if (!model || !/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new Error('OpenCode native approvals require an explicit provider/model ID in Mysti’s OpenCode model setting. Native user configuration and login stores are isolated.');
  }
  const provider = model.split('/')[0];
  const keys = Object.hasOwn(OPENCODE_ENV_AUTH, provider) ? OPENCODE_ENV_AUTH[provider] : undefined;
  if (!keys || !keys.some(key => context.env[key]?.trim())) {
    throw new Error(`OpenCode native approvals require ${keys?.join(' or ') ?? 'a supported provider API key'} in the extension environment for ${provider}. Native OpenCode login stores and custom providers are not used.`);
  }
  const canonicalCwd = await fs.realpath(context.cwd);
  const externalAuthority = openCodeExternalAuthorityPaths(context.env);
  const assertUnchanged = async () => {
    if (await fs.realpath(context.cwd) !== canonicalCwd) { throw new Error('OpenCode native workspace changed during startup.'); }
    await assertOpenCodeAuthorityAbsent([...externalAuthority, ...await openCodeWorkspaceAuthorityPaths(context.cwd)]);
  };
  await assertUnchanged();
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-acp-')));
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, 'empty.npmrc'), '', { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'empty-global.npmrc'), '', { mode: 0o600 });
    const shell = openCodeShellEnabled(context.settings, platform);
    const plugin = path.join(directory, 'mysti-shell-gate.mjs');
    const attestation = path.join(directory, 'shell-gate-attestation.json');
    const stopped = path.join(directory, 'stopped');
    const nonce = randomBytes(32).toString('hex');
    if (shell) { await fs.writeFile(plugin, openCodeShellGatePlugin(nonce, attestation, stopped), { mode: 0o600 }); }
    const pluginSpec = pathToFileURL(plugin).href;
    const config = openCodeNativeConfig(context.settings, model, shell ? pluginSpec : undefined);
    return {
      args: ['acp', ...(shell ? [] : ['--pure']), '--hostname', '127.0.0.1', '--port', '0', '--cwd', context.cwd],
      env: openCodeIsolatedEnv(context.env, directory, config, provider, !shell),
      expectedAgentInfo: { name: 'OpenCode', version: OPENCODE_ACP_VERSION },
      mode: OPENCODE_HOST_AGENT, model, images: true,
      // This native release emits an optional UI mirror write even when the
      // capability was advertised false. Reject it; native execution performs
      // the already approved edit. Mysti never writes the requested file.
      nonFatalUnsupportedRequests: ['fs/write_text_file'],
      decodePermission: decodeOpenCodePermission,
      // On abort this release SIGTERMs each running shell's whole process group
      // (core cross-spawn-spawner killGroup, SIGKILL after 3 s). That reaches a
      // background job whose foreground shell already exited: it is no longer a
      // descendant, so the tree kill alone misses it. Stop therefore blocks new
      // spawns and kills current descendants at once, then waits for the
      // cancelled prompt result before the freeze and tree kill, bounded.
      ...(shell ? { cancelGraceMs: 5000, onStop: () => writeFileSync(stopped, '', { mode: 0o600 }) } : {}),
      decodeUsage: decodeOpenCodeUsage,
      validateUpdate: update => validateOpenCodeConfigUpdate(update, model),
      validateSession(result) {
        const options = Array.isArray(result.configOptions) ? result.configOptions.filter(isRecord) : [];
        const mode = options.find(option => option.id === 'mode');
        if (!mode || mode.currentValue !== OPENCODE_HOST_AGENT) { throw new Error('OpenCode did not select the fixed Mysti permission agent.'); }
      },
      // Bootstrap loads plugins before the session exists, so the gate has
      // attested by now. Without it shell would stay denied; refuse the turn
      // anyway so a missing gate or an extra plugin is never silent.
      configure: shell ? async () => {
        let attested: unknown;
        try { attested = JSON.parse(await fs.readFile(attestation, 'utf8')); } catch { attested = undefined; }
        if (!isRecord(attested) || attested.nonce !== nonce || (attested.directory !== context.cwd && attested.directory !== canonicalCwd)
          || !Array.isArray(attested.plugins) || attested.plugins.length !== 1 || attested.plugins[0] !== pluginSpec) {
          throw new Error('OpenCode did not attest Mysti\'s shell approval gate as its only plugin; Mysti will not start this turn.');
        }
      } : undefined,
      assertUnchanged,
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The pinned native configuration surface has model, effort, and mode only.
 * Mode and provider/model remain fixed for the lifetime of a captured turn. */
export function validateOpenCodeConfigUpdate(update: Readonly<AcpObject>, model: string): void {
  if (update.sessionUpdate !== 'config_option_update') { return; }
  if (!Array.isArray(update.configOptions) || update.configOptions.some(option => !isRecord(option)
    || !['model', 'mode', 'effort'].includes(String(option.id)))) {
    throw new Error('OpenCode reported an unsupported native configuration change.');
  }
  const options = update.configOptions as AcpObject[];
  if (new Set(options.map(option => option.id)).size !== options.length) {
    throw new Error('OpenCode reported conflicting native configuration identities.');
  }
  if (options.find(option => option.id === 'mode')?.currentValue !== OPENCODE_HOST_AGENT
    || options.find(option => option.id === 'model')?.currentValue !== model) {
    throw new Error('OpenCode changed the captured native mode or model.');
  }
}

export function decodeOpenCodeUsage(result: Readonly<AcpObject>): UsageStats | undefined {
  if (!isRecord(result.usage)) { return; }
  const { inputTokens, outputTokens } = result.usage;
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0
    || typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0) { return; }
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

/** The final native request owns edit/fetch/shell inputs; read/search and
 * shell's workdir need the preceding immutable update because 1.18.29 omits
 * them. Custom tools and mode changes are excluded by the isolated policy. */
export function decodeOpenCodePermission(params: Readonly<AcpObject>, tracked: Readonly<AcpObject> | undefined): ToolCall | undefined {
  if (!isRecord(params.toolCall)) { return; }
  const call = params.toolCall;
  if (typeof call.toolCallId !== 'string' || !call.toolCallId || !isRecord(call.rawInput)) { return; }
  if (tracked?.toolCallId !== call.toolCallId || tracked.status === 'completed' || tracked.status === 'failed') { return; }
  const raw = call.rawInput;
  const previous = isRecord(tracked.rawInput) ? tracked.rawInput : undefined;
  let name: string;
  let input: AcpObject;
  if (call.kind === 'edit' && tracked.kind === 'edit') {
    const files = Array.isArray(raw.files) ? raw.files : undefined;
    if (files) {
      if (files.length === 0 || files.length > 1024 || !files.every(file => isRecord(file) && typeof file.filePath === 'string' && path.isAbsolute(file.filePath) && typeof file.patch === 'string' && file.patch.length > 0 && (file.movePath === undefined || typeof file.movePath === 'string' && path.isAbsolute(file.movePath)))) { return; }
    } else if (typeof raw.filepath !== 'string' || !path.isAbsolute(raw.filepath) || typeof raw.diff !== 'string' || !raw.diff) { return; }
    name = 'Edit'; input = raw;
  } else if (call.kind === 'read' && tracked.kind === 'read' && previous && typeof previous.filePath === 'string' && previous.filePath) {
    if (Object.keys(raw).length !== 0) { return; }
    name = 'Read'; input = previous;
  } else if (call.kind === 'search' && tracked.kind === 'search' && previous && typeof previous.pattern === 'string' && previous.pattern) {
    if (typeof raw.pattern !== 'string' || raw.pattern !== previous.pattern) { return; }
    name = tracked.title === 'glob' ? 'Glob' : 'Grep'; input = { ...previous, ...raw };
  } else if (call.kind === 'fetch' && tracked.kind === 'fetch' && typeof raw.url === 'string' && /^https?:\/\//.test(raw.url)) {
    if (!previous || previous.url !== raw.url) { return; }
    name = 'WebFetch'; input = raw;
  } else if (call.kind === 'execute' && tracked.kind === 'execute' && typeof raw.command === 'string' && raw.command) {
    // The request carries only the command; the running update carries the
    // model's arguments. `workdir` is the only other argument that changes
    // where it runs (outside the workspace it is denied natively).
    if (Object.keys(raw).length !== 1 || !previous || previous.command !== raw.command) { return; }
    if (previous.workdir !== undefined && typeof previous.workdir !== 'string') { return; }
    name = 'Bash'; input = { command: raw.command, ...(previous.workdir !== undefined ? { workdir: previous.workdir } : {}) };
  } else { return; }
  return { id: call.toolCallId, name, input, status: 'running', kind: toolKind(name) };
}
