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
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Module-level cache for the dashboard HTML template.
 * Read from disk once per extension-host session; placeholders are
 * substituted per call (nonce/URIs differ per webview).
 */
let _cachedTemplate: string | null = null;

/**
 * Replace every `{{key}}` placeholder in the template.
 * Uses split/join (not String.replace) so `$` sequences in values
 * (e.g. webview resource URIs) are never interpreted as patterns.
 */
function _substitutePlaceholders(template: string, replacements: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

/**
 * Returns the HTML content for the Visual Test Dashboard webview panel.
 * This is a standalone editor tab (not the chat sidebar).
 *
 * Assets live in `media/vt-dashboard/` (index.html template +
 * vt-dashboard.css + vt-dashboard.js) and are loaded from disk,
 * keeping the markup/styles/script out of the extension bundle.
 */
export function getVisualTestDashboardContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  version: string = '0.0.0'
): string {
  const nonce = getNonce();
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media', 'vt-dashboard');

  if (_cachedTemplate === null) {
    try {
      _cachedTemplate = fs.readFileSync(
        vscode.Uri.joinPath(mediaRoot, 'index.html').fsPath,
        'utf8'
      );
    } catch (err) {
      console.error('[Mysti] Failed to load visual test dashboard template:', err);
      return '<!DOCTYPE html><html><body><p>Failed to load Mysti Visual Test dashboard assets. Please reinstall the extension.</p></body></html>';
    }
  }

  // Bootstrap payload exposed to the webview script as window.__MYSTI_VT_BOOT__.
  // Escape `<` so the JSON can never terminate the inline <script> block.
  const bootJson = JSON.stringify({ version }).replace(/</g, '\\u003c');

  return _substitutePlaceholders(_cachedTemplate, {
    nonce,
    cspSource: webview.cspSource,
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vt-dashboard.css')).toString(),
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vt-dashboard.js')).toString(),
    bootJson
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
