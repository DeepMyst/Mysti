import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { killProcessTree, markOwnedProcessGroup } from '../../src/utils/processKill';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) { throw new Error(`Timed out: ${label}`); }
    await pause(10);
  }
}

function running(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // A reparented zombie cannot execute or write. Its reaping belongs to init.
    return state.length > 0 && !state.startsWith('Z');
  } catch { return false; }
}

function processGroup(pid: number): number {
  return Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], {
    encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim());
}

interface OwnedFixture {
  proc: ChildProcess;
  descendant: number;
  parentTerm: string;
  childTerm: string;
  trigger: string;
  canary: string;
}

/** Actual Node processes in separate, explicitly owned POSIX groups. No CLI,
 * credential, provider mock, fake clock, or external filesystem target. */
describe.skipIf(process.platform === 'win32')('real POSIX process-group escalation', () => {
  it.each([
    { leaderMode: 'ignore', detached: false }, { leaderMode: 'exit', detached: false },
    { leaderMode: 'ignore', detached: true }, { leaderMode: 'exit', detached: true },
  ] as const)(
    'kills a TERM-ignoring descendant (launcher=$leaderMode, separate tool group=$detached) without killing a replacement',
    async ({ leaderMode, detached }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-real-kill-'));
      const fixtures: OwnedFixture[] = [];
      const childScript = path.join(directory, 'child.cjs');
      const parentScript = path.join(directory, 'launcher.cjs');
      fs.writeFileSync(childScript, `
const fs = require('node:fs');
const [ready, term, trigger, canary] = process.argv.slice(2);
process.on('SIGTERM', () => fs.appendFileSync(term, 'TERM ignored\\n'));
setInterval(() => {
  if (fs.existsSync(trigger) && !fs.existsSync(canary)) {
    // Publish one complete receipt. Repeated writeFileSync truncated the live
    // positive control every 10 ms, racing the parent's content assertion.
    fs.writeFileSync(canary + '.tmp', 'owned descendant executed');
    fs.renameSync(canary + '.tmp', canary);
  }
}, 10);
// Publish readiness atomically: existence must imply a complete PID.
fs.writeFileSync(ready + '.tmp', String(process.pid));
fs.renameSync(ready + '.tmp', ready);
`);
      fs.writeFileSync(parentScript, `
const fs = require('node:fs'), { spawn } = require('node:child_process');
const [childScript, ready, term, mode, detached, ...childArgs] = process.argv.slice(2);
process.on('SIGTERM', () => {
  fs.appendFileSync(term, mode === 'exit' ? 'TERM exit\\n' : 'TERM ignored\\n');
  if (mode === 'exit') process.exit(0);
});
spawn(process.execPath, [childScript, ...childArgs], { stdio: 'ignore', detached: detached === 'true' });
setInterval(() => {}, 1000);
// Publish readiness atomically: existence must imply a complete PID.
fs.writeFileSync(ready + '.tmp', String(process.pid));
fs.renameSync(ready + '.tmp', ready);
`);

      async function start(name: string, mode: 'ignore' | 'exit'): Promise<OwnedFixture> {
        const file = (suffix: string) => path.join(directory, name + '-' + suffix);
        const parentReady = file('parent-ready'), childReady = file('child-ready');
        const fixture: OwnedFixture = {
          proc: spawn(process.execPath, [parentScript, childScript, parentReady, file('parent-term'), mode, String(detached),
            childReady, file('child-term'), file('trigger'), file('canary')], {
            detached: true, stdio: 'ignore',
          }),
          descendant: 0, parentTerm: file('parent-term'), childTerm: file('child-term'),
          trigger: file('trigger'), canary: file('canary'),
        };
        fixtures.push(fixture); // Cleanup owns even an early/partially failed spawn.
        markOwnedProcessGroup(fixture.proc, detached);
        let spawnError: Error | undefined;
        fixture.proc.on('error', error => { spawnError = error; });
        await until(() => {
          if (spawnError) { throw spawnError; }
          return fs.existsSync(parentReady) && fs.existsSync(childReady);
        }, 'both real processes must install their TERM handlers');
        fixture.descendant = Number(fs.readFileSync(childReady, 'utf8'));
        expect(Number(fs.readFileSync(parentReady, 'utf8'))).toBe(fixture.proc.pid);
        expect(fixture.descendant).toBeGreaterThan(0);
        expect(processGroup(fixture.descendant)).toBe(detached ? fixture.descendant : fixture.proc.pid);
        expect(processGroup(fixture.proc.pid!)).toBe(fixture.proc.pid);
        return fixture;
      }

      try {
        const old = await start('cancelled', leaderMode);
        const graceMs = 1000, started = Date.now();
        let settled = false;
        const firstCleanup = killProcessTree(old.proc, graceMs, { label: 'PC07 real TERM-ignoring fixture' });
        if (detached) {
          expect(killProcessTree(old.proc, graceMs)).toBe(firstCleanup);
        }
        const cleanup = firstCleanup
          .then(() => { settled = true; });

        // Receipts prove SIGTERM was delivered and deliberately ignored by the
        // actual descendant; mere survival after an unobserved signal is weaker.
        await until(() => fs.existsSync(old.parentTerm) && fs.existsSync(old.childTerm), 'actual TERM receipts', graceMs);
        expect(fs.readFileSync(old.childTerm, 'utf8')).toBe('TERM ignored\n');
        expect(fs.readFileSync(old.parentTerm, 'utf8')).toBe(leaderMode === 'exit' ? 'TERM exit\n' : 'TERM ignored\n');
        expect(running(old.descendant)).toBe(true);
        expect(settled).toBe(false);
        if (leaderMode === 'exit') {
          await until(() => old.proc.exitCode === 0, 'launcher exits before descendant escalation', graceMs);
        } else {
          expect(running(old.proc.pid!)).toBe(true);
          expect(old.proc.signalCode).toBeNull();
        }

        // Start replacement work while the old group still awaits escalation.
        const replacement = await start('replacement', 'ignore');
        expect(replacement.proc.pid).not.toBe(old.proc.pid);
        expect(settled).toBe(false);

        await cleanup;
        const escalationMs = Date.now() - started;
        expect(escalationMs).toBeGreaterThanOrEqual(graceMs - 25);
        await until(() => !running(old.descendant)
          && (old.proc.exitCode !== null || old.proc.signalCode !== null), 'actual old group death');
        expect(old.proc.signalCode).toBe(leaderMode === 'ignore' ? 'SIGKILL' : null);
        expect(old.proc.exitCode).toBe(leaderMode === 'exit' ? 0 : null);

        // The helper permits a grace interval: prove no descendant write AFTER
        // escalation/settlement, without claiming immediate Stop immunity.
        fs.writeFileSync(old.trigger, 'attempt cancelled write after cleanup');
        fs.writeFileSync(replacement.trigger, 'replacement should remain functional');
        await until(() => fs.existsSync(replacement.canary), 'replacement canary positive control');
        await pause(150);
        expect(fs.existsSync(old.canary)).toBe(false);
        expect(fs.readFileSync(replacement.canary, 'utf8')).toBe('owned descendant executed');
        expect(running(replacement.proc.pid!)).toBe(true);
        expect(running(replacement.descendant)).toBe(true);
        expect(fs.existsSync(replacement.parentTerm)).toBe(false);
        expect(fs.existsSync(replacement.childTerm)).toBe(false);
        console.log('[PC07 real escalation]', JSON.stringify({ leaderMode, detached, graceMs, escalationMs,
          oldPid: old.proc.pid, oldChildPid: old.descendant, replacementPid: replacement.proc.pid,
          replacementChildPid: replacement.descendant, ignoredTerm: true,
          cancelledPostCleanupCanaryAbsent: true, replacementPositiveControl: true,
          scope: 'Actual disposable Node POSIX groups; no installed backend, Windows, immediate-Stop write guarantee or elapsed soak claim.' }));
      } finally {
        // Emergency cleanup is independent of the product helper under test.
        for (const fixture of fixtures) {
          if (detached && fixture.descendant && running(fixture.descendant)
            && processGroup(fixture.descendant) === fixture.descendant) {
            try { process.kill(-fixture.descendant, 'SIGKILL'); } catch { /* Owned detached tool already gone. */ }
          }
          if (fixture.proc.pid) {
            try { process.kill(-fixture.proc.pid, 'SIGKILL'); } catch { /* Owned group already gone. */ }
          }
        }
        await until(() => fixtures.every(fixture =>
          (!fixture.descendant || !running(fixture.descendant))
          && (fixture.proc.exitCode !== null || fixture.proc.signalCode !== null)), 'all fixture processes exit');
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }, 10_000,
  );
});
