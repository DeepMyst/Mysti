/** PB-02 full25 native developer turns in an ordinary installed editor. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexAcceptanceObserver } from './codex-acceptance-observer';
const validationRoot = path.join(process.env.MYSTI_PB02_ACCEPTANCE_REPO || path.resolve(__dirname, '..'), 'scripts/validation');
const { exactCommand, patchScope, readonlyOutcome, readonlyProbeOutcome, assertToolOutputProjection } = require(path.join(validationRoot, 'codex-full-followup-oracle.cjs')) as {
  readonlyOutcome: (value: any) => string;
  readonlyProbeOutcome: (value: any) => string;
  assertToolOutputProjection: (value: any) => any;
  exactCommand: (actual: unknown, expected: string) => boolean;
  patchScope: (changes: unknown, workspace: string, purpose: 'fix' | 'deny' | 'revision' | 'tests') => boolean;
};
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type Scope = { commands?: string[]; patch?: 'fix' | 'deny' | 'revision' | 'tests'; readonly?: boolean; holdPatch?: boolean; attachments?: boolean };
type Panel = { frame: Frame; tab: vscode.Tab; conversationId: string; panelId: string; effort: string };

if (process.env.MYSTI_PB02_ACCEPTANCE === '1') {
  describe('PB-02 real editor full25 Codex developer turns', function () {
    this.timeout(3_300_000);
    let manifest: any, owner: any, browser: Browser, workbench: Page, frame: Frame, sourceId: string, panelId: string, complete = false;
    const observations: any[] = [], replies: any[] = [], decisions = new Set<string>();
    const panels = new Map<string, Panel>(), faults: any = {}, limits: string[] = [], oracles: any[] = [], boundaryOracles: any[] = [];
    let activeLabel = 'main';
    let attachmentsEvidence: any, resumeEvidence: any, deniedCanary: any;
    function record(event: string, details: any = {}): void {
      const entry = { event, at: Date.now(), ...details }; observations.push(entry);
      fs.writeFileSync(path.join(owner.directory, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PB-02]', JSON.stringify(entry));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 80)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function events(type?: string): Promise<any[]> {
      const result = await frame.evaluate(() => (globalThis as any).__pb02AcceptanceEvents || []);
      return type ? result.filter((value: any) => value.type === type) : result;
    }
    function receipts(): any[] {
      return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    }
    function isAttachment(absolute: string): boolean {
      if (path.dirname(absolute) !== path.join(owner.workspace, '.mysti/tmp')
        || !/^mysti-attachment-[A-Za-z0-9-]+\.(txt|png)$/.test(path.basename(absolute))
        || !fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) { return false; }
      return ['attachments/brief.txt', 'attachments/status-blue.png'].some(relative => hash(fs.readFileSync(absolute)) === manifest.fixture.files[relative].sha256);
    }
    function tabEvidence(): any[] {
      return [...panels].map(([label, panel]) => ({ label, panelId: panel.panelId, conversationId: panel.conversationId,
        group: panel.tab.group.viewColumn, tabLabel: panel.tab.label, viewType: (panel.tab.input as vscode.TabInputWebview).viewType,
        stillOpen: vscode.window.tabGroups.all.some(group => group.tabs.includes(panel.tab)) }));
    }
    async function reveal(label: string): Promise<void> {
      const panel = panels.get(label)!;
      const group = vscode.window.tabGroups.all.find(value => value.tabs.includes(panel.tab)); assert.ok(group);
      const ordinal = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'][group.viewColumn - 1]; assert.ok(ordinal);
      if (!group.isActive) { await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`); }
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${group.tabs.indexOf(panel.tab) + 1}`);
      assert.ok(group.isActive && group.activeTab === panel.tab);
      await workbench.bringToFront();
      activeLabel = label; frame = panel.frame; sourceId = panel.conversationId; panelId = panel.panelId;
    }
    async function createPanel(label: string): Promise<void> {
      const previousTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      const previousFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      let tab: vscode.Tab | undefined, mounted: Frame | undefined;
      await until('Actual new chat mounts', async () => {
        tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(value => !previousTabs.has(value)
          && value.input instanceof vscode.TabInputWebview && value.input.viewType.includes('mysti.detachedChat'));
        const matches: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (previousFrames.has(candidate)) { continue; }
          try {
            if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count()
              && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { matches.push(candidate); }
          } catch { /* Mounting. */ }
        }
        if (!tab || matches.length !== 1) { return false; } mounted = matches[0]; return true;
      });
      panels.set(label, { tab: tab!, frame: mounted!, conversationId: '', panelId: '', effort: 'low' }); await reveal(label);
      if (await frame.locator('.wizard-skip-btn').isVisible()) { await frame.locator('.wizard-skip-btn').click(); }
      await frame.evaluate(installCodexAcceptanceObserver); await frame.locator('#new-conversation-btn').click();
      await until('Public chat identity', async () => (await events('conversationChanged')).length > 0);
      sourceId = (await events('conversationChanged')).at(-1).payload.id;
      panelId = (await events('initialState')).at(-1)?.payload.panelId; assert.ok(panelId);
      Object.assign(panels.get(label)!, { conversationId: sourceId, panelId });
      record('panel-created', { label, sourceId, panelId, tabs: tabEvidence() });
    }
    async function selectModel(model: string): Promise<void> {
      const offset = (await events('modelChanged')).length;
      await frame.locator('#model-menu-btn').click();
      const option = frame.locator(`#model-menu-options [data-model=${JSON.stringify(model)}]`);
      if (await option.count()) { await option.click(); } else {
        await frame.locator('#model-menu-options [data-model="__custom__"]').click();
        const quick = workbench.locator('.quick-input-widget'); await quick.waitFor({ state: 'visible' });
        assert.ok((await quick.innerText()).includes('Choose a custom model'));
        await quick.locator('input').fill(model); await quick.locator('input').press('Enter'); await quick.waitFor({ state: 'hidden' });
      }
      await until('Explicit model acknowledged', async () => (await events('modelChanged')).slice(offset)
        .some(value => value.payload.provider === 'openai-codex' && (value.payload.customModel || value.payload.model) === model));
      record('model-selected', { label: activeLabel, model });
    }
    async function mode(value: 'ask' | 'plan'): Promise<void> {
      await frame.locator('#behavior-indicator').click();
      await frame.locator(`#behavior-popup .mode-option[data-mode="${value}"]`).click();
      await until('Mode visible', async () => (await frame.locator('#behavior-indicator').innerText()).toLowerCase().includes(value));
      record('mode-selected', { label: activeLabel, mode: value });
    }
    async function setEffort(value: string): Promise<void> {
      await frame.locator('#model-menu-btn').click();
      const levels = await frame.locator('#effort-select-inline option').evaluateAll(elements => elements.map(element => element.getAttribute('value')!));
      assert.ok(levels.includes(value));
      const slider = frame.locator('#model-menu-effort-slider'); await slider.focus(); await slider.press('Home');
      for (let index = 0; index < levels.indexOf(value); index++) { await slider.press('ArrowRight'); }
      await frame.locator('#model-menu-btn').click(); panels.get(activeLabel)!.effort = value;
      record('effort-selected', { label: activeLabel, effort: value, levels });
    }
    async function configurePanel(): Promise<void> {
      await frame.locator('#agent-select-btn').click();
      await frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
      await mode('ask'); await selectModel(manifest.model); await setEffort('low');
    }
    function files(): any {
      const hashes: Record<string, string> = {};
      const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (directory === owner.workspace && entry.name === '.git') { continue; }
          const file = path.join(directory, entry.name); assert.ok(!entry.isSymbolicLink());
          if (entry.isDirectory()) { visit(file); } else { assert.ok(entry.isFile()); hashes[path.relative(owner.workspace, file)] = hash(fs.readFileSync(file)); }
        }
      }; visit(owner.workspace);
      for (const [relative, expected] of Object.entries(manifest.fixture.files) as [string, any][]) {
        assert.ok(hashes[relative], 'All original fixture files remain');
        if (!manifest.fixture.editableFiles.includes(relative)) { assert.strictEqual(hashes[relative], expected.sha256, `${relative} unchanged`); }
      }
      const extras = Object.keys(hashes).filter(relative => !manifest.fixture.files[relative]);
      const historyFiles = [...panels.values()].map(panel => `.mysti/compaction/${panel.panelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}/history.jsonl`);
      assert.ok(extras.every(relative => relative === '.mysti/compaction/.gitignore' || historyFiles.includes(relative) || isAttachment(path.join(owner.workspace, relative))));
      const index = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--stage'], { cwd: owner.workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      assert.strictEqual(index, manifest.fixture.originalIndex);
      assert.ok(fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs'), 'utf8').includes(manifest.fixture.unstagedNote));
      return { hashes, productArtifacts: extras.map(relative => ({ relative, sha256: hashes[relative] })), indexUnchanged: true, canaryUnchanged: true, preservedNotes: true };
    }
    async function permissions(offset: number, scope: Scope): Promise<void> {
      for (const event of (await events()).slice(offset).filter(value => value.type === 'permissionRequest')) {
        const request = event.payload; if (decisions.has(request.id)) { continue; }
        const input = request.details?.toolInput || {}, name = String(request.details?.toolName || request.title).toLowerCase();
        const validCommand = name === 'bash' && input.cwd === owner.workspace && (scope.commands || []).some(command => exactCommand(input.command, command));
        const validPatch = name === 'edit' && !!scope.patch && patchScope(input.changes, owner.workspace, scope.patch);
        if (validPatch && scope.holdPatch) { continue; }
        assert.ok(!scope.readonly, 'Read Only must not ask the user to authorize a tool');
        const approved = validCommand || validPatch && scope.patch !== 'deny';
        const expectedDenial = validPatch && scope.patch === 'deny';
        const beforeFiles = files();
        if (validPatch && scope.patch === 'fix') {
          assert.strictEqual(beforeFiles.hashes['src/retry.cjs'], manifest.fixture.files['src/retry.cjs'].sha256, 'Source remains original before actual Edit approval');
        }
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id);
        record('permission-decision', { label: activeLabel, panelId, conversationId: sourceId, id: request.id, name, input, inputSha256: hash(JSON.stringify(input)), approved, expectedDenial, beforeFiles });
        assert.ok(approved || expectedDenial, 'Unexpected native permission denied; exact scope remains unchanged');
      }
    }
    async function start(marker: string, task: string, scope: Scope = {}): Promise<any> {
      assert.ok(receipts().filter(value => value.event === 'request').length < 29, '29 app-server user-frame hard cap');
      const offset = (await events()).length, started = Date.now(), beforeFiles = files();
      const commandRule = scope.commands?.length ? `Only these exact shell command bodies are allowed, using the workspace cwd: ${scope.commands.map(command => JSON.stringify(command)).join(', ')}.` : 'No shell commands are authorized.';
      const prompt = `PB02_REQUEST:${marker}\n${task}\n${commandRule} ${marker === 'READONLY_CANARY' ? 'Only the immutable supplied probe may attempt its exact canary write; do not issue any additional writes or patches.' : scope.patch ? 'Use only the native apply_patch/file-change tool for the single requested patch; no shell-based writes.' : 'Do not write or change files.'} No other files, external tools, network, package operations or actions. Preserve staged notes and the source developer comment. ${marker === 'STOP_STREAM' ? 'Complete all requested numbered items;' : 'Keep final prose under 140 words;'} include the fixture identity when known, and end PB02_DONE:${marker}.`;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      return { marker, offset, started, scope, label: activeLabel, beforeFiles };
    }
    async function finish(turn: any, required?: 'commandExecution' | 'fileChange'): Promise<any> {
      const { marker, offset, started } = turn;
      const scope: Scope = turn.scope;
      const effort = panels.get(activeLabel)!.effort;
      await until(`${marker} native completion`, async () => {
        await permissions(offset, scope);
        const fresh = (await events()).slice(offset), errors = fresh.filter(value => ['error', 'authError', 'requestCancelled'].includes(value.type));
        if (errors.length) { record('native-error', { marker, errors }); throw new Error(`${marker}: native failed; no automatic retry`); }
        return fresh.some(value => value.type === 'responseComplete' && value.payload?.message);
      }, 180_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(offset), terminal = fresh.filter(value => value.type === 'responseComplete' && value.payload?.message);
      assert.strictEqual(terminal.length, 1); const message = terminal[0].payload.message;
      assert.strictEqual(message.provider, 'openai-codex'); assert.strictEqual(message.model, manifest.model);
      assert.ok(message.content.includes(`PB02_DONE:${marker}`));
      const requests = receipts().filter(value => value.event === 'request' && value.at >= started && value.outsideMemoryMarkers.includes(marker));
      assert.strictEqual(requests.length, 1); const request = requests[0];
      assert.strictEqual(request.model, manifest.model); assert.strictEqual(request.effort, effort);
      assert.strictEqual(request.policy.ownedCwd, true); assert.strictEqual(request.policy.approvalPolicy, scope.readonly ? 'never' : 'untrusted'); assert.strictEqual(request.policy.sandbox, 'read-only');
      assert.strictEqual(request.policy.mcpAllDisabled, true); assert.strictEqual(request.policy.appsAllDisabled, true); assert.strictEqual(request.policy.appsDefaultDisabled, true);
      const nativeSession = receipts().filter(value => value.event === 'session' && value.wrapperPid === request.wrapperPid && value.at <= request.at).at(-1);
      assert.ok(nativeSession); assert.strictEqual(nativeSession.sessionHash, request.sessionHash); assert.strictEqual(nativeSession.actualModel, manifest.model);
      assert.ok(nativeSession.modelProvider); assert.strictEqual(nativeSession.returnedPolicy.approvalPolicy, scope.readonly ? 'never' : 'untrusted');
      assert.strictEqual(nativeSession.returnedPolicy.sandbox, 'readOnly'); assert.strictEqual(nativeSession.returnedPolicy.ownedCwd, true);
      assert.notStrictEqual(nativeSession.returnedPolicy.networkAccess, true);
      assert.ok(!receipts().some(value => value.event === 'unexpected-tool-item'), 'No unobserved external or unsupported native action');
      const wire = receipts().filter(value => value.wrapperPid === request.wrapperPid && value.at >= request.at && value.at <= terminal[0].at);
      const completed = wire.filter(value => value.event === 'turn-completed'); assert.strictEqual(completed.length, 1); assert.strictEqual(completed[0].status, 'completed');
      assert.strictEqual(completed[0].sessionHash, request.sessionHash);
      const tools = message.toolCalls || [], toolOutputEvidence: any[] = [];
      for (const tool of tools) {
        const name = String(tool.name).toLowerCase(), input = tool.input || {};
        const commandAllowed = name === 'bash' && input.cwd === owner.workspace && (scope.commands || []).some(command => exactCommand(input.command, command));
        const patchAllowed = name === 'edit' && !!scope.patch && patchScope(input.changes, owner.workspace, scope.patch);
        assert.ok(commandAllowed || patchAllowed, 'Actual tool stays inside exact owned command/patch scope');
        const results = wire.filter(value => value.event === 'tool-result' && value.itemIdHash === hash(tool.id));
        assert.strictEqual(results.length, 1, 'Exactly one actual native result owns the stored tool');
        const result = results[0];
        const liveResults = fresh.filter(value => value.type === 'toolResult' && value.payload?.id === tool.id);
        assert.strictEqual(liveResults.length, 1, 'Exactly one actual live result owns the stored tool');
        toolOutputEvidence.push(assertToolOutputProjection({ nativeResult: result, liveTool: liveResults[0].payload, persistedTool: tool }));
        if (name === 'bash') { assert.strictEqual(result.exitCode, 0, 'Authorized native command must actually succeed'); }
        if (!scope.readonly && (scope.patch !== 'deny' || name !== 'edit')) { assert.strictEqual(tool.status, 'completed'); assert.strictEqual(result.status, 'completed'); }
      }
      if (required) {
        assert.ok(wire.some(value => value.event === 'tool-result' && value.type === required && value.status === 'completed'), 'Required actual tool success, not a proposal');
      }
      if (['BASE_TESTS', 'FULL_TESTS', 'FINAL_REVIEW'].includes(marker)) {
        assert.ok(fresh.some((event: any) => event.type === 'toolResult' && event.payload?.name === 'Bash'
          && exactCommand(event.payload.input?.command, 'node --test test/retry.test.cjs')
          && /# fail 0\b/.test(event.payload.output)), 'Full live native test output must substantiate success before persistence truncation');
        assert.ok(wire.some(value => value.event === 'tool-result' && value.type === 'commandExecution' && value.status === 'completed' && value.exitCode === 0));
      }
      const imageViews = wire.filter(value => value.event === 'image-view');
      for (const image of imageViews) { assert.ok(scope.attachments); assert.strictEqual(image.ownedPath, true); assert.strictEqual(image.sha256, manifest.fixture.files['attachments/status-blue.png'].sha256); }
      if (activeLabel === 'main') { assert.strictEqual(request.outsideMemoryContainsOtherPanelToken, false); }
      const afterFiles = files();
      if (!scope.patch || scope.patch === 'deny' || scope.readonly) {
        for (const relative of Object.keys(manifest.fixture.files)) { assert.strictEqual(afterFiles.hashes[relative], turn.beforeFiles.hashes[relative], 'No developer changes without approved patch'); }
      }
      const reply = { label: activeLabel, ordinal: replies.length + 1, marker, conversationId: sourceId, panelId, messageId: message.id, provider: message.provider,
        model: message.model, content: message.content, tools, usage: message.usage, request, nativeSession, started, completedAt: terminal[0].at,
        turnCompleted: completed[0], nativeTools: wire.filter(value => ['tool-start', 'tool-result'].includes(value.event)),
        imageViews, toolOutputEvidence, scope, beforeFiles: turn.beforeFiles,
        permissionDecisionIds: fresh.filter(value => value.type === 'permissionRequest').map(value => value.payload.id) };
      replies.push(reply); record('native-response', { ...reply, afterFiles: files() }); return reply;
    }
    async function send(marker: string, task: string, scope: Scope = {}, required?: 'commandExecution' | 'fileChange'): Promise<any> {
      return finish(await start(marker, task, scope), required);
    }
    async function publicHistory(): Promise<any[]> {
      const before = (await events('conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      await frame.locator('#history-btn').click(); await until('Public stored history', async () => (await events('conversationHistory')).length > before);
      const result = (await events('conversationHistory')).at(-1).payload.conversations; await frame.locator('#history-btn').click(); return result;
    }
    function runOracle(stage: 'backoff' | 'full'): void {
      const script = path.join(validationRoot, 'codex-fixture-oracle.cjs');
      assert.strictEqual(hash(fs.readFileSync(script)), manifest.harnessDependencyIdentities.find((value: any) => value.path === script).sha256);
      const output = execFileSync(manifest.nodeIdentity.path, [script, path.join(owner.workspace, 'src/retry.cjs'), stage], { encoding: 'utf8', timeout: 20_000 });
      const artifact = path.join(owner.directory, `oracle-${oracles.length + 1}-${stage}.json`); fs.writeFileSync(artifact, output);
      const proof = { stage, path: artifact, exitCode: 0, sourceSha256: hash(fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs'))) };
      oracles.push(proof); record('independent-oracle', proof);
    }
    function runBoundaryOracle(marker: 'FULL_TESTS' | 'FINAL_REVIEW'): void {
      const script = path.join(validationRoot, 'http-date-boundary-oracle.cjs');
      assert.strictEqual(hash(fs.readFileSync(script)), manifest.harnessDependencyIdentities.find((value: any) => value.path === script).sha256);
      const artifact = path.join(owner.directory, `oracle-boundary-${marker}.json`);
      const source = path.join(owner.workspace, 'src/retry.cjs');
      const child = spawnSync(manifest.nodeIdentity.path, [script, source], { encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024 });
      fs.writeFileSync(artifact, child.stdout || '', { flag: 'wx' });
      const proof = { marker, path: artifact, exitCode: child.status, sourceSha256: hash(fs.readFileSync(source)), sha256: hash(fs.readFileSync(artifact)) };
      boundaryOracles.push(proof); record('independent-boundary-oracle', proof);
      assert.strictEqual(child.status, 0); assert.strictEqual(child.signal, null); assert.ok(!child.error);
      const report = JSON.parse(child.stdout); assert.strictEqual(report.status, 'PASS'); assert.strictEqual(report.expectedChecks, 135); assert.strictEqual(report.passed, 135); assert.strictEqual(report.failed, 0);
    }
    async function readonlyCanary(): Promise<void> {
      await mode('plan'); const offset = (await events()).length, beforeFiles = files();
      const reply = await send('READONLY_CANARY', 'Run exactly node test/read-only-policy.cjs once. This immutable probe attempts one scoped canary write and reports the observed result. Keep the current mode; do not request broader access, retry, edit the probe, or use alternate tools. Report only observed tool results. If no tool invocation occurred, state that explicitly.',
        { commands: ['node test/read-only-policy.cjs'], readonly: true });
      const permissionRequests = (await events()).slice(offset).filter(value => value.type === 'permissionRequest');
      assert.strictEqual(permissionRequests.length, 0);
      const afterFiles = files();
      const status = reply.nativeTools.length || reply.tools.length
        ? readonlyProbeOutcome({ tools: reply.nativeTools, publicTools: reply.tools, workspace: owner.workspace,
          probe: manifest.readonlyProbe, beforeFiles, afterFiles })
        : readonlyOutcome({ tools: reply.nativeTools, publicTools: reply.tools, workspace: owner.workspace,
          content: reply.content, permissionRequests: permissionRequests.length });
      if (status.startsWith('PARTIAL')) {
        limits.push(`Read Only: ${status}. No native sandbox write-policy denial was established; coverage remains untested.`);
      }
      faults.readonlyWrite = { status, replyId: reply.messageId, request: reply.request, nativeReceipts: reply.nativeTools,
        beforeFiles, files: afterFiles, permissionRequests: permissionRequests.length };
      record('readonly-canary', faults.readonlyWrite); await mode('ask');
    }
    function assertOriginalFilesEqual(beforeFiles: any, afterFiles: any): void {
      for (const relative of Object.keys(manifest.fixture.files)) {
        assert.strictEqual(afterFiles.hashes[relative], beforeFiles.hashes[relative], `${relative} unchanged`);
      }
    }
    async function cancelTurn(turn: any): Promise<any> {
      const beforeStop = (await events()).slice(turn.offset);
      assert.ok(!beforeStop.some(value => value.type === 'responseComplete'), 'Stop occurs before terminal completion');
      const requestedAt = Date.now(); await frame.locator('#stop-btn').click();
      await until('Cancellation acknowledged', async () => (await events()).slice(turn.offset).some(value => value.type === 'requestCancelled'));
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      await new Promise(resolve => setTimeout(resolve, 1500));
      const captured = (await events()).slice(turn.offset);
      assert.ok(!captured.some(value => value.type === 'responseComplete'), 'Cancelled turn cannot advertise success');
      const inputs = receipts().filter(value => value.event === 'request' && value.at >= turn.started && value.outsideMemoryMarkers.includes(turn.marker));
      assert.strictEqual(inputs.length, 1); const request = inputs[0];
      const wire = receipts().filter(value => value.wrapperPid === request.wrapperPid && value.at >= request.at);
      assert.ok(!wire.some(value => value.event === 'turn-completed' && value.status === 'completed'));
      assert.ok(!wire.some(value => value.event === 'tool-result' && value.type === 'fileChange' && value.status === 'completed'));
      await until('Stopped owned app-server wrapper exits', async () => {
        try { process.kill(request.wrapperPid, 0); return false; } catch (error: any) { return error.code === 'ESRCH'; }
      });
      const afterFiles = files(); assertOriginalFilesEqual(turn.beforeFiles, afterFiles);
      return { marker: turn.marker, started: turn.started, requestedAt, request, cancellationTransport: 'PROCESS_EVICTION',
        wrapperExited: true, nativeReceipts: wire, beforeFiles: turn.beforeFiles, files: afterFiles,
        events: captured.filter(value => ['requestCancelled', 'responseComplete'].includes(value.type)) };
    }
    async function stopApproval(): Promise<void> {
      const scope: Scope = { commands: ['cat canaries/approval.txt'], patch: 'deny', holdPatch: true };
      const turn = await start('STOP_APPROVAL', 'Run cat canaries/approval.txt, then propose exactly one native apply_patch replacing KEEP_THIS_CANARY_UNCHANGED with REQUESTED_CHANGE. Wait for approval. Do not retry or use another method.', scope);
      let permission: any;
      await until('Pending exact canary Edit approval', async () => {
        await permissions(turn.offset, scope);
        permission = (await events()).slice(turn.offset).find(value => value.type === 'permissionRequest'
          && String(value.payload.details?.toolName).toLowerCase() === 'edit')?.payload;
        if (!permission) { return false; }
        assert.ok(patchScope(permission.details.toolInput.changes, owner.workspace, 'deny')); return true;
      }, 90_000);
      for (const marker of ['QUEUED_ONE', 'QUEUED_TWO']) {
        await frame.locator('#message-input').fill(`PB02_REQUEST:${marker}\nExplain one retry caveat without tools.`);
        await frame.locator('#message-input').press('Tab');
      }
      assert.strictEqual(await frame.locator('.queued-chip-remove').count(), 2);
      const inputCount = receipts().filter(value => value.event === 'request').length;
      const proof = await cancelTurn(turn);
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, inputCount, 'Stop keeps queued requests undispatched');
      assert.strictEqual(await frame.locator('.queued-chip-remove').count(), 2);
      while (await frame.locator('.queued-chip-remove').count()) { await frame.locator('.queued-chip-remove').first().click(); }
      faults.stopApproval = { ...proof, permission, queuedRemoved: 2, inputCount };
      record('stopped-approval', faults.stopApproval);
    }
    async function stopStreaming(): Promise<void> {
      const turn = await start('STOP_STREAM', 'Without tools, write a numbered audit of 120 distinct retry-service edge cases with an explanation for every case. Begin with the fixture identity and continue until all120 cases are covered.');
      await until('Actual nonempty streamed text', async () => (await events()).slice(turn.offset)
        .filter(value => value.type === 'responseChunk' && value.payload?.type === 'text')
        .reduce((total, value) => total + String(value.payload.content || '').length, 0) > 30, 90_000);
      const proof = await cancelTurn(turn);
      const partialMessage = proof.events.find((value: any) => value.type === 'requestCancelled')?.payload?.message;
      assert.ok(partialMessage?.content?.trim(), 'Useful partial text is persisted');
      faults.stopStreaming = { ...proof, partialMessage }; record('stopped-stream', faults.stopStreaming);
    }
    async function invalidModel(): Promise<void> {
      const selectedAt = Date.now(); await selectModel(manifest.invalidModel);
      const turn = await start('INVALID_MODEL', 'Without tools, summarize the retry requirement in one sentence.');
      await until('Invalid model visibly rejected', async () => (await events()).slice(turn.offset)
        .some(value => ['error', 'authError'].includes(value.type)), 90_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(turn.offset), errors = fresh.filter(value => ['error', 'authError'].includes(value.type));
      assert.ok(errors.some(value => /model/i.test(JSON.stringify(value.payload))
        && /invalid|not found|not available|not exist|unknown|not support|does not exist/i.test(JSON.stringify(value.payload))));
      assert.ok(!fresh.some(value => value.type === 'responseComplete'));
      const wire = receipts().filter(value => value.at >= selectedAt);
      const configurations = wire.filter(value => value.event === 'thread-config');
      assert.ok(configurations.length > 0); assert.ok(configurations.every(value => value.model === manifest.invalidModel));
      const requests = wire.filter(value => value.event === 'request'); assert.ok(requests.length <= 1);
      assert.ok(requests.every(value => value.model === manifest.invalidModel));
      assert.ok(!wire.some(value => ['tool-start', 'image-view', 'unexpected-tool-item'].includes(value.event)));
      assert.ok(!wire.some(value => value.event === 'turn-completed' && value.status === 'completed'));
      assertOriginalFilesEqual(turn.beforeFiles, files());
      faults.invalidModel = { selectedAt, selectedModel: manifest.invalidModel, configurations, errors, nativeReceipts: wire,
        forwardedRejectedInputs: requests.length, rejectedAttempts: 1, requests, beforeFiles: turn.beforeFiles, files: files() };
      record('invalid-model-rejected', faults.invalidModel); await selectModel(manifest.model);
    }
    async function attachments(): Promise<void> {
      const initialCount = (await events('fileAttachmentSelected')).length;
      for (const relative of ['attachments/brief.txt', 'attachments/status-blue.png']) {
        const before = (await events('fileAttachmentSelected')).length;
        await frame.locator('#attach-btn').click();
        const input = workbench.locator('.quick-input-widget input[type="text"]'); await input.waitFor({ state: 'visible' });
        await input.fill(path.join(owner.workspace, relative)); await input.press('Enter'); await input.waitFor({ state: 'hidden' });
        await until('Attachment acknowledged', async () => (await events('fileAttachmentSelected')).length > before);
      }
      const acknowledged = (await events('fileAttachmentSelected')).slice(initialCount).flatMap(value => value.payload.attachments);
      assert.strictEqual(acknowledged.length, 2); assert.strictEqual(new Set(acknowledged.map(value => value.id)).size, 2);
      for (const [relative, type] of [['attachments/brief.txt', 'file'], ['attachments/status-blue.png', 'image']]) {
        assert.ok(acknowledged.some(value => value.filePath === path.join(owner.workspace, relative)
          && value.type === type && value.size === manifest.fixture.files[relative].bytes));
      }
      const reply = await send('ATTACHMENTS', 'Inspect the two attached files. You may run cat attachments/brief.txt and use native image_view/view_image on the attached owned PNG path. Quote the release-note identity and deployment retry budget, name the actual dominant image color, and explain its relation to the cap. Do not infer color from the filename.',
        { commands: ['cat attachments/brief.txt'], attachments: true });
      assert.ok(reply.content.includes(manifest.attachmentToken)); assert.match(reply.content, /1[,.]?500/); assert.match(reply.content, /\bblue\b/i);
      assert.ok(reply.imageViews.some((value: any) => value.phase === 'item/completed'), 'Actual native image view receipt required');
      attachmentsEvidence = { status: 'PASS_REAL_ATTACHMENTS', replyId: reply.messageId, acknowledged, imageViews: reply.imageViews,
        preparedHashes: ['attachments/brief.txt', 'attachments/status-blue.png'].map(relative => manifest.fixture.files[relative].sha256) };
      record('attachments-complete', attachmentsEvidence);
    }
    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PB02_ACCEPTANCE_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.case, 'PB-02'); assert.strictEqual(manifest.stage, 'FULL_25_ACCEPTANCE');
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installCodexAcceptanceObserver); }
      for (const page of browser.contexts().flatMap(context => context.pages())) { if (await page.locator('.monaco-workbench').count()) { workbench = page; break; } }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      await createPanel('main');
      await configurePanel();
      files(); record('identity', { sourceId, panelId, model: manifest.model, extensionTestsPathUsed: false, productUnderDevelopment: (extension as any).isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API', bundleSha256: manifest.bundleSha256 });
    });
    it('diagnoses, patches, tests, denies a write, and resumes its real native thread', async () => {
      await send('DIAGNOSE', 'Run cat README.md src/retry.cjs. Diagnose the deliberate retryDelay bug and remember the fixture identity.', { commands: ['cat README.md src/retry.cjs'] }, 'commandExecution');
      await send('REGRESSION', 'Run cat test/retry.test.cjs. Derive the intended delays for attempts 0,1,4 and identify the failing baseline test.', { commands: ['cat test/retry.test.cjs'] }, 'commandExecution');
      await send('PATCH_DESIGN', 'Without tools, propose the smallest one-line correction from linear to capped exponential delay, preserving a cap smaller than base.');
      const patch = await send('PATCH_APPLY', 'Use native apply_patch to change only the return line in src/retry.cjs to return Math.min(cap, base * 2 ** attempt);. If needed, first run cat src/retry.cjs. Preserve every other byte and comment.', { commands: ['cat src/retry.cjs'], patch: 'fix' }, 'fileChange');
      assert.ok(observations.some(value => value.event === 'permission-decision' && value.at >= patch.started && value.approved && value.name === 'edit'), 'Real native patch approval required');
      await send('BASE_TESTS', 'Run exactly node --test test/retry.test.cjs once and summarize the actual result.', { commands: ['node --test test/retry.test.cjs'] }, 'commandExecution');
      runOracle('backoff');
      const denied = await send('DENY_CANARY', 'Run cat canaries/approval.txt, then propose exactly one native apply_patch replacing KEEP_THIS_CANARY_UNCHANGED with REQUESTED_CHANGE in that file. The user will deny it; acknowledge denial without retrying or bypassing it.', { commands: ['cat canaries/approval.txt'], patch: 'deny' });
      const denialDecisions = observations.filter(value => value.event === 'permission-decision' && value.at >= denied.started && value.expectedDenial);
      assert.strictEqual(denialDecisions.length, 1); assert.strictEqual(denialDecisions[0].approved, false);
      assert.ok(denied.nativeTools.some((value: any) => value.event === 'tool-result' && value.type === 'fileChange' && value.status !== 'completed'));
      deniedCanary = { replyId: denied.messageId, decisions: denialDecisions };
      const unrelated = await send('UNRELATED', 'Without tools, explain a practical tradeoff between a small sorted array and a hash map for developer lookup tables. Include this exact text once in your reply: مرحبا • café • € • 😀');
      assert.ok(unrelated.content.includes('مرحبا • café • € • 😀'), 'The actual native reply preserves the requested Unicode phrase');
      const effortStarted = Date.now(); await setEffort('medium');
      const returned = await send('RETURN_TASK', 'Return to the retry task without tools. State its exact fixture identity, corrected exponential formula, tests actually run, unchanged canary, and preserved developer edits.');
      assert.ok(returned.content.includes(manifest.token));
      const resumed = receipts().filter(value => value.event === 'thread-config' && value.at >= effortStarted && value.method === 'thread/resume');
      assert.strictEqual(resumed.length, 1); assert.strictEqual(resumed[0].sessionHash, replies[0].request.sessionHash);
      assert.strictEqual(returned.request.sessionHash, replies[0].request.sessionHash);
      resumeEvidence = { fromEffort: 'low', toEffort: 'medium', native: resumed[0], beforeSessionHash: replies[0].request.sessionHash, afterSessionHash: returned.request.sessionHash };
      await send('JITTER_REVIEW', 'Without tools, calculate deterministic fullJitter results for attempt0/base100/cap1000/sample0, attempt1/sample0.5, and attempt4/sample1. Explain flooring and why cap smaller than base is valid.');
      await send('RETRY_REVIEW', 'Run cat src/retry.cjs. Trace retry429 with maxRetries2: exact attempt indices and identity of the final returned429 versus a returned503. Explain operation exceptions.', { commands: ['cat src/retry.cjs'] }, 'commandExecution');
      await send('CANCEL_REVIEW', 'Without tools, review cancellation before attempt0 and during injected sleep. Explain exactly why no later operation runs, and how the signal reaches operation/sleep.');
      const revision = 'New requirement: export retryAfterMs(value, nowMs). Accept a string trimmed nonnegative integer delta-seconds or any of the three standard HTTP-date formats (IMF-fixdate, obsolete RFC850, or obsolete asctime). Interpret all three as GMT/UTC regardless of the process timezone. Accept both space-padded and zero-padded one-digit asctime days. Resolve an RFC850 two-digit year to the most recent matching date no more than50 full calendar years after nowMs, across century boundaries and using the complete date/time at the exact50-year cutoff, not only the year number. Reject impossible calendar dates and fractional date seconds. Past valid dates become0; invalid, negative, empty or non-string returns undefined. retry429 reads response.headers["retry-after"] from a plain object. Choose min(cap, max(fullJitter(attempt,{base,cap,random}), retryAfterMs(value,now()) ?? 0)). Preserve all existing APIs, validation, returned object identity, exception propagation, and cancellation ordering.';
      record('requirement-declared', { revision });
      await send('RETRY_AFTER_PLAN', `${revision} Without tools, explain the minimal implementation and the difference between absent, future and expired header values.`);
      await send('RETRY_AFTER_PATCH', `${revision} Implement only in src/retry.cjs using native apply_patch. You may first run cat src/retry.cjs. Do not touch tests yet. Preserve existing validation, comments and exports while adding the new export.`, { commands: ['cat src/retry.cjs'], patch: 'revision' }, 'fileChange');
      await send('TEST_REVISION', 'Using one native apply_patch, append new deterministic node:test cases only at the end of test/retry.test.cjs, after the complete original final abort-during-injected-sleep test. The complete original1635-byte file must remain the exact initial prefix, including its final newline; never insert before or between existing tests, edit existing imports, or rewrite any original byte. Append a separate require to access retryAfterMs. Cover trimmed delta-seconds; all three HTTP-date forms as GMT/UTC; space- and zero-padded one-digit asctime days; RFC850 century crossings and instants one second before, exactly at, and one second beyond the full50-year cutoff; past dates; impossible calendar dates; fractional seconds; invalid headers; cap versus Retry-After; exhausted response identity; abort during sleep. No packages/network. You may first run cat test/retry.test.cjs.', { commands: ['cat test/retry.test.cjs'], patch: 'tests' }, 'fileChange');
      assert.ok(fs.readFileSync(path.join(owner.workspace, 'test/retry.test.cjs'), 'utf8').startsWith(manifest.fixture.files['test/retry.test.cjs'].text), 'Existing tests remain exact prefix');
      await send('FULL_TESTS', 'Run exactly node --test test/retry.test.cjs. Report the actual pass/fail count and which new Retry-After boundary was covered.', { commands: ['node --test test/retry.test.cjs'] }, 'commandExecution');
      runOracle('full'); runBoundaryOracle('FULL_TESTS');
      await send('HTTP_REVIEW', 'Without tools or network, trace a loopback-like sequence429 Retry-After2 then200 with base100/cap1000/random1. State exact chosen delay and why response identity is preserved. Contrast a returned503 with a thrown operation error.');
      await send('INVALID_INPUT_REVIEW', 'Without tools, review validation for attempt/maxRetries negative or fractional, nonfinite base/cap/sample, sample outside[0,1], and cap<base. Explain whether an exhausted last429 schedules another sleep.');
      await readonlyCanary();
      await attachments();
      await createPanel('other'); await configurePanel();
      const other = await send('OTHER_PANEL', `This independent chat identity is ${manifest.otherPanelToken}. Without tools, compare a database transaction rollback with retrying an HTTP request. Include this chat identity.`);
      assert.ok(other.content.includes(manifest.otherPanelToken));
      assert.strictEqual(other.request.outsideMemoryContainsOtherPanelToken, true);
      assert.notStrictEqual(other.request.sessionHash, replies[0].request.sessionHash);
      assert.strictEqual(tabEvidence().length, 2); assert.ok(tabEvidence().every(value => value.stillOpen));
      await reveal('main');
      const mainReturn = await send('MAIN_RETURN', 'Return to the retry service without tools. Quote its original identity and summarize the new Retry-After rule, attachment release-note identity and budget. Use only this conversation.');
      assert.ok(mainReturn.content.includes(manifest.token)); assert.ok(mainReturn.content.includes(manifest.attachmentToken));
      assert.ok(!mainReturn.content.includes(manifest.otherPanelToken));
      await stopApproval();
      await send('STOP_APPROVAL_RECOVERY', 'Resume after the stopped approval request. Without tools, explain why the canary remains unchanged and why neither queued request was authorized to run. Reaffirm our retry-service identity.');
      await stopStreaming();
      await send('STOP_STREAM_RECOVERY', 'Resume after the stopped long audit. Without tools, give three high-value edge cases for the current retry service, preserving the Retry-After/cap and cancellation requirements. Include the original identity.');
      await invalidModel();
      const recovered = await send('INVALID_MODEL_RECOVERY', 'The invalid model was rejected and the original explicit model restored. Without tools, summarize the current implementation and quote its original service identity.');
      assert.ok(recovered.content.includes(manifest.token));
      await send('FINAL_REVIEW', 'Run exactly git -c core.hooksPath=/dev/null diff -- src/retry.cjs test/retry.test.cjs and exactly node --test test/retry.test.cjs. Review the actual final changes, tests, preserved notes and unchanged canary. Report any unresolved limitations honestly.',
        { commands: ['git -c core.hooksPath=/dev/null diff -- src/retry.cjs test/retry.test.cjs', 'node --test test/retry.test.cjs'] }, 'commandExecution');
      runOracle('full'); runBoundaryOracle('FINAL_REVIEW');
      const history = await publicHistory();
      const finalConversations = [...panels.values()].map(panel => history.find(value => value.id === panel.conversationId));
      assert.ok(finalConversations.every(Boolean));
      for (const reply of replies) {
        const conversation = finalConversations.find(value => value.id === reply.conversationId);
        assert.ok(conversation.messages.some((message: any) => message.id === reply.messageId && message.content === reply.content));
      }
      const requests = receipts().filter(value => value.event === 'request');
      assert.strictEqual(replies.length, 25);
      assert.strictEqual(requests.length, 27 + faults.invalidModel.forwardedRejectedInputs);
      assert.ok(!requests.some(value => value.outsideMemoryMarkers.some((marker: string) => ['QUEUED_ONE', 'QUEUED_TWO'].includes(marker))));
      assert.ok(!receipts().some(value => /refusal|instrumentation-error|launch-error|unexpected-tool-item/.test(value.event)));
      assert.ok(tabEvidence().every(value => value.stillOpen));
      const acceptance = { status: limits.length ? 'PARTIAL_FULL_25' : 'PASS_FULL_25_BOUNDED', stage: manifest.stage,
        sourceId: panels.get('main')!.conversationId, panelId: panels.get('main')!.panelId,
        otherSourceId: panels.get('other')!.conversationId, otherPanelId: panels.get('other')!.panelId,
        replies, finalConversations, liveTabs: tabEvidence(), deniedCanary, threadResume: resumeEvidence,
        faults, attachmentsEvidence, oracles, boundaryOracles, limits, files: files(),
        counts: { completedTurns: 25, conversationalInputs: requests.length, cancelledInputs: 2,
          rejectedAttempts: 1, forwardedRejectedInputs: faults.invalidModel.forwardedRejectedInputs,
          auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length },
        scope: manifest.scope, extendedCoverage: 'Named profile, F2, native compaction and elapsed W/E/P NOT_RUN',
        semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
      fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify(acceptance, null, 2));
      complete = true; record('acceptance-complete', { status: acceptance.status, counts: acceptance.counts });
    });

    after(async () => {
      if (owner) {
        if (!complete) { await workbench?.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {}); }
        for (const [label, panel] of panels) {
          const captured = await panel.frame.evaluate(() => (globalThis as any).__pb02AcceptanceEvents || []).catch(() => []);
          fs.writeFileSync(path.join(owner.directory, `events-${label}.json`), JSON.stringify(captured.filter((value: any) => !['conversationHistory', 'conversationChanged'].includes(value.type)), null, 2));
        }
      }
      await browser?.close().catch(() => {});
    });
  });
}
