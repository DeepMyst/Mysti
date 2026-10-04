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
 * Plan 45: the Claude Code plugin adapter. The fixture is real
 * `claude plugin list --json --available` output (2.1.278), trimmed and with
 * the home directory scrubbed. The two exit-code facts below were observed on
 * the same CLI: a failed install exits 0, an already-disabled disable exits 1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PLUGIN_ADAPTERS, PluginCliError } from '../../../src/services/plugins/PluginAdapters';
import type { PluginAdapter, Run, RunResult, CatalogPlugin } from '../../../src/services/plugins/PluginAdapters';

const claude = PLUGIN_ADAPTERS['claude-code'] as PluginAdapter;
const FIXTURE = fs.readFileSync(path.join(__dirname, '../../fixtures/plugins/claude-list.json'), 'utf8');

function ok(stdout: string, code = 0): RunResult {
  return { code, stdout, stderr: '', timedOut: false };
}

/** A fake CLI: answers by the joined argv, records every call. */
function fakeRun(answers: Record<string, RunResult>): Run & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const key = args.join(' ');
    if (!(key in answers)) { throw new Error(`unexpected argv: ${key}`); }
    return answers[key];
  }) as Run & { calls: string[][] };
  run.calls = calls;
  return run;
}

const ID = 'commit-commands@claude-plugins-official';

describe('Claude Code plugin adapter (Plan 45)', () => {
  it('lists installed and available plugins from the real JSON shape', async () => {
    const listing = await claude.list(fakeRun({ 'plugin list --json --available': ok(FIXTURE) }));
    const sp = listing.installed.find((p) => p.name === 'superpowers');
    expect(sp).toMatchObject({ id: 'superpowers@claude-plugins-official', marketplace: 'claude-plugins-official', scope: 'user', enabled: true, version: '6.4.1' });
    expect(listing.installed.find((p) => p.name === 'playwright')?.enabled).toBe(false);
    expect(listing.installed.find((p) => p.name === 'ponytail')?.marketplace).toBe('ponytail');
    const c7 = listing.available?.find((p) => p.name === 'context7');
    expect(c7).toMatchObject({ id: 'context7@claude-plugins-official', marketplace: 'claude-plugins-official', installCount: 454347 });
    expect(c7?.description).toMatch(/Context7/);
  });

  it('refuses to read a list that is not JSON instead of showing it as empty', async () => {
    await expect(claude.list(fakeRun({ 'plugin list --json --available': ok('Installed plugins:\n  none') })))
      .rejects.toThrow("Couldn't read Claude Code's plugin list");
  });

  it('installs with the scope flag and --json, and no consent flag', async () => {
    const run = fakeRun({ [`plugin install ${ID} -s project --json`]: ok('{"command":"install","outcome":"success"}') });
    await claude.install(run, ID, 'project');
    expect(run.calls).toEqual([['plugin', 'install', ID, '-s', 'project', '--json']]);
    expect(run.calls.flat()).not.toContain('-y');
  });

  it('pins an approved marketplace command by its hash', async () => {
    const sha = 'a'.repeat(64);
    const run = fakeRun({ [`plugin install ${ID} -s user --json --accept-command ${sha}`]: ok('{"outcome":"success"}') });
    await claude.install(run, ID, 'user', { acceptCommandSha: sha });
    expect(run.calls[0].slice(-2)).toEqual(['--accept-command', sha]);
  });

  it('treats outcome "failed" as a failure even when the CLI exits 0', async () => {
    const failed = '{"command":"install","outcome":"failed","plugin":"x","message":"Plugin \\"x\\" not found in marketplace \\"claude-plugins-official\\"","failureCode":"not_found"}';
    const run = fakeRun({ [`plugin install ${ID} -s user --json`]: ok(failed, 0) });
    await expect(claude.install(run, ID, 'user')).rejects.toThrow('Plugin "x" not found in marketplace "claude-plugins-official"');
  });

  it('treats "already in that state" as success even though the CLI exits 1', async () => {
    const already = '{"command":"disable","outcome":"failed","message":"already disabled","failureCode":"already_in_goal_state","alreadyInGoalState":true}';
    const run = fakeRun({ 'plugin disable playwright@claude-plugins-official -s user --json': ok(already, 1) });
    await expect(claude.setEnabled!(run, { id: 'playwright@claude-plugins-official', name: 'playwright', scope: 'user' }, false)).resolves.toBeUndefined();
  });

  it('fails when there is no JSON result line at all', async () => {
    const run = fakeRun({ [`plugin install ${ID} -s user --json`]: { code: 0, stdout: '', stderr: 'boom', timedOut: false } });
    await expect(claude.install(run, ID, 'user')).rejects.toThrow('boom');
  });

  it('surfaces a marketplace-declared command from its shownCommand, as the CLI reports it', async () => {
    const sha = 'b'.repeat(64);
    const body = JSON.stringify({ command: 'install', outcome: 'failed', message: 'needs approval',
      shownCommand: { kind: 'install', pluginId: ID, command: ['npm', 'run', 'setup'], archiveUrl: 'https://example.com/a.tgz', sha256: sha } });
    const run = fakeRun({ [`plugin install ${ID} -s user --json`]: ok(body, 1) });
    const err = await claude.install(run, ID, 'user').catch((e) => e);
    expect(err).toBeInstanceOf(PluginCliError);
    expect(err.acceptCommand).toEqual({ command: 'npm run setup', sha, archiveUrl: 'https://example.com/a.tgz' });
  });

  it('never mistakes a hash for the command when the keys are flat', async () => {
    const body = JSON.stringify({ outcome: 'failed', message: 'needs approval', commandSha256: 'b'.repeat(64), declaredCommand: 'npm run setup' });
    const run = fakeRun({ [`plugin install ${ID} -s user --json`]: ok(body, 1) });
    const err = await claude.install(run, ID, 'user').catch((e) => e);
    expect(err.acceptCommand).toBeUndefined();
  });

  it('updates with an approved command pinned, like install', async () => {
    const sha = 'd'.repeat(64);
    const p = { id: ID, name: 'commit-commands', scope: 'user' as const };
    const run = fakeRun({ [`plugin update ${ID} -s user --json --accept-command ${sha}`]: ok('{"outcome":"ok"}') });
    await claude.update!(run, p, { acceptCommandSha: sha });
    expect(run.calls[0].slice(-2)).toEqual(['--accept-command', sha]);
  });

  it('uninstalls, enables and updates in the plugin\'s own scope', async () => {
    const p = { id: ID, name: 'commit-commands', scope: 'local' as const };
    const run = fakeRun({
      [`plugin uninstall ${ID} -s local --json`]: ok('{"outcome":"success"}'),
      [`plugin enable ${ID} -s local --json`]: ok('{"outcome":"success"}'),
      [`plugin update ${ID} -s local --json`]: ok('{"outcome":"success"}'),
    });
    await claude.uninstall!(run, p);
    await claude.setEnabled!(run, p, true);
    await claude.update!(run, p);
    expect(run.calls.map((c) => c[1])).toEqual(['uninstall', 'enable', 'update']);
  });

  it('returns the details text as the CLI printed it', async () => {
    const run = fakeRun({ [`plugin details ${ID}`]: ok('commit-commands\n  Skills (0)\n') });
    expect(await claude.details!(run, { id: ID, name: 'commit-commands', scope: 'user' })).toContain('Skills (0)');
  });

  it('manages marketplaces', async () => {
    const run = fakeRun({
      'plugin marketplace list --json': ok('[{"name":"ponytail","source":"github","repo":"DietrichGebert/ponytail","installLocation":"/x"}]'),
      'plugin marketplace add owner/repo': ok(''),
      'plugin marketplace remove ponytail': ok(''),
      'plugin marketplace update ponytail': ok(''),
    });
    expect(await claude.marketplaces!.list(run)).toEqual([{ name: 'ponytail', source: 'DietrichGebert/ponytail' }]);
    await claude.marketplaces!.add(run, 'owner/repo');
    await claude.marketplaces!.remove(run, 'ponytail');
    await claude.marketplaces!.refresh(run, 'ponytail');
    const failing = fakeRun({ 'plugin marketplace add bad': { code: 1, stdout: '', stderr: 'not a repo', timedOut: false } });
    await expect(claude.marketplaces!.add(failing, 'bad')).rejects.toThrow('not a repo');
  });

  describe('inspect: what runs code, read from the marketplace copy on disk', () => {
    let dir: string;
    const entry = (name: string): CatalogPlugin => ({ id: `${name}@mk`, name, marketplace: 'mk' });
    const listRun = () => fakeRun({
      'plugin marketplace update mk': ok(''),
      'plugin marketplace list --json': ok(JSON.stringify([{ name: 'mk', installLocation: dir }])),
    });

    function write(rel: string, body = '{}'): void {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-mk-'));
      write('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [
        { name: 'hooky', source: './plugins/hooky' },
        { name: 'mcpy', source: './plugins/mcpy' },
        { name: 'lspy', source: './plugins/lspy', lspServers: { ts: { command: 'tsls' } } },
        { name: 'plain', source: './plugins/plain' },
        { name: 'declared', source: './plugins/declared' },
        { name: 'remote', source: { source: 'url', url: 'https://example.com/x.git' } },
        { name: 'escape', source: '../../outside' },
      ] }));
      write('plugins/hooky/hooks/hooks.json');
      write('plugins/lspy/README.md', '# lspy');
      write('plugins/mcpy/.mcp.json');
      write('plugins/plain/commands/go.md', '# go');
      write('plugins/plain/.claude-plugin/plugin.json', '{"name":"plain"}');
      write('plugins/declared/.claude-plugin/plugin.json', '{"name":"declared","hooks":"./custom/hooks.json"}');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('finds hooks in hooks/hooks.json', async () => {
      expect(await claude.inspect(listRun(), entry('hooky'))).toEqual(['Hooks']);
    });
    it('finds an MCP server in .mcp.json', async () => {
      expect(await claude.inspect(listRun(), entry('mcpy'))).toEqual(['MCP servers']);
    });
    it('finds an LSP server declared inline in the marketplace entry', async () => {
      expect(await claude.inspect(listRun(), entry('lspy'))).toEqual(['LSP servers']);
    });
    it('finds hooks declared at a custom path in plugin.json', async () => {
      expect(await claude.inspect(listRun(), entry('declared'))).toEqual(['Hooks']);
    });
    it('reports nothing for a commands-only plugin', async () => {
      expect(await claude.inspect(listRun(), entry('plain'))).toEqual([]);
    });
    it('cannot see inside a plugin fetched from elsewhere', async () => {
      expect(await claude.inspect(listRun(), entry('remote'))).toBe('unknown');
    });
    it('treats a source outside the marketplace as unknown', async () => {
      expect(await claude.inspect(listRun(), entry('escape'))).toBe('unknown');
    });
    it('treats a manifest key it does not recognise as unknown, not as safe', async () => {
      write('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'novel', source: './plugins/plain', backgroundJobs: ['x'] }] }));
      expect(await claude.inspect(listRun(), entry('novel'))).toBe('unknown');
    });
    it('finds monitors declared in the manifest', async () => {
      write('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'watched', source: './plugins/plain', monitors: ['x'] }] }));
      expect(await claude.inspect(listRun(), entry('watched'))).toEqual(['Monitors']);
    });
    it('treats a plugin directory that is not on disk as unknown', async () => {
      write('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'gone', source: './plugins/gone' }] }));
      expect(await claude.inspect(listRun(), entry('gone'))).toBe('unknown');
    });
    it('finds monitors in monitors/monitors.json (same trust tier as hooks)', async () => {
      write('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'watchy', source: './plugins/watchy' }] }));
      write('plugins/watchy/monitors/monitors.json');
      write('plugins/watchy/commands/go.md', '# go');
      expect(await claude.inspect(listRun(), entry('watchy'))).toEqual(['Monitors']);
    });
    it('treats a top-level entry it does not recognise as unknown, not as safe', async () => {
      write('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'flowy', source: './plugins/flowy' }] }));
      write('plugins/flowy/workflows/run.js', 'x');
      write('plugins/flowy/commands/go.md', '# go');
      expect(await claude.inspect(listRun(), entry('flowy'))).toBe('unknown');
    });
    it('still names what it does recognise next to something it does not', async () => {
      write('.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'mixed', source: './plugins/mixed' }] }));
      write('plugins/mixed/hooks/hooks.json');
      write('plugins/mixed/hooks-handlers/run.sh', 'x');
      expect(await claude.inspect(listRun(), entry('mixed'))).toEqual(['Hooks', 'Other content']);
    });
    it('treats a bare source name as unknown (it may resolve under pluginRoot)', async () => {
      write('.claude-plugin/marketplace.json', JSON.stringify({ metadata: { pluginRoot: './real' }, plugins: [{ name: 'decoy', source: 'decoy' }] }));
      write('decoy/commands/go.md', '# go');
      write('real/decoy/hooks/hooks.json');
      expect(await claude.inspect(listRun(), entry('decoy'))).toBe('unknown');
    });
    it('refreshes the marketplace before looking, so it inspects what the install will use', async () => {
      const run = listRun();
      await claude.inspect(run, entry('plain'));
      expect(run.calls[0]).toEqual(['plugin', 'marketplace', 'update', 'mk']);
    });
    it('treats a marketplace it could not refresh as unknown', async () => {
      const run = fakeRun({
        'plugin marketplace update mk': { code: 1, stdout: '', stderr: 'offline', timedOut: false },
        'plugin marketplace list --json': ok(JSON.stringify([{ name: 'mk', installLocation: dir }])),
      });
      expect(await claude.inspect(run, entry('plain'))).toBe('unknown');
    });
    it('treats a plugin missing from the manifest as unknown', async () => {
      expect(await claude.inspect(listRun(), entry('ghost'))).toBe('unknown');
    });
  });
});
