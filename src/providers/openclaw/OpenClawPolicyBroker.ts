/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawPolicyRun, OPENCLAW_POLICY_PROTOCOL, type OpenClawPolicyRunOptions } from './OpenClawPolicyRun';

const LEASE_MS = 15_000;
const HANDSHAKE_MS = 10_000;
const MAX_PAYLOAD = 2 * 1024 * 1024;

export interface OpenClawBrokerCredentials {
  url: string;
  token: string;
  runtimeId: string;
}

export interface OpenClawBrokerLease {
  readonly runId: string;
  readonly sessionKey: string;
  readonly signal: AbortSignal;
  readonly hasPending: boolean;
  onPendingChanged(listener: () => void): () => void;
  dispose(): void;
}

interface OwnedRun {
  policy: OpenClawPolicyRun;
  controller: AbortController;
  grantId: string;
  runId: string;
  sessionKey: string;
  socket: WebSocket;
  removeAbort: () => void;
}

/**
 * One owned native runtime consumes decisions from this loopback connection.
 * Only in-process callers can create leases; the peer cannot grant authority,
 * change settings, approve a card, or attach itself to an existing run.
 */
export class OpenClawPolicyBroker {
  private readonly _runtimeId = randomUUID();
  private readonly _token = randomBytes(32).toString('hex');
  private readonly _runs = new Map<string, OwnedRun>();
  private readonly _waiters = new Set<() => void>();
  private readonly _acks = new Map<string, (ready: boolean) => void>();
  private readonly _sockets = new Set<WebSocket>();
  private _server?: WebSocketServer;
  private _socket?: WebSocket;
  private _closed = false;
  private _credentials?: OpenClawBrokerCredentials;
  private _heartbeat?: ReturnType<typeof setInterval>;
  private _lastHeartbeat = 0;

  constructor(private readonly _expected: { version: string; targetHash: string }) {}

  async listen(): Promise<OpenClawBrokerCredentials> {
    if (this._closed) { throw new Error('OpenClaw policy broker is closed.'); }
    if (this._credentials) { return this._credentials; }
    if (this._server) { throw new Error('OpenClaw policy broker startup is already pending.'); }
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    this._server = server;
    server.on('connection', (socket, request) => {
      if (this._closed || request.headers.origin || this._sockets.size >= 4) { socket.terminate(); return; }
      this._sockets.add(socket);
      const timer = setTimeout(() => socket.terminate(), HANDSHAKE_MS);
      timer.unref();
      socket.on('error', () => this._retireSocket(socket));
      socket.on('close', () => { clearTimeout(timer); this._sockets.delete(socket); this._retireSocket(socket); });
      socket.on('message', (data, binary) => {
        if (binary) { socket.terminate(); return; }
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(data.toString());
          if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid frame'); }
        } catch { socket.terminate(); return; }
        if (this._socket !== socket) {
          if (this._socket || !this._isHello(value)) { socket.terminate(); return; }
          clearTimeout(timer);
          this._socket = socket;
          this._lastHeartbeat = Date.now();
          this._send(socket, { type: 'hello.ready', protocol: OPENCLAW_POLICY_PROTOCOL, runtimeId: this._runtimeId });
          for (const notify of this._waiters) { notify(); }
          return;
        }
        this._receive(socket, value);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const ready = () => { server.removeListener('error', failed); resolve(); };
      const failed = (error: Error) => { server.removeListener('listening', ready); reject(error); };
      server.once('listening', ready);
      server.once('error', failed);
    });
    server.on('error', () => this.dispose());
    if (this._closed) { throw new Error('OpenClaw policy broker startup was cancelled.'); }
    const address = server.address() as AddressInfo;
    this._credentials = Object.freeze({ url: `ws://127.0.0.1:${address.port}`, token: this._token, runtimeId: this._runtimeId });
    this._heartbeat = setInterval(() => {
      const socket = this._socket;
      if (!socket) { return; }
      if (Date.now() - this._lastHeartbeat >= LEASE_MS) { socket.terminate(); this._retireSocket(socket); return; }
      this._send(socket, { type: 'heartbeat', runtimeId: this._runtimeId });
      for (const run of this._runs.values()) {
        this._send(socket, { type: 'run.renew', runId: run.runId, grantId: run.grantId, expiresAt: Date.now() + LEASE_MS });
      }
    }, LEASE_MS / 3);
    this._heartbeat.unref();
    return this._credentials;
  }

  waitUntilReady(signal: AbortSignal, timeoutMs = HANDSHAKE_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this._waiters.delete(check);
        signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (signal.aborted || this._closed) { finish(new Error('OpenClaw policy startup was cancelled.')); }
        else if (this._socket?.readyState === WebSocket.OPEN) { finish(); }
      };
      const aborted = () => finish(new Error('OpenClaw policy startup was cancelled.'));
      const timer = setTimeout(() => finish(new Error('OpenClaw native policy did not become ready.')), timeoutMs);
      this._waiters.add(check);
      signal.addEventListener('abort', aborted, { once: true });
      check();
    });
  }

  async openRun(options: OpenClawPolicyRunOptions): Promise<OpenClawBrokerLease> {
    await this.waitUntilReady(options.signal);
    const socket = this._socket!;
    if (this._runs.has(options.runId) || this._runs.size >= 64) { throw new Error('OpenClaw policy run identity is unavailable.'); }
    const controller = new AbortController();
    const abort = () => this._retireRun(options.runId, controller);
    const owned: OwnedRun = {
      runId: options.runId, sessionKey: options.sessionKey, grantId: randomUUID(), socket, controller,
      removeAbort: () => options.signal.removeEventListener('abort', abort),
      policy: new OpenClawPolicyRun({ ...options, signal: controller.signal,
        isCurrent: () => !this._closed && this._socket === socket && this._runs.get(options.runId) === owned
          && !options.signal.aborted && options.isCurrent(),
      }),
    };
    this._runs.set(options.runId, owned);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted || !options.isCurrent()) { abort(); throw new Error('OpenClaw policy run was cancelled.'); }
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (ready: boolean) => {
          clearTimeout(timer);
          this._acks.delete(owned.grantId);
          ready ? resolve() : reject(new Error('OpenClaw native runtime rejected the owned run.'));
        };
        const timer = setTimeout(() => finish(false), HANDSHAKE_MS);
        this._acks.set(owned.grantId, finish);
        this._send(socket, { type: 'run.open', runId: owned.runId, sessionKey: owned.sessionKey,
          grantId: owned.grantId, expiresAt: Date.now() + LEASE_MS });
      });
      if (controller.signal.aborted || this._socket !== socket || !options.isCurrent()) {
        throw new Error('OpenClaw policy run was cancelled before submission.');
      }
      return {
        runId: owned.runId, sessionKey: owned.sessionKey, signal: controller.signal,
        get hasPending() { return owned.policy.hasPending; },
        onPendingChanged: listener => owned.policy.onPendingChanged(listener),
        dispose: abort,
      };
    } catch (error) { abort(); throw error; }
  }

  private _isHello(value: Record<string, unknown>): boolean {
    if (value.type !== 'hello' || value.protocol !== OPENCLAW_POLICY_PROTOCOL || value.runtimeId !== this._runtimeId
      || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) { return false; }
    const receipt = value.guard as Record<string, unknown> | undefined;
    return !!receipt && receipt.version === this._expected.version && receipt.targetHash === this._expected.targetHash
      && receipt.protocolVersion === OPENCLAW_POLICY_PROTOCOL
      && value.harness === 'pi' && timingSafeEqual(Buffer.from(value.token), Buffer.from(this._token));
  }

  private _receive(socket: WebSocket, value: Record<string, unknown>): void {
    // A delayed acknowledgement cannot revive a peer whose lease already
    // elapsed but whose periodic sweep has not run yet.
    if (Date.now() - this._lastHeartbeat >= LEASE_MS) {
      this._retireSocket(socket);
      socket.terminate();
      return;
    }
    if (value.type === 'heartbeat.ack' && value.runtimeId === this._runtimeId) { this._lastHeartbeat = Date.now(); return; }
    if (value.type === 'run.ready' && typeof value.runId === 'string' && typeof value.grantId === 'string') {
      const run = this._runs.get(value.runId);
      if (run?.socket === socket && run.grantId === value.grantId) { this._acks.get(run.grantId)?.(value.ready === true); }
      return;
    }
    if (value.type !== 'tool.request' || typeof value.runId !== 'string' || typeof value.grantId !== 'string'
      || typeof value.requestId !== 'string') { socket.terminate(); return; }
    const run = this._runs.get(value.runId);
    if (!run || run.socket !== socket || run.grantId !== value.grantId || run.controller.signal.aborted) {
      this._send(socket, { type: 'tool.decision', requestId: value.requestId, runId: value.runId,
        grantId: value.grantId, decision: 'deny', actionDigest: '' });
      return;
    }
    const action = { requestId: value.requestId, runId: value.runId, sessionKey: value.sessionKey,
      toolCallId: value.toolCallId, toolName: value.toolName, params: value.params };
    void run.policy.request(action).then(result => {
      const current = this._socket === socket && this._runs.get(run.runId) === run && !run.controller.signal.aborted;
      this._send(socket, { type: 'tool.decision', requestId: value.requestId, runId: run.runId,
        grantId: run.grantId, ...result, decision: current && result.decision === 'allow' ? 'allow' : 'deny' });
    }, () => this._retireRun(run.runId, run.controller));
  }

  private _retireRun(runId: string, controller: AbortController): void {
    const run = this._runs.get(runId);
    if (!run || run.controller !== controller) { return; }
    this._runs.delete(runId);
    controller.abort();
    run.policy.dispose();
    run.removeAbort();
    this._acks.get(run.grantId)?.(false);
    this._send(run.socket, { type: 'run.revoke', runId, grantId: run.grantId });
  }

  private _retireSocket(socket: WebSocket): void {
    if (this._socket !== socket) { return; }
    this._socket = undefined;
    for (const run of [...this._runs.values()]) { this._retireRun(run.runId, run.controller); }
  }

  private _send(socket: WebSocket, value: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) { return; }
    try { socket.send(JSON.stringify(value), error => { if (error) { socket.terminate(); } }); }
    catch { socket.terminate(); }
  }

  dispose(): void {
    if (this._closed) { return; }
    this._closed = true;
    clearInterval(this._heartbeat);
    for (const run of [...this._runs.values()]) { this._retireRun(run.runId, run.controller); }
    for (const notify of this._waiters) { notify(); }
    for (const socket of this._sockets) { socket.terminate(); }
    this._socket = undefined;
    this._server?.close();
  }
}
