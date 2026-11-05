// Public Hermes sends over an owned Node ACP fixture, never the installed CLI.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestableHermesProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

vi.mock('../../../src/utils/platform', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/platform')>(),
  getEnrichedEnv: () => ({ PATH: process.env.PATH || '' }),
}));

const settings: Settings = { provider: 'hermes', model: '', mode: 'edit-automatically',
  accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };
const source = String.raw`
const fs = require('node:fs'), readline = require('node:readline');
const [receipt, mode] = process.argv.slice(2);
const record = data => fs.appendFileSync(receipt, JSON.stringify({ at: Date.now(), pid: process.pid, ...data }) + '\n');
const emit = packet => { record({ event: 'output', packet }); process.stdout.write(JSON.stringify(packet) + '\n'); };
const reply = (id, result) => emit({ jsonrpc: '2.0', id, result });
const fail = id => emit({ jsonrpc: '2.0', id, error: { code: -32000, message: 'owned ' + mode + ' failure' } });
const text = value => emit({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId: 'owned-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } }
} });
const input = readline.createInterface({ input: process.stdin });
const deadline = setTimeout(() => { record({ event: 'fixture-deadline' }); process.exit(93); }, 5000);
let previousPrompt;
record({ event: 'ready' });
input.on('line', line => {
  const packet = JSON.parse(line); record({ event: 'input', packet });
  if (packet.method === mode) { fail(packet.id); return; }
  if (packet.method === 'initialize') reply(packet.id, { protocolVersion: 1 });
  else if (packet.method === 'session/new') reply(packet.id, { sessionId: 'owned-session' });
  else if (packet.method === 'session/prompt') {
    if (previousPrompt !== undefined) {
      reply(previousPrompt, { stopReason: 'cancelled' }); fail(previousPrompt);
      reply(999, { stop_reason: 'end_turn' }); fail(999);
      reply(String(packet.id), { stopReason: 'end_turn' }); fail(String(packet.id));
    }
    text(previousPrompt === undefined ? 'First answer.' : 'Current answer.');
    reply(packet.id, { stopReason: 'end_turn' }); previousPrompt = packet.id;
  }
});
input.on('close', () => { clearTimeout(deadline); record({ event: 'stdin-closed' }); });
process.on('exit', code => record({ event: 'exit', code }));
`;

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), 7000);
  })]); } finally { clearTimeout(timer); }
}

type Captured = { child: ChildProcess; closed: Promise<void>; exit?: unknown; close?: unknown };
async function fixture(mode: string, run: (f: {
  send: (content: string) => Promise<StreamChunk[]>; children: Captured[];
  events: () => any[]; fallback: ReturnType<typeof vi.spyOn>;
}) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-hermes-correlation-'));
  const script = path.join(directory, 'acp.cjs'), receipt = path.join(directory, 'events.jsonl');
  fs.writeFileSync(script, source);
  clearMockConfig();
  const provider = new TestableHermesProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (...args: unknown[]) => String(args[0]));
  const originalArgs = provider.buildPersistentCliArgs.bind(provider);
  vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((s, session) => {
    originalArgs(s, session); return [script, receipt, mode];
  });
  const fallback = vi.spyOn(provider as any, '_sendSingleShot').mockImplementation(async function* () {
    yield { type: 'error', content: 'UNEXPECTED FALLBACK' };
  });
  const children: Captured[] = [], streams: AsyncGenerator<StreamChunk>[] = [], pending: Promise<unknown>[] = [];
  const replies: StreamChunk[][] = [], cleanupSignals: number[] = [];
  const tracker = {
    registerProcess: (_panel: string, child: ChildProcess) => {
      if (children.some(c => c.child === child)) return;
      const captured: Captured = { child, closed: Promise.resolve() };
      captured.closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
        captured.close = { code, signal }; resolve();
      }));
      child.once('exit', (code, signal) => { captured.exit = { code, signal }; });
      children.push(captured);
    }, clearProcess: () => {},
  };
  const events = () => fs.existsSync(receipt)
    ? fs.readFileSync(receipt, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)) : [];
  let drained = false, closed = false;
  try {
    await run({ children, events, fallback, send: async content => {
      const stream = provider.sendMessage(content, [], settings, null, undefined, 'owned', tracker);
      streams.push(stream);
      const operation = (async () => { const chunks: StreamChunk[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        replies.push(chunks); return chunks;
      })();
      pending.push(operation); return bounded(operation, 'owned ACP turn did not settle');
    } });
  } finally {
    // EOF is the fixture's ordinary shutdown. Track actual operations and every
    // captured close before deleting its files, including assertion failures.
    for (const captured of children) captured.child.stdin?.end();
    for (const stream of streams) pending.push(stream.return(undefined as never));
    try {
      await bounded(Promise.allSettled(pending), 'owned ACP readers did not settle'); drained = true;
      await bounded(Promise.all(children.map(c => c.closed)), 'owned ACP children did not close'); closed = true;
    } finally {
      if (!closed) {
        for (const captured of children) if (captured.child.exitCode === null && captured.child.signalCode === null) {
          cleanupSignals.push(captured.child.pid!); captured.child.kill('SIGKILL');
        }
        await bounded(Promise.all(children.map(c => c.closed)), 'owned ACP emergency close');
        closed = true;
      }
      provider.dispose(); vi.restoreAllMocks(); clearMockConfig();
      const evidence = { mode, directory, drained, closed, cleanupSignals, replies, fallbackCalls: fallback.mock.calls.length, events: events(), completeReceipt: !fs.existsSync(receipt) || fs.readFileSync(receipt, 'utf8').endsWith('\n'),
        children: children.map(c => ({ pid: c.child.pid, exit: c.exit, close: c.close })) };
      const sink = process.env.PB10_HERMES_CORRELATION_RECEIPT;
      if (sink) fs.appendFileSync(sink, JSON.stringify(evidence) + '\n');
      if (drained && closed) fs.rmSync(directory, { recursive: true, force: true });
    }
    expect(children).toHaveLength(1);
    expect(cleanupSignals).toEqual([]);
    for (const captured of children) {
      expect(captured.exit).toEqual({ code: 0, signal: null });
      expect(captured.close).toEqual(captured.exit);
    }
  }
}

describe('Hermes request correlation', () => {
  it('ignores stale and unknown terminal responses during a later public turn on the same child', async () => {
    await fixture('success', async ({ send, children, events, fallback }) => {
      const first = await send('FIRST');
      expect(first.filter(c => c.type === 'text').map(c => c.content)).toEqual(['First answer.']);
      expect(first.filter(c => c.type === 'done')).toHaveLength(1);
      const second = await send('SECOND');
      expect(second.filter(c => c.type === 'text').map(c => c.content)).toEqual(['Current answer.']);
      expect(second.filter(c => c.type === 'done')).toHaveLength(1);
      expect(second.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([]);
      expect(children).toHaveLength(1); expect(fallback).not.toHaveBeenCalled();
      const inputs = events().filter(e => e.event === 'input').map(e => e.packet);
      expect(inputs.map(e => e.method)).toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt']);
      expect(inputs.filter(e => e.method === 'session/prompt').map(e => e.params.prompt[0].text)).toEqual(['FIRST', 'SECOND']);
      expect(inputs.map(e => e.id)).toEqual([1, 2, 3, 4]);
    });
  }, 15000);

  it.each([
    ['initialize', 'error', ['initialize']],
    ['session/new', 'auth_error', ['initialize', 'session/new']],
    ['session/prompt', 'error', ['initialize', 'session/new', 'session/prompt']],
  ] as const)('preserves a correlated %s error without fallback or replay', async (mode, type, methods) => {
    await fixture(mode, async ({ send, events, fallback }) => {
      const chunks = await send('FAIL ONCE');
      expect(chunks.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([
        expect.objectContaining({ type, content: expect.stringContaining('owned ' + mode + ' failure') }),
      ]);
      expect(chunks.filter(c => c.type === 'text')).toEqual([]);
      expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
      expect(events().filter(e => e.event === 'input').map(e => e.packet.method)).toEqual(methods);
      expect(fallback).not.toHaveBeenCalled();
    });
  }, 15000);
});
