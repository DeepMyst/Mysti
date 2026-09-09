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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const version = process.env.MYSTI_TEST_VSCODE_VERSION || 'stable';
const vsixPath = process.env.MYSTI_TEST_VSIX_PATH && resolve(process.env.MYSTI_TEST_VSIX_PATH);
// Each run gets fresh editor state and a fresh DevToolsActivePort file. A
// profile under a deep checkout can exceed Unix socket path limits before
// the editor opens, so use a short temporary path and print it for diagnosis.
const userDataDir = mkdtempSync(join(tmpdir(), 'mysti-vscode-'));
console.log(`[Mysti test] VS Code profile: ${userDataDir}`);

export default defineConfig({
  files: 'out-vscode-test/**/*.test.js',
  version,
  // VS Code needs a development extension to start its test runner. For an
  // archive test, that is a separate inert driver: Mysti must load from the
  // installed VSIX, never silently from the checkout beside these tests.
  extensionDevelopmentPath: vsixPath ? './tests-vscode/driver' : '.',
  ...(vsixPath ? { installExtensions: [vsixPath] } : {}),
  // Inspect the actual nested webview through the test editor's loopback CDP
  // endpoint. Port 0 lets Electron allocate a free port without a bind race.
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ],
  env: { MYSTI_TEST_USER_DATA_DIR: userDataDir, MYSTI_TEST_VSIX_PATH: vsixPath },
  // A scratch folder so the canvas has a real workspace to write `.mysti/canvas`
  // into; created by the test's own setup.
  workspaceFolder: './out-vscode-test/fixture-workspace',
  mocha: { ui: 'bdd', timeout: 120_000, color: false, parallel: false },
});
