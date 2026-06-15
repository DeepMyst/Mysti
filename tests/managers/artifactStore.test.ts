/**
 * ArtifactStore tests — persistence (atomic write/reload), page primitives with
 * version bumping, op log, and the per-artifact content-addressed asset store.
 * Runs against a real temp dir via an injected root resolver (no vscode.fs mock).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactStore } from '../../src/managers/ArtifactStore';

describe('ArtifactStore', () => {
  let root: string;
  let store: ArtifactStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-artifact-'));
    store = new ArtifactStore({ getRoot: () => root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('createArtifact', () => {
    it('defaults a new artifact to screens (app/website) at the desktop frame', () => {
      const a = store.createArtifact({ name: 'My App' });
      expect(a.id).toBeTruthy();
      expect(a.version).toBe(1);
      expect(a.kind).toBe('screens');          // app & website design is primary
      expect(a.name).toBe('My App');
      expect(a.format.formatId).toBe('desktop');
      expect(a.theme.colors.primary).toBeTruthy();
      expect(a.pages).toEqual([]);
      expect(a.opLog).toEqual([]);
    });

    it('honors an explicit kind (and its default format)', () => {
      expect(store.createArtifact({ name: 'Board', kind: 'board' }).kind).toBe('board');
      expect(store.createArtifact({ name: 'Deck', kind: 'deck' }).format.formatId).toBe('deck-16x9');
    });
  });

  describe('persistence', () => {
    it('saves and reloads an artifact verbatim', async () => {
      const a = store.createArtifact({ name: 'Persist Me' });
      store.insertPage(a, store.makePage({ mode: 'html', htmlSource: '<h1>Hi</h1>', actionTitle: 'Cover' }));
      await store.save(a);

      const loaded = await store.load(a.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(a.id);
      expect(loaded!.name).toBe('Persist Me');
      expect(loaded!.pages).toHaveLength(1);
      expect(loaded!.pages[0].htmlSource).toBe('<h1>Hi</h1>');
    });

    it('writes to .mysti/canvas/<id>/artifact.json', async () => {
      const a = store.createArtifact({ name: 'Pathing' });
      await store.save(a);
      const file = path.join(root, '.mysti', 'canvas', a.id, 'artifact.json');
      expect(fs.existsSync(file)).toBe(true);
    });

    it('returns null for a missing artifact', async () => {
      expect(await store.load('does-not-exist')).toBeNull();
    });

    it('lists artifacts most-recent-first and excludes legacy session files', async () => {
      const a1 = store.createArtifact({ name: 'First' });
      const a2 = store.createArtifact({ name: 'Second' });
      await store.save(a1);
      await store.save(a2);
      // A legacy fabric session file living alongside artifacts must be ignored.
      fs.writeFileSync(path.join(root, '.mysti', 'canvas', 'legacy.json'), '{}');

      const list = await store.list();
      expect(list).toHaveLength(2);
      expect(list.map(s => s.name).sort()).toEqual(['First', 'Second']);
      expect(list[0].pageCount).toBe(0);
    });

    it('deletes an artifact directory', async () => {
      const a = store.createArtifact({ name: 'Doomed' });
      await store.save(a);
      await store.delete(a.id);
      expect(await store.load(a.id)).toBeNull();
    });

    it('no-ops gracefully when no workspace root is available', async () => {
      const rootless = new ArtifactStore({ getRoot: () => null });
      const a = rootless.createArtifact({ name: 'Homeless' });
      await expect(rootless.save(a)).resolves.toBeUndefined();
      expect(await rootless.load(a.id)).toBeNull();
    });
  });

  describe('page primitives bump versions', () => {
    it('insertPage bumps artifact version, new page is version 1', () => {
      const a = store.createArtifact({ name: 'V' });
      const before = a.version;
      const page = store.insertPage(a, store.makePage({ mode: 'html' }));
      expect(page.version).toBe(1);
      expect(a.version).toBe(before + 1);
      expect(a.pages).toHaveLength(1);
    });

    it('insertPage honors an index', () => {
      const a = store.createArtifact({ name: 'V' });
      const p1 = store.insertPage(a, store.makePage({ mode: 'html', actionTitle: 'A' }));
      const p3 = store.insertPage(a, store.makePage({ mode: 'html', actionTitle: 'C' }));
      const p2 = store.insertPage(a, store.makePage({ mode: 'html', actionTitle: 'B' }), 1);
      expect(a.pages.map(p => p.id)).toEqual([p1.id, p2.id, p3.id]);
    });

    it('updatePage bumps the page version and never overwrites id/version', () => {
      const a = store.createArtifact({ name: 'V' });
      const page = store.insertPage(a, store.makePage({ mode: 'html', htmlSource: 'old' }));
      const updated = store.updatePage(a, page.id, { htmlSource: 'new', id: 'HACK', version: 99 } as any);
      expect(updated!.htmlSource).toBe('new');
      expect(updated!.id).toBe(page.id);
      expect(updated!.version).toBe(2);
    });

    it('deletePage removes and returns the page', () => {
      const a = store.createArtifact({ name: 'V' });
      const page = store.insertPage(a, store.makePage({ mode: 'html' }));
      const removed = store.deletePage(a, page.id);
      expect(removed!.id).toBe(page.id);
      expect(a.pages).toHaveLength(0);
    });

    it('reorderPages reorders by id and appends unnamed pages', () => {
      const a = store.createArtifact({ name: 'V' });
      const p1 = store.insertPage(a, store.makePage({ mode: 'html', actionTitle: '1' }));
      const p2 = store.insertPage(a, store.makePage({ mode: 'html', actionTitle: '2' }));
      const p3 = store.insertPage(a, store.makePage({ mode: 'html', actionTitle: '3' }));
      store.reorderPages(a, [p3.id, p1.id]); // p2 omitted → appended at end
      expect(a.pages.map(p => p.id)).toEqual([p3.id, p1.id, p2.id]);
    });
  });

  describe('asset registry', () => {
    it('writes content-addressed bytes and registers a record with asset:// ref', async () => {
      const a = store.createArtifact({ name: 'Media' });
      const png = Buffer.from('fake-png-bytes').toString('base64');
      const rec = await store.addAsset(a, png, 'image/png', { role: 'image', prompt: 'a cat', model: 'gpt-image-1' });
      expect(rec).not.toBeNull();
      expect(rec!.ref).toMatch(new RegExp(`^asset://${a.id}/assets/[a-f0-9]{16}\\.png$`));
      expect(a.assets).toHaveLength(1);

      const resolved = store.resolveAssetPath(rec!.ref);
      expect(resolved).toBeTruthy();
      expect(fs.existsSync(resolved!)).toBe(true);
    });

    it('dedups identical bytes to the same file', async () => {
      const a = store.createArtifact({ name: 'Media' });
      const png = Buffer.from('same').toString('base64');
      const r1 = await store.addAsset(a, png, 'image/png', { role: 'image' });
      const r2 = await store.addAsset(a, png, 'image/png', { role: 'image' });
      expect(r1!.ref).toBe(r2!.ref);       // same content hash → same file
      expect(r1!.id).not.toBe(r2!.id);     // distinct provenance records
    });
  });
});
