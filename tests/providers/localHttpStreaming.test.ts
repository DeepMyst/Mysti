import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/providers/ollama/OllamaProvider';
import { LocalAIProvider } from '../../src/providers/localai/LocalAIProvider';
import type { Settings, StreamChunk } from '../../src/types';
import { MAX_HTTP_FRAME_CHARS } from '../../src/utils/httpStream';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

const context = () => ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;
class FixtureOllama extends OllamaProvider {
  prompt = (content: string) => Promise.resolve(content);
  protected buildPromptAsync(content: string) { return this.prompt(content); }
}
class FixtureLocalAI extends LocalAIProvider {
  prompt = (content: string) => Promise.resolve(content);
  protected buildPromptAsync(content: string) { return this.prompt(content); }
}
type Provider = FixtureOllama | FixtureLocalAI;
const variants = [
  { id: 'ollama', create: () => new FixtureOllama(context()), path: '/api/chat',
    text: (content: string) => JSON.stringify({ message: { content }, done: false }) + '\n',
    end: (n = 3) => JSON.stringify({ done: true, prompt_eval_count: n, eval_count: n + 1 }) + '\n',
  },
  { id: 'localai', create: () => new FixtureLocalAI(context()), path: '/v1/chat/completions',
    text: (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    end: (n = 3) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: n, completion_tokens: n + 1 } })}\n\ndata: [DONE]\n\n`,
  },
];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  return chunks;
}
const disposals: Array<() => void | Promise<void>> = [];
type RequestBody = { messages: Array<{ content: string }>; model?: string; stream_options?: { include_usage: boolean }; think?: string };
async function server(handler: (res: ServerResponse, body: RequestBody) => void | Promise<void>) {
  const requests: Array<{ url: string; body: RequestBody }> = [];
  const sockets = new Set<Socket>();
  const http = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ url: req.url!, body });
      res.setHeader('Content-Type', 'text/event-stream');
      await handler(res, body);
    } catch (error) { res.destroy(error as Error); }
  });
  http.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  disposals.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) { socket.destroy(); }
    http.close(() => resolve());
  }));
  return { endpoint: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests };
}
function setup(v: typeof variants[number], endpoint: string) {
  setMockConfig(`${v.id}Endpoint`, endpoint);
  setMockConfig(`${v.id}RequestTimeout`, 5000);
  const provider = v.create();
  disposals.push(() => provider.dispose());
  return provider;
}
function stream(provider: Provider, content = 'hello', panelId?: string) {
  return provider.sendMessage(content, [], { model: 'fixture-model' } as Settings, null, undefined, panelId);
}
async function fragmented(res: ServerResponse, text: string) {
  // Every byte is a distinct write, including inside UTF-8, CRLF and JSON tokens.
  for (const byte of Buffer.from(text)) {
    if (res.destroyed) { return; }
    res.write(Buffer.from([byte]));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  res.end();
}
beforeEach(() => {
  clearMockConfig();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  // Provider cleanup first, then fixture sockets, even after a failed assertion.
  for (const dispose of disposals.reverse()) { await dispose(); }
  disposals.length = 0;
  clearMockConfig();
  vi.restoreAllMocks();
});

describe.each(variants)('$id HTTP request ownership', v => {
  it('does not submit a prompt after Stop during asynchronous prompt preparation', async () => {
    const http = await server(res => { res.end(v.end()); });
    const provider = setup(v, http.endpoint);
    const entered = deferred();
    const prompt = deferred<string>();
    provider.prompt = () => { entered.resolve(); return prompt.promise; };
    const result = collect(stream(provider));
    await entered.promise;
    provider.cancelCurrentRequest();
    prompt.resolve('cancelled prompt');
    expect((await result).map(c => c.type)).toEqual(['error', 'done']);
    expect(http.requests).toEqual([]);
  });

  it('a replaced prompt cannot submit or cancel the replacement when it finally resolves', async () => {
    const entered = deferred();
    const oldPrompt = deferred<string>();
    const connected = deferred<ServerResponse>();
    const http = await server(res => { res.write(v.text('new')); connected.resolve(res); });
    const provider = setup(v, http.endpoint);
    provider.prompt = content => {
      if (content === 'old') { entered.resolve(); return oldPrompt.promise; }
      return Promise.resolve(content);
    };
    const old = collect(stream(provider, 'old', 'same'));
    await entered.promise;
    const current = collect(stream(provider, 'new', 'same'));
    const response = await connected.promise;
    oldPrompt.resolve('late old');
    expect((await old).map(c => c.type)).toEqual(['error', 'done']);
    response.end(v.end(9));
    expect(await current).toEqual([{ type: 'text', content: 'new' }, { type: 'done', usage: { input_tokens: 9, output_tokens: 10 } }]);
    expect(http.requests.map(r => r.body.messages[0].content)).toEqual(['new']);
  });

  it('an older timeout cannot abort a newer HTTP stream', async () => {
    const entered = deferred();
    const oldPrompt = deferred<string>();
    const connected = deferred<ServerResponse>();
    const oldDeadline = deferred();
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 75) { return realSetTimeout(() => { fn(); oldDeadline.resolve(); }, 75); }
      return realSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout);
    const http = await server(res => { res.write(v.text('new')); connected.resolve(res); });
    const provider = setup(v, http.endpoint);
    provider.prompt = content => {
      if (content === 'old') { entered.resolve(); return oldPrompt.promise; }
      return Promise.resolve(content);
    };
    setMockConfig(`${v.id}RequestTimeout`, 75);
    const old = collect(stream(provider, 'old', 'same'));
    await entered.promise;
    setMockConfig(`${v.id}RequestTimeout`, 5000);
    const current = collect(stream(provider, 'new', 'same'));
    const response = await connected.promise;
    await oldDeadline.promise;
    response.end(v.end());
    expect((await current).map(c => c.type)).toEqual(['text', 'done']);
    oldPrompt.resolve('late');
    await old;
  });

  it('old generator cleanup does not abort the next turn or contaminate its usage', async () => {
    const second = deferred<ServerResponse>();
    const http = await server((res, body) => {
      if (body.messages[0].content === 'old') { res.end(v.end(40)); }
      else { res.write(v.text('new')); second.resolve(res); }
    });
    const provider = setup(v, http.endpoint);
    const old = stream(provider, 'old', 'same');
    expect((await old.next()).value).toEqual({ type: 'done', usage: { input_tokens: 40, output_tokens: 41 } });
    const current = collect(stream(provider, 'new', 'same'));
    const res = await second.promise;
    await old.return(undefined);
    res.end(v.end(1));
    expect(await current).toEqual([{ type: 'text', content: 'new' }, { type: 'done', usage: { input_tokens: 1, output_tokens: 2 } }]);
  });

  it.each(['stop', 'clear', 'dispose', 'disposeSession'] as const)('%s aborts the actual default-panel HTTP response', async action => {
    const connected = deferred();
    const closed = deferred();
    const http = await server(res => {
      res.on('close', () => closed.resolve());
      res.write(v.text('before'));
      connected.resolve();
    });
    const provider = setup(v, http.endpoint);
    const result = collect(stream(provider));
    await connected.promise;
    if (action === 'stop') { provider.cancelCurrentRequest(); }
    else if (action === 'clear') { provider.clearSession(); }
    else if (action === 'disposeSession') { provider.disposeSession('default'); }
    else { provider.dispose(); }
    const chunks = await result;
    expect(chunks.at(-2)).toMatchObject({ type: 'error', content: 'Request cancelled or timed out' });
    expect(chunks.at(-1)).toEqual({ type: 'done' });
    await closed.promise;
  });

  it.each(['stop', 'clear'] as const)('%s on one panel leaves another panel usable', async action => {
    const responses = new Map<string, ServerResponse>();
    const connected = deferred();
    const http = await server((res, body) => {
      res.write(v.text(body.messages[0].content));
      responses.set(body.messages[0].content, res);
      if (responses.size === 2) { connected.resolve(); }
    });
    const provider = setup(v, http.endpoint);
    const first = collect(stream(provider, 'first', 'a'));
    const second = collect(stream(provider, 'second', 'b'));
    await connected.promise;
    if (action === 'clear') { provider.clearSession('a'); } else { provider.cancelCurrentRequest('a'); }
    responses.get('second')!.end(v.end(6));
    expect((await first).some(c => c.type === 'error')).toBe(true);
    expect(await second).toEqual([{ type: 'text', content: 'second' }, { type: 'done', usage: { input_tokens: 6, output_tokens: 7 } }]);
  });

  it('stops a held-open body as soon as its completion marker arrives', async () => {
    const closed = deferred();
    const http = await server(res => {
      res.on('close', () => closed.resolve());
      res.write(v.text('done') + v.end());
      // Deliberately no res.end(): the wire protocol, not TCP EOF, ends the turn.
    });
    const result = await collect(stream(setup(v, http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['text', 'done']);
    await closed.promise;
  });

  it('abandoning a generator closes its HTTP body', async () => {
    const closed = deferred();
    const http = await server(res => { res.on('close', () => closed.resolve()); res.write(v.text('one')); });
    const generator = stream(setup(v, http.endpoint));
    expect((await generator.next()).value).toEqual({ type: 'text', content: 'one' });
    await generator.return(undefined);
    await closed.promise;
  });

  it('reports a clean EOF without any completion marker as truncated', async () => {
    const http = await server(res => { res.end(v.text('partial')); });
    const result = await collect(stream(setup(v, http.endpoint)));
    expect(result[0]).toEqual({ type: 'text', content: 'partial' });
    expect(result[1]).toMatchObject({ type: 'error', content: expect.stringContaining('stream ended before completion') });
    expect(result[2]).toEqual({ type: 'done' });
  });

  it('surfaces an in-band error and emits no fabricated tool result', async () => {
    const error = JSON.stringify({ error: { message: 'fixture model failed' } });
    const http = await server(res => { res.end(v.id === 'ollama' ? error : `data:${error}`); });
    const result = await collect(stream(setup(v, http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['error', 'done']);
    expect(result[0].content).toContain('fixture model failed');
  });
});

describe.each(variants)('$id malformed HTTP framing', v => {
  it('reports invalid JSON distinctly from an early EOF', async () => {
    const http = await server(res => { res.end(v.id === 'ollama' ? '{invalid}\n' : 'data:{invalid}\n\n'); });
    const result = await collect(stream(setup(v, http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['error', 'done']);
    expect(result[0].content).toContain('returned malformed');
  });

  it('bounds an unterminated oversized line and closes the HTTP response', async () => {
    const closed = deferred();
    const http = await server(res => {
      res.on('close', () => closed.resolve());
      res.write('x'.repeat(MAX_HTTP_FRAME_CHARS + 1));
    });
    const result = await collect(stream(setup(v, http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['error', 'done']);
    expect(result[0].content).toContain('frame size limit');
    await closed.promise;
  });
});

describe('Ollama fragmented NDJSON', () => {
  it.each([['gpt-oss:20b', 'high'], ['library/gpt-oss:120b', 'high'], ['qwen3', 'max']])('maps max effort for %s to supported %s', async (model, effort) => {
    const http = await server(res => { res.end(variants[0].end()); });
    const provider = setup(variants[0], http.endpoint);
    await collect(provider.sendMessage('test', [], { model, effortLevel: 'max' } as Settings, null));
    expect(http.requests[0].body.think).toBe(effort);
  });

  it('retains final unterminated UTF-8 content, thinking, multiple proposals and usage in one frame', async () => {
    const frame = { message: { content: 'café 🌙', thinking: 'consider', tool_calls: [
      { function: { name: 'read', arguments: { path: 'a' } } },
      { function: { name: 'read', arguments: { path: 'b' } } },
    ] }, done: true, prompt_eval_count: 12, eval_count: 4 };
    const http = await server(res => fragmented(res, JSON.stringify(frame)));
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const result = await collect(stream(setup(variants[0], http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['tool_use', 'tool_use', 'thinking', 'text', 'done']);
    expect(new Set(result.filter(c => c.toolCall).map(c => c.toolCall!.id)).size).toBe(2);
    expect(result[0].toolCall?.input).toEqual({ path: 'a' });
    expect(result[1].toolCall?.input).toEqual({ path: 'b' });
    expect(result[3].content).toBe('café 🌙');
    expect(result[4].usage).toEqual({ input_tokens: 12, output_tokens: 4 });
    expect(http.requests[0].url).toBe('/api/chat');
    expect(http.requests[0].body.model).toBe('fixture-model');
  });

  it('does not emit remaining buffered content after Stop between tool proposals', async () => {
    const http = await server(res => { res.end(JSON.stringify({ message: { content: 'late', tool_calls: [
      { function: { name: 'first', arguments: {} } }, { function: { name: 'second', arguments: {} } },
    ] }, done: true })); });
    const provider = setup(variants[0], http.endpoint);
    const generator = stream(provider);
    expect((await generator.next()).value?.toolCall?.name).toBe('first');
    provider.cancelCurrentRequest();
    expect((await collect(generator)).map(c => c.type)).toEqual(['error', 'done']);
  });
});

describe('LocalAI fragmented SSE', () => {
  it('bounds an SSE event made of many individually valid data lines', async () => {
    const http = await server(res => { res.end(('data:' + 'x'.repeat(1024) + '\n').repeat(MAX_HTTP_FRAME_CHARS / 1024 + 1)); });
    const result = await collect(stream(setup(variants[1], http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['error', 'done']);
    expect(result[0].content).toContain('SSE event exceeds the frame size limit');
  });

  it('assembles interleaved arguments, accepts data: without space and records trailing usage-only frames', async () => {
    const events = [
      { choices: [{ delta: { content: 'café 🌙', reasoning: 'consider', tool_calls: [
        { index: 1, id: 'second', function: { name: 'read', arguments: '{"path":' } },
        { index: 0, id: 'first', function: { name: 'search', arguments: '{"query":"h' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: 'ello"}' } }, { index: 1, function: { arguments: '"a"}' } },
      ] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 7 } },
    ];
    const payload = ': keepalive\r\n\r\n' + events.map(e => `data:${JSON.stringify(e)}\r\n\r\n`).join('') + 'data:[DONE]';
    const http = await server(res => fragmented(res, payload));
    const result = await collect(stream(setup(variants[1], http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['text', 'thinking', 'tool_use', 'tool_use', 'done']);
    expect(result[0].content).toBe('café 🌙');
    expect(result[2].toolCall).toMatchObject({ id: 'first', name: 'search', input: { query: 'hello' } });
    expect(result[3].toolCall).toMatchObject({ id: 'second', name: 'read', input: { path: 'a' } });
    expect(result[4].usage).toEqual({ input_tokens: 30, output_tokens: 7 });
    expect(http.requests[0]).toMatchObject({ url: '/v1/chat/completions', body: { model: 'fixture-model', stream_options: { include_usage: true } } });
  });

  it('accepts a final unterminated finish_reason frame without DONE and marks estimated usage', async () => {
    const http = await server(res => fragmented(res, 'event: message\rdata:{"choices": [\rdata:{"delta":{"content":"final"},"finish_reason":"stop"}]}'));
    expect(await collect(stream(setup(variants[1], http.endpoint)))).toEqual([
      { type: 'text', content: 'final' },
      { type: 'done', usage: { input_tokens: 0, output_tokens: 1, estimated: true } },
    ]);
  });

  it('ignores buffered frames following DONE', async () => {
    const http = await server(res => { res.end('data:[DONE]\n\n' + variants[1].text('after completion')); });
    expect((await collect(stream(setup(variants[1], http.endpoint)))).map(c => c.type)).toEqual(['done']);
  });

  it.each(['{"path":', 'not-json', '[]'])('reports unusable tool arguments %s without fabricating a proposal or result', async args => {
    const data = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'write', arguments: args } }] }, finish_reason: 'tool_calls' }] };
    const http = await server(res => { res.end(`data:${JSON.stringify(data)}\n\ndata:[DONE]\n\n`); });
    const result = await collect(stream(setup(variants[1], http.endpoint)));
    expect(result.map(c => c.type)).toEqual(['error', 'done']);
    expect(result[0].content).toContain('arguments for tool write');
  });

  it('assigns distinct fallback IDs across calls and turns when native IDs are absent', async () => {
    const data = { choices: [{ delta: { tool_calls: [
      { index: 0, function: { name: 'read', arguments: '{}' } },
      { index: 1, function: { name: 'search', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] };
    const http = await server(res => { res.end(`data:${JSON.stringify(data)}\n\ndata:[DONE]\n\n`); });
    const provider = setup(variants[1], http.endpoint);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      for (const chunk of await collect(stream(provider))) { if (chunk.toolCall) { ids.push(chunk.toolCall.id); } }
    }
    expect(new Set(ids).size).toBe(4);
  });
});
