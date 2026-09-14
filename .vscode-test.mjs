/*
 * Mysti - AI Coding Agent · SPDX-License-Identifier: Apache-2.0
 *
 * Integration tests that run inside a REAL VS Code.
 *
 * The unit suite (vitest) mocks `vscode`; the browser suite
 * (playwright) runs the webview markup in bare Chromium. Neither contains VS
 * Code — and every production failure of the canvas so far has been a VS Code
 * HOST behaviour: the frame topology behind `ev.source`, `srcdoc` inheriting the
 * panel CSP, `vscode-resource` asset URIs, panel widths. This is the layer that
 * can see them.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import chatFixture from './scripts/editor-chat-fixture.cjs';

const version = process.env.MYSTI_TEST_VSCODE_VERSION || 'stable';
const vsixPath = process.env.MYSTI_TEST_VSIX_PATH && resolve(process.env.MYSTI_TEST_VSIX_PATH);
const ollamaEndpoint = await chatFixture.startEditorChatFixture();
// Each run gets fresh editor state and a fresh DevToolsActivePort file. A
// profile under a deep checkout can exceed Unix socket path limits before
// the editor opens, so use a short temporary path and print it for diagnosis.
const userDataDir = mkdtempSync(join(tmpdir(), 'mysti-vscode-'));
console.log(`[Mysti test] VS Code profile: ${userDataDir}`);
mkdirSync(join(userDataDir, 'User'));
// Never probe a maintainer's local model/gateway services during activation.
// Ollama's loopback fixture already exists before the first availability probe.
writeFileSync(join(userDataDir, 'User', 'settings.json'), JSON.stringify({
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'chat.disableAIFeatures': true,
  'mysti.updates.checkCliUpdates': false,
  'mysti.updates.notifyNewModels': false,
  'mysti.openclawGatewayUrl': 'ws://127.0.0.1:1',
  'mysti.ollamaEndpoint': ollamaEndpoint,
  'mysti.ollamaModel': 'qwen3-coder',
  'mysti.localaiEndpoint': 'http://127.0.0.1:1',
  'mysti.defaultAgent': 'ollama',
  'mysti.defaultProvider': 'ollama',
}));

export default {
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
    '--use-mock-keychain',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ],
  env: { MYSTI_TEST_USER_DATA_DIR: userDataDir, MYSTI_TEST_VSIX_PATH: vsixPath, MYSTI_TEST_OLLAMA_ENDPOINT: ollamaEndpoint,
    MYSTI_TEST_DESK_NATIVE: process.env.MYSTI_TEST_DESK_NATIVE },
  // A scratch folder so the canvas has a real workspace to write `.mysti/canvas`
  // into; created by the test's own setup.
  workspaceFolder: './out-vscode-test/fixture-workspace',
};
