import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStorage } from 'vscode';
import { OpenCodeRemote, remoteConnection } from '../../../src/providers/opencode/OpenCodeRemote';

const connection = remoteConnection('http://localhost:4096', '/owned');
const remote = new OpenCodeRemote({ get: async () => undefined } as unknown as SecretStorage);
let healthDelay = 0;
let catalogDelay = 0;
let catalog: unknown;
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers();
  healthDelay = 0; catalogDelay = 0; calls = [];
  catalog = { providers: [{ id: 'owned', models: { fixture: { name: 'Fixture', limit: { context: 32768 } } } }] };
  // Keep AbortSignal's real cancellation semantics while advancing time deterministically.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
    calls.push(url.pathname);
    const health = url.pathname === '/global/health';
    if (!health && url.pathname !== '/config/providers') { throw new Error('Full catalog must not be downloaded'); }
    return new Promise<Response>((resolve, reject) => {
      const signal = options.signal!;
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve(new Response(JSON.stringify(health ? { healthy: true, version: 'fixture' } : catalog)));
      }, health ? healthDelay : catalogDelay);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); }
    });
  }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('OpenCode configured-provider discovery', () => {
  it('allows healthy sequential checks their own deadline and omits the full catalog', async () => {
    healthDelay = 4000; catalogDelay = 4000;
    const result = expect(remote.probe(connection)).resolves.toEqual({ version: 'fixture', connected: ['owned'],
      models: [{ id: 'owned/fixture', name: 'Fixture', contextWindow: 32768 }] });
    await Promise.all([result, vi.advanceTimersByTimeAsync(8000)]);
    expect(calls).toEqual(['/global/health', '/config/providers']);
  });
  it.each(['health', 'catalog'])('still bounds a stalled %s request', async phase => {
    if (phase === 'health') { healthDelay = 8000; } else { catalogDelay = 31000; }
    const result = phase === 'health'
      ? expect(remote.probe(connection)).rejects.toMatchObject({ name: 'TimeoutError' })
      : expect(remote.probe(connection)).rejects.toThrow('provider initialization timed out');
    await Promise.all([result, vi.advanceTimersByTimeAsync(phase === 'health' ? 7000 : 30000)]);
    expect(calls).toHaveLength(phase === 'health' ? 1 : 2);
  });
  it('allows a cold workspace to initialize after health succeeds', async () => {
    catalogDelay = 15000;
    const result = expect(remote.probe(connection)).resolves.toMatchObject({ connected: ['owned'] });
    await Promise.all([result, vi.advanceTimersByTimeAsync(15000)]);
  });
  it('reports no connected providers for an empty configured list', async () => {
    catalog = { providers: [] };
    const result = expect(remote.probe(connection)).resolves.toEqual({ version: 'fixture', connected: [], models: [] });
    await Promise.all([result, vi.advanceTimersByTimeAsync(1)]);
  });
  it('rejects an unexpected catalog instead of interpreting it as a usable server', async () => {
    catalog = { all: [], connected: ['unconfigured'] };
    const result = expect(remote.probe(connection)).rejects.toThrow('configured providers');
    await Promise.all([result, vi.advanceTimersByTimeAsync(1)]);
  });
});
