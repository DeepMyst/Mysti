/**
 * Plan 20 Phase 3 — goldens come from what the HOST watched, never from the
 * model.
 *
 * This is the control that separates a verification ladder from theatre. The
 * documented failure is not hypothetical: the Darwin Gödel Machine fabricated a
 * passing test log for tests that never ran, and when asked to fix hallucination
 * detection found both the honest fix and the hack of deleting the detector's
 * markers. If the model writes the expectation, the expectation proves nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ObservedRuns,
  commandShape,
  digestOutput,
  RECURRENCE_THRESHOLD,
  type MementoLike,
} from '../../src/services/ObservedRuns';

function memento(): MementoLike {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string) => store.get(k) as T | undefined,
    update: (k: string, v: unknown) => { store.set(k, v); },
  };
}

describe('commandShape', () => {
  it('collapses runs of the same procedure to one shape', () => {
    // Without generalization every invocation looks unique and the recurrence
    // signal never fires.
    expect(commandShape('npm run build -- --out /tmp/a1b2c3d4e5f6')).toBe(
      commandShape('npm run build -- --out /tmp/9f8e7d6c5b4a')
    );
  });

  it('generalizes paths, hashes, ports, dates, numbers and quoted literals', () => {
    expect(commandShape('git show a1b2c3d4e5f6a7b8')).toContain('<hash>');
    expect(commandShape('node server.js --port 8080')).toContain('<n>');
    expect(commandShape('cat /etc/hosts')).toContain('<path>');
    expect(commandShape('echo "hello world"')).toContain('<str>');
    expect(commandShape('backup 2026-08-20T10:00:00')).toContain('<date>');
  });

  it('keeps genuinely different commands distinct', () => {
    expect(commandShape('npm run build')).not.toBe(commandShape('npm run test'));
  });
});

describe('ObservedRuns', () => {
  let runs: ObservedRuns;
  let clock: number;

  beforeEach(() => {
    clock = 0;
    runs = new ObservedRuns(memento(), () => clock++);
  });

  it('stores a digest, never the output itself', () => {
    // stdout can contain anything the workspace contains.
    runs.record('npm test', 0, 'SECRET_TOKEN=abc123', 'run-1');
    const stored = runs.forShape(commandShape('npm test'))[0];
    expect(JSON.stringify(stored)).not.toContain('SECRET_TOKEN');
    expect(stored.outputDigest).toBe(digestOutput('SECRET_TOKEN=abc123'));
  });

  it('counts independent successes per coordinator run, not per invocation', () => {
    // Five retries inside one turn are ONE observation. Counting correlated
    // observations as independent votes is how a promotion gate degrades.
    const shape = commandShape('npm test');
    for (let i = 0; i < 5; i++) { runs.record('npm test', 0, 'ok', 'run-1'); }
    expect(runs.independentSuccesses(shape)).toBe(1);

    runs.record('npm test', 0, 'ok', 'run-2');
    expect(runs.independentSuccesses(shape)).toBe(2);
  });

  it('does not count failures toward recurrence', () => {
    const shape = commandShape('npm test');
    runs.record('npm test', 1, 'boom', 'run-1');
    runs.record('npm test', 1, 'boom', 'run-2');
    expect(runs.independentSuccesses(shape)).toBe(0);
    expect(runs.recurringShapes()).toEqual([]);
  });

  it('surfaces a shape only once it hits the distillation break-even', () => {
    for (let i = 1; i <= RECURRENCE_THRESHOLD - 1; i++) {
      runs.record('npm run deploy:staging', 0, 'ok', `run-${i}`);
    }
    expect(runs.recurringShapes()).toEqual([]);

    runs.record('npm run deploy:staging', 0, 'ok', `run-${RECURRENCE_THRESHOLD}`);
    const recurring = runs.recurringShapes();
    expect(recurring).toHaveLength(1);
    expect(recurring[0].runs).toBe(RECURRENCE_THRESHOLD);
  });

  it('returns goldens drawn from observed successes', () => {
    runs.record('npm run build', 0, 'built in 3s', 'run-1');
    runs.record('npm test', 0, '42 passing', 'run-1');
    const goldens = runs.goldensFor(['npm run build', 'npm test']);
    expect(goldens).toHaveLength(2);
    expect(goldens[0].outputDigest).toBe(digestOutput('built in 3s'));
  });

  it('returns NOTHING when a command was never observed succeeding', () => {
    // Callers must treat this as "cannot verify" — there is deliberately no
    // fallback to anything a model supplied.
    runs.record('npm run build', 1, 'failed', 'run-1');
    expect(runs.goldensFor(['npm run build'])).toEqual([]);
    expect(runs.goldensFor(['never-run-command'])).toEqual([]);
  });

  it('bounds storage, evicting oldest first', () => {
    // Distinct WORDS, not numbers: `cmd-0` and `cmd-399` both normalize to
    // `cmd-<n>`, so numbered commands would all share one shape.
    const word = (i: number): string => `task${String.fromCharCode(97 + (i % 26))}${'x'.repeat(Math.floor(i / 26))}`;
    for (let i = 0; i < 400; i++) { runs.record(`npm run ${word(i)}`, 0, 'x', `run-${i}`); }
    expect(runs.forShape(commandShape(`npm run ${word(0)}`))).toHaveLength(0);   // evicted
    expect(runs.forShape(commandShape(`npm run ${word(399)}`))).toHaveLength(1); // kept
  });

  it('a numeric-only difference is deliberately the SAME shape', () => {
    // This is the generalization doing its job: `--port 8080` and `--port 9090`
    // are the same procedure, and treating them as distinct would mean the
    // recurrence signal never fires for any parameterized command.
    runs.record('node server.js --port 8080', 0, 'ok', 'run-1');
    runs.record('node server.js --port 9090', 0, 'ok', 'run-2');
    expect(runs.independentSuccesses(commandShape('node server.js --port 3000'))).toBe(2);
  });

  it('survives corrupt persisted state', () => {
    const bad: MementoLike = { get: () => 42 as never, update: () => {} };
    expect(new ObservedRuns(bad).recurringShapes()).toEqual([]);
  });
});
