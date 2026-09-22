/** Ordinary provider ownership across actual host sends; providers and catalogs are inert. */
import { afterEach, describe, it, expect, vi } from 'vitest';

// The real PlanOptionManager constructs a ResponseClassifier, which spawns
// warm Claude CLI processes — never acceptable in a unit test run.
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() {
      return { questions: [], planOptions: [], context: '' };
    }
  },
}));

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, setMockConfig, createMockMemento, Uri, window, workspace } from '../helpers/mockVscode';
import type { Settings, StreamChunk, WebviewMessage, VisualObservation } from '../../src/types';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';
import { BackendVisualTurn } from '../../src/chat/BackendVisualTurn';
import { VisualOperationCancelled, type VisualOperationContext, type VisualSessionTarget } from '../../src/services/VisualOperation';
import type { MystiDirective } from '../../src/utils/mystiDelegateParser';
import { DevServerManager } from '../../src/managers/DevServerManager';

// Empty discovery roots and awaited initialization keep the actual host fixture isolated.
vi.mock('../../src/managers/AgentLoader', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/managers/AgentLoader')>();
  return { ...actual, AgentLoader: class extends actual.AgentLoader {
    constructor(context: ConstructorParameters<typeof actual.AgentLoader>[0]) { super(context, []); }
  } };
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const SETTINGS: Settings = {
  mode: 'edit-automatically',
  thinkingLevel: 'medium',
  accessLevel: 'full-access',
  contextMode: 'manual',
  model: 'claude-opus-4-6',
  provider: 'claude-code',
};

type VisualResult = { ok: boolean; output: string; cancelled?: boolean; cleanupIncomplete?: boolean; observation?: VisualObservation };
type Panel = { id: string; webview: { postMessage(message: WebviewMessage): Promise<boolean> }; currentConversationId: string | null; isSidebar: boolean };
type Binding = { operation: VisualOperationContext; target: VisualSessionTarget; permissionOwnerKey: string; requestId?: string; abort(): void; dispose(): void; policy: Record<string, unknown> };
interface Host {
  _panelStates: Map<string, Panel>;
  _agentInitPromise: Promise<void>;
  _cancelledPanels: Set<string>;
  _backendVisualTurns: Map<string, { turn: BackendVisualTurn; visual: Binding }>;
  _visualOperations: Map<string, Binding>;
  _dashboardVisualOwners: Map<string, string>;
  _foregroundRequests: Map<string, { requestId: string }>;
  _extensionContext: { workspaceState: ReturnType<typeof createMockMemento> };
  _projectContextManager: { scanWorkspace?: () => Promise<unknown> };
  _visualSessions: { look: ReturnType<typeof vi.fn>; getBaseUrl: ReturnType<typeof vi.fn>; isDevServerRunning: ReturnType<typeof vi.fn>; cancelOwner: ReturnType<typeof vi.fn>; probe: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  _visualTestManager: { recordObservation: ReturnType<typeof vi.fn>; disposePanel: ReturnType<typeof vi.fn>; cancelTest: ReturnType<typeof vi.fn> };
  _visualPromptSnippet(panel: string, settings: Settings, current: () => boolean, owner: BackendVisualTurn): Promise<string>;
  _runMystiVisual(directive: MystiDirective, settings: Settings, panel: string, tool: string, binding: Binding): Promise<VisualResult>;
  _launchBackendVisualLook(directive: MystiDirective, owner: BackendVisualTurn, binding: Binding, post: (message: WebviewMessage) => void): Promise<void>;
  _handleSendMessage(payload: {content: string; context: never[]; settings: Settings}, panel: string): Promise<void>;
  _handleMessage(message: {type: string; panelId: string; payload?: unknown; requestId?: string}): Promise<void>;
  _handleDashboardMessage(message: {type: string; payload?: unknown}, panel: string): Promise<void>;
  _createVisualOperation(settings: Settings, panel: string, key: string, owner: string, permission: string, current: () => boolean, signal?: AbortSignal, requestId?: string, operationId?: string): Binding;
  _confirmVisualDevServerCommand(command: string, source: string, operation: VisualOperationContext): Promise<boolean>;
  _runDashboardLook(panel: string, origin: string, settings: Settings, req: object, operationId: string): Promise<void>;
  _mystiCoordinator: { status(): object; credentialState(): object; resolveCoordinatorModel(): Promise<string>; stream: ReturnType<typeof vi.fn> };
  _runMystiAgentic(...args: unknown[]): Promise<void>;
  _availableMystiBackends(): never[];
  _mystiExecutionAborts: Map<string, AbortController>;
  _mystiRunGen: Map<string, number>;
}

interface Harness {
  provider: ChatViewProvider;
  /** Args of every addMessageToConversation call. */
  persistedCalls: unknown[][];
  /** Messages posted to the sidebar panel's webview. */
  sidebarMessages: WebviewMessage[];
  /** Replace the chunks the provider stream yields. */
  setStream(chunks: StreamChunk[]): void;
  /** Override the capabilities reported by getProviderInstance. */
  setCapabilities(caps: Record<string, unknown> | undefined): void;
  dispose(): Promise<void>;
}

async function createHarness(): Promise<Harness & { setSource(source: (content: string) => AsyncGenerator<StreamChunk>): void; cancels: string[]; lifecycle: Array<{kind: string; panelId: string}> }> {
  const extensionUri = Uri.file('/mock/extension-does-not-exist');
  const extensionContext = {
    globalState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    },
    workspaceState: createMockMemento(),
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist',
    extensionUri,
    extension: { packageJSON: { version: '0.0.0' } },
  };

  const permissionManager = new PermissionManager('ask-permission');

  let streamChunks: StreamChunk[] = [];
  let source: ((content: string) => AsyncGenerator<StreamChunk>) | undefined;
  const cancels: string[] = [];
  const lifecycle: Array<{kind: string; panelId: string}> = [];
  let capabilities: Record<string, unknown> | undefined = {
    supportsImages: true,
    supportsFileAttachments: true,
    thinkingStyle: 'streamed',
  };

  const persistedCalls: unknown[][] = [];
  let messageCounter = 0;
  const conversationManager = {
    getCurrentConversation: () => null,
    getConversation: (id: string) => id === 'other-conversation' ? { id, messages: [] } : null,
    getAgentConfig: () => undefined,
    isFirstUserMessage: () => false,
    addMessageToConversation: vi.fn((...args: unknown[]) => {
      persistedCalls.push(args);
      const [, role, content, context, attachments, thinking, extras] = args;
      return {
        id: `msg-${++messageCounter}`,
        role,
        content,
        timestamp: Date.now(),
        context,
        attachments,
        thinking,
        ...(extras && typeof extras === 'object' ? extras : {}),
      };
    }),
  };

  const providerManager = {
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
    getProvider: () => undefined,
    getProviderInstance: () => (capabilities ? { capabilities, getEffectiveModelForSettings: (settings: Settings) => settings.model } : undefined),
    getModelContextWindow: () => 200000,
    setChannelSystemContext: () => undefined,
    cancelRequest: (panelId: string) => { cancels.push(panelId); },
    getAllProviderIds: () => [],
    dispose: () => undefined,
    sendMessage: vi.fn(async function* (content: string) {
      if (source) { yield* source(content); return; }
      for (const chunk of streamChunks) {
        yield chunk;
      }
    }),
  };

  const setupManager = {
    getWizardStatus: async () => ({ anyReady: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
    getWizardStatusCached: () => ({ anyReady: true, complete: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
    ensureProviderStatusFresh: async () => undefined,
    refreshWizardStatus: async () => ({ anyReady: true }),
    invalidateProviderStatus: () => undefined,
    onWizardStatusUpdated: () => ({ dispose: () => {} }),
  };

  const lifecycleManager = {
    onLifecycleEvent: () => undefined,
    touchSession: () => undefined,
    markBusy: (panelId: string) => { lifecycle.push({kind: 'busy', panelId}); },
    markIdle: (panelId: string) => { lifecycle.push({kind: 'idle', panelId}); },
    registerSession: () => undefined,
  };

  const activeModeManager = {
    onStatusChanged: () => undefined,
    onChannelChanged: () => undefined,
    onActivity: () => undefined,
    subscribeToChannelEvents: () => () => undefined,
    isConnected: () => false,
    isInstalled: () => false,
    isIntegrationEnabled: () => false,
  };

  const engagementManager = {
    trackCustomPersonaCreated: () => undefined,
    trackCustomSkillCreated: () => undefined,
    trackMessageSent: () => [],
    trackSuccessfulResponse: () => undefined,
  };

  const memoryManager = {
    learnFromPermissionDecision: () => undefined,
    getProjectMemoryContent: () => '',
    recordProjectLearning: () => undefined,
  };

  const projectContextManager = {
    readRules: () => '',
    getMystiMdContent: () => '',
    getCrossVendorInstructions: () => [],
    scanWorkspace: async () => null,
  };

  const suggestionManager = {
    generateSuggestions: async () => [],
  };

  const autonomousManager = {
    isActive: () => false,
  };

  const compactionManager = {
    shouldCompact: () => false,
    recordUsage: () => undefined,
    // Smart-compaction (Plan 08) additions the done-handler calls unconditionally.
    appendHistory: () => undefined,
    isSmartActive: () => false,
    evaluateCompaction: () => ({ act: false, smart: false }),
    getThreshold: () => 75,
  };

  const contextManager = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
  };

  const noop = {};

  const provider = new ChatViewProvider({
    extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager,
    brainstormManager: { cancelSession: () => undefined },
    permissionManager,
    setupManager,
    telemetryManager: noop,
    autonomousManager,
    memoryManager,
    compactionManager,
    lifecycleManager,
    slashCommandManager: noop,
    activeModeManager,
    engagementManager,
    projectContextManager,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub(),
    checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null }
  } as unknown as ConstructorParameters<typeof ChatViewProvider>[0]);

  const sidebarMessages: WebviewMessage[] = [];
  (provider as unknown as Host)._panelStates.set('sidebar', {
    id: 'sidebar',
    webview: {
      postMessage: (message: WebviewMessage) => {
        sidebarMessages.push(message);
        return Promise.resolve(true);
      },
    },
    currentConversationId: 'conversation-fixture',
    isSidebar: true,
  });

  const initialization = (provider as unknown as Host)._agentInitPromise;
  await initialization;
  return {
    cancels, lifecycle, setSource(value) { source = value; },
    provider,
    persistedCalls,
    sidebarMessages,
    setStream(chunks) { streamChunks = chunks; },
    setCapabilities(caps) { capabilities = caps; },
    async dispose() {

      provider.dispose();
      permissionManager.dispose();
      for (const subscription of extensionContext.subscriptions) { subscription.dispose(); }
      await initialization;
    },
  };
}



function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function send(h: Harness, content: string) {
  return (h.provider as unknown as Host)._handleSendMessage({content, context: [], settings: {...SETTINGS}}, 'sidebar');
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); } vi.restoreAllMocks(); clearMockConfig(); });
async function fixture() {
  clearMockConfig();
  const h = await createHarness(); cleanups.push(() => h.dispose());
  const p = h.provider as unknown as Host;
  p._visualSessions = { look: vi.fn(), getBaseUrl: vi.fn(), isDevServerRunning: vi.fn(() => false), cancelOwner: vi.fn(async () => {}), probe: vi.fn(async () => ({ module: true, browser: true })), close: vi.fn(async () => {}) };
  p._visualTestManager = { recordObservation: vi.fn(), disposePanel: vi.fn(async () => {}), cancelTest: vi.fn() };
  // No installed browser, project filesystem or provider is consulted.
  vi.spyOn(DevServerManager, 'detectDevCommand').mockReturnValue(null);
  return { h, p };
}
async function visualFixture() {
  const { h, p } = await fixture();
  const visual = deferred<VisualResult>(); const tasks: Promise<void>[] = []; const owners = new Map<string, BackendVisualTurn>();
  const launch = p._launchBackendVisualLook.bind(p);
  vi.spyOn(p, '_visualPromptSnippet').mockImplementation(async (panel, _settings, _current, owner) => {
    owner.enable(); owners.set(panel, owner); return 'Inert look convention';
  });
  const run = vi.spyOn(p, '_runMystiVisual').mockImplementation(() => visual.promise);
  vi.spyOn(p, '_launchBackendVisualLook').mockImplementation((...args) => { const task = launch(...args); tasks.push(task); return task; });
  cleanups.push(async () => { visual.resolve({ ok: false, output: 'cleanup', cancelled: true }); await Promise.allSettled(tasks); });
  return { h, p, visual, tasks, run, owners };
}
const lookTag = (owner: BackendVisualTurn) => `<look:${owner.nonce}>inspect</look>`;
const assistantContents = (h: Harness) => h.persistedCalls.filter(args => args[1] === 'assistant').map(args => args[2]);
const observation = { screenshotPath: '/inert/owned.png', sequence: 1, console: [] } as unknown as VisualObservation;

 describe('ordinary visual continuation through the actual host', () => {
  it('persists a slow parent answer before admitting exactly one fast visual child', async () => {
    const f = await visualFixture(); const entered = deferred(); const parentGate = deferred(); const children: string[] = [];
    f.h.setSource(async function* (content) {
      if (content === 'PARENT') {
        yield { type: 'text', content: lookTag(f.owners.get('sidebar')!) };
        entered.resolve(); await parentGate.promise;
        yield { type: 'text', content: 'PARENT_FINISHED_ANSWER' }; yield { type: 'done' };
      } else { children.push(content); yield { type: 'text', content: 'CHILD_ANSWER' }; yield { type: 'done' }; }
    });
    const parent = send(f.h, 'PARENT'); await entered.promise;
    const nonce = f.owners.get('sidebar')!.nonce;
    f.visual.resolve({ ok: true, output: 'INERT_OBSERVATION', observation });
    await new Promise(resolve => setImmediate(resolve));
    expect(children).toEqual([]); expect(assistantContents(f.h)).toEqual([]);
    parentGate.resolve(); await parent; await Promise.all(f.tasks);
    expect(assistantContents(f.h)).toEqual([expect.stringContaining('PARENT_FINISHED_ANSWER'), 'CHILD_ANSWER']);
    expect(children).toHaveLength(1); expect(children[0]).toContain(nonce); expect(children[0]).toContain('INERT_OBSERVATION');
    expect(f.p._visualTestManager.recordObservation).toHaveBeenCalledOnce();
    const terminal = f.h.sidebarMessages.filter(m => m.type === 'responseComplete');
    const mini = f.h.sidebarMessages.filter(m => m.type === 'visualTestMiniStatus');
    expect(terminal).toHaveLength(2); expect(mini).toHaveLength(2);
    expect(mini.every(m => m.scope === 'accessory' && m.requestId === terminal[0].requestId)).toBe(true);
    expect(mini.map(m => (m.payload as { operationId: string }).operationId).every(Boolean)).toBe(true);
  });

  it.each(['error', 'auth_error', 'throw', 'eof'] as const)('never continues a parent ending with %s', async outcome => {
    const f = await visualFixture(); const children: string[] = [];
    f.h.setSource(async function* (content) {
      if (content !== 'PARENT') { children.push(content); yield { type: 'done' }; return; }
      yield { type: 'text', content: lookTag(f.owners.get('sidebar')!) };
      if (outcome === 'throw') { throw new Error('inert failure'); }
      if (outcome === 'error' || outcome === 'auth_error') { yield { type: outcome, content: 'inert failure' }; }
    });
    await send(f.h, 'PARENT');
    f.visual.resolve({ ok: true, output: 'STALE', observation }); await Promise.all(f.tasks);
    expect(children).toEqual([]); expect(assistantContents(f.h)).toEqual([]);
    expect(f.p._visualTestManager.recordObservation).not.toHaveBeenCalled();
    expect(f.h.sidebarMessages.some(m => m.type === 'responseComplete')).toBe(false);
    if (outcome === 'eof') { expect(f.h.sidebarMessages.filter(m => m.type === 'requestCancelled')).toHaveLength(1); }
  });

  it.each(['stop', 'conversation', 'same-id-panel', 'replacement', 'dispose'] as const)('rejects delayed result after successful parent then %s', async invalidation => {
    const f = await visualFixture(); const children: string[] = [];
    f.h.setSource(async function* (content) {
      if (content === 'PARENT') { yield { type: 'text', content: lookTag(f.owners.get('sidebar')!) }; }
      else { children.push(content); }
      yield { type: 'done' };
    });
    await send(f.h, 'PARENT'); const old = f.owners.get('sidebar')!;
    expect(f.p._backendVisualTurns.get('sidebar')?.turn).toBe(old);
    if (invalidation === 'stop') {
      await f.p._handleMessage({ type: 'cancelRequest', panelId: 'sidebar' }); f.p._cancelledPanels.clear();
    } else if (invalidation === 'conversation') {
      f.p._panelStates.get('sidebar')!.currentConversationId = 'changed';
    } else if (invalidation === 'same-id-panel') {
      f.p._panelStates.set('sidebar', { ...f.p._panelStates.get('sidebar')! });
    } else if (invalidation === 'replacement') { await send(f.h, 'REPLACEMENT'); }
    else { f.h.provider.dispose(); }
    const before = f.h.sidebarMessages.length;
    f.visual.resolve({ ok: true, output: 'STALE', observation }); await Promise.all(f.tasks);
    expect(children).toEqual(invalidation === 'replacement' ? ['REPLACEMENT'] : []);
    expect(f.h.sidebarMessages).toHaveLength(before);
    expect(f.p._visualTestManager.recordObservation).not.toHaveBeenCalled();
    expect(old.signal.aborted).toBe(true);
    if (invalidation === 'stop') { expect(f.p._visualSessions.cancelOwner).toHaveBeenCalledWith(old.requestId); }
  });

  it('isolates trigger and scanner state when another panel sends between fragments', async () => {
    const f = await visualFixture(); const paused = deferred(); const resume = deferred();
    f.p._panelStates.set('sibling', { ...f.p._panelStates.get('sidebar')!, id: 'sibling' });
    f.h.setSource(async function* (content) {
      if (content === 'LEFT') {
        const tag = lookTag(f.owners.get('sidebar')!); yield { type: 'text', content: tag.slice(0, 10) };
        paused.resolve(); await resume.promise; yield { type: 'text', content: tag.slice(10) };
      } else if (content === 'RIGHT') { yield { type: 'text', content: lookTag(f.owners.get('sibling')!) }; }
      yield { type: 'done' };
    });
    const left = send(f.h, 'LEFT'); await paused.promise;
    await f.p._handleSendMessage({content: 'RIGHT', context: [], settings: { ...SETTINGS }}, 'sibling');
    resume.resolve(); await left;
    expect(f.run).toHaveBeenCalledTimes(2); expect(f.run.mock.calls.map(call => call[2]).sort()).toEqual(['sibling', 'sidebar']);
    expect(f.owners.get('sidebar')!.nonce).not.toBe(f.owners.get('sibling')!.nonce);
    f.visual.resolve({ ok: false, output: 'cancelled', cancelled: true }); await Promise.all(f.tasks);
  });

  it('only an exact current operation/request pair can cancel the visual after parent completion', async () => {
    const f = await visualFixture();
    f.h.setSource(async function* () { yield { type: 'text', content: lookTag(f.owners.get('sidebar')!) }; yield { type: 'done' }; });
    await send(f.h, 'PARENT'); const owner = f.owners.get('sidebar')!;
    const binding = f.p._backendVisualTurns.get('sidebar')!.visual;
    for (const [operationId, requestId] of [[binding.operation.id, 'old'], ['old-operation', owner.requestId]]) {
      await f.p._handleMessage({ type: 'cancelVisualTest', panelId: 'sidebar', requestId, payload: { operationId } });
      expect(binding.operation.signal.aborted).toBe(false);
    }
    await f.p._handleMessage({ type: 'cancelVisualTest', panelId: 'sidebar', requestId: owner.requestId, payload: { operationId: binding.operation.id } });
    expect(binding.operation.signal.aborted).toBe(true);
    expect(f.h.sidebarMessages.at(-1)).toMatchObject({ type: 'visualTestMiniStatus', requestId: owner.requestId,
      payload: { operationId: binding.operation.id, status: 'cancelled' } });
    f.visual.resolve({ ok: true, output: 'late' }); await Promise.all(f.tasks);
    expect(assistantContents(f.h)).toHaveLength(1);
  });
});

function enableVisual() {
  const descriptor = Object.getOwnPropertyDescriptor(workspace, 'isTrusted');
  Object.defineProperty(workspace, 'isTrusted', { value: true, configurable: true, writable: true });
  cleanups.push(async () => { if (descriptor) { Object.defineProperty(workspace, 'isTrusted', descriptor); } else { Reflect.deleteProperty(workspace, 'isTrusted'); } });
  setMockConfig('mysti.visualTools', 'on'); setMockConfig('visualTest.enabled', true);
  setMockConfig('visualTest.url', 'http://localhost:3000'); setMockConfig('visualTest.agentInteractions', 'safe');
}
function bind(p: Host, id = 'operation') {
  return p._createVisualOperation(SETTINGS, 'sidebar', 'mysti:sidebar', 'resource-owner', 'sidebar', () => true, undefined, undefined, id);
}
const fullObservation: VisualObservation = { ...observation, url: 'http://localhost:3000', browser: 'chromium',
  viewport: { width: 1280, height: 720 }, network: [], layout: [] };

describe('captured visual authority through actual host approval and runtime adapters', () => {
  it.each(['Run once', 'Always for this workspace'])('late modal %s after abort neither grants nor launches', async choice => {
    const { p } = await fixture(); enableVisual(); const visual = bind(p);
    const modal = deferred<string | undefined>(); const entered = deferred();
    const show = vi.spyOn(window, 'showWarningMessage').mockImplementation(() => { entered.resolve(); return modal.promise as Promise<undefined>; });
    const update = vi.spyOn(p._extensionContext.workspaceState, 'update');
    const approval = p._confirmVisualDevServerCommand('npm run dev', 'package-json', visual.operation);
    const refusal = expect(approval).rejects.toBeInstanceOf(VisualOperationCancelled);
    await entered.promise; visual.abort(); await refusal;
    modal.resolve(choice); await new Promise(resolve => setImmediate(resolve));
    expect(show).toHaveBeenCalledOnce(); expect(update).not.toHaveBeenCalled(); expect(p._visualSessions.look).not.toHaveBeenCalled();
    visual.dispose();
  });

  it('remembers consent only for captured cwd and never widens a model command', async () => {
    const { p } = await fixture(); enableVisual();
    const first = bind(p, 'first');
    const show = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Always for this workspace' as unknown as undefined);
    expect(await p._confirmVisualDevServerCommand('npm run dev', 'settings', first.operation)).toBe(true);
    expect(await p._confirmVisualDevServerCommand('npm run dev', 'settings', first.operation)).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    const second = { ...first.operation, workspaceRoot: '/another/root' };
    show.mockResolvedValue(undefined);
    expect(await p._confirmVisualDevServerCommand('npm run dev', 'settings', second)).toBe(false);
    expect(await p._confirmVisualDevServerCommand('npm run dev', 'model', first.operation)).toBe(false);
    expect(show).toHaveBeenCalledTimes(3); first.dispose();
  });

  it('captures cwd and denies delayed workspace scan after authority changes', async () => {
    const { p } = await fixture(); enableVisual(); const scan = deferred<unknown>(); const entered = deferred();
    p._projectContextManager.scanWorkspace = () => { entered.resolve(); return scan.promise; };
    const visual = bind(p); const originalRoot = visual.operation.workspaceRoot;
    const run = p._runMystiVisual({ kind: 'look' }, SETTINGS, 'sidebar', 'tool', visual);
    await entered.promise;
    setMockConfig('visualTest.agentInteractions', 'off');
    scan.resolve({ framework: 'inert' });
    expect(await run).toMatchObject({ ok: false, cancelled: true });
    expect(visual.operation.workspaceRoot).toBe(originalRoot); expect(p._visualSessions.look).not.toHaveBeenCalled(); visual.dispose();
  });

  it('does not seed new launch resolution with incompatible warm metadata', async () => {
    const { p } = await fixture(); enableVisual(); setMockConfig('visualTest.devServerCommand', 'npm run old');
    const old = bind(p, 'old');
    p._visualSessions.getBaseUrl.mockImplementation((_key, identity) => identity === old.operation.workspaceIdentity ? 'http://localhost:8999' : undefined);
    p._visualSessions.isDevServerRunning.mockImplementation((_key, identity) => identity === old.operation.workspaceIdentity);
    setMockConfig('visualTest.devServerCommand', 'npm run new');
    const next = bind(p, 'new');
    p._visualSessions.look.mockResolvedValue(fullObservation);
    expect(await p._runMystiVisual({ kind: 'look' }, SETTINGS, 'sidebar', 'tool', next)).toMatchObject({ ok: true });
    const [target, resolution, options] = p._visualSessions.look.mock.calls[0];
    expect(target).toMatchObject({ cacheKey: 'mysti:sidebar', ownerKey: 'resource-owner' });
    expect(resolution).toMatchObject({ devCommand: 'npm run new', devCommandSource: 'settings', config: { url: 'http://localhost:3000' } });
    expect(options.operation.workspaceIdentity).not.toBe(old.operation.workspaceIdentity);
    expect(old.operation.isCurrent()).toBe(false); old.dispose(); next.dispose();
  });

  it('passes immutable authority plus the real panel permission owner and signal to interaction approval', async () => {
    const { p, h } = await fixture(); enableVisual(); const visual = bind(p);
    const gate = vi.spyOn(h.provider, 'requestPermissionInline').mockImplementation(async (...args) => {
      expect(args[4]).toBe('sidebar'); expect(args[6]).toBe('sidebar'); expect(args[9]).toBe(visual.operation.signal);
      visual.abort(); return true;
    });
    p._visualSessions.look.mockImplementation(async (_target, _resolution, options) => {
      await options.approveInteractions([{ action: 'click', target: '#button' }]); return fullObservation;
    });
    expect(await p._runMystiVisual({ kind: 'act', actions: [{ action: 'click', target: '#button' }] }, SETTINGS, 'sidebar', 'tool', visual))
      .toMatchObject({ ok: false, cancelled: true });
    expect(gate).toHaveBeenCalledOnce(); visual.dispose();
  });

  it('preserves explicit cleanup-incomplete cancellation from the deep runtime', async () => {
    const { p } = await fixture(); enableVisual(); const visual = bind(p);
    p._visualSessions.look.mockRejectedValue(new VisualOperationCancelled(true));
    expect(await p._runMystiVisual({ kind: 'look' }, SETTINGS, 'sidebar', 'tool', visual))
      .toMatchObject({ ok: false, cancelled: true, cleanupIncomplete: true, output: expect.stringContaining('cleanup could not be confirmed') });
    visual.dispose();
  });

  it('reports current mini cancellation cleanup failure without claiming successful teardown', async () => {
    const f = await visualFixture();
    f.h.setSource(async function* () { yield { type: 'text', content: lookTag(f.owners.get('sidebar')!) }; yield { type: 'done' }; });
    await send(f.h, 'PARENT'); const { turn, visual } = f.p._backendVisualTurns.get('sidebar')!;
    f.p._visualSessions.cancelOwner.mockRejectedValue(new Error('owned browser cleanup unconfirmed'));
    await f.p._handleMessage({ type: 'cancelVisualTest', panelId: 'sidebar', requestId: turn.requestId, payload: { operationId: visual.operation.id } });
    expect(f.h.sidebarMessages.at(-1)).toMatchObject({ requestId: turn.requestId, payload: { status: 'cancelled', cleanupIncomplete: true, message: 'owned browser cleanup unconfirmed' } });
  });
});

describe('dashboard visual operation tokens through the actual host', () => {
  async function dashboard() {
    const f = await fixture(); enableVisual(); const messages: WebviewMessage[] = [];
    f.p._panelStates.set('dashboard', { id: 'dashboard', isSidebar: false, currentConversationId: null,
      webview: { postMessage: async message => { messages.push(message); return true; } } });
    return { ...f, messages };
  }

  it('immediate Cancel during scan stops before runtime effects and acknowledges its own token', async () => {
    const f = await dashboard(); const scan = deferred<unknown>(); const entered = deferred();
    f.p._projectContextManager.scanWorkspace = () => { entered.resolve(); return scan.promise; };
    const running = f.p._runDashboardLook('dashboard', 'sidebar', SETTINGS, {}, 'dash-A'); await entered.promise;
    await f.p._handleDashboardMessage({ type: 'dashboardCancelVisualTest', payload: { operationId: 'stale' } }, 'dashboard');
    expect(f.p._visualOperations.get('dash-A')!.operation.signal.aborted).toBe(false);
    await f.p._handleDashboardMessage({ type: 'dashboardCancelVisualTest', payload: { operationId: 'dash-A' } }, 'dashboard');
    await running; scan.resolve(null);
    expect(f.p._visualSessions.look).not.toHaveBeenCalled();
    expect(f.messages.filter(m => m.type === 'visualTestDashboardCancelled')).toEqual([{ type: 'visualTestDashboardCancelled', payload: { operationId: 'dash-A' } }]);
    expect(f.p._visualTestManager.recordObservation).not.toHaveBeenCalled();
  });

  it('uses actual observation completion payload and captured human origin without a provider follow-up', async () => {
    const f = await dashboard(); f.p._visualSessions.look.mockResolvedValue(fullObservation);
    await f.p._runDashboardLook('dashboard', 'sidebar', SETTINGS, {}, 'dash-A');
    expect(f.messages.at(-1)).toMatchObject({ type: 'visualTestDashboardUpdate', payload: { operationId: 'dash-A', type: 'visual_observation', status: 'complete', observation: fullObservation } });
    expect(f.h.sidebarMessages.at(-1)).toMatchObject({ type: 'visualTestMiniStatus', scope: 'notice', payload: { operationId: 'dash-A', status: 'complete' } });
    expect(f.h.persistedCalls).toEqual([]); expect(f.p._visualTestManager.recordObservation).toHaveBeenCalledWith('dashboard', fullObservation);
  });

  it('cleanup refusal still releases Cancel with a truthful warning', async () => {
    const f = await dashboard(); const scan = deferred<unknown>(); const entered = deferred();
    f.p._projectContextManager.scanWorkspace = () => { entered.resolve(); return scan.promise; };
    const running = f.p._runDashboardLook('dashboard', 'sidebar', SETTINGS, {}, 'dash-A'); await entered.promise;
    f.p._visualSessions.cancelOwner.mockRejectedValue(new Error('owned process cleanup unconfirmed'));
    await f.p._handleDashboardMessage({ type: 'dashboardCancelVisualTest', payload: { operationId: 'dash-A' } }, 'dashboard');
    await running; scan.resolve(null);
    expect(f.messages.at(-1)).toMatchObject({ type: 'visualTestDashboardCancelled', payload: { operationId: 'dash-A', cleanupIncomplete: true, message: 'owned process cleanup unconfirmed' } });
  });

  it('a late old cleanup acknowledgement cannot settle a newer dashboard operation', async () => {
    const f = await dashboard(); const cleanup = deferred();
    f.p._visualSessions.look.mockResolvedValue(fullObservation);
    await f.p._runDashboardLook('dashboard', 'sidebar', SETTINGS, {}, 'dash-A');
    f.p._visualSessions.cancelOwner.mockImplementationOnce(() => cleanup.promise);
    const cancelling = f.p._handleDashboardMessage({ type: 'dashboardCancelVisualTest', payload: { operationId: 'dash-A' } }, 'dashboard');
    await f.p._runDashboardLook('dashboard', 'sidebar', SETTINGS, {}, 'dash-B');
    cleanup.resolve(); await cancelling;
    expect(f.messages.filter(m => m.type === 'visualTestDashboardCancelled')).toEqual([]);
    expect(f.p._dashboardVisualOwners.get('dashboard')).toBe('dash-B');
  });
});

describe('coordinator visual execution through the actual run dispatcher', () => {
  async function coordinator() {
    const f = await fixture(); enableVisual();
    setMockConfig('mysti.memory', false); setMockConfig('mysti.verify', 'off'); setMockConfig('mysti.crossReview', 'off');
    f.p._availableMystiBackends = () => [];
    let turns = 0;
    f.p._mystiCoordinator = {
      status: () => ({ ready: true }), credentialState: () => ({ hasDeepMystKey: true, usingOpenRouter: false }),
      resolveCoordinatorModel: async () => 'openai/gpt-4.1',
      stream: vi.fn(async function* () {
        if (turns++ === 0) { yield { toolCalls: [{ id: 'inert-look', name: 'look', arguments: '{}' }] }; }
        else { yield { text: 'Coordinator answer.' }; }
        yield { done: true };
      }),
    };
    return { ...f, run: (jobId?: string) => f.p._runMystiAgentic('Observe inert fixture.', [], { ...SETTINGS, provider: 'mysti' },
      { id: 'conversation-fixture', messages: [] }, 'sidebar', 'conversation-fixture', jobId) };
  }

  it('publishes successful current observation with captured request and operation identity', async () => {
    const f = await coordinator(); let completedController: AbortController | undefined;
    f.p._visualSessions.look.mockImplementation(async () => { completedController = f.p._mystiExecutionAborts.get('sidebar'); return fullObservation; });
    await f.run();
    completedController!.abort();
    expect(f.p._visualSessions.cancelOwner).not.toHaveBeenCalled();
    expect(f.p._visualSessions.look).toHaveBeenCalledOnce();
    const [target, , options] = f.p._visualSessions.look.mock.calls[0];
    expect(target).toMatchObject({ panelId: 'sidebar', cacheKey: 'mysti:sidebar' });
    expect(options.operation.panelId).toBe('sidebar'); expect(options.operation.ownerKey).toBe(target.ownerKey);
    const started = f.h.sidebarMessages.find(m => m.type === 'responsePending')!;
    const mini = f.h.sidebarMessages.filter(m => m.type === 'visualTestMiniStatus');
    expect(mini.map(m => (m.payload as { status: string }).status)).toEqual(['capturing', 'complete']);
    expect(mini.every(m => m.scope === 'accessory' && m.requestId === started.requestId
      && (m.payload as { operationId: string }).operationId === options.operation.id)).toBe(true);
    expect(f.h.sidebarMessages.filter(m => m.type === 'responseComplete')).toHaveLength(1);
  });

  it('actual Stop aborts the captured runtime signal and retains a failed receipt after flag clear', async () => {
    const f = await coordinator(); const entered = deferred(); const runtime = deferred<VisualObservation>(); let captured: VisualOperationContext | undefined;
    f.p._visualSessions.look.mockImplementation(async (_target, _resolution, options) => {
      captured = options.operation; entered.resolve(); return runtime.promise;
    });
    const running = f.run(); await entered.promise;
    const sibling = new AbortController(); f.p._mystiExecutionAborts.set('sibling', sibling);
    await f.p._handleMessage({ type: 'cancelRequest', panelId: 'sidebar' }); f.p._cancelledPanels.clear();
    expect(captured!.signal.aborted).toBe(true); expect(sibling.signal.aborted).toBe(false);
    runtime.resolve(fullObservation); await running;
    expect(f.h.sidebarMessages.filter(m => m.type === 'responseComplete')).toEqual([]);
    expect(f.h.sidebarMessages.filter(m => m.type === 'visualTestMiniStatus').map(m => (m.payload as {status: string}).status)).toEqual(['capturing']);
    const assistant = f.h.persistedCalls.filter(args => args[1] === 'assistant').at(-1)!;
    expect(assistant[2]).toContain('Stopped');
    expect(assistant[6]).toMatchObject({ toolCalls: [expect.objectContaining({ status: 'failed', output: 'Visual operation cancelled.' })] });
  });

  it('generation replacement refuses late visual success even without an aborted run signal', async () => {
    const f = await coordinator(); const entered = deferred(); const runtime = deferred<VisualObservation>();
    f.p._visualSessions.look.mockImplementation(async () => { entered.resolve(); return runtime.promise; });
    const running = f.run(); await entered.promise;
    f.p._mystiRunGen.set('sidebar', (f.p._mystiRunGen.get('sidebar') ?? 0) + 1);
    runtime.resolve(fullObservation); await running;
    expect(f.h.sidebarMessages.filter(m => m.type === 'responseComplete')).toEqual([]);
    expect(f.h.sidebarMessages.filter(m => m.type === 'visualTestMiniStatus').map(m => (m.payload as {status: string}).status)).toEqual(['capturing']);
    expect(f.p._mystiCoordinator.stream).toHaveBeenCalledOnce();
  });

  it('Stop between coordinator turns closes the completed look owner immediately', async () => {
    const f = await coordinator(); const waiting = deferred(); const release = deferred();
    f.p._visualSessions.look.mockResolvedValue(fullObservation);
    let turns = 0;
    f.p._mystiCoordinator.stream.mockImplementation(async function* () {
      if (turns++ === 0) { yield { toolCalls: [{ id: 'look', name: 'look', arguments: '{}' }] }; }
      else { waiting.resolve(); await release.promise; yield { text: 'late response' }; }
      yield { done: true };
    });
    const running = f.run(); await waiting.promise;
    const target = f.p._visualSessions.look.mock.calls[0][0];
    await f.p._handleMessage({ type: 'cancelRequest', panelId: 'sidebar' });
    expect(f.p._visualSessions.cancelOwner).toHaveBeenCalledWith(target.ownerKey);
    release.resolve(); await running;
    expect(f.h.sidebarMessages.filter(m => m.type === 'responseComplete')).toEqual([]);
  });

  it('background completion closes its unique warm cache even if cleanup refuses, then releases its controller', async () => {
    const f = await coordinator(); f.p._visualSessions.look.mockResolvedValue(fullObservation);
    f.p._visualSessions.close.mockRejectedValue(new Error('owned cleanup unconfirmed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await f.run('visual-job');
    expect(f.p._visualSessions.look.mock.calls[0][0]).toMatchObject({ ownerKey: 'visual-job', cacheKey: 'mysti-job:visual-job', panelId: 'sidebar' });
    expect(f.p._visualSessions.close).toHaveBeenCalledWith('mysti-job:visual-job');
    expect(f.p._mystiExecutionAborts.has('visual-job')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup could not be confirmed'), 'owned cleanup unconfirmed');
    expect(f.h.sidebarMessages.some(m => m.type === 'visualTestMiniStatus')).toBe(false);
  });
});

it('refuses a held old mini cleanup warning after a replacement request is admitted', async () => {
  const f = await visualFixture(); const cleanup = deferred();
  f.h.setSource(async function* (content) {
    if (content === 'PARENT') { yield { type: 'text', content: lookTag(f.owners.get('sidebar')!) }; }
    yield { type: 'done' };
  });
  await send(f.h, 'PARENT'); const { turn, visual } = f.p._backendVisualTurns.get('sidebar')!;
  f.p._visualSessions.cancelOwner.mockImplementationOnce(async () => { await cleanup.promise; throw new Error('old cleanup incomplete'); });
  const cancelled = f.p._handleMessage({ type: 'cancelVisualTest', panelId: 'sidebar', requestId: turn.requestId, payload: { operationId: visual.operation.id } });
  await send(f.h, 'REPLACEMENT'); const before = f.h.sidebarMessages.length;
  cleanup.resolve(); await cancelled;
  expect(f.h.sidebarMessages).toHaveLength(before);
  expect(f.h.sidebarMessages.some(m => m.type === 'visualTestMiniStatus' && (m.payload as {status: string}).status === 'cancelled')).toBe(false);
});
