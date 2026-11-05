import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepMystGatewayClient, type GatewayChatMessage, type GatewayChatParams } from '../../src/services/DeepMystGatewayClient';
import { OpenRouterClient } from '../../src/services/OpenRouterClient';
import { CoordinatorModelClient } from '../../src/services/CoordinatorModelClient';

const MODEL = 'openai/gpt-oss-120b:free';
const HOST = 'https://gateway.v2.deepmyst.com';
const AUTO = 'UNSAVED_EDITOR_CONTEXT';
const canonical: GatewayChatMessage[] = [
  Object.freeze({ role: 'system' as const, content: 'Follow the user request.' }),
  Object.freeze({ role: 'user' as const, content: 'Inspect the manual attachment.' }),
];
Object.freeze(canonical);
const canonicalBytes = JSON.stringify(canonical);
const withAuto = (): GatewayChatMessage[] => [...canonical, { role: 'user', content: AUTO }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function response(stream = false): Response {
  return stream
    ? new Response('data: {"choices":[{"delta":{"content":"healthy"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
    : Response.json({ choices: [{ message: { content: 'healthy' } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
}

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of source) { events.push(event); }
  return events;
}

function body(init?: RequestInit): { model: string; messages: GatewayChatMessage[]; stream: boolean } {
  return JSON.parse(String(init?.body));
}

function gateway() { return new DeepMystGatewayClient(() => 'dm_fixture', () => HOST); }

function coordinator(openRouter: OpenRouterClient) {
  return new CoordinatorModelClient(gateway(), openRouter, () => true, () => ({
    freeModels: [`openrouter/${MODEL}`, 'openrouter/google/gemma-4-31b-it:free'],
    gatewayFallbackModel: '', openRouterModel: 'auto',
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(JSON.stringify(canonical)).toBe(canonicalBytes);
});

describe('late transport context at the serialized request boundary', () => {
  for (const transport of ['gateway', 'openrouter'] as const) {
    for (const stream of [false, true]) {
      const label = `${transport} ${stream ? 'stream' : 'completion'}`;
      function setup() {
        const requests: ReturnType<typeof body>[] = [];
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
          requests.push(body(init));
          return response(stream);
        });
        vi.stubGlobal('fetch', fetchImpl);
        const client = transport === 'gateway' ? gateway() : new OpenRouterClient(() => 'sk_fixture', { fetchImpl });
        const run = (params: GatewayChatParams) => stream ? drain(client.streamChat(params)) : client.chatCompletion(params);
        return { requests, fetchImpl, run };
      }

      it(`${label} serializes resolved bytes once and preserves calls without a factory`, async () => {
        const { requests, run } = setup();
        const resolveMessages = vi.fn(withAuto);
        const params = { model: MODEL, messages: canonical, resolveMessages };
        const result = await run(params);
        expect(JSON.stringify(result)).toContain('healthy');
        expect(requests[0].messages).toEqual(withAuto());
        expect(resolveMessages).toHaveBeenCalledTimes(1);
        const healthy = await run({ model: MODEL, messages: canonical });
        expect(JSON.stringify(healthy)).toContain('healthy');
        expect(requests[1].messages).toEqual(canonical);
        expect(requests).toHaveLength(2);
      });

      it(`${label} rejects a cancelled owner before resolving or fetching`, async () => {
        const { requests, run } = setup();
        const resolveMessages = vi.fn(withAuto);
        const params = { model: MODEL, messages: canonical, resolveMessages, isCancelled: () => true };
        const result = await run(params);
        expect(JSON.stringify(result)).toContain('Request cancelled before dispatch');
        expect(resolveMessages).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
        expect(JSON.stringify(await run({ model: MODEL, messages: canonical }))).toContain('healthy');
        expect(requests).toHaveLength(1);
      });

      it(`${label} rechecks cancellation after resolution and contains resolver failures`, async () => {
        const { requests, run } = setup();
        let cancelled = false;
        const params = {
          model: MODEL, messages: canonical,
          resolveMessages: vi.fn(() => { cancelled = true; return withAuto(); }),
          isCancelled: () => cancelled,
        };
        expect(JSON.stringify(await run(params))).toContain('Request cancelled before dispatch');
        expect(params.resolveMessages).toHaveBeenCalledTimes(1);
        const throwing = { model: MODEL, messages: canonical, resolveMessages: () => { throw new Error('fixture resolver rejected'); } };
        expect(JSON.stringify(await run(throwing))).toContain('fixture resolver rejected');
        expect(requests).toEqual([]);
        expect(JSON.stringify(await run({ model: MODEL, messages: canonical }))).toContain('healthy');
        expect(requests).toHaveLength(1);
      });
    }
  }

  for (const cancel of [false, true]) {
    it(`OpenRouter rechecks ${cancel ? 'ownership' : 'Auto Context'} after waiting for its request slot`, async () => {
      const firstStarted = deferred<void>();
      const releaseFirst = deferred<Response>();
      const requests: ReturnType<typeof body>[] = [];
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        requests.push(body(init));
        if (requests.length === 1) { firstStarted.resolve(); return releaseFirst.promise; }
        return response();
      });
      const client = new OpenRouterClient(() => 'sk_fixture', { fetchImpl, maxConcurrent: 1 });
      const occupying = client.chatCompletion({ model: MODEL, messages: canonical });
      await firstStarted.promise;
      let enabled = true;
      let cancelled = false;
      const resolveMessages = vi.fn(() => enabled ? withAuto() : canonical);
      const queued = client.chatCompletion({ model: MODEL, messages: canonical, resolveMessages, isCancelled: () => cancelled });
      expect(resolveMessages).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      enabled = false;
      cancelled = cancel;
      releaseFirst.resolve(response());
      expect(await occupying).toMatchObject({ text: 'healthy' });
      const result = await queued;
      if (cancel) {
        expect(result).toMatchObject({ failed: true, error: 'Request cancelled before dispatch' });
        expect(resolveMessages).not.toHaveBeenCalled();
        expect(requests).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ text: 'healthy', inputTokens: 11, outputTokens: 3 });
        expect(resolveMessages).toHaveBeenCalledTimes(1);
        expect(requests[1].messages).toEqual(canonical);
      }
      expect(await client.chatCompletion({ model: MODEL, messages: canonical })).toMatchObject({ text: 'healthy' });
      expect(requests).toHaveLength(cancel ? 2 : 3);
    });

    it(`OpenRouter rechecks ${cancel ? 'ownership' : 'Auto Context'} after 429 backoff`, async () => {
      const sleeping = deferred<void>();
      const releaseSleep = deferred<void>();
      const requests: ReturnType<typeof body>[] = [];
      const limited = new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        requests.push(body(init));
        return requests.length === 1 ? limited : response();
      });
      const client = new OpenRouterClient(() => 'sk_fixture', {
        fetchImpl, maxRetries: 1,
        sleepImpl: async () => { sleeping.resolve(); await releaseSleep.promise; },
      });
      let enabled = true;
      let cancelled = false;
      const resolveMessages = vi.fn(() => enabled ? withAuto() : canonical);
      const pending = client.chatCompletion({ model: MODEL, messages: canonical, resolveMessages, isCancelled: () => cancelled });
      await sleeping.promise;
      enabled = false;
      cancelled = cancel;
      releaseSleep.resolve();
      const result = await pending;
      expect(requests[0].messages).toEqual(withAuto());
      expect(limited.bodyUsed).toBe(true);
      if (cancel) {
        expect(result).toMatchObject({ failed: true, error: 'Request cancelled before dispatch' });
        expect(requests).toHaveLength(1);
        expect(resolveMessages).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toMatchObject({ text: 'healthy' });
        expect(requests[1].messages).toEqual(canonical);
        expect(resolveMessages).toHaveBeenCalledTimes(2);
      }
      expect(await client.chatCompletion({ model: MODEL, messages: canonical })).toMatchObject({ text: 'healthy' });
      expect(requests).toHaveLength(cancel ? 2 : 3);
    });

    for (const stream of [false, true]) {
      it(`Coordinator ${stream ? 'stream' : 'completion'} rechecks ${cancel ? 'ownership' : 'Auto Context'} for each gateway fallback`, async () => {
        let enabled = true;
        let cancelled = false;
        const requests: ReturnType<typeof body>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
          requests.push(body(init));
          if (requests.length === 1) {
            enabled = false;
            cancelled = cancel;
            return new Response('retry another model', { status: 429 });
          }
          return response(stream);
        }));
        const client = coordinator(new OpenRouterClient(() => undefined));
        const resolveMessages = vi.fn(() => enabled ? withAuto() : canonical);
        const options = { resolveMessages, isCancelled: () => cancelled };
        const result = stream ? await drain(client.stream(canonical, options)) : await client.complete(canonical, options);
        expect(requests[0].messages).toEqual(withAuto());
        if (cancel) {
          expect(JSON.stringify(result)).toContain('Request cancelled before dispatch');
          expect(requests).toHaveLength(1);
          expect(resolveMessages).toHaveBeenCalledTimes(1);
        } else {
          expect(JSON.stringify(result)).toContain('healthy');
          expect(requests.map(r => r.model)).toEqual([`openrouter/${MODEL}`, 'openrouter/google/gemma-4-31b-it:free']);
          expect(requests[1].messages).toEqual(canonical);
          expect(resolveMessages).toHaveBeenCalledTimes(2);
        }
      });

      it(`Coordinator ${stream ? 'stream' : 'completion'} rechecks ${cancel ? 'ownership' : 'Auto Context'} after model discovery`, async () => {
        const discoveryStarted = deferred<void>();
        const discoveryResponse = deferred<Response>();
        const requests: ReturnType<typeof body>[] = [];
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
          if (!init?.body) { discoveryStarted.resolve(); return discoveryResponse.promise; }
          requests.push(body(init));
          return response(stream);
        });
        const client = coordinator(new OpenRouterClient(() => 'sk_fixture', { fetchImpl }));
        let enabled = true;
        let cancelled = false;
        const resolveMessages = vi.fn(() => enabled ? withAuto() : canonical);
        const options = { resolveMessages, isCancelled: () => cancelled };
        const pending = stream ? drain(client.stream(canonical, options)) : client.complete(canonical, options);
        await discoveryStarted.promise;
        expect(resolveMessages).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
        enabled = false;
        cancelled = cancel;
        discoveryResponse.resolve(Response.json({ data: [{ id: MODEL, name: 'Fixture model', pricing: { prompt: '0', completion: '0' } }] }));
        const result = await pending;
        if (cancel) {
          expect(JSON.stringify(result)).toContain('Request cancelled before dispatch');
          expect(resolveMessages).not.toHaveBeenCalled();
          expect(requests).toEqual([]);
        } else {
          expect(JSON.stringify(result)).toContain('healthy');
          expect(requests).toHaveLength(1);
          expect(requests[0]).toMatchObject({ model: MODEL, messages: canonical });
          expect(resolveMessages).toHaveBeenCalledTimes(1);
        }
      });
    }
  }
});
