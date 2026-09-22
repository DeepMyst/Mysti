/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as path from 'path';
import { isRecord } from '../../utils/valueGuards';
import type { ToolCall, UsageStats } from '../../types';
import { VERIFIED_NATIVE_CLI_VERSIONS, getAcceptedNativeCliVersions } from '../base/NativeCliVersions';

export const GEMINI_ACP_VERSION = VERIFIED_NATIVE_CLI_VERSIONS['google-gemini'];
export const GEMINI_ACP_VERSIONS = getAcceptedNativeCliVersions('google-gemini');
/** The only accepted release that applies a user-owned system settings file. */
export const GEMINI_SETTINGS_FILE_VERSION = '0.58.0';

/** Final prompt totals; per-model quota entries are already included in these. */
export function decodeGeminiUsage(result: Readonly<Record<string, unknown>>): UsageStats | undefined {
  if (!isRecord(result._meta) || !isRecord(result._meta.quota) || !isRecord(result._meta.quota.token_count)) { return; }
  const usage = result._meta.quota.token_count;
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)
    || Number(usage.input_tokens) < 0 || Number(usage.output_tokens) < 0) { return; }
  return { input_tokens: Number(usage.input_tokens), output_tokens: Number(usage.output_tokens) };
}

/**
 * 0.58.0 and 0.60.0 omit rawInput/tool name. The bundled admin policy therefore admits
 * only read_file/write_file/replace. Edits carry authoritative full-file diffs;
 * read_file carries its native toolLocations. Shell/delegation are denied by
 * native policy before dispatch, not reconstructed from a display title.
 */
export function decodeGeminiPermission(params: Readonly<Record<string, unknown>>): ToolCall | undefined {
  const tool = params.toolCall;
  if (!isRecord(tool) || typeof tool.toolCallId !== 'string' || !tool.toolCallId || tool.status !== 'pending') { return undefined; }
  if (tool.kind === 'edit') {
    const content = Array.isArray(tool.content) ? tool.content : [];
    const diff = content.length === 1 && isRecord(content[0]) ? content[0] : undefined;
    if (!diff || diff.type !== 'diff' || typeof diff.path !== 'string' || !path.isAbsolute(diff.path)
      || typeof diff.newText !== 'string'
      || (diff.oldText !== null && diff.oldText !== undefined && typeof diff.oldText !== 'string')) { return undefined; }
    return { id: tool.toolCallId, name: 'Edit', kind: 'edit', status: 'running',
      input: { file_path: diff.path, old_text: diff.oldText ?? '', new_text: diff.newText, changes: [diff] } };
  }
  if (tool.kind === 'read') {
    const locations = Array.isArray(tool.locations) ? tool.locations : [];
    const location = locations.length === 1 && isRecord(locations[0]) ? locations[0] : undefined;
    if (!location || typeof location.path !== 'string' || !path.isAbsolute(location.path)) { return undefined; }
    return { id: tool.toolCallId, name: 'Read', kind: 'read', status: 'running', input: { file_path: location.path, locations } };
  }
  return undefined;
}
