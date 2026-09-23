/* eslint-disable @typescript-eslint/no-explicit-any -- actual host fixture with inert dependency ports */
/**
 * Per-turn Canvas MCP admission through the actual ChatViewProvider send path.
 *
 * The MCP bearer used to be scoped to the design only, so a delayed call from
 * the PREVIOUS turn's CLI arriving after a successor was admitted was accepted
 * under the successor's authority. Each ordinary turn in the linked chat panel
 * now revokes the previous credential at admission and mints a fresh one for
 * the turn's own backend just before it is sent. Providers are inert; the MCP
 * server is the real loopback HTTP server.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
vi.mock('../../src/managers/PlanOptionManager', () => ({
    PlanOptionManager: class { async classifyResponse() { return { questions: [], planOptions: [], context: '' }; } },
}));
vi.mock('../../src/managers/AgentLoader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/managers/AgentLoader')>();
    return { ...actual, AgentLoader: class extends actual.AgentLoader {
        constructor(context: ConstructorParameters<typeof actual.AgentLoader>[0]) { super(context, []); }
    } };
});
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasLiveness } from '../../src/canvas/CanvasLiveness';
import { CanvasSessionLinker } from '../../src/managers/CanvasSessionLinker';
import { CanvasToolServer } from '../../src/services/CanvasToolServer';
import { clearMockConfig, setMockConfig, Uri } from '../helpers/mockVscode';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';
import type { Settings, StreamChunk } from '../../src/types';

const SETTINGS: Settings = { mode: 'default', thinkingLevel: 'none', accessLevel: 'full-access', contextMode: 'manual', model: 'claude-opus-4-6', provider: 'claude-code' };

interface Endpoint { url: string; token: string }
interface Sent { panelId: string; provider: string; endpoint: Endpoint | null }

function rawStatus(endpoint: Endpoint, token = endpoint.token): Promise<number | 'refused'> {
    return new Promise(resolve => {
        const u = new URL(endpoint.url);
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
        res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', () => resolve('refused'));
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }));
    });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) { await c(); } vi.restoreAllMocks(); clearMockConfig(); });

async function harness() {
    clearMockConfig();
    setMockConfig('accessLevel', 'full-access');
    setMockConfig('defaultMode', 'default');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-mcp-turn-host-'));
    const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;
    const extensionContext = {
        globalState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
        workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
        subscriptions: [] as { dispose(): void }[],
        extensionPath: '/mock/extension-does-not-exist', extensionUri,
        extension: { packageJSON: { version: '0.0.0' } },
    } as any;
    const permissionManager = new PermissionManager('ask-permission');
    const configCalls: Array<[string, string | null, string | undefined]> = [];
    const sent: Sent[] = [];
    const holds = new Map<string, Promise<void>>();
    /** The config the provider would read for this panel at spawn. */
    const configFor = (panelId: string, provider: string): Endpoint | null => {
        const last = configCalls.filter(([p, , id]) => p === panelId && (id === undefined || id === provider)).at(-1);
        if (!last?.[1] || !fs.existsSync(last[1])) { return null; }
        const server = JSON.parse(fs.readFileSync(last[1], 'utf8')).mcpServers['mysti-canvas'];
        return { url: server.url, token: String(server.headers.Authorization).replace(/^Bearer /, '') };
    };
    const providerManager = {
        setNativeApprovalHandler: () => ({ dispose() { } }), setAgentContextManager: () => undefined,
        getProvider: () => ({ name: 'claude-code', models: [], defaultModel: 'claude-opus-4-6' }),
        getModels: () => [{ id: 'claude-opus-4-6', name: 'Inert' }],
        getProviders: () => [{ name: 'claude-code', models: [], defaultModel: 'claude-opus-4-6' }],
        getAllProviders: () => [],
        getProviderInstance: () => ({ capabilities: { supportsImages: true, thinkingStyle: 'streamed' }, getEffectiveModelForSettings: (s: Settings) => s.model }),
        getModelContextWindow: () => 200000,
        setChannelSystemContext: vi.fn(),
        setCanvasMcpConfig: vi.fn((panelId: string, configPath: string | null, providerId?: string) => { configCalls.push([panelId, configPath, providerId]); }),
        cancelRequest: () => undefined,
        getAllProviderIds: () => ['claude-code'],
        dispose: () => undefined,
        sendMessage: vi.fn(async function* (_c: string, _ctx: unknown, settings: Settings, _conv: unknown, _p: unknown, panelId: string): AsyncGenerator<StreamChunk> {
            sent.push({ panelId, provider: settings.provider!, endpoint: configFor(panelId, settings.provider!) });
            const hold = holds.get(panelId);
            if (hold) { await hold; }
            yield { type: 'done' } as StreamChunk;
        }),
    } as any;
    const noop = {} as any;
    const provider = new ChatViewProvider({
        extensionUri, extensionContext,
        contextManager: { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined } as any,
        conversationManager: {
            getCurrentConversation: () => null, getConversation: () => null, getAgentConfig: () => undefined,
            isFirstUserMessage: () => false,
            addMessageToConversation: (...args: any[]) => ({ id: `m-${Math.random()}`, role: args[1], content: args[2], timestamp: Date.now() }),
        } as any,
        providerManager,
        suggestionManager: { generateSuggestions: async () => [] } as any,
        brainstormManager: { cancelSession: () => undefined } as any,
        permissionManager,
        setupManager: {
            getWizardStatus: async () => ({ anyReady: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
            getWizardStatusCached: () => ({ anyReady: true, complete: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
            ensureProviderStatusFresh: async () => undefined, refreshWizardStatus: async () => ({ anyReady: true }),
            invalidateProviderStatus: () => undefined, onWizardStatusUpdated: () => ({ dispose: () => { } }),
        } as any,
        telemetryManager: noop,
        autonomousManager: { isActive: () => false } as any,
        memoryManager: { learnFromPermissionDecision: () => undefined, getProjectMemoryContent: () => '', recordProjectLearning: () => undefined } as any,
        compactionManager: {
            shouldCompact: () => false, recordUsage: () => undefined, appendHistory: () => undefined, isSmartActive: () => false,
            evaluateCompaction: () => ({ act: false, smart: false }), getThreshold: () => 75,
        } as any,
        lifecycleManager: { onLifecycleEvent: () => undefined, touchSession: () => undefined, markBusy: () => undefined, markIdle: () => undefined, registerSession: () => undefined } as any,
        slashCommandManager: noop,
        activeModeManager: {
            onStatusChanged: () => undefined, onChannelChanged: () => undefined, onActivity: () => undefined,
            subscribeToChannelEvents: () => () => undefined, isConnected: () => false, isInstalled: () => false, isIntegrationEnabled: () => false,
        } as any,
        engagementManager: { trackCustomPersonaCreated: () => undefined, trackCustomSkillCreated: () => undefined, trackMessageSent: () => [], trackSuccessfulResponse: () => undefined } as any,
        projectContextManager: { readRules: () => '', getMystiMdContent: () => '', getCrossVendorInstructions: () => [] } as any,
        visualTestManager: noop,
        modelRegistry: createModelRegistryStub() as any,
        checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null } as any,
    });
    const p = provider as any;
    const posts: any[] = [];
    for (const [id, conversation] of [['sidebar', 'conversation-fixture'], ['second', 'conversation-second']] as const) {
        p._panelStates.set(id, { id, webview: { postMessage: (m: any) => { posts.push({ id, ...m }); return Promise.resolve(true); } },
            currentConversationId: conversation, isSidebar: id === 'sidebar' });
    }
    await p._agentInitPromise;
    vi.spyOn(p, '_visualPromptSnippet').mockResolvedValue('');

    // An open canvas linked to the sidebar chat, with the real MCP transport.
    const store = new ArtifactStore({ getRoot: () => root });
    const router = new CanvasJobRouter(() => { });
    const executor = new CanvasOpExecutor(store, router);
    const artifact = store.createArtifact({ name: 'Design A', kind: 'screens' });
    p._panelStates.set('canvas', { id: 'canvas', webview: { postMessage: () => Promise.resolve(true) }, panel: { reveal: () => { }, dispose: () => { } }, currentConversationId: null, isSidebar: false });
    p._canvasPanelId = 'canvas';
    p._canvasChatOrigin = 'sidebar';
    p._canvasJobRouter = router;
    p._canvasLiveness = new CanvasLiveness({ router });
    p._canvasLinker = new CanvasSessionLinker({ tmpDir: root });
    p._canvasToolServer = new CanvasToolServer({ resolveContext: () => p._canvasToolContext({ kind: 'mcp' }) });
    p._canvasBridge = p._createCanvasBridge('canvas');
    p._canvasArtifactSession = p._createCanvasArtifactSession('canvas', store, executor, p._canvasBridge);
    const list = vi.spyOn(store, 'list').mockResolvedValue([{ id: artifact.id, name: artifact.name, kind: artifact.kind, pageCount: 0, updatedAt: artifact.updatedAt }]);
    const load = vi.spyOn(store, 'load').mockResolvedValue(artifact);
    await p._canvasArtifactSession.initialize();
    list.mockRestore(); load.mockRestore();
    // As on open: the tool server connects the current design once capabilities load.
    await p._canvasArtifactSession.refreshTransport();

    cleanups.push(async () => {
        await p._canvasArtifactSession?.close();
        await p._canvasMcpSession.dispose();
        p._canvasLiveness?.dispose();
        provider.dispose();
        permissionManager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return {
        p, sent, configCalls, posts,
        setHold(value: Promise<void> | undefined, panel = 'sidebar') {
            if (value) { holds.set(panel, value); } else { holds.delete(panel); }
        },
        run: (panel = 'sidebar', settings: Settings = SETTINGS) => p._handleSendMessage({ content: 'inert turn', context: [], settings: { ...settings } }, panel) as Promise<void>,
        /** Start a turn whose provider stream stays open until `release()`. */
        async held(panel = 'sidebar', settings: Settings = SETTINGS) {
            let release!: () => void;
            holds.set(panel, new Promise<void>(resolve => { release = resolve; }));
            const count = sent.length;
            const done = p._handleSendMessage({ content: 'inert turn', context: [], settings: { ...settings } }, panel) as Promise<void>;
            await vi.waitFor(() => expect(sent.length).toBe(count + 1));
            holds.delete(panel);
            return { endpoint: sent[count].endpoint, release, done: () => { release(); return done; } };
        },
        stop: (panel = 'sidebar') => p._handleMessage({ type: 'cancelRequest', panelId: panel, requestId: p._foregroundRequests.get(panel)?.requestId }),
    };
}

describe('per-turn Canvas MCP admission (actual host send path)', { timeout: 20_000 }, () => {
    it('each ordinary turn is sent with a fresh credential and the predecessor is refused', async () => {
        const h = await harness();
        const turn1 = await h.held();
        const first = turn1.endpoint!;
        expect(first).not.toBeNull();
        expect(await rawStatus(first)).toBe(200);
        await turn1.done();

        const turn2 = await h.held();
        const second = turn2.endpoint!;
        expect(second.token).not.toBe(first.token);
        expect(['refused', 410]).toContain(await rawStatus(first));
        expect(await rawStatus(second, first.token)).toBe(401);
        expect(await rawStatus(second)).toBe(200);
        await turn2.done();
    });

    it('links the originating backend, not the globally active provider', async () => {
        const h = await harness();
        await h.run('sidebar', { ...SETTINGS, provider: 'openai-codex' });
        const turnLink = h.configCalls.filter(([panel, config]) => panel === 'sidebar' && config !== null).at(-1)!;
        expect(turnLink[2]).toBe('openai-codex');
        expect(h.sent[0]).toMatchObject({ provider: 'openai-codex' });
        expect(h.sent[0].endpoint).not.toBeNull();
    });

    it('revokes at admission: a slow body from the old turn is never dispatched into the successor', async () => {
        const h = await harness();
        await h.run();
        const old = h.sent[0].endpoint!;
        const u = new URL(old.url);
        const status = new Promise<number | 'refused'>(resolve => {
            const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
                headers: { authorization: `Bearer ${old.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
            res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
            req.on('error', () => resolve('refused'));
            req.write('{"jsonrpc":"2.0","id":1,');
            (h as any).finishBody = () => req.end('"method":"tools/list","params":{}}');
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        let release!: () => void;
        h.setHold(new Promise<void>(resolve => { release = resolve; }));
        const successor = h.run();
        await vi.waitFor(() => expect(h.sent).toHaveLength(2));
        (h as any).finishBody();
        expect(['refused', 410]).toContain(await status);
        expect(await rawStatus(h.sent[1].endpoint!)).toBe(200);
        release();
        await successor;
    });

    it('a sibling panel turn neither revokes nor relinks the linked panel', async () => {
        const h = await harness();
        let release!: () => void;
        h.setHold(new Promise<void>(resolve => { release = resolve; }));
        const running = h.run();
        await vi.waitFor(() => expect(h.sent).toHaveLength(1));
        const linked = h.sent[0].endpoint!;
        const before = h.configCalls.length;
        await h.run('second');
        expect(h.sent[1]).toMatchObject({ panelId: 'second', endpoint: null });
        expect(h.configCalls.slice(before).filter(([panel]) => panel === 'second')).toHaveLength(0);
        expect(h.configCalls.slice(before)).toHaveLength(0);
        expect(await rawStatus(linked)).toBe(200);
        release();
        await running;
    });

    it('Stop still cancels the turn and retires its credential; the next turn gets a new one', async () => {
        const h = await harness();
        let release!: () => void;
        h.setHold(new Promise<void>(resolve => { release = resolve; }));
        const running = h.run();
        await vi.waitFor(() => expect(h.sent).toHaveLength(1));
        const held = h.sent[0].endpoint!;
        expect(await rawStatus(held)).toBe(200);
        await h.stop();
        expect(h.posts.some(m => m.id === 'sidebar' && m.type === 'requestCancelled')).toBe(true);
        expect(['refused', 410]).toContain(await rawStatus(held));
        release();
        await running;
        h.setHold(undefined);
        const next = await h.held();
        expect(next.endpoint!.token).not.toBe(held.token);
        expect(await rawStatus(next.endpoint!)).toBe(200);
        await next.done();
    });
});

describe('Canvas MCP credential lifetime beyond admission', { timeout: 20_000 }, () => {
    it('natural completion refuses the finished turn credential without retiring accessory posts', async () => {
        const h = await harness();
        const turn = await h.held();
        const finished = turn.endpoint!;
        expect(await rawStatus(finished)).toBe(200);
        const since = h.configCalls.length;
        await turn.done();
        // A late call from the finished turn's CLI is refused, not admitted.
        expect(['refused', 410]).toContain(await rawStatus(finished));
        // Accessory messages after `done` still own the foreground request.
        expect(h.p._foregroundRequests.get('sidebar').isCurrent()).toBe(true);
        // The config is not rewritten (no revision bump), so a warm process is
        // not restarted merely because the turn ended; the next admission unlinks.
        expect(h.configCalls.slice(since)).toHaveLength(0);
        const next = await h.held();
        expect(await rawStatus(next.endpoint!)).toBe(200);
        await next.done();
    });

    it('an obsolete turn finishing late cannot revoke its successor credential', async () => {
        const h = await harness();
        const old = await h.held();
        const successor = await h.held();
        await old.done();
        expect(await rawStatus(successor.endpoint!)).toBe(200);
        await successor.done();
        expect(['refused', 410]).toContain(await rawStatus(successor.endpoint!));
    });

    it('the design-open link targets the origin panel backend, not the globally active provider', async () => {
        const h = await harness();
        h.p._panelStates.get('sidebar').settingsOverrides = { provider: 'openai-codex' };
        h.configCalls.length = 0;
        await h.p._canvasArtifactSession.refreshTransport();
        const links = h.configCalls.filter(([, config]) => config !== null);
        expect(links).toHaveLength(1);
        expect(links[0]).toEqual(['sidebar', expect.any(String), 'openai-codex']);
    });

    describe('lanes that run under child panel ids never receive the credential', () => {
        /** Everything a lane could observe while it runs. */
        const observe = async (h: Awaited<ReturnType<typeof harness>>, previous: Endpoint, since: number) => ({
            previous: await rawStatus(previous),
            minted: h.configCalls.slice(since).filter(([, config]) => config !== null).length,
        });

        it.each(['coordinator', 'brainstorm'] as const)('a %s turn revokes the ordinary predecessor and mints nothing', async lane => {
            const h = await harness();
            const ordinary = await h.held();
            const since = h.configCalls.length;
            let during: Awaited<ReturnType<typeof observe>> | undefined;
            if (lane === 'coordinator') {
                vi.spyOn(h.p, '_runMystiAgentic').mockImplementation(async () => { during = await observe(h, ordinary.endpoint!, since); });
                await h.run('sidebar', { ...SETTINGS, provider: 'mysti' as Settings['provider'] });
            } else {
                h.p._brainstormManager = {
                    cancelSession: () => undefined, getCurrentSession: () => undefined,
                    startBrainstormSession: async function* () { during = await observe(h, ordinary.endpoint!, since); },
                };
                await h.p._handleBrainstormMessage({ content: 'inert brainstorm', context: [], settings: { ...SETTINGS } }, 'sidebar');
            }
            await ordinary.done();
            expect(during).toEqual({ previous: expect.stringMatching(/refused|410/) as unknown as string, minted: 0 });
            expect(h.configCalls.slice(since).filter(([, config]) => config !== null)).toHaveLength(0);
            expect(new Set(h.configCalls.map(([panel]) => panel))).toEqual(new Set(['sidebar']));
            expect(h.sent.map(s => s.panelId)).toEqual(['sidebar']);
        });

        it.each(['collaborator', 'mention'] as const)('%s children run with no live credential; only the parent lane is minted', async lane => {
            const h = await harness();
            const ordinary = await h.held();
            const since = h.configCalls.length;
            let during: Awaited<ReturnType<typeof observe>> | undefined;
            if (lane === 'collaborator') {
                vi.spyOn(h.p, '_runMentionCollaboration').mockImplementation(async () => { during = await observe(h, ordinary.endpoint!, since); return ''; });
            } else {
                vi.spyOn(h.p._mentionRouter, 'processMentions').mockImplementation(async function* () { during = await observe(h, ordinary.endpoint!, since); });
            }
            const mentions = [{ type: 'agent', value: 'openai-codex', ...(lane === 'collaborator' ? { role: 'critic' } : {}) }];
            await h.p._handleSendMessage({ content: '@openai-codex review', context: [], settings: { ...SETTINGS }, mentions }, 'sidebar');
            await ordinary.done();
            expect(during).toEqual({ previous: expect.stringMatching(/refused|410/) as unknown as string, minted: 0 });
            // The parent (main) lane of the same turn is the only one minted.
            expect(h.configCalls.slice(since).filter(([, config]) => config !== null).map(([panel]) => panel)).toEqual(['sidebar']);
            expect(new Set(h.configCalls.map(([panel]) => panel))).toEqual(new Set(['sidebar']));
        });
    });
});
