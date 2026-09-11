/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { isRecord } from '../../utils/valueGuards';

type Flavor = 'qwen' | 'gemini';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Do not inherit interpreter preload/startup code or private native host hooks. */
export function nativeFamilyEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (['NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'CLI_VERSION', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BUN_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'ZSH_ENV', 'KSH_ENV'].includes(key)
      || /^(?:QWEN|GEMINI)_/.test(key) && /(?:GUARD|PARENT|CAPABILITY|DAEMON|COMMAND|ENTRY|SIMPLE|SAFE_MODE|HOOK|PRELOAD|SANDBOX|IDE_|RELAUNCH|LAUNCHER|MANAGED_NPM|STARTUP_VERSION|COMPILE_CACHE|CODE_CLI$)/.test(key)) { delete env[key]; }
  }
  // Do not accept executable external-account authentication providers. The
  // native SDK only enables credential_source.executable when this flag is set.
  env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES = '0';
  return env;
}

/**
 * Read-only startup check for the two pinned Gemini-family runtimes. Neither
 * runtime exposes an effective-policy attestation. Refuse customization that
 * can install executable startup behavior and verify the sources again before
 * model input. This detects ordinary changes, not an adversarial host ABA race.
 */
export async function captureNativeFamilyConfig(options: {
  flavor: Flavor; cwd: string; env: NodeJS.ProcessEnv; cliPath: string;
  version: string; policyFiles: string[];
}): Promise<{ cliPath: string; assertUnchanged(): Promise<void> }> {
  const { flavor, cwd, env } = options;
  const label = flavor === 'qwen' ? 'Qwen Code' : 'Gemini CLI';
  const error = (detail: string): never => { throw new Error(`${label} native approval setup refused: ${detail}.`); };
  const snapshots = new Map<string, string>();
  const customizationDirs = new Set<string>();
  async function signature(file: string, inspect?: (data: string) => void): Promise<string> {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) { return error('a native configuration source is a symbolic link'); }
      if (stat.isDirectory()) {
        const names = (await fs.readdir(file)).sort().filter(name => !(flavor === 'qwen' && path.basename(file) === 'extensions' && name === 'extension-enablement.json'));
        if (names.length) { return error(`custom native ${path.basename(file)} are present`); }
        // Native startup creates empty directories and Qwen's extension
        // enablement metadata. With no extension payload, these cannot install
        // executable behavior; creation is equivalent to their prior absence.
        return customizationDirs.has(file) ? 'empty-customization' : `directory:${stat.dev}:${stat.ino}:${names.join(',')}`;
      }
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) { return error('unsupported native configuration file'); }
      const data = await fs.readFile(file, 'utf8'); inspect?.(data);
      return `${stat.dev}:${stat.ino}:${stat.size}:${hash(data)}`;
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') { return customizationDirs.has(file) ? 'empty-customization' : 'absent'; }
      throw reason;
    }
  }
  async function capture(file: string, inspect?: (data: string) => void): Promise<void> {
    if (!snapshots.has(file)) { snapshots.set(file, await signature(file, inspect)); }
  }
  let resolvedCli: string | undefined;
  const candidates = path.isAbsolute(options.cliPath) ? [options.cliPath]
    : options.cliPath.includes(path.sep) ? [path.resolve(cwd, options.cliPath)]
      : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, options.cliPath));
  for (const candidate of candidates) {
    try { resolvedCli = await fs.realpath(candidate); break; } catch (reason) {
      if (!['ENOENT', 'ENOTDIR'].includes((reason as NodeJS.ErrnoException).code || '')) { throw reason; }
    }
  }
  if (!resolvedCli) { return error('the configured CLI executable could not be resolved'); }
  let packagePath: string | undefined;
  for (let dir = path.dirname(resolvedCli), depth = 0; depth < 4; depth++, dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    try {
      const value = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (value.name === (flavor === 'qwen' ? '@qwen-code/qwen-code' : '@google/gemini-cli')) {
        if (value.version !== options.version) { return error(`only version ${options.version} has a verified bridge`); }
        packagePath = candidate; break;
      }
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') { throw reason; }
    }
  }
  if (!packagePath) { return error(`select the installed ${label} ${options.version} npm executable`); }
  await capture(resolvedCli); await capture(packagePath);

  const ancestors = new Set<string>();
  for (const start of [path.resolve(cwd), await fs.realpath(cwd)]) {
    for (let dir = start; ; dir = path.dirname(dir)) { ancestors.add(dir); if (dir === path.dirname(dir)) { break; } }
  }
  // Some provider context/agent discovery uses the shared project root for a
  // linked worktree. Resolve only Git's small path metadata; never run Git (its
  // configuration can itself install executable startup hooks).
  for (const dir of [...ancestors]) {
    const gitFile = path.join(dir, '.git');
    try {
      const stat = await fs.lstat(gitFile);
      if (stat.isSymbolicLink()) { return error('Git workspace metadata is a symbolic link'); }
      if (!stat.isFile()) { continue; }
      if (stat.size > 8192) { return error('Git workspace metadata is malformed'); }
      const text = await fs.readFile(gitFile, 'utf8'); const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
      if (!match) { return error('Git workspace metadata is malformed'); }
      await capture(gitFile);
      const gitDir = path.resolve(dir, match[1].trim()); const commonFile = path.join(gitDir, 'commondir');
      await capture(commonFile);
      if (snapshots.get(commonFile) === 'absent') { continue; }
      const relativeCommon = (await fs.readFile(commonFile, 'utf8')).trim();
      if (!relativeCommon || relativeCommon.length > 8192 || relativeCommon.includes('\n')) { return error('Git shared workspace metadata is malformed'); }
      const mainRoot = path.dirname(path.resolve(gitDir, relativeCommon));
      for (let main = mainRoot; ; main = path.dirname(main)) { ancestors.add(main); if (main === path.dirname(main)) { break; } }
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') { throw reason; }
    }
  }
  const nativeDir = flavor === 'qwen' ? '.qwen' : '.gemini';
  const nativeHome = flavor === 'qwen' ? env.QWEN_HOME || path.join(os.homedir(), nativeDir)
    : path.join(env.GEMINI_CLI_HOME || os.homedir(), nativeDir);
  const configDirs = new Set([path.resolve(cwd, nativeHome), ...[...ancestors].map(dir => path.join(dir, nativeDir))]);
  function inspectSettings(data: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return error('native settings must be plain JSON for policy verification'); }
    if (!isRecord(parsed)) { return error('native settings must be an object'); }
    const allowed = new Set(['$version', 'model', 'modelProviders', 'security', 'general', 'ui', 'permissions']);
    if (Object.keys(parsed).some(key => !allowed.has(key))) { return error('native settings contain unsupported customization; use an isolated provider configuration'); }
    if (isRecord(parsed.security) && Object.keys(parsed.security).some(key => !['auth', 'folderTrust'].includes(key))) {
      return error('native security customization cannot be verified');
    }
    function rejectExecutableAuth(value: unknown, depth = 0): void {
      if (depth > 32) { return error('native model/auth configuration is too deeply nested'); }
      if (typeof value === 'string' && value.startsWith('!')) { return error('executable native model/auth values are unsupported'); }
      if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          if (/(?:command|executable|script|helper|hook|preload|plugin)/i.test(key)) { return error('executable native model/auth configuration is unsupported'); }
          rejectExecutableAuth(entry, depth + 1);
        }
      }
    }
    rejectExecutableAuth(parsed.model); rejectExecutableAuth(parsed.modelProviders);
    if (isRecord(parsed.security)) { rejectExecutableAuth(parsed.security.auth); }
    if (isRecord(parsed.general) && Object.keys(parsed.general).some(key => !['language', 'theme', 'enableAutoUpdate', 'preventSystemSleep'].includes(key))) {
      return error('native startup customization cannot be verified');
    }
    // Model/authentication data remain in their original file. They are never
    // logged, copied into a policy, or returned to the caller.
  }
  for (const dir of configDirs) {
    await capture(path.join(dir, 'settings.json'), inspectSettings);
    for (const name of ['hooks', 'extensions', 'agents', 'commands', 'skills', 'policies']) {
      const file = path.join(dir, name); customizationDirs.add(file); await capture(file);
    }
    await capture(path.join(dir, '.env'), () => error('a native .env file can redirect startup policy'));
  }
  for (const dir of ancestors) {
    await capture(path.join(dir, '.env'), () => error('a workspace .env file can redirect startup policy'));
    await capture(path.join(dir, '.mcp.json'), () => error('project MCP customization is not supported by this bridge'));
  }
  const systemDir = process.platform === 'darwin' ? `/Library/Application Support/${flavor === 'qwen' ? 'QwenCode' : 'GeminiCli'}`
    : process.platform === 'win32' ? `C:\\ProgramData\\${flavor === 'qwen' ? 'qwen-code' : 'gemini-cli'}`
      : `/etc/${flavor === 'qwen' ? 'qwen-code' : 'gemini-cli'}`;
  const prefix = flavor === 'qwen' ? 'QWEN_CODE' : 'GEMINI_CLI';
  for (const file of new Set([path.join(systemDir, 'settings.json'), path.join(systemDir, 'system-defaults.json'),
    env[`${prefix}_SYSTEM_SETTINGS_PATH`], env[`${prefix}_SYSTEM_DEFAULTS_PATH`]].filter((item): item is string => Boolean(item)))) {
    if (options.policyFiles.includes(file)) { continue; }
    await capture(file, () => error('managed native settings would conflict with the host policy'));
  }
  if (flavor === 'gemini') {
    const file = path.join(systemDir, 'policies'); customizationDirs.add(file); await capture(file);
  }
  for (const file of options.policyFiles) {
    await capture(file);
    if (snapshots.get(file) === 'absent') { return error('the bundled host policy is missing'); }
  }
  return { cliPath: resolvedCli, assertUnchanged: async () => {
    for (const [file, previous] of snapshots) {
      if (await signature(file) !== previous) { return error('native configuration changed during startup'); }
    }
  } };
}
