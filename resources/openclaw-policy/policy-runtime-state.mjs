/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { OPENCLAW_VERSION, FINAL_EXECUTION_MODULE, VERIFIED_MODULES } from './runtime-manifest.mjs';

const key = Symbol.for('mysti.openclaw.policy.runtime.v1');

/**
 * OpenClaw can re-register a plugin for an agent registry without restarting
 * its gateway service. Jiti can also evaluate another copy of the module graph.
 * One owned process therefore anchors one exact authority tuple in its realm.
 * Registration alone neither replaces that authority nor acquires a service
 * lifetime; only an actual service start does so.
 */
export function ownedPolicyRuntime(credentials, create) {
  if (process.env.MYSTI_OPENCLAW_OWNED_RUNTIME !== '1' || !process.env.MYSTI_OPENCLAW_ROOT
    || !credentials || !['url', 'token', 'runtimeId'].every(field => typeof credentials[field] === 'string')) {
    throw new Error('Mysti policy requires an owned runtime and broker configuration');
  }
  const identity = JSON.stringify({
    runtimeId: credentials.runtimeId, url: credentials.url,
    tokenHash: createHash('sha256').update(credentials.token).digest('hex'),
    installedRoot: process.env.MYSTI_OPENCLAW_ROOT,
    version: OPENCLAW_VERSION, targetHash: VERIFIED_MODULES[FINAL_EXECUTION_MODULE],
  });
  const existing = globalThis[key];
  if (existing) {
    if (existing.identity !== identity || existing.state.closed) {
      throw new Error('Mysti native authority changed or stopped; restart the owned runtime');
    }
    return existing.state;
  }
  const state = create(Object.freeze({ ...credentials }));
  Object.defineProperty(globalThis, key, { value: Object.freeze({ identity, state }), writable: false, configurable: false });
  return state;
}
