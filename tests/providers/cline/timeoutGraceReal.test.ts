import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../../src/constants';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableClineProvider, TestableClaudeProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';

// Only the two long request deadlines change. Signals, real process cleanup and
// its five-second grace remain production code; no native CLI is loaded.
vi.mock('../../../src/constants', async () => ({
  ...await vi.importActual<typeof import('../../../src/constants')>('../../../src/constants'),
  STREAM_INACTIVITY_TIMEOUT_MS: 1000,
  PROCESS_TIMEOUT_MS: 1000,
}));

type Route = 'inactivity' | 'eof';
type Action = 'ordinary' | 'stop' | 'replacement' | 'hung' | 'earlier-ask' | 'stop-before-timeout';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) { return false; }
    await pause(10);
  }
  return true;
}
const settings: Settings = { provider: 'cline', model: '', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };

function fixture(route: Route, action: Action | 'default' | 'default-stop-before-timeout') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-timeout-'));
  const script = path.join(directory, 'owned-child.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path');
const [directory, route, action, protocol, name] = process.argv.slice(2);
const file = suffix => path.join(directory, name + '-' + suffix);
const event = data => fs.appendFileSync(file('events.jsonl'), JSON.stringify({ at: Date.now(), ...data }) + '\\n');
let signals = 0;
process.stdout.on('error', error => { event({ event: 'stdout-error', code: error.code }); });
const text = value => process.stdout.write(JSON.stringify(protocol === 'claude'
  ? { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } }
  : { type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: value } }) + '\\n');
process.on('SIGTERM', () => {
  event({ event: 'signal', signal: 'SIGTERM', sequence: ++signals });
  if (action !== 'hung' && signals > 1) { event({ event: 'forced-exit' }); process.exit(31); }
  if (signals !== 1 || action === 'hung') return;
  if (action === 'default') { event({ event: 'ack', finishReason: 'aborted', transport: 'file' }); process.exit(0); }
  if (action === 'default-stop-before-timeout') {
    setTimeout(() => { event({ event: 'ack', finishReason: 'aborted', transport: 'file' }); process.exit(0); }, 850);
    return;
  }
  if (route === 'inactivity') {
    if (action === 'stop-before-timeout') setTimeout(() => text('Late text before timeout abort acknowledgment'), 500);
    else text('Late text before timeout abort acknowledgment');
  }
  setTimeout(() => {
    const terminal = { type: 'run_result', finishReason: 'aborted' };
    if (route === 'eof') { event({ event: 'ack', finishReason: 'aborted', transport: 'file-after-eof' }); process.exit(0); }
    process.stdout.write(JSON.stringify(terminal) + '\\n', error => {
      event(error ? { event: 'terminal-write-error', code: error.code } : { event: 'ack', finishReason: 'aborted', transport: 'stdout-write-callback' });
      process.exit(error ? 32 : 0);
    });
  }, action === 'stop-before-timeout' ? 850 : 350);
});
setInterval(() => {
  if (name === 'replacement') text('Replacement progress');
  if (fs.existsSync(file('finish'))) { event({ event: 'controlled-exit' }); process.exit(0); }
}, 50);
event({ event: 'ready', pid: process.pid });
text('Ready ' + name);
if (name !== 'replacement') {
  if (action === 'earlier-ask') process.stdout.write(JSON.stringify({ type: 'ask', ask: 'followup', text: JSON.stringify({ question: 'Owned timeout fixture question' }) }) + '\\n');
  if (route === 'eof') process.stdout.end();
}
`);
  const events = (name = 'first'): Array<Record<string, any>> => {
    // Ignore only the incomplete append tail; malformed complete records still fail.
    try { return fs.readFileSync(path.join(directory, `${name}-events.jsonl`), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
  };
  const finish = (name: string) => fs.writeFileSync(path.join(directory, `${name}-finish`), 'owned completion');
  const retain = (data: unknown) => {
    // Optional local evidence sink. CI needs no extra output; the fix's red and
    // green runs retain exact child timelines before removing temporary files.
    const evidenceRoot = process.env.MYSTI_TIMEOUT_FIXTURE_EVIDENCE_DIR;
    if (!evidenceRoot) { return; }
    const target = path.join(evidenceRoot, `${route}-${action}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'result.json'), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    fs.copyFileSync(script, path.join(target, 'owned-child.cjs'), fs.constants.COPYFILE_EXCL);
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('-events.jsonl'))) {
      fs.copyFileSync(path.join(directory, name), path.join(target, name), fs.constants.COPYFILE_EXCL);
    }
  };
  const completeEventLogs = () => fs.readdirSync(directory).filter(name => name.endsWith('-events.jsonl'))
    .every(name => fs.readFileSync(path.join(directory, name), 'utf8').endsWith('\n'));
  return { directory, script, route, action, events, finish, retain, completeEventLogs };
}

afterEach(() => { vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners(); });

describe.skipIf(process.platform === 'win32')('Cline real timeout cleanup grace', () => {
  const cases = (['inactivity', 'eof'] as const).flatMap(route =>
    (['ordinary', 'stop', 'replacement', 'hung', 'stop-before-timeout'] as const).map(action => ({ route, action: action as Action })))
    .concat([{ route: 'inactivity', action: 'earlier-ask' }]);

  it.each(cases)('$route timeout preserves cleanup through $action', async ({ route, action }) => {
    const f = fixture(route, action);
    const provider = new TestableClineProvider();
    const originalFolders = vscode.workspace.workspaceFolders;
    (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = [
      { uri: vscode.Uri.file(f.directory), name: 'owned timeout fixture', index: 0 },
    ];
    const children: ChildProcess[] = [];
    const closes = new Map<ChildProcess, { at: number; code: number | null; signal: NodeJS.Signals | null }>();
    const tracked = new Map<string, ChildProcess>();
    const turns: Promise<void>[] = [];
    const chunks: StreamChunk[] = [];
    const timeoutEvents: Array<{ at: number; message: string }> = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const message = String(args[0]);
      if (/No stdout\/stderr activity|Process timeout after/.test(message)) { timeoutEvents.push({ at: Date.now(), message }); }
    });
    let replacement: Promise<void> | undefined;
    let observed: Record<string, unknown> | undefined;
    const tracker = {
      registerProcess: (panel: string, child: ChildProcess) => {
        children.push(child); tracked.set(panel, child);
        child.on('close', (code, signal) => { closes.set(child, { at: Date.now(), code, signal }); });
      },
      clearProcess: (panel: string, child: ChildProcess) => { if (tracked.get(panel) === child) { tracked.delete(panel); } },
    };
    vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(provider, 'buildCliArgs').mockReturnValue([f.script, f.directory, route, action, 'cline']);
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (name: string) => name);
    const begin = (name: string) => {
      const turn = (async () => {
        for await (const chunk of provider.sendMessage(name, [], settings, null, undefined, 'panel', tracker)) {
          if (name !== 'first') { continue; }
          chunks.push(chunk);
          if (chunk.type === 'error') {
            // Ensure first TERM was received before another cleanup path can
            // run; standard-signal coalescing must not hide the red regression.
            expect(await until(() => f.events().some(event => event.event === 'signal'))).toBe(true);
            if (action === 'stop') { provider.cancelCurrentRequest('panel'); }
            if (action === 'replacement') { replacement = begin('replacement'); }
          }
        }
      })();
      turns.push(turn); void turn.catch(() => {}); return turn;
    };
    try {
      const first = begin('first');
      expect(await until(() => chunks.some(chunk => chunk.content === 'Ready first'))).toBe(true);
      if (action === 'stop-before-timeout') {
        await pause(650);
        provider.cancelCurrentRequest('panel');
      }
      expect(await until(() => closes.has(children[0]), PROCESS_KILL_GRACE_PERIOD_MS + 4000)).toBe(true);
      await first;
      const events = f.events();
      const signals = events.filter(event => event.event === 'signal');
      const acknowledgment = events.find(event => event.event === 'ack');
      const close = closes.get(children[0])!;
      observed = { route, action, pid: children[0].pid, close, signals, acknowledgment: acknowledgment || null, chunks, timeoutEvents };
      expect.soft(signals).toHaveLength(1);
      expect.soft(timeoutEvents).toHaveLength(1);
      expect.soft(events.some(event => event.event === 'forced-exit' || event.event === 'terminal-write-error')).toBe(false);
      expect.soft(chunks.filter(chunk => chunk.type === 'error')).toHaveLength(action === 'stop-before-timeout' ? 0 : 1);
      if (action !== 'stop-before-timeout') { expect.soft(chunks.find(chunk => chunk.type === 'error')?.content).toMatch(/timed out|Process timeout/i); }
      else { expect.soft(signals[0].at).toBeLessThan(timeoutEvents[0].at); }
      expect.soft(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(['stop', 'replacement', 'stop-before-timeout'].includes(action) ? 0 : 1);
      expect.soft(chunks.some(chunk => chunk.content === 'Late text before timeout abort acknowledgment')).toBe(false);
      if (action === 'earlier-ask') { expect(chunks.some(chunk => chunk.type === 'ask_user_question')).toBe(true); }
      if (action === 'hung') {
        expect.soft(acknowledgment).toBeUndefined();
        expect.soft(close.signal).toBe('SIGKILL');
        expect.soft(close.at - signals[0].at).toBeGreaterThanOrEqual(PROCESS_KILL_GRACE_PERIOD_MS - 100);
      } else {
        expect.soft(acknowledgment?.finishReason).toBe('aborted');
        expect.soft(acknowledgment?.transport).toBe(route === 'inactivity' ? 'stdout-write-callback' : 'file-after-eof');
        expect.soft(close.code).toBe(0);
        expect.soft(close.signal).toBeNull();
      }
      if (replacement) {
        expect(await until(() => f.events('replacement').some(event => event.event === 'ready'))).toBe(true);
        expect(children).toHaveLength(2);
        expect(closes.has(children[1])).toBe(false);
        expect(tracked.get('panel')).toBe(children[1]);
        expect(f.events('replacement').filter(event => event.event === 'signal')).toHaveLength(0);
        f.finish('replacement');
        await replacement;
        expect(await until(() => closes.has(children[1]))).toBe(true);
        expect(closes.get(children[1])?.code).toBe(0);
      }
    } finally {
      provider.dispose();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      }
      const allClosed = await until(() => children.every(child => closes.has(child)));
      await Promise.allSettled(turns);
      const completeEventLogs = f.completeEventLogs();
      f.retain({ observed, children: children.map(child => ({ pid: child.pid, close: closes.get(child) })), allClosed, completeEventLogs, chunks, timeoutEvents });
      (vscode.workspace as { workspaceFolders: typeof originalFolders }).workspaceFolders = originalFolders;
      fs.rmSync(f.directory, { recursive: true, force: true });
      expect(allClosed, 'all unreaped owned fixture handles closed').toBe(true);
      expect(completeEventLogs, 'closed event logs have no incomplete record').toBe(true);
    }
  }, 12_000);

  const defaultCases = (['inactivity', 'eof'] as const).flatMap(route =>
    (['default', 'default-stop-before-timeout'] as const).map(action => ({ route, action })));
  it.each(defaultCases)('keeps the default provider $route $action behavior', async ({ route, action }) => {
    const f = fixture(route, action);
    const provider = new TestableClaudeProvider();
    const internal = provider as any;
    const session = internal._getSession('default');
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [f.script, f.directory, route, action, 'claude', 'first'], { stdio: ['ignore', 'pipe', 'pipe'] });
    session.process = child;
    let close: { at: number; code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('close', (code, signal) => { close = { at: Date.now(), code, signal }; });
    let startupError: Error | undefined;
    child.on('error', caught => { startupError = caught; });
    const chunks: StreamChunk[] = [];
    const timeoutEvents: Array<{ at: number; message: string }> = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const message = String(args[0]);
      if (/No stdout\/stderr activity|Process timeout after/.test(message)) { timeoutEvents.push({ at: Date.now(), message }); }
    });
    let error: unknown;
    let turn: Promise<void> | undefined;
    let readyAt: number | undefined;
    let readyObservedAt: number | undefined;
    let streamStartedAt: number | undefined;
    try {
      // This control tests timeout cleanup after the child can handle signals.
      // Keep startup outside the shortened request clock without consuming stdout.
      expect(await until(() => close !== undefined || startupError !== undefined
        || f.events().some(event => event.event === 'ready')), 'owned child did not become ready within 3s').toBe(true);
      expect(startupError, 'owned child failed before its ready handshake').toBeUndefined();
      expect(close, 'owned child closed before its ready handshake').toBeUndefined();
      readyAt = f.events().find(event => event.event === 'ready')?.at;
      expect(readyAt).toBeDefined();
      readyObservedAt = Date.now();
      streamStartedAt = Date.now();
      turn = (async () => {
        try { for await (const chunk of internal.processStream({ output: '' }, session)) { chunks.push(chunk); } }
        catch (caught) { error = caught; }
      })();
      if (action === 'default-stop-before-timeout') {
        expect(await until(() => chunks.some(chunk => chunk.content === 'Ready first'))).toBe(true);
        await pause(650);
        provider.cancelCurrentRequest('default');
      }
      await turn;
      expect(await until(() => close !== undefined)).toBe(true);
      expect(session.process).toBe(action === 'default' ? child : null);
      const signals = f.events().filter(event => event.event === 'signal');
      expect(signals).toHaveLength(1);
      expect(timeoutEvents).toHaveLength(1);
      if (action === 'default-stop-before-timeout') { expect(signals[0].at).toBeLessThan(timeoutEvents[0].at); }
      expect(f.events().some(event => event.event === 'ack')).toBe(true);
      expect(close?.code).toBe(0);
      expect(chunks.some(chunk => chunk.type === 'text' && chunk.content === 'Ready first')).toBe(true);
      if (route === 'inactivity') {
        expect(error).toBeUndefined(); expect(chunks.some(chunk => chunk.type === 'error' && /timed out/i.test(chunk.content || ''))).toBe(true);
      } else { expect(String(error)).toContain('Process timeout'); }
    } finally {
      session.process = null; provider.dispose();
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      const allClosed = await until(() => close !== undefined);
      await turn;
      const completeEventLogs = f.completeEventLogs();
      f.retain({ route, action, defaultProvider: 'claude', spawnedAt, readyAt, readyObservedAt, streamStartedAt,
        startupError: startupError ? String(startupError) : null, close, chunks, timeoutEvents,
        error: error ? String(error) : null, allClosed, completeEventLogs });
      fs.rmSync(f.directory, { recursive: true, force: true });
      expect(allClosed).toBe(true);
      expect(completeEventLogs, 'closed event logs have no incomplete record').toBe(true);
    }
  }, 5000);
});
