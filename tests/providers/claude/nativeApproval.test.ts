import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeApprovalTransport, claudeApprovalDecision } from '../../../src/providers/claude/ClaudeApproval';
import { NativeApprovalRequests } from '../../../src/providers/base/NativeApprovalRequests';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings } from '../../../src/types';

const settings: Pick<Settings, 'mode' | 'accessLevel'> = { mode: 'default', accessLevel: 'ask-permission' };
const scopes: NativeApprovalRequests[] = [];
afterEach(() => { for (const scope of scopes.splice(0)) { scope.dispose(); } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}

function frame(id = 'request-a', name = 'Bash', input: Record<string, unknown> = { command: 'echo marker', nested: { final: true } }) {
  return { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: name,
    tool_use_id: `tool-${id}`, input, matched_ask_rule: { source: 'flagSettings', tool_name: '*' } } };
}

function harness(handler?: NativeApprovalHandler) {
  const stdin = new PassThrough();
  const responses: Array<{ response: { response: { behavior: string } } }> = [];
  stdin.on('data', chunk => { responses.push(JSON.parse(String(chunk))); });
  const proc = Object.assign(new EventEmitter(), { stdin, kill: vi.fn() }) as unknown as ChildProcess;
  const controller = new AbortController();
  let current = true;
  const requests = new NativeApprovalRequests({ providerId: 'claude-code', panelId: 'captured-panel', process: proc,
    handler, signal: controller.signal, isCurrent: () => current });
  scopes.push(requests);
  const transport = new ClaudeApprovalTransport(proc);
  transport.attest('2.1.266');
  return { proc, requests, transport, responses, controller,
    request: (data = frame(), authority = settings) => transport.handle(data, requests, authority),
    replace: () => { current = false; },
  };
}

describe('Claude native request/response authority', () => {
  it('waits for a card then returns the exact frozen final input without persistent permission changes', async () => {
    const decision = deferred<boolean>();
    const received: NativeApprovalRequest[] = [];
    const h = harness(request => { received.push(request); return decision.promise; });
    const data = frame();
    h.request(data);
    expect(h.responses).toEqual([]);
    expect(h.requests.hasPending).toBe(true);
    expect(received[0]).toMatchObject({ providerId: 'claude-code', panelId: 'captured-panel', nativeRequestId: 'request-a' });
    expect(Object.isFrozen(received[0].toolCall.input)).toBe(true);
    expect(Object.isFrozen(received[0].toolCall.input.nested)).toBe(true);
    decision.resolve(true);
    await vi.waitFor(() => expect(h.responses).toHaveLength(1));
    expect(h.responses[0]).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'request-a',
      response: { behavior: 'allow', updatedInput: data.request.input } } });
    expect(received[0].signal.aborted).toBe(true);
  });

  it.each(['abort', 'close', 'exit', 'error', 'dispose', 'replacement', 'native-cancel'] as const)('%s prevents a late allow', async event => {
    const decision = deferred<boolean>();
    const handler = vi.fn(() => decision.promise);
    const h = harness(handler);
    h.request();
    if (event === 'abort') { h.controller.abort(); }
    else if (event === 'dispose') { h.requests.dispose(); }
    else if (event === 'replacement') { h.replace(); }
    else if (event === 'native-cancel') { h.transport.handle({ type: 'control_cancel_request', request_id: 'request-a' }, h.requests, settings); }
    else { h.proc.emit(event); }
    decision.resolve(true);
    await vi.waitFor(() => expect(h.responses).toHaveLength(1));
    expect(h.responses[0].response.response.behavior).toBe('deny');
    expect(h.requests.hasPending).toBe(false);
  });

  it('routes concurrent panel decisions only to their issuing processes', async () => {
    const decisions = [deferred<boolean>(), deferred<boolean>()];
    const a = harness(() => decisions[0].promise);
    const b = harness(() => decisions[1].promise);
    a.request(); b.request();
    decisions[1].resolve(true);
    await vi.waitFor(() => expect(b.responses).toHaveLength(1));
    expect(a.responses).toEqual([]);
    decisions[0].resolve(false);
    await vi.waitFor(() => expect(a.responses).toHaveLength(1));
    expect(a.responses[0].response.response.behavior).toBe('deny');
    expect(b.responses[0].response.response.behavior).toBe('allow');
  });

  it('coalesces pending duplicates but rejects conflicting or settled request-ID replays', async () => {
    const decision = deferred<boolean>();
    const handler = vi.fn(() => decision.promise);
    const h = harness(handler);
    h.request(); h.request();
    expect(handler).toHaveBeenCalledOnce();
    expect(() => h.request(frame('request-a', 'Bash', { command: 'different action' }))).toThrow(/reused/);
    decision.resolve(false);
    await vi.waitFor(() => expect(h.responses).toHaveLength(1));
    expect(() => h.request()).toThrow(/reused/);
  });

  it.each(['read-only', 'quick-plan', 'detailed-plan'] as const)('hard-denies mutation in %s even if the host always allows', async tier => {
    const handler = vi.fn(() => Promise.resolve(true));
    const h = harness(handler);
    const authority = tier === 'read-only' ? { ...settings, accessLevel: tier } : { ...settings, mode: tier };
    for (const name of ['Bash', 'Write', 'Edit', 'ExitPlanMode', 'mcp__mysti-canvas__edit_page']) {
      h.request(frame(`id-${name}`, name), authority);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(h.responses).toHaveLength(5);
    expect(h.responses.every(response => response.response.response.behavior === 'deny')).toBe(true);
  });

  it('allows read automatically but still lets a captured role handler restrict it', async () => {
    const handler = vi.fn(() => Promise.resolve(false));
    const h = harness(handler);
    h.request(frame('read', 'Read', { file_path: '/work/a.txt' }));
    await vi.waitFor(() => expect(h.responses).toHaveLength(1));
    expect(handler).toHaveBeenCalledOnce();
    expect(h.responses[0].response.response.behavior).toBe('deny');
    const unattended = harness();
    unattended.request(frame('read', 'Read', { file_path: '/work/a.txt' }));
    expect(unattended.responses[0].response.response.behavior).toBe('allow');
  });

  it('denies a missing owner or a missing native process attestation', () => {
    const h = harness(() => Promise.resolve(true));
    h.transport.handle(frame(), undefined, settings);
    expect(h.responses[0].response.response.behavior).toBe('deny');
    const unattested = new ClaudeApprovalTransport(h.proc);
    unattested.handle(frame('unattested'), h.requests, settings);
    expect(h.responses[1].response.response.behavior).toBe('deny');
  });

  it('accepts native Read requests whose optional ask-rule metadata is absent', async () => {
    const h = harness();
    const data = frame('read', 'Read', { file_path: '/work/a.txt' });
    const request = { ...data.request } as Record<string, unknown>;
    delete request.matched_ask_rule;
    h.transport.handle({ ...data, request }, h.requests, settings);
    expect(h.responses[0].response.response.behavior).toBe('allow');
  });

  it('denies unverified native versions before they can acquire authority', () => {
    const h = harness();
    expect(() => h.transport.attest('2.0.71')).toThrow(/no verified/);
    expect(() => h.transport.attest('2.1.267')).toThrow(/no verified/);
  });

  it('does not let malformed inputs or identities acquire a card', () => {
    const handler = vi.fn(() => Promise.resolve(true));
    const h = harness(handler);
    expect(() => h.request({ ...frame(), request_id: '' })).toThrow(/invalid request ID/);
    expect(() => h.request(frame('large', 'Bash', { command: 'x'.repeat(1024 * 1024) }))).toThrow(/size limit/);
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 34; index++) { nested = { child: nested }; }
    expect(() => h.request(frame('deep', 'Bash', nested))).toThrow(/structural limit/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects unsupported control requests without treating suggestions as authority', () => {
    const h = harness();
    h.transport.handle({ type: 'control_request', request_id: 'mode-change', request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' } }, h.requests, settings);
    expect(h.responses).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: 'mode-change', error: expect.any(String) } }]);
  });

  it('uses the host settings for auto-edit and full-access without returning a native lasting grant', () => {
    expect(claudeApprovalDecision({ mode: 'edit-automatically', accessLevel: 'ask-permission' }, 'Edit', {})).toBe('allow');
    expect(claudeApprovalDecision({ mode: 'edit-automatically', accessLevel: 'ask-permission' }, 'Bash', {})).toBe('ask');
    expect(claudeApprovalDecision({ mode: 'default', accessLevel: 'full-access' }, 'Bash', {})).toBe('allow');
    expect(claudeApprovalDecision({ mode: 'ask-before-edit', accessLevel: 'full-access' }, 'Edit', {})).toBe('ask');
    for (const tool of ['Agent', 'Task', 'CronCreate', 'UnknownTool', 'mcp__other__Read']) {
      expect(claudeApprovalDecision({ mode: 'default', accessLevel: 'full-access' }, tool, {})).toBe('deny');
    }
    expect(claudeApprovalDecision({ mode: 'default', accessLevel: 'full-access' }, 'Bash', { run_in_background: true })).toBe('deny');
  });
});
