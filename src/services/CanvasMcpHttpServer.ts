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

import * as http from 'http';
import * as crypto from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CanvasToolServer } from './CanvasToolServer';

/**
 * Hosts the {@link CanvasToolServer} over localhost HTTP so a CLI agent (Claude
 * Code `type:http`) can reach it while the server stays **in the extension host**
 * — keeping in-process `ArtifactStore`/executor access and the Playwright/vision
 * `render_page_preview` (Open Q4 / Plan 05 M3). A per-session bearer token gates
 * access so only the linked CLI connects. Bound to 127.0.0.1 only.
 */
export interface CanvasMcpHttpHandle {
  port: number;
  token: string;
  url: string;
}

export class CanvasMcpHttpServer {
  private _toolServer: CanvasToolServer;
  private _token: string;
  private _http: http.Server | null = null;
  private _transport: StreamableHTTPServerTransport | null = null;

  constructor(toolServer: CanvasToolServer, opts?: { token?: string }) {
    this._toolServer = toolServer;
    this._token = opts?.token ?? crypto.randomBytes(24).toString('hex');
  }

  get token(): string { return this._token; }

  /** Start the HTTP server on a random loopback port. Returns the connection info. */
  async start(): Promise<CanvasMcpHttpHandle> {
    this._transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });
    await this._toolServer.connect(this._transport);

    this._http = http.createServer((req, res) => { void this._handle(req, res); });
    await new Promise<void>((resolve) => this._http!.listen(0, '127.0.0.1', resolve));

    const addr = this._http.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { port, token: this._token, url: `http://127.0.0.1:${port}/mcp` };
  }

  async stop(): Promise<void> {
    try { await this._transport?.close(); } catch { /* ignore */ }
    if (this._http) {
      await new Promise<void>((resolve) => this._http!.close(() => resolve()));
      this._http = null;
    }
    this._transport = null;
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Loopback + bearer-token gate.
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${this._token}`) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }
    const path = (req.url || '').split('?')[0];
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    if (!this._transport) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('not ready');
      return;
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    await this._transport.handleRequest(req, res, body);
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(undefined); } });
    req.on('error', () => resolve(undefined));
  });
}
