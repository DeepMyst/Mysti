/** Opt-in, one real review per provider through the packaged native UI.
 * The launcher preserves Mysti policy and restricts tool access.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

const restoreReview = process.env.MYSTI_COPILOT_REVIEW_RESTORE === '1';
if (process.env.MYSTI_COPILOT_REVIEW_NATIVE === '1' || restoreReview) {
  describe('Native three-agent retry review', function () {
    this.timeout(340_000);
    const artifacts = process.env.MYSTI_COPILOT_ARTIFACTS!;
    const workspace = process.env.MYSTI_CONTEXT_WORKSPACE!;
    const profile = process.env.MYSTI_TEST_USER_DATA_DIR!;
    const originalRun = process.env.MYSTI_REVIEW_ORIGINAL_RUN || artifacts;
    const fixture = JSON.parse(fs.readFileSync(path.join(originalRun, 'fixture.json'), 'utf8'));
    const observations: unknown[] = [], tabs: vscode.Tab[] = [];
    let browser: Browser, workbench: Page, first: Frame, second: Frame | undefined;
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const receipts = (): any[] => fs.existsSync(path.join(artifacts, 'review-receipts.jsonl'))
      ? fs.readFileSync(path.join(artifacts, 'review-receipts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
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
          if (['conversationChanged', 'conversationHistory', 'messageAdded', 'responseComplete', 'error', 'authError', 'composerSubmissionSettled', 'collaborator', 'collaborationStarted', 'collaborationComplete', 'collaborationError'].includes(event.data?.type)) {
            win.__functionalEvents.push(event.data);
          }
        });
      });
      if (await frame!.locator('#setup-wizard').isVisible()) await frame!.locator('.wizard-skip-btn').click();
      if (!restoreReview) {
        await frame!.locator('#new-conversation-btn').click();
        await until('Fresh Copilot conversation', async () => (await events(frame!)).some(event => event.type === 'conversationChanged'));
      }
      await frame!.locator('#agent-select-btn').click();
      await frame!.locator('#agent-menu .agent-menu-item[data-agent="github-copilot"]').click();
      await until('Copilot explicitly selected', async () => (await frame!.locator('#agent-name').innerText()).includes('Copilot'));
      return frame!;
    }
    async function mode(frame: Frame, mode: string): Promise<void> {
      await frame.locator('#behavior-indicator').click();
      await frame.locator(`#behavior-popup .mode-option[data-mode="${mode}"]`).click();
    }
    before(async () => {
      assert.ok(path.isAbsolute(artifacts) && fs.existsSync(path.join(artifacts, '.owned-native-test')));
      assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(workspace));
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(profile, '.owned-native-profile.json'), 'utf8')).artifacts, originalRun);
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
    (restoreReview ? it.skip : it)('retains three independent attributed reviews and performs no edits', async () => {
      const prompt = '@claude @codex @copilot COPILOT_REVIEW:THREE_AGENT Review this proposed retry policy: delay = Math.min(1000, 73 * attempt). The requirement is exponential backoff for nonnegative integer attempts, starting at 73 milliseconds for attempt zero. Give the incorrect value produced at attempt 3, the correct value, and the smallest correction. Do not use tools or delegate. Keep your answer under 80 words.';
      await first.locator('#message-input').fill(prompt); await first.locator('#send-btn').click();
      await until('All three reviewers terminal', async () => {
        const all=await events(first);
        return new Set(all.filter(event=>event.type==='collaborator' && ['collab_complete','collab_skipped'].includes(event.payload.type))
          .map(event=>event.payload.agentId)).size>=3
          || all.some(event=>['error','authError','collaborationError'].includes(event.type));
      }, 150_000);
      const all=await events(first);record('review-events',all);
      const failures=all.filter(event=>['error','authError','collaborationError'].includes(event.type)
        || event.type==='collaborator' && (['collab_error','collab_skipped','collab_retry'].includes(event.payload.type) || event.payload.hasError===true));
      assert.deepStrictEqual(failures,[],'Each real backend must complete its own review');
      const completed=all.filter(event=>event.type==='collaborator' && event.payload.type==='collab_complete');
      assert.strictEqual(completed.length,3);
      assert.deepStrictEqual(completed.map(event=>event.payload.agentId).sort(),['claude-code','github-copilot','openai-codex']);
      await until('Final review message',async()=>(await events(first)).some(event=>event.type==='responseComplete'));
      const cards=first.locator('.collaboration-card');assert.strictEqual(await cards.count(),3);
      const answers=[];
      for(const card of await cards.all()){
        if (await card.getAttribute('open') === null) await card.locator('summary').click();
        const answer=await card.locator('.collaboration-output').innerText();assert.match(answer,/\b219\b/);assert.match(answer,/\b584\b/);answers.push(answer);
      }
      const requests=receipts().filter(row=>row.event==='request');assert.strictEqual(requests.length,3);
      assert.deepStrictEqual(requests.map(row=>row.provider).sort(),['claude-code','github-copilot','openai-codex']);
      assert.ok(!receipts().some(row=>['tool-start','deadline','rejected-prompt','rejected-duplicate-process'].includes(row.event)));
      const copilot=requests.find(row=>row.provider==='github-copilot');assert.strictEqual(copilot.policy.model,'auto');assert.strictEqual(copilot.policy.effort,undefined);
      assert.deepStrictEqual(copilot.policy.denyTools,['shell','write']);assert.strictEqual(copilot.policy.allowAllTools,false);
      const codex=receipts().find(row=>row.event==='thread-config' && row.provider==='openai-codex');assert.ok(codex);
      assert.strictEqual(codex.sandbox,'read-only');assert.strictEqual(codex.approvalPolicy,'never');assert.strictEqual(codex.model,'gpt-5.6-luna');
      assert.strictEqual(requests.find(row=>row.provider==='claude-code').policy.permissionMode,'plan');
      for(const [file,digest]of Object.entries(fixture.files))assert.strictEqual(hash(fs.readFileSync(path.join(workspace,file))),digest);
      record('three-real-reviews-verified',{answers,providers:completed.map(event=>event.payload.agentId),filesUnchanged:true});
    });
    (restoreReview ? it : it.skip)('restores the exact three real reviews after an editor restart without sending again', async () => {
      const prior = JSON.parse(fs.readFileSync(path.join(originalRun, 'observations.json'), 'utf8'));
      const previousEvents = prior.find((row: any) => row.event === 'final-events').detail;
      const conversationId = previousEvents.find((event: any) => event.type === 'conversationChanged').payload.id;
      const expected = previousEvents.find((event: any) => event.type === 'responseComplete').payload.message;
      assert.strictEqual(expected.role, 'assistant');
      assert.deepStrictEqual(expected.participants, ['claude-code', 'openai-codex', 'github-copilot']);
      await first.locator('#history-btn').click();
      const item = first.locator(`#history-menu .history-item[data-conversation-id="${conversationId}"] .history-item-info`);
      await until('Saved real review in history', async () => await item.count() === 1);
      await item.click();
      await until('Original review restored', async () => (await events(first)).some(event =>
        event.type === 'conversationChanged' && event.payload.id === conversationId));
      const restored = (await events(first)).filter(event => event.type === 'conversationChanged' && event.payload.id === conversationId).at(-1).payload;
      const assistant = restored.messages.find((message: any) => message.id === expected.id);
      assert.ok(assistant); assert.strictEqual(assistant.content, expected.content);
      assert.deepStrictEqual(assistant.participants, expected.participants);
      const rendered = await first.locator('.message.assistant').last().innerText();
      for (const name of ['Claude', 'Codex', 'Copilot']) assert.ok(rendered.includes(name));
      assert.match(rendered, /\b219\b/); assert.match(rendered, /\b584\b/);
      assert.deepStrictEqual((await events(first)).filter(event => ['error', 'authError', 'collaborationStarted'].includes(event.type)), []);
      for (const [file, digest] of Object.entries(fixture.files)) assert.strictEqual(hash(fs.readFileSync(path.join(workspace, file))), digest);
      record('saved-real-reviews-restored', { conversationId, messageId: assistant.id, content: assistant.content, participants: assistant.participants, rendered });
      await workbench.screenshot({ path: path.join(artifacts, 'restored-review.png') });
    });
  });
}
