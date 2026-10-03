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
 * Plan 22 §3.1 "Mid stability — three tiers".
 *
 * When a model rewrites a whole artboard it hands back a fresh tree. Most of
 * that tree is the same design — but only if IDENTITY survives, because
 * selection, pins, comments, conflict detection and element-level undo are all
 * anchored to {@link Mid}s. This module is the one place that decides which
 * node in `next` *is* which node in `prev`:
 *
 *   1. **Echoed** — `next` carried a `mid` that exists in `prev` and is
 *      structurally compatible. A mid from a model is a HINT, never an
 *      authority: it is verified against the live tree (exists + same `tag` +
 *      not already consumed) and otherwise discarded, never retargeted.
 *   2. **Reconciled** — a keyed tree diff per parent. Exact matches (same `tag`
 *      AND (same `props.key` OR identical `text`)) match position-independently
 *      and form an LCS backbone; the gaps between backbone anchors are filled
 *      greedily by `0.5*tagEqual + 0.3*dice(text) + 0.2*propOverlap`, accepted
 *      only ABOVE {@link SIMILARITY_THRESHOLD}.
 *   3. **Minted** — everything left gets a fresh mid, reported in `newMids`.
 *
 * **The non-negotiable rule (Plan 22 §7 risk 2):** a node matched only by the
 * similarity fill NEVER inherits a pin. It inherits the mid — losing identity
 * on a light edit would be its own disaster — but the human's per-cell
 * ownership is dropped and REPORTED in {@link ReconcileResult.droppedPins}. A
 * mis-inherited pin is the worst failure mode in the system because it is
 * invisible: the human believes they own a cell they do not, and the agent is
 * then refused a write nobody asked to protect. Pins ride tier 1 (`echoed`) and
 * tier-2-exact (`exact`) only.
 *
 * Pure: no `vscode`, no `fs`, no I/O, no clock. Given the same inputs and the
 * same `rand` it produces the same tree.
 */

import type { DocNode, DocNodeInput, JsonValue, Mid, PinCell } from './DocNode';
import { isMid, mintMid, pinnedCells, putOwn, walk } from './DocNode';

/* ------------------------------- result -------------------------------- */

/**
 * How a node in the reconciled tree acquired its identity.
 *
 * Ordered strongest to weakest. {@link PIN_CARRYING_TIERS} is the security-
 * relevant partition of this union, not a stylistic one.
 */
export type MatchTier =
  /** Tier 1 — `next` echoed a mid that verified against `prev`. */
  | 'echoed'
  /** Tier 2 — keyed / identical-text match, or the artboard root by position. */
  | 'exact'
  /** Tier 2 fill / tier 3 — matched only by similarity. NEVER carries a pin. */
  | 'similar'
  /** Tier 3 — no match; a fresh mid. */
  | 'minted';

/**
 * The only tiers a {@link DocNode.pins} record may ride.
 *
 * Do not widen this. See the module header — a pin inherited through a weak
 * match is invisible to the human it lies to.
 */
export const PIN_CARRYING_TIERS: ReadonlySet<MatchTier> = new Set<MatchTier>(['echoed', 'exact']);

/** A human's per-cell ownership that could not survive the rewrite. */
export interface DroppedPin {
  /** The node in `prev` that owned the cells. */
  prevMid: Mid;
  /** The mid the node carries now, or `null` when the node vanished entirely. */
  nowMid: Mid | null;
  /** `weak-match` — identity survived, ownership did not. `removed` — gone. */
  reason: 'weak-match' | 'removed';
  /** The pinned cells, sorted. */
  cells: PinCell[];
}

export interface ReconcileResult {
  /** `next`, with every node given a verified or freshly minted `mid`. */
  doc: DocNode;
  /**
   * Mids minted for nodes the writer sent without a usable one.
   *
   * Keyed by the writer's own handle so a receipt is actionable: the REJECTED
   * mid it claimed when it claimed one (and no surviving node kept that mid),
   * otherwise a structural path — `'#'` for the root, `'#/2'` for a child,
   * `'#/0/@trailing/1'` for a slot entry. Paths start with `#`, which
   * {@link isMid} can never accept, so the two key spaces cannot collide.
   */
  newMids: Record<string, Mid>;
  /** How many nodes kept a mid from `prev`. */
  carried: number;
  /** Every mid in {@link doc} mapped to the tier that produced it. */
  tiers: Record<Mid, MatchTier>;
  /** Pins that could not ride the match. The caller reports these to the human. */
  droppedPins: DroppedPin[];
  /** Mids in `prev` that no node in {@link doc} carries — anchors to retire. */
  lost: Mid[];
  /** Subtrees dropped for exceeding {@link ReconcileOptions.maxDepth}. */
  truncated: number;
}

export interface ReconcileOptions {
  /** Injectable for deterministic tests. Defaults to `Math.random`. */
  rand?: () => number;
  /** Similarity a fill candidate must EXCEED. Plan §3.1: `0.55`. */
  threshold?: number;
  /** How far (in sibling positions) a fill candidate may sit from its slot. */
  window?: number;
  /** Depth past which children are dropped rather than recursed into. */
  maxDepth?: number;
}

/** Plan 22 §3.1 — the similarity a fill candidate must exceed. */
export const SIMILARITY_THRESHOLD = 0.55;

/** Sibling-distance cap on the similarity fill. Bounds the O(n*m) inner loop. */
const DEFAULT_WINDOW = 32;
/** Recursion cap. A hostile tree must degrade, not overflow the host stack. */
const DEFAULT_MAX_DEPTH = 256;
/** Text longer than this is compared by similarity only, never bucketed. */
const EXACT_TEXT_MAX = 4096;
/** Dice only ever looks at this much text. */
const DICE_MAX_CHARS = 512;
/** How deep the unwrap pass looks inside unmatched previous siblings. */
const UNWRAP_DEPTH = 2;
/** Cap on the unwrap candidate pool. */
const UNWRAP_MAX_CANDIDATES = 512;

/* ----------------------------- similarity ------------------------------ */

/** Normalized bigram set. Empty for strings shorter than 2 characters. */
function _bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) { out.add(s.slice(i, i + 2)); }
  return out;
}

function _normalizeText(s: string): string {
  return s.slice(0, DICE_MAX_CHARS).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Dice coefficient over character bigrams: `2*|A n B| / (|A|+|B|)`.
 *
 * Case- and whitespace-insensitive, because it is a heuristic for "is this the
 * same label" — exact identity is tier 2's job and compares raw text.
 * Identical inputs short-circuit to `1`, so single characters and the
 * both-empty case (two containers) behave sanely instead of scoring 0.
 */
export function dice(a: string, b: string): number {
  const x = _normalizeText(a);
  const y = _normalizeText(b);
  if (x === y) { return 1; }
  if (!x || !y) { return 0; }
  const setA = _bigrams(x);
  const setB = _bigrams(y);
  if (setA.size === 0 || setB.size === 0) { return 0; }
  let hits = 0;
  for (const g of setA) { if (setB.has(g)) { hits++; } }
  return (2 * hits) / (setA.size + setB.size);
}

/** Structural equality over JSON-safe prop values. Depth-bounded. */
function _jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined, depth = 0): boolean {
  if (a === b) { return true; }
  if (depth > 8 || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { return false; }
  if (Array.isArray(a) !== Array.isArray(b)) { return false; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { return false; }
    return a.every((v, i) => _jsonEqual(v, b[i], depth + 1));
  }
  const objA = a as Record<string, JsonValue>;
  const objB = b as Record<string, JsonValue>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) { return false; }
  return keysA.every(k =>
    Object.prototype.hasOwnProperty.call(objB, k) && _jsonEqual(objA[k], objB[k], depth + 1),
  );
}

/**
 * Fraction of the union of prop names that agree on both name and value.
 * Two propless nodes agree vacuously (`1`) — they carry no evidence either way,
 * and the 0.2 weight alone can never clear the threshold on its own.
 */
function _propOverlap(a?: Record<string, JsonValue>, b?: Record<string, JsonValue>): number {
  const keysA = a ? Object.keys(a) : [];
  const keysB = b ? Object.keys(b) : [];
  if (keysA.length === 0 && keysB.length === 0) { return 1; }
  const union = new Set<string>([...keysA, ...keysB]);
  let same = 0;
  for (const k of union) {
    if (a && b
      && Object.prototype.hasOwnProperty.call(a, k)
      && Object.prototype.hasOwnProperty.call(b, k)
      && _jsonEqual(a[k], b[k])) { same++; }
  }
  return same / union.size;
}

type NodeLike = { tag: string; props?: Record<string, JsonValue>; text?: string };

/**
 * Plan 22 §3.1: `0.5*tagEqual + 0.3*dice(text) + 0.2*propOverlap`.
 *
 * Note the emergent property, which is deliberate: without tag equality the
 * maximum reachable score is `0.5`, below the `0.55` threshold. **The
 * similarity fill therefore never crosses a tag boundary** — a `section`
 * cannot inherit an `h1`'s identity no matter how alike their content is.
 */
export function similarity(a: NodeLike, b: NodeLike): number {
  return 0.5 * (a.tag === b.tag ? 1 : 0)
    + 0.3 * dice(a.text ?? '', b.text ?? '')
    + 0.2 * _propOverlap(a.props, b.props);
}

/** The explicit key of a node, or null when it has none. */
function _keyOf(n: NodeLike): string | null {
  const k = n.props?.key;
  if (typeof k === 'string' && k.trim().length > 0) { return `s ${k}`; }
  if (typeof k === 'number' && Number.isFinite(k)) { return `n ${k}`; }
  return null;
}

/** Bucket key for the exact pass, or null when the node is not exactly matchable. */
function _exactKey(n: NodeLike): string | null {
  if (typeof n.tag !== 'string') { return null; }
  const k = _keyOf(n);
  if (k !== null) { return `k ${n.tag} ${k}`; }
  const t = n.text;
  if (typeof t === 'string' && t.trim().length > 0 && t.length <= EXACT_TEXT_MAX) {
    return `t ${n.tag} ${t}`;
  }
  return null;
}

/**
 * Confirms a bucket hit structurally, so a crafted `props.key` cannot collide
 * its way into an identical-text bucket (and inherit that node's pins).
 */
function _exactMatch(a: NodeLike, b: NodeLike): boolean {
  if (a.tag !== b.tag) { return false; }
  const keyA = _keyOf(a);
  const keyB = _keyOf(b);
  if (keyA !== null || keyB !== null) { return keyA !== null && keyA === keyB; }
  return typeof a.text === 'string' && a.text === b.text && a.text.trim().length > 0;
}

/* ------------------------------ internals ------------------------------ */

interface Pairing { prev: DocNode; tier: Exclude<MatchTier, 'minted'>; }

interface Ctx {
  prevByMid: Map<Mid, DocNode>;
  /** Mids `next` claimed that verified against `prev` — off limits to tier 2. */
  reserved: Set<Mid>;
  /** Previous mids consumed by a pairing (matching time). */
  claimed: Set<Mid>;
  /** Mids present in the output tree (emission time). Uniqueness invariant. */
  used: Set<Mid>;
  /** Previous mids that actually reached the output. */
  matched: Set<Mid>;
  tiers: Record<Mid, MatchTier>;
  newMids: Record<string, Mid>;
  dropped: DroppedPin[];
  carried: number;
  truncated: number;
  threshold: number;
  window: number;
  maxDepth: number;
  rand: () => number;
  entropy: number;
}

function _asArray<T>(v: T[] | undefined): T[] { return Array.isArray(v) ? v : []; }

/** Every node in an untrusted input tree, parents before children. */
function* _walkInput(root: DocNodeInput): Generator<DocNodeInput> {
  yield root;
  for (const c of _asArray(root.children)) { if (c) { yield* _walkInput(c); } }
  for (const list of Object.values(root.slots ?? {})) {
    for (const c of _asArray(list)) { if (c) { yield* _walkInput(c); } }
  }
}

/**
 * A mid nothing in `prev` and nothing already emitted uses.
 *
 * Falls back to a counter-derived stream if the injected `rand` is degenerate
 * (a test stub returning a constant would otherwise spin forever).
 */
function _mint(ctx: Ctx): Mid {
  for (let i = 0; i < 64; i++) {
    const m = mintMid(ctx.rand);
    if (!ctx.used.has(m) && !ctx.prevByMid.has(m)) { return m; }
  }
  for (let i = 0; i < 10_000; i++) {
    let s = (ctx.entropy = (ctx.entropy + 0x9e3779b1) >>> 0) || 0x2545f491;
    const rand = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      if (s === 0) { s = 0x2545f491; }
      return s / 0x1_0000_0000;
    };
    const m = mintMid(rand);
    if (!ctx.used.has(m) && !ctx.prevByMid.has(m)) { return m; }
  }
  throw new Error('[Mysti] Reconciler: exhausted the mid space');
}

/** Longest subsequence of anchors (already sorted by `i`) with increasing `j`. */
function _backbone(anchors: Array<{ i: number; j: number }>): Array<{ i: number; j: number }> {
  const n = anchors.length;
  if (n === 0) { return []; }
  const len = new Array<number>(n).fill(1);
  const from = new Array<number>(n).fill(-1);
  let best = 0;
  for (let a = 1; a < n; a++) {
    for (let b = 0; b < a; b++) {
      if (anchors[b].j < anchors[a].j && len[b] + 1 > len[a]) { len[a] = len[b] + 1; from[a] = b; }
    }
    if (len[a] > len[best]) { best = a; }
  }
  const out: Array<{ i: number; j: number }> = [];
  for (let k = best; k >= 0; k = from[k]) {
    out.push(anchors[k]);
    if (from[k] < 0) { break; }
  }
  return out.reverse();
}

/** Unclaimed descendants of an unmatched previous sibling, for the unwrap pass. */
function _descendants(node: DocNode, depth: number, out: DocNode[], ctx: Ctx): void {
  if (depth <= 0 || out.length >= UNWRAP_MAX_CANDIDATES) { return; }
  const push = (c: DocNode) => {
    if (!ctx.claimed.has(c.mid) && !ctx.used.has(c.mid)) { out.push(c); }
    _descendants(c, depth - 1, out, ctx);
  };
  for (const c of _asArray(node.children)) { if (c) { push(c); } }
  for (const list of Object.values(node.slots ?? {})) {
    for (const c of _asArray(list)) { if (c) { push(c); } }
  }
}

/**
 * Match one list of incoming children against one list of previous children,
 * then emit them. Tier 1 anchors first, then the exact pass, then the
 * gap-bounded similarity fill, then a shallow unwrap pass for the case where
 * the model removed a wrapper.
 */
function _reconcileList(
  ctx: Ctx,
  nextKids: DocNodeInput[],
  prevPool: DocNode[],
  pathBase: string,
  depth: number,
): DocNode[] {
  const n = nextKids.length;
  const cand = prevPool.filter(p => p && !ctx.claimed.has(p.mid) && !ctx.used.has(p.mid));
  const candAt = new Map<Mid, number>();
  for (let j = 0; j < cand.length; j++) { if (!candAt.has(cand[j].mid)) { candAt.set(cand[j].mid, j); } }
  const pairings: Array<Pairing | null> = new Array(n).fill(null);
  const taken = new Set<number>();
  const anchors: Array<{ i: number; j: number }> = [];

  // -- tier 1: verified echoes. These also act as ordering anchors. --
  for (let i = 0; i < n; i++) {
    const kid = nextKids[i];
    const m = kid?.mid;
    if (typeof m !== 'string' || !isMid(m) || !ctx.reserved.has(m) || ctx.claimed.has(m) || ctx.used.has(m)) { continue; }
    const p = ctx.prevByMid.get(m);
    if (!p || p.tag !== kid.tag) { continue; }
    pairings[i] = { prev: p, tier: 'echoed' };
    ctx.claimed.add(m);
    const j = candAt.get(m);
    if (j !== undefined && cand[j] === p) { taken.add(j); anchors.push({ i, j }); }
  }

  // -- tier 2 exact: same tag + (same key | identical text), position free --
  const buckets = new Map<string, number[]>();
  for (let j = 0; j < cand.length; j++) {
    if (taken.has(j)) { continue; }
    const k = _exactKey(cand[j]);
    if (!k) { continue; }
    const bucket = buckets.get(k);
    if (bucket) { bucket.push(j); } else { buckets.set(k, [j]); }
  }
  for (let i = 0; i < n; i++) {
    if (pairings[i]) { continue; }
    const k = _exactKey(nextKids[i]);
    if (!k) { continue; }
    const bucket = buckets.get(k);
    if (!bucket || bucket.length === 0) { continue; }
    let best = -1;
    let bestAt = -1;
    let bestD = Infinity;
    for (let bi = 0; bi < bucket.length; bi++) {
      const j = bucket[bi];
      if (taken.has(j)) { continue; }
      const d = Math.abs(j - i);
      if (d < bestD) { bestD = d; best = j; bestAt = bi; }
    }
    if (best < 0 || !_exactMatch(nextKids[i], cand[best])) { continue; }
    pairings[i] = { prev: cand[best], tier: 'exact' };
    ctx.claimed.add(cand[best].mid);
    taken.add(best);
    bucket.splice(bestAt, 1);
    anchors.push({ i, j: best });
  }

  // -- the LCS backbone bounds where the similarity fill may look --
  anchors.sort((a, b) => a.i - b.i);
  const spine = _backbone(anchors);
  const gapOf = (i: number): [number, number] => {
    let lo = -1;
    let hi = cand.length;
    for (const a of spine) {
      if (a.i < i) { lo = Math.max(lo, a.j); } else if (a.i > i) { hi = Math.min(hi, a.j); }
    }
    return [lo + 1, hi - 1];
  };

  // -- tier 2 fill: greedy, best score first, never below the threshold --
  const fills: Array<{ i: number; j: number; s: number; d: number }> = [];
  for (let i = 0; i < n; i++) {
    if (pairings[i]) { continue; }
    const [lo, hi] = gapOf(i);
    const from = Math.max(lo, 0, i - ctx.window);
    const to = Math.min(hi, cand.length - 1, i + ctx.window);
    for (let j = from; j <= to; j++) {
      if (taken.has(j)) { continue; }
      const s = similarity(nextKids[i], cand[j]);
      if (s > ctx.threshold) { fills.push({ i, j, s, d: Math.abs(i - j) }); }
    }
  }
  fills.sort((a, b) => b.s - a.s || a.d - b.d || a.i - b.i || a.j - b.j);
  const filled = new Set<number>();
  for (const f of fills) {
    if (filled.has(f.i) || taken.has(f.j)) { continue; }
    pairings[f.i] = { prev: cand[f.j], tier: 'similar' };
    ctx.claimed.add(cand[f.j].mid);
    filled.add(f.i);
    taken.add(f.j);
  }

  // -- unwrap: the model deleted a wrapper, so look one or two levels in.
  //    EXACT matches only — a similarity match across a level boundary is a
  //    guess, and this pass is the one that can move a pin. --
  const orphans: number[] = [];
  for (let i = 0; i < n; i++) { if (!pairings[i]) { orphans.push(i); } }
  if (orphans.length > 0) {
    const deep: DocNode[] = [];
    for (let j = 0; j < cand.length; j++) {
      if (!taken.has(j)) { _descendants(cand[j], UNWRAP_DEPTH, deep, ctx); }
    }
    if (deep.length > 0) {
      const deepBuckets = new Map<string, number[]>();
      for (let j = 0; j < deep.length; j++) {
        const k = _exactKey(deep[j]);
        if (!k) { continue; }
        const bucket = deepBuckets.get(k);
        if (bucket) { bucket.push(j); } else { deepBuckets.set(k, [j]); }
      }
      for (const i of orphans) {
        const k = _exactKey(nextKids[i]);
        if (!k) { continue; }
        const bucket = deepBuckets.get(k);
        while (bucket && bucket.length > 0) {
          const j = bucket.shift();
          if (j === undefined) { break; }
          const p = deep[j];
          if (ctx.claimed.has(p.mid) || ctx.used.has(p.mid) || !_exactMatch(nextKids[i], p)) { continue; }
          pairings[i] = { prev: p, tier: 'exact' };
          ctx.claimed.add(p.mid);
          break;
        }
      }
    }
  }

  // -- emit. Unmatched children inherit the leftover pool so an inserted
  //    wrapper hands its own children the ids it did not take. --
  const leftover = cand.filter((p, j) => !taken.has(j) && !ctx.claimed.has(p.mid));
  const out: DocNode[] = [];
  for (let i = 0; i < n; i++) {
    const pairing = pairings[i];
    out.push(_emit(ctx, nextKids[i], pairing, pairing ? [] : leftover, `${pathBase}/${i}`, depth));
  }
  return out;
}

function _emit(
  ctx: Ctx,
  next: DocNodeInput,
  pairing: Pairing | null,
  inheritedPool: DocNode[],
  path: string,
  depth: number,
): DocNode {
  // A pairing whose mid somehow already reached the output (a shared node
  // object appearing twice in `next`) is refused — uniqueness is the invariant
  // every anchor in the system rests on.
  const src = pairing && !ctx.used.has(pairing.prev.mid) ? pairing.prev : null;
  const tier: MatchTier = src && pairing ? pairing.tier : 'minted';
  const mid = src ? src.mid : _mint(ctx);

  ctx.used.add(mid);
  // Every dynamic-key write in this module goes through `putOwn`: a mid, a slot
  // name and a rejected claim are all strings that can arrive from a model or
  // from a hand-edited `artifact.json`, and `obj['__proto__'] = v` stores
  // nothing (or replaces the prototype) instead of creating the cell.
  putOwn(ctx.tiers, mid, tier);
  if (src) {
    ctx.carried++;
    ctx.matched.add(src.mid);
  } else {
    const claimed = typeof next.mid === 'string' ? next.mid : '';
    // Key by the rejected claim when nothing else kept it — that is the handle
    // the writer actually holds. Otherwise fall back to the structural path.
    const key = claimed && isMid(claimed) && !ctx.reserved.has(claimed)
      && !Object.prototype.hasOwnProperty.call(ctx.newMids, claimed) ? claimed : path;
    putOwn(ctx.newMids, key, mid);
  }

  const out: DocNode = { mid, tag: next.tag };
  if (next.props) { out.props = { ...next.props }; }
  if (next.style) { out.style = { ...next.style }; }
  if (typeof next.text === 'string') { out.text = next.text; }

  if (src) {
    const cells = pinnedCells(src);
    if (PIN_CARRYING_TIERS.has(tier)) {
      if (src.pins && cells.length > 0) { out.pins = { ...src.pins }; }
      if (src.by) { out.by = src.by; }
    } else if (cells.length > 0) {
      // Identity survived a weak match; ownership did not, and the human is told.
      ctx.dropped.push({ prevMid: src.mid, nowMid: mid, reason: 'weak-match', cells });
    }
  }

  const kids = _asArray(next.children).filter(Boolean);
  if (kids.length > 0) {
    if (depth >= ctx.maxDepth) {
      ctx.truncated++;
    } else {
      out.children = _reconcileList(ctx, kids, src ? _asArray(src.children) : inheritedPool, path, depth + 1);
    }
  }

  if (next.slots) {
    const slots: Record<string, DocNode[]> = {};
    for (const [name, list] of Object.entries(next.slots)) {
      const entries = _asArray(list).filter(Boolean);
      if (entries.length === 0) { continue; }
      if (depth >= ctx.maxDepth) { ctx.truncated++; continue; }
      putOwn(slots, name, _reconcileList(ctx, entries, _asArray(src?.slots?.[name]), `${path}/@${name}`, depth + 1));
    }
    if (Object.keys(slots).length > 0) { out.slots = slots; }
  }

  return out;
}

/* ----------------------------- entry point ----------------------------- */

/**
 * Give every node in `next` the identity it earned against `prev`.
 *
 * `next` is untrusted: it is whatever a model wrote, parsed by `PageCompiler`.
 * Every mid it carries is treated as a hint and verified; every mid in the
 * result is unique; pins move only on the two strongest tiers.
 */
export function reconcile(prev: DocNode, next: DocNodeInput, opts: ReconcileOptions = {}): ReconcileResult {
  const ctx: Ctx = {
    prevByMid: new Map<Mid, DocNode>(),
    reserved: new Set<Mid>(),
    claimed: new Set<Mid>(),
    used: new Set<Mid>(),
    matched: new Set<Mid>(),
    tiers: {},
    newMids: {},
    dropped: [],
    carried: 0,
    truncated: 0,
    threshold: typeof opts.threshold === 'number' ? opts.threshold : SIMILARITY_THRESHOLD,
    window: typeof opts.window === 'number' && opts.window >= 0 ? opts.window : DEFAULT_WINDOW,
    maxDepth: typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH,
    rand: opts.rand ?? Math.random,
    entropy: 0x811c9dc5,
  };

  // A malformed `prev` with duplicate mids resolves to its first occurrence;
  // the second copy simply never matches, rather than aliasing identity.
  for (const p of walk(prev)) {
    if (!ctx.prevByMid.has(p.mid)) { ctx.prevByMid.set(p.mid, p); }
  }

  // Tier-1 reservation, before any structural matching, so a tier-2 pass at a
  // shallow parent cannot consume a node that a deeper echo is about to claim.
  //
  // The ROOT's own claim is exempt unless it names the previous root. A root
  // that echoes some inner node's mid would otherwise retarget the whole
  // artboard's identity onto a `<span>` three levels down — every page-level
  // anchor and pin silently relocated. The root corresponds by position; a
  // claim that disagrees is simply not evidence about the root.
  let first = true;
  for (const nn of _walkInput(next)) {
    const isRoot = first;
    first = false;
    const m = nn?.mid;
    if (typeof m !== 'string' || !isMid(m) || ctx.reserved.has(m)) { continue; }
    if (isRoot && m !== prev.mid) { continue; }
    const p = ctx.prevByMid.get(m);
    if (p && p.tag === nn.tag) { ctx.reserved.add(m); }
  }

  // The root is the artboard: it corresponds by POSITION, not by content, so
  // tag equality alone makes it an exact match and its pins (a pinned page
  // background, say) survive a rewrite. A changed root tag is a genuine
  // replacement — the root mints, and its children still reconcile against the
  // previous root's children so the body of the design is not collateral.
  const rootMid = typeof next.mid === 'string' ? next.mid : '';
  let rootPairing: Pairing | null = null;
  if (prev.tag === next.tag) {
    rootPairing = { prev, tier: rootMid === prev.mid && isMid(rootMid) ? 'echoed' : 'exact' };
  }
  if (rootPairing) { ctx.claimed.add(rootPairing.prev.mid); }

  const doc = _emit(ctx, next, rootPairing, rootPairing ? [] : _asArray(prev.children), '#', 0);

  const lost: Mid[] = [];
  const seen = new Set<Mid>();
  for (const p of walk(prev)) {
    if (ctx.matched.has(p.mid) || seen.has(p.mid)) { continue; }
    seen.add(p.mid);
    lost.push(p.mid);
    const cells = pinnedCells(p);
    if (cells.length > 0) { ctx.dropped.push({ prevMid: p.mid, nowMid: null, reason: 'removed', cells }); }
  }

  return {
    doc,
    newMids: ctx.newMids,
    carried: ctx.carried,
    tiers: ctx.tiers,
    droppedPins: ctx.dropped,
    lost,
    truncated: ctx.truncated,
  };
}
