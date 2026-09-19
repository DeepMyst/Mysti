import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepMystGatewayClient, type GatewayChatMessage, type GatewayStreamEvent } from '../../src/services/DeepMystGatewayClient';
import { CoordinatorModelClient } from '../../src/services/CoordinatorModelClient';
import type { OpenRouterClient } from '../../src/services/OpenRouterClient';
import { CoordinatorTurnRunner } from '../../src/coordinator/CoordinatorTurnRunner';
import { CoordinatorRunOrchestrator } from '../../src/coordinator/CoordinatorRunOrchestrator';
import { CoordinatorToolDispatcher } from '../../src/coordinator/CoordinatorToolDispatcher';
import { CoordinatorRunBudget, resolveCoordinatorRunLimits } from '../../src/coordinator/CoordinatorRunBudget';
import { ALL_MYSTI_KINDS, MYSTI_EXEC_KINDS, type MystiDirective } from '../../src/utils/mystiDelegateParser';
import { MAX_HTTP_FRAME_CHARS } from '../../src/utils/httpStream';

const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = (calls: unknown) => sse({ choices: [{ delta: { tool_calls: calls } }] });
const call = (name = 'bash', args = '{"command":"printf inert_gateway_fixture"}', index = 0, id = `call-${index}`) =>
  delta([{ index, id, type: 'function', function: { name, arguments: args } }]);
const finish = (reason: string) => sse({ choices: [{ delta: {}, finish_reason: reason }] });
const done = sse('[DONE]');
const answer = sse({ choices: [{ delta: { content: 'Inert fixture complete.' } }] }) + finish('stop') + done;
const complete = (wire: string) => wire + finish('tool_calls') + done;
const MODEL = 'openrouter/openai/gpt-oss-120b:free';
afterEach(() => vi.unstubAllGlobals());

async function collect(wire: string | Uint8Array): Promise<GatewayStreamEvent[]> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wire)));
  const gateway = new DeepMystGatewayClient(() => 'dm_inert_fixture', () => 'http://127.0.0.1');
  const events: GatewayStreamEvent[] = [];
  for await (const event of gateway.streamChat({ model: MODEL, messages: [] })) { events.push(event); }
  return events;
}

const invalid: [string, string][] = [
  ['EOF without a terminal', call()],
  ['EOF after a tool terminal', call() + finish('tool_calls')],
  ['malformed data', call() + 'data: {BROKEN\n\n' + done],
  ['empty data', call() + 'data:\n\n' + done],
  ['blank string error', call() + finish('tool_calls') + sse({ error: '' }) + done],
  ['whitespace error', call() + sse({ error: '  ' }) + done],
  ['empty object error', call() + sse({ error: {} }) + done],
  ['false error', call() + sse({ error: false }) + done],
  ['length finish', call() + finish('length') + done],
  ['stop finish with tools', call() + finish('stop') + done],
  ['missing tool finish', call() + done],
  ['filtered finish', call() + finish('content_filter') + done],
  ['error finish', call() + finish('error') + done],
  ['unknown finish', call() + finish('surprise') + done],
  ['changed finish', call() + finish('tool_calls') + finish('stop') + done],
  ['text after terminal', call() + finish('tool_calls') + sse({ choices: [{ delta: { content: 'late' } }] }) + done],
  ['tool after terminal', call() + finish('tool_calls') + call('ls', '{}', 1) + done],
  ['truncated object arguments', complete(call('ls', '{"path":"src/'))],
  ['malformed arguments', complete(call('ls', '{bad}'))],
  ['array arguments', complete(call('ls', '[]'))],
  ['null arguments', complete(call('ls', 'null'))],
  ['string arguments', complete(call('ls', '"src"'))],
  ['number arguments', complete(call('ls', '1'))],
  ['duplicate identity', complete(call() + call('ls', '{}', 1, 'call-0'))],
  ['missing identity', complete(delta([{ index: 0, function: { name: 'ls', arguments: '{}' } }]))],
  ['missing name', complete(delta([{ index: 0, id: 'call-0', function: { arguments: '{}' } }]))],
  ['changed identity', complete(call() + delta([{ index: 0, id: 'changed' }]))],
  ['changed name', complete(call() + delta([{ index: 0, function: { name: 'ls' } }]))],
  ['negative index', complete(call('ls', '{}', -1))],
  ['fractional index', complete(call('ls', '{}', 0.5))],
  ['non-array calls', complete(delta({}))],
  ['null calls', complete(delta(null))],
  ['non-object call', complete(delta([null]))],
  ['non-object function', complete(delta([{ index: 0, id: 'call-0', function: [] }]))],
  ['non-string identity', complete(delta([{ index: 0, id: 42, function: { name: 'ls', arguments: '{}' } }]))],
  ['empty identity', complete(call('ls', '{}', 0, ''))],
  ['empty name', complete(call('', '{}'))],
  ['non-string name', complete(delta([{ index: 0, id: 'call-0', function: { name: 42, arguments: '{}' } }]))],
  ['string index', complete(delta([{ index: '0', id: 'call-0', function: { name: 'ls', arguments: '{}' } }]))],
  ['null index', complete(delta([{ index: null, id: 'call-0', function: { name: 'ls', arguments: '{}' } }]))],
  ['non-string arguments', complete(delta([{ index: 0, id: 'call-0', function: { name: 'ls', arguments: {} } }]))],
  ['non-function type', complete(delta([{ index: 0, id: 'call-0', type: 'custom', function: { name: 'ls', arguments: '{}' } }]))],
  ['no calls at tool terminal', finish('tool_calls') + done],
  ['invalid batch suffix', complete(call() + call('ls', '{"path":', 1))],
  ['non-object frame', sse('null') + done],
  ['invalid choices', sse({ choices: {} }) + done],
  ['invalid delta', sse({ choices: [{ delta: [] }] }) + done],
  ['invalid content', sse({ choices: [{ delta: { content: {} } }] }) + done],
  ['invalid reasoning', sse({ choices: [{ delta: { reasoning: true } }] }) + done],
  ['invalid usage', sse({ usage: [] }) + done],
];

describe('DeepMyst Gateway complete-stream integrity', () => {
  it.each(invalid)('rejects %s without releasing any native proposal', async (_name, wire) => {
    const events = await collect(wire);
    expect(events.some(event => event.toolCalls || event.done)).toBe(false);
    expect(events.at(-1)?.error).toEqual(expect.any(String));
    expect(events.at(-1)?.error?.length).toBeGreaterThan(0);
  });

  it('bounds a single SSE frame and the accumulated argument batch', async () => {
    for (const wire of [
      `data: ${'x'.repeat(MAX_HTTP_FRAME_CHARS + 1)}\n\n`,
      complete(call('ls', ' '.repeat(MAX_HTTP_FRAME_CHARS / 2)) + delta([{ index: 0, function: { arguments: ' '.repeat(MAX_HTTP_FRAME_CHARS / 2) } }])),
    ]) {
      const events = await collect(wire);
      expect(events.some(event => event.toolCalls || event.done)).toBe(false);
      expect(events.at(-1)?.error).toMatch(/size limit/);
    }
  });

  it('rejects invalid UTF-8 rather than replacing an argument character', async () => {
    const events = await collect(new Uint8Array([...Buffer.from(call()), 0xff, ...Buffer.from(complete(''))]));
    expect(events.some(event => event.toolCalls || event.done)).toBe(false);
    expect(events.at(-1)?.error).toBeTruthy();
  });

  it('accepts CR-only/multiline/no-space SSE, usage-only frames and final DONE without a newline', async () => {
    const wire = ': heartbeat\r\rdata:{"choices":[\rdata:{"delta":{"content":"مرحبا 🌍","reasoning":"checking"}}]}\r\r'
      + sse({ usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 }, cache_creation_input_tokens: 1 } })
      + finish('stop') + 'data:[DONE]';
    const events = await collect(wire);
    expect(events).toEqual([
      { text: 'مرحبا 🌍' }, { reasoning: 'checking' },
      { usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 1 } },
      { finishReason: 'stop' }, { done: true },
    ]);
  });

  it('accepts legitimate nullary calls and repeated terminal usage, in index order', async () => {
    const events = await collect(call('ls', '', 1) + call('bash', '{"command":"printf inert"}', 0)
      + finish('tool_calls') + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5 } }) + done);
    expect(events.filter(event => event.toolCalls)).toEqual([{ toolCalls: [
      { id: 'call-0', name: 'bash', arguments: '{"command":"printf inert"}' }, { id: 'call-1', name: 'ls', arguments: '' },
    ] }]);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it.each(['costUsd', 'model', 'text', 'reasoning', 'usage', 'finishReason'] as const)(
    'honors Stop after yielding %s from a co-located complete frame', async boundary => {
      const wire = sse({ model: MODEL, choices: [{ delta: { content: 'visible', reasoning: 'thinking',
        tool_calls: [{ index: 0, id: 'call-0', type: 'function', function: { name: 'ls', arguments: '{}' } }],
      }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8 } }) + done;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ start(feed) { feed.enqueue(Buffer.from(wire)); }, cancel });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'x-deepmyst-cost-usd': '0.01' } })));
      const gateway = new DeepMystGatewayClient(() => 'dm_inert_fixture', () => 'http://127.0.0.1');
      const caller = new AbortController();
      const stream = gateway.streamChat({ model: MODEL, messages: [], signal: caller.signal });
      for (;;) {
        const event = await stream.next();
        expect(event.done).toBe(false);
        if (event.value?.[boundary] !== undefined) { break; }
      }
      caller.abort(new Error('fixture Stop'));
      const tail = [];
      for await (const event of stream) { tail.push(event); }
      expect(tail).toEqual([{ error: 'fixture Stop' }]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it('releases no proposal while awaiting DONE after the tool finish frame', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const gateway = new DeepMystGatewayClient(() => 'dm_inert_fixture', () => 'http://127.0.0.1');
    const events: GatewayStreamEvent[] = [];
    const pending = (async () => { for await (const event of gateway.streamChat({ model: MODEL, messages: [] })) { events.push(event); } })();
    feed.enqueue(Buffer.from(call() + finish('tool_calls')));
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual([]);
    feed.enqueue(Buffer.from(sse({ error: '' }) + done));
    await pending;
    expect(events).toEqual([{ error: 'DeepMyst gateway stream error' }]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});

/** Real loopback bytes -> actual coordinator owners -> inert effect ports only. */
async function runChain(wires: string[], options: { fallback?: boolean; stopOnReasoning?: boolean } = {}) {
  const requests: { model: string; tools?: { function: { name: string } }[] }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      sendFragmented(res, wires[requests.length - 1] ?? answer);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Missing loopback address'); }
  const gateway = new DeepMystGatewayClient(() => 'dm_inert_loopback_fixture', () => `http://127.0.0.1:${address.port}`);
  const model = new CoordinatorModelClient(gateway, { isConfigured: () => false } as OpenRouterClient, () => true,
    () => ({ freeModels: [MODEL], gatewayFallbackModel: options.fallback ? 'claude-haiku-4-5' : '', openRouterModel: 'auto' }));
  const effects: MystiDirective[] = [];
  const gatewayEvents: GatewayStreamEvent[] = [];
  const originalStream = gateway.streamChat.bind(gateway);
  gateway.streamChat = async function* (params) { for await (const event of originalStream(params)) { gatewayEvents.push(event); yield event; } };
  let visible = '';
  let nextId = 0;
  let cancelled = false;
  let controller: AbortController | undefined;
  const unexpected = () => { throw new Error('Unexpected effect port'); };
  const dispatcher = new CoordinatorToolDispatcher(new CoordinatorRunBudget({ ...resolveCoordinatorRunLimits('medium', () => undefined), maxTurns: 2 }), {
    isCancelled: () => cancelled, nextToolId: prefix => `${prefix}-${nextId++}`,
    output: { postToolUse: () => {}, postToolResult: () => {}, recordTool: () => {} },
    fenceResult: (kind, result) => `inert ${kind}: ${result}`, batchReadOnlyPrefix: () => false,
    readLocal: async directive => { effects.push(directive); return { ok: true, output: 'Inert read marker; no filesystem read' }; },
    executeLocal: async directive => { effects.push(directive); return { ok: true, output: 'Inert effect marker; no command or write' }; },
    remember: unexpected, connect: unexpected, publish: unexpected, runSkill: unexpected, lookupSkill: unexpected,
    executeMcp: unexpected, noteMcpUsage: unexpected, executeVisual: unexpected, noteVisualResult: unexpected, canvasToolLabel: unexpected, executeCanvas: unexpected,
  });
  const tools = ['bash', 'ls'].map(name => ({ type: 'function', function: { name, description: 'Inert fixture', parameters: { type: 'object' } } }));
  const runner = new CoordinatorTurnRunner({ nonce: 'GW_REVIEW', scanKinds: [...ALL_MYSTI_KINDS, ...MYSTI_EXEC_KINDS], maxTurns: 2, tools }, {
    stream: (messages, opts) => model.stream(messages, opts), isCancelled: () => cancelled,
    registerAbort: value => { controller = value; }, getMaxTokens: () => 1024, beforeTurn: () => dispatcher.beginTurn(),
    output: { beginTurn: () => {}, estimateInterruptedTurn: () => {}, emitText: text => { visible += text; }, observe: event => {
      if (event.reasoning && options.stopOnReasoning) { cancelled = true; controller?.abort(new Error('fixture Stop')); }
    } },
  });
  const errors: string[] = [];
  const orchestrator = new CoordinatorRunOrchestrator({ turns: messages => runner.turns(messages), dispatchTool: (turn, messages) => dispatcher.dispatch(turn, messages),
    delegate: unexpected, isCancelled: () => cancelled, hasVisibleText: () => !!visible.trim(), finalize: messages => runner.finalize(messages), onError: turn => { errors.push(turn.message); } });
  const messages: GatewayChatMessage[] = [{ role: 'system', content: 'Inert fixture; no actual effects.' }, { role: 'user', content: 'Exercise the prepared fixture.' }];
  try {
    const outcome = await orchestrator.run(messages);
    expect(requests.length).toBeLessThanOrEqual(3);
    expect(requests[0].tools?.map(tool => tool.function.name)).toEqual(['bash', 'ls']);
    return { outcome, effects, errors, requests, gatewayEvents, visible };
  } finally {
    for (const socket of sockets) { socket.destroy(); }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function sendFragmented(res: ServerResponse, wire: string): void {
  const bytes = Buffer.from(wire, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-deepmyst-cost-usd': '0.001' });
  let offset = 0;
  const pump = () => {
    if (res.destroyed) { return; }
    if (offset >= bytes.length) { res.end(); return; }
    const width = [1, 2, 5, 11, 23][offset % 5];
    res.write(bytes.subarray(offset, offset + width)); offset += width;
    setImmediate(pump);
  };
  pump();
}

describe('Gateway loopback through real coordinator dispatch', () => {
  // These six routes all reached an effect port before this fix. Preserve the
  // original raw wires in GATEWAY_STREAM_REVIEW_20260920/loopback-witnesses.json.
  it.each([
    ['tool-only EOF', call()],
    ['malformed SSE', call() + 'data: {BROKEN\n\n' + done],
    ['blank late error', call() + finish('tool_calls') + sse({ error: '' }) + done],
    ['length with complete arguments', call() + finish('length') + done],
    ['truncated ls at EOF', call('ls', '{"path":"src/')],
    ['truncated ls with terminal', complete(call('ls', '{"path":"src/'))],
    ['valid prefix followed by truncated batch member', complete(call() + call('ls', '{"path":', 1))],
    ['nonblank late error', call() + finish('tool_calls') + sse({ error: { message: 'fixture rejection', code: 400 } }) + done],
  ])('withholds all effects for %s', async (_name, wire) => {
    const result = await runChain([wire]);
    expect(result.effects).toEqual([]);
    expect(result.outcome.errored).toBe(true);
    expect(result.gatewayEvents.some(event => event.toolCalls || event.done)).toBe(false);
    expect(result.requests).toHaveLength(1);
  });

  it('preserves valid fragmented calls and Unicode arguments through dispatch', async () => {
    const first = delta([{ index: 0, id: 'call-0', type: 'function', function: { name: 'bash', arguments: '{"command":"printf ' } }]);
    const second = delta([{ index: 0, function: { arguments: 'مرحبا 🌍"}' } }]);
    const result = await runChain([complete(first + second)]);
    expect(result.effects).toEqual([{ kind: 'bash', command: 'printf مرحبا 🌍' }]);
    expect(result.outcome.errored).toBe(false);
    expect(result.requests).toHaveLength(2);
  });

  it('retains pre-text retry/fallback without leaking the abandoned tool batch', async () => {
    const result = await runChain([call() + sse({ error: { message: 'Rate limited', code: 429 } }) + done, complete(call('ls', '{"path":"src"}'))], { fallback: true });
    expect(result.effects).toEqual([{ kind: 'ls', path: 'src' }]);
    expect(result.requests.map(request => request.model)).toEqual([MODEL, 'claude-haiku-4-5', 'claude-haiku-4-5']);
    expect(result.outcome.errored).toBe(false);
  });

  it('never switches models after visible text followed by a retryable error', async () => {
    const result = await runChain([sse({ choices: [{ delta: { content: 'Already visible' } }] }) + call() + sse({ error: { code: 429 } }) + done], { fallback: true });
    expect(result.visible).toBe('Already visible');
    expect(result.effects).toEqual([]);
    expect(result.requests).toHaveLength(1);
    expect(result.outcome.errored).toBe(true);
  });

  it('retains authenticated text directives which intentionally stop streaming early', async () => {
    const result = await runChain([sse({ choices: [{ delta: { content: '<read:GW_REVIEW>src/inert.ts</read>' } }] })]);
    expect(result.effects).toEqual([{ kind: 'read', path: 'src/inert.ts' }]);
    expect(result.outcome.errored).toBe(false);
  });

  it('refuses an unauthenticated directive and requires complete framing', async () => {
    const result = await runChain([sse({ choices: [{ delta: { content: '<read:WRONG_NONCE>src/inert.ts</read>' } }] })]);
    expect(result.effects).toEqual([]);
    expect(result.outcome.errored).toBe(true);
  });

  it('preserves text length continuation for a properly completed stream', async () => {
    const result = await runChain([sse({ choices: [{ delta: { content: 'Partial ' } }] }) + finish('length') + done]);
    expect(result.visible).toBe('Partial Inert fixture complete.');
    expect(result.effects).toEqual([]);
    expect(result.outcome.errored).toBe(false);
  });

  it('Stop during a partial tool batch never reaches an effect port', async () => {
    const result = await runChain([call() + sse({ choices: [{ delta: { reasoning: 'pause for Stop' } }] }) + finish('tool_calls') + done], { stopOnReasoning: true });
    expect(result.effects).toEqual([]);
    expect(result.gatewayEvents.some(event => event.toolCalls || event.done)).toBe(false);
    expect(result.requests).toHaveLength(1);
  });
});
