/**
 * PC-01: real editor entry routes and repeatable onboarding exits.
 * Opt in with MYSTI_PC01=1 and run only --grep 'PC-01'. The default cases use
 * no installer/auth actions, credential changes, or mocked editor/provider APIs. Setting
 * MYSTI_PC01_LIVE=1 adds one real Codex answer using an existing login.
 * MYSTI_PC01_API_CANCEL=1 checks Escape from the real MiniMax password prompt
 * without entering a credential; it requires MiniMax to be unauthenticated.
 * A fresh VS Code profile still discovers the machine's installed CLIs; this
 * suite does not certify a no-CLI machine, successful login, or a timed soak.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

if (process.env.MYSTI_PC01 === '1') {
  describe('PC-01 first-run onboarding in the real editor', function () {
    const cycles = count('MYSTI_PC01_CYCLES', 10);
    const newChats = count('MYSTI_PC01_NEW_CHATS', cycles);
    this.timeout(Math.max(180_000, (cycles + newChats) * 20_000));
    let browser: Browser;
    let workbench: Page;
    let artifactDir: string;
    const ownedTabs = new Set<vscode.Tab>();
    const observations: Array<Record<string, unknown>> = [];

    function count(name: string, fallback: number): number {
      const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
      assert.ok(Number.isInteger(value) && value >= 1 && value <= 100,
        `${name} must be an integer from 1 to 100`);
      return value;
    }

    function tabs(): Array<Record<string, unknown>> {
      return vscode.window.tabGroups.all.map(group => ({
        column: group.viewColumn, active: group.isActive,
        tabs: group.tabs.map(tab => ({
          label: tab.label, active: tab.isActive,
          viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined,
        })),
      }));
    }

    function frames(): Frame[] {
      return browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()));
    }

    async function chatFrames(): Promise<Frame[]> {
      const found: Frame[] = [];
      for (const frame of frames()) {
        try {
          if (await frame.locator('#message-input').count() &&
              !await frame.locator('body.view-hub').count()) { found.push(frame); }
        } catch { /* A disposed webview may detach during this read-only scan. */ }
      }
      return found;
    }

    async function diagnostics(): Promise<Record<string, unknown>> {
      const details: unknown[] = [];
      for (const frame of frames()) {
        try {
          if (!await frame.locator('#message-input').count()) { continue; }
          details.push(await frame.evaluate(() => {
            const win = globalThis as any;
            const doc = win.document;
            const input = doc.querySelector('#message-input');
            const rect = input?.getBoundingClientRect();
            return {
              url: win.location.href, readyState: doc.readyState,
              hidden: doc.hidden, focusedElement: doc.activeElement?.id,
              body: doc.body?.className,
              input: input && { disabled: input.disabled, width: rect?.width, height: rect?.height,
                display: win.getComputedStyle(input).display, visibility: win.getComputedStyle(input).visibility },
              init: doc.querySelector('#init-loading-overlay')?.className,
              setup: doc.querySelector('#setup-overlay')?.className,
              wizard: doc.querySelector('#setup-wizard')?.className,
              wizardStep: doc.querySelector('.wizard-stepper [aria-current="step"]')?.getAttribute('data-step'),
              messages: doc.querySelectorAll('#messages .message').length,
              providers: Array.from(doc.querySelectorAll('#setup-wizard .provider-card')).map((card: any) => ({
                id: card.getAttribute('data-provider'),
                status: card.querySelector('.provider-status')?.getAttribute('data-status'),
              })),
            };
          }));
        } catch { details.push({ url: frame.url(), detached: true }); }
      }
      return { tabs: tabs(), frames: details, terminals: vscode.window.terminals.length };
    }

    function record(step: string, details: Record<string, unknown> = {}): void {
      const row = { ...details, at: new Date().toISOString(), step };
      observations.push(row);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-01]', JSON.stringify(row));
    }

    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) { return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${label}: timed out after ${timeout}ms. ${JSON.stringify(await diagnostics())}`);
    }

    async function readyFrame(excluded = new Set<Frame>()): Promise<Frame> {
      let selected: Frame | undefined;
      await until('Exactly one intended chat frame must initialize', async () => {
        const candidates = (await chatFrames()).filter(frame => !excluded.has(frame));
        if (candidates.length !== 1) { return false; }
        const candidate = candidates[0];
        try {
          if (!(await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) {
            return false;
          }
          selected = candidate;
          return true;
        } catch { return false; }
      }, 30_000);
      assert.ok(selected);
      await selected.page().bringToFront();
      return selected;
    }

    async function usable(frame: Frame, marker: string): Promise<void> {
      await frame.locator('#message-input').waitFor({ state: 'visible', timeout: 15_000 });
      assert.strictEqual(await frame.locator('#message-input').isEditable(), true);
      await frame.locator('#message-input').fill(marker);
      assert.strictEqual(await frame.locator('#message-input').inputValue(), marker);
      assert.strictEqual(await frame.locator('#stop-btn').isVisible(), false);
      assert.strictEqual(await frame.locator('#messages .message').count(), 0,
        'PC-01 must remain an unsent setup workflow in a fresh profile');
      await frame.locator('#message-input').fill('');
    }

    async function skipIfShown(frame: Frame): Promise<void> {
      if (await frame.locator('#setup-wizard').isVisible()) {
        await frame.locator('.wizard-skip-btn').click();
        await frame.locator('#setup-wizard').waitFor({ state: 'hidden', timeout: 15_000 });
        record('skip-automatic-wizard');
      }
    }

    async function openChatTab(): Promise<{ tab: vscode.Tab; frame: Frame }> {
      const before = new Set(frames());
      let subscription: vscode.Disposable | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const opened = new Promise<vscode.Tab>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The editor did not announce a new Mysti chat tab')), 15_000);
        subscription = vscode.window.tabGroups.onDidChangeTabs(event => {
          const tab = event.opened.find(item => item.input instanceof vscode.TabInputWebview &&
            item.input.viewType.includes('mysti.detachedChat'));
          if (tab) { ownedTabs.add(tab); resolve(tab); }
        });
      });
      let tab: vscode.Tab;
      try {
        await vscode.commands.executeCommand('mysti.openInNewTab');
        tab = await opened;
      } finally { subscription?.dispose(); clearTimeout(timer); }
      const frame = await readyFrame(before);
      const group = vscode.window.tabGroups.all.find(item => item.tabs.includes(tab));
      assert.ok(group, 'The announced chat must belong to an editor group');
      // Explicitly make the intended group/tab authoritative. Inner-frame
      // isVisible can stay true when a retained editor webview is backgrounded.
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      assert.strictEqual(vscode.window.tabGroups.activeTabGroup, group,
        'New chat must open in the active editor group');
      const index = group.tabs.indexOf(tab);
      assert.ok(index >= 0 && index < 9, 'Expected chat must have an addressable tab index');
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
      assert.strictEqual(group.activeTab, tab, 'Actions must target the newly opened chat');
      return { tab, frame };
    }

    before(async () => {
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
      assert.ok(profile, 'Run with the isolated .vscode-test.mjs profile; never attach to a daily editor');
      artifactDir = process.env.MYSTI_PC01_ARTIFACT_DIR || path.join(profile, 'pc01-evidence');
      fs.mkdirSync(artifactDir, { recursive: true });
      const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      const pages = browser.contexts().flatMap(context => context.pages());
      for (const page of pages) {
        if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      }
      assert.ok(workbench, 'Expected one native VS Code workbench page');
      workbench.setDefaultTimeout(15_000);
      const extension = vscode.extensions.getExtension('DeepMyst.mysti');
      assert.ok(extension, 'Mysti must be installed in the test editor');
      await extension.activate();
      const priorChats = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat'));
      assert.strictEqual(priorChats.length, 0, 'Run PC-01 alone in a fresh profile, before other chat suites');
      record('environment', { vscode: vscode.version, extension: extension.packageJSON.version,
        platform: process.platform, cycles, newChats,
        scope: process.env.MYSTI_PC01_LIVE === '1'
          ? 'native setup/navigation plus one existing-login Codex answer; no auth, installer or no-CLI claim'
          : 'native setup/navigation; no inference, auth, installer or no-CLI claim' });
    });

    afterEach(async function () {
      const failed = this.currentTest?.state === 'failed';
      if (browser) {
        const detail = await diagnostics();
        record(failed ? 'failure-diagnostics' : 'case-complete', { test: this.currentTest?.title, ...detail });
        if (failed && workbench) {
          await workbench.screenshot({ path: path.join(artifactDir, `failure-${Date.now()}.png`) })
            .catch(error => record('screenshot-unavailable', { message: String(error) }));
        }
      }
    });

    after(async () => {
      for (const tab of ownedTabs) {
        if (vscode.window.tabGroups.all.some(group => group.tabs.includes(tab))) {
          await vscode.window.tabGroups.close(tab);
        }
      }
      await browser?.close();
    });

    it('opens from the Activity Bar, registered command, and actual keyboard shortcut', async () => {
      await workbench.bringToFront();
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      // The Activity Bar badge repeats the label but is aria-hidden and is
      // not actionable. Target the actual view-container action.
      const activity = workbench.locator('.activitybar a.action-label[aria-label^="Mysti"]');
      await activity.waitFor({ state: 'visible' });
      await activity.click();
      let frame = await readyFrame();
      await skipIfShown(frame);
      await usable(frame, 'PC01 activity route');
      record('activity-bar-route');

      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('mysti.openChat');
      frame = await readyFrame();
      await usable(frame, 'PC01 command route');
      record('command-route');

      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await workbench.locator('.part.sidebar').waitFor({ state: 'hidden' });
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await workbench.bringToFront();
      await workbench.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+m' : 'Control+Shift+m');
      await workbench.locator('.part.sidebar').waitFor({ state: 'visible' });
      frame = await readyFrame();
      await usable(frame, 'PC01 shortcut route');
      record('keyboard-shortcut-route');
    });

    it('offers the zero-install route and repeatedly resumes named setup steps after Skip', async () => {
      await vscode.commands.executeCommand('mysti.getStarted', 'connect');
      let frame = await readyFrame();
      await frame.locator('#setup-wizard').waitFor({ state: 'visible' });
      await frame.locator('.wizard-step[data-step="connect"]').waitFor({ state: 'visible' });
      assert.match(await frame.locator('.wizard-fastpath').innerText(), /nothing to install/i);
      assert.strictEqual(await frame.locator('#wizard-signin-btn').count(), 1,
        'The sign-in route must exist, but this test must not invoke it');
      record('actual-provider-discovery', await diagnostics());
      await workbench.screenshot({ path: path.join(artifactDir, 'onboarding-connect.png') });
      await frame.locator('.wizard-skip-btn').click();
      await frame.locator('#setup-wizard').waitFor({ state: 'hidden' });
      await usable(frame, 'PC01 initial skip');

      const steps = ['connect', 'mode', 'task'];
      for (let cycle = 0; cycle < cycles; cycle++) {
        const step = steps[cycle % steps.length];
        const started = Date.now();
        await vscode.commands.executeCommand('mysti.getStarted', step);
        frame = await readyFrame();
        await frame.locator('#setup-wizard').waitFor({ state: 'visible' });
        await frame.locator(`.wizard-step[data-step="${step}"]`).waitFor({ state: 'visible' });
        assert.strictEqual(await frame.locator('.wizard-stepper [aria-current="step"]').getAttribute('data-step'), step);
        await frame.locator('.wizard-skip-btn').click();
        await frame.locator('#setup-wizard').waitFor({ state: 'hidden' });
        await usable(frame, `PC01 resumed ${step} ${cycle}`);
        assert.strictEqual(await frame.locator('#setup-wizard:not(.hidden)').count(), 0);
        record('setup-skip-resume', { cycle: cycle + 1, wizardStep: step, elapsedMs: Date.now() - started });
      }
    });

    it('keeps Skip dismissed through repeated real chat tab disposal and new-chat actions', async () => {
      for (let cycle = 0; cycle < cycles; cycle++) {
        const started = Date.now();
        const { tab, frame } = await openChatTab();
        assert.strictEqual(await frame.locator('#setup-wizard').isVisible(), false,
          'User-dismissed setup must not reappear in a newly opened chat');
        await usable(frame, `PC01 editor tab ${cycle}`);
        assert.strictEqual(await vscode.window.tabGroups.close(tab), true);
        ownedTabs.delete(tab);
        await until('Disposed editor chat frame must be removed', async () => (await chatFrames()).length === 1);
        record('tab-open-close', { cycle: cycle + 1, elapsedMs: Date.now() - started });
      }
      await vscode.commands.executeCommand('mysti.openChat');
      const frame = await readyFrame();
      // Read the actual host acknowledgement. New Chat resets the transcript
      // and session but preserves the unsent composer; an empty-input oracle
      // would invent a destructive behavior that the product does not promise.
      await frame.evaluate(() => {
        const win = globalThis as any;
        win.__pc01NewChats = [];
        win.__pc01NewChatListener = (event: any) => {
          if (event.data?.type !== 'conversationChanged') { return; }
          const conversation = event.data.payload;
          win.__pc01NewChats.push({
            id: conversation?.id,
            messageCount: Array.isArray(conversation?.messages) ? conversation.messages.length : null,
          });
        };
        win.addEventListener('message', win.__pc01NewChatListener);
      });
      const conversationIds = new Set<string>();
      try {
        for (let cycle = 0; cycle < newChats; cycle++) {
          const draft = `PC01 unsent new-chat draft ${cycle}`;
          await frame.locator('#message-input').fill(draft);
          await frame.locator('#new-conversation-btn').click();
          await until('New chat must receive its host conversation acknowledgement', async () =>
            await frame.evaluate(() => (globalThis as any).__pc01NewChats.length) > cycle);
          const acknowledged = await frame.evaluate(() => (globalThis as any).__pc01NewChats) as
            Array<{ id?: string; messageCount: number | null }>;
          assert.strictEqual(acknowledged.length, cycle + 1, 'Each click must create exactly one conversation');
          const conversation = acknowledged[cycle];
          assert.ok(typeof conversation.id === 'string' && conversation.id.length > 0,
            'Host must acknowledge the new conversation ID');
          assert.ok(!conversationIds.has(conversation.id), 'Each New Chat must create a fresh conversation ID');
          conversationIds.add(conversation.id);
          assert.strictEqual(conversation.messageCount, 0, 'New conversation must have no persisted messages');
          assert.strictEqual(await frame.locator('#message-input').inputValue(), draft,
            'New Chat preserves the unsent composer draft');
          assert.strictEqual(await frame.locator('#setup-wizard').isVisible(), false);
          await usable(frame, `PC01 new chat ${cycle}`);
          record('new-chat', { cycle: cycle + 1, conversationId: conversation.id, messageCount: conversation.messageCount });
        }
      } finally {
        await frame.evaluate(() => {
          const win = globalThis as any;
          win.removeEventListener('message', win.__pc01NewChatListener);
          delete win.__pc01NewChatListener;
          delete win.__pc01NewChats;
        });
      }
    });

    if (process.env.MYSTI_PC01_API_CANCEL === '1') {
      it('recovers immediately when the real MiniMax API-key prompt is cancelled', async function () {
        await vscode.commands.executeCommand('mysti.getStarted', 'connect');
        const frame = await readyFrame();
        await frame.locator('#setup-wizard').waitFor({ state: 'visible' });
        const card = frame.locator('#setup-wizard .provider-card[data-provider="minimax"]');
        assert.strictEqual(await card.count(), 1, 'Registered MiniMax must be reachable from setup');
        await until('MiniMax discovery must settle before testing cancellation', async () =>
          ['not-authenticated', 'ready', 'complete'].includes(await card.locator('.provider-status').getAttribute('data-status') || ''));
        const status = await card.locator('.provider-status').getAttribute('data-status');
        if (status !== 'not-authenticated') {
          record('minimax-api-cancellation-prerequisite', {
            status: 'blocked-prerequisite', providerStatus: status,
            reason: 'MiniMax already has credentials; this test must not replace or delete them.',
          });
          await skipIfShown(frame);
          this.skip();
        }
        const terminalsBefore = vscode.window.terminals.length;
        await frame.evaluate(() => {
          const win = globalThis as any;
          win.__pc01ApiCancelEvents = [];
          win.__pc01ApiCancelListener = (event: any) => {
            const message = event.data;
            if (message?.payload?.providerId === 'minimax' &&
                ['authPrompt', 'authOptions', 'setupComplete', 'setupFailed'].includes(message.type)) {
              win.__pc01ApiCancelEvents.push({ type: message.type, error: message.payload.error });
            }
          };
          win.addEventListener('message', win.__pc01ApiCancelListener);
        });
        const password = workbench.locator('.quick-input-widget input[type="password"]');
        let ownsPasswordPrompt = false;
        try {
          assert.strictEqual(await card.locator('.provider-action-btn').getAttribute('data-action'), 'auth');
          await card.locator('.provider-action-btn').click();
          await frame.locator('#auth-confirm-btn').waitFor({ state: 'visible' });
          await frame.locator('#auth-confirm-btn').click();
          await password.waitFor({ state: 'visible', timeout: 15_000 });
          assert.match(await workbench.locator('.quick-input-widget').innerText(), /MiniMax API key/i);
          ownsPasswordPrompt = true;
          assert.strictEqual(await password.inputValue(), '', 'The test must never enter a credential');
          const cancelledAt = Date.now();
          await password.press('Escape');
          await password.waitFor({ state: 'hidden' });
          ownsPasswordPrompt = false;
          await until('Cancelled API-key input must return a recoverable setup result immediately', async () =>
            await frame.evaluate(() => (globalThis as any).__pc01ApiCancelEvents.some((event: any) =>
              event.type === 'setupFailed' && /cancelled/i.test(event.error || ''))), 5_000);
          const elapsedMs = Date.now() - cancelledAt;
          const events = await frame.evaluate(() => (globalThis as any).__pc01ApiCancelEvents) as
            Array<{ type: string; error?: string }>;
          assert.strictEqual(events.filter(event => event.type === 'authPrompt').length, 1);
          assert.strictEqual(events.filter(event => event.type === 'setupFailed').length, 1);
          assert.strictEqual(events.some(event => event.type === 'setupComplete' || event.type === 'authOptions'), false);
          assert.match(await frame.locator('#setup-overlay .setup-message').innerText(), /cancelled/i);
          assert.strictEqual(await frame.locator('#auth-retry-btn').isEnabled(), true);
          assert.strictEqual(vscode.window.terminals.length, terminalsBefore, 'API-key setup must not launch a terminal');
          await workbench.screenshot({ path: path.join(artifactDir, 'minimax-api-cancelled.png') });
          await frame.locator('#auth-error-close-btn').click();
          await frame.locator('#setup-overlay').waitFor({ state: 'hidden' });
          await skipIfShown(frame);
          await usable(frame, 'PC01 cancelled MiniMax API setup');
          record('minimax-api-cancellation', { providerId: 'minimax', elapsedMs, events, enteredCredential: false, terminalsBefore });
        } finally {
          if (ownsPasswordPrompt && await password.isVisible().catch(() => false)) { await password.press('Escape'); }
          await frame.evaluate(() => {
            const win = globalThis as any;
            win.removeEventListener('message', win.__pc01ApiCancelListener);
            delete win.__pc01ApiCancelListener;
            delete win.__pc01ApiCancelEvents;
          });
        }
      });
    }

    if (process.env.MYSTI_PC01_LIVE === '1') {
      it('completes setup with an already authenticated Codex and receives a real first answer', async () => {
        const model = process.env.MYSTI_PC01_CODEX_MODEL || 'gpt-5.6-sol';
        const codexPath = process.env.MYSTI_PC01_CODEX_PATH || '/usr/local/bin/codex';
        // Global here is the isolated editor profile supplied by the native
        // runner, not the user's daily VS Code settings. No auth/key writes.
        assert.ok(process.env.MYSTI_TEST_USER_DATA_DIR);
        const config = vscode.workspace.getConfiguration('mysti');
        for (const [key, value] of Object.entries({
          codexPath, codexModel: model, defaultMode: 'quick-plan', accessLevel: 'read-only',
          autoContext: false, showSuggestions: false,
        })) {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
        }

        await vscode.commands.executeCommand('mysti.getStarted', 'connect');
        const frame = await readyFrame();
        await frame.locator('#setup-wizard').waitFor({ state: 'visible' });
        const codex = frame.locator('#setup-wizard .provider-card[data-provider="openai-codex"]');
        // Only the ready/select action is permitted. A missing or signed-out
        // CLI fails this prerequisite rather than triggering an installer or
        // login flow. Its status is not counted as successful inference.
        await codex.locator('.provider-action-btn[data-action="select"]').waitFor({ state: 'visible', timeout: 30_000 });
        const readiness = await codex.locator('.provider-status').getAttribute('data-status');
        assert.ok(readiness === 'ready' || readiness === 'complete',
          `Existing Codex login is required; wizard status was ${readiness}`);
        record('live-existing-login-prerequisite', { provider: 'openai-codex', model, readiness, codexPath });
        await codex.locator('.provider-action-btn[data-action="select"]').click();
        await until('Wizard selection must select Codex and its configured model', async () =>
          /Codex/i.test(await frame.locator('#agent-name').innerText()) &&
          await frame.locator('#model-select-inline').inputValue() === model);

        await frame.locator('#wizard-next-btn').click();
        await frame.locator('.wizard-step[data-step="mode"]').waitFor({ state: 'visible' });
        await frame.locator('.wizard-mode').filter({ has: frame.locator('input[value="plan"]') }).click();
        assert.strictEqual(await frame.locator('input[name="wizard-mode"][value="plan"]').isChecked(), true);
        await frame.locator('#wizard-next-btn').click();
        await frame.locator('.wizard-step[data-step="task"]').waitFor({ state: 'visible' });
        await frame.locator('#wizard-next-btn').click();
        await frame.locator('#setup-wizard').waitFor({ state: 'hidden' });
        await usable(frame, 'PC01 ready for a real first answer');
        await until('Read-only wizard choice must reach the host settings', async () =>
          vscode.workspace.getConfiguration('mysti').get('accessLevel') === 'read-only' &&
          vscode.workspace.getConfiguration('mysti').get('defaultMode') === 'quick-plan');

        // Read-only observation of genuine host completion events; never
        // synthesize a response or invoke a private extension function.
        await frame.evaluate(() => {
          const win = globalThis as any;
          win.__pc01Live = { completions: [], toolEvents: 0, permissionEvents: 0 };
          win.__pc01LiveListener = (event: any) => {
            const message = event.data;
            if (message?.type === 'responseComplete') {
              const answer = message.payload?.message;
              win.__pc01Live.completions.push(answer && {
                id: answer.id, provider: answer.provider, model: answer.model, content: answer.content,
              });
            }
            if (message?.type === 'toolUse') { win.__pc01Live.toolEvents++; }
            if (message?.type === 'permissionRequest') { win.__pc01Live.permissionEvents++; }
          };
          win.addEventListener('message', win.__pc01LiveListener);
        });
        const prompt = [
          'Answer using only the JavaScript shown here. Do not use tools, read files, run commands, or make changes.',
          'function retryDelay(attempt, base = 100, cap = 1000) { return Math.min(cap, base * (2 ** attempt)); }',
          'What values does retryDelay return for attempts 0, 1, and 4, in that order?',
          'Return exactly one line in this format: PC01_RETRY:<first>,<second>,<third>. No explanation.',
        ].join('\n');
        const started = Date.now();
        try {
          await frame.locator('#message-input').fill(prompt);
          await frame.locator('#send-btn').click();
          await until('Codex must deliver an actual terminal response', async () =>
            await frame.evaluate(() => ((globalThis as any).__pc01Live?.completions.length || 0) > 0), 120_000);
          await frame.locator('.message.assistant.streaming').waitFor({ state: 'hidden', timeout: 15_000 });
          await frame.locator('#stop-btn').waitFor({ state: 'hidden', timeout: 15_000 });
          const evidence = await frame.evaluate(() => (globalThis as any).__pc01Live);
          const response = frame.locator('#messages .message.assistant').last();
          const rendered = (await response.locator('.message-content').allTextContents()).join('\n');
          record('live-first-answer', {
            elapsedMs: Date.now() - started, selectedProvider: await frame.locator('#agent-name').innerText(),
            selectedModel: await frame.locator('#model-select-inline').inputValue(),
            attribution: await response.locator('.message-model-info').innerText(),
            prompt, response: rendered, ...evidence,
            scope: 'one existing-login inference after setup; not fresh-account authentication or a soak',
          });
          assert.strictEqual(evidence.completions.length, 1, 'One send must produce one terminal response');
          assert.strictEqual(evidence.completions[0]?.provider, 'openai-codex');
          assert.strictEqual(evidence.completions[0]?.model, model);
          assert.strictEqual(evidence.completions[0]?.content?.trim(), 'PC01_RETRY:100,200,1000');
          assert.strictEqual(rendered.trim(), 'PC01_RETRY:100,200,1000');
          assert.strictEqual(evidence.toolEvents, 0, 'This inline question must not invoke tools');
          assert.strictEqual(evidence.permissionEvents, 0, 'This inline question needs no mutation approval');
          assert.strictEqual(await frame.locator('#messages .message.user').count(), 1);
          assert.strictEqual(await frame.locator('#messages .message.assistant').count(), 1);
          await workbench.screenshot({ path: path.join(artifactDir, 'first-real-answer.png') });
        } finally {
          // The observer contains only this synthetic prompt's response and
          // attribution. Remove it even when an account/service is unavailable.
          const terminal = await frame.evaluate(() => {
            const win = globalThis as any;
            const captured = win.__pc01Live;
            win.removeEventListener('message', win.__pc01LiveListener);
            delete win.__pc01LiveListener;
            delete win.__pc01Live;
            return captured;
          });
          record('live-terminal-observation', { elapsedMs: Date.now() - started, ...terminal });
          if (await frame.locator('#stop-btn').isVisible()) {
            await frame.locator('#stop-btn').click();
          }
        }
      });
    }
  });
}
