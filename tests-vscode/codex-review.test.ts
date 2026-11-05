/** PB-02 native peer review of a preserved generated source, in an owned copy. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexReviewObserver } from './codex-review-observer';
const repo = process.env.MYSTI_PB02_REVIEW_REPO || path.resolve(__dirname, '..');
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type Scope = { commands?: string[]; patch?: 'repair' };

if (process.env.MYSTI_PB02_REVIEW === '1') {
  // Native campaign imports may resolve pinned local evidence; require opt-in first.
  const { exactCommand, patchScope, assertSourceRepair, verifyPreservedBase } = require(path.join(repo, 'scripts/validation/codex-review-contract.cjs'));
  const { assertToolOutputProjection } = require(path.join(repo, 'scripts/validation/codex-full-oracle.cjs'));
  describe('PB-02 real editor preserved HTTP-date peer review and repair', function () {
    this.timeout(780_000);
    let manifest: any, owner: any, browser: Browser, workbench: Page, frame: Frame, sourceId: string, panelId: string, complete = false;
    const observations: any[] = [], replies: any[] = [], decisions = new Set<string>();
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
      const result = await frame.evaluate(() => (globalThis as any).__pb02ReviewEvents || []);
      return type ? result.filter((value: any) => value.type === type) : result;
    }
    function receipts(): any[] {
      return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
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
        if (relative !== 'src/retry.cjs') { assert.strictEqual(hashes[relative], expected.sha256, `${relative} unchanged`); }
      }
      const extras = Object.keys(hashes).filter(relative => !manifest.fixture.files[relative]);
      const historyFile = `.mysti/compaction/${panelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}/history.jsonl`;
      assert.ok(extras.every(relative => relative === '.mysti/compaction/.gitignore' || relative === historyFile));
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
        const approved = validCommand || validPatch;
        const expectedDenial = false;
        const beforeFiles = files();
        if (validPatch && scope.patch === 'repair') {
          assert.strictEqual(beforeFiles.hashes['src/retry.cjs'], manifest.fixture.files['src/retry.cjs'].sha256, 'Source remains original before actual Edit approval');
        }
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id);
        record('permission-decision', { id: request.id, name, input, inputSha256: hash(JSON.stringify(input)), approved, expectedDenial, beforeFiles });
        assert.ok(approved || expectedDenial, 'Unexpected native permission denied; exact scope remains unchanged');
      }
    }
    async function send(marker: string, task: string, scope: Scope = {}, required?: 'commandExecution' | 'fileChange', effort = 'low'): Promise<any> {
      assert.ok(receipts().filter(value => value.event === 'request').length < 3, 'Three app-server user-frame hard cap');
      const offset = (await events()).length, started = Date.now(), beforeFiles = files();
      const commandRule = scope.commands?.length ? `Only these exact shell command bodies are allowed, using the workspace cwd: ${scope.commands.map(command => JSON.stringify(command)).join(', ')}.` : 'No shell commands are authorized.';
      const prompt = `PB02_REQUEST:${marker}\n${task}\n${commandRule} ${scope.patch ? 'Use only the native apply_patch/file-change tool for the single requested patch; no shell-based writes.' : 'Do not write or change files.'} No other files, external tools, network, package operations or actions. Preserve staged notes and the source developer comment. Keep final prose under 140 words, include the fixture identity when known, and end PB02_DONE:${marker}.`;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
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
      assert.strictEqual(request.policy.ownedCwd, true); assert.strictEqual(request.policy.approvalPolicy, 'untrusted'); assert.strictEqual(request.policy.sandbox, 'read-only');
      assert.strictEqual(request.policy.mcpAllDisabled, true); assert.strictEqual(request.policy.appsAllDisabled, true); assert.strictEqual(request.policy.appsDefaultDisabled, true);
      const nativeSession = receipts().filter(value => value.event === 'session' && value.wrapperPid === request.wrapperPid && value.at <= request.at).at(-1);
      assert.ok(nativeSession); assert.strictEqual(nativeSession.sessionHash, request.sessionHash); assert.strictEqual(nativeSession.actualModel, manifest.model);
      assert.ok(nativeSession.modelProvider); assert.strictEqual(nativeSession.returnedPolicy.approvalPolicy, 'untrusted');
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
        const results = wire.filter(value => value.event === 'tool-result' && value.itemIdHash === hash(tool.id)); assert.strictEqual(results.length, 1);
        const result = results[0], live = fresh.filter(value => value.type === 'toolResult' && value.payload?.id === tool.id); assert.strictEqual(live.length, 1);
        toolOutputEvidence.push(assertToolOutputProjection({ nativeResult: result, liveTool: live[0].payload, persistedTool: tool }));
        assert.strictEqual(tool.status, 'completed'); assert.strictEqual(result.status, 'completed');
        if (name === 'bash') { assert.strictEqual(result.exitCode, 0); }
      }
      if (required) {
        assert.ok(wire.some(value => value.event === 'tool-result' && value.type === required && value.status === 'completed'), 'Required actual tool success, not a proposal');
      }
      if (marker === 'PEER_TESTS') {
        assert.ok(tools.some((tool: any) => tool.name === 'Bash' && /# fail 0\b/.test(tool.output)));
        assert.ok(wire.some(value => value.event === 'tool-result' && value.type === 'commandExecution' && value.status === 'completed' && value.exitCode === 0));
      }
      const afterFiles = files();
      if (!scope.patch) { for (const relative of Object.keys(manifest.fixture.files)) { assert.strictEqual(afterFiles.hashes[relative], beforeFiles.hashes[relative], 'Read/test turns must not mutate developer files'); } }
      verifyPreservedBase(manifest.fixture);
      const reply = { scope, beforeFiles, toolOutputEvidence, ordinal: replies.length + 1, marker, conversationId: sourceId, panelId, messageId: message.id, provider: message.provider,
        model: message.model, content: message.content, tools, usage: message.usage, request, nativeSession, started, completedAt: terminal[0].at,
        turnCompleted: completed[0], nativeTools: wire.filter(value => ['tool-start', 'tool-result'].includes(value.event)),
        permissionDecisionIds: fresh.filter(value => value.type === 'permissionRequest').map(value => value.payload.id) };
      replies.push(reply); record('native-response', { ...reply, afterFiles: files() }); return reply;
    }
    async function publicHistory(): Promise<any[]> {
      const before = (await events('conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      await frame.locator('#history-btn').click(); await until('Public stored history', async () => (await events('conversationHistory')).length > before);
      const result = (await events('conversationHistory')).at(-1).payload.conversations; await frame.locator('#history-btn').click(); return result;
    }
    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PB02_REVIEW_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.case, 'PB-02'); assert.strictEqual(manifest.stage, 'PEER_REVIEW_REPAIR');
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installCodexReviewObserver); }
      for (const page of browser.contexts().flatMap(context => context.pages())) { if (await page.locator('.monaco-workbench').count()) { workbench = page; break; } }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      const prior = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('Actual new chat mounts', async () => {
        const matches: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (prior.has(candidate)) { continue; }
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { matches.push(candidate); } } catch { /* Mounting. */ }
        }
        if (matches.length !== 1) { return false; } frame = matches[0]; return true;
      });
      await workbench.bringToFront(); if (await frame.locator('.wizard-skip-btn').isVisible()) { await frame.locator('.wizard-skip-btn').click(); }
      await frame.evaluate(installCodexReviewObserver); await frame.locator('#new-conversation-btn').click();
      await until('Public chat identity', async () => (await events('conversationChanged')).length > 0);
      sourceId = (await events('conversationChanged')).at(-1).payload.id; panelId = (await events('initialState')).at(-1)?.payload.panelId; assert.ok(panelId);
      await frame.locator('#agent-select-btn').click(); await frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
      await frame.locator('#behavior-indicator').click(); await frame.locator('#behavior-popup .mode-option[data-mode="ask"]').click();
      const before = (await events('modelChanged')).length; await frame.locator('#model-menu-btn').click();
      const selected = frame.locator(`#model-menu-options [data-model=${JSON.stringify(manifest.model)}]`);
      if (await selected.count()) { await selected.click(); } else {
        await frame.locator('#model-menu-options [data-model="__custom__"]').click();
        const quick = workbench.locator('.quick-input-widget'); await quick.waitFor({ state: 'visible' });
        assert.ok((await quick.innerText()).includes('Choose a custom model')); await quick.locator('input').fill(manifest.model); await quick.locator('input').press('Enter'); await quick.waitFor({ state: 'hidden' });
      }
      await until('Explicit model acknowledged', async () => (await events('modelChanged')).slice(before).some(value => value.payload.provider === 'openai-codex' && (value.payload.customModel || value.payload.model) === manifest.model));
      verifyPreservedBase(manifest.fixture); files(); record('identity', { sourceId, panelId, model: manifest.model, extensionTestsPathUsed: false, productUnderDevelopment: (extension as any).isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API', bundleSha256: manifest.bundleSha256 });
    });
    it('reviews the prior model source, approves its minimal repair and executes actual tests', async () => {
      await send('PEER_REVIEW', 'Run cat README.md src/retry.cjs test/retry.test.cjs. This is an exact owned copy of a previous gpt-6.1-sol implementation. Independently review retryAfterMs for the contract that all three standard HTTP-date formats represent GMT in every host timezone. Give a precise counterexample and a minimal one-line timestamp-initializer correction; do not edit. Preserve the existing cancellation/retry behavior.',
        { commands: ['cat README.md src/retry.cjs test/retry.test.cjs'] }, 'commandExecution');
      const repair = await send('PEER_REPAIR', 'Repair only the const timestamp initializer in retryAfterMs using native apply_patch. Retain Date.parse and its existing formats-loop index i; normalize only the timezone-free third HTTP-date format to explicit GMT. Change exactly this one source line; preserve every other byte, all existing tests, staged notes and developer comment. You may first run cat src/retry.cjs.',
        { commands: ['cat src/retry.cjs'], patch: 'repair' }, 'fileChange');
      assert.ok(observations.some(value => value.event === 'permission-decision' && value.at >= repair.started && value.approved && value.name === 'edit'), 'Repair requires an actual native approval');
      assertSourceRepair(Buffer.from(manifest.fixture.files['src/retry.cjs'].text), fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs')));
      await send('PEER_TESTS', 'Run exactly node --test test/retry.test.cjs once. Report the actual counts and explain that this existing suite alone does not establish cross-timezone correctness. Do not edit or run any other command.',
        { commands: ['node --test test/retry.test.cjs'] }, 'commandExecution');
      const oracles: any[] = [];
      for (const [scriptName, args, label] of [
        ['http-date-portability-oracle.cjs', [], 'http-date'], ['codex-fixture-oracle.cjs', ['full'], 'full'],
      ] as const) {
        const script = path.join(repo, 'scripts/validation', scriptName);
        assert.strictEqual(hash(fs.readFileSync(script)), manifest.harnessDependencyIdentities.find((value: any) => value.path === script).sha256);
        const output = execFileSync(manifest.nodeIdentity.path, [script, path.join(owner.workspace, 'src/retry.cjs'), ...args], { encoding: 'utf8', timeout: 20_000 });
        const report = JSON.parse(output), artifact = path.join(owner.directory, `oracle-${label}.json`);
        fs.writeFileSync(artifact, output, { flag: 'wx' }); assert.strictEqual(report.status, 'PASS'); assert.strictEqual(report.failed, 0);
        assert.strictEqual(report.sourceSha256, hash(fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs'))));
        assert.strictEqual(report.fixtureSourceUnchanged, true); assert.strictEqual(report.realProviderInputs, 0);
        if (label === 'http-date') { assert.strictEqual(report.passed, 45); assert.strictEqual(report.expectedChecks, 45); }
        oracles.push({ label, path: artifact, report });
      }
      verifyPreservedBase(manifest.fixture);
      const history = await publicHistory(), finalConversation = history.find(value => value.id === sourceId); assert.ok(finalConversation);
      for (const reply of replies) { assert.ok(finalConversation.messages.some((message: any) => message.id === reply.messageId && message.content === reply.content)); }
      assert.strictEqual(replies.length, 3); assert.strictEqual(receipts().filter(value => value.event === 'request').length, 3);
      assert.ok(!receipts().some(value => /refusal|instrumentation-error|launch-error|unexpected-tool-item/.test(value.event)));
      const acceptance = { status: 'PASS_PEER_REPAIR_TRANSPORT', stage: manifest.stage, sourceId, panelId, replies, finalConversation,
        files: files(), oracles, preservedBase: manifest.fixture.base,
        counts: { completedTurns: 3, conversationalInputs: 3, auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length },
        scope: manifest.scope, remainingFull25AndExtendedCoverage: 'NOT_RUN', semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
      fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify(acceptance, null, 2)); complete = true; record('acceptance-complete', { status: acceptance.status, counts: acceptance.counts });
    });

    after(async () => {
      if (owner) {
        if (!complete) { await workbench?.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {}); }
        if (frame) { fs.writeFileSync(path.join(owner.directory, 'events-main.json'), JSON.stringify((await events().catch(() => [])).filter(value => !['conversationHistory', 'conversationChanged'].includes(value.type)), null, 2)); }
      }
      await browser?.close().catch(() => {});
    });
  });
}
