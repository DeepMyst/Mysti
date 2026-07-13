/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * ContinueProvider CLI-arg mapping: headless print mode, permission
 * policy flags (--readonly / --auto), custom model, and rule injection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableContinueProvider } from '../../helpers/providerFactory';
import { createContinueSession } from '../../helpers/sessionFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
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

  it.each([['quick-plan'], ['detailed-plan']] as const)('uses --readonly for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createContinueSession());
    expect(args).toContain('--readonly');
    expect(args).not.toContain('--auto');
  });

  it('uses --readonly for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createContinueSession());
    expect(args).toContain('--readonly');
  });

  it('FAILS CLOSED: ask-tier settings use --readonly, never --auto (no tool events to gate)', () => {
    // Shipped defaults are ask-permission + ask-before-edit — the exact combo
    // whose contract is "ask before each change". A plain-text CLI cannot
    // prompt, so deny writes/shell via --readonly instead of --auto.
    for (const settings of [
      s(),                                                      // default ask-before-edit + ask-permission
      s({ mode: 'ask-before-edit', accessLevel: 'ask-permission' }),
      s({ mode: 'default', accessLevel: 'ask-permission' }),
      s({ mode: 'ask-before-edit', accessLevel: 'full-access' }), // full-access but still ask-before-edit
    ]) {
      const args = provider.buildCliArgs(settings, createContinueSession());
      expect(args, JSON.stringify(settings)).toContain('--readonly');
      expect(args, JSON.stringify(settings)).not.toContain('--auto');
    }
  });

  it('uses --auto only where the gate is intentionally off (autonomous tiers)', () => {
    for (const settings of [
      s({ mode: 'edit-automatically', accessLevel: 'full-access' }),
      s({ mode: 'edit-automatically', accessLevel: 'ask-permission' }),
      s({ mode: 'default', accessLevel: 'full-access' }),
    ]) {
      const args = provider.buildCliArgs(settings, createContinueSession());
      expect(args, JSON.stringify(settings)).toContain('--auto');
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
