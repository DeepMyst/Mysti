import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasArtifactSession } from '../../src/canvas/CanvasArtifactSession';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import type { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import type { CanvasArtifact } from '../../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function artifact(name: string) {
  // Creation is in-memory; storage effects are explicit mocks below.
  return new ArtifactStore().createArtifact({ name, kind: 'screens' });
}

function harness() {
  const list = vi.fn(async () => [] as Array<{ id: string }>);
  const load = vi.fn(async (_id: string): Promise<CanvasArtifact | null> => null);
  const save = vi.fn(async (_artifact: CanvasArtifact, _revision?: () => number) => {});
  const store = { list, load, save } as unknown as ArtifactStore;
  const executor = {} as CanvasOpExecutor;
  const ports = {
    createEmpty: vi.fn((name?: string) => artifact(name || 'Untitled')),
    createHistory: vi.fn((design: CanvasArtifact, captured: CanvasOpExecutor) => new CanvasHistory(design, captured, { jobId: 'fixture' })),
    render: vi.fn(), ready: vi.fn(), relink: vi.fn(async (_id: string) => {}),
    closeTransport: vi.fn(async () => {}), onError: vi.fn(),
    retainUnsaved: vi.fn(async (_design: CanvasArtifact, _cause: unknown) => {}),
  };
  const session = new CanvasArtifactSession(store, executor, ports, 'Project designs');
  return { session, store, executor, ports, list, load, save };
}

afterEach(() => { vi.useRealTimers(); });

describe('CanvasArtifactSession', () => {
  it('loads the most recent design once, using captured resources and a matching history', async () => {
    const h = harness();
    const recent = artifact('Recent');
    h.list.mockResolvedValue([{ id: recent.id }, { id: 'older' }]);
    h.load.mockResolvedValue(recent);
    await Promise.all([h.session.initialize(), h.session.initialize()]);
    expect(h.list).toHaveBeenCalledOnce();
    expect(h.load).toHaveBeenCalledExactlyOnceWith(recent.id);
    expect(h.session.snapshot?.artifact).toBe(recent);
    expect(h.ports.createHistory).toHaveBeenCalledExactlyOnceWith(recent, h.executor);
    expect(h.ports.render).toHaveBeenCalledExactlyOnceWith(h.session.snapshot);
    expect(h.ports.ready).toHaveBeenCalledExactlyOnceWith('initial');
    expect(h.ports.relink).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('creates a workspace-named empty design when none exists', async () => {
    const h = harness();
    await h.session.initialize();
    expect(h.session.snapshot?.artifact.name).toBe('Project designs');
    expect(h.ports.createEmpty).toHaveBeenCalledExactlyOnceWith('Project designs');
  });

  it('reports a corrupt initial load and leaves the saved design untouched', async () => {
    const h = harness();
    h.list.mockResolvedValue([{ id: 'corrupt-id' }]);
    h.load.mockRejectedValue(new Error('corrupt file'));
    await h.session.initialize();
    expect(h.ports.onError).toHaveBeenCalledWith('initial-load', expect.any(Error));
    expect(h.session.snapshot?.artifact.id).not.toBe('corrupt-id');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.ports.ready).toHaveBeenCalledWith('initial');
  });

  it.each(['list', 'load'] as const)('a user selection wins over a delayed initial %s', async stage => {
    const h = harness();
    const listed = deferred<Array<{ id: string }>>();
    const loaded = deferred<CanvasArtifact>();
    if (stage === 'list') { h.list.mockReturnValue(listed.promise); }
    else { h.list.mockResolvedValue([{ id: 'old' }]); h.load.mockReturnValue(loaded.promise); }
    const initial = h.session.initialize();
    await Promise.resolve();
    await h.session.select(null, 'Selected');
    const selected = h.session.snapshot;
    if (stage === 'list') { listed.resolve([{ id: 'old' }]); }
    else { loaded.resolve(artifact('Old')); }
    await initial;
    expect(h.session.snapshot).toBe(selected);
    expect(h.ports.render).toHaveBeenCalledOnce();
    expect(h.ports.ready).toHaveBeenCalledExactlyOnceWith('selection');
    if (stage === 'list') { expect(h.load).not.toHaveBeenCalled(); }
  });

  it('keeps the latest selection when an earlier requested load completes last', async () => {
    const h = harness();
    await h.session.initialize();
    const pending = deferred<CanvasArtifact>();
    h.load.mockReturnValue(pending.promise);
    const first = h.session.select('slow');
    await h.session.select(null, 'Latest');
    const latest = h.session.snapshot;
    pending.resolve(artifact('Slow'));
    await first;
    expect(h.session.snapshot).toBe(latest);
    expect(h.ports.relink).toHaveBeenCalledExactlyOnceWith(latest!.artifact.id);
  });

  it.each(['missing', 'failed'] as const)('a %s explicit cold-open choice cannot strand the initial design', async outcome => {
    const h = harness();
    const pending = deferred<CanvasArtifact>();
    const recent = artifact('Recent saved design');
    h.list.mockResolvedValue([{ id: recent.id }]);
    h.load.mockImplementation(id => id === recent.id ? pending.promise
      : outcome === 'missing' ? Promise.resolve(null) : Promise.reject(new Error('unreadable')));
    const initial = h.session.initialize();
    await Promise.resolve();
    await h.session.select('unavailable');
    pending.resolve(recent);
    await initial;
    expect(h.session.snapshot!.artifact).toBe(recent);
    expect(h.ports.render).toHaveBeenCalledOnce();
    expect(h.ports.ready).toHaveBeenCalledExactlyOnceWith('initial');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('initial loading can render a usable design while an explicit selection remains pending', async () => {
    const h = harness();
    const listing = deferred<Array<{ id: string }>>();
    const selection = deferred<CanvasArtifact>();
    const recent = artifact('Recent');
    const chosen = artifact('Chosen');
    h.list.mockReturnValue(listing.promise);
    h.load.mockImplementation(id => id === recent.id ? Promise.resolve(recent) : selection.promise);
    const initial = h.session.initialize();
    const selecting = h.session.select(chosen.id);
    listing.resolve([{ id: recent.id }]);
    await initial;
    expect(h.session.snapshot!.artifact).toBe(recent);
    selection.resolve(chosen);
    await selecting;
    expect(h.session.snapshot!.artifact).toBe(chosen);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(recent, expect.any(Function));
  });

  it('reselecting the current design preserves unsaved edits, history and its pending save', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.initialize();
    const current = h.session.snapshot!;
    current.artifact.name = 'Unsaved rename';
    h.session.scheduleSave();
    await h.session.select(current.artifact.id);
    expect(h.session.snapshot).toBe(current);
    expect(h.session.snapshot!.artifact.name).toBe('Unsaved rename');
    expect(h.load).not.toHaveBeenCalled();
    expect(h.ports.relink).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(current.artifact, expect.any(Function));
  });

  it('reselecting the current design cancels an older pending choice', async () => {
    const h = harness();
    await h.session.initialize();
    const current = h.session.snapshot!;
    const pending = deferred<CanvasArtifact>();
    h.load.mockReturnValue(pending.promise);
    const switching = h.session.select('other');
    await h.session.select(current.artifact.id);
    pending.resolve(artifact('Must not replace current'));
    await switching;
    expect(h.session.snapshot).toBe(current);
    expect(h.ports.relink).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('coalesces overlapping outgoing saves and publishes only the latest selection', async () => {
    const h = harness();
    await h.session.initialize();
    const outgoing = h.session.snapshot!.artifact;
    const pending = deferred<void>();
    h.save.mockReturnValue(pending.promise);
    const first = h.session.select(null, 'Older');
    await Promise.resolve();
    const second = h.session.select(null, 'Latest');
    expect(h.session.snapshot!.artifact).toBe(outgoing);
    pending.resolve();
    await Promise.all([first, second]);
    expect(h.session.snapshot!.artifact.name).toBe('Latest');
    expect(h.save).toHaveBeenCalledExactlyOnceWith(outgoing, expect.any(Function));
    expect(h.ports.relink).toHaveBeenCalledOnce();
  });

  it('a failed outgoing save retains edits and history until a later successful retry', async () => {
    const h = harness();
    await h.session.initialize();
    const current = h.session.snapshot!;
    current.artifact.name = 'Unsaved work';
    h.session.scheduleSave();
    h.save.mockRejectedValueOnce(new Error('disk full'));
    await h.session.select(null, 'Replacement');
    expect(h.session.snapshot).toBe(current);
    expect(h.session.snapshot!.artifact.name).toBe('Unsaved work');
    expect(h.ports.onError).toHaveBeenCalledWith('save', expect.any(Error));
    expect(h.ports.relink).not.toHaveBeenCalled();
    expect(h.ports.render).toHaveBeenCalledOnce();
    await h.session.select(null, 'Replacement');
    expect(h.session.snapshot!.artifact.name).toBe('Replacement');
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it('a real store without a workspace cannot acknowledge a switch that discards unsaved work', async () => {
    const h = harness();
    const rootless = new ArtifactStore({ getRoot: () => null });
    const session = new CanvasArtifactSession(rootless, h.executor, h.ports);
    await session.initialize();
    const current = session.snapshot!;
    current.artifact.name = 'Unsaved rootless design';
    await session.select(null, 'Replacement');
    expect(session.snapshot).toBe(current);
    expect(h.ports.onError).toHaveBeenCalledWith('save', expect.objectContaining({
      message: 'Open a workspace folder before saving Canvas designs.',
    }));
    expect(h.ports.relink).not.toHaveBeenCalled();
  });

  it.each([null, new Error('unreadable')] as const)('a failed requested load preserves design/history and scheduled save (%s)', async result => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.initialize();
    const current = h.session.snapshot;
    h.session.scheduleSave();
    if (result instanceof Error) { h.load.mockRejectedValue(result); }
    else { h.load.mockResolvedValue(null); }
    await h.session.select('missing');
    expect(h.session.snapshot).toBe(current);
    expect(h.ports.relink).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(current!.artifact, expect.any(Function));
  });

  it('revokes the previous transport even when rendering the new shell throws', async () => {
    const h = harness();
    await h.session.initialize();
    h.ports.render.mockImplementation(() => { throw new Error('render failed'); });
    await h.session.select(null, 'New');
    expect(h.ports.onError).toHaveBeenCalledWith('render', expect.any(Error));
    expect(h.ports.relink).toHaveBeenCalledExactlyOnceWith(h.session.snapshot!.artifact.id);
    expect(h.ports.ready).toHaveBeenLastCalledWith('selection');
  });

  it('does not announce a stale selection after its delayed relink finishes', async () => {
    const h = harness();
    await h.session.initialize();
    h.ports.ready.mockClear();
    const pending = deferred<void>();
    h.ports.relink.mockReturnValueOnce(pending.promise);
    const first = h.session.select(null, 'Older');
    await vi.waitFor(() => expect(h.ports.relink).toHaveBeenCalledOnce());
    await h.session.select(null, 'Latest');
    pending.resolve();
    await first;
    expect(h.ports.ready).toHaveBeenCalledExactlyOnceWith('selection');
    expect(h.session.snapshot!.artifact.name).toBe('Latest');
  });

  it('capability completion relinks the current design and cannot relink a closed view', async () => {
    const h = harness();
    await h.session.initialize();
    await h.session.select(null, 'Selected');
    h.ports.relink.mockClear();
    await h.session.refreshTransport();
    expect(h.ports.relink).toHaveBeenCalledExactlyOnceWith(h.session.snapshot!.artifact.id);
    await h.session.close();
    h.ports.relink.mockClear();
    await h.session.refreshTransport();
    expect(h.ports.relink).not.toHaveBeenCalled();
  });

  it('close during initial loading invalidates immediately and never renders or saves', async () => {
    const h = harness();
    const pending = deferred<Array<{ id: string }>>();
    h.list.mockReturnValue(pending.promise);
    const initial = h.session.initialize();
    const closing = h.session.close();
    expect(h.session.closed).toBe(true);
    expect(h.session.snapshot).toBeNull();
    expect(h.ports.closeTransport).toHaveBeenCalledOnce();
    pending.resolve([{ id: 'late' }]);
    await Promise.all([initial, closing]);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.ports.render).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    await h.session.initialize();
    await h.session.select(null);
    h.session.scheduleSave();
    expect(h.list).toHaveBeenCalledOnce();
  });

  it('close cancels the debounce and flushes the captured outgoing design exactly once', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.initialize();
    const outgoing = h.session.snapshot!.artifact;
    h.session.scheduleSave();
    h.session.scheduleSave();
    await Promise.all([h.session.close(), h.session.close()]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(outgoing, expect.any(Function));
    expect(h.ports.closeTransport).toHaveBeenCalledOnce();
  });

  it('close coalesces an in-flight switch flush and prevents its render and relink', async () => {
    const h = harness();
    await h.session.initialize();
    const outgoing = h.session.snapshot!.artifact;
    const pending = deferred<void>();
    h.save.mockReturnValue(pending.promise);
    const switching = h.session.select(null, 'Must not publish');
    await Promise.resolve();
    const closing = h.session.close();
    expect(h.session.snapshot).toBeNull();
    pending.resolve();
    await Promise.all([switching, closing]);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(outgoing, expect.any(Function));
    expect(h.ports.render).toHaveBeenCalledOnce();
    expect(h.ports.relink).not.toHaveBeenCalled();
  });

  it('the shared flush receives the latest revision while close joins its pending save', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.initialize();
    const outgoing = h.session.snapshot!.artifact;
    const pending = deferred<void>();
    h.save.mockReturnValueOnce(pending.promise);
    h.session.scheduleSave();
    await vi.advanceTimersByTimeAsync(800);
    const revision = h.save.mock.calls[0][1]!;
    expect(revision()).toBe(1);
    outgoing.name = 'Edited while saving';
    h.session.scheduleSave();
    const closing = h.session.close();
    pending.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(outgoing, expect.any(Function));
    expect(revision()).toBe(2);
  });

  it('a reopened owner cannot receive a closed owner’s late load or teardown effects', async () => {
    const old = harness();
    const pending = deferred<CanvasArtifact>();
    old.list.mockResolvedValue([{ id: 'old' }]);
    old.load.mockReturnValue(pending.promise);
    const loading = old.session.initialize();
    await Promise.resolve();
    await old.session.close();
    const current = harness();
    await current.session.initialize();
    const snapshot = current.session.snapshot;
    pending.resolve(artifact('Old'));
    await loading;
    expect(current.session.snapshot).toBe(snapshot);
    expect(old.ports.render).not.toHaveBeenCalled();
    expect(old.ports.ready).not.toHaveBeenCalled();
  });

  it('save/transport/reporting failures cannot prevent close invalidation', async () => {
    const h = harness();
    await h.session.initialize();
    h.save.mockRejectedValue(new Error('disk full'));
    h.ports.closeTransport.mockRejectedValue(new Error('close failed'));
    h.ports.onError.mockImplementation(() => { throw new Error('logger failed'); });
    await h.session.close();
    expect(h.session.snapshot).toBeNull();
    expect(h.ports.onError.mock.calls.map(call => call[0]).sort()).toEqual(['close', 'save']);
  });
});

// R8 failed-close recovery: close drops the view's only in-memory copy, so a
// failed final flush must hand unsaved edits to a recovery owner before close
// resolves, and must not claim a loss when nothing unsaved existed.
describe('CanvasArtifactSession failed-close recovery', () => {
  it('hands unsaved edits and the failure to recovery before close resolves', async () => {
    const h = harness();
    await h.session.initialize();
    const outgoing = h.session.snapshot!.artifact;
    outgoing.name = 'Unsaved at close';
    h.session.scheduleSave();
    const failure = new Error('disk full');
    h.save.mockRejectedValue(failure);
    const retained = deferred<void>();
    h.ports.retainUnsaved.mockReturnValue(retained.promise);
    let closed = false;
    const closing = h.session.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(h.ports.retainUnsaved).toHaveBeenCalledExactlyOnceWith(outgoing, failure));
    expect(outgoing.name).toBe('Unsaved at close');
    await Promise.resolve();
    expect(closed).toBe(false);
    retained.resolve();
    await closing;
    await h.session.close();
    expect(h.ports.retainUnsaved).toHaveBeenCalledOnce();
  });

  it('retains edits that arrived while an earlier save was failing', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.initialize();
    const outgoing = h.session.snapshot!.artifact;
    const pending = deferred<void>();
    h.save.mockReturnValueOnce(pending.promise);
    h.session.scheduleSave();
    await vi.advanceTimersByTimeAsync(800);
    outgoing.name = 'Edited while saving';
    h.session.scheduleSave();
    const closing = h.session.close();
    pending.reject(new Error('disk full'));
    await closing;
    expect(h.ports.retainUnsaved).toHaveBeenCalledExactlyOnceWith(outgoing, expect.any(Error));
  });

  it('does not retain a copy when the close flush succeeds or nothing unsaved remained', async () => {
    const saved = harness();
    await saved.session.initialize();
    saved.session.scheduleSave();
    await saved.session.close();
    expect(saved.ports.retainUnsaved).not.toHaveBeenCalled();

    // Loaded or empty and never edited: disk already holds everything there is.
    const untouched = harness();
    await untouched.session.initialize();
    untouched.save.mockRejectedValue(new Error('Open a workspace folder before saving Canvas designs.'));
    await untouched.session.close();
    expect(untouched.ports.onError).toHaveBeenCalledWith('save', expect.any(Error));
    expect(untouched.ports.retainUnsaved).not.toHaveBeenCalled();

    // Everything was persisted by an earlier flush; only the final one failed.
    vi.useFakeTimers();
    const persisted = harness();
    await persisted.session.initialize();
    persisted.session.scheduleSave();
    await vi.advanceTimersByTimeAsync(800);
    expect(persisted.save).toHaveBeenCalledOnce();
    persisted.save.mockRejectedValue(new Error('disk full'));
    await persisted.session.close();
    expect(persisted.ports.retainUnsaved).not.toHaveBeenCalled();
  });

  it('a failing recovery owner is reported and cannot prevent close from settling', async () => {
    const h = harness();
    await h.session.initialize();
    h.session.scheduleSave();
    h.save.mockRejectedValue(new Error('disk full'));
    h.ports.retainUnsaved.mockImplementation(() => { throw new Error('recovery failed'); });
    await h.session.close();
    expect(h.session.snapshot).toBeNull();
    expect(h.ports.onError.mock.calls.map(call => call[0]).sort()).toEqual(['close', 'save']);
  });
});

describe('CanvasArtifactSession async media scopes', () => {
  it('revokes before a target load and prevents capture against the outgoing snapshot', async () => {
    const h = harness(); await h.session.initialize();
    const scope = h.session.captureMediaScope()!;
    const loaded = deferred<CanvasArtifact>(); h.load.mockReturnValue(loaded.promise);
    const selecting = h.session.select('target');
    expect(scope.signal.aborted).toBe(true); expect(scope.isCurrent()).toBe(false);
    expect(h.session.captureMediaScope()).toBeNull();
    loaded.resolve(artifact('Target')); await selecting;
    expect(h.session.captureMediaScope()?.isCurrent()).toBe(true);
    expect(scope.isCurrent()).toBe(false);
  });

  it('revokes before outgoing persistence and denies reentrant media until selection settles', async () => {
    const h = harness(); await h.session.initialize();
    const scope = h.session.captureMediaScope()!; const saving = deferred<void>();
    h.save.mockImplementation(async () => { expect(scope.signal.aborted).toBe(true); expect(h.session.captureMediaScope()).toBeNull(); await saving.promise; });
    const selecting = h.session.select(null, 'Next');
    expect(h.session.captureMediaScope()).toBeNull(); saving.resolve(); await selecting;
    expect(h.session.captureMediaScope()?.isCurrent()).toBe(true);
  });

  it.each(['missing', 'failed'] as const)('a %s selection restores fresh admission without reviving old signals', async outcome => {
    const h = harness(); await h.session.initialize(); const snapshot = h.session.snapshot;
    const old = h.session.captureMediaScope()!;
    if (outcome === 'failed') { h.load.mockRejectedValue(new Error('inert failure')); }
    await h.session.select('unavailable');
    expect(h.session.snapshot).toBe(snapshot); expect(old.signal.aborted).toBe(true);
    expect(h.session.captureMediaScope()?.isCurrent()).toBe(true);
  });

  it('a current-design choice cancels pending selection without its late finally blocking fresh media', async () => {
    const h = harness(); await h.session.initialize(); const snapshot = h.session.snapshot!;
    const loaded = deferred<CanvasArtifact>(); h.load.mockReturnValue(loaded.promise);
    const selecting = h.session.select('other');
    await h.session.select(snapshot.artifact.id);
    const fresh = h.session.captureMediaScope()!; expect(fresh.isCurrent()).toBe(true);
    loaded.resolve(artifact('Obsolete')); await selecting;
    expect(h.session.snapshot).toBe(snapshot); expect(fresh.isCurrent()).toBe(true);
  });

  it('abort-listener selection reentrancy cannot reopen the successor admission barrier', async () => {
    const h = harness(); await h.session.initialize(); const scope = h.session.captureMediaScope()!;
    const loaded = deferred<CanvasArtifact>(); h.load.mockReturnValue(loaded.promise);
    let successor!: Promise<void>;
    scope.signal.addEventListener('abort', () => { successor = h.session.select('held-successor'); }, { once: true });
    await h.session.select(null, 'Obsolete outer');
    expect(h.session.captureMediaScope()).toBeNull();
    loaded.resolve(artifact('Actual successor')); await successor;
    expect(h.session.snapshot!.artifact.name).toBe('Actual successor');
    expect(h.session.captureMediaScope()?.isCurrent()).toBe(true);
  });

  it('close revokes synchronously before transport or save awaits and never permits capture again', async () => {
    const h = harness(); await h.session.initialize(); const scope = h.session.captureMediaScope()!;
    const transport = deferred<void>(); h.ports.closeTransport.mockReturnValue(transport.promise);
    const closing = h.session.close();
    expect(scope.signal.aborted).toBe(true); expect(scope.isCurrent()).toBe(false); expect(h.session.captureMediaScope()).toBeNull();
    transport.resolve(); await closing; expect(h.session.captureMediaScope()).toBeNull();
  });
});
