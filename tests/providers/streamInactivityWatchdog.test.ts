/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 18 (4.2): PROCESS_TIMEOUT_MS previously only bounded the "stdout
 * closed but process not exited" window (waitForProcess) — a CLI wedged with
 * stdout OPEN and no data spun forever. The watchdog races every stdout read
 * against an inactivity timer, kills the wedged process, and surfaces an
 * explicit error chunk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { TestableClaudeProvider } from '../helpers/providerFactory';
import { STREAM_INACTIVITY_TIMEOUT_MS } from '../../src/constants';

describe('processStream inactivity watchdog (Plan 18 4.2)', () => {
  beforeEach(() => { clearMockConfig(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function wedgedSession(): any {
    const kill = vi.fn(() => true);
    const fakeStdout = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}), // stdout open, never any data
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    return {
      session: {
        panelId: 'p',
        autonomousMode: false,
        suspended: false,
        process: {
          // Exercise the handle fallback without targeting a real Windows PID.
          pid: undefined,
          exitCode: null,
          signalCode: null,
          kill,
          on: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn(),
          stdout: fakeStdout,
          stderr: null,
        },
      },
      kill,
    };
  }

  it('kills a wedged stdout-open CLI and surfaces a timeout error', async () => {
    const provider = new TestableClaudeProvider();
    const { session, kill } = wedgedSession();

    const gen = (provider as any).processStream({ output: '' }, session);
    const firstPull = gen.next();

    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1_000);

    const r = await firstPull;
    expect(r.done).toBe(false);
    expect(r.value.type).toBe('error');
    expect(String(r.value.content)).toMatch(/timed out/i);
    expect(kill).toHaveBeenCalled();

    // Generator ends after the timeout error — no hang on waitForProcess.
    const end = await gen.next();
    expect(end.done).toBe(true);
  });

  it('data arriving before the deadline resets the watchdog (no spurious timeout)', async () => {
    const provider = new TestableClaudeProvider();
    let pullCount = 0;
    const fakeStdout = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            pullCount++;
            if (pullCount === 1) {
              // One JSON line, delivered quickly. NOTE: must be a line the
              // Claude parser yields a chunk for — `assistant` events return
              // null by design (content_block_* events are authoritative), so
              // use a text_delta stream event.
              return Promise.resolve({ done: false, value: Buffer.from('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}}\n') });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    const session: any = {
      panelId: 'p', autonomousMode: false, suspended: false,
      process: {
        pid: 4243, exitCode: 0, signalCode: null,
        kill: vi.fn(() => true), on: vi.fn(), once: vi.fn(), removeListener: vi.fn(),
        stdout: fakeStdout, stderr: null,
      },
    };

    const chunks: any[] = [];
    const gen = (provider as any).processStream({ output: '' }, session);
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }
    expect(chunks.some(c => c.type === 'error')).toBe(false);
    expect(chunks.some(c => c.type === 'text')).toBe(true);
  });
});
