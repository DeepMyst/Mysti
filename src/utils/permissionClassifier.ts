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
import { ACTION_TOOLS, READ_ONLY_TOOLS, classifyCanvasTool, parseToolName } from './toolNames';
import { resolveCanvasApproval } from '../canvas/resolveCanvasApproval';

// The tool-name vocabulary (alias maps, action map, read-only allowlist,
// semantic kinds) lives in utils/toolNames.ts — the single tool-name/kind
// authority shared by this permission gate and the webview renderer.
// normalizeToolName is re-exported here so existing consumers keep working;
// parseToolName is exported alongside it for callers that need the MCP
// provenance (which server a namespaced call came from) and not just the
// canonical name.
export { normalizeToolName, parseToolName } from './toolNames';
export type { ParsedToolName } from './toolNames';

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
  // Normalize FIRST: MCP backends namespace every tool as `mcp__<server>__<tool>`,
  // which matched neither table and so fell through to the fail-closed default —
  // `mcp__mysti-canvas__list_pages` (a pure artifact read) classified as
  // `bash-command` (Plan 20 §3.6). The parse keeps the server segment so the
  // canvas classes below can be scoped to canvas provenance.
  const parsed = parseToolName(toolName);
  const key = parsed.name.toLowerCase();

  // Plan 20 §3.6: canvas ops get their own authority class. Checked before the
  // generic tables so `delete_page`/`edit_page` are not mistaken for source-tree
  // writes — and scoped by provenance + a boundary denylist inside
  // `classifyCanvasTool`, so `generate_visual` and a look-alike tool on a
  // third-party MCP server both stay out of the lenient classes.
  const canvasAction = classifyCanvasTool(parsed);
  if (canvasAction) {
    return canvasAction;
  }

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
  if (isNeverGatedAction(actionType)) {
    return false;
  }

  // Plan 20 §3.6: a canvas edit NEVER raises a blocking modal. Its approval
  // surface, when settings call for one, is the in-canvas accept/reject card
  // produced by staged mode — see `permissionSurfaceForTool` /
  // `resolveCanvasApproval`. Returning true here would both block the stream on
  // a modal the plan explicitly rules out AND double-approve an op the executor
  // has already staged.
  if (actionType === 'canvas-edit') {
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
      || actionType === 'web-request'
      // Plan 15 Phase 0: delegation is not an "edit" — it must still be gated in
      // the accept-edits tier (only explicit full-access/autonomous bypasses it).
      || actionType === 'delegate';
  }

  // "Default"/legacy — gate when access is ask-permission and mode doesn't bypass.
  if (settings.accessLevel === 'ask-permission' && settings.mode !== 'edit-automatically') {
    return true;
  }

  // "Full access" + edit-automatically, plan modes, read-only → not gated here
  // (read-only/plan are enforced by the provider's CLI permission mode).
  return false;
}

/**
 * Action types that are NEVER gated, on any transport, under any settings:
 * reading a file, and reading the canvas (Plan 20 §3.6 — reading a design the
 * user is already looking at is not a privileged act).
 *
 * Exported because the gate is re-implemented in a couple of places that must
 * not drift from it (notably the autonomous branch of
 * `ChatViewProvider._shouldGateToolUse`, which previously compared against the
 * literal `'file-read'` and so would have gated every canvas read).
 */
export function isNeverGatedAction(actionType: PermissionActionType): boolean {
  return actionType === 'file-read' || actionType === 'canvas-read';
}

/** True for the two canvas-authority action types (Plan 20 §3.6). */
export function isCanvasAction(actionType: PermissionActionType): boolean {
  return actionType === 'canvas-read' || actionType === 'canvas-edit';
}

/**
 * Where a tool call's approval must be shown, if anywhere.
 *
 * - `'none'`        — no approval needed; run it.
 * - `'modal'`       — the existing blocking permission card
 *                     (`requestPermissionInline`).
 * - `'canvas-card'` — an in-canvas accept/reject on the staged op. NEVER a
 *                     modal: the op is staged by `CanvasOpExecutor`, the
 *                     artifact is untouched until the user accepts, and the run
 *                     continues meanwhile.
 *
 * One call answers both "is approval required?" and "on which surface?", so a
 * caller cannot accidentally render a canvas approval as a stream-blocking
 * modal (or vice-versa).
 */
export type PermissionSurface = 'none' | 'modal' | 'canvas-card';

export function permissionSurfaceForTool(settings: Settings, toolName: string): PermissionSurface {
  const actionType = classifyToolAction(toolName);
  if (actionType === 'canvas-read') {
    return 'none';
  }
  if (actionType === 'canvas-edit') {
    return resolveCanvasApproval(settings) === 'staged' ? 'canvas-card' : 'none';
  }
  return shouldGateToolUse(settings, toolName) ? 'modal' : 'none';
}
