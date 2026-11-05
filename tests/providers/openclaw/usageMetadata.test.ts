import { expect, it, describe, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import * as vscode from 'vscode';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import { contextFillTokens, normalizeUsage } from '../../../src/services/TokenAccounting';
import { CompactionManager } from '../../../src/managers/CompactionManager';
import type { Settings, StreamChunk } from '../../../src/types';

vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(),
  readOpenClawToken: () => undefined, getEnrichedEnv: () => ({ PATH: process.env.PATH || '' }),
}));
const settings = { provider: 'openclaw', model: 'unused-picker-model', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings;
const totals = { input: 20000, output: 1000, cacheRead: 180000, cacheWrite: 50000 };
const latest = { input: 500, output: 60, cacheRead: 8000, cacheWrite: 1500 };
const metadata = () => ({ provider: 'openai-codex', model: 'owned-model', contextTokens: 128000,
  usage: totals, lastCallUsage: latest, promptTokens: 10000 });
type Plan = { meta?: Record<string, unknown>; streamed?: boolean; pretty?: boolean; delay?: number; failed?: boolean; empty?: boolean };
async function fixture(transport: 'cli' | 'gateway', run: (f: {
  send(plan: Plan, panel?: string): Promise<StreamChunk[]>; provider: TestableOpenClawProvider;
}) => Promise<void>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-usage-')));
  const previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  const plans: Record<string, Plan> = {}, children: Array<{ proc: ChildProcess; closed: Promise<void>; close?: unknown }> = [];
  const planFile = path.join(directory, 'plans.json'); let sequence = 0;
  const frames: any[] = [], sockets: WebSocket[] = [], errors: string[] = [];
  let server: WebSocketServer | undefined, serverClosed = transport === 'cli';
  let provider: TestableOpenClawProvider | undefined;
  const streams: AsyncGenerator<StreamChunk>[] = [], pending: Promise<unknown>[] = [];
  const wire = (socket: WebSocket, value: unknown) => socket.send(JSON.stringify(value));
  clearMockConfig(); setMockConfig('openclawUseGateway', transport === 'gateway');
  const result = (plan: Plan) => ({ payloads: plan.streamed || plan.empty ? [] : [{ text: plan.failed ? 'Owned model failure' : 'Owned reply', ...(plan.failed ? { isError: true } : {}) }],
    ...(plan.meta ? { meta: { agentMeta: plan.meta } } : {}) });
  try {
    let url: string | undefined;
    if (transport === 'gateway') {
      server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject); });
      url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      setMockConfig('openclawGatewayUrl', url);
      server.on('connection', socket => {
        sockets.push(socket);
        socket.on('message', data => {
          try {
            const frame = JSON.parse(data.toString()); frames.push(frame);
            if (frame.method === 'connect') { wire(socket, { type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } }); return; }
            const plan = plans[frame.params.message], runId = `owned-${frame.id}`;
            wire(socket, { type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', runId } });
            if (plan.streamed) wire(socket, { type: 'event', event: 'agent', payload: { runId, stream: 'assistant', data: { delta: 'Owned reply' } } });
            setTimeout(() => {
              if (socket.readyState === WebSocket.OPEN) wire(socket, { type: 'res', id: frame.id, ok: true,
                payload: { runId, status: 'ok', summary: 'completed', result: result(plan) } });
            }, plan.delay || 0);
          } catch (error) { errors.push(String(error)); }
        });
        wire(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-usage-challenge' } });
      });
    }
    provider = new TestableOpenClawProvider();
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => content);
    if (transport === 'gateway') {
      expect((provider as any)._gateway._url).toBe(url);
      const connecting = provider.initialize(); sockets.push((provider as any)._gateway._ws); await connecting;
      expect((provider as any)._gateway.isConnected()).toBe(true);
    } else {
      vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
      const originalArgs = provider.buildCliArgs.bind(provider);
      const script = `const fs=require('node:fs'),args=process.argv.slice(2),file=args[args.indexOf('--message-file')+1],message=fs.readFileSync(file,'utf8'),plan=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))[message];
if(plan.streamed)process.stdout.write(JSON.stringify({type:'text',content:'Owned reply'})+'\\n');
setTimeout(()=>process.stdout.write(JSON.stringify({payloads:plan.streamed||plan.empty?[]:[{text:plan.failed?'Owned model failure':'Owned reply',...(plan.failed?{isError:true}:{})}],...(plan.meta?{meta:{agentMeta:plan.meta}}:{})},null,plan.pretty?2:undefined)+'\\n'),plan.delay||0);`;
      vi.spyOn(provider, 'buildCliArgs').mockImplementation((s, session) => ['-e', script, '--', planFile, ...originalArgs(s, session)]);
    }
    const tracker = { registerProcess: (_panel: string, proc: ChildProcess) => {
      const row = { proc, close: undefined as unknown, closed: Promise.resolve() };
      row.closed = new Promise(resolve => proc.once('close', (code, signal) => { row.close = { code, signal }; resolve(); })); children.push(row);
    }, clearProcess() {} };
    await run({ provider, send: async (plan, panel = 'A') => {
      const message = `owned-${panel}-${++sequence}`; plans[message] = plan; fs.writeFileSync(planFile, JSON.stringify(plans));
      const stream = provider!.sendMessage(message, [], settings, null, undefined, panel, tracker); streams.push(stream);
      const promise = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; })(); pending.push(promise);
      return await promise;
    } });
    expect(errors).toEqual([]);
  } finally {
    provider?.dispose();
    for (const row of children) if (row.proc.exitCode === null && row.proc.signalCode === null) row.proc.kill('SIGKILL');
    await Promise.all(children.map(c => c.closed));
    for (const socket of server?.clients || []) socket.terminate();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => { serverClosed = true; if (error) reject(error); else resolve(); }));
    await vi.waitFor(() => expect(sockets.every(s => s.readyState === WebSocket.CLOSED)).toBe(true));
    await Promise.allSettled(pending); for (const stream of streams) await stream.return(undefined as never);
    const receipt = process.env.PB07_USAGE_METADATA_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ transport, serverClosed, allSocketsClosed: sockets.every(s => s.readyState === WebSocket.CLOSED),
      allChildrenClosed: children.every(c => c.close !== undefined), children: children.map(c => ({ pid: c.proc.pid, close: c.close })), methods: frames.map(f => f.method), errors, nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
    vi.restoreAllMocks(); clearMockConfig(); (vscode.workspace as any).workspaceFolders = previousFolders; fs.rmSync(directory, { recursive: true, force: true });
  }
}
function done(chunks: StreamChunk[]) { const rows = chunks.filter(c => c.type === 'done'); expect(rows).toHaveLength(1); return rows[0]; }

describe.each(['cli', 'gateway'] as const)('OpenClaw %s reported metadata', transport => {
  it('keeps disjoint run totals separate from latest context and reports the native model/window', async () => {
    await fixture(transport, async f => {
      const chunks = await f.send({ meta: metadata() }), final = done(chunks);
      expect(chunks).toContainEqual({ type: 'text', content: 'Owned reply' });
      expect(final.usage).toMatchObject({ input_tokens: 20000, output_tokens: 1000, cache_read_input_tokens: 180000, cache_creation_input_tokens: 50000, normalized: true });
      expect(final.contextUsage).toMatchObject({ input_tokens: 500, output_tokens: 60, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1500 });
      expect(contextFillTokens(final.contextUsage)).toBe(10000); expect(final.contextWindow).toBe(128000);
      expect(chunks.some(c => c.reportedModel === 'openai-codex/owned-model')).toBe(true);
      expect(normalizeUsage(final.usage!, 'openai')).toEqual(final.usage);
      expect(f.provider.capabilities.emitsUsage).toBe(true);
      const compaction = new CompactionManager({ globalState: { get: vi.fn(), update: vi.fn() } } as never);
      expect(compaction.recordUsage('owned', final.contextUsage!, final.contextWindow!, final.usage)).toBe(false);
      expect(compaction.getUsage('owned')).toMatchObject({ totalInputTokens: 20000, totalCacheReadTokens: 180000, totalCacheCreationTokens: 50000 });
    });
  });
  it('retains final metadata after streamed text without repeating the reply', async () => {
    await fixture(transport, async f => {
      const chunks = await f.send({ meta: metadata(), streamed: true });
      expect(chunks.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'Owned reply' }]);
      expect(done(chunks).contextWindow).toBe(128000); expect(done(chunks).usage?.cache_read_input_tokens).toBe(180000);
    });
  });
  it('keeps aggregate-only context explicitly unknown', async () => {
    await fixture(transport, async f => {
      const final = done(await f.send({ meta: { usage: totals } }));
      expect(final.usage?.output_tokens).toBe(1000); expect(final.contextUsage).toBeNull();
    });
  });
  it('accepts an explicit context measurement without inventing run totals', async () => {
    await fixture(transport, async f => {
      const final = done(await f.send({ meta: { promptTokens: 12345, contextTokens: 128000 } }));
      expect(final.usage).toBeUndefined(); expect(contextFillTokens(final.contextUsage)).toBe(12345);
    });
  });
  it('preserves cache-only calls whose zero uncached bucket was omitted by OpenClaw', async () => {
    await fixture(transport, async f => {
      const final = done(await f.send({ meta: { usage: { cacheRead: 9000, output: 50 }, lastCallUsage: { cacheRead: 9000, output: 50 } } }));
      expect(final.usage).toMatchObject({ input_tokens: 0, output_tokens: 50, cache_read_input_tokens: 9000 });
      expect(contextFillTokens(final.contextUsage)).toBe(9000);
    });
  });
  it('does not use malformed latest-call fields or totals as a context fallback', async () => {
    await fixture(transport, async f => {
      const final = done(await f.send({ meta: { usage: totals, lastCallUsage: { input: -1, output: 5, cacheRead: 9000 } } }));
      expect(final.usage?.output_tokens).toBe(1000); expect(final.contextUsage).toBeNull();
    });
  });
  it('rejects malformed numbers and model metadata instead of claiming measurements', async () => {
    await fixture(transport, async f => {
      const chunks = await f.send({ meta: { usage: { input: '100', output: 10 }, lastCallUsage: { input: null, cacheRead: 100 }, contextTokens: 1.5, model: 'bad model\nname', provider: 'openai', promptTokens: '200' } });
      expect(done(chunks)).toMatchObject({ contextUsage: null }); expect(done(chunks).usage).toBeUndefined();
      expect(done(chunks).contextWindow).toBeUndefined(); expect(chunks.some(c => c.reportedModel)).toBe(false);
    });
  });
  it('clears measurements and attribution between turns and consumes stored totals once', async () => {
    await fixture(transport, async f => {
      await f.send({ meta: metadata() }); expect(f.provider.getStoredUsage('A')).toBeNull();
      const next = await f.send({}); expect(done(next).usage).toBeUndefined(); expect(done(next).contextWindow).toBeUndefined();
      expect(done(next).contextUsage).toBeNull(); expect(next.some(c => c.reportedModel)).toBe(false);
    });
  });
  it('keeps simultaneous panels separate even when final responses finish out of order', async () => {
    await fixture(transport, async f => {
      const [a, b] = await Promise.all([
        f.send({ meta: { ...metadata(), model: 'model-A', promptTokens: 7000 }, delay: 40 }, 'A'),
        f.send({ meta: { ...metadata(), model: 'model-B', promptTokens: 3000 }, delay: 1 }, 'B'),
      ]);
      expect(contextFillTokens(done(a).contextUsage)).toBe(7000); expect(contextFillTokens(done(b).contextUsage)).toBe(3000);
      expect(a.some(c => c.reportedModel === 'openai-codex/model-A')).toBe(true); expect(b.some(c => c.reportedModel === 'openai-codex/model-B')).toBe(true);
    });
  });
  it('uses the explicit prompt measurement when it differs from last-call usage', async () => {
    await fixture(transport, async f => {
      const final = done(await f.send({ meta: { ...metadata(), promptTokens: 4500 } }));
      expect(contextFillTokens(final.contextUsage)).toBe(4500); expect(final.contextUsage?.cache_read_input_tokens).toBeUndefined();
      expect(final.usage?.cache_read_input_tokens).toBe(180000);
    });
  });
  it('attributes a failed native result before reporting the failure', async () => {
    await fixture(transport, async f => {
      const chunks = await f.send({ meta: metadata(), failed: true });
      const errorIndex = chunks.findIndex(c => c.type === 'error' || c.type === 'auth_error');
      expect(errorIndex).toBeGreaterThan(-1); expect(chunks.slice(0, errorIndex).some(c => c.reportedModel === 'openai-codex/owned-model')).toBe(true);
      expect(chunks.some(c => c.type === 'text' && c.content === 'Owned model failure')).toBe(false);
    });
  });
  it('leaves zero, total-only and output-only context measurements unknown', async () => {
    await fixture(transport, async f => {
      for (const usage of [{ input: 0, output: 0 }, { total: 99999 }, { output: 60 }]) {
        const final = done(await f.send({ meta: { usage, lastCallUsage: usage } }));
        expect(final.contextUsage).toBeNull();
        if ('output' in usage && usage.output) expect(final.usage?.output_tokens).toBe(60);
        else expect(final.usage).toBeUndefined();
      }
    });
  });
  it('preserves already-qualified native model names', async () => {
    await fixture(transport, async f => {
      const chunks = await f.send({ meta: { provider: 'openrouter', model: 'openrouter/anthropic/owned-model' } });
      expect(done(chunks).reportedModel).toBe('openrouter/anthropic/owned-model');
    });
  });
});

it('handles pretty-printed native CLI metadata and reply payloads', async () => {
  await fixture('cli', async f => {
    const chunks = await f.send({ meta: metadata(), pretty: true });
    expect(chunks).toContainEqual({ type: 'text', content: 'Owned reply' });
    expect(done(chunks).usage?.cache_creation_input_tokens).toBe(50000); expect(contextFillTokens(done(chunks).contextUsage)).toBe(10000);
  });
});

it('does not count metadata alone as a successful CLI reply', async () => {
  await fixture('cli', async f => {
    const chunks = await f.send({ meta: metadata(), empty: true });
    expect(chunks.some(c => c.type === 'error' && c.content?.includes('No response received'))).toBe(true);
    expect(done(chunks).contextWindow).toBe(128000);
  });
});
