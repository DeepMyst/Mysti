/**
 * ArtifactStore tests — persistence (atomic write/reload), page primitives with
 * version bumping, op log, and the per-artifact content-addressed asset store,
 * plus the Plan 20 Phase 0 durability contract: `schemaVersion`, validating
 * parse (absent vs corrupt), `.bak` + restore, the `index.json` listing cache,
 * and every asset path routed through the traversal guard.
 * Runs against a real temp dir via an injected root resolver (no vscode.fs mock).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ArtifactStore,
  ArtifactCorruptError,
  ARTIFACT_SCHEMA_VERSION,
} from '../../src/managers/ArtifactStore';
import type { CanvasArtifact } from '../../src/types';
import { pageHtml } from '../../src/canvas/pageMigration';

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

  // ---- helpers -----------------------------------------------------------

  const canvasDir = () => path.join(root, '.mysti', 'canvas');
  const artifactFile = (id: string) => path.join(canvasDir(), id, 'artifact.json');
  const backupFile = (id: string) => path.join(canvasDir(), id, 'artifact.json.bak');
  const indexFile = () => path.join(canvasDir(), 'index.json');
  const readJson = (file: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  const writeRaw = (file: string, contents: string) => fs.writeFileSync(file, contents, 'utf-8');
  const rewriteArtifact = (id: string, mutate: (raw: Record<string, unknown>) => void) => {
    const raw = readJson(artifactFile(id));
    mutate(raw);
    writeRaw(artifactFile(id), JSON.stringify(raw, null, 2));
  };

  /** A saved artifact with one page — the fixture most corruption tests need. */
  async function savedArtifact(name = 'Fixture'): Promise<CanvasArtifact> {
    const a = store.createArtifact({ name });
    store.insertPage(a, store.makePage({ mode: 'html', htmlSource: '<h1>Hi</h1>', actionTitle: 'Cover' }));
    await store.save(a);
    return a;
  }

  /** Assert `load` throws, and hand the error back for inspection. */
  async function loadFailure(id: string): Promise<ArtifactCorruptError> {
    try {
      const loaded = await store.load(id);
      throw new Error(`expected load("${id}") to throw, got ${loaded ? 'an artifact' : 'null'}`);
    } catch (err) {
      if (!ArtifactCorruptError.is(err)) { throw err; }
      return err;
    }
  }

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
      // Document-first storage: an html page keeps its exact source under
      // `legacy` (it is outside the compilable JSX subset), so a reload is
      // still byte-for-byte the same content.
      expect(loaded!.pages[0].legacy).toEqual({ mode: 'html', source: '<h1>Hi</h1>' });
      expect(pageHtml(loaded!.pages[0])).toBe('<h1>Hi</h1>');
      expect(loaded!.pages[0].doc).toBeTruthy();
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
      expect(pageHtml(updated!)).toBe('new');
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

    it('resolveAssetPath confines the result to the assets dir (6.4b traversal guard)', () => {
      const a = store.createArtifact({ name: 'Sec' });
      // `..` in the file segment escapes to the artifact dir (or beyond) → null.
      expect(store.resolveAssetPath(`asset://${a.id}/assets/../artifact.json`)).toBeNull();
      expect(store.resolveAssetPath(`asset://${a.id}/assets/../../../../etc/passwd`)).toBeNull();
      // `..`/backslash artifact ids are rejected outright.
      expect(store.resolveAssetPath('asset://../assets/x.png')).toBeNull();
      expect(store.resolveAssetPath('asset://..\\..\\x/assets/y.png')).toBeNull();
      // The bare assets dir itself is not a valid asset path.
      expect(store.resolveAssetPath(`asset://${a.id}/assets/.`)).toBeNull();
      // Normalization that stays inside the dir still resolves.
      expect(store.resolveAssetPath(`asset://${a.id}/assets/sub/../x.png`))
        .toBe(path.join(store.artifactDir(a.id)!, 'assets', 'x.png'));
      // A plain valid ref is unaffected.
      expect(store.resolveAssetPath(`asset://${a.id}/assets/abc123.png`))
        .toBe(path.join(store.artifactDir(a.id)!, 'assets', 'abc123.png'));
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

  // ========================================================================
  // Plan 20 Phase 0 — schemaVersion
  // ========================================================================

  describe('schemaVersion', () => {
    it('stamps the current schema version on every save', async () => {
      const a = await savedArtifact('Stamped');
      expect(readJson(artifactFile(a.id)).schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    });

    it('keeps the stamp out of the in-memory artifact', async () => {
      const a = await savedArtifact();
      const loaded = await store.load(a.id);
      expect(loaded).not.toBeNull();
      expect('schemaVersion' in (loaded as unknown as Record<string, unknown>)).toBe(false);
    });

    it('re-stamps rather than echoing a stale stamp riding on the object', async () => {
      const a = store.createArtifact({ name: 'Stale stamp' });
      (a as unknown as Record<string, unknown>).schemaVersion = 99;
      await store.save(a);
      expect(readJson(artifactFile(a.id)).schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    });

    it('refuses — loudly — an artifact written by a newer Mysti', async () => {
      const a = await savedArtifact('From the future');
      rewriteArtifact(a.id, raw => { raw.schemaVersion = ARTIFACT_SCHEMA_VERSION + 1; });

      const err = await loadFailure(a.id);
      expect(err.problem).toBe('schema-too-new');
      expect(err.artifactId).toBe(a.id);
      expect(err.filePath).toBe(artifactFile(a.id));
      // The design is untouched — a newer Mysti can still open it.
      expect(readJson(artifactFile(a.id)).name).toBe('From the future');
    });

    it('accepts a pre-Plan-20 file that carries no stamp at all', async () => {
      const a = await savedArtifact('Legacy');
      rewriteArtifact(a.id, raw => { delete raw.schemaVersion; });
      const loaded = await store.load(a.id);
      expect(loaded!.name).toBe('Legacy');
      expect(loaded!.pages).toHaveLength(1);
    });

    it('rejects a non-integer stamp as corruption', async () => {
      const a = await savedArtifact();
      rewriteArtifact(a.id, raw => { raw.schemaVersion = 'one'; });
      expect((await loadFailure(a.id)).problem).toBe('invalid-shape');
    });
  });

  // ========================================================================
  // Plan 20 Phase 0 — absent vs corrupt
  // ========================================================================

  describe('load distinguishes absent from corrupt', () => {
    it('a design that never existed is absent (null), not an error', async () => {
      expect(await store.load('never-existed')).toBeNull();
    });

    it('unparseable JSON throws instead of degrading to null, and touches nothing', async () => {
      const a = await savedArtifact('Precious');
      writeRaw(artifactFile(a.id), '{ "id": "half-written",');

      const err = await loadFailure(a.id);
      expect(err.problem).toBe('unparseable');
      expect(err.artifactId).toBe(a.id);
      expect(err.filePath).toBe(artifactFile(a.id));
      expect(err.message).toContain(a.id);
      // The bytes the user can still see on disk are exactly as they were.
      expect(fs.readFileSync(artifactFile(a.id), 'utf-8')).toBe('{ "id": "half-written",');
    });

    it('an unreadable primary (a directory in its place) throws', async () => {
      const a = await savedArtifact();
      fs.unlinkSync(artifactFile(a.id));
      fs.mkdirSync(artifactFile(a.id));
      expect((await loadFailure(a.id)).problem).toBe('unreadable');
    });

    it('ArtifactCorruptError.is recognises the error by name across bundles', async () => {
      const a = await savedArtifact();
      writeRaw(artifactFile(a.id), 'not json at all');
      const err = await loadFailure(a.id);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ArtifactCorruptError');
      expect(ArtifactCorruptError.is({ name: 'ArtifactCorruptError' })).toBe(true);
      expect(ArtifactCorruptError.is(new Error('boom'))).toBe(false);
      expect(ArtifactCorruptError.is(null)).toBe(false);
    });

    const shapeBreakers: Array<[string, (raw: Record<string, unknown>) => void]> = [
      ['the top level is an array', raw => { Object.keys(raw).forEach(k => delete raw[k]); }],
      ['id is empty', raw => { raw.id = ''; }],
      ['kind is unknown', raw => { raw.kind = 'poster'; }],
      ['version is missing', raw => { delete raw.version; }],
      ['updatedAt is a string', raw => { raw.updatedAt = 'yesterday'; }],
      ['format is gone', raw => { delete raw.format; }],
      ['format has no numeric size', raw => { (raw.format as Record<string, unknown>).width = 'wide'; }],
      ['theme.colors is gone', raw => { delete (raw.theme as Record<string, unknown>).colors; }],
      ['pages is not an array', raw => { raw.pages = 'nope'; }],
      ['a page is not an object', raw => { raw.pages = ['just a string']; }],
      ['a page has no id', raw => { (raw.pages as Record<string, unknown>[])[0].id = ''; }],
      ['a page has no version', raw => { delete (raw.pages as Record<string, unknown>[])[0].version; }],
      // Plan 22 §3.1: `mode` is gone as a concept, but the rule it encoded —
      // a page whose CONTENT shape is unrecognisable is corruption, not merely
      // an old file — still holds, now expressed against doc/legacy.
      ['a page has neither a doc nor a legacy source', raw => {
        const page = (raw.pages as Record<string, unknown>[])[0];
        delete page.doc; delete page.legacy; delete page.htmlSource; delete page.jsxSource; delete page.nodes;
      }],
      ['a page doc is not an object', raw => {
        const page = (raw.pages as Record<string, unknown>[])[0];
        page.doc = 'not a tree';
      }],
      ['a page source is not a string', raw => { (raw.pages as Record<string, unknown>[])[0].htmlSource = 42; }],
      ['two pages share an id', raw => {
        const pages = raw.pages as Record<string, unknown>[];
        pages.push({ ...pages[0] });
      }],
      ['assets is an object', raw => { raw.assets = {}; }],
      ['opLog is a string', raw => { raw.opLog = 'none'; }],
    ];

    for (const [label, mutate] of shapeBreakers) {
      it(`throws invalid-shape when ${label}`, async () => {
        const a = await savedArtifact();
        rewriteArtifact(a.id, mutate);
        expect((await loadFailure(a.id)).problem).toBe('invalid-shape');
      });
    }

    it('normalises a legacy file that predates assets/opLog', async () => {
      const a = await savedArtifact('Ancient');
      rewriteArtifact(a.id, raw => { delete raw.assets; delete raw.opLog; });
      const loaded = await store.load(a.id);
      expect(loaded!.assets).toEqual([]);
      expect(loaded!.opLog).toEqual([]);
    });

    it('preserves fields it does not know about (forward compatibility)', async () => {
      const a = await savedArtifact();
      rewriteArtifact(a.id, raw => { raw.versions = [{ sha: 'abc' }]; });
      const loaded = await store.load(a.id);
      expect((loaded as unknown as Record<string, unknown>).versions).toEqual([{ sha: 'abc' }]);
    });
  });

  // ========================================================================
  // Plan 20 Phase 0 — .bak
  // ========================================================================

  describe('backup (.bak)', () => {
    it('keeps the previous good copy alongside each save', async () => {
      const a = store.createArtifact({ name: 'v1' });
      await store.save(a);
      expect(fs.existsSync(backupFile(a.id))).toBe(false);   // nothing to back up yet

      a.name = 'v2';
      await store.save(a);
      expect(readJson(backupFile(a.id)).name).toBe('v1');
      expect(readJson(artifactFile(a.id)).name).toBe('v2');
    });

    it('reports a restorable backup when the primary goes corrupt', async () => {
      const a = await savedArtifact('Recoverable');
      a.name = 'Recoverable v2';
      await store.save(a);
      writeRaw(artifactFile(a.id), '@@@ garbage @@@');

      const err = await loadFailure(a.id);
      expect(err.problem).toBe('unparseable');
      expect(err.restorable).toBe(true);
      expect(err.backup!.valid).toBe(true);
      expect(err.backup!.path).toBe(backupFile(a.id));
      expect(err.backup!.artifact!.name).toBe('Recoverable');
      expect(typeof err.backup!.savedAt).toBe('number');
      // Reporting only — the corrupt primary is still the primary.
      expect(fs.readFileSync(artifactFile(a.id), 'utf-8')).toBe('@@@ garbage @@@');
    });

    it('restoreFromBackup promotes the backup and parks the corrupt primary', async () => {
      const a = await savedArtifact('Good');
      a.name = 'Newer';
      await store.save(a);
      writeRaw(artifactFile(a.id), 'corrupt');

      const restored = await store.restoreFromBackup(a.id);
      expect(restored!.name).toBe('Good');
      expect((await store.load(a.id))!.name).toBe('Good');
      // The corrupt bytes are parked, not destroyed.
      const parked = path.join(canvasDir(), a.id, 'artifact.json.corrupt');
      expect(fs.readFileSync(parked, 'utf-8')).toBe('corrupt');
    });

    it('restoreFromBackup returns null when there is nothing usable', async () => {
      const a = await savedArtifact();
      expect(await store.restoreFromBackup(a.id)).toBeNull();        // no .bak at all
      a.name = 'second';
      await store.save(a);
      writeRaw(backupFile(a.id), 'also corrupt');
      expect(await store.restoreFromBackup(a.id)).toBeNull();        // .bak unusable
      expect(await store.restoreFromBackup('no-such-design')).toBeNull();
    });

    it('never overwrites a good backup with corrupt bytes', async () => {
      const a = store.createArtifact({ name: 'A' });
      await store.save(a);
      a.name = 'B';
      await store.save(a);                                   // .bak = A
      writeRaw(artifactFile(a.id), 'corrupted by something else');

      a.name = 'C';
      await store.save(a);                                   // must NOT back up the garbage

      expect(readJson(backupFile(a.id)).name).toBe('A');
      expect((await store.load(a.id))!.name).toBe('C');
    });

    it('reports an unusable backup rather than pretending it is fine', async () => {
      const a = await savedArtifact();
      a.name = 'second';
      await store.save(a);
      writeRaw(artifactFile(a.id), 'corrupt');
      writeRaw(backupFile(a.id), 'also corrupt');

      const err = await loadFailure(a.id);
      expect(err.restorable).toBe(false);
      expect(err.backup!.valid).toBe(false);
      expect(err.backup!.problem).toBe('unparseable');
      expect(err.backup!.artifact).toBeNull();
    });

    it('a missing primary with a valid backup is corrupt, not absent', async () => {
      const a = await savedArtifact('Beheaded');
      a.name = 'Beheaded v2';
      await store.save(a);
      fs.unlinkSync(artifactFile(a.id));

      const err = await loadFailure(a.id);
      expect(err.problem).toBe('unreadable');
      expect(err.restorable).toBe(true);
      expect((await store.restoreFromBackup(a.id))!.name).toBe('Beheaded');
    });

    it('a directory holding only stray files is still absent', async () => {
      const dir = path.join(canvasDir(), 'not-a-design');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
      expect(await store.load('not-a-design')).toBeNull();
      expect(await store.list()).toEqual([]);
    });
  });

  // ========================================================================
  // Plan 20 Phase 0 — index.json is a cache, never the truth
  // ========================================================================

  describe('listing index', () => {
    it('writes an index and serves the same rows from it', async () => {
      const a1 = await savedArtifact('First');
      const a2 = await savedArtifact('Second');

      const first = await store.list();
      expect(fs.existsSync(indexFile())).toBe(true);
      const entries = readJson(indexFile()).entries as Record<string, Record<string, unknown>>;
      expect(Object.keys(entries).sort()).toEqual([a1.id, a2.id].sort());
      expect(entries[a1.id].pageCount).toBe(1);

      const second = await store.list();      // now served from the cache
      expect(second).toEqual(first);
    });

    it('never lets a stale index hide a real artifact', async () => {
      const a1 = await savedArtifact('Visible');
      const a2 = await savedArtifact('Also visible');
      await store.list();

      // An index that has forgotten everything must not make designs disappear.
      writeRaw(indexFile(), JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, entries: {} }));
      const names = (await store.list()).map(s => s.name).sort();
      expect(names).toEqual(['Also visible', 'Visible']);

      // …and the cache is repaired from disk.
      const entries = readJson(indexFile()).entries as Record<string, unknown>;
      expect(Object.keys(entries).sort()).toEqual([a1.id, a2.id].sort());
    });

    it('an unparseable index is a cache miss, not a failure', async () => {
      const a = await savedArtifact('Survives');
      await store.list();
      writeRaw(indexFile(), 'not json');
      expect((await store.list()).map(s => s.name)).toEqual(['Survives']);
      expect(readJson(indexFile()).schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
      expect(await store.load(a.id)).not.toBeNull();
    });

    it('ignores an index written by a newer schema', async () => {
      await savedArtifact('Real');
      writeRaw(indexFile(), JSON.stringify({
        schemaVersion: ARTIFACT_SCHEMA_VERSION + 1,
        entries: { ghost: { id: 'ghost', name: 'Ghost', kind: 'deck', pageCount: 9, updatedAt: 1, mtimeMs: 1, size: 1 } },
      }));
      const list = await store.list();
      expect(list.map(s => s.name)).toEqual(['Real']);
    });

    it('drops rows whose design no longer exists on disk', async () => {
      const a = await savedArtifact('Alive');
      await store.list();
      const index = readJson(indexFile()) as { entries: Record<string, unknown> };
      index.entries.phantom = { id: 'phantom', name: 'Phantom', kind: 'deck', pageCount: 3, updatedAt: Date.now(), mtimeMs: 1, size: 1 };
      writeRaw(indexFile(), JSON.stringify(index));

      const list = await store.list();
      expect(list.map(s => s.id)).toEqual([a.id]);
      expect(Object.keys((readJson(indexFile()).entries as Record<string, unknown>))).toEqual([a.id]);
    });

    it('re-reads an artifact edited out of band (the index is only a fingerprint)', async () => {
      const a = await savedArtifact('Before');
      await store.list();
      rewriteArtifact(a.id, raw => { raw.name = 'After'; raw.updatedAt = Date.now() + 5_000; });

      const list = await store.list();
      expect(list.map(s => s.name)).toEqual(['After']);
    });

    it('drops index rows that are themselves malformed', async () => {
      const a = await savedArtifact('Rebuilt');
      await store.list();
      writeRaw(indexFile(), JSON.stringify({
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        entries: { [a.id]: { id: a.id, name: 'Rebuilt', kind: 'screens' } },   // no fingerprint
      }));
      expect((await store.list()).map(s => s.name)).toEqual(['Rebuilt']);
      const entry = (readJson(indexFile()).entries as Record<string, Record<string, unknown>>)[a.id];
      expect(typeof entry.mtimeMs).toBe('number');
      expect(typeof entry.size).toBe('number');
    });

    it('keeps a corrupt design in the list, marked, with its last known name', async () => {
      const good = await savedArtifact('Real Design');
      await store.list();                       // caches name + pageCount
      writeRaw(artifactFile(good.id), 'corrupt');

      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(good.id);
      expect(list[0].name).toBe('Real Design');
      expect(list[0].corrupt).toBe(true);
    });

    it('lists a corrupt design even when it was never indexed', async () => {
      const a = await savedArtifact('Unknown');
      writeRaw(artifactFile(a.id), 'corrupt');
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0].corrupt).toBe(true);
      expect(list[0].id).toBe(a.id);
    });

    it('prunes the index when a design is deleted', async () => {
      const a = await savedArtifact('Doomed');
      const b = await savedArtifact('Kept');
      await store.list();
      await store.delete(a.id);

      expect(Object.keys(readJson(indexFile()).entries as Record<string, unknown>)).toEqual([b.id]);
      expect((await store.list()).map(s => s.id)).toEqual([b.id]);
    });

    it('does not mistake index.json for a design', async () => {
      await savedArtifact('Only one');
      await store.list();
      expect((await store.list()).map(s => s.name)).toEqual(['Only one']);
    });

    it('survives concurrent saves without losing rows', async () => {
      const a1 = store.createArtifact({ name: 'Race 1' });
      const a2 = store.createArtifact({ name: 'Race 2' });
      const a3 = store.createArtifact({ name: 'Race 3' });
      await Promise.all([store.save(a1), store.save(a2), store.save(a3)]);
      const entries = readJson(indexFile()).entries as Record<string, unknown>;
      expect(Object.keys(entries).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    });
  });

  // ========================================================================
  // Plan 20 Phase 0 — every asset path goes through the guard
  // ========================================================================

  describe('asset paths route through resolveAssetPath', () => {
    it('artifactDir rejects an id that is not a single path segment', () => {
      expect(store.artifactDir('..')).toBeNull();
      expect(store.artifactDir('.')).toBeNull();
      expect(store.artifactDir('')).toBeNull();
      expect(store.artifactDir('a/b')).toBeNull();
      expect(store.artifactDir('a\\b')).toBeNull();
      expect(store.artifactDir('ok-id')).toBe(path.join(canvasDir(), 'ok-id'));
    });

    it('addAsset refuses to write for a traversing artifact id', async () => {
      const a = store.createArtifact({ name: 'Hostile' });
      const png = Buffer.from('payload').toString('base64');
      for (const hostileId of ['../escape', '..\\..\\escape', 'nested/id', '..']) {
        (a as unknown as Record<string, unknown>).id = hostileId;
        expect(await store.addAsset(a, png, 'image/png', { role: 'image' })).toBeNull();
      }
      expect(a.assets).toHaveLength(0);
      expect(fs.existsSync(path.join(root, '.mysti', 'escape'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.mysti', 'canvas', 'nested'))).toBe(false);
    });

    it('writes exactly where the guard says, and nowhere else', async () => {
      const a = store.createArtifact({ name: 'Media' });
      const rec = await store.addAsset(a, Buffer.from('bytes').toString('base64'), 'image/png', { role: 'image' });
      const guarded = store.resolveAssetPath(rec!.ref)!;
      expect(fs.existsSync(guarded)).toBe(true);
      expect(path.dirname(guarded)).toBe(path.join(canvasDir(), a.id, 'assets'));
      expect(fs.readdirSync(path.dirname(guarded))).toEqual([path.basename(guarded)]);
    });

    it('resolveAssetPathForId re-uses the guard rather than trusting the record', async () => {
      const a = store.createArtifact({ name: 'Media' });
      const rec = await store.addAsset(a, Buffer.from('x').toString('base64'), 'image/png', { role: 'image' });
      expect(store.resolveAssetPathForId(a, rec!.id)).toBe(store.resolveAssetPath(rec!.ref));
      expect(store.resolveAssetPathForId(a, 'no-such-asset')).toBeNull();

      // A record forged into the artifact (corrupt file / model payload) is a
      // ref like any other: the guard, not the registry, decides.
      a.assets.push({ id: 'forged', role: 'image', ref: `asset://${a.id}/assets/../../../../etc/passwd`, ts: Date.now() });
      expect(store.resolveAssetPathForId(a, 'forged')).toBeNull();
    });

    it('readAssetBytes round-trips real bytes and refuses traversal', async () => {
      const a = store.createArtifact({ name: 'Media' });
      await store.save(a);
      const rec = await store.addAsset(a, Buffer.from('real bytes').toString('base64'), 'image/png', { role: 'image' });

      expect((await store.readAssetBytes(rec!.ref))!.toString()).toBe('real bytes');
      // artifact.json exists and is readable — the guard is what stops this.
      expect(await store.readAssetBytes(`asset://${a.id}/assets/../artifact.json`)).toBeNull();
      expect(await store.readAssetBytes(`asset://${a.id}/assets/missing.png`)).toBeNull();
      expect(await store.readAssetBytes('not-an-asset-ref')).toBeNull();
    });

    it('rejects a NUL byte instead of leaking it into a path', () => {
      const a = store.createArtifact({ name: 'Sec' });
      expect(store.resolveAssetPath(`asset://${a.id}/assets/evil\u0000.png`)).toBeNull();
      expect(store.resolveAssetPath(`asset://${a.id}\u0000/assets/x.png`)).toBeNull();
    });
  });
});
