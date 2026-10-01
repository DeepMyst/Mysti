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
 * Plan 39: a plugin installed, toggled or removed must reach a chat whose CLI
 * is already running. Claude Code, Hermes and Kimi keep a persistent process
 * that loaded its plugins at spawn, so the change has to break the
 * spawn-settings match — the existing pre-turn check then respawns it (with
 * --resume) on the next message, never mid-turn.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { TestableClaudeProvider, TestableHermesProvider } from '../helpers/providerFactory';
import type { Settings } from '../../src/types';

function settings(): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission', contextMode: 'auto',
    model: 'claude-sonnet-4-6', provider: 'claude-code', effortLevel: 'high',
  } as Settings;
}

function snapshot(provider: unknown, s: Settings) {
  const p = provider as any;
  return {
    model: p._getEffectiveModel(s),
    permissionMode: p._derivePermissionMode(s),
    thinkingLevel: s.thinkingLevel || 'none',
    effortLevel: s.effortLevel || '',
  };
}

describe('plugin changes respawn persistent processes (Plan 39)', () => {
  beforeEach(() => clearMockConfig());

  it('a snapshot taken before any plugin change still matches', () => {
    const provider = new TestableClaudeProvider();
    const session: any = { persistentSettings: snapshot(provider, settings()) };
    expect((provider as any)._persistentSettingsMatch(session, settings())).toBe(true);
  });

  it('markPluginsChanged breaks the match so the next send respawns', () => {
    const provider = new TestableClaudeProvider();
    const session: any = { persistentSettings: snapshot(provider, settings()) };
    provider.markPluginsChanged();
    expect((provider as any)._persistentSettingsMatch(session, settings())).toBe(false);
  });

  it('a process spawned after the change matches again', () => {
    const provider = new TestableClaudeProvider();
    provider.markPluginsChanged();
    const session: any = {
      persistentSettings: { ...snapshot(provider, settings()), pluginGeneration: 1 },
    };
    expect((provider as any)._persistentSettingsMatch(session, settings())).toBe(true);
  });

  it('Hermes inherits it through its own override', () => {
    const provider = new TestableHermesProvider();
    const p = provider as any;
    const s = settings();
    const session: any = { persistentSettings: snapshot(provider, s) };
    // Hermes's override also pins acpAccessLevel/acpMode; mirror what it reads.
    session.acpAccessLevel = s.accessLevel;
    session.acpMode = s.mode;
    const before = p._persistentSettingsMatch(session, s);
    provider.markPluginsChanged();
    expect(p._persistentSettingsMatch(session, s)).toBe(false);
    expect(before).toBe(true);
  });
});
