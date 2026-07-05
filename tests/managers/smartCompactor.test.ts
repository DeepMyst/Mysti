/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the SmartCompactor decision engine (Plan 08):
 * activation gate, cache-warmth, and the cache-aware + economic decision.
 */
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { SmartCompactor } from '../../src/managers/SmartCompactor';
import type { DeepMystAuthManager } from '../../src/managers/DeepMystAuthManager';
import type { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';
import type { SavingsLedger } from '../../src/managers/SavingsLedger';
import type { Conversation, Message, UsageStats } from '../../src/types';

function makeCompactor(opts?: { signedIn?: boolean; entitled?: boolean; summaryText?: string }) {
  const ledger = { record: vi.fn() } as unknown as SavingsLedger;
  const auth = {
    isSignedIn: () => opts?.signedIn ?? true,
    hasEntitlement: () => opts?.entitled ?? true,
    getEntitlement: () => undefined,
  } as unknown as DeepMystAuthManager;
  const summary = opts?.summaryText;
  const gateway = {
    chatCompletion: vi.fn(async () =>
      summary
        ? { text: summary, failed: false, costUsd: undefined, inputTokens: undefined, outputTokens: undefined }
        : { text: '', failed: true },
    ),
  } as unknown as DeepMystGatewayClient;
  return { sc: new SmartCompactor(auth, gateway, ledger), ledger, gateway };
}

const msg = (role: Message['role'], content: string, i: number): Message =>
  ({ id: `m${i}`, role, content, timestamp: 1_000 + i });

const usage = (input: number, cacheRead = 0): UsageStats => ({
  input_tokens: input,
  output_tokens: 100,
  cache_read_input_tokens: cacheRead,
});

const base = {
  messageCount: 10,
  providerModel: 'claude-opus-4-8',
  cheapModel: 'claude-haiku-4-5',
  thresholdPercent: 75,
  minSummaryTokens: 5000,
};

describe('SmartCompactor.isActive', () => {
  it('requires the toggle AND signed in AND entitled', () => {
    expect(makeCompactor().sc.isActive(true)).toBe(true);
    expect(makeCompactor().sc.isActive(false)).toBe(false);
    expect(makeCompactor({ signedIn: false }).sc.isActive(true)).toBe(false);
    expect(makeCompactor({ entitled: false }).sc.isActive(true)).toBe(false);
  });
});

describe('SmartCompactor.getWarmth', () => {
  it('is unknown before any turn, warm after a cached turn, cold without cache reads', () => {
    const { sc } = makeCompactor();
    expect(sc.getWarmth('p')).toBe('unknown');
    sc.recordTurn('p', usage(1000, 500));
    expect(sc.getWarmth('p')).toBe('warm');
    sc.recordTurn('p', usage(1000, 0));
    expect(sc.getWarmth('p')).toBe('cold');
  });
});

describe('SmartCompactor.evaluate', () => {
  it('does nothing below threshold', () => {
    const { sc } = makeCompactor();
    const d = sc.evaluate({ panelId: 'p', usage: usage(100000), contextWindow: 200000, ...base });
    expect(d.act).toBe(false);
    expect(d.tier).toBe('none');
  });

  it('compacts on critical fill regardless of warmth', () => {
    const { sc } = makeCompactor();
    const d = sc.evaluate({ panelId: 'p', usage: usage(185000), contextWindow: 200000, ...base });
    expect(d.act).toBe(true);
    expect(d.tier).toBe('compact');
  });

  it('acts when the cache is cold and compaction is economical (large prefix)', () => {
    const { sc } = makeCompactor();
    sc.recordTurn('p', usage(150000, 0)); // cold
    const d = sc.evaluate({ panelId: 'p', usage: usage(150000), contextWindow: 200000, ...base });
    expect(d.warmth).toBe('cold');
    expect(d.act).toBe(true);
    expect(d.breakEvenTurns).toBeGreaterThan(0);
  });

  it('defers while the cache is warm and compaction is not yet economical (small prefix)', () => {
    const { sc, ledger } = makeCompactor();
    sc.recordTurn('p', usage(10000, 5000)); // warm
    const d = sc.evaluate({ panelId: 'p', usage: usage(10000, 5000), contextWindow: 20000, ...base });
    expect(d.warmth).toBe('warm');
    expect(d.act).toBe(false);
    expect(d.deferred).toBe(true);
    // Deferring while warm records an (estimated) cache-timing saving.
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cache-timing', estimated: true }));
  });

  it('charges the cold-reseed of the preserved tail — a larger preserveTokens raises N*', () => {
    const { sc } = makeCompactor();
    sc.recordTurn('p', usage(150000, 0)); // cold
    const lean = sc.evaluate({ panelId: 'p', usage: usage(150000), contextWindow: 200000, ...base });
    const { sc: sc2 } = makeCompactor();
    sc2.recordTurn('q', usage(150000, 0));
    const heavy = sc2.evaluate({ panelId: 'q', usage: usage(150000), contextWindow: 200000, ...base, preserveTokens: 40000 });
    // Re-priming a bigger preserved tail costs more, so the break-even turn count
    // is strictly higher when preserveTokens is large.
    expect(heavy.breakEvenTurns!).toBeGreaterThan(lean.breakEvenTurns!);
  });
});

describe('SmartCompactor._preserveBoundary', () => {
  const M = (role: Message['role'], i: number) => msg(role, `c${i}`, i);

  it('defaults to len - COMPACTION_MESSAGES_TO_PRESERVE when that lands on a user turn', () => {
    // 8 messages, default boundary = 4; make index 4 a user turn.
    const ms = [M('user', 0), M('assistant', 1), M('user', 2), M('assistant', 3), M('user', 4), M('assistant', 5), M('user', 6), M('assistant', 7)];
    expect(SmartCompactor._preserveBoundary(ms)).toBe(4);
  });

  it('snaps earlier to the nearest user turn so an exchange is never split', () => {
    // Default boundary index 4 is an assistant reply; the nearest user turn
    // within the window is index 3.
    const ms = [M('user', 0), M('assistant', 1), M('assistant', 2), M('user', 3), M('assistant', 4), M('assistant', 5), M('user', 6), M('assistant', 7)];
    expect(SmartCompactor._preserveBoundary(ms)).toBe(3);
  });

  it('never returns < 1 (always summarizes at least one message)', () => {
    const ms = [M('assistant', 0), M('assistant', 1), M('assistant', 2), M('assistant', 3), M('assistant', 4)];
    expect(SmartCompactor._preserveBoundary(ms)).toBeGreaterThanOrEqual(1);
  });
});

describe('SmartCompactor measured remaining-turns (EWMA N)', () => {
  it('uses the default before any epoch, then the measured epoch length after a compaction', async () => {
    // Structured memory (known sections), > 150 est tokens — clears the
    // structure + degenerate floors so the bootstrap compaction succeeds.
    const summaryText = [
      '## Goal',
      'Keep the smart-compaction work moving toward a shippable, cache-honest state.',
      '',
      '## Decisions',
      '- Use delta-patch memory so unchanged sections stay byte-identical across epochs.',
      '- Measure remaining turns via an EWMA of completed compaction epochs, not a constant.',
      '- Fold the Claude cold-reseed cost into the break-even so N* is not optimistic.',
      '- Keep the compacted prefix above the minimum cacheable size for the model in use.',
      '',
      '## Files',
      'src/managers/SmartCompactor.ts → the decision engine and incremental summarizer',
      'src/managers/CompactionManager.ts → per-panel usage tracking and the smart/legacy switch',
      '',
      '## Open Threads',
      '- Land the EWMA measured-N change and prove it via this integration test.',
      '- Verify the economic decision uses the measured value once an epoch exists.',
      '- Surface realized savings continuously so users see the value of compaction.',
    ].join('\n');
    const { sc } = makeCompactor({ summaryText });
    expect(sc.estimateRemainingTurns()).toBe(6); // SMART_DEFAULT_REMAINING_TURNS

    // Accumulate a 10-turn epoch on panel 'p'.
    for (let i = 0; i < 10; i++) { sc.recordTurn('p', usage(1000, 500)); }

    const conversation: Conversation = {
      id: 'c', title: 't', messages: [
        msg('user', 'one', 0), msg('assistant', 'a', 1), msg('user', 'two', 2),
        msg('assistant', 'b', 3), msg('user', 'three', 4), msg('assistant', 'c', 5),
      ], createdAt: 0, updatedAt: 0,
    } as unknown as Conversation;

    // Skip the on-disk memory write so this stays a pure unit test.
    const folders = (vscode.workspace as any).workspaceFolders;
    (vscode.workspace as any).workspaceFolders = undefined;
    try {
      const res = await sc.summarize({ panelId: 'p', conversation, providerModel: 'claude-opus-4-8', cheapModel: 'claude-haiku-4-5', minSummaryTokens: 5000 });
      expect(res?.success).toBe(true);
    } finally {
      (vscode.workspace as any).workspaceFolders = folders;
    }

    // The closed epoch (10 turns) is now the EWMA seed → measured N = 10.
    expect(sc.estimateRemainingTurns()).toBe(10);
  });
});
