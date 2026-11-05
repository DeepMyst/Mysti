/** Three bounded owned helper examples through the actual editor/frontend. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexHelperQualityObserver, captureHelperQualityDom } from './codex-helper-quality-observer';
import { effortDom, assertLowEffort, selectLowEffort } from './codex-profile-compatibility-explicit-effort';
const repo = process.env.MYSTI_PB02_HELPER_QUALITY_REPO || path.resolve(__dirname, '..');
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
if (process.env.MYSTI_PB02_HELPER_QUALITY === '1') {
  // Native campaign imports may resolve pinned local evidence; require opt-in first.
  const { verifyPreservedBase, verifyCopiedFixture } = require(path.join(repo, 'scripts/validation/codex-helper-quality-contract.cjs'));
  describe('PB-02 real editor helper quality', function () {
    this.timeout(900_000);
    let manifest: any, owner: any, browser: Browser, workbench: Page, frame: Frame, ownedTab: vscode.Tab;
    let caseId = '', sourceId = '', panelId = '', complete = false;
    const observations: any[] = [], panels: any[] = [], panelIds: string[] = [], savedEvents = new Map<string, any[]>();
    function record(event: string, details: any = {}): void {
      const entry = { event, at: Date.now(), caseId, ...details }; observations.push(entry);
      fs.writeFileSync(path.join(owner.directory, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PB-02]', JSON.stringify(entry));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 80)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function events(type?: string): Promise<any[]> {
      const result = await frame.evaluate(() => (globalThis as any).__pb02HelperQualityEvents || []);
      return type ? result.filter((value: any) => value.type === type) : result;
    }
    function readReceipts(paths: string[]): any[] { return paths.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []); }
    const receipts = (): any[] => readReceipts(owner.receiptPaths);
    const helperReceipts = (): any[] => readReceipts(owner.auxiliaryReceiptPaths);
    const files = (): any => verifyCopiedFixture(manifest.fixture, panelIds);
    async function noUnexpectedActions(offset = 0): Promise<void> {
      const fresh = (await events()).slice(offset);
      for (const event of fresh.filter(value => value.type === 'permissionRequest')) {
        const request = event.payload;
        const button = frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="deny"]`);
        if (await button.count()) { await button.click(); }
        record('unexpected-permission-denied', { request });
      }
      assert.ok(!fresh.some(value => ['permissionRequest', 'toolUse', 'toolResult', 'autonomousDecision', 'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer'].includes(value.type)), 'No tools or autonomous card actions are authorized');
    }
    async function openHistory(): Promise<number> {
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      const count = (await events('conversationHistory')).length, started = Date.now();
      await frame.locator('#history-btn').click();
      await until('Actual public history', async () => (await events('conversationHistory')).length > count);
      return started;
    }
    async function openCase(definition: any): Promise<void> {
      caseId = definition.caseId;
      const prior = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      const priorTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('Fresh actual chat mounts', async () => {
        const matches: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (prior.has(candidate)) { continue; }
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { matches.push(candidate); } } catch { /* Mounting only. */ }
        }
        if (matches.length !== 1) { return false; } frame = matches[0]; return true;
      });
      await frame.evaluate(installCodexHelperQualityObserver);
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !priorTabs.has(tab) && tab.input instanceof vscode.TabInputWebview);
      assert.strictEqual(tabs.length, 1); ownedTab = tabs[0];
      record('effort-startup', { configuredDefault: vscode.workspace.getConfiguration('mysti').get('defaultEffortLevel'), dom: await effortDom(frame), settingsEvents: (await events()).filter(value => ['initialState', 'settingsSync'].includes(value.type)) });
      await workbench.bringToFront(); if (await frame.locator('.wizard-skip-btn').isVisible()) { await frame.locator('.wizard-skip-btn').click(); }
      await until('Actual new-tab conversation identity', async () => (await events('initialState')).some(value => value.payload?.conversationId && value.payload?.panelId));
      const initial = (await events('initialState')).at(-1).payload; sourceId = initial.conversationId; panelId = initial.panelId;
      assert.ok(!panels.some(value => value.conversationId === sourceId), 'The public new-tab command owns a fresh conversation');
      assert.ok(panelId); assert.ok(!panelIds.includes(panelId)); panelIds.push(panelId);
      await frame.locator('#agent-select-btn').click(); await frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
      await frame.locator('#behavior-indicator').click(); await frame.locator('#behavior-popup .mode-option[data-mode="ask"]').click();
      const before = (await events('modelChanged')).length; await frame.locator('#model-menu-btn').click();
      const selected = frame.locator(`#model-menu-options [data-model=${JSON.stringify(manifest.model)}]`);
      if (await selected.count()) { await selected.click(); } else {
        await frame.locator('#model-menu-options [data-model="__custom__"]').click();
        const quick = workbench.locator('.quick-input-widget'); await quick.waitFor({ state: 'visible' });
        assert.ok((await quick.innerText()).includes('Choose a custom model')); await quick.locator('input').fill(manifest.model); await quick.locator('input').press('Enter'); await quick.waitFor({ state: 'hidden' });
      }
      await until('Explicit native model selected', async () => (await events('modelChanged')).slice(before).some(value => value.payload.provider === 'openai-codex' && (value.payload.customModel || value.payload.model) === manifest.model));
      const effortStarted = Date.now(), selection = await selectLowEffort(frame);
      await until('Configured explicit low', async () => vscode.workspace.getConfiguration('mysti').get('defaultEffortLevel') === 'low');
      record('effort-selected', { started: effortStarted, ended: Date.now(), ...selection, configuredAfter: vscode.workspace.getConfiguration('mysti').get('defaultEffortLevel') });
      files(); verifyPreservedBase(manifest.fixture); record('identity', { panelId, sourceId, model: manifest.model });
    }
    async function sendCase(definition: any): Promise<{ reply: any; historyOpenedAt: number }> {
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, panels.length); assert.ok(panels.length < 3);
      assertLowEffort(await effortDom(frame));
      const offset = (await events()).length, started = Date.now(), beforeFiles = files();
      await frame.locator('#message-input').fill(definition.prompt); await frame.locator('#send-btn').click();
      const historyOpenedAt = await openHistory();
      await until('Literal native response completes', async () => {
        await noUnexpectedActions(offset); const fresh = (await events()).slice(offset);
        const errors = fresh.filter(value => ['error', 'authError', 'requestCancelled'].includes(value.type));
        if (errors.length) { record('native-error', { errors }); throw new Error('Native error; no automatic retry'); }
        return fresh.some(value => value.type === 'responseComplete' && value.payload?.message);
      }, 180_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(offset), terminals = fresh.filter(value => value.type === 'responseComplete'); assert.strictEqual(terminals.length, 1);
      const message = terminals[0].payload.message;
      assert.strictEqual(message.provider, 'openai-codex'); assert.strictEqual(message.model, manifest.model); assert.deepStrictEqual(message.toolCalls || [], []);
      const requests = receipts().filter(value => value.event === 'request' && value.at >= started); assert.strictEqual(requests.length, 1); const request = requests[0];
      assert.deepStrictEqual(request.outsideMemoryMarkers, [definition.marker]); assert.strictEqual(request.model, manifest.model); assert.strictEqual(request.effort, 'low');
      assert.strictEqual(request.policy.ownedCwd, true); assert.strictEqual(request.policy.approvalPolicy, 'untrusted'); assert.strictEqual(request.policy.sandbox, 'read-only');
      for (const field of ['mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) { assert.strictEqual(request.policy[field], true); }
      const nativeSession = receipts().filter(value => value.event === 'session' && value.wrapperPid === request.wrapperPid && value.at <= request.at).at(-1);
      assert.ok(nativeSession); assert.strictEqual(nativeSession.actualModel, manifest.model); assert.strictEqual(nativeSession.sessionHash, request.sessionHash);
      const wire = receipts().filter(value => value.wrapperPid === request.wrapperPid && value.inputIndex === request.inputIndex);
      const terminal = wire.filter(value => value.event === 'turn-completed'); assert.strictEqual(terminal.length, 1); assert.strictEqual(terminal[0].status, 'completed');
      assert.ok(!wire.some(value => ['tool-start', 'tool-result', 'approval-request', 'approval-decision', 'unexpected-tool-item'].includes(value.event)));
      const reply = { ordinal: panels.length + 1, marker: definition.marker, scope: {}, beforeFiles, toolOutputEvidence: [], conversationId: sourceId, panelId,
        messageId: message.id, provider: message.provider, model: message.model, content: message.content, tools: [], usage: message.usage, request, nativeSession,
        started, completedAt: terminals[0].at, turnCompleted: terminal[0], nativeTools: [], permissionDecisionIds: [] };
      record('native-response', { ...reply, afterFiles: files() });
      if (message.content !== definition.expectedReply) { record('partial-main-literal-mismatch', { expectedSha256: hash(definition.expectedReply), actualSha256: hash(message.content) }); }
      return { reply, historyOpenedAt };
    }
    async function settleAndSnapshot(reply: any, historyOpenedAt: number): Promise<any> {
      const started = Date.now(), deadline = started + 35_000; let timedOut = true, terminalSeenAt = 0;
      while (Date.now() < deadline) {
        await noUnexpectedActions();
        const helperRows = helperReceipts().filter(value => value.at >= reply.started);
        const submissions = helperRows.filter(value => value.event === 'auxiliary-submission');
        const allThree = ['title', 'suggestion', 'classification'].every(purpose => submissions.some(value => value.purpose === purpose));
        const allExited = allThree && submissions.every(value => helperRows.some(row => row.event === 'auxiliary-result' && row.wrapperPid === value.wrapperPid) && helperRows.some(row => row.event === 'exit' && row.wrapperPid === value.wrapperPid));
        if (allExited) { terminalSeenAt ||= Date.now(); if (Date.now() - terminalSeenAt >= 750) { timedOut = false; break; } }
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      const helperWait = { started, deadline, ended: Date.now(), timedOut };
      await openHistory();
      const history = (await events('conversationHistory')).at(-1).payload.conversations;
      const finalConversation = history.find((value: any) => value.id === sourceId); assert.ok(finalConversation);
      assert.ok(finalConversation.messages.some((value: any) => value.id === reply.messageId && value.content === reply.content));
      const row = frame.locator(`.history-item[data-conversation-id=${JSON.stringify(sourceId)}] .history-item-title`); await row.waitFor({ state: 'visible' });
      const historyTitle = (await row.textContent())?.trim() || '';
      const titleEvents = await events('titleUpdated'), titleAt = titleEvents.filter(value => value.payload.conversationId === sourceId).at(-1)?.at || reply.started;
      const observedTitles = await frame.evaluate(() => (globalThis as any).__pb02HelperQualityTitleObservations || []);
      const visibleAt = observedTitles.find((value: any) => value.conversationId === sourceId && value.title === historyTitle && value.at >= titleAt && value.at >= historyOpenedAt)?.at ?? null;
      fs.writeFileSync(path.join(owner.directory, `title-observations-${caseId}.json`), JSON.stringify(observedTitles, null, 2));
      await frame.locator('#history-btn').click();
      const dom = await captureHelperQualityDom(frame);
      return { helperWait, finalConversation, dom: { ...dom, title: { historyConversationId: sourceId, historyTitle, historyOpenedAt, visibleAt }, titleObservations: observedTitles } };
    }
    async function closeCase(reply: any): Promise<any> {
      savedEvents.set(caseId, await events());
      const eventsPath = path.join(owner.directory, `events-${caseId}.json`); fs.writeFileSync(eventsPath, JSON.stringify(savedEvents.get(caseId), null, 2));
      const before = receipts(), finalWrapperPid = reply.request.wrapperPid, starts = before.filter(value => value.event === 'start' && value.wrapperPid === finalWrapperPid); assert.strictEqual(starts.length, 1);
      assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.includes(ownedTab))); assert.ok(ownedTab.input instanceof vscode.TabInputWebview);
      const tab = { label: ownedTab.label, viewType: (ownedTab.input as vscode.TabInputWebview).viewType }; record('owned-chat-tab', { panelId, ...tab });
      const started = Date.now(), receiptStartIndex = before.length;
      record('lifecycle-boundary-start', { panelId, tab, started, receiptStartIndex, finalWrapperPid, finalChildPid: starts[0].childPid });
      let tabCloseEventSeen = false; const listener = vscode.window.tabGroups.onDidChangeTabs(event => { if (event.closed.includes(ownedTab)) { tabCloseEventSeen = true; } });
      let closeAccepted: boolean, closedAt: number;
      try {
        closeAccepted = await vscode.window.tabGroups.close(ownedTab, true); closedAt = Date.now(); assert.strictEqual(closeAccepted, true);
        await until('Actual owned tab and native process close', async () => {
          const current = receipts(); assert.strictEqual(current.filter(value => value.event === 'request').length, panels.length + 1);
          assert.ok(!current.slice(receiptStartIndex).some(value => value.event === 'invocation' && (value.kind !== 'probe' || JSON.stringify(value.args) !== JSON.stringify(['--version']))));
          return tabCloseEventSeen && frame.isDetached() && !vscode.window.tabGroups.all.some(group => group.tabs.includes(ownedTab));
        }, 15_000);
      } finally { listener.dispose(); }
      // Panel cancellation can force-kill the owned process group including this observer wrapper.
      // Keep actual receipt absence unknown; the independent runner separately verifies observed process exits.
      const terminalDeadline = Date.now() + 2_000;
      while (Date.now() < terminalDeadline && !receipts().some(value => value.event === 'exit' && value.wrapperPid === finalWrapperPid)) { await new Promise(resolve => setTimeout(resolve, 80)); }
      const after = receipts(), summaries = after.filter(value => value.event === 'stderr-summary' && value.wrapperPid === finalWrapperPid), exits = after.filter(value => value.event === 'exit' && value.wrapperPid === finalWrapperPid);
      assert.ok(summaries.length <= 1); assert.ok(exits.length <= 1);
      const terminalStatus = summaries.length === 1 && exits.length === 1 ? 'complete' : 'UNOBSERVED';
      const lifecycleBoundary = { action: 'public-owned-chat-tab-close', panelId, tab, started, closedAt, ended: Date.now(), closeAccepted,
        tabAbsent: true, frameDetached: true, tabCloseEventSeen, receiptStartIndex, receiptEndIndex: after.length,
        finalWrapperPid, finalChildPid: starts[0].childPid, finalInputIndex: reply.request.inputIndex, terminalStatus, summary: summaries[0] || null, exit: exits[0] || null,
        inputCountBefore: panels.length + 1, inputCountAfter: panels.length + 1 };
      record('lifecycle-boundary', lifecycleBoundary); return { tab, eventsPath, lifecycleBoundary };
    }
    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PB02_HELPER_QUALITY_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.stage, 'HELPER_QUALITY_3'); assert.strictEqual(manifest.maxForwardedInputs, 3); assert.strictEqual(manifest.auxiliary.maxInputs, 10);
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installCodexHelperQualityObserver); }
      for (const page of browser.contexts().flatMap(context => context.pages())) { if (await page.locator('.monaco-workbench').count()) { workbench = page; break; } }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000); files(); verifyPreservedBase(manifest.fixture);
    });
    it('observes three fresh literal examples and their actual helper outcomes without interacting with cards', async () => {
      for (const definition of manifest.cases) {
        const started = Date.now(); await openCase(definition);
        const { reply, historyOpenedAt } = await sendCase(definition), snapshot = await settleAndSnapshot(reply, historyOpenedAt);
        const userMessage = (await events('messageAdded')).find(value => value.payload.role === 'user')?.payload; assert.ok(userMessage);
        const closed = await closeCase(reply);
        panels.push({ caseId, panelId, conversationId: sourceId, reply, userMessage, ...snapshot, ...closed, started, ended: Date.now() });
        fs.writeFileSync(path.join(owner.directory, 'completed-panels.json'), JSON.stringify(panels, null, 2));
      }
      assert.strictEqual(panels.length, 3); assert.strictEqual(receipts().filter(value => value.event === 'request').length, 3); verifyPreservedBase(manifest.fixture);
      const acceptance = { status: 'CAPTURED_HELPER_QUALITY_3', stage: manifest.stage, panels, files: files(), preservedBase: manifest.fixture.base,
        counts: { completedTurns: 3, conversationalInputs: 3, auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length },
        scope: manifest.scope, semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
      fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify(acceptance, null, 2)); complete = true; record('acceptance-complete', { counts: acceptance.counts });
    });
    after(async () => {
      if (owner) {
        if (!complete) { await workbench?.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {}); }
        if (frame && !frame.isDetached()) { savedEvents.set(caseId, await events().catch(() => [])); }
        for (const [id, values] of savedEvents) { fs.writeFileSync(path.join(owner.directory, `events-${id}.json`), JSON.stringify(values, null, 2)); }
      }
      await browser?.close().catch(() => {});
    });
  });
}
