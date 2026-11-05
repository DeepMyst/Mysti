// Public Continue sends over owned Node fixtures; never the installed cn CLI.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestableContinueProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

vi.mock('../../../src/utils/platform', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/platform')>(),
  getEnrichedEnv: () => ({ PATH: process.env.PATH || '' }),
}));

const settings: Settings = { provider: 'continue', model: 'default', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
type Behavior = 'reasoning' | 'empty' | 'complete' | 'mixed' | 'nonzero' | 'held';
type Terminal = { code: number | null; signal: string | null };
type Captured = { child: ChildProcess; closed: Promise<void>; registeredAt: number;
  exit?: Terminal; exitAt?: number; close?: Terminal; closeAt?: number };
type Turn = { next: () => Promise<IteratorResult<StreamChunk>>;
  return: () => Promise<IteratorResult<StreamChunk>>; collect: () => Promise<StreamChunk[]> };
const failureDiagnostic = 'Owned Continue fixture failed after reasoning.';
const source = String.raw`
const fs = require('node:fs');
const [receipt, behavior, ...args] = process.argv.slice(2);
const record = data => fs.appendFileSync(receipt, JSON.stringify({ at: Date.now(), pid: process.pid, ...data }) + '\n');
record({ event: 'invocation', behavior, args });
let prompt = '';
const deadline = setTimeout(() => { record({ event: 'fixture-deadline' }); process.exit(93); }, 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { prompt += part; });
process.stdin.on('end', () => {
  clearTimeout(deadline); record({ event: 'input', prompt });
  const output = ['reasoning', 'nonzero', 'held'].includes(behavior) ? '<think>Preserved reasoning.</think>\n'
    : behavior === 'mixed' ? '<think>Ordinary reasoning.</think>\nHealthy final answer.\n'
    : behavior === 'complete' ? 'Healthy final answer.\n' : '';
  record({ event: 'output', output });
  if (behavior === 'held') {
    // Keep the exact owned child live until public Stop or consumer return
    // initiates production cleanup. No delayed output or service is involved.
    setTimeout(() => { record({ event: 'fixture-deadline' }); process.exit(93); }, 5000);
    process.stdout.write(output);
    return;
  }
  if (behavior === 'nonzero') {
    const diagnostic = 'Owned Continue fixture failed after reasoning.';
    record({ event: 'stderr', diagnostic });
    process.stderr.write(diagnostic + '\n');
  }
  process.stdout.end(output, () => process.exit(behavior === 'nonzero' ? 7 : 0));
});
process.on('exit', code => record({ event: 'exit', code }));
`;

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), 7000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture(behaviors: Behavior[], run: (f: {
  send: (content: string) => Promise<StreamChunk[]>; begin: (content: string) => Turn;
  stop: () => void; children: Captured[]; events: () => any[];
  tracked: Map<string, ChildProcess>; waitClosed: () => Promise<void>;
}) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-continue-incomplete-'));
  const script = path.join(directory, 'continue.cjs'), receipt = path.join(directory, 'events.jsonl');
  fs.writeFileSync(script, source); clearMockConfig();
  const provider = new TestableContinueProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (...args: unknown[]) => String(args[0]));
  const originalArgs = provider.buildCliArgs.bind(provider);
  let invocation = 0;
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((config, session) => {
    const behavior = behaviors[invocation++];
    if (!behavior) throw new Error('Unexpected extra Continue fixture invocation');
    return [script, receipt, behavior, ...originalArgs(config, session)];
  });
  const children: Captured[] = [], streams: AsyncGenerator<StreamChunk>[] = [], pending: Promise<unknown>[] = [];
  const responses: StreamChunk[][] = [], cleanupSignals: number[] = [];
  const actions: Array<{ action: string; at: number }> = [];
  const tracked = new Map<string, ChildProcess>();
  const tracker = { registerProcess(panel: string, child: ChildProcess) {
    if (children.some(c => c.child === child)) return;
    const captured: Captured = { child, closed: Promise.resolve(), registeredAt: Date.now() };
    captured.closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
      captured.close = { code, signal }; captured.closeAt = Date.now(); resolve();
    }));
    child.once('exit', (code, signal) => { captured.exit = { code, signal }; captured.exitAt = Date.now(); });
    children.push(captured); tracked.set(panel, child);
  }, clearProcess(panel: string, child: ChildProcess) {
    if (tracked.get(panel) === child) tracked.delete(panel);
  } };
  const events = () => fs.existsSync(receipt)
    ? fs.readFileSync(receipt, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)) : [];
  let drained = false, closed = false;
  let completeReceipt = false;
  let cleanupError: unknown;
  const observe = <T>(operation: Promise<T>, label: string) => {
    // Keep the underlying operation, not only the bounded waiter, so finally
    // cannot remove the fixture while a late iterator is still running.
    pending.push(operation); void operation.catch(() => {});
    return bounded(operation, label);
  };
  const waitClosed = async () => {
    await bounded(Promise.all(children.map(c => c.closed)), 'owned Continue close missing');
  };
  const begin = (content: string): Turn => {
    const stream = provider.sendMessage(content, [], settings, null, undefined, 'owned-panel', tracker);
    const chunks: StreamChunk[] = []; streams.push(stream); responses.push(chunks);
    const remember = (result: IteratorResult<StreamChunk>) => {
      if (!result.done) chunks.push(result.value);
      return result;
    };
    const turn: Turn = {
      next: () => observe(stream.next().then(remember), 'owned Continue next did not settle'),
      return: () => {
        actions.push({ action: 'consumer-return', at: Date.now() });
        return observe(stream.return(undefined as never).then(remember), 'owned Continue return did not settle');
      },
      collect: () => observe((async () => {
        while (!(await turn.next()).done) { /* Retained by remember. */ }
        await waitClosed(); return chunks;
      })(), 'owned Continue turn did not settle'),
    };
    return turn;
  };
  try {
    await run({ children, events, tracked, waitClosed, begin,
      send: content => begin(content).collect(),
      stop: () => { actions.push({ action: 'public-stop', at: Date.now() }); provider.cancelCurrentRequest('owned-panel'); },
    });
  } finally {
    // Preserve reader settlement and every captured close even after a failed
    // assertion. A returned iterator owns production cleanup of its child.
    for (const captured of children) {
      if (!captured.child.stdin?.destroyed && !captured.child.stdin?.writableEnded) captured.child.stdin?.end();
    }
    for (const stream of streams) {
      const finish = (async () => {
        let result = await stream.return(undefined as never);
        // A defective finally-yield must not leave the child/reader suspended
        // after the test has already retained its failed return assertion.
        while (!result.done) result = await stream.return(undefined as never);
      })();
      pending.push(finish); void finish.catch(() => {});
    }
    try {
      await bounded(Promise.allSettled(pending), 'owned Continue readers did not settle'); drained = true;
      await bounded(Promise.all(children.map(c => c.closed)), 'owned Continue children did not close'); closed = true;
    } catch (error) {
      cleanupError = error;
      for (const captured of children) if (captured.child.exitCode === null && captured.child.signalCode === null) {
        cleanupSignals.push(captured.child.pid!); captured.child.kill('SIGKILL');
      }
      try {
        await bounded(Promise.all(children.map(c => c.closed)), 'owned Continue emergency close'); closed = true;
      } catch { /* Keep files if any captured child lacks close. */ }
    } finally {
      provider.dispose(); vi.restoreAllMocks(); clearMockConfig();
      completeReceipt = !fs.existsSync(receipt) || fs.readFileSync(receipt, 'utf8').endsWith('\n');
      const evidence = { test: expect.getState().currentTestName, behaviors, directory, drained, closed,
        cleanupSignals, cleanupError: cleanupError ? String(cleanupError) : null, actions, responses, events: events(),
        completeReceipt,
        children: children.map(c => ({ pid: c.child.pid, registeredAt: c.registeredAt,
          exit: c.exit, exitAt: c.exitAt, close: c.close, closeAt: c.closeAt })) };
      const sink = process.env.PB12_CONTINUE_INCOMPLETE_RECEIPT;
      if (sink) fs.appendFileSync(sink, JSON.stringify(evidence) + '\n');
      if (drained && closed && completeReceipt) fs.rmSync(directory, { recursive: true, force: true });
    }
    if (cleanupError) throw cleanupError;
    expect(invocation).toBe(behaviors.length);
    expect(children).toHaveLength(behaviors.length);
    expect(new Set(children.map(c => c.child.pid)).size).toBe(behaviors.length);
    expect(cleanupSignals).toEqual([]);
    expect(completeReceipt).toBe(true);
    expect(tracked.size).toBe(0);
    for (const [index, child] of children.entries()) {
      const expected = behaviors[index] === 'held' ? { code: null, signal: 'SIGTERM' }
        : { code: behaviors[index] === 'nonzero' ? 7 : 0, signal: null };
      expect(child.exit).toEqual(expected);
      expect(child.close).toEqual(child.exit);
    }
  }
}

function completed(chunks: StreamChunk[], hasError: boolean) {
  expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
  expect(chunks.at(-1)?.type).toBe('done');
  expect(chunks.filter(c => c.type === 'auth_error')).toEqual([]);
  const errors = chunks.filter(c => c.type === 'error');
  expect(errors).toHaveLength(hasError ? 1 : 0);
  if (hasError) {
    expect(errors[0].content).toMatch(/no (?:final|response)|incomplete/i);
    expect(chunks.indexOf(errors[0])).toBeLessThan(chunks.length - 1);
  }
}

function requests(events: any[], expected: string[], exitCodes: number[] = expected.map(() => 0)) {
  expect(events.filter(e => e.event === 'input').map(e => e.prompt)).toEqual(expected);
  expect(events.filter(e => e.event === 'invocation').map(e => e.args)).toEqual(expected.map(() => ['-p', '--readonly']));
  expect(events.filter(e => e.event === 'fixture-deadline')).toEqual([]);
  expect(events.filter(e => e.event === 'exit').map(e => e.code)).toEqual(exitCodes);
}

describe('Continue incomplete final answer', () => {
  it('preserves reasoning-only output but reports no final answer and recovers on the same panel', async () => {
    await fixture(['reasoning', 'complete'], async ({ send, events }) => {
      const first = await send('request-A');
      const recovery = await send('request-B');
      // Collect the explicit recovery even in the failing baseline, then check
      // that reasoning alone did not masquerade as a completed final answer.
      expect(first.filter(c => c.type === 'thinking').map(c => c.content)).toEqual(['Preserved reasoning.\n']);
      expect(first.filter(c => c.type === 'text')).toEqual([]);
      completed(first, true);
      completed(recovery, false);
      expect(recovery.filter(c => c.type === 'text').map(c => c.content)).toEqual(['Healthy final answer.\n']);
      expect(recovery.filter(c => c.type === 'thinking')).toEqual([]);
      requests(events(), ['request-A', 'request-B']);
    });
  }, 15000);

  it('retains the existing empty-stdout error on clean exit0', async () => {
    await fixture(['empty'], async ({ send, events }) => {
      const chunks = await send('request-empty');
      completed(chunks, true);
      expect(chunks.filter(c => c.type === 'text' || c.type === 'thinking')).toEqual([]);
      requests(events(), ['request-empty']);
    });
  }, 15000);

  it('accepts reasoning followed by ordinary final text on clean exit0 without fabricating an error', async () => {
    await fixture(['mixed'], async ({ send, events }) => {
      const chunks = await send('request-complete');
      completed(chunks, false);
      expect(chunks.filter(c => c.type === 'text').map(c => c.content)).toEqual(['Healthy final answer.\n']);
      expect(chunks.filter(c => c.type === 'thinking').map(c => c.content)).toEqual(['Ordinary reasoning.\n']);
      requests(events(), ['request-complete']);
    });
  }, 15000);

  it('preserves the existing nonzero failure once after reasoning without adding an incomplete-answer error', async () => {
    await fixture(['nonzero'], async ({ send, events }) => {
      const chunks = await send('request-nonzero');
      expect(chunks.map(c => c.type)).toEqual(['thinking', 'error', 'done']);
      expect(chunks[0].content).toBe('Preserved reasoning.\n');
      expect(chunks[1].content).toBe(failureDiagnostic);
      expect(chunks.filter(c => c.type === 'text' || c.type === 'auth_error')).toEqual([]);
      requests(events(), ['request-nonzero'], [7]);
      expect(events().filter(e => e.event === 'stderr').map(e => e.diagnostic)).toEqual([failureDiagnostic]);
    });
  }, 15000);

  // Exact SIGTERM terminal assertions are POSIX-specific. Windows uses taskkill.
  it.skipIf(process.platform === 'win32')('public Stop after reasoning closes the owned child without late error or done', async () => {
    await fixture(['held'], async ({ begin, stop, children, events, waitClosed, tracked }) => {
      const turn = begin('request-stop');
      expect(await turn.next()).toEqual({ done: false, value: { type: 'thinking', content: 'Preserved reasoning.\n' } });
      expect(children).toHaveLength(1);
      expect(children[0].child.exitCode).toBeNull(); expect(children[0].child.signalCode).toBeNull();
      expect(children[0].close).toBeUndefined();
      stop();
      const chunks = await turn.collect();
      expect(chunks).toEqual([{ type: 'thinking', content: 'Preserved reasoning.\n' }]);
      await waitClosed(); expect(tracked.size).toBe(0);
      requests(events(), ['request-stop'], []);
    });
  }, 15000);

  it.skipIf(process.platform === 'win32')('consumer return after reasoning closes the owned child without synthesizing another yielded chunk', async () => {
    await fixture(['held'], async ({ begin, children, events, waitClosed, tracked }) => {
      const turn = begin('request-return');
      expect(await turn.next()).toEqual({ done: false, value: { type: 'thinking', content: 'Preserved reasoning.\n' } });
      expect(children).toHaveLength(1);
      expect(children[0].child.exitCode).toBeNull(); expect(children[0].child.signalCode).toBeNull();
      expect(children[0].close).toBeUndefined();
      expect(await turn.return()).toEqual({ done: true, value: undefined });
      expect(await turn.next()).toEqual({ done: true, value: undefined });
      await waitClosed(); expect(tracked.size).toBe(0);
      requests(events(), ['request-return'], []);
    });
  }, 15000);
});
