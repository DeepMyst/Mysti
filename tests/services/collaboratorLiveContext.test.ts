import { describe, it, expect, vi, afterEach } from 'vitest';
import { CollaborationManager, type CollaborationRunInput } from '../../src/managers/CollaborationManager';
import { runExplicitMentions } from '../../src/managers/ExplicitMentionRunner';
import { CollaboratorPool } from '../../src/services/CollaboratorPool';
import type { ProviderInputResolver } from '../../src/providers/base/IProvider';
import type { AgentContextManager } from '../../src/managers/AgentContextManager';
import type { CollaboratorChunk, ContextItem, StreamChunk } from '../../src/types';
import { MockProviderManager, createMockStream } from '../helpers/mockProviderManager';
import { collabOptions, collabSettings, collabSpec, collectCollabChunks } from '../helpers/collaboratorFactory';

const MANUAL = 'MANUAL_REFERENCE_KEEP';
const AUTO = 'CAPTURED_UNSAVED_AUTO_ONLY';
const manual: ContextItem[] = [{ path: '/manual.ts', content: MANUAL, enabled: true } as ContextItem];
const automatic: ContextItem = { path: '/captured.ts', content: AUTO, enabled: true } as ContextItem;
const question: StreamChunk = { type: 'ask_user_question', askUserQuestion: {
  toolCallId: 'question-1', questions: [{ question: 'Database?', header: 'Database', options: [{ label: 'SQLite', description: 'Local' }], multiSelect: false }],
} };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function drain(gen: AsyncGenerator<CollaboratorChunk, unknown>) {
  const chunks: CollaboratorChunk[] = [];
  for await (const chunk of gen) { chunks.push(chunk); }
  return chunks;
}
function setup() {
  const pm = new MockProviderManager();
  for (const agent of ['claude-code', 'google-gemini']) { pm.setProviderAvailable(agent); }
  pm.defaultStreamFactory = () => createMockStream([{ type: 'text', content: 'Result' }, { type: 'done' }]);
  const pool = new CollaboratorPool(pm);
  const role = { prompt: '[Trusted role frozen]', access: 'read-only' as const, trusted: true, name: 'Advisor', pattern: 'one-shot' as const };
  const buildRoleContext = vi.fn(async () => role);
  const manager = new CollaborationManager(pool, { buildRoleContext } as unknown as AgentContextManager);
  let enabled = true;
  let cancelled = false;
  const input: CollaborationRunInput = {
    brief: 'Review the captured code', collaborators: [{ agentId: 'claude-code', roleId: 'advisor' }],
    context: manual.map(item => ({ ...item })), settings: collabSettings(), panelId: 'owner-panel',
    resolveContext: () => enabled ? [...manual, automatic] : manual,
    isCancelled: () => cancelled,
  };
  return { pm, pool, role, buildRoleContext, manager, input, disable: () => { enabled = false; }, cancel: () => { cancelled = true; } };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('collaboration dispatch uses live private context', () => {
  it('includes the snapshot only in the dispatched prompt and keeps canonical input/spec manual', async () => {
    const s = setup();
    const dispatch = vi.spyOn(s.pool, 'dispatch');
    await drain(s.manager.run(s.input));
    expect(s.pm.sendCalls).toHaveLength(1);
    expect(s.pm.sendCalls[0].content).toContain(AUTO);
    expect(s.pm.sendCalls[0].content).toContain(MANUAL);
    expect(s.pm.sendCalls[0].content.indexOf(AUTO)).toBeGreaterThan(s.pm.sendCalls[0].content.indexOf('UNTRUSTED DATA'));
    expect(dispatch.mock.calls[0][0][0].prompt).not.toContain(AUTO);
    expect(s.input.context).toEqual(manual);
    expect(s.pm.nativeApprovalPanels.size).toBe(0);
  });

  it('resolves after later role setup and freezes the first role authority and body', async () => {
    const s = setup();
    const entered = deferred(); const release = deferred();
    s.input.collaborators.push({ agentId: 'google-gemini', roleId: 'critic' });
    s.buildRoleContext.mockImplementationOnce(async () => s.role).mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return s.role;
    });
    const work = drain(s.manager.run(s.input));
    await entered.promise;
    s.role.prompt = 'MUTATED_ROLE_MUST_NOT_REPLACE_FIRST';
    s.disable(); release.resolve();
    await work;
    expect(s.pm.sendCalls).toHaveLength(2);
    expect(s.pm.sendCalls[0].content).toContain('[Trusted role frozen]');
    for (const call of s.pm.sendCalls) { expect(call.content).not.toContain(AUTO); expect(call.content).toContain(MANUAL); }
    expect(s.pm.sendCalls[0].settings.accessLevel).toBe('read-only');
  });

  it('rechecks context after provider readiness has waited', async () => {
    const s = setup(); const entered = deferred(); const release = deferred();
    vi.spyOn(s.pm, 'getProviderStatus').mockImplementation(async () => { entered.resolve(); await release.promise; return null; });
    const dispatch = vi.spyOn(s.pool, 'dispatch');
    const work = drain(s.manager.run(s.input)); await entered.promise; s.disable(); release.resolve(); await work;
    expect(dispatch.mock.calls[0][0][0].resolvePrompt).toBeTypeOf('function');
    expect(s.pm.sendCalls).toHaveLength(1); expect(s.pm.sendCalls[0].content).not.toContain(AUTO);
    expect(s.pm.sendCalls[0].content).toContain(MANUAL);
  });

  it('rechecks a queued lane after the concurrency slot becomes free', async () => {
    const s = setup(); const entered = deferred(); const release = deferred();
    let enabled = true;
    s.pm.defaultStreamFactory = async function* (_agent, _prompt, _context, _settings, _conversation, _persona, panelId) {
      if (panelId?.endsWith('-first')) { entered.resolve(); await release.promise; }
      yield { type: 'text', content: 'Result' };
    };
    const specs = ['first', 'second'].map(id => collabSpec(id, 'claude-code', {
      prompt: MANUAL, resolvePrompt: () => enabled ? `${MANUAL}\n${AUTO}` : MANUAL,
    }));
    const work = collectCollabChunks(s.pool.dispatch(specs, collabOptions({ maxConcurrent: 1 })));
    await entered.promise; enabled = false; release.resolve(); await work;
    expect(s.pm.sendCalls).toHaveLength(2);
    expect(s.pm.sendCalls[0].content).toContain(AUTO); expect(s.pm.sendCalls[1].content).toBe(MANUAL);
    expect(specs.map(spec => spec.prompt)).toEqual([MANUAL, MANUAL]);
  });

  it('rebuilds each retry with the same nonce, request, role and permissions', async () => {
    const s = setup();
    let attempts = 0;
    s.pm.defaultStreamFactory = async function* () {
      if (++attempts === 1) { s.disable(); throw new Error('retryable transport failure'); }
      yield { type: 'text', content: 'Recovered' };
    };
    const chunks = await drain(s.manager.run(s.input));
    expect(s.pm.sendCalls).toHaveLength(2);
    const [first, second] = s.pm.sendCalls;
    expect(first.content).toContain(AUTO); expect(second.content).not.toContain(AUTO);
    expect(second.content).toContain(MANUAL); expect(second.content).toContain('[Trusted role frozen]');
    expect(second.settings).toEqual(first.settings);
    const nonce = (value: string) => /UNTRUSTED DATA \(nonce ([^)]+)\)/.exec(value)?.[1];
    expect(nonce(second.content)).toBe(nonce(first.content));
    expect(chunks.filter(c => c.type === 'collab_retry')).toHaveLength(1);
  });

  it('rebuilds the base after an answered question and appends the answer once', async () => {
    const s = setup(); const entered = deferred(); const release = deferred();
    s.pm.defaultStreamFactory = (_a, _p, _c, _s, _h, _persona, panel) => createMockStream(
      panel?.endsWith('-followup') ? [{ type: 'text', content: 'Answered' }] : [question]);
    s.input.onQuestion = async () => { entered.resolve(); await release.promise; return { answers: { Database: 'SQLite' } }; };
    const work = drain(s.manager.run(s.input)); await entered.promise; s.disable(); release.resolve(); await work;
    expect(s.pm.sendCalls).toHaveLength(2);
    expect(s.pm.sendCalls[0].content).toContain(AUTO);
    const followup = s.pm.sendCalls[1].content;
    expect(followup).not.toContain(AUTO); expect(followup).toContain(MANUAL); expect(followup).toContain('SQLite');
    expect(followup.match(/User answered your questions:/g)).toHaveLength(1);
    expect(s.pm.nativeApprovalPanels.size).toBe(0);
  });

  it('passes the same resolver into dependent explicit mention phases without recapture', async () => {
    const s = setup(); let attempts = 0;
    s.pm.defaultStreamFactory = async function* () {
      yield { type: 'text', content: `PHASE_RESULT_${++attempts}` };
      s.disable();
    };
    await runExplicitMentions(s.manager, [
      { dependsOnPrevious: false, assignments: [{ agentId: 'claude-code', brief: 'First' }] },
      { dependsOnPrevious: true, assignments: [{ agentId: 'google-gemini', brief: 'Second' }] },
    ], s.input, () => {});
    expect(s.pm.sendCalls).toHaveLength(2);
    expect(s.pm.sendCalls[0].content).toContain(AUTO); expect(s.pm.sendCalls[1].content).not.toContain(AUTO);
    expect(s.pm.sendCalls[1].content).toContain('PHASE_RESULT_1'); expect(s.pm.sendCalls[1].content).toContain(MANUAL);
  });

  it('cancels an obsolete owner after readiness without delivering or retrying', async () => {
    const s = setup(); const entered = deferred(); const release = deferred();
    vi.spyOn(s.pm, 'getProviderStatus').mockImplementation(async () => { entered.resolve(); await release.promise; return null; });
    const work = drain(s.manager.run(s.input)); await entered.promise; s.cancel(); release.resolve(); const chunks = await work;
    expect(s.pm.sendCalls).toHaveLength(0);
    expect(chunks.find(c => c.type === 'collab_complete')?.failure).toBe('cancelled');
    expect(chunks.some(c => c.type === 'collab_retry')).toBe(false);
  });

  it('cancels an obsolete owner during a question instead of sending a follow-up', async () => {
    const s = setup(); const entered = deferred(); const release = deferred();
    s.pm.defaultStreamFactory = () => createMockStream([question]);
    s.input.onQuestion = async () => { entered.resolve(); await release.promise; return { answers: { Database: 'SQLite' } }; };
    const work = drain(s.manager.run(s.input)); await entered.promise; s.cancel(); release.resolve(); const chunks = await work;
    expect(s.pm.sendCalls).toHaveLength(1);
    expect(chunks.find(c => c.type === 'collab_complete')?.failure).toBe('cancelled');
    expect(s.pm.nativeApprovalPanels.size).toBe(0);
  });

  it('does not start a retry when the owner becomes obsolete after a failed attempt', async () => {
    const s = setup();
    s.pm.defaultStreamFactory = async function* () { s.cancel(); throw new Error('failed after navigation'); };
    const chunks = await drain(s.manager.run(s.input));
    expect(s.pm.sendCalls).toHaveLength(1);
    expect(chunks.find(c => c.type === 'collab_complete')?.failure).toBe('cancelled');
    expect(chunks.some(c => c.type === 'collab_retry')).toBe(false);
  });

  for (const followup of [false, true]) {
    it(`forwards a live callback through ${followup ? 'answered-question' : 'initial'} provider preparation`, async () => {
      const s = setup(); const entered = deferred(); const release = deferred();
      const delivered: string[] = [];
      vi.spyOn(s.pm, 'sendMessageToProvider').mockImplementation(async function* (
        _agent, _content, _context, _settings, _conversation, _persona, panel,
        resolveInput?: ProviderInputResolver,
      ) {
        if (followup && !panel?.endsWith('-followup')) { yield question; return; }
        entered.resolve(); await release.promise;
        const input = resolveInput?.();
        if (!input) { return; }
        delivered.push(input.content);
        yield { type: 'text', content: 'Prepared' };
      });
      s.input.onQuestion = async () => ({ answers: { Database: 'SQLite' } });
      const work = drain(s.manager.run(s.input)); await entered.promise; s.disable(); release.resolve(); await work;
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).not.toContain(AUTO); expect(delivered[0]).toContain(MANUAL);
      if (followup) { expect(delivered[0].match(/User answered your questions:/g)).toHaveLength(1); expect(delivered[0]).toContain('SQLite'); }
    });
  }

  it('returns cancellation through provider preparation without an empty-response retry', async () => {
    const s = setup(); const entered = deferred(); const release = deferred();
    const sends = vi.spyOn(s.pm, 'sendMessageToProvider').mockImplementation(async function* (
      _agent, _content, _context, _settings, _conversation, _persona, _panel,
      resolveInput?: ProviderInputResolver,
    ) {
      entered.resolve(); await release.promise;
      if (resolveInput?.()) { yield { type: 'text', content: 'MUST_NOT_DELIVER' }; }
    });
    const work = drain(s.manager.run(s.input)); await entered.promise; s.cancel(); release.resolve(); const chunks = await work;
    expect(sends).toHaveBeenCalledTimes(1);
    expect(chunks.find(c => c.type === 'collab_complete')?.failure).toBe('cancelled');
    expect(chunks.some(c => c.type === 'collab_retry' || c.type === 'collab_error')).toBe(false);
  });

  it('never falls back to a stale prompt when a live resolver throws', async () => {
    const s = setup();
    s.input.resolveContext = () => { throw new Error('context no longer readable'); };
    const chunks = await drain(s.manager.run(s.input));
    expect(s.pm.sendCalls).toHaveLength(0);
    expect(chunks.find(c => c.type === 'collab_complete')?.failure).toBe('crashed');
    expect(s.pm.nativeApprovalPanels.size).toBe(0);
  });

  it('does not resume an approved child after its originating owner becomes obsolete', async () => {
    const s = setup(); const entered = deferred(); const release = deferred();
    const resume = vi.spyOn(s.pm, 'resumeRequest');
    vi.spyOn(s.pm, 'suspendRequest').mockReturnValue(true);
    s.input.collaborators = [{ agentId: 'claude-code', advisory: false }];
    s.input.onGate = async () => { entered.resolve(); await release.promise; return true; };
    s.pm.defaultStreamFactory = () => createMockStream([{ type: 'tool_use', toolCall: { id: 'write-1', name: 'Write', status: 'running', input: { file_path: '/owned/example', content: 'value' } } }]);
    const work = drain(s.manager.run(s.input)); await entered.promise; s.cancel(); release.resolve(); const chunks = await work;
    expect(resume).not.toHaveBeenCalled();
    expect(chunks.find(c => c.type === 'collab_complete')?.failure).toBe('cancelled');
    expect(s.pm.sendCalls).toHaveLength(1);
  });

});
