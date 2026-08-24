/**
 * Plan 20 Phase 6 — per-artifact health.
 *
 * Two design decisions carry the weight here, and both are tested directly:
 * `helped` and `hurt` are never averaged into one score, and nothing is ever
 * auto-deleted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CapabilityLedger,
  QUARANTINE_AFTER,
  DEREGISTER_AFTER,
  type MementoLike,
} from '../../src/services/CapabilityLedger';

function memento(): MementoLike {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string) => store.get(k) as T | undefined,
    update: (k: string, v: unknown) => { store.set(k, v); },
  };
}

describe('CapabilityLedger', () => {
  let ledger: CapabilityLedger;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    ledger = new CapabilityLedger(memento(), () => now);
  });

  it('counts uses and outcomes', () => {
    ledger.record('a', 'helped');
    ledger.record('a', 'neutral');
    const rec = ledger.get('a')!;
    expect(rec).toMatchObject({ uses: 2, helped: 1, hurt: 0 });
  });

  it('never nets hurt off against helped', () => {
    // A 6-help/6-harm artifact is UNSTABLE, not neutral: it fires often and
    // misleads half the time. An averaged score would render that as 50% and
    // file it next to "no data".
    for (let i = 0; i < 6; i++) { ledger.record('a', 'helped'); }
    for (let i = 0; i < 6; i++) { ledger.record('a', 'hurt'); }
    const rec = ledger.get('a')!;
    expect(rec.helped).toBe(6);
    expect(rec.hurt).toBe(6);
    expect(ledger.health()[0].unstable).toBe(true);
  });

  it('does not mark a rarely-used, never-harmful artifact unstable', () => {
    ledger.record('a', 'helped');
    expect(ledger.health()[0].unstable).toBe(false);
  });

  describe('quarantine', () => {
    it('quarantines after consecutive failures', () => {
      for (let i = 0; i < QUARANTINE_AFTER; i++) { ledger.record('a', 'hurt'); }
      expect(ledger.get('a')!.status).toBe('quarantined');
      expect(ledger.requiresForcedApproval('a')).toBe(true);
    });

    it('a success lifts the quarantine — it means "failing now", not a permanent mark', () => {
      for (let i = 0; i < QUARANTINE_AFTER; i++) { ledger.record('a', 'hurt'); }
      ledger.record('a', 'helped');
      expect(ledger.get('a')!.status).toBe('active');
      expect(ledger.requiresForcedApproval('a')).toBe(false);
    });

    it('an interleaved success resets the consecutive counter', () => {
      ledger.record('a', 'hurt');
      ledger.record('a', 'helped');
      ledger.record('a', 'hurt');
      expect(ledger.get('a')!.status).toBe('active');
    });

    it('stops offering it after enough consecutive failures, without deleting anything', () => {
      for (let i = 0; i < DEREGISTER_AFTER; i++) { ledger.record('a', 'hurt'); }
      expect(ledger.isOffered('a')).toBe(false);
      // The record survives, so the history explaining why is still there.
      expect(ledger.get('a')).toBeDefined();
    });

    it('offers an artifact that has never been used', () => {
      // No data is not the same as failing.
      expect(ledger.isOffered('never-seen')).toBe(true);
    });
  });

  describe('aging', () => {
    it('ages an unused artifact to stale, reversibly', () => {
      ledger.record('a', 'helped');
      now += 61 * 24 * 60 * 60 * 1000;
      expect(ledger.ageOut(['a'])).toEqual(['a']);
      expect(ledger.get('a')!.status).toBe('stale');

      ledger.record('a', 'helped');
      expect(ledger.get('a')!.uses).toBe(2);
    });

    it('leaves a recently-used artifact alone', () => {
      ledger.record('a', 'helped');
      now += 1000;
      expect(ledger.ageOut(['a'])).toEqual([]);
    });
  });

  it('reports worst-first so a report leads with what needs attention', () => {
    ledger.record('fine', 'helped');
    ledger.record('bad', 'hurt');
    ledger.record('bad', 'hurt');
    expect(ledger.health()[0].id).toBe('bad');
  });

  it('survives corrupt persisted state', () => {
    const bad: MementoLike = { get: () => [] as never, update: () => {} };
    expect(new CapabilityLedger(bad).health()).toEqual([]);
  });

  it('forgets one artifact on revoke', () => {
    ledger.record('a', 'helped');
    ledger.forget('a');
    expect(ledger.get('a')).toBeUndefined();
  });
});

describe('reportSection — the health surface', () => {
  /**
   * Folded into the single agent-catalog report rather than a second command:
   * two places to look is how a health surface stops being looked at.
   */
  const build = (): CapabilityLedger => new CapabilityLedger(memento(), () => 1);

  it('says so plainly when nothing has run', () => {
    expect(build().reportSection()).toContain('No capability has been called yet');
  });

  it('leads with what is wrong, not with a table', () => {
    const l = build();
    for (let i = 0; i < DEREGISTER_AFTER; i++) { l.record('broken', 'hurt'); }
    const out = l.reportSection();
    expect(out.indexOf('no longer offered')).toBeLessThan(out.indexOf('| capability |'));
  });

  it('names unstable capabilities explicitly rather than letting an average hide them', () => {
    const l = build();
    for (let i = 0; i < 3; i++) { l.record('flaky', 'helped'); l.record('flaky', 'hurt'); }
    const out = l.reportSection();
    expect(out).toContain('unstable');
    expect(out).toContain('helped 3, hurt 3');
    // The reason, stated in the report itself so the number is interpretable.
    expect(out).toContain('never combined');
  });

  it('flags quarantined capabilities as still-callable-but-forced', () => {
    const l = build();
    for (let i = 0; i < QUARANTINE_AFTER; i++) { l.record('q', 'hurt'); }
    expect(l.reportSection()).toContain('quarantined');
  });

  it('renders a row per capability with helped and hurt in separate columns', () => {
    const l = build();
    l.record('a', 'helped');
    l.record('b', 'hurt');
    const out = l.reportSection();
    expect(out).toContain('| a | 1 | 1 | 0 |');
    expect(out).toContain('| b | 1 | 0 | 1 |');
  });
});
