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
 *
 * Plan 28 Phase 4 — the shadow-repo diff the Changes dock is built on.
 *
 * The dock's safety claim is that the FILE LIST AND LINE COUNTS COME FROM DISK,
 * never from what a model said it did. That makes this parse the load-bearing
 * part: a file an agent claimed but did not touch must not appear, and a file
 * changed with no tool call behind it must appear so it can be shown as the
 * user's own and kept away from any revert.
 *
 * `-z` is why the parse is trustworthy. Without it git QUOTES any path with a
 * space or a non-ASCII byte (`"src/a b.ts"`, `"src/caf\\303\\251.ts"`) and the
 * escaping would have to be undone by hand — one of the classic ways a
 * file-listing tool ends up acting on the wrong path. The first suite pins the
 * format against real git so a future flag change cannot silently break it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseShadowDiff } from '../../src/managers/CheckpointManager';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('parseShadowDiff — against real git output', () => {
  let repo: string;
  let base: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-diff-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    write(path.join(repo, 'keep.txt'), 'a\nb\nc\n');
    write(path.join(repo, 'gone.txt'), 'x\n');
    write(path.join(repo, 'odd name.txt'), 'y\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    base = git(repo, ['rev-parse', 'HEAD']).trim();
  });

  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  function diffNow() {
    git(repo, ['add', '-A']);
    const numstat = git(repo, ['diff', '--numstat', '--no-renames', '-z', '--cached', base, '--']);
    const nameStatus = git(repo, ['diff', '--name-status', '--no-renames', '-z', '--cached', base, '--']);
    return parseShadowDiff(numstat, nameStatus);
  }

  it('reports adds, edits and deletes with their line counts', () => {
    write(path.join(repo, 'keep.txt'), 'a\nb\nc\nd\n');   // +1
    write(path.join(repo, 'added.txt'), 'n\n');            // new
    fs.rmSync(path.join(repo, 'gone.txt'));                // deleted
    const byPath = new Map(diffNow().map((c) => [c.path, c]));

    expect(byPath.get('keep.txt')).toMatchObject({ added: 1, removed: 0, status: 'M' });
    expect(byPath.get('added.txt')).toMatchObject({ added: 1, removed: 0, status: 'A' });
    expect(byPath.get('gone.txt')).toMatchObject({ added: 0, removed: 1, status: 'D' });
  });

  it('carries a path with a space through intact — the reason for -z', () => {
    write(path.join(repo, 'odd name.txt'), 'y\nz\n');
    const paths = diffNow().map((c) => c.path);
    expect(paths).toContain('odd name.txt');
    // Never the quoted spelling git emits without -z.
    expect(paths.some((p) => p.startsWith('"'))).toBe(false);
  });

  it('carries a non-ASCII path through intact', () => {
    write(path.join(repo, 'café.txt'), 'crème\n');
    expect(diffNow().map((c) => c.path)).toContain('café.txt');
  });

  it('sees an untracked file, because staging is what makes it visible', () => {
    write(path.join(repo, 'brand-new.ts'), 'export {};\n');
    expect(diffNow().map((c) => c.path)).toContain('brand-new.ts');
  });

  it('reports a binary file as -1/-1 rather than guessing a line count', () => {
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    const bin = diffNow().find((c) => c.path === 'blob.bin');
    expect(bin).toBeTruthy();
    expect(bin!.added).toBe(-1);
    expect(bin!.removed).toBe(-1);
  });

  it('finds nothing when nothing changed', () => {
    expect(diffNow()).toEqual([]);
  });
});

describe('parseShadowDiff — malformed input is dropped, never guessed', () => {
  it('ignores records that are not a numstat triple', () => {
    expect(parseShadowDiff('garbage\0', '')).toEqual([]);
    expect(parseShadowDiff('1\t2\0', '')).toEqual([]);
    expect(parseShadowDiff('', '')).toEqual([]);
  });

  it('defaults to modified when name-status says nothing about a path', () => {
    expect(parseShadowDiff('3\t1\tsrc/a.ts\0', '')).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1, status: 'M' },
    ]);
  });

  it('keeps a tab inside a path attached to the path', () => {
    // Only the first two fields are counts; everything after is the name.
    expect(parseShadowDiff('1\t0\tweird\tname.ts\0', '')[0].path).toBe('weird\tname.ts');
  });

  it('ignores a status code it does not understand', () => {
    const out = parseShadowDiff('1\t0\tx.ts\0', 'X\0x.ts\0');
    expect(out[0].status).toBe('M');
  });
});
