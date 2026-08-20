/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 / §3.5 — the two decisions the phase turns on.
 *
 * 1. **Delta vs re-render.** An element op must produce a PATCH, never a page
 *    reload — that is the whole difference between an edit that preserves
 *    scroll/focus/hover and one that destroys them.
 * 2. **View state vs artifact state.** "Preview this on mobile" must post
 *    nothing and survive the next agent update; "this artboard IS mobile" must
 *    become an op. Today's shell does the first as a local mutation that the
 *    next `Object.assign` silently destroys.
 */
import { describe, it, expect } from 'vitest';
import {
  CanvasStore, changeDevice, changeTheme, effectiveFormat, initialViewState,
  planRender, recordOp, setThemeToken, isCanvasOpKind,
} from '../../src/webview/canvas/state';
import type { CanvasOpRecord, WireArtifact } from '../../src/canvas/protocol';
import type { CanvasOp } from '../../src/canvas/CanvasOps';
import type { ArtifactPage, CanvasFormatSpec, DesignTheme } from '../../src/types';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP: CanvasFormatSpec = getFormat('desktop')!;
const MOBILE: CanvasFormatSpec = getFormat('mobile')!;

function doc(): DocNode {
  return {
    mid: 'aaaaaaaaaa',
    tag: 'UI.Screen',
    children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Welcome' }],
  };
}

function page(id: string, over: Partial<ArtifactPage> = {}): ArtifactPage {
  return { id, version: 1, doc: doc(), boardPos: { x: 0, y: 0 }, actionTitle: id, ...over };
}

function artifact(pages: ArtifactPage[] = [page('p1')]): WireArtifact {
  return {
    id: 'art1', version: 10, kind: 'screens', name: 'Acme', format: DESKTOP,
    theme: JSON.parse(JSON.stringify(THEME)) as DesignTheme,
    pages, assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

/** A Phase-2 record: the op algebra rides in `op`. */
function v2(op: CanvasOp, status = 'applied'): CanvasOpRecord {
  return { opId: `op-${Math.random()}`, txnId: 't', runId: 'r', author: 'agent', actorId: 'a', op, status, ts: 0 } as unknown as CanvasOpRecord;
}

/** A pre-Phase-2 record: page-sized blob, no element identity. */
function legacy(kind: string, targetPageId?: string): CanvasOpRecord {
  return {
    opId: 'legacy-1', runId: 'r', kind, targetPageId,
    proposedValue: {}, status: 'applied', author: 'agent', ts: 0,
  } as unknown as CanvasOpRecord;
}

describe('record normalizing', () => {
  it('recognizes every op kind and nothing else', () => {
    expect(isCanvasOpKind('el.setText')).toBe(true);
    expect(isCanvasOpKind('theme.setToken')).toBe(true);
    expect(isCanvasOpKind('el.evil')).toBe(false);
    expect(isCanvasOpKind('__proto__')).toBe(false);
    expect(isCanvasOpKind(null)).toBe(false);
  });

  it('reads the op out of a V2 record and null out of a legacy one', () => {
    const op: CanvasOp = { op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'hi' };
    expect(recordOp(v2(op))).toEqual(op);
    expect(recordOp(legacy('edit_page', 'p1'))).toBeNull();
    expect(recordOp({ op: { op: 'not.a.kind' } } as unknown as CanvasOpRecord)).toBeNull();
    expect(recordOp({ op: 'el.setText' } as unknown as CanvasOpRecord)).toBeNull();
  });
});

describe('planRender: deltas are the steady state', () => {
  it('turns element ops into PATCHES and rebuilds nothing', () => {
    const plan = planRender([
      v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'Get started' }),
      v2({ op: 'el.setStyle', pageId: 'p1', mid: 'bbbbbbbbbb', style: { color: '#111' } }),
      v2({ op: 'el.setProp', pageId: 'p2', mid: 'cccccccccc', name: 'label', value: 'Go' }),
    ]);
    expect(plan.patches.get('p1')).toHaveLength(2);
    expect(plan.patches.get('p2')).toHaveLength(1);
    expect(plan.reload.size).toBe(0);
    expect(plan.structure).toBe(false);
    expect(plan.theme).toBe(false);
    expect(plan.resync).toBe(false);
  });

  it('treats a whole-artboard write as a patch too — the frame diffs it', () => {
    const plan = planRender([v2({ op: 'page.setDoc', pageId: 'p1', doc: doc() })]);
    expect(plan.patches.get('p1')).toHaveLength(1);
    expect(plan.reload.size).toBe(0);
  });

  it('ignores records that did not change the document', () => {
    const plan = planRender([
      v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'x' }, 'rejected'),
      v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'x' }, 'staged'),
      v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'x' }, 'stale'),
    ]);
    expect(plan.patches.size).toBe(0);
    expect(plan.reload.size).toBe(0);
  });

  it('routes board layout to structure and theme to theme, never to a reload', () => {
    const moved = planRender([v2({ op: 'page.move', pageId: 'p1', boardPos: { x: 10, y: 20 } })]);
    expect(moved.structure).toBe(true);
    expect(moved.reload.size).toBe(0);

    const themed = planRender([v2({ op: 'theme.setToken', path: 'colors.primary', value: '#f00' })]);
    expect(themed.theme).toBe(true);
    expect(themed.reload.size).toBe(0);
    expect(themed.patches.size).toBe(0);
  });

  it('asks for a resync when the host mints an id the client cannot know', () => {
    const added = planRender([v2({ op: 'page.add', page: { doc: doc() } })]);
    expect(added.structure).toBe(true);
    expect(added.resync).toBe(true);
  });

  // CANVAS-P3-5. `artifact.format` is a LAYOUT input: `effectiveFormat` falls
  // back to it for every artboard that has no format of its own, and `_layout`
  // is the only thing that reads it. Planned as `theme`, `applyPlan` answered
  // with `_pushTheme()` — theme custom properties, a re-`mount` and a preview
  // redraw, and NO `_layout`/`_syncPages` — so `set_format` left every artboard
  // element sitting at its old desktop box while the rail thumbnails (which
  // read the same fallback) reflowed beside them.
  it('re-lays-out every artboard when the ARTIFACT format changes', () => {
    const plan = planRender([v2({ op: 'artifact.setFormat', format: MOBILE })]);
    expect(plan.structure, 'artifact.setFormat must re-run _syncPages/_layout').toBe(true);
    expect(plan.reload.size).toBe(0);
    expect(plan.patches.size).toBe(0);
    // …and it stays exactly the same class of change as its per-page twin.
    expect(planRender([v2({ op: 'page.setMeta', pageId: 'p1', patch: { format: MOBILE } })]).structure).toBe(true);
  });

  it('degrades a pre-Phase-2 record to an honest page reload', () => {
    const plan = planRender([legacy('edit_page', 'p1')]);
    expect(plan.reload.has('p1')).toBe(true);
    expect(plan.patches.size).toBe(0);
  });

  it('resyncs rather than guessing when a legacy record names no page', () => {
    expect(planRender([legacy('edit_page')]).resync).toBe(true);
    expect(planRender([legacy('who_knows', 'p1')]).resync).toBe(true);
  });
});

describe('CanvasStore: version gaps are detected, not absorbed', () => {
  it('applies a contiguous batch and advances the version', () => {
    const store = new CanvasStore();
    store.load(artifact());
    const out = store.applyOps([v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'Hi' })], 11);
    expect(out.ok).toBe(true);
    expect(store.version).toBe(11);
    expect(store.page('p1')!.doc.children![0].text).toBe('Hi');
    expect(store.page('p1')!.version).toBe(2);
  });

  it('reports a GAP when more versions passed than records arrived', () => {
    const store = new CanvasStore();
    store.load(artifact());
    const out = store.applyOps([v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'Hi' })], 14);
    expect(out).toEqual({ ok: false, reason: 'gap' });
    expect(store.version).toBe(10);       // unchanged: nothing half-applied
  });

  it('ignores a duplicate delivery instead of double-applying it', () => {
    const store = new CanvasStore();
    store.load(artifact());
    expect(store.applyOps([], 9)).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses ops before any state transfer has happened', () => {
    expect(new CanvasStore().applyOps([], 1)).toEqual({ ok: false, reason: 'no-artifact' });
  });

  it('flags a resync when an op targets a page or mid it does not have', () => {
    const store = new CanvasStore();
    store.load(artifact());
    const missingPage = store.applyOps([v2({ op: 'el.setText', pageId: 'nope', mid: 'bbbbbbbbbb', text: 'x' })], 11);
    expect(missingPage.ok && missingPage.plan.resync).toBe(true);
    const missingMid = store.applyOps([v2({ op: 'el.setText', pageId: 'p1', mid: 'zzzzzzzzzz', text: 'x' })], 12);
    expect(missingMid.ok && missingMid.plan.resync).toBe(true);
  });

  it('applies artifact-scope ops locally', () => {
    const store = new CanvasStore();
    store.load(artifact([page('p1'), page('p2')]));
    store.applyOps([v2({ op: 'page.reorder', orderedIds: ['p2', 'p1'] })], 11);
    expect(store.artifact!.pages.map(p => p.id)).toEqual(['p2', 'p1']);
    store.applyOps([v2({ op: 'page.remove', pageId: 'p2' })], 12);
    expect(store.artifact!.pages.map(p => p.id)).toEqual(['p1']);
    store.applyOps([v2({ op: 'artifact.setFormat', format: MOBILE })], 13);
    expect(store.artifact!.format.formatId).toBe('mobile');
  });

  /**
   * CANVAS-P3-1. `applyOp` MINTS a mid for any node the writer sent without
   * one, and the mint is `Math.random()`-backed. The host already minted its
   * own for the same wire op and never rewrote `record.op` (`newMids` rides
   * only on the receipt, which this client discards), so re-running the pure
   * function here produced a THIRD identity for the same element — and said
   * `ok`. The store is a cache, never a second writer: when it cannot
   * reproduce what the host did it must say so and let the caller resync.
   */
  describe('CANVAS-P3-1: a locally minted id is a divergence, not an apply', () => {
    const insert = (node: unknown) => v2({
      op: 'el.insert', pageId: 'p1', parentMid: 'aaaaaaaaaa', before: 'end', node,
    } as unknown as CanvasOp);

    it('refuses an el.insert whose payload node carries no mid', () => {
      const store = new CanvasStore();
      store.load(artifact());
      const before = JSON.parse(JSON.stringify(store.page('p1')!.doc));
      const out = store.applyOps([insert({ tag: 'UI.Button', props: { label: 'Save' } })], 11);
      expect(out.ok && out.plan.resync, 'a minted id must force a resync').toBe(true);
      // Nothing half-applied: the phantom identity never entered the cache.
      expect(store.page('p1')!.doc).toEqual(before);
    });

    it('refuses an el.replace and a page.setDoc that mint', () => {
      const store = new CanvasStore();
      store.load(artifact());
      // A replacement SUBTREE: the root reuses `op.mid`, so only the mid-less
      // child diverges — one anywhere in the tree is enough.
      const replaced = store.applyOps([v2({
        op: 'el.replace', pageId: 'p1', mid: 'bbbbbbbbbb',
        node: { tag: 'UI.Card', children: [{ tag: 'UI.Text', text: 'x' }] },
      } as unknown as CanvasOp)], 11);
      expect(replaced.ok && replaced.plan.resync).toBe(true);
      const wholePage = store.applyOps([v2({
        op: 'page.setDoc', pageId: 'p1',
        doc: { mid: 'cccccccccc', tag: 'UI.Screen', children: [{ tag: 'UI.Text', text: 'x' }] },
      } as unknown as CanvasOp)], 11);
      expect(wholePage.ok && wholePage.plan.resync).toBe(true);
    });

    // The guard is a MINT check, not a "payload carries a node" check: an
    // `el.replace` of a single leaf takes the target's own mid (`_resolveMid`
    // forces it), so both sides agree and refusing would cost a needless
    // round-trip on the commonest rewrite there is.
    it('does NOT resync when the payload cannot diverge', () => {
      const store = new CanvasStore();
      store.load(artifact());
      const out = store.applyOps([v2({
        op: 'el.replace', pageId: 'p1', mid: 'bbbbbbbbbb', node: { tag: 'UI.Text', text: 'x' },
      } as unknown as CanvasOp)], 11);
      expect(out.ok && out.plan.resync).toBe(false);
      expect(store.page('p1')!.doc.children![0]).toMatchObject({ mid: 'bbbbbbbbbb', tag: 'UI.Text' });
    });

    it('still applies the SAME ops locally when every node carries its mid', () => {
      const store = new CanvasStore();
      store.load(artifact());
      const out = store.applyOps([insert({ mid: 'dddddddddd', tag: 'UI.Button', props: { label: 'Save' } })], 11);
      expect(out.ok && out.plan.resync, 'a fully identified insert is reproducible').toBe(false);
      expect(store.page('p1')!.doc.children!.map(c => c.mid)).toEqual(['bbbbbbbbbb', 'dddddddddd']);
    });
  });

  it('never lets a receipt move the version backwards', () => {
    const store = new CanvasStore();
    store.load(artifact());
    store.noteReceipt({ opId: 'o', status: 'applied', artifactVersion: 3 });
    expect(store.version).toBe(10);
    store.noteReceipt({ opId: 'o', status: 'applied', artifactVersion: 12 });
    expect(store.version).toBe(12);
  });
});

describe('theme.setToken is prototype-pollution safe', () => {
  it('sets a real token path', () => {
    const theme = JSON.parse(JSON.stringify(THEME)) as DesignTheme;
    expect(setThemeToken(theme, 'colors.primary', '#ff0000')).toBe(true);
    expect(theme.colors.primary).toBe('#ff0000');
  });

  it('refuses __proto__ / constructor / prototype at ANY segment', () => {
    const theme = JSON.parse(JSON.stringify(THEME)) as DesignTheme;
    for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'colors.__proto__', 'colors.constructor']) {
      expect(setThemeToken(theme, path, 'yes')).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses absurd paths and non-string values', () => {
    const theme = JSON.parse(JSON.stringify(THEME)) as DesignTheme;
    expect(setThemeToken(theme, 'a.b.c.d.e.f.g', 'x')).toBe(false);
    expect(setThemeToken(theme, 'colors.primary', 1 as unknown as string)).toBe(false);
    expect(setThemeToken(theme, 'typography.fontFamily.nested', 'x')).toBe(false);
  });

  it('routes a hostile token through the store without polluting anything', () => {
    const store = new CanvasStore();
    store.load(artifact());
    const out = store.applyOps([v2({ op: 'theme.setToken', path: '__proto__.pwned', value: '1' })], 11);
    expect(out.ok && out.plan.resync).toBe(true);   // refused, and reported
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  });
});

describe('§3.5 view state vs artifact state', () => {
  it('previewing a device posts NOTHING and only changes the view', () => {
    const view = initialViewState();
    const intent = changeDevice(view, 'preview', MOBILE, 'p1');
    expect(intent.ops).toEqual([]);
    expect(intent.view.previewFormat).toEqual(MOBILE);
    expect(view.previewFormat).toBeNull();          // input untouched
  });

  it('a preview override survives an incoming artifact', () => {
    const view = changeDevice(initialViewState(), 'preview', MOBILE, 'p1').view;
    const store = new CanvasStore();
    store.load(artifact());
    store.applyOps([v2({ op: 'artifact.setFormat', format: DESKTOP })], 11);
    // The old shell Object.assign'ed the artifact over local state here.
    expect(view.previewFormat).toEqual(MOBILE);
    expect(effectiveFormat(store.artifact!, store.page('p1')!, view)).toEqual(MOBILE);
  });

  it('declaring an artboard a mobile screen emits page.setMeta and clears the preview', () => {
    const view = changeDevice(initialViewState(), 'preview', MOBILE, 'p1').view;
    const intent = changeDevice(view, 'artboard', MOBILE, 'p1');
    expect(intent.ops).toEqual([{ op: 'page.setMeta', pageId: 'p1', patch: { format: MOBILE } }]);
    expect(intent.view.previewFormat).toBeNull();
  });

  it('refuses to guess a target: no artboard focused degrades to a preview', () => {
    const intent = changeDevice(initialViewState(), 'artboard', MOBILE, null);
    expect(intent.ops).toEqual([]);
    expect(intent.view.previewFormat).toEqual(MOBILE);
  });

  it('theme is artifact state with no local twin', () => {
    expect(changeTheme(THEME)).toEqual([{ op: 'theme.set', theme: THEME }]);
  });

  it('effectiveFormat falls back preview -> page -> artifact', () => {
    const art = artifact([page('p1', { format: MOBILE })]);
    const view = initialViewState();
    expect(effectiveFormat(art, art.pages[0], view)).toEqual(MOBILE);
    expect(effectiveFormat(art, page('p2'), view)).toEqual(DESKTOP);
    expect(effectiveFormat(art, art.pages[0], { ...view, previewFormat: DESKTOP })).toEqual(DESKTOP);
  });
});
