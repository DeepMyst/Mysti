/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { fileURLToPath } from 'node:url';
import { FINAL_EXECUTION_PROTOCOL } from './runtime-manifest.mjs';

let expectedReceipt;
let instrumentationReady = false;
let registration;
const ownedRunIds = new Set();
const ownedSessionKeys = new Set();
const ownershipFailure = new AbortController();
export const MAX_OWNED_EXECUTION_IDENTITIES = 10000;

/** Internal preload/transform handshake; policy plugins use the receipt reader. */
export function initializeFinalExecutionGuard(receipt) {
  if (expectedReceipt) { throw new Error('Mysti final execution guard was already initialized'); }
  if (receipt?.protocolVersion !== FINAL_EXECUTION_PROTOCOL) { throw new Error('Unsupported Mysti final execution protocol'); }
  expectedReceipt = Object.freeze({ ...receipt });
}

export function markFinalExecutionInstrumentation(moduleURL) {
  if (!expectedReceipt || fileURLToPath(moduleURL) !== fileURLToPath(expectedReceipt.targetURL)) {
    throw new Error('Mysti final execution instrumentation identity mismatch');
  }
  instrumentationReady = true;
}

export function getFinalExecutionGuardReceipt() {
  if (!instrumentationReady) { return null; }
  const { protocolVersion, installedRoot, version, targetHash, targetURL } = expectedReceipt;
  return Object.freeze({ protocolVersion, installedRoot, version, targetHash, targetURL });
}

/**
 * The handler receives final, immutable params and a scoped abort signal.
 * It must return { allow: true, isCurrent: () => boolean, executionSignal } to
 * authorize the single captured execution. Owned runtimes require the grant's
 * executionSignal so revocation can abort execution after approval.
 */
export function installFinalExecutionPolicy(handler) {
  if (typeof handler !== 'function') { throw new TypeError('Mysti final execution policy must be a function'); }
  const previous = registration;
  const current = { handler, controller: new AbortController() };
  registration = current;
  previous?.controller.abort(new Error('Mysti final execution policy replaced'));
  return Object.freeze({
    dispose() {
      if (registration === current) { registration = undefined; }
      current.controller.abort(new Error('Mysti final execution policy disposed'));
    },
  });
}

export function isMystiExecutionContext(ctx) {
  return typeof ctx?.runId === 'string' && ctx.runId.startsWith('mysti-')
    || typeof ctx?.sessionKey === 'string' && /^(?:agent:[^:]+:)?mysti-/.test(ctx.sessionKey)
    || ownedRunIds.has(ctx?.runId) || ownedSessionKeys.has(ctx?.sessionKey);
}

/** Trusted host lineage only. These deny tombstones intentionally outlive policy disposal. */
export function markOwnedExecutionContext({ runId, sessionKey, parentRunId } = {}) {
  ownershipFailure.signal.throwIfAborted();
  if ((!runId && !sessionKey) || [runId, sessionKey, parentRunId].some(value =>
    value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 1024))) {
    throw new Error('Mysti execution ownership requires bounded explicit identities');
  }
  if (parentRunId !== undefined && !isMystiExecutionContext({ runId: parentRunId })) {
    throw new Error('Mysti child execution has no known owned parent');
  }
  const additions = Number(Boolean(runId) && !ownedRunIds.has(runId))
    + Number(Boolean(sessionKey) && !ownedSessionKeys.has(sessionKey));
  if (ownedRunIds.size + ownedSessionKeys.size + additions > MAX_OWNED_EXECUTION_IDENTITIES) {
    const error = new Error('Mysti execution ownership capacity exceeded; restart the owned runtime');
    ownershipFailure.abort(error);
    throw error;
  }
  if (runId) { ownedRunIds.add(runId); }
  if (sessionKey) { ownedSessionKeys.add(sessionKey); }
  return Object.freeze({ runId, sessionKey, parentRunId });
}

/** Preserve object identity: stock exec stores prepared environment in a WeakMap. */
function freezeAction(value, seen = new Set(), depth = 0, budget = { remaining: 20000 }) {
  if (--budget.remaining < 0) { throw new Error('Mysti final execution action is too large'); }
  if (value == null || ['string', 'boolean', 'undefined'].includes(typeof value)) { return; }
  if (typeof value === 'number' && Number.isFinite(value)) { return; }
  if (typeof value !== 'object' || depth > 64 || seen.has(value)) {
    throw new Error('Mysti final execution requires bounded JSON action parameters');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('Mysti final execution does not accept non-JSON action parameters');
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key === 'symbol' || !property || !('value' in property)) {
      throw new Error('Mysti final execution does not accept accessor action parameters');
    }
    freezeAction(property.value, seen, depth + 1, budget);
  }
  seen.delete(value);
  Object.freeze(value);
}

function executionContext(ctx) {
  const result = {};
  for (const field of ['runId', 'sessionKey', 'sessionId', 'agentId', 'cwd', 'workspaceDir']) {
    if (typeof ctx?.[field] === 'string') { result[field] = ctx[field]; }
  }
  return Object.freeze(result);
}

function abortScope(signals) {
  const controller = new AbortController();
  const cleanups = [];
  for (const signal of signals.filter(Boolean)) {
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); }
  }
  return { signal: controller.signal, dispose() { cleanups.forEach(remove => remove()); } };
}

async function waitForDecision(pending, signal) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Mysti final execution cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); }
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Called only by the hash-verified transform, after hooks and finalization. */
export async function guardFinalToolExecution({ tool, toolCallId, params, toolIdentity, ctx, signal, onUpdate, execute }) {
  // The original captured execute is called without a receiver. Preserve that
  // exact contract for guarded and unrelated calls (do not bind it to tool).
  ownershipFailure.signal.throwIfAborted();
  if (!expectedReceipt?.ownedRuntime && !isMystiExecutionContext(ctx)) {
    return execute(toolCallId, params, signal, onUpdate);
  }
  const current = registration;
  if (!getFinalExecutionGuardReceipt() || !current) { throw new Error('Mysti final execution policy is unavailable'); }
  const scope = abortScope([signal, current.controller.signal, ownershipFailure.signal]);
  try {
    scope.signal.throwIfAborted();
    freezeAction(params);
    const request = Object.freeze({
      protocolVersion: FINAL_EXECUTION_PROTOCOL,
      toolName: tool.name || 'tool',
      toolCallId,
      ...(toolIdentity?.toolKind ? { toolKind: toolIdentity.toolKind } : {}),
      ...(toolIdentity?.toolInputKind ? { toolInputKind: toolIdentity.toolInputKind } : {}),
      params,
      context: executionContext(ctx),
      signal: scope.signal,
    });
    const decision = await waitForDecision(Promise.resolve().then(() => {
      scope.signal.throwIfAborted();
      return current.handler(request);
    }), scope.signal);
    scope.signal.throwIfAborted();
    if (registration !== current || decision?.allow !== true
      || typeof decision.isCurrent !== 'function' || decision.isCurrent() !== true) {
      throw new Error('Mysti final execution was denied or its lease expired');
    }
    if ((expectedReceipt?.ownedRuntime || decision.executionSignal !== undefined)
      && !(decision.executionSignal instanceof AbortSignal)) {
      throw new Error('Mysti final execution requires a grant revocation signal');
    }
    const executionScope = abortScope([scope.signal, decision.executionSignal]);
    try {
      executionScope.signal.throwIfAborted();
      // Retain both scopes until captured execution settles: revoking a grant,
      // disposing a plugin or stopping the run also cancels an executing tool.
      return await execute(toolCallId, params, executionScope.signal, onUpdate);
    } finally { executionScope.dispose(); }
  } finally { scope.dispose(); }
}
