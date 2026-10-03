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
import {
  CANVAS_SURFACE_READ_NAMES,
  CANVAS_SURFACE_WRITE_NAMES,
} from '../canvas/CanvasToolSurface';

/**
 * Build a lookup table with a NULL prototype.
 *
 * Every table below is keyed by a model- or server-chosen tool name, and a
 * plain object literal answers `obj['constructor']` / `obj['__proto__']` with
 * an inherited `Object.prototype` member. That member is truthy, so
 * `TOOL_NAME_ALIASES[key] ?? bare` returned a *function* as the canonical tool
 * name and every consumer's `.toLowerCase()` threw — the sole permission
 * classifier failing OPEN-ish (by exception) on a name an untrusted MCP server
 * picks. `ACTION_TOOLS['constructor']` was likewise truthy and would have been
 * returned as a PermissionActionType. A null prototype makes a hostile key a
 * plain miss, so the fail-closed default applies to it like any other unknown.
 */
function nullProtoMap<V>(entries: Record<string, V>): Record<string, V> {
  return Object.assign(Object.create(null) as Record<string, V>, entries);
}

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
const TOOL_NAME_ALIASES: Record<string, string> = nullProtoMap<string>({
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
});

/**
 * Normalize a provider-native tool name to the canonical name used by the
 * permission classifier and the webview's tool renderer. Strips one
 * `mcp__<server>__` namespace segment (see {@link parseToolName}) and then
 * applies the alias map. Unknown names are returned unchanged (and will be
 * gated fail-closed by `classifyToolAction`).
 *
 * Callers that need the MCP provenance — which server a call came from — must
 * use {@link parseToolName} instead; this function deliberately returns only
 * the canonical identity.
 */
export function normalizeToolName(toolName: string): string {
  if (!toolName) {
    return toolName;
  }
  return parseToolName(toolName).name;
}

/**
 * MCP tool names arrive namespaced as `mcp__<server>__<tool>` (Claude Code and
 * every other backend that speaks MCP). The prefix is *transport provenance*,
 * not part of the tool's identity — but nothing stripped it, so EVERY MCP tool
 * call missed both lookup tables below and fell through to the fail-closed
 * `bash-command` default. That is correct for an unknown third-party tool and
 * wrong for our own in-process canvas server: `mcp__mysti-canvas__list_pages`
 * (a pure read of the user's own design) prompted as if it were a shell
 * command (Plan 20 §3.6, "Permission class").
 */
const MCP_TOOL_PREFIX = 'mcp__';
const MCP_SEGMENT_SEPARATOR = '__';

/**
 * A tool name split into its canonical identity and its MCP provenance.
 *
 * Provenance is deliberately PRESERVED rather than thrown away by the strip:
 * `classifyToolAction` scopes the lenient canvas action classes to the
 * in-process canvas server (so a third-party MCP server cannot claim them by
 * naming a tool `edit_page`), and the UI can still tell the user which server
 * a call came from.
 */
export interface ParsedToolName {
  /** The name exactly as the provider emitted it (never rewritten). */
  raw: string;
  /** Canonical name: one `mcp__<server>__` segment stripped, then aliased. */
  name: string;
  /** The `<server>` segment when `raw` was `mcp__<server>__<tool>`, else undefined. */
  mcpServer?: string;
}

/**
 * Split a provider-native tool name into `{raw, name, mcpServer}`.
 *
 * Exactly ONE `mcp__<server>__` segment is stripped and both segments must be
 * non-empty — `mcp__srv__` (no tool) and `mcp____tool` (no server) are left
 * verbatim so they keep fail-closing, and a nested `mcp__a__mcp__b__read`
 * yields the tool `mcp__b__read`, which is likewise unknown and fail-closed.
 * String scanning (no regex) so a hostile name cannot cost more than O(n).
 */
export function parseToolName(toolName: string): ParsedToolName {
  const raw = toolName || '';
  if (!raw) {
    return { raw, name: raw };
  }

  let bare = raw;
  let mcpServer: string | undefined;

  if (raw.length > MCP_TOOL_PREFIX.length
      && raw.slice(0, MCP_TOOL_PREFIX.length).toLowerCase() === MCP_TOOL_PREFIX) {
    const rest = raw.slice(MCP_TOOL_PREFIX.length);
    const sep = rest.indexOf(MCP_SEGMENT_SEPARATOR);
    const toolStart = sep + MCP_SEGMENT_SEPARATOR.length;
    if (sep > 0 && toolStart < rest.length) {
      mcpServer = rest.slice(0, sep);
      bare = rest.slice(toolStart);
    }
  }

  return {
    raw,
    name: TOOL_NAME_ALIASES[bare.toLowerCase()] ?? bare,
    mcpServer,
  };
}

/**
 * MCP server names that host Mysti's OWN in-process canvas tool surface
 * (`CanvasToolServer` / `CanvasSessionLinker`, both defaulting to
 * `mysti-canvas`). Only calls with this provenance — or with no MCP prefix at
 * all, i.e. the coordinator's in-process dispatch and the fenced CLI lane —
 * may claim the lenient `canvas-read` / `canvas-edit` classes.
 */
const CANVAS_MCP_SERVERS = new Set<string>(['mysti-canvas']);

/**
 * Canvas tools that CROSS a boundary — a paid generation API, a third-party
 * design payload, or a write outside `.mysti/canvas/`. They are canvas tools by
 * namespace only: they are explicitly EXCLUDED from the lenient classes and
 * keep their existing fail-closed treatment (Plan 20 §3.6 "Boundary tools",
 * which additionally requires `forceInteractive` at the call site).
 *
 * This set is checked FIRST, so adding a name to `CANVAS_EDIT_TOOLS` by mistake
 * cannot widen a boundary tool.
 */
export const CANVAS_BOUNDARY_TOOLS = new Set<string>([
  'generate_visual',
  'generate_video',
  'import_design',
  'export_artifact',
  // Drives a real browser + a vision model: network + process, not an artifact write.
  'render_page_preview',
]);

/**
 * Canvas tools that only READ the artifact. Never gated: reading a design the
 * user is looking at is not a privileged act, and gating it made the agent
 * unable to orient itself without a permission card per page.
 */
export const CANVAS_READ_TOOLS = new Set<string>([
  'list_pages',
  'read_page',
  'list_assets',
  'get_artifact_index',
  'page_coordinates',
  'validate_page',
  'list_scaffolds',
  'list_theme_presets',
  // Plan 20 §3.5/§3.6 element-level reads (Phase 2+; harmless until they exist).
  'get_page_jsx',
  'get_node',
  // Plan 22 §3.3 — the canonical surface, SPREAD from the one generator rather
  // than re-typed. `CanvasToolSurface` derives its catalog from the op algebra,
  // so a read tool added there is registered here for free instead of silently
  // falling through to the fail-closed default on the MCP/CLI transports.
  ...CANVAS_SURFACE_READ_NAMES,
]);

/**
 * Canvas tools that WRITE the artifact — and nothing else. Every one of these
 * goes through `CanvasOpExecutor.submit()`, which writes `.mysti/canvas/<id>/`
 * only, records an invertible op in the log, and touches no shell and no
 * network. They therefore get their own authority class instead of borrowing
 * `file-edit`/`file-delete`/`bash-command`, whose gating (and whose
 * `SafetyClassifier` verdicts) are calibrated for the user's source tree.
 */
export const CANVAS_EDIT_TOOLS = new Set<string>([
  'scaffold_page',
  'apply_theme_preset',
  'insert_page',
  'edit_page',
  'write_page_jsx',
  'delete_page',
  'reorder_pages',
  'set_theme',
  'set_format',
  'edit_element',
  'add_asset',
  // Plan 20 Phase 1 canvas-lifecycle/history tools (harmless until they exist).
  'open_canvas',
  'canvas_checkpoint',
  'undo_canvas',
  // Plan 22 §3.3 — same single source as the read set above. Boundary tools are
  // filtered out rather than trusted to the ordering in `classifyCanvasTool`:
  // `import_design` is a WRITE on the surface (it is a real capability) and a
  // BOUNDARY tool for permissions (it ingests a third-party payload), and the
  // two sets must stay disjoint whichever one is consulted first.
  ...CANVAS_SURFACE_WRITE_NAMES.filter(name => !CANVAS_BOUNDARY_TOOLS.has(name)),
]);

/**
 * Classify a canvas tool, or return undefined when the name is not a canvas
 * tool / the caller is not entitled to the canvas classes.
 *
 * Entitlement = the call carries NO MCP prefix (in-process coordinator dispatch
 * or the fenced CLI lane, both of which reach `CanvasToolDispatch` directly) or
 * carries the canvas server's own prefix. A tool named `delete_page` on some
 * other connected MCP server is NOT a canvas op and must not inherit its
 * leniency.
 */
export function classifyCanvasTool(parsed: ParsedToolName): PermissionActionType | undefined {
  const key = parsed.name.toLowerCase();
  if (CANVAS_BOUNDARY_TOOLS.has(key)) {
    return undefined;
  }
  if (parsed.mcpServer !== undefined && !CANVAS_MCP_SERVERS.has(parsed.mcpServer.toLowerCase())) {
    return undefined;
  }
  if (CANVAS_READ_TOOLS.has(key)) {
    return 'canvas-read';
  }
  if (CANVAS_EDIT_TOOLS.has(key)) {
    return 'canvas-edit';
  }
  return undefined;
}

/**
 * Tool-name → action-type classification map (keys lowercased; lookup is
 * case-insensitive so Cursor/OpenCode lowercase names classify identically
 * to Claude's capitalized canonical names).
 *
 * Consumed by `classifyToolAction` in `utils/permissionClassifier.ts`.
 */
export const ACTION_TOOLS: Record<string, PermissionActionType> = nullProtoMap<PermissionActionType>({
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
  // Delegation tools (Plan 15 Phase 0) — spawning/handing off to a sub-agent.
  // Gated like a write: a delegated agent can run arbitrary tools, and the
  // outer call is the only thing Mysti can gate (a native CLI sub-agent's inner
  // Write/Bash never surface separately).
  'task': 'delegate',
  'agent': 'delegate',
  'dispatch_agent': 'delegate',
});

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
  // NOTE (Plan 15 Phase 0): `task`/`agent`/`dispatch_agent` are NO LONGER here —
  // they are `delegate` (gated) in ACTION_TOOLS. Delegation spawns a sub-agent
  // that can run arbitrary tools, so it must not be auto-allowed. `toolsearch`/
  // `tool_search` (deferred tool-schema discovery, not agent-spawning) stay
  // read-only for now; revisit when Plan 12 deferred-tool loading lands.
  'toolsearch', 'tool_search',
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
const KIND_TOOLS: Record<string, ToolCallKind> = nullProtoMap<ToolCallKind>({
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
  // Canvas tools (Plan 20 §3.6). The renderer buckets them by what they do to
  // the design; the permission class they carry is decided by
  // `classifyCanvasTool` (which additionally checks MCP provenance).
  'list_pages': 'search',
  'list_assets': 'search',
  'list_scaffolds': 'search',
  'list_theme_presets': 'search',
  'read_page': 'read',
  'get_artifact_index': 'read',
  'get_page_jsx': 'read',
  'get_node': 'read',
  'page_coordinates': 'read',
  'validate_page': 'read',
  'scaffold_page': 'edit',
  'apply_theme_preset': 'edit',
  'insert_page': 'edit',
  'edit_page': 'edit',
  'write_page_jsx': 'edit',
  'reorder_pages': 'edit',
  'set_theme': 'edit',
  'set_format': 'edit',
  'edit_element': 'edit',
  'add_asset': 'edit',
  'open_canvas': 'edit',
  'canvas_checkpoint': 'edit',
  'undo_canvas': 'edit',
  'delete_page': 'delete',
  // Orchestration/UI tools
  'task': 'other',
  'agent': 'other',
  'dispatch_agent': 'other',
  'toolsearch': 'other',
  'tool_search': 'other',
  'askuserquestion': 'other',
  'ask_user': 'other',
  'ask_user_question': 'other',
  'ask_followup_question': 'other',
});

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
