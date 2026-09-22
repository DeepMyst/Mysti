/** Actual SDK requests, real Canvas owners/executor and private filesystem; generators are inert. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CanvasToolServer } from '../../src/services/CanvasToolServer';
import { CanvasMediaService, type GeneratedMedia, type GenerateMediaResult } from '../../src/services/CanvasMediaService';
import { CanvasMediaOperation } from '../../src/canvas/CanvasMediaOperation';
import { CanvasCapabilityRegistry } from '../../src/managers/CanvasCapabilityRegistry';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasArtifactSession } from '../../src/canvas/CanvasArtifactSession';
import { CanvasMcpSession } from '../../src/canvas/CanvasMcpSession';
import { CanvasToolSession, type CanvasToolView } from '../../src/canvas/CanvasToolSession';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { CanvasOpExecutor, type CanvasApprovalMode } from '../../src/managers/CanvasOpExecutor';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const PNG64 = Buffer.from('private-inert-png-fixture').toString('base64');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); }
  vi.restoreAllMocks();
});

async function fixture(stage: 'generation' | 'fetch' = 'generation', approval: CanvasApprovalMode = 'auto') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-media-owned-'));
  let storeRoot = path.join(root, 'first'); fs.mkdirSync(storeRoot);
  const store = new ArtifactStore({ getRoot: () => storeRoot });
  const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
  let current: CanvasArtifactSession;
  let liveApproval = approval;
  let lateError = false;
  const sessions: CanvasArtifactSession[] = [];
  const clients: Client[] = [];
  const operations: CanvasMediaOperation[] = [];
  const completed: Promise<GenerateMediaResult>[] = [];
  const published: CanvasArtifactSession[] = [];
  const generatorSignals: AbortSignal[] = [];
  const fetchSignals: AbortSignal[] = [];
  const entered = deferred(); const release = deferred();
  const registry = new CanvasCapabilityRegistry({ isHubConnected: () => true, hasLocalKey: () => false, getPreference: () => 'auto' });
  const media = new CanvasMediaService({ registry, store,
    callBrokered: async (_kind, _request, signal): Promise<GeneratedMedia> => {
      generatorSignals.push(signal);
      if (stage === 'generation') { entered.resolve(); await release.promise; }
      if (lateError) { throw new Error('late inert failure'); }
      return stage === 'fetch' ? { url: 'https://never-requested.invalid/inert.png', mimeType: 'image/png' }
        : { base64: PNG64, mimeType: 'image/png', model: 'inert-fixture' };
    },
    generateLocal: async () => { throw new Error('unexpected local generator'); },
    fetchBytes: async (_url, signal) => {
      fetchSignals.push(signal); entered.resolve(); await release.promise;
      if (lateError) { throw new Error('late inert fetch failure'); }
      return { base64: PNG64, mimeType: 'image/png' };
    },
  });
  const generate = media.generate.bind(media);
  vi.spyOn(media, 'generate').mockImplementation((...args) => {
    const task = generate(...args); completed.push(task); return task;
  });
  const view = (): CanvasToolView | null => {
    if (!current) { return null; }
    const owner = current;
    return { panelId: 'canvas-reused-id', originPanelId: 'chat', artifacts: owner,
      isCurrent: () => current === owner && !owner.closed, publish: () => {} };
  };
  const tools = new CanvasToolSession({ currentView: view, openView: () => null,
    approvalFor: () => liveApproval, toolLabel: name => name, openMcpTurn: () => {} });
  const server = new CanvasToolServer({ resolveContext: () => tools.context({ kind: 'mcp' }), mediaService: media,
    captureMediaOperation: (ctx, request) => {
      const owner = current; const snapshot = owner.snapshot;
      if (!snapshot || snapshot.artifact !== ctx.artifact) { return null; }
      const operation = new CanvasMediaOperation({ id: String(request.requestId), ctx, signal: request.signal,
        isCurrent: () => current === owner && !owner.closed && owner.snapshot === snapshot,
        liveApproval: () => liveApproval, publish: () => { published.push(owner); },
      });
      operations.push(operation); return operation;
    },
  });
  let client!: Client;
  const transportOwner = new CanvasMcpSession({
    artifactId: () => current?.snapshot?.artifact.id ?? null, originPanel: () => 'chat',
    createServer: artifactId => ({
      start: async () => {
        const [ct, st] = InMemoryTransport.createLinkedPair();
        client = new Client({ name: 'inert-media-acceptance', version: '1.0.0' }, { capabilities: {} });
        clients.push(client); await Promise.all([server.connect(st), client.connect(ct)]);
        return { url: 'http://127.0.0.1:0/not-listening', token: 'inert-never-networked', artifactId };
      }, stop: () => server.close(),
    }), link: () => {}, unlink: () => {}, onError: error => { throw error; },
  });
  function createSession() {
    const session = new CanvasArtifactSession(store, executor, {
      createEmpty: name => store.createArtifact({ name: name || 'Owned design', kind: 'screens' }),
      createHistory: (artifact, exec) => new CanvasHistory(artifact, exec, { jobId: 'inert' }),
      render: () => {}, ready: () => {}, relink: id => transportOwner.relink(id),
      closeTransport: () => transportOwner.close(), onError: (_stage, error) => { throw error; },
    });
    sessions.push(session); return session;
  }
  current = createSession(); await current.initialize();
  await store.save(current.snapshot!.artifact); await current.refreshTransport();
  const original = current.snapshot!.artifact; const originalSession = current;
  const firstRoot = storeRoot;
  cleanups.push(async () => {
    release.resolve(); await Promise.allSettled(completed);
    for (const session of sessions) { await session.close(); }
    await transportOwner.dispose();
    for (const item of clients) { await item.close().catch(() => {}); }
    await server.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const start = (abort?: AbortController, kind: 'image' | 'video' = 'image') => client.callTool({
    name: kind === 'video' ? 'generate_video' : 'generate_visual', arguments: { prompt: 'private inert image', role: 'hero' },
  }, undefined, abort ? { signal: abort.signal } : undefined).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }));
  async function finish() {
    release.resolve(); await Promise.allSettled(completed); await new Promise(resolve => setImmediate(resolve));
  }
  const assetFiles = (base = firstRoot) => {
    const directory = path.join(base, '.mysti', 'canvas', original.id, 'assets');
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  };
  return { root, store, executor, original, originalSession, media, server, entered, release, completed,
    start, finish, operations, published, generatorSignals, fetchSignals, assetFiles,
    get current() { return current; }, get client() { return client; }, get storeRoot() { return storeRoot; },
    setApproval: (value: CanvasApprovalMode) => { liveApproval = value; },
    rejectLate: () => { lateError = true; },
    moveRoot: () => { storeRoot = path.join(root, 'second'); fs.mkdirSync(storeRoot); },
    reopen: async () => {
      await current.close(); current = createSession(); await current.initialize(); await current.refreshTransport();
    },
  };
}

function textPayload(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['start']>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) { throw new Error(result.error); }
  const content = result.value.content as Array<{ type: string; text?: string }>;
  return { result: result.value, payload: JSON.parse(content[0].text!) };
}

describe('Canvas media admitted-operation ownership through the real MCP SDK', () => {
  it.each(['image', 'video'] as const)('active %s waits for bytes and metadata, then publishes its captured view', async kind => {
    const f = await fixture(); const pending = f.start(undefined, kind); await f.entered.promise;
    expect(f.original.assets).toHaveLength(0); await f.finish();
    const { result, payload } = textPayload(await pending);
    expect(result.isError).toBeFalsy(); expect(payload).toMatchObject({ committed: true, persisted: true, pending: false, status: 'applied' });
    expect(f.original.assets).toHaveLength(1); expect(f.original.opLog).toHaveLength(1);
    expect(f.original.assets[0].role).toBe(kind); expect(f.assetFiles()).toHaveLength(1);
    expect((await f.store.load(f.original.id))!.assets).toEqual(f.original.assets);
    expect(f.published).toEqual([f.originalSession]);
  });

  it.each(['generation', 'fetch'] as const)('SDK cancellation during %s drops late output and leaves the shared session usable', async stage => {
    const f = await fixture(stage); const abort = new AbortController(); const pending = f.start(abort);
    await f.entered.promise; abort.abort(); expect((await pending).ok).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.operations[0].signal.aborted).toBe(true);
    expect((await f.completed[0]).cancelled).toBe(true); // resolves before the inert provider does
    expect(f.generatorSignals[0].aborted).toBe(true);
    if (stage === 'fetch') { expect(f.fetchSignals[0].aborted).toBe(true); }
    await f.finish(); expect(f.original.assets).toHaveLength(0); expect(f.original.opLog).toHaveLength(0);
    expect(f.assetFiles()).toEqual([]); expect(f.published).toEqual([]);
    expect(textPayload(await f.start()).payload.persisted).toBe(true);
  });

  it.each(['generation', 'fetch'] as const)('view close during %s revokes the actual transport without a late file or record', async stage => {
    const f = await fixture(stage); const pending = f.start(); await f.entered.promise;
    await f.current.close(); expect((await pending).ok).toBe(false); await f.finish();
    expect(f.operations[0].signal.aborted).toBe(true); expect(f.original.assets).toHaveLength(0);
    expect(f.original.opLog).toHaveLength(0); expect(f.assetFiles()).toEqual([]);
    expect((await f.store.load(f.original.id))!.assets).toHaveLength(0); expect(f.published).toEqual([]);
  });

  it('actual artifact selection revokes the old request and leaves a usable successor', async () => {
    const f = await fixture(); const pending = f.start(); await f.entered.promise;
    await f.current.select(null, 'Successor'); expect((await pending).ok).toBe(false); await f.finish();
    expect(f.current.snapshot!.artifact).not.toBe(f.original); expect(f.original.assets).toHaveLength(0);
    expect(f.original.opLog).toHaveLength(0); expect(f.assetFiles()).toEqual([]); expect(f.published).toEqual([]);
    expect(textPayload(await f.start()).payload.persisted).toBe(true);
    expect(f.current.snapshot!.artifact.assets).toHaveLength(1);
  });

  it('same-ID close/reopen cannot revive the old artifact owner', async () => {
    const f = await fixture(); const pending = f.start(); await f.entered.promise;
    await f.reopen(); expect((await pending).ok).toBe(false); await f.finish();
    expect(f.current).not.toBe(f.originalSession); expect(f.current.snapshot!.artifact.id).toBe(f.original.id);
    expect(f.current.snapshot!.artifact).not.toBe(f.original); expect(f.assetFiles()).toEqual([]);
    expect(f.original.assets).toHaveLength(0); expect(f.current.snapshot!.artifact.assets).toHaveLength(0);
    expect(textPayload(await f.start()).payload.persisted).toBe(true);
  });

  it('a changed injected workspace root cannot redirect an admitted generation', async () => {
    const f = await fixture(); const pending = f.start(); await f.entered.promise; f.moveRoot(); await f.finish();
    const result = await pending; expect(result.ok).toBe(true);
    if (result.ok) { expect(result.value.isError).toBe(true); }
    expect(f.assetFiles()).toEqual([]); expect(f.assetFiles(f.storeRoot)).toEqual([]);
    expect(f.original.assets).toHaveLength(0); expect(f.original.opLog).toHaveLength(0);
  });

  it.each(['accept', 'reject'] as const)('staged bytes and pending intent survive reload before human %s', async decision => {
    const f = await fixture('generation', 'staged'); const pending = f.start(); await f.entered.promise;
    f.setApproval('auto'); // a later permissive setting cannot widen captured policy
    await f.finish(); const { payload } = textPayload(await pending);
    expect(payload).toMatchObject({ pending: true, status: 'pending', persisted: true });
    expect(f.original.assets).toHaveLength(0); expect(f.assetFiles()).toHaveLength(1);
    const saved = (await f.store.load(f.original.id))!;
    expect(saved.assets).toHaveLength(0); expect(saved.opLog).toHaveLength(1);
    expect(saved.opLog[0].opId).toBe(payload.opId);
    if (decision === 'accept') { f.executor.applyOp(saved, payload.opId, 'human'); }
    else { f.executor.rejectOp(saved, payload.opId, 'human'); }
    await f.store.save(saved);
    expect((await f.store.load(saved.id))!.assets).toHaveLength(decision === 'accept' ? 1 : 0);
    expect(f.assetFiles()).toHaveLength(1); // shared bytes/provenance are not cancellation garbage
  });

  it('live restrictions narrow a captured auto operation before commit', async () => {
    const f = await fixture(); const pending = f.start(); await f.entered.promise;
    f.setApproval('staged'); await f.finish();
    expect(textPayload(await pending).payload.pending).toBe(true); expect(f.original.assets).toHaveLength(0);
  });

  it('cancelling one concurrent request preserves its sibling and a single deduplicated file', async () => {
    const f = await fixture(); const abort = new AbortController(); const first = f.start(abort); const sibling = f.start();
    await f.entered.promise; await new Promise(resolve => setImmediate(resolve)); expect(f.operations).toHaveLength(2);
    abort.abort(); expect((await first).ok).toBe(false); await f.finish();
    expect(textPayload(await sibling).payload.persisted).toBe(true);
    expect(f.original.assets).toHaveLength(1); expect(f.original.opLog).toHaveLength(1); expect(f.assetFiles()).toHaveLength(1);
  });

  it.each(['generation', 'fetch'] as const)('late %s rejection after SDK cancellation is observed without publication', async stage => {
    const f = await fixture(stage); const abort = new AbortController(); const pending = f.start(abort);
    await f.entered.promise; abort.abort(); expect((await pending).ok).toBe(false);
    await new Promise(resolve => setImmediate(resolve)); expect((await f.completed[0]).cancelled).toBe(true);
    f.rejectLate(); await f.finish(); expect(f.original.assets).toHaveLength(0); expect(f.assetFiles()).toEqual([]);
  });
});
