import { expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { ProviderManager } from '../../../src/managers/ProviderManager';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
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
  enhance(): Promise<string>;
  ack(key: string): Promise<Run>; event(r: Run, payload: object, event?: string, seq?: number): void; finish(r: Run, text?: string): void;
  requests: any[]; sockets: WebSocket[]; challenge(socket: WebSocket): void; url: string;
}) => Promise<void>, options: { holdChallenge?: boolean; sign?: () => Promise<any>; publicProvider?: boolean; appendOnlyManager?: boolean } = {}) {
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
  const manager = Object.create(ProviderManager.prototype) as any;
  manager._getActiveProvider = () => provider; manager._panelProviders = new Map();
  let serverClosed = false;
  try {
    expect((gateway as any)._url).toBe(url);
    await run({ gateway, requests, sockets, url, challenge,
      enhance: () => { const p = provider!.enhancePrompt('Original draft'); pending.push(p); return p; },
      connect: () => { const p = gateway.connect(); pending.push(p); const socket = (gateway as any)._ws; if (socket && !clients.includes(socket)) clients.push(socket); return p; },
      start: key => {
        const selected = options.appendOnlyManager ? manager : provider;
        const stream = selected ? selected.sendMessage('Owned public request', [], { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings, null, undefined, key)
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
    if (process.env.PB07_COMMENTARY_RECEIPT) appendFileSync(process.env.PB07_COMMENTARY_RECEIPT, JSON.stringify({ serverClosed,
      allSocketsClosed: [...clients, ...sockets].every(s => s.readyState === WebSocket.CLOSED), errors,
      pendingRequests: (gateway as any)._pendingRequests.size, agentRuns: (gateway as any)._agentRuns.size,
      methods: requests.map(r => r.method), nativeGatewayRequests: 0, nativeCliInvocations: 0, paidRequests: 0 }) + '\n');
    vi.restoreAllMocks(); clearMockConfig();
  }
}
const replyText = (chunks: StreamChunk[]) => chunks.filter(c => c.type === 'text').map(c => c.content || '').join('');
const progress = (chunks: StreamChunk[]) => chunks.filter(c => (c.type as string) === 'progress').map(c => c.content);
const assistant = (text: string, extra: object = {}) => ({ stream: 'assistant', data: { text, ...extra } });

it.each(['direct', 'message', 'partial', 'item', 'signature'])('keeps %s commentary out of the answer and delivers the final envelope', async shape => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    const phase = shape === 'direct' ? { phase: 'commentary' } : shape === 'signature'
      ? { content: [{ type: 'text', textSignature: JSON.stringify({ v: 1, phase: 'commentary' }) }] }
      : { [shape]: { phase: 'commentary' } };
    f.event(r, assistant('Checking the files', phase)); f.finish(r, 'Actual answer');
    const chunks = await a.result;
    expect(replyText(chunks)).toBe('Actual answer'); expect(progress(chunks)).toEqual(['Checking the files']);
    expect(chunks.some(c => c.type === 'thinking' || c.type === 'error')).toBe(false);
  });
});

it('does not let commentary snapshots or replacements retract an already streamed answer', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, assistant('Answer', { delta: 'Answer', phase: 'final_answer' }));
    f.event(r, assistant('Checking', { replace: true, phase: 'commentary' }));
    f.event(r, assistant('Answer!', { delta: '!', phase: 'final_answer' })); f.finish(r, 'Answer!');
    const chunks = await a.result;
    expect(replyText(chunks)).toBe('Answer!'); expect(chunks.filter(c => c.replace)).toEqual([]);
    expect(progress(chunks)).toEqual(['Checking']);
  });
});

it('streams native preamble/status/plan progress but never invents tool cards from generic items', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    for (const data of [
      { kind: 'preamble', phase: 'update', itemId: 'one', progressText: 'Reading files' },
      { kind: 'preamble', phase: 'update', itemId: 'one', progressText: 'Reading files' },
      { kind: 'status', phase: 'update', title: 'Fast', summary: 'Fast mode enabled' },
      { kind: 'preamble', phase: 'update', progressText: 'Hidden', suppressChannelProgress: true },
      { kind: 'command', phase: 'start', itemId: 'cmd', title: 'Run', name: 'exec', meta: 'Not a tool event' },
    ]) f.event(r, { stream: 'item', data });
    f.event(r, { stream: 'plan', data: { phase: 'update', explanation: 'Check then report', steps: [{ step: 'Read', status: 'in_progress' }] } });
    await vi.waitFor(() => expect(progress(a.chunks)).toHaveLength(3));
    expect(a.chunks.some(c => c.toolCall || c.type === 'text' || c.type === 'thinking')).toBe(false);
    f.finish(r); expect(replyText(await a.result)).toBe('Final reply');
    expect(progress(a.chunks)).toEqual(['Reading files', 'Fast mode enabled', 'Check then report']);
  });
});

it('keeps progress request-local and still yields the final answer through the public manager', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), b = f.start('B'), ar = await f.ack('A'), br = await f.ack('B');
    f.event(ar, assistant('Only A', { phase: 'commentary' })); f.event(br, assistant('Only B', { phase: 'commentary' }));
    await vi.waitFor(() => expect(progress(a.chunks)).toEqual(['Only A']));
    f.finish(ar, 'Answer A'); f.finish(br, 'Answer B');
    expect(replyText(await a.result)).toBe('Answer A'); expect(replyText(await b.result)).toBe('Answer B');
    expect(progress(b.chunks)).toEqual(['Only B']); expect(a.chunks.filter(c => c.type === 'done')).toHaveLength(1);
  }, { publicProvider: true, appendOnlyManager: true });
});

it('filters phased final payloads and preserves only final blocks in a mixed envelope', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    wire(r.socket, { type: 'res', id: r.id, ok: true, payload: { status: 'ok', result: { payloads: [
      { text: 'Private progress', phase: 'commentary' },
      { content: [
        { type: 'text', text: 'More progress', textSignature: '{"v":1,"phase":"commentary"}' },
        { type: 'text', text: 'Actual answer', textSignature: '{"v":1,"phase":"final_answer"}' },
      ] },
    ] } } });
    expect(replyText(await a.result)).toBe('Actual answer');
  });
});

it('reconciles provisional text against only visible terminal payloads', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, assistant('Draft', { delta: 'Draft', replaceable: true }));
    wire(r.socket, { type: 'res', id: r.id, ok: true, payload: { status: 'ok', result: { payloads: [
      { text: 'Progress', phase: 'commentary' }, { text: 'Final', phase: 'final_answer' },
    ] } } });
    const chunks = await a.result;
    const rendered = chunks.filter(c => c.type === 'text').reduce((text, c) => c.replace
      ? text.slice(0, c.replace.start) + c.content + text.slice(c.replace.end) : text + c.content, '');
    expect(rendered).toBe('Final');
  });
});

it('does not replace an enhancement draft with commentary', async () => {
  await fixture(async f => {
    await f.connect(); const pending = f.enhance();
    await vi.waitFor(() => expect(f.requests.some(x => x.method === 'agent')).toBe(true));
    const r = await f.ack(f.requests.find(x => x.method === 'agent').params.sessionKey);
    f.event(r, assistant('Planning a rewrite', { phase: 'commentary' })); f.finish(r, 'Enhanced draft');
    expect(await pending).toBe('Enhanced draft');
  }, { publicProvider: true });
});

it('retains only the error when commentary precedes a failed request, without CLI replay', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, assistant('Looking at files', { phase: 'commentary' }));
    wire(r.socket, { type: 'res', id: r.id, ok: true, payload: { status: 'error', summary: 'Owned failure' } });
    const chunks = await a.result; expect(replyText(chunks)).toBe('');
    expect(chunks.filter(c => c.type === 'error')).toHaveLength(1); expect(progress(chunks)).toEqual(['Looking at files']);
  }, { publicProvider: true });
});

it('accumulates delta-only commentary, deduplicates snapshots, bounds output and redacts request credentials', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, { stream: 'assistant', data: { delta: 'Checking ', phase: 'commentary' } });
    f.event(r, { stream: 'assistant', data: { delta: 'files', phase: 'commentary' } });
    f.event(r, assistant('Checking files', { phase: 'commentary' }));
    f.event(r, { stream: 'item', data: { kind: 'status', phase: 'update', summary: 'Failed: ' + token } });
    f.event(r, { stream: 'item', data: { kind: 'preamble', phase: 'update', progressText: 'x'.repeat(10000) } });
    f.finish(r);
    const chunks = await a.result, statuses = progress(chunks);
    expect(statuses.slice(0, 2)).toEqual(['Checking', 'Checking files']); expect(statuses).toHaveLength(4);
    expect(statuses.join('')).not.toContain(token); expect(statuses.at(-1)).toHaveLength(2000);
    expect(replyText(chunks)).toBe('Final reply');
  });
});

it.each(['legacy', 'commentary', 'final_answer'])('handles a direct final %s envelope', async phase => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    wire(r.socket, { type: 'res', id: r.id, ok: true, payload: { status: 'ok', text: 'Envelope text', phase } });
    expect(replyText(await a.result)).toBe(phase === 'commentary' ? '' : 'Envelope text');
  });
});

it('reconciles provisional text with the legacy top-level final payload list', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, assistant('Draft', { delta: 'Draft', replaceable: true }));
    wire(r.socket, { type: 'res', id: r.id, ok: true, payload: { status: 'ok', payloads: [{ text: 'Final', phase: 'final_answer' }] } });
    expect((await a.result).find(c => c.replace)).toMatchObject({ type: 'text', content: 'Final', replace: { start: 0, end: 5 } });
  });
});

it.each(['{bad', 'null', '{"v":2,"phase":"commentary"}', '{"v":1,"phase":"unknown"}'])('keeps legacy text for an unrecognized signature %s', async textSignature => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, assistant('Legacy answer', { content: [{ type: 'text', textSignature }] })); f.finish(r);
    const chunks = await a.result; expect(replyText(chunks)).toBe('Legacy answer'); expect(progress(chunks)).toEqual([]);
  });
});

it('ignores foreign and late progress without contaminating the next run', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, { ...assistant('Foreign', { phase: 'commentary' }), runId: 'other-run' });
    f.event(r, assistant('Owned progress', { phase: 'commentary' })); f.finish(r, 'First answer');
    expect(progress(await a.result)).toEqual(['Owned progress']);
    f.event(r, assistant('Late progress', { phase: 'commentary' }));
    const b = f.start('B'), br = await f.ack('B');
    f.event(r, assistant('Still late', { phase: 'commentary' }));
    f.event(br, assistant('Fresh progress', { phase: 'commentary' })); f.finish(br, 'Second answer');
    expect(progress(await b.result)).toEqual(['Fresh progress']); expect(replyText(b.chunks)).toBe('Second answer');
  });
});

it('redacts a credential before truncating a long commentary snapshot', async () => {
  await fixture(async f => {
    await f.connect(); const a = f.start('A'), r = await f.ack('A');
    f.event(r, assistant('a'.repeat(1995) + token, { phase: 'commentary' })); f.finish(r);
    const text = progress(await a.result).join(''); expect(text).not.toContain(token.slice(0, 5));
  });
});
