/**
 * CanvasVariants tests (Plan 22 §4 "Beyond parity" / Phase 6).
 *
 * Variants are supposed to cost ONE field, so these tests pin the two claims
 * that make that true:
 *
 *  1. grouping is derived, never written — the group id IS the origin page's
 *     id, so generating directions mutates nothing (`page.setMeta` cannot carry
 *     `variantGroupId`, so any design needing a write here would need a new op);
 *  2. every planner emits ops the existing executor already implements, so the
 *     whole feature is undoable/auditable for free.
 *
 * Plus the adversarial half: adopting must never be able to empty a design, and
 * a model asking for 200 directions must not get 200 artboards.
 */
import { describe, it, expect } from 'vitest';
import {
  variantGroups,
  variantGroupOf,
  variantGroupIdFor,
  variantSiblings,
  planVariants,
  planVariantLabels,
  planAdoptVariant,
  planVariantLayout,
  variantTitle,
  variantLetter,
  VARIANT_ROW_GAP_PX,
} from '../../src/canvas/CanvasVariants';
import { CANVAS_MAX_VARIANTS } from '../../src/constants';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { applyOp } from '../../src/canvas/doc/DocPatch';
import { walk } from '../../src/canvas/doc/DocNode';
import type { ArtifactPage, CanvasArtifact } from '../../src/types';

const store = new ArtifactStore({ getRoot: () => null });

function page(
  id: string,
  over: Partial<ArtifactPage> = {},
): ArtifactPage {
  return {
    ...store.makePage({ id, actionTitle: over.actionTitle ?? id, mode: 'jsx', jsxSource: 'function Page(){return <div/>;}' }),
    boardPos: over.boardPos ?? { x: 0, y: 0 },
    ...over,
  } as ArtifactPage;
}

function artifact(pages: ArtifactPage[]): CanvasArtifact {
  const a = store.createArtifact({ name: 'Design', kind: 'screens' });
  a.pages = pages;
  return a;
}

describe('variant grouping', () => {
  it('groups the origin with the duplicates that name it', () => {
    const pages = [
      page('origin'),
      page('v1', { variantGroupId: 'origin' }),
      page('v2', { variantGroupId: 'origin' }),
      page('unrelated'),
    ];
    const groups = variantGroups(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0].groupId).toBe('origin');
    expect(groups[0].originId).toBe('origin');
    expect(groups[0].pages.map(p => p.id)).toEqual(['origin', 'v1', 'v2']);
  });

  it('is not a group until there are two members — a lone artboard is just an artboard', () => {
    expect(variantGroups([page('solo')])).toEqual([]);
    // Even one that (defensively) names itself.
    expect(variantGroups([page('solo', { variantGroupId: 'solo' })])).toEqual([]);
  });

  it('survives the origin being adopted away — the survivors stay grouped', () => {
    const pages = [
      page('v1', { variantGroupId: 'gone' }),
      page('v2', { variantGroupId: 'gone' }),
    ];
    const [group] = variantGroups(pages);
    expect(group.groupId).toBe('gone');
    expect(group.originId).toBeNull();
    expect(group.pages).toHaveLength(2);
  });

  it('keeps two independent rows apart', () => {
    const pages = [
      page('a'), page('a1', { variantGroupId: 'a' }),
      page('b'), page('b1', { variantGroupId: 'b' }), page('b2', { variantGroupId: 'b' }),
    ];
    expect(variantGroups(pages).map(g => [g.groupId, g.pages.length])).toEqual([['a', 2], ['b', 3]]);
    expect(variantGroupOf(pages, 'b2')?.groupId).toBe('b');
    expect(variantSiblings(pages, 'b').map(p => p.id)).toEqual(['b1', 'b2']);
  });

  it('reports no group for an unknown page id', () => {
    expect(variantGroupOf([page('a')], 'nope')).toBeNull();
    expect(variantGroupOf([page('a')], '')).toBeNull();
    expect(variantSiblings([page('a')], 'a')).toEqual([]);
  });

  it('the group id of a fresh artboard is its own id (no write needed to start a row)', () => {
    expect(variantGroupIdFor(page('p1'))).toBe('p1');
    expect(variantGroupIdFor(page('p2', { variantGroupId: 'g' }))).toBe('g');
  });
});

describe('planVariants', () => {
  it('emits N page.duplicate ops carrying the group id', () => {
    const ops = planVariants(page('p1'), { count: 3 });
    expect(ops).toEqual([
      { op: 'page.duplicate', pageId: 'p1', variantOf: 'p1' },
      { op: 'page.duplicate', pageId: 'p1', variantOf: 'p1' },
      { op: 'page.duplicate', pageId: 'p1', variantOf: 'p1' },
    ]);
  });

  it('joins the existing row when the artboard is already a variant', () => {
    const ops = planVariants(page('v1', { variantGroupId: 'origin' }), { count: 1 });
    expect(ops).toEqual([{ op: 'page.duplicate', pageId: 'v1', variantOf: 'origin' }]);
  });

  it('clamps a hostile count — 200 directions is 200 artboards to look at', () => {
    expect(planVariants(page('p1'), { count: 200 })).toHaveLength(CANVAS_MAX_VARIANTS);
    expect(planVariants(page('p1'), { count: 0 })).toHaveLength(1);
    expect(planVariants(page('p1'), { count: -5 })).toHaveLength(1);
    expect(planVariants(page('p1'), { count: Number.NaN })).toHaveLength(1);
    expect(planVariants(page('p1'), { count: 2.7 })).toHaveLength(2);
    expect(planVariants(page('p1'))).toHaveLength(2);
  });
});

describe('planVariantLabels', () => {
  it('titles the new artboards B, C, … leaving the origin as-is', () => {
    expect(planVariantLabels(['n1', 'n2'], 'Login')).toEqual([
      { op: 'page.setMeta', pageId: 'n1', patch: { actionTitle: 'Login · B' } },
      { op: 'page.setMeta', pageId: 'n2', patch: { actionTitle: 'Login · C' } },
    ]);
  });

  it('does not stack suffixes when re-varying an already-labelled artboard', () => {
    expect(variantTitle('Login · B', 2)).toBe('Login · C');
  });

  it('falls back to a generic title and skips empty ids', () => {
    expect(planVariantLabels(['n1', ''], undefined)).toEqual([
      { op: 'page.setMeta', pageId: 'n1', patch: { actionTitle: 'Variant B' } },
    ]);
  });

  it('letters keep going past Z and never loop on a hostile index', () => {
    expect(variantLetter(0)).toBe('A');
    expect(variantLetter(25)).toBe('Z');
    expect(variantLetter(26)).toBe('AA');
    expect(variantLetter(-1)).toBe('A');
    expect(variantLetter(Number.NaN)).toBe('A');
    expect(variantLetter(1e9).length).toBeLessThanOrEqual(4);
  });
});

describe('planAdoptVariant', () => {
  const pages = [
    page('origin'),
    page('v1', { variantGroupId: 'origin' }),
    page('v2', { variantGroupId: 'origin' }),
  ];

  it('removes the losers and never the keeper', () => {
    expect(planAdoptVariant(pages, 'v1')).toEqual([
      { op: 'page.remove', pageId: 'origin' },
      { op: 'page.remove', pageId: 'v2' },
    ]);
  });

  it('adopting the origin removes only the duplicates', () => {
    expect(planAdoptVariant(pages, 'origin')).toEqual([
      { op: 'page.remove', pageId: 'v1' },
      { op: 'page.remove', pageId: 'v2' },
    ]);
  });

  it('plans nothing for a page that is not in a row — it can never empty a design', () => {
    expect(planAdoptVariant(pages, 'nope')).toEqual([]);
    expect(planAdoptVariant([page('solo')], 'solo')).toEqual([]);
    expect(planAdoptVariant([], 'x')).toEqual([]);
  });

  it('leaves exactly one survivor, and the row dissolves with no cleanup op', () => {
    const ops = planAdoptVariant(pages, 'v2');
    const survivors = pages.filter(p => !ops.some(o => 'pageId' in o && o.pageId === p.id));
    expect(survivors.map(p => p.id)).toEqual(['v2']);
    // A one-member group is not a group, so nothing has to unset the field.
    expect(variantGroups(survivors)).toEqual([]);
  });
});

describe('planVariantLayout', () => {
  it('lays the row out left-to-right at the anchor, skipping artboards already in place', () => {
    const a = artifact([
      page('origin', { boardPos: { x: 100, y: 40 } }),
      page('v1', { variantGroupId: 'origin', boardPos: { x: 0, y: 0 } }),
    ]);
    a.format = { ...a.format, width: 1000, height: 800 };
    const ops = planVariantLayout(a, 'origin');
    // The origin is already at the anchor → no op for it.
    expect(ops).toEqual([
      { op: 'page.move', pageId: 'v1', boardPos: { x: 100 + 1000 + VARIANT_ROW_GAP_PX, y: 40 } },
    ]);
  });

  it('honours a per-artboard format when spacing the row', () => {
    const a = artifact([
      page('origin', { boardPos: { x: 0, y: 0 }, format: { formatId: 'phone', kind: 'screen', width: 390, height: 844 } }),
      page('v1', { variantGroupId: 'origin', boardPos: { x: 0, y: 0 } }),
    ]);
    const [move] = planVariantLayout(a, 'origin', { gap: 10 });
    expect(move).toEqual({ op: 'page.move', pageId: 'v1', boardPos: { x: 400, y: 0 } });
  });

  it('plans nothing for an unknown group', () => {
    expect(planVariantLayout(artifact([page('a')]), 'nope')).toEqual([]);
  });
});

describe('the ops are the real algebra', () => {
  it('every planned op is one the document patcher / executor already implements', () => {
    const pages = [page('origin'), page('v1', { variantGroupId: 'origin' })];
    const kinds = [
      ...planVariants(pages[0], { count: 2 }),
      ...planVariantLabels(['n1'], 'Login'),
      ...planAdoptVariant(pages, 'origin'),
      ...planVariantLayout(artifact(pages), 'origin'),
    ].map(o => o.op);
    expect(new Set(kinds)).toEqual(new Set(['page.duplicate', 'page.setMeta', 'page.remove', 'page.move']));
    // None of them are document-scoped, so `applyOp` must refuse them outright
    // rather than half-applying: they belong to the executor's page layer.
    const doc = pages[0].doc;
    expect(() => applyOp(doc, { op: 'page.duplicate', pageId: 'origin' } as never)).toThrow();
  });
});

describe('end to end through the executor', () => {
  it('plan → submit → a real row, then adopt leaves exactly the keeper', () => {
    const store2 = new ArtifactStore({ getRoot: () => null });
    const router = new CanvasJobRouter(() => undefined);
    const executor = new CanvasOpExecutor(store2, router);
    const a = store2.createArtifact({ name: 'Test', kind: 'screens' });
    const origin = store2.insertPage(a, store2.makePage({
      mode: 'jsx', jsxSource: 'function Page(){return <div>hi</div>;}', actionTitle: 'Login',
    }));

    for (const op of planVariants(origin, { count: 2 })) {
      const receipt = executor.submitOp(a, { op, runId: 'run-1' }, 'job', 'auto');
      expect(receipt.status).toBe('applied');
    }

    const group = variantGroupOf(a.pages, origin.id)!;
    expect(group.pages).toHaveLength(3);
    expect(group.groupId).toBe(origin.id);
    // A duplicate must not share mids with its sibling, or the two artboards
    // would be one artboard as far as pins/selection/comments are concerned.
    const midsOf = (p: ArtifactPage) => [...walk(p.doc)].map(n => n.mid);
    const originMids = new Set(midsOf(group.pages[0]));
    for (const variant of group.pages.slice(1)) {
      expect(midsOf(variant).some(m => originMids.has(m))).toBe(false);
    }

    const keeper = group.pages[2].id;
    for (const op of planAdoptVariant(a.pages, keeper)) {
      expect(executor.submitOp(a, { op, runId: 'run-2' }, 'job', 'auto').status).toBe('applied');
    }
    expect(a.pages.map(p => p.id)).toEqual([keeper]);
    expect(variantGroups(a.pages)).toEqual([]);
  });
});
