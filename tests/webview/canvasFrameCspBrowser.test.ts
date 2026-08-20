/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * A live artboard frame must actually RUN under the shell's real CSP.
 *
 * A `srcdoc` document inherits its parent's Content-Security-Policy in Chromium,
 * and the canvas shell ships `script-src 'nonce-<random>' <cspSource>` with no
 * `'unsafe-inline'`. The frame's own meta cannot widen an inherited policy, so
 * un-nonced `<script>` tags carrying React, the UI primitives and `harness.js`
 * were all refused: the harness never ran, `frame_hello` was never posted, no
 * MessagePort was ever bound, and the opaque page background painted a blank
 * rectangle over the static preview. Every artboard was blank in production.
 *
 * EVERY other browser test in this suite strips the CSP (`.replace('{{cspMeta}}',
 * '')`) before loading the shell — they remove the exact thing that broke. This
 * one keeps it, which is the whole point of the file.
 *
 * Round 4 added the two failures that survived the nonce fix, both of them
 * policy failures a frame cannot report and no unit test can see:
 *
 * - a **legacy JSX** artboard still rendered blank, because the inherited policy
 *   has no `'unsafe-eval'` and the in-frame compiler needs it;
 * - every **`asset://` image** was blocked in a live artboard on VS Code
 *   desktop, because the origin the frame was told to allow is not a legal CSP
 *   source expression and Chromium discarded it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { buildFrameDocument } from '../../src/webview/canvas/sandboxDoc';
import { assetCspSource } from '../../src/webview/canvas/boot';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import type { ArtifactPage } from '../../src/types';

const NONCE = 'testnonce0123456789';
/**
 * The shell's real policy shape (src/webview/canvasContent.ts). `img-src`
 * carries `https:` there, so the INHERITED half never blocks a webview asset —
 * the block measured in R4-2 is entirely the frame's own hardened policy.
 */
const SHELL_CSP = `default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; script-src 'nonce-${NONCE}';`;

const PAGE: ArtifactPage = {
  id: 'p1', version: 1, actionTitle: 'Login', boardPos: { x: 0, y: 0 },
  doc: { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Sign in' }] },
};

/**
 * A page parked by `migratePage` because its JSX fell outside the compilable
 * subset — the shape every pre-Plan-22 design carries at least one of.
 */
const LEGACY_PAGE: ArtifactPage = {
  id: 'p2', version: 1, actionTitle: 'Pricing', boardPos: { x: 0, y: 0 },
  doc: { mid: 'cccccccccc', tag: 'UI.Screen' },
  legacy: { mode: 'jsx', source: 'function Page(){ return <div>LEGACY BODY</div>; }' },
  compileError: 'unsupported expression at 3:11',
};

/** What `asWebviewUri` returns for the artifact's assets dir on VS Code DESKTOP. */
const DESKTOP_ASSET_BASE = 'https://file+.vscode-resource.vscode-cdn.net/Users/x/.mysti/canvas/a1/assets';
const DESKTOP_ASSET_URL = `${DESKTOP_ASSET_BASE}/deadbeef0011.png`;

let browser: Browser | undefined;
let page: Page | undefined;
let unavailable: string | null = null;

/** Mount a frame document as srcdoc under a parent carrying the shell CSP. */
async function mount(frameDoc: string): Promise<{ messages: string[]; violations: string[] }> {
  const violations: string[] = [];
  page!.on('console', m => { if (/Content Security Policy/i.test(m.text())) { violations.push(m.text()); } });
  await page!.setContent(
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SHELL_CSP}">`
    + `<script nonce="${NONCE}">window.__msgs=[];addEventListener('message',e=>{try{window.__msgs.push(String(e.data&&e.data.type||e.data&&e.data.t||''))}catch(_){}} )</script>`
    + `<iframe id="f" sandbox="allow-scripts"></iframe>`,
    { waitUntil: 'load' },
  );
  await page!.evaluate(doc => {
    (document.getElementById('f') as HTMLIFrameElement).srcdoc = doc;
  }, frameDoc);
  await page!.waitForTimeout(900);
  const messages = await page!.evaluate(() => (window as unknown as { __msgs: string[] }).__msgs);
  return { messages, violations };
}

function frameDoc(nonce: string | undefined): string {
  return buildFrameDocument({
    page: PAGE,
    theme: getThemePreset('clean-saas')!.theme,
    format: getFormat('desktop')!,
    runtime: { scripts: ['window.__ran=(window.__ran||0)+1;'], harness: 'parent.postMessage({type:"frame_hello"},"*");' },
    nonce,
  });
}

/**
 * A doc frame that reports every CSP violation it suffers and then tries to
 * load an image from the desktop webview asset origin. A BLOCKED load fires
 * `securitypolicyviolation`; an ALLOWED one fails DNS instead, which fires
 * nothing — so the absence of `violation:img-src` is the measurement.
 */
function imageFrameDoc(imgSources: readonly string[]): string {
  return buildFrameDocument({
    page: PAGE,
    theme: getThemePreset('clean-saas')!.theme,
    format: getFormat('desktop')!,
    runtime: {
      scripts: [],
      harness:
        `addEventListener('securitypolicyviolation',function(e){`
        + `parent.postMessage({type:'violation:'+e.violatedDirective},'*');});`
        + `var i=document.createElement('img');i.src=${JSON.stringify(DESKTOP_ASSET_URL)};`
        + `document.body.appendChild(i);`
        + `parent.postMessage({type:'frame_hello'},'*');`,
    },
    imgSources,
    nonce: NONCE,
  });
}

/** A legacy JSX frame that reports whether it can eval, and what it painted. */
function legacyFrameDoc(nonce?: string, csp?: string): string {
  return buildFrameDocument({
    page: LEGACY_PAGE,
    theme: getThemePreset('clean-saas')!.theme,
    format: getFormat('desktop')!,
    runtime: {
      scripts: ['window.__ran=(window.__ran||0)+1;'],
      babel: 'window.BabelStandaloneMarker=1;',
      harness:
        `var ok=true;try{new Function('return 1')();}catch(e){ok=false;}`
        + `parent.postMessage({type:'eval:'+ok},'*');`
        + `parent.postMessage({type:'text:'+((document.body.innerText||'').replace(/\\s+/g,' ').trim())},'*');`,
    },
    nonce,
    csp,
  });
}

describe('artboard frame under the shell CSP (real browser)', () => {
  beforeAll(async () => {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
      page = await browser.newPage();
    } catch (err) { unavailable = err instanceof Error ? err.message : String(err); }
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('runs the frame runtime when the nonce is stamped', async () => {
    if (unavailable) { console.warn('[Mysti] skipping — Chromium unavailable:', unavailable); return; }
    const { messages, violations } = await mount(frameDoc(NONCE));
    expect(violations, `CSP violations: ${violations.join(' | ')}`).toHaveLength(0);
    expect(messages).toContain('frame_hello');
  }, 120_000);

  it('is BLOCKED without the nonce — the bug this file exists for', async () => {
    if (unavailable) { return; }
    const { messages, violations } = await mount(frameDoc(undefined));
    expect(messages).not.toContain('frame_hello');
    expect(violations.length).toBeGreaterThan(0);
  }, 120_000);

  it('stamps the nonce onto every script tag it emits', () => {
    const doc = frameDoc(NONCE);
    const tags = doc.match(/<script[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, `un-nonced script tag: ${tag}`).toContain(`nonce="${NONCE}"`);
    }
  });

  it('omits the nonce attribute entirely for standalone documents (export, PNG)', () => {
    expect(frameDoc(undefined)).not.toContain('nonce=');
  });

  /* ── R4-2: asset:// images in a live artboard on VS Code desktop ── */

  describe('webview asset images (R4-2)', () => {
    it('derives a source expression Chromium can actually parse', () => {
      const source = assetCspSource(DESKTOP_ASSET_BASE);
      // `+` is not a CSP host-char: an origin carrying it is discarded wholesale
      // ("contains an invalid source … It will be ignored"), so returning the
      // literal origin is the same as returning nothing.
      expect(source).not.toBeNull();
      expect(source).not.toContain('+');
      expect(assetCspSource('vscode-webview://0a1b/assets')).toBe('vscode-webview://0a1b');
      expect(assetCspSource(undefined)).toBeNull();
    });

    it('carries that source into the frame policy', () => {
      const source = assetCspSource(DESKTOP_ASSET_BASE)!;
      const doc = imageFrameDoc([source]);
      // Not merely present in the file — present in `img-src`, past the
      // structural filter that silently dropped the old value.
      const imgSrc = /img-src ([^;]+);/.exec(doc)![1];
      expect(imgSrc.split(/\s+/)).toContain(source);
    });

    it('lets a live artboard load an image from the desktop asset origin', async () => {
      if (unavailable) { return; }
      const { messages } = await mount(imageFrameDoc([assetCspSource(DESKTOP_ASSET_BASE)!]));
      expect(messages).toContain('frame_hello');
      expect(messages.filter(m => m.startsWith('violation:'))).toEqual([]);
    }, 120_000);

    it('and blocks it when no origin is allowed — the control for the probe', async () => {
      if (unavailable) { return; }
      const { messages } = await mount(imageFrameDoc([]));
      expect(messages).toContain('violation:img-src');
    }, 120_000);
  });

  /* ── R4-1: legacy JSX artboards ── */

  describe('legacy JSX artboards (R4-1)', () => {
    it('cannot eval inside the panel — the cause, measured', async () => {
      if (unavailable) { return; }
      const { messages } = await mount(legacyFrameDoc(NONCE));
      // The frame's own meta grants `'unsafe-eval'`; the INHERITED shell policy
      // does not, and an inherited policy cannot be widened. `new Function`
      // therefore throws, which is why the in-frame compiler can never run here.
      expect(messages).toContain('eval:false');
    }, 120_000);

    it('paints an honest notice instead of a blank rectangle', async () => {
      if (unavailable) { return; }
      const { messages } = await mount(legacyFrameDoc(NONCE));
      const text = messages.find(m => m.startsWith('text:')) ?? '';
      expect(text, 'the frame rendered nothing at all').not.toBe('text:');
      // `innerText` is the RENDERED text, so the badge arrives uppercased by
      // `text-transform` — which is itself proof that the notice is laid out
      // and painted rather than merely present in the source.
      expect(text).toMatch(/code page/i);
      expect(text).toContain('Present');
    }, 120_000);

    it('ships neither the 2.98 MB compiler nor the page source to a frame that cannot compile', () => {
      const doc = legacyFrameDoc(NONCE);
      expect(doc).not.toContain('BabelStandaloneMarker');
      expect(doc).not.toContain('LEGACY BODY');
      expect(doc).toContain('data-mode="static"');
      expect(doc).toContain('unsupported expression at 3:11');
    });

    it('still compiles where eval IS available (Present, export bundle, PNG capture)', () => {
      const doc = legacyFrameDoc(undefined);
      expect(doc).toContain('data-mode="jsx"');
      expect(doc).toContain('BabelStandaloneMarker');
      expect(doc).toContain('LEGACY BODY');
    });

    it('falls back to the notice for any standalone policy that denies eval', () => {
      const doc = legacyFrameDoc(undefined, "default-src 'none'; script-src 'unsafe-inline';");
      expect(doc).toContain('Code page');
      expect(doc).not.toContain('BabelStandaloneMarker');
    });
  });
});
