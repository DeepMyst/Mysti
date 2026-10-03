/**
 * `mysti.checkpoints.maxSnapshots` is declared in package.json with a default of
 * 200 and a description promising "the oldest are pruned" — and until this
 * suite existed, nothing in src/ ever read the key. The Settings UI advertised a
 * cap that was enforced nowhere while the shadow-git store grew for the life of
 * the workspace.
 *
 * These tests drive the real CheckpointManager against a real git repo, because
 * the interesting part is git's behaviour: a pruned checkpoint must stop
 * resolving (objects actually gone), and every RETAINED checkpoint must keep the
 * exact SHA the UI already stored on its rewind button.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { setMockConfig, clearMockConfig } from '../helpers/mockVscode';
import { CheckpointManager } from '../../src/managers/CheckpointManager';
import { CHECKPOINTS_DIR } from '../../src/constants';

const ws = vscode.workspace as unknown as {
  workspaceFolders: unknown;
  onDidChangeWorkspaceFolders?: (cb: () => void) => { dispose(): void };
};

let repo: string;
let storage: string;
let originalFolders: unknown;
let mgr: CheckpointManager;

function gitDirFor(root: string): string {
  const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(storage, CHECKPOINTS_DIR, hash, 'git');
}

function shadowGit(args: string[]): string {
  return execFileSync('git', [`--git-dir=${gitDirFor(repo)}`, `--work-tree=${repo}`, ...args], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolves(sha: string): boolean {
  try { return shadowGit(['cat-file', '-t', sha]).trim() === 'commit'; } catch { return false; }
}

function checkpointRefs(): string[] {
  return shadowGit(['for-each-ref', '--format=%(refname)', 'refs/mysti/checkpoints/'])
    .split('\n').map(l => l.trim()).filter(Boolean);
}

async function takeSnapshots(n: number, from = 1): Promise<string[]> {
  const out: string[] = [];
  for (let i = from; i < from + n; i++) {
    fs.writeFileSync(path.join(repo, 'turn.txt'), `turn ${i}\n`);
    const sha = await mgr.snapshot(`turn ${i}`);
    expect(sha, `snapshot ${i} should commit`).toBeTruthy();
    out.push(sha as string);
  }
  return out;
}

describe('checkpoint retention honours mysti.checkpoints.maxSnapshots', () => {
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ckpt-wt-')));
    storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ckpt-gs-')));
    originalFolders = ws.workspaceFolders;
    ws.workspaceFolders = [{ uri: { fsPath: repo }, name: 'test', index: 0 }];
    // The real vscode API the manager subscribes to; the shared mock has no
    // workspace-folder event, so supply one rather than editing shared helpers.
    ws.onDidChangeWorkspaceFolders = () => ({ dispose: () => { /* noop */ } });
    clearMockConfig();
    mgr = new CheckpointManager({
      globalStorageUri: { fsPath: storage },
    } as unknown as ConstructorParameters<typeof CheckpointManager>[0]);
  });

  afterEach(() => {
    mgr.dispose();
    ws.workspaceFolders = originalFolders;
    clearMockConfig();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(storage, { recursive: true, force: true });
  });

  it('prunes the oldest beyond the cap and keeps the newest rewindable', async () => {
    setMockConfig('checkpoints.maxSnapshots', 3);
    const shas = await takeSnapshots(5);

    expect(checkpointRefs()).toHaveLength(3);
    // The two oldest are gone from the object store, so a stale rewind button
    // fails the `cat-file` probe and reports "Checkpoint no longer exists."
    expect(resolves(shas[0])).toBe(false);
    expect(resolves(shas[1])).toBe(false);
    // Every retained checkpoint kept its ORIGINAL sha — pruning must not
    // rewrite history, or every rewind target in the conversation would break.
    expect(resolves(shas[2])).toBe(true);
    expect(resolves(shas[3])).toBe(true);
    expect(resolves(shas[4])).toBe(true);

    const stale = await mgr.rewindTo(shas[0]);
    expect(stale).toEqual({ ok: false, reason: 'Checkpoint no longer exists.' });

    const rewound = await mgr.rewindTo(shas[2]);
    expect(rewound.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'turn.txt'), 'utf8')).toBe('turn 3\n');
  }, 120_000);

  it('treats 0 as unlimited', async () => {
    setMockConfig('checkpoints.maxSnapshots', 0);
    const shas = await takeSnapshots(4);
    expect(checkpointRefs()).toHaveLength(4);
    for (const sha of shas) { expect(resolves(sha)).toBe(true); }
  }, 120_000);

  it('keeps history taken by an older build that chained its commits', async () => {
    setMockConfig('checkpoints.maxSnapshots', 5);
    // Simulate the pre-fix on-disk state: a repo whose checkpoints are a chain
    // reachable only from HEAD, with no per-checkpoint refs.
    await mgr.snapshot('bootstrap');
    fs.rmSync(path.join(gitDirFor(repo), 'refs', 'mysti'), { recursive: true, force: true });
    fs.writeFileSync(path.join(repo, 'legacy.txt'), 'legacy\n');
    shadowGit(['add', '-A']);
    shadowGit(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'legacy turn']);
    const legacy = shadowGit(['rev-parse', 'HEAD']).trim();
    expect(checkpointRefs()).toHaveLength(0);

    await takeSnapshots(2);
    // The legacy chain is adopted as the oldest checkpoint instead of being
    // orphaned and collected by the first prune.
    expect(resolves(legacy)).toBe(true);
    expect(checkpointRefs()).toHaveLength(3);
  }, 120_000);

  it('each snapshot restores its own content independently', async () => {
    setMockConfig('checkpoints.maxSnapshots', 10);
    const shas = await takeSnapshots(3);
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'created after the checkpoint\n');
    const r = await mgr.rewindTo(shas[0]);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'turn.txt'), 'utf8')).toBe('turn 1\n');
    expect(fs.existsSync(path.join(repo, 'scratch.txt'))).toBe(false);
  }, 120_000);
});
