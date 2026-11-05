import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({
  expectedPath: '', handles: [] as ChildProcess[], closed: new Set<ChildProcess>(),
}));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    // Only the two owned fixture invocations are admitted; delegate unchanged.
    if (args[0] !== capture.expectedPath) throw new Error('Unexpected fixture executable');
    const proc = actual.spawn(...args);
    capture.handles.push(proc);
    // Capture close before returning the handle, including early failure paths.
    proc.once('close', () => capture.closed.add(proc));
    return proc;
  } };
});
import { probeCliVersion } from '../../src/utils/platform';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Diagnostic-only integration: existing group-kill coverage is reused. */
describe.skipIf(process.platform === 'win32')('real parent probe diagnostics', () => {
  it('retains success and default-deadline closure outside the killed fixture', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-probe-diagnostics-'));
    const executable = path.join(directory, 'owned-version');
    capture.expectedPath = executable; capture.handles.length = 0; capture.closed.clear();
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
if (JSON.stringify(process.argv.slice(2)) !== '["--version"]') throw Error('Unexpected argv');
fs.writeFileSync(process.env.READY, String(process.pid), {flag:'wx'});
(async () => {
  try {
    await new Promise(resolve => setTimeout(resolve, process.env.CASE === 'deadline' ? 15000 : 20));
    await new Promise(resolve => process.stdout.write('1.2.3\\n', resolve));
  } finally {
    fs.writeFileSync(process.env.TERMINAL, 'fixture finally', {flag:'wx'});
  }
})().catch(() => { process.exitCode = 1; });
`, { mode: 0o700 });
    const records: Array<Record<string, unknown>> = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      if (args[0] === '[Mysti CLI probe]') records.push(JSON.parse(String(args[1])));
    });
    const closed = capture.closed;
    const emergencies: number[] = [];
    try {
      for (const mode of ['success', 'deadline'] as const) {
        const ready = path.join(directory, mode + '-ready');
        const terminal = path.join(directory, mode + '-terminal');
        const firstRecord = records.length;
        const pending = probeCliVersion(executable, undefined, {
          PATH: path.dirname(process.execPath), CASE: mode, READY: ready, TERMINAL: terminal,
        });
        const proc = capture.handles.at(-1)!;
        const output = await pending;
        await until(() => closed.has(proc) && records.some(row => row.event === 'close' && row.childPid === proc.pid), 'captured close and parent record');
        const events = records.slice(firstRecord);
        const settled = events.filter(row => row.event === 'settled');
        expect(settled).toHaveLength(1);
        expect(Number(fs.readFileSync(ready, 'utf8'))).toBe(proc.pid);
        expect(events.find(row => row.event === 'start')).toMatchObject({ timeoutMs: 5000 });
        expect(events.find(row => row.event === 'spawn')).toMatchObject({ childPid: proc.pid, detached: true });
        expect(new Set(events.map(row => row.probeId)).size).toBe(1);
        if (mode === 'success') {
          expect(output).toBe('1.2.3');
          expect(fs.readFileSync(terminal, 'utf8')).toBe('fixture finally');
          expect(settled[0]).toMatchObject({ reason: 'close-zero', resultKind: 'output' });
          expect(events.some(row => row.event === 'cleanup-requested')).toBe(false);
          expect(events.find(row => row.event === 'exit')).toMatchObject({ code: 0, signal: null });
          expect(events.find(row => row.event === 'close')).toMatchObject({ code: 0, signal: null });
        } else {
          expect(output).toBeUndefined();
          expect(fs.existsSync(terminal)).toBe(false);
          expect(settled[0]).toMatchObject({ reason: 'deadline', resultKind: 'undefined' });
          expect(Number(settled[0].elapsedMs)).toBeGreaterThanOrEqual(4900);
          expect(events.find(row => row.event === 'cleanup-requested')).toMatchObject({ initialSignal: 'SIGKILL', graceMs: 0, useProcessGroup: true });
          expect(events.find(row => row.event === 'exit')).toMatchObject({ code: null, signal: 'SIGKILL' });
          expect(events.find(row => row.event === 'close')).toMatchObject({ code: null, signal: 'SIGKILL' });
          await until(() => records.some(row => row.probeId === settled[0].probeId && row.event === 'cleanup-helper-settled'), 'helper settlement record');
        }
      }
      expect(capture.handles).toHaveLength(2);
      expect(closed.size).toBe(2);
      expect(new Set(records.filter(row => row.event === 'start').map(row => row.probeId)).size).toBe(2);
      expect(emergencies).toEqual([]);
    } finally {
      // Independent bounded cleanup owns only captured live fixture handles.
      for (const proc of capture.handles) {
        if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
          emergencies.push(proc.pid);
          try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* Already gone. */ }
        }
      }
      // Exit alone can precede stdio closure. Preserve the fixture and observer
      // until every captured handle closes, even when an earlier assertion fails.
      await until(() => capture.handles.every(proc => closed.has(proc)), 'all owned fixtures closed');
      log.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
