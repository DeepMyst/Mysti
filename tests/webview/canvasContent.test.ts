/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 05 — the canvas webview is the three-pane design studio. canvasContent.ts
 * is a thin loader over media/canvas/. These tests assert the generated document
 * is well-formed (shell structure, asset URIs, a parseable boot object with the
 * sample artifact) and preserves the F-6 sandbox guarantees in the new
 * architecture (local runtime, no unpkg, allow-scripts only, srcdoc not Blob).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getCanvasContent } from '../../src/webview/canvasContent';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { SANDBOX_INNER_CSP } from '../../src/managers/CanvasSandbox';

const repoRoot = path.resolve(__dirname, '..', '..');

function makeWebview() {
  return {
    cspSource: 'vscode-resource://test',
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => 'vscode-resource://authority' + uri.fsPath }),
  } as any;
}
const extensionUri = { fsPath: repoRoot, path: repoRoot } as any;

let html: string;
beforeAll(() => { html = getCanvasContent(makeWebview(), extensionUri, '1.2.3'); });

/** Pull the injected window.__MYSTI_CANVAS_BOOT__ object back out and parse it. */
function extractBoot(): any {
  const marker = '__MYSTI_CANVAS_BOOT__ = ';
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = html.slice(start + marker.length);
  const close = rest.indexOf('</script>');
  const json = rest.slice(0, close).replace(/;\s*$/, '');
  return JSON.parse(json);
}

describe('three-pane shell structure', () => {
  it('renders the rail / board / inspector panes and top-bar switchers', () => {
    expect(html).toContain('id="pages-rail"');
    expect(html).toContain('id="board"');
    expect(html).toContain('id="inspector"');
    expect(html).toContain('id="device-select"');
    expect(html).toContain('id="theme-select"');
    // No legacy chrome: no in-canvas prompt bar, no Design/Assets/Themes/Code tabs.
    expect(html).not.toContain('Type a prompt');
  });

  it('loads the static canvas.css + canvas.js via webview URIs', () => {
    expect(html).toContain('media/canvas/canvas.css');
    expect(html).toContain('media/canvas/canvas.js');
  });
});

describe('boot state (real artifact, no placeholders)', () => {
  it('injects a parseable boot object', () => {
    expect(() => extractBoot()).not.toThrow();
  });

  it('with no artifact, boots an EMPTY design (no placeholder pages) + presets/devices/templates', () => {
    const boot = extractBoot();
    expect(boot.artifact.kind).toBe('screens');           // app/website is primary
    expect(boot.artifact.format.formatId).toBe('desktop');
    expect(boot.artifact.pages).toEqual([]);              // never fake "Sample App" pages
    expect(boot.artifact.name).toBe('Untitled design');
    expect(boot.presets.length).toBeGreaterThanOrEqual(5);
    expect(boot.scaffolds.length).toBeGreaterThanOrEqual(4); // quick-start templates instead
    const devices = boot.deviceFormats.map((d: any) => d.formatId);
    expect(devices).toEqual(expect.arrayContaining(['mobile', 'desktop']));
    expect(boot.capabilities.map((c: any) => c.label)).toEqual(expect.arrayContaining(['fal', 'Figma']));
  });

  it('boots from a provided real artifact verbatim (the project designs)', () => {
    const store = new ArtifactStore({ getRoot: () => null });
    const real = store.createArtifact({ name: 'Acme designs', kind: 'screens' });
    store.insertPage(real, store.makePage({ mode: 'html', htmlSource: '<h1>Checkout</h1>', actionTitle: 'Checkout' }));
    const bootHtml = getCanvasContent(makeWebview(), extensionUri, '0.0.0', real);
    const marker = '__MYSTI_CANVAS_BOOT__ = ';
    const rest = bootHtml.slice(bootHtml.indexOf(marker) + marker.length);
    const boot = JSON.parse(rest.slice(0, rest.indexOf('</script>')).replace(/;\s*$/, ''));
    expect(boot.artifact.name).toBe('Acme designs');
    expect(boot.artifact.pages.map((p: any) => p.actionTitle)).toEqual(['Checkout']);
  });
});

describe('F-6 sandbox guarantees preserved', () => {
  const sandboxDir = path.join(repoRoot, 'resources', 'canvas-sandbox');

  it('ships the runtime locally and inlines it (no unpkg, no external src)', () => {
    expect(fs.existsSync(path.join(sandboxDir, 'react.production.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(sandboxDir, 'babel.min.js'))).toBe(true);
    expect(html).not.toContain('unpkg.com');
    expect(html).toContain('@license React'); // runtime inlined into the boot
  });

  it('the canvas.js renderer uses allow-scripts only + srcdoc (not Blob/same-origin)', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'media', 'canvas', 'canvas.js'), 'utf8');
    expect(js).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(js).not.toContain('allow-same-origin');
    expect(js).toContain('iframe.srcdoc');
    expect(js).not.toContain('createObjectURL');
    // sanity: the renderer parses as JS
    expect(() => new Function(js)).not.toThrow();
  });

  it('carries a CSP and an inner sandbox CSP for the page iframes', () => {
    expect(html).toContain('Content-Security-Policy');
    const boot = extractBoot();
    expect(boot.innerCsp).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
  });

  it('the webview inner CSP stays in sync with the TS builder mirror (6.2)', () => {
    // buildPageSrcdoc (media/canvas/canvas.js, fed innerCsp by canvasContent.ts)
    // and buildPageDocument (src/managers/CanvasSandbox.ts) are mirrors; the
    // TS builder's default CSP must be the same policy the webview injects.
    const boot = extractBoot();
    expect(boot.innerCsp).toBe(SANDBOX_INNER_CSP);
  });

  it('the message handler guards against spoofed events from the page iframe (6.4a)', () => {
    // canvas.js is untypechecked webview JS that no test executes, so this is
    // a text-level guard: state-mutating messages (canvasArtifactUpdate) must
    // be dropped for ANY embedded-frame source. W4 review upgraded the guard
    // from a direct-contentWindow blocklist (bypassable via a NESTED iframe)
    // to an allowlist: only null/this-window sources pass.
    const js = fs.readFileSync(path.join(repoRoot, 'media', 'canvas', 'canvas.js'), 'utf8');
    const handler = js.slice(js.indexOf("window.addEventListener('message'"));
    expect(handler).toContain('fromEmbeddedFrame');
    expect(handler).toMatch(/ev\.source && ev\.source !== window/);
    // The guard must run before the artifact-update branch mutates state.
    expect(handler.indexOf('if (fromEmbeddedFrame) { return; }')).toBeGreaterThan(-1);
    expect(handler.indexOf('if (fromEmbeddedFrame) { return; }'))
      .toBeLessThan(handler.indexOf("d.type === 'canvasArtifactUpdate'"));
  });
});
