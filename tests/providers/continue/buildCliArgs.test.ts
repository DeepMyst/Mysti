/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * ContinueProvider CLI-arg mapping: headless print mode, permission
 * unrestricted policy (every tool but Search), custom model, and rule injection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableContinueProvider } from '../../helpers/providerFactory';
import { createContinueSession } from '../../helpers/sessionFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'full-access',
    contextMode: 'auto', model: '', provider: 'continue', ...overrides,
  } as Settings;
}

describe('Continue buildCliArgs', () => {
  let provider: TestableContinueProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableContinueProvider();
  });

  it('always runs headless print mode (prompt arrives via stdin)', () => {
    const args = provider.buildCliArgs(s(), createContinueSession());
    expect(args[0]).toBe('-p');
  });

  it('rejects restricted tiers instead of treating --readonly as command denial', () => {
    expect(() => provider.buildCliArgs(s({ accessLevel: 'ask-permission' }), createContinueSession())).toThrow('cannot enforce');
  });

  it('allows every tool except the shell-injectable Search, only in unrestricted tiers', () => {
    // cn 1.5.47 builds Search's rg command as a shell string from the model's
    // pattern and .gitignore lines; --auto overrides --exclude, so it is not used.
    for (const settings of [
      s({ mode: 'edit-automatically', accessLevel: 'full-access' }),
      s({ mode: 'default', accessLevel: 'full-access' }),
    ]) {
      const args = provider.buildCliArgs(settings, createContinueSession());
      expect(args.slice(1, 9), JSON.stringify(settings)).toEqual(['--exclude', 'Search', '--allow', 'Edit', '--allow', 'MultiEdit', '--allow', 'Write']);
      expect(args, JSON.stringify(settings)).not.toContain('--auto');
      expect(args, JSON.stringify(settings)).not.toContain('--readonly');
    }
  });

  it('passes the custom model as a hub slug', () => {
    setMockConfig('continueModel', 'anthropic/claude-sonnet-4-5');
    const args = provider.buildCliArgs(s({ mode: 'edit-automatically', accessLevel: 'full-access' }), createContinueSession());
    expect(args).toContain('--model');
    expect(args).toContain('anthropic/claude-sonnet-4-5');
  });

  it('omits --model when nothing is configured', () => {
    const args = provider.buildCliArgs(s(), createContinueSession());
    expect(args).not.toContain('--model');
  });

  it('never passes channel system context as a --rule arg (Windows arg-gate + double-inject)', () => {
    const session = createContinueSession();
    session.channelSystemContext = 'Project rules\n\nwith newlines and `backticks`.';
    const args = provider.buildCliArgs(s(), session);
    expect(args).not.toContain('--rule');
    // No arg carries the multi-line blob that would trip the shell-mode gate
    expect(args.some(a => a.includes('\n'))).toBe(false);
  });
});
