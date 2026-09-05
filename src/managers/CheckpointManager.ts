/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { getEnrichedEnv } from '../utils/platform';
import {
  CHECKPOINTS_DIR,
  CHECKPOINT_AUTHOR_NAME,
  CHECKPOINT_AUTHOR_EMAIL,
  CHECKPOINT_DEFAULT_MAX_FILES,
  CHECKPOINT_GIT_TIMEOUT_MS
} from '../constants';

/** Result of a rewind operation. */
export type RewindResult =
  | { ok: true; safetyCommit: string | null }
  | { ok: false; reason: string };

/**
 * Agent-artifact trees force-added on every snapshot (Plan 20 Phase 0).
 *
 * `info/exclude` and the user's own `.gitignore` are consulted independently,
 * and most projects ignore `.mysti/` wholesale — so the negations in
 * SHADOW_EXCLUDE are necessary but not sufficient. Kept in sync with them.
 */
export const CHECKPOINT_FORCED_PATHS = ['.mysti/agents', '.mysti/skills.staged'] as const;

/**
 * Retention cap for `mysti.checkpoints.maxSnapshots` (0 = unlimited). Mirrors
 * the default declared in package.json; kept here rather than in constants.ts
 * so the cap and the code that enforces it cannot drift apart unnoticed.
 */
export const CHECKPOINT_DEFAULT_MAX_SNAPSHOTS = 200;

/**
 * Plan 28 Phase 4 — one changed file, as the shadow repo sees it.
 *
 * `added`/`removed` are -1 for a binary file, which is what git reports as
 * `-`/`-`. `status` is git's own: added, modified or deleted. Renames are
 * deliberately NOT detected (`--no-renames`) — a rename shows as a delete plus
 * an add, which is the honest thing to put in front of someone deciding what
 * to keep, and it keeps the numstat records unambiguous to parse.
 */
export interface ShadowFileChange {
  path: string;
  added: number;
  removed: number;
  status: 'A' | 'M' | 'D';
}

/**
 * Parse `git diff --numstat -z` + `git diff --name-status -z` into one list.
 *
 * Pure, and exported so it can be tested without a workspace. `-z` matters:
 * without it git QUOTES paths containing spaces or non-ASCII, and the quoting
 * would have to be un-escaped by hand. With it, numstat records are
 * `added\tremoved\tpath\0` and name-status records alternate
 * `status\0path\0`, both unambiguous.
 */
export function parseShadowDiff(numstatZ: string, nameStatusZ: string): ShadowFileChange[] {
  const status = new Map<string, 'A' | 'M' | 'D'>();
  const statusFields = nameStatusZ.split('\0').filter((f) => f !== '');
  for (let i = 0; i + 1 < statusFields.length; i += 2) {
    const code = statusFields[i].charAt(0);
    if (code === 'A' || code === 'M' || code === 'D') {
      status.set(statusFields[i + 1], code);
    }
  }

  const out: ShadowFileChange[] = [];
  for (const record of numstatZ.split('\0')) {
    if (record === '') { continue; }
    const parts = record.split('\t');
    if (parts.length < 3) { continue; }
    // A path may itself contain a tab; only the first two fields are counts.
    const filePath = parts.slice(2).join('\t');
    const added = parts[0] === '-' ? -1 : Number.parseInt(parts[0], 10);
    const removed = parts[1] === '-' ? -1 : Number.parseInt(parts[1], 10);
    if (!filePath || Number.isNaN(added) || Number.isNaN(removed)) { continue; }
    out.push({ path: filePath, added, removed, status: status.get(filePath) ?? 'M' });
  }
  return out;
}

/**
 * One ref per checkpoint, ordered by a zero-padded counter.
 *
 * Snapshots are parentless ROOT commits held alive by these refs, not a single
 * linear chain. That is what makes the cap enforceable: git's history is a
 * Merkle chain, so dropping the oldest commit of a chain rewrites every
 * descendant's SHA — which would invalidate the rewind target stored on every
 * message in the conversation, not just the pruned ones. Independent roots let
 * the oldest refs be deleted and garbage-collected while every retained
 * checkpoint keeps the exact SHA the UI already holds.
 */
const CHECKPOINT_REF_PREFIX = 'refs/mysti/checkpoints/';
const CHECKPOINT_REF_PAD = 12;

/**
 * Default ignore rules for the shadow repo, written to <gitDir>/info/exclude.
 * The user's own nested .gitignore files are honored natively by `git add -A`
 * against the work-tree; this is the safety net for repos that don't ignore
 * these (or have no .gitignore at all) so we never snapshot heavy/junk paths.
 */
export const SHADOW_EXCLUDE = `# Mysti shadow-repo excludes — never snapshot these
.git/
# Plan 20 Phase 0: .mysti/ is excluded by CONTENTS (.mysti/*), not as a
# directory, so the agent-artifact trees below can be re-included. Excluding
# the directory itself would make the negations unreachable (git never
# descends into an excluded directory), and agent-authored personas/skills
# MUST be rewindable — they are the highest-consequence bytes the agent can
# write. Everything else under .mysti/ (compaction caches, run scratch,
# captured output) stays excluded.
.mysti/*
!.mysti/agents/
!.mysti/skills.staged/
node_modules/
bower_components/
.pnpm-store/
dist/
build/
out/
.next/
.nuxt/
.svelte-kit/
.turbo/
.cache/
coverage/
.venv/
venv/
__pycache__/
*.pyc
target/
vendor/
.gradle/
.idea/
.DS_Store
Thumbs.db
*.log
# large / binary junk
*.zip
*.tar
*.tar.gz
*.tgz
*.7z
*.rar
*.iso
*.dmg
*.exe
*.dll
*.so
*.dylib
*.bin
*.mp4
*.mov
*.avi
*.mkv
*.psd
*.sketch
`;

/**
 * CheckpointManager — a shadow git repository that snapshots the workspace
 * before each chat turn so the user can "rewind code to here".
 *
 * The git-dir lives under the extension's globalStorage (keyed by a hash of the
 * workspace root, so multiple workspaces never collide) while the work-tree is
 * the workspace root itself. Because the git-dir is never inside the workspace
 * and every command passes --git-dir/--work-tree explicitly, the shadow repo is
 * fully invisible to (and never touches) the user's own .git.
 *
 * All index-touching ops are serialized through a single promise chain so two
 * rapid turns — or a snapshot racing a rewind — never corrupt index.lock.
 */
export class CheckpointManager {
  private readonly _context: vscode.ExtensionContext;

  private _gitDir: string | null = null;
  private _workTree: string | null = null;
  private _initialized = false;
  private _initRoot: string | null = null;
  private _gitAvailable: boolean | null = null;
  /** Latched once so we don't spam the log when a huge repo keeps getting skipped. */
  private _warnedOverCap = false;

  private _opQueue: Promise<unknown> = Promise.resolve();
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    // A workspace-folder change invalidates the resolved root/repo.
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._initialized = false;
        this._initRoot = null;
        this._gitDir = null;
        this._workTree = null;
        this._warnedOverCap = false;
      })
    );
  }

  // --- Public API --------------------------------------------------------

  /** True when the feature is enabled, a workspace is open, and git is installed. */
  public async isAvailable(): Promise<boolean> {
    if (!this._enabled()) { return false; }
    if (!this._workspaceRoot()) { return false; }
    return this._gitInstalled();
  }

  /**
   * Commit the current work-tree as a checkpoint. Returns the commit SHA, or
   * null when unavailable / disabled / over the file cap. Never throws.
   */
  public async snapshot(label: string): Promise<string | null> {
    if (!(await this.isAvailable())) { return null; }
    return this._enqueue(() => this._snapshotImpl(label, true));
  }

  /**
   * Restore the work-tree to exactly match `commit`: reverts modifications,
   * re-creates deleted files, and removes files created after the checkpoint
   * (honoring excludes — never deletes node_modules/ignored paths). Takes a
   * safety snapshot first so the rewind itself is undoable.
   */
  public async rewindTo(commit: string): Promise<RewindResult> {
    if (!(await this.isAvailable())) {
      return { ok: false, reason: 'Checkpoints are unavailable (git not found or feature disabled).' };
    }
    return this._enqueue(() => this._rewindImpl(commit));
  }

  /**
   * Plan 28 Phase 4 — every file that differs between `commit` and the CURRENT
   * work tree, with line counts. Never throws; null when checkpoints are
   * unavailable, so the caller degrades to no Changes dock rather than an error.
   *
   * Staging first (`add -A`) is what makes untracked files visible to the diff,
   * exactly as `_snapshotImpl` does. It touches only the SHADOW index — the
   * --git-dir points at Mysti's own repo, never the user's — so this cannot
   * disturb a staged change the user was preparing.
   */
  public async diffSince(commit: string): Promise<ShadowFileChange[] | null> {
    // The SHA reaches us from a persisted conversation. Anything that is not
    // plainly a hex object name is refused rather than handed to git, where a
    // leading dash would be read as an option.
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) { return null; }
    if (!(await this.isAvailable())) { return null; }
    return this._enqueue(() => this._diffSinceImpl(commit));
  }

  private async _diffSinceImpl(commit: string): Promise<ShadowFileChange[] | null> {
    try {
      await this.ensureRepo();
      await this._runGit(['add', '-A']);
      const numstat = await this._runGit(
        ['diff', '--numstat', '--no-renames', '-z', '--cached', commit, '--']);
      if (numstat.code !== 0) { return null; }
      const nameStatus = await this._runGit(
        ['diff', '--name-status', '--no-renames', '-z', '--cached', commit, '--']);
      return parseShadowDiff(numstat.stdout, nameStatus.code === 0 ? nameStatus.stdout : '');
    } catch {
      return null;
    }
  }

  public dispose(): void {
    for (const d of this._disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this._disposables.length = 0;
  }

  // --- Snapshot / rewind implementations (run inside _opQueue) ------------

  /**
   * `prune = false` is used by the pre-rewind safety snapshot: pruning there
   * can delete the very checkpoint the rewind is about to restore (the target
   * becomes the oldest once the safety snapshot pushes the count over the cap),
   * which turned a valid rewind into "Checkpoint no longer exists." The rewind
   * prunes once it has finished instead.
   */
  private async _snapshotImpl(label: string, allowHeal: boolean, prune = true): Promise<string | null> {
    try {
      await this.ensureRepo();
      await this._clearStaleLock();

      if (await this._overFileCap()) {
        if (!this._warnedOverCap) {
          this._warnedOverCap = true;
          console.log('[Mysti] CheckpointManager: workspace exceeds maxFiles; skipping snapshots.');
        }
        return null;
      }

      await this._runGitOrThrow(['add', '-A']);
      // Plan 20 Phase 0: `add -A` also honors the USER's .gitignore, and most
      // projects gitignore `.mysti/` wholesale — which would silently undo the
      // shadow-exclude carve-out above. Force-add the agent-artifact trees so a
      // bad persona/skill is genuinely rewindable. Non-throwing and pathspec-
      // tolerant: these directories usually do not exist.
      for (const artifactPath of CHECKPOINT_FORCED_PATHS) {
        await this._runGit(['add', '-A', '-f', '--', artifactPath]);
      }
      // Preserve any pre-existing chained history from an older Mysti build:
      // once HEAD starts moving to root commits, that chain is reachable from
      // nothing and the first gc would delete every checkpoint the user has.
      const existing = await this._listSnapshotRefs();
      if (existing.length === 0) {
        const priorHead = await this._runGit(['rev-parse', '--verify', '--quiet', 'HEAD']);
        const priorSha = priorHead.code === 0 ? priorHead.stdout.trim() : '';
        if (priorSha) {
          await this._runGit(['update-ref', this._snapshotRef(0), priorSha]);
          existing.push(this._snapshotRef(0));
        }
      }

      const tree = (await this._runGitOrThrow(['write-tree'])).stdout.trim();
      const sha = (await this._runGitOrThrow([
        '-c', `user.name=${CHECKPOINT_AUTHOR_NAME}`,
        '-c', `user.email=${CHECKPOINT_AUTHOR_EMAIL}`,
        '-c', 'commit.gpgsign=false',
        'commit-tree', tree,
        '-m', label && label.trim() ? label.slice(0, 200) : 'checkpoint'
      ])).stdout.trim();
      if (!sha) { return null; }

      await this._runGitOrThrow(['update-ref', this._nextSnapshotRef(existing), sha]);
      // HEAD tracks the newest checkpoint so `add -A` and `reset --hard` behave
      // exactly as before; the per-checkpoint refs are what keep the rest alive.
      await this._runGitOrThrow(['update-ref', 'HEAD', sha]);
      if (prune) { await this._pruneSnapshots(); }
      return sha;
    } catch (err) {
      if (allowHeal && this._looksCorrupt(err)) {
        console.log('[Mysti] CheckpointManager: repo unhealthy, reinitializing.', err);
        await this._heal();
        return this._snapshotImpl(label, false, prune);
      }
      console.log('[Mysti] CheckpointManager: snapshot failed:', err);
      return null;
    }
  }

  private async _rewindImpl(commit: string): Promise<RewindResult> {
    try {
      await this.ensureRepo();
      await this._clearStaleLock();

      // Validate the commit exists before doing anything destructive.
      const probe = await this._runGit(['cat-file', '-t', commit]);
      if (probe.code !== 0 || probe.stdout.trim() !== 'commit') {
        return { ok: false, reason: 'Checkpoint no longer exists.' };
      }

      // Safety snapshot first so the rewind can itself be undone.
      const safetyCommit = await this._snapshotImpl('pre-rewind safety snapshot', true, false);

      await this._runGitOrThrow(['reset', '--hard', commit]);
      // clean -fd (NOT -x): remove files created after the checkpoint while
      // honoring .gitignore + info/exclude (never nukes node_modules etc.).
      await this._runGitOrThrow(['clean', '-fd']);

      // Deferred from the safety snapshot above, now that the restore is done.
      await this._pruneSnapshots();
      return { ok: true, safetyCommit };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log('[Mysti] CheckpointManager: rewind failed:', err);
      return { ok: false, reason };
    }
  }

  // --- Repo lifecycle ----------------------------------------------------

  /** Lazily initialize the shadow repo. Throws on no-workspace / git-missing. */
  public async ensureRepo(): Promise<void> {
    const root = this._workspaceRoot();
    if (!root) { throw new Error('no-workspace'); }
    if (this._initialized && this._initRoot === root) { return; }
    if (!(await this._gitInstalled())) { throw new Error('git-missing'); }

    const gitDir = this._gitDirFor(root);
    await fs.promises.mkdir(gitDir, { recursive: true });

    // Set these before any _runGit call (which reads them).
    this._gitDir = gitDir;
    this._workTree = root;

    const headExists = await this._pathExists(path.join(gitDir, 'HEAD'));
    if (!headExists) {
      await this._runGitOrThrow(['init']);
      await this._runGitOrThrow(['config', 'core.worktree', root]);
      await this._runGitOrThrow(['config', 'commit.gpgsign', 'false']);
      await this._runGitOrThrow(['config', 'core.autocrlf', 'false']);
      await this._runGitOrThrow(['config', 'user.name', CHECKPOINT_AUTHOR_NAME]);
      await this._runGitOrThrow(['config', 'user.email', CHECKPOINT_AUTHOR_EMAIL]);
    }

    // Always (re)write excludes so upgrades pick up new defaults.
    await fs.promises.mkdir(path.join(gitDir, 'info'), { recursive: true });
    await fs.promises.writeFile(path.join(gitDir, 'info', 'exclude'), SHADOW_EXCLUDE, 'utf8');

    this._initialized = true;
    this._initRoot = root;
  }

  /** Delete the shadow git-dir and reset state so the next op re-inits it. */
  private async _heal(): Promise<void> {
    const dir = this._gitDir;
    this._initialized = false;
    this._initRoot = null;
    if (dir) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.log('[Mysti] CheckpointManager: failed to remove unhealthy git-dir:', err);
      }
    }
  }

  // --- Helpers -----------------------------------------------------------

  private _enabled(): boolean {
    return vscode.workspace.getConfiguration('mysti').get<boolean>('checkpoints.enabled', true);
  }

  private _maxFiles(): number {
    return vscode.workspace
      .getConfiguration('mysti')
      .get<number>('checkpoints.maxFiles', CHECKPOINT_DEFAULT_MAX_FILES);
  }

  /**
   * `mysti.checkpoints.maxSnapshots` — retained checkpoints per workspace.
   * 0 (or a nonsense value) means unlimited. Until this was read, the Settings
   * UI advertised a cap of 200 that nothing anywhere enforced.
   */
  private _maxSnapshots(): number {
    const raw = vscode.workspace
      .getConfiguration('mysti')
      .get<number>('checkpoints.maxSnapshots', CHECKPOINT_DEFAULT_MAX_SNAPSHOTS);
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      return CHECKPOINT_DEFAULT_MAX_SNAPSHOTS;
    }
    return Math.floor(raw);
  }

  private _snapshotRef(index: number): string {
    return `${CHECKPOINT_REF_PREFIX}${String(index).padStart(CHECKPOINT_REF_PAD, '0')}`;
  }

  /** Checkpoint refs, oldest first (for-each-ref sorts by refname). */
  private async _listSnapshotRefs(): Promise<string[]> {
    const res = await this._runGit(['for-each-ref', '--format=%(refname)', CHECKPOINT_REF_PREFIX]);
    if (res.code !== 0) { return []; }
    return res.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  }

  private _nextSnapshotRef(existing: string[]): string {
    let max = -1;
    for (const ref of existing) {
      const n = Number.parseInt(ref.slice(CHECKPOINT_REF_PREFIX.length), 10);
      if (Number.isFinite(n) && n > max) { max = n; }
    }
    return this._snapshotRef(max + 1);
  }

  /**
   * Drop the oldest checkpoints beyond the cap and reclaim their objects.
   * Best-effort: a failed prune must never fail the snapshot that triggered it.
   */
  private async _pruneSnapshots(): Promise<void> {
    const cap = this._maxSnapshots();
    if (cap <= 0) { return; }
    const refs = await this._listSnapshotRefs();
    if (refs.length <= cap) { return; }
    for (const ref of refs.slice(0, refs.length - cap)) {
      await this._runGit(['update-ref', '-d', ref]);
    }
    // Without expiring the reflogs the pruned commits stay reachable from
    // HEAD's log and gc keeps every object — the cap would bound the ref count
    // and nothing else.
    await this._runGit(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
    await this._runGit(['gc', '--prune=now', '--quiet']);
  }

  private _workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private _gitDirFor(root: string): string {
    const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
    return path.join(this._context.globalStorageUri.fsPath, CHECKPOINTS_DIR, hash, 'git');
  }

  private async _gitInstalled(): Promise<boolean> {
    if (this._gitAvailable !== null) { return this._gitAvailable; }
    const res = await this._spawnGit(['--version'], 5000, undefined);
    this._gitAvailable = res.code === 0;
    return this._gitAvailable;
  }

  /** Cheap proxy for snapshot size: count non-ignored + tracked files. */
  private async _overFileCap(): Promise<boolean> {
    const cap = this._maxFiles();
    if (!cap || cap <= 0) { return false; }
    const res = await this._runGit(['ls-files', '--others', '--exclude-standard', '--cached']);
    if (res.code !== 0) { return false; } // don't block snapshots on a probe failure
    const count = res.stdout ? res.stdout.split('\n').filter(Boolean).length : 0;
    return count > cap;
  }

  private async _clearStaleLock(): Promise<void> {
    // Safe because all our index-touching ops are serialized: any lingering
    // index.lock is necessarily stale.
    if (!this._gitDir) { return; }
    try {
      await fs.promises.rm(path.join(this._gitDir, 'index.lock'), { force: true });
    } catch { /* ignore */ }
  }

  private _looksCorrupt(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes('not a git repository') ||
      msg.includes('bad object') ||
      msg.includes('unable to read') ||
      msg.includes('object file') ||
      msg.includes('corrupt')
    );
  }

  private async _pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Run a shadow-git subcommand, prepending --git-dir/--work-tree. */
  private _runGit(subArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this._gitDir || !this._workTree) {
      return Promise.resolve({ code: 1, stdout: '', stderr: 'shadow repo not initialized' });
    }
    const args = [`--git-dir=${this._gitDir}`, `--work-tree=${this._workTree}`, ...subArgs];
    return this._spawnGit(args, CHECKPOINT_GIT_TIMEOUT_MS, this._workTree);
  }

  private async _runGitOrThrow(subArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const res = await this._runGit(subArgs);
    if (res.code !== 0) {
      throw new Error(`git ${subArgs.join(' ')} failed: ${res.stderr || res.stdout || `exit ${res.code}`}`);
    }
    return res;
  }

  private _spawnGit(
    args: string[],
    timeoutMs: number,
    cwd: string | undefined
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn('git', args, {
          cwd,
          env: getEnrichedEnv() as NodeJS.ProcessEnv,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        resolve({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
        return;
      }

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        resolve({ code: 1, stdout, stderr: stderr || 'git command timed out' });
      }, timeoutMs);

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: err.message });
      });
    });
  }

  /** Serialize all index-touching ops through one promise chain. */
  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._opQueue.then(fn, fn);
    this._opQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
