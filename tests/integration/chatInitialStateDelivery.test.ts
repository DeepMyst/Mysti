import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Browser, Page } from 'playwright';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from '../webview/chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from '../webview/chromiumAvailability';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.setConfig({ testTimeout: 30000 });

// The real host delivers authority capabilities with the display/model fields.
// An incomplete display-only fixture correctly prevents a send in the webview.
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry);
const provider = manifest.providers.find(entry => entry.id === 'openai-codex')!;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function harness(post: (message: any) => Promise<boolean>) {
  let incoming!: (message: any) => Promise<void>;
  let dispose!: () => void;
  const webview = { html: '', options: {}, postMessage: vi.fn(post),
    onDidReceiveMessage: (callback: typeof incoming) => { incoming = callback; } };
  const view = { webview, onDidDispose: (callback: () => void) => { dispose = callback; } };
  const conversation = { id: 'owned-startup-conversation', messages: [], title: 'Startup delivery' };
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _sidebarId: 'sidebar', _panelStates: new Map(), _pendingUiReadyPanels: new Set(),
    _editorContextTracker: { focusPanel: vi.fn() },
    _extensionUri: vscode.Uri.file('/owned-no-probes'),
    _extensionContext: { extension: { packageJSON: { version: '0.0.0' } }, globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
    _agentInitPromise: Promise.resolve(), _getPanelProvider: () => provider.id, _getPanelAgent: () => provider.id,
    _getPanelModel: () => provider.defaultModel, _tryPreSpawnPersistentProcess: vi.fn(),
    _setupManager: { ensureProviderStatusFresh: async () => {}, getWizardStatusCached: () => ({ anyReady: true, providers: [{ providerId: provider.id, installed: true, authenticated: true }] }) },
    _contextManager: { restorePanelContext: async () => [], captureContextGuard: () => () => true, getContext: () => [] },
    _conversationManager: { getCurrentConversation: () => conversation, getConversation: () => conversation },
    _providerManager: { getProviders: () => [{ ...provider, name: provider.id }], cancelRequest: vi.fn() },
    _modelRegistry: { getModels: () => ({ models: provider.models, defaultModel: provider.defaultModel }) },
    _mapAgentLists: () => ({ availablePersonas: [], availableSkills: [], availableRoles: [] }),
    _buildManifestPayload: () => manifest, _agentContextManager: { getTokenBudget: () => 2000 },
    _engagementManager: { getUsageStats: () => ({}), getAllBadges: () => [], getUnlockedCount: () => 0 },
    _activeModeManager: { isInstalled: () => false, getDaemonStatus: () => 'stopped' },
    _checkpointManager: { isAvailable: async () => false }, _getCachedGithubStarCount: () => 0,
    _getGithubStarCount: async () => 0, _pushInAppMessages: async () => {}, _mirrorToHub: vi.fn(),
    _cancelPanelSetup: vi.fn(), _cancelQueuedChannelTurn: vi.fn(), _abortMystiDirect: vi.fn(),
    _backgroundJobManager: { listRunning: () => [] }, _cancelPendingSubAgentQuestions: vi.fn(),
    _pendingPlans: { clearPanel: vi.fn() }, _pendingPlanSelections: new Map(),
  });
  return { host, webview, view, incoming: (message: any) => incoming?.(message), dispose: () => dispose() };
}

let browser: Browser | undefined;
const pages: Page[] = [];
beforeAll(async () => { if (!CHROMIUM_UNAVAILABLE) { browser = await (await import('playwright')).chromium.launch(); } }, 60000);
afterEach(async () => { await Promise.all(pages.splice(0).map(page => page.close())); clearMockConfig(); });
afterAll(async () => { await browser?.close(); registry.dispose(); });

describe('Initial settings delivery across chat script loading', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves the draft and never submits bootstrap settings when the host is still loading past the overlay timeout', async () => {
    const page = await browser!.newPage(); pages.push(page); await page.clock.install();
    await page.setContent(composeChatHtml()); await page.clock.runFor(12500);
    const draft = 'Keep this draft until saved settings arrive.';
    await page.locator('#message-input').fill(draft); await page.locator('#send-btn').click();
    expect(await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'sendMessage'))).toEqual([]);
    expect(await page.locator('#message-input').inputValue()).toBe(draft);
    expect(await page.locator('.mysti-toast').last().innerText()).toContain('Chat settings are still loading');
    await page.evaluate(payload => window.dispatchEvent(new MessageEvent('message', { data: { type: 'initialState', payload } })), {
      ...INITIAL_STATE, panelId: 'late-host', providerManifest: manifest,
      settings: { ...(INITIAL_STATE.settings as object), provider: provider.id, model: provider.defaultModel, effortLevel: 'low' },
    });
    await page.locator('#send-btn').click();
    const sends = await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'sendMessage'));
    expect(sends).toHaveLength(1); expect(sends[0].payload.content).toBe(draft); expect(sends[0].payload.settings.effortLevel).toBe('low');
  });
  for (const timing of ['before chat script', 'after chat script'] as const) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`sends the saved settings when host initialization finishes ${timing}`, async () => {
      setMockConfig('defaultEffortLevel', 'low'); setMockConfig('autoContext', false);
      const page = await browser!.newPage(); pages.push(page);
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.clock.install();
      const gate = deferred(), blocked = deferred();
      const source = fs.readFileSync(path.resolve(__dirname, '../../media/chat/chat.js'), 'utf8');
      const html = composeChatHtml().replace(`<script>${source}</script>`, '<script src="https://startup-owned.test/chat.js"></script>');
      expect(html).toContain('https://startup-owned.test/chat.js');
      const deliveries: any[] = [];
      const h = harness(async message => {
        deliveries.push(structuredClone(message));
        await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), message);
        return true;
      });
      // VS Code binds this callback to the owning webview. No model or other
      // application actions are dispatched by this transport fixture.
      await page.exposeFunction('__hostReady', (message: any) => h.incoming(message));
      await page.addInitScript(() => {
        (window as any).__earlyInitialStates = [];
        window.addEventListener('message', event => {
          if (event.data?.type === 'initialState') (window as any).__earlyInitialStates.push(event.data);
        });
      });
      const bridged = html.replace('window.__posted.push(m);', 'window.__posted.push(m); if (m.type === "webviewReady") window.__hostReady(m);');
      await page.route('https://startup-owned.test/', route => route.fulfill({ contentType: 'text/html', body: bridged }));
      await page.route('https://startup-owned.test/chat.js', async route => { blocked.resolve(); await gate.promise; await route.fulfill({ contentType: 'text/javascript', body: source }); });
      const loaded = page.goto('https://startup-owned.test/', { waitUntil: 'load' });
      await blocked.promise;
      if (timing === 'before chat script') {
        h.host.resolveWebviewView(h.view, {}, {});
        // Allow the real host's initial-state construction and browser delivery
        // to settle while the browser is still waiting for the actual script.
        await new Promise(resolve => setImmediate(resolve));
        // Drain posted browser evaluations too; otherwise releasing the script
        // can overtake delivery and accidentally turn this into the late case.
        await page.evaluate(() => (window as any).__earlyInitialStates.length);
      }
      gate.resolve(); await loaded;
      if (timing === 'after chat script') {
        h.host.resolveWebviewView(h.view, {}, {});
        // The real transport registers before HTML is installed. The late-host
        // control replays only the browser's actual readiness post if present.
        const ready = await page.evaluate(() => (window as any).__posted.find((message: any) => message.type === 'webviewReady'));
        if (ready) await h.incoming(ready);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      await page.clock.runFor(12500);
      await page.locator('#message-input').fill('Owned settings delivery check.'); await page.locator('#send-btn').click();
      const sends = await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'sendMessage'));
      expect(sends).toHaveLength(1);
      expect(sends[0].payload.settings).toMatchObject({ provider: provider.id, model: provider.defaultModel, effortLevel: 'low', contextMode: 'manual' });
      expect(await page.locator('#effort-select-inline').inputValue()).toBe('low');
      expect(deliveries.filter(message => message.type === 'initialState')).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  }
});

const ready = (documentId: string) => ({ type: 'webviewReady', payload: { documentId } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function hostOnly() {
  const messages: any[] = [];
  const h = harness(async message => { messages.push(structuredClone(message)); return true; });
  return { ...h, messages, initialStates: () => messages.filter(message => message.type === 'initialState') };
}

describe('Initial settings ownership and document readiness', () => {
  it('delivers once when the first and replacement document announce readiness in the same turn', async () => {
    const h = hostOnly(); h.host.resolveWebviewView(h.view, {}, {});
    const first = h.incoming(ready('first'));
    const replacement = h.incoming(ready('replacement'));
    await Promise.all([first, replacement]); await settle();
    expect(h.initialStates()).toHaveLength(1);
  });

  it('waits for its bound document, ignores invalid signals, and does not repeat a completed handshake', async () => {
    const h = hostOnly(); h.host.resolveWebviewView(h.view, {}, {}); await settle();
    expect(h.messages).toEqual([]);
    for (const payload of [undefined, {}, { documentId: '' }, { documentId: 42 }, { documentId: 'x'.repeat(129) }]) {
      await h.incoming({ type: 'webviewReady', payload });
    }
    await h.host._receivePanelMessage(ready('foreign'), 'sidebar', {});
    await settle(); expect(h.messages).toEqual([]);
    await h.incoming({ ...ready('owned'), panelId: 'forged-sibling' }); await settle();
    expect(h.initialStates()).toHaveLength(1);
    expect(h.initialStates()[0].payload.panelId).toBe('sidebar');
    await h.incoming(ready('owned')); await settle(); expect(h.initialStates()).toHaveLength(1);
  });

  it('releases a disposed panel waiting for readiness without delivery or stale actions', async () => {
    const h = hostOnly(); h.host.resolveWebviewView(h.view, {}, {});
    h.dispose(); await h.incoming(ready('disposed')); await settle();
    expect(h.messages).toEqual([]); expect(h.host._panelStates.size).toBe(0);
  });

  it('does not let an old sidebar initialization write into its replacement', async () => {
    const h = hostOnly(), replacement = hostOnly(), probe = deferred();
    h.host._setupManager.ensureProviderStatusFresh = vi.fn(() => probe.promise);
    h.host.resolveWebviewView(h.view, {}, {}); await h.incoming(ready('old')); await settle();
    expect(h.host._setupManager.ensureProviderStatusFresh).toHaveBeenCalledOnce();
    h.host.resolveWebviewView(replacement.view, {}, {});
    h.dispose(); probe.resolve(); await settle();
    expect(h.messages).toEqual([]); expect(replacement.messages).toEqual([]);
    await replacement.incoming(ready('new')); await settle();
    expect(h.initialStates()).toHaveLength(0); expect(replacement.initialStates()).toHaveLength(1);
  });

  it('takes a fresh settings snapshot on document reload and drops a superseded pending load', async () => {
    const h = hostOnly(), probe = deferred();
    h.host._setupManager.ensureProviderStatusFresh = vi.fn().mockImplementationOnce(() => probe.promise).mockResolvedValue(undefined);
    setMockConfig('defaultEffortLevel', 'high');
    h.host.resolveWebviewView(h.view, {}, {}); await h.incoming(ready('first')); await settle();
    setMockConfig('defaultEffortLevel', 'low'); await h.incoming(ready('reload')); await settle();
    expect(h.initialStates()).toHaveLength(1); expect(h.initialStates()[0].payload.settings.effortLevel).toBe('low');
    probe.resolve(); await settle(); expect(h.initialStates()).toHaveLength(1);
    setMockConfig('defaultEffortLevel', 'medium'); await h.incoming(ready('second-reload')); await settle();
    expect(h.initialStates().map(message => message.payload.settings.effortLevel)).toEqual(['low', 'medium']);
  });

  it('also waits for the detached chat listener and binds its actual panel identity', async () => {
    const h = hostOnly(); const win = vscode.window as any, original = win.createWebviewPanel;
    win.createWebviewPanel = () => h.view;
    h.host._conversationManager.createNewConversation = () => ({ id: 'detached-conversation' });
    try {
      const id = h.host.openInNewTab(); await settle(); expect(h.messages).toEqual([]);
      await h.incoming({ ...ready('detached'), panelId: 'sidebar' }); await settle();
      expect(h.initialStates()).toHaveLength(1); expect(h.initialStates()[0].payload.panelId).toBe(id);
    } finally { win.createWebviewPanel = original; }
  });

  it('initializes only the latest hub binding once its real document is ready', async () => {
    const h = hostOnly(), hub = hostOnly(); const win = vscode.window as any, original = win.createWebviewPanel;
    win.createWebviewPanel = () => ({ ...hub.view, reveal: vi.fn() });
    h.host._panelStates.set('a', { id: 'a', webview: {}, currentConversationId: 'ca' });
    h.host._panelStates.set('b', { id: 'b', webview: {}, currentConversationId: 'cb' });
    h.host._panelAutonomyLevel = new Map();
    try {
      const first = h.host.openSettingsHub('settings', 'a');
      const second = h.host.openSettingsHub('about', 'b');
      await settle(); expect(hub.messages).toEqual([]);
      await hub.incoming({ ...ready('hub'), panelId: 'a' }); await Promise.all([first, second]);
      expect(hub.initialStates()).toHaveLength(1); expect(hub.initialStates()[0].payload.panelId).toBe('b');
      expect(hub.messages.at(-1)).toMatchObject({ type: 'hubShow', payload: { section: 'about' } });
      await hub.incoming(ready('hub')); expect(hub.initialStates()).toHaveLength(1);
      await hub.incoming(ready('hub-reload')); expect(hub.initialStates()).toHaveLength(2);
    } finally { win.createWebviewPanel = original; }
  });

  it('finishes a closed hub load without posting to the old or a replacement webview', async () => {
    const h = hostOnly(), hub = hostOnly(); const win = vscode.window as any, original = win.createWebviewPanel;
    win.createWebviewPanel = () => ({ ...hub.view, reveal: vi.fn() });
    h.host._panelStates.set('a', { id: 'a', webview: {}, currentConversationId: 'ca' });
    try {
      const loading = h.host.openSettingsHub('settings', 'a');
      hub.dispose(); await loading; await hub.incoming(ready('old-hub'));
      expect(hub.messages).toEqual([]); expect(h.host._hub).toBeNull();
    } finally { win.createWebviewPanel = original; }
  });

  it('settles an unbound hub that becomes ready after its source chat closes, then allows rebinding', async () => {
    const h = hostOnly(), hub = hostOnly(); const win = vscode.window as any, original = win.createWebviewPanel;
    win.createWebviewPanel = () => ({ ...hub.view, reveal: vi.fn() });
    h.host._panelStates.set('a', { id: 'a', webview: {}, currentConversationId: 'ca' });
    h.host._panelStates.set('b', { id: 'b', webview: {}, currentConversationId: 'cb' }); h.host._panelAutonomyLevel = new Map();
    try {
      let settled = false;
      const loading = h.host.openSettingsHub('settings', 'a').then(() => { settled = true; });
      h.host._unbindHubFrom('a'); hub.messages.length = 0;
      await hub.incoming(ready('unbound-hub')); await settle();
      expect(settled).toBe(true); await loading;
      expect(hub.initialStates()).toEqual([]);
      expect(hub.messages).toContainEqual({ type: 'hubShow', payload: { section: null, chatTitle: null } });
      await h.host.openSettingsHub('about', 'b');
      expect(hub.initialStates()).toHaveLength(1); expect(hub.initialStates()[0].payload.panelId).toBe('b');
    } finally { hub.dispose(); win.createWebviewPanel = original; }
  });
});
