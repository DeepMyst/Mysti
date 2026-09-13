/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — the canvas shell loader.
 *
 * Phase 2 turns `canvasContent.ts` into a shell and nothing else, and both
 * things it stopped shipping were bugs rather than mere weight:
 *
 * - **the artifact**, which used to be inlined once and never refreshed, so a
 *   webview reload rendered a stale design;
 * - **`babel.min.js`**, 2,983,904 of the 3,144,476 runtime bytes that the old
 *   renderer re-inlined into a fresh iframe `srcdoc` on every single edit.
 *
 * These tests assert both absences, plus the boot contract the compiled webview
 * actually reads (`readBoot`), plus the sandbox guarantees that must survive
 * the rewrite.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getCanvasContent, buildEmptyCanvasArtifact } from '../../src/webview/canvasContent';
import { readBoot, makeAssetResolver, CANVAS_BOOT_GLOBAL } from '../../src/webview/canvas/boot';
import { SANDBOX_INNER_CSP } from '../../src/managers/CanvasSandbox';
import { mintViewToken } from '../../src/canvas/protocol';

const repoRoot = path.resolve(__dirname, '..', '..');

function makeWebview() {
  return {
    cspSource: 'vscode-resource://test',
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => 'vscode-resource://authority' + uri.fsPath.replace(/\\/g, '/') }),
  } as never;
}
const extensionUri = { fsPath: repoRoot, path: repoRoot } as never;

const TOKEN = mintViewToken();
let html: string;
beforeAll(() => {
  html = getCanvasContent(makeWebview(), extensionUri, '1.2.3', undefined, undefined, { viewToken: TOKEN });
});

/** Pull the injected boot object back out, through the SAME reader the webview uses. */
function extractBoot() {
  const marker = `${CANVAS_BOOT_GLOBAL} = `;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = html.slice(start + marker.length);
  const json = rest.slice(0, rest.indexOf('</script>')).replace(/;\s*$/, '');
  const boot = readBoot({ [CANVAS_BOOT_GLOBAL]: JSON.parse(json) });
  expect(boot).not.toBeNull();
  return boot!;
}

describe('three-pane shell structure', () => {
  it('renders the rail / board / inspector panes and top-bar switchers', () => {
    expect(html).toContain('id="pages-rail"');
    expect(html).toContain('id="board"');
    expect(html).toContain('id="inspector"');
    expect(html).toContain('id="device-select"');
    expect(html).toContain('id="theme-select"');
    expect(html).not.toContain('Type a prompt');
  });

  it('loads the COMPILED webview bundle, not the deleted JS mirror', () => {
    expect(html).toContain('dist/canvasWebview.js');
    expect(html).not.toContain('media/canvas/canvas.js');
    expect(fs.existsSync(path.join(repoRoot, 'media', 'canvas', 'canvas.js'))).toBe(false);
  });
});

describe('no baked artifact state', () => {
  it('ships no pages, no theme and no artifact id — state arrives over canvas/hello', () => {
    const store = buildEmptyCanvasArtifact('Acme designs');
    const withArtifact = getCanvasContent(makeWebview(), extensionUri, '0.0.0', store, undefined, { viewToken: TOKEN });
    // Even when a real artifact is passed for source compatibility, nothing of
    // it is serialized: a reload cannot render a stale design.
    expect(withArtifact).not.toContain('Acme designs');
    expect(withArtifact).not.toContain('"pages"');
    expect(withArtifact).not.toContain('jsxSource');
    const boot = extractBoot();
    expect(Object.prototype.hasOwnProperty.call(boot, 'artifact')).toBe(false);
  });

  it('carries the host-minted view token so the FIRST canvas/ready is authenticated', () => {
    expect(extractBoot().viewToken).toBe(TOKEN);
  });

  it('still mints a token when the host forgot to pass one, and says so', () => {
    const orphan = getCanvasContent(makeWebview(), extensionUri, '0.0.0');
    const marker = `${CANVAS_BOOT_GLOBAL} = `;
    const rest = orphan.slice(orphan.indexOf(marker) + marker.length);
    const boot = JSON.parse(rest.slice(0, rest.indexOf('</script>')).replace(/;\s*$/, ''));
    expect(typeof boot.viewToken).toBe('string');
    expect(boot.viewToken.length).toBe(32);
    expect(boot.viewToken).not.toBe(TOKEN);       // and so the host will reject it
  });
});

describe('2.98 MB of Babel leaves the shell', () => {
  it('inlines no runtime at all — only URIs', () => {
    expect(html).not.toContain('@license React');
    expect(html.length).toBeLessThan(60_000);
    const boot = extractBoot();
    expect(boot.runtimeUris).toHaveLength(3);
    expect(boot.runtimeUris.join(' ')).not.toContain('babel');
    expect(boot.harnessUri).toContain('harness.js');
  });

  it('offers Babel as a separate lazily-fetched URI for legacy pages only', () => {
    const boot = extractBoot();
    expect(boot.babelUri).toContain('babel.min.js');
    // The 2.98 MB file is still shipped in the VSIX; it is simply not loaded
    // unless an artboard is a legacy source page.
    expect(fs.existsSync(path.join(repoRoot, 'resources', 'canvas-sandbox', 'babel.min.js'))).toBe(true);
  });

  it('allows the lazy fetch in the shell CSP', () => {
    expect(html).toContain('connect-src vscode-resource://test');
  });
});

describe('boot catalogs the chrome needs before any state arrives', () => {
  it('ships devices, themes and quick-start templates', () => {
    const boot = extractBoot();
    expect(boot.devices.map(d => d.formatId)).toEqual(expect.arrayContaining(['mobile', 'desktop']));
    expect(boot.themes.length).toBeGreaterThanOrEqual(5);
    expect(boot.scaffolds.length).toBeGreaterThanOrEqual(4);
    expect(boot.innerCsp).toBe(SANDBOX_INNER_CSP);
  });

  it('readBoot rejects a payload with no view token rather than half-booting', () => {
    expect(readBoot(null)).toBeNull();
    expect(readBoot({})).toBeNull();
    expect(readBoot({ [CANVAS_BOOT_GLOBAL]: { viewToken: '' } })).toBeNull();
    expect(readBoot({ [CANVAS_BOOT_GLOBAL]: { viewToken: 'abc' } })?.devices).toEqual([]);
  });
});

describe('asset resolution is traversal-proof', () => {
  const resolve = makeAssetResolver('vscode-resource://authority/assets');

  it('resolves a content-addressed name', () => {
    expect(resolve('asset://a1b2c3.png')).toBe('vscode-resource://authority/assets/a1b2c3.png');
  });

  it('refuses traversal, absolute paths and non-asset schemes', () => {
    for (const ref of [
      'asset://../../.mysti/secrets.json',
      'asset:///etc/passwd',
      'asset://a/../../b.png',
      'https://evil/x.png',
      'asset://',
      `asset://${'a'.repeat(500)}.png`,
    ]) {
      expect(resolve(ref)).toBeNull();
    }
  });

  it('resolves nothing at all when the host gave no asset base', () => {
    expect(makeAssetResolver(undefined)('asset://a.png')).toBeNull();
  });
});

describe('sandbox guarantees survive the rewrite', () => {
  it('still ships the runtime locally (no unpkg, no CDN)', () => {
    const sandboxDir = path.join(repoRoot, 'resources', 'canvas-sandbox');
    expect(fs.existsSync(path.join(sandboxDir, 'react.production.min.js'))).toBe(true);
    expect(html).not.toContain('unpkg.com');
  });

  it('carries a nonce-based SHELL CSP with no inline-script escape', () => {
    // Scoped to the shell's own meta: the frame's inner CSP (which does allow
    // inline scripts, inside a no-same-origin sandbox) rides in the boot JSON
    // and is a deliberately different policy.
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    expect(meta).not.toBeNull();
    const shellCsp = meta![1];
    expect(shellCsp).toContain("default-src 'none'");
    const scriptSrc = /script-src ([^;]+);/.exec(shellCsp)![1];
    expect(scriptSrc).toMatch(/^'nonce-[A-Za-z0-9]{32}'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('escapes < in the boot payload so it cannot open a tag', () => {
    const injected = getCanvasContent(makeWebview(), extensionUri, '0.0.0', undefined, undefined, {
      viewToken: TOKEN, assetBaseUri: '</script><script>alert(1)</script>',
    });
    expect(injected).not.toContain('</script><script>alert(1)');
    expect(injected).toContain('\\u003c');
  });
});

describe('asset CSP source derivation', () => {
  it('derives the origin a doc frame must allow in img-src', async () => {
    const { assetCspSource } = await import('../../src/webview/canvas/boot');
    expect(assetCspSource('vscode-webview://0a1b/assets')).toBe('vscode-webview://0a1b');
    // R4-2: the DESKTOP form. `+` is not a CSP `host-char`, so returning this
    // origin verbatim (what this assertion used to demand) made Chromium
    // discard the whole source and every image in every live artboard was
    // blocked by `img-src data: blob:`. The leading label is wildcarded, which
    // is both legal and narrower than `webview.cspSource`.
    expect(assetCspSource('https://file+.vscode-resource.vscode-cdn.net/a/b'))
      .toBe('https://*.vscode-resource.vscode-cdn.net');
    expect(assetCspSource(undefined)).toBeNull();
    expect(assetCspSource('not a url')).toBeNull();
    expect(assetCspSource('/relative/path')).toBeNull();
    // Never widened into a public suffix or a bare wildcard.
    expect(assetCspSource('https://a+b/x')).toBeNull();
    expect(assetCspSource('https://file+.net/x')).toBeNull();
    expect(assetCspSource('http://localhost:3000/assets')).toBe('http://localhost:3000');
  });
});
