/**
 * CanvasWorkspace tests (Plan 20 §3.3 "Ownership").
 *
 * The two defects this class exists to kill:
 *  1. THREE `ArtifactStore` instances writing `.mysti/canvas/` — every session
 *     must now share the one store the workspace owns.
 *  2. A chat-to-canvas link that failed OPEN (`_canvasChatOrigin === null` made
 *     `_isCanvasLinked(panelId)` true for EVERY panel). `resolve()` must return
 *     null for an unbound key, with no "null means everything" case — while a
 *     `-collab-` derived panel still inherits its parent's binding.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasWorkspace } from '../../src/canvas/CanvasWorkspace';
import type { CanvasSessionState } from '../../src/canvas/CanvasWorkspace';
import type { CanvasArtifact } from '../../src/types';
import { pageHtml } from '../../src/canvas/pageMigration';

describe('CanvasWorkspace', () => {
  let root: string;
  let store: ArtifactStore;
  let ws: CanvasWorkspace;

  function makeWorkspace(opts: { saveDebounceMs?: number; workspaceName?: string | null } = {}): CanvasWorkspace {
    return new CanvasWorkspace({
      store,
      getWorkspaceName: () => (opts.workspaceName === undefined ? 'acme' : opts.workspaceName),
      saveDebounceMs: opts.saveDebounceMs ?? 1000,
    });
  }

  /** Persist a saved design straight to disk (pre-existing project state). */
  async function seedSaved(name: string, updatedAt: number): Promise<CanvasArtifact> {
    const artifact = store.createArtifact({ name });
    await store.save(artifact);
    // `save()` stamps updatedAt itself; rewrite the file with the value we want
    // so "most recently updated" is deterministic.
    artifact.updatedAt = updatedAt;
    const dir = store.artifactDir(artifact.id)!;
    fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify(artifact, null, 2), 'utf-8');
    return artifact;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-canvas-ws-'));
    store = new ArtifactStore({ getRoot: () => root });
    ws = makeWorkspace();
  });

  afterEach(async () => {
    ws.dispose();
    await ws.whenFlushed();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ======================================================================
  // open()
  // ======================================================================

  describe('open()', () => {
    it('with no id and no saved designs mints an EMPTY "<workspace> designs" artifact', async () => {
      const session = await ws.open();
      expect(session.artifact.name).toBe('acme designs');
      expect(session.artifact.pages).toEqual([]);   // genuinely empty — no placeholder pages
      expect(session.artifactId).toBe(session.artifact.id);
      expect(session.panelId).toBeNull();
      expect(session.history).toBeTruthy();
    });

    it('falls back to the store default name when there is no workspace folder', async () => {
      const headless = makeWorkspace({ workspaceName: null });
      const session = await headless.open();
      expect(session.artifact.name).toBe('Untitled design');
      headless.dispose();
      await headless.whenFlushed();
    });

    it('with no id loads the MOST RECENTLY UPDATED saved design', async () => {
      await seedSaved('older', 1_000);
      const newest = await seedSaved('newest', 9_000);
      await seedSaved('middle', 5_000);

      const session = await ws.open();
      expect(session.artifactId).toBe(newest.id);
      expect(session.artifact.name).toBe('newest');
    });

    it('with an explicit id loads that design', async () => {
      const older = await seedSaved('older', 1_000);
      await seedSaved('newest', 9_000);

      const session = await ws.open(older.id);
      expect(session.artifactId).toBe(older.id);
    });

    it('rejects for an id that is not on disk (never silently invents one)', async () => {
      await expect(ws.open('does-not-exist')).rejects.toThrow(/no saved design/);
      expect(ws.sessions()).toHaveLength(0);
    });

    it('create:true mints a NEW design even when saved ones exist', async () => {
      const saved = await seedSaved('existing', 9_000);
      const session = await ws.open(undefined, { create: true, name: 'Second design' });
      expect(session.artifactId).not.toBe(saved.id);
      expect(session.artifact.name).toBe('Second design');
    });

    it('returns the SAME session object for a re-open of an open artifact', async () => {
      const first = await ws.open();
      const again = await ws.open(first.artifactId);
      expect(again).toBe(first);
      expect(ws.sessions()).toHaveLength(1);
    });

    it('dedupes concurrent opens instead of constructing two sessions', async () => {
      const saved = await seedSaved('existing', 9_000);
      const [a, b, c] = await Promise.all([ws.open(), ws.open(), ws.open(saved.id)]);
      expect(a).toBe(b);
      expect(c).toBe(a);
      expect(ws.sessions()).toHaveLength(1);
    });

    it('binds the origin only when one is given', async () => {
      const session = await ws.open(undefined, { origin: 'panel-1' });
      expect(ws.resolve('panel-1')).toBe(session);

      const other = await ws.open(undefined, { create: true });
      expect(ws.resolve('panel-1')).toBe(session);   // not stolen by the new design
      expect(ws.resolve(other.artifactId)).toBeNull();
    });
  });

  // ======================================================================
  // One store
  // ======================================================================

  describe('one-store invariant', () => {
    it('hands every session the identical ArtifactStore the workspace owns', async () => {
      const a = await ws.open(undefined, { create: true });
      const b = await ws.open(undefined, { create: true });
      const c = await ws.open(undefined, { create: true });
      expect(a).not.toBe(b);
      expect(a.store).toBe(ws.store);
      expect(b.store).toBe(ws.store);
      expect(c.store).toBe(ws.store);
      expect(new Set([a.store, b.store, c.store]).size).toBe(1);
    });

    it('constructs its own store when none is injected', () => {
      const owned = new CanvasWorkspace({ getRoot: () => root });
      expect(owned.store).toBeInstanceOf(ArtifactStore);
      owned.dispose();
    });

    it('routes each session executor at that same store', async () => {
      const session = await ws.open();
      const page = session.store.insertPage(
        session.artifact,
        session.store.makePage({ mode: 'html', htmlSource: 'old', actionTitle: 'Page' }),
      );
      const op = session.executor.submit(
        session.artifact,
        { kind: 'edit_page', runId: 'run-1', targetPageId: page.id, proposedValue: { htmlSource: 'new' } },
        'job-1',
        'auto',
      );
      expect(op?.status).toBe('applied');
      // The mutation landed on the workspace's own store view of the artifact.
      expect(pageHtml(ws.store.getPage(session.artifact, page.id)!)).toBe('new');
    });
  });

  // ======================================================================
  // resolve() — fail CLOSED
  // ======================================================================

  describe('resolve() fails closed', () => {
    let session: CanvasSessionState;

    beforeEach(async () => {
      session = await ws.open();
    });

    it('returns null for every key when the canvas was opened with no origin', () => {
      // The old bug: opening from the command palette left the origin null and
      // linked EVERY panel. An open session alone grants nobody anything.
      expect(ws.resolve('panel-1')).toBeNull();
      expect(ws.resolve('panel-2')).toBeNull();
      expect(ws.resolve('run-42')).toBeNull();
      expect(ws.isBound('panel-1')).toBe(false);
    });

    it('grants only the bound key, never its neighbours', () => {
      ws.bind('panel-1', session.artifactId);
      expect(ws.resolve('panel-1')).toBe(session);
      expect(ws.resolve('panel-2')).toBeNull();
      expect(ws.resolve('panel-10')).toBeNull();
      expect(ws.resolve('panel-1 ')).toBeNull();
      expect(ws.resolve('PANEL-1')).toBeNull();
    });

    it('returns null for an empty key', () => {
      ws.bind('panel-1', session.artifactId);
      expect(ws.resolve('')).toBeNull();
      expect(ws.resolveArtifactId('')).toBeNull();
    });

    it('returns null after unbind', () => {
      ws.bind('panel-1', session.artifactId);
      ws.unbind('panel-1');
      expect(ws.resolve('panel-1')).toBeNull();
    });

    it('returns null when the binding points at an artifact that is not open', async () => {
      const ghost = await seedSaved('ghost', 1_000);
      ws.bind('panel-1', ghost.id);
      expect(ws.resolveArtifactId('panel-1')).toBe(ghost.id);   // the binding exists…
      expect(ws.resolve('panel-1')).toBeNull();                 // …but there is no session
    });

    it('drops bindings when the design is closed', async () => {
      ws.bind('panel-1', session.artifactId);
      ws.bind('run-7', session.artifactId);
      await ws.close(session.artifactId);
      expect(ws.resolve('panel-1')).toBeNull();
      expect(ws.resolve('run-7')).toBeNull();
      expect(ws.resolveArtifactId('panel-1')).toBeNull();
      expect(ws.sessions()).toHaveLength(0);
    });

    it('binds run ids independently of any panel', () => {
      ws.bind('run-bg-1', session.artifactId);
      expect(ws.resolve('run-bg-1')).toBe(session);
      expect(ws.resolve('run-bg-2')).toBeNull();
      expect(ws.resolve(session.panelId ?? 'no-panel')).toBeNull();
    });

    it('reverse-lookups the bound origins of a design, oldest first', async () => {
      const other = await ws.open(undefined, { create: true });
      ws.bind('panel-1', session.artifactId);
      ws.bind('run-7', session.artifactId);
      ws.bind('panel-9', other.artifactId);

      expect(ws.originsFor(session.artifactId)).toEqual(['panel-1', 'run-7']);
      expect(ws.originsFor(other.artifactId)).toEqual(['panel-9']);
      expect(ws.originsFor('unknown')).toEqual([]);
      expect(ws.originsFor('')).toEqual([]);

      ws.unbind('panel-1');
      expect(ws.originsFor(session.artifactId)).toEqual(['run-7']);
    });

    it('rejects a bind with a missing key or artifact id', () => {
      expect(() => ws.bind('', session.artifactId)).toThrow(/required/);
      expect(() => ws.bind('panel-1', '')).toThrow(/required/);
      expect(ws.resolve('panel-1')).toBeNull();
    });
  });

  // ======================================================================
  // Collaborator inheritance
  // ======================================================================

  describe('-collab- derived panels inherit their parent binding', () => {
    let session: CanvasSessionState;

    beforeEach(async () => {
      session = await ws.open();
      ws.bind('panel-1', session.artifactId);
    });

    it('resolves `${panelId}-collab-${runId}-${collaboratorId}` through the parent', () => {
      expect(ws.resolve('panel-1-collab-run7-claude-code')).toBe(session);
      expect(ws.resolve('panel-1-collab-run7-claude-code-2')).toBe(session);
    });

    it('does NOT invent a binding for a collab child of an unbound parent', () => {
      expect(ws.resolve('panel-2-collab-run7-claude-code')).toBeNull();
    });

    it('does not let a prefix collision leak the parent binding', () => {
      // 'panel-10' merely starts with 'panel-1'; it must not inherit.
      expect(ws.resolve('panel-10-collab-run7-c1')).toBeNull();
      expect(ws.resolve('xpanel-1-collab-run7-c1')).toBeNull();
    });

    it('prefers the nearest bound ancestor for a nested delegation', async () => {
      const other = await ws.open(undefined, { create: true });
      ws.bind('panel-1-collab-run7-c1', other.artifactId);
      expect(ws.resolve('panel-1-collab-run7-c1-collab-run8-c2')).toBe(other);
      // A sibling with no binding of its own still falls back to the root.
      expect(ws.resolve('panel-1-collab-run7-c9-collab-run8-c2')).toBe(session);
    });

    it('revokes the child when the parent is unbound', () => {
      ws.unbind('panel-1');
      expect(ws.resolve('panel-1-collab-run7-c1')).toBeNull();
    });

    it('handles a degenerate key that begins with the collab marker', () => {
      expect(ws.resolve('-collab-run7-c1')).toBeNull();
      expect(ws.resolve('-collab-')).toBeNull();
    });
  });

  // ======================================================================
  // Rebinding
  // ======================================================================

  describe('rebinding', () => {
    it('repoints a key at another design without disturbing the first', async () => {
      const a = await ws.open(undefined, { create: true, name: 'A' });
      const b = await ws.open(undefined, { create: true, name: 'B' });

      ws.bind('panel-1', a.artifactId);
      expect(ws.resolve('panel-1')).toBe(a);

      ws.bind('panel-1', b.artifactId);
      expect(ws.resolve('panel-1')).toBe(b);
      expect(ws.resolve('panel-1-collab-r1-c1')).toBe(b);
      expect(ws.get(a.artifactId)).toBe(a);   // A stays open
      expect(ws.sessions()).toHaveLength(2);
    });

    it('re-opening with a new origin adds a binding rather than moving one', async () => {
      const a = await ws.open(undefined, { create: true, origin: 'panel-1' });
      await ws.open(a.artifactId, { origin: 'panel-2' });
      expect(ws.resolve('panel-1')).toBe(a);
      expect(ws.resolve('panel-2')).toBe(a);
    });
  });

  // ======================================================================
  // Multiple designs
  // ======================================================================

  describe('multiple open designs', () => {
    it('keeps sessions keyed by artifactId, each with its own executor and router', async () => {
      const a = await ws.open(undefined, { create: true, name: 'A', origin: 'panel-a' });
      const b = await ws.open(undefined, { create: true, name: 'B', origin: 'panel-b' });

      expect(ws.sessions()).toHaveLength(2);
      expect(a.executor).not.toBe(b.executor);
      expect(a.jobRouter).not.toBe(b.jobRouter);
      expect(a.history).not.toBe(b.history);
      expect(ws.resolve('panel-a')).toBe(a);
      expect(ws.resolve('panel-b')).toBe(b);
      expect(ws.get(a.artifactId)).toBe(a);
      expect(ws.get('nope')).toBeNull();
    });

    it('tags every job event with the artifact it came from', async () => {
      const seen: Array<{ artifactId: string; type: string }> = [];
      ws.setSink(e => seen.push({ artifactId: e.artifactId, type: e.event.type }));
      const a = await ws.open(undefined, { create: true });
      const b = await ws.open(undefined, { create: true });

      a.jobRouter.emit('job-a', { type: 'started', label: 'A' });
      b.jobRouter.emit('job-b', { type: 'started', label: 'B' });

      expect(seen).toEqual([
        { artifactId: a.artifactId, type: 'started' },
        { artifactId: b.artifactId, type: 'started' },
      ]);
    });

    it('tracks the canvas webview panel per design', async () => {
      const a = await ws.open(undefined, { create: true, panelId: 'canvas-1' });
      const b = await ws.open(undefined, { create: true, panelId: 'canvas-2' });
      expect(ws.sessionForPanel('canvas-1')).toBe(a);
      expect(ws.sessionForPanel('canvas-2')).toBe(b);
      expect(ws.sessionForPanel('canvas-3')).toBeNull();

      ws.detachPanel('canvas-1');
      expect(ws.sessionForPanel('canvas-1')).toBeNull();
      expect(a.panelId).toBeNull();

      ws.attachPanel(a.artifactId, 'canvas-9');
      expect(ws.sessionForPanel('canvas-9')).toBe(a);
    });
  });

  // ======================================================================
  // listSummaries()
  // ======================================================================

  describe('listSummaries()', () => {
    it('lists saved designs newest-first', async () => {
      await seedSaved('older', 1_000);
      await seedSaved('newest', 9_000);
      const summaries = await ws.listSummaries();
      expect(summaries.map(s => s.name)).toEqual(['newest', 'older']);
    });

    it('includes an open design that has never been saved', async () => {
      const session = await ws.open(undefined, { create: true, name: 'Unsaved' });
      const summaries = await ws.listSummaries();
      expect(summaries.find(s => s.id === session.artifactId)).toMatchObject({ name: 'Unsaved', pageCount: 0 });
    });

    it('prefers the live session over a stale on-disk snapshot', async () => {
      const saved = await seedSaved('old name', 1_000);
      const session = await ws.open(saved.id);
      session.artifact.name = 'renamed live';
      session.store.insertPage(session.artifact, session.store.makePage({ mode: 'html', htmlSource: 'x' }));

      const summaries = await ws.listSummaries();
      const row = summaries.find(s => s.id === saved.id)!;
      expect(row.name).toBe('renamed live');
      expect(row.pageCount).toBe(1);
      expect(summaries.filter(s => s.id === saved.id)).toHaveLength(1);
    });
  });

  // ======================================================================
  // Persistence
  // ======================================================================

  describe('persistence', () => {
    function savedFile(artifactId: string): CanvasArtifact | null {
      const file = path.join(store.artifactDir(artifactId)!, 'artifact.json');
      if (!fs.existsSync(file)) { return null; }
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as CanvasArtifact;
    }

    it('debounce-saves after an applied op reaches the router', async () => {
      const fast = makeWorkspace({ saveDebounceMs: 1 });
      const session = await fast.open(undefined, { create: true, name: 'Autosaved' });
      expect(savedFile(session.artifactId)).toBeNull();

      session.jobRouter.emit('job-1', { type: 'page_updated', pageId: 'p1' });
      await new Promise(resolve => setTimeout(resolve, 10));
      await fast.flush();

      expect(savedFile(session.artifactId)?.name).toBe('Autosaved');
      fast.dispose();
      await fast.whenFlushed();
    });

    it('does not save on non-mutating events', async () => {
      const fast = makeWorkspace({ saveDebounceMs: 1 });
      const session = await fast.open(undefined, { create: true });
      session.jobRouter.emit('job-1', { type: 'heartbeat', elapsedSeconds: 2 });
      session.jobRouter.emit('job-1', { type: 'op_staged' });
      await new Promise(resolve => setTimeout(resolve, 10));
      await fast.flush();
      expect(savedFile(session.artifactId)).toBeNull();
      fast.dispose();
      await fast.whenFlushed();
    });

    it('save() persists immediately, cancelling the pending debounce', async () => {
      const session = await ws.open(undefined, { create: true, name: 'Now' });
      session.jobRouter.emit('job-1', { type: 'op_applied' });
      await ws.save(session.artifactId);
      expect(savedFile(session.artifactId)?.name).toBe('Now');
    });

    it('close() persists the design before dropping it', async () => {
      const session = await ws.open(undefined, { create: true, name: 'Closing' });
      await ws.close(session.artifactId);
      expect(savedFile(session.artifactId)?.name).toBe('Closing');
    });
  });

  // ======================================================================
  // dispose()
  // ======================================================================

  describe('dispose()', () => {
    it('cancels every live job across every design', async () => {
      const events: Array<{ artifactId: string; type: string; cancelled: boolean }> = [];
      ws.setSink(e => events.push({
        artifactId: e.artifactId,
        type: e.event.type,
        cancelled: (e.event.result as { cancelled?: boolean } | undefined)?.cancelled === true,
      }));
      const a = await ws.open(undefined, { create: true });
      const b = await ws.open(undefined, { create: true });
      a.jobRouter.create('generating');
      b.jobRouter.create('exporting');
      expect(a.jobRouter.activeCount()).toBe(1);

      ws.dispose();

      expect(a.jobRouter.activeCount()).toBe(0);
      expect(b.jobRouter.activeCount()).toBe(0);
      expect(events.filter(e => e.type === 'done' && e.cancelled)).toHaveLength(2);
      await ws.whenFlushed();
    });

    it('flushes pending saves (a long debounce does not lose the design)', async () => {
      const session = await ws.open(undefined, { create: true, name: 'Survivor' });
      session.jobRouter.emit('job-1', { type: 'op_applied' });   // 1000ms debounce armed

      ws.dispose();
      await ws.whenFlushed();

      const file = path.join(store.artifactDir(session.artifactId)!, 'artifact.json');
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).name).toBe('Survivor');
    });

    it('fails closed for everything afterwards', async () => {
      const session = await ws.open(undefined, { create: true, origin: 'panel-1' });
      expect(ws.resolve('panel-1')).toBe(session);

      ws.dispose();
      await ws.whenFlushed();

      expect(ws.disposed).toBe(true);
      expect(ws.resolve('panel-1')).toBeNull();
      expect(ws.resolve('panel-1-collab-r1-c1')).toBeNull();
      ws.bind('panel-2', session.artifactId);          // silently ignored
      expect(ws.resolve('panel-2')).toBeNull();
      await expect(ws.open()).rejects.toThrow(/disposed/);
    });

    it('does not register a session for an open that was in flight when it was disposed', async () => {
      const pending = ws.open(undefined, { create: true, origin: 'panel-1' });
      ws.dispose();
      await expect(pending).rejects.toThrow(/disposed/);
      await ws.whenFlushed();
      expect(ws.sessions()).toHaveLength(0);
      expect(ws.resolve('panel-1')).toBeNull();
    });

    it('is idempotent', async () => {
      await ws.open(undefined, { create: true });
      ws.dispose();
      expect(() => ws.dispose()).not.toThrow();
      await ws.whenFlushed();
    });

    it('stops forwarding job events after disposal', async () => {
      const seen: string[] = [];
      ws.setSink(e => seen.push(e.event.type));
      const session = await ws.open(undefined, { create: true });
      ws.dispose();
      await ws.whenFlushed();
      const before = seen.length;
      session.jobRouter.emit('job-1', { type: 'page_updated', pageId: 'p1' });
      expect(seen).toHaveLength(before);
    });
  });
});
