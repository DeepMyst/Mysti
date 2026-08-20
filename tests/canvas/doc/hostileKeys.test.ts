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
 * Plan 22 — the `__proto__` class of defect, swept across the two modules that
 * still wrote model-authored keys with a bare `obj[k] = v`.
 *
 * Slot names, prop names and style properties are all MODEL-AUTHORED strings.
 * `obj['__proto__'] = v` does not create a property: it invokes
 * `Object.prototype`'s prototype setter, which silently ignores a primitive and
 * REPLACES the target's prototype for an object. Either way the cell vanishes
 * from `Object.keys` / `JSON.stringify` while `for…in` still sees it, and a node
 * parked in a `__proto__`-named slot becomes unreachable to `walk` — hence
 * un-addressable, un-removable and un-undoable.
 *
 * `PageCompiler.setCell`, `DocEmitter.objectKey`/`styleKey`, `DocNode.cloneNode`
 * and `DocPatch._put` all go out of their way to make such a cell survive, so a
 * value that reaches `Reconciler` / `TreeDiffer` intact must leave them intact
 * too. These tests assert the whole round trip, not the helper in isolation.
 */

import { describe, expect, it } from 'vitest';

import { reconcile } from '../../../src/canvas/doc/Reconciler';
import { diffDocs } from '../../../src/canvas/doc/TreeDiffer';
import { emitElement } from '../../../src/canvas/doc/DocEmitter';
import { compile } from '../../../src/canvas/doc/PageCompiler';
import { applyOp } from '../../../src/canvas/doc/DocPatch';
import type { CanvasOp } from '../../../src/canvas/CanvasOps';
import type { DocNode, DocNodeInput, JsonValue, Mid } from '../../../src/canvas/doc/DocNode';

const PAGE = 'page-1';
const HOSTILE = '__proto__';

function counterMint(): () => Mid {
  let n = 0;
  return () => `zz${String(++n).padStart(8, '0')}`;
}

function kinds(ops: CanvasOp[]): string[] { return ops.map(o => o.op); }

function diff(prev: DocNode, next: DocNode, respectPins = false) {
  return diffDocs(prev, next, { pageId: PAGE, mintMid: counterMint(), respectPins });
}

/**
 * An OWN `__proto__` property — the only way to build the fixture, since an
 * object literal `{ __proto__: v }` is a prototype directive, not a property.
 */
function withProto<T>(obj: Record<string, T>, value: T): Record<string, T> {
  Object.defineProperty(obj, HOSTILE, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}

/** An own `__proto__` cell must be present, enumerable, and leave the prototype alone. */
function expectOwnProto(target: Record<string, unknown> | undefined, label: string): unknown {
  expect(target, `${label}: the whole record vanished`).toBeDefined();
  expect(Object.keys(target ?? {}), `${label}: not an own enumerable key`).toContain(HOSTILE);
  expect(Object.getPrototypeOf(target ?? {}), `${label}: prototype was replaced`).toBe(Object.prototype);
  return Object.getOwnPropertyDescriptor(target ?? {}, HOSTILE)?.value;
}

const pin = (opId = 'op-h') => ({ at: 1_700_000_000_000, opId });

/* ───────────────────────────── DOC-2 · Reconciler ───────────────────────────── */

describe('Reconciler — a hostile slot name', () => {
  it('keeps a `__proto__` slot, its subtree and its pin instead of deleting them silently', () => {
    const prev: DocNode = {
      mid: 'aaaaaaaaaa',
      tag: 'UI.Card',
      slots: withProto<DocNode[]>({}, [
        { mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'Total: $4,210', pins: { 'style.color': pin() } },
      ]),
    };
    const next: DocNodeInput = {
      mid: 'aaaaaaaaaa',
      tag: 'UI.Card',
      slots: withProto<DocNodeInput[]>({}, [{ mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'Total: $4,210' }]),
    };

    const r = reconcile(prev, next);

    const list = expectOwnProto(r.doc.slots as Record<string, unknown> | undefined, 'reconciled slots') as DocNode[];
    expect(list).toHaveLength(1);
    expect(list[0].mid).toBe('bbbbbbbbbb');
    expect(list[0].text).toBe('Total: $4,210');
    // Tier 1 (echoed) carries the pin, so the human still owns the cell.
    expect(list[0].pins?.['style.color']).toBeDefined();
    // Nothing was lost, so nothing may be reported as lost.
    expect(r.lost).toEqual([]);
    expect(r.droppedPins).toEqual([]);
  });

  it('records a tier for a node whose stored mid is `__proto__`', () => {
    // A persisted artifact.json is not the host's own minting: a hand-edited or
    // hostile one can carry any string as a mid, and `tiers` is what the caller
    // reads to decide whether a pin may ride along.
    const prev: DocNode = { mid: HOSTILE, tag: 'div', children: [{ mid: 'bbbbbbbbbb', tag: 'p', text: 'x' }] };
    const next: DocNodeInput = { mid: HOSTILE, tag: 'div', children: [{ mid: 'bbbbbbbbbb', tag: 'p', text: 'y' }] };

    const r = reconcile(prev, next);

    expect(r.doc.mid).toBe(HOSTILE);
    expect(Object.keys(r.tiers)).toContain(HOSTILE);
    expect(Object.getOwnPropertyDescriptor(r.tiers, HOSTILE)?.value).toBe('exact');
  });
});

/* ───────────────────────────── DOC-3 · TreeDiffer ───────────────────────────── */

describe('TreeDiffer — hostile keys reach the ops intact', () => {
  it('carries a `__proto__` style property into the el.setStyle patch', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x' };
    const next: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'span',
      text: 'x',
      style: withProto<string>({ color: 'blue' }, 'red'),
    };

    const res = diff(prev, next);

    expect(res.ops).toHaveLength(1);
    const op = res.ops[0];
    if (op.op !== 'el.setStyle') { throw new Error(`expected el.setStyle, got ${op.op}`); }
    expect(expectOwnProto(op.style, 'setStyle patch')).toBe('red');
    expect(op.style.color).toBe('blue');
  });

  it('carries a `__proto__` style REMOVAL into the patch as null, without nulling the patch prototype', () => {
    // `patch['__proto__'] = null` is the worst of the two: the setter accepts
    // `null` and turns the patch itself into a prototype-less object.
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x', style: withProto<string>({}, 'red') };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x' };

    const res = diff(prev, next);

    expect(res.ops).toHaveLength(1);
    const op = res.ops[0];
    if (op.op !== 'el.setStyle') { throw new Error(`expected el.setStyle, got ${op.op}`); }
    expect(expectOwnProto(op.style, 'setStyle removal patch')).toBeNull();
  });

  it('preserves a pinned `style.__proto__` across an identity-keeping replace', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'div',
      children: [{
        mid: 'bbbbbbbbbb',
        tag: 'h1',
        text: 'T',
        style: withProto<string>({}, 'red'),
        pins: { 'style.__proto__': pin() },
      }],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'div',
      // tag change ⇒ el.replace, the path `_preservePins` exists for. The
      // incoming tree DROPS the cell, so the payload gets no own `__proto__`
      // from the spread and the restore is the only thing that can put it back.
      children: [{ mid: 'bbbbbbbbbb', tag: 'h2', text: 'T', style: { color: 'blue' } }],
    };

    const res = diff(prev, next, true);

    expect(res.ops).toHaveLength(1);
    const op = res.ops[0];
    if (op.op !== 'el.replace') { throw new Error(`expected el.replace, got ${op.op}`); }
    expect(expectOwnProto(op.node.style, 'replaced node style')).toBe('red');
    expect(res.dropped).toEqual([
      { mid: 'bbbbbbbbbb', cell: 'style.__proto__', wanted: null, reason: 'pinned-by-human' },
    ]);
  });

  it('preserves a pinned `props.__proto__` across an identity-keeping replace', () => {
    const keep: JsonValue = { x: 1 };
    const prev: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'div',
      children: [{
        mid: 'bbbbbbbbbb',
        tag: 'h1',
        text: 'T',
        props: withProto<JsonValue>({}, keep),
        pins: { 'props.__proto__': pin() },
      }],
    };
    const next: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'div',
      children: [{ mid: 'bbbbbbbbbb', tag: 'h2', text: 'T', props: withProto<JsonValue>({}, { x: 2 }) }],
    };

    const res = diff(prev, next, true);

    expect(res.ops).toHaveLength(1);
    const op = res.ops[0];
    if (op.op !== 'el.replace') { throw new Error(`expected el.replace, got ${op.op}`); }
    expect(expectOwnProto(op.node.props, 'replaced node props')).toEqual({ x: 1 });
  });

  it('carries a `__proto__` slot into an insert payload', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    const next: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'div',
      children: [{
        mid: 'bbbbbbbbbb',
        tag: 'UI.Card',
        slots: withProto<DocNode[]>({}, [{ mid: 'cccccccccc', tag: 'UI.Text', text: 'hi' }]),
      }],
    };

    const res = diff(prev, next);

    expect(res.ops).toHaveLength(1);
    const op = res.ops[0];
    if (op.op !== 'el.insert') { throw new Error(`expected el.insert, got ${op.op}`); }
    const list = expectOwnProto(op.node.slots as Record<string, unknown> | undefined, 'payload slots') as DocNodeInput[];
    expect(list[0].mid).toBe('cccccccccc');
  });

  it('carries a `__proto__` prop name and a nested `__proto__` value into an insert payload', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'div' };
    const next: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'div',
      children: [{
        mid: 'bbbbbbbbbb',
        tag: 'span',
        text: 'hi',
        props: withProto<JsonValue>({ data: withProto<JsonValue>({ y: 2 }, { x: 1 }) }, 'top'),
      }],
    };

    const res = diff(prev, next);

    expect(res.ops).toHaveLength(1);
    const op = res.ops[0];
    if (op.op !== 'el.insert') { throw new Error(`expected el.insert, got ${op.op}`); }
    // `_cloneProps` — the top-level name
    expect(expectOwnProto(op.node.props, 'payload props')).toBe('top');
    // `_cloneJson` — the nested value's own key
    const data = op.node.props?.data as Record<string, unknown> | undefined;
    expect(expectOwnProto(data, 'nested prop value')).toEqual({ x: 1 });
    expect(data?.y).toBe(2);
  });

  it('emits an el.setProp for a prop literally named `__proto__`', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x' };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x', props: withProto<JsonValue>({}, 'v') };

    const res = diff(prev, next);

    expect(res.ops).toEqual([
      { op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: HOSTILE, value: 'v' },
    ]);
  });
});

/* ───────── the read-side twin: a MISSING `__proto__` cell is not absent ───────── */

/**
 * `record['__proto__']` on a record that has no such own property does not
 * return `undefined` — it runs `Object.prototype.__proto__`'s GETTER and hands
 * back `Object.prototype`. Every "is this cell absent?" test in the differ is
 * written against `undefined`, so the missing cell reads as a live object value.
 */
describe('TreeDiffer — a missing hostile key reads as absent, not as Object.prototype', () => {
  it('does not throw when a `__proto__` slot exists only in prev', () => {
    const prev: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'UI.Card',
      slots: withProto<DocNode[]>({}, [{ mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'gone' }]),
    };
    // a slots record that EXISTS but has no own `__proto__` — so `?? []` cannot
    // save the read, and `Object.prototype` is handed to a `for…of`
    const next: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'UI.Card',
      slots: { trailing: [{ mid: 'cccccccccc', tag: 'UI.Badge', text: 'new' }] },
    };

    const res = diff(prev, next);

    expect(kinds(res.ops).sort()).toEqual(['el.insert', 'el.remove']);
    expect(res.ops.some(o => o.op === 'el.remove' && o.mid === 'bbbbbbbbbb')).toBe(true);
  });

  it('reports a removed `__proto__` style property as null, not as an object', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x', style: withProto<string>({}, 'red') };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x', style: { color: 'blue' } };

    const res = diff(prev, next);

    expect(res.ops).toHaveLength(1);
    const op = res.ops[0];
    if (op.op !== 'el.setStyle') { throw new Error(`expected el.setStyle, got ${op.op}`); }
    expect(expectOwnProto(op.style, 'setStyle patch')).toBeNull();
    expect(op.style.color).toBe('blue');
  });

  it('reports a removed `__proto__` prop as null, not as an object', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x', props: withProto<JsonValue>({}, 'v') };
    const next: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x', props: { gap: 1 } };

    const res = diff(prev, next);

    expect(res.ops).toEqual([
      { op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: HOSTILE, value: null },
      { op: 'el.setProp', pageId: PAGE, mid: 'rootaaaaaa', name: 'gap', value: 1 },
    ]);
  });
});

/* ─────────────────── the full emit → compile → reconcile → diff loop ─────────────────── */

describe('doc pipeline — a hostile slot survives a whole read_page round trip', () => {
  it('emits, compiles, reconciles and diffs to zero ops', () => {
    const prev: DocNode = {
      mid: 'aaaaaaaaaa',
      tag: 'UI.Card',
      slots: withProto<DocNode[]>({}, [{ mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'hello' }]),
    };

    const source = `function Page(){ return ${emitElement(prev, { mids: true })}; }`;
    const compiled = compile(source);
    expect(compiled.ok, compiled.ok ? '' : compiled.error).toBe(true);
    if (!compiled.ok) { return; }

    const r = reconcile(prev, compiled.doc);
    const list = expectOwnProto(r.doc.slots as Record<string, unknown> | undefined, 'round-tripped slots') as DocNode[];
    expect(list[0].mid).toBe('bbbbbbbbbb');

    const res = diffDocs(prev, r.doc, { pageId: PAGE, mintMid: counterMint(), respectPins: true });
    expect(res.ops).toEqual([]);
    expect(res.dropped).toEqual([]);
  });

  it('an op carrying a hostile key still applies through DocPatch', () => {
    const prev: DocNode = { mid: 'rootaaaaaa', tag: 'span', text: 'x' };
    const next: DocNode = {
      mid: 'rootaaaaaa',
      tag: 'span',
      text: 'x',
      style: withProto<string>({ color: 'blue' }, 'red'),
    };

    const ops: CanvasOp[] = diff(prev, next).ops;
    let doc = prev;
    for (const op of ops) { doc = applyOp(doc, op).doc; }

    expect(expectOwnProto(doc.style, 'applied style')).toBe('red');
  });
});
