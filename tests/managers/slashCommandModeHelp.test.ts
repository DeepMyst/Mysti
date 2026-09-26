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
 * Plan 32 — `/mode` speaks the four names the mode pill uses, and `/help`
 * opens the help card instead of printing a stale command list.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { SlashCommandManager } from '../../src/managers/SlashCommandManager';

function makeManager() {
  return new SlashCommandManager({
    providerManager: { getAllProviders: () => [] } as any,
    contextManager: {} as any,
    conversationManager: {} as any,
    compactionManager: {} as any,
    memoryManager: {} as any,
    brainstormManager: {} as any,
  });
}

function callbacks(updates: Array<Record<string, unknown>>, posted: unknown[]) {
  return {
    postToPanel: (_p: string, m: unknown) => { posted.push(m); },
    updateSettings: async (s: Record<string, unknown>) => { updates.push(s); },
    getPanelProvider: () => 'x',
    getPanelModel: () => 'm',
    getModelsForProvider: () => [],
    executeManualCompaction: async () => {},
  };
}

describe('/mode speaks the four mode names', () => {
  beforeEach(() => clearMockConfig());

  it.each([
    ['plan', { mode: 'quick-plan', accessLevel: 'read-only' }],
    ['ask', { mode: 'ask-before-edit', accessLevel: 'ask-permission' }],
    ['auto', { mode: 'edit-automatically', accessLevel: 'ask-permission' }],
    ['full', { mode: 'edit-automatically', accessLevel: 'full-access' }],
  ])('/mode %s writes mode AND access', async (arg, expected) => {
    const updates: Array<Record<string, unknown>> = [];
    const out = await makeManager().executeCommand('settings:mode', arg, 'p', callbacks(updates, []) as any);
    expect(updates).toEqual([expected]);
    expect(out).toMatch(new RegExp(`^Mode: ${arg[0].toUpperCase()}${arg.slice(1)}\\.`));
  });

  it('keeps detailed-plan when landing on plan from it', async () => {
    setMockConfig('defaultMode', 'detailed-plan');
    const updates: Array<Record<string, unknown>> = [];
    await makeManager().executeCommand('settings:mode', 'plan', 'p', callbacks(updates, []) as any);
    expect(updates[0]).toEqual({ mode: 'detailed-plan', accessLevel: 'read-only' });
  });

  it('still accepts a raw mode value', async () => {
    const updates: Array<Record<string, unknown>> = [];
    await makeManager().executeCommand('settings:mode', 'edit-automatically', 'p', callbacks(updates, []) as any);
    expect(updates).toEqual([{ mode: 'edit-automatically' }]);
  });

  it('names the four modes when the argument is wrong', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const out = await makeManager().executeCommand('settings:mode', 'turbo', 'p', callbacks(updates, []) as any);
    expect(out).toContain('plan, ask, auto or full');
    expect(updates).toEqual([]);
  });
});

describe('/mode reaches the panel, not just the config', () => {
  it('/mode full tells the panel the new pair', async () => {
    const posted: unknown[] = [];
    await makeManager().executeCommand('settings:mode', 'full', 'p', callbacks([], posted) as any);
    expect(posted).toEqual([{ type: 'modeChanged', payload: { mode: 'edit-automatically', accessLevel: 'full-access' } }]);
  });
  it('/mode takes any case', async () => {
    const updates: Array<Record<string, unknown>> = [];
    await makeManager().executeCommand('settings:mode', 'Plan', 'p', callbacks(updates, []) as any);
    expect(updates).toEqual([{ mode: 'quick-plan', accessLevel: 'read-only' }]);
  });
  it('/access tells the panel too', async () => {
    const posted: unknown[] = [];
    await makeManager().executeCommand('settings:access', 'read-only', 'p', callbacks([], posted) as any);
    expect(posted).toEqual([{ type: 'modeChanged', payload: { accessLevel: 'read-only' } }]);
  });
});

describe('/help opens the help card', () => {
  it('posts showHelp and returns no text', async () => {
    const posted: unknown[] = [];
    const out = await makeManager().executeCommand('cmd:help', '', 'p', callbacks([], posted) as any);
    expect(posted).toEqual([{ type: 'showHelp' }]);
    expect(out).toBeUndefined();
  });
});
