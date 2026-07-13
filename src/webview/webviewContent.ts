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
 * Plan 03 Phase 3c Step 1 — the chat webview's markup, styles, and script
 * were extracted verbatim into static assets under media/chat/
 * (index.html / chat.css / chat.js). This module is now a thin loader:
 * it reads the HTML template (cached at module level), substitutes the
 * per-load placeholders ({{nonce}}, {{cspSource}}, {{resourceBase}}, ...)
 * and injects all formerly-interpolated script values through a single
 * inline bootstrap object (window.__MYSTI_BOOT__) that media/chat/chat.js
 * reads at its former interpolation sites.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PROVIDER_MANIFEST_SCHEMA_VERSION } from '../providers/base/ProviderManifest';

/** Module-level template cache — read once per extension-host process. */
let _htmlTemplateCache: string | null = null;

/**
 * Read media/chat/index.html, caching the result. Set MYSTI_DEV=1 in the
 * extension host's environment to re-read on every call (watch-mode
 * iteration on the static assets without reloading the window).
 */
function _loadHtmlTemplate(extensionUri: vscode.Uri): string {
  if (_htmlTemplateCache !== null && process.env.MYSTI_DEV !== '1') {
    return _htmlTemplateCache;
  }
  const templatePath = path.join(extensionUri.fsPath, 'media', 'chat', 'index.html');
  _htmlTemplateCache = fs.readFileSync(templatePath, 'utf8');
  return _htmlTemplateCache;
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, version: string = '0.0.0'): string {
  const nonce = getNonce();

  // Base URI for everything under resources/ (library scripts, logos, icons).
  const resourceBase = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources')).toString();

  // Extracted chat assets. VSCode caches webview resources by URI and the cache
  // survives a window reload, so a stable URI serves a stale chat.js/chat.css
  // after edits. Append the file's mtime as a cache-busting query so every
  // change forces a fresh fetch (and unchanged files still cache).
  const assetUri = (rel: string[]): string => {
    const fileUri = vscode.Uri.joinPath(extensionUri, ...rel);
    let ver = version;
    try {
      ver = String(fs.statSync(fileUri.fsPath).mtimeMs);
    } catch {
      /* fall back to the extension version */
    }
    return `${webview.asWebviewUri(fileUri).toString()}?v=${ver}`;
  };
  const chatCssUri = assetUri(['media', 'chat', 'chat.css']);
  const chatJsUri = assetUri(['media', 'chat', 'chat.js']);

  // URIs for library scripts loaded lazily by the chat script.
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'mermaid.min.js'));
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'Mysti-Logo.png'));

  // Icon URIs for welcome suggestions and personas
  const iconUris: Record<string, string> = {};
  const iconNames = [
    // Welcome suggestions
    'magnifier', 'eye', 'brush', 'lab', 'lock', 'flash', 'notes', 'recycle', 'rocket', 'package', 'check', 'bug',
    // Personas (additional)
    'architecture', 'gear', 'target', 'microscope', 'hammer', 'chain', 'teacher', 'paint', 'globe', 'tools'
  ];
  for (const name of iconNames) {
    iconUris[name] = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', `${name}.png`)).toString();
  }

  // Provider logos
  const claudeLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'Claude.png')).toString();
  const openaiLogoLightUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'openai.svg')).toString();
  const openaiLogoDarkUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'openai_white.png')).toString();
  const geminiLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'gemini.png.webp')).toString();
  const clineLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'cline.png')).toString();
  const copilotLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'copilot.png')).toString();
  const cursorLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'cursor.png')).toString();
  const openclawLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'openclaw.png')).toString();
  const opencodeLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'opencode.png')).toString();
  const ollamaLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'ollama.png')).toString();
  const localaiLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'localai.png')).toString();
  const qwenLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'qwen.png')).toString();
  const hermesLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'hermes.png')).toString();
  const continueLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'continue.png')).toString();
  const openrouterLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'openrouter.png')).toString();

  // Every value the embedded script used to receive via template-literal
  // interpolation now travels through ONE inline nonce'd bootstrap script
  // (window.__MYSTI_BOOT__) emitted before the external chat.js tag.
  const boot = {
    mermaidUri: mermaidUri.toString(),
    logoUri: logoUri.toString(),
    version,
    iconUris,
    claudeLogoUri,
    openaiLogoLightUri,
    openaiLogoDarkUri,
    geminiLogoUri,
    clineLogoUri,
    copilotLogoUri,
    cursorLogoUri,
    openclawLogoUri,
    opencodeLogoUri,
    ollamaLogoUri,
    localaiLogoUri,
    qwenLogoUri,
    hermesLogoUri,
    continueLogoUri,
    openrouterLogoUri,
    manifestSchemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION
  };
  // Defensive: keep '<' out of the inline <script> body (e.g. '</script>').
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');

  const replacements: Record<string, string> = {
    nonce,
    cspSource: webview.cspSource,
    resourceBase,
    chatCssUri,
    chatJsUri,
    bootJson,
    version
  };

  let html = _loadHtmlTemplate(extensionUri);
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
