// Public sends use an owned Node ACP fixture, never the installed Kimi CLI.
// Its callback-free file effect models a native allow that never asks the host.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestableKimiProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

vi.mock('../../../src/utils/platform', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/platform')>(),
  getEnrichedEnv: () => ({ PATH: process.env.PATH || '' }),
}));

const settings = (overrides: Partial<Settings> = {}): Settings => ({ provider: 'kimi-code', model: '',
  mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual', ...overrides });
const diagnostic = /Kimi Code ACP cannot enforce Plan, Read Only, or approval-based modes safely/;
const source = String.raw`
const fs = require('node:fs'), readline = require('node:readline');
const [receipt, effect, ...args] = process.argv.slice(2);
const record = data => fs.appendFileSync(receipt, JSON.stringify({ at: Date.now(), pid: process.pid, ...data }) + '\n');
const emit = packet => { record({ event: 'output', packet }); process.stdout.write(JSON.stringify(packet) + '\n'); };
const reply = (id, result) => emit({ jsonrpc: '2.0', id, result });
record({ event: 'invocation', args });
const input = readline.createInterface({ input: process.stdin });
const deadline = setTimeout(() => { record({ event: 'fixture-deadline' }); process.exit(93); }, 5000);
input.on('line', line => {
  const packet = JSON.parse(line); record({ event: 'input', packet });
  if (packet.method === 'initialize') reply(packet.id, { protocolVersion: 1 });
  else if (packet.method === 'session/new') reply(packet.id, { sessionId: 'owned-session' });
  else if (packet.method === 'session/prompt') {
    // Deliberately no session/request_permission: the child's native policy allowed it.
    fs.appendFileSync(effect, 'owned effect\n'); record({ event: 'owned-effect' });
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'owned-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Owned answer.' } } } });
    reply(packet.id, { stopReason: 'end_turn' });
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
async function fixture(run: (h: {
  provider: TestableKimiProvider; send: (options: Settings) => Promise<StreamChunk[]>;
  prompt: ReturnType<typeof vi.spyOn>; attachments: ReturnType<typeof vi.spyOn>;
  children: Captured[]; events: () => any[]; effect: string;
}) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-kimi-preflight-'));
  const script = path.join(directory, 'acp.cjs'), receipt = path.join(directory, 'events.jsonl');
  const effect = path.join(directory, 'owned-effect.txt');
  fs.writeFileSync(script, source); clearMockConfig();
  const provider = new TestableKimiProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('OWNED PROMPT');
  // Positive input; baseline must not write attachments into the shared mock workspace.
  const attachments = vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(null);
  const build = provider.buildPersistentCliArgs.bind(provider);
  vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((options, session) =>
    [script, receipt, effect, ...build(options, session)!]);
  const children: Captured[] = [], streams: AsyncGenerator<StreamChunk>[] = [], pending: Promise<unknown>[] = [];
  const sends: Array<Record<string, unknown>> = [], cleanupSignals: number[] = [];
  const tracker = { registerProcess(_panel: string, child: ChildProcess) {
    if (children.some(c => c.child === child)) return;
    const captured: Captured = { child, closed: Promise.resolve() };
    captured.closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
      captured.close = { code, signal }; resolve();
    }));
    child.once('exit', (code, signal) => { captured.exit = { code, signal }; });
    children.push(captured);
  }, clearProcess() {} };
  const events = () => fs.existsSync(receipt)
    ? fs.readFileSync(receipt, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  let drained = false, closed = false;
  try {
    await run({ provider, prompt, attachments, children, events, effect, send: async options => {
      const stream = provider.sendMessage('owned request', [], options, null, undefined, 'panel', tracker, undefined,
        [{ id: 'owned-file', type: 'file', fileName: 'owned.txt', mimeType: 'text/plain', base64Data: 'b3duZWQ=', size: 5 }]);
      streams.push(stream);
      const operation = (async () => {
        const chunks: StreamChunk[] = [], entry: Record<string, unknown> = { settings: { ...options }, chunks };
        sends.push(entry);
        try { for await (const chunk of stream) chunks.push(chunk); entry.settlement = 'returned'; return chunks; }
        catch (error) { entry.settlement = 'rejected'; entry.error = String(error); throw error; }
      })();
      pending.push(operation); return bounded(operation, 'owned ACP turn did not settle');
    } });
  } finally {
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
        await bounded(Promise.all(children.map(c => c.closed)), 'owned ACP emergency close'); closed = true;
      }
      provider.dispose();
      const evidence = { test: expect.getState().currentTestName, directory, sends, drained, closed, cleanupSignals,
        promptCalls: prompt.mock.calls.length, attachmentCalls: attachments.mock.calls.length, events: events(),
        effect: fs.existsSync(effect) ? fs.readFileSync(effect, 'utf8') : null,
        completeReceipt: !fs.existsSync(receipt) || fs.readFileSync(receipt, 'utf8').endsWith('\n'),
        children: children.map(c => ({ pid: c.child.pid, exit: c.exit, close: c.close })) };
      const sink = process.env.PB11_KIMI_PREFLIGHT_RECEIPT;
      if (sink) fs.appendFileSync(sink, JSON.stringify(evidence) + '\n');
      vi.restoreAllMocks(); clearMockConfig();
      if (drained && closed) fs.rmSync(directory, { recursive: true, force: true });
    }
    expect(cleanupSignals).toEqual([]);
    for (const captured of children) {
      expect(captured.exit).toEqual({ code: 0, signal: null }); expect(captured.close).toEqual(captured.exit);
    }
  }
}

function seedPrior(provider: TestableKimiProvider) {
  const prior = (provider as any)._getSession('panel');
  Object.assign(prior, { sessionId: 'prior-session', cancelled: true, autonomousMode: true,
    rpcId: 19, promptId: 19, acpSessionId: 'prior-session', pendingPrompt: 'prior draft',
    acpMode: 'edit-automatically', acpAccessLevel: 'full-access' });
  prior.activeToolCalls.set('prior-tool', { id: 'prior-tool', name: 'Read', input: {} });
  return prior;
}

function snapshot(prior: any) {
  return { ...prior, activeToolCalls: [...prior.activeToolCalls.entries()] };
}

function completed(chunks: StreamChunk[]) {
  expect(chunks.filter(c => c.type === 'text').map(c => c.content)).toEqual(['Owned answer.']);
  expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
  expect(chunks.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([]);
}

describe('Kimi ACP permission preflight', () => {
  it.each([
    { mode: 'quick-plan', accessLevel: 'full-access' },
    { mode: 'detailed-plan', accessLevel: 'full-access' },
    { mode: 'default', accessLevel: 'read-only' },
    { mode: 'ask-before-edit', accessLevel: 'full-access' },
    { mode: 'edit-automatically', accessLevel: 'ask-permission' },
  ] as const)('refuses $mode/$accessLevel before session, prompt, attachments or child work', async selection => {
    await fixture(async h => {
      const prior = seedPrior(h.provider), before = snapshot(prior), options = settings(selection), original = { ...options };
      const getSession = vi.spyOn(h.provider as any, '_getSession');
      await expect(h.send(options)).rejects.toThrow(diagnostic);
      expect(getSession).not.toHaveBeenCalled(); expect(snapshot(prior)).toEqual(before); expect(options).toEqual(original);
      expect(h.prompt).not.toHaveBeenCalled(); expect(h.attachments).not.toHaveBeenCalled();
      expect(h.provider.buildPersistentCliArgs).not.toHaveBeenCalled(); expect(h.children).toEqual([]);
      expect(h.events()).toEqual([]); expect(fs.existsSync(h.effect)).toBe(false);
      expect(h.provider.capabilities).toMatchObject({ supportsNativeApproval: true,
        supportsAskPermission: false, supportsReadOnly: false, planMode: 'none' });
    });
  }, 15000);

  it('keeps explicitly selected Full ACP dispatch and records its callback-free owned effect', async () => {
    await fixture(async h => {
      completed(await h.send(settings())); expect(h.children).toHaveLength(1);
      expect(h.events().find(e => e.event === 'invocation').args).toEqual(['acp']);
      const inputs = h.events().filter(e => e.event === 'input').map(e => e.packet);
      expect(inputs.map(p => p.method)).toEqual(['initialize', 'session/new', 'session/prompt']);
      expect(inputs.map(p => p.id)).toEqual([1, 2, 3]);
      expect(inputs[2].params.prompt[0].text).toBe('OWNED PROMPT');
      expect(h.events().some(e => e.packet?.method === 'session/request_permission')).toBe(false);
      expect(fs.readFileSync(h.effect, 'utf8')).toBe('owned effect\n');
    });
  }, 15000);

  it('preserves a rejected selection and prior panel until a separate explicit Full request', async () => {
    await fixture(async h => {
      const prior = seedPrior(h.provider), before = snapshot(prior);
      const restricted = settings({ mode: 'quick-plan', accessLevel: 'read-only' }), original = { ...restricted };
      await expect(h.send(restricted)).rejects.toThrow(diagnostic);
      expect(snapshot(prior)).toEqual(before); expect(restricted).toEqual(original);
      expect(h.children).toEqual([]); expect(h.events()).toEqual([]); expect(h.prompt).not.toHaveBeenCalled();
      completed(await h.send(settings())); expect(restricted).toEqual(original);
      expect(h.children).toHaveLength(1); expect(h.prompt).toHaveBeenCalledOnce();
      expect(h.events().filter(e => e.event === 'input' && e.packet.method === 'session/prompt')).toHaveLength(1);
      expect(fs.readFileSync(h.effect, 'utf8')).toBe('owned effect\n');
    });
  }, 15000);

  it('rejects a direct persistent builder before resetting the prior protocol snapshot', async () => {
    await fixture(async h => {
      const prior = seedPrior(h.provider), before = snapshot(prior);
      expect(() => h.provider.buildPersistentCliArgs(settings({ accessLevel: 'read-only' }), prior)).toThrow(diagnostic);
      expect(snapshot(prior)).toEqual(before); expect(h.children).toEqual([]); expect(h.events()).toEqual([]);
    });
  });

  it('treats unsupported eager warming as a no-op before obtaining or disposing an existing warm handle', async () => {
    await fixture(async h => {
      const prior = seedPrior(h.provider);
      // A sentinel handle makes this advisory-path test independent of child timing.
      const warm = { pid: -1 } as ChildProcess;
      prior.persistentProcess = warm; prior.persistentReady = true;
      const before = snapshot(prior), getSession = vi.spyOn(h.provider as any, '_getSession');
      const dispose = vi.spyOn(h.provider, 'disposePersistentProcess').mockImplementation(() => {});
      vi.spyOn(h.provider as any, '_isPersistentProcessHealthy').mockReturnValue(true);
      const spawn = vi.spyOn(h.provider as any, '_getOrSpawnPersistentProcess').mockResolvedValue(warm);
      try {
        await expect(h.provider.preSpawnPersistentProcess('panel', settings({ mode: 'quick-plan', accessLevel: 'read-only' }))).resolves.toBeUndefined();
        expect(getSession).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
        expect(snapshot(prior)).toEqual(before); expect(prior.persistentProcess).toBe(warm);
        expect(h.children).toEqual([]); expect(h.prompt).not.toHaveBeenCalled(); expect(h.attachments).not.toHaveBeenCalled();
      } finally { prior.persistentProcess = null; prior.persistentReady = false; }
    });
  });
});
