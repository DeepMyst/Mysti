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
 * Loader for the DeepMyst Connections panel webview (Plan 04 Phase 2).
 * Assets live in `media/connections/` (index.html + connections.css +
 * connections.js); this module reads the template once and substitutes the
 * per-load placeholders (nonce / asset URIs).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

let _cachedTemplate: string | null = null;

function _substitutePlaceholders(template: string, replacements: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

/**
 * Returns the HTML for the Connections panel (a standalone editor tab).
 */
export function getConnectionsContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media', 'connections');

  if (_cachedTemplate === null || process.env.MYSTI_DEV === '1') {
    try {
      _cachedTemplate = fs.readFileSync(vscode.Uri.joinPath(mediaRoot, 'index.html').fsPath, 'utf8');
    } catch (err) {
      console.error('[Mysti] Failed to load connections panel template:', err);
      return '<!DOCTYPE html><html><body><p>Failed to load Mysti Connections assets. Please reinstall the extension.</p></body></html>';
    }
  }

  return _substitutePlaceholders(_cachedTemplate, {
    nonce,
    cspSource: webview.cspSource,
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'connections.css')).toString(),
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'connections.js')).toString(),
  });
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
