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
 * Plan 29 — the Manage Plugins tab. The markup, styles and script are static
 * assets in media/plugins/ (index.html, plugins.css, plugins.js); this module
 * reads the template once and fills the per-load placeholders, the same way
 * connectionsContent.ts does for the Connections tab.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

let _cachedTemplate: string | null = null;

export function getPluginsContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media', 'plugins');
  if (_cachedTemplate === null || process.env.MYSTI_DEV === '1') {
    try {
      _cachedTemplate = fs.readFileSync(vscode.Uri.joinPath(mediaRoot, 'index.html').fsPath, 'utf8');
    } catch (err) {
      console.error('[Mysti] Failed to load plugins panel template:', err);
      return '<!DOCTYPE html><html><body><p>Failed to load Mysti Plugins assets. Please reinstall the extension.</p></body></html>';
    }
  }
  const values: Record<string, string> = {
    nonce: getNonce(),
    cspSource: webview.cspSource,
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'plugins.css')).toString(),
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'plugins.js')).toString(),
  };
  return _cachedTemplate.replace(/\{\{(\w+)\}\}/g, (m, key: string) => values[key] ?? m);
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
