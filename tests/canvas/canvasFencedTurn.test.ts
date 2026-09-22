import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasFencedTurn, type CanvasFencedTurnPorts } from '../../src/canvas/CanvasFencedTurn';
import { CanvasArtifactSession } from '../../src/canvas/CanvasArtifactSession';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import type { CanvasToolView } from '../../src/canvas/CanvasToolSession';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasOpExecutor, type CanvasApprovalMode } from '../../src/managers/CanvasOpExecutor';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import type { CanvasArtifact } from '../../src/types';

const sessions: CanvasArtifactSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  vi.restoreAllMocks(); vi.useRealTimers();
});

const block = (nonce: unknown, title = 'Captured edit') => '```canvas-op\n' + JSON.stringify({ nonce,
  kind: 'insert_page', proposedValue: { mode: 'jsx', jsxSource: 'function Page(){ return <UI.Screen />; }', actionTitle: title },
}) + '\n```\n';
const promptNonce = (turn: CanvasFencedTurn): string => {
  const nonce = /Every block MUST carry "nonce":"([a-f0-9]+)"/.exec(turn.prompt())?.[1];
  expect(nonce).toMatch(/^[a-f0-9]{16}$/); return nonce!;
};

async function harness(originPanelId: string | null = 'chat') {
  const store = new ArtifactStore({ getRoot: () => null });
  vi.spyOn(store, 'list').mockResolvedValue([]);
  const saved: CanvasArtifact[] = [];
  vi.spyOn(store, 'save').mockImplementation(async artifact => { saved.push(JSON.parse(JSON.stringify(artifact))); });
  const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
  const artifacts = new CanvasArtifactSession(store, executor, {
    createEmpty: () => store.createArtifact({ name: 'Original design', kind: 'screens' }),
    createHistory: artifact => new CanvasHistory(artifact, executor, { jobId: 'fixture' }),
    render: () => {}, ready: () => {}, relink: async () => {}, closeTransport: async () => {}, onError: vi.fn(),
  });
  sessions.push(artifacts); await artifacts.initialize();
  let current: CanvasToolView;
  const view: CanvasToolView = { artifacts, panelId: 'canvas', originPanelId,
    isCurrent: () => current === view, publish: vi.fn() };
  current = view;
  let liveMode: CanvasApprovalMode = 'auto';
  const liveApproval = vi.fn(() => liveMode);
  const create = (floor: CanvasApprovalMode = 'auto', panelId = 'chat', requestId = 'request-A') => {
    const request = { current: true };
    const snapshot = artifacts.snapshot!;
    const ports = {
      openEdit: vi.fn(), problem: vi.fn(), publish: vi.fn(),
      save: vi.fn(() => artifacts.scheduleSave()),
      submit: vi.fn<CanvasFencedTurnPorts['submit']>((op, approval) => executor.submit(snapshot.artifact,
        { ...op, runId: panelId, author: 'agent' }, 'chat-' + panelId, approval)),
    };
    const capture = { view, snapshot, panelId, requestId, approvalFloor: floor,
      requestIsCurrent: () => request.current, liveApproval };
    const turn = new CanvasFencedTurn(capture, ports);
    return { turn, ports, capture, request };
  };
  return { store, executor, artifacts, saved, view, liveApproval, create,
    narrow: () => { liveMode = 'staged'; }, replace: () => { current = { ...view }; }, restore: () => { current = view; } };
}

describe('CanvasFencedTurn', () => {
  it('uses the emitted prompt nonce, real executor, and captured publication and save ports', async () => {
    const h = await harness(); const t = h.create();
    t.turn.push(block(promptNonce(t.turn)));
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(1);
    expect(t.ports.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'insert_page' }), 'auto');
    expect(t.ports.publish).toHaveBeenCalledOnce(); expect(t.ports.save).toHaveBeenCalledOnce();
    expect(h.artifacts.snapshot!.artifact.opLog[0]).not.toHaveProperty('nonce');
  });

  it('keeps prompt contents fixed when the same mutable design changes later', async () => {
    const h = await harness(); const t = h.create(); const prompt = t.turn.prompt();
    h.artifacts.snapshot!.artifact.name = 'A later name';
    expect(prompt).toContain('Original design'); expect(t.turn.prompt()).toBe(prompt);
  });

  it.each(['auto', 'staged'] as const)('preserves captured %s authority and announces the same floor in its prompt', async floor => {
    const h = await harness(); const t = h.create(floor);
    expect(t.turn.prompt()).toContain('Approval mode: ' + floor.toUpperCase());
    t.capture.approvalFloor = 'auto';
    t.turn.push(block(promptNonce(t.turn)));
    expect(t.ports.submit.mock.calls[0][1]).toBe(floor);
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(floor === 'auto' ? 1 : 0);
  });

  it('publishes and persists a current staged suggestion without applying it', async () => {
    vi.useFakeTimers(); const h = await harness(); const t = h.create('staged');
    t.turn.push(block(promptNonce(t.turn))); await vi.advanceTimersByTimeAsync(801);
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(0);
    expect(t.ports.publish).toHaveBeenCalledOnce(); expect(t.ports.save).toHaveBeenCalledOnce();
    expect(h.saved).toHaveLength(1); expect(h.saved[0].opLog).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('reads a live narrowing after opening the liveness job', async () => {
    const h = await harness(); const t = h.create(); const nonce = promptNonce(t.turn);
    t.ports.openEdit.mockImplementation(() => h.narrow()); t.turn.push(block(nonce));
    expect(t.ports.submit.mock.calls[0][1]).toBe('staged');
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(0);
  });

  it.each([undefined, null, 42, {}, 'wrong'])('refuses nonce %j even when the real token is inside the proposed value', async nonce => {
    const h = await harness(); const t = h.create(); t.turn.push(block(nonce, promptNonce(t.turn)));
    expect(t.ports.problem).toHaveBeenCalledOnce(); expect(t.ports.openEdit).not.toHaveBeenCalled();
    expect(t.ports.submit).not.toHaveBeenCalled(); expect(h.artifacts.snapshot!.artifact.opLog).toHaveLength(0);
  });

  it('reports malformed JSON and still accepts the following valid block', async () => {
    const h = await harness(); const t = h.create();
    t.turn.push('```canvas-op\n{bad}\n```\n' + block(promptNonce(t.turn)));
    expect(t.ports.problem).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(1);
  });

  it('keeps two current unbound panel parsers independent across interleaved partial chunks', async () => {
    const h = await harness(null); const a = h.create('auto', 'A'); const b = h.create('auto', 'B', 'request-B');
    const first = block(promptNonce(a.turn), 'First'), second = block(promptNonce(b.turn), 'Second');
    const split = first.indexOf('proposedValue');
    a.turn.push(first.slice(0, split)); b.turn.push(second); a.turn.push(first.slice(split));
    expect(a.ports.problem).not.toHaveBeenCalled(); expect(b.ports.problem).not.toHaveBeenCalled();
    expect(h.artifacts.snapshot!.artifact.opLog.map(op => op.runId)).toEqual(['B', 'A']);
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(2);
  });

  it('retiring one parser cannot erase a sibling partial block or revive its own', async () => {
    const h = await harness(null); const a = h.create('auto', 'A'); const b = h.create('auto', 'B');
    const first = block(promptNonce(a.turn)), second = block(promptNonce(b.turn)); const split = 40;
    a.turn.push(first.slice(0, split)); b.turn.push(second.slice(0, split));
    a.turn.retire(); a.turn.push(first.slice(split)); b.turn.push(second.slice(split));
    expect(a.ports.submit).not.toHaveBeenCalled(); expect(b.ports.submit).toHaveBeenCalledOnce();
    expect(a.turn.prompt()).toBe('');
  });

  it('refuses a panel other than the captured bound origin before revealing a prompt', async () => {
    const h = await harness(); const t = h.create('auto', 'other');
    expect(t.turn.prompt()).toBe(''); t.turn.push(block(t.turn.nonce));
    expect(t.ports.submit).not.toHaveBeenCalled(); expect(t.ports.problem).not.toHaveBeenCalled();
  });

  it('retires permanently when a request stops, even if a transient flag is later cleared', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    t.request.current = false; t.turn.push(text); t.request.current = true; t.turn.push(text);
    expect(t.ports.submit).not.toHaveBeenCalled(); expect(t.turn.prompt()).toBe('');
  });

  it('cannot regain authority after a same-ID view replacement is restored', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    h.replace(); t.turn.push(text); h.restore(); t.turn.push(text);
    expect(t.ports.submit).not.toHaveBeenCalled(); expect(t.ports.problem).not.toHaveBeenCalled();
  });

  it('rejects A to B to A selection even when the original artifact object is reused', async () => {
    const h = await harness(); const t = h.create(); const original = h.artifacts.snapshot!.artifact;
    const next = h.store.createArtifact({ name: 'Next', kind: 'screens' }); const text = block(promptNonce(t.turn));
    vi.spyOn(h.store, 'load').mockImplementation(async id => id === original.id ? original : next);
    await h.artifacts.select(next.id); await h.artifacts.select(original.id);
    expect(h.artifacts.snapshot!.artifact).toBe(original);
    t.turn.push(text); expect(t.ports.submit).not.toHaveBeenCalled(); expect(original.pages).toHaveLength(0);
  });

  it('rejects a closed artifact session even if its view callback still returns current', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    await h.artifacts.close(); t.turn.push(text);
    expect(t.ports.submit).not.toHaveBeenCalled(); expect(t.ports.problem).not.toHaveBeenCalled();
  });

  it('checks view ownership again after a liveness callback', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    t.ports.openEdit.mockImplementation(() => h.replace()); t.turn.push(text);
    expect(t.ports.submit).not.toHaveBeenCalled(); expect(t.ports.save).not.toHaveBeenCalled();
  });

  it('checks ownership again after a live-policy callback', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    h.liveApproval.mockImplementation(() => { h.replace(); return 'auto'; }); t.turn.push(text);
    expect(t.ports.submit).not.toHaveBeenCalled(); expect(t.ports.save).not.toHaveBeenCalled();
  });

  it('does not execute another buffered operation after submission invalidates its request', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    const submit = t.ports.submit.getMockImplementation()!;
    t.ports.submit.mockImplementation((op, approval) => { const result = submit(op, approval); t.request.current = false; return result; });
    t.turn.push(text + text);
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(1); expect(t.ports.submit).toHaveBeenCalledOnce();
    expect(t.ports.publish).not.toHaveBeenCalled(); expect(t.ports.save).not.toHaveBeenCalled();
  });

  it('does not save through a publication callback that invalidates the captured view', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    t.ports.publish.mockImplementation(() => h.replace()); t.turn.push(text);
    expect(t.ports.submit).toHaveBeenCalledOnce(); expect(t.ports.save).not.toHaveBeenCalled();
  });

  it('keeps the captured ports when their caller replaces the ports object fields', async () => {
    const h = await harness(); const t = h.create(); const text = block(promptNonce(t.turn));
    const capturedSubmit = t.ports.submit; t.ports.submit = vi.fn(); t.turn.push(text);
    expect(capturedSubmit).toHaveBeenCalledOnce(); expect(t.ports.submit).not.toHaveBeenCalled();
    expect(h.artifacts.snapshot!.artifact.pages).toHaveLength(1);
  });
});
