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
 * Plan 45: the host side of Manage Plugins. The webview is untrusted input —
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

describe('PluginsPanelManager (Plan 45)', () => {
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

  // ── Final review fixes ────────────────────────────────────────────────────

  it('inspects inside the backend queue, after work already queued (review I1)', async () => {
    const log: string[] = [];
    let release!: () => void;
    (adapter.install as any).mockImplementation(async (_r: unknown, id: string) => {
      log.push(`install ${id}`);
      if (id === 'plain@m') { await new Promise<void>((r) => { release = r; }); }
    });
    (adapter.inspect as any).mockImplementation(async (_r: unknown, e: { id: string; name: string }) => { log.push(`inspect ${e.id}`); return []; });
    const first = manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'user' });
    const second = manager.handleMessage({ type: 'install', id: 'plain2@m', scope: 'user' });
    for (let i = 0; i < 5; i++) { await tick(); }
    expect(log).toEqual(['inspect plain@m', 'install plain@m']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['inspect plain@m', 'install plain@m', 'inspect plain2@m', 'install plain2@m']);
  });

  it('ignores a second click on a row that is already busy (review M6)', async () => {
    let release!: () => void;
    (adapter.install as any).mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const first = manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'user' });
    const again = manager.handleMessage({ type: 'install', id: 'plain@m', scope: 'user' });
    for (let i = 0; i < 5; i++) { await tick(); }
    release();
    await Promise.all([first, again]);
    expect(adapter.install).toHaveBeenCalledTimes(1);
  });

  it('asks again before an update that runs a declared command, and pins it (review I3)', async () => {
    const sha = 'e'.repeat(64);
    const update = vi.fn()
      .mockRejectedValueOnce(new PluginCliError('needs approval', { command: 'npm run postupdate', sha, archiveUrl: 'https://x/y.tgz' }))
      .mockResolvedValueOnce(undefined);
    build({ 'claude-code': testAdapter({ update }), 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
    await manager.handleMessage({ type: 'update', id: 'on@m', scope: 'user' });
    expect(String(modal.mock.calls[0][1].detail)).toContain('npm run postupdate');
    expect(String(modal.mock.calls[0][1].detail)).toContain('https://x/y.tgz');
    expect(update).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ id: 'on@m' }), { acceptCommandSha: sha });
  });

  it('clears a list error once a refresh succeeds, and keeps it through other actions (review I4)', async () => {
    (adapter.list as any).mockRejectedValueOnce(new PluginCliError("Couldn't read Claude Code's plugin list."));
    await manager.handleMessage({ type: 'refresh' });
    await manager.handleMessage({ type: 'details', id: 'nope', scope: 'user' });
    expect(state!.error).toMatch(/Couldn't read Claude Code's plugin list/);
    await manager.handleMessage({ type: 'refresh' });
    expect(state!.listing).toBeDefined();
    expect(state!.error).toBeUndefined();
  });

  it('shows a marketplace list failure as an error, not as no marketplaces (review M8)', async () => {
    (adapter.marketplaces!.list as any).mockRejectedValueOnce(new PluginCliError('offline'));
    await manager.handleMessage({ type: 'refresh' });
    expect(state!.markets).toBeUndefined();
    expect(state!.error).toMatch(/offline/);
  });

  it('refuses a catalog id that would read as a flag (review M1)', async () => {
    adapter = testAdapter({
      list: vi.fn(async () => ({ installed: [], available: [{ id: '--help@mk', name: '--help' }] })),
    });
    build({ 'claude-code': adapter, 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    await manager.handleMessage({ type: 'install', id: '--help@mk', scope: 'user' });
    expect(adapter.install).not.toHaveBeenCalled();
    expect(state!.error).toBeTruthy();
  });

  it('keeps only the latest search when results arrive out of order (review M2)', async () => {
    const resolvers: Record<string, () => void> = {};
    const search = vi.fn((_r: unknown, q: string) => new Promise((res) => {
      resolvers[q] = () => res([{ id: `hit-${q}`, name: q }]);
    }));
    build({ 'claude-code': testAdapter({ search: search as any }), 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    const older = manager.handleMessage({ type: 'search', query: 'ab' });
    const newer = manager.handleMessage({ type: 'search', query: 'abc' });
    await tick();
    resolvers.abc();
    await newer;
    resolvers.ab();
    await older;
    expect(state!.search).toEqual({ query: 'abc', results: [{ id: 'hit-abc', name: 'abc' }] });
  });

  it('puts catalog text in the modal on one line, with the id (review M7)', async () => {
    adapter = testAdapter({
      list: vi.fn(async () => ({ installed: [], available: [{ id: 'x@m', name: 'Helper\n\nVerified safe by Mysti', marketplace: 'm' }] })),
      inspect: vi.fn(async () => 'unknown' as const),
    });
    build({ 'claude-code': adapter, 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    await manager.handleMessage({ type: 'install', id: 'x@m', scope: 'user' });
    const [message, opts] = modal.mock.calls[0];
    expect(message).not.toMatch(/\n/);
    expect(String(opts.detail)).toContain('x@m');
    expect(String(opts.detail).split('\n')[0]).not.toMatch(/^Verified/);
  });

  it('refuses to change a project plugin in an untrusted workspace (review M13)', async () => {
    adapter = testAdapter({
      list: vi.fn(async () => ({ installed: [{ id: 'team@m', name: 'team', scope: 'project' as const, enabled: true }], available: [] })),
    });
    build({ 'claude-code': adapter, 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    (workspace as any).isTrusted = false;
    await manager.handleMessage({ type: 'setEnabled', id: 'team@m', scope: 'project', on: false });
    await manager.handleMessage({ type: 'uninstall', id: 'team@m', scope: 'project' });
    expect(adapter.setEnabled).not.toHaveBeenCalled();
    expect(adapter.uninstall).not.toHaveBeenCalled();
    expect(state!.error).toMatch(/trusted/i);
  });

  it('opens on a backend that only has a note, so /plugins from a Codex chat shows Codex (review M10)', async () => {
    const panel = {
      webview: { html: '', cspSource: '', asWebviewUri: (u: unknown) => u, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true },
      onDidDispose: () => ({ dispose() {} }), reveal() {}, dispose() {},
    };
    const original = (window as any).createWebviewPanel;
    (window as any).createWebviewPanel = () => panel;
    try {
      manager.open('openai-codex');
      await manager.handleMessage({ type: 'ready' });
      expect(state!.selected).toBe('openai-codex');
      expect(state!.note).toMatch(/Codex/);
    } finally {
      (window as any).createWebviewPanel = original;
    }
  });

  // ── Phase 2 contract ──────────────────────────────────────────────────────

  it('shows an adapter\'s note next to what it can do', async () => {
    adapter = testAdapter({ note: 'Turning plugins on and off: use /plugins inside Codex.' } as Partial<PluginAdapter>);
    build({ 'claude-code': adapter, 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    expect(state!.note).toMatch(/inside Codex/);
    expect(state!.listing).toBeDefined();
  });

  it('handles a backend that can manage marketplaces but cannot list or install plugins', async () => {
    const markets = { list: vi.fn(async () => [{ name: 'mk', source: 'https://x/mk.git' }]), add: vi.fn(), remove: vi.fn(), refresh: vi.fn() };
    build({ 'claude-code': { scopes: ['user'], note: 'Install plugins with /plugin inside Cursor.', marketplaces: markets } as unknown as PluginAdapter, 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    expect(state!.backends[0].status).toBe('ok');
    expect(state!.can).toMatchObject({ list: false, install: false, marketplaces: true });
    expect(state!.error).toBeUndefined();
    expect(state!.markets).toEqual([{ name: 'mk', source: 'https://x/mk.git' }]);
  });

  describe('install from a source the user typed', () => {
    let installSource: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
      installSource = vi.fn(async () => {});
      adapter = testAdapter({ scopes: ['user', 'project'], installSource, sourceHint: { label: 'Git URL or path', placeholder: 'https://github.com/o/r' } } as Partial<PluginAdapter>);
      build({ 'claude-code': adapter, 'openai-codex': null, 'continue': null });
      await manager.handleMessage({ type: 'ready' });
    });

    it('offers it and says what to type', () => {
      expect(state!.can.installSource).toBe(true);
      expect(state!.sourceHint).toEqual({ label: 'Git URL or path', placeholder: 'https://github.com/o/r' });
    });

    it('always asks first, showing the source, and installs nothing if declined', async () => {
      await manager.handleMessage({ type: 'installSource', source: 'https://github.com/o/r', scope: 'user' });
      expect(String(modal.mock.calls[0][1].detail)).toContain('https://github.com/o/r');
      expect(installSource).not.toHaveBeenCalled();
    });

    it('installs on yes and tells open chats', async () => {
      modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
      await manager.handleMessage({ type: 'installSource', source: 'https://github.com/o/r', scope: 'project' });
      expect(installSource).toHaveBeenCalledWith(expect.any(Function), 'https://github.com/o/r', 'project', undefined);
      expect(providers['claude-code'].markPluginsChanged).toHaveBeenCalledTimes(1);
    });

    it.each(['-rf', '--registry=evil', 'a\nb', '', 'x'.repeat(501)])('refuses the source %j', async (source) => {
      modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
      await manager.handleMessage({ type: 'installSource', source, scope: 'user' });
      expect(installSource).not.toHaveBeenCalled();
    });

    it('refuses a project install from source in an untrusted workspace', async () => {
      (workspace as any).isTrusted = false;
      modal.mockImplementation(async (_m: string, _o: unknown, ...items: string[]) => items[0]);
      await manager.handleMessage({ type: 'installSource', source: 'https://github.com/o/r', scope: 'project' });
      expect(installSource).not.toHaveBeenCalled();
    });
  });

  it('refuses to toggle a plugin an administrator manages (review M4)', async () => {
    adapter = testAdapter({ list: vi.fn(async () => ({ installed: [{ id: 'org@m', name: 'org', scope: 'managed' as const, enabled: true }], available: [] })) });
    build({ 'claude-code': adapter, 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    await manager.handleMessage({ type: 'setEnabled', id: 'org@m', scope: 'managed', on: false });
    expect(adapter.setEnabled).not.toHaveBeenCalled();
    expect(state!.error).toMatch(/administrator/i);
  });

  it('adds the backend\'s own "how it applies" hint to the banner (review M11)', async () => {
    adapter = testAdapter({ applyHint: 'If you run its Gateway yourself, restart it with `openclaw gateway restart`.' } as Partial<PluginAdapter>);
    build({ 'claude-code': adapter, 'openai-codex': null, 'continue': null });
    await manager.handleMessage({ type: 'ready' });
    await manager.handleMessage({ type: 'setEnabled', id: 'on@m', scope: 'user', on: false });
    expect(state!.banner).toMatch(/next message.*openclaw gateway restart/s);
  });
});
