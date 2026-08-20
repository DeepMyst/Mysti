/**
 * `resources/canvas-sandbox/harness.js` — the Plan 22 Phase 2 DOC INTERPRETER.
 *
 * The harness is plain browser JS that runs inside a `sandbox="allow-scripts"`
 * iframe, so it is exercised here in a `node:vm` context against a minimal fake
 * DOM + fake React. That is deliberate rather than a shortcut: the assertions
 * that matter are about the ELEMENT TREE the interpreter produces and about the
 * port protocol, and both are observable without a real renderer. A real DOM
 * would let a React implementation detail decide whether a security test
 * passes.
 *
 * Covered, in order of how much damage the failure would do:
 *  - port binding is unstealable (self-posted handshake, wrong source, rebind);
 *  - `patch` never remounts (the single reason the port exists);
 *  - the interpreter's allowlists (tags, props, URLs, styles);
 *  - op application, including misses reported instead of guessed;
 *  - geometry / hit / inline-edit round trips;
 *  - the caps that keep a hostile doc from hanging the frame.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const HARNESS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../resources/canvas-sandbox/harness.js'),
  'utf8',
);

/* ─────────────────────────── minimal fake DOM ─────────────────────────── */

interface Rect { left: number; top: number; width: number; height: number }

class FakeEl {
  tagName: string;
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  textContent = '';
  id = '';
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  scrollHeight = 0;
  focused = false;

  constructor(tagName: string) { this.tagName = tagName; }

  setAttribute(k: string, v: unknown): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.has(k) ? this.attrs.get(k)! : null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  focus(): void { this.focused = true; }

  appendChild(child: FakeEl): FakeEl {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  get firstElementChild(): FakeEl | null { return this.children[0] ?? null; }

  contains(node: unknown): boolean {
    let n = node as FakeEl | null;
    while (n) { if (n === this) { return true; } n = n.parentElement; }
    return false;
  }

  getBoundingClientRect(): Rect { return this.rect; }

  private _all(out: FakeEl[]): FakeEl[] {
    for (const c of this.children) { out.push(c); c._all(out); }
    return out;
  }

  querySelectorAll(sel: string): FakeEl[] {
    const all = this._all([]);
    if (sel === '[data-mid]') { return all.filter(e => e.hasAttribute('data-mid')); }
    return [];
  }

  querySelector(sel: string): FakeEl | null {
    const m = /^\[data-mid="([^"]*)"\]$/.exec(sel);
    if (!m) { return null; }
    return this._all([]).find(e => e.getAttribute('data-mid') === m[1]) ?? null;
  }
}

interface HarnessHandles {
  window: Record<string, unknown>;
  document: Record<string, unknown>;
  root: FakeEl;
  /** Messages the harness posted UP the port. */
  up: Record<string, unknown>[];
  /** Messages the harness posted on the legacy window channel. */
  parentMsgs: Record<string, unknown>[];
  /** React trees handed to `root.render()`, in order. */
  renders: unknown[];
  rootCount: () => number;
  /** Hand the harness a port, as the real parent would. */
  bindPort: (opts?: { fromSelf?: boolean; source?: string; noPort?: boolean }) => void;
  /** Send a message DOWN the port. */
  send: (msg: unknown) => void;
  /** Run queued rAF callbacks. */
  flush: () => void;
  /** Dispatch a captured document listener. */
  fire: (type: string, ev: Record<string, unknown>) => void;
  byMid: (mid: string) => Record<string, unknown> | null;
  UI: Record<string, unknown>;
}

interface LoadOptions {
  mode?: 'doc' | 'jsx' | 'html';
  bootstrap?: unknown;
  /** Legacy `function Page()` source, for `mode: 'jsx'`. */
  jsxSource?: string;
  /** Pre-seed the DOM under the page root (React is faked, so nothing renders). */
  seed?: (root: FakeEl) => void;
}

function makeReact() {
  function Component(this: unknown) { /* base class stand-in */ }
  const React = {
    Component,
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      const p: Record<string, unknown> = { ...(props ?? {}) };
      if (children.length === 1) { p.children = children[0]; }
      else if (children.length > 1) { p.children = children; }
      return { type, props: p };
    },
  };
  return React;
}

function makeUI(): Record<string, unknown> {
  const names = [
    'Screen', 'Stack', 'Row', 'AppShell', 'Sidebar', 'SidebarItem', 'TopBar', 'StatusBar',
    'TabBar', 'Card', 'Section', 'Hero', 'Button', 'Field', 'Badge', 'Avatar', 'ListRow',
    'StatCard', 'EmptyState', 'Chart', 'Heading', 'Text',
  ];
  const UI: Record<string, unknown> = {};
  for (const n of names) { UI[n] = function named() { return null; }; }
  return UI;
}

function loadHarness(opts: LoadOptions = {}): HarnessHandles {
  const mode = opts.mode ?? 'doc';
  const root = new FakeEl('div');
  root.id = '__mysti_page';
  root.rect = { left: 10, top: 20, width: 390, height: 844 };
  root.scrollHeight = 900;
  if (opts.seed) { opts.seed(root); }

  const docEl = new FakeEl('html');
  docEl.setAttribute('data-mode', mode);
  const head = new FakeEl('head');

  const byId = new Map<string, FakeEl>();
  byId.set('__mysti_page', root);
  if (opts.bootstrap !== undefined) {
    const bootEl = new FakeEl('script');
    bootEl.textContent = typeof opts.bootstrap === 'string' ? opts.bootstrap : JSON.stringify(opts.bootstrap);
    byId.set('__mysti_page_doc', bootEl);
  }
  if (opts.jsxSource !== undefined) {
    const jsxEl = new FakeEl('script');
    jsxEl.textContent = opts.jsxSource;
    byId.set('__mysti_page_jsx', jsxEl);
  }

  const docListeners = new Map<string, ((ev: unknown) => void)[]>();
  const winListeners = new Map<string, ((ev: unknown) => void)[]>();
  const rafQueue: (() => void)[] = [];
  const up: Record<string, unknown>[] = [];
  const parentMsgs: Record<string, unknown>[] = [];
  const renders: unknown[] = [];
  let roots = 0;

  const created: FakeEl[] = [];
  const document = {
    readyState: 'complete',
    documentElement: docEl,
    head,
    getElementById(id: string) {
      return byId.get(id) ?? created.find(e => e.id === id) ?? null;
    },
    createElement(tag: string) {
      const el = new FakeEl(tag);
      created.push(el);
      return el;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    createRange() {
      return { selectNodeContents() { /* noop */ } };
    },
  };

  const parentWindow = {
    postMessage(msg: Record<string, unknown>) { parentMsgs.push(msg); },
  };

  const ReactDOM = {
    createRoot() {
      roots++;
      return { render(tree: unknown) { renders.push(tree); } };
    },
  };

  const win: Record<string, unknown> = {
    React: makeReact(),
    ReactDOM,
    UI: makeUI(),
    parent: parentWindow,
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = winListeners.get(type) ?? [];
      list.push(fn);
      winListeners.set(type, list);
    },
    requestAnimationFrame(fn: () => void) { rafQueue.push(fn); return rafQueue.length; },
    setTimeout(fn: () => void) { rafQueue.push(fn); return rafQueue.length; },
    getSelection() { return { removeAllRanges() { /* noop */ }, addRange() { /* noop */ } }; },
  };

  const sandbox: Record<string, unknown> = { window: win, document, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HARNESS_SRC, sandbox, { filename: 'harness.js' });

  const port = {
    onmessage: null as null | ((ev: { data: unknown }) => void),
    start() { /* noop */ },
    postMessage(msg: Record<string, unknown>) { up.push(msg); },
  };

  const handles: HarnessHandles = {
    window: win,
    document: document as unknown as Record<string, unknown>,
    root,
    up,
    parentMsgs,
    renders,
    rootCount: () => roots,
    UI: win.UI as Record<string, unknown>,
    bindPort(o = {}) {
      const listeners = winListeners.get('message') ?? [];
      const ev = {
        data: { source: o.source ?? 'mysti-canvas-host', t: 'port' },
        source: o.fromSelf ? win : parentWindow,
        ports: o.noPort ? [] : [port],
      };
      for (const fn of listeners) { fn(ev); }
    },
    send(msg: unknown) {
      if (port.onmessage) { port.onmessage({ data: msg }); }
    },
    flush() {
      while (rafQueue.length) { const fn = rafQueue.shift()!; fn(); }
    },
    fire(type: string, ev: Record<string, unknown>) {
      for (const fn of docListeners.get(type) ?? []) { fn(ev); }
    },
    byMid(mid: string) { return findByMid(renders[renders.length - 1], mid); },
  };
  return handles;
}

/**
 * Walk the fake React tree for the element carrying `data-mid`.
 *
 * Walks EVERY prop value, not just `children`: slot content is rendered into a
 * named prop, so a children-only walk would report a slotted node as missing.
 */
function findByMid(node: unknown, mid: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') { return null; }
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findByMid(n, mid); if (hit) { return hit; } }
    return null;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props && el.props['data-mid'] === mid) { return node as Record<string, unknown>; }
  if (!el.props) { return null; }
  for (const key of Object.keys(el.props)) {
    if (key === 'style') { continue; }
    const hit = findByMid(el.props[key], mid);
    if (hit) { return hit; }
  }
  return null;
}

/** The element the wrapper wraps (primitives are wrapped in a display:contents div). */
function inner(node: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!node) { return null; }
  const props = node.props as Record<string, unknown> | undefined;
  return (props?.children ?? null) as Record<string, unknown> | null;
}

const MID_A = 'aaaaaaaaaa';
const MID_B = 'bbbbbbbbbb';
const MID_C = 'cccccccccc';

function simpleDoc() {
  return {
    mid: MID_A,
    tag: 'UI.Screen',
    children: [
      { mid: MID_B, tag: 'UI.Heading', text: 'Welcome' },
      { mid: MID_C, tag: 'div', style: { 'background-color': 'red' }, text: 'body' },
    ],
  };
}

/* ─────────────────────────────── tests ─────────────────────────────── */

describe('harness — port handshake', () => {
  let h: HarnessHandles;
  beforeEach(() => { h = loadHarness({ mode: 'doc' }); });

  it('binds a port from the real parent and answers `ready`', () => {
    h.bindPort();
    expect(h.up.find(m => m.t === 'ready')).toEqual({ t: 'ready', protocol: 1 });
  });

  it('IGNORES a handshake posted by the page itself (ev.source === window)', () => {
    h.bindPort({ fromSelf: true });
    expect(h.up).toHaveLength(0);
    // …and the real parent can still bind afterwards.
    h.bindPort();
    expect(h.up.find(m => m.t === 'ready')).toBeTruthy();
  });

  it('ignores a handshake with the wrong source marker', () => {
    h.bindPort({ source: 'not-mysti' });
    expect(h.up).toHaveLength(0);
  });

  it('ignores a handshake that transfers no port', () => {
    h.bindPort({ noPort: true });
    expect(h.up).toHaveLength(0);
  });

  it('binds ONCE — a second handshake cannot rebind the channel', () => {
    h.bindPort();
    const readyCount = () => h.up.filter(m => m.t === 'ready').length;
    expect(readyCount()).toBe(1);
    h.bindPort();
    expect(readyCount()).toBe(1);
  });

  it('announces itself on the legacy window channel so a host knows to hand a port', () => {
    expect(h.parentMsgs.some(m => m.type === 'frame_hello' && m.source === 'mysti-canvas-page')).toBe(true);
  });
});

describe('harness — mount and patch never remount', () => {
  let h: HarnessHandles;
  beforeEach(() => {
    h = loadHarness({ mode: 'doc' });
    h.bindPort();
  });

  it('mount renders the doc and creates exactly one React root', () => {
    h.send({ t: 'mount', doc: simpleDoc() });
    expect(h.renders).toHaveLength(1);
    expect(h.rootCount()).toBe(1);
  });

  it('patch re-renders the EXISTING root — no second createRoot', () => {
    h.send({ t: 'mount', doc: simpleDoc() });
    h.send({ t: 'patch', ops: [{ op: 'el.setText', pageId: 'p', mid: MID_B, text: 'Hello' }] });
    h.send({ t: 'patch', ops: [{ op: 'el.setText', pageId: 'p', mid: MID_B, text: 'Hi' }] });
    expect(h.rootCount()).toBe(1);
    expect(h.renders.length).toBe(3);
    const heading = inner(h.byMid(MID_B));
    expect((heading?.props as Record<string, unknown>).children).toBe('Hi');
  });

  it('a second mount also re-renders the same root (idempotent resync)', () => {
    h.send({ t: 'mount', doc: simpleDoc() });
    h.send({ t: 'mount', doc: simpleDoc() });
    expect(h.rootCount()).toBe(1);
    expect(h.renders).toHaveLength(2);
  });

  it('rejects a mount whose doc is not a node tree, and does not render', () => {
    h.send({ t: 'mount', doc: { nope: true } });
    expect(h.renders).toHaveLength(0);
    expect(h.up.find(m => m.t === 'error')).toBeTruthy();
  });

  it('reports an error for a patch that arrives before any mount', () => {
    h.send({ t: 'patch', ops: [{ op: 'el.setText', pageId: 'p', mid: MID_B, text: 'x' }] });
    expect(h.renders).toHaveLength(0);
    const err = h.up.find(m => m.t === 'error') as Record<string, unknown>;
    expect(String(err.message)).toContain('patch before mount');
  });

  it('renders the bootstrap doc with no host attached (export bundle / PNG capture)', () => {
    const standalone = loadHarness({ mode: 'doc', bootstrap: { doc: simpleDoc() } });
    expect(standalone.renders).toHaveLength(1);
    expect(standalone.rootCount()).toBe(1);
  });

  it('survives a corrupt bootstrap payload instead of throwing', () => {
    const broken = loadHarness({ mode: 'doc', bootstrap: '{not json' });
    expect(broken.renders).toHaveLength(0);
    expect(broken.parentMsgs.some(m => m.type === 'page_render_error')).toBe(true);
  });
});

describe('harness — the interpreter', () => {
  let h: HarnessHandles;
  beforeEach(() => {
    h = loadHarness({ mode: 'doc' });
    h.bindPort();
  });

  it('wraps a UI primitive in a display:contents div carrying the mid', () => {
    h.send({ t: 'mount', doc: simpleDoc() });
    const wrapper = h.byMid(MID_B)!;
    const props = wrapper.props as Record<string, unknown>;
    expect(wrapper.type).toBe('div');
    expect(props.style).toEqual({ display: 'contents' });
    expect(props['data-mid-wrap']).toBe('1');
    expect(inner(wrapper)!.type).toBe(h.UI.Heading);
  });

  it('puts the mid directly on a plain HTML tag (no wrapper)', () => {
    h.send({ t: 'mount', doc: simpleDoc() });
    const el = h.byMid(MID_C)!;
    expect(el.type).toBe('div');
    expect((el.props as Record<string, unknown>)['data-mid-wrap']).toBeUndefined();
  });

  it('kebab style props become camelCase React style keys', () => {
    h.send({ t: 'mount', doc: simpleDoc() });
    const el = h.byMid(MID_C)!;
    expect((el.props as Record<string, unknown>).style).toEqual({ backgroundColor: 'red' });
  });

  it('renders an unknown UI primitive as a visible box, not silence', () => {
    h.send({ t: 'mount', doc: { mid: MID_A, tag: 'UI.Nope' } });
    const el = h.byMid(MID_A)!;
    expect(String((el.props as Record<string, unknown>).children)).toContain('unsupported element');
    expect(h.up.some(m => m.t === 'error' && String(m.message).includes('UI.Nope'))).toBe(true);
  });

  it('refuses a tag outside the HTML allowlist (script/iframe/object)', () => {
    for (const tag of ['script', 'iframe', 'object', 'style', 'link', 'form']) {
      const f = loadHarness({ mode: 'doc' });
      f.bindPort();
      f.send({ t: 'mount', doc: { mid: MID_A, tag } });
      const el = f.byMid(MID_A)!;
      expect(el.type).toBe('div');
      expect(String((el.props as Record<string, unknown>).children)).toContain('unsupported element');
    }
  });

  it('drops event-handler props and dangerouslySetInnerHTML', () => {
    h.send({
      t: 'mount',
      doc: {
        mid: MID_A, tag: 'div',
        props: { onClick: 'boom', onerror: 'boom', dangerouslySetInnerHTML: { __html: '<img>' }, title: 'ok' },
      },
    });
    const props = h.byMid(MID_A)!.props as Record<string, unknown>;
    expect(props.onClick).toBeUndefined();
    expect(props.onerror).toBeUndefined();
    expect(props.dangerouslySetInnerHTML).toBeUndefined();
    expect(props.title).toBe('ok');
  });

  it('drops nested on* keys inside object-valued props', () => {
    h.send({ t: 'mount', doc: { mid: MID_A, tag: 'UI.Chart', props: { data: [{ label: 'a', onLoad: 'x' }] } } });
    const data = (inner(h.byMid(MID_A))!.props as Record<string, unknown>).data as Record<string, unknown>[];
    expect(data[0]).toEqual({ label: 'a' });
  });

  it.each([
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['data:text/html,<script>', false],
    ['vbscript:msgbox', false],
    ['http://insecure.example/x.png', false],
    ['file:///etc/passwd', false],
    ['https://cdn.example/x.png', true],
    ['data:image/png;base64,AAAA', true],
    ['./local.png', true],
    ['vscode-webview://abc/assets/x.png', true],
  ])('URL prop %s → kept=%s', (url, kept) => {
    const f = loadHarness({ mode: 'doc' });
    f.bindPort();
    f.send({ t: 'mount', doc: { mid: MID_A, tag: 'img', props: { src: url } } });
    const props = f.byMid(MID_A)!.props as Record<string, unknown>;
    expect(props.src === url).toBe(kept);
  });

  it('strips a control-character-obfuscated javascript: URL', () => {
    h.send({ t: 'mount', doc: { mid: MID_A, tag: 'a', props: { href: 'java\nscript:alert(1)' } } });
    expect((h.byMid(MID_A)!.props as Record<string, unknown>).href).toBeUndefined();
  });

  it.each([
    ['red', true],
    ['var(--theme-color-primary)', true],
    ['url(https://cdn.example/a.png)', true],
    ['url(javascript:alert(1))', false],
    ['red; } body { display:none', false],
    ['expression(alert(1))', false],
    ['-moz-binding: url(x)', false],
  ])('style value %s → kept=%s', (value, kept) => {
    const f = loadHarness({ mode: 'doc' });
    f.bindPort();
    f.send({ t: 'mount', doc: { mid: MID_A, tag: 'div', style: { background: value } } });
    const style = (f.byMid(MID_A)!.props as Record<string, unknown>).style as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(style, 'background')).toBe(kept);
  });

  it('renders slots as props and OMITS an empty slot (primitives branch on truthiness)', () => {
    h.send({
      t: 'mount',
      doc: {
        mid: MID_A, tag: 'UI.AppShell',
        slots: { sidebar: [{ mid: MID_B, tag: 'UI.Sidebar' }], topBar: [] },
      },
    });
    const props = inner(h.byMid(MID_A))!.props as Record<string, unknown>;
    expect(props.sidebar).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(props, 'topBar')).toBe(false);
  });

  it('caps runaway nesting instead of blowing the stack', () => {
    let node: Record<string, unknown> = { mid: MID_C, tag: 'div', text: 'deep' };
    for (let i = 0; i < 400; i++) { node = { tag: 'div', children: [node] }; }
    (node as { mid?: string }).mid = MID_A;
    h.send({ t: 'mount', doc: node });
    expect(h.renders).toHaveLength(1);
    expect(h.byMid(MID_C)).toBeNull();      // truncated below MAX_DEPTH
    expect(h.byMid(MID_A)).toBeTruthy();    // the root still rendered
  });

  it('clamps an oversized text leaf', () => {
    h.send({ t: 'mount', doc: { mid: MID_A, tag: 'div', text: 'x'.repeat(50000) } });
    const children = (h.byMid(MID_A)!.props as Record<string, unknown>).children as string;
    expect(children.length).toBe(20000);
  });
});

describe('harness — op application', () => {
  let h: HarnessHandles;
  beforeEach(() => {
    h = loadHarness({ mode: 'doc' });
    h.bindPort();
    h.send({ t: 'mount', doc: simpleDoc() });
  });

  const patch = (...ops: unknown[]) => h.send({ t: 'patch', ops });

  it('el.setStyle merges, and a null value deletes the declaration', () => {
    patch({ op: 'el.setStyle', pageId: 'p', mid: MID_C, style: { color: 'blue' } });
    let style = (h.byMid(MID_C)!.props as Record<string, unknown>).style as Record<string, unknown>;
    expect(style).toEqual({ backgroundColor: 'red', color: 'blue' });
    patch({ op: 'el.setStyle', pageId: 'p', mid: MID_C, style: { 'background-color': null } });
    style = (h.byMid(MID_C)!.props as Record<string, unknown>).style as Record<string, unknown>;
    expect(style).toEqual({ color: 'blue' });
  });

  it('el.setProp sets and (with null) removes a prop', () => {
    patch({ op: 'el.setProp', pageId: 'p', mid: MID_B, name: 'as', value: 'h1' });
    expect((inner(h.byMid(MID_B))!.props as Record<string, unknown>).as).toBe('h1');
    patch({ op: 'el.setProp', pageId: 'p', mid: MID_B, name: 'as', value: null });
    expect((inner(h.byMid(MID_B))!.props as Record<string, unknown>).as).toBeUndefined();
  });

  it('el.insert honours an anchor mid and `end`', () => {
    patch({ op: 'el.insert', pageId: 'p', parentMid: MID_A, before: MID_B, node: { mid: 'dddddddddd', tag: 'div', text: 'first' } });
    patch({ op: 'el.insert', pageId: 'p', parentMid: MID_A, before: 'end', node: { mid: 'eeeeeeeeee', tag: 'div', text: 'last' } });
    const kids = (inner(h.byMid(MID_A))!.props as Record<string, unknown>).children as Record<string, unknown>[];
    const mids = kids.map(k => (k.props as Record<string, unknown>)['data-mid']);
    expect(mids).toEqual(['dddddddddd', MID_B, MID_C, 'eeeeeeeeee']);
  });

  it('el.remove, el.move and el.replace rewrite the tree', () => {
    patch({ op: 'el.move', pageId: 'p', mid: MID_B, newParentMid: MID_C, before: 'end' });
    expect(h.byMid(MID_B)).toBeTruthy();
    patch({ op: 'el.replace', pageId: 'p', mid: MID_B, node: { mid: 'ffffffffff', tag: 'div', text: 'new' } });
    expect(h.byMid(MID_B)).toBeNull();
    expect(h.byMid('ffffffffff')).toBeTruthy();
    patch({ op: 'el.remove', pageId: 'p', mid: 'ffffffffff' });
    expect(h.byMid('ffffffffff')).toBeNull();
  });

  it('page.setDoc swaps the whole document', () => {
    patch({ op: 'page.setDoc', pageId: 'p', doc: { mid: 'gggggggggg', tag: 'UI.Screen' } });
    expect(h.byMid(MID_A)).toBeNull();
    expect(h.byMid('gggggggggg')).toBeTruthy();
  });

  it('reports a miss instead of guessing when the mid is gone', () => {
    const before = h.renders.length;
    patch({ op: 'el.setText', pageId: 'p', mid: 'zzzzzzzzzz', text: 'nope' });
    expect(h.renders.length).toBe(before);   // no speculative re-render
    const err = h.up.find(m => m.t === 'error' && String(m.message).includes('resync'));
    expect(err).toBeTruthy();
  });

  it('ignores board-scope ops without calling them a miss', () => {
    patch({ op: 'page.add', page: {} }, { op: 'asset.add', asset: {} }, { op: 'theme.set', theme: {} });
    expect(h.up.some(m => m.t === 'error')).toBe(false);
  });

  it('a hostile op payload cannot inject a prototype-polluting key', () => {
    patch({ op: 'el.setProp', pageId: 'p', mid: MID_C, name: '__proto__', value: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a prop named __proto__ becomes a REAL own property, not a lost write', () => {
    patch({ op: 'el.setProp', pageId: 'p', mid: MID_C, name: '__proto__', value: 'sentinel' });
    const props = h.byMid(MID_C)!.props as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(props, '__proto__')).toBe(true);
    expect(Object.keys(props)).toContain('__proto__');
    // …and removing it round-trips, which a prototype-setter write could not do.
    patch({ op: 'el.setProp', pageId: 'p', mid: MID_C, name: '__proto__', value: null });
    const after = h.byMid(MID_C)!.props as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(after, '__proto__')).toBe(false);
  });

  it('a style property named __proto__ is filtered out and corrupts nothing', () => {
    // Built via JSON.parse: an object LITERAL with `__proto__:` sets the
    // prototype, so it would not even reach the harness as a real key.
    const hostile = JSON.parse('{"__proto__":"red","color":"blue"}') as Record<string, string>;
    patch({ op: 'el.setStyle', pageId: 'p', mid: MID_C, style: hostile });
    const style = (h.byMid(MID_C)!.props as Record<string, unknown>).style as Record<string, unknown>;
    // `__proto__` is not a CSS property, so the allowlist drops it — but the
    // sibling declarations in the same op still land, and the style object is
    // still a normal object (a prototype-setter write would have replaced it).
    expect(Object.keys(style).sort()).toEqual(['backgroundColor', 'color']);
    // Cross-realm safe "is a plain object": exactly one prototype level.
    expect(Object.getPrototypeOf(Object.getPrototypeOf(style))).toBeNull();
    expect(({} as Record<string, unknown>).color).toBeUndefined();
  });

  it('a slot named __proto__ stays addressable', () => {
    patch({
      op: 'el.insert', pageId: 'p', parentMid: MID_A, before: 'end', slot: '__proto__',
      node: { mid: 'hhhhhhhhhh', tag: 'UI.Badge', text: 'x' },
    });
    expect(h.byMid('hhhhhhhhhh')).toBeTruthy();
    patch({ op: 'el.remove', pageId: 'p', mid: 'hhhhhhhhhh' });
    expect(h.byMid('hhhhhhhhhh')).toBeNull();
  });
});

describe('harness — geometry, hits and inline editing', () => {
  function seeded() {
    const h = loadHarness({
      mode: 'doc',
      seed: root => {
        const card = new FakeEl('div');
        card.setAttribute('data-mid', MID_A);
        card.setAttribute('data-mid-wrap', '1');
        card.rect = { left: 20, top: 40, width: 100, height: 50 };
        const box = new FakeEl('div');       // the primitive's single root element
        box.rect = { left: 22, top: 44, width: 96, height: 46 };
        box.textContent = 'Original';
        card.appendChild(box);

        const leaf = new FakeEl('span');     // a plain node inside the box
        leaf.rect = { left: 30, top: 50, width: 20, height: 10 };
        box.appendChild(leaf);

        const other = new FakeEl('div');
        other.setAttribute('data-mid', MID_B);
        other.rect = { left: 0, top: 100, width: 50, height: 20 };
        root.appendChild(card);
        root.appendChild(other);
      },
    });
    h.bindPort();
    return h;
  }

  it('measure reports size and every mid rect in PAGE coordinates', () => {
    const h = seeded();
    h.send({ t: 'measure' });
    const size = h.up.find(m => m.t === 'size') as Record<string, number>;
    expect(size).toMatchObject({ w: 390, h: 900 });
    const rects = (h.up.find(m => m.t === 'rects') as Record<string, unknown>).rects as Record<string, Record<string, number>>;
    // wrapper → measured off its single element child, minus the root origin.
    expect(rects[MID_A]).toEqual({ x: 12, y: 24, w: 96, h: 46 });
    expect(rects[MID_B]).toEqual({ x: -10, y: 80, w: 50, h: 20 });
  });

  it('select answers with rects for ONLY the requested mids', () => {
    const h = seeded();
    h.send({ t: 'select', mids: [MID_B, 'not-a-real-mid-because-it-is-way-too-long-to-be-valid-at-all-x'] });
    const rects = (h.up.find(m => m.t === 'rects') as Record<string, unknown>).rects as Record<string, unknown>;
    expect(Object.keys(rects)).toEqual([MID_B]);
  });

  it('a mid named __proto__ still gets a reported rect', () => {
    const h = loadHarness({
      mode: 'doc',
      seed: root => {
        const el = new FakeEl('div');
        el.setAttribute('data-mid', '__proto__');
        el.rect = { left: 10, top: 20, width: 5, height: 6 };
        root.appendChild(el);
      },
    });
    h.bindPort();
    h.send({ t: 'measure' });
    const rects = (h.up.find(m => m.t === 'rects') as Record<string, unknown>).rects as Record<string, unknown>;
    expect(Object.keys(rects)).toContain('__proto__');
  });

  it('rects carry x/y/w/h and nothing else (no exfil surface)', () => {
    const h = seeded();
    h.send({ t: 'measure' });
    const rects = (h.up.find(m => m.t === 'rects') as Record<string, unknown>).rects as Record<string, unknown>;
    for (const r of Object.values(rects)) {
      expect(Object.keys(r as object).sort()).toEqual(['h', 'w', 'x', 'y']);
    }
  });

  it('a click reports the nearest mid ancestor with modifiers, and is prevented', () => {
    const h = seeded();
    const box = h.root.children[0].children[0];
    const leaf = box.children[0];
    let prevented = false;
    h.fire('click', {
      target: leaf,
      detail: 2,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      preventDefault() { prevented = true; },
      stopPropagation() { /* noop */ },
    });
    const hit = h.up.find(m => m.t === 'hit') as Record<string, unknown>;
    expect(prevented).toBe(true);
    expect(hit.mid).toBe(MID_A);
    expect(hit.double).toBe(true);
    expect(hit.modifiers).toEqual({ alt: false, ctrl: false, meta: false, shift: true });
    expect(hit.rect).toEqual({ x: 12, y: 24, w: 96, h: 46 });
  });

  it('a click outside any mid reports nothing but is still prevented', () => {
    const h = seeded();
    let prevented = false;
    h.fire('click', {
      target: h.root,
      preventDefault() { prevented = true; },
      stopPropagation() { /* noop */ },
    });
    expect(prevented).toBe(true);
    expect(h.up.some(m => m.t === 'hit')).toBe(false);
  });

  it('inline edit: Enter commits the new text and restores the DOM', () => {
    const h = seeded();
    const box = h.root.children[0].children[0];
    h.send({ t: 'beginTextEdit', mid: MID_A });
    expect(box.getAttribute('contenteditable')).toBe('plaintext-only');
    box.textContent = 'Edited';
    h.fire('keydown', { key: 'Enter', shiftKey: false, preventDefault() { /* noop */ } });
    const commit = h.up.find(m => m.t === 'textCommit') as Record<string, unknown>;
    expect(commit).toMatchObject({ mid: MID_A, text: 'Edited' });
    // The frame does not own the doc: the host applies the op and patches back.
    expect(box.textContent).toBe('Original');
    expect(box.hasAttribute('contenteditable')).toBe(false);
  });

  it('inline edit: Escape reverts and commits nothing', () => {
    const h = seeded();
    const box = h.root.children[0].children[0];
    h.send({ t: 'beginTextEdit', mid: MID_A });
    box.textContent = 'Edited';
    h.fire('keydown', { key: 'Escape', preventDefault() { /* noop */ } });
    expect(h.up.some(m => m.t === 'textCommit')).toBe(false);
    expect(box.textContent).toBe('Original');
  });

  it('inline edit on an unrendered mid reports an error rather than silently doing nothing', () => {
    const h = seeded();
    h.send({ t: 'beginTextEdit', mid: 'zzzzzzzzzz' });
    const err = h.up.find(m => m.t === 'error') as Record<string, unknown>;
    expect(String(err.message)).toContain('cannot edit');
    expect(err.mid).toBe('zzzzzzzzzz');
  });

  it('an unknown down-message is ignored without throwing', () => {
    const h = seeded();
    expect(() => h.send({ t: 'definitelyNotAThing' })).not.toThrow();
    expect(() => h.send('a string')).not.toThrow();
    expect(() => h.send(null)).not.toThrow();
  });
});

describe('harness — legacy mode', () => {
  it('says so when a legacy page has no Babel to compile it with', () => {
    const h = loadHarness({ mode: 'jsx', jsxSource: 'function Page(){return null;}' });
    expect(h.parentMsgs.some(m => String(m.message ?? '').includes('Babel'))).toBe(true);
    expect(h.renders).toHaveLength(0);
  });

  it('reports an empty legacy page rather than rendering a blank frame', () => {
    const h = loadHarness({ mode: 'jsx' });
    expect(h.parentMsgs.some(m => String(m.message ?? '').includes('empty page source'))).toBe(true);
  });

  it('never interprets a doc in legacy mode', () => {
    const h = loadHarness({ mode: 'jsx', bootstrap: { doc: { mid: 'aaaaaaaaaa', tag: 'UI.Screen' } } });
    expect(h.renders).toHaveLength(0);
  });

  it('html mode renders nothing itself (the DOM is already there)', () => {
    const h = loadHarness({ mode: 'html' });
    expect(h.renders).toHaveLength(0);
    expect(h.parentMsgs.some(m => m.type === 'page_ready')).toBe(true);
  });
});
