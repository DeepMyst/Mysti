/**
 * CanvasMcpHttpServer tests — host the mysti-canvas MCP server over localhost
 * HTTP and drive it with a real SDK HTTP client (the same transport a CLI uses),
 * validating the live path end-to-end. Also checks the bearer-token gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CanvasMcpHttpServer } from '../../src/services/CanvasMcpHttpServer';
import { CanvasToolServer } from '../../src/services/CanvasToolServer';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

describe('CanvasMcpHttpServer (live HTTP transport)', () => {
  let store: ArtifactStore;
  let artifact: CanvasArtifact;
  let ctx: CanvasToolContext;
  let host: CanvasMcpHttpServer;
  let handle: { port: number; token: string; url: string };
  let client: Client | null = null;

  beforeEach(async () => {
    store = new ArtifactStore({ getRoot: () => null });
    artifact = store.createArtifact({ name: 'App', kind: 'screens' });
    ctx = { artifact, store, executor: new CanvasOpExecutor(store, new CanvasJobRouter(() => {})), jobId: 'j', runId: 'r', approvalMode: 'auto' };
    host = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => ctx }));
    handle = await host.start();
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    client = null;
    await host.stop();
  });

  function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
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

    const res: any = await client.callTool({ name: 'insert_page', arguments: { page: { mode: 'html', htmlSource: '<h1>Hi</h1>', actionTitle: 'Home' } } });
    expect(res.isError).toBeFalsy();
    expect(artifact.pages).toHaveLength(1);
  });

  it('rejects a wrong bearer token', async () => {
    await expect(connect('wrong-token')).rejects.toBeTruthy();
  });
});
