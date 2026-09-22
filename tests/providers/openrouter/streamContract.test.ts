import { describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../../../src/services/OpenRouterClient';
import { CoordinatorModelClient } from '../../../src/services/CoordinatorModelClient';
import type { DeepMystGatewayClient } from '../../../src/services/DeepMystGatewayClient';
import { CoordinatorTurnRunner } from '../../../src/coordinator/CoordinatorTurnRunner';
import { MAX_HTTP_FRAME_CHARS } from '../../../src/utils/httpStream';

const params = { model: 'openrouter/free', messages: [] };
const textFrame = { choices: [{ delta: { content: 'hello' } }] };
const toolFrame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'mysti_read', arguments: '{"path":"fixture.txt"}' } }] } }] };
const terminal = (reason = 'stop') => ({ choices: [{ delta: {}, finish_reason: reason }] });
const encode = (frame: unknown) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`;
const sse = (...frames: unknown[]) => frames.map(encode).join('');
const collect = async <T>(stream: AsyncIterable<T>) => { const events: T[] = []; for await (const event of stream) { events.push(event); } return events; };
function client(body: string | ReadableStream<Uint8Array>) {
  return new OpenRouterClient(() => 'inert-fixture', { fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
}
function coordinator(router: OpenRouterClient) {
  return new CoordinatorModelClient({} as DeepMystGatewayClient, router, () => false,
    () => ({ freeModels: [], gatewayFallbackModel: '', openRouterModel: 'openai/gpt-oss-120b:free' }));
}

describe('OpenRouter stream completion contract', () => {
  it('decodes fragmented UTF-8, mixed SSE delimiters, multiline data and final DONE without newline', async () => {
    const payload = ': keepalive\r\ndata: {"choices":\rdata: [{"delta":{"content":"héllo 🌍"}}]}\r\r'
      + encode(terminal()) + 'data: [DONE]';
    const bytes = new TextEncoder().encode(payload);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) { controller.enqueue(new Uint8Array([byte])); } controller.close();
    } });
    expect(await collect(client(body).streamChat(params))).toEqual([{ text: 'héllo 🌍' }, { finishReason: 'stop' }, { done: true }]);
  });

  it('accepts accounting frame repeating terminal reason and emits model, cost, cache usage once', async () => {
    const usage = { prompt_tokens: 20, completion_tokens: 7, cost: 0.25, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 } };
    const events = await collect(coordinator(client(sse({ model: 'actual/model', ...textFrame }, terminal(), { ...terminal(), usage }, '[DONE]'))).stream([]));
    expect(events.filter(event => event.finishReason)).toEqual([{ finishReason: 'stop' }]);
    expect(events.filter(event => event.model)).toEqual([{ model: 'actual/model' }]);
    expect(events.filter(event => event.costUsd !== undefined)).toEqual([{ costUsd: 0.25 }]);
    expect(events.filter(event => event.usage)).toEqual([{ usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } }]);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it('displays reasoning text/summary without duplicating flat reasoning or exposing opaque data', async () => {
    const frames = [
      { choices: [{ delta: { reasoning: 'flat', reasoning_details: [{ type: 'reasoning.text', text: 'duplicate' }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'text' }, { type: 'reasoning.summary', summary: 'summary' }, { type: 'reasoning.encrypted', data: 'opaque' }] } }] },
      terminal(), '[DONE]',
    ];
    const events = await collect(client(sse(...frames)).streamChat(params));
    expect(events.filter(event => event.reasoning)).toEqual([{ reasoning: 'flat' }, { reasoning: 'textsummary' }]);
    // R11: opaque data is never displayed, but the completed sequence is carried
    // (once, verbatim, in order) so the coordinator can replay it next request.
    expect(JSON.stringify(events.filter(event => !event.reasoningDetails))).not.toContain('opaque');
    expect(events.filter(event => event.reasoningDetails)).toEqual([{ reasoningDetails: [
      { type: 'reasoning.text', text: 'duplicatetext' },
      { type: 'reasoning.summary', summary: 'summary' },
      { type: 'reasoning.encrypted', data: 'opaque' },
    ] }]);
  });

  // OpenRouter documents a final [DONE]. A finish reason alone can precede a
  // later provider error, so EOF must not turn an incomplete response into success.
  it.each([
    ['empty stream', ''],
    ['text EOF', sse(textFrame)],
    ['finish reason then EOF', sse(textFrame, terminal())],
    ['unfinished frame', 'data: {"choices":[{"delta":{"content":"partial"}}]}'],
    ['tool EOF', sse(toolFrame)],
    ['tool finish reason then EOF', sse(toolFrame, terminal('tool_calls'))],
    ['tool DONE without finish reason', sse(toolFrame, '[DONE]')],
    ['tool length', sse(toolFrame, terminal('length'), '[DONE]')],
    ['error after tool finish', sse(toolFrame, terminal('tool_calls'), { error: { message: 'late provider failure' } }, '[DONE]')],
    ['conflicting reason', sse(terminal('stop'), terminal('tool_calls'), '[DONE]')],
    ['content after terminal', sse(terminal(), textFrame, '[DONE]')],
    ['malformed JSON', 'data: {bad}\n\ndata: [DONE]\n\n'],
    ['non-object JSON', sse('null', '[DONE]')],
    ['invalid content shape', sse({ choices: [{ delta: { content: { bad: true } } }] }, '[DONE]')],
    ['invalid tool delta', sse({ choices: [{ delta: { tool_calls: [{ index: -1, function: {} }] } }] }, '[DONE]')],
    ['filtered', sse(textFrame, terminal('content_filter'), '[DONE]')],
    ['error terminal', sse(textFrame, terminal('error'), '[DONE]')],
    ['unknown terminal', sse(textFrame, terminal('unexpected'), '[DONE]')],
  ])('rejects %s without releasing tools or a success marker', async (_name, body) => {
    const events = await collect(client(body).streamChat(params));
    expect(events.at(-1)?.error).toBeTruthy(); expect(events.some(event => event.done || event.toolCalls)).toBe(false);
  });

  it('keeps explicit length available to the coordinator while distinguishing transport EOF', async () => {
    const events = await collect(client(sse(textFrame, terminal('length'), '[DONE]')).streamChat(params));
    expect(events).toEqual([{ text: 'hello' }, { finishReason: 'length' }, { done: true }]);
  });

  it('rejects oversized frames', async () => {
    const events = await collect(client('data: '+ 'x'.repeat(MAX_HTTP_FRAME_CHARS + 1)).streamChat(params));
    expect(events.at(-1)?.error).toContain('size limit'); expect(events.some(event => event.done)).toBe(false);
  });

  it.each(['{"path":', '[]', '"string"'])('rejects incomplete/non-object tool arguments %s', async args => {
    const frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'mysti_read', arguments: args } }] } }] };
    const events = await collect(client(sse(frame, terminal('tool_calls'), '[DONE]')).streamChat(params));
    expect(events.at(-1)?.error).toContain('tool arguments'); expect(events.some(event => event.toolCalls)).toBe(false);
  });

  it('preserves valid interleaved tool identities and arguments until the complete boundary', async () => {
    const frame = (tool_calls: unknown[]) => ({ choices: [{ delta: { tool_calls } }] });
    const events = await collect(client(sse(
      frame([{ index: 1, id: 'second', type: 'function' }, { index: 0, id: 'first', function: { name: 'mysti_read', arguments: '{"path":' } }]),
      frame([{ index: 1, function: { name: 'mysti_ls', arguments: '{"path":"directory"}' } }]),
      frame([{ index: 0, function: { arguments: '"file"}' } }]),
      terminal('tool_calls'), { ...terminal('tool_calls'), usage: { prompt_tokens: 2, completion_tokens: 4 } }, '[DONE]',
    )).streamChat(params));
    expect(events.filter(event => event.toolCalls)).toEqual([{ toolCalls: [
      { id: 'first', name: 'mysti_read', arguments: '{"path":"file"}' },
      { id: 'second', name: 'mysti_ls', arguments: '{"path":"directory"}' },
    ] }]);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it.each([false, true])('only a fully completed tool stream can reach coordinator dispatch (complete=%s)', async complete => {
    const router = coordinator(client(sse(toolFrame, terminal('tool_calls')) + (complete ? encode('[DONE]') : '')));
    const dispatch = vi.fn(); const failures: string[] = [];
    const runner = new CoordinatorTurnRunner({ nonce: 'FIXTURE1', scanKinds: [], maxTurns: 1 }, {
      stream: (messages, options) => router.stream(messages, options), isCancelled: () => false,
      registerAbort: () => {}, getMaxTokens: () => 2048,
      output: { beginTurn: () => {}, observe: () => {}, emitText: () => {}, estimateInterruptedTurn: () => {} },
    });
    for await (const turn of runner.turns([])) {
      if (turn.kind === 'turn') { dispatch(turn.toolCalls); } else { failures.push(turn.message); }
    }
    expect(dispatch).toHaveBeenCalledTimes(complete ? 1 : 0); expect(failures).toHaveLength(complete ? 0 : 1);
    if (complete) { expect(dispatch.mock.calls[0][0]).toEqual([{ id: 'call-1', name: 'mysti_read', arguments: '{"path":"fixture.txt"}' }]); }
  });

  it.each(['', '   ', { message: '' }, { message: '   ' }])('keeps blank error envelopes terminal through the coordinator (%j)', async error => {
    const events = await collect(coordinator(client(sse(textFrame, { error }, '[DONE]'))).stream([]));
    expect(events.at(-1)?.error).toBeTruthy(); expect(events.some(event => event.done || event.toolCalls)).toBe(false);
  });

  it('the coordinator treats an adapter error property as a failure even when empty', async () => {
    const router = client('');
    vi.spyOn(router, 'streamChat').mockImplementation(async function* () { yield { text: 'partial' }; yield { error: '' }; });
    const events = await collect(coordinator(router).stream([]));
    expect(events).toEqual([{ text: 'partial' }, { error: 'OpenRouter stream error' }]);
  });

  it.each([
    [{ index: 1, id: 'call-2', function: { arguments: '{}' } }],
    [{ index: 0, id: 'changed', function: { arguments: '' } }],
    [{ index: 0, function: { name: 'changed', arguments: '' } }],
    [{ index: 1, id: 'call-1', function: { name: 'mysti_read', arguments: '{}' } }],
  ])('rejects the whole tool batch when any identity is incomplete or changes (%j)', async (...calls) => {
    const extra = { choices: [{ delta: { tool_calls: calls } }] };
    const events = await collect(client(sse(toolFrame, extra, terminal('tool_calls'), '[DONE]')).streamChat(params));
    expect(events.at(-1)?.error).toBeTruthy(); expect(events.some(event => event.done || event.toolCalls)).toBe(false);
  });

  it('checks cancellation when a consumer resumes after metadata', async () => {
    const controller = new AbortController();
    const stream = client(sse({ model: 'actual/model', ...textFrame }, terminal(), '[DONE]')).streamChat({ ...params, signal: controller.signal });
    expect((await stream.next()).value).toEqual({ model: 'actual/model' }); controller.abort(new Error('stopped'));
    const events = await collect(stream); expect(events.some(event => event.text || event.done || event.toolCalls)).toBe(false);
    expect(events.at(-1)?.error).toBe('stopped');
  });
});

describe('OpenRouter nonstream envelopes and accounting', () => {
  it('rejects documented HTTP 200 error envelopes without reporting success', async () => {
    const c = new OpenRouterClient(() => 'inert-fixture', { fetchImpl: async () => Response.json({ id: 'fixture', error: { code: 502, message: 'provider disconnected' } }) });
    expect(await c.chatCompletion(params)).toMatchObject({ failed: true, error: 'provider disconnected' });
  });
  it.each([undefined, 0, 0.25])('preserves reported cost %s without inventing zero', async cost => {
    const c = new OpenRouterClient(() => 'inert-fixture', { fetchImpl: async () => Response.json({ model: 'actual/model', choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, cost } }) });
    const result = await c.chatCompletion(params); expect(result.failed).toBeUndefined(); expect(result.costUsd).toBe(cost); expect(result.model).toBe('actual/model');
  });
});
