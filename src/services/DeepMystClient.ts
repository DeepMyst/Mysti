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

/**
 * Default endpoints — overridable via the mysti.deepmyst.* settings.
 * The DeepMyst v2 web app is at v2.deepmyst.com; the REST + MCP API is on its
 * own host (api.v2.deepmyst.com) under `/api/v1/...`.
 */
export const DEEPMYST_DEFAULT_API_URL = 'https://api.v2.deepmyst.com';
export const DEEPMYST_DEFAULT_WEB_URL = 'https://v2.deepmyst.com';

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

/**
 * A user-scoped MCP connection from DeepMyst's "My Connections" hub
 * (GET /api/v1/me/mcp-connections). This is the real connections model —
 * Smithery/Composio servers the user authorized via OAuth, shared across all
 * their agents. NOTE: `mcpUrl` is the UPSTREAM provider URL, not a DeepMyst
 * broker endpoint — it is NOT written into local CLI MCP configs (the agent
 * broker /api/v1/mcp/{slug} is the only CLI-reachable endpoint).
 */
export interface McpUserConnection {
  id: string;
  displayName: string;
  provider: string;            // 'smithery' | 'composio' | …
  status: string;              // 'pending' | 'connected' | 'failed' | 'revoked'
  mcpUrl: string;              // upstream provider URL (not CLI-reachable)
  setupUrl?: string;           // present while pending OAuth — open to authorize
  iconUrl?: string;
  description?: string;
  errorMessage?: string;
  connectedAt?: string;
}

/** A catalog entry the user can connect (Composio app or Smithery registry card). */
export interface DeepMystCatalogItem {
  provider: 'composio' | 'smithery';
  slug: string;
  displayName: string;
  mcpUrl?: string;             // Smithery hosted URL, or composio://{slug}
  toolkitSlug?: string;        // Composio toolkit slug (connect payload)
  iconUrl?: string;
  description?: string;
}

/** Result of a best-effort list call: data plus whether the endpoint exists yet. */
export interface DeepMystListResult<T> {
  items: T[];
  /** false when DeepMyst returned 404 (endpoint not deployed) so the UI can say so. */
  available: boolean;
  /** HTTP status of the probe (200 ok, 0 = never reached server / signed out). */
  status?: number;
  /** Short error label when status is a non-200, non-404 (e.g. "HTTP 401"). */
  error?: string;
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
   * The per-user MCP broker endpoint (POST /api/v1/me/mcp). A single MCP server
   * exposing the union of the user's connected Smithery/Composio tools — this is
   * the URL written into each local CLI's MCP config (with the dm_ Bearer) so an
   * agent can call those tools directly. See DeepMyst MyMcpHandler.
   */
  getMyMcpEndpointUrl(): string {
    return `${this._baseUrl()}/api/v1/me/mcp`;
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
   * List the user's MCP connections (DeepMyst "My Connections" hub —
   * GET /api/v1/me/mcp-connections). These are the Smithery/Composio servers the
   * user authorized; the same `dm_` key Mysti holds authenticates this endpoint.
   * available=false only if the endpoint 404s (instance predates the feature).
   */
  async listMcpConnections(timeoutMs = 10000): Promise<DeepMystListResult<McpUserConnection>> {
    return this._getList('/api/v1/me/mcp-connections', (o) => DeepMystClient._mapConn(o), timeoutMs);
  }

  /** Map a raw DeepMyst MCP-connection object (snake_case) to McpUserConnection. */
  private static _mapConn(o: Record<string, unknown>): McpUserConnection | null {
    const id = typeof o.id === 'string' ? o.id : (typeof o.id === 'number' ? String(o.id) : '');
    if (!id) { return null; }
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return {
      id,
      displayName: str(o.display_name) ?? str(o.name) ?? id,
      provider: str(o.provider) ?? 'mcp',
      status: str(o.status) ?? 'connected',
      mcpUrl: str(o.mcp_url) ?? '',
      setupUrl: str(o.setup_url),
      iconUrl: str(o.icon_url),
      description: str(o.description),
      errorMessage: str(o.error_message),
      connectedAt: str(o.connected_at),
    };
  }

  /**
   * Disconnect a user MCP connection (DELETE /api/v1/me/mcp-connections/{id}).
   * Revokes upstream + deletes the row. Returns true on 2xx. Never throws.
   * A 401/403 (read-only or agent-scoped key) resolves false so the caller can
   * fall back to the web hub.
   */
  async disconnectMcp(id: string, timeoutMs = 10000): Promise<boolean> {
    return this._authedMutate('DELETE', `/api/v1/me/mcp-connections/${encodeURIComponent(id)}`, timeoutMs);
  }

  /**
   * Refresh a pending connection's status (POST .../{id}/refresh) — used to poll
   * after the user completes OAuth. Returns the updated connection, or null on
   * any failure.
   */
  async refreshMcpConnection(id: string, timeoutMs = 10000): Promise<McpUserConnection | null> {
    const headers = this._authHeaders();
    if (!headers) { return null; }
    try {
      const res = await fetch(`${this._baseUrl()}/api/v1/me/mcp-connections/${encodeURIComponent(id)}/refresh`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { return null; }
      const o = await res.json() as Record<string, unknown>;
      if (!o || typeof o !== 'object') { return null; }
      return DeepMystClient._mapConn({ id, ...o });
    } catch {
      return null;
    }
  }

  /**
   * Create a connection to a catalog MCP server (POST /api/v1/me/mcp-connections).
   * For Composio apps pass `provider:'composio'` + `toolkit_slug`; for Smithery
   * pass `provider:'smithery'` + the registry `mcp_url`. Returns the connection
   * (status 'pending' carries `setupUrl` to open for OAuth), or null on failure.
   */
  async connectMcp(body: {
    mcp_url?: string;
    provider?: string;
    toolkit_slug?: string;
    display_name?: string;
    icon_url?: string;
    description?: string;
  }, timeoutMs = 15000): Promise<McpUserConnection | null> {
    const headers = this._authHeaders();
    if (!headers) { return null; }
    try {
      const res = await fetch(`${this._baseUrl()}/api/v1/me/mcp-connections`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.warn(`[Mysti] DeepMyst connectMcp → HTTP ${res.status}`);
        return null;
      }
      const o = await res.json() as Record<string, unknown>;
      return (o && typeof o === 'object') ? DeepMystClient._mapConn(o) : null;
    } catch (err) {
      console.warn(`[Mysti] DeepMyst connectMcp failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Search the Composio managed-app catalog (GET /api/v1/me/mcp-catalog/apps).
   * Returns [] when Composio isn't configured on the instance or on any error.
   */
  async searchComposioApps(query: string, timeoutMs = 10000): Promise<DeepMystCatalogItem[]> {
    const headers = this._authHeaders();
    if (!headers) { return []; }
    try {
      const res = await fetch(
        `${this._baseUrl()}/api/v1/me/mcp-catalog/apps?q=${encodeURIComponent(query)}&page_size=10`,
        { headers, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) { return []; }
      const data = await res.json() as Record<string, unknown>;
      if (data.configured === false) { return []; }
      const items = Array.isArray(data.toolkits) ? data.toolkits : [];
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
      return items
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
        .map((t) => {
          const slug = str(t.slug);
          if (!slug) { return null; }
          return {
            provider: 'composio',
            slug,
            toolkitSlug: slug,
            displayName: str(t.display_name) ?? slug,
            iconUrl: str(t.icon_url),
            description: str(t.description),
            mcpUrl: str(t.mcp_url) ?? `composio://${slug}`,
          } as DeepMystCatalogItem;
        })
        .filter((x): x is DeepMystCatalogItem => x !== null);
    } catch {
      return [];
    }
  }

  /**
   * Search the Smithery registry (GET /api/v1/me/mcp-registry). Returns []
   * on any error. Each result's `mcpUrl` is the hosted connect URL.
   */
  async searchMcpRegistry(query: string, timeoutMs = 10000): Promise<DeepMystCatalogItem[]> {
    const headers = this._authHeaders();
    if (!headers) { return []; }
    try {
      const res = await fetch(
        `${this._baseUrl()}/api/v1/me/mcp-registry?q=${encodeURIComponent(query)}&page=1&page_size=10`,
        { headers, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) { return []; }
      const data = await res.json() as Record<string, unknown>;
      const items = Array.isArray(data.servers) ? data.servers : [];
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
      return items
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
        .map((s) => {
          const mcpUrl = str(s.mcp_url);
          if (!mcpUrl) { return null; }
          const name = str(s.display_name) ?? str(s.name) ?? str(s.qualified_name) ?? mcpUrl;
          return {
            provider: 'smithery',
            slug: (str(s.qualified_name) ?? name).toLowerCase(),
            displayName: name,
            iconUrl: str(s.icon_url),
            description: str(s.description),
            mcpUrl,
          } as DeepMystCatalogItem;
        })
        .filter((x): x is DeepMystCatalogItem => x !== null);
    } catch {
      return [];
    }
  }

  /** Shared authenticated mutation (no body). Returns true on 2xx. Never throws. */
  private async _authedMutate(method: 'POST' | 'DELETE', path: string, timeoutMs: number): Promise<boolean> {
    const headers = this._authHeaders();
    if (!headers) { return false; }
    try {
      const res = await fetch(`${this._baseUrl()}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
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
      console.log(`[Mysti] DeepMyst GET ${path} skipped — signed out`);
      return { items: [], available: true, status: 0 };
    }
    try {
      const res = await fetch(`${this._baseUrl()}${path}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) {
        console.log(`[Mysti] DeepMyst GET ${path} → 404 (endpoint not available)`);
        return { items: [], available: false, status: 404 };
      }
      if (!res.ok) {
        // 401/403 (key not accepted / wrong principal) and 5xx land here. We
        // report available:true (no "endpoint missing" banner) but record the
        // status so the UI can prompt a re-sign-in, and log loudly.
        console.warn(`[Mysti] DeepMyst GET ${path} → HTTP ${res.status} (treated as empty; check the dm_ key / its user binding)`);
        return { items: [], available: true, status: res.status, error: `HTTP ${res.status}` };
      }
      const data = await res.json() as unknown;
      const arr = Array.isArray(data)
        ? data
        : (data && typeof data === 'object'
          ? ((data as Record<string, unknown>).data ?? (data as Record<string, unknown>).items ?? (data as Record<string, unknown>).results)
          : null);
      if (!Array.isArray(arr)) {
        console.warn(`[Mysti] DeepMyst GET ${path} → 200 but body is not an array/{data|items|results} envelope`);
        return { items: [], available: true, status: 200 };
      }
      const items = arr
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
        .map(coerce)
        .filter((e): e is T => e !== null);
      console.log(`[Mysti] DeepMyst GET ${path} → 200, ${arr.length} raw / ${items.length} mapped item(s)`);
      return { items, available: true, status: 200 };
    } catch (err) {
      console.warn(`[Mysti] DeepMyst GET ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { items: [], available: true, status: 0, error: err instanceof Error ? err.message : String(err) };
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
