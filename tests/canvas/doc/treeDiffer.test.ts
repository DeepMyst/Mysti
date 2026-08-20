/**
 * `TreeDiffer` tests (Plan 22 §3.5) — whole-page rewrites, and the pin rule.
 *
 * Two properties are load-bearing and are asserted rather than described:
 *
 * 1. **Minimality.** A coarse write that changed one heading must land as ONE
 *    op. The whole point of the differ is that an agent rewrite is a set of
 *    small, individually-undoable changes; a differ that emits `el.replace` for
 *    a text edit has silently reintroduced the page-sized clobber.
 * 2. **Pins are excluded, not reverted.** A pinned cell must never appear as a
 *    candidate op — so the assertions look for the ABSENCE of an op targeting
 *    the cell, not for a rejection downstream.
 *
 * The last block replays the emitted ops through the real `DocPatch.applyOp`
 * and asserts the result deep-equals the incoming tree. That is the only test
 * that proves the ops are executable in the order they are emitted (anchors
 * that exist, removals late enough that survivors escape first).
 */
import { describe, it, expect } from 'vitest';
import { diffDocs } from '../../../src/canvas/doc/TreeDiffer';
import type { DiffDocsOptions } from '../../../src/canvas/doc/TreeDiffer';
import { applyOp, normalizeDoc } from '../../../src/canvas/doc/DocPatch';
import type { DocNode, Mid, PinCell, PinRecord } from '../../../src/canvas/doc/DocNode';
import type { CanvasOp } from '../../../src/canvas/CanvasOps';
import { opCells, opMid } from '../../../src/canvas/CanvasOps';
import { TEXT_CELL, findNode, isPinned, pinnedCells, walk } from '../../../src/canvas/doc/DocNode';

const PAGE = 'page-1';

/** Deterministic id source so payload mids are assertable. */
function counterMint(): () => Mid {
  let n = 0;
  return () => `zz${String(++n).padStart(8, '0')}`;
}

function diff(prev: DocNode, next: DocNode, opts: Partial<DiffDocsOptions> = {}) {
  return diffDocs(prev, next, { pageId: PAGE, mintMid: counterMint(), ...opts });
}

const pin = (opId = 'op-h'): PinRecord => ({ at: 1_700_000_000_000, opId });

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function kinds(ops: CanvasOp[]): string[] { return ops.map(o => o.op); }

function applyAll(doc: DocNode, ops: CanvasOp[]): DocNode {
  let cur = doc;
  for (const op of ops) { cur = applyOp(cur, op).doc; }
  return cur;
}

/* ─────────────────────────── fixtures ─────────────────────────── */

/** root > header > [h1(text), p(text)] , footer(text) */
function page(): DocNode {
  return {
    mid: 'rootaaaaaa',
    tag: 'div',
    style: { padding: '24px' },
    children: [
      {
        mid: 'headeraaaa',
        tag: 'header',
        children: [
          { mid: 'h1aaaaaaaa', tag: 'h1', text: 'Welcome', style: { color: 'red' } },
          { mid: 'paaaaaaaaa', tag: 'p', text: 'Sign in to continue' },
        ],
      },
      { mid: 'footeraaaa', tag: 'footer', text: 'v1' },
    ],
  };
}

/* ─────────────────────────── no-op ─────────────────────────── */

describe('diffDocs — nothing to do', () => {
  it('two structurally identical trees produce zero ops and zero dropped', () => {
    const res = diff(page(), page());
    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([]);
  });

  it('key order in props and style is not a change', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', props: { a: 1, b: { x: [1, 2] } }, style: { color: 'red', gap: '2px' } };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', props: { b: { x: [1, 2] }, a: 1 }, style: { gap: '2px', color: 'red' } };
    expect(diff(prev, next).ops).toEqual([]);
  });

  it('an empty doc against itself is stable', () => {
    const bare: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    expect(diff(bare, clone(bare)).ops).toEqual([]);
  });
});

/* ─────────────────────────── single-cell changes ─────────────────────────── */

describe('diffDocs — single-cell changes are single ops', () => {
  it('one heading text change produces exactly ONE op', () => {
    const next = page();
    next.children![0].children![0].text = 'Welcome back';
    const res = diff(page(), next);
    expect(res.ops).toEqual([{ op: 'el.setText', pageId: PAGE, mid: 'h1aaaaaaaa', text: 'Welcome back' }]);
    expect(res.dropped).toEqual([]);
  });

  it('every style change on one node collapses into ONE el.setStyle', () => {
    const next = page();
    next.children![0].children![0].style = { color: 'blue', 'font-size': '32px' };
    const res = diff(page(), next);
    expect(res.ops).toEqual([
      { op: 'el.setStyle', pageId: PAGE, mid: 'h1aaaaaaaa', style: { color: 'blue', 'font-size': '32px' } },
    ]);
  });

  it('a removed style property is patched to null, not left behind', () => {
    const next = page();
    delete next.children![0].children![0].style;
    const res = diff(page(), next);
    expect(res.ops).toEqual([{ op: 'el.setStyle', pageId: PAGE, mid: 'h1aaaaaaaa', style: { color: null } }]);
  });

  it('props diff per name, deep-compare, and delete with null', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Card', props: { label: 'A', data: [{ v: 1 }], gone: true } };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Card', props: { label: 'B', data: [{ v: 1 }] } };
    const res = diff(prev, next);
    expect(res.ops).toEqual([
      { op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: 'gone', value: null },
      { op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: 'label', value: 'B' },
    ]);
  });

  it('a prop payload is cloned, not aliased into the op', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Chart' };
    const nested = [{ v: 1 }];
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Chart', props: { data: nested } };
    const res = diff(prev, next);
    (nested[0] as { v: number }).v = 99;
    expect(res.ops[0]).toEqual({ op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: 'data', value: [{ v: 1 }] });
  });

  it('a deep leaf edit is still one op', () => {
    const deep = (leafText: string): DocNode => ({
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'l1aaaaaaaa', tag: 'div', children: [{ mid: 'l2aaaaaaaa', tag: 'div', children: [
        { mid: 'l3aaaaaaaa', tag: 'div', children: [{ mid: 'l4aaaaaaaa', tag: 'div', children: [
          { mid: 'l5aaaaaaaa', tag: 'span', text: leafText },
        ] }] },
      ] }] }],
    });
    const res = diff(deep('a'), deep('b'));
    expect(res.ops).toEqual([{ op: 'el.setText', pageId: PAGE, mid: 'l5aaaaaaaa', text: 'b' }]);
  });
});

/* ─────────────────────────── pins ─────────────────────────── */

describe('diffDocs — pinned cells are excluded from the diff, not reverted', () => {
  function pinned(): DocNode {
    return {
      mid: 'rootaaaaaa',
      tag: 'div',
      children: [{
        mid: 'btnaaaaaaa',
        tag: 'UI.Button',
        props: { label: 'Sign in', variant: 'primary' },
        style: { background: '#ff0066', color: 'white' },
        pins: { 'style.background': pin() },
      }],
    };
  }

  it('the pinned style is never a candidate while the same node\'s label still updates', () => {
    const next = clone(pinned());
    delete next.children![0].pins;
    next.children![0].style = { background: '#0000ff', color: 'white' };
    next.children![0].props = { label: 'Log in', variant: 'primary' };

    const res = diff(pinned(), next, { respectPins: true });

    expect(res.ops).toEqual([
      { op: 'el.setProp', pageId: PAGE, mid: 'btnaaaaaaa', name: 'label', value: 'Log in' },
    ]);
    // no op mentions the pinned cell at all
    expect(res.ops.some(o => o.op === 'el.setStyle')).toBe(false);
    expect(res.dropped).toEqual([
      { mid: 'btnaaaaaaa', cell: 'style.background', wanted: '#0000ff', reason: 'pinned-by-human' },
    ]);
  });

  it('an unpinned style property on the SAME node still lands in one op', () => {
    const next = clone(pinned());
    delete next.children![0].pins;
    next.children![0].style = { background: '#0000ff', color: 'black' };
    const res = diff(pinned(), next, { respectPins: true });
    expect(res.ops).toEqual([
      { op: 'el.setStyle', pageId: PAGE, mid: 'btnaaaaaaa', style: { color: 'black' } },
    ]);
    expect(res.dropped).toHaveLength(1);
  });

  it('respectPins:false diffs the pinned cell like any other', () => {
    const next = clone(pinned());
    next.children![0].style = { background: '#0000ff', color: 'white' };
    const res = diff(pinned(), next, { respectPins: false });
    expect(res.ops).toEqual([
      { op: 'el.setStyle', pageId: PAGE, mid: 'btnaaaaaaa', style: { background: '#0000ff' } },
    ]);
    expect(res.dropped).toEqual([]);
  });

  it('omitting respectPins defaults to NOT respecting them', () => {
    const next = clone(pinned());
    next.children![0].style = { background: '#0000ff', color: 'white' };
    expect(diff(pinned(), next).ops).toHaveLength(1);
  });

  it('a pinned cell the rewrite agrees with produces neither an op nor a dropped card', () => {
    const next = clone(pinned());
    next.children![0].props = { label: 'Sign in', variant: 'secondary' };
    const res = diff(pinned(), next, { respectPins: true });
    expect(res.ops).toEqual([
      { op: 'el.setProp', pageId: PAGE, mid: 'btnaaaaaaa', name: 'variant', value: 'secondary' },
    ]);
    expect(res.dropped).toEqual([]);
  });

  it('pinned text is excluded and reported', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'h1', text: 'Mine', pins: { text: pin('op-user') } };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'h1', text: 'Theirs' };
    const res = diff(prev, next, { respectPins: true });
    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([{ mid: 'rootaaaaaa', cell: 'text', wanted: 'Theirs', reason: 'pinned-by-human' }]);
  });

  it('a pinned prop deletion is reported with wanted:null', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Badge', props: { tone: 'danger' }, pins: { 'props.tone': pin() } };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Badge' };
    const res = diff(prev, next, { respectPins: true });
    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([{ mid: 'rootaaaaaa', cell: 'props.tone', wanted: null, reason: 'pinned-by-human' }]);
  });

  it('pins on the INCOMING tree are ignored — only the live doc can pin', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'h1', text: 'Old' };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'h1', text: 'New', pins: { text: pin('forged') } };
    const res = diff(prev, next, { respectPins: true });
    expect(res.ops).toEqual([{ op: 'el.setText', pageId: PAGE, mid: 'rootaaaaaa', text: 'New' }]);
    expect(res.dropped).toEqual([]);
  });

  it('a pinned cell survives inside a subtree that is otherwise rewritten', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{
        mid: 'cardaaaaaa', tag: 'UI.Card',
        children: [
          { mid: 'titleaaaaa', tag: 'h2', text: 'Old title', style: { color: 'hotpink' }, pins: { 'style.color': pin() } },
          { mid: 'oldrowaaaa', tag: 'div', text: 'to be deleted' },
        ],
      }],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{
        mid: 'cardaaaaaa', tag: 'UI.Card', style: { gap: '8px' },
        children: [
          { mid: 'titleaaaaa', tag: 'h2', text: 'New title', style: { color: 'black' } },
          { mid: 'newrowaaaa', tag: 'div', text: 'fresh' },
        ],
      }],
    };
    const res = diff(prev, next, { respectPins: true });

    // the human's colour is not even a candidate …
    expect(res.ops.filter(o => o.op === 'el.setStyle' && (o as { mid: string }).mid === 'titleaaaaa')).toEqual([]);
    // … while everything else in the subtree still lands
    expect(kinds(res.ops).sort()).toEqual(['el.insert', 'el.remove', 'el.setStyle', 'el.setText']);
    expect(res.ops.at(-1)).toEqual({ op: 'el.remove', pageId: PAGE, mid: 'oldrowaaaa' });
    expect(res.dropped).toEqual([
      { mid: 'titleaaaaa', cell: 'style.color', wanted: 'black', reason: 'pinned-by-human' },
    ]);
  });

  it('a tag change carries the human\'s pinned values into the replacement', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{
        mid: 'btnaaaaaaa', tag: 'button', text: 'Go',
        style: { background: 'rebeccapurple', border: 'none' },
        pins: { 'style.background': pin() },
      }],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'btnaaaaaaa', tag: 'a', text: 'Go', style: { background: 'grey', border: 'none' } }],
    };
    const res = diff(prev, next, { respectPins: true });
    expect(res.ops).toHaveLength(1);
    expect(res.ops[0]).toEqual({
      op: 'el.replace', pageId: PAGE, mid: 'btnaaaaaaa',
      node: { mid: 'btnaaaaaaa', tag: 'a', text: 'Go', style: { background: 'rebeccapurple', border: 'none' } },
    });
    expect(res.dropped).toEqual([
      { mid: 'btnaaaaaaa', cell: 'style.background', wanted: 'grey', reason: 'pinned-by-human' },
    ]);
  });

  it('payloads never carry pins or by — a model cannot forge either', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'evilaaaaaa', tag: 'div', by: 'user', pins: { text: pin('forged') }, text: 'hi' }],
    };
    const res = diff(prev, next, { respectPins: true });
    expect(res.ops).toEqual([{
      op: 'el.insert', pageId: PAGE, parentMid: 'rootaaaaaa', before: 'end',
      node: { mid: 'evilaaaaaa', tag: 'div', text: 'hi' },
    }]);
    expect(JSON.stringify(res.ops)).not.toContain('forged');
    expect(JSON.stringify(res.ops)).not.toContain('"by"');
  });

  it('structure stays lock-governed: a pinned node can still be removed', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'btnaaaaaaa', tag: 'button', text: 'x', pins: { text: pin() } }],
    };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    const res = diff(prev, next, { respectPins: true });
    expect(res.ops).toEqual([{ op: 'el.remove', pageId: PAGE, mid: 'btnaaaaaaa' }]);
  });
});

/* ─────────────────────────── dropped: node-vanished ─────────────────────────── */

describe('diffDocs — node-vanished intents', () => {
  it('reports a claimed mid the live doc no longer has', () => {
    const res = diff(page(), page(), { claimedMids: ['ghostaaaaa', 'h1aaaaaaaa'] });
    expect(res.dropped).toEqual([{ mid: 'ghostaaaaa', reason: 'node-vanished' }]);
    expect(res.ops).toEqual([]);
  });

  it('de-duplicates repeated claims and ignores junk', () => {
    const res = diff(page(), page(), { claimedMids: ['ghostaaaaa', 'ghostaaaaa', '', 'otheraaaaa'] });
    expect(res.dropped).toEqual([
      { mid: 'ghostaaaaa', reason: 'node-vanished' },
      { mid: 'otheraaaaa', reason: 'node-vanished' },
    ]);
  });

  it('is reported alongside the ops that DID apply', () => {
    const next = page();
    next.children![1].text = 'v2';
    const res = diff(page(), next, { claimedMids: ['ghostaaaaa'], respectPins: true });
    expect(res.ops).toEqual([{ op: 'el.setText', pageId: PAGE, mid: 'footeraaaa', text: 'v2' }]);
    expect(res.dropped).toEqual([{ mid: 'ghostaaaaa', reason: 'node-vanished' }]);
  });

  it('says nothing when no claims are supplied', () => {
    const next = page();
    next.children!.push({ mid: 'brandnewaa', tag: 'div', text: 'new' });
    expect(diff(page(), next).dropped).toEqual([]);
  });
});

/* ─────────────────────────── structure ─────────────────────────── */

describe('diffDocs — move beats remove+insert', () => {
  const twoBoxes = (zIn: 'a' | 'b'): DocNode => ({
    mid: 'rootaaaaaa', tag: 'div',
    children: [
      { mid: 'boxaaaaaaa', tag: 'div', children: zIn === 'a' ? [{ mid: 'zzzaaaaaaa', tag: 'span', text: 'z' }] : [] },
      { mid: 'boxbbbbbbb', tag: 'div', children: zIn === 'b' ? [{ mid: 'zzzaaaaaaa', tag: 'span', text: 'z' }] : [] },
    ],
  });

  it('a reparented node is ONE el.move', () => {
    const res = diff(twoBoxes('a'), twoBoxes('b'));
    expect(res.ops).toEqual([
      { op: 'el.move', pageId: PAGE, mid: 'zzzaaaaaaa', newParentMid: 'boxbbbbbbb', before: 'end' },
    ]);
  });

  it('reordering siblings emits the minimum number of moves', () => {
    const list = (order: string[]): DocNode => ({
      mid: 'rootaaaaaa', tag: 'div',
      children: order.map(k => ({ mid: `${k}aaaaaaaaa`, tag: 'li', text: k })),
    });
    const res = diff(list(['a', 'b', 'c']), list(['c', 'a', 'b']));
    expect(res.ops).toEqual([
      { op: 'el.move', pageId: PAGE, mid: 'caaaaaaaaa', newParentMid: 'rootaaaaaa', before: 'aaaaaaaaaa' },
    ]);
  });

  it('a node moved into a BRAND NEW wrapper keeps its identity', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'zzzaaaaaaa', tag: 'span', text: 'z' }] };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'wrapaaaaaa', tag: 'section', children: [{ mid: 'zzzaaaaaaa', tag: 'span', text: 'z' }] }],
    };
    const res = diff(prev, next);
    expect(res.ops).toEqual([
      { op: 'el.insert', pageId: PAGE, parentMid: 'rootaaaaaa', before: 'end', node: { mid: 'wrapaaaaaa', tag: 'section' } },
      { op: 'el.move', pageId: PAGE, mid: 'zzzaaaaaaa', newParentMid: 'wrapaaaaaa', before: 'end' },
    ]);
    expect(kinds(res.ops)).not.toContain('el.remove');
  });

  it('an inserted sibling anchors on the node that follows it', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'aaaaaaaaaa', tag: 'li', text: 'a' }, { mid: 'cccccccccc', tag: 'li', text: 'c' }],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'aaaaaaaaaa', tag: 'li', text: 'a' },
        { mid: 'bbbbbbbbbb', tag: 'li', text: 'b' },
        { mid: 'ccccccccccc'.slice(0, 10), tag: 'li', text: 'c' },
      ],
    };
    const res = diff(prev, next);
    expect(res.ops).toEqual([{
      op: 'el.insert', pageId: PAGE, parentMid: 'rootaaaaaa', before: 'ccccccccccc'.slice(0, 10),
      node: { mid: 'bbbbbbbbbb', tag: 'li', text: 'b' },
    }]);
  });

  it('removing a container is ONE el.remove, not one per descendant', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'wrapaaaaaa', tag: 'div', children: [
        { mid: 'xxxaaaaaaa', tag: 'span', text: 'x' },
        { mid: 'yyyaaaaaaa', tag: 'span', text: 'y' },
      ] }],
    };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    expect(diff(prev, next).ops).toEqual([{ op: 'el.remove', pageId: PAGE, mid: 'wrapaaaaaa' }]);
  });

  it('a survivor under a removed container is moved out BEFORE the removal', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'wrapaaaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'keep' }] },
        { mid: 'hostaaaaaa', tag: 'div' },
      ],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'hostaaaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'keep' }] }],
    };
    const res = diff(prev, next);
    expect(kinds(res.ops)).toEqual(['el.move', 'el.remove']);
    expect(res.ops[1]).toEqual({ op: 'el.remove', pageId: PAGE, mid: 'wrapaaaaaa' });
  });
});

describe('diffDocs — el.replace is the last resort', () => {
  it('a changed tag replaces exactly that node', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'h1aaaaaaaa', tag: 'h1', text: 'T' }] };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'h1aaaaaaaa', tag: 'h2', text: 'T' }] };
    expect(diff(prev, next).ops).toEqual([
      { op: 'el.replace', pageId: PAGE, mid: 'h1aaaaaaaa', node: { mid: 'h1aaaaaaaa', tag: 'h2', text: 'T' } },
    ]);
  });

  it('a text leaf becoming a container replaces rather than fighting the cell ops', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'boxaaaaaaa', tag: 'div', text: 'hi' }] };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'boxaaaaaaa', tag: 'div', children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 'hi' }] }],
    };
    expect(diff(prev, next).ops).toEqual([{
      op: 'el.replace', pageId: PAGE, mid: 'boxaaaaaaa',
      node: { mid: 'boxaaaaaaa', tag: 'div', children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 'hi' }] },
    }]);
  });

  it('a container becoming a text leaf replaces too', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'boxaaaaaaa', tag: 'div', children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 'hi' }] }],
    };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'boxaaaaaaa', tag: 'div', text: 'hi' }] };
    const res = diff(prev, next);
    expect(kinds(res.ops)).toEqual(['el.replace']);
  });

  it('a survivor escaping a replaced subtree is MOVED when its new home is visited first', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'oldboxaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'k' }] },
        { mid: 'hostaaaaaa', tag: 'div' },
      ],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'oldboxaaaa', tag: 'section', text: 'now a leaf' },
        { mid: 'hostaaaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'k' }] },
      ],
    };
    const res = diff(prev, next);
    // siblings are processed right-to-left, so the survivor escapes with its
    // identity (and its pins) intact before the replace destroys its old home
    expect(kinds(res.ops)).toEqual(['el.move', 'el.replace']);
    expect(res.ops[0]).toEqual({
      op: 'el.move', pageId: PAGE, mid: 'keepaaaaaa', newParentMid: 'hostaaaaaa', before: 'end',
    });
    expect(applyAll(normalizeDoc(clone(prev)), res.ops)).toEqual(normalizeDoc(clone(next)));
  });

  it('a survivor whose home is destroyed FIRST is re-created with the same mid', () => {
    // same shape, opposite sibling order: the replace is emitted before the
    // destination is reached, so the mid is free and the node is re-inserted
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'hostaaaaaa', tag: 'div' },
        { mid: 'oldboxaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'k' }] },
      ],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'hostaaaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'k' }] },
        { mid: 'oldboxaaaa', tag: 'section', text: 'now a leaf' },
      ],
    };
    const res = diff(prev, next);
    expect(kinds(res.ops)).toEqual(['el.replace', 'el.insert']);
    expect(res.ops[1]).toEqual({
      op: 'el.insert', pageId: PAGE, parentMid: 'hostaaaaaa', before: 'end',
      node: { mid: 'keepaaaaaa', tag: 'span', text: 'k' },
    });
    expect(applyAll(normalizeDoc(clone(prev)), res.ops)).toEqual(normalizeDoc(clone(next)));
  });
});

/* ─────────────────────────── slots ─────────────────────────── */

describe('diffDocs — slots are first-class', () => {
  const bar = (label: string, extra: DocNode[] = []): DocNode => ({
    mid: 'rootaaaaaa', tag: 'UI.TopBar',
    slots: { actions: [{ mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label } }, ...extra] },
  });

  it('a change inside a slot is one op', () => {
    expect(diff(bar('a'), bar('b')).ops).toEqual([
      { op: 'el.setProp', pageId: PAGE, mid: 'btnaaaaaaa', name: 'label', value: 'b' },
    ]);
  });

  it('an insert into a slot names the slot', () => {
    const res = diff(bar('a'), bar('a', [{ mid: 'avataraaaa', tag: 'UI.Avatar' }]));
    expect(res.ops).toEqual([{
      op: 'el.insert', pageId: PAGE, parentMid: 'rootaaaaaa', before: 'end', slot: 'actions',
      node: { mid: 'avataraaaa', tag: 'UI.Avatar' },
    }]);
  });

  it('moving a node out of a slot into children is a move, not remove+insert', () => {
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'UI.TopBar',
      children: [{ mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label: 'a' } }],
    };
    expect(diff(bar('a'), next).ops).toEqual([
      { op: 'el.move', pageId: PAGE, mid: 'btnaaaaaaa', newParentMid: 'rootaaaaaa', before: 'end' },
    ]);
  });

  it('a whole slot disappearing removes its nodes', () => {
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.TopBar' };
    expect(diff(bar('a'), next).ops).toEqual([{ op: 'el.remove', pageId: PAGE, mid: 'btnaaaaaaa' }]);
  });

  it('a pinned cell inside a slot is excluded like any other', () => {
    const prev = bar('a');
    prev.slots!.actions[0].pins = { 'props.label': pin() };
    const res = diff(prev, bar('b'), { respectPins: true });
    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([{ mid: 'btnaaaaaaa', cell: 'props.label', wanted: 'b', reason: 'pinned-by-human' }]);
  });
});

/* ─────────────────────────── adversarial input ─────────────────────────── */

describe('diffDocs — malformed and hostile trees', () => {
  it('the artboard root keeps its identity when the model forgets the root mid', () => {
    const prev = page();
    const next = page();
    next.mid = 'modelmadeu';
    next.children![1].text = 'v2';
    const res = diff(prev, next);
    expect(res.ops).toEqual([{ op: 'el.setText', pageId: PAGE, mid: 'footeraaaa', text: 'v2' }]);
  });

  it('a duplicate mid in the incoming tree becomes a fresh node, never a second op on the same id', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'aaaaaaaaaa', tag: 'span', text: '1' }] };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'aaaaaaaaaa', tag: 'span', text: '1' }, { mid: 'aaaaaaaaaa', tag: 'span', text: '2' }],
    };
    const res = diff(prev, next);
    expect(res.ops).toEqual([{
      op: 'el.insert', pageId: PAGE, parentMid: 'rootaaaaaa', before: 'end',
      node: { mid: 'zz00000001', tag: 'span', text: '2' },
    }]);
  });

  it('a node aliased into two places is minted twice rather than addressed twice', () => {
    const shared: DocNode = { mid: 'sharedaaaa', tag: 'span', text: 's' };
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [shared, shared] };
    const res = diff(prev, next);
    const mids = res.ops.map(o => (o as { node?: { mid?: string } }).node?.mid);
    expect(res.ops).toHaveLength(2);
    expect(new Set(mids).size).toBe(2);
    expect(mids).not.toContain('sharedaaaa');
  });

  it('a cyclic incoming tree terminates instead of unrolling forever', () => {
    const loop: DocNode = { mid: 'looplooplo', tag: 'div', children: [] };
    loop.children!.push(loop);
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [loop] };
    const res = diff(prev, next);
    expect(res.ops).toHaveLength(1);
    const node = (res.ops[0] as { node: { mid: string; children?: unknown[] } }).node;
    expect(node.mid).toBe('zz00000001');
    // the self-reference is dropped, not unrolled into a phantom copy
    expect(node.children).toBeUndefined();
  });

  it('a cyclic PREVIOUS tree does not hang the removal sweep', () => {
    const loop: DocNode = { mid: 'looplooplo', tag: 'div', children: [] };
    loop.children!.push(loop);
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [loop] };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    expect(diff(prev, next).ops).toEqual([{ op: 'el.remove', pageId: PAGE, mid: 'looplooplo' }]);
  });

  it('a root with no usable mid degrades to one honest replace', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'aaaaaaaaaa', tag: 'span', text: 'x' }] };
    const next = { mid: '', tag: 'section', text: 'all new' } as DocNode;
    const res = diff(prev, next);
    expect(kinds(res.ops)).toEqual(['el.replace']);
    expect((res.ops[0] as { mid: string }).mid).toBe('rootaaaaaa');
  });

  it('every emitted element op carries the requested pageId', () => {
    const prev = page();
    const next = page();
    next.children![0].children![0].text = 'x';
    next.children![0].children!.push({ mid: 'extraaaaaa', tag: 'p', text: 'e' });
    next.children!.pop();
    const res = diffDocs(prev, next, { pageId: 'other-page' });
    expect(res.ops.length).toBeGreaterThan(2);
    for (const op of res.ops) { expect((op as { pageId: string }).pageId).toBe('other-page'); }
  });
});

/* ─────────────────────────── executable in order ─────────────────────────── */

describe('diffDocs — the ops actually rebuild `next` (replayed through DocPatch)', () => {
  const cases: Array<[string, DocNode, DocNode]> = [
    ['text + style + prop', page(), (() => {
      const n = page();
      n.children![0].children![0].text = 'Hi';
      n.children![0].children![0].style = { color: 'blue' };
      n.children![1].text = 'v9';
      return n;
    })()],
    ['reorder', {
      mid: 'rootaaaaaa', tag: 'div',
      children: ['a', 'b', 'c', 'd'].map(k => ({ mid: `${k}aaaaaaaaa`, tag: 'li', text: k })),
    }, {
      mid: 'rootaaaaaa', tag: 'div',
      children: ['d', 'b', 'a', 'c'].map(k => ({ mid: `${k}aaaaaaaaa`, tag: 'li', text: k })),
    }],
    ['insert + remove + move together', {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'oldaaaaaaa', tag: 'div', text: 'bye' },
        { mid: 'boxaaaaaaa', tag: 'div', children: [{ mid: 'zzzaaaaaaa', tag: 'span', text: 'z' }] },
      ],
    }, {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'newaaaaaaa', tag: 'div', text: 'hello' },
        { mid: 'boxaaaaaaa', tag: 'div' },
        { mid: 'zzzaaaaaaa', tag: 'span', text: 'z!' },
      ],
    }],
    ['new wrapper adopts a survivor', {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'aaaaaaaaaa', tag: 'span', text: 'a' }, { mid: 'bbbbbbbbbb', tag: 'span', text: 'b' }],
    }, {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{
        mid: 'wrapaaaaaa', tag: 'section',
        children: [
          { mid: 'bbbbbbbbbb', tag: 'span', text: 'b' },
          { mid: 'freshaaaaa', tag: 'span', text: 'f' },
          { mid: 'aaaaaaaaaa', tag: 'span', text: 'a' },
        ],
      }],
    }],
    ['survivor escapes a removed container', {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'wrapaaaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'k' }] },
        { mid: 'hostaaaaaa', tag: 'div' },
      ],
    }, {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'hostaaaaaa', tag: 'div', children: [{ mid: 'keepaaaaaa', tag: 'span', text: 'k' }] }],
    }],
    ['tag change', {
      mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'h1aaaaaaaa', tag: 'h1', text: 'T', style: { color: 'red' } }],
    }, {
      mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'h1aaaaaaaa', tag: 'h2', text: 'T', style: { color: 'red' } }],
    }],
    ['leaf becomes a container', {
      mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'boxaaaaaaa', tag: 'div', text: 'hi' }],
    }, {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'boxaaaaaaa', tag: 'div', children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 'hi' }] }],
    }],
    ['slots move and grow', {
      mid: 'rootaaaaaa', tag: 'UI.TopBar',
      slots: { actions: [{ mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label: 'a' } }] },
      children: [{ mid: 'titleaaaaa', tag: 'span', text: 'T' }],
    }, {
      mid: 'rootaaaaaa', tag: 'UI.TopBar',
      slots: {
        actions: [
          { mid: 'avataraaaa', tag: 'UI.Avatar' },
          { mid: 'titleaaaaa', tag: 'span', text: 'T' },
          { mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label: 'b' } },
        ],
      },
    }],
    ['whole-page rewrite of a deep tree', {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'l1aaaaaaaa', tag: 'div', children: [{ mid: 'l2aaaaaaaa', tag: 'div', children: [
        { mid: 'l3aaaaaaaa', tag: 'p', text: 'deep' },
      ] }] }],
    }, {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'l1aaaaaaaa', tag: 'div', children: [
        { mid: 'l3aaaaaaaa', tag: 'p', text: 'deeper', style: { margin: '0' } },
        { mid: 'l2aaaaaaaa', tag: 'div' },
      ] }],
    }],
  ];

  for (const [name, prev, next] of cases) {
    it(`${name} → applying the ops reproduces the incoming tree`, () => {
      const res = diff(clone(prev), clone(next));
      const out = applyAll(normalizeDoc(clone(prev)), res.ops);
      expect(out).toEqual(normalizeDoc(clone(next)));
    });
  }

  it('a pinned rewrite reproduces `next` EXCEPT the pinned cell', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'btnaaaaaaa', tag: 'button', text: 'Go', style: { background: 'hotpink' }, pins: { 'style.background': pin() } }],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'btnaaaaaaa', tag: 'button', text: 'Start', style: { background: 'grey' } }],
    };
    const res = diff(clone(prev), clone(next), { respectPins: true });
    const out = applyAll(normalizeDoc(clone(prev)), res.ops);
    expect(out.children![0].text).toBe('Start');
    expect(out.children![0].style).toEqual({ background: 'hotpink' });
    expect(out.children![0].pins).toEqual(prev.children![0].pins);
  });
});

/* ─────────────────────── randomized whole-page rewrites ─────────────────────── */

/**
 * The scenarios above are the ones I thought of. This block is the one that
 * catches the ones I did not: a seeded generator builds a tree, mutates it the
 * way an agent rewrite would (retag, restyle, insert, delete, reparent,
 * reorder), and asserts that replaying the emitted ops through the real
 * `DocPatch` lands exactly on the rewritten tree — every anchor resolvable,
 * every removal late enough, every move legal at the moment it runs.
 */
describe('diffDocs — property: ops replay onto `next` for random rewrites', () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  }

  const TAGS = ['div', 'section', 'p', 'span', 'UI.Card', 'UI.Button'];

  function makeTree(rand: () => number, nextId: () => Mid): DocNode {
    const build = (depth: number): DocNode => {
      const n: DocNode = { mid: nextId(), tag: TAGS[Math.floor(rand() * TAGS.length)] };
      if (rand() < 0.4) { n.style = { color: rand() < 0.5 ? 'red' : 'blue' }; }
      if (rand() < 0.3) { n.props = { label: `l${Math.floor(rand() * 5)}` }; }
      if (depth >= 3 || rand() < 0.4) {
        n.text = `t${Math.floor(rand() * 9)}`;
        return n;
      }
      const count = Math.floor(rand() * 4);
      if (count > 0) { n.children = Array.from({ length: count }, () => build(depth + 1)); }
      if (rand() < 0.2) { n.slots = { trailing: [build(depth + 1)] }; }
      return n;
    };
    return build(0);
  }

  /** Every node, plus a parent lookup — the generator's own little index. */
  function flatten(root: DocNode): Array<{ node: DocNode; parent: DocNode | null; list: DocNode[] | null }> {
    const out: Array<{ node: DocNode; parent: DocNode | null; list: DocNode[] | null }> = [];
    const visit = (n: DocNode, parent: DocNode | null, list: DocNode[] | null): void => {
      out.push({ node: n, parent, list });
      for (const c of n.children ?? []) { visit(c, n, n.children ?? null); }
      for (const l of Object.values(n.slots ?? {})) { for (const c of l) { visit(c, n, l); } }
    };
    visit(root, null, null);
    return out;
  }

  const isDescendant = (root: DocNode, mid: Mid): boolean =>
    flatten(root).some(e => e.node.mid === mid);

  function mutate(root: DocNode, rand: () => number, nextId: () => Mid, rounds: number): DocNode {
    for (let r = 0; r < rounds; r++) {
      const all = flatten(root);
      const containers = all.filter(e => e.node.text === undefined);
      const pick = all[Math.floor(rand() * all.length)];
      const roll = rand();

      if (roll < 0.2 && pick.node.text !== undefined) {
        pick.node.text = `t${Math.floor(rand() * 9)}`;
      } else if (roll < 0.35) {
        pick.node.style = rand() < 0.3 ? undefined : { color: rand() < 0.5 ? 'green' : 'black' };
        if (!pick.node.style) { delete pick.node.style; }
      } else if (roll < 0.45) {
        pick.node.props = rand() < 0.3 ? undefined : { label: `l${Math.floor(rand() * 9)}`, n: Math.floor(rand() * 3) };
        if (!pick.node.props) { delete pick.node.props; }
      } else if (roll < 0.55) {
        pick.node.tag = TAGS[Math.floor(rand() * TAGS.length)];
      } else if (roll < 0.7) {
        // insert fresh content under a container
        if (containers.length === 0) { continue; }
        const host = containers[Math.floor(rand() * containers.length)].node;
        const list = host.children ?? (host.children = []);
        list.splice(Math.floor(rand() * (list.length + 1)), 0, makeTree(rand, nextId));
      } else if (roll < 0.85) {
        // delete a non-root node
        const victims = all.filter(e => e.parent !== null && e.list !== null);
        if (victims.length === 0) { continue; }
        const v = victims[Math.floor(rand() * victims.length)];
        v.list!.splice(v.list!.indexOf(v.node), 1);
      } else {
        // reparent / reorder
        const movable = all.filter(e => e.parent !== null && e.list !== null);
        if (movable.length === 0) { continue; }
        const m = movable[Math.floor(rand() * movable.length)];
        const hosts = containers.filter(c => c.node !== m.node && !isDescendant(m.node, c.node.mid));
        if (hosts.length === 0) { continue; }
        m.list!.splice(m.list!.indexOf(m.node), 1);
        const host = hosts[Math.floor(rand() * hosts.length)].node;
        const list = host.children ?? (host.children = []);
        list.splice(Math.floor(rand() * (list.length + 1)), 0, m.node);
      }
    }
    return root;
  }

  for (let seed = 1; seed <= 4000; seed++) {
    it(`seed ${seed}`, () => {
      const rand = lcg(seed * 7919);
      let counter = 0;
      const nextId = (): Mid => `q${String(++counter).padStart(9, '0')}`;
      const prev = makeTree(rand, nextId);
      const next = mutate(clone(prev), rand, nextId, 2 + (seed % 20));

      const res = diff(clone(prev), clone(next));
      const out = applyAll(normalizeDoc(clone(prev)), res.ops);
      expect(out).toEqual(normalizeDoc(clone(next)));
      // and the diff is a diff, not a rewrite: an unchanged tree costs nothing
      expect(diff(clone(next), clone(next)).ops).toEqual([]);
    });
  }
});

/* ─────────────────────── pins survive relocation ─────────────────────── */

describe('diffDocs — pins travel with the node', () => {
  it('a pinned node that is also reparented keeps its cell excluded', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'srcaaaaaaa', tag: 'div', children: [
          { mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label: 'Mine' }, pins: { 'props.label': pin() } },
        ] },
        { mid: 'dstaaaaaaa', tag: 'div' },
      ],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'srcaaaaaaa', tag: 'div' },
        { mid: 'dstaaaaaaa', tag: 'div', children: [
          { mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label: 'Theirs' } },
        ] },
      ],
    };
    const res = diff(prev, next, { respectPins: true });
    expect(res.ops).toEqual([
      { op: 'el.move', pageId: PAGE, mid: 'btnaaaaaaa', newParentMid: 'dstaaaaaaa', before: 'end' },
    ]);
    expect(res.dropped).toEqual([
      { mid: 'btnaaaaaaa', cell: 'props.label', wanted: 'Theirs', reason: 'pinned-by-human' },
    ]);
  });

  it('a new subtree with its own slots is emitted whole', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{
        mid: 'baraaaaaaa', tag: 'UI.TopBar',
        slots: { actions: [{ mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label: 'go' } }] },
        children: [{ mid: 'ttlaaaaaaa', tag: 'span', text: 'T' }],
      }],
    };
    const res = diff(prev, next);
    expect(res.ops).toEqual([{
      op: 'el.insert', pageId: PAGE, parentMid: 'rootaaaaaa', before: 'end',
      node: {
        mid: 'baraaaaaaa', tag: 'UI.TopBar',
        children: [{ mid: 'ttlaaaaaaa', tag: 'span', text: 'T' }],
        slots: { actions: [{ mid: 'btnaaaaaaa', tag: 'UI.Button', props: { label: 'go' } }] },
      },
    }]);
    expect(applyAll(normalizeDoc(clone(prev)), res.ops)).toEqual(normalizeDoc(clone(next)));
  });
});

/* ─────────────────── property: no op ever writes a pinned cell ─────────────────── */

/**
 * The pin rule stated generically, checked with the op algebra's OWN cell
 * accessor rather than a restatement of it: for every emitted op, the cells it
 * writes (`opCells`) must be disjoint from the cells the live doc says a human
 * owns (`isPinned`). A single counterexample means an agent rewrite can revert
 * a human's edit, which is the failure this whole file exists to prevent.
 */
describe('diffDocs — property: respectPins makes pinned cells unreachable', () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 0x100000000; };
  }

  const CELLS = ['text', 'style.color', 'style.background', 'props.label'];

  function sprinkle(root: DocNode, rand: () => number): void {
    const visit = (n: DocNode): void => {
      if (rand() < 0.5) {
        const cell = CELLS[Math.floor(rand() * CELLS.length)];
        n.pins = { [cell]: pin(`op-${cell}`) };
      }
      for (const c of n.children ?? []) { visit(c); }
      for (const l of Object.values(n.slots ?? {})) { for (const c of l) { visit(c); } }
    };
    visit(root);
  }

  for (let seed = 1; seed <= 300; seed++) {
    it(`seed ${seed}: no op targets a pinned cell`, () => {
      const rand = lcg(seed * 2654435761);
      const prev: DocNode = {
        mid: 'rootaaaaaa', tag: 'div',
        children: [
          { mid: 'aaaaaaaaaa', tag: 'h1', text: 'A', style: { color: 'red', background: 'white' }, props: { label: 'a' } },
          { mid: 'bbbbbbbbbb', tag: 'UI.Card', style: { color: 'blue' }, props: { label: 'b' }, children: [
            { mid: 'cccccccccc', tag: 'p', text: 'C', props: { label: 'c' } },
          ] },
          { mid: 'dddddddddd', tag: 'UI.Button', props: { label: 'd' }, style: { background: 'grey' } },
        ],
      };
      sprinkle(prev, rand);

      const next = clone(prev);
      const strip = (n: DocNode): void => {
        delete n.pins;
        if (n.text !== undefined) { n.text = `x${Math.floor(rand() * 9)}`; }
        if (rand() < 0.7) { n.style = { color: 'chartreuse', background: 'black' }; }
        if (rand() < 0.7) { n.props = { label: `z${Math.floor(rand() * 9)}` }; }
        if (rand() < 0.2) { n.tag = n.tag === 'p' ? 'span' : 'div'; }
        for (const c of n.children ?? []) { strip(c); }
        for (const l of Object.values(n.slots ?? {})) { for (const c of l) { strip(c); } }
      };
      strip(next);

      const res = diff(prev, next, { respectPins: true });

      for (const op of res.ops) {
        const cells = opCells(op);
        if (!cells) { continue; }
        const mid = opMid(op);
        const target = mid ? findNode(prev, mid) : null;
        if (!target) { continue; }
        for (const cell of cells) {
          expect(`${op.op}:${mid}:${cell}${isPinned(target, cell) ? ' WRITES A PIN' : ''}`)
            .toBe(`${op.op}:${mid}:${cell}`);
        }
      }

      // and a replace forced by a tag change carries the human's value forward
      for (const op of res.ops) {
        if (op.op !== 'el.replace') { continue; }
        const target = findNode(prev, op.mid);
        if (!target) { continue; }
        for (const cell of pinnedCells(target)) {
          if (cell === 'text') { expect(op.node.text).toBe(target.text); }
          if (cell.startsWith('style.')) {
            const k = cell.slice(6);
            expect(op.node.style?.[k]).toBe(target.style?.[k]);
          }
          if (cell.startsWith('props.')) {
            const k = cell.slice(6);
            expect(op.node.props?.[k]).toEqual(target.props?.[k]);
          }
        }
      }
    });
  }
});

/* ─────────────── regressions found by replay fuzzing (do not delete) ─────────────── */

/**
 * Each of these is a shrunk counterexample from a randomized replay run. They
 * are kept as named cases because every one of them is a WRONG DOCUMENT that no
 * hand-written scenario in this file caught, and three of the four are silent:
 * the ops apply cleanly and the artboard is simply not what the model asked for
 * — or not what the human pinned.
 */
describe('diffDocs — regressions found by replay fuzzing', () => {
  it('an orphan under a node that ESCAPED a removed subtree is still removed', () => {
    // The removal sweep used to stop descending at a doomed node, on the theory
    // that its subtree goes with it. A child that was reparented ELSEWHERE takes
    // its own subtree with it, so anything `next` dropped in there outlives the
    // ancestor's single `el.remove` and is left behind forever.
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'doomedaaaa', tag: 'div', children: [
          { mid: 'escapeeaaa', tag: 'div', slots: { trailing: [{ mid: 'orphanaaaa', tag: 'span', text: 'left behind' }] } },
        ] },
        { mid: 'hostaaaaaa', tag: 'div' },
      ],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'hostaaaaaa', tag: 'div', children: [{ mid: 'escapeeaaa', tag: 'div' }] },
      ],
    };
    const res = diff(prev, next);

    expect(res.ops).toContainEqual({ op: 'el.remove', pageId: PAGE, mid: 'orphanaaaa' });
    // still ONE op for the doomed container — the fix must not degrade into
    // one removal per descendant.
    expect(res.ops.filter(o => o.op === 'el.remove')).toHaveLength(2);
    // and the escapee leaves before either removal runs
    expect(kinds(res.ops)).toEqual(['el.move', 'el.remove', 'el.remove']);
    expect(applyAll(normalizeDoc(clone(prev)), res.ops)).toEqual(normalizeDoc(clone(next)));
  });

  it('a pin survives an ancestor being replaced out from under its node', () => {
    // The replaced node itself kept the human's values; a DESCENDANT re-created
    // inside the same payload under its own mid did not. Identity was preserved
    // and the value was reverted — the exact silent clobber pins exist to stop.
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'cardaaaaaa', tag: 'UI.Card', children: [
          {
            mid: 'btnaaaaaaa', tag: 'UI.Button',
            style: { background: 'hotpink' },
            props: { label: 'Mine' },
            pins: { 'style.background': pin(), 'props.label': pin() },
          },
        ] },
      ],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'cardaaaaaa', tag: 'UI.Panel', children: [   // tag change ⇒ el.replace
          { mid: 'btnaaaaaaa', tag: 'UI.Button', style: { background: 'blue' }, props: { label: 'Theirs' } },
        ] },
      ],
    };
    const res = diff(prev, next, { respectPins: true });

    expect(kinds(res.ops)).toEqual(['el.replace']);
    const op = res.ops[0];
    if (op.op !== 'el.replace') { throw new Error('expected el.replace'); }
    const rebuilt = op.node.children?.[0];
    expect(rebuilt?.mid).toBe('btnaaaaaaa');              // identity preserved…
    expect(rebuilt?.style?.background).toBe('hotpink');   // …so the pin is too
    expect(rebuilt?.props?.label).toBe('Mine');
    expect(res.dropped).toEqual([
      { mid: 'btnaaaaaaa', cell: 'props.label', wanted: 'Theirs', reason: 'pinned-by-human' },
      { mid: 'btnaaaaaaa', cell: 'style.background', wanted: 'blue', reason: 'pinned-by-human' },
    ]);

    const out = applyAll(normalizeDoc(clone(prev)), res.ops);
    expect(findNode(out, 'btnaaaaaaa')?.style?.background).toBe('hotpink');
    expect(findNode(out, 'btnaaaaaaa')?.props?.label).toBe('Mine');
    // and the payload still carries no pin records — a model cannot forge one
    expect((rebuilt as unknown as { pins?: unknown }).pins).toBeUndefined();
  });

  it('a promised move whose home is replaced before its turn becomes an insert', () => {
    // Both children of the new wrapper are alive in `prev`, so both are planned
    // as moves. Flushing them aligns `oldhomeaaa` first, whose tag change emits
    // an `el.replace` that destroys `yaaaaaaaaa` — and the move promised for
    // `yaaaaaaaaa` then addressed a mid the document no longer held, which
    // DocPatch rejects, failing the whole rewrite on a dead op.
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'oldhomeaaa', tag: 'div', children: [{ mid: 'yaaaaaaaaa', tag: 'span', text: 'y' }] },
      ],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [
        { mid: 'wrapaaaaaa', tag: 'UI.Card', children: [
          { mid: 'yaaaaaaaaa', tag: 'span', text: 'y' },
          { mid: 'oldhomeaaa', tag: 'section', children: [] },
        ] },
      ],
    };
    const res = diff(prev, next);

    expect(() => applyAll(normalizeDoc(clone(prev)), res.ops)).not.toThrow();
    expect(applyAll(normalizeDoc(clone(prev)), res.ops)).toEqual(normalizeDoc(clone(next)));
    // the survivor is re-created under its OWN id, not a minted one
    const insert = res.ops.find(o => o.op === 'el.insert' && o.node.mid === 'yaaaaaaaaa');
    expect(insert).toBeDefined();
    expect(res.ops.some(o => o.op === 'el.move' && o.mid === 'yaaaaaaaaa')).toBe(false);
  });

  it('pinned text on a leaf that becomes a container is dropped, not forced into an illegal payload', () => {
    // `text` and `children` are mutually exclusive and DocPatch rejects a
    // payload carrying both. Preserving the pinned text here produced exactly
    // that payload: an op that always throws. Structure is lock-governed, so
    // the structural intent wins and the cell simply ceases to exist.
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'leafaaaaaa', tag: 'div', text: 'mine', pins: { text: pin() } }],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'leafaaaaaa', tag: 'div', children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 'theirs' }] }],
    };
    const res = diff(prev, next, { respectPins: true });

    expect(kinds(res.ops)).toEqual(['el.replace']);
    const op = res.ops[0];
    if (op.op !== 'el.replace') { throw new Error('expected el.replace'); }
    expect(op.node.text).toBeUndefined();
    expect(op.node.children).toHaveLength(1);
    expect(() => applyAll(normalizeDoc(clone(prev)), res.ops)).not.toThrow();
    expect(applyAll(normalizeDoc(clone(prev)), res.ops)).toEqual(normalizeDoc(clone(next)));
    // nothing was REFUSED — the incoming tree got what it asked for, so no card
    expect(res.dropped).toEqual([]);
    // a pinned STYLE, which survives both natures, is still honoured
    const styled = diff(
      { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'leafaaaaaa', tag: 'div', text: 'mine', style: { color: 'red' }, pins: { 'style.color': pin() } }] },
      { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'leafaaaaaa', tag: 'div', style: { color: 'blue' }, children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 't' }] }] },
      { respectPins: true },
    );
    const sop = styled.ops[0];
    if (sop.op !== 'el.replace') { throw new Error('expected el.replace'); }
    expect(sop.node.style?.color).toBe('red');
    expect(styled.dropped).toEqual([
      { mid: 'leafaaaaaa', cell: 'style.color', wanted: 'blue', reason: 'pinned-by-human' },
    ]);
  });
});

/* ───────── property: slot-aware rewrites, replayed and pin-checked ───────── */

/**
 * The block above mutates `children` only. Slots are where the differ's two
 * worst bugs actually lived — an orphan stranded in an emptied slot, and a
 * promised move into a slot whose target had already been replaced away — so
 * this generator reaches them: it inserts into slots, empties and deletes whole
 * slots, and reparents ACROSS the children/slot boundary in both directions.
 *
 * Every seed asserts three things at once, which is what makes it worth its
 * runtime:
 *   1. replaying the ops reproduces `next` exactly (structure is correct);
 *   2. with `respectPins`, no emitted op writes a cell the live doc says a
 *      human owns (the pin is not a candidate);
 *   3. after replaying THOSE ops, every surviving pinned cell still holds the
 *      human's value (the pin was not clobbered through some other op — a
 *      replaced ancestor, a re-created node, a payload).
 *
 * (2) without (3) is the trap: the differ can honour the letter of the pin rule
 * op-by-op and still hand back a document where the human's value is gone.
 */
describe('diffDocs — property: slot-aware rewrites replay and respect pins', () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  }

  const TAGS = ['div', 'section', 'p', 'span', 'UI.Card', 'UI.Button'];
  const SLOTS = ['trailing', 'leading', 'actions'];

  function makeTree(rand: () => number, nextId: () => Mid): DocNode {
    const build = (depth: number): DocNode => {
      const n: DocNode = { mid: nextId(), tag: TAGS[Math.floor(rand() * TAGS.length)] };
      if (rand() < 0.4) { n.style = { color: rand() < 0.5 ? 'red' : 'blue', margin: '1px' }; }
      if (rand() < 0.3) { n.props = { label: `l${Math.floor(rand() * 5)}`, deep: { a: [1, 'x'] } }; }
      if (depth >= 3 || rand() < 0.4) { n.text = `t${Math.floor(rand() * 9)}`; return n; }
      const count = Math.floor(rand() * 4);
      if (count > 0) { n.children = Array.from({ length: count }, () => build(depth + 1)); }
      if (rand() < 0.35) { n.slots = { [SLOTS[Math.floor(rand() * SLOTS.length)]]: [build(depth + 1)] }; }
      return n;
    };
    return build(0);
  }

  interface Entry { node: DocNode; parent: DocNode | null; list: DocNode[] | null }
  function flatten(root: DocNode): Entry[] {
    const out: Entry[] = [];
    const visit = (n: DocNode, parent: DocNode | null, list: DocNode[] | null): void => {
      out.push({ node: n, parent, list });
      for (const c of n.children ?? []) { visit(c, n, n.children ?? null); }
      for (const l of Object.values(n.slots ?? {})) { for (const c of l) { visit(c, n, l); } }
    };
    visit(root, null, null);
    return out;
  }
  const isDescendant = (root: DocNode, mid: Mid): boolean => flatten(root).some(e => e.node.mid === mid);

  /** Drop a node into a host's children or one of its slots. */
  function place(host: DocNode, node: DocNode, rand: () => number): void {
    if (rand() < 0.35) {
      const slots = host.slots ?? (host.slots = {});
      const key = SLOTS[Math.floor(rand() * SLOTS.length)];
      const list = slots[key] ?? (slots[key] = []);
      list.splice(Math.floor(rand() * (list.length + 1)), 0, node);
      return;
    }
    const list = host.children ?? (host.children = []);
    list.splice(Math.floor(rand() * (list.length + 1)), 0, node);
  }

  function mutate(root: DocNode, rand: () => number, nextId: () => Mid, rounds: number): DocNode {
    for (let r = 0; r < rounds; r++) {
      const all = flatten(root);
      const containers = all.filter(e => e.node.text === undefined);
      const pick = all[Math.floor(rand() * all.length)];
      const roll = rand();
      if (roll < 0.15 && pick.node.text !== undefined) {
        pick.node.text = `t${Math.floor(rand() * 9)}`;
      } else if (roll < 0.28) {
        if (rand() < 0.3) { delete pick.node.style; } else { pick.node.style = { color: rand() < 0.5 ? 'green' : 'black' }; }
      } else if (roll < 0.38) {
        if (rand() < 0.3) { delete pick.node.props; } else { pick.node.props = { label: `l${Math.floor(rand() * 9)}`, n: Math.floor(rand() * 3) }; }
      } else if (roll < 0.46) {
        pick.node.tag = TAGS[Math.floor(rand() * TAGS.length)];
      } else if (roll < 0.58) {
        if (containers.length === 0) { continue; }
        place(containers[Math.floor(rand() * containers.length)].node, makeTree(rand, nextId), rand);
      } else if (roll < 0.66) {
        // empty or delete a whole slot — how an orphan gets stranded
        const hosts = all.filter(e => e.node.slots && Object.keys(e.node.slots).length > 0);
        if (hosts.length === 0) { continue; }
        const h = hosts[Math.floor(rand() * hosts.length)].node;
        const keys = Object.keys(h.slots ?? {});
        const key = keys[Math.floor(rand() * keys.length)];
        if (rand() < 0.5) { (h.slots ?? {})[key] = []; } else { delete (h.slots ?? {})[key]; }
      } else if (roll < 0.82) {
        const victims = all.filter(e => e.parent !== null && e.list !== null);
        if (victims.length === 0) { continue; }
        const v = victims[Math.floor(rand() * victims.length)];
        v.list!.splice(v.list!.indexOf(v.node), 1);
      } else {
        const movable = all.filter(e => e.parent !== null && e.list !== null);
        if (movable.length === 0) { continue; }
        const m = movable[Math.floor(rand() * movable.length)];
        const hosts = containers.filter(c => c.node !== m.node && !isDescendant(m.node, c.node.mid));
        if (hosts.length === 0) { continue; }
        m.list!.splice(m.list!.indexOf(m.node), 1);
        place(hosts[Math.floor(rand() * hosts.length)].node, m.node, rand);
      }
    }
    return root;
  }

  function sprinkle(root: DocNode, rand: () => number): void {
    for (const e of flatten(root)) {
      if (rand() > 0.25) { continue; }
      const cells = ['text',
        ...Object.keys(e.node.style ?? {}).map(k => `style.${k}`),
        ...Object.keys(e.node.props ?? {}).map(k => `props.${k}`)];
      e.node.pins = { [cells[Math.floor(rand() * cells.length)]]: pin() };
    }
  }

  const cellValue = (n: DocNode, cell: PinCell): unknown => {
    if (cell === TEXT_CELL) { return n.text; }
    if (cell.startsWith('style.')) { return n.style?.[cell.slice(6)]; }
    if (cell.startsWith('props.')) { return n.props?.[cell.slice(6)]; }
    return undefined;
  };

  for (let seed = 1; seed <= 200; seed++) {
    it(`seed ${seed}: replays exactly, and never clobbers a pin`, () => {
      const rand = lcg(seed * 7919 + 13);
      let counter = 0;
      const nextId = (): Mid => `q${String(++counter).padStart(9, '0')}`;
      const bare = makeTree(rand, nextId);
      const next = mutate(clone(bare), rand, nextId, 2 + (seed % 22));

      // 1. structure: the ops rebuild `next` exactly
      const plain = diff(clone(bare), clone(next));
      expect(applyAll(normalizeDoc(clone(bare)), plain.ops)).toEqual(normalizeDoc(clone(next)));
      expect(diff(clone(next), clone(next)).ops).toEqual([]);

      // 2+3. the same rewrite against a doc a human has been editing
      const pinned = clone(bare);
      sprinkle(pinned, rand);
      const res = diff(clone(pinned), clone(next), { respectPins: true });

      for (const op of res.ops) {
        const cells = opCells(op);
        const mid = opMid(op);
        if (!cells || !mid) { continue; }
        const target = findNode(pinned, mid);
        if (!target) { continue; }
        for (const cell of cells) {
          expect(`${op.op} ${mid} ${cell}${isPinned(target, cell) ? ' ← WRITES A PINNED CELL' : ''}`)
            .toBe(`${op.op} ${mid} ${cell}`);
        }
      }

      const out = applyAll(normalizeDoc(clone(pinned)), res.ops);
      for (const before of walk(normalizeDoc(clone(pinned)))) {
        const after = findNode(out, before.mid);
        if (!after) { continue; }   // removal is lock-governed, not pin-governed
        for (const cell of pinnedCells(before)) {
          expect(`${before.mid}.${cell}=${JSON.stringify(cellValue(after, cell))}`)
            .toBe(`${before.mid}.${cell}=${JSON.stringify(cellValue(before, cell))}`);
        }
      }

      for (const d of res.dropped) {
        expect(['pinned-by-human', 'node-vanished']).toContain(d.reason);
        if (d.reason === 'pinned-by-human') { expect(typeof d.cell).toBe('string'); }
      }
    });
  }
});

/* ──────────────── DOC-1 · `text: ''` and absent are ONE state ──────────────── */

/**
 * `DocEmitter.renderChildren` refuses to print an empty text child and
 * `PageCompiler.applyChildItems` refuses to read one back, so `text: ''` cannot
 * survive `compile(emit(doc))`. `_diffCells` normalizes with `?? ''` — but
 * `_natureChanged` used to compare `!== undefined`, so a byte-identical echo of
 * `read_page` looked like a text-leaf/container crossing and emitted
 * `el.replace` on a node nobody touched. That replace re-materializes the node
 * from a `DocNodeInput`, which has no `pins` field: the human's per-cell
 * ownership is deleted with `dropped: []` — the invisible pin failure Plan 22
 * §7 risk 2 calls the worst mode in the system.
 */
describe('diffDocs — an empty text cell is not a nature change', () => {
  it('a verbatim echo of a node holding `text: ""` emits nothing and keeps its pins', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'capaaaaaaa', tag: 'UI.Text', text: '', pins: { text: pin('op-human') } }],
    };
    // exactly what `emit` → `compile` gives back: the empty text is not printed
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'capaaaaaaa', tag: 'UI.Text' }] };

    const res = diff(prev, next, { respectPins: true });

    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([]);
  });

  it('the same echo is a no-op with pins off, in both directions', () => {
    const empty: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'capaaaaaaa', tag: 'p', text: '' }] };
    const absent: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'capaaaaaaa', tag: 'p' }] };
    expect(diff(clone(empty), clone(absent)).ops).toEqual([]);
    expect(diff(clone(absent), clone(empty)).ops).toEqual([]);
  });

  it('clearing real text is `el.setText ""`, not a replace — identity and pins survive', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'capaaaaaaa', tag: 'p', text: 'Caption' }],
    };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'capaaaaaaa', tag: 'p' }] };

    const res = diff(prev, next);

    expect(res.ops).toEqual([{ op: 'el.setText', pageId: PAGE, mid: 'capaaaaaaa', text: '' }]);
    // and it is executable: DocPatch accepts setText on a childless node
    const out = applyAll(normalizeDoc(clone(prev)), res.ops);
    expect(findNode(out, 'capaaaaaaa')?.text).toBe('');
  });

  it('a node holding `text: ""` that GAINS children still replaces', () => {
    // `DocPatch` guards the text-leaf invariant on PRESENCE (`text !== undefined`),
    // so `el.insert` under a node storing `''` is refused. Normalizing the
    // content view must not normalize that guard away.
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'boxaaaaaaa', tag: 'div', text: '' }] };
    const next: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'boxaaaaaaa', tag: 'div', children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 'hi' }] }],
    };

    const res = diff(prev, next);

    expect(kinds(res.ops)).toEqual(['el.replace']);
    expect(applyAll(normalizeDoc(clone(prev)), res.ops)).toEqual(normalizeDoc(clone(next)));
  });

  it('a container gaining EMPTY text is not a replace', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'div',
      children: [{ mid: 'boxaaaaaaa', tag: 'div', children: [{ mid: 'kidaaaaaaa', tag: 'span', text: 'hi' }] }],
    };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div', children: [{ mid: 'boxaaaaaaa', tag: 'div', text: '' }] };

    const res = diff(prev, next);

    expect(kinds(res.ops)).toEqual(['el.remove']);
  });
});

/* ─────── DOC-4 · a prop the emitter cannot print is not a deletion intent ─────── */

/**
 * `DocEmitter` skips any prop whose name is not a printable JSX attribute
 * (`isEmittablePropName`), while `set_prop` / `el.setProp` accept any non-empty
 * name. Such a prop is therefore invisible in `read_page` — and since the differ
 * compares the live doc against the tree compiled from that same JSX, its
 * absence from `next` used to read as "the writer removed it" and became
 * `el.setProp value: null`. Deletion was the default for anything the emitter
 * could not show, and it was reported nowhere.
 */
describe('diffDocs — invisible props are not deletable by a rewrite', () => {
  it('a verbatim echo does not delete a prop the emitter cannot print', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Grid', props: { '2col': true, gap: 20 } };
    // what `read_page` shows, compiled back: `2col` was never printed
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Grid', props: { gap: 20 } };

    const res = diff(prev, next);

    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([
      { mid: 'rootaaaaaa', cell: 'props.2col', wanted: null, reason: 'refused' },
    ]);
  });

  it('covers the names the emitter reserves as well as the unprintable ones', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div', props: { mid: 'x', style: 'y', 'a b': 1 } };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'div' };

    const res = diff(prev, next);

    expect(res.ops).toEqual([]);
    expect(res.dropped.map(d => d.cell).sort()).toEqual(['props.a b', 'props.mid', 'props.style']);
  });

  it('still deletes a prop the writer COULD see', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Grid', props: { '2col': true, gap: 20 } };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Grid' };

    const res = diff(prev, next);

    expect(res.ops).toEqual([{ op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: 'gap', value: null }]);
  });

  it('still CHANGES an invisible prop when the incoming tree names one', () => {
    // absence is not intent; a present value is.
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Grid', props: { '2col': true } };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Grid', props: { '2col': false } };

    const res = diff(prev, next);

    expect(res.ops).toEqual([{ op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: '2col', value: false }]);
  });

  it('a pinned invisible prop still reports the stronger reason', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa', tag: 'UI.Grid', props: { '2col': true }, pins: { 'props.2col': pin() },
    };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'UI.Grid' };

    const res = diff(prev, next, { respectPins: true });

    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([
      { mid: 'rootaaaaaa', cell: 'props.2col', wanted: null, reason: 'pinned-by-human' },
    ]);
  });
});
