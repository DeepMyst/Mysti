import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'http';
import type { SecretStorage } from 'vscode';
import type { Settings, StreamChunk } from '../../../src/types';
import { OpenCodeRemote, remoteConnection, remoteSecretKey, type RemoteConnection } from '../../../src/providers/opencode/OpenCodeRemote';
import type { NativeApprovalHost } from '../../../src/providers/base/IProvider';

let server: Server;
let connection: RemoteConnection;
let remote: OpenCodeRemote;
let stream: ServerResponse | undefined;
let message: ServerResponse | undefined;
let permissionReply: string | undefined;
let deleted = 0;
let aborted = 0;
let promptCount = 0;
let acknowledge = true;
let auth = '';
let directory = '';
let status = 200;
const secrets = new Map<string, string>();
const settings = { accessLevel: 'ask-permission', mode: 'code' } as Settings;
const finish = () => message?.end(JSON.stringify({ parts: [{ id: 'answer', type: 'text', text: 'Hello 世界' }] }));
const event = (type: string, properties: unknown) => stream!.write('data: ' + JSON.stringify({ type, properties }) + '\n\n');
async function collect(host?: NativeApprovalHost, options = settings): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of remote.send(connection, 'panel', options, async () => 'Hello', 'vendor/model', host)) { chunks.push(chunk); }
  return chunks;
}
async function ready(): Promise<void> { await vi.waitFor(() => expect(message).toBeDefined()); }
beforeEach(async () => {
  stream = undefined; message = undefined; permissionReply = undefined;
  deleted = 0; aborted = 0; promptCount = 0; acknowledge = true; status = 200; secrets.clear();
  server = createServer(async (req, res) => {
    auth = req.headers.authorization ?? '';
    const url = new URL(req.url!, 'http://localhost'); directory = url.searchParams.get('directory') ?? '';
    const chunks: Buffer[] = []; for await (const chunk of req) { chunks.push(chunk); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (status !== 200) { res.writeHead(status); res.end('{}'); return; }
    if (url.pathname === '/global/health') { res.end(JSON.stringify({ healthy: true, version: 'fixture' })); }
    else if (url.pathname === '/provider') { res.end(JSON.stringify({ connected: ['vendor'], all: [{ id: 'vendor', models: { model: { name: 'Model', limit: { context: 12345 } } } }] })); }
    else if (url.pathname === '/session' && req.method === 'POST') { res.end(JSON.stringify({ id: 'owned', ...(acknowledge ? { permission: body.permission } : {}) })); }
    else if (url.pathname === '/event') { res.setHeader('Content-Type', 'text/event-stream'); stream = res; res.write(': ready\n\n'); }
    else if (url.pathname === '/session/owned/message') { promptCount++; message = res; expect(body.model).toEqual({ providerID: 'vendor', modelID: 'model' }); }
    else if (url.pathname === '/permission/permission/reply') { permissionReply = body.reply; res.end('true'); finish(); }
    else if (url.pathname.endsWith('/abort')) { aborted++; res.end('true'); }
    else if (req.method === 'DELETE') { deleted++; res.end('true'); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  connection = remoteConnection(`http://127.0.0.1:${address.port}`, '/wsl/project');
  remote = new OpenCodeRemote({ get: async key => secrets.get(key) } as SecretStorage);
});
afterEach(async () => {
  remote.cancel(); stream?.end(); message?.end(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
describe('OpenCode HTTP transport', () => {
  it('discovers authenticated server models and sends the remote directory', async () => {
    secrets.set(remoteSecretKey(connection), 'test-password');
    expect((await remote.probe(connection)).models).toEqual([{ id: 'vendor/model', name: 'Model', contextWindow: 12345 }]);
    expect(auth).toBe('Basic ' + Buffer.from('opencode:test-password').toString('base64'));
    expect(directory).toBe('/wsl/project');
  });
  it('streams UTF-8 and deduplicates the final response, then removes its session', async () => {
    const result = collect(); await ready();
    event('message.part.updated', { part: { sessionID: 'owned', id: 'answer', type: 'text', text: 'Hello ' } });
    event('message.part.delta', { sessionID: 'owned', partID: 'answer', field: 'text', delta: '世界' });
    await new Promise(resolve => setTimeout(resolve, 10)); finish();
    const chunks = await result;
    expect(chunks.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('Hello 世界');
    expect(chunks.at(-1)?.type).toBe('done'); expect(deleted).toBe(1);
  });
  it('waits for host approval before replying to the server', async () => {
    let allow!: (value: boolean) => void;
    const handler = vi.fn(() => new Promise<boolean>(resolve => { allow = resolve; }));
    const result = collect({ handlerForPanel: () => handler }); await ready();
    event('permission.asked', { sessionID: 'owned', id: 'permission', permission: 'bash', metadata: { command: 'echo hi' } });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce()); expect(permissionReply).toBeUndefined();
    allow(true); await result; expect(permissionReply).toBe('once');
  });
  it.each([false, true])('denies writes without a host or in read-only mode (%s)', async readonly => {
    const handler = vi.fn(async () => true);
    const result = collect(readonly ? { handlerForPanel: () => handler } : undefined,
      { ...settings, accessLevel: readonly ? 'read-only' : 'ask-permission' });
    await ready(); event('permission.asked', { sessionID: 'owned', id: 'permission', permission: 'bash' });
    await result; expect(permissionReply).toBe('reject'); expect(handler).not.toHaveBeenCalled();
  });
  it('Stop cancels a pending approval and ignores a late Allow', async () => {
    let allow!: (value: boolean) => void;
    const handler = vi.fn(() => new Promise<boolean>(resolve => { allow = resolve; }));
    const result = collect({ handlerForPanel: () => handler }); await ready();
    event('permission.asked', { sessionID: 'owned', id: 'permission', permission: 'bash' });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    remote.cancel('unrelated-panel'); expect(aborted).toBe(0);
    remote.cancel('panel'); await result; allow(true);
    expect(permissionReply).toBeUndefined(); expect(aborted).toBe(1); expect(deleted).toBe(1);
  });
  it('refuses old servers that ignore session permissions before sending a prompt', async () => {
    acknowledge = false; const chunks = await collect();
    expect(chunks[0].content).toContain('did not acknowledge'); expect(promptCount).toBe(0); expect(deleted).toBe(1);
  });
  it.each([401, 403, 500])('reports HTTP %s without success', async code => {
    status = code; const chunks = await collect();
    expect(chunks.map(c => c.type)).toEqual(['error']); expect(chunks[0].content).toContain(String(code));
  });
  it('rejects unsafe endpoints', () => {
    for (const url of ['http://remote.example', 'https://user:password@example.com', 'https://example.com?token=x']) {
      expect(() => remoteConnection(url)).toThrow();
    }
    expect(remoteConnection('https://example.com').endpoint).toBe('https://example.com');
  });
});
