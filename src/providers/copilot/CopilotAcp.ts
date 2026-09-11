/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Settings, ToolCall } from '../../types';
import { isRecord } from '../../utils/valueGuards';
import { clampEffort } from '../../utils/effort';
import type { AcpNativeLaunch, AcpNativeLaunchContext, AcpObject } from '../base/AcpNativeTypes';

const TOOLS = ['view', 'grep', 'glob'];
export function copilotAcpArgs(settings: Readonly<Settings>, model?: string): string[] {
  const args = ['--acp', '--no-auto-update', '--no-remote', '--no-remote-export', '--no-bash-env',
    '--no-custom-instructions', '--disable-builtin-mcps', '--no-experimental', '--available-tools', ...TOOLS, '--deny-tool', 'shell', 'write'];
  if (model) { args.push('--model', model); }
  const effort = clampEffort(settings.effortLevel, ['low', 'medium', 'high', 'xhigh']);
  if (effort) { args.push('--effort', effort); }
  return args;
}

/**
 * 1.0.83 bypasses ACP for workspace edits and some redirected shell commands.
 * Its verified executable map is read/search only. Outside-path permissions
 * grant broader access than one operation, so no permission request may widen
 * this boundary, even if the host would otherwise approve it.
 */
export function decodeCopilotPermission(_params: Readonly<AcpObject>, _trackedTool?: Readonly<AcpObject>): ToolCall | undefined {
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
    env.COPILOT_ALLOW_ALL = 'false';
    // This disables GitHub authentication and its managed-policy refresh while
    // preserving the separately configured custom model provider.
    env.COPILOT_OFFLINE = 'true';
    env.COPILOT_AUTO_UPDATE = 'false';
    env.COPILOT_DISABLE_LOGIN_SHELL_ENV = '1';
    env.COPILOT_PLUGIN_DIR_ONLY = '1';
    env.USE_TGREP = 'false';
    return {
      args: copilotAcpArgs(context.settings, model), env,
      expectedAgentInfo: { name: 'Copilot', version: '1.0.83' },
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
