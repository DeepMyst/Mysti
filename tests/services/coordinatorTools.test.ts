/**
 * Native tool-calling foundation (Plan 19 Phase 4) — the tool schemas, the
 * conservative capability check, and the tool_call→MystiDirective converter that
 * lets a native tool_call reuse the coordinator's existing (gated) dispatch.
 */
import { describe, it, expect } from 'vitest';
import {
  coordinatorToolSchemas,
  modelSupportsToolCalls,
  toolCallToDirective,
  normalizeCanvasToolName,
  isKnownCanvasTool,
  CANVAS_TOOL_PREFIX,
  CANVAS_SESSION_TOOL_NAMES,
  CANVAS_NATIVE_EXCLUDED,
} from '../../src/services/coordinatorTools';
import { CANVAS_TOOLS, getCanvasTool } from '../../src/managers/CanvasToolDispatch';

describe('coordinatorToolSchemas', () => {
  it('offers read-only tools always; exec tools only when enabled', () => {
    const ro = coordinatorToolSchemas(false).map(t => t.function.name);
    expect(ro).toEqual(['read', 'ls', 'grep', 'diag', 'remember', 'delegate']);
    const full = coordinatorToolSchemas(true).map(t => t.function.name);
    expect(full).toContain('write');
    expect(full).toContain('bash');
    expect(full).toContain('patch');
    // Every schema is a well-formed function tool.
    for (const t of coordinatorToolSchemas(true)) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(t.function.parameters).toHaveProperty('type', 'object');
    }
  });
  it('offers connect only when enabled, and exposes MCP tools as mcp__ functions (Phase 6)', () => {
    const none = coordinatorToolSchemas(false).map(t => t.function.name);
    expect(none).not.toContain('connect');
    const withConnect = coordinatorToolSchemas(false, [], true).map(t => t.function.name);
    expect(withConnect).toContain('connect');
    const withMcp = coordinatorToolSchemas(false, [{ name: 'GMAIL_SEND', description: 'Send mail' }, { name: 'TRELLO_CREATE' }], true).map(t => t.function.name);
    expect(withMcp).toContain('mcp__GMAIL_SEND');
    expect(withMcp).toContain('mcp__TRELLO_CREATE');
    expect(withMcp).toContain('connect');
  });
});

describe('modelSupportsToolCalls', () => {
  it('is true for known-capable models, false for unknown (→ text fallback)', () => {
    for (const m of ['openrouter/openai/gpt-oss-120b:free', 'claude-haiku-4-5', 'google/gemma-4-31b-it', 'nvidia/nemotron-3', 'qwen3-coder', 'claude-sonnet-4-6']) {
      expect(modelSupportsToolCalls(m), m).toBe(true);
    }
    expect(modelSupportsToolCalls('some/unknown-tiny-model')).toBe(false);
    expect(modelSupportsToolCalls(undefined)).toBe(false);
    expect(modelSupportsToolCalls('')).toBe(false);
  });
});

describe('toolCallToDirective', () => {
  it('maps read/ls/grep/diag/remember/delegate', () => {
    expect(toolCallToDirective('read', { path: 'a.ts', start_line: 10, end_line: 20 })).toEqual({ kind: 'read', path: 'a.ts', startLine: 10, endLine: 20 });
    expect(toolCallToDirective('ls', {})).toEqual({ kind: 'ls', path: '.' });
    expect(toolCallToDirective('grep', { pattern: 'foo', include: 'src/**' })).toEqual({ kind: 'grep', pattern: 'foo', include: 'src/**' });
    expect(toolCallToDirective('diag', {})).toEqual({ kind: 'diag', target: 'all' });
    expect(toolCallToDirective('remember', { fact: 'x' })).toEqual({ kind: 'remember', fact: 'x' });
    expect(toolCallToDirective('delegate', { agent: 'claude-code', task: 't', tier: 'strong' })).toEqual({ kind: 'delegate', agent: 'claude-code', task: 't', tier: 'strong' });
    expect(toolCallToDirective('delegate', { agent: 'x', task: 't', tier: 'weird' })).toEqual({ kind: 'delegate', agent: 'x', task: 't' });
  });
  it('maps write/edit/patch/bash', () => {
    expect(toolCallToDirective('write', { path: 'a.ts', content: 'x' })).toEqual({ kind: 'write', path: 'a.ts', content: 'x' });
    expect(toolCallToDirective('edit', { path: 'a.ts', old_string: 'o', new_string: 'n', replace_all: true })).toEqual({ kind: 'edit', path: 'a.ts', oldString: 'o', newString: 'n', replaceAll: true });
    expect(toolCallToDirective('patch', { patch: '*** Delete: a.ts' })).toEqual({ kind: 'patch', patchText: '*** Delete: a.ts' });
    expect(toolCallToDirective('bash', { command: 'npm test' })).toEqual({ kind: 'bash', command: 'npm test' });
  });
  it('maps connect + namespaced mcp__ tools (Phase 6)', () => {
    expect(toolCallToDirective('connect', { service: 'Gmail' })).toEqual({ kind: 'connect', service: 'gmail' });
    expect(toolCallToDirective('connect', { service: '../evil' })).toMatchObject({ error: expect.stringContaining('service') });
    expect(toolCallToDirective('mcp__GMAIL_SEND', { to: 'a@b.com' })).toEqual({ kind: 'mcptool', tool: 'GMAIL_SEND', args: { to: 'a@b.com' } });
    expect(toolCallToDirective('mcp__T', {})).toEqual({ kind: 'mcptool', tool: 'T', args: {} });
  });
  it('returns an error for unknown tools and missing required args', () => {
    expect(toolCallToDirective('nope', {})).toMatchObject({ error: expect.stringContaining('Unknown tool') });
    expect(toolCallToDirective('read', {})).toMatchObject({ error: expect.stringContaining('path') });
    expect(toolCallToDirective('write', { path: 'a.ts' })).toMatchObject({ error: expect.any(String) });
    expect(toolCallToDirective('edit', { path: 'a.ts', new_string: 'n' })).toMatchObject({ error: expect.stringContaining('old_string') });
    expect(toolCallToDirective('bash', { command: '  ' })).toMatchObject({ error: expect.stringContaining('command') });
  });
});

/* ───────────────────── canvas tool surface (Plan 20 §3.3) ────────────────── */

describe('canvas tool schemas', () => {
  const canvasNames = () =>
    coordinatorToolSchemas(false, [], false, {}, true)
      .map(t => t.function.name)
      .filter(n => n.startsWith(CANVAS_TOOL_PREFIX));

  it('offers no canvas tools unless the run is bound to a canvas', () => {
    const unbound = coordinatorToolSchemas(true, [], true, { look: true, act: true }).map(t => t.function.name);
    expect(unbound.some(n => n.startsWith(CANVAS_TOOL_PREFIX))).toBe(false);
    // …and binding does not disturb the tools that were already there.
    const bound = coordinatorToolSchemas(true, [], true, { look: true, act: true }, true).map(t => t.function.name);
    expect(bound.slice(0, unbound.length)).toEqual(unbound);
    expect(canvasNames().length).toBeGreaterThan(0);
  });

  it('is DERIVED from CANVAS_TOOLS — name, description and schema cannot drift from the dispatcher', () => {
    const schemas = coordinatorToolSchemas(false, [], false, {}, true)
      .filter(t => t.function.name.startsWith(CANVAS_TOOL_PREFIX));
    const byName = new Map(schemas.map(t => [t.function.name, t]));
    let checked = 0;
    for (const def of CANVAS_TOOLS) {
      // `compat` names stay dispatchable but are never taught; whole-artboard
      // tools ride the text directive (both asserted separately below).
      if (def.tier === 'compat' || CANVAS_NATIVE_EXCLUDED.has(def.name)) { continue; }
      const schema = byName.get(`${CANVAS_TOOL_PREFIX}${def.name}`);
      expect(schema, def.name).toBeDefined();
      expect(schema!.function.description).toBe(def.description);
      expect(schema!.function.parameters).toEqual(def.inputSchema);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('offers exactly the primary + extra tiers — every op the editor performs, nothing superseded', () => {
    const offered = new Set(canvasNames().map(n => n.slice(CANVAS_TOOL_PREFIX.length)));
    for (const def of CANVAS_TOOLS) {
      const shouldOffer = def.tier !== 'compat' && !CANVAS_NATIVE_EXCLUDED.has(def.name);
      expect(offered.has(def.name), def.name).toBe(shouldOffer);
    }
  });

  it('keeps the whole-artboard tools off the native lane', () => {
    expect([...CANVAS_NATIVE_EXCLUDED].sort()).toEqual(['write_page', 'write_page_jsx']);
  });

  it('every offered canvas tool is dispatchable (or an explicit coordinator-lane tool)', () => {
    for (const name of canvasNames()) {
      const tool = name.slice(CANVAS_TOOL_PREFIX.length);
      const isSessionTool = (CANVAS_SESSION_TOOL_NAMES as readonly string[]).includes(tool);
      expect(Boolean(getCanvasTool(tool)) || isSessionTool, tool).toBe(true);
    }
    // The session tools are exactly the ones dispatchCanvasTool does NOT serve.
    for (const tool of CANVAS_SESSION_TOOL_NAMES) {
      expect(getCanvasTool(tool), tool).toBeUndefined();
      expect(canvasNames()).toContain(`${CANVAS_TOOL_PREFIX}${tool}`);
    }
  });

  it('does NOT expose a whole-page-source tool natively (artboards ride the text directive)', () => {
    expect(canvasNames()).not.toContain('canvas_write_page_jsx');
    // The dispatcher still serves it — only the native transport is withheld.
    expect(getCanvasTool('write_page_jsx')).toBeDefined();
  });

  it('exposes open / checkpoint so a cold chat can design and mark restore points', () => {
    const names = canvasNames();
    expect(names).toContain('canvas_open');
    expect(names).toContain('canvas_checkpoint');
    // canvas_open comes first — it is the precondition for every other call.
    expect(names[0]).toBe('canvas_open');
  });

  it('does NOT expose an agent undo (CANVAS-LANE-05 / Plan 22 §3.5)', () => {
    // Undo/redo is ONE SHARED stack, so an agent undo can revert the HUMAN's
    // last transaction — the plan's rule is "the agent is deliberately given no
    // undo tool ... it corrects by editing forward". It was nevertheless
    // advertised with a description telling the model to PREFER it, while no
    // executor served it.
    expect(canvasNames()).not.toContain('canvas_undo');
    expect(getCanvasTool('undo')).toBeUndefined();
  });

  it('emits well-formed function schemas with a real object parameter shape', () => {
    for (const t of coordinatorToolSchemas(true, [], true, {}, true)) {
      expect(t.type).toBe('function');
      expect(t.function.name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.function.description.length).toBeGreaterThan(0);
      expect(t.function.parameters).toHaveProperty('type', 'object');
      expect(t.function.parameters).toHaveProperty('properties');
    }
  });

  it('copies the dispatcher schema instead of aliasing it', () => {
    const listPages = coordinatorToolSchemas(false, [], false, {}, true)
      .find(t => t.function.name === 'canvas_list_pages')!;
    const def = getCanvasTool('list_pages')!;
    expect(listPages.function.parameters).toEqual(def.inputSchema);
    expect(listPages.function.parameters).not.toBe(def.inputSchema);
  });
});

describe('toolCallToDirective — canvas_*', () => {
  it('converts a native call into the SAME directive the text lane produces', () => {
    expect(toolCallToDirective('canvas_list_pages', {})).toEqual({ kind: 'canvas', tool: 'list_pages', args: {} });
    expect(toolCallToDirective('canvas_read_page', { pageId: 'p1' }))
      .toEqual({ kind: 'canvas', tool: 'read_page', args: { pageId: 'p1' } });
    expect(toolCallToDirective('canvas_insert_page', { page: { mode: 'jsx' }, index: 2 }))
      .toEqual({ kind: 'canvas', tool: 'insert_page', args: { page: { mode: 'jsx' }, index: 2 } });
    expect(toolCallToDirective('canvas_checkpoint', { label: 'before dark theme' }))
      .toEqual({ kind: 'canvas', tool: 'checkpoint', args: { label: 'before dark theme' } });
  });

  it('refuses canvas_undo by name, with a reason the model can act on', () => {
    const out = toolCallToDirective('canvas_undo', {});
    expect('error' in out).toBe(true);
    expect((out as { error: string }).error).toMatch(/editing forward/);
  });

  it('carries no extra authority — the directive is only {kind,tool,args}', () => {
    const d = toolCallToDirective('canvas_set_theme', { theme: { name: 'x' } });
    expect('error' in d).toBe(false);
    expect(Object.keys(d).sort()).toEqual(['args', 'kind', 'tool']);
  });

  it('rejects missing / blank required args instead of dispatching a half call', () => {
    expect(toolCallToDirective('canvas_read_page', {})).toMatchObject({ error: expect.stringContaining('pageId') });
    expect(toolCallToDirective('canvas_read_page', { pageId: '   ' })).toMatchObject({ error: expect.stringContaining('pageId') });
    expect(toolCallToDirective('canvas_read_page', { pageId: null })).toMatchObject({ error: expect.stringContaining('pageId') });
    expect(toolCallToDirective('canvas_checkpoint', {})).toMatchObject({ error: expect.stringContaining('label') });
    expect(toolCallToDirective('canvas_edit_page', { pageId: 'p1' })).toMatchObject({ error: expect.stringContaining('patch') });
    expect(toolCallToDirective('canvas_import_design', { source: 'figma' })).toMatchObject({ error: expect.stringContaining('payload') });
  });

  it('accepts falsy-but-present values that are legitimately empty', () => {
    // An empty reorder list is a no-op, not a missing argument.
    expect(toolCallToDirective('canvas_reorder_pages', { orderedIds: [] }))
      .toEqual({ kind: 'canvas', tool: 'reorder_pages', args: { orderedIds: [] } });
    // canvas_open and canvas_undo take no required arguments at all.
    expect(toolCallToDirective('canvas_open', {})).toEqual({ kind: 'canvas', tool: 'open', args: {} });
  });

  it('rejects unknown / empty canvas tool names', () => {
    expect(toolCallToDirective('canvas_drop_database', {})).toMatchObject({ error: expect.stringContaining('Unknown canvas tool') });
    expect(toolCallToDirective('canvas_', {})).toMatchObject({ error: expect.stringContaining('missing tool name') });
    // The excluded whole-page tool is not reachable through the native lane either.
    expect(toolCallToDirective('canvas_write_page_jsx', { jsx: 'function Page(){}' }))
      .toMatchObject({ error: expect.stringContaining('Unknown canvas tool') });
  });

  it('normalizes prose aliases so both lanes dispatch the same tool name', () => {
    expect(normalizeCanvasToolName('open_canvas')).toBe('open');
    expect(normalizeCanvasToolName('undo_canvas')).toBe('undo');
    expect(normalizeCanvasToolName('canvas_set_text')).toBe('set_text');
    expect(normalizeCanvasToolName('  read_page  ')).toBe('read_page');
    expect(normalizeCanvasToolName('nonsense')).toBe('nonsense');
    expect(toolCallToDirective('canvas_open_canvas', { name: 'Login flow' }))
      .toEqual({ kind: 'canvas', tool: 'open', args: { name: 'Login flow' } });
    expect(isKnownCanvasTool('open_canvas')).toBe(true);
    expect(isKnownCanvasTool('list_pages')).toBe(true);
    // Whole-artboard tools ARE known (the text directive runs them) — they are
    // merely refused on the native lane, which `toolCallToDirective` asserts.
    expect(isKnownCanvasTool('write_page_jsx')).toBe(true);
    expect(isKnownCanvasTool('write_page')).toBe(true);
    expect(isKnownCanvasTool('nonsense')).toBe(false);
  });

  it('leaves the non-canvas namespace untouched', () => {
    expect(toolCallToDirective('mcp__GMAIL_SEND', { to: 'a@b' })).toMatchObject({ kind: 'mcptool' });
    expect(toolCallToDirective('canvasify', {})).toMatchObject({ error: expect.stringContaining('Unknown tool') });
  });
});
