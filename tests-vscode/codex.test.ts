/** PB-02 first-eight native developer turns in an ordinary installed editor. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexObserver } from './codex-observer';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type Scope = { commands?: string[]; patch?: 'fix' | 'deny' };

if (process.env.MYSTI_PB02 === '1') {
  // Native campaign imports may resolve pinned local evidence; require opt-in first.
  const { exactCommand, patchScope } = require('../scripts/validation/codex-stage-oracle.cjs') as {
    exactCommand: (actual: unknown, expected: string) => boolean;
    patchScope: (changes: unknown, workspace: string, purpose: 'fix' | 'deny') => boolean;
  };
  describe('PB-02 real editor first eight Codex developer turns', function () {
    this.timeout(1_500_000);
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
      const result = await frame.evaluate(() => (globalThis as any).__pb02Events || []);
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
        const approved = validCommand || validPatch && scope.patch === 'fix';
        const expectedDenial = validPatch && scope.patch === 'deny';
        const beforeFiles = files();
        if (validPatch && scope.patch === 'fix') {
          assert.strictEqual(beforeFiles.hashes['src/retry.cjs'], manifest.fixture.files['src/retry.cjs'].sha256, 'Source remains original before actual Edit approval');
        }
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id);
        record('permission-decision', { id: request.id, name, input, inputSha256: hash(JSON.stringify(input)), approved, expectedDenial, beforeFiles });
        assert.ok(approved || expectedDenial, 'Unexpected native permission denied; exact scope remains unchanged');
      }
    }
    async function send(marker: string, task: string, scope: Scope = {}, required?: 'commandExecution' | 'fileChange', effort = 'low'): Promise<any> {
      assert.ok(receipts().filter(value => value.event === 'request').length < 10, 'Ten app-server user-frame hard cap');
      const offset = (await events()).length, started = Date.now();
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
      const tools = message.toolCalls || [];
      for (const tool of tools) {
        const name = String(tool.name).toLowerCase(), input = tool.input || {};
        const commandAllowed = name === 'bash' && input.cwd === owner.workspace && (scope.commands || []).some(command => exactCommand(input.command, command));
        const patchAllowed = name === 'edit' && !!scope.patch && patchScope(input.changes, owner.workspace, scope.patch);
        assert.ok(commandAllowed || patchAllowed, 'Actual tool stays inside exact owned command/patch scope');
        const result = wire.find(value => value.event === 'tool-result' && value.itemIdHash === hash(tool.id)); assert.ok(result);
        assert.strictEqual(result.outputSha256, hash(String(tool.output)), 'Native result bytes match persisted public tool output');
        if (scope.patch !== 'deny' || name !== 'edit') { assert.strictEqual(tool.status, 'completed'); assert.strictEqual(result.status, 'completed'); }
      }
      if (required) {
        assert.ok(wire.some(value => value.event === 'tool-result' && value.type === required && value.status === 'completed'), 'Required actual tool success, not a proposal');
      }
      if (marker === 'BASE_TESTS') {
        assert.ok(tools.some((tool: any) => tool.name === 'Bash' && /# fail 0\b/.test(tool.output)));
        assert.ok(wire.some(value => value.event === 'tool-result' && value.type === 'commandExecution' && value.status === 'completed' && value.exitCode === 0));
      }
      const reply = { ordinal: replies.length + 1, marker, conversationId: sourceId, panelId, messageId: message.id, provider: message.provider,
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
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PB02_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.case, 'PB-02'); assert.strictEqual(manifest.stage, 'FIRST_EIGHT');
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installCodexObserver); }
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
      await frame.evaluate(installCodexObserver); await frame.locator('#new-conversation-btn').click();
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
      files(); record('identity', { sourceId, panelId, model: manifest.model, extensionTestsPathUsed: false, productUnderDevelopment: (extension as any).isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API', bundleSha256: manifest.bundleSha256 });
    });
    it('diagnoses, patches, tests, denies a write, and resumes its real native thread', async () => {
      await send('DIAGNOSE', 'Run cat README.md src/retry.cjs. Diagnose the deliberate retryDelay bug and remember the fixture identity.', { commands: ['cat README.md src/retry.cjs'] }, 'commandExecution');
      await send('REGRESSION', 'Run cat test/retry.test.cjs. Derive the intended delays for attempts 0,1,4 and identify the failing baseline test.', { commands: ['cat test/retry.test.cjs'] }, 'commandExecution');
      await send('PATCH_DESIGN', 'Without tools, propose the smallest one-line correction from linear to capped exponential delay, preserving a cap smaller than base.');
      const patch = await send('PATCH_APPLY', 'Use native apply_patch to change only the return line in src/retry.cjs to return Math.min(cap, base * 2 ** attempt);. If needed, first run cat src/retry.cjs. Preserve every other byte and comment.', { commands: ['cat src/retry.cjs'], patch: 'fix' }, 'fileChange');
      assert.ok(observations.some(value => value.event === 'permission-decision' && value.at >= patch.started && value.approved && value.name === 'edit'), 'Real native patch approval required');
      await send('BASE_TESTS', 'Run exactly node --test test/retry.test.cjs once and summarize the actual result.', { commands: ['node --test test/retry.test.cjs'] }, 'commandExecution');
      const oracleScript = path.resolve(__dirname, '../scripts/validation/codex-fixture-oracle.cjs');
      assert.strictEqual(hash(fs.readFileSync(oracleScript)), manifest.harnessDependencyIdentities.find((value: any) => value.path === oracleScript).sha256);
      const oracleOutput = execFileSync(manifest.nodeIdentity.path, [oracleScript, path.join(owner.workspace, 'src/retry.cjs'), 'backoff'], { encoding: 'utf8', timeout: 20_000 });
      fs.writeFileSync(path.join(owner.directory, 'oracle-backoff.json'), oracleOutput); record('independent-oracle', { stage: 'backoff', exitCode: 0, sourceSha256: hash(fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs'))) });
      const denied = await send('DENY_CANARY', 'Run cat canaries/approval.txt, then propose exactly one native apply_patch replacing KEEP_THIS_CANARY_UNCHANGED with REQUESTED_CHANGE in that file. The user will deny it; acknowledge denial without retrying or bypassing it.', { commands: ['cat canaries/approval.txt'], patch: 'deny' });
      const denialDecisions = observations.filter(value => value.event === 'permission-decision' && value.at >= denied.started && value.expectedDenial);
      assert.strictEqual(denialDecisions.length, 1); assert.strictEqual(denialDecisions[0].approved, false);
      assert.ok(denied.nativeTools.some((value: any) => value.event === 'tool-result' && value.type === 'fileChange' && value.status !== 'completed'));
      await send('UNRELATED', 'Without tools, explain a practical tradeoff between a small sorted array and a hash map for developer lookup tables.');
      const effortStarted = Date.now(); await frame.locator('#model-menu-btn').click();
      const levels = await frame.locator('#effort-select-inline option').evaluateAll(elements => elements.map(element => element.getAttribute('value')!));
      const effort = levels.includes('medium') ? 'medium' : levels.find(value => value && value !== 'low'); assert.ok(effort);
      const slider = frame.locator('#model-menu-effort-slider'); await slider.focus(); await slider.press('Home');
      for (let index = 0; index < levels.indexOf(effort); index++) { await slider.press('ArrowRight'); }
      await frame.locator('#model-menu-btn').click(); record('effort-selected', { effort, levels });
      const returned = await send('RETURN_TASK', 'Return to the retry task without tools. State its exact fixture identity, corrected exponential formula, tests actually run, unchanged canary, and preserved developer edits.', {}, undefined, effort);
      assert.ok(returned.content.includes(manifest.token));
      const resumed = receipts().filter(value => value.event === 'thread-config' && value.at >= effortStarted && value.method === 'thread/resume');
      assert.strictEqual(resumed.length, 1); assert.strictEqual(resumed[0].sessionHash, replies[0].request.sessionHash); assert.strictEqual(returned.request.sessionHash, replies[0].request.sessionHash);
      const history = await publicHistory(), finalConversation = history.find(value => value.id === sourceId); assert.ok(finalConversation);
      for (const reply of replies) { assert.ok(finalConversation.messages.some((message: any) => message.id === reply.messageId && message.content === reply.content)); }
      assert.strictEqual(replies.length, 8); assert.strictEqual(receipts().filter(value => value.event === 'request').length, 8);
      assert.ok(!receipts().some(value => /refusal|instrumentation-error|launch-error/.test(value.event)));
      const acceptance = { status: 'PASS_FIRST_EIGHT_ONLY', stage: manifest.stage, sourceId, panelId, replies, finalConversation,
        deniedCanary: { replyId: denied.messageId, decisions: denialDecisions }, threadResume: { fromEffort: 'low', toEffort: effort, native: resumed[0], beforeSessionHash: replies[0].request.sessionHash, afterSessionHash: returned.request.sessionHash },
        files: files(), oracle: { stage: 'backoff', path: path.join(owner.directory, 'oracle-backoff.json') },
        counts: { completedTurns: 8, conversationalInputs: 8, auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length },
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
