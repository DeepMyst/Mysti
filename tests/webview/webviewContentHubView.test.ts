/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWebviewContent } from '../../src/webview/webviewContent';

const ROOT = path.resolve(__dirname, '../..');
const webview = {
  cspSource: 'csp',
  asWebviewUri: (u: { fsPath: string }) => ({ toString: () => u.fsPath }),
} as unknown as vscode.Webview;
const ext = vscode.Uri.file(ROOT) as unknown as vscode.Uri;

describe('Plan 31 — getWebviewContent view option', () => {
  it('leaves the chat page untouched by default', () => {
    const html = getWebviewContent(webview, ext, '1');
    expect(html).toContain('<body>');
    expect(html).not.toContain('<body class="view-hub">');
  });

  it('marks the Mysti tab page', () => {
    expect(getWebviewContent(webview, ext, '1', { view: 'hub' })).toContain('<body class="view-hub">');
  });
});
