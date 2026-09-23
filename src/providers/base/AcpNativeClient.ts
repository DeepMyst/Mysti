/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { createHash } from 'crypto';
import type { Settings, StreamChunk, ToolCall, UsageStats } from '../../types';
import { STREAM_INACTIVITY_TIMEOUT_MS } from '../../constants';
import { classifyToolAction, isNeverGatedAction, shouldGateToolUse } from '../../utils/permissionClassifier';
import { NativeApprovalScope } from './NativeApprovalScope';
import type { NativeApprovalHandler } from './IProvider';
import type { AcpNativeLaunch, AcpObject } from './AcpNativeTypes';

const object = (value: unknown): value is AcpObject => !!value && typeof value === 'object' && !Array.isArray(value);
const idString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const idKey = (value: unknown): string => {
  if (!idString(value) && !(typeof value === 'number' && Number.isSafeInteger(value))) { throw new Error('Invalid ACP request identity.'); }
  return `${typeof value}:${value}`;
};
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_IDENTITIES = 4096;

/** Native frames contain only JSON; never expose mutable approval authority. */
function freeze<T>(value: T, depth = 0): T {
  if (depth > 48) { throw new Error('ACP payload exceeds its structural limit.'); }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) { freeze(child, depth + 1); }
    Object.freeze(value);
  }
  return value;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const KIND_NAMES: Record<string, string> = { read: 'Read', search: 'Grep', think: 'Think', edit: 'Edit', move: 'Edit', delete: 'Delete', execute: 'Bash', fetch: 'WebFetch' };

/** Text extraction is for display only. Diff metadata is kept in approval input. */
function textContent(value: unknown, depth = 0): string {
  if (depth > 16) { return ''; }
  if (typeof value === 'string') { return value; }
  if (Array.isArray(value)) { return value.map(item => textContent(item, depth + 1)).filter(Boolean).join('\n'); }
  if (!object(value)) { return ''; }
  if (value.type === 'text' && typeof value.text === 'string') { return value.text; }
  if (value.type === 'content') { return textContent(value.content, depth + 1); }
  if (value.type === 'diff') { return typeof value.newText === 'string' ? value.newText : ''; }
  return '';
}

export interface AcpNativeClientOptions {
  process: ChildProcess;
  providerId: string;
  label: string;
  panelId: string;
  signal: AbortSignal;
  settings: Pick<Settings, 'mode' | 'accessLevel'>;
  handler: NativeApprovalHandler | undefined;
  launch: AcpNativeLaunch;
  isCurrent(): boolean;
  terminate(): void;
  inactivityTimeoutMs?: number;
  startupTimeoutMs?: number;
}

/** One issuing process owns one ACP session and one prompt; no shared native grants. */
export class AcpNativeClient {
  private readonly _pending = new Map<string, { method: string; resolve(result: AcpObject): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  private readonly _seen = new Map<string, string>();
  private readonly _unsupportedRequests = new Set<string>();
  private readonly _tools = new Map<string, AcpObject>();
  private readonly _display = new Map<string, ToolCall>();
  private readonly _toolRequests = new Map<string, Array<string | number>>();
  private readonly _completed = new Set<string>();
  private readonly _pendingApprovals = new Set<string>();
  private readonly _chunks: StreamChunk[] = [];
  private readonly _decoder = new StringDecoder('utf8');
  private readonly _approvals: NativeApprovalScope;
  private readonly _settings: Readonly<Pick<Settings, 'mode' | 'accessLevel'>>;
  private readonly _clock: ReturnType<typeof setInterval>;
  private readonly _releasePendingListener: () => void;
  private _buffer = '';
  private _nextId = 0;
  private _sessionId?: string;
  private _lastActivity = Date.now();
  private _prompting = false;
  private _ended = false;
  private _failed = false;
  private _disposed = false;
  private _mode?: string;
  private _changingMode?: string;
  private _wake?: () => void;
  private _cancelling = false;
  private _cancelTimer?: ReturnType<typeof setTimeout>;
  usage?: UsageStats;
  private readonly _onData = (data: Buffer) => this._consume(data);
  // Native diagnostic output must not fill a pipe and stall permission RPCs.
  // Do not retain it: it can include provider/account configuration details.
  private readonly _onStderr = () => {};
  private readonly _onError = (error: Error) => this._fail(error.message);
  private readonly _onExit = (code: number | null) => {
    if (!this._ended && !this._options.signal.aborted) { this._fail(`ACP process exited before the prompt completed (${code ?? 'signal'}).`); }
    this._finish();
  };
  private readonly _onAbort = () => {
    this._approvals.dispose();
    const prompting = this._sessionId && this._prompting;
    const grace = this._options.launch.cancelGraceMs;
    if (prompting && grace) {
      // Let the agent run its own cancellation first, bounded: the freeze and
      // tree kill follow when its prompt ends, it exits, or the bound expires.
      // Nothing it reports meanwhile is delivered; permission requests are
      // answered cancelled.
      this._cancelling = true;
      this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this._sessionId } });
      this._cancelTimer = setTimeout(() => this._finish(), grace);
      return;
    }
    // Terminate first: it freezes the agent before it can read the cancel and
    // exit, which would orphan a running tool's detached process group.
    this._finish(); this._options.terminate();
    if (prompting) { this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this._sessionId } }); }
  };

  constructor(private readonly _options: AcpNativeClientOptions) {
    this._settings = Object.freeze({ ..._options.settings });
    this._approvals = new NativeApprovalScope({ providerId: _options.providerId, panelId: _options.panelId,
      signal: _options.signal, handler: _options.handler, isCurrent: () => this._current() && this._prompting });
    this._releasePendingListener = this._approvals.onPendingChanged(() => { this._lastActivity = Date.now(); });
    const inactivity = _options.inactivityTimeoutMs ?? STREAM_INACTIVITY_TIMEOUT_MS;
    this._clock = setInterval(() => {
      if (!this._approvals.hasPending && Date.now() - this._lastActivity >= inactivity) { this._fail('ACP process became inactive and was terminated.'); }
    }, Math.min(1000, inactivity));
    this._clock.unref();
    _options.process.stdout?.on('data', this._onData);
    _options.process.stderr?.on('data', this._onStderr);
    _options.process.on('error', this._onError);
    _options.process.on('exit', this._onExit);
    _options.process.on('close', this._onExit);
    _options.process.stdin?.on('error', this._onError);
    _options.signal.addEventListener('abort', this._onAbort, { once: true });
    if (_options.signal.aborted) { this._onAbort(); }
  }

  get sessionId(): string | undefined { return this._sessionId; }
  /** True while a Stop waits for the agent's own cancellation; teardown follows. */
  get cancelling(): boolean { return this._cancelling && !this._ended; }
  get hasPendingApproval(): boolean { return this._approvals.hasPending; }
  private _current(): boolean { return !this._ended && !this._disposed && !this._options.signal.aborted && this._options.isCurrent(); }

  private _write(frame: AcpObject): void {
    if (this._disposed) { return; }
    const input = this._options.process.stdin;
    if (!input?.writable || input.destroyed) { this._fail('ACP input channel closed.'); return; }
    try { input.write(JSON.stringify(frame) + '\n', error => { if (error) { this._fail('ACP input write failed.'); } }); }
    catch { this._fail('ACP input write failed.'); }
  }

  private _request(method: string, params: AcpObject): Promise<AcpObject> {
    if (!this._current()) { return Promise.reject(new Error('ACP turn is no longer active.')); }
    const id = `mysti-${++this._nextId}`;
    return new Promise((resolve, reject) => {
      const timer = method === 'session/prompt' ? undefined : setTimeout(() => {
        this._fail(`ACP ${method} timed out.`);
      }, this._options.startupTimeoutMs ?? 30000);
      this._pending.set(idKey(id), { method, resolve, reject, timer });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize(): Promise<AcpObject> {
    const result = await this._request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'mysti', title: 'Mysti', version: '0.5.1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (result.protocolVersion !== 1) { throw new Error('The agent did not confirm ACP protocol version 1.'); }
    const expected = this._options.launch.expectedAgentInfo;
    if (expected) {
      const info = object(result.agentInfo) ? result.agentInfo : {};
      if ((expected.name && info.name !== expected.name) || (expected.version && info.version !== expected.version)) {
        throw new Error('The native ACP agent reported an unsupported identity or version.');
      }
    }
    this._options.launch.validateInitialize?.(freeze(result));
    return result;
  }

  async newSession(cwd: string): Promise<AcpObject> {
    if (this._sessionId) { throw new Error('This ACP process already owns a session.'); }
    const result = await this._request('session/new', { cwd, mcpServers: [] });
    if (!idString(result.sessionId)) { throw new Error('ACP returned an invalid session identity.'); }
    this._sessionId = result.sessionId;
    if (object(result.modes) && idString(result.modes.currentModeId)) { this._mode = result.modes.currentModeId; }
    freeze(result);
    this._options.launch.validateSession?.(result);
    this._push({ type: 'session_active', sessionId: this._sessionId });
    return result;
  }

  async setMode(modeId: string): Promise<void> {
    if (this._prompting || !this._sessionId || !idString(modeId)) { throw new Error('ACP mode must be configured before the prompt.'); }
    this._changingMode = modeId;
    try { await this._request('session/set_mode', { sessionId: this._sessionId, modeId }); this._mode = modeId; }
    finally { this._changingMode = undefined; }
  }

  async setModel(modelId: string): Promise<void> {
    if (this._prompting || !this._sessionId || !idString(modelId)) { throw new Error('ACP model must be configured before the prompt.'); }
    await this._request('session/set_model', { sessionId: this._sessionId, modelId });
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (this._prompting || !this._sessionId || !idString(configId) || !idString(value)) { throw new Error('ACP configuration must be set before the prompt.'); }
    await this._request('session/set_config_option', { sessionId: this._sessionId, configId, value });
  }

  startPrompt(prompt: AcpObject[]): void {
    if (!this._sessionId || this._prompting) { throw new Error('ACP prompt ownership is unavailable.'); }
    this._prompting = true;
    // The RPC remains pending throughout permission review; stream inactivity,
    // not a fixed request timer, bounds model silence outside permission waits.
    void this._request('session/prompt', { sessionId: this._sessionId, prompt }).catch(error => this._fail(error.message));
  }

  private _consume(data: Buffer): void {
    if (this._ended) { return; }
    this._lastActivity = Date.now();
    this._buffer += this._decoder.write(data);
    if (Buffer.byteLength(this._buffer) > MAX_FRAME_BYTES) { this._fail('ACP frame exceeded its size limit.'); return; }
    let newline: number;
    while ((newline = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, newline); this._buffer = this._buffer.slice(newline + 1);
      if (!line.trim()) { continue; }
      try {
        const frame: unknown = JSON.parse(line);
        if (!object(frame) || frame.jsonrpc !== '2.0') { throw new Error('Invalid ACP JSON-RPC frame.'); }
        this._dispatch(frame);
      } catch (error) { this._fail(error instanceof Error ? error.message : 'Invalid ACP frame.'); }
      if (this._ended) { return; }
    }
  }

  private _dispatch(frame: AcpObject): void {
    if (typeof frame.method === 'string') {
      const params = object(frame.params) ? frame.params : {};
      if ('id' in frame) {
        if (frame.method === 'session/request_permission') { this._permission(frame.id, params); }
        else {
          const key = idKey(frame.id);
          if (this._seen.has(key) || this._unsupportedRequests.has(key)) { throw new Error('Replayed ACP client request identity.'); }
          if (this._unsupportedRequests.size >= MAX_IDENTITIES) { throw new Error('ACP client request limit exceeded.'); }
          this._unsupportedRequests.add(key);
          this._write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Mysti does not expose this native client capability.' } });
          if (this._current() && this._prompting && params.sessionId === this._sessionId
            && this._options.launch.nonFatalUnsupportedRequests?.includes(frame.method)) { return; }
          throw new Error(`Unsupported ACP client request: ${frame.method}`);
        }
      } else if (frame.method === 'session/update') { this._update(params); }
      else if (this._sessionId && params.sessionId === this._sessionId) {
        this._options.launch.validateNotification?.(frame.method, freeze(params));
      }
      return;
    }
    const pending = this._pending.get(idKey(frame.id));
    if (!pending) { throw new Error('Unexpected or repeated ACP response identity.'); }
    this._pending.delete(idKey(frame.id)); clearTimeout(pending.timer);
    if (object(frame.error)) {
      const error = new Error(String(frame.error.message ?? 'Native ACP request failed.'));
      pending.reject(error); this._fail(error.message); return;
    }
    if (!object(frame.result)) { const error = new Error('ACP returned a malformed result.'); pending.reject(error); this._fail(error.message); return; }
    const result = frame.result;
    pending.resolve(result);
    if (pending.method === 'session/prompt') {
      const usage = this._options.launch.decodeUsage?.(freeze(result));
      if (usage) { this.usage = { ...usage }; }
      if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(String(result.stopReason))) {
        this._fail('ACP returned an unsupported prompt completion.'); return;
      }
      if (result.stopReason !== 'end_turn') { this._push({ type: 'error', content: `${this._options.label} stopped: ${String(result.stopReason)}.` }); }
      this._finish();
    }
  }

  private _permission(id: unknown, params: AcpObject): void {
    const key = idKey(id);
    if (this._cancelling) { this._write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    if (this._seen.has(key) || this._unsupportedRequests.has(key)) { throw new Error('Replayed or conflicting ACP permission identity.'); }
    if (this._seen.size >= MAX_IDENTITIES || this._pendingApprovals.size >= 64) { throw new Error('ACP permission request limit exceeded.'); }
    this._seen.set(key, digest(params));
    if (!this._current() || !this._prompting || params.sessionId !== this._sessionId || !object(params.toolCall) || !idString(params.toolCall.toolCallId)) {
      this._write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      throw new Error('ACP permission request has no current session and prompt owner.');
    }
    const toolId = params.toolCall.toolCallId;
    if ((this._toolRequests.get(toolId) ?? []).some(request => this._pendingApprovals.has(idKey(request)))) {
      throw new Error('ACP requested conflicting concurrent permissions for one tool.');
    }
    const options = params.options;
    if (!Array.isArray(options) || options.length > 32 || options.some(option => !object(option) || !idString(option.optionId) || !idString(option.kind))) {
      throw new Error('ACP permission options are malformed.');
    }
    const choices = options as AcpObject[];
    if (new Set(choices.map(option => option.optionId)).size !== choices.length) { throw new Error('ACP permission option identities conflict.'); }
    const allow = choices.find(option => option.kind === 'allow_once')?.optionId;
    const deny = choices.find(option => option.kind === 'reject_once')?.optionId;
    const tracked = this._tools.get(toolId);
    let decoded = this._options.launch.decodePermission(freeze(params), tracked);
    if (decoded && (decoded.id !== toolId || !idString(decoded.name) || !object(decoded.input))) { throw new Error('The provider could not bind ACP tool authority.'); }
    let decision: 'allow' | 'ask' | 'deny' = 'deny';
    if (decoded && allow && !this._completed.has(toolId)) {
      const action = classifyToolAction(decoded.name);
      const restricted = this._settings.accessLevel === 'read-only' || ['quick-plan', 'detailed-plan'].includes(this._settings.mode);
      if (!restricted || isNeverGatedAction(action)) { decision = shouldGateToolUse(this._settings, decoded.name) ? 'ask' : 'allow'; }
    }
    decoded ??= { id: toolId, name: 'UnknownTool', input: { nativeToolCall: params.toolCall }, status: 'running' };
    const tool = freeze(decoded);
    this._display.set(toolId, tool);
    if (!tracked) { this._push({ type: 'tool_use', toolCall: copy(tool) }); }
    const ids = this._toolRequests.get(toolId) ?? [];
    ids.push(id as string | number); this._toolRequests.set(toolId, ids);
    this._pendingApprovals.add(key);
    this._approvals.request(id as string | number, tool, decision, answer => {
      this._pendingApprovals.delete(key);
      const canAllow = answer === 'allow' && this._current() && this._prompting && !this._completed.has(toolId);
      const selected = canAllow ? allow : answer === 'cancelled' ? undefined : deny;
      this._write({ jsonrpc: '2.0', id, result: { outcome: selected
        ? { outcome: 'selected', optionId: selected } : { outcome: 'cancelled' } } });
    });
  }

  private _update(params: AcpObject): void {
    if (!this._sessionId || params.sessionId !== this._sessionId) { return; }
    if (!object(params.update)) { throw new Error('Malformed ACP session update.'); }
    const update = params.update;
    this._options.launch.validateUpdate?.(freeze(update));
    if (update.sessionUpdate === 'current_mode_update') {
      if (update.currentModeId !== this._mode && update.currentModeId !== this._changingMode) { throw new Error('The native agent changed the captured session mode.'); }
      return;
    }
    if (!this._prompting) { return; }
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const content = textContent(update.content);
      if (content) { this._push({ type: update.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'text', content }); }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') { this._toolUpdate(update); }
    else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
      const text = update.entries.filter(object).map(entry => `${String(entry.status ?? '')}: ${String(entry.content ?? '')}`).join('\n');
      if (text) { this._push({ type: 'text', content: text }); }
    }
    const usage = this._options.launch.decodeUsage?.(freeze(update));
    if (usage) { this.usage = { ...usage }; }
  }

  private _toolUpdate(update: AcpObject): void {
    if (!idString(update.toolCallId)) { throw new Error('ACP tool update has an invalid identity.'); }
    const id = update.toolCallId;
    const prior = this._tools.get(id);
    if (!prior && this._tools.size >= MAX_IDENTITIES) { throw new Error('ACP tool identity limit exceeded.'); }
    if (this._completed.has(id)) {
      // Cline appends progress/denial updates after terminal completion. These
      // are display-only and cannot reopen authority: every later permission
      // for this tool remains denied by _completed, regardless of notification.
      return;
    }
    const merged = freeze({ ...prior, ...update });
    const complete = update.status === 'completed' || update.status === 'failed';
    // A change in proposed authority while its card is open invalidates that
    // decision. Display progress alone does not change the permission input.
    const changed = prior && ['rawInput', 'kind', 'title', 'locations', 'content', '_meta'].some(field => field in update && digest(prior[field] ?? null) !== digest(update[field]));
    if (complete || changed) {
      for (const request of this._toolRequests.get(id) ?? []) { this._approvals.cancel(request); }
    }
    this._tools.set(id, merged);
    const previousDisplay = this._display.get(id);
    const display: ToolCall = previousDisplay ? { ...previousDisplay } : { id,
      name: Object.hasOwn(KIND_NAMES, String(merged.kind)) ? KIND_NAMES[String(merged.kind)] : 'UnknownTool',
      input: object(merged.rawInput) ? copy(merged.rawInput) : {}, status: 'running' };
    if (complete) {
      this._completed.add(id);
      display.status = update.status === 'failed' ? 'failed' : 'completed';
      display.output = textContent(update.content) || (update.rawOutput === undefined ? '' : JSON.stringify(update.rawOutput));
      this._push({ type: 'tool_result', toolCall: copy(display) });
    } else if (!prior) { this._push({ type: 'tool_use', toolCall: copy(display) }); }
    this._display.set(id, freeze(display));
  }

  private _push(chunk: StreamChunk): void {
    if (this._cancelling) { return; }
    if (this._chunks.length >= 10000) { this._fail('ACP output queue limit exceeded.'); return; }
    this._chunks.push(chunk); this._wake?.(); this._wake = undefined;
  }
  private _fail(message: string): void {
    if (this._failed || this._ended) { return; }
    this._failed = true;
    this._chunks.push({ type: 'error', content: `${this._options.label}: ${message}` });
    this._finish(); this._options.terminate();
  }
  private _finish(): void {
    this._ended = true; this._prompting = false; clearInterval(this._clock); clearTimeout(this._cancelTimer);
    this._approvals.dispose(); this._releasePendingListener();
    for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ACP process closed.')); }
    this._pending.clear(); this._wake?.(); this._wake = undefined;
    if (this._cancelling) { this._options.terminate(); }
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    while (true) {
      if (this._chunks.length) { yield this._chunks.shift()!; continue; }
      if (this._ended) { return; }
      await new Promise<void>(resolve => { this._wake = resolve; });
    }
  }
  dispose(): void {
    if (this._disposed) { return; }
    this._finish(); this._disposed = true;
    this._options.signal.removeEventListener('abort', this._onAbort);
    this._options.process.stdout?.removeListener('data', this._onData);
    this._options.process.stderr?.removeListener('data', this._onStderr);
    this._options.process.removeListener('error', this._onError);
    this._options.process.removeListener('exit', this._onExit);
    this._options.process.removeListener('close', this._onExit);
    // An already queued EPIPE still needs a listener while the child shuts down.
  }
}
