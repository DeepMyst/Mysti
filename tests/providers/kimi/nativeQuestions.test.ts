// Kimi's AskUserQuestion reaches Mysti's question card and the user's real
// choice goes back to Kimi in the same turn. Only the child transport is
// replaced; the provider, base persistent reader and approval scope are real.
// Wire shapes mirror Kimi 2.1.1's acp-server (question.ts, interaction-bridge.ts).
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableKimiProvider } from '../../helpers/providerFactory';
import { createKimiSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: mocks.kill,
}));

const providers: TestableKimiProvider[] = [];
afterEach(() => { for (const provider of providers.splice(0)) provider.dispose(); vi.restoreAllMocks(); clearMockConfig(); });

const settings = { provider: 'kimi-code', model: '', mode: 'edit-automatically', accessLevel: 'full-access',
  thinkingLevel: 'none', contextMode: 'manual' } as Settings;
type Frame = Record<string, any>;

const permissionQuestion = (id: number | string = 50, sessionId = 'S'): Frame => ({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
  sessionId,
  options: [
    { optionId: 'q0_opt_0', name: 'Red', kind: 'allow_once' },
    { optionId: 'q0_opt_1', name: 'Blue', kind: 'allow_once' },
    { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
  ],
  toolCall: { toolCallId: 'turn-1:call-1', title: 'AskUserQuestion',
    content: [{ type: 'content', content: { type: 'text', text: 'Which color?' } }] },
} });
const elicitation = (properties?: Record<string, unknown>): Frame => ({ jsonrpc: '2.0', id: 60, method: 'elicitation/create', params: {
  sessionId: 'S', toolCallId: 'turn-1:call-2', mode: 'form', message: 'Which color?\nWhich sizes?',
  requestedSchema: { type: 'object', required: ['q0', 'q1'], properties: properties ?? {
    q0: { type: 'string', title: 'Color', oneOf: [{ const: 'Red', title: 'Red', description: 'Warm' }, { const: 'Blue', title: 'Blue' }] },
    q1: { type: 'array', title: 'Which sizes?', minItems: 1, items: { anyOf: [{ const: 'S', title: 'S' }, { const: 'L', title: 'L' }] } },
  } },
} });

function harness() {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  const provider = new TestableKimiProvider(); providers.push(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/kimi');
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('PROMPT');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(null);
  let frames: Frame[] = [];
  let emit: (...values: Frame[]) => void = () => {};
  mocks.spawn.mockImplementation(() => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const received: Frame[] = []; frames = received;
    emit = (...values) => { stdout.write(values.map(value => JSON.stringify(value) + '\n').join('')); };
    let buffer = '';
    stdin.on('data', bytes => {
      buffer += bytes.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); received.push(frame);
        if (frame.method === 'initialize') { emit({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } }); }
        if (frame.method === 'session/new') { emit({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'S' } }); }
      }
    });
    return Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242, exitCode: null, signalCode: null, killed: false, kill: vi.fn() });
  });
  // Plays the main chat: it claims the questions it shows (claim=false plays Brainstorm/background).
  const start = async (claim = true) => {
    const chunks: StreamChunk[] = [];
    let settled = false;
    const completion = (async () => {
      try {
        for await (const chunk of provider.sendMessage('ask me', [], settings, null, undefined, 'panel')) {
          chunks.push(chunk);
          if (claim && chunk.type === 'ask_user_question') { provider.claimNativeQuestion('panel', chunk.askUserQuestion!.toolCallId); }
        }
      }
      finally { settled = true; }
    })();
    await vi.waitFor(() => expect(frames.some(frame => frame.method === 'session/prompt')).toBe(true), { interval: 1 });
    const promptId = frames.find(frame => frame.method === 'session/prompt')!.id;
    const question = async (frame: Frame) => {
      emit(frame);
      await vi.waitFor(() => expect(chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(true), { interval: 1 });
      return chunks.find(chunk => chunk.type === 'ask_user_question')!.askUserQuestion!;
    };
    return {
      frames, chunks, completion, question, emit, settled: () => settled,
      replies: (id: number | string) => frames.filter(frame => frame.id === id && frame.method === undefined),
      end: async () => { emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }); await completion; },
    };
  };
  return { provider, start };
}

describe('Kimi native AskUserQuestion', () => {
  it('advertises form elicitation so Kimi sends every question, not only the first', async () => {
    const turn = await harness().start();
    expect(turn.frames[0].params.clientCapabilities.elicitation).toEqual({ form: {} });
    await turn.end();
  });

  it('holds the permission-bridge question for the card and answers it with the chosen option in the same turn', async () => {
    const h = harness(); const approval = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => approval });
    const turn = await h.start();
    const asked = await turn.question(permissionQuestion());
    expect(asked).toEqual({ toolCallId: 'turn-1:call-1', questions: [{ question: 'Which color?', header: '',
      multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(turn.replies(50)).toEqual([]); expect(turn.settled()).toBe(false);
    expect(h.provider.answerNativeQuestion('panel', 'turn-1:call-1', { Q1: 'Blue' })).toBe(true);
    await vi.waitFor(() => expect(turn.replies(50)).toHaveLength(1), { interval: 1 });
    expect(turn.replies(50)[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'q0_opt_1' } });
    expect(approval).not.toHaveBeenCalled();
    await turn.end();
    expect(turn.chunks.at(-1)?.type).toBe('done');
    expect(h.provider.answerNativeQuestion('panel', 'turn-1:call-1', { Q1: 'Red' })).toBe(false);
  });

  it.each([
    ['skipped', null],
    ['answered with free text Kimi cannot accept', { Q1: 'Green' }],
  ] as const)('dismisses a %s permission-bridge question with q0_skip', async (_case, answers) => {
    const h = harness(); const turn = await h.start();
    await turn.question(permissionQuestion());
    expect(h.provider.answerNativeQuestion('panel', 'turn-1:call-1', answers as any)).toBe(true);
    await vi.waitFor(() => expect(turn.replies(50)).toHaveLength(1), { interval: 1 });
    expect(turn.replies(50)[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'q0_skip' } });
    await turn.end();
  });

  it('holds a multi-question elicitation and accepts it with every answer keyed by form field', async () => {
    const h = harness(); const turn = await h.start();
    const asked = await turn.question(elicitation());
    expect(asked).toEqual({ toolCallId: 'turn-1:call-2', questions: [
      { question: 'Which color?', header: 'Color', multiSelect: false,
        options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: '' }] },
      { question: 'Which sizes?', header: '', multiSelect: true,
        options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] },
    ] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(turn.replies(60)).toEqual([]);
    expect(h.provider.answerNativeQuestion('panel', 'turn-1:call-2', { Color: 'Blue', Q2: ['S', 'L'] })).toBe(true);
    await vi.waitFor(() => expect(turn.replies(60)).toHaveLength(1), { interval: 1 });
    expect(turn.replies(60)[0].result).toEqual({ action: 'accept', content: { q0: 'Blue', q1: ['S', 'L'] } });
    await turn.end();
  });

  it('declines a skipped elicitation', async () => {
    const h = harness(); const turn = await h.start();
    await turn.question(elicitation());
    expect(h.provider.answerNativeQuestion('panel', 'turn-1:call-2', null)).toBe(true);
    await vi.waitFor(() => expect(turn.replies(60)).toHaveLength(1), { interval: 1 });
    expect(turn.replies(60)[0].result).toEqual({ action: 'decline' });
    await turn.end();
  });

  it('rejects an elicitation it cannot show, so Kimi falls back to its permission-bridge question', async () => {
    const h = harness(); const turn = await h.start();
    turn.emit(elicitation({ q0: { type: 'string', title: 'Color' } }));
    await vi.waitFor(() => expect(turn.replies(60)).toHaveLength(1), { interval: 1 });
    expect(turn.replies(60)[0].error).toMatchObject({ code: -32602 });
    expect(turn.chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(false);
    await turn.question(permissionQuestion());
    expect(h.provider.answerNativeQuestion('panel', 'turn-1:call-1', { Q1: 'Red' })).toBe(true);
    await vi.waitFor(() => expect(turn.replies(50)[0]?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'q0_opt_0' } }), { interval: 1 });
    await turn.end();
  });

  it.each([
    ['the turn ends', async (turn: any) => turn.end()],
    ['the user stops the turn', async (turn: any, provider: TestableKimiProvider) => { provider.cancelCurrentRequest('panel'); await turn.completion; }],
  ])('cancels a held question when %s and no longer claims its answer', async (_case, finish) => {
    const h = harness(); const turn = await h.start();
    await turn.question(permissionQuestion());
    await finish(turn, h.provider);
    expect(turn.replies(50)).toEqual([{ jsonrpc: '2.0', id: 50, result: { outcome: { outcome: 'cancelled' } } }]);
    expect(h.provider.answerNativeQuestion('panel', 'turn-1:call-1', { Q1: 'Blue' })).toBe(false);
    expect(turn.replies(50)).toHaveLength(1);
  });

  it('dismisses a question for another ACP session instead of showing or answering it', async () => {
    const h = harness(); const turn = await h.start();
    turn.emit(permissionQuestion(51, 'other-session'));
    await vi.waitFor(() => expect(turn.replies(51)).toHaveLength(1), { interval: 1 });
    expect(turn.replies(51)[0].result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(turn.chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(false);
    await turn.end();
  });

  it('keeps ordinary approvals, including the approval of the AskUserQuestion tool itself, on the approval path', async () => {
    const h = harness(); const approval = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => approval });
    const turn = await h.start();
    const approvalOptions = [{ optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
      { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }];
    turn.emit(
      { jsonrpc: '2.0', id: 70, method: 'session/request_permission', params: { sessionId: 'S', options: approvalOptions,
        toolCall: { toolCallId: 'turn-1:bash', title: 'Bash', kind: 'execute', rawInput: { command: 'ls' } } } },
      { jsonrpc: '2.0', id: 71, method: 'session/request_permission', params: { sessionId: 'S', options: approvalOptions,
        toolCall: { toolCallId: 'turn-1:ask', title: 'AskUserQuestion' } } },
    );
    await vi.waitFor(() => expect(turn.replies(70)).toHaveLength(1), { interval: 1 });
    await vi.waitFor(() => expect(turn.replies(71)).toHaveLength(1), { interval: 1 });
    expect(approval).toHaveBeenCalledTimes(2);
    for (const id of [70, 71]) { expect(turn.replies(id)[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_once' } }); }
    expect(turn.chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(false);
    await turn.end();
  });

  it('dismisses an unclaimed question (Brainstorm, background runs) instead of holding the turn or auto-answering', async () => {
    const h = harness(); const turn = await h.start(false);
    const asked = await turn.question(permissionQuestion());
    await vi.waitFor(() => expect(turn.replies(50)).toHaveLength(1), { interval: 1 });
    expect(turn.replies(50)[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'q0_skip' } });
    expect(h.provider.answerNativeQuestion('panel', asked.toolCallId, { Q1: 'Blue' })).toBe(false);
    await turn.end();
  });

  it('does not claim an unknown question, so the host can fall back to a follow-up', async () => {
    const h = harness(); const turn = await h.start();
    expect(h.provider.answerNativeQuestion('panel', 'never-asked', { Q1: 'Blue' })).toBe(false);
    expect(h.provider.answerNativeQuestion('no-such-panel', 'turn-1:call-1', { Q1: 'Blue' })).toBe(false);
    await turn.end();
  });

  it('never picks the first option when no live turn can hold the question', () => {
    const provider = new TestableKimiProvider(); providers.push(provider);
    const session = createKimiSession(); const written: string[] = [];
    session.persistentProcess = { stdin: new Writable({ write(chunk, _encoding, callback) { written.push(String(chunk)); callback(); } }) } as unknown as ChildProcess;
    Object.assign(session, { acpSessionId: 'S', acpMode: 'edit-automatically', acpAccessLevel: 'full-access' });
    expect(provider.parseStreamLine(JSON.stringify(permissionQuestion()), session)).toBeNull();
    expect(JSON.parse(written.join(''))).toEqual({ jsonrpc: '2.0', id: 50, result: { outcome: { outcome: 'cancelled' } } });
  });
});
