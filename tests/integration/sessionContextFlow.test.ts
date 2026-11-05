import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { createHarness, installEditorWindowFixture } from '../helpers/autoContextSendHarness';
import type { ContextItem, Settings } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  const deny = () => { throw new Error('Session context fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

const AGENTS = ['claude-code', 'openai-codex', 'google-gemini'];
const SETTINGS = { provider: 'claude-code', mode: 'quick-plan', accessLevel: 'read-only',
  contextMode: 'auto', thinkingLevel: 'none' } as Settings;
const AUTO_PATH = '/session/active.ts';
const AUTO = 'AUTO_ORIGINAL_UNSAVED';
const MANUAL: ContextItem = { id: 'manual', type: 'selection', path: '/session/manual.ts',
  content: 'MANUAL_ORIGINAL', startLine: 4, endLine: 6, language: 'typescript', enabled: true };
interface Wire { providerId: string; content: string; context: ContextItem[]; settings: Settings; panelId: string }
let h: ReturnType<typeof createHarness>;
let host: any;
let editors: ReturnType<typeof installEditorWindowFixture>;
let wire: Wire[];
let beforeWire: (record: Wire) => Promise<void>;
let afterWire: (record: Wire) => void;
let beforeReady: () => Promise<void>;
let cleanups: Array<() => void>;
function editor(content = AUTO, selection?: { content: string; start: number; end: number }) {
  return { selection: selection
    ? { isEmpty: false, start: { line: selection.start, character: 2 }, end: { line: selection.end, character: 5 } }
    : { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  document: { uri: vscode.Uri.file(AUTO_PATH), languageId: 'typescript', isClosed: false, isDirty: true,
    getText: (range?: unknown) => range && selection ? selection.content : content } };
}
function deferred() {
  let release!: () => void, announce!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { announce = resolve; });
  cleanups.push(release);
  return { entered, release, wait: () => { announce(); return paused; } };
}
async function reach(gate: ReturnType<typeof deferred>, pending: Promise<void>) {
  await Promise.race([gate.entered, pending.then(() => { throw new Error('Session ended before controlled wait'); })]);
}
function payload(shape = 'review', context = [structuredClone(MANUAL)], settings: Partial<Settings> = {}) {
  return { shape, context, brief: 'Inspect the submitted branch.', settings: { ...SETTINGS, ...settings },
    agentIds: shape === 'panel' || shape === 'critique' ? AGENTS : AGENTS.slice(0, 2) };
}
async function start(request = payload(), panelId = 'sidebar', claimedPanelId = panelId) {
  const owner = host._panelStates.get(panelId);
  await host._receivePanelMessage({ type: 'startSession', panelId: claimedPanelId, payload: request }, panelId, owner.webview);
  expect(h.sidebarMessages.filter(m => m.type === 'sessionError' || m.type === 'error')).toEqual([]);
}
async function stop(panelId = 'sidebar') {
  const owner = host._panelStates.get(panelId);
  await host._receivePanelMessage({ type: 'cancelRequest' }, panelId, owner.webview);
}
function assertPrivate(manual = [MANUAL], expectedUsers = 1) {
  const users = h.persistedCalls.filter(call => call[1] === 'user');
  expect(users).toHaveLength(expectedUsers);
  for (const call of users) { expect(call[3]).toEqual(manual); }
  expect(JSON.stringify(h.persistedCalls)).not.toContain(AUTO);
  expect(JSON.stringify(h.sidebarMessages)).not.toContain(AUTO);
  expect(JSON.stringify(h.contextManager.getContext('sidebar'))).not.toContain(AUTO);
  const state = h.extensionContext.workspaceState;
  expect(JSON.stringify(state.keys().map((key: string) => [key, state.get(key)]))).not.toContain(AUTO);
}
function assertContext(records: Wire[], automatic = AUTO) {
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record.content).toContain('MANUAL_ORIGINAL');
    expect(record.content).toContain(MANUAL.path);
    expect(record.content).toContain(automatic);
    expect(record.content).toContain(AUTO_PATH);
    expect(record.settings.accessLevel).toBe('read-only');
    expect(record.context).toEqual([]); // Session references are folded into the lane's fenced prompt.
  }
}
beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers(); cleanups = [];
  setMockConfig('autoContext', true); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Session context fixture forbids network'); }));
  editors = installEditorWindowFixture(); editors.activate(editor());
  h = createHarness(); host = h.provider as any;
  host._panelStates.get('sidebar').currentConversationId = 'session-conversation';
  h.conversationManager.getConversation = (id: string) => ({ id, messages: [], settings: SETTINGS });
  Object.assign(h.providerManager, {
    getAllProviderIds: () => AGENTS,
    getProviderDefaultModel: (id: string) => `${id}-fixture`,
    getProviderStatus: async () => { await beforeReady(); return { found: true, authenticated: true, path: '/unused' }; },
    cancelRequest: vi.fn(), disposePersistentProcessForProvider: vi.fn(),
    suspendRequest: () => false, resumeRequest: () => false,
    async *sendMessageToProvider(providerId: string, content: string, context: ContextItem[], settings: Settings,
      _conversation: unknown, _persona: unknown, panelId: string,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      // Host, SessionManager and pool are real. Only the final provider transport
      // is controlled; resolving after this wait models credential/preparation awaits.
      await beforeWire({ providerId, content, context, settings, panelId });
      const input = resolveInput ? resolveInput() : { content, context };
      if (!input) { return; }
      const record = { providerId, ...structuredClone(input), settings: structuredClone(settings), panelId };
      wire.push(record); afterWire(record);
      yield { type: 'text', content: '[{"title":"Deterministic lane result","severity":"low","location":"a.ts:1"}]' };
      yield { type: 'done' };
    },
  });
  wire = []; beforeWire = async () => {}; afterWire = () => {}; beforeReady = async () => {};
  host._lifecycleManager.markIdle = vi.fn();
});
afterEach(() => {
  for (const release of cleanups) { release(); }
  try { h?.dispose(); } finally {
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners();
  }
});

describe('user-started session context reaches the final collaborator request', () => {
  for (const [shape, count] of [['review', 2], ['panel', 3], ['race', 2], ['critique', 3], ['brainstorm', 4]] as const) {
    it(`${shape} sends explicit and automatic context to every lane without saving automatic bytes`, async () => {
      await start(payload(shape)); expect(wire).toHaveLength(count); assertContext(wire); assertPrivate();
      expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toHaveLength(1);
      expect(host._runningPanels.has('sidebar')).toBe(false);
    });
  }
  it('captures selection and manual bytes once before compaction, retaining raw stored range', async () => {
    const gate = deferred(); host._waitForPanelCompaction = gate.wait;
    editors.activate(editor('UNSELECTED_PRIVATE', { content: 'SELECTED_ORIGINAL', start: 8, end: 10 }));
    const request = payload(); const pending = start(request); await reach(gate, pending);
    request.context[0].content = 'MUTATED_MANUAL'; request.context[0].startLine = 90;
    editors.activate(editor('REPLACEMENT_BUFFER', { content: 'REPLACEMENT_SELECTION', start: 20, end: 22 }));
    gate.release(); await pending;
    assertContext(wire, 'SELECTED_ORIGINAL');
    for (const record of wire) {
      expect(record.content).not.toMatch(/UNSELECTED_PRIVATE|REPLACEMENT_|MUTATED_MANUAL/);
      expect(record.content).toContain('9-11');
      expect(record.content).toContain('5-7');
    }
    assertPrivate();
    expect(h.persistedCalls.find(c => c[1] === 'user')![3][0]).toMatchObject({ startLine: 4, endLine: 6 });
  });
  for (const phase of ['compaction', 'readiness', 'final provider preparation'] as const) {
    it(`disabling Auto during ${phase} removes only automatic context`, async () => {
      const gate = deferred();
      if (phase === 'compaction') { host._waitForPanelCompaction = gate.wait; }
      else if (phase === 'readiness') { beforeReady = gate.wait; }
      else { beforeWire = gate.wait; }
      const pending = start(); await reach(gate, pending); setMockConfig('autoContext', false);
      gate.release(); await pending;
      expect(wire).toHaveLength(2);
      for (const record of wire) { expect(record.content).toContain('MANUAL_ORIGINAL'); expect(record.content).not.toContain(AUTO); }
      assertPrivate();
    });
  }
  for (const shape of ['critique', 'brainstorm']) {
    it(`${shape} rechecks Auto for later phases while retaining the original request and manual context`, async () => {
      const firstCount = shape === 'critique' ? 1 : 2;
      afterWire = () => { if (wire.length === firstCount) { setMockConfig('autoContext', false); editors.activate(editor('LATER_EDITOR')); } };
      await start(payload(shape));
      assertContext(wire.slice(0, firstCount)); expect(wire.length).toBeGreaterThan(firstCount);
      for (const record of wire.slice(firstCount)) {
        expect(record.content).toContain('MANUAL_ORIGINAL'); expect(record.content).toContain('Inspect the submitted branch.');
        expect(record.content).not.toMatch(/AUTO_ORIGINAL_UNSAVED|LATER_EDITOR/);
        expect(record.content).toContain('Deterministic lane result');
      }
      assertPrivate();
    });
  }
  it('does not capture an editor retroactively when Auto was disabled at submission', async () => {
    setMockConfig('autoContext', false); const gate = deferred(); host._waitForPanelCompaction = gate.wait;
    const pending = start(); await reach(gate, pending); setMockConfig('autoContext', true); gate.release(); await pending;
    expect(wire).toHaveLength(2); for (const record of wire) {
      expect(record.content).toContain('MANUAL_ORIGINAL'); expect(record.content).not.toContain(AUTO);
    }
  });
  it('saved question context cannot mutate the private snapshot while a lane prepares', async () => {
    const gate = deferred(); beforeWire = gate.wait;
    const pending = start(); await reach(gate, pending);
    const savedContext = h.persistedCalls.find(call => call[1] === 'user')![3];
    savedContext[0].content = 'HISTORY_CONTEXT_MUTATION'; savedContext[0].startLine = 90;
    gate.release(); await pending;
    assertContext(wire);
    for (const record of wire) {
      expect(record.content).not.toContain('HISTORY_CONTEXT_MUTATION'); expect(record.content).toContain('5-7');
    }
  });
  it('respects a disabled explicit attachment for the active path', async () => {
    const disabled = { ...MANUAL, id: 'disabled', path: AUTO_PATH, content: 'DISABLED_EXPLICIT', enabled: false };
    await start(payload('review', [MANUAL, disabled]));
    expect(wire).toHaveLength(2); for (const record of wire) {
      expect(record.content).toContain('MANUAL_ORIGINAL'); expect(record.content).not.toMatch(/AUTO_ORIGINAL_UNSAVED|DISABLED_EXPLICIT/);
    }
    assertPrivate([MANUAL, disabled]);
  });
  it('internal session calls forward explicit context without acquiring the current editor', async () => {
    await host._handleStartSession(payload(), 'sidebar');
    expect(wire).toHaveLength(2); for (const record of wire) {
      expect(record.content).toContain('MANUAL_ORIGINAL'); expect(record.content).not.toContain(AUTO);
    }
    assertPrivate();
  });
  it('an explicit manual context mode sends manual context only', async () => {
    await start(payload('review', [MANUAL], { contextMode: 'manual' }));
    expect(wire).toHaveLength(2);
    for (const record of wire) { expect(record.content).toContain('MANUAL_ORIGINAL'); expect(record.content).not.toContain(AUTO); }
    assertPrivate();
  });
  it('a session without enabled references still sends its original brief', async () => {
    await start(payload('review', [], { contextMode: 'manual' }));
    expect(wire).toHaveLength(2);
    for (const record of wire) {
      expect(record.content).toContain('Inspect the submitted branch.'); expect(record.content).not.toContain(AUTO);
    }
    assertPrivate([]);
  });
  it('same-conversation navigation during compaction cancels the obsolete submission before persistence', async () => {
    const gate = deferred(); host._waitForPanelCompaction = gate.wait;
    const pending = start(); await reach(gate, pending); host._panelStates.get('sidebar').navigationRevision = 1;
    gate.release(); await pending;
    expect(wire).toEqual([]); expect(h.persistedCalls).toEqual([]); expect(host._runningPanels.has('sidebar')).toBe(false);
  });
  it('same-conversation navigation during final preparation cancels all lanes and releases its own busy state', async () => {
    const gate = deferred(); beforeWire = gate.wait;
    const pending = start(); await reach(gate, pending); const owner = host._panelStates.get('sidebar');
    await host._receivePanelMessage({ type: 'switchConversation', payload: { id: owner.currentConversationId } }, 'sidebar', owner.webview);
    expect(owner.navigationRevision).toBe(1);
    const messagesBefore = h.sidebarMessages.length; gate.release(); await pending;
    expect(wire).toEqual([]); expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
    expect(h.sidebarMessages.slice(messagesBefore).filter(m => ['sessionEvent', 'responseComplete', 'sessionError'].includes(m.type))).toEqual([]);
    expect(host._runningPanels.has('sidebar')).toBe(false); expect(host._lifecycleManager.markIdle).toHaveBeenCalledWith('sidebar');
  });
  it('a replaced owner cannot receive the old session result or have its busy state cleared', async () => {
    const gate = deferred(); beforeWire = gate.wait;
    const pending = start(); await reach(gate, pending);
    const owner = host._panelStates.get('sidebar'); const replacementPosts = vi.fn(async () => true);
    host._panelStates.set('sidebar', { ...owner, webview: { postMessage: replacementPosts } });
    host._lifecycleManager.markIdle.mockClear(); gate.release(); await pending;
    expect(wire).toEqual([]); expect(replacementPosts).not.toHaveBeenCalled();
    expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
    expect(host._runningPanels.has('sidebar')).toBe(true); expect(host._lifecycleManager.markIdle).not.toHaveBeenCalled();
  });
  it('Stop prevents pending final requests and a subsequent session still succeeds', async () => {
    const gate = deferred(); beforeWire = gate.wait;
    const pending = start(); await reach(gate, pending); await stop(); gate.release(); await pending;
    expect(wire).toEqual([]); expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
    expect(host._runningPanels.has('sidebar')).toBe(false);
    beforeWire = async () => {}; await start(); expect(wire).toHaveLength(2); assertContext(wire);
    expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toHaveLength(1);
  });
  it('binds the emitting panel, retaining sibling captures and manual context independently', async () => {
    const siblingMessages: unknown[] = [];
    host._panelStates.set('sibling', { id: 'sibling', currentConversationId: 'sibling-conversation', navigationRevision: 0,
      webview: { postMessage: async (message: unknown) => { siblingMessages.push(message); return true; } } });
    const gate = deferred(); beforeWire = record => record.panelId.startsWith('sidebar-') ? gate.wait() : Promise.resolve();
    const first = start(); await reach(gate, first);
    editors.activate(editor('SIBLING_AUTO'));
    await start(payload('review', [{ ...MANUAL, content: 'SIBLING_MANUAL' }]), 'sibling', 'sidebar');
    const sibling = wire.slice(); expect(sibling).toHaveLength(2);
    expect(sibling.every(r => r.panelId.startsWith('sibling-') && r.content.includes('SIBLING_AUTO') && r.content.includes('SIBLING_MANUAL'))).toBe(true);
    expect(sibling.every(r => !r.content.includes(AUTO) && !r.content.includes('MANUAL_ORIGINAL'))).toBe(true);
    gate.release(); await first; assertContext(wire.slice(2));
    expect(JSON.stringify(siblingMessages)).not.toContain('SIBLING_AUTO');
    expect(host._runningPanels.size).toBe(0);
  });
  it('an obsolete pending session cannot send or clear a newer session busy state', async () => {
    const old = deferred(), next = deferred(); let which = old;
    beforeWire = () => which.wait();
    const first = start(); await reach(old, first); which = next;
    const second = start(); await reach(next, second); old.release(); await first;
    expect(wire).toEqual([]); expect(host._runningPanels.has('sidebar')).toBe(true);
    expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toEqual([]);
    next.release(); await second; expect(wire).toHaveLength(2); assertContext(wire);
    expect(h.persistedCalls.filter(c => c[1] === 'assistant')).toHaveLength(1);
    expect(host._runningPanels.has('sidebar')).toBe(false);
  });
});
