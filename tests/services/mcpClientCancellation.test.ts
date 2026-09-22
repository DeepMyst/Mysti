import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import { getEventListeners } from 'events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '../../src/services/McpClient';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const clients: McpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeClient(timeoutMs = 1000) {
  const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  const list = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'test', inputSchema: { type: 'object' } }] });
  const call = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const client = new McpClient({ url: 'https://inert.invalid/mcp', timeoutMs });
  clients.push(client);
  return { client, connect, close, list, call };
}

describe('McpClient captured connection ownership', () => {
  it('does not connect or submit either request when already aborted', async () => {
    const { client, connect, list, call } = fakeClient();
    const stop = new AbortController(); stop.abort(new Error('Stopped'));
    await expect(client.listTools(stop.signal)).rejects.toThrow('Stopped');
    await expect(client.callTool('test', {}, stop.signal)).rejects.toThrow('Stopped');
    expect(connect).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });

  it('shares lazy initialization while releasing only the cancelled connection waiter', async () => {
    const { client, connect, close, list, call } = fakeClient();
    const gate = deferred(); connect.mockReturnValueOnce(gate.promise);
    const stop = new AbortController();
    const first = client.listTools(stop.signal); const rejected = expect(first).rejects.toThrow('Stopped');
    const sibling = client.callTool('test', {});
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    stop.abort(new Error('Stopped')); await rejected;
    expect(close).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    gate.resolve(); await expect(sibling).resolves.toMatchObject({ text: 'ok' });
    await client.listTools();
    expect(connect).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledOnce();
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it('closes only the obsolete pending connection when close races a replacement', async () => {
    const { client, connect, close } = fakeClient();
    const gate = deferred(); connect.mockReturnValueOnce(gate.promise);
    const old = client.listTools(); const rejected = expect(old).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const oldInstance = connect.mock.instances[0];
    await client.close(); await rejected;
    await expect(client.listTools()).resolves.toHaveLength(1);
    const nextInstance = connect.mock.instances[1];
    expect(nextInstance).not.toBe(oldInstance);
    gate.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(close.mock.instances.every(instance => instance === oldInstance)).toBe(true);
    oldInstance.onclose?.();
    await client.listTools();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('cleans up a timed-out handshake and does not let its late success replace a retry', async () => {
    vi.useFakeTimers();
    const { client, connect, close } = fakeClient(100);
    const gate = deferred(); connect.mockReturnValueOnce(gate.promise);
    const pending = client.listTools(); const rejected = expect(pending).rejects.toThrow(/MCP connect timed out/);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(close).toHaveBeenCalled();
    await expect(client.listTools()).resolves.toHaveLength(1);
    const next = connect.mock.instances[1];
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(close.mock.instances).not.toContain(next);
    expect(vi.getTimerCount()).toBe(0);
    await client.callTool('test', {}); expect(connect).toHaveBeenCalledTimes(2);
  });

  it('observes a late handshake rejection after its caller has cancelled', async () => {
    const { client, connect, close } = fakeClient();
    const gate = deferred(); connect.mockReturnValueOnce(gate.promise);
    const stop = new AbortController();
    const pending = client.listTools(stop.signal); const rejected = expect(pending).rejects.toThrow('Stopped');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    stop.abort(new Error('Stopped')); await rejected;
    gate.reject(new Error('late connect failure'));
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    await expect(client.listTools()).resolves.toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('detaches caller listeners after successful and failed requests without retiring the session', async () => {
    const { client, connect, call, close } = fakeClient();
    const stop = new AbortController();
    for (let i = 0; i < 15; i++) { await client.callTool('test', {}, stop.signal); }
    const signals = call.mock.calls.map(args => args[2]?.signal);
    expect(signals.every(signal => signal !== stop.signal && !signal?.aborted)).toBe(true);
    expect(new Set(signals).size).toBe(15);
    call.mockRejectedValueOnce(new Error('protocol failure'));
    await expect(client.callTool('test', {}, stop.signal)).rejects.toThrow('protocol failure');
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    stop.abort();
    expect(signals.every(signal => !signal?.aborted)).toBe(true);
    await expect(client.listTools()).resolves.toHaveLength(1);
    expect(connect).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  });
});

async function loopback(timeoutMs = 1000) {
  const server = new Server({ name: 'inert-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'inert-session', enableJsonResponse: true });
  const holds = new Map<string, ReturnType<typeof deferred>>();
  const signals = new Map<string, AbortSignal>();
  const methods: string[] = [];
  let initialized = 0;
  server.oninitialized = () => { initialized++; };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'test', inputSchema: { type: 'object' as const } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = String(request.params.arguments?.label ?? 'fast');
    signals.set(name, extra.signal);
    await holds.get(name)?.promise;
    return { content: [{ type: 'text', text: name }] };
  });
  await server.connect(transport);
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
        body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        if (body && typeof body === 'object' && 'method' in body) { methods.push(String(body.method)); }
      }
      await transport.handleRequest(req, res, body);
    })().catch(() => { if (!res.writableEnded) { res.writeHead(500).end(); } });
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') { throw new Error('No loopback address'); }
  const client = new McpClient({ url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs });
  return { client, holds, signals, methods, initialized: () => initialized, close: async () => {
    for (const hold of holds.values()) { hold.resolve(); }
    await client.close(); await server.close();
    httpServer.closeAllConnections();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  } };
}

describe('McpClient cancellation over actual loopback MCP', () => {
  it('aborts exactly one server request while its sibling and the shared session remain usable', async () => {
    const fixture = await loopback();
    try {
      fixture.holds.set('first', deferred()); fixture.holds.set('sibling', deferred());
      const stop = new AbortController();
      const first = fixture.client.callTool('test', { label: 'first' }, stop.signal);
      const rejected = expect(first).rejects.toThrow('Stopped');
      const sibling = fixture.client.callTool('test', { label: 'sibling' });
      await vi.waitFor(() => expect(fixture.signals.size).toBe(2));
      expect(fixture.initialized()).toBe(1);
      stop.abort(new Error('Stopped')); await rejected;
      await vi.waitFor(() => expect(fixture.signals.get('first')?.aborted).toBe(true));
      expect(fixture.signals.get('sibling')?.aborted).toBe(false);
      fixture.holds.get('sibling')!.resolve();
      await expect(sibling).resolves.toMatchObject({ text: 'sibling' });
      await expect(fixture.client.listTools()).resolves.toHaveLength(1);
      await expect(fixture.client.callTool('test', { label: 'later' })).resolves.toMatchObject({ text: 'later' });
      expect(fixture.initialized()).toBe(1);
      expect(fixture.methods.filter(method => method === 'notifications/cancelled')).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it('times out one request without closing the session or cancelling a later sibling', async () => {
    const fixture = await loopback(200);
    try {
      await fixture.client.listTools();
      fixture.holds.set('timed', deferred());
      const timed = fixture.client.callTool('test', { label: 'timed' });
      const rejected = expect(timed).rejects.toThrow(/timed out/i);
      await vi.waitFor(() => expect(fixture.signals.has('timed')).toBe(true));
      await expect(fixture.client.callTool('test', { label: 'sibling' })).resolves.toMatchObject({ text: 'sibling' });
      await rejected;
      await vi.waitFor(() => expect(fixture.signals.get('timed')?.aborted).toBe(true));
      expect(fixture.signals.get('sibling')?.aborted).toBe(false);
      await expect(fixture.client.listTools()).resolves.toHaveLength(1);
      expect(fixture.initialized()).toBe(1);
    } finally { await fixture.close(); }
  });

  it('does not send a late cancellation when a completed caller signal is aborted', async () => {
    const fixture = await loopback();
    try {
      const stop = new AbortController();
      await fixture.client.callTool('test', { label: 'finished' }, stop.signal);
      expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
      stop.abort();
      await fixture.client.listTools();
      expect(fixture.methods).not.toContain('notifications/cancelled');
    } finally { await fixture.close(); }
  });
});
