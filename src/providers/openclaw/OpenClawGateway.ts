/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import WebSocket from 'ws';
import type { StreamChunk } from '../../types';
import { OPENCLAW_GATEWAY_TIMEOUT_MS } from '../../constants';

/**
 * Options for sending an agent message via the Gateway
 */
export interface GatewayAgentOptions {
  thinking?: string;
  elevated?: string;
  model?: string;
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
  }> = new Map();
  private _eventListeners: Map<string, ((payload: Record<string, unknown>, seq?: number) => void)[]> = new Map();
  private _disposed: boolean = false;

  constructor(url: string = 'ws://127.0.0.1:18789') {
    this._url = url;
  }

  /**
   * Attempt to connect to the OpenClaw Gateway
   * Returns true if connection succeeds, false otherwise
   */
  async connect(): Promise<boolean> {
    if (this._connected && this._ws?.readyState === WebSocket.OPEN) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      try {
        this._ws = new WebSocket(this._url);

        const timeout = setTimeout(() => {
          if (!this._connected) {
            this._ws?.terminate();
            console.log('[Mysti] OpenClaw Gateway: Connection timeout');
            resolve(false);
          }
        }, 5000);

        this._ws.on('open', async () => {
          clearTimeout(timeout);
          console.log('[Mysti] OpenClaw Gateway: WebSocket connected');

          // Send protocol handshake
          try {
            const response = await this._sendRequest('connect', {
              minProtocol: 1,
              maxProtocol: 1,
              client: { name: 'mysti', version: '1.0.0' }
            });

            if (response.ok) {
              this._connected = true;
              this._reconnectAttempts = 0;
              console.log('[Mysti] OpenClaw Gateway: Handshake complete');
              resolve(true);
            } else {
              console.log('[Mysti] OpenClaw Gateway: Handshake rejected:', response.error);
              this._ws?.close();
              resolve(false);
            }
          } catch (err) {
            console.log('[Mysti] OpenClaw Gateway: Handshake error:', err);
            this._ws?.close();
            resolve(false);
          }
        });

        this._ws.on('message', (data: WebSocket.Data) => {
          this._handleMessage(data);
        });

        this._ws.on('close', () => {
          this._connected = false;
          console.log('[Mysti] OpenClaw Gateway: Disconnected');
          if (!this._disposed) {
            this._scheduleReconnect();
          }
        });

        this._ws.on('error', (err) => {
          clearTimeout(timeout);
          console.log('[Mysti] OpenClaw Gateway: Connection error:', err.message);
          this._connected = false;
          resolve(false);
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
    // Create a message queue for this request
    const chunks: StreamChunk[] = [];
    let done = false;
    let error: Error | null = null;
    let resolveWait: (() => void) | null = null;

    const notify = () => {
      if (resolveWait) {
        const fn = resolveWait;
        resolveWait = null;
        fn();
      }
    };

    // Listen for agent events
    const eventHandler = (payload: Record<string, unknown>, _seq?: number) => {
      const chunk = this._mapEventToChunk(payload);
      if (chunk) {
        chunks.push(chunk);
        notify();
      }
    };
    this._addEventListener('agent', eventHandler);

    // Listen for the response (ack + final)
    const responsePromise = new Promise<GatewayResponse>((resolve, reject) => {
      // For the agent method, we get two responses:
      // 1. Immediate ack with status "accepted"
      // 2. Final with status "ok" or "error"
      // The pending request handler will resolve on the final one.
      this._pendingRequests.set(requestId, { resolve, reject });
    });

    // Send the agent request
    const params: Record<string, unknown> = { message };
    if (options.thinking) { params.thinking = options.thinking; }
    if (options.elevated) { params.elevated = options.elevated; }
    if (options.model) { params.model = options.model; }

    this._sendFrame({
      type: 'req',
      id: requestId,
      method: 'agent',
      params
    });

    // Handle the response asynchronously
    responsePromise.then((response) => {
      if (!response.ok) {
        const errMsg = response.error?.message || 'Agent request failed';
        chunks.push({ type: 'error', content: errMsg });
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
            setTimeout(() => {
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
      this._removeEventListener('agent', eventHandler);
      this._pendingRequests.delete(requestId);
    }
  }

  /**
   * Cancel a running agent request
   */
  async cancelAgent(): Promise<void> {
    if (!this.isConnected()) { return; }

    try {
      await this._sendRequest('agent.stop', {});
    } catch {
      // Best effort cancel
    }
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
    this._pendingRequests.clear();
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
      const response = await this._sendRequest('gateway.status', {});
      if (response.ok && response.payload) {
        return {
          running: true,
          uptime: (response.payload.uptime || 0) as number,
          version: (response.payload.version || 'unknown') as string,
          heartbeatInterval: (response.payload.heartbeatInterval || 1800) as number,
          channelCount: (response.payload.channelCount || 0) as number,
        };
      }
      return { running: true, uptime: 0, version: 'unknown', heartbeatInterval: 1800, channelCount: 0 };
    } catch {
      return null;
    }
  }

  /**
   * List all configured channels and their status
   */
  async listChannels(): Promise<ChannelInfo[]> {
    if (!this.isConnected()) { return []; }
    try {
      const response = await this._sendRequest('channels.list', {});
      if (response.ok && response.payload) {
        const channels = (response.payload.channels || response.payload) as unknown;
        if (Array.isArray(channels)) {
          return channels.map((ch: Record<string, unknown>) => ({
            id: (ch.id || '') as string,
            type: (ch.type || ch.channel_type || 'unknown') as string,
            name: (ch.name || ch.label || '') as string,
            status: (ch.status || 'disconnected') as ChannelInfo['status'],
            connectedSince: ch.connectedSince as number | undefined,
            lastActivity: (ch.lastActivity || ch.last_activity) as number | undefined,
            metadata: (ch.metadata || {}) as Record<string, unknown>,
          }));
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
  async connectChannel(type: string, config: Record<string, unknown> = {}): Promise<ChannelConnectResult> {
    if (!this.isConnected()) {
      return { success: false, error: 'Gateway not connected' };
    }
    try {
      const response = await this._sendRequest('channels.connect', { type, ...config });
      if (response.ok && response.payload) {
        return {
          success: true,
          channelId: response.payload.channelId as string | undefined,
          pairingData: {
            qrCode: response.payload.qrCode as string | undefined,
            authUrl: response.payload.authUrl as string | undefined,
            instructions: response.payload.instructions as string | undefined,
          },
        };
      }
      return { success: false, error: response.error?.message || 'Connection failed' };
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
      const response = await this._sendRequest('channels.disconnect', { channelId });
      return response.ok;
    } catch {
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
  async getActivityLog(limit: number = 50): Promise<ActivityEntry[]> {
    if (!this.isConnected()) { return []; }
    try {
      const response = await this._sendRequest('activity.log', { limit });
      if (response.ok && response.payload) {
        const entries = (response.payload.entries || response.payload) as unknown;
        if (Array.isArray(entries)) {
          return entries.map((e: Record<string, unknown>) => ({
            timestamp: (e.timestamp || Date.now()) as number,
            source: (e.source || 'unknown') as string,
            action: (e.action || e.message || '') as string,
            details: e.details as string | undefined,
          }));
        }
      }
      return [];
    } catch {
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
            // Ack — don't resolve yet, wait for the final response
            console.log('[Mysti] OpenClaw Gateway: Agent run ack, status:', status,
              'runId:', (frame.payload as Record<string, unknown>)?.runId);
            return;
          }
          this._pendingRequests.delete(frame.id);
          pending.resolve(frame as GatewayResponse);
        }
      } else if (frame.type === 'event') {
        const listeners = this._eventListeners.get(frame.event);
        if (listeners) {
          for (const listener of listeners) {
            listener(frame.payload, frame.seq);
          }
        }

        // Handle tick (keepalive) silently
        if (frame.event === 'tick') {
          return;
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

    // Done/complete
    if (eventType === 'done' || eventType === 'complete' || eventType === 'end') {
      return { type: 'done' };
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
