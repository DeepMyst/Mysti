/** PC-09 opt-in ordinary-editor journey: two real windows, five model requests. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { hasIsolationModelProgress, installIsolationObserver } from './isolation-observer';

if (process.env.MYSTI_PC09 === '1') {
  describe('PC-09 real editor window and panel isolation', function () {
    this.timeout(600_000);
    let browser: Browser, workbench: Page, manifest: any, owner: any, directory: string;
    const windowId = process.env.MYSTI_PC09_WINDOW!;
    const panels = new Map<string, { frame: Frame; tab: vscode.Tab; provider: string; conversationId: string }>();
    const observations: any[] = [];
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    function record(event: string, details: Record<string, unknown> = {}): void {
      const value = { event, at: Date.now(), window: windowId, ...details }; observations.push(value);
      fs.writeFileSync(path.join(directory, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-09]', JSON.stringify(value));
    }
    function barrier(name: string, value: any = {}): void {
      fs.writeFileSync(path.join(manifest.artifactDir, `barrier-${name}.json`), JSON.stringify({ at: Date.now(), window: windowId, ...value }));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 30_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const other = windowId === 'A' ? 'B' : 'A';
        assert.ok(!fs.existsSync(path.join(manifest.artifactDir, `failure-${other}.json`)), `Other window failed before ${label}`);
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function waitBarrier(name: string): Promise<any> {
      const file = path.join(manifest.artifactDir, `barrier-${name}.json`);
      await until(name, async () => fs.existsSync(file), 180_000); return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    function receipts(): any[] {
      return owner.receiptPaths.flatMap((file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    }
    async function events(label: string, type?: string): Promise<any[]> {
      const all = await panels.get(label)!.frame.evaluate(() => (globalThis as any).__pc09Events || []);
      return type ? all.filter((event: any) => event.type === type) : all;
    }
    function assertOwnerContent(label: string, history: any[]): void {
      const values = history.filter(event => ['responseChunk', 'messageAdded', 'responseComplete', 'requestCancelled'].includes(event.type))
        .map(event => event.payload?.content).filter((content): content is string => typeof content === 'string');
      values.push(history.filter(event => event.type === 'responseChunk' && event.payload?.type === 'text').map(event => event.payload.content || '').join(''));
      for (const content of values) {
        for (const [scope, token] of Object.entries(manifest.tokens)) if (scope !== label) assert.ok(!content.includes(String(token)), `${label} may not receive ${scope} context, even when stopped`);
        const markers = content.match(/PC09_REQUEST:[A-Z0-9_]+/g) || [];
        for (const marker of markers) assert.ok(marker === `PC09_REQUEST:${label}` || (label === 'A1' && marker === 'PC09_REQUEST:A1_RECOVER'), `${label} received another panel's request marker`);
      }
    }
    async function reveal(label: string): Promise<Frame> {
      const panel = panels.get(label)!;
      const group = vscode.window.tabGroups.all.find(candidate => candidate.tabs.includes(panel.tab)); assert.ok(group);
      const index = group.tabs.indexOf(panel.tab); assert.ok(index >= 0 && index < 9);
      const ordinal = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'][group.viewColumn - 1];
      assert.ok(ordinal, 'Only the captured editor group may receive chat actions');
      if (!group.isActive) await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`);
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
      assert.strictEqual(group.isActive, true); assert.strictEqual(group.activeTab, panel.tab); await workbench.bringToFront();
      await panel.frame.locator('#message-input').click(); return panel.frame;
    }
    async function createPanel(label: string, provider: string): Promise<void> {
      const oldTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      const oldFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      let tab: vscode.Tab | undefined, frame: Frame | undefined;
      await until(`Chat ${label} must mount`, async () => {
        tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => !oldTabs.has(candidate) && candidate.input instanceof vscode.TabInputWebview && candidate.input.viewType.includes('mysti.detachedChat'));
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (oldFrames.has(candidate)) continue;
          try {
            if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count()
              && (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) candidates.push(candidate);
          } catch { /* Webview still mounting. */ }
        }
        if (!tab || candidates.length !== 1) return false; frame = candidates[0]; return true;
      });
      assert.ok(frame && tab);
      panels.set(label, { frame, tab, provider, conversationId: '' });
      await reveal(label);
      if (await frame.locator('.wizard-skip-btn').isVisible()) await frame.locator('.wizard-skip-btn').click();
      await frame.evaluate(installIsolationObserver);
      await frame.locator('#new-conversation-btn').click();
      await until(`Chat ${label} identity`, async () => (await events(label, 'conversationChanged')).length > 0);
      panels.get(label)!.conversationId = (await events(label, 'conversationChanged')).at(-1).payload.id;
      await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent=${JSON.stringify(provider)}]:not(.disabled)`).click();
      await until(`Chat ${label} provider`, async () => (await frame!.locator('#agent-name').innerText()).includes(provider === 'claude-code' ? 'Claude' : 'Codex'));
      await vscode.commands.executeCommand('mysti.clearContext');
      await frame.locator('#message-input').click();
      await vscode.commands.executeCommand('mysti.addToContext', vscode.Uri.file(owner.scopes[label].contextFile));
      await until(`Public context command must target ${label}`, async () => {
        const context = (await events(label, 'contextUpdated')).at(-1)?.payload;
        return context?.length === 1 && context[0].path === owner.scopes[label].contextFile;
      });
      record('panel-ready', { label, provider, conversationId: panels.get(label)!.conversationId, contextSha256: owner.scopes[label].contentSha256 });
    }
    async function assertNoToolsOrErrors(label: string, offset: number): Promise<void> {
      const fresh = (await events(label)).slice(offset);
      for (const event of fresh.filter(value => value.type === 'permissionRequest')) {
        const frame = await reveal(label); const deny = frame.locator(`.permission-card[data-id=${JSON.stringify(event.payload.id)}] [data-action="deny"]`);
        if (await deny.isVisible()) await deny.click();
      }
      assert.deepStrictEqual(fresh.filter(event => ['permissionRequest', 'toolUse', 'error', 'authError'].includes(event.type)).map(event => event.type), [], `Inline ${label} must neither use tools nor hide a backend error`);
    }
    async function submit(label: string, marker: string, long: boolean): Promise<number> {
      const frame = await reveal(label); const offset = (await events(label)).length;
      const request = `PC09_REQUEST:${marker}\nUse only the one scoped context file already supplied with this request. Never read files, run commands, use tools, or modify anything. Begin with PC09_SCOPE: followed by the exact PC09_CONTEXT_TOKEN value from that context. `
        + (long ? 'Review bounded exponential retry/backoff for a local HTTP client. Give 80 numbered developer review points, each 25–35 words, so another chat can be interrupted while you explain. ' : 'Explain in one sentence why attempt 0 uses the supplied retryBaseMs without multiplying it by zero. ')
        + `End with PC09_DONE:${marker}. Do not invent a missing token or mention unrelated chat context.`;
      await frame.locator('#message-input').fill(request); await frame.locator('#send-btn').click();
      await until(`Selected ${label} CLI must receive ${marker}`, async () => receipts().some(receipt => receipt.event === 'request' && receipt.markers.includes(marker)));
      const wire = receipts().filter(receipt => receipt.event === 'request' && receipt.markers.includes(marker));
      assert.strictEqual(wire.length, 1); assert.strictEqual(wire[0].provider, panels.get(label)!.provider);
      assert.deepStrictEqual(wire[0].contextScopes, [label]);
      assert.ok(wire[0].markers.every((value: string) => value === label || (label === 'A1' && value === 'A1_RECOVER')), 'CLI input must contain only its owning panel markers');
      assert.ok(typeof wire[0].model === 'string' && wire[0].model.length > 0, 'Receipt must attribute the selected model');
      record('request-submitted', { label, marker, offset, receipt: wire[0] }); return offset;
    }
    function progressTiming(history: any[]): Record<string, number | null> {
      return {
        responseStartedAt: history.find(event => event.type === 'responseStarted')?.at ?? null,
        firstThinkingAt: history.find(event => event.type === 'responseChunk' && event.payload?.type === 'thinking' && event.payload.contentLength > 0)?.at ?? null,
        firstTextAt: history.find(event => event.type === 'responseChunk' && event.payload?.type === 'text' && typeof event.payload.content === 'string' && event.payload.content.length > 0)?.at ?? null,
        completionAt: history.find(event => event.type === 'responseComplete')?.at ?? null,
      };
    }
    async function active(label: string, offset: number): Promise<any[]> {
      await until(`${label} must start its response`, async () => (await events(label)).slice(offset).some(event => event.type === 'responseStarted'));
      await assertNoToolsOrErrors(label, offset);
      const fresh = (await events(label)).slice(offset);
      assert.strictEqual(fresh.filter(event => event.type === 'responseStarted').length, 1);
      assert.strictEqual(fresh.filter(event => ['responseComplete', 'requestCancelled'].includes(event.type)).length, 0, `${label} must remain in flight`);
      return fresh;
    }
    async function streaming(label: string, offset: number): Promise<void> {
      await until(`${label} must produce actual thinking or text`, async () => {
        await assertNoToolsOrErrors(label, offset);
        return hasIsolationModelProgress((await events(label)).slice(offset), true);
      }, 120_000);
      record('model-progress', { label, ...progressTiming((await events(label)).slice(offset)) });
    }
    async function complete(label: string, marker: string, offset: number): Promise<any> {
      await until(`${marker} completion`, async () => {
        await assertNoToolsOrErrors(label, offset); return (await events(label)).slice(offset).some(event => event.type === 'responseComplete');
      }, 240_000);
      const fresh = (await events(label)).slice(offset), terminals = fresh.filter(event => event.type === 'responseComplete');
      assert.strictEqual(terminals.length, 1); assert.strictEqual(fresh.filter(event => event.type === 'requestCancelled').length, 0);
      assertOwnerContent(label, fresh);
      const streamed = fresh.filter(event => event.type === 'responseChunk' && event.payload.type === 'text').map(event => event.payload.content || '').join('');
      const content = typeof terminals[0].payload?.content === 'string' && terminals[0].payload.content ? terminals[0].payload.content : streamed;
      assert.ok(content.includes(manifest.tokens[label]), `${label} must use the exact context token`); assert.ok(content.includes(`PC09_DONE:${marker}`));
      for (const [scope, token] of Object.entries(manifest.tokens)) if (scope !== label) assert.ok(!content.includes(String(token)), `${label} must not disclose ${scope} context`);
      const frame = panels.get(label)!.frame;
      const assistant = frame.locator('#messages .message.assistant').last();
      assert.strictEqual(await assistant.getAttribute('data-provider'), panels.get(label)!.provider);
      assert.ok((await assistant.locator('.message-content').allTextContents()).join('\n').includes(manifest.tokens[label]));
      record('response-verified', { label, marker, terminalAt: terminals[0].at, provider: panels.get(label)!.provider,
        attribution: terminals[0].payload, response: content, contextScopes: [label], ...progressTiming(fresh) });
      return terminals[0];
    }

    before(async () => {
      manifest = JSON.parse(fs.readFileSync(path.join(process.env.MYSTI_PC09_ARTIFACT_DIR!, 'prepared.json'), 'utf8'));
      assert.strictEqual(manifest.case, 'PC-09'); assert.ok(['A', 'B'].includes(windowId)); owner = manifest.windows[windowId]; directory = owner.directory;
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_USER_DATA_DIR!), fs.realpathSync(owner.profile));
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
      assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(owner.workspace));
      assert.ok(!fs.existsSync(path.join(directory, 'observations.json')), 'Preserve previous attempt evidence');
      assert.strictEqual(receipts().filter(receipt => receipt.event === 'request').length, 0);
      const extension = vscode.extensions.getExtension('DeepMyst.mysti')!; assert.ok(extension);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(owner.installedExtension));
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))), manifest.bundleSha256);
      assert.strictEqual(hash(fs.readFileSync(path.join(extension.extensionPath, 'media/chat/chat.js'))), manifest.chatSha256);
      await extension.activate();
      const endpoint = fs.readFileSync(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      assert.ok(workbench); workbench.setDefaultTimeout(15000);
      record('identity', { extensionHostPid: process.pid, profile: owner.profile, workspace: owner.workspace, bundleSha256: manifest.bundleSha256,
        chatSha256: manifest.chatSha256, syntheticUnrelatedFiles: owner.syntheticUnrelatedFileCount, extensionTestsPathUsed: false });
      if (windowId === 'A') {
        await createPanel('A0', 'claude-code'); await createPanel('A1', 'openai-codex'); await createPanel('A2', 'claude-code');
      } else await createPanel('B0', 'openai-codex');
      barrier(`${windowId}-READY`, { extensionHostPid: process.pid });
      const other = await waitBarrier(`${windowId === 'A' ? 'B' : 'A'}-READY`); assert.notStrictEqual(other.extensionHostPid, process.pid);
    });

    it('keeps context, streamed replies, Stop and inactive-tab closure with their owning window and chat', async () => {
      if (windowId === 'B') {
        await waitBarrier('A0-ACTIVE');
        const offset = await submit('B0', 'B0', true);
        const inFlight = await active('B0', offset);
        barrier('B0-ACTIVE', { requestAt: receipts().find(r => r.event === 'request' && r.markers.includes('B0')).at, ...progressTiming(inFlight) });
        const stopped = await waitBarrier('A1-STOPPED');
        const priorTerminal = (await events('B0')).slice(offset).find(event => event.type === 'responseComplete');
        assert.ok(!priorTerminal || priorTerminal.at > stopped.stopStartedAt, 'B0 must still run at Stop or finish strictly afterwards');
        const done = await complete('B0', 'B0', offset); assert.ok(done.at > stopped.stopStartedAt);
        barrier('B0-DONE', { terminalAt: done.at });
      } else {
        const a2 = await submit('A2', 'A2', false); await complete('A2', 'A2', a2);
        const a0 = await submit('A0', 'A0', true); await streaming('A0', a0); await active('A0', a0); barrier('A0-ACTIVE');
        const a1 = await submit('A1', 'A1', true); const other = await waitBarrier('B0-ACTIVE');
        await active('A0', a0); await active('A1', a1);
        assert.ok(typeof other.responseStartedAt === 'number', 'B0 must have received actual responseStarted');
        await reveal('A0');
        const inactiveTab = panels.get('A2')!.tab;
        const inactiveGroup = vscode.window.tabGroups.all.find(group => group.tabs.includes(inactiveTab));
        assert.ok(inactiveGroup, 'The captured chat must still belong to an editor group');
        // A tab can be selected within an inactive group; Tab.isActive is group-local.
        assert.strictEqual(inactiveGroup.isActive, false, 'Closing A2 must not target the focused chat group');
        assert.strictEqual(await vscode.window.tabGroups.close(inactiveTab, true), true, 'VS Code must accept closing the inactive chat');
        assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.includes(inactiveTab)), 'The captured inactive chat must actually close');
        panels.delete('A2');
        assert.strictEqual((await events('A0')).slice(a0).filter(event => event.type === 'requestCancelled').length, 0);
        const frame = await reveal('A1');
        const a0AtStop = await active('A0', a0), a1AtStop = await active('A1', a1);
        const stopPreparedAt = Date.now();
        const a0Request = receipts().find(receipt => receipt.event === 'request' && receipt.markers.includes('A0'));
        assert.ok(a0Request.at < stopPreparedAt && other.requestAt < stopPreparedAt);
        await frame.locator('#stop-btn').click();
        await until('A1 Stop must restore only its own composer', async () =>
          (await events('A1')).slice(a1).some(event => event.type === 'requestCancelled') && !await frame.locator('#stop-btn').isVisible(), 5000);
        const stoppedEvents = (await events('A1')).slice(a1);
        const stopClicks = stoppedEvents.filter(event => event.type === 'stopClicked');
        const cancellations = stoppedEvents.filter(event => event.type === 'requestCancelled');
        assert.strictEqual(stopClicks.length, 1); assert.strictEqual(cancellations.length, 1);
        const stopStartedAt = stopClicks[0].at, requestCancelledAt = cancellations[0].at;
        assert.ok(stopStartedAt >= stopPreparedAt && requestCancelledAt >= stopStartedAt);
        assert.ok(requestCancelledAt - stopStartedAt <= 5000, 'Stop acknowledgement must arrive within five seconds of the actual click');
        await assertNoToolsOrErrors('A1', a1);
        assertOwnerContent('A1', (await events('A1')).slice(a1));
        barrier('A1-STOPPED', { stopStartedAt }); record('overlap-and-stop', { stopStartedAt, stopClickedAt: stopStartedAt, stopPreparedAt, requestCancelledAt, stopLatencyMs: requestCancelledAt - stopStartedAt,
          a0RequestAt: a0Request.at, b0RequestAt: other.requestAt, inactiveTabClosed: 'A2',
          a0Progress: progressTiming(a0AtStop), a1Progress: progressTiming(a1AtStop), b0ActiveBarrier: other,
          scope: 'All three requests in flight; B0 may be awaiting first model output when A1 is stopped.' });
        const done = await complete('A0', 'A0', a0); assert.ok(done.at > stopStartedAt);
        await waitBarrier('B0-DONE');
        const recovery = await submit('A1', 'A1_RECOVER', false); await complete('A1', 'A1_RECOVER', recovery);
      }
      for (const label of panels.keys()) assertOwnerContent(label, await events(label));
      for (const fixture of Object.values(owner.scopes) as any[]) assert.strictEqual(hash(fs.readFileSync(fixture.contextFile)), fixture.contentSha256);
      assert.strictEqual(receipts().filter(receipt => receipt.event === 'request').length, windowId === 'A' ? 4 : 1);
      record('case-verified', { conversationalRequests: windowId === 'A' ? 4 : 1, auxiliaryInputs: receipts().filter(receipt => receipt.event === 'auxiliary-input').length,
        coverage: 'Actual simultaneous independent profiles; 3 detached chats in A and 1 in B. Native repeated-ID collisions and native questions/permissions remain controlled-fixture coverage.' });
    });

    afterEach(async function () {
      if (!directory) return;
      if (this.currentTest?.state === 'failed') {
        fs.writeFileSync(path.join(manifest.artifactDir, `failure-${windowId}.json`), JSON.stringify({ window: windowId, message: this.currentTest.err?.message }));
        await workbench?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
      }
      record('case-outcome', { state: this.currentTest?.state, error: this.currentTest?.err?.message,
        panelEvents: Object.fromEntries(await Promise.all([...panels.keys()].map(async label => [label, await events(label).catch(() => [])]))), wireReceipts: receipts() });
    });
    after(async () => {
      for (const [label, panel] of panels) {
        try { const frame = await reveal(label); if (await frame.locator('#stop-btn').isVisible()) await frame.locator('#stop-btn').click(); } catch { /* Failure cleanup still closes owned panel. */ }
        try { await vscode.window.tabGroups.close(panel.tab, true); } catch { /* Actual editor shutdown owns any remaining panel. */ }
      }
      await browser?.close();
    });
  });
}
