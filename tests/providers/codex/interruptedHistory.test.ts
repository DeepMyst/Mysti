import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import type { CodexSessionState } from '../../../src/providers/codex/CodexProvider';
import type { Conversation, Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: vi.fn(async () => {}),
}));

const NONCE = 'synthetic-prior-Claude-memory-8426';
const HISTORY = { id: 'conversation', title: 'retry service', createdAt: 1, updatedAt: 2, messages: [
  { id: 'question', role: 'user', content: `Remember ${NONCE} while reviewing retries.`, timestamp: 1 },
  { id: 'answer', role: 'assistant', content: 'I will retain that context.', timestamp: 2, provider: 'claude-code' },
] } as Conversation;
const SETTINGS = { provider: 'openai-codex', model: 'gpt-5.4', mode: 'quick-plan', accessLevel: 'read-only',
  contextMode: 'manual', thinkingLevel: 'none' } as Settings;

function harness() {
  mocks.spawn.mockReset();
  const provider = new TestableCodexProvider();
  const session: CodexSessionState = (provider as any)._getSession('panel');
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/codex');
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
  type Rpc = { id: number; method: string; params: { input: Array<{ text?: string }> } };
  type ReceivedTurn = { threadRequest: Rpc; turn: Rpc; emit: (value: unknown) => void };
  let receiveTurn: ((turn: ReceivedTurn) => void) | undefined;
  let resumedTurns: unknown[] = [];
  let processCount = 0;
  // Exercise public sendMessage, real prompt formatting, request ownership and
  // completion acknowledgement. Only the app-server child transport is fake.
  mocks.spawn.mockImplementation(() => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 89000 + processCount++,
      exitCode: null, signalCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess;
    const emit = (value: unknown) => { stdout.write(JSON.stringify(value) + '\n'); };
    let buffer = '', threadRequest: Rpc;
    stdin.on('data', bytes => {
      buffer += bytes.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message: Rpc = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        setImmediate(() => {
          if (message.method === 'initialize') emit({ id: message.id, result: {} });
          else if (message.method === 'config/read') emit({ id: message.id, result: { config: {} } });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') {
            threadRequest = message;
            emit({ id: message.id, result: { thread: { id: 'native-thread', turns: resumedTurns } } });
          } else if (message.method === 'turn/start') {
            const received = receiveTurn; receiveTurn = undefined;
            received?.({ threadRequest, turn: message, emit });
          }
        });
      }
    });
    return proc;
  });
  const send = async (content: string, conversation = HISTORY) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage(content, [], SETTINGS, conversation, undefined, 'panel')) chunks.push(chunk);
    return chunks;
  };
  const start = async (content: string, turns: unknown[] = [], conversation = HISTORY) => {
    resumedTurns = turns;
    const received = new Promise<ReceivedTurn>(resolve => { receiveTurn = resolve; });
    const completion = send(content, conversation);
    const result = await received;
    const accept = (id: string) => result.emit({ id: result.turn.id, result: { turn: { id } } });
    return { ...result, completion, accept,
      text: () => result.turn.params.input.map(input => input.text || '').join(''),
      complete: async (id: string) => {
        accept(id);
        result.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id, status: 'completed' } } });
        const chunks = await completion;
        expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
        expect(chunks.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
      },
    };
  };
  return { provider, session, start, send };
}

afterEach(() => { vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners(); });

describe('Codex ownership of imported conversation history after Stop', () => {
  it.each([false, true])('replays prior host context after Stop before the first completed turn (start acknowledged=%s)', async accepted => {
    const h = harness();
    try {
      const first = await h.start('Start a long analysis that I may stop.');
      expect(first.threadRequest.method).toBe('thread/start');
      expect(first.text()).toContain(NONCE);
      if (accepted) first.accept('interrupted-turn');
      // Native thread creation is acknowledged, but turn/start has not been.
      h.provider.cancelCurrentRequest('panel');
      await first.completion;
      const recovered = await h.start('Only recall the earlier nonce; do not continue the stopped task.', []);
      expect(recovered.threadRequest).toMatchObject({ method: 'thread/resume', params: { threadId: 'native-thread' } });
      expect(recovered.text()).toContain(NONCE);
      expect(recovered.text()).toContain('Only recall the earlier nonce');
      expect(recovered.text()).not.toContain('Start a long analysis that I may stop.');
      await recovered.complete('recovery-turn');
      h.provider.disposePersistentProcess('panel');
      const next = await h.start('Continue the recovered conversation.', [{ id: 'recovery-turn', status: 'completed' }]);
      expect(next.text()).not.toContain(NONCE);
      await next.complete('next-turn');
    } finally { h.provider.dispose(); }
  });

  it('keeps healthy completed native sessions free of duplicate imported history after respawn', async () => {
    const h = harness();
    try {
      const first = await h.start('Review retries.');
      await first.complete('completed-turn');
      h.provider.disposePersistentProcess('panel');
      const next = await h.start('Continue that completed review.', [{ id: 'completed-turn', status: 'completed' }]);
      expect(next.threadRequest.method).toBe('thread/resume');
      expect(next.text()).not.toContain(NONCE);
      expect(next.text()).toContain('Continue that completed review.');
      await next.complete('next-turn');
    } finally { h.provider.dispose(); }
  });

  it('retains a later cancelled user requirement as context after an established native session', async () => {
    const h = harness();
    try {
      const first = await h.start('Review retries.');
      await first.complete('completed-first');
      h.provider.disposePersistentProcess('panel');
      const stoppedRequirement = 'For subsequent reviews, assume max_attempts=7. Do not edit any files now.';
      const pending = await h.start(stoppedRequirement, [{ id: 'completed-first', status: 'completed' }]);
      expect(pending.text()).not.toContain(NONCE);
      h.provider.cancelCurrentRequest('panel');
      await pending.completion;
      const history = { ...HISTORY, messages: [...HISTORY.messages,
        { id: 'stopped-requirement', role: 'user' as const, content: stoppedRequirement, timestamp: 3 },
      ] };
      const current = 'Summarize the agreed retry limit; do not perform changes.';
      const recovered = await h.start(current, [{ id: 'completed-first', status: 'completed' }], history);
      expect(recovered.threadRequest.method).toBe('thread/resume');
      expect(recovered.text()).toContain(stoppedRequirement);
      expect(recovered.text()).toContain('--- End of conversation history ---');
      // The public async formatter also appends mode guidance. The stopped
      // instruction belongs only to history; the new request follows it.
      const currentInstructions = recovered.text().split('--- End of conversation history ---')[1];
      expect(currentInstructions).toContain(current);
      expect(currentInstructions).not.toContain(stoppedRequirement);
      await recovered.complete('recovery-turn');
    } finally { h.provider.dispose(); }
  });

  it('preserves a stopped requirement when cancellation occurs during attachment preparation before formatting', async () => {
    const h = harness();
    let finishPreparation!: (cleanup: () => Promise<void>) => void;
    let enteredPreparation!: () => void;
    const entered = new Promise<void>(resolve => { enteredPreparation = resolve; });
    const preparation = new Promise<() => Promise<void>>(resolve => { finishPreparation = resolve; });
    try {
      const first = await h.start('Review retries.');
      await first.complete('completed-first');
      vi.mocked((h.provider as any).prepareAttachments).mockImplementationOnce(() => { enteredPreparation(); return preparation; });
      const requirement = 'The new retry ceiling is eleven; do not execute tools.';
      const completion = h.send(requirement);
      await entered;
      h.provider.cancelCurrentRequest('panel');
      finishPreparation(async () => {}); await completion;
      const history = { ...HISTORY, messages: [...HISTORY.messages,
        { id: 'pending-requirement', role: 'user' as const, content: requirement, timestamp: 3 },
      ] };
      const recovered = await h.start('Recall the new ceiling only.', [{ id: 'completed-first', status: 'completed' }], history);
      expect(recovered.text()).toContain(requirement);
      await recovered.complete('recovery-turn');
    } finally {
      finishPreparation?.(async () => {}); h.provider.dispose();
    }
  });

  it.each([false, true])('retains every unacknowledged peer requirement after Stop with more than ten unseen messages (start acknowledged=%s)', async accepted => {
    const h = harness();
    try {
      const first = await h.start('Establish the native session.');
      await first.complete('established');
      const peers: Conversation = { ...HISTORY, messages: [...HISTORY.messages] };
      for (let index = 0; index < 7; index++) {
        peers.messages.push(
          { id: `peer-question-${index}`, role: 'user', content: `Peer requirement ${index}: keep limit ${index + 10}.`, timestamp: 3 + 2 * index },
          { id: `peer-answer-${index}`, role: 'assistant', content: `Verified peer contract ${index}.`, timestamp: 4 + 2 * index, provider: 'claude-code' },
        );
      }
      const stoppedInstruction = 'Review every peer requirement, but do not change files.';
      const interrupted = await h.start(stoppedInstruction, [{ id: 'established', status: 'completed' }], peers);
      expect(interrupted.text()).toContain('Peer requirement 0: keep limit 10.');
      expect(interrupted.text()).toContain('Verified peer contract 6.');
      if (accepted) interrupted.accept('stopped-peer-review');
      h.provider.cancelCurrentRequest('panel'); await interrupted.completion;

      const history: Conversation = { ...peers, messages: [...peers.messages,
        { id: 'stopped-peer-instruction', role: 'user', content: stoppedInstruction, timestamp: 18 },
      ] };
      const recovered = await h.start('Summarize all retained requirements only.', [{ id: 'established', status: 'completed' }], history);
      for (let index = 0; index < 7; index++) {
        expect(recovered.text()).toContain(`Peer requirement ${index}: keep limit ${index + 10}.`);
        expect(recovered.text()).toContain(`Verified peer contract ${index}.`);
      }
      expect(recovered.text().split('--- End of conversation history ---')[0]).toContain(stoppedInstruction);
      await recovered.complete('recovered-peers');
      const next = await h.start('Continue after successful recovery.', [{ id: 'recovered-peers', status: 'completed' }], history);
      expect(next.text()).not.toContain('Peer requirement');
      expect(next.text()).not.toContain(stoppedInstruction);
      await next.complete('next');
    } finally { h.provider.dispose(); }
  });
});
