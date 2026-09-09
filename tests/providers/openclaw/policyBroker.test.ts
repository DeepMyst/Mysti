/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenClawPolicyBroker } from '../../../src/providers/openclaw/OpenClawPolicyBroker';
import { snapshotOpenClawPolicyAction } from '../../../src/providers/openclaw/OpenClawPolicyRun';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import { MystiPolicyClient, actionDigest } from '../../../resources/openclaw-policy/policy-client.mjs';

const receipt = { version: '2026.6.34', targetHash: 'verified-hash', protocolVersion: 1 };
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) { cleanup(); } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function setup(handler?: NativeApprovalHandler, settings = { mode: 'ask-before-edit', accessLevel: 'full-access' } as const) {
  const broker = new OpenClawPolicyBroker(receipt);
  cleanups.push(() => broker.dispose());
  const credentials = await broker.listen();
  const client = new MystiPolicyClient(credentials, WebSocket, receipt, { markOwned: vi.fn() });
  cleanups.push(() => client.dispose());
  await client.start();
  const controller = new AbortController();
  const options = { runId: 'mysti-run', sessionKey: 'agent:main:mysti-session', panelId: 'panel', settings,
    handler, signal: controller.signal, isCurrent: () => true };
  const lease = await broker.openRun(options);
  const request = (overrides: Record<string, unknown> = {}) => ({
    toolName: 'write', toolCallId: 'call-1', params: { path: 'file', content: 'exact action' },
    context: { runId: options.runId, sessionKey: options.sessionKey }, signal: new AbortController().signal, ...overrides,
  });
  return { broker, client, controller, lease, request, credentials, options };
}

describe('OpenClaw host/native policy transport', () => {
  it('binds the approval card and decision to the exact final action', async () => {
    const asked = deferred<NativeApprovalRequest>();
    const answer = deferred<boolean>();
    const h = await setup(async request => { asked.resolve(request); return answer.promise; });
    let executed = false;
    const pending = h.client.evaluate(h.request()).then((decision: { allow: boolean; isCurrent(): boolean }) => {
      executed = decision.allow && decision.isCurrent();
      return decision;
    });
    const card = await asked.promise;
    expect(card.toolCall.input).toEqual({ path: 'file', content: 'exact action' });
    expect(h.lease.hasPending).toBe(true);
    expect(executed).toBe(false);
    answer.resolve(true);
    expect((await pending).allow).toBe(true);
    expect(executed).toBe(true);
    expect(h.lease.hasPending).toBe(false);
  });

  it.each(['host-cancel', 'lease-dispose', 'broker-close', 'native-close'] as const)('denies pending work after %s even if its card later allows', async trigger => {
    const asked = deferred<NativeApprovalRequest>();
    const answer = deferred<boolean>();
    const h = await setup(async request => { asked.resolve(request); return answer.promise; });
    const pending = h.client.evaluate(h.request());
    const card = await asked.promise;
    if (trigger === 'host-cancel') { h.controller.abort(); }
    if (trigger === 'lease-dispose') { h.lease.dispose(); }
    if (trigger === 'broker-close') { h.broker.dispose(); }
    if (trigger === 'native-close') { h.client.dispose(); }
    const result = await pending;
    expect(result.allow).toBe(false);
    expect(result.isCurrent()).toBe(false);
    await vi.waitFor(() => expect(card.signal.aborted).toBe(true));
    answer.resolve(true);
    expect(h.lease.hasPending).toBe(false);
  });

  it('aborts the returned execution lifetime when the grant is revoked after approval', async () => {
    const h = await setup(async () => true);
    const decision = await h.client.evaluate(h.request());
    expect(decision.allow).toBe(true);
    const aborted = once(decision.executionSignal, 'abort');
    h.lease.dispose();
    await aborted;
    expect(decision.isCurrent()).toBe(false);
  });

  it('revokes an already allowed execution when the peer changes a settled request ID', async () => {
    const captured = deferred<NativeApprovalRequest>();
    const h = await setup(async request => { captured.resolve(request); return true; });
    const decision = await h.client.evaluate(h.request());
    const card = await captured.promise;
    const grant = h.client.grants.get(h.options.runId);
    const aborted = once(decision.executionSignal, 'abort');
    h.client.send({ type: 'tool.request', requestId: card.nativeRequestId, runId: grant.runId,
      sessionKey: grant.sessionKey, grantId: grant.grantId, toolCallId: 'call-1', toolName: 'write',
      params: { path: 'different-file', content: 'changed after allowance' } });
    await aborted;
    expect(h.lease.signal.aborted).toBe(true);
    expect(decision.isCurrent()).toBe(false);
  });

  it('cannot revive the host peer with a delayed heartbeat acknowledgement before its sweep', async () => {
    const h = await setup(async () => true);
    const decision = await h.client.evaluate(h.request());
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 16000);
    const aborted = once(decision.executionSignal, 'abort');
    h.client.send({ type: 'heartbeat.ack', runtimeId: h.credentials.runtimeId });
    await aborted;
    expect(h.lease.signal.aborted).toBe(true);
    expect(decision.isCurrent()).toBe(false);
  });

  it('rejects foreign runs, sessions, unsupported tools and code-mode identities before cards', async () => {
    const handler = vi.fn(async () => true);
    const h = await setup(handler);
    for (const override of [
      { context: { runId: 'foreign', sessionKey: h.options.sessionKey } },
      { context: { runId: h.options.runId, sessionKey: 'agent:main:foreign' } },
      { context: {} }, ...['sessions_spawn', 'sessions_send', 'process', 'unknown', 'cron'].map(toolName => ({ toolName })),
      { toolName: 'exec', toolKind: 'code-mode' },
      ...[{ pty: true }, { background: true }, { elevated: true }, { host: 'node' }, { host: 'sandbox' }, { node: 'remote' }]
        .map(params => ({ toolName: 'exec', params: { command: 'inert', ...params } })),
    ]) { expect((await h.client.evaluate(h.request(override))).allow).toBe(false); }
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects missing interactive authority but still permits classified automatic reads', async () => {
    const h = await setup();
    expect((await h.client.evaluate(h.request())).allow).toBe(false);
    expect((await h.client.evaluate(h.request({ toolName: 'read', params: { path: 'file' } }))).allow).toBe(true);
  });

  it('does not accept a forged digest or a decision for a different run', async () => {
    const asked = deferred<NativeApprovalRequest>();
    const answer = deferred<boolean>();
    const h = await setup(async request => { asked.resolve(request); return answer.promise; });
    const pending = h.client.evaluate(h.request());
    await asked.promise;
    const [requestId, entry] = [...h.client.pending.entries()][0];
    h.client.receive({ type: 'tool.decision', requestId, runId: 'foreign', grantId: entry.grant.grantId,
      decision: 'allow', actionDigest: entry.digest });
    expect(h.client.pending.size).toBe(1);
    h.client.receive({ type: 'tool.decision', requestId, runId: h.options.runId, grantId: entry.grant.grantId,
      decision: 'allow', actionDigest: 'changed' });
    expect((await pending).allow).toBe(false);
    answer.resolve(true);
  });

  it('expires a live grant when heartbeat liveness is lost', async () => {
    const asked = deferred<NativeApprovalRequest>();
    const h = await setup(async request => { asked.resolve(request); return new Promise(() => {}); });
    const pending = h.client.evaluate(h.request());
    await asked.promise;
    h.client.now = () => Date.now() + 16000;
    h.client.expire();
    expect((await pending).allow).toBe(false);
    expect(h.client.closed).toBe(true);
    await vi.waitFor(() => expect(h.lease.signal.aborted).toBe(true));
  });

  it.each(['grant', 'connection'] as const)('cannot revive an expired %s with delayed frames before the sweep', async expired => {
    const h = await setup(async () => true);
    const decision = await h.client.evaluate(h.request());
    const grant = h.client.grants.get(h.options.runId);
    const now = Date.now() + 16000;
    h.client.now = () => now;
    // Keep connection live to independently exercise the per-grant boundary.
    if (expired === 'grant') { h.client.lastHeartbeat = now; }
    h.client.receive({ type: 'heartbeat', runtimeId: h.credentials.runtimeId });
    h.client.receive({ type: 'run.renew', runId: grant.runId, grantId: grant.grantId, expiresAt: now + 15000 });
    expect(h.client.isCurrent(grant)).toBe(false);
    expect(decision.executionSignal.aborted).toBe(true);
    expect(decision.isCurrent()).toBe(false);
  });

  it.each(['wrong-token', 'unicode-token', 'wrong-receipt', 'browser-origin'] as const)('rejects %s without replacing the current native peer', async mode => {
    const h = await setup();
    const socket = new WebSocket(h.credentials.url, mode === 'browser-origin' ? { origin: 'https://example.test' } : {});
    cleanups.push(() => socket.terminate());
    const closed = once(socket, 'close');
    socket.on('error', () => {});
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', protocol: 1, ...h.credentials,
      token: mode === 'unicode-token' ? 'é'.repeat(64) : mode === 'wrong-token' ? 'f'.repeat(64) : h.credentials.token,
      guard: mode === 'wrong-receipt' ? { ...receipt, targetHash: 'changed' } : receipt, harness: 'pi' })));
    await closed;
    expect(h.client.closed).toBe(false);
    expect((await h.client.evaluate(h.request({ toolName: 'read', params: { path: 'file' } }))).allow).toBe(true);
  });
});

describe('OpenClaw canonical digest parity', () => {
  it.each([
    {}, { path: 'file', content: 'héllo\n"' }, { '2': 'two', '10': 'ten', a: [{ y: false, x: null }] },
    JSON.parse('{"__proto__":{"safe":true},"constructor":0}'), { values: [-0, 1e30, '\ud800', '😀'] },
  ])('matches host snapshot for %j', params => {
    const action = { requestId: 'request', runId: 'run', sessionKey: 'session', toolCallId: 'tool', toolName: 'write', params };
    expect(actionDigest(action)).toBe(snapshotOpenClawPolicyAction(action)?.digest);
  });
  it.each([{ x: undefined }, { x: NaN }, { x: 1n }, { x: new Date() }, { x: Array(2) }])('rejects non-JSON case %# on both sides', params => {
    const action = { requestId: 'request', runId: 'run', sessionKey: 'session', toolCallId: 'tool', toolName: 'write', params };
    expect(() => actionDigest(action)).toThrow();
    expect(snapshotOpenClawPolicyAction(action)).toBeUndefined();
  });
});
