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
 * Plan 22 §3.1 — the JSX subset, verified rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanJsxText,
  compile,
  compilePartial,
  normalizeStyleKey,
  repairPrefix,
  styleNumber,
  withFreshMids,
} from '../../../src/canvas/doc/PageCompiler';
import { collectMids, isMid, walk, type DocNode } from '../../../src/canvas/doc/DocNode';
import { PAGE_SCAFFOLDS } from '../../../src/managers/CanvasScaffolds';

function ok(source: string): DocNode {
  const r = compile(source);
  if (!r.ok) { throw new Error(`expected compile to succeed, got: ${r.error}`); }
  return r.doc;
}

function fails(source: string): string {
  const r = compile(source);
  if (r.ok) { throw new Error('expected compile to fail'); }
  return r.error;
}

/** Wrap a JSX body in the canonical page shell. */
const page = (jsx: string) => `function Page() {\n  return (\n${jsx}\n  );\n}`;

describe('PageCompiler — the five shipped scaffolds', () => {
  for (const scaffold of PAGE_SCAFFOLDS) {
    it(`compiles "${scaffold.id}" with zero authoring changes`, () => {
      const r = compile(scaffold.jsx);
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
    });
  }

  it('mints a unique, well-formed mid for every node of every scaffold', () => {
    for (const scaffold of PAGE_SCAFFOLDS) {
      const doc = ok(scaffold.jsx);
      const nodes = [...walk(doc)];
      expect(nodes.length).toBeGreaterThan(3);
      for (const n of nodes) { expect(isMid(n.mid), `${scaffold.id}/${n.tag}`).toBe(true); }
      expect(collectMids(doc).size).toBe(nodes.length);
    }
  });

  it('DASHBOARD: local const JSX bindings are inlined at their use site', () => {
    const doc = ok(PAGE_SCAFFOLDS.find(s => s.id === 'dashboard')!.jsx);
    expect(doc.tag).toBe('UI.AppShell');
    // `const sidebar = (<UI.Sidebar…>)` referenced as sidebar={sidebar}
    expect(doc.slots?.sidebar?.[0].tag).toBe('UI.Sidebar');
    expect(doc.slots?.sidebar?.[0].children?.map(c => c.props?.label))
      .toEqual(['Overview', 'Customers', 'Revenue', 'Reports', 'Settings']);
    expect(doc.slots?.sidebar?.[0].children?.[0].props?.active).toBe(true);
    // `const topBar = <UI.TopBar actions={[<UI.Button/>, <UI.Avatar/>]}/>`
    const topBar = doc.slots?.topBar?.[0];
    expect(topBar?.tag).toBe('UI.TopBar');
    expect(topBar?.slots?.actions?.map(n => n.tag)).toEqual(['UI.Button', 'UI.Avatar']);
    expect(topBar?.slots?.actions?.[0].props?.key).toBe('n');
    // No binding leaks into props.
    expect(doc.props?.sidebar).toBeUndefined();
  });

  it('DASHBOARD: object-array data props fold to JSON', () => {
    const doc = ok(PAGE_SCAFFOLDS.find(s => s.id === 'dashboard')!.jsx);
    const chart = [...walk(doc)].find(n => n.tag === 'UI.Chart');
    expect(chart?.props?.data).toEqual([
      { label: 'Jan', value: 22 }, { label: 'Feb', value: 30 }, { label: 'Mar', value: 28 },
      { label: 'Apr', value: 41 }, { label: 'May', value: 38 }, { label: 'Jun', value: 48 },
    ]);
  });

  it('MOBILE_HOME: JSX-in-prop becomes a slot, object arrays stay props', () => {
    const doc = ok(PAGE_SCAFFOLDS.find(s => s.id === 'mobile-home')!.jsx);
    const rows = [...walk(doc)].filter(n => n.tag === 'UI.ListRow');
    expect(rows).toHaveLength(3);
    expect(rows[0].slots?.leading?.[0].tag).toBe('UI.Avatar');
    expect(rows[0].slots?.leading?.[0].props?.initials).toBe('SP');
    expect(rows[0].slots?.trailing?.[0].text).toBe('-$9.99');
    expect(rows[1].slots?.trailing?.[0].tag).toBe('UI.Badge');

    const tabBar = [...walk(doc)].find(n => n.tag === 'UI.TabBar');
    expect(tabBar?.props?.items).toEqual([
      { label: 'Home', icon: '⌂', active: true },
      { label: 'Cards', icon: '▭' },
      { label: 'Activity', icon: '☰' },
      { label: 'Profile', icon: '◔' },
    ]);
    expect(tabBar?.slots).toBeUndefined();
  });

  it('LOGIN: style objects, numeric props and trimmed multi-line text', () => {
    const doc = ok(PAGE_SCAFFOLDS.find(s => s.id === 'login')!.jsx);
    expect(doc.style).toEqual({ 'align-items': 'center', 'justify-content': 'center', padding: '24px' });
    const card = doc.children?.[0];
    expect(card?.style).toEqual({ width: '360px', 'max-width': '100%' });
    expect(card?.children?.[0].props?.gap).toBe(16);
    const tail = [...walk(doc)].filter(n => n.tag === 'UI.Text').pop();
    expect(tail?.text).toBe("Don't have an account? Sign up");
  });
});

describe('PageCompiler — page shells', () => {
  it('accepts `function Page()`', () => {
    expect(ok('function Page() { return <div/>; }').tag).toBe('div');
  });

  it('accepts an arrow component', () => {
    expect(ok('const Page = () => (<section/>);').tag).toBe('section');
  });

  it('accepts an arrow component with a block body', () => {
    expect(ok('const Page = () => { return <main/>; };').tag).toBe('main');
  });

  it('accepts a default-exported component', () => {
    expect(ok('export default function Page() { return <article/>; }').tag).toBe('article');
  });

  it('accepts a single unnamed component', () => {
    expect(ok('function Whatever() { return <aside/>; }').tag).toBe('aside');
  });

  it('accepts a bare JSX expression', () => {
    expect(ok('<div id="bare" />').props?.id).toBe('bare');
  });

  it('ignores imports ahead of the component', () => {
    expect(ok('import React from "react";\nfunction Page(){ return <div/>; }').tag).toBe('div');
  });

  it('rejects an empty source', () => {
    expect(compile('')).toEqual({ ok: false, error: 'empty page source' });
    expect(compile('   \n ')).toEqual({ ok: false, error: 'empty page source' });
  });

  it('rejects two components in one source', () => {
    expect(fails('function A(){ return <div/>; }\nfunction B(){ return <p/>; }'))
      .toMatch(/several components/);
  });

  it('rejects a component with no return', () => {
    expect(fails('function Page() { const a = 1; }')).toMatch(/no `return`/);
  });

  it('rejects a fragment root', () => {
    expect(fails('function Page(){ return <><div/><p/></>; }')).toMatch(/single root element/);
  });

  it('rejects a non-JSX return', () => {
    expect(fails('function Page(){ return "hi"; }')).toMatch(/must return a JSX element/);
  });
});

describe('PageCompiler — props', () => {
  it('folds every literal shape', () => {
    const doc = ok(page(`<UI.X s="str" n={12} neg={-4.5} t b={false} nul={null} tpl={\`raw\`} />`));
    expect(doc.props).toEqual({ s: 'str', n: 12, neg: -4.5, t: true, b: false, nul: null, tpl: 'raw' });
  });

  it('folds nested object and array literals', () => {
    const doc = ok(page(`<UI.X data={{ a: [1, 'two', { b: null }], 'quoted-key': true }} />`));
    expect(doc.props?.data).toEqual({ a: [1, 'two', { b: null }], 'quoted-key': true });
  });

  it('reads an empty array as data, not as an empty slot', () => {
    const doc = ok(page('<UI.X items={[]} />'));
    expect(doc.props?.items).toEqual([]);
    expect(doc.slots).toBeUndefined();
  });

  it('keeps namespaced prop names', () => {
    const doc = ok(page('<svg><use xlinkHref="#a" data-testid="t" aria-label="l" /></svg>'));
    expect(doc.children?.[0].props).toEqual({ xlinkHref: '#a', 'data-testid': 't', 'aria-label': 'l' });
  });

  it('decodes entities in string attributes exactly as JSX does', () => {
    const doc = ok(page('<UI.X label="a &amp; b" />'));
    expect(doc.props?.label).toBe('a & b');
  });

  it('lets a later duplicate attribute win, as JSX does', () => {
    const doc = ok(page('<UI.X label="first" label="second" />'));
    expect(doc.props?.label).toBe('second');
  });

  it('a JSX-valued prop that is later overwritten by a literal leaves no slot', () => {
    const doc = ok(page('<UI.X slot={<div/>} slot="plain" />'));
    expect(doc.props?.slot).toBe('plain');
    expect(doc.slots?.slot).toBeUndefined();
  });

  it('rejects prop spread', () => {
    expect(fails(page('<UI.X {...rest} />'))).toMatch(/spread/);
  });

  it('rejects a call expression in a prop', () => {
    expect(fails(page('<UI.X onClick={doThing()} />'))).toMatch(/CallExpression/);
  });

  it('rejects an arrow function prop', () => {
    expect(fails(page('<UI.X onClick={() => 1} />'))).toMatch(/ArrowFunctionExpression/);
  });

  it('rejects a ternary', () => {
    expect(fails(page('<UI.X label={a ? "y" : "n"} />'))).toMatch(/ConditionalExpression/);
  });

  it('rejects template interpolation', () => {
    expect(fails(page('<UI.X label={`a${b}c`} />'))).toMatch(/interpolation/);
  });

  it('rejects an undefined identifier', () => {
    expect(fails(page('<UI.X label={missing} />'))).toMatch(/`missing` is not defined/);
  });

  it('rejects an array prop mixing JSX and data', () => {
    expect(fails(page('<UI.X items={[<div/>, 3]} />'))).toMatch(/all JSX or all literal/);
  });

  it('rejects an empty expression prop', () => {
    expect(fails(page('<UI.X label={} />'))).toMatch(/non-empty expression|empty value/);
  });

  it('reports the line of the offending construct', () => {
    expect(fails('function Page() {\n  return (\n    <div>{items.map(x => x)}</div>\n  );\n}'))
      .toMatch(/line 3/);
  });
});

describe('PageCompiler — style', () => {
  it('kebab-cases keys and applies React unit rules', () => {
    const doc = ok(page(`<div style={{ alignItems: 'center', fontSize: 13, flex: 2, zIndex: 4, margin: 0, width: '100%' }} />`));
    expect(doc.style).toEqual({
      'align-items': 'center', 'font-size': '13px', flex: '2', 'z-index': '4', margin: '0', width: '100%',
    });
  });

  it('keeps custom properties and already-kebab keys verbatim', () => {
    const doc = ok(page(`<div style={{ '--brand': '#0f0', 'align-items': 'end' }} />`));
    expect(doc.style).toEqual({ '--brand': '#0f0', 'align-items': 'end' });
  });

  it('turns a leading capital into a vendor dash', () => {
    expect(normalizeStyleKey('WebkitFilter')).toBe('-webkit-filter');
    expect(normalizeStyleKey('--x')).toBe('--x');
    expect(normalizeStyleKey('align-items')).toBe('align-items');
  });

  it('drops a null style value rather than writing "null"', () => {
    const doc = ok(page(`<div style={{ color: null, background: 'red' }} />`));
    expect(doc.style).toEqual({ background: 'red' });
  });

  it('resolves a style object bound to a local const', () => {
    const doc = ok('function Page(){ const s = { padding: 8 }; return <div style={s}/>; }');
    expect(doc.style).toEqual({ padding: '8px' });
  });

  it('rejects a string style attribute', () => {
    expect(fails(page('<div style="color:red" />'))).toMatch(/object expression/);
  });

  it('rejects a computed style key', () => {
    expect(fails(page('<div style={{ [k]: 1 }} />'))).toMatch(/computed style keys/);
  });

  it('rejects a spread inside style', () => {
    expect(fails(page('<div style={{ ...base, color: "red" }} />'))).toMatch(/spread/);
  });

  it('rejects a non-scalar style value', () => {
    expect(fails(page('<div style={{ color: {} }} />'))).toMatch(/style values must be/);
  });

  it('styleNumber matches React: 0 and unitless props stay bare', () => {
    expect(styleNumber('padding', 12)).toBe('12px');
    expect(styleNumber('padding', 0)).toBe('0');
    expect(styleNumber('line-height', 1.5)).toBe('1.5');
    expect(styleNumber('--gap', 3)).toBe('3');
  });
});

describe('PageCompiler — children', () => {
  it('collapses multi-line text the way JSX does', () => {
    const doc = ok(page('    <p>\n      Hello\n      there\n    </p>'));
    expect(doc.text).toBe('Hello there');
  });

  it('keeps interior spacing on a single-line run', () => {
    expect(cleanJsxText('a  b')).toBe('a  b');
    expect(cleanJsxText('\n   only\n   ')).toBe('only');
    expect(cleanJsxText('\n   \n  ')).toBe('');
  });

  it('reads literal expression children as text', () => {
    expect(ok(page(`<p>{'literal'}</p>`)).text).toBe('literal');
    expect(ok(page('<p>{42}</p>')).text).toBe('42');
    expect(ok(page('<p>{`tpl`}</p>')).text).toBe('tpl');
  });

  it('joins adjacent text runs', () => {
    expect(ok(page(`<p>hello {'brave'} world</p>`)).text).toBe('hello brave world');
  });

  it('renders nothing for {null}, {false} and comments', () => {
    const doc = ok(page('<p>{null}{false}{/* note */}</p>'));
    expect(doc.text).toBeUndefined();
    expect(doc.children).toBeUndefined();
  });

  it('wraps bare text runs in spans when content is mixed, preserving order', () => {
    const doc = ok(page('<p>before <b>bold</b> after</p>'));
    expect(doc.text).toBeUndefined();
    expect(doc.children?.map(c => [c.tag, c.text])).toEqual([
      ['span', 'before '], ['b', 'bold'], ['span', ' after'],
    ]);
  });

  it('flattens a fragment child into its parent', () => {
    const doc = ok(page('<div><><a/><b/></></div>'));
    expect(doc.children?.map(c => c.tag)).toEqual(['a', 'b']);
  });

  it('accepts an array of JSX as children', () => {
    const doc = ok('function Page(){ const items = [<a key="1"/>, <b key="2"/>]; return <div>{items}</div>; }');
    expect(doc.children?.map(c => c.tag)).toEqual(['a', 'b']);
  });

  it('rejects .map over children', () => {
    expect(fails(page('<div>{rows.map(r => <p/>)}</div>'))).toMatch(/CallExpression|only arrays of JSX/);
  });

  it('rejects spread children', () => {
    expect(fails(page('<div>{...kids}</div>'))).toMatch(/spread/i);
  });
});

describe('PageCompiler — local bindings', () => {
  it('re-evaluates a binding at each use site so mids stay distinct', () => {
    const doc = ok('function Page(){ const chip = <UI.Badge label="x"/>; return <div a={chip} b={chip}/>; }');
    const a = doc.slots?.a?.[0];
    const b = doc.slots?.b?.[0];
    expect(a?.tag).toBe('UI.Badge');
    expect(b?.tag).toBe('UI.Badge');
    expect(a?.mid).not.toBe(b?.mid);
  });

  it('follows a chain of bindings', () => {
    const doc = ok('function Page(){ const a = <p/>; const b = a; return <div x={b}/>; }');
    expect(doc.slots?.x?.[0].tag).toBe('p');
  });

  it('rejects a self-referential binding instead of hanging', () => {
    expect(fails('function Page(){ const a = b; const b = a; return <div x={a}/>; }'))
      .toMatch(/refers to itself/);
  });

  it('rejects destructuring bindings', () => {
    expect(fails('function Page(){ const [s, set] = useState(0); return <div/>; }'))
      .toMatch(/destructuring/);
  });

  it('rejects statements that are not declarations or the return', () => {
    expect(fails('function Page(){ if (x) { return <div/>; } return <p/>; }'))
      .toMatch(/IfStatement/);
    expect(fails('function Page(){ useEffect(); return <p/>; }'))
      .toMatch(/ExpressionStatement/);
  });
});

describe('PageCompiler — mids as hints, never authority', () => {
  it('echoes back a well-formed mid', () => {
    const doc = ok(page('<div mid="k7f2xq3b4m"><p mid="abcdefgh23"/></div>'));
    expect(doc.mid).toBe('k7f2xq3b4m');
    expect(doc.children?.[0].mid).toBe('abcdefgh23');
  });

  it('discards and re-mints a malformed mid', () => {
    const doc = ok(page('<div mid="not-a-mid"/>'));
    expect(doc.mid).not.toBe('not-a-mid');
    expect(isMid(doc.mid)).toBe(true);
    expect(doc.props?.mid).toBeUndefined();
  });

  it('re-mints a duplicated mid so identity stays unique', () => {
    const doc = ok(page('<div mid="k7f2xq3b4m"><p mid="k7f2xq3b4m"/></div>'));
    expect(doc.mid).toBe('k7f2xq3b4m');
    expect(doc.children?.[0].mid).not.toBe('k7f2xq3b4m');
    expect(collectMids(doc).size).toBe(2);
  });

  it('discards a non-literal mid', () => {
    const doc = ok(page('<div mid={someVar}/>'));
    expect(isMid(doc.mid)).toBe(true);
  });

  it('never deadlocks on a degenerate RNG', () => {
    const r = compile(page('<div><p/><p/><p/></div>'), { rand: () => 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    expect(collectMids(r.doc).size).toBe(4);
    for (const n of walk(r.doc)) { expect(isMid(n.mid)).toBe(true); }
  });

  it('withFreshMids replaces every id including those in slots', () => {
    const doc = ok(page('<div a={<p><b/></p>}><i/></div>'));
    const before = collectMids(doc);
    const after = collectMids(withFreshMids(doc));
    expect(after.size).toBe(before.size);
    for (const m of after) { expect(before.has(m)).toBe(false); }
  });
});

describe('PageCompiler — `__proto__` is data, never a prototype', () => {
  // `record['__proto__'] = v` runs Object.prototype's accessor and REPLACES the
  // record's prototype instead of storing anything, so the key would vanish
  // from Object.keys and JSON while `for…in` and lookups still saw the value.
  // `DocPatch.applyOp` treats such a cell as ordinary data and requires it to
  // survive inversion, so it is stored as a real own property here rather than
  // dropped — dropping would erase, on the next read_page → rewrite, a cell the
  // op layer had just committed.
  const ownData = (o: object, key: string) =>
    Object.prototype.hasOwnProperty.call(o, key) && Object.getPrototypeOf(o) === Object.prototype;

  it('stores a nested `__proto__` key as an own property', () => {
    const doc = ok(page(`<UI.X data={{ "__proto__": { polluted: 1 }, ok: 2 }} />`));
    const data = doc.props?.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['__proto__', 'ok']);
    expect(ownData(data, '__proto__')).toBe(true);
    // Note the assertion cannot be written as an object literal: `{ __proto__: … }`
    // in test source is the very directive this guards against, and would build
    // an expectation of `{ ok: 2 }`.
    expect(JSON.stringify(data)).toBe('{"__proto__":{"polluted":1},"ok":2}');
    expect((data as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('stores a `__proto__` prop as an own property', () => {
    const doc = ok(page('<UI.X __proto__={{ polluted: 1 }} label="a" />'));
    expect(Object.keys(doc.props ?? {})).toEqual(['__proto__', 'label']);
    expect(ownData(doc.props ?? {}, '__proto__')).toBe(true);
    expect((doc.props as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('stores a `__proto__` style key as an own property', () => {
    const doc = ok(page(`<div style={{ '__proto__': 'x', color: 'red' }} />`));
    expect(Object.keys(doc.style ?? {})).toEqual(['__proto__', 'color']);
    expect(ownData(doc.style ?? {}, '__proto__')).toBe(true);
  });

  it('reads back the computed form the emitter writes', () => {
    const doc = ok(page(`<UI.X d={{ ['__proto__']: 1, ok: 2 }} style={{ ['__proto__']: 'x' }} />`));
    expect(Object.keys(doc.props?.d as object)).toEqual(['__proto__', 'ok']);
    expect(ownData(doc.props?.d as object, '__proto__')).toBe(true);
    expect(Object.keys(doc.style ?? {})).toEqual(['__proto__']);
  });

  it('still rejects a genuinely computed key — only a string literal is data', () => {
    expect(fails(page('<UI.X d={{ [key]: 1 }} />'))).toMatch(/computed keys/);
    expect(fails(page('<div style={{ [k]: 1 }} />'))).toMatch(/computed style keys/);
  });

  it('stores a `__proto__` slot as an own property', () => {
    const doc = ok(page('<UI.X __proto__={<p>hi</p>} />'));
    expect(Object.keys(doc.slots ?? {})).toEqual(['__proto__']);
    expect(ownData(doc.slots ?? {}, '__proto__')).toBe(true);
    expect(doc.slots?.__proto__?.[0].text).toBe('hi');
  });

  it('leaves the real Object.prototype untouched', () => {
    ok(page(`<UI.X data={{ "__proto__": { polluted: 1 } }} __proto__={{ polluted: 2 }} />`));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('PageCompiler — failure is total, never partial', () => {
  it('returns no doc at all when one node is outside the subset', () => {
    const r = compile(page('<div><p>ok</p><span>{rows.map(r => <i/>)}</span></div>'));
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('doc');
  });

  it('surfaces a syntax error as a message rather than throwing', () => {
    expect(() => compile('function Page(){ return (<div>; }')).not.toThrow();
    expect(compile('function Page(){ return (<div>; }').ok).toBe(false);
  });

  it('refuses a tree deeper than the nesting cap', () => {
    const deep = `${'<div>'.repeat(260)}x${'</div>'.repeat(260)}`;
    expect(fails(page(deep))).toMatch(/nests deeper/);
  });
});

describe('PageCompiler — compilePartial', () => {
  const hasRoot = (source: string) => /return\s*\(?\s*<[A-Za-z][^<]*>/.test(source);
  beforeEach(() => {
    // Keep the compiler's repair deadline stable while checking correctness.
    // Worker scheduling should not decide which source prefixes are repairable.
    vi.spyOn(Date, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is identical to compile on a complete source', () => {
    const full = PAGE_SCAFFOLDS[0].jsx;
    const a = compilePartial(full);
    expect(a.ok).toBe(true);
    if (a.ok) { expect(a.doc.tag).toBe('UI.Screen'); }
  });

  it('returns the best doc so far for every prefix of every scaffold', () => {
    // A root exists only once `return (` is followed by a complete opening tag —
    // before that there is genuinely nothing to render, and saying so beats
    // guessing a provisional root that would jump when the real one arrives.
    for (const scaffold of PAGE_SCAFFOLDS) {
      for (let pct = 5; pct <= 100; pct += 5) {
        const cut = scaffold.jsx.slice(0, Math.floor(scaffold.jsx.length * pct / 100));
        const r = compilePartial(cut);
        expect(r.ok, `${scaffold.id}@${pct}%: ${r.ok ? '' : r.error}`).toBe(hasRoot(cut));
      }
    }
  });

  it('has no root to show while a page is still declaring local bindings', () => {
    const dashboard = PAGE_SCAFFOLDS.find(s => s.id === 'dashboard')!.jsx;
    const beforeReturn = dashboard.slice(0, dashboard.indexOf('return ('));
    const r = compilePartial(beforeReturn);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toMatch(/no `return`/); }
  });

  it('grows monotonically as the source streams in', () => {
    const full = PAGE_SCAFFOLDS.find(s => s.id === 'settings')!.jsx;
    const counts: number[] = [];
    for (let pct = 30; pct <= 100; pct += 10) {
      const r = compilePartial(full.slice(0, Math.floor(full.length * pct / 100)));
      counts.push(r.ok ? [...walk(r.doc)].length : 0);
    }
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBe([...walk(ok(full))].length);
  });

  it('cuts back past a half-written attribute', () => {
    const r = compilePartial('function Page(){ return (<UI.Screen><UI.Card sty');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.tag).toBe('UI.Screen');
      expect(r.doc.children ?? []).toHaveLength(0);
    }
  });

  it('cuts back past an unterminated string', () => {
    const r = compilePartial('function Page(){ return (<div><p label="half');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.doc.tag).toBe('div'); }
  });

  it('keeps partial text content', () => {
    const r = compilePartial('function Page(){ return (<div><p>half a sen');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.doc.children?.[0].text).toBe('half a sen'); }
  });

  it('closes brackets opened inside JSX children', () => {
    const r = compilePartial('function Page(){ return (<div>{[<a/>');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.doc.children?.map(c => c.tag)).toEqual(['a']); }
  });

  it('drops a trailing unsupported construct instead of failing the whole prefix', () => {
    const r = compilePartial('function Page(){ return (<div><p>fine</p>{rows.map(');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.doc.children?.map(c => c.text)).toEqual(['fine']); }
  });

  it('reports failure when the prefix carries no element yet', () => {
    expect(compilePartial('function Pa').ok).toBe(false);
    expect(compilePartial('').ok).toBe(false);
    expect(compilePartial('   ').ok).toBe(false);
  });

  it.each([
    '<'.repeat(4000),
    '<a>'.repeat(400),
    '{'.repeat(2000),
    'function Page(){ return (<div title="a > b"><p>x',
    '\u0000\uffff<<//>>{{}}',
    'function Page(){ return (<div>{\'unclosed</div>); }',
    '/* unterminated comment <div>',
    '"unterminated string <div>',
  ])('never throws on adversarial input %#', (input) => {
    expect(() => compilePartial(input)).not.toThrow();
  });

  it('stops after 32 repair attempts even when the clock does not advance', () => {
    const source = `function Page(){ return (<div>{unsupported}${'<p/>'.repeat(100)}`;
    const result = compilePartial(source);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toMatch(/no compilable prefix/); }
    // One deadline read plus one per attempt: malformed output cannot cause
    // unlimited reparsing just by supplying more tag boundaries.
    expect(Date.now).toHaveBeenCalledTimes(33);
  });

  it('stops repairing when the 200 ms deadline has elapsed', () => {
    const source = 'function Page(){ return (<div><p>partial';
    expect(compilePartial(source).ok).toBe(true);

    vi.mocked(Date.now).mockReset().mockReturnValueOnce(0).mockReturnValue(201);
    const result = compilePartial(source);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toMatch(/no compilable prefix/); }
    expect(Date.now).toHaveBeenCalledTimes(2);
  });

  const prefixWindowSize = 250;
  const prefixWindows = PAGE_SCAFFOLDS.flatMap(scaffold => Array.from(
    { length: Math.ceil(scaffold.jsx.length / prefixWindowSize) },
    (_, window) => ({
      id: scaffold.id,
      src: scaffold.jsx,
      start: window * prefixWindowSize + 1,
      end: Math.min((window + 1) * prefixWindowSize, scaffold.jsx.length),
    }),
  ));

  it.each(prefixWindows)('handles every source prefix of $id from $start through $end', ({ id, src, start, end }) => {
    // A stream cuts wherever the token boundary falls: mid-entity, mid-attribute
    // name, between a `<` and its tag, inside `{{`. Sampling at 5% steps walks
    // past exactly the offsets where prefix repair is hardest. Bound each test's
    // work while retaining every offset and the transition between windows.
    const shrinks: string[] = [];
    const badMids: string[] = [];
    const previousPrefix = src.slice(0, start - 1);
    const previous = compilePartial(previousPrefix);
    expect(previous.ok, `${id}@${start - 1}: ${previous.ok ? '' : previous.error}`).toBe(hasRoot(previousPrefix));
    let prev = previous.ok ? [...walk(previous.doc)].length : 0;
    for (let i = start; i <= end; i++) {
      const prefix = src.slice(0, i);
      const r = compilePartial(prefix);
      expect(r.ok, `${id}@${i}: ${r.ok ? '' : r.error}`).toBe(hasRoot(prefix));
      if (!r.ok) { continue; }
      const nodes = [...walk(r.doc)];
      // A partial may only ever gain nodes as more source arrives; a shrink
      // means repair invented a tree the next chunk contradicts, which is
      // what makes a streaming preview flicker.
      if (nodes.length < prev) { shrinks.push(`${id}@${i}: ${prev} → ${nodes.length}`); }
      prev = nodes.length;
      for (const n of nodes) { if (!isMid(n.mid)) { badMids.push(`${id}@${i}: ${n.mid}`); } }
    }
    // The last prefix is the whole page, so the sweep must land on it exactly.
    if (end === src.length) { expect(prev, id).toBe([...walk(ok(src))].length); }
    expect(shrinks.slice(0, 5)).toEqual([]);
    expect(badMids.slice(0, 5)).toEqual([]);
  });

  it('repairPrefix refuses to invent content it cannot close honestly', () => {
    expect(repairPrefix('<div><p sty')).toBeNull();       // mid-tag
    expect(repairPrefix('const a = "unter')).toBeNull();  // mid-string in JS context
    // A quote inside JSX TEXT is literal content, not a string — closable.
    expect(repairPrefix('<div>"quoted')).toBe('<div>"quoted</div>');
    expect(repairPrefix('const a = /* open')).toBeNull(); // mid-comment
    expect(repairPrefix('function Page(){ return (<div>')).toBe('function Page(){ return (<div></div>)}');
  });
});
