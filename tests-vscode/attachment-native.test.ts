/** Opt-in packaged-extension attachment checks with a synthetic Claude CLI.
 * Real editor commands, file picker, webview controls and CLI adapter; no model inference.
 * MYSTI_ATTACHMENT_NATIVE=1 plus an owned profile/workspace/artifact directory.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';

if (process.env.MYSTI_ATTACHMENT_NATIVE === '1') {
  describe('Attachment native packaged extension', function () {
    this.timeout(90_000);
    let browser: Browser, workbench: Page, first: Frame;
    let firstTab: vscode.Tab, conversationId: string;
    const tabs: vscode.Tab[] = [];
    const artifacts = process.env.MYSTI_ATTACHMENT_ARTIFACTS!;
    const workspace = process.env.MYSTI_ATTACHMENT_WORKSPACE!;
    const fixtureReceipts = path.join(artifacts, 'cli-receipts.jsonl');
    const receipts = () => fs.existsSync(fixtureReceipts) ? fs.readFileSync(fixtureReceipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const requests = () => receipts().filter(row => row.event === 'request');
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
      await until('Claude selected', async () => (await frame!.locator('#agent-name').innerText()).includes('Claude'));
      assert.strictEqual(await frame.locator('#attach-btn').isEnabled(), true);
      return { frame, tab: tab! };
    }
    async function send(marker: string): Promise<any> {
      const before = (await events(first, 'responseComplete')).length;
      const count = requests().length;
      await first.locator('#message-input').fill('ATTACHMENT_NATIVE:' + marker);
      await first.locator('#send-btn').click();
      await until('Response for ' + marker, async () => (await events(first, 'responseComplete')).length > before);
      assert.deepStrictEqual(await events(first, 'error'), []);
      assert.deepStrictEqual(await events(first, 'authError'), []);
      assert.strictEqual(requests().length, count + 1);
      const receipt = requests().at(-1); assert.ok(receipt.prompt.includes('ATTACHMENT_NATIVE:' + marker));
      return receipt;
    }
    async function attach(file: string): Promise<any> {
      assert.strictEqual(path.dirname(file), workspace);
      const before = (await events(first, 'fileAttachmentSelected')).length;
      await first.locator('#attach-btn').click();
      const input = workbench.locator('.quick-input-widget input[type="text"]');
      await input.waitFor({ state: 'visible' }); await input.fill(file); await input.press('Enter');
      await until('Real attachment picker response', async () => (await events(first, 'fileAttachmentSelected')).length > before);
      await input.waitFor({ state: 'hidden' });
      const selected = (await latest(first, 'fileAttachmentSelected')).attachments;
      assert.strictEqual(selected.length, 1); assert.strictEqual(selected[0].fileName, path.basename(file));
      return selected[0];
    }
    async function assertTransport(receipt: any, selected: any[]): Promise<void> {
      assert.deepStrictEqual(receipt.attachments.map((item: any) => item.base64), selected.map(item => item.base64Data));
      assert.deepStrictEqual(receipt.attachments.map((item: any) => item.bytes), selected.map(item => item.size));
      assert.ok(receipt.attachments.every((item: any) => path.dirname(item.file) === path.join(workspace, '.mysti', 'tmp')));
      await until('Transport snapshots cleaned after turn', async () => receipt.attachments.every((item: any) => !fs.existsSync(item.file)));
    }
    async function stopped(marker: string, file: string): Promise<any> {
      const before = receipts().filter(row => row.event === 'compact-held').length;
      await first.locator('#context-usage').click();
      await until('Native compaction request held', async () => receipts().filter(row => row.event === 'compact-held').length > before);
      await until('Host compaction status', async () => (await latest(first, 'compactionStatus'))?.status === 'compacting');
      const selected = await attach(file), count = requests().length;
      await first.locator('#message-input').fill('ATTACHMENT_NATIVE:' + marker); await first.locator('#send-btn').click();
      await first.locator('#stop-btn').waitFor({ state: 'visible' }); await first.locator('#stop-btn').click();
      await first.locator('.unsent-message').waitFor({ state: 'visible' });
      assert.strictEqual(requests().length, count, 'Cancelled preparation never reaches CLI');
      const compactPid = receipts().filter(row => row.event === 'compact-held').at(-1).pid;
      await until('Native compaction worker exits after Stop', async () => receipts().some(row => row.pid === compactPid && row.event === 'exit'));
      return selected;
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
    });
    afterEach(async function () {
      record('case', { title: this.currentTest?.title, state: this.currentTest?.state,
        error: this.currentTest?.err?.message, first: first && await events(first).catch(() => []), wireReceipts: receipts() });
      if (this.currentTest?.state === 'failed' && workbench) {
        await workbench.screenshot({ path: path.join(artifacts, `failure-${observations.length}.png`) }).catch(() => {});
      }
    });
    after(async () => {
      if (first && await first.locator('#stop-btn').isVisible().catch(() => false)) await first.locator('#stop-btn').click().catch(() => {});
      for (const tab of tabs.reverse()) await vscode.window.tabGroups.close(tab);
      await browser?.close();
    });
    it('delivers selected nonempty and empty file bytes after the source changes or disappears', async () => {
      const full = path.join(workspace, 'selected-full.txt'), empty = path.join(workspace, 'selected-empty.txt');
      fs.writeFileSync(full, 'ORIGINAL_SELECTED_BYTES'); fs.writeFileSync(empty, '');
      const selected = [await attach(full), await attach(empty)];
      assert.strictEqual(selected[0].base64Data, Buffer.from('ORIGINAL_SELECTED_BYTES').toString('base64'));
      assert.strictEqual(selected[1].base64Data, '');
      fs.writeFileSync(full, 'LATER_SOURCE_BYTES'); fs.unlinkSync(empty);
      await assertTransport(await send('BASELINE'), selected);
      assert.strictEqual(fs.readFileSync(full, 'utf8'), 'LATER_SOURCE_BYTES'); assert.strictEqual(fs.existsSync(empty), false);
      assert.strictEqual(await first.locator('#attachment-previews .attachment-name').count(), 0);
    });
    it('recovers a stopped attachment without overwriting a newer draft or attachment', async () => {
      const source = path.join(workspace, 'cancelled-full.txt'), draft = path.join(workspace, 'newer-draft.txt');
      fs.writeFileSync(source, 'CANCELLED_ORIGINAL_BYTES'); fs.writeFileSync(draft, 'NEWER_DRAFT_BYTES');
      const selected = await stopped('CANCELLED_FULL', source); fs.unlinkSync(source);
      const count = requests().length; await attach(draft);
      await first.locator('#message-input').fill('A newer independent draft');
      const card = first.locator('.unsent-message'); await card.locator('[data-action="restore"]').click();
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'A newer independent draft');
      assert.deepStrictEqual(await first.locator('.attachment-name').allTextContents(), ['newer-draft.txt']);
      assert.strictEqual(await card.count(), 1); assert.strictEqual(requests().length, count);
      await first.locator('.attachment-remove').click(); await first.locator('#message-input').fill('');
      await card.locator('[data-action="restore"]').click();
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'ATTACHMENT_NATIVE:CANCELLED_FULL');
      assert.deepStrictEqual(await first.locator('.attachment-name').allTextContents(), ['cancelled-full.txt']);
      assert.strictEqual(await card.count(), 0); assert.strictEqual(requests().length, count);
      const receipt = await send('CANCELLED_FULL'); await assertTransport(receipt, [selected]);
      assert.ok(!receipt.prompt.includes('A newer independent draft')); assert.ok(!receipt.prompt.includes('newer-draft.txt'));
      assert.strictEqual(fs.existsSync(source), false);
    });
    it('keeps a cancelled zero-byte attachment with its original conversation across navigation', async () => {
      const source = path.join(workspace, 'cancelled-empty.txt'); fs.writeFileSync(source, '');
      const selected = await stopped('CANCELLED_EMPTY', source); assert.strictEqual(selected.base64Data, '');
      fs.writeFileSync(source, 'NOT_THE_CAPTURED_EMPTY_FILE');
      const count = requests().length;
      await first.locator('#new-conversation-btn').click();
      await until('New conversation', async () => (await latest(first, 'conversationChanged')).id !== conversationId);
      assert.strictEqual(await first.locator('.unsent-message').count(), 0);
      await first.locator('#message-input').fill('Other conversation draft');
      await switchConversation(first, conversationId);
      const card = first.locator('.unsent-message'); await card.waitFor({ state: 'visible' });
      await card.locator('[data-action="restore"]').click();
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'ATTACHMENT_NATIVE:CANCELLED_EMPTY');
      assert.deepStrictEqual(await first.locator('.attachment-name').allTextContents(), ['cancelled-empty.txt']);
      assert.strictEqual(requests().length, count);
      await assertTransport(await send('CANCELLED_EMPTY'), [selected]);
      assert.strictEqual(fs.readFileSync(source, 'utf8'), 'NOT_THE_CAPTURED_EMPTY_FILE');
    });
  });
}
