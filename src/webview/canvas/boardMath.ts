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
 * Plan 22 §4 row 1 - ONE transformed world, and all of its arithmetic.
 *
 * What this replaces: `media/canvas/canvas.js:152-178` put the *selected* page
 * in a single `#page-stage`, fit-to-width and capped at 1x. A 20-artboard
 * design was 19 text rows and one live frame; there was no board, therefore no
 * board math, therefore nothing to test.
 *
 * Every artboard now sits at its own `page.boardPos` at its own `page.format`
 * size inside one pan/zoom world:
 *
 *     screen = world * zoom + pan          (transform-origin: 0 0)
 *     world  = (screen - pan) / zoom
 *
 * Everything here is a PURE function of numbers. That is deliberate and it is
 * the whole reason this module exists apart from `board.ts`: the part of a
 * canvas that silently goes wrong is the arithmetic - a zoom that drifts under
 * the cursor, a fit that divides by a zero-width viewport, a marquee whose rect
 * is inverted when you drag up-left, a `NaN` pan that blanks the board with no
 * error anywhere. None of that is observable in a DOM test and all of it is
 * observable here.
 *
 * ## Fail-safe numerics
 *
 * Zoom and pan are fed by wheel events, by `IntersectionObserver` timing, by a
 * persisted view state and (indirectly) by artboard geometry that came from a
 * model-authored document. A single `NaN` propagating into the CSS transform
 * makes the entire board vanish. So every entry point normalizes: non-finite
 * numbers collapse to a defined fallback ({@link finiteOr}), zoom is clamped to
 * {@link MIN_ZOOM}..{@link MAX_ZOOM}, and no function can return a transform
 * containing a non-finite component. There is no code path here that divides by
 * an unchecked denominator.
 */

/* ------------------------------ shapes ------------------------------ */

export interface Point { x: number; y: number }

export interface Size { width: number; height: number }

/** An axis-aligned box. `w`/`h` are always non-negative once normalized. */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * The board transform. `pan` is in SCREEN pixels (it is the translation applied
 * after scaling), which is what makes {@link zoomAbout} a two-line function
 * instead of a matrix inversion.
 */
export interface BoardTransform { zoom: number; pan: Point }

/* ------------------------------ constants ------------------------------ */

/** Below this an artboard is a smudge; below ~0.02 float error starts to show. */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

/** The zoom levels the +/- buttons and Cmd+/Cmd- step through. */
export const ZOOM_PRESETS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Breathing room, in screen px, that {@link fitTransform} leaves around content. */
export const FIT_PADDING = 48;

/**
 * Fit never zooms PAST 1x. Blowing a single small artboard up to 4x to "fill
 * the viewport" is the behaviour every design tool learned not to ship: the
 * artboard is a fixed-size device surface, and magnifying it implies a
 * resolution it does not have.
 */
export const FIT_MAX_ZOOM = 1;

/** One wheel line / page, in px, for `deltaMode` 1 and 2. */
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 400;

/** Per-event zoom factor bounds - a trackpad pinch can report a huge delta. */
const MAX_WHEEL_ZOOM_FACTOR = 2;

/* ------------------------------ numerics ------------------------------ */

/** `value` when it is a finite number, else `fallback`. The one guard. */
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clampZoom(zoom: unknown, min = MIN_ZOOM, max = MAX_ZOOM): number {
  const z = finiteOr(zoom, 1);
  if (z < min) { return min; }
  if (z > max) { return max; }
  return z;
}

export function identityTransform(): BoardTransform {
  return { zoom: 1, pan: { x: 0, y: 0 } };
}

/**
 * Coerce anything transform-shaped into a usable transform.
 *
 * Called on every value crossing a boundary (persisted view state, an app's
 * `CanvasViewState`, a test fixture), because the alternative to normalizing
 * here is a `translate(NaN px, NaN px)` that renders an empty board with no
 * console output and no failing assertion anywhere.
 */
export function normalizeTransform(t: Partial<BoardTransform> | null | undefined): BoardTransform {
  const pan = t?.pan;
  return {
    zoom: clampZoom(t?.zoom),
    pan: { x: finiteOr(pan?.x, 0), y: finiteOr(pan?.y, 0) },
  };
}

/* --------------------------- world <-> screen --------------------------- */

export function worldToScreen(p: Point, t: BoardTransform): Point {
  const n = normalizeTransform(t);
  return { x: finiteOr(p?.x, 0) * n.zoom + n.pan.x, y: finiteOr(p?.y, 0) * n.zoom + n.pan.y };
}

export function screenToWorld(p: Point, t: BoardTransform): Point {
  const n = normalizeTransform(t);
  return { x: (finiteOr(p?.x, 0) - n.pan.x) / n.zoom, y: (finiteOr(p?.y, 0) - n.pan.y) / n.zoom };
}

export function rectToScreen(r: Rect, t: BoardTransform): Rect {
  const n = normalizeTransform(t);
  const origin = worldToScreen({ x: r.x, y: r.y }, n);
  return { x: origin.x, y: origin.y, w: finiteOr(r.w, 0) * n.zoom, h: finiteOr(r.h, 0) * n.zoom };
}

export function rectToWorld(r: Rect, t: BoardTransform): Rect {
  const n = normalizeTransform(t);
  const origin = screenToWorld({ x: r.x, y: r.y }, n);
  return { x: origin.x, y: origin.y, w: finiteOr(r.w, 0) / n.zoom, h: finiteOr(r.h, 0) / n.zoom };
}

/**
 * Where an element inside an artboard lands on screen.
 *
 * The harness reports `rects` in PAGE coordinates - relative to the artboard's
 * own root, because the frame has no idea where it sits on the board and must
 * not be told (its geometry channel stays a pure `x/y/w/h` report, never a
 * board-position oracle). The parent composes: page rect + artboard position,
 * then the board transform. This is the single line that makes a parent-drawn
 * selection overlay line up with content rendered inside a sandboxed iframe.
 */
export function elementScreenRect(elementRect: Rect, boardPos: Point, t: BoardTransform): Rect {
  return rectToScreen({
    x: finiteOr(boardPos?.x, 0) + finiteOr(elementRect?.x, 0),
    y: finiteOr(boardPos?.y, 0) + finiteOr(elementRect?.y, 0),
    w: finiteOr(elementRect?.w, 0),
    h: finiteOr(elementRect?.h, 0),
  }, t);
}

/* ------------------------------ rectangles ------------------------------ */

/** A rect from two corner points, in any drag direction. */
export function normalizedRect(a: Point, b: Point): Rect {
  const ax = finiteOr(a?.x, 0), ay = finiteOr(a?.y, 0);
  const bx = finiteOr(b?.x, 0), by = finiteOr(b?.y, 0);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export function inflateRect(r: Rect, by: number): Rect {
  const d = finiteOr(by, 0);
  return { x: r.x - d, y: r.y - d, w: Math.max(0, r.w + d * 2), h: Math.max(0, r.h + d * 2) };
}

/**
 * Overlap test. Touching edges do NOT count as an intersection: a marquee
 * dragged flush against an artboard's left edge should not select it.
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when `inner` lies entirely inside `outer` (edges inclusive). */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h;
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** The union of every rect, or `null` for an empty board. */
export function contentBounds(rects: readonly Rect[]): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let seen = 0;
  for (const r of rects) {
    if (!r) { continue; }
    const x = finiteOr(r.x, NaN), y = finiteOr(r.y, NaN);
    const w = finiteOr(r.w, 0), h = finiteOr(r.h, 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { continue; }
    seen++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + Math.max(0, w)); maxY = Math.max(maxY, y + Math.max(0, h));
  }
  if (seen === 0) { return null; }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The slice of the world currently on screen. Drives virtualization + minimap. */
export function viewportWorldRect(viewport: Size, t: BoardTransform): Rect {
  const n = normalizeTransform(t);
  const topLeft = screenToWorld({ x: 0, y: 0 }, n);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: Math.max(0, finiteOr(viewport?.width, 0)) / n.zoom,
    h: Math.max(0, finiteOr(viewport?.height, 0)) / n.zoom,
  };
}

/**
 * Is this world-space box worth a live frame right now?
 *
 * `margin` is in SCREEN px so the pre-mount ring stays a constant visual
 * distance rather than growing 50x when the human zooms out - mounting frames
 * for a whole zoomed-out design is exactly the O(pages) cost virtualization
 * exists to avoid.
 */
export function isVisible(worldRect: Rect, viewport: Size, t: BoardTransform, margin = 0): boolean {
  const n = normalizeTransform(t);
  const view = inflateRect(viewportWorldRect(viewport, n), Math.max(0, finiteOr(margin, 0)) / n.zoom);
  return rectsIntersect(view, worldRect);
}

/* -------------------------------- zooming -------------------------------- */

/**
 * Zoom to `nextZoom` while keeping the world point under `anchor` (a SCREEN
 * point, e.g. the cursor) exactly where it is.
 *
 * The property, asserted in the tests: `screenToWorld(anchor, before)` equals
 * `screenToWorld(anchor, after)`. Get this wrong by a sign and the board slides
 * out from under the pointer on every wheel notch - the single most-felt bug in
 * a pan/zoom surface.
 */
export function zoomAbout(t: BoardTransform, nextZoom: number, anchor: Point): BoardTransform {
  const current = normalizeTransform(t);
  const zoom = clampZoom(nextZoom);
  const ax = finiteOr(anchor?.x, 0), ay = finiteOr(anchor?.y, 0);
  const world = screenToWorld({ x: ax, y: ay }, current);
  return { zoom, pan: { x: ax - world.x * zoom, y: ay - world.y * zoom } };
}

/** Multiply the zoom, anchored on a screen point. */
export function zoomBy(t: BoardTransform, factor: number, anchor: Point): BoardTransform {
  const current = normalizeTransform(t);
  return zoomAbout(current, current.zoom * finiteOr(factor, 1), anchor);
}

export function panBy(t: BoardTransform, dx: number, dy: number): BoardTransform {
  const n = normalizeTransform(t);
  return { zoom: n.zoom, pan: { x: n.pan.x + finiteOr(dx, 0), y: n.pan.y + finiteOr(dy, 0) } };
}

/**
 * The next preset above (`dir > 0`) or below (`dir < 0`) the current zoom.
 * Strictly monotonic, so holding Cmd+ can never stall on a value that happens
 * to equal a preset.
 */
export function zoomPresetStep(current: number, dir: number): number {
  const z = clampZoom(current);
  const epsilon = 1e-4;
  if (dir > 0) {
    for (const preset of ZOOM_PRESETS) { if (preset > z + epsilon) { return clampZoom(preset); } }
    return clampZoom(Math.min(MAX_ZOOM, z * 2));
  }
  for (let i = ZOOM_PRESETS.length - 1; i >= 0; i--) {
    const preset = ZOOM_PRESETS[i];
    if (preset < z - epsilon) { return clampZoom(preset); }
  }
  return clampZoom(Math.max(MIN_ZOOM, z / 2));
}

/**
 * Zoom + pan that brings `content` fully into `viewport`.
 *
 * Degenerate inputs are the interesting half: an empty board (`null`), a
 * viewport of zero size (the panel is collapsed, or the board has not been laid
 * out yet), or content with zero extent (one artboard whose format failed to
 * resolve). Each of those is a division by zero waiting to happen, so each has
 * a defined answer here rather than an `Infinity` that reaches the CSS.
 */
export function fitTransform(
  content: Rect | null,
  viewport: Size,
  opts: { padding?: number; maxZoom?: number; minZoom?: number } = {},
): BoardTransform {
  const padding = Math.max(0, finiteOr(opts.padding, FIT_PADDING));
  const maxZoom = clampZoom(opts.maxZoom ?? FIT_MAX_ZOOM);
  const minZoom = clampZoom(opts.minZoom ?? MIN_ZOOM);
  const vw = Math.max(0, finiteOr(viewport?.width, 0));
  const vh = Math.max(0, finiteOr(viewport?.height, 0));
  if (!content || vw <= 0 || vh <= 0) { return identityTransform(); }

  const cw = Math.max(1, finiteOr(content.w, 0));
  const ch = Math.max(1, finiteOr(content.h, 0));
  const availW = Math.max(1, vw - padding * 2);
  const availH = Math.max(1, vh - padding * 2);
  const raw = Math.min(availW / cw, availH / ch, maxZoom);
  const zoom = clampZoom(Math.max(raw, minZoom), minZoom, maxZoom);
  return {
    zoom,
    pan: {
      x: (vw - cw * zoom) / 2 - finiteOr(content.x, 0) * zoom,
      y: (vh - ch * zoom) / 2 - finiteOr(content.y, 0) * zoom,
    },
  };
}

/** Centre `target` (world space) in `viewport` without changing zoom. */
export function centerOn(target: Rect, viewport: Size, t: BoardTransform): BoardTransform {
  const n = normalizeTransform(t);
  const vw = Math.max(0, finiteOr(viewport?.width, 0));
  const vh = Math.max(0, finiteOr(viewport?.height, 0));
  const center = rectCenter({
    x: finiteOr(target?.x, 0), y: finiteOr(target?.y, 0),
    w: Math.max(0, finiteOr(target?.w, 0)), h: Math.max(0, finiteOr(target?.h, 0)),
  });
  return { zoom: n.zoom, pan: { x: vw / 2 - center.x * n.zoom, y: vh / 2 - center.y * n.zoom } };
}

/* -------------------------------- wheel -------------------------------- */

/** The subset of a `WheelEvent` the board reads. Structural: no `lib.dom`. */
export interface WheelLike {
  deltaX?: number;
  deltaY?: number;
  /** 0 = pixel, 1 = line, 2 = page. Absent is treated as pixels. */
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export type WheelIntent =
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number; dy: number };

function deltaScale(mode: number | undefined): number {
  if (mode === 1) { return LINE_HEIGHT_PX; }
  if (mode === 2) { return PAGE_HEIGHT_PX; }
  return 1;
}

/**
 * Wheel semantics, decided in one pure place: **wheel pans, ctrl/cmd-wheel
 * zooms**.
 *
 * That mapping is not a preference - a trackpad pinch is reported by every
 * browser as a wheel event with `ctrlKey: true`, so honouring ctrl is what
 * makes pinch-to-zoom work at all, and treating a bare two-finger scroll as a
 * zoom is what makes a trackpad user seasick.
 *
 * `deltaMode` normalization matters on Windows/Firefox, where a mouse notch
 * arrives as `deltaMode: 1, deltaY: 3` - three PIXELS of pan without it, i.e. a
 * board that appears frozen.
 */
export function wheelIntent(ev: WheelLike): WheelIntent {
  const scale = deltaScale(ev?.deltaMode);
  const dy = finiteOr(ev?.deltaY, 0) * scale;
  const dx = finiteOr(ev?.deltaX, 0) * scale;
  if (ev?.ctrlKey === true || ev?.metaKey === true) {
    const factor = Math.exp(-dy / 300);
    return {
      kind: 'zoom',
      factor: Math.min(MAX_WHEEL_ZOOM_FACTOR, Math.max(1 / MAX_WHEEL_ZOOM_FACTOR, factor)),
    };
  }
  // Pan moves the world OPPOSITE the scroll direction: scrolling down moves
  // content up, exactly like a scrollbar.
  return { kind: 'pan', dx: -dx, dy: -dy };
}

/* -------------------------- responsive layout -------------------------- */

/*
 * WHY THIS LIVES HERE, and not in a `layout.ts` of its own.
 *
 * The shell (`media/canvas/canvas.css`) hard-coded
 * `grid-template-columns: 220px 1fr 280px` with no `@media`, no `@container`
 * and no `minmax()`: 500px of chrome before the board got a pixel, so a Canvas
 * panel dragged into a split editor column crushed the board to nothing. Fixing
 * that in CSS alone is not enough — *which* panes are on screen has to be a
 * decision the board itself can read (it changes the fit, the live-frame budget
 * and the keyboard model), and a decision that is wrong here is invisible in a
 * DOM test and obvious in a table of widths.
 *
 * So the decision is pure arithmetic and it sits with the rest of the board's
 * arithmetic. `board.ts` observes, this file decides, `app.ts` toggles classes.
 */

/** Ordered smallest → largest; the index IS the rank the hysteresis walks. */
export type LayoutMode = 'narrow' | 'medium' | 'wide';
export const LAYOUT_MODES: readonly LayoutMode[] = ['narrow', 'medium', 'wide'];

/**
 * Panel width, in CSS px, at which a second and then a third pane fits.
 *
 * These are NOT independently chosen: they are the same ladder
 * `media/canvas/canvas.css` §5 expresses as
 * `@container canvas-shell (max-width: 639.98px | 959.98px)`. A JS breakpoint
 * that disagreed with the CSS one would be worse than no JS breakpoint at all -
 * the toggle would claim the rail is open while the stylesheet had it docked
 * shut. Change one, change the other, and the tests below are the table both
 * are checked against.
 */
export const LAYOUT_MEDIUM_MIN_PX = 640;
export const LAYOUT_WIDE_MIN_PX = 960;

/**
 * Total width of the dead band around each breakpoint. **Zero, deliberately.**
 *
 * This was 48px, to keep a human parking the editor separator on a threshold
 * from re-fitting the viewport every frame. It cost far more than it bought:
 * the mode this function returns has exactly two consumers — the shell's layout
 * classes and {@link paneIsDocked} — and `paneIsDocked` decides WHICH of a
 * pane's two switches (`…-hidden` for a docked column, `…-shown` for a modal
 * overlay) the toggle and the `[` / `]` / `\` / Escape shortcuts write. The
 * stylesheet's ladder has no hysteresis at all, so inside a 48px band around
 * 640 and 960 the two authorities disagreed about which kind of thing a pane
 * was, and every keyboard pane command wrote the checkbox the stylesheet
 * ignores: at 970px arriving from below, `]` could not hide the inspector no
 * matter how many times it was pressed. That is precisely the failure the
 * module note above calls "worse than no JS breakpoint at all".
 *
 * The anti-flap argument does not survive contact with the code either: the
 * refit runs on `sizeChanged` as well as on a mode change (`board.ts`
 * `_flushResize`), so a drag re-fits every frame regardless, and the CSS flips
 * the panes at the bare threshold whatever this returns.
 *
 * The algorithm is kept and still takes a `hysteresis` argument, for a caller
 * that owns both authorities. Nothing in the shipped path is such a caller.
 */
export const LAYOUT_HYSTERESIS_PX = 0;

/** Lower bound of each rank. Index 0 is unused (narrow starts at zero). */
const LAYOUT_BOUNDS: readonly number[] = [0, LAYOUT_MEDIUM_MIN_PX, LAYOUT_WIDE_MIN_PX];

/**
 * Width → mode.
 *
 * With the shipped {@link LAYOUT_HYSTERESIS_PX} of 0 this is a pure
 * classification and `previous` cannot change the answer — which is the
 * property that keeps it identical to `canvas.css` §5's container queries. Pass
 * a non-zero `hysteresis` and the rank only moves up past `bound + h/2` and
 * only moves down past `bound - h/2`; see the constant for why the shipped
 * default is not that.
 */
export function decideLayoutMode(
  width: unknown,
  previous: LayoutMode | null = null,
  hysteresis: number = LAYOUT_HYSTERESIS_PX,
): LayoutMode {
  const w = Math.max(0, finiteOr(width, 0));
  if (previous === null) {
    if (w >= LAYOUT_WIDE_MIN_PX) { return 'wide'; }
    return w >= LAYOUT_MEDIUM_MIN_PX ? 'medium' : 'narrow';
  }
  const half = Math.max(0, finiteOr(hysteresis, LAYOUT_HYSTERESIS_PX)) / 2;
  let rank = LAYOUT_MODES.indexOf(previous);
  if (rank < 0) { rank = 0; }
  while (rank < LAYOUT_MODES.length - 1 && w >= LAYOUT_BOUNDS[rank + 1] + half) { rank++; }
  while (rank > 0 && w < LAYOUT_BOUNDS[rank] - half) { rank--; }
  return LAYOUT_MODES[rank];
}

/** Which side panes are on screen. `true` = visible. */
export interface PaneVisibility { rail: boolean; inspector: boolean }

/**
 * What a mode shows when the human has not said otherwise.
 *
 * Progressive disclosure, in the order chrome earns its space: the pages rail
 * is how you *navigate* a multi-artboard design, so it survives one step longer
 * than the inspector, which is only useful once something is selected.
 */
export function defaultPanes(mode: LayoutMode): PaneVisibility {
  if (mode === 'wide') { return { rail: true, inspector: true }; }
  if (mode === 'medium') { return { rail: true, inspector: false }; }
  return { rail: false, inspector: false };
}

/** A human's explicit toggle. Absent = "whatever this mode does by default". */
export interface PaneOverride { rail?: boolean; inspector?: boolean }

/**
 * Fold a human's toggles over the mode's defaults.
 *
 * An override wins *within* a mode; {@link carryOverride} decides which
 * overrides survive a mode change, so this function is only ever given the ones
 * that still apply.
 */
export function resolvePanes(mode: LayoutMode, override: PaneOverride | null | undefined): PaneVisibility {
  const base = defaultPanes(mode);
  return {
    rail: typeof override?.rail === 'boolean' ? override.rail : base.rail,
    inspector: typeof override?.inspector === 'boolean' ? override.inspector : base.inspector,
  };
}

/**
 * Which of a human's overrides still mean something in the new mode.
 *
 * The blunt rule - drop everything on any mode change - is wrong in both
 * directions. Going wide → medium moves only the inspector (the rail is docked
 * in both), so "I hid the rail" is still a live intent and must survive;
 * medium → narrow moves only the rail, so "I opened the inspector" survives.
 * What must NOT survive is an override that says "open" on a pane whose default
 * just changed, because at the new width that pane is a different kind of thing
 * - a docked column became a modal overlay - and a stale "open" would have the
 * panel boot into narrow mode with an overlay covering the board.
 *
 * That hazard is ONE-DIRECTIONAL, and the rule used to be applied in both. A
 * "closed" cannot cover anything, so dropping it only threw away the intent: at
 * 1200px the human closed the Inspector, dragged the splitter to 900 and back,
 * and the Inspector re-opened on its own and took 264px of board with it - no
 * user action, no visible cause, repeating on every crossing. Nothing persists
 * pane state (`CanvasViewState` carries none), so the override IS the memory.
 *
 * So: keep an override when the pane's default did not move, and keep a
 * "closed" one either way.
 */
export function carryOverride(
  from: LayoutMode,
  to: LayoutMode,
  override: PaneOverride | null | undefined,
): PaneOverride | null {
  if (!override) { return null; }
  const before = defaultPanes(from);
  const after = defaultPanes(to);
  const kept: PaneOverride = {};
  const survives = (value: unknown, moved: boolean): value is boolean =>
    typeof value === 'boolean' && (!moved || value === false);
  if (survives(override.rail, before.rail !== after.rail)) { kept.rail = override.rail; }
  if (survives(override.inspector, before.inspector !== after.inspector)) {
    kept.inspector = override.inspector;
  }
  return kept.rail === undefined && kept.inspector === undefined ? null : kept;
}

/**
 * Is this pane a docked column at this width, or a modal overlay?
 *
 * It is the same predicate as {@link defaultPanes} by construction - a pane is
 * on screen by default exactly when it has a column of its own - and it is
 * named separately because the shell needs the *reason*: a docked pane is
 * driven by its `…-hidden` switch and an overlay by its `…-shown` one
 * (`canvas.css` §5), and picking the wrong switch is a silent no-op.
 */
export function paneIsDocked(mode: LayoutMode, pane: 'rail' | 'inspector'): boolean {
  return defaultPanes(mode)[pane];
}

/* The class contract with the shell's stylesheet. One mode class is always
 * present; a collapsed pane adds its own. Nothing else is implied. */
export const LAYOUT_MODE_CLASS: Readonly<Record<LayoutMode, string>> = {
  narrow: 'layout-narrow',
  medium: 'layout-medium',
  wide: 'layout-wide',
};
export const RAIL_COLLAPSED_CLASS = 'rail-collapsed';
export const INSPECTOR_COLLAPSED_CLASS = 'inspector-collapsed';

/** Exactly the classes the layout root should carry, in a stable order. */
export function layoutClasses(mode: LayoutMode, panes: PaneVisibility): string[] {
  const out = [LAYOUT_MODE_CLASS[mode]];
  if (!panes.rail) { out.push(RAIL_COLLAPSED_CLASS); }
  if (!panes.inspector) { out.push(INSPECTOR_COLLAPSED_CLASS); }
  return out;
}

/* --------------------------- resize behaviour --------------------------- */

/**
 * Below this a single artboard stops being readable and starts being a swatch.
 * {@link fitMinZoom} makes it the floor for a one-artboard fit.
 */
export const MIN_LEGIBLE_ZOOM = 0.2;

/**
 * The floor a zoom-to-fit may not go under.
 *
 * With one artboard, "fit" means "show me this design" and a 0.05x fit in a
 * 200px-wide panel is a grey rectangle — so the floor applies and the artboard
 * overflows instead, which is recoverable by scrolling and legible on arrival.
 * With several artboards the human asked to see them ALL, and silently
 * refusing to zoom out far enough would hide some of them with no indication.
 */
export function fitMinZoom(pageCount: number): number {
  return Math.max(0, finiteOr(pageCount, 0)) <= 1 ? MIN_LEGIBLE_ZOOM : MIN_ZOOM;
}

/**
 * Re-pan so the world point at the centre of `before` is at the centre of
 * `after`. Zoom is untouched.
 *
 * This is what "the viewport does not jump when the panel is resized" means
 * arithmetically. Without it, `pan` is measured from the top-left, so widening
 * a panel by 300px slides everything the human was looking at 300px off-centre,
 * and narrowing it can push the focused artboard clean off screen.
 *
 * A zero-sized viewport (a collapsed panel, or a board that has not been laid
 * out yet) returns the transform unchanged rather than dividing its way to a
 * `NaN` pan.
 */
export function preserveCenter(t: BoardTransform, before: Size, after: Size): BoardTransform {
  const n = normalizeTransform(t);
  const bw = Math.max(0, finiteOr(before?.width, 0));
  const bh = Math.max(0, finiteOr(before?.height, 0));
  const aw = Math.max(0, finiteOr(after?.width, 0));
  const ah = Math.max(0, finiteOr(after?.height, 0));
  if (bw <= 0 || bh <= 0 || aw <= 0 || ah <= 0) { return n; }
  const world = screenToWorld({ x: bw / 2, y: bh / 2 }, n);
  return { zoom: n.zoom, pan: { x: aw / 2 - world.x * n.zoom, y: ah / 2 - world.y * n.zoom } };
}

/**
 * Next/previous index with wrap-around, for artboard navigation.
 *
 * `current < 0` (nothing focused) enters at the first artboard going forward
 * and the last going backward, so Alt+Right on a fresh panel selects artboard 1
 * rather than doing nothing.
 */
export function stepIndex(count: number, current: number, dir: number): number {
  const n = Math.max(0, Math.floor(finiteOr(count, 0)));
  if (n === 0) { return -1; }
  const step = finiteOr(dir, 0) >= 0 ? 1 : -1;
  const from = Math.floor(finiteOr(current, -1));
  if (from < 0 || from >= n) { return step > 0 ? 0 : n - 1; }
  return ((from + step) % n + n) % n;
}
