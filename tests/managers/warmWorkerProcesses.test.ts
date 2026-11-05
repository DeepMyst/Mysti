import { execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SuggestionManager } from '../../src/managers/SuggestionManager';
import { PlanOptionManager } from '../../src/managers/PlanOptionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

const redirect = vi.hoisted(() => ({ directory: '', processes: [] as ChildProcess[] }));
vi.mock('child_process', async original => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, spawn: (_command: string, _args: string[], options: any) => {
    // Real OS children replace only the model executable. All manager process
    // options, stream ownership, and processKill behavior remain production code.
    const id = String(redirect.processes.length);
    const proc = actual.spawn(process.execPath, [path.join(redirect.directory, 'wrapper.cjs'),
      path.join(redirect.directory, 'native.cjs'), path.join(redirect.directory, `${id}.pid`)], options);
    redirect.processes.push(proc);
    return proc;
  } };
});

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) { throw new Error(`Timed out: ${label}`); }
    await pause(15);
  }
}
function running(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch { return false; }
}

describe.skipIf(process.platform === 'win32')('PC-07 actual auxiliary worker teardown', () => {
  it('disposal settles title/classification and kills their real wrapper descendants without respawning', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-auxiliary-workers-'));
    redirect.directory = directory;
    redirect.processes = [];
    fs.writeFileSync(path.join(directory, 'wrapper.cjs'), `
const { spawnSync } = require('node:child_process');
spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit' });
`);
    fs.writeFileSync(path.join(directory, 'native.cjs'), `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
process.stderr.write(Buffer.alloc(512 * 1024, 120));
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[2], String(process.pid));
`);
    clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/no-inference-worker');
    let suggestions: SuggestionManager | undefined;
    let plans: PlanOptionManager | undefined;
    let descendants: number[] = [];
    try {
      suggestions = new SuggestionManager({} as any);
      plans = new PlanOptionManager();
      expect(redirect.processes).toHaveLength(0);
      const title = suggestions.generateTitle('Review bounded retry behavior');
      const classification = plans.classifyResponse('Compare a fixed retry delay with an exponential backoff and show their tradeoffs.');
      expect(redirect.processes).toHaveLength(2);
      await until(() => [0, 1].every(id => fs.existsSync(path.join(directory, `${id}.pid`))), 'all actual native workers ready');
      descendants = [0, 1].map(id => Number(fs.readFileSync(path.join(directory, `${id}.pid`), 'utf8')));
      for (const pid of descendants) expect(running(pid)).toBe(true);
      const started = Date.now();
      suggestions.dispose(); plans.dispose();
      expect(await title).toBe('Review bounded retry behavior');
      expect(await classification).toMatchObject({ questions: [], planOptions: [] });
      await until(() => redirect.processes.every(proc => proc.exitCode !== null || proc.signalCode !== null)
        && descendants.every(pid => !running(pid)), 'all owned wrappers and descendants exit');
      await pause(100);
      expect(redirect.processes).toHaveLength(2);
      console.log('[PC07 actual auxiliary disposal]', JSON.stringify({ wrappers: 2, descendants: 2,
        allExited: true, noRespawn: true, settlementAndExitMs: Date.now() - started,
        scope: 'Disposable Node POSIX wrappers only; no installed CLI, paid inference, or attribution of native editor-exit PIDs.' }));
    } finally {
      suggestions?.dispose(); plans?.dispose();
      // Emergency cleanup targets only the groups created by this fixture.
      for (const proc of redirect.processes) {
        if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* Already gone. */ } }
      }
      await until(() => redirect.processes.every(proc => proc.exitCode !== null || proc.signalCode !== null)
        && descendants.every(pid => !running(pid)), 'fixture emergency cleanup');
      clearMockConfig();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
