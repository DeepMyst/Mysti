/** Opt-in packaged-extension checks against a loopback LocalAI responder.
 * Real editor commands, webview controls and HTTP adapter; no provider inference.
 * MYSTI_CONTEXT_NATIVE=1 plus an owned profile/workspace/artifact directory.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';

if (process.env.MYSTI_CONTEXT_NATIVE === '1') {
  describe('Context native packaged extension', function () {
    this.timeout(90_000);
    let browser: Browser, workbench: Page, first: Frame, second: Frame;
    let firstTab: vscode.Tab, secondTab: vscode.Tab, conversationId: string;
    const tabs: vscode.Tab[] = [];
    const artifacts = process.env.MYSTI_CONTEXT_ARTIFACTS!;
    const workspace = process.env.MYSTI_CONTEXT_WORKSPACE!;
    const endpoint = process.env.MYSTI_CONTEXT_ENDPOINT!;
    const file = path.join(workspace, 'owned-context.txt');
    const sibling = path.join(workspace, 'readable-sibling.txt');
    const observations: unknown[] = [];
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const events = (frame: Frame, type?: string): Promise<any[]> => frame.evaluate(kind =>
      ((globalThis as any).__contextEvents || []).filter((event: any) => !kind || event.type === kind), type);
    const latest = async (frame: Frame, type: string) => (await events(frame, type)).at(-1)?.payload;
    async function until(label: string, check: () => Promise<boolean>, timeout = 20_000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(label + ': timed out');
    }
    async function control(action: string): Promise<any> {
      const response = await fetch(endpoint + '/test/' + action);
      assert.strictEqual(response.status, 200); return response.json();
    }
    function record(event: string, detail: unknown): void {
      observations.push({ event, detail, at: new Date().toISOString() });
      fs.writeFileSync(path.join(artifacts, 'observations.json'), JSON.stringify(observations, null, 2));
    }
    async function reveal(tab: vscode.Tab): Promise<void> {
      const group = vscode.window.tabGroups.all.find(group => group.tabs.includes(tab)); assert.ok(group);
      const groupName = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'][group.viewColumn - 1];
      assert.ok(groupName); await vscode.commands.executeCommand(`workbench.action.focus${groupName}EditorGroup`);
      await until('Focus requested editor group', async () => group === vscode.window.tabGroups.activeTabGroup);
      const index = group.tabs.indexOf(tab); assert.ok(index >= 0 && index < 9);
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
      await workbench.bringToFront(); assert.strictEqual(group.activeTab, tab);
    }
    async function open(): Promise<{ frame: Frame; tab: vscode.Tab }> {
      const oldTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      const oldFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      let tab: vscode.Tab | undefined, frame: Frame | undefined;
      await until('New detached chat tab', async () => {
        tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => !oldTabs.has(tab)
          && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat'));
        return !!tab;
      });
      tabs.push(tab!); await reveal(tab!);
      await until('Native chat webview initialization', async () => {
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (oldFrames.has(candidate)) continue;
          try {
            if (await candidate.locator('#message-input').count()
              && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) {
              frame = candidate; return true;
            }
          } catch { /* Mounting frame. */ }
        }
        return false;
      }, 45_000);
      assert.ok(frame);
      // Observe host messages only. Never acquire, replace or seed the webview API.
      await frame.evaluate(() => {
        const win = globalThis as any; win.__contextEvents = [];
        win.addEventListener('message', (event: any) => {
          const allowed = ['conversationChanged', 'conversationHistory', 'messageAdded', 'responseComplete',
            'contextUpdated', 'contextWarning', 'composerSubmissionSettled', 'fileAttachmentSelected',
            'compactionStatus', 'requestCancelled', 'error', 'authError'];
          if (allowed.includes(event.data?.type)) win.__contextEvents.push(event.data);
        });
      });
      if (await frame.locator('#setup-wizard').isVisible()) await frame.locator('.wizard-skip-btn').click();
      await frame.locator('#new-conversation-btn').click();
      await until('New host conversation', async () => !!await latest(frame!, 'conversationChanged'));
      await until('LocalAI selected', async () => (await frame!.locator('#agent-name').innerText()).includes('LocalAI'));
      return { frame, tab: tab! };
    }
    async function send(frame: Frame, marker: string): Promise<any> {
      const before = (await events(frame, 'responseComplete')).length;
      await frame.locator('#message-input').fill('NATIVE_REQUEST:' + marker);
      await frame.locator('#send-btn').click();
      await until('Response for ' + marker, async () => (await events(frame, 'responseComplete')).length > before);
      assert.deepStrictEqual(await events(frame, 'error'), []);
      const receipt = (await control('state')).requests.filter((row: any) => !row.summary).at(-1);
      assert.ok(receipt.body.messages[0].content.includes('NATIVE_REQUEST:' + marker));
      assert.strictEqual(receipt.body.model, 'mysti-native-fixture');
      return receipt;
    }
    async function add(frame: Frame, filePath: string): Promise<void> {
      await vscode.commands.executeCommand('mysti.addToContext', vscode.Uri.file(filePath));
      await until('Context command reaches active native panel', async () =>
        (await latest(frame, 'contextUpdated') || []).some((item: any) => item.path === filePath));
    }
    async function switchConversation(frame: Frame, id: string): Promise<any> {
      const before = (await events(frame, 'conversationHistory')).length;
      await frame.locator('#history-btn').click();
      await until('History menu reply', async () => (await events(frame, 'conversationHistory')).length > before);
      const history = await latest(frame, 'conversationHistory');
      const index = history.conversations.findIndex((c: any) => c.id === id); assert.ok(index >= 0);
      await frame.locator('#history-menu .history-item').nth(index).locator('.history-item-info').click();
      await until('Original conversation restored', async () => (await latest(frame, 'conversationChanged'))?.id === id);
      return latest(frame, 'conversationChanged');
    }
    before(async () => {
      assert.ok(path.isAbsolute(artifacts) && fs.existsSync(path.join(artifacts, '.owned-native-test')));
      assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(workspace));
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR!;
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(profile, '.owned-native-profile.json'), 'utf8')).artifacts, artifacts);
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH!));
      record('identity', { vscode: vscode.version, extensionPath: extension.extensionPath,
        bundle: hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), profile, workspace });
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port[0]}${port[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      await extension.activate();
      const opened = await open(); first = opened.frame; firstTab = opened.tab;
      conversationId = (await latest(first, 'conversationChanged')).id;
      fs.writeFileSync(file, 'CONTEXT_VERSION_ONE'); fs.writeFileSync(sibling, 'READABLE_SIBLING');
    });
    afterEach(async function () {
      record('case', { title: this.currentTest?.title, state: this.currentTest?.state,
        error: this.currentTest?.err?.message, first: first && await events(first).catch(() => []),
        second: second && await events(second).catch(() => []) });
      if (this.currentTest?.state === 'failed' && workbench) {
        await workbench.screenshot({ path: path.join(artifacts, `failure-${observations.length}.png`) }).catch(() => {});
      }
    });
    after(async () => {
      await control('release').catch(() => {});
      for (const tab of tabs.reverse()) await vscode.window.tabGroups.close(tab);
      await browser?.close();
    });
    it('refreshes changed file bytes while keeping original message snapshots', async () => {
      await add(first, file);
      const initial = await send(first, 'FIRST');
      assert.ok(initial.body.messages[0].content.includes('CONTEXT_VERSION_ONE'));
      fs.writeFileSync(file, 'CONTEXT_VERSION_TWO');
      const updated = await send(first, 'UPDATED');
      assert.ok(updated.body.messages[0].content.includes('CONTEXT_VERSION_TWO'));
      assert.ok(!updated.body.messages[0].content.includes('CONTEXT_VERSION_ONE'));
      await first.locator('#new-conversation-btn').click();
      await until('Leave original conversation', async () => (await latest(first, 'conversationChanged')).id !== conversationId);
      const restored = await switchConversation(first, conversationId);
      const initialMessage = restored.messages.find((message: any) => message.content === 'NATIVE_REQUEST:FIRST');
      const updatedMessage = restored.messages.find((message: any) => message.content === 'NATIVE_REQUEST:UPDATED');
      assert.strictEqual(initialMessage.context.find((item: any) => item.path === file).content, 'CONTEXT_VERSION_ONE');
      assert.strictEqual(updatedMessage.context.find((item: any) => item.path === file).content, 'CONTEXT_VERSION_TWO');
    });
    it('omits deleted file bytes with a warning and keeps readable siblings', async () => {
      await add(first, sibling); fs.unlinkSync(file);
      const request = await send(first, 'DELETED');
      assert.ok(request.body.messages[0].content.includes('READABLE_SIBLING'));
      assert.ok(!request.body.messages[0].content.includes('CONTEXT_VERSION_ONE'));
      assert.ok(!request.body.messages[0].content.includes('CONTEXT_VERSION_TWO'));
      const warning = await latest(first, 'contextWarning'); assert.ok(JSON.stringify(warning).includes('owned-context.txt'));
      const context = await latest(first, 'contextUpdated');
      assert.ok(!context.some((item: any) => item.path === file));
      const message = (await events(first, 'messageAdded')).map(event => event.payload)
        .find(message => message.content === 'NATIVE_REQUEST:DELETED');
      assert.deepStrictEqual(message.context.map((item: any) => item.path), [sibling]);
    });
    it('keeps persistent context isolated between actual editor tabs', async () => {
      const opened = await open(); second = opened.frame; secondTab = opened.tab;
      const isolatedFile = path.join(workspace, 'second-panel.txt'); fs.writeFileSync(isolatedFile, 'SECOND_PANEL_ONLY');
      await add(second, isolatedFile);
      const isolated = await send(second, 'SECOND_PANEL');
      assert.ok(isolated.body.messages[0].content.includes('SECOND_PANEL_ONLY'));
      assert.ok(!isolated.body.messages[0].content.includes('READABLE_SIBLING'));
      await reveal(firstTab);
      const original = await send(first, 'ORIGINAL_PANEL');
      assert.ok(original.body.messages[0].content.includes('READABLE_SIBLING'));
      assert.ok(!original.body.messages[0].content.includes('SECOND_PANEL_ONLY'));
    });
    it('recovers a stopped preparation without replacing a newer draft', async () => {
      await reveal(firstTab);
      await control('hold-summary');
      await first.locator('#message-input').fill('/compact'); await first.locator('#send-btn').click();
      await until('Actual client-summary request held by loopback server', async () => (await control('state')).held === 1);
      assert.strictEqual(await first.locator('#attach-btn').isDisabled(), true, 'LocalAI does not advertise attachments');
      const before = (await control('state')).requests.length;
      await first.locator('#message-input').fill('NATIVE_REQUEST:CANCELLED'); await first.locator('#send-btn').click();
      await first.locator('#stop-btn').waitFor({ state: 'visible' });
      await first.locator('#message-input').fill('A newer independent draft'); await first.locator('#stop-btn').click();
      await control('release');
      const card = first.locator('.unsent-message'); await card.waitFor({ state: 'visible' });
      assert.strictEqual((await control('state')).requests.length, before, 'Stopped submission never reaches provider');
      await card.locator('[data-action="restore"]').click();
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'A newer independent draft');
      assert.strictEqual(await card.count(), 1);
      await first.locator('#message-input').fill(''); await card.locator('[data-action="restore"]').click();
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'NATIVE_REQUEST:CANCELLED');
      assert.deepStrictEqual(await first.locator('.attachment-name').allTextContents(), []);
      const count = (await events(first, 'responseComplete')).length;
      await first.locator('#send-btn').click();
      await until('Explicit resubmission completes', async () => (await events(first, 'responseComplete')).length > count);
      const request = (await control('state')).requests.at(-1);
      assert.ok(request.body.messages[0].content.includes('NATIVE_REQUEST:CANCELLED'));
      assert.ok(!request.body.messages[0].content.includes('A newer independent draft'));
      assert.strictEqual((await control('state')).requests.length, before + 1, 'Only explicit resubmission dispatches');
      const message = (await events(first, 'messageAdded')).map(event => event.payload)
        .find(message => message.content === 'NATIVE_REQUEST:CANCELLED');
      assert.ok(message); assert.strictEqual(message.attachments, undefined);
      assert.strictEqual(await card.count(), 0);
    });
  });
}
