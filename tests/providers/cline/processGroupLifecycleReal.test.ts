import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../../src/constants';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableClineProvider } from '../../helpers/providerFactory';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitUntil(check: () => boolean, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) { return false; }
    await pause(20);
  }
  return true;
}

function ps(pid: number, columns: string): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', columns], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}
function running(pid: number): boolean {
  const state = ps(pid, 'stat=');
  return state.length > 0 && !state.startsWith('Z');
}
const identity = (pid: number) => ps(pid, 'pid=,ruid=,lstart=,command=');

// Real spawn, Cline stream parsing, cancellation and shared cleanup. Only CLI
// path/arguments and prompt construction are redirected to disposable fixtures.
// Children stay in their launcher's group: deliberately detached shared services
// and Windows taskkill behavior are outside this POSIX regression's scope.
describe.skipIf(process.platform === 'win32')('Cline real process-group lifecycle', () => {
  it.each(['stop', 'completed'] as const)(
    'cleans descendants after %s without touching an unrelated process',
    async mode => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-group-'));
      const file = (name: string) => path.join(directory, name);
      const provider = new TestableClineProvider();
      const originalFolders = vscode.workspace.workspaceFolders;
      const children = new Map<number, string>();
      let leader: ChildProcess | undefined, sentinel: ChildProcess | undefined;
      let completion: Promise<void> | undefined;
      let finished = false;
      const chunks: StreamChunk[] = [];
      const lifecycle: { exit?: unknown; close?: unknown } = {};
      let clearCount = 0;
      fs.writeFileSync(file('child.cjs'), `
const fs = require('node:fs');
const [directory, name, ignoreTerm] = process.argv.slice(2);
const file = suffix => require('node:path').join(directory, name + '-' + suffix);
process.on('SIGTERM', () => {
  fs.appendFileSync(file('term'), 'TERM received\\n');
  if (ignoreTerm !== 'true') process.exit(0);
});
setInterval(() => {
  if (fs.existsSync(file('trigger')) && !fs.existsSync(file('canary'))) {
    fs.writeFileSync(file('canary') + '.tmp', 'owned fixture still executes');
    fs.renameSync(file('canary') + '.tmp', file('canary'));
  }
}, 10);
fs.writeFileSync(file('ready') + '.tmp', String(process.pid));
fs.renameSync(file('ready') + '.tmp', file('ready'));
`);
      fs.writeFileSync(file('launcher.cjs'), `
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const [directory, mode, prompt] = process.argv.slice(2);
const file = name => path.join(directory, name);
process.on('SIGTERM', () => { fs.writeFileSync(file('leader-term'), 'TERM received'); process.exit(0); });
const child = spawn(process.execPath, [file('child.cjs'), directory, 'descendant', String(mode === 'stop')], { stdio: 'ignore' });
child.unref();
let announced = false;
setInterval(() => {
  if (!announced && fs.existsSync(file('descendant-ready'))) {
    fs.writeFileSync(file('leader-ready') + '.tmp', JSON.stringify({ pid: process.pid, childPid: child.pid, prompt }));
    fs.renameSync(file('leader-ready') + '.tmp', file('leader-ready'));
    process.stdout.write(JSON.stringify({ type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: 'Fixture response' } }) + '\\n');
    announced = true;
  }
  if (mode === 'completed' && fs.existsSync(file('finish-leader'))) process.exit(0);
}, 10);
`);

      try {
        (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = [
          { uri: vscode.Uri.file(directory), name: 'owned fixture', index: 0 },
        ];
        vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
        vi.spyOn(provider, 'buildCliArgs').mockReturnValue([file('launcher.cjs'), directory, mode]);
        vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Harmless process cleanup fixture');
        const settings: Settings = { provider: 'cline', model: '', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };
        const tracker = {
          registerProcess: (_panel: string, proc: ChildProcess) => {
            leader = proc;
            proc.on('exit', (code, signal) => { lifecycle.exit = { code, signal }; });
            proc.on('close', (code, signal) => { lifecycle.close = { code, signal }; });
          },
          clearProcess: (_panel: string, proc: ChildProcess) => {
            expect(proc).toBe(leader);
            clearCount++;
          },
        };
        completion = (async () => {
          for await (const chunk of provider.sendMessage('fixture', [], settings, null, undefined, 'owned-panel', tracker)) {
            chunks.push(chunk);
          }
        })().finally(() => { finished = true; });
        expect(await waitUntil(() => fs.existsSync(file('leader-ready')))).toBe(true);
        const ready = JSON.parse(fs.readFileSync(file('leader-ready'), 'utf8'));
        expect(ready).toEqual({ pid: leader!.pid, childPid: expect.any(Number), prompt: 'Harmless process cleanup fixture' });
        const childPid = ready.childPid as number;
        children.set(childPid, identity(childPid));
        expect(children.get(childPid)).toContain(file('child.cjs'));
        expect(running(childPid)).toBe(true);
        const leaderGroup = Number(ps(leader!.pid!, 'pgid='));
        expect(Number(ps(childPid, 'pgid='))).toBe(leaderGroup);
        expect(await waitUntil(() => chunks.some(chunk => chunk.type === 'text' && chunk.content === 'Fixture response'))).toBe(true);

        // An independent owned process is a positive control for overbroad kills.
        sentinel = spawn(process.execPath, [file('child.cjs'), directory, 'sentinel', 'false'], {
          detached: true, stdio: 'ignore',
        });
        expect(await waitUntil(() => fs.existsSync(file('sentinel-ready')))).toBe(true);
        expect(Number(fs.readFileSync(file('sentinel-ready'), 'utf8'))).toBe(sentinel.pid);
        expect(Number(ps(sentinel.pid!, 'pgid='))).not.toBe(leaderGroup);

        const started = Date.now();
        if (mode === 'stop') { provider.cancelCurrentRequest('owned-panel'); }
        else { fs.writeFileSync(file('finish-leader'), 'exit normally'); }
        expect(await waitUntil(() => finished && lifecycle.close !== undefined)).toBe(true);
        await completion;
        const descendantGone = await waitUntil(() => !running(childPid), PROCESS_KILL_GRACE_PERIOD_MS + 1500);
        const elapsedMs = Date.now() - started;
        fs.writeFileSync(file('descendant-trigger'), 'must not execute after cleanup');
        fs.writeFileSync(file('sentinel-trigger'), 'must execute');
        expect(await waitUntil(() => fs.existsSync(file('sentinel-canary')))).toBe(true);
        await pause(100);
        const evidence = {
          mode, leaderPid: leader!.pid, childPid, sentinelPid: sentinel.pid,
          leaderGroup, lifecycle, descendantGone, elapsedMs,
          childReceivedTerm: fs.existsSync(file('descendant-term')),
          descendantWroteAfterCleanup: fs.existsSync(file('descendant-canary')),
          sentinelAlive: running(sentinel.pid!), sentinelReceivedTerm: fs.existsSync(file('sentinel-term')),
          sentinelCanary: fs.readFileSync(file('sentinel-canary'), 'utf8'), clearCount,
        };
        console.log('[Cline real group lifecycle]', JSON.stringify(evidence));
        expect.soft(descendantGone).toBe(true);
        expect.soft(evidence.childReceivedTerm).toBe(true);
        expect.soft(evidence.descendantWroteAfterCleanup).toBe(false);
        expect.soft(evidence.sentinelAlive).toBe(true);
        expect.soft(evidence.sentinelReceivedTerm).toBe(false);
        expect.soft(evidence.sentinelCanary).toBe('owned fixture still executes');
        expect.soft(leaderGroup).toBe(leader!.pid);
        expect.soft(clearCount).toBe(1);
        expect.soft(chunks.some(chunk => chunk.type === 'error')).toBe(false);
        if (mode === 'completed') {
          expect.soft(lifecycle).toEqual({ exit: { code: 0, signal: null }, close: { code: 0, signal: null } });
          expect.soft(chunks.at(-1)?.type).toBe('done');
        } else {
          expect.soft(chunks.some(chunk => chunk.type === 'done')).toBe(false);
          expect.soft(elapsedMs).toBeGreaterThanOrEqual(PROCESS_KILL_GRACE_PERIOD_MS - 50);
        }
      } finally {
        provider.dispose();
        // Emergency cleanup is independent of product group ownership, including
        // the deliberately leaking red run. Never signal our inherited group.
        if (leader && leader.exitCode === null && leader.signalCode === null) { leader.kill('SIGKILL'); }
        if (sentinel && sentinel.exitCode === null && sentinel.signalCode === null) { sentinel.kill('SIGKILL'); }
        const ready = file('descendant-ready');
        if (fs.existsSync(ready)) {
          const pid = Number(fs.readFileSync(ready, 'utf8'));
          if (!children.has(pid)) {
            const current = identity(pid);
            if (current.includes(file('child.cjs'))) { children.set(pid, current); }
          }
        }
        for (const [pid, expected] of children) {
          if (expected && identity(pid) === expected) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
          }
        }
        const allGone = await waitUntil(() => [...children.keys()].every(pid => !running(pid))
          && (!leader || leader.exitCode !== null || leader.signalCode !== null)
          && (!sentinel || sentinel.exitCode !== null || sentinel.signalCode !== null));
        (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = originalFolders;
        vi.restoreAllMocks();
        expect(allGone, 'all exact owned fixture processes reclaimed').toBe(true);
        if (completion) { await completion; }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }, 15_000,
  );
});
