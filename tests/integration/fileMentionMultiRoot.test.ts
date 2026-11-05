import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCliProvider } from '../../src/providers/base/BaseCliProvider';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { BrainstormManager } from '../../src/managers/BrainstormManager';
import { CoordinatorModelClient } from '../../src/services/CoordinatorModelClient';
import { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';
import type { OpenRouterClient } from '../../src/services/OpenRouterClient';
import * as shorthand from '../../src/services/WorkspaceFileShorthand';
import type { ContextItem, Mention, Settings } from '../../src/types';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { createHarness, installEditorWindowFixture } from '../helpers/autoContextSendHarness';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  const deny = () => { throw new Error('Multi-root mention fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

interface Capture { panelId: string; prompt: string; context: ContextItem[] }
interface ReadReceipt { path: string; content: string }
interface OpenReceipt { path: string; reads: number; closes: number; closed: boolean;
  operations: Array<{ requested: number | null; returned: number; eof: boolean; bytesBase64: string }> }
type Route = 'ordinary' | 'mysti' | 'explicit-agent' | 'brainstorm';
const A_BYTES = 'export const rootA = "MULTIROOT_A_雪_🙂";\n';
const B_BYTES = 'export const rootB = "MULTIROOT_B_مرحبا_🙂";\n';
const UNIQUE_BYTES = 'export const unique = "MULTIROOT_ONLY_IN_B";\n';
const originalOpen = fs.open.bind(fs);
const actualResolveShorthand = shorthand.resolveWorkspaceFileShorthand;
let h: ReturnType<typeof createHarness>, host: any, editors: ReturnType<typeof installEditorWindowFixture>;
let owned: string, rootA: string, rootB: string, a: string, b: string, unique: string;
let manual: ContextItem, workspaceDescriptor: PropertyDescriptor | undefined;
let findFilesDescriptor: PropertyDescriptor | undefined;
let workspaceEventDescriptor: PropertyDescriptor | undefined;
let workspaceListeners: Set<(event: vscode.WorkspaceFoldersChangeEvent) => void>;
let captures: Capture[], reads: ReadReceipt[], opens: OpenReceipt[], inputs: unknown[], checkpoints: unknown[];
let queries: Array<{ include: unknown; exclude: unknown; maximum: unknown }>;
let catalogue: string[], readRoots: string[], queryTokens: vscode.CancellationToken[];
let query: () => Promise<vscode.Uri[]>, releaseQuery: (() => void) | undefined;
let wires: Array<{ messages: Array<{ role: string; content: string }> }>;
let payloadOrigin: string;
let roots: string[];

function setRoots(order: 'A-B' | 'B-A' | string[], emit = false) {
  const previous = vscode.workspace.workspaceFolders ?? [];
  roots = Array.isArray(order) ? order : order === 'A-B' ? [rootA, rootB] : [rootB, rootA];
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true,
    value: roots.map((root, index) => ({ uri: vscode.Uri.file(root), name: path.basename(root), index })) });
  if (emit) for (const listener of workspaceListeners) listener({ added: vscode.workspace.workspaceFolders ?? [], removed: previous });
}

function payload(token: string, value: string, route: Route = 'ordinary') {
  // Controlled host input matching the webview's wire shape, not a browser receipt.
  // Typed relative text carries an absolute value selected from its cached files.
  const content = (route === 'explicit-agent' ? '@codex ' : '') + 'Explain ' + token + ' please.';
  const startIndex = content.indexOf(token);
  const mentions: Mention[] = [{ type: 'file', value, displayName: token, startIndex, endIndex: startIndex + token.length }];
  return { content, mentions, context: structuredClone([manual]), settings: {
    provider: route === 'mysti' ? 'mysti' : route === 'brainstorm' ? 'brainstorm' : 'claude-code',
    model: '', mode: 'quick-plan', accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none',
  } as Settings };
}
async function receive(type: string, value?: unknown) {
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type, payload: value }, 'sidebar', owner.webview);
}
async function submit(value: ReturnType<typeof payload>, route: Route = 'ordinary') {
  inputs.push(structuredClone(value));
  await receive(route === 'brainstorm' ? 'sendBrainstormMessage' : 'sendMessage', value);
}
async function send(token: string, value: string, route: Route = 'ordinary') { await submit(payload(token, value, route), route); }
function texts() { return [...captures.map(c => c.prompt), ...wires.map(w => w.messages.map(m => m.content).join('\n'))]; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function snapshot() {
  return structuredClone({ captures, wires, reads, opens, messages: h.sidebarMessages, persisted: h.persistedCalls });
}

function assertSettled(userMessages: number, route: Route = 'ordinary') {
  expect(opens.every(open => open.closed && open.closes === 1), 'every real file handle closes exactly once').toBe(true);
  expect(h.persistedCalls.filter(call => call[1] === 'user').map(call => call[3]))
    .toEqual(Array.from({ length: userMessages }, () => [manual]));
  expect(h.contextManager.getContext('sidebar'), 'file mentions stay transient').toEqual([]);
  expect(host._runningPanels.has('sidebar')).toBe(false);
  expect(host._collaborationManager.run.mock.calls.length).toBe(route === 'explicit-agent' ? userMessages : 0);
  expect(h.sidebarMessages.filter(message => message.type === 'error')).toEqual([]);
}

beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers();
  setMockConfig('autoContext', false); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false); setMockConfig('mysti.memory', false);
  setMockConfig('brainstorm.agents', ['claude-code', 'openai-codex']);
  setMockConfig('brainstorm.strategy', 'quick'); setMockConfig('brainstorm.synthesisAgent', 'claude-code');
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://gateway.v2.deepmyst.com/v1/chat/completions'); expect(init?.method).toBe('POST');
    wires.push(JSON.parse(String(init?.body)));
    return new Response('data: {"choices":[{"delta":{"content":"Deterministic multi-root coordinator answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));
  editors = installEditorWindowFixture();
  owned = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'mysti-ew04-multiroot-')));
  rootA = path.join(owned, 'root-a'); rootB = path.join(owned, 'root-b');
  a = path.join(rootA, 'src/util.ts'); b = path.join(rootB, 'src/util.ts'); unique = path.join(rootB, 'src/only.ts');
  mkdirSync(path.dirname(a), { recursive: true }); mkdirSync(path.dirname(b), { recursive: true });
  writeFileSync(a, A_BYTES); writeFileSync(b, B_BYTES); writeFileSync(unique, UNIQUE_BYTES);
  manual = { id: 'manual', type: 'file', path: path.join(rootA, 'manual.ts'), content: 'MULTIROOT_MANUAL_KEEP', enabled: true };
  workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  findFilesDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'findFiles');
  workspaceEventDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'onDidChangeWorkspaceFolders');
  workspaceListeners = new Set();
  Object.defineProperty(vscode.workspace, 'onDidChangeWorkspaceFolders', { configurable: true,
    value: (listener: (event: vscode.WorkspaceFoldersChangeEvent) => void) => {
      workspaceListeners.add(listener); return { dispose: () => workspaceListeners.delete(listener) };
    } });
  setRoots('A-B'); captures = []; reads = []; opens = []; inputs = []; checkpoints = []; queries = []; wires = [];
  catalogue = [a, b, unique]; readRoots = [owned]; queryTokens = []; releaseQuery = undefined;
  query = async () => catalogue.map(file => vscode.Uri.file(file));
  payloadOrigin = 'controlled-host-fixture-not-browser-generated';
  // Discovery is a controlled complete catalogue; filesystem identities,
  // handle reads, host routing and the final prompt remain production code.
  Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: async (include: unknown, exclude: unknown, maximum: unknown, token: vscode.CancellationToken) => {
    queries.push({ include, exclude, maximum });
    queryTokens.push(token); return query();
  } });
  h = createHarness(); host = h.provider as any;
  host._panelStates.get('sidebar').currentConversationId = 'mention-multiroot';
  h.conversationManager.getConversation = () => ({ id: 'mention-multiroot', messages: [] });
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), {
    id: 'claude-code', displayName: 'Owned multi-root fixture',
    capabilities: { supportsImages: false, supportsFileAttachments: false }, _nativeHistoryDeltas: new WeakSet(),
  });
  const backend = (id: string) => ({ id, capabilities: { supportsNativeApproval: false, toolCallsAreProposals: true },
    async *sendMessage(content: string, context: ContextItem[], settings: Settings, history: unknown,
      persona: unknown, panelId: string, _manager: unknown, agentConfig: unknown, attachments: unknown,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      if (resolveInput) { const resolved = resolveInput(); if (!resolved) return; ({ content, context } = resolved); }
      const prompt = await builder.buildPromptAsync(content, context, history, settings, persona, agentConfig, attachments);
      captures.push({ panelId, prompt, context: structuredClone(context) });
      yield { type: 'text', content: 'Deterministic multi-root answer.' }; yield { type: 'done' };
    },
  });
  const backends = new Map(['claude-code', 'openai-codex'].map(id => [id, backend(id)]));
  const manager = Object.assign(Object.create(ProviderManager.prototype), {
    _registry: { get: (id: string) => backends.get(id) }, _panelProviders: new Map(),
  });
  Object.assign(h.providerManager, {
    sendMessage: ProviderManager.prototype.sendMessage.bind(manager),
    sendMessageToProvider: ProviderManager.prototype.sendMessageToProvider.bind(manager),
    getAllProviderIds: () => [...backends.keys()], getProviderDefaultModel: () => '',
    getProviderInstance: (id: string) => backends.get(id),
    getProviderStatus: async () => ({ found: true, authenticated: true, path: '/unused' }),
    captureNativeApprovalHandler: () => undefined, setNativeApprovalHandlerForPanel: () => ({ dispose() {} }),
    disposePersistentProcessForProvider: vi.fn(), suspendRequest: () => false, resumeRequest: () => false,
  });
  const modelCatalogue = { isConfigured: () => false, cachedModel: () => undefined, listAllModels: async () => [] } as unknown as OpenRouterClient;
  host.setMystiCoordinator(new CoordinatorModelClient(new DeepMystGatewayClient(() => 'dm_owned_fixture', () => 'https://gateway.v2.deepmyst.com'),
    modelCatalogue, () => true, () => ({ freeModels: ['openrouter/owned-fixture'], gatewayFallbackModel: '', openRouterModel: 'auto' })));
  host._brainstormManager = new BrainstormManager(h.extensionContext, h.providerManager);
  host._engagementManager.trackBrainstormCompleted = () => [];
  host._mystiMcpToolset = async () => null; host._mystiVisualEnabled = () => ({ look: false, act: false });
  host._mystiSkillsEnabled = () => false; host._buildMystiProjectBrain = async () => '';
  vi.spyOn(host._collaborationManager, 'run');
  vi.spyOn(fs, 'open').mockImplementation((async (file: any, ...args: any[]) => {
    const handle = await (originalOpen as any)(file, ...args);
    if (!readRoots.some(root => String(file).startsWith(root + path.sep))) return handle;
    const record: OpenReceipt = { path: String(file), reads: 0, closes: 0, closed: false, operations: [] }; opens.push(record);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    const chunks: Buffer[] = [];
    let contentReceipt: ReadReceipt | undefined;
    vi.spyOn(handle, 'read').mockImplementation(async (...options: any[]) => {
      const result = await read(...options);
      const offset = typeof options[1] === 'number' ? options[1] : options[0]?.offset ?? 0;
      const bytes = Buffer.from(new Uint8Array(result.buffer.buffer, result.buffer.byteOffset + offset, result.bytesRead));
      record.operations.push({ requested: typeof options[2] === 'number' ? options[2] : options[0]?.length ?? null,
        returned: result.bytesRead, eof: result.bytesRead === 0, bytesBase64: bytes.toString('base64') });
      if (result.bytesRead) {
        record.reads++; chunks.push(bytes);
        if (!contentReceipt) { contentReceipt = { path: String(file), content: '' }; reads.push(contentReceipt); }
        contentReceipt.content = Buffer.concat(chunks).toString('utf8');
      }
      return result;
    });
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      record.closes++; const result = await close(); record.closed = true; return result;
    });
    return handle;
  }) as any);
});

afterEach(async () => {
  releaseQuery?.();
  const evidence = process.env.MYSTI_FILE_MENTION_MULTIROOT_RECEIPTS;
  if (evidence) appendFileSync(evidence, JSON.stringify({
    test: expect.getState().currentTestName, payloadOrigin,
    roots, files: [{ path: a, content: A_BYTES }, { path: b, content: B_BYTES }, { path: unique, content: UNIQUE_BYTES }],
    discoveryOrigin: 'controlled-complete-catalogue-real-owned-files', catalogue, queries,
    queryCancellationRequested: queryTokens.map(token => token.isCancellationRequested), workspaceListenerCount: workspaceListeners.size,
    manual, inputs, checkpoints, ...snapshot(), collaboratorDispatches: host._collaborationManager.run.mock.calls.length,
  }) + '\n');
  try {
    try { expect(workspaceListeners.size, 'workspace query listeners are released after every turn').toBe(0); }
    finally { host?._brainstormManager.clearSession('sidebar'); await host?._agentInitPromise; h?.dispose(); }
  } finally {
    if (workspaceDescriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceDescriptor);
    if (findFilesDescriptor) Object.defineProperty(vscode.workspace, 'findFiles', findFilesDescriptor);
    else Reflect.deleteProperty(vscode.workspace, 'findFiles');
    if (workspaceEventDescriptor) Object.defineProperty(vscode.workspace, 'onDidChangeWorkspaceFolders', workspaceEventDescriptor);
    else Reflect.deleteProperty(vscode.workspace, 'onDidChangeWorkspaceFolders');
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners(); rmSync(owned, { recursive: true, force: true });
  }
});

describe('EW04 multi-root file identity at the bound host dispatch', () => {
  for (const order of ['A-B', 'B-A'] as const) {
    it(`keeps explicitly selected absolute B despite duplicate relative paths and root order ${order}`, async () => {
      setRoots(order); await send('@' + JSON.stringify(b), b);
      expect(reads).toEqual([{ path: b, content: B_BYTES }]); expect(captures).toHaveLength(1);
      expect(captures[0].context.map(item => [item.path, item.content])).toEqual([[manual.path, manual.content], [b, B_BYTES]]);
      expect(captures[0].prompt).toContain(b); expect(captures[0].prompt).toContain(B_BYTES);
      expect(captures[0].prompt).not.toContain(A_BYTES);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toEqual([]);
      assertSettled(1);
    });

    it(`resolves typed unique-root-two text carrying absolute metadata in root order ${order}`, async () => {
      setRoots(order); await send('@src/only.ts', unique);
      expect(reads).toEqual([{ path: unique, content: UNIQUE_BYTES }]); expect(captures).toHaveLength(1);
      expect(captures[0].context.map(item => [item.path, item.content])).toEqual([[manual.path, manual.content], [unique, UNIQUE_BYTES]]);
      expect(captures[0].prompt).toContain(unique); expect(captures[0].prompt).toContain(UNIQUE_BYTES);
      expect(captures[0].prompt).not.toContain(A_BYTES); expect(captures[0].prompt).not.toContain(B_BYTES);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toEqual([]);
      assertSettled(1);
    });

    for (const claimed of ['A', 'B'] as const) {
      it(`warns without ambiguous bytes for stale relative metadata ${claimed} in root order ${order}, then recovers`, async () => {
        setRoots(order); await send('@src/util.ts', claimed === 'A' ? a : b);
        const first = snapshot(); checkpoints.push({ phase: 'ambiguous-relative-reference', ...first });
        // Run recovery before assertions so failed red evidence also retains it.
        await send('@' + JSON.stringify(b), b);
        expect(first.reads, 'a stale cache choice cannot authorize ambiguous file bytes').toEqual([]);
        expect(first.captures).toHaveLength(1);
        expect(first.captures[0].context).toEqual([manual]);
        expect(first.captures[0].prompt).toContain(manual.content);
        expect(first.captures[0].prompt).not.toContain(A_BYTES); expect(first.captures[0].prompt).not.toContain(B_BYTES);
        const warnings = first.messages.filter(message => message.type === 'mentionWarning');
        expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toMatch(/file|reference|ambig|match/i);
        expect(captures).toHaveLength(2); expect(captures[1].context.map(item => [item.path, item.content]))
          .toEqual([[manual.path, manual.content], [b, B_BYTES]]);
        expect(captures[1].prompt).toContain(B_BYTES); expect(captures[1].prompt).not.toContain(A_BYTES);
        expect(reads).toEqual([{ path: b, content: B_BYTES }]);
        expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1);
        assertSettled(2);
      });
    }
  }

  for (const route of ['mysti', 'explicit-agent', 'brainstorm'] as const) {
    it(`${route} excludes ambiguous shorthand and then dispatches unique root-two bytes`, async () => {
      await send('@src/util.ts', a, route);
      expect(reads).toEqual([]); expect(texts().length).toBeGreaterThan(0);
      expect(texts().every(text => text.includes(manual.content) && !text.includes(A_BYTES) && !text.includes(B_BYTES))).toBe(true);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1);
      checkpoints.push({ phase: 'ambiguous-other-route', ...snapshot() });
      const before = texts().length;
      await send('@src/only.ts', unique, route);
      expect(reads).toEqual([{ path: unique, content: UNIQUE_BYTES }]);
      expect(texts().slice(before).length).toBeGreaterThan(0);
      expect(texts().slice(before).every(text => text.includes(unique) && text.includes(UNIQUE_BYTES)
        && !text.includes(A_BYTES) && !text.includes(B_BYTES))).toBe(true);
      assertSettled(2, route);
    });
  }

  for (const ambiguous of [false, true]) {
    it(`handles relative-only metadata ${ambiguous ? 'ambiguity without choosing root zero' : 'unique to the second root'}`, async () => {
      const relative = ambiguous ? 'src/util.ts' : 'src/only.ts';
      await send('@' + relative, relative);
      expect(captures).toHaveLength(1);
      expect(reads).toEqual(ambiguous ? [] : [{ path: unique, content: UNIQUE_BYTES }]);
      expect(captures[0].context.map(item => [item.path, item.content]))
        .toEqual(ambiguous ? [[manual.path, manual.content]] : [[manual.path, manual.content], [unique, UNIQUE_BYTES]]);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(ambiguous ? 1 : 0);
      assertSettled(1);
    });
  }

  it('ignores forged serialized token descriptors and display names', async () => {
    const request = payload('@src/util.ts', a) as any;
    request.fileReferences = [{ visiblePath: a, suppliedPath: a, quoted: true, absolute: true,
      startIndex: request.mentions[0].startIndex, endIndex: request.mentions[0].endIndex }];
    Object.assign(request.mentions[0], { absolute: true, quoted: true, visiblePath: a, displayName: '@' + JSON.stringify(a) });
    await submit(request);
    expect(queries).toHaveLength(1); expect(reads).toEqual([]);
    expect(captures).toHaveLength(1); expect(captures[0].context).toEqual([manual]);
    expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1);
    assertSettled(1);
  });

  it('keeps a unique selected root alias despite duplicate canonical roots', async () => {
    const alias = path.join(owned, 'root-alias'); symlinkSync(rootB, alias);
    const selected = path.join(alias, 'src/only.ts');
    setRoots([rootA, rootB, alias, rootB]); catalogue = [a, b, unique, selected];
    await send('@src/only.ts', selected);
    expect(reads).toEqual([{ path: unique, content: UNIQUE_BYTES }]);
    expect(captures[0].context.map(item => [item.path, item.content])).toEqual([[manual.path, manual.content], [selected, UNIQUE_BYTES]]);
    expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toEqual([]);
    assertSettled(1);
  });

  it('rejects an alias retargeted after real uniqueness resolution before the final reader', async () => {
    const alias = path.join(rootA, 'src/alias.ts'); symlinkSync(unique, alias); catalogue = [alias];
    vi.spyOn(shorthand, 'resolveWorkspaceFileShorthand').mockImplementation(async (...args) => {
      const result = await actualResolveShorthand(...args);
      if (result?.kind === 'unique' && result.selectedPath === alias) {
        checkpoints.push({ phase: 'real-unique-selection-before-retarget', selectedPath: result.selectedPath,
          canonicalPath: result.expected.canonicalPath, dev: String(result.expected.dev), ino: String(result.expected.ino) });
        unlinkSync(alias); symlinkSync(b, alias);
      }
      return result;
    });
    await send('@src/alias.ts', alias);
    expect(checkpoints).toHaveLength(1); expect(reads).toEqual([]); expect(opens).toEqual([]);
    expect(captures[0].context).toEqual([manual]);
    expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1);
    await send('@' + JSON.stringify(b), b);
    expect(reads).toEqual([{ path: b, content: B_BYTES }]);
    expect(captures[1].prompt).toContain(B_BYTES); assertSettled(2);
  });

  for (const action of ['Stop', 'navigation', 'workspace replacement'] as const) {
    it(`${action} during a held catalogue query ignores its late result and permits recovery`, async () => {
      const entered = deferred<void>(), held = deferred<vscode.Uri[]>();
      releaseQuery = () => held.resolve(catalogue.map(file => vscode.Uri.file(file)));
      query = () => { entered.resolve(); return held.promise; };
      const pending = send('@src/only.ts', unique);
      try {
        expect(await Promise.race([entered.promise.then(() => 'query'), pending.then(() => 'finished')])).toBe('query');
        if (action === 'Stop') await receive('cancelRequest');
        else if (action === 'navigation') await receive('switchConversation', { id: 'mention-multiroot' });
        else setRoots([rootA], true);
        await vi.advanceTimersByTimeAsync(25); await pending;
        expect(queryTokens[0].isCancellationRequested).toBe(true); expect(reads).toEqual([]); expect(opens).toEqual([]);
        if (action === 'workspace replacement') {
          expect(captures).toHaveLength(1); expect(captures[0].context).toEqual([manual]);
          expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1);
        } else {
          expect(texts()).toEqual([]);
          expect(h.persistedCalls.filter(call => call[1] === 'assistant')).toEqual([]);
          expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toEqual([]);
        }
        expect(host._runningPanels.has('sidebar')).toBe(false);
        const beforeLate = snapshot(); checkpoints.push({ phase: 'cancelled-query-before-late-result', ...beforeLate });
        releaseQuery(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(25);
        expect(snapshot()).toEqual(beforeLate);
        query = async () => catalogue.map(file => vscode.Uri.file(file)); setRoots('A-B');
        const prior = captures.length; await send('@' + JSON.stringify(b), b);
        expect(captures).toHaveLength(prior + 1); expect(captures[prior].prompt).toContain(B_BYTES);
        expect(reads).toEqual([{ path: b, content: B_BYTES }]); expect(host._runningPanels.has('sidebar')).toBe(false);
        expect(opens.every(open => open.closed && open.closes === 1)).toBe(true);
      } finally { releaseQuery(); await pending; }
    });
  }

  it('revokes a catalogue query when workspace change events restore the original list before the next poll', async () => {
    const entered = deferred<void>(), held = deferred<vscode.Uri[]>(); releaseQuery = () => held.resolve([vscode.Uri.file(a)]);
    query = () => { entered.resolve(); return held.promise; };
    const pending = send('@src/util.ts', a);
    try {
      expect(await Promise.race([entered.promise.then(() => 'query'), pending.then(() => 'finished')])).toBe('query');
      setRoots([rootA], true); setRoots('A-B', true);
      checkpoints.push({ phase: 'workspace-change-and-restore-before-poll', registeredListeners: workspaceListeners.size, roots: [...roots] });
      expect(workspaceListeners.size, 'the live resolver observes workspace change events').toBeGreaterThan(0);
      // This reply represents the intermediate single-root catalogue, not the restored workspace.
      releaseQuery(); await pending;
      expect(reads, 'an observed workspace event must revoke the in-flight catalogue even if the array is restored').toEqual([]);
      expect(captures).toHaveLength(1); expect(captures[0].context).toEqual([manual]);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1);
      assertSettled(1);
    } finally { releaseQuery(); await pending; }
  });

  for (const caseId of ['multiroot-stale-cache-shorthand', 'multiroot-unique-second-root', 'multiroot-explicit-second-root']) {
    it(`replays ${caseId} through the host with exact payload bytes`, async () => {
      const receipts = process.env.MYSTI_MULTIROOT_BROWSER_RECEIPTS;
      let request: ReturnType<typeof payload>;
      const stale = caseId === 'multiroot-stale-cache-shorthand';
      let expectedFile = caseId === 'multiroot-unique-second-root' ? unique : b;
      let expectedBytes = caseId === 'multiroot-unique-second-root' ? UNIQUE_BYTES : B_BYTES;
      if (receipts) {
        const row = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(item => item.caseId === caseId);
        expect(row?.payload).toBeDefined(); request = structuredClone(row.payload);
        setRoots(row.declaredWorkspaceRoots); readRoots.push(...roots.map(root => realpathSync.native(root)));
        const files = row.files.filter((file: { path: string }) => roots.some(root => file.path.startsWith(root + path.sep)));
        for (const file of files) expect(readFileSync(file.path, 'utf8')).toBe(file.content);
        catalogue = files.map((file: { path: string }) => file.path);
        expectedFile = request.mentions[0].value; expectedBytes = files.find((file: { path: string }) => file.path === expectedFile).content;
        payloadOrigin = 'actual-retained-browser-payload-unmodified';
        checkpoints.push({ phase: 'actual-browser-input', receiptFile: receipts, caseId, payload: structuredClone(row.payload), files });
      } else {
        request = stale ? payload('@src/util.ts', a) : caseId === 'multiroot-unique-second-root'
          ? payload('@src/only.ts', unique) : payload('@' + JSON.stringify(b), b);
        request.context = []; payloadOrigin = 'controlled-host-fallback-no-browser-replay-claim';
      }
      const before = structuredClone(request); await submit(request); expect(request).toEqual(before);
      expect(inputs[0]).toEqual(before); expect(captures).toHaveLength(1);
      expect(reads).toEqual(stale ? [] : [{ path: realpathSync.native(expectedFile), content: expectedBytes }]);
      expect(captures[0].context.map(item => [item.path, item.content])).toEqual(stale ? [] : [[expectedFile, expectedBytes]]);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(stale ? 1 : 0);
      expect(h.persistedCalls.filter(call => call[1] === 'user').map(call => call[3])).toEqual([[]]);
      expect(host._runningPanels.has('sidebar')).toBe(false);
      expect(opens.every(open => open.closed && open.closes === 1)).toBe(true);
    });
  }
});
