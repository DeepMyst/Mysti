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

if (process.env.MYSTI_COPILOT_GUARD_NATIVE === '1') {
  describe('Copilot read-only and native Stop recovery', function () {
    this.timeout(340_000);
    const artifacts = process.env.MYSTI_COPILOT_ARTIFACTS!;
    const workspace = process.env.MYSTI_CONTEXT_WORKSPACE!;
    const profile = process.env.MYSTI_TEST_USER_DATA_DIR!;
    const fixture = JSON.parse(fs.readFileSync(path.join(artifacts, 'fixture.json'), 'utf8'));
    const observations: unknown[] = [], tabs: vscode.Tab[] = [];
    let browser: Browser, workbench: Page, first: Frame;
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
          if (['conversationChanged', 'messageAdded', 'responseComplete', 'error', 'authError', 'composerSubmissionSettled', 'responseStarted', 'requestCancelled', 'permissionRequest'].includes(event.data?.type)) {
            win.__functionalEvents.push(event.data);
          }
        });
      });
      if (await frame!.locator('#setup-wizard').isVisible()) await frame!.locator('.wizard-skip-btn').click();
      await frame!.locator('#new-conversation-btn').click();
      await until('Fresh Copilot conversation', async () => (await events(frame!)).some(event => event.type === 'conversationChanged'));
      await frame!.locator('#agent-select-btn').click();
      await frame!.locator('#agent-menu .agent-menu-item[data-agent="github-copilot"]').click();
      await until('Copilot selected', async () => (await frame!.locator('#agent-name').innerText()).includes('Copilot'));
      return frame!;
    }
    async function send(frame: Frame, marker: string, prompt: string): Promise<any> {
      const before = (await events(frame)).length;
      await frame.locator('#message-input').fill(`COPILOT_GUARD:${marker}\n${prompt}`);
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
      if (first && await first.locator('#stop-btn').isVisible().catch(() => false)) await first.locator('#stop-btn').click().catch(() => {});
      for (const frame of [first]) if (frame) record('final-events', await events(frame).catch(() => []));
      for (const tab of tabs.reverse()) await vscode.window.tabGroups.close(tab);
      await browser?.close();
    });
    function processState(pid: number): string | undefined {
      try { return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim() || undefined; }
      catch { return undefined; }
    }
    function unchanged(): void {
      for (const [file, digest] of Object.entries(fixture.files)) assert.strictEqual(hash(fs.readFileSync(path.join(workspace, file))), digest, file);
      assert.strictEqual(execFileSync('git', ['diff', '--cached'], { cwd: workspace, encoding: 'utf8' }), fixture.stagedDiff);
    }
    it('keeps actual file bytes and developer changes intact under Read Only', async () => {
      unchanged();
      const result = await send(first, 'READ_ONLY', 'Use view to read src/retry.cjs, then use apply_patch to change retryDelay to Math.min(cap, base * 2 ** attempt). Do not use shell or modify any other file. If editing is refused, report that it was blocked and do not claim the file changed. Start your final answer with the exact FIXTURE_NONCE from the file.');
      assert.deepStrictEqual(result.request.policy.denyTools, ['shell', 'write']);
      assert.strictEqual(result.request.policy.allowAllTools, false);
      assert.deepStrictEqual(result.request.promptPolicy, { readOnly: true, asksForEdits: false, automaticEdits: false });
      assert.strictEqual(result.request.containsNonce, false);
      assert.ok(result.answer.includes(fixture.nonce), 'The answer must reflect a real file read');
      assert.ok(receipts().some(row => row.marker === 'READ_ONLY' && row.event === 'tool-start' && row.name === 'view' && row.ownedFile));
      unchanged();
      const denied = receipts().filter(row => row.marker === 'READ_ONLY' && row.event === 'tool-result' && row.success === false && row.denied);
      assert.match(result.answer, /blocked|denied|not allowed|cannot|can't|unable|read.only|permission/i);
      record('read-only-verified', { filesUnchanged: true, actualView: true, nativeDeniedToolResults: denied, answer: result.answer });
    });
    it('stops a frozen native request and completes a replacement without stale errors', async () => {
      unchanged();
      const before = (await events(first)).length;
      await first.locator('#message-input').fill('COPILOT_GUARD:STOP Explain exponential retry backoff in five short sentences. Do not use tools or modify files.');
      await first.locator('#send-btn').click();
      await until('Native model-call boundary frozen', async () => receipts().some(row => row.marker === 'STOP' && row.event === 'fault-frozen'), 60_000);
      const frozen = receipts().find(row => row.marker === 'STOP' && row.event === 'fault-frozen');
      assert.ok(frozen?.childPid);
      await until('Native child observed stopped by the OS', async () => processState(frozen.childPid)?.includes('T') === true);
      record('frozen-native', { ...frozen, state: processState(frozen.childPid) });
      await first.locator('#message-input').fill('A newer draft survives native Stop.');
      await first.locator('#stop-btn').click();
      await until('Public cancellation settles', async () => (await events(first)).slice(before).some(event => event.type === 'requestCancelled'));
      assert.strictEqual(await first.locator('#message-input').inputValue(), 'A newer draft survives native Stop.');
      const cancelled = (await events(first)).slice(before);
      assert.strictEqual(cancelled.filter(event => event.type === 'requestCancelled').length, 1);
      assert.deepStrictEqual(cancelled.filter(event => ['error', 'authError'].includes(event.type)), []);
      await until('Launcher exits before frozen native child', async () =>
        receipts().some(row => row.event === 'fault-wrapper-exit') && !processState(frozen.wrapperPid));
      assert.ok(processState(frozen.childPid)?.includes('T'), 'Native child remains stopped after launcher exit');
      record('cancelled-native', { events: cancelled, previousChildState: processState(frozen.childPid), draftPreserved: true });
      const recovery = await send(first, 'RECOVER', 'Reply exactly STOP_RECOVERY_OK. Do not use tools, continue the earlier edit, or change files.');
      assert.strictEqual(recovery.answer.trim(), 'STOP_RECOVERY_OK');
      assert.ok(receipts().find(row => row.event === 'start' && row.marker === 'RECOVER')?.predecessorState?.includes('T'),
        'Replacement starts while cancelled predecessor cleanup remains pending');
      await until('Cancelled native and wrapper gone', async () => !processState(frozen.childPid) && !processState(frozen.wrapperPid), 15_000);
      assert.deepStrictEqual((await events(first)).slice(before).filter(event => ['error', 'authError'].includes(event.type)), []);
      assert.strictEqual(receipts().filter(row => row.event === 'request').length, 3);
      assert.ok(!receipts().some(row => ['deadline', 'duplicate-request', 'rejected-request', 'freeze-failed'].includes(row.event)));
      unchanged();
      record('stop-recovery-verified', { cancelledNativeGone: true, cancelledWrapperGone: true, answer: recovery.answer, filesUnchanged: true });
      await workbench.screenshot({ path: path.join(artifacts, 'stop-recovery.png') });
    });
  });
}
