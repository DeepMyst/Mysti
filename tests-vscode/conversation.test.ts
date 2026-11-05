/** Deterministic chat journey through the real editor host; no model call. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame } from 'playwright';
import { legacyCdp } from './legacyCdp';

describe('Mysti conversation editor bridge', function () {
  this.timeout(60_000);
  let browser: Browser;
  let legacy: Awaited<ReturnType<typeof legacyCdp>> | undefined;
  after(async () => {
    try { await browser?.close(); }
    finally { await legacy?.close(); }
  });

  it('reselects its chat tab, preserves a draft across agent switches, executes Help, and starts fresh', async () => {
    await vscode.extensions.getExtension('DeepMyst.mysti')!.activate();
    for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label !== 'Mysti Canvas')) {
      await vscode.window.tabGroups.close(tab);
    }
    const endpoint = fs.readFileSync(path.join(process.env.MYSTI_TEST_USER_DATA_DIR!, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    const inspection = `ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`;
    // The oldest supported editor needs the same download-free CDP adapter as
    // the Canvas journey; all actual target/frame commands still reach VS Code.
    if (vscode.version.startsWith('1.86.')) { legacy = await legacyCdp(inspection); }
    browser = await chromium.connectOverCDP(legacy?.endpoint || inspection);
    const previousFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
    let tabListener: vscode.Disposable | undefined;
    let tabTimeout: ReturnType<typeof setTimeout> | undefined;
    const openedTab = new Promise<vscode.Tab>((resolve, reject) => {
      tabTimeout = setTimeout(() => reject(new Error('The new chat tab was not announced by the editor')), 15_000);
      tabListener = vscode.window.tabGroups.onDidChangeTabs(event => {
        const tab = event.opened.find(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat'));
        if (tab) { resolve(tab); }
      });
    });
    let chatTab: vscode.Tab;
    try {
      await vscode.commands.executeCommand('mysti.openInNewTab');
      chatTab = await openedTab;
    } finally { tabListener?.dispose(); clearTimeout(tabTimeout); }
    const chatGroup = vscode.window.tabGroups.all.find(group => group.tabs.includes(chatTab));
    assert.ok(chatGroup, 'The new chat tab must belong to an editor group');
    // Editor activity can return focus to a document after a webview opens.
    // Exercise that state explicitly rather than relying on the preceding
    // dictation test's focus/timing. Discover this chat before revealing it.
    const source = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'README.md'));
    await vscode.window.showTextDocument(source, { viewColumn: chatGroup.viewColumn, preserveFocus: false });
    assert.strictEqual(chatTab.isActive, false, 'The fixture must leave the new chat in the background');
    let frame: Frame | undefined;
    let frameDiagnostics: unknown[] = [];
    const deadline = Date.now() + 30_000;
    while (!frame && Date.now() < deadline) {
      frameDiagnostics = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          for (const candidate of page.frames()) {
            if (previousFrames.has(candidate)) { continue; }
            try {
              frameDiagnostics.push(await candidate.evaluate(() => {
                const win = globalThis as any;
                const document = win.document;
                const input = document.querySelector('#message-input');
                const rect = input?.getBoundingClientRect();
                return {
                  url: win.location.href, readyState: document.readyState, hidden: document.hidden,
                  input: input && { display: win.getComputedStyle(input).display, visibility: win.getComputedStyle(input).visibility, width: rect?.width, height: rect?.height },
                  overlay: document.querySelector('#init-loading-overlay')?.className,
                  wizard: document.querySelector('#setup-wizard')?.className,
                  body: document.body?.className,
                };
              }));
              // Visibility is an actionability check, not panel identity. A
              // retained background webview is fully initialized but hidden.
              if (await candidate.locator('#message-input').count() &&
                  (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) {
                frame = candidate;
                await page.bringToFront();
                break;
              }
            } catch { /* webview is mounting */ }
          }
        }
      }
      if (!frame) { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(frame, 'Mysti chat must finish initialization in the real editor. ' + JSON.stringify({
      frames: frameDiagnostics,
      tabs: vscode.window.tabGroups.all.map(group => ({ active: group.isActive, tabs: group.tabs.map(tab => ({ label: tab.label, active: tab.isActive })) })),
    }));
    // Electron can retain an inner frame with nonzero dimensions while its
    // editor tab is inactive. The editor's tab state owns focus, not the
    // inner DOM's isVisible result.
    assert.strictEqual(chatTab.isActive, false, 'Discovery must not select an unrelated editor');
    const chatIndex = chatGroup.tabs.indexOf(chatTab);
    assert.ok(chatIndex >= 0 && chatIndex < 9, 'The known chat tab must remain in its editor group');
    await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${chatIndex + 1}`);
    assert.strictEqual(chatGroup.activeTab, chatTab, 'Reveal the intended chat, not an arbitrary webview');
    const skip = frame.locator('.wizard-skip-btn');
    if (await skip.isVisible()) { await skip.click(); }
    await frame.locator('#message-input').waitFor({ state: 'visible', timeout: 15_000 });
    await frame.locator('#message-input').fill('Keep my unfinished review request');
    // Mysti and the built-in MiniMax API adapter are selectable without a CLI
    // installation. Brainstorm requires two available providers, which a clean
    // hosted runner does not have. Selecting an adapter performs no inference;
    // the only submitted message below is the local /help command.
    for (const [agent, label] of [['mysti', 'Mysti'], ['minimax', 'MiniMax'], ['mysti', 'Mysti']]) {
      await frame.locator('#agent-select-btn').click();
      const item = frame.locator(`#agent-menu .agent-menu-item[data-agent="${agent}"]`);
      assert.ok(!(await item.getAttribute('class'))?.split(/\s+/).includes('disabled'), `${label} must be selectable without an installed CLI`);
      await item.click();
      const selectedLabel = await frame.locator('#agent-name').innerText();
      assert.ok(selectedLabel.includes(label), `Expected selected agent ${label}, received ${selectedLabel}`);
      assert.strictEqual(await frame.locator('#message-input').inputValue(), 'Keep my unfinished review request');
    }

    await frame.locator('#message-input').fill('/help');
    await frame.locator('#message-input').press('Enter');
    await frame.locator('.help-card').waitFor({ state: 'visible', timeout: 15_000 });
    assert.strictEqual(await frame.locator('#message-input').inputValue(), '');

    await frame.locator('#new-conversation-btn').click();
    await frame.locator('.help-card').waitFor({ state: 'detached', timeout: 15_000 });
    assert.strictEqual(await frame.locator('.message').count(), 0);
    assert.strictEqual(await frame.locator('#stop-btn').isVisible(), false);
    assert.strictEqual(await frame.locator('#message-input').isEditable(), true);
  });
});
