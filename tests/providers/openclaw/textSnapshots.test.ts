import { expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import { applyStreamText } from '../../../src/utils/streamText';
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
  ack(key: string): Promise<Run>; event(r: Run, payload: object, event?: string, seq?: number): void; finish(r: Run, text?: string): void;
  requests: any[]; sockets: WebSocket[]; challenge(socket: WebSocket): void; url: string;
}) => Promise<void>, options: { holdChallenge?: boolean; sign?: () => Promise<any>; publicProvider?: boolean } = {}) {
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
  let serverClosed = false;
  try {
    expect((gateway as any)._url).toBe(url);
    await run({ gateway, requests, sockets, url, challenge,
      connect: () => { const p = gateway.connect(); pending.push(p); const socket = (gateway as any)._ws; if (socket && !clients.includes(socket)) clients.push(socket); return p; },
      start: key => {
        const stream = provider ? provider.sendMessage('Owned public request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings, null, undefined, key)
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
    if (process.env.PB07_TEXT_SNAPSHOT_RECEIPT) appendFileSync(process.env.PB07_TEXT_SNAPSHOT_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: [...clients, ...sockets].every(s => s.readyState === WebSocket.CLOSED), errors,
      pendingRequests: (gateway as any)._pendingRequests.size, agentRuns: (gateway as any)._agentRuns.size,
      methods: requests.map(r => r.method), nativeGatewayRequests: 0, nativeCliInvocations: 0, paidRequests: 0 }) + '\n');
    vi.restoreAllMocks(); clearMockConfig();
  }
}
const delta = (text: string, seq?: number) => ({ stream: 'assistant', data: { delta: text }, ...(seq === undefined ? {} : { seq }) });

const snapshot = (text: string, extra: object = {}) => ({ stream: 'assistant', data: { text, ...extra } });
const text = (chunks: StreamChunk[], type = 'text') => chunks.filter(c => c.type === type).reduce((value, chunk) => applyStreamText(value, chunk), '');

it('delivers a native text-only snapshot once, even with a repeated snapshot and final payload', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Complete reply')); f.event(r, snapshot('Complete reply')); f.finish(r, 'Complete reply');
    const chunks = await a.result; expect(text(chunks)).toBe('Complete reply');
    expect(chunks.filter(c => c.type === 'text')).toHaveLength(1);
  });
});

it('delivers snapshot-only text before the final RPC response arrives', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Visible now'));
    await vi.waitFor(() => expect(text(a.chunks)).toBe('Visible now'));
    f.finish(r, 'Visible now'); await a.result;
  });
});

it('appends only the missing snapshot suffix after deltas', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, delta('Hello')); f.event(r, snapshot('Hello world')); f.event(r, snapshot('Hello world!')); f.finish(r);
    expect(text(await a.result)).toBe('Hello world!');
  });
});

it('keeps thinking and assistant snapshot state independent', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, { stream: 'thinking', data: { text: 'Consider' } }); f.event(r, snapshot('Answer'));
    f.event(r, { stream: 'thinking', data: { text: 'Consider carefully' } }); f.event(r, snapshot('Answer here')); f.finish(r);
    const chunks = await a.result; expect(text(chunks)).toBe('Answer here'); expect(text(chunks, 'thinking')).toBe('Consider carefully');
  });
});

it('starts fresh native text segments at tool boundaries without removing prior text or tools', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Before.')); f.event(r, { stream: 'thinking', data: { text: 'First thought.' } });
    f.event(r, { stream: 'tool', data: { phase: 'start', toolCallId: 'owned-tool', name: 'read', args: { path: 'owned.txt' } } });
    f.event(r, { stream: 'tool', data: { phase: 'result', toolCallId: 'owned-tool', result: 'Owned tool output' } });
    f.event(r, { stream: 'thinking', data: { text: 'Second thought.' } }); f.event(r, snapshot('After.')); f.finish(r);
    const chunks = await a.result;
    expect(chunks.map(c => c.type)).toEqual(['text', 'thinking', 'tool_use', 'tool_result', 'thinking', 'text']);
    expect(text(chunks)).toBe('Before.After.'); expect(text(chunks, 'thinking')).toBe('First thought.Second thought.');
  });
});

it('accepts a first replacement and append-compatible replacements without repeating text', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Start', { replace: true, delta: '' }));
    f.event(r, snapshot('Start here', { replace: true, delta: 'Start here' }));
    f.event(r, snapshot('Start here', { replace: true })); f.finish(r);
    expect(text(await a.result)).toBe('Start here');
  });
});

it.each([
  ['missing replacement text', { delta: 'Untrusted suffix', replace: true }],
] as const)('reports %s as incomplete instead of presenting stale text as final', async (_label, data) => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), b = f.start('B'), r = await f.ack('A'), br = await f.ack('B');
    f.event(r, delta('Original partial')); f.event(r, { stream: 'assistant', data }); f.finish(r, 'Late obsolete final');
    const chunks = await bounded(a.result, 'revision settles');
    expect(text(chunks)).toBe('Original partial'); expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
    expect(chunks.at(-1)?.content).toMatch(/revis|replac/i); expect(chunks.at(-1)?.content).toMatch(/incomplete/i);
    await vi.waitFor(() => expect(f.requests.filter(x => x.method === 'chat.abort')).toHaveLength(1));
    expect(f.requests.find(x => x.method === 'chat.abort').params).toEqual({ sessionKey: r.key, runId: r.runId });
    f.event(br, snapshot('Other reply')); f.finish(br); expect(text(await b.result)).toBe('Other reply');
  });
});

it('ignores foreign snapshots and chat mirrors while isolating requests and repeated session keys', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), b = f.start('B'), r = await f.ack('A'), br = await f.ack('B');
    f.event(r, { ...snapshot('Foreign'), runId: 'foreign' });
    f.event(r, snapshot('First')); f.event(br, snapshot('Other'));
    f.event(r, { state: 'delta', deltaText: 'First', message: { role: 'assistant', content: [{ type: 'text', text: 'First' }] } }, 'chat');
    f.finish(r); f.finish(br); expect(text(await a.result)).toBe('First'); expect(text(await b.result)).toBe('Other');
    const next = f.start('A');
    await vi.waitFor(() => expect(f.requests.filter(x => x.method === 'agent')).toHaveLength(3));
    const nr = await f.ack('A'); f.event(r, snapshot('Old late')); f.event(nr, snapshot('Fresh')); f.finish(nr);
    expect(text(await next.result)).toBe('Fresh');
  });
});

it('preserves delta whitespace and coalesced deltas when snapshots are also present', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Hello', { delta: ' Hello' }));
    f.event(r, snapshot('Hello there', { delta: ' there' }));
    f.event(r, snapshot('Hello there!')); f.finish(r);
    expect(text(await a.result)).toBe(' Hello there!');
  });
});

it('resets snapshot state when native fallback starts a new attempt', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Partial.')); f.event(r, { stream: 'lifecycle', data: { phase: 'error', error: 'Owned fallback' } });
    f.event(r, { stream: 'lifecycle', data: { phase: 'start' } }); f.event(r, snapshot('Recovered.')); f.finish(r);
    const chunks = await a.result; expect(text(chunks)).toBe('Partial.Recovered.'); expect(chunks.some(c => c.type === 'error')).toBe(false);
  });
});

it('preserves public provider snapshot output and emits one done after a revision', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A'); f.event(r, snapshot('Public partial'));
    f.event(r, snapshot('Revised', { replace: true })); f.finish(r);
    const chunks = await a.result; expect(text(chunks)).toBe('Revised');
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(0); expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
  }, { publicProvider: true });
});

it('ignores media-only empty text and malformed non-text values without losing a later snapshot', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, snapshot('Reply', { delta: 'Reply' }));
    f.event(r, snapshot('', { delta: '', mediaUrl: 'https://example.invalid/owned-image.png' }));
    f.event(r, { stream: 'assistant', data: { text: { private: 'not text' }, delta: 5 } });
    f.event(r, { stream: 'assistant', data: 'invalid' }); f.event(r, snapshot('Reply complete')); f.finish(r);
    const chunks = await a.result; expect(text(chunks)).toBe('Reply complete'); expect(chunks.some(c => c.type === 'error')).toBe(false);
  });
});

it('does not append a revised thinking snapshot to the prior reasoning', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, { stream: 'thinking', data: { text: 'First thought', delta: 'First thought' } });
    f.event(r, { stream: 'thinking', data: { text: 'Revised thought', replace: true } }); f.finish(r);
    const chunks = await a.result; expect(text(chunks, 'thinking')).toBe('Revised thought');
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(0); expect(text(chunks)).toBe('Final reply');
  });
});
