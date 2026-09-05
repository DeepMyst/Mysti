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
 * Plan 22 §3.1 — `compile(emit(doc)) ≡ doc`. THE contract of the doc model.
 *
 * PageCompiler and DocEmitter are two halves of one seam, so they are tested as
 * one: every drift in this subsystem has come from letting one side move alone.
 * If a construct survives here it survives `read_page` → model → `write_page`,
 * which is the only path an agent's edit ever takes.
 */

import { describe, expect, it } from 'vitest';

import { emit } from '../../../src/canvas/doc/DocEmitter';
import { compile } from '../../../src/canvas/doc/PageCompiler';
import { walk, type DocNode, type JsonValue } from '../../../src/canvas/doc/DocNode';
import { PAGE_SCAFFOLDS } from '../../../src/managers/CanvasScaffolds';

/** Everything about a node except its identity — for "equal ignoring mids". */
function shape(n: DocNode): unknown {
  const out: Record<string, unknown> = { tag: n.tag };
  if (n.props) { out.props = n.props; }
  if (n.style) { out.style = n.style; }
  if (n.text !== undefined) { out.text = n.text; }
  if (n.children) { out.children = n.children.map(shape); }
  if (n.slots) {
    out.slots = Object.fromEntries(Object.entries(n.slots).map(([k, v]) => [k, v.map(shape)]));
  }
  return out;
}

function mustCompile(source: string, label = ''): DocNode {
  const r = compile(source);
  if (!r.ok) { throw new Error(`${label} compile failed: ${r.error}\n---\n${source}`); }
  return r.doc;
}

/**
 * The full loop. Returns the doc that came back so callers can assert on it.
 *
 * `mids: true` must preserve identity exactly; `mids: false` must preserve
 * everything else. Both are asserted on every fixture.
 */
function roundTrip(doc: DocNode, label: string): DocNode {
  const withIds = emit(doc, { mids: true });
  const back = mustCompile(withIds, `${label} [mids]`);
  expect(shape(back), `${label}: shape drifted`).toEqual(shape(doc));
  expect([...walk(back)].map(n => n.mid), `${label}: identity drifted`)
    .toEqual([...walk(doc)].map(n => n.mid));

  const anonymous = mustCompile(emit(doc), `${label} [no mids]`);
  expect(shape(anonymous), `${label}: shape drifted without mids`).toEqual(shape(doc));

  const annotated = mustCompile(emit(doc, { mids: true, pins: true }), `${label} [pins]`);
  expect(shape(annotated), `${label}: pin comments changed the doc`).toEqual(shape(doc));

  // Source-level fixed point: a second pass must produce byte-identical JSX.
  expect(emit(back, { mids: true }), `${label}: emit is not idempotent`).toBe(withIds);
  return back;
}

describe('round trip — the five shipped scaffolds', () => {
  for (const scaffold of PAGE_SCAFFOLDS) {
    it(`compile(emit(compile("${scaffold.id}"))) is the same document`, () => {
      const doc = mustCompile(scaffold.jsx, scaffold.id);
      roundTrip(doc, scaffold.id);
    });
  }

  it('a scaffold emitted with mids can be edited by mid and re-read', () => {
    const doc = mustCompile(PAGE_SCAFFOLDS.find(s => s.id === 'dashboard')!.jsx);
    const target = [...walk(doc)].find(n => n.tag === 'UI.StatCard')!;
    const source = emit(doc, { mids: true });
    expect(source).toContain(`mid="${target.mid}"`);
    // Simulate the model echoing the page back with one label changed.
    const edited = source.replace('label="Revenue" value="$48.2k"', 'label="MRR" value="$48.2k"');
    const back = mustCompile(edited);
    const sameNode = [...walk(back)].find(n => n.mid === target.mid);
    expect(sameNode?.props?.label).toBe('MRR');
    expect([...walk(back)].map(n => n.mid)).toEqual([...walk(doc)].map(n => n.mid));
  });
});

describe('round trip — every supported construct', () => {
  const fixtures: Record<string, string> = {
    'bare element': '<div />',
    'nested elements': '<div><section><p /></section><footer /></div>',
    'literal props': `<UI.X s="str" n={12} f={2.5} neg={-4} t b={false} nul={null} tpl={\`raw\`} />`,
    'dashed and namespaced props': '<div data-testid="t" aria-label="l" xlinkHref="#a" />',
    'object and array data': `<UI.Chart data={[{ label: 'Jan', value: 22 }, { label: 'Feb', value: 30 }]} meta={{ a: { b: [1, 2, null] } }} />`,
    'empty array prop': '<UI.X items={[]} />',
    'style, every flavour': `<div style={{ alignItems: 'center', fontSize: 13, flex: 2, margin: 0, width: '100%', '--brand': '#0f0', 'z-index': 3 }} />`,
    'single JSX slot': '<UI.ListRow leading={<UI.Avatar initials="SP" size={32} />} title="Spotify" />',
    'array JSX slot': '<UI.TopBar actions={[<UI.Button key="n" label="Export" />, <UI.Avatar key="a" />]} />',
    'slot inside a slot': '<UI.AppShell topBar={<UI.TopBar actions={[<UI.Badge tone="success">+1</UI.Badge>]} />} />',
    'slot with children': '<UI.AppShell sidebar={<UI.Sidebar brand="Acme"><UI.SidebarItem label="Overview" active /><UI.SidebarItem label="Revenue" /></UI.Sidebar>}><p /></UI.AppShell>',
    'text child': '<p>Hello there</p>',
    'multi-line text child': '<p>\n      Wrapped over\n      several lines\n    </p>',
    'literal expression child': `<p>{'literal'}</p>`,
    'unicode and punctuation text': `<p>◆ Don't — “quote” &amp; more</p>`,
    'mixed content': '<p>before <b>bold</b> after</p>',
    'fragment child': '<div><><a /><b /></></div>',
    'array of JSX children': '<div>{[<a key="1" />, <b key="2" />]}</div>',
    'comment child is dropped': '<div>{/* note */}<p /></div>',
    'deep nesting': `${'<div>'.repeat(30)}leaf${'</div>'.repeat(30)}`,
  };

  for (const [label, jsx] of Object.entries(fixtures)) {
    it(label, () => {
      const doc = mustCompile(`function Page() {\n  return (\n    ${jsx}\n  );\n}`, label);
      roundTrip(doc, label);
    });
  }

  it('local const bindings survive as inlined slots', () => {
    const doc = mustCompile(`function Page() {
      const sidebar = (<UI.Sidebar brand="Acme"><UI.SidebarItem label="One" /></UI.Sidebar>);
      const topBar = <UI.TopBar actions={[<UI.Button key="n" label="Go" />]} />;
      return <UI.AppShell sidebar={sidebar} topBar={topBar}><p>body</p></UI.AppShell>;
    }`);
    const back = roundTrip(doc, 'bindings');
    // The binding is gone from the source but the tree is identical.
    expect(emit(back)).not.toContain('const ');
    expect(back.slots?.sidebar?.[0].tag).toBe('UI.Sidebar');
    expect(back.slots?.topBar?.[0].slots?.actions?.[0].tag).toBe('UI.Button');
  });
});

describe('round trip — hand-built documents', () => {
  const n = (x: Partial<DocNode> & { tag: string; mid: string }): DocNode => x as DocNode;

  const docs: Record<string, DocNode> = {
    'leaf with text': n({ mid: 'aaaaaaaaaa', tag: 'p', text: 'hello' }),
    'text needing escape': n({ mid: 'aaaaaaaaaa', tag: 'p', text: '  a & b <c> {d}  ' }),
    'props needing escape': n({
      mid: 'aaaaaaaaaa', tag: 'UI.X',
      props: { quoted: 'say "hi"', amp: 'a & b', nl: 'one\ntwo', apos: "it's", tag: '<script>' },
    }),
    'deep slot chain': n({
      mid: 'aaaaaaaaaa', tag: 'UI.A',
      slots: {
        one: [n({
          mid: 'bbbbbbbbbb', tag: 'UI.B',
          slots: {
            two: [n({
              mid: 'cccccccccc', tag: 'UI.C',
              slots: { three: [n({ mid: 'dddddddddd', tag: 'UI.D', text: 'deep' })] },
            })],
          },
        })],
      },
    }),
    'slot array of many': n({
      mid: 'aaaaaaaaaa', tag: 'UI.TopBar',
      slots: {
        actions: Array.from({ length: 6 }, (_, i) => n({
          mid: `mmmmmmmmm${String.fromCharCode(97 + i)}`,
          tag: 'UI.Button',
          props: { key: String(i), label: `Action ${i}` },
        })),
      },
    }),
    'large data prop': n({
      mid: 'aaaaaaaaaa', tag: 'UI.Chart',
      props: {
        data: Array.from({ length: 24 }, (_, i) => ({ label: `m${i}`, value: i * 7, nested: { ok: i % 2 === 0 } })),
      },
    }),
    'style plus slots plus children': n({
      mid: 'aaaaaaaaaa', tag: 'UI.Card',
      props: { padding: 4 },
      style: { flex: '1', 'max-width': '100%', '--tone': 'var(--accent)' },
      slots: { header: [n({ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Title' })] },
      children: [n({ mid: 'cccccccccc', tag: 'p', text: 'body' })],
    }),
  };

  for (const [label, doc] of Object.entries(docs)) {
    it(label, () => { roundTrip(doc, label); });
  }

  it('a 40-level slot chain still emits parseable JSX', () => {
    // Mids are base32 `[a-z2-7]` — a fixture that ignores that would be
    // re-minted by the compiler and would test nothing.
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    const midFor = (i: number) => (alpha[Math.floor(i / 26) % 26] + alpha[i % 26]).padEnd(10, 'q');
    let doc: DocNode = { mid: 'zzzzzzzzzz', tag: 'UI.Leaf', text: 'end' };
    for (let i = 0; i < 40; i++) {
      doc = { mid: midFor(i), tag: 'UI.Wrap', slots: { inner: [doc] } };
    }
    roundTrip(doc, 'slot chain');
  });

  it('array props of 200 rows survive intact', () => {
    const doc: DocNode = {
      mid: 'aaaaaaaaaa',
      tag: 'UI.Table',
      props: { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row ${i}`, on: i % 3 === 0 })) },
    };
    const back = roundTrip(doc, 'big array');
    expect((back.props?.rows as unknown[]).length).toBe(200);
  });
});

describe('round trip — adversarial content', () => {
  const hostile: Array<[string, DocNode]> = [
    ['text that closes its own tag', { mid: 'aaaaaaaaaa', tag: 'p', text: '</p><script>alert(1)</script>' }],
    ['text that opens a comment', { mid: 'aaaaaaaaaa', tag: 'p', text: '/* */ */ /*' }],
    ['text that looks like an expression', { mid: 'aaaaaaaaaa', tag: 'p', text: '{ ...evil }' }],
    ['prop that closes the tag', { mid: 'aaaaaaaaaa', tag: 'div', props: { title: '"><img onerror=x>' } }],
    ['prop with an entity', { mid: 'aaaaaaaaaa', tag: 'div', props: { title: '&amp;lt;' } }],
    ['prop with a backslash', { mid: 'aaaaaaaaaa', tag: 'div', props: { path: 'C:\\Users\\x' } }],
    ['style value with a quote', { mid: 'aaaaaaaaaa', tag: 'div', style: { content: `"x"` } }],
    ['style value that closes the object', { mid: 'aaaaaaaaaa', tag: 'div', style: { background: `red' }} onload='x` } }],
    ['prop key colliding with mid is dropped', { mid: 'aaaaaaaaaa', tag: 'div', props: { mid: 'bbbbbbbbbb' } }],
    // `__proto__` is a cell DocPatch can legitimately write, and the only key a
    // plain object cannot store by assignment — it must survive the whole loop
    // as data, or a read_page → rewrite would silently erase it.
    ['a cell named __proto__', JSON.parse(
      '{"mid":"aaaaaaaaaa","tag":"UI.X","props":{"__proto__":1,"data":{"__proto__":{"deep":1},"ok":2}},'
      + '"style":{"__proto__":"x","color":"red"}}',
    ) as DocNode],
  ];

  for (const [label, doc] of hostile) {
    it(label, () => {
      const source = emit(doc, { mids: true });
      const back = mustCompile(source, label);
      if (label.includes('__proto__')) {
        // shape() equality alone would pass vacuously if BOTH directions
        // dropped the key, so assert the serialized cells directly.
        expect(JSON.stringify(back.props)).toBe('{"__proto__":1,"data":{"__proto__":{"deep":1},"ok":2}}');
        expect(JSON.stringify(back.style)).toBe('{"__proto__":"x","color":"red"}');
        expect(Object.getPrototypeOf(back.props!)).toBe(Object.prototype);
        expect(source).toContain(`['__proto__']`);
        return;
      }
      if (label.includes('colliding')) {
        // `mid` is identity, never a prop — it can never be smuggled back in.
        expect(back.props?.mid).toBeUndefined();
        expect(back.mid).toBe('aaaaaaaaaa');
        return;
      }
      expect(shape(back)).toEqual(shape(doc));
      expect(back.mid).toBe(doc.mid);
    });
  }

  it('a page from a scaffold survives ten emit/compile cycles unchanged', () => {
    let doc = mustCompile(PAGE_SCAFFOLDS.find(s => s.id === 'landing')!.jsx);
    const first = emit(doc, { mids: true });
    for (let i = 0; i < 10; i++) {
      doc = mustCompile(emit(doc, { mids: true }), `cycle ${i}`);
    }
    expect(emit(doc, { mids: true })).toBe(first);
  });
});

/**
 * The fixtures above enumerate constructs one at a time; real pages COMBINE
 * them, and that is where an inverse pair drifts — a style block that pushes an
 * element past the inline budget, text needing escape inside a slot inside an
 * array prop, a prop whose value forces a multi-line literal. A seeded
 * generator covers those combinations without pinning the suite to one shape.
 */
describe('round trip — generated documents', () => {
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz234567';
  const TEXTS = [
    'hello', ' lead ', 'a & b', '<b>x</b>', '{x}', "it's", 'say "hi"', 'ünïcødé ◆',
    'line\nbreak', 'tab\there', 'a'.repeat(120), '</p>', 'back\\slash', '&amp;',
    'ends with space ', ' starts', 'a  b   c', '',
  ];
  const STYLE_KEYS = ['align-items', 'font-size', 'flex', 'margin', '--brand', 'z-index', 'line-height', 'grid-column'];
  const STYLE_VALUES = ['center', '13px', "quote'd", '"dq"', "red' }} onload='x", '0', 'var(--a)', '100%'];
  const PROP_KEYS = ['label', 'variant', 'data-x', 'aria-label', 'xlinkHref', 'key', 'items', 'data', 'muted'];
  const TAGS = ['div', 'p', 'span', 'h1', 'img', 'UI.Card', 'UI.Button', 'UI.Row', 'UI.ListRow'];
  const SLOT_NAMES = ['leading', 'trailing', 'actions', 'topBar'];
  const SCALARS: JsonValue[] = ['s', 'a & b', "q'", 12, -4, 2.5, 0, true, false, null, '', 'x\ny'];

  function generator(seedValue: number) {
    let seed = seedValue >>> 0;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    let n = 0;
    // Mids must be real base32 ids: a fixture the compiler re-mints tests nothing.
    const mid = () => {
      let v = ++n;
      let s = '';
      while (v > 0) { s = ALPHA[v % 32] + s; v = Math.floor(v / 32); }
      return s.padStart(10, 'a');
    };

    const data = (depth: number): JsonValue => {
      const k = Math.floor(rnd() * 7);
      if (depth > 2 || k < 3) { return pick(SCALARS); }
      if (k < 5) { return Array.from({ length: Math.floor(rnd() * 4) }, () => data(depth + 1)); }
      const o: Record<string, JsonValue> = {};
      for (let i = 0; i <= Math.floor(rnd() * 2); i++) { o[pick(['a', 'b', 'x-y', 'label', '2n'])] = data(depth + 1); }
      return o;
    };

    const build = (depth: number): DocNode => {
      const node: DocNode = { mid: mid(), tag: pick(TAGS) };
      const props: Record<string, JsonValue> = {};
      for (let i = 0; i < Math.floor(rnd() * 3); i++) { props[pick(PROP_KEYS)] = data(0); }
      if (Object.keys(props).length) { node.props = props; }

      const style: Record<string, string> = {};
      for (let i = 0; i < Math.floor(rnd() * 4); i++) { style[pick(STYLE_KEYS)] = pick(STYLE_VALUES); }
      if (Object.keys(style).length) { node.style = style; }

      if (depth < 3 && rnd() < 0.4) {
        const slots: Record<string, DocNode[]> = {};
        for (let i = 0; i <= Math.floor(rnd() * 1.9); i++) {
          slots[pick(SLOT_NAMES)] = Array.from({ length: Math.floor(rnd() * 3) + 1 }, () => build(depth + 1));
        }
        node.slots = slots;
      }
      if (depth < 3 && rnd() < 0.5) {
        node.children = Array.from({ length: Math.floor(rnd() * 3) + 1 }, () => build(depth + 1));
      } else if (rnd() < 0.6) {
        const t = pick(TEXTS);
        if (t) { node.text = t; }
      }
      return node;
    };
    return build;
  }

  it('250 generated documents survive emit → compile with identity intact', () => {
    const build = generator(0x5eed);
    for (let i = 0; i < 250; i++) { roundTrip(build(0), `generated#${i}`); }
  }, 30_000);
  it('a different seed covers a different shape space', () => {
    const build = generator(0xc0ffee);
    for (let i = 0; i < 250; i++) { roundTrip(build(0), `generated2#${i}`); }
  }, 30_000);
});
