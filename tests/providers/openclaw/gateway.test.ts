import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import type { StreamChunk } from '../../../src/types';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(reject = false) {
  const timeline: Array<Record<string, unknown>> = [], failures: string[] = [];
  const waiters = new Set<() => void>();
  const collectors: Array<{ key: string; status: string; error?: string; promise: Promise<StreamChunk[]> }> = [];
  const sockets: Array<{ socket: WebSocket; side: string; closed: boolean }> = [];
  let overflow = false, serverClosed = false;
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    if (timeline.length < 200) timeline.push({ at: Date.now(), event, ...detail }); else overflow = true;
    for (const notify of [...waiters]) notify();
  };
  const observeSocket = (socket: WebSocket, side: string) => {
    const row = { socket, side, closed: false }; sockets.push(row);
    const onClose = (code: number) => { row.closed = true; record('socket-close', { side, code }); };
    socket.once('close', onClose);
    if (side === 'client') socket.once('open', () => {
      // The owned transport listener survives gateway.disconnect removing all
      // WebSocket listeners, including when a test explicitly disconnects.
      (socket as any)._socket.once('close', () => {
        row.closed = true; record('client-transport-close');
      });
    });
    socket.on('error', error => { failures.push(`${side}: ${error.message}`); record('socket-error', { side }); });
    return { row, onClose };
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, rejectListening) => { server.once('listening', resolve); server.once('error', rejectListening); });
  const requests: any[] = []; const runs = new Map<string, { socket: WebSocket; id: string; runId: string }>();
  const send = (socket: WebSocket, value: any) => {
    record('server-send', { type: value.type, eventName: value.event, id: value.id, ok: value.ok,
      status: value.payload?.status, runId: value.payload?.runId });
    socket.send(JSON.stringify(value), error => {
      if (error) failures.push(`server send: ${error.message}`);
      record('server-sent', { id: value.id, failed: !!error });
    });
  };
  server.on('connection', socket => {
    observeSocket(socket, 'server'); record('server-connection');
    socket.on('message', data => {
      try {
        const msg = JSON.parse(data.toString()); requests.push(msg);
        record('server-received', { type: msg.type, method: msg.method, id: msg.id, sessionKey: msg.params?.sessionKey });
        if (msg.method === 'connect') {
          expect(msg.params.minProtocol).toBeLessThanOrEqual(4); expect(msg.params.maxProtocol).toBe(4);
          send(socket, reject ? { type: 'res', id: msg.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'protocol mismatch' } }
            : { type: 'res', id: msg.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } });
        } else if (msg.method === 'agent') {
          const runId = `run-${msg.params.sessionKey}`;
          runs.set(msg.params.sessionKey, { socket, id: msg.id, runId });
          send(socket, { type: 'res', id: msg.id, ok: true, payload: { status: 'accepted', runId } });
        } else { send(socket, { type: 'res', id: msg.id, ok: true }); }
      } catch (error) { failures.push(String(error)); record('fixture-callback-error'); }
    });
    send(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture' } });
  });
  const gateway = new OpenClawGateway(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, 'fixture-token');
  let client: ReturnType<typeof observeSocket> | undefined;
  const connect = async () => {
    record('connect-start'); const pending = gateway.connect();
    const socket = (gateway as any)._ws as WebSocket;
    client = observeSocket(socket, 'client');
    // Registered after the product listener: this observes the consumed frame,
    // not merely the server's decision to enqueue an acknowledgment.
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString());
        record('client-received', { type: frame.type, eventName: frame.event, id: frame.id, ok: frame.ok,
          status: frame.payload?.status, runId: frame.payload?.runId });
      } catch (error) { failures.push(String(error)); record('client-observer-error'); }
    });
    const connected = await pending; record('connect-result', { connected }); return connected;
  };
  const diagnostic = () => JSON.stringify({ failures, overflow, collectors: collectors.map(({ key, status, error }) => ({ key, status, error })), timeline });
  const waitFor = (ready: () => boolean, budget: number, observeFailures = true) => new Promise<void>((resolve, rejectWait) => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const failure = observeFailures && (failures.length > 0 || overflow || collectors.some(row => row.status === 'rejected'));
      if (!failure && !ready()) return;
      clearTimeout(timer); waiters.delete(check);
      if (failure) rejectWait(new Error(diagnostic())); else resolve();
    };
    timer = setTimeout(() => { waiters.delete(check); rejectWait(new Error(`Fixture readiness deadline: ${diagnostic()}`)); }, budget);
    waiters.add(check); check();
  });
  cleanups.push(async () => {
    let cleanupError: unknown;
    try {
      gateway.disconnect();
      // disconnect removes all product socket listeners; restore observation
      // before the asynchronous close event, without changing its operation.
      if (client && !client.row.closed) client.row.socket.once('close', client.onClose);
      for (const socket of server.clients) socket.terminate();
      server.close(error => { if (error) failures.push(error.message); serverClosed = true; record('server-close'); });
      await waitFor(() => serverClosed && sockets.every(row => row.closed && row.socket.readyState === 3) && collectors.every(row => row.status !== 'pending'), 3000, false);
      await Promise.allSettled(collectors.map(row => row.promise));
    } catch (error) { cleanupError = error; }
    finally {
      const receipt = { rejectHandshake: reject, serverClosed, allSocketsClosed: sockets.every(row => row.closed && row.socket.readyState === 3),
        socketCount: sockets.length, collectors: collectors.map(({ key, status, error }) => ({ key, status, error })),
        failures, overflow, cleanupError: cleanupError ? String(cleanupError) : undefined, timeline };
      const output = process.env.PB07_OPENCLAW_GATEWAY_RECEIPT;
      if (output) fs.appendFileSync(output, JSON.stringify(receipt) + '\n');
    }
    if (cleanupError) throw cleanupError;
    expect(failures, diagnostic()).toEqual([]); expect(overflow).toBe(false);
  });
  const complete = (key: string) => {
    const run = runs.get(key)!;
    send(run.socket, { type: 'event', event: 'agent', payload: { runId: run.runId, sessionKey: key, stream: 'assistant', data: { delta: key } } });
    send(run.socket, { type: 'res', id: run.id, ok: true, payload: { status: 'ok', text: key } });
  };
  const waitRuns = async (count: number) => {
    await waitFor(() => runs.size === count && [...runs.values()].every(run =>
      (gateway as any)._agentRuns.get(run.id)?.runId === run.runId), 3000);
    expect(runs.size).toBe(count);
  };
  const collect = (key: string) => {
    const promise = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of gateway.sendAgentMessage('fixture', { sessionKey: key })) chunks.push(chunk);
      return chunks;
    })();
    const row = { key, status: 'pending', error: undefined as string | undefined, promise }; collectors.push(row);
    void promise.then(() => { row.status = 'fulfilled'; record('collector-fulfilled', { key }); }, error => {
      row.status = 'rejected'; row.error = String(error); record('collector-rejected', { key });
    });
    return promise;
  };
  return { gateway, runs, requests, complete, waitRuns, collect, connect };
}
describe('OpenClaw protocol 4 transport', () => {
  it('isolates concurrent streams and does not duplicate final text', async () => {
    const h = await fixture(); expect(await h.connect()).toBe(true);
    const a = h.collect('a'), b = h.collect('b'); await h.waitRuns(2);
    h.complete('a'); h.complete('b');
    expect(await a).toEqual([{ type: 'text', content: 'a' }]); expect(await b).toEqual([{ type: 'text', content: 'b' }]);
  });
  it('cancels only the owning run and settles without waiting for remote completion', async () => {
    const h = await fixture(); expect(await h.connect()).toBe(true);
    const a = h.collect('a'), b = h.collect('b'); await h.waitRuns(2);
    await h.gateway.cancelAgent('a'); expect(await a).toEqual([]);
    expect(h.requests.find(r => r.method === 'chat.abort').params).toEqual({ sessionKey: 'a', runId: 'run-a' });
    h.complete('b'); expect(await b).toEqual([{ type: 'text', content: 'b' }]);
  });
  it('does not schedule reconnect storms after an incompatible handshake', async () => {
    const h = await fixture(true); expect(await h.connect()).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((h.gateway as any)._reconnectTimer).toBeNull();
  });
  it('settles an active stream on disconnect', async () => {
    const h = await fixture(); expect(await h.connect()).toBe(true); const run = h.collect('a'); await h.waitRuns(1);
    h.gateway.disconnect(); expect((await run).some(chunk => chunk.type === 'error')).toBe(true);
  });
});
