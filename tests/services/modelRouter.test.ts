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
 * Plan 24 Phase 2 — ModelRouter tier/effort suggestions for UN-tiered
 * delegations. The asymmetry under test is the design: security/review-shaped
 * tasks are forced to `strong` in every profile, `fast` only ever fires on a
 * conservative prose-verb allowlist (never on code-writing tasks — the
 * Sonnet-floor invariant), and everything else returns undefined so existing
 * routing is untouched.
 */
import { describe, it, expect } from 'vitest';
import { ModelRouter, BoostRoutingConfig } from '../../src/services/ModelRouter';
import { BoostProfile } from '../../src/types';

function router(enabled: boolean, profile: BoostProfile = 'balanced'): ModelRouter {
  const cfg: BoostRoutingConfig = { enabled, profile };
  return new ModelRouter(() => cfg);
}

describe('ModelRouter.suggestTier', () => {
  it('returns undefined for everything when Boost is disabled', () => {
    const r = router(false);
    expect(r.suggestTier('Review the permission gate for security holes')).toBeUndefined();
    expect(r.suggestTier('Summarize the changes in this PR')).toBeUndefined();
  });

  it('forces strong for security/review-shaped tasks in every profile', () => {
    const tasks = [
      'Review the settingsClamp changes for correctness',
      'Run an adversarial security audit of the permission gate',
      'Check MystiLocalExec for vulnerabilities',
      'Harden the auth flow against injection',
      'Audit the sandbox escape surface',
      'Make sure no secrets leak into the trust-perimeter files',
    ];
    for (const profile of ['economy', 'balanced', 'quality'] as const) {
      const r = router(true, profile);
      for (const task of tasks) {
        expect(r.suggestTier(task), `${profile}: ${task}`).toBe('strong');
      }
    }
  });

  it('does not over-match auth inside author', () => {
    const r = router(true, 'balanced');
    expect(r.suggestTier('Write the author bio for the README')).toBeUndefined();
  });

  it('suggests fast only for leading prose-shaped verbs (economy/balanced)', () => {
    for (const profile of ['economy', 'balanced'] as const) {
      const r = router(true, profile);
      expect(r.suggestTier('Summarize the changes in this PR')).toBe('fast');
      expect(r.suggestTier('Please explain how the compaction manager works')).toBe('fast');
      expect(r.suggestTier('Translate the README to Arabic')).toBe('fast');
      expect(r.suggestTier('write release notes for v0.5.0')).toBe('fast');
    }
  });

  it('never suggests fast in the quality profile', () => {
    const r = router(true, 'quality');
    expect(r.suggestTier('Summarize the changes in this PR')).toBeUndefined();
    expect(r.suggestTier('Explain how the compaction manager works')).toBeUndefined();
  });

  it('does not downgrade a code task with an incidental trailing verb', () => {
    const r = router(true, 'economy');
    expect(r.suggestTier('Implement the parser and then summarize what changed')).toBeUndefined();
  });

  it('never downgrades a prose-led task that also asks for an EDIT', () => {
    // The Sonnet-floor invariant is about INTENT, not the opening verb: a
    // fast-tier delegation still runs with gated-write access, so anything
    // that ends in a code change must stay off the cheap lane.
    for (const profile of ['economy', 'balanced'] as const) {
      const r = router(true, profile);
      for (const task of [
        'List the dead code in src/ and delete it',
        'Document the public API by adding TSDoc to BoostManager.ts',
        'Explain the flaky test and then fix it',
        'Summarize the diff and update the changelog',
        'Summarize what changed in the parser.ts file',
        'Describe the schema, then migrate the table',
      ]) {
        // The invariant is "never the cheap lane" — an escalation to 'strong'
        // (e.g. a security-shaped filename) also satisfies it.
        expect(r.suggestTier(task), `${profile}: ${task}`).not.toBe('fast');
      }
    }
  });

  it('still downgrades genuine prose work (the guard is not a blanket veto)', () => {
    const r = router(true, 'economy');
    // "changes"/"updates" as NOUNS must not trip the edit guard — otherwise the
    // canonical fast task stops being fast and the lane is dead code.
    expect(r.suggestTier('Summarize the changes in this PR')).toBe('fast');
    expect(r.suggestTier('Describe the data flow of the brainstorm mode')).toBe('fast');
  });

  it('sees an edit ask that opens a sentence, line, bullet, or clause', () => {
    // The guard first matched edit verbs only after and/then/also/to/by, so
    // coverage was phrasing-accidental: the same ask starting a new sentence
    // or a bullet slipped straight through to the cheap, write-capable lane.
    const r = router(true, 'economy');
    for (const task of [
      'Explain what the retry helper does. Fix the off-by-one in the loop.',
      'Explain the retry logic:\n- fix the exponential backoff\n- remove the dead branch',
      'Explain the parser; refactor it so the lexer is reused',
      'Explain what this does\n\nfix the bug',
      'Explain + fix the null deref in the reducer',
    ]) {
      expect(r.suggestTier(task), task).not.toBe('fast');
    }
  });

  it('covers the common edit verbs, not just a sample of them', () => {
    const r = router(true, 'economy');
    for (const verb of [
      'write', 'generate', 'apply', 'commit', 'scaffold', 'revert', 'make',
      'move', 'drop', 'extract', 'split', 'convert', 'port', 'harden',
      'replace', 'rewrite', 'upgrade', 'annotate', 'consolidate',
    ]) {
      const task = `Explain the module and ${verb} the missing handler`;
      expect(r.suggestTier(task), task).not.toBe('fast');
    }
  });

  it('never lets task LENGTH decide the tier', () => {
    // The safety gates once shared a 2000-char window with the `^`-anchored
    // lead test, so truncation could only ever discard an escalation or a
    // veto — the same brief routed differently purely because it was long.
    const r = router(true, 'economy');
    const filler = ' lorem ipsum dolor sit amet consectetur adipiscing elit'.repeat(45);
    expect(filler.length).toBeGreaterThan(2000);

    // Security content past char 2000 must still escalate.
    expect(r.suggestTier(`Summarize the following context:\n${filler}\nthen check the permission gate for injection`))
      .toBe('strong');
    // An edit ask past char 2000 must still veto the downgrade.
    expect(r.suggestTier(`Summarize the following brief:\n${filler}\nFinally, add the missing null check.`))
      .not.toBe('fast');
    // And a genuinely long prose task is still fast.
    expect(r.suggestTier(`Summarize the following meeting notes for the newsletter.${filler}`))
      .toBe('fast');
  });

  it('runs in linear time on adversarial input (no ReDoS)', () => {
    const r = router(true, 'economy');
    const hostile = `summarize ${'and '.repeat(20_000)}`;
    const t0 = Date.now();
    r.suggestTier(hostile);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('strong wins when a prose verb leads into security-shaped content', () => {
    const r = router(true, 'economy');
    expect(r.suggestTier('Summarize the security review findings')).toBe('strong');
  });

  it('leaves ordinary code tasks unrouted', () => {
    const r = router(true, 'economy');
    expect(r.suggestTier('Implement a new provider for Foo following the checklist')).toBeUndefined();
    expect(r.suggestTier('Fix the failing brainstormManager test')).toBeUndefined();
    expect(r.suggestTier('Refactor the webview content builder')).toBeUndefined();
  });
});

describe('ModelRouter.delegationEffort', () => {
  it('lowers effort only for economy fast lanes', () => {
    expect(router(true, 'economy').delegationEffort('fast')).toBe('medium');
    expect(router(true, 'economy').delegationEffort('strong')).toBeUndefined();
    expect(router(true, 'balanced').delegationEffort('fast')).toBeUndefined();
    expect(router(true, 'quality').delegationEffort('fast')).toBeUndefined();
    expect(router(true, 'economy').delegationEffort(undefined)).toBeUndefined();
    expect(router(false, 'economy').delegationEffort('fast')).toBeUndefined();
  });

  it('NEVER raises a child above its parent', () => {
    // clampEffort clamps to the provider's tiers, not to the parent's value,
    // and spec.effortLevel overrides the inherited setting — so a parent at or
    // below 'medium' must return undefined and simply be inherited.
    const r = router(true, 'economy');
    expect(r.delegationEffort('fast', 'low')).toBeUndefined();
    expect(r.delegationEffort('fast', 'medium')).toBeUndefined();
    expect(r.delegationEffort('fast', 'high')).toBe('medium');
    expect(r.delegationEffort('fast', 'xhigh')).toBe('medium');
    expect(r.delegationEffort('fast', 'max')).toBe('medium');
    // Absent parent effort ⇒ assume the shipped 'high' default.
    expect(r.delegationEffort('fast', undefined)).toBe('medium');
  });

  it('does not override when the parent effort is not a known tier', () => {
    // Settings are read with an unchecked cast, so junk is reachable. The
    // parent's own clampEffort drops an unknown value to the backend's LOWEST
    // tier — assuming 'high' here would hand the child a higher effort than
    // the parent is actually running at.
    const r = router(true, 'economy');
    expect(r.delegationEffort('fast', 'none' as never)).toBeUndefined();
    expect(r.delegationEffort('fast', '' as never)).toBeUndefined();
  });
});
