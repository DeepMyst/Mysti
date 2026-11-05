/** PC-11 ordinary-editor transfer journey; two profiles, seven native inputs. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, createHmac } from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { deflateSync } from 'zlib';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { installTransferObserver } from './transfer-observer';
import { NativeClipboardGuard } from './clipboard-guard';
const execFileAsync = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function canonical(value: any): string {
  if (Array.isArray(value)) { return '[' + value.map(canonical).join(',') + ']'; }
  if (value && typeof value === 'object') { return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'; }
  return JSON.stringify(value);
}
const digest = (value: any) => hash(canonical(value));
const same = (actual: any, expected: any) => assert.strictEqual(digest(actual), digest(expected), 'Exact canonical values must match; raw thinking is excluded from assertion logs');
const watermark = '*I was Mysting — built with [Mysti](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti), the multi-agent AI coding assistant*';
function markdown(conversation: any, one?: any): string {
  const lines = one ? [] : [`# ${conversation.title}`, '', `> Provider: ${conversation.provider} | Model: ${conversation.model}`, ''];
  for (const message of one ? [one] : conversation.messages) { lines.push(`### ${message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role}`, '', message.content, ''); }
  return [...lines, '---', '', watermark, ''].join('\n');
}
function messageSemantics(message: any): any {
  const result = JSON.parse(JSON.stringify(message)); delete result.id; delete result.checkpoint;
  if (result.toolCalls) { result.toolCalls = result.toolCalls.map((tool: any) => ({ ...tool, historicalOnly: true })); }
  return result;
}
function assertJsonImport(imported: any, source: any): void {
  assert.notStrictEqual(imported.id, source.id); assert.strictEqual(imported.messages.length, source.messages.length);
  const sourceIds = new Set(source.messages.map((message: any) => message.id));
  assert.strictEqual(new Set(imported.messages.map((message: any) => message.id)).size, imported.messages.length);
  for (const message of imported.messages) { assert.ok(!sourceIds.has(message.id)); assert.strictEqual(message.checkpoint, undefined); }
  assert.ok(imported.messages.every((message: any) => (message.toolCalls || []).every((tool: any) => tool.historicalOnly === true)), 'Every imported tool must be marked historical-only');
  same(imported.messages.map(messageSemantics), source.messages.map(messageSemantics));
  for (const field of ['title', 'mode', 'provider', 'model', 'createdAt']) { assert.strictEqual(imported[field], source[field]); }
  same(imported.agentConfig || null, source.agentConfig || null);
}

if (process.env.MYSTI_PC11 === '1') {
  describe('PC-11 real editor transfer, clipboard, URI and active import', function () {
    this.timeout(1_050_000);
    const windowId = process.env.MYSTI_PC11_WINDOW!, repo = path.resolve(__dirname, '..');
    let browser: Browser, workbench: Page, manifest: any, owner: any, guard: NativeClipboardGuard | undefined;
    let completed = false;
    let lastOwnedUri: { authority: string; canonical: string; sha256: string } | undefined;
    const observations: any[] = [], panels = new Map<string, { frame: Frame; tab: vscode.Tab; id: string }>();
    function signedRecovery(fileName: string, details: Record<string, unknown>): void {
      const value = { window: windowId, profile: owner.profile, extensionHostPid: process.pid, at: Date.now(), ...details };
      fs.writeFileSync(path.join(owner.directory, fileName), JSON.stringify({ ...value, signature: createHmac('sha256', manifest.clipboardRecoveryKey).update(JSON.stringify(value)).digest('hex') }, null, 2), { mode: 0o600 });
    }
    async function quitClipboardGuard(): Promise<any> {
      try { const result = await guard!.quit(); guard = undefined; return result; }
      catch (error) {
        const pid = guard?.pid; assert.ok(pid, 'Clipboard recovery needs the actual persistent helper PID');
        const startedAt = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000 }).trim();
        assert.ok(startedAt, 'A lost clipboard helper cannot claim a retained RAM backup');
        signedRecovery('clipboard-restore-failed.json', { guardPid: pid, guardStartedAt: startedAt, status: 'FAIL_RETAINED_CLIPBOARD_RECOVERY', reason: 'Clipboard guard could not confirm restoration; preserve owned editor and helper for explicit retry.' });
        throw error;
      }
    }
    function record(event: string, details: Record<string, unknown> = {}): void {
      const value = { event, at: Date.now(), window: windowId, ...details }; observations.push(value);
      fs.writeFileSync(path.join(owner.directory, 'observations.json'), JSON.stringify(observations, null, 2)); console.log('[PC-11]', JSON.stringify(value));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        assert.ok(!fs.existsSync(path.join(manifest.artifactDir, `failure-${windowId === 'A' ? 'B' : 'A'}.json`)), `Other owned window failed before ${label}`);
        if (await predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 75));
      }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function waitFile(file: string, timeout = 300000): Promise<any> { await until(path.basename(file), async () => fs.existsSync(file), timeout); return JSON.parse(fs.readFileSync(file, 'utf8')); }
    function receipts(): any[] { return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []); }
    async function events(label: string, type?: string): Promise<any[]> {
      const values = await panels.get(label)!.frame.evaluate(() => (globalThis as any).__pc11Events || []);
      return type ? values.filter((value: any) => value.type === type) : values;
    }
    async function reveal(label: string): Promise<Frame> {
      const panel = panels.get(label)!;
      const group = vscode.window.tabGroups.all.find(value => value.tabs.includes(panel.tab)); assert.ok(group);
      const ordinal = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'][group.viewColumn - 1]; assert.ok(ordinal);
      if (!group.isActive) { await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`); }
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${group.tabs.indexOf(panel.tab) + 1}`);
      assert.strictEqual(group.isActive, true); assert.strictEqual(group.activeTab, panel.tab);
      await workbench.bringToFront(); return panel.frame;
    }
    async function bindNewPanel(label: string, previousTabs: Set<vscode.Tab>, previousFrames: Set<Frame>): Promise<void> {
      let tab: vscode.Tab | undefined, frame: Frame | undefined;
      await until('Owned chat mounts', async () => {
        tab = vscode.window.tabGroups.all.flatMap(value => value.tabs).find(value => !previousTabs.has(value) && value.input instanceof vscode.TabInputWebview && value.input.viewType.includes('mysti.detachedChat'));
        const candidates: Frame[] = [];
        for (const value of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (previousFrames.has(value)) { continue; }
          try { if (await value.locator('#message-input').count() && !await value.locator('body.view-hub').count() && (await value.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { candidates.push(value); } } catch { /* Mounting. */ }
        }
        if (!tab || candidates.length !== 1) { return false; } frame = candidates[0]; return true;
      });
      panels.set(label, { tab: tab!, frame: frame!, id: '' }); await reveal(label);
      if (await frame!.locator('.wizard-skip-btn').isVisible()) { await frame!.locator('.wizard-skip-btn').click(); }
      await frame!.evaluate(installTransferObserver);
    }
    function beforePanel(): { tabs: Set<vscode.Tab>; frames: Set<Frame> } { return { tabs: new Set(vscode.window.tabGroups.all.flatMap(value => value.tabs)), frames: new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) }; }
    async function createPanel(label: string): Promise<void> {
      const before = beforePanel(); await vscode.commands.executeCommand('mysti.openInNewTab'); await bindNewPanel(label, before.tabs, before.frames);
      const frame = panels.get(label)!.frame; await frame.locator('#new-conversation-btn').click();
      await until('New conversation has a host identity', async () => (await events(label, 'conversationChanged')).length > 0);
      panels.get(label)!.id = (await events(label, 'conversationChanged')).at(-1).payload.id;
    }
    async function history(label: string): Promise<any[]> {
      const frame = await reveal(label), count = (await events(label, 'conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      await frame.locator('#history-btn').click(); await until('History returns actual records', async () => (await events(label, 'conversationHistory')).length > count);
      const result = (await events(label, 'conversationHistory')).at(-1).payload.conversations; await frame.locator('#history-btn').click(); return result;
    }
    async function snapshot(label: string, id = panels.get(label)!.id): Promise<any> { const result = (await history(label)).find(value => value.id === id); assert.ok(result); return result; }
    async function action(label: string, selector: string): Promise<void> { const frame = await reveal(label); await frame.locator('#tools-menu-btn').click(); await frame.locator(selector).click(); }
    async function slashShare(label: string): Promise<void> {
      const frame = await reveal(label); await frame.locator('#message-input').fill('/share');
      await frame.locator('#slash-menu .slash-menu-item[data-command-id="cmd:share"]').click();
    }
    async function resultAfter(label: string, before: number): Promise<any> {
      await until('Transfer operation returns owned acknowledgement', async () => (await events(label, 'exportResult')).length > before);
      const result = (await events(label, 'exportResult')).at(-1).payload;
      assert.ok(typeof result.requestId === 'string' && result.requestId.length > 0); return result;
    }
    async function fileDialog(label: string, selector: string, destination?: string): Promise<any> {
      const before = (await events(label, 'exportResult')).length; await action(label, selector);
      const input = workbench.locator('.quick-input-widget input[type="text"]'); await input.waitFor({ state: 'visible' });
      if (destination) { await input.fill(destination); await input.press('Enter'); } else { await input.press('Escape'); }
      await input.waitFor({ state: 'hidden' });
      const result = await resultAfter(label, before); assert.strictEqual(result.success, !!destination);
      if (!destination) { assert.strictEqual(result.cancelled, true); }
      if (selector.startsWith('#export-')) { assert.strictEqual(result.operation, 'file'); assert.strictEqual(result.format, selector === '#export-json-btn' ? 'json' : 'markdown'); }
      record('file-dialog', { label, selector, destination: destination || null, result }); return result;
    }
    async function importFile(label: string, file: string): Promise<any> {
      const count = (await events(label, 'conversationChanged')).length;
      await fileDialog(label, '#import-conversation-btn', file);
      await until('Imported conversation activates', async () => (await events(label, 'conversationChanged')).length > count);
      const imported = (await events(label, 'conversationChanged')).at(-1).payload; panels.get(label)!.id = imported.id;
      if (file === manifest.exports.json || file === manifest.exports.markdown) {
        await until('Imported limitations are owned by the new conversation', async () => (await events(label, 'conversationImportNotice')).some(value => value.payload.conversationId === imported.id));
        const notice = (await events(label, 'conversationImportNotice')).filter(value => value.payload.conversationId === imported.id).at(-1).payload;
        assert.ok(typeof notice.notice === 'string' && notice.notice.length > 0);
        assert.strictEqual(await panels.get(label)!.frame.locator('#export-toast').evaluate(element => element.classList.contains('visible')), true);
        record('visible-import-notice', { label, conversationId: imported.id, notice: notice.notice });
      }
      return imported;
    }
    async function ownedCliUri(uri: string): Promise<void> {
      const parsed = vscode.Uri.parse(uri), canonicalUri = parsed.toString();
      const helperAuthority = 'MystiValidation.pc11-transfer-runner';
      assert.ok(parsed.authority === helperAuthority || parsed.authority === 'DeepMyst.mysti');
      assert.strictEqual(parsed.path, parsed.authority === helperAuthority ? '/preflight' : '/import');
      const extension = vscode.extensions.getExtension(parsed.authority); assert.ok(extension);
      const expectedMessage = `Allow '${extension.packageJSON.displayName || extension.packageJSON.name}' extension to open this URI?`;
      lastOwnedUri = { authority: parsed.authority, canonical: canonicalUri, sha256: hash(canonicalUri) };
      const binary = path.join(repo, '.vscode-test/vscode-darwin-arm64-1.141.0/Visual Studio Code.app/Contents/MacOS/Code');
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      await execFileAsync(binary, [`--user-data-dir=${owner.profile}`, `--shared-data-dir=${owner.sharedDataDir}`, `--extensions-dir=${owner.extensionsDir}`, '--open-url', '--', uri], { env, timeout: 20000, maxBuffer: 1024 * 1024 });
      record('owned-uri-dispatch', { profile: owner.profile, authority: vscode.Uri.parse(uri).authority, path: vscode.Uri.parse(uri).path, uriSha256: hash(uri), osOpenExternalUsed: false });
      const dialog = workbench.locator('.monaco-dialog-box[role="dialog"]').filter({ has: workbench.locator('.dialog-message-text', { hasText: expectedMessage }) });
      await dialog.waitFor({ state: 'visible', timeout: 20000 });
      assert.strictEqual(await dialog.locator('.dialog-message-text').innerText(), expectedMessage);
      const exactDetailCount = await dialog.locator('[title], [aria-label]').evaluateAll((elements, expected) => elements.filter(element => element.getAttribute('title') === expected || element.getAttribute('aria-label') === expected).length, canonicalUri);
      assert.ok(exactDetailCount > 0, 'URI gate must expose the exact expected synthetic URI and extension authority');
      const checkbox = dialog.getByRole('checkbox'); assert.strictEqual(await checkbox.count(), 1); assert.strictEqual(await checkbox.isChecked(), false);
      await dialog.getByRole('button', { name: 'Open', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      record('owned-uri-gate-opened', { profile: owner.profile, authority: parsed.authority, uriSha256: hash(canonicalUri), exactDetailMatched: true, trustCheckboxChecked: false });
    }
    async function captureFailureEvidence(): Promise<void> {
      if (!owner || !workbench || fs.existsSync(path.join(owner.directory, 'failure.png'))) { return; }
      await workbench.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {});
      const dialogs = await workbench.locator('.monaco-dialog-box[role="dialog"]:visible').evaluateAll((elements, expected) => elements.map(element => {
        const message = element.querySelector('.dialog-message-text')?.textContent || '';
        return { extensionUriGate: /^Allow '.+' extension to open this URI\?$/.test(message),
          expectedUriDetailPresent: !!expected && [...element.querySelectorAll('[title], [aria-label]')].some(value => value.getAttribute('title') === expected || value.getAttribute('aria-label') === expected),
          buttonLabels: [...element.querySelectorAll('[role="button"], button')].map(value => (value.textContent || '').slice(0, 80)),
          checkboxStates: [...element.querySelectorAll('[role="checkbox"]')].map(value => value.getAttribute('aria-checked')) };
      }), lastOwnedUri?.canonical || '').catch(() => []);
      record('failure-owned-dialog-evidence', { lastUriAuthority: lastOwnedUri?.authority, lastUriSha256: lastOwnedUri?.sha256, dialogs });
    }
    async function select(label: string, provider: string): Promise<Frame> {
      const frame = await reveal(label); await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent=${JSON.stringify(provider)}]:not(.disabled)`).click();
      await until('Native provider selection', async () => (await frame.locator('#agent-name').innerText()).includes(provider === 'claude-code' ? 'Claude' : 'Codex')); return frame;
    }
    async function submit(label: string, marker: string, provider: string, task: string, long = false): Promise<number> {
      assert.ok(receipts().filter(value => value.event === 'request').length < (windowId === 'A' ? 2 : 5));
      const frame = await select(label, provider), offset = (await events(label)).length;
      const prompt = `PC11_REQUEST:${marker}\n${task}\n${long ? 'Give 80 numbered review points, each 25–35 words, covering distinct practical failure cases. Do not stop early.' : 'Reply in 40–90 words; include one JavaScript code block when useful.'} Include the exact fixture token and end with PC11_DONE:${marker}. Do not ask questions. ${marker === 'SOURCE_1' ? 'Use only Read for the exact requested file. Do not edit files or run shell commands.' : 'No tools, shell commands, file access or changes. Use only supplied text and this conversation.'}`;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      await until('Real CLI receives the owning request', async () => receipts().some(value => value.event === 'request' && value.markers.includes(marker)));
      await until('Actual response begins', async () => (await events(label)).slice(offset).some(value => value.type === 'responseStarted'));
      record('request-submitted', { label, marker, provider, offset, conversationId: panels.get(label)!.id,
        receipt: receipts().filter(value => value.event === 'request' && value.markers.includes(marker)).at(-1) }); return offset;
    }
    async function healthy(label: string, offset: number, allowRead = false): Promise<any[]> {
      const frame = panels.get(label)!.frame, values = (await events(label)).slice(offset);
      for (const event of values.filter(value => value.type === 'permissionRequest')) {
        const request = event.payload, input = request.details?.toolInput || {}, file = input.file_path || input.path || request.details?.filePath;
        const card = frame.locator(`.permission-card[data-id=${JSON.stringify(request.id)}]`);
        if (!await card.locator('[data-action="approve"]').isVisible()) { continue; }
        const approved = allowRead && String(request.details?.toolName).toLowerCase() === 'read' && typeof file === 'string' && path.resolve(owner.workspace, file) === path.join(owner.workspace, 'src/issues.cjs');
        await card.locator(`[data-action="${approved ? 'approve' : 'deny'}"]`).click(); assert.ok(approved, 'Denied a request outside the sole owned Read scope');
      }
      assert.deepStrictEqual(values.filter(value => ['error', 'authError'].includes(value.type)).map(value => value.type), []); return values;
    }
    async function finish(label: string, marker: string, provider: string, offset: number, token: string): Promise<any> {
      await until('Native response completes', async () => (await healthy(label, offset, marker === 'SOURCE_1')).some(value => value.type === 'responseComplete'), 240000);
      const fresh = await healthy(label, offset, marker === 'SOURCE_1'), terminal = fresh.filter(value => value.type === 'responseComplete');
      assert.strictEqual(terminal.length, 1); assert.strictEqual(fresh.filter(value => value.type === 'requestCancelled').length, 0);
      const message = terminal[0].payload.message; assert.ok(message); assert.strictEqual(message.provider, provider);
      assert.strictEqual(message.model, provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol');
      assert.ok(message.content.includes(token)); assert.ok(message.content.includes(`PC11_DONE:${marker}`));
      if (marker === 'SOURCE_1') {
        assert.ok(message.toolCalls?.length); assert.ok(message.segments?.some((value: any) => value.type === 'tool'));
        assert.ok(message.toolCalls.every((tool: any) => String(tool.name).toLowerCase() === 'read' && tool.status === 'completed' && path.resolve(owner.workspace, tool.input?.file_path || tool.input?.path || '') === path.join(owner.workspace, 'src/issues.cjs')));
      } else { assert.strictEqual(fresh.filter(value => value.type === 'toolUse' || value.type === 'permissionRequest').length, 0); }
      record('native-response', { label, marker, provider, model: message.model, content: message.content, messageId: message.id, messageSha256: digest(message), terminalAt: terminal[0].at }); return terminal[0];
    }
    async function send(label: string, marker: string, provider: string, task: string): Promise<any> {
      return finish(label, marker, provider, await submit(label, marker, provider, task), manifest.token);
    }
    async function expectClipboard(textOrJson: string | object): Promise<void> {
      const result = await guard!.request(typeof textOrJson === 'string' ? { action: 'expect', text: textOrJson } : { action: 'expect-json', expected: textOrJson });
      assert.strictEqual(result.ok, true, 'A changed user clipboard blocks further test copies');
    }
    async function claimClipboard(): Promise<void> { const result = await guard!.request({ action: 'claim' }); assert.strictEqual(result.ok, true); record('clipboard-owned-copy', result); }
    async function sourceStable(label: string): Promise<any> {
      await until('Source title and checkpoints settle', async () => {
        const conversation = await snapshot(label);
        return (await events(label, 'titleUpdated')).some(value => value.payload.conversationId === conversation.id)
          && conversation.messages.filter((value: any) => value.role === 'user').every((value: any) => value.checkpoint?.commit);
      }); return snapshot(label);
    }

    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PC11_ARTIFACT_DIR!, 'prepared.json'), 'utf8')); owner = manifest.windows[windowId];
      assert.strictEqual(manifest.case, 'PC-11'); assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
      assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension));
      if ((extension as any).isUnderDevelopment !== undefined) { assert.strictEqual((extension as any).isUnderDevelopment, false); }
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256); await extension.activate();
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) { if (await page.locator('.monaco-workbench').count()) { workbench = page; break; } }
      assert.ok(workbench); workbench.setDefaultTimeout(15000); await createPanel('main');
      record('identity', { profile: owner.profile, extensionHostPid: process.pid, bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256, scope: manifest.scope, extensionTestsPathUsed: false,
        isUnderDevelopment: (extension as any).isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API' });
      vscode.commands.registerCommand('mystiValidation.pc11.retryClipboardRestore', async () => {
        assert.ok(guard && fs.existsSync(path.join(owner.directory, 'clipboard-restore-failed.json')), 'Only a retained guard from this owned helper may be retried');
        const result = await quitClipboardGuard();
        signedRecovery('clipboard-recovered.json', { status: 'RECOVERED_AFTER_FAILED_ATTEMPT', result });
        record('clipboard-recovery', result);
        await vscode.commands.executeCommand('workbench.action.quit');
        return result;
      });
      if (manifest.mode === 'ack-smoke') {
        assert.strictEqual(windowId, 'A'); assert.deepStrictEqual(Object.keys(manifest.windows), ['A']);
        assert.strictEqual(manifest.conversationalRequestsPlanned, 0); return;
      }
      if (windowId === 'B') {
        await ownedCliUri(`vscode://MystiValidation.pc11-transfer-runner/preflight?nonce=${manifest.uriPreflightNonce}`);
        const preflight = await waitFile(path.join(owner.directory, 'uri-routing-preflight.json'), 20000);
        assert.strictEqual(preflight.profile, owner.profile); assert.strictEqual(preflight.extensionHostPid, process.pid); assert.strictEqual(preflight.nonce, manifest.uriPreflightNonce);
        fs.writeFileSync(path.join(manifest.artifactDir, 'receiver-ready.json'), JSON.stringify(preflight));
      } else { await waitFile(path.join(manifest.artifactDir, 'receiver-ready.json'), 90000); }
    });

    it(process.env.MYSTI_PC11_ACK_ONLY === '1' ? 'imports JSON, framed Markdown and JSONL with honest acknowledgements and cancellation, without inference' : 'round-trips real native conversation data using actual menus, dialogs, clipboard and owned URI dispatch', async () => {
      if (manifest.mode === 'ack-smoke') {
        const imports: any[] = [], requestIds = new Set<string>();
        for (const fixture of manifest.acknowledgementFixtures) {
          assert.strictEqual(hash(fs.readFileSync(fixture.file)), fixture.sha256);
          const priorId = panels.get('main')!.id, imported = await importFile('main', fixture.file);
          const acknowledgement = (await events('main', 'exportResult')).at(-1).payload;
          assert.strictEqual(acknowledgement.operation, 'import'); assert.strictEqual(acknowledgement.success, true);
          assert.strictEqual(acknowledgement.conversationId, priorId);
          assert.strictEqual(Object.prototype.hasOwnProperty.call(acknowledgement, 'format'), false, 'Import acknowledgement must not invent a selected output format');
          assert.ok(!requestIds.has(acknowledgement.requestId)); requestIds.add(acknowledgement.requestId);
          same(imported.messages.map((message: any) => ({ role: message.role, content: message.content })), fixture.messages);
          const frame = await reveal('main'), rendered = frame.locator('#messages .message.user, #messages .message.assistant');
          same(await rendered.evaluateAll(elements => elements.map(element => element.getAttribute('data-id'))), imported.messages.map((message: any) => message.id));
          const visibleProofs = [];
          for (let index = 0; index < imported.messages.length; index++) {
            const element = rendered.nth(index), expected = fixture.messages[index];
            assert.strictEqual(await element.evaluate((node, role) => node.classList.contains(role), expected.role), true);
            const visibleText = (await element.locator('.message-content').allInnerTexts()).join('\n');
            const anchors: string[] = [...new Set<string>(expected.content.match(/PC11_[A-Za-z0-9_]+(?::[A-Z0-9_]+)?/g) || [])]; assert.ok(anchors.length);
            assert.ok(anchors.every(anchor => visibleText.includes(anchor)), 'Every imported message must visibly show its own synthetic transcript markers');
            visibleProofs.push({ id: imported.messages[index].id, role: expected.role, visibleTextSha256: hash(visibleText), anchors });
          }
          const proof = { format: fixture.format, importedId: imported.id, acknowledgement, roleTextSha256: digest(fixture.messages), visibleProofs };
          imports.push(proof); record('acknowledgement-smoke-import', proof);
        }
        const beforeCancel = await history('main'), activeId = panels.get('main')!.id;
        const cancelled = await fileDialog('main', '#import-conversation-btn');
        assert.strictEqual(cancelled.operation, 'import'); assert.strictEqual(cancelled.conversationId, activeId);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(cancelled, 'format'), false);
        assert.ok(!requestIds.has(cancelled.requestId)); requestIds.add(cancelled.requestId);
        const final = await history('main'); same(final, beforeCancel);
        const allEvents = await events('main'); assert.strictEqual(allEvents.filter(value => ['responseStarted', 'responseComplete', 'error', 'authError'].includes(value.type)).length, 0);
        assert.strictEqual(receipts().filter(value => ['request', 'auxiliary-input'].includes(value.event)).length, 0);
        const blockedInferenceLaunches = receipts().filter(value => value.event === 'inference-launch-refused').map(value => ({ provider: value.provider, at: value.at, wrapperPid: value.wrapperPid, reason: value.reason, invocationKind: value.invocationKind }));
        const readOnlyVersionProbeLaunches = receipts().filter(value => value.event === 'read-only-probe-start').length;
        assert.strictEqual(guard, undefined);
        fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify({ status: 'PASS_NATIVE_IMPORT_ACKNOWLEDGEMENTS', mode: manifest.mode, imports, cancelled,
          finalConversations: final.map(value => ({ id: value.id, canonicalSha256: digest(value) })), conversationalInputs: 0, auxiliaryInputs: 0, blockedInferenceLaunches, readOnlyVersionProbeLaunches, clipboardAccessed: false,
          limits: ['No inference; this acknowledgement smoke supplements native-retry1 and does not replay its seven conversational requests.', 'Actual public file dialogs and rendered imported transcripts in one fresh ordinary profile.', 'Only exact --version CLI probes can reach a backend; every other startup/prewarm, auxiliary or unknown invocation is blocked before backend launch and reported separately from actual inputs.'] }, null, 2));
        record('acknowledgement-smoke-no-inference', { conversationalInputs: 0, auxiliaryInputs: 0, blockedInferenceLaunches, readOnlyVersionProbeLaunches });
        completed = true; return;
      }
      if (windowId === 'A') {
        const frame = await reveal('main');
        // Real attachment picker, not attachment-state injection.
        await frame.locator('#attach-btn').click();
        const picker = workbench.locator('.quick-input-widget input[type="text"]'); await picker.waitFor({ state: 'visible' });
        await picker.fill(path.join(owner.workspace, 'README.md')); await picker.press('Enter'); await picker.waitFor({ state: 'hidden' });
        await until('Attachment card arrives', async () => (await events('main', 'fileAttachmentSelected')).length > 0);
        await send('main', 'SOURCE_1', 'claude-code', `Read exactly ${path.join(owner.workspace, 'src/issues.cjs')}. Explain the original open-only rule, include the complete current function in a JavaScript code block, and use the file's fixture token. The attached README is developer context.`);
        await send('main', 'SOURCE_2', 'openai-codex', 'Review the preceding Claude answer. Keep the open-only requirement. Give a concrete regression assertion for closed issues and explain why it catches accidental inclusion. Repeat the fixture token already read.');
        const source = await sourceStable('main'); assert.strictEqual(source.messages.length, 4);
        assert.ok(source.messages[0].attachments?.length); assert.deepStrictEqual(source.messages.filter((value: any) => value.role === 'assistant').map((value: any) => value.provider), ['claude-code', 'openai-codex']);
        const idsBefore = (await history('main')).map(value => value.id).sort();
        await fileDialog('main', '#export-json-btn'); await fileDialog('main', '#import-conversation-btn');
        same((await history('main')).map(value => value.id).sort(), idsBefore); same(await snapshot('main'), source);
        for (const [selector, file] of [['#export-json-btn', manifest.exports.json], ['#export-markdown-btn', manifest.exports.markdown]]) { await fileDialog('main', selector, file); assert.ok(fs.existsSync(file)); }
        const json = JSON.parse(fs.readFileSync(manifest.exports.json, 'utf8')); assert.strictEqual(json.format, 'mysti'); assert.strictEqual(json.version, 1); same(json.conversation, source);
        const savedMarkdown = fs.readFileSync(manifest.exports.markdown, 'utf8'); assert.ok(savedMarkdown.startsWith('<!-- mysti-transcript-v1 '));
        guard = new NativeClipboardGuard(path.join(repo, 'scripts/validation/clipboard-guard.swift'));
        assert.strictEqual((await guard.request({ action: 'capture' })).ok, true);
        let count = (await events('main', 'exportResult')).length; await expectClipboard(markdown(source));
        await action('main', '[data-composer-action="export-conversation-btn"]'); assert.strictEqual((await resultAfter('main', count)).success, true);
        await claimClipboard();
        const assistant = source.messages.find((value: any) => value.role === 'assistant'); count = (await events('main', 'exportResult')).length;
        await expectClipboard(markdown(source, assistant)); await frame.locator(`.message-copy-btn[data-message-id=${JSON.stringify(assistant.id)}]`).click();
        assert.strictEqual((await resultAfter('main', count)).success, true); await claimClipboard();
        const compact = { t: source.title.slice(0, 200), p: source.provider, m: source.messages.map((value: any) => ({ r: value.role === 'user' ? 'u' : 'a', c: value.content.slice(0, 2000) })) };
        const uri = `vscode://DeepMyst.mysti/import?data=${deflateSync(Buffer.from(JSON.stringify(compact))).toString('base64url')}`;
        assert.ok(uri.length <= 2000 && source.messages.every((value: any) => value.content.length <= 2000));
        count = (await events('main', 'exportResult')).length; await expectClipboard(uri); await slashShare('main');
        const shareResult = await resultAfter('main', count); assert.strictEqual(shareResult.success, true); assert.ok(shareResult.notice, 'Structured-source share must state its text-only limitations'); await claimClipboard();
        const long = await importFile('main', manifest.exports.longInput); assert.strictEqual(long.messages.length, 14);
        count = (await events('main', 'exportResult')).length; await expectClipboard({ format: 'mysti', version: 1, conversation: long }); await slashShare('main');
        const fallback = await resultAfter('main', count); assert.strictEqual(fallback.success, true); assert.strictEqual(fallback.format, 'json'); assert.ok(fallback.notice);
        await claimClipboard();
        record('long-share-full-json', { messageCount: long.messages.length, longestMessage: Math.max(...long.messages.map((value: any) => value.content.length)), fullConversationSha256: digest(long), notice: fallback.notice });
        const cleanup = await quitClipboardGuard(); assert.ok(cleanup.restored || cleanup.preservedNewerClipboard); record('clipboard-cleanup', cleanup);
        const final = await history('main'); same(final.find(value => value.id === source.id), source);
        const ready = { source, uri, shortShare: compact, exports: manifest.exports, finalConversations: final.map(value => ({ id: value.id, canonicalSha256: digest(value) })),
          jsonSha256: hash(fs.readFileSync(manifest.exports.json)), markdownSha256: hash(savedMarkdown), clipboardCleanup: cleanup };
        // The owned synthetic transcript retains exported metadata for exact
        // JSON fidelity checks. Assertion logs print hashes rather than fields.
        fs.writeFileSync(path.join(manifest.exchange, 'source-ready.json'), JSON.stringify(ready, null, 2));
        record('source-transfer-ready', { sourceId: source.id, sourceSha256: digest(source), jsonSha256: ready.jsonSha256, markdownSha256: ready.markdownSha256 });
      } else {
        const ready = await waitFile(path.join(manifest.exchange, 'source-ready.json'));
        const fromMarkdown = await importFile('main', manifest.exports.markdown);
        same(fromMarkdown.messages.map((value: any) => ({ role: value.role, content: value.content })), ready.source.messages.map((value: any) => ({ role: value.role, content: value.content })));
        assert.notStrictEqual(fromMarkdown.id, ready.source.id); record('markdown-roundtrip', { id: fromMarkdown.id, transcriptSha256: digest(fromMarkdown.messages.map((value: any) => ({ role: value.role, content: value.content }))) });
        const imported = await importFile('main', manifest.exports.json); assertJsonImport(imported, ready.source);
        record('json-roundtrip', { id: imported.id, sourceId: ready.source.id, semanticSha256: digest(imported.messages.map(messageSemantics)), attachments: imported.messages[0].attachments?.length || 0, toolCount: imported.messages.reduce((sum: number, value: any) => sum + (value.toolCalls?.length || 0), 0) });
        await send('main', 'IMPORT_CONTINUE', 'claude-code', 'Continue this imported multi-agent review. State the open-only filter predicate and one useful assertion; use the fixture token inherited from the conversation.');
        const beforeActive = await snapshot('main'), oldId = beforeActive.id;
        await createPanel('sibling');
        const siblingOffset = await submit('sibling', 'SIBLING_LIVE', 'openai-codex', `Review a retry utility with retryBaseMs=73, an abort signal and bounded exponential backoff. Your separate fixture token is ${manifest.siblingToken}.`, true);
        const oldOffset = await submit('main', 'ACTIVE_IMPORT', 'claude-code', 'Extend the issue-filter review into a detailed implementation checklist. Use the inherited fixture token.', true);
        for (const [label, offset] of [['sibling', siblingOffset], ['main', oldOffset]] as const) { assert.strictEqual((await healthy(label, offset)).filter(value => ['responseComplete', 'requestCancelled'].includes(value.type)).length, 0); }
        const importPreparedAt = Date.now(); const freshImport = await importFile('main', manifest.exports.json);
        const changedAt = (await events('main', 'conversationChanged')).at(-1).at;
        assertJsonImport(freshImport, ready.source);
        assert.ok(changedAt >= importPreparedAt);
        const mainEvents = (await events('main')).slice(oldOffset);
        assert.ok(mainEvents.some(value => value.type === 'sessionCleared' && value.at >= changedAt));
        assert.strictEqual(await panels.get('main')!.frame.locator('#stop-btn').isVisible(), false);
        assert.strictEqual(mainEvents.filter(value => value.type === 'responseComplete').length, 0);
        const oldHistory = await snapshot('main', oldId); same(oldHistory.messages.slice(0, beforeActive.messages.length), beforeActive.messages);
        assert.ok(oldHistory.messages.some((value: any) => value.role === 'user' && value.content.includes('PC11_REQUEST:ACTIVE_IMPORT')));
        assert.strictEqual((await events('main')).filter(value => value.at > changedAt && ['responseChunk', 'responseComplete'].includes(value.type)).length, 0, 'Old turn must not stream into the imported chat before its new request');
        const oldRequest = receipts().filter(value => value.event === 'request' && value.markers.includes('ACTIVE_IMPORT')).at(-1); assert.ok(oldRequest);
        record('active-import-owner-reset', { oldId, importedId: freshImport.id, changedAt, originalPrefixSha256: digest(beforeActive.messages), oldMessageCount: oldHistory.messages.length,
          preservedPartialAssistantCount: oldHistory.messages.slice(beforeActive.messages.length).filter((value: any) => value.role === 'assistant').length,
          oldWorkerExitAlreadyObserved: receipts().some(value => value.event === 'exit' && value.wrapperPid === oldRequest.wrapperPid), oldWrapperPid: oldRequest.wrapperPid,
          cancellationEvidence: 'Owned conversationChanged/sessionCleared and cleared loading; no old completion/new-chat stream; native context reset verified by next input markers.' });
        await send('main', 'AFTER_IMPORT', 'openai-codex', 'Use ONLY this imported conversation. Give the exact open-only predicate and repeat the inherited fixture token; do not continue another chat\'s implementation checklist.');
        const recoveryRequest = receipts().filter(value => value.event === 'request' && value.markers.includes('AFTER_IMPORT')).at(-1);
        assert.ok(recoveryRequest, 'Native recovery request must have an actual CLI receipt');
        assert.ok(recoveryRequest.markerOrigins, 'Native request origin evidence must exist');
        assert.ok(['ACTIVE_IMPORT', 'IMPORT_CONTINUE', 'SIBLING_LIVE'].every(marker => !recoveryRequest.markerOrigins.outsideProjectMemoryMarkers.includes(marker)));
        record('recovery-native-context', { markerOrigins: recoveryRequest.markerOrigins, sessionHash: recoveryRequest.sessionHash });
        const siblingDone = await finish('sibling', 'SIBLING_LIVE', 'openai-codex', siblingOffset, manifest.siblingToken);
        assert.ok(siblingDone.at > changedAt, 'Sibling native task must survive and complete after the actual import');
        assert.ok(!(await snapshot('main')).messages.some((value: any) => value.content.includes(manifest.siblingToken)));
        const beforeUri = await history('main'), beforeUriIds = beforeUri.map(value => value.id).sort();
        await ownedCliUri(ready.uri); await workbench.getByRole('button', { name: 'Cancel', exact: true }).click();
        // Let the real confirmation handler settle; use an explicit history
        // round-trip before comparing IDs, not a seeded host acknowledgement.
        await until('URI cancellation dialog closes', async () => !await workbench.getByRole('button', { name: 'Import conversation', exact: true }).isVisible());
        same((await history('main')).map(value => value.id).sort(), beforeUriIds);
        const before = beforePanel(); await ownedCliUri(ready.uri);
        await workbench.getByRole('button', { name: 'Import conversation', exact: true }).click();
        await bindNewPanel('uri', before.tabs, before.frames);
        const afterUri = await history('uri'); const added = afterUri.filter(value => !beforeUriIds.includes(value.id)); assert.strictEqual(added.length, 1);
        const shared = added[0]; panels.get('uri')!.id = shared.id;
        const renderedIds = await panels.get('uri')!.frame.locator('#messages .message.user, #messages .message.assistant').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')));
        same(renderedIds, shared.messages.map((value: any) => value.id));
        same(shared.messages.map((value: any) => ({ r: value.role === 'user' ? 'u' : 'a', c: value.content })), ready.shortShare.m);
        assert.ok(shared.messages.every((value: any) => !ready.source.messages.some((source: any) => source.id === value.id)));
        for (const prior of beforeUri) { same(afterUri.find(value => value.id === prior.id), prior); }
        record('actual-uri-import', { importedId: shared.id, priorIdsUnchanged: beforeUriIds, shareRoleTextSha256: digest(ready.shortShare.m), independentNewTab: true });
        await send('uri', 'URI_CONTINUE', 'claude-code', 'Continue this shared conversation. State what listOpen includes and excludes, repeat the fixture token, and give one concise assertion.');
        const uriRequest = receipts().filter(value => value.event === 'request' && value.markers.includes('URI_CONTINUE')).at(-1);
        assert.ok(uriRequest?.markerOrigins, 'URI continuation must have native request origin evidence');
        assert.ok(['ACTIVE_IMPORT', 'AFTER_IMPORT', 'IMPORT_CONTINUE', 'SIBLING_LIVE'].every(marker => !uriRequest.markerOrigins.outsideProjectMemoryMarkers.includes(marker)));
        record('uri-native-context', { markerOrigins: uriRequest.markerOrigins, sessionHash: uriRequest.sessionHash });
        const final = await history('uri');
        fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify({ status: 'PASS_BOUNDED_NATIVE_TRANSFER', finalConversations: final.map(value => ({ id: value.id, canonicalSha256: digest(value) })),
          finalPublicIds: final.map(value => value.id).sort(), sourceConversationId: ready.source.id, jsonImportId: imported.id, markdownImportId: fromMarkdown.id, activeImportId: freshImport.id, oldActiveId: oldId,
          sharedId: shared.id, siblingId: panels.get('sibling')!.id, importAt: changedAt, siblingCompleteAt: siblingDone.at, semanticReview: 'PENDING_ROOT_REVIEW: read every completed reply and the stopped source excerpt; marker identity alone does not prove correctness.',
          limits: ['Seven native inputs across two profiles, not full F2 or elapsed W/P.', 'JSON checkpoint references and local undo capability intentionally removed; Markdown/share preserve their documented subsets.', 'No native clipboard-denial or OS-wide URL-default-handler claim.'] }, null, 2));
      }
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, windowId === 'A' ? 2 : 5); completed = true;
    });
    afterEach(async function () {
      if (!owner) { return; } record('case-outcome', { state: this.currentTest?.state, error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message } });
      if (this.currentTest?.state === 'failed') { await captureFailureEvidence(); }
    });
    after(async () => {
      // Mocha skips afterEach when beforeAll fails. Capture this owned page
      // before normal helper shutdown so preflight failures remain reviewable.
      if (!completed) { await captureFailureEvidence(); }
      if (guard && !fs.existsSync(path.join(owner.directory, 'clipboard-restore-failed.json'))) { const cleanup = await quitClipboardGuard(); record('clipboard-cleanup', cleanup); }
      if (owner) { record('helper-finished', { completed, conversationalInputs: receipts().filter(value => value.event === 'request').length, auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length }); }
      await browser?.close().catch(() => {});
    });
  });
}
