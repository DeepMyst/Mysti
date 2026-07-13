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
      expect(res.costUsd).toBe(0);
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
});
