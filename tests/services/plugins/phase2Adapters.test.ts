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
 * Plan 45 Phase 2: Codex, Gemini, Qwen, Cline, OpenCode and Cursor, each driven
 * only as far as its own CLI allows (re-verified against the latest releases
 * on 2026-10-05: Codex 0.160.0, Gemini 0.62.0, Qwen 0.24.7, Cline 3.0.68,
 * OpenCode 1.18.34, Cursor 2026.10.01). The Codex fixture is real output;
 * the rest follow each CLI's source, since nothing is installed for them here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PLUGIN_ADAPTERS } from '../../../src/services/plugins/PluginAdapters';
import type { PluginAdapter, Run, RunResult } from '../../../src/services/plugins/PluginAdapters';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, '../../fixtures/plugins', f), 'utf8');
const ok = (stdout: string, stderr = '', code = 0): RunResult => ({ code, stdout, stderr, timedOut: false });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr, timedOut: false });

function fakeRun(answers: Record<string, RunResult>, cwd?: string): Run & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const key = args.join(' ');
    if (!(key in answers)) { throw new Error(`unexpected argv: ${key}`); }
    return answers[key];
  }) as Run & { calls: string[][] };
  run.calls = calls;
  run.cwd = cwd;
  return run;
}

describe('Codex adapter (Plan 45 Phase 2)', () => {
  const codex = PLUGIN_ADAPTERS['openai-codex'] as PluginAdapter;

  it('lists installed and available plugins from the real JSON', async () => {
    const listing = await codex.list!(fakeRun({ 'plugin list --json --available': ok(fx('codex-list.json')) }));
    expect(listing.installed[0]).toMatchObject({ id: 'openai-templates@openai-curated-remote', name: 'openai-templates', marketplace: 'openai-curated-remote', version: '0.1.1', enabled: true, scope: 'user' });
    expect(listing.available!.map((p) => p.id)).toContain('gmail@openai-curated-remote');
    expect(listing.available!.every((p) => !listing.installed.some((i) => i.id === p.id))).toBe(true);
    expect(listing.warning).toBeUndefined();
  });

  it('warns that the lists may be incomplete when its remote catalog fails (it still exits 0)', async () => {
    const run = fakeRun({ 'plugin list --json --available': ok('{"installed":[],"available":[]}', 'Warning: failed to list remote marketplace plugins: network error') });
    const listing = await codex.list!(run);
    expect(listing.warning).toMatch(/couldn't reach its plugin catalog/i);
  });

  it('installs with add and removes with remove, by plugin id', async () => {
    const run = fakeRun({
      'plugin add gmail@openai-curated-remote --json': ok('{"pluginId":"gmail@openai-curated-remote"}'),
      'plugin remove pages@openai-curated-remote --json': ok('{"pluginId":"pages@openai-curated-remote"}'),
    });
    await codex.install!(run, 'gmail@openai-curated-remote', 'user');
    await codex.uninstall!(run, { id: 'pages@openai-curated-remote', name: 'pages', scope: 'user' });
    expect(run.calls.map((c) => c[1])).toEqual(['add', 'remove']);
  });

  it('has no on/off or update from its CLI, and says so', () => {
    expect(codex.setEnabled).toBeUndefined();
    expect(codex.update).toBeUndefined();
    expect(codex.note).toMatch(/\/plugins inside Codex/);
  });

  it('manages marketplaces, keeping its built-in one', async () => {
    const run = fakeRun({
      'plugin marketplace list --json': ok('{"marketplaces":[{"name":"openai-curated","root":"/home/user/.codex/.tmp/plugins"},{"name":"mine","root":"/x","marketplaceSource":{"sourceType":"git","source":"https://github.com/o/m"}}]}'),
      'plugin marketplace add o/m --json': ok('{"marketplaceName":"m","alreadyAdded":false}'),
      'plugin marketplace upgrade mine --json': ok('{"selectedMarketplaces":["mine"],"upgradedRoots":[],"errors":[]}'),
    });
    expect(await codex.marketplaces!.list(run)).toEqual([
      { name: 'openai-curated', source: 'built in', builtin: true },
      { name: 'mine', source: 'https://github.com/o/m', builtin: false },
    ]);
    await codex.marketplaces!.add(run, 'o/m');
    await codex.marketplaces!.refresh(run, 'mine');
  });

  it('cannot see inside a Codex plugin before install', async () => {
    expect(await codex.inspect!(fakeRun({}), { id: 'gmail@openai-curated-remote', name: 'gmail' })).toBe('unknown');
  });
});

describe('Gemini adapter (Plan 45 Phase 2)', () => {
  const gemini = PLUGIN_ADAPTERS['google-gemini'] as PluginAdapter;
  const ext = JSON.stringify([
    { name: 'conductor', version: '1.2.0', isActive: true, path: '/home/user/.gemini/extensions/conductor', id: 'abc', contextFiles: [], installMetadata: { source: 'https://github.com/gemini-cli-extensions/conductor', type: 'git' }, resolvedSettings: [{ envVar: 'TOKEN', value: 'secret', sensitive: true }] },
    { name: 'off-one', version: '0.1.0', isActive: false, path: '/home/user/.gemini/extensions/off-one', id: 'def', contextFiles: [] },
  ]);

  it('reads the extension list from STDERR, where Gemini writes it', async () => {
    const listing = await gemini.list!(fakeRun({ 'extensions list -o json': ok('', ext) }));
    expect(listing.installed.map((p) => [p.id, p.enabled, p.version])).toEqual([['conductor', true, '1.2.0'], ['off-one', false, '0.1.0']]);
    expect(JSON.stringify(listing)).not.toContain('secret');
  });

  it('finds the JSON past loader warnings on the same stream', async () => {
    const listing = await gemini.list!(fakeRun({ 'extensions list -o json': ok('', `Loaded cached credentials.\nWarning: something\n${ext}\n`) }));
    expect(listing.installed).toHaveLength(2);
  });

  it('installs from a typed source with consent given by the modal, never prompting', async () => {
    const run = fakeRun({ 'extensions install https://github.com/o/ext --consent --skip-settings': ok('') });
    await gemini.installSource!(run, 'https://github.com/o/ext', 'user');
    expect(gemini.install).toBeUndefined();
    expect(gemini.sourceHint!.label).toMatch(/URL/);
  });

  it('turns extensions on and off at user scope, and uninstalls', async () => {
    const run = fakeRun({
      'extensions disable --scope user conductor': ok(''),
      'extensions uninstall conductor': ok(''),
    });
    const p = { id: 'conductor', name: 'conductor', scope: 'user' as const };
    await gemini.setEnabled!(run, p, false);
    await gemini.uninstall!(run, p);
  });

  it('offers no update: it can prompt with no flag to skip it, and exits 0 on failure', () => {
    expect(gemini.update).toBeUndefined();
  });
});

describe('Qwen adapter (Plan 45 Phase 2)', () => {
  const qwen = PLUGIN_ADAPTERS['qwen-code'] as PluginAdapter;
  const listText = [
    '✓ Conductor (1.2.0)',
    ' Description: Plans and tracks work',
    ' Path: /home/user/.qwen/extensions/conductor',
    ' Source: https://github.com/o/conductor (Type: git)',
    ' Enabled (User): true',
    ' Enabled (Workspace): true',
    ' Commands:',
    '   /plan',
    '',
    '✗ Quiet Tool (0.3.1)',
    ' Path: /home/user/.qwen/extensions/quiet-tool',
    ' Enabled (User): true',
    ' Enabled (Workspace): false',
    '',
  ].join('\n');

  it('parses the text list, naming each extension by its folder, not its display name', async () => {
    const listing = await qwen.list!(fakeRun({ 'extensions list': ok(listText) }));
    expect(listing.installed.map((p) => [p.id, p.name, p.version, p.enabled])).toEqual([
      ['conductor', 'Conductor', '1.2.0', true],
      ['quiet-tool', 'Quiet Tool', '0.3.1', false],
    ]);
    expect(listing.installed[0].description).toBe('Plans and tracks work');
  });

  it('reads the empty message as nothing installed', async () => {
    expect((await qwen.list!(fakeRun({ 'extensions list': ok('No extensions installed.\n') }))).installed).toEqual([]);
  });

  it('refuses output it cannot read rather than showing an empty list', async () => {
    await expect(qwen.list!(fakeRun({ 'extensions list': ok('Расширения не установлены.\n') }))).rejects.toThrow(/Couldn't read Qwen/);
  });

  it('installs from a source at the chosen scope, with consent from the modal', async () => {
    const run = fakeRun({ 'extensions install https://github.com/o/x --scope project --consent': ok('') });
    await qwen.installSource!(run, 'https://github.com/o/x', 'project');
    expect(qwen.scopes).toEqual(['user', 'project']);
  });

  it('manages marketplace sources from their text list', async () => {
    const run = fakeRun({
      'extensions sources list': ok('claude-official\n Source: https://github.com/anthropics/claude-plugins-official (Type: git)\n Last updated: 2026-10-01\n'),
      'extensions sources add o/m': ok(''),
      'extensions sources remove claude-official': ok(''),
    });
    expect(await qwen.marketplaces!.list(run)).toEqual([{ name: 'claude-official', source: 'https://github.com/anthropics/claude-plugins-official' }]);
    expect(await qwen.marketplaces!.list(fakeRun({ 'extensions sources list': ok('No marketplace sources added yet.\n') }))).toEqual([]);
    await qwen.marketplaces!.add(run, 'o/m');
    await qwen.marketplaces!.remove(run, 'claude-official');
  });

  it('turns extensions on and off and uninstalls; no update (it exits 0 on failure)', async () => {
    const run = fakeRun({ 'extensions enable --scope user conductor': ok(''), 'extensions uninstall conductor': ok('') });
    const p = { id: 'conductor', name: 'Conductor', scope: 'user' as const };
    await qwen.setEnabled!(run, p, true);
    await qwen.uninstall!(run, p);
    expect(qwen.update).toBeUndefined();
  });
});

describe('Cline adapter (Plan 45 Phase 2)', () => {
  const cline = PLUGIN_ADAPTERS['cline'] as PluginAdapter;
  let home: string;
  let ws: string;
  const original = process.env.CLINE_DIR;

  function plugin(root: string, rel: string, name: string): string {
    const dir = path.join(root, '_installed', rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', description: `${name} plugin`, cline: { plugins: ['./index.js'] } }));
    return dir;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-'));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ws-'));
    process.env.CLINE_DIR = home;
  });
  afterEach(() => {
    if (original === undefined) { delete process.env.CLINE_DIR; } else { process.env.CLINE_DIR = original; }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('lists what is installed by reading its plugin folders (it has no list command)', async () => {
    const userDir = plugin(path.join(home, 'plugins'), 'npm/web-tools-1a2b', 'web-tools');
    const projectDir = plugin(path.join(ws, '.cline', 'plugins'), 'git/github.com/o/repo-3c4d', 'repo-plugin');
    fs.mkdirSync(path.join(home, 'data', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'settings', 'global-settings.json'), JSON.stringify({ disabledPlugins: [projectDir] }));
    const listing = await cline.list!(fakeRun({}, ws));
    expect(listing.installed).toEqual([
      expect.objectContaining({ id: userDir, name: 'web-tools', scope: 'user', enabled: true, description: 'web-tools plugin' }),
      expect.objectContaining({ id: projectDir, name: 'repo-plugin', scope: 'project', enabled: false }),
    ]);
  });

  it('lists nothing when it has no plugin folders', async () => {
    expect((await cline.list!(fakeRun({}, ws))).installed).toEqual([]);
  });

  it('installs a typed source, into the workspace for project scope', async () => {
    const run = fakeRun({ [`plugin install web-tools --json --cwd ${ws}`]: ok('{"source":"web-tools","installPath":"/x","entryPaths":[],"mcpSyncFailures":[]}') }, ws);
    await cline.installSource!(run, 'web-tools', 'project');
    const user = fakeRun({ 'plugin install web-tools --json': ok('{}') }, ws);
    await cline.installSource!(user, 'web-tools', 'user');
  });

  it('uninstalls by install path, in its own scope', async () => {
    const run = fakeRun({ [`plugin uninstall /p/x --json --cwd ${ws}`]: ok('{}') }, ws);
    await cline.uninstall!(run, { id: '/p/x', name: 'x', scope: 'project' });
    const bad = fakeRun({ 'plugin uninstall /p/y --json': fail('Plugin not found: /p/y') }, ws);
    await expect(cline.uninstall!(bad, { id: '/p/y', name: 'y', scope: 'user' })).rejects.toThrow('Plugin not found');
  });

  it('has no on/off from its CLI, and says so', () => {
    expect(cline.setEnabled).toBeUndefined();
    expect(cline.note).toMatch(/settings/);
  });
});

describe('OpenCode adapter (Plan 45 Phase 2)', () => {
  const opencode = PLUGIN_ADAPTERS['opencode'] as PluginAdapter;

  it('lists plugins from its resolved config, with where each one came from', async () => {
    const config = JSON.stringify({
      $schema: 'https://opencode.ai/config.json', mcp: {}, agent: {},
      plugin: ['opencode-wakatime', ['opencode-helicone-session', { key: 'x' }]],
      plugin_origins: [{ spec: 'opencode-wakatime', source: '/home/user/.config/opencode/opencode.json', scope: 'global' }, { spec: 'opencode-helicone-session', source: '/w/.opencode/opencode.json', scope: 'local' }],
    });
    const listing = await opencode.list!(fakeRun({ 'debug config': ok(config) }));
    expect(listing.installed.map((p) => [p.id, p.scope])).toEqual([['opencode-wakatime', 'user'], ['opencode-helicone-session', 'project']]);
  });

  it('installs an npm package globally for you, or into the project', async () => {
    const run = fakeRun({ 'plugin opencode-wakatime -g': ok(''), 'plugin opencode-wakatime': ok('') });
    await opencode.installSource!(run, 'opencode-wakatime', 'user');
    await opencode.installSource!(run, 'opencode-wakatime', 'project');
    expect(run.calls).toEqual([['plugin', 'opencode-wakatime', '-g'], ['plugin', 'opencode-wakatime']]);
  });

  it('never offers uninstall (its top-level uninstall removes OpenCode itself) and says how instead', () => {
    expect(opencode.uninstall).toBeUndefined();
    expect(opencode.note).toMatch(/opencode\.json/);
  });
});

describe('Cursor adapter (Plan 45 Phase 2)', () => {
  const cursor = PLUGIN_ADAPTERS['cursor'] as PluginAdapter;

  it('manages only marketplaces; plugins are installed inside Cursor', async () => {
    expect(cursor.list).toBeUndefined();
    expect(cursor.install).toBeUndefined();
    expect(cursor.note).toMatch(/inside Cursor/);
  });

  it('lists marketplaces, and only user ones can be removed here', async () => {
    const run = fakeRun({
      'plugin marketplace list --format json': ok(JSON.stringify([
        { name: 'team-tools', displayName: 'Team Tools', gitUrl: 'https://github.com/acme/tools', gitRef: 'main', scope: 'team' },
        { name: 'mine', displayName: 'Mine', gitUrl: 'https://github.com/me/mine', scope: 'user' },
      ])),
      'plugin marketplace add https://github.com/o/m': ok(''),
      'plugin marketplace update mine': ok(''),
      'plugin marketplace remove mine': ok(''),
    });
    expect(await cursor.marketplaces!.list(run)).toEqual([
      { name: 'team-tools', source: 'https://github.com/acme/tools@main', builtin: true },
      { name: 'mine', source: 'https://github.com/me/mine', builtin: false },
    ]);
    await cursor.marketplaces!.add(run, 'https://github.com/o/m');
    await cursor.marketplaces!.refresh(run, 'mine');
    await cursor.marketplaces!.remove(run, 'mine');
  });

  it('shows its login message as the error', async () => {
    await expect(cursor.marketplaces!.list(fakeRun({ 'plugin marketplace list --format json': fail('Not logged in. Run `agent login` first.') })))
      .rejects.toThrow('agent login');
  });
});
