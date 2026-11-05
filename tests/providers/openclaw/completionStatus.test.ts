import { expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';
vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(), readOpenClawToken: () => undefined,
}));
const token = 'owned-completion-token';
const wire = (socket: WebSocket, frame: unknown) => socket.send(JSON.stringify(frame));
type Request = { id: string; method: string; params: any; socket: WebSocket };
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned response deadline')), 1500); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function fixture(test: (f: {
  gateway: OpenClawGateway; start(key?: string): { chunks: StreamChunk[]; result: Promise<StreamChunk[]> };
  request(method: string, index?: number): Promise<Request>;
  reply(r: Request, payload: object, ok?: boolean): void; event(r: Request, payload: object): void;
  track<T>(p: Promise<T>): Promise<T>; requests: Request[];
}) => Promise<void>, publicProvider = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requests: Request[] = [], sockets: WebSocket[] = [], errors: string[] = [];
  const pending: Promise<unknown>[] = [], streams: AsyncGenerator<StreamChunk>[] = [];
  server.on('connection', socket => {
    sockets.push(socket); socket.on('error', e => errors.push(e.message));
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()); requests.push({ ...frame, socket });
      if (frame.method === 'connect' || frame.method === 'chat.abort') wire(socket, { type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } });
    });
    wire(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-completion-nonce' } });
  });
  clearMockConfig(); setMockConfig('openclawUseGateway', true); setMockConfig('openclawGatewayUrl', url);
  const provider = publicProvider ? new TestableOpenClawProvider() : undefined;
  if (provider) {
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => content);
    vi.spyOn(provider, 'getCliPath').mockImplementation(() => { throw new Error('Unexpected CLI replay'); });
  }
  const gateway: OpenClawGateway = provider ? (provider as any)._gateway : new OpenClawGateway(url, token);
  const track = <T>(p: Promise<T>) => { pending.push(p); return p; };
  let serverClosed = false, client: WebSocket | undefined;
  try {
    expect((gateway as any)._url).toBe(url); const connecting = track(gateway.connect()); client = (gateway as any)._ws;
    expect(await bounded(connecting)).toBe(true);
    await test({ gateway, track, requests,
      start: (key = 'owned') => {
        const stream = provider ? provider.sendMessage('Owned request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings, null, undefined, key)
          : gateway.sendAgentMessage('Owned request', { sessionKey: key });
        streams.push(stream); const chunks: StreamChunk[] = [];
        const result = track((async () => { for await (const chunk of stream) chunks.push(chunk); return chunks; })()); return { chunks, result };
      },
      request: async (method, index = 0) => { await vi.waitFor(() => expect(requests.filter(r => r.method === method).length).toBeGreaterThan(index)); return requests.filter(r => r.method === method)[index]; },
      reply: (r, payload, ok = true) => wire(r.socket, { type: 'res', id: r.id, ok, payload: { runId: r.params.idempotencyKey, ...payload }, ...(ok ? {} : { error: { message: 'Owned failure ' + token } }) }),
      event: (r, payload) => wire(r.socket, { type: 'event', event: 'agent', payload: { runId: r.params.idempotencyKey, sessionKey: r.params.sessionKey, ...payload } }),
    });
    expect(errors).toEqual([]);
  } finally {
    provider?.dispose(); gateway.disconnect(); for (const s of server.clients) s.terminate();
    await new Promise<void>((resolve, reject) => server.close(e => { serverClosed = true; if (e) reject(e); else resolve(); }));
    await Promise.allSettled(pending); for (const s of streams) await s.return(undefined as never);
    await vi.waitFor(() => expect([...sockets, ...(client ? [client] : [])].every(s => s.readyState === WebSocket.CLOSED)).toBe(true));
    if (process.env.PB07_COMPLETION_RECEIPT) appendFileSync(process.env.PB07_COMPLETION_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: [...sockets, ...(client ? [client] : [])].every(s => s.readyState === WebSocket.CLOSED), errors,
      methods: requests.map(r => r.method), pendingRequests: (gateway as any)._pendingRequests.size, agentRuns: (gateway as any)._agentRuns.size,
      nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0, externalMessages: 0 }) + '\n');
    vi.restoreAllMocks(); clearMockConfig();
  }
}
const text = (value: string) => ({ stream: 'assistant', data: { delta: value } });
const final = (value = 'Reply') => ({ status: 'ok', result: { payloads: [{ text: value }] } });

it.each(['accepted', 'pending', 'running'])('settles a non-agent %s acknowledgement instead of waiting for a nonexistent final', async status => {
  await fixture(async f => {
    const result = f.track(f.gateway.sendAgentTask('Owned loopback task'));
    const request = await f.request('chat.send'); f.reply(request, { status });
    expect(await bounded(result)).toBe(true);
    expect(f.requests.filter(r => r.method === 'chat.send')).toHaveLength(1);
    expect((f.gateway as any)._pendingRequests.size).toBe(0);
  });
});

it.each(['accepted', 'pending', 'running'])('settles an explicit RPC rejection with ack-like status %s immediately', async status => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status }, false);
    const chunks = await bounded(a.result); expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
    expect(JSON.stringify(chunks)).not.toContain(token); expect(f.requests.some(r => r.method === 'chat.abort')).toBe(false);
  });
});

it.each([false, true])('reports native in-flight as incomplete without replaying or aborting the existing run; public=%s', async publicProvider => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status: 'in_flight' });
    const chunks = await bounded(a.result); expect(chunks.find(c => c.type === 'error')?.content).toMatch(/already.*running|already.*in flight/i);
    expect(chunks.filter(c => c.type === 'text')).toEqual([]); expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(1);
    expect(f.requests.some(r => r.method === 'chat.abort')).toBe(false);
  }, publicProvider);
});

it.each(['timeout', 'error'])('does not claim an RPC-ok %s delegation was accepted', async status => {
  await fixture(async f => {
    const result = f.track(f.gateway.sendAgentTask('Owned loopback task'));
    f.reply(await f.request('chat.send'), { status, summary: 'aborted' }); expect(await bounded(result)).toBe(false);
  });
});

it.each(['aborted', 'meta-error'])('reads %s metadata from a legacy top-level final envelope', async kind => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status: 'accepted' });
    f.event(r, text('Useful partial'));
    f.reply(r, { status: 'ok', payloads: [], meta: kind === 'aborted' ? { aborted: true } : { error: { message: 'Owned failure ' + token } } });
    const chunks = await bounded(a.result); expect(chunks[0]).toMatchObject({ type: 'text', content: 'Useful partial' });
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(1); expect(JSON.stringify(chunks)).not.toContain(token);
  });
});

it('retains a terminal aborted lifecycle signal even when a later RPC says ok', async () => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status: 'accepted' });
    f.event(r, text('Partial')); f.event(r, { stream: 'lifecycle', data: { phase: 'end', aborted: true } }); f.reply(r, final('Partial'));
    const chunks = await bounded(a.result); expect(chunks.find(c => c.type === 'error')?.content).toMatch(/abort|incomplete/i);
  });
});

it.each(['accepted', 'pending', 'running'])('keeps an actual agent %s acknowledgement open until its final response', async status => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status }); f.event(r, text('Partial'));
    await vi.waitFor(() => expect(a.chunks).toContainEqual({ type: 'text', content: 'Partial' }));
    expect((f.gateway as any)._pendingRequests.has(r.id)).toBe(true);
    f.reply(r, final('Partial')); expect(await bounded(a.result)).toEqual([{ type: 'text', content: 'Partial' }]);
  });
});

it.each(['started', 'in_flight', 'ok'])('keeps native delegation %s successful as an acceptance receipt', async status => {
  await fixture(async f => {
    const result = f.track(f.gateway.sendAgentTask('Owned task')); f.reply(await f.request('chat.send'), { status });
    expect(await bounded(result)).toBe(true); expect(f.requests.filter(r => r.method === 'chat.send')).toHaveLength(1);
  });
});

it('preserves normal channel delivery acknowledgements without dispatching an agent', async () => {
  await fixture(async f => {
    const result = f.track(f.gateway.sendToChannel('owned-channel', 'Owned loopback message', 'owned-target'));
    f.reply(await f.request('send'), { status: 'accepted' }); expect(await bounded(result)).toBe(true);
    expect(f.requests.map(r => r.method)).toEqual(['connect', 'send']);
  });
});

it('does not let an error-shaped accepted response hide behind RPC ok=true', async () => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent');
    wire(r.socket, { type: 'res', id: r.id, ok: true, payload: { status: 'accepted' }, error: { message: 'Owned failure ' + token } });
    const chunks = await bounded(a.result); expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
    expect(JSON.stringify(chunks)).not.toContain(token);
  });
});

it('only clears an aborted attempt when a new lifecycle start establishes recovery', async () => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status: 'accepted' });
    f.event(r, { stream: 'lifecycle', data: { phase: 'end', aborted: true } });
    f.event(r, { stream: 'lifecycle', data: { phase: 'start' } }); f.event(r, text('Recovered')); f.reply(r, final('Recovered'));
    expect(await bounded(a.result)).toEqual([{ type: 'text', content: 'Recovered' }]);
  });
});

it('does not turn an explicit normal empty result into an invented failure or answer', async () => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status: 'accepted' });
    f.event(r, { stream: 'lifecycle', data: { phase: 'end', aborted: false } }); f.reply(r, { status: 'ok', result: { payloads: [] } });
    expect(await bounded(a.result)).toEqual([]);
  });
});

it('keeps simultaneous agent/RPC state separate and recovers after an in-flight result', async () => {
  await fixture(async f => {
    const a = f.start('A'), b = f.start('B'), task = f.track(f.gateway.sendAgentTask('Owned task'));
    const ar = await f.request('agent'), br = await f.request('agent', 1), tr = await f.request('chat.send');
    f.reply(ar, { status: 'accepted' }); f.reply(br, { status: 'in_flight' }); f.reply(tr, { status: 'running' });
    expect(await bounded(task)).toBe(true); expect((await bounded(b.result)).filter(c => c.type === 'error')).toHaveLength(1);
    expect((f.gateway as any)._pendingRequests.has(ar.id)).toBe(true); f.event(ar, text('A reply')); f.reply(ar, final('A reply'));
    expect(await bounded(a.result)).toEqual([{ type: 'text', content: 'A reply' }]);
    const c = f.start('C'), cr = await f.request('agent', 2); f.reply(cr, { status: 'accepted' }); f.reply(cr, final('Fresh reply'));
    expect(await bounded(c.result)).toEqual([{ type: 'text', content: 'Fresh reply' }]);
    expect(f.requests.some(r => r.method === 'chat.abort')).toBe(false);
  });
});

it('does not label an aborted run as completed when the final summary says completed', async () => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status: 'accepted' });
    f.event(r, { stream: 'lifecycle', data: { phase: 'end', aborted: true } });
    f.reply(r, { status: 'ok', summary: 'completed', result: { payloads: [] } });
    expect((await bounded(a.result)).find(c => c.type === 'error')?.content).toMatch(/abort/i);
  });
});

it.each(['finishing', 'error'])('retains an aborted %s lifecycle signal through a later normal end', async phase => {
  await fixture(async f => {
    const a = f.start(), r = await f.request('agent'); f.reply(r, { status: 'accepted' });
    f.event(r, { stream: 'lifecycle', data: { phase, aborted: true } });
    f.event(r, { stream: 'lifecycle', data: { phase: 'end' } }); f.reply(r, final());
    expect((await bounded(a.result)).find(c => c.type === 'error')?.content).toMatch(/abort/i);
  });
});
