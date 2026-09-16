import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NativeApprovalHost, NativeApprovalRequest } from '../../src/providers/base/IProvider';
import { NativeApprovalRequests, type NativeApprovalDecision } from '../../src/providers/base/NativeApprovalRequests';
import type { CollaboratorChunk, ContextItem, Conversation, Settings, StreamChunk } from '../../src/types';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { CollaboratorPool } from '../../src/services/CollaboratorPool';
import { collabOptions, collabSettings, collabSpec, collectCollabChunks } from '../helpers/collaboratorFactory';
import { clearMockConfig, clearConfigurationListeners, setMockConfig } from '../helpers/mockVscode';

const registryState = vi.hoisted(() => ({ providers: new Map<string, unknown>() }));
vi.mock('../../src/providers/ProviderRegistry', () => ({
  ProviderRegistry: class {
    getAll() { return [...registryState.providers.values()]; }
    get(id: string) { return registryState.providers.get(id); }
    async getProviderStatus() { return { found: true, authenticated: true, path: '/fake/native' }; }
    dispose() {}
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

interface NativeTurn {
  panelId: string;
  ask(name: string, policy?: NativeApprovalRequest['defaultDecision']): Promise<NativeApprovalDecision>;
}

function harness(script: (turn: NativeTurn) => AsyncGenerator<StreamChunk>) {
  let host: NativeApprovalHost | undefined;
  const turns = new Map<string, AbortController>();
  const calls: string[] = [];
  const decisions: { panelId: string; decision: NativeApprovalDecision }[] = [];
  const suspend = vi.fn(() => false);
  const resume = vi.fn(() => false);
  const cancel = vi.fn((panelId: string) => turns.get(panelId)?.abort());
  const provider = {
    id: 'hermes',
    config: { name: 'hermes', models: [], defaultModel: 'native-model' },
    capabilities: { supportsNativeApproval: true },
    setNativeApprovalHost(value: NativeApprovalHost) { host = value; },
    suspendProcess: suspend, resumeProcess: resume, cancelCurrentRequest: cancel,
    disposePersistentProcess: cancel, clearSession: cancel,
    async *sendMessage(_content: string, _context: ContextItem[], _settings: Settings, _conversation: Conversation | null, _persona: unknown, panelId: string) {
      calls.push(panelId);
      const controller = new AbortController();
      turns.get(panelId)?.abort();
      turns.set(panelId, controller);
      const process = new EventEmitter() as ChildProcess;
      const requests = new NativeApprovalRequests({
        providerId: 'hermes', panelId, process, signal: controller.signal,
        handler: host?.handlerForPanel(panelId, controller.signal),
        isCurrent: () => turns.get(panelId) === controller,
      });
      let nativeId = 0;
      try {
        yield* script({
          panelId,
          ask: (name, policy = 'ask') => new Promise(resolve => {
            requests.request(++nativeId, { id: 'native-tool', name, input: {} }, policy, decision => {
              decisions.push({ panelId, decision });
              resolve(decision);
            });
          }),
        });
      } finally {
        controller.abort();
        requests.dispose();
        if (turns.get(panelId) === controller) { turns.delete(panelId); }
      }
    },
  };
  registryState.providers.set('hermes', provider);
  setMockConfig('defaultProvider', 'hermes');
  const manager = new ProviderManager({
    subscriptions: [],
    globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
    workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
    extensionUri: vscode.Uri.file('/mock'),
  } as unknown as vscode.ExtensionContext);
  const pool = new CollaboratorPool(manager);
  return { pool, manager, calls, decisions, suspend, resume, cancel };
}

async function* writeThenText(turn: NativeTurn): AsyncGenerator<StreamChunk> {
  const decision = await turn.ask('Write');
  if (decision === 'allow') { yield { type: 'tool_use', toolCall: { id: 'native-tool', name: 'Write', input: {} } }; }
  yield { type: 'text', content: decision === 'allow' ? 'changed' : 'not changed' };
}

function completions(chunks: CollaboratorChunk[]) { return chunks.filter(chunk => chunk.type === 'collab_complete'); }

describe('CollaboratorPool native approvals through ProviderManager', () => {
  beforeEach(() => { registryState.providers.clear(); clearMockConfig(); });
  afterEach(() => { vi.useRealTimers(); clearConfigurationListeners(); });

  it('keeps simultaneous child gates separate and never suspends or re-prompts for a native notification', async () => {
    const h = harness(writeThenText);
    const arrived = deferred<void>();
    const answers = new Map<string, ReturnType<typeof deferred<boolean>>>();
    const identities: { id: string; signal: AbortSignal }[] = [];
    const gate = vi.fn((spec, _tool, origin) => {
      const answer = deferred<boolean>();
      answers.set(spec.collaboratorId, answer);
      identities.push(origin);
      if (answers.size === 2) { arrived.resolve(); }
      return answer.promise;
    });
    const pending = collectCollabChunks(h.pool.dispatch([
      collabSpec('a', 'hermes', { access: 'gated-write' }),
      collabSpec('b', 'hermes', { access: 'gated-write' }),
    ], collabOptions({ onGate: gate })));
    await arrived.promise;
    expect(h.decisions).toEqual([]);
    expect(new Set(identities.map(origin => origin.id)).size).toBe(2);
    answers.get('a')!.resolve(false);
    answers.get('b')!.resolve(true);
    const chunks = await pending;
    expect(completions(chunks).find(chunk => chunk.collaboratorId === 'a')?.failure).toBe('denied');
    expect(completions(chunks).find(chunk => chunk.collaboratorId === 'b')?.hasError).toBe(false);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(h.suspend).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.decisions.map(result => result.decision).sort()).toEqual(['allow', 'deny']);
    expect(identities.every(origin => origin.signal.aborted)).toBe(true);
  });

  it.each([
    ['sealed', 'Write'], ['sealed', 'WebFetch'], ['sealed', 'Task'], ['read-only', 'Write'], ['read-only', 'Task'],
  ] as const)('hard-denies %s %s even when the native default and gate would allow it', async (access, name) => {
    const h = harness(async function* (turn) {
      await turn.ask(name, 'allow');
      yield { type: 'text', content: 'finished' };
    });
    const gate = vi.fn(async () => true);
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access })], collabOptions({
      settings: collabSettings({ mode: 'edit-automatically', accessLevel: 'full-access' }), onGate: gate,
    })));
    expect(h.decisions[0].decision).toBe('deny');
    expect(gate).not.toHaveBeenCalled();
    expect(completions(chunks)[0].failure).toBe('denied');
    expect(h.calls).toHaveLength(1);
    expect(h.suspend).not.toHaveBeenCalled();
  });

  it('never turns a native hard-deny into a host approval', async () => {
    const h = harness(async function* (turn) {
      await turn.ask('Write', 'deny');
      yield { type: 'text', content: 'denied by backend' };
    });
    const gate = vi.fn(async () => true);
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({ onGate: gate })));
    expect(h.decisions[0].decision).toBe('deny');
    expect(gate).not.toHaveBeenCalled();
    expect(completions(chunks)[0].failure).toBe('denied');
    expect(h.calls).toHaveLength(1);
  });

  it('does not retry a native policy denial when the backend fails afterward', async () => {
    const h = harness(async function* (turn) {
      await turn.ask('Write', 'deny');
      yield { type: 'error', content: 'Backend refused the tool' };
    });
    const gate = vi.fn(async () => true);
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({ onGate: gate })));
    expect(gate).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(completions(chunks)[0].failure).toBe('denied');
    expect(chunks.some(chunk => chunk.type === 'collab_retry')).toBe(false);
  });

  it.each(['card', 'native policy'] as const)('a %s denial prevents an already pending card from allowing another action', async source => {
    const arrived = deferred<void>();
    const pendingAnswer = deferred<boolean>();
    const h = harness(async function* (turn) {
      const pending = turn.ask('Write');
      await arrived.promise;
      expect(await turn.ask('Bash', source === 'native policy' ? 'deny' : 'ask')).toBe('deny');
      pendingAnswer.resolve(true);
      expect(await pending).toBe('deny');
      yield { type: 'done' };
    });
    const gate = vi.fn((_spec, tool) => {
      if (tool.name === 'Bash') { return Promise.resolve(false); }
      arrived.resolve();
      return pendingAnswer.promise;
    });
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({ onGate: gate })));
    expect(gate).toHaveBeenCalledTimes(source === 'native policy' ? 1 : 2);
    expect(h.decisions.map(result => result.decision)).toEqual(['deny', 'deny']);
    expect(h.calls).toHaveLength(1);
    expect(completions(chunks)[0].failure).toBe('denied');
  });

  it('a cancelled gate prevents both pending and later native requests from allowing actions', async () => {
    const arrived = deferred<void>();
    const answer = deferred<boolean>();
    const h = harness(async function* (turn) {
      const pending = turn.ask('Write');
      await arrived.promise;
      expect(await turn.ask('Bash')).toBe('cancelled');
      answer.resolve(true);
      expect(await pending).toBe('cancelled');
      expect(await turn.ask('Read', 'allow')).toBe('cancelled');
      yield { type: 'done' };
    });
    // Exercise the gate's typed cancellation result while keeping the real
    // native request scope and manager routing for simultaneous requests.
    const gate = vi.spyOn(h.pool as unknown as {
      _awaitNativeGate(spec: unknown, options: unknown, request: NativeApprovalRequest): Promise<boolean | 'cancelled'>;
    }, '_awaitNativeGate').mockImplementation((_spec, _options, request) => {
      if (request.toolCall.name === 'Bash') { return Promise.resolve('cancelled'); }
      arrived.resolve();
      return answer.promise;
    });
    try {
      const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions()));
      expect(h.decisions.map(result => result.decision)).toEqual(['cancelled', 'cancelled', 'cancelled']);
      expect(gate).toHaveBeenCalledTimes(2);
      expect(h.calls).toHaveLength(1);
      expect(completions(chunks)[0].failure).toBe('cancelled');
    } finally { gate.mockRestore(); }
  });

  it('allows sealed file reads while preserving the user web gate for read-only advisors', async () => {
    const h = harness(async function* (turn) {
      await turn.ask(turn.panelId.endsWith('-reader') ? 'Read' : 'WebFetch', 'allow');
      yield { type: 'text', content: 'read' };
    });
    const gate = vi.fn(async () => true);
    const chunks = await collectCollabChunks(h.pool.dispatch([
      collabSpec('reader', 'hermes', { access: 'sealed' }),
      collabSpec('advisor', 'hermes', { access: 'read-only' }),
    ], collabOptions({ settings: collabSettings({ accessLevel: 'read-only' }), onGate: gate })));
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0][0].collaboratorId).toBe('advisor');
    expect(h.decisions.every(result => result.decision === 'allow')).toBe(true);
    expect(completions(chunks).every(chunk => !chunk.hasError)).toBe(true);
  });

  it('keeps the explicit gated-write policy when the native default is allow', async () => {
    const h = harness(async function* (turn) {
      await turn.ask('Write', 'allow');
      yield { type: 'text', content: 'finished' };
    });
    const gate = vi.fn(async () => false);
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({ onGate: gate })));
    expect(gate).toHaveBeenCalledTimes(1);
    expect(h.decisions[0].decision).toBe('deny');
    expect(completions(chunks)[0].failure).toBe('denied');
  });

  it('retains permissive web research when both native and parent policies allow it', async () => {
    const h = harness(async function* (turn) {
      await turn.ask('WebFetch', 'allow');
      yield { type: 'text', content: 'researched' };
    });
    const gate = vi.fn(async () => false);
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'read-only' })], collabOptions({
      settings: collabSettings({ mode: 'edit-automatically', accessLevel: 'full-access' }), onGate: gate,
    })));
    expect(gate).not.toHaveBeenCalled();
    expect(h.decisions[0].decision).toBe('allow');
    expect(completions(chunks)[0].hasError).toBe(false);
  });

  it('fails closed when a native write has no host gate', async () => {
    const h = harness(writeThenText);
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions()));
    expect(h.decisions[0].decision).toBe('deny');
    expect(completions(chunks)[0].failure).toBe('denied');
    expect(h.calls).toHaveLength(1);
  });

  it('cancels one pending child, aborts its card signal and ignores its late approval without touching a sibling', async () => {
    const h = harness(writeThenText);
    const arrived = deferred<void>();
    const answers = new Map<string, ReturnType<typeof deferred<boolean>>>();
    const origins = new Map<string, { signal: AbortSignal }>();
    const pending = collectCollabChunks(h.pool.dispatch([
      collabSpec('a', 'hermes', { access: 'gated-write' }),
      collabSpec('b', 'hermes', { access: 'gated-write' }),
    ], collabOptions({ onGate: (spec, _tool, origin) => {
      const answer = deferred<boolean>(); answers.set(spec.collaboratorId, answer); origins.set(spec.collaboratorId, origin!);
      if (answers.size === 2) { arrived.resolve(); }
      return answer.promise;
    } })));
    await arrived.promise;
    expect(h.pool.cancelCollaborator('run-1', 'a')).toBe(1);
    expect(origins.get('a')!.signal.aborted).toBe(true);
    expect(origins.get('b')!.signal.aborted).toBe(false);
    answers.get('a')!.resolve(true);
    answers.get('b')!.resolve(true);
    const chunks = await pending;
    expect(h.decisions.find(result => result.panelId.endsWith('-a'))?.decision).toBe('cancelled');
    expect(h.decisions.find(result => result.panelId.endsWith('-b'))?.decision).toBe('allow');
    expect(completions(chunks).find(chunk => chunk.collaboratorId === 'a')?.failure).toBe('cancelled');
    expect(h.calls).toHaveLength(2);
  });

  it('disposes a run with a pending card and prevents a late answer from starting another child', async () => {
    const arrived = deferred<void>();
    const answer = deferred<boolean>();
    const h = harness(writeThenText);
    let origin: { signal: AbortSignal } | undefined;
    const pending = collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({
      onGate: (_spec, _tool, request) => { origin = request; arrived.resolve(); return answer.promise; },
    })));
    await arrived.promise;
    h.pool.disposeRun('run-1');
    expect(origin!.signal.aborted).toBe(true);
    answer.resolve(true);
    const chunks = await pending;
    expect(h.decisions[0].decision).toBe('cancelled');
    expect(completions(chunks)[0].failure).toBe('cancelled');
    expect(h.calls).toHaveLength(1);
  });

  it('does not retry a transport failure after approving a native write', async () => {
    const h = harness(async function* (turn) {
      await turn.ask('Write');
      throw new Error('crashed after write');
    });
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({ onGate: async () => true })));
    expect(h.decisions[0].decision).toBe('allow');
    expect(h.calls).toHaveLength(1);
    expect(completions(chunks)[0].failure).toBe('crashed');
    expect(completions(chunks)[0].mayHaveSideEffects).toBe(true);
    expect(chunks.find(chunk => chunk.type === 'collab_error')?.mayHaveSideEffects).toBe(true);
    expect(chunks.some(chunk => chunk.type === 'collab_tool_use')).toBe(false);
    expect(chunks.some(chunk => chunk.type === 'collab_retry')).toBe(false);
  });

  it.each(['Task', 'Agent', 'WebFetch', 'Bash'])('reports an approved %s effect before any execution notification arrives', async name => {
    const h = harness(async function* (turn) {
      expect(await turn.ask(name)).toBe('allow');
      yield { type: 'error', content: 'lost transport after approval' };
    });
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({ onGate: async () => true })));
    expect(h.calls).toHaveLength(1);
    expect(chunks.some(chunk => chunk.type === 'collab_tool_use')).toBe(false);
    expect(chunks.filter(chunk => chunk.type === 'collab_error' || chunk.type === 'collab_complete'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'collab_error', failure: 'stream-error', mayHaveSideEffects: true }),
        expect.objectContaining({ type: 'collab_complete', failure: 'stream-error', mayHaveSideEffects: true }),
      ]));
  });

  it.each(['read', 'denied', 'hard-denied'])('does not claim execution authority for a %s native request', async kind => {
    const h = harness(async function* (turn) {
      await turn.ask(kind === 'read' ? 'Read' : 'Write', kind === 'hard-denied' ? 'deny' : 'ask');
      yield { type: 'text', content: 'finished' };
    });
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({ onGate: async () => kind === 'read' })));
    expect(completions(chunks)[0].mayHaveSideEffects).toBe(false);
  });

  it('retains approved-effect evidence through Stop and run disposal while a later gate is pending', async () => {
    const arrived = deferred<void>();
    const answer = deferred<boolean>();
    const h = harness(async function* (turn) {
      expect(await turn.ask('Write')).toBe('allow');
      expect(await turn.ask('Bash')).toBe('cancelled');
      yield { type: 'done' };
    });
    const pending = collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({
      onGate: (_spec, tool) => {
        if (tool.name === 'Write') { return Promise.resolve(true); }
        arrived.resolve();
        return answer.promise;
      },
    })));
    await arrived.promise;
    h.pool.disposeRun('run-1');
    answer.resolve(true);
    const chunks = await pending;
    expect(completions(chunks)[0]).toMatchObject({ failure: 'cancelled', mayHaveSideEffects: true });
    expect(h.calls).toHaveLength(1);
  });

  it('retains effect evidence on an approved-action timeout without replaying the task', async () => {
    vi.useFakeTimers();
    const arrived = deferred<void>();
    const h = harness(async function* (turn) {
      expect(await turn.ask('Write')).toBe('allow');
      arrived.resolve();
      await new Promise<void>(() => {});
      yield { type: 'done' };
    });
    const pending = collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write', timeoutMs: 20 })], collabOptions({ onGate: async () => true })));
    await arrived.promise;
    await vi.advanceTimersByTimeAsync(25);
    const chunks = await pending;
    expect(completions(chunks)[0]).toMatchObject({ failure: 'timeout', mayHaveSideEffects: true });
    expect(h.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets effect evidence for a later dispatch that reuses the stable child identity', async () => {
    let attempt = 0;
    const h = harness(async function* (turn) {
      if (attempt++ === 0) { await turn.ask('Write'); }
      throw new Error('transport failure');
    });
    const spec = collabSpec('a', 'hermes', { access: 'gated-write' });
    const options = collabOptions({ onGate: async () => true });
    const first = await collectCollabChunks(h.pool.dispatch([spec], options));
    const second = await collectCollabChunks(h.pool.dispatch([spec], options));
    expect(completions(first)[0].mayHaveSideEffects).toBe(true);
    expect(completions(second)[0].mayHaveSideEffects).toBe(false);
    expect(second.some(chunk => chunk.type === 'collab_retry')).toBe(true);
    expect(h.calls).toHaveLength(3);
  });

  it('registers question follow-ups and attributes their approved writes to the original retry attempt', async () => {
    vi.useFakeTimers();
    const h = harness(async function* (turn) {
      if (!turn.panelId.endsWith('-followup')) {
        yield { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which?', header: 'Q', options: [], multiSelect: false }] } };
        return;
      }
      await turn.ask('Write');
      throw new Error('follow-up crashed after write');
    });
    const gate = vi.fn(async () => true);
    const chunks = await collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({
      onQuestion: async () => ({ answers: { Q: 'continue' } }), onGate: gate,
    })));
    expect(h.calls).toEqual(['panel-1-collab-run-1-a', 'panel-1-collab-run-1-a-followup']);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(h.decisions).toEqual([{ panelId: h.calls[1], decision: 'allow' }]);
    expect(completions(chunks)[0].failure).toBe('crashed');
    expect(completions(chunks)[0].mayHaveSideEffects).toBe(true);
    expect(chunks.find(chunk => chunk.type === 'collab_error')?.mayHaveSideEffects).toBe(true);
    expect(chunks.some(chunk => chunk.type === 'collab_retry')).toBe(false);
    expect(h.suspend).not.toHaveBeenCalled();
  });

  it('cancels a native question follow-up through the owning collaborator Stop', async () => {
    vi.useFakeTimers();
    const arrived = deferred<void>();
    const answer = deferred<boolean>();
    const h = harness(async function* (turn) {
      if (!turn.panelId.endsWith('-followup')) {
        yield { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which?', header: 'Q', options: [], multiSelect: false }] } };
        return;
      }
      yield* writeThenText(turn);
    });
    let origin: { signal: AbortSignal } | undefined;
    const pending = collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({
      onQuestion: async () => ({ answers: { Q: 'continue' } }),
      onGate: (_spec, _tool, context) => { origin = context; arrived.resolve(); return answer.promise; },
    })));
    await arrived.promise;
    expect(h.pool.cancelCollaborator('run-1', 'a')).toBe(1);
    expect(origin!.signal.aborted).toBe(true);
    answer.resolve(true);
    const chunks = await pending;
    expect(h.decisions[0].decision).toBe('cancelled');
    expect(completions(chunks)[0].failure).toBe('cancelled');
    expect(h.calls).toHaveLength(2);
  });

  it('expires a pending native gate and cancels its card before retrying a fresh attempt', async () => {
    vi.useFakeTimers();
    const arrived = deferred<void>();
    const h = harness(writeThenText);
    const origins: { signal: AbortSignal }[] = [];
    const pending = collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write', timeoutMs: 20 })], collabOptions({
      onGate: (_spec, _tool, origin) => { origins.push(origin!); arrived.resolve(); return new Promise<boolean>(() => {}); },
    })));
    await arrived.promise;
    await vi.advanceTimersByTimeAsync(45);
    const chunks = await pending;
    expect(origins).toHaveLength(2);
    expect(origins.every(origin => origin.signal.aborted)).toBe(true);
    expect(h.decisions.every(result => result.decision === 'cancelled')).toBe(true);
    expect(completions(chunks)[0].failure).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an old dispatch finishing cannot dispose a replacement handler for the same child panel', async () => {
    const arrived = deferred<void>();
    const answer = deferred<boolean>();
    const h = harness(writeThenText);
    const pending = collectCollabChunks(h.pool.dispatch([collabSpec('a', 'hermes', { access: 'gated-write' })], collabOptions({
      onGate: () => { arrived.resolve(); return answer.promise; },
    })));
    await arrived.promise;
    const replacement = vi.fn(async () => true);
    const registration = h.manager.setNativeApprovalHandlerForPanel('panel-1-collab-run-1-a', replacement);
    answer.resolve(true);
    const chunks = await pending;
    expect(h.decisions[0].decision).toBe('cancelled');
    expect(completions(chunks)[0].failure).toBe('cancelled');
    // The old registration's finally has now run. The actual manager still
    // routes a new process/turn to the explicitly installed replacement.
    for await (const _chunk of h.manager.sendMessageToProvider('hermes', 'new turn', [], collabSettings(), null, undefined, 'panel-1-collab-run-1-a')) { /* drain */ }
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(h.decisions.at(-1)?.decision).toBe('allow');
    registration.dispose();
  });
});
