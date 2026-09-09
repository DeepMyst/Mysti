import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../../src/types';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import {
  OPENCLAW_POLICY_LIMITS, OPENCLAW_POLICY_PROTOCOL, OpenClawPolicyLimitError, OpenClawPolicyConflictError,
  OpenClawPolicyRun, snapshotOpenClawPolicyAction,
} from '../../../src/providers/openclaw/OpenClawPolicyRun';

type PolicySettings = Pick<Settings, 'mode' | 'accessLevel'>;
function action(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'request-1', runId: 'run-1', sessionKey: 'session-1',
    toolCallId: 'tool-1', toolName: 'write', params: { path: 'file.txt', content: 'original' },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const runs: OpenClawPolicyRun[] = [];
afterEach(() => { for (const run of runs.splice(0)) { run.dispose(); } });
function harness(
  settings: PolicySettings = { mode: 'ask-before-edit', accessLevel: 'full-access' },
  handler?: NativeApprovalHandler,
) {
  const controller = new AbortController();
  let current = true;
  const run = new OpenClawPolicyRun({
    runId: 'run-1', sessionKey: 'session-1', panelId: 'panel-1', settings,
    signal: controller.signal, handler, isCurrent: () => current,
  });
  runs.push(run);
  return { run, controller, replace: () => { current = false; } };
}

describe('OpenClaw policy action snapshots', () => {
  it('has a stable protocol1 digest with lexically sorted keys and intact arrays', () => {
    expect(OPENCLAW_POLICY_PROTOCOL).toBe(1);
    const first = action({ params: { '2': 'two', '10': 'ten', z: 2, a: [{ y: false, x: 'é' }] } });
    const reordered = action({ params: { a: [{ x: 'é', y: false }], z: 2, '10': 'ten', '2': 'two' } });
    const canonical = '{"params":{"10":"ten","2":"two","a":[{"x":"é","y":false}],"z":2},"requestId":"request-1","runId":"run-1","sessionKey":"session-1","toolCallId":"tool-1","toolName":"write"}';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(snapshotOpenClawPolicyAction(first)?.digest).toBe(expected);
    expect(snapshotOpenClawPolicyAction(reordered)?.digest).toBe(expected);
    expect(snapshotOpenClawPolicyAction(action({ params: { items: [1, 2] } }))?.digest)
      .not.toBe(snapshotOpenClawPolicyAction(action({ params: { items: [2, 1] } }))?.digest);
  });

  it.each(['requestId', 'runId', 'sessionKey', 'toolCallId', 'toolName', 'params'])('binds %s into the action digest', field => {
    const original = snapshotOpenClawPolicyAction(action())!;
    const changed = snapshotOpenClawPolicyAction(action({ [field]: field === 'params' ? { path: 'different' } : 'different' }))!;
    expect(changed.digest).not.toBe(original.digest);
  });

  it('snapshots and freezes nested values without mutating the caller or interpreting prototype keys', () => {
    const params = JSON.parse('{"__proto__":{"polluted":true},"nested":{"items":[1,2]}}');
    const snapshot = snapshotOpenClawPolicyAction(action({ params }))!;
    expect(Object.isFrozen(params)).toBe(false);
    params.nested.items[0] = 9;
    const nested = snapshot.action.params.nested as { items: number[] };
    expect(nested.items).toEqual([1, 2]);
    expect(Object.isFrozen(snapshot.action)).toBe(true);
    expect(Object.isFrozen(snapshot.action.params)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.items)).toBe(true);
    expect(Object.getPrototypeOf(snapshot.action.params)).toBeNull();
    expect(snapshot.action.params.__proto__).toEqual({ polluted: true });
    expect(Reflect.set(nested.items, '0', 3)).toBe(false);
  });

  it.each([
    ['missing', undefined], ['null', null], ['array', []], ['function', { value: () => true }],
    ['undefined', { value: undefined }], ['bigint', { value: 1n }], ['NaN', { value: NaN }],
    ['infinity', { value: Infinity }], ['date', { value: new Date(0) }],
    ['sparse array', { value: Array(2) }], ['symbol value', { value: Symbol('x') }],
    ['custom prototype', Object.create({ inherited: true })],
  ])('rejects %s params', (_name, params) => {
    expect(snapshotOpenClawPolicyAction(action({ params }))).toBeUndefined();
  });

  it('rejects accessors, proxies, hidden properties, cycles and array extras without executing getters', () => {
    const getter = vi.fn(() => 'untrusted');
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    const hidden = Object.defineProperty({}, 'value', { value: 'hidden' });
    const symbol = { [Symbol('x')]: 1 };
    const proxy = new Proxy({}, { getPrototypeOf: getter });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const array = Object.assign([1], { extra: true });
    for (const params of [accessor, hidden, symbol, proxy, cyclic, { array }]) {
      expect(snapshotOpenClawPolicyAction(action({ params }))).toBeUndefined();
    }
    const envelope = Object.defineProperty(action(), 'toolName', { enumerable: true, get: getter });
    expect(snapshotOpenClawPolicyAction(envelope)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['', ' ', ' trailing ', 'nul\0', 'line\n', 'x'.repeat(257)])('rejects invalid identifiers/names %j', value => {
    for (const field of ['requestId', 'runId', 'sessionKey', 'toolCallId', 'toolName']) {
      expect(snapshotOpenClawPolicyAction(action({ [field]: value }))).toBeUndefined();
    }
  });

  it('requires the exact action envelope', () => {
    expect(snapshotOpenClawPolicyAction(action({ protocol: 1 }))).toBeUndefined();
    const missing = action() as Record<string, unknown>;
    delete missing.toolCallId;
    expect(snapshotOpenClawPolicyAction(missing)).toBeUndefined();
  });

  it('accepts substantial patches and enforces canonical UTF-8 byte, nesting and value limits', () => {
    expect(snapshotOpenClawPolicyAction(action({ params: { patch: 'x'.repeat(100_000) } }))).toBeDefined();
    expect(snapshotOpenClawPolicyAction(action({ params: { patch: 'x'.repeat(OPENCLAW_POLICY_LIMITS.maxCanonicalBytes) } }))).toBeUndefined();
    expect(snapshotOpenClawPolicyAction(action({ params: { patch: 'é'.repeat(600_000) } }))).toBeUndefined();
    let nested: unknown = 0;
    for (let depth = 0; depth < OPENCLAW_POLICY_LIMITS.maxDepth; depth++) { nested = { nested }; }
    expect(snapshotOpenClawPolicyAction(action({ params: nested }))).toBeDefined();
    expect(snapshotOpenClawPolicyAction(action({ params: { deeper: nested } }))).toBeUndefined();
    expect(snapshotOpenClawPolicyAction(action({ params: { values: Array(OPENCLAW_POLICY_LIMITS.maxValues).fill(0) } }))).toBeUndefined();
  });
});

describe('OpenClaw policy run authority', () => {
  it.each([
    ['quick-plan', 'full-access', 'write'], ['detailed-plan', 'full-access', 'exec'],
    ['default', 'read-only', 'apply_patch'], ['edit-automatically', 'read-only', 'browser'],
    ['quick-plan', 'full-access', 'Agent'], ['detailed-plan', 'full-access', 'UnknownTool'],
    ['quick-plan', 'full-access', 'mcp__mysti-canvas__edit_page'],
  ] as const)('hard-denies %s/%s/%s before opening a card', async (mode, accessLevel, toolName) => {
    const onDecision = vi.fn();
    const handler = Object.assign(vi.fn(async () => true), { onDecision });
    const h = harness({ mode, accessLevel }, handler);
    expect(await h.run.request(action({ toolName }))).toMatchObject({ decision: 'deny', actionDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(handler).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledOnce();
  });

  it.each(['read', 'grep', 'mcp__mysti-canvas__list_pages'])('allows classified read %s in plan mode without a host', async toolName => {
    const h = harness({ mode: 'quick-plan', accessLevel: 'read-only' });
    expect(await h.run.request(action({ toolName }))).toMatchObject({ decision: 'allow' });
  });

  it.each([
    ['ask-before-edit', 'full-access', 'write', 'ask'],
    ['edit-automatically', 'ask-permission', 'write', 'allow'],
    ['edit-automatically', 'ask-permission', 'exec', 'ask'],
    ['default', 'ask-permission', 'web_fetch', 'ask'],
    ['edit-automatically', 'full-access', 'UnknownTool', 'allow'],
  ] as const)('uses shared policy for %s/%s/%s and lets the host restrict it', async (mode, accessLevel, toolName, policy) => {
    const handler = vi.fn(async (_request: NativeApprovalRequest) => false);
    const h = harness({ mode, accessLevel }, handler);
    expect(await h.run.request(action({ toolName }))).toMatchObject({ decision: 'deny' });
    expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      providerId: 'openclaw', panelId: 'panel-1', defaultDecision: policy,
      toolCall: expect.objectContaining({ name: toolName }),
    }));
  });

  it('captures immutable settings and denies invalid authority even for reads', async () => {
    const settings: PolicySettings = { mode: 'quick-plan', accessLevel: 'read-only' };
    const handler = vi.fn(async () => true);
    const h = harness(settings, handler);
    settings.mode = 'edit-automatically'; settings.accessLevel = 'full-access';
    expect(await h.run.request(action())).toMatchObject({ decision: 'deny' });
    for (const invalid of [null, {}, { mode: 'bogus', accessLevel: 'full-access' }, { mode: 'default', accessLevel: 'bogus' }]) {
      const invalidRun = harness(invalid as PolicySettings, handler);
      expect(await invalidRun.run.request(action({ toolName: 'read' }))).toMatchObject({ decision: 'deny' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('owns the actual immutable card input while a decision is pending', async () => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(undefined, handler);
    const input = action();
    const digest = snapshotOpenClawPolicyAction(input)!.digest;
    const result = h.run.request(input);
    input.params.content = 'changed'; input.params.path = 'other.txt';
    expect(handler.mock.calls[0][0].toolCall.input).toEqual({ path: 'file.txt', content: 'original' });
    expect(Object.isFrozen(handler.mock.calls[0][0].toolCall.input)).toBe(true);
    decision.resolve(true);
    expect(await result).toEqual({ decision: 'allow', actionDigest: digest });
  });

  it('does not let wrong run/session requests cancel or acquire the owned pending decision', async () => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(undefined, handler);
    const owned = h.run.request(action());
    for (const wrong of [action({ runId: 'other-run' }), action({ sessionKey: 'other-session' })]) {
      expect(await h.run.request(wrong)).toEqual({ decision: 'deny', actionDigest: '' });
    }
    expect(handler).toHaveBeenCalledOnce();
    expect(h.run.hasPending).toBe(true);
    decision.resolve(true);
    expect(await owned).toMatchObject({ decision: 'allow' });
  });

  it('coalesces identical pending actions but denies replay after settlement', async () => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(undefined, handler);
    const first = h.run.request(action());
    const repeated = h.run.request(action({ params: { content: 'original', path: 'file.txt' } }));
    expect(repeated).toBe(first);
    expect(handler).toHaveBeenCalledOnce();
    decision.resolve(true);
    expect(await first).toMatchObject({ decision: 'allow' });
    expect(await h.run.request(action())).toMatchObject({ decision: 'deny' });
    expect(handler).toHaveBeenCalledOnce();
    expect(await h.run.request(action({ requestId: 'request-2' }))).toMatchObject({ decision: 'allow' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each(['changed', 'malformed'])('rejects a %s duplicate so the broker revokes the execution grant', async variant => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(undefined, handler);
    const first = h.run.request(action());
    const second = h.run.request(action({ requestId: 'request-2' }));
    const conflict = action({ params: variant === 'changed' ? { command: 'different' } : { invalid: undefined } });
    await expect(h.run.request(conflict)).rejects.toBeInstanceOf(OpenClawPolicyConflictError);
    expect(await first).toMatchObject({ decision: 'cancelled' });
    expect(await second).toMatchObject({ decision: 'cancelled' });
    expect(handler.mock.calls.every(([request]) => request.signal.aborted)).toBe(true);
    expect(h.run.hasPending).toBe(false);
    decision.resolve(true);
    expect(await first).toMatchObject({ decision: 'cancelled' });
    expect(await h.run.request(action({ requestId: 'new' }))).toMatchObject({ decision: 'cancelled' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each(['changed', 'malformed'])('signals a fatal %s conflict even after the original action was allowed', async variant => {
    const h = harness({ mode: 'edit-automatically', accessLevel: 'full-access' });
    expect(await h.run.request(action())).toMatchObject({ decision: 'allow' });
    const conflict = action(variant === 'changed' ? { toolCallId: 'different-tool' } : { params: null });
    await expect(h.run.request(conflict)).rejects.toMatchObject({
      name: 'OpenClawPolicyConflictError', code: 'OPENCLAW_POLICY_REQUEST_CONFLICT',
    });
    expect(await h.run.request(action({ requestId: 'new' }))).toMatchObject({ decision: 'cancelled' });
  });

  it('ordinary policy denials, malformed new requests and wrong-owner duplicates do not revoke the run', async () => {
    const h = harness({ mode: 'quick-plan', accessLevel: 'full-access' });
    expect(await h.run.request(action())).toMatchObject({ decision: 'deny' });
    expect(await h.run.request(action())).toMatchObject({ decision: 'deny' });
    expect(await h.run.request(action({ requestId: 'invalid-new', params: null }))).toMatchObject({ decision: 'deny' });
    expect(await h.run.request(action({ runId: 'another-run', params: null }))).toMatchObject({ decision: 'deny' });
    expect(await h.run.request(action({ sessionKey: 'another-session', params: null }))).toMatchObject({ decision: 'deny' });
    expect(await h.run.request(action({ requestId: 'read-next', toolName: 'read', params: { path: 'file.txt' } })))
      .toMatchObject({ decision: 'allow' });
  });

  it.each(['abort', 'dispose', 'replace'] as const)('%s prevents a late host approval', async retirement => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(undefined, handler);
    const result = h.run.request(action());
    if (retirement === 'abort') { h.controller.abort(); }
    else if (retirement === 'dispose') { h.run.dispose(); }
    else { h.replace(); }
    decision.resolve(true);
    expect(await result).toMatchObject({ decision: 'cancelled' });
    expect(h.run.hasPending).toBe(false);
  });

  it('rechecks ownership before publishing even a synchronous autonomous result', async () => {
    const h = harness({ mode: 'edit-automatically', accessLevel: 'full-access' });
    const result = h.run.request(action());
    h.controller.abort();
    expect(await result).toMatchObject({ decision: 'cancelled' });
  });

  it('forwards pending transitions and honors cancellation triggered by the decision observer', async () => {
    const onDecision = vi.fn(() => { h.run.dispose(); });
    const handler = Object.assign(vi.fn(async () => true), { onDecision });
    const h = harness(undefined, handler);
    const pending: boolean[] = [];
    const release = h.run.onPendingChanged(() => { pending.push(h.run.hasPending); });
    expect(await h.run.request(action())).toMatchObject({ decision: 'cancelled' });
    expect(pending).toEqual([true, false]);
    expect(onDecision).toHaveBeenCalledOnce();
    release();
  });

  it('retains settled IDs and fails closed at the run cap without eviction', async () => {
    const h = harness({ mode: 'edit-automatically', accessLevel: 'full-access' });
    for (let i = 0; i < OPENCLAW_POLICY_LIMITS.maxRequests; i++) {
      expect(await h.run.request(action({ requestId: String(i) }))).toMatchObject({ decision: 'allow' });
    }
    expect(await h.run.request(action({ requestId: '0' }))).toMatchObject({ decision: 'deny' });
    await expect(h.run.request(action({ requestId: 'overflow' }))).rejects.toBeInstanceOf(OpenClawPolicyLimitError);
    expect(await h.run.request(action({ requestId: 'after-overflow' }))).toMatchObject({ decision: 'cancelled' });
  });

  it('cancels every pending approval when the action limit is exceeded', async () => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(undefined, handler);
    const pending = Array.from({ length: OPENCLAW_POLICY_LIMITS.maxRequests }, (_, index) =>
      h.run.request(action({ requestId: String(index) })));
    await expect(h.run.request(action({ requestId: 'overflow' }))).rejects.toMatchObject({ code: 'OPENCLAW_POLICY_REQUEST_LIMIT' });
    expect((await Promise.all(pending)).every(result => result.decision === 'cancelled')).toBe(true);
    expect(h.run.hasPending).toBe(false);
    expect(handler).toHaveBeenCalledTimes(OPENCLAW_POLICY_LIMITS.maxRequests);
    expect(handler.mock.calls.every(([request]) => request.signal.aborted)).toBe(true);
    decision.resolve(true);
    expect((await Promise.all(pending)).every(result => result.decision === 'cancelled')).toBe(true);
  });
});
