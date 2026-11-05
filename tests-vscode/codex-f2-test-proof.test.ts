/** One native approved client-test invocation; no retries or source edits. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexF2TestProofObserver } from './codex-f2-test-proof-observer';
import { effortDom, assertLowEffort, selectLowEffort } from './codex-profile-compatibility-explicit-effort';
const repo = process.env.MYSTI_PB02_F2_TEST_PROOF_REPO || path.resolve(__dirname, '..');
const contract = require(path.join(repo, 'scripts/validation/codex-f2-test-proof.cjs'));
const { assertToolOutputProjection } = require(path.join(repo, 'scripts/validation/codex-full-oracle.cjs'));
const { joinNativeAssistantMessages } = require(path.join(repo, 'scripts/validation/audit-vscode-codex-helper-quality.cjs'));

if (process.env.MYSTI_PB02_F2_TEST_PROOF === '1') {
  describe('PB-02 one-command client-test authority proof', function () {
    this.timeout(600_000);
    let manifest: any, owner: any, campaign: any, browser: Browser, workbench: Page, frame: Frame;
    let conversationId = '', panelId = '', finished = false;
    const observations: any[] = [], replies: any[] = [], decisions = new Set<string>(), completedCases: string[] = [], panelIds: string[] = [];
    const read = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (file: string, value: any): void => { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); };
    const receipts = (): any[] => owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    const files = (): any => contract.verifySnapshot(manifest.fixture, completedCases, panelIds);
    function record(event: string, details: any = {}): void {
      const value = { event, at: Date.now(), segment: manifest.segment.index, ...details }; observations.push(value);
      fs.writeFileSync(path.join(owner.directory, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PB-02 F2]', JSON.stringify(value));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw Error(`${label}: timeout after ${timeout}ms; no automatic retry`);
    }
    async function events(type?: string): Promise<any[]> {
      const rows = await frame.evaluate(() => (globalThis as any).__pb02FullFollowupEvents || []);
      return type ? rows.filter((row: any) => row.type === type) : rows;
    }
    async function history(): Promise<any> {
      if (await frame.locator('#history-menu').isVisible()) await frame.locator('#history-btn').click();
      const offset = (await events('conversationHistory')).length;
      await frame.locator('#history-btn').click();
      await until('Actual stored conversation history', async () => (await events('conversationHistory')).length > offset);
      return (await events('conversationHistory')).at(-1).payload.conversations;
    }
    async function permissions(offset: number, step: any, commands: string[]): Promise<void> {
      for (const row of (await events()).slice(offset).filter(value => value.type === 'permissionRequest')) {
        const request = row.payload; if (decisions.has(request.id)) continue;
        const input = request.details?.toolInput || {}, name = String(request.details?.toolName || request.title).toLowerCase();
        const command = name === 'bash' && input.cwd === owner.workspace && commands.some(value => contract.exactCommand(input.command, value));
        const expectedDenial = false;
        const approved = command;
        const beforeFiles = files();
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id); record('permission-decision', { marker: step.marker, id: request.id, name, input, approved, expectedDenial, beforeFiles });
        assert.ok(approved || expectedDenial, 'Unexpected native action denied; scope cannot be widened');
      }
    }
    async function send(step: any): Promise<void> {
      const commands: string[] = step.commands;
      assertLowEffort(await effortDom(frame));
      const globalCount = fs.existsSync(campaign.counterFile) ? read(campaign.counterFile).forwardedInputs : 0;
      assert.strictEqual(globalCount, step.ordinal - 1); assert.ok(globalCount < contract.MAIN_CAP);
      const priorConversation = (await history()).find((value: any) => value.id === conversationId); assert.ok(priorConversation);
      const priorMessages = priorConversation.messages;
      await frame.locator('#history-btn').click();
      const beforeFiles = files(), offset = (await events()).length, started = Date.now(), prompt = contract.promptFor(step, commands);
      record('turn-start', { ordinal: step.ordinal, marker: step.marker, beforeFiles, effort: await effortDom(frame) });
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      await until(step.marker, async () => {
        await permissions(offset, step, commands);
        const fresh = (await events()).slice(offset), errors = fresh.filter(row => ['error', 'authError', 'requestCancelled'].includes(row.type));
        if (errors.length) { record('native-error', { marker: step.marker, errors }); throw Error('Actual native error; retain first failure without retry'); }
        return fresh.some(row => row.type === 'responseComplete' && row.payload?.message);
      }, 300_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(offset), completed = fresh.filter(row => row.type === 'responseComplete' && row.payload?.message);
      assert.strictEqual(completed.length, 1); const message = completed[0].payload.message;
      assert.strictEqual(message.provider, 'openai-codex'); assert.strictEqual(message.model, manifest.model);
      assert.ok(message.content.includes(`PB02_DONE:${step.marker}`));
      const inputs = receipts().filter(row => row.event === 'request' && row.inputIndex === step.ordinal);
      assert.strictEqual(inputs.length, 1); const request = inputs[0];
      assert.strictEqual(request.model, manifest.model); assert.strictEqual(request.effort, 'low');
      const permittedMarkers = [manifest.proof.marker];
      assert.ok(request.outsideMemoryMarkers.includes(step.marker));
      assert.ok(request.markers.every((marker: string) => permittedMarkers.includes(marker)), 'No foreign or future task in native context');
      assert.strictEqual(request.policy.ownedCwd, true); assert.strictEqual(request.policy.approvalPolicy, 'untrusted'); assert.strictEqual(request.policy.sandbox, 'read-only');
      for (const field of ['mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.strictEqual(request.policy[field], true);
      const wire = receipts().filter(row => row.wrapperPid === request.wrapperPid && row.inputIndex === request.inputIndex);
      const terminal = wire.filter(row => row.event === 'turn-completed'); assert.strictEqual(terminal.length, 1); assert.strictEqual(terminal[0].status, 'completed');
      assert.strictEqual(terminal[0].sessionHash, request.sessionHash);
      const session = receipts().filter(row => row.event === 'session' && row.wrapperPid === request.wrapperPid && row.at <= request.at).at(-1);
      assert.ok(session); assert.strictEqual(session.actualModel, manifest.model); assert.strictEqual(session.sessionHash, request.sessionHash);
      assert.strictEqual(session.returnedPolicy.approvalPolicy, 'untrusted'); assert.strictEqual(session.returnedPolicy.sandbox, 'readOnly');
      assert.strictEqual(session.returnedPolicy.ownedCwd, true); assert.notStrictEqual(session.returnedPolicy.networkAccess, true);
      const outputEvidence: any[] = [], nativeTools = wire.filter(row => ['tool-start', 'tool-result'].includes(row.event));
      for (const tool of message.toolCalls || []) {
        const name = String(tool.name).toLowerCase(), input = tool.input || {};
        const command = name === 'bash' && input.cwd === owner.workspace && commands.some(value => contract.exactCommand(input.command, value));
        assert.ok(command, 'Every persisted tool is the exact approved test command');
        const results = wire.filter(row => row.event === 'tool-result' && row.itemIdHash === contract.hash(tool.id)); assert.strictEqual(results.length, 1);
        const live = fresh.filter(row => row.type === 'toolResult' && row.payload?.id === tool.id); assert.strictEqual(live.length, 1);
        outputEvidence.push(assertToolOutputProjection({ nativeResult: results[0], liveTool: live[0].payload, persistedTool: tool }));
        assert.strictEqual(results[0].exitCode, 0);
      }
      const nativeResultIds = nativeTools.filter(row => row.event === 'tool-result').map(row => row.itemIdHash).sort();
      assert.deepStrictEqual(nativeResultIds, (message.toolCalls || []).map((tool: any) => contract.hash(tool.id)).sort(), 'No native result outside the public/persisted tool list');
      assert.ok(!wire.some(row => ['unexpected-tool-item', 'image-view'].includes(row.event)));
      for (const command of commands) assert.ok((message.toolCalls || []).some((tool: any) => String(tool.name).toLowerCase() === 'bash'
        && contract.exactCommand(tool.input?.command, command)), 'Each requested read/test and external report must actually be consumed');
      assert.strictEqual(message.toolCalls?.length, 1, 'Exactly one command, no retries');
      const reply = { ordinal: step.ordinal, marker: step.marker, started, completedAt: completed[0].at, panelId, conversationId,
        messageId: message.id, prompt, message, request, session, terminal: terminal[0], commands, scope: step.patch || null,
        beforeFiles, afterFiles: files(), priorMessages, nativeTools, outputEvidence, evidence: null, faultCoverage: null,
        nativeText: joinNativeAssistantMessages(wire.filter(row => row.event === 'assistant-message'), message.content) };
      replies.push(reply); write(path.join(owner.directory, `reply-${String(step.ordinal).padStart(2, '0')}.json`), reply);
      record('turn-complete', { ordinal: step.ordinal, marker: step.marker, messageId: message.id, completedCases: completedCases.slice() });
    }
    before(async () => {
      manifest = read(path.join(process.env.MYSTI_PB02_F2_TEST_PROOF_ARTIFACT_DIR!, 'prepared.json')); owner = manifest.windows.A; campaign = manifest.campaign;
      assert.strictEqual(manifest.stage, contract.STAGE); assert.strictEqual(manifest.maxForwardedInputs, contract.MAIN_CAP); assert.strictEqual(manifest.auxiliary.maxInputs, contract.HELPER_CAP);
      assert.strictEqual(manifest.segment.index, 1); assert.strictEqual(manifest.model, 'gpt-5.6-sol');
      assert.strictEqual(fs.realpathSync(owner.workspace), manifest.fixture.workspace);
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), owner.workspace);
      files(); const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(contract.identity(path.join(extension.extensionPath, 'dist/extension.js')).sha256, manifest.bundleSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint[0]}`); workbench = browser.contexts()[0].pages()[0];
      await browser.contexts()[0].addInitScript(installCodexF2TestProofObserver);
      const previous = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('Real owned chat frame', async () => {
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (previous.has(candidate)) continue;
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) candidates.push(candidate); } catch { /* Mount only. */ }
        }
        if (candidates.length !== 1) return false; frame = candidates[0]; return true;
      });
      await frame.evaluate(installCodexF2TestProofObserver); await workbench.bringToFront();
      if (await frame.locator('.wizard-skip-btn').isVisible()) await frame.locator('.wizard-skip-btn').click();
      await until('Actual initial identity', async () => (await events('initialState')).some(row => row.payload?.panelId && row.payload?.conversationId));
      const initial = (await events('initialState')).at(-1).payload; panelId = initial.panelId; conversationId = initial.conversationId; panelIds.push(panelId);
      await frame.locator('#agent-select-btn').click(); await frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
      await frame.locator('#behavior-indicator').click(); await frame.locator('#behavior-popup .mode-option[data-mode="ask"]').click();
      const offset = (await events('modelChanged')).length; await frame.locator('#model-menu-btn').click();
      const selected = frame.locator(`#model-menu-options [data-model=${JSON.stringify(manifest.model)}]`);
      if (await selected.count()) await selected.click(); else {
        await frame.locator('#model-menu-options [data-model="__custom__"]').click(); const quick = workbench.locator('.quick-input-widget');
        await quick.waitFor({ state: 'visible' }); assert.ok((await quick.innerText()).includes('Choose a custom model'));
        await quick.locator('input').fill(manifest.model); await quick.locator('input').press('Enter'); await quick.waitFor({ state: 'hidden' });
      }
      await until('Explicit actual model', async () => (await events('modelChanged')).slice(offset).some(row => row.payload?.provider === 'openai-codex' && (row.payload.customModel || row.payload.model) === manifest.model));
      record('effort-startup', { dom: await effortDom(frame) }); record('effort-selected', await selectLowEffort(frame));
      await until('Explicit low effort persisted', async () => vscode.workspace.getConfiguration('mysti').get('defaultEffortLevel') === 'low');
      files(); record('segment-ready', { panelId, conversationId, segment: manifest.segment.index });
    });
    it('runs one approved client test command and retains the first actual result', async () => {
      await send(manifest.proof.step);
      const stored = (await history()).find((value: any) => value.id === conversationId); assert.ok(stored);
      for (const reply of replies) assert.ok(stored.messages.some((value: any) => value.id === reply.messageId && value.content === reply.message.content));
      await frame.locator('#history-btn').click();
      const acceptance = { status: 'CAPTURED_F2_CLIENT_TEST_PROOF', stage: contract.STAGE, segment: manifest.segment.index, at: Date.now(),
        panelId, panelIds, conversationId, completedCases, replies, reply: replies[0], cacheSnapshot: files().cacheSnapshot, finalConversation: stored, files: files(), observations,
        qualification: 'Exactly one approved command; internal escalation arguments unobserved unless native telemetry exposes them. Main shutdown and helper outcomes audited separately.' };
      write(path.join(owner.directory, 'acceptance.json'), acceptance); finished = true;
    });
    after(async () => {
      if (owner) {
        try { write(path.join(owner.directory, 'events.json'), frame ? await events() : []); } catch { /* Preserve earlier receipts if renderer closed. */ }
        if (!finished) write(path.join(owner.directory, 'partial.json'), { status: 'PARTIAL_FIRST_FAILURE_PRESERVED', replies, observations, completedCases, panelIds });
      }
      await browser?.close();
    });
  });
}
