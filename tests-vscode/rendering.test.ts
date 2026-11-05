/**
 * PC-05 opt-in packaged-editor rendering and one owned-file Edit/Revert.
 * MYSTI_PC05=1, --grep 'PC-05 real editor'; requires fresh runner profile,
 * MYSTI_TEST_EXTENSION_PATH, MYSTI_PC05_CLAUDE_PATH, MYSTI_PC05_NODE_PATH.
 * Two existing-account Claude turns. No account/CLI config writes. The only
 * agent-write target is a unique retry.ts under the runner fixture workspace.
 * Apply has no public control and is explicitly NOT_REACHABLE in this case.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';

if (process.env.MYSTI_PC05 === '1') {
  describe('PC-05 real editor rich review and owned edit round trip', function () {
    this.timeout(240_000);
    let browser: Browser, workbench: Page, frame: Frame, artifactDir: string;
    let chatTab: vscode.Tab | undefined;
    let workspace: string, fixtureDirectory: string, fixtureFile: string, launchReceipts: string;
    let originalClipboard: string | undefined, initialExtensionHash: string, loadedExtensionPath: string;
    let reviewComplete = false;
    const model = 'sonnet';
    const oldLine = '  return Math.min(capMs, baseMs * attempt);';
    const newLine = '  return Math.min(capMs, baseMs * 2 ** attempt);';
    const original = '// USER_SENTINEL_BEFORE: preserve review notes\nexport function retryDelay(attempt: number, baseMs = 73, capMs = 500): number {\n'
      + oldLine + '\n}\n// USER_SENTINEL_AFTER: preserve ownership\n';
    const laterUserLine = '// USER_ADDED_AFTER_AGENT_EDIT: preserve this independent work\n';
    const observations: unknown[] = [];
    const saved: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
    const ownedPids = new Set<number>();
    const approvals = new Set<string>();
    const initialTabs = new Set<vscode.Tab>();
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { ...details, event, at: new Date().toISOString() };
      observations.push(entry);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-05]', JSON.stringify(entry));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function events(type?: string): Promise<any[]> {
      const all = await frame.evaluate(() => (globalThis as any).__pc05Events || []);
      return type ? all.filter((event: any) => event.type === type) : all;
    }
    async function configure(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
      const configuration = vscode.workspace.getConfiguration('mysti');
      if (!saved.some(previous => previous.key === key && previous.target === target)) saved.push({ key, target,
        value: target === vscode.ConfigurationTarget.Global ? configuration.inspect(key)?.globalValue : configuration.inspect(key)?.workspaceValue });
      await configuration.update(key, value, target);
    }
    async function revealChat(): Promise<void> {
      assert.ok(chatTab);
      const group = vscode.window.tabGroups.all.find(item => item.tabs.includes(chatTab!)); assert.ok(group);
      const index = group.tabs.indexOf(chatTab);
      assert.ok(index >= 0 && index < 9, 'The exact owned chat tab must remain addressable');
      assert.strictEqual(vscode.window.tabGroups.activeTabGroup, group, 'The fixture retains its one intended editor group');
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
      assert.strictEqual(group.activeTab, chatTab); await workbench.bringToFront();
    }
    function processRows(): number[] {
      if (launchReceipts && fs.existsSync(launchReceipts)) {
        for (const line of fs.readFileSync(launchReceipts, 'utf8').split('\n').filter(Boolean)) {
          const receipt = JSON.parse(line);
          if (receipt.event === 'start') for (const pid of [receipt.wrapperPid, receipt.childPid]) if (Number.isInteger(pid)) ownedPids.add(pid);
        }
      }
      // Process ancestry only. Never inspect or persist command lines/env.
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')
        .map(line => line.trim().split(/\s+/).map(Number));
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows) if (ownedPids.has(parent) && !ownedPids.has(pid)) { ownedPids.add(pid); changed = true; }
      }
      return rows.filter(([pid]) => ownedPids.has(pid)).map(([pid]) => pid);
    }
    function isOwnedPath(value: unknown): boolean {
      return typeof value === 'string' && path.resolve(workspace, value) === fixtureFile;
    }
    async function approveKnownRequest(allowEdit: boolean): Promise<void> {
      for (const event of await events('permissionRequest')) {
        const request = event.payload;
        if (approvals.has(request.id)) continue;
        assert.match(request.id, /^[a-zA-Z0-9_-]+$/);
        const details = request.details || {}, input = details.toolInput || {};
        const name = String(details.toolName || request.title || '').toLowerCase();
        const exactPath = isOwnedPath(input.file_path || input.path || details.filePath);
        const read = name === 'read' && exactPath;
        const edit = allowEdit && name === 'edit' && exactPath && input.old_string === oldLine && input.new_string === newLine && input.replace_all !== true;
        const card = frame.locator(`.permission-card[data-id=${JSON.stringify(request.id)}]`);
        await card.locator(`[data-action="${read || edit ? 'approve' : 'deny'}"]`).click();
        approvals.add(request.id);
        record('permission-decision', { requestId: request.id, toolName: name, approved: read || edit, ownedPath: exactPath });
        assert.ok(read || edit, 'Refused a tool outside the single owned Read/Edit scope');
      }
    }
    async function send(prompt: string, allowEdit: boolean): Promise<any> {
      const offset = (await events()).length, completedBefore = (await events('responseComplete')).length;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      await until('The actual Claude response must finish', async () => {
        await approveKnownRequest(allowEdit);
        const fresh = (await events()).slice(offset);
        assert.strictEqual(fresh.some(event => ['authError', 'error'].includes(event.type)), false, 'Real inference must not report an auth/transport error');
        if (fresh.some(event => event.type === 'toolUse')) processRows();
        return (await events('responseComplete')).length > completedBefore;
      }, 150_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(offset);
      assert.strictEqual(fresh.filter(event => event.type === 'responseStarted').length, 1);
      const completed = fresh.filter(event => event.type === 'responseComplete'); assert.strictEqual(completed.length, 1);
      const message = completed[0].payload.message;
      assert.strictEqual(message.provider, 'claude-code'); assert.strictEqual(message.model, model);
      const textEvents = fresh.filter(event => event.type === 'responseChunk' && event.payload.type === 'text');
      assert.ok(textEvents.length > 1, 'Observe actual streamed text, not a seeded completed message');
      assert.strictEqual(textEvents.map(event => event.payload.content || '').join(''), message.content);
      assert.ok(textEvents.every(event => event.sequence < completed[0].sequence));
      const toolCalls = message.toolCalls || [];
      assert.strictEqual(new Set(toolCalls.map((tool: any) => tool.id)).size, toolCalls.length, 'Persisted native start/stop events must merge by tool ID');
      for (const tool of toolCalls) {
        assert.strictEqual(tool.status, 'completed');
        assert.ok(['read', ...(allowEdit ? ['edit'] : [])].includes(String(tool.name).toLowerCase()), 'Only the assigned Read/Edit tools may run');
        assert.ok(isOwnedPath(tool.input?.file_path || tool.input?.path), 'Every tool must target the owned fixture');
      }
      assert.strictEqual(await frame.locator('#messages .message.streaming').count(), 0);
      assert.strictEqual(await frame.locator('#messages .tool-call.running').count(), 0);
      record('actual-response', { prompt, message, textChunkCount: textEvents.length, exactOrderedText: true,
        toolIds: toolCalls.map((tool: any) => tool.id), eventCount: fresh.length });
      return message;
    }

    before(async () => {
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
      assert.ok(profile && path.isAbsolute(profile) && fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Require the runner fresh editor profile');
      artifactDir = process.env.MYSTI_PC05_ARTIFACT_DIR || path.join(profile, 'pc05-evidence'); fs.mkdirSync(artifactDir, { recursive: true });
      const requested = process.env.MYSTI_TEST_EXTENSION_PATH;
      assert.ok(requested && path.isAbsolute(requested));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      loadedExtensionPath = fs.realpathSync(extension.extensionPath);
      const requestedPath = fs.realpathSync(requested);
      initialExtensionHash = hash(fs.readFileSync(path.join(loadedExtensionPath, 'dist/extension.js')));
      record('loaded-extension-identity', { actualPath: loadedExtensionPath, requestedPath, actualHash: initialExtensionHash,
        requestedHash: hash(fs.readFileSync(path.join(requestedPath, 'dist/extension.js'))), vscode: vscode.version });
      assert.strictEqual(loadedExtensionPath, requestedPath);
      assert.strictEqual(initialExtensionHash, hash(fs.readFileSync(path.join(requestedPath, 'dist/extension.js'))));
      const executable = process.env.MYSTI_PC05_CLAUDE_PATH, node = process.env.MYSTI_PC05_NODE_PATH;
      assert.ok(executable && path.isAbsolute(executable) && fs.existsSync(executable));
      assert.ok(node && path.isAbsolute(node) && fs.existsSync(node));
      assert.notStrictEqual(process.platform, 'win32', 'This selected-Claude fixture uses a POSIX wrapper');
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
      workspace = fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath);
      assert.strictEqual(workspace, fs.realpathSync(path.join(__dirname, 'fixture-workspace')), 'Never write an arbitrary developer workspace');
      fixtureDirectory = fs.mkdtempSync(path.join(workspace, 'pc05-'));
      fixtureFile = path.join(fixtureDirectory, 'retry.ts'); fs.writeFileSync(fixtureFile, original);
      const cliDirectory = fs.mkdtempSync(path.join(artifactDir, 'cli-'));
      const hooks = path.join(cliDirectory, 'claude-settings.json');
      fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
      launchReceipts = path.join(cliDirectory, 'process-receipts.jsonl');
      const wrapper = path.join(cliDirectory, 'claude-review-fixture');
      // Transparent stdin/stdout/argv/env. Only persistent inference gains the
      // owned hooks-off settings. Version/auth probes remain unchanged.
      fs.writeFileSync(wrapper, `#!${node}\n'use strict';\nconst fs=require('fs'),{spawn}=require('child_process');\nconst args=process.argv.slice(2);\nconst flag=name=>args[args.indexOf(name)+1];\nconst persistent=args.includes('--input-format')&&flag('--input-format')==='stream-json'&&args.includes('--output-format')&&flag('--output-format')==='stream-json';\nconst child=spawn(${JSON.stringify(executable)},persistent?[...args,'--settings',${JSON.stringify(hooks)}]:args,{env:process.env,stdio:'inherit'});\nconst record=event=>{if(persistent)fs.appendFileSync(${JSON.stringify(launchReceipts)},JSON.stringify({event,wrapperPid:process.pid,childPid:child.pid})+'\\n',{mode:0o600});};\nchild.on('spawn',()=>record('start'));\nchild.on('error',()=>{process.stderr.write('PC05 selected CLI failed to launch.\\n');process.exitCode=1;});\nchild.on('close',(code,signal)=>{record('exit');if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});\n`, { mode: 0o700 });
      originalClipboard = await vscode.env.clipboard.readText();
      for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) initialTabs.add(tab);
      await configure('claudeCodePath', wrapper, vscode.ConfigurationTarget.Global);
      for (const [key, value] of Object.entries({ defaultAgent: 'claude-code', defaultProvider: 'claude-code', defaultModel: model,
        claudeCodeModel: model, defaultEffortLevel: 'low', defaultThinkingLevel: 'none', defaultMode: 'ask-before-edit',
        accessLevel: 'ask-permission', autoContext: false, showSuggestions: false })) {
        await configure(key, undefined, vscode.ConfigurationTarget.Workspace);
        await configure(key, value, vscode.ConfigurationTarget.Global);
      }
      const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat')).length, 0);
      await extension.activate();
      const previousFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      const previousTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('The exact test-owned chat tab must open', async () => {
        chatTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => !previousTabs.has(tab) &&
          tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat'));
        return !!chatTab;
      });
      await revealChat();
      await until('The dedicated test chat must initialize', async () => {
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (previousFrames.has(candidate)) continue;
          try {
            if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() &&
              (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) candidates.push(candidate);
          } catch { /* Webview is mounting. */ }
        }
        if (candidates.length !== 1) return false;
        frame = candidates[0]; return true;
      }, 30_000);
      if (await frame.locator('#setup-wizard').isVisible()) await frame.locator('.wizard-skip-btn').click();
      await frame.evaluate(() => {
        const win = globalThis as any; win.__pc05Events = [];
        const tool = (value: any) => value && ({ id: value.id, name: value.name, status: value.status,
          input: value.input && { file_path: value.input.file_path, path: value.input.path, old_string: value.input.old_string,
            new_string: value.input.new_string, replace_all: value.input.replace_all } });
        win.__pc05Listener = (event: any) => {
          const message = event.data, payload = message?.payload || {};
          if (!['conversationChanged', 'responseStarted', 'responseChunk', 'responseComplete', 'toolUse', 'toolResult',
            'permissionRequest', 'authError', 'error', 'exportResult', 'fileReverted'].includes(message?.type)) return;
          let captured: any = {};
          if (message.type === 'conversationChanged') captured = { id: payload.id };
          if (message.type === 'responseStarted') captured = { provider: payload.provider, model: payload.model };
          if (message.type === 'responseChunk') captured = { type: payload.type, ...(payload.type === 'text' ? { content: payload.content } : {}) };
          if (message.type === 'responseComplete') captured = { message: payload.message && {
            id: payload.message.id, provider: payload.message.provider, model: payload.message.model, content: payload.message.content,
            toolCalls: (payload.message.toolCalls || []).map(tool),
            segments: (payload.message.segments || []).map((segment: any) => ({ type: segment.type, toolCallId: segment.toolCallId,
              ...(segment.type === 'text' ? { content: segment.content } : {}) })) } };
          if (['toolUse', 'toolResult'].includes(message.type)) captured = tool(payload);
          if (message.type === 'permissionRequest') captured = { id: payload.id, title: payload.title,
            details: { filePath: payload.details?.filePath, toolName: payload.details?.toolName, toolInput: tool({ input: payload.details?.toolInput })?.input } };
          if (message.type === 'exportResult') captured = { success: payload.success, markdown: payload.markdown };
          if (message.type === 'fileReverted') captured = { success: payload.success, path: payload.path, toolCallId: payload.toolCallId };
          win.__pc05Events.push({ type: message.type, sequence: win.__pc05Events.length, payload: captured });
        };
        win.addEventListener('message', win.__pc05Listener);
      });
      await frame.locator('#new-conversation-btn').click();
      await until('New chat must have a genuine host identity', async () => (await events('conversationChanged')).length === 1);
      await frame.locator('#agent-select-btn').click();
      await frame.locator('#agent-menu .agent-menu-item[data-agent="claude-code"]:not(.disabled)').click();
      await until('Claude and the actual alias must be selected', async () => /Claude/i.test(await frame.locator('#agent-name').innerText()) &&
        await frame.locator('#model-select-inline').inputValue() === model);
      record('fixture-scope', { fixtureFile, originalSha256: hash(original), selectedExecutable: executable, wrapper, model,
        scope: 'Two existing-account real editor turns; owned Read and one exact Edit only. Public rendering/copy/open/revert controls. No account/CLI config writes, no workday/endurance soak.',
        applySuggestedEdit: 'NOT_REACHABLE: no public Apply control; no synthetic host action is posted.' });
    });

    afterEach(async function () {
      if (!artifactDir) return;
      record(this.currentTest?.state === 'failed' ? 'case-failed' : 'case-complete', { title: this.currentTest?.title,
        error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message },
        events: frame && await events().catch(() => []), fixtureSha256: fixtureFile && fs.existsSync(fixtureFile) ? hash(fs.readFileSync(fixtureFile)) : undefined });
      if (this.currentTest?.state === 'failed' && workbench) await workbench.screenshot({ path: path.join(artifactDir, 'failure.png') }).catch(() => {});
    });
    after(async () => {
      let clipboardRestored = false;
      try {
        if (frame) {
          if (await frame.locator('#stop-btn').isVisible().catch(() => false)) await frame.locator('#stop-btn').click().catch(() => {});
          processRows();
          await frame.evaluate(() => { const win = globalThis as any; win.removeEventListener('message', win.__pc05Listener); }).catch(() => {});
        }
      } finally {
        if (originalClipboard !== undefined) {
          await vscode.env.clipboard.writeText(originalClipboard);
          clipboardRestored = await vscode.env.clipboard.readText() === originalClipboard;
        }
        // Closing this exact owned panel disposes its session, without warming
        // a replacement conversation or shutting down unrelated editor agents.
        if (chatTab) await vscode.window.tabGroups.close(chatTab);
        for (const previous of saved.reverse()) await vscode.workspace.getConfiguration('mysti').update(previous.key, previous.value, previous.target);
        for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) {
          if (!initialTabs.has(tab) && tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === fixtureFile) await vscode.window.tabGroups.close(tab);
        }
        await browser?.close();
      }
      const started = Date.now(); let remaining = launchReceipts ? processRows() : [];
      while (remaining.length && Date.now() - started < 10_000) {
        await new Promise(resolve => setTimeout(resolve, 100)); remaining = processRows();
      }
      if (artifactDir) record('cleanup', { clipboardRestored, ownedProcessCount: ownedPids.size, remainingOwnedPids: remaining,
        durationMs: Date.now() - started, immutableExtension: !loadedExtensionPath || hash(fs.readFileSync(path.join(loadedExtensionPath, 'dist/extension.js'))) === initialExtensionHash });
      if (originalClipboard !== undefined) assert.strictEqual(clipboardRestored, true, 'Restore the pre-test clipboard without recording its contents');
      assert.deepStrictEqual(remaining, [], 'Owned persistent CLI processes must settle after the dedicated chat tab closes');
      if (loadedExtensionPath) assert.strictEqual(hash(fs.readFileSync(path.join(loadedExtensionPath, 'dist/extension.js'))), initialExtensionHash);
    });

    it('renders a real Read-backed rich review and copies the persisted Markdown and code to the native clipboard', async () => {
      const prompt = `Review only ${fixtureFile}. Use Read once on that exact file; no other tools or files and no changes. Contract: retryDelay(n) = min(capMs, baseMs * 2 ** n) for nonnegative integers. Give concise prose, a Markdown table of actual/expected for attempts 0,1,4, a corrected function in a fenced javascript block (without TypeScript annotations), the minimal proposed change in a fenced diff, and a small fenced mermaid flowchart with quoted labels. Include Retry → cap ✅ once and end with PC05_NATIVE_REVIEW_DONE. Keep below 350 words.`;
      const message = await send(prompt, false);
      assert.strictEqual((message.toolCalls || []).filter((tool: any) => tool.name.toLowerCase() === 'read').length, 1);
      assert.ok(message.content.trimEnd().endsWith('PC05_NATIVE_REVIEW_DONE'));
      assert.strictEqual(fs.readFileSync(fixtureFile, 'utf8'), original);
      const rendered = frame.locator(`.message.assistant[data-id=${JSON.stringify(message.id)}]`);
      assert.strictEqual(await rendered.count(), 1); assert.strictEqual(await rendered.getAttribute('data-provider'), 'claude-code');
      assert.strictEqual(await rendered.locator('table').count(), 1);
      assert.ok(await rendered.locator('pre code.language-javascript').count() >= 1);
      assert.strictEqual(await rendered.locator('.file-edit-card').count(), 1);
      assert.strictEqual(await rendered.locator('.file-edit-card .file-edit-revert').count(), 0, 'Proposed diffs cannot offer a destructive revert');
      await until('The actual Mermaid source must render to SVG', async () => await rendered.locator('.mermaid-rendered svg').count() === 1, 30_000);
      assert.strictEqual(await rendered.locator('.mermaid-error').count(), 0);
      assert.strictEqual((await rendered.innerText()).split('Retry → cap ✅').length, 2);
      const sourceCode = /```(?:javascript|js)\s*\n([\s\S]*?)\n```/.exec(message.content)?.[1]; assert.ok(sourceCode);
      const code = rendered.locator('pre code.language-javascript').first();
      assert.strictEqual(await code.textContent(), sourceCode);
      const beforeExport = (await events('exportResult')).length;
      await rendered.locator('.message-copy-btn').click();
      await until('Message copy must complete in the real extension clipboard', async () => (await events('exportResult')).length > beforeExport);
      const exported = (await events('exportResult')).at(-1).payload;
      assert.strictEqual(exported.success, true);
      const markdownClipboard = await vscode.env.clipboard.readText(); assert.strictEqual(markdownClipboard, exported.markdown);
      assert.ok(markdownClipboard.startsWith('### Assistant\n\n' + message.content + '\n\n---\n'));
      await code.locator('..').locator('..').locator('.message-code-copy').click();
      await until('Code copy must retain exact source bytes in the real clipboard', async () => await vscode.env.clipboard.readText() === sourceCode);
      record('rich-render-and-native-copy', { messageId: message.id, tableCount: 1, diagramSvgCount: 1,
        sourceCodeSha256: hash(sourceCode), clipboardMarkdownSha256: hash(markdownClipboard), clipboardCodeSha256: hash(await vscode.env.clipboard.readText()),
        originalFilePreserved: true, markdownFromPersistedMessage: true });
      await workbench.screenshot({ path: path.join(artifactDir, 'rich-review.png') });
      reviewComplete = true;
    });

    it('opens the actual edited file and reverts only its exact agent change while preserving later user work', async () => {
      assert.strictEqual(reviewComplete, true, 'The same-conversation review must have completed before the edit request');
      const message = await send(`Apply the agreed correction in ${fixtureFile} using exactly one Edit call, not Write, Bash or another tool. Replace exactly this old_string (no newline): ${JSON.stringify(oldLine)} with exactly this new_string (no newline): ${JSON.stringify(newLine)}. Do not use replace_all. Preserve both USER_SENTINEL lines and every other byte. The file was already read in this conversation. No other files or actions. End with PC05_NATIVE_EDIT_DONE.`, true);
      assert.ok(message.content.trimEnd().endsWith('PC05_NATIVE_EDIT_DONE'));
      const edits = (message.toolCalls || []).filter((tool: any) => tool.name.toLowerCase() === 'edit'); assert.strictEqual(edits.length, 1);
      const edit = edits[0]; assert.strictEqual(edit.input.old_string, oldLine); assert.strictEqual(edit.input.new_string, newLine);
      assert.notStrictEqual(edit.input.replace_all, true);
      const edited = original.replace(oldLine, newLine); assert.strictEqual(fs.readFileSync(fixtureFile, 'utf8'), edited);
      const uri = vscode.Uri.file(fixtureFile), document = await vscode.workspace.openTextDocument(uri);
      const userEdit = new vscode.WorkspaceEdit(); userEdit.insert(uri, document.positionAt(document.getText().length), laterUserLine);
      assert.strictEqual(await vscode.workspace.applyEdit(userEdit), true); assert.strictEqual(await document.save(), true);
      assert.strictEqual(fs.readFileSync(fixtureFile, 'utf8'), edited + laterUserLine);
      const card = frame.locator(`.edit-report-card[data-tool-id=${JSON.stringify(edit.id)}]`);
      assert.strictEqual(await card.count(), 1); assert.ok(isOwnedPath(await card.getAttribute('data-file-path')));
      await card.locator('.edit-report-btn-open').click();
      await until('Open file must reveal exactly the owned source URI', async () => vscode.window.activeTextEditor?.document.uri.fsPath === fixtureFile);
      assert.strictEqual(vscode.window.activeTextEditor!.document.getText(), edited + laterUserLine);
      assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 2, 'Open file must select the actual changed third line');
      await revealChat();
      const beforeRevert = (await events('fileReverted')).length;
      await card.locator('.edit-report-btn-revert').click();
      await until('The exact completed Edit must report a scoped revert', async () => (await events('fileReverted')).length > beforeRevert);
      const reverted = (await events('fileReverted')).at(-1).payload;
      assert.strictEqual(reverted.success, true); assert.strictEqual(reverted.toolCallId, edit.id); assert.ok(isOwnedPath(reverted.path));
      await until('Revert must restore only the agent replacement in the editor', async () => document.getText() === original + laterUserLine);
      assert.strictEqual(document.isDirty, true, 'Revert must not silently save unrelated user work');
      assert.strictEqual(fs.readFileSync(fixtureFile, 'utf8'), edited + laterUserLine);
      assert.strictEqual(await document.save(), true, 'The test explicitly saves its owned reverted document');
      assert.strictEqual(fs.readFileSync(fixtureFile, 'utf8'), original + laterUserLine);
      await revealChat();
      assert.strictEqual(await card.locator('.edit-report-btn-revert').isDisabled(), true);
      assert.strictEqual((await events('conversationChanged')).length, 1);
      record('owned-edit-open-revert', { messageId: message.id, toolCallId: edit.id, fixtureFile, permissionCount: approvals.size,
        originalSha256: hash(original), afterAgentSha256: hash(edited), afterUserSha256: hash(edited + laterUserLine),
        afterRevertSha256: hash(fs.readFileSync(fixtureFile)), expectedRevertSha256: hash(original + laterUserLine),
        userSentinelsPreserved: true, laterUserLinePreserved: true, openFileExactUri: true, selectedLine: 2,
        revertLeftEditorDirty: true, explicitFixtureSave: true });
      await workbench.screenshot({ path: path.join(artifactDir, 'edit-reverted.png') });
    });
  });
}
