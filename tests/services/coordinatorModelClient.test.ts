/**
 * CoordinatorModelClient tests — the Mysti agent runs through the DeepMyst
 * gateway (dm_ key) by default and requires a signed-in DeepMyst account (free
 * OK); an explicit OpenRouter key opts into OpenRouter instead.
 */
import { describe, it, expect, vi } from 'vitest';
import { CoordinatorModelClient, MYSTI_SIGNIN_MESSAGE, type CoordinatorConfig } from '../../src/services/CoordinatorModelClient';
import type { OpenRouterClient } from '../../src/services/OpenRouterClient';
import type { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';

async function* mkStream(events: any[]) { for (const e of events) { yield e; } }

function stubGateway(over: Partial<Record<keyof DeepMystGatewayClient, any>> = {}): DeepMystGatewayClient {
  return {
    chatCompletion: async () => ({ text: 'gateway result', failed: false, costUsd: 0.0001 }),
    streamChat: () => mkStream([{ text: 'gateway ' }, { text: 'stream' }, { done: true }]),
    ...over,
  } as unknown as DeepMystGatewayClient;
}

function stubOpenRouter(over: Partial<Record<keyof OpenRouterClient, any>> = {}): OpenRouterClient {
  return {
    isConfigured: () => false, // default: NOT configured ⇒ gateway is used
    getDefaultFreeModel: async () => 'discovered/model:free',
    chatCompletion: async () => ({ text: 'openrouter result', failed: false, costUsd: 0 }),
    streamChat: () => mkStream([{ text: 'openrouter stream' }, { done: true }]),
    ...over,
  } as unknown as OpenRouterClient;
}

function cfg(over: Partial<CoordinatorConfig> = {}): CoordinatorConfig {
  return { freeModels: ['openrouter/openai/gpt-oss-120b:free'], gatewayFallbackModel: 'claude-haiku-4-5', openRouterModel: 'auto', ...over };
}

function make(opts: { or?: OpenRouterClient; gw?: DeepMystGatewayClient; signedIn?: boolean; config?: CoordinatorConfig } = {}) {
  return new CoordinatorModelClient(
    opts.gw ?? stubGateway(),
    opts.or ?? stubOpenRouter(),
    () => opts.signedIn ?? true,
    () => opts.config ?? cfg(),
  );
}

describe('CoordinatorModelClient — DeepMyst gateway by default', () => {
  it('runs on the gateway when signed in and no OpenRouter key', async () => {
    const client = make({ signedIn: true });
    expect(client.status()).toEqual({ ready: true });
    expect(await client.resolveCoordinatorModel()).toBe('openrouter/openai/gpt-oss-120b:free');
    const res = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(res.failed).toBe(false);
    expect(res.text).toBe('gateway result');
  });

  it('needs sign-in when not signed in and no OpenRouter key', async () => {
    const gatewaySpy = vi.fn(async () => ({ text: 'x', failed: false }));
    const client = make({ signedIn: false, gw: stubGateway({ chatCompletion: gatewaySpy }) });
    expect(client.status()).toEqual({ ready: false, reason: 'signin' });
    const res = await client.complete([]);
    expect(res.failed).toBe(true);
    expect(res.error).toBe(MYSTI_SIGNIN_MESSAGE);
    expect(gatewaySpy).not.toHaveBeenCalled(); // never hits the gateway signed out
  });

  it('streams over the gateway (normalizing usage)', async () => {
    const gw = stubGateway({ streamChat: () => mkStream([{ text: 'A' }, { text: 'B' }, { usage: { inputTokens: 3, outputTokens: 1 } }, { done: true }]) });
    const client = make({ gw, signedIn: true });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('AB');
    expect(out.find(e => e.usage)?.usage).toEqual({ input_tokens: 3, output_tokens: 1 });
    expect(out.some(e => e.done)).toBe(true);
  });

  it('stream emits the sign-in message when signed out (no OR key)', async () => {
    const client = make({ signedIn: false });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(out.some(e => e.error === MYSTI_SIGNIN_MESSAGE)).toBe(true);
    expect(out.some(e => e.text)).toBe(false);
  });

  it('falls back to the paid model when the free model is rate-limited (stream)', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => {
        models.push(p.model);
        return p.model === 'claude-haiku-4-5'
          ? mkStream([{ text: 'paid answer' }, { done: true }])
          : mkStream([{ error: 'RateLimitError: 429 temporarily rate-limited' }]);
      },
    });
    const client = make({ gw, signedIn: true });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['openrouter/openai/gpt-oss-120b:free', 'claude-haiku-4-5']); // free first, then fallback
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('paid answer');
    expect(out.some(e => e.error)).toBe(false);
  });

  it('rotates through multiple free models on rate-limit before the paid fallback (stream)', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => {
        models.push(p.model);
        // first two free models are throttled; the third answers.
        return p.model === 'openrouter/google/gemma-4-31b-it:free'
          ? mkStream([{ text: 'gemma answer' }, { done: true }])
          : mkStream([{ error: '429 temporarily rate-limited' }]);
      },
    });
    const client = make({
      gw,
      signedIn: true,
      config: cfg({
        freeModels: [
          'openrouter/openai/gpt-oss-120b:free',
          'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
          'openrouter/google/gemma-4-31b-it:free',
        ],
      }),
    });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    // walked free models in order, stopped at the one that answered (no paid fallback needed).
    expect(models).toEqual([
      'openrouter/openai/gpt-oss-120b:free',
      'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/google/gemma-4-31b-it:free',
    ]);
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('gemma answer');
    expect(out.some(e => e.error)).toBe(false);
  });

  it('reaches the paid fallback only after every free model is rate-limited (stream)', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => {
        models.push(p.model);
        return p.model === 'claude-haiku-4-5'
          ? mkStream([{ text: 'paid answer' }, { done: true }])
          : mkStream([{ error: '429 rate-limited' }]);
      },
    });
    const client = make({
      gw,
      signedIn: true,
      config: cfg({ freeModels: ['free/a:free', 'free/b:free'] }),
    });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['free/a:free', 'free/b:free', 'claude-haiku-4-5']);
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('paid answer');
  });

  it('de-duplicates the chain (pinned model == fallback ⇒ no wasted retry)', async () => {
    const models: string[] = [];
    const gw = stubGateway({ streamChat: (p: any) => { models.push(p.model); return mkStream([{ error: '429 rate-limited' }]); } });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['claude-haiku-4-5'], gatewayFallbackModel: 'claude-haiku-4-5' }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['claude-haiku-4-5']); // deduped: tried once, no rollover to an identical model
    expect(out.some(e => e.error)).toBe(true);
  });

  it('resolveCoordinatorModel returns the first free model in the chain', async () => {
    const client = make({ signedIn: true, config: cfg({ freeModels: ['free/x:free', 'free/y:free'] }) });
    expect(await client.resolveCoordinatorModel()).toBe('free/x:free');
  });

  it('advances on a mid-stream fallback / provider-drop error before any text (the reported MidStreamFallbackError)', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => {
        models.push(p.model);
        // The auto-router drops with litellm's mid-stream fallback error before
        // emitting text; the next free model answers.
        return p.model === 'openrouter/openrouter/free'
          ? mkStream([{ error: 'Stream interrupted: MidStreamFallbackError' }])
          : mkStream([{ text: 'concrete answer' }, { done: true }]);
      },
    });
    const client = make({
      gw,
      signedIn: true,
      config: cfg({ freeModels: ['openrouter/openrouter/free', 'openrouter/openai/gpt-oss-120b:free'] }),
    });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['openrouter/openrouter/free', 'openrouter/openai/gpt-oss-120b:free']);
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('concrete answer');
    expect(out.some(e => e.error)).toBe(false);
  });

  it('degrades gracefully when the router id is unusable (model-not-found rolls to the next model)', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => {
        models.push(p.model);
        return p.model === 'openrouter/openrouter/free'
          ? mkStream([{ error: 'BadRequestError: model not found' }])
          : mkStream([{ text: 'ok' }, { done: true }]);
      },
    });
    const client = make({
      gw,
      signedIn: true,
      config: cfg({ freeModels: ['openrouter/openrouter/free', 'openrouter/openai/gpt-oss-120b:free'] }),
    });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['openrouter/openrouter/free', 'openrouter/openai/gpt-oss-120b:free']);
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('ok');
  });

  it('does NOT fall back on a hard (non-transient) error — no wasted paid call', async () => {
    const models: string[] = [];
    const gw = stubGateway({ streamChat: (p: any) => { models.push(p.model); return mkStream([{ error: '401 Unauthorized: invalid key' }]); } });
    const client = make({ gw, signedIn: true });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['openrouter/openai/gpt-oss-120b:free']); // no fallback attempt on an auth error
    expect(out.some(e => e.error === '401 Unauthorized: invalid key')).toBe(true);
  });

  it('complete() falls back to the paid model on rate-limit', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      chatCompletion: async (p: any) => {
        models.push(p.model);
        return p.model === 'claude-haiku-4-5'
          ? { text: 'paid', failed: false }
          : { text: '', failed: true, error: '429 rate limit' };
      },
    });
    const client = make({ gw, signedIn: true });
    const res = await client.complete([]);
    expect(res.failed).toBe(false);
    expect(res.text).toBe('paid');
    expect(res.viaFallback).toBe(true);
    expect(models).toEqual(['openrouter/openai/gpt-oss-120b:free', 'claude-haiku-4-5']);
  });

  it('surfaces a mid-stream error even after text was emitted (no silent completion)', async () => {
    // text-then-error (e.g. a timeout mid-generation) must NOT be reported done.
    const gw = stubGateway({ streamChat: () => mkStream([{ text: 'partial' }, { error: 'read timeout' }]) });
    const client = make({ gw, signedIn: true });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(out.some(e => e.text === 'partial')).toBe(true);
    expect(out.some(e => e.error === 'read timeout')).toBe(true);
    expect(out.some(e => e.done)).toBe(false); // never a clean done after an error
  });

  // ── Attribution: report the model that actually answered (router / fall-through) ──

  it('forwards the concrete model the gateway resolved to (behind a router id)', async () => {
    const gw = stubGateway({ streamChat: () => mkStream([{ model: 'openai/gpt-oss-120b' }, { text: 'hi' }, { done: true }]) });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['openrouter/openrouter/free'] }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    // The router id was requested, but the answer is attributed to the real model.
    expect(out.filter(e => e.model).map(e => e.model)).toContain('openai/gpt-oss-120b');
    expect(out.filter(e => e.model).map(e => e.model)).not.toContain('openrouter/openrouter/free');
  });

  it('falls back to the requested id for attribution when the gateway reports no model', async () => {
    const gw = stubGateway({ streamChat: () => mkStream([{ text: 'hi' }, { done: true }]) });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['free/x:free'] }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(out.find(e => e.model)?.model).toBe('free/x:free');
  });

  it('attributes to the fall-through model, not chain[0], when the router is rate-limited', async () => {
    const gw = stubGateway({
      streamChat: (p: any) => p.model === 'openrouter/openrouter/free'
        ? mkStream([{ error: '429 rate-limited' }])
        : mkStream([{ model: 'concrete-winner' }, { text: 'answer' }, { done: true }]),
    });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['openrouter/openrouter/free', 'openrouter/openai/gpt-oss-120b:free'] }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    // Last-reported model is the one that actually answered.
    const models = out.filter(e => e.model).map(e => e.model);
    expect(models[models.length - 1]).toBe('concrete-winner');
  });

  it('complete() returns the model that actually answered', async () => {
    const gw = stubGateway({
      chatCompletion: async (p: any) => p.model === 'claude-haiku-4-5'
        ? { text: 'paid', failed: false, model: 'claude-haiku-4-5-resolved' }
        : { text: '', failed: true, error: '429 rate limit' },
    });
    const client = make({ gw, signedIn: true });
    const res = await client.complete([]);
    expect(res.model).toBe('claude-haiku-4-5-resolved');
  });

  // ── Broadened retryable classifier (adversarial-review findings) ──

  it('rolls over on a generic transport failure "fetch failed" (undici collapses network errors)', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => { models.push(p.model); return p.model === 'b/b:free' ? mkStream([{ text: 'ok' }, { done: true }]) : mkStream([{ error: 'fetch failed' }]); },
    });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['a/a:free', 'b/b:free'] }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['a/a:free', 'b/b:free']);
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('ok');
  });

  it('rolls over on a code-less "Too Many Requests" rate phrase', async () => {
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => { models.push(p.model); return p.model === 'b/b:free' ? mkStream([{ text: 'ok' }, { done: true }]) : mkStream([{ error: 'Too Many Requests' }]); },
    });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['a/a:free', 'b/b:free'] }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['a/a:free', 'b/b:free']);
    expect(out.filter(e => e.text).map(e => e.text).join('')).toBe('ok');
  });

  it('HARD-STOPS on a 402 even when the error body contains a transient word (stream/complete symmetry)', async () => {
    const models: string[] = [];
    // streamChat appends the response body to the error; a 402 body may contain a
    // transient phrase, but out-of-credits fails identically everywhere → stop.
    const gw = stubGateway({
      streamChat: (p: any) => { models.push(p.model); return mkStream([{ error: 'HTTP 402: insufficient credits; upstream provider returned error' }]); },
    });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['a/a:free', 'b/b:free'] }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['a/a:free']); // did NOT walk the chain to burn the paid fallback
    expect(out.some(e => e.error && e.error.includes('402'))).toBe(true);
  });
});

describe('CoordinatorModelClient — OpenRouter opt-in when keyed', () => {
  it('uses OpenRouter (not the gateway) when an OpenRouter key is configured, even signed out', async () => {
    const gatewaySpy = vi.fn(async () => ({ text: 'gw', failed: false }));
    const or = stubOpenRouter({ isConfigured: () => true });
    const client = make({ or, signedIn: false, gw: stubGateway({ chatCompletion: gatewaySpy }) });
    expect(client.status()).toEqual({ ready: true }); // OR key ⇒ ready regardless of sign-in
    const res = await client.complete([]);
    expect(res.text).toBe('openrouter result');
    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  it('resolves an OpenRouter free model (auto) on the opt-in path', async () => {
    const or = stubOpenRouter({ isConfigured: () => true });
    const client = make({ or, config: cfg({ openRouterModel: 'auto' }) });
    expect(await client.resolveCoordinatorModel()).toBe('discovered/model:free');
  });

  it('pins an explicit OpenRouter model when configured', async () => {
    const getDefaultFreeModel = vi.fn(async () => 'discovered/model:free');
    const or = stubOpenRouter({ isConfigured: () => true, getDefaultFreeModel });
    const client = make({ or, config: cfg({ openRouterModel: 'openai/gpt-oss-120b:free' }) });
    expect(await client.resolveCoordinatorModel()).toBe('openai/gpt-oss-120b:free');
    expect(getDefaultFreeModel).not.toHaveBeenCalled();
  });
});

describe('CoordinatorModelClient — native tool-calling (Plan 19 P4)', () => {
  const TOOL_CALLS = [{ id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' }];

  it('forwards a toolCalls event from the gateway path (with done)', async () => {
    const gw = stubGateway({ streamChat: () => mkStream([{ toolCalls: TOOL_CALLS }, { finishReason: 'tool_calls' }, { done: true }]) });
    const client = make({ gw });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(out.find(e => e.toolCalls)?.toolCalls).toEqual(TOOL_CALLS);
    expect(out.some(e => e.done)).toBe(true);
  });

  it('forwards a toolCalls event from the OpenRouter path', async () => {
    const or = stubOpenRouter({ isConfigured: () => true, streamChat: () => mkStream([{ toolCalls: TOOL_CALLS }, { done: true }]) });
    const client = make({ or, signedIn: false });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(out.find(e => e.toolCalls)?.toolCalls).toEqual(TOOL_CALLS);
    expect(out.some(e => e.done)).toBe(true);
  });

  it('completes a tool-call-only turn even with no text (drain marks done)', async () => {
    // A pure tool-call turn emits no text; the OpenRouter drain must still end
    // with { done } rather than "No response from the coordinator model".
    const or = stubOpenRouter({ isConfigured: () => true, streamChat: () => mkStream([{ toolCalls: TOOL_CALLS }]) });
    const client = make({ or, signedIn: false });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(out.some(e => e.error)).toBe(false);
    expect(out[out.length - 1]).toEqual({ done: true });
  });

  it('passes the tools array through to the gateway streamChat', async () => {
    const seen: any = {};
    const gw = stubGateway({ streamChat: (p: any) => { seen.tools = p.tools; return mkStream([{ text: 'ok' }, { done: true }]); } });
    const client = make({ gw });
    const tools = [{ type: 'function', function: { name: 'read', description: 'd', parameters: {} } }];
    for await (const _ of client.stream([], { tools })) { /* drain */ }
    expect(seen.tools).toEqual(tools);
  });

  it('passes the tools array through to the OpenRouter streamChat (tool-capable model)', async () => {
    const seen: any = {};
    const or = stubOpenRouter({ isConfigured: () => true, streamChat: (p: any) => { seen.tools = p.tools; return mkStream([{ text: 'ok' }, { done: true }]); } });
    // Pin a tool-capable resolved model so the per-model gate attaches tools.
    const client = make({ or, signedIn: false, config: cfg({ openRouterModel: 'openai/gpt-oss-120b:free' }) });
    const tools = [{ type: 'function', function: { name: 'ls', description: 'd', parameters: {} } }];
    for await (const _ of client.stream([], { tools })) { /* drain */ }
    expect(seen.tools).toEqual(tools);
  });

  it('does NOT attach tools when the resolved OpenRouter model is not tool-capable (round-5 #5/#9)', async () => {
    const seen: any = { set: false };
    const or = stubOpenRouter({ isConfigured: () => true, getDefaultFreeModel: async () => 'mystery/unknown-model:free', streamChat: (p: any) => { seen.tools = p.tools; seen.set = true; return mkStream([{ text: 'ok' }, { done: true }]); } });
    const client = make({ or, signedIn: false, config: cfg({ openRouterModel: 'auto' }) });
    const tools = [{ type: 'function', function: { name: 'ls', description: 'd', parameters: {} } }];
    for await (const _ of client.stream([], { tools })) { /* drain */ }
    expect(seen.set).toBe(true);
    expect(seen.tools).toBeUndefined();
  });

  it('does NOT fail over to the next chain model after a model already emitted toolCalls (round-5 #4/#6)', async () => {
    // Model A emits a finalized tool_call, then a retryable transport error
    // before [DONE]. The attempt OWNS the turn — the chain must NOT advance and
    // merge a second model's output into the same coordinator turn.
    const models: string[] = [];
    const gw = stubGateway({
      streamChat: (p: any) => {
        models.push(p.model);
        return p.model === 'free/a:free'
          ? mkStream([{ toolCalls: TOOL_CALLS }, { error: 'Stream interrupted: MidStreamFallbackError' }])
          : mkStream([{ text: 'second model answer' }, { done: true }]);
      },
    });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['free/a:free', 'free/b:free'] }) });
    const out: any[] = [];
    for await (const ev of client.stream([])) { out.push(ev); }
    expect(models).toEqual(['free/a:free']); // never advanced to free/b:free
    expect(out.find(e => e.toolCalls)?.toolCalls).toEqual(TOOL_CALLS);
    expect(out.some(e => e.text === 'second model answer')).toBe(false);
  });

  it('attaches tools only to the tool-capable models in the chain (round-5 #5/#9)', async () => {
    // Primary is tool-capable (gets tools); a non-capable fallback must NOT
    // receive the tools field (it would 400 on it).
    const seen: Record<string, unknown> = {};
    const gw = stubGateway({
      streamChat: (p: any) => {
        seen[p.model] = p.tools;
        return p.model === 'openrouter/openai/gpt-oss-120b:free'
          ? mkStream([{ error: '429 rate-limited' }]) // force failover
          : mkStream([{ text: 'ok' }, { done: true }]);
      },
    });
    const client = make({ gw, signedIn: true, config: cfg({ freeModels: ['openrouter/openai/gpt-oss-120b:free'], gatewayFallbackModel: 'noncapable/mystery-model' }) });
    const tools = [{ type: 'function', function: { name: 'read', description: 'd', parameters: {} } }];
    for await (const _ of client.stream([], { tools })) { /* drain */ }
    expect(seen['openrouter/openai/gpt-oss-120b:free']).toEqual(tools); // capable → tools
    expect(seen['noncapable/mystery-model']).toBeUndefined();            // non-capable → no tools
  });
});
