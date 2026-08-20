/**
 * CanvasMcpHttpServer tests — host the mysti-canvas MCP server over localhost
 * HTTP and drive it with a real SDK HTTP client (the same transport a CLI uses),
 * validating the live path end-to-end. Also checks the bearer-token gate, the
 * 6.3b Host/Origin gates, and (Plan 20 §3.6) the per-artifact token binding and
 * the idempotent, retroactive `stop()`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CanvasMcpHttpServer } from '../../src/services/CanvasMcpHttpServer';
import { CanvasToolServer } from '../../src/services/CanvasToolServer';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

function makeContext(name = 'App'): { store: ArtifactStore; artifact: CanvasArtifact; ctx: CanvasToolContext } {
  const store = new ArtifactStore({ getRoot: () => null });
  const artifact = store.createArtifact({ name, kind: 'screens' });
  const ctx: CanvasToolContext = {
    artifact, store,
    executor: new CanvasOpExecutor(store, new CanvasJobRouter(() => {})),
    jobId: 'j', runId: 'r', approvalMode: 'auto',
  };
  return { store, artifact, ctx };
}

/** Raw request against a loopback port with fully attacker-controlled headers. */
function rawRequest(port: number, headers: Record<string, string>, path = '/mcp'): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('CanvasMcpHttpServer (live HTTP transport)', () => {
  let artifact: CanvasArtifact;
  let ctx: CanvasToolContext;
  let host: CanvasMcpHttpServer;
  let handle: { port: number; token: string; url: string };
  let client: Client | null = null;

  beforeEach(async () => {
    ({ artifact, ctx } = makeContext());
    host = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => ctx }));
    handle = await host.start();
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    client = null;
    await host.stop();
  });

  function connect(token: string, url = handle.url): Promise<Client> {
    const c = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    return c.connect(transport).then(() => c);
  }

  it('serves on a loopback port with a token', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(handle.token).toHaveLength(48);
    expect(handle.port).toBeGreaterThan(0);
  });

  it('a real HTTP client can list + call tools end-to-end', async () => {
    client = await connect(handle.token);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toContain('insert_page');

    const res = await client.callTool({ name: 'insert_page', arguments: { page: { mode: 'html', htmlSource: '<h1>Hi</h1>', actionTitle: 'Home' } } });
    expect(res.isError).toBeFalsy();
    expect(artifact.pages).toHaveLength(1);
  });

  it('rejects a wrong bearer token', async () => {
    await expect(connect('wrong-token')).rejects.toBeTruthy();
  });

  it('rejects a token of the right length but the wrong bytes (constant-time compare)', async () => {
    const wrong = 'f'.repeat(handle.token.length);
    expect((await rawRequest(handle.port, { authorization: `Bearer ${wrong}`, host: '127.0.0.1' })).status).toBe(401);
  });

  // 6.3b — defensive Host/Origin validation (DNS-rebinding / cross-site).
  describe('Host/Origin validation (6.3b)', () => {
    it('403s a non-loopback Host header even with a valid bearer (DNS rebinding)', async () => {
      const { status } = await rawRequest(handle.port, {
        host: 'evil.example.com',
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      });
      expect(status).toBe(403);
    });

    it('403s a rebound Host with port and a null Origin', async () => {
      expect((await rawRequest(handle.port, { host: 'evil.example.com:8080' })).status).toBe(403);
      expect((await rawRequest(handle.port, { host: `127.0.0.1:${handle.port}`, origin: 'null' })).status).toBe(403);
    });

    it('403s a non-localhost Origin even when Host is loopback', async () => {
      const { status } = await rawRequest(handle.port, {
        host: `127.0.0.1:${handle.port}`,
        origin: 'https://evil.example.com',
        authorization: `Bearer ${handle.token}`,
      });
      expect(status).toBe(403);
    });

    it('passes loopback Host + localhost Origin through to the bearer gate', async () => {
      // No/bad token → the request must reach the 401 bearer check, proving the
      // new gates did not reject it.
      const unauthed = await rawRequest(handle.port, { host: 'localhost', origin: 'http://localhost:3000' });
      expect(unauthed.status).toBe(401);
      const ipv6 = await rawRequest(handle.port, { host: '[::1]:9999', origin: 'http://127.0.0.1' });
      expect(ipv6.status).toBe(401);
    });

    it('the real SDK client flow still works after the new gates', async () => {
      client = await connect(handle.token);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    });
  });
});

// ── Plan 20 §3.6: the token belongs to ONE artifact ──
describe('CanvasMcpHttpServer artifact binding', () => {
  it('a token minted for design A does not follow the user into design B', async () => {
    const a = makeContext('A');
    const b = makeContext('B');
    // The host's "current" artifact, mutable exactly like the provider field.
    let current = a.artifact;
    const server = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => (current === a.artifact ? a.ctx : b.ctx) }), {
      artifactId: a.artifact.id,
      currentArtifactId: () => current.id,
    });
    const h = await server.start();
    try {
      expect(h.artifactId).toBe(a.artifact.id);
      // Reaches the MCP transport (which 406s a bare POST) — i.e. past every gate.
      expect((await rawRequest(h.port, { host: '127.0.0.1', authorization: `Bearer ${h.token}` })).status).toBe(406);

      // The user opens their next design; the old token dies with the old one.
      current = b.artifact;
      expect((await rawRequest(h.port, { host: '127.0.0.1', authorization: `Bearer ${h.token}` })).status).toBe(410);
      expect(server.isRevoked).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('revocation is permanent — reopening design A does not resurrect the token', async () => {
    const a = makeContext('A');
    let current: string | null = a.artifact.id;
    const server = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), {
      artifactId: a.artifact.id,
      currentArtifactId: () => current,
    });
    const h = await server.start();
    try {
      current = null;   // canvas closed
      expect((await rawRequest(h.port, { host: '127.0.0.1', authorization: `Bearer ${h.token}` })).status).toBe(410);
      current = a.artifact.id;   // …and reopened
      const again = await rawRequest(h.port, { host: '127.0.0.1', authorization: `Bearer ${h.token}` })
        .catch(() => ({ status: 0 }));   // the socket may already be gone (self-stop)
      expect([0, 410]).toContain(again.status);
    } finally {
      await server.stop();
    }
  });

  it('an invalid bearer is still 401 — the binding check never leaks liveness', async () => {
    const a = makeContext('A');
    let current: string | null = a.artifact.id;
    const server = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), {
      artifactId: a.artifact.id,
      currentArtifactId: () => current,
    });
    const h = await server.start();
    try {
      current = 'some-other-artifact';
      expect((await rawRequest(h.port, { host: '127.0.0.1', authorization: 'Bearer nope' })).status).toBe(401);
      expect(server.isRevoked).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('a probe that throws is treated as "not my artifact"', async () => {
    const a = makeContext('A');
    const server = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), {
      artifactId: a.artifact.id,
      currentArtifactId: () => { throw new Error('panel disposed'); },
    });
    const h = await server.start();
    try {
      expect((await rawRequest(h.port, { host: '127.0.0.1', authorization: `Bearer ${h.token}` })).status).toBe(410);
    } finally {
      await server.stop();
    }
  });

  it('two artifacts get two different tokens', () => {
    const a = makeContext('A');
    const s1 = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), { artifactId: 'one' });
    const s2 = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), { artifactId: 'two' });
    expect(s1.token).not.toBe(s2.token);
    expect(s1.artifactId).toBe('one');
  });
});

// ── Plan 20 §3.6: lifecycle ──
describe('CanvasMcpHttpServer lifecycle', () => {
  it('stop() before the async startup finishes leaves NO listening server', async () => {
    const a = makeContext('A');
    // `_getActiveHandles()` is how a leaked listener is actually observable: the
    // old code assigned `_http` AFTER `listen` resolved, so a stop() that landed
    // first found nothing to close and the socket stayed bound for the session.
    const activeHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    expect(typeof activeHandles).toBe('function');
    const before = new Set(activeHandles!.call(process));

    const server = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), { artifactId: a.artifact.id });
    const starting = server.start();
    // The panel is disposed before `listen` resolves.
    const stopping = server.stop();
    await expect(starting).rejects.toThrow(/stopped before startup/);
    await stopping;
    expect(server.isRevoked).toBe(true);

    const leaked = activeHandles!.call(process).filter(
      (h): h is http.Server => !before.has(h) && h instanceof http.Server && h.listening,
    );
    expect(leaked).toHaveLength(0);
  });

  it('a stop() that lands while `listen` is still pending is honoured after it resolves', async () => {
    // The narrow window the `_stopped`-after-listen check exists for: the tool
    // server has connected, the socket is being bound, and the panel closes.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const toolServer = { connect: async () => { await gate; } } as unknown as CanvasToolServer;

    const activeHandles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles;
    const before = new Set(activeHandles.call(process));

    const server = new CanvasMcpHttpServer(toolServer, { artifactId: 'a1' });
    const starting = server.start();
    release();
    // Drain microtasks until `_start` is parked on `listen` (an I/O wait, so it
    // cannot complete on the microtask queue).
    for (let i = 0; i < 6; i++) { await Promise.resolve(); }

    const stopping = server.stop();
    await expect(starting).rejects.toThrow(/stopped before startup/);
    await stopping;

    const leaked = activeHandles.call(process).filter(
      (h): h is http.Server => !before.has(h) && h instanceof http.Server && h.listening,
    );
    expect(leaked).toHaveLength(0);
  });

  it('stop() is idempotent and safe before start / repeatedly after', async () => {
    const a = makeContext('A');
    const never = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), { artifactId: a.artifact.id });
    await expect(never.stop()).resolves.toBeUndefined();
    await expect(never.stop()).resolves.toBeUndefined();
    // …and start() after stop() refuses rather than listening on a dead server.
    await expect(never.start()).rejects.toThrow(/stopped before startup/);

    const b = makeContext('B');
    const live = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => b.ctx }), { artifactId: b.artifact.id });
    const h = await live.start();
    await live.stop();
    await live.stop();
    await expect(rawRequest(h.port, { host: '127.0.0.1', authorization: `Bearer ${h.token}` })).rejects.toBeTruthy();
  });

  it('concurrent start() calls share one listener', async () => {
    const a = makeContext('A');
    const server = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => a.ctx }), { artifactId: a.artifact.id });
    try {
      const [h1, h2] = await Promise.all([server.start(), server.start()]);
      expect(h1.port).toBe(h2.port);
      expect(await server.start()).toBe(h1);
    } finally {
      await server.stop();
    }
  });
});
