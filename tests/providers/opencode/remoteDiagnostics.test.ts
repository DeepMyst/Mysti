import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'http';
import type { SecretStorage } from 'vscode';
import type { Settings, StreamChunk } from '../../../src/types';
import { OpenCodeRemote, remoteConnection, type RemoteConnection } from '../../../src/providers/opencode/OpenCodeRemote';

let server: Server, remote: OpenCodeRemote, connection: RemoteConnection;
let events: ServerResponse | undefined, message: ServerResponse | undefined;
let healthStatus: number, modelStatus: number;
const settings = { mode: 'ask-before-edit', accessLevel: 'ask-permission' } as Settings;
const secret = 'owned-server-diagnostic-secret';
async function collect() {
  const chunks: StreamChunk[] = [];
  for await (const chunk of remote.send(connection, 'owned-panel', settings, async () => 'Hello', 'owned/missing')) chunks.push(chunk);
  return chunks;
}
beforeEach(async () => {
  events = undefined; message = undefined; healthStatus = 200; modelStatus = 200;
  server = createServer(async (req, res) => {
    const route = new URL(req.url!, 'http://owned').pathname;
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (route === '/global/health') { res.writeHead(healthStatus); res.end(JSON.stringify({ healthy: true, detail: secret })); }
    else if (route === '/session') res.end(JSON.stringify({ id: 'owned', permission: body.permission }));
    else if (route === '/event') { events = res; res.setHeader('Content-Type', 'text/event-stream'); res.write(': ready\n\n'); }
    else if (route.endsWith('/message')) {
      message = res;
      if (modelStatus !== 200) { res.writeHead(modelStatus); res.end(JSON.stringify({ error: 'ModelNotFoundError', detail: secret })); }
    } else if (route.endsWith('/abort') || req.method === 'DELETE') res.end('true');
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  connection = remoteConnection(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  remote = new OpenCodeRemote({ get: async () => 'owned-password' } as unknown as SecretStorage);
});
afterEach(async () => {
  remote.cancel(); events?.end(); message?.end(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks();
});

describe('OpenCode remote failure guidance', () => {
  it.each([401, 403])('keeps HTTP %s server authentication guidance without echoing the response body', async status => {
    healthStatus = status;
    await expect(remote.probe(connection)).rejects.toThrow(`HTTP ${status}`);
    await expect(remote.probe(connection)).rejects.toThrow('server password');
    await expect(remote.probe(connection)).rejects.not.toThrow(secret);
  });
  it('explains a model-request HTTP 500 without blaming the server password or echoing raw diagnostics', async () => {
    modelStatus = 500; const chunks = await collect();
    expect(chunks.map(c => c.type)).toEqual(['error']);
    expect(chunks[0].content).toContain('HTTP 500');
    expect(chunks[0].content).toContain('selected model');
    expect(chunks[0].content).not.toContain('server password');
    expect(chunks[0].content).not.toContain(secret);
  });
  it('points a health HTTP 500 to server diagnostics', async () => {
    healthStatus = 500;
    await expect(remote.probe(connection)).rejects.toThrow('server status');
    await expect(remote.probe(connection)).rejects.not.toThrow('server password');
  });
  it.each(['message', 'events'])('explains a broken %s connection and never completes successfully', async target => {
    const pending = collect(); await vi.waitFor(() => expect(message).toBeDefined());
    (target === 'message' ? message : events)!.destroy();
    const chunks = await pending;
    expect(chunks.map(c => c.type)).toEqual(['error']);
    expect(chunks[0].content).toContain('connection was interrupted');
    expect(chunks[0].content).toContain('server is running');
    expect(chunks[0].content).not.toContain('TypeError');
  });
});
