/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as path from 'path';
import { isRecord } from '../../utils/valueGuards';
import type { ToolCall } from '../../types';
import { VERIFIED_NATIVE_CLI_VERSIONS, getAcceptedNativeCliVersions } from '../base/NativeCliVersions';

export const QWEN_ACP_VERSION = VERIFIED_NATIVE_CLI_VERSIONS['qwen-code'];
export const QWEN_ACP_VERSIONS = getAcceptedNativeCliVersions('qwen-code');
export const QWEN_ACP_TOOLS = ['read_file', 'edit', 'notebook_edit', 'run_shell_command'] as const;

// Verified 0.23.0/0.24.4 registries. --core-tools does not restrict synthetic tools, so
// those must be excluded separately, before registration and execution.
export const QWEN_ACP_EXCLUDED_TOOLS = [
  'agent', 'skill', 'exit_plan_mode', 'enter_plan_mode',
  'image_gen', 'ask_user_question', 'list_agents',
  'task_stop', 'task_create', 'task_update', 'task_list', 'team_create', 'team_delete',
  'team_plan_approval', 'request_shutdown', 'send_message', 'structured_output',
  'tool_search', 'enter_worktree', 'exit_worktree',
  'workflow', 'artifact', 'record_artifact', 'report_findings', 'get_goal',
  'update_goal', 'propose_goal', 'display_image',
  // Added by 0.24.x and outside --core-tools. `tool_call` dispatches another
  // registered tool by name; `exec` runs code-mode JavaScript that can call
  // bound tools; `omni_*` register when QWEN_CODE_ENABLE_OMNI or `omni` is on.
  // Unknown deny names are inert on 0.23.0, so one list serves both releases.
  'tool_call', 'exec', 'record_source',
  'omni_downsample_image', 'omni_downscale_video', 'omni_downsample_audio', 'omni_extract_keyframes',
  'omni_extract_audio', 'omni_clip_video', 'omni_convert_image', 'omni_transcribe_audio', 'omni_clip_image',
  'omni_clip_audio', 'omni_caption_image', 'omni_caption_audio', 'omni_ocr_image',
  'omni_understand_video_segments', 'omni_recall_media_memory',
] as const;

/** Decode the actual can-execute request, never a display-only kind or title. */
export function decodeQwenPermission(params: Readonly<Record<string, unknown>>, cwd: string): ToolCall | undefined {
  const tool = params.toolCall;
  if (!isRecord(tool) || typeof tool.toolCallId !== 'string' || !tool.toolCallId || tool.status !== 'pending'
    || !isRecord(tool._meta) || !isRecord(tool.rawInput)) { return undefined; }
  const nativeName = tool._meta.toolName;
  const input = tool.rawInput;
  const keys = Object.keys(input);
  let name: string;
  let kind: ToolCall['kind'];
  let completeInput: Record<string, unknown> = input;
  switch (nativeName) {
    case 'run_shell_command':
      if (tool.kind !== 'execute' || typeof input.command !== 'string' || !input.command.trim()
        || (input.is_background !== undefined && input.is_background !== false)
        || (input.directory !== undefined && typeof input.directory !== 'string')
        || keys.some(key => !['command', 'directory', 'description', 'timeout', 'is_background'].includes(key))) { return undefined; }
      name = 'Bash'; kind = 'execute';
      completeInput = { ...input, directory: path.resolve(cwd, typeof input.directory === 'string' ? input.directory : '.') };
      break;
    case 'edit':
      if (tool.kind !== 'edit' || typeof input.file_path !== 'string' || !path.isAbsolute(input.file_path)
        || typeof input.old_string !== 'string' || typeof input.new_string !== 'string'
        || keys.some(key => !['file_path', 'old_string', 'new_string', 'replace_all'].includes(key))) { return undefined; }
      name = 'Edit'; kind = 'edit';
      break;
    case 'notebook_edit':
      if (tool.kind !== 'edit' || typeof input.notebook_path !== 'string' || !path.isAbsolute(input.notebook_path)
        || typeof input.new_source !== 'string') { return undefined; }
      name = 'NotebookEdit'; kind = 'edit';
      break;
    case 'read_file':
      if (tool.kind !== 'read' || typeof input.file_path !== 'string' || !path.isAbsolute(input.file_path)) { return undefined; }
      name = 'Read'; kind = 'read';
      break;
    default: return undefined;
  }
  if (kind === 'edit') {
    const diffs = Array.isArray(tool.content) ? tool.content.filter(isRecord).filter(item => item.type === 'diff') : [];
    const target = input.file_path ?? input.notebook_path;
    if (diffs.length !== 1 || diffs[0].path !== target || typeof diffs[0].newText !== 'string'
      || (diffs[0].oldText !== null && diffs[0].oldText !== undefined && typeof diffs[0].oldText !== 'string')) { return undefined; }
    // The native edit tool may normalize replacement text. The confirmation's
    // actual proposed file contents accompany the raw model arguments.
    completeInput = { ...input, changes: diffs };
  }
  return { id: tool.toolCallId, name, kind, input: completeInput, status: 'running' };
}
