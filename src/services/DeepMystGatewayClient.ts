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
 * DeepMystGatewayClient (Plan 08 — smart compaction).
 *
 * A thin client for DeepMyst's OpenAI-compatible LLM gateway
 * (`https://gateway.v2.deepmyst.com/v1/chat/completions`). This is a DIFFERENT
 * host from the MCP/REST API in DeepMystClient (`api.v2.deepmyst.com`); the same
 * `dm_` key authenticates both.
 *
 * Used by the smart compactor to run cheap-model summarization + retrieval
 * scoring. The gateway returns `X-DeepMyst-Cost-USD` headers, giving us the real
 * billed cost of each call for the savings ledger.
 *
 * Notes (confirmed from the connections-hub repo):
 *  - Use `/v1/chat/completions` (OpenAI shape) — NOT `/anthropic/v1/messages`,
 *    which needs internal-service headers a bare `dm_` key lacks.
 *  - `-optimize`/`-auto` model suffixes are accepted but currently no-ops; we
 *    pass an explicit cheap model and don't rely on them.
 *  - `extra_body` / gateway-controlled fields are deny-listed; send a plain body.
 */

import type { GatewayCompletion } from '../types';
import { applyCacheBreakpoints, readCacheTokens } from './PromptCache';
import { createAbortScope } from '../utils/abortScope';
import { ToolCallAccumulator, type AccumulatedToolCall, type ToolCallDelta } from '../utils/toolCallAccumulator';

export interface GatewayChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Plan 19 P4: an assistant turn that requested native tool calls (OpenAI shape). */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Plan 19 P4: a tool-result message — which tool_call id it answers. */
  tool_call_id?: string;
  /** Plan 19 P4: the tool name on a tool-result message (some providers require it). */
  name?: string;
}

/** One streamed delta from the gateway (same shape as OpenRouterStreamEvent). */
export interface GatewayStreamEvent {
  text?: string;
  reasoning?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  done?: boolean;
  error?: string;
  /**
   * The concrete model the gateway actually resolved to (present when a router
   * model like `openrouter/free` picks a real model). Lets the caller attribute
   * the answer to the model that produced it, not the requested router id.
   */
  model?: string;
  /**
   * OpenAI finish_reason when the stream reports one ('stop' | 'length' | …).
   * 'length' means max_tokens cut the answer mid-sentence — the caller can
   * auto-continue instead of presenting a truncated reply as complete.
   */
  finishReason?: string;
  /** Real billed cost (X-DeepMyst-Cost-USD header), when the gateway reports it. */
  costUsd?: number;
  /** Plan 19 P4: raw streamed tool_call deltas (accumulated by streamChat, not surfaced). */
  toolCallDeltas?: ToolCallDelta[];
  /** Plan 19 P4: the finalized native tool calls for this turn (emitted once). */
  toolCalls?: AccumulatedToolCall[];
}

export interface GatewayChatParams {
  model: string;
  messages: GatewayChatMessage[];
  maxTokens?: number;
  /**
   * OpenAI-/OpenRouter-style reasoning effort. Emitted as a `reasoning: { effort }`
   * body field (OpenRouter translates it to a token budget for budget-based
   * models). Undefined ⇒ omit the field entirely.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Abort signal so callers can cancel a slow call. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Plan 19 P4: OpenAI-style function tools; when present the model may emit tool_calls. */
  tools?: unknown[];
}

export class DeepMystGatewayClient {
  /**
   * @param _getApiKey returns the current `dm_` key (or undefined when signed out)
   * @param _getGatewayUrl returns the configured gateway base URL
   */
  constructor(
    private readonly _getApiKey: () => string | undefined,
    private readonly _getGatewayUrl: () => string,
  ) {}

  /** Gateway base URL with any trailing slash trimmed. */
  private _baseUrl(): string {
    return this._getGatewayUrl().replace(/\/+$/, '');
  }

  /**
   * Run a chat completion through the gateway. Never throws — on any failure
   * (signed out, unreachable, non-2xx, malformed body) it returns
   * `{ text: '', failed: true, error }` so the caller can fall back.
   */
  async chatCompletion(params: GatewayChatParams): Promise<GatewayCompletion> {
    const key = this._getApiKey();
    if (!key) {
      return { text: '', failed: true, error: 'Not signed in to DeepMyst' };
    }

    // Never attach the dm_ Bearer key to a non-DeepMyst host. The gateway URL
    // comes from a setting that a workspace could override, so an allowlist
    // prevents a malicious .vscode/settings.json from exfiltrating the key.
    if (!isAllowedHost(this._baseUrl())) {
      console.warn('[Mysti] DeepMyst gateway: refusing to send key to non-allowlisted host');
      return { text: '', failed: true, error: 'gateway host not allowed' };
    }

    const timeoutMs = params.timeoutMs ?? 60_000;
    const abortScope = createAbortScope([params.signal], timeoutMs);

    const body = {
      model: params.model,
      messages: applyCacheBreakpoints(params.messages, params.model),
      max_tokens: params.maxTokens ?? 1024,
      stream: false,
    };

    try {
      abortScope.signal.throwIfAborted();
      const res = await fetch(`${this._baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: abortScope.signal,
      });

      if (!res.ok) {
        const detail = redactSecrets(await safeText(res));
        console.warn(`[Mysti] DeepMyst gateway chat → HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        return { text: '', failed: true, error: `HTTP ${res.status}` };
      }

      const costUsd = parseFloatHeader(res.headers.get('x-deepmyst-cost-usd'));
      const data = await res.json() as GatewayChatResponse;
      const text = data?.choices?.[0]?.message?.content ?? '';
      const usage = data?.usage;
      const cacheTokens = readCacheTokens(usage);

      return {
        text: typeof text === 'string' ? text : '',
        costUsd,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        ...cacheTokens,
        model: typeof data?.model === 'string' ? data.model : undefined,
      };
    } catch (err) {
      const error = errMessage(err);
      console.warn(`[Mysti] DeepMyst gateway chat failed: ${error}`);
      return { text: '', failed: true, error };
    } finally {
      abortScope.dispose();
    }
  }

  /**
   * Stream a chat completion over the gateway (OpenAI SSE). Powers the Mysti
   * agent's token-by-token answer + inline delegation loop. Yields text/reasoning/
   * usage/done/error. Same host-allowlist protection as chatCompletion.
   */
  public async *streamChat(params: GatewayChatParams): AsyncGenerator<GatewayStreamEvent> {
    const key = this._getApiKey();
    if (!key) {
      yield { error: 'Not signed in to DeepMyst' };
      return;
    }
    if (!isAllowedHost(this._baseUrl())) {
      yield { error: 'gateway host not allowed' };
      return;
    }

    // `timeoutMs` here is an INTER-CHUNK IDLE ceiling, NOT a total-stream
    // deadline: a slow-but-alive free model that keeps emitting tokens must
    // never be killed mid-generation. We arm a watchdog before the request and
    // RESET it on every chunk read; only a genuinely stalled stream (no bytes
    // for `timeoutMs`) aborts. A caller-provided signal is still honored.
    const timeoutMs = params.timeoutMs ?? 120_000;
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleTimer) { clearTimeout(idleTimer); }
      idleTimer = setTimeout(() => idle.abort(new Error(`gateway stream idle for ${timeoutMs}ms`)), timeoutMs);
    };
    const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };

    const abortScope = createAbortScope([params.signal, idle.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let res: Response | undefined;
    try {
      armIdle();
      try {
        abortScope.signal.throwIfAborted();
        res = await fetch(`${this._baseUrl()}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: params.model,
            // Explicit prompt-cache breakpoints on the stable prefix — the ReAct
            // loop re-sends the system prompt on every round-trip and Anthropic
            // models cache nothing without one. See src/services/PromptCache.ts.
            messages: applyCacheBreakpoints(params.messages, params.model),
            max_tokens: params.maxTokens ?? 2048,
            stream: true,
            stream_options: { include_usage: true },
            ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
            ...(params.tools && params.tools.length ? { tools: params.tools, tool_choice: 'auto' } : {}),
          }),
          signal: abortScope.signal,
        });
      } catch (err) {
        disarmIdle();
        yield { error: errMessage(err) };
        return;
      }

      if (!res.ok || !res.body) {
        if (!res.ok) {
          const detail = redactSecrets(await safeText(res));
          yield { error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
        } else {
          yield { error: 'DeepMyst stream had no body' };
        }
        return;
      }

      // Real billed cost (P0.8): the gateway sets X-DeepMyst-Cost-USD on the
      // response head when it can price the call — surface it when present.
      const costUsd = parseFloatHeader(res.headers.get('x-deepmyst-cost-usd'));
      if (costUsd !== undefined) { yield { costUsd }; }

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sentModel = false;
      // Truncation guard: a clean SSE close that emitted text but NEVER sent
      // [DONE] or a finish_reason (e.g. a Render worker recycle / early generator
      // end) is almost certainly a cut-off answer, not a complete one.
      let sawText = false;
      let sawTerminal = false; // observed [DONE] or any finish_reason
      // Plan 19 P4: accumulate native tool_call deltas; emit once at the boundary.
      const toolAcc = new ToolCallAccumulator();
      let emittedTools = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { break; }
          armIdle(); // a chunk arrived — reset the idle watchdog (never kill a live stream)
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) { continue; }
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              if (!emittedTools && toolAcc.hasAny()) { emittedTools = true; yield { toolCalls: toolAcc.finalize() }; }
              yield { done: true };
              return;
            }
            const parsed = parseSseData(data);
            if (parsed.error) { yield { error: parsed.error }; return; }
            // Surface the concrete model the router resolved to, once.
            if (parsed.model && !sentModel) { sentModel = true; yield { model: parsed.model }; }
            if (parsed.text) { sawText = true; yield { text: parsed.text }; }
            if (parsed.reasoning) { yield { reasoning: parsed.reasoning }; }
            if (parsed.toolCallDeltas) { toolAcc.add(parsed.toolCallDeltas); }
            if (parsed.usage) { yield { usage: parsed.usage }; }
            if (parsed.finishReason) {
              sawTerminal = true;
              if (parsed.finishReason === 'tool_calls' && !emittedTools && toolAcc.hasAny()) { emittedTools = true; yield { toolCalls: toolAcc.finalize() }; }
              yield { finishReason: parsed.finishReason };
            }
          }
        }
        // Flush a final data frame that arrived without a trailing newline (abrupt
        // close without [DONE]) so its last delta isn't silently dropped.
        const tail = buffer.trim();
        if (tail.startsWith('data:')) {
          const data = tail.slice(5).trim();
          if (data === '[DONE]') {
            sawTerminal = true;
          } else if (data) {
            const parsed = parseSseData(data);
            if (parsed.error) { yield { error: parsed.error }; return; }
            // Mirror the main loop (review [20]): an abrupt close can carry the
            // final usage/finish_reason/reasoning in this frame — don't drop them.
            if (parsed.model && !sentModel) { sentModel = true; yield { model: parsed.model }; }
            if (parsed.reasoning) { yield { reasoning: parsed.reasoning }; }
            if (parsed.text) { sawText = true; yield { text: parsed.text }; }
            if (parsed.toolCallDeltas) { toolAcc.add(parsed.toolCallDeltas); }
            if (parsed.usage) { yield { usage: parsed.usage }; }
            if (parsed.finishReason) { sawTerminal = true; yield { finishReason: parsed.finishReason }; }
          }
        }
      } catch (err) {
        yield { error: errMessage(err) };
        return;
      }
      // Clean close with text but no [DONE]/finish_reason ⇒ likely truncated: flag
      // 'length' so the consumer auto-continues rather than accepting the partial
      // reply as final. No text at all ⇒ nothing to continue (keep prior behavior).
      if (!emittedTools && toolAcc.hasAny()) { yield { toolCalls: toolAcc.finalize() }; }
      if (sawText && !sawTerminal) { yield { finishReason: 'length' }; }
      yield { done: true };
    } finally {
      disarmIdle();
      abortScope.dispose();
      if (reader) {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* already released */ }
      } else if (res?.body) {
        void res.body.cancel().catch(() => {});
      }
    }
  }
}

/**
 * Parse one OpenAI-style SSE `data:` payload into a normalized event. Surfaces
 * in-band error frames (`data: {"error": ...}`) which some gateways/proxies emit
 * mid-stream instead of an HTTP status — otherwise a failed generation would be
 * silently reported as complete.
 */
function parseSseData(data: string): GatewayStreamEvent {
  let json: {
    error?: { message?: string; code?: number | string; type?: string } | string;
    model?: string;
    choices?: Array<{ delta?: { content?: string; reasoning?: string; tool_calls?: ToolCallDelta[] } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      cache_creation_input_tokens?: number;
    };
  };
  try { json = JSON.parse(data); } catch { return {}; }
  if (json.error) {
    if (typeof json.error === 'string') { return { error: json.error }; }
    const msg = json.error.message || 'gateway stream error';
    // Preserve the numeric status code (some providers put the human phrase in
    // `message` and the 429/5xx code in `code`) so digit-based retry matching
    // still fires when the message alone is code-less (e.g. "Too Many Requests").
    const code = json.error.code;
    return { error: code !== undefined && code !== null ? `${msg} (${code})` : msg };
  }
  const choice = (json.choices?.[0] ?? {}) as { delta?: { content?: string; reasoning?: string; tool_calls?: ToolCallDelta[] }; finish_reason?: string | null };
  const delta = choice.delta;
  const out: GatewayStreamEvent = {};
  if (typeof json.model === 'string' && json.model) { out.model = json.model; }
  if (delta?.content) { out.text = delta.content; }
  if (typeof delta?.reasoning === 'string' && delta.reasoning) { out.reasoning = delta.reasoning; }
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) { out.toolCallDeltas = delta.tool_calls; }
  if (json.usage) {
    // cached_tokens is a SUBSET of prompt_tokens — reported alongside, never
    // summed into it. Unread before this, so coordinator cache hits were
    // invisible to the ledger, the savings chip and the warmth decision.
    out.usage = {
      inputTokens: json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
      ...readCacheTokens(json.usage),
    };
  }
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) { out.finishReason = choice.finish_reason; }
  return out;
}

interface GatewayChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number;
  };
  model?: string;
}

/**
 * Extract a matchable error string from a thrown value. Node's native `fetch`
 * (undici) collapses ALL transport failures to `err.message === 'fetch failed'`
 * (or `'terminated'` mid-stream) and hides the real code (ECONNRESET / ENOTFOUND
 * / ECONNREFUSED / EAI_AGAIN …) in `err.cause`. Keeping only `err.message` makes
 * those undistinguishable from a hard failure, so we append the cause's code/
 * message — restoring the transient signal the retry classifier looks for.
 */
function errMessage(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const extra = cause?.code || cause?.message;
  return extra && !base.includes(String(extra)) ? `${base}: ${extra}` : base;
}

function parseFloatHeader(v: string | null): number | undefined {
  if (!v) { return undefined; }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

/** Strip any leaked `dm_` key or Bearer token before logging remote content. */
function redactSecrets(s: string): string {
  return s.replace(/dm_[A-Za-z0-9_-]+/g, 'dm_***').replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

/** Hosts the dm_ Bearer key may be sent to: DeepMyst, or localhost for dev. */
function isAllowedHost(urlStr: string): boolean {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return h === 'deepmyst.com' || h.endsWith('.deepmyst.com') || h === 'localhost' || h === '127.0.0.1';
  } catch {
    return false;
  }
}
