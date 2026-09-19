/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 — `app.ts`'s FOCUS behaviour, measured in a real browser.
 *
 * Sibling of `canvasLayoutBrowser.test.ts`, and for the same reason: the fake
 * DOM the rest of the webview suite drives has no focus model at all — no
 * `activeElement`, no `focus()`, no `focusout`, no tab order. It can prove that
 * `app.ts` DECIDED to defer a repaint; it cannot prove that a person's caret
 * survived one. These four defects are all about what the keyboard does, so
 * they are asserted where the keyboard is real.
 *
 * Unlike that file, this one also loads the real MODULE graph: `app.ts` is
 * bundled with esbuild (already a dependency, via vite) and started against
 * `realEnv()` inside the page, so what is measured is the shipped wiring rather
 * than a re-statement of it. The runtime fetch is made to fail on purpose, which
 * keeps every artboard a static preview — no iframes, no timing — and doubles as
 * the check that a failed fetch is actually REPORTED (CANVAS-W6).
 *
 * Covers: A11Y-4 (an agent op destroying focus and in-progress typing),
 * A11Y-6 (the template disclosure's state and keyboard exit), CANVAS-W6.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import type { WireArtifact } from '../../src/canvas/protocol';
import type { ArtifactPage } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';

const ROOT = path.resolve(__dirname, '../..');
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const HEADING = 'aaaaaaaaaa';
const STACK = 'cccccccccc';

let browser: Browser | undefined;
let page: Page | undefined;
let bundle = '';

function pageFixture(id: string, x: number, title: string): ArtifactPage {
  return {
    id, version: 2, boardPos: { x, y: 0 }, actionTitle: title,
    doc: {
      mid: 'root000000', tag: 'UI.Screen', children: [
        { mid: HEADING, tag: 'UI.Heading', text: 'Welcome' },
        { mid: STACK, tag: 'UI.Stack', props: { gap: 12 } },
      ],
    },
  };
}

function artifact(): WireArtifact {
  return {
    id: 'art1', version: 7, kind: 'screens', name: 'Acme',
    format: getFormat('desktop')!, theme: getThemePreset('clean-saas')!.theme,
    pages: [pageFixture('p1', 0, 'Login'), pageFixture('p2', 1600, 'Home')],
    assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

/** The shipped boot payload, minus a reachable runtime (see the module note). */
function boot(): Record<string, unknown> {
  const desktop = getFormat('desktop')!;
  return {
    viewToken: TOKEN,
    runtimeUris: ['./missing-runtime.js'], harnessUri: '', babelUri: '', innerCsp: '',
    devices: [{
      formatId: desktop.formatId, width: desktop.width, height: desktop.height,
      kind: desktop.kind, label: 'Desktop',
    }],
    themes: [],
    scaffolds: [
      { id: 'login', name: 'Login', description: 'Email + password' },
      { id: 'dashboard', name: 'Dashboard', description: 'Sidebar + stats' },
    ],
  };
}

/** `src/webview/canvas/app.ts` and its whole graph, as one browser script. */
async function buildBundle(): Promise<string> {
  const { build } = await import('esbuild');
  const result = await build({
    stdin: {
      contents: `
        import { CanvasApp } from './src/webview/canvas/app';
        import { realEnv } from './src/webview/canvas/dom';
        export function start(boot) {
          const env = realEnv();
          // Every runtime fetch fails: artboards stay static previews, so the
          // page has no iframes and no async settling to race against.
          const offline = { ...env, fetchText: () => Promise.reject(new Error('offline')) };
          const app = new CanvasApp({ boot, env: offline, post: m => { window.__posted.push(m); } });
          window.__posted = [];
          app.start();
          return app;
        }
      `,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'canvasAppBrowserDriver.ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'MystiCanvasApp',
    platform: 'browser', target: 'es2020', logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function bootPage(): Promise<void> {
  const { chromium } = await import('playwright');
  bundle = await buildBundle();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  const css = fs.readFileSync(path.join(ROOT, 'media/canvas/canvas.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'media/canvas/index.html'), 'utf8')
    .replace('{{cspMeta}}', '')
    .replace('<link rel="stylesheet" href="{{cssUri}}">', `<style>${css}</style>`)
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace('{{boot}}', '')
    .replace(/<script[^>]*src="\{\{jsUri\}\}"[^>]*><\/script>/, '');
  await page.setContent(html, { waitUntil: 'load' });
}

/** A fresh app over a fresh shell, so no test inherits another's focus. */
async function freshApp(): Promise<void> {
  const css = fs.readFileSync(path.join(ROOT, 'media/canvas/canvas.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'media/canvas/index.html'), 'utf8')
    .replace('{{cspMeta}}', '')
    .replace('<link rel="stylesheet" href="{{cssUri}}">', `<style>${css}</style>`)
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace('{{boot}}', '')
    .replace(/<script[^>]*src="\{\{jsUri\}\}"[^>]*><\/script>/, '');
  await page!.setContent(html, { waitUntil: 'load' });
  await page!.addScriptTag({ content: bundle });
  await page!.evaluate(b => {
    (window as unknown as { __app: unknown }).__app =
      (window as unknown as { MystiCanvasApp: { start(b: unknown): unknown } }).MystiCanvasApp.start(b);
  }, boot());
  await page!.evaluate(([art, token]) => {
    window.postMessage(
      { t: 'canvas/hello', artifactId: 'art1', artifact: art, viewToken: token, caps: [] },
      '*',
    );
  }, [artifact(), TOKEN] as [WireArtifact, string]);
  // One turn for the `message` event, one for the runtime rejection.
  await page!.waitForTimeout(50);
}

/** One committed agent op, delivered exactly as `CanvasBridge` pushes it. */
async function agentOp(text = 'Rewritten by the agent'): Promise<void> {
  await page!.evaluate(t => {
    window.postMessage({
      t: 'canvas/ops',
      records: [{
        opId: 'o8', txnId: 't8', runId: 'r1', author: 'agent', actorId: 'mysti',
        op: { op: 'el.setText', pageId: 'p1', mid: 'aaaaaaaaaa', text: t },
        status: 'applied', ts: 0,
      }],
      artifactVersion: 8,
    }, '*');
  }, text);
  await page!.waitForTimeout(30);
}

/* ═══════════ R4-3 — `\` must not stack two overlay panes ═══════════
 * Measured against the REAL app, at a real width, with the shipped stylesheet:
 * below the medium breakpoint both panes are `position:absolute` overlays
 * pinned to opposite edges of the same grid area at the same `z-index`, and
 * their widths (`min(280px,82%)` + `min(340px,86%)`) exceed the panel. The
 * later element in DOM order wins, so opening both left the rail rendered and
 * almost entirely unclickable.
 */
describe('overlay panes at narrow widths (real browser)', () => {
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    await bootPage();
  }, 180_000);
  afterAll(async () => { await browser?.close(); browser = undefined; });

  /** Open the panes with `\` at `width`, then measure what is actually hittable. */
  async function pressBackslash(width: number): Promise<{
    mode: string; rail: boolean; inspector: boolean; railCentreOwner: string; railWidth: number;
  }> {
    await freshApp();
    await page!.setViewportSize({ width, height: 900 });
    // The shortcut depends on the CURRENT responsive mode. A fixed delay can
    // send it while the old wide panes are still open, closing them just before
    // the delayed ResizeObserver finally publishes the narrow layout.
    await page!.waitForFunction(
      () => document.getElementById('app')?.classList.contains('layout-narrow'),
      undefined, { timeout: 5_000 },
    );
    await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page!.keyboard.press('Backslash');
    await page!.waitForTimeout(120);
    return page!.evaluate(() => {
      const checked = (id: string): boolean =>
        (document.getElementById(id) as HTMLInputElement | null)?.checked === true;
      const rail = document.getElementById('pages-rail')!;
      const box = rail.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const owner = hit?.closest('#pages-rail') ? 'rail'
        : hit?.closest('#inspector') ? 'inspector'
          : (hit as HTMLElement | null)?.id || (hit?.className ?? 'none');
      return {
        mode: document.getElementById('app')!.className,
        rail: checked('rail-shown'),
        inspector: checked('inspector-shown'),
        railCentreOwner: String(owner),
        railWidth: box.width,
      };
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('R4-3 · opens at most one overlay pane, and it is actually clickable', async () => {
    for (const width of [320, 360, 400]) {
      const state = await pressBackslash(width);
      expect(state.mode, `layout at ${width}px`).toContain('layout-narrow');
      // The shortcut still does something...
      expect(state.rail || state.inspector, `\\ opened nothing at ${width}px`).toBe(true);
      // ...but never two modal overlays over the same grid area. Before the fix
      // both opened and the inspector — later in DOM order, same z-index —
      // buried all but the leftmost ~60px of the 280px rail.
      expect(
        state.rail && state.inspector,
        `both overlay panes opened at ${width}px`,
      ).toBe(false);
      if (state.rail) {
        expect(state.railWidth, `rail overlay width at ${width}px`).toBeGreaterThan(160);
        expect(
          state.railCentreOwner,
          `the rail's own centre belongs to "${state.railCentreOwner}" at ${width}px`,
        ).toBe('rail');
      }
    }
  }, 180_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('R4-3 · still opens BOTH panes where they are docked columns', async () => {
    // At wide widths the panes are columns, not overlays: nothing collides, so
    // `\` keeps its documented "show/hide both" meaning.
    await freshApp();
    await page!.setViewportSize({ width: 1400, height: 900 });
    await page!.waitForTimeout(120);
    await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // Start from both hidden so the press is an OPEN.
    await page!.keyboard.press('Backslash');
    await page!.waitForTimeout(80);
    await page!.keyboard.press('Backslash');
    await page!.waitForTimeout(120);
    const state = await page!.evaluate(() => ({
      mode: document.getElementById('app')!.className,
      railHidden: (document.getElementById('rail-hidden') as HTMLInputElement).checked,
      inspectorHidden: (document.getElementById('inspector-hidden') as HTMLInputElement).checked,
    }));
    expect(state.mode).toContain('layout-wide');
    expect(state.railHidden, 'the docked rail stayed collapsed').toBe(false);
    expect(state.inspectorHidden, 'the docked inspector stayed collapsed').toBe(false);
  }, 180_000);
});

describe('canvas app focus (real browser)', () => {
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    await bootPage();
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  /* ───────── A11Y-4 — an agent op must not take the keyboard ───────── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('A11Y-4 · keeps the focused rail row focused across an agent op', async () => {
    await freshApp();

    const before = await page!.evaluate(() => {
      const row = document.querySelector('#rail-list .thumb') as HTMLElement | null;
      row?.focus();
      return document.activeElement?.getAttribute('data-id') ?? null;
    });
    expect(before, 'a rail row can take focus at all').toBe('p1');

    await agentOp();

    // Before the fix `RailController.render` replaced every row, so focus fell
    // to <body> — and the next arrow key nudged the selected ELEMENT instead.
    expect(await page!.evaluate(() => document.activeElement?.getAttribute('data-id') ?? null)).toBe('p1');
    expect(await page!.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
  }, 120_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('A11Y-4 · keeps a half-typed inspector value and its caret', async () => {
    await freshApp();
    await page!.evaluate(() => {
      (window as unknown as { __app: { board: { select(p: string, m: string[]): void } } })
        .__app.board.select('p1', ['cccccccccc']);
    });

    const typed = await page!.evaluate(() => {
      const input = document.querySelector('#insp-body input.ctl-input') as HTMLInputElement | null;
      if (!input) { return null; }
      input.focus();
      return input.className;
    });
    expect(typed, 'the inspector generated a control for the selection').not.toBeNull();
    // Real keystrokes into the focused control. The inspector commits on
    // `change`, so at this point the value exists ONLY in the live element.
    await page!.keyboard.type('24');
    const draft = await page!.evaluate(() => (document.activeElement as HTMLInputElement).value);

    await agentOp();

    const after = await page!.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | null;
      return {
        tag: active?.tagName ?? '',
        cls: active?.className ?? '',
        value: active?.value ?? '',
        connected: !!active?.isConnected,
      };
    });
    expect(after.tag).toBe('INPUT');
    expect(after.cls).toContain('ctl-input');
    expect(after.value).toBe(draft);
    expect(after.connected).toBe(true);
  }, 120_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('A11Y-4 · repaints the inspector from the store once focus leaves it', async () => {
    await freshApp();
    await page!.evaluate(() => {
      (window as unknown as { __app: { board: { select(p: string, m: string[]): void } } })
        .__app.board.select('p1', ['cccccccccc']);
    });
    const stamped = await page!.evaluate(() => {
      const input = document.querySelector('#insp-body input.ctl-input') as HTMLInputElement | null;
      if (!input) { return false; }
      input.focus();
      input.setAttribute('data-stale-marker', '1');
      return true;
    });
    expect(stamped).toBe(true);

    await agentOp();
    // Still the same element: the repaint was withheld, not skipped.
    expect(await page!.evaluate(() => !!document.querySelector('#insp-body [data-stale-marker]'))).toBe(true);

    await page!.evaluate(() => { (document.activeElement as HTMLElement).blur(); });
    await page!.waitForTimeout(20);
    expect(
      await page!.evaluate(() => !!document.querySelector('#insp-body [data-stale-marker]')),
      'the deferred repaint ran on blur',
    ).toBe(false);
    expect(await page!.evaluate(() => !!document.querySelector('#insp-body .ctl'))).toBe(true);
  }, 120_000);

  /* ───────── A11Y-6 — the template disclosure ───────── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('A11Y-6 · announces its state, takes focus, and gives it back on Escape', async () => {
    await freshApp();

    expect(await page!.getAttribute('#btn-add-page', 'aria-expanded')).toBe('false');
    await page!.click('#btn-add-page');

    expect(await page!.getAttribute('#btn-add-page', 'aria-expanded')).toBe('true');
    expect(await page!.evaluate(() => document.getElementById('scaffold-menu')!.hidden)).toBe(false);
    // A menu that opens and leaves focus behind is a menu a keyboard user has
    // to go hunting for.
    expect(await page!.evaluate(() => document.activeElement?.className ?? '')).toBe('sm-item');

    await page!.keyboard.press('Escape');
    expect(await page!.evaluate(() => document.getElementById('scaffold-menu')!.hidden)).toBe(true);
    expect(await page!.getAttribute('#btn-add-page', 'aria-expanded')).toBe('false');
    expect(await page!.evaluate(() => document.activeElement?.id ?? '')).toBe('btn-add-page');
  }, 120_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('A11Y-6 · returns focus to the button when a template is chosen', async () => {
    await freshApp();
    await page!.click('#btn-add-page');
    await page!.click('#scaffold-menu .sm-item');

    expect(await page!.evaluate(() => document.getElementById('scaffold-menu')!.hidden)).toBe(true);
    expect(await page!.evaluate(() => document.activeElement?.id ?? '')).toBe('btn-add-page');
    expect(await page!.evaluate(
      () => (window as unknown as { __posted: Array<{ t: string }> }).__posted.some(m => m.t === 'canvas/addScaffold'),
    )).toBe(true);
  }, 120_000);

  /* ───────── SYNC-8 / CANVAS-W5 — cues that have to survive the cascade ───────── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('SYNC-8 · shows a visible, non-colour difference between on and off chips', async () => {
    await freshApp();
    await page!.evaluate(() => {
      window.postMessage({
        t: 'canvas/caps',
        caps: [
          { slug: 'image', label: 'fal.ai', enabled: false, source: 'off' },
          { slug: 'figma', label: 'Figma', enabled: true, source: 'deepmyst' },
        ],
      }, '*');
    });
    await page!.waitForTimeout(20);

    // The chips describe the AGENT, so they sit beside it in the Activity tab
    // rather than in the top bar, where their only explanation was a `title`
    // on the container they shared. The cue still has to be DRAWN, which is
    // what this test is for — so open the tab that holds them.
    await page!.click('#tab-activity');
    await page!.waitForTimeout(20);

    const chips = await page!.evaluate(() => [...document.querySelectorAll('#capability-chips .chip')]
      .map(chip => {
        const mark = chip.querySelector('.chip-mark') as HTMLElement | null;
        return {
          name: chip.getAttribute('aria-label'),
          glyph: mark?.textContent ?? '',
          markShown: !!mark && getComputedStyle(mark).display !== 'none',
          width: chip.getBoundingClientRect().width,
        };
      }));
    expect(chips).toHaveLength(2);
    expect(chips[0].name).toBe('fal.ai — not connected');
    expect(chips[1].name).toBe('Figma — connected');
    // The cue is drawn, not merely present in the DOM.
    expect(chips[0].markShown).toBe(true);
    expect(chips[1].markShown).toBe(true);
    expect(chips[0].glyph).not.toBe(chips[1].glyph);
    expect(chips[0].width).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('CANVAS-W5 · draws an “Ask Mysti” the stylesheet actually shows', async () => {
    await freshApp();
    await page!.evaluate(() => {
      (window as unknown as { __app: { board: { select(p: string, m: string[]): void } } })
        .__app.board.select('p1', ['aaaaaaaaaa']);
    });

    const ask = await page!.evaluate(() => {
      const el = document.querySelector('#insp-body .insp-ask') as HTMLElement | null;
      if (!el) { return null; }
      const rect = el.getBoundingClientRect();
      return { label: el.getAttribute('aria-label'), w: rect.width, h: rect.height };
    });
    expect(ask, 'the seam is wired AND the button is in the shipped inspector').not.toBeNull();
    expect(ask!.w).toBeGreaterThan(0);
    expect(ask!.h).toBeGreaterThan(0);
    expect(ask!.label ?? '').toContain('Ask Mysti');
  }, 120_000);

  /* ───────── CANVAS-W6 — the alert region the shell ships ───────── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('CANVAS-W6 · shows a failed runtime fetch on screen, not only in the console', async () => {
    await freshApp();

    const banner = await page!.evaluate(() => {
      const el = document.getElementById('board-error')!;
      const rect = el.getBoundingClientRect();
      return {
        hidden: el.hidden,
        visible: rect.width > 0 && rect.height > 0,
        role: el.getAttribute('role'),
        text: document.getElementById('board-error-text')!.textContent ?? '',
      };
    });
    expect(banner.hidden).toBe(false);
    expect(banner.visible, 'the banner has real geometry, not just hidden=false').toBe(true);
    expect(banner.role).toBe('alert');
    expect(banner.text).toContain('static previews');
  }, 120_000);
});
