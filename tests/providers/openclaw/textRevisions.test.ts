import { expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { ProviderManager } from '../../../src/managers/ProviderManager';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { StreamChunk, Settings } from '../../../src/types';

vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(), readOpenClawToken: () => undefined,
}));
const token = 'owned-text-snapshot-secret';
const wire = (socket: WebSocket, frame: unknown) => socket.send(JSON.stringify(frame));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, ms = 1200): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned deadline: ${label}`)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type Run = { id: string; runId: string; key: string; socket: WebSocket };
async function fixture(run: (f: {
  gateway: OpenClawGateway; connect(): Promise<boolean>; start(key: string): { chunks: StreamChunk[]; result: Promise<StreamChunk[]> };
  enhance(): Promise<string>;
  ack(key: string): Promise<Run>; event(r: Run, payload: object, event?: string, seq?: number): void; finish(r: Run, text?: string): void;
  requests: any[]; sockets: WebSocket[]; challenge(socket: WebSocket): void; url: string;
}) => Promise<void>, options: { holdChallenge?: boolean; sign?: () => Promise<any>; publicProvider?: boolean; appendOnlyManager?: boolean } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requests: any[] = [], sockets: WebSocket[] = [], clients: WebSocket[] = [], errors: string[] = [];
  const runs = new Map<string, Run>(), pending: Promise<unknown>[] = [], generators: AsyncGenerator<StreamChunk>[] = [];
  const challenge = (socket: WebSocket) => wire(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-text-snapshot-nonce' } });
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        if (frame.method === 'agent') {
          const key = frame.params.sessionKey, r = { key, id: frame.id, runId: `run-${frame.id}`, socket }; runs.set(key, r);
          wire(socket, { type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', runId: r.runId } });
        } else wire(socket, { type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } });
      } catch (error) { errors.push(String(error)); }
    });
    if (!options.holdChallenge) challenge(socket);
  });
  clearMockConfig(); setMockConfig('openclawUseGateway', true); setMockConfig('openclawGatewayUrl', url);
  const provider = options.publicProvider ? new TestableOpenClawProvider() : undefined;
  if (provider) {
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => content);
    vi.spyOn(provider, 'buildCliArgs').mockImplementation(() => { throw new Error('Unexpected CLI replay'); });
  }
  const gateway: OpenClawGateway = provider ? (provider as any)._gateway : new OpenClawGateway(url, token, options.sign);
  const manager = Object.create(ProviderManager.prototype) as any;
  manager._getActiveProvider = () => provider; manager._panelProviders = new Map();
  let serverClosed = false;
  try {
    expect((gateway as any)._url).toBe(url);
    await run({ gateway, requests, sockets, url, challenge,
      enhance: () => { const p = provider!.enhancePrompt('Original draft'); pending.push(p); return p; },
      connect: () => { const p = gateway.connect(); pending.push(p); const socket = (gateway as any)._ws; if (socket && !clients.includes(socket)) clients.push(socket); return p; },
      start: key => {
        const selected = options.appendOnlyManager ? manager : provider;
        const stream = selected ? selected.sendMessage('Owned public request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings, null, undefined, key)
          : gateway.sendAgentMessage('Owned request', { sessionKey: key });
        generators.push(stream); const chunks: StreamChunk[] = [];
        const result = (async () => { for await (const chunk of stream) chunks.push(chunk); return chunks; })(); pending.push(result); return { chunks, result };
      },
      ack: async key => {
        await vi.waitFor(() => expect([...runs.values()].some(r => (r.key === key || r.key.startsWith(`openclaw-gw-${key}-`)) && (gateway as any)._agentRuns.get(r.id)?.runId === r.runId)).toBe(true));
        return [...runs.values()].find(r => r.key === key || r.key.startsWith(`openclaw-gw-${key}-`))!;
      },
      event: (r, payload, event = 'agent', seq) => wire(r.socket, { type: 'event', event, payload: { runId: r.runId, sessionKey: r.key, ...payload }, ...(seq === undefined ? {} : { seq }) }),
      finish: (r, text = 'Final reply') => wire(r.socket, { type: 'res', id: r.id, ok: true, payload: { status: 'ok', runId: r.runId, result: { payloads: [{ text }] } } }),
    });
    expect(errors).toEqual([]);
  } finally {
    const currentSocket = (gateway as any)._ws;
    if (currentSocket && !clients.includes(currentSocket)) clients.push(currentSocket);
    provider?.dispose(); gateway.disconnect();
    // Observe the owned sockets even on baseline disconnect implementations
    // that remove every listener before closing an in-flight connection.
    for (const socket of clients) { socket.on('error', () => {}); if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); }));
    await Promise.allSettled(pending); for (const stream of generators) await stream.return(undefined as never);
    await vi.waitFor(() => expect([...clients, ...sockets].every(s => s.readyState === WebSocket.CLOSED)).toBe(true));
    if (process.env.PB07_TEXT_REVISION_RECEIPT) appendFileSync(process.env.PB07_TEXT_REVISION_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: [...clients, ...sockets].every(s => s.readyState === WebSocket.CLOSED), errors,
      pendingRequests: (gateway as any)._pendingRequests.size, agentRuns: (gateway as any)._agentRuns.size,
      methods: requests.map(r => r.method), nativeGatewayRequests: 0, nativeCliInvocations: 0, paidRequests: 0 }) + '\n');
    vi.restoreAllMocks(); clearMockConfig();
  }
}
const delta = (text: string, seq?: number) => ({ stream: 'assistant', data: { delta: text }, ...(seq === undefined ? {} : { seq }) });

function rendered(chunks: StreamChunk[], type = 'text') {
  return chunks.filter(c => c.type === type).reduce((text, chunk: any) => chunk.replace
    ? text.slice(0, chunk.replace.start) + (chunk.content || '') + text.slice(chunk.replace.end)
    : text + (chunk.content || ''), '');
}
const snapshot = (text: string, extra: object = {}) => ({ stream: 'assistant', data: { text, ...extra } });

it.each(['Corrected answer', '', '🙂 مصحح'])('applies a native replacement %j and continues streaming without aborting', async replacement => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, delta('Wrong answer')); f.event(r, snapshot(replacement, { replace: true, delta: '' }));
    f.event(r, delta('!')); f.finish(r);
    const chunks = await a.result;
    expect(rendered(chunks)).toBe(replacement + '!');
    expect(chunks.some(c => c.type === 'error')).toBe(false);
    expect(f.requests.some(x => x.method === 'chat.abort')).toBe(false);
    expect(chunks.find(c => (c as any).replace)).toMatchObject({ type: 'text', content: replacement, replace: { start: 0, end: 12 } });
  });
});

it('revises only the current message after tools and keeps thinking separate', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Earlier.')); f.event(r, { stream: 'tool', data: { phase: 'start', toolCallId: 'read', name: 'read' } });
    f.event(r, { stream: 'tool', data: { phase: 'result', toolCallId: 'read', result: 'Owned output' } });
    f.event(r, { stream: 'thinking', data: { text: 'Old reasoning' } }); f.event(r, snapshot('Wrong'));
    f.event(r, { stream: 'thinking', data: { text: 'Correct reasoning', replace: true } });
    f.event(r, snapshot('Right', { replace: true })); f.finish(r);
    const chunks = await a.result; expect(rendered(chunks)).toBe('Earlier.Right'); expect(rendered(chunks, 'thinking')).toBe('Correct reasoning');
    expect(chunks.filter(c => c.toolCall)).toHaveLength(2);
    expect(chunks.find(c => (c as any).replace && c.type === 'text')).toMatchObject({ replace: { start: 8, end: 13 } });
  });
});

it('replaces a provisional answer across tools and reconciles its terminal snapshot', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Draft', { delta: 'Draft', replaceable: true }));
    f.event(r, { stream: 'tool', data: { phase: 'start', toolCallId: 'read', name: 'read' } });
    f.event(r, { stream: 'tool', data: { phase: 'result', toolCallId: 'read', result: 'Owned result' } });
    f.event(r, snapshot('Revised draft', { delta: '', replace: true, replaceable: true }));
    f.event(r, snapshot('Final answer')); f.finish(r, 'Final answer');
    const chunks = await a.result; expect(rendered(chunks)).toBe('Final answer'); expect(chunks.some(c => c.type === 'error')).toBe(false);
    expect(chunks[0]).toMatchObject({ provisional: true }); expect(chunks.filter(c => c.toolCall)).toHaveLength(2);
  });
});

it('uses rendered UTF-16 offsets and replaces actual whitespace rather than trimmed snapshot lengths', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('🙂 draft', { delta: '  🙂 draft ' })); f.event(r, snapshot('🙂 done', { replace: true })); f.finish(r);
    const chunks = await a.result; expect(rendered(chunks)).toBe('🙂 done');
    expect(chunks.find(c => (c as any).replace)).toMatchObject({ replace: { start: 0, end: '  🙂 draft '.length } });
  });
});

it('isolates revisions between panels and emits a single public completion', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), b = f.start('B'), ar = await f.ack('A'), br = await f.ack('B');
    f.event(ar, snapshot('First')); f.event(br, snapshot('Other')); f.event(ar, snapshot('Corrected', { replace: true }));
    f.finish(ar); f.finish(br); const ac = await a.result, bc = await b.result;
    expect(rendered(ac)).toBe('Corrected'); expect(rendered(bc)).toBe('Other');
    expect(ac.filter(c => c.type === 'done')).toHaveLength(1); expect(bc.filter(c => c.type === 'done')).toHaveLength(1);
  }, { publicProvider: true });
});

it.each(['Final RPC answer', ''])('reconciles provisional text with the final RPC snapshot %j', async final => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Discarded draft', { delta: 'Discarded draft', replaceable: true })); f.finish(r, final);
    const chunks = await a.result; expect(rendered(chunks)).toBe(final); expect(chunks.some(c => c.type === 'error')).toBe(false);
  });
});

it('accounts for preceding legacy text when locating a native revision', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, { type: 'text', content: 'Legacy.' }); f.event(r, snapshot('Wrong')); f.event(r, snapshot('Right', { replace: true })); f.finish(r);
    expect(rendered(await a.result)).toBe('Legacy.Right');
  });
});

it.each([false, true])('enhancement consumes corrected snapshots and preserves the draft on invalid revision: %s', async invalid => {
  await fixture(async f => {
    await f.connect(); const pending = f.enhance();
    await vi.waitFor(() => expect(f.requests.some(x => x.method === 'agent')).toBe(true));
    const request = f.requests.find(x => x.method === 'agent'); expect(request.params.modelRun).toBe(true);
    const r = await f.ack(request.params.sessionKey);
    f.event(r, snapshot('Incorrect draft', { delta: 'Incorrect draft' }));
    f.event(r, invalid ? { stream: 'assistant', data: { replace: true } } : snapshot('Enhanced draft', { replace: true })); f.finish(r);
    expect(await pending).toBe(invalid ? 'Original draft' : 'Enhanced draft');
  }, { publicProvider: true });
});

it('routes actual gateway revisions through the append-only manager contract while tools stay live', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Discarded', { delta: 'Discarded', replaceable: true }));
    f.event(r, { stream: 'tool', data: { phase: 'start', toolCallId: 'read', name: 'read' } });
    await vi.waitFor(() => expect(a.chunks.some(c => c.type === 'tool_use')).toBe(true));
    expect(a.chunks.some(c => c.type === 'text')).toBe(false);
    f.event(r, snapshot('Correct answer', { replace: true })); f.finish(r);
    const chunks = await a.result;
    expect(chunks.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'Correct answer' }]);
    expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
  }, { publicProvider: true, appendOnlyManager: true });
});

it.each(['Earlier.', 'Hello'])('keeps the previous stable message %j when a new message begins without a tool', async first => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot(first, { delta: first })); f.event(r, snapshot('Hello', { delta: 'Hello' }));
    f.event(r, snapshot('Corrected', { replace: true })); f.finish(r);
    expect(rendered(await a.result)).toBe(first + 'Corrected');
  });
});

it('keeps a whitespace-only prefix in the current message revision range', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('  ', { delta: '  ' })); f.event(r, snapshot('Hello', { delta: 'Hello' }));
    f.event(r, snapshot('Corrected', { replace: true })); f.finish(r); expect(rendered(await a.result)).toBe('Corrected');
  });
});
