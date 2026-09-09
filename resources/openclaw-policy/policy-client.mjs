/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import { markOwnedExecutionContext } from './runtime-guard.mjs';

// Background processes, delegated agents and alternate harnesses need their own
// lifetime authority; none are admitted by this verified embedded tool path.
export const SUPPORTED_TOOLS = Object.freeze(['read', 'write', 'edit', 'exec']);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Wire digest: the same six-field canonical JSON envelope used by the host. */
export function actionDigest(action) {
  let values = 0;
  let bytes = 0;
  const active = new Set();
  const charge = token => {
    bytes += Buffer.byteLength(token, 'utf8');
    if (bytes > 1024 * 1024) { throw new Error('Mysti action byte limit'); }
    return token;
  };
  function canonical(value, depth) {
    if (++values > 100000 || depth > 32) { throw new Error('Mysti action structure limit'); }
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) {
      if (typeof value === 'string' && value.length > 1024 * 1024) { throw new Error('Mysti action string limit'); }
      return charge(JSON.stringify(value));
    }
    if (!value || typeof value !== 'object' || active.has(value)) { throw new Error('Mysti action must be JSON'); }
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      throw new Error('Mysti action must be plain JSON');
    }
    active.add(value);
    charge('[]');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 100001 || keys.some(key => typeof key !== 'string')) { throw new Error('Mysti action property limit'); }
    const read = key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) { throw new Error('Mysti action accessor property'); }
      return canonical(descriptor.value, depth + 1);
    };
    let result;
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || value.length > 100000) { throw new Error('Mysti action sparse array'); }
      result = `[${Array.from({ length: value.length }, (_, index) => `${index ? charge(',') : ''}${read(String(index))}`).join('')}]`;
    } else { result = `{${keys.sort().map((key, index) => `${charge(`${index ? ',' : ''}${JSON.stringify(key)}:`)}${read(key)}`).join('')}}`; }
    active.delete(value);
    return result;
  }
  const fields = ['requestId', 'runId', 'sessionKey', 'toolCallId', 'toolName', 'params'];
  if (!action || Reflect.ownKeys(action).length !== fields.length || !fields.every(field => Object.hasOwn(action, field))
    || !fields.slice(0, 5).every(field => identifier(action[field])) || !action.params || Array.isArray(action.params)
    || typeof action.params !== 'object') { throw new Error('Mysti action identity is invalid'); }
  const json = `{${fields.sort().map(field => `${JSON.stringify(field)}:${canonical(action[field], 0)}`).join(',')}}`;
  if (Buffer.byteLength(json) > 1024 * 1024) { throw new Error('Mysti action byte limit'); }
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/** Consumer only: this endpoint cannot create authority or approve its own calls. */
export class MystiPolicyClient {
  constructor(credentials, WebSocket, receipt, options = {}) {
    const url = new URL(credentials?.url);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || !/^[a-f0-9]{64}$/.test(credentials.token) || !identifier(credentials.runtimeId)) {
      throw new Error('Mysti policy requires owned authenticated loopback transport');
    }
    this.credentials = Object.freeze({ ...credentials });
    this.WebSocket = WebSocket;
    this.receipt = receipt;
    this.now = options.now ?? Date.now;
    this.markOwned = options.markOwned ?? markOwnedExecutionContext;
    this.grants = new Map();
    this.pending = new Map();
    this.closed = false;
    this.ready = false;
    this.lastHeartbeat = 0;
  }

  start() {
    if (this.closed || this.socket) { return Promise.reject(new Error('Mysti policy connection already used')); }
    return new Promise((resolve, reject) => {
      const socket = this.socket = new this.WebSocket(this.credentials.url, { maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
      const timer = setTimeout(() => this.dispose(), 10000);
      const fail = () => { clearTimeout(timer); this.dispose(); reject(new Error('Mysti native policy connection closed')); };
      socket.on('error', fail);
      socket.on('close', fail);
      socket.on('open', () => this.send({ type: 'hello', protocol: 1, ...this.credentials, guard: this.receipt, harness: 'pi' }));
      socket.on('message', (data, binary) => {
        try {
          if (binary) { throw new Error('Mysti binary policy frame'); }
          const value = JSON.parse(data.toString());
          if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Mysti invalid policy frame'); }
          if (!this.ready) {
            if (value.type !== 'hello.ready' || value.protocol !== 1 || value.runtimeId !== this.credentials.runtimeId) {
              throw new Error('Mysti policy handshake rejected');
            }
            this.ready = true;
            this.lastHeartbeat = this.now();
            clearTimeout(timer);
            this.timer = setInterval(() => this.expire(), 1000);
            this.timer.unref();
            resolve();
          } else { this.receive(value); }
        } catch { fail(); }
      });
    });
  }

  send(value) {
    if (this.closed || this.socket?.readyState !== this.WebSocket.OPEN) { return false; }
    try { this.socket.send(JSON.stringify(value), error => { if (error) { this.dispose(); } }); return true; }
    catch { this.dispose(); return false; }
  }

  receive(value) {
    // Expiry is irreversible, even when a delayed frame arrives before the
    // periodic sweep. A renewal must never resurrect an old execution signal.
    this.expire();
    if (this.closed) { return; }
    if (value.type === 'heartbeat' && value.runtimeId === this.credentials.runtimeId) {
      this.lastHeartbeat = this.now();
      this.send({ type: 'heartbeat.ack', runtimeId: this.credentials.runtimeId });
      return;
    }
    if (value.type === 'run.open') {
      if (!identifier(value.runId) || !value.runId.startsWith('mysti-') || !identifier(value.sessionKey)
        || !/^agent:main:mysti-/.test(value.sessionKey) || !identifier(value.grantId)
        || this.grants.has(value.runId) || this.grants.size >= 64 || !this.validExpiry(value.expiresAt)) {
        throw new Error('Mysti owned run grant is invalid');
      }
      this.markOwned({ runId: value.runId, sessionKey: value.sessionKey });
      this.grants.set(value.runId, { ...value, controller: new AbortController() });
      this.send({ type: 'run.ready', runId: value.runId, grantId: value.grantId, ready: true });
      return;
    }
    const grant = this.grants.get(value.runId);
    if (value.type === 'run.renew') {
      if (grant?.grantId === value.grantId && this.validExpiry(value.expiresAt)) { grant.expiresAt = value.expiresAt; }
      return;
    }
    if (value.type === 'run.revoke') {
      if (grant?.grantId === value.grantId) { this.revoke(grant); }
      return;
    }
    if (value.type === 'tool.decision') {
      const pending = this.pending.get(value.requestId);
      if (pending && pending.grant === grant && grant?.grantId === value.grantId) {
        pending.finish(value.decision === 'allow' && value.actionDigest === pending.digest && this.isCurrent(grant));
      }
      return;
    }
    throw new Error('Mysti unexpected policy frame');
  }

  validExpiry(value) { return Number.isSafeInteger(value) && value > this.now() && value <= this.now() + 16000; }
  isCurrent(grant) {
    return !this.closed && this.ready && this.socket?.readyState === this.WebSocket.OPEN && !!grant
      && this.grants.get(grant.runId) === grant && !grant.controller.signal.aborted
      && grant.expiresAt > this.now() && this.now() - this.lastHeartbeat < 15000;
  }
  owns(context) {
    const grant = this.grants.get(context?.runId);
    return this.isCurrent(grant) && context.sessionKey === grant.sessionKey;
  }
  supports(request) {
    if (!SUPPORTED_TOOLS.includes(request.toolName) || request.toolKind || request.toolInputKind) { return false; }
    if (request.toolName !== 'exec') { return true; }
    const params = request.params;
    // Only the foreground local service-group path has owned crash cleanup.
    // PTYs, remote nodes and elevated/background execution need other lifetimes.
    return !!params && typeof params === 'object' && !Array.isArray(params)
      && (params.pty === undefined || params.pty === false)
      && (params.background === undefined || params.background === false)
      && (params.elevated === undefined || params.elevated === false)
      && (params.host === undefined || params.host === 'gateway') && params.node === undefined;
  }
  async evaluate(request) {
    this.expire();
    const grant = this.grants.get(request.context?.runId);
    const current = () => this.owns(request.context) && this.grants.get(grant?.runId) === grant && !request.signal.aborted;
    if (!current() || !this.supports(request) || this.pending.size >= 1024) { return { allow: false, isCurrent: current }; }
    const action = { requestId: randomUUID(), runId: grant.runId, sessionKey: grant.sessionKey,
      toolCallId: request.toolCallId, toolName: request.toolName, params: request.params };
    let digest;
    try { digest = actionDigest(action); } catch { return { allow: false, isCurrent: current }; }
    const allow = await new Promise(resolve => {
      const abort = () => finish(false);
      const finish = value => {
        this.pending.delete(action.requestId);
        request.signal.removeEventListener('abort', abort);
        grant.controller.signal.removeEventListener('abort', abort);
        resolve(value && current());
      };
      this.pending.set(action.requestId, { grant, digest, finish });
      request.signal.addEventListener('abort', abort, { once: true });
      grant.controller.signal.addEventListener('abort', abort, { once: true });
      if (!current() || !this.send({ type: 'tool.request', grantId: grant.grantId, ...action })) { finish(false); }
    });
    return { allow, isCurrent: current, executionSignal: grant.controller.signal };
  }
  expire() {
    if (this.now() - this.lastHeartbeat >= 15000) { this.dispose(); return; }
    for (const grant of this.grants.values()) { if (!this.isCurrent(grant)) { this.revoke(grant); } }
  }
  revoke(grant) {
    if (this.grants.get(grant.runId) !== grant) { return; }
    this.grants.delete(grant.runId);
    grant.controller.abort();
  }
  dispose() {
    if (this.closed) { return; }
    this.closed = true;
    this.ready = false;
    clearInterval(this.timer);
    for (const grant of this.grants.values()) { this.revoke(grant); }
    for (const pending of this.pending.values()) { pending.finish(false); }
    this.socket?.terminate();
  }
}
