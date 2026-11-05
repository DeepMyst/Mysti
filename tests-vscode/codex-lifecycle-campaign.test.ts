/** Bounded PB-02 public reset/model/profile/crash journey. No private product calls. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexHelperQualityObserver } from './codex-helper-quality-observer';
import { effortDom, assertLowEffort, selectLowEffort } from './codex-profile-compatibility-explicit-effort';
const prefix = 'MYSTI_PB02_LIFECYCLE_CAMPAIGN';
const repo = process.env[prefix + '_REPO'] || path.resolve(__dirname, '..');
const campaign = require(path.join(repo, 'scripts/validation/codex-lifecycle-campaign.cjs'));
const contract = require(path.join(repo, 'scripts/validation/codex-helper-quality-contract.cjs'));
const hash = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (process.env[prefix] === '1') {
  describe('PB-02 bounded actual lifecycle campaign', function () {
    this.timeout(1_500_000);
    let manifest: any, owner: any, browser: Browser, workbench: Page, frame: Frame, ownedTab: vscode.Tab;
    let panelId = '', conversationId = '', cycle = 0, complete = false;
    const observations: any[] = [], cycles: any[] = [];
    const directory = process.env[prefix + '_ARTIFACT_DIR']!;
    function record(event: string, details: any = {}): void {
      observations.push({ event, at: Date.now(), cycle, ...details });
      campaign.replaceSnapshot(path.join(owner.directory, 'observations.json'), observations);
    }
    async function events(type?: string): Promise<any[]> {
      const values = await frame.evaluate(() => (globalThis as any).__pb02HelperQualityEvents || []);
      return type ? values.filter((value: any) => value.type === type) : values;
    }
    async function persistEvents(): Promise<void> { campaign.replaceSnapshot(path.join(owner.directory, 'events-main.json'), await events()); }
    function wire(): any[] { return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []); }
    function files(): any { return contract.verifyCopiedFixture(manifest.fixture, panelId ? [panelId] : []); }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 60)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function noTools(): Promise<void> {
      assert.ok(!(await events()).some(value => ['permissionRequest', 'toolUse', 'toolResult', 'autonomousDecision', 'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer'].includes(value.type)), 'Only public lifecycle actions and tool-free replies are authorized');
    }
    async function selectModel(model: string): Promise<void> {
      const before = (await events('modelChanged')).length;
      await frame.locator('#model-menu-btn').click();
      const chosen = frame.locator(`#model-menu-options [data-model=${JSON.stringify(model)}]`);
      if (await chosen.count()) { await chosen.click(); } else {
        await frame.locator('#model-menu-options [data-model="__custom__"]').click();
        const quick = workbench.locator('.quick-input-widget'); await quick.waitFor({ state: 'visible' });
        assert.ok((await quick.innerText()).includes('Choose a custom model'));
        await quick.locator('input').fill(model); await quick.locator('input').press('Enter'); await quick.waitFor({ state: 'hidden' });
      }
      await until('Actual selected model acknowledgement', async () => (await events('modelChanged')).slice(before).some(value => value.payload.provider === 'openai-codex' && (value.payload.customModel || value.payload.model) === model));
      const selected = await selectLowEffort(frame); assertLowEffort(selected.after);
      record('model-selected', { model, selection: selected });
    }
    async function history(): Promise<any[]> {
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      const before = (await events('conversationHistory')).length; await frame.locator('#history-btn').click();
      await until('Actual durable public history', async () => (await events('conversationHistory')).length > before);
      const conversations = (await events('conversationHistory')).at(-1).payload.conversations;
      await frame.locator('#history-btn').click(); return conversations;
    }
    async function sendCompleted(definition: any): Promise<void> {
      assertLowEffort(await effortDom(frame)); files();
      const offset = (await events()).length, started = Date.now(), before = wire().filter(value => value.event === 'request').length;
      await frame.locator('#message-input').fill(definition.prompt); await frame.locator('#send-btn').click();
      await until('Actual cycle reply', async () => {
        await noTools(); const fresh = (await events()).slice(offset);
        assert.ok(!fresh.some(value => ['error', 'authError', 'requestCancelled'].includes(value.type)), 'No automatic retry or substitute model');
        return fresh.some(value => value.type === 'responseComplete' && value.payload?.message);
      }, 180_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const terminals = (await events()).slice(offset).filter(value => value.type === 'responseComplete'); assert.strictEqual(terminals.length, 1);
      const terminal = terminals[0], message = terminal.payload.message;
      assert.strictEqual(message.content, definition.expectedReply); assert.strictEqual(message.model, definition.model); assert.strictEqual(message.provider, 'openai-codex'); assert.deepStrictEqual(message.toolCalls || [], []);
      const requests = wire().filter(value => value.event === 'request'); assert.strictEqual(requests.length, before + 1); const request = requests.at(-1);
      campaign.assertRequestHistory(request, definition.marker, cycle === 29 ? ['PROFILE_REJECT_29'] : cycle === 30 ? ['CRASH_30'] : []);
      assert.strictEqual(request.model, definition.model); assert.strictEqual(request.effort, 'low');
      const native = wire().filter(value => value.event === 'turn-completed' && value.inputIndex === request.inputIndex); assert.strictEqual(native.length, 1); assert.strictEqual(native[0].status, 'completed');
      const stored = (await history()).find(value => value.id === conversationId); assert.ok(stored); assert.ok(stored.messages.some((value: any) => value.id === message.id && value.content === message.content));
      const result = { index: cycle, marker: definition.marker, conversationId, panelId, messageId: message.id, model: message.model, started, completedAt: terminal.at,
        wrapperPid: request.wrapperPid, inputIndex: request.inputIndex, sessionHash: request.sessionHash, request, content: message.content };
      cycles.push(result); record('cycle-complete', result); await persistEvents(); files();
    }
    async function reset(): Promise<void> {
      const oldConversationId = conversationId, before = (await events()).length;
      record('reset-start', { oldConversationId, oldWrapperPid: cycles.at(-1).wrapperPid });
      await frame.locator('#new-conversation-btn').click();
      await until('Public new conversation reset', async () => {
        const fresh = (await events()).slice(before);
        return fresh.some(value => value.type === 'conversationChanged' && value.payload?.id !== oldConversationId) && fresh.some(value => value.type === 'sessionCleared');
      });
      const changed = (await events()).slice(before).filter(value => value.type === 'conversationChanged'); assert.strictEqual(changed.length, 1);
      conversationId = changed[0].payload.id; assert.ok(!cycles.some(value => value.conversationId === conversationId));
      record('reset-complete', { oldConversationId, newConversationId: conversationId });
    }
    async function rejectProfile(): Promise<any> {
      const selectedAt = Date.now(), inputCountBefore = wire().filter(value => value.event === 'request').length;
      await vscode.workspace.getConfiguration('mysti').update('codexProfile', manifest.profileValidation.missing.name, vscode.ConfigurationTarget.Global);
      const configRaw = vscode.workspace.getConfiguration('mysti').get('codexProfile'); assert.strictEqual(configRaw, manifest.profileValidation.missing.name);
      const offset = (await events()).length, started = Date.now(), errorsBefore = await frame.locator('.message.error').count();
      await frame.locator('#message-input').fill(campaign.profilePrompt(manifest.token)); await frame.locator('#send-btn').click();
      await until('Unsupported named profile is visibly rejected', async () => {
        await noTools(); const fresh = (await events()).slice(offset);
        assert.ok(!fresh.some(value => value.type === 'responseComplete'));
        return fresh.some(value => value.type === 'error') && await frame.locator('.message.error').count() > errorsBefore;
      }, 90_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const visibleError = await frame.locator('.message.error').last().innerText(); assert.strictEqual(visibleError, `Error: ${campaign.PROFILE_ERROR}`);
      await until('All observed rejected profile invocations have actual exits', async () => {
        const rows = wire(), invocations = rows.filter(value => value.event === 'invocation' && value.selectedProfile === configRaw);
        return invocations.length > 0 && invocations.every(value => rows.some(row => row.event === 'exit' && row.wrapperPid === value.wrapperPid));
      });
      const inputCountAfter = wire().filter(value => value.event === 'request').length; assert.strictEqual(inputCountAfter, inputCountBefore);
      const result = { selectedAt, started, ended: Date.now(), configRaw, visibleError, inputCountBefore, inputCountAfter }; record('profile-rejected', result); await persistEvents();
      await vscode.workspace.getConfiguration('mysti').update('codexProfile', '', vscode.ConfigurationTarget.Global);
      assert.strictEqual(vscode.workspace.getConfiguration('mysti').get('codexProfile'), ''); record('profile-cleared', { value: '' });
      await selectLowEffort(frame); return result;
    }
    async function crash(): Promise<any> {
      assertLowEffort(await effortDom(frame)); const offset = (await events()).length, started = Date.now(), errorsBefore = await frame.locator('.message.error').count();
      await frame.locator('#message-input').fill(campaign.crashPrompt(manifest.token)); await frame.locator('#send-btn').click();
      await until('Actual acknowledged crash turn', async () => wire().some(value => value.event === 'turn-started' && value.inputIndex === 31));
      const request = wire().find(value => value.event === 'request' && value.inputIndex === 31); assert.ok(request);
      assert.ok(!wire().some(value => value.event === 'turn-completed' && value.inputIndex === 31), 'Completed turn cannot be faulted or retried');
      assert.ok(!fs.existsSync(path.join(directory, 'fault-request.json')));
      campaign.replaceSnapshot(path.join(directory, 'fault-request.json'), { marker: 'CRASH_30', inputIndex: 31, wrapperPid: request.wrapperPid, signal: 'SIGKILL', requestedAt: Date.now() });
      await until('Independent native child fault observation', async () => fs.existsSync(path.join(directory, 'fault-result.json')));
      const fault = JSON.parse(fs.readFileSync(path.join(directory, 'fault-result.json'), 'utf8')); assert.strictEqual(fault.status, 'SIGNAL_ISSUED');
      await until('Incomplete response is visibly surfaced', async () => {
        await noTools(); const fresh = (await events()).slice(offset);
        return fresh.some(value => value.type === 'error') && await frame.locator('.message.error').count() > errorsBefore;
      }, 90_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      assert.strictEqual(wire().filter(value => value.event === 'request').length, 31, 'Crash must not cause an automatic resend');
      const result = { started, ended: Date.now(), visibleError: true, errorText: await frame.locator('.message.error').last().innerText(), busyStopped: true, fault };
      record('crash-observed', result); await persistEvents(); return result;
    }
    async function oldProcessExited(oldWrapperPid: number): Promise<void> {
      const started = Date.now(); let observed: any;
      await until('External observation verifies prior owned process identities exited', async () => {
        const file = path.join(directory, 'external-live.json'); if (!fs.existsSync(file)) { return false; }
        const sample = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (sample.at >= cycles.at(-1).completedAt && !sample.rows.some((value: any) => value.wrapperPid === oldWrapperPid)) { observed = sample; return true; }
        return false;
      }, 10_000);
      record('old-process-exited', { cycle: cycles.at(-1).index, oldWrapperPid, started, snapshotAt: observed.at });
    }
    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.stage, campaign.STAGE); assert.strictEqual(manifest.maxForwardedInputs, 32); assert.strictEqual(manifest.auxiliary.maxInputs, 32);
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(hash(path.join(extension.extensionPath, 'dist/extension.js')), manifest.bundleSha256); assert.strictEqual(hash(path.join(extension.extensionPath, 'media/chat/chat.js')), manifest.chatSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installCodexHelperQualityObserver); }
      for (const page of browser.contexts().flatMap(context => context.pages())) { if (await page.locator('.monaco-workbench').count()) { workbench = page; break; } }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      const priorFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      const priorTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs)); await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('Fresh actual owned chat', async () => {
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (priorFrames.has(candidate)) { continue; }
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { frame = candidate; return true; } } catch { /* Mounting. */ }
        } return false;
      });
      await frame.evaluate(installCodexHelperQualityObserver);
      const newTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !priorTabs.has(tab) && tab.input instanceof vscode.TabInputWebview); assert.strictEqual(newTabs.length, 1); ownedTab = newTabs[0];
      await workbench.bringToFront(); if (await frame.locator('.wizard-skip-btn').isVisible()) { await frame.locator('.wizard-skip-btn').click(); }
      const initial = (await events('initialState')).at(-1).payload; panelId = initial.panelId; conversationId = initial.conversationId; assert.ok(panelId && conversationId);
      await frame.locator('#agent-select-btn').click(); await frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
      await frame.locator('#behavior-indicator').click(); await frame.locator('#behavior-popup .mode-option[data-mode="ask"]').click();
      await selectModel(manifest.models.primary); files(); contract.verifyPreservedBase(manifest.fixture); record('identity', { panelId, conversationId });
    });
    it('performs thirty real public thread resets and bounded model/profile/crash recovery', async () => {
      let profileRejection: any, crashRecovery: any;
      for (const definition of manifest.cycles) {
        cycle = definition.index; const oldWrapperPid = cycles.at(-1)?.wrapperPid;
        if (cycle) { await reset(); }
        if (cycle === 27 || cycle === 28) { await selectModel(definition.model); }
        if (cycle === 29) { profileRejection = await rejectProfile(); }
        if (cycle === 30) { crashRecovery = await crash(); }
        await sendCompleted(definition);
        if (oldWrapperPid) { await oldProcessExited(oldWrapperPid); }
      }
      const conversations = await history(); await persistEvents();
      const acceptance = { status: 'CAPTURED_LIFECYCLE_CAMPAIGN_30', stage: manifest.stage, panelId, cycles, profileRejection, crashRecovery,
        finalConversations: conversations, files: files(), counts: { publicAttempts: 33, completedReplies: 31, resets: 30, conversationalInputs: wire().filter(value => value.event === 'request').length } };
      assert.strictEqual(acceptance.counts.conversationalInputs, 32); contract.verifyPreservedBase(manifest.fixture);
      campaign.replaceSnapshot(path.join(owner.directory, 'acceptance.json'), acceptance); record('capture-complete', { counts: acceptance.counts });
      assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.includes(ownedTab)));
      const started = Date.now(), accepted = await vscode.window.tabGroups.close(ownedTab, true); assert.strictEqual(accepted, true);
      await until('Owned final public tab closes', async () => frame.isDetached() && !vscode.window.tabGroups.all.some(group => group.tabs.includes(ownedTab)));
      record('final-tab-closed', { started, accepted, absent: true, frameDetached: true }); complete = true;
    });
    after(async () => { if (frame && !frame.isDetached()) { await persistEvents().catch(() => {}); } if (!complete) { await workbench?.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {}); } await browser?.close().catch(() => {}); });
  });
}
