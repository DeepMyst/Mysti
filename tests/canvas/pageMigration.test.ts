/**
 * pageMigration tests (Plan 22 §3.1) — upgrading persisted artifacts to the
 * document model.
 *
 * The three properties the whole migration rests on are asserted adversarially,
 * not by example: it NEVER loses a page (a source outside the JSX subset comes
 * back byte-for-byte, a junk object still yields a renderable artboard), it is
 * IDEMPOTENT (a second pass preserves every mid, so pins and comments survive
 * a reload), and it NEVER throws (one bad page must not turn into "no design").
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  boardPosForIndex,
  docFromDesignNodes,
  emptyDoc,
  isDocNode,
  migrateArtifactPages,
  migratePage,
  pageHtml,
  pageJsx,
  pageMode,
  pageSource,
  pageWire,
  refreshJsxCache,
} from '../../src/canvas/pageMigration';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { collectMids, walk } from '../../src/canvas/doc/DocNode';
import { PAGE_SCAFFOLDS } from '../../src/managers/CanvasScaffolds';
import type { CanvasArtifact } from '../../src/types';

const JSX_OK = 'function Page(){ return <UI.Screen><UI.Heading>Sign in</UI.Heading></UI.Screen>; }';
/** Outside the subset: a local template-literal binding used as a child. */
const JSX_BAD = 'function Page(){ const s = `a ``` b`; return <UI.Screen>{s}</UI.Screen>; }';

function legacyArtifact(pages: unknown[]): CanvasArtifact {
  const store = new ArtifactStore({ getRoot: () => null });
  const a = store.createArtifact({ name: 'Old' });
  (a as unknown as { pages: unknown[] }).pages = pages;
  return a;
}

describe('pageMigration', () => {
  describe('compiling old pages', () => {
    it('compiles a jsx page into a document and derives the mid-annotated cache', () => {
      const { page, outcome } = migratePage({ id: 'p1', version: 3, mode: 'jsx', jsxSource: JSX_OK });
      expect(outcome).toBe('compiled');
      expect(page.legacy).toBeUndefined();
      expect(page.compileError).toBeUndefined();
      expect(page.doc.tag).toBe('UI.Screen');
      expect(page.jsxCache).toContain('mid=');
      expect(page.version).toBe(3);           // version bookkeeping is preserved
      expect(page.id).toBe('p1');
    });

    it('parks a jsx page outside the subset as legacy, byte-for-byte, and says why', () => {
      const { page, outcome } = migratePage({ id: 'p1', version: 1, mode: 'jsx', jsxSource: JSX_BAD });
      expect(outcome).toBe('legacy');
      expect(page.legacy).toEqual({ mode: 'jsx', source: JSX_BAD });
      expect(page.compileError).toBeTruthy();
      expect(pageJsx(page)).toBe(JSX_BAD);     // still renders, nothing lost
      expect(isDocNode(page.doc)).toBe(true);  // and `doc` is never absent
    });

    it('parks an html page as legacy html — markup is not in the JSX subset', () => {
      const { page, outcome } = migratePage({ id: 'p1', version: 1, mode: 'html', htmlSource: '<h1>Hi</h1>' });
      expect(outcome).toBe('legacy');
      expect(pageMode(page)).toBe('html');
      expect(pageHtml(page)).toBe('<h1>Hi</h1>');
      expect(pageJsx(page)).toBe('');
      expect(pageSource(page)).toBe('<h1>Hi</h1>');
      // An html page never compiled, so it carries no compile ERROR — it is
      // simply a different kind of content, and the rail badges it as such.
      expect(page.compileError).toBeUndefined();
    });

    it('transcodes a structured-mode page rather than blanking it', () => {
      const { page, outcome } = migratePage({
        id: 'p1', version: 1, mode: 'structured',
        nodes: [{
          id: 'n1', type: 'section', name: 'Hero', x: 0, y: 0, width: 100, height: 40,
          layout: { display: 'block' }, style: { background: '#fff' }, text: 'Hello',
        }],
      });
      expect(outcome).toBe('compiled');
      expect([...walk(page.doc)]).toHaveLength(2);
      expect([...walk(page.doc)][1].text).toBe('Hello');
    });

    it('every shipped scaffold compiles — the subset covers our own content', () => {
      for (const scaffold of PAGE_SCAFFOLDS) {
        const { page } = migratePage({ id: scaffold.id, version: 1, mode: 'jsx', jsxSource: scaffold.jsx });
        expect(page.compileError, `${scaffold.id} must compile`).toBeUndefined();
        expect(page.legacy, `${scaffold.id} must not be legacy`).toBeUndefined();
      }
    });
  });

  describe('never loses a page', () => {
    it('rebuilds a structurally junk page instead of dropping it', () => {
      const artifact = legacyArtifact([null, 42, 'a page', { }, []]);
      const report = migrateArtifactPages(artifact);
      expect(artifact.pages).toHaveLength(5);
      for (const p of artifact.pages) {
        expect(typeof p.id).toBe('string');
        expect(p.id.length).toBeGreaterThan(0);
        expect(isDocNode(p.doc)).toBe(true);
        expect(p.boardPos).toBeTruthy();
      }
      expect(report.repaired).toBe(5);
    });

    it('re-ids a duplicate page rather than collapsing two artboards into one', () => {
      const artifact = legacyArtifact([
        { id: 'dup', version: 1, mode: 'html', htmlSource: 'one' },
        { id: 'dup', version: 1, mode: 'html', htmlSource: 'two' },
      ]);
      migrateArtifactPages(artifact);
      expect(artifact.pages).toHaveLength(2);
      expect(artifact.pages[0].id).not.toBe(artifact.pages[1].id);
      expect(pageHtml(artifact.pages[0])).toBe('one');
      expect(pageHtml(artifact.pages[1])).toBe('two');
    });

    it('keeps an empty-source page as a page (not a hole in the rail)', () => {
      const { page } = migratePage({ id: 'p1', version: 1, mode: 'html', htmlSource: '' });
      expect(page.id).toBe('p1');
      expect(page.legacy).toEqual({ mode: 'html', source: '' });
    });

    it('survives a pages array that is not an array', () => {
      const artifact = legacyArtifact([]);
      (artifact as unknown as { pages: unknown }).pages = 'nope';
      expect(() => migrateArtifactPages(artifact)).not.toThrow();
      expect(artifact.pages).toEqual([]);
    });

    it('does not throw on a hostile self-referential page object', () => {
      const cyclic: Record<string, unknown> = { id: 'c', version: 1, mode: 'jsx' };
      cyclic.self = cyclic;
      cyclic.doc = cyclic;                  // claims to be a document, is not
      expect(() => migratePage(cyclic)).not.toThrow();
      const { page } = migratePage(cyclic);
      expect(isDocNode(page.doc)).toBe(true);
    });
  });

  describe('idempotence', () => {
    it('a second migration is a no-op and preserves every mid', () => {
      const artifact = legacyArtifact([
        { id: 'a', version: 1, mode: 'jsx', jsxSource: JSX_OK },
        { id: 'b', version: 1, mode: 'html', htmlSource: '<h1>Hi</h1>' },
        { id: 'c', version: 1, mode: 'jsx', jsxSource: JSX_BAD },
      ]);
      const first = migrateArtifactPages(artifact);
      expect(first.compiled).toBe(1);
      expect(first.legacy).toBe(2);
      const snapshot = JSON.parse(JSON.stringify(artifact.pages));
      const mids = artifact.pages.map(p => [...collectMids(p.doc)]);

      const second = migrateArtifactPages(artifact);
      expect(second).toEqual({ alreadyDocFirst: 3, compiled: 0, legacy: 0, repaired: 0, errors: expect.any(Object) });
      expect(artifact.pages).toEqual(snapshot);
      expect(artifact.pages.map(p => [...collectMids(p.doc)])).toEqual(mids);
    });

    it('keeps human pins across a migration — mids are what pins hang on', () => {
      const { page } = migratePage({ id: 'p', version: 1, mode: 'jsx', jsxSource: JSX_OK });
      const leaf = [...walk(page.doc)].find(n => n.text !== undefined)!;
      leaf.pins = { text: { at: 1, opId: 'op-1' } };
      const again = migratePage(JSON.parse(JSON.stringify(page)));
      const sameLeaf = [...walk(again.page.doc)].find(n => n.mid === leaf.mid)!;
      expect(sameLeaf.pins).toEqual({ text: { at: 1, opId: 'op-1' } });
    });
  });

  describe('board layout', () => {
    it('lays pages out in rows and preserves an explicit boardPos', () => {
      expect(boardPosForIndex(0)).toEqual({ x: 0, y: 0 });
      expect(boardPosForIndex(4)).toEqual({ x: 0, y: 1200 });
      const { page } = migratePage({ id: 'p', version: 1, mode: 'html', htmlSource: 'x', boardPos: { x: 7, y: 9 } });
      expect(page.boardPos).toEqual({ x: 7, y: 9 });
    });

    it('ignores a non-numeric boardPos rather than persisting NaN geometry', () => {
      const { page } = migratePage(
        { id: 'p', version: 1, mode: 'html', htmlSource: 'x', boardPos: { x: 'left', y: null } },
        { index: 1 },
      );
      expect(page.boardPos).toEqual(boardPosForIndex(1));
    });
  });

  describe('compatibility accessors', () => {
    it('pageWire exposes mode/jsxSource/htmlSource without storing them', () => {
      const jsx = migratePage({ id: 'a', version: 2, mode: 'jsx', jsxSource: JSX_OK }).page;
      const html = migratePage({ id: 'b', version: 1, mode: 'html', htmlSource: '<h1>Hi</h1>' }).page;

      const wj = pageWire(jsx);
      expect(wj.mode).toBe('jsx');
      expect(wj.jsxSource).toContain('function Page()');
      expect(wj.htmlSource).toBeUndefined();
      expect(wj.legacy).toBe(false);

      const wh = pageWire(html);
      expect(wh.mode).toBe('html');
      expect(wh.htmlSource).toBe('<h1>Hi</h1>');
      expect(wh.legacy).toBe(true);

      // The stored page never grows the deleted fields back.
      expect(Object.keys(jsx)).not.toContain('jsxSource');
      expect(Object.keys(html)).not.toContain('htmlSource');
      expect(Object.keys(html)).not.toContain('mode');
    });

    it('pageJsx re-emits from the document when the cache was dropped', () => {
      const { page } = migratePage({ id: 'a', version: 1, mode: 'jsx', jsxSource: JSX_OK });
      delete page.jsxCache;
      expect(pageJsx(page)).toContain('function Page()');
      refreshJsxCache(page);
      expect(page.jsxCache).toContain('mid=');
    });
  });

  describe('helpers', () => {
    it('isDocNode rejects the shapes a corrupt file produces', () => {
      expect(isDocNode(emptyDoc())).toBe(true);
      expect(isDocNode(null)).toBe(false);
      expect(isDocNode([])).toBe(false);
      expect(isDocNode({ tag: 'div' })).toBe(false);                 // no mid
      expect(isDocNode({ mid: 'a', tag: '' })).toBe(false);           // no tag
      expect(isDocNode({ mid: 'a', tag: 'div', children: 'x' })).toBe(false);
      expect(isDocNode({ mid: 'a', tag: 'div', children: [{ tag: 'p' }] })).toBe(false);
      expect(isDocNode({ mid: 'a', tag: 'div', text: 5 })).toBe(false);
    });

    it('docFromDesignNodes clamps geometry and never concatenates into style', () => {
      const doc = docFromDesignNodes([{
        id: 'n', type: 'section', name: 'x', x: 0, y: 0,
        width: 1e12, height: Number.NaN,
        layout: { display: 'block' },
        style: { background: '"; behavior: url(evil)' },
      } as never]);
      const child = doc.children![0];
      expect(child.style!.width).toBe('100000px');
      expect(child.style!.height).toBeUndefined();
      expect(child.style!.background).toBeUndefined();   // rejected, not escaped in
    });
  });

  describe('through ArtifactStore.load — real files saved in the OLD shape', () => {
    it('migrates a pre-Phase-2 artifact.json on load and re-saves it document-first', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-migrate-'));
      try {
        const store = new ArtifactStore({ getRoot: () => root });
        const id = 'a1b2c3d4';
        const dir = path.join(root, '.mysti', 'canvas', id);
        await fs.mkdir(dir, { recursive: true });
        // Exactly the shape Mysti wrote before Plan 22 — including the deleted
        // shadow layers, which must not survive the upgrade.
        const old = {
          schemaVersion: 1,
          id, name: 'Old Deck', kind: 'screens', version: 4,
          createdAt: 1, updatedAt: 2,
          format: { formatId: 'desktop', kind: 'screen', width: 1440, height: 900 },
          theme: { colors: { primary: '#000' } },
          pages: [
            { id: 'p1', version: 2, mode: 'jsx', jsxSource: JSX_OK, actionTitle: 'Login',
              elementOverrides: { '0/1': { innerHtml: 'ghost' } }, previewAsset: 'asset://x' },
            { id: 'p2', version: 1, mode: 'html', htmlSource: '<h1>Legacy</h1>',
              stitchRef: { projectId: 'proj', screenId: 'scr' }, droppedAssets: [{ id: 'd' }] },
            { id: 'p3', version: 1, mode: 'jsx', jsxSource: JSX_BAD },
          ],
          assets: [], opLog: [],
        };
        await fs.writeFile(path.join(dir, 'artifact.json'), JSON.stringify(old), 'utf-8');

        const loaded = await store.load(id);
        expect(loaded).not.toBeNull();
        expect(loaded!.pages).toHaveLength(3);

        const [p1, p2, p3] = loaded!.pages;
        expect(p1.doc.tag).toBe('UI.Screen');
        expect(p1.actionTitle).toBe('Login');
        expect(p1.legacy).toBeUndefined();
        expect((p1 as Record<string, unknown>).elementOverrides).toBeUndefined();
        expect((p1 as Record<string, unknown>).previewAsset).toBeUndefined();

        expect(pageHtml(p2)).toBe('<h1>Legacy</h1>');
        expect((p2 as Record<string, unknown>).stitchRef).toBeUndefined();
        expect((p2 as Record<string, unknown>).droppedAssets).toBeUndefined();

        expect(p3.legacy).toEqual({ mode: 'jsx', source: JSX_BAD });
        expect(p3.compileError).toBeTruthy();

        // Round-trip: saving the migrated artifact and reloading is stable.
        await store.save(loaded!);
        const again = await store.load(id);
        expect(again!.pages.map(p => p.id)).toEqual(['p1', 'p2', 'p3']);
        expect(again!.pages.map(p => [...collectMids(p.doc)]))
          .toEqual(loaded!.pages.map(p => [...collectMids(p.doc)]));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('an artifact whose pages carry no content at all is corrupt, not silently empty', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-migrate-'));
      try {
        const store = new ArtifactStore({ getRoot: () => root });
        const id = 'deadbeef';
        const dir = path.join(root, '.mysti', 'canvas', id);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'artifact.json'), JSON.stringify({
          id, name: 'X', kind: 'screens', version: 1, createdAt: 1, updatedAt: 1,
          format: { formatId: 'desktop', kind: 'screen', width: 1440, height: 900 },
          theme: { colors: {} },
          pages: [{ id: 'p1', version: 1 }],
          assets: [], opLog: [],
        }), 'utf-8');
        await expect(store.load(id)).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});
