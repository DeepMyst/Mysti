/** Real loopback WebSocket tests: no gateway daemon, CLI, credentials, or model. */
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import type { StreamChunk } from '../../../src/types';

interface Request {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
  socket: WebSocket;
}

const gateways: OpenClawGateway[] = [];
const fixtures: Fixture[] = [];
const pause = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function eventually<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) { return value; }
    await pause();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gateway reader did not settle')), 2000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function hello(protocol = 4): Record<string, unknown> {
  return {
    type: 'hello-ok', protocol,
    server: { version: '2026.6.34-fixture', connId: 'fixture-connection' },
    features: { methods: ['agent', 'sessions.abort'], events: ['agent', 'chat', 'shutdown'] },
    snapshot: {}, auth: { role: 'operator', scopes: ['operator.write'] },
    policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 30000 },
  };
}

class Fixture {
  readonly server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  readonly requests: Request[] = [];
  readonly sockets: WebSocket[] = [];
  private readonly sequences = new Map<string, number>();
  url = '';

  constructor(private readonly options: { challenge?: boolean; autoHello?: boolean } = {}) {
    fixtures.push(this);
    this.server.on('connection', socket => {
      this.sockets.push(socket);
      socket.on('error', () => { /* Expected when a test terminates its peer. */ });
      socket.on('message', bytes => {
        const request = { ...JSON.parse(bytes.toString()), socket } as Request;
        this.requests.push(request);
        if (request.method === 'connect' && this.options.autoHello !== false) {
          this.reply(request, hello());
        }
        if (request.method === 'sessions.abort') {
          this.reply(request, { ok: true, abortedRunId: null, status: 'no-active-run' });
        }
      });
      if (this.options.challenge !== false) { this.challenge(socket); }
    });
  }

  async listen(): Promise<this> {
    if (!this.server.address()) { await once(this.server, 'listening'); }
    const address = this.server.address();
    if (!address || typeof address === 'string') { throw new Error('No loopback address'); }
    this.url = `ws://127.0.0.1:${address.port}`;
    return this;
  }

  challenge(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-nonce', ts: Date.now() } }));
  }

  request(method: string, predicate: (request: Request) => boolean = () => true): Promise<Request> {
    return eventually(() => this.requests.find(request => request.method === method && predicate(request)), method);
  }

  reply(request: Request, payload: Record<string, unknown>, ok = true): void {
    request.socket.send(JSON.stringify({ type: 'res', id: request.id, ok, payload,
      ...(!ok ? { error: { code: 'UNAVAILABLE', message: 'fixture rejection' } } : {}),
    }));
  }

  event(request: Request, data: Record<string, unknown>, overrides: Record<string, unknown> = {}): void {
    const seq = (this.sequences.get(request.id) ?? 0) + 1;
    this.sequences.set(request.id, seq);
    request.socket.send(JSON.stringify({ type: 'event', event: 'agent', payload: {
      runId: request.params.idempotencyKey, sessionKey: request.params.sessionKey,
      seq, ts: Date.now(), stream: 'assistant', data, ...overrides,
    } }));
  }

  accept(request: Request, extra: Record<string, unknown> = {}): void {
    this.reply(request, { status: 'accepted', runId: request.params.idempotencyKey,
      sessionKey: request.params.sessionKey, acceptedAt: Date.now(), ...extra });
  }

  finish(request: Request, text: string, extra: Record<string, unknown> = {}): void {
    this.reply(request, { status: 'ok', runId: request.params.idempotencyKey,
      summary: 'completed', result: { payloads: [{ text }] }, ...extra });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) { socket.terminate(); }
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

function client(fixture: Fixture): OpenClawGateway {
  const gateway = new OpenClawGateway(fixture.url);
  gateways.push(gateway);
  return gateway;
}

async function ready(): Promise<{ fixture: Fixture; gateway: OpenClawGateway }> {
  const fixture = await new Fixture().listen();
  const gateway = client(fixture);
  expect(await bounded(gateway.connect())).toBe(true);
  return { fixture, gateway };
}

function collect(iterator: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const result = (async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) { chunks.push(chunk); }
    return chunks;
  })();
  void result.catch(() => { /* The test observes rejection through bounded(). */ });
  return result;
}

function text(chunks: StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content ?? '').join('');
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) { gateway.disconnect(); }
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});

describe('OpenClaw gateway over real WebSockets', () => {
  it('coalesces concurrent connection callers and negotiates the installed protocol', async () => {
    const fixture = await new Fixture({ autoHello: false }).listen();
    const gateway = client(fixture);
    const first = gateway.connect();
    const second = gateway.connect();
    expect(first).toBe(second);
    const request = await fixture.request('connect');
    expect(fixture.sockets).toHaveLength(1);
    expect(request.params).toMatchObject({ minProtocol: 3, maxProtocol: 4, caps: ['tool-events'] });
    expect(gateway.isConnected()).toBe(false);
    fixture.reply(request, hello());
    expect(await bounded(first)).toBe(true);
    expect(await bounded(second)).toBe(true);
  });

  it('ignores malformed frames before and after the hello', async () => {
    const fixture = await new Fixture({ challenge: false }).listen();
    const gateway = client(fixture);
    const connection = gateway.connect();
    const socket = await eventually(() => fixture.sockets[0], 'socket');
    for (const value of ['{', 'null', '[]', '"text"']) { socket.send(value); }
    fixture.challenge(socket);
    expect(await bounded(connection)).toBe(true);
    for (const value of ['null', '[]', '{"type":"event","event":"agent","payload":null}']) { socket.send(value); }
    const response = gateway.sendAgentTask('fixture task', 'fixture-session');
    const request = await fixture.request('chat.send');
    fixture.reply(request, { status: 'accepted', runId: request.params.idempotencyKey });
    expect(await bounded(response)).toBe(true);
  });

  it.each([3, 4])('accepts an explicitly supported protocol %s hello', async protocol => {
    const fixture = await new Fixture({ autoHello: false }).listen();
    const gateway = client(fixture);
    const connection = gateway.connect();
    fixture.reply(await fixture.request('connect'), hello(protocol));
    expect(await bounded(connection)).toBe(true);
  });

  it.each([{ type: 'hello-ok', protocol: 5 }, { type: 'unrecognized', protocol: 4 }])(
    'rejects unsupported hello %j without leaving connection callers pending', async payload => {
      const fixture = await new Fixture({ autoHello: false }).listen();
      const gateway = client(fixture);
      const connection = gateway.connect();
      fixture.reply(await fixture.request('connect'), payload);
      expect(await bounded(connection)).toBe(false);
      expect(gateway.isConnected()).toBe(false);
    },
  );

  it('isolates two sessions, including valid pre-ack events and unrelated or missing run IDs', async () => {
    const { fixture, gateway } = await ready();
    const a = collect(gateway.sendAgentMessage('A', { sessionKey: 'panel-a' }));
    const b = collect(gateway.sendAgentMessage('B', { sessionKey: 'panel-b' }));
    const ar = await fixture.request('agent', r => r.params.message === 'A');
    const br = await fixture.request('agent', r => r.params.message === 'B');
    expect(ar.params.idempotencyKey).not.toBe(br.params.idempotencyKey);
    fixture.event(ar, { delta: 'wrong', text: 'wrong' }, { runId: 'unrelated' });
    fixture.event(ar, { delta: 'missing', text: 'missing' }, { runId: undefined });
    fixture.event(ar, { delta: 'A', text: 'A' });
    fixture.event(br, { delta: 'B', text: 'B' });
    fixture.accept(ar, { sessionKey: 'agent:main:panel-a' });
    fixture.accept(br, { sessionKey: 'agent:main:panel-b' });
    fixture.finish(br, 'B');
    fixture.finish(ar, 'A');
    expect(text(await bounded(a))).toBe('A');
    expect(text(await bounded(b))).toBe('B');
  });

  it('extracts a nested final-only reply and does not render the completion summary', async () => {
    const { fixture, gateway } = await ready();
    const output = collect(gateway.sendAgentMessage('final only'));
    const request = await fixture.request('agent');
    fixture.finish(request, 'Only the answer');
    expect(text(await bounded(output))).toBe('Only the answer');
  });

  it('reports acceptance once, only for the matching accepted run and canonical session', async () => {
    const { fixture, gateway } = await ready();
    const accepted: string[] = [];
    const output = collect(gateway.sendAgentMessage('acceptance hook', {
      sessionKey: 'requested', onAccepted: key => { accepted.push(key); },
    }));
    const request = await fixture.request('agent');
    fixture.reply(request, { status: 'accepted', sessionKey: 'missing-run' });
    fixture.accept(request, { runId: 'unrelated', sessionKey: 'wrong-run' });
    fixture.reply(request, { status: 'pending', runId: request.params.idempotencyKey });
    fixture.accept(request, { sessionKey: 'agent:main:requested' });
    fixture.accept(request, { sessionKey: 'agent:main:requested' });
    fixture.finish(request, 'accepted answer');
    expect(text(await bounded(output))).toBe('accepted answer');
    expect(accepted).toEqual(['agent:main:requested']);
  });

  it('isolates an acceptance callback failure and aborts only its run', async () => {
    const { fixture, gateway } = await ready();
    const failed = collect(gateway.sendAgentMessage('failing hook', {
      sessionKey: 'failing', onAccepted: () => { throw new Error('fixture hook failed'); },
    }));
    const other = collect(gateway.sendAgentMessage('other hook', { sessionKey: 'other' }));
    const request = await fixture.request('agent', item => item.params.message === 'failing hook');
    const otherRequest = await fixture.request('agent', item => item.params.message === 'other hook');
    fixture.accept(request, { sessionKey: 'agent:main:failing' });
    expect((await bounded(failed)).some(chunk => chunk.type === 'error' && chunk.content === 'fixture hook failed')).toBe(true);
    expect((await fixture.request('sessions.abort')).params).toEqual({
      key: 'agent:main:failing', runId: request.params.idempotencyKey,
    });
    fixture.finish(otherRequest, 'other survived');
    expect(text(await bounded(other))).toBe('other survived');
  });

  it('does not duplicate streamed text when the final response repeats it', async () => {
    const { fixture, gateway } = await ready();
    const output = collect(gateway.sendAgentMessage('streamed'));
    const request = await fixture.request('agent');
    fixture.accept(request);
    fixture.event(request, { delta: 'hello ', text: 'hello ' });
    fixture.event(request, { delta: 'world', text: 'hello world' }, { seq: 2 });
    fixture.finish(request, 'hello world');
    expect(text(await bounded(output))).toBe('hello world');
  });

  it('does not finish on transient lifecycle or sequence-gap events', async () => {
    const { fixture, gateway } = await ready();
    const output = collect(gateway.sendAgentMessage('retry'));
    const request = await fixture.request('agent');
    fixture.accept(request);
    fixture.event(request, { reason: 'seq gap', expected: 1, received: 3 }, { stream: 'error' });
    fixture.event(request, { phase: 'error', error: 'transient fallback' }, { stream: 'lifecycle' });
    fixture.event(request, { phase: 'end', aborted: true }, { stream: 'lifecycle' });
    fixture.event(request, { phase: 'start' }, { stream: 'lifecycle' });
    fixture.event(request, { text: 'Recovered', delta: 'Recovered' });
    fixture.finish(request, 'Recovered');
    expect(text(await bounded(output))).toBe('Recovered');
  });

  it('sends nothing for a signal already aborted before iteration', async () => {
    const { fixture, gateway } = await ready();
    const controller = new AbortController();
    controller.abort();
    expect(await bounded(collect(gateway.sendAgentMessage('cancelled', { signal: controller.signal })))).toEqual([]);
    expect(fixture.requests.filter(request => request.method === 'agent')).toEqual([]);
  });

  it('repeats a pre-ack abort using the accepted target and protects a replacement in the same session', async () => {
    const { fixture, gateway } = await ready();
    const controller = new AbortController();
    const oldOutput = collect(gateway.sendAgentMessage('old', { sessionKey: 'panel', signal: controller.signal }));
    const old = await fixture.request('agent', request => request.params.message === 'old');
    controller.abort();
    const firstAbort = await fixture.request('sessions.abort');
    expect(firstAbort.params).toEqual({ key: 'panel', runId: old.params.idempotencyKey });
    await bounded(oldOutput);
    const nextOutput = collect(gateway.sendAgentMessage('replacement', { sessionKey: 'panel' }));
    const next = await fixture.request('agent', request => request.params.message === 'replacement');
    fixture.accept(old, { sessionKey: 'global', agentId: 'main' });
    const repeated = await fixture.request('sessions.abort', request => request.id !== firstAbort.id);
    expect(repeated.params).toEqual({ key: 'global', runId: old.params.idempotencyKey, agentId: 'main' });
    fixture.event(old, { text: 'stale', delta: 'stale' });
    fixture.finish(old, 'stale');
    fixture.accept(next);
    fixture.finish(next, 'replacement answer');
    expect(text(await bounded(nextOutput))).toBe('replacement answer');
    expect(fixture.requests.filter(request => request.method === 'sessions.abort')
      .every(request => request.params.runId === old.params.idempotencyKey)).toBe(true);
  });

  it('cancels only the requested active session', async () => {
    const { fixture, gateway } = await ready();
    const a = collect(gateway.sendAgentMessage('A', { sessionKey: 'panel-a' }));
    const b = collect(gateway.sendAgentMessage('B', { sessionKey: 'panel-b' }));
    const ar = await fixture.request('agent', request => request.params.message === 'A');
    const br = await fixture.request('agent', request => request.params.message === 'B');
    gateway.cancelSession('panel-a');
    expect((await fixture.request('sessions.abort')).params).toEqual({ key: 'panel-a', runId: ar.params.idempotencyKey });
    await bounded(a);
    fixture.finish(br, 'B survives');
    expect(text(await bounded(b))).toBe('B survives');
  });

  it.each(['panel-alias', 'agent:main:panel-alias'])('cancels an acknowledged run by session alias %s', async alias => {
    const { fixture, gateway } = await ready();
    const iterator = gateway.sendAgentMessage('canonical alias', { sessionKey: 'panel-alias' });
    const first = iterator.next();
    const request = await fixture.request('agent');
    fixture.accept(request, { sessionKey: 'agent:main:panel-alias' });
    fixture.event(request, { text: 'ready', delta: 'ready' }, { sessionKey: 'agent:main:panel-alias' });
    expect((await bounded(first)).value).toMatchObject({ type: 'text', content: 'ready' });
    gateway.cancelSession(alias);
    expect((await fixture.request('sessions.abort')).params).toEqual({
      key: 'agent:main:panel-alias', runId: request.params.idempotencyKey,
    });
    expect(await bounded(collect(iterator))).toEqual([]);
  });

  it('times out a completely silent run and sends a targeted remote abort', async () => {
    const { fixture, gateway } = await ready();
    const output = collect(gateway.sendAgentMessage('silent', { sessionKey: 'silent-panel', timeoutMs: 60 }));
    const request = await fixture.request('agent');
    const chunks = await bounded(output);
    expect(chunks.some(chunk => chunk.type === 'error' && /timed? ?out|timeout/i.test(chunk.content ?? ''))).toBe(true);
    expect((await fixture.request('sessions.abort')).params).toEqual({ key: 'silent-panel', runId: request.params.idempotencyKey });
  });

  it('repeats cancellation if a timed-out run is accepted after its first abort found no active run', async () => {
    const { fixture, gateway } = await ready();
    const output = collect(gateway.sendAgentMessage('late after timeout', { sessionKey: 'timed-out', timeoutMs: 40 }));
    const request = await fixture.request('agent');
    await bounded(output);
    const firstAbort = await fixture.request('sessions.abort');
    fixture.accept(request, { sessionKey: 'agent:main:timed-out' });
    const repeated = await fixture.request('sessions.abort', item => item.id !== firstAbort.id);
    expect(repeated.params).toEqual({ key: 'agent:main:timed-out', runId: request.params.idempotencyKey });
  });

  it('repeats cancellation when acceptance arrives while the consumer is paused at a yielded chunk', async () => {
    const { fixture, gateway } = await ready();
    const controller = new AbortController();
    const iterator = gateway.sendAgentMessage('paused reader', { sessionKey: 'paused', signal: controller.signal });
    try {
      const next = iterator.next();
      const request = await fixture.request('agent');
      fixture.event(request, { text: 'partial', delta: 'partial' });
      expect((await bounded(next)).value).toMatchObject({ type: 'text', content: 'partial' });
      controller.abort();
      const firstAbort = await fixture.request('sessions.abort');
      fixture.accept(request, { sessionKey: 'agent:main:paused' });
      const repeated = await fixture.request('sessions.abort', item => item.id !== firstAbort.id);
      expect(repeated.params).toEqual({ key: 'agent:main:paused', runId: request.params.idempotencyKey });
    } finally { await bounded(iterator.return(undefined)); }
  });

  it('return wakes an outstanding next and cancels its remote run', async () => {
    const { fixture, gateway } = await ready();
    const iterator = gateway.sendAgentMessage('abandoned reader', { sessionKey: 'abandoned' });
    const next = iterator.next();
    const request = await fixture.request('agent');
    const returned = iterator.return(undefined);
    const settled = await bounded(Promise.all([next, returned]));
    expect(settled.every(value => value.done)).toBe(true);
    expect((await fixture.request('sessions.abort')).params).toEqual({ key: 'abandoned', runId: request.params.idempotencyKey });
  });

  it('throw cancels a paused reader while preserving the injected error', async () => {
    const { fixture, gateway } = await ready();
    const iterator = gateway.sendAgentMessage('throwing reader', { sessionKey: 'throwing' });
    const next = iterator.next();
    const request = await fixture.request('agent');
    fixture.event(request, { text: 'partial', delta: 'partial' });
    await bounded(next);
    const injected = new Error('consumer stopped with an error');
    await expect(bounded(iterator.throw(injected))).rejects.toBe(injected);
    expect((await fixture.request('sessions.abort')).params).toEqual({ key: 'throwing', runId: request.params.idempotencyKey });
  });

  it.each(['peer-close', 'shutdown', 'disconnect'] as const)('wakes all silent readers on %s', async mode => {
    const { fixture, gateway } = await ready();
    const a = collect(gateway.sendAgentMessage('A', { sessionKey: 'a' }));
    const b = collect(gateway.sendAgentMessage('B', { sessionKey: 'b' }));
    await fixture.request('agent', request => request.params.message === 'B');
    if (mode === 'peer-close') { fixture.sockets[0].terminate(); }
    else if (mode === 'shutdown') {
      fixture.sockets[0].send(JSON.stringify({ type: 'event', event: 'shutdown', payload: { reason: 'fixture restart' } }));
    } else { gateway.disconnect(); }
    for (const output of await bounded(Promise.all([a, b]))) {
      expect(output.some(chunk => chunk.type === 'error')).toBe(true);
    }
    expect(gateway.isConnected()).toBe(false);
    if (mode === 'disconnect') { expect(await gateway.connect()).toBe(false); }
  });

  it('cannot adopt a late hello from the old socket after changing URL', async () => {
    const old = await new Fixture({ autoHello: false }).listen();
    const next = await new Fixture({ autoHello: false }).listen();
    const gateway = client(old);
    const oldConnection = gateway.connect();
    const oldHello = await old.request('connect');
    old.reply(oldHello, hello());
    gateway.setUrl(next.url);
    const newConnection = gateway.connect();
    expect(await bounded(oldConnection)).toBe(false);
    const newHello = await next.request('connect');
    expect(gateway.isConnected()).toBe(false);
    next.reply(newHello, hello());
    expect(await bounded(newConnection)).toBe(true);
    const task = gateway.sendAgentTask('new endpoint');
    const request = await next.request('chat.send');
    next.reply(request, { status: 'accepted' });
    expect(await bounded(task)).toBe(true);
    expect(old.requests.some(request => request.method === 'chat.send')).toBe(false);
  });

  it.each(['accepted', 'pending', 'running', 'in_flight'])('resolves one-response channel RPC status %s', async status => {
    const { fixture, gateway } = await ready();
    const delegated = gateway.sendAgentTask('delegate', 'channel-panel');
    fixture.reply(await fixture.request('chat.send'), { status, runId: 'channel-run' });
    expect(await bounded(delegated)).toBe(true);
    const delivered = gateway.sendToChannel('fixture-channel', 'hello', 'fixture-target');
    fixture.reply(await fixture.request('send'), { status });
    expect(await bounded(delivered)).toBe(true);
  });
});
