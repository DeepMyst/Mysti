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
import { ACTION_TOOLS, READ_ONLY_TOOLS } from './toolNames';

// The tool-name vocabulary (alias maps, action map, read-only allowlist,
// semantic kinds) lives in utils/toolNames.ts — the single tool-name/kind
// authority shared by this permission gate and the webview renderer.
// normalizeToolName is re-exported here so existing consumers keep working.
export { normalizeToolName } from './toolNames';

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

  // "Ask" — gate every change (edits AND commands).
  if (settings.mode === 'ask-before-edit') {
    return true;
  }

  // "Auto-edit" (edit-automatically + ask-permission): file edits/creates
  // auto-apply, but commands, deletes, and network requests still ask — the
  // Claude-Code "accept edits" tier. Without this branch, edit-automatically
  // would auto-run everything (which is the "Full access" tier instead).
  if (settings.mode === 'edit-automatically' && settings.accessLevel === 'ask-permission') {
    return actionType === 'bash-command'
      || actionType === 'file-delete'
      || actionType === 'web-request';
  }

  // "Default"/legacy — gate when access is ask-permission and mode doesn't bypass.
  if (settings.accessLevel === 'ask-permission' && settings.mode !== 'edit-automatically') {
    return true;
  }

  // "Full access" + edit-automatically, plan modes, read-only → not gated here
  // (read-only/plan are enforced by the provider's CLI permission mode).
  return false;
}
