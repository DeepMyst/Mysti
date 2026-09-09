/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { OPENCLAW_GATEWAY_TIMEOUT_MS } from '../../constants';
import type { StreamChunk, ToolCall } from '../../types';
import { toolKind } from '../../utils/toolNames';
import { asRecord, asString } from '../../utils/valueGuards';

export interface OpenClawAgentRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Human approval time does not consume the remaining execution budget. */
  hasPending?: () => boolean;
  onPendingChanged?: (listener: () => void) => () => void;
}

export interface OpenClawAgentResponse {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { message?: string };
}

const PROGRESS = new Set(['accepted', 'pending', 'running']);
const FAILURES = new Set(['error', 'timeout', 'aborted', 'cancelled']);

function textBlocks(value: unknown): string {
  if (typeof value === 'string') { return value; }
  if (!Array.isArray(value)) { return ''; }
  return value.map(block => {
    const record = asRecord(block);
    return record?.type === 'text' ? asString(record.text) ?? '' : '';
  }).join('');
}

function outputText(value: unknown): string | undefined {
  if (value === undefined) { return undefined; }
  if (typeof value === 'string') { return value; }
  try { return JSON.stringify(value); }
  catch { return '[Unserializable tool output]'; }
}

/** Longest streamed suffix matching a snapshot prefix, without quadratic slicing. */
function snapshotOverlap(streamed: string, snapshot: string): number {
  const prefixes = new Uint32Array(snapshot.length);
  for (let i = 1, matched = 0; i < snapshot.length; i++) {
    while (matched > 0 && snapshot[i] !== snapshot[matched]) { matched = prefixes[matched - 1]; }
    if (snapshot[i] === snapshot[matched]) { matched++; }
    prefixes[i] = matched;
  }
  let matched = 0;
  for (let i = Math.max(0, streamed.length - snapshot.length); i < streamed.length; i++) {
    while (matched > 0 && streamed[i] !== snapshot[matched]) { matched = prefixes[matched - 1]; }
    if (streamed[i] === snapshot[matched]) { matched++; }
    if (matched === snapshot.length && i < streamed.length - 1) { matched = prefixes[matched - 1]; }
  }
  return matched;
}

/**
 * One gateway request owns its queue, deadline and cancellation. The gateway
 * routes RPC responses by request ID; events additionally require this run ID.
 * The provider, not this queue, emits the single authoritative `done` chunk.
 */
export class OpenClawAgentRun {
  private _sessionKey: string;
  private _hasCanonicalSession = false;
  private _finished = false;
  private _cancelled = false;
  private _remoteAborted = false;
  private _consuming = false;
  private _queue: StreamChunk[] = [];
  private _wake?: () => void;
  private _timer?: ReturnType<typeof setTimeout>;
  private _remainingTimeoutMs = 0;
  private _timeoutStartedAt?: number;
  private _hasPending?: () => boolean;
  private _removePendingListener?: () => void;
  private _signal?: AbortSignal;
  private readonly _onAbort = () => this.cancel();
  private _text = '';
  private _assistantSnapshot = '';
  private _thinkingSnapshot = '';
  private _chatSnapshot = '';
  private _lastRunError?: string;
  private readonly _lastSequence = new Map<string, number>();
  private readonly _tools = new Map<string, ToolCall>();

  constructor(
    readonly runId: string,
    sessionKey: string,
    options: OpenClawAgentRunOptions,
    private readonly _abortRemote: (sessionKey: string, runId: string) => void | Promise<void>,
  ) {
    this._sessionKey = sessionKey;
    this._signal = options.signal;
    if (this._signal?.aborted) {
      this.cancel();
      return;
    }
    this._signal?.addEventListener('abort', this._onAbort, { once: true });
    const timeout = options.timeoutMs;
    this._remainingTimeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0
      ? timeout : OPENCLAW_GATEWAY_TIMEOUT_MS;
    this._hasPending = options.hasPending;
    try {
      if (!!options.hasPending !== !!options.onPendingChanged) {
        throw new Error('Incomplete pending approval observation');
      }
      const remove = options.onPendingChanged?.(() => this._syncTimeout());
      // A subscriber may synchronously cancel this run before returning cleanup.
      if (this._finished) { remove?.(); }
      else { this._removePendingListener = remove; }
      this._syncTimeout();
    } catch {
      this._abort();
      this.fail(new Error('OpenClaw Gateway: Approval state unavailable'));
    }
  }

  get isFinished(): boolean { return this._finished; }
  get isCancelled(): boolean { return this._cancelled; }
  get sessionKey(): string { return this._sessionKey; }

  onEvent(event: string, payload: Record<string, unknown>): void {
    if (this._finished || (event !== 'agent' && event !== 'chat') ||
        !asRecord(payload) || payload.runId !== this.runId) { return; }
    // Before the ack the canonical session alias is unknown. The caller-chosen
    // idempotency key is already the authoritative run ID in protocol 4.
    if (this._hasCanonicalSession && payload.sessionKey !== undefined && payload.sessionKey !== this._sessionKey) { return; }
    const seq = payload.seq;
    if (typeof seq === 'number' && Number.isSafeInteger(seq)) {
      if (seq <= (this._lastSequence.get(event) ?? -1)) { return; }
      this._lastSequence.set(event, seq);
    }
    if (event === 'chat') {
      const message = asRecord(payload.message);
      if (message && (message.role === undefined || message.role === 'assistant')) {
        const snapshot = textBlocks(message.content);
        if (snapshot) { this._chatSnapshot = snapshot; }
      }
      // Chat text is a cumulative projection of the same assistant stream.
      // Keep it as a fallback, so interleaved projections cannot double text.
      return;
    }
    const data = asRecord(payload.data);
    if (!data) { return; }
    if (payload.stream === 'assistant') {
      const delta = asString(data.delta);
      const snapshot = asString(data.text);
      if (delta !== undefined) {
        this._appendText(delta);
        this._assistantSnapshot += delta;
      } else if (snapshot !== undefined) {
        this._appendText(snapshot.startsWith(this._assistantSnapshot)
          ? snapshot.slice(this._assistantSnapshot.length) : snapshot);
      }
      if (snapshot !== undefined) { this._assistantSnapshot = snapshot; }
    } else if (payload.stream === 'thinking') {
      const delta = asString(data.delta);
      const snapshot = asString(data.text);
      const content = delta ?? (snapshot?.startsWith(this._thinkingSnapshot)
        ? snapshot.slice(this._thinkingSnapshot.length) : snapshot);
      if (content) { this._push({ type: 'thinking', content }); }
      if (delta !== undefined) { this._thinkingSnapshot += delta; }
      if (snapshot !== undefined) { this._thinkingSnapshot = snapshot; }
    } else if (payload.stream === 'tool') {
      this._onTool(data);
    } else if (payload.stream === 'lifecycle' || payload.stream === 'error') {
      // A lifecycle error can precede successful model failover. Sequence-gap
      // diagnostics are transport warnings, not authoritative run failures.
      if (data.reason !== 'seq gap') {
        this._lastRunError = asString(data.error) ?? asString(data.message) ?? this._lastRunError;
      }
    }
  }

  onResponse(response: OpenClawAgentResponse): void {
    if (this._finished) { return; }
    const payload = asRecord(response.payload);
    if (payload?.runId !== undefined && payload.runId !== this.runId) { return; }
    const status = asString(payload?.status);
    // A deduplicated in-flight request receives no later final RPC response.
    // Recovery must explicitly reattach; it must not abort the existing run.
    if (response.ok && status === 'in_flight') {
      this.fail(new Error('OpenClaw Gateway: Run is already active; reconnect/recovery required'));
      return;
    }
    if (response.ok && status && PROGRESS.has(status)) {
      if (payload?.runId !== this.runId) { return; }
      const canonicalSessionKey = asString(payload?.sessionKey);
      if (!this._hasCanonicalSession && canonicalSessionKey) {
        this._sessionKey = canonicalSessionKey;
        this._hasCanonicalSession = true;
      }
      return;
    }

    const result = asRecord(payload?.result);
    const items = result?.payloads ?? payload?.payloads;
    const finalText = Array.isArray(items)
      ? items.map(item => {
        const part = asRecord(item);
        return part?.isReasoning === true ? '' : asString(part?.text) ?? asString(part?.content) ?? '';
      }).join('')
      : asString(result?.text) ?? asString(payload?.text) ?? asString(payload?.content) ?? '';
    this._appendSnapshot(finalText || this._chatSnapshot);
    if (!response.ok || (status && FAILURES.has(status)) || asRecord(result?.meta)?.aborted === true) {
      this._push({ type: 'error', content: response.error?.message || asString(payload?.summary) ||
        asString(payload?.error) || this._lastRunError || `OpenClaw Gateway: ${status || 'Agent request failed'}` });
    }
    this._finish();
  }

  fail(error: Error): void {
    if (this._finished) { return; }
    this._push({ type: 'error', content: error.message });
    this._finish();
  }

  cancel(): void {
    if (this._cancelled) { return; }
    this._cancelled = true;
    this._queue.length = 0;
    if (!this._finished) { this._abort(); }
    this._finish();
  }

  /** Even return() while next() is waiting must wake and retire the run. */
  chunks(): AsyncGenerator<StreamChunk> {
    if (this._consuming) { throw new Error('OpenClaw run already has a stream consumer'); }
    this._consuming = true;
    const iterator = this._drain();
    const close = iterator.return.bind(iterator);
    const throwError = iterator.throw.bind(iterator);
    iterator.return = value => { this.dispose(); return close(value); };
    iterator.throw = error => { this.dispose(); return throwError(error); };
    return iterator;
  }

  dispose(): void {
    if (!this._finished) { this.cancel(); }
    this._release();
    this._queue.length = 0;
    this._tools.clear();
    this._text = this._assistantSnapshot = this._thinkingSnapshot = this._chatSnapshot = '';
    this._lastSequence.clear();
  }

  private async *_drain(): AsyncGenerator<StreamChunk> {
    try {
      while (!this._finished || this._queue.length > 0) {
        const chunk = this._queue.shift();
        if (chunk) { yield chunk; }
        else if (!this._finished) { await new Promise<void>(resolve => { this._wake = resolve; }); }
      }
    } finally { this.dispose(); }
  }

  private _onTool(data: Record<string, unknown>): void {
    const id = asString(data.toolCallId);
    if (!id) { return; }
    const previous = this._tools.get(id);
    const name = asString(data.name) ?? previous?.name;
    if (!name || previous?.status === 'completed' || previous?.status === 'failed') { return; }
    const input = asRecord(data.args) ?? previous?.input ?? {};
    if (data.phase === 'start') {
      if (previous) { return; }
      const tool: ToolCall = { id, name, input, status: 'running', kind: toolKind(name) };
      this._tools.set(id, tool);
      this._push({ type: 'tool_use', toolCall: { ...tool } });
    } else if (data.phase === 'update') {
      // StreamChunk has no tool-progress event. Buffer partial output until
      // result rather than repeating a tool-use/approval or claiming success.
      this._tools.set(id, { id, name, input, status: 'running',
        output: outputText(data.partialResult) ?? previous?.output, kind: toolKind(name) });
    } else if (data.phase === 'result') {
      const tool: ToolCall = { id, name, input,
        output: outputText(data.result) ?? previous?.output,
        status: data.isError === true ? 'failed' : 'completed', kind: toolKind(name) };
      this._tools.set(id, tool);
      this._push({ type: 'tool_result', toolCall: { ...tool } });
    }
  }

  private _appendText(content: string): void {
    if (!content) { return; }
    this._text += content;
    this._push({ type: 'text', content });
  }

  private _appendSnapshot(snapshot: string): void {
    if (!snapshot || this._text.includes(snapshot)) { return; }
    if (snapshot.startsWith(this._text)) {
      this._appendText(snapshot.slice(this._text.length));
      return;
    }
    // A final payload may contain only the final assistant message after
    // earlier commentary/tool turns. Append its unstreamed suffix once.
    this._appendText(snapshot.slice(snapshotOverlap(this._text, snapshot)));
  }

  private _push(chunk: StreamChunk): void {
    this._queue.push(chunk);
    this._notify();
  }

  private _notify(): void {
    const wake = this._wake;
    this._wake = undefined;
    wake?.();
  }

  private _finish(): void {
    this._finished = true;
    this._release();
    this._notify();
  }

  private _release(): void {
    this._pauseTimeout();
    const remove = this._removePendingListener;
    this._removePendingListener = undefined;
    this._hasPending = undefined;
    try { remove?.(); } catch { /* Subscription cleanup cannot strand a reader. */ }
    this._signal?.removeEventListener('abort', this._onAbort);
    this._signal = undefined;
  }

  private _pauseTimeout(): void {
    if (this._timer !== undefined) { clearTimeout(this._timer); this._timer = undefined; }
    if (this._timeoutStartedAt !== undefined) {
      this._remainingTimeoutMs = Math.max(0, this._remainingTimeoutMs - (performance.now() - this._timeoutStartedAt));
      this._timeoutStartedAt = undefined;
    }
  }

  private _syncTimeout(): void {
    if (this._finished) { return; }
    const wasRunning = this._timeoutStartedAt !== undefined;
    this._pauseTimeout();
    try {
      if (this._hasPending?.() === true) { return; }
    } catch {
      this._abort();
      this.fail(new Error('OpenClaw Gateway: Approval state unavailable'));
      return;
    }
    if (this._finished) { return; }
    if (wasRunning && this._remainingTimeoutMs <= 0) {
      this._abort();
      this.fail(new Error('OpenClaw Gateway: Request timed out'));
      return;
    }
    this._timeoutStartedAt = performance.now();
    this._timer = setTimeout(() => this._syncTimeout(), this._remainingTimeoutMs);
    this._timer.unref?.();
  }

  private _abort(): void {
    if (this._remoteAborted) { return; }
    this._remoteAborted = true;
    try { void Promise.resolve(this._abortRemote(this._sessionKey, this.runId)).catch(() => {}); }
    catch { /* Local cleanup must finish even when the connection is gone. */ }
  }
}
