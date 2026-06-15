/**
 * CanvasToolServer tests — the real mysti-canvas MCP server, exercised
 * end-to-end over the SDK's in-memory transport (a Client talks to the Server,
 * no F5 / live CLI needed). Verifies tools/list, a tools/call that mutates the
 * artifact, and the no-active-canvas + tool-error paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CanvasToolServer } from '../../src/services/CanvasToolServer';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

describe('CanvasToolServer (MCP, in-memory transport)', () => {
  let store: ArtifactStore;
  let artifact: CanvasArtifact;
  let ctx: CanvasToolContext | null;
  let server: CanvasToolServer;
  let client: Client;

  async function connect(resolveContext: () => CanvasToolContext | null) {
    server = new CanvasToolServer({ resolveContext });
    client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  }

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
    artifact = store.createArtifact({ name: 'App', kind: 'screens' });
    ctx = { artifact, store, executor, jobId: 'j', runId: 'r', approvalMode: 'auto' };
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
  });

  it('tools/list returns the mysti-canvas tool catalog', async () => {
    await connect(() => ctx);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_pages', 'read_page', 'insert_page', 'write_page_jsx', 'set_theme']));
    for (const t of tools) {
      expect(t.description).toMatch(/^(READ-ONLY|WRITE)/);
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('tools/call insert_page mutates the live artifact and returns an op summary', async () => {
    await connect(() => ctx);
    const res: any = await client.callTool({ name: 'insert_page', arguments: { page: { mode: 'html', htmlSource: '<h1>Hi</h1>', actionTitle: 'Home' } } });
    expect(res.isError).toBeFalsy();
    expect(artifact.pages).toHaveLength(1);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.op.kind).toBe('insert_page');
    expect(payload.op.status).toBe('applied');
  });

  it('a read tool returns artifact data', async () => {
    store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: 'x', actionTitle: 'P1' }));
    await connect(() => ctx);
    const res: any = await client.callTool({ name: 'get_artifact_index', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).data).toContain('pages=1');
  });

  it('a tool error comes back as isError with the reason', async () => {
    await connect(() => ctx);
    const res: any = await client.callTool({ name: 'edit_page', arguments: { pageId: 'ghost', patch: { htmlSource: 'x' } } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('does not belong');
  });

  it('returns a friendly error when no canvas is active', async () => {
    await connect(() => null);
    const res: any = await client.callTool({ name: 'list_pages', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('No active canvas');
  });
});
