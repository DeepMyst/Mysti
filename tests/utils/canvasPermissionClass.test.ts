/**
 * Plan 20 §3.6 — "Permission class".
 *
 * Two verified defects are pinned here:
 *
 * 1. `mcp__mysti-canvas__list_pages` classified as `bash-command`, because
 *    nothing stripped the `mcp__<server>__` namespace before classification, so
 *    EVERY MCP tool call fell through to the fail-closed default.
 * 2. Canvas ops had no authority class of their own and borrowed
 *    `file-edit`/`file-delete`/`bash-command` — classes calibrated for the
 *    user's source tree, not for an invertible write into `.mysti/canvas/<id>/`.
 *
 * The adversarial half matters more than the happy path: stripping a namespace
 * must not let a third-party MCP server claim the lenient canvas classes, and
 * the four boundary tools must not be widened by the canvas class.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyToolAction,
  shouldGateToolUse,
  permissionSurfaceForTool,
  isNeverGatedAction,
  isCanvasAction,
  normalizeToolName,
  parseToolName,
} from '../../src/utils/permissionClassifier';
import { CANVAS_READ_TOOLS, CANVAS_EDIT_TOOLS, CANVAS_BOUNDARY_TOOLS } from '../../src/utils/toolNames';
import {
  CANVAS_SURFACE_READ_NAMES,
  CANVAS_SURFACE_WRITE_NAMES,
} from '../../src/canvas/CanvasToolSurface';
import type { Settings } from '../../src/types';

function settings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'claude-code', ...overrides,
  };
}

/** Settings that resolve the canvas to `staged` approval (the shipped default). */
const stagedSettings = () => settings({ mode: 'ask-before-edit', accessLevel: 'ask-permission' });
/** Settings that resolve the canvas to `auto` approval. */
const autoSettings = () => settings({ mode: 'edit-automatically', accessLevel: 'full-access' });

// ============================================================================
// parseToolName — the MCP namespace strip, with provenance preserved
// ============================================================================
describe('parseToolName', () => {
  it('splits a real MCP tool name into tool + server', () => {
    expect(parseToolName('mcp__mysti-canvas__list_pages')).toEqual({
      raw: 'mcp__mysti-canvas__list_pages',
      name: 'list_pages',
      mcpServer: 'mysti-canvas',
    });
  });

  it('preserves the server segment rather than discarding it (provenance)', () => {
    for (const server of ['mysti-canvas', 'github', 'figma_dev_mode', 'trello-composio']) {
      const parsed = parseToolName(`mcp__${server}__do_thing`);
      expect(parsed.mcpServer).toBe(server);
      expect(parsed.name).toBe('do_thing');
      expect(parsed.raw).toBe(`mcp__${server}__do_thing`);
    }
  });

  it('applies the alias map to the stripped name', () => {
    expect(parseToolName('mcp__srv__write_file').name).toBe('Write');
    expect(parseToolName('mcp__srv__run_shell_command').name).toBe('Bash');
  });

  it('leaves non-MCP names untouched and reports no server', () => {
    expect(parseToolName('Edit')).toEqual({ raw: 'Edit', name: 'Edit', mcpServer: undefined });
    expect(parseToolName('save_memory').mcpServer).toBeUndefined();
    expect(parseToolName('')).toEqual({ raw: '', name: '' });
  });

  it('refuses malformed namespaces so they keep fail-closing', () => {
    // No tool segment.
    expect(parseToolName('mcp__srv__').name).toBe('mcp__srv__');
    expect(parseToolName('mcp__srv__').mcpServer).toBeUndefined();
    // No server segment.
    expect(parseToolName('mcp____list_pages').name).toBe('mcp____list_pages');
    expect(parseToolName('mcp____list_pages').mcpServer).toBeUndefined();
    // Prefix only.
    expect(parseToolName('mcp__').name).toBe('mcp__');
  });

  it('strips exactly one segment (a nested prefix stays unknown)', () => {
    const parsed = parseToolName('mcp__outer__mcp__mysti-canvas__read_page');
    expect(parsed.mcpServer).toBe('outer');
    expect(parsed.name).toBe('mcp__mysti-canvas__read_page');
    expect(classifyToolAction('mcp__outer__mcp__mysti-canvas__read_page')).toBe('bash-command');
  });

  it('handles a pathological name in linear time (no catastrophic backtracking)', () => {
    const hostile = 'mcp__' + '_'.repeat(50_000) + 'x';
    const started = Date.now();
    expect(() => parseToolName(hostile)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('normalizeToolName returns just the canonical identity', () => {
    expect(normalizeToolName('mcp__mysti-canvas__list_pages')).toBe('list_pages');
    expect(normalizeToolName('mcp__srv__replace')).toBe('Edit');
    expect(normalizeToolName('Read')).toBe('Read');
  });
});

// ============================================================================
// The reported bug
// ============================================================================
describe('MCP-namespaced canvas reads', () => {
  it('mcp__mysti-canvas__list_pages is canvas-read, not bash-command', () => {
    expect(classifyToolAction('mcp__mysti-canvas__list_pages')).toBe('canvas-read');
  });

  it('classifies every canvas read tool, namespaced or bare', () => {
    for (const tool of CANVAS_READ_TOOLS) {
      expect(classifyToolAction(tool)).toBe('canvas-read');
      expect(classifyToolAction(`mcp__mysti-canvas__${tool}`)).toBe('canvas-read');
    }
  });

  it('is case-insensitive on both the server and the tool segment', () => {
    expect(classifyToolAction('MCP__Mysti-Canvas__LIST_PAGES')).toBe('canvas-read');
  });
});

describe('canvas write tools', () => {
  it('classifies every canvas edit tool, namespaced or bare', () => {
    for (const tool of CANVAS_EDIT_TOOLS) {
      expect(classifyToolAction(tool)).toBe('canvas-edit');
      expect(classifyToolAction(`mcp__mysti-canvas__${tool}`)).toBe('canvas-edit');
    }
  });

  it('does not let a canvas page delete borrow the source-tree delete class', () => {
    expect(classifyToolAction('delete_page')).toBe('canvas-edit');
    // ...while a real file delete is untouched.
    expect(classifyToolAction('delete_file')).toBe('file-delete');
  });
});

// ============================================================================
// Adversarial: the canvas class must not widen anything
// ============================================================================
describe('canvas class boundaries', () => {
  it('never applies to the four boundary tools (network / third-party / fs)', () => {
    for (const tool of CANVAS_BOUNDARY_TOOLS) {
      expect(isCanvasAction(classifyToolAction(tool))).toBe(false);
      expect(isCanvasAction(classifyToolAction(`mcp__mysti-canvas__${tool}`))).toBe(false);
    }
  });

  it('keeps generate_visual / generate_video / import_design / export_artifact gated', () => {
    for (const tool of ['generate_visual', 'generate_video', 'import_design', 'export_artifact']) {
      expect(classifyToolAction(tool)).toBe('bash-command');
      expect(shouldGateToolUse(settings(), `mcp__mysti-canvas__${tool}`)).toBe(true);
      expect(permissionSurfaceForTool(autoSettings(), `mcp__mysti-canvas__${tool}`)).not.toBe('canvas-card');
    }
  });

  it('a third-party MCP server cannot claim the canvas classes by name collision', () => {
    for (const server of ['github', 'gmail', 'evil-server']) {
      expect(classifyToolAction(`mcp__${server}__delete_page`)).not.toBe('canvas-edit');
      expect(classifyToolAction(`mcp__${server}__edit_page`)).not.toBe('canvas-edit');
      expect(classifyToolAction(`mcp__${server}__list_pages`)).not.toBe('canvas-read');
      // ...and they stay gated under the shipped default settings.
      expect(shouldGateToolUse(settings(), `mcp__${server}__delete_page`)).toBe(true);
      expect(shouldGateToolUse(settings(), `mcp__${server}__list_pages`)).toBe(true);
    }
  });

  it('a shell tool served by the canvas server is still a shell tool', () => {
    expect(classifyToolAction('mcp__mysti-canvas__bash')).toBe('bash-command');
    expect(classifyToolAction('mcp__mysti-canvas__run_shell_command')).toBe('bash-command');
    expect(classifyToolAction('mcp__mysti-canvas__Write')).toBe('file-create');
    expect(shouldGateToolUse(settings(), 'mcp__mysti-canvas__bash')).toBe(true);
  });

  it('the read and edit sets are disjoint, and neither overlaps the boundary set', () => {
    for (const tool of CANVAS_READ_TOOLS) {
      expect(CANVAS_EDIT_TOOLS.has(tool)).toBe(false);
      expect(CANVAS_BOUNDARY_TOOLS.has(tool)).toBe(false);
    }
    for (const tool of CANVAS_EDIT_TOOLS) {
      expect(CANVAS_BOUNDARY_TOOLS.has(tool)).toBe(false);
    }
  });
});

// ============================================================================
// Plan 22 §3.3 — the sets are GENERATED from the tool surface
// ============================================================================
describe('the canonical Plan 22 tool surface is registered', () => {
  it('classifies every read on the generated surface as canvas-read', () => {
    for (const name of CANVAS_SURFACE_READ_NAMES) {
      expect(CANVAS_READ_TOOLS.has(name)).toBe(true);
      expect(classifyToolAction(name)).toBe('canvas-read');
      expect(classifyToolAction(`mcp__mysti-canvas__${name}`)).toBe('canvas-read');
    }
  });

  it('classifies every non-boundary write on the generated surface as canvas-edit', () => {
    for (const name of CANVAS_SURFACE_WRITE_NAMES) {
      if (CANVAS_BOUNDARY_TOOLS.has(name)) { continue; }
      expect(CANVAS_EDIT_TOOLS.has(name)).toBe(true);
      expect(classifyToolAction(name)).toBe('canvas-edit');
      expect(classifyToolAction(`mcp__mysti-canvas__${name}`)).toBe('canvas-edit');
    }
  });

  it('registers the element-scope names that used to fall through to bash-command', () => {
    // These are the Phase-4 canonical names: before registration they matched
    // neither table and were classified as if they were shell commands.
    for (const name of ['find_nodes']) {
      expect(classifyToolAction(name)).toBe('canvas-read');
    }
    for (const name of [
      'add_page', 'remove_page', 'duplicate_page', 'set_page_meta', 'move_page',
      'write_page', 'set_text', 'set_style', 'set_prop', 'insert_element',
      'remove_element', 'move_element', 'replace_element', 'set_theme_token', 'checkpoint',
    ]) {
      expect(classifyToolAction(name)).toBe('canvas-edit');
    }
  });

  it('keeps import_design a BOUNDARY tool even though the surface calls it a write', () => {
    // It is a real capability on the surface and a third-party payload for the
    // permission gate; the two sets must stay disjoint whichever is read first.
    expect(CANVAS_SURFACE_WRITE_NAMES).toContain('import_design');
    expect(CANVAS_EDIT_TOOLS.has('import_design')).toBe(false);
    expect(isCanvasAction(classifyToolAction('import_design'))).toBe(false);
    expect(shouldGateToolUse(settings(), 'mcp__mysti-canvas__import_design')).toBe(true);
    expect(permissionSurfaceForTool(autoSettings(), 'mcp__mysti-canvas__import_design'))
      .not.toBe('canvas-card');
  });
});

// ============================================================================
// Gating semantics
// ============================================================================
describe('shouldGateToolUse — canvas', () => {
  const modes: Array<Partial<Settings>> = [
    { mode: 'ask-before-edit', accessLevel: 'ask-permission' },
    { mode: 'default', accessLevel: 'ask-permission' },
    { mode: 'edit-automatically', accessLevel: 'ask-permission' },
    { mode: 'edit-automatically', accessLevel: 'full-access' },
    { mode: 'default', accessLevel: 'read-only' },
    { mode: 'quick-plan', accessLevel: 'ask-permission' },
  ];

  it('never gates a canvas read, under any mode/access combination', () => {
    for (const overrides of modes) {
      expect(shouldGateToolUse(settings(overrides), 'mcp__mysti-canvas__read_page')).toBe(false);
      expect(shouldGateToolUse(settings(overrides), 'get_artifact_index')).toBe(false);
    }
  });

  it('never raises a blocking modal for a canvas edit (its approval is in-canvas)', () => {
    for (const overrides of modes) {
      expect(shouldGateToolUse(settings(overrides), 'mcp__mysti-canvas__edit_page')).toBe(false);
      expect(shouldGateToolUse(settings(overrides), 'write_page_jsx')).toBe(false);
    }
  });

  it('leaves non-canvas gating decisions exactly as they were', () => {
    const ask = settings({ mode: 'ask-before-edit' });
    expect(shouldGateToolUse(ask, 'Edit')).toBe(true);
    expect(shouldGateToolUse(ask, 'Bash')).toBe(true);
    expect(shouldGateToolUse(ask, 'Read')).toBe(false);
    expect(shouldGateToolUse(ask, 'UnknownTool')).toBe(true);
    expect(shouldGateToolUse(ask, 'Task')).toBe(true);
  });
});

describe('isNeverGatedAction', () => {
  it('covers file-read and canvas-read only', () => {
    expect(isNeverGatedAction('file-read')).toBe(true);
    expect(isNeverGatedAction('canvas-read')).toBe(true);
    expect(isNeverGatedAction('canvas-edit')).toBe(false);
    expect(isNeverGatedAction('bash-command')).toBe(false);
    expect(isNeverGatedAction('delegate')).toBe(false);
  });
});

// ============================================================================
// Approval surface
// ============================================================================
describe('permissionSurfaceForTool', () => {
  it('a canvas read needs no approval anywhere', () => {
    expect(permissionSurfaceForTool(stagedSettings(), 'mcp__mysti-canvas__list_pages')).toBe('none');
    expect(permissionSurfaceForTool(autoSettings(), 'read_page')).toBe('none');
  });

  it('a canvas edit asks in-canvas in staged mode and not at all in auto mode', () => {
    expect(permissionSurfaceForTool(stagedSettings(), 'mcp__mysti-canvas__edit_page')).toBe('canvas-card');
    expect(permissionSurfaceForTool(autoSettings(), 'mcp__mysti-canvas__edit_page')).toBe('none');
  });

  it('read-only access stages canvas edits rather than dropping the approval', () => {
    expect(permissionSurfaceForTool(settings({ accessLevel: 'read-only' }), 'insert_page')).toBe('canvas-card');
  });

  it('a canvas edit is NEVER a modal, even where every other write is', () => {
    for (const tool of CANVAS_EDIT_TOOLS) {
      expect(permissionSurfaceForTool(stagedSettings(), tool)).not.toBe('modal');
    }
    expect(permissionSurfaceForTool(stagedSettings(), 'Edit')).toBe('modal');
  });

  it('non-canvas tools keep the modal surface exactly where the gate fires', () => {
    const ask = settings({ mode: 'ask-before-edit' });
    expect(permissionSurfaceForTool(ask, 'Bash')).toBe('modal');
    expect(permissionSurfaceForTool(ask, 'Read')).toBe('none');
    expect(permissionSurfaceForTool(autoSettings(), 'Edit')).toBe('none');
  });
});
