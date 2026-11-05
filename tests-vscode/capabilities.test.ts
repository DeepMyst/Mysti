/** PC-12 bounded native controls/receipts. Ordinary installed product only. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { installCapabilitiesObserver } from './capabilities-observer';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const ids = ['claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot', 'cursor', 'openclaw', 'opencode', 'ollama', 'localai', 'qwen-code', 'hermes', 'continue', 'openrouter', 'minimax', 'kimi-code'];
if (process.env.MYSTI_PC12 === '1') {
  // Native campaign imports may resolve pinned local evidence; require opt-in first.
  const { assertCopilotPromptHistoryRequest, matchesPublicModelSelection, assertUnavailableCopilotModelAttempt, assertClaudePeerHandoff } = require('../scripts/validation/capabilities-request-oracle.cjs') as {
    assertCopilotPromptHistoryRequest: (request: any) => void; matchesPublicModelSelection: (evidence: any) => boolean; assertUnavailableCopilotModelAttempt: (evidence: any) => void; assertClaudePeerHandoff: (evidence: any) => void;
  };
  describe('PC-12 real editor capability truthfulness', function () {
    this.timeout(780_000);
    let manifest: any, owner: any, browser: Browser, workbench: Page, frame: Frame, sourceId: string, complete = false;
    const observations: any[] = [], approvals = new Set<string>();
    const replies: any[] = [], rejectedAttempts: any[] = [];
    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { event, at: Date.now(), ...details }; observations.push(entry);
      fs.writeFileSync(path.join(owner.directory, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-12]', JSON.stringify(entry));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 75)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    function receipts(): any[] {
      return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    }
    async function events(type?: string): Promise<any[]> {
      const values = await frame.evaluate(() => (globalThis as any).__pc12Events || []);
      return type ? values.filter((value: any) => value.type === type) : values;
    }
    function filesUnchanged(): void {
      const actualFiles: string[] = [];
      function visit(directory: string): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (directory === owner.workspace && entry.name === '.git') { continue; }
          const absolute = path.join(directory, entry.name);
          assert.ok(!entry.isSymbolicLink(), 'Unexpected symlink in owned fixture');
          if (entry.isDirectory()) { visit(absolute); } else { assert.ok(entry.isFile()); actualFiles.push(path.relative(owner.workspace, absolute)); }
        }
      }
      visit(owner.workspace);
      assert.deepStrictEqual(actualFiles.sort(), Object.keys(manifest.files).sort(), 'Exact owned workspace file tree outside Git metadata');
      for (const [relative, content] of Object.entries(manifest.files)) { assert.strictEqual(hash(fs.readFileSync(path.join(owner.workspace, relative))), hash(content as string), `${relative} bytes changed`); }
      assert.strictEqual(execFileSync('git', ['ls-files', '--stage'], { cwd: owner.workspace, encoding: 'utf8' }), manifest.originalIndex, 'Staged entry semantics unchanged');
      assert.strictEqual(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: owner.workspace, encoding: 'utf8' }), manifest.originalStatus, 'Tracked and untracked working tree status unchanged');
    }
    async function history(): Promise<any[]> {
      const before = (await events('conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      await frame.locator('#history-btn').click();
      await until('Public history reply', async () => (await events('conversationHistory')).length > before);
      const result = (await events('conversationHistory')).at(-1).payload.conversations;
      await frame.locator('#history-btn').click(); return result;
    }
    async function selectProvider(provider: string): Promise<void> {
      await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent=${JSON.stringify(provider)}]:not(.disabled)`).click();
      const label = provider === 'claude-code' ? 'Claude' : provider === 'openai-codex' ? 'Codex' : 'Copilot';
      await until('Provider selection visible', async () => (await frame.locator('#agent-name').innerText()).includes(label));
    }
    async function selectMode(mode: 'ask' | 'plan'): Promise<void> {
      await frame.locator('#behavior-indicator').click();
      const button = frame.locator(`#behavior-popup .mode-option[data-mode=${mode}]`); assert.strictEqual(await button.isEnabled(), true);
      await button.click();
      await until('Requested behavior visible', async () => (await frame.locator('#behavior-indicator').innerText()).toLowerCase().includes(mode));
    }
    async function selectModel(model: string, provider: string): Promise<void> {
      const changedBefore = (await events('modelChanged')).length;
      await frame.locator('#model-menu-btn').click();
      const option = frame.locator(`#model-menu-options [data-model=${JSON.stringify(model)}]`);
      if (await option.count()) { await option.click(); }
      else {
        await frame.locator('#model-menu-options [data-model="__custom__"]').click();
        const quick = workbench.locator('.quick-input-widget');
        await quick.waitFor({ state: 'visible' });
        assert.ok((await quick.innerText()).includes('Choose a custom model'), 'Public custom model input title');
        await quick.locator('input').fill(model); await quick.locator('input').press('Enter'); await quick.waitFor({ state: 'hidden' });
      }
      const selectionEvidence = async (): Promise<any> => ({ requestedProvider: provider, requestedModel: model,
        inlineValue: await frame.locator('#model-select-inline').inputValue().catch(() => ''),
        customInputValue: await frame.locator('#custom-model-input').inputValue(),
        menuLabel: await frame.locator('#model-menu-label').innerText(),
        hostSelectionEvents: (await events('modelChanged')).slice(changedBefore).map(value => ({ at:value.at,provider:value.payload?.provider,model:value.payload?.model,customModel:value.payload?.customModel })) });
      try {
        await until('Model selection persisted in public controls', async () => {
          const evidence = await selectionEvidence();
          return evidence.hostSelectionEvents.some((selection: any) => matchesPublicModelSelection({expectedProvider:provider,expectedModel:model,selection,inlineValue:evidence.inlineValue,customInputValue:evidence.customInputValue}));
        });
        record('model-selection-settled', await selectionEvidence());
      } catch (error) {
        record('model-selection-failed', await selectionEvidence()); throw error;
      }
    }
    async function controlSnapshot(provider: string): Promise<any> {
      await frame.locator('#model-menu-btn').click();
      const models = await frame.locator('#model-menu-options [data-model]').evaluateAll(elements => elements.map(element => ({ model: element.getAttribute('data-model'), selected: element.getAttribute('aria-pressed') === 'true', text: element.textContent })));
      const modelEffortVisible = await frame.locator('#model-menu [data-effort-control]').isVisible();
      const levels = await frame.locator('#effort-select-inline option').evaluateAll(elements => elements.map(element => element.getAttribute('value')));
      await frame.locator('#model-menu-btn').click(); await frame.locator('#tools-menu-btn').click();
      const toolsEffortVisible = await frame.locator('#tools-menu [data-effort-control]').isVisible();
      const enhance = { disabled: await frame.locator('#enhance-btn').isDisabled(), title: await frame.locator('#enhance-btn').getAttribute('title') };
      await frame.locator('#tools-menu-btn').click(); await frame.locator('#behavior-indicator').click();
      const modes = await frame.locator('#behavior-popup .mode-option').evaluateAll(elements => elements.map(element => ({ mode: element.getAttribute('data-mode'), disabled: (element as any).disabled, title: element.getAttribute('title') })));
      const hint = await frame.locator('#mode-capability-hint').innerText();
      await frame.locator('#behavior-indicator').click();
      const usage = { text: await frame.locator('#context-usage-text').innerText(), title: await frame.locator('#context-usage').getAttribute('title'), pie: await frame.locator('#context-pie-fill').getAttribute('d') };
      const value = { provider, models, modelEffortVisible, toolsEffortVisible, levels, enhance, modes, hint, usage };
      record('rendered-controls', value); return value;
    }
    async function approveRead(offset: number, expected: boolean): Promise<void> {
      for (const value of (await events()).slice(offset).filter(entry => entry.type === 'permissionRequest')) {
        const request = value.payload; if (approvals.has(request.id)) { continue; }
        const input = request.details?.toolInput || {}, name = String(request.details?.toolName || request.title || '').toLowerCase();
        const supplied = input.file_path || input.path || request.details?.filePath;
        const exactOwnedFile = typeof supplied === 'string' && path.resolve(owner.workspace, supplied) === path.join(owner.workspace, 'src/issues.cjs');
        const approved = expected && name === 'read' && exactOwnedFile;
        await frame.locator(`.permission-card[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        approvals.add(request.id); record('native-approval', { approved, name, exactOwnedFile });
        assert.ok(approved, 'Denied unexpected native permission outside the exact owned Read');
      }
    }
    async function send(marker: string, provider: string, model: string, task: string, read: boolean): Promise<any> {
      assert.ok(receipts().filter(value => value.event === 'request').length < 6, 'Six native input cap: five successful replies and one known explicit-model rejection');
      const offset = (await events()).length, started = Date.now();
      const prompt = `PC12_REQUEST:${marker}\n${task}\nThe requirement is to include open issues only. For inputs in order open, closed, triaged, derive the intended inclusion truth table and include PC12_TRUTH: followed by a JSON boolean array. Include the exact fixture token from the file/conversation. End with PC12_DONE:${marker}. Keep the answer under 110 words. ${read ? 'Use only the native file Read/view tool for the exact specified file. No shell, writes, external tools, or other files.' : 'Use only this conversation. No tools, files, shell commands, or changes.'}`;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      await until(`${marker} native completion`, async () => {
        await approveRead(offset, read && provider === 'claude-code');
        const fresh = (await events()).slice(offset);
        const errors = fresh.filter(value => ['error', 'authError', 'requestCancelled'].includes(value.type));
        if (errors.length) { record('native-error', { marker, errors }); throw new Error(`${marker}: real backend failed; no substitute or retry was dispatched`); }
        return fresh.some(value => value.type === 'responseComplete');
      }, 150_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(offset), terminal = fresh.filter(value => value.type === 'responseComplete');
      assert.strictEqual(terminal.length, 1); assert.strictEqual(fresh.filter(value => value.type === 'responseStarted').length, 1);
      const message = terminal[0].payload.message; assert.ok(message);
      assert.strictEqual(message.provider, provider); assert.strictEqual(message.model, model);
      assert.ok(message.content.includes(manifest.token), 'Read or remembered fixture token'); assert.ok(message.content.includes(`PC12_DONE:${marker}`));
      const truth = message.content.match(/PC12_TRUTH:\s*(\[[^\]]+\])/); assert.ok(truth, 'Derived semantic truth table required');
      assert.deepStrictEqual(JSON.parse(truth[1]), [true, false, false], 'Open-only semantics');
      const requests = receipts().filter(value => value.event === 'request' && value.at >= started - 250 && value.markers.includes(marker));
      assert.strictEqual(requests.length, 1); assert.strictEqual(requests[0].provider, provider); assert.strictEqual(requests[0].model, model);
      if (provider === 'github-copilot') {
        assertCopilotPromptHistoryRequest(requests[0]);
        assert.deepStrictEqual(requests[0].policy.denyTools.slice().sort(), ['shell', 'write']); assert.strictEqual(requests[0].policy.allowAllTools, false);
        assert.strictEqual(requests[0].policy.injectedNoAutoUpdate, true);
        assert.strictEqual(requests[0].policy.effort, model === 'auto' ? undefined : 'low');
        assert.strictEqual(fresh.filter(value => value.type === 'permissionRequest').length, 0, 'Copilot tool notifications must not masquerade as pre-execution consent');
      }
      const tools = message.toolCalls || [];
      if (read) {
        assert.ok(tools.length > 0, 'Actual requested native Read result required; missing result means incomplete');
        assert.ok(message.segments?.some((segment: any) => segment.type === 'tool'));
        for (const tool of tools) {
          assert.ok(['read', 'view'].includes(String(tool.name).toLowerCase()), 'Only assigned file read tool');
          assert.strictEqual(tool.status, 'completed');
          assert.strictEqual(path.resolve(owner.workspace, tool.input?.file_path || tool.input?.path || ''), path.join(owner.workspace, 'src/issues.cjs'));
          assert.ok(typeof tool.output === 'string' && tool.output.includes(manifest.token), 'Actual tool result includes owned source token');
        }
        if (provider === 'github-copilot') {
          const wire = receipts().filter(value => value.provider === provider && value.at >= started);
          assert.ok(wire.some(value => value.event === 'tool-start' && value.exactOwnedFile));
          assert.ok(wire.some(value => value.event === 'tool-result' && value.success === true && value.containsFixtureToken));
        }
      } else { assert.strictEqual(tools.length, 0); assert.strictEqual(fresh.filter(value => value.type === 'toolUse' || value.type === 'permissionRequest').length, 0); }
      const assistant = frame.locator('#messages .message.assistant').last(); assert.strictEqual(await assistant.getAttribute('data-provider'), provider);
      assert.ok((await assistant.locator('.message-content').allTextContents()).join('\n').includes(manifest.token));
      filesUnchanged();
      const proof = { marker, provider, model, id: message.id, content: message.content, request: requests[0], started, completedAt: terminal[0].at,
        nativePermissionRequests: fresh.filter(value => value.type === 'permissionRequest').length, toolCount: tools.length,
        tools: tools.map((tool: any) => ({ name: tool.name, status: tool.status, id: tool.id, outputSha256: hash(tool.output || '') })),
        usage: message.usage, segmentTypes: (message.segments || []).map((segment: any) => segment.type),
        actualModelCallReceipts: receipts().filter(value => value.provider === provider && value.event === 'model-call' && value.at >= started && value.at <= terminal[0].at).map(value => value.actualModel).filter(Boolean) };
      if (provider === 'github-copilot' && model !== 'auto') {
        assert.ok(proof.actualModelCallReceipts.every((actual: string) => actual === model), 'Emitted native actual model must match explicit request');
        record('explicit-model-attribution', { requestedModel: model, actualModelCallReceipts: proof.actualModelCallReceipts,
          attribution: proof.actualModelCallReceipts.length ? 'NATIVE_MODEL_CALL_CONFIRMED' : 'EXPLICIT_REQUEST_ACCEPTED; independent actual-model telemetry was not emitted' });
      }
      replies.push(proof); record('native-response', proof); return proof;
    }
    async function rejectUnavailableExplicitModel(model: string): Promise<void> {
      assert.ok(receipts().filter(value => value.event === 'request').length < 6, 'Six forwarded input cap');
      const marker = 'COPILOT_EXPLICIT_UNAVAILABLE', offset = (await events()).length, started = Date.now();
      await frame.locator('#message-input').fill(`PC12_REQUEST:${marker}\nUse only this conversation to state the original open-only requirement in one sentence. No tools, file access, commands, or changes. This is an explicit model availability check.`);
      await frame.locator('#send-btn').click();
      await until('Known explicit model availability rejection', async () => {
        const fresh = (await events()).slice(offset);
        await approveRead(offset, false);
        assert.ok(!fresh.some(value => ['responseComplete','toolUse','toolResult','authError','requestCancelled'].includes(value.type)), 'Expected unavailable-model attempt must not succeed, run tools, or fail for another reason');
        return fresh.some(value => value.type === 'error');
      }, 150_000);
      await frame.locator('#stop-btn').waitFor({state:'hidden'});
      const fresh = (await events()).slice(offset), failures = fresh.filter(value=>value.type==='error');
      assert.strictEqual(failures.length,1); assert.strictEqual(fresh.filter(value=>value.type==='responseStarted').length,1);
      assert.strictEqual(fresh.filter(value=>value.type==='responseComplete'||value.type==='permissionRequest'||value.type==='toolUse'||value.type==='toolResult').length,0);
      const rejectedAt = failures[0].at, errorText = failures[0].payload;
      assert.strictEqual(typeof errorText,'string');
      const requests = receipts().filter(value=>value.event==='request'&&value.at>=started&&value.markers.includes(marker));
      assert.strictEqual(requests.length,1);
      const nativeReceipts = receipts().filter(value=>value.provider==='github-copilot'&&value.at>=started&&value.at<=rejectedAt);
      assertUnavailableCopilotModelAttempt({request:requests[0],expectedModel:model,errorText,nativeReceipts});
      filesUnchanged();
      const proof = {marker,provider:'github-copilot',model,started,rejectedAt,errorText,request:requests[0],
        modelCallCount:nativeReceipts.filter(value=>value.event==='model-call').length,toolReceiptCount:nativeReceipts.filter(value=>value.event==='tool-start'||value.event==='tool-result').length,
        exitCodes:nativeReceipts.filter(value=>value.event==='exit').map(value=>value.exitCode),classification:'REJECTED_EXPLICIT_MODEL; no successful explicit inference claim'};
      rejectedAttempts.push(proof); record('explicit-model-rejected',proof);
    }
    function actualAutoModel(reply: any): string {
      const chosen = receipts().filter(value=>value.provider==='github-copilot'&&value.event==='auto-model-resolved'&&value.at>=reply.started&&value.at<=reply.completedAt).map(value=>value.chosenModel).filter(Boolean);
      if (new Set(chosen).size!==1||chosen[0]==='auto') {record('auto-attribution-incomplete',{marker:reply.marker,observedModelReceipts:chosen});throw new Error('INCOMPLETE: actual Auto identity is unproven');}
      assert.ok(reply.actualModelCallReceipts.every((actual:string)=>actual===chosen[0]),'Auto chosen model and emitted model-call receipts agree');
      record('auto-model-attribution',{marker:reply.marker,selectedModel:'auto',actualModel:chosen[0],source:'native session.auto_mode_resolved.data.chosenModel'});return chosen[0];
    }

    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PC12_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.case, 'PC-12'); assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      if ((extension as any).isUnderDevelopment !== undefined) { assert.strictEqual((extension as any).isUnderDevelopment, false); }
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension));
      for (const [relative, expected] of [['dist/extension.js', manifest.bundleSha256], ['media/chat/chat.js', manifest.chatSha256]]) { assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, relative))), expected); }
      await extension.activate();
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installCapabilitiesObserver); }
      for (const page of browser.contexts().flatMap(context => context.pages())) { if (await page.locator('.monaco-workbench').count()) { workbench = page; break; } }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      const oldFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('New actual chat mounts', async () => {
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (oldFrames.has(candidate)) { continue; }
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { candidates.push(candidate); } } catch { /* Mounting. */ }
        }
        if (candidates.length !== 1) { return false; } frame = candidates[0]; return true;
      });
      await workbench.bringToFront();
      if (await frame.locator('.wizard-skip-btn').isVisible()) { await frame.locator('.wizard-skip-btn').click(); }
      await frame.evaluate(installCapabilitiesObserver);
      await frame.locator('#message-input').click();
      await frame.locator('#new-conversation-btn').click();
      await until('New conversation identity', async () => (await events('conversationChanged')).length > 0);
      sourceId = (await events('conversationChanged')).at(-1).payload.id;
      await until('Actual manifest observed', async () => (await events('manifestObserved')).length > 0);
      filesUnchanged(); record('identity', { sourceId, profile: owner.profile, workspace: owner.workspace, extensionHostPid: process.pid,
        productUnderDevelopment: (extension as any).isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API', extensionTestsPathUsed: false, bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256, scope: manifest.scope });
    });

    it('matches public capabilities to three real backends and rejects unsupported authority before dispatch', async () => {
      const actualManifest = (await events('manifestObserved')).at(-1);
      assert.strictEqual(actualManifest.payload.schemaVersion, 1);
      assert.deepStrictEqual(actualManifest.payload.providers.map((value: any) => value.id).sort(), ids.slice().sort());
      const options = await frame.locator('#provider-select option').evaluateAll(elements => elements.map(element => element.getAttribute('value')));
      assert.deepStrictEqual(options.slice().sort(), [...ids, 'mysti', 'brainstorm'].sort());
      await frame.locator('#agent-select-btn').click();
      const menu = await frame.locator('#agent-menu .agent-menu-item[data-agent]').evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-agent'), disabled: element.classList.contains('disabled'), text: element.textContent, title: element.getAttribute('title') })));
      assert.ok(!menu.some((value: any) => value.id === 'manus')); assert.ok(menu.some((value: any) => value.id === 'mysti')); assert.ok(menu.some((value: any) => value.id === 'brainstorm'));
      await frame.locator('#agent-select-btn').click();
      record('actual-provider-manifest', { source: actualManifest.source, manifest: actualManifest.payload, menu, renderedProviderOptionIds: options });
      const caps = (id: string): any => actualManifest.payload.providers.find((value: any) => value.id === id).capabilities;
      assert.notStrictEqual(caps('github-copilot').supportsNativeApproval, true); assert.strictEqual(caps('github-copilot').emitsUsage, false);
      assert.strictEqual(caps('github-copilot').sessionKind, 'prompt-history');
      const issuePath = path.join(owner.workspace, 'src/issues.cjs');
      await selectProvider('claude-code'); await selectMode('ask'); await selectModel('sonnet', 'claude-code');
      await send('CLAUDE_READ', 'claude-code', 'sonnet', `Read exactly ${issuePath}. Diagnose the filter bug against the open-only requirement and propose the smallest predicate correction.`, true);
      const claudeControls = await controlSnapshot('claude-code'); assert.notStrictEqual(claudeControls.usage.text, 'n/a');
      await selectProvider('openai-codex'); await selectModel('gpt-5.6-sol', 'openai-codex');
      await send('CODEX_REVIEW', 'openai-codex', 'gpt-5.6-sol', 'Review Claude’s proposed open-only correction using the existing conversation. Explain a regression input that fails before the fix and passes afterward.', false);
      await controlSnapshot('openai-codex');
      await selectProvider('github-copilot'); await selectModel('auto', 'github-copilot');
      const autoControls = await controlSnapshot('github-copilot');
      assert.strictEqual(autoControls.modelEffortVisible, false); assert.strictEqual(autoControls.toolsEffortVisible, false);
      assert.ok(autoControls.modes.find((value: any) => value.mode === 'ask')?.disabled); assert.ok(autoControls.modes.find((value: any) => value.mode === 'auto')?.disabled);
      assert.ok(autoControls.hint.trim(), 'Persisted unsupported Ask must show an explanation');
      const beforeNegative = receipts().filter(value => value.event === 'request').length, negativeOffset = (await events()).length;
      await frame.locator('#message-input').fill('PC12_REQUEST:UNSUPPORTED_ASK\nExplain the current issue without tools. This submission checks the selected Ask authority.'); await frame.locator('#send-btn').click();
      await until('Actual unsupported Ask preflight error', async () => (await events()).slice(negativeOffset).some(value => value.type === 'error'));
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, beforeNegative);
      const rejected = (await events()).slice(negativeOffset); assert.ok(!rejected.some(value => value.type === 'responseComplete'));
      assert.ok(rejected.some(value => value.type === 'error' && /cannot request approval|does not support.*approval|unsupported.*permission/i.test(typeof value.payload === 'string' ? value.payload : JSON.stringify(value.payload))), 'The failure must identify unsupported approval authority');
      record('unsupported-ask-rejected', { forwardedConversationInputs: 0, errors: rejected.filter(value => value.type === 'error').map(value => value.payload), preservedMode: await frame.locator('#behavior-indicator').innerText() });
      await selectMode('plan');
      const auto = await send('COPILOT_AUTO', 'github-copilot', 'auto', 'Independently review the prior agents’ diagnosis. Keep the same open-only requirement and give one concise regression test description.', false);
      const unknown = await controlSnapshot('github-copilot'); assert.strictEqual(unknown.usage.text, 'n/a'); assert.strictEqual(unknown.usage.pie, ''); assert.ok(/unknown|does not report/i.test(unknown.usage.title));
      const actualModel = actualAutoModel(auto);
      const explicitCandidate = manifest.explicitCopilotModel;
      assert.strictEqual(explicitCandidate.id, 'gpt-5.4'); assert.strictEqual(explicitCandidate.sourceKind, 'PUBLIC_PINNED_CLI_HELP_CONFIG_CATALOG');
      assert.strictEqual(hash(fs.readFileSync(explicitCandidate.sourceArtifact)), explicitCandidate.sourceSha256);
      record('explicit-model-candidate', { ...explicitCandidate, autoActualModel: actualModel, accountAvailability: 'KNOWN_REJECTION_IN_PRIOR_NATIVE_ATTEMPT; verify current error and public recovery' });
      await selectModel(explicitCandidate.id, 'github-copilot');
      const explicit = await controlSnapshot('github-copilot'); assert.strictEqual(explicit.modelEffortVisible, true); assert.strictEqual(explicit.toolsEffortVisible, true); assert.ok(explicit.levels.includes('low'));
      await frame.locator('#model-menu-btn').click();
      const slider = frame.locator('#model-menu-effort-slider'); await slider.focus(); await slider.press('Home');
      for (let index = 0; index < explicit.levels.indexOf('low'); index++) { await slider.press('ArrowRight'); }
      await frame.locator('#model-menu-btn').click();
      await rejectUnavailableExplicitModel(explicitCandidate.id);
      await selectModel('auto','github-copilot');
      const recoveredControls = await controlSnapshot('github-copilot'); assert.strictEqual(recoveredControls.modelEffortVisible,false); assert.strictEqual(recoveredControls.toolsEffortVisible,false);
      const recovered = await send('COPILOT_AUTO_READ','github-copilot','auto',`Recover after the unavailable explicit model by using Auto. Read exactly ${issuePath} using your native read/view tool. Confirm the bug and propose the exact corrected function in a fenced code block. Label this proposal with the review tag ${manifest.handoffToken}. Do not apply the patch.`,true);
      assert.ok(recovered.content.includes(manifest.handoffToken), 'Copilot must introduce its review tag');
      const recoveryActualModel = actualAutoModel(recovered);
      await selectProvider('claude-code'); await selectMode('ask'); await selectModel('sonnet', 'claude-code');
      const claudeReturn = await send('CLAUDE_RETURN', 'claude-code', 'sonnet', 'Review Copilot’s proposed patch and the prior regression discussion. Quote the review tag from Copilot’s proposal. Confirm the original open-only requirement still holds, explain why triaged is excluded, and state the exact predicate.', false);
      assertClaudePeerHandoff({ request: claudeReturn.request, content: claudeReturn.content, handoffToken: manifest.handoffToken });
      const returned = await controlSnapshot('claude-code'); assert.notStrictEqual(returned.usage.text, 'n/a');
      const final = (await history()).find(value => value.id === sourceId); assert.ok(final);
      assert.strictEqual(final.messages.filter((value: any) => value.role === 'assistant').length, 5);
      assert.deepStrictEqual(final.messages.filter((value: any) => value.role === 'assistant').map((value: any) => value.provider), ['claude-code', 'openai-codex', 'github-copilot', 'github-copilot', 'claude-code']);
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, 6); assert.strictEqual(rejectedAttempts.length,1); filesUnchanged();
      fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify({ status: 'PASS_BOUNDED_ERROR_RECOVERY', sourceId, manifest: actualManifest.payload, replies, rejectedAttempts, actualCopilotAutoModel: actualModel, actualCopilotRecoveryModel: recoveryActualModel, explicitCopilotModel: explicitCandidate,
        negativeUnsupportedAskInputs: 0, conversationInputs: 6, successfulReplies:5, rejectedExplicitAttempts:1, validExplicitInference:'UNRUN_SERVICE_LIMITED', copilotPromptHistoryOmitsNativeResume: true, auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length,
        finalMessageIds: final.messages.map((value: any) => value.id), finalAssistantProviders: final.messages.filter((value: any) => value.role === 'assistant').map((value: any) => value.provider),
        fixtureUnchanged: true, productWorkspaceArtifactsOutsideGit: [], gitMetadataExcluded: 'Mysti checkpoint writes and Git stat cache may change Git metadata; developer files, complete file tree, status, and staged entries must match', semanticTruthTables: 'all five derive [true,false,false]', semanticPatchReview: 'ROOT_REVIEW_REQUIRED', scope: manifest.scope }, null, 2));
      complete = true; record('acceptance-complete', { conversationInputs: 6,successfulReplies:5,rejectedExplicitAttempts:1,negativeUnsupportedAskInputs:0,validExplicitInference:'UNRUN_SERVICE_LIMITED' });
    });
    after(async () => {
      if (!complete && owner) {
        await workbench?.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {});
        if (frame) { const safeEvents = (await events()).filter(value => ['error', 'authError', 'requestCancelled'].includes(value.type)); fs.writeFileSync(path.join(owner.directory, 'failure-events.json'), JSON.stringify(safeEvents, null, 2)); }
      }
      await browser?.close().catch(() => {});
    });
  });
}
