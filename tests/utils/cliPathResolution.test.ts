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
 * Mysti must run the same CLI the user's shell runs.
 *
 * It did not. `_discoverCliCommon` walked a list of hard-coded guesses headed
 * by `/usr/local/bin` and only consulted PATH if every one of them missed, and
 * `getCliPath()` — the synchronous getter the SPAWN uses — walked that list
 * again on its own. The two disagree the moment a CLI lives anywhere else.
 *
 * Observed on a real machine: Claude Code's own installer puts the current
 * build in `~/.local/bin` (first on PATH), while an old `npm i -g` copy stayed
 * behind at `/usr/local/bin`. `claude --version` in a terminal said 2.1.263 and
 * reported 53 slash commands including `/design`; Mysti drove the stale 2.0.71,
 * which reports 8 and has no `/design` at all. Upgrading the CLI changed
 * nothing, because Mysti never looked at the upgraded one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getPriorityCliPaths, getCommonSearchPaths, resolveCommandOnPath, getResolutionEnv, getEnrichedEnv } from '../../src/utils/platform';

describe('getPriorityCliPaths', () => {
  /**
   * Only two things outrank the user's PATH: a path they configured by hand,
   * and a location the provider itself declares. Everything else is a guess.
   */
  it('returns only the configured path and provider-declared locations', () => {
    expect(getPriorityCliPaths({
      commandName: 'claude',
      configuredPath: '/opt/custom/claude',
      additionalPaths: ['/Applications/Codex.app/bin/codex'],
    })).toEqual(['/opt/custom/claude', '/Applications/Codex.app/bin/codex']);
  });

  it('treats a configured path equal to the bare name as unset', () => {
    expect(getPriorityCliPaths({ commandName: 'claude', configuredPath: 'claude' })).toEqual([]);
    expect(getPriorityCliPaths({ commandName: 'claude' })).toEqual([]);
  });

  /**
   * The guess list still contains /usr/local/bin ahead of ~/.local/bin, which
   * is exactly why it must not be consulted before PATH.
   */
  it('is a strict subset of the full guess list, which PATH now outranks', () => {
    const priority = getPriorityCliPaths({ commandName: 'claude' });
    const all = getCommonSearchPaths({ commandName: 'claude' });
    expect(priority.length).toBeLessThan(all.length);

    if (process.platform !== 'win32') {
      const usrLocal = all.indexOf('/usr/local/bin/claude');
      const dotLocal = all.indexOf(path.join(os.homedir(), '.local', 'bin', 'claude'));
      expect(usrLocal).toBeGreaterThanOrEqual(0);
      expect(dotLocal).toBeGreaterThanOrEqual(0);
      // Documents the ordering that caused the bug: without the PATH probe in
      // front, a stale /usr/local copy beats a current ~/.local one.
      expect(usrLocal).toBeLessThan(dotLocal);
    }
  });
});

describe('getResolutionEnv', () => {
  /**
   * The bug that made the PATH-first fix a no-op. `getEnrichedEnv()` PREPENDS
   * /usr/local/bin so a `#!/usr/bin/env node` shebang resolves in a
   * GUI-launched host — correct for spawning, but it inverts the user's own
   * PATH order. Probing with it resolved `claude` to the stale 2.0.71 in
   * /usr/local/bin while the user's shell ran 2.1.263 from ~/.local/bin.
   */
  it('keeps the user\'s PATH order ahead of the fallback directories', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    // A real PATH repeats entries, so compare against the de-duplicated form.
    const userPath = [...new Set((process.env.PATH || '').split(sep).filter(Boolean))];
    const resolved = (getResolutionEnv().PATH || '').split(sep).filter(Boolean);
    // The user's entries come first, in their original order.
    expect(resolved.slice(0, userPath.length)).toEqual(userPath);
  });

  it('still contains everything the enriched env would have added', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const enriched = new Set((getEnrichedEnv().PATH || '').split(sep).filter(Boolean));
    const resolved = new Set((getResolutionEnv().PATH || '').split(sep).filter(Boolean));
    for (const dir of enriched) {
      expect(resolved.has(dir), `${dir} was dropped from the resolution PATH`).toBe(true);
    }
  });

  it('does not repeat a directory that was already on the user PATH', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const resolved = (getResolutionEnv().PATH || '').split(sep).filter(Boolean);
    expect(new Set(resolved).size).toBe(resolved.length);
  });
});

describe('resolveCommandOnPath', () => {
  it('resolves a real command to an absolute path', async () => {
    // Exercise the real locator with a known executable and a bounded search
    // path. A runner's unrelated tool directories are not part of this contract.
    const systemPaths = process.platform === 'win32'
      ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')]
      : ['/usr/bin', '/bin'];
    const resolved = await resolveCommandOnPath(path.basename(process.execPath), {
      ...process.env,
      PATH: [path.dirname(process.execPath), ...systemPaths].join(path.delimiter),
    });
    expect(resolved).toBeTruthy();
    expect(path.isAbsolute(resolved!)).toBe(true);
    expect(fs.realpathSync.native(resolved!)).toBe(fs.realpathSync.native(process.execPath));
  });

  it('returns null for a command that does not exist', async () => {
    // Bounded like the positive case: `where` over a hosted Windows runner's
    // full PATH can exceed the test timeout on a miss.
    const env = { ...process.env, PATH: path.dirname(process.execPath) };
    expect(await resolveCommandOnPath('mysti-definitely-not-a-real-binary-xyz', env)).toBeNull();
  });

  /** A path is already resolved; handing it to `which` would be meaningless. */
  it('returns null for anything that is already a path', async () => {
    expect(await resolveCommandOnPath('/usr/bin/env')).toBeNull();
    expect(await resolveCommandOnPath('./local-thing')).toBeNull();
  });
});

describe('discovery prefers PATH over the hard-coded guesses', () => {
  let dir: string;
  let onPathBin: string;
  let guessBin: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cli-'));
    onPathBin = path.join(dir, 'onpath');
    guessBin = path.join(dir, 'guess');
    fs.mkdirSync(onPathBin);
    fs.mkdirSync(guessBin);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The end-to-end property, with two real executables standing in for the two
   * real Claude Code installs: the one on PATH must win, even though the other
   * sits in a directory the guess list would reach first.
   */
  it('runs the binary the shell resolves, not the one a guess would find first', async () => {
    const name = `mysti-test-cli-${process.pid}`;
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const preferred = path.join(onPathBin, name + suffix);
    const stale = path.join(guessBin, name + suffix);
    for (const [file, tag] of [[preferred, 'NEW'], [stale, 'OLD']] as const) {
      fs.writeFileSync(file, process.platform === 'win32' ? `@echo ${tag}\r\n` : `#!/bin/sh\necho ${tag}\n`);
      fs.chmodSync(file, 0o755);
    }

    // Both directories are searchable; the "preferred" one comes first, exactly
    // as ~/.local/bin precedes /usr/local/bin on the machine where this bit.
    // The system PATH stays on the end — `which` itself has to be findable.
    const resolved = await resolveCommandOnPath(name, {
      ...process.env,
      PATH: [onPathBin, guessBin, process.env.PATH ?? ''].join(path.delimiter),
    });
    expect(fs.realpathSync.native(resolved!)).toBe(fs.realpathSync.native(preferred));
    expect(fs.realpathSync.native(resolved!)).not.toBe(fs.realpathSync.native(stale));
  });

  /** Reversing PATH reverses the winner — it really is PATH doing the work. */
  it('follows PATH order rather than a fixed preference', async () => {
    const name = `mysti-test-order-${process.pid}`;
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const a = path.join(onPathBin, name + suffix);
    const b = path.join(guessBin, name + suffix);
    for (const file of [a, b]) {
      fs.writeFileSync(file, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
      fs.chmodSync(file, 0o755);
    }
    const sys = process.env.PATH ?? '';
    expect(fs.realpathSync.native((await resolveCommandOnPath(name, { ...process.env, PATH: [onPathBin, guessBin, sys].join(path.delimiter) }))!)).toBe(fs.realpathSync.native(a));
    expect(fs.realpathSync.native((await resolveCommandOnPath(name, { ...process.env, PATH: [guessBin, onPathBin, sys].join(path.delimiter) }))!)).toBe(fs.realpathSync.native(b));
  });
});

describe('discovery and execution agree on one binary', () => {
  /**
   * `getCliPath()` is synchronous and cannot run `which`, so it used to redo
   * the guess walk and could return a different binary than discovery had just
   * validated. Discovery now seeds the cache it reads.
   */
  it('_discoverCliCommon seeds the path getter\'s cache', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'providers', 'base', 'BaseCliProvider.ts'),
      'utf8',
    );
    const discover = source.slice(
      source.indexOf('protected async _discoverCliCommon'),
      source.indexOf('protected _getCliPathCommon'),
    );
    expect(discover.length).toBeGreaterThan(200);

    // Every successful branch records the path rather than returning it raw.
    expect(discover).not.toMatch(/return\s*\{\s*found:\s*true,\s*path:\s*searchPath\s*\}/);
    expect(discover).toContain('_rememberCliPath');

    // …and PATH is consulted before the guess list, not after it.
    const pathProbe = discover.indexOf('resolveCommandOnPath');
    const guessWalk = discover.indexOf('getCommonSearchPaths');
    expect(pathProbe).toBeGreaterThan(-1);
    expect(guessWalk).toBeGreaterThan(-1);
    expect(pathProbe).toBeLessThan(guessWalk);
  });
});
