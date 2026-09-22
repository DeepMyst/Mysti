/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpHttpEndpoint } from '../managers/CanvasSessionLinker';

export interface CanvasMcpSessionServer {
  start(): Promise<McpHttpEndpoint>;
  /** Must also revoke a start that is still pending. */
  stop(): Promise<void>;
}

export interface CanvasMcpSessionPorts {
  artifactId(): string | null;
  originPanel(): string | null;
  createServer(artifactId: string): CanvasMcpSessionServer | null;
  /** `providerId` names the backend a per-turn link is minted for (else the default). */
  link(panelId: string, endpoint: McpHttpEndpoint, providerId?: string): void;
  unlink(panelId: string): void;
  onError(error: unknown): void;
}

/**
 * Owns one design's MCP server and its disposable chat-session registration.
 *
 * The host also uses it as the per-turn MCP admission: every ordinary turn in
 * the linked chat panel {@link close}s (synchronously revoking the previous
 * turn's bearer and transport) and then {@link relink}s for that turn's own
 * backend, so a delayed call from an earlier turn's CLI is refused rather
 * than admitted under its successor's authority.
 */
export class CanvasMcpSession {
  private _generation = 0;
  private _server: CanvasMcpSessionServer | null = null;
  private _linkedPanel: string | null = null;
  private _stopping: Promise<void> = Promise.resolve();
  private readonly _stops = new WeakMap<CanvasMcpSessionServer, Promise<void>>();
  private _disposed = false;

  public constructor(private readonly _ports: CanvasMcpSessionPorts) {}

  /** Only the latest design switch may publish a newly started endpoint. */
  public async relink(artifactId: string, providerId?: string): Promise<void> {
    if (this._disposed || this._ports.artifactId() !== artifactId) { return; }
    const generation = ++this._generation;
    const origin = this._ports.originPanel();
    const current = () => !this._disposed && this._generation === generation
      && this._ports.artifactId() === artifactId && this._ports.originPanel() === origin;
    this._detach();
    // CanvasToolServer is shared by successive transports. Do not reconnect it
    // until every previous transport, including one still starting, has stopped.
    await this._stopping;
    if (!current()) { return; }

    let server: CanvasMcpSessionServer | null;
    try { server = this._ports.createServer(artifactId); }
    catch (error) { this._report(error); return; }
    if (!server) { return; }
    if (!current()) { await this._stop(server); return; }
    this._server = server;
    try {
      const endpoint = await server.start();
      if (!current() || this._server !== server) {
        this._release(server);
        await this._stop(server);
        return;
      }
      if (origin) {
        // Record before calling the port so a partially failed link is removed.
        this._linkedPanel = origin;
        if (providerId) { this._ports.link(origin, endpoint, providerId); }
        else { this._ports.link(origin, endpoint); }
      }
    } catch (error) {
      const wasCurrent = current();
      this._release(server);
      await this._stop(server);
      if (wasCurrent) { this._report(error); }
    }
  }

  /** Reusable after the canvas is reopened; invalidates pending work immediately. */
  public close(): Promise<void> {
    ++this._generation;
    this._detach();
    return this._stopping;
  }

  public dispose(): Promise<void> {
    this._disposed = true;
    return this.close();
  }

  private _detach(): void {
    const server = this._server;
    this._server = null;
    this._unlink();
    if (server) { void this._stop(server); }
  }

  private _release(server: CanvasMcpSessionServer): void {
    if (this._server !== server) { return; }
    this._server = null;
    this._unlink();
  }

  private _unlink(): void {
    const panelId = this._linkedPanel;
    this._linkedPanel = null;
    if (!panelId) { return; }
    try { this._ports.unlink(panelId); } catch (error) { this._report(error); }
  }

  private _stop(server: CanvasMcpSessionServer): Promise<void> {
    const previous = this._stops.get(server);
    if (previous) { return previous; }
    let stopping: Promise<void>;
    try { stopping = Promise.resolve(server.stop()).catch(() => {}); }
    catch { stopping = Promise.resolve(); }
    this._stops.set(server, stopping);
    this._stopping = Promise.all([this._stopping, stopping]).then(() => {});
    return stopping;
  }

  private _report(error: unknown): void {
    try { this._ports.onError(error); } catch { /* logging cannot break teardown */ }
  }
}
