/** Ordinary provider ownership across actual host sends; providers and catalogs are inert. */
import { describe, it, expect, vi } from 'vitest';
import { CanvasLiveness } from '../../src/canvas/CanvasLiveness';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
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
import { clearMockConfig, setMockConfig, Uri } from '../helpers/mockVscode';
import type { Settings, StreamChunk, WebviewMessage } from '../../src/types';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';
// Empty discovery roots and awaited initialization keep the actual host fixture isolated.
vi.mock('../../src/managers/AgentLoader', async (importOriginal) => {
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
interface Harness {
    provider: ChatViewProvider;
    /** Args of every addMessageToConversation call. */
    persistedCalls: any[][];
    /** Messages posted to the sidebar panel's webview. */
    sidebarMessages: Array<{
        type: string;
        payload?: any;
    }>;
    /** Replace the chunks the provider stream yields. */
    setStream(chunks: StreamChunk[]): void;
    /** Override the capabilities reported by getProviderInstance. */
    setCapabilities(caps: Record<string, unknown> | undefined): void;
    dispose(): Promise<void>;
}
async function createHarness(): Promise<Harness & {
    setSource(source: (content: string) => AsyncGenerator<StreamChunk>): void;
    cancels: string[];
    lifecycle: Array<{
        kind: string;
        panelId: string;
    }>;
}> {
    const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;
    const extensionContext = {
        globalState: {
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: async () => undefined,
        },
        workspaceState: {
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: async () => undefined,
        },
        subscriptions: [] as {
            dispose(): void;
        }[],
        extensionPath: '/mock/extension-does-not-exist',
        extensionUri,
        extension: { packageJSON: { version: '0.0.0' } },
    } as any;
    const permissionManager = new PermissionManager('ask-permission');
    let streamChunks: StreamChunk[] = [];
    let source: ((content: string) => AsyncGenerator<StreamChunk>) | undefined;
    const cancels: string[] = [];
    const lifecycle: Array<{
        kind: string;
        panelId: string;
    }> = [];
    let capabilities: Record<string, unknown> | undefined = {
        supportsImages: true,
        supportsFileAttachments: true,
        thinkingStyle: 'streamed',
    };
    const persistedCalls: any[][] = [];
    let messageCounter = 0;
    const conversationManager = {
        getCurrentConversation: () => null,
        getConversation: (id: string) => id === 'other-conversation' ? { id, messages: [] } : null,
        getAgentConfig: () => undefined,
        isFirstUserMessage: () => false,
        addMessageToConversation: vi.fn((...args: any[]) => {
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
                ...(extras || {}),
            };
        }),
    } as any;
    const providerManager = {
        setNativeApprovalHandler: () => ({ dispose() { } }), setAgentContextManager: () => undefined,
        getProvider: () => ({ name: 'claude-code', models: [], defaultModel: 'claude-opus-4-6' }),
        getModels: () => [{ id: 'claude-opus-4-6', name: 'Inert' }],
        getProviders: () => [{ name: 'claude-code', models: [], defaultModel: 'claude-opus-4-6' }],
        getAllProviders: () => [],
        getProviderInstance: () => (capabilities ? { capabilities, getEffectiveModelForSettings: (settings: Settings) => settings.model } : undefined),
        getModelContextWindow: () => 200000,
        setChannelSystemContext: vi.fn(),
        cancelRequest: (panelId: string) => { cancels.push(panelId); },
        getAllProviderIds: () => ['claude-code'],
        dispose: () => undefined,
        sendMessage: vi.fn(async function* (content: string) {
            if (source) {
                yield* source(content);
                return;
            }
            for (const chunk of streamChunks) {
                yield chunk;
            }
        }),
    } as any;
    const setupManager = {
        getWizardStatus: async () => ({ anyReady: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
        getWizardStatusCached: () => ({ anyReady: true, complete: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
        ensureProviderStatusFresh: async () => undefined,
        refreshWizardStatus: async () => ({ anyReady: true }),
        invalidateProviderStatus: () => undefined,
        onWizardStatusUpdated: () => ({ dispose: () => { } }),
    } as any;
    const lifecycleManager = {
        onLifecycleEvent: () => undefined,
        touchSession: () => undefined,
        markBusy: (panelId: string) => { lifecycle.push({ kind: 'busy', panelId }); },
        markIdle: (panelId: string) => { lifecycle.push({ kind: 'idle', panelId }); },
        registerSession: () => undefined,
    } as any;
    const activeModeManager = {
        onStatusChanged: () => undefined,
        onChannelChanged: () => undefined,
        onActivity: () => undefined,
        subscribeToChannelEvents: () => () => undefined,
        isConnected: () => false,
        isInstalled: () => false,
        isIntegrationEnabled: () => false,
    } as any;
    const engagementManager = {
        trackCustomPersonaCreated: () => undefined,
        trackCustomSkillCreated: () => undefined,
        trackMessageSent: () => [],
        trackSuccessfulResponse: () => undefined,
    } as any;
    const memoryManager = {
        learnFromPermissionDecision: () => undefined,
        getProjectMemoryContent: () => '',
        recordProjectLearning: () => undefined,
    } as any;
    const projectContextManager = {
        readRules: () => '',
        getMystiMdContent: () => '',
        getCrossVendorInstructions: () => [],
    } as any;
    const suggestionManager = {
        generateSuggestions: async () => [],
    } as any;
    const autonomousManager = {
        isActive: () => false,
    } as any;
    const compactionManager = {
        shouldCompact: () => false,
        recordUsage: () => undefined,
        // Smart-compaction (Plan 08) additions the done-handler calls unconditionally.
        appendHistory: () => undefined,
        isSmartActive: () => false,
        evaluateCompaction: () => ({ act: false, smart: false }),
        getThreshold: () => 75,
    } as any;
    const contextManager = {
        getContext: () => [],
        setAutoContext: () => undefined,
        clearPanelContext: () => undefined,
    } as any;
    const noop = {} as any;
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
        modelRegistry: createModelRegistryStub() as any,
        checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null } as any
    });
    const sidebarMessages: Array<{
        type: string;
        payload?: any;
    }> = [];
    (provider as any)._panelStates.set('sidebar', {
        id: 'sidebar',
        webview: {
            postMessage: (message: WebviewMessage) => {
                sidebarMessages.push(message as any);
                return Promise.resolve(true);
            },
        },
        currentConversationId: 'conversation-fixture',
        isSidebar: true,
    });
    const initialization = (provider as any)._agentInitPromise;
    await initialization;
    return {
        cancels, lifecycle, setSource(value) { source = value; },
        provider,
        persistedCalls,
        sidebarMessages,
        setStream(chunks) { streamChunks = chunks; },
        setCapabilities(caps) { capabilities = caps; },
        async dispose() {
            (provider as any)._canvasLiveness?.dispose();
            provider.dispose();
            permissionManager.dispose();
            for (const subscription of extensionContext.subscriptions) {
                subscription.dispose();
            }
            await initialization;
        },
    };
}
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
const PAGE = 'function Page(){ return <UI.Screen><UI.Heading>Inert</UI.Heading></UI.Screen>; }';
function op(nonce: string | undefined, label = 'inert') { return { ...(nonce === undefined ? {} : { nonce }), kind: 'insert_page', proposedValue: { mode: 'jsx', jsxSource: PAGE, actionTitle: label } }; }
function actualFence(value: unknown) { return '```canvas-op\n' + JSON.stringify(value) + '\n```\n'; }
const fullSettings = { ...SETTINGS, mode: 'default' } as Settings;
async function canvasHarness() {
    clearMockConfig();
    setMockConfig('accessLevel', 'full-access');
    setMockConfig('defaultMode', 'default');
    const h = await createHarness();
    const p = h.provider as any;
    // Explicit inert visual port; these tests exercise Canvas preparation/intake only.
    vi.spyOn(p, '_visualPromptSnippet').mockResolvedValue('');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-fenced-authority-'));
    const store = new ArtifactStore({ getRoot: () => root });
    const events: any[] = [];
    let onEvent: ((event: any) => void) | undefined;
    const router = new CanvasJobRouter(event => { events.push(event); onEvent?.(event); });
    const executor = new CanvasOpExecutor(store, router);
    const artifact = store.createArtifact({ name: 'Original A', kind: 'screens' });
    const messages: any[] = [];
    p._panelStates.set('second', { id: 'second', webview: { postMessage: (m: any) => { messages.push(m); return Promise.resolve(true); } }, currentConversationId: 'other-conversation', isSidebar: false });
    p._panelStates.set('canvas', { id: 'canvas', webview: { postMessage: () => Promise.resolve(true) }, panel: { reveal: () => { }, dispose: () => { } }, currentConversationId: null, isSidebar: false });
    p._canvasPanelId = 'canvas';
    p._canvasChatOrigin = null;
    p._canvasJobRouter = router;
    p._canvasLiveness = new CanvasLiveness({ router });
    p._canvasBridge = p._createCanvasBridge('canvas');
    p._canvasArtifactSession = p._createCanvasArtifactSession('canvas', store, executor, p._canvasBridge);
    vi.spyOn(p._canvasMcpSession, 'relink').mockResolvedValue(undefined);
    const list = vi.spyOn(store, 'list').mockResolvedValue([{ id: artifact.id, name: artifact.name, kind: artifact.kind, pageCount: 0, updatedAt: artifact.updatedAt }]);
    const load = vi.spyOn(store, 'load').mockResolvedValue(artifact);
    await p._canvasArtifactSession.initialize();
    list.mockRestore();
    load.mockRestore();
    return { ...h, p, root, store, executor, artifact, events, messages, router,
        onEvent(value: (event: any) => void) { onEvent = value; },
        stop: (panel = 'sidebar') => p._handleMessage({ type: 'cancelRequest', panelId: panel, requestId: p._foregroundRequests.get(panel)?.requestId }),
        systemPrompt: (panel = 'sidebar') => p._providerManager.setChannelSystemContext.mock.calls.filter((args: any[]) => args[0] === panel).at(-1)?.[1] ?? '',
        nonce: (panel = 'sidebar') => {
            const prompt = p._providerManager.setChannelSystemContext.mock.calls.filter((args: any[]) => args[0] === panel).at(-1)?.[1] ?? '';
            const match = /"nonce":"([^"\n]+)"/.exec(prompt);
            expect(match, `no Canvas nonce in actual emitted prompt for ${panel}`).not.toBeNull();
            return match![1];
        },
        run: (content: string, panel = 'sidebar', settings = fullSettings) => p._handleSendMessage({ content, context: [], settings: { ...settings } }, panel) as Promise<void>,
        close: async () => { await p._canvasArtifactSession?.close(); await p._canvasMcpSession.dispose(); await h.dispose(); fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); clearMockConfig(); },
    };
}
describe('actual ordinary Canvas fenced turn authority', () => {
    it('current full-access exact-nonce stream edits its captured design', async () => {
        const h = await canvasHarness();
        try {
            h.setSource(async function* () { yield { type: 'text', content: actualFence(op(h.nonce('sidebar'), 'valid')) }; yield { type: 'done' }; });
            await h.run('VALID');
            expect(h.artifact.pages).toHaveLength(1);
            expect(h.artifact.opLog[0].status).toBe('applied');
            expect(h.p._providerManager.sendMessage).toHaveBeenCalledOnce();
        }
        finally {
            await h.close();
        }
    });
    it('live restrictive global policy still stages an ordinary fenced edit', async () => {
        const h = await canvasHarness();
        try {
            setMockConfig('accessLevel', 'read-only');
            h.setSource(async function* () { yield { type: 'text', content: actualFence(op(h.nonce('sidebar'), 'staged')) }; yield { type: 'done' }; });
            await h.run('STAGED');
            expect(h.artifact.pages).toHaveLength(0);
            expect(h.artifact.opLog[0].status).toBe('pending');
        }
        finally {
            await h.close();
        }
    });
    it.each(['read-only', 'quick-plan'] as const)('captured %s ordinary settings must constrain a permissive live Canvas policy', async (floor) => {
        const h = await canvasHarness();
        try {
            const settings = { ...fullSettings, ...(floor === 'read-only' ? { accessLevel: 'read-only' as const } : { mode: 'quick-plan' as const }) };
            h.setSource(async function* () { yield { type: 'text', content: actualFence(op(h.nonce('sidebar'), 'captured-floor')) }; yield { type: 'done' }; });
            await h.run('CAPTURED_FLOOR', 'sidebar', settings);
            const actualSettings = h.p._providerManager.sendMessage.mock.calls[0]?.[2];
            expect(actualSettings[floor === 'read-only' ? 'accessLevel' : 'mode']).toBe(floor);
            expect(h.artifact.pages).toHaveLength(0);
            expect(h.artifact.opLog[0].status).toBe('pending');
        }
        finally {
            await h.close();
        }
    });
    it.each(['missing', 'wrong'] as const)('a %s nonce is not authorized by the token appearing inside proposedValue', async (shape) => {
        const h = await canvasHarness();
        try {
            h.setSource(async function* () { const token = h.nonce('sidebar'); yield { type: 'text', content: actualFence(op(shape === 'missing' ? undefined : 'wrong-nonce', 'decoy ' + token)) }; yield { type: 'done' }; });
            await h.run('DECOY');
            expect(h.artifact.pages).toHaveLength(0);
        }
        finally {
            await h.close();
        }
    });
    it.each(['during-stream', 'before-stream-visual-await'] as const)('switching design %s cannot redirect an old prompt-authorized edit', async (phase) => {
        const h = await canvasHarness();
        const entered = deferred();
        const release = deferred();
        let pending: Promise<void> | undefined;
        try {
            if (phase === 'before-stream-visual-await') {
                vi.mocked(h.p._visualPromptSnippet).mockImplementationOnce(() => { entered.resolve(); return release.promise.then(() => ''); });
            }
            h.setSource(async function* () { const token = h.nonce('sidebar'); if (phase === 'during-stream') {
                entered.resolve();
                await release.promise;
            } yield { type: 'text', content: actualFence(op(token, 'OLD_PROMPT_EDIT')) }; yield { type: 'done' }; });
            const next = h.store.createArtifact({ name: 'Successor B', kind: 'screens' });
            await h.store.save(next);
            pending = h.run('OLD_DESIGN');
            await entered.promise;
            await h.p._switchCanvasArtifact('canvas', next.id);
            expect(h.p._canvasArtifact.id).toBe(next.id);
            release.resolve();
            await pending;
            const prompt = h.p._providerManager.setChannelSystemContext.mock.calls.map((c: any[]) => c[1]).join('\n');
            expect(prompt).toContain('Original A');
            expect(h.p._canvasArtifact.pages).toHaveLength(0);
        }
        finally {
            release.resolve();
            if (pending) {
                await Promise.allSettled([pending]);
            }
            await h.close();
        }
    });
    it('a second still-current panel starting a stream must not erase the first partial fence', async () => {
        const h = await canvasHarness();
        const aWaiting = deferred();
        const bWaiting = deferred();
        const releaseA = deferred();
        const releaseB = deferred();
        let a: Promise<void> | undefined, b: Promise<void> | undefined;
        try {
            h.setSource(async function* (content) {
                const panel = content === 'A' ? 'sidebar' : 'second';
                const block = actualFence(op(h.nonce(panel), content));
                if (content === 'A') {
                    const split = Math.floor(block.length / 2);
                    yield { type: 'text', content: block.slice(0, split) };
                    aWaiting.resolve();
                    await releaseA.promise;
                    yield { type: 'text', content: block.slice(split) };
                }
                else {
                    yield { type: 'text', content: block };
                    bWaiting.resolve();
                    await releaseB.promise;
                }
                yield { type: 'done' };
            });
            a = h.run('A');
            await aWaiting.promise;
            b = h.run('B', 'second');
            await bWaiting.promise;
            expect(h.p._runningPanels.has('sidebar')).toBe(true);
            expect(h.p._runningPanels.has('second')).toBe(true);
            releaseA.resolve();
            releaseB.resolve();
            await Promise.all([a, b]);
            expect(h.artifact.pages.map((page: any) => page.actionTitle).sort()).toEqual(['A', 'B']);
        }
        finally {
            releaseA.resolve();
            releaseB.resolve();
            await Promise.allSettled([a, b].filter(Boolean));
            await h.close();
        }
    });
    it('independent partial streams must not splice one panel body with another panel nonce', async () => {
        const h = await canvasHarness();
        const aReady = deferred();
        const bReady = deferred();
        const emitA = deferred();
        const aPartial = deferred();
        const emitB = deferred();
        const finishA = deferred();
        let a: Promise<void> | undefined, b: Promise<void> | undefined;
        try {
            h.setSource(async function* (content) {
                if (content === 'A') {
                    aReady.resolve();
                    await emitA.promise;
                    const body = JSON.stringify(op(undefined, 'BODY_FROM_A'));
                    yield { type: 'text', content: '```canvas-op\n' + body.slice(0, -1) + ',' };
                    aPartial.resolve();
                    await finishA.promise;
                }
                else {
                    bReady.resolve();
                    await emitB.promise;
                    yield { type: 'text', content: '"nonce":' + JSON.stringify(h.nonce('second')) + '}\n```\n' };
                }
                yield { type: 'done' };
            });
            a = h.run('A');
            await aReady.promise;
            b = h.run('B', 'second');
            await bReady.promise;
            emitA.resolve();
            await aPartial.promise;
            emitB.resolve();
            await b;
            finishA.resolve();
            await a;
            expect(h.artifact.pages).toHaveLength(0);
        }
        finally {
            emitA.resolve();
            emitB.resolve();
            finishA.resolve();
            await Promise.allSettled([a, b].filter(Boolean));
            await h.close();
        }
    });
    it('publishes and persists staged suggestions, preserving human apply and reject', async () => {
        const h = await canvasHarness();
        try {
            const publish = vi.spyOn(h.p._canvasBridge, 'pushOps');
            const history = vi.spyOn(h.p._canvasBridge, 'pushHistory');
            const save = vi.spyOn(h.p._canvasArtifactSession, 'scheduleSave');
            h.setSource(async function* () {
                yield { type: 'text', content: actualFence(op(h.nonce(), 'accept-me')) + actualFence(op(h.nonce(), 'reject-me')) };
                yield { type: 'done' };
            });
            await h.run('STAGED_PERSISTENCE', 'sidebar', { ...fullSettings, accessLevel: 'read-only' });
            expect(h.artifact.pages).toHaveLength(0);
            expect(h.artifact.opLog.map(entry => entry.status)).toEqual(['pending', 'pending']);
            expect(publish).toHaveBeenCalled();
            expect(history).toHaveBeenCalled();
            expect(save).toHaveBeenCalled();
            await h.p._canvasArtifactSession.close();
            const restored = await h.store.load(h.artifact.id);
            expect(restored?.opLog.map(entry => entry.status)).toEqual(['pending', 'pending']);
            expect(restored?.pages).toHaveLength(0);
            const [accept, reject] = restored!.opLog;
            h.executor.applyOp(restored!, accept.opId, 'human-accept');
            h.executor.rejectOp(restored!, reject.opId, 'human-reject');
            expect(restored!.pages.map(page => page.actionTitle)).toEqual(['accept-me']);
            expect(restored!.opLog.map(entry => entry.status)).toEqual(['applied', 'rejected']);
        }
        finally {
            await h.close();
        }
    });
    it('only the bound origin receives and can use its Canvas instructions', async () => {
        const h = await canvasHarness();
        try {
            h.p._canvasChatOrigin = 'sidebar';
            let originNonce = '';
            h.setSource(async function* (content) {
                if (content === 'ORIGIN') {
                    originNonce = h.nonce();
                }
                yield { type: 'text', content: actualFence(op(originNonce, content)) };
                yield { type: 'done' };
            });
            await h.run('ORIGIN');
            await h.run('OTHER', 'second');
            expect(h.systemPrompt()).toContain(originNonce);
            expect(h.systemPrompt('second')).not.toContain('canvas-op');
            expect(h.artifact.pages.map(page => page.actionTitle)).toEqual(['ORIGIN']);
        }
        finally {
            await h.close();
        }
    });
    it('reads live approval from the originating unbound chat after the job-start callback', async () => {
        const h = await canvasHarness();
        try {
            const original = h.p._getSettingsForPanel.bind(h.p);
            let restrictOrigin = false;
            const settings = vi.spyOn(h.p, '_getSettingsForPanel').mockImplementation((panel: unknown) => ({
                ...original(panel), ...(restrictOrigin && panel === 'sidebar' ? { accessLevel: 'read-only' } : {}),
            }));
            h.onEvent(event => { if (event.type === 'started') {
                restrictOrigin = true;
            } });
            h.setSource(async function* () { yield { type: 'text', content: actualFence(op(h.nonce())) }; yield { type: 'done' }; });
            await h.run('LIVE_NARROWING');
            expect(settings).toHaveBeenCalledWith('sidebar');
            expect(h.artifact.pages).toHaveLength(0);
            expect(h.artifact.opLog[0].status).toBe('pending');
        }
        finally {
            await h.close();
        }
    });
    it('returning from A to B to A cannot restore a prior snapshot authority', async () => {
        const h = await canvasHarness();
        const entered = deferred();
        const release = deferred();
        let pending: Promise<void> | undefined;
        try {
            const b = h.store.createArtifact({ name: 'B', kind: 'screens' });
            await h.store.save(b);
            const oldSnapshot = h.p._canvasArtifactSession.snapshot;
            h.setSource(async function* () {
                const token = h.nonce();
                entered.resolve();
                await release.promise;
                yield { type: 'text', content: actualFence(op(token, 'obsolete-A')) };
                yield { type: 'done' };
            });
            pending = h.run('ROUND_TRIP');
            await entered.promise;
            await h.p._switchCanvasArtifact('canvas', b.id);
            await h.p._switchCanvasArtifact('canvas', h.artifact.id);
            expect(h.p._canvasArtifact.id).toBe(h.artifact.id);
            expect(h.p._canvasArtifactSession.snapshot).not.toBe(oldSnapshot);
            release.resolve();
            await pending;
            expect(h.artifact.pages).toHaveLength(0);
            expect(h.p._canvasArtifact.pages).toHaveLength(0);
        }
        finally {
            release.resolve();
            await Promise.allSettled([pending]);
            await h.close();
        }
    });
    it('same-ID view and artifact reopen refuses the old turn while a fresh turn still edits', async () => {
        const h = await canvasHarness();
        const entered = deferred();
        const release = deferred();
        let pending: Promise<void> | undefined;
        try {
            h.setSource(async function* (content) {
                const token = h.nonce();
                if (content === 'OLD_VIEW') {
                    entered.resolve();
                    await release.promise;
                }
                yield { type: 'text', content: actualFence(op(token, content)) };
                yield { type: 'done' };
            });
            pending = h.run('OLD_VIEW');
            await entered.promise;
            const oldSession = h.p._canvasArtifactSession;
            await oldSession.close();
            h.p._canvasBridge.dispose();
            h.p._canvasLiveness.dispose();
            h.p._canvasTurns.clearCanvas();
            h.p._panelStates.set('canvas', { ...h.p._panelStates.get('canvas') });
            h.p._canvasLiveness = new CanvasLiveness({ router: h.router });
            h.p._canvasBridge = h.p._createCanvasBridge('canvas');
            h.p._canvasArtifactSession = h.p._createCanvasArtifactSession('canvas', h.store, h.executor, h.p._canvasBridge);
            await h.p._canvasArtifactSession.initialize();
            expect(h.p._canvasArtifact.id).toBe(h.artifact.id);
            expect(h.p._canvasArtifactSession).not.toBe(oldSession);
            release.resolve();
            await pending;
            expect(h.p._canvasArtifact.pages).toHaveLength(0);
            await h.run('NEW_VIEW');
            expect(h.p._canvasArtifact.pages.map((page: any) => page.actionTitle)).toEqual(['NEW_VIEW']);
        }
        finally {
            release.resolve();
            await Promise.allSettled([pending]);
            await h.close();
        }
    });
    it('a synchronous started callback invalidating the view prevents submission', async () => {
        const h = await canvasHarness();
        try {
            const submit = vi.spyOn(h.executor, 'submit');
            h.onEvent(event => { if (event.type === 'started') {
                h.p._panelStates.set('canvas', { ...h.p._panelStates.get('canvas') });
            } });
            h.setSource(async function* () { yield { type: 'text', content: actualFence(op(h.nonce())) }; yield { type: 'done' }; });
            await h.run('REENTRANT_VIEW');
            expect(submit).not.toHaveBeenCalled();
            expect(h.artifact.pages).toHaveLength(0);
            expect(h.router.activeCount()).toBe(0);
        }
        finally {
            await h.close();
        }
    });
    it('publication invalidating the captured view prevents history and save through a successor', async () => {
        const h = await canvasHarness();
        try {
            const bridge = h.p._canvasBridge;
            const originalPublish = bridge.pushOps.bind(bridge);
            vi.spyOn(bridge, 'pushOps').mockImplementation(() => {
                originalPublish();
                h.p._panelStates.set('canvas', { ...h.p._panelStates.get('canvas') });
            });
            const history = vi.spyOn(bridge, 'pushHistory');
            const save = vi.spyOn(h.p._canvasArtifactSession, 'scheduleSave');
            h.setSource(async function* () { yield { type: 'text', content: actualFence(op(h.nonce())) }; yield { type: 'done' }; });
            await h.run('REENTRANT_PUBLICATION');
            expect(h.artifact.pages).toHaveLength(1);
            expect(history).not.toHaveBeenCalled();
            expect(save).not.toHaveBeenCalled();
        }
        finally {
            await h.close();
        }
    });
    it('Stop during the actual started event closes the job once and refuses the edit', async () => {
        const h = await canvasHarness();
        let stopping: Promise<void> | undefined;
        try {
            h.onEvent(event => { if (event.type === 'started') {
                stopping = h.stop();
            } });
            h.setSource(async function* () { yield { type: 'text', content: actualFence(op(h.nonce())) }; yield { type: 'done' }; });
            await h.run('STOP_IN_STARTED');
            await stopping;
            const started = h.events.filter(event => event.type === 'started');
            expect(started).toHaveLength(1);
            expect(h.events.filter(event => event.jobId === started[0].jobId && event.type === 'done')).toHaveLength(1);
            expect(h.router.activeCount()).toBe(0);
            expect(h.p._canvasLiveness.jobsForRun('chat-sidebar')).toEqual([]);
            expect(h.artifact.pages).toHaveLength(0);
            expect(h.artifact.opLog).toHaveLength(0);
            expect(h.sidebarMessages.filter(message => message.type === 'requestCancelled')).toHaveLength(1);
            expect(h.p._runningPanels.has('sidebar')).toBe(false);
        }
        finally {
            await stopping;
            await h.close();
        }
    });
    it('Stop remains sticky after flag clearing and old cleanup cannot close the successor job', async () => {
        const h = await canvasHarness();
        const oldReady = deferred();
        const newReady = deferred();
        const releaseOld = deferred();
        const releaseNew = deferred();
        let old: Promise<void> | undefined;
        let next: Promise<void> | undefined;
        try {
            h.setSource(async function* (content) {
                const token = h.nonce();
                const block = actualFence(op(token, content));
                if (content === 'OLD') {
                    yield { type: 'text', content: block.slice(0, block.length - 5) };
                    oldReady.resolve();
                    await releaseOld.promise;
                    yield { type: 'text', content: block.slice(-5) };
                }
                else {
                    yield { type: 'text', content: block };
                    newReady.resolve();
                    await releaseNew.promise;
                }
                yield { type: 'done' };
            });
            old = h.run('OLD');
            await oldReady.promise;
            await h.stop();
            h.p._cancelledPanels.delete('sidebar');
            next = h.run('NEW');
            await newReady.promise;
            const successorJob = h.events.find(event => event.type === 'started').jobId;
            releaseOld.resolve();
            await old;
            expect(h.router.has(successorJob)).toBe(true);
            expect(h.p._runningPanels.has('sidebar')).toBe(true);
            expect(h.artifact.pages.map(page => page.actionTitle)).toEqual(['NEW']);
            releaseNew.resolve();
            await next;
            expect(h.router.activeCount()).toBe(0);
            expect(h.events.filter(event => event.jobId === successorJob && event.type === 'done')).toHaveLength(1);
        }
        finally {
            releaseOld.resolve();
            releaseNew.resolve();
            await Promise.allSettled([old, next]);
            await h.close();
        }
    });
    it.each(['done', 'error', 'eof'] as const)('retires a partial fence at %s without consuming the next turn', async (terminal) => {
        const h = await canvasHarness();
        let staleTail = '';
        try {
            h.setSource(async function* (content) {
                if (content === 'OLD_PARTIAL') {
                    const block = actualFence(op(h.nonce(), 'old-partial'));
                    const split = Math.floor(block.length / 2);
                    staleTail = block.slice(split);
                    yield { type: 'text', content: block.slice(0, split) };
                    if (terminal === 'done') {
                        yield { type: 'done' };
                    }
                    if (terminal === 'error') {
                        yield { type: 'error', content: 'inert refusal' };
                    }
                }
                else {
                    yield { type: 'text', content: staleTail };
                    yield { type: 'text', content: actualFence(op(h.nonce(), 'current')) };
                    yield { type: 'done' };
                }
            });
            await h.run('OLD_PARTIAL');
            await h.run('CURRENT');
            expect(h.artifact.pages.map(page => page.actionTitle)).toEqual(['current']);
            expect(h.artifact.opLog).toHaveLength(1);
            expect(h.router.activeCount()).toBe(0);
        }
        finally {
            await h.close();
        }
    });
    it('ending one panel never clears a still-current sibling parser', async () => {
        const h = await canvasHarness();
        const aReady = deferred();
        const releaseA = deferred();
        let a: Promise<void> | undefined;
        try {
            h.setSource(async function* (content) {
                const block = actualFence(op(h.nonce(content === 'A' ? 'sidebar' : 'second'), content));
                if (content === 'A') {
                    const split = Math.floor(block.length / 2);
                    yield { type: 'text', content: block.slice(0, split) };
                    aReady.resolve();
                    await releaseA.promise;
                    yield { type: 'text', content: block.slice(split) };
                }
                else {
                    yield { type: 'text', content: block };
                }
                yield { type: 'done' };
            });
            a = h.run('A');
            await aReady.promise;
            await h.run('B', 'second');
            expect(h.p._runningPanels.has('sidebar')).toBe(true);
            releaseA.resolve();
            await a;
            expect(h.artifact.pages.map(page => page.actionTitle).sort()).toEqual(['A', 'B']);
        }
        finally {
            releaseA.resolve();
            await Promise.allSettled([a]);
            await h.close();
        }
    });
});
