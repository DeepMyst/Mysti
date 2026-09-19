import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../../../src/services/OpenRouterClient';
import { CoordinatorModelClient } from '../../../src/services/CoordinatorModelClient';
import type { DeepMystGatewayClient } from '../../../src/services/DeepMystGatewayClient';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const collect = async <T>(source: AsyncIterable<T>) => { const out: T[] = []; for await (const event of source) { out.push(event); } return out; };
function setup() {
  const catalogue = deferred<Response>(); let catalogueSignal: AbortSignal | undefined;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/models')) { catalogueSignal = init?.signal ?? undefined; return catalogue.promise; }
    const request = JSON.parse(String(init?.body)) as { stream?: boolean };
    return request.stream
      ? new Response('data: {"choices":[{"delta":{"content":"sibling"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      : Response.json({ choices: [{ message: { content: 'sibling' } }] });
  });
  const router = new OpenRouterClient(() => 'inert-fixture', { fetchImpl });
  const client = new CoordinatorModelClient({} as DeepMystGatewayClient, router, () => false,
    () => ({ freeModels: [], gatewayFallbackModel: '', openRouterModel: 'auto' }));
  return { client, fetchImpl, catalogue, catalogueSignal: () => catalogueSignal };
}
const catalogueBody = { data: [{ id: 'inert/model:free', supported_parameters: ['tools'] }] };

describe('OpenRouter per-caller catalogue cancellation', () => {
  it.each(['stream', 'complete'] as const)('a pre-aborted %s does not begin discovery or submission', async method => {
    const h = setup(); const controller = new AbortController(); controller.abort(new Error('already stopped'));
    const result = method === 'stream' ? await collect(h.client.stream([], { signal: controller.signal })) : await h.client.complete([], { signal: controller.signal });
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(JSON.stringify(result)).toContain('already stopped');
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it.each(['stream', 'complete'] as const)('cancelled %s waiter exits before shared discovery settles; sibling continues', async method => {
    const h = setup(); const controller = new AbortController(); const sibling = new AbortController();
    const first = method === 'stream' ? collect(h.client.stream([], { signal: controller.signal })) : h.client.complete([], { signal: controller.signal });
    const other = collect(h.client.stream([], { signal: sibling.signal }));
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    controller.abort(new Error('waiter stopped'));
    const result = await first; // Catalogue remains unresolved: this must not wait for its 30-second deadline.
    expect(JSON.stringify(result)).toContain('waiter stopped'); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.catalogueSignal()?.aborted).toBe(false); expect(sibling.signal.aborted).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    h.catalogue.resolve(Response.json(catalogueBody));
    expect(await other).toContainEqual({ text: 'sibling' });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2); expect(getEventListeners(sibling.signal, 'abort')).toEqual([]);
  });

  it('observes rejected discovery after its only waiter is cancelled', async () => {
    const h = setup(); const controller = new AbortController();
    const discovery = deferred<string>();
    vi.spyOn(h.client, 'resolveCoordinatorModel').mockReturnValue(discovery.promise);
    const pending = collect(h.client.stream([], { signal: controller.signal })); controller.abort(new Error('stopped'));
    expect(await pending).toEqual([{ error: 'stopped' }]);
    discovery.reject(new Error('late catalogue rejection'));
    await Promise.resolve(); await Promise.resolve();
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('does not submit when cancellation arrives as discovery resolves', async () => {
    const h = setup(); const controller = new AbortController();
    vi.spyOn(h.client, 'resolveCoordinatorModel').mockImplementation(async () => {
      controller.abort(new Error('resolved after Stop')); return 'inert/model';
    });
    expect(await h.client.complete([], { signal: controller.signal })).toMatchObject({ failed: true, error: 'resolved after Stop' });
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
});
