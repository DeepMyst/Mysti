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
 * Order-preserving bounded-concurrency runner (Plan 19 Phase 5). Runs `items`
 * through `fn` with at most `limit` in flight and returns results in INPUT
 * order. Used by the Mysti coordinator to run a native parallel-tool-call batch
 * of read-only local tools (cap 3, like CollaboratorPool). `fn` is expected to
 * be total (never throw); if it can reject, wrap it so one failure doesn't abort
 * the whole batch.
 */

export async function runBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) { return; }
      results[i] = await fn(items[i], i);
    }
  };
  // At least one worker; never more workers than items.
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
