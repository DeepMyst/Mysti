/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { OpenClawAgentRun } from './OpenClawAgentRun';
import { createAbortScope } from '../../utils/abortScope';
import type { StreamChunk } from '../../types';
import { OPENCLAW_GATEWAY_TIMEOUT_MS } from '../../constants';

/**
 * Options for sending an agent message via the Gateway
 */
export interface GatewayAgentOptions {
  thinking?: string;
  sessionKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onAccepted?: (sessionKey: string) => void;
  attachments?: Array<{ type: string; mimeType: string; fileName: string; content: string }>;
}

// --- Active Mode types (used by ActiveModeManager) ---

export interface GatewayStatus {
  running: boolean;
  uptime: number;
  version: string;
  heartbeatInterval: number;
  channelCount: number;
}

export interface ChannelInfo {
  id: string;
  type: 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'signal' | string;
  name: string;
  status: 'connected' | 'disconnected' | 'pairing' | 'error';
  connectedSince?: number;
  lastActivity?: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelEvent {
  channelId: string;
  channelType: string;
  eventType: 'message_received' | 'message_sent' | 'connected' | 'disconnected' | 'pairing';
  content?: string;
  sender?: string;
  timestamp: number;
}

export interface ActivityEntry {
  timestamp: number;
  source: string;
  action: string;
  details?: string;
}

// --- Session types (for inbound message polling) ---

export interface SessionInfo {
  sessionKey: string;
  lastActivity?: number;
  messageCount?: number;
}

export interface SessionMessage {
  role: string;
  content: string;
  timestamp: number;
  from?: string;
}

export interface ChannelConnectResult {
  success: boolean;
  channelId?: string;
  pairingData?: {
    qrCode?: string;
    authUrl?: string;
    instructions?: string;
  };
  error?: string;
}

/**
 * OpenClaw Gateway WebSocket protocol frame types
 */
interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { message?: string; code?: string };
}

interface GatewayEvent {
  type: 'event';
  event: string;
  payload: Record<string, unknown>;
  seq?: number;
}

type GatewayFrame = GatewayRequest | GatewayResponse | GatewayEvent;

/**
 * WebSocket client for the OpenClaw Gateway
 *
 * Connects to the Gateway at ws://127.0.0.1:18789 (configurable) and
 * uses the JSON-RPC-style protocol for agent message execution.
 *
 * Protocol frames:
 * - Request:  {type: "req", id, method, params}
 * - Response: {type: "res", id, ok, payload?, error?}
 * - Event:    {type: "event", event, payload, seq?}
 */
export class OpenClawGateway {
  private _ws: WebSocket | null = null;
  private _url: string;
  private _requestId: number = 0;
  private _connected: boolean = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = 5;
  private _pendingRequests: Map<string, {
    resolve: (value: GatewayResponse) => void;
    reject: (reason: Error) => void;
    onProgress?: (response: GatewayResponse) => void;
  }> = new Map();
  private _eventListeners: Map<string, ((payload: Record<string, unknown>, seq?: number) => void)[]> = new Map();
  private _disposed: boolean = false;
  private _connecting: Promise<boolean> | null = null;
  private _cancelConnect: (() => void) | null = null;
  private readonly _activeRuns = new Map<string, { run: OpenClawAgentRun; sessionKey: string }>();
  private _token: string | undefined;

  constructor(url: string = 'ws://127.0.0.1:18789', token?: string) {
    this._url = url;
    this._token = token;
  }

  /**
   * Attempt to connect to the OpenClaw Gateway
   * Returns true if connection succeeds, false otherwise
   */
  connect(): Promise<boolean> {
    if (this.isConnected()) { return Promise.resolve(true); }
    if (this._disposed) { return Promise.resolve(false); }
    if (this._connecting) { return this._connecting; }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const attempt = this._openConnection();
    this._connecting = attempt;
    void attempt.then(() => {
      if (this._connecting === attempt) { this._connecting = null; }
    });
    return attempt;
  }

  private _openConnection(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this._url); } catch { resolve(false); return; }
      this._ws = ws;
      let settled = false;
      let challenged = false;
      const timeout = setTimeout(() => fail('Connection timeout'), 10000);
      const settle = (connected: boolean) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        if (this._cancelConnect === cancel) { this._cancelConnect = null; }
        resolve(connected);
      };
      const fail = (reason: string) => {
        if (this._ws !== ws) { settle(false); return; }
        this._ws = null;
        this._connected = false;
        this._rejectPending(new Error(`OpenClaw Gateway: ${reason}`));
        settle(false);
        // Retain the error listener through termination of a connecting socket.
        ws.terminate();
        this._scheduleReconnect();
      };
      const cancel = () => fail('Connection cancelled');
      this._cancelConnect = cancel;

      ws.on('message', (data: WebSocket.Data) => {
        if (this._ws !== ws) { return; }
        let frame: GatewayFrame;
        try { frame = JSON.parse(data.toString()) as GatewayFrame; } catch { return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { return; }
        if (frame.type === 'event' && frame.event === 'connect.challenge' && !challenged) {
          challenged = true;
          void this._sendRequest('connect', {
            minProtocol: 3,
            maxProtocol: 4,
            client: { id: 'cli', version: '1.0.0', platform: process.platform, mode: 'cli' },
            role: 'operator',
            scopes: ['operator.admin', 'operator.read', 'operator.write'],
            // Tool events are observations; this does not advertise an approval bridge.
            caps: ['tool-events'],
            auth: this._token ? { token: this._token } : {},
            locale: 'en-US',
          }).then(response => {
            if (this._ws !== ws || settled || this._disposed) { return; }
            if (!response.ok || response.payload?.type !== 'hello-ok' ||
                ![3, 4].includes(response.payload.protocol as number)) {
              fail(response.error?.message || 'Unsupported handshake response');
              return;
            }
            this._connected = true;
            this._reconnectAttempts = 0;
            settle(true);
          }, () => fail('Handshake failed'));
        } else {
          this._handleMessage(frame);
        }
      });
      ws.on('close', () => {
        if (this._ws !== ws) { return; }
        this._ws = null;
        this._connected = false;
        this._rejectPending(new Error('OpenClaw Gateway disconnected'));
        settle(false);
        this._scheduleReconnect();
      });
      ws.on('error', () => fail('Connection error'));
    });
  }

  /**
   * Check if the Gateway is connected and ready
   */
  isConnected(): boolean {
    return this._connected && this._ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send an agent message and return an async generator of StreamChunk events.
   *
   * Flow:
   * 1. Send {type: "req", method: "agent", params: {message, ...options}}
   * 2. Receive ack response with runId and status "accepted"
   * 3. Receive streaming {type: "event", event: "agent"} frames
   * 4. Receive final response with status "ok" or "error"
   */
  sendAgentMessage(message: string, options: GatewayAgentOptions = {}): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    const scope = createAbortScope([controller.signal, options.signal]);
    const stream = this._streamAgentMessage(message, { ...options, signal: scope.signal });
    // Async-generator return() ordinarily queues behind an outstanding next().
    // Abort first so abandoning a silent stream reaches its finally immediately.
    const settle = async (operation: Promise<IteratorResult<StreamChunk>>) => {
      try {
        const result = await operation;
        if (result.done) { scope.dispose(); }
        return result;
      } catch (error) { scope.dispose(); throw error; }
    };
    return {
      next: (...args) => settle(stream.next(...args)),
      return: value => { controller.abort(); return settle(stream.return(value)); },
      throw: error => { controller.abort(); return settle(stream.throw(error)); },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  private async *_streamAgentMessage(
    message: string,
    options: GatewayAgentOptions = {}
  ): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) { return; }
    if (!this.isConnected()) { throw new Error('Gateway not connected'); }

    const requestId = this._nextId();
    // Installed protocol uses the idempotency key as the run ID, including
    // events emitted before the accepted response. Never correlate by session alone.
    const runId = `mysti-${randomUUID()}`;
    const sessionKey = options.sessionKey || `mysti-ephemeral-${randomUUID()}`;
    const deadline = Date.now() + (options.timeoutMs ?? OPENCLAW_GATEWAY_TIMEOUT_MS);
    let accepted = false;
    let sessionReported = false;
    let terminal = false;
    let needsAbort = false;
    let agentId: string | undefined;
    const run = new OpenClawAgentRun(runId, sessionKey, options, (key, id) => {
      needsAbort = true;
      this._abortRun(key, id, agentId);
    });
    this._activeRuns.set(runId, { run, sessionKey });
    const listeners = ['agent', 'chat'].map(event => {
      const handler = (payload: Record<string, unknown>) => run.onEvent(event, payload);
      this._addEventListener(event, handler);
      return () => this._removeEventListener(event, handler);
    });
    const onProgress = (response: GatewayResponse) => {
      if (response.payload?.runId === runId) {
        accepted = true;
        agentId = typeof response.payload.agentId === 'string' ? response.payload.agentId : undefined;
        if (needsAbort) {
          this._abortRun(typeof response.payload.sessionKey === 'string' ? response.payload.sessionKey : sessionKey, runId, agentId);
        }
      }
      run.onResponse(response);
      if (!sessionReported && response.payload?.runId === runId && response.payload.status === 'accepted') {
        sessionReported = true;
        try { options.onAccepted?.(run.sessionKey); }
        catch (error) {
          run.fail(error instanceof Error ? error : new Error(String(error)));
          needsAbort = true;
          this._abortRun(run.sessionKey, runId, agentId);
        }
      }
    };
    this._pendingRequests.set(requestId, {
      resolve: response => { terminal = true; run.onResponse(response); },
      reject: error => run.fail(error),
      onProgress,
    });
    try {
      try {
        this._sendFrame({ type: 'req', id: requestId, method: 'agent', params: {
          message, idempotencyKey: runId, sessionKey,
          ...(options.attachments?.length ? { attachments: options.attachments } : {}),
          ...(options.thinking ? { thinking: options.thinking } : {}),
        } });
      } catch (error) {
        run.fail(error instanceof Error ? error : new Error(String(error)));
      }
      yield* run.chunks();
    } finally {
      run.dispose();
      listeners.forEach(remove => remove());
      this._activeRuns.delete(runId);
      this._pendingRequests.delete(requestId);
      // An abort sent before the server reserves the run has no tombstone.
      // Retain only an acknowledgement watcher to stop a late accepted run.
      if (needsAbort && !accepted && !terminal && this.isConnected()) {
        this._watchCancelledAck(requestId, runId, sessionKey, Math.max(30000, deadline - Date.now()));
      }
    }
  }

  /** Cancel only runs owned by this client in the requested session. */
  cancelSession(sessionKey: string): void {
    for (const { run, sessionKey: requestedKey } of this._activeRuns.values()) {
      if (requestedKey === sessionKey || run.sessionKey === sessionKey) { run.cancel(); }
    }
  }

  private _abortRun(key: string, runId: string, agentId?: string): void {
    if (!this.isConnected()) { return; }
    void this._sendRequest('sessions.abort', { key, runId, ...(agentId ? { agentId } : {}) })
      .then(response => {
        if (!response.ok) { console.warn('[Mysti] OpenClaw Gateway: Run cancellation rejected'); }
      }, () => { /* Disconnect and timeout already settle the local run. */ });
  }

  private _watchCancelledAck(id: string, runId: string, key: string, timeoutMs: number): void {
    const cleanup = () => {
      clearTimeout(timer);
      this._pendingRequests.delete(id);
    };
    const timer = setTimeout(cleanup, timeoutMs);
    timer.unref();
    this._pendingRequests.set(id, {
      resolve: cleanup,
      reject: cleanup,
      onProgress: response => {
        if (response.payload?.runId !== runId) { return; }
        this._abortRun(
          typeof response.payload.sessionKey === 'string' ? response.payload.sessionKey : key,
          runId,
          typeof response.payload.agentId === 'string' ? response.payload.agentId : undefined,
        );
        cleanup();
      },
    });
  }

  /** Disconnect and wake all readers before releasing their socket. */
  disconnect(): void {
    this._disposed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._cancelConnect?.();
    this._connecting = null;
    const ws = this._ws;
    this._ws = null;
    this._connected = false;
    this._rejectPending(new Error('OpenClaw Gateway disconnected'));
    this._eventListeners.clear();
    ws?.terminate();
  }

  setUrl(url: string): void {
    if (url === this._url) { return; }
    this.disconnect();
    this._url = url;
    this._disposed = false;
  }

  // --- Active Mode: Channel & Status Methods ---

  /**
   * Query the daemon for its current status
   */
  async getGatewayStatus(): Promise<GatewayStatus | null> {
    if (!this.isConnected()) { return null; }
    try {
      const response = await this._sendRequest('health', {});
      if (response.ok && response.payload) {
        const p = response.payload as Record<string, unknown>;
        const channels = p.channels as Record<string, unknown> | undefined;
        const channelCount = channels ? Object.keys(channels).length : 0;
        const heartbeatSeconds = (p.heartbeatSeconds || 3600) as number;
        return {
          running: true,
          uptime: 0,
          version: 'unknown',
          heartbeatInterval: heartbeatSeconds,
          channelCount,
        };
      }
      return { running: true, uptime: 0, version: 'unknown', heartbeatInterval: 3600, channelCount: 0 };
    } catch {
      return null;
    }
  }

  /**
   * List all configured channels and their status.
   * Uses `channels.status` which returns channels keyed by channel ID.
   */
  async listChannels(): Promise<ChannelInfo[]> {
    if (!this.isConnected()) { return []; }
    try {
      const response = await this._sendRequest('channels.status', {});
      if (response.ok && response.payload) {
        const p = response.payload as Record<string, unknown>;
        const channelsMap = p.channels as Record<string, Record<string, unknown>> | undefined;
        const channelLabels = (p.channelLabels || {}) as Record<string, string>;
        if (channelsMap && typeof channelsMap === 'object') {
          return Object.entries(channelsMap).map(([id, ch]) => {
            const selfInfo = ch.self as Record<string, unknown> | undefined;
            return {
              id,
              type: id,
              name: channelLabels[id] || id,
              // OpenClaw treats linked channels as operational — it connects on-demand.
              // Map both connected AND linked to 'connected' so the prompt snippet is injected.
              status: ((ch.connected || ch.linked) ? 'connected' : ch.configured ? 'disconnected' : 'error') as ChannelInfo['status'],
              connectedSince: ch.lastConnectedAt as number | undefined,
              lastActivity: (ch.lastMessageAt || ch.lastEventAt) as number | undefined,
              metadata: {
                configured: ch.configured,
                linked: ch.linked,
                running: ch.running,
                connected: ch.connected,
                phoneNumber: selfInfo?.e164,
                jid: selfInfo?.jid,
              },
            };
          });
        }
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Initiate channel connection/pairing
   */
  async connectChannel(type: string, _config: Record<string, unknown> = {}): Promise<ChannelConnectResult> {
    if (!this.isConnected()) {
      return { success: false, error: 'Gateway not connected' };
    }
    try {
      // Channel setup uses the wizard flow
      const response = await this._sendRequest('wizard.start', { wizard: 'channel-setup', channel: type });
      if (response.ok && response.payload) {
        return {
          success: true,
          channelId: response.payload.channelId as string | undefined,
          pairingData: {
            qrCode: response.payload.qrCode as string | undefined,
            authUrl: response.payload.authUrl as string | undefined,
            instructions: (response.payload.instructions || response.payload.message) as string | undefined,
          },
        };
      }
      return { success: false, error: response.error?.message || 'Channel setup failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Disconnect a channel
   */
  async disconnectChannel(channelId: string): Promise<boolean> {
    if (!this.isConnected()) { return false; }
    try {
      const response = await this._sendRequest('channels.logout', { channel: channelId });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Send a message directly to a channel via the Gateway's `send` RPC.
   * Uses the direct delivery path (not the `chat.send` agent pipeline).
   */
  async sendToChannel(channelId: string, message: string, target?: string): Promise<boolean> {
    if (!this.isConnected()) {
      console.log('[Mysti] OpenClaw Gateway: Cannot send — not connected');
      return false;
    }
    if (!target) {
      console.log('[Mysti] OpenClaw Gateway: Cannot send — no recipient (to) address');
      return false;
    }
    try {
      const idempotencyKey = `mysti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const params: Record<string, unknown> = {
        channel: channelId,
        message,
        to: target,
        idempotencyKey,
      };
      console.log(`[Mysti] OpenClaw Gateway: send to '${channelId}' (to: ${target})`);
      const response = await this._sendRequest('send', params);
      if (!response.ok) {
        console.log('[Mysti] OpenClaw Gateway: send failed:', JSON.stringify(response.error || response.payload));
      } else {
        console.log('[Mysti] OpenClaw Gateway: send succeeded');
      }
      return response.ok === true;
    } catch (err) {
      console.log('[Mysti] OpenClaw Gateway: send error:', err);
      return false;
    }
  }

  /**
   * Delegate a task to the OpenClaw agent via the `chat.send` RPC.
   * Routes through the agent pipeline — the agent can use tools (message, exec,
   * browse, etc.) and resolve fuzzy contact names.
   */
  async sendAgentTask(prompt: string, sessionKey: string = 'main'): Promise<boolean> {
    if (!this.isConnected()) {
      console.log('[Mysti] OpenClaw Gateway: Cannot delegate — not connected');
      return false;
    }
    try {
      const idempotencyKey = `mysti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[Mysti] OpenClaw Gateway: chat.send (session: ${sessionKey}, ${prompt.length} chars)`);
      const response = await this._sendRequest('chat.send', {
        sessionKey,
        idempotencyKey,
        message: prompt,
      });
      if (!response.ok) {
        console.log('[Mysti] OpenClaw Gateway: chat.send failed:', JSON.stringify(response.error || response.payload));
      } else {
        console.log('[Mysti] OpenClaw Gateway: chat.send accepted');
      }
      return response.ok === true;
    } catch (err) {
      console.log('[Mysti] OpenClaw Gateway: chat.send error:', err);
      return false;
    }
  }

  /**
   * Subscribe to channel events (messages, connect/disconnect, pairing)
   * Returns a cleanup function to unsubscribe.
   */
  subscribeToChannelEvents(handler: (event: ChannelEvent) => void): () => void {
    const wrappedHandler = (payload: Record<string, unknown>) => {
      handler({
        channelId: (payload.channelId || payload.channel_id || '') as string,
        channelType: (payload.channelType || payload.channel_type || '') as string,
        eventType: (payload.eventType || payload.event_type || 'message_received') as ChannelEvent['eventType'],
        content: payload.content as string | undefined,
        sender: (payload.sender || payload.from) as string | undefined,
        timestamp: (payload.timestamp || Date.now()) as number,
      });
    };
    this._addEventListener('channel', wrappedHandler);
    return () => this._removeEventListener('channel', wrappedHandler);
  }

  /**
   * Fetch recent cross-channel activity log
   */
  async getActivityLog(_limit: number = 50): Promise<ActivityEntry[]> {
    // Activity log is maintained client-side from channel events.
    // The gateway does not expose a persistent activity.log method.
    return [];
  }

  // --- Session history methods (for inbound message polling) ---

  /**
   * List active sessions from the Gateway.
   * Used to discover which channels/conversations have recent activity.
   */
  async listSessions(): Promise<SessionInfo[]> {
    if (!this.isConnected()) { return []; }
    try {
      const response = await this._sendRequest('sessions.list', {});
      if (response.ok && response.payload) {
        const sessions = response.payload.sessions as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(sessions)) {
          return sessions.map(s => ({
            sessionKey: (s.sessionKey || s.key || s.id || '') as string,
            lastActivity: (s.lastActivity || s.updatedAt || s.lastMessageAt) as number | undefined,
            messageCount: (s.messageCount || s.count) as number | undefined,
          }));
        }
        // If payload is a map of sessionKey -> info (alternative format)
        const entries = Object.entries(response.payload).filter(([k]) => k !== 'ok' && k !== 'status');
        if (entries.length > 0) {
          return entries.map(([key, val]) => {
            const info = val as Record<string, unknown> | undefined;
            return {
              sessionKey: key,
              lastActivity: (info?.lastActivity || info?.updatedAt) as number | undefined,
              messageCount: (info?.messageCount || info?.count) as number | undefined,
            };
          });
        }
      }
      return [];
    } catch (err) {
      console.log('[Mysti] OpenClaw Gateway: sessions.list error:', err);
      return [];
    }
  }

  /**
   * Fetch message history for a specific session.
   * Used to poll for new inbound messages.
   */
  async getSessionHistory(sessionKey: string, after?: number, limit: number = 20): Promise<SessionMessage[]> {
    if (!this.isConnected()) { return []; }
    try {
      const params: Record<string, unknown> = { sessionKey, limit };
      if (after) { params.after = after; }
      const response = await this._sendRequest('sessions.history', params);
      if (response.ok && response.payload) {
        const messages = (response.payload.messages || response.payload.history || response.payload.entries) as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(messages)) {
          return messages.map(m => ({
            role: (m.role || m.type || 'unknown') as string,
            content: (m.content || m.text || m.body || m.message || '') as string,
            timestamp: (m.timestamp || m.createdAt || m.time || 0) as number,
            from: (m.from || m.sender || m.source) as string | undefined,
          }));
        }
      }
      return [];
    } catch (err) {
      console.log('[Mysti] OpenClaw Gateway: sessions.history error:', err);
      return [];
    }
  }

  // --- Private methods ---

  private _nextId(): string {
    return String(++this._requestId);
  }

  private _sendFrame(frame: GatewayFrame): void {
    if (this._ws?.readyState !== WebSocket.OPEN) { throw new Error('Gateway not connected'); }
    this._ws.send(JSON.stringify(frame));
  }

  private _rejectPending(error: Error): void {
    const pending = [...this._pendingRequests.values()];
    this._pendingRequests.clear();
    pending.forEach(request => request.reject(error));
  }

  private _sendRequest(method: string, params: Record<string, unknown>): Promise<GatewayResponse> {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Gateway request '${method}' timed out`));
      }, 30000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        this._pendingRequests.delete(id);
        reject(error);
      };
      this._pendingRequests.set(id, {
        resolve: response => { clearTimeout(timeout); resolve(response); },
        reject: fail,
      });
      try { this._sendFrame({ type: 'req', id, method, params }); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private _handleMessage(frame: GatewayFrame): void {
    if (!frame || typeof frame !== 'object') { return; }
    if (frame.type === 'res') {
      const pending = this._pendingRequests.get(frame.id);
      if (!pending) { return; }
      const status = frame.payload?.status;
      if (frame.ok && pending.onProgress && typeof status === 'string' &&
          ['accepted', 'pending', 'running'].includes(status)) {
        pending.onProgress(frame);
        return;
      }
      this._pendingRequests.delete(frame.id);
      pending.resolve(frame);
    } else if (frame.type === 'event') {
      if (!frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) { return; }
      for (const listener of [...(this._eventListeners.get(frame.event) || [])]) {
        try { listener(frame.payload, frame.seq); }
        catch { console.warn('[Mysti] OpenClaw Gateway: Event listener failed'); }
      }
      if (frame.event === 'shutdown') {
        this._connected = false;
        this._rejectPending(new Error('OpenClaw Gateway shut down'));
        this._ws?.close();
      }
    }
  }

  private _addEventListener(event: string, handler: (payload: Record<string, unknown>, seq?: number) => void): void {
    const listeners = this._eventListeners.get(event) || [];
    listeners.push(handler);
    this._eventListeners.set(event, listeners);
  }

  private _removeEventListener(event: string, handler: (payload: Record<string, unknown>, seq?: number) => void): void {
    const listeners = this._eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(handler);
      if (index >= 0) {
        listeners.splice(index, 1);
        if (listeners.length === 0) { this._eventListeners.delete(event); }
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectTimer || this._reconnectAttempts >= this._maxReconnectAttempts) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;

    console.log(`[Mysti] OpenClaw Gateway: Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._disposed) {
        await this.connect();
      }
    }, delay);
  }
}
