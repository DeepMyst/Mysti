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
import { randomUUID } from 'crypto';
import type { StreamChunk, ToolCall } from '../../types';
import { OPENCLAW_GATEWAY_TIMEOUT_MS } from '../../constants';
import { toolKind } from '../../utils/toolNames';
import { readOpenClawRunMetadata, type OpenClawRunMetadata } from './OpenClawRunMetadata';
import { openClawAssistantPhase, openClawVisibleText } from './OpenClawAssistantText';

/**
 * Options for sending an agent message via the Gateway
 */
export interface GatewayAgentOptions {
  thinking?: string;
  sessionKey?: string;
  /** One-shot draft generation using OpenClaw's tool-free model-run mode. */
  textOnly?: boolean;
  /** Local observer for the final run's totals and latest context measurement. */
  onRunMetadata?: (metadata: OpenClawRunMetadata) => void;
  /** Issuing request's local stored-credential snapshot; never sent on the wire. */
  diagnosticRedactor?: (text: string) => string;
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

type DiagnosticRedactor = (value: unknown) => string;

interface ActiveAgentRun {
  sessionKey: string;
  /** Native agent RPC reserves its idempotency key as runId before the ack. */
  requestRunId: string;
  runId?: string;
  cancellation?: Promise<void>;
  cancel(): void;
  fail(message: string): void;
}

/** Diagnostics may wrap an Error, but must never dump its request/arguments. */
function diagnosticMessage(value: unknown, depth = 0): string {
  if (typeof value === 'string') { return value; }
  if (value && typeof value === 'object' && depth < 4) {
    const wrapped = value as Record<string, unknown>;
    return diagnosticMessage(wrapped.message ?? wrapped.error, depth + 1);
  }
  return 'Unknown Gateway error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Native tool results contain text/image blocks; only text belongs in a card. */
function toolOutput(value: unknown, failed = false): string {
  if (typeof value === 'string') { return value; }
  if (value === undefined || value === null) { return failed ? 'Tool failed' : ''; }
  if (isRecord(value) && Array.isArray(value.content)) {
    return value.content.filter((block): block is { type: 'text'; text: string } =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n');
  }
  return failed ? diagnosticMessage(value) : JSON.stringify(value ?? '');
}

function createDiagnosticRedactor(url: string, token?: string): DiagnosticRedactor {
  const secrets = new Set<string>();
  if (token) { secrets.add(token); }
  try {
    const parsed = new URL(url);
    for (const value of [parsed.username, parsed.password, ...parsed.searchParams.values()]) {
      if (!value) { continue; }
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
      secrets.add(encodeURIComponent(value).replace(/%20/g, '+'));
      try { secrets.add(decodeURIComponent(value)); } catch { /* Keep literal malformed escapes. */ }
    }
  } catch { /* Invalid URLs are reported without their contents. */ }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return value => {
    let safe = diagnosticMessage(value);
    for (const secret of values) { safe = safe.split(secret).join('[REDACTED]'); }
    return safe
      .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/_=.-]{8,}/gi, '$1[REDACTED]')
      .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[REDACTED]');
  };
}

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
  private _lastEventSeq?: number;
  private _connected: boolean = false;
  private _permanentFailure = false;
  private _connecting?: Promise<boolean>;
  private _cancelConnect?: () => void;
  private _agentRuns = new Map<string, ActiveAgentRun>();
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
  private _redactDiagnostic: DiagnosticRedactor;

  constructor(
    url: string = 'ws://127.0.0.1:18789',
    token?: string,
    private readonly _signDevice?: GatewayDeviceSigner,
    private readonly _readToken?: () => string | undefined,
    private readonly _backendRedactor?: () => (text: string) => string,
  ) {
    this._url = url;
    this._token = token;
    this._redactDiagnostic = createDiagnosticRedactor(url, token);
  }

  /** Retain the issuing connection's credentials, including across rotation. */
  captureDiagnosticRedactor(): DiagnosticRedactor {
    const gatewayRedact = this._redactDiagnostic;
    const backendRedact = this._backendRedactor?.();
    return backendRedact ? value => backendRedact(gatewayRedact(value)) : gatewayRedact;
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
    const connecting = this._connect();
    this._connecting = connecting;
    try { return await connecting; } finally {
      if (this._connecting === connecting) { this._connecting = undefined; }
    }
  }

  private async _connect(): Promise<boolean> {
    if (this._connected && this._ws?.readyState === WebSocket.OPEN) {
      return true;
    }
    this._connected = false;
    this._lastEventSeq = undefined;

    // An earlier socket can still be closing after a failed handshake/error.
    // Retire its requests before assigning a replacement socket.
    if (this._ws) {
      const previous = this._ws;
      this._ws = null;
      this._cancelConnect?.();
      this._rejectPending('OpenClaw Gateway connection replaced');
      previous.terminate();
    }

    return new Promise<boolean>((resolve) => {
      const url = this._url;
      let redact = createDiagnosticRedactor(url, this._token);
      try {
        const socket = new WebSocket(url);
        this._ws = socket;
        let resolved = false;

        const cleanup = () => {
          if (challengeHandler) {
            this._removeEventListener('connect.challenge', challengeHandler);
          }
        };

        const finishConnect = (connected: boolean) => {
          if (!resolved) {
            resolved = true;
            cleanup();
            clearTimeout(timeout);
            if (this._cancelConnect === cancelConnect) { this._cancelConnect = undefined; }
            resolve(connected);
          }
        };
        const cancelConnect = () => finishConnect(false);
        this._cancelConnect = cancelConnect;
        const fail = (reason: string) => {
          if (resolved) { return; }
          console.log('[Mysti] OpenClaw Gateway:', redact(reason));
          finishConnect(false);
          socket.terminate();
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
            // Read again for every handshake so setup/rotation/removal works
            // without recreating the provider. Keep one snapshot across async
            // signing: the signed token and transmitted token must agree.
            const token = this._readToken ? this._readToken() : this._token;
            redact = createDiagnosticRedactor(url, token);
            this._redactDiagnostic = redact;
            const device = this._signDevice ? await this._signDevice({ nonce, token, scopes }) : undefined;
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
              caps: ['tool-events'],
              auth: token ? { token } : {},
              locale: 'en-US',
            };

            const response = await this._sendRequest('connect', params);

            if (resolved || this._disposed || this._ws !== socket) { return; }
            clearTimeout(timeout);
            if (response.ok) {
              this._connected = true;
              this._reconnectAttempts = 0;
              console.log('[Mysti] OpenClaw Gateway: Handshake complete');
              finishConnect(true);
            } else {
              this._permanentFailure = response.error?.code !== 'UNAVAILABLE';
              fail('Handshake rejected: ' + redact(response.error));
            }
          } catch (err) {
            fail('Handshake error: ' + redact(err));
          }
        };

        // Register the challenge listener before opening so it's ready
        // when the first message arrives
        this._addEventListener('connect.challenge', challengeHandler);

        socket.on('open', () => {
          if (this._ws !== socket || this._disposed) { socket.terminate(); return; }
          console.log('[Mysti] OpenClaw Gateway: WebSocket connected, waiting for challenge...');
          // Don't send anything yet — wait for connect.challenge event
        });

        socket.on('message', (data: WebSocket.Data) => {
          if (this._ws !== socket || (resolved && !this._connected)) { return; }
          this._handleMessage(data);
        });

        socket.on('close', () => {
          if (this._ws !== socket) { return; }
          this._connected = false;
          this._ws = null;
          console.log('[Mysti] OpenClaw Gateway: Disconnected');
          finishConnect(false);
          this._rejectPending('OpenClaw Gateway disconnected');
          if (!this._disposed && !this._permanentFailure) {
            this._scheduleReconnect();
          }
        });

        socket.on('error', (err) => {
          if (this._ws !== socket) { return; }
          console.log('[Mysti] OpenClaw Gateway: Connection error:', redact(err));
          this._connected = false;
          finishConnect(false);
          this._rejectPending('OpenClaw Gateway connection error: ' + redact(err));
          socket.terminate();
        });
      } catch {
        console.log('[Mysti] OpenClaw Gateway: Failed to create WebSocket; check the Gateway URL');
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

    const gatewayRedact = this.captureDiagnosticRedactor();
    const redact: DiagnosticRedactor = options.diagnosticRedactor
      ? value => options.diagnosticRedactor!(gatewayRedact(value)) : gatewayRedact;
    const requestId = this._nextId();
    const sessionKey = options.sessionKey || 'main';
    const idempotencyKey = `mysti-${randomUUID()}`;
    let streamedText = false;
    let commentary = '';
    let lastProgress = '';
    const activeTools = new Map<string, ToolCall>();
    const seenNativeEvents = new Set<string>();
    // Native text is a message snapshot, not necessarily an append delta.
    // Track each stream separately, within this request and tool/attempt segment.
    const nativeText = new Map<string, { snapshot: string; rendered: string; start: number; provisional: boolean }>();
    const textLengths = new Map<string, number>();
    // A lifecycle error can be followed by fallback on the same run. The
    // final RPC decides completion; retain the error unless recovery begins.
    let pendingRunError: string | undefined;
    let pendingRunAborted = false;
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

    const run: ActiveAgentRun = { sessionKey, requestRunId: idempotencyKey, runId: undefined,
      cancel: () => { done = true; notify(); }, fail: message => failStream(message),
    };
    this._agentRuns.set(requestId, run);

    const failStream = (message: string) => {
      if (done) { return; }
      chunks.push({ type: 'error', content: message });
      done = true;
      this._pendingRequests.get(requestId)?.reject(new Error(message));
      this._pendingRequests.delete(requestId);
      notify();
      // Stop only this native run. Never replay an incompletely observed task.
      void this._cancelRun(run);
    };

    const mapNativeText = (stream: string, data: Record<string, unknown>): StreamChunk | null => {
      const total = textLengths.get(stream) ?? 0;
      let previous = nativeText.get(stream) ?? { snapshot: '', rendered: '', start: total, provisional: false };
      const delta = typeof data.delta === 'string' ? data.delta : '';
      const snapshot = typeof data.text === 'string' ? data.text : undefined;
      const provisional = data.replaceable === true;
      let content: string;
      let replace: StreamChunk['replace'];
      const hasDelta = data.replace !== true && delta.length > 0;
      if (hasDelta) {
        // Native message-start resets its snapshot/delta builder even when
        // no tool ran between messages. A fresh full-text delta starts a new
        // stable message; revisions must not erase the preceding message.
        if (snapshot && previous.snapshot.trim() && !provisional && !previous.provisional && delta.trim() === snapshot.trim()) {
          previous = { snapshot: '', rendered: '', start: total, provisional: false };
        }
      }
      // A targeted event can arrive without a connection sequence number.
      // Its snapshot may include deltas we never received. Preserve raw delta
      // whitespace when it agrees with the snapshot; otherwise reconcile it.
      if (hasDelta && (!snapshot || (previous.rendered + delta).trim() === snapshot.trim())) {
        content = delta;
        nativeText.set(stream, { ...previous, snapshot: snapshot ?? previous.snapshot + delta,
          rendered: previous.rendered + delta, provisional });
      } else {
        if (snapshot === undefined) {
          if (data.replace === true) { failStream('OpenClaw sent a replacement without text. The reply may be incomplete.'); }
          return null;
        }
        // Media-only events do not retract prior text unless explicitly marked.
        if (snapshot === '' && data.replace !== true) { return null; }
        const extendsSnapshot = snapshot.trimStart().startsWith(previous.snapshot.trim());
        if (hasDelta && !extendsSnapshot && !provisional && !previous.provisional) {
          // A lost message start and a lost revision can look identical. Do
          // not erase a stable message or invent a new boundary from a suffix.
          failStream('OpenClaw response text lost its message boundary. The reply may be incomplete. Check the result before retrying.');
          return null;
        }
        let rendered = snapshot;
        if (data.replace !== true && extendsSnapshot) {
          if (snapshot === previous.snapshot) { rendered = previous.rendered; }
          else if (previous.rendered.trim() === previous.snapshot.trim() && snapshot === snapshot.trimStart()) {
            // Native snapshots may trim margins that raw deltas preserved.
            // Keep known leading whitespace, without duplicating trailing
            // whitespace that has become part of the expanded snapshot.
            rendered = previous.rendered.slice(0, previous.rendered.length - previous.rendered.trimStart().length) + snapshot;
          }
        }
        if (hasDelta && snapshot !== previous.snapshot) {
          const trailing = delta.slice(delta.trimEnd().length);
          if (trailing && rendered.trimEnd().endsWith(delta.trim())) { rendered = rendered.trimEnd() + trailing; }
        }
        nativeText.set(stream, { ...previous, snapshot, rendered, provisional });
        if (rendered === previous.rendered) { return null; }
        if (data.replace !== true && rendered.startsWith(previous.rendered)) { content = rendered.slice(previous.rendered.length); }
        else {
          content = rendered;
          if (previous.rendered) { replace = { start: previous.start, end: previous.start + previous.rendered.length }; }
        }
      }
      textLengths.set(stream, total + content.length - (replace ? replace.end - replace.start : 0));
      return content || replace ? { type: stream === 'assistant' ? 'text' : 'thinking', content,
        ...(replace ? { replace } : {}), ...(provisional ? { provisional: true } : {}) } : null;
    };

    const mapProgress = (content: unknown): StreamChunk | null => {
      if (typeof content !== 'string') { return null; }
      const text = redact(content).replace(/\s+/g, ' ').trim().slice(0, 2000);
      if (!text || text === lastProgress) { return null; }
      lastProgress = text;
      return { type: 'progress', content: text };
    };

    // Listen for events belonging to this run only.
    const eventHandler = (payload: Record<string, unknown>, _seq?: number) => {
      if (done) { return; }
      // Native requests acknowledge their runId before dispatch. Until then,
      // a run-tagged event may belong to an older run in the same session.
      // Keep session-only routing for legacy events that have no run identity.
      if (run.runId ? payload.runId !== run.runId
        : typeof payload.runId === 'string' || payload.sessionKey !== sessionKey) { return; }
      if (payload.stream === 'error') {
        const reason = isRecord(payload.data) ? payload.data.reason ?? payload.data.error ?? payload.data.message : undefined;
        failStream(reason === 'seq gap'
          ? 'OpenClaw missed part of the response stream. The reply may be incomplete. Check the result before retrying.'
          : 'OpenClaw response stream failed: ' + redact(reason || 'Unknown stream error'));
        return;
      }
      // Native text events may coalesce several sequence numbers and arrive
      // after another stream's newer event. Deduplicate exact event identities;
      // only the gateway's explicit error establishes a missing-event gap.
      if (typeof payload.stream === 'string' && Number.isSafeInteger(payload.seq) && (payload.seq as number) > 0) {
        const identity = `${payload.stream}:${payload.seq}`;
        if (seenNativeEvents.has(identity)) { return; }
        seenNativeEvents.add(identity);
      }
      if (payload.stream === 'lifecycle' && isRecord(payload.data)) {
        if (['end', 'error', 'finishing'].includes(String(payload.data.phase)) && payload.data.aborted === true) {
          pendingRunAborted = true;
        }
        if (payload.data.phase === 'error') {
          pendingRunError = redact(payload.data.error || 'Agent request failed');
        } else if (payload.data.phase === 'start' || payload.data.phase === 'end') {
          pendingRunError = undefined;
          if (payload.data.phase === 'start') {
            nativeText.clear(); commentary = ''; lastProgress = ''; pendingRunAborted = false;
          }
        }
      } else if (payload.state === 'error') {
        pendingRunError = redact(payload.errorMessage || toolOutput(payload.message, true) || 'Agent request failed');
      }
      if (payload.stream === 'tool' && isRecord(payload.data)
        && payload.data.phase === 'start' && typeof payload.data.toolCallId === 'string' && payload.data.toolCallId) {
        // Native provisional answers can be replaced across tool activity.
        if (!nativeText.get('assistant')?.provisional) { nativeText.delete('assistant'); }
        nativeText.delete('thinking');
      }
      let chunk: StreamChunk | null;
      const data = isRecord(payload.data) ? payload.data : undefined;
      if (payload.stream === 'assistant' && data && openClawAssistantPhase(data) === 'commentary') {
        // Commentary is a transient status, not reply text or private thinking.
        // It must not move answer revision offsets or suppress the final RPC.
        commentary = typeof data.text === 'string' ? data.text
          : commentary + (typeof data.delta === 'string' ? data.delta : '');
        chunk = mapProgress(commentary);
      } else if (payload.stream === 'item' || payload.stream === 'plan') {
        chunk = !data || data.suppressChannelProgress === true || data.phase !== 'update' ? null
          : payload.stream === 'plan' ? mapProgress(data.explanation || (Array.isArray(data.steps) && data.steps.length ? 'Plan updated' : undefined))
          : data.kind === 'preamble' ? mapProgress(data.progressText)
          : data.kind === 'status' ? mapProgress(data.summary) : null;
        // Generic item events accompany normalized tool events. They do not
        // establish tool execution, approval, success or a completed answer.
      } else {
        chunk = payload.stream === 'assistant' || payload.stream === 'thinking'
          ? (data ? mapNativeText(payload.stream, data) : null)
          : this._mapEventToChunk(payload);
      }
      if (chunk) {
        if ((chunk.type === 'tool_use' || chunk.type === 'tool_result') && chunk.toolCall) {
          const call = chunk.toolCall;
          const active = activeTools.get(call.id);
          if (active) {
            chunk.toolCall = { ...call,
              name: chunk.type === 'tool_result' || !call.name || call.name === 'unknown' ? active.name : call.name,
              input: chunk.type === 'tool_result' || Object.keys(call.input).length === 0 ? active.input : call.input,
              kind: chunk.type === 'tool_result' || !call.name || call.name === 'unknown' ? active.kind : call.kind,
            };
          }
          if (chunk.type === 'tool_result') { activeTools.delete(call.id); }
          else if (call.id) { activeTools.set(call.id, chunk.toolCall); }
        }
        if (chunk.type === 'error' || chunk.type === 'auth_error') {
          chunk.content = redact(chunk.content);
        } else if (chunk.type === 'tool_result' && chunk.toolCall?.status === 'failed') {
          chunk.toolCall.output = redact(chunk.toolCall.output);
        }
        if (chunk.type === 'text') { streamedText = true; }
        if (['text', 'thinking', 'tool_use', 'tool_result'].includes(chunk.type)) { commentary = ''; lastProgress = ''; }
        if ((chunk.type === 'text' || chunk.type === 'thinking') && payload.stream !== 'assistant' && payload.stream !== 'thinking') {
          const stream = chunk.type === 'text' ? 'assistant' : 'thinking';
          textLengths.set(stream, (textLengths.get(stream) ?? 0) + (chunk.content?.length ?? 0));
          nativeText.delete(stream);
        }
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
    const params: Record<string, unknown> = { message, idempotencyKey, sessionKey };
    if (options.thinking) { params.thinking = options.thinking; }
    if (options.textOnly) {
      params.modelRun = true;
      params.promptMode = 'none';
      params.cleanupBundleMcpOnRunEnd = true;
    }

    // Handle the response asynchronously
    responsePromise.then((response) => {
      if (done) { return; }
      const p = response.payload;
      const result = isRecord(p?.result) ? p.result : undefined;
      const runMetadata = readOpenClawRunMetadata(result ?? p);
      if (runMetadata) {
        options.onRunMetadata?.(runMetadata);
        if (runMetadata.reportedModel) { chunks.push({ type: 'model_info', reportedModel: runMetadata.reportedModel }); }
      }
      const meta = isRecord(result?.meta) ? result.meta : isRecord(p?.meta) ? p.meta : undefined;
      const payloads = Array.isArray(result?.payloads) ? result.payloads : Array.isArray(p?.payloads) ? p.payloads : [];
      const errorPayload = payloads.find(item => isRecord(item) && item.isError === true);
      const inFlight = p?.status === 'in_flight';
      const failed = !response.ok || !!response.error || inFlight || p?.status === 'error' || p?.status === 'timeout'
        || meta?.aborted === true || !!meta?.error || !!errorPayload || !!pendingRunError || pendingRunAborted;
      if (!failed && nativeText.get('assistant')?.provisional && (Array.isArray(result?.payloads) || Array.isArray(p?.payloads))) {
        // A native provisional stream is not the final answer. Some backends
        // supply its authoritative snapshot only in the final RPC envelope.
        const text = payloads.filter(isRecord).filter(item => item.isError !== true).map(item => openClawVisibleText(item) ?? '').join('');
        const revision = mapNativeText('assistant', { text, replace: true });
        if (revision) { chunks.push(revision); }
      }
      if (response.ok && !streamedText) {
        for (const item of payloads) {
          if (!isRecord(item) || item.isError === true) { continue; }
          const text = openClawVisibleText(item);
          if (typeof text === 'string' && text) { chunks.push({ type: 'text', content: text }); }
        }
      }
      if (failed) {
        chunks.push({ type: 'error', content: redact(response.error?.message || errorPayload?.text
          || pendingRunError || meta?.error
          || (inFlight ? 'OpenClaw reports this task is already running. No completed reply was returned. Check the existing run before retrying.' : undefined)
          || (pendingRunAborted || meta?.aborted === true ? 'OpenClaw Gateway: Agent request was aborted. The reply may be incomplete.' : undefined)
          || p?.summary
          || (p?.status === 'timeout' || meta?.aborted || pendingRunAborted ? 'OpenClaw Gateway: Agent request timed out or was aborted' : 'Agent request failed')) });
      } else if (p && !streamedText && payloads.length === 0) {
        // Extract content from the final response payload if no streaming events provided it
        const text = openClawAssistantPhase(p) === 'commentary' ? undefined
          : openClawVisibleText(p) ?? p.message ?? p.response ?? p.output ?? p.result;
        if (text && typeof text === 'string') {
          chunks.push({ type: 'text', content: text });
        }
      }
      done = true;
      notify();
    }).catch((err: unknown) => {
      if (done) { return; }
      error = new Error(redact(err));
      done = true;
      notify();
    });

    // Yield chunks as they arrive
    const overallStart = Date.now();
    try {
      this._sendFrame({ type: 'req', id: requestId, method: 'agent', params });
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
        yield { type: 'error', content: pendingRunError || redact(finalError) };
      }
    } catch (err) {
      done = true;
      yield { type: 'error', content: redact(err) };
    } finally {
      activeTools.clear();
      seenNativeEvents.clear();
      nativeText.clear();
      if (waitTimer) { clearTimeout(waitTimer); }
      for (const name of eventNames) {
        this._removeEventListener(name, eventHandler);
      }
      if (!done) { void this._cancelRun(run); }
      done = true;
      this._agentRuns.delete(requestId);
      this._pendingRequests.delete(requestId);
    }
  }

  /**
   * Cancel a running agent request
   */
  async cancelAgent(sessionKey?: string): Promise<void> {
    const runs = [...this._agentRuns.values()].filter(run => !sessionKey || run.sessionKey === sessionKey);
    await Promise.all(runs.map(run => this._cancelRun(run)));
  }

  private async _cancelRun(run: ActiveAgentRun): Promise<void> {
    run.cancel();
    if (run.cancellation) { return run.cancellation; }
    if (!this.isConnected()) { return; }
    // Omitting runId aborts every authorized run in the session. Native agent
    // requests already have an exact identity before acknowledgement, so never
    // broaden Stop to the whole session while setup is still in progress.
    run.cancellation = this._sendRequest('chat.abort', {
      sessionKey: run.sessionKey, runId: run.runId || run.requestRunId,
    }).then(() => undefined, () => undefined); // Local cancellation already settled the stream.
    return run.cancellation;
  }

  /**
   * Disconnect from the Gateway
   */
  disconnect(): void {
    this._disposed = true;
    this._cancelConnect?.();
    this._connecting = undefined;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      const socket = this._ws;
      this._ws = null;
      // Keep guarded error listeners while terminating a connecting socket:
      // ws reports cancellation asynchronously through its error event.
      if (socket.readyState === WebSocket.OPEN) { socket.close(); }
      else if (socket.readyState !== WebSocket.CLOSED) { socket.terminate(); }
    }
    this._connected = false;
    this._rejectPending('OpenClaw Gateway disconnected');
    this._agentRuns.clear();
    this._eventListeners.clear();
  }

  /**
   * Update the Gateway URL
   */
  setUrl(url: string): void {
    if (url !== this._url) {
      this.disconnect();
      this._url = url;
      this._disposed = false;
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
    const redact = this.captureDiagnosticRedactor();
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
      return { success: false, error: redact(err) };
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
    const redact = this.captureDiagnosticRedactor();
    try {
      const idempotencyKey = `mysti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const params: Record<string, unknown> = {
        channel: channelId,
        message,
        to: target,
        idempotencyKey,
      };
      console.log('[Mysti] OpenClaw Gateway: Sending channel message');
      const response = await this._sendRequest('send', params);
      if (!response.ok) {
        console.log('[Mysti] OpenClaw Gateway: send failed:', redact(response.error));
      } else {
        console.log('[Mysti] OpenClaw Gateway: send succeeded');
      }
      return response.ok === true;
    } catch (err) {
      console.log('[Mysti] OpenClaw Gateway: send error:', redact(err));
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
    const redact = this.captureDiagnosticRedactor();
    try {
      const idempotencyKey = `mysti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log('[Mysti] OpenClaw Gateway: Delegating task');
      const response = await this._sendRequest('chat.send', {
        sessionKey,
        idempotencyKey,
        message: prompt,
      });
      // RPC transport success also wraps native cached/queued abort results.
      // This boolean means accepted for work, never merely received by the RPC.
      const accepted = response.ok === true && !response.error
        && response.payload?.status !== 'timeout' && response.payload?.status !== 'error';
      if (!accepted) {
        console.log('[Mysti] OpenClaw Gateway: chat.send failed:', redact(response.error || response.payload?.summary || 'Task was not accepted'));
      } else {
        console.log('[Mysti] OpenClaw Gateway: chat.send accepted');
      }
      return accepted;
    } catch (err) {
      console.log('[Mysti] OpenClaw Gateway: chat.send error:', redact(err));
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
    const redact = this.captureDiagnosticRedactor();
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
      console.log('[Mysti] OpenClaw Gateway: sessions.list error:', redact(err));
      return [];
    }
  }

  /**
   * Fetch message history for a specific session.
   * Used to poll for new inbound messages.
   */
  async getSessionHistory(sessionKey: string, after?: number, limit: number = 20): Promise<SessionMessage[]> {
    if (!this.isConnected()) { return []; }
    const redact = this.captureDiagnosticRedactor();
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
      console.log('[Mysti] OpenClaw Gateway: sessions.history error:', redact(err));
      return [];
    }
  }

  // --- Private methods ---

  private _nextId(): string {
    return String(++this._requestId);
  }

  private _sendFrame(frame: GatewayFrame): void {
    if (this._ws?.readyState !== WebSocket.OPEN) { throw new Error('OpenClaw Gateway is not connected'); }
    this._ws.send(JSON.stringify(frame));
  }

  private _rejectPending(message: string): void {
    for (const pending of this._pendingRequests.values()) { pending.reject(new Error(message)); }
    this._pendingRequests.clear();
  }

  private _sendRequest(method: string, params: Record<string, unknown>): Promise<GatewayResponse> {
    const redact = this.captureDiagnosticRedactor();
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Gateway request '${method}' timed out`));
      }, 30000);

      this._pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response.error ? { ...response, error: {
            message: redact(response.error),
            ...(response.error.code ? { code: response.error.code } : {}),
          } } : response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(new Error(redact(err)));
        }
      });

      try {
        this._sendFrame({ type: 'req', id, method, params });
      } catch (err) {
        clearTimeout(timeout);
        this._pendingRequests.delete(id);
        reject(new Error(redact(err)));
      }
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
          const run = this._agentRuns.get(frame.id);
          if (run && frame.ok === true && !frame.error && (status === 'accepted' || status === 'pending' || status === 'running')) {
            if (typeof frame.payload?.runId === 'string') { run.runId = frame.payload.runId; }
            // Ack — don't resolve yet, wait for the final response
            console.log('[Mysti] OpenClaw Gateway: Agent run ack, status:', status);
            return;
          }
          this._pendingRequests.delete(frame.id);
          pending.resolve(frame as GatewayResponse);
        }
      } else if (frame.type === 'event') {
        // Event bodies can contain private messages; do not dump them to logs.

        // Native broadcast sequence numbers are per connection. Targeted
        // events omit seq, and dropped broadcasts still advance the counter.
        // A gap cannot be attributed to just one run, so every active reply on
        // this connection becomes incomplete; later tasks may use it afresh.
        if (typeof frame.seq === 'number' && Number.isSafeInteger(frame.seq) && frame.seq > 0) {
          const previous = this._lastEventSeq;
          if (previous !== undefined && frame.seq <= previous) { return; }
          this._lastEventSeq = frame.seq;
          if (previous !== undefined && frame.seq > previous + 1) {
            for (const run of this._agentRuns.values()) {
              run.fail('OpenClaw missed gateway events. The reply may be incomplete. Check the result before retrying.');
            }
          }
        }

        const listeners = this._eventListeners.get(frame.event);
        if (listeners) {
          for (const listener of listeners) {
            listener(frame.payload, frame.seq);
          }
        }

        // Handle shutdown
        if (frame.event === 'shutdown') {
          console.log('[Mysti] OpenClaw Gateway: Shutdown event received');
          this._connected = false;
          this._rejectPending('OpenClaw Gateway is shutting down. The reply may be incomplete.');
          this._ws?.terminate();
        }
      }
    } catch {
      console.log('[Mysti] OpenClaw Gateway: Failed to process message');
    }
  }

  /**
   * Map a Gateway agent event payload to a Mysti StreamChunk
   */
  private _mapEventToChunk(payload: Record<string, unknown>): StreamChunk | null {
    // --- OpenClaw Gateway native format ---
    // Assistant/thinking snapshots are mapped with request-local state above.
    // Chat events:  {state: "delta", message: {role, content: [{type, text}]}, ...}
    // Lifecycle:    {stream: "lifecycle", data: {phase: "start"|"end"}, ...}
    const stream = payload.stream as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;
    const state = payload.state as string | undefined;

    if (stream === 'tool' && data) {
      const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      if (!id || !['start', 'update', 'result'].includes(String(data.phase))) { return null; }
      const name = typeof data.name === 'string' ? data.name : 'unknown';
      const finished = data.phase === 'result';
      const failed = data.isError === true;
      return {
        type: finished ? 'tool_result' : 'tool_use',
        toolCall: {
          id, name, input: isRecord(data.args) ? data.args : {},
          status: finished ? (failed ? 'failed' : 'completed') : 'running',
          kind: toolKind(name),
          ...(finished || data.partialResult !== undefined ? {
            output: toolOutput(finished ? data.result : data.partialResult, failed),
          } : {}),
        },
      };
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
    const failed = payload.is_error === true || payload.success === false || payload.status === 'failed';

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
      if (status === 'completed' || status === 'done' || failed) {
        return {
          type: 'tool_result',
          toolCall: {
            id: (payload.id || payload.tool_call_id || '') as string,
            name: (payload.name || payload.tool || '') as string,
            input: (payload.input || payload.arguments || {}) as Record<string, unknown>,
            output: (payload.output || payload.result || '') as string,
            status: failed ? 'failed' : 'completed',
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
          id: (payload.tool_use_id || payload.tool_id || payload.tool_call_id || payload.id || '') as string,
          name: (payload.tool_name || '') as string,
          input: {},
          output: failed ? diagnosticMessage(payload.content)
            : typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content || ''),
          status: failed ? 'failed' : 'completed',
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
            output: failed ? diagnosticMessage(output) : typeof output === 'string' ? output : JSON.stringify(output),
            status: failed ? 'failed' : 'completed',
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
