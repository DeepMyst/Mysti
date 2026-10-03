/**
 * Plan 20 Phase 1 — the go/no-go instrument.
 *
 * The point of these tests is that the instrument must be able to say NO. A
 * measurement that can only produce encouraging numbers is not evidence, and
 * Phases 2–4 are supposed to be gated on it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SkillTelemetry, type MementoLike } from '../../src/services/SkillTelemetry';

function memento(): MementoLike {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string) => store.get(k) as T | undefined,
    update: (k: string, v: unknown) => { store.set(k, v); },
  };
}

describe('SkillTelemetry', () => {
  let tel: SkillTelemetry;
  let clock: number;

  beforeEach(() => {
    clock = 1000;
    tel = new SkillTelemetry(memento(), () => clock++);
  });

  it('starts empty without dividing by zero', () => {
    const s = tel.summary();
    expect(s).toMatchObject({ runs: 0, engagementRate: 0, searchToViewRate: 0 });
    expect(s.completionWithView).toBeNull();
    expect(s.completionWithoutView).toBeNull();
  });

  it('computes engagement as searched-runs over all runs', () => {
    tel.record(1, ['test-driven'], 'completed');
    tel.record(0, [], 'completed');
    tel.record(2, ['concise'], 'completed');
    tel.record(0, [], 'cancelled');
    const s = tel.summary();
    expect(s.runs).toBe(4);
    expect(s.runsThatSearched).toBe(2);
    expect(s.engagementRate).toBe(0.5);
  });

  it('separates searching from actually reading something', () => {
    tel.record(3, [], 'completed');            // searched, read nothing
    tel.record(1, ['test-driven'], 'completed');
    const s = tel.summary();
    expect(s.runsThatSearched).toBe(2);
    expect(s.runsThatViewed).toBe(1);
    expect(s.searchToViewRate).toBe(0.5);
  });

  it('splits completion by whether the catalog was consulted', () => {
    tel.record(1, ['a'], 'completed');
    tel.record(1, ['a'], 'completed');
    tel.record(0, [], 'completed');
    tel.record(0, [], 'turn-limit');
    const s = tel.summary();
    expect(s.completionWithView).toBe(1);
    expect(s.completionWithoutView).toBe(0.5);
  });

  it('records error and turn-limit outcomes distinctly', () => {
    tel.record(1, ['a'], 'error');
    tel.record(1, ['a'], 'turn-limit');
    expect(tel.summary().completionWithView).toBe(0);
  });

  it('ranks the most-read artifacts and dedupes within a run', () => {
    tel.record(1, ['a', 'a', 'b'], 'completed'); // 'a' twice in one run counts once
    tel.record(1, ['a'], 'completed');
    const top = tel.summary().topArtifacts;
    expect(top[0]).toEqual({ id: 'a', views: 2 });
    expect(top[1]).toEqual({ id: 'b', views: 1 });
  });

  it('bounds storage so a long-lived workspace cannot grow it without limit', () => {
    for (let i = 0; i < 600; i++) { tel.record(1, [`artifact-${i}`], 'completed'); }
    expect(tel.summary().runs).toBe(500);
  });

  it('survives corrupt persisted state', () => {
    const bad: MementoLike = { get: () => 'not an array' as never, update: () => {} };
    expect(new SkillTelemetry(bad).summary().runs).toBe(0);
  });
});

describe('the report must be able to say NO', () => {
  const build = (runs: Array<[number, string[]]>): SkillTelemetry => {
    const t = new SkillTelemetry(memento(), () => 1);
    for (const [searches, viewed] of runs) { t.record(searches, viewed, 'completed'); }
    return t;
  };

  it('refuses to render a verdict on too small a sample', () => {
    const report = build(Array.from({ length: 10 }, () => [1, ['a']] as [number, string[]])).report();
    expect(report).toContain('Not enough data to decide');
    expect(report).not.toContain('NO-GO');
  });

  it('says NO-GO when the model rarely consults the catalog', () => {
    // 40 runs, 4 searches — the ~19% drift band and below.
    const runs: Array<[number, string[]]> = [
      ...Array.from({ length: 4 }, () => [1, ['a']] as [number, string[]]),
      ...Array.from({ length: 36 }, () => [0, []] as [number, string[]]),
    ];
    const report = build(runs).report();
    expect(report).toContain('NO-GO');
    expect(report).toContain('retrieval is');
  });

  it('reports engagement and completion delta without declaring victory', () => {
    const runs: Array<[number, string[]]> = Array.from({ length: 40 }, (_, i) =>
      (i % 4 === 0 ? [0, []] : [1, ['a']]) as [number, string[]]);
    const report = build(runs).report();
    expect(report).toContain('engagement 75%');
    // Engagement alone is explicitly not treated as value.
    expect(report).toContain('Engagement alone is not value');
    expect(report).not.toContain('NO-GO');
  });

  it('states the published comparison band so the number is interpretable', () => {
    expect(build([[1, ['a']]]).report()).toContain('70–80%');
  });
});
