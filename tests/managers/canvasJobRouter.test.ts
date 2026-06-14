/**
 * CanvasJobRouter tests — jobId minting/echo, AbortController per job, the
 * pipe() terminal-event guarantee (fixes the F-4 leaked-spinner class), and
 * cancellation stopping a running pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import type { CanvasJobEvent } from '../../src/types';
import type { CanvasJobEventBody } from '../../src/managers/CanvasJobRouter';

describe('CanvasJobRouter', () => {
  let events: CanvasJobEvent[];
  let router: CanvasJobRouter;

  beforeEach(() => {
    events = [];
    router = new CanvasJobRouter(e => events.push(e));
  });

  async function* gen(...bodies: CanvasJobEventBody[]): AsyncGenerator<CanvasJobEventBody> {
    for (const b of bodies) { yield b; }
  }

  it('mints a unique jobId and echoes an existing one', () => {
    const a = router.create('first');
    const b = router.create('second');
    expect(a.jobId).not.toBe(b.jobId);
    const echoed = router.create('again', a.jobId);
    expect(echoed.jobId).toBe(a.jobId); // same id → same job object
    expect(router.activeCount()).toBe(2);
  });

  it('stamps jobId onto emitted event bodies', () => {
    const job = router.create();
    router.emit(job.jobId, { type: 'progress', progress: 0.5 });
    expect(events).toEqual([{ jobId: job.jobId, type: 'progress', progress: 0.5 }]);
  });

  it('pipe() forwards events and appends a terminal done when missing', async () => {
    const job = router.create();
    await router.pipe(job.jobId, gen(
      { type: 'started', label: 'Generate' },
      { type: 'progress', progress: 0.5 },
    ));
    expect(events.map(e => e.type)).toEqual(['started', 'progress', 'done']);
    expect(router.has(job.jobId)).toBe(false); // job cleaned up
  });

  it('pipe() does not double-emit done when the source already ends with one', async () => {
    const job = router.create();
    await router.pipe(job.jobId, gen(
      { type: 'started' },
      { type: 'done', result: { ok: true } },
    ));
    expect(events.map(e => e.type)).toEqual(['started', 'done']);
    expect(events[1].result).toEqual({ ok: true });
  });

  it('pipe() converts a thrown error into a single error event', async () => {
    const job = router.create();
    async function* boom(): AsyncGenerator<CanvasJobEventBody> {
      yield { type: 'started' };
      throw new Error('pipeline blew up');
    }
    await router.pipe(job.jobId, boom());
    expect(events.map(e => e.type)).toEqual(['started', 'error']);
    expect(events[1].error).toBe('pipeline blew up');
  });

  it('cancel() aborts the signal and emits a single cancelled done', async () => {
    const job = router.create();
    expect(job.controller.signal.aborted).toBe(false);
    const cancelled = router.cancel(job.jobId);
    expect(cancelled).toBe(true);
    expect(job.controller.signal.aborted).toBe(true);
    expect(events).toEqual([{ jobId: job.jobId, type: 'done', result: { cancelled: true } }]);
    expect(router.cancel(job.jobId)).toBe(false); // already gone
  });

  it('a cancelled job stops pipe() mid-stream with no further events', async () => {
    const job = router.create();
    let yielded = 0;
    async function* slow(): AsyncGenerator<CanvasJobEventBody> {
      yield { type: 'started' };
      yielded++;
      router.cancel(job.jobId); // cancel arrives between events
      yield { type: 'progress', progress: 1 };
      yielded++;
    }
    await router.pipe(job.jobId, slow());
    // started forwarded, then cancel's terminal done; the post-cancel progress
    // event is suppressed by the abort check.
    expect(events.map(e => e.type)).toEqual(['started', 'done']);
    expect(events.find(e => e.type === 'progress')).toBeUndefined();
  });
});
