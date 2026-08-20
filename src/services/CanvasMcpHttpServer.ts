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
 *
 * **Plan 20 §3.6 — the token is minted per *artifact*, not per provider.** The
 * tool server resolves its context from mutable host state, so without a binding
 * a token handed to a CLI while design A was open keeps working after the user
 * switches to design B — it silently follows them into the next design. Each
 * server is therefore constructed **for one artifact id** ({@link
 * CanvasMcpHttpServerOptions.artifactId}) and re-checks that binding on every
 * request via a `currentArtifactId` probe captured at construction: the moment
 * the host is serving a different artifact the token is revoked, every further
 * request is `410 Gone`, and the listener shuts itself down. Callers mint a new
 * server (hence a new token) per artifact.
 *
 * **Lifecycle.** `stop()` is idempotent and is honoured *retroactively*: it sets
 * a `_stopped` flag that `start()` re-checks after every await — including after
 * `listen` resolves — so a panel that opens and closes faster than the async
 * startup can never leave a listening socket behind.
 */
export interface CanvasMcpHttpHandle {
  port: number;
  token: string;
  url: string;
  /** The artifact this token is scoped to (when the server was bound to one). */
  artifactId?: string;
}

export interface CanvasMcpHttpServerOptions {
  /** Override the generated bearer token (tests). */
  token?: string;
  /** The artifact id this server + token are minted for. */
  artifactId?: string;
  /**
   * Probe for the artifact the host is currently serving, **captured at
   * construction** rather than closed over by the caller after the fact. Any
   * answer other than {@link artifactId} — including `null`/`undefined` for "no
   * design open" — revokes the token. Omit it only for an unbound server.
   */
  currentArtifactId?: () => string | null | undefined;
}

export class CanvasMcpHttpServer {
  private _toolServer: CanvasToolServer;
  private _token: string;
  private _tokenBuf: Buffer;
  private _http: http.Server | null = null;
  private _transport: StreamableHTTPServerTransport | null = null;
  private _artifactId: string | null;
  private _currentArtifactId: (() => string | null | undefined) | null;
  private _stopped = false;
  private _revoked = false;
  private _starting: Promise<CanvasMcpHttpHandle> | null = null;
  private _handleInfo: CanvasMcpHttpHandle | null = null;

  constructor(toolServer: CanvasToolServer, opts?: CanvasMcpHttpServerOptions) {
    this._toolServer = toolServer;
    this._token = opts?.token ?? crypto.randomBytes(24).toString('hex');
    this._tokenBuf = Buffer.from(`Bearer ${this._token}`, 'utf8');
    this._artifactId = opts?.artifactId ?? null;
    this._currentArtifactId = opts?.currentArtifactId ?? null;
    if (!this._artifactId) {
      console.warn('[Mysti] CanvasMcpHttpServer: no artifactId bound — the token is not scoped to a design.');
    }
  }

  get token(): string { return this._token; }

  /** The artifact this server's token is minted for (null when unbound). */
  get artifactId(): string | null { return this._artifactId; }

  /** True once the artifact binding broke (or {@link stop} ran) — every request 410s. */
  get isRevoked(): boolean { return this._revoked || this._stopped; }

  /** Start the HTTP server on a random loopback port. Returns the connection info. */
  async start(): Promise<CanvasMcpHttpHandle> {
    if (this._handleInfo) { return this._handleInfo; }
    if (this._starting) { return this._starting; }
    this._starting = this._start();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  private async _start(): Promise<CanvasMcpHttpHandle> {
    this._assertRunnable();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });
    try {
      this._assertRunnable();
      await this._toolServer.connect(transport);
      this._assertRunnable();
    } catch (err) {
      await closeQuietly(transport);
      throw err;
    }

    const server = http.createServer((req, res) => { void this._handle(req, res); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
    } catch (err) {
      await closeQuietly(transport);
      throw err;
    }

    // The stop() that arrived while we were awaiting `listen` must still win —
    // otherwise a fast open→close leaks a listening socket for the session.
    if (this._stopped) {
      await closeServer(server);
      await closeQuietly(transport);
      throw new Error('CanvasMcpHttpServer stopped before startup completed');
    }

    this._transport = transport;
    this._http = server;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this._handleInfo = {
      port,
      token: this._token,
      url: `http://127.0.0.1:${port}/mcp`,
      ...(this._artifactId ? { artifactId: this._artifactId } : {}),
    };
    return this._handleInfo;
  }

  /** Idempotent: safe to call before `start()`, during it, and repeatedly after. */
  async stop(): Promise<void> {
    this._stopped = true;
    // Let an in-flight startup finish (it will tear itself down on the flag).
    if (this._starting) { await this._starting.catch(() => { /* already stopped */ }); }
    const transport = this._transport;
    const server = this._http;
    this._transport = null;
    this._http = null;
    this._handleInfo = null;
    if (transport) { await closeQuietly(transport); }
    if (server) { await closeServer(server); }
  }

  private _assertRunnable(): void {
    if (this._stopped) { throw new Error('CanvasMcpHttpServer stopped before startup completed'); }
  }

  /**
   * The artifact binding, re-checked per request. Returns false once the host
   * moved on to another design — the token dies with the design it was minted
   * for rather than following the user into the next one.
   */
  private _bindingHolds(): boolean {
    if (this._revoked) { return false; }
    if (!this._artifactId || !this._currentArtifactId) { return true; }
    let current: string | null | undefined;
    try { current = this._currentArtifactId(); } catch { current = null; }
    // Fail CLOSED: "no artifact open" is not "any artifact will do".
    return current === this._artifactId;
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 6.3b defense-in-depth vs DNS-rebinding / cross-site requests: the server
    // only listens on 127.0.0.1, so a legitimate client always addresses a
    // loopback host — a rebound browser request carries the attacker's domain
    // in Host (and a non-localhost Origin). Reject both BEFORE the transport
    // (or the bearer check) sees the request.
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(String(origin))) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return;
    }
    // Loopback + bearer-token gate (constant-time, so the token is not a timing
    // oracle for anything else that can reach the loopback interface).
    if (!safeEqual(req.headers['authorization'], this._tokenBuf)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }
    // Plan 20 §3.6: the token is scoped to ONE artifact. A valid bearer whose
    // design is gone is dead, not a pass into the user's next design.
    if (this._stopped || !this._bindingHolds()) {
      this._revoked = true;
      res.writeHead(410, { 'content-type': 'text/plain' });
      res.on('finish', () => { void this.stop(); });
      res.end('canvas session ended');
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

/** Constant-time compare of an Authorization header against the expected value. */
function safeEqual(header: string | string[] | undefined, expected: Buffer): boolean {
  if (typeof header !== 'string') { return false; }
  const got = Buffer.from(header, 'utf8');
  if (got.length !== expected.length) { return false; }
  return crypto.timingSafeEqual(got, expected);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    server.close(done);
    // Keep-alive sockets hold `close()` open indefinitely; the callers here are
    // disposing the session, so drop them (Node >= 18.2 — optional for older).
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    if (!server.listening) { done(); }
  });
}

async function closeQuietly(transport: { close(): Promise<void> | void }): Promise<void> {
  try { await transport.close(); } catch { /* ignore */ }
}

/** True when a Host header names a loopback host (`127.0.0.1`/`localhost`/`[::1]`, optional port). */
function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) { return false; }
  const m = host.match(/^(\[[^\]]*\]|[^:]+)(:\d+)?$/);
  if (!m) { return false; }
  const h = m[1].toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

/** True when an Origin header (if a browser sent one) is a localhost origin. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false; // includes the opaque "null" origin
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
