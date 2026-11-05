import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireConfigurationChange } from '../helpers/mockVscode';
import { resolveWorkspaceFileShorthand } from '../../src/services/WorkspaceFileShorthand';

vi.mock('vscode', async () => {
  const original = await import('../helpers/mockVscode');
  return { ...original, workspace: { ...original.workspace, findFiles: vi.fn() } };
});

const find = vi.mocked(vscode.workspace.findFiles);
const realRealpath = fs.promises.realpath.bind(fs.promises);
const realLstat = fs.promises.lstat.bind(fs.promises);
let base: string, rootA: string, rootB: string, a: string, b: string;
let queryTokens: vscode.CancellationToken[];
function uri(file: string) { return { scheme: 'file', fsPath: file } as vscode.Uri; }
function token(file = a, visible = 'src/util.ts', quoted = false) { return { visiblePath: visible, suppliedPath: file, quoted }; }
function file(root: string, relative: string) {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'UNREAD_TEST_BYTES'); return target;
}
function reply(paths: string[]) {
  find.mockImplementation(async (_include, _exclude, _limit, cancellation) => {
    queryTokens.push(cancellation!); return paths.map(uri);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function expected(filePath: string) {
  const canonicalPath = await realRealpath(filePath), stat = await realLstat(canonicalPath, { bigint: true });
  return { kind: 'unique', selectedPath: filePath, expected: { canonicalPath, dev: stat.dev, ino: stat.ino } };
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-shorthand-')));
  rootA = path.join(base, 'root-A'); rootB = path.join(base, 'root-B');
  a = file(rootA, 'src/util.ts'); b = file(rootB, 'src/util.ts');
  find.mockReset(); queryTokens = []; reply([a]);
  vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('Metadata admission must not read content'));
  vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('Metadata admission must not open content handles'));
});
afterEach(() => {
  expect(fs.promises.readFile).not.toHaveBeenCalled(); expect(fs.promises.open).not.toHaveBeenCalled();
  for (const item of queryTokens) { expect(item.isCancellationRequested).toBe(true); }
  vi.restoreAllMocks(); fs.rmSync(base, { recursive: true, force: true });
});

describe('workspace shorthand searchable catalogue admission', () => {
  for (const visible of ['åA.ts', 'a*.ts']) {
    it(`refuses unsupported unquoted grammar ${JSON.stringify(visible)} before metadata`, async () => {
      const spy = vi.spyOn(fs.promises, 'realpath');
      expect(await resolveWorkspaceFileShorthand(token(a, visible), [rootA, rootB])).toMatchObject({ kind: 'unavailable' });
      expect(spy).not.toHaveBeenCalled(); expect(find).not.toHaveBeenCalled();
    });
  }
  for (const reverse of [false, true]) {
    it(`keeps unique root-two identity when root order is ${reverse ? 'reversed' : 'ordinary'}`, async () => {
      reply([b]);
      expect(await resolveWorkspaceFileShorthand(token(b), reverse ? [rootB, rootA] : [rootA, rootB])).toEqual(await expected(b));
      expect(find).toHaveBeenCalledWith('**/*util.ts', '**/node_modules/**', 257, expect.anything());
    });
  }
  it('rejects stale-cache metadata when two physical targets match', async () => {
    reply([a, b]);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'ambiguous', reason: expect.stringContaining('quoted full path') });
  });
  it('checks nested packages instead of only root-relative joins', async () => {
    const nested = file(rootB, 'packages/deep/src/util.ts'); reply([a, nested]);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'ambiguous' });
  });
  it('allows suffixes containing a root name', async () => {
    expect(await resolveWorkspaceFileShorthand(token(a, 'root-A/src/util.ts'), [rootA, rootB])).toEqual(await expected(a));
  });
  it('filters a conservative basename query by the complete literal suffix', async () => {
    const other = file(rootB, 'other/util.ts'); reply([a, other]);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toEqual(await expected(a));
  });
  it('deduplicates overlapping, duplicate and symlinked roots without losing the selected alias', async () => {
    const alias = path.join(base, 'alias'); fs.symlinkSync(rootA, alias);
    const selected = path.join(alias, 'src/util.ts'); reply([a, selected]);
    expect(await resolveWorkspaceFileShorthand(token(selected), [rootA, alias, rootA, path.join(rootA, 'src')])).toEqual(await expected(selected));
  });
  it('deduplicates different file aliases reaching one canonical target', async () => {
    fs.unlinkSync(b); fs.symlinkSync(a, b); reply([a, b]);
    expect(await resolveWorkspaceFileShorthand(token(b), [rootA, rootB])).toEqual(await expected(b));
  });
  it('resolves relative-only metadata to the unique root-two canonical target', async () => {
    reply([b]);
    expect(await resolveWorkspaceFileShorthand(token('src/util.ts'), [rootA, rootB])).toEqual(await expected(b));
    expect(await resolveWorkspaceFileShorthand(token('src/util.ts'), [rootB, rootA])).toEqual(await expected(b));
  });
  it('rejects ambiguous relative-only metadata instead of selecting root zero', async () => {
    reply([a, b]);
    expect(await resolveWorkspaceFileShorthand(token('src/util.ts'), [rootA, rootB])).toMatchObject({ kind: 'ambiguous' });
  });
  it('does not merge distinct canonical hard-link paths', async () => {
    fs.unlinkSync(b); fs.linkSync(a, b); reply([a, b]);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'ambiguous' });
  });
  it('does not accept a sole other target in place of supplied identity', async () => {
    reply([b]); expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'unavailable' });
  });
  it('ignores external and nonregular candidates but never admits external selected paths', async () => {
    const outside = file(path.join(base, 'outside'), 'src/util.ts');
    const dir = path.join(rootB, 'dir/src/util.ts'); fs.mkdirSync(dir, { recursive: true });
    reply([a, outside, dir]);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toEqual(await expected(a));
    find.mockClear();
    expect(await resolveWorkspaceFileShorthand(token(outside), [rootA, rootB])).toMatchObject({ kind: 'unavailable' });
    expect(find).not.toHaveBeenCalled();
  });
  it('keeps exact case ahead of case-folded alternatives', async () => {
    const upper = file(rootA, 'src/UTIL.ts'); reply([upper, b]);
    expect(await resolveWorkspaceFileShorthand(token(upper, 'src/UTIL.ts'), [rootA, rootB])).toEqual(await expected(upper));
    expect(find).toHaveBeenCalledTimes(1);
  });
  it('uses ASCII case-class fallback only after the completed exact phase is empty', async () => {
    const order: string[] = [];
    find.mockImplementation(async (pattern, _exclude, _limit, cancellation) => {
      order.push(String(pattern)); queryTokens.push(cancellation!); return order.length === 1 ? [] : [uri(a)];
    });
    expect(await resolveWorkspaceFileShorthand(token(a, 'SRC/UTIL.TS'), [rootA, rootB])).toEqual(await expected(a));
    expect(order).toEqual(['**/*UTIL.TS', '**/*[uU][tT][iI][lL].[tT][sS]']);
  });
  it('refuses ambiguous fallback and never case-folds quoted references', async () => {
    find.mockResolvedValueOnce([]).mockResolvedValueOnce([uri(a), uri(b)]);
    expect(await resolveWorkspaceFileShorthand(token(a, 'SRC/UTIL.TS'), [rootA, rootB])).toMatchObject({ kind: 'ambiguous' });
    find.mockReset(); reply([]);
    expect(await resolveWorkspaceFileShorthand(token(a, 'SRC/UTIL.TS', true), [rootA, rootB])).toMatchObject({ kind: 'unavailable' });
    expect(find).not.toHaveBeenCalled(); // lexical quoted mismatch is rejected first
  });
  it('includes Unicode Kelvin lowercase aliases in the fallback candidate query', async () => {
    const upper = file(rootA, 'K.ts'), kelvin = file(rootB, 'K.ts');
    find.mockImplementation(async (pattern) => {
      if (pattern === '**/*k.ts') { return []; }
      expect(pattern).toBe('**/*[kKK].[tT][sS]');
      return [uri(upper), uri(kelvin)];
    });
    expect(await resolveWorkspaceFileShorthand(token(upper, 'k.ts'), [rootA, rootB])).toMatchObject({ kind: 'ambiguous' });
  });
  it('does not case-fold a complete missing quoted reference', async () => {
    reply([]); expect(await resolveWorkspaceFileShorthand(token(a, 'src/util.ts', true), [rootA, rootB])).toMatchObject({ kind: 'unavailable' });
    expect(find).toHaveBeenCalledTimes(1);
  });
  for (const count of [257, 258]) {
    it(`rejects ${count} raw results before filtering or canonical deduplication`, async () => {
      reply(Array(count).fill(a));
      expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'incomplete', reason: expect.stringContaining('search limit') });
      expect(find).toHaveBeenCalledTimes(1);
    });
  }
  it('allows a complete 256-result alias list with one target', async () => {
    reply(Array(256).fill(a)); expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toEqual(await expected(a));
  });
  for (const [name, glob] of [
    ['a*b.ts', '**/*a[*]b.ts'], ['a?b.ts', '**/*a[?]b.ts'], ['a[b].ts', '**/*a[[]b[]].ts'],
    ['a{b}.ts', '**/*a[{]b[}].ts'], ['雪 "name".ts', '**/*雪 "name".ts'], ['a\\b.ts', '**/*b.ts'],
  ]) {
    it(`keeps ${JSON.stringify(name)} literal in the query and path filter`, async () => {
      const selected = file(rootA, name); reply([selected]);
      expect(await resolveWorkspaceFileShorthand(token(selected, name, true), [rootA, rootB])).toEqual(await expected(selected));
      expect(find.mock.calls[0][0]).toBe(glob);
    });
  }
  it('returns incomplete for a query failure without exposing internal paths', async () => {
    find.mockRejectedValue(new Error('/secret/query/path'));
    const result = await resolveWorkspaceFileShorthand(token(), [rootA, rootB]);
    expect(result).toMatchObject({ kind: 'incomplete' }); expect(JSON.stringify(result)).not.toContain('/secret');
  });
  it('fails closed when a query candidate vanishes during metadata', async () => {
    reply([a, path.join(rootB, 'missing/src/util.ts')]);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'incomplete' });
  });
  it('rejects unsupported URI schemes instead of treating the catalogue as complete', async () => {
    find.mockResolvedValue([{ scheme: 'remote', fsPath: a } as vscode.Uri]);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'incomplete' });
  });
  it('does no query or metadata when already cancelled', async () => {
    const spy = vi.spyOn(fs.promises, 'realpath');
    expect(await resolveWorkspaceFileShorthand(token(), [rootA], () => true)).toBeUndefined();
    expect(find).not.toHaveBeenCalled(); expect(spy).not.toHaveBeenCalled();
  });
  it('cancels a held query and ignores its later result', async () => {
    let cancelled = false; const started = deferred<void>(), held = deferred<vscode.Uri[]>();
    find.mockImplementation((_p, _e, _m, cancellation) => { queryTokens.push(cancellation!); started.resolve(); return held.promise; });
    const pending = resolveWorkspaceFileShorthand(token(), [rootA, rootB], () => cancelled);
    await started.promise; cancelled = true;
    expect(await pending).toBeUndefined(); expect(queryTokens[0].isCancellationRequested).toBe(true);
    held.resolve([uri(a)]); await Promise.resolve(); expect(find).toHaveBeenCalledTimes(1);
  });
  it('enforces the five-second deadline on a pending query and disposes resources', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const started = deferred<void>(), held = deferred<vscode.Uri[]>();
    const clear = vi.spyOn(globalThis, 'clearInterval');
    find.mockImplementation((_p, _e, _m, cancellation) => { queryTokens.push(cancellation!); started.resolve(); return held.promise; });
    const pending = resolveWorkspaceFileShorthand(token(), [rootA, rootB]);
    await started.promise; now = 5000;
    expect(await pending).toMatchObject({ kind: 'incomplete' }); expect(clear).toHaveBeenCalledTimes(1);
    held.resolve([uri(a)]);
  });
  it('invalidates a held search when catalogue settings change', async () => {
    const started = deferred<void>(), held = deferred<vscode.Uri[]>();
    find.mockImplementation((_p, _e, _m, cancellation) => { queryTokens.push(cancellation!); started.resolve(); return held.promise; });
    const pending = resolveWorkspaceFileShorthand(token(), [rootA, rootB]);
    await started.promise; fireConfigurationChange('search.followSymlinks');
    expect(await pending).toMatchObject({ kind: 'incomplete' }); held.resolve([uri(a)]);
  });
  it('rechecks cancellation after metadata and stops before querying', async () => {
    let cancelled = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.promises.lstat>) => {
      const value = await realLstat(...args); cancelled = true; return value;
    }) as typeof fs.promises.lstat);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB], () => cancelled)).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });
  it('stops candidate metadata after ownership is revoked during the first candidate', async () => {
    reply([a, b]); let cancelled = false, queried = false; const observed: string[] = [];
    find.mockImplementation(async () => { queried = true; return [uri(a), uri(b)]; });
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.promises.realpath>) => {
      const value = await realRealpath(...args);
      if (queried) { observed.push(String(args[0])); cancelled = true; }
      return value;
    }) as typeof fs.promises.realpath);
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB], () => cancelled)).toBeUndefined();
    expect(observed).toEqual([a]);
  });
  it('rejects selected identity changed after candidate admission but before final validation', async () => {
    const original = await expected(a); let stats = 0;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.promises.lstat>) => {
      const value = await realLstat(...args);
      if (String(args[0]) === a && ++stats === 2) { fs.renameSync(a, a + '.old'); fs.writeFileSync(a, 'AFTER_CANDIDATE'); }
      return value;
    }) as typeof fs.promises.lstat);
    const result = await resolveWorkspaceFileShorthand(token(), [rootA, rootB]);
    expect(result).toMatchObject({ kind: 'unavailable' }); expect(result).not.toEqual(original);
  });
  it('rejects a selected alias retargeted while the query is pending', async () => {
    const alias = path.join(rootA, 'alias/src/util.ts'); fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.symlinkSync(a, alias);
    find.mockImplementation(async () => { fs.unlinkSync(alias); fs.symlinkSync(b, alias); return [uri(b)]; });
    expect(await resolveWorkspaceFileShorthand(token(alias), [rootA, rootB])).toMatchObject({ kind: 'unavailable' });
  });
  it('rejects replacement of the selected inode with unchanged path spelling', async () => {
    find.mockImplementation(async () => { fs.renameSync(a, a + '.old'); fs.writeFileSync(a, 'REPLACED'); return [uri(a)]; });
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, rootB])).toMatchObject({ kind: 'unavailable' });
  });
  it('invalidates a declared root alias retargeted during the query', async () => {
    const alias = path.join(base, 'root-alias'); fs.symlinkSync(rootA, alias);
    find.mockImplementation(async () => { fs.unlinkSync(alias); fs.symlinkSync(rootB, alias); return [uri(a)]; });
    expect(await resolveWorkspaceFileShorthand(token(), [rootA, alias, rootB])).toMatchObject({ kind: 'incomplete' });
  });
});
