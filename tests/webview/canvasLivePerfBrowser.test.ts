/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * The cost of LIVE artboards — the one path no harness has ever measured.
 *
 * `canvasPerfBrowser.test.ts` fails every runtime fetch, so every artboard stays
 * a static preview and no iframe is ever mounted; the VS Code harness reports
 * `liveFrames: 0` for the same reason. Both therefore measure the cheap half.
 *
 * This one serves the REAL sandbox runtime (React, ReactDOM, the UI primitives,
 * harness.js) so frames actually mount, and drives a REAL design — the 9-page
 * artifact from Mysti-Test-Project — because a synthetic board turned out to be
 * larger than a real one (1,898 nodes vs 177) and still fast, which is what
 * ruled DOM volume out as the cause.
 *
 * The hypothesis under test: transforming a container full of live iframes
 * forces each to re-rasterize, so pan/zoom cost is driven by FRAME COUNT rather
 * than node count. Figma never transforms live content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import { getFormat } from '../../src/managers/CanvasFormats';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import type { WireArtifact } from '../../src/canvas/protocol';

const ROOT = path.resolve(__dirname, '../..');
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const REAL_ARTIFACT = path.resolve(
  ROOT, '..', 'Mysti-Test-Project', '.mysti', 'canvas',
  '6c97862f-2787-4f28-82f6-f38fdf144492', 'artifact.json',
);
const SANDBOX = path.join(ROOT, 'resources', 'canvas-sandbox');

let browser: Browser | undefined;
let page: Page | undefined;
let bundle = '';

interface Report { p50: number; p95: number; dropped: number; frames: number; nodes: number }

/** The real design, or null when the sibling project is absent. */
function realArtifact(): WireArtifact | null {
  if (!fs.existsSync(REAL_ARTIFACT)) { return null; }
  const raw = JSON.parse(fs.readFileSync(REAL_ARTIFACT, 'utf8')) as Record<string, unknown>;
  return {
    id: String(raw.id ?? 'real'), version: Number(raw.version ?? 1),
    kind: (raw.kind as WireArtifact['kind']) ?? 'screens', name: String(raw.name ?? 'Sample App'),
    format: (raw.format as WireArtifact['format']) ?? getFormat('desktop')!,
    theme: (raw.theme as WireArtifact['theme']) ?? getThemePreset('clean-saas')!.theme,
    pages: (raw.pages as WireArtifact['pages']) ?? [],
    assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

/** The real sandbox runtime, keyed by the URI the boot payload advertises. */
function runtimeFiles(): Record<string, string> {
  const read = (f: string) => fs.readFileSync(path.join(SANDBOX, f), 'utf8');
  return {
    './react.js': read('react.production.min.js'),
    './react-dom.js': read('react-dom.production.min.js'),
    './ui.js': read('ui-primitives.js'),
    './harness.js': read('harness.js'),
  };
}

function boot(): Record<string, unknown> {
  const desktop = getFormat('desktop')!;
  return {
    viewToken: TOKEN,
    runtimeUris: ['./react.js', './react-dom.js', './ui.js'],
    harnessUri: './harness.js',
    babelUri: '', innerCsp: '',
    devices: [{
      formatId: desktop.formatId, width: desktop.width, height: desktop.height,
      kind: desktop.kind, label: 'Desktop',
    }],
    themes: [], scaffolds: [],
  };
}

/** Driver whose `fetchText` serves the preloaded runtime, so frames MOUNT. */
async function buildBundle(): Promise<string> {
  const { build } = await import('esbuild');
  const result = await build({
    stdin: {
      contents: `
        import { CanvasApp } from './src/webview/canvas/app';
        import { realEnv } from './src/webview/canvas/dom';
        export function start(boot) {
          const env = realEnv();
          const served = { ...env, fetchText: (url) => {
            const files = window.__RUNTIME || {};
            return url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('404 ' + url));
          } };
          window.__posted = [];
          const app = new CanvasApp({ boot, env: served, post: m => { window.__posted.push(m); } });
          app.start();
          return app;
        }
      `,
      resolveDir: ROOT, loader: 'ts', sourcefile: 'canvasLivePerfDriver.ts',
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

async function loadBoard(art: WireArtifact, zoom: number): Promise<number> {
  await page!.setContent(shellHtml(), { waitUntil: 'load' });
  await page!.evaluate(files => { (window as unknown as { __RUNTIME: unknown }).__RUNTIME = files; }, runtimeFiles());
  await page!.addScriptTag({ content: bundle });
  await page!.evaluate(b => {
    (window as unknown as { __app: unknown }).__app =
      (window as unknown as { MystiCanvasApp: { start(b: unknown): unknown } }).MystiCanvasApp.start(b);
  }, boot());
  await page!.evaluate(([a, token]) => {
    window.postMessage({ t: 'canvas/hello', artifactId: 'real', artifact: a, viewToken: token, caps: [] }, '*');
  }, [art, TOKEN] as [WireArtifact, string]);
  await page!.waitForTimeout(300);
  await page!.evaluate(z => {
    const app = (window as unknown as { __app: { board?: { setZoom?(n: number): void } } }).__app;
    app.board?.setZoom?.(z);
  }, zoom);
  // Frames mount asynchronously (runtime fetch + React boot).
  await page!.waitForTimeout(1800);
  return page!.evaluate(() => document.querySelectorAll('iframe.artboard-frame').length);
}

async function pacedPan(ticks: number): Promise<Report> {
  return page!.evaluate(async (n: number) => {
    const view = document.getElementById('board-scroll')!;
    const opts = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 };
    view.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 700, clientY: 450 }));
    const frames: number[] = [];
    await new Promise<void>(resolve => {
      let i = 0; let last = performance.now();
      const tick = (t: number) => {
        frames.push(t - last); last = t;
        window.dispatchEvent(new PointerEvent('pointermove', {
          ...opts, clientX: 700 + (i % 50) * 6, clientY: 450 + (i % 30) * 5,
        }));
        if (++i >= n) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 900, clientY: 560, buttons: 0 }));
    const sorted = [...frames].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
    return {
      p50: at(0.5), p95: at(0.95), dropped: frames.filter(f => f > 20).length,
      frames: frames.length,
      nodes: document.getElementById('page-stage')!.querySelectorAll('*').length,
    };
  }, ticks);
}

describe('live-artboard performance (real design from Mysti-Test-Project)', () => {
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    const { chromium } = await import('playwright');
    bundle = await buildBundle();
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  // Two preconditions, both declared so vitest reports a SKIP rather than a
  // green tick with nothing measured: a launchable Chromium, and the real
  // design fixture from the sibling Mysti-Test-Project checkout.
  it.skipIf(CHROMIUM_UNAVAILABLE || !fs.existsSync(REAL_ARTIFACT))('measures a pan with LIVE frames mounted vs static previews', async () => {
    const art = realArtifact()!;
    console.log(`[perf] real design: ${art.pages.length} artboards`);

    // Zoomed in enough that frames are allowed to mount (threshold 0.35).
    const liveCount = await loadBoard(art, 0.6);
    const live = await pacedPan(60);
    console.log(`[perf] LIVE   frames=${liveCount} p50=${live.p50.toFixed(1)}ms p95=${live.p95.toFixed(1)}ms dropped=${live.dropped}/${live.frames} nodes=${live.nodes}`);

    // Below the threshold every artboard falls back to a static preview.
    const previewCount = await loadBoard(art, 0.2);
    const preview = await pacedPan(60);
    console.log(`[perf] STATIC frames=${previewCount} p50=${preview.p50.toFixed(1)}ms p95=${preview.p95.toFixed(1)}ms dropped=${preview.dropped}/${preview.frames} nodes=${preview.nodes}`);

    // Reported, not asserted on the first run: this test exists to FIND the
    // cost, and a threshold invented before the first measurement is a guess.
    expect(live.frames).toBeGreaterThan(0);
  }, 300_000);
});
