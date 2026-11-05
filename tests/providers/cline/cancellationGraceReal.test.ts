import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../../src/constants';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableClineProvider, TestableGeminiProvider } from '../../helpers/providerFactory';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 2500): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) { return false; }
    await pause(10);
  }
  return true;
}
const settings: Settings = { provider: 'cline', model: '', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };

// The installed CLI's global first signal requests abort; its second signal
// exits immediately, independently of the runAgent listener. This owned Node
// fixture models that contract without loading a CLI, account or network client.
// A delayed terminal record must still reach the real stdout pipe; its write
// callback records acknowledgment independently of suppressed public chunks.
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-grace-'));
  const script = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path');
const [directory, mode, name] = process.argv.slice(2);
const file = suffix => path.join(directory, name + '-' + suffix);
let signals = 0;
process.stdout.on('error', error => { if (error.code !== 'EPIPE') throw error; });
const text = value => process.stdout.write(JSON.stringify({ type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: value } }) + '\\n');
process.on('SIGTERM', () => {
  signals++;
  fs.appendFileSync(file('signals'), JSON.stringify({ signal: 'SIGTERM', at: Date.now() }) + '\\n');
  if (mode !== 'hung' && signals > 1) {
    fs.writeFileSync(file('forced'), 'second signal forced exit');
    process.exit(31);
  }
  if (signals === 1) {
    text('Late text while abort is pending');
    if (mode !== 'hung') setTimeout(() => {
      const terminal = { type: 'run_result', finishReason: 'aborted', at: Date.now() };
      if (mode === 'ask') { fs.writeFileSync(file('ack'), JSON.stringify(terminal)); process.exit(0); }
      process.stdout.write(JSON.stringify(terminal) + '\\n', error => {
        fs.writeFileSync(file(error ? 'pipe-error' : 'ack'), JSON.stringify(error ? { code: error.code } : terminal));
        process.exit(error ? 32 : 0);
      });
    }, 250);
  }
});
setInterval(() => { if (fs.existsSync(file('finish'))) process.exit(0); }, 10);
fs.writeFileSync(file('ready'), String(process.pid));
text('Ready ' + name);
if (mode === 'ask') process.stdout.end(JSON.stringify({ type: 'ask', ask: 'followup', text: JSON.stringify({ question: 'Fixture question' }) }) + '\\n');
`);
  const file = (name: string, suffix: string) => path.join(directory, `${name}-${suffix}`);
  // A concurrent append can be visible before its newline; poll that tail again.
  const signals = (name: string) => fs.existsSync(file(name, 'signals'))
    ? fs.readFileSync(file(name, 'signals'), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)) : [];
  const completeSignalLogs = () => fs.readdirSync(directory).filter(name => name.endsWith('-signals'))
    .every(name => fs.readFileSync(path.join(directory, name), 'utf8').endsWith('\n'));
  return { directory, script, file, signals, completeSignalLogs };
}

describe.skipIf(process.platform === 'win32')('Cline real cancellation grace', () => {
  it('positive control exits before acknowledgment after a second TERM', async () => {
    const f = fixture();
    const child = spawn(process.execPath, [f.script, f.directory, 'normal', 'control'], { stdio: 'ignore' });
    let closed = false;
    child.on('close', () => { closed = true; });
    try {
      expect(await until(() => fs.existsSync(f.file('control', 'ready')))).toBe(true);
      child.kill('SIGTERM');
      expect(await until(() => f.signals('control').length === 1)).toBe(true);
      child.kill('SIGTERM');
      expect(await until(() => closed)).toBe(true);
      expect(child.exitCode).toBe(31);
      expect(f.signals('control')).toHaveLength(2);
      expect(fs.existsSync(f.file('control', 'ack'))).toBe(false);
      expect(fs.existsSync(f.file('control', 'forced'))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      expect(await until(() => closed)).toBe(true);
      const completeSignalLogs = f.completeSignalLogs();
      fs.rmSync(f.directory, { recursive: true, force: true });
      expect(completeSignalLogs, 'closed signal logs have no incomplete record').toBe(true);
    }
  });

  it.each(['stop', 'dispose', 'replace', 'abandon', 'hung', 'ask', 'ask-stop'] as const)(
    'preserves owned cleanup after %s', async action => {
      const f = fixture();
      const provider = new TestableClineProvider();
      const originalFolders = vscode.workspace.workspaceFolders;
      (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = [
        { uri: vscode.Uri.file(f.directory), name: 'owned cancellation fixture', index: 0 },
      ];
      const children: ChildProcess[] = [];
      const closed = new Set<ChildProcess>();
      const turns: Array<Promise<void>> = [];
      const chunks: StreamChunk[] = [];
      const tracker = {
        registerProcess: (_panel: string, child: ChildProcess) => {
          children.push(child); child.on('close', () => { closed.add(child); });
        },
        clearProcess: () => {},
      };
      const asking = action === 'ask' || action === 'ask-stop';
      vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
      vi.spyOn(provider, 'buildCliArgs').mockImplementation(() => [f.script, f.directory, action === 'hung' ? 'hung' : asking ? 'ask' : 'normal']);
      vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (name: string) => name);
      // Exercise the adapter's existing ask boundary while the actual child is
      // still alive. Only the boundary wait is substituted, never signaling.
      if (asking) { vi.spyOn(provider as any, 'waitForProcess').mockResolvedValue(0); }
      const begin = (name: string, abandon = false) => {
        const turn = (async () => {
          for await (const chunk of provider.sendMessage(name, [], settings, null, undefined, 'panel', tracker)) {
            if (name === 'first') { chunks.push(chunk); }
            if (abandon && chunk.type === 'text') { break; }
            if (asking && chunk.type === 'done') {
              expect(await until(() => f.signals('first').length === 1)).toBe(true);
              if (action === 'ask-stop') { provider.cancelCurrentRequest('panel'); }
            }
          }
        })();
        turns.push(turn); void turn.catch(() => {}); return turn;
      };
      try {
        const first = begin('first', action === 'abandon');
        expect(await until(() => chunks.some(chunk => chunk.type === 'text' && chunk.content === 'Ready first')), JSON.stringify({ chunks, children: children.map(child => ({ pid: child.pid, exit: child.exitCode, signal: child.signalCode })) })).toBe(true);
        const started = Date.now();
        let replacement: Promise<void> | undefined;
        if (action === 'stop' || action === 'hung') { provider.cancelCurrentRequest('panel'); }
        else if (action === 'dispose') { provider.dispose(); }
        else if (action === 'replace') { replacement = begin('second'); }
        expect(await until(() => closed.has(children[0]), PROCESS_KILL_GRACE_PERIOD_MS + 2000)).toBe(true);
        await first;
        const elapsed = Date.now() - started;
        const evidence = {
          action, signals: f.signals('first'), exitCode: children[0].exitCode,
          signalCode: children[0].signalCode, elapsedMs: elapsed,
          acknowledgment: fs.existsSync(f.file('first', 'ack')) ? JSON.parse(fs.readFileSync(f.file('first', 'ack'), 'utf8')) : null,
          forced: fs.existsSync(f.file('first', 'forced')),
          pipeError: fs.existsSync(f.file('first', 'pipe-error')) ? fs.readFileSync(f.file('first', 'pipe-error'), 'utf8') : null,
        };
        console.log('[Cline cancellation grace]', JSON.stringify(evidence));
        expect.soft(evidence.signals).toHaveLength(1);
        expect.soft(evidence.forced).toBe(false);
        expect.soft(evidence.pipeError).toBeNull();
        if (action === 'hung') {
          expect.soft(evidence.acknowledgment).toBeNull();
          expect.soft(evidence.signalCode).toBe('SIGKILL');
          expect.soft(elapsed).toBeGreaterThanOrEqual(PROCESS_KILL_GRACE_PERIOD_MS - 50);
        } else {
          expect.soft(evidence.acknowledgment?.finishReason).toBe('aborted');
          expect.soft(evidence.exitCode).toBe(0);
          expect.soft(evidence.signalCode).toBeNull();
        }
        expect.soft(chunks.some(chunk => chunk.type === 'error')).toBe(false);
        expect.soft(chunks.some(chunk => chunk.type === 'done')).toBe(asking);
        if (asking) { expect(chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(true); }
        expect.soft(chunks.some(chunk => chunk.content === 'Late text while abort is pending')).toBe(false);
        if (replacement) {
          expect(children).toHaveLength(2);
          expect(closed.has(children[1])).toBe(false);
          expect(f.signals('second')).toHaveLength(0);
          fs.writeFileSync(f.file('second', 'finish'), 'finish normally');
          await replacement;
          expect(await until(() => closed.has(children[1]))).toBe(true);
          expect(children[1].exitCode).toBe(0);
        }
      } finally {
        provider.dispose();
        for (const child of children) {
          // Only unreaped direct fixture handles are eligible; never signal a
          // cached PID or inherited process group during emergency cleanup.
          if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
        }
        expect(await until(() => children.every(child => closed.has(child)))).toBe(true);
        await Promise.allSettled(turns);
        const completeSignalLogs = f.completeSignalLogs();
        (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = originalFolders;
        vi.restoreAllMocks();
        fs.rmSync(f.directory, { recursive: true, force: true });
        expect(completeSignalLogs, 'closed signal logs have no incomplete record').toBe(true);
      }
    }, 12_000,
  );
});

describe('shared stdout abandonment contract', () => {
  it.each([false, true])('keeps drain opt-in scoped (drain=%s) and handles late stream errors', async drain => {
    const provider = drain ? new TestableClineProvider() : new TestableGeminiProvider();
    const internal = provider as any;
    const session = internal._getSession('stream-control');
    const stdout = new PassThrough();
    session.process = { stdout, exitCode: null, signalCode: null };
    const reader: AsyncGenerator<StreamChunk> = drain
      ? internal.processStream({ output: '' }, session, true)
      : internal.processStream({ output: '' }, session);
    try {
      const record = drain
        ? { type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: 'first' } }
        : { type: 'message', role: 'assistant', content: 'first' };
      stdout.write(JSON.stringify(record) + '\n');
      expect(await reader.next()).toMatchObject({ value: { type: 'text', content: 'first' }, done: false });
      await reader.return(undefined);
      expect(stdout.destroyed).toBe(!drain);
      if (drain) {
        expect(await until(() => stdout.readableFlowing === true)).toBe(true);
        // A discarded stream remains error-safe after its iterator returned.
        expect(() => stdout.emit('error', new Error('late owned stream error'))).not.toThrow();
        stdout.write('discarded terminal bytes\n');
      }
    } finally {
      stdout.destroy();
      session.process = null;
      provider.dispose();
    }
  });
});
