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
 * Plan 22 §3.1 — the document model. THE decision the whole plan turns on.
 *
 * Before this file, an `ArtifactPage` was `jsxSource: string` — one opaque blob.
 * Every canvas gap was downstream of that: element edits had nowhere to live
 * (so `elementOverrides` became a side-band no renderer ever read), "change this
 * button" was a whole-page rewrite that destroyed human tweaks, there was no
 * partial state so streaming was impossible, undo cost a 30 KB snapshot, and
 * conflict detection could only ever be page-scoped.
 *
 * A `DocNode` tree makes the element the addressable unit. Selection, the
 * properties panel, inline editing, comments, conflict, pins and undo are all
 * built on node identity — so identity is decided FIRST, here, and everything
 * else is derived from it.
 */

/**
 * A stable element id, minted host-side. 10 chars of lowercase base32.
 *
 * Deliberately NOT a DOM index path (`0.2.1`), which is what `harness.js`
 * writes today as `data-el`: an index path is a function of tree SHAPE, so it
 * silently retargets the moment an agent inserts a wrapper — every pin, comment
 * and override anchored to it would point at a different element with no error.
 */
export type Mid = string;

/** JSON-safe prop value. Props are literal data; behaviour lives in primitives. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Which cell of a node a human has taken ownership of.
 *
 * Addressed as `'text'`, `'style.<prop>'` or `'props.<name>'` so a pin is
 * per-cell, not per-node: a human who recolors a button still gets agent
 * updates to that button's label.
 */
export type PinCell = string;

export interface PinRecord {
  /** When the human set it. */
  at: number;
  /** The op that pinned it — so the UI can show "you changed this" precisely. */
  opId: string;
}

/**
 * One element in a page.
 *
 * `text` and `children` are mutually exclusive: a node is either a leaf holding
 * content or a container holding elements. Mixing them is what makes inline
 * editing ambiguous in DOM-shaped models.
 */
export interface DocNode {
  mid: Mid;
  /**
   * `'div' | 'h1' | 'img' | …` from the HTML allowlist, or `'UI.Card'` naming
   * one of the 22 primitives on `window.UI`.
   */
  tag: string;
  /** Literal props: `gap={20}`, `variant="secondary"`, `data={[…]}`. */
  props?: Record<string, JsonValue>;
  /** Filtered CSS subset. Theme tokens preferred over raw values. */
  style?: Record<string, string>;
  /** Leaf content — mutually exclusive with {@link children}. */
  text?: string;
  children?: DocNode[];
  /** JSX-valued props: `trailing={<UI.Text/>}`, `actions={[…]}`. */
  slots?: Record<string, DocNode[]>;
  /**
   * Cells a human owns. The differ EXCLUDES these from an agent's whole-page
   * rewrite diff, so a human's change is never even a candidate for reversion —
   * strictly stronger than reverting and replaying it afterwards.
   */
  pins?: Record<PinCell, PinRecord>;
  /** Who last wrote this node. Advisory (for UI affordances), never authority. */
  by?: 'agent' | 'user';
}

/** A node as it arrives from a model: `mid` is a HINT, children may be partial. */
export interface DocNodeInput {
  mid?: Mid;
  tag: string;
  props?: Record<string, JsonValue>;
  style?: Record<string, string>;
  text?: string;
  children?: DocNodeInput[];
  slots?: Record<string, DocNodeInput[]>;
}

/* ─────────────────────────────── mids ─────────────────────────────── */

const MID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const MID_LENGTH = 10;

/**
 * Mint a fresh mid.
 *
 * Not security-sensitive — a mid is an identity hint the host always verifies
 * against the live tree, never an authority. Forging one gains nothing because
 * pin enforcement is on the TARGET CELL, not on the claimed identity.
 */
export function mintMid(rand: () => number = Math.random): Mid {
  let out = '';
  for (let i = 0; i < MID_LENGTH; i++) {
    out += MID_ALPHABET[Math.floor(rand() * MID_ALPHABET.length) % MID_ALPHABET.length];
  }
  return out;
}

export function isMid(v: unknown): v is Mid {
  return typeof v === 'string' && v.length === MID_LENGTH && /^[a-z2-7]+$/.test(v);
}

/* ────────────────────────────── traversal ────────────────────────────── */

/** Every node in the tree, parents before children (slots included). */
export function* walk(root: DocNode): Generator<DocNode> {
  yield root;
  for (const child of root.children ?? []) { yield* walk(child); }
  for (const list of Object.values(root.slots ?? {})) {
    for (const child of list) { yield* walk(child); }
  }
}

/** Find a node by mid, or null. */
export function findNode(root: DocNode, mid: Mid): DocNode | null {
  for (const n of walk(root)) { if (n.mid === mid) { return n; } }
  return null;
}

/**
 * Find a node's parent and its position, or null for the root / a missing mid.
 * `slot` names the slot when the node lives in one rather than in `children`.
 */
export function findParent(
  root: DocNode,
  mid: Mid,
): { parent: DocNode; index: number; slot?: string } | null {
  for (const n of walk(root)) {
    const kids = n.children ?? [];
    const i = kids.findIndex(c => c.mid === mid);
    if (i >= 0) { return { parent: n, index: i }; }
    for (const [slot, list] of Object.entries(n.slots ?? {})) {
      const j = list.findIndex(c => c.mid === mid);
      if (j >= 0) { return { parent: n, index: j, slot }; }
    }
  }
  return null;
}

/** All mids in the tree. */
export function collectMids(root: DocNode): Set<Mid> {
  const out = new Set<Mid>();
  for (const n of walk(root)) { out.add(n.mid); }
  return out;
}

/**
 * Own-property write that survives a hostile key.
 *
 * Tags, prop names, style properties and slot names are all MODEL-AUTHORED
 * strings. Plain `obj[k] = v` with `k === '__proto__'` invokes the prototype
 * setter instead of creating a property, so the value silently disappears from
 * `Object.keys`/`Object.entries` — and a node parked in a `__proto__`-named slot
 * becomes unreachable to `walk`, which makes it un-addressable, un-removable and
 * un-undoable. Object spread and computed keys in literals already create own
 * properties; this is for the loop-assignment sites.
 */
export function putOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Structural deep clone. Cheaper and safer than JSON round-tripping. */
export function cloneNode(n: DocNode): DocNode {
  const out: DocNode = { mid: n.mid, tag: n.tag };
  if (n.props) { out.props = { ...n.props }; }
  if (n.style) { out.style = { ...n.style }; }
  if (n.text !== undefined) { out.text = n.text; }
  if (n.by) { out.by = n.by; }
  if (n.pins) { out.pins = { ...n.pins }; }
  if (n.children) { out.children = n.children.map(cloneNode); }
  if (n.slots) {
    const slots: Record<string, DocNode[]> = {};
    for (const [k, v] of Object.entries(n.slots)) { putOwn(slots, k, v.map(cloneNode)); }
    out.slots = slots;
  }
  return out;
}

/* ──────────────────────────────── pins ──────────────────────────────── */

/** Cell address for a style property. */
export const styleCell = (prop: string): PinCell => `style.${prop}`;
/** Cell address for a named prop. */
export const propCell = (name: string): PinCell => `props.${name}`;
/** Cell address for a node's text. */
export const TEXT_CELL: PinCell = 'text';

export function isPinned(n: DocNode, cell: PinCell): boolean {
  return !!n.pins && Object.prototype.hasOwnProperty.call(n.pins, cell);
}

/** Every pinned cell on a node, sorted for stable output. */
export function pinnedCells(n: DocNode): PinCell[] {
  return n.pins ? Object.keys(n.pins).sort() : [];
}
