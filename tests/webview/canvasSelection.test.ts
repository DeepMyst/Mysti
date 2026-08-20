/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 row 2 + §3.5 — the selection model.
 *
 * Two properties are load-bearing and both are asserted here:
 *
 * 1. **Selection is view state.** An incoming agent edit may only PRUNE it.
 *    `pruneSelection` cannot select, cannot re-target, cannot reorder. Today's
 *    canvas force-selects the newest page on every artifact update, which is
 *    exactly how an agent steals a human's cursor mid-gesture (§4 row 9).
 * 2. **A human gesture produces the same op an agent tool produces.** An
 *    arrow-nudge is `el.setStyle`, down the identical `canvas/submit`
 *    chokepoint — no private channel, therefore undoable by the same Cmd+Z.
 */
import { describe, it, expect } from 'vitest';
import {
  MARQUEE_MIN_DRAG_PX, NUDGE_STEP_LARGE_PX, NUDGE_STEP_PX,
  SelectionOverlay, applyHit, arrowDelta, emptySelection, isMarqueeGesture,
  isSelected, marqueeHits, nudgeOps, nudgeStyle, pruneSelection, selectOne,
  selectableMids, selectionAnchor, selectionEquals, setSelection, siblingMids,
  tabTarget, type SelectionState,
} from '../../src/webview/canvas/selection';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import type { DomDocument, DomElement } from '../../src/webview/canvas/dom';
import { FakeDocument, FakeElement } from './canvasFakeDom';

/**
 *  root
 *   ├ header ─ title
 *   ├ card   ─ [a, b, c]
 *   └ slot "trailing" ─ badge
 */
function tree(): DocNode {
  return {
    mid: 'root000000', tag: 'UI.Screen',
    children: [
      { mid: 'header0000', tag: 'UI.TopBar', children: [{ mid: 'title00000', tag: 'UI.Heading', text: 'Hi' }] },
      {
        mid: 'card000000', tag: 'UI.Card',
        children: [
          { mid: 'aaaaaaaaaa', tag: 'UI.Text', text: 'a' },
          { mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'b' },
          { mid: 'cccccccccc', tag: 'UI.Text', text: 'c' },
        ],
        slots: { trailing: [{ mid: 'badge00000', tag: 'UI.Badge', text: 'new' }] },
      },
    ],
  };
}

describe('click semantics', () => {
  it('replaces on a plain click and toggles on shift/cmd/ctrl', () => {
    let sel = applyHit(emptySelection(), 'p1', 'aaaaaaaaaa');
    expect(sel).toEqual({ pageId: 'p1', mids: ['aaaaaaaaaa'] });
    sel = applyHit(sel, 'p1', 'bbbbbbbbbb', { shift: true });
    expect(sel.mids).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
    sel = applyHit(sel, 'p1', 'cccccccccc', { meta: true });
    expect(sel.mids).toHaveLength(3);
    // Shift-clicking a selected element DESELECTS it - toggle, not add.
    sel = applyHit(sel, 'p1', 'bbbbbbbbbb', { ctrl: true });
    expect(sel.mids).toEqual(['aaaaaaaaaa', 'cccccccccc']);
    sel = applyHit(sel, 'p1', 'aaaaaaaaaa');
    expect(sel.mids).toEqual(['aaaaaaaaaa']);
  });

  it('collapses to empty when the last element is toggled off', () => {
    const sel = applyHit(selectOne('p1', 'aaaaaaaaaa'), 'p1', 'aaaaaaaaaa', { shift: true });
    expect(sel).toEqual(emptySelection());
  });

  it('never spans two artboards, even with shift held', () => {
    const sel = applyHit(selectOne('p1', 'aaaaaaaaaa'), 'p2', 'bbbbbbbbbb', { shift: true });
    expect(sel).toEqual({ pageId: 'p2', mids: ['bbbbbbbbbb'] });
  });

  it('anchors on the most recent hit', () => {
    const sel = applyHit(selectOne('p1', 'aaaaaaaaaa'), 'p1', 'bbbbbbbbbb', { shift: true });
    expect(selectionAnchor(sel)).toBe('bbbbbbbbbb');
    expect(selectionAnchor(emptySelection())).toBeNull();
    expect(isSelected(sel, 'p1', 'aaaaaaaaaa')).toBe(true);
    expect(isSelected(sel, 'p2', 'aaaaaaaaaa')).toBe(false);
  });

  it('setSelection dedupes, preserves order and rejects junk', () => {
    expect(setSelection('p1', ['a', 'b', 'a', '', 42 as unknown as string]).mids).toEqual(['a', 'b']);
    expect(setSelection('p1', [])).toEqual(emptySelection());
  });

  it('equality is order-sensitive because the anchor matters', () => {
    expect(selectionEquals({ pageId: 'p', mids: ['a', 'b'] }, { pageId: 'p', mids: ['a', 'b'] })).toBe(true);
    expect(selectionEquals({ pageId: 'p', mids: ['a', 'b'] }, { pageId: 'p', mids: ['b', 'a'] })).toBe(false);
    expect(selectionEquals({ pageId: 'p', mids: ['a'] }, { pageId: 'q', mids: ['a'] })).toBe(false);
  });
});

describe('an agent edit may only PRUNE the selection (§3.5)', () => {
  const pages = [{ id: 'p1', doc: tree() }];

  it('drops mids that ceased to exist and keeps the rest', () => {
    const sel: SelectionState = { pageId: 'p1', mids: ['aaaaaaaaaa', 'deleted000', 'cccccccccc'] };
    expect(pruneSelection(sel, pages)).toEqual({ pageId: 'p1', mids: ['aaaaaaaaaa', 'cccccccccc'] });
  });

  it('returns the SAME object when nothing died - no spurious change events', () => {
    const sel: SelectionState = { pageId: 'p1', mids: ['aaaaaaaaaa'] };
    expect(pruneSelection(sel, pages)).toBe(sel);
  });

  it('clears when the whole artboard is gone', () => {
    expect(pruneSelection({ pageId: 'p9', mids: ['aaaaaaaaaa'] }, pages)).toEqual(emptySelection());
    expect(pruneSelection({ pageId: 'p1', mids: ['gone000000'] }, pages)).toEqual(emptySelection());
  });

  it('can never ADD - a page full of new nodes leaves an empty selection empty', () => {
    expect(pruneSelection(emptySelection(), pages)).toEqual(emptySelection());
  });

  it('reaches into slots, so a slotted node is not treated as deleted', () => {
    expect(pruneSelection({ pageId: 'p1', mids: ['badge00000'] }, pages).mids).toEqual(['badge00000']);
  });
});

describe('keyboard traversal', () => {
  const doc = tree();

  it('excludes the artboard root from everything selectable', () => {
    const mids = selectableMids(doc);
    expect(mids).not.toContain('root000000');
    expect(mids).toContain('badge00000');           // slots included
    expect(mids[0]).toBe('header0000');             // document order
  });

  it('walks siblings and wraps', () => {
    expect(siblingMids(doc, 'bbbbbbbbbb')).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
    expect(tabTarget(doc, 'aaaaaaaaaa', 1)).toBe('bbbbbbbbbb');
    expect(tabTarget(doc, 'cccccccccc', 1)).toBe('aaaaaaaaaa');
    expect(tabTarget(doc, 'aaaaaaaaaa', -1)).toBe('cccccccccc');
  });

  it('starts from the first (or last) node when nothing is selected', () => {
    expect(tabTarget(doc, null, 1)).toBe('header0000');
    expect(tabTarget(doc, null, -1)).toBe('badge00000');
    expect(tabTarget(doc, 'not-a-mid', 1)).toBe('header0000');
  });

  it('falls back to document order for an only child', () => {
    // `title00000` is `header0000`'s only child; tabbing must not park forever.
    expect(tabTarget(doc, 'title00000', 1)).not.toBe('title00000');
  });

  it('has nothing to move to in an empty artboard', () => {
    expect(tabTarget({ mid: 'solo000000', tag: 'UI.Screen' }, null, 1)).toBeNull();
  });
});

describe('marquee', () => {
  const candidates = [
    { mid: 'aaaaaaaaaa', rect: { x: 10, y: 10, w: 50, h: 50 } },
    { mid: 'bbbbbbbbbb', rect: { x: 100, y: 10, w: 50, h: 50 } },
    { mid: 'cccccccccc', rect: { x: 0, y: 0, w: 400, h: 400 } },
  ];

  it('requires full containment by default, so ancestors are not swept up', () => {
    expect(marqueeHits(candidates, { x: 0, y: 0, w: 200, h: 200 })).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
  });

  it('intersect mode is opt-in', () => {
    expect(marqueeHits(candidates, { x: 0, y: 0, w: 20, h: 20 }, 'intersect'))
      .toEqual(['aaaaaaaaaa', 'cccccccccc']);
  });

  it('ignores malformed candidates rather than throwing', () => {
    const junk = [null, { mid: 1 }, { mid: 'x' }] as unknown as typeof candidates;
    expect(() => marqueeHits(junk, { x: 0, y: 0, w: 10, h: 10 })).not.toThrow();
    expect(marqueeHits(junk, { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });

  it('treats a wobble under the threshold as a click, not a drag', () => {
    expect(isMarqueeGesture({ x: 0, y: 0, w: MARQUEE_MIN_DRAG_PX - 1, h: 1 })).toBe(false);
    expect(isMarqueeGesture({ x: 0, y: 0, w: 0, h: MARQUEE_MIN_DRAG_PX })).toBe(true);
  });
});

describe('arrow nudge produces the SAME op an agent tool produces', () => {
  it('maps keys to deltas, with a coarse step on shift', () => {
    expect(arrowDelta('ArrowLeft')).toEqual({ dx: -NUDGE_STEP_PX, dy: 0 });
    expect(arrowDelta('ArrowDown', true)).toEqual({ dx: 0, dy: NUDGE_STEP_LARGE_PX });
    expect(arrowDelta('Enter')).toBeNull();
  });

  it('composes a translate for flow-layout nodes', () => {
    expect(nudgeStyle(undefined, 4, -2)).toEqual({ transform: 'translate(4px, -2px)' });
  });

  it('accumulates an existing leading translate instead of nesting them', () => {
    const once = nudgeStyle({ transform: 'translate(4px, -2px)' }, 4, -2);
    expect(once).toEqual({ transform: 'translate(8px, -4px)' });
  });

  it('preserves any other transform functions', () => {
    expect(nudgeStyle({ transform: 'translate(1px, 1px) rotate(3deg)' }, 1, 0))
      .toEqual({ transform: 'translate(2px, 1px) rotate(3deg)' });
    expect(nudgeStyle({ transform: 'rotate(3deg)' }, 1, 2))
      .toEqual({ transform: 'translate(1px, 2px) rotate(3deg)' });
  });

  it('moves an absolutely positioned node by left/top, which is what the author meant', () => {
    expect(nudgeStyle({ position: 'absolute', left: '10px', top: '20px' }, -5, 5))
      .toEqual({ position: 'absolute', left: '5px', top: '25px' });
    // A missing or non-px offset starts from 0 rather than emitting NaN.
    expect(nudgeStyle({ position: 'fixed' }, 3, 0)).toEqual({ position: 'fixed', left: '3px', top: '0px' });
    expect(nudgeStyle({ position: 'absolute', left: '50%' }, 3, 0).left).toBe('3px');
  });

  it('emits el.setStyle per selected element and skips ghosts and the root', () => {
    const doc = tree();
    const ops = nudgeOps('p1', doc, ['aaaaaaaaaa', 'root000000', 'ghost00000', 'badge00000'], 0, 10);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa',
      style: { transform: 'translate(0px, 10px)' },
    });
    expect(ops[1].op).toBe('el.setStyle');
  });

  it('is a no-op for a zero delta or an empty selection', () => {
    expect(nudgeOps('p1', tree(), ['aaaaaaaaaa'], 0, 0)).toEqual([]);
    expect(nudgeOps('', tree(), ['aaaaaaaaaa'], 1, 0)).toEqual([]);
    expect(nudgeOps('p1', tree(), [], 1, 0)).toEqual([]);
  });

  it('does not mutate the doc - the op does, once the host applies it', () => {
    const doc = tree();
    const before = JSON.stringify(doc);
    nudgeOps('p1', doc, ['aaaaaaaaaa'], 5, 5);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('SelectionOverlay pools its elements', () => {
  function overlay() {
    const doc = new FakeDocument();
    const host = new FakeElement('div');
    const o = new SelectionOverlay({ doc: doc as unknown as DomDocument, host: host as unknown as DomElement });
    return { doc, host, o };
  }

  it('places boxes in screen space and marks the anchor', () => {
    const { host, o } = overlay();
    o.render([
      { mid: 'aaaaaaaaaa', rect: { x: 10.4, y: 20.6, w: 100, h: 50 } },
      { mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 10, h: 10 }, primary: true },
    ]);
    expect(o.visibleCount).toBe(2);
    expect(host.children[0].style.get('left')).toBe('10px');
    expect(host.children[0].style.get('top')).toBe('21px');
    expect(host.children[0].style.get('width')).toBe('100px');
    expect(host.children[1].className).toContain('primary');
    expect(host.children[0].attrs.get('data-mid')).toBe('aaaaaaaaaa');
  });

  it('reuses elements instead of rebuilding them on every pan frame', () => {
    const { doc, o } = overlay();
    for (let i = 0; i < 30; i++) {
      o.render([{ mid: 'aaaaaaaaaa', rect: { x: i, y: 0, w: 10, h: 10 } }]);
    }
    expect(doc.created).toHaveLength(1);
    expect(o.poolSize).toBe(1);
  });

  it('hides surplus boxes and drops their mid when the selection shrinks', () => {
    const { host, doc, o } = overlay();
    o.render([
      { mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 1, h: 1 } },
    ]);
    o.render([{ mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 } }]);
    expect(doc.created).toHaveLength(2);           // pooled, not re-created
    expect(o.visibleCount).toBe(1);
    expect(host.children[1].hidden).toBe(true);
    expect(host.children[1].attrs.has('data-mid')).toBe(false);
  });

  it('creates the marquee lazily and hides it rather than churning it', () => {
    const { host, doc, o } = overlay();
    o.setMarquee(null);
    expect(doc.created).toHaveLength(0);
    o.setMarquee({ x: 5, y: 5, w: 50, h: 50 });
    o.setMarquee({ x: 5, y: 5, w: 60, h: 60 });
    expect(doc.created).toHaveLength(1);
    expect(host.children[0].style.get('width')).toBe('60px');
    o.clear();
    expect(host.children[0].hidden).toBe(true);
    expect(o.visibleCount).toBe(0);
  });

  it('removes everything on dispose', () => {
    const { host, o } = overlay();
    o.render([{ mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 } }]);
    o.setMarquee({ x: 0, y: 0, w: 1, h: 1 });
    o.dispose();
    expect(host.children).toHaveLength(0);
    expect(o.poolSize).toBe(0);
  });

  it('never writes a negative extent, whatever geometry a frame reported', () => {
    const { host, o } = overlay();
    o.render([{ mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: -40, h: -40 } }]);
    expect(host.children[0].style.get('width')).toBe('0px');
    expect(host.children[0].style.get('height')).toBe('0px');
  });
});
