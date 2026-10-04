import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { observeRepository, repositoryInsights, mayNotify } from '../../../src/services/proactive/LocalRepository';
const dirs: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
afterEach(async () => { for (const dir of dirs.splice(0)) { await rm(dir, { recursive: true, force: true }); } });
describe('read-only repository monitoring', () => {
  it('detects fetched upstream overlap without modifying or fetching the working tree', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mysti-proactive-')); dirs.push(base);
    const upstream = join(base, 'upstream'), local = join(base, 'local');
    await mkdir(upstream); git(upstream, 'init', '-b', 'main'); git(upstream, 'config', 'user.email', 'test@example.invalid'); git(upstream, 'config', 'user.name', 'Test');
    await writeFile(join(upstream, 'file.txt'), 'initial'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'initial');
    git(base, 'clone', upstream, local);
    const initial = await observeRepository(local);
    expect(repositoryInsights(initial)).toEqual([]);
    await writeFile(join(upstream, 'file.txt'), 'upstream change'); git(upstream, 'commit', '-am', 'change');
    expect((await observeRepository(local)).behind).toBe(0); // no implicit fetch
    git(local, 'fetch'); await writeFile(join(local, 'file.txt'), 'my unfinished work');
    const before = git(local, 'status', '--porcelain=v1');
    const observed = await observeRepository(local);
    expect(observed).toMatchObject({ behind: 1, ahead: 0, overlap: ['file.txt'] });
    expect(repositoryInsights(observed, initial)[0].title).toContain('overlap');
    expect(git(local, 'status', '--porcelain=v1')).toBe(before);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(initial.head);
    await mkdir(join(local, 'nested'));
    await expect(observeRepository(join(local, 'nested'))).rejects.toThrow('repository root');
    git(local, 'reset', '--hard', 'origin/main');
    expect(repositoryInsights(await observeRepository(local), observed)[0].title).toContain('changed');
  }, 30_000);
  it('handles detached HEAD, no upstream, filenames with spaces and newlines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mysti-proactive-')); dirs.push(root);
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
    await expect(observeRepository(root)).rejects.toThrow();
    await writeFile(join(root, 'old file'), 'content'); git(root, 'add', '.'); git(root, 'commit', '-m', 'initial');
    const renamed = process.platform === 'win32' ? 'new file' : 'new\nfile'; // Windows forbids control characters in filenames.
    git(root, 'mv', 'old file', renamed);
    const s = await observeRepository(root);
    expect(s.dirty).toEqual(expect.arrayContaining([renamed, 'old file']));
    expect(s.upstream).toBeUndefined();
    git(root, 'checkout', '--detach');
    expect((await observeRepository(root)).branch).toBe('HEAD');
  }, 30_000);
  it('enforces opt-in, quiet hours, and a daily notification budget', () => {
    const morning = new Date(2026, 9, 1, 9);
    const today = morning.toLocaleDateString('en-CA');
    expect(mayNotify(false, morning, { day: today, count: 0 })).toBe(false);
    expect(mayNotify(true, new Date(2026, 9, 1, 21), { day: today, count: 0 })).toBe(false);
    expect(mayNotify(true, morning, { day: today, count: 3 })).toBe(false);
    expect(mayNotify(true, morning, { day: 'yesterday', count: 3 })).toBe(true);
  });
});
