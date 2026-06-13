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
 * DeepMyst API client (Plan 04 — DeepMyst-brokered MCP connections).
 *
 * Mysti authenticates to DeepMyst with a machine-to-machine API key (the
 * `dm_` prefix) that the user mints from the DeepMyst web dashboard after
 * signing in with Clerk. The key is sent as `Authorization: Bearer dm_...`.
 * DeepMyst holds all the third-party connection credentials (GitHub, Slack,
 * ...), so nothing sensitive lives locally — the local backend CLIs only ever
 * see the DeepMyst MCP endpoint + this key.
 *
 * This client is intentionally thin: a key/URL accessor pair injected by
 * DeepMystAuthManager, plus the handful of GET calls the connections UI needs.
 * The MCP traffic itself does NOT flow through this client — it flows from each
 * backend CLI directly to `getMcpEndpointUrl(slug)` (written into the CLI's own
 * MCP config), so the agents talk to DeepMyst without round-tripping Mysti.
 */

/** A DeepMyst API key always starts with this prefix (machine-to-machine). */
export const DEEPMYST_KEY_PREFIX = 'dm_';

/** Default endpoints — overridable via the mysti.deepmyst.* settings. */
export const DEEPMYST_DEFAULT_API_URL = 'https://api.deepmyst.com';
export const DEEPMYST_DEFAULT_WEB_URL = 'https://app.deepmyst.com';

/** Metadata for a DeepMyst built-in MCP server (Corporate Knowledge, Org Data, …). */
export interface DeepMystBuiltinMcp {
  name: string;
  title?: string;
  description?: string;
}

/** A DeepMyst agent exposed as an MCP endpoint at /api/v1/mcp/{slug}. */
export interface DeepMystAgent {
  slug: string;
  name: string;
  description?: string;
}

/** A connected data source / integration the user set up in DeepMyst. */
export interface DeepMystConnection {
  id: string;
  name: string;
  type?: string;
  status?: string;
}

/** Result of a best-effort list call: data plus whether the endpoint exists yet. */
export interface DeepMystListResult<T> {
  items: T[];
  /** false when DeepMyst returned 404 (endpoint not deployed) so the UI can say so. */
  available: boolean;
}

export interface DeepMystKeyValidation {
  valid: boolean;
  /** HTTP status of the probe (0 when the request never reached the server). */
  status: number;
  error?: string;
}

/**
 * Returns true for a syntactically plausible DeepMyst key. This is a cheap
 * client-side guard only — real validity is confirmed by {@link DeepMystClient.validateKey}.
 */
export function isPlausibleDeepMystKey(key: string | undefined | null): key is string {
  return typeof key === 'string' && key.startsWith(DEEPMYST_KEY_PREFIX) && key.trim().length >= DEEPMYST_KEY_PREFIX.length + 8;
}

export class DeepMystClient {
  /**
   * @param _getApiKey returns the current `dm_` key (or undefined when signed out)
   * @param _getApiUrl returns the configured API base URL (no trailing slash required)
   */
  constructor(
    private readonly _getApiKey: () => string | undefined,
    private readonly _getApiUrl: () => string,
  ) {}

  /** Base API URL with any trailing slash trimmed. */
  private _baseUrl(): string {
    return this._getApiUrl().replace(/\/+$/, '');
  }

  /** Authorization headers for an authenticated request, or null when signed out. */
  private _authHeaders(): Record<string, string> | null {
    const key = this._getApiKey();
    if (!key) {
      return null;
    }
    return { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  }

  /**
   * The MCP JSON-RPC endpoint URL for a DeepMyst agent (or built-in). Written
   * verbatim into each backend CLI's MCP config; the CLI sends the same
   * `Authorization: Bearer dm_...` header so DeepMyst can scope the tools to
   * this user's connections.
   */
  getMcpEndpointUrl(slug: string): string {
    return `${this._baseUrl()}/api/v1/mcp/${encodeURIComponent(slug)}`;
  }

  /** Built-in MCP server endpoint URL (Corporate Knowledge, Org Data, …). */
  getBuiltinMcpEndpointUrl(name: string): string {
    return `${this._baseUrl()}/api/v1/mcp/builtin/${encodeURIComponent(name)}`;
  }

  /**
   * Verify a candidate key by hitting a lightweight authenticated GET
   * (the built-in MCP list). 200 → valid; 401/403 → invalid; anything else or
   * a network error → not-valid-but-reason-recorded (so the UI can distinguish
   * "wrong key" from "DeepMyst unreachable"). Never throws.
   *
   * Pass a candidate key to validate it before storing; omit to validate the
   * currently-stored key.
   */
  async validateKey(candidate?: string, timeoutMs = 10000): Promise<DeepMystKeyValidation> {
    const key = candidate ?? this._getApiKey();
    if (!isPlausibleDeepMystKey(key)) {
      return { valid: false, status: 0, error: `Key must start with "${DEEPMYST_KEY_PREFIX}".` };
    }
    try {
      const res = await fetch(`${this._baseUrl()}/api/v1/mcp/builtin`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        return { valid: true, status: res.status };
      }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, status: res.status, error: 'DeepMyst rejected this key (unauthorized).' };
      }
      return { valid: false, status: res.status, error: `DeepMyst returned HTTP ${res.status}.` };
    } catch (err) {
      return { valid: false, status: 0, error: `Could not reach DeepMyst: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** List the platform built-in MCP servers. Returns [] on any failure. */
  async listBuiltinMcps(timeoutMs = 10000): Promise<DeepMystBuiltinMcp[]> {
    const headers = this._authHeaders();
    if (!headers) {
      return [];
    }
    try {
      const res = await fetch(`${this._baseUrl()}/api/v1/mcp/builtin`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return [];
      }
      const data = await res.json() as unknown;
      return this._coerceBuiltins(data);
    } catch {
      return [];
    }
  }

  /**
   * List the user's DeepMyst agents (each exposes an MCP endpoint at
   * /api/v1/mcp/{slug}). available=false when the endpoint 404s (not deployed).
   */
  async listAgents(timeoutMs = 10000): Promise<DeepMystListResult<DeepMystAgent>> {
    return this._getList('/api/v1/agents', (o) => {
      const slug = typeof o.slug === 'string' ? o.slug : '';
      if (!slug) { return null; }
      return {
        slug,
        name: typeof o.name === 'string' ? o.name : slug,
        description: typeof o.description === 'string' ? o.description : undefined,
      };
    }, timeoutMs);
  }

  /**
   * List the user's connected data sources / integrations (the "connections").
   * available=false when the endpoint 404s.
   */
  async listConnections(timeoutMs = 10000): Promise<DeepMystListResult<DeepMystConnection>> {
    return this._getList('/api/v1/datasources', (o) => {
      const id = typeof o.id === 'string' ? o.id : (typeof o.id === 'number' ? String(o.id) : '');
      if (!id) { return null; }
      return {
        id,
        name: typeof o.name === 'string' ? o.name : id,
        type: typeof o.type === 'string' ? o.type : (typeof o.source_type === 'string' ? o.source_type : undefined),
        status: typeof o.status === 'string' ? o.status : undefined,
      };
    }, timeoutMs);
  }

  /**
   * Shared best-effort GET-list helper. Returns {items, available}; never throws.
   * Accepts both a bare array and a {data|items|results: [...]} envelope.
   */
  private async _getList<T>(
    path: string,
    coerce: (o: Record<string, unknown>) => T | null,
    timeoutMs: number,
  ): Promise<DeepMystListResult<T>> {
    const headers = this._authHeaders();
    if (!headers) {
      return { items: [], available: true };
    }
    try {
      const res = await fetch(`${this._baseUrl()}${path}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) {
        return { items: [], available: false };
      }
      if (!res.ok) {
        return { items: [], available: true };
      }
      const data = await res.json() as unknown;
      const arr = Array.isArray(data)
        ? data
        : (data && typeof data === 'object'
          ? ((data as Record<string, unknown>).data ?? (data as Record<string, unknown>).items ?? (data as Record<string, unknown>).results)
          : null);
      if (!Array.isArray(arr)) {
        return { items: [], available: true };
      }
      const items = arr
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
        .map(coerce)
        .filter((e): e is T => e !== null);
      return { items, available: true };
    } catch {
      return { items: [], available: true };
    }
  }

  /** Normalize the /mcp/builtin payload (object map or array) into a flat list. */
  private _coerceBuiltins(data: unknown): DeepMystBuiltinMcp[] {
    if (Array.isArray(data)) {
      return data
        .map(e => this._coerceBuiltin(e))
        .filter((e): e is DeepMystBuiltinMcp => e !== null);
    }
    if (data && typeof data === 'object') {
      return Object.entries(data as Record<string, unknown>)
        .map(([name, v]) => {
          const base = this._coerceBuiltin(v) ?? { name };
          return { ...base, name: base.name || name };
        })
        .filter((e): e is DeepMystBuiltinMcp => Boolean(e.name));
    }
    return [];
  }

  private _coerceBuiltin(v: unknown): DeepMystBuiltinMcp | null {
    if (!v || typeof v !== 'object') {
      return null;
    }
    const o = v as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : '';
    if (!name) {
      return null;
    }
    return {
      name,
      title: typeof o.title === 'string' ? o.title : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
    };
  }
}
