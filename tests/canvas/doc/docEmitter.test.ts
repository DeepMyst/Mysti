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
 * Plan 22 §3.1 — doc → JSX. The half of the contract the model reads.
 */

import { describe, expect, it } from 'vitest';

import { PIN_MARKER, emit, emitElement, isEmittablePropName } from '../../../src/canvas/doc/DocEmitter';
import { compile } from '../../../src/canvas/doc/PageCompiler';
import type { DocNode } from '../../../src/canvas/doc/DocNode';

const node = (n: Partial<DocNode> & { tag: string }): DocNode => ({ mid: 'aaaaaaaaaa', ...n });

/** Every emitter output must be valid input to the compiler. */
function parses(source: string): void {
  const r = compile(source);
  expect(r.ok, r.ok ? '' : `${r.error}\n---\n${source}`).toBe(true);
}

/** An emitted subtree read straight back — the loop a `read_page` edit takes. */
function reparse(element: string): DocNode {
  const source = `function Page(){ return ${element}; }`;
  const r = compile(source);
  expect(r.ok, r.ok ? '' : `${r.error}\n---\n${source}`).toBe(true);
  if (!r.ok) { throw new Error(r.error); }
  return r.doc;
}

describe('DocEmitter — shape', () => {
  it('emits a readable `function Page()`', () => {
    const out = emit(node({ tag: 'UI.Screen' }));
    expect(out).toBe('function Page() {\n  return (\n    <UI.Screen />\n  );\n}');
    parses(out);
  });

  it('omits mids by default and renders them on request', () => {
    const doc = node({ mid: 'k7f2xq3b4m', tag: 'div' });
    expect(emit(doc)).not.toContain('mid=');
    expect(emit(doc, { mids: true })).toContain('mid="k7f2xq3b4m"');
  });

  it('renders a mid on EVERY element, including inside slots', () => {
    const doc = node({
      mid: 'aaaaaaaaaa',
      tag: 'div',
      slots: { lead: [node({ mid: 'bbbbbbbbbb', tag: 'span' })] },
      children: [node({ mid: 'cccccccccc', tag: 'p' })],
    });
    const out = emit(doc, { mids: true });
    for (const m of ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']) { expect(out).toContain(`mid="${m}"`); }
  });

  it('routes a malformed mid through an expression so the source still parses', () => {
    const out = emit(node({ mid: 'not a mid"', tag: 'div' }), { mids: true });
    expect(out).toContain('mid={');
    parses(out);
  });

  it('emitElement returns the bare subtree', () => {
    expect(emitElement(node({ tag: 'p', text: 'hi' }))).toBe('<p>hi</p>');
  });
});

describe('DocEmitter — props', () => {
  it('uses the JSX shorthand for `true` and a container for `false`', () => {
    const out = emitElement(node({ tag: 'UI.X', props: { muted: true, deltaUp: false } }));
    expect(out).toBe('<UI.X muted deltaUp={false} />');
  });

  it('emits numbers, null and nested data', () => {
    const out = emitElement(node({ tag: 'UI.X', props: { gap: 16, neg: -2.5, nul: null, o: { a: [1, 'x'] } } }));
    expect(out).toBe(`<UI.X gap={16} neg={-2.5} nul={null} o={{ a: [1, 'x'] }} />`);
    parses(`function Page(){ return ${out}; }`);
  });

  it('escapes a string prop that JSX would otherwise mangle', () => {
    const out = emitElement(node({ tag: 'UI.X', props: { a: 'q"q', b: 'a & b', c: 'line\nbreak' } }));
    expect(out).toContain(`a={'q"q'}`);
    expect(out).toContain(`b={'a & b'}`);
    expect(out).toContain(`c={'line\\nbreak'}`);
    parses(`function Page(){ return ${out}; }`);
  });

  it('breaks a long data prop across lines and still parses', () => {
    const data = Array.from({ length: 12 }, (_, i) => ({ label: `m${i}`, value: i * 3 }));
    const out = emit(node({ tag: 'UI.Chart', props: { data } }));
    expect(out.split('\n').length).toBeGreaterThan(10);
    expect(out.split('\n').every(l => l.length <= 120)).toBe(true);
    parses(out);
  });

  it('drops a prop whose name could not be written as JSX', () => {
    const out = emitElement(node({ tag: 'UI.X', props: { 'bad name': 1, '"><script>': 2, good: 3 } }));
    expect(out).toBe('<UI.X good={3} />');
    parses(`function Page(){ return ${out}; }`);
  });

  it('writes a non-finite number as null rather than an identifier', () => {
    const out = emitElement(node({ tag: 'UI.X', props: { n: Number.NaN, i: Number.POSITIVE_INFINITY } }));
    expect(out).toBe('<UI.X n={null} i={null} />');
    parses(`function Page(){ return ${out}; }`);
  });

  it('quotes object keys that are not identifiers', () => {
    const out = emitElement(node({ tag: 'UI.X', props: { o: { 'a-b': 1, ok: 2 } } }));
    expect(out).toBe(`<UI.X o={{ 'a-b': 1, ok: 2 }} />`);
  });
});

describe('DocEmitter — style', () => {
  it('camel-cases kebab keys back for readability', () => {
    const out = emitElement(node({ tag: 'div', style: { 'align-items': 'center', padding: '24px' } }));
    expect(out).toBe(`<div style={{ alignItems: 'center', padding: '24px' }} />`);
  });

  it('keeps custom properties quoted', () => {
    const out = emitElement(node({ tag: 'div', style: { '--brand': '#0f0' } }));
    expect(out).toBe(`<div style={{ '--brand': '#0f0' }} />`);
    parses(`function Page(){ return ${out}; }`);
  });

  it('breaks a large style block across lines', () => {
    const style: Record<string, string> = {};
    for (let i = 0; i < 12; i++) { style[`--token-${i}`] = `value-${i}`; }
    const out = emit(node({ tag: 'div', style }));
    expect(out).toContain('style={{');
    parses(out);
  });
});

describe('DocEmitter — text', () => {
  it('writes plain text inline', () => {
    expect(emitElement(node({ tag: 'p', text: 'Hello there' }))).toBe('<p>Hello there</p>');
  });

  it('escapes text JSX would trim, collapse or decode', () => {
    for (const text of [' padded ', 'a & b', 'a < b', '{braces}', 'two\nlines', '</p> literal']) {
      const out = emitElement(node({ tag: 'p', text }));
      const src = `function Page(){ return ${out}; }`;
      const r = compile(src);
      expect(r.ok, r.ok ? '' : `${r.error} for ${JSON.stringify(text)}`).toBe(true);
      if (r.ok) { expect(r.doc.text ?? '').toBe(text); }
    }
  });

  it('treats empty text as no content at all', () => {
    expect(emitElement(node({ tag: 'p', text: '' }))).toBe('<p />');
  });

  it('emits text and children together rather than losing either', () => {
    const out = emit(node({ tag: 'p', text: 'lead ', children: [node({ tag: 'b', text: 'x' })] }));
    const r = compile(out);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.children?.map(c => [c.tag, c.text])).toEqual([['span', 'lead '], ['b', 'x']]);
    }
  });
});

describe('DocEmitter — slots', () => {
  it('emits a single-node slot inline', () => {
    const out = emitElement(node({ tag: 'UI.ListRow', slots: { trailing: [node({ tag: 'UI.Text', text: '-$9.99' })] } }));
    expect(out).toBe('<UI.ListRow trailing={<UI.Text>-$9.99</UI.Text>} />');
  });

  it('emits a multi-node slot as an array', () => {
    const out = emit(node({
      tag: 'UI.TopBar',
      slots: { actions: [node({ tag: 'UI.Button', props: { label: 'a' } }), node({ tag: 'UI.Avatar' })] },
    }));
    expect(out).toContain('actions={[');
    expect(out).toContain('<UI.Avatar />,');
    parses(out);
  });

  it('emits an empty slot as an empty array', () => {
    expect(emitElement(node({ tag: 'UI.X', slots: { actions: [] } }))).toBe('<UI.X actions={[]} />');
  });

  it('expands a slot whose content does not fit on one line', () => {
    const out = emit(node({
      tag: 'UI.AppShell',
      slots: {
        sidebar: [node({
          tag: 'UI.Sidebar',
          props: { brand: 'Acme' },
          children: Array.from({ length: 5 }, () => node({ tag: 'UI.SidebarItem', props: { label: 'Overview' } })),
        })],
      },
    }));
    expect(out).toContain('sidebar={');
    parses(out);
  });
});

describe('DocEmitter — pins are visible to the model', () => {
  const pinned = node({
    mid: 'k7f2xq3b4m',
    tag: 'UI.Button',
    props: { label: 'Go' },
    style: { background: 'red' },
    pins: {
      'style.background': { at: 1, opId: 'op1' },
      'props.label': { at: 2, opId: 'op2' },
    },
  });

  it('annotates human-owned cells inline, sorted', () => {
    const out = emitElement(pinned, { mids: true, pins: true });
    expect(out).toContain(`/* ${PIN_MARKER} props.label, style.background */`);
    expect(out.indexOf('mid=')).toBeLessThan(out.indexOf(PIN_MARKER));
    parses(`function Page(){ return ${out}; }`);
  });

  it('says nothing when pins are off or absent', () => {
    expect(emitElement(pinned, { mids: true })).not.toContain(PIN_MARKER);
    expect(emitElement(node({ tag: 'div' }), { pins: true })).not.toContain(PIN_MARKER);
  });

  it('a crafted pin cell can neither close the comment nor inject a newline', () => {
    const hostile = node({
      tag: 'div',
      pins: {
        'props.*/ alert(1) /*': { at: 1, opId: 'x' },
        'props.a\n*/<script>': { at: 1, opId: 'y' },
      },
    });
    const out = emit(hostile, { pins: true });
    expect(out).not.toContain('*/ alert');
    expect(out).not.toContain('<script>');
    expect(out.match(/\*\//g)).toHaveLength(1);
    parses(out);
  });

  it('pins never come back as props', () => {
    const r = compile(emit(pinned, { mids: true, pins: true }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.props).toEqual({ label: 'Go' });
      expect(r.doc.pins).toBeUndefined();
    }
  });
});

describe('DocEmitter — hostile docs still produce parseable JSX', () => {
  it('degrades an unusable tag to div', () => {
    for (const tag of ['', '<script>', 'div onload=x', '../../etc', '9lives']) {
      const out = emit(node({ tag }));
      expect(out).toContain('<div');
      parses(out);
    }
  });

  it('survives a deeply nested tree', () => {
    let doc = node({ tag: 'span', text: 'deep' });
    for (let i = 0; i < 60; i++) { doc = node({ tag: 'div', children: [doc] }); }
    const out = emit(doc, { mids: true });
    parses(out);
  });

  it('writes `__proto__` in the computed form, which is a property not a directive', () => {
    // A doc reaches the emitter from JSON on disk, and JSON.parse DOES create a
    // real own `__proto__` property. Printed as `{ __proto__: … }` that would be
    // a prototype directive storing nothing, so it goes out as `['__proto__']`.
    const parsed = JSON.parse(
      '{"mid":"aaaaaaaaaa","tag":"UI.X","props":{"data":{"__proto__":{"deep":1},"ok":2}},' +
      '"style":{"__proto__":"x","color":"red"}}',
    ) as DocNode;
    expect(Object.prototype.hasOwnProperty.call(parsed.props!.data as object, '__proto__')).toBe(true);

    const out = emit(parsed, { mids: true });
    expect(out).toContain(`['__proto__']`);
    expect(out).not.toMatch(/[^[']__proto__[^']/);
    parses(out);

    const r = compile(out);
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    const data = r.doc.props?.data as Record<string, unknown>;
    expect(JSON.stringify(data)).toBe('{"__proto__":{"deep":1},"ok":2}');
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(JSON.stringify(r.doc.style)).toBe('{"__proto__":"x","color":"red"}');
    expect(Object.getPrototypeOf(r.doc.style!)).toBe(Object.prototype);
  });

  it('keeps a `__proto__` prop name, which JSX spells literally', () => {
    const doc = node({ tag: 'UI.X', props: JSON.parse('{"__proto__":1,"keep":2}') as Record<string, never> });
    const back = reparse(emitElement(doc, { mids: true }));
    expect(Object.keys(back.props ?? {})).toEqual(['__proto__', 'keep']);
    expect(Object.getPrototypeOf(back.props!)).toBe(Object.prototype);
    expect(JSON.stringify(back.props)).toBe('{"__proto__":1,"keep":2}');
  });

  it('keeps a `__proto__` slot name', () => {
    const doc = node({
      tag: 'UI.X',
      slots: JSON.parse('{"__proto__":[{"mid":"bbbbbbbbbb","tag":"p","text":"y"}]}') as Record<string, DocNode[]>,
    });
    const back = reparse(emitElement(doc, { mids: true }));
    expect(Object.keys(back.slots ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(back.slots!)).toBe(Object.prototype);
    expect(back.slots!['__proto__'][0].text).toBe('y');
  });

  it('escapes control characters and line separators in strings', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const bell = String.fromCharCode(0x07);
    const raw = `x${ls}y${ps}z${bell}w`;
    const out = emitElement(node({ tag: 'UI.X', props: { a: raw } }));
    expect(out).not.toMatch(new RegExp(`[${ls}${ps}${bell}]`));
    const r = compile(`function Page(){ return ${out}; }`);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) { expect(r.doc.props?.a).toBe(raw); }
  });
});

/* ─────────── DOC-4 · the predicate the write side has to share ─────────── */

/**
 * The emitter is the only place that knows which prop names it can print, and
 * it prints into JSX — where an attribute name is grammatically an identifier.
 * `2col`, `a b` and `foo.bar` have NO JSX attribute spelling (the compiler
 * rejects `{...spread}`, PageCompiler.ts:311-313), and `mid`/`style` already
 * mean something else. A prop the emitter drops is invisible in `read_page`, so
 * the doc must never be allowed to hold one — which means the write side needs
 * this exact predicate rather than a second copy of it.
 */
describe('DocEmitter — isEmittablePropName', () => {
  it('accepts the names JSX can carry', () => {
    for (const name of ['gap', 'data', 'aria-label', 'xlink:href', '$x', '_x', '__proto__']) {
      expect(isEmittablePropName(name), name).toBe(true);
    }
  });

  it('rejects the names JSX cannot carry, and the two the emitter reserves', () => {
    for (const name of ['2col', 'a b', 'foo.bar', '', 'mid', 'style', 'café']) {
      expect(isEmittablePropName(name), name).toBe(false);
    }
  });

  it('agrees with what emit actually prints', () => {
    const out = emitElement(node({ tag: 'UI.Grid', props: { '2col': true, gap: 20, mid: 'nope' } }), { mids: true });
    expect(out).not.toContain('2col');
    expect(out).toContain('gap={20}');
    // `mid` in the props bag is the identity attribute, never the prop
    expect(out).toContain('mid="aaaaaaaaaa"');
    expect(out).not.toContain('nope');
    parses(`function Page(){ return ${out}; }`);
  });
});
