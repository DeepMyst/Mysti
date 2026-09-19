import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasToolSession, type CanvasToolView, type CoordinatorCanvasAuthority } from '../../src/canvas/CanvasToolSession';
import { CanvasArtifactSession } from '../../src/canvas/CanvasArtifactSession';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import type { LivenessJobHandle } from '../../src/canvas/CanvasLiveness';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';

const owners: CanvasArtifactSession[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); vi.restoreAllMocks(); vi.useRealTimers(); });

async function harness(ready = true) {
  const store = new ArtifactStore({ getRoot: () => null });
  vi.spyOn(store, 'list').mockResolvedValue([]);
  vi.spyOn(store, 'save').mockResolvedValue(undefined);
  const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
  const artifacts = new CanvasArtifactSession(store, executor, {
    createEmpty: () => store.createArtifact({ name: 'Captured design', kind: 'screens' }),
    createHistory: artifact => new CanvasHistory(artifact, executor, { jobId: 'fixture' }),
    render: () => {}, ready: () => {}, relink: async () => {}, closeTransport: async () => {}, onError: vi.fn(),
  });
  owners.push(artifacts);
  if (ready) { await artifacts.initialize(); }
  const controller = new AbortController(); const jobController = new AbortController();
  const job = { signal: jobController.signal, done: vi.fn(), fail: vi.fn(), cursor: vi.fn() } as unknown as LivenessJobHandle;
  const openJob = vi.fn(() => job); const noteReceipt = vi.fn();
  const publish = vi.fn(); const save = vi.spyOn(artifacts, 'scheduleSave');
  let current: CanvasToolView | null;
  const view: CanvasToolView = { artifacts, panelId: 'same-panel', originPanelId: 'chat',
    liveness: { openJob, noteReceipt }, isCurrent: () => current === view, publish };
  current = view;
  const ports = { currentView: vi.fn(() => current), openView: vi.fn(() => current),
    approvalFor: vi.fn(() => 'auto' as const), toolLabel: (name: string) => `canvas:${name}`, openMcpTurn: vi.fn() };
  const service = new CanvasToolSession(ports);
  const authority: CoordinatorCanvasAuthority = { kind: 'coordinator', panelId: 'chat', runId: 'run', jobId: 'job',
    signal: controller.signal, isCancelled: vi.fn(() => false), approvalFloor: 'auto' };
  const run = (tool: string, args: Record<string, unknown> = {}) => service.run({ kind: 'canvas', tool, args }, authority);
  return { service, ports, artifacts, view, publish, save, authority, controller, jobController, job, openJob, noteReceipt, run,
    replace: (next: CanvasToolView | null) => { current = next; } };
}

describe('CanvasToolSession', () => {
  it('uses the shared write payload and the captured publication/save/receipt/job owners', async () => {
    const h = await harness();
    const result = await h.run('add_page', { name: 'One' });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ approvalMode: 'auto' });
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(1);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(h.artifacts.snapshot);
    expect(h.save).toHaveBeenCalledOnce(); expect(h.noteReceipt).toHaveBeenCalledOnce();
    expect(h.openJob).toHaveBeenCalledOnce(); expect(h.job.done).toHaveBeenCalledOnce(); expect(h.job.fail).not.toHaveBeenCalled();
  });

  it.each(['auto', 'staged'] as const)('retains %s captured run authority when live policy becomes permissive', async floor => {
    const h = await harness(); h.authority.approvalFloor = floor;
    const result = await h.run('add_page', { name: 'One' });
    expect(result.ok).toBe(true); expect(JSON.parse(result.output).approvalMode).toBe(floor);
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(floor === 'auto' ? 1 : 0);
  });

  it('never lets captured auto authority relax the current view policy', async () => {
    const h = await harness(); h.ports.approvalFor.mockReturnValue('staged' as 'auto');
    const result = await h.run('add_page', { name: 'One' });
    expect(JSON.parse(result.output).approvalMode).toBe('staged');
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(0);
  });

  it('keeps explicit MCP and human contexts separate', async () => {
    const h = await harness(); h.ports.approvalFor.mockReturnValue('staged' as 'auto');
    expect(h.service.context({ kind: 'human' })?.approvalMode).toBe('auto');
    expect(h.ports.openMcpTurn).not.toHaveBeenCalled();
    expect(h.service.context({ kind: 'mcp' })?.approvalMode).toBe('staged');
    expect(h.ports.openMcpTurn).toHaveBeenCalledExactlyOnceWith(h.view);
  });

  it.each([undefined, null, {}, { kind: 'unknown' }])('refuses missing or invalid context authority: %j', async authority => {
    const h = await harness();
    expect(h.service.context(authority as never)).toBeNull();
    expect(h.ports.openMcpTurn).not.toHaveBeenCalled();
  });

  it('reports a malformed directive once and does not dispatch or publish it', async () => {
    const h = await harness();
    const result = await h.service.run({ kind: 'canvas', tool: 'add_page', args: {}, argsError: 'bad json' }, h.authority);
    expect(result.ok).toBe(false); expect(result.output).toContain('valid JSON');
    expect(h.job.fail).toHaveBeenCalledOnce(); expect(h.job.done).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });

  it('keeps agent undo refusal outside edit liveness', async () => {
    const h = await harness(); const result = await h.run('canvas_undo');
    expect(result.ok).toBe(false); expect(h.openJob).not.toHaveBeenCalled();
  });

  it('refuses other chats without revealing the design, while an origin-null view is usable', async () => {
    const h = await harness(); h.authority.panelId = 'other';
    const result = await h.run('open');
    expect(result.ok).toBe(false); expect(result.output).toContain('different chat');
    expect(result.output).not.toContain('Captured design');
    const humanView = { ...h.view, originPanelId: null, isCurrent: () => true }; h.replace(humanView);
    expect((await h.run('list_pages')).ok).toBe(true);
  });

  it.each(['open', 'add_page'])('pre-aborted %s does not acquire a view or create effects', async tool => {
    const h = await harness(); h.controller.abort();
    expect(await h.run(tool)).toEqual({ ok: false, output: 'Canvas tool cancelled.' });
    expect(h.ports.currentView).not.toHaveBeenCalled(); expect(h.ports.openView).not.toHaveBeenCalled();
    expect(h.openJob).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });

  it('releases an aborted readiness waiter and removes its listener and timer', async () => {
    vi.useFakeTimers(); const h = await harness(false);
    const add = vi.spyOn(h.controller.signal, 'addEventListener'); const remove = vi.spyOn(h.controller.signal, 'removeEventListener');
    const pending = h.run('open'); expect(vi.getTimerCount()).toBe(1);
    h.controller.abort(); expect((await pending).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    await h.artifacts.initialize();
    const fresh = { ...h.authority, signal: new AbortController().signal };
    expect((await h.service.run({ kind: 'canvas', tool: 'open', args: {} }, fresh)).ok).toBe(true);
  });

  it('checks callback-only generation invalidation after a readiness wait', async () => {
    vi.useFakeTimers(); const h = await harness(false); let cancelled = false; h.authority.isCancelled = () => cancelled;
    const pending = h.run('open'); cancelled = true; await h.artifacts.initialize(); await vi.advanceTimersByTimeAsync(50);
    expect((await pending).ok).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a closed or replaced same-ID owner rather than recapturing it', async () => {
    vi.useFakeTimers(); const h = await harness(false); const pending = h.run('open');
    const replacement = await harness(); replacement.artifacts.snapshot!.artifact.id = 'same-artifact';
    h.replace(replacement.view); await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ ok: false, output: expect.stringContaining('closed or changed') });
    expect(replacement.artifacts.closed).toBe(false); expect(h.ports.openView).toHaveBeenCalledOnce();
  });

  it('bounds a never-ready view and cleans its wait timer', async () => {
    vi.useFakeTimers(); const h = await harness(false); const pending = h.run('open');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ ok: false, output: expect.stringContaining('did not finish opening') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns open/focus errors as a failed tool result', async () => {
    const h = await harness(false); h.ports.openView.mockImplementation(() => { throw new Error('View creation failed'); });
    expect(await h.run('open')).toEqual({ ok: false, output: 'View creation failed' });
  });

  it('checks job cancellation before synchronous dispatch', async () => {
    const h = await harness(); h.openJob.mockImplementation(() => { h.jobController.abort(); return h.job; });
    expect((await h.run('add_page')).ok).toBe(false); expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(0);
    expect(h.job.fail).toHaveBeenCalledOnce(); expect(h.job.done).not.toHaveBeenCalled();
  });

  it('cannot publish or save into a successor substituted by an effect callback', async () => {
    const h = await harness(); const next = await harness(); h.publish.mockImplementation(() => h.replace(next.view));
    expect((await h.run('add_page')).ok).toBe(false);
    expect(h.save).not.toHaveBeenCalled(); expect(next.save).not.toHaveBeenCalled();
    expect(next.publish).not.toHaveBeenCalled(); expect(next.noteReceipt).not.toHaveBeenCalled();
    expect(h.job.fail).toHaveBeenCalledOnce(); expect(h.job.done).not.toHaveBeenCalled();
  });
});
