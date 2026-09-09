/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const project = path.resolve(__dirname, '../../..');
const preload = path.join(project, 'resources/openclaw-policy/runtime-preload.mjs');
const fixture = path.join(project, 'tests/fixtures/openclaw/finalExecutionAgent.mjs');
const installedRoot = process.env.MYSTI_TEST_OPENCLAW_ROOT || '/usr/local/lib/node_modules/openclaw';
const installed = fs.existsSync(path.join(installedRoot, 'dist/agent-tools.before-tool-call-59sE70R-.js'));
const directories: string[] = [];

function environment(root = installedRoot) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-final-execution-'));
  directories.push(workspace);
  const config = path.join(workspace, 'openclaw.json');
  fs.writeFileSync(config, JSON.stringify({
    logging: { level: 'silent', consoleLevel: 'silent', file: path.join(workspace, 'runtime.log') },
    agents: { defaults: { workspace } },
    tools: { allow: ['read', 'write', 'edit', 'exec'], exec: { host: 'gateway', security: 'full', ask: 'off' } },
    plugins: { enabled: false },
  }));
  return { workspace, env: {
    ...process.env,
    MYSTI_TEST_WORKSPACE: workspace,
    MYSTI_OPENCLAW_OWNED_RUNTIME: '1', MYSTI_OPENCLAW_ROOT: root,
    OPENCLAW_STATE_DIR: path.join(workspace, 'state'), OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_TEST_FAST: '1',
  } };
}

async function run(mode: string, usePreload = true) {
  const { env } = environment();
  const result = await execute(process.execPath, [...usePreload ? ['--import', preload] : [], fixture, mode], {
    cwd: project, env, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

afterEach(() => { for (const directory of directories.splice(0)) { fs.rmSync(directory, { recursive: true, force: true }); } });

describe('owned OpenClaw final execution guard', () => {
  it('enforces scoped policy, cancellation, immutable arguments and descendant tombstones', async () => {
    const result = await run('unit', false);
    expect(result.cases).toHaveLength(15);
    expect(result.networkAttempts).toBe(0);
  });

  it.skipIf(!installed)('instruments the actual installed wrapper after all argument mutations', { timeout: 30000 }, async () => {
    const result = await run('pipeline');
    expect(result.cases).toHaveLength(9);
    expect(result.effects).toBe(4);
    expect(result.receipt.version).toBe('2026.6.34');
    expect(result.networkAttempts).toBe(0);
  });

  it.skipIf(!installed)('preserves real stock read, write, edit and inert exec behavior', { timeout: 30000 }, async () => {
    const result = await run('core');
    expect(result.cases).toHaveLength(5);
    expect(result.networkAttempts).toBe(0);
  });

  it.skipIf(!installed)('rechecks verified source when it is loaded after startup', async () => {
    const { workspace, env } = environment();
    const root = path.join(workspace, 'installation');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    const files = ['package.json', 'dist/agent-tools.before-tool-call-59sE70R-.js',
      'dist/hook-runner-global-D_43rcnU.js', 'dist/agent-tools-Dpv9_S5A.js', 'dist/native-hook-relay-B-nKeNyC.js',
      'dist/supervisor-BsgzaQWk.js', 'dist/bash-tools.exec-runtime-DhPzqgnv.js'];
    for (const filename of files) { fs.copyFileSync(path.join(installedRoot, filename), path.join(root, filename)); }
    const target = path.join(root, files[1]);
    const script = `require('node:fs').appendFileSync(${JSON.stringify(target)}, ' // changed after preload'); import(require('node:url').pathToFileURL(${JSON.stringify(target)}).href).catch(error => { console.error(error); process.exitCode = 1; });`;
    await expect(execute(process.execPath, ['--import', preload, '-e', script], {
      env: { ...env, MYSTI_OPENCLAW_ROOT: root }, timeout: 10000,
    })).rejects.toThrow(/source does not match/);
  });

  it('does not activate when the owned-process environment marker is absent', async () => {
    const { env } = environment('/not-an-installation');
    const result = await execute(process.execPath, ['--import', preload, '-e', 'process.stdout.write("entry executed")'], {
      env: { ...env, MYSTI_OPENCLAW_OWNED_RUNTIME: '' }, timeout: 10000,
    });
    expect(result.stdout).toBe('entry executed');
  });

  for (const scenario of ['version', 'source'] as const) {
    it(`rejects a ${scenario} mismatch before the application entrypoint executes`, async () => {
      const { workspace, env } = environment();
      const root = path.join(workspace, 'installation');
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw', version: scenario === 'version' ? '2026.6.35' : '2026.6.34' }));
      fs.writeFileSync(path.join(root, 'dist/agent-tools.before-tool-call-59sE70R-.js'), 'export const changed = true;');
      const marker = path.join(workspace, 'entry-ran');
      await expect(execute(process.execPath, ['--import', preload, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`], {
        env: { ...env, MYSTI_OPENCLAW_ROOT: root }, timeout: 10000,
      })).rejects.toThrow(scenario === 'version' ? /requires verified OpenClaw/ : /source does not match/);
      expect(fs.existsSync(marker)).toBe(false);
    });
  }
});
