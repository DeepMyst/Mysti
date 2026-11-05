import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableClineProvider } from '../../helpers/providerFactory';

// Bound the bad baseline's missed-close wait. All other constants, including
// the production process-kill grace, remain unchanged. No fake timers.
vi.mock('../../../src/constants', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/constants')>(),
  PROCESS_TIMEOUT_MS: 750,
}));

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await pause(10);
  }
  return true;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture deadline: ${label}`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

const partial = 'Useful owned partial reply \u{1F501}';
const recovered = 'Fresh owned request completed.';
const panelId = 'owned-crash-panel';
const settings: Settings = {
  provider: 'cline', model: '', mode: 'quick-plan', accessLevel: 'read-only',
  thinkingLevel: 'none', contextMode: 'manual',
};
type EndReceipt = { code: number | null; signal: NodeJS.Signals | null; at: number };
type OwnedChild = {
  child: ChildProcess; name: string; registeredAt: number;
  exit?: EndReceipt; close?: EndReceipt; cleared: number;
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-crash-'));
  const script = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path');
const [directory, mode, name] = process.argv.slice(2);
const file = suffix => path.join(directory, name + '-' + suffix);
process.on('SIGTERM', () => {
  fs.appendFileSync(file('received-signals'), JSON.stringify({ signal: 'SIGTERM', at: Date.now() }) + '\\n');
  process.exit(41);
});
fs.writeFileSync(file('ready'), JSON.stringify({ pid: process.pid, ppid: process.ppid, mode, name }));
if (mode !== 'success') setInterval(() => {}, 1000);
const text = mode === 'success' ? ${JSON.stringify(recovered)} : ${JSON.stringify(partial)};
process.stdout.write(JSON.stringify({ type: 'agent_event', event: { type: 'content_start', contentType: 'text', text } }) + '\\n', () => {
  if (mode === 'stdout-eof-before-signal') {
    process.stdout.end(() => fs.writeFileSync(file('stdout-ended'), String(Date.now())));
  } else if (mode === 'success') {
    process.stdout.end(() => process.exit(0));
  }
});
`);
  const rules = Buffer.from('User-owned rules\r\nKeep these bytes.  \n');
  fs.writeFileSync(path.join(directory, '.clinerules'), rules);
  const file = (name: string, suffix: string) => path.join(directory, `${name}-${suffix}`);
  return { directory, script, rules, file };
}

// Real public Cline sends, spawn, pipes, parser, signals and cleanup. Only the
// executable/arguments/prompt point to a disposable Node fixture. A following
// success is also real and uses the same provider and panel without a reset.
describe.skipIf(process.platform === 'win32')('single-shot signal crash recovery', () => {
  it.each(['stdout-eof-before-signal', 'close-before-consumer-resumes'] as const)(
    'reports a signal failure and recovers after %s', async mode => {
      const f = fixture();
      const provider = new TestableClineProvider();
      const originalFolders = vscode.workspace.workspaceFolders;
      const resume = gate();
      const children: OwnedChild[] = [];
      const tracked = new Map<string, ChildProcess>();
      const turns: Promise<void>[] = [];
      const firstChunks: StreamChunk[] = [], nextChunks: StreamChunk[] = [];
      const signalAttempts: Array<{
        name: string; pid: number | undefined; signal: 'SIGKILL';
        phase: 'declared-fault' | 'finally-reap'; at: number;
        sent?: boolean; error?: string;
      }> = [];
      let currentName = 'first', pausedAfterPartial = false;
      let settledTurns = false, allReaped = false;
      let faultAt: number | undefined, resumedAt: number | undefined, settledAt: number | undefined;
      let waitCallsBeforeFault: number | undefined, waitCallsBeforeResume: number | undefined;
      const signal = (owned: OwnedChild, phase: 'declared-fault' | 'finally-reap') => {
        const attempt: (typeof signalAttempts)[number] = {
          name: owned.name, pid: owned.child.pid, signal: 'SIGKILL', phase, at: Date.now(),
        };
        signalAttempts.push(attempt);
        try { attempt.sent = owned.child.kill('SIGKILL'); }
        catch (error) { attempt.error = error instanceof Error ? error.message : String(error); }
        return attempt.sent === true;
      };
      const tracker = {
        registerProcess: (panel: string, child: ChildProcess) => {
          const owned: OwnedChild = { child, name: currentName, registeredAt: Date.now(), cleared: 0 };
          children.push(owned); tracked.set(panel, child);
          child.on('exit', (code, exitSignal) => { owned.exit = { code, signal: exitSignal, at: Date.now() }; });
          child.on('close', (code, closeSignal) => { owned.close = { code, signal: closeSignal, at: Date.now() }; });
        },
        clearProcess: (panel: string, child: ChildProcess) => {
          const owned = children.find(entry => entry.child === child);
          if (owned) owned.cleared++;
          if (tracked.get(panel) === child) tracked.delete(panel);
        },
      };
      const begin = (name: string, chunks: StreamChunk[], hold = false) => {
        currentName = name;
        const turn = (async () => {
          for await (const chunk of provider.sendMessage(name, [], settings, null, undefined, panelId, tracker)) {
            chunks.push(chunk);
            if (hold && chunk.type === 'text' && chunk.content === partial) {
              pausedAfterPartial = true;
              await resume.promise;
            }
          }
        })();
        turns.push(turn); void turn.catch(() => {}); return turn;
      };
      try {
        (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = [
          { uri: vscode.Uri.file(f.directory), name: 'owned crash fixture', index: 0 },
        ];
        vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
        const args = vi.spyOn(provider, 'buildCliArgs').mockReturnValue([f.script, f.directory, mode]);
        vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (name: string) => name);
        // Default spy calls through unchanged: neither wait result nor event is
        // substituted. The first scenario observes entry before the signal.
        const wait = vi.spyOn(provider as any, 'waitForProcess');
        const first = begin('first', firstChunks, mode === 'close-before-consumer-resumes');
        expect(await until(() => children.length === 1 && firstChunks.some(chunk => chunk.type === 'text' && chunk.content === partial))).toBe(true);
        const owned = children[0];
        expect(JSON.parse(fs.readFileSync(f.file('first', 'ready'), 'utf8'))).toEqual({
          pid: owned.child.pid, ppid: process.pid, mode, name: 'first',
        });
        if (mode === 'stdout-eof-before-signal') {
          expect(await until(() => wait.mock.calls.length === 1 && fs.existsSync(f.file('first', 'stdout-ended')))).toBe(true);
          expect(pausedAfterPartial).toBe(false);
        } else {
          expect(pausedAfterPartial).toBe(true);
          expect(wait).not.toHaveBeenCalled();
        }
        expect(owned.child.exitCode).toBeNull();
        expect(owned.child.signalCode).toBeNull();
        expect(owned.close).toBeUndefined();
        waitCallsBeforeFault = wait.mock.calls.length;
        faultAt = Date.now();
        expect(signal(owned, 'declared-fault')).toBe(true);
        expect(await until(() => owned.close !== undefined)).toBe(true);
        expect(owned.exit).toMatchObject({ code: null, signal: 'SIGKILL' });
        expect(owned.close).toMatchObject({ code: null, signal: 'SIGKILL' });
        if (mode === 'close-before-consumer-resumes') expect(wait).not.toHaveBeenCalled();
        waitCallsBeforeResume = wait.mock.calls.length;
        resumedAt = Date.now();
        resume.resolve();
        await bounded(first, 'first request must settle on the observed signal');
        settledAt = Date.now();
        const errors = firstChunks.filter(chunk => chunk.type === 'error');
        const diagnostic = errors.map(chunk => chunk.content || '').join('\n');
        // Soft assertions let both bad baselines still exercise and retain the
        // following successful request and exact process closure evidence.
        expect.soft(errors).toHaveLength(1);
        expect.soft(diagnostic).toMatch(/SIGKILL/);
        expect.soft(diagnostic).not.toMatch(/process timeout|no response received/i);
        expect.soft(firstChunks.filter(chunk => chunk.type === 'auth_error')).toHaveLength(0);
        expect.soft(firstChunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual([partial]);
        expect.soft(firstChunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
        expect.soft(firstChunks.findIndex(chunk => chunk.type === 'error'))
          .toBeLessThan(firstChunks.findIndex(chunk => chunk.type === 'done'));
        expect.soft(owned.cleared).toBe(1);
        expect.soft(tracked.has(panelId)).toBe(false);
        expect.soft(fs.existsSync(f.file('first', 'received-signals'))).toBe(false);

        args.mockReturnValue([f.script, f.directory, 'success']);
        await bounded(begin('recovered', nextChunks), 'same-provider/panel fresh request');
        expect(children).toHaveLength(2); // No automatic replay or replacement of the failed input.
        expect(await until(() => children[1].close !== undefined)).toBe(true);
        expect(children[1].child.pid).not.toBe(owned.child.pid);
        expect(children[1].exit).toMatchObject({ code: 0, signal: null });
        expect(children[1].close).toMatchObject({ code: 0, signal: null });
        expect(nextChunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual([recovered]);
        expect(nextChunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toHaveLength(0);
        expect(nextChunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
        expect(children[1].cleared).toBe(1);
        expect(tracked.has(panelId)).toBe(false);
        expect(fs.readFileSync(path.join(f.directory, '.clinerules'))).toEqual(f.rules);
        expect(signalAttempts).toEqual([expect.objectContaining({ name: 'first', signal: 'SIGKILL', phase: 'declared-fault', sent: true })]);
        console.log('[single-shot crash classification]', JSON.stringify({
          mode, faultAt, resumedAt, settledAt, diagnostic,
          firstTypes: firstChunks.map(chunk => chunk.type), nextTypes: nextChunks.map(chunk => chunk.type),
          scope: 'Owned Node fixture, real Cline send/parser/cleanup; no installed CLI or service verification.',
        }));
      } finally {
        // Never signal by process name, cached PID, or inherited group. A test
        // failure before release must not strand a paused iterator or child.
        resume.resolve();
        try {
          try { provider.dispose(); }
          finally {
            for (const owned of children) {
              if (owned.child.exitCode === null && owned.child.signalCode === null) signal(owned, 'finally-reap');
            }
            allReaped = await until(() => children.every(owned => owned.close !== undefined));
            await bounded(Promise.allSettled(turns), 'all owned request iterators settle');
            settledTurns = true;
          }
        } finally {
          (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = originalFolders;
          vi.restoreAllMocks();
          const receipt = {
            mode, allReaped, settledTurns, signalAttempts,
            faultAt, resumedAt, settledAt, waitCallsBeforeFault, waitCallsBeforeResume,
            firstChunks, nextChunks,
            children: children.map(({ child, ...receipt }) => ({ pid: child.pid, ...receipt })),
          };
          // Console output can be suppressed by the shared test setup. Retain
          // optional raw receipts before removing this owned fixture.
          const evidenceDirectory = process.env.MYSTI_CRASH_FIXTURE_EVIDENCE_DIR;
          if (evidenceDirectory) {
            fs.mkdirSync(evidenceDirectory, { recursive: true });
            fs.writeFileSync(path.join(evidenceDirectory, `${mode}.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
          }
          console.log('[single-shot crash closure]', JSON.stringify(receipt));
          if (allReaped && settledTurns) fs.rmSync(f.directory, { recursive: true, force: true });
        }
        expect(allReaped, 'all exact owned child handles have close receipts').toBe(true);
        expect(settledTurns, 'all public send iterators settled before fixture removal').toBe(true);
      }
    }, 12_000,
  );
});
