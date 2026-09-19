/**
 * OpenRouterClient tests (Plan 15 Phase 1). Injected fetch + sleep keep these
 * deterministic and fast — no network, no real backoff waits.
 */
import { describe, it, expect, vi } from 'vitest';
import { OpenRouterClient, OPENROUTER_FREE_ROUTER } from '../../src/services/OpenRouterClient';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

const MODELS_BODY = {
  data: [
    { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS', context_length: 131000, supported_parameters: ['tools', 'temperature'] },
    { id: 'nvidia/nemotron-ultra:free', name: 'Nemotron', context_length: 1000000, supported_parameters: ['tools'] },
    { id: 'some/no-tools:free', name: 'NoTools', context_length: 8000, supported_parameters: ['temperature'] },
    { id: 'paid/model', name: 'Paid', context_length: 200000, supported_parameters: ['tools'] },
  ],
};

function makeClient(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}) {
  return new OpenRouterClient(() => 'sk-or-test-key', {
    fetchImpl,
    sleepImpl: async () => {},
    ...opts,
  });
}

describe('OpenRouterClient', () => {
  describe('chatCompletion', () => {
    it('returns the completion text on success', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({
        choices: [{ message: { content: 'hello from free model' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      const res = await client.chatCompletion({ model: 'x:free', messages: [{ role: 'user', content: 'hi' }] });
      expect(res.failed).toBeFalsy();
      expect(res.text).toBe('hello from free model');
      expect(res.costUsd).toBeUndefined();
      expect(res.inputTokens).toBe(10);
    });

    it('fails gracefully with no API key', async () => {
      const client = new OpenRouterClient(() => undefined, { fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
      const res = await client.chatCompletion({ model: 'x:free', messages: [] });
      expect(res.failed).toBe(true);
      expect(res.text).toBe('');
    });

    it('sends Authorization + attribution headers to the chat endpoint', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
      const client = makeClient(fetchImpl as unknown as typeof fetch, { appTitle: 'Mysti', referer: 'https://x' });
      await client.chatCompletion({ model: 'x:free', messages: [{ role: 'user', content: 'hi' }] });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain('openrouter.ai/api/v1/chat/completions');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-or-test-key');
      expect(headers['X-Title']).toBe('Mysti');
      expect(headers['HTTP-Referer']).toBe('https://x');
    });

    it('retries on 429 then fails after exhausting retries', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'rate limited' }, { status: 429 }));
      const client = makeClient(fetchImpl as unknown as typeof fetch, { maxRetries: 2 });
      const res = await client.chatCompletion({ model: 'x:free', messages: [] });
      expect(res.failed).toBe(true);
      expect(res.error).toContain('429');
      // 1 initial + 2 retries
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('recovers when a retry succeeds after a 429', async () => {
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n++;
        return n === 1
          ? jsonResponse({}, { status: 429 })
          : jsonResponse({ choices: [{ message: { content: 'recovered' } }] });
      });
      const client = makeClient(fetchImpl as unknown as typeof fetch, { maxRetries: 2 });
      const res = await client.chatCompletion({ model: 'x:free', messages: [] });
      expect(res.failed).toBeFalsy();
      expect(res.text).toBe('recovered');
    });

    it('fails (does not throw) on a non-2xx error', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'boom' }, { status: 500 }));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      const res = await client.chatCompletion({ model: 'x:free', messages: [] });
      expect(res.failed).toBe(true);
      expect(res.error).toContain('500');
    });
  });

  describe('free-model discovery', () => {
    it('filters to :free models, and to tool-capable ones when asked', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(MODELS_BODY));
      const client = makeClient(fetchImpl as unknown as typeof fetch);

      const free = await client.listFreeModels();
      expect(free.map(m => m.id).sort()).toEqual(
        ['nvidia/nemotron-ultra:free', 'openai/gpt-oss-120b:free', 'some/no-tools:free'].sort()
      );
      expect(free.some(m => m.id === 'paid/model')).toBe(false);

      const toolCapable = await client.listFreeModels({ toolsOnly: true });
      expect(toolCapable.map(m => m.id)).not.toContain('some/no-tools:free');
      expect(toolCapable.every(m => m.supportsTools)).toBe(true);
    });

    it('caches the model list (single fetch across calls)', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(MODELS_BODY));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      await client.listFreeModels();
      await client.listFreeModels({ toolsOnly: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('getDefaultFreeModel prefers the largest-context tool-capable free model', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(MODELS_BODY));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      const def = await client.getDefaultFreeModel();
      // Nemotron has the largest context (1M) among tool-capable free models.
      expect(def).toBe('nvidia/nemotron-ultra:free');
    });

    it('falls back to the free meta-router when discovery is empty', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      expect(await client.getDefaultFreeModel()).toBe(OPENROUTER_FREE_ROUTER);
    });

    it('falls back to the meta-router when /models errors', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 500 }));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      expect(await client.getDefaultFreeModel()).toBe(OPENROUTER_FREE_ROUTER);
    });
  });

  describe('full catalog (listAllModels) + free/paid + pricing', () => {
    const CATALOG = {
      data: [
        { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS Free', context_length: 131000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', context_length: 200000, supported_parameters: ['tools'], pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'zero/priced-no-suffix', name: 'Zero Priced', context_length: 8000, supported_parameters: [], pricing: { prompt: '0', completion: '0' } },
        { id: 'nopricing/model', name: 'No Pricing', context_length: 4000, supported_parameters: ['tools'] },
      ],
    };

    it('returns BOTH free and paid models (unlike listFreeModels)', async () => {
      const client = makeClient((async () => jsonResponse(CATALOG)) as unknown as typeof fetch);
      const all = await client.listAllModels();
      expect(all.map(m => m.id).sort()).toEqual(CATALOG.data.map(m => m.id).sort());
    });

    it('marks :free suffix and all-zero pricing as free; priced/unknown as paid', async () => {
      const client = makeClient((async () => jsonResponse(CATALOG)) as unknown as typeof fetch);
      const byId = Object.fromEntries((await client.listAllModels()).map(m => [m.id, m]));
      expect(byId['openai/gpt-oss-120b:free'].free).toBe(true);    // :free suffix
      expect(byId['zero/priced-no-suffix'].free).toBe(true);        // all-zero pricing, no suffix
      expect(byId['anthropic/claude-sonnet-4.6'].free).toBe(false); // priced
      expect(byId['nopricing/model'].free).toBe(false);            // unknown pricing → treat as paid
    });

    it('parses per-token pricing (absent when the API omits it)', async () => {
      const client = makeClient((async () => jsonResponse(CATALOG)) as unknown as typeof fetch);
      const all = await client.listAllModels();
      expect(all.find(m => m.id === 'anthropic/claude-sonnet-4.6')!.pricing).toEqual({ prompt: 0.000003, completion: 0.000015 });
      expect(all.find(m => m.id === 'nopricing/model')!.pricing).toBeUndefined();
    });

    it('toolsOnly filters to tool-capable models', async () => {
      const client = makeClient((async () => jsonResponse(CATALOG)) as unknown as typeof fetch);
      const tools = await client.listAllModels({ toolsOnly: true });
      expect(tools.map(m => m.id)).not.toContain('zero/priced-no-suffix');
      expect(tools.every(m => m.supportsTools)).toBe(true);
    });
  });

  describe('concurrency cap', () => {
    it('never runs more than maxConcurrent requests at once', async () => {
      let active = 0;
      let peak = 0;
      const fetchImpl = vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 10));
        active--;
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      });
      const client = makeClient(fetchImpl as unknown as typeof fetch, { maxConcurrent: 2 });
      await Promise.all(
        Array.from({ length: 6 }, () => client.chatCompletion({ model: 'x:free', messages: [] }))
      );
      expect(peak).toBeLessThanOrEqual(2);
      expect(fetchImpl).toHaveBeenCalledTimes(6);
    });
  });

  describe('streamChat — native tool_calls (Plan 19 P4)', () => {
    function sseResponse(frames: string[]): Response {
      return new Response(frames.map(f => `data: ${f}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    it('accumulates streamed tool_call deltas and emits one toolCalls event', async () => {
      const fetchImpl = vi.fn(async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      const out: any[] = [];
      for await (const ev of client.streamChat({ model: 'x:free', messages: [], tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: {} } }] })) { out.push(ev); }
      const tc = out.find(e => e.toolCalls)?.toolCalls;
      expect(tc).toEqual([{ id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' }]);
      // emitted exactly once, and the stream still completes cleanly
      expect(out.filter(e => e.toolCalls).length).toBe(1);
      expect(out.some(e => e.done)).toBe(true);
    });

    it('sends the tools field in the request body only when provided', async () => {
      const bodies: any[] = [];
      const fetchImpl = vi.fn(async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }), '[DONE]']); });
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      for await (const _ of client.streamChat({ model: 'x:free', messages: [], tools: [{ type: 'function', function: { name: 'ls', description: 'd', parameters: {} } }] })) { /* drain */ }
      for await (const _ of client.streamChat({ model: 'x:free', messages: [] })) { /* drain */ }
      expect(bodies[0].tools).toBeDefined();
      expect(bodies[0].tool_choice).toBe('auto');
      expect(bodies[1].tools).toBeUndefined();
    });
  });
});
