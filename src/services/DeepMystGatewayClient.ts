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
import { ToolCallAccumulator, parseToolArgsChecked, type AccumulatedToolCall, type ToolCallDelta } from '../utils/toolCallAccumulator';
import { MAX_HTTP_FRAME_CHARS, readServerSentData } from '../utils/httpStream';

export interface GatewayChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Plan 19 P4: an assistant turn that requested native tool calls (OpenAI shape). */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Plan 19 P4: a tool-result message — which tool_call id it answers. */
  tool_call_id?: string;
  /** Plan 19 P4: the tool name on a tool-result message (some providers require it). */
  name?: string;
  /** Opaque reasoning from this assistant turn, replayed unmodified (OpenRouter `reasoning_details`). */
  reasoning_details?: Record<string, unknown>[];
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
      if (costUsd !== undefined) { abortScope.signal.throwIfAborted(); yield { costUsd }; }

      const toolAcc = new ToolCallAccumulator();
      const identities = new Map<number, { id?: string; name?: string }>();
      let toolChars = 0;
      let completed = false;
      let finishReason: string | undefined;
      let sentModel = false;
      for await (const data of readServerSentData(res.body, abortScope.signal, armIdle)) {
        abortScope.signal.throwIfAborted();
        if (data.trim() === '[DONE]') { completed = true; break; }
        const parsed = parseSseData(data);
        if (parsed.error !== undefined) { throw new Error(parsed.error); }
        if (finishReason && (parsed.text || parsed.reasoning || parsed.toolCallDeltas?.length)) {
          throw new Error('DeepMyst gateway returned content after its terminal response');
        }
        if (parsed.model && !sentModel) { sentModel = true; abortScope.signal.throwIfAborted(); yield { model: parsed.model }; }
        if (parsed.text) { abortScope.signal.throwIfAborted(); yield { text: parsed.text }; }
        if (parsed.reasoning) { abortScope.signal.throwIfAborted(); yield { reasoning: parsed.reasoning }; }
        if (parsed.toolCallDeltas) {
          toolChars += JSON.stringify(parsed.toolCallDeltas).length;
          if (toolChars > MAX_HTTP_FRAME_CHARS) { throw new Error('DeepMyst gateway tool calls exceed the size limit'); }
          for (const call of parsed.toolCallDeltas) {
            const index = call.index ?? 0;
            const identity = identities.get(index) ?? {};
            if (call.id !== undefined) {
              if (!call.id || (identity.id !== undefined && identity.id !== call.id)) {
                throw new Error('DeepMyst gateway changed a tool call identity');
              }
              identity.id = call.id;
            }
            if (call.function?.name !== undefined) {
              if (!call.function.name || (identity.name !== undefined && identity.name !== call.function.name)) {
                throw new Error('DeepMyst gateway changed a tool call name');
              }
              identity.name = call.function.name;
            }
            identities.set(index, identity);
          }
          toolAcc.add(parsed.toolCallDeltas);
        }
        if (parsed.usage) { abortScope.signal.throwIfAborted(); yield { usage: parsed.usage }; }
        if (parsed.finishReason) {
          if (finishReason && finishReason !== parsed.finishReason) { throw new Error('DeepMyst gateway changed its finish reason'); }
          // Usage-only frames may repeat the same terminal reason.
          finishReason = parsed.finishReason;
        }
      }
      abortScope.signal.throwIfAborted();
      if (!completed) { throw new Error('DeepMyst gateway stream ended before its completion marker'); }
      if (finishReason === 'error' || finishReason === 'content_filter') {
        throw new Error(`DeepMyst gateway response ended with ${finishReason}`);
      }
      if (toolAcc.hasAny() && finishReason !== 'tool_calls') {
        throw new Error('DeepMyst gateway tool calls did not finish completely');
      }
      if (finishReason === 'tool_calls' && !toolAcc.hasAny()) { throw new Error('DeepMyst gateway completed tool calls without any calls'); }
      const ids = new Set<string>();
      for (const identity of identities.values()) {
        if (!identity.id || !identity.name || ids.has(identity.id)) {
          throw new Error('DeepMyst gateway returned incomplete or duplicate tool identities');
        }
        ids.add(identity.id);
      }
      const calls = toolAcc.finalize();
      if (calls.some(call => !['ok', 'empty'].includes(parseToolArgsChecked(call.arguments).status))) {
        throw new Error('DeepMyst gateway returned incomplete or invalid tool arguments');
      }
      if (finishReason) { abortScope.signal.throwIfAborted(); yield { finishReason }; }
      // The complete batch is validated before any proposal escapes. EOF,
      // truncation or an in-band error must never turn partial JSON into {}.
      if (calls.length) { abortScope.signal.throwIfAborted(); yield { toolCalls: calls }; }
      abortScope.signal.throwIfAborted();
      yield { done: true };
    } catch (err) {
      yield { error: errMessage(err) };
    } finally {
      disarmIdle();
      abortScope.dispose();
      if (res?.body && !res.body.locked) { void res.body.cancel().catch(() => {}); }
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
  let json: unknown;
  try { json = JSON.parse(data); } catch { throw new Error('DeepMyst gateway returned malformed SSE data'); }
  if (!isRecord(json)) { throw new Error('DeepMyst gateway returned an invalid stream frame'); }
  if (json.error !== undefined && json.error !== null) {
    const error = json.error;
    const msg = (typeof error === 'string' ? error : isRecord(error) && typeof error.message === 'string' ? error.message : '').trim()
      || 'DeepMyst gateway stream error';
    // Preserve status codes for the coordinator's existing retry classifier.
    const code = isRecord(error) ? error.code : undefined;
    return { error: typeof code === 'string' || typeof code === 'number' ? `${msg} (${code})` : msg };
  }
  if (json.choices !== undefined && !Array.isArray(json.choices)) { throw new Error('DeepMyst gateway returned invalid stream choices'); }
  const choice = (json.choices as unknown[] | undefined)?.[0];
  if (choice !== undefined && !isRecord(choice)) { throw new Error('DeepMyst gateway returned an invalid stream choice'); }
  const delta = isRecord(choice) ? choice.delta : undefined;
  if (delta !== undefined && delta !== null && !isRecord(delta)) { throw new Error('DeepMyst gateway returned an invalid stream delta'); }
  const out: GatewayStreamEvent = {};
  if (json.model !== undefined) {
    if (typeof json.model !== 'string' || !json.model) { throw new Error('DeepMyst gateway returned an invalid model'); }
    out.model = json.model;
  }
  if (isRecord(delta)) {
    for (const field of ['content', 'reasoning']) {
      if (delta[field] !== undefined && delta[field] !== null && typeof delta[field] !== 'string') {
        throw new Error(`DeepMyst gateway returned invalid ${field}`);
      }
    }
    if (delta.content) { out.text = delta.content as string; }
    if (delta.reasoning) { out.reasoning = delta.reasoning as string; }
    if (delta.tool_calls !== undefined) { out.toolCallDeltas = validateToolDeltas(delta.tool_calls); }
  }
  if (json.usage !== undefined && json.usage !== null) {
    if (!isRecord(json.usage)) { throw new Error('DeepMyst gateway returned invalid usage'); }
    // cached_tokens is a subset of prompt_tokens, never added to it.
    out.usage = {
      inputTokens: nonnegativeNumber(json.usage.prompt_tokens),
      outputTokens: nonnegativeNumber(json.usage.completion_tokens),
      ...readCacheTokens(json.usage),
    };
  }
  const terminal = isRecord(choice) ? choice.finish_reason : undefined;
  if (terminal !== undefined && terminal !== null) {
    if (typeof terminal !== 'string' || !['stop', 'length', 'tool_calls', 'content_filter', 'error'].includes(terminal)) {
      throw new Error('DeepMyst gateway returned an invalid finish reason');
    }
    out.finishReason = terminal;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validateToolDeltas(value: unknown): ToolCallDelta[] {
  if (!Array.isArray(value)) { throw new Error('DeepMyst gateway returned invalid tool calls'); }
  for (const call of value) {
    if (!isRecord(call) || (call.index !== undefined && (!Number.isInteger(call.index) || Number(call.index) < 0))
      || (call.id !== undefined && typeof call.id !== 'string')
      || (call.type !== undefined && call.type !== 'function')
      || (call.function !== undefined && (!isRecord(call.function)
        || (call.function.name !== undefined && typeof call.function.name !== 'string')
        || (call.function.arguments !== undefined && typeof call.function.arguments !== 'string')))) {
      throw new Error('DeepMyst gateway returned an invalid tool call delta');
    }
  }
  return value as ToolCallDelta[];
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
  const base = (err instanceof Error ? err.message : String(err)).trim() || 'DeepMyst gateway stream error';
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
