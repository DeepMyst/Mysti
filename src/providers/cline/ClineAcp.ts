/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolCall } from '../../types';
import { isRecord } from '../../utils/valueGuards';
import { toolKind } from '../../utils/toolNames';
import type { AcpNativeLaunch, AcpNativeLaunchContext, AcpObject } from '../base/AcpNativeTypes';

const TOOLS: Readonly<Record<string, { name: string; kind: string }>> = {
  read_file: { name: 'Read', kind: 'read' }, read_files: { name: 'Read', kind: 'read' },
  list_files: { name: 'Glob', kind: 'search' }, search_files: { name: 'Grep', kind: 'search' },
  search_codebase: { name: 'Grep', kind: 'search' },
  write_file: { name: 'Write', kind: 'edit' }, write_to_file: { name: 'Write', kind: 'edit' },
  replace_in_file: { name: 'Edit', kind: 'edit' }, edit_file: { name: 'Edit', kind: 'edit' },
  editor: { name: 'Edit', kind: 'edit' },
  run_commands: { name: 'Bash', kind: 'execute' }, execute_command: { name: 'Bash', kind: 'execute' },
  fetch_web_content: { name: 'WebFetch', kind: 'fetch' }, web_search: { name: 'WebSearch', kind: 'search' },
  Read: { name: 'Read', kind: 'read' }, Glob: { name: 'Glob', kind: 'search' }, Grep: { name: 'Grep', kind: 'search' },
  Write: { name: 'Write', kind: 'edit' }, Edit: { name: 'Edit', kind: 'edit' }, Bash: { name: 'Bash', kind: 'execute' },
  WebFetch: { name: 'WebFetch', kind: 'fetch' }, WebSearch: { name: 'WebSearch', kind: 'search' },
};

/** Cline's title starts with the actual tool name; kind alone mislabels Agent as think. */
export function decodeClinePermission(params: Readonly<AcpObject>): ToolCall | undefined {
  const tool = params.toolCall;
  if (!isRecord(tool) || typeof tool.toolCallId !== 'string' || typeof tool.title !== 'string' || !isRecord(tool.rawInput)) { return; }
  const actual = tool.title.split(':', 1)[0];
  const supported = Object.hasOwn(TOOLS, actual) ? TOOLS[actual] : undefined;
  if (!supported || tool.kind !== supported.kind) { return; }
  const input = tool.rawInput;
  if (input.run_in_background === true || input.background === true || input.detached === true) { return; }
  // The native run_commands schema supports an array. Never approve an empty
  // command card or a request carrying an execution location hidden from the UI.
  if (supported.name === 'Bash' && typeof input.command !== 'string' && !Array.isArray(input.commands)) { return; }
  return { id: tool.toolCallId, name: supported.name, input, status: 'running', kind: toolKind(supported.name) };
}

async function assertNoInheritedAuthority(cwd: string): Promise<void> {
  const roots = new Set<string>();
  for (const initial of [path.resolve(cwd), await fs.realpath(cwd)]) {
    for (let current = initial;; current = path.dirname(current)) {
      roots.add(current);
      if (path.dirname(current) === current) { break; }
    }
  }
  const candidates = [...roots].flatMap(root => ['.cline/plugins', '.cline/hooks', '.clinerules/hooks', '.cline/settings.json', '.cline/hooks.json', '.cline/mcp.json'].map(file => path.join(root, file)));
  // These legacy global paths do not honor CLINE_DIR.
  candidates.push(path.join(os.homedir(), 'Documents/Cline/Hooks'), path.join(os.homedir(), 'Documents/Cline/Plugins'));
  for (const candidate of candidates) {
    try {
      const info = await fs.lstat(candidate);
      if (info.isDirectory() && (await fs.readdir(candidate)).length === 0) { continue; }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') { continue; } throw error; }
    throw new Error(`Cline native approvals require an execution configuration without inherited hooks or plugins: ${candidate}`);
  }
}

export async function prepareClineAcpLaunch(context: AcpNativeLaunchContext, model?: string): Promise<AcpNativeLaunch> {
  if (!context.env.CLINE_API_KEY?.trim()) {
    throw new Error('Cline native approvals currently require CLINE_API_KEY in the extension environment. Stored CLI login profiles cannot be imported into the isolated approval session.');
  }
  await assertNoInheritedAuthority(context.cwd);
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-cline-acp-'));
  const cleanup = () => fs.rm(state, { recursive: true, force: true });
  try {
    const env = { ...context.env };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('CLINE_') && !['CLINE_API_KEY', 'CLINE_PROVIDER'].includes(key)) || ['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'ZSH_ENV', 'KSH_ENV'].includes(key)) { delete env[key]; }
    }
    // The native ACP entry point ignores --model/--plan; set them by RPC.
    env.CLINE_DIR = state;
    env.CLINE_DATA_DIR = path.join(state, 'data');
    env.CLINE_SESSION_BACKEND_MODE = 'local';
    return {
      args: ['--acp', '--auto-approve', 'false'], env,
      expectedAgentInfo: { name: 'cline', version: '3.0.61' },
      mode: context.settings.accessLevel === 'read-only' || ['quick-plan', 'detailed-plan'].includes(context.settings.mode) ? 'plan' : 'act',
      model, images: false, decodePermission: decodeClinePermission,
      validateSession(result) {
        const options = result.configOptions;
        if (!Array.isArray(options) || !options.some(option => isRecord(option) && option.id === 'auto_approve' && option.currentValue === false)) {
          throw new Error('Cline did not attest that native auto-approval is disabled.');
        }
      },
      validateUpdate(update) {
        if (update.sessionUpdate !== 'config_option_update') { return; }
        if (!Array.isArray(update.configOptions) || update.configOptions.some(option => isRecord(option) && option.id === 'auto_approve' && option.currentValue !== false)) {
          throw new Error('Cline changed native auto-approval permissions.');
        }
      },
      assertUnchanged: () => assertNoInheritedAuthority(context.cwd), cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}
