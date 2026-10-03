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
 * Plan 32: chat.js creates the agent map at load, so the module has to be on
 * the page first, under the same nonce and cache-busting URI as every other
 * chat asset. A missing or late tag degrades to "no map" silently.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import type * as vscode from 'vscode';
import { getWebviewContent } from '../../src/webview/webviewContent';

const ROOT = path.resolve(__dirname, '..', '..');

describe('agent map loader', () => {
  it('emits agentMap.js before chat.js with a nonce and a fresh asset URI', () => {
    const webview = {
      cspSource: 'vscode-resource://test',
      asWebviewUri: (uri: vscode.Uri) => ({ toString: () => 'vscode-resource://test' + uri.fsPath }),
    } as vscode.Webview;
    const html = getWebviewContent(webview, { fsPath: ROOT, path: ROOT } as vscode.Uri, '1.2.3');
    const dom = new JSDOM(html);
    try {
      const scripts = [...dom.window.document.querySelectorAll('script[src]')];
      const mapIndex = scripts.findIndex(script => script.getAttribute('src')?.includes('/agentMap.js?'));
      const chatIndex = scripts.findIndex(script => script.getAttribute('src')?.includes('/chat.js?'));
      expect(mapIndex).toBeGreaterThan(-1);
      expect(mapIndex).toBeLessThan(chatIndex);
      expect(scripts[mapIndex].getAttribute('nonce')).toHaveLength(32);
      expect(scripts[mapIndex].getAttribute('src')).toContain(
        '?v=' + fs.statSync(path.join(ROOT, 'media/chat/agentMap.js')).mtimeMs,
      );
      expect(html).not.toContain('{{agentMapJsUri}}');
      // The shell and the pill the module drives ship in the markup.
      expect(dom.window.document.getElementById('agent-map')?.getAttribute('role')).toBe('dialog');
      expect(dom.window.document.querySelector('.input-status-line > #agent-map-pill.hidden')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });
});
