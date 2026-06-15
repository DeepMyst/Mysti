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
 * Plan 05 — the canvas webview is now the three-pane design studio (pages rail /
 * live sandboxed page / inspector), driven from Mysti chat (no in-canvas chat).
 * This module is a thin loader: it reads the static shell from media/canvas/,
 * fills the {{placeholders}}, and injects all dynamic state through a single
 * inline boot object (window.__MYSTI_CANVAS_BOOT__) that media/canvas/canvas.js
 * reads. The agent/MCP wiring (pages arriving live from chat) is layered on
 * later via postMessage; for now the boot seeds sample scaffold pages so the new
 * UI renders immediately.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getScaffold } from '../managers/CanvasScaffolds';
import { THEME_PRESETS, getThemePreset } from '../managers/CanvasThemePresets';
import { getFormat } from '../managers/CanvasFormats';

/** Inner CSP for the per-page sandboxed iframes — runtime is inlined as text. */
const SANDBOX_INNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; connect-src 'none';";

const SAMPLE_SCAFFOLDS = ['dashboard', 'landing', 'mobile-home', 'login', 'settings'];

// Module-level caches (read once per extension-host process).
let _templateCache: string | null = null;
const _runtimeCache: Record<string, string> = {};

function readFileCached(p: string): string {
  if (_runtimeCache[p] === undefined || process.env.MYSTI_DEV === '1') {
    _runtimeCache[p] = fs.readFileSync(p, 'utf8');
  }
  return _runtimeCache[p];
}

function loadTemplate(extensionUri: vscode.Uri): string {
  if (_templateCache === null || process.env.MYSTI_DEV === '1') {
    _templateCache = fs.readFileSync(path.join(extensionUri.fsPath, 'media', 'canvas', 'index.html'), 'utf8');
  }
  return _templateCache;
}

function sandboxPath(extensionUri: vscode.Uri, file: string): string {
  return path.join(extensionUri.fsPath, 'resources', 'canvas-sandbox', file);
}

export function getCanvasContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  _version: string = '0.0.0'
): string {
  const nonce = getNonce();
  const cspSource = webview.cspSource;

  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'canvas.css')).toString();
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'canvas.js')).toString();

  // Inline the sandbox runtime (matches the proven inner-CSP pattern: scripts
  // run inline in the no-same-origin iframe, no network dependency).
  const runtimeContent = [
    readFileCached(sandboxPath(extensionUri, 'react.production.min.js')),
    readFileCached(sandboxPath(extensionUri, 'react-dom.production.min.js')),
    readFileCached(sandboxPath(extensionUri, 'babel.min.js')),
    readFileCached(sandboxPath(extensionUri, 'ui-primitives.js')),
  ];
  const harnessContent = readFileCached(sandboxPath(extensionUri, 'harness.js'));

  // Sample artifact (scaffold pages + clean-saas theme) so the new UI renders
  // immediately; replaced by the real linked artifact once chat-wiring lands.
  const theme = getThemePreset('clean-saas')!.theme;
  const pages = SAMPLE_SCAFFOLDS.map((id, i) => {
    const s = getScaffold(id)!;
    return { id: `sample-${i}`, version: 1, mode: 'jsx' as const, jsxSource: s.jsx, actionTitle: s.name };
  });
  const desktop = getFormat('desktop')!;
  const deviceFormats = ['desktop', 'web', 'tablet', 'mobile'].map(fid => {
    const f = getFormat(fid)!;
    return { formatId: f.formatId, width: f.width, height: f.height, kind: f.kind, label: `${f.formatId} (${f.width}×${f.height})` };
  });
  const presets = THEME_PRESETS.map(p => ({ id: p.id, name: p.name, dark: p.dark, theme: p.theme }));

  const boot = {
    artifact: {
      id: 'sample', name: 'Sample App (sample data)', kind: 'screens',
      format: { formatId: desktop.formatId, width: desktop.width, height: desktop.height, kind: desktop.kind },
      theme, pages,
    },
    presets, deviceFormats, activeThemeId: 'clean-saas',
    runtimeContent, harnessContent, innerCsp: SANDBOX_INNER_CSP,
    capabilities: [{ label: 'fal', on: false }, { label: 'Stitch', on: false }, { label: 'Figma', on: false }],
  };

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="`
    + `default-src 'none'; `
    + `img-src ${cspSource} data: blob: https:; media-src data: blob:; `
    + `frame-src 'self' blob: data:; child-src 'self' blob: data:; `
    + `style-src ${cspSource} 'unsafe-inline'; `
    + `script-src 'nonce-${nonce}' ${cspSource}; `
    + `font-src ${cspSource} https: data:; connect-src ${cspSource} https: data:;">`;

  // Escape `<` so JSX/runtime content in the boot JSON can't break out of the
  // <script> tag (e.g. a literal `</script>`); `<` is valid JSON.
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');

  return loadTemplate(extensionUri)
    .replace('{{cspMeta}}', cspMeta)
    .replace('{{cssUri}}', cssUri)
    .replace('{{jsUri}}', jsUri)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace('{{boot}}', `window.__MYSTI_CANVAS_BOOT__ = ${bootJson};`);
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
  return text;
}
