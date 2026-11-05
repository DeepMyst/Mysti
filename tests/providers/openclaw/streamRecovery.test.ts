import { expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { StreamChunk, Settings } from '../../../src/types';

vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(), readOpenClawToken: () => undefined,
}));
const token = 'owned-stream-recovery-secret';
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
  const challenge = (socket: WebSocket) => wire(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-recovery-nonce' } });
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
    if (process.env.PB07_STREAM_RECOVERY_RECEIPT) appendFileSync(process.env.PB07_STREAM_RECOVERY_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: [...clients, ...sockets].every(s => s.readyState === WebSocket.CLOSED), errors,
      pendingRequests: (gateway as any)._pendingRequests.size, agentRuns: (gateway as any)._agentRuns.size,
      methods: requests.map(r => r.method), nativeGatewayRequests: 0, nativeCliInvocations: 0, paidRequests: 0 }) + '\n');
    vi.restoreAllMocks(); clearMockConfig();
  }
}
const delta = (text: string, seq?: number) => ({ stream: 'assistant', data: { delta: text }, ...(seq === undefined ? {} : { seq }) });

it('settles an explicit native sequence gap promptly, preserves partial text and aborts only that run', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), b = f.start('B'); const ar = await f.ack('A'), br = await f.ack('B');
    f.event(ar, delta('Partial reply', 1)); f.event(ar, { stream: 'error', data: { reason: 'seq gap', expected: 2, received: 4 } });
    const chunks = await bounded(a.result, 'gap completion');
    expect(chunks[0]).toEqual({ type: 'text', content: 'Partial reply' });
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(1); expect(chunks.at(-1)?.content).toMatch(/incomplete|missing|missed/i);
    await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(1));
    expect(f.requests.find(r => r.method === 'chat.abort').params).toEqual({ sessionKey: ar.key, runId: ar.runId });
    f.finish(br, 'Sibling reply'); expect(await bounded(b.result, 'sibling')).toEqual([{ type: 'text', content: 'Sibling reply' }]);
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2);
  });
});

it('reports a native stream error once even if late lifecycle/end/final frames claim success', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    f.event(ar, { stream: 'error', data: { reason: `Owned stream failure ${token}` } });
    f.event(ar, { stream: 'lifecycle', data: { phase: 'end' } }); f.finish(ar);
    const chunks = await bounded(a.result, 'native error');
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(1); expect(chunks.at(-1)?.content).toContain('[REDACTED]');
    expect(JSON.stringify(chunks)).not.toContain(token);
  });
});

it('deduplicates native sequenced text and tools without suppressing identical unsequenced text', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    const tool = { stream: 'tool', seq: 3, data: { phase: 'start', toolCallId: 'owned-tool', name: 'read', args: { path: 'owned.txt' } } };
    f.event(ar, delta('Once', 1)); f.event(ar, delta('Once', 1)); f.event(ar, tool); f.event(ar, tool);
    f.event(ar, delta(' repeat')); f.event(ar, delta(' repeat')); f.finish(ar);
    const chunks = await bounded(a.result, 'duplicates');
    expect(chunks.filter(c => c.type === 'text').map(c => c.content)).toEqual(['Once', ' repeat', ' repeat']);
    expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(1);
  });
});

it('accepts intentionally coalesced native event numbers and separate stream identities', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    f.event(ar, delta('A', 1)); f.event(ar, { stream: 'thinking', seq: 7, data: { delta: 'Thinking' } });
    f.event(ar, delta('BCDEF', 6)); f.finish(ar);
    expect(await bounded(a.result, 'coalesced')).toEqual([{ type: 'text', content: 'A' }, { type: 'thinking', content: 'Thinking' }, { type: 'text', content: 'BCDEF' }]);
  });
});

it('ignores another run’s stream error and starts sequence tracking fresh for a later request', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    f.event(ar, { runId: 'foreign', stream: 'error', data: { reason: 'seq gap' } }); f.event(ar, delta('First', 1)); f.finish(ar);
    expect(await bounded(a.result, 'first')).toEqual([{ type: 'text', content: 'First' }]);
    const b = f.start('A'); await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2)); const br = await f.ack('A');
    f.event(br, delta('Second', 1)); f.finish(br); expect(await bounded(b.result, 'second')).toEqual([{ type: 'text', content: 'Second' }]);
  });
});

it.each(['disconnect', 'shutdown'])('settles every active run on gateway %s without replaying requests', async kind => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), b = f.start('B'), ar = await f.ack('A'), br = await f.ack('B');
    f.event(ar, delta('Partial A')); f.event(br, delta('Partial B'));
    if (kind === 'disconnect') ar.socket.close(); else f.event(ar, { reason: `Private ${token}` }, 'shutdown');
    const replies = await bounded(Promise.all([a.result, b.result]), kind);
    for (const [index, chunks] of replies.entries()) {
      expect(chunks[0]?.content).toBe(index === 0 ? 'Partial A' : 'Partial B'); expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
      expect(JSON.stringify(chunks)).not.toContain(token);
    }
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2);
  });
});

it('reconnects after a drop and keeps old final/events out of the new request', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A'); ar.socket.close();
    expect((await bounded(a.result, 'drop')).some(c => c.type === 'error')).toBe(true);
    expect(await f.connect()).toBe(true); const b = f.start('A'); await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2)); const br = await f.ack('A');
    f.event(br, { runId: ar.runId, ...delta('Stale') }); wire(br.socket, { type: 'res', id: ar.id, ok: true, payload: { text: 'Old final' } }); f.finish(br, 'Fresh reply');
    expect(await bounded(b.result, 'fresh')).toEqual([{ type: 'text', content: 'Fresh reply' }]);
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2);
  });
});

it('finishes the public provider once on a stream gap and never replays the task through the CLI', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    f.event(ar, delta('Public partial')); f.event(ar, { stream: 'error', data: { reason: 'seq gap' } });
    const chunks = await bounded(a.result, 'public gap'); expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(1); expect(chunks.some(c => c.content?.includes('Unexpected CLI replay'))).toBe(false);
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(1);
  }, { publicProvider: true });
});

it('settles a pending handshake immediately when disconnected and closes its socket', async () => {
  await fixture(async f => {
    const connection = f.connect(); await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
    f.gateway.disconnect(); expect(await bounded(connection, 'cancelled handshake')).toBe(false);
    await vi.waitFor(() => expect(f.sockets[0].readyState).toBe(WebSocket.CLOSED));
  }, { holdChallenge: true });
}, 20000);

it('closes a socket cancelled before its WebSocket handshake opens', async () => {
  await fixture(async f => {
    const connection = f.connect(), socket = (f.gateway as any)._ws as WebSocket;
    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    f.gateway.disconnect(); expect(await bounded(connection, 'early cancellation')).toBe(false);
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED)); expect(f.requests).toEqual([]);
  });
});

it('keeps a replacement socket unavailable until its own handshake succeeds', async () => {
  await fixture(async f => {
    const first = f.connect(); await vi.waitFor(() => expect(f.sockets).toHaveLength(1)); f.challenge(f.sockets[0]); expect(await first).toBe(true);
    ((f.gateway as any)._ws as WebSocket).close();
    const next = f.connect(); await vi.waitFor(() => expect(f.sockets).toHaveLength(2));
    expect(f.gateway.isConnected()).toBe(false); f.challenge(f.sockets[1]); expect(await bounded(next, 'replacement readiness')).toBe(true);
  }, { holdChallenge: true });
});

it('does not cancel a sibling request that happens to share the same native session key', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('shared'), ar = await f.ack('shared');
    const b = f.start('shared'); await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2)); const br = await f.ack('shared');
    f.event(ar, { stream: 'error', data: { reason: 'seq gap' } }); expect((await bounded(a.result, 'same-session error')).some(c => c.type === 'error')).toBe(true);
    f.finish(br, 'Surviving sibling'); expect(await bounded(b.result, 'same-session sibling')).toEqual([{ type: 'text', content: 'Surviving sibling' }]);
    await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(1));
    expect(f.requests.find(r => r.method === 'chat.abort').params.runId).toBe(ar.runId);
  });
});

it('automatically reconnects after a dropped run without replaying it', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A'); ar.socket.close();
    expect((await bounded(a.result, 'dropped run')).some(c => c.type === 'error')).toBe(true);
    await vi.waitFor(() => expect(f.gateway.isConnected()).toBe(true), { timeout: 3000 });
    expect(f.requests.filter(r => r.method === 'connect')).toHaveLength(2); expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(1);
    const b = f.start('B'), br = await f.ack('B'); f.finish(br, 'New task'); expect(await bounded(b.result, 'new task')).toEqual([{ type: 'text', content: 'New task' }]);
  });
});

it('settles a run on an owned socket error and redacts its diagnostic', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'); await f.ack('A');
    ((f.gateway as any)._ws as WebSocket).emit('error', new Error(`Owned socket fault ${token}`));
    const chunks = await bounded(a.result, 'socket error'); expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
    expect(chunks[0].content).toContain('[REDACTED]'); expect(JSON.stringify(chunks)).not.toContain(token);
  });
});

it('marks active replies incomplete on a connection-wide event gap and allows a fresh task', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), b = f.start('B'), ar = await f.ack('A'), br = await f.ack('B');
    f.event(ar, delta('Partial A'), 'agent', 10); f.event(br, delta('Partial B'), 'agent', 11);
    f.event(ar, {}, 'tick', 13); // Native non-targeted broadcast12 was dropped.
    const results = await bounded(Promise.all([a.result, b.result]), 'connection-wide gap');
    for (const chunks of results) { expect(chunks.filter(c => c.type === 'error')).toHaveLength(1); expect(chunks.at(-1)?.content).toContain('incomplete'); }
    await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(2));
    expect(f.requests.filter(r => r.method === 'chat.abort').map(r => r.params.runId).sort()).toEqual([ar.runId, br.runId].sort());
    const c = f.start('C'), cr = await f.ack('C'); f.event(cr, delta('Fresh'), 'agent', 14); f.finish(cr);
    expect(await bounded(c.result, 'post-gap task')).toEqual([{ type: 'text', content: 'Fresh' }]);
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(3);
  });
});

it('discards duplicate outer frame identities while preserving targeted unsequenced events', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    f.event(ar, delta('Once'), 'agent', 1); f.event(ar, delta('Once'), 'agent', 1);
    f.event(ar, delta(' targeted')); f.event(ar, {}, 'tick', 2); f.event(ar, delta(' last'), 'agent', 3); f.finish(ar);
    expect(await bounded(a.result, 'frame identities')).toEqual([{ type: 'text', content: 'Once' }, { type: 'text', content: ' targeted' }, { type: 'text', content: ' last' }]);
  });
});

it('counts unrelated broadcast frames and leaves unsequenced targeted events outside that counter', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    f.event(ar, delta('First'), 'agent', 4); f.event(ar, {}, 'presence', 5); f.event(ar, delta(' targeted'));
    f.event(ar, {}, 'tick', 6); f.event(ar, delta(' last'), 'agent', 7); f.finish(ar);
    const chunks = await bounded(a.result, 'unsequenced targeted'); expect(chunks.map(c => c.content)).toEqual(['First', ' targeted', ' last']);
  });
});

it('restarts outer sequence numbering after a new connection', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); const a = f.start('A'), ar = await f.ack('A');
    f.event(ar, delta('First'), 'agent', 100); f.finish(ar); expect(await bounded(a.result, 'first connection')).toEqual([{ type: 'text', content: 'First' }]);
    f.gateway.disconnect(); expect(await f.connect()).toBe(true); const b = f.start('B'), br = await f.ack('B');
    f.event(br, delta('New connection'), 'agent', 1); f.finish(br); expect(await bounded(b.result, 'new sequence numbering')).toEqual([{ type: 'text', content: 'New connection' }]);
  });
});

it('can start a fresh connection immediately after cancelling a pending handshake', async () => {
  await fixture(async f => {
    const old = f.connect(); await vi.waitFor(() => expect(f.sockets).toHaveLength(1)); f.gateway.disconnect();
    const current = f.connect(); await vi.waitFor(() => expect(f.sockets).toHaveLength(2)); f.challenge(f.sockets[1]);
    expect(await bounded(current, 'replacement handshake')).toBe(true); expect(await bounded(old, 'old handshake')).toBe(false);
    expect(f.requests.filter(r => r.method === 'connect')).toHaveLength(1);
  }, { holdChallenge: true });
}, 20000);

it('retires an in-flight handshake when the configured URL changes', async () => {
  await fixture(async f => {
    const old = f.connect(); await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
    f.gateway.setUrl(f.url + '/replacement'); const current = f.connect();
    await vi.waitFor(() => expect(f.sockets).toHaveLength(2)); f.challenge(f.sockets[1]);
    expect(await bounded(current, 'changed URL handshake')).toBe(true); expect(await bounded(old, 'old URL handshake')).toBe(false);
    expect(f.sockets[0].readyState).toBe(WebSocket.CLOSED);
  }, { holdChallenge: true });
}, 20000);

it('does not transmit a late device signature after the handshake is cancelled', async () => {
  const signing = deferred<any>();
  const signer = vi.fn(() => signing.promise);
  try {
    await fixture(async f => {
      const connecting = f.connect(); await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());
      f.gateway.disconnect(); signing.resolve({ id: 'owned-device' });
      expect(await bounded(connecting, 'signing cancellation')).toBe(false);
      expect(f.requests).toEqual([]);
    }, { sign: signer });
  } finally { signing.resolve({ id: 'owned-device' }); }
}, 20000);
