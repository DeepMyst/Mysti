/** PB-02 native named-profile compatibility in a preserved final fixture copy. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { installCodexProfileCompatibilityObserver } from './codex-profile-compatibility-observer';
const repo = process.env.MYSTI_PB02_PROFILE_COMPATIBILITY_REPO || path.resolve(__dirname, '..');
const { exactCommand, verifyPreservedBase, verifyCopiedFixture, verifyOwnedProfiles } = require(path.join(repo, 'scripts/validation/codex-profile-validation-contract.cjs'));
const { assertToolOutputProjection } = require(path.join(repo, 'scripts/validation/codex-full-oracle.cjs'));
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type Scope = { commands?: string[] };

if (process.env.MYSTI_PB02_PROFILE_COMPATIBILITY === '1') {
  describe('PB-02 real editor named profile compatibility', function () {
    this.timeout(780_000);
    let manifest: any, owner: any, browser: Browser, workbench: Page, frame: Frame, sourceId: string, panelId: string, complete = false;
    const observations: any[] = [], replies: any[] = [], attempts: any[] = [], decisions = new Set<string>();
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
      const result = await frame.evaluate(() => (globalThis as any).__pb02ProfileCompatibilityEvents || []);
      return type ? result.filter((value: any) => value.type === type) : result;
    }
    function receipts(): any[] {
      return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    }
    function files(): any { verifyOwnedProfiles(manifest.profileValidation); return verifyCopiedFixture(manifest.fixture, panelId); }
    async function permissions(offset: number, scope: Scope): Promise<void> {
      for (const event of (await events()).slice(offset).filter(value => value.type === 'permissionRequest')) {
        const request = event.payload; if (decisions.has(request.id)) { continue; }
        const input = request.details?.toolInput || {}, name = String(request.details?.toolName || request.title).toLowerCase();
        const validCommand = name === 'bash' && input.cwd === owner.workspace && (scope.commands || []).some(command => exactCommand(input.command, command));
        const approved = validCommand;
        const expectedDenial = false;
        const beforeFiles = files();
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id);
        record('permission-decision', { id: request.id, name, input, inputSha256: hash(JSON.stringify(input)), approved, expectedDenial, beforeFiles });
        assert.ok(approved || expectedDenial, 'Unexpected native permission denied; exact scope remains unchanged');
      }
    }
    async function send(marker: string, task: string, scope: Scope = {}, required?: 'commandExecution', effort = 'low', selected?: any): Promise<any> {
      assert.ok(receipts().filter(value => value.event === 'request').length < 3, 'Three app-server user-frame hard cap');
      const offset = (await events()).length, started = Date.now(), beforeFiles = files();
      const commandRule = scope.commands?.length ? `Only these exact shell command bodies are allowed, using the workspace cwd: ${scope.commands.map(command => JSON.stringify(command)).join(', ')}.` : 'No shell commands are authorized.';
      const prompt = `PB02_REQUEST:${marker}\n${task}\n${commandRule} Do not write or change files. No other files, external tools, network, package operations or actions. Preserve staged notes and the source developer comment. Keep final prose under 180 words, include the fixture identity when known, and end PB02_DONE:${marker}.`;
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
      assert.strictEqual(tools.length, scope.commands?.length ? 1 : 0, 'Exactly one authorized read or no tools');
      assert.strictEqual(wire.filter(value => value.event === 'tool-start').length, tools.length);
      assert.strictEqual(wire.filter(value => value.event === 'tool-result').length, tools.length);
      for (const tool of tools) {
        const name = String(tool.name).toLowerCase(), input = tool.input || {};
        const commandAllowed = name === 'bash' && input.cwd === owner.workspace && (scope.commands || []).some(command => exactCommand(input.command, command));
        assert.ok(commandAllowed, 'Actual tool stays inside exact owned read-only command scope');
        const results = wire.filter(value => value.event === 'tool-result' && value.itemIdHash === hash(tool.id)); assert.strictEqual(results.length, 1);
        const result = results[0], live = fresh.filter(value => value.type === 'toolResult' && value.payload?.id === tool.id); assert.strictEqual(live.length, 1);
        toolOutputEvidence.push(assertToolOutputProjection({ nativeResult: result, liveTool: live[0].payload, persistedTool: tool }));
        assert.strictEqual(tool.status, 'completed'); assert.strictEqual(result.status, 'completed');
        if (name === 'bash') { assert.strictEqual(result.exitCode, 0); }
      }
      if (required) {
        assert.ok(wire.some(value => value.event === 'tool-result' && value.type === required && value.status === 'completed'), 'Required actual tool success, not a proposal');
      }
      const afterFiles = files();
      for (const relative of Object.keys(manifest.fixture.files)) { assert.strictEqual(afterFiles.hashes[relative], beforeFiles.hashes[relative], 'Profile validation must not mutate copied files'); }
      verifyPreservedBase(manifest.fixture);
      const reply = { scope, beforeFiles, toolOutputEvidence, ordinal: replies.length + 1, marker, conversationId: sourceId, panelId, messageId: message.id, provider: message.provider,
        model: message.model, content: message.content, tools, usage: message.usage, request, nativeSession, started, completedAt: terminal[0].at,
        turnCompleted: completed[0], nativeTools: wire.filter(value => ['tool-start', 'tool-result'].includes(value.event)),
        permissionDecisionIds: fresh.filter(value => value.type === 'permissionRequest').map(value => value.payload.id) };
      replies.push(reply); record('native-response', { ...reply, afterFiles: files() });
      assert.ok(selected); await finishAttempt({ ...selected, marker, started, replyId: reply.messageId }); return reply;
    }
    async function selectProfile(configRaw: string): Promise<any> {
      const receiptStartIndex = receipts().length, inputCountBefore = receipts().filter(value => value.event === 'request').length;
      const selectedAt = Date.now();
      await vscode.workspace.getConfiguration('mysti').update('codexProfile', configRaw, vscode.ConfigurationTarget.Global);
      const configReadback = vscode.workspace.getConfiguration('mysti').get('codexProfile');
      assert.strictEqual(configReadback, configRaw);
      record('profile-selection', { configRaw, configReadback, selectedAt, receiptStartIndex, inputCountBefore });
      return { configRaw, configReadback, selectedAt, receiptStartIndex, inputCountBefore };
    }
    async function finishAttempt(value: any): Promise<void> {
      const current = receipts(), ended = Date.now(), capturedEvents = (await events()).filter(event => event.at >= value.started && event.at <= ended && !['conversationHistory', 'conversationChanged'].includes(event.type));
      const users = capturedEvents.filter(event => event.type === 'messageAdded' && event.payload?.role === 'user' && event.payload?.content?.includes(`PB02_REQUEST:${value.marker}`));
      assert.strictEqual(users.length, 1);
      const errorEvents = capturedEvents.filter(event => ['error', 'authError', 'requestCancelled'].includes(event.type));
      const attempt = { ...value, ended, userMessageId: users[0].payload.id, capturedEvents, errorEvents,
        receiptEndIndex: current.length, inputCountAfter: current.filter(event => event.event === 'request').length };
      assert.ok(current.slice(attempt.receiptStartIndex).every(event => event.at <= ended));
      attempts.push(attempt); record('profile-attempt', attempt);
    }
    async function reject(marker: string, selected: any, expectedError: RegExp): Promise<void> {
      const offset = (await events()).length, started = Date.now(), errorsBefore = await frame.locator('.message.error').count();
      await frame.locator('#message-input').fill(`PB02_REQUEST:${marker}\nWithout tools, state the fixture identity if known. End PB02_DONE:${marker}.`);
      await frame.locator('#send-btn').click();
      await until(`${marker} actionable error`, async () => {
        const fresh = (await events()).slice(offset);
        assert.ok(!fresh.some(value => ['responseComplete', 'toolUse', 'toolResult', 'permissionRequest'].includes(value.type)), 'Rejected profile must not execute a turn or a tool');
        return fresh.some(value => value.type === 'error');
      }, 90_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      await until(`${marker} visible error`, async () => await frame.locator('.message.error').count() > errorsBefore);
      const visibleError = await frame.locator('.message.error').last().innerText(); assert.match(visibleError, expectedError);
      {
        await until('Unsupported profile native children exited', async () => {
          const observed = receipts().slice(selected.receiptStartIndex), invocations = observed.filter(value => value.event === 'invocation' && value.kind === 'app-server');
          return invocations.length > 0 && invocations.every(invocation => observed.some(value => value.event === 'exit' && value.wrapperPid === invocation.wrapperPid));
        });
      }
      const wire = receipts().slice(selected.receiptStartIndex);
      assert.ok(!wire.some(value => ['session', 'request', 'turn-started', 'turn-completed', 'tool-start', 'tool-result'].includes(value.event)));
      assert.ok(!wire.some(value => value.event === 'rpc-result' && value.method === 'initialize' && value.success));
      assert.ok(wire.some(value => value.event === 'stderr-summary' && value.runtimeOnlyProfileArgument === true));
      files(); verifyPreservedBase(manifest.fixture);
      await finishAttempt({ ...selected, marker, started, visibleError });
    }
    async function publicHistory(): Promise<any[]> {
      const before = (await events('conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      await frame.locator('#history-btn').click(); await until('Public stored history', async () => (await events('conversationHistory')).length > before);
      const result = (await events('conversationHistory')).at(-1).payload.conversations; await frame.locator('#history-btn').click(); return result;
    }
    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PB02_PROFILE_COMPATIBILITY_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.case, 'PB-02'); assert.strictEqual(manifest.stage, 'PROFILE_COMPATIBILITY_2');
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      assert.strictEqual(vscode.workspace.getConfiguration('mysti').get('codexProfile'), manifest.profileValidation.profiles.A.name); verifyOwnedProfiles(manifest.profileValidation);
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); assert.notStrictEqual((extension as any).isUnderDevelopment, true);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension)); await extension.activate();
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installCodexProfileCompatibilityObserver); }
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
      await frame.evaluate(installCodexProfileCompatibilityObserver); await frame.locator('#new-conversation-btn').click();
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
    it('explains unsupported named profiles and recovers only after explicit clears', async () => {
      const profiles = manifest.profileValidation;
      const diagnostic = "This Codex CLI cannot use named profiles with Mysti's app-server connection. Clear mysti.codexProfile in Settings and retry to use your base Codex configuration. No model request was submitted.";
      const expectedError = /^Error: This Codex CLI cannot use named profiles with Mysti's app-server connection\. Clear mysti\.codexProfile in Settings and retry to use your base Codex configuration\. No model request was submitted\.$/;
      const first = { configRaw: profiles.profiles.A.name, configReadback: vscode.workspace.getConfiguration('mysti').get('codexProfile'), selectedAt: Date.now(), receiptStartIndex: 0, inputCountBefore: 0 };
      assert.strictEqual(first.configReadback, profiles.profiles.A.name);
      await reject('UNSUPPORTED_A', first, expectedError);
      await send('DEFAULT_A', 'Run exactly cat README.md. State the fixture identity and the documented purpose in two sentences. Do not infer any runtime configuration values from your own identity.',
        { commands: ['cat README.md'] }, 'commandExecution', 'low', await selectProfile(''));
      await reject('UNSUPPORTED_PADDED_A', await selectProfile(`  ${profiles.profiles.A.name}  `), expectedError);
      await send('DEFAULT_RECOVERY', 'Without tools, repeat the same fixture identity and summarize the prior README purpose in one sentence. Do not claim to have loaded a named profile or inspected any new file or runtime setting.', {}, undefined, 'low', await selectProfile(''));
      verifyPreservedBase(manifest.fixture); verifyOwnedProfiles(profiles);
      const history = await publicHistory(), finalConversation = history.find(value => value.id === sourceId); assert.ok(finalConversation);
      for (const reply of replies) { assert.ok(finalConversation.messages.some((message: any) => message.id === reply.messageId && message.content === reply.content)); }
      assert.strictEqual(replies.length, 2); assert.strictEqual(attempts.length, 4); assert.strictEqual(receipts().filter(value => value.event === 'request').length, 2);
      for (const attempt of attempts.filter(value => value.marker.startsWith('UNSUPPORTED_'))) assert.strictEqual(attempt.visibleError, `Error: ${diagnostic}`);
      assert.ok(!receipts().some(value => /refusal|instrumentation-error|launch-error|unexpected-tool-item/.test(value.event)));
      const acceptance = { status: 'PASS_PROFILE_COMPATIBILITY_TRANSPORT', stage: manifest.stage, sourceId, panelId, replies, attempts, finalConversation,
        files: files(), preservedBase: manifest.fixture.base,
        counts: { completedTurns: 2, conversationalInputs: 2, publicUserAttempts: 4, rejectedAttempts: 2, auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length },
        scope: manifest.scope, semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
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
