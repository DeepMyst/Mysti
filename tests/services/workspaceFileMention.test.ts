import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceFileMention } from '../../src/services/WorkspaceFileMention';

const realOpen = fs.promises.open.bind(fs.promises);
const realRealpath = fs.promises.realpath.bind(fs.promises);
const realLstat = fs.promises.lstat.bind(fs.promises);
const INSIDE = 'const selected = "IN_WORKSPACE_雪_🙂";\n';
const OUTSIDE = 'OUTSIDE_BYTES_MUST_NOT_BE_READ';
let base: string, firstRoot: string, secondRoot: string, outside: string, first: string, second: string, secret: string;
let handles: Array<{ path: string; handle: FileHandle; reads: number; closes: number }>;
let afterOpen: (file: string) => Promise<void>;
let beforeStat: () => Promise<void>;
let beforeRead: () => Promise<void>;
let afterClose: () => Promise<void>;
let substituteOpen: string | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function link(target: string, name: string) { fs.symlinkSync(target, name); return name; }
function retarget(name: string, target: string) { fs.unlinkSync(name); fs.symlinkSync(target, name); }
function reads() { return handles.reduce((total, item) => total + item.reads, 0); }

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-mention-containment-')));
  firstRoot = path.join(base, 'first'); secondRoot = path.join(base, 'second'); outside = path.join(base, 'outside');
  for (const root of [firstRoot, secondRoot, outside]) { fs.mkdirSync(root); }
  first = path.join(firstRoot, 'file.ts'); second = path.join(secondRoot, 'file.ts'); secret = path.join(outside, 'file.ts');
  fs.writeFileSync(first, INSIDE); fs.writeFileSync(second, 'SECOND_ROOT_BYTES'); fs.writeFileSync(secret, OUTSIDE);
  handles = []; substituteOpen = undefined;
  afterOpen = async () => undefined; beforeStat = async () => undefined;
  beforeRead = async () => undefined; afterClose = async () => undefined;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(substituteOpen ?? args[0], args[1], args[2]);
    const record = { path: String(args[0]), handle, reads: 0, closes: 0 }; handles.push(record);
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle);
    let firstRead = true;
    vi.spyOn(handle, 'stat').mockImplementation(async (...options) => { await beforeStat(); return stat(...options); });
    vi.spyOn(handle, 'read').mockImplementation(async (...options) => {
      // Retarget/hold the first actual I/O only; the later EOF read stays real.
      if (firstRead) { firstRead = false; await beforeRead(); }
      const result = await read(...options);
      if (result.bytesRead > 0) { record.reads++; }
      return result;
    });
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); record.closes++; await afterClose(); });
    await afterOpen(String(args[0]));
    return handle;
  });
});

afterEach(async () => {
  try {
    for (const record of handles) {
      expect(record.closes, 'every acquired handle must be closed exactly once').toBe(1);
      await expect(record.handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    }
  } finally {
    vi.restoreAllMocks();
    for (const record of handles) { await record.handle.close().catch(() => undefined); }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

describe('workspace file mention physical admission', () => {
  it('reads exact UTF-8 bytes through one read-only handle and preserves selected spelling', async () => {
    const selected = `${firstRoot}/./file.ts`;
    expect(await readWorkspaceFileMention(selected, [firstRoot])).toEqual({ path: selected, content: INSIDE });
    expect(handles.map(item => item.path)).toEqual([first]); expect(reads()).toBe(1);
    expect(fs.promises.open).toHaveBeenCalledWith(first,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  });
  it('keeps relative names mapped to the first root', async () => {
    expect(await readWorkspaceFileMention('file.ts', [firstRoot, secondRoot])).toEqual({ path: first, content: INSIDE });
  });
  it('accepts an absolute file in another declared root', async () => {
    expect(await readWorkspaceFileMention(second, [firstRoot, secondRoot])).toEqual({ path: second, content: 'SECOND_ROOT_BYTES' });
  });
  it('does not let an unavailable root prevent admission by another declared root', async () => {
    expect(await readWorkspaceFileMention(second, [path.join(base, 'missing'), secondRoot])).toEqual({ path: second, content: 'SECOND_ROOT_BYTES' });
  });
  it('preserves an in-root file symlink as its lexical label', async () => {
    const selected = link(first, path.join(firstRoot, 'alias.js'));
    expect(await readWorkspaceFileMention(selected, [firstRoot])).toEqual({ path: selected, content: INSIDE });
    expect(handles[0].path).toBe(first);
  });
  it('accepts an in-root directory symlink', async () => {
    const dir = path.join(firstRoot, 'dir'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'file.ts'), INSIDE);
    const selected = path.join(link(dir, path.join(firstRoot, 'alias')), 'file.ts');
    expect(await readWorkspaceFileMention(selected, [firstRoot])).toEqual({ path: selected, content: INSIDE });
  });
  it('accepts a symlinked workspace root', async () => {
    const alias = link(firstRoot, path.join(base, 'root-alias'));
    const selected = path.join(alias, 'file.ts');
    expect(await readWorkspaceFileMention(selected, [alias])).toEqual({ path: selected, content: INSIDE });
  });
  it('allows a link into another declared workspace root', async () => {
    const selected = link(second, path.join(firstRoot, 'cross-root.ts'));
    expect(await readWorkspaceFileMention(selected, [firstRoot, secondRoot])).toEqual({ path: selected, content: 'SECOND_ROOT_BYTES' });
  });
  for (const kind of ['absolute outside', 'relative traversal', 'prefix sibling', 'outside file symlink', 'outside directory symlink', 'directory', 'missing', 'no workspace'] as const) {
    it(`rejects ${kind} without a content read`, async () => {
      let selected = secret, roots = [firstRoot];
      if (kind === 'relative traversal') { selected = '../outside/file.ts'; }
      if (kind === 'prefix sibling') {
        const sibling = firstRoot + '-sibling'; fs.mkdirSync(sibling); selected = path.join(sibling, 'file.ts'); fs.writeFileSync(selected, OUTSIDE);
      }
      if (kind === 'outside file symlink') { selected = link(secret, path.join(firstRoot, 'escape.ts')); }
      if (kind === 'outside directory symlink') { selected = path.join(link(outside, path.join(firstRoot, 'escape')), 'file.ts'); }
      if (kind === 'directory') { selected = path.join(firstRoot, 'dir'); fs.mkdirSync(selected); }
      if (kind === 'missing') { selected = path.join(firstRoot, 'missing.ts'); }
      if (kind === 'no workspace') { selected = first; roots = []; }
      await expect(readWorkspaceFileMention(selected, roots)).rejects.toThrow();
      expect(reads()).toBe(0); expect(handles).toEqual([]);
    });
  }
  it('captures the root array before asynchronous resolution', async () => {
    const roots = [firstRoot], entered = deferred(), release = deferred();
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
      if (args[0] === firstRoot) { entered.resolve(); await release.promise; }
      return realRealpath(...args);
    });
    const pending = readWorkspaceFileMention(secret, roots);
    const outcome = expect(pending).rejects.toThrow(/outside/);
    try { await entered.promise; roots.push(outside); release.resolve(); await outcome; expect(reads()).toBe(0); }
    finally { release.resolve(); await pending.catch(() => undefined); }
  });
});

describe('workspace file mention handle and path revalidation', () => {
  it('reads the acquired inside inode when the path changes after validation', async () => {
    beforeRead = async () => {
      fs.renameSync(first, first + '.original');
      fs.symlinkSync(secret, first);
    };
    const result = await readWorkspaceFileMention(first, [firstRoot]);
    expect(fs.realpathSync(first)).toBe(secret);
    expect(result).toEqual({ path: first, content: INSIDE });
    expect(result?.content).not.toContain(OUTSIDE);
    expect(handles).toHaveLength(1);
    expect(handles[0].path).toBe(first);
    expect(handles[0].reads).toBe(1);
    expect(handles[0].closes).toBe(1);
  });

  for (const when of ['open', 'stat'] as const) {
    it(`rejects leaf-link retargeting during held ${when} before content`, async () => {
      const selected = link(first, path.join(firstRoot, 'alias.ts'));
      const entered = deferred(), release = deferred();
      const hold = async () => { entered.resolve(); await release.promise; };
      if (when === 'open') { afterOpen = hold; } else { beforeStat = hold; }
      const pending = readWorkspaceFileMention(selected, [firstRoot]);
      const outcome = expect(pending).rejects.toThrow(/changed/);
      try { await entered.promise; retarget(selected, secret); release.resolve(); await outcome; expect(reads()).toBe(0); }
      finally { release.resolve(); await pending.catch(() => undefined); beforeStat = async () => undefined; }
    });
  }
  it('rejects a changed opened inode even when the path spelling is identical', async () => {
    substituteOpen = secret;
    await expect(readWorkspaceFileMention(first, [firstRoot])).rejects.toThrow(/changed while opening/);
    expect(reads()).toBe(0);
  });
  it('rejects a regular-file replacement after acquiring the original handle', async () => {
    afterOpen = async () => { fs.renameSync(first, first + '.old'); fs.writeFileSync(first, 'REPLACEMENT'); };
    await expect(readWorkspaceFileMention(first, [firstRoot])).rejects.toThrow(/changed/); expect(reads()).toBe(0);
  });
  it('rejects selected parent-link retargeting after open', async () => {
    const selectedParent = link(firstRoot, path.join(firstRoot, 'parent-link'));
    const selected = path.join(selectedParent, 'file.ts');
    afterOpen = async () => { retarget(selectedParent, outside); };
    await expect(readWorkspaceFileMention(selected, [firstRoot])).rejects.toThrow(/changed/); expect(reads()).toBe(0);
  });
  it('rejects canonical parent replacement before reading the acquired handle', async () => {
    const dir = path.join(firstRoot, 'dir'); fs.mkdirSync(dir); const selected = path.join(dir, 'file.ts'); fs.writeFileSync(selected, INSIDE);
    afterOpen = async () => { fs.renameSync(dir, dir + '-old'); fs.symlinkSync(outside, dir); };
    await expect(readWorkspaceFileMention(selected, [firstRoot])).rejects.toThrow(/changed/); expect(reads()).toBe(0);
  });
  it('revalidates a declared workspace alias independently of the file path', async () => {
    const alias = link(firstRoot, path.join(base, 'root-alias'));
    afterOpen = async () => { retarget(alias, secondRoot); };
    await expect(readWorkspaceFileMention(first, [alias])).rejects.toThrow(/changed/); expect(reads()).toBe(0);
  });
  it('rejects a replaced root inode even if the file is hard-linked into its old spelling', async () => {
    afterOpen = async () => {
      fs.renameSync(firstRoot, firstRoot + '-old'); fs.mkdirSync(firstRoot);
      fs.linkSync(path.join(firstRoot + '-old', 'file.ts'), first);
    };
    await expect(readWorkspaceFileMention(first, [firstRoot])).rejects.toThrow(/changed/); expect(reads()).toBe(0);
  });
  for (const failure of ['stat', 'read', 'revalidation'] as const) {
    it(`closes the real handle when ${failure} fails`, async () => {
      if (failure === 'stat') { beforeStat = async () => { throw new Error('owned stat failure'); }; }
      if (failure === 'read') { beforeRead = async () => { throw new Error('owned read failure'); }; }
      if (failure === 'revalidation') { afterOpen = async () => { fs.unlinkSync(first); }; }
      await expect(readWorkspaceFileMention(first, [firstRoot])).rejects.toThrow();
      beforeStat = async () => undefined;
      expect(handles).toHaveLength(1); expect(handles[0].closes).toBe(1);
    });
  }
});

describe('workspace file mention cancellation', () => {
  it('does no filesystem work when already cancelled', async () => {
    const metadata = vi.spyOn(fs.promises, 'realpath');
    expect(await readWorkspaceFileMention(first, [firstRoot], () => true)).toBeUndefined();
    expect(metadata).not.toHaveBeenCalled(); expect(fs.promises.open).not.toHaveBeenCalled();
  });
  for (const phase of ['root metadata', 'target metadata', 'open', 'stat', 'revalidation', 'read', 'read rejection', 'close'] as const) {
    it(`discards cancelled results and closes handles during ${phase}`, async () => {
      let cancelled = false;
      const entered = deferred(), release = deferred();
      const hold = async () => { entered.resolve(); await release.promise; };
      if (phase === 'root metadata' || phase === 'revalidation') {
        let selectedCalls = 0;
        vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
          const result = await realRealpath(...args);
          if ((phase === 'root metadata' && args[0] === firstRoot)
            || (phase === 'revalidation' && args[0] === first && ++selectedCalls === 2)) { await hold(); }
          return result;
        });
      }
      if (phase === 'target metadata') {
        vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
          const result = await realLstat(...args); if (args[0] === first) { await hold(); } return result;
        });
      }
      if (phase === 'open') { afterOpen = hold; }
      if (phase === 'stat') { beforeStat = hold; }
      if (phase === 'read' || phase === 'read rejection') {
        beforeRead = async () => { await hold(); if (phase === 'read rejection') { throw new Error('owned read failure after Stop'); } };
      }
      if (phase === 'close') { afterClose = hold; }
      const pending = readWorkspaceFileMention(first, [firstRoot], () => cancelled);
      try {
        const reached = await Promise.race([entered.promise.then(() => true), pending.then(() => false)]);
        expect(reached, 'the held operation must actually be reached').toBe(true);
        cancelled = true; release.resolve(); expect(await pending).toBeUndefined();
        if (!['read', 'read rejection', 'close'].includes(phase)) { expect(reads()).toBe(0); }
      } finally { release.resolve(); await pending; beforeStat = async () => undefined; }
    });
  }
});
