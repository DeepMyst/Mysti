/**
 * Compaction transports are owned by the request that started them: Stop,
 * a conversation switch, a replacement send or a disposed view must close the
 * in-flight summarisation / retrieval socket immediately, not merely ignore its
 * late result. Every transport here is a loopback server; no real account,
 * provider or model is contacted.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class { async classifyResponse() { return { questions: [], planOptions: [], context: '' }; } },
}));
vi.mock('../../src/managers/AgentLoader', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/managers/AgentLoader')>();
  return { ...actual, AgentLoader: class extends actual.AgentLoader {
    constructor(context: ConstructorParameters<typeof actual.AgentLoader>[0]) { super(context, []); }
  } };
});

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { CompactionManager } from '../../src/managers/CompactionManager';
import { SmartCompactor } from '../../src/managers/SmartCompactor';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';
import { HistoryStore, safePanelSegment } from '../../src/services/HistoryStore';
import { OllamaProvider } from '../../src/providers/ollama/OllamaProvider';
import type { DeepMystAuthManager } from '../../src/managers/DeepMystAuthManager';
import type { SavingsLedger } from '../../src/managers/SavingsLedger';
import type { Conversation, Message, StreamChunk, WebviewMessage } from '../../src/types';
import { clearMockConfig, setMockConfig, Uri, workspace } from '../helpers/mockVscode';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';

const MEMORY = '## Goal\n' + 'Keep all current conversation facts intact while compacting old context. '.repeat(20) + '\n';
const PANELS = ['sidebar', 'tab2'] as const;
type Panel = typeof PANELS[number];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([promise.then(() => true as const), late]); } finally { clearTimeout(timer); }
}

interface Held { panel: Panel | 'unknown'; body: string; res: ServerResponse; closed: Promise<void>; aborted: () => boolean }

/** Loopback endpoint that holds every request open until the test answers it. */
async function holdingServer() {
  const held: Held[] = [];
  const arrivals: Array<() => void> = [];
  const sockets = new Set<Socket>();
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
    const body = Buffer.concat(chunks).toString();
    const closed = deferred();
    res.on('close', () => closed.resolve());
    held.push({ panel: body.includes('TAB2-') ? 'tab2' : body.includes('SIDEBAR-') ? 'sidebar' : 'unknown',
      body, res, closed: closed.promise, aborted: () => !res.writableFinished });
    arrivals.splice(0).forEach(wake => wake());
  });
  http.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    held,
    async waitFor(count: number) {
      while (held.length < count) { await new Promise<void>(resolve => arrivals.push(resolve)); }
    },
    close: () => new Promise<void>(resolve => { for (const s of sockets) { s.destroy(); } http.close(() => resolve()); }),
  };
}

function conversation(panel: Panel): Conversation {
  const tag = panel === 'tab2' ? 'TAB2' : 'SIDEBAR';
  const messages: Message[] = Array.from({ length: 8 }, (_, i) => ({
    id: `${tag}-m${i}`, role: i % 2 ? 'assistant' : 'user', content: `${tag}-${i} original`, timestamp: i,
  }));
  return { id: `conv-${panel}`, title: tag, messages, createdAt: 0, updatedAt: 0 } as unknown as Conversation;
}

let root: string;
let oldFolders: unknown;
const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  clearMockConfig();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-compaction-transport-'));
  oldFolders = workspace.workspaceFolders;
  (workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: root }, name: 'isolated', index: 0 }];
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); }
  (workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = oldFolders;
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  clearMockConfig();
});

async function createHost(options: { smart: boolean; endpoint: string }) {
  setMockConfig('compaction.smart.enabled', options.smart);
  setMockConfig('defaultProvider', 'ollama');
  setMockConfig('defaultAgent', 'ollama');
  setMockConfig('ollamaEndpoint', options.endpoint);
  setMockConfig('ollamaRequestTimeout', 60_000);
  const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;
  const extensionContext = {
    globalState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist', extensionUri,
    extension: { packageJSON: { version: '0.0.0' } },
  } as any;
  const conversations = new Map<string, Conversation>(PANELS.map(p => [`conv-${p}`, conversation(p)]));
  conversations.set('conv-other', { id: 'conv-other', messages: [] } as unknown as Conversation);
  const conversationManager = {
    getCurrentConversation: () => null,
    getConversation: (id: string) => conversations.get(id) ?? null,
    getAgentConfig: () => undefined,
    isFirstUserMessage: () => false,
    addMessageToConversation: (_id: string, role: string, content: string) => ({ id: `msg-${Math.random()}`, role, content, timestamp: Date.now() }),
  } as any;

  // The real provider stack, with the Ollama transport pointed at the loopback.
  class FixtureOllama extends OllamaProvider {
    protected buildPromptAsync(content: string) { return Promise.resolve(content); }
  }
  const ollama = new FixtureOllama({ subscriptions: [] } as any);
  const realProviders = new ProviderManager({ subscriptions: [], globalState: extensionContext.globalState } as any);
  (realProviders as any)._registry = { get: (id: string) => id === 'ollama' ? ollama : undefined, getAll: () => [ollama] };
  const cancels: string[] = [];
  const mainSends: string[] = [];
  const providerManager = {
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
    getProvider: () => undefined,
    getProviderInstance: () => ({ capabilities: { supportsImages: true }, getEffectiveModelForSettings: (s: any) => s.model }),
    getModelContextWindow: () => 200000,
    setChannelSystemContext: () => undefined,
    cancelRequest: (panelId: string) => { cancels.push(panelId); realProviders.cancelRequest(panelId); },
    getAllProviderIds: () => ['ollama'],
    clearSessionForProvider: () => undefined,
    disposePersistentProcess: () => undefined,
    dispose: () => undefined,
    sendMessage: (content: string, context: any, settings: any, conv: any, persona: any, panelId?: string) => {
      if (panelId && !panelId.endsWith('-compaction')) {
        mainSends.push(content);
        return (async function* (): AsyncGenerator<StreamChunk> { yield { type: 'text', content: 'MAIN' }; yield { type: 'done' }; })();
      }
      return realProviders.sendMessage(content, context, { ...settings, provider: 'ollama' }, conv, persona, panelId);
    },
  } as any;

  const compactionManager = new CompactionManager(extensionContext);
  const smart = new SmartCompactor(
    { isSignedIn: () => true, hasEntitlement: () => true } as unknown as DeepMystAuthManager,
    new DeepMystGatewayClient(() => 'dm_loopback_fixture_only', () => options.endpoint),
    { record: vi.fn() } as unknown as SavingsLedger,
  );
  compactionManager.setSmartCompactor(smart);

  const noop = {} as any;
  const permissionManager = new PermissionManager('ask-permission');
  const provider = new ChatViewProvider({
    extensionUri, extensionContext, conversationManager, providerManager, compactionManager, permissionManager,
    contextManager: { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined } as any,
    suggestionManager: { generateSuggestions: async () => [] } as any,
    brainstormManager: { cancelSession: () => undefined } as any,
    setupManager: {
      getWizardStatus: async () => ({ anyReady: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
      getWizardStatusCached: () => ({ anyReady: true, complete: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
      ensureProviderStatusFresh: async () => undefined, refreshWizardStatus: async () => ({ anyReady: true }),
      invalidateProviderStatus: () => undefined, onWizardStatusUpdated: () => ({ dispose: () => {} }),
    } as any,
    telemetryManager: noop,
    autonomousManager: { isActive: () => false } as any,
    memoryManager: { learnFromPermissionDecision: () => undefined, getProjectMemoryContent: () => '', recordProjectLearning: () => undefined } as any,
    lifecycleManager: { onLifecycleEvent: () => undefined, touchSession: () => undefined, markBusy: () => undefined, markIdle: () => undefined, registerSession: () => undefined } as any,
    slashCommandManager: noop,
    activeModeManager: { onStatusChanged: () => undefined, onChannelChanged: () => undefined, onActivity: () => undefined,
      subscribeToChannelEvents: () => () => undefined, isConnected: () => false, isInstalled: () => false, isIntegrationEnabled: () => false } as any,
    engagementManager: { trackCustomPersonaCreated: () => undefined, trackCustomSkillCreated: () => undefined, trackMessageSent: () => [], trackSuccessfulResponse: () => undefined } as any,
    projectContextManager: { readRules: () => '', getMystiMdContent: () => '', getCrossVendorInstructions: () => [] } as any,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub() as any,
    checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null } as any,
  });
  const posted: Record<Panel, Array<{ type: string; payload?: any }>> = { sidebar: [], tab2: [] };
  for (const panel of PANELS) {
    (provider as any)._panelStates.set(panel, {
      id: panel, isSidebar: panel === 'sidebar', currentConversationId: `conv-${panel}`,
      webview: { postMessage: (m: WebviewMessage) => { posted[panel].push(m as any); return Promise.resolve(true); } },
    });
  }
  await (provider as any)._agentInitPromise;
  cleanups.push(async () => {
    (provider as any)._canvasLiveness?.dispose();
    provider.dispose(); permissionManager.dispose(); compactionManager.dispose(); ollama.dispose();
    for (const s of extensionContext.subscriptions) { s.dispose(); }
  });
  const p = provider as any;
  return {
    p, conversations, posted, cancels, mainSends,
    manualCompact: (panel: Panel) => p._handleManualCompact(panel) as Promise<void>,
    stop: (panel: Panel) => p._handleMessage({ type: 'cancelRequest', panelId: panel }) as Promise<void>,
    statuses: (panel: Panel) => posted[panel].filter(m => m.type === 'compactionStatus').map(m => m.payload.status),
  };
}

function memoryFile(panel: Panel) { return path.join(root, '.mysti', 'compaction', safePanelSegment(panel), 'memory.md'); }
function gatewayReply(res: ServerResponse, text: string) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
}
function ollamaReply(res: ServerResponse, text: string) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.end(JSON.stringify({ message: { content: text }, done: false }) + '\n' + JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 4 }) + '\n');
}

describe('compaction transport ownership', () => {
  it('Stop closes the smart summary socket immediately while a sibling panel still commits', async () => {
    const server = await holdingServer(); cleanups.push(server.close);
    const h = await createHost({ smart: true, endpoint: server.endpoint });
    const before = JSON.stringify(h.conversations.get('conv-sidebar')!.messages);
    const sidebarRun = h.manualCompact('sidebar'); const tabRun = h.manualCompact('tab2');
    await server.waitFor(2);
    const sidebar = server.held.find(r => r.panel === 'sidebar')!; const tab = server.held.find(r => r.panel === 'tab2')!;
    await h.stop('sidebar');
    expect(await within(sidebar.closed, 1500)).toBe(true);
    expect(sidebar.aborted()).toBe(true);
    expect(await within(tab.closed, 50)).toBe(false);
    gatewayReply(tab.res, MEMORY);
    await Promise.all([sidebarRun, tabRun]);
    expect(JSON.stringify(h.conversations.get('conv-sidebar')!.messages)).toBe(before);
    expect(fs.existsSync(memoryFile('sidebar'))).toBe(false);
    expect(h.statuses('sidebar')).toEqual(['compacting']);
    expect(h.statuses('tab2')).toEqual(['compacting', 'complete']);
    expect(h.conversations.get('conv-tab2')!.messages[0].content).toContain('[Conversation Summary]');
    expect(fs.readFileSync(memoryFile('tab2'), 'utf8')).toContain('## Goal');
  });

  it.each(['conversation switch', 'view dispose', 'replacement send'] as const)('%s closes the smart summary socket', async boundary => {
    const server = await holdingServer(); cleanups.push(server.close);
    const h = await createHost({ smart: true, endpoint: server.endpoint });
    const run = h.manualCompact('sidebar');
    await server.waitFor(1);
    if (boundary === 'conversation switch') {
      await h.p._handleMessage({ type: 'switchConversation', panelId: 'sidebar', payload: { id: 'conv-other' } });
    } else if (boundary === 'view dispose') {
      h.p.dispose();
    } else {
      await h.p._handleSendMessage({ content: 'NEXT', context: [], settings: { provider: 'ollama', model: 'm', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' } }, 'sidebar');
      expect(h.mainSends).toEqual(['NEXT']);
    }
    expect(await within(server.held[0].closed, 1500)).toBe(true);
    expect(server.held[0].aborted()).toBe(true);
    await run;
    expect(fs.existsSync(memoryFile('sidebar'))).toBe(false);
    expect(h.conversations.get('conv-sidebar')!.messages[0].content).toBe('SIDEBAR-0 original');
  });

  it('Stop closes a client-summarize provider request while a sibling panel still commits', async () => {
    const server = await holdingServer(); cleanups.push(server.close);
    const h = await createHost({ smart: false, endpoint: server.endpoint });
    const before = JSON.stringify(h.conversations.get('conv-sidebar')!.messages);
    const sidebarRun = h.manualCompact('sidebar'); const tabRun = h.manualCompact('tab2');
    await server.waitFor(2);
    const sidebar = server.held.find(r => r.panel === 'sidebar')!; const tab = server.held.find(r => r.panel === 'tab2')!;
    await h.stop('sidebar');
    expect(await within(sidebar.closed, 1500)).toBe(true);
    expect(sidebar.aborted()).toBe(true);
    expect(await within(tab.closed, 50)).toBe(false);
    expect(h.cancels).not.toContain('tab2-compaction');
    ollamaReply(tab.res, 'TAB2 SUMMARY');
    await Promise.all([sidebarRun, tabRun]);
    expect(JSON.stringify(h.conversations.get('conv-sidebar')!.messages)).toBe(before);
    expect(h.statuses('sidebar')).toEqual(['compacting']);
    expect(h.statuses('tab2')).toEqual(['compacting', 'complete']);
    expect(h.conversations.get('conv-tab2')!.messages[0].content).toBe('[Conversation Summary]\nTAB2 SUMMARY');
  });

  it('Stop closes in-flight smart retrieval sockets and the stopped send never reaches the provider', async () => {
    const server = await holdingServer(); cleanups.push(server.close);
    const h = await createHost({ smart: true, endpoint: server.endpoint });
    fs.mkdirSync(path.dirname(memoryFile('sidebar')), { recursive: true });
    fs.writeFileSync(memoryFile('sidebar'), MEMORY);
    const history = new HistoryStore(root);
    for (let i = 0; i < 10; i++) {
      await history.append('sidebar', { role: i % 2 ? 'assistant' : 'user', kind: 'text', content: `SIDEBAR-${i} buried detail`, ts: i });
    }
    const run = h.p._handleSendMessage({ content: 'QUESTION', context: [], settings: { provider: 'ollama', model: 'm', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' } }, 'sidebar');
    await server.waitFor(1);
    await h.stop('sidebar');
    expect(await within(Promise.all(server.held.map(r => r.closed)), 1500)).toBe(true);
    expect(server.held.every(r => r.aborted())).toBe(true);
    await run;
    expect(h.mainSends).toEqual([]);
  });
});
