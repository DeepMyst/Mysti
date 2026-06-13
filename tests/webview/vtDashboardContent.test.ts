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
 * Plan 03 Phase 3c Step 1 (task 8) — Visual Test Dashboard webview extraction.
 *
 * The dashboard HTML/CSS/JS now live as static assets under
 * media/vt-dashboard/ and getVisualTestDashboardContent() is a thin loader
 * that reads the cached index.html template and substitutes {{placeholders}}.
 * These tests run the REAL loader against the REAL shipped assets, so they
 * cannot drift from the packaged artifact.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getVisualTestDashboardContent } from '../../src/webview/visualTestDashboardContent';

const repoRoot = path.resolve(__dirname, '..', '..');
const mediaDir = path.join(repoRoot, 'media', 'vt-dashboard');

function makeWebview() {
  return {
    cspSource: 'https://test-csp.example',
    asWebviewUri: (uri: { fsPath: string }) => ({
      toString: () => 'vscode-resource://authority' + uri.fsPath
    })
  } as any;
}

const extensionUri = { fsPath: repoRoot, path: repoRoot } as any;

describe('vt-dashboard static assets', () => {
  it('ships index.html, vt-dashboard.css and vt-dashboard.js', () => {
    expect(fs.existsSync(path.join(mediaDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, 'vt-dashboard.css'))).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, 'vt-dashboard.js'))).toBe(true);
  });

  it('assets contain no leftover TS template interpolations', () => {
    for (const file of ['index.html', 'vt-dashboard.css', 'vt-dashboard.js']) {
      const content = fs.readFileSync(path.join(mediaDir, file), 'utf8');
      expect(content, `${file} must not contain \${...}`).not.toMatch(/\$\{/);
    }
  });

  it('vt-dashboard.js carries the dashboard message handlers verbatim', () => {
    const js = fs.readFileSync(path.join(mediaDir, 'vt-dashboard.js'), 'utf8');
    // Outbound messages
    expect(js).toContain("vscode.postMessage({ type: 'dashboardStartVisualTest', payload: { config: config } })");
    expect(js).toContain("vscode.postMessage({ type: 'dashboardCancelVisualTest' })");
    // Inbound messages
    for (const type of [
      'visualTestDashboardConfig',
      'visualTestDashboardAutoStart',
      'visualTestDashboardUpdate',
      'visualTestDashboardCancelled'
    ]) {
      expect(js).toContain(`case '${type}'`);
    }
    // Stream chunk types
    for (const chunk of [
      'visual_test_started',
      'visual_test_screenshot',
      'visual_test_iteration',
      'visual_test_issue',
      'visual_test_fix',
      'visual_test_interaction',
      'visual_test_error',
      'visual_test_complete'
    ]) {
      expect(js).toContain(`case '${chunk}'`);
    }
    // Template-literal unescaping produced real JS escapes (single backslash)
    expect(js).toContain("'\\u2713'");
    expect(js).toContain("'\\u25CB'");
    expect(js).not.toContain('\\\\u2713');
  });
});

describe('getVisualTestDashboardContent loader', () => {
  it('substitutes every placeholder (no {{...}} left in output)', () => {
    const html = getVisualTestDashboardContent(makeWebview(), extensionUri, '1.2.3');
    expect(html).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  });

  it('applies the nonce to CSP, stylesheet link, bootstrap and external script', () => {
    const html = getVisualTestDashboardContent(makeWebview(), extensionUri, '1.2.3');
    const nonceMatch = html.match(/script-src 'nonce-([A-Za-z0-9]{32})'/);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch![1];
    expect(html).toContain(`style-src https://test-csp.example 'nonce-${nonce}'`);
    expect(html).toContain(`<link rel="stylesheet" nonce="${nonce}"`);
    expect(html).toContain(`<script nonce="${nonce}">window.__MYSTI_VT_BOOT__`);
    expect(html).toContain(`<script nonce="${nonce}" src="`);
  });

  it('points the external tags at the media/vt-dashboard assets via asWebviewUri', () => {
    const html = getVisualTestDashboardContent(makeWebview(), extensionUri, '1.2.3');
    expect(html).toContain('vscode-resource://authority' + path.join(mediaDir, 'vt-dashboard.css'));
    expect(html).toContain('vscode-resource://authority' + path.join(mediaDir, 'vt-dashboard.js'));
  });

  it('uses cspSource for img-src and embeds the version in __MYSTI_VT_BOOT__', () => {
    const html = getVisualTestDashboardContent(makeWebview(), extensionUri, '9.8.7');
    expect(html).toContain('img-src https://test-csp.example data:');
    expect(html).toContain('window.__MYSTI_VT_BOOT__ = {"version":"9.8.7"};');
  });

  it('keeps the dashboard markup (header, config form, progress view)', () => {
    const html = getVisualTestDashboardContent(makeWebview(), extensionUri, '1.2.3');
    expect(html).toContain('<span class="vt-header-title">Mysti Visual Test</span>');
    expect(html).toContain('id="vt-config"');
    expect(html).toContain('id="vt-progress"');
    expect(html).toContain('id="vt-start"');
    expect(html).toContain('id="vt-cancel"');
  });

  it('generates a fresh nonce per call (template cached, nonce not)', () => {
    const a = getVisualTestDashboardContent(makeWebview(), extensionUri, '1.2.3');
    const b = getVisualTestDashboardContent(makeWebview(), extensionUri, '1.2.3');
    const nonceOf = (html: string) => html.match(/script-src 'nonce-([A-Za-z0-9]{32})'/)![1];
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });
});
