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

afterEach(() => { provider.dispose(); });

async function prepare(panelId = 'panel-1', prompt = 'test prompt') {
  const session = createOpenClawSession(panelId);
  const args = provider.buildCliArgs(settings(), session);
  const cleanup = await (provider as any)._preparePromptBeforeSpawn(prompt, args, session);
  return { session, args, cleanup, file: args[args.indexOf('--message-file') + 1] };
}

describe('OpenClaw prompt delivery', () => {
  it('names a message file instead of relying on stdin', async () => {
    const { args } = await prepare();
    const idx = args.indexOf('--message-file');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain('mysti-openclaw-');
  });

  /** Without one the CLI refuses the turn outright. */
  it('always passes a session selector', () => {
    const args = provider.buildCliArgs(settings(), createOpenClawSession('panel-1'));
    const idx = args.indexOf('--session-key');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('mysti-panel-1');
  });

  it('gives each panel its own session and its own file', async () => {
    const { args: a } = await prepare('panel-1');
    const { args: b } = await prepare('panel-2');
    expect(a[a.indexOf('--session-key') + 1]).not.toBe(b[b.indexOf('--session-key') + 1]);
    expect(a[a.indexOf('--message-file') + 1]).not.toBe(b[b.indexOf('--message-file') + 1]);
  });

  /** A panel id reaches a filesystem path, so it must not be able to escape. */
  it('cannot be steered out of the temp directory by a panel id', async () => {
    const { file } = await prepare('../../etc/passwd');
    expect(path.dirname(path.dirname(file))).toBe(os.tmpdir());
    expect(file).not.toContain('..');
  });

  it('keeps the flags the CLI still expects', () => {
    const args = provider.buildCliArgs(settings(), createOpenClawSession('panel-1'));
    expect(args.slice(0, 2)).toEqual(['agent', '--json']);
    expect(args).toContain('--local');
    expect(args.join(' ')).toContain('--thinking medium');
  });
});

describe('OpenClaw message-file ownership', () => {
  it('writes the prompt before delivery and only closes stdin on the spawned child', async () => {
    const { session, file } = await prepare('panel-1', 'Explain the diff');
    expect(fs.readFileSync(file, 'utf8')).toBe('Explain the diff');
    let stdinEnded = false;
    const proc = { stdin: {
      end: () => { stdinEnded = true; },
      write: () => { throw new Error('must not write to stdin'); },
    } };
    await provider.deliverPrompt(proc as never, 'Explain the diff', session);
    expect(stdinEnded).toBe(true);
  });

  it('writes a private directory and owner-readable file', async () => {
    const { file } = await prepare('panel-1', 'secret');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it('overlapping turns have distinct files and old cleanup preserves the replacement', async () => {
    const first = await prepare('panel-1', 'first');
    const second = await prepare('panel-1', 'second');
    expect(first.file).not.toBe(second.file);
    await first.cleanup();
    expect(fs.existsSync(first.file)).toBe(false);
    expect(fs.readFileSync(second.file, 'utf8')).toBe('second');
    await second.cleanup();
    expect(fs.existsSync(second.file)).toBe(false);
  });
});
