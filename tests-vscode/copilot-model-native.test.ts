/** Opt-in, at most three real Copilot requests through the packaged native UI.
 * The launcher preserves Mysti policy and further restricts tools to file operations.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

if (process.env.MYSTI_COPILOT_MODEL_NATIVE === '1') {
  describe('Real Copilot native model selection and recovery', function () {
    this.timeout(340_000);
    const artifacts = process.env.MYSTI_COPILOT_ARTIFACTS!;
    const workspace = process.env.MYSTI_CONTEXT_WORKSPACE!;
    const profile = process.env.MYSTI_TEST_USER_DATA_DIR!;
    const fixture = JSON.parse(fs.readFileSync(path.join(artifacts, 'fixture.json'), 'utf8'));
    const observations: unknown[] = [], tabs: vscode.Tab[] = [];
    let browser: Browser, workbench: Page, first: Frame, second: Frame | undefined;
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const receipts = (): any[] => fs.existsSync(path.join(artifacts, 'copilot-model-receipts.jsonl'))
      ? fs.readFileSync(path.join(artifacts, 'copilot-model-receipts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const events = (frame: Frame): Promise<any[]> => frame.evaluate(() => (globalThis as any).__functionalEvents || []);
    const record = (event: string, detail: unknown) => {
      observations.push({ event, detail, at: new Date().toISOString() });
      fs.writeFileSync(path.join(artifacts, 'observations.json'), JSON.stringify(observations, null, 2));
    };
    async function until(label: string, check: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeout) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error(label + ': timed out');
    }
    async function open(): Promise<Frame> {
      const oldTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      const oldFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      let tab: vscode.Tab | undefined, frame: Frame | undefined;
      await until('New Copilot chat tab', async () => !!(tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
        !oldTabs.has(tab) && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat'))));
      tabs.push(tab!);
      const group = vscode.window.tabGroups.all.find(group => group.tabs.includes(tab!))!;
      const name = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'][group.viewColumn - 1];
      await vscode.commands.executeCommand(`workbench.action.focus${name}EditorGroup`);
      await until('Focus chat group', async () => group === vscode.window.tabGroups.activeTabGroup);
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${group.tabs.indexOf(tab!) + 1}`);
      await workbench.bringToFront();
      await until('Copilot webview initialized', async () => {
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (oldFrames.has(candidate)) continue;
          try {
            if (await candidate.locator('#message-input').count()
              && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) {
              frame = candidate; return true;
            }
          } catch { /* Frame still mounting. */ }
        }
        return false;
      }, 45_000);
      await frame!.evaluate(() => {
        const win = globalThis as any; win.__functionalEvents = [];
        win.addEventListener('message', (event: any) => {
          if (['conversationChanged', 'messageAdded', 'responseComplete', 'error', 'authError', 'composerSubmissionSettled', 'modelChanged'].includes(event.data?.type)) {
            win.__functionalEvents.push(event.data);
          }
        });
      });
      if (await frame!.locator('#setup-wizard').isVisible()) await frame!.locator('.wizard-skip-btn').click();
      await frame!.locator('#new-conversation-btn').click();
      await until('Fresh Copilot conversation', async () => (await events(frame!)).some(event => event.type === 'conversationChanged'));
      await until('Copilot selected', async () => (await frame!.locator('#agent-name').innerText()).includes('Copilot'));
      return frame!;
    }
    async function mode(frame: Frame, mode: string): Promise<void> {
      await frame.locator('#behavior-indicator').click();
      await frame.locator(`#behavior-popup .mode-option[data-mode="${mode}"]`).click();
    }
    async function selectModel(model: string): Promise<void> {
      await first.locator('#model-menu-btn').click();
      if (model === 'auto') {
        await first.locator('#model-menu [data-model="auto"]').click();
      } else {
        await first.locator('#model-menu [data-model="__custom__"]').click();
        const input = workbench.locator('.quick-input-widget:visible input');
        await input.fill(model); await input.press('Enter');
      }
      await until('Requested model reflected in host UI', async () => (await events(first))
        .some(event => event.type === 'modelChanged' && (event.payload.customModel || event.payload.model) === model && event.payload.provider === 'github-copilot'));
      const label = await first.locator('#model-menu-label').innerText();
      assert.strictEqual(label, model === 'auto' ? 'Auto' : model);
      record('selected-model', { model, label });
    }
    async function send(marker: string, prompt: string): Promise<any> {
      const before = (await events(first)).length;
      const requestCount = receipts().filter(row => row.event === 'request').length;
      await first.locator('#message-input').fill(`COPILOT_MODEL:${marker}\n${prompt}`);
      await first.locator('#send-btn').click();
      await until('Copilot terminal result ' + marker, async () => (await events(first)).slice(before)
        .some(event => ['responseComplete', 'error', 'authError'].includes(event.type)), 115_000);
      await until('Native child closes ' + marker, async () => receipts().some(row => row.event === 'exit' && row.marker === marker));
      await first.locator('#stop-btn').waitFor({ state: 'hidden' });
      const observed = (await events(first)).slice(before), request = receipts().find(row => row.event === 'request' && row.marker === marker);
      const exit = receipts().find(row => row.event === 'exit' && row.marker === marker);
      record('response-' + marker, { observed, request, exit });
      assert.ok(request); assert.strictEqual(request.policy.outputFormat, 'json'); assert.strictEqual(request.policy.nativeResume, false);
      assert.deepStrictEqual(request.policy.denyTools, ['shell', 'write']); assert.strictEqual(request.policy.allowAllTools, false);
      for (const [file, digest] of Object.entries(fixture.files)) assert.strictEqual(hash(fs.readFileSync(path.join(workspace, file))), digest);
      assert.strictEqual(receipts().filter(row => row.event === 'request').length, requestCount + 1);
      const message = observed.find(event => event.type === 'responseComplete')?.payload.message;
      const answer = message?.content || '';
      if (message) { assert.strictEqual(message.role, 'assistant'); assert.strictEqual(message.provider, 'github-copilot'); }
      return { observed, request, exit, answer };
    }
    before(async () => {
      assert.ok(path.isAbsolute(artifacts) && fs.existsSync(path.join(artifacts, '.owned-native-test')));
      assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(workspace));
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(profile, '.owned-native-profile.json'), 'utf8')).artifacts, artifacts);
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH!));
      record('identity', { vscode: vscode.version, extensionPath: extension.extensionPath,
        bundle: hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), profile, workspace });
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port[0]}${port[1]}`);
      workbench = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench'))!;
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      await extension.activate(); first = await open();
    });
    afterEach(async function () {
      record('case', { title: this.currentTest?.title, state: this.currentTest?.state, error: this.currentTest?.err?.message });
      if (this.currentTest?.state === 'failed') await workbench?.screenshot({ path: path.join(artifacts, `failure-${observations.length}.png`) }).catch(() => {});
    });
    after(async () => {
      for (const frame of [first, second]) if (frame) record('final-events', await events(frame).catch(() => []));
      for (const tab of tabs.reverse()) await vscode.window.tabGroups.close(tab);
      await browser?.close();
    });
    it('routes an explicit model and Low effort without silently substituting', async () => {
      await selectModel('gpt-5.4');
      await first.locator('#model-menu-btn').click();
      const slider = first.locator('#model-menu-effort-slider'); await slider.focus(); await slider.press('Home');
      assert.strictEqual(await slider.getAttribute('aria-valuetext'), 'Low');
      await first.locator('#model-menu-btn').click();
      const result = await send('EXPLICIT', 'Without tools, calculate Math.min(1000, 73 * 2 ** 3). Reply with EXPLICIT_MODEL_OK and the number.');
      assert.strictEqual(result.request.policy.model, 'gpt-5.4'); assert.strictEqual(result.request.policy.effort, 'low');
      assert.strictEqual(receipts().filter(row => row.event === 'request').length, 1);
      const errors = result.observed.filter((event: any) => ['error', 'authError'].includes(event.type));
      if (errors.length) {
        assert.strictEqual(errors.length, 1); assert.match(JSON.stringify(errors), /model.*(?:not available|unavailable|not found|not supported|invalid)/i);
        assert.notStrictEqual(result.exit.code, 0);
        assert.strictEqual(receipts().some(row => row.marker === 'EXPLICIT' && row.event === 'reported-model'), false);
        record('explicit-model-service-unavailable', { model: 'gpt-5.4', effort: 'low', noFallback: true });
      } else {
        assert.strictEqual(result.exit.code, 0);
        assert.match(result.answer, /EXPLICIT_MODEL_OK/); assert.match(result.answer, /\b584\b/);
        const reported = receipts().filter(row => row.marker === 'EXPLICIT' && row.event === 'reported-model');
        assert.ok(reported.length, 'Native protocol must identify the explicit model');
        assert.ok(reported.every(row => row.model === 'gpt-5.4'));
        record('explicit-model-accepted', { model: 'gpt-5.4', effort: 'low', reported });
      }
    });
    it('shows one invalid-model error and retains the newer draft', async () => {
      await selectModel('mysti-invalid-model-7f2a93');
      const pending = send('INVALID', 'Without tools, reply INVALID_MODEL_MUST_NOT_SUCCEED.');
      await first.locator('#stop-btn').waitFor({ state: 'visible' });
      await first.locator('#message-input').fill('UNSENT_NEWER_MODEL_DRAFT');
      const result = await pending;
      assert.strictEqual(result.request.policy.model, 'mysti-invalid-model-7f2a93');
      assert.notStrictEqual(result.exit.code, 0);
      const errors = result.observed.filter((event: any) => ['error', 'authError'].includes(event.type));
      assert.strictEqual(errors.length, 1); assert.match(JSON.stringify(errors), /model.*(?:not available|unavailable|not found|not supported|invalid)/i);
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'UNSENT_NEWER_MODEL_DRAFT');
      assert.strictEqual(receipts().some(row => row.marker === 'INVALID' && row.event === 'reported-model'), false);
      assert.strictEqual(receipts().filter(row => row.event === 'request' && row.marker === 'INVALID').length, 1);
      record('invalid-model-rejected', { singleError: true, newerDraftPreserved: true, noFallback: true });
    });
    it('recovers with Auto and omits the explicit effort flag', async () => {
      await selectModel('auto');
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'UNSENT_NEWER_MODEL_DRAFT');
      const result = await send('RECOVERY', 'Without tools, reply exactly AUTO_RECOVERY_OK.');
      assert.strictEqual(result.request.policy.model, 'auto'); assert.strictEqual(result.request.policy.effort, undefined);
      assert.strictEqual(result.exit.code, 0);
      assert.deepStrictEqual(result.observed.filter((event: any) => ['error', 'authError'].includes(event.type)), []);
      assert.ok(result.observed.some((event: any) => event.type === 'responseComplete' && event.payload.usageUnavailable === true));
      assert.strictEqual(result.answer.trim(), 'AUTO_RECOVERY_OK');
      assert.strictEqual(receipts().filter(row => row.event === 'request' && row.marker === 'RECOVERY').length, 1);
      record('auto-recovered', { effortOmitted: true, unknownTokenUsageHonest: true });
    });
  });
}
