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

export class McpClient {
  private _url: string;
  private _bearer?: string;
  private _client: Client | null = null;

  constructor(opts: { url: string; bearer?: string }) {
    this._url = opts.url;
    this._bearer = opts.bearer;
  }

  private async _connect(): Promise<Client> {
    if (this._client) { return this._client; }
    const client = new Client({ name: 'mysti', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this._url), {
      requestInit: this._bearer ? { headers: { authorization: `Bearer ${this._bearer}` } } : undefined,
    });
    await client.connect(transport);
    this._client = client;
    return client;
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const client = await this._connect();
    const { tools } = await client.listTools();
    return tools.map(t => ({ name: t.name, description: t.description }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const client = await this._connect();
    const res = await client.callTool({ name, arguments: args });
    const content = Array.isArray(res.content) ? (res.content as McpToolCallResult['content']) : [];
    const text = content.filter(c => c.type === 'text').map(c => String((c as { text?: unknown }).text ?? '')).join('\n');
    return { isError: res.isError === true, text, content };
  }

  async close(): Promise<void> {
    try { await this._client?.close(); } catch { /* ignore */ }
    this._client = null;
  }
}
