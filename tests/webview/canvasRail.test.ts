/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 row 1 — the pages rail.
 *
 * The rail used to be N text rows because a thumbnail was assumed to be a
 * picture of the live frame, which `sandbox="allow-scripts"` without
 * `allow-same-origin` makes impossible. These tests pin the replacement: tiles
 * drawn by the parent from the `DocNode` tree, and every rail gesture emitting
 * the SAME op an agent tool produces — including the two properties that are
 * easy to get wrong and invisible when you do (the drop index excludes the
 * dragged row; a drag that did not move emits nothing at all).
 */
import { describe, it, expect } from 'vitest';
import {
  RailController,
  RAIL_DRAG_THRESHOLD_PX,
  LEGACY_BADGE_LABEL,
  LEGACY_BADGE_HINT,
  addPageOps,
  beginRailDrag,
  blankArtboardDoc,
  deviceBadge,
  duplicatePageOps,
  endRailDrag,
  moveInOrder,
  nextBoardPos,
  pointerY,
  railDragOrder,
  railActionKeyIntent,
  railDropIndex,
  railKeyIntent,
  railReorderOps,
  railRows,
  removePageOps,
  updateRailDrag,
  type RailRowGeometry,
} from '../../src/webview/canvas/rail';
import { initialViewState } from '../../src/webview/canvas/state';
import { themeCssVars } from '../../src/webview/canvas/sandboxDoc';
import type { CanvasOp } from '../../src/canvas/CanvasOps';
import type { WireArtifact } from '../../src/canvas/protocol';
import type { CanvasEnv, DomElement } from '../../src/webview/canvas/dom';
import type { ArtifactPage, CanvasFormatSpec, DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { FakeChannel, FakeDocument, FakeElement } from './canvasFakeDom';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP: CanvasFormatSpec = getFormat('desktop')!;
const MOBILE: CanvasFormatSpec = getFormat('mobile')!;

function page(id: string, extra: Partial<ArtifactPage> = {}): ArtifactPage {
  return {
    id,
    version: 1,
    boardPos: { x: 0, y: 0 },
    actionTitle: id.toUpperCase(),
    doc: {
      mid: `mid-${id}`,
      tag: 'UI.Screen',
      children: [{ mid: `head-${id}`, tag: 'UI.Heading', text: `Heading ${id}` }],
    },
    ...extra,
  };
}

function artifact(pages: ArtifactPage[]): WireArtifact {
  return {
    id: 'art1', version: 3, kind: 'screens', name: 'Acme', format: DESKTOP,
    theme: THEME, pages, assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

function geometry(ids: string[], height = 100): RailRowGeometry[] {
  return ids.map((pageId, i) => ({ pageId, top: i * height, height }));
}

/* ============================== pure model ============================== */

describe('railRows', () => {
  it('names untitled artboards positionally and marks the focused one', () => {
    const art = artifact([page('a', { actionTitle: undefined }), page('b')]);
    const rows = railRows(art, { focusedPageId: 'b' });
    expect(rows.map(r => r.title)).toEqual(['Artboard 1', 'B']);
    expect(rows.map(r => r.selected)).toEqual([false, true]);
    expect(rows.map(r => r.index)).toEqual([0, 1]);
  });

  it('falls back to the artifact format and prefers the page override', () => {
    const art = artifact([page('a'), page('b', { format: MOBILE })]);
    const rows = railRows(art, { focusedPageId: null });
    expect(rows[0].format.formatId).toBe('desktop');
    expect(rows[1].format.formatId).toBe('mobile');
    expect(rows[1].device.label).toContain('390×844');
  });

  it('badges the artboard\'s REAL device, never the human\'s local preview override', () => {
    // §3.5: "show me this on mobile" is view state; "this artboard IS mobile"
    // is artifact state. A badge that followed the preview would report the
    // second when the human only asked for the first.
    const art = artifact([page('a')]);
    const view = { ...initialViewState(), previewFormat: MOBILE, focusedPageId: 'a' };
    const rows = railRows(art, view);
    expect(rows[0].format.formatId).toBe('desktop');
    expect(rows[0].device.label).toContain('1440×900');
  });

  it('badges a legacy page honestly, and carries the compile error in the hint', () => {
    const art = artifact([
      page('a'),
      page('b', { legacy: { mode: 'jsx', source: 'function Page(){ return items.map(x => <div/>) }' }, compileError: 'unsupported: .map' }),
    ]);
    const rows = railRows(art, { focusedPageId: null });
    expect(rows[0].legacy).toBeNull();
    expect(rows[1].legacy?.label).toBe(LEGACY_BADGE_LABEL);
    expect(rows[1].legacy?.hint).toContain(LEGACY_BADGE_HINT);
    expect(rows[1].legacy?.hint).toContain('unsupported: .map');
  });

  it('uses the boot device catalog for badge names when it has one', () => {
    const art = artifact([page('a', { format: MOBILE })]);
    const labels = new Map([['mobile', 'iPhone 15']]);
    const rows = railRows(art, { focusedPageId: null }, { deviceLabels: labels });
    expect(rows[0].device.label).toBe('iPhone 15 · 390×844');
  });
});

describe('deviceBadge', () => {
  it('prettifies an unknown format id and marks print formats', () => {
    expect(deviceBadge(getFormat('story-9x16')!).label).toBe('Story 9x16 · 1080×1920');
    expect(deviceBadge(getFormat('a4-portrait')!).hint).toContain('print format');
    expect(deviceBadge(DESKTOP).hint).toContain('screen format');
  });

  it('shows bare dimensions for a custom format', () => {
    expect(deviceBadge({ formatId: 'custom', kind: 'screen', width: 900, height: 600 }).label).toBe('900×600');
  });
});

/* ================================= drag ================================= */

describe('railDropIndex', () => {
  const rows = geometry(['a', 'b', 'c', 'd']);

  it('returns 0 above every row and the last index below every row', () => {
    expect(railDropIndex(rows, 'a', -50)).toBe(0);
    expect(railDropIndex(rows, 'a', 10_000)).toBe(3);
  });

  it('excludes the dragged row, so dragging down by one is not a no-op', () => {
    // Rows are 100 tall. Dragging 'a' just past b's midpoint (150) must land at
    // index 1. Counting the dragged row would return 0 and eat the gesture.
    expect(railDropIndex(rows, 'a', 151)).toBe(1);
    expect(railDropIndex(rows, 'a', 149)).toBe(0);
  });

  it('is insensitive to the order geometry arrives in', () => {
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];
    // Sorted by `top`, the survivors are a(0) b(100) c(200); y=151 is past the
    // midpoints of a and b, so 'd' lands third.
    expect(railDropIndex(shuffled, 'd', 151)).toBe(2);
    expect(railDropIndex(shuffled, 'd', 149)).toBe(1);
  });

  it('handles a single row', () => {
    expect(railDropIndex(geometry(['only']), 'only', 5000)).toBe(0);
  });
});

describe('drag session', () => {
  const rows = geometry(['a', 'b', 'c']);

  it('refuses to start on a row it cannot find', () => {
    expect(beginRailDrag(rows, 'ghost', 10)).toBeNull();
  });

  it('stays put until the pointer passes the threshold', () => {
    const start = beginRailDrag(rows, 'a', 10)!;
    expect(start.moved).toBe(false);
    const jitter = updateRailDrag(start, rows, 10 + RAIL_DRAG_THRESHOLD_PX - 1);
    expect(jitter.moved).toBe(false);
    expect(jitter.toIndex).toBe(0);
    expect(endRailDrag(jitter, ['a', 'b', 'c'])).toEqual([]);
  });

  it('stays "moved" once the threshold is crossed, even if the pointer returns', () => {
    const start = beginRailDrag(rows, 'a', 10)!;
    const moved = updateRailDrag(start, rows, 260);
    const back = updateRailDrag(moved, rows, 10);
    expect(back.moved).toBe(true);
    expect(back.toIndex).toBe(0);
  });

  it('produces ONE page.reorder carrying the final order', () => {
    const ids = ['a', 'b', 'c'];
    const drag = updateRailDrag(beginRailDrag(rows, 'a', 10)!, rows, 260);
    expect(drag.toIndex).toBe(2);
    expect(railDragOrder(drag, ids)).toEqual(['b', 'c', 'a']);
    const ops = endRailDrag(drag, ids);
    expect(ops).toEqual([{ op: 'page.reorder', orderedIds: ['b', 'c', 'a'] }]);
    expect(ops).toHaveLength(1); // never N page.moves
  });

  it('drags upward too', () => {
    const ids = ['a', 'b', 'c'];
    const drag = updateRailDrag(beginRailDrag(rows, 'c', 250)!, rows, 5);
    expect(railDragOrder(drag, ids)).toEqual(['c', 'a', 'b']);
  });
});

describe('railReorderOps', () => {
  it('emits nothing when the order is unchanged', () => {
    expect(railReorderOps(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('refuses an order that is not a permutation — a dropped or duplicated id', () => {
    expect(railReorderOps(['a', 'b', 'c'], ['a', 'b'])).toEqual([]);
    expect(railReorderOps(['a', 'b'], ['a', 'a'])).toEqual([]);
    expect(railReorderOps(['a', 'b'], ['a', 'z'])).toEqual([]);
  });

  it('copies the order, so a later mutation of the caller\'s array cannot rewrite the op', () => {
    const next = ['b', 'a'];
    const ops = railReorderOps(['a', 'b'], next);
    next.push('c');
    expect(ops[0]).toEqual({ op: 'page.reorder', orderedIds: ['b', 'a'] });
  });
});

describe('moveInOrder', () => {
  it('moves an item and clamps out-of-range targets', () => {
    expect(moveInOrder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveInOrder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveInOrder(['a', 'b', 'c'], -1, 0)).toEqual(['a', 'b', 'c']);
  });
});

/* =========================== insert / duplicate =========================== */

describe('page ops', () => {
  it('addPageOps proposes a doc but never an id — ids are minted host-side', () => {
    let n = 0;
    const ops = addPageOps({
      format: MOBILE, boardPos: { x: 400, y: 0 }, index: 2, title: 'Checkout',
      mint: () => `m${n++}`,
    });
    expect(ops).toHaveLength(1);
    const op = ops[0] as Extract<CanvasOp, { op: 'page.add' }>;
    expect(op.op).toBe('page.add');
    expect(op.index).toBe(2);
    expect(op.page.id).toBeUndefined();
    expect(op.page.actionTitle).toBe('Checkout');
    expect(op.page.format.formatId).toBe('mobile');
    expect(op.page.boardPos).toEqual({ x: 400, y: 0 });
  });

  it('omits index entirely when appending', () => {
    const op = addPageOps({ format: DESKTOP, boardPos: { x: 0, y: 0 } })[0];
    expect('index' in op).toBe(false);
  });

  it('blankArtboardDoc gives the human something to click and the agent an anchor', () => {
    let n = 0;
    const doc = blankArtboardDoc(() => `m${n++}`, 'Hello');
    expect(doc.tag).toBe('UI.Screen');
    expect(doc.children?.[0].tag).toBe('UI.Stack');
    expect(doc.children?.[0].children?.[0].text).toBe('Hello');
    const mids = [doc.mid, doc.children![0].mid, doc.children![0].children![0].mid];
    expect(new Set(mids).size).toBe(3);
  });

  it('duplicate and remove are single ops on the shared stack', () => {
    expect(duplicatePageOps('p1')).toEqual([{ op: 'page.duplicate', pageId: 'p1' }]);
    expect(removePageOps('p1')).toEqual([{ op: 'page.remove', pageId: 'p1' }]);
  });
});

describe('nextBoardPos', () => {
  it('is the origin for the first artboard', () => {
    expect(nextBoardPos([], DESKTOP)).toEqual({ x: 0, y: 0 });
  });

  it('places the new artboard right of everything, honouring per-page widths', () => {
    const pages = [
      page('a', { boardPos: { x: 0, y: 40 } }),
      page('b', { boardPos: { x: 1560, y: 40 }, format: MOBILE }),
    ];
    const pos = nextBoardPos(pages, DESKTOP);
    expect(pos.x).toBe(1560 + 390 + 120);
    expect(pos.y).toBe(40);
  });
});

describe('pointerY', () => {
  it('reads clientY, falls back to pageY, and refuses anything else', () => {
    expect(pointerY({ clientY: 12 })).toBe(12);
    expect(pointerY({ pageY: 7 })).toBe(7);
    expect(pointerY({ clientY: NaN })).toBeNull();
    expect(pointerY({})).toBeNull();
    expect(pointerY(null)).toBeNull();
    expect(pointerY('nope')).toBeNull();
  });
});

/* ============================== controller ============================== */

interface Harness {
  rail: RailController;
  list: FakeElement;
  submitted: CanvasOp[][];
  selected: string[];
  doc: FakeDocument;
}

function harness(pages: ArtifactPage[], focusedPageId: string | null = null, rowHeight = 100): Harness {
  const doc = new FakeDocument();
  const list = new FakeElement('div');
  const env: CanvasEnv = {
    doc: doc as unknown as CanvasEnv['doc'],
    self: { addEventListener: () => { /* unused */ } },
    createIntersectionObserver: null,
    createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
    fetchText: async () => '',
    now: () => 1_000,
    warn: () => { /* silent */ },
  };
  const submitted: CanvasOp[][] = [];
  const selected: string[] = [];
  const rail = new RailController({
    env,
    list: list as unknown as DomElement,
    callbacks: { submit: ops => submitted.push(ops), select: id => selected.push(id) },
    measure: (_el, pageId, index) => ({ pageId, top: index * rowHeight, height: rowHeight }),
  });
  rail.render(artifact(pages), { focusedPageId });
  return { rail, list, submitted, selected, doc };
}

describe('RailController', () => {
  it('draws a real thumbnail per artboard, from the doc, with no innerHTML', () => {
    const { list } = harness([page('a'), page('b')]);
    const rows = list.children;
    expect(rows).toHaveLength(2);
    // The tile contains the artboard's own text, so it is a drawn preview and
    // not a placeholder box. `FakeElement.innerHTML` throws on both read and
    // write, so reaching this line at all proves the renderer never used it.
    expect(rows[0].allText()).toContain('Heading a');
    expect(rows[1].allText()).toContain('Heading b');
  });

  it('renders the device badge and the honest legacy badge', () => {
    const { list } = harness([
      page('a', { format: MOBILE }),
      page('b', { legacy: { mode: 'html', source: '<p/>' } }),
    ]);
    const badges = list.findAll(el => el.className.includes('thumb-badge'));
    const labels = badges.map(b => b.textContent);
    expect(labels).toContain('Mobile · 390×844');
    expect(labels).toContain(LEGACY_BADGE_LABEL);
    const legacy = badges.find(b => b.textContent === LEGACY_BADGE_LABEL)!;
    expect(legacy.attrs.get('title')).toBe(LEGACY_BADGE_HINT);
  });

  it('selects on click', () => {
    const h = harness([page('a'), page('b')]);
    h.list.children[1].fire('click');
    expect(h.selected).toEqual(['b']);
    expect(h.submitted).toEqual([]);
  });

  it('turns a drag into exactly one page.reorder', () => {
    const h = harness([page('a'), page('b'), page('c')]);
    const row = h.list.children[0];
    row.fire('pointerdown', { clientY: 10 });
    h.list.fire('pointermove', { clientY: 260 });
    h.list.fire('pointerup', { clientY: 260 });
    expect(h.submitted).toEqual([[{ op: 'page.reorder', orderedIds: ['b', 'c', 'a'] }]]);
  });

  it('a press that never moved selects instead of reordering', () => {
    const h = harness([page('a'), page('b'), page('c')]);
    const row = h.list.children[0];
    row.fire('pointerdown', { clientY: 10 });
    h.list.fire('pointerup', { clientY: 11 });
    row.fire('click');
    expect(h.submitted).toEqual([]);
    expect(h.selected).toEqual(['a']);
  });

  it('a completed drag does not also select', () => {
    const h = harness([page('a'), page('b'), page('c')]);
    const row = h.list.children[0];
    row.fire('pointerdown', { clientY: 10 });
    h.list.fire('pointermove', { clientY: 260 });
    h.list.fire('pointerup', { clientY: 260 });
    row.fire('click');
    expect(h.selected).toEqual([]);
  });

  it('a pointer that leaves the rail cancels the drag rather than leaving it stuck', () => {
    const h = harness([page('a'), page('b'), page('c')]);
    h.list.children[0].fire('pointerdown', { clientY: 10 });
    h.list.fire('pointermove', { clientY: 260 });
    h.list.fire('pointerleave');
    expect(h.rail.drag()).toBeNull();
    h.list.fire('pointerup', { clientY: 260 });
    expect(h.submitted).toEqual([]);
  });

  it('per-row actions emit duplicate / remove and never start a drag', () => {
    const h = harness([page('a'), page('b')]);
    const actions = h.list.children[0].findAll(el => el.className === 'thumb-action');
    expect(actions).toHaveLength(3);

    let prevented = 0;
    actions[1].fire('pointerdown', { clientY: 10, stopPropagation: () => { prevented++; }, preventDefault: () => { /* noop */ } });
    expect(h.rail.drag()).toBeNull();
    expect(prevented).toBe(1);

    actions[1].fire('click', { stopPropagation: () => { /* noop */ }, preventDefault: () => { /* noop */ } });
    actions[2].fire('click', { stopPropagation: () => { /* noop */ }, preventDefault: () => { /* noop */ } });
    expect(h.submitted).toEqual([
      [{ op: 'page.duplicate', pageId: 'a' }],
      [{ op: 'page.remove', pageId: 'a' }],
    ]);
    expect(h.selected).toEqual([]);
  });

  it('the row "+" inserts a blank artboard right after that row', () => {
    const h = harness([page('a'), page('b')]);
    const insert = h.list.children[0].findAll(el => el.className === 'thumb-action')[0];
    insert.fire('click', { stopPropagation: () => { /* noop */ }, preventDefault: () => { /* noop */ } });
    const op = h.submitted[0][0] as Extract<CanvasOp, { op: 'page.add' }>;
    expect(op.op).toBe('page.add');
    expect(op.index).toBe(1);
    expect(op.page.boardPos).toEqual({ x: 1440 + 120, y: 0 });
  });

  it('re-rendering drops any live drag, so a stale order can never be committed', () => {
    const h = harness([page('a'), page('b'), page('c')]);
    h.list.children[0].fire('pointerdown', { clientY: 10 });
    h.list.fire('pointermove', { clientY: 260 });
    h.rail.render(artifact([page('c'), page('b'), page('a')]), { focusedPageId: null });
    expect(h.rail.drag()).toBeNull();
    h.list.fire('pointerup', { clientY: 260 });
    expect(h.submitted).toEqual([]);
  });
});

/* ====================== one tab stop, keyboard actions ====================== */

/** Record what the controller asked to focus (the fake DOM has no focus model). */
function trackFocus(list: FakeElement): FakeElement[] {
  const focused: FakeElement[] = [];
  for (const el of list.walk()) {
    (el as unknown as { focus?: () => void }).focus = () => { focused.push(el); };
  }
  return focused;
}

describe('railActionKeyIntent', () => {
  it('moves within the actions, back to the row, and leaves activation alone', () => {
    expect(railActionKeyIntent({ key: 'ArrowRight' })).toEqual({ kind: 'sibling', delta: 1 });
    expect(railActionKeyIntent({ key: 'ArrowLeft' })).toEqual({ kind: 'sibling', delta: -1 });
    expect(railActionKeyIntent({ key: 'ArrowDown' })).toEqual({ kind: 'row', delta: 1 });
    expect(railActionKeyIntent({ key: 'ArrowUp' })).toEqual({ kind: 'row', delta: -1 });
    expect(railActionKeyIntent({ key: 'Escape' })).toEqual({ kind: 'row', delta: 0 });
    expect(railActionKeyIntent({ key: 'Home' })).toEqual({ kind: 'edge', to: 'first' });
    // Enter and Space ACTIVATE the button; the rail must not touch them.
    expect(railActionKeyIntent({ key: 'Enter' })).toBeNull();
    expect(railActionKeyIntent({ key: ' ' })).toBeNull();
    // Nor may it steal an editor chord.
    expect(railActionKeyIntent({ key: 'ArrowRight', metaKey: true })).toBeNull();
    expect(railActionKeyIntent({ key: 'ArrowDown', altKey: true })).toBeNull();
  });

  it('maps ArrowRight on a ROW into that row\'s actions', () => {
    expect(railKeyIntent({ key: 'ArrowRight' })).toEqual({ kind: 'action', delta: 1 });
    expect(railKeyIntent({ key: 'ArrowLeft' })).toEqual({ kind: 'action', delta: -1 });
    expect(railKeyIntent({ key: 'ArrowRight', altKey: true })).toBeNull();
  });
});

describe('the rail is ONE tab stop (A11Y-8)', () => {
  it('keeps the three row actions out of the tab order', () => {
    // The class documents "exactly one tab stop rather than one per row plus
    // three per row's actions", but `_applyRovingTabIndex` only ever wrote
    // tabindex onto the ROW, and a <button> is tabbable by default — so a
    // 20-artboard rail was 80 tab stops, and tabbing landed on "Delete
    // Artboard 3" of a row the user was only passing through.
    const { list } = harness([page('a'), page('b'), page('c')]);
    const buttons = list.findAll(el => el.tag === 'button');
    expect(buttons).toHaveLength(9);
    for (const b of buttons) {
      expect(b.attrs.get('tabindex'), b.attrs.get('aria-label')).toBe('-1');
    }
    const tabbable = list.findAll(el => el.attrs.get('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].attrs.get('role')).toBe('option');
  });

  it('reaches the row actions with ArrowRight and comes back with ArrowLeft', () => {
    const h = harness([page('a'), page('b')]);
    const focused = trackFocus(h.list);
    const row0 = h.list.children[0];
    const actions = row0.findAll(el => el.className === 'thumb-action');

    row0.fire('keydown', { key: 'ArrowRight' });
    expect(focused.at(-1)).toBe(actions[0]);
    actions[0].fire('keydown', { key: 'ArrowRight' });
    expect(focused.at(-1)).toBe(actions[1]);
    actions[1].fire('keydown', { key: 'ArrowLeft' });
    expect(focused.at(-1)).toBe(actions[0]);
    actions[0].fire('keydown', { key: 'ArrowLeft' });
    expect(focused.at(-1)).toBe(row0);
  });

  it('leaves an action button for the next artboard with ArrowDown', () => {
    const h = harness([page('a'), page('b')]);
    const focused = trackFocus(h.list);
    const action = h.list.children[0].findAll(el => el.className === 'thumb-action')[2];
    action.fire('keydown', { key: 'ArrowDown' });
    expect(focused.at(-1)).toBe(h.list.children[1]);
  });

  it('never swallows Enter or Space on an action button', () => {
    // Those are the keys that ACTIVATE it; the rail must leave them to the
    // browser (and to the board's own Space guard).
    const h = harness([page('a')]);
    const action = h.list.children[0].findAll(el => el.className === 'thumb-action')[1];
    let prevented = 0;
    for (const key of ['Enter', ' ']) {
      action.fire('keydown', { key, preventDefault: () => { prevented++; }, stopPropagation: () => { /* noop */ } });
    }
    expect(prevented).toBe(0);
  });

  it('claims ArrowLeft/ArrowRight so they cannot reach the board and nudge an element', () => {
    const h = harness([page('a')]);
    let prevented = 0;
    h.list.children[0].fire('keydown', {
      key: 'ArrowRight',
      preventDefault: () => { prevented++; },
      stopPropagation: () => { /* noop */ },
    });
    expect(prevented).toBe(1);
  });
});

/* ======================= theme vars on the tile ======================= */

describe('rail thumbnails carry the design\'s own theme (CV-T1)', () => {
  it('sets every --theme-* var on the tile the preview is drawn into', () => {
    // `preview.ts` emits `var(--theme-color-text)` / `var(--theme-color-background)`
    // with NO fallback. Those custom properties were set in exactly one place —
    // the `.artboard` root in `board.ts` — and a rail tile has no `.artboard`
    // ancestor, so every declaration was invalid at computed-value time:
    // `background` fell back to `transparent` (showing the hardcoded white
    // `--canvas-paper` beneath) and `color` inherited the SHELL's foreground.
    // In any dark theme that is ~#CCCCCC text on #FFFFFF paper.
    const { list } = harness([page('a')]);
    const tile = list.children[0].find(el => el.className === 'thumb-preview')!;
    const expected = themeCssVars(THEME);
    expect(Object.keys(expected).length).toBeGreaterThan(4);
    for (const [name, value] of Object.entries(expected)) {
      expect(tile.style.get(name), `${name} on the rail tile`).toBe(value);
    }
  });

  it('re-reads the theme on every render, so a theme.set op repaints the rail', () => {
    const h = harness([page('a')]);
    const dark: DesignTheme = { ...THEME, colors: { ...THEME.colors, background: '#101418', text: '#f4f6f8' } };
    h.rail.render({ ...artifact([page('a')]), theme: dark }, { focusedPageId: null });
    const tile = h.list.children[0].find(el => el.className === 'thumb-preview')!;
    expect(tile.style.get('--theme-color-background')).toBe('#101418');
    expect(tile.style.get('--theme-color-text')).toBe('#f4f6f8');
  });
});
