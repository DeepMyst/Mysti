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
 * Plan 39: `/plugins` only OPENS the Manage Plugins tab, on the chat's own
 * backend. Nothing typed in a chat installs anything.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { commands } from '../helpers/mockVscode';
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

const callbacks = {
  postToPanel: () => {},
  updateSettings: async () => {},
  getPanelProvider: () => 'github-copilot',
  getPanelModel: () => 'm',
  getModelsForProvider: () => [],
  executeManualCompaction: async () => {},
};

describe('/plugins (Plan 39)', () => {
  const original = commands.executeCommand;
  afterEach(() => { (commands as any).executeCommand = original; });

  it('opens Manage Plugins on the chat\'s backend', async () => {
    const run = vi.fn(async () => undefined);
    (commands as any).executeCommand = run;
    await makeManager().executeCommand('cmd:plugins', '', 'panel-1', callbacks as any);
    expect(run).toHaveBeenCalledWith('mysti.managePlugins', 'github-copilot');
  });

  it('is in the menu', () => {
    const all = (makeManager() as any)._getUniversalCommands('panel-1', 'claude-code', callbacks);
    expect(all.find((c: { id: string }) => c.id === 'cmd:plugins')).toMatchObject({ action: 'execute', provider: 'all' });
  });
});
