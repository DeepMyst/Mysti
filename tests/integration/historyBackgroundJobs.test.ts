import { afterEach, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { BackgroundJobManager } from '../../src/managers/BackgroundJobManager';
import { clearMockConfig } from '../helpers/mockVscode';

function harness(position: 'visible' | 'switched' | 'closed') {
  const values = new Map<string, any>();
  const store = { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => {
    values.set(key, JSON.parse(JSON.stringify(value)));
  } };
  const conversations = new ConversationManager({ globalState: store } as any);
  const old = conversations.getCurrentConversation()!;
  const keep = conversations.createNewConversation();
  const now = Date.now();
  values.set('mysti.backgroundJobs.v1', [{ id: 'foreign-job', panelId: 'a', conversationId: old.id,
    title: 'Other editor window', status: 'running', hostId: 'foreign-host', startedAt: now, heartbeat: now, delegations: 0 }]);
  const jobs = new BackgroundJobManager(); jobs.attachStore(store, now, 'test-host');
  jobs.create('delete-job', 'a', old.id, 'Work belonging to deleted chat', now);
  jobs.create('keep-job', 'a', keep.id, 'Unrelated background work', now);
  jobs.create('completed-job', 'a', old.id, 'Already completed', now);
  jobs.markDone('completed-job', 'Finished result', now);
  const deletedController = new AbortController();
  const keepController = new AbortController();
  const completedController = new AbortController();
  let resolveGate!: (allowed: boolean) => void;
  const pendingGate = new Promise<boolean>(resolve => { resolveGate = resolve; });
  const permission = { cancelRequestsByOwner: vi.fn((id: string) => {
    if (id === 'delete-job') { resolveGate(false); return ['deleted-job-permission']; }
    return [];
  }) };
  const panels = new Map(position === 'closed' ? [] : [['a', {
    id: 'a', currentConversationId: position === 'visible' ? old.id : keep.id, webview: {},
  }]]);
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _extensionContext: { workspaceState: store },
    _conversationManager: conversations, _backgroundJobManager: jobs, _panelStates: panels,
    _jobCancelled: new Set(), _jobAbortControllers: new Map([
      ['delete-job', deletedController], ['keep-job', keepController], ['completed-job', completedController],
    ]),
    _mystiActiveDelegationRuns: new Map(), _permissionManager: permission,
    _collaboratorPool: { cancelRun: vi.fn() },
    _dictationManager: { cancelPanel: vi.fn(async () => {}) },
    _resetConversationWork: vi.fn(), _compactionManager: { resetUsage: vi.fn() },
    _lifecycleManager: { removeSession: vi.fn() }, _postToPanel: vi.fn(),
  });
  return { host, conversations, jobs, old, keep, deletedController, keepController, completedController,
    pendingGate, resolveGate, permission };
}

afterEach(() => { clearMockConfig(); vi.restoreAllMocks(); });

it.each(['visible', 'switched', 'closed'] as const)(
  'deleting conversation aborts only its locally executing background job when owner is %s', async position => {
    const h = harness(position);
    try {
      await h.host._handleMessage({ type: 'deleteConversation', panelId: 'a', payload: { id: h.old.id } });
      expect(h.conversations.getConversation(h.old.id)).toBeNull();
      expect(h.deletedController.signal.aborted).toBe(true);
      expect(h.keepController.signal.aborted).toBe(false);
      expect(h.completedController.signal.aborted).toBe(false);
      expect(h.host._jobCancelled.has('foreign-job')).toBe(false);
      expect(h.jobs.get('foreign-job')?.status).toBe('running');
      expect(h.conversations.getConversation(h.keep.id)).not.toBeNull();
    } finally { h.resolveGate(false); h.jobs.dispose(); }
  },
);

it('deleting a background chat releases its coordinator-owned permission gate without requiring a delegation child', async () => {
  const h = harness('switched');
  let outcome: boolean | undefined;
  void h.pendingGate.then(value => { outcome = value; });
  try {
    await h.host._handleMessage({ type: 'deleteConversation', panelId: 'a', payload: { id: h.old.id } });
    await Promise.resolve();
    expect(outcome, 'A coordinator local-write/MCP gate is owned by its job even without a delegate run').toBe(false);
    expect(h.permission.cancelRequestsByOwner.mock.calls).toEqual([['delete-job']]);
    expect(h.keepController.signal.aborted).toBe(false);
  } finally { h.resolveGate(false); h.jobs.dispose(); }
});

it.each(['stream', 'final model metadata'] as const)(
  'a real coordinator loop delayed at %s settles cancelled after deletion without restoring a transcript', async boundary => {
    const h = harness('switched');
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let modelLookups = 0;
    let streamSignal: AbortSignal | undefined;
    const kept = JSON.stringify(h.conversations.getConversation(h.keep.id));
    const persist = vi.spyOn(h.conversations, 'addMessageToConversation');
    Object.assign(h.host, {
      _availableMystiBackends: () => [],
      _mystiGovernors: () => ({ maxTurns: 3, maxDelegations: 1 }),
      _mystiLocalExecEnabled: () => false,
      _mystiVisualEnabled: () => ({ look: false, act: false }),
      _mystiMcpToolset: async () => null,
      _mystiSkillsEnabled: () => false,
      _maybeNoticeStealthModel: () => {},
      _canvasBoundTo: () => false,
      _buildMystiProjectBrain: async () => '',
      _mystiAgenticSystemPrompt: () => 'Controlled coordinator prompt.',
      _buildMystiDirectPrompt: () => 'Complete the background task.',
      _canvasSteeringRuns: new Set(),
      _drainCanvasSteering: () => '',
      _announceRefusedCapability: () => {},
      _collaboratorPool: { disposeRun: vi.fn(), cancelRun: vi.fn() },
      _mystiCoordinator: {
        status: () => ({ ready: true }),
        supportsToolCalls: async () => false,
        resolveCoordinatorModel: async () => {
          if (++modelLookups > 1 && boundary === 'final model metadata') { started(); await delayed; }
          return 'controlled-coordinator-model';
        },
        stream: async function* (_messages: unknown[], options: { signal: AbortSignal }) {
          streamSignal = options.signal;
          yield { text: 'Owned partial background answer.' };
          if (boundary === 'stream') { started(); await delayed; }
          yield { done: true };
        },
      },
    });
    // The real CoordinatorTurnRunner and host terminal logic run; only external
    // providers and optional capability discovery are controlled/no-inference.
    const pending = h.host._runMystiAgentic('Complete the background task.', [], {
      provider: 'mysti', model: '', mode: 'ask-before-edit', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual',
    }, h.old, 'a', h.old.id, 'delete-job');
    try {
      // Surface a missing fixture dependency immediately instead of hanging on
      // its never-reached latch and calling a harness failure a product timeout.
      await Promise.race([ready, pending.then(() => { throw new Error('Coordinator ended before the requested boundary'); })]);
      await h.host._handleMessage({ type: 'deleteConversation', panelId: 'a', payload: { id: h.old.id } });
      const afterDelete = h.host._postToPanel.mock.calls.length;
      if (boundary === 'stream') expect(streamSignal?.aborted).toBe(true);
      release();
      await expect(pending).resolves.toBeUndefined();
      expect(h.jobs.get('delete-job')?.status).toBe('cancelled');
      expect(h.conversations.getConversation(h.old.id)).toBeNull();
      expect(JSON.stringify(h.conversations.getConversation(h.keep.id))).toBe(kept);
      expect(persist).not.toHaveBeenCalled();
      const terminal = h.host._postToPanel.mock.calls.slice(afterDelete).map((call: any[]) => call[1])
        .filter((message: any) => ['jobCancelled', 'jobComplete', 'jobError', 'responseComplete', 'error'].includes(message.type));
      expect(terminal).toEqual([{ type: 'jobCancelled', payload: { jobId: 'delete-job' } }]);
      expect(h.host._jobAbortControllers.has('delete-job')).toBe(false);
      expect(h.host._jobCancelled.has('delete-job')).toBe(false);
    } finally { release(); await pending; h.resolveGate(false); h.jobs.dispose(); }
  },
);
