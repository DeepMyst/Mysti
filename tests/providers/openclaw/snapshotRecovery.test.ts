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
    if (process.env.PB07_SNAPSHOT_RECOVERY_RECEIPT) appendFileSync(process.env.PB07_SNAPSHOT_RECOVERY_RECEIPT, JSON.stringify({ serverClosed,
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

it.each(['assistant', 'thinking'])('recovers a missing first %s delta from its accompanying snapshot', async stream => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, { stream, seq: 3, data: { text: 'Hello world', delta: ' world' } }); f.finish(r);
    const chunks = await a.result;
    expect(rendered(chunks, stream === 'assistant' ? 'text' : 'thinking')).toBe('Hello world');
    expect(chunks.some(c => c.type === 'error')).toBe(false);
  });
});

it.each([
  ['plain', 'Hello', 'Hello', 'Hello world!', '! ', 'Hello world! '],
  ['raw whitespace', '  Hello ', 'Hello', 'Hello world!', '!', '  Hello world!'],
  ['unicode', '🙂 مرحبا', '🙂 مرحبا', '🙂 مرحبا بالعالم!', '!', '🙂 مرحبا بالعالم!'],
  ['snapshot only', '  Hello ', 'Hello', 'Hello world!', undefined, '  Hello world!'],
])('recovers a missing middle delta with %s formatting', async (_label, initial, initialSnapshot, next, delta, expected) => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot(initialSnapshot!, { delta: initial }));
    f.event(r, snapshot(next!, { delta })); f.finish(r);
    const chunks = await a.result; expect(rendered(chunks)).toBe(expected);
    expect(chunks.some(c => c.type === 'error')).toBe(false);
    expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(0);
  });
});

it('uses a recovered snapshot as the base for later deltas, repeated snapshots and revisions', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('🙂 Hello world', { delta: ' world' }));
    f.event(r, snapshot('🙂 Hello world!', { delta: '!' }));
    f.event(r, snapshot('🙂 Hello world!', { delta: '!' }));
    await vi.waitFor(() => expect(rendered(a.chunks)).toBe('🙂 Hello world!'));
    f.event(r, snapshot('Corrected', { replace: true })); f.finish(r);
    const chunks = await a.result; expect(rendered(chunks)).toBe('Corrected');
    expect(chunks.find(c => c.replace)).toMatchObject({ replace: { start: 0, end: '🙂 Hello world!'.length } });
  });
});

it('preserves earlier messages and tools when recovering the next segment', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Earlier.', { delta: 'Earlier.' }));
    f.event(r, { stream: 'tool', data: { phase: 'start', toolCallId: 'read', name: 'read' } });
    f.event(r, { stream: 'tool', data: { phase: 'result', toolCallId: 'read', result: 'Owned result' } });
    f.event(r, snapshot('Next complete', { delta: ' complete' }));
    f.event(r, snapshot('Next corrected', { replace: true })); f.finish(r);
    const chunks = await a.result; expect(rendered(chunks)).toBe('Earlier.Next corrected');
    expect(chunks.filter(c => c.toolCall)).toHaveLength(2);
    expect(chunks.find(c => c.replace)).toMatchObject({ replace: { start: 8, end: 21 } });
  });
});

it('recovers provisional snapshots across tool activity without retaining stale text', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Draft', { delta: 'Draft', replaceable: true }));
    f.event(r, { stream: 'tool', data: { phase: 'start', toolCallId: 'read', name: 'read' } });
    f.event(r, snapshot('Final complete', { delta: ' complete', replaceable: true }));
    await vi.waitFor(() => expect(rendered(a.chunks)).toBe('Final complete'));
    f.finish(r, 'Final complete');
    const chunks = await a.result; expect(rendered(chunks)).toBe('Final complete');
    expect(chunks.some(c => c.type === 'error')).toBe(false);
  });
});

it('reports ambiguous stable message loss without erasing previous text or affecting another request', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), b = f.start('B'), r = await f.ack('A'), br = await f.ack('B');
    f.event(r, snapshot('Earlier stable.', { delta: 'Earlier stable.' }));
    f.event(r, snapshot('Different message complete', { delta: ' complete' }));
    const chunks = await bounded(a.result, 'ambiguous snapshot settles');
    expect(rendered(chunks)).toBe('Earlier stable.'); expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
    expect(chunks.at(-1)?.content).toMatch(/incomplete/i);
    await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(1));
    expect(f.requests.find(r => r.method === 'chat.abort').params).toEqual({ sessionKey: r.key, runId: r.runId });
    f.event(br, snapshot('Other recovered', { delta: ' recovered' })); f.finish(br);
    expect(rendered(await b.result)).toBe('Other recovered');
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2);
  });
});

it.each([false, true])('recovers text through the public provider with append-only manager=%s', async appendOnlyManager => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Complete answer', { delta: ' answer' })); f.finish(r, 'Complete answer');
    const chunks = await a.result; expect(rendered(chunks)).toBe('Complete answer');
    expect(chunks.filter(c => c.type === 'done')).toHaveLength(1); expect(chunks.filter(c => c.type === 'error')).toHaveLength(0);
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(1);
  }, { publicProvider: true, appendOnlyManager });
});

it('keeps full-message deltas separate and preserves coalesced whitespace', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Earlier.', { delta: 'Earlier.' }));
    f.event(r, snapshot('Hello', { delta: '  Hello ' }));
    f.event(r, snapshot('Hello world!', { delta: 'world!\n' })); f.finish(r);
    const chunks = await a.result; expect(rendered(chunks)).toBe('Earlier.  Hello world!\n');
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(0);
  });
});

it('deduplicates exact native event IDs while keeping request and thinking state separate', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), b = f.start('B'), r = await f.ack('A'), br = await f.ack('B');
    f.event(r, { ...snapshot('One recovered', { delta: ' recovered' }), seq: 3 });
    f.event(r, { ...snapshot('One recovered', { delta: ' recovered' }), seq: 3 });
    f.event(r, { stream: 'thinking', seq: 3, data: { text: 'Thought recovered', delta: ' recovered' } });
    f.event(br, { ...snapshot('Two recovered', { delta: ' recovered' }), seq: 3 }); f.finish(r); f.finish(br);
    const chunks = await a.result; expect(rendered(chunks)).toBe('One recovered');
    expect(rendered(chunks, 'thinking')).toBe('Thought recovered'); expect(rendered(await b.result)).toBe('Two recovered');
  });
});

it('still rejects a connection sequence gap even if a later snapshot could fill the text', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Hello', { delta: 'Hello' }), 'agent', 1);
    f.event(r, snapshot('Hello world', { delta: ' world' }), 'agent', 3);
    const chunks = await bounded(a.result, 'connection gap settles');
    expect(rendered(chunks)).toBe('Hello'); expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
    expect(chunks.at(-1)?.content).toMatch(/incomplete/i);
  });
});

it('does not replay a request or guess an aggregate final payload after targeted text loss', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Recovered snapshot', { delta: ' snapshot' }));
    f.finish(r, 'Different aggregate payload with no message identity');
    expect(rendered(await a.result)).toBe('Recovered snapshot');
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(1);
  });
});

it.each(['!', undefined])('reconciles legacy raw delta margins with a later snapshot and delta %j', async suffix => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, delta('  Hello '));
    f.event(r, snapshot('Hello world!', { delta: suffix })); f.finish(r);
    const chunks = await a.result; expect(rendered(chunks)).toBe('  Hello world!');
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(0);
  });
});
