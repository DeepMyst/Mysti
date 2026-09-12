import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs/promises', async original => ({ ...await original<typeof import('fs/promises')>() }));
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HistoryStore, type HistoryRecord } from '../../src/services/HistoryStore';

let root: string;
let store: HistoryStore;
const record = (content: string): Omit<HistoryRecord, 'seq' | 'tokensEst'> => ({ content, ts: 1, role: 'user', kind: 'text' });
const journal = () => path.join(root, '.mysti', 'compaction', 'panel', 'history.jsonl');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-history-')); store = new HistoryStore(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('history journal persistence', () => {
  it('preserves a partial tail and keeps the next append readable after reload', async () => {
    await store.append('panel', record('first'));
    await fs.appendFile(journal(), '{"seq":2,"content":"partial');
    store = new HistoryStore(root);
    await store.append('panel', record('second'));
    const raw = await fs.readFile(journal(), 'utf8');
    expect(raw).toContain('{"seq":2,"content":"partial\n');
    const reloaded = await new HistoryStore(root).readAll('panel');
    expect(reloaded.map(r => [r.seq, r.content])).toEqual([[1, 'first'], [2, 'second']]);
  });

  it('orders clear between old and new appends without resurrecting the old conversation', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = (store as any)._doAppend.bind(store);
    vi.spyOn(store as any, '_doAppend').mockImplementationOnce(async (...args: unknown[]) => { entered(); await pending; await original(...args); });
    const old = store.append('panel', record('old'));
    await started;
    const remove = vi.spyOn(fs, 'rm');
    const clearing = store.clear('panel');
    const fresh = store.append('panel', record('fresh'));
    expect(remove).not.toHaveBeenCalled();
    release();
    await Promise.all([old, clearing, fresh]);
    expect((await store.readAll('panel')).map(r => [r.seq, r.content])).toEqual([[1, 'fresh']]);
  });

  it('serializes aliases of one journal and captures records at append time', async () => {
    const mutable = record('captured');
    const pending = store.append('', mutable);
    mutable.content = 'changed afterward';
    await Promise.all([pending, store.append('..', record('second'))]);
    expect((await store.readAll('panel')).map(r => [r.seq, r.content])).toEqual([[1, 'captured'], [2, 'second']]);
    expect((store as any)._appendChains.size).toBe(0);
  });

  it('filters invalid records, preserves bytes, and seeds sequence from the maximum valid record', async () => {
    await store.append('panel', record('first'));
    const raw = [
      { ...record('legacy'), seq: 8 },
      { ...record('lower'), seq: 3, tokensEst: 1 },
      { ...record('invalid'), seq: 9, content: { malformed: true } },
      { ...record('invalid token count'), seq: 10, tokensEst: -1 },
    ].map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(journal(), raw);
    store = new HistoryStore(root);
    await store.append('panel', record('new'));
    expect((await store.readAll('panel')).map(r => r.seq)).toEqual([8, 3, 9]);
    expect((await fs.readFile(journal(), 'utf8')).startsWith(raw)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses linked history paths without reading, deleting or changing the target', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-history-outside-'));
    try {
      const sentinel = path.join(outside, 'sentinel'); await fs.writeFile(sentinel, 'keep');
      await fs.mkdir(path.join(root, '.mysti'));
      await fs.symlink(outside, path.join(root, '.mysti', 'compaction'));
      await store.append('panel', record('must not escape'));
      await store.clear('panel');
      expect(await store.readAll('panel')).toEqual([]);
      expect(await fs.readdir(outside)).toEqual(['sentinel']);
      expect(await fs.readFile(sentinel, 'utf8')).toBe('keep');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});
