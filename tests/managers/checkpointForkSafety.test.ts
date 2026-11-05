import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CheckpointManager } from '../../src/managers/CheckpointManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

let directory: string, root: string, storage: string, manager: CheckpointManager;
let originalFolders: unknown, originalEvent: unknown, workspaceChanged: () => void;
const workspace = vscode.workspace as any;
function git(args: string[]): Buffer { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); }
function write(name: string, content: string | Buffer): void {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
function bytes(name: string): Buffer { return fs.readFileSync(path.join(root, name)); }
function userIndex(): Buffer { return fs.readFileSync(path.join(root, '.git', 'index')); }
beforeEach(() => {
  clearMockConfig();
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-fork-rewind-')));
  root = path.join(directory, 'workspace with spaces'); storage = path.join(directory, 'owned storage');
  fs.mkdirSync(root); fs.mkdirSync(storage);
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  write('.gitignore', 'ignored/\nnode_modules/\n'); write('retry.ts', 'export const base = 73;\n');
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'owned baseline']);
  originalFolders = workspace.workspaceFolders; originalEvent = workspace.onDidChangeWorkspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'owned', index: 0 }];
  workspace.onDidChangeWorkspaceFolders = (listener: () => void) => { workspaceChanged = listener; return { dispose() {} }; };
  manager = new CheckpointManager({ globalStorageUri: { fsPath: storage } } as any);
});
afterEach(() => {
  manager.dispose(); workspace.workspaceFolders = originalFolders; workspace.onDidChangeWorkspaceFolders = originalEvent;
  clearMockConfig(); vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
});

describe('PC-10 owned filesystem fork-and-rewind safety', () => {
  it('refuses a rewind when changed workspace exceeds the safety snapshot cap, preserving all user bytes', async () => {
    setMockConfig('checkpoints.maxFiles', 2);
    const target = await manager.snapshot('branch point'); expect(target).toBeTruthy();
    write('retry.ts', 'export const base = 146; // user-owned edit\n');
    write('user-notes.md', '# Must remain recoverable\n');
    const before = { code: bytes('retry.ts'), notes: bytes('user-notes.md'), index: userIndex() };
    const result = await manager.rewindTo(target!);
    expect(result).toMatchObject({ ok: false });
    expect(bytes('retry.ts')).toEqual(before.code); expect(bytes('user-notes.md')).toEqual(before.notes); expect(userIndex()).toEqual(before.index);
  });

  it('refuses a rewind when the safety snapshot cannot stage current bytes', async () => {
    const target = await manager.snapshot('branch point'); expect(target).toBeTruthy();
    write('retry.ts', 'pending user work\n'); write('user-draft.md', 'untracked user work\n');
    const original = manager['_runGit'].bind(manager);
    vi.spyOn(manager as any, '_runGit').mockImplementation((args: string[]) => args[0] === 'add'
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'controlled ENOSPC staging failure' }) : original(args));
    const result = await manager.rewindTo(target!);
    expect(result).toMatchObject({ ok: false });
    expect(bytes('retry.ts').toString()).toBe('pending user work\n'); expect(bytes('user-draft.md').toString()).toBe('untracked user work\n');
  });

  it('restores pre-existing edits exactly and makes later user edits recoverable without touching the user git index', async () => {
    write('retry.ts', 'export const base = 73;\n// pre-existing user change\n'); git(['add', 'retry.ts']);
    write('binary fixture.dat', Buffer.from([0, 255, 13, 10, 128]));
    write('ignored/keep.txt', 'ignored at checkpoint'); write('node_modules/keep.js', 'dependency at checkpoint');
    const target = await manager.snapshot('branch point'); expect(target).toBeTruthy();
    const original = { code: bytes('retry.ts'), binary: bytes('binary fixture.dat'), index: userIndex(), head: git(['rev-parse', 'HEAD']) };
    write('retry.ts', 'export const base = 999; // alternate branch\n'); fs.unlinkSync(path.join(root, 'binary fixture.dat'));
    write('after checkpoint.md', 'later untracked user notes');
    write('ignored/keep.txt', 'current ignored bytes'); write('node_modules/keep.js', 'current dependency bytes');
    const changedCode = bytes('retry.ts');
    const result = await manager.rewindTo(target!);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
    expect(result.safetyCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(bytes('retry.ts')).toEqual(original.code); expect(bytes('binary fixture.dat')).toEqual(original.binary);
    expect(fs.existsSync(path.join(root, 'after checkpoint.md'))).toBe(false);
    expect(bytes('ignored/keep.txt').toString()).toBe('current ignored bytes'); expect(bytes('node_modules/keep.js').toString()).toBe('current dependency bytes');
    expect(userIndex()).toEqual(original.index); expect(git(['rev-parse', 'HEAD'])).toEqual(original.head);
    expect((await manager.rewindTo(result.safetyCommit!)).ok).toBe(true);
    expect(bytes('retry.ts')).toEqual(changedCode); expect(bytes('after checkpoint.md').toString()).toBe('later untracked user notes');
    expect(userIndex()).toEqual(original.index);
  });

  it('rejects missing or non-checkpoint object names before any destructive work', async () => {
    await manager.snapshot('branch point'); write('retry.ts', 'leave this edit alone\n');
    for (const commit of ['f'.repeat(40), '', 'HEAD', '--help']) {
      expect((await manager.rewindTo(commit)).ok).toBe(false);
      expect(bytes('retry.ts').toString()).toBe('leave this edit alone\n');
    }
  });

  it('cancelled queued rewind leaves the current workspace unchanged', async () => {
    const target = await manager.snapshot('branch point'); write('retry.ts', 'newer user edit\n');
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    manager['_opQueue'] = blocker;
    let current = true;
    const result = manager.rewindTo(target!, () => current);
    await Promise.resolve(); current = false; release();
    expect((await result).ok).toBe(false);
    expect(bytes('retry.ts').toString()).toBe('newer user edit\n');
  });

  it('owner cancellation while the safety snapshot is awaited prevents reset and clean', async () => {
    const target = await manager.snapshot('branch point'); write('retry.ts', 'pending current edit\n'); write('draft.md', 'pending draft\n');
    const original = manager['_snapshotImpl'].bind(manager);
    let entered!: () => void, release!: () => void, current = true;
    const enteredSafety = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(manager as any, '_snapshotImpl').mockImplementation(async (...args: [string, boolean, boolean?]) => {
      const result = await original(...args); entered(); await blocked; return result;
    });
    const pending = manager.rewindTo(target!, () => current);
    await enteredSafety; current = false; release();
    expect((await pending).ok).toBe(false);
    expect(bytes('retry.ts').toString()).toBe('pending current edit\n'); expect(bytes('draft.md').toString()).toBe('pending draft\n');
  });

  it('finishes an already-started rewind on its captured root when focus moves to another workspace', async () => {
    const target = await manager.snapshot('branch point');
    write('retry.ts', 'alternate branch\n'); write('after.txt', 'remove only from captured workspace');
    const otherRoot = path.join(directory, 'other workspace'); fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, 'retry.ts'), 'other workspace stays untouched');
    const original = manager['_spawnGit'].bind(manager); let current = true, moved = false;
    vi.spyOn(manager as any, '_spawnGit').mockImplementation(async (...args: [string[], number, string | undefined]) => {
      const result = await original(...args);
      if (!moved && args[0].includes('reset')) {
        moved = true; current = false;
        workspace.workspaceFolders = [{ uri: { fsPath: otherRoot }, name: 'other', index: 0 }]; workspaceChanged();
      }
      return result;
    });
    expect((await manager.rewindTo(target!, () => current)).ok).toBe(true);
    expect(moved).toBe(true); expect(bytes('retry.ts').toString()).toBe('export const base = 73;\n');
    expect(fs.existsSync(path.join(root, 'after.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(otherRoot, 'retry.ts'), 'utf8')).toBe('other workspace stays untouched');
    expect(fs.readdirSync(otherRoot)).toEqual(['retry.ts']);
  });

  it('a reset failure after writes restores the complete pre-rewind bytes from the safety snapshot', async () => {
    const target = await manager.snapshot('branch point');
    write('retry.ts', 'user edit before rewind\n'); write('new notes.txt', 'untracked notes before rewind');
    const index = userIndex(), original = manager['_spawnGit'].bind(manager); let resetAttempts = 0;
    vi.spyOn(manager as any, '_spawnGit').mockImplementation(async (...args: [string[], number, string | undefined]) => {
      const result = await original(...args);
      if (args[0].includes('reset') && ++resetAttempts === 1) {
        return { code: 1, stdout: '', stderr: 'controlled reset failure after workspace writes' };
      }
      return result;
    });
    const result = await manager.rewindTo(target!);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('previous workspace was restored') });
    expect(bytes('retry.ts').toString()).toBe('user edit before rewind\n'); expect(bytes('new notes.txt').toString()).toBe('untracked notes before rewind');
    expect(userIndex()).toEqual(index); expect(resetAttempts).toBe(2);
  });

  it('reports a distinct partial-restore state and recovery reference if rollback also fails', async () => {
    const target = await manager.snapshot('branch point'); write('retry.ts', 'recoverable user edit\n');
    const original = manager['_spawnGit'].bind(manager); let resetAttempts = 0;
    vi.spyOn(manager as any, '_spawnGit').mockImplementation(async (...args: [string[], number, string | undefined]) => {
      if (args[0].includes('reset')) {
        if (++resetAttempts > 1) return { code: 1, stdout: '', stderr: 'controlled rollback unavailable' };
        await original(...args);
        return { code: 1, stdout: '', stderr: 'controlled reset failure after workspace writes' };
      }
      return original(...args);
    });
    const result = await manager.rewindTo(target!);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/automatic recovery failed.*partially restored.*recovery checkpoint: [0-9a-f]{40}/) });
    expect(resetAttempts).toBe(2);
  });

  it('preserves files ignored by current rules when rewind restores older ignore rules', async () => {
    const target = await manager.snapshot('before local ignore rule');
    write('.gitignore', 'ignored/\nnode_modules/\nuser-private/\n');
    write('user-private/local-notes.txt', 'synthetic private notes excluded from every checkpoint');
    write('retry.ts', 'alternate branch work\n');
    const result = await manager.rewindTo(target!);
    expect(result.ok).toBe(true);
    expect(bytes('retry.ts').toString()).toBe('export const base = 73;\n');
    expect(bytes('user-private/local-notes.txt').toString()).toBe('synthetic private notes excluded from every checkpoint');
  });

  it('workspace A to B to A while saving safety invalidates the original rewind ownership', async () => {
    const target = await manager.snapshot('branch point'); write('retry.ts', 'latest A edit\n');
    const otherRoot = path.join(directory, 'other'); fs.mkdirSync(otherRoot);
    const original = manager['_snapshotImpl'].bind(manager);
    vi.spyOn(manager as any, '_snapshotImpl').mockImplementation(async (...args: [string, boolean, boolean?]) => {
      const safety = await original(...args);
      workspace.workspaceFolders = [{ uri: { fsPath: otherRoot } }]; workspaceChanged();
      workspace.workspaceFolders = [{ uri: { fsPath: root } }]; workspaceChanged();
      return safety;
    });
    const result = await manager.rewindTo(target!, () => true);
    expect(result.ok).toBe(false); expect(bytes('retry.ts').toString()).toBe('latest A edit\n');
  });

  it.each(['file', 'directory'])('refuses an ignored unbacked %s that would be overwritten by a target tracked file', async kind => {
    write('local.txt', 'old tracked checkpoint value');
    const target = await manager.snapshot('old target with local.txt');
    fs.unlinkSync(path.join(root, 'local.txt')); await manager.snapshot('later deletion');
    write('.gitignore', 'ignored/\nnode_modules/\nlocal.txt\n');
    const privatePath = kind === 'file' ? 'local.txt' : 'local.txt/private-notes.txt';
    write(privatePath, 'synthetic unbacked private notes');
    const beforeIndex = userIndex(), beforeIgnore = bytes('.gitignore');
    const result = await manager.rewindTo(target!);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/unbacked|not.*safety|not.*backed/i) });
    expect(bytes(privatePath).toString()).toBe('synthetic unbacked private notes');
    expect(bytes('.gitignore')).toEqual(beforeIgnore); expect(userIndex()).toEqual(beforeIndex);
  });

  it.skipIf(process.platform === 'win32')('refuses an ignored unbacked symlink ancestor without reading or changing its target', async () => {
    write('local/retry.ts', 'old tracked local source');
    const target = await manager.snapshot('old target inside local');
    fs.rmSync(path.join(root, 'local'), { recursive: true }); await manager.snapshot('later local deletion');
    write('.gitignore', 'ignored/\nnode_modules/\nlocal\n');
    const other = path.join(directory, 'private sibling'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'retry.ts'), 'unbacked sibling canary');
    fs.symlinkSync(other, path.join(root, 'local'), 'dir');
    const result = await manager.rewindTo(target!);
    expect(result.ok).toBe(false);
    expect(fs.lstatSync(path.join(root, 'local')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(other, 'retry.ts'), 'utf8')).toBe('unbacked sibling canary');
  });
});
