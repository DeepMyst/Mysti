/**
 * Media generation tests (Plan 05 Phase 6.3):
 * - CanvasMediaService routing: deepmyst-brokered vs local-key vs off (connect
 *   hint), URL-result fetching, provenance-tracked asset persistence.
 * - CanvasToolServer generate_visual/generate_video tools (in-memory MCP).
 * - McpClient end-to-end over REAL HTTP against our own CanvasMcpHttpServer
 *   (bearer auth) — the same client the DeepMyst-hub path uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CanvasMediaService } from '../../src/services/CanvasMediaService';
import type { CanvasMediaDeps } from '../../src/services/CanvasMediaService';
import { CanvasCapabilityRegistry } from '../../src/managers/CanvasCapabilityRegistry';
import type { CapabilityInputs } from '../../src/managers/CanvasCapabilityRegistry';
import { CanvasToolServer, type CanvasMediaRequest } from '../../src/services/CanvasToolServer';
import { CanvasMediaOperation } from '../../src/canvas/CanvasMediaOperation';
import { CanvasMcpHttpServer } from '../../src/services/CanvasMcpHttpServer';
import { McpClient } from '../../src/services/McpClient';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

const PNG64 = Buffer.from('fake-png').toString('base64');

function operation(ctx: CanvasToolContext, request?: CanvasMediaRequest): CanvasMediaOperation {
  return new CanvasMediaOperation({ id: String(request?.requestId ?? 'inert-media'), ctx,
    signal: request?.signal ?? new AbortController().signal,
    isCurrent: () => true, liveApproval: () => ctx.approvalMode, publish: () => {},
  });
}


function registry(over: { hub?: string[]; keys?: string[] } = {}): CanvasCapabilityRegistry {
  const hub = new Set(over.hub ?? []);
  const keys = new Set(over.keys ?? []);
  const inputs: CapabilityInputs = {
    isHubConnected: s => hub.has(s),
    hasLocalKey: k => keys.has(k),
    getPreference: () => 'auto',
  };
  return new CanvasCapabilityRegistry(inputs);
}

describe('CanvasMediaService', () => {
  let root: string;
  let store: ArtifactStore;
  let artifact: CanvasArtifact;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-media-'));
    store = new ArtifactStore({ getRoot: () => root });
    artifact = store.createArtifact({ name: 'App', kind: 'screens' });
    return () => fs.rmSync(root, { recursive: true, force: true });
  });

  function admitted(): CanvasMediaOperation {
    return operation({ artifact, store, executor: new CanvasOpExecutor(store, new CanvasJobRouter(() => {})),
      jobId: 'j', runId: 'mcp', approvalMode: 'auto' });
  }

  function deps(over: Partial<CanvasMediaDeps> & { reg?: CanvasCapabilityRegistry } = {}): CanvasMediaDeps {
    return {
      registry: over.reg ?? registry({ hub: ['fal_ai'] }),
      callBrokered: over.callBrokered ?? vi.fn().mockResolvedValue({ base64: PNG64, mimeType: 'image/png', model: 'fal:flux' }),
      generateLocal: over.generateLocal ?? vi.fn().mockResolvedValue({ base64: PNG64, mimeType: 'image/png', model: 'gpt-image-1' }),
      fetchBytes: over.fetchBytes ?? vi.fn().mockResolvedValue({ base64: PNG64, mimeType: 'image/png' }),
      store,
    };
  }

  it('routes to the brokered (DeepMyst/fal) generator when the hub is connected', async () => {
    const d = deps();
    const r = await new CanvasMediaService(d).generate(admitted(), { kind: 'image', prompt: 'a city skyline', role: 'hero', sourcePageId: 'p1' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('deepmyst');
    expect(d.callBrokered).toHaveBeenCalledOnce();
    expect(d.generateLocal).not.toHaveBeenCalled();
    // provenance-tracked asset persisted into the artifact
    expect(r.asset!.ref).toMatch(/^asset:\/\//);
    expect(r.asset!.prompt).toBe('[hero] a city skyline');
    expect(r.asset!.model).toBe('fal:flux');
    expect(r.asset!.sourcePageId).toBe('p1');
    expect(artifact.assets).toHaveLength(1);
  });

  it('falls back to the local generator when only a key is present', async () => {
    const d = deps({ reg: registry({ keys: ['openai'] }) });
    const r = await new CanvasMediaService(d).generate(admitted(), { kind: 'image', prompt: 'x' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('local');
    expect(d.callBrokered).not.toHaveBeenCalled();
  });

  it('returns a connect hint when the capability is off', async () => {
    const d = deps({ reg: registry() });
    const r = await new CanvasMediaService(d).generate(admitted(), { kind: 'image', prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.connectHint).toBe('canvas-image');
    expect(r.error).toContain('not connected');
  });

  it('fetches URL results (fal CDN) before persisting', async () => {
    const d = deps({ callBrokered: vi.fn().mockResolvedValue({ url: 'https://cdn.fal.ai/x.png', mimeType: 'image/png' }) });
    const r = await new CanvasMediaService(d).generate(admitted(), { kind: 'image', prompt: 'x' });
    expect(r.ok).toBe(true);
    expect(d.fetchBytes).toHaveBeenCalledWith('https://cdn.fal.ai/x.png', expect.any(AbortSignal));
  });

  it('video requests use the canvas-video capability and role video', async () => {
    const d = deps({ reg: registry({ hub: ['fal_ai'] }) });
    const r = await new CanvasMediaService(d).generate(admitted(), { kind: 'video', prompt: 'intro clip' });
    expect(r.ok).toBe(true);
    expect(r.asset!.role).toBe('video');
  });

  it('surfaces generator failures as clean errors', async () => {
    const d = deps({ callBrokered: vi.fn().mockRejectedValue(new Error('rate limited')) });
    const r = await new CanvasMediaService(d).generate(admitted(), { kind: 'image', prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('rate limited');
  });
});

describe('CanvasToolServer media tools', () => {
  let store: ArtifactStore;
  let artifact: CanvasArtifact;
  let ctx: CanvasToolContext;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-media-srv-'));
    store = new ArtifactStore({ getRoot: () => root });
    artifact = store.createArtifact({ name: 'App', kind: 'screens' });
    ctx = { artifact, store, executor: new CanvasOpExecutor(store, new CanvasJobRouter(() => {})), jobId: 'j', runId: 'r', approvalMode: 'auto' };
    return () => fs.rmSync(root, { recursive: true, force: true });
  });

  const connected: Array<{ client: Client; server: CanvasToolServer }> = [];
  afterEach(async () => {
    for (const { client, server } of connected.splice(0)) { await client.close(); await server.close(); }
  });
  async function connect(server: CanvasToolServer) {
    const client = new Client({ name: 't', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    connected.push({ client, server });
    return client;
  }

  function mediaService(reg: CanvasCapabilityRegistry): CanvasMediaService {
    return new CanvasMediaService({
      registry: reg,
      callBrokered: vi.fn().mockResolvedValue({ base64: PNG64, mimeType: 'image/png', model: 'fal:flux' }),
      generateLocal: vi.fn().mockResolvedValue({ base64: PNG64, mimeType: 'image/png' }),
      fetchBytes: vi.fn(),
      store,
    });
  }

  it('exposes generate_visual/generate_video only when a media service is provided', async () => {
    const bare = await connect(new CanvasToolServer({ resolveContext: () => ctx }));
    expect((await bare.listTools()).tools.map(t => t.name)).not.toContain('generate_visual');

    const withMedia = await connect(new CanvasToolServer({ resolveContext: () => ctx, captureMediaOperation: operation, mediaService: mediaService(registry({ hub: ['fal_ai'] })) }));
    const names = (await withMedia.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['generate_visual', 'generate_video']));
  });

  it('generate_visual persists an asset and returns its asset:// ref', async () => {
    const client = await connect(new CanvasToolServer({ resolveContext: () => ctx, captureMediaOperation: operation, mediaService: mediaService(registry({ hub: ['fal_ai'] })) }));
    const res: any = await client.callTool({ name: 'generate_visual', arguments: { prompt: 'hero image', role: 'hero', sourcePageId: 'p9' } });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.source).toBe('deepmyst');
    expect(payload.asset.ref).toMatch(/^asset:\/\//);
    expect(artifact.assets).toHaveLength(1);
  });

  it('returns isError + MYSTI_CONNECT hint when the capability is off', async () => {
    const client = await connect(new CanvasToolServer({ resolveContext: () => ctx, captureMediaOperation: operation, mediaService: mediaService(registry()) }));
    const res: any = await client.callTool({ name: 'generate_visual', arguments: { prompt: 'x' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('<<<MYSTI_CONNECT:canvas-image>>>');
  });
});

describe('McpClient ↔ CanvasMcpHttpServer (real HTTP, bearer)', () => {
  it('lists and calls tools over streamable HTTP with the token', async () => {
    const store = new ArtifactStore({ getRoot: () => null });
    const artifact = store.createArtifact({ name: 'Net', kind: 'screens' });
    const ctx: CanvasToolContext = { artifact, store, executor: new CanvasOpExecutor(store, new CanvasJobRouter(() => {})), jobId: 'j', runId: 'r', approvalMode: 'auto' };
    const http = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => ctx }));
    const handle = await http.start();
    const client = new McpClient({ url: handle.url, bearer: handle.token });
    try {
      const tools = await client.listTools();
      expect(tools.map(t => t.name)).toContain('insert_page');

      const call = await client.callTool('insert_page', { page: { mode: 'html', htmlSource: '<h1>Hi</h1>', actionTitle: 'Home' } });
      expect(call.isError).toBe(false);
      expect(JSON.parse(call.text).ok).toBe(true);
      expect(artifact.pages).toHaveLength(1);
    } finally {
      await client.close();
      await http.stop();
    }
  });

  it('is rejected without the bearer token', async () => {
    const store = new ArtifactStore({ getRoot: () => null });
    const artifact = store.createArtifact({ name: 'Net', kind: 'screens' });
    const ctx: CanvasToolContext = { artifact, store, executor: new CanvasOpExecutor(store, new CanvasJobRouter(() => {})), jobId: 'j', runId: 'r', approvalMode: 'auto' };
    const http = new CanvasMcpHttpServer(new CanvasToolServer({ resolveContext: () => ctx }));
    const handle = await http.start();
    const client = new McpClient({ url: handle.url }); // no bearer
    try {
      await expect(client.listTools()).rejects.toThrow();
    } finally {
      await client.close();
      await http.stop();
    }
  });
});
