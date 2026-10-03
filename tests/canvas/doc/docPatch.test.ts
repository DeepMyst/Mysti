/**
 * `DocPatch.applyOp` tests (Plan 22 §3.2 "Executor changes" item 1).
 *
 * The load-bearing claim of this module is a LAW, not a set of behaviours:
 *
 *     applyOp(applyOp(doc, op).doc, inverse).doc  ≡  doc
 *
 * so the bulk of this file is a property harness — a seeded generator that
 * builds trees (leaves, containers, slots, pins, nested JSON props) and then
 * synthesises valid ops against whatever tree it currently holds, chaining
 * eight ops per seed so later ops run against evolved shapes rather than the
 * pristine fixture. Every step asserts the law, plus purity (the input tree is
 * untouched and shares no object with the output, and neither does the op
 * payload or the inverse's payload) and mid uniqueness.
 *
 * The hand-written suites below it exist for the cases a generator cannot be
 * trusted to hit on its own: the two inverses that must degrade to `el.replace`
 * because the op algebra literally cannot say "make this absent again", anchor
 * rebasing, cycles, mid collisions, and every typed failure code.
 */
import { describe, it, expect } from 'vitest';
import {
  applyOp,
  cloneForPayload,
  isDocPatchError,
  isDocScopedOp,
  isStaleDocPatchError,
  normalizeDoc,
  sanitizeNodeInput,
  DocPatchError,
  PAYLOAD_ROOT_KEY,
} from '../../../src/canvas/doc/DocPatch';
import type { DocPatchErrorCode } from '../../../src/canvas/doc/DocPatch';
import { collectMids, findNode, walk } from '../../../src/canvas/doc/DocNode';
import type { DocNode, DocNodeInput, JsonValue, Mid } from '../../../src/canvas/doc/DocNode';
import type { CanvasOp } from '../../../src/canvas/CanvasOps';

/* ────────────────────────────── helpers ────────────────────────────── */

const PAGE = 'page-1';

/** Deterministic PRNG — a failing seed is a reproducible failing seed. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length) % xs.length];
}

/** Mid source for payloads and for `applyOp`'s minting — one counter per run. */
function counterMinter(prefix: string): () => Mid {
  let i = 0;
  return () => `${prefix}${i++}`;
}

/** Every object reachable from a tree: nodes, arrays, prop values, pin records. */
function collectRefs(root: DocNode): Set<object> {
  const out = new Set<object>();
  const json = (v: unknown): void => {
    if (!v || typeof v !== 'object') { return; }
    out.add(v);
    for (const x of Object.values(v as Record<string, unknown>)) { json(x); }
  };
  for (const n of walk(root)) {
    out.add(n);
    if (n.props) { out.add(n.props); for (const v of Object.values(n.props)) { json(v); } }
    if (n.style) { out.add(n.style); }
    if (n.pins) { out.add(n.pins); for (const r of Object.values(n.pins)) { out.add(r); } }
    if (n.children) { out.add(n.children); }
    if (n.slots) { out.add(n.slots); for (const l of Object.values(n.slots)) { out.add(l); } }
  }
  return out;
}

function sharedRefs(a: Set<object>, b: Set<object>): object[] {
  const out: object[] = [];
  for (const x of a) { if (b.has(x)) { out.push(x); } }
  return out;
}

function midList(root: DocNode): Mid[] {
  return [...walk(root)].map(n => n.mid);
}

/** The error code a call throws, or a marker — keeps assertions readable. */
function codeOf(fn: () => unknown): DocPatchErrorCode | string {
  try {
    fn();
    return 'DID-NOT-THROW';
  } catch (e) {
    return isDocPatchError(e) ? e.code : `other:${String(e)}`;
  }
}

/* ───────────────────────────── generators ───────────────────────────── */

const TAGS = ['div', 'section', 'h1', 'UI.Card', 'UI.Button', 'UI.Text', 'UI.Row'];
const STYLE_KEYS = ['background', 'color', 'padding', 'gap', 'border-radius'];
const PROP_NAMES = ['label', 'gap', 'variant', 'data', 'nil'];
const SLOT_NAMES = ['actions', 'trailing'];

function genJson(rnd: () => number, depth: number): JsonValue {
  const roll = rnd();
  if (depth >= 2 || roll < 0.4) {
    if (roll < 0.1) { return null; }
    if (roll < 0.2) { return Math.floor(rnd() * 100); }
    if (roll < 0.3) { return rnd() < 0.5; }
    return `s${Math.floor(rnd() * 1000)}`;
  }
  if (roll < 0.7) {
    return Array.from({ length: Math.floor(rnd() * 3) }, () => genJson(rnd, depth + 1));
  }
  const out: { [k: string]: JsonValue } = {};
  const n = 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) { out[`k${i}`] = genJson(rnd, depth + 1); }
  return out;
}

/** A tree with unique mids, pins, slots, nested props — already normalized. */
function genDoc(rnd: () => number, mid: () => Mid, depth = 0): DocNode {
  const node: DocNode = { mid: mid(), tag: pick(rnd, TAGS) };
  if (rnd() < 0.6) {
    const props: Record<string, JsonValue> = {};
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) { props[pick(rnd, PROP_NAMES)] = genJson(rnd, 1); }
    node.props = props;
  }
  if (rnd() < 0.6) {
    const style: Record<string, string> = {};
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) { style[pick(rnd, STYLE_KEYS)] = `v${Math.floor(rnd() * 100)}`; }
    node.style = style;
  }
  if (rnd() < 0.25) { node.by = rnd() < 0.5 ? 'user' : 'agent'; }
  if (rnd() < 0.25) {
    node.pins = { [`style.${pick(rnd, STYLE_KEYS)}`]: { at: Math.floor(rnd() * 1e6), opId: `op${Math.floor(rnd() * 100)}` } };
  }
  const leaf = depth >= 3 || rnd() < 0.4;
  if (leaf) {
    if (rnd() < 0.8) { node.text = `t${Math.floor(rnd() * 1000)}`; }
  } else {
    const n = 1 + Math.floor(rnd() * 3);
    node.children = Array.from({ length: n }, () => genDoc(rnd, mid, depth + 1));
  }
  if (rnd() < 0.25) {
    node.slots = { [pick(rnd, SLOT_NAMES)]: [genDoc(rnd, mid, depth + 2)] };
  }
  return node;
}

/** A payload for insert/replace: mids sometimes omitted, sometimes colliding. */
function genInput(rnd: () => number, mid: () => Mid, collide: Mid[], depth = 0): DocNodeInput {
  const node: DocNodeInput = { tag: pick(rnd, TAGS) };
  const roll = rnd();
  if (roll < 0.5) { node.mid = mid(); }
  else if (roll < 0.65 && collide.length > 0) { node.mid = pick(rnd, collide); }
  // else: no mid at all → must be minted, keyed by payload path
  if (rnd() < 0.5) { node.props = { label: `l${Math.floor(rnd() * 100)}`, data: genJson(rnd, 1) }; }
  if (rnd() < 0.5) { node.style = { color: `c${Math.floor(rnd() * 100)}` }; }
  const leaf = depth >= 2 || rnd() < 0.5;
  if (leaf) { node.text = `x${Math.floor(rnd() * 100)}`; }
  else { node.children = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => genInput(rnd, mid, collide, depth + 1)); }
  if (rnd() < 0.2) { node.slots = { actions: [genInput(rnd, mid, collide, depth + 2)] }; }
  return node;
}

const OP_KINDS = [
  'el.setText', 'el.setStyle', 'el.setProp', 'el.insert',
  'el.remove', 'el.move', 'el.replace', 'page.setDoc',
] as const;
type DocOpKind = typeof OP_KINDS[number];

/** A VALID op against `doc` — the harness must never manufacture a failure. */
function genOp(rnd: () => number, doc: DocNode, kind: DocOpKind, mid: () => Mid): CanvasOp | null {
  const nodes = [...walk(doc)];
  const nonRoot = nodes.filter(n => n.mid !== doc.mid);
  const existing = midList(doc);

  switch (kind) {
    case 'el.setText': {
      const cands = nodes.filter(n => !n.children || n.children.length === 0);
      if (cands.length === 0) { return null; }
      return { op: 'el.setText', pageId: PAGE, mid: pick(rnd, cands).mid, text: `T${Math.floor(rnd() * 1000)}` };
    }
    case 'el.setStyle': {
      const target = pick(rnd, nodes);
      const style: Record<string, string | null> = {};
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        style[pick(rnd, STYLE_KEYS)] = rnd() < 0.4 ? null : `w${Math.floor(rnd() * 100)}`;
      }
      if (target.style && rnd() < 0.6) { style[pick(rnd, Object.keys(target.style))] = null; }
      return { op: 'el.setStyle', pageId: PAGE, mid: target.mid, style };
    }
    case 'el.setProp': {
      const target = pick(rnd, nodes);
      const own = target.props ? Object.keys(target.props) : [];
      const name = own.length > 0 && rnd() < 0.6 ? pick(rnd, own) : pick(rnd, PROP_NAMES);
      const value = rnd() < 0.25 ? null : genJson(rnd, 1);
      return { op: 'el.setProp', pageId: PAGE, mid: target.mid, name, value };
    }
    case 'el.insert': {
      const useSlot = rnd() < 0.25;
      const cands = useSlot ? nodes : nodes.filter(n => n.text === undefined);
      if (cands.length === 0) { return null; }
      const parent = pick(rnd, cands);
      const slot = useSlot ? pick(rnd, SLOT_NAMES) : undefined;
      const list = (slot === undefined ? parent.children : parent.slots?.[slot]) ?? [];
      const before: Mid | 'end' = list.length > 0 && rnd() < 0.6 ? pick(rnd, list).mid : 'end';
      const node = genInput(rnd, mid, existing);
      return slot === undefined
        ? { op: 'el.insert', pageId: PAGE, parentMid: parent.mid, before, node }
        : { op: 'el.insert', pageId: PAGE, parentMid: parent.mid, before, node, slot };
    }
    case 'el.remove': {
      if (nonRoot.length === 0) { return null; }
      return { op: 'el.remove', pageId: PAGE, mid: pick(rnd, nonRoot).mid };
    }
    case 'el.move': {
      if (nonRoot.length === 0) { return null; }
      const moving = pick(rnd, nonRoot);
      const inside = collectMids(moving);
      const useSlot = rnd() < 0.2;
      const cands = nodes.filter(p => !inside.has(p.mid) && (useSlot || p.text === undefined));
      if (cands.length === 0) { return null; }
      const parent = pick(rnd, cands);
      const slot = useSlot ? pick(rnd, SLOT_NAMES) : undefined;
      const list = (slot === undefined ? parent.children : parent.slots?.[slot]) ?? [];
      // Anchors are drawn from the DESTINATION list only, so `before === mid`
      // can only ever occur where it is legal: the node's own list.
      const before: Mid | 'end' = list.length > 0 && rnd() < 0.7 ? pick(rnd, list).mid : 'end';
      return slot === undefined
        ? { op: 'el.move', pageId: PAGE, mid: moving.mid, newParentMid: parent.mid, before }
        : { op: 'el.move', pageId: PAGE, mid: moving.mid, newParentMid: parent.mid, before, slot };
    }
    case 'el.replace': {
      const target = pick(rnd, nodes);
      return { op: 'el.replace', pageId: PAGE, mid: target.mid, node: genInput(rnd, mid, existing) };
    }
    case 'page.setDoc':
      return { op: 'page.setDoc', pageId: PAGE, doc: genDoc(rnd, mid) };
  }
}

/* ───────────────────────── the invertibility law ───────────────────────── */

describe('applyOp — the exact-invertibility law over generated docs and ops', () => {
  it('inverts every op exactly, stays pure, and keeps mids unique', () => {
    const counts: Record<DocOpKind, number> = {
      'el.setText': 0, 'el.setStyle': 0, 'el.setProp': 0, 'el.insert': 0,
      'el.remove': 0, 'el.move': 0, 'el.replace': 0, 'page.setDoc': 0,
    };
    const mint = counterMinter('z');
    const payloadMid = counterMinter('p');
    let checked = 0;

    for (let seed = 1; seed <= 80; seed++) {
      const rnd = lcg(seed);
      let doc = genDoc(rnd, counterMinter(`s${seed}n`));

      for (let step = 0; step < 8; step++) {
        const kind = OP_KINDS[(step + seed) % OP_KINDS.length];
        const op = genOp(rnd, doc, kind, payloadMid);
        if (!op) { continue; }

        const beforeJson = JSON.stringify(doc);
        const beforeRefs = collectRefs(doc);
        const opRefs = 'node' in op ? collectRefs(op.node as DocNode) : ('doc' in op ? collectRefs(op.doc) : new Set<object>());

        const where = `seed ${seed} step ${step} ${op.op}`;
        const res = applyOp(doc, op, { mintMid: mint });

        // Purity: the input tree is byte-identical and structurally unshared.
        expect(JSON.stringify(doc), where).toBe(beforeJson);
        expect(sharedRefs(beforeRefs, collectRefs(res.doc)), where).toEqual([]);
        // …and the result never aliases the op payload either, so mutating a
        // persisted op record can never reach into the live document.
        expect(sharedRefs(opRefs, collectRefs(res.doc)), where).toEqual([]);

        // Mids stay unique.
        const mids = midList(res.doc);
        expect(new Set(mids).size, `${where} duplicate mids`).toBe(mids.length);
        // Every minted id is really in the tree.
        for (const minted of Object.values(res.newMids)) {
          expect(findNode(res.doc, minted), `${where} newMids ${minted}`).not.toBeNull();
        }

        // THE LAW.
        const back = applyOp(res.doc, res.inverse, { mintMid: mint });
        expect(back.doc, `${where} did not invert exactly`).toStrictEqual(normalizeDoc(doc));

        counts[kind]++;
        checked++;
        doc = res.doc;
      }
    }

    expect(checked).toBeGreaterThan(400);
    for (const kind of OP_KINDS) {
      expect(counts[kind], `generator never produced ${kind}`).toBeGreaterThan(20);
    }
    // 640 ops × (2 applies + 3 full-tree ref scans) runs in ~200 ms alone, but
    // vitest's 5 s default is per-test and this file competes with 165 others
    // for CPU — an explicit budget keeps a green suite from flaking red.
  }, 30_000);
});

/* ─────────────────────────── fixture helpers ─────────────────────────── */

/**
 * a
 * ├─ b  "hello"
 * ├─ c  (style/props)
 * │   └─ d "deep"
 * └─ slots.actions: [e "act"]
 */
function fixture(): DocNode {
  return {
    mid: 'a',
    tag: 'UI.Card',
    props: { gap: 20 },
    children: [
      { mid: 'b', tag: 'UI.Text', text: 'hello' },
      {
        mid: 'c',
        tag: 'UI.Row',
        style: { background: '#fff', padding: '8px' },
        props: { variant: 'secondary', data: [{ label: 'Jan', value: 22 }] },
        children: [{ mid: 'd', tag: 'UI.Text', text: 'deep' }],
      },
    ],
    slots: { actions: [{ mid: 'e', tag: 'UI.Button', text: 'act' }] },
  };
}

function roundTrip(doc: DocNode, op: CanvasOp, mint?: () => Mid): DocNode {
  const res = applyOp(doc, op, mint ? { mintMid: mint } : {});
  return applyOp(res.doc, res.inverse, mint ? { mintMid: mint } : {}).doc;
}

/* ─────────────────────────────── el.setText ─────────────────────────────── */

describe('el.setText', () => {
  it('sets text and inverts through el.setText when text already existed', () => {
    const doc = fixture();
    const res = applyOp(doc, { op: 'el.setText', pageId: PAGE, mid: 'b', text: 'Get started' });
    expect(findNode(res.doc, 'b')?.text).toBe('Get started');
    expect(res.inverse).toEqual({ op: 'el.setText', pageId: PAGE, mid: 'b', text: 'hello' });
    expect(res.newMids).toEqual({});
    expect(roundTrip(doc, { op: 'el.setText', pageId: PAGE, mid: 'b', text: 'Get started' })).toStrictEqual(doc);
  });

  it('inverts through el.replace when the node had NO text (absence is not sayable)', () => {
    const doc: DocNode = { mid: 'a', tag: 'div', style: { color: 'red' } };
    const res = applyOp(doc, { op: 'el.setText', pageId: PAGE, mid: 'a', text: 'hi' });
    expect(res.inverse.op).toBe('el.replace');
    const back = applyOp(res.doc, res.inverse).doc;
    expect(back).toStrictEqual(doc);
    expect(back.text).toBeUndefined();
  });

  it('refuses a container — text and children are mutually exclusive', () => {
    expect(codeOf(() => applyOp(fixture(), { op: 'el.setText', pageId: PAGE, mid: 'c', text: 'x' }))).toBe('invalid-target');
  });

  it('allows text on a node that only has slots', () => {
    const doc: DocNode = { mid: 'a', tag: 'UI.Button', slots: { trailing: [{ mid: 'i', tag: 'UI.Badge', text: '3' }] } };
    const res = applyOp(doc, { op: 'el.setText', pageId: PAGE, mid: 'a', text: 'Save' });
    expect(res.doc.text).toBe('Save');
    expect(res.doc.slots?.trailing[0].mid).toBe('i');
  });

  it('reports a vanished mid as a stale-class failure, never a silent no-op', () => {
    let caught: unknown;
    try { applyOp(fixture(), { op: 'el.setText', pageId: PAGE, mid: 'nope', text: 'x' }); } catch (e) { caught = e; }
    expect(isDocPatchError(caught)).toBe(true);
    expect((caught as DocPatchError).code).toBe('missing-mid');
    expect((caught as DocPatchError).mid).toBe('nope');
    expect(isStaleDocPatchError(caught)).toBe(true);
    expect((caught as DocPatchError).message).toContain('[Mysti]');
  });
});

/* ─────────────────────────────── el.setStyle ─────────────────────────────── */

describe('el.setStyle', () => {
  it('sets, deletes with null, and inverts both directions in one patch', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.setStyle', pageId: PAGE, mid: 'c', style: { background: null, color: 'blue' } };
    const res = applyOp(doc, op);
    expect(findNode(res.doc, 'c')?.style).toEqual({ padding: '8px', color: 'blue' });
    expect(res.inverse).toEqual({ op: 'el.setStyle', pageId: PAGE, mid: 'c', style: { background: '#fff', color: null } });
    expect(roundTrip(doc, op)).toStrictEqual(doc);
  });

  it('drops the style key entirely when the last property is deleted, and restores it', () => {
    const doc: DocNode = { mid: 'a', tag: 'div', style: { color: 'red' } };
    const op: CanvasOp = { op: 'el.setStyle', pageId: PAGE, mid: 'a', style: { color: null } };
    const res = applyOp(doc, op);
    expect('style' in res.doc).toBe(false);
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('creates the style key on a node that had none, and the inverse removes it again', () => {
    const doc: DocNode = { mid: 'a', tag: 'div' };
    const op: CanvasOp = { op: 'el.setStyle', pageId: PAGE, mid: 'a', style: { gap: '4px' } };
    const res = applyOp(doc, op);
    expect(res.doc.style).toEqual({ gap: '4px' });
    expect(res.inverse).toEqual({ op: 'el.setStyle', pageId: PAGE, mid: 'a', style: { gap: null } });
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('treats an empty patch as a no-op with an empty inverse', () => {
    const doc = fixture();
    const res = applyOp(doc, { op: 'el.setStyle', pageId: PAGE, mid: 'c', style: {} });
    expect(res.doc).toStrictEqual(doc);
    expect(res.inverse).toEqual({ op: 'el.setStyle', pageId: PAGE, mid: 'c', style: {} });
  });

  it('deleting an absent property is a no-op that still inverts', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.setStyle', pageId: PAGE, mid: 'b', style: { gap: null } };
    expect(applyOp(doc, op).doc).toStrictEqual(doc);
    expect(roundTrip(doc, op)).toStrictEqual(doc);
  });
});

/* ─────────────────────────────── el.setProp ─────────────────────────────── */

describe('el.setProp', () => {
  it('sets a new prop; the inverse deletes it', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.setProp', pageId: PAGE, mid: 'b', name: 'label', value: 'Hi' };
    const res = applyOp(doc, op);
    expect(findNode(res.doc, 'b')?.props).toEqual({ label: 'Hi' });
    expect(res.inverse).toEqual({ op: 'el.setProp', pageId: PAGE, mid: 'b', name: 'label', value: null });
    expect(roundTrip(doc, op)).toStrictEqual(doc);
  });

  it('null deletes; the inverse restores the previous value, deep-cloned', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.setProp', pageId: PAGE, mid: 'c', name: 'data', value: null };
    const res = applyOp(doc, op);
    expect(findNode(res.doc, 'c')?.props).toEqual({ variant: 'secondary' });
    expect(res.inverse).toEqual({
      op: 'el.setProp', pageId: PAGE, mid: 'c', name: 'data', value: [{ label: 'Jan', value: 22 }],
    });
    // The captured previous value must not alias the input tree.
    const captured = (res.inverse as Extract<CanvasOp, { op: 'el.setProp' }>).value;
    expect(captured).not.toBe(fixture().children![1].props!.data);
    expect(roundTrip(doc, op)).toStrictEqual(doc);
  });

  it('drops the props key when the last prop is deleted, and restores it', () => {
    const doc: DocNode = { mid: 'a', tag: 'div', props: { gap: 4 } };
    const res = applyOp(doc, { op: 'el.setProp', pageId: PAGE, mid: 'a', name: 'gap', value: null });
    expect('props' in res.doc).toBe(false);
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('inverts through el.replace when the previous value was a JSON null (null means DELETE here)', () => {
    const doc: DocNode = { mid: 'a', tag: 'div', props: { nil: null, keep: 1 } };
    const res = applyOp(doc, { op: 'el.setProp', pageId: PAGE, mid: 'a', name: 'nil', value: 'now-set' });
    expect(res.inverse.op).toBe('el.replace');
    const back = applyOp(res.doc, res.inverse).doc;
    expect(back).toStrictEqual(doc);
    expect(back.props).toEqual({ nil: null, keep: 1 });
  });

  it('deleting an absent prop is a no-op that still inverts', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.setProp', pageId: PAGE, mid: 'b', name: 'ghost', value: null };
    expect(applyOp(doc, op).doc).toStrictEqual(doc);
    expect(roundTrip(doc, op)).toStrictEqual(doc);
  });
});

/* ──────────────────────────────── el.insert ──────────────────────────────── */

describe('el.insert — anchor-relative, never an integer index', () => {
  it('inserts before a sibling anchor and inverts to a remove of the real mid', () => {
    const doc = fixture();
    const mint = counterMinter('z');
    const op: CanvasOp = {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'c', node: { tag: 'UI.Badge', text: 'new' },
    };
    const res = applyOp(doc, op, { mintMid: mint });
    expect(res.doc.children!.map(c => c.mid)).toEqual(['b', 'z0', 'c']);
    expect(res.newMids).toEqual({ [PAYLOAD_ROOT_KEY]: 'z0' });
    expect(res.inverse).toEqual({ op: 'el.remove', pageId: PAGE, mid: 'z0' });
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it("appends on 'end'", () => {
    const res = applyOp(fixture(), {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: { mid: 'q', tag: 'div' },
    });
    expect(res.doc.children!.map(c => c.mid)).toEqual(['b', 'c', 'q']);
    expect(res.newMids).toEqual({});
  });

  it('rebases correctly by construction: the anchor survives a sibling insert', () => {
    // A human inserts at index 0; the agent's anchor-relative op still lands
    // before `c`, where an integer index 1 would have retargeted onto it.
    const human = applyOp(fixture(), {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'b', node: { mid: 'h', tag: 'div' },
    }).doc;
    const agent = applyOp(human, {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'c', node: { mid: 'g', tag: 'div' },
    }).doc;
    expect(agent.children!.map(c => c.mid)).toEqual(['h', 'b', 'g', 'c']);
  });

  it('creates children on a node that had none; the inverse deletes the key again', () => {
    const doc: DocNode = { mid: 'a', tag: 'div' };
    const res = applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: { mid: 'k', tag: 'span' } });
    expect(res.doc.children!.map(c => c.mid)).toEqual(['k']);
    const back = applyOp(res.doc, res.inverse).doc;
    expect(back).toStrictEqual(doc);
    expect('children' in back).toBe(false);
  });

  it('creates and prunes a slot list', () => {
    const doc = fixture();
    const op: CanvasOp = {
      op: 'el.insert', pageId: PAGE, parentMid: 'b', before: 'end', node: { mid: 'ic', tag: 'UI.Badge', text: '9' }, slot: 'trailing',
    };
    const res = applyOp(doc, op);
    expect(findNode(res.doc, 'b')?.slots).toEqual({ trailing: [{ mid: 'ic', tag: 'UI.Badge', text: '9' }] });
    const back = applyOp(res.doc, res.inverse).doc;
    expect(back).toStrictEqual(doc);
    expect('slots' in findNode(back, 'b')!).toBe(false);
  });

  it('mints ids for every node lacking one, keyed by payload path', () => {
    const mint = counterMinter('z');
    const res = applyOp(fixture(), {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end',
      node: {
        tag: 'UI.Row',
        children: [{ tag: 'UI.Text', text: 'one' }, { mid: 'kept', tag: 'UI.Text', text: 'two' }],
        slots: { actions: [{ tag: 'UI.Button', text: 'go' }] },
      },
    }, { mintMid: mint });
    expect(res.newMids).toEqual({ '$': 'z0', '$/0': 'z1', '$/@actions/0': 'z2' });
    expect(midList(res.doc)).toContain('kept');
  });

  it('re-mints a payload mid that collides with the live tree, keyed by the mid sent', () => {
    const mint = counterMinter('z');
    const res = applyOp(fixture(), {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: { mid: 'b', tag: 'div' },
    }, { mintMid: mint });
    expect(res.newMids).toEqual({ b: 'z0' });
    expect(res.doc.children!.map(c => c.mid)).toEqual(['b', 'c', 'z0']);
    expect(midList(res.doc).filter(m => m === 'b')).toHaveLength(1);
  });

  it('re-mints a mid duplicated INSIDE one payload, falling back to the path key', () => {
    const mint = counterMinter('z');
    const res = applyOp(fixture(), {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end',
      node: { mid: 'dup', tag: 'div', children: [{ mid: 'dup', tag: 'span', text: 'x' }, { mid: 'dup', tag: 'span', text: 'y' }] },
    }, { mintMid: mint });
    expect(res.newMids).toEqual({ dup: 'z0', '$/1': 'z1' });
    const mids = midList(res.doc);
    expect(new Set(mids).size).toBe(mids.length);
  });

  it('refuses a missing parent (stale) and a missing anchor (stale)', () => {
    const doc = fixture();
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'ghost', before: 'end', node: { tag: 'div' } }))).toBe('missing-mid');
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'ghost', node: { tag: 'div' } }))).toBe('missing-anchor');
    // An anchor in a DIFFERENT list is not an anchor.
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'e', node: { tag: 'div' } }))).toBe('missing-anchor');
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'b', before: 'x', node: { tag: 'div' }, slot: 'nope' }))).toBe('missing-anchor');
  });

  it('refuses to give children to a text leaf, but allows a slot on one', () => {
    const doc = fixture();
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'b', before: 'end', node: { tag: 'div' } }))).toBe('invalid-target');
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'b', before: 'end', node: { tag: 'div' }, slot: 'trailing' }))).toBe('DID-NOT-THROW');
  });

  it('refuses a malformed payload', () => {
    const doc = fixture();
    const bad = { tag: 'div', text: 'x', children: [{ tag: 'span' }] } as DocNodeInput;
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: bad }))).toBe('invalid-node');
    expect(codeOf(() => applyOp(doc, { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: { tag: '' } }))).toBe('invalid-node');
    expect(codeOf(() => applyOp(doc, {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: null as unknown as DocNodeInput,
    }))).toBe('invalid-node');
  });

  it('gives up honestly when the mid generator cannot produce a free id', () => {
    expect(codeOf(() => applyOp(fixture(), {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: { tag: 'div' },
    }, { mintMid: () => 'b' }))).toBe('mint-failed');
  });
});

/* ──────────────────────────────── el.remove ──────────────────────────────── */

describe('el.remove', () => {
  it('captures the FOLLOWING sibling as the undo anchor', () => {
    const res = applyOp(fixture(), { op: 'el.remove', pageId: PAGE, mid: 'b' });
    expect(res.inverse).toEqual({
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'c',
      node: { mid: 'b', tag: 'UI.Text', text: 'hello' },
    });
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(fixture());
  });

  it("uses 'end' when the node was last", () => {
    const res = applyOp(fixture(), { op: 'el.remove', pageId: PAGE, mid: 'c' });
    expect((res.inverse as Extract<CanvasOp, { op: 'el.insert' }>).before).toBe('end');
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(fixture());
  });

  it('restores the whole subtree, its mids, its pins and its `by` on undo', () => {
    const doc = fixture();
    doc.children![1].pins = { 'style.background': { at: 42, opId: 'op-7' } };
    doc.children![1].by = 'user';
    const res = applyOp(doc, { op: 'el.remove', pageId: PAGE, mid: 'c' });
    expect(findNode(res.doc, 'd')).toBeNull();
    const back = applyOp(res.doc, res.inverse).doc;
    expect(back).toStrictEqual(doc);
    // The human's ownership record must survive an undo — dropping it would
    // silently hand the cell back to the agent (§3.5).
    expect(findNode(back, 'c')?.pins).toEqual({ 'style.background': { at: 42, opId: 'op-7' } });
    expect(findNode(back, 'c')?.by).toBe('user');
  });

  it('round-trips a slot member, pruning and recreating the slot', () => {
    const doc = fixture();
    const res = applyOp(doc, { op: 'el.remove', pageId: PAGE, mid: 'e' });
    expect('slots' in res.doc).toBe(false);
    expect((res.inverse as Extract<CanvasOp, { op: 'el.insert' }>).slot).toBe('actions');
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('refuses the document root and a vanished mid', () => {
    expect(codeOf(() => applyOp(fixture(), { op: 'el.remove', pageId: PAGE, mid: 'a' }))).toBe('invalid-target');
    expect(codeOf(() => applyOp(fixture(), { op: 'el.remove', pageId: PAGE, mid: 'ghost' }))).toBe('missing-mid');
  });

  it('does not alias the live tree into the inverse payload', () => {
    const doc = fixture();
    const res = applyOp(doc, { op: 'el.remove', pageId: PAGE, mid: 'c' });
    const payload = (res.inverse as Extract<CanvasOp, { op: 'el.insert' }>).node as DocNode;
    expect(sharedRefs(collectRefs(payload), collectRefs(doc))).toEqual([]);
    expect(sharedRefs(collectRefs(payload), collectRefs(res.doc))).toEqual([]);
  });
});

/* ───────────────────────────────── el.move ───────────────────────────────── */

describe('el.move', () => {
  it('moves across parents and inverts back to the original anchor', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'c', before: 'd' };
    const res = applyOp(doc, op);
    expect(findNode(res.doc, 'c')!.children!.map(c => c.mid)).toEqual(['b', 'd']);
    expect(res.doc.children!.map(c => c.mid)).toEqual(['c']);
    expect(res.inverse).toEqual({ op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'a', before: 'c' });
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('reorders within one list', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.move', pageId: PAGE, mid: 'c', newParentMid: 'a', before: 'b' };
    const res = applyOp(doc, op);
    expect(res.doc.children!.map(c => c.mid)).toEqual(['c', 'b']);
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('treats "before myself" as staying put, and inverts to identity', () => {
    const doc = fixture();
    const res = applyOp(doc, { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'a', before: 'b' });
    expect(res.doc).toStrictEqual(doc);
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('refuses "before myself" when the destination is a different list', () => {
    expect(codeOf(() => applyOp(fixture(), { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'c', before: 'b' }))).toBe('missing-anchor');
  });

  it('moves into a slot and back out, pruning and recreating both lists', () => {
    const doc: DocNode = { mid: 'a', tag: 'div', children: [{ mid: 'b', tag: 'span', text: 'x' }] };
    const op: CanvasOp = { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'a', before: 'end', slot: 'actions' };
    const res = applyOp(doc, op);
    expect('children' in res.doc).toBe(false);
    expect(res.doc.slots).toEqual({ actions: [{ mid: 'b', tag: 'span', text: 'x' }] });
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('refuses a cycle: into itself or into its own descendant', () => {
    expect(codeOf(() => applyOp(fixture(), { op: 'el.move', pageId: PAGE, mid: 'c', newParentMid: 'd', before: 'end' }))).toBe('invalid-target');
    expect(codeOf(() => applyOp(fixture(), { op: 'el.move', pageId: PAGE, mid: 'c', newParentMid: 'c', before: 'end' }))).toBe('invalid-target');
  });

  it('refuses the root, a vanished node, a vanished parent, a bad anchor and a text destination', () => {
    const doc = fixture();
    expect(codeOf(() => applyOp(doc, { op: 'el.move', pageId: PAGE, mid: 'a', newParentMid: 'c', before: 'end' }))).toBe('invalid-target');
    expect(codeOf(() => applyOp(doc, { op: 'el.move', pageId: PAGE, mid: 'ghost', newParentMid: 'c', before: 'end' }))).toBe('missing-mid');
    expect(codeOf(() => applyOp(doc, { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'ghost', before: 'end' }))).toBe('missing-mid');
    expect(codeOf(() => applyOp(doc, { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'c', before: 'ghost' }))).toBe('missing-anchor');
    expect(codeOf(() => applyOp(doc, { op: 'el.move', pageId: PAGE, mid: 'c', newParentMid: 'b', before: 'end' }))).toBe('invalid-target');
  });

  it('leaves the input tree untouched even when it throws late (after the internal splice)', () => {
    const doc = fixture();
    const json = JSON.stringify(doc);
    expect(codeOf(() => applyOp(doc, { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'c', before: 'ghost' }))).toBe('missing-anchor');
    expect(JSON.stringify(doc)).toBe(json);
  });
});

/* ─────────────────────────────── el.replace ─────────────────────────────── */

describe('el.replace', () => {
  it('preserves the target mid — identity is what selection, pins and anchors hang on', () => {
    const doc = fixture();
    const res = applyOp(doc, { op: 'el.replace', pageId: PAGE, mid: 'c', node: { mid: 'whatever', tag: 'UI.Hero', text: 'new' } });
    const swapped = findNode(res.doc, 'c');
    expect(swapped).toEqual({ mid: 'c', tag: 'UI.Hero', text: 'new' });
    expect(findNode(res.doc, 'whatever')).toBeNull();
    expect(res.newMids).toEqual({ whatever: 'c' });
    expect(res.doc.children!.map(c => c.mid)).toEqual(['b', 'c']);
  });

  it('inverts exactly, restoring the replaced subtree with its mids and pins', () => {
    const doc = fixture();
    doc.children![1].pins = { 'props.variant': { at: 9, opId: 'op-1' } };
    const op: CanvasOp = { op: 'el.replace', pageId: PAGE, mid: 'c', node: { tag: 'div', text: 'gone' } };
    const res = applyOp(doc, op);
    expect(findNode(res.doc, 'd')).toBeNull();
    const back = applyOp(res.doc, res.inverse).doc;
    expect(back).toStrictEqual(doc);
    expect(findNode(back, 'c')?.pins).toEqual({ 'props.variant': { at: 9, opId: 'op-1' } });
  });

  it('frees the replaced subtree ids for reuse by the replacement', () => {
    const res = applyOp(fixture(), {
      op: 'el.replace', pageId: PAGE, mid: 'c', node: { tag: 'div', children: [{ mid: 'd', tag: 'span', text: 'reused' }] },
    });
    // `d` lived inside the replaced subtree, so it is not a collision.
    expect(res.newMids).toEqual({});
    expect(findNode(res.doc, 'd')?.text).toBe('reused');
  });

  it('replaces the document root, keeping the root mid', () => {
    const doc = fixture();
    const op: CanvasOp = { op: 'el.replace', pageId: PAGE, mid: 'a', node: { tag: 'UI.Screen', children: [{ mid: 'n1', tag: 'div', text: 'x' }] } };
    const res = applyOp(doc, op);
    expect(res.doc.mid).toBe('a');
    expect(res.doc.tag).toBe('UI.Screen');
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('refuses a vanished mid', () => {
    expect(codeOf(() => applyOp(fixture(), { op: 'el.replace', pageId: PAGE, mid: 'ghost', node: { tag: 'div' } }))).toBe('missing-mid');
  });
});

/* ─────────────────────────────── page.setDoc ─────────────────────────────── */

describe('page.setDoc', () => {
  it('replaces the whole tree and inverts to the previous tree', () => {
    const doc = fixture();
    const next: DocNode = { mid: 'r', tag: 'UI.Screen', children: [{ mid: 's', tag: 'UI.Text', text: 'fresh' }] };
    const res = applyOp(doc, { op: 'page.setDoc', pageId: PAGE, doc: next });
    expect(res.doc).toStrictEqual(next);
    expect(res.inverse).toEqual({ op: 'page.setDoc', pageId: PAGE, doc });
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('does not alias the incoming tree or the outgoing one', () => {
    const doc = fixture();
    const next: DocNode = { mid: 'r', tag: 'div', children: [{ mid: 's', tag: 'span', text: 'x' }] };
    const res = applyOp(doc, { op: 'page.setDoc', pageId: PAGE, doc: next });
    expect(sharedRefs(collectRefs(next), collectRefs(res.doc))).toEqual([]);
    const prev = (res.inverse as Extract<CanvasOp, { op: 'page.setDoc' }>).doc;
    expect(sharedRefs(collectRefs(prev), collectRefs(doc))).toEqual([]);
  });

  it('heals duplicate mids inside the incoming tree', () => {
    const mint = counterMinter('z');
    const res = applyOp(fixture(), {
      op: 'page.setDoc', pageId: PAGE,
      doc: { mid: 'r', tag: 'div', children: [{ mid: 'r', tag: 'span', text: 'a' }, { mid: 'x', tag: 'span', text: 'b' }] },
    }, { mintMid: mint });
    expect(res.newMids).toEqual({ r: 'z0' });
    const mids = midList(res.doc);
    expect(new Set(mids).size).toBe(mids.length);
    expect(res.doc.mid).toBe('r');
  });
});

/* ───────────────────────── scope, purity, utilities ───────────────────────── */

describe('scope guard', () => {
  it('refuses ops that do not patch a document', () => {
    const doc = fixture();
    expect(codeOf(() => applyOp(doc, { op: 'page.reorder', orderedIds: ['p1'] }))).toBe('invalid-op');
    expect(codeOf(() => applyOp(doc, { op: 'page.remove', pageId: PAGE }))).toBe('invalid-op');
    expect(codeOf(() => applyOp(doc, { op: 'page.move', pageId: PAGE, boardPos: { x: 0, y: 0 } }))).toBe('invalid-op');
  });

  it('isDocScopedOp agrees with what applyOp accepts', () => {
    const doc = fixture();
    const scoped: CanvasOp[] = [
      { op: 'el.setText', pageId: PAGE, mid: 'b', text: 'x' },
      { op: 'el.setStyle', pageId: PAGE, mid: 'b', style: {} },
      { op: 'el.setProp', pageId: PAGE, mid: 'b', name: 'l', value: 1 },
      { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: { mid: 'zz', tag: 'div' } },
      { op: 'el.remove', pageId: PAGE, mid: 'b' },
      { op: 'el.move', pageId: PAGE, mid: 'b', newParentMid: 'c', before: 'end' },
      { op: 'el.replace', pageId: PAGE, mid: 'b', node: { tag: 'div' } },
      { op: 'page.setDoc', pageId: PAGE, doc: { mid: 'r', tag: 'div' } },
    ];
    for (const op of scoped) {
      expect(isDocScopedOp(op), op.op).toBe(true);
      expect(codeOf(() => applyOp(doc, op)), op.op).not.toBe('invalid-op');
    }
    const unscoped: CanvasOp[] = [
      { op: 'page.reorder', orderedIds: [] },
      { op: 'page.remove', pageId: PAGE },
      { op: 'page.duplicate', pageId: PAGE },
      { op: 'page.setMeta', pageId: PAGE, patch: { notes: 'n' } },
      { op: 'page.move', pageId: PAGE, boardPos: { x: 1, y: 2 } },
    ];
    for (const op of unscoped) {
      expect(isDocScopedOp(op), op.op).toBe(false);
      expect(codeOf(() => applyOp(doc, op)), op.op).toBe('invalid-op');
    }
  });
});

describe('normalizeDoc / cloneForPayload', () => {
  it('drops empty containers so "absent" and "{}" stop being two states', () => {
    const messy: DocNode = {
      mid: 'a', tag: 'div', props: {}, style: {}, pins: {}, children: [],
      slots: { actions: [], trailing: [{ mid: 'b', tag: 'span', props: {}, text: 't' }] },
    };
    expect(normalizeDoc(messy)).toStrictEqual({
      mid: 'a', tag: 'div', slots: { trailing: [{ mid: 'b', tag: 'span', text: 't' }] },
    });
  });

  it('removes an empty slots map entirely', () => {
    expect(normalizeDoc({ mid: 'a', tag: 'div', slots: { actions: [] } })).toStrictEqual({ mid: 'a', tag: 'div' });
  });

  it('deep-clones nested prop values and pin records', () => {
    const src: DocNode = {
      mid: 'a', tag: 'div',
      props: { data: [{ label: 'Jan', rows: [1, 2] }] },
      pins: { text: { at: 1, opId: 'o' } },
    };
    const out = normalizeDoc(src);
    expect(out).toStrictEqual(src);
    expect(sharedRefs(collectRefs(src), collectRefs(out))).toEqual([]);
  });

  it('applyOp normalizes the tree it is handed, so its output is always canonical', () => {
    const messy: DocNode = { mid: 'a', tag: 'div', style: {}, children: [{ mid: 'b', tag: 'span', props: {}, text: 'x' }] };
    const res = applyOp(messy, { op: 'el.setText', pageId: PAGE, mid: 'b', text: 'y' });
    expect('style' in res.doc).toBe(false);
    expect('props' in res.doc.children![0]).toBe(false);
  });

  it('cloneForPayload keeps pins and `by` — an inverse that dropped them would erase human ownership', () => {
    const src: DocNode = { mid: 'a', tag: 'div', by: 'user', pins: { text: { at: 5, opId: 'o1' } }, text: 'hi' };
    expect(cloneForPayload(src)).toStrictEqual(src);
  });
});

describe('sanitizeNodeInput — the boundary the executor must use', () => {
  it('strips pins, `by` and unknown fields, recursively', () => {
    const hostile = {
      mid: 'm1', tag: 'div', by: 'user', pins: { 'style.background': { at: 1, opId: 'forged' } },
      frame: { x: 1, y: 2 }, onClick: 'alert(1)',
      children: [{ tag: 'span', text: 'x', by: 'user', pins: { text: { at: 2, opId: 'f2' } } }],
      slots: { actions: [{ tag: 'b', text: 'y', by: 'agent' }], empty: [] },
    } as unknown as DocNodeInput;
    expect(sanitizeNodeInput(hostile)).toStrictEqual({
      tag: 'div', mid: 'm1',
      children: [{ tag: 'span', text: 'x' }],
      slots: { actions: [{ tag: 'b', text: 'y' }] },
    });
  });

  it('a sanitized payload cannot forge a pin through applyOp', () => {
    const forged = { tag: 'div', text: 'x', pins: { text: { at: 1, opId: 'forged' } } } as unknown as DocNodeInput;
    const withPins = applyOp(fixture(), { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: forged });
    expect(withPins.doc.children![2].pins).toBeDefined();       // honoured — purity, not policy
    const cleaned = applyOp(fixture(), { op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: sanitizeNodeInput(forged) });
    expect(cleaned.doc.children![2].pins).toBeUndefined();       // the boundary is where trust is decided
  });
});

describe('hostile keys — a model chooses the prop, style, slot and mid strings', () => {
  it('round-trips a prop literally named __proto__ instead of setting a prototype', () => {
    const doc: DocNode = { mid: 'a', tag: 'div', text: 'x' };
    const op: CanvasOp = { op: 'el.setProp', pageId: PAGE, mid: 'a', name: '__proto__', value: { evil: true } };
    const res = applyOp(doc, op);
    expect(Object.keys(res.doc.props!)).toEqual(['__proto__']);
    expect(Object.prototype.hasOwnProperty.call(res.doc.props!, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('round-trips a style property and a nested JSON key named __proto__', () => {
    const doc: DocNode = { mid: 'a', tag: 'div', text: 'x' };
    // NB: an object LITERAL `{ __proto__: 'red' }` is the prototype-setter
    // syntax and creates no own property — the one spelling that would make
    // this test pass vacuously. Build it the way a real payload arrives.
    const hostileStyle = JSON.parse('{"__proto__":"red"}') as Record<string, string | null>;
    const styled = applyOp(doc, { op: 'el.setStyle', pageId: PAGE, mid: 'a', style: hostileStyle });
    expect(Object.keys(styled.doc.style!)).toEqual(['__proto__']);
    expect(applyOp(styled.doc, styled.inverse).doc).toStrictEqual(doc);

    const nested = applyOp(doc, {
      op: 'el.setProp', pageId: PAGE, mid: 'a', name: 'data',
      value: JSON.parse('{"__proto__":{"polluted":1},"ok":2}') as JsonValue,
    });
    expect(Object.keys(nested.doc.props!.data as object)).toEqual(['__proto__', 'ok']);
  });

  it('round-trips a slot named __proto__', () => {
    const doc: DocNode = { mid: 'a', tag: 'div' };
    const op: CanvasOp = {
      op: 'el.insert', pageId: PAGE, parentMid: 'a', before: 'end', node: { mid: 'k', tag: 'span', text: 'y' }, slot: '__proto__',
    };
    const res = applyOp(doc, op);
    expect(Object.keys(res.doc.slots!)).toEqual(['__proto__']);
    expect(res.doc.slots!['__proto__'][0].mid).toBe('k');
    expect(applyOp(res.doc, res.inverse).doc).toStrictEqual(doc);
  });

  it('reports a re-minted mid named __proto__ as a real newMids entry', () => {
    const mint = counterMinter('z');
    const res = applyOp(
      { mid: '__proto__', tag: 'div' },
      { op: 'el.insert', pageId: PAGE, parentMid: '__proto__', before: 'end', node: { mid: '__proto__', tag: 'span', text: 'x' } },
      { mintMid: mint },
    );
    expect(Object.keys(res.newMids)).toEqual(['__proto__']);
    expect(res.newMids['__proto__']).toBe('z0');
  });

  it('drops a prop explicitly set to undefined rather than round-tripping unequally', () => {
    const doc = { mid: 'a', tag: 'div', props: { ghost: undefined, real: 1 } } as unknown as DocNode;
    expect(normalizeDoc(doc).props).toEqual({ real: 1 });
  });
});

describe('error surface', () => {
  it('classifies stale vs rejected for the executor', () => {
    const stale = new DocPatchError({ code: 'missing-mid', opKind: 'el.setText', detail: 'x' });
    const anchor = new DocPatchError({ code: 'missing-anchor', opKind: 'el.insert', detail: 'x' });
    const bad = new DocPatchError({ code: 'invalid-target', opKind: 'el.remove', detail: 'x' });
    expect([stale, anchor].every(isStaleDocPatchError)).toBe(true);
    expect(isStaleDocPatchError(bad)).toBe(false);
    expect(isStaleDocPatchError(new Error('nope'))).toBe(false);
    expect(isDocPatchError(new Error('nope'))).toBe(false);
    expect(isDocPatchError(null)).toBe(false);
    expect(isDocPatchError({ name: 'DocPatchError', code: 'missing-mid' })).toBe(true);
    expect(stale instanceof Error).toBe(true);
    expect(stale.opKind).toBe('el.setText');
  });
});
