/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'crypto';
import { types } from 'util';
import type { Settings } from '../../types';
import { classifyToolAction, isNeverGatedAction, shouldGateToolUse } from '../../utils/permissionClassifier';
import { ACCESS_LEVELS, OPERATION_MODES } from '../../utils/settingsClamp';
import { toolKind } from '../../utils/toolNames';
import type { NativeApprovalDecision, NativeApprovalHandler } from '../base/IProvider';
import { NativeApprovalScope } from '../base/NativeApprovalScope';

export const OPENCLAW_POLICY_PROTOCOL = 1;
export const OPENCLAW_POLICY_LIMITS = Object.freeze({
  maxCanonicalBytes: 1024 * 1024,
  maxDepth: 32,
  maxValues: 100_000,
  maxRequests: 1024,
  maxIdentifierLength: 256,
});

export interface OpenClawPolicyAction {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionKey: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface OpenClawPolicyRunOptions {
  runId: string;
  sessionKey: string;
  panelId: string;
  settings: Pick<Settings, 'mode' | 'accessLevel'>;
  signal: AbortSignal;
  handler: NativeApprovalHandler | undefined;
  isCurrent(): boolean;
}

export interface OpenClawPolicyResult {
  decision: NativeApprovalDecision;
  actionDigest: string;
}

export class OpenClawPolicyLimitError extends Error {
  readonly code = 'OPENCLAW_POLICY_REQUEST_LIMIT';
  constructor() {
    super(`OpenClaw policy run exceeded ${OPENCLAW_POLICY_LIMITS.maxRequests} action IDs`);
    this.name = 'OpenClawPolicyLimitError';
  }
}

/** Fatal identity violation: transports must revoke the run's native execution grant. */
export class OpenClawPolicyConflictError extends Error {
  readonly code = 'OPENCLAW_POLICY_REQUEST_CONFLICT';
  constructor() {
    super('OpenClaw policy request ID was reused for a different or malformed action');
    this.name = 'OpenClawPolicyConflictError';
  }
}

function identifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0
    || value.length > OPENCLAW_POLICY_LIMITS.maxIdentifierLength || value.trim() !== value) { return false; }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) { return false; }
  }
  return true;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) { return false; }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

/** Canonical JSON: lexically sorted object keys, array order intact, JSON primitive encoding. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') { return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(',')}]`; }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * No coercion, getters, custom prototypes, sparse arrays, cycles, or non-JSON values.
 * Params depth starts at zero. The byte limit includes the complete canonical action.
 * Digest is SHA-256(UTF-8(canonical JSON of the six action fields)), without protocol metadata.
 */
export function snapshotOpenClawPolicyAction(input: unknown): { action: OpenClawPolicyAction; digest: string } | undefined {
  try {
    if (!plainRecord(input)) { return undefined; }
    const fields = ['requestId', 'runId', 'sessionKey', 'toolCallId', 'toolName', 'params'] as const;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key as typeof fields[number]))) {
      return undefined;
    }
    const requestId = dataProperty(input, 'requestId');
    const runId = dataProperty(input, 'runId');
    const sessionKey = dataProperty(input, 'sessionKey');
    const toolCallId = dataProperty(input, 'toolCallId');
    const toolName = dataProperty(input, 'toolName');
    const params = dataProperty(input, 'params');
    if (![requestId, runId, sessionKey, toolCallId, toolName].every(identifier) || !plainRecord(params)) { return undefined; }

    const active = new Set<object>();
    let values = 0;
    let bytes = 0;
    const charge = (token: string) => {
      bytes += Buffer.byteLength(token, 'utf8');
      if (bytes > OPENCLAW_POLICY_LIMITS.maxCanonicalBytes) { throw new Error('JSON byte limit'); }
    };
    const clone = (value: unknown, depth: number): unknown => {
      if (++values > OPENCLAW_POLICY_LIMITS.maxValues || depth > OPENCLAW_POLICY_LIMITS.maxDepth) {
        throw new Error('JSON structure limit');
      }
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        charge(JSON.stringify(value));
        return value;
      }
      if (typeof value === 'string') {
        if (value.length > OPENCLAW_POLICY_LIMITS.maxCanonicalBytes) { throw new Error('JSON string limit'); }
        charge(JSON.stringify(value));
        return value;
      }
      if (!value || typeof value !== 'object' || types.isProxy(value) || active.has(value)) { throw new Error('Not plain JSON'); }
      const array = Array.isArray(value);
      if (array && Object.getPrototypeOf(value) !== Array.prototype) { throw new Error('Not plain JSON array'); }
      if (!array && !plainRecord(value)) { throw new Error('Not plain JSON object'); }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length > OPENCLAW_POLICY_LIMITS.maxValues + 1 || ownKeys.some(key => typeof key !== 'string')) {
        throw new Error('JSON property limit');
      }
      active.add(value);
      charge('[]');
      if (array) {
        if (value.length > OPENCLAW_POLICY_LIMITS.maxValues || ownKeys.length !== value.length + 1) { throw new Error('Not dense JSON array'); }
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) { throw new Error('Not JSON array item'); }
          if (index) { charge(','); }
          result.push(clone(descriptor.value, depth + 1));
        }
        active.delete(value);
        return Object.freeze(result);
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const [index, key] of (ownKeys as string[]).sort().entries()) {
        if (key.length > OPENCLAW_POLICY_LIMITS.maxCanonicalBytes) { throw new Error('JSON key limit'); }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) { throw new Error('Not JSON property'); }
        charge(`${index ? ',' : ''}${JSON.stringify(key)}:`);
        result[key] = clone(descriptor.value, depth + 1);
      }
      active.delete(value);
      return Object.freeze(result);
    };
    const action: OpenClawPolicyAction = Object.freeze({
      requestId: requestId as string, runId: runId as string, sessionKey: sessionKey as string,
      toolCallId: toolCallId as string, toolName: toolName as string,
      params: clone(params, 0) as Readonly<Record<string, unknown>>,
    });
    const canonical = canonicalJson(action);
    if (Buffer.byteLength(canonical, 'utf8') > OPENCLAW_POLICY_LIMITS.maxCanonicalBytes) { return undefined; }
    return { action, digest: createHash('sha256').update(canonical, 'utf8').digest('hex') };
  } catch { return undefined; }
}

/** One gateway run owns an immutable policy and a bounded, non-evicting action history. */
export class OpenClawPolicyRun {
  private readonly _scope: NativeApprovalScope;
  private readonly _settings: Readonly<Pick<Settings, 'mode' | 'accessLevel'>> | undefined;
  private readonly _runId: string;
  private readonly _sessionKey: string;
  private readonly _signal: AbortSignal;
  private readonly _isOwnerCurrent: () => boolean;
  private readonly _validOwner: boolean;
  private readonly _requests = new Map<string, { digest: string; pending: boolean; promise: Promise<OpenClawPolicyResult> }>();
  private _disposed = false;
  private readonly _onAbort = () => this.dispose();

  constructor(options: OpenClawPolicyRunOptions) {
    this._runId = options.runId;
    this._sessionKey = options.sessionKey;
    this._signal = options.signal;
    this._isOwnerCurrent = options.isCurrent.bind(options);
    this._validOwner = [options.runId, options.sessionKey, options.panelId].every(identifier);
    const mode = plainRecord(options.settings) ? dataProperty(options.settings, 'mode') : undefined;
    const accessLevel = plainRecord(options.settings) ? dataProperty(options.settings, 'accessLevel') : undefined;
    this._settings = typeof mode === 'string' && OPERATION_MODES.includes(mode)
      && typeof accessLevel === 'string' && ACCESS_LEVELS.includes(accessLevel)
      ? Object.freeze({ mode, accessLevel }) as Readonly<Pick<Settings, 'mode' | 'accessLevel'>> : undefined;
    this._scope = new NativeApprovalScope({
      providerId: 'openclaw', panelId: options.panelId, signal: options.signal,
      handler: options.handler, isCurrent: () => this._isCurrent(),
    });
    this._signal.addEventListener('abort', this._onAbort, { once: true });
    if (this._signal.aborted) { this.dispose(); }
  }

  get hasPending(): boolean { return this._scope.hasPending; }

  onPendingChanged(listener: () => void): () => void { return this._scope.onPendingChanged(listener); }

  private _isCurrent(): boolean {
    try { return !this._disposed && !this._signal.aborted && this._validOwner && this._isOwnerCurrent(); }
    catch { return false; }
  }

  request(input: unknown): Promise<OpenClawPolicyResult> {
    const denied = (actionDigest = ''): Promise<OpenClawPolicyResult> => Promise.resolve({ decision: 'deny', actionDigest });
    if (!plainRecord(input) || !this._validOwner
      || dataProperty(input, 'runId') !== this._runId || dataProperty(input, 'sessionKey') !== this._sessionKey) {
      return denied();
    }
    const snapshot = snapshotOpenClawPolicyAction(input);
    if (!snapshot) {
      const requestId = dataProperty(input, 'requestId');
      if (identifier(requestId) && this._requests.has(requestId)) {
        this.dispose();
        return Promise.reject(new OpenClawPolicyConflictError());
      }
      return denied();
    }
    const { action, digest } = snapshot;
    if (!this._isCurrent()) { return Promise.resolve({ decision: 'cancelled', actionDigest: digest }); }
    const previous = this._requests.get(action.requestId);
    if (previous) {
      if (previous.digest !== digest) {
        this.dispose();
        return Promise.reject(new OpenClawPolicyConflictError());
      }
      return previous.pending ? previous.promise : denied(digest);
    }
    if (this._requests.size >= OPENCLAW_POLICY_LIMITS.maxRequests) {
      this.dispose();
      return Promise.reject(new OpenClawPolicyLimitError());
    }
    let settle!: (decision: NativeApprovalDecision) => void;
    const decision = new Promise<NativeApprovalDecision>(resolve => { settle = resolve; });
    const entry = {
      digest, pending: true,
      promise: decision.then((result): OpenClawPolicyResult => ({
        decision: this._isCurrent() ? result : 'cancelled', actionDigest: digest,
      })),
    };
    this._requests.set(action.requestId, entry);
    const actionType = classifyToolAction(action.toolName);
    const restricted = this._settings?.accessLevel === 'read-only'
      || this._settings?.mode === 'quick-plan' || this._settings?.mode === 'detailed-plan';
    const policy = !this._settings || (restricted && !isNeverGatedAction(actionType)) ? 'deny'
      : shouldGateToolUse(this._settings, action.toolName) ? 'ask' : 'allow';
    this._scope.request(action.requestId, {
      id: action.toolCallId, name: action.toolName, input: action.params,
      status: 'running', kind: toolKind(action.toolName),
    }, policy, result => {
      entry.pending = false;
      settle(result);
    });
    return entry.promise;
  }

  dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    this._signal.removeEventListener('abort', this._onAbort);
    this._scope.dispose();
  }
}
