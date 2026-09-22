/** Real private filesystem, actual executor, and held owned IO; no provider/account calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ArtifactStore, type MediaAssetCommitControl, type MediaAssetDestination, type MediaAssetFileOps, type MediaAssetSubmission } from '../../src/managers/ArtifactStore';
import { CanvasOpExecutor, type CanvasApprovalMode } from '../../src/managers/CanvasOpExecutor';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import type { CanvasArtifact, CanvasAssetRecord } from '../../src/types';

type IoCall = { kind: keyof MediaAssetFileOps; file: string; to?: string };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('ArtifactStore generated media transaction', () => {
  let root: string;
  let activeRoot: string;
  let store: ArtifactStore;
  let artifact: CanvasArtifact;
  let executor: CanvasOpExecutor;
  let router: CanvasJobRouter;
  let before: ((call: IoCall) => Promise<void>) | undefined;
  let after: ((call: IoCall) => Promise<void>) | undefined;
  let tasks: Promise<unknown>[];
  let releases: (() => void)[];
  let calls: IoCall[];
  let io: MediaAssetFileOps;
  const bytes = Buffer.from('inert-generated-media');
  const metadata: Omit<CanvasAssetRecord, 'id' | 'ref' | 'ts'> = { role: 'image', prompt: 'private fixture', model: 'inert', size: { width: 10, height: 8 } };
  const track = <T>(task: Promise<T>): Promise<T> => { tasks.push(task); void task.catch(() => {}); return task; };
  const dir = (a = artifact) => path.join(root, '.mysti', 'canvas', a.id);
  const primary = (a = artifact) => path.join(dir(a), 'artifact.json');
  const read = async (a = artifact): Promise<CanvasArtifact> => JSON.parse(await fs.readFile(primary(a), 'utf8'));
  const entries = async (a = artifact) => fs.readdir(path.join(dir(a), 'assets')).catch(() => [] as string[]);
  const control = (approvalFloor: CanvasApprovalMode = 'auto', live: CanvasApprovalMode = 'auto') => {
    const abort = new AbortController();
    const value: MediaAssetCommitControl = { signal: abort.signal, approvalFloor, liveApproval: () => live, isCurrent: () => true };
    return { abort, value };
  };
  const submitter = (a = artifact): MediaAssetSubmission => ({ runId: 'captured-run', jobId: 'captured-job',
    submit: vi.fn((record, approval) => executor.submit(a, { kind: 'add_asset', runId: 'captured-run', proposedValue: record, author: 'agent' }, 'captured-job', approval)) });
  function commit(a = artifact, c = control().value, submission = submitter(a), destination = store.captureMediaDestination(a)!, body = bytes, mime = 'image/png') {
    return track(store.commitGeneratedAsset(destination, body, mime, { ...metadata, role: mime.startsWith('video/') ? 'video' : 'image' }, c, submission));
  }
  function hold(kind: IoCall['kind'], match: (call: IoCall) => boolean = () => true, position: 'before' | 'after' = 'after') {
    const entered = deferred(); const release = deferred(); let used = false;
    releases.push(release.resolve);
    const hook = async (call: IoCall) => {
      if (!used && call.kind === kind && match(call)) { used = true; entered.resolve(); await release.promise; }
    };
    if (position === 'before') { before = hook; } else { after = hook; }
    return { entered: entered.promise, release: release.resolve };
  }
  async function expectNoMedia(a = artifact) {
    expect(a.assets).toEqual([]); expect(a.opLog).toEqual([]);
    expect(await entries(a)).toEqual([]);
    expect((await read(a)).assets).toEqual([]);
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-media-transaction-'));
    activeRoot = root; tasks = []; releases = []; calls = []; before = undefined; after = undefined;
    async function run<T>(call: IoCall, work: () => Promise<T>): Promise<T> {
      calls.push(call); await before?.(call); const value = await work(); await after?.(call); return value;
    }
    io = {
      mkdir: file => run({ kind: 'mkdir', file }, async () => { await fs.mkdir(file, { recursive: true }); }),
      writeExclusive: (file, data) => run({ kind: 'writeExclusive', file }, () => fs.writeFile(file, data, { flag: 'wx', mode: 0o600 })),
      read: file => run({ kind: 'read', file }, () => fs.readFile(file)),
      rename: (file, to) => run({ kind: 'rename', file, to }, () => fs.rename(file, to)),
      removeOwnedTemp: file => run({ kind: 'removeOwnedTemp', file }, () => fs.rm(file, { force: true })),
    };
    store = new ArtifactStore({ getRoot: () => activeRoot, mediaFs: io });
    router = new CanvasJobRouter(() => {}); executor = new CanvasOpExecutor(store, router);
    artifact = store.createArtifact({ name: 'Captured design' }); await store.save(artifact);
  });
  afterEach(async () => {
    for (const release of releases) { release(); }
    await Promise.allSettled(tasks);
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each(['image/png', 'video/mp4'])('persists an active auto %s only after primary acknowledgment', async mime => {
    const held = hold('rename', call => call.to === primary());
    let settled = false; const task = commit(artifact, control().value, submitter(), undefined, bytes, mime).then(result => { settled = true; return result; });
    await held.entered; expect(settled).toBe(false); expect(artifact.assets).toHaveLength(1);
    held.release(); const result = await task; expect(result.state).toBe('durable');
    expect((await store.load(artifact.id))!.assets).toEqual(artifact.assets);
    expect(artifact.opLog[0]).toMatchObject({ kind: 'add_asset', runId: 'captured-run', status: 'applied' });
    expect(await fs.readFile(store.resolveAssetPath(artifact.assets[0].ref)!)).toEqual(bytes);
    expect(artifact.assets[0]).toMatchObject({ prompt: metadata.prompt, model: 'inert', size: metadata.size });
  });

  it.each(['image/png', 'video/mp4'])('keeps staged %s bytes and pending op durable through human accept and reject', async mime => {
    const first = await commit(artifact, control('staged').value, submitter(), undefined, bytes, mime);
    expect(first.state).toBe('durable'); expect(artifact.assets).toEqual([]);
    const loaded = (await store.load(artifact.id))!;
    expect(loaded.opLog[0].status).toBe('pending');
    const record = loaded.opLog[0].proposedValue as CanvasAssetRecord;
    expect(await fs.readFile(store.resolveAssetPath(record.ref)!)).toEqual(bytes);
    const human = new CanvasOpExecutor(store, router);
    expect(human.applyOp(loaded, loaded.opLog[0].opId, 'human')!.status).toBe('applied');
    await store.save(loaded); expect((await store.load(loaded.id))!.assets).toHaveLength(1);
    const second = await commit(loaded, control('staged').value, { runId: 'second', jobId: 'second', submit: (r, approval) => human.submit(loaded, { kind: 'add_asset', runId: 'second', proposedValue: r }, 'second', approval) }, undefined, bytes, mime);
    expect(second.state).toBe('durable'); human.rejectOp(loaded, loaded.opLog[1].opId, 'human'); await store.save(loaded);
    expect((await store.load(loaded.id))!.opLog[1].status).toBe('rejected');
    expect(await entries(loaded)).toHaveLength(1); expect(await fs.readFile(store.resolveAssetPath(record.ref)!)).toEqual(bytes);
  });

  it.each(['mkdir', 'writeExclusive', 'read'] as const)('refuses Stop after held precommit %s without final files, ops, or sibling loss', async kind => {
    // A before-read hold also covers ENOENT reads, whose after hook cannot run.
    const held = hold(kind, () => true, kind === 'read' ? 'before' : 'after');
    const c = control(); const task = commit(artifact, c.value);
    await held.entered; c.abort.abort(); held.release();
    expect(await task).toMatchObject({ state: 'refused', committed: false, reason: 'cancelled' }); await expectNoMedia();
    const sibling = store.createArtifact({ name: 'Sibling' }); await store.save(sibling);
    expect((await commit(sibling)).state).toBe('durable'); expect(sibling.assets).toHaveLength(1);
  });

  it('cancels a queued request before it starts any filesystem operation', async () => {
    const held = hold('rename', call => path.basename(call.to ?? '') !== 'artifact.json', 'before');
    const first = commit(); await held.entered;
    const c = control(); const second = commit(artifact, c.value); c.abort.abort();
    held.release(); expect((await first).state).toBe('durable');
    const writes = calls.filter(call => call.kind === 'writeExclusive').length;
    expect(await second).toMatchObject({ state: 'refused', reason: 'cancelled' });
    expect(calls.filter(call => call.kind === 'writeExclusive')).toHaveLength(writes);
    expect(artifact.opLog).toHaveLength(1); expect(await entries()).toHaveLength(1);
  });

  it.each(['asset', 'metadata'] as const)('finishes already committed %s publication after Stop and a root switch', async phase => {
    const held = hold('rename', call => phase === 'asset' ? call.to !== primary() : call.to === primary());
    const c = control(); const task = commit(artifact, c.value); await held.entered;
    c.abort.abort(); activeRoot = path.join(root, 'successor-workspace');
    held.release(); expect(await task).toMatchObject({ state: 'durable', committed: true });
    expect((await read()).assets).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(root, '.mysti', 'canvas', 'index.json'), 'utf8'))).toBeTruthy();
    await expect(fs.stat(activeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes load wait for an accepted metadata rename instead of reopening an old snapshot', async () => {
    const held = hold('rename', call => call.to === primary(), 'before'); const task = commit(); await held.entered;
    let loaded = false; const reopened = track(store.load(artifact.id).then(value => { loaded = true; return value; }));
    await Promise.resolve(); expect(loaded).toBe(false); held.release(); await task;
    expect((await reopened)!.assets).toHaveLength(1);
  });

  it.each(['before-queue', 'temp-write'] as const)('refuses a deleted incarnation at %s without resurrecting its directory', async phase => {
    const ticket = store.captureMediaDestination(artifact)!;
    if (phase === 'before-queue') {
      const deleted = track(store.delete(artifact.id)); const task = commit(artifact, control().value, submitter(), ticket);
      await deleted; expect(await task).toMatchObject({ state: 'refused', reason: 'stale' });
    } else {
      const held = hold('writeExclusive'); const task = commit(artifact, control().value, submitter(), ticket);
      await held.entered; const deleted = track(store.delete(artifact.id)); held.release();
      expect(await task).toMatchObject({ state: 'refused', reason: 'stale' }); await deleted;
    }
    expect(store.captureMediaDestination(artifact)).toBeNull(); expect(artifact.assets).toEqual([]);
    await expect(fs.stat(dir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['deleted', 'restored'] as const)('retires a committed ticket after %s and never writes it into a new incarnation', async reason => {
    const ticket = store.captureMediaDestination(artifact)!;
    const held = hold('rename', call => call.to !== primary(), 'before');
    const task = commit(artifact, control().value, submitter(), ticket); await held.entered;
    const retiring = track(reason === 'deleted' ? store.delete(artifact.id) : store.restoreFromBackup(artifact.id));
    held.release(); expect((await task).state).toBe('durable'); await retiring;
    expect(await store.retryMediaPersistence(ticket)).toMatchObject({ state: 'retired', committed: true, reason });
    expect(store.captureMediaDestination(artifact)).toBeNull();
    if (reason === 'deleted') { await expect(fs.stat(dir())).rejects.toMatchObject({ code: 'ENOENT' }); }
    else { const loaded = (await store.load(artifact.id))!; expect(loaded.assets).toEqual([]); expect(store.captureMediaDestination(loaded)).not.toBeNull(); }
  });

  it('retires an already durable ticket even after its recovery entry was removed', async () => {
    const ticket = store.captureMediaDestination(artifact)!; await commit(artifact, control().value, submitter(), ticket);
    await store.delete(artifact.id);
    expect(await store.retryMediaPersistence(ticket)).toMatchObject({ state: 'retired', reason: 'deleted' });
    await expect(fs.stat(dir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a prior equal-content asset when a later dedup read is cancelled', async () => {
    await commit(); const existing = artifact.assets[0];
    const held = hold('read'); const c = control(); const task = commit(artifact, c.value);
    await held.entered; c.abort.abort(); held.release(); expect((await task).state).toBe('refused');
    expect(artifact.assets).toEqual([existing]); expect(artifact.opLog).toHaveLength(1);
    expect(await entries()).toHaveLength(1); expect(await fs.readFile(store.resolveAssetPath(existing.ref)!)).toEqual(bytes);
  });

  it('refreshes a save queued before media installation using the same object including synchronous page edits', async () => {
    const held = hold('rename', call => call.to !== primary(), 'before'); const task = commit(); await held.entered;
    const saved = track(store.save(artifact));
    store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: '<p>Human edit</p>' }));
    held.release(); await task; await saved;
    const loaded = (await store.load(artifact.id))!;
    expect(loaded.assets).toHaveLength(1); expect(loaded.opLog).toHaveLength(1); expect(loaded.pages).toHaveLength(1);
  });

  it('repeats metadata publication if the same object changes during its rename await', async () => {
    const held = hold('rename', call => call.to === primary()); const task = commit(); await held.entered;
    artifact.name = 'Synchronous rename'; store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: '<p>Newest</p>' }));
    held.release(); await task;
    expect((await read()).name).toBe('Synchronous rename'); expect((await read()).pages).toHaveLength(1);
    expect(calls.filter(call => call.kind === 'rename' && call.to === primary())).toHaveLength(2);
  });

  it.each(['writeExclusive', 'rename'] as const)('retains an accepted operation after metadata %s failure and retries without rolling back newer edits', async kind => {
    let fail = true;
    before = async call => { if (fail && call.kind === kind && (kind === 'rename' ? call.to === primary() : call.file.startsWith(primary()))) { throw new Error('injected metadata failure'); } };
    const ticket = store.captureMediaDestination(artifact)!; const submit = submitter();
    expect(await commit(artifact, control().value, submit, ticket)).toMatchObject({ state: 'unsaved', committed: true, recoveryRetained: true });
    expect(artifact.assets).toHaveLength(1); expect((await read()).assets).toEqual([]);
    store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: '<p>Keep me</p>' })); artifact.name = 'Later human title';
    const blocked = await commit(); expect(blocked).toMatchObject({ state: 'refused', reason: 'unavailable' });
    fail = false; expect((await store.retryMediaPersistence(ticket)).state).toBe('durable');
    expect(submit.submit).toHaveBeenCalledTimes(1); const loaded = (await store.load(artifact.id))!;
    expect(loaded.opLog).toHaveLength(1); expect(loaded.assets).toHaveLength(1); expect(loaded.pages).toHaveLength(1); expect(loaded.name).toBe('Later human title');
    expect((await fs.readdir(dir())).some(file => file.endsWith('.tmp'))).toBe(false);
  });

  it('lets save finish the exact unresolved media operation before saving its own snapshot', async () => {
    let fail = true; before = async call => { if (fail && call.kind === 'rename' && call.to === primary()) { throw new Error('save refused'); } };
    const submit = submitter(); expect((await commit(artifact, control().value, submit)).state).toBe('unsaved');
    fail = false; artifact.name = 'Saved recovery'; await store.save(artifact);
    expect((await read()).assets).toHaveLength(1); expect((await read()).name).toBe('Saved recovery'); expect(submit.submit).toHaveBeenCalledTimes(1);
  });

  it('retains bytes after failed promotion and submits only once after recovery', async () => {
    let fail = true; before = async call => { if (fail && call.kind === 'rename' && call.to !== primary()) { throw new Error('promotion failed'); } };
    const ticket = store.captureMediaDestination(artifact)!; const submit = submitter();
    expect(await commit(artifact, control().value, submit, ticket)).toMatchObject({ state: 'unsaved', committed: true });
    expect(artifact.opLog).toEqual([]); expect(artifact.assets).toEqual([]); expect(submit.submit).not.toHaveBeenCalled();
    expect((await entries()).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
    fail = false; expect((await store.retryMediaPersistence(ticket)).state).toBe('durable');
    expect(submit.submit).toHaveBeenCalledTimes(1); expect(await entries()).toHaveLength(1);
  });

  it.each(['staged', 'auto'] as const)('recognizes its accepted %s op if the real router throws after append', async approval => {
    router.setSink(() => { throw new Error('injected synchronous view callback'); });
    const ticket = store.captureMediaDestination(artifact)!; const submit = submitter();
    expect(await commit(artifact, control(approval).value, submit, ticket)).toMatchObject({ state: 'durable', committed: true, approval });
    expect(artifact.opLog).toHaveLength(1); expect((await read()).opLog[0].status).toBe(approval === 'auto' ? 'applied' : 'pending');
    expect(await entries()).toHaveLength(1); await store.retryMediaPersistence(ticket); expect(submit.submit).toHaveBeenCalledTimes(1);
  });

  it('does not adopt an unrelated op or blindly resubmit when submission throws without its asset', async () => {
    const ticket = store.captureMediaDestination(artifact)!;
    const submission: MediaAssetSubmission = { runId: 'run', jobId: 'job', submit: vi.fn(() => {
      executor.submit(artifact, { kind: 'add_asset', runId: 'other', proposedValue: { ...metadata, id: 'unrelated', ref: 'asset://unrelated/assets/x.png', ts: 1 } }, 'other', 'staged');
      throw new Error('unrelated notification');
    }) };
    expect((await commit(artifact, control().value, submission, ticket)).state).toBe('unsaved');
    expect((await store.retryMediaPersistence(ticket)).state).toBe('unsaved');
    expect(submission.submit).toHaveBeenCalledTimes(1); expect(artifact.opLog).toHaveLength(1); expect((artifact.opLog[0].proposedValue as CanvasAssetRecord).id).toBe('unrelated');
  });

  it.each(['refused', 'durable'] as const)('retains only its failed temp cleanup descriptor after a %s result', async state => {
    if (state === 'durable') { await commit(); }
    let fail = true; before = async call => { if (fail && call.kind === 'removeOwnedTemp') { throw new Error('cleanup locked'); } };
    const ticket = store.captureMediaDestination(artifact)!; const c = control();
    if (state === 'refused') { const original = before; before = async call => { await original?.(call); if (call.kind === 'read') { c.abort.abort(); } }; }
    const result = await commit(artifact, c.value, submitter(), ticket); expect(result).toMatchObject({ state, cleanupIncomplete: true });
    const files = await entries(); expect(files.filter(name => name.endsWith('.tmp'))).toHaveLength(1);
    fail = false; expect(await store.retryMediaPersistence(ticket)).not.toHaveProperty('cleanupIncomplete', true);
    expect((await entries()).some(name => name.endsWith('.tmp'))).toBe(false);
    expect((await entries()).length).toBe(state === 'durable' ? 1 : 0);
    expect(calls.filter(call => call.kind === 'removeOwnedTemp').every(call => call.file.endsWith('.tmp'))).toBe(true);
  });

  it.each(['before-start', 'held-write'] as const)('refuses a root redirect at %s before logical commit', async phase => {
    const ticket = store.captureMediaDestination(artifact)!;
    let task: ReturnType<typeof commit>;
    if (phase === 'before-start') { activeRoot = path.join(root, 'other'); task = commit(artifact, control().value, submitter(), ticket); }
    else { const held = hold('writeExclusive'); task = commit(artifact, control().value, submitter(), ticket); await held.entered; activeRoot = path.join(root, 'other'); held.release(); }
    expect(await task).toMatchObject({ state: 'refused', reason: 'stale' }); await expectNoMedia();
    await expect(fs.stat(activeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['owner-stop', 'policy-delete'] as const)('rechecks non-callback authority after synchronous %s invalidation', async action => {
    const c = control(); let deleted: Promise<void> | undefined;
    if (action === 'owner-stop') { c.value.isCurrent = () => { c.abort.abort(); return true; }; }
    else { c.value.liveApproval = () => { deleted = track(store.delete(artifact.id)); return 'auto'; }; }
    expect((await commit(artifact, c.value)).state).toBe('refused'); if (deleted) { await deleted; }
    expect(artifact.opLog).toEqual([]); expect(artifact.assets).toEqual([]);
  });

  it.each([['staged', 'auto'], ['auto', 'staged']] as const)('preserves captured %s and live %s approval as staged', async (floor, live) => {
    expect(await commit(artifact, control(floor, live).value)).toMatchObject({ state: 'durable', approval: 'staged' });
    expect(artifact.assets).toEqual([]); expect((await read()).opLog[0].status).toBe('pending');
  });

  it('snapshots bytes, metadata and callback ports before queue waits and prevents identity injection', async () => {
    const held = hold('mkdir'); const ticket = store.captureMediaDestination(artifact)!;
    const data = Buffer.from(bytes); const meta = { ...metadata, size: { width: 3, height: 4 }, id: '../foreign', ref: 'file:///escape', ts: -1 };
    const c = control(); const submit = submitter(); const original = submit.submit;
    const task = track(store.commitGeneratedAsset(ticket, data, 'image/png', meta, c.value, submit)); await held.entered;
    data.fill(0); meta.size.width = 999; submit.submit = () => { throw new Error('rebound'); }; c.value.isCurrent = () => false;
    held.release(); const result = await task; expect(result.state).toBe('durable');
    expect(original).toHaveBeenCalledTimes(1); expect(artifact.assets[0].id).not.toBe('../foreign'); expect(artifact.assets[0].size!.width).toBe(3);
    expect(artifact.assets[0].ts).toBeGreaterThan(0); expect(await fs.readFile(store.resolveAssetPath(artifact.assets[0].ref)!)).toEqual(bytes);
    expect(await commit(artifact, control().value, submitter(), { ...ticket } as MediaAssetDestination)).toMatchObject({ state: 'refused', reason: 'invalid' });
  });

  it('rejects invalid destination identifiers and foreign store tickets without filesystem effects', async () => {
    const ticket = store.captureMediaDestination(artifact)!;
    const foreign = new ArtifactStore({ getRoot: () => root });
    expect(await foreign.commitGeneratedAsset(ticket, bytes, 'image/png', metadata, control().value, submitter())).toMatchObject({ state: 'refused', reason: 'invalid' });
    artifact.id = '../escape'; expect(store.captureMediaDestination(artifact)).toBeNull();
    expect(await commit(artifact, control().value, submitter(), ticket)).toMatchObject({ state: 'refused', reason: 'stale' });
    expect(calls).toEqual([]);
  });
});
