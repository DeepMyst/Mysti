import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';
import { OpenRouterClient } from '../../src/services/OpenRouterClient';

beforeEach(() => {
  vi.useFakeTimers();
  // VS Code 1.85 embeds Node 18.15, before AbortSignal.any was introduced.
  class LegacyAbortSignal extends AbortSignal {}
  Object.defineProperty(LegacyAbortSignal, 'any', { value: undefined });
  vi.stubGlobal('AbortSignal', LegacyAbortSignal);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([
  ['DeepMyst', () => new DeepMystGatewayClient(() => 'dm_test', () => 'https://gateway.v2.deepmyst.com')],
  ['OpenRouter', () => new OpenRouterClient(() => 'sk_test')],
] as const)('%s cancellation on the minimum host', (_name, makeClient) => {
  const params = { model: 'test', messages: [], timeoutMs: 1000 };

  it('does not dispatch work that was already cancelled', async () => {
    const caller = new AbortController();
    caller.abort(new Error('already stopped'));
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const client = makeClient();
    expect(await client.chatCompletion({ ...params, signal: caller.signal })).toMatchObject({ failed: true, error: 'already stopped' });
    const stream = client.streamChat({ ...params, signal: caller.signal });
    expect((await stream.next()).value).toMatchObject({ error: 'already stopped' });
    await stream.return(undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an in-flight completion before its timeout', async () => {
    const caller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    const pending = makeClient().chatCompletion({ ...params, signal: caller.signal });
    caller.abort(new Error('user stopped'));
    expect(await pending).toMatchObject({ failed: true, error: 'user stopped' });
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stream while waiting for response headers', async () => {
    const caller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    const stream = makeClient().streamChat({ ...params, signal: caller.signal });
    const pending = stream.next();
    caller.abort(new Error('user stopped'));
    expect((await pending).value).toMatchObject({ error: 'user stopped' });
    await stream.return(undefined);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps caller cancellation connected while consuming the response body', async () => {
    const caller = new AbortController();
    let body: ReadableStream<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
      });
      return new Response(body);
    }));
    const stream = makeClient().streamChat({ ...params, signal: caller.signal });
    expect((await stream.next()).value).toEqual({ text: 'first' });
    const pending = stream.next();
    caller.abort(new Error('user stopped'));
    expect((await pending).value).toMatchObject({ error: 'user stopped' });
    await stream.return(undefined);
    expect(body!.locked).toBe(false);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the response and deadline when the consumer stops early', async () => {
    const caller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const stream = makeClient().streamChat({ ...params, signal: caller.signal });
    expect((await stream.next()).value).toEqual({ text: 'first' });
    await stream.return(undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up successful completions and exhausted HTTP failures', async () => {
    const caller = new AbortController();
    for (const status of [200, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status })));
      const pending = makeClient().chatCompletion({ ...params, signal: caller.signal });
      await vi.runAllTimersAsync();
      const result = await pending;
      if (status === 200) { expect(result.text).toBe('ok'); }
      else { expect(result.failed).toBe(true); }
      expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

it('closes a DeepMyst body when the consumer returns after cost metadata', async () => {
  const caller = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'x-deepmyst-cost-usd': '0.01' } })));
  const client = new DeepMystGatewayClient(() => 'dm_test', () => 'https://gateway.v2.deepmyst.com');
  const stream = client.streamChat({ model: 'test', messages: [], signal: caller.signal });
  expect((await stream.next()).value).toEqual({ costUsd: 0.01 });
  await stream.return(undefined);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function completion(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
}

describe('OpenRouter waiting cancellation', () => {
  const params = { model: 'test', messages: [], timeoutMs: 60_000 };

  it('removes a cancelled waiter immediately without releasing an active request or starving the next waiter', async () => {
    const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    const fetchImpl = vi.fn(() => responses[fetchImpl.mock.calls.length - 1].promise);
    const client = new OpenRouterClient(() => 'sk_test', { maxConcurrent: 1, fetchImpl });
    const first = client.chatCompletion(params);
    const caller = new AbortController();
    const cancelled = client.chatCompletion({ ...params, signal: caller.signal });
    const second = client.chatCompletion(params);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(1);

    caller.abort(new Error('stopped while queued'));
    expect(await cancelled).toMatchObject({ failed: true, error: 'stopped while queued' });
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    responses[0].resolve(completion('first'));
    expect((await first).text).toBe('first');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const third = client.chatCompletion(params);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    responses[1].resolve(completion('second'));
    expect((await second).text).toBe('second');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    responses[2].resolve(completion('third'));
    expect((await third).text).toBe('third');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a slot when cancellation happens during handoff before dispatch', async () => {
    const firstResponse = deferred<Response>();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async () => completion('next'));
    const client = new OpenRouterClient(() => 'sk_test', { maxConcurrent: 1, fetchImpl });
    const first = client.chatCompletion(params);
    const caller = new AbortController();
    const cancelled = client.chatCompletion({ ...params, signal: caller.signal });
    const next = client.chatCompletion(params);
    const originalRemove = caller.signal.removeEventListener.bind(caller.signal);
    const remove = vi.spyOn(caller.signal, 'removeEventListener').mockImplementation((...args) => {
      originalRemove(...args);
      caller.abort(new Error('stopped during handoff'));
    });
    try {
      firstResponse.resolve(completion('first'));
      expect((await first).text).toBe('first');
      expect(await cancelled).toMatchObject({ failed: true, error: 'stopped during handoff' });
      expect((await next).text).toBe('next');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { remove.mockRestore(); }
  });

  it('cancels a 30-second Retry-After immediately and releases its body and timers', async () => {
    const caller = new AbortController();
    const cancelBody = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelBody }), {
      status: 429, headers: { 'retry-after': '30' },
    }));
    const client = new OpenRouterClient(() => 'sk_test', { fetchImpl });
    const pending = client.chatCompletion({ ...params, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(2);
    caller.abort(new Error('stopped during backoff'));
    expect(await pending).toMatchObject({ failed: true, error: 'stopped during backoff' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cleans the backoff timer when the attempt deadline expires', async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    const client = new OpenRouterClient(() => 'sk_test', { fetchImpl });
    const pending = client.chatCompletion({ ...params, timeoutMs: 100, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ failed: true, error: 'The operation was aborted due to timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves injected sleep and observes its late rejection after cancellation', async () => {
    const caller = new AbortController();
    const sleep = deferred<void>();
    const sleepImpl = vi.fn(() => sleep.promise);
    const fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    const client = new OpenRouterClient(() => 'sk_test', { fetchImpl, sleepImpl });
    const pending = client.chatCompletion({ ...params, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(sleepImpl).toHaveBeenCalledWith(30_000, expect.objectContaining({ aborted: false }));
    caller.abort(new Error('stopped during injected sleep'));
    expect(await pending).toMatchObject({ failed: true, error: 'stopped during injected sleep' });
    sleep.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries successfully at Retry-After and clears the previous attempt resources', async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      .mockImplementationOnce(async () => completion('retried'));
    const client = new OpenRouterClient(() => 'sk_test', { fetchImpl });
    const pending = client.chatCompletion({ ...params, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).text).toBe('retried');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels unread bodies for exhausted rate limits and failed catalog responses', async () => {
    for (const catalog of [false, true]) {
      const cancel = vi.fn();
      const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: catalog ? 500 : 429 }));
      const client = new OpenRouterClient(() => 'sk_test', { maxRetries: 0, fetchImpl });
      if (catalog) { expect(await client.listAllModels()).toEqual([]); }
      else { expect(await client.chatCompletion(params)).toMatchObject({ failed: true }); }
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

it('keeps the DeepMyst idle deadline while reading a stalled HTTP error body', async () => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    requestSignal = init.signal;
    return new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    }), { status: 500 });
  }));
  const client = new DeepMystGatewayClient(() => 'dm_test', () => 'https://gateway.v2.deepmyst.com');
  const stream = client.streamChat({ model: 'test', messages: [], timeoutMs: 100, signal: caller.signal });
  const pending = stream.next();
  await vi.advanceTimersByTimeAsync(100);
  expect(requestSignal?.aborted).toBe(true);
  expect((await pending).value).toMatchObject({ error: 'HTTP 500' });
  await stream.return(undefined);
  expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});


it('resets the Gateway idle deadline on raw fragments before an SSE event is complete', async () => {
  const caller = new AbortController();
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      feed = controller;
      init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
    }, cancel,
  }))));
  const client = new DeepMystGatewayClient(() => 'dm_test', () => 'http://127.0.0.1');
  const stream = client.streamChat({ model: 'test', messages: [], timeoutMs: 100, signal: caller.signal });
  const pending = stream.next();
  await vi.advanceTimersByTimeAsync(0);
  for (const fragment of ['data: {"choices":', '[{"delta":', '{"content":"alive"}}]}']) {
    await vi.advanceTimersByTimeAsync(80);
    feed.enqueue(Buffer.from(fragment));
    await vi.advanceTimersByTimeAsync(0);
  }
  // More than twice the idle timeout elapsed, with no complete SSE event yet.
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(80);
  feed.enqueue(Buffer.from('\n\n'));
  expect((await pending).value).toEqual({ text: 'alive' });
  await stream.return(undefined);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
