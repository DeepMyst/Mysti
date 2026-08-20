/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — the canvas shell loader, and nothing else.
 *
 * Two things left this file in Phase 2, and both were load-bearing bugs:
 *
 * 1. **The artifact.** It used to be serialized into the HTML at render time
 *    and never refreshed, so a webview reload (a tab drag, a window restore, a
 *    theme change) painted whatever the design looked like when the panel first
 *    opened. State now arrives over `canvas/hello` in response to
 *    `canvas/ready` — one authoritative transfer, always current (§3.4).
 * 2. **`babel.min.js`.** 2,983,904 bytes — 95% of the 3,144,476-byte runtime —
 *    inlined into this document and then re-inlined into a fresh iframe
 *    `srcdoc` on every single edit. A document-model page needs no JSX
 *    compiler at all, so only *URIs* ship here; the webview fetches React and
 *    the primitives lazily (static previews are already on screen by then) and
 *    fetches Babel only if some artboard is still a `legacy` source page.
 *
 * The shell therefore carries: a view token, four URIs, the static catalogs the
 * chrome needs before any state arrives, and the inner CSP. Nothing else.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactStore } from '../managers/ArtifactStore';
import { listScaffolds } from '../managers/CanvasScaffolds';
import { THEME_PRESETS, getThemePreset } from '../managers/CanvasThemePresets';
import { getFormat } from '../managers/CanvasFormats';
import { SANDBOX_INNER_CSP } from '../managers/CanvasSandbox';
import { mintViewToken } from '../canvas/protocol';
import { CANVAS_BOOT_GLOBAL, type CanvasBoot } from './canvas/boot';
import type { CanvasArtifact } from '../types';

/**
 * A fresh, EMPTY artifact for a project with no saved designs. The canvas never
 * shows placeholder pages — the empty state offers quick-start templates and the
 * chat agent adds real pages. Named after the workspace so users recognize it.
 */
export function buildEmptyCanvasArtifact(name?: string): CanvasArtifact {
  const store = new ArtifactStore();
  const theme = getThemePreset('clean-saas')!.theme;
  return store.createArtifact({ name: name || 'Untitled design', kind: 'screens', theme });
}

/** Devices offered in the top-bar preview switcher. */
const DEVICE_IDS = ['desktop', 'web', 'tablet', 'mobile'];

let _templateCache: string | null = null;

function loadTemplate(extensionUri: vscode.Uri): string {
  if (_templateCache === null || process.env.MYSTI_DEV === '1') {
    _templateCache = fs.readFileSync(path.join(extensionUri.fsPath, 'media', 'canvas', 'index.html'), 'utf8');
  }
  return _templateCache;
}

function sandboxUri(webview: vscode.Webview, extensionUri: vscode.Uri, file: string): string {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'canvas-sandbox', file)).toString();
}

export interface CanvasShellOptions {
  /**
   * The per-view token minted by the host ({@link mintViewToken}) and checked
   * on every arriving client message with `acceptCanvasClientMessage`.
   *
   * Optional only so this signature stays source-compatible while
   * `ChatViewProvider` is wired; when absent a token is minted here and the
   * host will reject every message the view sends, which is loud and safe
   * rather than silently unauthenticated.
   */
  viewToken?: string;
  /** Webview URI prefix for the artifact's `assets/` directory. */
  assetBaseUri?: string;
}

export function getCanvasContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  _version: string = '0.0.0',
  /** Accepted for source compatibility and deliberately NOT baked — see the module docs. */
  _artifact?: CanvasArtifact,
  /** Real connection status chips (from CanvasCapabilityRegistry); fallback = all off. */
  capabilities?: Array<{ label: string; on: boolean }>,
  opts?: CanvasShellOptions,
): string {
  const nonce = getNonce();
  const cspSource = webview.cspSource;

  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'canvas.css')).toString();
  // The compiled webview bundle (webpack `target:'web'` entry), NOT the deleted
  // media/canvas/canvas.js — which hand-mirrored CanvasSandbox and had drifted
  // three ways by the time it was removed (§2.9).
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'canvasWebview.js')).toString();

  if (!opts?.viewToken) {
    console.warn('[Mysti] canvas shell rendered without a host view token; client messages will be rejected');
  }

  const devices = DEVICE_IDS.map(fid => {
    const f = getFormat(fid)!;
    return {
      formatId: f.formatId, width: f.width, height: f.height, kind: f.kind,
      label: `${f.formatId} (${f.width}×${f.height})`,
    };
  });

  const boot: CanvasBoot = {
    viewToken: opts?.viewToken ?? mintViewToken(),
    // The shell's own CSP nonce. A `srcdoc` artboard inherits this policy, so
    // its React/primitives/harness tags must carry the nonce or Chromium
    // refuses them and every live frame renders blank.
    frameNonce: nonce,
    // React + ReactDOM + the 22 UI primitives. Babel is NOT in this list.
    runtimeUris: [
      sandboxUri(webview, extensionUri, 'react.production.min.js'),
      sandboxUri(webview, extensionUri, 'react-dom.production.min.js'),
      sandboxUri(webview, extensionUri, 'ui-primitives.js'),
    ],
    harnessUri: sandboxUri(webview, extensionUri, 'harness.js'),
    // Fetched by the webview ONLY when an artboard is still a legacy source page.
    babelUri: sandboxUri(webview, extensionUri, 'babel.min.js'),
    assetBaseUri: opts?.assetBaseUri,
    innerCsp: SANDBOX_INNER_CSP,
    devices,
    themes: THEME_PRESETS.map(p => ({ id: p.id, name: p.name, dark: p.dark, theme: p.theme })),
    scaffolds: listScaffolds().map(s => ({ id: s.id, name: s.name, description: s.description })),
    activeThemeId: 'clean-saas',
  };

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="`
    + `default-src 'none'; `
    + `img-src ${cspSource} data: blob: https:; media-src data: blob:; `
    + `frame-src 'self' blob: data:; child-src 'self' blob: data:; `
    + `style-src ${cspSource} 'unsafe-inline'; `
    + `script-src 'nonce-${nonce}' ${cspSource}; `
    + `font-src ${cspSource} https: data:; connect-src ${cspSource} https: data:;">`;

  // Escape `<` so nothing in the boot JSON can break out of the <script> tag
  // (e.g. a literal `</script>`); `<` is valid JSON.
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');

  return loadTemplate(extensionUri)
    .replace('{{cspMeta}}', cspMeta)
    .replace('{{cssUri}}', cssUri)
    .replace('{{jsUri}}', jsUri)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace('{{boot}}', `window.${CANVAS_BOOT_GLOBAL} = ${bootJson};`);
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
  return text;
}
