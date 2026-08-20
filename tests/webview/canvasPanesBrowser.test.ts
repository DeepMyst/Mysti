/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 — the two SIDE PANES, measured in a real browser.
 *
 * `canvasLayoutBrowser.test.ts` owns the shell's grid; this file owns what the
 * rail and the inspector actually render into it, for the two questions the
 * fake DOM structurally cannot answer:
 *
 * - **Colour** (CV-T1). `preview.ts` emits every primitive's paint as
 *   `var(--theme-color-*)` with no fallback. Whether that resolves depends on
 *   the CASCADE — an undefined custom property makes the declaration invalid at
 *   computed-value time, so `background` falls back to `transparent` and `color`
 *   inherits from the shell. `FakeDocument` has no cascade, so it recorded the
 *   declaration and never noticed it painted nothing. Contrast here is a
 *   MEASURED ratio between `getComputedStyle` values.
 * - **Focus** (A11Y-5). Whether a `<label for>` reaches its control is the
 *   browser's answer, not ours — and it is the same association the
 *   accessibility tree computes the control's NAME from.
 *
 * Both subjects are built by the REAL `RailController` / `InspectorPanel`
 * against the fake DOM and then rebuilt node-for-node in the page, so what is
 * measured is the markup and the style declarations those modules actually
 * emit — never a hand-written approximation of them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import { RailController } from '../../src/webview/canvas/rail';
import { InspectorPanel } from '../../src/webview/canvas/inspector';
import type { CanvasEnv, DomElement } from '../../src/webview/canvas/dom';
import type { WireArtifact } from '../../src/canvas/protocol';
import type { DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { decideLayoutMode, paneIsDocked, type LayoutMode } from '../../src/webview/canvas/boardMath';
import { FakeDocument, FakeElement } from './canvasFakeDom';

const ROOT = path.resolve(__dirname, '../..');

let browser: Browser | undefined;
let page: Page | undefined;
let unavailable: string | null = null;

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
  try { await boot(); } catch (err) {
    unavailable = err instanceof Error ? err.message : String(err);
  }
}, 120_000);
afterAll(async () => { await browser?.close(); });

/* ------------------------- fake DOM → real DOM ------------------------- */

/** A `FakeElement` subtree, flattened so it can cross into the browser. */
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

/* ───────────────────── CV-T1: the rail tile's contrast ───────────────────── */

/** One rail row, drawn by the real controller from a DARK design theme. */
function darkRailRow(): Serialized {
  const doc = new FakeDocument();
  const list = new FakeElement('div');
  const rail = new RailController({
    env: fakeEnv(doc),
    list: list as unknown as DomElement,
    callbacks: { submit: () => { /* unused */ }, select: () => { /* unused */ } },
  });
  const base = getThemePreset('clean-saas')!.theme;
  const theme: DesignTheme = {
    ...base,
    colors: { ...base.colors, background: '#0d1117', surface: '#161b22', text: '#e6edf3', border: '#30363d' },
  };
  rail.render({
    id: 'art1', version: 1, kind: 'screens', name: 'Acme', format: getFormat('desktop')!, theme,
    assets: [], updatedAt: 0, approvalMode: 'auto',
    pages: [{
      id: 'a', version: 1, boardPos: { x: 0, y: 0 }, actionTitle: 'Home',
      doc: {
        mid: 'aaaaaaaaaa', tag: 'UI.Screen',
        children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'Monthly revenue' }],
      },
    }],
  } as unknown as WireArtifact, { focusedPageId: null });
  return serialize(list.children[0]);
}

/**
 * Mount a serialized row into the real `#rail-list` under a dark VS Code
 * palette, and report the design text's contrast against what is behind it.
 */
async function railTextContrast(row: Serialized, needle: string): Promise<number> {
  return page!.evaluate(({ row, needle }) => {
    const root = document.documentElement;
    // Dark Modern, as VS Code injects it.
    root.style.setProperty('--vscode-foreground', '#CCCCCC');
    root.style.setProperty('--vscode-editor-background', '#1F1F1F');
    root.style.setProperty('--vscode-sideBar-background', '#181818');
    root.style.setProperty('--vscode-editorWidget-background', '#202020');
    document.body.className = 'vscode-dark';

    const build = (node: typeof row): HTMLElement => {
      const el = document.createElement(node.tag);
      if (node.className) { el.className = node.className; }
      for (const [k, v] of node.attrs) { el.setAttribute(k, v); }
      for (const [k, v] of node.style) { el.style.setProperty(k, v); }
      if (node.text !== null && node.text !== undefined) { el.textContent = node.text; }
      for (const c of node.children) { el.appendChild(build(c as typeof row)); }
      return el;
    };
    const list = document.getElementById('rail-list')!;
    list.replaceChildren(build(row));

    const target = [...list.querySelectorAll<HTMLElement>('*')]
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
    list.replaceChildren();
    const a = lum(fg), b = lum(behind);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, { row, needle });
}

describe('rail thumbnails in a dark editor (real browser)', () => {
  it('paints the design\'s own text on the design\'s own paper, not the shell\'s', async () => {
    if (unavailable) { console.warn('[Mysti] skipping — Chromium unavailable:', unavailable); return; }
    // Before the fix the tile carried no `--theme-*` vars at all, so
    // `color: var(--theme-color-text)` was invalid at computed-value time and
    // the design's text INHERITED the shell's #CCCCCC, while
    // `background: var(--theme-color-background)` fell back to `transparent`,
    // revealing `.thumb-preview`'s hardcoded white `--canvas-paper`. Measured
    // ratio at that point: 1.61:1 — a rail of blank white cards in every dark
    // theme, which is also every version thumbnail and every staged tile.
    const contrast = await railTextContrast(darkRailRow(), 'Monthly revenue');
    expect(contrast, 'the tile was not mounted').toBeGreaterThan(0);
    expect(contrast, 'design text vs. what is actually behind it in the rail tile')
      .toBeGreaterThan(4.5);
  }, 120_000);
});

/* ────────────── A11Y-5: the inspector's label association ────────────── */

/** The properties panel for one selected element, drawn by the real panel. */
function inspectorPanelDom(): Serialized {
  const doc = new FakeDocument();
  const host = new FakeElement('div');
  const panel = new InspectorPanel({
    env: fakeEnv(doc),
    host: host as unknown as DomElement,
    callbacks: { submit: () => { /* unused */ }, unpin: () => { /* unused */ } },
  });
  panel.render({
    pageId: 'p1',
    mids: ['aaaaaaaaaa'],
    nodes: [{
      mid: 'aaaaaaaaaa', tag: 'UI.Button',
      props: { label: 'Sign in', variant: 'primary' }, text: 'Sign in',
    }],
    theme: getThemePreset('clean-saas')!.theme,
  });
  return serialize(host);
}

describe('inspector controls have a real accessible name (real browser)', () => {
  it('clicking a property label moves focus into that property\'s control', async () => {
    if (unavailable) { console.warn('[Mysti] skipping — Chromium unavailable:', unavailable); return; }
    // The one thing the fake DOM cannot answer: whether the `for`/`id` pair the
    // panel writes is the association the BROWSER honours — which is the same
    // association the accessibility tree computes each control's NAME from.
    // Before the fix every `.ctl-label` was an unassociated sibling of its
    // widget: clicking one focused nothing (31 of 31 rows), and every control
    // announced as "edit text, blank" / "slider, 16" / "combo box".
    const dom = inspectorPanelDom();
    const result = await page!.evaluate(node => {
      const build = (n: typeof node): HTMLElement => {
        const el = document.createElement(n.tag);
        if (n.className) { el.className = n.className; }
        for (const [k, v] of n.attrs) { el.setAttribute(k, v); }
        for (const [k, v] of n.style) { el.style.setProperty(k, v); }
        if (n.text !== null && n.text !== undefined) { el.textContent = n.text; }
        for (const c of n.children) { el.appendChild(build(c as typeof n)); }
        return el;
      };
      const host = document.getElementById('insp-body')!;
      host.replaceChildren(...[...build(node).childNodes]);

      const rows = [...host.querySelectorAll<HTMLElement>('[data-control]')];
      const misses: string[] = [];
      const ids = new Set<string>();
      for (const row of rows) {
        const label = row.querySelector<HTMLLabelElement>('label.ctl-label');
        if (!label) { misses.push(`${row.dataset.control}: no label`); continue; }
        const target = label.htmlFor ? document.getElementById(label.htmlFor) : null;
        if (target && ids.has(label.htmlFor)) { misses.push(`${row.dataset.control}: duplicate id`); }
        ids.add(label.htmlFor);
        (document.activeElement as HTMLElement | null)?.blur?.();
        label.click();
        const active = document.activeElement;
        if (!active || active === document.body || !row.contains(active)) {
          misses.push(`${row.dataset.control}: the label focused ${active?.tagName ?? 'nothing'}`);
        }
      }
      host.replaceChildren();
      return { rows: rows.length, misses };
    }, dom);
    expect(result.rows, 'the panel was not mounted').toBeGreaterThan(4);
    expect(result.misses).toEqual([]);
  }, 120_000);
});

/* ───────── A11Y-8: the rail's tab order, walked with a real Tab key ───────── */

/** A whole rail list, drawn by the real controller. */
function railList(count: number): Serialized {
  const doc = new FakeDocument();
  const list = new FakeElement('div');
  const rail = new RailController({
    env: fakeEnv(doc),
    list: list as unknown as DomElement,
    callbacks: { submit: () => { /* unused */ }, select: () => { /* unused */ } },
  });
  rail.render({
    id: 'art1', version: 1, kind: 'screens', name: 'Acme',
    format: getFormat('desktop')!, theme: getThemePreset('clean-saas')!.theme,
    assets: [], updatedAt: 0, approvalMode: 'auto',
    pages: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`, version: 1, boardPos: { x: 0, y: 0 }, actionTitle: `Screen ${i + 1}`,
      doc: { mid: `aaaaaaaaa${i}`, tag: 'UI.Screen' },
    })),
  } as unknown as WireArtifact, { focusedPageId: null });
  return serialize(list);
}

describe('the pages rail is one tab stop (real browser)', () => {
  it('never puts a row action in the Tab order', async () => {
    if (unavailable) { console.warn('[Mysti] skipping — Chromium unavailable:', unavailable); return; }
    // The class documents "exactly one tab stop rather than one per row plus
    // three per row's actions", but only the ROW ever got a tabindex — and a
    // <button> is tabbable by default. A 20-artboard rail was 80 tab stops, and
    // "Delete Screen 3" sat one Enter away from a row the user was passing.
    await page!.setViewportSize({ width: 1200, height: 900 });
    await page!.evaluate(node => {
      const build = (n: typeof node): HTMLElement => {
        const el = document.createElement(n.tag);
        if (n.className) { el.className = n.className; }
        for (const [k, v] of n.attrs) { el.setAttribute(k, v); }
        for (const [k, v] of n.style) { el.style.setProperty(k, v); }
        if (n.text !== null && n.text !== undefined) { el.textContent = n.text; }
        for (const c of n.children) { el.appendChild(build(c as typeof n)); }
        return el;
      };
      document.getElementById('rail-list')!.replaceChildren(...[...build(node).childNodes]);
      document.getElementById('btn-add-page')!.focus();
    }, railList(3));

    const trail: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page!.keyboard.press('Tab');
      trail.push(await page!.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) { return 'nothing'; }
        return `${el.id || el.className || el.tagName}`;
      }));
    }
    await page!.evaluate(() => { document.getElementById('rail-list')!.replaceChildren(); });

    expect(trail.filter(t => t.includes('thumb-action')), `Tab trail: ${trail.join(' → ')}`).toEqual([]);
    expect(trail.filter(t => t.includes('thumb')), `Tab trail: ${trail.join(' → ')}`).toHaveLength(1);
  }, 120_000);
});

/* ───── CANVAS-W2: the JS breakpoint against the one the stylesheet uses ───── */

/** What the STYLESHEET does at this width, with the shell in its default state. */
async function stylesheetDocking(width: number): Promise<{ appWidth: number; rail: boolean; inspector: boolean }> {
  await page!.setViewportSize({ width, height: 900 });
  return page!.evaluate(() => {
    const app = document.getElementById('app')!;
    app.className = 'app';
    for (const id of ['rail-hidden', 'rail-shown', 'inspector-hidden', 'inspector-shown']) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) { el.checked = false; }
    }
    const shown = (id: string): boolean => getComputedStyle(document.getElementById(id)!).display !== 'none';
    return { appWidth: app.clientWidth, rail: shown('pages-rail'), inspector: shown('inspector') };
  });
}

describe('the JS layout mode agrees with the container-query ladder (real browser)', () => {
  it('names the same panes docked as the stylesheet does, from any previous mode', async () => {
    if (unavailable) { console.warn('[Mysti] skipping — Chromium unavailable:', unavailable); return; }
    // Two authorities decide whether a pane is a docked column or a modal
    // overlay: `@container canvas-shell` in canvas.css §5, and
    // `paneIsDocked(decideLayoutMode(width))` in the shell. They pick WHICH of
    // the pane's two checkboxes the toggle and the `[` / `]` / `\` / Escape
    // shortcuts write, so a disagreement is a keyboard command that writes a
    // switch the stylesheet ignores. 48px of JS hysteresis produced four such
    // bands (936-984 and 616-664); this is the cross-check that closes them.
    const previous: Array<LayoutMode | null> = [null, 'narrow', 'medium', 'wide'];
    const mismatches: string[] = [];
    for (const w of [400, 639, 640, 660, 700, 900, 936, 950, 959, 960, 970, 984, 1000, 1400]) {
      const css = await stylesheetDocking(w);
      for (const prev of previous) {
        const mode = decideLayoutMode(css.appWidth, prev);
        for (const pane of ['rail', 'inspector'] as const) {
          if (paneIsDocked(mode, pane) !== css[pane]) {
            mismatches.push(`${w}px from ${prev}: JS says ${pane} ${paneIsDocked(mode, pane) ? 'docked' : 'overlay'}, CSS renders it ${css[pane] ? 'docked' : 'undocked'}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});
