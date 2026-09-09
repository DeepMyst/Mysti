/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawAgentRun } from '../../../src/providers/openclaw/OpenClawAgentRun';
import type { StreamChunk } from '../../../src/types';

const runs: OpenClawAgentRun[] = [];
function create(options: { signal?: AbortSignal; timeoutMs?: number } = {}, id = 'run-a', session = 'mysti-a') {
  const abort = vi.fn();
  const run = new OpenClawAgentRun(id, session, options, abort);
  runs.push(run);
  return { run, abort };
}
function assistant(run: OpenClawAgentRun, delta: string, extra: Record<string, unknown> = {}) {
  run.onEvent('agent', { runId: run.runId, stream: 'assistant', data: { delta }, ...extra });
}
function chat(run: OpenClawAgentRun, text: string, state = 'delta') {
  run.onEvent('chat', { runId: run.runId, state, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
function complete(run: OpenClawAgentRun, text?: string) {
  run.onResponse({ ok: true, payload: { runId: run.runId, status: 'ok', result: {
    payloads: text === undefined ? [] : [{ text }],
  } } });
}
async function collect(run: OpenClawAgentRun): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of run.chunks()) { chunks.push(chunk); }
  return chunks;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const run of runs.splice(0)) { run.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('OpenClaw gateway run ownership', () => {
  it('accepts pre-ack events by run ID, then enforces the acknowledged canonical session', async () => {
    const { run } = create();
    assistant(run, 'pre', { sessionKey: 'agent:main:mysti-a' });
    assistant(run, 'wrong-run', { runId: 'run-b' });
    run.onEvent('agent', { stream: 'assistant', data: { delta: 'missing ID' } });
    run.onResponse({ ok: true, payload: { runId: 'run-a', status: 'pending' } });
    run.onResponse({ ok: true, payload: { runId: 'run-a', status: 'accepted', sessionKey: 'agent:main:mysti-a' } });
    assistant(run, 'wrong-session', { sessionKey: 'agent:main:mysti-b' });
    assistant(run, 'after', { sessionKey: 'agent:main:mysti-a' });
    expect(run.sessionKey).toBe('agent:main:mysti-a');
    complete(run);
    expect(await collect(run)).toEqual([{ type: 'text', content: 'pre' }, { type: 'text', content: 'after' }]);
  });

  it('keeps two sessions separate and cancels only the owned run', async () => {
    const a = create();
    const b = create({}, 'run-b', 'mysti-b');
    for (const run of [a.run, b.run]) {
      run.onEvent('agent', { runId: 'run-a', stream: 'assistant', data: { delta: 'A' } });
      run.onEvent('agent', { runId: 'run-b', stream: 'assistant', data: { delta: 'B' } });
    }
    a.run.cancel();
    complete(b.run, 'B');
    expect(await collect(a.run)).toEqual([]);
    expect(await collect(b.run)).toEqual([{ type: 'text', content: 'B' }]);
    expect(a.abort).toHaveBeenCalledExactlyOnceWith('mysti-a', 'run-a');
    expect(b.abort).not.toHaveBeenCalled();
  });

  it('a progress ack without a run ID cannot poison canonical session adoption or event filtering', async () => {
    const { run } = create();
    run.onResponse({ ok: true, payload: { status: 'accepted', sessionKey: 'agent:main:wrong' } });
    expect(run.sessionKey).toBe('mysti-a');
    assistant(run, 'before', { sessionKey: 'agent:main:mysti-a' });
    run.onResponse({ ok: true, payload: { runId: run.runId, status: 'accepted', sessionKey: 'agent:main:mysti-a' } });
    expect(run.sessionKey).toBe('agent:main:mysti-a');
    assistant(run, 'wrong', { sessionKey: 'agent:main:wrong' });
    assistant(run, 'after', { sessionKey: 'agent:main:mysti-a' });
    complete(run);
    expect(await collect(run)).toEqual([{ type: 'text', content: 'before' }, { type: 'text', content: 'after' }]);
  });

  it.each(['accepted', 'pending', 'running'])('%s is progress, not final', async status => {
    const { run } = create();
    const iterator = run.chunks();
    let settled = false;
    const pending = iterator.next().then(result => { settled = true; return result; });
    run.onResponse({ ok: true, payload: { runId: run.runId, status } });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(run.isFinished).toBe(false);
    complete(run, 'result');
    expect(await pending).toEqual({ done: false, value: { type: 'text', content: 'result' } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('surfaces an in-flight duplicate as requiring recovery without aborting the existing run', async () => {
    const { run, abort } = create();
    const pending = collect(run);
    run.onResponse({ ok: true, payload: { runId: run.runId, status: 'in_flight', sessionKey: 'agent:main:mysti-a' } });
    expect(await pending).toEqual([{ type: 'error', content: 'OpenClaw Gateway: Run is already active; reconnect/recovery required' }]);
    expect(abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unrelated responses and malformed/unscoped events without completing', async () => {
    const { run } = create();
    run.onResponse({ ok: true, payload: { runId: 'another', status: 'ok', text: 'leak' } });
    for (const data of [null, [], 2, 'bad']) {
      run.onEvent('agent', { runId: run.runId, stream: 'assistant', data });
    }
    run.onEvent('response', { runId: run.runId, text: 'legacy unscoped contract' });
    expect(run.isFinished).toBe(false);
    complete(run, 'safe');
    expect(await collect(run)).toEqual([{ type: 'text', content: 'safe' }]);
  });

  it('deduplicates replayed agent sequences independently from chat sequences', async () => {
    const { run } = create();
    assistant(run, 'A', { seq: 4 });
    assistant(run, 'duplicate', { seq: 4 });
    assistant(run, 'old', { seq: 3 });
    run.onEvent('chat', { runId: run.runId, seq: 4, state: 'delta', message: { content: [{ type: 'text', text: 'AB' }] } });
    assistant(run, 'B', { seq: 5 });
    complete(run, 'AB');
    expect(await collect(run)).toEqual([{ type: 'text', content: 'A' }, { type: 'text', content: 'B' }]);
  });

  it('wakes a silent pending next on abort and removes its listener/deadline', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { run, abort } = create({ signal: controller.signal });
    const pending = run.chunks().next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(run.isCancelled).toBe(true);
    expect(abort).toHaveBeenCalledExactlyOnceWith('mysti-a', 'run-a');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an already-aborted run without installing a timer', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, abort } = create({ signal: controller.signal });
    expect(await collect(run)).toEqual([]);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards queued/stale output and errors after cancellation', async () => {
    const { run, abort } = create();
    assistant(run, 'queued');
    run.cancel();
    assistant(run, 'late');
    complete(run, 'late snapshot');
    run.fail(new Error('late disconnect'));
    run.cancel();
    run.dispose();
    expect(await collect(run)).toEqual([]);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('iterator return wakes a pending empty read and aborts exactly once', async () => {
    const { run, abort } = create();
    const iterator = run.chunks();
    const pending = iterator.next();
    const returned = iterator.return(undefined);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await returned).toEqual({ done: true, value: undefined });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('a deadline wakes a silent stream with one error and targets canonical session', async () => {
    const { run, abort } = create({ timeoutMs: 50 });
    run.onResponse({ ok: true, payload: { runId: run.runId, status: 'accepted', sessionKey: 'agent:main:mysti-a' } });
    const result = collect(run);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual([{ type: 'error', content: 'OpenClaw Gateway: Request timed out' }]);
    expect(abort).toHaveBeenCalledExactlyOnceWith('agent:main:mysti-a', 'run-a');
  });

  it('normal completion and a connection failure release ownership without remote abort', async () => {
    const a = create();
    const b = create({}, 'run-b');
    complete(a.run);
    b.run.fail(new Error('Disconnected'));
    expect(await collect(a.run)).toEqual([]);
    expect(await collect(b.run)).toEqual([{ type: 'error', content: 'Disconnected' }]);
    expect(a.abort).not.toHaveBeenCalled();
    expect(b.abort).not.toHaveBeenCalled();
  });
});

describe('OpenClaw native stream normalization', () => {
  it.each(['before', 'after'])('does not repeat final/chat snapshots arriving %s native deltas', async order => {
    const { run } = create();
    if (order === 'before') { chat(run, 'Hello world', 'final'); }
    assistant(run, 'Hello ');
    assistant(run, 'world');
    if (order === 'after') { chat(run, 'Hello world', 'final'); }
    complete(run, 'Hello world');
    expect(await collect(run)).toEqual([{ type: 'text', content: 'Hello ' }, { type: 'text', content: 'world' }]);
  });

  it.each([
    ['Hello', 'Hello world', 'Hello world'],
    ['Commentary. Hello', 'Hello world', 'Commentary. Hello world'],
    ['Commentary. ', 'New final answer.', 'Commentary. New final answer.'],
  ])('keeps the unstreamed final suffix of %s + %s', async (streamed, final, expected) => {
    const { run } = create();
    assistant(run, streamed);
    complete(run, final);
    expect((await collect(run)).map(chunk => chunk.content).join('')).toBe(expected);
  });

  it('uses chat-only output at final RPC and ignores user message content', async () => {
    const { run } = create();
    chat(run, 'short');
    chat(run, 'short and complete', 'final');
    run.onEvent('chat', { runId: run.runId, message: { role: 'user', content: 'private prompt' } });
    expect(run.isFinished).toBe(false);
    complete(run);
    expect(await collect(run)).toEqual([{ type: 'text', content: 'short and complete' }]);
  });

  it('deduplicates snapshot-only assistant updates after deltas and a long overlapping final suffix', async () => {
    const { run } = create();
    assistant(run, 'Intro. ');
    run.onEvent('agent', { runId: run.runId, stream: 'assistant', data: { text: 'Intro. ' + 'a'.repeat(20_000) } });
    complete(run, 'a'.repeat(20_000) + 'b');
    const chunks = await collect(run);
    expect(chunks.map(chunk => chunk.content).join('')).toBe('Intro. ' + 'a'.repeat(20_000) + 'b');
    expect(chunks.map(chunk => chunk.content?.length)).toEqual([7, 20_000, 1]);
  });

  it('reads nested final payloads and separates reasoning from answer text', async () => {
    const { run } = create();
    run.onResponse({ ok: true, payload: { status: 'ok', result: { payloads: [
      { text: 'First ' }, { text: 'private reasoning', isReasoning: true }, null, { text: 'second' }, { text: {} },
    ] } } });
    expect(await collect(run)).toEqual([{ type: 'text', content: 'First second' }]);
  });

  it('does not treat lifecycle errors/end or a sequence gap as terminal failure', async () => {
    const { run } = create();
    run.onEvent('agent', { runId: run.runId, stream: 'lifecycle', data: { phase: 'error', error: 'model fallback' } });
    run.onEvent('agent', { runId: run.runId, stream: 'lifecycle', data: { phase: 'end' } });
    run.onEvent('agent', { runId: run.runId, stream: 'error', data: { reason: 'seq gap', message: 'lost packet' } });
    expect(run.isFinished).toBe(false);
    complete(run, 'Recovered');
    expect(await collect(run)).toEqual([{ type: 'text', content: 'Recovered' }]);
  });

  it.each(['timeout', 'error'])('surfaces an RPC envelope ok:true with final status:%s as failure', async status => {
    const { run } = create();
    run.onResponse({ ok: true, payload: { runId: run.runId, status, summary: 'run failed', result: { payloads: [{ text: 'partial' }] } } });
    expect(await collect(run)).toEqual([{ type: 'text', content: 'partial' }, { type: 'error', content: 'run failed' }]);
  });

  it('preserves native tool arguments/results and buffers updates without repeating tool execution', async () => {
    const { run } = create();
    const tool = (data: Record<string, unknown>) => run.onEvent('agent', { runId: run.runId, stream: 'tool', data });
    tool({ phase: 'start', toolCallId: 'id[opaque]', name: 'edit', args: { path: '/src/a.ts', content: 'changed' } });
    tool({ phase: 'update', toolCallId: 'id[opaque]', partialResult: { content: [{ type: 'text', text: 'working' }] } });
    tool({ phase: 'result', toolCallId: 'id[opaque]', isError: true, result: { content: [{ type: 'text', text: 'denied' }], details: { code: 1 } } });
    tool({ phase: 'update', toolCallId: 'id[opaque]', partialResult: 'stale' });
    tool({ phase: 'result', toolCallId: 'id[opaque]', result: 'duplicate' });
    complete(run);
    const chunks = await collect(run);
    expect(chunks.map(chunk => chunk.type)).toEqual(['tool_use', 'tool_result']);
    expect(chunks[0].toolCall).toMatchObject({ id: 'id[opaque]', name: 'edit', input: { path: '/src/a.ts', content: 'changed' }, kind: 'edit', status: 'running' });
    expect(chunks[1].toolCall).toMatchObject({ id: 'id[opaque]', name: 'edit', input: chunks[0].toolCall?.input, status: 'failed' });
    expect(JSON.parse(chunks[1].toolCall!.output!)).toEqual({ content: [{ type: 'text', text: 'denied' }], details: { code: 1 } });
  });

  it('retains falsy tool output and the latest partial result when final result omits it', async () => {
    const { run } = create();
    for (const [id, output] of [['zero', 0], ['false', false], ['empty', '']] as const) {
      run.onEvent('agent', { runId: run.runId, stream: 'tool', data: { phase: 'start', toolCallId: id, name: 'read', args: { path: id } } });
      run.onEvent('agent', { runId: run.runId, stream: 'tool', data: { phase: 'update', toolCallId: id, partialResult: output } });
      run.onEvent('agent', { runId: run.runId, stream: 'tool', data: { phase: 'result', toolCallId: id } });
    }
    complete(run);
    expect((await collect(run)).filter(chunk => chunk.type === 'tool_result').map(chunk => chunk.toolCall?.output)).toEqual(['0', 'false', '']);
  });

  it('normalizes thinking deltas and snapshot-only increments without emitting done', async () => {
    const { run } = create();
    for (const data of [{ delta: 'Think' }, { text: 'Thinking' }, { text: 'Thinking' }]) {
      run.onEvent('agent', { runId: run.runId, stream: 'thinking', data });
    }
    complete(run);
    expect(await collect(run)).toEqual([{ type: 'thinking', content: 'Think' }, { type: 'thinking', content: 'ing' }]);
  });
});
