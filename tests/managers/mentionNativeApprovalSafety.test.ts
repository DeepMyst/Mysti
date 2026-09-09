/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../src/providers/base/IProvider';
import type { StreamChunk, SubAgentQuestionCallback } from '../../src/types';
import { MockProviderManager } from '../helpers/mockProviderManager';
import { agentMention, collectMentionChunks, createMentionSettings, createTestMentionRouter } from '../helpers/mentionFactory';
import { clearMockConfig } from '../helpers/mockVscode';

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
  const approval = async (childId: string, name: string, defaultDecision: NativeApprovalRequest['defaultDecision'] = 'ask') => {
    const controller = new AbortController();
    const request: NativeApprovalRequest = {
      id: `write-${++nativeId}`, nativeRequestId: nativeId, providerId: 'claude-code',
      panelId: childId, signal: controller.signal, defaultDecision,
      toolCall: { id: 'tool', name, input: { file_path: 'src/app.ts' }, status: 'pending' },
    };
    try {
      const handler = nativeManager.captureNativeApprovalHandler(childId, controller.signal)!;
      return await handler(request);
    } finally { controller.abort(); }
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
