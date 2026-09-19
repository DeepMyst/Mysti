import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeExecutionGate } from '../../fixtures/opencode/ownedGatePrototype';
import type { OpenCodeGatePrototypeClient } from '../../fixtures/opencode/ownedGatePrototype';
import type { NativeApprovalDecision } from '../../../src/providers/base/IProvider';
import type { ToolCall } from '../../../src/types';

type Hook = { config(): Promise<void>; 'tool.execute.before'(call: object, output: { args: Record<string, unknown> }): Promise<void> };
const roots: string[] = [];
const gates: OpenCodeExecutionGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map(gate => gate.dispose()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
};
async function harness(handler: (session: string, tool: ToolCall, signal: AbortSignal) => Promise<NativeApprovalDecision> = async () => 'allow') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-owned-gate-'))); roots.push(root);
  const abort = new AbortController();
  const gate = await OpenCodeExecutionGate.create(root, root, abort.signal); gates.push(gate);
  const client = { sessionId: 'owned-session', requestHookApproval: vi.fn(handler), failOwnedHook: vi.fn() };
  // Evaluate the prototype's generated function without modifying its body. The
  // hook uses real authenticated HTTP; native/child suites cover module loading.
  const source = await fs.readFile(gate.pluginPath, 'utf8');
  const plugin = new Function(`return (${source.replace(/^export default /, '')})`)() as (input: { directory: string }) => Promise<Hook>;
  const hooks = await plugin({ directory: root });
  const endpoint = JSON.parse(source.match(/const endpoint = ("[^"]+")/)![1]);
  const token = JSON.parse(source.match(/token = ("[^"]+")/)![1]);
  const ready = async () => { await hooks.config(); await gate.bind(client as unknown as OpenCodeGatePrototypeClient); };
  const invoke = (callId = 'call', args: Record<string, unknown> = { command: '> marker' }) => hooks['tool.execute.before']({ tool: 'bash', sessionID: client.sessionId, callID: callId }, { args });
  const post = (body: object, signal?: AbortSignal, secret = token) => fetch(`${endpoint}/approval`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const body = { cwd: root, sessionId: client.sessionId, callId: 'call', tool: 'bash', args: { command: '> marker' } };
  return { root, gate, abort, client, hooks, ready, invoke, post, body };
}

describe('OpenCode owned execution hook prototype (not shipped)', () => {
  it('requires authenticated registration before binding a session', async () => {
    const h = await harness();
    await expect(h.gate.bind(h.client as unknown as OpenCodeGatePrototypeClient, 20)).rejects.toThrow('no prompt was sent');
    expect(h.client.requestHookApproval).not.toHaveBeenCalled();
  });
  it('holds a redirect effect until one explicit approval and freezes its authority', async () => {
    const decision = deferred<NativeApprovalDecision>();
    const h = await harness(async () => decision.promise); await h.ready();
    const marker = path.join(h.root, 'effect');
    const args = { command: '> marker' };
    const execution = h.invoke('call', args).then(() => fs.writeFile(marker, 'effect'));
    await vi.waitFor(() => expect(h.client.requestHookApproval).toHaveBeenCalledOnce());
    expect(existsSync(marker)).toBe(false); expect(Object.isFrozen(args)).toBe(true);
    expect(h.client.requestHookApproval.mock.calls[0][1].input).toEqual({ command: '> marker', cwd: h.root });
    decision.resolve('allow'); await execution; expect(await fs.readFile(marker, 'utf8')).toBe('effect');
    await expect(h.invoke()).rejects.toThrow('refused'); expect(h.client.requestHookApproval).toHaveBeenCalledOnce();
  });
  it.each(['deny', 'cancelled', 'throw'] as const)('%s cannot execute a following effect', async outcome => {
    const h = await harness(async () => { if (outcome === 'throw') { throw new Error('host failure'); } return outcome; }); await h.ready();
    const effect = vi.fn();
    await expect(h.invoke().then(effect)).rejects.toThrow(); expect(effect).not.toHaveBeenCalled();
  });
  it.each(['bad token', 'wrong session', 'wrong cwd', 'unknown tool', 'outside workdir', 'malformed args'] as const)('rejects %s before presenting a card', async fault => {
    const h = await harness(); await h.ready();
    const body = { ...h.body };
    if (fault === 'wrong session') { body.sessionId = 'other-session'; }
    if (fault === 'wrong cwd') { body.cwd += '/other'; }
    if (fault === 'unknown tool') { body.tool = 'task'; }
    if (fault === 'outside workdir') { body.args = { ...body.args, workdir: '..' } as typeof body.args; }
    if (fault === 'malformed args') { body.args = {} as typeof body.args; }
    const response = await h.post(body, undefined, fault === 'bad token' ? 'invalid' : undefined);
    expect(response.status).toBe(403); expect(h.client.requestHookApproval).not.toHaveBeenCalled();
  });
  it.each(['Stop', 'disconnect'] as const)('%s revokes pending transport authority and ignores late allow', async fault => {
    const decision = deferred<NativeApprovalDecision>();
    const h = await harness(async () => decision.promise); await h.ready();
    const disconnected = new AbortController();
    const pending = h.post(h.body, disconnected.signal).catch(error => error);
    await vi.waitFor(() => expect(h.client.requestHookApproval).toHaveBeenCalledOnce());
    const signal = h.client.requestHookApproval.mock.calls[0][2];
    if (fault === 'Stop') { h.abort.abort(); } else { disconnected.abort(); }
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    decision.resolve('allow'); await pending;
    expect(h.gate.consumeApproval(h.client.requestHookApproval.mock.calls[0][1])).toBe(false);
  });
  it('cannot execute after the registered server disappears', async () => {
    const h = await harness(); await h.ready(); await h.gate.dispose();
    const effect = vi.fn(); await expect(h.invoke().then(effect)).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled(); expect(h.client.requestHookApproval).not.toHaveBeenCalled();
  });
  it('reuses a scanner request only for the exact approved command and call, once', async () => {
    const h = await harness(); await h.ready(); await h.invoke();
    const tracked = { toolCallId: 'call', kind: 'execute', rawInput: { command: '> marker' } };
    const params = { sessionId: h.client.sessionId, toolCall: tracked };
    const tool = h.gate.decodePermission(params, tracked)!; expect(tool).toBeDefined();
    expect(h.gate.decodePermission({ ...params, sessionId: 'other' }, tracked)).toBeUndefined();
    expect(h.gate.decodePermission({ ...params, toolCall: { ...tracked, rawInput: { command: '> other' } } }, tracked)).toBeUndefined();
    expect(h.gate.decodePermission(params, { ...tracked, rawInput: { command: '> other' } })).toBeUndefined();
    expect(h.gate.decodePermission({ ...params, toolCall: { ...tracked, rawInput: { command: '> marker', directories: ['/outside'] } } }, tracked)).toBeUndefined();
    expect(h.gate.consumeApproval(tool)).toBe(true); expect(h.gate.consumeApproval(tool)).toBe(false);
    expect(h.gate.decodePermission(params, tracked)).toBeUndefined();
  });
  it('Stop of one gate preserves a sibling gate with the same native identity', async () => {
    const held = deferred<NativeApprovalDecision>();
    const first = await harness(async () => held.promise); const second = await harness();
    await Promise.all([first.ready(), second.ready()]);
    const pending = first.invoke().catch(error => error);
    await vi.waitFor(() => expect(first.client.requestHookApproval).toHaveBeenCalledOnce());
    first.abort.abort(); held.resolve('allow'); await pending;
    await expect(second.invoke()).resolves.toBeUndefined(); expect(second.client.requestHookApproval).toHaveBeenCalledOnce();
  });
});
