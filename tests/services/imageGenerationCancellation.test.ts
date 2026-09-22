import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, getEventListeners } from 'events';
import type { IncomingMessage, RequestOptions } from 'http';
import { ImageGenerationService } from '../../src/services/ImageGenerationService';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('https', () => ({ request: mocks.request }));

class FakeResponse extends EventEmitter {
  destroyed = false;
  constructor(public statusCode = 200) { super(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
  end(value: string) { this.emit('data', Buffer.from(value)); this.emit('end'); this.emit('close'); }
}
class FakeRequest extends EventEmitter {
  destroyed = false;
  timeoutMs = -1;
  write = vi.fn();
  end = vi.fn();
  constructor(readonly options: RequestOptions, private readonly receive: (res: IncomingMessage) => void) { super(); }
  setTimeout(ms: number, fn?: () => void) { this.timeoutMs = ms; if (fn) { this.on('timeout', fn); } return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
  response(status = 200) { const res = new FakeResponse(status); this.receive(res as unknown as IncomingMessage); return res; }
}
const requests: FakeRequest[] = [];
beforeEach(() => {
  mocks.request.mockReset();
  requests.length = 0;
  mocks.request.mockImplementation((options: RequestOptions, receive: (res: IncomingMessage) => void) => {
    const request = new FakeRequest(options, receive); requests.push(request); return request;
  });
});
afterEach(() => { clearMockConfig(); vi.restoreAllMocks(); });

const cases = [
  { provider: 'gpt-image-1.5', reference: false, response: { data: [{ b64_json: 'IMAGE' }] } },
  { provider: 'gpt-image-1.5', reference: true, response: { data: [{ b64_json: 'IMAGE' }] } },
  { provider: 'nano-banana', reference: false, response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'IMAGE' } }] } }] } },
] as const;

function service(provider = 'gpt-image-1.5') {
  setMockConfig('canvas.imageGenerationProvider', provider);
  const instance = new ImageGenerationService();
  instance.setKeys({ openai: 'inert-fixture-only', gemini: 'inert-fixture-only' });
  return instance;
}

describe('ImageGenerationService owned cancellation', () => {
  it('refuses pre-aborted generation before HTTPS submission', async () => {
    const stop = new AbortController(); stop.abort(new Error('Stopped'));
    await expect(service().generate('test', { signal: stop.signal })).rejects.toThrow('Stopped');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(cases)('aborts before headers and destroys a late response for $provider reference:$reference', async ({ provider, reference }) => {
    const stop = new AbortController();
    const pending = service(provider).generate('test', { signal: stop.signal, ...(reference ? { referenceImageBase64: 'AAAA' } : {}) });
    const rejected = expect(pending).rejects.toThrow('Stopped');
    expect(requests[0].options.signal).toBe(stop.signal);
    expect(requests[0].timeoutMs).toBe(180000);
    stop.abort(new Error('Stopped')); await rejected;
    expect(requests[0].destroyed).toBe(true);
    const late = requests[0].response();
    expect(late.destroyed).toBe(true);
    expect(() => late.emit('error', new Error('late socket error'))).not.toThrow();
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    expect(requests[0].timeoutMs).toBe(0);
  });

  it.each(cases)('cancels an in-flight body without affecting a sibling for $provider reference:$reference', async ({ provider, reference, response }) => {
    const instance = service(provider); const stop = new AbortController();
    const pending = instance.generate('old', { signal: stop.signal, ...(reference ? { referenceImageBase64: 'AAAA' } : {}) });
    const rejected = expect(pending).rejects.toThrow('Stopped');
    const old = requests[0].response(); old.emit('data', Buffer.from('{'));
    const sibling = instance.generate('sibling');
    stop.abort(new Error('Stopped')); await rejected;
    old.end(JSON.stringify(response));
    expect(old.destroyed).toBe(true);
    expect(requests[0].destroyed).toBe(true);
    expect(requests[1].destroyed).toBe(false);
    requests[1].response().end(JSON.stringify(response));
    await expect(sibling).resolves.toMatchObject({ imageBase64: 'IMAGE' });
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    expect(old.listenerCount('data')).toBe(0);
  });

  it.each(cases)('preserves natural completion and releases cancellation authority for $provider reference:$reference', async ({ provider, reference, response }) => {
    const stop = new AbortController();
    const pending = service(provider).generate('test', { signal: stop.signal, ...(reference ? { referenceImageBase64: 'AAAA' } : {}) });
    requests[0].response().end(JSON.stringify(response));
    await expect(pending).resolves.toMatchObject({ imageBase64: 'IMAGE' });
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    stop.abort(); expect(requests[0].destroyed).toBe(false);
    expect(requests[0].timeoutMs).toBe(0);
    expect(requests[0].listenerCount('timeout')).toBe(0);
  });

  it.each(['close', 'aborted', 'error'])('rejects a response %s instead of waiting forever', async event => {
    const stop = new AbortController(); const pending = service().generate('test', { signal: stop.signal });
    const rejected = expect(pending).rejects.toThrow(/closed|socket failure/);
    const response = requests[0].response(); response.emit(event, new Error('socket failure'));
    await rejected;
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it.each([false, true])('preserves the 180-second timeout and owned cleanup (reference:%s)', async reference => {
    const pending = service().generate('test', reference ? { referenceImageBase64: 'AAAA' } : undefined);
    const rejected = expect(pending).rejects.toThrow(reference ? 'Image edit request timed out (180s)' : 'Image generation request timed out (180s)');
    requests[0].emit('timeout'); await rejected;
    expect(requests[0].destroyed).toBe(true);
  });

  it('rejects an HTTP error and a synchronous request failure without retaining the caller signal', async () => {
    const stop = new AbortController();
    const pending = service().generate('test', { signal: stop.signal });
    requests[0].response(429).end(JSON.stringify({ error: { message: 'fixture rate limit' } }));
    await expect(pending).rejects.toThrow('fixture rate limit');
    mocks.request.mockImplementationOnce(() => { throw new Error('request construction failed'); });
    await expect(service().generate('test', { signal: stop.signal })).rejects.toThrow('request construction failed');
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });
});
