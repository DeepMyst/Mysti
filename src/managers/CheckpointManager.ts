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
 * Default ignore rules for the shadow repo, written to <gitDir>/info/exclude.
 * The user's own nested .gitignore files are honored natively by `git add -A`
 * against the work-tree; this is the safety net for repos that don't ignore
 * these (or have no .gitignore at all) so we never snapshot heavy/junk paths.
 */
const SHADOW_EXCLUDE = `# Mysti shadow-repo excludes — never snapshot these
.git/
.mysti/
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

  public dispose(): void {
    for (const d of this._disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this._disposables.length = 0;
  }

  // --- Snapshot / rewind implementations (run inside _opQueue) ------------

  private async _snapshotImpl(label: string, allowHeal: boolean): Promise<string | null> {
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
      await this._runGitOrThrow([
        '-c', `user.name=${CHECKPOINT_AUTHOR_NAME}`,
        '-c', `user.email=${CHECKPOINT_AUTHOR_EMAIL}`,
        'commit', '--allow-empty', '--no-verify', '--no-gpg-sign',
        '-m', label && label.trim() ? label.slice(0, 200) : 'checkpoint'
      ]);
      const head = await this._runGitOrThrow(['rev-parse', 'HEAD']);
      return head.stdout.trim() || null;
    } catch (err) {
      if (allowHeal && this._looksCorrupt(err)) {
        console.log('[Mysti] CheckpointManager: repo unhealthy, reinitializing.', err);
        await this._heal();
        return this._snapshotImpl(label, false);
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
      const safetyCommit = await this._snapshotImpl('pre-rewind safety snapshot', true);

      await this._runGitOrThrow(['reset', '--hard', commit]);
      // clean -fd (NOT -x): remove files created after the checkpoint while
      // honoring .gitignore + info/exclude (never nukes node_modules etc.).
      await this._runGitOrThrow(['clean', '-fd']);

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
