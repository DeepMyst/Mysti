/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GatewayDeviceSigner } from './OpenClawDeviceIdentity';
import WebSocket from 'ws';
import type { StreamChunk } from '../../types';
import { OPENCLAW_GATEWAY_TIMEOUT_MS } from '../../constants';
import { toolKind } from '../../utils/toolNames';

/**
 * Options for sending an agent message via the Gateway
 */
export interface GatewayAgentOptions {
  thinking?: string;
  sessionKey?: string;
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
  private _permanentFailure = false;
  private _connecting?: Promise<boolean>;
  private _agentRuns = new Map<string, { sessionKey: string; runId?: string; cancel(): void }>();
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = 5;
  private _pendingRequests: Map<string, {
    resolve: (value: GatewayResponse) => void;
    reject: (reason: Error) => void;
  }> = new Map();
  private _eventListeners: Map<string, ((payload: Record<string, unknown>, seq?: number) => void)[]> = new Map();
  private _disposed: boolean = false;
  private _token: string | undefined;

  constructor(url: string = 'ws://127.0.0.1:18789', token?: string, private readonly _signDevice?: GatewayDeviceSigner) {
    this._url = url;
    this._token = token;
  }

  /**
   * Attempt to connect to the OpenClaw Gateway
   * Returns true if connection succeeds, false otherwise
   */
  async connect(): Promise<boolean> {
    if (this._connecting) { return this._connecting; }
    this._disposed = false;
    this._permanentFailure = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._connecting = this._connect();
    try { return await this._connecting; } finally { this._connecting = undefined; }
  }

  private async _connect(): Promise<boolean> {
    if (this._connected && this._ws?.readyState === WebSocket.OPEN) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      try {
        const socket = new WebSocket(this._url);
        this._ws = socket;
        let resolved = false;

        const cleanup = () => {
          if (challengeHandler) {
            this._removeEventListener('connect.challenge', challengeHandler);
          }
        };

        const fail = (reason: string) => {
          if (!resolved) {
            resolved = true;
            cleanup();
            console.log('[Mysti] OpenClaw Gateway:', reason);
            clearTimeout(timeout);
            socket.close();
            resolve(false);
          }
        };

        // Overall timeout for the entire connect flow (WebSocket open + challenge + handshake)
        const timeout = setTimeout(() => {
          fail('Connection timeout');
          socket.terminate();
        }, 10000);

        // One-shot handler for the connect.challenge event from the gateway
        const challengeHandler = async (_payload: Record<string, unknown>) => {
          cleanup(); // Remove listener after first call
          console.log('[Mysti] OpenClaw Gateway: Challenge received, sending connect...');

          try {
            const scopes = ['operator.admin', 'operator.read', 'operator.write'];
            const nonce = typeof _payload.nonce === 'string' ? _payload.nonce : '';
            if (this._signDevice && !nonce) { throw new Error('Gateway did not provide a device challenge'); }
            const device = this._signDevice ? await this._signDevice({ nonce, token: this._token, scopes }) : undefined;
            if (resolved || this._disposed || this._ws !== socket) { return; }
            const params: Record<string, unknown> = {
              minProtocol: 3,
              maxProtocol: 4,
              client: {
                id: 'cli',
                version: '1.0.0',
                platform: process.platform,
                mode: 'cli',
              },
              role: 'operator',
              scopes,
              ...(device ? { device } : {}),
              caps: [],
              auth: this._token ? { token: this._token } : {},
              locale: 'en-US',
            };

            const response = await this._sendRequest('connect', params);

            if (resolved || this._disposed || this._ws !== socket) { return; }
            clearTimeout(timeout);
            if (response.ok) {
              this._connected = true;
              this._reconnectAttempts = 0;
              resolved = true;
              console.log('[Mysti] OpenClaw Gateway: Handshake complete');
              resolve(true);
            } else {
              this._permanentFailure = response.error?.code !== 'UNAVAILABLE';
              fail('Handshake rejected: ' + (response.error ? JSON.stringify(response.error) : 'unknown'));
            }
          } catch (err) {
            fail('Handshake error: ' + err);
          }
        };

        // Register the challenge listener before opening so it's ready
        // when the first message arrives
        this._addEventListener('connect.challenge', challengeHandler);

        socket.on('open', () => {
          console.log('[Mysti] OpenClaw Gateway: WebSocket connected, waiting for challenge...');
          // Don't send anything yet — wait for connect.challenge event
        });

        socket.on('message', (data: WebSocket.Data) => {
          if (this._ws !== socket) { return; }
          this._handleMessage(data);
        });

        socket.on('close', () => {
          if (this._ws !== socket) { return; }
          this._connected = false;
          console.log('[Mysti] OpenClaw Gateway: Disconnected');
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            cleanup();
            resolve(false);
          }
          for (const pending of this._pendingRequests.values()) { pending.reject(new Error('OpenClaw Gateway disconnected')); }
          this._pendingRequests.clear();
          if (!this._disposed && !this._permanentFailure) {
            this._scheduleReconnect();
          }
        });

        socket.on('error', (err) => {
          if (this._ws !== socket) { return; }
          console.log('[Mysti] OpenClaw Gateway: Connection error:', err.message);
          this._connected = false;
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            cleanup();
            resolve(false);
          }
        });
      } catch (err) {
        console.log('[Mysti] OpenClaw Gateway: Failed to create WebSocket:', err);
        resolve(false);
      }
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
  async *sendAgentMessage(
    message: string,
    options: GatewayAgentOptions = {}
  ): AsyncGenerator<StreamChunk> {
    if (!this.isConnected()) {
      throw new Error('Gateway not connected');
    }

    const requestId = this._nextId();
    const sessionKey = options.sessionKey || 'main';
    let streamedText = false;
    // Create a message queue for this request
    const chunks: StreamChunk[] = [];
    let done = false;
    let error: Error | null = null;
    let resolveWait: (() => void) | null = null;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;

    const notify = () => {
      if (waitTimer) { clearTimeout(waitTimer); waitTimer = undefined; }
      if (resolveWait) {
        const fn = resolveWait;
        resolveWait = null;
        fn();
      }
    };

    const run = { sessionKey, runId: undefined as string | undefined, cancel: () => { done = true; notify(); } };
    this._agentRuns.set(requestId, run);

    // Listen for events belonging to this run only.
    const eventHandler = (payload: Record<string, unknown>, _seq?: number) => {
      if (done) { return; }
      if (run.runId ? payload.runId !== run.runId : payload.sessionKey !== sessionKey) { return; }
      const chunk = this._mapEventToChunk(payload);
      if (chunk) {
        if (chunk.type === 'text') { streamedText = true; }
        chunks.push(chunk);
        notify();
      }
    };
    const eventNames = ['agent', 'chat', 'stream', 'message', 'response'];
    for (const name of eventNames) {
      this._addEventListener(name, eventHandler);
    }

    // Listen for the response (ack + final)
    const responsePromise = new Promise<GatewayResponse>((resolve, reject) => {
      // For the agent method, we get two responses:
      // 1. Immediate ack with status "accepted"
      // 2. Final with status "ok" or "error"
      // The pending request handler will resolve on the final one.
      this._pendingRequests.set(requestId, { resolve, reject });
    });

    // Send the agent request
    const idempotencyKey = `mysti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const params: Record<string, unknown> = { message, idempotencyKey, sessionKey };
    if (options.thinking) { params.thinking = options.thinking; }

    this._sendFrame({
      type: 'req',
      id: requestId,
      method: 'agent',
      params
    });

    // Handle the response asynchronously
    responsePromise.then((response) => {
      if (done) { return; }
      if (!response.ok) {
        const errMsg = response.error?.message || 'Agent request failed';
        chunks.push({ type: 'error', content: errMsg });
      } else if (response.payload && !streamedText) {
        // Extract content from the final response payload if no streaming events provided it
        const p = response.payload;
        const text = (p.text || p.content || p.message || p.response || p.output || p.result) as string | undefined;
        if (text && typeof text === 'string') {
          chunks.push({ type: 'text', content: text });
        }
        // Check for payloads array (batch format)
        const payloads = p.payloads as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(payloads)) {
          for (const item of payloads) {
            const itemText = (item.text || item.content) as string | undefined;
            if (itemText) {
              chunks.push({ type: 'text', content: itemText });
            }
          }
        }
      }
      done = true;
      notify();
    }).catch((err: unknown) => {
      error = err instanceof Error ? err : new Error(String(err));
      done = true;
      notify();
    });

    // Yield chunks as they arrive
    const overallStart = Date.now();
    try {
      while (!done || chunks.length > 0) {
        // Check overall timeout to prevent infinite spinner
        if (Date.now() - overallStart > OPENCLAW_GATEWAY_TIMEOUT_MS) {
          yield { type: 'error', content: 'OpenClaw Gateway: Request timed out' };
          break;
        }

        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else if (!done) {
          // Wait for more data
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
            // Safety timeout to prevent infinite wait
            waitTimer = setTimeout(() => {
              if (resolveWait === resolve) {
                resolveWait = null;
                resolve();
              }
            }, 30000);
          });
        }
      }

      // error may be set by the async .catch() handler above
      const finalError = error as Error | null;
      if (finalError) {
        yield { type: 'error', content: finalError.message };
      }
    } finally {
      if (waitTimer) { clearTimeout(waitTimer); }
      for (const name of eventNames) {
        this._removeEventListener(name, eventHandler);
      }
      if (!done) { void this.cancelAgent(sessionKey); }
      this._agentRuns.delete(requestId);
      this._pendingRequests.delete(requestId);
    }
  }

  /**
   * Cancel a running agent request
   */
  async cancelAgent(sessionKey?: string): Promise<void> {
    const runs = [...this._agentRuns.values()].filter(run => !sessionKey || run.sessionKey === sessionKey);
    await Promise.all(runs.map(async run => {
      run.cancel();
      if (!this.isConnected()) { return; }
      try {
        await this._sendRequest('chat.abort', { sessionKey: run.sessionKey, ...(run.runId ? { runId: run.runId } : {}) });
      } catch { /* connection loss already settles the local stream */ }
    }));
  }

  /**
   * Disconnect from the Gateway
   */
  disconnect(): void {
    this._disposed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.removeAllListeners();
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.close();
      }
      this._ws = null;
    }
    this._connected = false;
    for (const pending of this._pendingRequests.values()) { pending.reject(new Error('OpenClaw Gateway disconnected')); }
    this._pendingRequests.clear();
    this._agentRuns.clear();
    this._eventListeners.clear();
  }

  /**
   * Update the Gateway URL
   */
  setUrl(url: string): void {
    if (url !== this._url) {
      this._url = url;
      if (this._connected) {
        this.disconnect();
        this._disposed = false;
      }
    }
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
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(frame));
    }
  }

  private _sendRequest(method: string, params: Record<string, unknown>): Promise<GatewayResponse> {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Gateway request '${method}' timed out`));
      }, 30000);

      this._pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this._sendFrame({ type: 'req', id, method, params });
    });
  }

  private _handleMessage(data: WebSocket.Data): void {
    try {
      const frame = JSON.parse(data.toString()) as GatewayFrame;

      if (frame.type === 'res') {
        const pending = this._pendingRequests.get(frame.id);
        if (pending) {
          // For agent requests, intermediate responses have ack-like statuses.
          // The final response has status "ok", "error", or no status field.
          const status = (frame.payload as Record<string, unknown>)?.status as string | undefined;
          if (status === 'accepted' || status === 'pending' || status === 'running') {
            const run = this._agentRuns.get(frame.id);
            if (run && typeof frame.payload?.runId === 'string') { run.runId = frame.payload.runId; }
            // Ack — don't resolve yet, wait for the final response
            console.log('[Mysti] OpenClaw Gateway: Agent run ack, status:', status,
              'runId:', (frame.payload as Record<string, unknown>)?.runId);
            return;
          }
          this._pendingRequests.delete(frame.id);
          pending.resolve(frame as GatewayResponse);
        }
      } else if (frame.type === 'event') {
        // Event bodies can contain private messages; do not dump them to logs.

        const listeners = this._eventListeners.get(frame.event);
        if (listeners) {
          for (const listener of listeners) {
            listener(frame.payload, frame.seq);
          }
        }

        // Handle shutdown
        if (frame.event === 'shutdown') {
          console.log('[Mysti] OpenClaw Gateway: Shutdown event received:', frame.payload);
          this._connected = false;
        }
      }
    } catch (err) {
      console.log('[Mysti] OpenClaw Gateway: Failed to parse message:', err);
    }
  }

  /**
   * Map a Gateway agent event payload to a Mysti StreamChunk
   */
  private _mapEventToChunk(payload: Record<string, unknown>): StreamChunk | null {
    // --- OpenClaw Gateway native format ---
    // Agent events: {stream: "assistant"|"thinking", data: {delta: "...", text: "..."}, ...}
    // Chat events:  {state: "delta", message: {role, content: [{type, text}]}, ...}
    // Lifecycle:    {stream: "lifecycle", data: {phase: "start"|"end"}, ...}
    const stream = payload.stream as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;
    const state = payload.state as string | undefined;

    if (stream === 'assistant' && data) {
      const delta = data.delta as string | undefined;
      if (delta) {
        return { type: 'text', content: delta };
      }
      return null;
    }

    if (stream === 'thinking' && data) {
      const delta = data.delta as string | undefined;
      if (delta) {
        return { type: 'thinking', content: delta };
      }
      return null;
    }

    if (stream === 'lifecycle' && data) {
      // Lifecycle end is NOT surfaced as a done chunk: the provider's
      // _sendViaGateway yields the single authoritative done after the
      // generator finishes (Plan 02 Phase 3: exactly one done per response).
      // Loop termination in sendAgentMessage is driven by the final Gateway
      // response, not by this chunk.
      return null;
    }

    // Chat delta events — skip to avoid duplicate text (agent events already provide deltas)
    if (state === 'delta' && payload.message) {
      return null;
    }

    // --- Legacy/fallback format (payload.type based) ---
    const eventType = (payload.type || payload.event_type || '') as string;

    // Text content
    if (eventType === 'text' || eventType === 'content' || eventType === 'assistant') {
      const content = (payload.content || payload.text || payload.delta) as string | undefined;
      if (content) {
        return { type: 'text', content: typeof content === 'string' ? content : JSON.stringify(content) };
      }
      return null;
    }

    // Thinking/reasoning content
    if (eventType === 'thinking' || eventType === 'reasoning') {
      const content = (payload.content || payload.thinking || payload.text) as string | undefined;
      if (content) {
        return { type: 'thinking', content };
      }
      return null;
    }

    // Tool call started
    if (eventType === 'tool_call' || eventType === 'tool.call' || eventType === 'tool_use') {
      const status = (payload.status || 'running') as string;
      if (status === 'completed' || status === 'done') {
        return {
          type: 'tool_result',
          toolCall: {
            id: (payload.id || payload.tool_call_id || '') as string,
            name: (payload.name || payload.tool || '') as string,
            input: (payload.input || payload.arguments || {}) as Record<string, unknown>,
            output: (payload.output || payload.result || '') as string,
            status: 'completed',
          }
        };
      }
      return {
        type: 'tool_use',
        toolCall: {
          id: (payload.id || payload.tool_call_id || `tool_${Date.now()}`) as string,
          name: (payload.name || payload.tool || 'unknown') as string,
          input: (payload.input || payload.arguments || {}) as Record<string, unknown>,
          status: 'running',
          kind: toolKind((payload.name || payload.tool || '') as string),
        }
      };
    }

    // Tool result (standalone event)
    if (eventType === 'tool_result' || eventType === 'tool.output') {
      return {
        type: 'tool_result',
        toolCall: {
          id: (payload.tool_use_id || payload.tool_id || '') as string,
          name: (payload.tool_name || '') as string,
          input: {},
          output: typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content || ''),
          status: (payload.is_error ? 'failed' : 'completed') as 'failed' | 'completed',
        }
      };
    }

    // Tool error
    if (eventType === 'tool.error' || eventType === 'tool_error') {
      return {
        type: 'tool_result',
        toolCall: {
          id: (payload.tool_id || '') as string,
          name: (payload.tool_name || '') as string,
          input: {},
          output: (payload.error || payload.message || 'Tool error') as string,
          status: 'failed',
        }
      };
    }

    // Block/chunk streaming (OpenClaw-specific)
    if (eventType === 'block' || eventType === 'chunk') {
      const content = (payload.content || payload.text || payload.data) as string | undefined;
      if (content) {
        return { type: 'text', content };
      }
      return null;
    }

    // Error
    if (eventType === 'error') {
      return {
        type: 'error',
        content: (payload.error || payload.message || 'Unknown Gateway error') as string,
      };
    }

    // Done/complete — swallowed; see the lifecycle handler above
    // (exactly one done per response, emitted by _sendViaGateway).
    if (eventType === 'done' || eventType === 'complete' || eventType === 'end') {
      return null;
    }

    // Step completion — extract tool/text content instead of dropping
    if (eventType === 'step_completed' || eventType === 'agent.step_completed') {
      console.log('[Mysti] OpenClaw Gateway: Step completed:', payload);

      const toolName = (payload.tool || payload.name || payload.step_name || '') as string;
      const output = (payload.output || payload.result || payload.text || payload.content || '') as string;
      const toolId = (payload.id || payload.tool_id || payload.step_id || '') as string;

      if (toolName || output) {
        return {
          type: 'tool_result',
          toolCall: {
            id: toolId || `step_${Date.now()}`,
            name: toolName || 'step',
            input: {},
            output: typeof output === 'string' ? output : JSON.stringify(output),
            status: 'completed' as const,
          }
        };
      }

      const textContent = (payload.summary || payload.message) as string | undefined;
      if (textContent) {
        return { type: 'text', content: textContent };
      }

      return null;
    }

    // Unknown event type — try to extract text content before discarding
    if (eventType) {
      console.log('[Mysti] OpenClaw Gateway: Unknown event type:', eventType, payload);

      const textContent = (
        payload.content || payload.text || payload.message ||
        payload.delta || payload.data || payload.output || payload.result
      ) as string | Record<string, unknown> | undefined;

      if (textContent) {
        const content = typeof textContent === 'string'
          ? textContent
          : JSON.stringify(textContent);
        if (content && content !== '{}' && content !== '""') {
          return { type: 'text', content };
        }
      }
    }

    return null;
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
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectAttempts >= this._maxReconnectAttempts) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;

    console.log(`[Mysti] OpenClaw Gateway: Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(async () => {
      if (!this._disposed) {
        await this.connect();
      }
    }, delay);
  }
}
