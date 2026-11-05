/**
 * PC-04 actual packaged-editor controls and opt-in Codex request receipts.
 * MYSTI_PC04=1: bounded 100 UI effort changes + 20 public catalog requests.
 * MYSTI_PC04_LIVE=1 additionally performs four existing-account Codex turns.
 * Required: MYSTI_TEST_EXTENSION_PATH, MYSTI_PC04_CODEX_PATH,
 * MYSTI_PC04_NODE_PATH and the runner's fresh MYSTI_TEST_USER_DATA_DIR.
 * Optional: MYSTI_PC04_CODEX_MODEL, MYSTI_PC04_CODEX_PROFILE (already existing),
 * MYSTI_PC04_ARTIFACT_DIR. No CLI config/credential writes or native auth.
 * Catalog requests may use cache; this is not 20 forced probes or an 8h soak.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';

interface SettingsReceipt { method: string; model?: string; effort?: string; profile?: string }
// CodexProvider.CODEX_EFFORT_LEVELS; additionally checked against the actual UI.
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

if (process.env.MYSTI_PC04 === '1') {
  describe('PC-04 real editor model and reasoning settings', function () {
    this.timeout(300_000);
    let browser: Browser, workbench: Page, frame: Frame, artifactDir: string;
    let fixture: { path: string; receiptsPath: string };
    const model = process.env.MYSTI_PC04_CODEX_MODEL || 'gpt-5.6-sol';
    const profile = process.env.MYSTI_PC04_CODEX_PROFILE || '';
    const observations: unknown[] = [];
    const ownedTabs: vscode.Tab[] = [];
    const saved: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
    const draft = 'Keep these unsent retry-review notes while I compare settings.';

    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { ...details, event, at: new Date().toISOString() };
      observations.push(entry);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-04]', JSON.stringify(entry));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    function receipts(): SettingsReceipt[] {
      if (!fs.existsSync(fixture.receiptsPath)) return [];
      return fs.readFileSync(fixture.receiptsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    }
    async function events(type?: string): Promise<any[]> {
      const result = await frame.evaluate(() => (globalThis as any).__pc04Events || []);
      return type ? result.filter((event: any) => event.type === type) : result;
    }
    async function configure(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
      const configuration = vscode.workspace.getConfiguration('mysti');
      if (!saved.some(previous => previous.key === key && previous.target === target)) saved.push({ key, target,
        value: target === vscode.ConfigurationTarget.Global ? configuration.inspect(key)?.globalValue : configuration.inspect(key)?.workspaceValue });
      await configuration.update(key, value, target);
    }
    async function chooseEffort(effort: string, menu: 'model' | 'tools'): Promise<void> {
      await frame.locator(`#${menu}-menu-btn`).click();
      const slider = frame.locator(`#${menu}-menu input[type="range"]`);
      assert.strictEqual(await slider.getAttribute('max'), String(EFFORTS.length - 1));
      await slider.press(effort === 'xhigh' ? 'End' : 'Home');
      if (effort !== 'xhigh') for (let index = 0; index < EFFORTS.indexOf(effort); index++) await slider.press('ArrowRight');
      await slider.press('Escape');
      await until(`The ${menu} menu must persist ${effort}`, async () =>
        await frame.locator('#effort-select-inline').inputValue() === effort &&
        vscode.workspace.getConfiguration('mysti').get('defaultEffortLevel') === effort);
    }
    async function selectCodex(): Promise<void> {
      await frame.locator('#agent-select-btn').click();
      await frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
      await until('Codex selection must settle', async () => /Codex/i.test(await frame.locator('#agent-name').innerText()));
    }

    before(async () => {
      const userData = process.env.MYSTI_TEST_USER_DATA_DIR;
      assert.ok(userData && path.isAbsolute(userData) && fs.existsSync(path.join(userData, 'DevToolsActivePort')),
        'Settings writes require the runner fresh --user-data-dir profile');
      artifactDir = process.env.MYSTI_PC04_ARTIFACT_DIR || path.join(userData, 'pc04-evidence');
      fs.mkdirSync(artifactDir, { recursive: true });
      const requested = process.env.MYSTI_TEST_EXTENSION_PATH;
      assert.ok(requested && path.isAbsolute(requested));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      const actualPath = fs.realpathSync(extension.extensionPath), requestedPath = fs.realpathSync(requested);
      const hash = (root: string) => createHash('sha256').update(fs.readFileSync(path.join(root, 'dist/extension.js'))).digest('hex');
      record('loaded-extension-identity', { actualPath, requestedPath, actualHash: hash(actualPath), requestedHash: hash(requestedPath), vscode: vscode.version });
      assert.strictEqual(actualPath, requestedPath); assert.strictEqual(hash(actualPath), hash(requestedPath));
      const executable = process.env.MYSTI_PC04_CODEX_PATH, node = process.env.MYSTI_PC04_NODE_PATH;
      assert.ok(executable && path.isAbsolute(executable) && fs.existsSync(executable));
      assert.ok(node && path.isAbsolute(node) && fs.existsSync(node));
      assert.notStrictEqual(process.platform, 'win32', 'This selected-CLI fixture uses a POSIX wrapper');
      assert.ok(vscode.workspace.workspaceFolders?.length);
      const factory = require(path.resolve(__dirname, '../scripts/validation/settings-cli-fixture.cjs'));
      fixture = factory.createSettingsCliFixture(fs.mkdtempSync(path.join(artifactDir, 'cli-')), executable, node);
      // Machine-scoped path belongs to this disposable editor profile. Picker
      // writes are global too; clear only this fixture workspace's shadow values.
      await configure('codexPath', fixture.path, vscode.ConfigurationTarget.Global);
      for (const [key, value] of Object.entries({ defaultAgent: 'openai-codex', defaultProvider: 'openai-codex',
        defaultModel: model, codexModel: '', defaultEffortLevel: 'high', defaultThinkingLevel: 'none', codexProfile: '' })) {
        if (key !== 'codexProfile') await configure(key, undefined, vscode.ConfigurationTarget.Workspace);
        await configure(key, value, vscode.ConfigurationTarget.Global);
      }
      for (const [key, value] of Object.entries({ defaultMode: 'quick-plan', accessLevel: 'read-only', autoContext: false, showSuggestions: false })) {
        await configure(key, value, vscode.ConfigurationTarget.Workspace);
      }
      const endpoint = fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat')).length, 0);
      await extension.activate();
      await vscode.commands.executeCommand('mysti.openChat'); await workbench.bringToFront();
      await until('One intended sidebar must initialize', async () => {
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          try {
            if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() &&
              (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) candidates.push(candidate);
          } catch { /* A frame is mounting. */ }
        }
        if (candidates.length !== 1) return false;
        frame = candidates[0]; return true;
      }, 30_000);
      if (await frame.locator('#setup-wizard').isVisible()) await frame.locator('.wizard-skip-btn').click();
      // Attach to the current document after webview document.open/readiness.
      // These are genuine host messages; no host event or API is simulated.
      await frame.evaluate(() => {
        const win = globalThis as any;
        win.__pc04Events = [];
        win.__pc04Listener = (event: any) => {
          const message = event.data, payload = message?.payload || {};
          const types = ['conversationChanged', 'modelsUpdated', 'modelChanged', 'responseStarted', 'responseComplete', 'authError', 'error', 'toolUse', 'permissionRequest'];
          if (!types.includes(message?.type)) return;
          let captured: any = {};
          if (message.type === 'conversationChanged') captured = { id: payload.id };
          if (message.type === 'modelsUpdated') captured = { provider: payload.provider, count: payload.models?.length };
          if (message.type === 'modelChanged') captured = { provider: payload.provider, model: payload.model, customModel: payload.customModel };
          if (message.type === 'responseComplete') captured = { message: payload.message && {
            provider: payload.message.provider, model: payload.message.model, content: payload.message.content } };
          win.__pc04Events.push({ type: message.type, at: Date.now(), payload: captured });
        };
        win.addEventListener('message', win.__pc04Listener);
      });
      await frame.locator('#new-conversation-btn').click();
      await until('New chat must have a genuine host identity', async () => (await events('conversationChanged')).length === 1);
      await selectCodex();
      await until('The selected model must be displayed', async () => await frame.locator('#model-select-inline').inputValue() === model);
      assert.deepStrictEqual(await frame.locator('#effort-select-inline option').evaluateAll(options => options.map(option => (option as any).value)), EFFORTS);
      await frame.locator('#message-input').fill(draft);
      record('fixture-scope', { selectedExecutable: executable, wrapper: fixture.path, model, suppliedExistingProfile: profile || null,
        liveEnabled: process.env.MYSTI_PC04_LIVE === '1',
        scope: 'Actual UI operations; optional four existing-account turns; strict model/effort/profile receipts. No CLI config/credential changes. No elapsed workday or persistence soak.' });
    });

    afterEach(async function () {
      if (!artifactDir) return;
      record(this.currentTest?.state === 'failed' ? 'case-failed' : 'case-complete', {
        title: this.currentTest?.title, error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message },
        receipts: fixture && receipts(), events: frame && await events().catch(() => []),
      });
      if (this.currentTest?.state === 'failed' && workbench) await workbench.screenshot({ path: path.join(artifactDir, 'failure.png') }).catch(() => {});
      for (const tab of ownedTabs.splice(0)) await vscode.window.tabGroups.close(tab).then(() => {}, () => {});
      if (frame) { await vscode.commands.executeCommand('mysti.openChat'); await workbench.bringToFront(); }
    });
    after(async () => {
      if (frame) {
        if (await frame.locator('#stop-btn').isVisible().catch(() => false)) await frame.locator('#stop-btn').click().catch(() => {});
        await frame.evaluate(() => { const win = globalThis as any; win.removeEventListener('message', win.__pc04Listener); }).catch(() => {});
      }
      for (const previous of saved.reverse()) await vscode.workspace.getConfiguration('mysti').update(previous.key, previous.value, previous.target);
      await browser?.close();
    });

    it('preserves a draft through 100 actual effort changes and 20 public catalog requests', async () => {
      const started = Date.now(), initialTurns = receipts().filter(receipt => receipt.method === 'turn/start').length;
      let catalogRequests = 0;
      for (let change = 0; change < 100; change++) {
        await chooseEffort(change % 2 ? 'low' : 'xhigh', change % 2 ? 'tools' : 'model');
        if (change % 5 === 0) {
          const prior = (await events('modelsUpdated')).filter(event => event.payload.provider === 'openai-codex').length;
          await selectCodex();
          await until('Public agent selection must return a fresh catalog event', async () =>
            (await events('modelsUpdated')).filter(event => event.payload.provider === 'openai-codex').length > prior);
          catalogRequests++;
        }
        assert.strictEqual(await frame.locator('#message-input').inputValue(), draft);
        assert.strictEqual(await frame.locator('#model-select-inline').inputValue(), model);
      }
      assert.strictEqual(receipts().filter(receipt => receipt.method === 'turn/start').length, initialTurns);
      assert.strictEqual(await frame.locator('#messages .message').count(), 0);
      assert.strictEqual(catalogRequests, 20);
      record('bounded-settings-load', { actualEffortChanges: 100, menus: ['model', 'tools'], publicCatalogRequests: catalogRequests,
        elapsedMs: Date.now() - started, draftPreserved: true, inferenceTurns: 0,
        scope: 'Public requests may return cached catalogs; no forced discovery, 30-turn run, or 8-hour soak is claimed.' });
    });

    it('shows honest Codex thinking guidance in the real settings hub and round-trips a custom model through the native input', async () => {
      const beforeTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      await frame.locator('#overflow-btn').click(); await frame.locator('#settings-btn').click();
      let hub: Frame | undefined;
      await until('The real bound settings tab must open', async () => {
        for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) if (!beforeTabs.has(tab) && !ownedTabs.includes(tab)) ownedTabs.push(tab);
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          try {
            if (await candidate.locator('body.view-hub:not(.hub-unbound)').count() && await candidate.locator('#thinking-select').isVisible()) { hub = candidate; return true; }
          } catch { /* New hub document is initializing. */ }
        }
        return false;
      });
      assert.ok(hub);
      assert.strictEqual(await hub.locator('#thinking-advisory-hint').isVisible(), true);
      assert.match(await hub.locator('#thinking-advisory-hint').innerText(), /does not enforce/);
      assert.strictEqual(await hub.locator('#ultracode-section').isVisible(), false);
      await hub.locator('#thinking-select').selectOption('high');
      await until('Advisory thinking choice must save', async () => vscode.workspace.getConfiguration('mysti').get('defaultThinkingLevel') === 'high');
      await hub.locator('#thinking-select').selectOption('none');
      await until('Thinking default must be restored', async () => vscode.workspace.getConfiguration('mysti').get('defaultThinkingLevel') === 'none');
      if (profile) {
        const field = hub.locator('#provider-settings-sections .settings-section').filter({ hasText: 'Codex Profile' }).locator('input');
        await field.fill(profile); await field.press('Tab');
        await until('The supplied existing Codex profile must save', async () => vscode.workspace.getConfiguration('mysti').get('codexProfile') === profile);
      }
      for (const tab of ownedTabs.splice(0)) await vscode.window.tabGroups.close(tab);
      await vscode.commands.executeCommand('mysti.openChat'); await workbench.bringToFront();
      await frame.locator('#model-menu-btn').click(); await frame.locator('#model-menu [data-model="__custom__"]').click();
      const input = workbench.locator('.quick-input-widget input[type="text"]');
      await input.waitFor({ state: 'visible' });
      assert.match(await workbench.locator('.quick-input-widget').innerText(), /custom model/i);
      await input.fill(model); await input.press('Enter'); await input.waitFor({ state: 'hidden' });
      await until('Native custom model must be reflected by a real modelChanged', async () =>
        (await events('modelChanged')).some(event => event.payload.provider === 'openai-codex' && event.payload.model === model && event.payload.customModel === model));
      assert.strictEqual(vscode.workspace.getConfiguration('mysti').get('codexModel'), model);
      assert.strictEqual(await frame.locator('#message-input').inputValue(), draft);
      record('native-custom-and-advisory', { model, customModel: model, advisoryThinkingRoundTrip: ['high', 'none'], unsupportedUltracodeHidden: true,
        profile: profile || null, profileScope: profile ? 'User-supplied existing profile; no CLI config file read/write.' : 'Named profile not exercised; default-profile path only.' });
    });

    if (process.env.MYSTI_PC04_LIVE === '1') it('sends every Codex effort tier on the actual wire and retains the retry task across settings changes', async () => {
      const started = Date.now(), replies: unknown[] = [], conversationId = (await events('conversationChanged'))[0].payload.id;
      for (let index = 0; index < EFFORTS.length; index++) {
        const effort = EFFORTS[index];
        await chooseEffort(effort, index % 2 ? 'tools' : 'model');
        // Return to the discovered model through its real menu after proving
        // the same valid ID as a custom override on the first two wire turns.
        if (index === 2) {
          await frame.locator('#model-menu-btn').click();
          const options = frame.locator('#model-menu-options [data-model]');
          const identities = await options.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-model')));
          const chosen = identities.indexOf(model); assert.ok(chosen >= 0, 'The intended model must have its own exact menu identity');
          await options.nth(chosen).click();
          await until('Selecting the listed model must clear the custom override', async () => vscode.workspace.getConfiguration('mysti').get('codexModel') === '');
          assert.strictEqual(await frame.locator('#model-select-inline').inputValue(), model);
        }
        const beforeReceipts = receipts().length, beforeReplies = (await events('responseComplete')).length;
        const prompt = index === 0
          ? 'Use only this inline JavaScript, no tools, files, commands or changes: function retryDelay(attempt, base=73, cap=500) { return Math.min(cap, base * 2 ** attempt); } Remember it for the next three questions. What is retryDelay(0)? Reply exactly PC04_VALUE:73.'
          : `Using the exact retryDelay function from our first question, what is retryDelay(${index})? No tools, files, commands or changes. Reply exactly PC04_VALUE:<number>.`;
        await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
        await frame.locator('#message-input').fill(draft);
        await until(`Actual ${effort} Codex answer must complete`, async () => (await events('responseComplete')).length > beforeReplies, 120_000);
        await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
        const answer = (await events('responseComplete')).at(-1).payload.message;
        assert.strictEqual(answer.provider, 'openai-codex'); assert.strictEqual(answer.model, model);
        assert.strictEqual(answer.content.trim(), `PC04_VALUE:${[73, 146, 292, 500][index]}`);
        const actual = receipts().slice(beforeReceipts), turns = actual.filter(receipt => receipt.method === 'turn/start');
        assert.strictEqual(turns.length, 1, 'One accepted user turn must produce one actual turn/start');
        assert.strictEqual(turns[0].effort, effort);
        const thread = receipts().filter(receipt => receipt.method === 'thread/start' || receipt.method === 'thread/resume').at(-1);
        assert.ok(thread, 'The actual app-server must receive a thread start/resume with a model');
        assert.strictEqual(thread.model, model); assert.strictEqual(thread.effort, effort);
        assert.strictEqual(thread.profile || '', profile);
        assert.strictEqual(await frame.locator('#message-input').inputValue(), draft);
        assert.strictEqual((await events('conversationChanged')).length, 1);
        assert.strictEqual((await events('authError')).length, 0); assert.strictEqual((await events('error')).length, 0);
        assert.strictEqual((await events('toolUse')).length, 0); assert.strictEqual((await events('permissionRequest')).length, 0);
        replies.push({ effort, answer: answer.content.trim(), actualReceipts: actual });
        record('actual-settings-turn', { conversationId, provider: answer.provider, model, effort, answer: answer.content.trim(), actualReceipts: actual });
      }
      assert.strictEqual(await frame.locator('#messages .message.assistant').count(), 4);
      await workbench.screenshot({ path: path.join(artifactDir, 'four-effort-replies.png') });
      record('four-tier-wire-complete', { elapsedMs: Date.now() - started, conversationId, replies,
        scope: 'Four actual existing-account Codex turns, both menus and custom/listed model precedence; no 8h/250turn or restart-soak claim.' });
    }).timeout(540_000);
  });
}
