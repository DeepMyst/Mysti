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
  let onStarted: ((event: CanvasJobEvent) => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    onStarted = undefined;
    liveness = new CanvasLiveness({ router: new CanvasJobRouter(event => {
      events.push(event);
      if (event.type === 'started') { onStarted?.(event); }
    }) });
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

  it.each([undefined, 'stream failed'])('retires an opening handle when its started sink ends the turn with %s', error => {
    const cancel = vi.fn();
    onStarted = () => turns.end('chat-A', error);
    turns.begin('chat-A', cancel, 'request');
    turns.open('chat-A', 'Editing');
    turns.end('chat-A');
    turns.cancel('canvas-turn-chat-A-request');
    expect(events.map(event => event.type)).toEqual(['started', error ? 'error' : 'done']);
    if (error) { expect(events.at(-1)?.error).toBe(error); }
    expect(liveness.jobIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('routes Stop during started to the captured producer exactly once and preserves a sibling', () => {
    const cancel = vi.fn(() => turns.end('chat-A'));
    const siblingCancel = vi.fn();
    turns.begin('sibling', siblingCancel, 'other');
    turns.open('sibling', 'Other edit');
    onStarted = event => {
      turns.cancel(event.jobId);
      turns.cancel(event.jobId);
    };
    turns.begin('chat-A', cancel, 'request');
    turns.open('chat-A', 'Editing');
    expect(cancel).toHaveBeenCalledOnce();
    expect(siblingCancel).not.toHaveBeenCalled();
    expect(cancelPanel).not.toHaveBeenCalled();
    expect(events.filter(event => event.jobId === 'canvas-turn-chat-A-request').map(event => event.type))
      .toEqual(['started', 'done']);
    expect(liveness.jobIds()).toEqual(['canvas-turn-sibling-other']);
    expect(vi.getTimerCount()).toBe(1);
    turns.end('sibling');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { tagged: true, endFirst: true }, { tagged: false, endFirst: true },
    { tagged: true, endFirst: false }, { tagged: false, endFirst: false },
  ])('serializes a same-panel replacement during started (%j)', ({ tagged, endFirst }) => {
    const oldCancel = vi.fn(); const nextCancel = vi.fn();
    onStarted = () => {
      onStarted = undefined;
      if (endFirst) { turns.end('chat-A'); }
      turns.begin('chat-A', nextCancel, tagged ? 'next' : undefined);
      turns.open('chat-A', 'Successor');
    };
    turns.begin('chat-A', oldCancel, tagged ? 'old' : undefined);
    turns.open('chat-A', 'Old');
    expect(events.map(event => event.type)).toEqual(['started', 'done', 'started']);
    expect(events.at(-1)?.label).toBe('Successor');
    expect(liveness.jobIds()).toEqual([`canvas-turn-chat-A${tagged ? '-next' : ''}`]);
    expect(vi.getTimerCount()).toBe(1);
    if (tagged) { turns.cancel('canvas-turn-chat-A-old'); }
    turns.cancel(`canvas-turn-chat-A${tagged ? '-next' : ''}`);
    expect(oldCancel).not.toHaveBeenCalled();
    expect(nextCancel).toHaveBeenCalledOnce();
    turns.end('chat-A');
    expect(events.map(event => event.type)).toEqual(['started', 'done', 'started', 'done']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reopens only the new canvas when the started sink closes and reopens its view', () => {
    let oldLiveness: CanvasLiveness;
    onStarted = () => {
      onStarted = undefined;
      oldLiveness = liveness;
      liveness.dispose();
      turns.clearCanvas();
      liveness = new CanvasLiveness({ router: new CanvasJobRouter(event => events.push(event)) });
      turns.open('chat-A', 'Reopened');
    };
    turns.begin('chat-A');
    turns.open('chat-A', 'Old view');
    expect(oldLiveness!.jobIds()).toEqual([]);
    expect(liveness.jobIds()).toEqual(['canvas-turn-chat-A']);
    expect(events.map(event => event.type)).toEqual(['started', 'started']);
    expect(events.at(-1)?.label).toBe('Reopened');
    expect(vi.getTimerCount()).toBe(1);
    turns.end('chat-A');
    expect(events.map(event => event.type)).toEqual(['started', 'started', 'done']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not register a handle after disposal during its started callback', () => {
    onStarted = () => turns.dispose();
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    turns.cancel('canvas-turn-chat-A');
    turns.begin('chat-A');
    turns.open('chat-A', 'Late');
    expect(events.map(event => event.type)).toEqual(['started', 'done']);
    expect(liveness.jobIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(cancelPanel).not.toHaveBeenCalled();
  });

  it('does not recursively open the same turn from its own started callback', () => {
    onStarted = () => turns.open('chat-A', 'Reentrant');
    turns.begin('chat-A');
    turns.open('chat-A', 'Editing');
    expect(openJob).toHaveBeenCalledOnce();
    expect(events.map(event => event.type)).toEqual(['started']);
    expect(vi.getTimerCount()).toBe(1);
    turns.end('chat-A');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a failed opening reservation so a later view can acquire the job', () => {
    openJob.mockImplementationOnce(() => { throw new Error('view unavailable'); });
    turns.begin('chat-A');
    expect(() => turns.open('chat-A', 'Unavailable')).toThrow('view unavailable');
    turns.open('chat-A', 'Ready');
    expect(events).toMatchObject([{ type: 'started', label: 'Ready' }]);
    turns.end('chat-A');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the original cancellation callback if started prepares a successor before Stop', () => {
    const oldCancel = vi.fn(); const nextCancel = vi.fn();
    onStarted = event => {
      onStarted = undefined;
      turns.begin('chat-A', nextCancel, 'next');
      turns.open('chat-A', 'Successor');
      turns.cancel(event.jobId);
    };
    turns.begin('chat-A', oldCancel, 'old');
    turns.open('chat-A', 'Old');
    expect(oldCancel).toHaveBeenCalledOnce();
    expect(nextCancel).not.toHaveBeenCalled();
    expect(liveness.jobIds()).toEqual(['canvas-turn-chat-A-next']);
    turns.cancel('canvas-turn-chat-A-next');
    expect(nextCancel).toHaveBeenCalledOnce();
    turns.end('chat-A');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens the queued successor even if the old view returns no handle', () => {
    openJob.mockImplementationOnce(() => {
      turns.end('chat-A');
      turns.begin('chat-A', undefined, 'next');
      turns.open('chat-A', 'Successor');
      return undefined;
    });
    turns.begin('chat-A', undefined, 'old');
    turns.open('chat-A', 'Unavailable');
    expect(events).toMatchObject([{ type: 'started', jobId: 'canvas-turn-chat-A-next', label: 'Successor' }]);
    expect(openJob).toHaveBeenCalledTimes(2);
    turns.end('chat-A');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not replace the old opening failure with a successor terminal outcome', () => {
    onStarted = () => {
      turns.end('chat-A', 'Original stream failed');
      turns.begin('chat-A', undefined, 'next');
      turns.open('chat-A', 'Never started');
      turns.end('chat-A');
    };
    turns.begin('chat-A', undefined, 'old');
    turns.open('chat-A', 'Old');
    expect(events.map(event => event.type)).toEqual(['started', 'error']);
    expect(events.at(-1)?.error).toBe('Original stream failed');
    expect(openJob).toHaveBeenCalledOnce();
    expect(liveness.jobIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
