import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, promises as fs } from 'node:fs';
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
  const deny = () => { throw new Error('File mention containment fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

interface Capture { panelId: string; providerId: string; prompt: string; context: ContextItem[] }
type Route = 'ordinary' | 'mysti' | 'explicit-agent' | 'brainstorm';
interface OpenReceipt { path: string; flags: unknown; reads: number; stats: number; closes: number; closed: boolean;
  operations: Array<{ requested: number | null; returned: number; eof: boolean; bytesBase64: string }> }
const INSIDE_BYTES = 'export const selected = "CONTAINED_WORKSPACE_雪_🙂";\n';
const SECOND_BYTES = 'SECOND_INDEPENDENT_WORKSPACE_FILE\n';
const DECLARED_BYTES = 'SECOND_DECLARED_ROOT_FILE\n';
const OUTSIDE_BYTES = 'OWNED_OUTSIDE_BYTES_MUST_NOT_REACH_CONTEXT\n';
const originalRead = fs.readFile.bind(fs);
const originalOpen = fs.open.bind(fs);
let h: ReturnType<typeof createHarness>, host: any, editors: ReturnType<typeof installEditorWindowFixture>;
let owned: string, workspace: string, outside: string, insideFile: string, outsideFile: string, escapedLink: string;
let secondFile: string, secondRoot: string, declaredFile: string, siblingFile: string, parentLink: string, insideLink: string, rootAlias: string, crossRootLink: string;
let manual: ContextItem, workspaceDescriptor: PropertyDescriptor | undefined;
let captures: Capture[], reads: Array<{ path: string; content: string; via: string }>, currentPayload: unknown;
let wires: Array<{ messages: Array<{ role: string; content: string }> }>, opens: OpenReceipt[], inputs: unknown[], checkpoints: unknown[];
let beforeOpen: (file: string) => Promise<void>, beforeHandleStat: (file: string) => Promise<void>;
let afterHandleRead: (file: string) => Promise<void>;
let releaseWait: (() => void) | undefined;

function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function setRoots(roots: string[]) {
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true,
    value: roots.map((root, index) => ({ uri: vscode.Uri.file(root), name: 'owned-' + index, index })) });
}

function payload(file: string | string[], route: Route = 'ordinary') {
  let content = (route === 'explicit-agent' ? '@codex ' : '') + 'Explain ';
  const mentions: Mention[] = (Array.isArray(file) ? file : [file]).map(value => {
    const token = '@' + JSON.stringify(value), startIndex = content.length; content += token + ' ';
    return { type: 'file', value, displayName: token, startIndex, endIndex: startIndex + token.length };
  });
  content += 'please.';
  return { content, mentions, context: structuredClone([manual]), settings: {
    provider: route === 'mysti' ? 'mysti' : route === 'brainstorm' ? 'brainstorm' : 'claude-code',
    model: '', mode: 'quick-plan', accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none',
  } as Settings };
}
async function receive(type: string, value?: unknown) {
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type, payload: value }, 'sidebar', owner.webview);
}
async function send(file: string | string[], route: Route = 'ordinary') {
  currentPayload = payload(file, route); inputs.push(structuredClone(currentPayload));
  await receive(route === 'brainstorm' ? 'sendBrainstormMessage' : 'sendMessage', currentPayload);
}
function texts() { return [...captures.map(c => c.prompt), ...wires.map(w => w.messages.map(m => m.content).join('\n'))]; }
function assertNoOutside() {
  expect(reads.some(read => read.content.includes(OUTSIDE_BYTES)), 'outside bytes must not be read').toBe(false);
  expect(texts().some(text => text.includes(OUTSIDE_BYTES)), 'outside bytes must not reach dispatch').toBe(false);
}
function assertClosed() {
  expect(opens.every(open => open.closed && open.closes === 1), 'all real opened handles must close exactly once').toBe(true);
}
function assertValidParts(route: Route, expected: Array<[string, string]>, userMessages = 1) {
  const finalTexts = texts(); expect(finalTexts.length).toBeGreaterThan(0);
  for (const text of finalTexts) {
    expect(text).toContain(manual.content);
    for (const [file, bytes] of expected) { expect(text).toContain(file); expect(text).toContain(bytes); }
  }
  // Explicit collaboration folds the shared context into its final brief;
  // ordinary/brainstorm providers receive the separate context array too.
  for (const capture of captures) expect(capture.context.map(item => [item.path, item.content]))
    .toEqual(route === 'explicit-agent' ? [] : [[manual.path, manual.content], ...expected]);
  expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[3])).toEqual(Array.from({ length: userMessages }, () => [manual]));
  expect(host._runningPanels.has('sidebar')).toBe(false);
  expect(h.sidebarMessages.filter(m => ['error', 'mystiError', 'brainstormError', 'brainstormAgentError'].includes(m.type))).toEqual([]);
  expect(host._collaborationManager.run.mock.calls.length).toBe(route === 'explicit-agent' ? userMessages : 0);
  assertNoOutside(); assertClosed();
}

beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers();
  setMockConfig('autoContext', false); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  setMockConfig('mysti.memory', false); setMockConfig('brainstorm.agents', ['claude-code', 'openai-codex']);
  setMockConfig('brainstorm.strategy', 'quick'); setMockConfig('brainstorm.synthesisAgent', 'claude-code');
  editors = installEditorWindowFixture();
  owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mysti-ew04-containment-')));
  workspace = path.join(owned, 'workspace'); outside = path.join(owned, 'outside');
  secondRoot = path.join(owned, 'second-root');
  mkdirSync(workspace); mkdirSync(outside); mkdirSync(secondRoot); mkdirSync(workspace + '-sibling');
  insideFile = path.join(workspace, 'selected.ts'); outsideFile = path.join(outside, 'outside.ts');
  secondFile = path.join(workspace, 'second.ts'); declaredFile = path.join(secondRoot, 'declared.ts');
  siblingFile = path.join(workspace + '-sibling', 'outside.ts');
  escapedLink = path.join(workspace, 'linked.ts'); parentLink = path.join(workspace, 'outside-parent');
  insideLink = path.join(workspace, 'inside-link.ts'); rootAlias = path.join(owned, 'linked-workspace'); crossRootLink = path.join(workspace, 'cross-root.ts');
  writeFileSync(insideFile, INSIDE_BYTES); writeFileSync(secondFile, SECOND_BYTES); writeFileSync(declaredFile, DECLARED_BYTES);
  writeFileSync(outsideFile, OUTSIDE_BYTES); writeFileSync(siblingFile, OUTSIDE_BYTES);
  symlinkSync(outsideFile, escapedLink); symlinkSync(outside, parentLink); symlinkSync(insideFile, insideLink);
  symlinkSync(workspace, rootAlias); symlinkSync(declaredFile, crossRootLink);
  manual = { id: 'manual', type: 'file', path: path.join(workspace, 'manual.ts'), content: 'CONTAINMENT_MANUAL_KEEP', enabled: true };
  workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  setRoots([workspace]);
  captures = []; reads = []; wires = []; opens = []; inputs = []; checkpoints = []; currentPayload = undefined;
  beforeOpen = async () => undefined; beforeHandleStat = async () => undefined; afterHandleRead = async () => undefined; releaseWait = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://gateway.v2.deepmyst.com/v1/chat/completions'); expect(init?.method).toBe('POST');
    wires.push(JSON.parse(String(init?.body)));
    return new Response('data: {"choices":[{"delta":{"content":"Deterministic contained coordinator answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));
  h = createHarness(); host = h.provider as any;
  host._panelStates.get('sidebar').currentConversationId = 'mention-containment';
  const conversation = { id: 'mention-containment', messages: [] }; h.conversationManager.getConversation = () => conversation;
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), { id: 'claude-code', displayName: 'Owned containment fixture',
    capabilities: { supportsImages: false, supportsFileAttachments: false }, _nativeHistoryDeltas: new WeakSet() });
  const backend = (id: string) => ({ id, capabilities: { supportsNativeApproval: false, toolCallsAreProposals: true },
    async *sendMessage(content: string, context: ContextItem[], settings: Settings, history: unknown,
      persona: unknown, panelId: string, _manager: unknown, agentConfig: unknown, attachments: unknown,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      if (resolveInput) { const resolved = resolveInput(); if (!resolved) return; ({ content, context } = resolved); }
      const prompt = await builder.buildPromptAsync(content, context, history, settings, persona, agentConfig, attachments);
      captures.push({ providerId: id, panelId, prompt, context: structuredClone(context) });
      yield { type: 'text', content: 'Deterministic contained-file answer.' }; yield { type: 'done' };
    },
  });
  const backends = new Map(['claude-code', 'openai-codex'].map(id => [id, backend(id)]));
  const manager = Object.assign(Object.create(ProviderManager.prototype), { _registry: { get: (id: string) => backends.get(id) }, _panelProviders: new Map() });
  Object.assign(h.providerManager, {
    sendMessage: ProviderManager.prototype.sendMessage.bind(manager), sendMessageToProvider: ProviderManager.prototype.sendMessageToProvider.bind(manager),
    getAllProviderIds: () => [...backends.keys()], getProviderDefaultModel: () => '', getProviderInstance: (id: string) => backends.get(id),
    getProviderStatus: async () => ({ found: true, authenticated: true, path: '/unused' }),
    captureNativeApprovalHandler: () => undefined, setNativeApprovalHandlerForPanel: () => ({ dispose() {} }),
    disposePersistentProcessForProvider: vi.fn(), suspendRequest: () => false, resumeRequest: () => false,
  });
  const catalog = { isConfigured: () => false, cachedModel: () => undefined, listAllModels: async () => [] } as unknown as OpenRouterClient;
  host.setMystiCoordinator(new CoordinatorModelClient(new DeepMystGatewayClient(() => 'dm_owned_fixture', () => 'https://gateway.v2.deepmyst.com'),
    catalog, () => true, () => ({ freeModels: ['openrouter/owned-fixture'], gatewayFallbackModel: '', openRouterModel: 'auto' })));
  host._brainstormManager = new BrainstormManager(h.extensionContext, h.providerManager);
  host._engagementManager.trackBrainstormCompleted = () => [];
  host._mystiMcpToolset = async () => null; host._mystiVisualEnabled = () => ({ look: false, act: false });
  host._mystiSkillsEnabled = () => false; host._buildMystiProjectBrain = async () => '';
  vi.spyOn(host._collaborationManager, 'run');
  vi.spyOn(host._lifecycleManager, 'markIdle');
  vi.spyOn(fs, 'readFile').mockImplementation((async (file: any, ...args: any[]) => {
    const result = await (originalRead as any)(file, ...args);
    if (String(file).startsWith(owned + path.sep)) reads.push({ path: String(file), content: String(result), via: 'readFile' });
    return result;
  }) as any);
  vi.spyOn(fs, 'open').mockImplementation((async (file: any, ...args: any[]) => {
    if (!String(file).startsWith(owned + path.sep)) return (originalOpen as any)(file, ...args);
    await beforeOpen(String(file));
    const handle = await (originalOpen as any)(file, ...args);
    const record: OpenReceipt = { path: String(file), flags: args[0], reads: 0, stats: 0, closes: 0, closed: false, operations: [] }; opens.push(record);
    const read = handle.read.bind(handle), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
    const chunks: Buffer[] = [];
    let contentReceipt: { path: string; content: string; via: string } | undefined;
    vi.spyOn(handle, 'stat').mockImplementation(async (...options: any[]) => {
      record.stats++; await beforeHandleStat(String(file)); return stat(...options);
    });
    vi.spyOn(handle, 'read').mockImplementation(async (...options: any[]) => {
      const result = await read(...options);
      const offset = typeof options[1] === 'number' ? options[1] : options[0]?.offset ?? 0;
      const bytes = Buffer.from(new Uint8Array(result.buffer.buffer, result.buffer.byteOffset + offset, result.bytesRead));
      record.operations.push({ requested: typeof options[2] === 'number' ? options[2] : options[0]?.length ?? null,
        returned: result.bytesRead, eof: result.bytesRead === 0, bytesBase64: bytes.toString('base64') });
      if (result.bytesRead) {
        record.reads++; chunks.push(bytes);
        if (!contentReceipt) { contentReceipt = { path: String(file), content: '', via: 'handle.read' }; reads.push(contentReceipt); }
        contentReceipt.content = Buffer.concat(chunks).toString('utf8');
        await afterHandleRead(String(file));
      }
      return result;
    });
    vi.spyOn(handle, 'close').mockImplementation(async () => { record.closes++; const result = await close(); record.closed = true; return result; });
    return handle;
  }) as any);
});
afterEach(() => {
  releaseWait?.();
  if (process.env.MYSTI_FILE_MENTION_CONTAINMENT_RECEIPTS) appendFileSync(process.env.MYSTI_FILE_MENTION_CONTAINMENT_RECEIPTS, JSON.stringify({
    test: expect.getState().currentTestName, inputPayload: currentPayload, workspace, outside, insideFile, outsideFile, escapedLink,
    insideBytes: INSIDE_BYTES, outsideBytes: OUTSIDE_BYTES, manual, reads, captures, wires, opens, inputs, checkpoints,
    messages: h.sidebarMessages, persisted: h.persistedCalls, collaboratorDispatches: host._collaborationManager.run.mock.calls.length,
    idleCalls: host._lifecycleManager.markIdle.mock.calls,
  }) + '\n');
  try { host?._brainstormManager.clearSession('sidebar'); h?.dispose(); } finally {
    if (workspaceDescriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceDescriptor);
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners(); rmSync(owned, { recursive: true, force: true });
  }
});

describe('EW04 physical workspace containment at the final file-mention boundary', () => {
  it('a valid owned workspace file reaches the actual final provider prompt', async () => {
    await send(insideFile);
    expect(reads).toEqual([{ path: insideFile, content: INSIDE_BYTES, via: 'handle.read' }]);
    expect(captures).toHaveLength(1); expect(captures[0].prompt).toContain(INSIDE_BYTES);
    expect(captures[0].prompt).not.toContain(OUTSIDE_BYTES);
    expect(captures[0].context.map(item => [item.path, item.content])).toEqual([[manual.path, manual.content], [insideFile, INSIDE_BYTES]]);
    expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[3])).toEqual([[manual]]);
    expect(h.sidebarMessages.filter(m => m.type === 'error' || m.type === 'mentionWarning')).toEqual([]);
    expect(host._collaborationManager.run).not.toHaveBeenCalled();
    expect(opens).toHaveLength(1); assertClosed();
  });
  it('an in-workspace symlink must not read or serialize bytes from an owned outside file', async () => {
    await send(escapedLink);
    expect(reads.map(read => read.content), 'physical outside bytes must not be materialized as workspace mention context').not.toContain(OUTSIDE_BYTES);
    expect(captures).toHaveLength(1); expect(captures[0].prompt).not.toContain(OUTSIDE_BYTES);
    expect(captures[0].context).toEqual([manual]);
    const warnings = h.sidebarMessages.filter(m => m.type === 'mentionWarning');
    expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain(escapedLink);
    expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[3])).toEqual([[manual]]);
    expect(host._collaborationManager.run).not.toHaveBeenCalled();
    expect(host._runningPanels.has('sidebar')).toBe(false);
    expect(opens).toEqual([]);
  });
  for (const route of ['ordinary', 'mysti', 'explicit-agent', 'brainstorm'] as const) {
    if (route !== 'ordinary') {
      it(`${route}: a regular workspace file reaches the real final dispatch`, async () => {
        await send(insideFile, route); assertValidParts(route, [[insideFile, INSIDE_BYTES]]);
        expect(opens).toHaveLength(1); expect(opens[0].reads).toBe(1);
      });
    }
    for (const kind of ['outside-absolute', 'traversal', 'leaf-symlink', 'parent-symlink', 'sibling-prefix', 'directory'] as const) {
      it(`${route}: ${kind} is reported while a valid requested file continues`, async () => {
        const rejected = kind === 'outside-absolute' ? outsideFile : kind === 'traversal' ? '../outside/outside.ts'
          : kind === 'leaf-symlink' ? escapedLink : kind === 'parent-symlink' ? path.join(parentLink, 'outside.ts')
            : kind === 'sibling-prefix' ? siblingFile : workspace;
        await send([rejected, insideFile], route);
        assertValidParts(route, [[insideFile, INSIDE_BYTES]]);
        expect(reads).toEqual([{ path: insideFile, content: INSIDE_BYTES, via: 'handle.read' }]);
        expect(opens).toHaveLength(1); expect(opens[0].path).toBe(insideFile);
        const warnings = h.sidebarMessages.filter(m => m.type === 'mentionWarning');
        expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain(rejected);
        if (kind === 'leaf-symlink') {
          await send(insideFile, route); assertValidParts(route, [[insideFile, INSIDE_BYTES]], 2);
          expect(h.sidebarMessages.filter(m => m.type === 'mentionWarning')).toHaveLength(1);
          expect(opens).toHaveLength(2);
        }
      });
    }
    for (const kind of ['in-root-link', 'second-declared-root', 'cross-root-link', 'declared-root-alias', 'canonical-under-root-alias'] as const) {
      it(`${route}: ${kind} remains a legitimate physical workspace member`, async () => {
        if (kind === 'second-declared-root' || kind === 'cross-root-link') setRoots([workspace, secondRoot]);
        if (kind === 'declared-root-alias' || kind === 'canonical-under-root-alias') setRoots([rootAlias]);
        const selected = kind === 'in-root-link' ? insideLink : kind === 'second-declared-root' ? declaredFile
          : kind === 'cross-root-link' ? crossRootLink : kind === 'declared-root-alias' ? path.join(rootAlias, 'selected.ts') : insideFile;
        const bytes = kind === 'second-declared-root' || kind === 'cross-root-link' ? DECLARED_BYTES : INSIDE_BYTES;
        await send(selected, route); assertValidParts(route, [[selected, bytes]]);
        expect(reads).toEqual([{ path: bytes === DECLARED_BYTES ? declaredFile : insideFile, content: bytes, via: 'handle.read' }]);
        expect(opens).toHaveLength(1); expect(h.sidebarMessages.filter(m => m.type === 'mentionWarning')).toEqual([]);
      });
    }
    for (const action of ['Stop', 'navigation'] as const) {
      it(`${route}: ${action} during handle metadata reads no bytes and releases the handle before recovery`, async () => {
        const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
        beforeHandleStat = async file => { if (file === insideFile) { entered.resolve(); await wait.promise; } };
        const pending = send([insideFile, secondFile], route);
        try {
          expect(await Promise.race([entered.promise.then(() => 'metadata'), pending.then(() => 'finished')])).toBe('metadata');
          expect(opens).toHaveLength(1); expect(reads).toEqual([]);
          if (action === 'Stop') await receive('cancelRequest');
          else await receive('switchConversation', { id: 'mention-containment' });
          wait.resolve(); await pending;
          expect(reads).toEqual([]); expect(texts()).toEqual([]); expect(opens).toHaveLength(1); assertClosed();
          expect(h.sidebarMessages.filter(m => m.type === 'mentionWarning')).toEqual([]);
          expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
          expect(host._runningPanels.has('sidebar')).toBe(false);
          checkpoints.push({ phase: 'cancelled-metadata', opens: structuredClone(opens), reads: structuredClone(reads),
            messages: structuredClone(h.sidebarMessages), persisted: structuredClone(h.persistedCalls) });
          beforeHandleStat = async () => undefined;
          await send(secondFile, route);
          expect(texts().length).toBeGreaterThan(0); expect(texts().every(text => text.includes(SECOND_BYTES) && !text.includes(INSIDE_BYTES))).toBe(true);
          expect(opens).toHaveLength(2); assertClosed(); assertNoOutside();
          expect(host._runningPanels.has('sidebar')).toBe(false);
        } finally { wait.resolve(); await pending; }
      });
    }
    it(`${route}: workspace replacement discards every already-collected file and recovers in the new root`, async () => {
      const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
      afterHandleRead = async file => { if (file === secondFile) { entered.resolve(); await wait.promise; } };
      const pending = send([insideFile, secondFile], route);
      try {
        expect(await Promise.race([entered.promise.then(() => 'read'), pending.then(() => 'finished')])).toBe('read');
        expect(reads.map(r => r.content)).toEqual([INSIDE_BYTES, SECOND_BYTES]);
        setRoots([secondRoot]); wait.resolve(); await pending;
        expect(texts().length).toBeGreaterThan(0);
        expect(texts().every(text => text.includes(manual.content) && !text.includes(INSIDE_BYTES) && !text.includes(SECOND_BYTES))).toBe(true);
        for (const capture of captures) expect(capture.context).toEqual(route === 'explicit-agent' ? [] : [manual]);
        const warnings = h.sidebarMessages.filter(m => m.type === 'mentionWarning');
        expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain(insideFile); expect(warnings[0].payload.message).toContain(secondFile);
        expect(host._runningPanels.has('sidebar')).toBe(false); assertClosed();
        checkpoints.push({ phase: 'workspace-replaced', opens: structuredClone(opens), reads: structuredClone(reads), captures: structuredClone(captures),
          wires: structuredClone(wires), messages: structuredClone(h.sidebarMessages), persisted: structuredClone(h.persistedCalls) });
        const previousTexts = texts().length, previousCaptures = captures.length;
        afterHandleRead = async () => undefined; await send(declaredFile, route);
        expect(texts().slice(previousTexts).every(text => text.includes(DECLARED_BYTES) && !text.includes(INSIDE_BYTES) && !text.includes(SECOND_BYTES))).toBe(true);
        for (const capture of captures.slice(previousCaptures)) expect(capture.context)
          .toEqual(route === 'explicit-agent' ? [] : [manual, expect.objectContaining({ path: declaredFile, content: DECLARED_BYTES })]);
        expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[3])).toEqual([[manual], [manual]]);
        expect(h.sidebarMessages.filter(m => m.type === 'mentionWarning')).toHaveLength(1);
        expect(opens).toHaveLength(3); assertClosed(); assertNoOutside();
      } finally { wait.resolve(); await pending; }
    });
  }
  for (const seam of ['before-open', 'during-handle-metadata'] as const) {
    it(`retargeting the original in-root symlink ${seam} cannot read the outside destination`, async () => {
      const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
      const hold = async (file: string) => { if (file === insideFile) { entered.resolve(); await wait.promise; } };
      if (seam === 'before-open') beforeOpen = hold; else beforeHandleStat = hold;
      const pending = send(insideLink);
      try {
        expect(await Promise.race([entered.promise.then(() => 'held'), pending.then(() => 'finished')])).toBe('held');
        unlinkSync(insideLink); symlinkSync(outsideFile, insideLink);
        wait.resolve(); await pending;
        expect(reads).toEqual([]); expect(opens).toHaveLength(1); expect(opens[0].path).toBe(insideFile); assertClosed();
        expect(captures).toHaveLength(1); expect(captures[0].context).toEqual([manual]); assertNoOutside();
        const warnings = h.sidebarMessages.filter(m => m.type === 'mentionWarning'); expect(warnings).toHaveLength(1);
        expect(warnings[0].payload.message).toContain(insideLink);
      } finally { wait.resolve(); await pending; }
    });
  }
  it('cancelling one metadata-only resolution preserves an independent valid read', async () => {
    const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
    beforeHandleStat = async file => { if (file === insideFile) { entered.resolve(); await wait.promise; } };
    const pending = send([insideFile, secondFile]);
    try {
      expect(await Promise.race([entered.promise.then(() => 'metadata'), pending.then(() => 'finished')])).toBe('metadata');
      const independent = await host._mentionRouter.resolveFileContext(payload(secondFile).mentions);
      expect(independent.items).toEqual([expect.objectContaining({ path: secondFile, content: SECOND_BYTES })]);
      await receive('cancelRequest'); wait.resolve(); await pending;
      expect(texts()).toEqual([]); expect(reads.map(r => r.content)).toEqual([SECOND_BYTES]);
      expect(opens).toHaveLength(2); assertClosed(); assertNoOutside();
      expect(h.sidebarMessages.filter(m => m.type === 'mentionWarning')).toEqual([]);
    } finally { wait.resolve(); await pending; }
  });
  it('no declared workspace denies the reference while preserving manual context', async () => {
    setRoots([]); await send(insideFile);
    expect(reads).toEqual([]); expect(opens).toEqual([]); expect(captures).toHaveLength(1);
    expect(captures[0].context).toEqual([manual]); expect(h.sidebarMessages.filter(m => m.type === 'mentionWarning')).toHaveLength(1);
    assertNoOutside();
  });
  for (const route of ['ordinary', 'explicit-agent'] as const) {
    it(`internal ${route}: navigation without automatic capture stops metadata and releases busy state`, async () => {
      const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
      beforeHandleStat = async file => { if (file === insideFile) { entered.resolve(); await wait.promise; } };
      currentPayload = payload([insideFile, secondFile], route); inputs.push(structuredClone(currentPayload));
      const pending = host._handleSendMessage(currentPayload, 'sidebar');
      try {
        expect(await Promise.race([entered.promise.then(() => 'metadata'), pending.then(() => 'finished')])).toBe('metadata');
        await receive('switchConversation', { id: 'mention-containment' });
        wait.resolve(); await pending;
        expect(reads).toEqual([]); expect(opens).toHaveLength(1); assertClosed();
        expect(texts()).toEqual([]); expect(host._collaborationManager.run).not.toHaveBeenCalled();
        expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
        expect(h.sidebarMessages.filter(m => m.type === 'mentionWarning' || m.type === 'responseComplete')).toEqual([]);
        expect(host._runningPanels.has('sidebar')).toBe(false);
        expect(host._lifecycleManager.markIdle).toHaveBeenCalledWith('sidebar');
        expect(h.sidebarMessages.filter(m => m.type === 'requestCancelled')).toHaveLength(1);
      } finally { wait.resolve(); await pending; }
    });
  }
});
