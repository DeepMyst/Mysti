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
 * Plan 22 §4 row 2 - click-to-select any element, drawn by the PARENT.
 *
 * What this replaces: nothing. The canvas had 12 listeners and not one of them
 * was element-level; `harness.js` had no `message` listener at all, and the
 * `data-el` DOM-index paths it wrote were read by exactly zero consumers. There
 * was no selection because there was no element identity to select.
 *
 * ## Why the overlay is drawn in the parent
 *
 * The obvious design - draw a blue outline inside the frame - loses three ways:
 *
 * 1. **It dies on every repaint.** The frame re-renders on every agent patch;
 *    chrome injected into its DOM is either wiped or has to be re-injected in
 *    lockstep with React reconciliation.
 * 2. **It cannot work over a static preview.** Most artboards on a board are
 *    parent-rendered `preview.ts` tiles with no scripts at all (§3.4). Selection
 *    has to look and behave identically on both, or the board has two modes the
 *    user can feel.
 * 3. **It would be page-forgeable.** The frame renders MODEL-AUTHORED content.
 *    Chrome drawn inside it is chrome a prompt-injected page can imitate,
 *    move, or hide.
 *
 * So the frame reports geometry (`rects`, `hit`) and nothing else, and the
 * parent composes those page-space rects with `boardPos` and the board
 * transform ({@link elementScreenRect}) to draw an overlay that survives
 * repaints, works over previews, and lives in a document the page cannot reach.
 *
 * ## Selection is view state (§3.5)
 *
 * Selection is **local and sovereign**: an incoming `canvas/ops` NEVER changes
 * it. The only concession to reality is {@link pruneSelection}, which drops
 * mids that no longer exist - keeping a selection on a deleted node would make
 * the next arrow-nudge address a ghost. It removes; it never adds, never
 * re-targets, and never moves the viewport. That is the direct fix for the
 * behaviour §4 row 9 calls out: today an artifact update force-selects the
 * newest page, so an agent edit steals the human's cursor mid-gesture.
 *
 * Everything above the {@link SelectionOverlay} class is a pure function of
 * data, which is what makes hit resolution, sibling traversal, marquee
 * containment and nudge-op construction testable without a DOM.
 */

import type { CanvasOp } from '../../canvas/CanvasOps';
import { findParent, walk, type DocNode, type Mid } from '../../canvas/doc/DocNode';
import { rectContains, rectsIntersect, type Rect } from './boardMath';
import type { DomDocument, DomElement } from './dom';

/* ------------------------------ the model ------------------------------ */

/**
 * The selected elements.
 *
 * One `pageId` for the whole selection, deliberately: every op in the algebra
 * is page-scoped, ops are grouped into one txn per gesture, and a cross-artboard
 * multi-selection would make "nudge" mean N txns on N pages while looking like
 * one gesture. Clicking into a different artboard therefore REPLACES the
 * selection rather than extending it, even with Shift held.
 */
export interface SelectionState {
  pageId: string | null;
  mids: Mid[];
}

/** Modifier keys, as reported by the frame or read off a parent DOM event. */
export interface HitModifiers {
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

export function emptySelection(): SelectionState {
  return { pageId: null, mids: [] };
}

export function selectOne(pageId: string, mid: Mid): SelectionState {
  return { pageId, mids: [mid] };
}

export function isEmptySelection(sel: SelectionState): boolean {
  return sel.mids.length === 0;
}

export function isSelected(sel: SelectionState, pageId: string, mid: Mid): boolean {
  return sel.pageId === pageId && sel.mids.includes(mid);
}

/** Order-sensitive equality - the anchor (last hit) matters for Tab and nudge. */
export function selectionEquals(a: SelectionState, b: SelectionState): boolean {
  if (a.pageId !== b.pageId || a.mids.length !== b.mids.length) { return false; }
  for (let i = 0; i < a.mids.length; i++) { if (a.mids[i] !== b.mids[i]) { return false; } }
  return true;
}

/** The element a keyboard gesture acts from: the most recently hit mid. */
export function selectionAnchor(sel: SelectionState): Mid | null {
  return sel.mids.length > 0 ? sel.mids[sel.mids.length - 1] : null;
}

/**
 * Fold a click into the selection.
 *
 * Plain click replaces. Shift (or Cmd/Ctrl, which is what a Mac user's hand
 * reaches for) TOGGLES, so a shift-click on an already-selected element
 * deselects it - the behaviour every design tool has, and the reason toggle is
 * not "add".
 */
export function applyHit(
  sel: SelectionState,
  pageId: string,
  mid: Mid,
  mods: HitModifiers = {},
): SelectionState {
  const additive = mods.shift === true || mods.meta === true || mods.ctrl === true;
  if (!additive || sel.pageId !== pageId) { return selectOne(pageId, mid); }
  if (sel.mids.includes(mid)) {
    const mids = sel.mids.filter(m => m !== mid);
    return mids.length > 0 ? { pageId, mids } : emptySelection();
  }
  return { pageId, mids: [...sel.mids, mid] };
}

/** Replace the selection wholesale, de-duplicated and order-preserving. */
export function setSelection(pageId: string, mids: readonly Mid[]): SelectionState {
  const out: Mid[] = [];
  for (const mid of mids) { if (typeof mid === 'string' && mid && !out.includes(mid)) { out.push(mid); } }
  return out.length > 0 ? { pageId, mids: out } : emptySelection();
}

/**
 * Drop what no longer exists after an incoming edit.
 *
 * The ONLY way an agent op may touch selection. It cannot select, cannot
 * re-target, cannot reorder, and cannot change `pageId` to anything but `null`.
 */
export function pruneSelection(
  sel: SelectionState,
  pages: ReadonlyArray<{ id: string; doc: DocNode }>,
): SelectionState {
  if (!sel.pageId || sel.mids.length === 0) { return sel; }
  const page = pages.find(p => p.id === sel.pageId);
  if (!page) { return emptySelection(); }
  const alive = new Set<Mid>();
  for (const node of walk(page.doc)) { alive.add(node.mid); }
  const mids = sel.mids.filter(m => alive.has(m));
  if (mids.length === sel.mids.length) { return sel; }
  return mids.length > 0 ? { pageId: sel.pageId, mids } : emptySelection();
}

/* --------------------------- traversal / Tab --------------------------- */

/**
 * Every selectable mid in document order.
 *
 * The ROOT is excluded on purpose. It is the artboard itself: selecting it
 * would make a marquee over the whole board select "everything and also the
 * thing that contains everything", and an arrow-nudge on it would translate the
 * entire screen instead of moving an element.
 */
export function selectableMids(doc: DocNode): Mid[] {
  const out: Mid[] = [];
  for (const node of walk(doc)) { if (node.mid !== doc.mid) { out.push(node.mid); } }
  return out;
}

/** The siblings of `mid`, in order, including `mid` itself. */
export function siblingMids(doc: DocNode, mid: Mid): Mid[] {
  const found = findParent(doc, mid);
  if (!found) { return []; }
  const list = found.slot
    ? (found.parent.slots?.[found.slot] ?? [])
    : (found.parent.children ?? []);
  return list.map(n => n.mid);
}

/**
 * Tab / Shift-Tab: the next sibling, wrapping within the parent.
 *
 * Siblings rather than document order because that is what "walk this row of
 * cards" means to a designer; descending into children is what click and the
 * layer tree are for. With nothing selected, Tab takes the first selectable
 * node so the keyboard is reachable without touching the mouse.
 */
export function tabTarget(doc: DocNode, current: Mid | null, dir: 1 | -1): Mid | null {
  const all = selectableMids(doc);
  if (all.length === 0) { return null; }
  if (!current) { return dir === 1 ? all[0] : all[all.length - 1]; }
  const siblings = siblingMids(doc, current);
  const pool = siblings.length > 1 ? siblings : all;
  const index = pool.indexOf(current);
  if (index < 0) { return dir === 1 ? all[0] : all[all.length - 1]; }
  const next = (index + dir + pool.length) % pool.length;
  return pool[next];
}

/* -------------------------------- marquee -------------------------------- */

export interface MarqueeCandidate { mid: Mid; rect: Rect }

/**
 * Which elements a marquee caught.
 *
 * `'contain'` (the default) requires the box to fully enclose the element -
 * the Figma/Sketch rule, and the only one that behaves sanely when elements
 * nest: a loose intersect test on a card would also catch the section, the
 * screen padding wrapper and every ancestor the drag happened to clip.
 */
export function marqueeHits(
  candidates: readonly MarqueeCandidate[],
  marquee: Rect,
  mode: 'contain' | 'intersect' = 'contain',
): Mid[] {
  const test = mode === 'contain' ? rectContains : rectsIntersect;
  const out: Mid[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.mid !== 'string' || !candidate.rect) { continue; }
    if (test(marquee, candidate.rect) && !out.includes(candidate.mid)) { out.push(candidate.mid); }
  }
  return out;
}

/** A drag under this many px is a click that wobbled, not a marquee. */
export const MARQUEE_MIN_DRAG_PX = 3;

export function isMarqueeGesture(rect: Rect): boolean {
  return rect.w >= MARQUEE_MIN_DRAG_PX || rect.h >= MARQUEE_MIN_DRAG_PX;
}

/* ------------------------------ arrow nudge ------------------------------ */

export const NUDGE_STEP_PX = 1;
export const NUDGE_STEP_LARGE_PX = 10;

/** An arrow key to a world-space delta, or `null` for any other key. */
export function arrowDelta(key: string, large = false): { dx: number; dy: number } | null {
  const step = large ? NUDGE_STEP_LARGE_PX : NUDGE_STEP_PX;
  switch (key) {
    case 'ArrowLeft': return { dx: -step, dy: 0 };
    case 'ArrowRight': return { dx: step, dy: 0 };
    case 'ArrowUp': return { dx: 0, dy: -step };
    case 'ArrowDown': return { dx: 0, dy: step };
    default: return null;
  }
}

const PX_RE = /^\s*(-?\d+(?:\.\d+)?)px\s*$/;
/** A leading `translate(<x>px, <y>px)`, capturing any transform that follows. */
const TRANSLATE_RE = /^\s*translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)\s*(.*)$/;

function px(value: string | undefined, fallback = 0): number {
  if (typeof value !== 'string') { return fallback; }
  const m = PX_RE.exec(value);
  if (!m) { return fallback; }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The style patch that moves a node by (dx, dy).
 *
 * Two cases, because a design doc is mostly flow layout:
 *
 * - **Absolutely positioned** (`position: absolute|fixed` with a px `left`/
 *   `top`): adjust `left`/`top`. That is what the author meant by placing it.
 * - **Everything else**: compose a `translate()`, which moves the element
 *   without reflowing its siblings. Nudging a flex child by rewriting `margin`
 *   would shove the entire row - visually identical for one element, wrong for
 *   every element next to it.
 *
 * An existing LEADING translate is accumulated (so 10 nudges are one
 * declaration, not ten nested ones) and any further transform functions are
 * preserved after it - a node with `rotate(3deg)` keeps its rotation, and the
 * translate still composes correctly because CSS applies the list left to right.
 */
export function nudgeStyle(
  style: Readonly<Record<string, string>> | undefined,
  dx: number,
  dy: number,
): Record<string, string | null> {
  const position = style?.position;
  if (position === 'absolute' || position === 'fixed') {
    return {
      position,
      left: `${round2(px(style?.left) + dx)}px`,
      top: `${round2(px(style?.top) + dy)}px`,
    };
  }
  const existing = style?.transform;
  let baseX = 0, baseY = 0, rest = '';
  if (typeof existing === 'string' && existing.trim().length > 0) {
    const m = TRANSLATE_RE.exec(existing);
    if (m) {
      baseX = Number(m[1]); baseY = Number(m[2]); rest = m[3].trim();
      if (!Number.isFinite(baseX)) { baseX = 0; }
      if (!Number.isFinite(baseY)) { baseY = 0; }
    } else {
      rest = existing.trim();
    }
  }
  const translate = `translate(${round2(baseX + dx)}px, ${round2(baseY + dy)}px)`;
  return { transform: rest ? `${translate} ${rest}` : translate };
}

/**
 * Arrow-nudge as ops.
 *
 * These are `el.setStyle` records - the IDENTICAL op an agent's `set_style`
 * tool call produces and the identical path through `CanvasOpExecutor.submit`.
 * The human gesture gets no private channel, which is the property §2.3 exists
 * to protect and the reason a nudge is undoable by the same Cmd+Z as an agent
 * restyle.
 *
 * Nodes that vanished (an agent deleted one mid-gesture) and the artboard root
 * are skipped rather than submitted as ops that would be rejected downstream.
 */
export function nudgeOps(
  pageId: string,
  doc: DocNode,
  mids: readonly Mid[],
  dx: number,
  dy: number,
): CanvasOp[] {
  if (!pageId || (dx === 0 && dy === 0)) { return []; }
  const byMid = new Map<Mid, DocNode>();
  for (const node of walk(doc)) { byMid.set(node.mid, node); }
  const ops: CanvasOp[] = [];
  for (const mid of mids) {
    if (mid === doc.mid) { continue; }
    const node = byMid.get(mid);
    if (!node) { continue; }
    ops.push({ op: 'el.setStyle', pageId, mid, style: nudgeStyle(node.style, dx, dy) });
  }
  return ops;
}

/* ------------------------------ the overlay ------------------------------ */

export interface OverlayBox {
  mid: Mid;
  /** SCREEN-space rect, already through {@link elementScreenRect}. */
  rect: Rect;
  /** The anchor - drawn with handles; the rest get a plain outline. */
  primary?: boolean;
}

export interface SelectionOverlayOptions {
  doc: DomDocument;
  /** An untransformed layer sitting over the world, `pointer-events: none`. */
  host: DomElement;
  boxClass?: string;
  marqueeClass?: string;
}

/**
 * Draws the selection boxes and the marquee.
 *
 * It lives OUTSIDE the transformed world on purpose: a 1px outline scaled by a
 * 0.2x board transform is a 0.2px outline, i.e. invisible at exactly the zoom
 * level where you most need to see what is selected. Rects arrive already in
 * screen space, so the outline is always 1 real pixel.
 *
 * Elements are POOLED. Selection redraws on every pan frame, every wheel notch
 * and every `rects` report from a live frame; rebuilding N elements 60 times a
 * second is how a canvas starts dropping frames while "doing nothing".
 */
export class SelectionOverlay {
  private readonly _doc: DomDocument;
  private readonly _host: DomElement;
  private readonly _boxClass: string;
  private readonly _marqueeClass: string;
  private readonly _pool: DomElement[] = [];
  private _marquee: DomElement | null = null;
  private _visible = 0;

  constructor(opts: SelectionOverlayOptions) {
    this._doc = opts.doc;
    this._host = opts.host;
    this._boxClass = opts.boxClass ?? 'sel-box';
    this._marqueeClass = opts.marqueeClass ?? 'sel-marquee';
  }

  /** Boxes currently on screen. The pooling assertion in the tests reads this. */
  get visibleCount(): number { return this._visible; }

  /** Elements ever created. Must not grow once the pool is warm. */
  get poolSize(): number { return this._pool.length; }

  render(boxes: readonly OverlayBox[]): void {
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const el = this._at(i);
      el.hidden = false;
      el.className = box.primary ? `${this._boxClass} primary` : this._boxClass;
      // `data-mid` is diagnostic only - the overlay never hit-tests off it, so
      // a model-authored mid cannot influence what a click does.
      el.setAttribute('data-mid', box.mid);
      place(el, box.rect);
    }
    for (let i = boxes.length; i < this._pool.length; i++) {
      this._pool[i].hidden = true;
      this._pool[i].removeAttribute('data-mid');
    }
    this._visible = boxes.length;
  }

  setMarquee(rect: Rect | null): void {
    if (!rect) {
      if (this._marquee) { this._marquee.hidden = true; }
      return;
    }
    if (!this._marquee) {
      const el = this._doc.createElement('div');
      el.className = this._marqueeClass;
      this._host.appendChild(el);
      this._marquee = el;
    }
    this._marquee.hidden = false;
    place(this._marquee, rect);
  }

  clear(): void {
    this.render([]);
    this.setMarquee(null);
  }

  dispose(): void {
    for (const el of this._pool) { el.remove(); }
    this._pool.length = 0;
    this._marquee?.remove();
    this._marquee = null;
    this._visible = 0;
  }

  private _at(index: number): DomElement {
    const existing = this._pool[index];
    if (existing) { return existing; }
    const el = this._doc.createElement('div');
    el.className = this._boxClass;
    this._host.appendChild(el);
    this._pool[index] = el;
    return el;
  }
}

function place(el: DomElement, rect: Rect): void {
  el.style.setProperty('left', `${Math.round(rect.x)}px`);
  el.style.setProperty('top', `${Math.round(rect.y)}px`);
  el.style.setProperty('width', `${Math.max(0, Math.round(rect.w))}px`);
  el.style.setProperty('height', `${Math.max(0, Math.round(rect.h))}px`);
}
