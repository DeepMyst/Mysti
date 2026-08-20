/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.5 — the canvas shell's responsive decision table.
 *
 * The shell it describes is 8,813 LOC of well-tested behaviour behind 239 lines
 * of CSS that hard-coded `220px 1fr 280px` — 500px of chrome before the board
 * got a pixel, no `@media`, no `@container`, no collapse. The ladder that
 * replaced it makes exactly one promise, and it is a promise about numbers:
 *
 *     the board is never squeezed below its floor, at any panel width,
 *     in any pane state.
 *
 * So it is asserted here as a sweep rather than as three spot checks — the
 * failure mode being guarded against is a *boundary*, and boundaries are
 * precisely what spot checks miss.
 */
import { describe, it, expect } from 'vitest';
import {
  LAYOUT_BREAKPOINTS, LAYOUT_CEILINGS, LAYOUT_FLOORS, LAYOUT_RATIOS, PANE_SWITCH_IDS,
  boardFloor, defaultPresentation, isCompact, paneStateFromSwitches, paneTrackPx,
  resolveLayoutMode, resolvePanePresentation, resolveShellLayout, switchesForPaneState,
  type PaneKey, type PaneState,
} from '../../src/webview/canvas/layout';

const STATES: PaneState[] = ['auto', 'open', 'closed'];
const PANES: PaneKey[] = ['rail', 'inspector'];

describe('breakpoint ladder', () => {
  it('steps exactly at the documented widths', () => {
    expect(resolveLayoutMode(2000)).toBe('wide');
    expect(resolveLayoutMode(LAYOUT_BREAKPOINTS.wide)).toBe('wide');
    expect(resolveLayoutMode(LAYOUT_BREAKPOINTS.wide - 1)).toBe('medium');
    expect(resolveLayoutMode(LAYOUT_BREAKPOINTS.medium)).toBe('medium');
    expect(resolveLayoutMode(LAYOUT_BREAKPOINTS.medium - 1)).toBe('narrow');
    expect(resolveLayoutMode(320)).toBe('narrow');
  });

  it('treats a missing or nonsensical measurement as the narrowest panel', () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveLayoutMode(bad)).toBe('narrow');
    }
  });

  it('drops top-bar labels only below the compact width', () => {
    expect(isCompact(LAYOUT_BREAKPOINTS.compact)).toBe(false);
    expect(isCompact(LAYOUT_BREAKPOINTS.compact - 1)).toBe(true);
  });

  it('yields the inspector before the rail, and the board never', () => {
    expect(defaultPresentation('inspector', 'wide')).toBe('docked');
    expect(defaultPresentation('inspector', 'medium')).not.toBe('docked');
    expect(defaultPresentation('rail', 'medium')).toBe('docked');
    expect(defaultPresentation('rail', 'narrow')).not.toBe('docked');
  });
});

describe('pane presentation', () => {
  it('offers "closed" at docked widths and "open" at overlay widths', () => {
    expect(resolvePanePresentation('rail', 'wide', 'auto')).toBe('docked');
    expect(resolvePanePresentation('rail', 'wide', 'closed')).toBe('hidden');
    // A pane that is not docked cannot be "opened" into the grid — it overlays.
    expect(resolvePanePresentation('rail', 'narrow', 'open')).toBe('overlay');
    expect(resolvePanePresentation('rail', 'narrow', 'auto')).toBe('hidden');
    expect(resolvePanePresentation('inspector', 'medium', 'open')).toBe('overlay');
  });

  it('ignores an override that belongs to the other width class', () => {
    // Opened while narrow, then widened: the docked layout is not corrupted.
    expect(resolvePanePresentation('rail', 'wide', 'open')).toBe('docked');
    // Hidden while wide, then narrowed: it is closed either way, not doubled.
    expect(resolvePanePresentation('rail', 'narrow', 'closed')).toBe('hidden');
  });

  it('costs the board nothing when a pane is an overlay or hidden', () => {
    expect(paneTrackPx('rail', 1400, 'overlay')).toBe(0);
    expect(paneTrackPx('inspector', 1400, 'hidden')).toBe(0);
  });

  it('clamps a docked track between its floor and its ceiling', () => {
    expect(paneTrackPx('rail', 700, 'docked')).toBe(LAYOUT_FLOORS.rail);      // 119 → floor
    expect(paneTrackPx('rail', 4000, 'docked')).toBe(LAYOUT_CEILINGS.rail);   // 680 → ceiling
    expect(paneTrackPx('inspector', 1200, 'docked')).toBeCloseTo(1200 * LAYOUT_RATIOS.inspector, 5);
  });
});

describe('the board is the product', () => {
  it('never falls below its floor — swept across every width and pane state', () => {
    for (let width = 240; width <= 2400; width += 1) {
      for (const rail of STATES) {
        for (const inspector of STATES) {
          const layout = resolveShellLayout(width, { rail, inspector });
          expect(layout.boardPx).toBeGreaterThanOrEqual(boardFloor(width));
          // And the grid never overflows: tracks + board fit the panel.
          expect(layout.rail.trackPx + layout.inspector.trackPx + layout.boardPx)
            .toBeLessThanOrEqual(Math.max(width, boardFloor(width)) + 0.001);
        }
      }
    }
  });

  it('gives the whole panel to the board in a narrow split column', () => {
    const layout = resolveShellLayout(320);
    expect(layout.mode).toBe('narrow');
    expect(layout.rail.presentation).toBe('hidden');
    expect(layout.inspector.presentation).toBe('hidden');
    expect(layout.boardPx).toBe(320);
  });

  it('keeps a comfortable board at the first wide width', () => {
    const layout = resolveShellLayout(LAYOUT_BREAKPOINTS.wide);
    expect(layout.rail.presentation).toBe('docked');
    expect(layout.inspector.presentation).toBe('docked');
    expect(layout.boardPx).toBe(960 - LAYOUT_FLOORS.rail - LAYOUT_FLOORS.inspector);
    expect(layout.boardPx).toBeGreaterThan(LAYOUT_FLOORS.board);
  });

  it('grows the board, not the chrome, on a full-screen editor', () => {
    const wide = resolveShellLayout(2000);
    expect(wide.rail.trackPx).toBe(LAYOUT_CEILINGS.rail);
    expect(wide.inspector.trackPx).toBe(LAYOUT_CEILINGS.inspector);
    expect(wide.boardPx).toBe(2000 - LAYOUT_CEILINGS.rail - LAYOUT_CEILINGS.inspector);
  });

  it('hands a collapsed pane track straight to the board', () => {
    const both = resolveShellLayout(1400);
    const noInspector = resolveShellLayout(1400, { inspector: 'closed' });
    expect(noInspector.boardPx).toBe(both.boardPx + both.inspector.trackPx);
    const neither = resolveShellLayout(1400, { rail: 'closed', inspector: 'closed' });
    expect(neither.boardPx).toBe(1400);
  });
});

describe('view state ⇄ the CSS switches', () => {
  it('round-trips every pane state through the two checkboxes', () => {
    for (const state of STATES) {
      expect(paneStateFromSwitches(switchesForPaneState(state))).toBe(state);
    }
  });

  it('renders at most one switch as checked, so the UI cannot show both', () => {
    for (const state of STATES) {
      const s = switchesForPaneState(state);
      expect(Number(s.hide) + Number(s.show)).toBeLessThanOrEqual(1);
    }
  });

  it('resolves a restored-into-a-different-width conflict conservatively', () => {
    expect(paneStateFromSwitches({ hide: true, show: true })).toBe('closed');
  });

  it('names the ids the stylesheet keys off', () => {
    for (const pane of PANES) {
      expect(PANE_SWITCH_IDS[pane].hide).toMatch(/-hidden$/);
      expect(PANE_SWITCH_IDS[pane].show).toMatch(/-shown$/);
    }
  });
});
