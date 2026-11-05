import { expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import type { StreamChunk } from '../../../src/types';

// Shapes reviewed against OpenClaw2026.6.34's selection/agent/server-chat
// modules. This is an owned wire fixture, not an installed gateway invocation.
const TOKEN = 'owned-native-events-token';
const send = (socket: WebSocket, value: unknown) => socket.send(JSON.stringify(value));
type Plan = { events?: Record<string, unknown>[]; preAckEvents?: Record<string, unknown>[]; final?: Record<string, unknown>; ok?: boolean; requireCap?: boolean; interleave?: boolean };
async function fixture(run: (f: {
  collect(key: string, plan: Plan): Promise<StreamChunk[]>; gateway: OpenClawGateway; requests: any[];
}) => Promise<void>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = new OpenClawGateway(url, TOKEN);
  const requests: any[] = [], sockets: WebSocket[] = [], errors: string[] = [], plans = new Map<string, Plan>();
  const streams: AsyncGenerator<StreamChunk>[] = [], pending: Promise<StreamChunk[]>[] = [];
  let serverClosed = false;
  const interleaved: Array<{ start(): void; event(index: number): void; end(): void; count: number }> = [];
  server.on('connection', socket => {
    sockets.push(socket); let caps: string[] = [];
    socket.on('error', error => { errors.push(error.message); });
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString()); requests.push(frame);
        if (frame.method === 'connect') {
          caps = frame.params.caps;
          send(socket, { type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } });
        } else if (frame.method === 'agent') {
          const key = frame.params.sessionKey, runId = `run-${key}`, plan = plans.get(key)!;
          const job = {
            count: plan.events?.length || 0,
            start: () => {
              for (const event of plan.preAckEvents || []) send(socket, { type: 'event', event: 'agent', payload: { sessionKey: key, ...event } });
              send(socket, { type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', runId } });
            },
            event: (index: number) => {
              const event = plan.events?.[index]; if (!event) return;
              if (event.stream === 'tool' && plan.requireCap && !caps.includes('tool-events')) return;
              const { eventName, ...payload } = event;
              send(socket, { type: 'event', event: eventName || 'agent', payload: { sessionKey: key, runId, ...payload } });
            },
            end: () => send(socket, { type: 'res', id: frame.id, ok: plan.ok ?? true,
              payload: { runId, status: 'ok', result: { payloads: [] }, ...plan.final },
              ...(plan.ok === false ? { error: { message: `Final failure ${TOKEN}` } } : {}) }),
          };
          if (plan.interleave) {
            interleaved.push(job);
            if (interleaved.length === 2) {
              for (const j of interleaved) j.start();
              for (let i = 0; i < Math.max(...interleaved.map(j => j.count)); i++) for (const j of interleaved) j.event(i);
              for (const j of interleaved) j.end();
            }
          } else { job.start(); for (let i = 0; i < job.count; i++) job.event(i); job.end(); }
        } else send(socket, { type: 'res', id: frame.id, ok: true });
      } catch (error) { errors.push(String(error)); }
    });
    send(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-native-event-challenge' } });
  });
  try {
    expect((gateway as any)._url).toBe(url);
    const connecting = gateway.connect(); sockets.push((gateway as any)._ws);
    expect(await connecting).toBe(true);
    await run({ gateway, requests, collect: (key, plan) => {
      plans.set(key, plan);
      const stream = gateway.sendAgentMessage('Owned wire request', { sessionKey: key }); streams.push(stream);
      const result = (async () => { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; })();
      pending.push(result); return result;
    } });
    expect((gateway as any)._agentRuns.size).toBe(0);
    expect((gateway as any)._pendingRequests.size).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    gateway.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; if (error) reject(error); else resolve(); }));
    await vi.waitFor(() => expect(sockets.every(s => s.readyState === WebSocket.CLOSED)).toBe(true));
    await Promise.allSettled(pending);
    for (const stream of streams) await stream.return(undefined as never);
    if (process.env.PB07_NATIVE_EVENTS_RECEIPT) appendFileSync(process.env.PB07_NATIVE_EVENTS_RECEIPT,
      JSON.stringify({ serverClosed, allSocketsClosed: sockets.every(s => s.readyState === WebSocket.CLOSED),
        methods: requests.map(r => r.method), errors, nativeGatewayRequests: 0 }) + '\n');
  }
}
const tool = (phase: string, data: Record<string, unknown> = {}) => ({ stream: 'tool', data: { phase, toolCallId: 'owned-tool', ...data } });
const lifecycle = (phase: string, data: Record<string, unknown> = {}) => ({ stream: 'lifecycle', data: { phase, ...data } });
const reply = (text: string) => ({ stream: 'assistant', data: { delta: text } });
const content = (text: string) => ({ content: [{ type: 'text', text }] });

it('subscribes to native tool events and renders an actual start/result pair', async () => {
  await fixture(async f => {
    const chunks = await f.collect('subscription', { requireCap: true, events: [
      tool('start', { name: 'read', args: { path: 'owned.txt' } }), tool('result', { name: 'read', result: content('File text'), isError: false }),
    ] });
    expect(f.requests[0].params.caps).toContain('tool-events');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ type: 'tool_use', toolCall: { id: 'owned-tool', name: 'read', input: { path: 'owned.txt' }, status: 'running', kind: 'read' } });
    expect(chunks[1]).toMatchObject({ type: 'tool_result', toolCall: { id: 'owned-tool', name: 'read', input: { path: 'owned.txt' }, output: 'File text', status: 'completed', kind: 'read' } });
  });
});

it('keeps partial native output running and joins only text result blocks', async () => {
  await fixture(async f => {
    const chunks = await f.collect('updates', { events: [
      tool('start', { name: 'exec', args: { command: 'owned-command' } }),
      tool('update', { partialResult: content('Still running') }),
      tool('result', { result: { content: [{ type: 'text', text: 'First' }, { type: 'image', data: 'owned-image-data' }, { type: 'text', text: 'Second' }] } }),
    ] });
    expect(chunks).toHaveLength(3);
    expect(chunks[1]).toMatchObject({ type: 'tool_use', toolCall: { name: 'exec', input: { command: 'owned-command' }, output: 'Still running', status: 'running' } });
    expect(chunks[2]).toMatchObject({ type: 'tool_result', toolCall: { name: 'exec', input: { command: 'owned-command' }, output: 'First\nSecond', status: 'completed' } });
  });
});

it('redacts native failed results and retains the started tool identity', async () => {
  await fixture(async f => {
    const chunks = await f.collect('failure', { events: [
      tool('start', { name: 'read', args: { path: 'owned.txt' } }),
      tool('result', { result: content(`Failed ${TOKEN}`), isError: true }),
    ] });
    expect(chunks[1]).toMatchObject({ type: 'tool_result', toolCall: { id: 'owned-tool', name: 'read', input: { path: 'owned.txt' }, output: 'Failed [REDACTED]', status: 'failed' } });
  });
});

it('isolates reused tool ids across concurrent requests and clears completed metadata', async () => {
  await fixture(async f => {
    const [a, b] = await Promise.all(['A', 'B'].map(key => f.collect(key, { interleave: true, events: [
      tool('start', { name: key, args: { owner: key } }),
      tool('result', { result: content(`Result ${key}`) }),
      tool('result', { name: 'untracked', result: content('Later result') }),
    ] })));
    for (const [key, chunks] of [['A', a], ['B', b]] as const) {
      expect(chunks[1]?.toolCall).toMatchObject({ name: key, input: { owner: key }, output: `Result ${key}` });
      expect(chunks[2]?.toolCall).toMatchObject({ name: 'untracked', input: {}, output: 'Later result' });
    }
  });
});

it('does not retain unfinished tool metadata into a later request', async () => {
  await fixture(async f => {
    const first = await f.collect('reuse', { events: [tool('start', { name: 'old', args: { old: true } })] });
    expect(first[0]?.toolCall?.status).toBe('running');
    const next = await f.collect('reuse', { events: [tool('result', { name: 'fresh', result: content('Fresh result') })] });
    expect(next[0]?.toolCall).toMatchObject({ name: 'fresh', input: {}, output: 'Fresh result' });
  });
});

it('retains native semantic kind on updates and handles an omitted result without fake output', async () => {
  await fixture(async f => {
    const chunks = await f.collect('empty', { events: [
      tool('start', { name: 'read', args: { path: 'owned.txt' } }), tool('update', { partialResult: content('Partial') }), tool('result'),
    ] });
    expect(chunks.map(c => c.toolCall?.kind)).toEqual(['read', 'read', 'read']);
    expect(chunks[2]?.toolCall?.output).toBe('');
  });
});

it.each(['tool_result', 'tool.error', 'tool_call', 'step_completed'])('correlates legacy %s completions within the gateway request', async type => {
  await fixture(async f => {
    const end = type === 'tool_result' ? { type, tool_use_id: 'owned-tool', content: 'Done' }
      : type === 'tool.error' ? { type, tool_id: 'owned-tool', error: `Failure ${TOKEN}` }
      : { type, id: 'owned-tool', status: 'completed', output: 'Done' };
    const chunks = await f.collect(type, { events: [
      { type: 'tool_call', id: 'owned-tool', name: 'read', input: { path: 'owned.txt' } }, end,
    ] });
    expect(chunks[1]?.toolCall).toMatchObject({ id: 'owned-tool', name: 'read', input: { path: 'owned.txt' },
      status: type === 'tool.error' ? 'failed' : 'completed', output: type === 'tool.error' ? 'Failure [REDACTED]' : 'Done' });
  });
});

it('ignores foreign-run native tool events even when session keys match', async () => {
  await fixture(async f => {
    const chunks = await f.collect('ownership', { events: [
      { ...tool('start', { name: 'foreign', args: { foreign: true } }), runId: 'other-run' },
      tool('result', { name: 'owned', result: content('Owned result') }),
    ] });
    expect(chunks).toHaveLength(1); expect(chunks[0]?.toolCall).toMatchObject({ name: 'owned', input: {}, output: 'Owned result' });
  });
});

it('does not accept another native run before the request acknowledgement', async () => {
  await fixture(async f => {
    const chunks = await f.collect('pre-ack', { preAckEvents: [
      { ...tool('start', { name: 'foreign', args: { privateForeign: true } }), runId: 'other-run' },
      { ...lifecycle('error', { error: 'Foreign failure' }), runId: 'other-run' },
    ], events: [tool('result', { name: 'owned', result: content('Owned result') })] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.toolCall).toMatchObject({ name: 'owned', input: {}, output: 'Owned result' });
    expect(JSON.stringify(chunks)).not.toContain('Foreign');
  });
});

it('extracts native final response text when no assistant deltas were delivered', async () => {
  await fixture(async f => {
    expect(await f.collect('final-only', { final: { result: { payloads: [{ text: 'First reply' }, { text: 'Second reply' }] } } }))
      .toEqual([{ type: 'text', content: 'First reply' }, { type: 'text', content: 'Second reply' }]);
  });
});

it('does not repeat a streamed reply from the nested final envelope', async () => {
  await fixture(async f => {
    expect(await f.collect('streamed', { events: [reply('Reply')], final: { result: { payloads: [{ text: 'Reply' }] } } }))
      .toEqual([{ type: 'text', content: 'Reply' }]);
  });
});

it.each(['timeout', 'error', 'aborted', 'meta-error', 'payload-error', 'lifecycle-error', 'chat-error'])('surfaces native %s despite a successful RPC envelope', async reason => {
  await fixture(async f => {
    const events: Record<string, unknown>[] = [reply('Partial reply')];
    const final: Record<string, unknown> = {};
    if (reason === 'timeout' || reason === 'error') Object.assign(final, { status: reason, summary: `Failure ${TOKEN}` });
    if (reason === 'aborted') final.result = { meta: { aborted: true }, payloads: [] };
    if (reason === 'meta-error') final.result = { meta: { error: { message: `Failure ${TOKEN}` } }, payloads: [] };
    if (reason === 'payload-error') final.result = { payloads: [{ text: `Failure ${TOKEN}`, isError: true }] };
    if (reason === 'lifecycle-error') events.push(lifecycle('error', { error: `Failure ${TOKEN}` }));
    if (reason === 'chat-error') events.push({ eventName: 'chat', state: 'error', errorMessage: `Failure ${TOKEN}` });
    const chunks = await f.collect(reason, { events, final });
    expect(chunks[0]).toEqual({ type: 'text', content: 'Partial reply' });
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(1);
    expect(JSON.stringify(chunks)).not.toContain(TOKEN);
    expect(typeof chunks.at(-1)?.content).toBe('string');
  });
});

it('preserves useful final-only payload text before a redacted failed payload', async () => {
  await fixture(async f => {
    expect(await f.collect('mixed-final', { final: { result: { payloads: [
      { text: 'Useful partial reply' }, { text: `Failure ${TOKEN}`, isError: true },
    ] } } })).toEqual([
      { type: 'text', content: 'Useful partial reply' }, { type: 'error', content: 'Failure [REDACTED]' },
    ]);
  });
});

it.each(['start', 'end'])('lets native fallback recover after lifecycle error followed by %s', async phase => {
  await fixture(async f => {
    expect(await f.collect('recovered-' + phase, { events: [
      lifecycle('error', { error: 'Temporary model failure' }), lifecycle(phase), reply('Recovered reply'),
    ] })).toEqual([{ type: 'text', content: 'Recovered reply' }]);
  });
});

it('emits one final error when lifecycle, chat and RPC report the same failure', async () => {
  await fixture(async f => {
    const chunks = await f.collect('dedupe', { ok: false, events: [
      lifecycle('error', { error: `Final failure ${TOKEN}` }),
      { eventName: 'chat', state: 'error', errorMessage: `Final failure ${TOKEN}` },
    ] });
    expect(chunks).toEqual([{ type: 'error', content: 'Final failure [REDACTED]' }]);
  });
});
