/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';

const MAX_REQUEST_BYTES = 256 * 1024;
const POLL_MS = 20;
const PARTIAL_WRITE_RETRIES = 15;
const DENIAL = 'This tool cannot run in Mysti Plan or Read Only mode. Only file reads and searches are permitted.';
const SAFE_PART = /^[a-zA-Z0-9._-]{1,180}$/;

/** Request-local implementation of Cline's desktop tool-approval file protocol.
 * The installed CLI writes requests non-atomically and waits for a decision.
 * This is a tool permission boundary, not containment of trusted native hooks.
 */
export class ClineReadOnlyApproval {
  readonly directory: string;
  private readonly _identity: fs.Stats;
  private readonly _attempts = new Map<string, number>();
  private readonly _completed = new Map<string, string>();
  private _sessionId: string | undefined;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _process: ChildProcess | undefined;
  private _closed = false;
  private _disposed = false;
  private readonly _onAbort = () => this.dispose();
  private readonly _onClose = () => {
    this._closed = true;
    this.dispose();
    this._process?.removeListener('error', this._onError);
  };
  private readonly _onError = () => {
    if (!this._process?.pid) { this._onClose(); }
  };

  constructor(private readonly _owner: { signal: AbortSignal; isCurrent(): boolean }) {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-approval-'));
    try {
      fs.chmodSync(this.directory, 0o700);
      this._identity = fs.lstatSync(this.directory);
    } catch (error) {
      fs.rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
    _owner.signal.addEventListener('abort', this._onAbort, { once: true });
    if (_owner.signal.aborted) { this.dispose(); }
  }

  get environment(): Record<string, string> {
    return { CLINE_TOOL_APPROVAL_MODE: 'desktop', CLINE_TOOL_APPROVAL_DIR: this.directory };
  }

  bind(process: ChildProcess): void {
    this._process = process;
    process.once('close', this._onClose);
    process.once('error', this._onError);
    if (!this._disposed) {
      this._timer = setInterval(() => this._poll(), POLL_MS);
      this._timer.unref();
    }
  }

  /** Revoke authority now; the child can still be unwinding its native writer. */
  dispose(): void {
    this._disposed = true;
    this._owner.signal.removeEventListener('abort', this._onAbort);
    if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
    if ((!this._process || this._closed) && this._ownsDirectory()) {
      try { fs.rmSync(this.directory, { recursive: true, force: true }); } catch { /* temporary directory cleanup */ }
    }
  }

  private _isCurrent(): boolean {
    if (this._disposed || this._owner.signal.aborted || !this._owner.isCurrent()) { return false; }
    return this._ownsDirectory();
  }

  private _ownsDirectory(): boolean {
    try {
      const stat = fs.lstatSync(this.directory);
      return stat.isDirectory() && !stat.isSymbolicLink()
        && stat.dev === this._identity.dev && stat.ino === this._identity.ino;
    } catch { return false; }
  }

  private _poll(): void {
    if (!this._isCurrent()) { this.dispose(); return; }
    let directory: fs.Dir | undefined;
    try {
      directory = fs.opendirSync(this.directory);
      // Bound work on the extension thread, including unexpected directory entries.
      for (let count = 0; count < 128; count++) {
        const entry = directory.readSync();
        if (!entry) { break; }
        if (entry.name.endsWith('.json') && entry.name.includes('.request.')) { this._read(entry.name); }
      }
    } catch { /* A missing/unreadable request cannot grant permission. */ }
    finally { try { directory?.closeSync(); } catch { /* directory was removed */ } }
  }

  private _read(filename: string): void {
    // Fresh CLI session IDs are UUIDs; a tool-call ID can itself contain this
    // delimiter because the native sanitizer preserves dots.
    const separator = filename.indexOf('.request.');
    const sessionId = filename.slice(0, separator);
    const requestId = filename.slice(separator + '.request.'.length, -'.json'.length);
    if (!SAFE_PART.test(sessionId) || !SAFE_PART.test(requestId)) { return; }
    const requestPath = path.join(this.directory, filename);
    let descriptor: number | undefined;
    let fingerprint: string | undefined;
    let value: unknown;
    try {
      // lstat excludes links even on platforms lacking O_NOFOLLOW; open/fstat
      // also exclude a swapped link or non-regular file on supported platforms.
      const before = fs.lstatSync(requestPath);
      fingerprint = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}`;
      if (this._completed.get(filename) === fingerprint) { return; }
      if (!before.isFile() || before.size > MAX_REQUEST_BYTES) {
        this._reject(filename, sessionId, requestId, fingerprint);
        return;
      }
      descriptor = fs.openSync(requestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES || before.dev !== stat.dev || before.ino !== stat.ino) {
        this._reject(filename, sessionId, requestId, fingerprint);
        return;
      }
      const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_REQUEST_BYTES + 1));
      const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count > MAX_REQUEST_BYTES) { this._reject(filename, sessionId, requestId, fingerprint); return; }
      value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } catch {
      // Native writeFile is not atomic. Retry a bounded number of times before
      // rejecting an incomplete/malformed request with a safe filename.
      const attempts = (this._attempts.get(filename) ?? 0) + 1;
      this._attempts.set(filename, attempts);
      if (attempts >= PARTIAL_WRITE_RETRIES && fingerprint) {
        this._reject(filename, sessionId, requestId, fingerprint);
      }
      return;
    } finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* already closed */ } } }

    const request = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
    const valid = request?.sessionId === sessionId && request.requestId === requestId
      && typeof request.toolCallId === 'string' && request.toolCallId.length > 0 && request.toolCallId.length <= 512
      && request.toolCallId.replace(/[^a-zA-Z0-9._-]+/g, '_') === requestId
      && typeof request.toolName === 'string'
      && typeof request.createdAt === 'string' && Number.isFinite(Date.parse(request.createdAt))
      && typeof request.agentId === 'string' && typeof request.conversationId === 'string'
      && Number.isInteger(request.iteration) && (request.iteration as number) >= 0
      && Object.prototype.hasOwnProperty.call(request, 'input');
    const duplicate = this._completed.has(filename);
    if (valid && !this._sessionId) { this._sessionId = sessionId; }
    const allowed = valid && !duplicate && this._sessionId === sessionId
      && (request.toolName === 'read_files' || request.toolName === 'search_codebase');
    this._publish(sessionId, requestId, allowed === true, DENIAL);
    if (fingerprint) { this._completed.set(filename, fingerprint); }
    this._attempts.delete(filename);
  }

  private _reject(filename: string, sessionId: string, requestId: string, fingerprint: string): void {
    this._publish(sessionId, requestId, false, 'Invalid Cline Plan / Read Only approval request.');
    this._completed.set(filename, fingerprint);
    this._attempts.delete(filename);
  }

  private _publish(sessionId: string, requestId: string, approved: boolean, reason: string): void {
    if (!this._isCurrent()) { return; }
    const target = path.join(this.directory, `${sessionId}.decision.${requestId}.json`);
    const temporary = path.join(this.directory, `.decision-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ requestId, sessionId, approved, ...(!approved ? { reason } : {}) }), { flag: 'wx', mode: 0o600 });
      // Synchronous check + rename has no await at which cancellation or a
      // replacement request could retain this scope's approval authority.
      if (this._isCurrent()) { fs.renameSync(temporary, target); }
    } catch { /* Permission is denied unless a complete decision is published. */ }
    finally { try { fs.unlinkSync(temporary); } catch { /* renamed or removed */ } }
  }
}
