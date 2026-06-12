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

import type { PermissionActionType, Settings } from '../types';

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
 */
const ACTION_TOOLS: Record<string, PermissionActionType> = {
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
 * gated fail-closed.
 */
const READ_ONLY_TOOLS = new Set<string>([
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
 * Classify a tool name into a PermissionActionType.
 *
 * FAIL-CLOSED: unknown tool names classify as 'bash-command' (high risk) so
 * the stream gate prompts for them whenever mode/access requires approval.
 * Every CLI provider runs with its native permissions bypassed (--yolo,
 * --allow-all-tools, --approval-mode auto-edit, --force), so a fail-open
 * default here would let unrecognized write/shell tools execute silently.
 */
export function classifyToolAction(toolName: string): PermissionActionType {
  const key = (toolName || '').toLowerCase();

  const known = ACTION_TOOLS[key];
  if (known) {
    return known;
  }

  if (READ_ONLY_TOOLS.has(key)) {
    return 'file-read';
  }

  // Heuristic bucketing for unrecognized names so the permission card shows
  // a sensible action/risk label.
  if (/delete|remove/.test(key)) {
    return 'file-delete';
  }
  if (/write|create/.test(key)) {
    return 'file-create';
  }
  if (/edit|patch|replace|apply/.test(key)) {
    return 'file-edit';
  }
  if (/bash|shell|exec|command|terminal/.test(key)) {
    return 'bash-command';
  }
  if (/web|fetch|http|url|browser|download/.test(key)) {
    return 'web-request';
  }

  // Unknown tool: fail closed — treat as command-level risk so the gate fires.
  return 'bash-command';
}

/**
 * Determine if a tool_use should be gated with a permission card.
 * Returns true when mode/access settings require user approval for write operations.
 * All providers bypass CLI-level permissions (piped stdin can't prompt interactively).
 * This stream-level gate is the sole enforcement point.
 *
 * Only tools on the explicit read-only allowlist skip the gate; unknown tools
 * are gated (fail-closed) whenever the mode/access combination requires approval.
 */
export function shouldGateToolUse(settings: Settings, toolName: string): boolean {
  // Never gate read-only operations (explicit allowlist)
  const actionType = classifyToolAction(toolName);
  if (actionType === 'file-read') {
    return false;
  }

  // Gate when mode is ask-before-edit (regardless of access level)
  if (settings.mode === 'ask-before-edit') {
    return true;
  }

  // Gate when access is ask-permission and mode doesn't bypass
  if (settings.accessLevel === 'ask-permission' && settings.mode !== 'edit-automatically') {
    return true;
  }

  // Don't gate for edit-automatically + full-access, plan modes, read-only, etc.
  return false;
}
