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
 *
 * Native tool-calling foundation for the Mysti coordinator (Plan 19 Phase 4,
 * the deferred Plan 16 P1.4b). One op set, two encodings:
 *   - text directives (<read:>, <write:>, …) parsed by MystiTagScanner, and
 *   - OpenAI-style function `tools` for models that support tool-calling.
 * This module is the SHARED, pure core: the tool schemas, a conservative
 * capability check (unknown models fall back to the proven text protocol), and
 * a converter that maps a parsed tool_call back onto a `MystiDirective` so the
 * coordinator's EXISTING dispatch/gate/fence logic runs unchanged — a native
 * tool_call is never more trusted than a text directive.
 */

import type { MystiDirective } from '../utils/mystiDelegateParser';
import { CANVAS_TOOLS } from '../managers/CanvasToolDispatch';
import { CANVAS_FORMATS } from '../managers/CanvasFormats';
import type { CanvasArtifact } from '../types';

/** OpenAI-style function tool schema. */
export interface CoordinatorTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const str = (description: string) => ({ type: 'string', description });

/** Read-only + delegate tools — always available to the coordinator. */
const READ_TOOLS: CoordinatorTool[] = [
  { type: 'function', function: { name: 'read', description: 'Read a workspace file (line-numbered). Optional 1-based inclusive range.', parameters: { type: 'object', properties: { path: str('workspace-relative path'), start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'ls', description: 'List a workspace directory (one level).', parameters: { type: 'object', properties: { path: str('workspace-relative directory (empty = root)') }, required: [] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents across the repo by regex.', parameters: { type: 'object', properties: { pattern: str('regex'), include: str('optional path glob, e.g. src/**') }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'diag', description: 'Live compiler/linter diagnostics from the editor (or a single file path).', parameters: { type: 'object', properties: { target: str('"all" or a file path') }, required: [] } } },
  { type: 'function', function: { name: 'remember', description: 'Persist a durable project fact across sessions/backends. Use sparingly.', parameters: { type: 'object', properties: { fact: str('the fact') }, required: ['fact'] } } },
  { type: 'function', function: { name: 'delegate', description: 'Hand a self-contained task to a specialist coding backend.', parameters: { type: 'object', properties: { agent: str('backend id'), task: str('self-contained task text'), tier: { type: 'string', enum: ['fast', 'strong'] } }, required: ['agent', 'task'] } } },
];

/** Gated local execution tools — only when local execution is enabled. */
const EXEC_TOOLS: CoordinatorTool[] = [
  { type: 'function', function: { name: 'write', description: 'Create or overwrite a whole file (gated + checkpointed).', parameters: { type: 'object', properties: { path: str('workspace-relative path'), content: str('full file content') }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Targeted string replacement in an existing file (old_string must be unique unless replace_all).', parameters: { type: 'object', properties: { path: str('workspace-relative path'), old_string: str('exact existing text'), new_string: str('replacement'), replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'patch', description: 'Apply an atomic multi-file patch (Add/Update SEARCH-REPLACE/Delete/Move envelope).', parameters: { type: 'object', properties: { patch: str('the *** Add/Update/Delete/Move envelope') }, required: ['patch'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run ONE shell command in an OS sandbox (no network, writes limited to the workspace). No chaining.', parameters: { type: 'object', properties: { command: str('a single shell command') }, required: ['command'] } } },
];

/** A `connect` tool — offered when DeepMyst is wired (Plan 19 Phase 6). SAFE. */
const CONNECT_TOOL: CoordinatorTool = {
  type: 'function',
  function: {
    name: 'connect',
    description: 'Offer the user a one-click button to connect an external service (Gmail, Slack, Notion, a database, …) through DeepMyst — use when the task needs a service the user has NOT connected yet. Grants no access by itself; the user completes an OAuth flow.',
    parameters: { type: 'object', properties: { service: str('short lowercase service slug, e.g. gmail, slack, notion, postgres, github') }, required: ['service'] },
  },
};

/**
 * Visual observation tools. `look` is a READ — it renders the app and reports —
 * so it stays available in read-only and plan modes; `act` touches the page and
 * is gated separately.
 *
 * Note what these schemas do NOT expose: `url` and `devServerCommand`. The
 * address and the shell command come from the user's settings. A model that
 * cannot name a command is a model no confirmation dialog can be talked into
 * approving — which is strictly stronger than gating one it can name.
 */
const LOOK_TOOL: CoordinatorTool = {
  type: 'function',
  function: {
    name: 'look',
    description: 'Render the running app in a real browser and LOOK at it. Returns console errors, failed network requests, layout/overflow/contrast probes, the accessibility tree, a DOM outline, and a screenshot. Use it after any UI change, and before claiming a UI change works. The dev server and browser stay warm, so looking again is fast.',
    parameters: {
      type: 'object',
      properties: {
        path: str('page path relative to the app root, e.g. "/settings" (omit to stay on the current page)'),
        selector: str('CSS selector to focus the capture and the layout probes on'),
        mode: { type: 'string', enum: ['viewport', 'full-page', 'element'], description: 'capture mode (default viewport)' },
        wait_for: str('CSS selector to wait for before capturing'),
        reload: { type: 'boolean', description: 'reload before capturing (default true, so your edits are picked up)' },
        focus: str('one line: what you are checking'),
      },
      required: [],
    },
  },
};

const ACT_TOOL: CoordinatorTool = {
  type: 'function',
  function: {
    name: 'act',
    description: 'Interact with the page (click, type, scroll, hover, select, navigate), then look at the result. The user approves the batch. Maximum 8 actions.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          maxItems: 8,
          description: 'ordered list of actions to perform',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'type', 'navigate', 'scroll', 'hover', 'select'] },
              target: str('CSS selector (required for click/type/hover/select)'),
              value: str('text to type, app-relative path to navigate to, up|down|top|bottom to scroll, or the option value to select'),
            },
            required: ['action'],
          },
        },
        focus: str('one line: what you are checking'),
      },
      required: ['actions'],
    },
  },
};

/* ─────────────────────────── canvas (Plan 20 §3.3) ───────────────────────── */

/** Every canvas function is namespaced so it can never collide with a built-in. */
export const CANVAS_TOOL_PREFIX = 'canvas_';

/**
 * Canvas tools deliberately NOT offered as native function calls.
 *
 * `write_page` / `write_page_jsx` take a whole artboard as a JSON string
 * argument, and a native tool call cannot carry one: the coordinator generates
 * under a token cap, and BOTH length-continuation branches in
 * `_runMystiAgentic` are skipped on a tool-call turn — so a cut lands mid-JSON,
 * `parseToolArgsChecked` reports `truncated`, and the model burns its turn
 * budget re-truncating the same page. Whole artboards therefore ride the
 * `<canvaspage:NONCE>` TEXT directive, where the scanner is carried across a
 * length cut and reassembles the payload. Everything else in the surface is a
 * small structured op that fits comfortably.
 *
 * Derived from `CanvasToolSpec.nativeExcluded` rather than restated here, so
 * the dispatcher's own catalog decides — but the membership is asserted in
 * `tests/services/coordinatorTools.test.ts` so the exclusion cannot be lost by
 * an edit to the surface.
 *
 * Only the transport differs — a `<canvaspage:>` page lands on the same
 * `dispatchCanvasTool` write path with the same authority.
 */
export const CANVAS_NATIVE_EXCLUDED: ReadonlySet<string> =
  new Set(CANVAS_TOOLS.filter(t => t.nativeExcluded).map(t => t.name));

/** Artifact kinds, typed against the real union so a rename fails `tsc`. */
const CANVAS_ARTIFACT_KINDS: ReadonlyArray<CanvasArtifact['kind']> = ['deck', 'document', 'screens', 'board'];

/**
 * Canvas tools that exist ONLY on the coordinator lane — they are not in
 * `CANVAS_TOOLS`, so `dispatchCanvasTool` does not serve them and the
 * `{kind:'canvas'}` dispatch branch must handle them itself: opening a canvas
 * is session lifecycle, not an artifact-editing op. (`checkpoint` used to sit
 * here; Plan 22 Phase 4 moved it into the catalog, where it belongs — it is a
 * write the UI performs too.)
 *
 * `undo` used to sit here too, and nothing ever implemented it — see
 * {@link CANVAS_REFUSED_TOOLS}.
 */
export const CANVAS_SESSION_TOOL_NAMES = ['open'] as const;

/**
 * Canvas tool names the coordinator will NOT run, mapped to the sentence the
 * model is told instead.
 *
 * `undo` is here by design, not by omission (Plan 22 §3.5): undo/redo is ONE
 * SHARED stack — "a design tool must make Cmd+Z mean 'undo the last thing that
 * happened', whoever did it" — so an agent undo can silently revert the
 * HUMAN's last transaction. The plan's rule is verbatim: *"The agent is
 * deliberately given no undo tool — an agent that can revert the human's work
 * is a hazard; it corrects by editing forward."* It was nevertheless ADVERTISED
 * as a native schema whose description told the model to prefer it over a
 * corrective edit, so every canvas-bound run burned turns on a call that
 * answered "unknown canvas tool: undo".
 *
 * Refusing by name (rather than falling through to the generic "Unknown canvas
 * tool" error) is what stops the model re-spelling it and retrying.
 */
const CANVAS_REFUSED_TOOLS: ReadonlyMap<string, string> = new Map([
  ['undo', 'Canvas undo is the user\'s, not yours — Cmd+Z in the canvas, the history rail, and rejecting a staged suggestion all revert edits, and the stack is shared, so an agent undo could revert THEIR last change. Correct the design by editing forward instead (set_text / set_style / write_page_jsx), or call canvas_checkpoint first if you want a named restore point.'],
]);

/**
 * The refusal sentence for a canvas tool the coordinator declines to run, or
 * `undefined` when the tool is allowed. Accepts any spelling either lane may
 * produce (`undo`, `undo_canvas`, `canvas_undo`) — it normalizes first, so the
 * two lanes cannot disagree about what is refused.
 */
export function canvasToolRefusal(tool: string): string | undefined {
  return CANVAS_REFUSED_TOOLS.get(normalizeCanvasToolName(tool));
}

const CANVAS_OPEN_TOOL: CoordinatorTool = {
  type: 'function',
  function: {
    name: `${CANVAS_TOOL_PREFIX}open`,
    description: 'WRITE (opens the canvas): create a design canvas for this chat, or focus the one already open. Call this FIRST whenever the user asks for a design, mockup, screen, deck, poster or slide — every other canvas_* tool fails while no canvas is open. Safe to call when one already exists (it just focuses it).',
    parameters: {
      type: 'object',
      properties: {
        name: str('short canvas name, e.g. "Login flow"'),
        kind: { type: 'string', enum: [...CANVAS_ARTIFACT_KINDS], description: 'what is being designed (default screens)' },
        format: { type: 'string', enum: CANVAS_FORMATS.map(f => f.formatId), description: 'artboard format id (default follows the kind)' },
      },
      required: [],
    },
  },
};

/**
 * The canvas function schemas, DERIVED from `CANVAS_TOOLS` — the same catalog
 * `dispatchCanvasTool` switches on — plus the two coordinator-lane tools.
 * Deriving is the point: a tool added to (or renamed in) the dispatcher shows
 * up here automatically, so the model can never be taught a call the executor
 * rejects (the `scaffold_page`-in-the-prompt failure Phase 0 closed).
 *
 * Only the `primary` and `extra` tiers are offered: a superseded name stays
 * dispatchable (see `CANVAS_SCHEMA_BY_TOOL`) but teaching two vocabularies for
 * one write is how the surface drifted from the dispatcher in the first place.
 */
const asCoordinatorTool = (t: { name: string; description: string; inputSchema: Record<string, unknown> }): CoordinatorTool => ({
  type: 'function',
  function: {
    name: `${CANVAS_TOOL_PREFIX}${t.name}`,
    description: t.description,
    // Copied, not aliased — a caller mutating a schema must not be able to
    // rewrite the dispatcher's own contract object.
    parameters: { ...t.inputSchema },
  },
});

export const CANVAS_TOOL_SCHEMAS: readonly CoordinatorTool[] = [
  CANVAS_OPEN_TOOL,
  ...CANVAS_TOOLS
    .filter(t => t.tier !== 'compat' && !CANVAS_NATIVE_EXCLUDED.has(t.name))
    .map(asCoordinatorTool),
];

/**
 * Unprefixed canvas tool name → its parameter schema, for the NATIVE lane.
 *
 * Compat-tier names are included even though they are never offered: a model
 * that reaches for the previous vocabulary (from an older transcript, or from
 * its own priors) must land on the same dispatcher rather than get a refusal
 * it cannot act on. Native-excluded tools are deliberately absent — a native
 * call for a whole artboard is refused with a pointer to the text directive.
 */
const CANVAS_SCHEMA_BY_TOOL = new Map<string, Record<string, unknown>>([
  ...CANVAS_TOOL_SCHEMAS.map(t => [t.function.name.slice(CANVAS_TOOL_PREFIX.length), t.function.parameters] as const),
  ...CANVAS_TOOLS
    .filter(t => t.tier === 'compat' && !CANVAS_NATIVE_EXCLUDED.has(t.name))
    .map(t => [t.name, { ...t.inputSchema }] as const),
]);

/**
 * Every canvas tool name either lane may legitimately produce — the catalog
 * plus the two coordinator-lane session tools. Used for canonicalization, so
 * `<canvas:NONCE tool="write_page">` normalizes correctly even though
 * `canvas_write_page` is not a native function.
 */
const CANVAS_KNOWN_TOOLS: ReadonlySet<string> = new Set<string>([
  ...CANVAS_TOOLS.map(t => t.name),
  ...CANVAS_SESSION_TOOL_NAMES,
  // Refused names are KNOWN (so `canvas_undo` normalizes to `undo` and is
  // answered with its refusal) but are not offered and are not dispatchable.
  'undo',
]);

/**
 * Plan-prose spellings the model may reach for → the canonical dispatch name.
 * The two lanes must land on the SAME `{kind:'canvas', tool}` value, so the
 * text lane (`<canvas:NONCE tool="open_canvas">`) should run its parsed tool
 * name through {@link normalizeCanvasToolName} too.
 */
const CANVAS_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['open_canvas', 'open'],
  ['undo_canvas', 'undo'],
  ['checkpoint_canvas', 'checkpoint'],
]);

/**
 * Canonicalize a canvas tool name from either lane: trim, tolerate a stray
 * `canvas_` prefix (models copy the function name into the text directive),
 * then resolve prose aliases.
 */
export function normalizeCanvasToolName(tool: string): string {
  let t = (tool || '').trim();
  while (t.startsWith(CANVAS_TOOL_PREFIX) && !CANVAS_KNOWN_TOOLS.has(t)) {
    t = t.slice(CANVAS_TOOL_PREFIX.length);
  }
  return CANVAS_TOOL_ALIASES.get(t) ?? t;
}

/** Whether a (normalized) canvas tool name is one the coordinator can run on EITHER lane. */
export function isKnownCanvasTool(tool: string): boolean {
  return CANVAS_KNOWN_TOOLS.has(normalizeCanvasToolName(tool));
}

/** Required args the model omitted (empty/blank strings count as omitted). */
function missingRequiredArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) { return []; }
  return required.filter((k): k is string => typeof k === 'string').filter(k => {
    const v = args[k];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  });
}

/**
 * The `canvas` directive the text lane (`<canvas:NONCE tool="…">`) produces —
 * a native `canvas_*` call converts into exactly this, so neither encoding
 * carries more authority than the other.
 */
export type CanvasToolDirective = Extract<MystiDirective, { kind: 'canvas' }>;

/**
 * The tool schemas offered to a capable coordinator model.
 * @param mcpTools the user's CONNECTED external MCP tools (name + description),
 *   exposed as `mcp__<name>` functions so the model can call them natively.
 * @param connectEnabled whether to offer the `connect` tool (DeepMyst wired).
 * @param visual whether to offer `look` (render + observe) and `act` (interact).
 * @param canvasBound whether this run can reach a canvas — bound to an open
 *   artifact, OR merely able to open one. Canvas schemas are offered only then,
 *   so a coding-only run is not paying for ~20 irrelevant tools. Pass true from
 *   a cold chat that could design (`canvas_open` is the first schema in the
 *   list) — that is what turns "design me a login screen" into a canvas instead
 *   of prose. The text lane's `<canvas:NONCE>` / `<canvaspage:NONCE>` scanning
 *   is separate and stays on always, per Plan 20 §3.3 item 3.
 */
export function coordinatorToolSchemas(
  execEnabled: boolean,
  mcpTools: Array<{ name: string; description?: string }> = [],
  connectEnabled = false,
  visual: { look?: boolean; act?: boolean } = {},
  canvasBound = false,
): CoordinatorTool[] {
  const base = execEnabled ? [...READ_TOOLS, ...EXEC_TOOLS] : [...READ_TOOLS];
  if (connectEnabled) { base.push(CONNECT_TOOL); }
  if (visual.look) { base.push(LOOK_TOOL); }
  if (visual.look && visual.act) { base.push(ACT_TOOL); }
  if (canvasBound) { base.push(...CANVAS_TOOL_SCHEMAS); }
  // External MCP tools are namespaced `mcp__<name>` so they can never collide
  // with a built-in tool. No inputSchema is available from listTools(), so the
  // parameters are open (the model infers args from the description).
  for (const t of mcpTools) {
    base.push({
      type: 'function',
      function: {
        name: `mcp__${t.name}`,
        description: (t.description || t.name).slice(0, 1024),
        parameters: { type: 'object', additionalProperties: true, properties: {} },
      },
    });
  }
  return base;
}

/**
 * Conservative capability check. Returns true ONLY for models known to do
 * OpenAI-style function calling well; anything unknown falls back to the proven
 * text-directive protocol (a broken native path would break the coordinator).
 */
const TOOL_CAPABLE = /(gpt|claude|gemini|gemma|nemotron|qwen|mistral|command-r|codestral|deepseek|grok|kimi|llama-3\.[1-9]|llama-4|phi-[34]|mixtral)/i;
export function modelSupportsToolCalls(modelId: string | undefined): boolean {
  return !!modelId && TOOL_CAPABLE.test(modelId);
}

function asStr(v: unknown): string { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
function asIntOrU(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/**
 * Map a parsed native tool_call to a MystiDirective so the coordinator's
 * existing dispatch runs it (same gate/fence/budget). Returns {error} for an
 * unknown tool or missing required args — the caller feeds that back to the model.
 */
export function toolCallToDirective(name: string, args: Record<string, unknown>): MystiDirective | { error: string } {
  const a = args || {};
  switch (name) {
    case 'read': {
      const path = asStr(a.path).trim();
      if (!path) { return { error: 'read: "path" is required.' }; }
      return { kind: 'read', path, startLine: asIntOrU(a.start_line), endLine: asIntOrU(a.end_line) };
    }
    case 'ls':
      return { kind: 'ls', path: asStr(a.path).trim() || '.' };
    case 'grep': {
      const pattern = asStr(a.pattern);
      if (!pattern.trim()) { return { error: 'grep: "pattern" is required.' }; }
      const include = asStr(a.include).trim();
      return { kind: 'grep', pattern, include: include || undefined };
    }
    case 'diag':
      return { kind: 'diag', target: asStr(a.target).trim() || 'all' };
    case 'remember': {
      const fact = asStr(a.fact).trim();
      if (!fact) { return { error: 'remember: "fact" is required.' }; }
      return { kind: 'remember', fact };
    }
    case 'delegate': {
      const agent = asStr(a.agent).trim();
      const task = asStr(a.task).trim();
      if (!agent || !task) { return { error: 'delegate: "agent" and "task" are required.' }; }
      const tier = a.tier === 'fast' || a.tier === 'strong' ? a.tier : undefined;
      return { kind: 'delegate', agent, task, ...(tier ? { tier } : {}) };
    }
    case 'write': {
      const path = asStr(a.path).trim();
      if (!path) { return { error: 'write: "path" is required.' }; }
      if (a.content === undefined || a.content === null) { return { error: 'write: "content" is required (use "" for an empty file).' }; }
      return { kind: 'write', path, content: asStr(a.content) };
    }
    case 'edit': {
      const path = asStr(a.path).trim();
      const oldString = asStr(a.old_string);
      if (!path || !oldString) { return { error: 'edit: "path" and a non-empty "old_string" are required.' }; }
      return { kind: 'edit', path, oldString, newString: asStr(a.new_string), replaceAll: !!a.replace_all };
    }
    case 'patch': {
      const patchText = asStr(a.patch);
      if (!patchText.trim()) { return { error: 'patch: "patch" envelope is required.' }; }
      return { kind: 'patch', patchText };
    }
    case 'bash': {
      const command = asStr(a.command).trim();
      if (!command) { return { error: 'bash: "command" is required.' }; }
      return { kind: 'bash', command };
    }
    case 'connect': {
      const service = asStr(a.service).trim().toLowerCase();
      if (!service || !/^[a-z0-9][a-z0-9._-]*$/.test(service)) { return { error: 'connect: a valid lowercase "service" slug is required.' }; }
      return { kind: 'connect', service };
    }
    case 'look': {
      const rawMode = asStr(a.mode).trim().toLowerCase();
      const mode = rawMode === 'viewport' || rawMode === 'full-page' || rawMode === 'element'
        ? rawMode as 'viewport' | 'full-page' | 'element'
        : undefined;
      return {
        kind: 'look',
        path: asStr(a.path).trim() || undefined,
        selector: asStr(a.selector).trim() || undefined,
        mode,
        waitFor: asStr(a.wait_for).trim() || undefined,
        reload: a.reload === undefined ? undefined : !!a.reload,
        focus: asStr(a.focus).trim() || undefined,
      };
    }
    case 'act': {
      if (!Array.isArray(a.actions)) { return { error: 'act: "actions" must be an array of action objects.' }; }
      const actions = a.actions.filter(x => x && typeof x === 'object' && !Array.isArray(x)) as Array<Record<string, unknown>>;
      if (actions.length === 0) { return { error: 'act: "actions" contained no action objects.' }; }
      return { kind: 'act', actions, focus: asStr(a.focus).trim() || undefined };
    }
    default:
      // Canvas tools arrive namespaced `canvas_<tool>` (Plan 20 §3.3). They map
      // back to the SAME `{kind:'canvas'}` directive the `<canvas:NONCE>` text
      // directive produces, so a native call is never more trusted than a text
      // one — and, exactly like `write`/`bash` above, the authority check lives
      // in the dispatch branch, not here.
      if (name.startsWith(CANVAS_TOOL_PREFIX)) {
        const tool = normalizeCanvasToolName(name);
        if (!tool) { return { error: 'canvas tool: missing tool name.' }; }
        // Refused BEFORE the schema lookup so the model gets the reason rather
        // than "Unknown canvas tool", which it would answer by re-spelling.
        const refused = CANVAS_REFUSED_TOOLS.get(tool);
        if (refused) { return { error: refused }; }
        const schema = CANVAS_SCHEMA_BY_TOOL.get(tool);
        if (!schema) {
          // A whole artboard has no native encoding — say so, rather than
          // letting the model retry a call that can never fit.
          return CANVAS_NATIVE_EXCLUDED.has(tool)
            ? { error: `Unknown canvas tool "${tool}" on the native lane — a whole artboard rides the <canvaspage:…> text directive instead.` }
            : { error: `Unknown canvas tool "${tool}".` };
        }
        const missing = missingRequiredArgs(schema, a);
        if (missing.length) {
          return { error: `${name}: missing required argument(s): ${missing.map(m => `"${m}"`).join(', ')}.` };
        }
        const directive: CanvasToolDirective = { kind: 'canvas', tool, args: a };
        return directive;
      }
      // External MCP tools arrive namespaced `mcp__<name>` (Plan 19 Phase 6) —
      // map back to the gated mcptool directive so the SAME dispatch runs them.
      if (name.startsWith('mcp__')) {
        const tool = name.slice(5).trim();
        if (!tool) { return { error: 'mcp tool: missing tool name.' }; }
        return { kind: 'mcptool', tool, args: (a && typeof a === 'object' ? a : {}) as Record<string, unknown> };
      }
      return { error: `Unknown tool "${name}".` };
  }
}
