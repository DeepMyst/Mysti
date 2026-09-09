/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../src/providers/base/IProvider';
import type { StreamChunk, SubAgentQuestionCallback } from '../../src/types';
import { MockProviderManager } from '../helpers/mockProviderManager';
import { agentMention, collectMentionChunks, createMentionSettings, createTestMentionRouter } from '../helpers/mentionFactory';
import { clearMockConfig } from '../helpers/mockVscode';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { NativeApprovalRequests } from '../../src/providers/base/NativeApprovalRequests';

const disposals: Array<() => void> = [];
beforeEach(() => clearMockConfig());
afterEach(() => { for (const dispose of disposals.splice(0)) { dispose(); } vi.restoreAllMocks(); });

function harness() {
  const pm = new MockProviderManager();
  const nativeManager = Object.assign(Object.create(ProviderManager.prototype), {
    _nativeApprovalPanels: new Map(), _nativeApprovalTurns: new Map(),
  }) as ProviderManager;
  pm.captureNativeApprovalHandler = nativeManager.captureNativeApprovalHandler.bind(nativeManager);
  pm.setNativeApprovalHandlerForPanel = nativeManager.setNativeApprovalHandlerForPanel.bind(nativeManager);
  const approve = vi.fn<NativeApprovalHandler>(async () => true);
  const parentRegistration = nativeManager.setNativeApprovalHandlerForPanel('parent', approve);
  disposals.push(() => parentRegistration.dispose());
  const { router } = createTestMentionRouter(pm);
  let nativeId = 0;
  const nativeScopes = new Map<string, NativeApprovalRequests>();
  const sendMessage = pm.sendMessageToProvider.bind(pm);
  vi.spyOn(pm, 'sendMessageToProvider').mockImplementation(async function* (...args) {
    const childId = args[6]!;
    const controller = new AbortController();
    const scope = new NativeApprovalRequests({
      process: new EventEmitter() as ChildProcess, panelId: childId, providerId: 'hermes',
      signal: controller.signal,
      handler: nativeManager.captureNativeApprovalHandler(childId, controller.signal),
      isCurrent: () => !controller.signal.aborted && nativeScopes.get(childId) === scope,
    });
    nativeScopes.set(childId, scope);
    try { yield* sendMessage(...args); }
    finally {
      controller.abort();
      scope.dispose();
      if (nativeScopes.get(childId) === scope) { nativeScopes.delete(childId); }
    }
  });
  const approval = async (childId: string, name: string, defaultDecision: NativeApprovalRequest['defaultDecision'] = 'ask') => {
    const scope = nativeScopes.get(childId)!;
    return await new Promise<boolean | 'cancelled'>(resolve => {
      scope.request(++nativeId, { id: 'tool', name, input: { file_path: 'src/app.ts' }, status: 'pending' },
        defaultDecision, decision => resolve(decision === 'allow' ? true : decision === 'deny' ? false : 'cancelled'));
    });
  };
  const run = (ask?: SubAgentQuestionCallback) => collectMentionChunks(router.processMentions(
    '@claude implement this', [agentMention('claude', 'claude-code')], [],
    createMentionSettings({ provider: 'google-gemini' }), null, 'parent', ask,
  ));
  return { pm, approve, approval, run };
}

describe('mention native approval retry safety', () => {
  it.each(['Edit', 'Bash', 'Task', 'Agent', 'UnknownTool'])('does not replay an approved %s when its child fails afterward', async name => {
    const h = harness();
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!, name)).toBe(true);
      yield { type: 'error', content: 'Backend crashed after executing the tool' };
    };
    const chunks = await h.run();
    expect(h.pm.sendCalls.map(call => call.panelId)).toEqual(['parent-subagent-claude-code']);
    expect(h.approve).toHaveBeenCalledOnce();
    expect(chunks).toContainEqual({ type: 'subagent_complete', agentId: 'claude-code', hasError: true });
  });

  it.each(['Read', 'Grep', 'Think'])('preserves retry after an approved %s', async name => {
    const h = harness();
    let attempt = 0;
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!, name)).toBe(true);
      yield ++attempt === 1 ? { type: 'error', content: 'Temporary transport failure' } : { type: 'text', content: 'Analysis complete' };
    };
    const chunks = await h.run();
    expect(h.pm.sendCalls).toHaveLength(2);
    expect(chunks).toContainEqual({ type: 'subagent_complete', agentId: 'claude-code', hasError: false });
  });

  it.each([false, 'cancelled'] as const)('does not ask again after the parent returns %s', async answer => {
    const h = harness();
    h.approve.mockResolvedValue(answer);
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!, 'Edit')).toBe(answer);
      yield { type: 'error', content: 'Tool permission declined' };
    };
    await h.run();
    expect(h.pm.sendCalls).toHaveLength(1);
    expect(h.approve).toHaveBeenCalledOnce();
  });

  it('marks a denied request as failed even when the backend ends normally', async () => {
    const h = harness();
    h.approve.mockResolvedValue(false);
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!, 'Edit')).toBe(false);
      yield { type: 'done' };
    };
    const chunks = await h.run();
    expect(h.pm.sendCalls).toHaveLength(1);
    expect(chunks).toContainEqual({ type: 'subagent_complete', agentId: 'claude-code', hasError: true });
  });

  it.each(['error', 'done'] as const)('a native policy denial prevents replay after backend %s without opening a card', async type => {
    const h = harness();
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!, 'Edit', 'deny')).toBe(false);
      yield { type, content: type === 'error' ? 'Native policy denied editing' : undefined };
    };
    const chunks = await h.run();
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.pm.sendCalls).toHaveLength(1);
    expect(chunks).toContainEqual({ type: 'subagent_complete', agentId: 'claude-code', hasError: true });
  });

  it('an already pending approval cannot allow another action after denial', async () => {
    const h = harness();
    let deny!: (answer: boolean) => void;
    let allow!: (answer: boolean) => void;
    h.approve.mockImplementationOnce(() => new Promise(resolve => { deny = resolve; }));
    h.approve.mockImplementationOnce(() => new Promise(resolve => { allow = resolve; }));
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      const first = h.approval(childId!, 'Edit');
      const second = h.approval(childId!, 'Bash');
      await vi.waitFor(() => expect(h.approve).toHaveBeenCalledTimes(2));
      deny(false);
      expect(await first).toBe(false);
      allow(true);
      expect(await second).toBe(false);
      yield { type: 'done' };
    };
    const chunks = await h.run();
    expect(h.pm.sendCalls).toHaveLength(1);
    expect(chunks).toContainEqual({ type: 'subagent_complete', agentId: 'claude-code', hasError: true });
  });

  it('a native policy denial also blocks a card that was already waiting', async () => {
    const h = harness();
    let approve!: (answer: boolean) => void;
    h.approve.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      const pending = h.approval(childId!, 'Bash');
      await vi.waitFor(() => expect(h.approve).toHaveBeenCalledOnce());
      expect(await h.approval(childId!, 'Edit', 'deny')).toBe(false);
      approve(true);
      expect(await pending).toBe(false);
      yield { type: 'done' };
    };
    const chunks = await h.run();
    expect(h.pm.sendCalls).toHaveLength(1);
    expect(chunks).toContainEqual({ type: 'subagent_complete', agentId: 'claude-code', hasError: true });
  });

  it('does not start a question follow-up after the user denied the native action', async () => {
    const h = harness();
    h.approve.mockResolvedValue(false);
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId) {
      expect(await h.approval(childId!, 'Edit')).toBe(false);
      yield { type: 'ask_user_question', askUserQuestion: { toolCallId: 'question', questions: [] } };
    };
    const ask = vi.fn(async () => ({ answers: { Continue: 'Yes' } }));
    await h.run(ask);
    expect(ask).not.toHaveBeenCalled();
    expect(h.pm.sendCalls).toHaveLength(1);
  });

  it.each(['primary', 'followup'])('an approved write in the %s prevents replay when the follow-up throws', async phase => {
    const h = harness();
    h.pm.defaultStreamFactory = async function* (_id, _prompt, _context, _settings, _conversation, _persona, childId): AsyncGenerator<StreamChunk> {
      if (!childId!.endsWith('-followup')) {
        if (phase === 'primary') { expect(await h.approval(childId!, 'Edit')).toBe(true); }
        yield { type: 'ask_user_question', askUserQuestion: { toolCallId: 'question', questions: [] } };
      } else {
        if (phase === 'followup') { expect(await h.approval(childId!, 'Edit')).toBe(true); }
        throw new Error('Follow-up transport failed');
      }
    };
    const chunks = await h.run(async () => ({ answers: { Continue: 'Yes' } }));
    expect(h.pm.sendCalls.map(call => call.panelId)).toEqual(['parent-subagent-claude-code', 'parent-subagent-claude-code-followup']);
    expect(h.approve).toHaveBeenCalledOnce();
    expect(chunks).toContainEqual({ type: 'subagent_complete', agentId: 'claude-code', hasError: true });
  });
});
