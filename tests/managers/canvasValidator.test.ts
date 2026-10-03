/**
 * CanvasValidator tests — the static validate_page rule engine, plus the
 * validate_page tool path through CanvasToolDispatch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { validatePage, validateArtifact } from '../../src/managers/CanvasValidator';
import { dispatchCanvasTool } from '../../src/managers/CanvasToolDispatch';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact, ArtifactPage } from '../../src/types';

describe('CanvasValidator', () => {
  let store: ArtifactStore;
  let artifact: CanvasArtifact;

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    artifact = store.createArtifact({ name: 'Deck', kind: 'deck' });
  });

  function page(p: Partial<ArtifactPage>): ArtifactPage {
    return store.makePage({ mode: 'html', ...p } as any);
  }

  function rules(issues: { rule: string }[]): string[] {
    return issues.map(i => i.rule);
  }

  it('flags an empty page and stops there', () => {
    const issues = validatePage(artifact, page({ htmlSource: '' }));
    expect(rules(issues)).toEqual(['empty-page']);
  });

  it('does not flag a structured page as empty', () => {
    const p = page({ htmlSource: '', nodes: [{ id: 'n', type: 'section', name: 'x', x: 0, y: 0, width: 10, height: 10, layout: { display: 'block' }, style: {} }] as any });
    expect(rules(validatePage(artifact, p))).not.toContain('empty-page');
  });

  it('warns on a deck page missing an actionTitle, not when present', () => {
    expect(rules(validatePage(artifact, page({ htmlSource: '<h1>Hi</h1>' })))).toContain('missing-action-title');
    expect(rules(validatePage(artifact, page({ htmlSource: '<h1>Hi</h1>', actionTitle: 'Cover' })))).not.toContain('missing-action-title');
  });

  it('does not require actionTitle on non-deck kinds', () => {
    const board = store.createArtifact({ name: 'B', kind: 'board' });
    expect(rules(validatePage(board, page({ htmlSource: '<h1>Hi</h1>' })))).not.toContain('missing-action-title');
  });

  it('warns on raw hex colors', () => {
    const issues = validatePage(artifact, page({ htmlSource: '<div style="color:#ff0000;background:#0f0">x</div>', actionTitle: 'T' }));
    const hex = issues.find(i => i.rule === 'raw-hex');
    expect(hex).toBeDefined();
    expect(hex!.message).toContain('2');
  });

  it('errors on an unresolved asset:// reference, not on a registered one', () => {
    const unresolved = validatePage(artifact, page({ htmlSource: '<img src="asset://x/assets/abc.png">', actionTitle: 'T' }));
    expect(rules(unresolved)).toContain('unresolved-asset');

    artifact.assets.push({ id: 'a1', role: 'image', ref: 'asset://x/assets/abc.png', ts: 1 });
    const resolved = validatePage(artifact, page({ htmlSource: '<img src="asset://x/assets/abc.png">', actionTitle: 'T' }));
    expect(rules(resolved)).not.toContain('unresolved-asset');
  });

  it('errors on overflow only when a measured height exceeds the format', () => {
    const tall = validatePage(artifact, page({ htmlSource: '<h1>Hi</h1>', actionTitle: 'T' }), { reportedContentHeight: 2000 });
    expect(rules(tall)).toContain('overflow');
    const fits = validatePage(artifact, page({ htmlSource: '<h1>Hi</h1>', actionTitle: 'T' }), { reportedContentHeight: 900 });
    expect(rules(fits)).not.toContain('overflow');
    const noData = validatePage(artifact, page({ htmlSource: '<h1>Hi</h1>', actionTitle: 'T' }));
    expect(rules(noData)).not.toContain('overflow');
  });

  it('validateArtifact aggregates issues across pages', () => {
    store.insertPage(artifact, page({ htmlSource: '' }));            // empty-page
    store.insertPage(artifact, page({ htmlSource: '<h1>Hi</h1>' })); // missing-action-title
    const all = validateArtifact(artifact);
    expect(rules(all)).toEqual(expect.arrayContaining(['empty-page', 'missing-action-title']));
  });

  describe('validate_page tool', () => {
    let ctx: CanvasToolContext;
    beforeEach(() => {
      const router = new CanvasJobRouter(() => {});
      const executor = new CanvasOpExecutor(store, router);
      ctx = { artifact, store, executor, jobId: 'j', runId: 'r', approvalMode: 'auto' };
    });

    it('returns issues and an ok flag (false when an error rule fires)', () => {
      const p = store.insertPage(artifact, page({ htmlSource: '' }));
      const r = dispatchCanvasTool('validate_page', { pageId: p.id }, ctx);
      expect(r.ok).toBe(true);
      expect((r.data as any).ok).toBe(false); // empty-page is an error
      expect((r.data as any).issues.length).toBeGreaterThan(0);
    });

    it('reports ok=true for a clean page', () => {
      artifact.assets.push({ id: 'a', role: 'image', ref: 'asset://x/assets/y.png', ts: 1 });
      const p = store.insertPage(artifact, page({ htmlSource: '<img src="asset://x/assets/y.png">', actionTitle: 'Cover' }));
      const r = dispatchCanvasTool('validate_page', { pageId: p.id }, ctx);
      expect((r.data as any).ok).toBe(true);
    });

    it('errors on a missing page id', () => {
      const r = dispatchCanvasTool('validate_page', { pageId: 'ghost' }, ctx);
      expect(r.ok).toBe(false);
    });
  });
});
