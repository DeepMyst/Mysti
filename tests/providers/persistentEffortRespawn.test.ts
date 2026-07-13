/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 18 (4.1): --effort is baked into persistent-process spawn args, so a
 * mid-session effort change MUST make _persistentSettingsMatch return false
 * (→ respawn). Same bug class as the issue-#39 custom-model fix: the snapshot
 * compared only {model, permissionMode, thinkingLevel} and silently kept the
 * old effort forever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { TestableClaudeProvider } from '../helpers/providerFactory';
import type { Settings } from '../../src/types';

function settings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default',
    thinkingLevel: 'none',
    accessLevel: 'ask-permission',
    contextMode: 'auto',
    model: 'claude-sonnet-4-6',
    provider: 'claude-code',
    effortLevel: 'high',
    ...overrides,
  } as Settings;
}

describe('persistent-process effort snapshot (Plan 18 4.1)', () => {
  let provider: TestableClaudeProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableClaudeProvider();
  });

  function snapshotFor(s: Settings) {
    const p = provider as any;
    return {
      model: p._getEffectiveModel(s),
      permissionMode: p._derivePermissionMode(s),
      thinkingLevel: s.thinkingLevel || 'none',
      effortLevel: s.effortLevel || '',
    };
  }

  it('matches when nothing changed', () => {
    const s = settings();
    const session: any = { persistentSettings: snapshotFor(s) };
    expect((provider as any)._persistentSettingsMatch(session, s)).toBe(true);
  });

  it('a mid-session effort change breaks the match (forces respawn)', () => {
    const s = settings({ effortLevel: 'high' });
    const session: any = { persistentSettings: snapshotFor(s) };
    expect((provider as any)._persistentSettingsMatch(session, settings({ effortLevel: 'max' }))).toBe(false);
  });

  it('clearing effort also breaks the match', () => {
    const s = settings({ effortLevel: 'high' });
    const session: any = { persistentSettings: snapshotFor(s) };
    expect((provider as any)._persistentSettingsMatch(session, settings({ effortLevel: undefined }))).toBe(false);
  });
});

// Plan 18 W2 review: the effort comparison is capability-gated — a provider
// that declares no effortLevels (Hermes) must NOT respawn on an effort flip,
// or a global effort change would destroy its live ACP session.
import { TestableHermesProvider } from '../helpers/providerFactory';

describe('effort snapshot capability gate (Plan 18 W2 review)', () => {
  it('Hermes (no effortLevels) ignores an effort change in the match', () => {
    clearMockConfig();
    const provider = new TestableHermesProvider();
    const p = provider as any;
    const base = settings({ effortLevel: 'high' });
    // Hermes's own override additionally pins acpAccessLevel/acpMode.
    const session: any = {
      acpAccessLevel: base.accessLevel,
      acpMode: base.mode,
      persistentSettings: {
        model: p._getEffectiveModel(base),
        permissionMode: p._derivePermissionMode(base),
        thinkingLevel: base.thinkingLevel || 'none',
        effortLevel: 'high',
      },
    };
    expect(p._persistentSettingsMatch(session, settings({ effortLevel: 'max' }))).toBe(true);
  });
});
