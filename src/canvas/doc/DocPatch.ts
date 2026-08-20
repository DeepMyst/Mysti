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
 * Plan 22 §3.2 "Executor changes" item 1 — `applyOp(doc, op)`, the pure core of
 * every canvas mutation.
 *
 * This is what replaces `previousValue`'s deep clone of whole page sources
 * (`CanvasOpExecutor.ts:413-425`): instead of snapshotting a 30 KB string per
 * edit, every op computes the op that *exactly* undoes it. Undo becomes a
 * cursor over ~200-byte records rather than a stack of page-sized blobs.
 *
 * Three properties are load-bearing, and all three are asserted in
 * `tests/canvas/doc/docPatch.test.ts` over generated docs, not three examples:
 *
 * 1. **Purity.** The input tree is never mutated and shares no `DocNode` object
 *    with the returned tree. The executor can hand the old tree to history and
 *    the new one to the renderer without either aliasing the other.
 * 2. **Exact invertibility.** For every op,
 *    `applyOp(applyOp(doc, op).doc, inverse).doc` deep-equals `doc`. Where an
 *    element op cannot express the restoration (restoring an absent `text`, or
 *    a prop whose previous value was a JSON `null`, neither of which the op
 *    algebra can say), the inverse degrades to an `el.replace` carrying the
 *    previous node — still element-scoped, still exact, never a page snapshot.
 * 3. **Anchor-relative insertion.** `before` is a sibling `mid` or `'end'`,
 *    never an integer index: an index silently retargets when a human inserts a
 *    sibling, an anchor mid rebases correctly by construction. The inverse of a
 *    remove therefore captures the *following sibling's* mid (or `'end'`) so an
 *    undo puts the node back exactly where it was.
 *
 * Pure module: no vscode, no fs, no I/O, no clock, no randomness beyond
 * {@link mintMid} (injectable for tests).
 *
 * ## Invariants this module assumes and maintains
 * - **Mids are unique within a doc.** Maintained: any node arriving through
 *   `el.insert` / `el.replace` / `page.setDoc` whose mid collides with one
 *   already in the tree (or with an earlier node in the same payload) is
 *   re-minted and reported in `newMids`. Not retroactively repaired: a doc that
 *   already contains duplicates is only healed by a `page.setDoc`.
 * - **Shape is normalized.** Empty `props` / `style` / `pins` / `children` /
 *   `slots` containers are dropped from every node of every tree this module
 *   returns (see {@link normalizeDoc}), so `{}` and absent are one state rather
 *   than two indistinguishable-to-a-renderer-but-not-to-`toEqual` states. This
 *   is what lets "delete the last style property" and "insert into a node with
 *   no children" be exact inverses of each other.
 * - **Trust is decided by the caller.** `pins` and `by` are honoured when the
 *   incoming node carries them, because that is what makes an inverse restore a
 *   human's pins instead of quietly destroying them. Payloads that came from a
 *   model must therefore be run through {@link sanitizeNodeInput} at the
 *   transport boundary (`CanvasOpExecutor` / the tool surface), which is the
 *   layer that knows the author — a pure function of its arguments cannot.
 */

import {
  cloneNode,
  collectMids,
  findNode,
  findParent,
  mintMid,
  walk,
} from './DocNode';
import type { DocNode, DocNodeInput, JsonValue, Mid, PinCell, PinRecord } from './DocNode';
import { ELEMENT_SCOPED_OPS } from '../CanvasOps';
import type { CanvasOp, CanvasOpKindV2, DocPatchResult } from '../CanvasOps';

/* ─────────────────────────────── errors ─────────────────────────────── */

/**
 * Why a patch could not be applied.
 *
 * - `missing-mid` / `missing-anchor` — the op addressed something that is no
 *   longer in the document. The executor turns these into a `stale` receipt
 *   (or, for `missing-anchor`, may rebase to `'end'` and retry).
 * - `invalid-target` — the address resolved but the operation is structurally
 *   illegal there (removing the root, giving text to a container, moving a node
 *   inside itself). A `rejected` receipt; retrying will not help.
 * - `invalid-node` — the payload is not a well-formed node.
 * - `invalid-op` — this op does not patch a document at all (it is page- or
 *   artifact-scoped); routing it here is a caller bug.
 * - `mint-failed` — the mid generator could not produce a free id.
 */
export type DocPatchErrorCode =
  | 'missing-mid'
  | 'missing-anchor'
  | 'invalid-target'
  | 'invalid-node'
  | 'invalid-op'
  | 'mint-failed';

/** Codes that mean "the document moved under this writer", not "this op is wrong". */
const STALE_CODES: ReadonlySet<DocPatchErrorCode> = new Set<DocPatchErrorCode>([
  'missing-mid',
  'missing-anchor',
]);

/**
 * A typed failure the executor can convert into a receipt without string
 * matching. Never thrown for a *legal* op — a no-op op (an empty style patch, a
 * move that lands where the node already was) succeeds and returns an inverse.
 */
export class DocPatchError extends Error {
  readonly code: DocPatchErrorCode;
  readonly opKind: CanvasOpKindV2;
  /** The mid that could not be resolved, when the code is about an address. */
  readonly mid?: Mid;

  constructor(init: { code: DocPatchErrorCode; opKind: CanvasOpKindV2; detail: string; mid?: Mid }) {
    super(`[Mysti] DocPatch: ${init.opKind} — ${init.detail}`);
    this.name = 'DocPatchError';
    this.code = init.code;
    this.opKind = init.opKind;
    this.mid = init.mid;
    // Belt and braces for any downlevel-compiled consumer: keeps `instanceof`
    // working even if a bundler emits ES5 classes for this file.
    Object.setPrototypeOf(this, DocPatchError.prototype);
  }
}

/** Structural guard — survives duplicate module instances, unlike bare `instanceof`. */
export function isDocPatchError(e: unknown): e is DocPatchError {
  if (e instanceof DocPatchError) { return true; }
  if (!e || typeof e !== 'object') { return false; }
  const c = e as { name?: unknown; code?: unknown };
  return c.name === 'DocPatchError' && typeof c.code === 'string';
}

/** True when the failure means "stale", i.e. the address vanished. */
export function isStaleDocPatchError(e: unknown): boolean {
  return isDocPatchError(e) && STALE_CODES.has(e.code);
}

/* ──────────────────────────── entry point ──────────────────────────── */

export interface ApplyOpOptions {
  /** Injectable id source. Tests pass a counter; production uses {@link mintMid}. */
  mintMid?: () => Mid;
}

/** Ops {@link applyOp} understands: every element-scoped op, plus `page.setDoc`. */
export function isDocScopedOp(op: CanvasOp): boolean {
  return ELEMENT_SCOPED_OPS.has(op.op) || op.op === 'page.setDoc';
}

/**
 * Apply one op to one artboard's document.
 *
 * @returns the NEW tree, the op that exactly undoes it, and every mid minted
 *          for a node the writer sent without one (or with one that collided).
 * @throws  {@link DocPatchError} — never a bare `Error`, and never a silent
 *          no-op: a vanished target must reach the writer as `stale`, not as a
 *          receipt claiming success.
 */
export function applyOp(doc: DocNode, op: CanvasOp, opts: ApplyOpOptions = {}): DocPatchResult {
  const mint = opts.mintMid ?? (() => mintMid());
  switch (op.op) {
    case 'el.setText': return _setText(doc, op);
    case 'el.setStyle': return _setStyle(doc, op);
    case 'el.setProp': return _setProp(doc, op);
    case 'el.insert': return _insert(doc, op, mint);
    case 'el.remove': return _remove(doc, op);
    case 'el.move': return _move(doc, op);
    case 'el.replace': return _replace(doc, op, mint);
    case 'page.setDoc': return _setDoc(doc, op, mint);
    default:
      throw new DocPatchError({
        code: 'invalid-op',
        opKind: op.op,
        detail: 'this op does not patch a document — route page- and artifact-scoped ops elsewhere',
      });
  }
}

/* ───────────────────────────── el.setText ───────────────────────────── */

function _setText(doc: DocNode, op: Extract<CanvasOp, { op: 'el.setText' }>): DocPatchResult {
  const next = normalizeDoc(doc);
  const node = _need(next, op.mid, op.op);
  if (node.children && node.children.length > 0) {
    throw new DocPatchError({
      code: 'invalid-target',
      opKind: op.op,
      mid: op.mid,
      detail: `mid "${op.mid}" is a container (${node.children.length} children) — text and children are mutually exclusive`,
    });
  }
  const prevText = node.text;
  if (prevText === undefined) {
    // `el.setText` cannot say "make text absent again", so a first write to a
    // text-less node inverts through `el.replace` with the node as captured.
    const restore = cloneForPayload(node);
    node.text = op.text;
    return {
      doc: next,
      inverse: { op: 'el.replace', pageId: op.pageId, mid: op.mid, node: restore },
      newMids: {},
    };
  }
  node.text = op.text;
  return {
    doc: next,
    inverse: { op: 'el.setText', pageId: op.pageId, mid: op.mid, text: prevText },
    newMids: {},
  };
}

/* ──────────────────────────── el.setStyle ──────────────────────────── */

function _setStyle(doc: DocNode, op: Extract<CanvasOp, { op: 'el.setStyle' }>): DocPatchResult {
  const next = normalizeDoc(doc);
  const node = _need(next, op.mid, op.op);
  const style: Record<string, string> = { ...(node.style ?? {}) };
  /** Previous value per touched property; `null` where the property was absent. */
  const before: Record<string, string | null> = {};
  for (const [prop, value] of Object.entries(op.style)) {
    _put(before, prop, Object.prototype.hasOwnProperty.call(style, prop) ? style[prop] : null);
    if (value === null) { delete style[prop]; } else { _put(style, prop, value); }
  }
  if (Object.keys(style).length > 0) { node.style = style; } else { delete node.style; }
  return {
    doc: next,
    inverse: { op: 'el.setStyle', pageId: op.pageId, mid: op.mid, style: before },
    newMids: {},
  };
}

/* ───────────────────────────── el.setProp ───────────────────────────── */

function _setProp(doc: DocNode, op: Extract<CanvasOp, { op: 'el.setProp' }>): DocPatchResult {
  const next = normalizeDoc(doc);
  const node = _need(next, op.mid, op.op);
  const props: Record<string, JsonValue> = { ...(node.props ?? {}) };
  const had = Object.prototype.hasOwnProperty.call(props, op.name);
  // `null` means DELETE in this algebra, so a previous value that *was* a JSON
  // null is not expressible as a `setProp` inverse — fall back to `el.replace`.
  const restore = had && props[op.name] === null ? cloneForPayload(node) : null;
  const prev: JsonValue | undefined = had ? _cloneJson(props[op.name]) : undefined;

  if (op.value === null) { delete props[op.name]; } else { _put(props, op.name, _cloneJson(op.value)); }
  if (Object.keys(props).length > 0) { node.props = props; } else { delete node.props; }

  let inverse: CanvasOp;
  if (restore) {
    inverse = { op: 'el.replace', pageId: op.pageId, mid: op.mid, node: restore };
  } else if (prev !== undefined) {
    inverse = { op: 'el.setProp', pageId: op.pageId, mid: op.mid, name: op.name, value: prev };
  } else {
    inverse = { op: 'el.setProp', pageId: op.pageId, mid: op.mid, name: op.name, value: null };
  }
  return { doc: next, inverse, newMids: {} };
}

/* ───────────────────────────── el.insert ───────────────────────────── */

function _insert(
  doc: DocNode,
  op: Extract<CanvasOp, { op: 'el.insert' }>,
  mint: () => Mid,
): DocPatchResult {
  const next = normalizeDoc(doc);
  const parent = _need(next, op.parentMid, op.op);
  const list = _destList(parent, op.slot, op.op, op.parentMid);
  const index = _anchorIndex(list, op.before, op.op, op.parentMid);

  const ctx: MintCtx = { taken: collectMids(next), newMids: {}, mint, opKind: op.op };
  const node = _materialize(op.node, ctx, PAYLOAD_ROOT_KEY);

  list.splice(index, 0, node);
  _attachList(parent, op.slot, list);

  return {
    doc: next,
    inverse: { op: 'el.remove', pageId: op.pageId, mid: node.mid },
    newMids: ctx.newMids,
  };
}

/* ───────────────────────────── el.remove ───────────────────────────── */

function _remove(doc: DocNode, op: Extract<CanvasOp, { op: 'el.remove' }>): DocPatchResult {
  const next = normalizeDoc(doc);
  _need(next, op.mid, op.op);
  const at = findParent(next, op.mid);
  if (!at) {
    throw new DocPatchError({
      code: 'invalid-target',
      opKind: op.op,
      mid: op.mid,
      detail: 'cannot remove the document root — replace it with `page.setDoc` or `el.replace`',
    });
  }
  const list = _listAt(at.parent, at.slot, op.op);
  const removed = cloneForPayload(list[at.index]);
  // The FOLLOWING sibling is the anchor an undo re-inserts against: an integer
  // index would retarget the moment anything else moved in this list.
  const anchor: Mid | 'end' = at.index + 1 < list.length ? list[at.index + 1].mid : 'end';
  list.splice(at.index, 1);
  _pruneList(at.parent, at.slot, list);

  const inverse: Extract<CanvasOp, { op: 'el.insert' }> = {
    op: 'el.insert',
    pageId: op.pageId,
    parentMid: at.parent.mid,
    before: anchor,
    node: removed,
  };
  if (at.slot !== undefined) { inverse.slot = at.slot; }
  return { doc: next, inverse, newMids: {} };
}

/* ────────────────────────────── el.move ────────────────────────────── */

function _move(doc: DocNode, op: Extract<CanvasOp, { op: 'el.move' }>): DocPatchResult {
  const next = normalizeDoc(doc);
  const node = _need(next, op.mid, op.op);
  const at = findParent(next, op.mid);
  if (!at) {
    throw new DocPatchError({
      code: 'invalid-target',
      opKind: op.op,
      mid: op.mid,
      detail: 'cannot move the document root',
    });
  }
  const newParent = findNode(next, op.newParentMid);
  if (!newParent) {
    throw new DocPatchError({
      code: 'missing-mid',
      opKind: op.op,
      mid: op.newParentMid,
      detail: `new parent "${op.newParentMid}" is not in this document`,
    });
  }
  // `findNode(node, …)` covers "into itself" as well as "into its own subtree".
  if (findNode(node, op.newParentMid)) {
    throw new DocPatchError({
      code: 'invalid-target',
      opKind: op.op,
      mid: op.mid,
      detail: `cannot move "${op.mid}" into itself or its own descendant "${op.newParentMid}"`,
    });
  }
  if (op.slot === undefined && newParent.text !== undefined) {
    throw new DocPatchError({
      code: 'invalid-target',
      opKind: op.op,
      mid: op.newParentMid,
      detail: `new parent "${op.newParentMid}" is a text leaf — text and children are mutually exclusive`,
    });
  }
  const sameList = newParent === at.parent && at.slot === op.slot;

  const src = _listAt(at.parent, at.slot, op.op);
  const origAnchor: Mid | 'end' = at.index + 1 < src.length ? src[at.index + 1].mid : 'end';
  src.splice(at.index, 1);
  _pruneList(at.parent, at.slot, src);

  // Resolve the destination AFTER the removal: within one list the anchor's
  // index shifts, and the source list may have been pruned away entirely.
  const dest = _destList(newParent, op.slot, op.op, op.newParentMid);
  let index: number;
  if (op.before === 'end') {
    index = dest.length;
  } else if (op.before === op.mid) {
    // "before myself" — a drag that landed back on its own gap. Meaningful only
    // within the node's own list, where it means "stay put".
    if (!sameList) {
      throw new DocPatchError({
        code: 'missing-anchor',
        opKind: op.op,
        mid: op.before,
        detail: `anchor "${op.before}" is the moved node itself and is not in the destination list`,
      });
    }
    index = Math.min(at.index, dest.length);
  } else {
    index = dest.findIndex(c => c.mid === op.before);
    if (index < 0) {
      throw new DocPatchError({
        code: 'missing-anchor',
        opKind: op.op,
        mid: op.before,
        detail: `anchor "${op.before}" is not a child of "${op.newParentMid}"`,
      });
    }
  }
  dest.splice(index, 0, node);
  _attachList(newParent, op.slot, dest);

  const inverse: Extract<CanvasOp, { op: 'el.move' }> = {
    op: 'el.move',
    pageId: op.pageId,
    mid: op.mid,
    newParentMid: at.parent.mid,
    before: origAnchor,
  };
  if (at.slot !== undefined) { inverse.slot = at.slot; }
  return { doc: next, inverse, newMids: {} };
}

/* ───────────────────────────── el.replace ───────────────────────────── */

function _replace(
  doc: DocNode,
  op: Extract<CanvasOp, { op: 'el.replace' }>,
  mint: () => Mid,
): DocPatchResult {
  const next = normalizeDoc(doc);
  const target = _need(next, op.mid, op.op);
  const previous = cloneForPayload(target);

  // The target's own mid and everything under it is leaving, so those ids are
  // free for the replacement to reuse.
  const taken = collectMids(next);
  for (const gone of collectMids(target)) { taken.delete(gone); }

  const ctx: MintCtx = { taken, newMids: {}, mint, opKind: op.op };
  // Identity is preserved by force: selection, pins, comments and anchors all
  // hang off this mid, so a content swap must not move it — whatever mid the
  // writer put on the payload root is recorded as a remap instead.
  const fresh = _materialize(op.node, ctx, PAYLOAD_ROOT_KEY, op.mid);

  const inverse: CanvasOp = { op: 'el.replace', pageId: op.pageId, mid: op.mid, node: previous };
  const at = findParent(next, op.mid);
  if (!at) { return { doc: fresh, inverse, newMids: ctx.newMids }; }
  _listAt(at.parent, at.slot, op.op)[at.index] = fresh;
  return { doc: next, inverse, newMids: ctx.newMids };
}

/* ──────────────────────────── page.setDoc ──────────────────────────── */

function _setDoc(
  doc: DocNode,
  op: Extract<CanvasOp, { op: 'page.setDoc' }>,
  mint: () => Mid,
): DocPatchResult {
  const previous = cloneForPayload(doc);
  const ctx: MintCtx = { taken: new Set<Mid>(), newMids: {}, mint, opKind: op.op };
  const fresh = _materialize(op.doc, ctx, PAYLOAD_ROOT_KEY);
  return {
    doc: fresh,
    inverse: { op: 'page.setDoc', pageId: op.pageId, doc: previous },
    newMids: ctx.newMids,
  };
}

/* ──────────────────────────── tree helpers ──────────────────────────── */

function _need(root: DocNode, mid: Mid, opKind: CanvasOpKindV2): DocNode {
  const node = findNode(root, mid);
  if (!node) {
    throw new DocPatchError({
      code: 'missing-mid',
      opKind,
      mid,
      detail: `mid "${mid}" is not in this document`,
    });
  }
  return node;
}

/** The live child array a located node sits in. */
function _listAt(parent: DocNode, slot: string | undefined, opKind: CanvasOpKindV2): DocNode[] {
  const list = slot === undefined ? parent.children : parent.slots?.[slot];
  if (!list) {
    // Unreachable: `findParent` only ever reports a position that exists.
    throw new DocPatchError({
      code: 'invalid-target',
      opKind,
      mid: parent.mid,
      detail: `internal: ${slot === undefined ? 'children' : `slot "${slot}"`} vanished from "${parent.mid}"`,
    });
  }
  return list;
}

/** A mutable destination list for an insert/move — created empty when absent. */
function _destList(
  parent: DocNode,
  slot: string | undefined,
  opKind: CanvasOpKindV2,
  parentMid: Mid,
): DocNode[] {
  if (slot !== undefined) { return (parent.slots?.[slot] ?? []).slice(); }
  if (parent.text !== undefined) {
    throw new DocPatchError({
      code: 'invalid-target',
      opKind,
      mid: parentMid,
      detail: `"${parentMid}" is a text leaf — text and children are mutually exclusive`,
    });
  }
  return (parent.children ?? []).slice();
}

/** Write a list back, normalizing an empty one away. */
function _attachList(parent: DocNode, slot: string | undefined, list: DocNode[]): void {
  if (slot === undefined) {
    if (list.length > 0) { parent.children = list; } else { delete parent.children; }
    return;
  }
  if (list.length > 0) {
    parent.slots = { ...(parent.slots ?? {}), [slot]: list };
    return;
  }
  _pruneSlot(parent, slot);
}

/** After a removal: drop the key when the list emptied, so `{}` never lingers. */
function _pruneList(parent: DocNode, slot: string | undefined, list: DocNode[]): void {
  if (list.length > 0) { return; }
  if (slot === undefined) { delete parent.children; return; }
  _pruneSlot(parent, slot);
}

function _pruneSlot(parent: DocNode, slot: string): void {
  if (!parent.slots) { return; }
  delete parent.slots[slot];
  if (Object.keys(parent.slots).length === 0) { delete parent.slots; }
}

/**
 * Index for an anchor within `list`.
 * `'end'` appends; a sibling mid inserts before it; anything else is stale.
 */
function _anchorIndex(
  list: DocNode[],
  before: Mid | 'end',
  opKind: CanvasOpKindV2,
  parentMid: Mid,
): number {
  if (before === 'end') { return list.length; }
  const i = list.findIndex(c => c.mid === before);
  if (i < 0) {
    throw new DocPatchError({
      code: 'missing-anchor',
      opKind,
      mid: before,
      detail: `anchor "${before}" is not a child of "${parentMid}"`,
    });
  }
  return i;
}

/* ──────────────────────── cloning & normalization ──────────────────────── */

/**
 * Own-property write that survives a hostile key.
 *
 * Props, style properties, slot names and mids are all model-authored strings,
 * and plain `obj[k] = v` with `k === '__proto__'` sets the prototype instead of
 * creating a property: the value silently vanishes from `Object.entries`, which
 * would break invertibility on exactly the input an attacker chooses. Object
 * spread and computed keys in literals already create own properties; this is
 * for the loop-assignment sites.
 */
function _put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function _cloneJson(v: JsonValue): JsonValue {
  if (Array.isArray(v)) { return v.map(_cloneJson); }
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, x] of Object.entries(v)) { _put(out, k, _cloneJson(x)); }
    return out;
  }
  return v;
}

function _cloneProps(p: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  // A prop explicitly set to `undefined` is not JSON and would not survive a
  // save/load cycle, so it is dropped here rather than round-tripping unequally.
  for (const [k, v] of Object.entries(p)) { if (v !== undefined) { _put(out, k, _cloneJson(v)); } }
  return out;
}

function _clonePins(p: Record<PinCell, PinRecord>): Record<PinCell, PinRecord> {
  const out: Record<PinCell, PinRecord> = {};
  for (const [cell, rec] of Object.entries(p)) { _put(out, cell, { at: rec.at, opId: rec.opId }); }
  return out;
}

/**
 * Deep clone + shape normalization — the entry every patch starts from.
 *
 * `cloneNode` is structural but shallow over `props` values and `PinRecord`s;
 * both are deepened here so the returned tree shares *nothing* mutable with the
 * input. Empty containers are dropped so "absent" and "`{}`" stop being two
 * states that render identically and compare differently.
 */
export function normalizeDoc(root: DocNode): DocNode {
  const out = cloneNode(root);
  for (const node of walk(out)) {
    if (node.props) {
      if (Object.keys(node.props).length === 0) { delete node.props; }
      else { node.props = _cloneProps(node.props); }
    }
    if (node.style && Object.keys(node.style).length === 0) { delete node.style; }
    if (node.pins) {
      if (Object.keys(node.pins).length === 0) { delete node.pins; }
      else { node.pins = _clonePins(node.pins); }
    }
    if (node.children && node.children.length === 0) { delete node.children; }
    if (node.slots) {
      for (const [slot, list] of Object.entries(node.slots)) {
        if (list.length === 0) { delete node.slots[slot]; }
      }
      if (Object.keys(node.slots).length === 0) { delete node.slots; }
    }
  }
  return out;
}

/**
 * Snapshot a live node for an inverse op's payload.
 *
 * Keeps `pins` and `by`: an undo that restored the geometry but dropped the
 * record of which cells a human owns would silently hand those cells back to
 * the agent — the exact failure §3.5 exists to prevent.
 */
export function cloneForPayload(node: DocNode): DocNode {
  return normalizeDoc(node);
}

/**
 * Strip host-authority fields (`pins`, `by`) and anything not in the node
 * schema from a payload, recursively.
 *
 * Call this on model- or webview-authored `DocNodeInput` at the transport
 * boundary. `applyOp` deliberately honours those fields, because that is what
 * makes an inverse exact; deciding whether *this* writer is allowed to assert
 * them is the executor's job, not a pure function's.
 */
export function sanitizeNodeInput(input: DocNodeInput): DocNodeInput {
  const out: DocNodeInput = { tag: input.tag };
  if (input.mid !== undefined) { out.mid = input.mid; }
  if (input.props && Object.keys(input.props).length > 0) { out.props = _cloneProps(input.props); }
  if (input.style && Object.keys(input.style).length > 0) { out.style = { ...input.style }; }
  if (input.text !== undefined) { out.text = input.text; }
  if (input.children && input.children.length > 0) { out.children = input.children.map(sanitizeNodeInput); }
  if (input.slots) {
    const slots: Record<string, DocNodeInput[]> = {};
    for (const [slot, list] of Object.entries(input.slots)) {
      if (list.length > 0) { _put(slots, slot, list.map(sanitizeNodeInput)); }
    }
    if (Object.keys(slots).length > 0) { out.slots = slots; }
  }
  return out;
}

/* ─────────────────────────── materialization ─────────────────────────── */

/**
 * Key used in {@link DocPatchResult.newMids} for the payload's own root.
 * Descendants extend it: `$/0`, `$/0/1`, `$/@actions/0`. `$` is outside the mid
 * alphabet, so a path key can never collide with a mid key.
 */
export const PAYLOAD_ROOT_KEY = '$';

/** Bound on mid-minting retries before we admit the generator is broken. */
const MINT_ATTEMPTS = 64;

interface MintCtx {
  /** Mids already spoken for — the surviving tree plus everything minted so far. */
  taken: Set<Mid>;
  newMids: Record<string, Mid>;
  mint: () => Mid;
  opKind: CanvasOpKindV2;
}

/** A `DocNodeInput` that may in fact be a full `DocNode` (an inverse payload). */
type IncomingNode = DocNodeInput & { pins?: Record<PinCell, PinRecord>; by?: 'agent' | 'user' };

function _materialize(input: DocNodeInput, ctx: MintCtx, path: string, forcedMid?: Mid): DocNode {
  const src = input as IncomingNode;
  if (!src || typeof src !== 'object') {
    throw new DocPatchError({ code: 'invalid-node', opKind: ctx.opKind, detail: `payload node at "${path}" is not an object` });
  }
  if (typeof src.tag !== 'string' || src.tag.length === 0) {
    throw new DocPatchError({ code: 'invalid-node', opKind: ctx.opKind, detail: `payload node at "${path}" has no tag` });
  }
  const hasChildren = !!src.children && src.children.length > 0;
  if (hasChildren && src.text !== undefined) {
    throw new DocPatchError({
      code: 'invalid-node',
      opKind: ctx.opKind,
      detail: `payload node at "${path}" carries both text and children — they are mutually exclusive`,
    });
  }

  // Field order mirrors `cloneNode`, so serialized docs stay byte-stable
  // whether a node was cloned or materialized.
  const out: DocNode = { mid: _resolveMid(src.mid, ctx, path, forcedMid), tag: src.tag };
  if (src.props && Object.keys(src.props).length > 0) { out.props = _cloneProps(src.props); }
  if (src.style && Object.keys(src.style).length > 0) { out.style = { ...src.style }; }
  if (src.text !== undefined) { out.text = src.text; }
  if (src.by) { out.by = src.by; }
  if (src.pins && Object.keys(src.pins).length > 0) { out.pins = _clonePins(src.pins); }
  if (hasChildren) {
    out.children = (src.children ?? []).map((c, i) => _materialize(c, ctx, `${path}/${i}`));
  }
  if (src.slots) {
    const slots: Record<string, DocNode[]> = {};
    for (const [slot, list] of Object.entries(src.slots)) {
      if (list.length === 0) { continue; }
      _put(slots, slot, list.map((c, i) => _materialize(c, ctx, `${path}/@${slot}/${i}`)));
    }
    if (Object.keys(slots).length > 0) { out.slots = slots; }
  }
  return out;
}

/**
 * Decide a node's mid.
 *
 * A mid a writer sends is a *hint*: honoured when it is free, re-minted when it
 * collides with a node that already exists (or with an earlier node in the same
 * payload), because two nodes sharing a mid would make every later address
 * ambiguous. Either way the writer learns the outcome through `newMids`.
 */
function _resolveMid(sent: Mid | undefined, ctx: MintCtx, path: string, forced?: Mid): Mid {
  if (forced !== undefined) {
    ctx.taken.add(forced);
    if (sent && sent !== forced) { _put(ctx.newMids, _freeKey(sent, ctx, path), forced); }
    return forced;
  }
  if (sent && !ctx.taken.has(sent)) {
    ctx.taken.add(sent);
    return sent;
  }
  const fresh = _mintFree(ctx);
  _put(ctx.newMids, sent ? _freeKey(sent, ctx, path) : path, fresh);
  return fresh;
}

/** Prefer keying by the mid the writer sent; fall back to the path on a repeat. */
function _freeKey(sent: Mid, ctx: MintCtx, path: string): string {
  return Object.prototype.hasOwnProperty.call(ctx.newMids, sent) ? path : sent;
}

function _mintFree(ctx: MintCtx): Mid {
  for (let i = 0; i < MINT_ATTEMPTS; i++) {
    const candidate = ctx.mint();
    if (typeof candidate === 'string' && candidate.length > 0 && !ctx.taken.has(candidate)) {
      ctx.taken.add(candidate);
      return candidate;
    }
  }
  throw new DocPatchError({
    code: 'mint-failed',
    opKind: ctx.opKind,
    detail: `could not mint a free mid in ${MINT_ATTEMPTS} attempts`,
  });
}
