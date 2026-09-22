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
import { isLoopbackHost } from './outboundUrlPolicy';

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

/** Release one waiter without cancelling a connection shared by other callers. */
function waitForCaller<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) { return pending; }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    // Always observe late settlement, including a shared handshake after Stop.
    pending.then(value => {
      cleanup();
      if (signal.aborted) { reject(signal.reason); } else { resolve(value); }
    }, error => { cleanup(); reject(signal.aborted ? signal.reason : error); });
    if (signal.aborted) { abort(); }
  });
}

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  controller: AbortController;
  ready: Promise<Client>;
  closing?: Promise<void>;
}

export class McpClient {
  private _url: string;
  private _bearer?: string;
  private _connection: Connection | null = null;
  /** Per-request timeout (ms). A hung MCP server must never hang a coordinator turn. */
  private readonly _timeoutMs: number;

  constructor(opts: { url: string; bearer?: string; timeoutMs?: number }) {
    this._url = opts.url;
    this._bearer = opts.bearer;
    this._timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
  }

  private _connect(): Connection {
    if (this._connection) { return this._connection; }
    // A bearer is a live account credential. The endpoint comes from a setting
    // (machine-scoped, but still a string), so refuse to put the token on the
    // wire in cleartext: https, or loopback for a local dev broker. This does
    // NOT replace the caller's `isDeepMystHost` check — it is the floor beneath
    // it, and it is the only check on the paths that forget to make one.
    if (this._bearer) {
      let parsed: URL;
      try {
        parsed = new URL(this._url);
      } catch {
        throw new Error('MCP endpoint URL is not parseable');
      }
      if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
        throw new Error(`refusing to send an MCP bearer token in cleartext to ${parsed.host}`);
      }
    }
    const client = new Client({ name: 'mysti', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this._url), {
      requestInit: this._bearer ? { headers: { authorization: `Bearer ${this._bearer}` } } : undefined,
    });
    const connection: Connection = {
      client, transport, controller: new AbortController(),
      // Publish the reservation before connect can emit callbacks or another
      // lazy caller starts. The handshake belongs to this connection only.
      ready: Promise.resolve().then(() => this._initialize(connection)),
    };
    this._connection = connection;
    client.onclose = () => {
      if (this._connection === connection) { this._connection = null; }
      connection.controller.abort(new Error('MCP connection closed'));
    };
    return connection;
  }

  private async _initialize(connection: Connection): Promise<Client> {
    const { client, transport, controller } = connection;
    const timer = setTimeout(() => controller.abort(new Error(`MCP connect timed out after ${this._timeoutMs}ms`)), this._timeoutMs);
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return client.connect(transport, { signal: controller.signal, timeout: this._timeoutMs });
    });
    // A late, non-cooperative connect cannot publish or retain its resources
    // after close/timeout. Cleanup always targets this captured client.
    void pending.then(() => {
      if (controller.signal.aborted || this._connection !== connection) { return this._closeConnection(connection); }
    }, () => {}).catch(() => {});
    try {
      await waitForCaller(pending, controller.signal);
      controller.signal.throwIfAborted();
      if (this._connection !== connection) { throw new Error('MCP connection replaced'); }
      return client;
    } catch (error) {
      if (this._connection === connection) { this._connection = null; }
      controller.abort(error);
      await this._closeConnection(connection);
      throw error;
    } finally { clearTimeout(timer); }
  }

  private _closeConnection(connection: Connection): Promise<void> {
    if (connection.closing) { return connection.closing; }
    const closing = Promise.resolve().then(() => connection.client.close()).catch(() => {}).finally(() => {
      if (connection.closing === closing) { connection.closing = undefined; }
    });
    connection.closing = closing;
    return closing;
  }

  private async _request<T>(signal: AbortSignal | undefined, send: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const connection = this._connect();
    const client = await waitForCaller(connection.ready, signal);
    signal?.throwIfAborted();
    connection.controller.signal.throwIfAborted();
    if (this._connection !== connection) { throw new Error('MCP connection replaced'); }
    // The SDK retains its listener on a request signal. Give it a short-lived
    // derived signal, never the run signal that can outlive many requests.
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) { abort(); }
      controller.signal.throwIfAborted();
      const result = await waitForCaller(send(client, controller.signal), signal);
      signal?.throwIfAborted();
      return result;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  /**
   * List the server's tools. Surfaces `inputSchema` so callers can advertise
   * argument shapes to a model. Cancellation and timeout belong to this request,
   * so a sibling request can continue using the same session.
   */
  async listTools(signal?: AbortSignal): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const { tools } = await this._request(signal, (client, requestSignal) => client.listTools(undefined, { timeout: this._timeoutMs, signal: requestSignal }));
    return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
    const res = await this._request(signal, (client, requestSignal) => client.callTool({ name, arguments: args }, undefined, { timeout: this._timeoutMs, signal: requestSignal }));
    const content = Array.isArray(res.content) ? (res.content as McpToolCallResult['content']) : [];
    const text = content.filter(c => c.type === 'text').map(c => String((c as { text?: unknown }).text ?? '')).join('\n');
    return { isError: res.isError === true, text, content };
  }

  async close(): Promise<void> {
    const connection = this._connection;
    this._connection = null;
    if (connection) {
      connection.controller.abort(new Error('MCP connection closed'));
      await this._closeConnection(connection);
    }
  }
}
