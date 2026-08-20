/*
 * Mysti - AI Coding Agent · SPDX-License-Identifier: Apache-2.0
 *
 * Integration tests that run inside a REAL VS Code.
 *
 * The unit suite (vitest, ~9k tests) mocks `vscode`; the browser suite
 * (playwright) runs the webview markup in bare Chromium. Neither contains VS
 * Code — and every production failure of the canvas so far has been a VS Code
 * HOST behaviour: the frame topology behind `ev.source`, `srcdoc` inheriting the
 * panel CSP, `vscode-resource` asset URIs, panel widths. This is the layer that
 * can see them.
 */
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out-vscode-test/**/*.test.js',
  version: 'stable',
  // A scratch folder so the canvas has a real workspace to write `.mysti/canvas`
  // into; created by the test's own setup.
  workspaceFolder: './out-vscode-test/fixture-workspace',
  mocha: { ui: 'bdd', timeout: 120_000, color: false },
});
