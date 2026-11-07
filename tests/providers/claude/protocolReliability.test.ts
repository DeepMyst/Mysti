import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: mocks.kill,
}));
const providers: TestableClaudeProvider[] = [];
afterEach(() => {
  for (const provider of providers.splice(0)) provider.dispose();
  vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});
const settings = { provider: 'claude-code', model: 'sonnet', mode: 'ask-before-edit', accessLevel: 'ask-permission',
  thinkingLevel: 'none', contextMode: 'manual' } as Settings;
type Frame = Record<string, any>;
function text(content: string): Frame {
  return { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } };
}
const result = (content = ''): Frame => ({ type: 'result', subtype: 'success', result: content });
function toolResults(...ids: string[]): Frame {
  return { type: 'user', message: { content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: `output-${id}` })) } };
}
function questionFrames(input: unknown, id: unknown = 'question-tool'): Frame[] {
  return [
    { type: 'stream_event', event: { type: 'content_block_start', index: 7,
      content_block: { type: 'tool_use', id, name: 'AskUserQuestion' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 7,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 7 } },
  ];
}

/** Public provider requests and real Claude control/stream parsing. Only the
 * child transport is replaced; there are no native/model/account operations. */
function harness() {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  const provider = new TestableClaudeProvider(); providers.push(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/claude');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('');
  const children: Array<{ frames: Frame[]; emit: (...frames: Frame[]) => void; emitRaw: (bytes: string) => void; args: string[] }> = [];
  mocks.spawn.mockImplementation((_path: string, args: string[]) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const frames: Frame[] = [];
    let buffer = '';
    stdin.on('data', bytes => {
      buffer += bytes.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1);
      }
    });
    children.push({ frames, args, emitRaw: bytes => { stdout.write(bytes); },
      emit: (...values) => { stdout.write(values.map(value => JSON.stringify(value) + '\n').join('')); } });
    return Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 87000 + children.length,
      exitCode: null, signalCode: null, killed: false, kill: vi.fn() });
  });
  const start = async (content: string, initialize = true, stopOnError = false) => {
    const previous = children.at(-1);
    const before = previous?.frames.length ?? 0;
    const chunks: StreamChunk[] = [];
    let settled = false;
    const completion = (async () => {
      try {
        for await (const chunk of provider.sendMessage(content, [], settings, null, undefined, 'panel')) {
          chunks.push(chunk);
          if (stopOnError && chunk.type === 'error') { break; }
        }
      } finally { settled = true; }
    })();
    await vi.waitFor(() => expect(children.at(-1)?.frames.length).toBeGreaterThan(children.at(-1) === previous ? before : 0), { interval: 1 });
    const child = children.at(-1)!;
    const first = child.frames[child === previous ? before : 0];
    if (initialize && first.type === 'control_request') {
      child.emit({ type: 'control_response', response: { subtype: 'success', request_id: first.request_id, response: {} } });
      await vi.waitFor(() => expect(child.frames.at(-1)?.type).toBe('user'), { interval: 1 });
    }
    return { child, first, chunks, completion, settled: () => settled };
  };
  return { provider, children, start };
}

describe('Claude persistent protocol reliability', () => {
  it('preserves a final-only reply after an earlier streamed turn on the same process', async () => {
    const h = harness();
    const first = await h.start('First request');
    first.child.emit(text('FIRST_STREAMED'), result()); await first.completion;
    const second = await h.start('/cost');
    expect(h.children).toHaveLength(1);
    second.child.emit(result('SECOND_FINAL_ONLY')); await second.completion;
    expect(second.chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(['SECOND_FINAL_ONLY']);
  });

  it('preserves wire order for two parallel result batches and intervening text in one stdout buffer', async () => {
    const h = harness(); const turn = await h.start('Review both parallel batches');
    turn.child.emit(toolResults('A', 'B'), text('BETWEEN_BATCHES'), toolResults('C', 'D'), result());
    await turn.completion;
    expect(turn.chunks.filter(chunk => chunk.type !== 'done').map(chunk => chunk.type === 'tool_result'
      ? chunk.toolCall?.id : chunk.content)).toEqual(['A', 'B', 'BETWEEN_BATCHES', 'C', 'D']);
  });

  it('preserves fragmented result batches before an error boundary and ignores a repeated terminal in the same buffer', async () => {
    const h = harness(); const turn = await h.start('Review fragmented tool output');
    const wire = JSON.stringify(toolResults('A', 'B')) + '\n';
    const split = wire.indexOf('tool_result') + 4;
    turn.child.emitRaw(wire.slice(0, split));
    await Promise.resolve();
    expect(turn.chunks).toEqual([]);
    turn.child.emitRaw(wire.slice(split));
    turn.child.emit(toolResults('C', 'D'), { ...result('TOOLS_FAILED'), is_error: true }, result('IGNORED_DUPLICATE'));
    await turn.completion;
    expect(turn.chunks.map(chunk => chunk.type === 'tool_result' ? chunk.toolCall?.id
      : chunk.type === 'error' ? chunk.content : chunk.type)).toEqual(['A', 'B', 'C', 'D', 'TOOLS_FAILED', 'done']);
  });

  it('settles malformed initialization as one actionable failure without submitting the user prompt or falling back', async () => {
    const h = harness(); const turn = await h.start('Must not reach an uninitialized backend', false);
    turn.child.emit({ type: 'control_response', response: { request_id: turn.first.request_id, subtype: 'unexpected' } });
    try {
      await vi.waitFor(() => expect(turn.settled()).toBe(true), { timeout: 150 });
      expect(turn.chunks.filter(chunk => chunk.type === 'error')).toHaveLength(1);
      expect(turn.chunks.find(chunk => chunk.type === 'error')?.content).toContain('Update Claude Code');
      expect(turn.child.frames.some(frame => frame.type === 'user')).toBe(false);
      expect(h.children).toHaveLength(1);
      expect(mocks.kill).toHaveBeenCalled();
    } finally {
      h.provider.cancelCurrentRequest('panel'); await turn.completion;
    }
  });

  it('ignores a delayed duplicate initialization response after the handshake has already succeeded', async () => {
    const h = harness(); const first = await h.start('First request');
    first.child.emit(result('FIRST_COMPLETE')); await first.completion;
    const second = await h.start('Second request');
    second.child.emit({ type: 'control_response', response: { request_id: first.first.request_id, subtype: 'error', error: 'stale initialization reply' } },
      text('SECOND_COMPLETE'), result());
    await second.completion;
    expect(second.chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(['SECOND_COMPLETE']);
    expect(second.chunks.some(chunk => chunk.type === 'error')).toBe(false);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it('rejects an old CLI initialization error before work and recovers through a fresh approved transport', async () => {
    const h = harness(); const old = await h.start('Old CLI request', false);
    old.child.emit({ type: 'control_response', response: { subtype: 'error', request_id: old.first.request_id, error: 'Unsupported initialize' } });
    await old.completion;
    expect(old.chunks.filter(chunk => chunk.type === 'error')).toHaveLength(1);
    expect(old.child.frames.some(frame => frame.type === 'user')).toBe(false);
    expect(h.children).toHaveLength(1);
    expect(old.child.args).not.toContain('--dangerously-skip-permissions');
    const recovered = await h.start('Try the repaired transport');
    expect(h.children).toHaveLength(2);
    recovered.child.emit(result('RECOVERED')); await recovered.completion;
    expect(recovered.chunks).toContainEqual({ type: 'text', content: 'RECOVERED' });
  });

  it('does not open a second permission gate or implicitly authorize native question and plan tools', async () => {
    const h = harness(); const approval = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => approval });
    const turn = await h.start('Ask a question then present a plan');
    for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
      turn.child.emit({ type: 'control_request', request_id: name, request: { subtype: 'can_use_tool', tool_name: name, input: {} } });
    }
    turn.child.emit(result()); await turn.completion;
    expect(approval).not.toHaveBeenCalled();
    for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
      expect(turn.child.frames.filter(frame => frame.type === 'control_response' && frame.response?.request_id === name))
        .toEqual([expect.objectContaining({ response: expect.objectContaining({ response: expect.objectContaining({ behavior: 'deny' }) }) })]);
    }
  });

  const QUESTION = { question: 'Floor or round?', header: 'Rounding', options: [{ label: 'Floor' }, { label: 'Round' }] };
  const askNatively = async (h: ReturnType<typeof harness>, answerEarly?: Record<string, string> | null) => {
    const turn = await h.start('Ask me how to round');
    turn.child.emit(...questionFrames({ questions: [QUESTION] }));
    await vi.waitFor(() => expect(turn.chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(true), { interval: 1 });
    if (answerEarly !== undefined) { expect(h.provider.answerNativeQuestion('panel', 'question-tool', answerEarly)).toBe(true); }
    turn.child.emit({ type: 'control_request', request_id: 'native-question', request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'question-tool', input: { questions: [QUESTION] } } });
    const responses = () => turn.child.frames.filter(frame => frame.type === 'control_response' && frame.response?.request_id === 'native-question');
    return { turn, responses };
  };

  // Claude Code's SDK contract: the host answers AskUserQuestion in its
  // permission reply and Claude continues the SAME turn with the answers.
  it('holds a native question for the user and answers it in the same turn', async () => {
    const h = harness(); const approval = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => approval });
    const { turn, responses } = await askNatively(h);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(responses()).toEqual([]); expect(turn.settled()).toBe(false);
    expect(h.provider.answerNativeQuestion('panel', 'question-tool', { Rounding: 'Round' })).toBe(true);
    await vi.waitFor(() => expect(responses()).toHaveLength(1), { interval: 1 });
    expect(responses()[0].response.response).toEqual({ behavior: 'allow', updatedInput: { questions: [QUESTION], answers: { 'Floor or round?': 'Round' } } });
    turn.child.emit(text('Rounding to nearest.'), result()); await turn.completion;
    expect(turn.chunks).toContainEqual({ type: 'text', content: 'Rounding to nearest.' });
    expect(turn.child.frames.filter(frame => frame.type === 'user')).toHaveLength(1);
    expect(approval).not.toHaveBeenCalled();
  });

  it('delivers an answer given before Claude asks permission (autonomous auto-answer)', async () => {
    const h = harness();
    const { turn, responses } = await askNatively(h, { Rounding: ['Floor', 'Round'] } as any);
    await vi.waitFor(() => expect(responses()).toHaveLength(1), { interval: 1 });
    expect(responses()[0].response.response.updatedInput.answers).toEqual({ 'Floor or round?': 'Floor, Round' });
    turn.child.emit(result()); await turn.completion;
  });

  it('declines a skipped native question without inventing an answer', async () => {
    const h = harness();
    const { turn, responses } = await askNatively(h);
    expect(h.provider.answerNativeQuestion('panel', 'question-tool', null)).toBe(true);
    await vi.waitFor(() => expect(responses()).toHaveLength(1), { interval: 1 });
    expect(responses()[0].response.response).toEqual({ behavior: 'deny', message: expect.stringMatching(/skipped/i) });
    turn.child.emit(result()); await turn.completion;
  });

  it('does not claim an unknown question, so the host can fall back to a follow-up', async () => {
    const h = harness(); const turn = await h.start('No question here');
    expect(h.provider.answerNativeQuestion('panel', 'never-asked', { Rounding: 'Round' })).toBe(false);
    turn.child.emit(result()); await turn.completion;
    expect(h.provider.answerNativeQuestion('panel', 'never-asked', { Rounding: 'Round' })).toBe(false);
  });

  it.each(['ExitPlanMode'])('describes %s as a pending Mysti handoff instead of a user refusal', async name => {
    const h = harness(); const approval = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => approval });
    const turn = await h.start('Wait for the user to answer or review before proceeding');
    if (name === 'AskUserQuestion') {
      turn.child.emit(...questionFrames({ questions: [{ question: 'Floor or round?', options: [{ label: 'Floor' }, { label: 'Round' }] }] }));
    } else {
      turn.child.emit(
        { type: 'stream_event', event: { type: 'content_block_start', index: 8, content_block: { type: 'tool_use', id: 'plan-tool', name } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 8, delta: { type: 'input_json_delta', partial_json: '{}' } } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 8 } },
      );
    }
    turn.child.emit({ type: 'control_request', request_id: 'interactive-owner', request: {
      subtype: 'can_use_tool', tool_name: name, tool_use_id: name === 'AskUserQuestion' ? 'question-tool' : 'plan-tool',
      input: name === 'AskUserQuestion' ? { questions: [{ question: 'Floor or round?' }] } : {},
    } }, result('Waiting for the Mysti follow-up.'));
    await turn.completion;
    const responses = turn.child.frames.filter(frame => frame.type === 'control_response' && frame.response?.request_id === 'interactive-owner');
    expect(responses).toHaveLength(1);
    const response = responses[0].response.response;
    expect(response.behavior).toBe('deny');
    expect(response.message).toMatch(name === 'AskUserQuestion' ? /pending question/i : /pending plan/i);
    expect(response.message).toMatch(/scoped follow-up/i);
    expect(response.message).toMatch(/wait/i);
    expect(response.message).not.toContain('Mysti denied or cancelled this operation');
    expect(response.message).not.toMatch(/(?:user|user's)\s+(?:has\s+)?(?:denied|cancelled|refused|rejected)/i);
    if (name === 'ExitPlanMode') { expect(response.message).toMatch(/keep the current permission mode/i); }
    expect(approval).not.toHaveBeenCalled();
    expect(turn.chunks.filter(chunk => chunk.type === (name === 'AskUserQuestion' ? 'ask_user_question' : 'exit_plan_mode'))).toHaveLength(1);
    expect(turn.child.frames.filter(frame => frame.type === 'user')).toHaveLength(1);
  });

  it.each([
    ['object instead of questions', { questions: { bad: true } }],
    ['empty questions', { questions: [] }],
    ['null question', { questions: [null] }],
    ['nontext question', { questions: [{ question: { bad: true } }] }],
    ['nontext header', { questions: [{ question: 'Choose?', header: 42 }] }],
    ['object instead of options', { questions: [{ question: 'Choose?', options: { bad: true } }] }],
    ['invalid option', { questions: [{ question: 'Choose?', options: [{ label: ['bad'] }] }] }],
    ['nontext option description', { questions: [{ question: 'Choose?', options: [{ label: 'A', description: {} }] }] }],
    ['nonboolean multiSelect', { questions: [{ question: 'Choose?', multiSelect: 'yes' }] }],
    ['nonobject input', null],
  ])('rejects malformed AskUserQuestion (%s) visibly without a question or approval owner', async (_name, input) => {
    const h = harness(); const approval = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => approval });
    const turn = await h.start('Ask for a design choice');
    turn.child.emit(...questionFrames(input), { type: 'control_request', request_id: 'question-permission',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'question-tool', input } });
    // Native question execution is denied, then the CLI finishes its turn.
    expect(turn.child.frames.at(-1)).toMatchObject({ type: 'control_response', response: {
      request_id: 'question-permission', response: { behavior: 'deny' },
    } });
    turn.child.emit(result()); await turn.completion;
    expect(turn.chunks.filter(chunk => chunk.type === 'error')).toEqual([
      expect.objectContaining({ content: expect.stringContaining('invalid question') }),
    ]);
    expect(turn.chunks.some(chunk => chunk.type === 'ask_user_question' || chunk.type === 'tool_use')).toBe(false);
    expect(turn.chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(approval).not.toHaveBeenCalled();
  });

  it('normalizes optional question fields while preserving exact valid text and native identity', async () => {
    const h = harness(); const turn = await h.start('Ask one freeform question');
    turn.child.emit(...questionFrames({ questions: [{ question: 'Which café should retry?\nKeep the Unicode.' }] }), result());
    await turn.completion;
    expect(turn.chunks.find(chunk => chunk.type === 'ask_user_question')?.askUserQuestion).toEqual({
      toolCallId: 'question-tool', questions: [{ question: 'Which café should retry?\nKeep the Unicode.', header: '', options: [], multiSelect: false }],
    });
    expect(turn.chunks.some(chunk => chunk.type === 'error')).toBe(false);
  });

  it('rejects a native question without a usable tool identity', async () => {
    const h = harness(); const turn = await h.start('Ask a question');
    turn.child.emit(...questionFrames({ questions: [{ question: 'Choose?' }] }, 42), result()); await turn.completion;
    expect(turn.chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(false);
    expect(turn.chunks.filter(chunk => chunk.type === 'error')).toEqual([
      expect.objectContaining({ content: expect.stringContaining('invalid question') }),
    ]);
  });

  it('releases an invalid mixed question turn when the host stops on its error, without awaiting a native result', async () => {
    const h = harness(); const turn = await h.start('Ask two questions', true, true);
    const input = { questions: [{ question: 'Valid first question?' }, { question: 'Broken second question?', options: 'invalid' }] };
    turn.child.emit(...questionFrames(input), { type: 'control_request', request_id: 'invalid-question-permission',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } });
    try {
      await vi.waitFor(() => expect(turn.settled()).toBe(true), { timeout: 150, interval: 1 });
      expect(turn.chunks.map(chunk => chunk.type)).toEqual(['error']);
      expect(turn.child.frames.at(-1)).toMatchObject({ type: 'control_response', response: {
        request_id: 'invalid-question-permission', response: { behavior: 'deny' },
      } });
      expect(mocks.kill).toHaveBeenCalledOnce();
      const recovered = await h.start('Restate one valid question');
      expect(h.children).toHaveLength(2);
      recovered.child.emit(...questionFrames({ questions: [{ question: 'What is the retry budget?' }] }), result());
      await recovered.completion;
      expect(recovered.chunks.filter(chunk => chunk.type === 'ask_user_question')).toHaveLength(1);
    } finally {
      h.provider.cancelCurrentRequest('panel'); await turn.completion;
    }
  });

  it('keeps native identity and request cleanup stable across 30 Stop/resume cycles', async () => {
    const h = harness(); const initial = await h.start('Establish native conversation');
    initial.child.emit({ type: 'system', subtype: 'init', session_id: 'owned-native-session' }, result('ESTABLISHED'));
    await initial.completion;
    for (let cycle = 0; cycle < 30; cycle++) {
      const stopped = await h.start(`Long request ${cycle}`);
      stopped.child.emit(text(`PARTIAL_${cycle}`));
      await vi.waitFor(() => expect(stopped.chunks.some(chunk => chunk.type === 'text')).toBe(true), { interval: 1 });
      h.provider.cancelCurrentRequest('panel'); await stopped.completion;
      const recovered = await h.start(`Recover request ${cycle}`);
      const resume = recovered.child.args.indexOf('--resume');
      expect(resume).toBeGreaterThanOrEqual(0);
      expect(recovered.child.args[resume + 1]).toBe('owned-native-session');
      // A dead predecessor must not leak its late terminal into the successor.
      stopped.child.emit(text(`STALE_${cycle}`), result('STALE_RESULT'));
      recovered.child.emit(result(`RECOVERED_${cycle}`)); await recovered.completion;
      expect(recovered.chunks).toEqual([{ type: 'text', content: `RECOVERED_${cycle}` }, { type: 'done' }]);
    }
    expect(h.children).toHaveLength(31);
    expect(h.children.flatMap(child => child.frames).filter(frame => frame.type === 'user')).toHaveLength(61);
    expect(mocks.kill).toHaveBeenCalledTimes(30);
  });
});
