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
 * Plan 29: the host side of Manage Plugins. The webview is untrusted input —
 * every id, scope and source it sends is checked against what the CLI last
 * reported before anything spawns — and the install gate is a NATIVE modal the
 * webview cannot answer for the user.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { window, workspace } from '../helpers/mockVscode';
import { PluginsPanelManager } from '../../src/managers/PluginsPanelManager';
import type { PluginsViewState } from '../../src/managers/PluginsPanelManager';
import { PLUGIN_ADAPTERS, PluginCliError } from '../../src/services/plugins/PluginAdapters';
import type { PluginAdapter, PluginBackend, RunResult } from '../../src/services/plugins/PluginAdapters';

const CLAUDE_FIXTURE = fs.readFileSync(path.join(__dirname, '../fixtures/plugins/claude-list.json'), 'utf8');

function fakeProvider(id: string, name: string) {
  return {
    id, displayName: name,
    discoverCli: async () => ({ found: true, path: `/bin/${id}` }),
    getCliPath: () => `/bin/${id}`,
    getCachedCliVersion: () => '1.2.3',
    markPluginsChanged: vi.fn(),
  };
}

function testAdapter(over: Partial<PluginAdapter> = {}): PluginAdapter {
  return {
    scopes: ['user', 'project', 'local'],
    list: vi.fn(async () => ({
      installed: [
        { id: 'on@m', name: 'on', scope: 'user' as const, enabled: true },
        { id: 'core', name: 'core', scope: 'bundled' as const, enabled: true },
      ],
      available: [{ id: 'hooky@m', name: 'hooky' }, { id: 'plain@m', name: 'plain' }, { id: 'plain2@m', name: 'plain2' }],
    })),
    inspect: vi.fn(async (_run, e) => (e.name === 'hooky' ? ['Hooks'] : [])),
    install: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    marketplaces: {
      list: vi.fn(async () => [{ name: 'mk', source: 'owner/mk' }, { name: 'core-mk', source: 'built in', builtin: true }]),
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    },
    ...over,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PluginsPanelManager (Plan 29)', () => {
  let providers: Record<string, ReturnType<typeof fakeProvider>>;
  let adapter: PluginAdapter;
  let manager: PluginsPanelManager;
  let state: PluginsViewState | undefined;
  let modal: ReturnType<typeof vi.fn>;
  const originalWarning = window.showWarningMessage;

  function build(adapters: Record<string, PluginBackend>, run?: (cliPath: string, args: string[]) => Promise<RunResult>) {
    manager = new PluginsPanelManager({ fsPath: '/ext' } as any, {
      getProviderInstance: (id: string) => providers[id] as any,
      getAllProviderIds: () => Object.keys(providers) as any,
    }, { adapters, run });
    manager.onState = (s) => { state = s; };
  }

  beforeEach(async () => {
    providers = {
      'claude-code': fakeProvider('claude-code', 'Claude Code'),
      'openai-codex': fakeProvider('openai-codex', 'Codex'),
      'continue': fakeProvider('continue', 'Continue'),
    };
    adapter = testAdapter();
    modal = vi.fn(async () => undefined);
    (window as any).showWarningMessage = modal;
    (workspace as any).isTrusted = true;
    build({ 'claude-code': adapter, 'openai-codex': { note: 'Use /plugins inside Codex.' }, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
  });

  afterEach(() => {
    (window as any).showWarningMessage = originalWarning;
    delete (workspace as any).isTrusted;
  });

  it('shows every backend with what it can do, and lists the selected one', () => {
    expect(state!.backends.map((b) => [b.id, b.status])).toEqual([
      ['claude-code', 'ok'], ['openai-codex', 'note'], ['continue', 'none'],
    ]);
    expect(state!.selected).toBe('claude-code');
    expect(state!.listing!.installed.map((p) => p.id)).toEqual(['on@m', 'core']);
    expect(state!.can).toMatchObject({ toggle: true, uninstall: true, marketplaces: true, search: false });
  });

  it('refuses an id the CLI never listed, before anything runs', async () => {
    await manager.handleMessage({ type: 'install', id: '--evil', scope: 'user' });
    expect(adapter.install).not.toHaveBeenCalled();
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(state!.error).toBeTruthy();
  });

  it('refuses a scope the backend does not offer', async () => {
    await manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'managed' });
    expect(adapter.install).not.toHaveBeenCalled();
  });

  it('refuses a project install in an untrusted workspace', async () => {
    (workspace as any).isTrusted = false;
    await manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'project' });
    expect(adapter.install).not.toHaveBeenCalled();
    expect(state!.error).toMatch(/trusted/i);
  });

  it('asks before installing something that runs code, and installs nothing if declined', async () => {
    await manager.handleMessage({ type: 'install', id: 'hooky@m', scope: 'user' });
    expect(modal).toHaveBeenCalledTimes(1);
    expect(modal.mock.calls[0][1]).toMatchObject({ modal: true });
    expect(String(modal.mock.calls[0][1].detail)).toMatch(/Hooks/);
    expect(adapter.install).not.toHaveBeenCalled();
    expect(providers['claude-code'].markPluginsChanged).not.toHaveBeenCalled();
  });

  it('installs after the user confirms, re-lists, and tells open chats', async () => {
    modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
    const lists = (adapter.list as any).mock.calls.length;
    await manager.handleMessage({ type: 'install', id: 'hooky@m', scope: 'user' });
    expect(adapter.install).toHaveBeenCalledWith(expect.any(Function), 'hooky@m', 'user', undefined);
    expect((adapter.list as any).mock.calls.length).toBe(lists + 1);
    expect(providers['claude-code'].markPluginsChanged).toHaveBeenCalledTimes(1);
    expect(state!.banner).toMatch(/next message/);
  });

  it('installs a plugin that runs no code without asking', async () => {
    await manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'local' });
    expect(modal).not.toHaveBeenCalled();
    expect(adapter.install).toHaveBeenCalledWith(expect.any(Function), 'plain@m', 'local', undefined);
  });

  it('runs two installs on the same backend one after the other', async () => {
    const log: string[] = [];
    let releaseFirst!: () => void;
    (adapter.install as any).mockImplementation(async (_run: unknown, id: string) => {
      log.push(`start ${id}`);
      if (id === 'plain@m') { await new Promise<void>((r) => { releaseFirst = r; }); }
      log.push(`end ${id}`);
    });
    const first = manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'user' });
    const second = manager.handleMessage({ type: 'install', id: 'plain2@m', scope: 'user' });
    for (let i = 0; i < 5; i++) { await tick(); }
    expect(log).toEqual(['start plain@m']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(log).toEqual(['start plain@m', 'end plain@m', 'start plain2@m', 'end plain2@m']);
  });

  it('offers to approve a marketplace-declared command and pins it by hash', async () => {
    const sha = 'c'.repeat(64);
    (adapter.install as any)
      .mockRejectedValueOnce(new PluginCliError('needs approval', { command: 'npm run setup', sha }))
      .mockResolvedValueOnce(undefined);
    modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
    await manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'user' });
    expect(String(modal.mock.calls[0][1].detail)).toContain('npm run setup');
    expect(adapter.install).toHaveBeenLastCalledWith(expect.any(Function), 'plain@m', 'user', { acceptCommandSha: sha });
  });

  it('toggles and uninstalls only plugins it listed, never a bundled one', async () => {
    await manager.handleMessage({ type: 'setEnabled', id: 'on@m', scope: 'user', on: false });
    expect(adapter.setEnabled).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ id: 'on@m' }), false);
    await manager.handleMessage({ type: 'uninstall', id: 'core', scope: 'bundled' });
    expect(adapter.uninstall).not.toHaveBeenCalled();
    await manager.handleMessage({ type: 'uninstall', id: 'on@m', scope: 'user' });
    expect(adapter.uninstall).toHaveBeenCalledTimes(1);
  });

  it('refuses a marketplace source that would read as a flag', async () => {
    await manager.handleMessage({ type: 'addMarketplace', source: '-x' });
    expect(adapter.marketplaces!.add).not.toHaveBeenCalled();
    expect(modal).not.toHaveBeenCalled();
  });

  it('asks before adding a marketplace, and adds it on yes', async () => {
    modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
    await manager.handleMessage({ type: 'addMarketplace', source: 'owner/repo' });
    expect(adapter.marketplaces!.add).toHaveBeenCalledWith(expect.any(Function), 'owner/repo');
  });

  it('never removes a built-in marketplace', async () => {
    modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
    await manager.handleMessage({ type: 'removeMarketplace', name: 'core-mk' });
    expect(adapter.marketplaces!.remove).not.toHaveBeenCalled();
    await manager.handleMessage({ type: 'removeMarketplace', name: 'mk' });
    expect(adapter.marketplaces!.remove).toHaveBeenCalledWith(expect.any(Function), 'mk');
  });

  it('ignores a backend id it does not know', async () => {
    await manager.handleMessage({ type: 'select', backend: 'evil' });
    expect(state!.selected).toBe('claude-code');
  });

  it('shows a list failure as an error, never as an empty list', async () => {
    (adapter.list as any).mockRejectedValueOnce(new PluginCliError("Couldn't read Claude Code's plugin list."));
    await manager.handleMessage({ type: 'refresh' });
    expect(state!.listing).toBeUndefined();
    expect(state!.error).toMatch(/Couldn't read/);
  });

  it('reports Claude\'s exit-0 failure on the row and leaves open chats alone', async () => {
    const failed = '{"command":"install","outcome":"failed","message":"Plugin \\"commit-commands\\" not found in marketplace \\"claude-plugins-official\\"","failureCode":"not_found"}';
    const run = vi.fn(async (_cli: string, args: string[]): Promise<RunResult> => {
      const key = args.join(' ');
      if (key === 'plugin list --json --available') { return { code: 0, stdout: CLAUDE_FIXTURE, stderr: '', timedOut: false }; }
      if (key === 'plugin marketplace list --json') { return { code: 0, stdout: '[]', stderr: '', timedOut: false }; }
      if (key.startsWith('plugin install')) { return { code: 0, stdout: failed, stderr: '', timedOut: false }; }
      throw new Error(`unexpected ${key}`);
    });
    build({ 'claude-code': PLUGIN_ADAPTERS['claude-code'], 'openai-codex': null, 'continue': null }, run);
    await manager.handleMessage({ type: 'ready' });
    modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
    const id = 'context7@claude-plugins-official';
    await manager.handleMessage({ type: 'install', id, scope: 'user' });
    expect(state!.rowErrors[id]).toMatch(/not found in marketplace/);
    expect(providers['claude-code'].markPluginsChanged).not.toHaveBeenCalled();
    expect(run.mock.calls.every(([cli]) => cli === '/bin/claude-code')).toBe(true);
  });
});
