/** Actual coordinator -> Canvas dispatcher -> inert temporary artifact authority regression. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Classification must never warm a real provider in an integration fixture.
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class { async classifyResponse() { return { questions: [], planOptions: [], context: '' }; } },
}));
// Keep constructor initialization real, but exclude personal and workspace catalogs.
vi.mock('../../src/managers/AgentLoader', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/managers/AgentLoader')>();
  return {
    ...actual,
    AgentLoader: class extends actual.AgentLoader {
      constructor(context: ConstructorParameters<typeof actual.AgentLoader>[0]) { super(context, []); }
    },
  };
});

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasLiveness } from '../../src/canvas/CanvasLiveness';
import type { CanvasBridge } from '../../src/canvas/CanvasBridge';
import type { CanvasArtifactSession } from '../../src/canvas/CanvasArtifactSession';
import { clearMockConfig, setMockConfig, Uri } from '../helpers/mockVscode';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';
import type { Settings, WebviewMessage } from '../../src/types';

interface HostFixture {
  dispose(): void;
  openCanvas(sessionId?: string, originPanelId?: string): string;
  _handleMessage(message: { type: 'cancelRequest'; panelId: string }): Promise<void>;
  _agentInitPromise: Promise<void>;
  _cancelledPanels: Set<string>;
  _mystiExecutionAborts: Map<string, AbortController>;
  _mystiRunGen: Map<string, number>;
  _panelStates: Map<string, unknown>;
  _canvasPanelId: string;
  _canvasChatOrigin: 'sidebar' | null;
  _canvasJobRouter: CanvasJobRouter;
  _canvasLiveness: CanvasLiveness;
  _canvasBridge: CanvasBridge;
  _canvasArtifactSession: CanvasArtifactSession;
  _canvasMcpSession: { dispose(): Promise<void> };
  _createCanvasBridge(panelId: string): CanvasBridge;
  _createCanvasArtifactSession(panelId: string, store: ArtifactStore, executor: CanvasOpExecutor, bridge: CanvasBridge): CanvasArtifactSession;
  _availableMystiBackends(): never[];
  _mystiCoordinator: {
    status(): { ready: boolean };
    credentialState(): { hasDeepMystKey: boolean; usingOpenRouter: boolean };
    resolveCoordinatorModel(): Promise<string>;
    stream(): AsyncGenerator<unknown>;
  };
  _runMystiAgentic(...args: unknown[]): Promise<void>;
  _runMystiCanvasTool(...args: unknown[]): Promise<{ ok: boolean; output: string }>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) { await cleanup(); } vi.restoreAllMocks(); clearMockConfig(); });

async function fixture(origin: 'sidebar' | null, resolveModel: () => Promise<string> = async () => 'openai/gpt-4.1', toolName = 'canvas_add_page') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-canvas-coordinator-authority-'));
  const permissionManager = new PermissionManager('ask-permission');
  const extensionUri = Uri.file('/inert/extension'); const noop = {};
  const subscriptions: Array<{ dispose(): void }> = [];
  let messageId = 0;
  const messages: WebviewMessage[] = [];
  const provider = new ChatViewProvider({
    extensionUri,
    extensionContext: {
      extensionUri, extensionPath: '/inert/extension', extension: { packageJSON: { version: '0.0.0' } }, subscriptions,
      globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined },
      workspaceState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined },
    },
    permissionManager,
    contextManager: { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined },
    conversationManager: {
      getCurrentConversation: () => null, getConversation: () => null, getAgentConfig: () => undefined,
      addMessageToConversation: (_conversation: string, role: string, content: string, _context: unknown, _attachments: unknown, thinking: unknown, extras: object) =>
        ({ id: `message-${++messageId}`, role, content, timestamp: Date.now(), thinking, ...extras }),
    },
    providerManager: {
      setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
      getProvider: () => undefined, getProviderInstance: () => undefined, getModelContextWindow: () => 200000,
      cancelRequest: () => undefined, setChannelSystemContext: () => undefined,
      dispose: () => undefined, getAllProviderIds: () => [],
    },
    setupManager: { onWizardStatusUpdated: () => ({ dispose() {} }) },
    memoryManager: { getProjectMemoryContent: () => '', recordProjectLearning: () => undefined },
    projectContextManager: { readRules: () => '', getMystiMdContent: () => '', getCrossVendorInstructions: () => [], scanWorkspace: async () => null },
    autonomousManager: { isActive: () => false },
    compactionManager: {
      shouldCompact: () => false, recordUsage: () => undefined, appendHistory: () => undefined,
      isSmartActive: () => false, evaluateCompaction: () => ({ act: false, smart: false }), getThreshold: () => 75,
    },
    lifecycleManager: { onLifecycleEvent: () => undefined, markBusy: () => undefined, markIdle: () => undefined },
    activeModeManager: {
      onStatusChanged: () => undefined, onChannelChanged: () => undefined, onActivity: () => undefined,
      subscribeToChannelEvents: () => () => undefined, isConnected: () => false, isInstalled: () => false,
    },
    suggestionManager: { generateSuggestions: async () => [] },
    brainstormManager: { cancelSession: () => undefined }, telemetryManager: noop, slashCommandManager: noop, engagementManager: noop, visualTestManager: noop,
    modelRegistry: createModelRegistryStub(),
    checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null },
  } as unknown as ConstructorParameters<typeof ChatViewProvider>[0]) as unknown as HostFixture;
  const webview = { postMessage: (message: WebviewMessage) => { messages.push(message); return Promise.resolve(true); } };
  provider._panelStates.set('sidebar', { id: 'sidebar', webview, currentConversationId: 'conversation', isSidebar: true });
  provider._panelStates.set('canvas-fixture', { id: 'canvas-fixture', webview, panel: { reveal() {}, dispose() {} }, currentConversationId: null, isSidebar: false });
  const store = new ArtifactStore({ getRoot: () => root }); const router = new CanvasJobRouter(() => {});
  const executor = new CanvasOpExecutor(store, router); const artifact = store.createArtifact({ name: 'Inert design', kind: 'screens' });
  provider._canvasPanelId = 'canvas-fixture'; provider._canvasChatOrigin = origin;
  provider._canvasJobRouter = router; provider._canvasLiveness = new CanvasLiveness({ router });
  provider._canvasBridge = provider._createCanvasBridge('canvas-fixture');
  provider._canvasArtifactSession = provider._createCanvasArtifactSession('canvas-fixture', store, executor, provider._canvasBridge);
  cleanups.push(async () => {
    await provider._canvasArtifactSession.close(); provider._canvasLiveness.dispose(); provider._canvasBridge.dispose();
    provider.dispose(); await provider._canvasMcpSession.dispose(); permissionManager.dispose();
    for (const subscription of subscriptions) { subscription.dispose(); }
    await provider._agentInitPromise;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await provider._agentInitPromise;
  const listing = vi.spyOn(store, 'list').mockResolvedValue([{ id: artifact.id, name: artifact.name, kind: artifact.kind, pageCount: 0, updatedAt: artifact.updatedAt }]);
  const loading = vi.spyOn(store, 'load').mockResolvedValue(artifact);
  await provider._canvasArtifactSession.initialize(); listing.mockRestore(); loading.mockRestore();
  provider._availableMystiBackends = () => [];
  let turns = 0;
  provider._mystiCoordinator = {
    status: () => ({ ready: true }), credentialState: () => ({ hasDeepMystKey: true, usingOpenRouter: false }),
    resolveCoordinatorModel: resolveModel,
    stream: async function* () {
      if (turns++ === 0) { yield { toolCalls: [{ id: 'inert-canvas', name: toolName, arguments: '{}' }] }; }
      else { yield { text: 'Complete.' }; }
      yield { done: true };
    },
  };
  return { provider, artifact, messages, run: (settings: Settings) => provider._runMystiAgentic(
    'Inert authority fixture.', [], settings, { id: 'conversation', messages: [] }, 'sidebar', 'conversation',
  ) };
}

describe.each(['sidebar', null] as const)('coordinator Canvas authority with origin %s', origin => {
  it.each([
    { name: 'captured read-only', run: { accessLevel: 'read-only', mode: 'default' }, live: 'full-access', expected: 'staged' },
    { name: 'captured quick plan', run: { accessLevel: 'full-access', mode: 'quick-plan' }, live: 'full-access', expected: 'staged' },
    { name: 'live approval restriction', run: { accessLevel: 'full-access', mode: 'default' }, live: 'ask-permission', expected: 'staged' },
    { name: 'read-only floor under autonomy', run: { accessLevel: 'read-only', mode: 'default', autonomousMode: true }, live: 'full-access', expected: 'staged' },
    { name: 'permissive ordinary run', run: { accessLevel: 'full-access', mode: 'default' }, live: 'full-access', expected: 'auto' },
    { name: 'existing autonomous resolver semantics', run: { accessLevel: 'ask-permission', mode: 'quick-plan', autonomousMode: true }, live: 'full-access', expected: 'auto' },
  ] as const)('respects $name through the actual run dispatcher', async scenario => {
    clearMockConfig(); setMockConfig('accessLevel', scenario.live); setMockConfig('defaultMode', 'default');
    setMockConfig('mysti.memory', false); setMockConfig('mysti.verify', 'off'); setMockConfig('mysti.crossReview', 'off');
    const h = await fixture(origin);
    await h.run({ provider: 'mysti', model: 'openai/gpt-4.1', thinkingLevel: 'none', contextMode: 'manual', ...scenario.run });
    const results = h.messages.filter(message => message.type === 'toolResult').map(message => message.payload as { output: string });
    expect(results).toHaveLength(1);
    const receipt = JSON.parse(results[0].output);
    expect(receipt.approvalMode).toBe(scenario.expected);
    expect(receipt.op.status).toBe(scenario.expected === 'auto' ? 'applied' : 'pending');
    expect(h.artifact.pages).toHaveLength(scenario.expected === 'auto' ? 1 : 0);
  });
});

async function delayedCoordinatorOpen() {
  setMockConfig('accessLevel', 'full-access'); setMockConfig('defaultMode', 'default');
  setMockConfig('mysti.memory', false); setMockConfig('mysti.verify', 'off'); setMockConfig('mysti.crossReview', 'off');
  const h = await fixture('sidebar', undefined, 'canvas_open');
  const { provider } = h;
  const { store, executor } = provider._canvasArtifactSession;
  await provider._canvasArtifactSession.close();
  let releaseListing!: (summaries: Awaited<ReturnType<ArtifactStore['list']>>) => void;
  const listing = new Promise<Awaited<ReturnType<ArtifactStore['list']>>>(resolve => { releaseListing = resolve; });
  vi.spyOn(store, 'list').mockReturnValue(listing);
  vi.spyOn(store, 'load').mockResolvedValue(h.artifact);
  provider._canvasArtifactSession = provider._createCanvasArtifactSession('canvas-fixture', store, executor, provider._canvasBridge);
  const initializing = provider._canvasArtifactSession.initialize();
  let notifyOpen!: () => void;
  const opened = new Promise<void>(resolve => { notifyOpen = resolve; });
  const actualOpen = provider.openCanvas.bind(provider);
  vi.spyOn(provider, 'openCanvas').mockImplementation((...args) => { const id = actualOpen(...args); notifyOpen(); return id; });
  const canvasCall = vi.spyOn(provider, '_runMystiCanvasTool');
  return { ...h, opened, canvasCall, release: async () => {
    releaseListing([{ id: h.artifact.id, name: h.artifact.name, kind: h.artifact.kind, pageCount: 0, updatedAt: h.artifact.updatedAt }]);
    await initializing;
  } };
}

const OPEN_SETTINGS: Settings = { provider: 'mysti', model: 'openai/gpt-4.1', thinkingLevel: 'none', contextMode: 'manual',
  accessLevel: 'full-access', mode: 'default' };

it('Stop aborts a real coordinator Canvas open even after the panel cancellation flag is cleared', async () => {
  const h = await delayedCoordinatorOpen();
  const sibling = new AbortController(); h.provider._mystiExecutionAborts.set('sibling', sibling);
  const running = h.run({ ...OPEN_SETTINGS });
  try {
    await h.opened;
    const owned = h.provider._mystiExecutionAborts.get('sidebar')!;
    expect(owned).toBeDefined(); expect(owned.signal.aborted).toBe(false);
    expect(h.canvasCall.mock.calls[0][5]).toBe(owned.signal);
    await h.provider._handleMessage({ type: 'cancelRequest', panelId: 'sidebar' });
    h.provider._cancelledPanels.delete('sidebar');
    expect(owned.signal.aborted).toBe(true); expect(sibling.signal.aborted).toBe(false);
    // No timer advance or artifact release: abort must release the actual waiter.
    expect(await h.canvasCall.mock.results[0].value).toEqual({ ok: false, output: 'Canvas tool cancelled.' });
    await running;
    expect(h.provider._canvasArtifactSession.snapshot).toBeNull();
    expect(h.artifact.pages).toHaveLength(0);
    expect(h.messages.filter(message => message.type === 'toolResult').map(message => message.payload))
      .toEqual([expect.objectContaining({ status: 'failed', output: 'Canvas tool cancelled.' })]);
    await h.release();
    expect(h.provider._canvasArtifactSession.snapshot?.artifact).toBe(h.artifact);
    expect(sibling.signal.aborted).toBe(false);
  } finally {
    await h.release(); await running;
  }
});

it('a new coordinator generation invalidates its pending Canvas open without aborting the shared view', async () => {
  const h = await delayedCoordinatorOpen(); vi.useFakeTimers();
  const running = h.run({ ...OPEN_SETTINGS });
  try {
    await h.opened;
    const owned = h.provider._mystiExecutionAborts.get('sidebar')!;
    expect(owned).toBeDefined();
    h.provider._mystiRunGen.set('sidebar', (h.provider._mystiRunGen.get('sidebar') ?? 0) + 1);
    expect(owned.signal.aborted).toBe(false);
    await h.release();
    await vi.advanceTimersByTimeAsync(50);
    expect(await h.canvasCall.mock.results[0].value).toEqual({ ok: false, output: 'Canvas tool cancelled.' });
    await running;
    expect(owned.signal.aborted).toBe(false);
    expect(h.provider._canvasArtifactSession.snapshot?.artifact).toBe(h.artifact);
    expect(h.artifact.pages).toHaveLength(0);
    const use = h.messages.find(message => message.type === 'toolUse')?.payload as { id: string };
    expect(use.id).toBeTruthy();
    // The old card receives its terminal failure; it cannot report success or
    // finish a replacement run. Its unique tool identity stays unchanged.
    expect(h.messages.filter(message => message.type === 'toolResult').map(message => message.payload))
      .toEqual([expect.objectContaining({ id: use.id, status: 'failed', output: 'Canvas tool cancelled.' })]);
    expect(h.messages.filter(message => message.type === 'responseComplete')).toHaveLength(0);
  } finally {
    await h.release(); await vi.advanceTimersByTimeAsync(50); await running; vi.useRealTimers();
  }
});


it('captures the approval floor before a deferred model preflight can mutate caller settings', async () => {
  clearMockConfig(); setMockConfig('accessLevel', 'full-access'); setMockConfig('defaultMode', 'default');
  setMockConfig('mysti.memory', false); setMockConfig('mysti.verify', 'off'); setMockConfig('mysti.crossReview', 'off');
  let releaseModel!: (model: string) => void;
  let reportEntered!: () => void;
  const entered = new Promise<void>(resolve => { reportEntered = resolve; });
  const model = new Promise<string>(resolve => { releaseModel = resolve; });
  const h = await fixture('sidebar', () => { reportEntered(); return model; });
  const settings: Settings = { provider: 'mysti', model: 'openai/gpt-4.1', thinkingLevel: 'none', contextMode: 'manual',
    accessLevel: 'read-only', mode: 'default' };
  const running = h.run(settings);
  try {
    await entered;
    settings.accessLevel = 'full-access';
    releaseModel('openai/gpt-4.1');
    await running;
    const results = h.messages.filter(message => message.type === 'toolResult').map(message => message.payload as { output: string });
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].output)).toMatchObject({ approvalMode: 'staged', op: { status: 'pending' } });
    expect(h.artifact.pages).toHaveLength(0);
  } finally {
    releaseModel('openai/gpt-4.1');
    await running;
  }
});
