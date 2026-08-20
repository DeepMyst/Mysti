/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 — the agent-status surface, measured in a real browser.
 *
 * Third sibling of `canvasLayoutBrowser.test.ts` and `canvasAppBrowser.test.ts`,
 * for the reason the first of those was written: `canvasFakeDom.ts` has no
 * cascade, no box model and no computed style, so it can prove that a module
 * WROTE an attribute and never that anything reads it. Two of the defects here
 * are exactly that shape:
 *
 *  - **SYNC-6** — `data-working` / `data-staged` / `data-cursor` / `data-writing`
 *    were stamped on `#rail-list` and on the world by `liveness.ts` on the
 *    documented assumption that a rule like
 *    `#rail-list[data-working~="p1"] .thumb[data-id="p1"]` lights up the row.
 *    No such rule existed anywhere in the shipped CSS. A unit test asserting the
 *    attribute is written passes either way; only a cascade can tell you whether
 *    the row changed.
 *  - **SYNC-3 / CANVAS-W3** — `CanvasApp._flash` writes the element the status
 *    adopted as its label and hides it 1.8 s later, and the pill chrome and the
 *    state dot hang off `.agent-status:has(> .agent-activity:not([hidden]))`.
 *    Whether the status pill actually vanishes is a `:has()` question.
 *
 * **A11Y-3** and **SYNC-5** are asserted here too, against the shipped shell and
 * the real module graph, because both are claims about what the browser ends up
 * with: a live region that is not the whole status bar, and a button that
 * reveals a pane the stylesheet had collapsed.
 *
 * Like its siblings it degrades to a warning where Chromium is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import type { WireArtifact } from '../../src/canvas/protocol';
import type { ArtifactPage } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { activityStyleText } from '../../src/webview/canvas/liveness';

const ROOT = path.resolve(__dirname, '../..');
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const HEADING = 'aaaaaaaaaa';

let browser: Browser | undefined;
let page: Page | undefined;
let bundle = '';
let unavailable: string | null = null;

function pageFixture(id: string, x: number, title: string): ArtifactPage {
  return {
    id, version: 2, boardPos: { x, y: 0 }, actionTitle: title,
    doc: {
      mid: 'root000000', tag: 'UI.Screen', children: [
        { mid: HEADING, tag: 'UI.Heading', text: 'Welcome' },
      ],
    },
  };
}

function artifact(): WireArtifact {
  return {
    id: 'art1', version: 7, kind: 'screens', name: 'Acme',
    format: getFormat('desktop')!, theme: getThemePreset('clean-saas')!.theme,
    pages: [pageFixture('p1', 0, 'Login'), pageFixture('p2', 1600, 'Home')],
    assets: [], updatedAt: 0, approvalMode: 'staged',
  };
}

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
    scaffolds: [{ id: 'login', name: 'Login', description: 'Email + password' }],
  };
}

async function buildBundle(): Promise<string> {
  const { build } = await import('esbuild');
  const result = await build({
    stdin: {
      contents: `
        import { CanvasApp } from './src/webview/canvas/app';
        import { realEnv } from './src/webview/canvas/dom';
        export function start(boot) {
          const env = realEnv();
          const offline = { ...env, fetchText: () => Promise.reject(new Error('offline')) };
          const app = new CanvasApp({ boot, env: offline, post: m => { window.__posted.push(m); } });
          window.__posted = [];
          app.start();
          return app;
        }
      `,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'canvasAgentSyncBrowserDriver.ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'MystiCanvasApp',
    platform: 'browser', target: 'es2020', logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

function shellHtml(): string {
  const css = fs.readFileSync(path.join(ROOT, 'media/canvas/canvas.css'), 'utf8');
  return fs.readFileSync(path.join(ROOT, 'media/canvas/index.html'), 'utf8')
    .replace('{{cspMeta}}', '')
    .replace('<link rel="stylesheet" href="{{cssUri}}">', `<style>${css}</style>`)
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace('{{boot}}', '')
    .replace(/<script[^>]*src="\{\{jsUri\}\}"[^>]*><\/script>/, '');
}

async function bootPage(): Promise<void> {
  const { chromium } = await import('playwright');
  bundle = await buildBundle();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setContent(shellHtml(), { waitUntil: 'load' });
}

/** A fresh shell + a fresh app, so no test inherits another's state. */
async function freshApp(): Promise<void> {
  await page!.setContent(shellHtml(), { waitUntil: 'load' });
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
  await page!.waitForTimeout(50);
}

/** One `canvas/job` event, exactly as `CanvasBridge.pushJob` posts it. */
async function job(event: Record<string, unknown>): Promise<void> {
  await page!.evaluate(e => { window.postMessage({ t: 'canvas/job', event: e }, '*'); }, event);
  await page!.waitForTimeout(30);
}

/** The complete staged set, exactly as `CanvasBridge._flushStaged` posts it. */
async function staged(count: number): Promise<void> {
  const records = Array.from({ length: count }, (_, i) => ({
    opId: `o${i}`, targetPageId: 'p1',
    op: { op: 'el.setText', pageId: 'p1', mid: HEADING, text: `v${i}` },
  }));
  await page!.evaluate(r => { window.postMessage({ t: 'canvas/staged', records: r }, '*'); }, records);
  await page!.waitForTimeout(30);
}

describe('canvas agent status (real browser)', () => {
  beforeAll(async () => {
    try { await bootPage(); } catch (err) {
      unavailable = err instanceof Error ? err.message : String(err);
    }
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  /* ───────── SYNC-6 — the stamped attributes must reach the cascade ───────── */

  it('SYNC-6 · a stamped rail row is actually drawn differently', async () => {
    if (unavailable) { console.warn('[Mysti] skipping — Chromium unavailable:', unavailable); return; }
    await freshApp();

    // The shipped stylesheet alone: this is the state the finding describes —
    // the attribute is written and nothing anywhere reads it. `p2` is the
    // unselected row, so `.thumb.active`'s own ring cannot be mistaken for a
    // highlight.
    const baseline = await page!.evaluate(() => {
      const list = document.getElementById('rail-list')!;
      list.removeAttribute('data-working');
      const rows = [...list.querySelectorAll('.thumb')] as HTMLElement[];
      const row = rows.find(r => r.getAttribute('data-id') === 'p2');
      const before = row ? getComputedStyle(row).boxShadow : null;
      list.setAttribute('data-working', 'p2');
      return { rows: rows.length, before, after: row ? getComputedStyle(row).boxShadow : null };
    });
    expect(baseline.rows, 'the rail rendered rows to highlight').toBeGreaterThan(1);
    expect(baseline.after, 'canvas.css alone gives the stamp no consumer').toBe(baseline.before);

    // The module's own generated sheet — the half that was missing.
    const css = activityStyleText({
      working: new Set(['p2']), staged: new Set(), cursor: new Set(), writing: new Set(),
    });
    expect(css).not.toBe('');
    const measured = await page!.evaluate(text => {
      const style = document.createElement('style');
      style.textContent = text;
      document.body.appendChild(style);
      const rows = [...document.querySelectorAll('#rail-list .thumb')] as HTMLElement[];
      const row = rows.find(r => r.getAttribute('data-id') === 'p2')!;
      return getComputedStyle(row).boxShadow;
    }, css);
    expect(measured).not.toBe(baseline.before);
    expect(measured).toContain('inset');
  }, 120_000);

  it('SYNC-6 · the layer attaches that sheet itself while a job is live', async () => {
    if (unavailable) { return; }
    await freshApp();
    await job({ jobId: 'j1', type: 'started', label: 'Canvas · write_page_jsx', pageId: 'p2' });

    const drawn = await page!.evaluate(() => {
      const rows = [...document.querySelectorAll('#rail-list .thumb')] as HTMLElement[];
      const on = rows.find(r => r.getAttribute('data-id') === 'p2')!;
      const list = document.getElementById('rail-list')!;
      const styled = getComputedStyle(on).boxShadow;
      list.removeAttribute('data-working');
      return {
        attr: 'p2',
        sheet: !!document.getElementById('agent-activity-style'),
        styled,
        bare: getComputedStyle(on).boxShadow,
      };
    });
    expect(drawn.sheet, 'the attribute needs a generated consumer').toBe(true);
    expect(drawn.styled).not.toBe(drawn.bare);
  }, 120_000);

  /* ───────── A11Y-3 — the live region is a sentence, not the bar ───────── */

  it('A11Y-3 · the ticking clock is not inside a live region', async () => {
    if (unavailable) { return; }
    await freshApp();
    await job({ jobId: 'j1', type: 'started', label: 'Canvas · write_page_jsx', pageId: 'p1' });

    const shape = await page!.evaluate(() => {
      const host = document.getElementById('agent-status')!;
      const live = host.querySelector('[data-status-live]') as HTMLElement | null;
      const elapsed = document.getElementById('agent-elapsed')!;
      /** The nearest ancestor that would actually announce a mutation. */
      const announcer = (el: Element | null): string | null => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          const v = n.getAttribute('aria-live');
          if (v) { return v; }
          if (n.getAttribute('role') === 'status' || n.getAttribute('role') === 'alert') { return 'polite'; }
        }
        return null;
      };
      return {
        hostRole: host.getAttribute('role'),
        hostLive: host.getAttribute('aria-live'),
        elapsedAnnouncer: announcer(elapsed),
        liveAnnouncer: announcer(live),
        liveText: live?.textContent ?? null,
        liveRect: live ? live.getBoundingClientRect().width : null,
      };
    });
    expect(shape.hostRole, 'role=status implies aria-live=polite').toBeNull();
    expect(shape.hostLive).toBe('off');
    // The clock is inside the bar, but the bar no longer announces.
    expect(shape.elapsedAnnouncer).toBe('off');
    expect(shape.liveAnnouncer).toBe('polite');
    expect(shape.liveText).toContain('Working');
    // Visually hidden but still in the accessibility tree.
    expect(shape.liveRect).toBeLessThanOrEqual(2);
  }, 120_000);

  it('A11Y-3 · a second of ticking changes the clock and not the announcement', async () => {
    if (unavailable) { return; }
    await freshApp();
    await job({ jobId: 'j1', type: 'started', label: 'Canvas · write_page_jsx', pageId: 'p1' });
    const read = () => page!.evaluate(() => ({
      elapsed: document.getElementById('agent-elapsed')!.textContent,
      live: (document.querySelector('#agent-status [data-status-live]') as HTMLElement).textContent,
    }));
    const before = await read();
    await job({ jobId: 'j1', type: 'heartbeat', elapsedSeconds: 4 });
    await page!.waitForTimeout(1300);
    const after = await read();
    expect(after.elapsed).not.toBe(before.elapsed);
    expect(after.live).toBe(before.live);
  }, 120_000);

  /* ───────── SYNC-3 — the toast cannot take the status with it ───────── */

  it('SYNC-3 · the status survives the 1.8 s toast that owns #agent-activity', async () => {
    if (unavailable) { return; }
    await freshApp();
    // The real path: `app.ts`'s `job` handler calls `_flash('Designing...')`
    // right after handing the event to the liveness layer.
    await job({ jobId: 'j1', type: 'started', label: 'Canvas · write_page_jsx', pageId: 'p1' });

    const during = await page!.evaluate(() => {
      const host = document.getElementById('agent-status')!;
      const label = host.querySelector('[data-status-label]') as HTMLElement;
      return { label: label.textContent, dot: getComputedStyle(host.querySelector('.agent-dot')!).display };
    });
    expect(during.label, 'the toast must not overwrite the job label').toBe('Canvas · write_page_jsx');
    expect(during.dot).not.toBe('none');

    // Past the toast's own timer, with no further canvas event to redraw.
    await page!.waitForTimeout(2100);
    const after = await page!.evaluate(() => {
      const host = document.getElementById('agent-status')!;
      const label = host.querySelector('[data-status-label]') as HTMLElement;
      return {
        toastHidden: (document.getElementById('agent-activity') as HTMLElement).hidden,
        label: label.textContent,
        labelHidden: label.hidden,
        labelWidth: label.getBoundingClientRect().width,
        dot: getComputedStyle(host.querySelector('.agent-dot')!).display,
      };
    });
    expect(after.toastHidden, 'the toast did expire — this is the real timer').toBe(true);
    expect(after.label).toBe('Canvas · write_page_jsx');
    expect(after.labelHidden).toBe(false);
    expect(after.labelWidth).toBeGreaterThan(10);
    // The pill chrome and the state dot hang off `:has(> .agent-activity:not([hidden]))`.
    expect(after.dot).not.toBe('none');
  }, 120_000);

  /* ───────── SYNC-5 — the review button opens the queue it names ───────── */

  it('SYNC-5 · clicking “N to review” reveals the collapsed pane holding the queue', async () => {
    if (unavailable) { return; }
    await freshApp();
    await staged(3);

    // The human closed the Pages panel to get more board.
    await page!.evaluate(() => {
      (document.getElementById('rail-hidden') as HTMLInputElement).checked = true;
      (document.getElementById('rail-hidden') as HTMLInputElement)
        .dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page!.waitForTimeout(30);

    const collapsed = await page!.evaluate(() => ({
      queue: document.getElementById('staged-rail')!.getBoundingClientRect().width,
      button: !!document.querySelector('#agent-status .agent-review'),
    }));
    expect(collapsed.button, 'the top bar offers the review button').toBe(true);
    expect(collapsed.queue, 'the queue is inside a display:none aside').toBe(0);

    await page!.click('#agent-status .agent-review');
    await page!.waitForTimeout(50);

    const revealed = await page!.evaluate(() => ({
      queue: document.getElementById('staged-rail')!.getBoundingClientRect().width,
      railDisplay: getComputedStyle(document.getElementById('pages-rail')!).display,
      rows: document.querySelectorAll('#staged-rail .staged-row').length,
    }));
    // Before the fix the click flipped `aria-expanded` on a queue that stayed
    // inside a `display:none` aside, so nothing appeared at all.
    expect(revealed.railDisplay).not.toBe('none');
    expect(revealed.queue, 'the queue the button names must be on screen').toBeGreaterThan(0);
    expect(revealed.rows).toBe(3);
  }, 120_000);
});
