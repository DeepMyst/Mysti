/**
 * PC-03 opt-in real-editor authentication failure and recovery.
 * MYSTI_PC03=1; --grep 'PC-03'. Requires an exact extracted release payload
 * MYSTI_TEST_EXTENSION_PATH, fresh runner profile, MYSTI_PC03_CODEX_PATH and
 * MYSTI_PC03_NODE_PATH. Uses the shared child-only ephemeral auth fixture.
 * No HOME/CODEX_HOME override, credential read/copy/write, login, or revocation.
 * Actual login handoff is blocked by the fixture; successful recovery uses the
 * existing account. This bounded case is neither fresh login nor expiry soak.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';

if (process.env.MYSTI_PC03 === '1') {
  describe('PC-03 real editor authentication failure and same-task recovery', function () {
    this.timeout(300_000);
    let browser: Browser, workbench: Page, frame: Frame, artifactDir: string;
    let fixture: { path: string; blockedActionsPath: string; setSignedOut(value: boolean): void };
    const saved = new Map<string, { value: unknown; target: vscode.ConfigurationTarget }>();
    const observations: unknown[] = [];
    const ownedTerminals: vscode.Terminal[] = [];
    let terminals: vscode.Disposable | undefined;

    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { ...details, event, at: new Date().toISOString() };
      observations.push(entry);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-03]', JSON.stringify(entry));
    }
    async function events(type?: string): Promise<any[]> {
      const result = await frame.evaluate(() => (globalThis as any).__pc03Events || []);
      return type ? result.filter((event: any) => event.type === type) : result;
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function configure(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
      const configuration = vscode.workspace.getConfiguration('mysti');
      saved.set(key, { value: target === vscode.ConfigurationTarget.Global
        ? configuration.inspect(key)?.globalValue : configuration.inspect(key)?.workspaceValue, target });
      await configuration.update(key, value, target);
    }

    before(async () => {
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
      assert.ok(profile && path.isAbsolute(profile) && fs.existsSync(path.join(profile, 'DevToolsActivePort')),
        'PC-03 requires the runner fresh --user-data-dir profile');
      artifactDir = process.env.MYSTI_PC03_ARTIFACT_DIR || path.join(profile, 'pc03-evidence');
      fs.mkdirSync(artifactDir, { recursive: true });
      const requested = process.env.MYSTI_TEST_EXTENSION_PATH;
      assert.ok(requested && path.isAbsolute(requested));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti');
      assert.ok(extension);
      const actualPath = fs.realpathSync(extension.extensionPath), requestedPath = fs.realpathSync(requested);
      const hash = (root: string) => createHash('sha256').update(fs.readFileSync(path.join(root, 'dist/extension.js'))).digest('hex');
      record('loaded-extension-identity', { actualPath, requestedPath, actualHash: hash(actualPath), requestedHash: hash(requestedPath), vscode: vscode.version });
      assert.strictEqual(actualPath, requestedPath);
      assert.strictEqual(hash(actualPath), hash(requestedPath));
      const executable = process.env.MYSTI_PC03_CODEX_PATH;
      const node = process.env.MYSTI_PC03_NODE_PATH;
      assert.ok(executable && path.isAbsolute(executable) && fs.existsSync(executable));
      assert.ok(node && path.isAbsolute(node) && fs.existsSync(node), 'Supply the pinned Node executable for the wrapper');
      assert.notStrictEqual(process.platform, 'win32', 'This fixture uses a POSIX executable wrapper');
      assert.ok(vscode.workspace.workspaceFolders?.length);
      const factory = require(path.resolve(__dirname, '../scripts/validation/auth-cli-fixture.cjs'));
      fixture = factory.createAuthCliFixture(fs.mkdtempSync(path.join(artifactDir, 'cli-')), executable, node);
      await configure('codexPath', fixture.path, vscode.ConfigurationTarget.Global);
      for (const [key, value] of Object.entries({ codexModel: process.env.MYSTI_PC03_CODEX_MODEL || 'gpt-5.6-sol',
        defaultMode: 'quick-plan', accessLevel: 'read-only', autoContext: false, showSuggestions: false })) {
        await configure(key, value, vscode.ConfigurationTarget.Workspace);
      }
      const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      }
      assert.ok(workbench);
      workbench.setDefaultTimeout(15_000);
      assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat')).length, 0);
      terminals = vscode.window.onDidOpenTerminal(terminal => {
        if (/Codex.*Authentication/i.test(terminal.name)) ownedTerminals.push(terminal);
      });
      await extension.activate();
      await vscode.commands.executeCommand('mysti.openChat');
      await workbench.bringToFront();
      await until('One intended sidebar must initialize', async () => {
        const found: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          try {
            if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() &&
              (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) found.push(candidate);
          } catch { /* Frame still loading. */ }
        }
        if (found.length !== 1) return false;
        frame = found[0]; return true;
      }, 30_000);
      if (await frame.locator('#setup-wizard').isVisible()) await frame.locator('.wizard-skip-btn').click();
      // Attach after document.open/readiness. Observe genuine messages only.
      await frame.evaluate(() => {
        const win = globalThis as any;
        win.__pc03Events = [];
        win.__pc03Listener = (event: any) => {
          const message = event.data, payload = message?.payload || {};
          const types = ['conversationChanged', 'messageAdded', 'responseStarted', 'responseComplete', 'authError',
            'setupComplete', 'setupFailed', 'toolUse', 'permissionRequest', 'error'];
          if (!types.includes(message?.type)) return;
          let captured: any = {};
          if (message.type === 'conversationChanged') captured = { id: payload.id };
          if (message.type === 'messageAdded') captured = { id: payload.id, role: payload.role };
          if (message.type === 'responseComplete') captured = { message: payload.message && {
            id: payload.message.id, provider: payload.message.provider, model: payload.message.model, content: payload.message.content } };
          if (['authError', 'setupComplete', 'setupFailed'].includes(message.type)) captured = {
            providerId: payload.providerId, requiresVerification: payload.requiresVerification,
            authReasonPresent: typeof payload.error === 'string' && /auth|sign.?in|unauthorized|401/i.test(payload.error) };
          win.__pc03Events.push({ type: message.type, at: Date.now(), payload: captured });
        };
        win.addEventListener('message', win.__pc03Listener);
      });
      record('fixture-scope', { fixturePath: fixture.path, selectedExecutable: executable,
        scope: 'Process-only ephemeral signed-out CLI; guarded login handoff; restored existing-account inference. No actual login, revocation, credential rotation, or elapsed soak.' });
    });

    afterEach(async function () {
      if (!artifactDir) return;
      record(this.currentTest?.state === 'failed' ? 'case-failed' : 'case-complete', {
        error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message },
        events: frame && await events(),
      });
      if (this.currentTest?.state === 'failed' && workbench) {
        await workbench.screenshot({ path: path.join(artifactDir, 'failure.png') }).catch(() => {});
      }
    });
    after(async () => {
      if (frame) {
        if (await frame.locator('#stop-btn').isVisible().catch(() => false)) await frame.locator('#stop-btn').click().catch(() => {});
        await frame.evaluate(() => {
          const win = globalThis as any;
          win.removeEventListener('message', win.__pc03Listener);
          delete win.__pc03Listener; delete win.__pc03Events;
        }).catch(() => {});
      }
      terminals?.dispose();
      ownedTerminals.forEach(terminal => terminal.dispose());
      fixture?.setSignedOut(false);
      for (const [key, previous] of saved) await vscode.workspace.getConfiguration('mysti').update(key, previous.value, previous.target);
      await browser?.close();
    });

    it('shows one genuine auth failure, guards the login handoff, and answers in the original conversation after account restoration', async () => {
      await frame.locator('#new-conversation-btn').click();
      await until('New conversation must have a real host identity', async () => (await events('conversationChanged')).length === 1);
      const conversationId = (await events('conversationChanged'))[0].payload.id;
      assert.ok(conversationId);
      await frame.locator('#agent-select-btn').click();
      await frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
      const model = process.env.MYSTI_PC03_CODEX_MODEL || 'gpt-5.6-sol';
      await until('Selected provider and model must reach the UI', async () =>
        /Codex/i.test(await frame.locator('#agent-name').innerText()) && await frame.locator('#model-select-inline').inputValue() === model);
      const prompt = 'Use only this inline JavaScript, no tools, files, commands or changes: function retryDelay(attempt, base=73, cap=500) { return Math.min(cap, base * 2 ** attempt); } What is retryDelay(1)? Reply exactly PC03_VALUE:146.';
      await frame.locator('#message-input').fill(prompt);
      await frame.locator('#send-btn').click();
      const draft = 'Keep my unsent review notes while authentication is unavailable.';
      await frame.locator('#message-input').fill(draft);
      await until('The actual isolated Codex must produce an authentication failure', async () => (await events('authError')).length > 0, 90_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      assert.strictEqual((await events('authError')).length, 1);
      assert.strictEqual((await events('authError'))[0].payload.providerId, 'openai-codex');
      assert.strictEqual((await events('responseComplete')).length, 0, 'Authentication failure cannot be announced as a successful response');
      assert.strictEqual(await frame.locator('.auth-error').count(), 1);
      assert.strictEqual(await frame.locator('#message-input').inputValue(), draft);
      assert.strictEqual(await frame.locator('#messages .message.user').count(), 1);
      await workbench.screenshot({ path: path.join(artifactDir, 'actual-auth-failure.png') });
      record('actual-signed-out-failure', { conversationId, prompt, provider: 'openai-codex', model, draftPreserved: true });

      // SetupManager must route the actual button to the selected wrapper.
      // Its guard rejects login before the real CLI is invoked.
      await frame.locator('#auth-terminal-btn').click();
      await until('The actual auth handoff must reach the selected fixture guard', async () =>
        fs.existsSync(fixture.blockedActionsPath), 30_000);
      const blocked = fs.readFileSync(fixture.blockedActionsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.deepStrictEqual(blocked.map(entry => entry.action), ['login']);
      assert.strictEqual(ownedTerminals.length, 1);
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('mysti.openChat');
      await workbench.bringToFront();
      let cancelledViaUi = false;
      if (await frame.locator('#auth-wait-skip-btn').isVisible()) {
        await frame.locator('#auth-wait-skip-btn').click(); cancelledViaUi = true;
      }
      await frame.locator('#setup-overlay').waitFor({ state: 'hidden' });
      ownedTerminals.forEach(terminal => terminal.dispose());
      assert.strictEqual(await frame.locator('#message-input').inputValue(), draft);
      assert.strictEqual((await events('responseComplete')).length, 0);
      record('guarded-auth-handoff', { blocked, cancelledViaUi,
        detectedCredentials: (await events('setupComplete')).map(event => event.payload),
        scope: 'Actual card and terminal invocation; fixture refuses login before any remote account action. Credential detection is not proof of restored access.' });

      fixture.setSignedOut(false);
      const recovery = 'Continue the original inline retryDelay task using its exact base and cap. What is retryDelay(2)? No tools, files, commands or changes. Reply exactly PC03_RECOVERED:<number>.';
      await frame.locator('#message-input').fill(recovery);
      await frame.locator('#send-btn').click();
      await until('Restored existing-account Codex must complete the same-task response', async () => (await events('responseComplete')).length > 0, 120_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const completions = await events('responseComplete');
      assert.strictEqual(completions.length, 1);
      const answer = completions[0].payload.message;
      assert.strictEqual(answer.provider, 'openai-codex');
      assert.strictEqual(answer.model, model);
      assert.strictEqual(answer.content.trim(), 'PC03_RECOVERED:292');
      assert.strictEqual((await events('authError')).length, 1);
      assert.strictEqual((await events('conversationChanged')).length, 1, 'Recovery must preserve the original conversation');
      assert.strictEqual((await events('conversationChanged'))[0].payload.id, conversationId);
      assert.strictEqual(await frame.locator('#messages .message.user').count(), 2);
      assert.strictEqual(await frame.locator('#messages .message.assistant').count(), 1);
      assert.strictEqual((await events('toolUse')).length, 0);
      assert.strictEqual((await events('permissionRequest')).length, 0);
      assert.strictEqual((await frame.locator('#messages .message.assistant .message-content').allTextContents()).join('\n').trim(), answer.content.trim());
      await workbench.screenshot({ path: path.join(artifactDir, 'same-task-recovered.png') });
      record('existing-account-recovered', { conversationId, prompt: recovery, answer,
        scope: 'Existing-account restoration and real same-task inference; not fresh login, revocation, or credential rotation.' });
    });
  });
}
