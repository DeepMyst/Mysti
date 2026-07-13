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
  /** Injected sleep for tests (ms). */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class OpenRouterClient {
  private readonly _getApiKey: () => string | undefined;
  private readonly _maxConcurrent: number;
  private readonly _maxRetries: number;
  private readonly _appTitle: string;
  private readonly _referer: string;
  private readonly _fetch: typeof fetch;
  private readonly _sleep: (ms: number) => Promise<void>;

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
    this._sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
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
  public async chatCompletion(params: GatewayChatParams): Promise<GatewayCompletion> {
    const key = this._getApiKey();
    if (!key) {
      return { text: '', failed: true, error: 'No OpenRouter API key configured' };
    }
    if (!isAllowedHost(OPENROUTER_BASE_URL)) {
      // Defensive: OPENROUTER_BASE_URL is a constant, but never send the key off-host.
      return { text: '', failed: true, error: 'OpenRouter host not allowed' };
    }

    return this._withSlot(() => this._doChatWithRetry(params, key));
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
    let res: Response;
    try {
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
          messages: params.messages,
          max_tokens: params.maxTokens ?? 2048,
          stream: true,
          // Ask OpenRouter to emit a final usage frame (prompt/completion tokens).
          stream_options: { include_usage: true },
          // Reasoning effort — OpenRouter translates effort→token budget for
          // budget-based models (Anthropic/Gemini). Omitted when unset.
          ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
        }),
        signal: composeSignal(timeoutMs, params.signal),
      });
    } catch (err) {
      yield { error: err instanceof Error ? err.message : String(err) };
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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Truncation guard (mirrors DeepMystGatewayClient): if the body closes
    // cleanly having emitted text but WITHOUT [DONE] or any finish_reason, the
    // generation was cut short — surface a synthetic 'length' so the coordinator
    // loop continues rather than accepting the truncated text as the final answer.
    let sawText = false;
    let sawTerminal = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) {
            continue; // SSE comments (': OPENROUTER PROCESSING') and blank lines
          }
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            yield { done: true };
            return;
          }
          let json: OpenRouterStreamChunk & { error?: { message?: string } | string };
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          // In-band error frame (OpenRouter emits these mid-stream instead of an
          // HTTP status) — surface it so a failed generation isn't reported clean.
          if (json.error) {
            yield { error: typeof json.error === 'string' ? json.error : (json.error.message || 'OpenRouter stream error') };
            return;
          }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            sawText = true;
            yield { text: delta.content };
          }
          if (typeof delta?.reasoning === 'string' && delta.reasoning) {
            yield { reasoning: delta.reasoning };
          }
          if (json.usage) {
            yield { usage: { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens } };
          }
          const fr = json.choices?.[0]?.finish_reason;
          if (typeof fr === 'string' && fr) {
            sawTerminal = true;
            yield { finishReason: fr };
          }
        }
      }
    } catch (err) {
      yield { error: err instanceof Error ? err.message : String(err) };
      return;
    }
    // Clean close without [DONE] (which returns above) or a finish_reason: if we
    // streamed text, treat it as an incomplete generation, not a clean finish.
    if (sawText && !sawTerminal) {
      yield { finishReason: 'length' };
    }
    yield { done: true };
  }

  private async _doChatWithRetry(params: GatewayChatParams, key: string): Promise<GatewayCompletion> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 1024,
      stream: false,
    };

    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      try {
        const res = await this._fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'HTTP-Referer': this._referer,
            'X-Title': this._appTitle,
          },
          body: JSON.stringify(body),
          signal: composeSignal(timeoutMs, params.signal),
        });

        if (res.status === 429) {
          // Free-tier 20 rpm / daily cap. Back off and retry a couple of times.
          if (attempt < this._maxRetries) {
            await this._sleep(retryAfterMs(res.headers.get('retry-after'), attempt));
            continue;
          }
          return { text: '', failed: true, error: 'rate-limited (HTTP 429)' };
        }

        if (!res.ok) {
          const detail = redactSecrets(await safeText(res));
          console.warn(`[Mysti] OpenRouter chat → HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
          return { text: '', failed: true, error: `HTTP ${res.status}` };
        }

        const data = await res.json() as OpenRouterChatResponse;
        const text = data?.choices?.[0]?.message?.content ?? '';
        const usage = data?.usage;
        return {
          text: typeof text === 'string' ? text : '',
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          // Free models are free; no cost header to reconcile.
          costUsd: 0,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(`[Mysti] OpenRouter chat failed: ${error}`);
        return { text: '', failed: true, error };
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
    const free = all.filter(m => m.id.endsWith(':free'));
    return opts.toolsOnly ? free.filter(m => m.supportsTools) : free;
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
      try {
        const key = this._getApiKey();
        const res = await this._fetch(`${OPENROUTER_BASE_URL}/models`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
            'HTTP-Referer': this._referer,
            'X-Title': this._appTitle,
          },
          signal: composeSignal(30_000),
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
        this._modelsInFlight = null;
      }
    })();
    return this._modelsInFlight;
  }

  /** Concurrency semaphore — keeps in-flight requests under the free-tier cap. */
  private async _withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this._active >= this._maxConcurrent) {
      await new Promise<void>(resolve => this._waiters.push(resolve));
    }
    this._active++;
    try {
      return await fn();
    } finally {
      this._active--;
      const next = this._waiters.shift();
      if (next) {
        next();
      }
    }
  }
}

/** One SSE event from streamChat: an incremental delta, a usage report, done, or an error. */
export interface OpenRouterStreamEvent {
  text?: string;
  reasoning?: string;
  done?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
  /** OpenAI finish_reason ('length' ⇒ max_tokens truncation). */
  finishReason?: string;
}

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenRouterStreamChunk {
  choices?: Array<{ delta?: { content?: string; reasoning?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
    supported_parameters?: string[];
  }>;
}

function normalizeModel(m: NonNullable<OpenRouterModelsResponse['data']>[number]): OpenRouterModel {
  return {
    id: String(m.id ?? ''),
    name: m.name,
    contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
    supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
  };
}

/** Backoff in ms for a 429: honor Retry-After (seconds) when present, else exponential. */
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

/** Compose a timeout with an optional caller signal, leak-free. */
function composeSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) {
    return timeout;
  }
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return AbortSignal.any([caller, timeout]);
  }
  return caller.aborted ? caller : timeout;
}
