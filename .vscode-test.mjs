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
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const version = process.env.MYSTI_TEST_VSCODE_VERSION || 'stable';
const profiles = fileURLToPath(new URL('./.vscode-test/profiles/', import.meta.url));
mkdirSync(profiles, { recursive: true });
// Each run gets fresh editor state and a fresh DevToolsActivePort file. Keep
// the profile's logs under the ignored test directory for failure diagnosis.
const userDataDir = mkdtempSync(join(profiles, `${version}-`));

export default defineConfig({
  files: 'out-vscode-test/**/*.test.js',
  version,
  // Inspect the actual nested webview through the test editor's loopback CDP
  // endpoint. Port 0 lets Electron allocate a free port without a bind race.
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ],
  env: { MYSTI_TEST_USER_DATA_DIR: userDataDir },
  // A scratch folder so the canvas has a real workspace to write `.mysti/canvas`
  // into; created by the test's own setup.
  workspaceFolder: './out-vscode-test/fixture-workspace',
  mocha: { ui: 'bdd', timeout: 120_000, color: false, parallel: false },
});
