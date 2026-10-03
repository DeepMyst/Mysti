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
 * CANVAS-LANE-05 / CANVAS-LANE-06 — the coordinator's canvas tool surface must
 * advertise only what it can actually run, and BOTH lanes must canonicalize
 * names the same way.
 *
 * LANE-05: `canvas_undo` was offered as a native schema (with a description
 * telling the model to prefer it over a corrective edit) while nothing
 * implemented it — every call returned "unknown canvas tool: undo". Plan 22
 * §3.5 is explicit that the AGENT is deliberately given no undo tool ("an agent
 * that can revert the human's work is a hazard; it corrects by editing
 * forward"), and undo/redo is ONE SHARED stack, so an agent undo can revert the
 * human's last transaction. The fix is therefore to stop offering it and to
 * refuse it with a sentence the model can act on.
 *
 * LANE-06: `normalizeCanvasToolName` ran only on the native `tool_calls` lane.
 * The text lane is the always-on one (and the only one for models without
 * native function calling), so a coordinator with no canvas open could not open
 * one: the refusal it got back said "Call canvas_open", a spelling the text
 * lane could not express — a livelock that burned the whole run.
 */
import { describe, it, expect } from 'vitest';
import {
  CANVAS_TOOL_SCHEMAS,
  CANVAS_SESSION_TOOL_NAMES,
  coordinatorToolSchemas,
  toolCallToDirective,
  normalizeCanvasToolName,
  canvasToolRefusal,
} from '../../src/services/coordinatorTools';
import { canvasDirectiveToToolCall, isCanvasDirectiveError } from '../../src/canvas/canvasDirective';
import { CANVAS_TOOLS } from '../../src/managers/CanvasToolDispatch';

describe('CANVAS-LANE-05 — no agent undo tool is advertised', () => {
  it('canvas_undo is not in the native schema list', () => {
    const names = CANVAS_TOOL_SCHEMAS.map(t => t.function.name);
    expect(names).not.toContain('canvas_undo');
  });

  it('canvas_undo is not offered to a canvas-bound run', () => {
    const names = coordinatorToolSchemas(false, [], false, {}, true).map(t => t.function.name);
    expect(names).not.toContain('canvas_undo');
  });

  it('every advertised canvas schema is reachable by SOME executor', () => {
    // The conformance gap that let LANE-05 ship: the old test asserted only
    // that the session tools were ABSENT from the dispatcher, never that the
    // coordinator lane implemented them.
    const dispatchable = new Set(CANVAS_TOOLS.map(t => t.name));
    const sessionTools = new Set<string>(CANVAS_SESSION_TOOL_NAMES);
    for (const schema of CANVAS_TOOL_SCHEMAS) {
      const tool = normalizeCanvasToolName(schema.function.name);
      expect(
        dispatchable.has(tool) || sessionTools.has(tool),
        `canvas schema "${schema.function.name}" has no executor`,
      ).toBe(true);
    }
  });

  it('CANVAS_SESSION_TOOL_NAMES no longer claims `undo`', () => {
    expect([...CANVAS_SESSION_TOOL_NAMES]).toEqual(['open']);
  });

  it('a native canvas_undo call is refused with an actionable sentence', () => {
    const out = toolCallToDirective('canvas_undo', {});
    expect('error' in out).toBe(true);
    const err = (out as { error: string }).error;
    expect(err).toMatch(/undo/i);
    // It must NOT read as "you spelled it wrong" — the model would retry.
    expect(err).not.toMatch(/^Unknown canvas tool/);
  });

  it('canvasToolRefusal names undo on both lanes', () => {
    expect(canvasToolRefusal('undo')).toBeTruthy();
    expect(canvasToolRefusal('undo_canvas')).toBeTruthy();
    expect(canvasToolRefusal('canvas_undo')).toBeTruthy();
    expect(canvasToolRefusal('set_text')).toBeUndefined();
  });
});

describe('CANVAS-LANE-06 — the text lane canonicalizes tool names too', () => {
  const textCall = (tool: string) =>
    canvasDirectiveToToolCall({ kind: 'canvas', tool, args: {} } as never);

  it('`canvas_open` on the text lane normalizes to `open`', () => {
    const call = textCall('canvas_open');
    expect(isCanvasDirectiveError(call)).toBe(false);
    expect((call as { tool: string }).tool).toBe('open');
  });

  it('`open_canvas` on the text lane normalizes to `open`', () => {
    expect((textCall('open_canvas') as { tool: string }).tool).toBe('open');
  });

  it('`canvas_set_text` on the text lane normalizes to `set_text`', () => {
    expect((textCall('canvas_set_text') as { tool: string }).tool).toBe('set_text');
  });

  it('both lanes land on the SAME tool for the same intent', () => {
    const native = toolCallToDirective('canvas_set_text', { pageId: 'p1', mid: 'k7f2xq9b1m', text: 'Hi' });
    expect('error' in native).toBe(false);
    const nativeCall = canvasDirectiveToToolCall(native as never);
    const text = textCall('canvas_set_text');
    expect((nativeCall as { tool: string }).tool).toBe((text as { tool: string }).tool);
  });

  it('an empty/whitespace tool name is still reported, not normalized away', () => {
    expect(isCanvasDirectiveError(textCall('   '))).toBe(true);
  });
});
