import { describe, expect, it } from 'vitest';
import {
  CoordinatorTurnRunner,
  type CoordinatorStreamOptions,
  type CoordinatorTurnConfig,
  type CoordinatorTurnPorts,
  type CoordinatorTurnResult,
} from '../../src/coordinator/CoordinatorTurnRunner';
import type { CoordinatorStreamEvent } from '../../src/services/CoordinatorModelClient';
import type { GatewayChatMessage } from '../../src/services/DeepMystGatewayClient';
import { ALL_MYSTI_KINDS, MYSTI_EXEC_KINDS } from '../../src/utils/mystiDelegateParser';

const NONCE = 'N1234567';
const READ = `<read:${NONCE}>src/a.ts</read>`;
const NATIVE = [{ id: 'call-1', name: 'mysti_read', arguments: '{"path":"src/b.ts"}' }];
type Script = CoordinatorStreamEvent[] | ((options: CoordinatorStreamOptions) => AsyncIterable<CoordinatorStreamEvent>);

function harness(scripts: Script[], config: Partial<CoordinatorTurnConfig> = {}) {
  let cancelled = false;
  const emitted: string[] = [];
  const observed: CoordinatorStreamEvent[] = [];
  const estimates: string[] = [];
  const order: string[] = [];
  const controllers: AbortController[] = [];
  const requests: { messages: GatewayChatMessage[]; options: CoordinatorStreamOptions }[] = [];
  const messages: GatewayChatMessage[] = [{ role: 'system', content: 'protocol' }, { role: 'user', content: 'task' }];
  const ports: CoordinatorTurnPorts = {
    stream: async function* (input, options) {
      const script = scripts[requests.length] ?? [];
      requests.push({ messages: input.map(message => ({ ...message })), options });
      order.push('stream');
      if (typeof script === 'function') { yield* script(options); }
      else { yield* script; }
    },
    isCancelled: () => cancelled,
    registerAbort: controller => { controllers.push(controller); order.push('register'); },
    getMaxTokens: () => 8192,
    beforeTurn: () => { order.push('before'); },
    onTurnText: text => { order.push(`raw:${text}`); },
    output: {
      beginTurn: () => { order.push('begin'); },
      observe: event => { observed.push(event); order.push('observe'); },
      emitText: text => { emitted.push(text); order.push(`text:${text}`); },
      estimateInterruptedTurn: text => { estimates.push(text); order.push('estimate'); },
    },
  };
  const runner = new CoordinatorTurnRunner({ nonce: NONCE, scanKinds: ALL_MYSTI_KINDS, maxTurns: 4, ...config }, ports);
  return {
    runner, ports, emitted, observed, estimates, order, controllers, requests, messages,
    stop() { cancelled = true; controllers.at(-1)?.abort(); },
  };
}

async function collect(turns: AsyncIterable<CoordinatorTurnResult>): Promise<CoordinatorTurnResult[]> {
  const results: CoordinatorTurnResult[] = [];
  for await (const turn of turns) { results.push(turn); }
  return results;
}

describe('CoordinatorTurnRunner', () => {
  it('bounds model turns while the caller executes tools and returns their fenced results', async () => {
    const h = harness([[{ text: READ }], [{ text: READ }], [{ text: 'must not start' }]], { maxTurns: 2 });
    const actions: string[] = [];
    for await (const turn of h.runner.turns(h.messages)) {
      expect(turn.kind).toBe('turn');
      if (turn.kind !== 'turn' || turn.directive?.kind !== 'read') { throw new Error('missing read'); }
      actions.push(turn.directive.path);
      h.messages.push({ role: 'assistant', content: turn.text }, { role: 'user', content: '<<<UNTRUSTED result>>>' });
    }
    expect(actions).toEqual(['src/a.ts', 'src/a.ts']);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].messages.at(-1)?.content).toBe('<<<UNTRUSTED result>>>');
    expect(h.runner.roundTrips).toBe(2);
    expect(h.controllers.every(controller => controller.signal.aborted)).toBe(true);
  });

  it('closes a directive stream before yielding the action, preserving prose and metadata order', async () => {
    let closed = false;
    const event = { text: `Investigating. ${READ}`, reasoning: 'reason', model: 'actual-model', usage: { input_tokens: 8, output_tokens: 5 }, costUsd: 0.01 };
    const h = harness([async function* () {
      try { yield event; yield { text: 'must not consume' }; }
      finally { closed = true; }
    }]);
    const iterator = h.runner.turns(h.messages);
    const result = await iterator.next();
    expect(closed).toBe(true);
    expect(result.value).toMatchObject({ kind: 'turn', directive: { kind: 'read', path: 'src/a.ts' } });
    expect(h.emitted.join('')).toBe('Investigating. ');
    expect(h.observed).toEqual([event]);
    expect(h.estimates).toEqual([event.text]);
    expect(h.order).toEqual(['before', 'register', 'begin', 'stream', 'observe', 'text:Investigating. ', 'estimate', `raw:${event.text}`]);
    await iterator.return();
    expect(h.requests).toHaveLength(1);
  });

  it('reassembles a nonce tag split by a length continuation without exposing it as prose', async () => {
    const h = harness([
      [{ text: 'Checking. <read:N123', finishReason: 'length' }],
      [{ text: '4567>src/a.ts</read>' }],
    ]);
    const iterator = h.runner.turns(h.messages);
    const result = await iterator.next();
    expect(result.value).toMatchObject({ kind: 'turn', directive: { kind: 'read', path: 'src/a.ts' } });
    expect(h.emitted.join('')).toBe('Checking. ');
    expect(h.requests[1].messages.at(-2)).toEqual({ role: 'assistant', content: 'Checking. <read:N123' });
    expect(h.requests[1].messages.at(-1)?.content).toContain('Continue EXACTLY');
    expect(h.order.filter(item => item === 'before')).toHaveLength(2);
    await iterator.return();
  });

  it('shares the two-continuation allowance between visible and reasoning-only length stops', async () => {
    const h = harness([
      [{ reasoning: 'thinking', finishReason: 'length' }],
      [{ text: 'Partial ', finishReason: 'length' }],
      [{ text: 'answer', finishReason: 'length' }],
      [{ text: 'never requested' }],
    ]);
    for await (const turn of h.runner.turns(h.messages)) {
      expect(turn).toEqual({ kind: 'turn', text: 'answer', directive: undefined, toolCalls: undefined });
      break;
    }
    expect(h.requests).toHaveLength(3);
    expect(h.requests[1].messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(h.requests[1].messages.at(-1)?.content).toContain('without emitting a visible answer');
    expect(h.emitted.join('')).toBe('Partial answer');
  });

  it('lets the main turn cap end a continuation chain before its allowance is exhausted', async () => {
    const h = harness([[{ text: 'cut', finishReason: 'length' }]], { maxTurns: 1 });
    expect(await collect(h.runner.turns(h.messages))).toEqual([]);
    expect(h.requests).toHaveLength(1);
    expect(h.runner.roundTrips).toBe(1);
  });

  it('preserves native calls on length finishes and gives their assistant history nonempty text', async () => {
    const h = harness([[{ toolCalls: NATIVE, finishReason: 'length' }]], { tools: [{ type: 'function' }], reasoningEffort: 'high' });
    const iterator = h.runner.turns(h.messages);
    const result = await iterator.next();
    expect(result.value).toEqual({ kind: 'turn', text: '(tool: mysti_read)', toolCalls: NATIVE, directive: undefined });
    expect(h.messages).toHaveLength(2);
    expect(h.requests[0].options).toMatchObject({ maxTokens: 8192, reasoningEffort: 'high', tools: [{ type: 'function' }] });
    expect(h.estimates).toEqual([]);
    await iterator.return();
  });

  it('gives a captured text directive precedence when a native call also arrived', async () => {
    const h = harness([[{ toolCalls: NATIVE }, { text: READ }]]);
    const iterator = h.runner.turns(h.messages);
    const result = await iterator.next();
    expect(result.value).toMatchObject({ kind: 'turn', directive: { kind: 'read', path: 'src/a.ts' }, toolCalls: NATIVE });
    await iterator.return();
  });

  it('recognizes exactly the host-authorized kinds and never executes native calls itself', async () => {
    const write = `<write:${NONCE} path="a.ts">changed</write>`;
    const h = harness([[{ text: write, toolCalls: NATIVE }]]);
    const iterator = h.runner.turns(h.messages);
    const result = await iterator.next();
    expect(result.value).toMatchObject({ kind: 'turn', directive: undefined, toolCalls: NATIVE });
    expect(h.emitted.join('')).toBe(write);
    expect(h.controllers[0].signal.aborted).toBe(true);
    await iterator.return();
  });

  it.each(['event', 'throw'] as const)('returns a %s failure without flushing held markup or starting another turn', async mode => {
    const h = harness([async function* () {
      yield { text: 'Partial <rea' };
      if (mode === 'throw') { throw new Error('401 unauthorized'); }
      yield { error: '401 unauthorized', text: 'discard this', model: 'discard this too' };
    }]);
    const turns = await collect(h.runner.turns(h.messages));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: 'error', message: '401 unauthorized' });
    if (mode === 'throw') { expect(turns[0]).toHaveProperty('cause', new Error('401 unauthorized')); }
    expect(h.emitted.join('')).toBe('Partial ');
    expect(h.observed).toEqual([{ text: 'Partial <rea' }]);
    expect(h.requests).toHaveLength(1);
  });

  it('ignores an iterator teardown rejection caused by its deliberate directive abort', async () => {
    const h = harness([async function* () {
      try { yield { text: READ }; }
      finally { throw new Error('aborted during return'); }
    }]);
    const iterator = h.runner.turns(h.messages);
    expect((await iterator.next()).value).toMatchObject({ kind: 'turn', directive: { kind: 'read' } });
    await iterator.return();
  });

  it('does not start or count a stream when cancellation precedes it', async () => {
    const h = harness([[{ text: 'never requested' }]]);
    h.stop();
    expect(await collect(h.runner.turns(h.messages))).toEqual([]);
    await h.runner.finalize(h.messages);
    expect(h.requests).toEqual([]);
    expect(h.order).toEqual([]);
    expect(h.runner.roundTrips).toBe(0);
  });

  it('rechecks cancellation after registering the host controller', async () => {
    const h = harness([[{ text: 'never requested' }]]);
    h.ports.registerAbort = controller => { h.controllers.push(controller); h.stop(); };
    expect(await collect(h.runner.turns(h.messages))).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(h.controllers[0].signal.aborted).toBe(true);
    expect(h.runner.roundTrips).toBe(0);
  });

  it('settles a cancelled in-flight stream without an error turn or late directive', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const h = harness([async function* (options) {
      entered();
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      yield { text: READ };
    }]);
    const pending = collect(h.runner.turns(h.messages));
    await started;
    h.stop();
    expect(await pending).toEqual([]);
    await h.runner.finalize(h.messages);
    expect(h.emitted).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });

  it('keeps independent run cancellation and scanner state isolated', async () => {
    const first = harness([[{ text: READ }]]);
    const second = harness([[{ text: 'Other panel answer' }]]);
    first.stop();
    const iterator = second.runner.turns(second.messages);
    expect(await collect(first.runner.turns(first.messages))).toEqual([]);
    expect((await iterator.next()).value).toMatchObject({ kind: 'turn', text: 'Other panel answer' });
    expect(second.controllers[0].signal.aborted).toBe(true);
    await iterator.return();
  });

  it('runs at most one additional finalize stream, without tools or directive dispatch', async () => {
    const h = harness([
      [{ text: READ }],
      [{ text: 'Result. ' }, { text: `<write:${NONCE} path="a.ts">do not execute</write>`, toolCalls: NATIVE }],
    ], { maxTurns: 1, tools: [{ type: 'function' }], scanKinds: [...ALL_MYSTI_KINDS, ...MYSTI_EXEC_KINDS] });
    await collect(h.runner.turns(h.messages));
    const originalMessages = structuredClone(h.messages);
    await h.runner.finalize(h.messages);
    await h.runner.finalize(h.messages);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].options).toMatchObject({ maxTokens: 4096 });
    expect(h.requests[1].options).not.toHaveProperty('tools');
    expect(h.requests[1].messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(h.requests[1].messages.at(-1)?.content).toContain('Do NOT emit any tool directives');
    expect(h.messages).toEqual(originalMessages);
    expect(h.emitted.join('')).toBe('Result. ');
    expect(h.runner.roundTrips).toBe(2);
    expect(h.estimates).toEqual([READ]);
  });

  it.each(['event', 'throw'] as const)('keeps rescue prose on a %s failure without surfacing a new error', async mode => {
    const h = harness([async function* () {
      yield { text: 'Partial answer. ' };
      if (mode === 'throw') { throw new Error('rescue failed'); }
      yield { error: 'rescue failed' };
    }]);
    await expect(h.runner.finalize(h.messages)).resolves.toBeUndefined();
    expect(h.emitted.join('')).toBe('Partial answer. ');
    expect(h.runner.roundTrips).toBe(1);
  });

  it('does not flush buffered text after cancellation in the finalize stream', async () => {
    const h = harness([async function* () {
      yield { text: 'Answer <rea' };
      h.stop();
    }]);
    await h.runner.finalize(h.messages);
    expect(h.emitted.join('')).toBe('Answer ');
    expect(h.controllers[0].signal.aborted).toBe(true);
  });

  it('aborts and closes a blocked transport when its consumer returns early', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let closed = false;
    const h = harness([async function* (options) {
      try {
        entered();
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('abandoned')), { once: true });
        });
        yield { text: READ };
      } finally { closed = true; }
    }]);
    const iterator = h.runner.turns(h.messages);
    const pending = iterator.next();
    await started;
    const returned = iterator.return();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await returned).toEqual({ done: true, value: undefined });
    expect(closed).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.emitted).toEqual([]);
  });

  it('does not yield an action after a synchronous host callback cancels the run', async () => {
    const h = harness([[{ text: READ }]]);
    h.ports.onTurnText = () => h.stop();
    expect(await collect(h.runner.turns(h.messages))).toEqual([]);
    expect(h.controllers[0].signal.aborted).toBe(true);
  });

  it('does not restart a spent run through a second iterator', async () => {
    const h = harness([], { maxTurns: 0 });
    await collect(h.runner.turns(h.messages));
    await expect(collect(h.runner.turns(h.messages))).rejects.toThrow('only run once');
    expect(h.requests).toEqual([]);
  });
});
