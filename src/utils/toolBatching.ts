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
 * Plan 24 Phase 3 — how much of a native tool-call batch may run at once.
 *
 * A capable model emits several `tool_calls` in one turn. The coordinator can
 * only run a batch in parallel when every call in it is a read-only local tool
 * (no gate, no write race, no interactive card to collide over); anything else
 * runs one at a time, and the extras are re-issued a round-trip later.
 *
 * The stock rule is all-or-nothing: ONE mutating call anywhere in the batch
 * sends every read in it back for another round-trip. Boost adds the leading
 * read-only RUN as a middle case, which is the same safety property (the
 * prefix is read-only by construction) with fewer wasted round-trips.
 *
 * Pure and separated from the coordinator loop so the decision is testable on
 * its own — the loop around it is 800 lines of streaming state.
 */

export type ToolBatchReason = 'all-read-only' | 'read-only-prefix' | 'none';

export interface ToolBatchDecision {
  /**
   * How many LEADING calls may run together. 0 means fall through to the
   * serial single-call path (which is also the answer for a batch of one).
   */
  batchSize: number;
  reason: ToolBatchReason;
}

/**
 * Decide the batch size for one turn's tool calls.
 *
 * @param kinds       One entry per call, in emission order. `null` marks a call
 *                    that failed to convert (bad arguments) — never batchable,
 *                    and it terminates the prefix.
 * @param isReadOnly  Whether a kind is a read-only local tool.
 * @param allowPrefix Whether the leading read-only run may be batched when the
 *                    batch as a whole is mixed (Boost on).
 */
export function selectToolBatch(
  kinds: ReadonlyArray<string | null>,
  isReadOnly: (kind: string) => boolean,
  allowPrefix: boolean,
): ToolBatchDecision {
  // A single call has nothing to parallelise; the serial path handles it.
  if (kinds.length < 2) { return { batchSize: 0, reason: 'none' }; }

  const readOnlyAt = (i: number): boolean => {
    const k = kinds[i];
    return k !== null && isReadOnly(k);
  };

  let prefix = 0;
  while (prefix < kinds.length && readOnlyAt(prefix)) { prefix++; }

  if (prefix === kinds.length) { return { batchSize: prefix, reason: 'all-read-only' }; }
  // A prefix of one is not a batch — it is the serial path with extra steps,
  // and routing it here would change which card the single path posts.
  if (allowPrefix && prefix > 1) { return { batchSize: prefix, reason: 'read-only-prefix' }; }
  return { batchSize: 0, reason: 'none' };
}
