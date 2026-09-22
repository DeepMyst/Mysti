/* eslint-disable @typescript-eslint/no-explicit-any -- actual host fixture with inert dependency ports */
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
const fullSettings = { ...SETTINGS, mode: 'default' } as Settings;
async function canvasHarness() {
    clearMockConfig();
    setMockConfig('accessLevel', 'full-access');
    setMockConfig('defaultMode', 'default');
    const h = await createHarness();
    const p = h.provider as any;
    // Explicit inert visual port; these tests exercise Canvas preparation/intake only.
    vi.spyOn(p, '_visualPromptSnippet').mockResolvedValue('');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-media-authority-'));
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CanvasToolServer } from '../../src/services/CanvasToolServer';
import { CanvasMediaService } from '../../src/services/CanvasMediaService';
import { CanvasCapabilityRegistry } from '../../src/managers/CanvasCapabilityRegistry';

async function mediaHarness() {
    const h = await canvasHarness();
    h.p._canvasChatOrigin = 'sidebar';
    await h.store.save(h.artifact);
    const generationEntered = deferred();
    const generationRelease = deferred();
    const parentEntered = deferred();
    const parentRelease = deferred();
    const parentRuns: Promise<void>[] = [];
    const generation = vi.fn(async (_kind, _request, signal: AbortSignal) => {
        generationEntered.resolve();
        await generationRelease.promise;
        return { base64: Buffer.from('isolated-media-fixture').toString('base64'), mimeType: 'image/png', model: signal.aborted ? 'retired' : 'inert' };
    });
    const registry = new CanvasCapabilityRegistry({ isHubConnected: () => true, hasLocalKey: () => false, getPreference: () => 'auto' });
    const media = new CanvasMediaService({ registry, store: h.store, callBrokered: generation,
        generateLocal: async () => { throw new Error('unexpected local generation'); },
        fetchBytes: async () => { throw new Error('unexpected network fetch'); },
    });
    const captures: any[] = [];
    const server = new CanvasToolServer({ resolveContext: () => h.p._canvasToolContext({ kind: 'mcp' }), mediaService: media,
        captureMediaOperation: (ctx, request) => { const operation = h.p._captureCanvasMediaOperation(ctx, request); captures.push(operation); return operation; },
    });
    const client = new Client({ name: 'inert-host-media', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const pushOps = vi.spyOn(h.p._canvasBridge, 'pushOps');
    const pushHistory = vi.spyOn(h.p._canvasBridge, 'pushHistory');
    h.setSource(async function* () { parentEntered.resolve(); await parentRelease.promise; yield { type: 'done' }; });
    return { ...h, generationEntered, generationRelease, parentEntered, parentRelease, generation, client, server, captures, pushOps, pushHistory,
        startParent(content = 'inert media request', panel = 'sidebar', settings = fullSettings) {
            const pending = h.run(content, panel, settings); parentRuns.push(pending); return pending;
        },
        startMedia(signal?: AbortSignal) { return client.callTool({ name: 'generate_visual', arguments: { prompt: 'private inert art', role: 'hero' } }, undefined, signal ? { signal } : undefined); },
        async finish() {
            generationRelease.resolve(); parentRelease.resolve(); await Promise.allSettled(parentRuns);
            await client.close(); await server.close(); await h.close();
        },
    };
}

function mediaPayload(result: any) { return JSON.parse(result.content[0].text); }
function expectNoMedia(h: Awaited<ReturnType<typeof mediaHarness>>) {
    expect(h.artifact.assets).toHaveLength(0);
    expect(h.artifact.opLog.filter(op => op.kind === 'add_asset')).toHaveLength(0);
    expect(h.p._canvasMediaOperations?.size ?? 0).toBe(0);
}

describe('actual ordinary host and SDK media ownership', () => {
    it('persists and publishes an active MCP asset without borrowing foreground attribution', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            const before = h.pushOps.mock.calls.length;
            h.generationRelease.resolve(); const result = await pending;
            expect(result.isError).toBeFalsy();
            expect(mediaPayload(result)).toMatchObject({ committed: true, persisted: true, pending: false, status: 'applied' });
            expect(h.artifact.assets).toHaveLength(1);
            expect((await h.store.load(h.artifact.id))!.assets).toHaveLength(1);
            expect(h.artifact.opLog[0].runId).toBe('mcp');
            expect(h.pushOps.mock.calls.length).toBe(before + 1);
            expect(h.pushHistory).toHaveBeenCalled();
            expect(h.p._canvasMediaOperations.size).toBe(0);
        } finally { await h.finish(); }
    });

    it('actual Stop cancels a held generator promptly and clearing the panel flag cannot revive it', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            const captured = h.captures[0]; await h.stop(); h.p._cancelledPanels.clear();
            expect(captured.signal.aborted).toBe(true);
            expect((await pending).isError).toBe(true);
            expect(h.generation.mock.calls[0][2].aborted).toBe(true);
            h.generationRelease.resolve(); await Promise.resolve(); await Promise.resolve();
            expectNoMedia(h);
            expect((await h.store.load(h.artifact.id))!.assets).toHaveLength(0);
        } finally { await h.finish(); }
    });

    it('SDK request cancellation reaches the captured host operation', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const abort = new AbortController();
            const pending = h.startMedia(abort.signal).catch(error => error);
            await h.generationEntered.promise; abort.abort(); await pending;
            await new Promise(resolve => setImmediate(resolve));
            expect(h.captures[0].signal.aborted).toBe(true);
            h.generationRelease.resolve(); await Promise.resolve();
            expectNoMedia(h);
        } finally { await h.finish(); }
    });

    it.each(['done', 'error', 'auth_error', 'throw', 'EOF'] as const)('natural %s retires media even while the foreground object remains current', async outcome => {
        const h = await mediaHarness();
        try {
            h.setSource(async function* () {
                h.parentEntered.resolve(); await h.parentRelease.promise;
                if (outcome === 'throw') { throw new Error('inert provider failure'); }
                if (outcome !== 'EOF') { yield { type: outcome, content: outcome === 'done' ? undefined : 'inert terminal failure' } as StreamChunk; }
            });
            const parent = h.startParent(); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            h.parentRelease.resolve(); await parent;
            expect(h.p._foregroundRequests.get('sidebar').isCurrent()).toBe(true);
            expect((await pending).isError).toBe(true);
            expect(h.captures[0].signal.aborted).toBe(true);
            const retry = await h.startMedia(); expect(retry.isError).toBe(true);
            expect(h.generation).toHaveBeenCalledOnce();
            expectNoMedia(h);
        } finally { await h.finish(); }
    });

    it('replacement retires the captured call, while old finally cannot cancel successor media', async () => {
        const h = await mediaHarness(); const successorEntered = deferred(); const successorRelease = deferred();
        try {
            h.setSource(async function* (content) {
                if (content === 'old') { h.parentEntered.resolve(); await h.parentRelease.promise; }
                else { successorEntered.resolve(); await successorRelease.promise; }
                yield { type: 'done' };
            });
            const oldParent = h.startParent('old'); await h.parentEntered.promise;
            const oldMedia = h.startMedia(); await h.generationEntered.promise;
            h.startParent('new'); await successorEntered.promise;
            expect((await oldMedia).isError).toBe(true);
            const newMedia = h.startMedia();
            await vi.waitFor(() => expect(h.generation).toHaveBeenCalledTimes(2));
            h.parentRelease.resolve(); await oldParent;
            expect(h.captures[1].isCurrent()).toBe(true);
            h.generationRelease.resolve(); expect((await newMedia).isError).toBeFalsy();
            expect(h.artifact.assets).toHaveLength(1);
        } finally { successorRelease.resolve(); await h.finish(); }
    });

    it('Stop on another panel preserves this media operation', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            await h.p._handleMessage({ type: 'cancelRequest', panelId: 'second' });
            expect(h.captures[0].isCurrent()).toBe(true);
            h.generationRelease.resolve(); expect((await pending).isError).toBeFalsy();
        } finally { await h.finish(); }
    });

    it.each(['conversation', 'same-ID view', 'close', 'select'] as const)('%s invalidation refuses a late captured result', async change => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            if (change === 'conversation') { h.p._panelStates.get('sidebar').currentConversationId = 'other-conversation'; }
            if (change === 'same-ID view') { h.p._panelStates.set('canvas', { ...h.p._panelStates.get('canvas') }); }
            if (change === 'close') { await h.p._canvasArtifactSession.close(); }
            if (change === 'select') { await h.p._canvasArtifactSession.select(null, 'Successor'); }
            h.generationRelease.resolve(); expect((await pending).isError).toBe(true);
            expectNoMedia(h);
        } finally { await h.finish(); }
    });

    it('a captured staged parent floor survives live policy widening and saves a human-applicable pending op', async () => {
        const h = await mediaHarness();
        try {
            h.startParent('staged', 'sidebar', { ...fullSettings, accessLevel: 'read-only' }); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            setMockConfig('accessLevel', 'full-access'); h.generationRelease.resolve();
            const result = await pending; expect(result.isError).toBeFalsy();
            const payload = mediaPayload(result); expect(payload).toMatchObject({ pending: true, persisted: true, status: 'pending' });
            expect(h.artifact.assets).toHaveLength(0);
            const saved = (await h.store.load(h.artifact.id))!;
            expect(saved.opLog.find(op => op.opId === payload.opId)?.status).toBe('pending');
            expect(h.executor.applyOp(h.artifact, payload.opId, 'human')?.status).toBe('applied');
            expect(h.artifact.assets).toHaveLength(1);
        } finally { await h.finish(); }
    });

    it('live policy narrowing stages a formerly automatic media call', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            setMockConfig('accessLevel', 'read-only'); h.generationRelease.resolve();
            expect(mediaPayload(await pending)).toMatchObject({ pending: true, persisted: true });
            expect(h.artifact.assets).toHaveLength(0);
        } finally { await h.finish(); }
    });

    it('Stop reentered from the MCP started callback prevents generator admission', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            h.onEvent(event => { if (event.type === 'started') { void h.stop(); h.p._cancelledPanels.clear(); } });
            expect((await h.startMedia()).isError).toBe(true);
            expect(h.generation).not.toHaveBeenCalled(); expectNoMedia(h);
        } finally { await h.finish(); }
    });
    it('terminal UI callbacks cannot admit new media before optional done processing finishes', async () => {
        const h = await mediaHarness();
        try {
            const post = h.p._panelStates.get('sidebar').webview.postMessage;
            let capturedAtTerminal: any = 'not-called';
            h.p._panelStates.get('sidebar').webview.postMessage = (message: WebviewMessage) => {
                if (message.type === 'responseComplete') {
                    const ctx = h.p._canvasToolContext({ kind: 'mcp' });
                    capturedAtTerminal = h.p._captureCanvasMediaOperation(ctx, { requestId: 'late-ui', signal: new AbortController().signal });
                }
                return post(message);
            };
            const parent = h.startParent(); await h.parentEntered.promise;
            h.parentRelease.resolve(); await parent;
            expect(capturedAtTerminal).toBeNull(); expect(h.generation).not.toHaveBeenCalled();
        } finally { await h.finish(); }
    });

    it('a same-ID artifact session reopen cannot revive old media and admits a fresh call', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const pending = h.startMedia(); await h.generationEntered.promise;
            const old = h.p._canvasArtifactSession; await old.close();
            h.p._canvasArtifactSession = h.p._createCanvasArtifactSession('canvas', h.store, h.executor, h.p._canvasBridge);
            await h.p._canvasArtifactSession.initialize();
            expect(h.p._canvasArtifactSession.snapshot.artifact.id).toBe(h.artifact.id);
            expect(h.p._canvasArtifactSession.snapshot.artifact).not.toBe(h.artifact);
            expect((await pending).isError).toBe(true);
            h.generationRelease.resolve(); expect((await h.startMedia()).isError).toBeFalsy();
            expect(h.artifact.assets).toHaveLength(0);
            expect(h.p._canvasArtifactSession.snapshot.artifact.assets).toHaveLength(1);
        } finally { await h.finish(); }
    });

    it('a mismatched context cannot substitute another artifact or store', async () => {
        const h = await mediaHarness();
        try {
            h.startParent(); await h.parentEntered.promise;
            const ctx = h.p._canvasToolContext({ kind: 'mcp' });
            const request = { requestId: 'mismatch', signal: new AbortController().signal };
            expect(h.p._captureCanvasMediaOperation({ ...ctx, artifact: { ...ctx.artifact } }, request)).toBeNull();
            expect(h.p._captureCanvasMediaOperation({ ...ctx, store: new ArtifactStore({ getRoot: () => h.root }) }, request)).toBeNull();
            expect(h.p._captureCanvasMediaOperation({ ...ctx, history: {} }, request)).toBeNull();
        } finally { await h.finish(); }
    });

    it('unbound authenticated MCP retains its explicit view scope without guessing a chat parent', async () => {
        const h = await mediaHarness();
        try {
            h.p._canvasChatOrigin = null;
            const pending = h.startMedia(); await h.generationEntered.promise;
            await h.p._handleMessage({ type: 'cancelRequest', panelId: 'second' });
            expect(h.captures[0].isCurrent()).toBe(true);
            h.generationRelease.resolve(); expect((await pending).isError).toBeFalsy();
            expect(h.artifact.opLog[0].runId).toBe('mcp');
        } finally { await h.finish(); }
    });

});

import { McpClient } from '../../src/services/McpClient';

describe('production Canvas media adapter signal and kind routing', () => {
    it('caches distinct image/video tool choices and forwards the exact caller signal', async () => {
        const h = await canvasHarness();
        try {
            const listed = vi.spyOn(McpClient.prototype, 'listTools').mockResolvedValue([{ name: 'flux_image', description: '', inputSchema: {} }, { name: 'create_video', description: '', inputSchema: {} }]);
            const called = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue({ text: 'https://never-requested.invalid/inert.png', isError: false });
            h.p._deepMystAuth = { getApiKey: () => 'inert-not-a-credential', isSignedIn: () => true, client: { getMcpEndpointUrl: () => 'http://127.0.0.1:1/never-called' } };
            const registry = new CanvasCapabilityRegistry({ isHubConnected: () => true, hasLocalKey: () => false, getPreference: () => 'auto' });
            const deps = h.p._buildCanvasMediaService(registry, h.store)._deps;
            const signal = new AbortController().signal;
            for (const kind of ['image', 'video', 'image']) { await deps.callBrokered(kind, { kind, prompt: 'inert' }, signal); }
            expect(listed.mock.calls).toEqual([[signal], [signal]]);
            expect(called.mock.calls).toEqual([
                ['flux_image', { prompt: 'inert' }, signal], ['create_video', { prompt: 'inert' }, signal], ['flux_image', { prompt: 'inert' }, signal],
            ]);
        } finally { await h.close(); }
    });

    it('cancellation during an inert tool listing cannot start a generation call', async () => {
        const h = await canvasHarness(); const listed = deferred<any[]>();
        try {
            vi.spyOn(McpClient.prototype, 'listTools').mockReturnValue(listed.promise);
            const called = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue({ text: '', isError: false });
            h.p._deepMystAuth = { getApiKey: () => 'inert-not-a-credential', isSignedIn: () => true, client: { getMcpEndpointUrl: () => 'http://127.0.0.1:1/never-called' } };
            const deps = h.p._buildCanvasMediaService(new CanvasCapabilityRegistry({ isHubConnected: () => true, hasLocalKey: () => false, getPreference: () => 'auto' }), h.store)._deps;
            const abort = new AbortController();
            const pending = deps.callBrokered('image', { kind: 'image', prompt: 'inert' }, abort.signal).catch((error: unknown) => error);
            abort.abort(); listed.resolve([{ name: 'flux_image' }]);
            expect(await pending).toBe(abort.signal.reason); expect(called).not.toHaveBeenCalled();
        } finally { listed.resolve([]); await h.close(); }
    });

    it('local generation receives the signal and is not started after a cancelled inert key lookup', async () => {
        const h = await canvasHarness(); const lookup = deferred<string>();
        try {
            h.p._canvasSecrets = { get: vi.fn(() => lookup.promise) };
            h.p._imageGenService = { generate: vi.fn(async () => ({ imageBase64: 'inert' })) };
            const deps = h.p._buildCanvasMediaService(new CanvasCapabilityRegistry({ isHubConnected: () => false, hasLocalKey: () => true, getPreference: () => 'local' }), h.store)._deps;
            const abort = new AbortController();
            const pending = deps.generateLocal('image', { kind: 'image', prompt: 'inert' }, abort.signal).catch((error: unknown) => error);
            abort.abort(); lookup.resolve('fixture-key');
            expect(await pending).toBe(abort.signal.reason); expect(h.p._imageGenService.generate).not.toHaveBeenCalled();
            const signal = new AbortController().signal;
            await deps.generateLocal('image', { kind: 'image', prompt: 'inert' }, signal);
            expect(h.p._imageGenService.generate).toHaveBeenCalledExactlyOnceWith('inert', expect.objectContaining({ signal, apiKey: 'fixture-key' }));
        } finally { lookup.resolve(''); h.p._canvasSecrets = null; await h.close(); }
    });
});
