import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BaseCliProvider } from '../../src/providers/base/BaseCliProvider';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { BrainstormManager } from '../../src/managers/BrainstormManager';
import { MystiOrchestratorManager } from '../../src/managers/MystiOrchestratorManager';
import { CoordinatorModelClient } from '../../src/services/CoordinatorModelClient';
import { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';
import type { OpenRouterClient } from '../../src/services/OpenRouterClient';
import type { ContextItem, Mention, Settings } from '../../src/types';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { createHarness, installEditorWindowFixture } from '../helpers/autoContextSendHarness';
import { observeFileHandleReads } from '../helpers/fileHandleReads';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  const deny = () => { throw new Error('Mention route fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

type Route = 'selected' | 'prefix' | 'background' | 'orchestration' | 'fallback' | 'brainstorm';
interface Wire { url: string; body: { messages: Array<{ role: string; content: string }>; stream: boolean; model: string } }
interface Child { panelId: string; providerId: string; prompt: string; context: ContextItem[]; settings: Settings }
const FILE_BYTES = 'export const message = "EW04_ROUTE_SELECTED_雪_مرحبا_🙂";\n';
const OTHER_BYTES = 'EW04_ROUTE_UNSELECTED_FILE\n';
const MODEL = 'openrouter/owned-fixture';
let h: ReturnType<typeof createHarness>, host: any, editors: ReturnType<typeof installEditorWindowFixture>;
let root: string, selected: string, unselected: string, manual: ContextItem;
let workspaceDescriptor: PropertyDescriptor | undefined;
let wires: Wire[], children: Child[], readPaths: string[];
let planNodes: Array<{ id: string; task: string; backend: string; dependsOn: string[] }>;
let releaseRead: (() => void) | undefined;
let backgroundDone: ReturnType<typeof deferred>;
let backgroundJobs: Map<string, any>;
let currentPayload: unknown;
let afterChildText: (content: string) => Promise<void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function wireText(wire: Wire) { return wire.body.messages.map(m => m.content).join('\n'); }
function streamResponse() {
  return new Response('data: {"choices":[{"delta":{"content":"Deterministic route answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function payload(route: Route, withMention = true) {
  const token = '@' + JSON.stringify(selected);
  const prefix = route === 'prefix' ? '@mysti ' : route === 'background' ? 'bg: '
    : route === 'orchestration' || route === 'fallback' ? 'orchestrate ' : '';
  const content = prefix + 'Explain ' + (withMention ? token : 'the attached manual context') + '.';
  const mentions: Mention[] = withMention ? [{ type: 'file', value: selected, displayName: token,
    startIndex: content.indexOf(token), endIndex: content.indexOf(token) + token.length }] : [];
  return { content, context: structuredClone([manual]), mentions,
    settings: { provider: route === 'prefix' ? 'claude-code' : route === 'brainstorm' ? 'brainstorm' : 'mysti',
      model: '', mode: 'quick-plan', accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' } as Settings };
}
async function receive(type: string, value?: unknown) {
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type, payload: value }, 'sidebar', owner.webview);
}
async function send(route: Route, withMention = true) {
  currentPayload = payload(route, withMention);
  await receive(route === 'brainstorm' ? 'sendBrainstormMessage' : 'sendMessage', currentPayload);
  if (route === 'background') await backgroundDone.promise;
}
function assertPrivate() {
  expect(h.persistedCalls.filter(call => call[1] === 'user').map(call => call[3])).toEqual([[manual]]);
  expect(h.contextManager.getContext('sidebar')).toEqual([]);
  expect(JSON.stringify(h.sidebarMessages)).not.toContain('EW04_ROUTE_SELECTED_');
  expect(host._collaborationManager.run).not.toHaveBeenCalled();
  expect(host._runningPanels.has('sidebar')).toBe(false);
}
function assertFileText(text: string) {
  expect(text).toContain(selected); expect(text).toContain(FILE_BYTES);
  expect(text).toContain(manual.content); expect(text).not.toContain(OTHER_BYTES);
}
function assertNoErrors() {
  expect(h.sidebarMessages.filter(m => ['error', 'mystiError', 'jobError', 'brainstormError', 'brainstormAgentError'].includes(m.type))).toEqual([]);
}

beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers();
  setMockConfig('autoContext', false); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  setMockConfig('mysti.memory', false); setMockConfig('brainstorm.agents', ['claude-code', 'openai-codex']);
  setMockConfig('brainstorm.strategy', 'quick'); setMockConfig('brainstorm.synthesisAgent', 'claude-code');
  editors = installEditorWindowFixture();
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'mysti-ew04-routes-')));
  selected = path.join(root, 'sources/ref @claude and @codex note.ts');
  unselected = path.join(root, 'sources/unselected.ts');
  mkdirSync(path.dirname(selected), { recursive: true }); writeFileSync(selected, FILE_BYTES); writeFileSync(unselected, OTHER_BYTES);
  manual = { id: 'manual', type: 'file', path: path.join(root, 'manual.ts'), content: 'EW04_MANUAL_KEEP', enabled: true };
  workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(root), name: 'owned', index: 0 }] });
  wires = []; children = []; readPaths = []; currentPayload = undefined; releaseRead = undefined;
  afterChildText = async () => undefined;
  backgroundDone = deferred(); backgroundJobs = new Map();
  planNodes = [{ id: 'inspect', task: 'inspect the reference', backend: 'claude-code', dependsOn: [] },
    { id: 'explain', task: 'explain the findings', backend: 'openai-codex', dependsOn: ['inspect'] }];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://gateway.v2.deepmyst.com/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)); wires.push({ url: String(url), body });
    if (body.stream) return streamResponse();
    const text = JSON.stringify(body.messages).includes('Decompose the user') ? JSON.stringify({ nodes: planNodes }) : 'Deterministic orchestration synthesis.';
    return Response.json({ choices: [{ message: { content: text } }] });
  }));
  h = createHarness(); host = h.provider as any;
  host._panelStates.get('sidebar').currentConversationId = 'mention-routes';
  const conversation = { id: 'mention-routes', messages: [] };
  h.conversationManager.getConversation = () => conversation;
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), { id: 'claude-code', displayName: 'Owned route fixture',
    capabilities: { supportsImages: false, supportsFileAttachments: false }, _nativeHistoryDeltas: new WeakSet() });
  const backend = (id: string) => ({ id, capabilities: { supportsNativeApproval: false, toolCallsAreProposals: true },
    async *sendMessage(content: string, context: ContextItem[], settings: Settings, conversation: unknown,
      persona: unknown, panelId: string, _manager: unknown, agentConfig: unknown, attachments: unknown,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      if (resolveInput) { const resolved = resolveInput(); if (!resolved) return; ({ content, context } = resolved); }
      const prompt = await builder.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, attachments);
      children.push({ providerId: id, panelId, prompt, context: structuredClone(context), settings: { ...settings } });
      yield { type: 'text', content: `RESULT_${id}` };
      await afterChildText(content);
      yield { type: 'done' };
    },
  });
  const backends = new Map(['claude-code', 'openai-codex'].map(id => [id, backend(id)]));
  const router = Object.assign(Object.create(ProviderManager.prototype), { _registry: { get: (id: string) => backends.get(id) }, _panelProviders: new Map() });
  Object.assign(h.providerManager, {
    sendMessage: ProviderManager.prototype.sendMessage.bind(router),
    sendMessageToProvider: ProviderManager.prototype.sendMessageToProvider.bind(router),
    getAllProviderIds: () => [...backends.keys()], getProviderDefaultModel: () => '',
    getProviderInstance: (id: string) => backends.get(id),
    getProviderStatus: async () => ({ found: true, authenticated: true, path: '/unused' }),
    captureNativeApprovalHandler: () => undefined, setNativeApprovalHandlerForPanel: () => ({ dispose() {} }),
    disposePersistentProcessForProvider: vi.fn(), suspendRequest: () => false, resumeRequest: () => false,
  });
  const catalog = { isConfigured: () => false, cachedModel: () => undefined, listAllModels: async () => [] } as unknown as OpenRouterClient;
  const coordinator = new CoordinatorModelClient(new DeepMystGatewayClient(() => 'dm_owned_fixture', () => 'https://gateway.v2.deepmyst.com'),
    catalog, () => true, () => ({ freeModels: [MODEL], gatewayFallbackModel: '', openRouterModel: 'auto' }));
  host.setMystiCoordinator(coordinator);
  host._brainstormManager = new BrainstormManager(h.extensionContext, h.providerManager);
  host._engagementManager.trackBrainstormCompleted = () => [];
  host._mystiMcpToolset = async () => null;
  host._mystiVisualEnabled = () => ({ look: false, act: false }); host._mystiSkillsEnabled = () => false;
  host._buildMystiProjectBrain = async () => '';
  host._backgroundJobManager = {
    runningCount: () => 0,
    create: (id: string, panelId: string, conversationId: string) => {
      const job = { id, panelId, conversationId, title: 'Owned route job' }; backgroundJobs.set(id, job); return job;
    },
    get: (id: string) => backgroundJobs.get(id), isExecutingHere: () => true,
    markDone: () => { backgroundDone.resolve(); return { delegations: 0 }; },
    markFailed: () => { backgroundDone.resolve(); }, markCancelled: () => { backgroundDone.resolve(); }, dispose() {},
  };
  host._notifyJobDone = () => undefined;
  vi.spyOn(host._collaborationManager, 'run');
  vi.spyOn(host._lifecycleManager, 'markBusy');
  vi.spyOn(host._lifecycleManager, 'markIdle');
  vi.spyOn(h.providerManager, 'cancelRequest');
  observeFileHandleReads(async (file, read) => {
    if (file === selected) readPaths.push(file);
    return read();
  });
});
afterEach(async () => {
  releaseRead?.();
  if (process.env.MYSTI_FILE_MENTION_ROUTE_RECEIPTS) appendFileSync(process.env.MYSTI_FILE_MENTION_ROUTE_RECEIPTS, JSON.stringify({
    test: expect.getState().currentTestName, payload: currentPayload, selected, fileBytes: FILE_BYTES, manual,
    wires, children, readPaths, messages: h.sidebarMessages, persisted: h.persistedCalls,
    collaboratorDispatches: host._collaborationManager.run.mock.calls.length,
  }) + '\n');
  try { host?._brainstormManager.clearSession('sidebar'); await host?._agentInitPromise; h?.dispose(); } finally {
    if (workspaceDescriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceDescriptor);
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners(); rmSync(root, { recursive: true, force: true });
  }
});

describe('EW04 file mentions across Mysti and brainstorm routes', () => {
  it('manual-only Mysti control reaches the actual serialized coordinator boundary', async () => {
    await send('selected', false); assertNoErrors(); expect(wires).toHaveLength(1);
    expect(wireText(wires[0])).toContain(manual.content); expect(wireText(wires[0])).not.toContain(FILE_BYTES);
    expect(readPaths).toEqual([]); expect(children).toEqual([]); assertPrivate();
  });
  for (const route of ['selected', 'prefix', 'background'] as const) {
    it(`${route} Mysti sends exact mentioned bytes without persisting them`, async () => {
      await send(route); assertNoErrors(); expect(wires).toHaveLength(1);
      assertFileText(wireText(wires[0])); expect(readPaths).toEqual([selected]); expect(children).toEqual([]); assertPrivate();
    });
  }
  it('accepted orchestration gives the planner paths and both actual leaves exact referenced bytes', async () => {
    await send('orchestration'); assertNoErrors(); expect(wires).toHaveLength(2);
    expect(wireText(wires[0])).toContain(selected); expect(wireText(wires[0])).not.toContain(FILE_BYTES);
    expect(children).toHaveLength(2); for (const child of children) assertFileText(child.prompt);
    expect(children.map(c => c.providerId)).toEqual(['claude-code', 'openai-codex']);
    expect(readPaths).toEqual([selected]); assertPrivate();
  });
  it('a real single-lane orchestration refusal preserves resolved bytes in inline fallback', async () => {
    planNodes = planNodes.slice(0, 1);
    host._mystiOrchestrator = new MystiOrchestratorManager(host._collaboratorPool, host._mystiCoordinator, h.providerManager,
      () => 3, () => ({ maxLanes: 3, refuseSingleLane: true, verifyParallelLanes: false }));
    await send('fallback'); assertNoErrors(); expect(wires).toHaveLength(2); expect(children).toEqual([]);
    assertFileText(wireText(wires[1])); expect(readPaths).toEqual([selected]); assertPrivate();
  });
  it('brainstorm gives both real analysis children and synthesis the same transient file bytes', async () => {
    await send('brainstorm'); assertNoErrors(); expect(wires).toEqual([]); expect(children).toHaveLength(3);
    for (const child of children) { assertFileText(child.prompt); expect(child.settings.accessLevel).toBe('read-only'); }
    expect(new Set(children.map(c => c.panelId))).toEqual(new Set(['sidebar-brainstorm-claude-code', 'sidebar-brainstorm-openai-codex']));
    expect(readPaths).toEqual([selected]); assertPrivate();
  });
  it('brainstorm children see the earlier chat once, without the message just sent', async () => {
    const conversation = h.conversationManager.getConversation('mention-routes');
    conversation.messages.push({ id: 'e1', role: 'user', content: 'EARLIER_QUESTION', timestamp: 1 },
      { id: 'e2', role: 'assistant', content: 'EARLIER_ANSWER', timestamp: 2 });
    // Persist the way the real ConversationManager does: the sent message joins the chat.
    const persist = h.conversationManager.addMessageToConversation;
    h.conversationManager.addMessageToConversation = vi.fn((...args: any[]) => {
      const message = persist(...args); conversation.messages.push(message); return message;
    });
    await send('brainstorm', false); assertNoErrors();
    const sent = (currentPayload as { content: string }).content;
    for (const panelId of ['sidebar-brainstorm-claude-code', 'sidebar-brainstorm-openai-codex']) {
      const first = children.find(c => c.panelId === panelId)!;
      expect(first.prompt).toContain('EARLIER_QUESTION'); expect(first.prompt).toContain('EARLIER_ANSWER');
      expect(first.prompt.split(sent).length - 1).toBe(1);
    }
  });
  for (const route of ['selected', 'brainstorm'] as const) {
    it(`${route} reports a missing mentioned file instead of silently dropping it`, async () => {
      rmSync(selected); await send(route); assertNoErrors();
      const warnings = h.sidebarMessages.filter(m => m.type === 'mentionWarning');
      expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain(path.basename(selected));
      expect(warnings[0].payload.message).toContain('Could not read');
      expect([...wires.map(wireText), ...children.map(c => c.prompt)].every(text => !text.includes(FILE_BYTES) && text.includes(manual.content))).toBe(true);
      expect(readPaths).toEqual([]); assertPrivate();
    });
  }
  for (const route of ['selected', 'orchestration', 'brainstorm'] as const) {
    for (const action of ['Stop', 'navigation'] as const) {
      it(`${route} ${action} during actual file read prevents stale dispatch and persistence`, async () => {
        const entered = deferred(), wait = deferred(); releaseRead = wait.resolve;
        observeFileHandleReads(async (file, read) => {
          if (file === selected) { readPaths.push(file); entered.resolve(); await wait.promise; }
          return read();
        });
        const pending = send(route);
        try {
          const phase = await Promise.race([entered.promise.then(() => 'read'), pending.then(() => 'finished')]);
          expect(phase, 'the selected file must actually be read before this route can dispatch').toBe('read');
          if (action === 'Stop') await receive('cancelRequest');
          else await receive('switchConversation', { id: 'mention-routes' });
          wait.resolve(); await pending;
          expect(wires).toEqual([]); expect(children).toEqual([]);
          expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
          expect(h.sidebarMessages.filter(m => ['responseComplete', 'brainstormComplete'].includes(m.type))).toEqual([]);
          expect(host._runningPanels.has('sidebar')).toBe(false);
          if (route === 'brainstorm') expect(host._lifecycleManager.markBusy).not.toHaveBeenCalled();
          else expect(host._lifecycleManager.markIdle).toHaveBeenCalledWith('sidebar');
        } finally { wait.resolve(); await pending; }
      });
    }
  }
  it('internal Mysti without automatic metadata releases busy state after navigation during file read', async () => {
    const entered = deferred(), wait = deferred(); releaseRead = wait.resolve;
    observeFileHandleReads(async (file, read) => {
      if (file === selected) { readPaths.push(file); entered.resolve(); await wait.promise; }
      return read();
    });
    currentPayload = payload('selected');
    const pending = host._handleSendMessage(currentPayload, 'sidebar');
    try {
      expect(await Promise.race([entered.promise.then(() => 'read'), pending.then(() => 'finished')])).toBe('read');
      await receive('switchConversation', { id: 'mention-routes' });
      wait.resolve(); await pending;
      expect(wires).toEqual([]); expect(children).toEqual([]);
      expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
      expect(host._lifecycleManager.markIdle).toHaveBeenCalledWith('sidebar');
      expect(host._runningPanels.has('sidebar')).toBe(false);
      expect(h.sidebarMessages.filter(m => m.type === 'requestCancelled')).toHaveLength(1);
    } finally { wait.resolve(); await pending; }
  });
  it('brainstorm Stop during real compaction wait prevents later file reads and dispatch', async () => {
    const entered = deferred(), wait = deferred(); releaseRead = wait.resolve;
    host._panelCompactions.set('sidebar', wait.promise);
    const original = host._waitForPanelCompaction.bind(host);
    vi.spyOn(host, '_waitForPanelCompaction').mockImplementation(async (...args: any[]) => { entered.resolve(); return original(...args); });
    const pending = send('brainstorm');
    try {
      await entered.promise; await receive('cancelRequest'); wait.resolve(); await pending;
      expect(readPaths).toEqual([]); expect(wires).toEqual([]); expect(children).toEqual([]);
      expect(h.persistedCalls).toEqual([]);
      expect(h.sidebarMessages.filter(m => ['brainstormStarted', 'brainstormComplete'].includes(m.type))).toEqual([]);
      expect(host._lifecycleManager.markIdle).toHaveBeenCalledWith('sidebar');
    } finally { wait.resolve(); await pending; host._panelCompactions.delete('sidebar'); }
  });
  for (const disposition of ['resolve', 'reject'] as const) {
    it(`a superseded brainstorm file read may ${disposition} without touching its completed successor`, async () => {
      const entered = deferred(), wait = deferred(); releaseRead = wait.resolve;
      observeFileHandleReads(async (file, read) => {
        if (file === selected) {
          readPaths.push(file); entered.resolve(); await wait.promise;
          if (disposition === 'reject') throw new Error('Owned late read failure');
        }
        return read();
      });
      const disposeChildren = vi.spyOn(host._brainstormManager, 'disposeChildSessions');
      const oldPayload = payload('brainstorm'); currentPayload = oldPayload;
      const pending = receive('sendBrainstormMessage', oldPayload);
      try {
        expect(await Promise.race([entered.promise.then(() => 'read'), pending.then(() => 'finished')])).toBe('read');
        const nextPayload = payload('brainstorm', false); nextPayload.content += ' SUCCESSOR_ONLY';
        await receive('sendBrainstormMessage', nextPayload);
        expect(children).toHaveLength(3); expect(children.every(c => c.prompt.includes(manual.content) && !c.prompt.includes(FILE_BYTES))).toBe(true);
        expect(h.sidebarMessages.filter(m => m.type === 'brainstormComplete')).toHaveLength(1);
        const messages = structuredClone(h.sidebarMessages), persisted = structuredClone(h.persistedCalls);
        const disposeCount = disposeChildren.mock.calls.length;
        wait.resolve(); await pending;
        expect(children).toHaveLength(3); expect(wires).toEqual([]);
        expect(h.sidebarMessages).toEqual(messages); expect(h.persistedCalls).toEqual(persisted);
        expect(disposeChildren).toHaveBeenCalledTimes(disposeCount);
        expect(host._runningPanels.has('sidebar')).toBe(false);
        currentPayload = { oldPayload, nextPayload };
      } finally { wait.resolve(); await pending; }
    });
  }
  it('brainstorm takeover cancels a real held ordinary iterator and releases its running lock', async () => {
    const entered = deferred(), wait = deferred(); releaseRead = wait.resolve;
    afterChildText = async content => { if (content.includes('OLD_ORDINARY')) { entered.resolve(); await wait.promise; } };
    const oldPayload = payload('selected', false); oldPayload.settings.provider = 'claude-code'; oldPayload.content = 'OLD_ORDINARY';
    const pending = receive('sendMessage', oldPayload);
    try {
      expect(await Promise.race([entered.promise.then(() => 'stream'), pending.then(() => 'finished')])).toBe('stream');
      expect(host._runningPanels.has('sidebar')).toBe(true);
      const nextPayload = payload('brainstorm', false); nextPayload.content += ' SUCCESSOR_ONLY';
      await receive('sendBrainstormMessage', nextPayload);
      expect(h.providerManager.cancelRequest).toHaveBeenCalledWith('sidebar');
      expect(host._runningPanels.has('sidebar')).toBe(false);
      expect(host._lifecycleManager.markIdle).toHaveBeenCalledWith('sidebar');
      const messages = structuredClone(h.sidebarMessages), persisted = structuredClone(h.persistedCalls);
      wait.resolve(); await pending;
      expect(h.sidebarMessages).toEqual(messages); expect(h.persistedCalls).toEqual(persisted);
      currentPayload = { oldPayload, nextPayload };
    } finally { wait.resolve(); await pending; }
  });
  it('abandoning pending brainstorm during compaction preserves the active foreground generation', async () => {
    const enteredStream = deferred(), streamWait = deferred(), enteredCompaction = deferred(), compactionWait = deferred();
    releaseRead = () => { streamWait.resolve(); compactionWait.resolve(); };
    afterChildText = async content => { if (content.includes('OLD_FOREGROUND')) { enteredStream.resolve(); await streamWait.promise; } };
    const oldPayload = payload('selected', false); oldPayload.settings.provider = 'claude-code'; oldPayload.content = 'OLD_FOREGROUND';
    const foreground = receive('sendMessage', oldPayload);
    let pending: Promise<void> | undefined;
    try {
      expect(await Promise.race([enteredStream.promise.then(() => 'stream'), foreground.then(() => 'finished')])).toBe('stream');
      const generation = host._mystiRunGen.get('sidebar');
      const cancelCount = h.providerManager.cancelRequest.mock.calls.length;
      host._panelCompactions.set('sidebar', compactionWait.promise);
      const original = host._waitForPanelCompaction.bind(host);
      vi.spyOn(host, '_waitForPanelCompaction').mockImplementation(async (...args: any[]) => { enteredCompaction.resolve(); return original(...args); });
      const abandonedPayload = payload('brainstorm'); pending = receive('sendBrainstormMessage', abandonedPayload);
      await enteredCompaction.promise; await receive('switchConversation', { id: 'mention-routes' });
      compactionWait.resolve(); await pending;
      expect(host._mystiRunGen.get('sidebar')).toBe(generation);
      expect(h.providerManager.cancelRequest).toHaveBeenCalledTimes(cancelCount);
      expect(readPaths).toEqual([]); expect(children).toHaveLength(1);
      expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[2])).toEqual(['OLD_FOREGROUND']);
      expect(h.sidebarMessages.filter(m => m.type === 'brainstormStarted')).toEqual([]);
      expect(host._runningPanels.has('sidebar')).toBe(true);
      streamWait.resolve(); await foreground;
      expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toHaveLength(1);
      expect(h.sidebarMessages.filter(m => m.type === 'responseComplete')).toHaveLength(1);
      expect(host._runningPanels.has('sidebar')).toBe(false);
      currentPayload = { oldPayload, abandonedPayload };
    } finally { releaseRead(); await pending; await foreground; host._panelCompactions.delete('sidebar'); }
  });
  it('only the newest pending brainstorm may take ownership after shared compaction', async () => {
    const bothEntered = deferred(), wait = deferred(); releaseRead = wait.resolve;
    host._panelCompactions.set('sidebar', wait.promise);
    const generation = host._mystiRunGen.get('sidebar') ?? 0;
    const original = host._waitForPanelCompaction.bind(host); let waiting = 0;
    vi.spyOn(host, '_waitForPanelCompaction').mockImplementation(async (...args: any[]) => {
      if (++waiting === 2) bothEntered.resolve(); return original(...args);
    });
    const oldPayload = payload('brainstorm'); const nextPayload = payload('brainstorm', false); nextPayload.content += ' NEWEST_ONLY';
    const old = receive('sendBrainstormMessage', oldPayload), next = receive('sendBrainstormMessage', nextPayload);
    try {
      await bothEntered.promise; wait.resolve(); await Promise.all([old, next]);
      expect(readPaths).toEqual([]); expect(wires).toEqual([]); expect(children).toHaveLength(3);
      expect(host._mystiRunGen.get('sidebar')).toBe(generation + 1);
      expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[2])).toEqual([nextPayload.content]);
      expect(h.sidebarMessages.filter(m => m.type === 'brainstormStarted')).toHaveLength(1);
      expect(h.sidebarMessages.filter(m => m.type === 'brainstormComplete')).toHaveLength(1);
      currentPayload = { oldPayload, nextPayload };
    } finally { wait.resolve(); await Promise.all([old, next]); host._panelCompactions.delete('sidebar'); }
  });
});
