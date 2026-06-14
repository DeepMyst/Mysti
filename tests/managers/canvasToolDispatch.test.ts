/**
 * CanvasToolDispatch tests — the transport-agnostic mysti-canvas tool contract:
 * read tools return artifact data (with baseVersion), write tools route through
 * the executor (validation/staging/versioning), and write_page_jsx enforces the
 * sandbox page shape.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import {
  CANVAS_TOOLS,
  dispatchCanvasTool,
  buildArtifactIndex,
  getCanvasTool,
} from '../../src/managers/CanvasToolDispatch';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

describe('CanvasToolDispatch', () => {
  let store: ArtifactStore;
  let executor: CanvasOpExecutor;
  let artifact: CanvasArtifact;
  let ctx: CanvasToolContext;

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    const router = new CanvasJobRouter(() => {});
    executor = new CanvasOpExecutor(store, router);
    artifact = store.createArtifact({ name: 'Deck' });
    ctx = { artifact, store, executor, jobId: 'job-1', runId: 'run-1', approvalMode: 'auto' };
  });

  function addPage(html = 'hello', title = 'Cover') {
    return store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: html, actionTitle: title }));
  }

  describe('tool catalog', () => {
    it('declares read/write access and prefixes descriptions accordingly', () => {
      for (const t of CANVAS_TOOLS) {
        expect(t.description.startsWith(t.access === 'read-only' ? 'READ-ONLY' : 'WRITE')).toBe(true);
      }
      expect(getCanvasTool('read_page')!.access).toBe('read-only');
      expect(getCanvasTool('insert_page')!.access).toBe('write');
      expect(getCanvasTool('nope')).toBeUndefined();
    });
  });

  describe('read tools', () => {
    it('list_pages returns index/id/mode/version/title', () => {
      const p = addPage();
      const r = dispatchCanvasTool('list_pages', {}, ctx);
      expect(r.ok).toBe(true);
      expect(r.data).toEqual([{ index: 0, id: p.id, mode: 'html', version: 1, actionTitle: 'Cover' }]);
    });

    it('read_page returns the page plus baseVersion', () => {
      const p = addPage();
      const r = dispatchCanvasTool('read_page', { pageId: p.id }, ctx);
      expect(r.ok).toBe(true);
      expect((r.data as any).id).toBe(p.id);
      expect((r.data as any).baseVersion).toBe(1);
    });

    it('read_page errors on a missing page', () => {
      const r = dispatchCanvasTool('read_page', { pageId: 'ghost' }, ctx);
      expect(r.ok).toBe(false);
    });

    it('get_artifact_index summarizes the artifact', () => {
      addPage('x', 'Intro');
      const r = dispatchCanvasTool('get_artifact_index', {}, ctx);
      expect(String(r.data)).toContain('pages=1');
      expect(String(r.data)).toContain('Intro');
    });

    it('page_coordinates returns anchor geometry for the format', () => {
      const r = dispatchCanvasTool('page_coordinates', {}, ctx);
      expect((r.data as any).center).toEqual({ x: 960, y: 540 });
    });
  });

  describe('write tools route through the executor', () => {
    it('insert_page (auto) applies and creates a page', () => {
      const r = dispatchCanvasTool('insert_page', { page: { mode: 'html', htmlSource: 'new' } }, ctx);
      expect(r.ok).toBe(true);
      expect(r.op!.status).toBe('applied');
      expect(artifact.pages).toHaveLength(1);
    });

    it('insert_page rejects a page with no mode', () => {
      const r = dispatchCanvasTool('insert_page', { page: { htmlSource: 'x' } }, ctx);
      expect(r.ok).toBe(false);
    });

    it('edit_page patches an existing page', () => {
      const p = addPage('old');
      const r = dispatchCanvasTool('edit_page', { pageId: p.id, patch: { htmlSource: 'new' }, baseVersion: 1 }, ctx);
      expect(r.ok).toBe(true);
      expect(store.getPage(artifact, p.id)!.htmlSource).toBe('new');
    });

    it('edit_page with a stale baseVersion does not clobber', () => {
      const p = addPage('v1');
      store.updatePage(artifact, p.id, { htmlSource: 'v2' }); // version → 2
      const r = dispatchCanvasTool('edit_page', { pageId: p.id, patch: { htmlSource: 'agent' }, baseVersion: 1 }, ctx);
      expect(r.op!.status).toBe('stale');
      expect(store.getPage(artifact, p.id)!.htmlSource).toBe('v2');
    });

    it('delete_page removes a page (and is undoable via the executor)', () => {
      const p = addPage();
      const r = dispatchCanvasTool('delete_page', { pageId: p.id }, ctx);
      expect(r.ok).toBe(true);
      expect(artifact.pages).toHaveLength(0);
      executor.undoLastApplied(artifact, 'job-1');
      expect(artifact.pages).toHaveLength(1);
    });

    it('reorder_pages reorders by id', () => {
      const p1 = addPage('1', 'A');
      const p2 = addPage('2', 'B');
      const r = dispatchCanvasTool('reorder_pages', { orderedIds: [p2.id, p1.id] }, ctx);
      expect(r.ok).toBe(true);
      expect(artifact.pages.map(p => p.id)).toEqual([p2.id, p1.id]);
    });

    it('set_format resolves a catalog id', () => {
      const r = dispatchCanvasTool('set_format', { formatId: 'story-9x16' }, ctx);
      expect(r.ok).toBe(true);
      expect(artifact.format.formatId).toBe('story-9x16');
      expect(artifact.format.height).toBe(1920);
    });

    it('set_theme replaces the theme', () => {
      const theme = JSON.parse(JSON.stringify(artifact.theme));
      theme.colors.primary = '#123456';
      const r = dispatchCanvasTool('set_theme', { theme }, ctx);
      expect(r.ok).toBe(true);
      expect(artifact.theme.colors.primary).toBe('#123456');
    });

    it('edit_element stores a durable override', () => {
      const p = addPage();
      const r = dispatchCanvasTool('edit_element', { pageId: p.id, path: '0/1', override: { innerHtml: 'hi' } }, ctx);
      expect(r.ok).toBe(true);
      expect(store.getPage(artifact, p.id)!.elementOverrides!['0/1'].innerHtml).toBe('hi');
    });
  });

  describe('write_page_jsx validation', () => {
    it('accepts a valid function Page() component and strips fences', () => {
      const jsx = '```jsx\nfunction Page() { return <div>Hi</div>; }\n```';
      const r = dispatchCanvasTool('write_page_jsx', { jsx, actionTitle: 'Slide' }, ctx);
      expect(r.ok).toBe(true);
      expect(artifact.pages[0].mode).toBe('jsx');
      expect(artifact.pages[0].jsxSource).toContain('function Page()');
      expect(artifact.pages[0].jsxSource).not.toContain('```');
    });

    it('rejects imports (sandbox preloads React/UI.*)', () => {
      const jsx = "import React from 'react';\nfunction Page() { return null; }";
      const r = dispatchCanvasTool('write_page_jsx', { jsx }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('import');
    });

    it('rejects source without a function Page()', () => {
      const r = dispatchCanvasTool('write_page_jsx', { jsx: 'const x = 1;' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('function Page()');
    });

    it('edits an existing page when pageId is given', () => {
      const p = addPage();
      const r = dispatchCanvasTool('write_page_jsx', { pageId: p.id, jsx: 'function Page(){return <b/>;}', baseVersion: 1 }, ctx);
      expect(r.ok).toBe(true);
      expect(store.getPage(artifact, p.id)!.mode).toBe('jsx');
    });
  });

  it('unknown tool returns an error', () => {
    const r = dispatchCanvasTool('frobnicate', {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown canvas tool');
  });

  it('buildArtifactIndex lists one line per page', () => {
    addPage('a', 'One');
    addPage('b', 'Two');
    const idx = buildArtifactIndex(artifact);
    expect(idx).toContain('pages=2');
    expect(idx).toContain('One');
    expect(idx).toContain('Two');
  });
});
