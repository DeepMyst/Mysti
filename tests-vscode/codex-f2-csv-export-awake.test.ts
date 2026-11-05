/** Two ordinary-editor launch segments for one useful F2 workload. No elapsed padding. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexF2CsvExportObserver } from './codex-f2-csv-export-awake-observer';
import { effortDom, assertLowEffort, selectLowEffort } from './codex-profile-compatibility-explicit-effort';
const repo = process.env.MYSTI_PB02_F2_CSV_EXPORT_AWAKE_REPO || path.resolve(__dirname, '..');

if (process.env.MYSTI_PB02_F2_CSV_EXPORT_AWAKE === '1') {
  // Native campaign imports may resolve pinned local evidence; require opt-in first.
  const contract = require(path.join(repo, 'scripts/validation/codex-f2-csv-export-awake-campaign.cjs'));
  const compact = require(path.join(repo, 'scripts/validation/codex-f2-compact-store.cjs'));
  const { assertToolOutputProjection } = require(path.join(repo, 'scripts/validation/codex-full-oracle.cjs'));
  const { joinNativeAssistantMessages } = require(path.join(repo, 'scripts/validation/audit-vscode-codex-helper-quality.cjs'));
  describe('PB-02 actual F2 F06 CSV export and responsive description segment', function () {
    this.timeout(3_900_000);
    let manifest: any, owner: any, campaign: any, browser: Browser, workbench: Page, frame: Frame;
    let conversationId = '', panelId = '', prior: any = null, finished = false;
    const observations: any[] = [], replies: any[] = [], decisions = new Set<string>(), completedCases: string[] = [], panelIds: string[] = [];
    const read = (file: string): any => compact.readJson(file);
    const write = (file: string, value: any): void => { compact.writeJson(file, value); };
    const receipts = (): any[] => owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    const files = (): any => contract.verifySnapshot(manifest.fixture, completedCases, panelIds);
    function record(event: string, details: any = {}): void {
      const value = { event, at: Date.now(), segment: manifest.segment.index, ...details }; observations.push(value);
      compact.writeJson(path.join(owner.directory, 'observations.json'), observations, { flag: 'w' });
      console.log('[PB-02 F2]', compact.stringify(path.join(owner.directory, 'observations.json'), value, 0));
    }
    function boundary(label: string): any {
      const started = Date.now(), snapshot = contract.verifyBoundary(manifest.fixture, completedCases, panelIds);
      write(path.join(owner.directory, `boundary-${label}.json`), { label, at: Date.now(), durationMs: Date.now() - started, snapshot });
      record('boundary', { label, snapshot, durationMs: Date.now() - started }); contract.assertBoundary(snapshot); return snapshot;
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
      const evidenceBoundary = boundary(`evidence-${step.evidence}`);
      record('external-evidence-needed', { marker: step.marker, kind: step.evidence, gateFile, files: evidenceBoundary.files, boundary: evidenceBoundary, panelIds: [...panelIds] });
      // This is substantive root-run F06 CSV/API/SQL/F04-wrap/regression evidence work. Nothing waits merely
      // to reach a session duration; a missing evidence gate fails on deadline.
      await until(`Reviewed ${step.evidence} evidence`, async () => fs.existsSync(gateFile), 900_000);
      const evidence = read(gateFile), commands = contract.evidenceForStep(step, evidence, campaign.evidenceDirectory, owner.workspace, campaign.evidenceFiles[step.evidence]);
      record('external-evidence-reviewed', { marker: step.marker, evidence, gateIdentity: contract.identity(gateFile) });
      return { commands: [...step.commands, ...commands], evidence: { ...evidence, gateIdentity: contract.identity(gateFile) } };
    }
    function observeAppliedPatch(step: any): void {
      if (!step.patch) return;
      const approved = observations.filter(row => row.event === 'permission-decision' && row.marker === step.marker && row.name === 'edit' && row.approved);
      const completed = receipts().filter(row => row.event === 'tool-result' && row.inputIndex === step.ordinal && row.type === 'fileChange' && row.status === 'completed');
      if (!completed.length) return;
      assert.strictEqual(approved.length, 1); assert.strictEqual(completed.length, 1);
      const change = approved[0].input.changes[0];
      assert.deepStrictEqual(completed[0].changes, [{ relativePath: manifest.fixture.repairs[step.patch].path, kind: manifest.fixture.repairs[step.patch].kind, diffSha256: contract.hash(change.diff) }]);
      assert.strictEqual(contract.identity(path.join(owner.workspace, manifest.fixture.repairs[step.patch].path)).sha256, manifest.fixture.repairs[step.patch].afterSha256);
      if (!completedCases.includes(step.patch)) {
        completedCases.push(step.patch); record('approved-patch-applied', { marker: step.marker, caseId: step.patch, nativeResult: completed[0] });
      }
    }
    function assertUniqueNativeAttempts(step: any, commands: string[]): void {
      const tools = receipts().filter(row => row.inputIndex === step.ordinal && ['tool-start', 'tool-result'].includes(row.event));
      const commandItems = new Map<string, Set<string>>(), patchItems = new Set<string>(), commandKeys = new Map<string, string>();
      // The ordinary transport may encode an exact command body in a shell wrapper.
      // Group every representation already permitted by exactCommand into one attempt.
      for (const command of commands) {
        const variants: any[] = [command];
        for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) for (const flag of ['-c', '-lc']) {
          variants.push([shell, flag, command], `${shell} ${flag} '${command}'`, `${shell} ${flag} "${command}"`,
            `${shell} ${flag} '${command.replace(/'/g, "'\\''")}'`, `${shell} ${flag} '${command.replace(/'/g, `'"'"'`)}'`);
        }
        for (const variant of variants) if (contract.exactCommand(variant, command)) commandKeys.set(contract.hash(JSON.stringify(variant)), command);
      }
      for (const tool of tools) {
        if (tool.type === 'commandExecution') {
          const command = commandKeys.get(tool.commandSha256); assert.ok(command, 'No unrequested native command');
          assert.strictEqual(tool.ownedCwd, true);
          const ids = commandItems.get(command) || new Set<string>(); ids.add(tool.itemIdHash); commandItems.set(command, ids);
          assert.strictEqual(ids.size, 1, 'A native command may execute only once; retries are failures');
        } else if (tool.type === 'fileChange') {
          assert.ok(step.patch, 'No patch outside a scoped patch task'); patchItems.add(tool.itemIdHash);
          assert.strictEqual(patchItems.size, 1, 'A patch may have only one native tool item');
        } else assert.fail('Unexpected native tool type');
      }
      const results = tools.filter(row => row.event === 'tool-result');
      assert.strictEqual(new Set(results.map(row => row.itemIdHash)).size, results.length, 'No repeated native tool result');
    }
    async function permissions(offset: number, step: any, commands: string[]): Promise<void> {
      assertUniqueNativeAttempts(step, commands);
      observeAppliedPatch(step);
      const cards = (await events()).slice(offset).filter(value => value.type === 'permissionRequest');
      assert.strictEqual(new Set(cards.map(row => row.payload.id)).size, cards.length, 'No duplicate native approval card');
      for (const row of cards) {
        const request = row.payload; if (decisions.has(request.id)) continue;
        const input = request.details?.toolInput || {}, name = String(request.details?.toolName || request.title).toLowerCase();
        const command = name === 'bash' && input.cwd === owner.workspace ? commands.find(value => contract.exactCommand(input.command, value)) : undefined;
        const patch = name === 'edit' && !!step.patch && contract.patchScope(input.changes, manifest.fixture, step.patch);
        const earlier = observations.filter(value => value.event === 'permission-decision' && value.marker === step.marker && value.approved);
        const duplicate = command ? earlier.some(value => value.name === 'bash' && contract.exactCommand(value.input.command, command))
          : patch && (completedCases.includes(step.patch) || earlier.some(value => value.name === 'edit'));
        const expectedDenial = false, approved = !!(command || patch) && !duplicate;
        const beforeFiles = files();
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id); record('permission-decision', { marker: step.marker, id: request.id, name, input, approved, expectedDenial, duplicate, beforeFiles });
        assert.ok(approved, duplicate ? 'Duplicate native approval denied; no retry is authorized' : 'Unexpected native action denied; scope cannot be widened');
      }
    }
    async function send(step: any): Promise<void> {
      const evidence = await externalEvidence(step), commands: string[] = evidence.commands;
      assert.strictEqual(new Set(commands).size, commands.length, 'No duplicate requested command');
      assertLowEffort(await effortDom(frame));
      const globalCount = fs.existsSync(campaign.counterFile) ? read(campaign.counterFile).forwardedInputs : 0;
      assert.strictEqual(globalCount, step.ordinal - 1); assert.ok(globalCount < contract.MAIN_CAP);
      const priorConversation = (await history()).find((value: any) => value.id === conversationId); assert.ok(priorConversation);
      const priorMessages = priorConversation.messages;
      await frame.locator('#history-btn').click();
      const needsBoundary = !!(step.nativeTests || step.nativeLint || step.nativeBuild);
      assert.strictEqual(needsBoundary, contract.BOUNDARY_ORDINALS.includes(step.ordinal));
      assert.strictEqual(!!step.requiresEscalation.length, needsBoundary);
      const beforeBoundary = needsBoundary ? boundary(`before-${step.ordinal}`) : null;
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
      assertUniqueNativeAttempts(step, commands); observeAppliedPatch(step);
      assert.strictEqual(completed.length, 1); const message = completed[0].payload.message;
      assert.strictEqual(message.provider, 'openai-codex'); assert.strictEqual(message.model, manifest.model);
      assert.ok(message.content.includes(`PB02_DONE:${step.marker}`));
      const inputs = receipts().filter(row => row.event === 'request' && row.inputIndex === step.ordinal);
      assert.strictEqual(inputs.length, 1); const request = inputs[0];
      assert.strictEqual(request.model, manifest.model); assert.strictEqual(request.effort, 'low');
      const permittedMarkers = contract.buildSteps(owner.workspace).filter((value: any) => value.ordinal <= step.ordinal).map((value: any) => value.marker);
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
      const publicTools = message.toolCalls || [];
      assert.strictEqual(new Set(publicTools.map((tool: any) => tool.id)).size, publicTools.length, 'No duplicate public tool ID');
      for (const tool of publicTools) {
        const name = String(tool.name).toLowerCase(), input = tool.input || {};
        const command = name === 'bash' && input.cwd === owner.workspace && commands.some(value => contract.exactCommand(input.command, value));
        const patch = name === 'edit' && !!step.patch && contract.patchScope(input.changes, manifest.fixture, step.patch);
        assert.ok(command || patch, 'Every persisted tool is in exact approved scope');
        const results = wire.filter(row => row.event === 'tool-result' && row.itemIdHash === contract.hash(tool.id)); assert.strictEqual(results.length, 1);
        const live = fresh.filter(row => row.type === 'toolResult' && row.payload?.id === tool.id); assert.strictEqual(live.length, 1);
        outputEvidence.push(assertToolOutputProjection({ nativeResult: results[0], liveTool: live[0].payload, persistedTool: tool }));
        if (command) {
          contract.assertCommandResult({ step, command: input.command, result: results[0], output: live[0].payload.output, workspace: owner.workspace });
        } else { assert.strictEqual(results[0].status, 'completed'); }
      }
      const nativeResultIds = nativeTools.filter(row => row.event === 'tool-result').map(row => row.itemIdHash).sort();
      assert.deepStrictEqual(nativeResultIds, (message.toolCalls || []).map((tool: any) => contract.hash(tool.id)).sort(), 'No native result outside the public/persisted tool list');
      assert.ok(!wire.some(row => ['unexpected-tool-item', 'image-view'].includes(row.event)));
      const nativeItemIds = [...new Set(nativeTools.map(row => row.itemIdHash))].sort();
      assert.deepStrictEqual(nativeItemIds, publicTools.map((tool: any) => contract.hash(tool.id)).sort(), 'No native start outside the public/persisted tool list');
      for (const command of commands) assert.strictEqual(publicTools.filter((tool: any) => String(tool.name).toLowerCase() === 'bash'
        && contract.exactCommand(tool.input?.command, command)).length, 1, 'Each requested read/test and external report executes exactly once');
      for (const command of step.requiresEscalation) assert.strictEqual(observations.filter(row => row.event === 'permission-decision'
        && row.marker === step.marker && row.name === 'bash' && row.approved && contract.exactCommand(row.input.command, command)).length, 1,
      'Each write-capable command requires exactly one actual approval');
      assert.strictEqual(publicTools.filter((tool: any) => String(tool.name).toLowerCase() === 'edit').length, step.patch ? 1 : 0, 'Exactly one scoped patch, or none');
      if (step.patch) {
        assert.ok(observations.some(row => row.event === 'permission-decision' && row.marker === step.marker && row.name === 'edit' && row.approved));
        assert.ok(nativeTools.some(row => row.event === 'tool-result' && row.type === 'fileChange' && row.status === 'completed'));
        assert.ok(completedCases.includes(step.patch));
      }
      const faultCoverage = null;
      const afterBoundary = needsBoundary ? boundary(`after-${step.ordinal}`) : null;
      if (needsBoundary) {
        assert.ok(beforeBoundary && afterBoundary);
        contract.assertCommandBoundary(beforeBoundary, afterBoundary, step);
      }
      const reply = { beforeBoundary, afterBoundary, ordinal: step.ordinal, marker: step.marker, started, completedAt: completed[0].at, panelId, conversationId,
        messageId: message.id, prompt, message, request, session, terminal: terminal[0], commands, scope: step.patch || null,
        beforeFiles, afterFiles: files(), priorMessages, nativeTools, outputEvidence, evidence: evidence.evidence, faultCoverage,
        nativeText: joinNativeAssistantMessages(wire.filter(row => row.event === 'assistant-message'), message.content) };
      replies.push(reply); write(path.join(owner.directory, `reply-${String(step.ordinal).padStart(2, '0')}.json`), reply);
      record('turn-complete', { ordinal: step.ordinal, marker: step.marker, messageId: message.id, completedCases: completedCases.slice() });
    }
    before(async () => {
      manifest = read(path.join(process.env.MYSTI_PB02_F2_CSV_EXPORT_AWAKE_ARTIFACT_DIR!, 'prepared.json')); owner = manifest.windows.A; campaign = manifest.campaign;
      contract.assertNativePreparationReady(campaign.priorBinding);
      assert.strictEqual(contract.TURN_COUNT, 18); assert.strictEqual(contract.FIRST_SEGMENT_COUNT, 16);
      assert.strictEqual(contract.BUILD_ORDINAL, 15); assert.strictEqual(contract.LINT_ORDINAL, 14);
      assert.deepStrictEqual(contract.BOUNDARY_ORDINALS, [12, 13, 14, 15]);
      assert.strictEqual(contract.SELECTED.length, 10);
      assert.strictEqual(Object.values(manifest.fixture.repairs).filter((repair: any) => repair.kind === 'add').length, 3);
      assert.strictEqual(manifest.stage, contract.STAGE); assert.strictEqual(manifest.maxForwardedInputs, contract.MAIN_CAP); assert.strictEqual(manifest.auxiliary.maxInputs, contract.HELPER_CAP);
      assert.ok([1, 2].includes(manifest.segment.index)); assert.strictEqual(manifest.model, 'gpt-5.6-sol');
      assert.strictEqual(fs.realpathSync(owner.workspace), manifest.fixture.workspace);
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), owner.workspace);
      if (manifest.segment.index === 2) {
        const pin = manifest.segment.priorAcceptance; assert.strictEqual(contract.identity(pin.path).sha256, pin.sha256); prior = read(pin.path);
        assert.strictEqual(prior.status, 'CAPTURED_F2_SEGMENT'); assert.strictEqual(prior.segment, 1); assert.strictEqual(prior.replies.length, contract.FIRST_SEGMENT_COUNT);
        const exit = read(manifest.segment.priorEditorExit.path); assert.strictEqual(contract.identity(manifest.segment.priorEditorExit.path).sha256, manifest.segment.priorEditorExit.sha256);
        assert.strictEqual(exit.code, 0); assert.strictEqual(exit.cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
        assert.strictEqual(prior.stage, contract.STAGE); assert.deepStrictEqual(prior.completedCases, contract.SELECTED);
        completedCases.push(...prior.completedCases); panelIds.push(...prior.panelIds);
      }
      files(); const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(contract.identity(path.join(extension.extensionPath, 'dist/extension.js')).sha256, manifest.bundleSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint[0]}`); workbench = browser.contexts()[0].pages()[0];
      await browser.contexts()[0].addInitScript(installCodexF2CsvExportObserver);
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
      await frame.evaluate(installCodexF2CsvExportObserver); await workbench.bringToFront();
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
      for (const step of contract.buildSteps(owner.workspace).filter((value: any) => value.segment === manifest.segment.index)) await send(step);
      const stored = (await history()).find((value: any) => value.id === conversationId); assert.ok(stored);
      for (const reply of [...(prior?.replies || []), ...replies]) assert.ok(stored.messages.some((value: any) => value.id === reply.messageId && value.content === reply.message.content));
      await frame.locator('#history-btn').click();
      const finalBoundary = boundary('final');
      const acceptance = { finalBoundary, status: 'CAPTURED_F2_SEGMENT', stage: contract.STAGE, segment: manifest.segment.index, at: Date.now(),
        panelId, panelIds, conversationId, completedCases, replies, finalConversation: stored, files: files(), observations,
        priorAcceptance: manifest.segment.priorAcceptance || null, qualification: 'Ten guided internal file approvals implement F06 CSV export and the disclosed F04 responsive correction; actual API/SQL/browser/regression evidence, first native tests/lints/build results, editor-history restoration and native/helper transport require independent campaign audit. Eighteen tasks alone do not establish full S/W/E/P or ordinary-mistake recovery.' };
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
