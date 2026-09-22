/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Settings, ToolCall } from '../../types';
import { isRecord } from '../../utils/valueGuards';
import { clampEffort } from '../../utils/effort';
import { toolKind } from '../../utils/toolNames';
import type { AcpNativeLaunch, AcpNativeLaunchContext, AcpObject } from '../base/AcpNativeTypes';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../base/NativeCliVersions';

const READ_TOOLS = ['view', 'grep', 'glob'];
// apply_patch serves OpenAI-family models, edit/create Claude-family ones.
const WRITE_TOOLS = ['bash', 'apply_patch', 'edit', 'create'];
const isRestricted = (settings: Readonly<Settings>) => settings.accessLevel === 'read-only' || ['quick-plan', 'detailed-plan'].includes(settings.mode);

export function copilotAcpArgs(settings: Readonly<Settings>, model?: string): string[] {
  const args = ['--acp', '--no-auto-update', '--no-remote', '--no-remote-export', '--no-bash-env',
    '--no-custom-instructions', '--disable-builtin-mcps', '--no-experimental', '--available-tools', ...READ_TOOLS];
  // Restricted tiers never expose mutation tools, independent of host policy.
  if (isRestricted(settings)) { args.push('--deny-tool', 'shell', 'write'); } else { args.splice(args.indexOf('--available-tools') + 1, 0, ...WRITE_TOOLS); }
  if (model) { args.push('--model', model); }
  const effort = clampEffort(settings.effortLevel, ['low', 'medium', 'high', 'xhigh']);
  if (effort) { args.push('--effort', effort); }
  return args;
}

// A sync shell is discarded when its command ends; one still running after
// initial_wait belongs to the agent process tree that Stop and turn end kill.
const SHELL_KEYS = new Set(['command', 'description', 'mode', 'initial_wait', 'shellId']);

/**
 * 1.0.83 sends one ACP request per shell command and per patched file before
 * executing it, and a reject prevents the effect (runtime-verified with a
 * private profile; the earlier "bypass" was COPILOT_ALLOW_ALL being set).
 * Only a sync command whose request repeats the announced command, or one
 * file's absolute path with its diff, can be approved. Async/detached shells,
 * outside-path/URL grants and every other kind are denied.
 */
export function decodeCopilotPermission(params: Readonly<AcpObject>, tracked?: Readonly<AcpObject>): ToolCall | undefined {
  const call = params.toolCall;
  if (!isRecord(call) || typeof call.toolCallId !== 'string' || !call.toolCallId || !isRecord(call.rawInput)) { return; }
  if (!tracked || tracked.toolCallId !== call.toolCallId || tracked.kind !== call.kind
    || tracked.status === 'completed' || tracked.status === 'failed') { return; }
  const raw = call.rawInput;
  if (call.kind === 'execute') {
    const announced = isRecord(tracked.rawInput) ? tracked.rawInput : undefined;
    if (typeof raw.command !== 'string' || !raw.command.trim() || announced?.command !== raw.command
      || Object.keys(announced).some(key => !SHELL_KEYS.has(key))
      || (announced.mode !== undefined && announced.mode !== 'sync')) { return; }
    return { id: call.toolCallId, name: 'Bash', input: { command: raw.command }, status: 'running', kind: toolKind('Bash') };
  }
  if (call.kind === 'edit') {
    if (typeof raw.fileName !== 'string' || !path.isAbsolute(raw.fileName) || typeof raw.diff !== 'string' || !raw.diff) { return; }
    return { id: call.toolCallId, name: 'Edit', input: { file_path: raw.fileName, diff: raw.diff }, status: 'running', kind: toolKind('Edit') };
  }
  return undefined;
}

async function assertNoInheritedAuthority(cwd: string): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('Copilot native approvals are not enabled on Windows until machine policy and registry hooks can be attested.');
  }
  const roots = new Set<string>();
  for (const initial of [path.resolve(cwd), await fs.realpath(cwd)]) {
    for (let current = initial;; current = path.dirname(current)) {
      roots.add(current);
      if (path.dirname(current) === current) { break; }
    }
  }
  // Linked worktrees can discover policy from the common checkout as well.
  for (const root of [...roots]) {
    const gitFile = path.join(root, '.git');
    let pointer: string;
    try { if (!(await fs.lstat(gitFile)).isFile()) { continue; } pointer = await fs.readFile(gitFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
    const match = /^gitdir:\s*([^\r\n]+)\s*$/u.exec(pointer);
    if (!match) { throw new Error('Copilot cannot attest this worktree Git configuration.'); }
    const gitDir = await fs.realpath(path.resolve(root, match[1]));
    let common: string;
    try { common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
    const commonDir = await fs.realpath(path.resolve(gitDir, common));
    if (path.basename(commonDir) !== '.git') { throw new Error('Copilot cannot attest this worktree common repository.'); }
    for (let current = path.dirname(commonDir);; current = path.dirname(current)) {
      roots.add(current); if (path.dirname(current) === current) { break; }
    }
  }
  const sources = ['.github/hooks', '.github/copilot/settings.json', '.github/copilot/settings.local.json',
    '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.github/mcp.json', '.github/plugins'];
  const candidates = [...roots].flatMap(root => sources.map(file => path.join(root, file)));
  // Policy hooks bypass disableAllHooks. Device settings can change discovery.
  candidates.push('/etc/github-copilot/policy.d', '/etc/github-copilot/managed-settings.json',
    '/Library/Application Support/GitHubCopilot/managed-settings.json',
    // MDM can be delivered in per-user subdirectories; an unmanaged machine is
    // required until native CFPreferences policy is exposed for attestation.
    '/Library/Managed Preferences', path.join(os.homedir(), 'Library/Managed Preferences'));
  for (const candidate of candidates) {
    try {
      const info = await fs.lstat(candidate);
      if (info.isDirectory() && (await fs.readdir(candidate)).length === 0) { continue; }
    }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { continue; } throw error; }
    throw new Error(`Copilot native approvals cannot use inherited executable or managed configuration: ${candidate}`);
  }
}

export async function prepareCopilotAcpLaunch(context: AcpNativeLaunchContext, model?: string): Promise<AcpNativeLaunch> {
  if (!context.env.COPILOT_PROVIDER_BASE_URL?.trim()) {
    throw new Error('Copilot native approvals currently require COPILOT_PROVIDER_BASE_URL (BYOK). GitHub-token and stored-login sessions can load unobservable managed execution policy and are not supported.');
  }
  await assertNoInheritedAuthority(context.cwd);
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-copilot-acp-'));
  const cleanup = () => fs.rm(state, { recursive: true, force: true });
  try {
    const policy = JSON.stringify({ disableAllHooks: true, defaultPermissionMode: 'manual',
      enabledPlugins: {}, ide: { autoConnect: false }, enableMemory: false, });
    await fs.writeFile(path.join(state, 'settings.json'), policy, { mode: 0o600 });
    const env = { ...context.env };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('COPILOT_') && !key.startsWith('COPILOT_PROVIDER_') && key !== 'COPILOT_GITHUB_TOKEN' && key !== 'COPILOT_OFFLINE')
        || ['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'ZSH_ENV', 'KSH_ENV', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'].includes(key)) { delete env[key]; }
    }
    env.COPILOT_HOME = state;
    env.COPILOT_CACHE_HOME = path.join(state, 'cache');
    // COPILOT_ALLOW_ALL stays unset (the scrub above removes any inherited
    // value). Before 1.0.85 any non-empty value, including 'false', enables
    // allow-all while the session's allow_all option still reports off.
    // This disables GitHub authentication and its managed-policy refresh while
    // preserving the separately configured custom model provider.
    env.COPILOT_OFFLINE = 'true';
    env.COPILOT_AUTO_UPDATE = 'false';
    env.COPILOT_DISABLE_LOGIN_SHELL_ENV = '1';
    env.COPILOT_PLUGIN_DIR_ONLY = '1';
    env.USE_TGREP = 'false';
    return {
      args: copilotAcpArgs(context.settings, model), env,
      expectedAgentInfo: { name: 'Copilot', version: VERIFIED_NATIVE_CLI_VERSIONS['github-copilot'] },
      // Autopilot changes native permissions. Keep all host access tiers manual.
      mode: context.settings.accessLevel === 'read-only' || ['quick-plan', 'detailed-plan'].includes(context.settings.mode) ? 'https://agentclientprotocol.com/protocol/session-modes#plan' : 'https://agentclientprotocol.com/protocol/session-modes#agent',
      images: true, decodePermission: decodeCopilotPermission,
      validateSession(result) {
        if (!Array.isArray(result.configOptions) || !result.configOptions.some(option => isRecord(option) && option.id === 'allow_all' && option.currentValue === 'off')) {
          throw new Error('Copilot did not attest that native allow-all permissions are disabled.');
        }
      },
      validateUpdate(update) {
        if (update.sessionUpdate !== 'config_option_update') { return; }
        if (!Array.isArray(update.configOptions) || update.configOptions.some(option => isRecord(option) && option.id === 'allow_all' && option.currentValue !== 'off')) {
          throw new Error('Copilot changed native allow-all permissions.');
        }
      },
      assertUnchanged: async () => {
        await assertNoInheritedAuthority(context.cwd);
        const actual = JSON.parse(await fs.readFile(path.join(state, 'settings.json'), 'utf8'));
        if (!isRecord(actual) || actual.disableAllHooks !== true || actual.defaultPermissionMode !== 'manual'
          || !isRecord(actual.enabledPlugins) || Object.keys(actual.enabledPlugins).length > 0
          || !isRecord(actual.ide) || actual.ide.autoConnect !== false
          || Object.keys(actual).some(key => !['disableAllHooks', 'defaultPermissionMode', 'enabledPlugins', 'ide', 'enableMemory', 'experimental', 'bashEnv'].includes(key))
          || actual.experimental === true || actual.bashEnv === true) {
          throw new Error('Copilot changed the native approval policy during startup.');
        }
      }, cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}
