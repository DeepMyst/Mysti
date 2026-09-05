/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 — the board with artboards that are actually LIVE, measured in a real
 * browser.
 *
 * Fourth sibling of `canvasLayoutBrowser` / `canvasAppBrowser` /
 * `canvasAgentSyncBrowser`, and the first that lets a frame RUN: those three
 * deliberately fail the runtime fetch so every artboard stays a static preview
 * ("no iframes, no timing to race against"). Every defect below lives in
 * exactly the gap that leaves:
 *
 *  - **CANVAS-P3-4** — an artboard's page box is baked into the `srcdoc` by
 *    `buildBaseCss`, and `format` occurred ONCE in the whole of `harness.js`:
 *    in a comment. Picking "Mobile" resized the iframe ELEMENT around an
 *    unchanged 1440px document, so the human saw the top-left 390px crop of the
 *    desktop layout while the static preview tile beside it reflowed correctly.
 *    Only a real frame with a real layout can show that.
 *  - **R3-3** — `<iframe>` is a native tab stop, so every mounted artboard sat
 *    in sequential navigation and one Shift+Tab past the zoom controls dropped
 *    focus inside a sandboxed, model-authored document where none of the
 *    shell's keys work. Only a real focus model can show that.
 *  - **R3-2** — `tabTarget` wraps modulo, so the documented "a no-op walk must
 *    fall through" never fired and `#board-scroll` was a Tab cycle whose only
 *    exit is an unannounced Escape.
 *  - **CANVAS-P3-6** — the frame's own projection of `el.move` appended where
 *    `DocPatch` keeps position, and reported `'ok'`.
 *
 * The shell is loaded under its REAL CSP (nonce-based `script-src`, no
 * `'unsafe-inline'`) rather than the stripped one every other browser test
 * uses, because a live frame is exactly what that policy broke once already.
 *
 * Skipped (it.skipIf) where Chromium is unavailable, like its siblings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Frame, Page } from 'playwright';
import type { WireArtifact } from '../../src/canvas/protocol';
import type { ArtifactPage, DocNode } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { buildFrameDocument } from '../../src/webview/canvas/sandboxDoc';
import { getCanvasContent } from '../../src/webview/canvasContent';
import { mintViewToken } from '../../src/canvas/protocol';

const ROOT = path.resolve(__dirname, '../..');
const SANDBOX = path.join(ROOT, 'resources/canvas-sandbox');
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const NONCE = 'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn';
const ROOT_MID = 'root000000';
const HEADING = 'aaaaaaaaaa';

let browser: Browser | undefined;
let page: Page | undefined;
let bundle = '';

/** React, ReactDOM, the 22 primitives and the harness, keyed by fake URI. */
function runtimeFiles(): Record<string, string> {
  const read = (f: string): string => fs.readFileSync(path.join(SANDBOX, f), 'utf8');
  return {
    'runtime://react': read('react.production.min.js'),
    'runtime://react-dom': read('react-dom.production.min.js'),
    'runtime://ui': read('ui-primitives.js'),
    'runtime://harness': read('harness.js'),
  };
}

function docOf(...children: DocNode[]): DocNode {
  return { mid: ROOT_MID, tag: 'UI.Screen', children };
}

function pageFixture(id: string, x: number, title: string, doc: DocNode, formatId?: string): ArtifactPage {
  const format = formatId ? getFormat(formatId) : undefined;
  return { id, version: 2, boardPos: { x, y: 0 }, actionTitle: title, doc, format };
}

function artifact(pages: ArtifactPage[]): WireArtifact {
  return {
    id: 'art1', version: 7, kind: 'screens', name: 'Acme',
    format: getFormat('desktop')!, theme: getThemePreset('clean-saas')!.theme,
    pages, assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

/** The shipped boot payload, WITH a reachable runtime — the whole point here. */
function boot(): Record<string, unknown> {
  const device = (id: string, label: string): Record<string, unknown> => {
    const f = getFormat(id)!;
    return { formatId: f.formatId, width: f.width, height: f.height, kind: f.kind, label };
  };
  return {
    viewToken: TOKEN,
    frameNonce: NONCE,
    runtimeUris: ['runtime://react', 'runtime://react-dom', 'runtime://ui'],
    harnessUri: 'runtime://harness',
    babelUri: '', innerCsp: '',
    devices: [device('desktop', 'Desktop'), device('mobile', 'Mobile')],
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
        export function start(boot, files) {
          const env = realEnv();
          // The runtime is SERVED rather than fetched: no network, no ordering
          // to race, and the frame gets byte-identical bytes to production.
          const served = {
            ...env,
            fetchText: (u) => Object.prototype.hasOwnProperty.call(files, u)
              ? Promise.resolve(files[u])
              : Promise.reject(new Error('no such runtime: ' + u)),
          };
          window.__posted = [];
          const app = new CanvasApp({ boot, env: served, post: m => { window.__posted.push(m); } });
          app.start();
          return app;
        }
      `,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'canvasLiveFrameBrowserDriver.ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'MystiCanvasApp',
    platform: 'browser', target: 'es2020', logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/**
 * The shell with its REAL policy: the exact shape `getCanvasContent` emits, with
 * the bundle inlined under the same nonce a webview script would carry.
 */
function shellCspMeta(): string {
  // Taken from the real emitter rather than hand-written: a model of the shell
  // policy that drifts (this one carried `https:` scheme-sources J-6 removed)
  // validates the live frame under a policy that no longer ships.
  return realShellCspMeta('https://canvas.test.invalid', NONCE);
}

function shellHtml(): string {
  const csp = shellCspMeta();
  const css = fs.readFileSync(path.join(ROOT, 'media/canvas/canvas.css'), 'utf8');
  return fs.readFileSync(path.join(ROOT, 'media/canvas/index.html'), 'utf8')
    .replace('{{cspMeta}}', csp)
    .replace('<link rel="stylesheet" href="{{cssUri}}">', `<style>${css}</style>`)
    .replace('{{boot}}', '')
    .replace(/<script[^>]*src="\{\{jsUri\}\}"[^>]*><\/script>/, `<script nonce="${NONCE}">${bundle}</script>`)
    .replace(/\{\{nonce\}\}/g, NONCE);
}

/**
 * The shell's REAL `<meta http-equiv="Content-Security-Policy">`, taken from
 * `getCanvasContent` (the same extraction `canvasShellCsp.test.ts` uses) with
 * the generated nonce swapped for this file's fixed one.
 */
function realShellCspMeta(cspSource: string, nonce: string): string {
  const webview = {
    cspSource,
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => cspSource + uri.fsPath }),
  } as never;
  const extensionUri = { fsPath: ROOT, path: ROOT } as never;
  const html = getCanvasContent(webview, extensionUri, '1.2.3', undefined, undefined, { viewToken: mintViewToken() });
  const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]+">/.exec(html);
  if (!meta) { throw new Error('getCanvasContent emitted no CSP meta'); }
  return meta[0].replace(/'nonce-[^']+'/, `'nonce-${nonce}'`);
}

/** A fresh shell + app + artifact, with every artboard's frame actually live. */
async function freshApp(pages: ArtifactPage[]): Promise<void> {
  await page!.setContent(shellHtml(), { waitUntil: 'load' });
  await page!.evaluate(
    ({ b, files }) => {
      (window as unknown as { __app: unknown }).__app =
        (window as unknown as { MystiCanvasApp: { start(b: unknown, f: unknown): unknown } })
          .MystiCanvasApp.start(b, files);
    },
    { b: boot(), files: runtimeFiles() },
  );
  await page!.evaluate(([art, token]) => {
    window.postMessage(
      { t: 'canvas/hello', artifactId: 'art1', artifact: art, viewToken: token, caps: [] },
      '*',
    );
  }, [artifact(pages), TOKEN] as [WireArtifact, string]);
  await page!.waitForFunction(
    n => document.querySelectorAll('#page-stage iframe').length >= n,
    pages.length,
    { timeout: 20_000 },
  );
  // …and wait for the harness inside each frame to have painted the doc, so a
  // measurement is never taken against an empty root.
  for (const f of artboardFrames()) {
    await f.waitForFunction(
      () => !!document.querySelector('#__mysti_page [data-mid]'),
      undefined,
      { timeout: 20_000 },
    );
  }
}

function artboardFrames(): Frame[] {
  return page!.frames().filter(f => f !== page!.mainFrame());
}

/** One committed record, in the envelope `CanvasBridge` puts on the wire. */
function rec(opId: string, op: unknown): Record<string, unknown> {
  return { opId, txnId: 't1', runId: 'r1', author: 'agent', actorId: 'mysti', op, status: 'applied', ts: 0 };
}

/** Push one `canvas/ops` batch through the real intake path. */
async function ops(records: Array<Record<string, unknown>>, artifactVersion: number): Promise<void> {
  await page!.evaluate(([recs, v]) => {
    window.postMessage({ t: 'canvas/ops', records: recs, artifactVersion: v }, '*');
  }, [records, artifactVersion] as [Array<Record<string, unknown>>, number]);
  await page!.waitForTimeout(150);
}

/** Every `data-mid` the live frame is currently painting, in document order. */
function midsIn(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => [...document.querySelectorAll('#__mysti_page [data-mid]')]
    .map(e => e.getAttribute('data-mid') ?? ''));
}

/** The id of whatever holds focus, plus its tag — an IFRAME has no id. */
async function focused(): Promise<string> {
  return page!.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) { return 'none'; }
    return el.id ? `${el.tagName}#${el.id}` : el.tagName;
  });
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  const { chromium } = await import('playwright');
  bundle = await buildBundle();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
}, 180_000);
afterAll(async () => { await browser?.close(); });

describe('the shell policy this file loads the live frame under (static)', () => {
  // Round-3 gate. This file's `shellHtml` claims "the shell with its REAL policy"
  // and is the only test that runs a LIVE frame under it, so a hand-written
  // model that drifts from `canvasContent.ts` validates the frame bundle under a
  // policy that no longer ships. J-6 removed every `https:` scheme-source and
  // added `form-action`/`base-uri`; this pins the model to the real emitter.
  it('is the policy getCanvasContent actually emits (J-6: no https: scheme-source)', () => {
    const meta = /content="([^"]+)"/.exec(shellCspMeta());
    expect(meta).not.toBeNull();
    const csp = meta![1];
    expect(csp).not.toMatch(/\bhttps:(?=[\s;])/);
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Directive-for-directive equality with the shipped shell, modulo the two
    // per-instance tokens (cspSource, nonce).
    const real = /content="([^"]+)"/.exec(realShellCspMeta('https://canvas.test.invalid', NONCE))![1];
    const norm = (v: string) => v.split(';').map(d => d.trim()).filter(Boolean).sort();
    expect(norm(csp)).toEqual(norm(real));
  });
});

describe('canvas live artboard frames (real browser)', () => {
  /* ───────────── CANVAS-P3-4 — a device change must reach the frame ───────────── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('CANVAS-P3-4 · a device change re-lays-out the LIVE document, not just its box', async () => {
    await freshApp([pageFixture('p1', 0, 'Login', docOf(
      { mid: HEADING, tag: 'UI.Heading', text: 'Welcome' },
    ))]);

    const frame = artboardFrames()[0];
    // A witness for "the frame OUTLIVED the resize": a rebuild is a fresh
    // document, so this global would not survive one.
    await frame.evaluate(() => { (window as unknown as { __alive: number }).__alive = 1; });

    const desktop = await frame.evaluate(
      () => getComputedStyle(document.getElementById('__mysti_page')!).width,
    );
    expect(desktop, 'the artboard starts at the desktop page box').toBe('1440px');

    await page!.selectOption('#device-select', 'mobile');
    await page!.waitForTimeout(120);

    const after = await frame.evaluate(() => ({
      pageBox: getComputedStyle(document.getElementById('__mysti_page')!).width,
      alive: (window as unknown as { __alive?: number }).__alive ?? 0,
    }));
    const box = await page!.evaluate(
      () => (document.querySelector('#page-stage iframe') as HTMLElement).style.width,
    );

    expect(box, 'the iframe element followed the device').toBe('390px');
    // Before the fix: '1440px' — the box shrank around an unchanged document
    // and the human saw the top-left 390px crop of the desktop layout.
    expect(after.pageBox, 'the DOCUMENT inside the frame still lays out at the old width').toBe('390px');
    // Phase 2's invariant: a live frame outlives the edit AND the resize.
    expect(after.alive, 'the frame was rebuilt instead of being told the new format').toBe(1);
  }, 180_000);

  /* ── R4-1 — a mount and a patch must never describe the same op ── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('R4-1 · an element op batched with a theme op is applied ONCE', async () => {
    await freshApp([pageFixture('p1', 0, 'Login', docOf(
      { mid: HEADING, tag: 'UI.Heading', text: 'Welcome' },
    ))]);
    const frame = artboardFrames()[0];
    // The Phase 2 invariant, witnessed: a rebuild is a fresh document, so this
    // global would not survive one.
    await frame.evaluate(() => { (window as unknown as { __alive: number }).__alive = 1; });

    // "Accept all" over a staged `set_theme` + `insert_element`: CanvasBridge
    // applies every staged op inside ONE `_coalesced`, so both ride one batch.
    await ops([
      rec('o1', {
        op: 'el.insert', pageId: 'p1', parentMid: ROOT_MID, before: 'end',
        node: { mid: 'cccccccccc', tag: 'UI.Text', text: 'Inserted once' },
      }),
      rec('o2', { op: 'theme.set', theme: getThemePreset('midnight')!.theme }),
    ], 9);

    const mids = await midsIn(frame);
    // Before the fix: ['root000000','aaaaaaaaaa','cccccccccc','cccccccccc'].
    // The theme re-mount carried the POST-op doc down the existing port and the
    // patch loop then applied the same insert on top of it. Two nodes shared a
    // mid, so `findNode` reached only the first: every later `set_text` on it
    // edited one copy, and `plan.resync` is false so nothing repaired it.
    expect(mids.filter(m => m === 'cccccccccc'), `frame mids: ${mids.join(', ')}`).toHaveLength(1);
    expect(mids).toEqual([ROOT_MID, HEADING, 'cccccccccc']);
    // …and the theme still arrived, without costing a rebuild.
    const themed = await frame.evaluate(
      () => document.getElementById('__mysti_theme_tokens')?.textContent ?? '',
    );
    expect(themed, 'the theme never reached the frame').toContain('--theme-color-primary');
    expect(
      await frame.evaluate(() => (window as unknown as { __alive?: number }).__alive ?? 0),
      'the artboard was rebuilt instead of patched',
    ).toBe(1);
  }, 180_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('R4-1 · a remove batched with a theme op reports no spurious frame error', async () => {
    await freshApp([pageFixture('p1', 0, 'Login', docOf(
      { mid: HEADING, tag: 'UI.Heading', text: 'Welcome' },
      { mid: 'cccccccccc', tag: 'UI.Text', text: 'Doomed' },
    ))]);
    const frame = artboardFrames()[0];

    await ops([
      rec('o1', { op: 'el.remove', pageId: 'p1', mid: 'cccccccccc' }),
      rec('o2', { op: 'theme.set', theme: getThemePreset('midnight')!.theme }),
    ], 9);

    expect(await midsIn(frame)).toEqual([ROOT_MID, HEADING]);
    // The mirror of the double-apply: the mount already had the node removed,
    // so the replayed `el.remove` missed and the harness reported "resync
    // needed" — an error card on the artboard and a report into the run's
    // steering inbox, for a batch that applied perfectly.
    const errors = await page!.evaluate(
      () => ((window as unknown as { __posted: Array<{ t?: string; message?: string }> }).__posted)
        .filter(m => m && m.t === 'canvas/frameError').map(m => String(m.message ?? '')),
    );
    expect(errors, `frame errors: ${errors.join(' | ')}`).toEqual([]);
  }, 180_000);

  /* ───────────────── R3-3 — a frame must not be a tab stop ───────────────── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('R3-3 · sequential navigation never drops focus inside an artboard frame', async () => {
    // Two artboards, both mobile so zoom-to-fit lands well above the live
    // threshold and both frames are genuinely mounted.
    await freshApp([
      pageFixture('p1', 0, 'Login', docOf({ mid: HEADING, tag: 'UI.Heading', text: 'Welcome' }), 'mobile'),
      pageFixture('p2', 500, 'Home', docOf({ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Home' }), 'mobile'),
    ]);
    expect(artboardFrames().length, 'both artboards mounted a live frame').toBeGreaterThanOrEqual(2);

    // The finding's measured path: overshoot the zoom controls and step back
    // one stop. Before the fix this landed on `IFRAME.artboard-frame`, where
    // Escape, the zoom keys and the pane toggles are all dead because keydown
    // fires in the frame's own document.
    await page!.focus('#btn-zoom-out');
    await page!.keyboard.press('Shift+Tab');
    expect(await focused(), 'Shift+Tab from the zoom controls fell into a sandboxed artboard')
      .toBe('DIV#board-scroll');

    // …and the whole forward walk out of the board reaches the zoom controls
    // without visiting a frame.
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page!.keyboard.press('Tab');
      const at = await focused();
      seen.push(at);
      if (at === 'BUTTON#btn-zoom-out') { break; }
    }
    expect(seen, `tab order walked through a frame: ${seen.join(' → ')}`).not.toContain('IFRAME');
  }, 180_000);

  /* ────────── R3-2 — a walk that cannot move must release the key ────────── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('R3-2 · Tab falls through when the element walk has nowhere to go', async () => {
    // ONE selectable element: `tabTarget` wraps modulo, so `(0 + 1 + 1) % 1`
    // hands back the mid the user is already on — a walk that does not move.
    await freshApp([pageFixture('p1', 0, 'Login', docOf(
      { mid: HEADING, tag: 'UI.Heading', text: 'Welcome' },
    ))]);
    await page!.evaluate(() => {
      (window as unknown as { __prevented: boolean[] }).__prevented = [];
      window.addEventListener('keydown', ev => {
        if (ev.key === 'Tab') {
          (window as unknown as { __prevented: boolean[] }).__prevented.push(ev.defaultPrevented);
        }
      });
    });

    await page!.focus('#board-scroll');
    // First Tab: nothing selected → the walk moves onto the only element, so
    // the board is right to claim the key.
    await page!.keyboard.press('Tab');
    expect(await focused(), 'the first Tab is a real walk and stays on the board').toBe('DIV#board-scroll');

    // Second Tab: the walk cannot move. Before the fix `preventDefault()` ran
    // anyway, so this was a cycle whose only exit is an Escape the board's
    // accessible name never mentions — WCAG 2.1.2.
    await page!.keyboard.press('Tab');
    const prevented = await page!.evaluate(
      () => (window as unknown as { __prevented: boolean[] }).__prevented,
    );
    const at = await focused();
    expect(prevented[1], 'a no-op walk still swallowed the key').toBe(false);
    expect(at, 'focus never left the board on a no-op walk').not.toBe('DIV#board-scroll');
    expect(at, 'a released Tab must not land inside an artboard frame').not.toBe('IFRAME');

    // …and Shift+Tab is released for the same reason, in the same state.
    await page!.keyboard.press('Shift+Tab');           // back onto #board-scroll
    expect(await focused()).toBe('DIV#board-scroll');
    await page!.keyboard.press('Shift+Tab');
    expect(await focused(), 'Shift+Tab was swallowed by a no-op walk').not.toBe('DIV#board-scroll');

    // The walk still WRAPS within a multi-element artboard, so Escape remains a
    // non-standard exit — which WCAG 2.1.2 permits only when the user is
    // advised of the method. The accessible name is where that advice lives.
    const label = await page!.evaluate(
      () => document.getElementById('board-scroll')!.getAttribute('aria-label') ?? '',
    );
    expect(label.toLowerCase(), `the board's accessible name never names its exit: "${label}"`)
      .toContain('escape');
  }, 180_000);
});

/* ══════════════ CANVAS-P3-6 — the frame's projection of el.move ══════════════
 * A bare frame with a port, which is all this needs: the claim is about what
 * `applyOps` does to the tree the harness renders, and it has to be measured
 * where the harness actually runs.
 */
describe('harness op projection (real frame)', () => {
  let bare: Page | undefined;

  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    bare = await browser!.newPage();
  }, 120_000);
  afterAll(async () => { await bare?.close(); });

  /** Mount a doc in a real frame and return a `patch` sender + an order reader. */
  async function mountFrame(doc: DocNode): Promise<{
    patch(op: unknown): Promise<void>;
    send(message: unknown): Promise<void>;
    textOf(mid: string): Promise<string>;
    themeCss(): Promise<string>;
    order(): Promise<string[]>;
    errors(): Promise<string[]>;
  }> {
    const runtime = runtimeFiles();
    const html = buildFrameDocument({
      page: { id: 'p1', version: 1, boardPos: { x: 0, y: 0 }, doc },
      theme: getThemePreset('clean-saas')!.theme,
      format: getFormat('desktop')!,
      runtime: {
        scripts: [runtime['runtime://react'], runtime['runtime://react-dom'], runtime['runtime://ui']],
        harness: runtime['runtime://harness'],
      },
    });
    await bare!.setContent('<!doctype html><iframe id="f" sandbox="allow-scripts"></iframe>', { waitUntil: 'load' });
    // Arm the handshake BEFORE the frame exists. `harness.js` announces itself
    // with `frame_hello` the moment it executes, which is the only moment the
    // port is guaranteed bindable: a sandboxed frame has no reachable
    // `contentDocument`, so the parent cannot poll its readiness.
    await bare!.evaluate(([theDoc]) => {
      const w = window as unknown as { __up: unknown[]; __port?: MessagePort };
      w.__up = [];
      const channel = new MessageChannel();
      channel.port1.onmessage = ev => { w.__up.push(ev.data); };
      channel.port1.start();
      w.__port = channel.port1;
      window.addEventListener('message', ev => {
        const data = ev.data as { source?: string; type?: string } | null;
        if (!data || data.source !== 'mysti-canvas-page' || data.type !== 'frame_hello') { return; }
        // Exactly what `BoardController._openPort` posts, from the real parent
        // window — which is what makes it bindable at all.
        (ev.source as Window).postMessage(
          { source: 'mysti-canvas-host', t: 'port', protocol: 1 }, '*', [channel.port2],
        );
        channel.port1.postMessage({ t: 'mount', doc: theDoc });
      });
    }, [doc] as [DocNode]);
    await bare!.evaluate(src => {
      (document.getElementById('f') as HTMLIFrameElement).srcdoc = src;
    }, html);
    await bare!.waitForFunction(
      () => (window as unknown as { __up: Array<{ t?: string }> }).__up.some(m => m && m.t === 'ready'),
      undefined,
      { timeout: 20_000 },
    );

    const frame = bare!.frames().find(f => f !== bare!.mainFrame())!;
    await frame.waitForFunction(
      () => !!document.querySelector('#__mysti_page [data-mid]'),
      undefined,
      { timeout: 20_000 },
    );
    return {
      async patch(op: unknown): Promise<void> {
        await bare!.evaluate(o => {
          (window as unknown as { __port: MessagePort }).__port.postMessage({ t: 'patch', ops: [o] });
        }, op);
        await bare!.waitForTimeout(80);
      },
      async send(message: unknown): Promise<void> {
        await bare!.evaluate(m => {
          (window as unknown as { __port: MessagePort }).__port.postMessage(m);
        }, message);
        await bare!.waitForTimeout(80);
      },
      textOf: (mid: string) => frame.evaluate(
        m => document.querySelector(`[data-mid="${m}"]`)?.textContent ?? '',
        mid,
      ),
      themeCss: () => frame.evaluate(
        () => document.getElementById('__mysti_theme_tokens')?.textContent ?? '',
      ),
      order: () => frame.evaluate(() => [...document.querySelectorAll('#__mysti_page [data-mid]')]
        .map(e => e.getAttribute('data-mid') ?? '')),
      errors: () => bare!.evaluate(() => (window as unknown as { __up: Array<{ t?: string; message?: string }> })
        .__up.filter(m => m && m.t === 'error').map(m => String(m.message ?? ''))),
    };
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('CANVAS-P3-6 · el.move onto its own gap stays put instead of appending', async () => {
    const doc = docOf(
      { mid: 'aaaaaaaaaa', tag: 'UI.Text', text: 'one' },
      { mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'two' },
      { mid: 'cccccccccc', tag: 'UI.Text', text: 'three' },
    );
    const f = await mountFrame(doc);
    expect(await f.order()).toEqual([ROOT_MID, 'aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);

    // "Before myself" — a drag that landed back on its own gap. `DocPatch._move`
    // treats it as "stay put" (`index = Math.min(at.index, dest.length)`) and
    // the host commits it as APPLIED, so the frame must agree. Before the fix
    // the frame had already spliced the node out, `indexFor` could not find
    // `op.mid` in the destination, and it APPENDED — reporting 'ok', so nothing
    // resynced and every later rect for that subtree was measured off a layout
    // the document does not contain.
    await f.patch({
      op: 'el.move', pageId: 'p1', mid: 'bbbbbbbbbb', newParentMid: ROOT_MID, before: 'bbbbbbbbbb',
    });
    expect(await f.order(), 'the frame reordered a list the document did not')
      .toEqual([ROOT_MID, 'aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
    expect(await f.errors(), 'a stay-put move is not an error').toEqual([]);
  }, 180_000);

  /* ── R4-2 — a theme/device re-mount is not a document replacement ── */

  it.skipIf(CHROMIUM_UNAVAILABLE)('R4-2 · a doc-less re-mount keeps the human\u2019s in-flight inline edit', async () => {
    const f = await mountFrame(docOf({ mid: HEADING, tag: 'UI.Heading', text: 'Welcome' }));

    // Exactly what the parent does on a double-click: open the edit, then let
    // the human type into the contenteditable node the harness focused and
    // selected. Real keystrokes, so the DOM state is the one a human produces.
    await f.send({ t: 'beginTextEdit', mid: HEADING });
    await bare!.keyboard.type('Welcome EDITED');
    expect(await f.textOf(HEADING), 'the frame never opened the edit').toBe('Welcome EDITED');

    // An agent `theme.set` (or the human picking a device) now arrives. It
    // carries tokens, NOT a document — the frame's tree is already current.
    await f.send({ t: 'mount', themeTokens: { 'color-primary': 'rgb(1, 2, 3)' } });

    // Before the fix the harness began `case 'mount'` with `endTextEdit(false)`,
    // which restores `editing.original` and posts no `textCommit`: the typed
    // characters were gone, with no message and no undo entry.
    expect(await f.textOf(HEADING), 'a theme update ate the characters the human had just typed')
      .toBe('Welcome EDITED');
    expect(await f.themeCss(), 'the theme never reached the frame').toContain('--theme-color-primary');
    expect(await f.errors(), 'a doc-less mount reported an error').toEqual([]);
  }, 180_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('R4-2 · a mount that DOES replace the document still ends the edit', async () => {
    const f = await mountFrame(docOf({ mid: HEADING, tag: 'UI.Heading', text: 'Welcome' }));
    await f.send({ t: 'beginTextEdit', mid: HEADING });
    await bare!.keyboard.type('Welcome EDITED');
    expect(await f.textOf(HEADING)).toBe('Welcome EDITED');

    // The control for the test above: a real state transfer is still allowed to
    // take the edit down with it, because the tree it edited is being replaced.
    await f.send({ t: 'mount', doc: docOf({ mid: HEADING, tag: 'UI.Heading', text: 'Replaced' }) });
    expect(await f.textOf(HEADING)).toBe('Replaced');
  }, 180_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('CANVAS-P3-6 · an anchor this frame cannot resolve is a MISS, not an append', async () => {
    const doc = docOf(
      { mid: 'aaaaaaaaaa', tag: 'UI.Text', text: 'one' },
      { mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'two' },
    );
    const f = await mountFrame(doc);

    // The host's `_anchorIndex` THROWS on an unfound anchor, so a frame that
    // appends is diverging from a document the host refused to change.
    await f.patch({
      op: 'el.insert', pageId: 'p1', parentMid: ROOT_MID, before: 'zzzzzzzzzz',
      node: { mid: 'dddddddddd', tag: 'UI.Text', text: 'ghost' },
    });
    expect(await f.order(), 'an unresolvable anchor was silently appended')
      .toEqual([ROOT_MID, 'aaaaaaaaaa', 'bbbbbbbbbb']);
    const errs = await f.errors();
    expect(errs.join(' | '), 'the divergence was not reported').toContain('resync needed');
  }, 180_000);
});
