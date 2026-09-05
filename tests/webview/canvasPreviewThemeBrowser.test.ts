/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * CANVAS-P3-2 — a parent-side preview is only as legible as the theme custom
 * properties its HOST carries, and the fake DOM cannot see that.
 *
 * `preview.ts` emits every colour, border, radius and shadow as
 * `var(--theme-*)`. Those properties live on whatever element mounts the
 * preview, and an undefined one makes the whole declaration invalid AT
 * COMPUTED-VALUE TIME: `background` falls back to `transparent` (revealing the
 * hardcoded white `--canvas-paper` under it), `border`/`border-radius`/
 * `box-shadow` collapse to nothing, and `color` INHERITS the shell's
 * foreground. `FakeDocument` has no cascade, so every existing test recorded
 * the declaration and never noticed it painted nothing.
 *
 * `rail.ts` stamps `themeCssVars` on its tiles (with a 10-line comment saying
 * exactly why) and `board.ts` stamps them on each artboard root. The review
 * queue's Before/After panes and the version-history thumbnails did not — so:
 *
 *  1. a staged `el.setStyle` that swaps one theme token for another rendered
 *     BYTE-IDENTICAL Before and After panes (the human presses Accept or Reject
 *     on two identical pictures), and
 *  2. in any dark editor a preview drawn on a bare host was the design's text
 *     at ~1.6:1 on white, below every legibility floor this suite enforces.
 *
 * Both halves are measured here, in headless Chromium, against the REAL
 * `index.html` + `canvas.css`. The subject is built by the REAL
 * `LivenessLayer` / `renderPreview` against the fake DOM and then rebuilt
 * node-for-node in the page, so what is measured is the markup and the
 * declarations those modules actually emit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import { mountLiveness } from '../../src/webview/canvas/liveness';
import { drawPreview } from '../../src/webview/canvas/preview';
import type { CanvasEnv, DomElement } from '../../src/webview/canvas/dom';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import type { DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { FakeDocument, FakeElement } from './canvasFakeDom';

const ROOT = path.resolve(__dirname, '../..');

let browser: Browser | undefined;
let page: Page | undefined;

async function boot(): Promise<void> {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  page = await browser.newPage();
  let html = fs.readFileSync(path.join(ROOT, 'media/canvas/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'media/canvas/canvas.css'), 'utf8');
  html = html
    .replace('{{cspMeta}}', '')
    .replace('<link rel="stylesheet" href="{{cssUri}}">', `<style>${css}</style>`)
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace('{{boot}}', '')
    .replace(/<script[^>]*src="\{\{jsUri\}\}"[^>]*><\/script>/, '');
  await page.setContent(html, { waitUntil: 'load' });
  await page.setViewportSize({ width: 1200, height: 900 });
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  await boot();
}, 120_000);
afterAll(async () => { await browser?.close(); });

/* ------------------------- fake DOM → real DOM ------------------------- */

interface Serialized {
  tag: string;
  className: string;
  attrs: Array<[string, string]>;
  style: Array<[string, string]>;
  text: string | null;
  children: Serialized[];
}

function serialize(el: FakeElement): Serialized {
  return {
    tag: el.tag,
    className: el.className,
    attrs: [...el.attrs.entries()],
    style: [...el.style.props.entries()],
    text: el.textContent,
    children: el.children.map(serialize),
  };
}

function fakeEnv(doc: FakeDocument): CanvasEnv {
  return {
    doc: doc as unknown as CanvasEnv['doc'],
    self: { addEventListener: () => { /* unused */ } },
    createIntersectionObserver: null,
    createMessageChannel: () => ({}) as ReturnType<CanvasEnv['createMessageChannel']>,
    fetchText: async () => '',
    now: () => 0,
    warn: () => { /* silent */ },
  } as unknown as CanvasEnv;
}

/**
 * A DARK design theme with colours that exist in no fallback table, so a pane
 * painted from the renderer's own last resort is distinguishable from one
 * painted from the DESIGN's theme. That distinction is the whole test: a
 * legible-but-wrong palette would still mislead an Accept/Reject decision.
 */
const BASE = getThemePreset('clean-saas')!.theme;
const DESIGN_THEME: DesignTheme = {
  ...BASE,
  colors: {
    ...BASE.colors,
    background: '#0d1117',
    surface: '#161b22',
    primary: '#7c3aed',
    text: '#e6edf3',
    border: '#30363d',
  },
};

/** rgb() strings for what the design says, so the assertions read as colours. */
const SURFACE_RGB = 'rgb(22, 27, 34)';
const PRIMARY_RGB = 'rgb(124, 58, 237)';

const CARD: DocNode = {
  mid: 'rootaaaaaa',
  tag: 'UI.Card',
  style: { background: 'var(--theme-color-surface)' },
  children: [{ mid: 'textaaaaaa', tag: 'UI.Text', text: 'Monthly revenue' }],
};

/**
 * The review queue as the REAL layer draws it, for one staged `el.setStyle`
 * that swaps `color-surface` for `color-primary` — i.e. the commonest thing a
 * designer is ever asked to accept or reject.
 */
function stagedRowDom(): Serialized {
  const doc = new FakeDocument();
  const rail = new FakeElement('div');
  const layer = mountLiveness({
    env: fakeEnv(doc),
    hosts: {
      world: new FakeElement('div') as unknown as DomElement,
      overlay: new FakeElement('div') as unknown as DomElement,
      rail: rail as unknown as DomElement,
    },
    send: () => { /* unused */ },
    pages: () => [{ id: 'p1', doc: CARD }],
    theme: () => DESIGN_THEME,
  });
  layer.onStaged([{
    opId: 'op-1', txnId: 't', runId: 'r', author: 'agent', actorId: 'a', status: 'staged', ts: 0,
    op: {
      op: 'el.setStyle', pageId: 'p1', mid: 'rootaaaaaa',
      style: { background: 'var(--theme-color-primary)' },
    },
  }]);
  const row = rail.find(e => e.className === 'staged-row');
  if (!row) { throw new Error('the review queue rendered no row'); }
  return serialize(row);
}

/** A preview drawn into a bare host — exactly what a version thumbnail is. */
function bareThumbDom(): Serialized {
  const doc = new FakeDocument();
  const tile = new FakeElement('div');
  tile.className = 'version-thumb';
  drawPreview(tile as unknown as DomElement, CARD, doc as unknown as CanvasEnv['doc']);
  return serialize(tile);
}

/** Mount a serialized subtree under a dark VS Code palette and hand it back. */
async function mountUnderDarkShell(node: Serialized, hostId: string): Promise<void> {
  await page!.evaluate(({ node, hostId }) => {
    const root = document.documentElement;
    // Dark Modern, as VS Code injects it.
    root.style.setProperty('--vscode-foreground', '#CCCCCC');
    root.style.setProperty('--vscode-editor-background', '#1F1F1F');
    root.style.setProperty('--vscode-sideBar-background', '#181818');
    root.style.setProperty('--vscode-editorWidget-background', '#202020');
    document.body.className = 'vscode-dark';

    const build = (n: typeof node): HTMLElement => {
      const el = document.createElement(n.tag);
      if (n.className) { el.className = n.className; }
      for (const [k, v] of n.attrs) { el.setAttribute(k, v); }
      for (const [k, v] of n.style) { el.style.setProperty(k, v); }
      if (n.text !== null && n.text !== undefined) { el.textContent = n.text; }
      for (const c of n.children) { el.appendChild(build(c as typeof node)); }
      return el;
    };
    document.getElementById(hostId)!.replaceChildren(build(node));
  }, { node, hostId });
}

/** The computed paint of the first `[data-ui="Card"]` under `sel`. */
async function cardPaint(sel: string): Promise<{ background: string; radius: string; found: boolean }> {
  return page!.evaluate(sel => {
    const card = document.querySelector<HTMLElement>(`${sel} [data-ui="Card"]`);
    if (!card) { return { background: '', radius: '', found: false }; }
    const cs = getComputedStyle(card);
    return { background: cs.backgroundColor, radius: cs.borderTopLeftRadius, found: true };
  }, sel);
}

/** Contrast of the design's own text against everything painted behind it. */
async function designTextContrast(sel: string, needle: string): Promise<number> {
  return page!.evaluate(({ sel, needle }) => {
    const host = document.querySelector<HTMLElement>(sel);
    if (!host) { return -1; }
    const target = [...host.querySelectorAll<HTMLElement>('*')]
      .find(el => el.children.length === 0 && (el.textContent ?? '').trim() === needle);
    if (!target) { return -1; }
    const parse = (value: string): [number, number, number] => {
      const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
      const scale = value.startsWith('color(') ? 255 : 1;
      return [(parts[0] ?? 0) * scale, (parts[1] ?? 0) * scale, (parts[2] ?? 0) * scale];
    };
    const opaque = (value: string): boolean => {
      const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
      return value !== 'transparent' && value !== 'none' && (parts.length < 4 || parts[3] > 0.5);
    };
    const lum = ([r, g, b]: [number, number, number]): number => {
      const f = (v: number): number => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = parse(getComputedStyle(target).color);
    let behind: [number, number, number] = [255, 255, 255];
    for (let el: HTMLElement | null = target; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (opaque(bg)) { behind = parse(bg); break; }
    }
    const a = lum(fg), b = lum(behind);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, { sel, needle });
}

/* ═══════ the same property, asserted where Chromium is not available ═══════ */

describe('CANVAS-P3-2 · the layer stamps the design theme on every pane', () => {
  it('sets --theme-* on both .sr-preview hosts, and degrades without a theme', () => {
    const withTheme = stagedRowDom();
    const panes = (row: Serialized): Serialized[] => {
      const out: Serialized[] = [];
      const walk = (n: Serialized): void => {
        if (n.className === 'sr-preview') { out.push(n); }
        n.children.forEach(walk);
      };
      walk(row);
      return out;
    };
    const hosts = panes(withTheme);
    expect(hosts).toHaveLength(2);
    for (const host of hosts) {
      const vars = new Map(host.style);
      expect(vars.get('--theme-color-surface')).toBe('#161b22');
      expect(vars.get('--theme-color-primary')).toBe('#7c3aed');
    }
  });
});

/* ═════════════════ the review queue's Before / After panes ═════════════════ */

describe('CANVAS-P3-2 · a staged restyle must LOOK different (real browser)', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('paints Before and After in the DESIGN’s theme, not identically', async () => {
    await mountUnderDarkShell(stagedRowDom(), 'staged-rail');

    const before = await cardPaint('.sr-before .sr-preview');
    const after = await cardPaint('.sr-after .sr-preview');
    expect(before.found && after.found, 'the panes rendered no card').toBe(true);

    // Before the fix BOTH were `rgba(0, 0, 0, 0)` with `0px` radius: the panes
    // carried no `--theme-*` at all, so every declaration the op changes was
    // invalid at computed-value time and Accept/Reject decided two identical
    // pictures.
    expect(before.background, 'Before must paint the design’s surface').toBe(SURFACE_RGB);
    expect(after.background, 'After must paint the design’s primary').toBe(PRIMARY_RGB);
    expect(before.background).not.toBe(after.background);
    // …and the structure the op did NOT change must survive in both.
    expect(parseFloat(before.radius), 'Before lost its radius').toBeGreaterThan(0);
    expect(parseFloat(after.radius), 'After lost its radius').toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps the design’s own text legible in a dark editor', async () => {
    await mountUnderDarkShell(stagedRowDom(), 'staged-rail');
    // Measured at 2.71:1 before the fix — the design's #CCCCCC-inherited text
    // on the hardcoded white `--canvas-paper` of `.sr-preview`.
    const ratio = await designTextContrast('.sr-before .sr-preview', 'Monthly revenue');
    expect(ratio, 'the pane was not mounted').toBeGreaterThan(0);
    expect(ratio, 'design text vs. what is actually behind it in the Before pane')
      .toBeGreaterThan(4.5);
  }, 120_000);
});

/* ════════════ the renderer's own last resort, for a bare host ════════════ */

describe('CANVAS-P3-2 · a preview on a bare host degrades, it does not collapse', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('stays legible and structurally intact with no --theme-* anywhere', async () => {
    // `historyUi._renderVersion` mounts a thumbnail exactly like this: no theme
    // custom properties on the tile, on a `--canvas-paper` white ground. Before
    // the renderer carried a fallback arm this measured 1.61:1 with
    // `border-style: none` and `border-radius: 0px` — the design stripped of
    // itself.
    await mountUnderDarkShell(bareThumbDom(), 'version-timeline');
    const paint = await cardPaint('.version-thumb');
    expect(paint.found, 'the thumbnail rendered no card').toBe(true);
    expect(parseFloat(paint.radius), 'the card collapsed to a square').toBeGreaterThan(0);

    const ratio = await designTextContrast('.version-thumb', 'Monthly revenue');
    expect(ratio, 'the thumbnail was not mounted').toBeGreaterThan(0);
    expect(ratio, 'design text in a version thumbnail').toBeGreaterThan(4.5);
  }, 120_000);
});
