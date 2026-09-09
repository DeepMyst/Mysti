import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { respondToAcpApproval } from '../../../src/providers/base/AcpApproval';
import { NativeApprovalRequests } from '../../../src/providers/base/NativeApprovalRequests';

function respond(options: Record<string, unknown>[]) {
  const write = vi.fn();
  const proc = Object.assign(new EventEmitter(), { stdin: { writable: true, write } }) as unknown as ChildProcess;
  const handler = vi.fn(async () => true);
  const requests = new NativeApprovalRequests({
    panelId: 'p', providerId: 'hermes', process: proc,
    signal: new AbortController().signal, handler, isCurrent: () => true,
  });
  respondToAcpApproval({
    id: 31, params: { sessionId: 's', toolCall: { kind: 'execute', rawInput: {} }, options },
    settings: { mode: 'ask-before-edit', accessLevel: 'full-access' },
    process: proc, sessionId: 's', trackedTools: new Map(), requests,
  });
  return { write, handler, requests, outcome: () => JSON.parse(write.mock.calls[0][0]).result.outcome };
}

describe('ACP permission choices', () => {
  it('one card selects the native one-shot option and preserves its opaque ID', async () => {
    const h = respond([
      { optionId: 'persist', kind: 'allow_always' },
      { optionId: 'opaque-once', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ]);
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledOnce());
    expect(h.outcome()).toEqual({ outcome: 'selected', optionId: 'opaque-once' });
    h.requests.dispose();
  });

  it.each(['allow_always', 'allow_session'])('cannot widen a card to %s', persistentKind => {
    const h = respond([
      { optionId: 'persistent', kind: persistentKind },
      { optionId: 'reject', kind: 'reject_once' },
    ]);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.outcome()).toEqual({ outcome: 'selected', optionId: 'reject' });
    h.requests.dispose();
  });

  it('option kind overrides a contradictory allow_once ID', () => {
    const h = respond([
      { optionId: 'allow_once', kind: 'allow_always' },
      { optionId: 'deny', kind: 'allow_always' },
    ]);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.outcome()).toEqual({ outcome: 'cancelled' });
    h.requests.dispose();
  });

  it('legacy choices with no kind can still express a one-shot decision', async () => {
    const h = respond([{ optionId: 'allow_once' }, { optionId: 'deny' }]);
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledOnce());
    expect(h.outcome()).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    h.requests.dispose();
  });
});
