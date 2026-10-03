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
 * Plan 22 §3.5 — the canvas shell's responsive decision table, as pure numbers.
 *
 * The layout itself is CSS (`media/canvas/canvas.css` §5): a container-query
 * ladder over four checkboxes, so the panel is responsive and its side panes
 * are collapsible with **no JavaScript at all** — which is the honest default
 * for a shell whose bundle may still be fetching, or may have failed.
 *
 * This module is the same decision expressed as arithmetic, for the three
 * things CSS cannot do:
 *
 *  1. **Persist.** Pane collapse is *view* state (§3.5: "local, sovereign,
 *     never overwritten"), so it belongs in `CanvasViewState` and never on the
 *     wire as an artifact op. {@link paneStateFromSwitches} /
 *     {@link switchesForPaneState} convert between that state and the two
 *     checkboxes that drive the CSS, so a host can restore a remembered layout
 *     by assigning `input.checked` and nothing else.
 *  2. **Answer questions the board asks.** `board.ts` fits artboards to the
 *     viewport; {@link resolveShellLayout} tells it how many CSS pixels the
 *     board track will actually get at a given panel width, without measuring.
 *  3. **Be tested.** The load-bearing property of the ladder — *the board is
 *     never squeezed below its floor, at any width, in any pane state* — is a
 *     claim about numbers. Asserting it here is cheap; asserting it in CSS is
 *     not possible.
 *
 * The numbers below are the CSS's numbers. If one changes, both change: the
 * conformance test in `tests/webview/canvasShell.test.ts` reads the stylesheet
 * and fails if they drift apart.
 */

/** How much of the shell is on screen. Mirrors the `@container` ladder. */
export type LayoutMode = 'wide' | 'medium' | 'narrow';

/** Which side pane. */
export type PaneKey = 'rail' | 'inspector';

/**
 * What the user asked for, independent of width. `'auto'` = whatever the
 * ladder does by default, which is what a fresh canvas opens in.
 */
export type PaneState = 'auto' | 'open' | 'closed';

/** How a pane is presented once width and user intent are both accounted for. */
export type PanePresentation = 'docked' | 'overlay' | 'hidden';

/**
 * Panel widths, in CSS px, at which the ladder steps. Inclusive lower bounds.
 *
 * `wide` is the first width at which all three panes are simultaneously
 * comfortable: 172 (rail floor) + 240 (inspector floor) + 548 leaves a board
 * wider than the 320px floor with room to spare. Below it the inspector yields
 * first — it is modal to a selection and useless without one — then the rail,
 * which is navigation. The board never yields.
 */
export const LAYOUT_BREAKPOINTS = {
  /** >= this width: rail docked + inspector docked. */
  wide: 960,
  /** >= this width (and < `wide`): rail docked, inspector overlays. */
  medium: 640,
  /** < this width: labels and capability chips hide to buy back the top bar. */
  compact: 480,
} as const;

/**
 * Floors, in CSS px. Below its floor a pane stops being useful rather than
 * merely tight: the rail truncates page titles mid-word, the inspector wraps a
 * label/control pair into unreadability, and the board stops being a board.
 */
export const LAYOUT_FLOORS = {
  rail: 172,
  inspector: 240,
  board: 320,
} as const;

/** Ceilings — a rail 400px wide is not a better rail, only a smaller board. */
export const LAYOUT_CEILINGS = {
  rail: 260,
  inspector: 340,
} as const;

/** Proportional targets, as a fraction of panel width (the CSS's `cqi` terms). */
export const LAYOUT_RATIOS = {
  rail: 0.17,
  inspector: 0.22,
} as const;

/** The checkbox ids that drive the CSS ladder, per pane. */
export const PANE_SWITCH_IDS: Readonly<Record<PaneKey, { hide: string; show: string }>> = {
  rail: { hide: 'rail-hidden', show: 'rail-shown' },
  inspector: { hide: 'inspector-hidden', show: 'inspector-shown' },
};

/** Both switches for one pane, as the DOM holds them. */
export interface PaneSwitches {
  /** Checked = "hide this pane" — the control offered while it is docked. */
  hide: boolean;
  /** Checked = "show this pane" — the control offered while it is an overlay. */
  show: boolean;
}

export interface PaneLayout {
  presentation: PanePresentation;
  /** Grid track width in CSS px. Zero whenever the pane is not docked. */
  trackPx: number;
}

export interface ShellLayout {
  mode: LayoutMode;
  /** True when the top bar drops its text labels and capability chips. */
  compact: boolean;
  rail: PaneLayout;
  inspector: PaneLayout;
  /** CSS px the board track receives. Never below {@link boardFloor}. */
  boardPx: number;
}

/* ------------------------------- primitives ------------------------------- */

function _clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** A non-finite or negative width is treated as the narrowest panel possible. */
function _sanitizeWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/**
 * The board's floor at a given width. `min(floor, width)` — the same `min()`
 * the CSS grid track uses — is what makes the floor incapable of overflowing a
 * panel narrower than the floor itself.
 */
export function boardFloor(width: number): number {
  return Math.min(LAYOUT_FLOORS.board, _sanitizeWidth(width));
}

export function resolveLayoutMode(width: number): LayoutMode {
  const w = _sanitizeWidth(width);
  if (w >= LAYOUT_BREAKPOINTS.wide) { return 'wide'; }
  if (w >= LAYOUT_BREAKPOINTS.medium) { return 'medium'; }
  return 'narrow';
}

export function isCompact(width: number): boolean {
  return _sanitizeWidth(width) < LAYOUT_BREAKPOINTS.compact;
}

/** The presentation a pane defaults to at this width, before any user intent. */
export function defaultPresentation(pane: PaneKey, mode: LayoutMode): PanePresentation {
  if (mode === 'wide') { return 'docked'; }
  if (pane === 'inspector') { return 'hidden'; }        // overlay, but closed
  return mode === 'medium' ? 'docked' : 'hidden';
}

/**
 * Fold width and user intent into one presentation.
 *
 * The asymmetry is the point, and it is why the shell carries two switches per
 * pane rather than one: at a docked width the only useful override is *closed*,
 * and at an overlay width the only useful override is *open*. A single checkbox
 * whose checked state meant "open" at one width and "closed" at another would
 * lie to a screen reader, so each switch is named for the action it performs
 * and the irrelevant one is not rendered.
 */
export function resolvePanePresentation(
  pane: PaneKey,
  mode: LayoutMode,
  state: PaneState,
): PanePresentation {
  const docks = defaultPresentation(pane, mode) === 'docked';
  if (docks) { return state === 'closed' ? 'hidden' : 'docked'; }
  return state === 'open' ? 'overlay' : 'hidden';
}

/**
 * The docked track width, mirroring `clamp(floor, ratio*width, ceiling)`.
 * Zero for any pane that is not docked — an overlay is out of flow, so it costs
 * the board nothing.
 */
export function paneTrackPx(pane: PaneKey, width: number, presentation: PanePresentation): number {
  if (presentation !== 'docked') { return 0; }
  const w = _sanitizeWidth(width);
  return _clamp(w * LAYOUT_RATIOS[pane], LAYOUT_FLOORS[pane], LAYOUT_CEILINGS[pane]);
}

/**
 * The whole shell, resolved.
 *
 * Invariant asserted in the tests and relied on by `board.ts`:
 * `boardPx >= boardFloor(width)` for every width and every pane state.
 */
export function resolveShellLayout(
  width: number,
  states?: Partial<Record<PaneKey, PaneState>>,
): ShellLayout {
  const w = _sanitizeWidth(width);
  const mode = resolveLayoutMode(w);
  const railPresentation = resolvePanePresentation('rail', mode, states?.rail ?? 'auto');
  const inspPresentation = resolvePanePresentation('inspector', mode, states?.inspector ?? 'auto');
  const rail: PaneLayout = { presentation: railPresentation, trackPx: paneTrackPx('rail', w, railPresentation) };
  const inspector: PaneLayout = { presentation: inspPresentation, trackPx: paneTrackPx('inspector', w, inspPresentation) };
  const boardPx = Math.max(w - rail.trackPx - inspector.trackPx, boardFloor(w));
  return { mode, compact: isCompact(w), rail, inspector, boardPx };
}

/* --------------------------- view-state ⇄ switches --------------------------- */

/**
 * Read a pane's state back out of its two checkboxes.
 *
 * Both checked is not a state the UI can produce (only one switch is rendered
 * at a time), but a persisted layout could be restored into a different width,
 * so it is defined rather than left to chance: an explicit *close* outranks an
 * explicit *open*, because the conservative reading of "the user hid this" is
 * to keep it hidden until they ask for it again.
 */
export function paneStateFromSwitches(switches: PaneSwitches): PaneState {
  if (switches.hide) { return 'closed'; }
  return switches.show ? 'open' : 'auto';
}

/** The inverse: what the two checkboxes must read for a remembered state. */
export function switchesForPaneState(state: PaneState): PaneSwitches {
  return { hide: state === 'closed', show: state === 'open' };
}
