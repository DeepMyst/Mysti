import { describe, expect, it, vi } from 'vitest';
import { CoordinatorRunOrchestrator, type CoordinatorRunOrchestratorPorts } from '../../src/coordinator/CoordinatorRunOrchestrator';
import { CoordinatorTurnRunner, type CoordinatorTurnResult } from '../../src/coordinator/CoordinatorTurnRunner';
import type { CoordinatorToolDispatch } from '../../src/coordinator/CoordinatorToolDispatcher';
import type { GatewayChatMessage } from '../../src/services/DeepMystGatewayClient';
import type { MystiDirective } from '../../src/utils/mystiDelegateParser';

const DELEGATE: Extract<MystiDirective, { kind: 'delegate' }> = { kind: 'delegate', agent: 'hermes', task: 'inspect the change' };
const READ: MystiDirective = { kind: 'read', path: 'src/a.ts' };
const turn = (directive?: MystiDirective): Extract<CoordinatorTurnResult, { kind: 'turn' }> => ({ kind: 'turn', text: 'turn text', directive });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(script: CoordinatorTurnResult[] = [turn()]) {
  const state = { cancelled: false, visible: true, closed: false };
  const order: string[] = [];
  const messages: GatewayChatMessage[] = [{ role: 'user', content: 'task' }];
  const ports = {
    turns: vi.fn(async function* (_messages: GatewayChatMessage[]) {
      try { for (const item of script) { order.push('turn'); yield item; } }
      finally { state.closed = true; order.push('close'); }
    }),
    dispatchTool: vi.fn(async (item: Extract<CoordinatorTurnResult, { kind: 'turn' }>, _messages: GatewayChatMessage[]): Promise<CoordinatorToolDispatch> => {
      order.push('tool');
      return { kind: 'unhandled', directive: item.directive };
    }),
    delegate: vi.fn(async (_directive: typeof DELEGATE, _text: string, _messages: GatewayChatMessage[]): Promise<'handled' | 'cancelled'> => {
      order.push('delegate');
      return 'handled';
    }),
    isCancelled: () => state.cancelled,
    hasVisibleText: () => state.visible,
    finalize: vi.fn(async (_messages: GatewayChatMessage[]) => { order.push('finalize'); state.visible = true; }),
    onError: vi.fn((_error: Extract<CoordinatorTurnResult, { kind: 'error' }>) => { order.push('error'); }),
  } satisfies CoordinatorRunOrchestratorPorts;
  return { ports, state, order, messages, orchestrator: new CoordinatorRunOrchestrator(ports) };
}

describe('CoordinatorRunOrchestrator', () => {
  it('ends on a natural answer and closes the iterator before any unused turn', async () => {
    const h = harness([turn(), turn(DELEGATE)]);
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: true, exhausted: false });
    expect(h.order).toEqual(['turn', 'tool', 'close']);
    expect(h.ports.delegate).not.toHaveBeenCalled();
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it('uses the converted dispatch directive and shares ordered history with subsequent turns', async () => {
    const nativeTurn = { kind: 'turn' as const, text: '(native call)', toolCalls: [{ id: 'n1', name: 'mysti_delegate', arguments: '{}' }] };
    const h = harness([turn(READ), nativeTurn, turn()]);
    h.ports.dispatchTool.mockImplementation(async (item, messages) => {
      if (item.directive?.kind === 'read') {
        messages.push({ role: 'assistant', content: item.text }, { role: 'user', content: 'fenced read result' });
        return { kind: 'handled' };
      }
      if (item === nativeTurn) {
        expect(messages.at(-1)?.content).toBe('fenced read result');
        return { kind: 'unhandled', directive: DELEGATE };
      }
      expect(messages.at(-1)?.content).toBe('fenced delegation result');
      return { kind: 'unhandled' };
    });
    h.ports.delegate.mockImplementation(async (directive, text, messages) => {
      expect(directive).toBe(DELEGATE);
      expect(text).toBe(nativeTurn.text);
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'fenced delegation result' });
      return 'handled';
    });
    expect(await h.orchestrator.run(h.messages)).toMatchObject({ naturalEnd: true });
    expect(h.ports.turns).toHaveBeenCalledWith(h.messages);
    expect(h.ports.dispatchTool).toHaveBeenCalledTimes(3);
    expect(h.ports.delegate).toHaveBeenCalledTimes(1);
  });

  it('leaves an unhandled non-delegate directive at the existing natural-end fallback', async () => {
    const h = harness([turn(READ), turn(DELEGATE)]);
    expect(await h.orchestrator.run(h.messages)).toMatchObject({ naturalEnd: true });
    expect(h.ports.delegate).not.toHaveBeenCalled();
    expect(h.ports.dispatchTool).toHaveBeenCalledTimes(1);
  });

  it('does not start a cancelled owner or try a rescue', async () => {
    const h = harness();
    h.state.cancelled = true;
    h.state.visible = false;
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: false, exhausted: false });
    expect(h.ports.turns).not.toHaveBeenCalled();
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it.each(['turn', 'error'] as const)('checks ownership after an asynchronous %s iterator handoff', async kind => {
    const h = harness();
    const ready = deferred<void>();
    const release = deferred<void>();
    h.state.visible = false;
    h.ports.turns.mockImplementation(async function* () {
      try {
        ready.resolve();
        await release.promise;
        yield kind === 'turn' ? turn(DELEGATE) : { kind: 'error', message: 'late error' };
      } finally { h.state.closed = true; }
    });
    const pending = h.orchestrator.run(h.messages);
    await ready.promise;
    h.state.cancelled = true;
    release.resolve();
    expect(await pending).toEqual({ errored: false, naturalEnd: false, exhausted: false });
    expect(h.state.closed).toBe(true);
    expect(h.ports.dispatchTool).not.toHaveBeenCalled();
    expect(h.ports.onError).not.toHaveBeenCalled();
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it.each(['handled', 'unhandled', 'cancelled'] as const)('checks ownership after %s tool dispatch and closes the iterator', async kind => {
    const h = harness([turn(DELEGATE), turn()]);
    h.state.visible = false;
    h.ports.dispatchTool.mockImplementation(async () => {
      h.state.cancelled = true;
      return kind === 'unhandled' ? { kind, directive: DELEGATE } : { kind };
    });
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: false, exhausted: false });
    expect(h.state.closed).toBe(true);
    expect(h.ports.delegate).not.toHaveBeenCalled();
    expect(h.ports.dispatchTool).toHaveBeenCalledTimes(1);
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it.each(['tool', 'delegate'] as const)('honors the %s cancellation result independently of the ownership predicate', async source => {
    const h = harness([turn(DELEGATE), turn()]);
    h.state.visible = false;
    if (source === 'tool') { h.ports.dispatchTool.mockResolvedValue({ kind: 'cancelled' }); }
    else { h.ports.delegate.mockResolvedValue('cancelled'); }
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: false, exhausted: false });
    expect(h.state.cancelled).toBe(false);
    expect(h.state.closed).toBe(true);
    expect(h.ports.dispatchTool).toHaveBeenCalledTimes(1);
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it('checks cancellation after delegation before asking for another turn', async () => {
    const h = harness([turn(DELEGATE), turn()]);
    h.state.visible = false;
    h.ports.delegate.mockImplementation(async () => { h.state.cancelled = true; return 'handled'; });
    expect(await h.orchestrator.run(h.messages)).toMatchObject({ naturalEnd: false, exhausted: false });
    expect(h.ports.dispatchTool).toHaveBeenCalledTimes(1);
    expect(h.ports.finalize).not.toHaveBeenCalled();
    expect(h.state.closed).toBe(true);
  });

  it('reports a model error once and skips the rescue even when there is no visible answer', async () => {
    const error = { kind: 'error' as const, message: 'upstream failed', cause: new Error('underlying failure') };
    const h = harness([error, turn(DELEGATE)]);
    h.state.visible = false;
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: true, naturalEnd: false, exhausted: false });
    expect(h.ports.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.order).toEqual(['turn', 'error', 'close']);
    expect(h.ports.dispatchTool).not.toHaveBeenCalled();
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it('marks exhaustion when the turn source ends with only handled work and visible partial prose', async () => {
    const h = harness([turn(DELEGATE), turn(READ)]);
    h.ports.dispatchTool.mockImplementation(async item => item.directive?.kind === 'delegate'
      ? { kind: 'unhandled', directive: item.directive } : { kind: 'handled' });
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: false, exhausted: true });
    expect(h.ports.delegate).toHaveBeenCalledTimes(1);
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it.each([true, false])('runs a single rescue after exhaustion; visible result=%s determines completion', async visibleResult => {
    const h = harness([turn(DELEGATE)]);
    h.state.visible = false;
    h.ports.finalize.mockImplementation(async messages => {
      expect(messages).toBe(h.messages);
      expect(h.state.closed).toBe(true);
      h.state.visible = visibleResult;
    });
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: visibleResult, exhausted: !visibleResult });
    expect(h.ports.finalize).toHaveBeenCalledTimes(1);
  });

  it('also rescues an empty natural answer without dispatching another tool turn', async () => {
    const h = harness([turn(), turn(DELEGATE)]);
    h.state.visible = false;
    expect(await h.orchestrator.run(h.messages)).toMatchObject({ naturalEnd: true });
    expect(h.ports.finalize).toHaveBeenCalledTimes(1);
    expect(h.ports.dispatchTool).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation after iterator teardown before starting the rescue', async () => {
    const h = harness();
    h.state.visible = false;
    h.ports.turns.mockImplementation(async function* () {
      try { yield turn(DELEGATE); }
      finally { h.state.cancelled = true; }
    });
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: false, exhausted: false });
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it('does not call a cancelled rescue a completed answer or turn-limit exhaustion', async () => {
    const h = harness([]);
    h.state.visible = false;
    h.ports.finalize.mockImplementation(async () => { h.state.visible = true; h.state.cancelled = true; });
    expect(await h.orchestrator.run(h.messages)).toEqual({ errored: false, naturalEnd: false, exhausted: false });
    expect(h.ports.finalize).toHaveBeenCalledTimes(1);
  });

  it.each(['tool', 'delegate', 'error callback'] as const)('closes the iterator and propagates unexpected %s failure to host cleanup', async source => {
    const error = new Error('host port failed');
    const h = harness(source === 'error callback' ? [{ kind: 'error', message: 'transport' }] : [turn(DELEGATE)]);
    h.state.visible = false;
    if (source === 'tool') { h.ports.dispatchTool.mockRejectedValue(error); }
    else if (source === 'delegate') { h.ports.delegate.mockRejectedValue(error); }
    else { h.ports.onError.mockImplementation(() => { throw error; }); }
    await expect(h.orchestrator.run(h.messages)).rejects.toBe(error);
    expect(h.state.closed).toBe(true);
    expect(h.ports.finalize).not.toHaveBeenCalled();
    await expect(h.orchestrator.run(h.messages)).rejects.toThrow('only run once');
  });

  it('propagates iterator failure and does not start the rescue', async () => {
    const error = new Error('iterator failed');
    const h = harness();
    h.state.visible = false;
    h.ports.turns.mockImplementation(async function* () {
      try { yield turn(DELEGATE); throw error; }
      finally { h.state.closed = true; }
    });
    await expect(h.orchestrator.run(h.messages)).rejects.toBe(error);
    expect(h.state.closed).toBe(true);
    expect(h.ports.finalize).not.toHaveBeenCalled();
  });

  it('propagates unexpected rescue rejection without reopening the closed iterator', async () => {
    const h = harness([]);
    h.state.visible = false;
    const error = new Error('rescue port failed');
    h.ports.finalize.mockRejectedValue(error);
    await expect(h.orchestrator.run(h.messages)).rejects.toBe(error);
    expect(h.state.closed).toBe(true);
    expect(h.ports.turns).toHaveBeenCalledTimes(1);
    expect(h.ports.finalize).toHaveBeenCalledTimes(1);
  });

  it('rejects concurrent and completed reuse without stealing the original owner', async () => {
    const h = harness();
    const arrived = deferred<void>();
    const release = deferred<CoordinatorToolDispatch>();
    h.ports.dispatchTool.mockImplementation(async () => { arrived.resolve(); return release.promise; });
    const pending = h.orchestrator.run(h.messages);
    await arrived.promise;
    await expect(h.orchestrator.run([])).rejects.toThrow('only run once');
    release.resolve({ kind: 'unhandled' });
    expect(await pending).toMatchObject({ naturalEnd: true });
    await expect(h.orchestrator.run([])).rejects.toThrow('only run once');
    expect(h.ports.turns).toHaveBeenCalledTimes(1);
  });

  it('keeps the actual turn-runner cap and single additional rescue with no native tools', async () => {
    const requests: { tools?: unknown[] }[] = [];
    let visible = '';
    const runner = new CoordinatorTurnRunner({ nonce: 'N1234567', scanKinds: ['read'], maxTurns: 2, tools: ['schema'] }, {
      isCancelled: () => false,
      registerAbort: () => {},
      getMaxTokens: () => 4096,
      stream: async function* (_messages, options) {
        requests.push(options);
        yield { text: requests.length <= 2 ? '<read:N1234567>src/a.ts</read>' : 'Final answer' };
      },
      output: { beginTurn() {}, observe() {}, estimateInterruptedTurn() {}, emitText(text) { visible += text; } },
    });
    const dispatch = vi.fn(async (_item, messages: GatewayChatMessage[]): Promise<CoordinatorToolDispatch> => {
      messages.push({ role: 'assistant', content: 'read' }, { role: 'user', content: 'fenced result' });
      return { kind: 'handled' };
    });
    const delegate = vi.fn(async () => 'handled' as const);
    const orchestrator = new CoordinatorRunOrchestrator({
      turns: messages => runner.turns(messages), dispatchTool: dispatch, delegate,
      isCancelled: () => false, hasVisibleText: () => !!visible.trim(),
      finalize: messages => runner.finalize(messages), onError: () => {},
    });
    expect(await orchestrator.run([{ role: 'user', content: 'task' }])).toEqual({ errored: false, naturalEnd: true, exhausted: false });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(delegate).not.toHaveBeenCalled();
    expect(runner.roundTrips).toBe(3);
    expect(requests.map(request => request.tools)).toEqual([['schema'], ['schema'], undefined]);
    expect(visible).toBe('Final answer');
  });
});
