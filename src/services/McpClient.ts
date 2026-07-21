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
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * A thin extension-host MCP **client** (Plan 05 §9 / Phase 6.2). Used for
 * extension-initiated calls to brokered capability tools — e.g. fal image/video
 * generation through the DeepMyst hub (`/api/v1/mcp/{slug}` with the `dm_`
 * bearer) — and equally happy talking to any streamable-HTTP MCP endpoint
 * (including our own `CanvasMcpHttpServer`, which is how it's tested without a
 * network). Lazy-connects on first call and reuses the session.
 */
export interface McpToolCallResult {
  isError: boolean;
  /** Concatenated text content blocks. */
  text: string;
  /** Raw content blocks for callers that need structured/typed parts. */
  content: Array<{ type: string; [k: string]: unknown }>;
}

/** Race a promise against a timeout; rejects with a clear error if it wins. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export class McpClient {
  private _url: string;
  private _bearer?: string;
  private _client: Client | null = null;
  /** Per-request timeout (ms). A hung MCP server must never hang a coordinator turn. */
  private readonly _timeoutMs: number;

  constructor(opts: { url: string; bearer?: string; timeoutMs?: number }) {
    this._url = opts.url;
    this._bearer = opts.bearer;
    this._timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
  }

  private async _connect(): Promise<Client> {
    if (this._client) { return this._client; }
    const client = new Client({ name: 'mysti', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this._url), {
      requestInit: this._bearer ? { headers: { authorization: `Bearer ${this._bearer}` } } : undefined,
    });
    // The transport connect has no built-in deadline — bound it so an
    // unreachable/hung endpoint can't stall the caller indefinitely.
    await withTimeout(client.connect(transport), this._timeoutMs, 'MCP connect');
    this._client = client;
    return client;
  }

  /**
   * List the server's tools. Surfaces `inputSchema` so callers can advertise
   * argument shapes to a model. On timeout/error the session is dropped so the
   * next call reconnects fresh.
   */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    try {
      const client = await this._connect();
      const { tools } = await client.listTools(undefined, { timeout: this._timeoutMs });
      return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    try {
      const client = await this._connect();
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: this._timeoutMs });
      const content = Array.isArray(res.content) ? (res.content as McpToolCallResult['content']) : [];
      const text = content.filter(c => c.type === 'text').map(c => String((c as { text?: unknown }).text ?? '')).join('\n');
      return { isError: res.isError === true, text, content };
    } catch (e) {
      // Drop the (possibly wedged) session so a retry reconnects; surface the error.
      await this.close();
      throw e;
    }
  }

  async close(): Promise<void> {
    try { await this._client?.close(); } catch { /* ignore */ }
    this._client = null;
  }
}
