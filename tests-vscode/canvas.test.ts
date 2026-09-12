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
 * The canvas, inside a REAL VS Code.
 *
 * Why this file exists: every production failure of this panel has been a VS
 * Code HOST behaviour, and the unit tests could not see any of them
 * because they mock `vscode`, while the browser suite runs the markup in bare
 * Chromium.
 *
 *   - the client dropped every host message, because VS Code relays them from
 *     the parent frame and the guard allowlisted only null/self;
 *   - every artboard was blank, because a `srcdoc` frame inherits the panel CSP;
 *   - every `asset://` image was blocked, because a `vscode-resource` origin is
 *     not a legal CSP host expression;
 *   - the board rendered 0px wide at panel widths a split editor produces.
 *
 * The load-bearing assertion here is `rendered !== null`: the webview only
 * reports that after it has actually painted an artifact, so it is positive
 * proof the whole boot — shell HTML, CSP, bundle, boot payload, `canvas/ready`,
 * `canvas/hello`, token check, first render — completed in the real host. The
 * two "Loading your designs…" failures were exactly `rendered === null`, and
 * were invisible because nothing ever reported success.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

const EXTENSION_ID = 'DeepMyst.mysti';

interface CanvasDiagnostics {
  panelOpen: boolean;
  viewTokenSet: boolean;
  artifactId: string | null;
  pages: number;
  storeReady: boolean;
  bridgeReady: boolean;
  rendered: { pages: number; layoutMode: string; liveFrames: number; at: number } | null;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Poll `mysti.canvasDiagnostics` until `predicate` holds, or time out. */
async function waitFor(
  predicate: (d: CanvasDiagnostics) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<CanvasDiagnostics> {
  const deadline = Date.now() + timeoutMs;
  let last: CanvasDiagnostics | undefined;
  while (Date.now() < deadline) {
    last = await vscode.commands.executeCommand<CanvasDiagnostics>('mysti.canvasDiagnostics');
    if (last && predicate(last)) { return last; }
    await sleep(250);
  }
  assert.fail(`timed out waiting for ${what}. Last diagnostics: ${JSON.stringify(last, null, 2)}`);
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the integration fixture workspace did not open');
  return folder.uri.fsPath;
}

describe('Mysti Canvas — real VS Code host', function () {
  this.timeout(120_000);
  let browser: Browser | undefined;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found — is package.json's publisher/name unchanged?`);
    console.log(`[Mysti test] VS Code ${vscode.version}, Node ${process.versions.node}, extension ${ext.extensionPath}`);
    if (process.env.MYSTI_TEST_VSIX_PATH) {
      assert.notStrictEqual(
        fs.realpathSync(ext.extensionPath), fs.realpathSync(path.resolve(__dirname, '..')),
        'the archive test loaded the source checkout instead of the installed VSIX',
      );
      const requireFromPackage = createRequire(path.join(ext.extensionPath, 'package.json'));
      const shippedModules = fs.realpathSync(path.join(ext.extensionPath, 'node_modules')) + path.sep;
      assert.ok(
        fs.realpathSync(requireFromPackage.resolve('playwright')).startsWith(shippedModules),
        'Playwright resolved outside the installed VSIX',
      );
      assert.strictEqual(typeof requireFromPackage('playwright').chromium.connectOverCDP, 'function');
    }
    await ext.activate();
    assert.ok(ext.isActive, 'extension failed to activate');

    const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
    assert.ok(profile, 'run through .vscode-test.mjs so the actual editor can be inspected');
    const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    assert.match(endpoint[0], /^\d+$/, 'the editor did not publish a CDP port');
    assert.ok(endpoint[1]?.startsWith('/devtools/browser/'), 'the editor did not publish a CDP endpoint');
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        page.on('console', message => {
          if (/canvas:|Content Security Policy/.test(message.text())) {
            console.log('[Mysti test] webview console:', message.text());
          }
        });
      }
    }
  });

  after(async () => {
    // For connectOverCDP this disconnects our client; the test runner owns the
    // editor process and must still receive the Mocha result before it exits.
    await browser?.close();
  });

  async function canvasFrame(): Promise<{ page: Page; frame: Frame }> {
    assert.ok(browser, 'the editor inspection connection was not established');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          for (const frame of page.frames()) {
            if (await frame.locator('#board-scroll').count()) { return { page, frame }; }
          }
        }
      }
      await sleep(250);
    }
    assert.fail('the Canvas document was not found in the actual editor webview frames');
  }

  it('activates and registers the canvas commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('mysti.openCanvas'), 'mysti.openCanvas is not registered');
    assert.ok(commands.includes('mysti.canvasDiagnostics'), 'mysti.canvasDiagnostics is not registered');
  });

  it('opens the canvas panel', async () => {
    await vscode.commands.executeCommand('mysti.openCanvas');
    const diag = await waitFor(d => d.panelOpen, 'the canvas panel to open');
    assert.ok(diag.viewTokenSet, 'no view token was minted — every client message would be refused');
    assert.ok(diag.storeReady, 'the artifact store was never constructed');
    assert.ok(diag.bridgeReady, 'the protocol bridge was never constructed');
  });

  it('loads an artifact host-side', async () => {
    const diag = await waitFor(d => d.artifactId !== null, 'an artifact to load');
    assert.ok(diag.artifactId, 'no artifact id');
  });

  /**
   * THE test. Everything above proves the host got ready; only this proves the
   * webview did — that the bundle loaded under the real CSP, the boot payload
   * parsed, `canvas/ready` reached the extension, `canvas/hello` came back, the
   * view token matched, and the client painted.
   */
  it('the WEBVIEW confirms it rendered — the handshake completes end to end', async () => {
    const diag = await waitFor(
      d => d.rendered !== null,
      'the webview to confirm a render (this is the "Loading your designs…" failure)',
    );
    assert.ok(diag.rendered, 'no render report');
    assert.strictEqual(
      diag.rendered.pages, diag.pages,
      'the webview painted a different number of artboards than the host holds',
    );
    assert.ok(
      ['wide', 'medium', 'narrow'].includes(diag.rendered.layoutMode),
      `unexpected layout mode: ${diag.rendered.layoutMode}`,
    );
  });

  it('a design created in the panel persists to .mysti/canvas', async () => {
    const before = await vscode.commands.executeCommand<CanvasDiagnostics>('mysti.canvasDiagnostics');
    assert.ok(before);

    // The empty state's own affordance, driven the way the webview drives it.
    await vscode.commands.executeCommand('mysti.canvasAddScaffold', 'login');
    const after = await waitFor(d => d.pages > (before.pages ?? 0), 'a scaffold to become an artboard');

    // …and on disk. The autosave is debounced host-side.
    const dir = path.join(workspaceRoot(), '.mysti', 'canvas');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !fs.existsSync(dir)) { await sleep(250); }
    assert.ok(fs.existsSync(dir), `.mysti/canvas was never created under ${workspaceRoot()}`);

    const artifactDir = path.join(dir, String(after.artifactId));
    const file = path.join(artifactDir, 'artifact.json');
    const fileDeadline = Date.now() + 15_000;
    while (Date.now() < fileDeadline && !fs.existsSync(file)) { await sleep(250); }
    assert.ok(fs.existsSync(file), `no artifact.json at ${file}`);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { pages?: unknown[] };
    assert.ok(Array.isArray(saved.pages) && saved.pages.length > 0, 'the saved design has no pages');
  });

  /**
   * Artboard rendering under the real host CSP.
   *
   * A `srcdoc` artboard inherits the panel CSP, which is how React, the UI
   * primitives and `harness.js` came to be refused in every live artboard while
   * every test still passed. A host diagnostic can confirm the shell rendered,
   * but even a nonzero iframe count does not establish that scripts inside the
   * frame ran. Inspect visible content and interact with an input in the actual
   * sandboxed frame to prove the shipped runtime and mount handshake completed.
   */
  it('mounts an interactive artboard under the real host CSP', async () => {
    const diag = await waitFor(d => d.pages > 0, 'an artboard to exist');
    assert.ok(diag.pages > 0, 'no artboard to mount');

    // Re-open so the client re-reports with pages present.
    await vscode.commands.executeCommand('mysti.openCanvas');
    const live = await waitFor(
      // A previous nonempty render can arrive before the newly added page's
      // report. Wait for the current host count, not any earlier render.
      d => d.pages > 0 && d.rendered !== null && d.rendered.pages === d.pages,
      'the webview to report all current artboards',
    );
    assert.ok(live.rendered);
    assert.strictEqual(live.rendered.pages, live.pages, 'painted a different artboard count than the host holds');

    const { page, frame } = await canvasFrame();
    await page.bringToFront();
    await frame.locator('#btn-zoom-fit').click();
    // A split editor fits a desktop page at 20%, intentionally below the live
    // frame threshold. Use the same zoom control as a person so this test
    // reaches interactive mode without overriding virtualization or app state.
    const zoom = frame.locator('#zoom-level');
    const zoomDeadline = Date.now() + 30_000;
    while (Date.now() < zoomDeadline && Number.parseInt(await zoom.innerText(), 10) < 50) {
      await frame.locator('#btn-zoom-in').click();
      await sleep(250);
    }
    assert.ok(Number.parseInt(await zoom.innerText(), 10) >= 50, 'Zoom In did not reach interactive scale');
    const artboard = frame.locator('iframe.artboard-frame').first();
    try {
      await artboard.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      console.log('[Mysti test] frame mount state:', JSON.stringify({
        board: await frame.locator('#board-scroll').boundingBox(),
        zoom: await frame.locator('#zoom-level').textContent(),
        notice: await frame.locator('#board-error').textContent(),
        artboards: await frame.locator('.artboard').count(),
        frames: await frame.locator('iframe.artboard-frame').count(),
        world: await frame.locator('#page-stage').getAttribute('style'),
      }));
      await page.screenshot({ path: path.join(process.env.MYSTI_TEST_USER_DATA_DIR!, 'canvas-failure.png') });
      throw error;
    }
    assert.strictEqual(await artboard.getAttribute('sandbox'), 'allow-scripts');
    const design = artboard.contentFrame();
    await design.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor({ state: 'visible' });
    const email = design.getByRole('textbox', { name: 'Email', exact: true });
    await email.fill('canvas-test@example.invalid');
    assert.strictEqual(await email.inputValue(), 'canvas-test@example.invalid');
    if (process.env.MYSTI_TEST_VSIX_PATH) {
      const screenshot = path.join(process.env.MYSTI_TEST_USER_DATA_DIR!, 'canvas-success.png');
      await page.screenshot({ path: screenshot });
      console.log(`[Mysti test] Packaged Canvas screenshot: ${screenshot}`);
    }
  });

  /**
   * Nothing in the panel may leave a `.mysti/canvas` design unreadable: the
   * store distinguishes ABSENT from CORRUPT precisely so a real design is never
   * silently replaced by a blank one.
   */
  it('reloads the persisted design on a second open', async () => {
    const first = await waitFor(d => d.pages > 0, 'a saved artboard');
    const artifactId = first.artifactId;
    const canvasTab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Mysti Canvas');
    assert.ok(canvasTab, 'no Canvas editor tab was open');
    assert.ok(await vscode.window.tabGroups.close(canvasTab), 'the Canvas editor did not close');
    await waitFor(d => !d.panelOpen && d.artifactId === null, 'the Canvas session to dispose');
    await vscode.commands.executeCommand('mysti.openCanvas');
    const again = await waitFor(d => d.artifactId !== null, 'the canvas to reopen');
    assert.strictEqual(again.artifactId, artifactId, 'reopening produced a DIFFERENT artifact — the saved design was not loaded');
    assert.ok(again.pages > 0, 'the reloaded design lost its artboards');
  });
});
