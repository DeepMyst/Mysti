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
const wire = (socket: WebSocket, value: unknown) => socket.send(JSON.stringify(value));
type Run = { requestId: string; runId: string; key: string; aborted: boolean; socket: WebSocket; params: any };
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned cancellation deadline')), 1500); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function fixture(test: (f: {
  start(key: string): Promise<StreamChunk[]>; stop(key?: string): Promise<void>; received(count: number): Promise<Run[]>;
  acknowledge(run: Run, assignedId?: string): Promise<void>; finish(run: Run, text?: string): void;
  foreign(key: string): Run; runs: Run[]; requests: any[]; gap(): void; gateway: OpenClawGateway;
}) => Promise<void>, publicProvider = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [], requests: any[] = [], runs: Run[] = [], foreignRuns: Run[] = [], errors: string[] = [];
  const calls: Promise<unknown>[] = [], generators: AsyncGenerator<StreamChunk>[] = []; let serverClosed = false;
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        if (frame.method === 'agent') {
          // Native2026.6.34 reserves idempotencyKey as runId before async setup
          // and acknowledgement. No agent/model work is executed by this fixture.
          runs.push({ requestId: frame.id, runId: frame.params.idempotencyKey, key: frame.params.sessionKey, aborted: false, socket, params: frame.params });
        } else if (frame.method === 'chat.abort') {
          const selected = [...runs, ...foreignRuns].filter(r => r.key === frame.params.sessionKey && (!frame.params.runId || r.runId === frame.params.runId));
          selected.forEach(r => { r.aborted = true; });
          wire(socket, { type: 'res', id: frame.id, ok: true, payload: { ok: true, aborted: selected.length > 0, runIds: selected.map(r => r.runId) } });
        } else wire(socket, { type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } });
      } catch (error) { errors.push(String(error)); }
    });
    wire(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-preack-challenge' } });
  });
  clearMockConfig(); setMockConfig('openclawUseGateway', true); setMockConfig('openclawGatewayUrl', url);
  const provider = publicProvider ? new TestableOpenClawProvider() : undefined;
  if (provider) {
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => content);
    vi.spyOn(provider, 'getCliPath').mockImplementation(() => { throw new Error('Unexpected CLI replay'); });
  }
  const gateway: OpenClawGateway = provider ? (provider as any)._gateway : new OpenClawGateway(url, 'owned-preack-token');
  let client: WebSocket | undefined;
  try {
    expect((gateway as any)._url).toBe(url); const connecting = gateway.connect(); client = (gateway as any)._ws; expect(await connecting).toBe(true);
    await test({ gateway, runs, requests,
      start: key => {
        const stream = provider ? provider.sendMessage('Owned request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings, null, undefined, key)
          : gateway.sendAgentMessage('Owned request', { sessionKey: key }); generators.push(stream);
        const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; })(); calls.push(result); return result;
      },
      stop: async key => { if (provider) provider.cancelCurrentRequest(key); else await gateway.cancelAgent(key); },
      received: async count => { await vi.waitFor(() => expect(runs).toHaveLength(count)); return runs; },
      acknowledge: async (run, assignedId) => {
        if (assignedId) run.runId = assignedId;
        wire(run.socket, { type: 'res', id: run.requestId, ok: true, payload: { status: 'accepted', runId: run.runId } });
        if ((gateway as any)._agentRuns.has(run.requestId)) await vi.waitFor(() => expect((gateway as any)._agentRuns.get(run.requestId)?.runId).toBe(run.runId));
      },
      finish: (run, text = 'Owned reply') => wire(run.socket, { type: 'res', id: run.requestId, ok: true, payload: { status: run.aborted ? 'timeout' : 'ok', runId: run.runId,
        result: { payloads: run.aborted ? [] : [{ text }] } } }),
      foreign: key => { const row = { key, requestId: 'foreign-request', runId: `foreign-run-${foreignRuns.length}`, aborted: false, socket: sockets[0], params: {} }; foreignRuns.push(row); return row; },
      gap: () => { wire(sockets[0], { type: 'event', event: 'tick', seq: 1, payload: {} }); wire(sockets[0], { type: 'event', event: 'tick', seq: 3, payload: {} }); },
    });
    expect(errors).toEqual([]);
  } finally {
    provider?.dispose(); gateway.disconnect(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); }));
    await Promise.allSettled(calls); for (const stream of generators) await stream.return(undefined as never);
    await vi.waitFor(() => expect([...sockets, ...(client ? [client] : [])].every(s => s.readyState === WebSocket.CLOSED)).toBe(true));
    if (process.env.PB07_PREACK_RECEIPT) appendFileSync(process.env.PB07_PREACK_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: [...sockets, ...(client ? [client] : [])].every(s => s.readyState === WebSocket.CLOSED), errors,
      pendingRequests: (gateway as any)._pendingRequests.size, agentRuns: (gateway as any)._agentRuns.size,
      methods: requests.map(r => r.method), aborts: requests.filter(r => r.method === 'chat.abort').map(r => r.params),
      runs: runs.map(r => ({ id: r.runId, key: r.key, aborted: r.aborted })), foreignRuns: foreignRuns.map(r => ({ id: r.runId, key: r.key, aborted: r.aborted })),
      nativeCliInvocations: 0, nativeGatewayRequests: 0, paidRequests: 0 }) + '\n');
    vi.restoreAllMocks(); clearMockConfig();
  }
}

it('stops only its pre-registered native run before acknowledgment, preserving another owner in the same session', async () => {
  await fixture(async f => {
    const result = f.start('shared'), [run] = await f.received(1), foreign = f.foreign('shared');
    await bounded(f.stop('shared')); expect(await bounded(result)).toEqual([]);
    expect(run.aborted).toBe(true); expect(foreign.aborted).toBe(false);
    expect(f.requests.find(r => r.method === 'chat.abort').params).toEqual({ sessionKey: 'shared', runId: run.params.idempotencyKey });
  });
});

it('stops two owned pre-ack requests in a shared session without a session-wide abort', async () => {
  await fixture(async f => {
    const a = f.start('shared'), b = f.start('shared'), runs = await f.received(2), foreign = f.foreign('shared');
    await bounded(f.stop('shared')); await bounded(Promise.all([a, b]));
    expect(runs.every(r => r.aborted)).toBe(true); expect(foreign.aborted).toBe(false);
    expect(f.requests.filter(r => r.method === 'chat.abort').map(r => r.params.runId).sort()).toEqual(runs.map(r => r.runId).sort());
  });
});

it.each([false, true])('coalesces repeated Stop calls into one abort with acknowledged=%s', async acknowledged => {
  await fixture(async f => {
    const result = f.start('owned'), [run] = await f.received(1); if (acknowledged) await f.acknowledge(run);
    await bounded(Promise.all([f.stop('owned'), f.stop('owned')])); await bounded(result);
    expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(1); expect(run.aborted).toBe(true);
  });
});

it('uses an explicitly acknowledged server run id when it differs from the request key', async () => {
  await fixture(async f => {
    const result = f.start('shared'), [run] = await f.received(1), foreign = f.foreign('shared'); await f.acknowledge(run, 'legacy-assigned-run');
    await bounded(f.stop('shared')); await bounded(result); expect(run.aborted).toBe(true); expect(foreign.aborted).toBe(false);
    expect(f.requests.find(r => r.method === 'chat.abort').params.runId).toBe('legacy-assigned-run');
  });
});

it('does not let a late old acknowledgment or final response affect a replacement request', async () => {
  await fixture(async f => {
    const a = f.start('owned'), [ar] = await f.received(1); await bounded(f.stop('owned')); await bounded(a);
    const b = f.start('owned'), [, br] = await f.received(2); await f.acknowledge(ar); f.finish(ar, 'Stale'); await f.acknowledge(br); f.finish(br, 'Fresh');
    expect(await bounded(b)).toEqual([{ type: 'text', content: 'Fresh' }]); expect(br.aborted).toBe(false);
    expect(f.requests.filter(r => r.method === 'agent')).toHaveLength(2); expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(1);
  });
});

it('keeps different panels independent while one is stopped before acknowledgment', async () => {
  await fixture(async f => {
    const a = f.start('A'), b = f.start('B'), [ar, br] = await f.received(2);
    await bounded(f.stop('A')); await bounded(a); await f.acknowledge(br); f.finish(br, 'B reply');
    expect(ar.aborted).toBe(true); expect(br.aborted).toBe(false); expect(await bounded(b)).toEqual([{ type: 'text', content: 'B reply' }]);
  });
});

it('uses distinct native request identities even when time and Math.random repeat', async () => {
  await fixture(async f => {
    const fixedTime = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(fixedTime), random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const a = f.start('A'), b = f.start('B'); now.mockRestore(); random.mockRestore();
    const [ar, br] = await f.received(2); expect(ar.runId).not.toBe(br.runId);
    await f.acknowledge(ar); await f.acknowledge(br); f.finish(ar, 'A reply'); f.finish(br, 'B reply');
    expect((await bounded(a))[0]?.content).toBe('A reply'); expect((await bounded(b))[0]?.content).toBe('B reply');
  });
});

it('uses exact pre-ack identities when a connection-wide gap cancels active requests', async () => {
  await fixture(async f => {
    const a = f.start('shared'), b = f.start('shared'), runs = await f.received(2), foreign = f.foreign('shared'); f.gap();
    const results = await bounded(Promise.all([a, b])); expect(results.every(chunks => chunks.some(c => c.type === 'error'))).toBe(true);
    await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'chat.abort')).toHaveLength(2));
    expect(runs.every(r => r.aborted)).toBe(true); expect(foreign.aborted).toBe(false);
  });
});

it('stops the public provider before acknowledgment and preserves a fresh request', async () => {
  await fixture(async f => {
    const a = f.start('panel'), [ar] = await f.received(1), foreign = f.foreign(ar.key); await f.stop('panel'); await bounded(a);
    await vi.waitFor(() => expect(ar.aborted).toBe(true)); expect(foreign.aborted).toBe(false);
    const b = f.start('panel'), [, br] = await f.received(2); await f.acknowledge(ar); f.finish(ar, 'Stale'); await f.acknowledge(br); f.finish(br, 'Fresh public reply');
    const chunks = await bounded(b); expect(chunks).toContainEqual({ type: 'text', content: 'Fresh public reply' }); expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    expect(chunks.some(c => c.type === 'error')).toBe(false);
  }, true);
});
