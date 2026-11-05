/** PC-10 bounded native acceptance. Opt-in ordinary installed editor only. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { installForksObserver } from './forks-observer';

function canonical(value: any): string {
  if (Array.isArray(value)) { return '[' + value.map(canonical).join(',') + ']'; }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const digestObject = (value: any): string => digest(canonical(value));
function assertSameJson(actual: any, expected: any): void {
  // Keep raw thinking out of assertion logs while comparing every JSON field.
  assert.strictEqual(digestObject(actual), digestObject(expected), 'Exact canonical conversation/message values must match');
}

if (process.env.MYSTI_PC10 === '1') {
  describe('PC-10 real editor conversation branches and checkpoint Undo', function () {
    this.timeout(780_000);
    let browser: Browser, workbench: Page, frame: Frame, manifest: any, owner: any;
    let completed = false, sourceId: string;
    const observations: any[] = [], approvals = new Set<string>();
    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { event, at: Date.now(), ...details }; observations.push(entry);
      fs.writeFileSync(path.join(owner.directory, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-10]', JSON.stringify(entry));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 75)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    function receipts(): any[] {
      return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    }
    async function events(type?: string): Promise<any[]> {
      const result = await frame.evaluate(() => (globalThis as any).__pc10Events || []);
      return type ? result.filter((entry: any) => entry.type === type) : result;
    }
    async function history(): Promise<any[]> {
      const before = (await events('conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) { await frame.locator('#history-btn').click(); }
      await frame.locator('#history-btn').click();
      await until('Public History must return records', async () => (await events('conversationHistory')).length > before);
      const conversations = (await events('conversationHistory')).at(-1).payload.conversations;
      await frame.locator('#history-btn').click();
      return conversations;
    }
    async function snapshot(id: string): Promise<any> {
      const conversation = (await history()).find(value => value.id === id);
      assert.ok(conversation, `Conversation ${id} must remain in public history`); return conversation;
    }
    function proof(conversation: any): any {
      return { id: conversation.id, canonicalSha256: digestObject(conversation), title: conversation.title,
        createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, mode: conversation.mode, provider: conversation.provider, model: conversation.model,
        agentConfigSha256: digestObject(conversation.agentConfig || null),
        messages: conversation.messages.map((message: any) => ({ id: message.id, role: message.role, content: message.content,
          provider: message.provider, model: message.model, checkpoint: message.checkpoint,
          canonicalSha256: digestObject(message), toolCount: message.toolCalls?.length || 0,
          segmentTypes: (message.segments || []).map((segment: any) => segment.type),
          fieldDigests: Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined).map(([key, value]) => [key, digestObject(value)])) })) };
    }
    async function selectProvider(provider: string): Promise<void> {
      await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent=${JSON.stringify(provider)}]:not(.disabled)`).click();
      await until('Provider selection settles', async () => (await frame.locator('#agent-name').innerText()).includes(provider === 'claude-code' ? 'Claude' : 'Codex'));
    }
    async function switchTo(id: string): Promise<any> {
      await history(); const before = (await events('conversationChanged')).length;
      await frame.locator('#history-btn').click();
      await frame.locator(`#history-menu .history-item[data-conversation-id=${JSON.stringify(id)}] .history-item-info`).click();
      await until('History activates the requested branch', async () => (await events('conversationChanged')).length > before &&
        (await events('conversationChanged')).at(-1).payload.id === id);
      const conversation = (await events('conversationChanged')).at(-1).payload;
      const expectedIds = conversation.messages.filter((value: any) => ['user', 'assistant'].includes(value.role)).map((value: any) => value.id);
      await until('Actual DOM has the complete ordered prefix', async () => {
        const ids = await frame.locator('#messages .message.user, #messages .message.assistant').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')));
        return canonical(ids) === canonical(expectedIds);
      });
      return conversation;
    }
    async function approveOnlyOwnedRead(offset: number, allowRead: boolean): Promise<void> {
      for (const event of (await events()).slice(offset).filter(value => value.type === 'permissionRequest')) {
        const request = event.payload; if (approvals.has(request.id)) { continue; }
        const input = request.details?.toolInput || {}, name = String(request.details?.toolName || request.title || '').toLowerCase();
        const supplied = input.file_path || input.path || request.details?.filePath;
        const exact = typeof supplied === 'string' && path.resolve(owner.workspace, supplied) === path.join(owner.workspace, 'src/issues.cjs');
        const approved = allowRead && name === 'read' && exact;
        await frame.locator(`.permission-card[data-id=${JSON.stringify(request.id)}] [data-action="${approved ? 'approve' : 'deny'}"]`).click();
        approvals.add(request.id); record('permission-decision', { approved, name, exactOwnedPath: exact });
        assert.ok(approved, 'A native request outside the single owned Read scope was denied');
      }
    }
    async function send(marker: string, provider: string, task: string, allowRead = false): Promise<any> {
      assert.ok(receipts().filter(value => value.event === 'request').length < 5, 'Five conversational input cap');
      await selectProvider(provider);
      const offset = (await events()).length;
      const prompt = `PC10_REQUEST:${marker}\n${task}\nReply in 40–90 words. Include the exact fixture token and end with PC10_DONE:${marker}. Do not ask a question. ${allowRead ? 'Use only the Read tool for the specified file. Do not change files or run shell commands.' : 'Use the existing conversation only. No tools, file access, shell commands or changes.'}`;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      await until(`${marker} native reply`, async () => {
        await approveOnlyOwnedRead(offset, allowRead);
        const fresh = (await events()).slice(offset);
        assert.deepStrictEqual(fresh.filter(value => ['authError', 'error', 'requestCancelled'].includes(value.type)).map(value => value.type), [], 'Native response must not fail or be cancelled');
        return fresh.some(value => value.type === 'responseComplete');
      }, 150_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(offset), terminals = fresh.filter(value => value.type === 'responseComplete');
      assert.strictEqual(terminals.length, 1); assert.strictEqual(fresh.filter(value => value.type === 'responseStarted').length, 1);
      const message = terminals[0].payload.message; assert.ok(message);
      assert.strictEqual(message.provider, provider); assert.strictEqual(message.model, provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol');
      assert.ok(message.content.includes(manifest.token)); assert.ok(message.content.includes(`PC10_DONE:${marker}`));
      if (allowRead) {
        assert.ok((message.toolCalls || []).length > 0, 'First native response must persist an actual tool result');
        assert.ok((message.segments || []).some((segment: any) => segment.type === 'tool'), 'Actual structured tool segment must be present');
        for (const tool of message.toolCalls) {
          assert.strictEqual(String(tool.name).toLowerCase(), 'read', 'Every actual tool must be the assigned Read');
          assert.strictEqual(tool.status, 'completed');
          assert.strictEqual(path.resolve(owner.workspace, tool.input?.file_path || tool.input?.path || ''), path.join(owner.workspace, 'src/issues.cjs'));
        }
      } else {
        assert.strictEqual(fresh.filter(value => value.type === 'toolUse' || value.type === 'permissionRequest').length, 0, 'Follow-up must use only the conversation');
      }
      const requests = receipts().filter(value => value.event === 'request' && value.at >= fresh[0].at - 1000 && value.markers.includes(marker));
      assert.strictEqual(requests.length, 1); assert.strictEqual(requests[0].provider, provider);
      assert.strictEqual(requests[0].model, provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol');
      if (marker === 'SOURCE_CONTINUE') { assert.ok(!requests[0].markers.includes('BRANCH_ALT'), 'Original native input may not inherit the alternate branch prompt'); }
      if (marker === 'BRANCH_ALT') { assert.ok(!requests[0].markers.includes('SOURCE_CONTINUE'), 'Branch native input may not contain the original continuation'); }
      const assistant = frame.locator('#messages .message.assistant').last();
      assert.strictEqual(await assistant.getAttribute('data-provider'), provider);
      assert.ok((await assistant.locator('.message-content').allTextContents()).join('\n').includes(manifest.token));
      record('native-response', { marker, provider, model: message.model, id: message.id, content: message.content,
        toolCount: message.toolCalls?.length || 0, segmentTypes: (message.segments || []).map((segment: any) => segment.type),
        messageSha256: digestObject(message), receipt: requests[0], terminalAt: terminals[0].at });
      // Await the exact owned user anchor's checkpoint before copying history.
      const user = fresh.filter(value => value.type === 'messageAdded').map(value => value.payload.message || value.payload).find(value => value.role === 'user');
      assert.ok(user?.id);
      await until('Current turn checkpoint persisted', async () => (await events('checkpointCreated')).some(value => value.payload.messageId === user.id), 30_000);
      return message;
    }
    async function menu(messageId: string, action: 'fork' | 'fork-rewind'): Promise<void> {
      const button = frame.locator(`.message-rewind-btn[data-message-id=${JSON.stringify(messageId)}]`);
      await button.scrollIntoViewIfNeeded(); await button.click();
      const item = frame.locator(`#rewind-menu [data-action=${JSON.stringify(action)}]`);
      assert.strictEqual(await item.isEnabled(), true);
      await item.click();
    }
    function files(): Record<string, string> {
      const result: Record<string, string> = {};
      function visit(folder: string): void {
        for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
          if (item.name === '.git') { continue; }
          const file = path.join(folder, item.name);
          if (item.isDirectory()) { visit(file); } else { assert.ok(item.isFile()); result[path.relative(owner.workspace, file)] = fs.readFileSync(file, 'utf8'); }
        }
      }
      visit(owner.workspace); return result;
    }
    function index(): string { return execFileSync('git', ['ls-files', '--stage'], { cwd: owner.workspace, encoding: 'utf8' }); }
    async function editOwnedFile(relative: string, content: string): Promise<void> {
      const uri = vscode.Uri.file(path.join(owner.workspace, relative));
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true); assert.strictEqual(await doc.save(), true);
    }

    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PC10_ARTIFACT_DIR!, 'prepared.json'), 'utf8'));
      assert.strictEqual(manifest.case, 'PC-10'); owner = manifest.windows.A;
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
      assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      assert.ok(!fs.existsSync(path.join(owner.directory, 'observations.json')));
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, 0);
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension));
      assert.strictEqual(digest(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(digest(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      await extension.activate();
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      const oldFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('Actual detached chat mounts', async () => {
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (oldFrames.has(candidate)) { continue; }
          try {
            if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count()
              && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { candidates.push(candidate); }
          } catch { /* Real webview is still mounting. */ }
        }
        if (candidates.length !== 1) { return false; } frame = candidates[0]; return true;
      });
      await workbench.bringToFront();
      if (await frame.locator('.wizard-skip-btn').isVisible()) { await frame.locator('.wizard-skip-btn').click(); }
      await frame.evaluate(installForksObserver);
      await frame.locator('#new-conversation-btn').click();
      await until('Real conversation identity', async () => (await events('conversationChanged')).length > 0);
      sourceId = (await events('conversationChanged')).at(-1).payload.id;
      assert.deepStrictEqual(files(), manifest.files); assert.strictEqual(index(), manifest.originalIndex);
      record('identity', { profile: owner.profile, workspace: owner.workspace, extensionHostPid: process.pid,
        bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256, sourceId, scope: manifest.scope, extensionTestsPathUsed: false });
    });

    it('preserves original history and metadata across a Codex fork, then rewinds and undoes owned developer edits', async () => {
      const issuePath = path.join(owner.workspace, 'src/issues.cjs');
      await send('SOURCE_1', 'claude-code', `Read exactly ${issuePath}. Explain what listOpen does and suggest one regression assertion for closed issues. Identify the fixture token from the file.`, true);
      await until('Initial asynchronous title settles', async () => (await events('titleUpdated')).some(value => value.payload.conversationId === sourceId), 20_000);
      await send('SOURCE_2', 'claude-code', 'For the same issue tracker, keep the existing open-only rule. Explain the empty-array and unknown-status behavior, using the fixture token read previously.');
      await send('SOURCE_3', 'claude-code', 'Keep the original open-only requirement. Give a precise two-case acceptance checklist and repeat the previously read fixture token.');
      const original = await snapshot(sourceId); assert.strictEqual(original.messages.length, 6);
      assert.strictEqual(original.messages[4].role, 'user'); assert.strictEqual(original.messages[5].role, 'assistant');
      const anchor = original.messages[4]; assert.ok(anchor.checkpoint?.commit);
      assert.ok(original.messages.slice(0, 5).some((value: any) => value.toolCalls?.length && value.segments?.some((segment: any) => segment.type === 'tool')));
      assert.strictEqual(await frame.locator(`.message-rewind-btn[data-message-id=${JSON.stringify(original.messages[5].id)}]`).count(), 0);
      record('source-six-messages', { original: proof(original), publicForkAnchorOrdinal: 5,
        limit: 'Message6 is an assistant message with no reachable fork button; actual menu action selects user message5.' });
      const initialHistoryIds = (await history()).map(value => value.id).sort();
      const beforeFork = (await events('conversationChanged')).length;
      await menu(anchor.id, 'fork');
      await until('Actual fork activates', async () => (await events('conversationChanged')).length > beforeFork);
      const branch = (await events('conversationChanged')).at(-1).payload;
      assert.notStrictEqual(branch.id, sourceId); assertSameJson(branch.messages, original.messages.slice(0, 5));
      for (const field of ['mode', 'provider', 'model', 'agentConfig']) { assert.deepStrictEqual(branch[field], original[field]); }
      assertSameJson(await snapshot(sourceId), original);
      assert.deepStrictEqual(files(), manifest.files); assert.strictEqual(index(), manifest.originalIndex);
      record('fork-prefix', { original: proof(await snapshot(sourceId)), branch: proof(branch), sourceId, anchorId: anchor.id });
      await send('BRANCH_ALT', 'openai-codex', 'Alternate branch requirement: listOpen must include BOTH open and triaged issues, while excluding closed and unknown statuses. Propose the exact predicate and a two-case regression test. Use the inherited fixture token; do not inspect files.');
      const branchDone = await snapshot(branch.id); assert.strictEqual(branchDone.messages.length, 7);
      assertSameJson(branchDone.messages.slice(0, 5), original.messages.slice(0, 5));
      assertSameJson(await snapshot(sourceId), original);
      assertSameJson(await switchTo(sourceId), original);
      await send('SOURCE_CONTINUE', 'claude-code', 'Continue THIS original conversation with its original open-only requirement. State the exact predicate, explain why triaged remains excluded, and use the remembered fixture token.');
      const originalDone = await snapshot(sourceId); assert.strictEqual(originalDone.messages.length, 8);
      assertSameJson(originalDone.messages.slice(0, 6), original.messages);
      assertSameJson(await snapshot(branch.id), branchDone);
      assert.deepStrictEqual(files(), manifest.files); assert.strictEqual(index(), manifest.originalIndex);
      record('independent-native-continuations', { original: proof(originalDone), branch: proof(branchDone),
        originalPrefixSha256: digestObject(originalDone.messages.slice(0, 6)), originalSixMessagesSha256: digestObject(original.messages) });

      // Real user edits after the checkpoint: modify, create and delete.
      await editOwnedFile('src/issues.cjs', manifest.files['src/issues.cjs'] + '// Later unsaved-plan work, saved by the developer before rewind.\n');
      await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(owner.workspace, 'scratch.txt')), Buffer.from('Developer work created after the selected checkpoint.\n'));
      await vscode.workspace.fs.delete(vscode.Uri.file(path.join(owner.workspace, 'src/unused.cjs')));
      const edited = files(); assert.notDeepStrictEqual(edited, manifest.files); assert.strictEqual(index(), manifest.originalIndex);
      record('pre-rewind-developer-edits', { fileContents: edited, stagedEntriesSha256: digest(index()), checkpoint: anchor.checkpoint });

      // Cancel is a real modal action and must not publish a misleading fork.
      let count = (await events('rewindComplete')).length;
      const changesBeforeCancel = (await events('conversationChanged')).length;
      const historyIdsBeforeCancel = (await history()).map(value => value.id).sort();
      await menu(anchor.id, 'fork-rewind');
      await workbench.getByRole('button', { name: 'Cancel', exact: true }).click();
      await until('Cancelled rewind acknowledgement', async () => (await events('rewindComplete')).length > count);
      assert.strictEqual((await events('rewindComplete')).at(-1).payload.reason, 'cancelled');
      assert.strictEqual((await events('conversationChanged')).length, changesBeforeCancel);
      assertSameJson(await snapshot(sourceId), originalDone); assert.deepStrictEqual(files(), edited);
      const historyIdsAfterCancel = (await history()).map(value => value.id).sort();
      assert.deepStrictEqual(historyIdsAfterCancel, historyIdsBeforeCancel, 'Cancelled rewind may not persist an orphan branch');
      record('cancel-preserved-original', { sourceId, originalSha256: digestObject(originalDone), filesSha256: digestObject(edited), historyIdsBeforeCancel, historyIdsAfterCancel });

      count = (await events('rewindComplete')).length;
      const beforeRewindFork = (await events('conversationChanged')).length;
      await menu(anchor.id, 'fork-rewind');
      await workbench.getByRole('button', { name: 'Rewind', exact: true }).click();
      await until('Fork and real code rewind completes', async () => (await events('rewindComplete')).length > count);
      const rewind = (await events('rewindComplete')).at(-1).payload;
      assert.strictEqual(rewind.ok, true); assert.ok(rewind.safetyCommit);
      assert.strictEqual((await events('conversationChanged')).length, beforeRewindFork + 1);
      const rewoundBranch = (await events('conversationChanged')).at(-1).payload;
      assert.notStrictEqual(rewoundBranch.id, sourceId); assert.notStrictEqual(rewoundBranch.id, branch.id);
      assertSameJson(rewoundBranch.messages, original.messages.slice(0, 5));
      assert.deepStrictEqual(files(), manifest.files); assert.strictEqual(index(), manifest.originalIndex);
      record('real-fork-and-rewind', { branch: proof(rewoundBranch), rewind, restoredFiles: files(), originalStagedEntriesSha256: digest(index()) });
      await workbench.getByRole('button', { name: 'Undo', exact: true }).click();
      await until('Real Undo restores safety checkpoint', async () => (await events('rewindComplete')).some(value => value.payload.ok && value.payload.undone));
      assert.deepStrictEqual(files(), edited); assert.strictEqual(index(), manifest.originalIndex);
      assertSameJson(await snapshot(sourceId), originalDone);
      assertSameJson(await snapshot(branch.id), branchDone);
      assertSameJson(await snapshot(rewoundBranch.id), rewoundBranch);
      const finalConversations = [originalDone, branchDone, rewoundBranch].map(proof);
      const finalPublicHistoryIds = (await history()).map(value => value.id).sort();
      assert.deepStrictEqual(finalPublicHistoryIds, [...initialHistoryIds, branch.id, rewoundBranch.id].sort(), 'Only the two accepted fork actions may add branches');
      const clicks = (await events('menuClicked')).map(value => value.payload);
      assert.deepStrictEqual(clicks.map(value => value.action), ['fork', 'fork-rewind', 'fork-rewind']);
      assert.ok(clicks.every(value => value.conversationId === sourceId && value.messageId === anchor.id && !value.disabled));
      assert.ok(clicks.filter(value => value.action === 'fork-rewind').every(value => value.commit === anchor.checkpoint.commit));
      record('real-undo', { finalConversations, finalPublicHistoryIds, finalFiles: edited, stagedEntriesSha256: digest(index()), menuClicks: clicks,
        originalSourceId: sourceId, alternateBranchId: branch.id, rewindBranchId: rewoundBranch.id });
      fs.writeFileSync(path.join(owner.directory, 'acceptance.json'), JSON.stringify({ status: 'PASS_BOUNDED_NATIVE_FORKS',
        finalConversations, initialHistoryIds, finalPublicHistoryIds, finalFiles: edited, originalIndex: manifest.originalIndex, originalSourceId: sourceId,
        alternateBranchId: branch.id, rewindBranchId: rewoundBranch.id, menuClicks: clicks,
        conversationalInputs: receipts().filter(value => value.event === 'request').length,
        auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length,
        indexEvidenceScope: 'Exact git ls-files --stage entries, including blob IDs, modes and stages; not raw .git/index serialization/stat-cache bytes.',
        semanticReview: 'PENDING_ROOT_REVIEW: read the five saved replies; verify BRANCH_ALT includes open+triaged, SOURCE_CONTINUE remains open-only, and proposed assertions match their requirements. Token checks alone do not prove semantic quality.',
        limitations: [manifest.scope, 'Exact canonical JSON values/IDs/metadata compared; raw SQLite serialization bytes are not an equality oracle.',
          'Observed process sampling cannot capture every sub-250ms process.', 'Input writes are not confirmed billable API acceptance; no spend claim.'] }, null, 2));
      assert.strictEqual(receipts().filter(value => value.event === 'request').length, 5);
      completed = true;
    });

    afterEach(async function () {
      if (!owner) { return; }
      record('case-outcome', { state: this.currentTest?.state, title: this.currentTest?.title,
        error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message } });
      if (this.currentTest?.state === 'failed' && workbench) {
        await workbench.screenshot({ path: path.join(owner.directory, 'failure.png') }).catch(() => {});
      }
    });
    after(async () => {
      if (owner) { record('helper-finished', { completed, conversationalInputs: receipts().filter(value => value.event === 'request').length,
        auxiliaryInputs: receipts().filter(value => value.event === 'auxiliary-input').length }); }
      await browser?.close().catch(() => {});
    });
  });
}
