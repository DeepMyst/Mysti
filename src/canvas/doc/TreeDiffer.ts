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
 * Plan 22 §3.5 — whole-page rewrites, and the PIN mechanism.
 *
 * A coarse write (`write_page`, `page.setDoc`, a model handing back a whole
 * artboard) is the natural thing for a language model to produce and the worst
 * thing for the canvas to store: it clobbers the page, it is one undo step, it
 * has no per-element identity, and every human tweak inside it is silently
 * reverted. {@link diffDocs} is the translator that makes a coarse write land
 * as the *fine* ops a human's own hands would have produced — individually
 * undoable, individually pinnable, individually stale-checkable.
 *
 * ## Pipeline position
 *
 * ```
 *   jsx ──PageCompiler──▶ DocNodeInput ──Reconciler──▶ DocNode (mids resolved)
 *                                                          │
 *                              prev (the live doc) ────────┼──▶ diffDocs ──▶ CanvasOp[]
 *                                                                              │
 *                                                                    CanvasOpExecutor / DocPatch
 * ```
 *
 * `diffDocs` assumes **both trees are already reconciled** — that is, a node in
 * `next` carrying a mid that also exists in `prev` really is that node. It does
 * not do fuzzy matching; `Reconciler.ts` owns that. When the caller has the
 * pre-reconcile mids the model *claimed*, it passes them as
 * {@link DiffDocsOptions.claimedMids} and any that no longer exist come back as
 * `node-vanished` dropped intents.
 *
 * ## The pin rule (§3.5 rule 2) — the point of this file
 *
 * With `respectPins`, a cell carrying a `PinRecord` is **excluded from the diff
 * entirely**. Not diffed and reverted, not diffed and rejected downstream:
 * never emitted as a candidate. That is strictly stronger than rejection —
 * there is no window in which the human's value is not the value, and no way
 * for a later `force` path to resurrect an op that was never built. Whatever
 * the incoming tree wanted for that cell is reported in `dropped` so the UI can
 * show a dismissible card and the model can be told what was refused.
 *
 * Pins are read from `prev` only. `next` is a rewrite proposal — a model that
 * writes `pins` into its tree gains nothing, and payloads emitted from here
 * carry neither `pins` nor `by` (they are not part of {@link DocNodeInput}).
 *
 * Structure is deliberately **not** pin-governed: `opCells` in `CanvasOps.ts`
 * returns `null` for insert/remove/move/replace precisely because subtree locks,
 * not pins, are the mechanism for "don't restructure this". A pinned node can
 * therefore still be removed by a rewrite. What this file does guarantee is
 * that a pinned *value* is never overwritten in place, and that an `el.replace`
 * forced by a tag change carries the human's pinned values forward into the
 * replacement rather than reverting them.
 *
 * ## Minimality
 *
 * - a text change is `el.setText`, never `el.replace`;
 * - every style change on one node is ONE `el.setStyle`;
 * - a relocated node is `el.move`, never remove + insert (identity, pins and
 *   comments hang off the mid, so remove + insert destroys them);
 * - reordering emits the minimum number of moves (longest increasing
 *   subsequence of the surviving siblings is left untouched);
 * - removing a container emits ONE `el.remove`, not one per descendant — though
 *   the sweep still descends past it, because a child that was reparented
 *   elsewhere carries its own subtree beyond the reach of that single op;
 * - `el.replace` is the fallback of last resort — a changed `tag`, or a node
 *   changing between "text leaf" and "container", which the cell ops cannot
 *   express (`DocPatch._setText` rejects a container, and text and children are
 *   mutually exclusive by construction).
 *
 * ## Ordering contract
 *
 * The returned ops are a SEQUENCE and must be applied in order. Two orderings
 * are load-bearing:
 *
 * 1. `el.remove` ops come **last**, so a node that survives underneath a
 *    removed container is moved out first and keeps its identity and its pins
 *    instead of being destroyed and re-created.
 * 2. Within a sibling list, ops are emitted right-to-left, so the `before`
 *    anchor of every insert/move is a sibling already sitting in its final
 *    position.
 *
 * Cycles are impossible by construction: nodes are visited in `next` pre-order,
 * so a move's destination parent has already been placed, and in `next` the
 * destination is an ancestor of the moved node — never a descendant.
 *
 * Pure module: no vscode, no fs, no I/O, no clock. The only nondeterminism is
 * {@link mintMid}, reached only for malformed input (duplicate or missing mids)
 * and injectable via {@link DiffDocsOptions.mintMid} for tests.
 */

import type { CanvasOp } from '../CanvasOps';
import type { DocNode, DocNodeInput, JsonValue, Mid, PinCell } from './DocNode';
import { TEXT_CELL, isPinned, mintMid, pinnedCells, propCell, putOwn, styleCell } from './DocNode';
import { isEmittablePropName } from './DocEmitter';

/**
 * Why an incoming intent never became an op.
 *
 * Deliberately a SUBSET of `CanvasDroppedIntent['reason']` in
 * `CanvasToolDispatch`, which ships these straight to the model — widening this
 * union past that one is a type error there, not a silent mismatch.
 */
export type DroppedReason = 'pinned-by-human' | 'node-vanished' | 'refused';

/**
 * One thing the incoming tree wanted that the diff refused to emit.
 *
 * Rendered as a dismissible card on the artboard and folded into the agent's
 * next turn, so "your change was ignored" is never silent.
 */
export interface DroppedIntent {
  /** The node the intent targeted. */
  mid: Mid;
  /** `'text' | 'style.<prop>' | 'props.<name>'`. Absent for whole-node intents. */
  cell?: PinCell;
  /** What the incoming tree wanted. `null` means "clear it". */
  wanted?: JsonValue;
  reason: DroppedReason;
}

export interface DiffDocsOptions {
  /** Stamped onto every element op — the artboard being rewritten. */
  pageId: string;
  /**
   * `true` for agent-authored writes: cells a human owns are excluded from the
   * diff entirely. Defaults to `false` (a human's own rewrite owns everything).
   */
  respectPins?: boolean;
  /**
   * Mids the incoming tree *claimed* before reconciliation — i.e. ids a model
   * echoed back. Any that no longer exist in `prev` are reported as
   * `node-vanished`. Optional: without it the differ cannot tell a genuinely
   * new node from an intent aimed at a deleted one, and reports neither.
   */
  claimedMids?: Iterable<Mid>;
  /** Injectable id source. Tests pass a counter; production uses {@link mintMid}. */
  mintMid?: () => Mid;
}

export interface DiffDocsResult {
  /** Apply in order. Empty when the trees already agree. */
  ops: CanvasOp[];
  dropped: DroppedIntent[];
}

/**
 * Depth beyond which the differ stops descending. A UI tree is never close to
 * this; a malformed or hostile one would otherwise blow the stack. Deeper
 * structure is left untouched rather than mis-diffed.
 */
const MAX_DEPTH = 512;

interface NodeLoc {
  node: DocNode;
  parentMid: Mid | null;
  slot?: string;
}

interface Deferred {
  parentMid: Mid;
  slot?: string;
  before: Mid | 'end';
  prevNode: DocNode;
  nextNode: DocNode;
}

interface DiffCtx {
  pageId: string;
  respectPins: boolean;
  mint: () => Mid;
  prev: Map<Mid, NodeLoc>;
  next: Map<Mid, NodeLoc>;
  /** `next` nodes with a duplicate/absent mid, or reached through a cycle. */
  unaddressable: Set<DocNode>;
  /** prev mids whose node has been destroyed by an `el.replace` already emitted. */
  destroyed: Set<Mid>;
  /** mids handed out by {@link _freshMid} in this run. */
  minted: Set<Mid>;
  aligned: Set<Mid>;
  ops: CanvasOp[];
  dropped: DroppedIntent[];
}

/* ────────────────────────────── entry point ────────────────────────────── */

/**
 * The minimal `CanvasOp[]` that turns `prev` into `next`, minus anything a
 * human owns.
 *
 * Both trees must already be reconciled: a shared mid means "the same element".
 */
export function diffDocs(prev: DocNode, next: DocNode, opts: DiffDocsOptions): DiffDocsResult {
  const scanned = _scanNext(next);
  const ctx: DiffCtx = {
    pageId: opts.pageId,
    respectPins: opts.respectPins === true,
    mint: opts.mintMid ?? (() => mintMid()),
    prev: _indexPrev(prev),
    next: scanned.index,
    unaddressable: scanned.unaddressable,
    destroyed: new Set<Mid>(),
    minted: new Set<Mid>(),
    aligned: new Set<Mid>(),
    ops: [],
    dropped: [],
  };

  // Intents aimed at nodes that are simply gone. Reported before anything else
  // so the caller can show them even when the rest of the write applies fine.
  const claimSeen = new Set<Mid>();
  for (const mid of opts.claimedMids ?? []) {
    if (typeof mid !== 'string' || mid.length === 0 || claimSeen.has(mid)) { continue; }
    claimSeen.add(mid);
    if (!ctx.prev.has(mid)) { ctx.dropped.push({ mid, reason: 'node-vanished' }); }
  }

  if (ctx.unaddressable.has(next)) {
    // A root we cannot address at all (no mid). Nothing finer is possible.
    const built = _buildPayload(ctx, next, 1);
    ctx.ops.push({ op: 'el.replace', pageId: ctx.pageId, mid: prev.mid, node: built.input });
    return { ops: ctx.ops, dropped: ctx.dropped };
  }

  // The artboard root is identity-stable BY DEFINITION — it is the page. A
  // model that forgets to echo the root mid must not clobber the whole page, so
  // the root is aliased onto prev's identity instead of being replaced.
  if (prev.mid !== next.mid) {
    ctx.next.delete(next.mid);
    ctx.next.set(prev.mid, { node: next, parentMid: null });
  }

  _alignNode(ctx, prev, next, 0);
  _collectRemovals(ctx, prev, false, new Set<DocNode>(), 0);

  return { ops: ctx.ops, dropped: ctx.dropped };
}

/* ─────────────────────────────── indexing ─────────────────────────────── */

function _indexPrev(root: DocNode): Map<Mid, NodeLoc> {
  const index = new Map<Mid, NodeLoc>();
  const seen = new Set<DocNode>();
  const visit = (n: DocNode, parentMid: Mid | null, slot: string | undefined, depth: number): void => {
    if (seen.has(n) || depth >= MAX_DEPTH) { return; }
    seen.add(n);
    if (typeof n.mid === 'string' && n.mid.length > 0 && !index.has(n.mid)) {
      index.set(n.mid, slot === undefined ? { node: n, parentMid } : { node: n, parentMid, slot });
    }
    for (const c of n.children ?? []) { visit(c, n.mid, undefined, depth + 1); }
    for (const key of Object.keys(n.slots ?? {}).sort()) {
      for (const c of _ownList(n.slots, key)) { visit(c, n.mid, key, depth + 1); }
    }
  };
  visit(root, null, undefined, 0);
  return index;
}

/**
 * Index `next`, and decide which of its nodes are addressable at all.
 *
 * A node is unaddressable when its mid is missing, when an earlier node already
 * claimed that mid, or when the object is reached twice (an alias or a cycle).
 * Unaddressable nodes — and everything under them — are treated as brand new
 * content with freshly minted ids, so a malformed tree degrades into inserts
 * rather than into ops that address the wrong element.
 */
function _scanNext(root: DocNode): { index: Map<Mid, NodeLoc>; unaddressable: Set<DocNode> } {
  const index = new Map<Mid, NodeLoc>();
  const unaddressable = new Set<DocNode>();
  const seen = new Set<DocNode>();

  const visit = (n: DocNode, parentMid: Mid | null, slot: string | undefined, poisoned: boolean, depth: number): void => {
    const aliased = seen.has(n);
    seen.add(n);
    const midUsable = typeof n.mid === 'string' && n.mid.length > 0 && !index.has(n.mid);
    const bad = poisoned || aliased || !midUsable;
    if (bad) {
      unaddressable.add(n);
    } else {
      index.set(n.mid, slot === undefined ? { node: n, parentMid } : { node: n, parentMid, slot });
    }
    if (aliased || depth >= MAX_DEPTH) { return; }
    for (const c of n.children ?? []) { visit(c, n.mid, undefined, bad, depth + 1); }
    for (const key of Object.keys(n.slots ?? {}).sort()) {
      for (const c of _ownList(n.slots, key)) { visit(c, n.mid, key, bad, depth + 1); }
    }
  };
  visit(root, null, undefined, false, 0);

  // An aliased object is indexed by its first visit and condemned by its
  // second. Drop the entry so the prev counterpart is honestly removed rather
  // than left orphaned by ops that re-mint both occurrences.
  for (const n of unaddressable) {
    if (typeof n.mid === 'string' && index.get(n.mid)?.node === n) { index.delete(n.mid); }
  }
  return { index, unaddressable };
}

/* ─────────────────────────────── alignment ─────────────────────────────── */

function _alive(ctx: DiffCtx, mid: Mid): boolean {
  return ctx.prev.has(mid) && !ctx.destroyed.has(mid);
}

function _addressable(ctx: DiffCtx, n: DocNode): boolean {
  return !ctx.unaddressable.has(n);
}

/** `pn` and `nn` are the same element. Emit what it takes to make them agree. */
function _alignNode(ctx: DiffCtx, pn: DocNode, nn: DocNode, depth: number): void {
  if (ctx.aligned.has(pn.mid)) { return; }
  ctx.aligned.add(pn.mid);

  if (pn.tag !== nn.tag || _natureChanged(pn, nn)) {
    _replaceNode(ctx, pn, nn, depth);
    return;
  }

  _diffCells(ctx, pn, nn);

  if (depth >= MAX_DEPTH) { return; }
  _alignChildren(ctx, pn, undefined, pn.children ?? [], nn.children ?? [], depth);
  const slots = new Set<string>([...Object.keys(pn.slots ?? {}), ...Object.keys(nn.slots ?? {})]);
  for (const slot of [...slots].sort()) {
    _alignChildren(ctx, pn, slot, _ownList(pn.slots, slot), _ownList(nn.slots, slot), depth);
  }
}

/**
 * True when the node crosses the text-leaf / container line, which the cell ops
 * cannot express: `el.setText` refuses a node with children, and text and
 * children are mutually exclusive by construction.
 *
 * **`text: ''` and absent `text` are ONE state here**, exactly as they are in
 * {@link _diffCells}'s `?? ''`. They have to be: `DocEmitter.renderChildren`
 * refuses to print an empty text child and `PageCompiler` refuses to read one
 * back, so `compile(emit(doc))` turns `text: ''` into no text at all. Comparing
 * PRESENCE here while `_diffCells` compared emptiness made a byte-identical echo
 * of `read_page` look like a nature change — `el.replace` on a node nobody
 * touched, re-materialized from a {@link DocNodeInput} that has no `pins` field,
 * so the human's per-cell ownership was deleted with an empty `dropped`.
 *
 * Losing text is NOT a crossing: `el.setText('')` lands the same state the
 * emitter and the compiler both round-trip to, and it keeps the node's identity,
 * its pins and its comments. Gaining children still is — but that guard has to
 * stay on presence, because `DocPatch` refuses `el.insert` under any node whose
 * `text` cell exists at all, `''` included.
 */
function _natureChanged(pn: DocNode, nn: DocNode): boolean {
  const nText = (nn.text ?? '') !== '';
  const pKids = (pn.children?.length ?? 0) > 0;
  const nKids = (nn.children?.length ?? 0) > 0;
  if (nText && pKids) { return true; }
  if (pn.text !== undefined && nKids) { return true; }
  if (nText && nKids) { return true; }
  return false;
}

function _replaceNode(ctx: DiffCtx, pn: DocNode, nn: DocNode, depth: number): void {
  // Everything under the target is leaving; the target's own address survives
  // (DocPatch forces the payload root onto `op.mid`).
  _markDestroyed(ctx, pn, false, new Set<DocNode>(), 0);
  // The replacement inherits the address it replaced — selection, comments and
  // anchors all hang off that mid, so a content swap must not move it. The
  // payload builder carries the human's pinned values across for this node AND
  // for every descendant it re-creates under a preserved mid.
  const built = _buildPayload(ctx, nn, depth + 1, pn.mid);
  ctx.ops.push({ op: 'el.replace', pageId: ctx.pageId, mid: pn.mid, node: built.input });
  _flushDeferred(ctx, built.deferred, depth);
}

/**
 * Mark everything an `el.replace` is about to destroy.
 *
 * A descendant that has ALREADY been aligned got there through a different
 * parent in `next` — it was moved out before the replace fires, and its own
 * subtree went with it. Descending into it would condemn nodes that are still
 * very much alive, and the payload builder would then inline a mid the document
 * still holds (which the executor re-mints, silently duplicating the node).
 */
function _markDestroyed(ctx: DiffCtx, n: DocNode, includeSelf: boolean, seen: Set<DocNode>, depth: number): void {
  if (seen.has(n) || depth >= MAX_DEPTH) { return; }
  seen.add(n);
  if (includeSelf) {
    if (ctx.aligned.has(n.mid)) { return; }   // escaped, with everything under it
    ctx.destroyed.add(n.mid);
  }
  for (const c of n.children ?? []) { _markDestroyed(ctx, c, true, seen, depth + 1); }
  for (const list of Object.values(n.slots ?? {})) {
    for (const c of list) { _markDestroyed(ctx, c, true, seen, depth + 1); }
  }
}

/* ───────────────────────────────── cells ───────────────────────────────── */

function _drop(ctx: DiffCtx, mid: Mid, cell: PinCell, wanted: JsonValue): void {
  ctx.dropped.push({ mid, cell, wanted, reason: 'pinned-by-human' });
}

function _diffCells(ctx: DiffCtx, pn: DocNode, nn: DocNode): void {
  const mid = pn.mid;
  const guard = (cell: PinCell): boolean => ctx.respectPins && isPinned(pn, cell);

  // text
  const pText = pn.text ?? '';
  const nText = nn.text ?? '';
  if (pText !== nText) {
    if (guard(TEXT_CELL)) {
      _drop(ctx, mid, TEXT_CELL, nText);
    } else {
      ctx.ops.push({ op: 'el.setText', pageId: ctx.pageId, mid, text: nText });
    }
  }

  // style — one op for the whole node, `null` meaning "remove this property"
  const patch: Record<string, string | null> = {};
  let patched = false;
  for (const key of _sortedKeys(pn.style, nn.style)) {
    const before = _own(pn.style, key);
    const after = _own(nn.style, key);
    if (before === after) { continue; }
    const cell = styleCell(key);
    if (guard(cell)) { _drop(ctx, mid, cell, after ?? null); continue; }
    putOwn(patch, key, after ?? null);
    patched = true;
  }
  if (patched) { ctx.ops.push({ op: 'el.setStyle', pageId: ctx.pageId, mid, style: patch }); }

  // props — the op algebra is per-name, so one op each
  for (const name of _sortedKeys(pn.props, nn.props)) {
    const before = _own(pn.props, name);
    const after = _own(nn.props, name);
    if (_jsonEqual(before, after, 0)) { continue; }
    const cell = propCell(name);
    const value = after === undefined ? null : _cloneJson(after, 0);
    if (guard(cell)) { _drop(ctx, mid, cell, value); continue; }
    // A prop whose name is not a printable JSX attribute never appeared in the
    // `read_page` output this rewrite was written against ({@link
    // isEmittablePropName}), so its ABSENCE from the incoming tree is not an
    // instruction to delete it — the writer was never shown it. Emitting
    // `el.setProp … null` here made deletion the default for everything the
    // emitter cannot print, silently, on a verbatim echo. A named value is still
    // honored: absence is not intent, a present value is.
    if (after === undefined && !isEmittablePropName(name)) {
      ctx.dropped.push({ mid, cell, wanted: null, reason: 'refused' });
      continue;
    }
    ctx.ops.push({ op: 'el.setProp', pageId: ctx.pageId, mid, name, value });
  }
}

/**
 * Carry a human's pinned VALUES into a payload that keeps their node's identity.
 *
 * Reached two ways, and it must be both or the guarantee has a hole:
 *  - a tag / nature change on the node itself (`_replaceNode`);
 *  - a node RE-CREATED inside someone else's payload under its own mid, because
 *    an ancestor was replaced out from under it (`_buildPayload`). Identity is
 *    preserved there too, so reverting the cell would be exactly the silent
 *    clobber the pin exists to prevent.
 *
 * A structural intent is never refused — structure is lock-governed, not
 * pin-governed — so the incoming tree's wishes for these cells are reported as
 * dropped rather than applied.
 *
 * The pin RECORDS themselves cannot ride along: `DocNodeInput` has no `pins`
 * field by design. Re-pinning after an identity-preserving replace is the
 * executor's call, which is the layer that knows the author.
 */
function _preservePins(ctx: DiffCtx, pn: DocNode, nn: DocNode, input: DocNodeInput): void {
  for (const cell of pinnedCells(pn)) {
    if (cell === TEXT_CELL) {
      // A leaf becoming a container destroys the text CELL, not just its value:
      // `text` and `children` are mutually exclusive, and `DocPatch` rejects a
      // payload carrying both outright. There is nothing left to preserve and
      // nothing was refused — the structural intent won, as it is meant to.
      if ((nn.children?.length ?? 0) > 0) { continue; }
      const keep = pn.text;
      if ((nn.text ?? '') !== (keep ?? '')) { _drop(ctx, pn.mid, cell, nn.text ?? ''); }
      if (keep === undefined) { delete input.text; } else { input.text = keep; }
      continue;
    }
    if (cell.startsWith('style.')) {
      const key = cell.slice('style.'.length);
      if (key.length === 0) { continue; }
      const keep = _own(pn.style, key);
      const after = _own(nn.style, key);
      if (keep !== after) { _drop(ctx, pn.mid, cell, after ?? null); }
      if (keep === undefined) {
        if (input.style) { delete input.style[key]; }
      } else {
        input.style = { ...(input.style ?? {}) };
        putOwn(input.style, key, keep);
      }
      continue;
    }
    if (cell.startsWith('props.')) {
      const name = cell.slice('props.'.length);
      if (name.length === 0) { continue; }
      const keep = _own(pn.props, name);
      const after = _own(nn.props, name);
      if (!_jsonEqual(keep, after, 0)) { _drop(ctx, pn.mid, cell, after === undefined ? null : _cloneJson(after, 0)); }
      if (keep === undefined) {
        if (input.props) { delete input.props[name]; }
      } else {
        input.props = { ...(input.props ?? {}) };
        putOwn(input.props, name, _cloneJson(keep, 0));
      }
    }
  }
}

/* ──────────────────────────────── children ──────────────────────────────── */

function _alignChildren(
  ctx: DiffCtx,
  pn: DocNode,
  slot: string | undefined,
  prevList: DocNode[],
  nextList: DocNode[],
  depth: number,
): void {
  const parentMid = pn.mid;

  // Nodes that live in this list on BOTH sides. Only these can be left alone;
  // everything else is an insert, an arrival from elsewhere, or a reorder.
  const stayers = new Set<Mid>();
  for (const nc of nextList) {
    if (!_addressable(ctx, nc) || !_alive(ctx, nc.mid)) { continue; }
    const at = ctx.prev.get(nc.mid);
    if (at && at.parentMid === parentMid && at.slot === slot) { stayers.add(nc.mid); }
  }

  // Minimum moves: keep the longest run of stayers that is already in the right
  // relative order, move the rest.
  const prevOrder = new Map<Mid, number>();
  let rank = 0;
  for (const pc of prevList) {
    if (stayers.has(pc.mid) && !prevOrder.has(pc.mid)) { prevOrder.set(pc.mid, rank++); }
  }
  const seq: number[] = [];
  const seqMids: Mid[] = [];
  for (const nc of nextList) {
    if (!stayers.has(nc.mid)) { continue; }
    const at = prevOrder.get(nc.mid);
    if (at === undefined) { continue; }
    seq.push(at);
    seqMids.push(nc.mid);
  }
  const keep = new Set<Mid>();
  for (const i of _longestIncreasingRun(seq)) { keep.add(seqMids[i]); }

  // Right to left, so `before` always names a sibling already in place.
  let anchor: Mid | 'end' = 'end';
  for (let i = nextList.length - 1; i >= 0; i--) {
    const nc = nextList[i];
    const usable = _addressable(ctx, nc);
    const at = usable ? ctx.prev.get(nc.mid) : undefined;

    if (!usable || !at || !_alive(ctx, nc.mid)) {
      // New content, or content whose old home has already been destroyed by an
      // `el.replace` — either way it arrives as a payload, keeping its mid when
      // that mid is free.
      const built = _buildPayload(ctx, nc, depth + 1);
      ctx.ops.push(slot === undefined
        ? { op: 'el.insert', pageId: ctx.pageId, parentMid, before: anchor, node: built.input }
        : { op: 'el.insert', pageId: ctx.pageId, parentMid, before: anchor, node: built.input, slot });
      _flushDeferred(ctx, built.deferred, depth);
      if (typeof built.input.mid === 'string') { anchor = built.input.mid; }
      continue;
    }

    const moved = at.parentMid !== parentMid || at.slot !== slot || !keep.has(nc.mid);
    if (moved) {
      ctx.ops.push(slot === undefined
        ? { op: 'el.move', pageId: ctx.pageId, mid: nc.mid, newParentMid: parentMid, before: anchor }
        : { op: 'el.move', pageId: ctx.pageId, mid: nc.mid, newParentMid: parentMid, before: anchor, slot });
    }
    _alignNode(ctx, at.node, nc, depth + 1);
    anchor = nc.mid;
  }
}

/**
 * Removals come last so a survivor under a removed container is moved out
 * first. One op per top-most removal: the subtree goes with it.
 *
 * `carried` means "an ancestor's `el.remove` already deletes this node", which
 * is what makes that one op enough. It does NOT end the walk. A descendant that
 * ESCAPED the doomed subtree — it matched a node in `next`, so an `el.move`
 * already pulled it out and it is still in the document — takes its own subtree
 * with it, and anything in THERE that `next` dropped needs its own removal: the
 * ancestor's op can no longer reach it. Pruning at the doomed node is how a
 * rewrite silently leaves an orphan behind (a slot the model emptied, whose
 * occupant hung under a node that merely got reparented).
 */
function _collectRemovals(ctx: DiffCtx, n: DocNode, carried: boolean, seen: Set<DocNode>, depth: number): void {
  if (seen.has(n) || depth >= MAX_DEPTH) { return; }
  seen.add(n);
  const sweep = (list: DocNode[]): void => {
    for (const c of list) {
      if (ctx.destroyed.has(c.mid)) { continue; }   // already gone with an el.replace
      const gone = !ctx.next.has(c.mid);
      // Under a doomed ancestor the node is deleted for free; emitting a second
      // op would target a mid the document no longer holds.
      if (gone && !carried) {
        ctx.ops.push({ op: 'el.remove', pageId: ctx.pageId, mid: c.mid });
      }
      // Aligned = matched to a node in `next`, so it stayed or was moved. Under
      // a doomed ancestor that can only mean moved — it escaped.
      const escaped = ctx.aligned.has(c.mid);
      _collectRemovals(ctx, c, carried ? !escaped : gone, seen, depth + 1);
    }
  };
  sweep(n.children ?? []);
  for (const key of Object.keys(n.slots ?? {}).sort()) { sweep(_ownList(n.slots, key)); }
}

/* ──────────────────────────────── payloads ──────────────────────────────── */

/**
 * Turn a `next` subtree into an insertable payload.
 *
 * Descendants that are still ALIVE elsewhere in the document are excluded and
 * returned as deferred `el.move`s instead — inlining them would duplicate a mid
 * and destroy the identity (and the pins) of a node that merely got a new
 * parent. `pins` and `by` never ride along: {@link DocNodeInput} has no such
 * fields, which is exactly the boundary that stops a model forging either.
 */
function _buildPayload(
  ctx: DiffCtx,
  root: DocNode,
  depth: number,
  rootMid?: Mid,
): { input: DocNodeInput; deferred: Deferred[] } {
  const deferred: Deferred[] = [];

  const isDeferrable = (n: DocNode): boolean => _addressable(ctx, n) && _alive(ctx, n.mid);

  const build = (n: DocNode, assigned: Mid, d: number, path: Set<DocNode>): DocNodeInput => {
    const out: DocNodeInput = { mid: assigned, tag: typeof n.tag === 'string' ? n.tag : 'div' };
    if (n.props) { out.props = _cloneProps(n.props); }
    if (n.style) { out.style = { ...n.style }; }
    if (n.text !== undefined) { out.text = n.text; }
    // Keeping a mid means keeping an identity, so the human who owns a cell on
    // THAT identity still owns it after the re-creation. Without this a pin
    // survives a direct rewrite of its own node but is silently reverted when
    // an ancestor is replaced — the same clobber, one level up, and invisible.
    const keeper = ctx.respectPins ? ctx.prev.get(assigned)?.node : undefined;
    if (keeper && keeper.pins) { _preservePins(ctx, keeper, n, out); }
    // A cyclic tree is malformed input, not a shape to faithfully reproduce:
    // emit the node once and stop rather than unrolling it MAX_DEPTH times.
    if (d >= MAX_DEPTH || path.has(n)) { return out; }
    path.add(n);

    const takeList = (raw: DocNode[], slot: string | undefined): DocNodeInput[] => {
      // A child that is its own ancestor is a cycle, not content: drop it here
      // so it never becomes a phantom copy or a dangling anchor.
      const list = raw.some(c => path.has(c)) ? raw.filter(c => !path.has(c)) : raw;
      // Final ids first, so a deferred child can anchor on the sibling to its
      // right whatever that sibling turns out to be.
      const finals: Mid[] = list.map(c => (isDeferrable(c) ? c.mid : _pickMid(ctx, c)));
      const kept: DocNodeInput[] = [];
      const pending: Deferred[] = [];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (isDeferrable(c)) {
          const at = ctx.prev.get(c.mid);
          if (at) {
            const before: Mid | 'end' = i + 1 < finals.length ? finals[i + 1] : 'end';
            pending.push(slot === undefined
              ? { parentMid: assigned, before, prevNode: at.node, nextNode: c }
              : { parentMid: assigned, slot, before, prevNode: at.node, nextNode: c });
            continue;
          }
        }
        kept.push(build(c, finals[i], d + 1, path));
      }
      // Right to left: each deferred move anchors on one already placed.
      for (let i = pending.length - 1; i >= 0; i--) { deferred.push(pending[i]); }
      return kept;
    };

    const kids = takeList(n.children ?? [], undefined);
    if (kids.length > 0) { out.children = kids; }
    const slotKeys = Object.keys(n.slots ?? {}).sort();
    if (slotKeys.length > 0) {
      const slots: Record<string, DocNodeInput[]> = {};
      for (const key of slotKeys) {
        const built = takeList(_ownList(n.slots, key), key);
        if (built.length > 0) { putOwn(slots, key, built); }
      }
      if (Object.keys(slots).length > 0) { out.slots = slots; }
    }
    path.delete(n);
    return out;
  };

  return { input: build(root, rootMid ?? _pickMid(ctx, root), depth, new Set<DocNode>()), deferred };
}

/**
 * Run the moves a payload promised — revalidating each one when its turn comes.
 *
 * The list was planned when the payload was built, and aligning an EARLIER
 * entry can emit an `el.replace` that destroys a LATER entry's home before its
 * move ever runs. Trusting the stale plan emits a move addressing a mid the
 * document no longer holds, which `DocPatch` rejects outright — one dead op
 * failing the whole rewrite. A node whose home is gone is re-created in place
 * under the same id instead, exactly as {@link _alignChildren} does for a
 * survivor it meets after the fact.
 */
function _flushDeferred(ctx: DiffCtx, deferred: Deferred[], depth: number): void {
  for (const d of deferred) {
    if (!_alive(ctx, d.nextNode.mid)) {
      const built = _buildPayload(ctx, d.nextNode, depth + 1);
      ctx.ops.push(d.slot === undefined
        ? { op: 'el.insert', pageId: ctx.pageId, parentMid: d.parentMid, before: d.before, node: built.input }
        : { op: 'el.insert', pageId: ctx.pageId, parentMid: d.parentMid, before: d.before, node: built.input, slot: d.slot });
      _flushDeferred(ctx, built.deferred, depth);
      continue;
    }
    ctx.ops.push(d.slot === undefined
      ? { op: 'el.move', pageId: ctx.pageId, mid: d.nextNode.mid, newParentMid: d.parentMid, before: d.before }
      : { op: 'el.move', pageId: ctx.pageId, mid: d.nextNode.mid, newParentMid: d.parentMid, before: d.before, slot: d.slot });
    _alignNode(ctx, d.prevNode, d.nextNode, depth + 1);
  }
}

/** The mid a payload node may keep, or a fresh one when keeping it would collide. */
function _pickMid(ctx: DiffCtx, n: DocNode): Mid {
  if (_addressable(ctx, n) && ctx.next.get(n.mid)?.node === n && !_alive(ctx, n.mid)) { return n.mid; }
  return _freshMid(ctx);
}

function _freshMid(ctx: DiffCtx): Mid {
  for (let i = 0; i < 64; i++) {
    const candidate = ctx.mint();
    if (!ctx.prev.has(candidate) && !ctx.next.has(candidate) && !ctx.minted.has(candidate)) {
      ctx.minted.add(candidate);
      return candidate;
    }
  }
  // Deliberately still a mid: DocPatch re-mints colliding payload ids and
  // reports them in `newMids`, so a pathological id source degrades, not fails.
  const last = ctx.mint();
  ctx.minted.add(last);
  return last;
}

/* ──────────────────────────────── helpers ──────────────────────────────── */

/**
 * Read a MODEL-AUTHORED key without falling through to the prototype.
 *
 * The mirror image of `putOwn`. `record['__proto__']` on a record that has no
 * such OWN property does not return `undefined`: it runs
 * `Object.prototype.__proto__`'s getter and hands back `Object.prototype`
 * itself. Every "is this cell absent?" test in this file is written against
 * `undefined`, so without this a missing `__proto__` cell reads as a live object
 * value — it lands in an `el.setStyle` patch as a style value, it reaches the
 * model as the `wanted` half of a dropped-intent card, and as a slot it is
 * handed to a `for…of` that throws mid-diff.
 */
function _own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) { return undefined; }
  return record[key];
}

/** {@link _own} for a slot list: anything that is not an array is no list at all. */
function _ownList(slots: Record<string, DocNode[]> | undefined, key: string): DocNode[] {
  const v = _own(slots, key);
  return Array.isArray(v) ? v : [];
}

/** Union of two records' keys, sorted — so op order is deterministic. */
function _sortedKeys(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): string[] {
  const keys = new Set<string>([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].sort();
}

function _cloneProps(props: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(props).sort()) { putOwn(out, key, _cloneJson(props[key], 0)); }
  return out;
}

function _cloneJson(v: JsonValue, depth: number): JsonValue {
  if (depth >= MAX_DEPTH) { return null; }
  if (Array.isArray(v)) { return v.map(x => _cloneJson(x, depth + 1)); }
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, x] of Object.entries(v)) { putOwn(out, k, _cloneJson(x, depth + 1)); }
    return out;
  }
  return v;
}

function _jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined, depth: number): boolean {
  if (a === b) { return true; }
  if (depth >= MAX_DEPTH) { return false; }
  if (a === undefined || b === undefined || a === null || b === null) { return false; }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { return false; }
    return a.every((x, i) => _jsonEqual(x, b[i], depth + 1));
  }
  if (typeof a !== 'object' || typeof b !== 'object') { return false; }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) { return false; }
  return ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && _jsonEqual(a[k], (b as { [k: string]: JsonValue })[k], depth + 1));
}

/**
 * Indices of one longest strictly-increasing subsequence — the siblings whose
 * relative order is already right and which therefore need no `el.move`.
 * O(n log n) patience sort; the sequence is a permutation of distinct ranks.
 */
function _longestIncreasingRun(seq: number[]): number[] {
  const n = seq.length;
  if (n === 0) { return []; }
  const tails: number[] = [];
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) { lo = mid + 1; } else { hi = mid; }
    }
    if (lo > 0) { prev[i] = tails[lo - 1]; }
    tails[lo] = i;
  }
  const out: number[] = [];
  let k = tails[tails.length - 1];
  while (k >= 0) { out.push(k); k = prev[k]; }
  return out.reverse();
}
