import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { createHarness, installEditorWindowFixture } from '../helpers/autoContextSendHarness';
import type { ContextItem, Settings } from '../../src/types';
import type { GatewayChatMessage } from '../../src/services/DeepMystGatewayClient';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  const deny = () => { throw new Error('EW03 route fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});
const settings = { provider: 'mysti', mode: 'quick-plan', accessLevel: 'read-only', contextMode: 'auto', thinkingLevel: 'none' } as unknown as Settings;
const manual: ContextItem = { id: 'manual', type: 'file', path: '/owned/manual.ts', content: 'MANUAL_KEEP', enabled: true };
const automatic: ContextItem = { id: 'auto', type: 'file', path: '/owned/current.ts', content: 'AUTO_CAPTURED', enabled: true };
let h: ReturnType<typeof createHarness>;
let host: any;
let editors: ReturnType<typeof installEditorWindowFixture>;
let canonical: GatewayChatMessage[][];
let sent: GatewayChatMessage[][];
let beforeWire: () => Promise<void>;
let respond: (index: number) => any[];
function text(messages: GatewayChatMessage[]) { return messages.map(m => m.content).join('\n'); }
function deferred() {
  let release!: () => void, enter!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { entered, release, wait: () => { enter(); return waiting; } };
}
function resolver() { return host._withComposerEditorContext([manual], { item: automatic, isCurrent: () => true }); }
async function send(content = 'Explain this code.', mentions?: any[]) {
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type: 'sendMessage', payload: { content, settings, context: [manual], mentions } }, 'sidebar', owner.webview);
  const errors = h.sidebarMessages.filter(m => m.type === 'error');
  if (errors.length) { throw new Error(JSON.stringify(errors)); }
}
function assertPrivate() {
  expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[3])).toEqual([[manual]]);
  expect(JSON.stringify(h.sidebarMessages)).not.toContain('AUTO_CAPTURED');
  expect(canonical.every(m => !text(m).includes('AUTO_CAPTURED'))).toBe(true);
}
beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers();
  setMockConfig('autoContext', true); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  editors = installEditorWindowFixture();
  editors.activate({ selection: { isEmpty: true }, document: { uri: vscode.Uri.file(automatic.path),
    languageId: 'typescript', isClosed: false, getText: () => automatic.content } });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('EW03 route fixture forbids network'); }));
  h = createHarness(); host = h.provider as any;
  h.providerManager.getAllProviderIds = () => ['claude-code'];
  h.providerManager.captureNativeApprovalHandler = () => undefined;
  host._panelStates.get('sidebar').currentConversationId = 'conversation';
  h.conversationManager.getConversation = () => ({ id: 'conversation', messages: [], settings });
  canonical = []; sent = []; beforeWire = async () => undefined;
  respond = () => [{ text: 'Deterministic response.' }, { done: true, model: 'owned-test' }];
  host._mystiCoordinator = {
    status: () => ({ ready: true }), resolveCoordinatorModel: async () => 'owned-test',
    supportsToolCalls: async () => false, contextWindowOf: async () => undefined,
    async *stream(messages: GatewayChatMessage[], options: any) {
      canonical.push(structuredClone(messages));
      await beforeWire();
      if (options.isCancelled?.() || options.signal?.aborted) { return; }
      sent.push(structuredClone(options.resolveMessages?.() ?? messages));
      for (const event of respond(sent.length - 1)) { yield event; }
    },
  };
  host._mystiMcpToolset = async () => null;
  host._mystiVisualEnabled = () => ({ look: false, act: false });
  host._mystiSkillsEnabled = () => false;
  host._buildMystiProjectBrain = async () => 'OWNED_PROJECT_BRAIN';
  host._collaboratorPool = { disposeRun() {}, dispose() {}, cancelPanel() {} };
});
afterEach(() => {
  try { h?.dispose(); } finally {
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners();
  }
});

describe('EW03 host routes retain a private capture until each dispatch', () => {
  it('sends the original editor to the coordinator without persisting it', async () => {
    await send(); expect(sent).toHaveLength(1); expect(text(sent[0])).toContain('AUTO_CAPTURED');
    expect(text(sent[0])).toContain('MANUAL_KEEP'); expect(text(sent[0])).toContain('OWNED_PROJECT_BRAIN');
    assertPrivate(); expect(host._runningPanels.has('sidebar')).toBe(false);
  });
  it('rechecks Auto Context after project-brain preparation', async () => {
    const gate = deferred(); host._buildMystiProjectBrain = async () => { await gate.wait(); return 'BRAIN'; };
    const pending = send(); await Promise.race([gate.entered, pending.then(() => { throw new Error('send ended before preparation gate'); })]); setMockConfig('autoContext', false); gate.release(); await pending;
    expect(sent).toHaveLength(1); expect(text(sent[0])).not.toContain('AUTO_CAPTURED');
    expect(text(sent[0])).toContain('MANUAL_KEEP'); assertPrivate();
  });
  it('rechecks Auto Context after the coordinator accepts a queued request', async () => {
    const gate = deferred(); beforeWire = gate.wait;
    const pending = send(); await Promise.race([gate.entered, pending.then(() => { throw new Error('send ended before preparation gate'); })]); setMockConfig('autoContext', false); gate.release(); await pending;
    expect(sent).toHaveLength(1); expect(text(sent[0])).not.toContain('AUTO_CAPTURED'); assertPrivate();
  });
  it('never reacquires an editor while waiting to send', async () => {
    const gate = deferred(); beforeWire = gate.wait;
    const pending = send(); await Promise.race([gate.entered, pending.then(() => { throw new Error('send ended before preparation gate'); })]);
    editors.activate({ selection: { isEmpty: true }, document: { uri: vscode.Uri.file('/owned/other.ts'),
      isClosed: false, getText: () => 'OTHER_EDITOR' } });
    gate.release(); await pending;
    expect(text(sent[0])).toContain('AUTO_CAPTURED'); expect(text(sent[0])).not.toContain('OTHER_EDITOR');
  });
  it('revokes an obsolete owner during preparation and releases busy state', async () => {
    const gate = deferred(); host._buildMystiProjectBrain = gate.wait;
    const pending = send(); await Promise.race([gate.entered, pending.then(() => { throw new Error('send ended before preparation gate'); })]); host._panelStates.get('sidebar').navigationRevision = 1;
    gate.release(); await pending;
    expect(sent).toEqual([]); expect(host._runningPanels.has('sidebar')).toBe(false);
    expect(h.sidebarMessages.some(m => m.type === 'requestCancelled')).toBe(true);
  });
  it('keeps length-continuation text while removing direct automatic inclusion', async () => {
    respond = index => {
      if (index === 0) { setMockConfig('autoContext', false); return [{ text: 'First half.' }, { done: true, finishReason: 'length' }]; }
      return [{ text: 'Second half.' }, { done: true }];
    };
    await send(); expect(sent).toHaveLength(2);
    expect(text(sent[0])).toContain('AUTO_CAPTURED'); expect(text(sent[1])).not.toContain('AUTO_CAPTURED');
    expect(text(sent[1])).toContain('First half.'); expect(sent[1].length).toBeGreaterThan(sent[0].length);
    assertPrivate();
  });
  it('internal coordinator calls have no editor capture', async () => {
    await host._runMystiAgentic('Internal task', [manual], settings, null, 'sidebar', 'conversation');
    expect(text(sent[0])).not.toContain('AUTO_CAPTURED'); expect(text(sent[0])).toContain('MANUAL_KEEP');
  });
  it('passes late context through explicit assignment phases without modifying manual input', async () => {
    const observed: string[] = [];
    host._collaborationManager = { async *run(input: any) {
      expect(input.context).toEqual([manual]);
      observed.push(JSON.stringify(input.resolveContext()));
      setMockConfig('autoContext', false);
      observed.push(JSON.stringify(input.resolveContext()));
      return { contextBlock: 'assignment complete', outcomes: [] };
    }, dispose() {}, cancelPanel() {} };
    await send('@claude-code explain', [{ type: 'agent', value: 'claude-code', raw: '@claude-code', startIndex: 0, endIndex: 12 }]);
    expect(observed).toHaveLength(2); expect(observed[0]).toContain('AUTO_CAPTURED');
    expect(observed[1]).not.toContain('AUTO_CAPTURED'); expect(observed[1]).toContain('MANUAL_KEEP'); assertPrivate();
  });
  it('keeps the same capture when a one-step orchestration falls back inline', async () => {
    host._mystiOrchestrator = { async *run(input: any) {
      expect(JSON.stringify(input.resolveContext())).toContain('AUTO_CAPTURED');
      setMockConfig('autoContext', false);
      return { synthesis: '', outcomes: [], refused: 'single-lane' };
    }, cancelPanel() {} };
    await send('orchestrate explain this');
    expect(sent).toHaveLength(1); expect(text(sent[0])).not.toContain('AUTO_CAPTURED');
    expect(text(sent[0])).toContain('explain this'); assertPrivate();
  });
  it('delegation factories preserve read-only and review-only policies while refreshing context', async () => {
    const prompts: string[] = []; const specs: any[] = [];
    host._collaboratorPool.dispatch = async function* (batch: any[]) {
      specs.push(...batch);
      for (const spec of batch) {
        prompts.push(spec.resolvePrompt?.() ?? spec.prompt);
        setMockConfig('autoContext', false);
        prompts.push(spec.resolvePrompt?.() ?? spec.prompt);
        yield { type: 'collab_complete', collaboratorId: spec.collaboratorId, responseText: 'done' };
      }
    };
    await host._runMystiDelegations([
      { agentId: 'claude-code', task: 'analyze', collaboratorId: 'a', readOnly: true, fold: true },
      { agentId: 'claude-code', task: 'review', collaboratorId: 'b', readOnly: true, reviewOnly: true, fold: true },
    ], settings, 'sidebar', 'run', 'sidebar', () => false, [manual], resolver);
    expect(specs.map(s => s.access)).toEqual(['read-only', 'read-only']);
    expect(specs.every(s => !s.prompt.includes('AUTO_CAPTURED'))).toBe(true);
    expect(prompts[0]).toContain('AUTO_CAPTURED'); expect(prompts[1]).not.toContain('AUTO_CAPTURED');
    expect(prompts[1]).toContain('MANUAL_KEEP'); expect(prompts[2]).not.toContain('MANUAL_KEEP');
  });
  it('refreshes native subagent context after a paid-approval wait and preserves child boundaries', async () => {
    const gate = deferred();
    host._mystiCoordinator.catalogModel = async () => ({ free: false, pricing: { prompt: '0.000001', completion: '0.000001' } });
    const guard = { approve: async () => { await gate.wait(); return true; }, settle: vi.fn() };
    const pending = host._runMystiSubagent({ kind: 'delegate', agent: 'mysti', task: 'explain', access: 'read-only' }, {
      settings, context: [manual], resolveContext: resolver, panelId: 'sidebar', cancelKey: 'sidebar', toolId: 'child',
      isCancelled: () => false, registerAbort: () => undefined, readOnly: true, execEnabled: false,
      chargeExec: () => false, model: 'owned-paid-fixture', paidGuard: guard,
    });
    await gate.entered; setMockConfig('autoContext', false); gate.release();
    const result = await pending;
    expect(result.hasError).toBe(false); expect(sent).toHaveLength(1);
    expect(text(sent[0])).not.toContain('AUTO_CAPTURED'); expect(text(sent[0])).toContain('MANUAL_KEEP');
    expect(sent[0][0].content).toContain('READ-ONLY'); expect(canonical.every(m => !text(m).includes('AUTO_CAPTURED'))).toBe(true);
    expect(guard.settle).toHaveBeenCalledOnce();
  });
  it('refreshes the tool-less advisor after approval without changing its authority', async () => {
    const gate = deferred();
    host._mystiCoordinator.catalogModel = async () => ({ free: false, pricing: { prompt: '0.000001', completion: '0.000001' } });
    host._mystiCoordinator.complete = async (messages: GatewayChatMessage[], options: any) => {
      canonical.push(structuredClone(messages));
      expect(options.tools).toBeUndefined();
      sent.push(structuredClone(options.resolveMessages?.() ?? messages));
      return { text: 'Advice', failed: false };
    };
    const pending = host._runMystiAdvisor({ kind: 'delegate', agent: 'advisor', task: 'explain' }, {
      settings, context: [manual], resolveContext: resolver, panelId: 'sidebar', runId: 'run', cancelKey: 'sidebar', toolId: 'advisor',
      isCancelled: () => false, registerAbort: () => undefined, liveBackends: [],
      paidGuard: { approve: async () => { await gate.wait(); return true; }, settle() {} },
    });
    await gate.entered; setMockConfig('autoContext', false); gate.release(); await pending;
    expect(sent).toHaveLength(1); expect(text(sent[0])).not.toContain('AUTO_CAPTURED');
    expect(text(sent[0])).toContain('MANUAL_KEEP'); expect(canonical.every(m => !text(m).includes('AUTO_CAPTURED'))).toBe(true);
  });
  it('explicit background jobs keep their original snapshot across chat navigation', async () => {
    const gate = deferred(); const completed = deferred(); beforeWire = gate.wait;
    host._backgroundJobManager = {
      runningCount: () => 0, create: () => ({ title: 'Owned background task' }),
      markDone: () => { completed.release(); return { delegations: 0 }; }, dispose() {},
      markFailed: (_id: string, error: string) => { throw new Error(error); },
    };
    host._notifyJobDone = () => undefined;
    await send('bg: explain'); await gate.entered;
    host._panelStates.get('sidebar').navigationRevision = 1;
    editors.activate({ selection: { isEmpty: true }, document: { uri: vscode.Uri.file('/owned/other.ts'),
      isClosed: false, getText: () => 'OTHER_EDITOR' } });
    gate.release(); await completed.wait();
    expect(sent).toHaveLength(1); expect(text(sent[0])).toContain('AUTO_CAPTURED');
    expect(text(sent[0])).not.toContain('OTHER_EDITOR'); assertPrivate();
  });

  it.each([
    ['reasoning-only length', 'length', 'You used your token budget without emitting a visible answer'],
    ['empty final answer', 'stop', 'Do NOT emit any tool directives now'],
  ])('preserves the coordinator nudge for %s', async (_label, finishReason, nudge) => {
    respond = index => {
      if (index === 0) { setMockConfig('autoContext', false); return [{ done: true, finishReason }]; }
      return [{ text: 'Recovered answer.' }, { done: true }];
    };
    await send(); expect(sent).toHaveLength(2);
    expect(text(sent[1])).toContain(nudge); expect(text(sent[1])).not.toContain('AUTO_CAPTURED');
    expect(text(sent[1])).toContain('MANUAL_KEEP'); assertPrivate();
  });
  it.each([
    ['reasoning-only length', 'length', 'You used your token budget without emitting a visible answer'],
  ])('preserves the native child nudge for %s', async (_label, finishReason, nudge) => {
    respond = index => {
      if (index === 0) { setMockConfig('autoContext', false); return [{ done: true, finishReason }]; }
      return [{ text: 'Recovered child answer.' }, { done: true }];
    };
    await host._runMystiSubagent({ kind: 'delegate', agent: 'mysti', task: 'explain', access: 'read-only' }, {
      settings, context: [manual], resolveContext: resolver, panelId: 'sidebar', cancelKey: 'sidebar', toolId: 'child',
      isCancelled: () => false, registerAbort: () => undefined, readOnly: true, execEnabled: false, chargeExec: () => false,
    });
    expect(sent).toHaveLength(2); expect(text(sent[1])).toContain(nudge);
    expect(text(sent[1])).not.toContain('AUTO_CAPTURED'); expect(text(sent[1])).toContain('MANUAL_KEEP');
  });

  it('freezes history, tool digests, and project memory across later coordinator rounds', async () => {
    let memory = 'PRIOR_MEMORY';
    host._memory = () => ({ digest: () => memory });
    const conversation = { id: 'conversation', settings, messages: [{ role: 'assistant', content: 'PRIOR_HISTORY',
      toolCalls: [{ name: 'delegate', input: { agent: 'claude-code', task: 'PRIOR_TASK' }, output: 'PRIOR_TOOL_RESULT' }] }] };
    h.conversationManager.getConversation = () => conversation;
    respond = index => {
      if (index === 0) {
        memory = 'LATER_MEMORY';
        conversation.messages[0].content = 'LATER_HISTORY';
        conversation.messages[0].toolCalls[0].input.task = 'LATER_TASK';
        conversation.messages[0].toolCalls[0].output = 'LATER_TOOL_RESULT';
        setMockConfig('autoContext', false);
        return [{ text: 'First half.' }, { done: true, finishReason: 'length' }];
      }
      return [{ text: 'Second half.' }, { done: true }];
    };
    await send(); expect(sent).toHaveLength(2);
    for (const value of ['PRIOR_MEMORY', 'PRIOR_HISTORY', 'PRIOR_TASK', 'PRIOR_TOOL_RESULT']) expect(text(sent[1])).toContain(value);
    for (const value of ['LATER_MEMORY', 'LATER_HISTORY', 'LATER_TASK', 'LATER_TOOL_RESULT', 'AUTO_CAPTURED']) expect(text(sent[1])).not.toContain(value);
    expect(text(sent[1])).toContain('First half.');
  });

  it('a replacement send revokes old orchestration without terminating the successor UI', async () => {
    const gate = deferred(); let oldCancelled: boolean | undefined;
    host._mystiOrchestrator = { async *run(input: any) {
      await gate.wait(); oldCancelled = input.isCancelled();
      return { synthesis: 'OLD_ORCHESTRATION', outcomes: [] };
    }, cancelPanel() {} };
    const previous = send('orchestrate old task'); await gate.entered;
    const successor = send('new task'); await vi.advanceTimersByTimeAsync(50); await successor;
    const afterSuccessor = h.sidebarMessages.length;
    gate.release(); await previous;
    expect(oldCancelled).toBe(true);
    expect(h.sidebarMessages.slice(afterSuccessor)).toEqual([]);
    expect(h.persistedCalls.filter(c => c[1] === 'assistant').map(c => c[2])).toEqual(['Deterministic response.']);
    expect(host._runningPanels.has('sidebar')).toBe(false);
  });

});
