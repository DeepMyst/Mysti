/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { NativeApprovalCards } from '../../src/chat/NativeApprovalCards';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../src/providers/base/IProvider';
import type { CollaborationStrategy, StreamChunk } from '../../src/types';
import { MockProviderManager } from '../helpers/mockProviderManager';
import { agentMention, collectMentionChunks, createMentionSettings, createTestMentionRouter } from '../helpers/mentionFactory';
import { collectChunks, configureBrainstorm, createMockSettings, createTestBrainstormManager } from '../helpers/brainstormFactory';
import { clearMockConfig } from '../helpers/mockVscode';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

const disposals: Array<() => void> = [];
beforeEach(() => clearMockConfig());
afterEach(() => { for (const dispose of disposals.splice(0)) { dispose(); } vi.restoreAllMocks(); vi.useRealTimers(); });

function harness() {
  const pm = new MockProviderManager();
  const registrations = new Map();
  // Exercise real registration snapshots/disposal while keeping provider I/O fake.
  const nativeManager = Object.assign(Object.create(ProviderManager.prototype), {
    _nativeApprovalPanels: registrations, _nativeApprovalTurns: new Map(),
  }) as ProviderManager;
  pm.captureNativeApprovalHandler = vi.fn(nativeManager.captureNativeApprovalHandler.bind(nativeManager));
  pm.setNativeApprovalHandlerForPanel = nativeManager.setNativeApprovalHandlerForPanel.bind(nativeManager);
  const panels = new Map([['parent', {}], ['other', {}]]);
  const requests: NativeApprovalRequest[] = [];
  const request = vi.fn(async (value: NativeApprovalRequest) => { requests.push(value); return true; });
  const cancelCard = vi.fn();
  const cards = new NativeApprovalCards({
    hasPanel: id => panels.has(id),
    captureScope: id => { const captured = panels.get(id); return () => panels.get(id) === captured; },
    request, cancelCard,
  });
  const registration = nativeManager.setNativeApprovalHandler(cards);
  disposals.push(() => { registration.dispose(); cards.dispose(); });
  let sequence = 0;
  const retained: Array<{ handler: NativeApprovalHandler; request: NativeApprovalRequest }> = [];
  const decisions: Array<boolean | 'cancelled'> = [];
  async function approval(childPanelId: string, defaultDecision: NativeApprovalRequest['defaultDecision'] = 'ask') {
    const controller = new AbortController();
    const native: NativeApprovalRequest = {
      id: 'host-' + (++sequence), nativeRequestId: 1, panelId: childPanelId, providerId: 'claude-code',
      defaultDecision, signal: controller.signal,
      toolCall: { id: 'tool', name: 'Read', input: { file_path: 'README.md' }, status: 'pending' },
    };
    const handler = nativeManager.captureNativeApprovalHandler(childPanelId, controller.signal)!;
    expect(handler).toBeTypeOf('function');
    retained.push({ handler, request: native });
    try {
      const decision = await handler(native);
      decisions.push(decision);
      return decision;
    } finally { controller.abort(); }
  }
  pm.setProviderAvailable('claude-code'); pm.setProviderAvailable('google-gemini');
  pm.defaultStreamFactory = async function* (_provider, _prompt, _context, _settings, _conversation, _persona, childPanelId) {
    const decision = await approval(childPanelId!);
    yield { type: 'text', content: decision === true ? 'A complete analysis and synthesis.' : 'Denied.' };
  };
  return { pm, nativeManager, registrations, panels, request, requests, cancelCard, cards, approval, retained, decisions };
}

describe('mention child native approvals', () => {
  it('captures the parent once across primary, retry, and answered-question follow-up', async () => {
    const h = harness();
    const { router } = createTestMentionRouter(h.pm);
    let calls = 0;
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!)).toBe(true);
      calls++;
      if (calls === 1) { yield { type: 'error', content: 'Retryable error' }; }
      else if (calls === 2) {
        yield { type: 'ask_user_question', askUserQuestion: { toolCallId: 'q', questions: [{ question: 'Continue?', options: [] }] } };
      } else { yield { type: 'text', content: 'Final response' }; }
    };
    const chunks = await collectMentionChunks(router.processMentions(
      '@claude implement this', [agentMention('claude', 'claude-code')], [],
      createMentionSettings({ provider: 'google-gemini' }), null, 'parent', async () => ({ answers: { Continue: 'Yes' } }),
    ));
    expect(chunks.some(chunk => chunk.type === 'subagent_text' && chunk.content === 'Final response')).toBe(true);
    expect(h.pm.sendCalls.map(call => call.panelId)).toEqual([
      'parent-subagent-claude-code', 'parent-subagent-claude-code-retry1', 'parent-subagent-claude-code-retry1-followup',
    ]);
    expect(h.requests.map(request => request.panelId)).toEqual(['parent', 'parent', 'parent']);
    expect(new Set(h.requests.map(request => request.id)).size).toBe(3);
    expect(h.pm.captureNativeApprovalHandler).toHaveBeenCalledTimes(1);
    expect(h.registrations.size).toBe(0);
  });

  it('routes AI task generation explicitly and limits that planning child to read-only', async () => {
    const h = harness();
    const { router } = createTestMentionRouter(h.pm);
    vi.spyOn(router as unknown as { _generateTaskListHeuristic(): null }, '_generateTaskListHeuristic').mockReturnValue(null);
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!)).toBe(true);
      yield { type: 'text', content: childId!.endsWith('-taskgen')
        ? '[{"agent":"claude-code","task":"Implement the feature","taskType":"execute"}]' : 'Implemented' };
    };
    await collectMentionChunks(router.processMentions('@claude help', [agentMention('claude', 'claude-code')], [],
      createMentionSettings({ provider: 'google-gemini', accessLevel: 'ask-permission' }), null, 'parent'));
    expect(h.pm.sendCalls[0].panelId).toBe('parent-taskgen');
    expect(h.pm.sendCalls[0].settings.accessLevel).toBe('read-only');
    expect(h.pm.sendCalls[1].settings.accessLevel).toBe('ask-permission');
    expect(h.requests.map(request => request.panelId)).toEqual(['parent', 'parent']);
    expect(h.registrations.size).toBe(0);
  });

  it('never forwards native deny to an approving parent', async () => {
    const h = harness();
    const { router } = createTestMentionRouter(h.pm);
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!, 'deny')).toBe(false);
      yield { type: 'text', content: 'Denied operation' };
    };
    await collectMentionChunks(router.processMentions('@claude help', [agentMention('claude', 'claude-code')], [],
      createMentionSettings({ provider: 'google-gemini' }), null, 'parent'));
    expect(h.request).not.toHaveBeenCalled();
    expect(h.registrations.size).toBe(0);
  });

  it('stopping one parent cancels its native card without cancelling another parent', async () => {
    const h = harness();
    const { router } = createTestMentionRouter(h.pm);
    const otherAnswer = deferred<boolean>();
    h.request.mockImplementation(async request => {
      h.requests.push(request);
      return request.panelId === 'other' ? otherAnswer.promise : new Promise<boolean>(() => {});
    });
    const run = (panel: string) => collectMentionChunks(router.processMentions('@claude help', [agentMention('claude', 'claude-code')], [],
      createMentionSettings({ provider: 'google-gemini' }), null, panel));
    const first = run('parent'); const second = run('other');
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    router.cancelSubAgents('parent', ['claude-code', 'google-gemini']);
    await first;
    expect(h.requests.find(request => request.panelId === 'parent')!.signal.aborted).toBe(true);
    expect(h.requests.find(request => request.panelId === 'other')!.signal.aborted).toBe(false);
    otherAnswer.resolve(true);
    await second;
    expect(h.decisions).toContain('cancelled');
    expect(h.registrations.size).toBe(0);
  });

  it('cancels a pending question wait so a late answer cannot create a follow-up', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { router } = createTestMentionRouter(h.pm);
    h.pm.defaultStreamFactory = async function* () {
      yield { type: 'ask_user_question', askUserQuestion: { toolCallId: 'q', questions: [] } };
    };
    const answer = deferred<{ answers: Record<string, string> }>();
    const ask = vi.fn(() => answer.promise);
    const run = collectMentionChunks(router.processMentions('@claude help', [agentMention('claude', 'claude-code')], [],
      createMentionSettings({ provider: 'google-gemini' }), null, 'parent', ask));
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    router.cancelSubAgents('parent', ['claude-code', 'google-gemini']);
    await run;
    answer.resolve({ answers: { Continue: 'Yes' } });
    await Promise.resolve();
    expect(h.pm.sendCalls).toHaveLength(1);
    expect(h.registrations.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('brainstorm child native approvals', () => {
  it.each(['quick', 'debate', 'red-team', 'perspectives', 'delphi'] as CollaborationStrategy[])(
    '%s captures one parent destination for every phase and keeps children read-only', async strategy => {
      const h = harness();
      const { manager } = createTestBrainstormManager(h.pm);
      configureBrainstorm({ strategy, agents: ['claude-code', 'google-gemini'], synthesisAgent: 'claude-code', maxRounds: 1, autoConverge: false });
      await collectChunks(manager.startBrainstormSession('Compare approaches', [], createMockSettings(), 'parent'));
      expect(h.requests.length).toBeGreaterThanOrEqual(3);
      expect(h.requests.every(request => request.panelId === 'parent')).toBe(true);
      expect(h.pm.sendCalls.every(call => call.settings.accessLevel === 'read-only')).toBe(true);
      expect(h.pm.captureNativeApprovalHandler).toHaveBeenCalledTimes(1);
      expect(h.registrations.size).toBe(0);
      expect(h.requests.every(request => request.signal.aborted)).toBe(true);
    },
  );

  it('keeps fallback synthesis on the captured parent and never forwards a native deny', async () => {
    const h = harness();
    const { manager } = createTestBrainstormManager(h.pm);
    configureBrainstorm({ strategy: 'quick', agents: ['claude-code', 'google-gemini'], synthesisAgent: 'claude-code' });
    let calls = 0;
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId): AsyncGenerator<StreamChunk> {
      const invocation = ++calls;
      expect(await h.approval(childId!, 'deny')).toBe(false);
      expect(await h.approval(childId!)).toBe(true);
      yield invocation === 3 ? { type: 'error', content: 'Synthesis unavailable' } : { type: 'text', content: 'Useful analysis' };
    };
    const chunks = await collectChunks(manager.startBrainstormSession('Compare approaches', [], createMockSettings(), 'parent'));
    expect(chunks.some(chunk => chunk.type === 'synthesis_fallback')).toBe(true);
    expect(h.requests).toHaveLength(4);
    expect(h.requests.every(request => request.panelId === 'parent')).toBe(true);
    expect(h.registrations.size).toBe(0);
  });

  it('Stop settles pending native approvals and removes child registrations before iterators finish', async () => {
    const h = harness();
    const { manager } = createTestBrainstormManager(h.pm);
    configureBrainstorm({ strategy: 'quick', agents: ['claude-code', 'google-gemini'], synthesisAgent: 'claude-code' });
    h.request.mockImplementation(async request => { h.requests.push(request); return new Promise<boolean>(() => {}); });
    const run = collectChunks(manager.startBrainstormSession('Compare approaches', [], createMockSettings(), 'parent'));
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    manager.cancelSession('parent');
    expect(h.registrations.size).toBe(0);
    await run;
    expect(h.requests.every(request => request.signal.aborted)).toBe(true);
    expect(h.pm.sendCalls).toHaveLength(2);
  });
});
