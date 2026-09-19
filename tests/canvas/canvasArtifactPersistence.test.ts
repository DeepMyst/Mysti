import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs/promises', async original => ({ ...await original<typeof import('fs/promises')>() }));
import * as fs from 'fs';
import * as asyncFs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasArtifactSession } from '../../src/canvas/CanvasArtifactSession';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Canvas close/reopen persistence ordering', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-canvas-order-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  function session() {
    const store = new ArtifactStore({ getRoot: () => root });
    const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
    const owner = new CanvasArtifactSession(store, executor, {
      createEmpty: name => store.createArtifact({ name: name || 'New design' }),
      createHistory: (artifact, captured) => new CanvasHistory(artifact, captured, { jobId: 'fixture' }),
      render: () => {}, ready: () => {}, relink: async () => {}, closeTransport: async () => {},
      onError: () => {},
    });
    return { owner, store };
  }

  function holdNextPrimary(id: string, writeNumber = 1) {
    const entered = deferred();
    const release = deferred();
    const target = path.join(root, '.mysti', 'canvas', id, 'artifact.json');
    const rename = asyncFs.rename;
    let writes = 0;
    vi.spyOn(asyncFs, 'rename').mockImplementation(async (from, to) => {
      if (to === target && ++writes === writeNumber) {
        entered.resolve();
        await release.promise;
      }
      return rename(from, to);
    });
    return { entered, release };
  }

  it('a reopened view cannot load and later resave the disk version preceding the closing view flush', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    artifact.name = 'Previously saved';
    await first.store.save(artifact);
    artifact.name = 'Last edit before close';
    const held = holdNextPrimary(artifact.id);
    const closing = first.owner.close();
    await held.entered.promise;
    const reopened = session();
    // The physical write is deliberately slow. A correct reader waits for it;
    // the old reader immediately consumed the previous complete disk version.
    const releaseTimer = setTimeout(held.release.resolve, 100);
    try {
      await reopened.owner.initialize();
      held.release.resolve();
      await closing;
      expect(reopened.owner.snapshot!.artifact.name).toBe('Last edit before close');
      await reopened.owner.close();
      expect((await reopened.store.load(artifact.id))!.name).toBe('Last edit before close');
    } finally {
      clearTimeout(releaseTimer);
      held.release.resolve();
      await closing;
    }
  });

  it('reopening immediately discovers a never-saved design whose close flush is still pending', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    artifact.name = 'First save on close';
    const held = holdNextPrimary(artifact.id);
    const closing = first.owner.close();
    const reopened = session();
    const releaseTimer = setTimeout(held.release.resolve, 100);
    try {
      await reopened.owner.initialize();
      held.release.resolve();
      await closing;
      expect(reopened.owner.snapshot!.artifact.id).toBe(artifact.id);
      expect(reopened.owner.snapshot!.artifact.name).toBe('First save on close');
    } finally {
      clearTimeout(releaseTimer);
      held.release.resolve();
      await closing;
    }
  });

  it('reopening waits for the last dirty revision when close joins an in-flight debounced save', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    artifact.name = 'First pending revision';
    const held = holdNextPrimary(artifact.id);
    first.owner.scheduleSave();
    await held.entered.promise;
    artifact.name = 'Final revision before close';
    first.owner.scheduleSave();
    const closing = first.owner.close();
    const reopened = session();
    const releaseTimer = setTimeout(held.release.resolve, 100);
    try {
      await reopened.owner.initialize();
      expect(reopened.owner.snapshot!.artifact.id).toBe(artifact.id);
      expect(reopened.owner.snapshot!.artifact.name).toBe('Final revision before close');
      await closing;
    } finally {
      clearTimeout(releaseTimer);
      held.release.resolve();
      await closing;
    }
  });

  it('immediate readers cannot pass between the two revisions of a closing selection flush', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    artifact.name = 'First revision';
    const held = holdNextPrimary(artifact.id, 2);
    const selecting = first.owner.select(null, 'Replacement');
    artifact.name = 'Final edit before close';
    first.owner.scheduleSave();
    const closing = first.owner.close();
    const reopened = new ArtifactStore({ getRoot: () => root });
    const reading = reopened.load(artifact.id);
    const listing = reopened.list();
    const reopenedOwner = session();
    const initializing = reopenedOwner.owner.initialize();
    await held.entered.promise;
    const releaseTimer = setTimeout(held.release.resolve, 100);
    try {
      expect((await reading)!.name).toBe('Final edit before close');
      expect((await listing)[0].name).toBe('Final edit before close');
      await initializing;
      expect(reopenedOwner.owner.snapshot!.artifact.id).toBe(artifact.id);
      expect(reopenedOwner.owner.snapshot!.artifact.name).toBe('Final edit before close');
      await Promise.all([selecting, closing]);
    } finally {
      clearTimeout(releaseTimer);
      held.release.resolve();
      await Promise.allSettled([selecting, closing, reading, listing, initializing]);
    }
  });

  it.each(['delete', 'restore'] as const)('%s cannot be overwritten by a later dirty revision of an earlier flush', async operation => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    artifact.name = 'Seed';
    await first.store.save(artifact);
    const held = holdNextPrimary(artifact.id, 2);
    artifact.name = 'First flush revision';
    const selecting = first.owner.select(null, 'Replacement');
    artifact.name = 'Final flush revision';
    first.owner.scheduleSave();
    const closing = first.owner.close();
    const second = new ArtifactStore({ getRoot: () => root });
    const changing = operation === 'delete' ? second.delete(artifact.id) : second.restoreFromBackup(artifact.id);
    const reading = second.load(artifact.id);
    await held.entered.promise;
    const releaseTimer = setTimeout(held.release.resolve, 100);
    try {
      await Promise.all([selecting, closing, changing]);
      const result = await reading;
      if (operation === 'delete') {
        expect(result).toBeNull();
        expect(fs.existsSync(first.store.artifactDir(artifact.id)!)).toBe(false);
      } else {
        expect(result!.name).toBe('First flush revision');
        const parked = JSON.parse(fs.readFileSync(path.join(first.store.artifactDir(artifact.id)!, 'artifact.json.corrupt'), 'utf8'));
        expect(parked.name).toBe('Final flush revision');
      }
    } finally {
      clearTimeout(releaseTimer);
      held.release.resolve();
      await Promise.allSettled([selecting, closing, changing, reading]);
    }
  });

  it('serializes same-path snapshots across stores using content captured at invocation', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    await first.store.save(artifact);
    const held = holdNextPrimary(artifact.id);
    artifact.name = 'First requested snapshot';
    const savingFirst = first.store.save(artifact);
    // Mutate immediately, before the queued first write reaches the filesystem.
    artifact.name = 'Second requested snapshot';
    const second = new ArtifactStore({ getRoot: () => root });
    const savingSecond = second.save(artifact);
    await held.entered.promise;
    try {
      held.release.resolve();
      await Promise.all([savingFirst, savingSecond]);
      expect((await second.load(artifact.id))!.name).toBe('Second requested snapshot');
      const backup = JSON.parse(fs.readFileSync(path.join(root, '.mysti', 'canvas', artifact.id, 'artifact.json.bak'), 'utf8'));
      expect(backup.name).toBe('First requested snapshot');
    } finally {
      held.release.resolve();
      await Promise.allSettled([savingFirst, savingSecond]);
    }
  });

  it('a blocked workspace save cannot block another workspace save, load or listing', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    const held = holdNextPrimary(artifact.id);
    const saving = first.store.save(artifact);
    await held.entered.promise;
    let gateReleased = false;
    const releaseTimer = setTimeout(() => { gateReleased = true; held.release.resolve(); }, 2000);
    try {
      const independent = new ArtifactStore({ getRoot: () => path.join(root, 'other-workspace') });
      const other = independent.createArtifact({ name: 'Independent' });
      await independent.save(other);
      expect((await independent.load(other.id))!.name).toBe('Independent');
      expect((await independent.list()).map(summary => summary.id)).toEqual([other.id]);
      expect(gateReleased, 'independent operations waited for the blocked workspace').toBe(false);
    } finally {
      clearTimeout(releaseTimer);
      held.release.resolve();
      await saving;
    }
  });

  it('a rejected save releases readers and cannot poison a later write', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    artifact.name = 'Last good version';
    await first.store.save(artifact);
    const target = path.join(root, '.mysti', 'canvas', artifact.id, 'artifact.json');
    const rename = asyncFs.rename;
    let rejected = false;
    vi.spyOn(asyncFs, 'rename').mockImplementation(async (from, to) => {
      if (to === target && !rejected) {
        rejected = true;
        throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
      }
      return rename(from, to);
    });
    artifact.name = 'Cannot save this';
    const second = new ArtifactStore({ getRoot: () => root });
    const failed = first.store.save(artifact);
    const reading = second.load(artifact.id);
    await expect(failed).rejects.toThrow('fixture disk full');
    expect((await reading)!.name).toBe('Last good version');
    expect((await second.list())[0].name).toBe('Last good version');
    artifact.name = 'Recovered';
    await second.save(artifact);
    expect((await first.store.load(artifact.id))!.name).toBe('Recovered');
  });

  it('deleting after a queued save cannot let that save recreate the design', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    await first.store.save(artifact);
    const dir = first.store.artifactDir(artifact.id)!;
    const entered = deferred();
    const release = deferred();
    const mkdir = asyncFs.mkdir;
    let held = false;
    vi.spyOn(asyncFs, 'mkdir').mockImplementation(async (target, options) => {
      if (target === dir && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return mkdir(target, options);
    });
    artifact.name = 'Pending save before delete';
    const saving = first.store.save(artifact);
    await entered.promise;
    const second = new ArtifactStore({ getRoot: () => root });
    const deleting = second.delete(artifact.id);
    const reading = second.load(artifact.id);
    const releaseTimer = setTimeout(release.resolve, 100);
    try {
      await Promise.all([saving, deleting]);
      expect(await reading).toBeNull();
      expect(fs.existsSync(dir)).toBe(false);
      expect(await second.list()).toEqual([]);
    } finally {
      clearTimeout(releaseTimer);
      release.resolve();
      await Promise.allSettled([saving, deleting, reading]);
    }
  });

  it('restoring after a queued save preserves that completed head and promotes its backup', async () => {
    const first = session();
    await first.owner.initialize();
    const artifact = first.owner.snapshot!.artifact;
    artifact.name = 'Original';
    await first.store.save(artifact);
    artifact.name = 'Version to restore';
    await first.store.save(artifact);
    const held = holdNextPrimary(artifact.id);
    artifact.name = 'Last head before restore';
    const saving = first.store.save(artifact);
    await held.entered.promise;
    const second = new ArtifactStore({ getRoot: () => root });
    const restoring = second.restoreFromBackup(artifact.id);
    const reading = second.load(artifact.id);
    const releaseTimer = setTimeout(held.release.resolve, 100);
    try {
      const [, restored] = await Promise.all([saving, restoring]);
      expect(restored!.name).toBe('Version to restore');
      expect((await reading)!.name).toBe('Version to restore');
      const parked = JSON.parse(fs.readFileSync(path.join(first.store.artifactDir(artifact.id)!, 'artifact.json.corrupt'), 'utf8'));
      expect(parked.name).toBe('Last head before restore');
      expect((await second.list())[0].name).toBe('Version to restore');
    } finally {
      clearTimeout(releaseTimer);
      held.release.resolve();
      await Promise.allSettled([saving, restoring, reading]);
    }
  });
});
