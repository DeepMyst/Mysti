import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'http';
import type { SecretStorage } from 'vscode';
import type { Settings, StreamChunk } from '../../../src/types';
import { OpenCodeRemote, remoteConnection, type RemoteConnection } from '../../../src/providers/opencode/OpenCodeRemote';
import * as abortScopes from '../../../src/utils/abortScope';

type Cleanup = 'ok' | 'fail' | 'hang' | 'hold-delete';
interface Session { id: string; directory: string; username: string; cleanup: Cleanup; hold?: boolean; messages: number }
interface Options { cleanup?: Cleanup; hold?: boolean; id?: string }
async function fixture(prefix: string) {
  let sequence = 0;
  const sessions = new Map<string, Session>(), options: Options[] = [];
  const calls: Array<{ method: string; route: string; directory: string; username: string }> = [];
  const messages = new Set<string>(), deletes = new Map<string, ServerResponse>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://owned'), directory = url.searchParams.get('directory') || '';
    const username = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':')[0];
    const route = url.pathname, method = req.method!;
    calls.push({ method, route, directory, username });
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (method === 'POST' && route === '/session') {
      const next = options.shift() || {}, id = next.id || `${prefix}-${++sequence}`;
      if (!sessions.has(id)) sessions.set(id, { id, directory, username, cleanup: next.cleanup || 'ok', hold: next.hold, messages: 0 });
      res.end(JSON.stringify({ id, permission: body.permission })); return;
    }
    if (route === '/event') { res.setHeader('Content-Type', 'text/event-stream'); res.write(': ready\n\n'); return; }
    const id = route.split('/')[2], session = sessions.get(id);
    if (!session) { res.writeHead(404); res.end('{}'); return; }
    if (session.directory !== directory || session.username !== username) { res.writeHead(403); res.end('{}'); return; }
    if (route.endsWith('/message')) {
      session.messages++; messages.add(id);
      if (!session.hold || session.messages > 1) res.end(JSON.stringify({ parts: [{ id: 'answer', type: 'text', text: 'Owned answer' }] }));
      return;
    }
    if (session.cleanup === 'hang') return;
    if (session.cleanup === 'fail') { res.writeHead(503); res.end('{}'); return; }
    if (method === 'DELETE') {
      if (session.cleanup === 'hold-delete') { deletes.set(id, res); return; }
      sessions.delete(id);
    }
    res.end('true');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = remoteConnection(`http://127.0.0.1:${(server.address() as { port: number }).port}`, '/owned', 'owned-user');
  return { server, connection, sessions, calls, messages, options, deletes,
    finishDelete(id: string) { sessions.delete(id); deletes.get(id)?.end('true'); deletes.delete(id); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let a: Fixture, b: Fixture, remote: OpenCodeRemote, jobs: Array<Promise<StreamChunk[]>>;
let getSecret: ReturnType<typeof vi.fn<() => Promise<string>>>;
const settings = { mode: 'ask-before-edit', accessLevel: 'ask-permission' } as Settings;
function collect(connection = a.connection, panel = 'owned-panel') {
  const operation = (async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of remote.send(connection, panel, settings, async () => 'Hello', 'owned/model')) chunks.push(chunk);
    return chunks;
  })(); jobs.push(operation); return operation;
}
const cleanupCalls = (f: Fixture, id: string) => f.calls.filter(c => c.route === `/session/${id}/abort` || c.method === 'DELETE' && c.route === `/session/${id}`);
async function leaveRetired() {
  a.options.push({ cleanup: 'fail' }); const chunks = await collect();
  expect(chunks.at(-1)?.type).toBe('done');
  const session = [...a.sessions.values()].at(-1)!; expect(session).toBeDefined(); return session;
}
beforeEach(async () => {
  a = await fixture('a'); b = await fixture('b'); jobs = [];
  getSecret = vi.fn(async () => 'owned-password');
  remote = new OpenCodeRemote({ get: getSecret } as unknown as SecretStorage);
});
afterEach(async () => {
  for (const f of [a, b]) {
    for (const s of f.sessions.values()) s.cleanup = 'ok';
    for (const id of f.deletes.keys()) f.finishDelete(id);
  }
  remote.cancel(); for (const f of [a, b]) f.server.closeAllConnections();
  await Promise.allSettled(jobs);
  for (const f of [a, b]) { f.server.closeAllConnections(); await new Promise<void>(resolve => f.server.close(() => resolve())); }
  vi.restoreAllMocks();
});

describe('owned OpenCode remote session cleanup after recovery', () => {
  it('retries a retired session after recovery and leaves another client session alone', async () => {
    const old = await leaveRetired(); old.cleanup = 'ok';
    a.sessions.set('foreign', { ...old, id: 'foreign' });
    expect((await collect()).at(-1)?.type).toBe('done');
    expect([...a.sessions.keys()]).toEqual(['foreign']);
    expect(a.calls.some(c => c.route.includes('foreign'))).toBe(false);
    expect(a.calls.some(c => c.method === 'GET' && c.route === '/session')).toBe(false);
  });
  it.each(['endpoint', 'directory', 'username'] as const)('isolates retired cleanup by %s, including mutable caller configuration', async field => {
    const original = { ...a.connection }, old = await leaveRetired(); old.cleanup = 'ok';
    const before = cleanupCalls(a, old.id).length;
    a.connection[field] = field === 'endpoint' ? b.connection.endpoint : 'other-owned-value';
    expect((await collect()).at(-1)?.type).toBe('done');
    expect(cleanupCalls(a, old.id)).toHaveLength(before); expect(a.sessions.has(old.id)).toBe(true);
    expect((await collect(original)).at(-1)?.type).toBe('done'); expect(a.sessions.has(old.id)).toBe(false);
  });
  it('retires an already-deleted session after a 404 instead of retrying forever', async () => {
    const old = await leaveRetired(); a.sessions.delete(old.id);
    const before = cleanupCalls(a, old.id).length;
    await collect(); const after = cleanupCalls(a, old.id).length; expect(after).toBeGreaterThan(before);
    await collect(); expect(cleanupCalls(a, old.id)).toHaveLength(after);
  });
  it('does not clean up another panel while that request is active', async () => {
    a.options.push({ hold: true }); const active = collect(a.connection, 'active-panel');
    await vi.waitFor(() => expect(a.messages.size).toBe(1)); const id = [...a.messages][0];
    await collect(a.connection, 'other-panel'); expect(cleanupCalls(a, id)).toEqual([]); expect(a.sessions.has(id)).toBe(true);
    remote.cancel('active-panel'); await active; expect(a.sessions.has(id)).toBe(false);
  });
  it('deduplicates concurrent retries before allowing both new turns to proceed', async () => {
    const old = await leaveRetired(); old.cleanup = 'hold-delete';
    const before = cleanupCalls(a, old.id).length;
    const first = collect(a.connection, 'first');
    await vi.waitFor(() => expect(a.deletes.has(old.id)).toBe(true));
    const second = collect(a.connection, 'second'); await new Promise(resolve => setTimeout(resolve, 20));
    expect(cleanupCalls(a, old.id)).toHaveLength(before + 2);
    a.finishDelete(old.id); const result = await Promise.all([first, second]);
    expect(result.every(chunks => chunks.at(-1)?.type === 'done')).toBe(true); expect(a.sessions.size).toBe(0);
  });
  it('bounds a hung retry and still permits a new turn, then cleans it on later recovery', async () => {
    const old = await leaveRetired(); old.cleanup = 'hang';
    const scope = abortScopes.createAbortScope, deadlines: Array<number | undefined> = [];
    vi.spyOn(abortScopes, 'createAbortScope').mockImplementation((signals, ms) => { deadlines.push(ms); return scope(signals, ms === 5000 ? 50 : ms); });
    const before = cleanupCalls(a, old.id).length;
    expect((await collect()).at(-1)?.type).toBe('done');
    expect(deadlines).toContain(5000); expect(cleanupCalls(a, old.id).length).toBeGreaterThan(before); expect(a.sessions.has(old.id)).toBe(true);
    old.cleanup = 'ok'; await collect(); expect(a.sessions.has(old.id)).toBe(false);
  });
  it('honors Stop during retry without creating a new remote session', async () => {
    const old = await leaveRetired(); old.cleanup = 'hang';
    const creates = a.calls.filter(c => c.method === 'POST' && c.route === '/session').length;
    const before = cleanupCalls(a, old.id).length, pending = collect(a.connection, 'stopped');
    await vi.waitFor(() => expect(cleanupCalls(a, old.id).length).toBeGreaterThan(before));
    remote.cancel('stopped'); expect(await pending).toEqual([]);
    expect(a.calls.filter(c => c.method === 'POST' && c.route === '/session')).toHaveLength(creates);
    old.cleanup = 'ok'; await collect(); expect(a.sessions.has(old.id)).toBe(false);
  });
  it('refuses a server-reused active ID without aborting the existing panel', async () => {
    a.options.push({ hold: true }); const active = collect(a.connection, 'active');
    await vi.waitFor(() => expect(a.messages.size).toBe(1)); const id = [...a.messages][0];
    a.options.push({ id }); const reused = await collect(a.connection, 'reused');
    expect(reused.map(c => c.type)).toEqual(['error']); expect(reused[0].content).toContain('reused');
    expect(cleanupCalls(a, id)).toEqual([]); expect(a.sessions.has(id)).toBe(true);
    remote.cancel('active'); await active;
  });
  it('limits each recovery batch and drains the remaining retired sessions on a later turn', async () => {
    const retired: Session[] = []; for (let i = 0; i < 9; i++) retired.push(await leaveRetired());
    for (const old of retired) old.cleanup = 'ok';
    await collect();
    expect(retired.filter(old => a.sessions.has(old.id))).toHaveLength(1);
    await collect(); expect(a.sessions.size).toBe(0);
  });
  it('bounds a stalled credential lookup and prevents its late completion from dispatching cleanup', async () => {
    const old = await leaveRetired(); old.cleanup = 'ok';
    let release!: (value: string) => void;
    getSecret.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const scope = abortScopes.createAbortScope;
    vi.spyOn(abortScopes, 'createAbortScope').mockImplementation((signals, ms) => scope(signals, ms === 5000 ? 50 : ms));
    const before = cleanupCalls(a, old.id).length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([collect(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Credential lookup outlived the cleanup deadline')), 1000);
      })]);
      expect(result.at(-1)?.type).toBe('done');
    } finally { clearTimeout(timer); release('owned-password'); }
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cleanupCalls(a, old.id)).toHaveLength(before);
    expect(a.sessions.has(old.id)).toBe(true);
    await collect(); expect(a.sessions.has(old.id)).toBe(false);
  });
});
