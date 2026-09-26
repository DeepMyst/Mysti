/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for PaidSpendGuard (Plan 30 subagent cost control).
 */
import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { estimateCallUsd, rateFromCatalog, PaidSpendGuard } from '../../src/coordinator/PaidSpendGuard';

describe('estimateCallUsd', () => {
  it('prices prompt chars/4 plus the full output allowance', () => {
    // 40k chars ≈ 10k tokens in at $4/M + 4096 out at $20/M
    expect(estimateCallUsd({ inputPerMTok: 4, outputPerMTok: 20 }, 40_000, 4096)).toBeCloseTo(0.04 + 0.08192, 5);
  });
  it('is undefined for an unknown rate', () => {
    expect(estimateCallUsd(null, 1_000, 100)).toBeUndefined();
  });
  it('converts catalog per-token prices', () => {
    const r = rateFromCatalog({ prompt: 0.000004, completion: 0.00002 })!;
    expect(r.inputPerMTok).toBeCloseTo(4);
    expect(r.outputPerMTok).toBeCloseTo(20);
    expect(rateFromCatalog(undefined)).toBeNull();
  });
});

describe('PaidSpendGuard', () => {
  it('asks for every paid call at the default budget of 0', async () => {
    const ask = vi.fn(async () => true);
    const g = new PaidSpendGuard(0, ask);
    expect(await g.approve({ label: 'Advisor', model: 'm', estimateUsd: 0.1 })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(g.spentUsd).toBeCloseTo(0.1);
  });

  it('proceeds silently within budget and asks once it would be exceeded', async () => {
    const ask = vi.fn(async () => false);
    const g = new PaidSpendGuard(0.25, ask);
    expect(await g.approve({ label: 'a', model: 'm', estimateUsd: 0.1 })).toBe(true);
    expect(await g.approve({ label: 'b', model: 'm', estimateUsd: 0.1 })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(await g.approve({ label: 'c', model: 'm', estimateUsd: 0.1 })).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(g.spentUsd).toBeCloseTo(0.2);
  });

  it('passes an approximate call to ask unchanged', async () => {
    const ask = vi.fn(async () => true);
    const call = { label: 'Subagent', model: 'm', estimateUsd: 0.3, approximate: true };
    await new PaidSpendGuard(0, ask).approve(call);
    expect(ask).toHaveBeenCalledWith(call);
  });

  it('always asks when the cost is unknown', async () => {
    const ask = vi.fn(async () => true);
    await new PaidSpendGuard(100, ask).approve({ label: 'a', model: 'mystery' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('replaces an estimate with the actual cost', async () => {
    const g = new PaidSpendGuard(1, async () => true);
    await g.approve({ label: 'a', model: 'm', estimateUsd: 0.5 });
    g.settle(0.5, 0.12);
    expect(g.spentUsd).toBeCloseTo(0.12);
  });

  it('reports approximate spend once a call settles with no actual cost (I2)', async () => {
    const g = new PaidSpendGuard(1, async () => true);
    await g.approve({ label: 'a', model: 'm', estimateUsd: 0.5 });
    g.settle(0.5, 0.1);
    expect(g.spentApprox).toBe(false);
    await g.approve({ label: 'b', model: 'm', estimateUsd: 0.2 });
    g.settle(0.2, undefined);
    expect(g.spentApprox).toBe(true);
    expect(g.spentUsd).toBeCloseTo(0.3);
  });

  it('never goes negative on a bad budget', async () => {
    const ask = vi.fn(async () => false);
    expect(await new PaidSpendGuard(-5, ask).approve({ label: 'a', model: 'm', estimateUsd: 0 })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
