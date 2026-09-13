import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { respondToAcpApproval } from '../../../src/providers/base/AcpApproval';
import { NativeApprovalRequests } from '../../../src/providers/base/NativeApprovalRequests';

function respond(options: Record<string, unknown>[]) {
  const write = vi.fn();
  const stdin = new Writable({ write(chunk, _encoding, callback) { write(String(chunk)); callback(); } });
  const proc = Object.assign(new EventEmitter(), { stdin }) as unknown as ChildProcess;
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
  return { write, handler, requests, stdin, outcome: () => JSON.parse(write.mock.calls[0][0]).result.outcome };
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
    expect(h.stdin.listenerCount('error')).toBe(0);
    expect(h.stdin.listenerCount('close')).toBe(0);
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

  it('handles an asynchronous EPIPE and ends only the child whose stdin closed', async () => {
    const child = spawn(process.execPath, ['-e',
      `require(${JSON.stringify(path.resolve(__dirname, '../../fixtures/closeStdin.cjs'))})(() => process.stdout.write('ready')); setTimeout(() => {}, 30000);`,
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', () => { child.removeListener('error', reject); resolve(); });
      });
      expect(child.stdin.writable).toBe(true);
      respondToAcpApproval({
        id: 91, params: { toolCall: { kind: 'read' }, options: [{ optionId: 'yes', kind: 'allow_once' }] },
        settings: { mode: 'default', accessLevel: 'full-access' },
        process: child, sessionId: null, trackedTools: new Map(), requests: undefined,
      });
      await exited;
      expect(child.killed).toBe(true);
      expect(child.stdin.listenerCount('error')).toBe(0);
      expect(child.stdin.listenerCount('close')).toBe(0);
    } finally {
      child.kill();
      await exited;
    }
  });
});
