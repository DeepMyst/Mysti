/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';

/**
 * Codex 0.153.4's native allow rules bypass both its approval policy and sandbox.
 * The release CLI has no supported option to ignore those rules. Inspect their
 * sources before starting the process, then verify the same snapshot after the
 * native thread has loaded its policy, before sending any model input.
 *
 * This intentionally supports a conservative subset of TOML. It never reads
 * auth.json, keychains, token files, or the contents of rejected rule files.
 */
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SOURCES = 256;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

const FORCED: Readonly<Record<string, string | boolean | readonly string[]>> = Object.freeze({
  approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'read-only',
  web_search: 'disabled', allow_login_shell: false, notify: Object.freeze([]),
  'agents.enabled': false,
  'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false,
  'features.hooks': false, 'features.plugin_hooks': false,
  'features.multi_agent_v2': false, 'features.browser_use': false,
  'features.browser_use_external': false, 'features.computer_use': false,
  'features.image_generation': false, 'features.code_mode': false,
  'features.code_mode_only': false, 'features.code_mode_host': false,
  'features.js_repl': false, 'features.request_permissions_tool': false,
  'features.exec_permission_approvals': false, 'features.write_stdin_approval': true,
  'features.shell_zsh_fork': false, 'features.shell_snapshot': false,
  'features.shell_snapshot_v2': false, 'features.skill_mcp_dependency_install': false,
  'features.apply_patch_streaming_events': false,
  'features.tool_suggest': false, 'features.recommended_plugins': false,
  'features.memories': false, 'features.memory_tool': false,
});

/** Pass every entry as a separate `-c`, value pair; never through a shell. */
export const CODEX_NATIVE_CONFIG_OVERRIDES: readonly string[] = Object.freeze(
  Object.entries(FORCED).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
);

export interface CodexNativeConfigSnapshot {
  /** Recheck after native thread/start or resume, before turn/start. */
  assertUnchanged(): Promise<void>;
}

/** Dependency injection for isolated filesystem fixtures; no process environment changes. */
export interface CodexNativeConfigInspection {
  userConfigDirectory?: string;
  systemConfigDirectory?: string;
  managedPreferencesPresent?: () => Promise<boolean>;
}

function unsupported(reason: string): Error {
  return new Error(`Codex native approvals cannot verify this configuration: ${reason}.`);
}

const SIMPLE_KEYS = new Set([
  'model', 'review_model', 'model_provider', 'model_reasoning_effort',
  'model_reasoning_summary', 'model_verbosity', 'model_context_window',
  'model_auto_compact_token_limit', 'model_auto_compact_token_limit_scope',
  'service_tier', 'cli_auth_credentials_store', 'forced_login_method',
  'forced_chatgpt_workspace_id', 'check_for_update_on_startup',
  'hide_agent_reasoning', 'show_raw_agent_reasoning', 'suppress_unstable_features_warning',
  'disable_paste_burst', 'personality', 'developer_instructions',
]);
const PROVIDER_KEYS = new Set([
  'name', 'base_url', 'env_key', 'env_key_instructions', 'wire_api',
  'requires_openai_auth', 'request_max_retries', 'stream_max_retries',
  'stream_idle_timeout_ms', 'supports_websockets',
]);

/** Decode only ordinary TOML strings; reject multiline and unsupported syntax. */
function stringValue(text: string): string | undefined {
  if (text.startsWith("'") && text.endsWith("'") && !text.slice(1, -1).includes("'")) {
    return text.slice(1, -1);
  }
  if (text.startsWith('"') && text.endsWith('"') && !text.startsWith('"""')) {
    try { const value: unknown = JSON.parse(text); return typeof value === 'string' ? value : undefined; }
    catch { return undefined; }
  }
  return undefined;
}

/** Split dotted TOML keys without interpreting dots or comment markers in quotes. */
function keyPath(text: string): string[] {
  const parts: string[] = [];
  let token = ''; let quote = ''; let escaped = false;
  for (const char of text) {
    if (quote) {
      token += char;
      if (escaped) { escaped = false; }
      else if (quote === '"' && char === '\\') { escaped = true; }
      else if (char === quote) { quote = ''; }
    } else if (char === '"' || char === "'") { quote = char; token += char; }
    else if (char === '.') { parts.push(token.trim()); token = ''; }
    else { token += char; }
  }
  if (quote) { throw unsupported('unsupported TOML key syntax'); }
  parts.push(token.trim());
  return parts.map(part => {
    if (/^[A-Za-z0-9_-]+$/.test(part)) { return part; }
    const decoded = stringValue(part);
    if (decoded !== undefined && decoded.length > 0 && ![...decoded].some(char => char.charCodeAt(0) < 32)) { return decoded; }
    throw unsupported('unsupported TOML key syntax');
  });
}

function stripComment(line: string): string {
  let quote = ''; let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (escaped) { escaped = false; }
      else if (quote === '"' && char === '\\') { escaped = true; }
      else if (char === quote) { quote = ''; }
    } else if (char === '"' || char === "'") { quote = char; }
    else if (char === '#') { return line.slice(0, index).trim(); }
  }
  if (quote) { throw unsupported('multiline or unterminated TOML values require review'); }
  return line.trim();
}

function isSafeKey(parts: string[]): boolean {
  const joined = parts.join('.');
  if (Object.prototype.hasOwnProperty.call(FORCED, joined)) { return true; }
  if (parts.length === 1 && SIMPLE_KEYS.has(parts[0])) { return true; }
  if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'trust_level') { return true; }
  if (parts.length === 3 && parts[0] === 'model_providers' && PROVIDER_KEYS.has(parts[2])) { return true; }
  if (parts.length === 2 && parts[0] === 'history' && ['persistence', 'max_bytes'].includes(parts[1])) { return true; }
  if (parts.length === 2 && ['analytics', 'feedback'].includes(parts[0]) && parts[1] === 'enabled') { return true; }
  if (parts.length === 2 && parts[0] === 'sandbox_workspace_write'
    && ['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'].includes(parts[1])) { return true; }
  return false;
}

function inspectToml(text: string): void {
  let section: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) { continue; }
    if (line.startsWith('[')) {
      if (!line.endsWith(']') || line.startsWith('[[')) { throw unsupported('unsupported TOML table syntax'); }
      section = keyPath(line.slice(1, -1));
      // Empty authority tables are also rejected: table merging cannot erase
      // inherited MCP servers, hooks, profiles, or alternative runtimes.
      if (!['projects', 'model_providers', 'features', 'agents', 'history', 'analytics', 'feedback', 'sandbox_workspace_write'].includes(section[0])) {
        throw unsupported('an unsupported configuration table is present');
      }
      continue;
    }
    // Locate the first unquoted assignment separator.
    let quote = ''; let escaped = false; let assignment = -1;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (quote) {
        if (escaped) { escaped = false; }
        else if (quote === '"' && char === '\\') { escaped = true; }
        else if (char === quote) { quote = ''; }
      } else if (char === '"' || char === "'") { quote = char; }
      else if (char === '=') { assignment = index; break; }
    }
    if (assignment < 1) { throw unsupported('unsupported TOML assignment syntax'); }
    const parts = [...section, ...keyPath(line.slice(0, assignment))];
    const identity = JSON.stringify(parts);
    if (seen.has(identity) || !isSafeKey(parts)) { throw unsupported('an unsupported or repeated configuration key is present'); }
    seen.add(identity);
    const value = line.slice(assignment + 1).trim();
    if (stringValue(value) === undefined && !/^(true|false|-?[0-9]+(?:\.[0-9]+)?)$/.test(value)
      && !(parts.join('.') === 'notify' && value === '[]')) {
      throw unsupported('structured or multiline configuration values require review');
    }
  }
}

async function statOrMissing(filename: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try { return await fs.lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw unsupported('a configuration source could not be inspected'); }
}

async function fileText(filename: string, stamps: string[]): Promise<string | undefined> {
  const before = await statOrMissing(filename);
  if (!before) { stamps.push(`${filename}:missing`); return undefined; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONFIG_BYTES) { throw unsupported('configuration files must be bounded regular files'); }
  let contents: Buffer;
  try { contents = await fs.readFile(filename); }
  catch { throw unsupported('a configuration file could not be read'); }
  const after = await statOrMissing(filename);
  if (!after || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || contents.byteLength > MAX_CONFIG_BYTES) { throw unsupported('configuration changed while it was being inspected'); }
  stamps.push(`${filename}:${after.dev}:${after.ino}:${after.mtimeMs}:${createHash('sha256').update(contents).digest('hex')}`);
  return contents.toString('utf8');
}

function ancestors(directory: string): string[] {
  const result: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    if (result.length >= MAX_SOURCES) { throw unsupported('too many ancestor configuration sources'); }
    result.push(current);
    if (path.dirname(current) === current) { return result; }
  }
}

/** Query only the two Codex managed keys; never print their values or errors. */
async function hasMacManagedPreferences(): Promise<boolean> {
  if (process.platform !== 'darwin') { return false; }
  for (const key of ['config_toml_base64', 'requirements_toml_base64']) {
    const exists = await new Promise<boolean>((resolve, reject) => {
      execFile('/usr/bin/defaults', ['read', 'com.openai.codex', key], { timeout: 5000, maxBuffer: MAX_CONFIG_BYTES }, (error, _stdout, stderr) => {
        if (!error) { resolve(true); }
        else if (error.code === 1 && /does not exist/.test(stderr)) { resolve(false); }
        else { reject(unsupported('managed preferences could not be inspected')); }
      });
    });
    if (exists) { return true; }
  }
  return false;
}

/** Reject authority that the supported native protocol cannot bind to host approval. */
export async function captureCodexNativeConfig(
  cwd: string, env: NodeJS.ProcessEnv = process.env, inspection: CodexNativeConfigInspection = {},
): Promise<CodexNativeConfigSnapshot> {
  if (process.platform === 'win32') { throw unsupported('Windows native configuration and process ownership are not supported yet'); }
  if (!path.isAbsolute(cwd)) { throw unsupported('the working directory must be absolute'); }
  const userDirectory = inspection.userConfigDirectory ?? env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const systemDirectory = inspection.systemConfigDirectory ?? '/etc/codex';
  if (!path.isAbsolute(userDirectory) || !path.isAbsolute(systemDirectory)) { throw unsupported('configuration directories must be absolute'); }
  const checkManaged = inspection.managedPreferencesPresent ?? hasMacManagedPreferences;

  const capture = async (): Promise<string> => {
    if (await checkManaged()) { throw unsupported('managed preferences can replace native approval authority'); }
    const stamps: string[] = [];
    let realCwd: string;
    try { realCwd = await fs.realpath(cwd); }
    catch { throw unsupported('the working directory could not be resolved'); }
    const projectDirectories = new Set([...ancestors(path.resolve(cwd)), ...ancestors(realCwd)]);
    const configDirectories = new Set([path.resolve(userDirectory), path.resolve(systemDirectory)]);
    for (const directory of projectDirectories) {
      configDirectories.add(path.join(directory, '.codex'));
      const gitFile = path.join(directory, '.git');
      const gitStat = await statOrMissing(gitFile);
      if (!gitStat?.isFile()) { continue; }
      const gitText = await fileText(gitFile, stamps);
      const match = /^gitdir: (.+)\s*$/.exec(gitText ?? '');
      if (!match) { throw unsupported('linked checkout metadata could not be verified'); }
      const gitDirectory = path.resolve(directory, match[1].trim());
      const common = await fileText(path.join(gitDirectory, 'commondir'), stamps);
      if (common !== undefined) {
        const commonDirectory = path.resolve(gitDirectory, common.trim());
        configDirectories.add(path.join(path.dirname(commonDirectory), '.codex'));
      }
    }
    if (configDirectories.size > MAX_SOURCES) { throw unsupported('too many configuration sources'); }
    for (const directory of [...configDirectories].sort()) {
      const directoryStat = await statOrMissing(directory);
      if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) {
        throw unsupported('configuration directories must not be links or special files');
      }
      stamps.push(`${directory}:${directoryStat ? `${directoryStat.dev}:${directoryStat.ino}` : 'missing'}`);
      for (const blocked of ['managed_config.toml', 'requirements.toml', 'hooks.json']) {
        const filename = path.join(directory, blocked);
        if (await statOrMissing(filename)) { throw unsupported(`${blocked} requires a separate native authority review`); }
        stamps.push(`${filename}:missing`);
      }
      const rulesDirectory = path.join(directory, 'rules');
      const rulesStat = await statOrMissing(rulesDirectory);
      if (rulesStat && (!rulesStat.isDirectory() || rulesStat.isSymbolicLink())) { throw unsupported('the native rules directory is not a regular directory'); }
      let entries: string[] = [];
      if (rulesStat) {
        try { entries = await fs.readdir(rulesDirectory); }
        catch { throw unsupported('the native rules directory could not be inspected'); }
        if (entries.some(name => name.endsWith('.rules'))) { throw unsupported('native .rules files can bypass host approval'); }
      }
      stamps.push(`${rulesDirectory}:${rulesStat ? `${rulesStat.dev}:${rulesStat.ino}:${rulesStat.mtimeMs}` : 'missing'}:${entries.sort().join('\0')}`);
      const config = await fileText(path.join(directory, 'config.toml'), stamps);
      if (config !== undefined) { inspectToml(config); }
    }
    return createHash('sha256').update(stamps.join('\n')).digest('hex');
  };
  const original = await capture();
  return Object.freeze({ assertUnchanged: async () => {
    if (await capture() !== original) { throw unsupported('configuration changed while the native thread was starting'); }
  } });
}

/**
 * Call with both native responses before thread/start and again before turn/start.
 * The public requirements shape omits execpolicy rules, so ANY non-null managed
 * requirements must be rejected, including an apparently empty object.
 */
export function assertCodexServerConfigSafe(configRead: unknown, requirementsRead: unknown): void {
  if (!object(requirementsRead) || requirementsRead.requirements !== null) {
    throw unsupported('native managed requirements are present or could not be verified');
  }
  if (!object(configRead) || !object(configRead.config) || !Array.isArray(configRead.layers)) {
    throw unsupported('native configuration provenance is missing');
  }
  for (const layer of configRead.layers) {
    if (!object(layer) || !object(layer.name) || typeof layer.name.type !== 'string'
      || !['system', 'user', 'project', 'sessionFlags'].includes(layer.name.type)) {
      throw unsupported('an unsupported native configuration source is active');
    }
    if (layer.name.type === 'user' && layer.name.profile !== undefined && layer.name.profile !== null) { throw unsupported('named profiles require a separate native authority review'); }
  }
  for (const [key, expected] of Object.entries(FORCED)) {
    let actual: unknown = configRead.config;
    for (const part of key.split('.')) { actual = object(actual) ? actual[part] : undefined; }
    // Legacy feature aliases may disappear from the native normalized view.
    if (['features.js_repl', 'features.plugin_hooks'].includes(key) && actual === undefined) { continue; }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) { throw unsupported(`native override ${key} was not confirmed`); }
  }
  const config = configRead.config;
  if ((config.profile !== undefined && config.profile !== null) || (object(config.profiles) && Object.keys(config.profiles).length)
    || (object(config.mcp_servers) && Object.keys(config.mcp_servers).length)) {
    throw unsupported('native profiles or MCP servers are configured');
  }
}
