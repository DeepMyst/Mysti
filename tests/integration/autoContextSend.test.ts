import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BaseCliProvider } from '../../src/providers/base/BaseCliProvider';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { ContextItem, Settings } from '../../src/types';
import { clearConfigurationListeners, clearMockConfig, fireConfigurationChange, setMockConfig } from '../helpers/mockVscode';
import { createHarness, installEditorWindowFixture } from '../helpers/autoContextSendHarness';

// The existing host fixture already substitutes model-independent auxiliary
// managers. Also forbid its classifier from warming Claude subprocesses.
vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
    dispose() { /* This fixture owns no classifier process or timer. */ }
  },
}));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  const deny = () => { throw new Error('EW03 fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny,
    execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

const SETTINGS: Settings = { provider: 'claude-code', model: 'claude-opus-4-6',
  mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'auto' };
const QUESTION = 'Explain the current code.';
const win = vscode.window as any;
let editors: ReturnType<typeof installEditorWindowFixture>;
interface SendOptions {
  context?: ContextItem[];
  settings?: Partial<Settings>;
  panelId?: string;
  claimedPanelId?: string;
  sender?: unknown;
  secondOpinion?: unknown;
}
type CapturingHarness = ReturnType<typeof createHarness> & {
  host: any;
  captures: Captured[];
  send: (options?: SendOptions) => Promise<void>;
  holdBeforeDelivery: (doneOnRevocation?: boolean) => { entered: Promise<void>; release: () => void };
  holdAfterFirstText: () => { entered: Promise<void>; release: () => void };
};
let current: CapturingHarness | undefined;

interface Captured {
  panelId: string;
  context: ContextItem[];
  prompt: string;
  settled: boolean;
}

function editor(name: string, full: string, selected?: { content: string; start: number; end: number }) {
  const selection = selected
    ? { isEmpty: false, start: { line: selected.start, character: 0 }, end: { line: selected.end, character: 0 } }
    : { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return { selection, selections: [selection], document: {
    uri: vscode.Uri.file(`/owned-ew03/${name}.ts`), languageId: 'typescript',
    isDirty: true, isUntitled: false, isClosed: false, version: 1,
    getText: (range?: unknown) => range && selected ? selected.content : full,
  } };
}

function harness(): CapturingHarness {
  const h = createHarness();
  const host = h.provider as any;
  const captures: Captured[] = [];
  let afterFirstText = () => Promise.resolve();
  let beforeDelivery = () => Promise.resolve();
  let doneOnRevocation = false;
  // Only the provider's response transport is substituted. The actual manager
  // routes the bound panel, and the production asynchronous prompt builder
  // formats exactly the context it receives. No HTTP/CLI provider is started.
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), {
    id: 'claude-code', displayName: 'EW03 in-memory responder',
    capabilities: { supportsImages: false, supportsFileAttachments: false },
    _nativeHistoryDeltas: new WeakSet(),
  });
  const responder = {
    id: 'claude-code',
    async *sendMessage(content: string, context: ContextItem[], settings: Settings,
      conversation: unknown, persona: unknown, panelId: string, _manager: unknown,
      agentConfig: unknown, attachments: unknown,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      // Model the shared provider's final resolver after asynchronous setup.
      // Its actual stdin-boundary behavior is covered by providerInputResolution.
      await beforeDelivery();
      if (resolveInput) {
        const input = resolveInput();
        if (!input) { if (doneOnRevocation) { yield { type: 'done' }; } return; }
        ({ content, context } = input);
      }
      const prompt = await builder.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, attachments);
      const record = { panelId, context: structuredClone(context), prompt, settled: false };
      captures.push(record);
      try {
        yield { type: 'text', content: 'Owned deterministic response.' };
        await afterFirstText();
        yield { type: 'done' };
      } finally { record.settled = true; }
    },
  };
  const router = Object.assign(Object.create(ProviderManager.prototype), {
    _registry: { get: (id: string) => id === responder.id ? responder : undefined },
    _panelProviders: new Map(),
  });
  h.providerManager.sendMessage = ProviderManager.prototype.sendMessage.bind(router);
  const send = async (options: SendOptions = {}) => {
    const panelId = options.panelId ?? 'sidebar';
    const owner = host._panelStates.get(panelId);
    const payload = { content: QUESTION, context: options.context ?? [], settings: { ...SETTINGS, ...options.settings },
      ...(options.secondOpinion ? { secondOpinion: options.secondOpinion } : {}) };
    await host._receivePanelMessage({ type: 'sendMessage', panelId: options.claimedPanelId ?? panelId, payload },
      panelId, options.sender ?? owner?.webview);
    expect(h.sidebarMessages.filter(message => message.type === 'error')).toEqual([]);
  };
  const holdAfterFirstText = () => {
    let announce!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    afterFirstText = () => { announce(); return paused; };
    return { entered, release };
  };
  const holdBeforeDelivery = (terminalOnly = false) => {
    doneOnRevocation = terminalOnly;
    let announce!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    beforeDelivery = () => { announce(); return paused; };
    return { entered, release };
  };
  current = { ...h, host, captures, send, holdAfterFirstText, holdBeforeDelivery };
  return current;
}

async function manual(h: ReturnType<typeof harness>, panelId = 'sidebar') {
  return await h.contextManager.addSelectionToContext(`/owned-ew03/${panelId}-manual.ts`,
    `MANUAL_${panelId}_KEEP`, 30, 31, 'typescript', panelId);
}
function onlyCapture(h: ReturnType<typeof harness>): Captured {
  expect(h.captures).toHaveLength(1);
  expect(h.captures[0].settled).toBe(true);
  return h.captures[0];
}

function retrievalGate(h: CapturingHarness) {
  let release!: (content: string) => void, announce!: () => void;
  const paused = new Promise<string>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { announce = resolve; });
  h.host._compactionManager.retrieveContext = vi.fn(() => { announce(); return paused; });
  return { entered, release: () => release('') };
}

beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers();
  setMockConfig('autoContext', true); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  editors = installEditorWindowFixture();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('EW03 fixture forbids network'); }));
});
afterEach(() => {
  const receipt = { case: expect.getState().currentTestName, captures: current?.captures ?? [],
    errors: current?.sidebarMessages.filter(message => message.type === 'error') ?? [] };
  try {
    if (process.env.EW03_AUTO_CONTEXT_RECEIPT) appendFileSync(process.env.EW03_AUTO_CONTEXT_RECEIPT, JSON.stringify(receipt) + '\n');
  } finally {
    try { current?.dispose(); } finally {
      current = undefined; editors.restore();
      vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
      clearMockConfig(); clearConfigurationListeners();
    }
  }
});

describe('EW03 ordinary composer context reaches the production prompt builder', () => {
  it('includes an already-open unsaved buffer on the first submit without needing an editor event', async () => {
    editors.activate(editor('initial', 'INITIAL_UNSAVED_BUFFER'));
    const h = harness(); await h.send(); const captured = onlyCapture(h);
    expect(captured.context).toEqual([expect.objectContaining({ type: 'file', path: '/owned-ew03/initial.ts',
      content: 'INITIAL_UNSAVED_BUFFER', language: 'typescript' })]);
    expect(captured.prompt).toContain('## /owned-ew03/initial.ts\n```typescript\nINITIAL_UNSAVED_BUFFER\n```');
    expect(h.contextManager.getContext('sidebar')).toEqual([]);
    expect(h.extensionContext.workspaceState.get('mysti.context:sidebar')).toBeUndefined();
    expect(h.persistedCalls.filter(call => call[1] === 'user').map(call => call[3])).toEqual([[]]);
    expect(h.sidebarMessages.filter(message => message.type === 'messageAdded').map(message => message.payload.context)).toEqual([[]]);
    expect(h.host._lastMentionContext.size).toBe(0);
  });

  it('prefers the exact selected bytes and range over the unselected buffer', async () => {
    editors.activate(editor('selection', 'OUTSIDE_SELECTION_MUST_NOT_ENTER',
      { content: 'selected\nbytes 🧪', start: 4, end: 7 }));
    const h = harness(); await h.send(); const captured = onlyCapture(h);
    expect(captured.context).toEqual([expect.objectContaining({ type: 'selection', path: '/owned-ew03/selection.ts',
      content: 'selected\nbytes 🧪', startLine: 4, endLine: 7, endCharacter: 0, language: 'typescript' })]);
    expect(captured.prompt).toContain('Selection from /owned-ew03/selection.ts (lines 5-7)');
    expect(captured.prompt).toContain('```typescript\nselected\nbytes 🧪\n```');
    expect(captured.prompt).not.toContain('OUTSIDE_SELECTION_MUST_NOT_ENTER');
  });

  for (const boundary of ['global setting', 'panel manual mode'] as const) {
    it(`excludes automatic bytes when the ${boundary} is off while preserving explicit context`, async () => {
      if (boundary === 'global setting') setMockConfig('autoContext', false);
      editors.activate(editor('private', 'PRIVATE_EDITOR_CANARY'));
      const h = harness(); const explicit = await manual(h);
      await h.send({ context: [explicit], settings: { contextMode: boundary === 'panel manual mode' ? 'manual' : 'auto' } });
      const captured = onlyCapture(h);
      expect(captured.context).toEqual([explicit]); expect(captured.prompt).toContain('MANUAL_sidebar_KEEP');
      expect(captured.prompt).not.toContain('PRIVATE_EDITOR_CANARY');
    });
  }

  it('honors live configuration changes even when the composer settings and manager started in Auto', async () => {
    const h = harness(); const explicit = await manual(h);
    setMockConfig('autoContext', false); fireConfigurationChange('mysti.autoContext');
    editors.activate(editor('disabled', 'DISABLED_CANARY')); await h.send({ context: [explicit] });
    setMockConfig('autoContext', true); fireConfigurationChange('mysti.autoContext');
    editors.activate(editor('enabled', 'ENABLED_CANARY')); await h.send({ context: [explicit] });
    expect(h.captures).toHaveLength(2);
    expect(h.captures[0].context).toEqual([explicit]); expect(h.captures[0].prompt).not.toContain('DISABLED_CANARY');
    expect(h.captures[1].prompt).toContain('ENABLED_CANARY'); expect(h.captures[1].prompt).toContain('MANUAL_sidebar_KEEP');
    expect(h.contextManager.getContext('sidebar')).toEqual([explicit]);
  });

  it('uses the latest editor per submit and drops automatic context when no editor remains', async () => {
    const h = harness(); const explicit = await manual(h);
    for (const active of [editor('a', 'EDITOR_A_CANARY'), editor('b', 'EDITOR_B_CANARY'), undefined]) {
      editors.activate(active); await h.send({ context: [explicit] });
    }
    expect(h.captures).toHaveLength(3);
    expect(h.captures[0].prompt).toContain('EDITOR_A_CANARY'); expect(h.captures[0].prompt).not.toContain('EDITOR_B_CANARY');
    expect(h.captures[1].prompt).toContain('EDITOR_B_CANARY'); expect(h.captures[1].prompt).not.toContain('EDITOR_A_CANARY');
    expect(h.captures[2].context).toEqual([explicit]); expect(h.captures[2].prompt).not.toMatch(/EDITOR_[AB]_CANARY/);
    expect(h.contextManager.getContext('sidebar')).toEqual([explicit]);
  });

  it('captures the original submit before preparation waits and keeps its bound owner', async () => {
    const h = harness(); const explicit = await manual(h), sibling = await manual(h, 'sibling');
    h.host._panelStates.set('sibling', { id: 'sibling', currentConversationId: null, webview: { postMessage: vi.fn() } });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([wait]);
    editors.activate(editor('original', 'ORIGINAL_SUBMIT_CANARY'));
    const pending = h.send({ context: [explicit], claimedPanelId: 'sibling' });
    editors.activate(editor('later', 'LATER_SIBLING_CANARY'));
    try { release(); await pending; } finally { release(); await pending; }
    const captured = onlyCapture(h);
    expect(captured.panelId).toBe('sidebar'); expect(captured.prompt).toContain('ORIGINAL_SUBMIT_CANARY');
    expect(captured.prompt).not.toContain('LATER_SIBLING_CANARY'); expect(captured.prompt).not.toContain('MANUAL_sibling_KEEP');
    expect(h.contextManager.getContext('sibling')).toEqual([sibling]);
    await h.send({ sender: {} }); expect(h.captures).toHaveLength(1);
  });

  it('revokes only the automatic snapshot if global Auto is disabled during preparation', async () => {
    const h = harness(); const explicit = await manual(h);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([wait]);
    editors.activate(editor('revoked', 'REVOKED_AUTO_CANARY'));
    const pending = h.send({ context: [explicit] });
    setMockConfig('autoContext', false); fireConfigurationChange('mysti.autoContext');
    try { release(); await pending; } finally { release(); await pending; }
    const captured = onlyCapture(h); expect(captured.context).toEqual([explicit]);
    expect(captured.prompt).not.toContain('REVOKED_AUTO_CANARY'); expect(captured.prompt).toContain('MANUAL_sidebar_KEEP');
  });

  it('does not acquire a new snapshot when Auto is enabled after the original submit', async () => {
    setMockConfig('autoContext', false);
    const h = harness(); const explicit = await manual(h);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([wait]);
    editors.activate(editor('initially-disabled', 'INITIAL_DISABLED_CANARY'));
    const pending = h.send({ context: [explicit] });
    setMockConfig('autoContext', true); fireConfigurationChange('mysti.autoContext');
    editors.activate(editor('later-enabled', 'LATER_ENABLED_CANARY'));
    try { release(); await pending; } finally { release(); await pending; }
    const captured = onlyCapture(h); expect(captured.context).toEqual([explicit]);
    expect(captured.prompt).not.toMatch(/INITIAL_DISABLED_CANARY|LATER_ENABLED_CANARY/);
  });

  it('rechecks live disabling after a late retrieval wait and preserves manual context', async () => {
    const h = harness(); const explicit = await manual(h); const gate = retrievalGate(h);
    editors.activate(editor('late-disabled', 'LATE_DISABLED_EDITOR_CANARY'));
    const pending = h.send({ context: [explicit] });
    try {
      await Promise.race([gate.entered, pending.then(() => { throw new Error('Send ended before the retrieval fixture'); })]);
      setMockConfig('autoContext', false); fireConfigurationChange('mysti.autoContext');
      gate.release(); await pending;
      const captured = onlyCapture(h); expect(captured.context).toEqual([explicit]);
      expect(captured.prompt).toContain('MANUAL_sidebar_KEEP');
      expect(captured.prompt).not.toContain('LATE_DISABLED_EDITOR_CANARY');
    } finally { gate.release(); await pending; }
  });

  for (const enabled of [true, false]) {
    it(`respects explicit same-path context precedence when the manual item is ${enabled ? 'enabled' : 'disabled'}`, async () => {
      const h = harness();
      editors.activate(editor('same-path', 'AUTO_SAME_PATH_CANARY'));
      const explicit = await h.contextManager.addSelectionToContext('/owned-ew03/same-path.ts',
        'MANUAL_SAME_PATH_CANARY', 3, 6, 'typescript', 'sidebar');
      h.contextManager.setItemEnabled(explicit.id, enabled, 'sidebar');
      await h.send({ context: [explicit] }); const captured = onlyCapture(h);
      expect(captured.context).toEqual([explicit]); expect(captured.prompt).not.toContain('AUTO_SAME_PATH_CANARY');
      if (enabled) expect(captured.prompt).toContain('MANUAL_SAME_PATH_CANARY');
      else expect(captured.prompt).not.toContain('MANUAL_SAME_PATH_CANARY');
      expect(h.contextManager.getContext('sidebar')).toEqual([explicit]);
    });
  }

  for (const change of ['navigation', 'conversation', 'replacement', 'close'] as const) {
    it(`does not dispatch an obsolete submit after owner ${change} during late preparation`, async () => {
      const h = harness(); const gate = retrievalGate(h);
      const owner = h.host._panelStates.get('sidebar');
      editors.activate(editor('obsolete', 'OBSOLETE_OWNER_CANARY'));
      const pending = h.send();
      try {
        await Promise.race([gate.entered, pending.then(() => { throw new Error('Send ended before the retrieval fixture'); })]);
        if (change === 'navigation') owner.navigationRevision = (owner.navigationRevision ?? 0) + 1;
        else if (change === 'conversation') owner.currentConversationId = 'replacement-conversation';
        else if (change === 'replacement') h.host._panelStates.set('sidebar', { ...owner, webview: { postMessage: vi.fn() } });
        else h.host._panelStates.delete('sidebar');
        editors.activate(editor('successor', 'SUCCESSOR_EDITOR_CANARY'));
        gate.release(); await pending;
        expect(h.captures).toEqual([]);
        if (change === 'navigation') {
          expect(h.host._runningPanels.has('sidebar')).toBe(false);
          expect(h.sidebarMessages.filter(message => message.type === 'requestCancelled')).toHaveLength(1);
        }
      } finally { gate.release(); await pending; }
    });
  }

  it('does not attach the local editor to an internal continuation using the shared send method', async () => {
    const h = harness(); const explicit = await manual(h);
    editors.activate(editor('unrelated', 'UNRELATED_LOCAL_EDITOR'));
    await h.host._handleSendMessage({ content: QUESTION, context: [explicit], settings: { ...SETTINGS } }, 'sidebar');
    const captured = onlyCapture(h); expect(captured.context).toEqual([explicit]);
    expect(captured.prompt).not.toContain('UNRELATED_LOCAL_EDITOR');
  });

  it('a second opinion keeps the original question context without the current editor', async () => {
    const h = harness(); const explicit = await manual(h);
    editors.activate(editor('unrelated', 'UNRELATED_OPINION_EDITOR'));
    const source = { id: 'original-question', role: 'user', content: 'Original question.', context: [explicit] };
    const conversation = { id: 'owned-conversation', messages: [source] };
    h.host._panelStates.get('sidebar').currentConversationId = conversation.id;
    h.conversationManager.getConversation = () => conversation;
    h.providerManager.getProvider = () => ({ defaultModel: SETTINGS.model });
    h.providerManager.getModels = () => [{ id: SETTINGS.model }];
    await h.send({ secondOpinion: { provider: SETTINGS.provider, messageId: source.id } });
    const captured = onlyCapture(h); expect(captured.context).toEqual([explicit]);
    expect(captured.prompt).toContain('Original question.'); expect(captured.prompt).not.toContain('UNRELATED_OPINION_EDITOR');
  });

  it('opening a real host tab retains the visible editor when creation synchronously clears activeTextEditor', async () => {
    const active = editor('open-tab', 'OPEN_TAB_UNSAVED_CANARY'); editors.activate(active);
    const h = harness(); const panels = editors.installDetachedPanels(h.host);
    const panelId = h.host.openInNewTab();
    expect(win.activeTextEditor).toBeUndefined(); expect(win.visibleTextEditors).toEqual([active]);
    expect(panels).toHaveLength(1); expect(h.host._panelStates.get(panelId).panel).toBe(panels[0]);
    await h.send({ panelId }); const captured = onlyCapture(h);
    expect(captured.panelId).toBe(panelId); expect(captured.prompt).toContain('OPEN_TAB_UNSAVED_CANARY');
    expect(h.contextManager.getContext(panelId)).toEqual([]);
  });

  it('an existing tab consumes the last code-editor event through its registered focus callback', async () => {
    const initial = editor('before-focus', 'BEFORE_FOCUS_CANARY'); editors.activate(initial);
    const h = harness(); const panels = editors.installDetachedPanels(h.host);
    const panelId = h.host.openInNewTab();
    const latest = editor('after-focus', 'AFTER_FOCUS_CANARY');
    editors.activate(latest, [initial, latest]); panels[0].focus();
    expect(win.activeTextEditor).toBeUndefined();
    await h.send({ panelId }); const captured = onlyCapture(h);
    expect(captured.prompt).toContain('AFTER_FOCUS_CANARY'); expect(captured.prompt).not.toContain('BEFORE_FOCUS_CANARY');
  });

  it('switching between two real host tabs preserves their separate visible editor identities', async () => {
    const a = editor('tab-a', 'TAB_A_CONTEXT'), b = editor('tab-b', 'TAB_B_CONTEXT');
    editors.activate(a, [a, b]);
    const h = harness(); const panels = editors.installDetachedPanels(h.host);
    const panelA = h.host.openInNewTab();
    editors.activate(b, [a, b]); const panelB = h.host.openInNewTab();
    for (const [index, panelId] of [[0, panelA], [1, panelB], [0, panelA]] as const) {
      panels[index].focus(); expect(win.activeTextEditor).toBeUndefined(); await h.send({ panelId });
    }
    expect(h.captures.map(capture => capture.panelId)).toEqual([panelA, panelB, panelA]);
    for (const [index, expected, forbidden] of [[0, 'TAB_A_CONTEXT', 'TAB_B_CONTEXT'],
      [1, 'TAB_B_CONTEXT', 'TAB_A_CONTEXT'], [2, 'TAB_A_CONTEXT', 'TAB_B_CONTEXT']] as const) {
      expect(h.captures[index].prompt).toContain(expected); expect(h.captures[index].prompt).not.toContain(forbidden);
    }
    expect(h.contextManager.getContext(panelA)).toEqual([]); expect(h.contextManager.getContext(panelB)).toEqual([]);
  });

  for (const change of ['closed', 'hidden'] as const) {
    it(`drops an editor that becomes ${change} before its chat submits`, async () => {
      const active = editor('unavailable', 'UNAVAILABLE_EDITOR_CANARY'); editors.activate(active);
      const h = harness(); const panels = editors.installDetachedPanels(h.host);
      const panelId = h.host.openInNewTab();
      if (change === 'closed') active.document.isClosed = true;
      else editors.setVisible([]);
      panels[0].focus(); await h.send({ panelId });
      const captured = onlyCapture(h); expect(captured.context).toEqual([]);
      expect(captured.prompt).not.toContain('UNAVAILABLE_EDITOR_CANARY');
    });
  }

  it('does not choose an arbitrary visible editor when the chat never received a code handoff', async () => {
    const unrelated = editor('unclaimed', 'UNCLAIMED_VISIBLE_CANARY');
    editors.setVisible([unrelated]);
    const h = harness(); editors.installDetachedPanels(h.host);
    const panelId = h.host.openInNewTab();
    expect(win.activeTextEditor).toBeUndefined(); await h.send({ panelId });
    const captured = onlyCapture(h); expect(captured.context).toEqual([]);
    expect(captured.prompt).not.toContain('UNCLAIMED_VISIBLE_CANARY');
  });

  it('a focused-tab selection is immutable after submit while preparation waits', async () => {
    const selected = editor('selection-snapshot', 'WHOLE_BUFFER_NOT_SELECTED',
      { content: 'ORIGINAL_SELECTED_BYTES', start: 2, end: 4 });
    editors.activate(selected);
    const h = harness(); editors.installDetachedPanels(h.host);
    const panelId = h.host.openInNewTab();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.host._panelStates.get(panelId).pendingSettingsUpdates = new Set([wait]);
    const pending = h.send({ panelId });
    selected.document.getText = () => 'CHANGED_SELECTED_BYTES';
    selected.selection.start.line = 8; selected.selection.end.line = 10;
    try { release(); await pending; } finally { release(); await pending; }
    const captured = onlyCapture(h);
    expect(captured.context).toEqual([expect.objectContaining({ type: 'selection', content: 'ORIGINAL_SELECTED_BYTES',
      startLine: 2, endLine: 4, endCharacter: 0 })]);
    expect(captured.prompt).toContain('ORIGINAL_SELECTED_BYTES');
    expect(captured.prompt).not.toMatch(/CHANGED_SELECTED_BYTES|WHOLE_BUFFER_NOT_SELECTED/);
  });

  it('same-conversation navigation after streaming starts still completes and releases the busy state', async () => {
    editors.activate(editor('streaming', 'STREAMING_CONTEXT_CANARY'));
    const h = harness(); const gate = h.holdAfterFirstText();
    const owner = h.host._panelStates.get('sidebar');
    const conversation = { id: 'streaming-conversation', messages: [] };
    owner.currentConversationId = conversation.id;
    h.conversationManager.getConversation = () => conversation;
    const pending = h.send();
    try {
      await Promise.race([gate.entered, pending.then(() => { throw new Error('Send ended before the streaming fixture'); })]);
      expect(h.sidebarMessages.some(message => message.type === 'responseChunk')).toBe(true);
      await h.host._receivePanelMessage({ type: 'switchConversation', payload: { id: conversation.id } },
        'sidebar', owner.webview);
      expect(owner.navigationRevision).toBe(1);
      gate.release(); await pending;
      expect(h.sidebarMessages.filter(message => message.type === 'responseComplete')).toHaveLength(1);
      expect(h.host._runningPanels.has('sidebar')).toBe(false);
      expect(onlyCapture(h).prompt).toContain('STREAMING_CONTEXT_CANARY');
    } finally { gate.release(); await pending; }
  });
  it.each([false, true])('same-conversation navigation during provider preparation cancels without a stream error (terminal-only=%s)', async terminalOnly => {
    editors.activate(editor('preparing', 'PREPARING_CONTEXT_CANARY'));
    const h = harness(); const gate = h.holdBeforeDelivery(terminalOnly);
    const owner = h.host._panelStates.get('sidebar');
    const conversation = { id: 'preparing-conversation', messages: [] };
    owner.currentConversationId = conversation.id;
    h.conversationManager.getConversation = () => conversation;
    const pending = h.send();
    try {
      await Promise.race([gate.entered, pending.then(() => { throw new Error('Send ended before preparation'); })]);
      await h.host._receivePanelMessage({ type: 'switchConversation', payload: { id: conversation.id } }, 'sidebar', owner.webview);
      gate.release(); await pending;
      expect(h.captures).toEqual([]);
      expect(h.sidebarMessages.filter(m => m.type === 'requestCancelled')).toHaveLength(1);
      expect(h.sidebarMessages.some(m => m.type === 'responseComplete')).toBe(false);
      expect(h.host._runningPanels.has('sidebar')).toBe(false);
    } finally { gate.release(); await pending; }
  });
  it('disabling Auto during provider preparation still sends the manual context', async () => {
    editors.activate(editor('preparing', 'PREPARING_CONTEXT_CANARY'));
    const h = harness(); const explicit = await manual(h); const gate = h.holdBeforeDelivery();
    const pending = h.send({ context: [explicit] });
    try {
      await Promise.race([gate.entered, pending.then(() => { throw new Error('Send ended before preparation'); })]);
      setMockConfig('autoContext', false); gate.release(); await pending;
      expect(onlyCapture(h).prompt).not.toContain('PREPARING_CONTEXT_CANARY');
      expect(onlyCapture(h).prompt).toContain('MANUAL_sidebar_KEEP');
    } finally { gate.release(); await pending; }
  });

});
