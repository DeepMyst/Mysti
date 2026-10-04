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
 * Plan 45: the Copilot, OpenClaw and Hermes adapters, the backends that are
 * notes only, and the runner itself. Copilot and OpenClaw fixtures are real
 * output (Copilot 1.0.89, OpenClaw 2026.6.34), trimmed. Copilot's installed
 * list and all of Hermes come from their documented JSON (nothing installed /
 * CLI not installed here).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PLUGIN_ADAPTERS, isAdapter, runCli, cleanCliText } from '../../../src/services/plugins/PluginAdapters';
import type { PluginAdapter, Run, RunResult } from '../../../src/services/plugins/PluginAdapters';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, '../../fixtures/plugins', f), 'utf8');
const ok = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: '', timedOut: false });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr, timedOut: false });

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

describe('Copilot adapter (Plan 45)', () => {
  const copilot = PLUGIN_ADAPTERS['github-copilot'] as PluginAdapter;
  const markets = '[{"name":"copilot-plugins","source":"GitHub: github/copilot-plugins","isDefault":true},{"name":"awesome-copilot","source":"GitHub: github/awesome-copilot","isDefault":true}]';

  it('lists installed plugins and every marketplace catalog', async () => {
    const run = fakeRun({
      'plugin list --json': ok('[{"name":"workiq","marketplace":"copilot-plugins","version":"1.2.0","enabled":false}]'),
      'plugin marketplace list --json': ok(markets),
      'plugin marketplace browse copilot-plugins --json': ok(fx('copilot-browse-copilot-plugins.json')),
      'plugin marketplace browse awesome-copilot --json': ok(fx('copilot-browse-awesome-copilot.json')),
    });
    const listing = await copilot.list(run);
    // Same id as its catalog entry, so it is never also offered for install.
    expect(listing.installed).toEqual([expect.objectContaining({ id: 'workiq@copilot-plugins', name: 'workiq', marketplace: 'copilot-plugins', enabled: false, scope: 'user' })]);
    const ids = listing.available!.map((p) => p.id);
    expect(ids).toContain('microsoft-365-agents-toolkit@copilot-plugins');
    expect(ids).toContain('accessibility-kanban@awesome-copilot');
    expect(listing.warning).toBeUndefined();
  });

  it('keeps the rest of the catalog and warns when one marketplace fails to load', async () => {
    const run = fakeRun({
      'plugin list --json': ok('[]'),
      'plugin marketplace list --json': ok(markets),
      'plugin marketplace browse copilot-plugins --json': ok(fx('copilot-browse-copilot-plugins.json')),
      'plugin marketplace browse awesome-copilot --json': fail('network down'),
    });
    const listing = await copilot.list(run);
    expect(listing.available!.length).toBeGreaterThan(0);
    expect(listing.warning).toMatch(/awesome-copilot/);
  });

  it('installs by name@marketplace and reports a failure from the exit code', async () => {
    const run = fakeRun({ 'plugin install workiq@copilot-plugins': ok('') });
    await copilot.install(run, 'workiq@copilot-plugins', 'user');
    expect(run.calls).toEqual([['plugin', 'install', 'workiq@copilot-plugins']]);
    const bad = fakeRun({ 'plugin install nope@copilot-plugins': fail('Failed to install plugin: Error: Plugin "nope" not found in marketplace "copilot-plugins".') });
    await expect(copilot.install(bad, 'nope@copilot-plugins', 'user')).rejects.toThrow('not found in marketplace');
  });

  it('cannot see what a Copilot plugin contains before install', async () => {
    expect(await copilot.inspect(fakeRun({}), { id: 'workiq@copilot-plugins', name: 'workiq' })).toBe('unknown');
  });

  it('marks the built-in marketplaces so they are not offered for removal', async () => {
    const list = await copilot.marketplaces!.list(fakeRun({ 'plugin marketplace list --json': ok(markets) }));
    expect(list[0]).toEqual({ name: 'copilot-plugins', source: 'github/copilot-plugins', builtin: true });
  });
});

describe('OpenClaw adapter (Plan 45)', () => {
  const openclaw = PLUGIN_ADAPTERS['openclaw'] as PluginAdapter;

  it('lists bundled plugins as bundled, with their on/off state', async () => {
    const listing = await openclaw.list(fakeRun({ 'plugins list --json': ok(fx('openclaw-list.json')) }));
    expect(listing.installed).toEqual([
      expect.objectContaining({ id: 'cohere', name: 'Cohere', scope: 'bundled', enabled: true, description: 'OpenClaw Cohere provider plugin.' }),
      expect.objectContaining({ id: 'workboard', scope: 'bundled', enabled: false }),
    ]);
  });

  it('reads JSON that follows a config-warning banner', async () => {
    const banner = '│\n◇  Config warnings ───╮\n│  - plugins.entries.whatsapp: plugin not installed\n';
    const listing = await openclaw.list(fakeRun({ 'plugins list --json': ok(banner + fx('openclaw-list.json')) }));
    expect(listing.installed).toHaveLength(2);
  });

  it('searches ClawHub and installs a result by its clawhub: spec', async () => {
    const run = fakeRun({ 'plugins search memory --json --limit 25': ok(fx('openclaw-search.json')) });
    const results = await openclaw.search!(run, 'memory');
    expect(results[0]).toMatchObject({ id: 'clawhub:memory-lancedb-dreaming', name: 'Memory LanceDB Dreaming', version: '0.3.17', marketplace: 'ClawHub' });
    expect(results[1].id).toBe('clawhub:@openclaw/memory-lancedb');
    // Installed under its runtime id, which is how the panel knows it's already there.
    expect(results[1].installedAs).toBe('memory-lancedb');
    const install = fakeRun({ 'plugins install clawhub:@openclaw/memory-lancedb': ok('') });
    await openclaw.install(install, 'clawhub:@openclaw/memory-lancedb', 'user');
    expect(install.calls[0]).not.toContain('--force');
  });

  it('uninstalls with --force only to skip its terminal prompt', async () => {
    const run = fakeRun({ 'plugins uninstall memory-lancedb --force': ok('') });
    await openclaw.uninstall!(run, { id: 'memory-lancedb', name: 'memory-lancedb', scope: 'user' });
    expect(run.calls[0]).toEqual(['plugins', 'uninstall', 'memory-lancedb', '--force']);
  });

  it('strips the TUI frame from an error', async () => {
    const stderr = '│\n◇  Config warnings ──╮\n│  - plugins.entries.whatsapp: not installed  │\n├──────╯\nError: package not found: no-such-plugin\n';
    const run = fakeRun({ 'plugins install clawhub:nope': fail(stderr) });
    await expect(openclaw.install(run, 'clawhub:nope', 'user')).rejects.toThrow(/^Error: package not found: no-such-plugin$/);
  });
});

describe('Hermes adapter (Plan 45)', () => {
  const hermes = PLUGIN_ADAPTERS['hermes'] as PluginAdapter;

  it('lists plugins from its JSON, skipping removed ones', async () => {
    const out = JSON.stringify([
      { name: 'web-tools', status: 'enabled', version: '1.0.0', description: 'Web tools', source: 'catalog' },
      { name: 'notes', status: 'not enabled', version: '0.2.0', description: 'Notes', source: 'catalog' },
      { name: 'old', status: 'disabled', version: '0.1.0', removed: true },
    ]);
    const listing = await hermes.list(fakeRun({ 'plugins list --json': ok(out) }));
    expect(listing.installed.map((p) => [p.name, p.enabled])).toEqual([['web-tools', true], ['notes', false]]);
  });

  it('searches its catalog and reports what each plugin runs', async () => {
    const out = JSON.stringify({ query: 'web', results: [
      { name: 'web-tools', description: 'Web tools', version: '1.0.0', capabilities: { provides_tools: true, provides_hooks: true, provides_middleware: false } },
      { name: 'quiet', description: 'Declares nothing', version: '0.1.0', capabilities: {} },
    ] });
    const results = await hermes.search!(fakeRun({ 'plugins search web --json': ok(out) }), 'web');
    expect(results[0].codeParts).toEqual(['Hooks', 'Tools']);
    // A Hermes plugin is Python that runs in the agent, whatever it declares.
    expect(results[1].codeParts).toEqual(['Python code']);
    expect(await hermes.inspect(fakeRun({}), results[0])).toEqual(['Hooks', 'Tools']);
    expect(await hermes.inspect(fakeRun({}), { id: 'x', name: 'x' })).toBe('unknown');
  });

  it('installs enabled, so it never waits on its "Enable now?" prompt', async () => {
    const run = fakeRun({ 'plugins install web-tools --enable': ok('') });
    await hermes.install(run, 'web-tools', 'user');
    expect(run.calls[0]).toEqual(['plugins', 'install', 'web-tools', '--enable']);
  });
});

describe('the backend table (Plan 45)', () => {
  it('drives Claude Code, Copilot, OpenClaw and Hermes; notes the rest that have plugins; nothing for the HTTP backends', () => {
    const kind = (id: keyof typeof PLUGIN_ADAPTERS) => {
      const b = PLUGIN_ADAPTERS[id];
      return isAdapter(b) ? 'adapter' : b ? 'note' : 'none';
    };
    for (const id of ['claude-code', 'github-copilot', 'openclaw', 'hermes', 'openai-codex', 'google-gemini', 'qwen-code', 'cline', 'opencode', 'cursor'] as const) { expect(kind(id)).toBe('adapter'); }
    // Kimi manages plugins only inside its TUI.
    for (const id of ['kimi-code'] as const) { expect(kind(id)).toBe('note'); }
    for (const id of ['continue', 'ollama', 'localai', 'openrouter', 'minimax'] as const) { expect(kind(id)).toBe('none'); }
  });
});

describe('runCli (Plan 45)', () => {
  it('passes arguments verbatim with no shell', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned);x']);
    expect(r).toMatchObject({ code: 0, stdout: '$(echo pwned);x', timedOut: false });
  });

  it('closes stdin so a CLI that asks a question gets EOF instead of hanging', async () => {
    const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("eof:"+d.length))';
    const r = await runCli(process.execPath, ['-e', script], { timeoutMs: 5000 });
    expect(r).toMatchObject({ stdout: 'eof:0', timedOut: false });
  });

  it('kills a CLI that runs past its timeout', async () => {
    const r = await runCli(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('a timeout also kills what the CLI started (git, npm)', async () => {
    // The "CLI" starts a grandchild that would outlive it, prints its pid, then hangs.
    const script = 'const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});'
      + 'process.stdout.write(String(c.pid));setTimeout(()=>{},60000)';
    const r = await runCli(process.execPath, ['-e', script], { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    const grandchild = Number(r.stdout);
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 300));
    const alive = (() => { try { process.kill(grandchild, 0); return true; } catch { return false; } })();
    if (alive) { process.kill(grandchild, 'SIGKILL'); }
    expect(alive).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('returns as soon as the CLI exits, killing a child left holding its output (review P2-m1)', async () => {
    const started = Date.now();
    const r = await runCli('/bin/sh', ['-c', 'sleep 6 & echo started'], { timeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(3500);
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.stdout.trim()).toBe('started');
  });

  it('reports a missing binary instead of throwing', async () => {
    const r = await runCli('/nonexistent/mysti-test-cli', []);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it('cleanCliText keeps the last meaningful lines', () => {
    expect(cleanCliText('│\n◇  box ─╮\n\nreal error\n')).toBe('real error');
  });
});
