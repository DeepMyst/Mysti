/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Order-preserving bounded-concurrency runner (Plan 19 Phase 5).
 */
import { describe, it, expect } from 'vitest';
import { runBounded } from '../../src/utils/boundedConcurrency';

describe('runBounded', () => {
  it('returns results in INPUT order regardless of completion order', async () => {
    // Later items resolve sooner (descending delay) — output must still be in input order.
    const items = [0, 1, 2, 3, 4];
    const out = await runBounded(items, 2, async (n) => {
      await new Promise(r => setTimeout(r, (5 - n) * 5));
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let active = 0;
    let peak = 0;
    await runBounded(Array.from({ length: 9 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await runBounded([10, 20, 30, 40], 3, async (n) => { seen.push(n); return n; });
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
  });

  it('is empty-safe and passes the index', async () => {
    expect(await runBounded([], 3, async () => 1)).toEqual([]);
    const idx = await runBounded(['a', 'b', 'c'], 5, async (_v, i) => i);
    expect(idx).toEqual([0, 1, 2]);
  });

  it('treats a non-positive/NaN limit as a single worker (never zero)', async () => {
    const out0 = await runBounded([1, 2, 3], 0, async (n) => n);
    const outNaN = await runBounded([1, 2, 3], Number.NaN, async (n) => n);
    expect(out0).toEqual([1, 2, 3]);
    expect(outNaN).toEqual([1, 2, 3]);
  });
});
