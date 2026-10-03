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
 * Plan 28 Phase 1 — the Trust ladder's guardrails.
 *
 * The ladder's whole safety claim is that it is a PRESENTATION collapse: it
 * adds no authority, invents no pair the gate has not already handled, and
 * leaves the Plan 23 B1 fail-closed tail reachable. Each of those is a test
 * here, and every one of them should fail loudly if someone later edits
 * `shouldGateToolUse` in a way that changes what a rung means.
 */
import { describe, it, expect } from 'vitest';
import {
  TRUST_STOPS,
  TRUST_COPY,
  authorityForTrust,
  trustForAuthority,
  cycleTrust,
  isTrustStop,
  type TrustStop,
} from '../../src/utils/trustLadder';
import { shouldGateToolUse } from '../../src/utils/permissionClassifier';
import { ACCESS_LEVELS, OPERATION_MODES } from '../../src/utils/settingsClamp';
import type { Settings, AccessLevel, OperationMode } from '../../src/types';

const base = (mode: string, accessLevel: string): Settings => ({
  provider: 'claude-code',
  model: '',
  mode: mode as OperationMode,
  thinkingLevel: 'none',
  effortLevel: 'high',
  accessLevel: accessLevel as AccessLevel,
  contextMode: 'auto',
  autonomousMode: false,
} as Settings);

/** One representative tool per non-read action class the gate distinguishes. */
const WRITING_TOOLS = ['Write', 'Edit', 'MultiEdit', 'delete_file', 'Bash', 'WebFetch', 'Task'];

/** The set of tools a rung gates, as a sorted array for stable comparison. */
function gatedBy(stop: TrustStop): string[] {
  const a = authorityForTrust(stop);
  return WRITING_TOOLS.filter(t => shouldGateToolUse(base(a.mode, a.accessLevel), t)).sort();
}

describe('Trust ladder — the rungs are pairs the gate already handles', () => {
  it('every rung maps into the declared OperationMode x AccessLevel unions', () => {
    for (const stop of TRUST_STOPS) {
      const a = authorityForTrust(stop);
      expect(OPERATION_MODES, `${stop}.mode`).toContain(a.mode);
      expect(ACCESS_LEVELS, `${stop}.accessLevel`).toContain(a.accessLevel);
    }
  });

  it('pins each rung to the exact pair documented in TRUST_AUTHORITY', () => {
    expect(authorityForTrust('plan')).toEqual({ mode: 'quick-plan', accessLevel: 'read-only' });
    expect(authorityForTrust('ask')).toEqual({ mode: 'ask-before-edit', accessLevel: 'ask-permission' });
    expect(authorityForTrust('auto')).toEqual({ mode: 'edit-automatically', accessLevel: 'ask-permission' });
    expect(authorityForTrust('full')).toEqual({ mode: 'edit-automatically', accessLevel: 'full-access' });
  });

  it('round-trips: setting a rung and reading it back yields the same rung', () => {
    for (const stop of TRUST_STOPS) {
      const a = authorityForTrust(stop);
      expect(trustForAuthority(a.mode, a.accessLevel), stop).toBe(stop);
    }
  });

  it('keeps detailed-plan when the user was already on it', () => {
    expect(authorityForTrust('plan', 'detailed-plan').mode).toBe('detailed-plan');
    expect(authorityForTrust('plan', 'quick-plan').mode).toBe('quick-plan');
    // The preference is scoped to `plan` — it must not leak into a writing rung.
    expect(authorityForTrust('auto', 'detailed-plan').mode).toBe('edit-automatically');
  });
});

describe('Trust ladder — authority is monotonic across the writing rungs', () => {
  /*
   * `plan` is deliberately excluded from this ordering. Its enforcement is NOT
   * the stream gate: `quick-plan` + `read-only` reaches the "not gated here"
   * tail of `shouldGateToolUse`, because a plan-tier turn is held read-only by
   * the CLI's own permission mode and the coordinator refuses local execution
   * outright. Asserting `plan` gates the most tools would therefore encode a
   * falsehood. What IS asserted about `plan` is the pair itself, below.
   */
  it('ask gates at least as much as auto, which gates at least as much as full', () => {
    const ask = new Set(gatedBy('ask'));
    const auto = new Set(gatedBy('auto'));
    const full = new Set(gatedBy('full'));

    for (const t of auto) { expect(ask.has(t), `auto gates ${t}, ask must too`).toBe(true); }
    for (const t of full) { expect(auto.has(t), `full gates ${t}, auto must too`).toBe(true); }

    // And the ordering is strict — the rungs are not three names for one tier.
    expect(ask.size).toBeGreaterThan(auto.size);
    expect(auto.size).toBeGreaterThan(full.size);
  });

  it('pins what each writing rung actually gates', () => {
    expect(gatedBy('ask')).toEqual(
      ['Bash', 'Edit', 'MultiEdit', 'Task', 'WebFetch', 'Write', 'delete_file'].sort());
    // The accept-edits tier: writes land, everything with reach still asks.
    expect(gatedBy('auto')).toEqual(['Bash', 'Task', 'WebFetch', 'delete_file'].sort());
    expect(gatedBy('full')).toEqual([]);
  });

  it('plan is held read-only above the gate, not by it', () => {
    const a = authorityForTrust('plan');
    expect(a.accessLevel).toBe('read-only');
    expect(['quick-plan', 'detailed-plan']).toContain(a.mode);
  });

  it('never gates a plain read on any rung', () => {
    for (const stop of TRUST_STOPS) {
      const a = authorityForTrust(stop);
      expect(shouldGateToolUse(base(a.mode, a.accessLevel), 'Read'), stop).toBe(false);
    }
  });
});

describe('Trust ladder — the display mapping is total and honest', () => {
  it('resolves all fifteen stored combinations to a real rung', () => {
    let n = 0;
    for (const mode of OPERATION_MODES) {
      for (const access of ACCESS_LEVELS) {
        const stop = trustForAuthority(mode as OperationMode, access as AccessLevel);
        expect(isTrustStop(stop), `${mode}/${access} -> ${stop}`).toBe(true);
        n++;
      }
    }
    expect(n).toBe(15);
  });

  it('never shows a rung that gates MORE than the stored pair actually does', () => {
    // The pill must not claim to be asking when the gate is letting things
    // through. For every stored combination, the rung's own pair may not gate
    // a tool that the stored pair lets past.
    for (const mode of OPERATION_MODES) {
      for (const access of ACCESS_LEVELS) {
        if (access === 'read-only' || mode === 'quick-plan' || mode === 'detailed-plan') {
          continue; // the plan tier is enforced above the gate — see above
        }
        const shown = authorityForTrust(trustForAuthority(mode as OperationMode, access as AccessLevel));
        for (const t of WRITING_TOOLS) {
          const storedGates = shouldGateToolUse(base(mode, access), t);
          const shownGates = shouldGateToolUse(base(shown.mode, shown.accessLevel), t);
          expect(shownGates, `${mode}/${access} tool=${t}`).toBe(storedGates);
        }
      }
    }
  });

  it('shows Plan whenever either half of the pair forbids writing', () => {
    expect(trustForAuthority('quick-plan', 'full-access')).toBe('plan');
    expect(trustForAuthority('detailed-plan', 'ask-permission')).toBe('plan');
    expect(trustForAuthority('edit-automatically', 'read-only')).toBe('plan');
    expect(trustForAuthority('default', 'read-only')).toBe('plan');
  });

  it('falls back to ask — never full — for a value outside the unions', () => {
    expect(trustForAuthority('nonsense' as OperationMode, 'nonsense' as AccessLevel)).toBe('ask');
  });
});

describe('Trust ladder — the B1 fail-closed tail is still reachable', () => {
  it('an unrecognised mode still gates, ladder or not', () => {
    // The ladder shrinks what can REACH this tail. It must not remove it.
    expect(shouldGateToolUse(base('bogus-mode', 'ask-permission'), 'Bash')).toBe(true);
    expect(shouldGateToolUse(base('edit-automatically', 'bogus-access'), 'Bash')).toBe(true);
  });
});

describe('Trust ladder — cycling', () => {
  it('advances one rung and wraps', () => {
    expect(cycleTrust('plan')).toBe('ask');
    expect(cycleTrust('ask')).toBe('auto');
    expect(cycleTrust('auto')).toBe('full');
    expect(cycleTrust('full')).toBe('plan');
  });

  it('cycles backwards on a negative delta', () => {
    expect(cycleTrust('ask', -1)).toBe('plan');
    expect(cycleTrust('plan', -1)).toBe('full');
  });

  it('clamps any magnitude to a single rung, so a stray value cannot skip one', () => {
    expect(cycleTrust('plan', 99)).toBe('ask');
    expect(cycleTrust('plan', -99)).toBe('full');
    expect(cycleTrust('plan', 0)).toBe('ask');
  });

  it('recovers from an unknown current rung at the most restrictive end', () => {
    expect(cycleTrust('bogus' as TrustStop)).toBe('ask'); // index 0 -> plan, +1 -> ask
  });
});

describe('Trust ladder — copy', () => {
  it('gives every rung a label and a plain-words permission line', () => {
    for (const stop of TRUST_STOPS) {
      expect(TRUST_COPY[stop].label.length).toBeGreaterThan(0);
      expect(TRUST_COPY[stop].permits.length).toBeGreaterThan(0);
    }
  });

  it('has exactly four rungs, ordered most restrictive first', () => {
    expect(TRUST_STOPS).toEqual(['plan', 'ask', 'auto', 'full']);
  });
});
