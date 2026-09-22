/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenRouterClient (Plan 15 Phase 1 — the @mysti coordinator's cheap-task model).
 *
 * A thin OpenAI-compatible client for OpenRouter (`https://openrouter.ai/api/v1`),
 * used to run the coordinator's own reasoning (decompose/synthesize) + cheap leaf
 * tasks on FREE models. Its `chatCompletion(params) → GatewayCompletion` signature
 * mirrors DeepMystGatewayClient so a facade can dispatch by model id and the
 * caller is untouched.
 *
 * Free-tier reality drives the design (see plans/15):
 *  - Free models carry a `:free` suffix and the roster ROTATES — never hardcode.
 *    `listFreeModels()` discovers them at runtime from `/models` and caches.
 *  - There's a HARD 20 requests/min cap on `:free` that credits don't raise, plus
 *    a daily cap; failed calls burn quota. So: a small concurrency semaphore, and
 *    429 retry-with-backoff; on exhaustion return `{ failed: true }` so the caller
 *    degrades gracefully (or falls back to a user-set paid model).
 *  - The base URL is fixed (not workspace-overridable) and host-allowlisted so a
 *    workspace can't redirect the user's OpenRouter key elsewhere.
 */

import type { GatewayCompletion } from '../types';
import type { GatewayChatParams } from './DeepMystGatewayClient';
import { applyCacheBreakpoints, readCacheTokens } from './PromptCache';
import { createAbortScope } from '../utils/abortScope';
import { readServerSentData, MAX_HTTP_FRAME_CHARS } from '../utils/httpStream';
import { isRecord } from '../utils/valueGuards';
import { ToolCallAccumulator, parseToolArgsChecked, type AccumulatedToolCall, type ToolCallDelta } from '../utils/toolCallAccumulator';

/** Fixed OpenRouter API base — deliberately not a workspace setting (key safety). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** How long a discovered free-model list is trusted before re-fetching. */
export const OPENROUTER_MODELS_TTL_MS = 10 * 60 * 1000;

/** The meta-router that auto-routes to whatever free model is currently up. */
export const OPENROUTER_FREE_ROUTER = 'openrouter/free';

export interface OpenRouterModel {
  id: string;
  name?: string;
  contextLength?: number;
  /** Whether the model advertises tool/function calling (varies on free tier). */
  supportsTools: boolean;
  /** True for zero-cost models (a `:free` id, or all-zero pricing). */
  free: boolean;
  /** USD per token (prompt/completion) when advertised; absent ⇒ unknown. */
  pricing?: { prompt: number; completion: number };
}

export interface OpenRouterClientOptions {
  /** Max concurrent requests — kept well under the 20 rpm cap. */
  maxConcurrent?: number;
  /** Retries on HTTP 429 before giving up. */
  maxRetries?: number;
  /** App attribution (OpenRouter `X-Title`); no functional effect. */
  appTitle?: string;
  /** App URL (OpenRouter `HTTP-Referer`); no functional effect. */
  referer?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injected sleep for tests; optional signal lets the implementation release its work. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface OpenRouterCompletion extends GatewayCompletion {
  /** The cache-creation count is already included in inputTokens. */
  cacheCreationIncluded?: boolean;
}

export class OpenRouterClient {
  private readonly _getApiKey: () => string | undefined;
  private readonly _maxConcurrent: number;
  private readonly _maxRetries: number;
  private readonly _appTitle: string;
  private readonly _referer: string;
  private readonly _fetch: typeof fetch;
  private readonly _sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  private _active = 0;
  private readonly _waiters: Array<() => void> = [];
  private _modelCache: { models: OpenRouterModel[]; fetchedAt: number } | null = null;
  private _modelsInFlight: Promise<OpenRouterModel[]> | null = null;

  constructor(getApiKey: () => string | undefined, options: OpenRouterClientOptions = {}) {
    this._getApiKey = getApiKey;
    this._maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this._maxRetries = Math.max(0, options.maxRetries ?? 2);
    this._appTitle = options.appTitle ?? 'Mysti';
    this._referer = options.referer ?? 'https://www.deepmyst.com/mysti';
    this._fetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this._sleep = (ms, signal) => sleepWithAbort(ms, signal, options.sleepImpl);
  }

  /** Whether an OpenRouter key is configured (client is usable). */
  public isConfigured(): boolean {
    return !!this._getApiKey();
  }

  /**
   * Run a chat completion on OpenRouter. Never throws — returns
   * `{ failed: true }` on any failure (no key, 429-exhausted, non-2xx, network)
   * so the caller can degrade gracefully or fall back to a paid model.
   */
  public async chatCompletion(params: GatewayChatParams): Promise<OpenRouterCompletion> {
    const key = this._getApiKey();
    if (!key) {
      return { text: '', failed: true, error: 'No OpenRouter API key configured' };
    }
    if (!isAllowedHost(OPENROUTER_BASE_URL)) {
      // Defensive: OPENROUTER_BASE_URL is a constant, but never send the key off-host.
      return { text: '', failed: true, error: 'OpenRouter host not allowed' };
    }

    try {
      return await this._withSlot(() => this._doChatWithRetry(params, key), params.signal);
    } catch (err) {
      return { text: '', failed: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Stream a chat completion as SSE events (for the user-facing OpenRouter
   * backend provider). Yields incremental text/reasoning deltas, then a final
   * `{ done, usage }`. On any failure yields a single `{ error }` and returns —
   * never throws. Not semaphore-gated (a streamed turn holds one connection).
   */
  public async *streamChat(params: GatewayChatParams): AsyncGenerator<OpenRouterStreamEvent> {
    const key = this._getApiKey();
    if (!key) {
      yield { error: 'No OpenRouter API key configured' };
      return;
    }
    if (!isAllowedHost(OPENROUTER_BASE_URL)) {
      yield { error: 'OpenRouter host not allowed' };
      return;
    }

    const timeoutMs = params.timeoutMs ?? 120_000;
    const abortScope = createAbortScope([params.signal], timeoutMs);
    let res: Response | undefined;
    try {
      try {
        abortScope.signal.throwIfAborted();
        res = await this._fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'HTTP-Referer': this._referer,
            'X-Title': this._appTitle,
          },
          body: JSON.stringify({
            model: params.model,
            // Explicit prompt-cache breakpoints on the stable prefix. The ReAct
            // loop re-sends the whole system prompt every round-trip, and on
            // Anthropic models nothing is cached without a breakpoint — so this
            // was full input price, N times per turn. No-op for models that cache
            // automatically. See src/services/PromptCache.ts.
            messages: applyCacheBreakpoints(params.messages, params.model),
            max_tokens: params.maxTokens ?? 2048,
            stream: true,
            // Reasoning effort — OpenRouter translates effort→token budget for
            // budget-based models (Anthropic/Gemini). Omitted when unset.
            ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
            ...(params.tools && params.tools.length ? { tools: params.tools, tool_choice: 'auto' } : {}),
          }),
          signal: abortScope.signal,
        });
      } catch (err) {
        yield { error: streamError(err) };
        return;
      }

      if (!res.ok || !res.body) {
        if (!res.ok) {
          const detail = redactSecrets(await safeText(res));
          yield { error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
        } else {
          yield { error: 'OpenRouter stream had no body' };
        }
        return;
      }

      const toolAcc = new ToolCallAccumulator();
      const toolIdentities = new Map<number, { id?: string; name?: string }>();
      let toolChars = 0;
      let completed = false;
      let finishReason: string | undefined;
      let model: string | undefined;
      const reasoningDetails: Record<string, unknown>[] = [];
      for await (const data of readServerSentData(res.body, abortScope.signal)) {
        abortScope.signal.throwIfAborted();
        if (data.trim() === '[DONE]') { completed = true; break; }
        let frame: unknown;
        try { frame = JSON.parse(data); }
        catch { throw new Error('OpenRouter returned malformed SSE data'); }
        if (!isRecord(frame)) { throw new Error('OpenRouter returned an invalid stream frame'); }
        if ((frame.error !== undefined && frame.error !== null)) { throw new Error(responseError(frame.error)); }
        if (frame.model !== undefined) {
          if (typeof frame.model !== 'string' || !frame.model) { throw new Error('OpenRouter returned an invalid model'); }
          if (frame.model !== model) { model = frame.model; yield { model }; }
        }
        if (frame.choices !== undefined && !Array.isArray(frame.choices)) {
          throw new Error('OpenRouter returned invalid stream choices');
        }
        const choice = (frame.choices as unknown[] | undefined)?.[0];
        if (choice !== undefined && !isRecord(choice)) { throw new Error('OpenRouter returned an invalid stream choice'); }
        const delta = isRecord(choice) ? choice.delta : undefined;
        if ((delta !== undefined && delta !== null) && !isRecord(delta)) { throw new Error('OpenRouter returned an invalid stream delta'); }
        if (isRecord(delta)) {
          for (const field of ['content', 'reasoning']) {
            if ((delta[field] !== undefined && delta[field] !== null) && typeof delta[field] !== 'string') { throw new Error(`OpenRouter returned invalid ${field}`); }
          }
          const reasoning = visibleReasoning(delta);
          appendReasoningDetails(reasoningDetails, delta.reasoning_details);
          if (finishReason && (delta.content || reasoning || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) {
            throw new Error('OpenRouter returned content after its terminal response');
          }
          if (delta.content) { abortScope.signal.throwIfAborted(); yield { text: delta.content as string }; }
          if (reasoning) { abortScope.signal.throwIfAborted(); yield { reasoning }; }
          if (delta.tool_calls !== undefined) {
            const calls = validateToolDeltas(delta.tool_calls);
            toolChars += JSON.stringify(calls).length;
            if (toolChars > MAX_HTTP_FRAME_CHARS) { throw new Error('OpenRouter tool calls exceed the size limit'); }
            for (const call of calls) {
              const index = call.index ?? 0;
              const identity = toolIdentities.get(index) ?? {};
              if (call.id !== undefined) {
                if (!call.id || (identity.id !== undefined && identity.id !== call.id)) { throw new Error('OpenRouter changed a tool call identity'); }
                identity.id = call.id;
              }
              if (call.function?.name !== undefined) {
                if (!call.function.name || (identity.name !== undefined && identity.name !== call.function.name)) { throw new Error('OpenRouter changed a tool call name'); }
                identity.name = call.function.name;
              }
              toolIdentities.set(index, identity);
            }
            toolAcc.add(calls);
          }
        }
        if ((frame.usage !== undefined && frame.usage !== null)) {
          if (!isRecord(frame.usage)) { throw new Error('OpenRouter returned invalid usage'); }
          abortScope.signal.throwIfAborted();
          yield { usage: readOpenRouterUsage(frame.usage) };
          const costUsd = nonnegativeNumber(frame.usage.cost);
          if (costUsd !== undefined) { abortScope.signal.throwIfAborted(); yield { costUsd }; }
        }
        const terminal = isRecord(choice) ? choice.finish_reason : undefined;
        if ((terminal !== undefined && terminal !== null)) {
          if (typeof terminal !== 'string' || !['stop', 'length', 'tool_calls', 'content_filter', 'error'].includes(terminal)) {
            throw new Error('OpenRouter returned an invalid finish reason');
          }
          if (finishReason && finishReason !== terminal) { throw new Error('OpenRouter changed its finish reason'); }
          // The final usage frame legitimately repeats the same reason.
          finishReason = terminal;
        }
      }
      abortScope.signal.throwIfAborted();
      if (!completed) { throw new Error('OpenRouter stream ended before its completion marker'); }
      if (finishReason === 'error' || finishReason === 'content_filter') {
        throw new Error(`OpenRouter response ended with ${finishReason}`);
      }
      if (toolAcc.hasAny() && finishReason !== 'tool_calls') {
        throw new Error('OpenRouter tool calls did not finish completely');
      }
      if (finishReason === 'tool_calls' && !toolAcc.hasAny()) { throw new Error('OpenRouter completed tool calls without any calls'); }
      const ids = new Set<string>();
      for (const identity of toolIdentities.values()) {
        if (!identity.id || !identity.name || ids.has(identity.id)) { throw new Error('OpenRouter returned incomplete or duplicate tool identities'); }
        ids.add(identity.id);
      }
      const calls = toolAcc.finalize();
      if (calls.some(call => !['ok', 'empty'].includes(parseToolArgsChecked(call.arguments).status))) {
        throw new Error('OpenRouter returned incomplete or invalid tool arguments');
      }
      if (finishReason) { abortScope.signal.throwIfAborted(); yield { finishReason }; }
      // Like tool calls, replayable reasoning escapes only from a completed response.
      if (reasoningDetails.length) { abortScope.signal.throwIfAborted(); yield { reasoningDetails }; }
      // No proposals escape until the entire response has completed successfully.
      if (calls.length) { abortScope.signal.throwIfAborted(); yield { toolCalls: calls }; }
      abortScope.signal.throwIfAborted();
      yield { done: true };
    } catch (err) {
      yield { error: streamError(err) };
    } finally {
      abortScope.dispose();
      if (res?.body && !res.body.locked) { void res.body.cancel().catch(() => {}); }
    }
  }

  private async _doChatWithRetry(params: GatewayChatParams, key: string): Promise<OpenRouterCompletion> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 1024,
      stream: false,
    };

    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      const abortScope = createAbortScope([params.signal], timeoutMs);
      let res: Response | undefined;
      try {
        abortScope.signal.throwIfAborted();
        res = await this._fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'HTTP-Referer': this._referer,
            'X-Title': this._appTitle,
          },
          body: JSON.stringify(body),
          signal: abortScope.signal,
        });

        if (res.status === 429) {
          // Release the response before waiting; an unread body can keep the
          // connection alive even after the retry deadline has been disposed.
          void res.body?.cancel().catch(() => {});
          // Free-tier 20 rpm / daily cap. Back off and retry a couple of times.
          if (attempt < this._maxRetries) {
            await this._sleep(retryAfterMs(res.headers.get('retry-after'), attempt), abortScope.signal);
            continue;
          }
          return { text: '', failed: true, error: 'rate-limited (HTTP 429)' };
        }

        if (!res.ok) {
          const detail = redactSecrets(await safeText(res));
          console.warn(`[Mysti] OpenRouter chat → HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
          return { text: '', failed: true, error: `HTTP ${res.status}` };
        }

        const data: unknown = await res.json();
        abortScope.signal.throwIfAborted();
        if (!isRecord(data)) { throw new Error('OpenRouter returned an invalid response'); }
        if ((data.error !== undefined && data.error !== null)) { throw new Error(responseError(data.error)); }
        const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
        if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') {
          throw new Error('OpenRouter returned no completion text');
        }
        if ((choice.finish_reason !== undefined && choice.finish_reason !== null) && choice.finish_reason !== 'stop') {
          throw new Error(`OpenRouter response ended with ${String(choice.finish_reason)}`);
        }
        const usage = isRecord(data.usage) ? data.usage : {};
        const costUsd = nonnegativeNumber(usage.cost);
        return {
          text: choice.message.content,
          ...readOpenRouterUsage(usage),
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(typeof data.model === 'string' ? { model: data.model } : {}),
        };
      } catch (err) {
        const error = redactSecrets(err instanceof Error ? err.message : String(err));
        console.warn(`[Mysti] OpenRouter chat failed: ${error}`);
        return { text: '', failed: true, error };
      } finally {
        void res?.body?.cancel().catch(() => {});
        abortScope.dispose();
      }
    }
    return { text: '', failed: true, error: 'rate-limited (retries exhausted)' };
  }

  /**
   * Discover currently-available FREE models (`:free` suffix). Cached for
   * OPENROUTER_MODELS_TTL_MS. `toolsOnly` filters to tool-calling-capable models
   * (recommended for a coordinator that may need structured/tool output).
   */
  public async listFreeModels(opts: { toolsOnly?: boolean } = {}): Promise<OpenRouterModel[]> {
    const all = await this._fetchModels();
    const free = all.filter(m => m.free);
    return opts.toolsOnly ? free.filter(m => m.supportsTools) : free;
  }

  /**
   * The FULL OpenRouter catalog (free + paid), for the coordinator model picker.
   * Cached like listFreeModels. `toolsOnly` filters to tool-calling-capable
   * models (recommended for a coordinator that emits structured output).
   * Returns [] on failure — callers fall back to a curated list.
   */
  public async listAllModels(opts: { toolsOnly?: boolean } = {}): Promise<OpenRouterModel[]> {
    const all = await this._fetchModels();
    return opts.toolsOnly ? all.filter(m => m.supportsTools) : all;
  }

  /**
   * The default free model for the coordinator: the first tool-capable free
   * model discovered, else any free model, else the `openrouter/free` meta-router
   * (which auto-routes to whatever is up). Never a hardcoded id.
   */
  public async getDefaultFreeModel(): Promise<string> {
    try {
      const toolCapable = await this.listFreeModels({ toolsOnly: true });
      if (toolCapable.length > 0) {
        // Prefer larger context windows for a coordinator (more room for the DAG).
        toolCapable.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
        return toolCapable[0].id;
      }
      const anyFree = await this.listFreeModels();
      if (anyFree.length > 0) {
        return anyFree[0].id;
      }
    } catch {
      /* fall through to the meta-router */
    }
    return OPENROUTER_FREE_ROUTER;
  }

  private async _fetchModels(): Promise<OpenRouterModel[]> {
    const now = Date.now();
    if (this._modelCache && now - this._modelCache.fetchedAt < OPENROUTER_MODELS_TTL_MS) {
      return this._modelCache.models;
    }
    if (this._modelsInFlight) {
      return this._modelsInFlight;
    }
    this._modelsInFlight = (async () => {
      const abortScope = createAbortScope([], 30_000);
      let res: Response | undefined;
      try {
        const key = this._getApiKey();
        res = await this._fetch(`${OPENROUTER_BASE_URL}/models`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
            'HTTP-Referer': this._referer,
            'X-Title': this._appTitle,
          },
          signal: abortScope.signal,
        });
        if (!res.ok) {
          console.warn(`[Mysti] OpenRouter /models → HTTP ${res.status}`);
          return this._modelCache?.models ?? [];
        }
        const json = await res.json() as OpenRouterModelsResponse;
        const models = (json?.data ?? []).map(normalizeModel);
        this._modelCache = { models, fetchedAt: Date.now() };
        return models;
      } catch (err) {
        console.warn(`[Mysti] OpenRouter /models failed: ${err instanceof Error ? err.message : String(err)}`);
        return this._modelCache?.models ?? [];
      } finally {
        void res?.body?.cancel().catch(() => {});
        abortScope.dispose();
        this._modelsInFlight = null;
      }
    })();
    return this._modelsInFlight;
  }

  /** Concurrency semaphore — keeps in-flight requests under the free-tier cap. */
  private async _withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this._active >= this._maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this._waiters.indexOf(grant);
          if (index !== -1) { this._waiters.splice(index, 1); }
          reject(signal?.reason);
        };
        this._waiters.push(grant);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      this._active++;
    }
    try {
      // A queued request can be cancelled after its slot was granted but
      // before this continuation runs. The reserved slot still needs release.
      signal?.throwIfAborted();
      return await fn();
    } finally {
      const next = this._waiters.shift();
      if (next) {
        // Transfer ownership before waking the waiter. A new request must not
        // take the freed slot while the queued continuation is still pending.
        next();
      } else {
        this._active--;
      }
    }
  }
}

/** One SSE event from streamChat: an incremental delta, a usage report, done, or an error. */
export interface OpenRouterStreamEvent {
  text?: string;
  reasoning?: string;
  done?: boolean;
  model?: string;
  costUsd?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; cacheCreationIncluded?: boolean };
  error?: string;
  /** OpenAI finish_reason ('length' ⇒ max_tokens truncation). */
  finishReason?: string;
  /** Plan 19 P4: finalized native tool calls for this turn (emitted once). */
  toolCalls?: AccumulatedToolCall[];
  /**
   * The completed response's `reasoning_details`, in stream order (emitted once,
   * only after the completion marker). Opaque: callers replay them unmodified on
   * the assistant message of the next request and never display or edit them.
   */
  reasoningDetails?: Record<string, unknown>[];
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
    supported_parameters?: string[];
    /** Per-token USD prices as strings, e.g. { prompt: "0.000003", completion: "0.000015" }. */
    pricing?: { prompt?: string | number; completion?: string | number };
  }>;
}

function normalizeModel(m: NonNullable<OpenRouterModelsResponse['data']>[number]): OpenRouterModel {
  const id = String(m.id ?? '');
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  const hasPricing = Number.isFinite(prompt) && Number.isFinite(completion);
  // Free when the id is a `:free` variant, or the advertised price is all-zero.
  const free = id.endsWith(':free') || (hasPricing && prompt === 0 && completion === 0);
  return {
    id,
    name: m.name,
    contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
    supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
    free,
    ...(hasPricing ? { pricing: { prompt, completion } } : {}),
  };
}

/** Backoff in ms for a 429: honor Retry-After (seconds) when present, else exponential. */
/** Wait for a retry without retaining timers or abort listeners after Stop. */
function sleepWithAbort(
  ms: number,
  signal: AbortSignal,
  sleepImpl?: OpenRouterClientOptions['sleepImpl'],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const complete = () => { cleanup(); resolve(); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (sleepImpl) {
      try {
        // Observe late settlement even when an older injected implementation
        // ignores the signal, so cancellation never becomes an unhandled rejection.
        Promise.resolve(sleepImpl(ms, signal)).then(complete, fail);
      } catch (error) { fail(error); }
    } else {
      timer = setTimeout(complete, ms);
      timer.unref?.();
    }
  });
}

function retryAfterMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const secs = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, 30_000);
    }
  }
  return Math.min(500 * Math.pow(2, attempt), 8_000);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/** Strip any leaked Bearer/OpenRouter key before logging remote content. */
function redactSecrets(s: string): string {
  return s.replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-***').replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

/** Hosts the OpenRouter key may be sent to. */
function isAllowedHost(urlStr: string): boolean {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return h === 'openrouter.ai' || h.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/** OpenRouter reports normalized token totals, including cache subsets. */
function readOpenRouterUsage(usage: Record<string, unknown>): NonNullable<OpenRouterStreamEvent['usage']> {
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cache = readCacheTokens(usage);
  const includedCreation = nonnegativeNumber(details.cache_write_tokens);
  const cacheCreationTokens = includedCreation ?? cache.cacheCreationTokens;
  return {
    inputTokens: nonnegativeNumber(usage.prompt_tokens),
    outputTokens: nonnegativeNumber(usage.completion_tokens),
    ...cache,
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(includedCreation !== undefined ? { cacheCreationIncluded: true } : {}),
  };
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function responseError(value: unknown): string {
  const message = typeof value === 'string' ? value
    : isRecord(value) && typeof value.message === 'string' ? value.message : '';
  return message.trim() || 'OpenRouter response error';
}

function streamError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).trim() || 'OpenRouter request failed';
}

/** Display readable reasoning only; signed/encrypted replay needs a separate history contract. */
function visibleReasoning(delta: Record<string, unknown>): string {
  if ((delta.reasoning_details !== undefined && delta.reasoning_details !== null) && !Array.isArray(delta.reasoning_details)) {
    throw new Error('OpenRouter returned invalid reasoning details');
  }
  if (typeof delta.reasoning === 'string' && delta.reasoning) { return delta.reasoning; }
  return (delta.reasoning_details as unknown[] | undefined ?? []).map(detail => {
    if (!isRecord(detail)) { throw new Error('OpenRouter returned an invalid reasoning detail'); }
    const value = detail.type === 'reasoning.text' ? detail.text : detail.type === 'reasoning.summary' ? detail.summary : undefined;
    if ((value !== undefined && value !== null) && typeof value !== 'string') { throw new Error('OpenRouter returned invalid reasoning text'); }
    return typeof value === 'string' ? value : '';
  }).join('');
}

/**
 * Rebuild the response's reasoning_details from streamed deltas. Consecutive
 * fragments of the SAME text/summary block (same type and index) are joined into
 * the one block the non-streaming response would carry, keeping the first
 * signature/id/format seen — the merge OpenRouter's own AI SDK provider does.
 * Every other entry (reasoning.encrypted, unknown types) is kept verbatim and in
 * order: the docs require the sequence to match the model's output exactly.
 * https://openrouter.ai/docs/use-cases/reasoning-tokens#preserving-reasoning-blocks
 */
function appendReasoningDetails(out: Record<string, unknown>[], value: unknown): void {
  if (!Array.isArray(value)) { return; } // visibleReasoning already rejected non-arrays.
  for (const detail of value) {
    if (!isRecord(detail)) { throw new Error('OpenRouter returned an invalid reasoning detail'); }
    const field = detail.type === 'reasoning.text' ? 'text' : detail.type === 'reasoning.summary' ? 'summary' : undefined;
    const last = out[out.length - 1];
    if (field && last && last.type === detail.type && last.index === detail.index) {
      if (typeof (detail[field] ?? '') !== 'string') { throw new Error('OpenRouter returned invalid reasoning text'); }
      last[field] = String(last[field] ?? '') + String(detail[field] ?? '');
      for (const key of Object.keys(detail)) {
        if (key !== field && (last[key] === undefined || last[key] === null)) { last[key] = detail[key]; }
      }
      continue;
    }
    out.push(structuredClone(detail));
  }
}

function validateToolDeltas(value: unknown): ToolCallDelta[] {
  if (!Array.isArray(value)) { throw new Error('OpenRouter returned invalid tool calls'); }
  for (const call of value) {
    if (!isRecord(call) || (call.index !== undefined && (!Number.isInteger(call.index) || Number(call.index) < 0))
      || (call.id !== undefined && typeof call.id !== 'string')
      || (call.type !== undefined && call.type !== 'function')
      || (call.function !== undefined && (!isRecord(call.function)
        || (call.function.name !== undefined && typeof call.function.name !== 'string')
        || (call.function.arguments !== undefined && typeof call.function.arguments !== 'string')))) {
      throw new Error('OpenRouter returned an invalid tool call delta');
    }
  }
  return value as ToolCallDelta[];
}
