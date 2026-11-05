/**
 * PC-02: actual editor discovery, diagnostics and installer refresh surfaces.
 * MYSTI_PC02=1 opts in; run alone with --grep 'PC-02' in the runner's fresh
 * profile. MYSTI_PC02_REFRESHES=50 exercises the planned bounded iteration
 * count; the default is six. Neither count claims an eight-hour soak.
 * MYSTI_TEST_EXTENSION_PATH must identify the exact extracted release payload;
 * its realpath and dist/extension.js hash are checked before any test action.
 * The default cases request no install, upgrade, terminal command, login or inference.
 * Optional MYSTI_PC02_CODEX_PATH / MYSTI_PC02_EXPECTED_CODEX_VERSION point at
 * root's disposable installation. The machine-scoped codexPath is written to
 * the runner's disposable user-data profile; other settings use the scratch
 * workspace. Every written value is restored during cleanup.
 * MYSTI_PC02_UPDATE=1 authorizes one update of that disposable prefix to
 * MYSTI_PC02_UPDATED_CODEX_VERSION via the actual update card. Also setting
 * MYSTI_PC02_UPDATE_LIVE=1 adds one read-only answer using an existing login.
 * MYSTI_PC02_UPDATE_TIMEOUT_MS bounds version verification (default 240000,
 * maximum 900000) so a slow package download is reported with its actual bound.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

if (process.env.MYSTI_PC02 === '1') {
  describe('PC-02 provider discovery and installer surfaces in the real editor', function () {
    const refreshes = Number(process.env.MYSTI_PC02_REFRESHES || 6);
    assert.ok(Number.isInteger(refreshes) && refreshes >= 3 && refreshes <= 100,
      'MYSTI_PC02_REFRESHES must be an integer from 3 to 100');
    this.timeout(180_000 + refreshes * 35_000);
    const updateTimeout = Number(process.env.MYSTI_PC02_UPDATE_TIMEOUT_MS || 240_000);
    assert.ok(Number.isInteger(updateTimeout) && updateTimeout >= 1_000 && updateTimeout <= 900_000,
      'MYSTI_PC02_UPDATE_TIMEOUT_MS must be an integer from 1000 to 900000');
    interface Panel { label: string; frame: Frame; tab?: vscode.Tab; providerId?: string }
    interface HostEvent { type: string; at: number; payload: any }
    interface ProcessIdentity { pid: number; ppid: number }
    let browser: Browser, workbench: Page, artifactDir: string;
    const panels: Panel[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const openedTerminals: string[] = [];
    let terminalListener: vscode.Disposable | undefined;
    let previousCodexPath: unknown;
    let changedCodexPath = false;
    const savedUpdateSettings = new Map<string, unknown>();
    let ownedUpdateTerminal: vscode.Terminal | undefined;
    const execFileAsync = promisify(execFile);

    function observeUpdateOffers(): void {
      const win = globalThis as any;
      if (!win.__pc02UpdateListener) {
        win.__pc02UpdateOffers = [];
        win.__pc02UpdateObserverInstalledAt = Date.now();
        win.__pc02UpdateListener = (event: any) => {
          if (event.data?.type === 'cliUpdatesAvailable') {
            win.__pc02UpdateOffers.push({ at: Date.now(), updates: event.data.payload?.updates || [],
              hasUpdatesArray: Array.isArray(event.data.payload?.updates) });
          }
        };
      }
      // VS Code populates fake.html with document.open/write/close, which
      // removes early window listeners without clearing custom globals.
      // Reattach after readiness; preserve any events already observed.
      win.removeEventListener('message', win.__pc02UpdateListener);
      win.addEventListener('message', win.__pc02UpdateListener);
      win.__pc02UpdateObserverAttachedAt = Date.now();
    }

    // Accept only the literal shell words emitted by Mysti's POSIX updater.
    // Operators, expansions and escape syntax cannot pass this pre-click gate.
    function literalShellWords(command: string): string[] {
      const words: string[] = [];
      let word = '', started = false;
      for (let index = 0; index < command.length; index++) {
        const character = command[index];
        assert.ok(character !== '\n' && character !== '\r' && character !== '\0', 'Update command must be one literal command');
        if (character === ' ') {
          if (started) { words.push(word); word = ''; started = false; }
        } else if (character === "'" || character === '"') {
          const quote = character;
          started = true;
          let closed = false;
          while (++index < command.length) {
            const quoted = command[index];
            if (quoted === quote) { closed = true; break; }
            assert.ok(!/[\n\r\0]/.test(quoted), 'Multiline shell words are not permitted');
            if (quote === '"') { assert.ok(!/[$`\\]/.test(quoted), 'Shell expansion is not permitted'); }
            word += quoted;
          }
          assert.ok(closed, 'Unterminated shell quote');
        } else {
          assert.match(character, /^[A-Za-z0-9_@./:+-]$/, 'Unexpected shell syntax in update command');
          started = true; word += character;
        }
      }
      if (started) { words.push(word); }
      return words;
    }

    async function executableVersion(executable: string): Promise<string | undefined> {
      const result = await execFileAsync(executable, ['--version'], { timeout: 10_000, maxBuffer: 16_384 });
      return result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0];
    }

    async function selectedAppServerProcesses(prefix: string): Promise<{ selected: ProcessIdentity[]; livePids: Set<number> }> {
      assert.notStrictEqual(process.platform, 'win32', 'Runtime identity verification requires POSIX ps');
      const acceptedPrefixes = [...new Set([prefix, fs.realpathSync(prefix)])].map(value => value + path.sep);
      let output: string;
      try {
        // Read argv only to filter locally; never persist it or read process
        // environments. Both the npm launcher and its native child may match.
        output = (await execFileAsync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,args='], {
          timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
        })).stdout;
      } catch {
        throw new Error('Read-only POSIX process snapshot failed; raw process output omitted.');
      }
      const selected: ProcessIdentity[] = [];
      const livePids = new Set<number>();
      for (const line of output.split(/\r?\n/)) {
        const row = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!row) { continue; }
        const pid = Number(row[1]), ppid = Number(row[2]), command = row[3];
        livePids.add(pid);
        if (/(?:^|\s)app-server(?:\s|$)/.test(command) && acceptedPrefixes.some(value => command.includes(value))) {
          selected.push({ pid, ppid });
        }
      }
      return { selected: selected.sort((left, right) => left.pid - right.pid), livePids };
    }

    function record(event: string, details: Record<string, unknown> = {}): void {
      const row = { ...details, at: new Date().toISOString(), event };
      observations.push(row);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-02]', JSON.stringify(row));
    }

    async function frames(): Promise<Frame[]> {
      const found: Frame[] = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          for (const frame of page.frames()) {
            try {
              if (await frame.locator('#message-input').count() && !await frame.locator('body.view-hub').count()) {
                found.push(frame);
              }
            } catch { /* A closing frame can detach during a read-only scan. */ }
          }
        }
      }
      return found;
    }

    async function diagnosticState(): Promise<unknown> {
      return Promise.all(panels.map(async panel => ({
        panel: panel.label, url: panel.frame.url(), tabActive: panel.tab?.isActive,
        state: await panel.frame.evaluate(() => {
          const win = globalThis as any;
          const doc = win.document;
          const updateOffers = win.__pc02UpdateOffers || [];
          // Restrict failure evidence to catalogue identities and versions.
          // Commands, arbitrary descriptions and manual paths are deliberately
          // omitted here; the validated update command is recorded pre-click.
          const identity = (value: unknown) => typeof value === 'string' && /^[a-z0-9@/._-]{1,100}$/i.test(value) ? value : undefined;
          const version = (value: unknown) => typeof value === 'string' && /^v?\d+(?:\.\d+){1,2}(?:[-+][a-z0-9.-]+)?$/i.test(value) ? value : undefined;
          return {
            focus: doc.activeElement?.id, wizard: doc.querySelector('#setup-wizard')?.className,
            setup: doc.querySelector('#setup-overlay')?.className, installer: doc.querySelector('#install-provider-modal')?.className,
            installerTitle: doc.querySelector('#install-provider-title')?.textContent,
            installerStatus: doc.querySelector('#install-status')?.textContent,
            events: win.__pc02Events?.slice(-4),
            updateObserver: {
              installed: typeof win.__pc02UpdateListener === 'function', installedAt: win.__pc02UpdateObserverInstalledAt,
              attachedAt: win.__pc02UpdateObserverAttachedAt,
              eventCount: updateOffers.length,
              recentEvents: updateOffers.slice(-8).map((event: any) => ({
                at: event.at, hasUpdatesArray: event.hasUpdatesArray,
                updates: Array.isArray(event.updates) ? event.updates.map((row: any) => ({
                  providerId: identity(row?.providerId), packageName: identity(row?.packageName),
                  installed: version(row?.installed), latest: version(row?.latest), installable: version(row?.installable),
                  blockedByNodeEngine: row?.blockedByNodeEngine === true,
                  commandPresent: typeof row?.command === 'string' && row.command.length > 0,
                  manualUpdateReasonPresent: typeof row?.manualUpdateReason === 'string' && row.manualUpdateReason.length > 0,
                })) : undefined,
              })),
            },
            currentNotice: Array.from(doc.querySelectorAll('#update-notices .update-card')).map((card: any) => ({
              kind: identity(card.getAttribute('data-kind')), providerId: identity(card.getAttribute('data-provider')),
              position: card.querySelector('.update-count')?.textContent,
            })),
          };
        }).catch(() => ({ detached: true })),
      })));
    }

    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000, pollMs = 100): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) { return; }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      throw new Error(`${label}: timed out after ${timeout}ms. ${JSON.stringify(await diagnosticState())}`);
    }

    async function newFrame(excluded = new Set<Frame>()): Promise<Frame> {
      let selected: Frame | undefined;
      await until('Exactly one intended chat must initialize', async () => {
        const candidates = (await frames()).filter(frame => !excluded.has(frame));
        if (candidates.length !== 1) { return false; }
        if (!(await candidates[0].locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) { return false; }
        selected = candidates[0];
        return true;
      }, 30_000);
      assert.ok(selected);
      return selected;
    }

    async function reveal(panel: Panel): Promise<void> {
      await workbench.bringToFront();
      if (!panel.tab) {
        await vscode.commands.executeCommand('mysti.openChat');
        return;
      }
      const group = vscode.window.tabGroups.all.find(candidate => candidate.tabs.includes(panel.tab!));
      assert.ok(group, 'The intended editor chat must still exist');
      // openInNewTab uses ViewColumn.Beside, so the two retained chats can
      // legitimately occupy different groups. Select the owning group first.
      const ordinals = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'];
      const ordinal = ordinals[group.viewColumn - 1];
      assert.ok(ordinal, 'The target chat must have an addressable editor group');
      await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`);
      await until('The intended editor group must become active', async () =>
        vscode.window.tabGroups.activeTabGroup.viewColumn === group.viewColumn);
      const index = group.tabs.indexOf(panel.tab);
      assert.ok(index >= 0 && index < 9);
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
      await until('The actual target chat tab must become active', async () =>
        vscode.window.tabGroups.activeTabGroup.viewColumn === group.viewColumn &&
        vscode.window.tabGroups.activeTabGroup.activeTab === panel.tab);
    }

    async function dismissOwnedUiAfterFailure(): Promise<void> {
      for (const panel of panels) {
        try {
          await reveal(panel);
          // Use the same visible Close/Skip/Stop controls as a user. Preserve
          // the original failure evidence before removing any overlay.
          if (await panel.frame.locator('#install-provider-modal').isVisible()) {
            await panel.frame.locator('#install-close-btn').click();
            await panel.frame.locator('#install-provider-modal').waitFor({ state: 'hidden' });
          }
          if (await panel.frame.locator('#auth-options-modal').isVisible()) {
            await panel.frame.locator('.auth-options-cancel').click();
          }
          if (await panel.frame.locator('#setup-overlay').isVisible()) {
            const exits = ['#auth-error-close-btn', '#setup-skip-btn', '#auth-skip-btn', '#auth-wait-skip-btn', '#auth-choice-skip-btn'];
            let dismissed = false;
            for (const selector of exits) {
              const button = panel.frame.locator(selector);
              if (await button.isVisible()) { await button.click(); dismissed = true; break; }
            }
            assert.ok(dismissed, 'A visible setup overlay must expose an actual exit control');
            await panel.frame.locator('#setup-overlay').waitFor({ state: 'hidden' });
          }
          await skipWizard(panel);
          if (await panel.frame.locator('#stop-btn').isVisible()) { await panel.frame.locator('#stop-btn').click(); }
          if (await panel.frame.locator('#agent-menu').isVisible()) { await panel.frame.locator('#agent-select-btn').click(); }
          record('failure-ui-dismissed', { panel: panel.label });
        } catch (error) {
          record('failure-ui-cleanup-error', { panel: panel.label,
            message: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    async function observe(panel: Panel): Promise<void> {
      // Observe real host replies; never manufacture messages or access the
      // extension's private provider/setup state from this native suite.
      await panel.frame.evaluate(() => {
        const win = globalThis as any;
        const types = ['providerInstallInfo', 'providerDetectionComplete', 'wizardStatus', 'diagnosticsResult',
          'providerSetupStep', 'setupFailed', 'setupComplete', 'authPrompt', 'authOptions', 'setupProgress',
          'responseComplete', 'toolUse', 'permissionRequest'];
        win.__pc02Events = [];
        win.__pc02Listener = (event: any) => {
          const message = event.data;
          if (!types.includes(message?.type)) { return; }
          const p = message.payload || {};
          const payload = message.type === 'responseComplete'
            ? { message: p.message && { id: p.message.id, provider: p.message.provider, model: p.message.model, content: p.message.content } }
            : message.type === 'diagnosticsResult'
            ? { timestamp: p.timestamp, providerCount: p.providers?.length }
            : message.type === 'wizardStatus'
              ? { providers: p.providers?.map((provider: any) => ({
                providerId: provider.providerId, installed: provider.installed,
                authenticated: provider.authenticated, cliVersion: provider.cliVersion,
              })) }
              : { providerId: p.providerId, requestId: p.requestId, error: p.error,
                displayName: p.displayName, supportsAutoInstall: p.supportsAutoInstall,
                installed: p.installed, authenticated: p.authenticated, step: p.step };
          win.__pc02Events.push({ type: message.type, at: Date.now(), payload });
        };
        win.addEventListener('message', win.__pc02Listener);
      });
      await panel.frame.evaluate(observeUpdateOffers);
    }

    async function events(panel: Panel, type?: string): Promise<HostEvent[]> {
      const all = await panel.frame.evaluate(() => (globalThis as any).__pc02Events || []) as HostEvent[];
      return type ? all.filter(event => event.type === type) : all;
    }

    async function skipWizard(panel: Panel): Promise<void> {
      if (await panel.frame.locator('#setup-wizard').isVisible()) {
        await panel.frame.locator('.wizard-skip-btn').click();
        await panel.frame.locator('#setup-wizard').waitFor({ state: 'hidden' });
      }
    }

    async function openTab(label: string): Promise<Panel> {
      const excluded = new Set(await frames());
      let subscription: vscode.Disposable | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const announced = new Promise<vscode.Tab>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('No new Mysti chat tab was announced')), 15_000);
        subscription = vscode.window.tabGroups.onDidChangeTabs(event => {
          const tab = event.opened.find(candidate => candidate.input instanceof vscode.TabInputWebview &&
            candidate.input.viewType.includes('mysti.detachedChat'));
          if (tab) { resolve(tab); }
        });
      });
      let tab: vscode.Tab;
      try { await vscode.commands.executeCommand('mysti.openInNewTab'); tab = await announced; }
      finally { subscription?.dispose(); clearTimeout(timer); }
      const panel: Panel = { label, tab, frame: await newFrame(excluded) };
      panels.push(panel);
      await reveal(panel);
      await skipWizard(panel);
      await observe(panel);
      return panel;
    }

    async function composer(panel: Panel): Promise<{ agent: string; model: string; draft: string }> {
      return {
        agent: await panel.frame.locator('#agent-name').innerText(),
        model: await panel.frame.locator('#model-select-inline').inputValue(),
        draft: await panel.frame.locator('#message-input').inputValue(),
      };
    }

    before(async () => {
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
      assert.ok(profile, 'Run PC-02 in the fresh test editor, never attach to a daily editor');
      assert.ok(path.isAbsolute(profile) && fs.existsSync(path.join(profile, 'DevToolsActivePort')),
        'The runner must supply its active disposable --user-data-dir profile');
      artifactDir = process.env.MYSTI_PC02_ARTIFACT_DIR || path.join(profile, 'pc02-evidence');
      fs.mkdirSync(artifactDir, { recursive: true });
      const requestedExtensionPath = process.env.MYSTI_TEST_EXTENSION_PATH;
      assert.ok(requestedExtensionPath && path.isAbsolute(requestedExtensionPath),
        'PC-02 requires an absolute MYSTI_TEST_EXTENSION_PATH identifying the exact release payload');
      const extension = vscode.extensions.getExtension('DeepMyst.mysti');
      assert.ok(extension, 'The intended Mysti extension must be available in the test host');
      const actualExtensionPath = fs.realpathSync(extension.extensionPath);
      const requestedRealPath = fs.realpathSync(requestedExtensionPath);
      const bundleSha256 = (root: string) => createHash('sha256')
        .update(fs.readFileSync(path.join(root, 'dist', 'extension.js'))).digest('hex');
      const actualBundleSha256 = bundleSha256(actualExtensionPath);
      const requestedBundleSha256 = bundleSha256(requestedRealPath);
      record('loaded-extension-identity', { actualExtensionPath, requestedExtensionPath: requestedRealPath,
        actualBundleSha256, requestedBundleSha256, vscode: vscode.version, extension: extension.packageJSON.version });
      assert.strictEqual(actualExtensionPath, requestedRealPath, 'VS Code must load the exact requested extension directory');
      assert.strictEqual(actualBundleSha256, requestedBundleSha256, 'The loaded and requested dist/extension.js must match');
      const customPath = process.env.MYSTI_PC02_CODEX_PATH;
      if (process.env.MYSTI_PC02_UPDATE === '1') {
        assert.ok(customPath, 'An update requires the explicitly supplied disposable Codex path');
        assert.notStrictEqual(process.platform, 'win32', 'This bounded updater case validates the POSIX npm-prefix layout');
        assert.match(process.env.MYSTI_PC02_UPDATED_CODEX_VERSION || '', /^\d+\.\d+\.\d+(?:[-+].+)?$/,
          'An update requires its exact authorized target version');
      }
      if (customPath) {
        assert.ok(path.isAbsolute(customPath) && fs.existsSync(customPath), 'Supply the real disposable Codex executable');
        assert.match(process.env.MYSTI_PC02_EXPECTED_CODEX_VERSION || '', /^\d+\.\d+\.\d+(?:[-+].+)?$/,
          'An exact expected version is required with a custom Codex path');
        assert.ok(vscode.workspace.workspaceFolders?.length, 'The acceptance run requires the runner scratch workspace');
        const config = vscode.workspace.getConfiguration('mysti');
        // codexPath declares scope:"machine", so VS Code rejects workspace
        // writes. Global here is the verified test profile above, never the
        // developer's daily VS Code user-data directory.
        previousCodexPath = config.inspect('codexPath')?.globalValue;
        await config.update('codexPath', customPath, vscode.ConfigurationTarget.Global);
        changedCodexPath = true;
      }
      const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) {
        // Catch the real cached update reply during new-frame initialization,
        // before the normal ready-frame helper can attach its other observer.
        await context.addInitScript(observeUpdateOffers);
      }
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      }
      assert.ok(workbench);
      workbench.setDefaultTimeout(15_000);
      await extension.activate();
      assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat')).length, 0,
      'Run PC-02 alone in a fresh profile');
      terminalListener = vscode.window.onDidOpenTerminal(terminal => openedTerminals.push(terminal.name));
      await vscode.commands.executeCommand('mysti.openChat');
      const sidebar: Panel = { label: 'sidebar', frame: await newFrame() };
      panels.push(sidebar);
      await skipWizard(sidebar);
      await observe(sidebar);
      await openTab('editor-one');
      await openTab('editor-two');
      record('environment', { vscode: vscode.version, extension: extension.packageJSON.version,
        platform: process.platform, refreshes, panelCount: panels.length, customCodexPath: customPath,
        expectedCodexVersion: process.env.MYSTI_PC02_EXPECTED_CODEX_VERSION,
        scope: process.env.MYSTI_PC02_UPDATE === '1'
          ? 'Real discovery/diagnostics/refresh and one explicitly bounded disposable Codex update; optional existing-login answer; debug commands are simulated UI only; no elapsed soak claim.'
          : 'Real discovery, diagnostics and bounded refresh loop; debug commands are simulated UI only; no install/update/login/inference or elapsed soak claim.' });
    });

    afterEach(async function () {
      if (!browser) { return; }
      const error = this.currentTest?.err;
      record(this.currentTest?.state === 'failed' ? 'case-failed' : 'case-complete', {
        test: this.currentTest?.title, panels: await diagnosticState(), openedTerminals,
        error: error && { name: error.name, message: error.message, stack: error.stack },
        groups: vscode.window.tabGroups.all.map(group => ({ viewColumn: group.viewColumn, active: group.isActive,
          tabs: group.tabs.map(tab => ({ label: tab.label, active: tab.isActive,
            viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined })) })),
      });
      if (this.currentTest?.state === 'failed') {
        await workbench.screenshot({ path: path.join(artifactDir, `failure-${Date.now()}.png`) }).catch(() => {});
        await dismissOwnedUiAfterFailure();
      }
    });

    after(async () => {
      terminalListener?.dispose();
      for (const panel of panels) {
        await panel.frame.evaluate(() => {
          const win = globalThis as any;
          win.removeEventListener('message', win.__pc02Listener);
          win.removeEventListener('message', win.__pc02UpdateListener);
          delete win.__pc02Listener; delete win.__pc02Events;
          delete win.__pc02UpdateListener; delete win.__pc02UpdateOffers;
          delete win.__pc02UpdateObserverInstalledAt;
          delete win.__pc02UpdateObserverAttachedAt;
        }).catch(() => {});
        if (panel.tab) { await vscode.window.tabGroups.close(panel.tab); }
      }
      if (changedCodexPath) {
        await vscode.workspace.getConfiguration('mysti').update('codexPath', previousCodexPath, vscode.ConfigurationTarget.Global);
      }
      for (const [key, value] of savedUpdateSettings) {
        await vscode.workspace.getConfiguration('mysti').update(key, value, vscode.ConfigurationTarget.Workspace);
      }
      ownedUpdateTerminal?.dispose();
      await browser?.close();
    });

    it('runs actual diagnostics and copies the report from the originating panel', async () => {
      const sidebar = panels[0];
      await reveal(sidebar);
      await vscode.commands.executeCommand('mysti.getStarted', 'connect');
      await sidebar.frame.locator('#setup-wizard').waitFor({ state: 'visible' });
      const expectedIds = await sidebar.frame.locator('.provider-card').evaluateAll(cards =>
        cards.map(card => card.getAttribute('data-provider')).sort());
      const before = await Promise.all(panels.map(async panel => (await events(panel, 'diagnosticsResult')).length));
      const started = Date.now();
      await sidebar.frame.locator('.wizard-diagnose-btn').click();
      await until('Real diagnostics must return to its initiating panel', async () =>
        (await events(sidebar, 'diagnosticsResult')).length > before[0], 90_000);
      assert.strictEqual((await events(sidebar, 'diagnosticsResult')).length, before[0] + 1);
      const serialized = await sidebar.frame.locator('#diagnostics-panel').getAttribute('data-diagnostics');
      assert.ok(serialized);
      const report = JSON.parse(serialized);
      assert.deepStrictEqual(report.providers.map((provider: any) => provider.id).sort(), expectedIds,
        'Diagnostics must account for every provider even when some are unavailable');
      assert.strictEqual(report.platform.os, process.platform);
      assert.strictEqual(typeof report.npmStatus.available, 'boolean');
      assert.strictEqual(typeof report.nodeStatus.meetsMinimum, 'boolean');
      for (let index = 1; index < panels.length; index++) {
        assert.strictEqual((await events(panels[index], 'diagnosticsResult')).length, before[index], 'Diagnostics replies must stay in their originating panel');
      }
      if (process.env.MYSTI_PC02_CODEX_PATH) {
        const codex = report.providers.find((provider: any) => provider.id === 'openai-codex');
        assert.strictEqual(codex?.installed, true);
        assert.strictEqual(codex.path, process.env.MYSTI_PC02_CODEX_PATH, 'Diagnostics must identify the selected executable');
        assert.strictEqual(codex.version?.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0], process.env.MYSTI_PC02_EXPECTED_CODEX_VERSION);
        assert.ok((await sidebar.frame.locator('.diagnostics-provider-path').allTextContents()).includes(codex.path));
      }
      const oldClipboard = await vscode.env.clipboard.readText();
      try {
        await sidebar.frame.locator('.diagnostics-copy-btn').click();
        await until('Copy diagnostics must place the actual report on the native clipboard', async () =>
          await vscode.env.clipboard.readText() === serialized);
      } finally { await vscode.env.clipboard.writeText(oldClipboard); }
      assert.strictEqual(await sidebar.frame.locator('.wizard-diagnose-btn').isEnabled(), true);
      await workbench.screenshot({ path: path.join(artifactDir, 'diagnostics.png') });
      record('real-diagnostics', { elapsedMs: Date.now() - started, platform: report.platform,
        node: report.nodeStatus, npm: report.npmStatus, networkReachable: report.networkReachable,
        providers: report.providers.map((provider: any) => ({ id: provider.id, installed: provider.installed,
          version: provider.version, path: provider.path, authenticated: provider.authenticated, hasError: !!provider.error })) });
      await skipWizard(sidebar);
      assert.deepStrictEqual(openedTerminals, []);
    });

    it('refreshes the real provider catalog with independent installer menus in three panels', async function () {
      const baseline: Array<{ agent: string; model: string; draft: string }> = [];
      for (let index = 0; index < panels.length; index++) {
        const panel = panels[index];
        await reveal(panel);
        await skipWizard(panel);
        await panel.frame.locator('#message-input').fill(`PC02 unsent ${panel.label}`);
        await panel.frame.locator('#agent-select-btn').click();
        const candidates = await panel.frame.locator('#agent-menu .agent-install-btn').evaluateAll(buttons =>
          buttons.map(button => button.getAttribute('data-agent')).filter(Boolean));
        if (!candidates.length) {
          record('installer-prerequisite', { status: 'blocked-prerequisite', panel: panel.label,
            reason: 'Every provider is installed, so the actual agent menu exposes no Install entry. No missing-provider state is fabricated.' });
          await panel.frame.locator('#agent-select-btn').click();
          this.skip();
        }
        panel.providerId = candidates[index % candidates.length]!;
        baseline.push(await composer(panel));
        const before = (await events(panel, 'providerInstallInfo')).length;
        await panel.frame.locator(`#agent-menu .agent-install-btn[data-agent="${panel.providerId}"]`).click();
        await until('Installer instructions must arrive from the actual host', async () =>
          (await events(panel, 'providerInstallInfo')).length > before);
        const replies = await events(panel, 'providerInstallInfo');
        assert.strictEqual(replies.length, before + 1, 'One click must request one installer dialog');
        const info = replies.at(-1)!.payload;
        assert.strictEqual(info.providerId, panel.providerId);
        assert.ok(!info.error, info.error);
        assert.ok((await panel.frame.locator('#install-provider-title').innerText()).includes(info.displayName));
        assert.strictEqual(await panel.frame.locator('#install-provider-modal').isVisible(), true);
        if (!info.supportsAutoInstall) { assert.strictEqual(await panel.frame.locator('#install-auto-section').isVisible(), false); }
        record('installer-opened', { panel: panel.label, providerId: panel.providerId, info,
          visibleCommands: await panel.frame.locator('#install-provider-modal code').allTextContents() });
      }

      const started = Date.now();
      for (let cycle = 0; cycle < refreshes; cycle++) {
        const index = cycle % panels.length;
        const panel = panels[index];
        await reveal(panel);
        const before = await Promise.all(panels.map(async other => (await events(other, 'providerDetectionComplete')).length));
        const refreshStarted = Date.now();
        await panel.frame.locator('#install-refresh-btn').click();
        await until('Refresh must settle with an actual host acknowledgement', async () =>
          (await events(panel, 'providerDetectionComplete')).length > before[index], 35_000);
        const replies = await events(panel, 'providerDetectionComplete');
        assert.strictEqual(replies.length, before[index] + 1);
        assert.ok(!replies.at(-1)!.payload.error, replies.at(-1)!.payload.error);
        for (let sibling = 0; sibling < panels.length; sibling++) {
          if (sibling !== index) {
            assert.strictEqual((await events(panels[sibling], 'providerDetectionComplete')).length, before[sibling],
              'One panel must not consume another panel\'s refresh acknowledgement');
          }
        }
        const status = (await events(panel, 'wizardStatus')).at(-1)!.payload;
        const cardIds = await panel.frame.locator('.provider-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-provider')).sort());
        assert.deepStrictEqual(status.providers.map((provider: any) => provider.providerId).sort(), cardIds);
        assert.strictEqual(await panel.frame.locator('#install-refresh-btn').isEnabled(), true);
        assert.strictEqual(await panel.frame.locator('#install-provider-modal').isVisible(), true);
        assert.deepStrictEqual(await composer(panel), baseline[index], 'Discovery must preserve the chosen agent, model and draft');
        assert.deepStrictEqual(openedTerminals, [], 'Viewing and refreshing installers must not execute them');
        record('refresh-complete', { cycle: cycle + 1, panel: panel.label, providerId: panel.providerId,
          elapsedMs: Date.now() - refreshStarted, providers: status.providers });
      }
      record('bounded-refresh-loop', { iterations: refreshes, panelCount: panels.length, elapsedMs: Date.now() - started,
        elapsedSoakClaim: false });
      for (const panel of panels) {
        await reveal(panel);
        await workbench.screenshot({ path: path.join(artifactDir, `installer-${panel.label}.png`) });
        await panel.frame.locator('#install-close-btn').click();
        await panel.frame.locator('#install-provider-modal').waitFor({ state: 'hidden' });
        assert.strictEqual(await panel.frame.locator('#message-input').isEditable(), true);
        assert.strictEqual(await panel.frame.locator('#message-input').inputValue(), `PC02 unsent ${panel.label}`);
        await panel.frame.locator('#message-input').fill('');
        assert.strictEqual(await panel.frame.locator('#messages .message').count(), 0);
      }
    });

    it('keeps public debug setup progress and failures dismissible in the sidebar only', async () => {
      const sidebar = panels[0];
      await reveal(sidebar);
      const siblingCounts = await Promise.all(panels.slice(1).map(async panel => (await events(panel)).length));
      await vscode.commands.executeCommand('mysti.debugSetupFailure');
      await until('The public debug failure must be visible', async () =>
        (await sidebar.frame.locator('#setup-overlay .setup-message').innerText()).includes('DEBUG: Simulated failure'));
      const close = sidebar.frame.locator('#auth-error-close-btn');
      if (await close.isVisible()) { await close.click(); }
      else { await sidebar.frame.locator('#setup-skip-btn').click(); }
      await sidebar.frame.locator('#setup-overlay').waitFor({ state: 'hidden' });
      await vscode.commands.executeCommand('mysti.debugSetup');
      await sidebar.frame.locator('#auth-skip-btn').waitFor({ state: 'visible' });
      assert.match(await sidebar.frame.locator('#setup-overlay .setup-message').innerText(), /DEBUG: This is a test auth prompt/);
      await sidebar.frame.locator('#auth-skip-btn').click();
      await sidebar.frame.locator('#setup-overlay').waitFor({ state: 'hidden' });
      for (let index = 1; index < panels.length; index++) {
        const later = (await events(panels[index])).slice(siblingCounts[index - 1]);
        assert.strictEqual(later.some(event => ['setupFailed', 'setupProgress', 'authPrompt'].includes(event.type)), false);
        assert.strictEqual(await panels[index].frame.locator('#setup-overlay').isVisible(), false);
      }
      await sidebar.frame.locator('#message-input').fill('PC02 debug recovery');
      assert.strictEqual(await sidebar.frame.locator('#message-input').inputValue(), 'PC02 debug recovery');
      await sidebar.frame.locator('#message-input').fill('');
      assert.deepStrictEqual(openedTerminals, []);
      record('debug-ui-dismissed', { scope: 'Actual registered debug commands; progress and failures are intentionally simulated, not installation evidence.' });
    });

    if (process.env.MYSTI_PC02_UPDATE === '1') {
      it('updates only the selected disposable Codex prefix through its actual update card', async function () {
        this.timeout(updateTimeout + 360_000);
        const sidebar = panels[0];
        const executable = process.env.MYSTI_PC02_CODEX_PATH!;
        const previousVersion = process.env.MYSTI_PC02_EXPECTED_CODEX_VERSION!;
        const updatedVersion = process.env.MYSTI_PC02_UPDATED_CODEX_VERSION!;
        const prefix = path.dirname(path.dirname(executable));
        const canonicalPrefix = fs.realpathSync(prefix);
        assert.strictEqual(executable, path.join(prefix, 'bin', 'codex'), 'Only the supplied npm-layout Codex shim is eligible');
        assert.ok(!['/', '/usr', '/usr/local', '/opt/homebrew', os.homedir(), path.join(os.homedir(), '.npm-global')]
          .includes(canonicalPrefix), 'A personal or system npm prefix is never eligible');
        const selectedEntry = fs.realpathSync(executable);
        const relativeEntry = path.relative(canonicalPrefix, selectedEntry);
        assert.ok(relativeEntry && !relativeEntry.startsWith('..') && !path.isAbsolute(relativeEntry),
          'The selected shim must resolve inside its disposable prefix');
        const manifest = JSON.parse(fs.readFileSync(path.join(canonicalPrefix, 'lib/node_modules/@openai/codex/package.json'), 'utf8'));
        assert.strictEqual(manifest.name, '@openai/codex');
        assert.strictEqual(await executableVersion(executable), previousVersion);
        assert.notStrictEqual(updatedVersion, previousVersion, 'The acceptance case requires an actual version transition');

        const closedPanels: string[] = [];
        for (const panel of panels.slice(1).reverse()) {
          assert.ok(panel.tab, 'Only the test-owned editor panels may be closed');
          assert.strictEqual(await vscode.window.tabGroups.close(panel.tab), true,
            'The test-owned editor panel must close before isolating the updater runtime');
          closedPanels.push(panel.label);
          panels.splice(panels.indexOf(panel), 1);
        }
        assert.deepStrictEqual(panels.map(panel => panel.label), ['sidebar']);
        record('update-sidebar-isolation', { closedPanels, remainingPanels: panels.map(panel => panel.label),
          scope: 'Earlier three-panel refresh evidence is retained. Update and runtime replacement are tested only in the remaining sidebar.' });

        const model = process.env.MYSTI_PC02_CODEX_MODEL || 'gpt-5.6-sol';
        const config = vscode.workspace.getConfiguration('mysti');
        // These five settings declare the default window scope in the
        // manifest, so scratch-workspace values are supported and restored.
        for (const [key, value] of Object.entries({
          codexModel: model, defaultMode: 'quick-plan', accessLevel: 'read-only', autoContext: false, showSuggestions: false,
        })) {
          savedUpdateSettings.set(key, config.inspect(key)?.workspaceValue);
          await config.update(key, value, vscode.ConfigurationTarget.Workspace);
        }
        await reveal(sidebar);
        await skipWizard(sidebar);
        await sidebar.frame.locator('#agent-select-btn').click();
        await sidebar.frame.locator('#agent-menu .agent-menu-item[data-agent="openai-codex"]:not(.disabled)').click();
        await until('The intended provider and model must be selected before updating', async () =>
          /Codex/i.test(await sidebar.frame.locator('#agent-name').innerText()) &&
          await sidebar.frame.locator('#model-select-inline').inputValue() === model);
        await sidebar.frame.locator('#message-input').fill('PC02 preserved draft while updating the selected CLI');
        const baseline = await composer(sidebar);
        await sidebar.frame.locator('#agent-select-btn').click();
        const refreshCandidates = await sidebar.frame.locator('#agent-menu .agent-install-btn').evaluateAll(buttons =>
          buttons.map(button => button.getAttribute('data-agent')).filter(Boolean));
        assert.ok(refreshCandidates.length > 0, 'An actual installer Refresh Detection route must be available before updating');
        const refreshProviderId = refreshCandidates.includes(sidebar.providerId || '') ? sidebar.providerId! : refreshCandidates[0]!;
        await sidebar.frame.locator('#agent-select-btn').click();

        let offer: any;
        await until('A real host Codex update offer must identify the selected installation', async () => {
          const rows = await sidebar.frame.evaluate(() =>
            ((globalThis as any).__pc02UpdateOffers || []).flatMap((event: any) => event.updates));
          offer = rows.filter((row: any) => row.providerId === 'openai-codex').at(-1);
          return !!offer;
        }, 60_000);
        assert.strictEqual(offer.packageName, '@openai/codex');
        assert.ok(!offer.manualUpdateReason, offer.manualUpdateReason);
        assert.strictEqual(offer.installed, previousVersion);
        assert.strictEqual(offer.installable || offer.latest, updatedVersion, 'The visible target must match the authorized version');
        const words = literalShellWords(offer.command);
        assert.strictEqual(words.length, 6, 'Only one explicit npm package and no additional shell operation may be offered');
        assert.ok(words[0] === 'npm' || (path.isAbsolute(words[0]) && path.basename(words[0]) === 'npm'),
          'Expected the npm executable chosen by the host');
        assert.deepStrictEqual(words.slice(1, 4), ['install', '-g', '--prefix']);
        assert.ok(path.isAbsolute(words[4]), 'The disposable prefix must be absolute');
        assert.strictEqual(fs.realpathSync(words[4]), canonicalPrefix, 'The offered update must target only the authorized disposable prefix');
        assert.strictEqual(words[5], `@openai/codex@${updatedVersion}`, 'The host must pin exactly the authorized package/version');

        const targetCard = sidebar.frame.locator('#update-notices .update-card-cli[data-provider="openai-codex"]');
        const visited = new Set<string>();
        while (!await targetCard.count()) {
          const current = sidebar.frame.locator('#update-notices .update-card');
          assert.strictEqual(await current.count(), 1, 'The real update-notice carousel must be reachable');
          const identity = await current.evaluate(card => [card.getAttribute('data-kind'), card.getAttribute('data-provider'), card.getAttribute('data-model')].join(':'));
          assert.ok(!visited.has(identity), 'The actual carousel completed a cycle without the offered Codex update');
          visited.add(identity);
          await current.locator('[data-action="next-notice"]').click();
        }
        assert.strictEqual(await targetCard.locator('.update-cmd').innerText(), offer.command);
        assert.strictEqual(await targetCard.locator('.update-agent').innerText(), `${previousVersion} → ${updatedVersion}`);
        assert.strictEqual(await targetCard.locator('[data-action="run-update"]').innerText(), 'Update');
        assert.strictEqual(vscode.workspace.getConfiguration('mysti').get('codexPath'), executable,
          'The selected path must still match the validated command immediately before the click');
        let runtimeBeforeUpdate: ProcessIdentity[] = [];
        try {
          await until('The selected disposable Codex must have a warm app-server before updating', async () => {
            runtimeBeforeUpdate = (await selectedAppServerProcesses(prefix)).selected;
            return runtimeBeforeUpdate.length > 0;
          }, 30_000, 500);
        } finally {
          record('pre-update-runtime-snapshot', { processes: runtimeBeforeUpdate,
            scope: 'Only app-server processes whose argv contains the authorized disposable prefix; argv and environment are not recorded.' });
        }
        const terminalsBefore = openedTerminals.length;
        const terminalListener = vscode.window.onDidOpenTerminal(terminal => {
          if (/^Mysti: update (?:OpenAI )?Codex$/i.test(terminal.name)) { ownedUpdateTerminal = terminal; }
        });
        const started = Date.now();
        record('authorized-update-click', { providerId: 'openai-codex', executable, prefix: canonicalPrefix,
          previousVersion, updatedVersion, offeredCommand: offer.command, validatedWords: words, versionVerificationTimeoutMs: updateTimeout });
        try {
          // This actual button sends provider identity only; the host resolves
          // its validated updater. No command/event is injected by the test.
          await targetCard.locator('[data-action="run-update"]').click();
          await until('The selected update must open its own visible terminal', async () => !!ownedUpdateTerminal);
          await until('The actual selected Codex executable must report the authorized new version', async () => {
            try { return await executableVersion(executable) === updatedVersion; }
            catch { return false; } // npm can briefly replace the shim while updating it.
          }, updateTimeout, 2_000);
          assert.strictEqual(openedTerminals.length, terminalsBefore + 1, 'One selected update must launch exactly one terminal');
        } finally { terminalListener.dispose(); }

        await vscode.commands.executeCommand('workbench.action.closePanel');
        await reveal(sidebar);
        assert.deepStrictEqual(await composer(sidebar), baseline, 'The update must preserve the selected provider, model and unsent draft');
        // The selected executable changed outside the host in its terminal.
        // Use the real Refresh Detection affordance to invalidate cached CLI
        // metadata before checking the updated version through diagnostics.
        await sidebar.frame.locator('#agent-select-btn').click();
        const infoCount = (await events(sidebar, 'providerInstallInfo')).length;
        await sidebar.frame.locator(`#agent-menu .agent-install-btn[data-agent="${refreshProviderId}"]`).click();
        await until('The real installer must open for post-update detection refresh', async () =>
          (await events(sidebar, 'providerInstallInfo')).length > infoCount);
        const refreshCount = (await events(sidebar, 'providerDetectionComplete')).length;
        const updateOffersBeforeRefresh = await sidebar.frame.evaluate(() =>
          ((globalThis as any).__pc02UpdateOffers || []).length);
        await sidebar.frame.locator('#install-refresh-btn').click();
        await until('Real detection must refresh after the selected CLI update', async () =>
          (await events(sidebar, 'providerDetectionComplete')).length > refreshCount, 35_000);
        assert.ok(!(await events(sidebar, 'providerDetectionComplete')).at(-1)!.payload.error);
        await until('A new real host update list must stop offering the installed Codex version', async () => {
          const refreshed = await sidebar.frame.evaluate(before =>
            ((globalThis as any).__pc02UpdateOffers || []).slice(before), updateOffersBeforeRefresh);
          return refreshed.length > 0 && !refreshed.at(-1).updates.some((row: any) => row.providerId === 'openai-codex');
        }, 35_000);
        await sidebar.frame.locator('#install-close-btn').click();
        await sidebar.frame.locator('#install-provider-modal').waitFor({ state: 'hidden' });
        assert.strictEqual(await targetCard.count(), 0, 'The installed Codex must no longer have an update card');
        record('post-update-notice-refreshed', { updates: await sidebar.frame.evaluate(() =>
          ((globalThis as any).__pc02UpdateOffers || []).at(-1)), codexUpdateCardCount: await targetCard.count() });
        assert.deepStrictEqual(await composer(sidebar), baseline);
        await vscode.commands.executeCommand('mysti.getStarted', 'connect');
        await sidebar.frame.locator('#setup-wizard').waitFor({ state: 'visible' });
        const diagnosticCount = (await events(sidebar, 'diagnosticsResult')).length;
        await sidebar.frame.locator('.wizard-diagnose-btn').click();
        await until('Actual diagnostics must verify the updated selected binary', async () =>
          (await events(sidebar, 'diagnosticsResult')).length > diagnosticCount, 90_000);
        const report = JSON.parse((await sidebar.frame.locator('#diagnostics-panel').getAttribute('data-diagnostics'))!);
        const codex = report.providers.find((provider: any) => provider.id === 'openai-codex');
        assert.strictEqual(codex?.installed, true);
        assert.strictEqual(codex.path, executable);
        assert.strictEqual(codex.version?.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0], updatedVersion);
        await workbench.screenshot({ path: path.join(artifactDir, 'codex-updated-diagnostics.png') });
        await skipWizard(sidebar);
        assert.deepStrictEqual(await composer(sidebar), baseline);
        record('selected-prefix-updated', { elapsedMs: Date.now() - started, executable, prefix: canonicalPrefix,
          previousVersion, updatedVersion, diagnosticVersion: codex.version, diagnosticPath: codex.path,
          selectedProvider: baseline.agent, selectedModel: baseline.model, terminal: ownedUpdateTerminal?.name });

        if (process.env.MYSTI_PC02_UPDATE_LIVE === '1') {
          assert.strictEqual(codex.authenticated, true, 'The optional answer requires an existing login; this test cannot authenticate');
          const before = (await events(sidebar)).length;
          const prompt = [
            'Answer using only the JavaScript shown here. Do not use tools, read files, run commands, or make changes.',
            'function retryDelay(attempt, base = 100, cap = 1000) { return Math.min(cap, base * (2 ** attempt)); }',
            'What values does retryDelay return for attempts 0, 1, and 4, in that order?',
            'Return exactly one line: PC02_RETRY:<first>,<second>,<third>. No explanation.',
          ].join('\n');
          await sidebar.frame.locator('#message-input').fill(prompt);
          await sidebar.frame.locator('#send-btn').click();
          try {
            await until('The updated Codex must complete a real first answer', async () =>
              (await events(sidebar)).slice(before).some(event => event.type === 'responseComplete'), 120_000);
            await sidebar.frame.locator('#stop-btn').waitFor({ state: 'hidden' });
            const turn = (await events(sidebar)).slice(before);
            const completions = turn.filter(event => event.type === 'responseComplete');
            assert.strictEqual(completions.length, 1);
            const answer = completions[0].payload.message;
            assert.strictEqual(answer?.provider, 'openai-codex');
            assert.strictEqual(answer?.model, model);
            assert.strictEqual(answer?.content?.trim(), 'PC02_RETRY:100,200,1000');
            assert.strictEqual(turn.some(event => ['toolUse', 'permissionRequest'].includes(event.type)), false);
            const response = sidebar.frame.locator('#messages .message.assistant').last();
            assert.strictEqual((await response.locator('.message-content').allTextContents()).join('\n').trim(), 'PC02_RETRY:100,200,1000');
            const previousPids = new Set(runtimeBeforeUpdate.map(process => process.pid));
            let runtimeAfterAnswer: ProcessIdentity[] = [], previousStillAlive: ProcessIdentity[] = [];
            try {
              await until('The completed answer must leave only new selected app-server processes and no old runtime PIDs', async () => {
                const snapshot = await selectedAppServerProcesses(prefix);
                runtimeAfterAnswer = snapshot.selected;
                previousStillAlive = runtimeBeforeUpdate.filter(process => snapshot.livePids.has(process.pid));
                return runtimeAfterAnswer.length > 0 && previousStillAlive.length === 0 &&
                  runtimeAfterAnswer.every(process => !previousPids.has(process.pid));
              }, 15_000, 500);
            } finally {
              record('post-answer-runtime-snapshot', { before: runtimeBeforeUpdate, after: runtimeAfterAnswer,
                previousStillAlive, scope: 'PID/PPID only. Old PIDs must be absent from the process table, and selected app-server PIDs must be new.' });
            }
            await workbench.screenshot({ path: path.join(artifactDir, 'updated-codex-first-answer.png') });
            record('updated-codex-real-answer', { executable, version: updatedVersion, prompt, answer,
              runtimeBeforeUpdate, runtimeAfterAnswer,
              attribution: await response.locator('.message-model-info').innerText(),
              scope: 'One real read-only answer after a selected-prefix update using an existing login; not fresh authentication or a soak.' });
          } finally {
            if (await sidebar.frame.locator('#stop-btn').isVisible()) { await sidebar.frame.locator('#stop-btn').click(); }
          }
        } else { await sidebar.frame.locator('#message-input').fill(''); }
      });
    }
  });
}
