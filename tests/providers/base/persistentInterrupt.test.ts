/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * D-4 regression: the base `_interruptPersistentProcess` wrote a raw ETX byte
 * (\x03) into the persistent process's stdin. Three providers declare
 * `supportsPersistentProcess` — Claude Code, Hermes and Kimi — and all three
 * speak a STRUCTURED stdin protocol (Claude Code: `--input-format stream-json`
 * NDJSON; Hermes/Kimi: ACP JSON-RPC over stdio). On such a pipe the byte is not
 * an interrupt: it lands inside the current line and makes the NEXT message
 * unparseable, so Stop bricked the session instead of cancelling the turn.
 *
 * Hermes and Kimi already overrode this. This locks the fix for Claude Code and
 * for the base default no future provider should inherit.
 */
import { describe, it, expect, vi } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';

vi.mock('../../../src/utils/processKill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/processKill')>();
  return { ...actual, killProcessTree: vi.fn(() => true) };
});
import { killProcessTree } from '../../../src/utils/processKill';

const ETX = String.fromCharCode(3);

function livePersistentSession() {
  const write = vi.fn();
  const session: any = createClaudeSession();
  session.persistentProcess = {
    pid: 9001,
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, write },
    kill: vi.fn(() => true),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  session.persistentReady = true;
  return { session, write };
}

describe('D-4 — Stop must not write a raw ETX byte into a structured stdin', () => {
  it('Claude Code never writes to stdin on interrupt', () => {
    const provider = new TestableClaudeProvider();
    const { session, write } = livePersistentSession();

    (provider as any)._interruptPersistentProcess(session);

    expect(write).not.toHaveBeenCalled();
    for (const call of write.mock.calls) {
      expect(String(call[0])).not.toContain(ETX);
    }
  });

  it('Claude Code ends the turn with the documented SIGINT and evicts the process', () => {
    const provider = new TestableClaudeProvider();
    const { session } = livePersistentSession();
    vi.mocked(killProcessTree).mockClear();

    (provider as any)._interruptPersistentProcess(session);

    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(vi.mocked(killProcessTree).mock.calls[0][2]).toMatchObject({ initialSignal: 'SIGINT' });
    // Evicted, so the next turn respawns with clean protocol state (and
    // re-attaches via --resume, which buildPersistentCliArgs still emits).
    expect(session.persistentProcess).toBeNull();
    expect(session.persistentReady).toBe(false);
  });

  it('the inherited base default writes no stdin byte either', async () => {
    const { BaseCliProvider } = await import('../../../src/providers/base/BaseCliProvider');
    const provider = new TestableClaudeProvider();
    const { session, write } = livePersistentSession();

    (BaseCliProvider.prototype as any)._interruptPersistentProcess.call(provider, session);

    expect(write).not.toHaveBeenCalled();
    expect(session.persistentProcess).toBeNull();
    expect(session.persistentReady).toBe(false);
  });

  it('every provider that declares supportsPersistentProcess overrides the interrupt', async () => {
    const { ClaudeCodeProvider } = await import('../../../src/providers/claude/ClaudeCodeProvider');
    const { HermesProvider } = await import('../../../src/providers/hermes/HermesProvider');
    const { KimiCodeProvider } = await import('../../../src/providers/kimi/KimiCodeProvider');
    for (const cls of [ClaudeCodeProvider, HermesProvider, KimiCodeProvider]) {
      expect(
        Object.prototype.hasOwnProperty.call(cls.prototype, '_interruptPersistentProcess'),
        `${cls.name} must define its own _interruptPersistentProcess`,
      ).toBe(true);
    }
  });
});
