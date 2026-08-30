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
 * Plan 24 Phase 3 — the tool-batch decision.
 *
 * The safety property under test is that the batched span is read-only for its
 * WHOLE length. Everything the coordinator runs in parallel skips the
 * permission card by construction, so a mutating call reaching the batch would
 * be a mutating call running ungated — the batch size is the only thing
 * standing between those two states.
 */
import { describe, it, expect } from 'vitest';
import { selectToolBatch } from '../../src/utils/toolBatching';

const READ_ONLY = new Set(['read', 'ls', 'grep', 'diag']);
const isReadOnly = (k: string) => READ_ONLY.has(k);

/** Every kind the coordinator can emit that is NOT read-only. */
const MUTATING = ['write', 'edit', 'patch', 'bash', 'delegate', 'remember', 'publish', 'skillrun', 'act', 'mcptool', 'connect'];

describe('selectToolBatch — stock behaviour (Boost off)', () => {
  it('batches only when EVERY call is read-only', () => {
    expect(selectToolBatch(['read', 'grep', 'ls'], isReadOnly, false))
      .toEqual({ batchSize: 3, reason: 'all-read-only' });
  });

  it('falls through to serial as soon as anything mutates', () => {
    for (const m of MUTATING) {
      expect(selectToolBatch(['read', 'read', m], isReadOnly, false), m)
        .toEqual({ batchSize: 0, reason: 'none' });
    }
  });

  it('never batches a single call', () => {
    expect(selectToolBatch(['read'], isReadOnly, false)).toEqual({ batchSize: 0, reason: 'none' });
    expect(selectToolBatch([], isReadOnly, false)).toEqual({ batchSize: 0, reason: 'none' });
  });
});

describe('selectToolBatch — Boost prefix', () => {
  it('runs the leading read-only run of a mixed batch', () => {
    expect(selectToolBatch(['read', 'grep', 'write', 'read'], isReadOnly, true))
      .toEqual({ batchSize: 2, reason: 'read-only-prefix' });
  });

  it('NEVER extends past the first mutating call, for every mutating kind', () => {
    // The core safety property: the batched span skips the permission gate, so
    // it must be read-only for its whole length.
    for (const m of MUTATING) {
      const d = selectToolBatch(['read', 'ls', m, 'read', 'grep'], isReadOnly, true);
      expect(d.batchSize, m).toBe(2);
    }
  });

  it('declines when the batch opens with a mutating call', () => {
    expect(selectToolBatch(['write', 'read', 'read'], isReadOnly, true))
      .toEqual({ batchSize: 0, reason: 'none' });
  });

  it('declines a prefix of one — that is the serial path with extra steps', () => {
    expect(selectToolBatch(['read', 'write', 'read'], isReadOnly, true))
      .toEqual({ batchSize: 0, reason: 'none' });
  });

  it('treats a failed conversion as a hard stop, never as read-only', () => {
    // A call that would not parse must not be counted into a parallel span.
    expect(selectToolBatch(['read', 'read', null, 'read'], isReadOnly, true))
      .toEqual({ batchSize: 2, reason: 'read-only-prefix' });
    expect(selectToolBatch([null, 'read', 'read'], isReadOnly, true))
      .toEqual({ batchSize: 0, reason: 'none' });
    // All-null is not "all read-only".
    expect(selectToolBatch([null, null], isReadOnly, true))
      .toEqual({ batchSize: 0, reason: 'none' });
  });

  it('an all-read-only batch is unaffected by the Boost flag', () => {
    const off = selectToolBatch(['read', 'ls'], isReadOnly, false);
    const on = selectToolBatch(['read', 'ls'], isReadOnly, true);
    expect(on).toEqual(off);
    expect(on.reason).toBe('all-read-only');
  });

  it('the prefix is exactly the batch when Boost is off, or nothing', () => {
    // Boost must not change any all-read-only or single-call outcome; it only
    // adds the mixed-batch case.
    const cases: Array<Array<string | null>> = [
      ['read'], ['write'], ['read', 'ls'], ['write', 'read'],
      ['read', 'write'], ['read', 'read', 'write'],
    ];
    for (const c of cases) {
      const off = selectToolBatch(c, isReadOnly, false);
      const on = selectToolBatch(c, isReadOnly, true);
      if (off.batchSize > 0) {
        expect(on, JSON.stringify(c)).toEqual(off);
      } else {
        // Boost may only ever ADD a read-only prefix, never a mutating one.
        expect(on.batchSize === 0 || on.reason === 'read-only-prefix').toBe(true);
        for (let i = 0; i < on.batchSize; i++) {
          expect(isReadOnly(c[i] as string), `${JSON.stringify(c)}[${i}]`).toBe(true);
        }
      }
    }
  });
});
