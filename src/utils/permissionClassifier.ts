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
 * Tool-name → action-type classification map.
 * Only explicitly known write/destructive tools are listed.
 * Unknown tools default to 'file-read' (safe, no gate) to avoid
 * blocking non-destructive tools like Agent, TodoRead, ToolSearch, etc.
 */
const WRITE_TOOLS: Record<string, PermissionActionType> = {
  // File edit tools
  'Edit': 'file-edit',
  'edit_file': 'file-edit',
  'replace_in_file': 'file-edit',
  'insert_code_block': 'file-edit',
  'rename_file': 'file-edit',
  'apply_diff': 'file-edit',
  'apply_patch': 'file-edit',
  'NotebookEdit': 'file-edit',
  // File create tools
  'Write': 'file-create',
  'write_to_file': 'file-create',
  'create_file': 'file-create',
  // File delete tools
  'delete_file': 'file-delete',
  'remove_file': 'file-delete',
  // Multi-file edit tools
  'MultiEdit': 'multi-file-edit',
  'multi_edit': 'multi-file-edit',
  // Bash/command tools
  'Bash': 'bash-command',
  'bash': 'bash-command',
  'shell': 'bash-command',
  'execute_command': 'bash-command',
  'run_terminal_command': 'bash-command',
};

/**
 * Classify a tool name into a PermissionActionType.
 */
export function classifyToolAction(toolName: string): PermissionActionType {
  return WRITE_TOOLS[toolName] || 'file-read';
}

/**
 * Determine if a tool_use should be gated with a permission card.
 * Returns true when mode/access settings require user approval for write operations.
 * All providers bypass CLI-level permissions (piped stdin can't prompt interactively).
 * This stream-level gate is the sole enforcement point.
 */
export function shouldGateToolUse(settings: Settings, toolName: string): boolean {
  // Never gate read operations
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
