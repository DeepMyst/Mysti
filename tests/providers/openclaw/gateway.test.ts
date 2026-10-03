import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import type { StreamChunk } from '../../../src/types';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
async function fixture(reject = false) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(() => { server.clients.forEach(client => client.terminate()); server.close(); });
  const requests: any[] = []; const runs = new Map<string, { socket: WebSocket; id: string; runId: string }>();
  const send = (socket: WebSocket, value: unknown) => socket.send(JSON.stringify(value));
  server.on('connection', socket => {
    send(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture' } });
    socket.on('message', data => {
      const msg = JSON.parse(data.toString()); requests.push(msg);
      if (msg.method === 'connect') {
        expect(msg.params.minProtocol).toBeLessThanOrEqual(4); expect(msg.params.maxProtocol).toBe(4);
        send(socket, reject ? { type: 'res', id: msg.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'protocol mismatch' } }
          : { type: 'res', id: msg.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } });
      } else if (msg.method === 'agent') {
        const runId = `run-${msg.params.sessionKey}`;
        runs.set(msg.params.sessionKey, { socket, id: msg.id, runId });
        send(socket, { type: 'res', id: msg.id, ok: true, payload: { status: 'accepted', runId } });
      } else { send(socket, { type: 'res', id: msg.id, ok: true }); }
    });
  });
  const gateway = new OpenClawGateway(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, 'fixture-token');
  cleanups.push(() => gateway.disconnect());
  const complete = (key: string) => {
    const run = runs.get(key)!;
    send(run.socket, { type: 'event', event: 'agent', payload: { runId: run.runId, sessionKey: key, stream: 'assistant', data: { delta: key } } });
    send(run.socket, { type: 'res', id: run.id, ok: true, payload: { status: 'ok', text: key } });
  };
  const waitRuns = async (count: number) => {
    const deadline = Date.now() + 3000;
    while (runs.size < count && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
    expect(runs.size).toBe(count);
  };
  const collect = async (key: string) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of gateway.sendAgentMessage('fixture', { sessionKey: key })) { chunks.push(chunk); }
    return chunks;
  };
  return { gateway, runs, requests, complete, waitRuns, collect };
}
describe('OpenClaw protocol 4 transport', () => {
  it('isolates concurrent streams and does not duplicate final text', async () => {
    const h = await fixture(); expect(await h.gateway.connect()).toBe(true);
    const a = h.collect('a'), b = h.collect('b'); await h.waitRuns(2);
    h.complete('a'); h.complete('b');
    expect(await a).toEqual([{ type: 'text', content: 'a' }]); expect(await b).toEqual([{ type: 'text', content: 'b' }]);
  });
  it('cancels only the owning run and settles without waiting for remote completion', async () => {
    const h = await fixture(); await h.gateway.connect();
    const a = h.collect('a'), b = h.collect('b'); await h.waitRuns(2);
    await h.gateway.cancelAgent('a'); expect(await a).toEqual([]);
    expect(h.requests.find(r => r.method === 'chat.abort').params).toEqual({ sessionKey: 'a', runId: 'run-a' });
    h.complete('b'); expect(await b).toEqual([{ type: 'text', content: 'b' }]);
  });
  it('does not schedule reconnect storms after an incompatible handshake', async () => {
    const h = await fixture(true); expect(await h.gateway.connect()).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((h.gateway as any)._reconnectTimer).toBeNull();
  });
  it('settles an active stream on disconnect', async () => {
    const h = await fixture(); await h.gateway.connect(); const run = h.collect('a'); await h.waitRuns(1);
    h.gateway.disconnect(); expect((await run).some(chunk => chunk.type === 'error')).toBe(true);
  });
});
