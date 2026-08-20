/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 — the canvas shell's LAYOUT and THEME CORRECTNESS, measured in a real
 * browser.
 *
 * Every other webview test drives `FakeDocument`, which has no cascade, no grid
 * and no box model — so it can assert that a rule exists in the stylesheet but
 * never that the rule does what it says. That gap shipped a critical bug: the
 * shell declared three grid tracks and placed nothing into them, so the moment
 * the rail left flow (`display:none` at narrow widths, or the `[` toggle at any
 * width) `main.board` auto-placed into the rail's `0px` track and the entire
 * board rendered at ZERO width. A guard test existed and passed — it substring
 * matched `minmax(min(var(--board-floor), 100%), 1fr)` in the CSS text, never
 * checking which element occupied that track.
 *
 * The same gap hides every THEME defect: a `--vscode-*` token that does not
 * exist in some themes resolves to its fallback, an `rgba()` wash only dims when
 * the ground it assumes is real, and a `transparent` border erases structure in
 * exactly the two themes where VS Code makes borders load-bearing. None of that
 * is visible to a stylesheet substring match — it is only visible to
 * `getComputedStyle` under a `body.vscode-*` class, which is what the second
 * half of this file does. Contrast is asserted as a measured RATIO, never as an
 * equality on a hex string.
 *
 * This file loads the REAL `index.html` + `canvas.css` in headless Chromium and
 * measures. Playwright is already a dependency (`ScreenshotService`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../..');
/** Widths straddling every documented breakpoint (480 / 640 / 960). */
const WIDTHS = [320, 380, 479, 480, 500, 639, 640, 700, 800, 959, 960, 1200, 1400, 2000];

let browser: Browser | undefined;
let page: Page | undefined;
let unavailable: string | null = null;

/**
 * Colour maths, injected once into the page: sRGB parsing (including the
 * `color(srgb …)` form Chromium returns for every `color-mix()`), alpha
 * compositing down the ancestor chain, relative luminance and WCAG contrast.
 * It has to live in the page because only the page can resolve the cascade.
 */
const PROBE_JS = String.raw`
window.__probe = (function () {
  function parse(str) {
    if (!str || str === 'transparent' || str === 'none') { return { r: 0, g: 0, b: 0, a: 0 }; }
    var m = str.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,\/]+([\d.]+))?\s*\)$/);
    if (m) { return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }; }
    m = str.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/);
    if (m) { return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] }; }
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  function over(src, dst) {
    var a = src.a + dst.a * (1 - src.a);
    if (a === 0) { return { r: 0, g: 0, b: 0, a: 0 }; }
    var mix = function (s, d) { return (s * src.a + d * dst.a * (1 - src.a)) / a; };
    return { r: mix(src.r, dst.r), g: mix(src.g, dst.g), b: mix(src.b, dst.b), a: a };
  }
  function lum(c) {
    var ch = [c.r, c.g, c.b].map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function ratio(x, y) {
    var a = lum(x) + 0.05, b = lum(y) + 0.05;
    return +((a > b ? a / b : b / a).toFixed(2));
  }
  /** What a viewer actually sees behind (and including) this element. */
  function bgOf(el) {
    var acc = { r: 0, g: 0, b: 0, a: 0 };
    for (var n = el; n; n = n.parentElement) {
      var c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0) { acc = over(acc, c); if (acc.a >= 0.999) { return acc; } }
    }
    return over(acc, { r: 255, g: 255, b: 255, a: 1 });
  }
  function need(sel) {
    var el = document.querySelector(sel);
    if (!el) { throw new Error('probe: no element for ' + sel); }
    return el;
  }
  return {
    /** Contrast of an element's TEXT against everything painted behind it. */
    text: function (sel) {
      var el = need(sel);
      var bg = bgOf(el);
      var fg = over(parse(getComputedStyle(el).color), bg);
      return { ratio: ratio(fg, bg), fg: [Math.round(fg.r), Math.round(fg.g), Math.round(fg.b)], bg: [Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)] };
    },
    /** Is a surface delimited from what surrounds it, and by what? */
    edge: function (sel) {
      var el = need(sel);
      var cs = getComputedStyle(el);
      var paper = bgOf(el);
      var ground = bgOf(el.parentElement || document.body);
      var outline = parse(cs.outlineColor);
      var border = parse(cs.borderTopColor);
      var shadow = parse((cs.boxShadow.match(/^(rgba?\([^)]*\)|color\([^)]*\))/) || [])[0] || 'none');
      var hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && outline.a > 0;
      var hasBorder = cs.borderTopStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0 && border.a > 0;
      return {
        outlineStyle: cs.outlineStyle, borderStyle: cs.borderTopStyle,
        shadowAlpha: +shadow.a.toFixed(3),
        paperVsGround: ratio(paper, ground),
        edgeVsPaper: hasOutline ? ratio(over(outline, paper), paper) : (hasBorder ? ratio(over(border, paper), paper) : 0),
        edgeVsGround: hasOutline ? ratio(over(outline, ground), ground) : (hasBorder ? ratio(over(border, ground), ground) : 0),
      };
    },
    /** How much a translucent overlay actually changes the ground it covers. */
    wash: function (sel, groundSel) {
      var el = need(sel);
      var ground = bgOf(need(groundSel));
      var wash = parse(getComputedStyle(el).backgroundColor);
      return {
        display: getComputedStyle(el).display,
        alpha: +wash.a.toFixed(3),
        ratio: ratio(over(wash, ground), ground),
      };
    },
    /** Does a control give any VISIBLE feedback in its current state? */
    feedback: function (sel) {
      var el = need(sel);
      var cs = getComputedStyle(el);
      var around = bgOf(el.parentElement || document.body);
      var fill = parse(cs.backgroundColor);
      var outline = parse(cs.outlineColor);
      var border = parse(cs.borderTopColor);
      var hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && outline.a > 0;
      var hasBorder = cs.borderTopStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0 && border.a > 0;
      return {
        fillRatio: fill.a > 0 ? ratio(over(fill, around), around) : 1,
        outlineRatio: hasOutline ? ratio(over(outline, around), around) : 1,
        borderRatio: hasBorder ? ratio(over(border, around), around) : 1,
        outlineStyle: cs.outlineStyle,
      };
    },
    style: function (sel, props) {
      var cs = getComputedStyle(need(sel));
      var out = {};
      props.forEach(function (p) { out[p] = cs.getPropertyValue(p); });
      return out;
    },
    /** Can a keyboard reach this control, and is it rendered at all? */
    reachable: function (sel) {
      var el = need(sel);
      el.focus();
      return {
        focused: document.activeElement === el,
        rendered: !!el.getClientRects().length,
        ariaHidden: el.closest('[aria-hidden="true"]') !== null,
      };
    },
  };
})();
`;

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
  // Colour transitions would make every computed colour a function of WHEN it
  // is read — a hover or theme swap is still 90ms of interpolation after the
  // class lands. Freeze them; nothing below asserts a transition.
  await page.addStyleTag({ content: '*, *::before, *::after { transition-duration: 0s !important; }' });
  await page.addScriptTag({ content: PROBE_JS });
}

beforeAll(async () => {
  try { await boot(); } catch (err) {
    unavailable = err instanceof Error ? err.message : String(err);
  }
}, 120_000);
afterAll(async () => { await browser?.close(); });

/** Width of `#board`, with optional shell classes / checked pane switches. */
async function boardWidth(w: number, classes = '', checked: string[] = []): Promise<number> {
  await page!.setViewportSize({ width: w, height: 900 });
  await page!.evaluate(({ classes, checked }) => {
    const app = document.getElementById('app')!;
    app.className = `app ${classes}`.trim();
    for (const id of ['rail-hidden', 'rail-shown', 'inspector-hidden', 'inspector-shown']) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) { el.checked = checked.includes(id); }
    }
  }, { classes, checked });
  return page!.evaluate(() => document.getElementById('board')!.getBoundingClientRect().width);
}

describe('canvas shell layout (real browser)', () => {
  it('gives the board a usable width at every breakpoint', async () => {
    if (unavailable) { console.warn('[Mysti] skipping — Chromium unavailable:', unavailable); return; }
    const measured: Record<number, number> = {};
    for (const w of WIDTHS) { measured[w] = await boardWidth(w); }
    // Before the fix: 0 at every width <= 639.
    for (const w of WIDTHS) {
      expect(measured[w], `board width at panel width ${w}px (all: ${JSON.stringify(measured)})`).toBeGreaterThan(100);
    }
  }, 120_000);

  it('keeps the board visible when the user hides the pages rail', async () => {
    if (unavailable) { return; }
    // The `[` toggle. Before the fix this was 0px and the inspector took the space.
    expect(await boardWidth(1200, 'layout-wide rail-collapsed', ['rail-hidden'])).toBeGreaterThan(100);
    expect(await boardWidth(800, 'layout-medium rail-collapsed', ['rail-hidden'])).toBeGreaterThan(100);
  }, 120_000);

  it('keeps the board visible when the user hides the inspector', async () => {
    if (unavailable) { return; }
    expect(await boardWidth(1200, 'layout-wide inspector-collapsed', ['inspector-hidden'])).toBeGreaterThan(100);
  }, 120_000);

  it('keeps the board visible with BOTH side panes hidden', async () => {
    if (unavailable) { return; }
    const w = await boardWidth(1200, 'layout-wide rail-collapsed inspector-collapsed', ['rail-hidden', 'inspector-hidden']);
    expect(w).toBeGreaterThan(900);
  }, 120_000);

  it('never lets the page scroll sideways', async () => {
    if (unavailable) { return; }
    for (const w of [320, 640, 1400]) {
      await boardWidth(w);
      const overflow = await page!.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow at ${w}px`).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});

/* ══ THEME CORRECTNESS ═══════════════════════════════════════════════════════
 * VS Code stamps exactly one of four classes on <body> and injects one
 * `--vscode-*` custom property per theme colour. These palettes are the shipped
 * values of Light Modern / Dark Modern / High Contrast / High Contrast Light,
 * trimmed to the tokens `canvas.css` reads. A theme is deliberately allowed to
 * omit tokens (`--vscode-widget-shadow` does not exist in either high-contrast
 * theme) — that omission is what several of these defects were made of.
 */
const THEMES = {
  light: {
    cls: 'vscode-light',
    vars: {
      '--vscode-foreground': '#3b3b3b',
      '--vscode-descriptionForeground': '#717171',
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-editorWidget-background': '#f8f8f8',
      '--vscode-sideBar-background': '#f8f8f8',
      '--vscode-titleBar-activeBackground': '#f8f8f8',
      '--vscode-titleBar-activeForeground': '#1e1e1e',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-list-hoverBackground': '#e8e8e8',
      '--vscode-focusBorder': '#005fb8',
      '--vscode-badge-background': '#c4c4c4',
      '--vscode-badge-foreground': '#333333',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-widget-shadow': '#00000029',
    },
  },
  dark: {
    cls: 'vscode-dark',
    vars: {
      '--vscode-foreground': '#cccccc',
      '--vscode-descriptionForeground': '#9d9d9d',
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-editorWidget-background': '#202020',
      '--vscode-sideBar-background': '#181818',
      '--vscode-titleBar-activeBackground': '#181818',
      '--vscode-titleBar-activeForeground': '#cccccc',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-list-hoverBackground': '#2a2d2e',
      '--vscode-focusBorder': '#0078d4',
      '--vscode-badge-background': '#616161',
      '--vscode-badge-foreground': '#f8f8f8',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-widget-shadow': '#0000005c',
    },
  },
  // High contrast ships NO widget.shadow, which is why `--shadow-c` is forced
  // transparent for both — anything delimited only by a shadow disappears here.
  hcDark: {
    cls: 'vscode-high-contrast',
    vars: {
      '--vscode-foreground': '#ffffff',
      '--vscode-descriptionForeground': '#ffffff',
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-editorWidget-background': '#0c141f',
      '--vscode-sideBar-background': '#000000',
      '--vscode-titleBar-activeBackground': '#000000',
      '--vscode-contrastBorder': '#6fc3df',
      '--vscode-contrastActiveBorder': '#f38518',
      '--vscode-focusBorder': '#f38518',
      '--vscode-badge-background': '#000000',
      '--vscode-badge-foreground': '#ffffff',
      '--vscode-button-foreground': '#ffffff',
    },
  },
  hcLight: {
    cls: 'vscode-high-contrast vscode-high-contrast-light',
    vars: {
      '--vscode-foreground': '#292929',
      '--vscode-descriptionForeground': '#292929',
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#292929',
      '--vscode-editorWidget-background': '#ffffff',
      '--vscode-sideBar-background': '#ffffff',
      '--vscode-titleBar-activeBackground': '#ffffff',
      '--vscode-contrastBorder': '#0f4a85',
      '--vscode-contrastActiveBorder': '#0f4a85',
      '--vscode-focusBorder': '#0f4a85',
      '--vscode-badge-background': '#0f4a85',
      '--vscode-badge-foreground': '#ffffff',
      '--vscode-button-foreground': '#ffffff',
    },
  },
} as const;

type ThemeName = keyof typeof THEMES;
const ALL_THEMES = Object.keys(THEMES) as ThemeName[];
const HIGH_CONTRAST: ThemeName[] = ['hcDark', 'hcLight'];

/**
 * Paint the shell in one theme and seed the surfaces the JS modules normally
 * build (the shell ships their hosts empty). Idempotent.
 */
async function theme(name: ThemeName, width = 1200, extraVars: Record<string, string> = {}): Promise<void> {
  await page!.setViewportSize({ width, height: 900 });
  await page!.evaluate(({ cls, vars, extra }) => {
    document.body.className = cls;
    const root = document.documentElement;
    root.removeAttribute('style');
    for (const [k, v] of Object.entries({ ...vars, ...extra })) { root.style.setProperty(k, v); }

    const app = document.getElementById('app')!;
    app.className = 'app';
    for (const id of ['rail-hidden', 'rail-shown', 'inspector-hidden', 'inspector-shown']) {
      (document.getElementById(id) as HTMLInputElement).checked = false;
    }

    const add = (host: string, cls2: string, tag = 'div', text = ''): HTMLElement => {
      const existing = document.querySelector(`.${cls2.split(' ')[0]}`) as HTMLElement | null;
      if (existing) { return existing; }
      const el = document.createElement(tag);
      el.className = cls2;
      if (text) { el.textContent = text; }
      document.getElementById(host)!.appendChild(el);
      return el;
    };
    // An artboard on the board: the object the whole panel exists to show.
    if (!document.querySelector('.artboard')) {
      const art = document.createElement('div');
      art.className = 'artboard';
      const surface = document.createElement('div');
      surface.className = 'artboard-surface';
      surface.style.width = '320px';
      surface.style.height = '200px';
      art.appendChild(surface);
      document.getElementById('page-stage')!.appendChild(art);
    }
    add('capability-chips', 'chip', 'span', 'Gmail');
    if (!document.querySelector('.thumb')) {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const meta = document.createElement('div');
      meta.className = 'thumb-meta';
      const title = document.createElement('span');
      title.className = 'thumb-title';
      title.textContent = 'Home';
      const badge = document.createElement('span');
      badge.className = 'thumb-badge device';
      badge.textContent = 'Desktop';
      meta.appendChild(title); meta.appendChild(badge); thumb.appendChild(meta);
      document.getElementById('rail-list')!.appendChild(thumb);
    }
    if (!document.querySelector('.ctl')) {
      const ctl = document.createElement('div');
      ctl.className = 'ctl';
      const label = document.createElement('span');
      label.className = 'ctl-label';
      label.textContent = 'Padding';
      const note = document.createElement('span');
      note.className = 'ctl-note';
      note.textContent = 'Applies to all sides';
      ctl.appendChild(label); ctl.appendChild(note);
      document.getElementById('insp-body')!.appendChild(ctl);
    }
    add('agent-status', 'agent-progress');
    add('board-overlay', 'agent-cursor-label', 'div', 'Mysti · heading');
    add('history-toolbar', 'history-btn undo', 'button', 'Undo');
    const activity = document.getElementById('agent-activity')!;
    activity.hidden = false;
    activity.textContent = 'Mysti is editing Home';
    document.getElementById('agent-status')!.setAttribute('data-state', 'working');
  }, { cls: THEMES[name].cls, vars: THEMES[name].vars as Record<string, string>, extra: extraVars });
}

/**
 * Walk focus with real Tab presses until `id` has it. `blur()` alone will not
 * do: it clears `activeElement` but leaves the sequential-navigation starting
 * point where it was, so the next Tab resumes from there.
 */
async function tabTo(id: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const at = await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? '');
    if (at === id) { return true; }
    await page!.keyboard.press('Tab');
  }
  return false;
}

const probe = <T>(fn: string, ...args: unknown[]): Promise<T> =>
  page!.evaluate(({ fn, args }) => (window as unknown as { __probe: Record<string, (...a: unknown[]) => unknown> }).__probe[fn](...args) as T, { fn, args });

describe('canvas theme correctness (real browser, per VS Code theme class)', () => {
  it('CV-T2 · delimits every artboard from the board, with shadows forced off', async () => {
    if (unavailable) { return; }
    const seen: Record<string, unknown> = {};
    for (const name of ALL_THEMES) {
      await theme(name);
      const edge = await probe<{ paperVsGround: number; edgeVsPaper: number; edgeVsGround: number; shadowAlpha: number; outlineStyle: string }>('edge', '.artboard-surface');
      seen[name] = edge;
      // The artboard is visible if ANY of these separates it: its own paper
      // against the board, a real edge, or a shadow the theme still allows.
      const delimited = edge.paperVsGround >= 3 || edge.edgeVsPaper >= 3 || edge.edgeVsGround >= 3 || edge.shadowAlpha > 0.05;
      expect(delimited, `artboard has no boundary in ${name}: ${JSON.stringify(seen)}`).toBe(true);
    }
    // …and in high contrast it must not be the shadow doing the work: VS Code
    // forces `--shadow-c: transparent` there, so a real edge is required.
    for (const name of HIGH_CONTRAST) {
      await theme(name);
      const edge = await probe<{ outlineStyle: string; borderStyle: string; edgeVsPaper: number; edgeVsGround: number }>('edge', '.artboard-surface');
      expect(edge.outlineStyle !== 'none' || edge.borderStyle !== 'none', `no artboard edge in ${name}: ${JSON.stringify(edge)}`).toBe(true);
      expect(Math.max(edge.edgeVsPaper, edge.edgeVsGround), `artboard edge invisible in ${name}: ${JSON.stringify(edge)}`).toBeGreaterThanOrEqual(3);
    }
  }, 120_000);

  it('CV-T3 · keeps quiet UI text above the contrast floor in every theme', async () => {
    if (unavailable) { return; }
    // Each of these is real, non-decorative text: the capability chips, the
    // device badge on every rail row, and the inspector's help line.
    const targets = ['.chip', '.thumb-badge', '.ctl-note'];
    const measured: Record<string, { ratio: number; fg: number[]; bg: number[] }> = {};
    for (const name of ALL_THEMES) {
      await theme(name);
      for (const sel of targets) {
        measured[`${name} ${sel}`] = await probe<{ ratio: number; fg: number[]; bg: number[] }>('text', sel);
      }
    }
    const failing = Object.entries(measured).filter(([, m]) => m.ratio < 3.5).map(([k, m]) => `${k} = ${m.ratio}`);
    expect(failing, `low-contrast text: ${JSON.stringify(measured, null, 1)}`).toEqual([]);
  }, 120_000);

  it('CV-T4 · still answers a hover in high contrast, where fills are switched off', async () => {
    if (unavailable) { return; }
    for (const name of HIGH_CONTRAST) {
      await theme(name);
      for (const sel of ['.history-btn', '#btn-zoom-in']) {
        await page!.hover(sel);
        const fb = await probe<{ fillRatio: number; outlineRatio: number; borderRatio: number; outlineStyle: string }>('feedback', sel);
        await page!.mouse.move(0, 0);
        const visible = Math.max(fb.fillRatio, fb.outlineRatio, fb.borderRatio);
        expect(visible, `${sel} gives no hover feedback in ${name}: ${JSON.stringify(fb)}`).toBeGreaterThanOrEqual(3);
      }
      // …and the hover treatment must not eat the neighbouring affordance it
      // shares a property with: a control that is BOTH focused and hovered
      // keeps its 2px solid focus ring, not the 1px dashed hover outline. Both
      // shapes are checked — the button wears its own ring, the pane switch
      // wears the ring of the input it wraps (`:has(> input:focus-visible)`).
      for (const [focusId, hoverSel] of [['btn-export', '#btn-export'], ['rail-hidden', '.pane-toggle-hide-rail']]) {
        expect(await tabTo(focusId), `could not tab to #${focusId} in ${name}`).toBe(true);
        await page!.hover(hoverSel);
        const ring = await probe<Record<string, string>>('style', hoverSel, ['outline-style', 'outline-width']);
        await page!.mouse.move(0, 0);
        expect(ring['outline-style'], `hover outranked ${hoverSel}'s focus ring in ${name}`).toBe('solid');
        expect(ring['outline-width'], `hover outranked ${hoverSel}'s focus ring in ${name}`).toBe('2px');
      }
    }
  }, 120_000);

  it('R3-4 · a hover never outranks the SELECTION ring in high contrast', async () => {
    if (unavailable) { return; }
    // The hover treatment added for CV-T4 is (0,5,1); the high-contrast
    // selection ring on `.thumb.active` / `.insp-tab.active` is (0,2,1) and
    // loses, so hovering the page currently open on the board swapped its SOLID
    // ring for a DASHED one in the identical colour and width — while the
    // pointer was over it there was no way to tell the open page from any other
    // hovered page. The rule's two guards protect focus, not selection.
    for (const name of HIGH_CONTRAST) {
      await theme(name);
      await page!.evaluate(() => {
        const tabs = document.getElementById('insp-tabs')!;
        tabs.hidden = false;
        if (!document.getElementById('probe-insp-tab')) {
          const tab = document.createElement('button');
          tab.type = 'button';
          tab.id = 'probe-insp-tab';
          tab.className = 'insp-tab active';
          tab.textContent = 'Design';
          tabs.appendChild(tab);
        }
        if (!document.getElementById('probe-thumb-active')) {
          const row = document.createElement('div');
          row.id = 'probe-thumb-active';
          row.className = 'thumb active';
          const meta = document.createElement('div');
          meta.className = 'thumb-meta';
          meta.textContent = 'Home';
          row.appendChild(meta);
          document.getElementById('rail-list')!.appendChild(row);
        }
      });
      for (const sel of ['#probe-thumb-active', '#probe-insp-tab']) {
        const props = ['outline-style', 'outline-width'];
        const idle = await probe<Record<string, string>>('style', sel, props);
        expect(idle['outline-style'], `${sel} carries no selection ring in ${name}`).toBe('solid');
        await page!.hover(sel);
        const hovered = await probe<Record<string, string>>('style', sel, props);
        await page!.mouse.move(0, 0);
        expect(hovered['outline-style'],
          `hover turned ${sel}'s selection ring dashed in ${name}: ${JSON.stringify(hovered)}`).toBe('solid');
        // …and it must still ANSWER the pointer rather than going silent, which
        // is what a bare `:not(.active)` exclusion would have cost.
        expect(hovered['outline-width'],
          `${sel} gives no hover feedback at all in ${name}`).not.toBe(idle['outline-width']);
      }
    }
    await page!.evaluate(() => {
      document.getElementById('probe-thumb-active')?.remove();
      document.getElementById('probe-insp-tab')?.remove();
      document.getElementById('insp-tabs')!.hidden = true;
    });
  }, 120_000);

  it('CV-T4 · keeps the progress track visible when --bg-hover is transparent', async () => {
    if (unavailable) { return; }
    for (const name of HIGH_CONTRAST) {
      await theme(name);
      const fb = await probe<{ fillRatio: number; borderRatio: number; outlineRatio: number }>('feedback', '.agent-progress');
      const visible = Math.max(fb.fillRatio, fb.borderRatio, fb.outlineRatio);
      expect(visible, `the determinate progress track vanishes in ${name}: ${JSON.stringify(fb)}`).toBeGreaterThanOrEqual(3);
    }
  }, 120_000);

  it('CV-T5 · dims the board behind an overlay pane in every theme', async () => {
    if (unavailable) { return; }
    const measured: Record<string, unknown> = {};
    for (const name of ALL_THEMES) {
      await theme(name, 500);                       // narrow: the rail is an overlay
      await page!.evaluate(() => { (document.getElementById('rail-shown') as HTMLInputElement).checked = true; });
      // Measured against the ARTBOARD's paper, which is the one surface that is
      // the same colour in every theme — so this asks the honest question ("is
      // the board visibly dimmed?") rather than a theme-dependent one.
      const wash = await probe<{ display: string; ratio: number; alpha: number }>('wash', '.pane-scrim-rail', '.artboard-surface');
      measured[name] = wash;
      expect(wash.display, `scrim not rendered in ${name}`).not.toBe('none');
      // The scrim eats every pointer event on the board, so it MUST be visible.
      expect(wash.ratio, `invisible scrim in ${name}: ${JSON.stringify(measured)}`).toBeGreaterThanOrEqual(1.25);
    }
  }, 120_000);

  it('CV-T6 · pairs the top bar background with a foreground guaranteed against it', async () => {
    if (unavailable) { return; }
    const targets = ['.brand', '#artifact-name', '#btn-export'];
    const measured: Record<string, number> = {};
    for (const name of ALL_THEMES) {
      await theme(name);
      for (const sel of targets) { measured[`${name} ${sel}`] = (await probe<{ ratio: number }>('text', sel)).ratio; }
    }
    // A theme that gives the title bar its own identity (accent-coloured or
    // inverted) decouples titleBar.activeBackground from `foreground`; the
    // shell must not be drawing one against the other.
    await theme('light', 1200, { '--vscode-titleBar-activeBackground': '#1f1f1f', '--vscode-titleBar-activeForeground': '#ffffff' });
    for (const sel of targets) { measured[`decoupled-titlebar ${sel}`] = (await probe<{ ratio: number }>('text', sel)).ratio; }

    const failing = Object.entries(measured).filter(([, r]) => r < 4.5);
    expect(failing, `top-bar text below 4.5:1 — ${JSON.stringify(measured, null, 1)}`).toEqual([]);
  }, 120_000);

  it('CV-T7 · draws the agent cursor label with a guaranteed colour pair', async () => {
    if (unavailable) { return; }
    const measured: Record<string, number> = {};
    for (const name of ALL_THEMES) {
      await theme(name);
      measured[name] = (await probe<{ ratio: number }>('text', '.agent-cursor-label')).ratio;
    }
    // High-contrast dark makes `--accent` a bright orange while button.foreground
    // stays white: 2.6:1 on the one label that says WHICH element is being
    // rewritten.
    const failing = Object.entries(measured).filter(([, r]) => r < 4.5);
    expect(failing, `agent cursor label below 4.5:1 — ${JSON.stringify(measured)}`).toEqual([]);
  }, 120_000);

  it('SYNC-4 · pulses the status dot only while the agent is actually working', async () => {
    if (unavailable) { return; }
    await theme('dark');
    const animationFor = async (state: string): Promise<string> => {
      await page!.evaluate(s => { document.getElementById('agent-status')!.setAttribute('data-state', s); }, state);
      return (await probe<Record<string, string>>('style', '.agent-dot', ['animation-name', 'display']))['animation-name'];
    };
    expect(await animationFor('working')).toBe('pulse');
    for (const state of ['idle', 'review', 'offline']) {
      expect(await animationFor(state), `the dot still pulses at data-state="${state}"`).toBe('none');
    }
    // The reduced-motion opt-out has to beat the state rule too.
    await page!.evaluate(() => {
      document.getElementById('agent-status')!.setAttribute('data-state', 'working');
      document.getElementById('agent-status')!.setAttribute('data-motion', 'reduced');
    });
    expect((await probe<Record<string, string>>('style', '.agent-dot', ['animation-name']))['animation-name']).toBe('none');
    await page!.evaluate(() => { document.getElementById('agent-status')!.removeAttribute('data-motion'); });
  }, 120_000);

  it('A11Y-7 · leaves an overlay pane closable by keyboard, and announces no empty control', async () => {
    if (unavailable) { return; }
    await theme('dark', 500);                        // narrow: both panes are overlays
    await page!.evaluate(() => { (document.getElementById('rail-shown') as HTMLInputElement).checked = true; });

    // The in-pane × is a `<label for=…>`: clickable, but never focusable and
    // with no text of its own. It must therefore not be offered to assistive
    // tech as a control — it is a pointer shortcut for the switch below.
    for (const sel of ['.pane-close-rail', '.pane-close-insp']) {
      const state = await probe<{ focused: boolean; rendered: boolean; ariaHidden: boolean }>('reachable', sel);
      expect(state.focused, `${sel} is a <label>; it cannot take focus`).toBe(false);
      expect(state.ariaHidden, `${sel} is announced as an unnamed, unreachable node`).toBe(true);
    }
    // …and the keyboard path it shadows is rendered and focusable at this width.
    const sw = await probe<{ focused: boolean; ariaHidden: boolean }>('reachable', '#rail-shown');
    expect(sw.focused).toBe(true);
    expect(sw.ariaHidden).toBe(false);
    const toggle = await probe<Record<string, string>>('style', '.pane-toggle-show-rail', ['display']);
    expect(toggle.display, 'no keyboard-reachable way to close the rail overlay').not.toBe('none');
  }, 120_000);
});

/** Bounding width of an element, with shell classes / checked pane switches. */
async function paneWidth(id: string, w: number, classes = '', checked: string[] = []): Promise<number> {
  await page!.setViewportSize({ width: w, height: 900 });
  await page!.evaluate(({ classes, checked }) => {
    const app = document.getElementById('app')!;
    app.className = `app ${classes}`.trim();
    for (const s of ['rail-hidden', 'rail-shown', 'inspector-hidden', 'inspector-shown']) {
      const el = document.getElementById(s) as HTMLInputElement | null;
      if (el) { el.checked = checked.includes(s); }
    }
  }, { classes, checked });
  return page!.evaluate(i => document.getElementById(i)!.getBoundingClientRect().width, id);
}

describe('overlay panes are actually usable (R3-1)', () => {
  // The regression from the R1 fix: `.inspector { grid-column: 3 }` gave the
  // ABS-POS overlay a containing block from its grid AREA, and `--insp-track`
  // is 0px in exactly those modes — so `width: min(340px, 86%)` resolved 86% of
  // zero and the inspector was a 1px sliver of border, while its scrim still
  // covered the board and ate every click. The old suite measured only #board
  // and the scrim's display, so it was blind to this.
  it('opens the inspector to a real width at every overlay breakpoint', async () => {
    if (unavailable) { return; }
    for (const w of [380, 500, 639, 700, 800, 959]) {
      const width = await paneWidth('inspector', w, '', ['inspector-shown']);
      expect(width, `inspector overlay width at ${w}px`).toBeGreaterThan(200);
    }
  }, 120_000);

  it('opens the rail to a real width at narrow widths', async () => {
    if (unavailable) { return; }
    for (const w of [380, 500, 639]) {
      const width = await paneWidth('pages-rail', w, '', ['rail-shown']);
      expect(width, `rail overlay width at ${w}px`).toBeGreaterThan(160);
    }
  }, 120_000);

  it('does NOT let a docked pane span the whole grid', async () => {
    if (unavailable) { return; }
    // The naive fix (a bare `grid-column: 1 / -1` on the :has() rules) made the
    // DOCKED rail 700-959px wide at medium and wide widths.
    for (const [w, cls] of [[1200, 'layout-wide'], [800, 'layout-medium']] as Array<[number, string]>) {
      const rail = await paneWidth('pages-rail', w, cls, []);
      expect(rail, `docked rail width at ${w}px`).toBeLessThan(300);
      expect(rail, `docked rail present at ${w}px`).toBeGreaterThan(100);
    }
  }, 120_000);

  it('keeps the board usable while an overlay pane is open', async () => {
    if (unavailable) { return; }
    expect(await paneWidth('board', 800, '', ['inspector-shown'])).toBeGreaterThan(100);
  }, 120_000);
});

describe('board interaction affordances', () => {
  // Frame rate was never the problem — the board holds 60fps with 8 live
  // frames. What was missing is the FEEDBACK that makes an interaction feel
  // responsive: the board had no cursor rule of any kind, so pan was both
  // undiscoverable and unconfirmed.
  it('shows a grab cursor when space is held, and grabbing while panning', async () => {
    if (unavailable) { return; }
    await page!.setViewportSize({ width: 1400, height: 900 });
    const cursors = await page!.evaluate(() => {
      const el = document.getElementById('board-scroll')!;
      const read = () => getComputedStyle(el).cursor;
      const idle = read();
      el.classList.add('can-pan');
      const held = read();
      el.classList.remove('can-pan'); el.classList.add('panning');
      const dragging = read();
      el.classList.remove('panning');
      return { idle, held, dragging };
    });
    expect(cursors.idle).toBe('default');
    expect(cursors.held, 'space-held must offer a grab cursor').toBe('grab');
    expect(cursors.dragging, 'an active pan must show grabbing').toBe('grabbing');
  }, 120_000);
});
