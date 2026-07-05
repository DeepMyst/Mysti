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

export interface GatewayChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GatewayChatParams {
  model: string;
  messages: GatewayChatMessage[];
  maxTokens?: number;
  /** Abort signal so callers can cancel a slow call. */
  signal?: AbortSignal;
  timeoutMs?: number;
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
    const signal = composeSignal(timeoutMs, params.signal);

    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 1024,
      stream: false,
    };

    try {
      const res = await fetch(`${this._baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
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

      return {
        text: typeof text === 'string' ? text : '',
        costUsd,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[Mysti] DeepMyst gateway chat failed: ${error}`);
      return { text: '', failed: true, error };
    }
  }
}

interface GatewayChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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

/** Compose the caller's signal with a timeout, leak-free (AbortSignal.any). */
function composeSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) { return timeout; }
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return AbortSignal.any([caller, timeout]);
  }
  return caller.aborted ? caller : timeout;
}
