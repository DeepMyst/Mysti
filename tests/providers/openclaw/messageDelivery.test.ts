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
 * `openclaw agent` does not read stdin.
 *
 * Every other CLI Mysti drives takes its prompt on a pipe, and the base class
 * writes it there. OpenClaw 2026.6.34 ignores the pipe and answers:
 *
 *   Error: Missing message. Use openclaw agent --message "..." --agent <id>
 *          or openclaw agent --message-file <path> --agent <id>.
 *
 * and, once a message IS supplied:
 *
 *   Error: Pass --to <E.164>, --session-key, --session-id, or --agent to
 *          choose a session
 *
 * so the turn died before reaching the model. Both were verified against the
 * installed CLI. `--message-file` is used rather than `--message` so a long
 * prompt cannot hit ARG_MAX.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    mode: 'default', thinkingLevel: 'medium', accessLevel: 'full-access',
    contextMode: 'auto', model: '', provider: 'openclaw', ...overrides,
  } as Settings;
}

let provider: TestableOpenClawProvider;

beforeEach(() => {
  clearMockConfig();
  provider = new TestableOpenClawProvider();
});

afterEach(() => {
  for (const p of ['panel-1', 'panel-2']) {
    try { fs.unlinkSync(path.join(os.tmpdir(), `mysti-openclaw-${p}.txt`)); } catch { /* fine */ }
  }
});

describe('OpenClaw prompt delivery', () => {
  it('names a message file instead of relying on stdin', () => {
    const args = provider.buildCliArgs(settings(), createOpenClawSession('panel-1'));
    const idx = args.indexOf('--message-file');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain('mysti-openclaw-panel-1');
  });

  /** Without one the CLI refuses the turn outright. */
  it('always passes a session selector', () => {
    const args = provider.buildCliArgs(settings(), createOpenClawSession('panel-1'));
    const idx = args.indexOf('--session-key');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('mysti-panel-1');
  });

  it('gives each panel its own session and its own file', () => {
    const a = provider.buildCliArgs(settings(), createOpenClawSession('panel-1'));
    const b = provider.buildCliArgs(settings(), createOpenClawSession('panel-2'));
    expect(a[a.indexOf('--session-key') + 1]).not.toBe(b[b.indexOf('--session-key') + 1]);
    expect(a[a.indexOf('--message-file') + 1]).not.toBe(b[b.indexOf('--message-file') + 1]);
  });

  /** A panel id reaches a filesystem path, so it must not be able to escape. */
  it('cannot be steered out of the temp directory by a panel id', () => {
    const args = provider.buildCliArgs(settings(), createOpenClawSession('../../etc/passwd'));
    const file = args[args.indexOf('--message-file') + 1];
    expect(path.dirname(file)).toBe(os.tmpdir());
    expect(file).not.toContain('..');
  });

  it('keeps the flags the CLI still expects', () => {
    const args = provider.buildCliArgs(settings(), createOpenClawSession('panel-1'));
    expect(args.slice(0, 2)).toEqual(['agent', '--json']);
    expect(args).toContain('--local');
    expect(args.join(' ')).toContain('--thinking medium');
  });
});

describe('OpenClaw _deliverPrompt', () => {
  /** The base writes to stdin; OpenClaw has to write the file it named. */
  it('writes the prompt to the file the args point at, and closes stdin', async () => {
    const session = createOpenClawSession('panel-1');
    const args = provider.buildCliArgs(settings(), session);
    const file = args[args.indexOf('--message-file') + 1];

    let stdinEnded = false;
    const fakeProc = { stdin: { end: () => { stdinEnded = true; }, write: () => { throw new Error('must not write to stdin'); } } };

    await provider.deliverPrompt(fakeProc as never, 'Explain the diff', session);

    expect(fs.readFileSync(file, 'utf8')).toBe('Explain the diff');
    // Nothing reads stdin, but an open pipe would hold the process forever.
    expect(stdinEnded).toBe(true);
  });

  /** The file is the user's prompt sitting in a shared temp directory. */
  it('writes it readable only by the owner', async () => {
    const session = createOpenClawSession('panel-1');
    const file = provider.buildCliArgs(settings(), session)[
      provider.buildCliArgs(settings(), session).indexOf('--message-file') + 1
    ];
    await provider.deliverPrompt({ stdin: { end: () => undefined } } as never, 'secret', session);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('overwrites the previous turn rather than appending to it', async () => {
    const session = createOpenClawSession('panel-1');
    const file = provider.buildCliArgs(settings(), session)[
      provider.buildCliArgs(settings(), session).indexOf('--message-file') + 1
    ];
    const proc = { stdin: { end: () => undefined } } as never;
    await provider.deliverPrompt(proc, 'first turn', session);
    await provider.deliverPrompt(proc, 'second', session);
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });
});
