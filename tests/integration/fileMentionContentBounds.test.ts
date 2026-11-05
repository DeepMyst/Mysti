import { appendFileSync, mkdtempSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
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
  const deny = () => { throw new Error('Mention content fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

interface Capture { panelId: string; prompt: string; context: ContextItem[] }
interface OpenReceipt { path: string; readFileCalls: number; readCalls: number; bytesRead: number; closes: number; closed: boolean;
  operations: Array<{ requested: number | null; returned: number; eof: boolean; sha256: string; prefixBase64: string }> }
type Route = 'ordinary' | 'mysti' | 'explicit-agent' | 'brainstorm';
const TEXT = 'export const greeting = "CONTENT_VALID_雪_مرحبا_🙂";\n';
const BINARY = 'A\0B';
const OVERSIZE_MARKER = 'CONTENT_OVERSIZE_MUST_NOT_BE_PARTIAL';
const originalOpen = fs.open.bind(fs);
let h: ReturnType<typeof createHarness>, host: any, editors: ReturnType<typeof installEditorWindowFixture>;
let owned: string, valid: string, binary: string, oversized: string, manual: ContextItem;
let workspaceDescriptor: PropertyDescriptor | undefined;
let captures: Capture[], opens: OpenReceipt[], inputs: unknown[], checkpoints: unknown[];
let wires: Array<{ messages: Array<{ role: string; content: string }> }>;
let reads: Array<{ path: string; api: string; bytes: number; sha256: string; hasNul: boolean }>;

function digest(value: string | Buffer) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), hasNul: bytes.includes(0), prefixBase64: bytes.subarray(0, 64).toString('base64') };
}
function compact(text: string) {
  return { ...digest(text), includesValid: text.includes(TEXT), includesBinary: text.includes(BINARY), includesOversizeMarker: text.includes(OVERSIZE_MARKER),
    text: Buffer.byteLength(text) <= 32768 ? text : undefined, preview: text.slice(0, 256) };
}
function evidenceSnapshot() {
  return { captures: captures.map(c => ({ panelId: c.panelId, prompt: compact(c.prompt),
    context: c.context.map(item => ({ path: item.path, type: item.type, content: compact(item.content) })) })),
  wires: wires.map(wire => ({ messages: wire.messages.map(message => ({ role: message.role, content: compact(message.content) })) })),
  opens: structuredClone(opens), reads: structuredClone(reads), messages: structuredClone(h.sidebarMessages), persisted: structuredClone(h.persistedCalls) };
}
function texts() { return [...captures.map(capture => capture.prompt), ...wires.map(wire => wire.messages.map(message => message.content).join('\n'))]; }
async function send(files: string[], route: Route = 'ordinary') {
  let content = (route === 'explicit-agent' ? '@codex ' : '') + 'Explain ';
  const mentions: Mention[] = files.map(value => {
    const token = '@' + JSON.stringify(value), startIndex = content.length; content += token + ' ';
    return { type: 'file', value, displayName: token, startIndex, endIndex: startIndex + token.length };
  });
  const payload = { content, mentions, context: structuredClone([manual]), settings: {
    provider: route === 'mysti' ? 'mysti' : route === 'brainstorm' ? 'brainstorm' : 'claude-code',
    model: '', mode: 'quick-plan', accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none',
  } as Settings };
  inputs.push(structuredClone(payload));
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type: route === 'brainstorm' ? 'sendBrainstormMessage' : 'sendMessage', payload }, 'sidebar', owner.webview);
}
function settled(users: number, route: Route = 'ordinary') {
  expect(opens.every(open => open.closed && open.closes === 1), 'every real file handle closes exactly once').toBe(true);
  expect(h.persistedCalls.filter(call => call[1] === 'user').map(call => call[3]))
    .toEqual(Array.from({ length: users }, () => [manual]));
  expect(h.contextManager.getContext('sidebar')).toEqual([]);
  expect(host._runningPanels.has('sidebar')).toBe(false);
  expect(host._collaborationManager.run.mock.calls.length).toBe(route === 'explicit-agent' ? users : 0);
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
    return new Response('data: {"choices":[{"delta":{"content":"Deterministic bounded-content coordinator answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));
  editors = installEditorWindowFixture();
  owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mysti-ew04-content-')));
  valid = path.join(owned, 'unicode.ts'); binary = path.join(owned, 'binary.bin'); oversized = path.join(owned, 'oversized.txt');
  writeFileSync(valid, TEXT); writeFileSync(binary, BINARY);
  manual = { id: 'manual', type: 'file', path: path.join(owned, 'manual.ts'), content: 'CONTENT_MANUAL_KEEP', enabled: true };
  workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true,
    value: [{ uri: vscode.Uri.file(owned), name: 'owned-content', index: 0 }] });
  captures = []; opens = []; reads = []; inputs = []; checkpoints = []; wires = [];
  h = createHarness(); host = h.provider as any;
  host._panelStates.get('sidebar').currentConversationId = 'mention-content';
  h.conversationManager.getConversation = () => ({ id: 'mention-content', messages: [] });
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), {
    id: 'claude-code', displayName: 'Owned content fixture',
    capabilities: { supportsImages: false, supportsFileAttachments: false }, _nativeHistoryDeltas: new WeakSet(),
  });
  const backend = (id: string) => ({ id, capabilities: { supportsNativeApproval: false, toolCallsAreProposals: true },
    async *sendMessage(content: string, context: ContextItem[], settings: Settings, history: unknown,
      persona: unknown, panelId: string, _manager: unknown, agentConfig: unknown, attachments: unknown,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      if (resolveInput) { const resolved = resolveInput(); if (!resolved) return; ({ content, context } = resolved); }
      const prompt = await builder.buildPromptAsync(content, context, history, settings, persona, agentConfig, attachments);
      captures.push({ panelId, prompt, context: structuredClone(context) });
      yield { type: 'text', content: 'Deterministic bounded-content answer.' }; yield { type: 'done' };
    },
  });
  const backends = new Map(['claude-code', 'openai-codex'].map(id => [id, backend(id)]));
  const manager = Object.assign(Object.create(ProviderManager.prototype), {
    _registry: { get: (id: string) => backends.get(id) }, _panelProviders: new Map(),
  });
  Object.assign(h.providerManager, {
    sendMessage: ProviderManager.prototype.sendMessage.bind(manager), sendMessageToProvider: ProviderManager.prototype.sendMessageToProvider.bind(manager),
    getAllProviderIds: () => [...backends.keys()], getProviderDefaultModel: () => '', getProviderInstance: (id: string) => backends.get(id),
    getProviderStatus: async () => ({ found: true, authenticated: true, path: '/unused' }),
    captureNativeApprovalHandler: () => undefined, setNativeApprovalHandlerForPanel: () => ({ dispose() {} }),
    disposePersistentProcessForProvider: vi.fn(), suspendRequest: () => false, resumeRequest: () => false,
  });
  const catalogue = { isConfigured: () => false, cachedModel: () => undefined, listAllModels: async () => [] } as unknown as OpenRouterClient;
  host.setMystiCoordinator(new CoordinatorModelClient(new DeepMystGatewayClient(() => 'dm_owned_fixture', () => 'https://gateway.v2.deepmyst.com'),
    catalogue, () => true, () => ({ freeModels: ['openrouter/owned-fixture'], gatewayFallbackModel: '', openRouterModel: 'auto' })));
  host._brainstormManager = new BrainstormManager(h.extensionContext, h.providerManager);
  host._engagementManager.trackBrainstormCompleted = () => [];
  host._mystiMcpToolset = async () => null; host._mystiVisualEnabled = () => ({ look: false, act: false });
  host._mystiSkillsEnabled = () => false; host._buildMystiProjectBrain = async () => '';
  vi.spyOn(host._collaborationManager, 'run');
  vi.spyOn(fs, 'open').mockImplementation((async (file: any, ...args: any[]) => {
    const handle = await (originalOpen as any)(file, ...args);
    if (!String(file).startsWith(owned + path.sep)) return handle;
    const record: OpenReceipt = { path: String(file), readFileCalls: 0, readCalls: 0, bytesRead: 0, closes: 0, closed: false, operations: [] }; opens.push(record);
    const readFile = handle.readFile.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle);
    vi.spyOn(handle, 'readFile').mockImplementation(async (...options: any[]) => {
      record.readFileCalls++; const content = await readFile(...options), measured = digest(content);
      record.bytesRead += measured.bytes; reads.push({ path: String(file), api: 'handle.readFile', ...measured }); return content;
    });
    vi.spyOn(handle, 'read').mockImplementation(async (...options: any[]) => {
      record.readCalls++; const result = await read(...options);
      const offset = typeof options[1] === 'number' ? options[1] : options[0]?.offset ?? 0;
      const bytes = Buffer.from(result.buffer.buffer, result.buffer.byteOffset + offset, result.bytesRead);
      record.operations.push({ requested: typeof options[2] === 'number' ? options[2] : options[0]?.length ?? null,
        returned: result.bytesRead, eof: result.bytesRead === 0, sha256: digest(bytes).sha256, prefixBase64: bytes.subarray(0, 64).toString('base64') });
      if (result.bytesRead) {
        record.bytesRead += result.bytesRead; reads.push({ path: String(file), api: 'handle.read', ...digest(bytes) });
      }
      return result;
    });
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      record.closes++; const result = await close(); record.closed = true; return result;
    });
    return handle;
  }) as any);
});

afterEach(() => {
  const sink = process.env.MYSTI_FILE_MENTION_CONTENT_RECEIPTS;
  if (sink) appendFileSync(sink, JSON.stringify({ test: expect.getState().currentTestName,
    payloadOrigin: 'controlled-host-fixture', owned, valid, binary, oversized, textFixture: compact(TEXT), binaryFixture: compact(BINARY),
    manual, inputs, checkpoints, ...evidenceSnapshot(), collaboratorDispatches: host._collaborationManager.run.mock.calls.length,
  }) + '\n');
  try { host?._brainstormManager.clearSession('sidebar'); h?.dispose(); } finally {
    if (workspaceDescriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceDescriptor);
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners(); rmSync(owned, { recursive: true, force: true });
  }
});

describe('EW04 file mention text content bounds at actual host dispatch', () => {
  it('preserves exact small Unicode file content and manual context', async () => {
    await send([valid]); expect(captures).toHaveLength(1);
    expect(captures[0].context.map(item => [item.path, item.content])).toEqual([[manual.path, manual.content], [valid, TEXT]]);
    expect(captures[0].prompt.includes(TEXT)).toBe(true); expect(captures[0].prompt.includes(manual.content)).toBe(true);
    expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toEqual([]);
    expect(opens.find(open => open.path === valid)?.bytesRead).toBe(Buffer.byteLength(TEXT)); settled(1);
  });
  it('omits binary A NUL B with a warning while valid text continues and a followup succeeds', async () => {
    await send([binary, valid]); const first = evidenceSnapshot(); checkpoints.push({ phase: 'mixed-binary-and-valid', ...first });
    await send([valid]);
    expect(first.captures.every(capture => !capture.prompt.includesBinary), 'binary bytes must not enter the actual outgoing prompt').toBe(true);
    expect(first.captures).toHaveLength(1);
    expect(first.captures[0].context.map(item => [item.path, item.content.text])).toEqual([[manual.path, manual.content], [valid, TEXT]]);
    expect(first.captures[0].prompt.includesValid).toBe(true);
    const warnings = first.messages.filter(message => message.type === 'mentionWarning');
    expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain(binary);
    expect(captures).toHaveLength(2); expect(captures[1].context.map(item => [item.path, item.content]))
      .toEqual([[manual.path, manual.content], [valid, TEXT]]);
    expect(captures[1].prompt.includes(TEXT)).toBe(true); expect(captures[1].prompt.includes(BINARY)).toBe(false);
    expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1); settled(2);
  });
  for (const route of ['mysti', 'explicit-agent', 'brainstorm'] as const) {
    it(`${route} omits binary bytes while valid Unicode and manual content reach every participant`, async () => {
      await send([binary, valid], route);
      expect(texts().length).toBeGreaterThan(0);
      expect(texts().every(text => text.includes(TEXT) && text.includes(manual.content) && !text.includes(BINARY))).toBe(true);
      const warnings = h.sidebarMessages.filter(message => message.type === 'mentionWarning');
      expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain(binary);
      expect(warnings[0].payload.message).toMatch(/binary|NUL/i);
      checkpoints.push({ phase: 'binary-rejected-valid-dispatched', ...evidenceSnapshot() });
      const before = texts().length; await send([valid], route);
      expect(texts().slice(before).length).toBeGreaterThan(0);
      expect(texts().slice(before).every(text => text.includes(TEXT) && !text.includes(BINARY))).toBe(true);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1); settled(2, route);
    });
  }
  for (const route of ['ordinary', 'mysti', 'explicit-agent', 'brainstorm'] as const) {
    it(`${route} rejects a 5,000,001-byte file before reading content and preserves the valid request parts`, async () => {
      writeFileSync(oversized, OVERSIZE_MARKER); truncateSync(oversized, 5_000_001);
      expect(statSync(oversized).size).toBe(5_000_001);
      await send([oversized, valid], route);
      expect(reads.filter(read => read.path === oversized), 'metadata rejects oversized file before content allocation').toEqual([]);
      expect(texts().length).toBeGreaterThan(0);
      expect(texts().every(text => text.includes(TEXT) && text.includes(manual.content)
        && !text.includes(OVERSIZE_MARKER) && !text.includes('\0')), 'neither oversized bytes nor partial text reaches a recipient').toBe(true);
      const warnings = h.sidebarMessages.filter(message => message.type === 'mentionWarning');
      expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain(oversized);
      expect(warnings[0].payload.message).toMatch(/5,?000,?000|limit|large/i);
      checkpoints.push({ phase: 'oversize-rejected-valid-dispatched', declaredFileBytes: statSync(oversized).size, ...evidenceSnapshot() });
      const before = texts().length; await send([valid], route);
      expect(texts().slice(before).length).toBeGreaterThan(0);
      expect(texts().slice(before).every(text => text.includes(TEXT) && !text.includes(OVERSIZE_MARKER))).toBe(true);
      expect(h.sidebarMessages.filter(message => message.type === 'mentionWarning')).toHaveLength(1); settled(2, route);
    });
  }
});
