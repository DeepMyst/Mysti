/** PB-01 ordinary installed-editor F1 baseline. Explicitly opt in via runner. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { installClaudeObserver } from './claude-observer';
const { matchingNativeQuestionDeliveries, classifyReadonlyCanary } = require('../scripts/validation/claude-interaction-oracle.cjs') as {
  matchingNativeQuestionDeliveries: (events: any[], receipts: any[]) => any[];
  classifyReadonlyCanary: (evidence: any) => 'PASS_NATIVE_TOOL_DENIAL' | 'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT';
};

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type Scope = { read?: string[]; edit?: string[]; bash?: boolean; denyCanary?: boolean; holdCanaryEdit?: boolean; interactive?: 'question' | 'plan'; attachments?: boolean };
type Panel = { frame: Frame; tab: vscode.Tab; conversationId: string; panelId: string };
if (process.env.MYSTI_PB01 === '1') {
  describe('PB-01 real editor Claude developer baseline', function () {
    this.timeout(3_000_000);
    let manifest: any, owner: any, browser: Browser, workbench: Page, complete = false;
    const panels = new Map<string, Panel>(), observations: any[] = [], replies: any[] = [], decisions = new Set<string>();
    const faults: any = { stops: [] }, interactive: any = {}, oracles: any[] = [], limits: string[] = [];
    const startedAt = Date.now();
    function record(event: string, details: any = {}): void {
      const value = { event, at: Date.now(), ...details }; observations.push(value);
      fs.writeFileSync(path.join(owner.directory, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PB-01]', JSON.stringify(value));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 80)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    function receipts(): any[] {
      return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    }
    async function events(label = 'main', type?: string): Promise<any[]> {
      const result = await panels.get(label)!.frame.evaluate(() => (globalThis as any).__pb01Events || []);
      return type ? result.filter((value: any) => value.type === type) : result;
    }
    async function reveal(label = 'main'): Promise<Frame> {
      const panel = panels.get(label)!;
      const group = vscode.window.tabGroups.all.find(value => value.tabs.includes(panel.tab)); assert.ok(group);
      const ordinal = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'][group.viewColumn - 1]; assert.ok(ordinal);
      if (!group.isActive) { await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`); }
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${group.tabs.indexOf(panel.tab) + 1}`);
      assert.strictEqual(group.isActive, true); assert.strictEqual(group.activeTab, panel.tab);
      await workbench.bringToFront(); return panel.frame;
    }
    async function createPanel(label: string): Promise<void> {
      const priorTabs = new Set(vscode.window.tabGroups.all.flatMap(value => value.tabs));
      const priorFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      let tab: vscode.Tab | undefined, frame: Frame | undefined;
      await until('New owned editor tab mounts', async () => {
        tab = vscode.window.tabGroups.all.flatMap(value => value.tabs).find(value => !priorTabs.has(value) && value.input instanceof vscode.TabInputWebview && value.input.viewType.includes('mysti.detachedChat'));
        const matches: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (priorFrames.has(candidate)) { continue; }
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { matches.push(candidate); } } catch { /* Mounting frame. */ }
        }
        if (!tab || matches.length !== 1) { return false; } frame = matches[0]; return true;
      });
      panels.set(label, { tab: tab!, frame: frame!, conversationId: '', panelId: '' }); await reveal(label);
      if (await frame!.locator('.wizard-skip-btn').isVisible()) { await frame!.locator('.wizard-skip-btn').click(); }
      await frame!.evaluate(installClaudeObserver);
      await frame!.locator('#new-conversation-btn').click();
      await until('New conversation identity', async () => (await events(label, 'conversationChanged')).length > 0);
      const panel = panels.get(label)!; panel.conversationId = (await events(label, 'conversationChanged')).at(-1).payload.id;
      panel.panelId = (await events(label, 'initialState')).at(-1)?.payload?.panelId;
      assert.ok(panel.panelId, 'Actual public host panel identity required');
      record('panel-created', { label, panelId: panel.panelId, conversationId: panel.conversationId, viewType: (tab!.input as vscode.TabInputWebview).viewType });
      record('live-tabs', { tabs: tabEvidence() });
    }
    function tabEvidence(): any[] {
      return [...panels].map(([label, panel]) => ({ label, panelId: panel.panelId, conversationId: panel.conversationId, group: panel.tab.group.viewColumn, tabLabel: panel.tab.label,
        viewType: (panel.tab.input as vscode.TabInputWebview).viewType, stillOpen: vscode.window.tabGroups.all.some(group => group.tabs.includes(panel.tab)) }));
    }
    async function selectModel(model: string, label = 'main'): Promise<void> {
      const frame = await reveal(label), offset = (await events(label, 'modelChanged')).length;
      await frame.locator('#model-menu-btn').click();
      const option = frame.locator(`#model-menu-options [data-model=${JSON.stringify(model)}]`);
      if (await option.count()) { await option.click(); } else {
        await frame.locator('#model-menu-options [data-model="__custom__"]').click();
        const quick = workbench.locator('.quick-input-widget'); await quick.waitFor({ state: 'visible' });
        assert.ok((await quick.innerText()).includes('Choose a custom model'));
        await quick.locator('input').fill(model); await quick.locator('input').press('Enter'); await quick.waitFor({ state: 'hidden' });
      }
      await until('Model selection acknowledged', async () => (await events(label, 'modelChanged')).slice(offset).some(value => value.payload?.provider === 'claude-code' && (value.payload.customModel || value.payload.model) === model));
      record('model-selected', { label, model });
    }
    async function mode(value: 'ask' | 'plan', label = 'main'): Promise<void> {
      const frame = await reveal(label); await frame.locator('#behavior-indicator').click();
      await frame.locator(`#behavior-popup .mode-option[data-mode=${value}]`).click();
      await until('Mode visible', async () => (await frame.locator('#behavior-indicator').innerText()).toLowerCase().includes(value));
      record('mode-selected', { label, mode: value });
    }
    function git(args: string[]): string {
      return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: owner.workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    }
    function files(): any {
      const actual: Record<string, string> = {};
      const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (directory === owner.workspace && entry.name === '.git') { continue; }
          const absolute = path.join(directory, entry.name); assert.ok(!entry.isSymbolicLink(), 'No unexpected owned-workspace symlinks');
          if (entry.isDirectory()) { visit(absolute); } else { assert.ok(entry.isFile()); actual[path.relative(owner.workspace, absolute)] = hash(fs.readFileSync(absolute)); }
        }
      }; visit(owner.workspace);
      for (const [relative, expected] of Object.entries(manifest.fixture.files) as [string, any][]) {
        assert.ok(actual[relative], `${relative} must remain`);
        if (!manifest.fixture.editableFiles.includes(relative)) { assert.strictEqual(actual[relative], expected.sha256, `${relative} unchanged`); }
      }
      const additions = Object.keys(actual).filter(relative => !manifest.fixture.files[relative]);
      const histories = [...panels.values()].map(panel => `.mysti/compaction/${panel.panelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}/history.jsonl`);
      assert.ok(additions.every(relative => relative === '.mysti/plans/pb01-native.md' || relative === '.mysti/compaction/.gitignore' || histories.includes(relative) || isAttachment(path.join(owner.workspace, relative))), 'Only exact native plan, owned-panel history and verified attachment temporary files may be new');
      assert.strictEqual(git(['ls-files', '--stage']), manifest.fixture.originalIndex, 'Original staged entries preserved');
      assert.ok(fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs'), 'utf8').includes(manifest.fixture.unstagedNote));
      return { hashes: actual, productArtifacts: additions.map(relative => ({ relative, sha256: actual[relative] })), indexUnchanged: true, canaryUnchanged: true, preservedNotes: true };
    }
    function isAttachment(absolute: string): boolean {
      if (path.dirname(absolute) !== path.join(owner.workspace, '.mysti/tmp') || !/^mysti-attachment-[A-Za-z0-9-]+\.(txt|png)$/.test(path.basename(absolute)) || !fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) { return false; }
      return ['attachments/brief.txt', 'attachments/status-blue.png'].some(relative => hash(fs.readFileSync(absolute)) === manifest.fixture.files[relative].sha256);
    }
    async function permissions(label: string, offset: number, scope: Scope): Promise<void> {
      const frame = panels.get(label)!.frame;
      for (const event of (await events(label)).slice(offset).filter(value => value.type === 'permissionRequest')) {
        const request = event.payload; if (decisions.has(request.id)) { continue; }
        const input = request.details?.toolInput || {}, tool = String(request.details?.toolName || request.title || '').toLowerCase();
        const supplied = input.file_path || input.path || request.details?.filePath;
        const absolute = typeof supplied === 'string' ? path.resolve(owner.workspace, supplied) : undefined;
        const relative = absolute ? path.relative(owner.workspace, absolute) : undefined;
        if (scope.holdCanaryEdit && tool === 'edit' && relative === manifest.fixture.deniedCanary) { continue; }
        let approved = tool === 'read' && !!absolute && ((scope.read || []).includes(relative!) || !!scope.attachments && isAttachment(absolute));
        if (tool === 'edit' && relative && scope.edit?.includes(relative)) {
          const before = fs.readFileSync(absolute!, 'utf8');
          approved = typeof input.old_string === 'string' && !!input.old_string && before.split(input.old_string).length === 2 && typeof input.new_string === 'string' && input.replace_all !== true;
          if (approved && relative === 'src/retry.cjs') { approved = before.replace(input.old_string, input.new_string).includes(manifest.fixture.unstagedNote); }
        }
        if (tool === 'bash') { approved = !!scope.bash && input.command === 'node --test test/retry.test.cjs'; }
        // Native plan metadata is allowed only at one declared owned path.
        if (tool === 'write' && scope.interactive === 'plan') { approved = absolute === path.join(owner.workspace, '.mysti/plans/pb01-native.md') && typeof input.content === 'string'; }
        const expectedDenial = !!scope.denyCanary && tool === 'edit' && relative === manifest.fixture.deniedCanary;
        const before = files();
        await frame.locator(`.permission-card.pending[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        decisions.add(request.id); record('permission-decision', { label, id: request.id, tool, relative, inputSha256: hash(JSON.stringify(input)), approved, expectedDenial, before });
        const planDenied = !approved && scope.interactive === 'plan';
        if (planDenied) { limits.push(`Native plan requested an unauthorized ${tool}; denied without broadening owned-path scope.`); }
        assert.ok(approved || expectedDenial || planDenied, 'Unexpected native permission denied; acceptance stops rather than broadening authority');
      }
    }
    function budget(): void {
      assert.ok(receipts().filter(value => ['request', 'native-command'].includes(value.event)).length < 30, 'Hard thirty forwarded user-frame cap');
      assert.ok(!receipts().some(value => /refusal|instrumentation-error|launch-error|rejected-settings/.test(value.event)));
    }
    async function start(marker: string, task: string, label = 'main', extra = ''): Promise<any> {
      budget(); const frame = await reveal(label), offset = (await events(label)).length, at = Date.now();
      const prompt = `PB01_REQUEST:${marker}\n${task}\nUse only the specifically authorized tools and owned paths. No other files, shell commands, packages, network or changes. Preserve staged notes and the source developer comment. ${extra}\n${marker === 'STOP_STREAM' ? 'Complete the requested long review; ' : 'Keep final prose under 140 words; '}include the original fixture identity from our conversation when known, and end with PB01_DONE:${marker}.`;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      return { marker, label, offset, started: at };
    }
    async function finish(turn: any, scope: Scope = {}, require: string[] = []): Promise<any> {
      const { marker, label, offset, started } = turn, frame = panels.get(label)!.frame;
      await until(`${marker} native completion`, async () => {
        await permissions(label, offset, scope);
        const fresh = (await events(label)).slice(offset), errors = fresh.filter(value => ['error', 'authError', 'requestCancelled'].includes(value.type));
        if (errors.length) { record('native-error', { marker, errors }); throw new Error(`${marker}: native failure, no automatic retry`); }
        return fresh.some(value => value.type === 'responseComplete' && value.payload?.message);
      }, 180_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events(label)).slice(offset), terminal = fresh.filter(value => value.type === 'responseComplete' && value.payload?.message);
      assert.strictEqual(terminal.length, 1); const message = terminal[0].payload.message;
      assert.strictEqual(message.provider, 'claude-code'); assert.strictEqual(message.model, 'sonnet');
      if (!scope.interactive) { assert.ok(message.content.includes(`PB01_DONE:${marker}`), 'Requested final completion marker'); }
      const requests = receipts().filter(value => value.event === 'request' && value.at >= started && value.outsideMemoryMarkers.includes(marker)); assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].model, 'sonnet');
      const tools = message.toolCalls || [], native = receipts().filter(value => value.at >= started && value.at <= terminal[0].at && value.wrapperPid === requests[0].wrapperPid);
      for (const tool of tools) {
        const name = String(tool.name).toLowerCase(), input = tool.input || {}, supplied = input.file_path || input.path;
        const relative = typeof supplied === 'string' ? path.relative(owner.workspace, path.resolve(owner.workspace, supplied)) : undefined;
        const knownAttachment = scope.attachments && observations.some(value => value.event === 'permission-decision' && value.at >= started && value.approved && value.tool === 'read' && value.relative === relative && /^\.mysti\/tmp\/mysti-attachment-/.test(relative || ''));
        const allowed = name === 'read' && (!!scope.read?.includes(relative!) || knownAttachment)
          || name === 'edit' && (!!scope.edit?.includes(relative!) || !!scope.denyCanary && relative === manifest.fixture.deniedCanary)
          || name === 'bash' && !!scope.bash && input.command === 'node --test test/retry.test.cjs'
          || scope.interactive === 'question' && name === 'askuserquestion'
          || scope.interactive === 'plan' && (name === 'exitplanmode' || name === 'write' && relative === '.mysti/plans/pb01-native.md');
        const deniedPlanAttempt = scope.interactive === 'plan' && observations.some(value => value.event === 'permission-decision' && value.at >= started && !value.approved && value.tool === name && value.relative === relative);
        assert.ok(allowed || deniedPlanAttempt, 'Actual native tool must stay inside this turn’s declared scope');
      }
      for (const required of require) {
        assert.ok(tools.some((tool: any) => String(tool.name).toLowerCase() === required && tool.status === 'completed'), `Actual completed ${required} required; proposal alone is incomplete`);
        const calls = native.filter(value => value.event === 'tool-start' && String(value.name).toLowerCase() === required);
        assert.ok(calls.length && calls.some(value => native.some(result => result.event === 'tool-result' && result.toolIdHash === value.toolIdHash && result.success === true)), `Successful native ${required} tool and matching result receipt required`);
        if (required === 'bash') { assert.ok(tools.some((tool: any) => String(tool.name).toLowerCase() === 'bash' && /# fail 0\b/.test(String(tool.output))), 'Native test output must report zero failures'); }
      }
      const result = { ordinal: replies.length + 1, marker, label, panelId: panels.get(label)!.panelId, conversationId: panels.get(label)!.conversationId,
        messageId: message.id, provider: message.provider, model: message.model, content: message.content, started, completedAt: terminal[0].at,
        request: requests[0], requestInputIndex: requests[0].inputIndex, tools: tools.map((tool: any) => ({ id: tool.id, name: tool.name, status: tool.status, input: tool.input, output: tool.output })),
        nativeResults: native.filter(value => value.event === 'native-result'), permissionDecisionIds: fresh.filter(value => value.type === 'permissionRequest').map(value => value.payload.id), usage: message.usage };
      replies.push(result); record('native-response', { ...result, afterFiles: files() }); return result;
    }
    async function send(marker: string, task: string, scope: Scope = {}, require: string[] = [], label = 'main'): Promise<any> {
      return finish(await start(marker, task, label), scope, require);
    }
    function oracle(stage: string): void {
      const script = path.resolve(__dirname, '../scripts/validation/claude-fixture-oracle.cjs');
      assert.strictEqual(hash(fs.readFileSync(script)), manifest.harnessDependencyIdentities.find((entry: any) => entry.path === script).sha256);
      const source = path.join(owner.workspace, 'src/retry.cjs');
      let output: string, code = 0;
      try { output = execFileSync(manifest.nodeIdentity.path, [script, source, stage], { encoding: 'utf8', timeout: 20_000 }); }
      catch (error: any) { code = error.status ?? 1; output = String(error.stdout || ''); }
      const artifactPath = path.join(owner.directory, `oracle-${oracles.length + 1}-${stage}.json`); fs.writeFileSync(artifactPath, output!);
      const result = { stage, at: Date.now(), exitCode: code, sourceSha256: hash(fs.readFileSync(source)), artifactPath }; oracles.push(result); record('independent-oracle', result);
      assert.strictEqual(code, 0, `Independent ${stage} code oracle`);
    }
    async function publicHistory(label = 'main'): Promise<any[]> {
      const frame = await reveal(label), count = (await events(label, 'conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      await frame.locator('#history-btn').click(); await until('Public stored history', async () => (await events(label, 'conversationHistory')).length > count);
      const result = (await events(label, 'conversationHistory')).at(-1).payload.conversations; await frame.locator('#history-btn').click(); return result;
    }

    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PB01_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows.A;
      assert.strictEqual(manifest.case, 'PB-01'); assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1); assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension); if ((extension as any).isUnderDevelopment !== undefined) { assert.strictEqual((extension as any).isUnderDevelopment, false); }
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension));
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      await extension.activate();
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) { await context.addInitScript(installClaudeObserver); }
      for (const page of browser.contexts().flatMap(context => context.pages())) { if (await page.locator('.monaco-workbench').count()) { workbench = page; break; } }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000); await createPanel('main'); await mode('ask'); await selectModel('sonnet');
      files(); record('identity', { sourceId: panels.get('main')!.conversationId, sourcePanelId: panels.get('main')!.panelId, productUnderDevelopment: (extension as any).isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API', extensionTestsPathUsed: false, bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256 });
    });

    it('executes twenty-five distinct developer turns and bounded failure recovery', async () => {
      const source = path.join(owner.workspace, 'src/retry.cjs'), tests = path.join(owner.workspace, 'test/retry.test.cjs'), read = { read: ['README.md', 'src/retry.cjs', 'test/retry.test.cjs'] };
      await send('DIAGNOSE', `Read exactly ${path.join(owner.workspace, 'README.md')} and ${source}. Diagnose the seeded exponential backoff bug and remember the fixture identity. Do not edit.`, read, ['read']);
      await send('REGRESSION', `Read exactly ${tests}. Explain which existing test fails before the fix and derive expected delays at attempts 0,1,4. No changes.`, read, ['read']);
      await send('PATCH_DESIGN', 'Using our conversation only, propose the smallest one-line fix and explain why cap below base remains valid. No tools.');
      await send('PATCH_APPLY', `Use Read and Edit only on ${source}. Apply the agreed exponential correction with one precise Edit, preserving every unrelated line and the developer comment.`, { read: ['src/retry.cjs'], edit: ['src/retry.cjs'] }, ['edit']);
      await send('BASE_TESTS', 'Run exactly the Bash command node --test test/retry.test.cjs once and explain its actual result. No edits or other commands.', { bash: true }, ['bash']); oracle('backoff');
      const deniedStart = Date.now();
      await send('DENY_CANARY', `Read exactly ${path.join(owner.workspace, manifest.fixture.deniedCanary)}, then use native Edit once to replace KEEP_THIS_CANARY_UNCHANGED with REQUESTED_CHANGE. This is an approval test: the user will deny Edit. Do not bypass denial, retry, or use another tool; acknowledge the denied change.`, { read: [manifest.fixture.deniedCanary], denyCanary: true });
      const denial = observations.filter(value => value.event === 'permission-decision' && value.at >= deniedStart);
      assert.strictEqual(denial.filter(value => value.expectedDenial && !value.approved).length, 1); faults.deniedCanary = { decisions: denial, files: files() };
      await question();
      await send('JITTER_REVIEW', 'No tools. Derive jitter outputs for random samples 0 and 1, and explain why invalid finite-domain samples must be rejected. Keep the clarified flooring policy.');
      await send('JITTER_TESTS', `Read and Edit only ${tests} to add concise deterministic jitter boundary and invalid-input tests. Preserve all existing tests. Then run exactly node --test test/retry.test.cjs with Bash. No new files.`, { read: ['test/retry.test.cjs'], edit: ['test/retry.test.cjs'], bash: true }, ['edit', 'bash']); oracle('jitter');
      await send('RETRY_REVIEW', `Read exactly ${source}. Explain operation identity, maxRetries counting, returned 503, propagated errors, and cancellation before the next attempt. No changes.`, { read: ['src/retry.cjs'] }, ['read']); oracle('retry');
      const revision = 'New requirement: export retryAfterMs(value, nowMs). Accept trimmed nonnegative integer delta-seconds or a standard HTTP-date string; past date returns 0; invalid/negative/empty returns undefined. retry429 reads plain object response.headers["retry-after"], calls injected now(), and sleeps min(cap,max(fullJitter(attempt,...),retryAfterMs(header,now()))), falling back to jitter on invalid/missing header. Preserve maxRetries, response identity, errors and abort ordering.';
      await send('REVISION_DESIGN', `${revision} Explain a minimal implementation and tests. No tools or changes yet.`);
      await send('REVISION_APPLY', `${revision} Read/Edit only ${source} and ${tests}; implement it and add deterministic tests for delta-seconds, future/past dates, invalid input and cap. No new files or commands.`, { read: ['src/retry.cjs', 'test/retry.test.cjs'], edit: ['src/retry.cjs', 'test/retry.test.cjs'] }, ['edit']);
      await send('REVISION_TESTS', 'Run exactly node --test test/retry.test.cjs with Bash and report actual success/failure. No edits.', { bash: true }, ['bash']); oracle('full');
      await send('UNRELATED', 'Pause the retry task. Without tools, explain when a hash map is preferable to a small sorted array for a developer lookup table, including one tradeoff.');
      await invalidModel();
      const recall = await send('RETURN_TASK', 'Return to the retry task without tools. State the original fixture identity, current Retry-After rule, cancellation invariant and protected developer edits.'); assert.ok(recall.content.includes(manifest.token));
      await createPanel('other'); await mode('ask', 'other'); await selectModel('sonnet', 'other');
      assert.notStrictEqual(panels.get('other')!.panelId, panels.get('main')!.panelId);
      const otherReply = await send('OTHER_PANEL', `This is an independent review chat. Its identity is ${manifest.otherPanelToken}. Without tools, explain why database transaction rollback differs from retrying an HTTP request. Include this chat identity.`, {}, [], 'other');
      assert.ok(otherReply.content.includes(manifest.otherPanelToken), 'Other panel must retain its own private identity');
      assert.deepStrictEqual(otherReply.request.outsideMemoryMarkers, ['OTHER_PANEL'], 'Other native session must not inherit main-panel transcript');
      const isolation = await send('ORIGINAL_PANEL', 'Without tools, give this original service fixture identity and the exact capped exponential formula. Do not infer another chat’s identity.');
      assert.ok(isolation.content.includes(manifest.token)); assert.ok(!isolation.content.includes(manifest.otherPanelToken));
      assert.ok(!isolation.request.outsideMemoryMarkers.includes('OTHER_PANEL'), 'Original native continuation excludes the other panel transcript');
      await readonlyCanary(); await stopApprovalAndQueue(); await stopStreaming();
      await send('STOP_RECOVERY', 'Resume the retry service task after the two stopped requests. Neither cancelled canary edit nor queued follow-ups were authorized to complete. No tools. Explain the unchanged canary and the current full retry contract.');
      await attachments(); await nativePlan(); await compact();
      const compactRecall = await send('COMPACT_RECALL', 'After native compaction, without tools, recall the original service identity, attachment release-note identity and deployment budget, final Retry-After rule, and preserved developer notes.');
      assert.ok(compactRecall.content.includes(manifest.token)); assert.ok(compactRecall.content.includes(manifest.attachmentToken)); assert.match(compactRecall.content, /1[,.]?500/);
      await send('FINAL_VERIFY', 'Run exactly node --test test/retry.test.cjs with Bash. Then summarize the actual result, exponential/jitter/Retry-After/cancellation behavior and remaining limitations. Do not claim any unrun soak or backend tests.', { bash: true }, ['bash']); oracle('full');
      assert.strictEqual(replies.length, 25, 'Twenty-five completed real replies');
      const all = receipts(), requests = all.filter(value => value.event === 'request'), commands = all.filter(value => value.event === 'native-command');
      assert.strictEqual(requests.length, 27 + faults.invalidModel.forwardedRejectedInputs); assert.strictEqual(commands.length, 1); assert.strictEqual(commands[0].command, '/compact');
      assert.ok(requests.every(value => !value.outsideMemoryMarkers.some((marker: string) => ['QUEUED_ONE', 'QUEUED_TWO'].includes(marker))), 'Removed queued prompts never reached native history');
      assert.ok(!all.some(value => /refusal|instrumentation-error|launch-error|rejected-settings/.test(value.event)));
      const history = await publicHistory(), finalFiles = files();
      assert.ok(tabEvidence().length === 2 && tabEvidence().every(value => value.stillOpen), 'Both independently owned editor tabs remain live');
      for (const reply of replies) { assert.ok(history.find(value => value.id === reply.conversationId)?.messages.some((message: any) => message.id === reply.messageId && message.content === reply.content), 'Completed reply persisted under correct conversation'); }
      const acceptance = { status: limits.length ? 'PARTIAL_NATIVE_INTERACTION' : 'PASS_BOUNDED_F1_BASELINE', sourceId: panels.get('main')!.conversationId, sourcePanelId: panels.get('main')!.panelId,
        otherConversationId: panels.get('other')!.conversationId, otherPanelId: panels.get('other')!.panelId, replies, faults, interactive, compact: interactive.compact, oracles, files: finalFiles,
        counts: { completedTurns: replies.length, conversationInputs: requests.length, nativeCommands: commands.length, stoppedInputs: 2, rejectedAttempts: 1, forwardedRejectedInputs: faults.invalidModel.forwardedRejectedInputs, auxiliaryInputs: all.filter(value => value.event === 'auxiliary-input').length, forwardedTotal: requests.length + commands.length },
        finalPublicHistoryIds: history.map(value => value.id), conversations: history.filter(value => [...panels.values()].some(panel => panel.conversationId === value.id)),
        liveTabs: tabEvidence(),
        elapsedMs: Date.now() - startedAt, scope: manifest.scope, limits, semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED', elapsedCampaigns: { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' } };
      fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify(acceptance, null, 2)); complete = true; record('acceptance-complete', { status: acceptance.status, counts: acceptance.counts });
    });

    // Native fault and interaction steps are separate so their generated inputs
    // cannot be silently counted as ordinary successful developer turns.
    async function question(): Promise<void> {
      const turn = await start('NATIVE_QUESTION', 'Use native AskUserQuestion exactly once to clarify whether fractional full-jitter delays should be floored or rounded. Offer both choices; do not edit, run commands or invent the user answer. After the answer, only explain its consequences.');
      const reply = await finish(turn, { interactive: 'question' });
      const native = receipts().filter(value => value.at >= turn.started && value.at <= reply.completedAt && value.wrapperPid === reply.request.wrapperPid && value.event === 'tool-start' && value.name === 'AskUserQuestion');
      await until('Native question delivery settles', async () => matchingNativeQuestionDeliveries((await events()).slice(turn.offset), native).length > 0, 3000).catch(() => {});
      const candidates = matchingNativeQuestionDeliveries((await events()).slice(turn.offset), native);
      const frame = await reveal();
      if (!candidates.length) {
        assert.strictEqual(native.length, 0, 'An actual native question must be answered through its correlated public card; no manual fallback');
        limits.push('Native AskUserQuestion was not emitted; manual clarification follows, native question coverage incomplete.');
        interactive.question = { status: 'INCOMPLETE', messageId: reply.messageId };
        await send('QUESTION_ANSWER', 'Clarification: floor the fractional full-jitter result. Explain why flooring is deterministic. No tools.'); return;
      }
      assert.strictEqual(candidates.length, 1, 'One current native question delivery'); assert.strictEqual(native.length, 1, 'One requested native question');
      const delivery = candidates.at(-1).payload, card = frame.locator(`.ask-user-question-container[data-tool-call-id=${JSON.stringify(delivery.toolCallId)}]`);
      await card.locator('.auq-other-radio').first().check();
      await card.locator('.auq-other-text').first().fill('Floor the fractional result. PB01_REQUEST:QUESTION_ANSWER. No tools; explain consequences and end PB01_DONE:QUESTION_ANSWER.');
      const next = { marker: 'QUESTION_ANSWER', label: 'main', offset: (await events()).length, started: Date.now() }; budget();
      await card.locator('.auq-submit-btn').click(); const followup = await finish(next);
      interactive.question = { status: 'PASS_NATIVE_FOLLOWUP', nativeToolIdHashes: native.map(value => value.toolIdHash), publicOwner: panels.get('main')!.panelId, deliveryId: delivery.toolCallId, selection: 'Floor', followupInputIndex: followup.requestInputIndex };
    }
    async function invalidModel(): Promise<void> {
      const selectedAt = Date.now(); await selectModel(manifest.invalidModel); const turn = await start('INVALID_MODEL', 'Without tools, explain the current retry requirement in one sentence.');
      await until('Invalid model rejected visibly', async () => (await events()).slice(turn.offset).some(value => ['error', 'authError'].includes(value.type)), 90_000);
      await panels.get('main')!.frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(turn.offset), errors = fresh.filter(value => ['error', 'authError'].includes(value.type));
      assert.ok(errors.some(value => /model/i.test(JSON.stringify(value.payload)) && /invalid|not found|not available|not exist|unknown|not support/i.test(JSON.stringify(value.payload))));
      assert.ok(!fresh.some(value => value.type === 'responseComplete'));
      const request = receipts().filter(value => value.event === 'request' && value.at >= turn.started); assert.ok(request.length <= 1); if (request.length) { assert.strictEqual(request[0].model, manifest.invalidModel); }
      const launches = receipts().filter(value => value.event === 'start' && value.at >= selectedAt && value.policy.model === manifest.invalidModel); assert.ok(launches.length >= 1, 'Actual pinned CLI must receive the invalid model configuration');
      assert.ok(!receipts().some(value => value.at >= selectedAt && value.event === 'tool-start'), 'Rejected model must not execute tools');
      faults.invalidModel = { request: request[0], errors, launches, selectedAt, forwardedRejectedInputs: request.length, rejectedAttempts: 1 }; record('invalid-model-rejected', faults.invalidModel); await selectModel('sonnet');
    }
    async function readonlyCanary(): Promise<void> {
      await mode('plan'); const startAt = Date.now(), beforeFiles = files(), offset = (await events()).length;
      const reply = await send('READONLY_CANARY', `Read exactly ${path.join(owner.workspace, manifest.fixture.deniedCanary)}, then attempt native Edit replacing KEEP_THIS_CANARY_UNCHANGED with READONLY_WRITE. Current Read Only mode must refuse it; do not switch modes or try another method. Explain the actual refusal.`, { read: [manifest.fixture.deniedCanary], denyCanary: true });
      const wire = receipts().filter(value => value.at >= startAt && value.at <= reply.completedAt && value.wrapperPid === reply.request.wrapperPid); assert.strictEqual(reply.request.policy.permissionMode, 'plan');
      assert.ok(!observations.some(value => value.event === 'permission-decision' && value.at >= startAt && value.tool === 'edit'), 'Read Only must enforce denial itself; manual Deny cannot mask unsafe authority');
      const afterFiles = files();
      for (const relative of Object.keys(manifest.fixture.files)) { assert.strictEqual(afterFiles.hashes[relative], beforeFiles.hashes[relative], 'Read-only turn leaves every developer fixture byte unchanged'); }
      const permissionRequests = (await events()).slice(offset).filter(value => value.type === 'permissionRequest');
      const status = classifyReadonlyCanary({ nativeReceipts: wire, permissionRequests, content: reply.content, canary: manifest.fixture.deniedCanary });
      if (status === 'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT') { limits.push('Read Only: Claude declined to attempt the native Edit. The canary stayed unchanged; actual native write-policy enforcement remains untested in this run.'); }
      faults.readonlyWrite = { status, replyId: reply.messageId, request: reply.request, nativeReceipts: wire, beforeFiles, files: afterFiles, permissionRequests: permissionRequests.length };
      record('readonly-canary', faults.readonlyWrite); await mode('ask');
    }
    async function stopApprovalAndQueue(): Promise<void> {
      const turn = await start('STOP_APPROVAL', `Read exactly ${path.join(owner.workspace, manifest.fixture.deniedCanary)}, then use native Edit once replacing KEEP_THIS_CANARY_UNCHANGED with CANCELLED_WRITE. Wait for native approval; no other tools or retry.`), frame = panels.get('main')!.frame;
      await until('Pending actual canary approval', async () => {
        const fresh = (await events()).slice(turn.offset), edit = fresh.find(value => value.type === 'permissionRequest' && String(value.payload.details?.toolName).toLowerCase() === 'edit');
        if (edit) { return true; }
        await permissions('main', turn.offset, { read: [manifest.fixture.deniedCanary], holdCanaryEdit: true });
        return false;
      }, 90_000);
      const permission = (await events()).slice(turn.offset).find(value => value.type === 'permissionRequest' && String(value.payload.details?.toolName).toLowerCase() === 'edit').payload;
      assert.strictEqual(String(permission.details?.toolName).toLowerCase(), 'edit'); assert.strictEqual(path.resolve(owner.workspace, permission.details.toolInput.file_path), path.join(owner.workspace, manifest.fixture.deniedCanary));
      for (const marker of ['QUEUED_ONE', 'QUEUED_TWO']) { await frame.locator('#message-input').fill(`PB01_REQUEST:${marker}\nExplain one retry caveat without tools.`); await frame.locator('#message-input').press('Tab'); }
      assert.strictEqual(await frame.locator('.queued-chip-remove').count(), 2);
      const inputCount = receipts().filter(value => value.event === 'request').length; await frame.locator('#stop-btn').click();
      await until('Cancellation acknowledged', async () => (await events()).slice(turn.offset).some(value => value.type === 'requestCancelled'));
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.ok(!(await events()).slice(turn.offset).some(value => value.type === 'responseComplete'), 'Stopped approval turn cannot later report successful completion');
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, inputCount, 'Stop must not dispatch queued followups');
      assert.strictEqual(await frame.locator('.queued-chip-remove').count(), 2);
      while (await frame.locator('.queued-chip-remove').count()) { await frame.locator('.queued-chip-remove').first().click(); }
      const proof = { marker: turn.marker, kind: 'pending-approval', inputCount, permissionId: permission.id, queuedRemoved: 2, events: (await events()).slice(turn.offset).filter(value => ['requestCancelled', 'responseComplete'].includes(value.type)), files: files() };
      faults.stops.push(proof); record('stopped-turn', proof);
    }
    async function stopStreaming(): Promise<void> {
      const turn = await start('STOP_STREAM', 'Without tools, write a long numbered audit of 120 distinct retry-service edge cases. Begin with the fixture identity and continue until all cases are explained. This deliberately overrides the final prose length bound.'), frame = panels.get('main')!.frame;
      await until('Actual nonempty first text', async () => (await events()).slice(turn.offset).filter(value => value.type === 'responseChunk' && value.payload?.type === 'text').reduce((total, value) => total + String(value.payload.content || '').length, 0) > 30, 90_000);
      assert.ok(!(await events()).slice(turn.offset).some(value => value.type === 'responseComplete'), 'Must stop while response is actually streaming');
      await frame.locator('#stop-btn').click();
      await until('Streaming cancellation acknowledged', async () => (await events()).slice(turn.offset).some(value => value.type === 'requestCancelled'));
      const cancelled = (await events()).slice(turn.offset).find(value => value.type === 'requestCancelled');
      assert.ok(cancelled.payload?.message?.content?.trim(), 'Useful partial text persisted on Stop'); await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.ok(!(await events()).slice(turn.offset).some(value => value.type === 'responseComplete'), 'Stopped text turn cannot later report successful completion');
      const proof = { marker: turn.marker, kind: 'text-stream', partialMessage: cancelled.payload.message, files: files() }; faults.stops.push(proof); record('stopped-turn', proof);
    }
    async function attachments(): Promise<void> {
      const frame = await reveal(), initialCount = (await events('main', 'fileAttachmentSelected')).length;
      for (const relative of ['attachments/brief.txt', 'attachments/status-blue.png']) {
        const before = (await events('main', 'fileAttachmentSelected')).length;
        await frame.locator('#attach-btn').click();
        const input = workbench.locator('.quick-input-widget input[type="text"]'); await input.waitFor({ state: 'visible' });
        await input.fill(path.join(owner.workspace, relative)); await input.press('Enter'); await input.waitFor({ state: 'hidden' });
        await until('Attachment acknowledged', async () => (await events('main', 'fileAttachmentSelected')).length > before);
      }
      const acknowledged = (await events('main', 'fileAttachmentSelected')).slice(initialCount).flatMap(value => value.payload.attachments);
      assert.strictEqual(acknowledged.length, 2); assert.strictEqual(new Set(acknowledged.map(value => value.id)).size, 2);
      for (const [relative, type] of [['attachments/brief.txt', 'file'], ['attachments/status-blue.png', 'image']]) {
        assert.ok(acknowledged.some(value => value.filePath === path.join(owner.workspace, relative) && value.fileName === path.basename(relative) && value.type === type && value.size === manifest.fixture.files[relative].bytes), 'Exact selected owned file acknowledged with its declared attachment type');
      }
      const reply = await send('ATTACHMENTS', 'Inspect both attached files using native Read when file paths are provided. Identify the image’s dominant color, quote the text release-note identity and deployment retry budget, then explain how that budget relates to our capped retry policy. No other files or changes.', { attachments: true }, ['read']);
      assert.match(reply.content, /\bblue\b/i); assert.ok(reply.content.includes(manifest.attachmentToken)); assert.match(reply.content, /1[,.]?500/);
      interactive.attachments = { replyId: reply.messageId, status: 'PASS_REAL_FILE_ATTACHMENTS', acknowledged, preparedHashes: ['attachments/brief.txt', 'attachments/status-blue.png'].map(relative => manifest.fixture.files[relative].sha256), tools: reply.tools };
    }
    async function nativePlan(): Promise<void> {
      await mode('plan'); const planPath = path.join(owner.workspace, '.mysti/plans/pb01-native.md');
      const turn = await start('NATIVE_PLAN', `Produce a short native ExitPlanMode plan for a final read-only verification of this completed retry task. If native plan metadata needs a file, only ${planPath} is allowed; never use another plan directory. Plan no code changes, only running node --test test/retry.test.cjs after approval. Use native ExitPlanMode to request review, not a prose-only substitute.`);
      const reply = await finish(turn, { interactive: 'plan', read: ['src/retry.cjs', 'test/retry.test.cjs'] });
      await until('Native plan delivery settles', async () => (await events()).slice(turn.offset).some(value => value.type === 'planOptions' && value.payload?.source === 'exit-plan-mode'), 3000).catch(() => {});
      const frame = await reveal(), plans = (await events()).slice(turn.offset).filter(value => value.type === 'planOptions' && value.payload?.source === 'exit-plan-mode');
      const card = frame.locator('.plan-options-container.native-plan[data-plan-source="exit-plan-mode"]').last();
      if (!plans.length || !await card.count()) {
        limits.push('Native ExitPlanMode card was not emitted; follow-up verification is manual and native plan coverage remains incomplete.'); interactive.plan = { status: 'INCOMPLETE', replyId: reply.messageId };
        await mode('ask'); await send('PLAN_FOLLOWUP', 'Run exactly node --test test/retry.test.cjs with Bash for the final verification discussed in our plan; no changes.', { bash: true }, ['bash']); return;
      }
      const delivery = plans.at(-1).payload; assert.strictEqual(delivery.conversationId, panels.get('main')!.conversationId);
      if (delivery.planFilePath) { assert.strictEqual(path.resolve(delivery.planFilePath), planPath, 'Native plan metadata must stay at the explicitly owned path'); }
      const native = receipts().filter(value => value.at >= turn.started && value.event === 'tool-start' && value.name === 'ExitPlanMode'); assert.ok(native.length);
      assert.strictEqual(await card.getAttribute('data-message-id'), delivery.messageId); assert.strictEqual(await card.getAttribute('data-synthetic-plan-id'), delivery.syntheticPlanId);
      await card.locator('.plan-option-header').first().click(); await card.locator('.custom-instructions-toggle').first().click();
      await card.locator('.custom-instructions-textarea').first().fill('PB01_REQUEST:PLAN_FOLLOWUP. Run only node --test test/retry.test.cjs with Bash; no edits or other tools. End PB01_DONE:PLAN_FOLLOWUP.');
      const next = { marker: 'PLAN_FOLLOWUP', label: 'main', offset: (await events()).length, started: Date.now() }; budget();
      await card.locator('.plan-execute-btn[data-mode="ask-before-edit"]').first().click(); const followup = await finish(next, { bash: true }, ['bash']);
      interactive.plan = { status: 'PASS_NATIVE_FOLLOWUP', nativeToolIdHashes: native.map(value => value.toolIdHash), publicOwner: panels.get('main')!.panelId, syntheticPlanId: delivery.syntheticPlanId, conversationId: delivery.conversationId, planFilePath: delivery.planFilePath, selection: 'ask-before-edit', followupInputIndex: followup.requestInputIndex };
    }
    async function compact(): Promise<void> {
      const frame = await reveal(), offset = (await events()).length, at = Date.now(); budget();
      const before = receipts().filter(value => value.event === 'session').at(-1)?.sessionHash;
      await frame.locator('#context-usage').click();
      await until('Native compaction completes', async () => {
        const statuses = (await events()).slice(offset).filter(value => value.type === 'compactionStatus');
        assert.ok(!statuses.some(value => value.payload.status === 'error'), 'Actual native compaction failure');
        return statuses.some(value => value.payload.status === 'complete');
      }, 180_000);
      const receipt = receipts().filter(value => value.event === 'native-command' && value.at >= at); assert.strictEqual(receipt.length, 1); assert.strictEqual(receipt[0].command, '/compact');
      const native = receipts().filter(value => value.event === 'native-result' && value.at >= at && value.wrapperPid === receipt[0].wrapperPid);
      assert.ok(native.length > 0 && native.every(value => value.isError === false), 'Native compaction must actually succeed, not only show a completion toast');
      interactive.compact = { started: at, completedAt: Date.now(), receiptInputIndex: receipt[0].inputIndex, sessionHashBefore: before, sessionHashAfter: receipts().filter(value => value.event === 'session').at(-1)?.sessionHash, events: (await events()).slice(offset).filter(value => value.type === 'compactionStatus') };
      record('native-compact', interactive.compact);
    }
    after(async () => {
      if (owner) {
        if (!complete) { await workbench?.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {}); }
        for (const [label] of panels) {
          const safe = (await events(label).catch(() => [])).filter(value => value.type !== 'conversationHistory' && value.type !== 'conversationChanged');
          fs.writeFileSync(path.join(owner.directory, `events-${label}.json`), JSON.stringify(safe, null, 2));
        }
      }
      await browser?.close().catch(() => {});
    });
  });
}
