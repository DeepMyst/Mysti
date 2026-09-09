/** Actual installed native gateway and stock tools against an inert loopback model. */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execute = promisify(execFile);
const project = path.resolve(__dirname, '../../..');
const installedRoot = process.env.MYSTI_TEST_OPENCLAW_ROOT || '/usr/local/lib/node_modules/openclaw';
const installed = existsSync(path.join(installedRoot, 'dist/agent-tools.before-tool-call-59sE70R-.js'));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) { await fs.rm(directory, { recursive: true, force: true }); }
});

describe('installed OpenClaw owned native approval integration', () => {
  for (const mode of ['normal', 'missing-admission', 'gateway-crash'] as const) {
    const name = mode === 'normal'
      ? 'gates actual model admission and stock write/edit/exec across approval, denial, read-only, Stop, and broker disconnect'
      : mode === 'missing-admission' ? 'refuses broker readiness when actual plugin registration omits the model admission hook'
        : 'kills actual approved foreground exec after the owned native gateway crashes';
    it.skipIf(!installed || process.platform === 'win32')(name, { timeout: 120000 }, async () => {
      const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-native-policy-integration-')));
      directories.push(fixture);
      const bundleDir = path.join(fixture, 'bundles');
      await build({ entryPoints: ['OpenClawManagedRuntime', 'OpenClawPolicyBroker', 'OpenClawGateway'].map(name =>
        path.join(project, 'src/providers/openclaw', `${name}.ts`)), bundle: true, platform: 'node', format: 'cjs',
      outdir: bundleDir, logLevel: 'silent' });
      // Deliberately omit HOME, model credentials, user config and inherited Node preload settings.
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
        MYSTI_PROBE_ROOT: fixture, MYSTI_TEST_OPENCLAW_ROOT: installedRoot, MYSTI_TEST_BUNDLE_DIR: bundleDir };
      let executionError: unknown;
      try {
        await execute(process.execPath, [path.join(project, 'tests/fixtures/openclaw/managedGatewayAgent.mjs'), mode], {
          cwd: project, env, timeout: 105000, maxBuffer: 1024 * 1024,
        });
      } catch (error) { executionError = error; }
      const evidence = path.join(project, 'out-test/release-evidence', `item2-native-policy-${Date.now()}`);
      await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
      for (const name of ['result.json', 'guard.jsonl']) {
        try { await fs.copyFile(path.join(fixture, name), path.join(evidence, name)); } catch { /* Startup may precede the guard. */ }
      }
      await fs.writeFile(path.join(evidence, 'process-error.txt'), executionError instanceof Error ? executionError.message : 'Process passed');
      const result = JSON.parse(await fs.readFile(path.join(fixture, 'result.json'), 'utf8'));
      expect(result.error, `${executionError instanceof Error ? executionError.message : ''}\nEvidence: ${evidence}`).toBeUndefined();
      expect(result.passed).toBe(true);
      expect(result.nativeReady).toBe(true);
      if (mode === 'normal') {
        expect(result.policyReady).toBe(true);
        expect(result.cases.map((entry: { name: string }) => entry.name)).toEqual([
          'missing lease blocks before model', 'pipeline', 'deny', 'readonly', 'cancel', 'disconnect',
        ]);
        expect(result.pendingChecks).toEqual(['write absent while card pending', 'exec absent while card pending']);
        expect(result.cards.filter((card: { scenario: string }) => card.scenario === 'readonly')).toHaveLength(0);
        expect(result.decisions).toContainEqual({ scenario: 'readonly', tool: 'write', decision: 'deny' });
        for (const request of result.modelRequests) { expect(request.tools.sort()).toEqual(['edit', 'exec', 'read', 'write']); }
      } else if (mode === 'gateway-crash') {
        expect(result.policyReady).toBe(true);
        expect(result.decisions).toEqual([{ scenario: 'crash', tool: 'exec', decision: 'allow' }]);
        expect(result.cards).toHaveLength(1);
        expect(result.cases).toEqual([expect.objectContaining({ name: 'gateway crash kills approved foreground exec',
          delayedEffectAbsent: true, privateStateRemoved: true })]);
        expect(result.cases[0].toolGroup).toBe(result.cases[0].gatewayPid);
        expect(result.modelRequests).toHaveLength(1);
      } else {
        expect(result.policyReady).toBe(false);
        expect(result.modelRequests).toHaveLength(0);
        expect(result.cases.map((entry: { name: string }) => entry.name)).toEqual(['missing admission prevents broker readiness']);
      }
      const io = (await fs.readFile(path.join(fixture, 'guard.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(io.filter(entry => entry.blockedNetwork || entry.blockedDns || entry.blockedFetch)).toHaveLength(0);
      expect(io.filter(entry => entry.blockedFile && entry.write)).toHaveLength(0);
      expect(io.filter(entry => entry.blockedFile?.includes('/.openclaw/'))).toHaveLength(0);
      expect(await fs.readdir(path.join(fixture, 'storage'))).toEqual([]);
    });
  }
});
