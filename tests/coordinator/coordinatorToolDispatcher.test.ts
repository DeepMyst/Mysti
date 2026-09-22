import { describe, expect, it, vi } from 'vitest';
import { CoordinatorToolDispatcher, type CoordinatorToolPorts, type CoordinatorToolResult } from '../../src/coordinator/CoordinatorToolDispatcher';
import { CoordinatorRunBudget, resolveCoordinatorRunLimits, type CoordinatorRunLimits } from '../../src/coordinator/CoordinatorRunBudget';
import type { MystiDirective } from '../../src/utils/mystiDelegateParser';
import type { AccumulatedToolCall } from '../../src/utils/toolCallAccumulator';
import type { GatewayChatMessage } from '../../src/services/DeepMystGatewayClient';
import type { McpToolInfo } from '../../src/services/coordinatorTools';

const ok = (output = 'result'): CoordinatorToolResult => ({ ok: true, output });
const native = (name: string, args: Record<string, unknown> = {}): AccumulatedToolCall => ({ id: `native-${name}`, name, arguments: JSON.stringify(args) });
const read = (path: string): MystiDirective => ({ kind: 'read', path });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(limits: Partial<CoordinatorRunLimits> = {}, mcpTools?: McpToolInfo[]) {
  let cancelled = false;
  let nextId = 0;
  const events: string[] = [];
  const messages: GatewayChatMessage[] = [];
  const budget = new CoordinatorRunBudget({ ...resolveCoordinatorRunLimits('medium', () => undefined), ...limits });
  const ports = {
    isCancelled: () => cancelled,
    nextToolId: (prefix: string) => `${prefix}-${nextId++}`,
    output: {
      postToolUse: vi.fn<CoordinatorToolPorts['output']['postToolUse']>(tool => { events.push(`use:${tool.id}`); }),
      postToolResult: vi.fn<CoordinatorToolPorts['output']['postToolResult']>(tool => { events.push(`result:${tool.id}`); }),
      recordTool: vi.fn<CoordinatorToolPorts['output']['recordTool']>(id => { events.push(`record:${id}`); }),
    },
    fenceResult: vi.fn((kind: string, output: string) => `FENCED[${kind}]${output}[/FENCED]`),
    batchReadOnlyPrefix: vi.fn(() => false),
    readLocal: vi.fn<CoordinatorToolPorts['readLocal']>(async () => ok()),
    executeLocal: vi.fn<CoordinatorToolPorts['executeLocal']>(async () => ok()),
    remember: vi.fn<CoordinatorToolPorts['remember']>(),
    connect: vi.fn<CoordinatorToolPorts['connect']>(),
    publish: vi.fn<CoordinatorToolPorts['publish']>(async () => ok()),
    runSkill: vi.fn<CoordinatorToolPorts['runSkill']>(async () => ok()),
    lookupSkill: vi.fn<CoordinatorToolPorts['lookupSkill']>(async () => ok()),
    executeMcp: vi.fn<CoordinatorToolPorts['executeMcp']>(async () => ok()),
    noteMcpUsage: vi.fn<CoordinatorToolPorts['noteMcpUsage']>(),
    executeVisual: vi.fn<CoordinatorToolPorts['executeVisual']>(async () => ok()),
    noteVisualResult: vi.fn<CoordinatorToolPorts['noteVisualResult']>(),
    canvasToolLabel: (tool: string) => `canvas:${tool}`,
    executeCanvas: vi.fn<CoordinatorToolPorts['executeCanvas']>(async () => ok()),
  } satisfies CoordinatorToolPorts;
  const dispatcher = new CoordinatorToolDispatcher(budget, ports, mcpTools);
  const dispatch = (directive?: MystiDirective, toolCalls?: AccumulatedToolCall[]) => {
    dispatcher.beginTurn();
    return dispatcher.dispatch({ kind: 'turn', text: 'assistant turn', directive, toolCalls }, messages);
  };
  return { dispatcher, ports, budget, messages, events, dispatch, stop: () => { cancelled = true; } };
}

describe('CoordinatorToolDispatcher run ownership and tool ordering', () => {
  it('honors the earlier text directive over native calls and leaves delegation accounting alone', async () => {
    const h = harness();
    await h.dispatch(read('earlier'), [native('write', { path: 'later', content: 'no' })]);
    expect(h.ports.readLocal).toHaveBeenCalledWith(read('earlier'));
    expect(h.ports.executeLocal).not.toHaveBeenCalled();
    expect(h.budget.used('delegations')).toBe(0);
    expect(h.messages).toEqual([{ role: 'assistant', content: 'assistant turn' }, { role: 'user', content: 'FENCED[read]result[/FENCED]' }]);
  });

  it('converges native and text mutation requests on the same serial, permission-enforcing port', async () => {
    const h = harness();
    h.ports.executeLocal.mockResolvedValue({ ok: false, output: 'approval denied' });
    const directive: MystiDirective = { kind: 'write', path: 'a', content: 'bytes' };
    await h.dispatch(directive);
    await h.dispatch(undefined, [native('write', { path: 'a', content: 'bytes' }), native('bash', { command: 'must not run' })]);
    expect(h.ports.executeLocal.mock.calls.map(call => call[0])).toEqual([directive, directive]);
    expect(h.budget.used('localExec')).toBe(2);
    expect(h.ports.output.recordTool).toHaveBeenLastCalledWith('exec-1', 'write', { path: 'a' }, 'approval denied', true);
  });

  it('reserves the whole admitted batch, posts all cards before work, caps concurrency at three, and replays in model order', async () => {
    const h = harness({ maxLocalTools: 4 });
    const pending = Array.from({ length: 4 }, () => deferred<CoordinatorToolResult>());
    let active = 0;
    let maxActive = 0;
    h.ports.readLocal.mockImplementation(async directive => {
      const i = Number((directive as Extract<MystiDirective, { kind: 'read' }>).path);
      expect(h.budget.used('localTools')).toBe(4);
      expect(h.ports.output.postToolUse).toHaveBeenCalledTimes(4);
      maxActive = Math.max(maxActive, ++active);
      const result = await pending[i].promise;
      active--;
      return result;
    });
    const work = h.dispatch(undefined, Array.from({ length: 5 }, (_, i) => native('read', { path: String(i) })));
    expect(h.ports.readLocal).toHaveBeenCalledTimes(3);
    pending[2].resolve(ok('third'));
    await vi.waitFor(() => expect(h.ports.readLocal).toHaveBeenCalledTimes(4));
    pending[3].resolve(ok('fourth'));
    pending[1].resolve(ok('second'));
    pending[0].resolve(ok('first'));
    await work;
    expect(maxActive).toBe(3);
    expect(h.ports.output.recordTool.mock.calls.map(call => call[3])).toEqual(['first', 'second', 'third', 'fourth']);
    expect(h.events.slice(0, 4)).toEqual(['use:local-0', 'use:local-1', 'use:local-2', 'use:local-3']);
    expect(h.messages.at(-1)?.content).toContain('1 further tool call(s) were not run — the local tool budget was reached');
  });

  it('runs only the leading read batch with Boost; gated effects remain deferred', async () => {
    const h = harness();
    h.ports.batchReadOnlyPrefix.mockReturnValue(true);
    await h.dispatch(undefined, [native('read', { path: 'a' }), native('ls'), native('write', { path: 'b', content: 'x' }), native('read', { path: 'c' })]);
    expect(h.ports.readLocal).toHaveBeenCalledTimes(2);
    expect(h.ports.executeLocal).not.toHaveBeenCalled();
    expect(h.messages.at(-1)?.content).toContain('2 further tool call(s) were not run because they are not read-only');
  });

  it('keeps a mixed native batch serial without Boost, including visual reads that can need approval', async () => {
    const h = harness();
    await h.dispatch(undefined, [native('read', { path: 'a' }), native('read', { path: 'b' }), native('look')]);
    expect(h.ports.readLocal).toHaveBeenCalledTimes(1);
    expect(h.ports.executeVisual).not.toHaveBeenCalled();
  });

  it('returns argument errors without executing or charging a tool', async () => {
    const h = harness();
    await h.dispatch(undefined, [native('write', { content: 'missing path' }), native('read', { path: 'b' })]);
    expect(h.ports.executeLocal).not.toHaveBeenCalled();
    expect(h.ports.readLocal).not.toHaveBeenCalled();
    expect(h.ports.output.postToolUse).not.toHaveBeenCalled();
    expect(h.messages.at(-1)?.content).toContain('Tool call error:');
    expect(h.budget.used('localExec')).toBe(0);
  });

  it('refuses work after Stop, before IDs, cards, budgets or effects are touched', async () => {
    const h = harness();
    h.stop();
    expect(await h.dispatch({ kind: 'write', path: 'a', content: 'b' })).toEqual({ kind: 'cancelled' });
    expect(h.ports.output.postToolUse).not.toHaveBeenCalled();
    expect(h.ports.executeLocal).not.toHaveBeenCalled();
    expect(h.budget.used('localExec')).toBe(0);
    expect(h.messages).toEqual([]);
  });

  it('settles a card completed after Stop but never appends its result to a successor turn', async () => {
    const h = harness();
    const pending = deferred<CoordinatorToolResult>();
    h.ports.executeLocal.mockReturnValue(pending.promise);
    const work = h.dispatch({ kind: 'edit', path: 'a', oldString: 'a', newString: 'b', replaceAll: false });
    h.stop();
    pending.resolve({ ok: false, output: 'cancelled at approval' });
    expect(await work).toEqual({ kind: 'cancelled' });
    expect(h.ports.output.recordTool).toHaveBeenCalledTimes(1);
    expect(h.messages).toEqual([]);
  });

  it('stops queued batch reads and settles every already-posted card in input order', async () => {
    const h = harness();
    const pending = deferred<CoordinatorToolResult>();
    h.ports.readLocal.mockReturnValue(pending.promise);
    const work = h.dispatch(undefined, Array.from({ length: 6 }, (_, i) => native('read', { path: String(i) })));
    expect(h.ports.readLocal).toHaveBeenCalledTimes(3);
    h.stop();
    pending.resolve(ok('already running'));
    expect(await work).toEqual({ kind: 'cancelled' });
    expect(h.ports.readLocal).toHaveBeenCalledTimes(3);
    expect(h.ports.output.postToolResult).toHaveBeenCalledTimes(6);
    expect(h.ports.output.recordTool.mock.calls.map(call => call[3])).toEqual(['already running', 'already running', 'already running', '(cancelled by user)', '(cancelled by user)', '(cancelled by user)']);
    expect(h.messages).toEqual([]);
  });

  it('rejects overlapping dispatch while one approval is pending', async () => {
    const h = harness();
    const approval = deferred<CoordinatorToolResult>();
    h.ports.executeLocal.mockReturnValue(approval.promise);
    const first = h.dispatch({ kind: 'bash', command: 'first' });
    await expect(h.dispatch({ kind: 'bash', command: 'second' })).rejects.toThrow('dispatched serially');
    expect(h.ports.executeLocal).toHaveBeenCalledTimes(1);
    approval.resolve(ok());
    await first;
    await h.dispatch(read('next'));
    expect(h.ports.readLocal).toHaveBeenCalledTimes(1);
  });

  it('hands delegation and a natural final answer back to the run owner', async () => {
    const h = harness();
    const delegate: MystiDirective = { kind: 'delegate', agent: 'test', task: 'task' };
    expect(await h.dispatch(delegate)).toEqual({ kind: 'unhandled', directive: delegate });
    expect(await h.dispatch()).toEqual({ kind: 'unhandled', directive: undefined });
    expect(h.messages).toEqual([]);
  });
});

describe('CoordinatorToolDispatcher capability budgets and effects', () => {
  it('retains denied local execution charges and shares that cap with registered skills', async () => {
    const h = harness({ maxLocalExec: 1 });
    h.ports.executeLocal.mockResolvedValue({ ok: false, output: 'denied' });
    await h.dispatch({ kind: 'bash', command: 'cmd' });
    await h.dispatch({ kind: 'skillrun', tool: 'task', args: {} });
    expect(h.ports.runSkill).not.toHaveBeenCalled();
    expect(h.budget.used('localExec')).toBe(1);
    expect(h.ports.output.recordTool).toHaveBeenLastCalledWith('skillrun-1', 'skillrun', { tool: 'task' }, 'Capability budget reached (1 per run).', true);
  });

  it('shares local reads and catalog lookup budget while collecting only admitted catalog telemetry', async () => {
    const h = harness({ maxLocalTools: 2 });
    await h.dispatch({ kind: 'skill', query: 'layout' });
    await h.dispatch({ kind: 'skill', id: 'artifact', part: 'body' });
    await h.dispatch(read('blocked'));
    await h.dispatch({ kind: 'skill', id: 'blocked' });
    expect(h.ports.readLocal).not.toHaveBeenCalled();
    expect(h.ports.lookupSkill).toHaveBeenCalledTimes(2);
    expect(h.dispatcher.skillSearches).toBe(1);
    expect(h.dispatcher.skillViewed).toEqual(['artifact']);
    h.dispatcher.skillViewed.push('caller cannot mutate telemetry');
    expect(h.dispatcher.skillViewed).toEqual(['artifact']);
  });

  it('keeps memory limits and connection dedupe scoped to each run', async () => {
    const a = harness();
    for (let i = 0; i < 9; i++) { await a.dispatch({ kind: 'remember', fact: `fact ${i}` }); }
    await a.dispatch({ kind: 'connect', service: 'drive' });
    await a.dispatch({ kind: 'connect', service: 'drive' });
    const b = harness();
    await b.dispatch({ kind: 'remember', fact: 'new run' });
    await b.dispatch({ kind: 'connect', service: 'drive' });
    expect(a.ports.remember).toHaveBeenCalledTimes(8);
    expect(a.ports.connect).toHaveBeenCalledTimes(1);
    expect(b.ports.remember).toHaveBeenCalledTimes(1);
    expect(b.ports.connect).toHaveBeenCalledTimes(1);
  });

  it('refuses disconnected and invented MCP tools before any external effect or charge', async () => {
    for (const tools of [undefined, [{ name: 'KNOWN' }]]) {
      const h = harness({}, tools);
      await h.dispatch({ kind: 'mcptool', tool: 'INVENTED', args: {} });
      expect(h.ports.executeMcp).not.toHaveBeenCalled();
      expect(h.budget.used('mcpCalls')).toBe(0);
      expect(h.ports.output.recordTool).toHaveBeenCalledTimes(1);
    }
  });

  it('charges connected MCP calls before their approval and counts usage only after success', async () => {
    const h = harness({ maxMcpCalls: 2 }, [{ name: 'KNOWN', description: 'connected description' }]);
    h.ports.executeMcp.mockImplementationOnce(async () => {
      expect(h.budget.used('mcpCalls')).toBe(1);
      return { ok: false, output: 'denied' };
    });
    await h.dispatch({ kind: 'mcptool', tool: 'KNOWN', args: { body: 'data' } });
    await h.dispatch(undefined, [native('mcp__KNOWN', { body: 'data' })]);
    await h.dispatch({ kind: 'mcptool', tool: 'KNOWN', args: {} });
    expect(h.ports.executeMcp).toHaveBeenCalledTimes(2);
    expect(h.ports.executeMcp).toHaveBeenNthCalledWith(1, { kind: 'mcptool', tool: 'KNOWN', args: { body: 'data' } }, 'mcp-0', 'connected description');
    expect(h.ports.noteMcpUsage).toHaveBeenCalledExactlyOnceWith('KNOWN');
    expect(h.ports.fenceResult).toHaveBeenCalledWith('mcptool:KNOWN', 'result');
  });

  it('fences third-party schema metadata without invoking external tools', async () => {
    const h = harness({}, [{ name: 'MAIL_SEND', description: 'mail tool', inputSchema: { type: 'object' } }]);
    await h.dispatch({ kind: 'findtool', query: 'MAIL' });
    expect(h.messages.at(-1)?.content).toContain('FENCED[findtool]MAIL_SEND');
    expect(h.ports.executeMcp).not.toHaveBeenCalled();
    expect(h.budget.used('mcpCalls')).toBe(0);
  });

  it('keeps visual and Canvas caps separate, settles failed cards and forwards visual progress', async () => {
    const h = harness({ maxVisualLooks: 1, maxCanvasCalls: 1 });
    const failed = { ok: false, output: 'visual denied' };
    h.ports.executeVisual.mockResolvedValue(failed);
    await h.dispatch({ kind: 'look' });
    await h.dispatch({ kind: 'act', actions: [{ click: 'button' }] });
    await h.dispatch({ kind: 'canvas', tool: 'list_pages', args: {} });
    await h.dispatch({ kind: 'canvas', tool: 'list_pages', args: {} });
    expect(h.ports.executeVisual).toHaveBeenCalledTimes(1);
    expect(h.ports.noteVisualResult).toHaveBeenCalledExactlyOnceWith(failed);
    expect(h.ports.executeCanvas).toHaveBeenCalledTimes(1);
    expect(h.ports.fenceResult).toHaveBeenCalledWith('canvas:list_pages', 'result');
    expect(h.budget.used('localExec')).toBe(0);
  });

  it('passes publication through its gated port and fences the outcome', async () => {
    const h = harness();
    h.ports.publish.mockResolvedValue({ ok: false, output: 'second approval denied' });
    await h.dispatch({ kind: 'publish', id: 'staged' });
    expect(h.ports.publish).toHaveBeenCalledExactlyOnceWith('staged', 'publish-0');
    expect(h.messages.at(-1)?.content).toBe('FENCED[publish]second approval denied[/FENCED]');
  });

  it('counts repeated reads and consecutive read turns but resets the shape for non-tool streams', async () => {
    const h = harness();
    await h.dispatch(read('a'));
    await h.dispatch(read('a'));
    h.dispatcher.beginTurn(); // A length continuation is still a model round trip.
    await h.dispatch(read('b'));
    expect(h.dispatcher.redundantToolCalls).toBe(1);
    expect(h.dispatcher.mergeableRoundTrips).toBe(1);
    expect(harness().dispatcher.redundantToolCalls).toBe(0);
  });
});

describe('CoordinatorToolDispatcher visual cancellation receipts', () => {
  it('records cleanup-incomplete cancellation as failed without model replay or a success mini-status', async () => {
    const h = harness(); const output = 'Visual operation cancelled; resource cleanup could not be confirmed.';
    h.ports.executeVisual.mockResolvedValue({ ok: false, cancelled: true, cleanupIncomplete: true, output });
    expect(await h.dispatch({ kind: 'look' })).toEqual({ kind: 'cancelled' });
    expect(h.ports.output.postToolResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', output }));
    expect(h.ports.output.recordTool).toHaveBeenCalledWith(expect.any(String), 'look', expect.any(Object), output, true);
    expect(h.ports.noteVisualResult).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
  });

  it('refuses a successful visual result which arrives after Stop', async () => {
    const h = harness(); const visual = deferred<CoordinatorToolResult>(); h.ports.executeVisual.mockReturnValue(visual.promise);
    const running = h.dispatch({ kind: 'look' }); h.stop(); visual.resolve(ok('late success'));
    expect(await running).toEqual({ kind: 'cancelled' });
    expect(h.ports.output.postToolResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', output: 'Visual operation cancelled.' }));
    expect(h.ports.noteVisualResult).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
  });
});
