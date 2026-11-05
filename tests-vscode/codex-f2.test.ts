/** Two ordinary-editor launch segments for one useful F2 workload. No elapsed padding. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexF2Observer } from './codex-f2-observer';
import { effortDom, assertLowEffort, selectLowEffort } from './codex-profile-compatibility-explicit-effort';
const repo = process.env.MYSTI_PB02_F2_REPO || path.resolve(__dirname, '..');

if (process.env.MYSTI_PB02_F2 === '1') {
  // Native campaign imports may resolve pinned local evidence; require opt-in first.
  const contract = require(path.join(repo, 'scripts/validation/codex-f2-campaign.cjs'));
  const { assertToolOutputProjection } = require(path.join(repo, 'scripts/validation/codex-full-oracle.cjs'));
  const { joinNativeAssistantMessages } = require(path.join(repo, 'scripts/validation/audit-vscode-codex-helper-quality.cjs'));
  describe('PB-02 actual F2 short-session segment', function () {
    this.timeout(3_900_000);
    let manifest: any, owner: any, campaign: any, browser: Browser, workbench: Page, frame: Frame;
    let conversationId = '', panelId = '', prior: any = null, finished = false;
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
    async function externalEvidence(step: any): Promise<any> {
      if (!step.evidence) return { commands: step.commands, evidence: null };
      const gateFile = path.join(campaign.directory, 'gates', `${step.evidence}.json`);
      record('external-evidence-needed', { marker: step.marker, kind: step.evidence, gateFile, files: files() });
      // This is substantive root-run API/SQL/browser work. Nothing waits merely
      // to reach a session duration; a missing evidence gate fails on deadline.
      await until(`Reviewed ${step.evidence} evidence`, async () => fs.existsSync(gateFile), 900_000);
      const evidence = read(gateFile), commands = contract.evidenceForStep(step, evidence, campaign.evidenceDirectory, owner.workspace, campaign.evidenceFiles[step.evidence]);
      record('external-evidence-reviewed', { marker: step.marker, evidence, gateIdentity: contract.identity(gateFile) });
      return { commands: [...step.commands, ...commands], evidence: { ...evidence, gateIdentity: contract.identity(gateFile) } };
    }
    function observeAppliedPatch(step: any): void {
      if (!step.patch || step.patch === 'deny-notes' || completedCases.includes(step.patch)) return;
      const approved = observations.filter(row => row.event === 'permission-decision' && row.marker === step.marker && row.name === 'edit' && row.approved);
      const completed = receipts().filter(row => row.event === 'tool-result' && row.inputIndex === step.ordinal && row.type === 'fileChange' && row.status === 'completed');
      if (!completed.length) return;
      assert.strictEqual(approved.length, 1); assert.strictEqual(completed.length, 1);
      const change = approved[0].input.changes[0];
      assert.deepStrictEqual(completed[0].changes, [{ relativePath: manifest.fixture.repairs[step.patch].path, kind: 'update', diffSha256: contract.hash(change.diff) }]);
      assert.strictEqual(contract.identity(path.join(owner.workspace, manifest.fixture.repairs[step.patch].path)).sha256, manifest.fixture.repairs[step.patch].afterSha256);
      completedCases.push(step.patch); record('approved-patch-applied', { marker: step.marker, caseId: step.patch, nativeResult: completed[0] });
    }
    async function permissions(offset: number, step: any, commands: string[]): Promise<void> {
      observeAppliedPatch(step);
      for (const row of (await events()).slice(offset).filter(value => value.type === 'permissionRequest')) {
        const request = row.payload; if (decisions.has(request.id)) continue;
        const input = request.details?.toolInput || {}, name = String(request.details?.toolName || request.title).toLowerCase();
        const command = name === 'bash' && input.cwd === owner.workspace && commands.some(value => contract.exactCommand(input.command, value));
        const patch = name === 'edit' && !!step.patch && contract.patchScope(input.changes, manifest.fixture, step.patch);
        const expectedDenial = patch && step.patch === 'deny-notes';
        const approved = command || patch && !expectedDenial;
        const beforeFiles = files();
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id); record('permission-decision', { marker: step.marker, id: request.id, name, input, approved, expectedDenial, beforeFiles });
        assert.ok(approved || expectedDenial, 'Unexpected native action denied; scope cannot be widened');
      }
    }
    async function send(step: any): Promise<void> {
      const evidence = await externalEvidence(step), commands: string[] = evidence.commands;
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
      observeAppliedPatch(step);
      assert.strictEqual(completed.length, 1); const message = completed[0].payload.message;
      assert.strictEqual(message.provider, 'openai-codex'); assert.strictEqual(message.model, manifest.model);
      assert.ok(message.content.includes(`PB02_DONE:${step.marker}`));
      const inputs = receipts().filter(row => row.event === 'request' && row.inputIndex === step.ordinal);
      assert.strictEqual(inputs.length, 1); const request = inputs[0];
      assert.strictEqual(request.model, manifest.model); assert.strictEqual(request.effort, 'low');
      const permittedMarkers = contract.buildSteps().filter((value: any) => value.ordinal <= step.ordinal).map((value: any) => value.marker);
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
      if (prior && replies.length === 0) {
        // Native thread IDs are process-local; the real editor restart restores
        // durable public history into a fresh native thread, not thread/resume.
        assert.notStrictEqual(request.sessionHash, prior.replies.at(-1).request.sessionHash);
        assert.strictEqual(session.method, 'thread/start');
        const expectedHistoryMarkers = [...new Set(priorMessages.slice(-10).flatMap((value: any) => [...value.content.matchAll(/PB02_REQUEST:([A-Z0-9_]+)/g)].map((match: any) => match[1])))];
        assert.ok(expectedHistoryMarkers.length > 0 && expectedHistoryMarkers.every(marker => request.outsideMemoryMarkers.includes(marker)), 'Cold native thread replays actual retained last10 public messages');
      } else if (replies.length) assert.strictEqual(request.sessionHash, replies[0].request.sessionHash);
      const outputEvidence: any[] = [], nativeTools = wire.filter(row => ['tool-start', 'tool-result'].includes(row.event));
      for (const tool of message.toolCalls || []) {
        const name = String(tool.name).toLowerCase(), input = tool.input || {};
        const command = name === 'bash' && input.cwd === owner.workspace && commands.some(value => contract.exactCommand(input.command, value));
        const patch = name === 'edit' && !!step.patch && contract.patchScope(input.changes, manifest.fixture, step.patch);
        assert.ok(command || patch, 'Every persisted tool is in exact approved scope');
        const results = wire.filter(row => row.event === 'tool-result' && row.itemIdHash === contract.hash(tool.id)); assert.strictEqual(results.length, 1);
        const live = fresh.filter(row => row.type === 'toolResult' && row.payload?.id === tool.id); assert.strictEqual(live.length, 1);
        outputEvidence.push(assertToolOutputProjection({ nativeResult: results[0], liveTool: live[0].payload, persistedTool: tool }));
        if (command) {
          assert.ok(step.expectedNonzero ? Number.isInteger(results[0].exitCode) && results[0].exitCode !== 0 : results[0].exitCode === 0);
        } else if (step.patch === 'deny-notes') {
          assert.ok(['failed', 'declined'].includes(results[0].status));
        } else { assert.strictEqual(results[0].status, 'completed'); }
      }
      const nativeResultIds = nativeTools.filter(row => row.event === 'tool-result').map(row => row.itemIdHash).sort();
      assert.deepStrictEqual(nativeResultIds, (message.toolCalls || []).map((tool: any) => contract.hash(tool.id)).sort(), 'No native result outside the public/persisted tool list');
      assert.ok(!wire.some(row => ['unexpected-tool-item', 'image-view'].includes(row.event)));
      for (const command of commands) assert.ok((message.toolCalls || []).some((tool: any) => String(tool.name).toLowerCase() === 'bash'
        && contract.exactCommand(tool.input?.command, command)), 'Each requested read/test and external report must actually be consumed');
      if (step.patch && step.patch !== 'deny-notes') {
        assert.ok(observations.some(row => row.event === 'permission-decision' && row.marker === step.marker && row.name === 'edit' && row.approved));
        assert.ok(nativeTools.some(row => row.event === 'tool-result' && row.type === 'fileChange' && row.status === 'completed'));
        assert.ok(completedCases.includes(step.patch));
      }
      const faultCoverage = step.patch === 'deny-notes' ? {
        nativePatchDenied: observations.some(row => row.event === 'permission-decision' && row.marker === step.marker && row.expectedDenial && !row.approved)
          && nativeTools.some(row => row.event === 'tool-result' && row.type === 'fileChange' && ['failed', 'declined'].includes(row.status)),
        protectedNoteUnchanged: contract.identity(path.join(owner.workspace, contract.NOTE)).sha256 === manifest.fixture.deniedNote.beforeSha256,
      } : null;
      if (faultCoverage && !faultCoverage.nativePatchDenied) record('partial-denial-coverage', { marker: step.marker, reason: 'No actual native approval denial; no retry/coaxing authorized' });
      const reply = { ordinal: step.ordinal, marker: step.marker, started, completedAt: completed[0].at, panelId, conversationId,
        messageId: message.id, prompt, message, request, session, terminal: terminal[0], commands, scope: step.patch || null,
        beforeFiles, afterFiles: files(), priorMessages, nativeTools, outputEvidence, evidence: evidence.evidence, faultCoverage,
        nativeText: joinNativeAssistantMessages(wire.filter(row => row.event === 'assistant-message'), message.content) };
      replies.push(reply); write(path.join(owner.directory, `reply-${String(step.ordinal).padStart(2, '0')}.json`), reply);
      record('turn-complete', { ordinal: step.ordinal, marker: step.marker, messageId: message.id, completedCases: completedCases.slice() });
    }
    before(async () => {
      manifest = read(path.join(process.env.MYSTI_PB02_F2_ARTIFACT_DIR!, 'prepared.json')); owner = manifest.windows.A; campaign = manifest.campaign;
      assert.strictEqual(manifest.stage, contract.STAGE); assert.strictEqual(manifest.maxForwardedInputs, contract.MAIN_CAP); assert.strictEqual(manifest.auxiliary.maxInputs, contract.HELPER_CAP);
      assert.ok([1, 2].includes(manifest.segment.index)); assert.strictEqual(manifest.model, 'gpt-5.6-sol');
      assert.strictEqual(fs.realpathSync(owner.workspace), manifest.fixture.workspace);
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), owner.workspace);
      if (manifest.segment.index === 2) {
        const pin = manifest.segment.priorAcceptance; assert.strictEqual(contract.identity(pin.path).sha256, pin.sha256); prior = read(pin.path);
        assert.strictEqual(prior.status, 'CAPTURED_F2_SEGMENT'); assert.strictEqual(prior.segment, 1); assert.strictEqual(prior.replies.length, 13);
        const exit = read(manifest.segment.priorEditorExit.path); assert.strictEqual(contract.identity(manifest.segment.priorEditorExit.path).sha256, manifest.segment.priorEditorExit.sha256);
        assert.strictEqual(exit.code, 0); assert.strictEqual(exit.cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
        completedCases.push(...prior.completedCases); panelIds.push(...prior.panelIds);
      }
      files(); const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(contract.identity(path.join(extension.extensionPath, 'dist/extension.js')).sha256, manifest.bundleSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint[0]}`); workbench = browser.contexts()[0].pages()[0];
      await browser.contexts()[0].addInitScript(installCodexF2Observer);
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
      await frame.evaluate(installCodexF2Observer); await workbench.bringToFront();
      if (await frame.locator('.wizard-skip-btn').isVisible()) await frame.locator('.wizard-skip-btn').click();
      await until('Actual initial identity', async () => (await events('initialState')).some(row => row.payload?.panelId && row.payload?.conversationId));
      const initial = (await events('initialState')).at(-1).payload; panelId = initial.panelId; conversationId = initial.conversationId; panelIds.push(panelId);
      if (prior) {
        const stored = await history(), found = stored.find((value: any) => value.id === prior.conversationId); assert.ok(found);
        for (const reply of prior.replies) { assert.ok(found.messages.some((value: any) => value.id === reply.messageId && value.content === reply.message.content)); }
        const offset = (await events('conversationChanged')).length;
        await frame.locator(`.history-item[data-conversation-id=${JSON.stringify(prior.conversationId)}]`).click();
        await until('Actual saved conversation restored', async () => (await events('conversationChanged')).slice(offset).some(row => row.payload?.id === prior.conversationId));
        conversationId = prior.conversationId; record('restart-history-restored', { conversationId, priorMessageIds: prior.replies.map((reply: any) => reply.messageId) });
      }
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
    it('performs the bounded useful tasks, retaining each first actual result', async () => {
      for (const step of contract.buildSteps().filter((value: any) => value.segment === manifest.segment.index)) await send(step);
      const stored = (await history()).find((value: any) => value.id === conversationId); assert.ok(stored);
      for (const reply of [...(prior?.replies || []), ...replies]) assert.ok(stored.messages.some((value: any) => value.id === reply.messageId && value.content === reply.message.content));
      await frame.locator('#history-btn').click();
      const acceptance = { status: 'CAPTURED_F2_SEGMENT', stage: contract.STAGE, segment: manifest.segment.index, at: Date.now(),
        panelId, panelIds, conversationId, completedCases, replies, finalConversation: stored, files: files(), observations,
        priorAcceptance: manifest.segment.priorAcceptance || null, qualification: 'Useful work captured; elapsed/restart/fault/native/helper transport acceptance requires independent campaign audit.' };
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
