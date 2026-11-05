/** Opt-in, at most three real Copilot requests through the packaged native UI.
 * The launcher preserves Mysti policy and further restricts tools to file operations.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

if (process.env.MYSTI_COPILOT_FUNCTIONAL_NATIVE === '1') {
  describe('Real Copilot bounded native functional check', function () {
    this.timeout(340_000);
    const artifacts = process.env.MYSTI_COPILOT_ARTIFACTS!;
    const workspace = process.env.MYSTI_CONTEXT_WORKSPACE!;
    const profile = process.env.MYSTI_TEST_USER_DATA_DIR!;
    const fixture = JSON.parse(fs.readFileSync(path.join(artifacts, 'fixture.json'), 'utf8'));
    const observations: unknown[] = [], tabs: vscode.Tab[] = [];
    let browser: Browser, workbench: Page, first: Frame, second: Frame;
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const receipts = (): any[] => fs.existsSync(path.join(artifacts, 'copilot-receipts.jsonl'))
      ? fs.readFileSync(path.join(artifacts, 'copilot-receipts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
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
          if (['conversationChanged', 'messageAdded', 'responseComplete', 'error', 'authError', 'composerSubmissionSettled'].includes(event.data?.type)) {
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
    async function send(frame: Frame, marker: string, prompt: string): Promise<any> {
      const before = (await events(frame)).length;
      await frame.locator('#message-input').fill(`COPILOT_FUNCTIONAL:${marker}\n${prompt}`);
      await frame.locator('#send-btn').click();
      await until('Copilot terminal result ' + marker, async () => (await events(frame)).slice(before)
        .some(event => ['responseComplete', 'error', 'authError'].includes(event.type)), 115_000);
      const observed = (await events(frame)).slice(before);
      record('response-' + marker, observed);
      assert.deepStrictEqual(observed.filter(event => ['error', 'authError'].includes(event.type)), [], 'Provider must complete without error');
      await until('Native child closes ' + marker, async () => receipts().some(row => row.event === 'exit' && row.marker === marker));
      assert.strictEqual(receipts().find(row => row.event === 'exit' && row.marker === marker)?.code, 0);
      const request = receipts().find(row => row.event === 'request' && row.marker === marker);
      assert.ok(request); assert.strictEqual(request.policy.model, 'auto'); assert.strictEqual(request.policy.effort, undefined);
      assert.strictEqual(request.policy.outputFormat, 'json'); assert.strictEqual(request.policy.nativeResume, false);
      const answer = observed.find(event => event.type === 'responseComplete')?.payload.message?.content || '';
      return { observed, request, answer };
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
      if (this.currentTest?.state === 'failed') await workbench?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    });
    after(async () => {
      for (const frame of [first, second]) if (frame) record('final-events', await events(frame).catch(() => []));
      for (const tab of tabs.reverse()) await vscode.window.tabGroups.close(tab);
      await browser?.close();
    });
    it('reads actual bytes, repairs the scoped bug, and isolates a new panel', async () => {
      await mode(first, 'plan');
      const read = await send(first, 'READ', 'Use view to read src/retry.cjs. Return its exact FIXTURE_NONCE and diagnose retryDelay. State expected delays for attempts 0, 1, 4 with base 100 and cap 1000. Do not edit files, use shell, or access anything outside this workspace.');
      assert.deepStrictEqual(read.request.policy.denyTools, ['shell', 'write']);
      assert.strictEqual(read.request.policy.allowAllTools, false); assert.strictEqual(read.request.containsNonce, false);
      assert.ok(read.answer.includes(fixture.nonce), 'Actual read result includes the unpredictable file nonce');
      assert.ok(receipts().some(row => row.marker === 'READ' && row.event === 'tool-start' && row.name === 'view' && row.ownedFile));
      for (const [file, digest] of Object.entries(fixture.files)) assert.strictEqual(hash(fs.readFileSync(path.join(workspace, file))), digest);
      record('read-only-verified', { filesUnchanged: true, actualView: true });
      await mode(first, 'full');
      const write = await send(first, 'WRITE', 'Fix retryDelay in src/retry.cjs to return Math.min(cap, base * 2 ** attempt). Edit only that file using a file editing tool. Preserve the developer comment and all unrelated code. Do not run shell, commit, access network tools or modify any other file.');
      assert.strictEqual(write.request.policy.allowAllTools, true);
      assert.ok(write.request.markers.includes('READ'), 'Continuation carries the prior user turn');
      assert.ok(fs.readFileSync(path.join(workspace, 'src/retry.cjs'), 'utf8').includes('DEVELOPER_UNSTAGED_NOTE'));
      for (const [file, digest] of Object.entries(fixture.files)) if (file !== 'src/retry.cjs') assert.strictEqual(hash(fs.readFileSync(path.join(workspace, file))), digest);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.strictEqual(git('diff', '--cached'), fixture.stagedDiff);
      const oracle = execFileSync(process.env.MYSTI_PINNED_NODE!, [path.join(artifacts, 'oracle.cjs'), workspace], { encoding: 'utf8' });
      record('writer-verified', { oracle, diff: git('diff'), stagedDiffPreserved: true });
      second = await open(); await mode(second, 'plan');
      const isolated = await send(second, 'ISOLATE', 'Without reading files or using tools, reply exactly ISOLATED_OK.');
      assert.deepStrictEqual(isolated.request.markers, ['ISOLATE']); assert.strictEqual(isolated.request.containsNonce, false);
      assert.strictEqual(isolated.answer.trim(), 'ISOLATED_OK'); assert.ok(!isolated.answer.includes(fixture.nonce));
      assert.strictEqual(receipts().filter(row => row.event === 'request').length, 3);
      record('isolation-verified', { priorMarkersAbsent: true, priorNonceAbsent: true });
    });
  });
}
