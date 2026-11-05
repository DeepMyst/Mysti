import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import type { StreamChunk } from '../../../src/types';

const OLD = 'owned-old-credential-🔑-12345';
const NEW = 'owned-new-credential-67890';
const PRIVATE = 'owned-private-prompt-or-recipient';
let logs: unknown[][];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args); });
});
afterEach(() => vi.restoreAllMocks());
const logText = () => inspect(logs, { depth: 12 });
const send = (socket: WebSocket, value: unknown) => socket.send(JSON.stringify(value));
const collect = async (stream: AsyncIterable<StreamChunk>) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

async function fixture(run: (f: {
  gateway: OpenClawGateway; readToken: ReturnType<typeof vi.fn>; rotate(): void;
  requests: any[]; connect(): Promise<boolean>; request(handler: (frame: any, socket: WebSocket) => void): void;
  event(payload: Record<string, unknown>, name?: string): void; raw(value: string): void;
  client(): WebSocket;
}) => Promise<void>, options: { reject?: boolean; sign?: () => Promise<never>; url?: (base: string) => string } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  let token = OLD, serverClosed = false;
  const readToken = vi.fn(() => token);
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = options.url ? options.url(base) : base;
  const gateway = new OpenClawGateway(url, undefined, options.sign, readToken);
  const requests: any[] = [], sockets: WebSocket[] = [], errors: string[] = [];
  let requestHandler: ((frame: any, socket: WebSocket) => void) | undefined;
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('error', error => { errors.push(error.message); });
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        if (frame.method === 'connect') {
          send(socket, { type: 'res', id: frame.id, ok: !options.reject,
            ...(options.reject ? { error: { code: 'AUTH_TOKEN_MISMATCH', message: `Rejected ${frame.params.auth.token}`,
              request: PRIVATE } } : { payload: { type: 'hello-ok', protocol: 4 } }) });
        } else if (requestHandler) requestHandler(frame, socket);
        else send(socket, { type: 'res', id: frame.id, ok: true });
      } catch (error) { errors.push(String(error)); }
    });
    send(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-challenge' } });
  });
  try {
    expect((gateway as any)._url).toBe(url); // Must hold before any connect.
    await run({ gateway, readToken, requests, rotate: () => { token = NEW; },
      connect: async () => {
        const pending = gateway.connect(); sockets.push((gateway as any)._ws);
        return pending;
      },
      request: handler => { requestHandler = handler; },
      event: (payload, event = 'agent') => { for (const s of server.clients) send(s, { type: 'event', event, payload }); },
      raw: value => { for (const s of server.clients) s.send(value); },
      client: () => (gateway as any)._ws,
    });
  } finally {
    gateway.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => {
      serverClosed = true; if (error) reject(error); else resolve();
    }));
    await vi.waitFor(() => expect(sockets.every(socket => socket.readyState === WebSocket.CLOSED)).toBe(true));
    if (process.env.PB07_GATEWAY_PRIVACY_RECEIPT) appendFileSync(process.env.PB07_GATEWAY_PRIVACY_RECEIPT,
      JSON.stringify({ serverClosed, allSocketsClosed: sockets.every(s => s.readyState === WebSocket.CLOSED),
        methods: requests.map(r => r.method), errors, nativeGatewayRequests: 0 }) + '\n');
    expect(serverClosed).toBe(true); expect(errors).toEqual([]);
  }
}

it('does not log the token or request metadata when a handshake is rejected', async () => {
  await fixture(async f => { expect(await f.connect()).toBe(false); }, { reject: true });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
  expect(logText()).toContain('Handshake rejected');
});

it('redacts the signing token even when config rotates before an asynchronous signer fails', async () => {
  let rejectSigning: (reason: Error) => void = () => {};
  const sign = vi.fn(() => new Promise<never>((_, reject) => { rejectSigning = reject; }));
  await fixture(async f => {
    const pending = f.connect(); await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
    f.rotate(); rejectSigning(Object.assign(new Error(`Signing failed ${OLD}`), { privateData: PRIVATE }));
    expect(await pending).toBe(false); expect(f.readToken).toHaveBeenCalledOnce();
  }, { sign });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
});

it('redacts late connection errors using the authenticated token without re-reading config', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); f.rotate();
    f.client().emit('error', Object.assign(new Error(`Socket failed ${OLD}`), { request: PRIVATE }));
    expect(f.readToken).toHaveBeenCalledOnce();
  });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
});

it('does not log a malformed WebSocket URL with embedded credentials', async () => {
  const gateway = new OpenClawGateway(`owned-invalid-${OLD}`, OLD);
  try { expect(await gateway.connect()).toBe(false); } finally { gateway.disconnect(); }
  expect(logText()).not.toContain(OLD);
});

it('does not log malformed message bodies, shutdown data, or run identifiers', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.raw(`{"private":"${PRIVATE}-${OLD}", invalid`);
    f.event({ reason: `${PRIVATE}-${OLD}` }, 'shutdown');
    await vi.waitFor(() => expect(f.gateway.isConnected()).toBe(false));
  });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
});

it.each(['string', 'object'])('redacts %s final response errors after config rotation', async shape => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.request((frame, socket) => {
      f.rotate(); const message = `Access denied ${OLD}`;
      send(socket, { type: 'res', id: frame.id, ok: false,
        error: { message: shape === 'string' ? message : { message, privateData: PRIVATE } } });
    });
    const chunks = await collect(f.gateway.sendAgentMessage('owned-message', { sessionKey: 'owned-session' }));
    expect(chunks).toEqual([{ type: 'error', content: 'Access denied [REDACTED]' }]);
    expect(f.readToken).toHaveBeenCalledOnce();
  });
  expect(logText()).not.toContain(OLD);
});

it.each([
  { label: 'event error', event: { type: 'error', error: { message: `Rejected ${OLD}`, request: PRIVATE } }, kind: 'error' },
  { label: 'standalone tool error', event: { type: 'tool_result', is_error: true, content: `Rejected ${OLD}` }, kind: 'tool_result' },
  { label: 'standalone tool error object', event: { type: 'tool_result', success: false, content: { message: `Rejected ${OLD}`, request: PRIVATE } }, kind: 'tool_result' },
  { label: 'tool.error object', event: { type: 'tool.error', error: { message: `Rejected ${OLD}`, request: PRIVATE } }, kind: 'tool_result' },
  { label: 'failed tagged tool', event: { type: 'tool_call', status: 'failed', output: `Rejected ${OLD}` }, kind: 'tool_result' },
  { label: 'completed tagged failed tool', event: { type: 'tool_call', status: 'completed', success: false, output: `Rejected ${OLD}` }, kind: 'tool_result' },
  { label: 'failed step', event: { type: 'step_completed', name: 'owned-tool', is_error: true, output: `Rejected ${OLD}` }, kind: 'tool_result' },
  { label: 'failed step object', event: { type: 'step_completed', name: 'owned-tool', status: 'failed', output: { message: `Rejected ${OLD}`, request: PRIVATE } }, kind: 'tool_result' },
])('redacts and normalizes $label', async ({ event, kind }) => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.request((frame, socket) => {
      f.rotate();
      send(socket, { type: 'event', event: 'agent', payload: { ...event, sessionKey: 'owned-session' } });
      send(socket, { type: 'res', id: frame.id, ok: true });
    });
    const chunks = await collect(f.gateway.sendAgentMessage('owned-message', { sessionKey: 'owned-session' }));
    expect(chunks).toHaveLength(1); expect(chunks[0].type).toBe(kind);
    const content = kind === 'tool_result' ? chunks[0].toolCall?.output : chunks[0].content;
    expect(content).toBe('Rejected [REDACTED]');
    if (kind === 'tool_result') expect(chunks[0].toolCall?.status).toBe('failed');
    expect(f.readToken).toHaveBeenCalledOnce();
  });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
});

it('preserves assistant, successful tool, and unknown-event fallback text without dumping payloads', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.request((frame, socket) => {
      send(socket, { type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', runId: PRIVATE } });
      for (const event of [
        { stream: 'assistant', data: { delta: OLD } },
        { type: 'step_completed', name: 'owned-tool', output: OLD, privateData: PRIVATE },
        { type: 'owned-future-event', content: OLD, privateData: PRIVATE },
      ]) send(socket, { type: 'event', event: 'agent', payload: { ...event, runId: PRIVATE } });
      send(socket, { type: 'res', id: frame.id, ok: true });
    });
    const chunks = await collect(f.gateway.sendAgentMessage('owned-message'));
    expect(chunks.map(c => c.content ?? c.toolCall?.output)).toEqual([OLD, OLD, OLD]);
    expect(chunks[1].toolCall?.status).toBe('completed');
  });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
});

it.each(['channel', 'task', 'setup'])('redacts %s diagnostics and omits private routing metadata', async method => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.request((frame, socket) => {
      f.rotate(); send(socket, { type: 'res', id: frame.id, ok: false,
        error: { message: `Rejected ${OLD}`, request: PRIVATE } });
    });
    if (method === 'channel') expect(await f.gateway.sendToChannel('owned-channel', PRIVATE, PRIVATE)).toBe(false);
    if (method === 'task') expect(await f.gateway.sendAgentTask(PRIVATE, PRIVATE)).toBe(false);
    if (method === 'setup') expect(await f.gateway.connectChannel('owned-channel')).toEqual({ success: false, error: 'Rejected [REDACTED]' });
    expect(f.readToken).toHaveBeenCalledOnce();
  });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
});

it('uses a fresh token on reconnect and redacts errors from both completed connections', async () => {
  await fixture(async f => {
    f.request((frame, socket) => send(socket, { type: 'res', id: frame.id, ok: false,
      error: { message: `Rejected ${f.requests.filter(r => r.method === 'connect').at(-1).params.auth.token}` } }));
    for (const expected of [OLD, NEW]) {
      expect(await f.connect()).toBe(true);
      expect(f.requests.filter(r => r.method === 'connect').at(-1).params.auth.token).toBe(expected);
      expect(await collect(f.gateway.sendAgentMessage('owned-message'))).toEqual([{ type: 'error', content: 'Rejected [REDACTED]' }]);
      f.gateway.disconnect(); f.rotate();
    }
    expect(f.readToken).toHaveBeenCalledTimes(2);
  });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(NEW);
});

it.each(['agent', 'channel', 'task', 'setup', 'sessions', 'history'])('redacts synchronous %s socket failures and releases request state', async method => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true); f.rotate();
    vi.spyOn(f.client(), 'send').mockImplementation(() => {
      throw Object.assign(new Error(`Send failed ${OLD}`), { request: PRIVATE });
    });
    if (method === 'agent') expect(await collect(f.gateway.sendAgentMessage(PRIVATE))).toEqual([{ type: 'error', content: 'Send failed [REDACTED]' }]);
    if (method === 'channel') expect(await f.gateway.sendToChannel('owned', PRIVATE, PRIVATE)).toBe(false);
    if (method === 'task') expect(await f.gateway.sendAgentTask(PRIVATE, PRIVATE)).toBe(false);
    if (method === 'setup') expect(await f.gateway.connectChannel('owned')).toEqual({ success: false, error: 'Send failed [REDACTED]' });
    if (method === 'sessions') expect(await f.gateway.listSessions()).toEqual([]);
    if (method === 'history') expect(await f.gateway.getSessionHistory(PRIVATE)).toEqual([]);
    expect((f.gateway as any)._pendingRequests.size).toBe(0);
    expect((f.gateway as any)._agentRuns.size).toBe(0);
    expect(f.readToken).toHaveBeenCalledOnce();
  });
  expect(logText()).not.toContain(OLD); expect(logText()).not.toContain(PRIVATE);
});

it('redacts a pending run rejection with its original credentials after rotation', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.request(frame => {
      f.rotate(); (f.gateway as any)._pendingRequests.get(frame.id).reject(new Error(`Late failure ${OLD}`));
    });
    expect(await collect(f.gateway.sendAgentMessage('owned-message'))).toEqual([{ type: 'error', content: 'Late failure [REDACTED]' }]);
    expect(f.readToken).toHaveBeenCalledOnce();
  });
});

it('redacts configured URL credentials in decoded and encoded connection errors', async () => {
  const password = 'owned-private-URL-password', query = 'owned private URL query';
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.client().emit('error', new Error(`Failed ${(f.gateway as any)._url}; decoded ${query}`));
  }, { url: base => base.replace('ws://', `ws://owned:${password}@`) + `/?credential=${encodeURIComponent(query)}` });
  for (const value of [password, query, encodeURIComponent(query)]) expect(logText()).not.toContain(value);
  expect(logText()).toContain('?credential=[REDACTED]');
  expect(logText()).not.toContain('private%20URL%20query');
});

it('redacts standard authorization and key patterns without changing normal error details', async () => {
  await fixture(async f => {
    expect(await f.connect()).toBe(true);
    f.request((frame, socket) => send(socket, { type: 'res', id: frame.id, ok: false, error: {
      message: 'HTTP 401: Bearer owned-unconfigured-token; api_key=owned-unconfigured-key',
    } }));
    expect(await collect(f.gateway.sendAgentMessage('owned-message'))).toEqual([{
      type: 'error', content: 'HTTP 401: Bearer [REDACTED]; api_key=[REDACTED]',
    }]);
  });
});
