import { describe, it, expect, beforeEach } from 'vitest';
import { BackgroundJobManager } from '../../src/managers/BackgroundJobManager';

describe('BackgroundJobManager', () => {
  let m: BackgroundJobManager;
  beforeEach(() => { m = new BackgroundJobManager(); });

  it('creates a running job and truncates a long title', () => {
    const long = 'x'.repeat(200);
    const job = m.create('j1', 'p1', 'c1', long, 1000);
    expect(job.status).toBe('running');
    expect(job.startedAt).toBe(1000);
    expect(job.title.length).toBeLessThanOrEqual(81);
    expect(job.title.endsWith('…')).toBe(true);
    expect(m.isRunning('j1')).toBe(true);
  });

  it('settles to done/failed/cancelled only from running (idempotent)', () => {
    m.create('j1', 'p1', 'c1', 't', 1000);
    expect(m.markDone('j1', 'answer', 1500)?.status).toBe('done');
    expect(m.get('j1')?.resultText).toBe('answer');
    expect(m.get('j1')?.finishedAt).toBe(1500);
    // second settle is a no-op
    expect(m.markFailed('j1', 'boom', 1600)).toBeUndefined();
    expect(m.get('j1')?.status).toBe('done');
    expect(m.isRunning('j1')).toBe(false);
  });

  it('tracks delegation count', () => {
    m.create('j1', 'p1', 'c1', 't', 1000);
    m.incrementDelegations('j1');
    m.incrementDelegations('j1');
    expect(m.get('j1')?.delegations).toBe(2);
  });

  it('lists per panel newest-first and filters running', () => {
    m.create('a', 'p1', 'c1', 't', 1000);
    m.create('b', 'p1', 'c1', 't', 2000);
    m.create('c', 'p2', 'c1', 't', 3000);
    m.markDone('a', 'x', 2500);
    expect(m.listForPanel('p1').map(j => j.id)).toEqual(['b', 'a']);
    expect(m.listRunning('p1').map(j => j.id)).toEqual(['b']);
    expect(m.listForPanel('p2').map(j => j.id)).toEqual(['c']);
  });

  it('cancelAllForPanel settles only running jobs on that panel', () => {
    m.create('a', 'p1', 'c1', 't', 1000);
    m.create('b', 'p1', 'c1', 't', 1000);
    m.create('c', 'p2', 'c1', 't', 1000);
    m.markDone('a', 'x', 1100);
    m.cancelAllForPanel('p1', 2000);
    expect(m.get('a')?.status).toBe('done');        // already terminal — untouched
    expect(m.get('b')?.status).toBe('cancelled');
    expect(m.get('c')?.status).toBe('running');      // other panel — untouched
  });
});

// ── Durability (Plan 17 P1.5) ──
describe('BackgroundJobManager durability', () => {
  function memento() {
    const store = new Map<string, unknown>();
    return { _store: store, get<T>(k: string): T | undefined { return store.get(k) as T | undefined; }, update(k: string, v: unknown) { store.set(k, v); } };
  }

  it('persists jobs and rehydrates a fresh manager', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000);
    a.create('j1', 'p', 'c', 'task one', 1000);
    a.markDone('j1', 'result', 1500);
    // fresh manager over the same store
    const b = new BackgroundJobManager();
    b.attachStore(mem, 2000);
    expect(b.get('j1')?.status).toBe('done');
    expect(b.get('j1')?.resultText).toBe('result');
  });

  it('marks a still-running job as interrupted on rehydrate once its heartbeat is stale', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('j2', 'p', 'c', 'task', 1000); // left running (host "crashes" — stops beating)
    // A second window attaches long after A's last heartbeat → A is presumed dead.
    const b = new BackgroundJobManager();
    b.attachStore(mem, 1000 + 200_000, 'hostB');
    expect(b.get('j2')?.status).toBe('interrupted');
    expect(b.runningCount()).toBe(0);
  });

  it('does NOT interrupt another live window\'s fresh running job on rehydrate', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('live', 'p', 'c', 'task', 1000); // hostA is alive, heartbeat fresh
    // hostB attaches only 5s later — hostA's job is still fresh → left running.
    const b = new BackgroundJobManager();
    b.attachStore(mem, 6000, 'hostB');
    expect(b.get('live')?.status).toBe('running');
  });

  it('sweep interrupts a foreign job only after it goes stale (periodic GC)', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('x', 'p', 'c', 'task', 1000);
    const b = new BackgroundJobManager();
    b.attachStore(mem, 2000, 'hostB');
    expect(b.get('x')?.status).toBe('running'); // still fresh
    b.sweep(2000 + 200_000);                     // hostA never beat again → stale
    expect(b.get('x')?.status).toBe('interrupted');
  });

  it('_persist merges — one window never clobbers another window\'s jobs', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('a1', 'p', 'c', 't', 1000);
    // hostB attaches (sees a1) and adds its own job, then persists.
    const b = new BackgroundJobManager();
    b.attachStore(mem, 1100, 'hostB');
    b.create('b1', 'p', 'c', 't', 1100);
    // hostA settling its own job must not drop hostB's b1 from the store.
    a.markDone('a1', 'r', 1200);
    const c = new BackgroundJobManager();
    c.attachStore(mem, 1300, 'hostC');
    expect(c.get('a1')?.status).toBe('done');
    expect(c.get('b1')).toBeDefined();
  });

  it('runningCount is scoped to this host — another window\'s jobs don\'t trip the cap', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('a1', 'p', 'c', 't', 1000);
    a.create('a2', 'p', 'c', 't', 1000);
    a.create('a3', 'p', 'c', 't', 1000); // hostA has 3 running
    // hostB attaches — sees hostA's fresh running jobs but owns none itself.
    const b = new BackgroundJobManager();
    b.attachStore(mem, 1100, 'hostB');
    expect(b.runningCount()).toBe(0); // not blocked by hostA's 3 jobs
    b.create('b1', 'p', 'c', 't', 1100);
    expect(b.runningCount()).toBe(1);
  });

  it('reported flag is monotonic across reload — no repeated away-notification', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('j', 'p', 'c', 't', 1000);
    a.markDone('j', 'r', 1100); // finished while its tab/window is closing
    // Reload: a new session rehydrates, is told it's unreported, notifies + marks.
    const b = new BackgroundJobManager();
    expect(b.attachStore(mem, 1200, 'hostB').map(j => j.id)).toEqual(['j']);
    b.markReported('j');
    // A THIRD session must NOT be told to re-notify (reported persisted).
    const c = new BackgroundJobManager();
    expect(c.attachStore(mem, 1300, 'hostC').map(j => j.id)).toEqual([]);
    expect(c.get('j')?.reported).toBe(true);
  });

  it('never resurrects a job another window finalized (interrupted) back to running', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('j', 'p', 'c', 't', 1000); // hostA owns j, running
    // hostB observes j after hostA stalls >stale, GC-interrupts + claims it.
    const b = new BackgroundJobManager();
    b.attachStore(mem, 1000 + 200_000, 'hostB');
    expect(b.get('j')?.status).toBe('interrupted');
    // hostA (still holding j=running in memory) persists again for an unrelated job.
    a.create('other', 'p', 'c', 't', 1000 + 201_000);
    // The store must still show j interrupted — not resurrected to running.
    const c = new BackgroundJobManager();
    c.attachStore(mem, 1000 + 202_000, 'hostC');
    expect(c.get('j')?.status).toBe('interrupted');
  });

  it('review[5]: a job THIS host is executing survives a false foreign interrupt and still records its result', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('j', 'p', 'c', 't', 1000); // hostA is ACTIVELY executing j
    // hostA stalls (machine sleep); hostB observes j stale and GC-interrupts+claims it.
    const b = new BackgroundJobManager();
    b.attachStore(mem, 1000 + 200_000, 'hostB');
    expect(b.get('j')?.status).toBe('interrupted');
    // hostA wakes and its run actually COMPLETES — the result must NOT be lost
    // (force-settle over the false interrupt), and must win on disk (done > interrupted).
    expect(a.markDone('j', 'the answer', 1000 + 201_000)?.status).toBe('done');
    const c = new BackgroundJobManager();
    c.attachStore(mem, 1000 + 202_000, 'hostC');
    expect(c.get('j')?.status).toBe('done');
    expect(c.get('j')?.resultText).toBe('the answer');
  });

  it('review[41]: _mergeJob never lets a claimed "cancelled" clobber a foreign "done" result', () => {
    // Simulate the dangerous rank-tie cell: disk has a real done (with result),
    // our in-memory copy is a cancelled claim for the same id → done must survive.
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000, 'hostA');
    a.create('j', 'p', 'c', 't', 1000);
    a.markDone('j', 'real result', 1100); // disk: done, resultText, hostA
    // hostB loads it (foreign, terminal) then persists an unrelated job — the
    // monotonic merge must preserve j's done+resultText, never downgrade it.
    const b = new BackgroundJobManager();
    b.attachStore(mem, 1200, 'hostB');
    b.create('other', 'p', 'c', 't', 1200);
    const c = new BackgroundJobManager();
    c.attachStore(mem, 1300, 'hostC');
    expect(c.get('j')?.status).toBe('done');
    expect(c.get('j')?.resultText).toBe('real result');
  });

  it('returns finished-unreported jobs on rehydrate (for the away-notification)', () => {
    const mem = memento();
    const a = new BackgroundJobManager();
    a.attachStore(mem, 1000);
    a.create('done1', 'p', 'c', 'done task', 1000); a.markDone('done1', 'r', 1100);
    a.create('fail1', 'p', 'c', 'fail task', 1000); a.markFailed('fail1', 'boom', 1100);
    a.create('done2', 'p', 'c', 'reported', 1000); a.markDone('done2', 'r', 1100); a.markReported('done2');
    const b = new BackgroundJobManager();
    const unreported = b.attachStore(mem, 2000).map(j => j.id).sort();
    expect(unreported).toEqual(['done1', 'fail1']); // done2 already reported → excluded
  });

  it('runningCount tracks active jobs for the concurrency cap', () => {
    const m = new BackgroundJobManager();
    m.create('a', 'p', 'c', 't', 1); m.create('b', 'p', 'c', 't', 1);
    expect(m.runningCount()).toBe(2);
    m.markDone('a', 'x', 2);
    expect(m.runningCount()).toBe(1);
  });
});
