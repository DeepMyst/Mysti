import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasTurnJobs, type CanvasTurnJobPorts } from '../../src/canvas/CanvasTurnJobs';
import { CanvasLiveness } from '../../src/canvas/CanvasLiveness';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import type { CanvasJobEvent } from '../../src/types';

describe('canvas chat turn jobs', () => {
  let events: CanvasJobEvent[];
  let liveness: CanvasLiveness;
  let openJob: ReturnType<typeof vi.fn<CanvasTurnJobPorts['openJob']>>;
  let cancelPanel: ReturnType<typeof vi.fn<CanvasTurnJobPorts['cancelPanel']>>;
  let turns: CanvasTurnJobs;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    liveness = new CanvasLiveness({ router: new CanvasJobRouter(event => events.push(event)) });
    openJob = vi.fn(spec => liveness.openJob(spec));
    cancelPanel = vi.fn();
    turns = new CanvasTurnJobs({ openJob, cancelPanel });
  });

  afterEach(() => {
    liveness.dispose();
    turns.dispose();
    vi.useRealTimers();
  });

  it('opens one job across multiple edits until the stream ends', () => {
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing', 'page-1');
    turns.open('chat-A', 'Editing again', 'page-2');
    expect(openJob).toHaveBeenCalledExactlyOnceWith({
      runId: 'chat-chat-A', jobId: 'canvas-turn-chat-A', label: 'Editing', pageId: 'page-1',
    });
    expect(events.map(event => event.type)).toEqual(['started']);
    turns.end('chat-A');
    turns.end('chat-A');
    expect(events.map(event => event.type)).toEqual(['started', 'done']);
    expect(liveness.jobIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create a running job for turns that never touch the canvas', () => {
    turns.begin('chat-A');
    turns.end('chat-A');
    expect(openJob).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('refuses detached writes before and after the streaming window', () => {
    turns.open('chat-A', 'Too early');
    turns.begin('chat-A');
    turns.end('chat-A');
    turns.open('chat-A', 'Too late');
    expect(openJob).not.toHaveBeenCalled();
  });

  it('waits for a canvas to exist without losing the active turn', () => {
    openJob.mockReturnValueOnce(undefined);
    turns.begin('chat-A');
    turns.open('chat-A', 'No view');
    turns.open('chat-A', 'View ready');
    expect(openJob).toHaveBeenCalledTimes(2);
    expect(events).toMatchObject([{ type: 'started', label: 'View ready' }]);
    turns.end('chat-A');
    expect(liveness.jobIds()).toEqual([]);
  });

  it('keeps concurrent panels independent when one stream fails', () => {
    turns.begin('chat-A');
    turns.begin('chat-A-other');
    turns.open('chat-A', 'First');
    turns.open('chat-A-other', 'Other');
    turns.end('chat-A', 'stream died');
    turns.end('chat-A');
    expect(events.filter(event => event.type === 'error')).toMatchObject([
      { jobId: 'canvas-turn-chat-A', error: 'stream died' },
    ]);
    expect(liveness.jobIds()).toEqual(['canvas-turn-chat-A-other']);
    turns.cancel('canvas-turn-chat-A-other');
    expect(cancelPanel).toHaveBeenCalledExactlyOnceWith('chat-A-other');
    turns.end('chat-A-other');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('routes Stop to its provider and keeps the job until its terminal event', () => {
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    turns.cancel('canvas-turn-chat-A');
    expect(cancelPanel).toHaveBeenCalledExactlyOnceWith('chat-A');
    expect(liveness.jobIds()).toEqual(['canvas-turn-chat-A']);
    turns.end('chat-A');
    turns.cancel('canvas-turn-chat-A');
    turns.cancel('unknown-job');
    expect(cancelPanel).toHaveBeenCalledTimes(1);
  });

  it('also routes a liveness-assigned job ID back to its panel', () => {
    openJob.mockImplementation(spec => liveness.openJob({ ...spec, jobId: 'assigned-id' }));
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    turns.cancel('assigned-id');
    expect(cancelPanel).toHaveBeenCalledExactlyOnceWith('chat-A');
    turns.cancel('canvas-turn-chat-A');
    expect(cancelPanel).toHaveBeenCalledTimes(1);
    turns.end('chat-A');
    turns.begin('chat-A');
    turns.open('chat-A', 'Next edit');
    turns.cancel('canvas-turn-chat-A');
    expect(cancelPanel).toHaveBeenCalledTimes(2);
  });

  it('does not emit heartbeats after a terminal event', () => {
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    vi.advanceTimersByTime(3000);
    expect(events.some(event => event.type === 'heartbeat')).toBe(true);
    turns.end('chat-A');
    const terminalCount = events.length;
    vi.advanceTimersByTime(3000);
    expect(events).toHaveLength(terminalCount);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('does not duplicate the bridge cancellation terminal event', () => {
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    turns.cancel('canvas-turn-chat-A');
    liveness.cancel('canvas-turn-chat-A');
    turns.end('chat-A');
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reopens jobs for still-streaming turns after the old canvas is disposed', () => {
    turns.begin('chat-A');
    turns.open('chat-A', 'Old canvas');
    liveness.dispose();
    turns.clearCanvas();
    turns.cancel('canvas-turn-chat-A');
    expect(cancelPanel).not.toHaveBeenCalled();
    expect(events.map(event => event.type)).toEqual(['started']);
    liveness = new CanvasLiveness({ router: new CanvasJobRouter(event => events.push(event)) });
    turns.open('chat-A', 'New canvas');
    expect(liveness.jobIds()).toEqual(['canvas-turn-chat-A']);
    turns.end('chat-A');
    expect(events.map(event => event.type)).toEqual(['started', 'started', 'done']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forgets dead-view handles before a surviving stream ends', () => {
    const done = vi.fn();
    const fail = vi.fn();
    openJob.mockReturnValue({ jobId: 'dead-view-job', done, fail });
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    turns.clearCanvas();
    turns.end('chat-A', 'late failure');
    expect(done).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])('a dead view cannot break a %s stream exit', exit => {
    const finish = vi.fn(() => { throw new Error('view disposed'); });
    openJob.mockReturnValue({ jobId: 'dead-view-job', done: finish, fail: finish });
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    expect(() => turns.end('chat-A', exit === 'failure' ? 'stream died' : undefined)).not.toThrow();
    turns.end('chat-A');
    turns.open('chat-A', 'Late write');
    turns.cancel('dead-view-job');
    expect(finish).toHaveBeenCalledOnce();
    expect(openJob).toHaveBeenCalledOnce();
    expect(cancelPanel).not.toHaveBeenCalled();
  });

  it('allows the next turn on the same panel to own a fresh job', () => {
    turns.begin('chat-A');
    turns.open('chat-A', 'First turn');
    turns.end('chat-A');
    turns.begin('chat-A');
    turns.open('chat-A', 'Next turn');
    expect(events.map(event => event.type)).toEqual(['started', 'done', 'started']);
    turns.cancel('canvas-turn-chat-A');
    expect(cancelPanel).toHaveBeenCalledExactlyOnceWith('chat-A');
  });

  it('forgets every panel and refuses new work after host disposal', () => {
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    liveness.dispose();
    turns.dispose();
    turns.begin('chat-B');
    turns.open('chat-A', 'Old turn');
    turns.open('chat-B', 'New turn');
    turns.cancel('canvas-turn-chat-A');
    turns.end('chat-A');
    expect(openJob).toHaveBeenCalledOnce();
    expect(cancelPanel).not.toHaveBeenCalled();
    expect(events.map(event => event.type)).toEqual(['started']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the opened job callback when another begin changes the panel preparation', () => {
    const old = vi.fn(); const next = vi.fn();
    turns.begin('chat-A', old, 'old'); turns.open('chat-A', 'Old');
    turns.begin('chat-A', next, 'next');
    turns.cancel('canvas-turn-chat-A-old');
    expect(old).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
    expect(cancelPanel).not.toHaveBeenCalled();
  });

  it('does not let a delayed old job cancellation reach a new turn on the same panel', () => {
    const old = vi.fn(); const next = vi.fn();
    turns.begin('chat-A', old, 'old'); turns.open('chat-A', 'Old'); turns.end('chat-A');
    turns.begin('chat-A', next, 'next'); turns.open('chat-A', 'Next');
    turns.cancel('canvas-turn-chat-A-old'); turns.cancel('canvas-turn-chat-A');
    expect(old).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    turns.cancel('canvas-turn-chat-A-next'); expect(next).toHaveBeenCalledOnce();
    expect(cancelPanel).not.toHaveBeenCalled();
  });
});
