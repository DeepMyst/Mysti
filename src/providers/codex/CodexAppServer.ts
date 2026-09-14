/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { STREAM_INACTIVITY_TIMEOUT_MS } from '../../constants';
import { createHash } from 'crypto';
import type { Settings, StreamChunk, ToolCall, UsageStats } from '../../types';
import type { NativeApprovalHandler } from '../base/IProvider';
import { NativeApprovalScope } from '../base/NativeApprovalScope';
import { shouldGateToolUse } from '../../utils/permissionClassifier';

export const CODEX_APP_SERVER_VERSION = '0.153.4';
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 8192;
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_REQUESTS = 4096;
function freezeSnapshot<T>(value: T, depth = 0): T {
  if (depth > 64) { throw new Error('Native approval payload is too deeply nested'); }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) { freezeSnapshot(child, depth + 1); }
    Object.freeze(value);
  }
  return value;
}

export interface CodexAppServerOptions {
  process: ChildProcess;
  panelId: string;
  signal: AbortSignal;
  handler: NativeApprovalHandler | undefined;
  settings: Pick<Settings, 'mode' | 'accessLevel'>;
  isCurrent(): boolean;
  terminate(): void;
  inactivityTimeoutMs?: number;
}

/** One process, one fresh thread and one turn. Responses never grant session authority. */
export class CodexAppServer {
  private readonly _settings: Readonly<Pick<Settings, 'mode' | 'accessLevel'>>;
  private readonly _pending = new Map<string, { resolve(value: JsonObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly _seen = new Map<string, string>();
  private readonly _items = new Map<string, JsonObject>();
  private readonly _completed = new Set<string>();
  private readonly _requestsByItem = new Map<string, Array<string | number>>();
  private readonly _streamed = new Set<string>();
  private readonly _chunks: StreamChunk[] = [];
  private _wake: (() => void) | undefined;
  private _buffer = '';
  private readonly _decoder = new StringDecoder('utf8');
  private readonly _resolved = new Set<string>();
  private _lastActivity = Date.now();
  private readonly _clock: ReturnType<typeof setInterval>;
  private _nextId = 0;
  private _threadId: string | undefined;
  private _turnId: string | undefined;
  private _startingTurn = false;
  private readonly _earlyFrames: JsonObject[] = [];
  private _ended = false;
  private _failed = false;
  private _disposed = false;
  usage: UsageStats | undefined;
  private readonly _approvals: NativeApprovalScope;
  private readonly _onData = (data: Buffer) => this._consume(data);
  private readonly _onError = (error: Error) => this._fail(error.message);
  private readonly _onExit = (code: number | null) => {
    if (!this._ended && !this._options.signal.aborted) { this._fail(`Codex app-server exited before the turn completed (${code ?? 'signal'}).`); }
    this._finish();
  };
  private readonly _onClose = (code: number | null) => {
    if (!this._ended && !this._options.signal.aborted) { this._fail(`Codex app-server exited before the turn completed (${code ?? 'signal'}).`); }
    this._finish();
  };
  private readonly _onAbort = () => {
    this._approvals.dispose();
    if (this._threadId && this._turnId) {
      this._write({ id: `mysti-interrupt-${++this._nextId}`, method: 'turn/interrupt', params: { threadId: this._threadId, turnId: this._turnId } });
    }
    this._finish();
    this._options.terminate();
  };

  constructor(private readonly _options: CodexAppServerOptions) {
    this._settings = Object.freeze({ ..._options.settings });
    this._approvals = new NativeApprovalScope({
      providerId: 'openai-codex', panelId: _options.panelId,
      signal: _options.signal, handler: _options.handler,
      isCurrent: () => this._current(),
    });
    this._clock = setInterval(() => {
      if (this._approvals.hasPending) { this._lastActivity = Date.now(); return; }
      if (Date.now() - this._lastActivity > (_options.inactivityTimeoutMs ?? STREAM_INACTIVITY_TIMEOUT_MS)) { this._fail('Codex app-server became inactive and was terminated.'); }
    }, Math.min(1000, _options.inactivityTimeoutMs ?? 1000));
    this._clock.unref();
    _options.process.stdout?.on('data', this._onData);
    _options.process.on('error', this._onError);
    _options.process.on('close', this._onClose);
    _options.process.on('exit', this._onExit);
    _options.process.stdin?.on('error', this._onError);
    _options.signal.addEventListener('abort', this._onAbort, { once: true });
    if (_options.signal.aborted) { this._onAbort(); }
  }

  get hasPendingApproval(): boolean { return this._approvals.hasPending; }
  get threadId(): string | undefined { return this._threadId; }

  private _current(): boolean { return !this._ended && !this._disposed && !this._options.signal.aborted && this._options.isCurrent(); }

  private _write(frame: JsonObject): void {
    if (this._disposed) { return; }
    if (!this._options.process.stdin?.writable) { this._fail('Codex app-server input closed.'); return; }
    try { this._options.process.stdin.write(JSON.stringify(frame) + '\n'); }
    catch { this._fail('Codex app-server input failed.'); }
  }

  private _request(method: string, params: JsonObject): Promise<JsonObject> {
    if (!this._current()) { return Promise.reject(new Error('Codex turn is no longer active.')); }
    const id = `mysti-${++this._nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`Codex app-server ${method} timed out.`)); this._fail(`Codex app-server ${method} timed out.`); }, 30_000);
      this._pending.set(id, { resolve, reject, timer });
      this._write({ id, method, params });
    });
  }

  async initialize(): Promise<void> {
    const result = await this._request('initialize', {
      clientInfo: { name: 'mysti', title: 'Mysti', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (typeof result.userAgent !== 'string' || !new RegExp(`(?:^|[/ ])${CODEX_APP_SERVER_VERSION.replace(/\./g, '\\.')}([^0-9.]|$)`).test(result.userAgent)) {
      throw new Error(`Mysti native approvals require Codex ${CODEX_APP_SERVER_VERSION}; this app-server reported an unsupported version.`);
    }
    this._write({ method: 'initialized', params: {} });
  }

  async verifyConfiguration(validate: (config: unknown, requirements: unknown) => void, cwd: string): Promise<void> {
    const config = await this._request('config/read', { includeLayers: true, cwd });
    const requirements = await this._request('configRequirements/read', {});
    validate(config, requirements);
  }

  async startThread(params: JsonObject): Promise<string> {
    const result = await this._request('thread/start', params);
    if (!object(result.thread) || !nonempty(result.thread.id)
      || result.approvalPolicy !== 'untrusted' || result.approvalsReviewer !== 'user'
      || !object(result.sandbox) || result.sandbox.type !== 'readOnly' || result.sandbox.networkAccess !== false) {
      throw new Error('Codex did not confirm the required read-only sandbox and native user approval policy.');
    }
    this._threadId = result.thread.id;
    this._push({ type: 'session_active', sessionId: this._threadId });
    return this._threadId;
  }

  async startTurn(params: JsonObject): Promise<void> {
    if (!this._threadId) { throw new Error('Codex thread is not ready.'); }
    this._startingTurn = true;
    const result = await this._request('turn/start', { ...params, threadId: this._threadId });
    if (!object(result.turn) || !nonempty(result.turn.id)) { throw new Error('Codex returned an invalid turn identity.'); }
    this._turnId = result.turn.id;
    this._startingTurn = false;
    for (const frame of this._earlyFrames.splice(0)) {
      try { this._dispatch(frame); }
      catch (error) { this._protocolFailure(error); }
      if (this._ended) { break; }
    }
  }

  private _consume(data: Buffer): void {
    if (this._ended) { return; }
    this._lastActivity = Date.now();
    this._buffer += this._decoder.write(data);
    if (Buffer.byteLength(this._buffer) > MAX_FRAME) { this._fail('Codex app-server frame exceeded the size limit.'); return; }
    let newline: number;
    while ((newline = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, newline); this._buffer = this._buffer.slice(newline + 1);
      if (!line.trim()) { continue; }
      try {
        const frame: unknown = JSON.parse(line);
        if (!object(frame)) { throw new Error('Invalid protocol frame'); }
        this._dispatch(frame);
      } catch (error) { this._protocolFailure(error); return; }
      if (this._ended) { return; }
    }
  }

  private _protocolFailure(error: unknown): void {
    this._fail(`Codex app-server protocol failed: ${error instanceof Error ? error.message : 'invalid frame'}`);
  }

  private _dispatch(frame: JsonObject): void {
    if (this._ended) { return; }
    if (typeof frame.method !== 'string') {
      if (typeof frame.id !== 'string') { throw new Error('Invalid response identity'); }
      const pending = this._pending.get(frame.id);
      if (!pending) { throw new Error('Unexpected or repeated response identity'); }
      this._pending.delete(frame.id); clearTimeout(pending.timer);
      if (object(frame.error)) { pending.reject(new Error(String(frame.error.message ?? 'Codex request failed'))); }
      else if (object(frame.result)) { pending.resolve(frame.result); }
      else { pending.reject(new Error('Malformed Codex response')); }
      return;
    }
    const params = object(frame.params) ? frame.params : {};
    if (this._startingTurn && !this._turnId && params.threadId === this._threadId) {
      if (this._earlyFrames.length >= 256) { throw new Error('Too many events before turn identity'); }
      this._earlyFrames.push(frame); return;
    }
    if ('id' in frame) { this._approval(frame, params); return; }
    this._notification(frame.method, params);
  }

  private _approval(frame: JsonObject, params: JsonObject): void {
    const id = frame.id;
    if (!(typeof id === 'string' && nonempty(id)) && !(typeof id === 'number' && Number.isSafeInteger(id))) { throw new Error('Invalid approval identity'); }
    const key = `${typeof id}:${id}`;
    const digest = createHash('sha256').update(JSON.stringify(frame)).digest('hex');
    const previous = this._seen.get(key);
    if (previous !== undefined) { throw new Error(previous === digest ? 'Replayed approval identity' : 'Conflicting approval identity'); }
    if (this._seen.size >= MAX_REQUESTS) { throw new Error('Native approval limit exceeded'); }
    this._seen.set(key, digest);
    const validOwner = this._current() && !this._completed.has(String(params.itemId)) && params.threadId === this._threadId && params.turnId === this._turnId && nonempty(params.itemId);
    const method = frame.method;
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      this._write({ id, error: { code: -32601, message: 'Mysti does not grant this native authority.' } });
      throw new Error(`Unsupported Codex native request: ${String(method)}`);
    }
    const item = validOwner ? this._items.get(params.itemId as string) : undefined;
    let tool: ToolCall | undefined;
    let denied = !validOwner || !item;
    if (method === 'item/commandExecution/requestApproval') {
      denied ||= item?.type !== 'commandExecution' || params.kind !== 'command' || !nonempty(params.command)
        || params.command !== item?.command || params.cwd !== item?.cwd
        || (params.environmentId !== null && params.environmentId !== undefined)
        || (params.additionalPermissions !== null && params.additionalPermissions !== undefined) || (params.networkApprovalContext !== null && params.networkApprovalContext !== undefined)
        || (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept'));
      tool = { id: String(params.itemId ?? id), name: 'Bash', input: { command: params.command, cwd: params.cwd, reason: params.reason }, status: 'running', kind: 'execute' };
    } else {
      denied ||= item?.type !== 'fileChange' || (params.grantRoot !== null && params.grantRoot !== undefined) || !Array.isArray(item?.changes) || item.changes.length === 0;
      const changes = Array.isArray(item?.changes) ? item.changes : [];
      denied ||= changes.some(change => !object(change) || !nonempty(change.path) || typeof change.diff !== 'string' || !object(change.kind) || !['add', 'update', 'delete'].includes(String(change.kind.type)));
      const deletes = changes.some(change => object(change) && object(change.kind) && change.kind.type === 'delete');
      tool = { id: String(params.itemId ?? id), name: deletes ? 'Delete' : 'Edit', input: { changes: JSON.parse(JSON.stringify(changes)) as unknown[] }, status: 'running', kind: 'edit' };
    }
    const settings = this._settings;
    denied ||= settings.accessLevel === 'read-only' || settings.mode === 'quick-plan' || settings.mode === 'detailed-plan';
    const decision = denied ? 'deny' : shouldGateToolUse(settings, tool.name) ? 'ask' : 'allow';
    const itemRequests = this._requestsByItem.get(String(params.itemId)) ?? [];
    itemRequests.push(id as string | number); this._requestsByItem.set(String(params.itemId), itemRequests);
    freezeSnapshot(tool);
    this._approvals.request(id as string | number, tool, decision, answer => {
      // Every answer is scoped to this callback. Session/rule/root grants are never emitted.
      const currentItem = this._items.get(String(params.itemId));
      const allow = answer === 'allow' && this._current() && currentItem === item && !this._completed.has(String(params.itemId));
      if (this._resolved.has(key)) { return; }
      this._write({ id, result: { decision: allow ? 'accept' : answer === 'cancelled' ? 'cancel' : 'decline' } });
    });
  }

  private _notification(method: string, params: JsonObject): void {
    if (method === 'serverRequest/resolved' && params.threadId === this._threadId) {
      if (typeof params.requestId !== 'string' && typeof params.requestId !== 'number') { throw new Error('Invalid resolved approval identity'); }
      const resolvedKey = `${typeof params.requestId}:${params.requestId}`;
      if (!this._seen.has(resolvedKey)) { throw new Error('Unknown resolved approval identity'); }
      this._resolved.add(resolvedKey);
      this._approvals.cancel(params.requestId); return;
    }
    if ((method === 'thread/closed' || method === 'thread/settings/updated') && params.threadId === this._threadId) { this._fail('Codex changed or closed the captured thread authority.'); return; }
    if (method === 'error' && params.willRetry === true) { return; }
    if (method === 'error') { this._fail(object(params.error) ? String(params.error.message ?? 'Codex turn failed') : 'Codex turn failed'); return; }
    if (!this._threadId || !this._turnId || params.threadId !== this._threadId) { return; }
    const eventTurnId = method === 'turn/completed' && object(params.turn) ? params.turn.id : params.turnId;
    if (eventTurnId !== this._turnId) { return; }
    if (method === 'item/fileChange/patchUpdated') { throw new Error('Codex changed a patch after its captured approval item.'); }
    if (method === 'turn/completed') {
      if (!object(params.turn) || params.turn.id !== this._turnId) { throw new Error('Mismatched completed turn'); }
      if (params.turn.status !== 'completed') { this._push({ type: 'error', content: object(params.turn.error) ? String(params.turn.error.message ?? 'Codex turn did not complete.') : `Codex turn ${String(params.turn.status)}.` }); }
      this._finish(); return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!object(params.item) || !nonempty(params.item.id)) { throw new Error('Invalid native item'); }
      const item = params.item;
      if (method === 'item/started') {
        if (this._items.has(item.id as string)) { throw new Error('Repeated native item identity'); }
        if (this._items.size >= MAX_REQUESTS) { throw new Error('Native item limit exceeded'); }
        this._items.set(item.id as string, freezeSnapshot(item));
      }
      if (method === 'item/completed') {
        if (this._completed.has(String(item.id))) { throw new Error('Repeated completed native item'); }
        this._completed.add(String(item.id));
        for (const requestId of this._requestsByItem.get(String(item.id)) ?? []) { this._approvals.cancel(requestId); }
      }
      this._item(item, method === 'item/completed'); return;
    }
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta' || method === 'item/plan/delta') {
      if (!nonempty(params.itemId) || typeof params.delta !== 'string') { throw new Error('Invalid content delta'); }
      this._streamed.add(params.itemId);
      this._push({ type: method.includes('reasoning') ? 'thinking' : 'text', content: params.delta }); return;
    }
    if (method === 'thread/tokenUsage/updated' && object(params.tokenUsage) && object(params.tokenUsage.last)) {
      const usage = params.tokenUsage.last;
      this.usage = { input_tokens: Number(usage.inputTokens) || 0, output_tokens: Number(usage.outputTokens) || 0, cache_read_input_tokens: Number(usage.cachedInputTokens) || 0 };
    }
  }

  private _item(item: JsonObject, completed: boolean): void {
    const id = String(item.id);
    if ((item.type === 'agentMessage' || item.type === 'plan') && completed && !this._streamed.has(id) && typeof item.text === 'string') { this._push({ type: 'text', content: item.text }); }
    if (item.type === 'reasoning' && completed && !this._streamed.has(id)) {
      const text = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].filter(value => typeof value === 'string').join('\n');
      if (text) { this._push({ type: 'thinking', content: text }); }
    }
    if (item.type === 'commandExecution' || item.type === 'fileChange') {
      const command = item.type === 'commandExecution';
      this._push({ type: completed ? 'tool_result' : 'tool_use', toolCall: {
        id, name: command ? 'Bash' : 'Edit', kind: command ? 'execute' : 'edit',
        input: command ? { command: item.command, cwd: item.cwd } : { changes: JSON.parse(JSON.stringify(item.changes)) as unknown[] },
        status: completed ? item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'failed' : 'completed' : 'running',
        ...(completed ? { output: command ? String(item.aggregatedOutput ?? '') : String(item.status ?? '') } : {}),
      } });
    }
    if (['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'imageGeneration'].includes(String(item.type))) { throw new Error(`Unsupported Codex execution route: ${String(item.type)}`); }
  }

  private _push(chunk: StreamChunk): void {
    if (this._chunks.length >= 10_000) { this._fail('Codex output queue limit exceeded.'); return; }
    this._chunks.push(chunk); this._wake?.(); this._wake = undefined;
  }
  private _fail(message: string): void {
    if (this._failed || this._ended) { return; }
    this._failed = true;
    this._chunks.push({ type: 'error', content: message });
    // Startup awaits RPCs before consuming stream(), so preserve the cause there too.
    this._finish(new Error(message)); this._options.terminate();
  }
  private _finish(error = new Error('Codex app-server closed.')): void {
    this._ended = true; clearInterval(this._clock); this._approvals.dispose();
    for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this._pending.clear(); this._wake?.(); this._wake = undefined;
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
    this._options.process.removeListener('error', this._onError);
    this._options.process.removeListener('close', this._onClose);
    this._options.process.removeListener('exit', this._onExit);
    // Keep the stdin error listener through process shutdown (EPIPE must not escape).
  }
}
