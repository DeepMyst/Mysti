import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { observeFileHandleReads } from '../helpers/fileHandleReads';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  const deny = () => { throw new Error('File mention binding fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

type Route = 'ordinary' | 'mysti' | 'explicit-agent' | 'brainstorm';
interface Capture { providerId: string; panelId: string; prompt: string; context: ContextItem[] }
interface Wire { messages: Array<{ role: string; content: string }> }
const A_BYTES = 'export const requested = "BINDING_A_雪_مرحبا_🙂";\n';
const B_BYTES = 'export const unrelated = "BINDING_B_MUST_NOT_LEAK";\n';
let h: ReturnType<typeof createHarness>, host: any, editors: ReturnType<typeof installEditorWindowFixture>;
let root: string, a: string, b: string, manual: ContextItem;
let workspaceDescriptor: PropertyDescriptor | undefined;
let findFilesDescriptor: PropertyDescriptor | undefined;
let captures: Capture[], wires: Wire[], readPaths: string[], sent: unknown[];
let checkpoints: unknown[];
let conversation: { id: string; messages: any[] };
let beforeDone: (content: string) => Promise<void>;
let releaseWait: (() => void) | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function payload(route: Route, token = '@' + JSON.stringify(a), value = a) {
  const content = (route === 'explicit-agent' ? '@codex ' : '') + 'Explain ' + token + '.';
  const startIndex = content.indexOf(token);
  const mentions: Mention[] = [{ type: 'file', value, displayName: token, startIndex, endIndex: startIndex + token.length }];
  return { content, mentions, context: structuredClone([manual]),
    settings: { provider: route === 'mysti' ? 'mysti' : route === 'brainstorm' ? 'brainstorm' : 'claude-code',
      model: '', mode: 'quick-plan', accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' } as Settings };
}
async function send(route: Route, value: ReturnType<typeof payload> & { secondOpinion?: { provider: string; messageId: string } } = payload(route)) {
  sent.push(structuredClone(value));
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type: route === 'brainstorm' ? 'sendBrainstormMessage' : 'sendMessage', payload: value }, 'sidebar', owner.webview);
}
function texts() { return [...captures.map(c => c.prompt), ...wires.map(w => w.messages.map(m => m.content).join('\n'))]; }
function assertAccepted(route: Route, previousRejections = 0) {
  expect(texts().length).toBeGreaterThan(0);
  for (const text of texts()) { expect(text).toContain(A_BYTES); expect(text).not.toContain(B_BYTES); expect(text).toContain(manual.content); }
  expect(readPaths).toEqual([a]);
  expect(h.persistedCalls.filter(call => call[1] === 'user').map(call => call[3])).toEqual([[manual]]);
  expect(h.contextManager.getContext('sidebar')).toEqual([]);
  expect(host._runningPanels.has('sidebar')).toBe(false);
  expect(h.sidebarMessages.filter(m => m.type === 'error')).toHaveLength(previousRejections);
  expect(h.sidebarMessages.filter(m => ['mystiError', 'brainstormError', 'brainstormAgentError'].includes(m.type))).toEqual([]);
  expect(host._collaborationManager.run.mock.calls.length).toBe(route === 'explicit-agent' ? 1 : 0);
}
function assertRefused() {
  checkpoints.push({ phase: 'rejected-send', readPaths: [...readPaths], captures: structuredClone(captures), wires: structuredClone(wires),
    messages: structuredClone(h.sidebarMessages), persisted: structuredClone(h.persistedCalls),
    collaboratorDispatches: host._collaborationManager.run.mock.calls.length });
  expect(readPaths, 'invalid visible-to-file identity must be rejected before any referenced file read').toEqual([]);
  expect(texts(), 'an invalid reference must not reach any final dispatch').toEqual([]);
  expect(h.persistedCalls, 'the rejected send must not become saved history').toEqual([]);
  expect(host._collaborationManager.run).not.toHaveBeenCalled();
  expect(h.sidebarMessages.filter(m => m.type === 'error'), 'idle refusal must visibly settle the submitted composer loading state').toHaveLength(1);
  expect(h.sidebarMessages.find(m => m.type === 'error')?.payload).toMatch(/file|reference/i);
  expect(host._runningPanels.has('sidebar')).toBe(false);
}

beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers();
  setMockConfig('autoContext', false); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false); setMockConfig('mysti.memory', false);
  setMockConfig('brainstorm.agents', ['claude-code', 'openai-codex']); setMockConfig('brainstorm.strategy', 'quick');
  setMockConfig('brainstorm.synthesisAgent', 'claude-code');
  editors = installEditorWindowFixture();
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mysti-ew04-binding-')));
  a = path.join(root, 'src/requested.ts'); b = path.join(root, 'src/unrelated.ts');
  mkdirSync(path.dirname(a), { recursive: true }); writeFileSync(a, A_BYTES); writeFileSync(b, B_BYTES);
  manual = { id: 'manual', type: 'file', path: path.join(root, 'manual.ts'), content: 'BINDING_MANUAL_KEEP', enabled: true };
  workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(root), name: 'owned', index: 0 }] });
  findFilesDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'findFiles');
  // Controlled complete catalogue for the owned files; the selector still
  // performs real canonical metadata checks and the final reader uses real handles.
  Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true,
    value: vi.fn(async () => [a, b].map(file => vscode.Uri.file(file))) });
  captures = []; wires = []; readPaths = []; sent = []; checkpoints = [];
  beforeDone = async () => undefined; releaseWait = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://gateway.v2.deepmyst.com/v1/chat/completions');
    expect(init?.method).toBe('POST'); wires.push(JSON.parse(String(init?.body)));
    return new Response('data: {"choices":[{"delta":{"content":"Deterministic binding answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));
  h = createHarness(); host = h.provider as any;
  host._panelStates.get('sidebar').currentConversationId = 'mention-binding';
  conversation = { id: 'mention-binding', messages: [] }; h.conversationManager.getConversation = () => conversation;
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), { id: 'claude-code', displayName: 'Owned binding fixture',
    capabilities: { supportsImages: false, supportsFileAttachments: false }, _nativeHistoryDeltas: new WeakSet() });
  const backend = (id: string) => ({ id, capabilities: { supportsNativeApproval: false, toolCallsAreProposals: true },
    async *sendMessage(content: string, context: ContextItem[], settings: Settings, history: unknown,
      persona: unknown, panelId: string, _manager: unknown, agentConfig: unknown, attachments: unknown,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      if (resolveInput) { const resolved = resolveInput(); if (!resolved) return; ({ content, context } = resolved); }
      const prompt = await builder.buildPromptAsync(content, context, history, settings, persona, agentConfig, attachments);
      captures.push({ providerId: id, panelId, prompt, context: structuredClone(context) });
      yield { type: 'text', content: `RESULT_${id}` }; await beforeDone(content); yield { type: 'done' };
    },
  });
  const backends = new Map(['claude-code', 'openai-codex'].map(id => [id, backend(id)]));
  const manager = Object.assign(Object.create(ProviderManager.prototype), { _registry: { get: (id: string) => backends.get(id) }, _panelProviders: new Map() });
  Object.assign(h.providerManager, {
    sendMessage: ProviderManager.prototype.sendMessage.bind(manager), sendMessageToProvider: ProviderManager.prototype.sendMessageToProvider.bind(manager),
    getAllProviderIds: () => [...backends.keys()], getProviderDefaultModel: () => '', getProviderInstance: (id: string) => backends.get(id),
    getProvider: (id: string) => backends.has(id) ? { id, defaultModel: '' } : undefined,
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
  vi.spyOn(h.providerManager, 'cancelRequest');
  vi.spyOn(host._lifecycleManager, 'markIdle');
  observeFileHandleReads(async (file, read) => {
    if (file.startsWith(root + path.sep)) readPaths.push(file);
    return read();
  });
});
afterEach(() => {
  releaseWait?.();
  if (process.env.MYSTI_FILE_MENTION_BINDING_RECEIPTS) appendFileSync(process.env.MYSTI_FILE_MENTION_BINDING_RECEIPTS, JSON.stringify({
    test: expect.getState().currentTestName, sent, files: [{ path: a, content: A_BYTES }, { path: b, content: B_BYTES }],
    manual, readPaths, captures, wires, checkpoints, messages: h.sidebarMessages, persisted: h.persistedCalls,
    collaboratorDispatches: host._collaborationManager.run.mock.calls.length,
    cancellationCalls: h.providerManager.cancelRequest.mock.calls,
    idleCalls: host._lifecycleManager.markIdle.mock.calls,
  }) + '\n');
  try { host?._brainstormManager.clearSession('sidebar'); h?.dispose(); } finally {
    if (workspaceDescriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceDescriptor);
    if (findFilesDescriptor) Object.defineProperty(vscode.workspace, 'findFiles', findFilesDescriptor);
    else Reflect.deleteProperty(vscode.workspace, 'findFiles');
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners(); rmSync(root, { recursive: true, force: true });
  }
});

describe('EW04 visible file token binding at the host boundary', () => {
  it('matching quoted A and value A reaches the ordinary final prompt', async () => {
    await send('ordinary'); assertAccepted('ordinary');
  });
  it('quoted A and supplied value B refuses the whole ordinary send before reading B', async () => {
    await send('ordinary', payload('ordinary', '@' + JSON.stringify(a), b)); assertRefused();
  });
  for (const route of ['mysti', 'explicit-agent', 'brainstorm'] as const) {
    it(`${route}: matching quoted A reaches the real final dispatch`, async () => {
      await send(route); assertAccepted(route);
    });
  }
  for (const route of ['ordinary', 'mysti', 'explicit-agent', 'brainstorm'] as const) {
    it(`${route}: mismatched B metadata refuses before reads and the next matching A send succeeds`, async () => {
      await send(route, payload(route, '@' + JSON.stringify(a), b)); assertRefused();
      await send(route); assertAccepted(route, 1);
    });
    for (const change of ['removed', 'replaced'] as const) {
      it(`${route}: ${change} visible token cannot retain stale A metadata`, async () => {
        const input = payload(route);
        input.content = change === 'removed' ? input.content.replace(input.mentions[0].displayName, 'the overview')
          : input.content.replace(input.mentions[0].displayName, '@' + JSON.stringify(b));
        await send(route, input); assertRefused();
      });
    }
    for (const location of ['inline-code', 'fenced-code', 'email', 'unrelated-text'] as const) {
      it(`${route}: supplied file offsets inside ${location} are not a reference`, async () => {
        const input = payload(route);
        const token = input.mentions[0].displayName;
        const prefix = route === 'explicit-agent' ? '@codex ' : '';
        input.content = prefix + (location === 'inline-code' ? '`' + token + '`'
          : location === 'fenced-code' ? '```text\n' + token + '\n```'
            : location === 'email' ? 'person' + token : 'Explain this ordinary text without any file reference.');
        input.mentions[0].startIndex = location === 'unrelated-text' ? prefix.length : input.content.indexOf(token);
        input.mentions[0].endIndex = input.mentions[0].startIndex + (location === 'unrelated-text' ? 7 : token.length);
        await send(route, input); assertRefused();
      });
    }
  }
  for (const spelling of ['basename', 'relative-path', 'relative-value', 'quoted-relative', 'quoted-special'] as const) {
    for (const route of ['ordinary', 'brainstorm'] as const) {
      it(`${route}: valid ${spelling} reference keeps the intended exact bytes`, async () => {
        if (spelling === 'quoted-special') {
          a = path.join(root, 'src/雪 ref @claude and @codex "quoted".ts'); writeFileSync(a, A_BYTES);
        }
        const relative = path.relative(root, a);
        const token = spelling === 'basename' ? '@' + path.basename(a)
          : spelling === 'relative-path' || spelling === 'relative-value' ? '@' + relative
            : '@' + JSON.stringify(spelling === 'quoted-relative' ? relative : a);
        const input = payload(route, token, spelling === 'relative-value' ? relative : a);
        // Bare-path grammar includes dots; whitespace terminates the actual
        // token just as the composer does before deriving these offsets.
        input.content = input.content.slice(0, -1) + ' please.';
        await send(route, input);
        assertAccepted(route);
      });
    }
  }
  for (const offsets of ['negative', 'fractional', 'truncated', 'out-of-range'] as const) {
    it(`ordinary: ${offsets} supplied offsets refuse before any file is read`, async () => {
      const input = payload('ordinary');
      if (offsets === 'negative') input.mentions[0].startIndex = -1;
      else if (offsets === 'fractional') input.mentions[0].startIndex += 0.5;
      else if (offsets === 'truncated') input.mentions[0].endIndex--;
      else input.mentions[0].endIndex = input.content.length + 1;
      await send('ordinary', input); assertRefused();
    });
  }
  for (const route of ['ordinary', 'mysti', 'explicit-agent', 'brainstorm'] as const) {
    it(`${route}: rejecting an invalid send leaves an active ordinary response owned and running`, async () => {
      const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
      beforeDone = async content => { if (content.includes('ACTIVE_FOREGROUND')) { entered.resolve(); await wait.promise; } };
      const foregroundInput = payload('ordinary'); foregroundInput.content += ' ACTIVE_FOREGROUND';
      const foreground = send('ordinary', foregroundInput);
      try {
        expect(await Promise.race([entered.promise.then(() => 'stream'), foreground.then(() => 'finished')])).toBe('stream');
        const generation = host._mystiRunGen.get('sidebar');
        const previous = { readPaths: [...readPaths], captures: structuredClone(captures), persisted: structuredClone(h.persistedCalls),
          cancelledMessages: h.sidebarMessages.filter(m => m.type === 'requestCancelled').length };
        const invalid = send(route, payload(route, '@' + JSON.stringify(a), b));
        await vi.advanceTimersByTimeAsync(51); await invalid;
        expect(host._mystiRunGen.get('sidebar')).toBe(generation);
        expect(host._runningPanels.has('sidebar')).toBe(true);
        expect(h.providerManager.cancelRequest).not.toHaveBeenCalled();
        expect(readPaths).toEqual(previous.readPaths); expect(captures).toEqual(previous.captures); expect(wires).toEqual([]);
        expect(h.persistedCalls).toEqual(previous.persisted);
        expect(h.sidebarMessages.filter(m => m.type === 'requestCancelled')).toHaveLength(previous.cancelledMessages);
        expect(h.sidebarMessages.filter(m => m.type === 'error')).toEqual([]);
        expect(h.sidebarMessages.filter(m => m.type === 'systemNotice')).toHaveLength(1);
        expect(h.sidebarMessages.find(m => m.type === 'systemNotice')?.payload.message).toMatch(/file|reference/i);
        wait.resolve(); await foreground;
        expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toHaveLength(1);
        expect(h.sidebarMessages.filter(m => m.type === 'responseComplete')).toHaveLength(1);
        expect(host._runningPanels.has('sidebar')).toBe(false);
      } finally { wait.resolve(); await foreground; }
    });
  }
  it('second opinion binds supplied metadata against saved source, not the replacement draft', async () => {
    const saved = payload('ordinary');
    conversation.messages.push({ id: 'saved-user', role: 'user', content: saved.content, context: [manual] });
    const untrustedDraft = payload('ordinary', '@' + JSON.stringify(b), b);
    await send('ordinary', { ...untrustedDraft, secondOpinion: { provider: 'claude-code', messageId: 'saved-user' } });
    assertRefused();
  });
  it('second opinion revalidates file identity if its saved source changes during settings preparation', async () => {
    const saved = payload('ordinary');
    const source = { id: 'saved-user', role: 'user', content: saved.content, context: [manual] };
    conversation.messages.push(source);
    const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
    host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([wait.promise]);
    const originalPrepare = host._prepareSecondOpinion.bind(host);
    vi.spyOn(host, '_prepareSecondOpinion').mockImplementation((...args: any[]) => {
      const result = originalPrepare(...args); entered.resolve(); return result;
    });
    const pending = send('ordinary', { ...saved, secondOpinion: { provider: 'claude-code', messageId: 'saved-user' } });
    try {
      expect(await Promise.race([entered.promise.then(() => 'prepared'), pending.then(() => 'finished')])).toBe('prepared');
      source.content = source.content.replace('@' + JSON.stringify(a), '@' + JSON.stringify(b));
      wait.resolve(); await pending; assertRefused();
    } finally { wait.resolve(); await pending; }
  });
  it('second opinion without file metadata keeps saved manual context and does not reacquire file bytes', async () => {
    const saved = payload('ordinary');
    conversation.messages.push({ id: 'saved-user', role: 'user', content: saved.content, context: [manual] });
    await send('ordinary', { ...saved, mentions: [], secondOpinion: { provider: 'claude-code', messageId: 'saved-user' } });
    expect(readPaths).toEqual([]); expect(captures).toHaveLength(1);
    expect(captures[0].context).toEqual([manual]); expect(captures[0].prompt).toContain(manual.content);
    expect(captures[0].prompt).not.toContain(A_BYTES); expect(captures[0].prompt).not.toContain(B_BYTES);
    expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[3])).toEqual([[manual]]);
  });
  it('saved-source invalidation after settings retires the superseded active response and releases preparation', async () => {
    const activeEntered = deferred(), activeWait = deferred(), settingsEntered = deferred(), settingsWait = deferred();
    releaseWait = () => { activeWait.resolve(); settingsWait.resolve(); };
    beforeDone = async content => { if (content.includes('SUPERSEDED_FOREGROUND')) { activeEntered.resolve(); await activeWait.promise; } };
    const activeInput = payload('ordinary'); activeInput.content += ' SUPERSEDED_FOREGROUND';
    const foreground = send('ordinary', activeInput);
    let pending: Promise<void> | undefined;
    try {
      expect(await Promise.race([activeEntered.promise.then(() => 'stream'), foreground.then(() => 'finished')])).toBe('stream');
      const generation = host._mystiRunGen.get('sidebar');
      expect(host._runningPanels.has('sidebar')).toBe(true);
      const saved = payload('ordinary');
      const source = { id: 'saved-user', role: 'user', content: saved.content, context: [manual] };
      conversation.messages.push(source);
      host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([settingsWait.promise]);
      const originalPrepare = host._prepareSecondOpinion.bind(host);
      vi.spyOn(host, '_prepareSecondOpinion').mockImplementation((...args: any[]) => {
        const result = originalPrepare(...args); settingsEntered.resolve(); return result;
      });
      pending = send('ordinary', { ...saved, secondOpinion: { provider: 'claude-code', messageId: 'saved-user' } });
      expect(await Promise.race([settingsEntered.promise.then(() => 'settings'), pending.then(() => 'finished')])).toBe('settings');
      expect(host._mystiRunGen.get('sidebar')).toBe(generation + 1);
      expect(host._delayedChannelTurns.has('sidebar')).toBe(true);
      expect(h.providerManager.cancelRequest).not.toHaveBeenCalled();
      source.content = source.content.replace('@' + JSON.stringify(a), '@' + JSON.stringify(b));
      settingsWait.resolve(); await pending;
      expect(readPaths).toEqual([a]); expect(captures).toHaveLength(1); expect(wires).toEqual([]);
      expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[2])).toEqual([activeInput.content]);
      expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
      expect(h.providerManager.cancelRequest.mock.calls.filter((call: unknown[]) => call[0] === 'sidebar')).toEqual([['sidebar']]);
      expect(host._lifecycleManager.markIdle).toHaveBeenCalledWith('sidebar');
      expect(host._runningPanels.has('sidebar')).toBe(false);
      expect(host._delayedChannelTurns.has('sidebar')).toBe(false);
      expect(h.sidebarMessages.filter(m => m.type === 'error')).toHaveLength(1);
      expect(h.sidebarMessages.find(m => m.type === 'error')?.payload).toMatch(/file|reference/i);
      const messages = structuredClone(h.sidebarMessages), persisted = structuredClone(h.persistedCalls);
      const cancellations = structuredClone(h.providerManager.cancelRequest.mock.calls);
      checkpoints.push({ phase: 'invalidated-current-owner-retires-predecessor', generation: host._mystiRunGen.get('sidebar'),
        preparation: host._delayedChannelTurns.has('sidebar'), running: host._runningPanels.has('sidebar'),
        cancellationCalls: structuredClone(h.providerManager.cancelRequest.mock.calls), messages, persisted });
      activeWait.resolve(); await foreground;
      expect(h.sidebarMessages).toEqual(messages); expect(h.persistedCalls).toEqual(persisted);
      expect(h.providerManager.cancelRequest.mock.calls).toEqual(cancellations);
      expect(host._runningPanels.has('sidebar')).toBe(false);
    } finally { releaseWait(); await pending; await foreground; }
  });
  it('obsolete saved-source invalidation cannot clear a successor preparation or its later active response', async () => {
    const activeEntered = deferred(), activeWait = deferred(), oldSettingsEntered = deferred(), oldSettingsWait = deferred();
    const newSettingsEntered = deferred(), newSettingsWait = deferred(), successorEntered = deferred(), successorWait = deferred();
    releaseWait = () => { activeWait.resolve(); oldSettingsWait.resolve(); newSettingsWait.resolve(); successorWait.resolve(); };
    beforeDone = async content => {
      if (content.includes('OLD_FOREGROUND')) { activeEntered.resolve(); await activeWait.promise; }
      if (content.includes('OWNED_SUCCESSOR')) { successorEntered.resolve(); await successorWait.promise; }
    };
    const activeInput = payload('ordinary'); activeInput.content += ' OLD_FOREGROUND';
    const foreground = send('ordinary', activeInput);
    let pending: Promise<void> | undefined, successor: Promise<void> | undefined;
    try {
      expect(await Promise.race([activeEntered.promise.then(() => 'stream'), foreground.then(() => 'finished')])).toBe('stream');
      const saved = payload('ordinary');
      const source = { id: 'saved-user', role: 'user', content: saved.content, context: [manual] };
      conversation.messages.push(source);
      host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([oldSettingsWait.promise]);
      const originalPrepare = host._prepareSecondOpinion.bind(host);
      vi.spyOn(host, '_prepareSecondOpinion').mockImplementation((...args: any[]) => {
        const result = originalPrepare(...args); oldSettingsEntered.resolve(); return result;
      });
      pending = send('ordinary', { ...saved, secondOpinion: { provider: 'claude-code', messageId: 'saved-user' } });
      expect(await Promise.race([oldSettingsEntered.promise.then(() => 'settings'), pending.then(() => 'finished')])).toBe('settings');
      const oldGeneration = host._mystiRunGen.get('sidebar');
      host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([newSettingsWait.promise]);
      const originalTurn = host._handleSendMessageForTurn.bind(host);
      vi.spyOn(host, '_handleSendMessageForTurn').mockImplementation((...args: any[]) => {
        if (args[0].content.includes('OWNED_SUCCESSOR')) newSettingsEntered.resolve();
        return originalTurn(...args);
      });
      const successorInput = payload('ordinary'); successorInput.content += ' OWNED_SUCCESSOR';
      successor = send('ordinary', successorInput);
      expect(await Promise.race([newSettingsEntered.promise.then(() => 'settings'), successor.then(() => 'finished')])).toBe('settings');
      const successorGeneration = host._mystiRunGen.get('sidebar'); expect(successorGeneration).toBe(oldGeneration + 1);
      source.content = source.content.replace('@' + JSON.stringify(a), '@' + JSON.stringify(b));
      const before = { messages: structuredClone(h.sidebarMessages), persisted: structuredClone(h.persistedCalls) };
      oldSettingsWait.resolve(); await pending;
      expect(host._mystiRunGen.get('sidebar')).toBe(successorGeneration);
      expect(host._delayedChannelTurns.has('sidebar')).toBe(true);
      expect(host._runningPanels.has('sidebar')).toBe(true);
      expect(h.providerManager.cancelRequest).not.toHaveBeenCalled();
      expect(h.sidebarMessages).toEqual(before.messages); expect(h.persistedCalls).toEqual(before.persisted);
      checkpoints.push({ phase: 'obsolete-owner-preserves-successor-preparation', generation: successorGeneration,
        preparation: host._delayedChannelTurns.has('sidebar'), running: host._runningPanels.has('sidebar'),
        cancellationCalls: structuredClone(h.providerManager.cancelRequest.mock.calls), ...before });
      newSettingsWait.resolve(); await vi.advanceTimersByTimeAsync(51);
      expect(await Promise.race([successorEntered.promise.then(() => 'stream'), successor.then(() => 'finished')])).toBe('stream');
      expect(readPaths).toEqual([a, a]); expect(captures).toHaveLength(2); expect(wires).toEqual([]);
      expect(h.providerManager.cancelRequest.mock.calls.filter((call: unknown[]) => call[0] === 'sidebar')).toEqual([['sidebar']]);
      expect(host._runningPanels.has('sidebar')).toBe(true);
      expect(host._delayedChannelTurns.has('sidebar')).toBe(false);
      const messages = structuredClone(h.sidebarMessages), persisted = structuredClone(h.persistedCalls);
      const cancellations = structuredClone(h.providerManager.cancelRequest.mock.calls);
      activeWait.resolve(); await foreground;
      expect(host._mystiRunGen.get('sidebar')).toBe(successorGeneration);
      expect(host._runningPanels.has('sidebar')).toBe(true);
      expect(h.sidebarMessages).toEqual(messages); expect(h.persistedCalls).toEqual(persisted);
      expect(h.providerManager.cancelRequest.mock.calls).toEqual(cancellations);
      successorWait.resolve(); await successor;
      expect(h.sidebarMessages.filter(m => m.type === 'error' || m.type === 'requestCancelled')).toEqual([]);
      expect(h.sidebarMessages.filter(m => m.type === 'responseComplete')).toHaveLength(1);
      expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[2])).toEqual([activeInput.content, successorInput.content]);
      expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toHaveLength(1);
      expect(host._runningPanels.has('sidebar')).toBe(false);
    } finally { releaseWait(); await vi.advanceTimersByTimeAsync(51); await pending; await successor; await foreground; }
  });
  for (const route of ['ordinary', 'brainstorm'] as const) {
    it(`${route}: mutation of submitted metadata during preparation cannot change the validated file`, async () => {
      const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
      const input = payload(route);
      if (route === 'ordinary') {
        host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([wait.promise]);
        const original = host._handleSendMessageForTurn.bind(host);
        vi.spyOn(host, '_handleSendMessageForTurn').mockImplementation((...args: any[]) => { entered.resolve(); return original(...args); });
      } else {
        host._panelCompactions.set('sidebar', wait.promise);
        const original = host._waitForPanelCompaction.bind(host);
        vi.spyOn(host, '_waitForPanelCompaction').mockImplementation((...args: any[]) => { entered.resolve(); return original(...args); });
      }
      const pending = send(route, input);
      try {
        expect(await Promise.race([entered.promise.then(() => 'preparation'), pending.then(() => 'finished')])).toBe('preparation');
        input.mentions[0].value = b; input.mentions[0].displayName = '@' + JSON.stringify(b);
        input.content = input.content.replace('@' + JSON.stringify(a), '@' + JSON.stringify(b));
        wait.resolve(); await pending; assertAccepted(route);
      } finally { wait.resolve(); await pending; host._panelCompactions.delete('sidebar'); }
    });
    it(`${route}: invalid send cannot supersede an ordinary request waiting for settings`, async () => {
      const entered = deferred(), wait = deferred(); releaseWait = wait.resolve;
      host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([wait.promise]);
      const original = host._handleSendMessageForTurn.bind(host);
      vi.spyOn(host, '_handleSendMessageForTurn').mockImplementation((...args: any[]) => { entered.resolve(); return original(...args); });
      const pending = send('ordinary');
      try {
        expect(await Promise.race([entered.promise.then(() => 'preparation'), pending.then(() => 'finished')])).toBe('preparation');
        const generation = host._mystiRunGen.get('sidebar');
        await send(route, payload(route, '@' + JSON.stringify(a), b));
        expect(host._mystiRunGen.get('sidebar')).toBe(generation);
        expect(readPaths).toEqual([]); expect(texts()).toEqual([]); expect(h.persistedCalls).toEqual([]);
        expect(h.providerManager.cancelRequest).not.toHaveBeenCalled();
        expect(h.sidebarMessages.filter(m => m.type === 'error' || m.type === 'requestCancelled')).toEqual([]);
        expect(h.sidebarMessages.filter(m => m.type === 'systemNotice')).toHaveLength(1);
        wait.resolve(); await pending; assertAccepted('ordinary');
      } finally { wait.resolve(); await pending; }
    });
  }
});
