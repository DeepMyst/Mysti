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
 * Historical message-file helper regression coverage. Production agent turns
 * now require the owned gateway runtime; these fixtures never spawn an agent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';

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
  const args: string[] = [];
  const helper = provider as unknown as {
    _preparePromptBeforeSpawn(prompt: string, args: string[], session: PanelSessionState): Promise<() => Promise<void>>;
  };
  const cleanup = await helper._preparePromptBeforeSpawn(prompt, args, session);
  return { session, args, cleanup, file: args[args.indexOf('--message-file') + 1] };
}

describe('OpenClaw prompt delivery', () => {
  it('names a message file instead of relying on stdin', async () => {
    const { args } = await prepare();
    const idx = args.indexOf('--message-file');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain('mysti-openclaw-');
  });

  it('gives each panel its own private file', async () => {
    const { file: a } = await prepare('panel-1');
    const { file: b } = await prepare('panel-2');
    expect(a).not.toBe(b);
  });

  /** A panel id reaches a filesystem path, so it must not be able to escape. */
  it('cannot be steered out of the temp directory by a panel id', async () => {
    const { file } = await prepare('../../etc/passwd');
    expect(path.dirname(path.dirname(file))).toBe(os.tmpdir());
    expect(file).not.toContain('..');
  });

  it('cannot construct executable agent arguments through the legacy helper path', () => {
    expect(() => provider.buildCliArgs(settings(), createOpenClawSession('panel-1')))
      .toThrow('Unguarded CLI fallback is disabled');
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
