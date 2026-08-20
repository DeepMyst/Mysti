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
 * Plan 22 §4 row 1 / §5 Phase 3 — the pages rail: real thumbnails, drag to
 * reorder, insert / duplicate / delete, and an honest per-artboard badge.
 *
 * ## Why the thumbnails are drawn, not rasterized
 *
 * Every previous design in this subsystem assumed a thumbnail was a picture of
 * the live frame. It never could be: an artboard runs in `sandbox="allow-scripts"`
 * WITHOUT `allow-same-origin`, so the parent has no pixel access to it — no
 * `canvas.drawImage`, no `html2canvas`, no `getComputedStyle`. That is why the
 * rail was 19 text rows.
 *
 * The document model removes the problem rather than working around it: the
 * PARENT holds the `DocNode` tree, so it can draw the artboard itself through
 * {@link drawPreview} — no iframe, no scripts, no `innerHTML`, always fresh
 * (the tile is redrawn from the same store the board renders from, so it can
 * never disagree with the artboard it depicts).
 *
 * ## Why every gesture here is an op
 *
 * Reorder, insert, duplicate and delete emit `page.reorder` / `page.add` /
 * `page.duplicate` / `page.remove` — the identical records an agent tool
 * produces (§2.3), down the identical `CanvasOpExecutor.submit` chokepoint.
 * Two consequences that are the whole point:
 *
 * 1. Deleting an artboard needs no "are you sure": it is one op on the shared
 *    undo stack, so Cmd+Z brings it back with its id, pins and comments intact.
 * 2. The drag cannot half-apply. A drag emits ONE `page.reorder` on pointer-up
 *    carrying the final order — not N `page.move`s — so a stale intermediate
 *    order can never be committed, and one drag is one undo step by
 *    construction rather than by remembering to group it.
 *
 * The decision-making half (geometry, drop index, op construction, badges) is
 * pure and exported, because that is the half a headless test can actually
 * falsify; the class below is DOM wiring over it.
 */

import type { CanvasOp, NewPageSpec } from '../../canvas/CanvasOps';
import type { DocNode, Mid } from '../../canvas/doc/DocNode';
import { mintMid } from '../../canvas/doc/DocNode';
import type { WireArtifact } from '../../canvas/protocol';
import type { ArtifactPage, CanvasFormatSpec } from '../../types';
import type { CanvasEnv, DomElement } from './dom';
import { drawPreview } from './preview';
import { themeCssVars } from './sandboxDoc';
import type { CanvasViewState } from './state';

/* ------------------------------- row model ------------------------------- */

/** The honest badge for an artboard whose source never compiled (§3.1). */
export const LEGACY_BADGE_LABEL = 'code page';
export const LEGACY_BADGE_HINT = 'code page — not directly editable';

export interface RailBadge {
  label: string;
  /** `title` attribute — the long form. */
  hint: string;
}

export interface RailRow {
  pageId: string;
  index: number;
  title: string;
  /** The artboard's real device/format. Never the human's local preview override. */
  format: CanvasFormatSpec;
  device: RailBadge;
  /** Present only for a `legacy` page; the rail says so rather than pretending. */
  legacy: RailBadge | null;
  selected: boolean;
}

/** Turn a formatId into something a human reads: `story-9x16` → `Story 9x16`. */
function prettyFormatId(formatId: string): string {
  const words = formatId.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) { return ''; }
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The per-page device badge.
 *
 * `labels` is the boot payload's device catalog (`CanvasBoot.devices`), so the
 * rail and the device dropdown name the same format the same way; without it
 * the badge degrades to a prettified id rather than disappearing.
 */
export function deviceBadge(
  format: CanvasFormatSpec,
  labels?: ReadonlyMap<string, string>,
): RailBadge {
  const dims = `${Math.round(format.width)}×${Math.round(format.height)}`;
  const named = labels?.get(format.formatId) ?? (format.formatId === 'custom' ? '' : prettyFormatId(format.formatId));
  const label = named ? `${named} · ${dims}` : dims;
  const kind = format.kind === 'print' ? 'print format' : 'screen format';
  return { label, hint: `${label} — ${kind}` };
}

export interface RailRowOptions {
  deviceLabels?: ReadonlyMap<string, string>;
}

/**
 * Project the artifact onto rail rows.
 *
 * Reads `page.format ?? artifact.format` and NEVER `view.previewFormat`: the
 * badge states what the artboard IS, and a local "show me this on mobile"
 * preview must not rewrite that claim (§3.5 — the exact conflation that made
 * the old device dropdown both lossy and destructive).
 */
export function railRows(
  artifact: WireArtifact,
  view: Pick<CanvasViewState, 'focusedPageId'>,
  opts: RailRowOptions = {},
): RailRow[] {
  return artifact.pages.map((page, index) => {
    const format = page.format ?? artifact.format;
    return {
      pageId: page.id,
      index,
      title: page.actionTitle?.trim() || `Artboard ${index + 1}`,
      format,
      device: deviceBadge(format, opts.deviceLabels),
      legacy: page.legacy
        ? { label: LEGACY_BADGE_LABEL, hint: page.compileError ? `${LEGACY_BADGE_HINT} · ${page.compileError}` : LEGACY_BADGE_HINT }
        : null,
      selected: page.id === view.focusedPageId,
    };
  });
}

/* --------------------------------- drag --------------------------------- */

/** Where a rail row sits, in the rail's own scroll coordinates. */
export interface RailRowGeometry {
  pageId: string;
  top: number;
  height: number;
}

/** Pointer travel before a press becomes a drag rather than a click. */
export const RAIL_DRAG_THRESHOLD_PX = 4;

export interface RailDrag {
  pageId: string;
  fromIndex: number;
  /** Final index the dragged row would land at. Equals `fromIndex` until moved. */
  toIndex: number;
  startY: number;
  y: number;
  /** False until the pointer passed {@link RAIL_DRAG_THRESHOLD_PX}. */
  moved: boolean;
}

function sortedRows(rows: readonly RailRowGeometry[]): RailRowGeometry[] {
  return [...rows].sort((a, b) => a.top - b.top);
}

/**
 * The index the dragged row lands at for a pointer at `y`.
 *
 * Counts how many OTHER rows the pointer has passed the midpoint of. Excluding
 * the dragged row is what makes the result a final index rather than an
 * insertion index into a list that still contains the row being moved — the
 * off-by-one that makes "drag down by one" a no-op in most hand-rolled rails.
 */
export function railDropIndex(
  rows: readonly RailRowGeometry[],
  draggedPageId: string,
  y: number,
): number {
  const others = sortedRows(rows).filter(r => r.pageId !== draggedPageId);
  let index = 0;
  for (const row of others) {
    if (y > row.top + row.height / 2) { index++; } else { break; }
  }
  return Math.max(0, Math.min(others.length, index));
}

export function beginRailDrag(
  rows: readonly RailRowGeometry[],
  pageId: string,
  y: number,
): RailDrag | null {
  const order = sortedRows(rows).map(r => r.pageId);
  const fromIndex = order.indexOf(pageId);
  if (fromIndex < 0) { return null; }
  return { pageId, fromIndex, toIndex: fromIndex, startY: y, y, moved: false };
}

export function updateRailDrag(
  drag: RailDrag,
  rows: readonly RailRowGeometry[],
  y: number,
): RailDrag {
  const moved = drag.moved || Math.abs(y - drag.startY) >= RAIL_DRAG_THRESHOLD_PX;
  return {
    ...drag,
    y,
    moved,
    toIndex: moved ? railDropIndex(rows, drag.pageId, y) : drag.fromIndex,
  };
}

/** Move one id to a new index. Pure; returns a fresh array. */
export function moveInOrder(ids: readonly string[], from: number, to: number): string[] {
  const out = [...ids];
  if (from < 0 || from >= out.length) { return out; }
  const [moved] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, moved);
  return out;
}

/** The order a finished drag would produce. */
export function railDragOrder(drag: RailDrag, ids: readonly string[]): string[] {
  if (!drag.moved) { return [...ids]; }
  return moveInOrder(ids, ids.indexOf(drag.pageId), drag.toIndex);
}

function isPermutation(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) { return false; }
  const seen = new Set(a);
  // Both sides must be duplicate-free: `['a','a']` against `['a','b']` is the
  // same length and every element is "known", yet committing it would delete an
  // artboard from the order.
  if (seen.size !== a.length || new Set(b).size !== b.length) { return false; }
  return b.every(id => seen.has(id));
}

/**
 * One `page.reorder` for a real change, and NOTHING for a no-op drag.
 *
 * The permutation check is not decoration: an order that dropped or duplicated
 * an id would be rejected host-side, but only after the executor had already
 * bumped `artifact.version` on a sibling op — so a client bug would surface as
 * a spurious resync rather than as the silence it deserves.
 */
export function railReorderOps(current: readonly string[], next: readonly string[]): CanvasOp[] {
  if (!isPermutation(current, next)) { return []; }
  if (current.length === next.length && current.every((id, i) => id === next[i])) { return []; }
  return [{ op: 'page.reorder', orderedIds: [...next] }];
}

/** Ops for a completed drag gesture. Empty when the row did not actually move. */
export function endRailDrag(drag: RailDrag, ids: readonly string[]): CanvasOp[] {
  return railReorderOps(ids, railDragOrder(drag, ids));
}

/* ------------------------------- keyboard ------------------------------- */

/**
 * What a keydown on a rail row means.
 *
 * Pure and exported because "the pages rail is operable without a mouse" is a
 * claim worth being able to falsify: every branch below is one assertion, and
 * the controller underneath it only moves focus and emits the ops the pointer
 * path already emits.
 */
export type RailKeyIntent =
  | { kind: 'select' }
  | { kind: 'focus'; delta: -1 | 1 }
  | { kind: 'move'; delta: -1 | 1 }
  | { kind: 'edge'; to: 'first' | 'last' }
  /** Into (delta 1) the row's action buttons. The composite-widget idiom. */
  | { kind: 'action'; delta: -1 | 1 };

interface RailKeyEvent {
  key?: unknown;
  altKey?: unknown;
  metaKey?: unknown;
  ctrlKey?: unknown;
  shiftKey?: unknown;
}

/**
 * Alt is the reorder modifier on every platform.
 *
 * Deliberately NOT Cmd/Ctrl+Arrow: those are word-wise caret motion and native
 * editor navigation, and a design tool that steals them reorders artboards
 * while someone is trying to move a cursor. Alt+Arrow is the same chord VS
 * Code itself uses to move a line, so the muscle memory already means "move
 * this thing".
 */
export function railKeyIntent(ev: RailKeyEvent): RailKeyIntent | null {
  if (!ev || typeof ev !== 'object') { return null; }
  const key = typeof ev.key === 'string' ? ev.key : '';
  const move = ev.altKey === true;
  switch (key) {
    case 'Enter':
    case ' ':
    case 'Spacebar':
      return move ? null : { kind: 'select' };
    case 'ArrowUp':
      return move ? { kind: 'move', delta: -1 } : { kind: 'focus', delta: -1 };
    case 'ArrowDown':
      return move ? { kind: 'move', delta: 1 } : { kind: 'focus', delta: 1 };
    case 'ArrowRight':
      return move ? null : { kind: 'action', delta: 1 };
    case 'ArrowLeft':
      return move ? null : { kind: 'action', delta: -1 };
    case 'Home':
      return move ? null : { kind: 'edge', to: 'first' };
    case 'End':
      return move ? null : { kind: 'edge', to: 'last' };
    default:
      return null;
  }
}

/** What a keydown on one of a row's action buttons means. */
export type RailActionIntent =
  | { kind: 'sibling'; delta: -1 | 1 }
  | { kind: 'row'; delta: -1 | 0 | 1 }
  | { kind: 'edge'; to: 'first' | 'last' };

/**
 * The action buttons' half of the composite widget.
 *
 * Enter and Space are deliberately absent: they ACTIVATE the button, and the
 * rail must leave them to the browser. Escape and ArrowLeft-off-the-first
 * button both return to the row, so there is always a way back to the list.
 */
export function railActionKeyIntent(ev: RailKeyEvent): RailActionIntent | null {
  if (!ev || typeof ev !== 'object') { return null; }
  if (ev.altKey === true || ev.metaKey === true || ev.ctrlKey === true) { return null; }
  switch (typeof ev.key === 'string' ? ev.key : '') {
    case 'ArrowRight': return { kind: 'sibling', delta: 1 };
    case 'ArrowLeft': return { kind: 'sibling', delta: -1 };
    case 'ArrowDown': return { kind: 'row', delta: 1 };
    case 'ArrowUp': return { kind: 'row', delta: -1 };
    case 'Escape': return { kind: 'row', delta: 0 };
    case 'Home': return { kind: 'edge', to: 'first' };
    case 'End': return { kind: 'edge', to: 'last' };
    default: return null;
  }
}

/** One `page.reorder` for an Alt+Arrow nudge, or nothing at an edge. */
export function railNudgeOps(ids: readonly string[], pageId: string, delta: number): CanvasOp[] {
  const from = ids.indexOf(pageId);
  if (from < 0) { return []; }
  const to = from + delta;
  if (to < 0 || to >= ids.length) { return []; }
  return railReorderOps(ids, moveInOrder(ids, from, to));
}

/* ----------------------------- insert / clone ----------------------------- */

/**
 * A blank artboard's document.
 *
 * Three nodes, all on the shipped `UI.*` primitives so the frame renders it
 * with no compiler: an empty `doc` would give the human nothing to click and
 * the agent no anchor mid to insert against.
 */
export function blankArtboardDoc(mint: () => Mid = mintMid, title = 'New artboard'): DocNode {
  return {
    mid: mint(),
    tag: 'UI.Screen',
    children: [{
      mid: mint(),
      tag: 'UI.Stack',
      props: { gap: 16 },
      children: [{ mid: mint(), tag: 'UI.Heading', text: title }],
    }],
  };
}

/** Horizontal gap between artboards on the infinite board. */
export const BOARD_GUTTER_PX = 120;

/**
 * Where a new artboard goes: to the right of everything, on the top row.
 *
 * Board position is artifact state, so the client proposing one is a
 * convenience the host may override — but proposing `{0,0}` would stack the new
 * artboard underneath an existing one, which reads as "nothing happened".
 */
export function nextBoardPos(
  pages: readonly ArtifactPage[],
  artifactFormat: CanvasFormatSpec,
): { x: number; y: number } {
  let right = 0;
  let top: number | null = null;
  for (const page of pages) {
    const width = (page.format ?? artifactFormat).width;
    right = Math.max(right, (page.boardPos?.x ?? 0) + width);
    const y = page.boardPos?.y ?? 0;
    top = top === null ? y : Math.min(top, y);
  }
  return { x: pages.length === 0 ? 0 : right + BOARD_GUTTER_PX, y: top ?? 0 };
}

export interface AddArtboardSpec {
  format: CanvasFormatSpec;
  boardPos: { x: number; y: number };
  title?: string;
  /** Insertion position in the rail. Omitted = append. */
  index?: number;
  mint?: () => Mid;
}

/**
 * `page.add` for the rail's "+".
 *
 * `NewPageSpec.id` is deliberately NOT set: ids are minted host-side, and a
 * client-chosen page id is exactly the kind of claim §3.4 keeps off the wire.
 * The mids inside `doc` are only hints — the host verifies them against the
 * live tree and re-mints on collision.
 */
export function addPageOps(spec: AddArtboardSpec): CanvasOp[] {
  const mint = spec.mint ?? mintMid;
  const title = spec.title?.trim() || 'New artboard';
  const page: NewPageSpec = {
    doc: blankArtboardDoc(mint, title),
    actionTitle: title,
    format: spec.format,
    boardPos: spec.boardPos,
  };
  return [spec.index === undefined ? { op: 'page.add', page } : { op: 'page.add', page, index: spec.index }];
}

export function duplicatePageOps(pageId: string): CanvasOp[] {
  return [{ op: 'page.duplicate', pageId }];
}

/**
 * `page.remove`.
 *
 * No confirmation dialog, on purpose: the op is on the shared undo stack, so
 * Cmd+Z restores the artboard under its ORIGINAL id (`page.remove`'s inverse is
 * a `page.add` carrying it), which keeps every pin, comment and staged op that
 * addressed it addressable. A modal would buy nothing and cost a gesture.
 */
export function removePageOps(pageId: string): CanvasOp[] {
  return [{ op: 'page.remove', pageId }];
}

/* ------------------------------- controller ------------------------------- */

export interface RailCallbacks {
  /** Every gesture leaves through here — the same path an agent op takes. */
  submit(ops: CanvasOp[]): void;
  /** Selection is view state: local, sovereign, never an op. */
  select(pageId: string): void;
}

export interface RailOptions {
  env: CanvasEnv;
  /** The `#rail-list` container. Owned by this controller once passed. */
  list: DomElement;
  callbacks: RailCallbacks;
  resolveAsset?: (ref: string) => string | null;
  deviceLabels?: ReadonlyMap<string, string>;
  thumbWidth?: number;
  /**
   * Row geometry for the drag hit-test. Injected because `DomElement` declares
   * no `getBoundingClientRect` (see `dom.ts`), and because a test must be able
   * to state where the rows are without a layout engine.
   */
  measure?: (el: DomElement, pageId: string, index: number) => RailRowGeometry;
}

/** Rail thumbnails render at this width; the tile scales the artboard down. */
export const RAIL_THUMB_WIDTH = 148;
/** Fallback row pitch when nothing can measure the DOM (headless, or no layout). */
export const RAIL_FALLBACK_ROW_HEIGHT = 96;

interface RailRowEl {
  row: RailRow;
  root: DomElement;
  /** Insert / duplicate / delete, in order. Reached with ArrowRight, never Tab. */
  actions: DomElement[];
}

/**
 * The pages rail.
 *
 * Holds no artifact state of its own — {@link render} is called with the
 * store's artifact and redraws from it, so a tile can never depict a version
 * the board has moved past.
 */
export class RailController {
  private readonly _env: CanvasEnv;
  private readonly _list: DomElement;
  private readonly _callbacks: RailCallbacks;
  private readonly _resolveAsset: (ref: string) => string | null;
  private readonly _deviceLabels: ReadonlyMap<string, string> | undefined;
  private readonly _thumbWidth: number;
  private readonly _measure: (el: DomElement, pageId: string, index: number) => RailRowGeometry;

  private _rows: RailRowEl[] = [];
  private _order: string[] = [];
  private _artifact: WireArtifact | null = null;
  private _drag: RailDrag | null = null;
  /** Roving tabindex: the rail is ONE tab stop, arrows move within it. */
  private _focusIndex = 0;
  /** Set by a keyboard reorder so focus follows the artboard across the rebuild. */
  private _refocusPageId: string | null = null;

  constructor(opts: RailOptions) {
    this._env = opts.env;
    this._list = opts.list;
    this._callbacks = opts.callbacks;
    this._resolveAsset = opts.resolveAsset ?? (() => null);
    this._deviceLabels = opts.deviceLabels;
    this._thumbWidth = opts.thumbWidth ?? RAIL_THUMB_WIDTH;
    this._measure = opts.measure ?? defaultMeasure;

    // A rail is a single-select list of artboards, and saying so is what makes
    // it navigable: a screen reader announces "Artboard 2 of 7, selected", and
    // the roving tabindex below gives it exactly one tab stop rather than one
    // per row plus three per row's actions.
    this._list.setAttribute('role', 'listbox');
    this._list.setAttribute('aria-label', 'Artboards');

    // Move/up/cancel live on the LIST, not the row: a pointer that leaves the
    // row it started on must keep driving the drag, and a pointer that leaves
    // the rail entirely must cancel it rather than leave a stuck session.
    this._list.addEventListener('pointermove', ev => this._onPointerMove(ev));
    this._list.addEventListener('pointerup', ev => this._onPointerUp(ev));
    this._list.addEventListener('pointercancel', () => this._cancelDrag());
    this._list.addEventListener('pointerleave', () => this._cancelDrag());
  }

  /** The rows currently rendered. Test seam and drag geometry source. */
  rows(): RailRow[] { return this._rows.map(r => r.row); }

  /** The live drag, or null. */
  drag(): RailDrag | null { return this._drag; }

  render(artifact: WireArtifact, view: Pick<CanvasViewState, 'focusedPageId'>): void {
    this._artifact = artifact;
    this._drag = null;
    const rows = railRows(artifact, view, { deviceLabels: this._deviceLabels });
    this._order = rows.map(r => r.pageId);
    this._rows = [];
    this._list.replaceChildren();
    // Computed once per render, not once per row: `themeCssVars` sanitizes
    // every token, and a 40-artboard rail would pay for that 40 times.
    const themeVars = themeCssVars(artifact.theme);
    for (const row of rows) {
      const page = artifact.pages[row.index];
      const actions: DomElement[] = [];
      const root = this._renderRow(row, page, themeVars, actions);
      this._rows.push({ row, root, actions });
      this._list.appendChild(root);
    }
    // The tab stop follows the selection across a rebuild, so tabbing into the
    // rail lands on the artboard the board is showing rather than always on the
    // first one — unless a keyboard reorder is mid-gesture, in which case it
    // follows the artboard the human is moving.
    const moving = this._refocusPageId ? rows.findIndex(r => r.pageId === this._refocusPageId) : -1;
    const selected = rows.findIndex(r => r.selected);
    this._focusIndex = moving >= 0 ? moving : (selected >= 0 ? selected : 0);
    this._applyRovingTabIndex();
    if (moving >= 0) { focusElement(this._rows[moving].root); }
    this._refocusPageId = null;
  }

  /** The row index that currently owns the rail's single tab stop. */
  get focusIndex(): number { return this._focusIndex; }

  /** The rail's "+": a blank artboard appended after the current selection. */
  addArtboard(afterPageId?: string): void {
    const artifact = this._artifact;
    if (!artifact) { return; }
    const at = afterPageId ? artifact.pages.findIndex(p => p.id === afterPageId) : -1;
    const anchor = at >= 0 ? artifact.pages[at] : undefined;
    this._callbacks.submit(addPageOps({
      format: anchor?.format ?? artifact.format,
      boardPos: nextBoardPos(artifact.pages, artifact.format),
      index: at >= 0 ? at + 1 : undefined,
      title: `Artboard ${artifact.pages.length + 1}`,
    }));
  }

  /* ------------------------------- rendering ------------------------------- */

  private _renderRow(
    row: RailRow,
    page: ArtifactPage | undefined,
    themeVars: Readonly<Record<string, string>>,
    actionsOut: DomElement[],
  ): DomElement {
    const doc = this._env.doc;
    const root = doc.createElement('div');
    root.className = row.selected ? 'thumb active' : 'thumb';
    root.setAttribute('data-id', row.pageId);
    root.setAttribute('data-index', String(row.index));
    root.setAttribute('role', 'option');
    root.setAttribute('aria-selected', row.selected ? 'true' : 'false');
    root.setAttribute('aria-label', railRowLabel(row));
    root.setAttribute('tabindex', '-1');
    root.addEventListener('keydown', ev => this._onKeyDown(row, ev));
    root.addEventListener('focus', () => { this._focusIndex = row.index; this._applyRovingTabIndex(); });

    const tile = doc.createElement('div');
    tile.className = 'thumb-preview';
    // The preview renderer emits every colour as `var(--theme-color-*)` with no
    // fallback, and those custom properties live on the `.artboard` root the
    // board builds — which a rail tile has no ancestor of. Undefined, the
    // declarations are invalid at computed-value time: `background` falls back
    // to `transparent` (revealing the hardcoded white `--canvas-paper`) and
    // `color` INHERITS the shell's foreground, so in any dark theme the tile
    // was the design's text at #CCCCCC on #FFFFFF (~1.6:1) with every border
    // collapsed to `none`. The tile carries the design's own theme instead.
    for (const [name, value] of Object.entries(themeVars)) { tile.style.setProperty(name, value); }
    const scale = this._thumbWidth / Math.max(1, row.format.width);
    tile.style.setProperty('width', `${row.format.width}px`);
    tile.style.setProperty('height', `${row.format.height}px`);
    tile.style.setProperty('transform', `scale(${scale.toFixed(4)})`);
    tile.style.setProperty('transform-origin', 'top left');
    if (page) {
      // The SAME renderer the board uses for offscreen tiles. `textContent`
      // only, allowlisted tags and styles, `asset://` images resolved through
      // the injected resolver — a rail thumbnail of a prompt-injected artboard
      // is as inert as an offscreen one.
      drawPreview(tile, page.doc, doc, { resolveAsset: this._resolveAsset });
    }
    const frame = doc.createElement('div');
    frame.className = 'thumb-frame';
    frame.style.setProperty('width', `${this._thumbWidth}px`);
    frame.style.setProperty('height', `${Math.round(row.format.height * scale)}px`);
    frame.style.setProperty('overflow', 'hidden');
    frame.appendChild(tile);
    root.appendChild(frame);

    const meta = doc.createElement('div');
    meta.className = 'thumb-meta';
    const title = doc.createElement('span');
    title.className = 'thumb-title';
    title.textContent = row.title;
    meta.appendChild(title);

    const device = doc.createElement('span');
    device.className = 'thumb-badge device';
    device.textContent = row.device.label;
    device.setAttribute('title', row.device.hint);
    meta.appendChild(device);

    if (row.legacy) {
      const badge = doc.createElement('span');
      badge.className = 'thumb-badge legacy';
      badge.textContent = row.legacy.label;
      badge.setAttribute('title', row.legacy.hint);
      meta.appendChild(badge);
    }
    root.appendChild(meta);

    const actions = doc.createElement('div');
    actions.className = 'thumb-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', `Actions for ${row.title}`);
    const add = this._actionButton('add', 'Add', `Insert a blank artboard after ${row.title}`, () => {
      this.addArtboard(row.pageId);
    });
    const duplicate = this._actionButton('duplicate', 'Duplicate', `Duplicate ${row.title}`, () => {
      this._callbacks.submit(duplicatePageOps(row.pageId));
    });
    const remove = this._actionButton('delete', 'Delete', `Delete ${row.title} (Cmd+Z restores it)`, () => {
      this._callbacks.submit(removePageOps(row.pageId));
    });
    for (const [at, button] of [add, duplicate, remove].entries()) {
      button.addEventListener('keydown', ev => this._onActionKeyDown(row, at, ev));
      actions.appendChild(button);
      actionsOut.push(button);
    }
    root.appendChild(actions);

    root.addEventListener('pointerdown', ev => this._onPointerDown(row.pageId, ev));
    root.addEventListener('click', () => {
      // A finished drag must not also select — the pointer-up already consumed
      // the gesture, and re-selecting would fight the reorder's re-render.
      if (this._dragConsumedClick) { this._dragConsumedClick = false; return; }
      this._callbacks.select(row.pageId);
    });
    return root;
  }

  /**
   * A row action.
   *
   * The glyph is CSS's job (`data-icon`), and the WORD lives in a `.btn-label`
   * span a stylesheet can hide once it draws a real icon — so an unstyled shell
   * still shows an operable, readable button rather than an empty square, and
   * the `aria-label` never depends on which of the two is visible. This is the
   * same split `historyUi.ts` uses; the previous `＋ ⧉ ✕` text glyphs rendered
   * differently on every platform and read aloud as punctuation.
   */
  private _actionButton(icon: string, label: string, title: string, onClick: () => void): DomElement {
    const button = this._env.doc.createElement('button');
    button.className = 'thumb-action';
    button.setAttribute('type', 'button');
    // The rail is ONE tab stop. A natively-tabbable <button> per action would
    // make a 20-artboard rail 80 of them, and would put "Delete Artboard 3" in
    // the path of a user who was only tabbing past. They are reached from the
    // focused row with ArrowRight instead — the composite-widget idiom this
    // class's roving tabindex already implements for the rows themselves.
    button.setAttribute('tabindex', '-1');
    button.setAttribute('data-icon', icon);
    button.setAttribute('title', title);
    button.setAttribute('aria-label', title);
    const text = this._env.doc.createElement('span');
    text.className = 'btn-label';
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener('click', ev => {
      stopEvent(ev);
      onClick();
    });
    // Keep a press on an action button from starting a row drag.
    button.addEventListener('pointerdown', ev => stopEvent(ev));
    return button;
  }

  /* -------------------------------- keyboard -------------------------------- */

  /**
   * Arrow to browse, Enter to select, Alt+Arrow to reorder.
   *
   * The reorder path emits the SAME single `page.reorder` the drag does, so a
   * keyboard nudge is one undo step and cannot half-apply either.
   */
  private _onKeyDown(row: RailRow, ev: unknown): void {
    const intent = railKeyIntent(ev as { key?: unknown; altKey?: unknown });
    if (!intent) { return; }
    stopEvent(ev);
    switch (intent.kind) {
      case 'select':
        this._callbacks.select(row.pageId);
        return;
      case 'focus':
        this._focusRow(this._focusIndex + intent.delta);
        return;
      case 'edge':
        this._focusRow(intent.to === 'first' ? 0 : this._rows.length - 1);
        return;
      case 'action':
        // ArrowRight steps INTO the row's actions; ArrowLeft from the row has
        // nowhere further left to go, and is swallowed either way so it cannot
        // reach the board's window handler and nudge the selected element.
        if (intent.delta === 1) { this._focusAction(row.index, 0); }
        return;
      case 'move': {
        const ops = railNudgeOps(this._order, row.pageId, intent.delta);
        if (ops.length === 0) { return; }
        // The reorder round-trips through the host and rebuilds every row, so
        // the element that had focus is GONE by the time the new order lands.
        // Without this, a second Alt+Arrow would do nothing — the classic
        // "keyboard reorder works exactly once" bug.
        this._refocusPageId = row.pageId;
        this._callbacks.submit(ops);
        return;
      }
      default: {
        const never: never = intent;
        void never;
      }
    }
  }

  /**
   * Arrows move within the row's actions; Escape and a left step off the first
   * one return to the row, so focus can always get back to the list.
   */
  private _onActionKeyDown(row: RailRow, at: number, ev: unknown): void {
    const intent = railActionKeyIntent(ev as RailKeyEvent);
    if (!intent) { return; }          // Enter / Space stay the browser's.
    stopEvent(ev);
    switch (intent.kind) {
      case 'sibling': {
        const next = at + intent.delta;
        if (next < 0) { this._focusRow(row.index); return; }
        this._focusAction(row.index, next);
        return;
      }
      case 'row':
        this._focusRow(row.index + intent.delta);
        return;
      case 'edge':
        this._focusRow(intent.to === 'first' ? 0 : this._rows.length - 1);
        return;
      default: {
        const never: never = intent;
        void never;
      }
    }
  }

  /** Focus one of a row's action buttons, clamped to the ones that exist. */
  private _focusAction(rowIndex: number, at: number): void {
    const entry = this._rows[rowIndex];
    if (!entry || entry.actions.length === 0) { return; }
    const next = Math.max(0, Math.min(entry.actions.length - 1, at));
    // The ROW keeps the rail's single tab stop while a descendant has focus:
    // Shift+Tab back into the rail must land on the artboard, not on Delete.
    this._focusIndex = rowIndex;
    this._applyRovingTabIndex();
    focusElement(entry.actions[next]);
  }

  private _focusRow(index: number): void {
    if (this._rows.length === 0) { return; }
    const next = Math.max(0, Math.min(this._rows.length - 1, index));
    this._focusIndex = next;
    this._applyRovingTabIndex();
    focusElement(this._rows[next].root);
  }

  private _applyRovingTabIndex(): void {
    for (let i = 0; i < this._rows.length; i++) {
      this._rows[i].root.setAttribute('tabindex', i === this._focusIndex ? '0' : '-1');
    }
  }

  /* --------------------------------- drag --------------------------------- */

  private _dragConsumedClick = false;

  private _geometry(): RailRowGeometry[] {
    return this._rows.map((entry, i) => this._measure(entry.root, entry.row.pageId, i));
  }

  private _onPointerDown(pageId: string, ev: unknown): void {
    const y = pointerY(ev);
    if (y === null) { return; }
    this._drag = beginRailDrag(this._geometry(), pageId, y);
  }

  private _onPointerMove(ev: unknown): void {
    if (!this._drag) { return; }
    const y = pointerY(ev);
    if (y === null) { return; }
    this._drag = updateRailDrag(this._drag, this._geometry(), y);
    this._paintDropTarget();
  }

  private _onPointerUp(ev: unknown): void {
    const drag = this._drag;
    this._drag = null;
    this._clearDropTarget();
    if (!drag) { return; }
    const y = pointerY(ev);
    const settled = y === null ? drag : updateRailDrag(drag, this._geometry(), y);
    if (!settled.moved) { return; }
    this._dragConsumedClick = true;
    stopEvent(ev);
    const ops = endRailDrag(settled, this._order);
    if (ops.length > 0) { this._callbacks.submit(ops); }
  }

  private _cancelDrag(): void {
    if (!this._drag) { return; }
    this._drag = null;
    this._clearDropTarget();
  }

  private _paintDropTarget(): void {
    const drag = this._drag;
    if (!drag || !drag.moved) { this._clearDropTarget(); return; }
    const order = railDragOrder(drag, this._order);
    for (const entry of this._rows) {
      const at = order.indexOf(entry.row.pageId);
      const dragging = entry.row.pageId === drag.pageId;
      const shifted = at >= 0 && at !== entry.row.index;
      entry.root.className = [
        entry.row.selected ? 'thumb active' : 'thumb',
        dragging ? 'dragging' : '',
        shifted && !dragging ? 'shifted' : '',
      ].filter(Boolean).join(' ');
    }
  }

  private _clearDropTarget(): void {
    for (const entry of this._rows) {
      entry.root.className = entry.row.selected ? 'thumb active' : 'thumb';
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

/** What a screen reader reads for one row: name, device, and the honest badge. */
export function railRowLabel(row: RailRow): string {
  const parts = [`${row.title}, artboard ${row.index + 1}`, row.device.label];
  if (row.legacy) { parts.push(row.legacy.label); }
  return parts.join(', ');
}

interface FocusableLike { focus?: unknown }

/**
 * `DomElement` declares no `focus()` (see `dom.ts`), so the rail reaches it the
 * same way it reaches `getBoundingClientRect`: structurally, where a real DOM
 * and the fake one agree, and as a no-op where they do not.
 */
function focusElement(el: DomElement): void {
  const source = el as unknown as FocusableLike;
  if (typeof source.focus === 'function') { (source.focus as () => void).call(source); }
}

interface PointerLike { clientY?: unknown; pageY?: unknown }

/** The vertical position of a pointer event, or null when it carries none. */
export function pointerY(ev: unknown): number | null {
  if (!ev || typeof ev !== 'object') { return null; }
  const p = ev as PointerLike;
  const value = typeof p.clientY === 'number' ? p.clientY : p.pageY;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface StoppableEvent {
  preventDefault?: unknown;
  stopPropagation?: unknown;
}

function stopEvent(ev: unknown): void {
  if (!ev || typeof ev !== 'object') { return; }
  const e = ev as StoppableEvent;
  if (typeof e.stopPropagation === 'function') { (e.stopPropagation as () => void).call(e); }
  if (typeof e.preventDefault === 'function') { (e.preventDefault as () => void).call(e); }
}

interface RectSource {
  getBoundingClientRect?: unknown;
}

/**
 * Default geometry: the real rect when the host DOM has one, otherwise a
 * uniform pitch. The fallback keeps a drag *coherent* rather than accurate —
 * silently returning zeros would make every drop index 0, which is worse than
 * approximate.
 */
function defaultMeasure(el: DomElement, pageId: string, index: number): RailRowGeometry {
  const source = el as unknown as RectSource;
  if (typeof source.getBoundingClientRect === 'function') {
    const rect = (source.getBoundingClientRect as () => { top?: number; height?: number }).call(source);
    if (rect && typeof rect.top === 'number' && typeof rect.height === 'number') {
      return { pageId, top: rect.top, height: rect.height };
    }
  }
  return { pageId, top: index * RAIL_FALLBACK_ROW_HEIGHT, height: RAIL_FALLBACK_ROW_HEIGHT };
}
