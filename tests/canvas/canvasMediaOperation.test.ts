import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanvasMediaOperation, type CanvasMediaOperationCapture } from '../../src/canvas/CanvasMediaOperation';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasCapabilityRegistry } from '../../src/managers/CanvasCapabilityRegistry';
import { CanvasMediaService, type CanvasMediaDeps, type GenerateMediaRequest } from '../../src/services/CanvasMediaService';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });
function fixture(available = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-media-operation-')); directories.push(root);
  const store = new ArtifactStore({ getRoot: () => available ? root : null });
  const artifact = store.createArtifact({ name: 'Original', kind: 'screens' });
  const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
  const ctx: CanvasToolContext = { artifact, store, executor, runId: 'mcp-original', jobId: 'original', approvalMode: 'auto' };
  const capture: CanvasMediaOperationCapture = { id: 'fixture', ctx, signal: new AbortController().signal,
    isCurrent: () => true, liveApproval: () => 'auto', publish: vi.fn() };
  const deps: CanvasMediaDeps = { store,
    registry: new CanvasCapabilityRegistry({ isHubConnected: () => true, hasLocalKey: () => false, getPreference: () => 'auto' }),
    callBrokered: vi.fn(async () => ({ base64: Buffer.from('inert-bytes').toString('base64'), mimeType: 'image/png' })),
    generateLocal: vi.fn(), fetchBytes: vi.fn(),
  };
  return { root, store, artifact, executor, ctx, capture, deps };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('Captured Canvas media operation boundary', () => {
  it('copies context, policy, ports, dependency references and generation inputs before awaits', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    const published = f.capture.publish;
    let generated: GenerateMediaRequest | undefined;
    f.deps.callBrokered = async (_kind, req) => {
      generated = req; entered.resolve(); await release.promise;
      return { base64: Buffer.from('owned').toString('base64'), mimeType: 'image/png' };
    };
    const operation = new CanvasMediaOperation(f.capture); const service = new CanvasMediaService(f.deps);
    const req: GenerateMediaRequest = { kind: 'image', prompt: 'original prompt', role: 'hero', size: { width: 10, height: 20 } };
    const pending = service.generate(operation, req); await entered.promise;
    const successor = fixture(); f.ctx.artifact = successor.artifact; f.ctx.store = successor.store;
    f.ctx.executor = successor.executor; f.ctx.runId = 'successor'; f.ctx.approvalMode = 'staged';
    f.capture.isCurrent = () => false; f.capture.publish = vi.fn(); f.deps.store = successor.store;
    req.prompt = 'changed'; req.role = 'icon'; req.size!.width = 99;
    release.resolve(); expect((await pending).ok).toBe(true);
    expect(generated).toMatchObject({ prompt: 'original prompt', role: 'hero', size: { width: 10, height: 20 } });
    expect(f.artifact.assets[0].prompt).toBe('[hero] original prompt'); expect(f.artifact.assets[0].size).toEqual({ width: 10, height: 20 });
    expect(f.artifact.opLog[0].runId).toBe('mcp-original'); expect(successor.artifact.assets).toHaveLength(0);
    expect(published).toHaveBeenCalledOnce(); expect(f.capture.publish).not.toHaveBeenCalled();
  });

  it('once invalidated, a temporarily true owner predicate cannot revive it', async () => {
    const f = fixture(); let current = true; f.capture.isCurrent = () => current;
    const operation = new CanvasMediaOperation(f.capture); current = false; expect(operation.isCurrent()).toBe(false);
    current = true; expect(operation.isCurrent()).toBe(false);
    expect(await new CanvasMediaService(f.deps).generate(operation, { kind: 'image', prompt: 'x' })).toMatchObject({ cancelled: true, committed: false });
    expect(f.deps.callBrokered).not.toHaveBeenCalled(); expect(f.artifact.opLog).toHaveLength(0);
  });

  it('a reentrant abort in an owner probe wins even when that probe returns true', async () => {
    const f = fixture(); const abort = new AbortController();
    const operation = new CanvasMediaOperation({ ...f.capture, signal: abort.signal, isCurrent: () => { abort.abort(); return true; } });
    expect(await new CanvasMediaService(f.deps).generate(operation, { kind: 'image', prompt: 'x' })).toMatchObject({ cancelled: true, committed: false });
    expect(f.deps.callBrokered).not.toHaveBeenCalled();
  });

  it('refuses an unavailable captured destination before generation', async () => {
    const f = fixture(false); const operation = new CanvasMediaOperation(f.capture);
    expect(await new CanvasMediaService(f.deps).generate(operation, { kind: 'image', prompt: 'x' })).toMatchObject({ ok: false, committed: false });
    expect(f.deps.callBrokered).not.toHaveBeenCalled();
  });

  it('refuses a service/store mismatch instead of granting it another destination', async () => {
    const f = fixture(); const successor = fixture(); const operation = new CanvasMediaOperation(f.capture);
    expect(await new CanvasMediaService(successor.deps).generate(operation, { kind: 'image', prompt: 'x' })).toMatchObject({ ok: false, committed: false });
    expect(successor.deps.callBrokered).not.toHaveBeenCalled(); expect(f.artifact.assets).toHaveLength(0);
  });

  it('a failed view notification cannot turn a durable asset into an uncommitted error', async () => {
    const f = fixture(); f.capture.publish = () => { throw new Error('inert closed sink'); };
    const result = await new CanvasMediaService(f.deps).generate(new CanvasMediaOperation(f.capture), { kind: 'image', prompt: 'x' });
    expect(result).toMatchObject({ ok: true, committed: true, persisted: true }); expect(result.error).toContain('refresh failed');
    expect((await f.store.load(f.artifact.id))!.assets).toHaveLength(1);
  });

  it('disposes listeners and its captured registry entry once without changing the durable result', async () => {
    const f = fixture(); const parent = new AbortController(); const detach = vi.spyOn(parent.signal, 'removeEventListener');
    const onDispose = vi.fn(() => { throw new Error('inert registry failure'); }); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = new CanvasMediaOperation({ ...f.capture, signals: [parent.signal], onDispose });
    expect(await new CanvasMediaService(f.deps).generate(operation, { kind: 'image', prompt: 'x' })).toMatchObject({ ok: true, persisted: true });
    operation.dispose(); expect(onDispose).toHaveBeenCalledOnce(); expect(detach).toHaveBeenCalledOnce();
    parent.abort(); expect(operation.signal.aborted).toBe(false); expect(operation.isCurrent()).toBe(false);
  });
});
