/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single tool-name/kind authority (Plan 02 Phase 3, coordinated with Plan 00
 * Batch 1.1 B1/B6 tool-name normalization).
 *
 * This module owns:
 * - the per-provider native-name → canonical-name alias map (`normalizeToolName`)
 * - the canonical-name → PermissionActionType map consumed by the permission
 *   gate (`utils/permissionClassifier.ts`)
 * - the canonical-name → semantic `ToolCallKind` map consumed by the webview
 *   renderer (`toolKind`)
 *
 * Both the stream-level permission gate and the renderer key off the SAME
 * vocabulary, so a new tool name only ever needs to be added here.
 */

import type { PermissionActionType, ToolCallKind } from '../types';

/**
 * Canonical tool-name aliases: maps provider-native tool names (lowercased)
 * to the canonical names used by the classifier and the webview renderer.
 *
 * Every CLI provider bypasses its own interactive permissions (piped stdin
 * cannot prompt), so the stream-level gate keyed on these names is the SOLE
 * enforcement point. Providers should call `normalizeToolName()` at the
 * tool_use emission point in `parseStreamLine` so the gate and the webview
 * see one canonical vocabulary regardless of backend:
 * - Gemini / Qwen (gemini-cli fork): write_file, replace, run_shell_command, ...
 * - Cursor: lowercase write/edit/delete/... (via its ToolCall-key map)
 * - OpenCode: lowercase bash/edit/write/patch/...
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  // Read tools
  'read': 'Read',
  'read_file': 'Read',
  'readfile': 'Read',
  'read_many_files': 'Read',
  // Create/write tools
  'write': 'Write',
  'write_file': 'Write',
  'writefile': 'Write',
  // Edit tools
  'edit': 'Edit',
  'replace': 'Edit',
  'patch': 'Edit',
  // Shell tools
  'bash': 'Bash',
  'shell': 'Bash',
  'run_shell_command': 'Bash',
  // Search/listing tools
  'grep': 'Grep',
  'search_file_content': 'Grep',
  'glob': 'Glob',
  'ls': 'LS',
  'list': 'LS',
  'list_directory': 'LS',
  // Delete tools
  'delete': 'Delete',
  // Web tools
  'webfetch': 'WebFetch',
  'web_fetch': 'WebFetch',
  'fetch': 'WebFetch',
  'websearch': 'WebSearch',
  'web_search': 'WebSearch',
  'google_web_search': 'WebSearch',
  'search_web': 'WebSearch',
};

/**
 * Normalize a provider-native tool name to the canonical name used by the
 * permission classifier and the webview's tool renderer. Unknown names are
 * returned unchanged (and will be gated fail-closed by `classifyToolAction`).
 */
export function normalizeToolName(toolName: string): string {
  if (!toolName) {
    return toolName;
  }
  return TOOL_NAME_ALIASES[toolName.toLowerCase()] ?? toolName;
}

/**
 * Tool-name → action-type classification map (keys lowercased; lookup is
 * case-insensitive so Cursor/OpenCode lowercase names classify identically
 * to Claude's capitalized canonical names).
 *
 * Consumed by `classifyToolAction` in `utils/permissionClassifier.ts`.
 */
export const ACTION_TOOLS: Record<string, PermissionActionType> = {
  // File edit tools
  'edit': 'file-edit',
  'edit_file': 'file-edit',
  'replace': 'file-edit',
  'replace_in_file': 'file-edit',
  'insert_code_block': 'file-edit',
  'rename_file': 'file-edit',
  'apply_diff': 'file-edit',
  'apply_patch': 'file-edit',
  'patch': 'file-edit',
  'notebookedit': 'file-edit',
  // File create tools
  'write': 'file-create',
  'write_file': 'file-create',
  'write_to_file': 'file-create',
  'create_file': 'file-create',
  // File delete tools
  'delete': 'file-delete',
  'delete_file': 'file-delete',
  'remove_file': 'file-delete',
  // Multi-file edit tools
  'multiedit': 'multi-file-edit',
  'multi_edit': 'multi-file-edit',
  // Bash/command tools
  'bash': 'bash-command',
  'shell': 'bash-command',
  'execute_command': 'bash-command',
  'run_terminal_command': 'bash-command',
  'run_shell_command': 'bash-command',
  // Web tools
  'webfetch': 'web-request',
  'web_fetch': 'web-request',
  'fetch': 'web-request',
  'websearch': 'web-request',
  'web_search': 'web-request',
  'google_web_search': 'web-request',
  'search_web': 'web-request',
};

/**
 * Explicit read-only allowlist (lowercased). These are the ONLY tools that
 * are auto-allowed without a permission card when mode/access settings
 * require approval. Anything not listed here and not in ACTION_TOOLS is
 * gated fail-closed by `classifyToolAction`.
 */
export const READ_ONLY_TOOLS = new Set<string>([
  // Read tools
  'read', 'read_file', 'readfile', 'read_files', 'read_many_files',
  'cat', 'view', 'view_file', 'open_file',
  'notebookread', 'notebook_read',
  // Search tools
  'grep', 'search', 'search_files', 'search_file_content',
  'codebase_search', 'find_files',
  // Listing tools
  'glob', 'ls', 'list', 'list_directory', 'list_dir', 'list_files',
  'directory_tree',
  // Orchestration/UI tools with no direct file or system side effects.
  // Sub-agent tool calls (Task/Agent) stream through the same gate and are
  // classified individually; Todo tools only manage the in-chat task list.
  'task', 'agent', 'toolsearch', 'tool_search',
  'todoread', 'todo_read', 'todowrite', 'todo_write',
  'askuserquestion', 'ask_user', 'ask_user_question', 'ask_followup_question',
  'exitplanmode', 'exit_plan_mode', 'bashoutput',
]);

/**
 * Tool-name → semantic ToolCallKind map (keys lowercased; lookup is
 * case-insensitive). The buckets mirror `classifyToolAction`'s action types
 * so the renderer icon and the permission card risk label never disagree:
 *
 *   file-read (read tools)            → 'read'
 *   file-read (search/listing tools)  → 'search'
 *   file-edit / file-create / multi   → 'edit'
 *   file-delete                       → 'delete'
 *   bash-command                      → 'execute'
 *   web-request                       → 'fetch'
 *   plan/todo bookkeeping             → 'think'
 *   orchestration/UI + unknown        → 'other'
 */
const KIND_TOOLS: Record<string, ToolCallKind> = {
  // Read tools
  'read': 'read',
  'read_file': 'read',
  'readfile': 'read',
  'read_files': 'read',
  'read_many_files': 'read',
  'cat': 'read',
  'view': 'read',
  'view_file': 'read',
  'open_file': 'read',
  'notebookread': 'read',
  'notebook_read': 'read',
  'bashoutput': 'read',
  // Search/listing tools
  'grep': 'search',
  'search': 'search',
  'search_files': 'search',
  'search_file_content': 'search',
  'codebase_search': 'search',
  'find_files': 'search',
  'glob': 'search',
  'ls': 'search',
  'list': 'search',
  'list_directory': 'search',
  'list_dir': 'search',
  'list_files': 'search',
  'directory_tree': 'search',
  // Edit/create tools
  'edit': 'edit',
  'edit_file': 'edit',
  'replace': 'edit',
  'replace_in_file': 'edit',
  'insert_code_block': 'edit',
  'apply_diff': 'edit',
  'apply_patch': 'edit',
  'patch': 'edit',
  'notebookedit': 'edit',
  'notebook_edit': 'edit',
  'multiedit': 'edit',
  'multi_edit': 'edit',
  'write': 'edit',
  'write_file': 'edit',
  'writefile': 'edit',
  'write_to_file': 'edit',
  'create_file': 'edit',
  // Move/rename tools
  'rename_file': 'move',
  // Delete tools
  'delete': 'delete',
  'delete_file': 'delete',
  'remove_file': 'delete',
  // Shell/command tools
  'bash': 'execute',
  'shell': 'execute',
  'execute_command': 'execute',
  'run_terminal_command': 'execute',
  'run_shell_command': 'execute',
  // Web tools
  'webfetch': 'fetch',
  'web_fetch': 'fetch',
  'fetch': 'fetch',
  'websearch': 'fetch',
  'web_search': 'fetch',
  'google_web_search': 'fetch',
  'search_web': 'fetch',
  // Plan/todo bookkeeping tools
  'todoread': 'think',
  'todo_read': 'think',
  'todowrite': 'think',
  'todo_write': 'think',
  'exitplanmode': 'think',
  'exit_plan_mode': 'think',
  // Orchestration/UI tools
  'task': 'other',
  'agent': 'other',
  'toolsearch': 'other',
  'tool_search': 'other',
  'askuserquestion': 'other',
  'ask_user': 'other',
  'ask_user_question': 'other',
  'ask_followup_question': 'other',
};

/**
 * Derive the semantic `ToolCall.kind` for a tool name. Accepts either a
 * provider-native or canonical name (normalizes first, lookup is
 * case-insensitive). Unknown names fall through heuristic buckets that
 * mirror `classifyToolAction`'s regexes; anything unrecognized is 'other'
 * (the renderer's generic card — NOT a safety decision; the permission gate
 * still fail-closes unknown names independently).
 */
export function toolKind(toolName: string): ToolCallKind {
  if (!toolName) {
    return 'other';
  }
  const key = normalizeToolName(toolName).toLowerCase();

  const known = KIND_TOOLS[key];
  if (known) {
    return known;
  }

  // Heuristic bucketing for unrecognized names — keep in sync with the
  // heuristics in classifyToolAction (utils/permissionClassifier.ts).
  if (/delete|remove/.test(key)) {
    return 'delete';
  }
  if (/write|create/.test(key)) {
    return 'edit';
  }
  if (/edit|patch|replace|apply/.test(key)) {
    return 'edit';
  }
  if (/bash|shell|exec|command|terminal/.test(key)) {
    return 'execute';
  }
  if (/web|fetch|http|url|browser|download/.test(key)) {
    return 'fetch';
  }
  if (/search|grep|glob|find/.test(key)) {
    return 'search';
  }
  if (/read|view|cat|list/.test(key)) {
    return 'read';
  }

  return 'other';
}
