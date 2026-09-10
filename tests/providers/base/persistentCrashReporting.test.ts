/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * D-5 regression: the persistent read loop's `close` handler ignored the exit
 * code, and sendMessage emitted `done` unconditionally afterwards. A backend
 * that crashed, was OOM-killed, or exited non-zero mid-stream therefore
 * rendered in the UI as a successful, complete answer.
 *
 * The stream contract is unchanged: parseStreamLine still emits no `done`, and
 * sendMessage still owns the single terminal `done`. The crash is surfaced as
 * an `error` chunk ahead of it — the same shape the single-shot non-zero-exit
 * path and the inactivity watchdog already use.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliLifecycleProvider } from '../../helpers/cliLifecycleProvider';
import { createClaudeSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { StreamChunk } from '../../../src/types';

const TEXT_LINE = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } },
}) + '\n';
const BOUNDARY_LINE = JSON.stringify({ type: 'result', result: 'done' }) + '\n';

function fakeProc() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const stdoutHandlers: Record<string, ((...a: any[]) => void)[]> = {};
  const proc: any = {
    pid: 4711,
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, write: vi.fn() },
    stdout: {
      on: (e: string, h: any) => { (stdoutHandlers[e] ||= []).push(h); },
      removeListener: (e: string, h: any) => {
        stdoutHandlers[e] = (stdoutHandlers[e] || []).filter(x => x !== h);
      },
    },
    on: (e: string, h: any) => { (handlers[e] ||= []).push(h); },
    removeListener: (e: string, h: any) => {
      handlers[e] = (handlers[e] || []).filter(x => x !== h);
    },
    kill: vi.fn(() => true),
  };
  return {
    proc,
    emitData: (s: string) => { for (const h of stdoutHandlers['data'] || []) { h(Buffer.from(s)); } },
    emitClose: () => { for (const h of handlers['close'] || []) { h(); } },
  };
}

/** Drive _readUntilBoundary through one stdout write and then a process exit. */
async function runUntilExit(
  provider: CliLifecycleProvider,
  session: any,
  exit: { code: number | null; signal: NodeJS.Signals | null },
  opts: { boundaryFirst?: boolean; cancelled?: boolean; stderr?: string } = {},
): Promise<StreamChunk[]> {
  const { proc, emitData, emitClose } = fakeProc();
  session.process = proc;
  session.persistentProcess = proc;
  session.persistentReady = true;
  if (opts.stderr) { session._persistentStderr = opts.stderr; }

  const gen: AsyncGenerator<StreamChunk> = (provider as any)._readUntilBoundary(proc, session);
  const chunks: StreamChunk[] = [];

  const first = gen.next();
  emitData(opts.boundaryFirst ? TEXT_LINE + BOUNDARY_LINE : TEXT_LINE);
  let r = await first;
  while (!r.done) {
    chunks.push(r.value);
    const pending = gen.next();
    if (!opts.boundaryFirst) {
      proc.exitCode = exit.code;
      proc.signalCode = exit.signal;
      if (opts.cancelled) { session.cancelled = true; }
      emitClose();
    }
    r = await pending;
  }
  return chunks;
}

describe('D-5 — a persistent process that dies mid-stream is reported, not silently "done"', () => {
  beforeEach(() => clearMockConfig());

  it('surfaces a non-zero exit as an error chunk carrying the code and the stderr tail', async () => {
    const provider = new CliLifecycleProvider(true);
    const session: any = createClaudeSession();

    const chunks = await runUntilExit(provider, session, { code: 1, signal: null }, {
      stderr: 'FATAL: model provider unreachable',
    });

    expect(chunks.some(c => c.type === 'text')).toBe(true);
    const errors = chunks.filter(c => c.type === 'error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0].content)).toMatch(/exited with code 1/);
    expect(String(errors[0].content)).toMatch(/incomplete/i);
    expect(String(errors[0].content)).toMatch(/model provider unreachable/);
    // Still exactly one terminal `done`, and it is not this generator's to emit.
    expect(chunks.filter(c => c.type === 'done')).toHaveLength(0);
    // Evicted so the next turn respawns rather than writing to a dead pipe.
    expect(session.persistentProcess).toBeNull();
    expect(session.persistentReady).toBe(false);
  });

  it('surfaces an OOM-style signal kill', async () => {
    const provider = new CliLifecycleProvider(true);
    const session: any = createClaudeSession();

    const chunks = await runUntilExit(provider, session, { code: null, signal: 'SIGKILL' });

    const errors = chunks.filter(c => c.type === 'error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0].content)).toMatch(/terminated by SIGKILL/);
  });

  it('stays silent when the response completed before the process exited', async () => {
    const provider = new CliLifecycleProvider(true);
    const session: any = createClaudeSession();

    const chunks = await runUntilExit(provider, session, { code: 0, signal: null }, { boundaryFirst: true });

    expect(chunks.filter(c => c.type === 'error')).toHaveLength(0);
    expect(chunks.some(c => c.type === 'text')).toBe(true);
  });

  it('does not report a user-initiated Stop as a crash', async () => {
    const provider = new CliLifecycleProvider(true);
    const session: any = createClaudeSession();

    const chunks = await runUntilExit(provider, session, { code: null, signal: 'SIGINT' }, { cancelled: true });

    expect(chunks.filter(c => c.type === 'error')).toHaveLength(0);
  });
});
