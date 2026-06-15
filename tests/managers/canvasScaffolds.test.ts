/**
 * CanvasScaffolds tests — the curated app/web page scaffold library and its
 * list_scaffolds / scaffold_page tools. Verifies every scaffold is a valid
 * write_page_jsx component (single function Page(), no imports, uses UI.*) and
 * that the tools surface + insert them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PAGE_SCAFFOLDS, getScaffold, listScaffolds } from '../../src/managers/CanvasScaffolds';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool } from '../../src/managers/CanvasToolDispatch';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

describe('CanvasScaffolds', () => {
  describe('the library', () => {
    it('every scaffold is a single function Page() with no imports and uses UI.*', () => {
      for (const s of PAGE_SCAFFOLDS) {
        expect(s.jsx).toMatch(/function\s+Page\s*\(/);
        // exactly one Page component
        expect((s.jsx.match(/function\s+Page\s*\(/g) || []).length).toBe(1);
        expect(s.jsx).not.toMatch(/^\s*import\s/m);
        expect(s.jsx).not.toMatch(/\brequire\s*\(/);
        expect(s.jsx).toContain('UI.');
        expect(s.devices.length).toBeGreaterThan(0);
      }
    });

    it('getScaffold / listScaffolds', () => {
      expect(getScaffold('dashboard')!.name).toBe('Desktop dashboard');
      expect(getScaffold('nope')).toBeUndefined();
      // list metadata excludes the (large) jsx
      const list = listScaffolds();
      expect(list.length).toBe(PAGE_SCAFFOLDS.length);
      expect((list[0] as any).jsx).toBeUndefined();
    });

    it('listScaffolds filters by device', () => {
      const mobile = listScaffolds('mobile').map(s => s.id);
      expect(mobile).toContain('mobile-home');
      expect(mobile).not.toContain('dashboard'); // desktop/tablet only
      const desktop = listScaffolds('desktop').map(s => s.id);
      expect(desktop).toContain('dashboard');
    });
  });

  describe('tools', () => {
    let store: ArtifactStore;
    let artifact: CanvasArtifact;
    let ctx: CanvasToolContext;

    beforeEach(() => {
      store = new ArtifactStore({ getRoot: () => null });
      const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
      artifact = store.createArtifact({ name: 'App' });
      ctx = { artifact, store, executor, jobId: 'j', runId: 'r', approvalMode: 'auto' };
    });

    it('list_scaffolds returns the catalog metadata', () => {
      const r = dispatchCanvasTool('list_scaffolds', {}, ctx);
      expect(r.ok).toBe(true);
      expect((r.data as any[]).map(s => s.id)).toContain('login');
    });

    it('scaffold_page inserts a jsx page seeded from the scaffold', () => {
      const r = dispatchCanvasTool('scaffold_page', { scaffold: 'login', actionTitle: 'Sign in' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.op!.status).toBe('applied');
      expect(artifact.pages).toHaveLength(1);
      expect(artifact.pages[0].mode).toBe('jsx');
      expect(artifact.pages[0].actionTitle).toBe('Sign in');
      expect(artifact.pages[0].jsxSource).toContain('function Page()');
    });

    it('every scaffold passes the write-jsx validation via scaffold_page', () => {
      for (const s of PAGE_SCAFFOLDS) {
        const r = dispatchCanvasTool('scaffold_page', { scaffold: s.id }, ctx);
        expect(r.ok, `scaffold ${s.id} should be valid`).toBe(true);
      }
    });

    it('scaffold_page rejects an unknown scaffold', () => {
      const r = dispatchCanvasTool('scaffold_page', { scaffold: 'nope' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('unknown scaffold');
    });
  });
});
