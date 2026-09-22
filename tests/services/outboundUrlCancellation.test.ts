import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'events';
import { fetchGuarded, fetchGuardedBytes, OutboundUrlBlockedError } from '../../src/services/outboundUrlPolicy';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const publicResolve = async () => ['93.184.216.34'];
const url = 'https://cdn.example.com/image.png';

describe('guarded outbound request cancellation', () => {
  it('refuses a pre-aborted request before DNS or fetch', async () => {
    const resolve = vi.fn(publicResolve); const fetchImpl = vi.fn<typeof fetch>();
    const stop = new AbortController(); stop.abort(new Error('Stopped'));
    await expect(fetchGuardedBytes(url, { resolve, fetchImpl }, stop.signal)).rejects.toThrow('Stopped');
    expect(resolve).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it('releases a cancelled DNS waiter without submitting its fetch or cancelling a sibling', async () => {
    const gate = deferred<string[]>(); const resolve = vi.fn(() => gate.promise);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('sibling'));
    const stop = new AbortController();
    const first = fetchGuardedBytes(url, { resolve, fetchImpl }, stop.signal);
    const rejected = expect(first).rejects.toThrow('Stopped');
    const sibling = fetchGuardedBytes(url, { resolve, fetchImpl });
    stop.abort(new Error('Stopped')); await rejected;
    expect(fetchImpl).not.toHaveBeenCalled();
    gate.resolve(['93.184.216.34']);
    await expect(sibling).resolves.toMatchObject({ base64: Buffer.from('sibling').toString('base64') });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it('observes DNS failure arriving after cancellation', async () => {
    const gate = deferred<string[]>(); const fetchImpl = vi.fn<typeof fetch>();
    const stop = new AbortController();
    const pending = fetchGuardedBytes(url, { resolve: () => gate.promise, fetchImpl }, stop.signal);
    const rejected = expect(pending).rejects.toThrow('Stopped');
    stop.abort(new Error('Stopped')); await rejected;
    gate.reject(new Error('late DNS failure')); await Promise.resolve(); await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('discards a late fetch response body when the fetch ignores cancellation', async () => {
    const gate = deferred<Response>(); const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(gate.promise);
    const cancel = vi.fn();
    const stop = new AbortController();
    const pending = fetchGuardedBytes(url, { resolve: publicResolve, fetchImpl }, stop.signal);
    const rejected = expect(pending).rejects.toThrow('Stopped');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(stop.signal);
    stop.abort(new Error('Stopped')); await rejected;
    gate.resolve(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it('does not follow a redirect delivered concurrently with cancellation', async () => {
    const stop = new AbortController(); const resolve = vi.fn(publicResolve); const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      stop.abort(new Error('Stopped'));
      return new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: 'https://next.example.com/image.png' } });
    });
    await expect(fetchGuardedBytes(url, { resolve, fetchImpl }, stop.signal)).rejects.toThrow('Stopped');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(resolve).toHaveBeenCalledOnce(); expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('cancels a pending body reader promptly even if its cancel hook never settles', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    const stop = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = fetchGuardedBytes(url, { resolve: publicResolve, fetchImpl }, stop.signal);
    const rejected = expect(pending).rejects.toThrow('Stopped');
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    stop.abort(new Error('Stopped')); await rejected;
    expect(cancelled).toHaveBeenCalledOnce(); expect(response.body?.locked).toBe(false);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    await expect(fetchGuardedBytes(url, { resolve: publicResolve, fetchImpl: async () => new Response('ok') }))
      .resolves.toMatchObject({ base64: 'b2s=' });
  });

  it('preserves policy options, manual redirects, MIME and signal on every successful hop', async () => {
    const stop = new AbortController(); const redirectCancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: redirectCancel }), { status: 302, headers: { location: '/final' } }))
      .mockResolvedValueOnce(new Response('DATA', { headers: { 'content-type': 'image/png' } }));
    const resolve = vi.fn(publicResolve);
    const result = await fetchGuardedBytes('http://cdn.example.com/start', { allowHttp: true, maxRedirects: 1, maxBytes: 4, resolve, fetchImpl }, stop.signal);
    expect(result).toEqual({ base64: 'REFUQQ==', mimeType: 'image/png' });
    expect(resolve).toHaveBeenCalledTimes(2); expect(redirectCancel).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.map(call => call[1])).toEqual([
      { signal: stop.signal, redirect: 'manual' }, { signal: stop.signal, redirect: 'manual' },
    ]);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it('still denies a redirect into metadata and releases its original response body', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' },
    }));
    await expect(fetchGuardedBytes(url, { resolve: publicResolve, fetchImpl }, new AbortController().signal))
      .rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['declared', 'streamed'])('releases a %s oversized body and preserves the byte cap', async kind => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { if (kind === 'streamed') { controller.enqueue(Buffer.from('too much')); } }, cancel,
    }), { headers: kind === 'declared' ? { 'content-length': '8' } : {} });
    await expect(fetchGuardedBytes(url, { resolve: publicResolve, fetchImpl: async () => response, maxBytes: 4 }))
      .rejects.toThrow(/exceeds 4/);
    expect(cancel).toHaveBeenCalledOnce(); expect(response.body?.locked).toBe(false);
  });

  it('preserves direct fetch init options and cancels an HTTP error response body', async () => {
    const stop = new AbortController(); const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('ok'));
    const response = await fetchGuarded(url, { method: 'POST', headers: { 'x-test': 'inert' }, signal: stop.signal }, { resolve: publicResolve, fetchImpl });
    expect(fetchImpl.mock.calls[0][1]).toEqual({ method: 'POST', headers: { 'x-test': 'inert' }, signal: stop.signal, redirect: 'manual' });
    await response.body?.cancel();
    const cancel = vi.fn();
    await expect(fetchGuardedBytes(url, { resolve: publicResolve, fetchImpl: async () => new Response(new ReadableStream({ cancel }), { status: 404 }) }, stop.signal))
      .rejects.toThrow('HTTP 404');
    expect(cancel).toHaveBeenCalledOnce(); expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });
});
