/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 rows 1-2 — the board as a surface a human can actually use.
 *
 * `canvasBoard.test.ts` covers the delta protocol ("an edit is a message, not a
 * rebuild"). This file covers what Phase 3 adds on top: one transformed world
 * of N artboards, virtualization that RETAINS frames instead of churning them,
 * and click-to-select drawn by the parent — over live frames and static
 * previews alike.
 *
 * The sharpest assertions here are the negative ones (§3.5): an incoming
 * `canvas/ops` must not move the viewport, must not change the selection, and
 * must not re-focus an artboard. Today's canvas does all three, which is what
 * makes co-editing with an agent feel like fighting it.
 */
import { describe, it, expect } from 'vitest';
import {
  BOARD_OVERLAY_ID, BOARD_VIEWPORT_ID, BOARD_ZOOM_FIT_ID, BOARD_ZOOM_IN_ID,
  BOARD_ZOOM_LEVEL_ID, BOARD_ZOOM_OUT_ID, BoardController,
} from '../../src/webview/canvas/board';
import { initialViewState, planRender, type CanvasViewState } from '../../src/webview/canvas/state';
import { screenToWorld } from '../../src/webview/canvas/boardMath';
import type { CanvasEnv, DomDocument, DomElement, MessageChannelLike } from '../../src/webview/canvas/dom';
import type { CanvasOpRecord, WireArtifact } from '../../src/canvas/protocol';
import type { CanvasOp } from '../../src/canvas/CanvasOps';
import type { SelectionState } from '../../src/webview/canvas/selection';
import type { ArtifactPage, DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { FakeChannel, FakeDocument, FakeElement, FakeIntersectionObserver } from './canvasFakeDom';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP = getFormat('desktop')!;

/** The viewport host is the one element the board measures and binds input on. */
class FakeViewport extends FakeElement {
  clientWidth = 800;
  clientHeight = 600;
  box = { left: 220, top: 44, width: 800, height: 600 };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } { return this.box; }
}

/** A stand-in for a rendered preview node: attributes, a parent, a box. */
interface DomStub {
  getAttribute(name: string): string | null;
  parentElement: DomStub | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

function stub(
  attrs: Record<string, string>,
  parent: DomStub | null = null,
  box = { left: 0, top: 0, width: 0, height: 0 },
): DomStub {
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    parentElement: parent,
    getBoundingClientRect: () => box,
  };
}

function page(id: string, x = 0): ArtifactPage {
  return {
    id, version: 1, boardPos: { x, y: 0 }, actionTitle: id,
    doc: {
      mid: 'root000000', tag: 'UI.Screen',
      children: [
        { mid: 'aaaaaaaaaa', tag: 'UI.Heading', text: `${id}-a` },
        { mid: 'bbbbbbbbbb', tag: 'UI.Text', text: `${id}-b` },
        { mid: 'cccccccccc', tag: 'UI.Text', text: `${id}-c` },
      ],
    },
  };
}

function artifact(pages: ArtifactPage[]): WireArtifact {
  return {
    id: 'art1', version: 1, kind: 'screens', name: 'Acme', format: DESKTOP,
    theme: THEME, pages, assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

function v2(op: CanvasOp, opId = 'o1'): CanvasOpRecord {
  return { opId, txnId: 't', runId: 'r', author: 'agent', actorId: 'a', op, status: 'applied', ts: 0 } as unknown as CanvasOpRecord;
}

interface Harness {
  env: CanvasEnv;
  doc: FakeDocument;
  world: FakeElement;
  viewport: FakeViewport;
  overlay: FakeElement;
  channels: FakeChannel[];
  observer(): FakeIntersectionObserver | null;
  /** Fire a window-level listener (keydown, pointermove, pointerup, blur). */
  fire(type: string, ev?: unknown): void;
  selections: SelectionState[];
  views: CanvasViewState[];
  ops: CanvasOp[][];
  focused: string[];
  edits: Array<{ pageId: string; mid: string }>;
}

function makeHarness(): Harness {
  const doc = new FakeDocument();
  const world = new FakeElement('div');
  const viewport = new FakeViewport('div');
  const overlay = new FakeElement('div');
  doc.byId.set(BOARD_VIEWPORT_ID, viewport as unknown as FakeElement);
  doc.byId.set(BOARD_OVERLAY_ID, overlay);
  doc.byId.set(BOARD_ZOOM_LEVEL_ID, new FakeElement('span'));
  doc.byId.set(BOARD_ZOOM_IN_ID, new FakeElement('button'));
  doc.byId.set(BOARD_ZOOM_OUT_ID, new FakeElement('button'));
  doc.byId.set(BOARD_ZOOM_FIT_ID, new FakeElement('button'));

  const channels: FakeChannel[] = [];
  const windowListeners = new Map<string, Array<(ev: unknown) => void>>();
  let observer: FakeIntersectionObserver | null = null;

  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: {
      addEventListener: (type, listener) => {
        const list = windowListeners.get(type);
        if (list) { list.push(listener); } else { windowListeners.set(type, [listener]); }
      },
    },
    createIntersectionObserver: cb => {
      observer = new FakeIntersectionObserver(cb as unknown as (e: readonly { target: unknown; isIntersecting: boolean }[]) => void);
      return observer as unknown as ReturnType<NonNullable<CanvasEnv['createIntersectionObserver']>>;
    },
    createMessageChannel: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel as unknown as MessageChannelLike;
    },
    fetchText: async () => '',
    now: () => 0,
    warn: () => { /* quiet */ },
  };

  return {
    env, doc, world, viewport, overlay, channels,
    observer: () => observer,
    fire: (type, ev = {}) => { for (const l of windowListeners.get(type) ?? []) { l(ev); } },
    selections: [], views: [], ops: [], focused: [], edits: [],
  };
}

function board(h: Harness, opts: { maxLive?: number; autoFit?: boolean } = {}): BoardController {
  return new BoardController({
    env: h.env,
    world: h.world as unknown as DomElement,
    maxLiveFrames: opts.maxLive,
    autoFit: opts.autoFit ?? false,
    measureViewport: () => ({ width: h.viewport.clientWidth, height: h.viewport.clientHeight }),
    callbacks: {
      onSelectionChange: s => h.selections.push(s),
      onViewChange: v => h.views.push(v),
      onOps: ops => h.ops.push(ops),
      onFocusPage: id => h.focused.push(id),
      onBeginTextEdit: (pageId, mid) => h.edits.push({ pageId, mid }),
    },
  });
}

function goLive(h: Harness, controller: BoardController, art: WireArtifact, view = initialViewState()): void {
  controller.setArtifact(art, view);
  controller.setRuntime({ scripts: ['/* react */'], harness: '/* harness */' });
  h.observer()?.emit(h.world.children.map(target => ({ target, isIntersecting: true })));
  for (const frame of h.doc.created.filter(e => e.tag === 'iframe')) { frame.fire('load'); }
}

/** Screen point inside the viewport, in the same space `_localPoint` produces. */
function at(x: number, y: number): { clientX: number; clientY: number } {
  return { clientX: 220 + x, clientY: 44 + y };
}

describe('one transformed world', () => {
  it('writes the board transform onto the world element, origin 0 0', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), { ...initialViewState(), zoom: 0.5, pan: { x: 40, y: -10 } });
    expect(h.world.style.get('transform')).toBe('translate(40px, -10px) scale(0.5)');
    expect(h.world.style.get('transform-origin')).toBe('0 0');
    expect(h.doc.byId.get(BOARD_ZOOM_LEVEL_ID)!.textContent).toBe('50%');
  });

  it('places every artboard at its own boardPos and format', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    expect(h.world.children).toHaveLength(2);
    expect(h.world.children[1].style.get('left')).toBe('1600px');
    expect(h.world.children[1].findAll(e => e.className === 'artboard-surface')[0].style.get('width'))
      .toBe(`${DESKTOP.width}px`);
  });

  it('pans on a bare wheel and swallows the event so the shell does not scroll', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    let prevented = 0;
    h.viewport.fire('wheel', { deltaX: 10, deltaY: 20, preventDefault: () => { prevented++; } });
    expect(prevented).toBe(1);
    expect(controller.transform.pan).toEqual({ x: -10, y: -20 });
    expect(controller.transform.zoom).toBe(1);
    expect(h.views[h.views.length - 1].pan).toEqual({ x: -10, y: -20 });
  });

  it('ctrl-wheel zooms about the cursor, keeping that world point pinned', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(anchor, controller.transform);
    h.viewport.fire('wheel', { deltaY: -120, ctrlKey: true, ...at(anchor.x, anchor.y) });
    expect(controller.transform.zoom).toBeGreaterThan(1);
    const after = screenToWorld(anchor, controller.transform);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('space-drag pans; a plain drag does not', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    h.fire('keydown', { key: ' ', preventDefault: () => { /* */ } });
    h.viewport.fire('pointerdown', { button: 0, ...at(100, 100) });
    h.fire('pointermove', at(160, 130));
    expect(controller.transform.pan).toEqual({ x: 60, y: 30 });
    h.fire('pointerup', at(160, 130));
    h.fire('keyup', { key: ' ' });
    // Space released: the same drag is now a marquee, not a pan.
    const panned = controller.transform.pan;
    h.viewport.fire('pointerdown', { button: 0, ...at(100, 100) });
    h.fire('pointermove', at(200, 200));
    expect(controller.transform.pan).toEqual(panned);
  });

  it('zoom presets and fit are wired to the chrome buttons', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    h.doc.byId.get(BOARD_ZOOM_IN_ID)!.fire('click');
    expect(controller.transform.zoom).toBe(1.5);
    h.doc.byId.get(BOARD_ZOOM_OUT_ID)!.fire('click');
    expect(controller.transform.zoom).toBe(1);
    h.doc.byId.get(BOARD_ZOOM_FIT_ID)!.fire('click');
    // Two 1440-wide artboards 1600 apart cannot fit at 1x in an 800px viewport.
    expect(controller.transform.zoom).toBeLessThan(1);
    expect(controller.transform.zoom).toBeGreaterThan(0);
  });

  it('keeps the whole design inside the viewport after a fit', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    controller.zoomToFit();
    const { zoom, pan } = controller.transform;
    const right = pan.x + (1600 + DESKTOP.width) * zoom;
    expect(pan.x).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(h.viewport.clientWidth + 0.001);
  });
});

describe('virtualization retains frames instead of churning them', () => {
  it('reuses the SAME frame when an artboard leaves the viewport and comes back', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    goLive(h, controller, art);
    const buildsBefore = controller.buildCount;
    const frame = h.doc.created.find(e => e.tag === 'iframe')!;

    h.observer()!.emit([{ target: h.world.children[0], isIntersecting: false }]);
    h.observer()!.emit([{ target: h.world.children[0], isIntersecting: true }]);

    expect(controller.buildCount).toBe(buildsBefore);          // no rebuild
    expect(h.doc.countTag('iframe')).toBe(1);                  // no new element
    expect(controller.liveCount).toBe(1);
    expect(frame.srcdocWrites).toBeLessThanOrEqual(1);
  });

  it('evicts the coldest retained frame only when the budget is exhausted', () => {
    const h = makeHarness();
    const controller = board(h, { maxLive: 2 });
    const art = artifact([page('p1'), page('p2', 1600), page('p3', 3200)]);
    controller.setArtifact(art, initialViewState());
    controller.setRuntime({ scripts: [], harness: '' });
    const [a, b, c] = h.world.children;

    h.observer()!.emit([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }]);
    expect(controller.liveCount).toBe(2);
    // p3 scrolls in, p1 scrolls out: p1 is the coldest, so it loses the slot.
    h.observer()!.emit([{ target: a, isIntersecting: false }, { target: c, isIntersecting: true }]);
    expect(controller.liveCount).toBe(2);
    expect(controller.buildCount).toBe(3);                     // p2 was never rebuilt
  });

  it('drops every frame below the zoom threshold, retention notwithstanding', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1'), page('p2', 1600)]));
    expect(controller.liveCount).toBe(2);
    controller.setView({ ...initialViewState(), zoom: 0.1 });
    expect(controller.liveCount).toBe(0);
    // ...and the tiles are still real content, drawn by the parent.
    expect(h.world.allText()).toContain('p2-a');
  });
});

describe('click-to-select over a LIVE frame', () => {
  function live() {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1'), page('p2', 1600)]);
    goLive(h, controller, art);
    return { h, controller, art };
  }

  it('selects from a hit and draws the box in the parent overlay', () => {
    const { h, controller } = live();
    h.channels[0].port1.deliver({
      t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 24, y: 80, w: 200, h: 40 },
      modifiers: { shift: false, alt: false, ctrl: false, meta: false }, double: false,
    });
    expect(controller.selection).toEqual({ pageId: 'p1', mids: ['aaaaaaaaaa'] });
    const box = h.overlay.children[0];
    expect(box.style.get('left')).toBe('24px');
    expect(box.style.get('top')).toBe('80px');
    expect(box.style.get('width')).toBe('200px');
    expect(h.selections[h.selections.length - 1].mids).toEqual(['aaaaaaaaaa']);
  });

  it('offsets the box by the artboard position, not just the frame rect', () => {
    const { h, controller } = live();
    h.channels[1].port1.deliver({
      t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 10, y: 10, w: 50, h: 50 },
      modifiers: {}, double: false,
    });
    expect(controller.selection.pageId).toBe('p2');
    expect(h.overlay.children[0].style.get('left')).toBe(`${1600 + 10}px`);
  });

  it('shift-click multi-selects and pushes the set down the frame port', () => {
    const { h, controller } = live();
    const port = h.channels[0].port1;
    port.deliver({ t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 10, h: 10 }, modifiers: {}, double: false });
    port.deliver({ t: 'hit', mid: 'bbbbbbbbbb', rect: { x: 0, y: 20, w: 10, h: 10 }, modifiers: { shift: true }, double: false });
    expect(controller.selection.mids).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
    const last = port.posted.filter(m => (m as { t: string }).t === 'select').pop();
    expect((last as { mids: string[] }).mids).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
    expect(h.overlay.findAll(e => !e.hidden && e.className.includes('sel-box'))).toHaveLength(2);
    // The anchor is the most recent hit.
    expect(h.overlay.children[1].className).toContain('primary');
  });

  it('clears the previous artboard selection when the hit lands on another', () => {
    const { h, controller } = live();
    h.channels[0].port1.deliver({ t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: {}, double: false });
    h.channels[1].port1.deliver({ t: 'hit', mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: { shift: true }, double: false });
    expect(controller.selection).toEqual({ pageId: 'p2', mids: ['bbbbbbbbbb'] });
    const cleared = h.channels[0].port1.posted.filter(m => (m as { t: string }).t === 'select').pop();
    expect((cleared as { mids: string[] }).mids).toEqual([]);
  });

  it('re-measures for the parent overlay when a frame remounts', () => {
    const { h, controller } = live();
    h.channels[0].port1.deliver({ t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: {}, double: false });
    // Push it out of view and back: the fresh port must be told the selection.
    h.observer()!.emit([{ target: h.world.children[0], isIntersecting: false }]);
    controller.setView({ ...initialViewState(), zoom: 0.1 });     // force a real unmount
    controller.setView(initialViewState());
    h.observer()!.emit([{ target: h.world.children[0], isIntersecting: true }]);
    for (const frame of h.doc.created.filter(e => e.tag === 'iframe')) { frame.fire('load'); }
    const port = h.channels[h.channels.length - 1].port1;
    expect(port.posted.some(m => (m as { t: string }).t === 'select')).toBe(true);
  });

  it('a double-click hit opens inline text editing', () => {
    const { h } = live();
    h.channels[0].port1.deliver({
      t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: {}, double: true,
    });
    expect(h.edits).toEqual([{ pageId: 'p1', mid: 'aaaaaaaaaa' }]);
  });

  it('refuses a forged mid from a hostile frame before it reaches selection', () => {
    const { h, controller } = live();
    h.channels[0].port1.deliver({ t: 'hit', mid: '<script>', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: {} });
    h.channels[0].port1.deliver({ t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: NaN, w: 1, h: 1 }, modifiers: {} });
    expect(controller.selection).toEqual({ pageId: null, mids: [] });
  });
});

describe('click-to-select over a STATIC preview', () => {
  it('selects a preview element and remembers its geometry in page space', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    const artboard = stub({ 'data-page-id': 'p1' });
    const node = stub({ 'data-mid': 'bbbbbbbbbb' }, artboard, { left: 220 + 30, top: 44 + 40, width: 120, height: 24 });
    h.viewport.fire('click', { target: node });

    expect(controller.selection).toEqual({ pageId: 'p1', mids: ['bbbbbbbbbb'] });
    expect(h.focused).toEqual(['p1']);
    // Stored in PAGE coordinates, so it survives a later pan/zoom untouched.
    expect(controller.rectsFor('p1').get('bbbbbbbbbb')).toEqual({ x: 30, y: 40, w: 120, h: 24 });
    expect(h.overlay.children[0].style.get('left')).toBe('30px');
  });

  it('follows a zoom without re-measuring anything', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    const artboard = stub({ 'data-page-id': 'p1' });
    h.viewport.fire('click', {
      target: stub({ 'data-mid': 'bbbbbbbbbb' }, artboard, { left: 220 + 30, top: 44 + 40, width: 100, height: 20 }),
    });
    controller.setZoom(2);
    const { zoom, pan } = controller.transform;
    expect(h.overlay.children[0].style.get('left')).toBe(`${Math.round(30 * zoom + pan.x)}px`);
    expect(h.overlay.children[0].style.get('width')).toBe(`${Math.round(100 * zoom)}px`);
  });

  it('shift-clicks accumulate across preview tiles of the same artboard', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    const artboard = stub({ 'data-page-id': 'p1' });
    h.viewport.fire('click', { target: stub({ 'data-mid': 'aaaaaaaaaa' }, artboard) });
    h.viewport.fire('click', { target: stub({ 'data-mid': 'bbbbbbbbbb' }, artboard), shiftKey: true });
    expect(controller.selection.mids).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
  });

  it('clicking artboard chrome focuses it and clears the element selection', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    const artboard = stub({ 'data-page-id': 'p1' });
    h.viewport.fire('click', { target: stub({ 'data-mid': 'aaaaaaaaaa' }, artboard) });
    h.viewport.fire('click', { target: artboard });
    expect(controller.selection).toEqual({ pageId: null, mids: [] });
    expect(h.focused).toEqual(['p1', 'p1']);
  });

  it('clicking empty board space clears the selection', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    const artboard = stub({ 'data-page-id': 'p1' });
    h.viewport.fire('click', { target: stub({ 'data-mid': 'aaaaaaaaaa' }, artboard) });
    h.viewport.fire('click', { target: stub({}) });
    expect(controller.selection).toEqual({ pageId: null, mids: [] });
  });

  it('survives an event whose target is not a DOM node at all', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    for (const target of [null, undefined, 42, 'div', {}]) {
      expect(() => h.viewport.fire('click', { target })).not.toThrow();
    }
    expect(controller.selection.mids).toEqual([]);
  });
});

describe('marquee', () => {
  function withRects() {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]));
    h.channels[0].port1.deliver({
      t: 'rects',
      rects: {
        root000000: { x: 0, y: 0, w: 1440, h: 1024 },
        aaaaaaaaaa: { x: 10, y: 10, w: 100, h: 40 },
        bbbbbbbbbb: { x: 10, y: 60, w: 100, h: 40 },
        cccccccccc: { x: 10, y: 400, w: 100, h: 40 },
      },
    });
    return { h, controller };
  }

  it('selects every element the box fully contains, and never the artboard root', () => {
    const { h, controller } = withRects();
    h.viewport.fire('pointerdown', { button: 0, ...at(0, 0) });
    h.fire('pointermove', at(200, 150));
    h.fire('pointerup', at(200, 150));
    expect(controller.selection).toEqual({ pageId: 'p1', mids: ['aaaaaaaaaa', 'bbbbbbbbbb'] });
  });

  it('lets the drag cross live iframes by making the world inert, then restores it', () => {
    const { h } = withRects();
    h.viewport.fire('pointerdown', { button: 0, ...at(0, 0) });
    expect(h.world.style.get('pointer-events')).toBeUndefined();   // a click is still a click
    h.fire('pointermove', at(200, 150));
    expect(h.world.style.get('pointer-events')).toBe('none');
    expect(h.overlay.findAll(e => e.className.includes('sel-marquee'))).toHaveLength(1);
    h.fire('pointerup', at(200, 150));
    expect(h.world.style.get('pointer-events')).toBeUndefined();
    expect(h.overlay.find(e => e.className.includes('sel-marquee'))!.hidden).toBe(true);
  });

  it('a wobble under the threshold stays a click and does not clear the selection', () => {
    const { h, controller } = withRects();
    h.channels[0].port1.deliver({ t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 10, y: 10, w: 100, h: 40 }, modifiers: {} });
    h.viewport.fire('pointerdown', { button: 0, ...at(50, 50) });
    h.fire('pointermove', at(51, 51));
    h.fire('pointerup', at(51, 51));
    expect(controller.selection.mids).toEqual(['aaaaaaaaaa']);
  });

  it('an empty marquee clears, and shift-marquee adds to what is selected', () => {
    const { h, controller } = withRects();
    h.viewport.fire('pointerdown', { button: 0, ...at(0, 0) });
    h.fire('pointermove', at(200, 150));
    h.fire('pointerup', at(200, 150));
    h.viewport.fire('pointerdown', { button: 0, shiftKey: true, ...at(0, 380) });
    h.fire('pointermove', at(200, 460));
    h.fire('pointerup', at(200, 460));
    expect(controller.selection.mids).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);

    h.viewport.fire('pointerdown', { button: 0, ...at(600, 600) });
    h.fire('pointermove', at(700, 700));
    h.fire('pointerup', at(700, 700));
    expect(controller.selection.mids).toEqual([]);
  });

  it('a cancelled pointer leaves no marquee behind', () => {
    const { h } = withRects();
    h.viewport.fire('pointerdown', { button: 0, ...at(0, 0) });
    h.fire('pointermove', at(200, 150));
    h.fire('pointercancel');
    expect(h.world.style.get('pointer-events')).toBeUndefined();
  });
});

describe('keyboard', () => {
  function selected() {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    goLive(h, controller, art);
    h.channels[0].port1.deliver({ t: 'hit', mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 10, h: 10 }, modifiers: {} });
    return { h, controller, art };
  }

  it('Escape clears the selection', () => {
    const { h, controller } = selected();
    h.fire('keydown', { key: 'Escape' });
    expect(controller.selection.mids).toEqual([]);
  });

  it('Tab and Shift-Tab walk the siblings WHEN THE BOARD HAS FOCUS', () => {
    const { h, controller } = selected();
    // `target` is load-bearing: the board only claims Tab while focus is inside
    // the viewport. This test used to fire Tab with no target at all, which is
    // why it stayed green while the board was swallowing Tab globally.
    const viewport = h.doc.getElementById('board-scroll');
    h.fire('keydown', { key: 'Tab', target: viewport });
    expect(controller.selection.mids).toEqual(['cccccccccc']);
    h.fire('keydown', { key: 'Tab', shiftKey: true, target: viewport });
    expect(controller.selection.mids).toEqual(['bbbbbbbbbb']);
  });

  it('does NOT swallow Tab when focus is on a toolbar control (WCAG 2.1.2)', () => {
    // The keyboard-trap regression. A BUTTON is not a text-entry target, so the
    // old guard let it through and ate the key — a keyboard user could never
    // reach Undo, Present, the pane toggles, the review queue, or the Stop
    // button that cancels a running agent job, and could never Tab back out to
    // VS Code.
    const { h, controller } = selected();
    const button = h.doc.getElementById('btn-export');
    let prevented = false;
    h.fire('keydown', { key: 'Tab', target: button, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(false);
    expect(controller.selection.mids).toEqual(['bbbbbbbbbb']);
  });

  it('does NOT swallow Space on a focused button, so every control still activates', () => {
    // A11Y-2. The pan gesture claimed Space window-wide for any target that was
    // not a text entry, and `preventDefault()` on a Space keydown suppresses
    // the browser's native activation of a focused <button> — so Stop, Undo,
    // Redo, Save version, Export, Present, every zoom button, every
    // Accept/Reject in the review queue and every inspector toggle could only
    // be operated with Enter. Nothing in the UI says so.
    const { h } = selected();
    for (const target of [
      { tagName: 'BUTTON' },
      { tagName: 'A', getAttribute: (n: string) => (n === 'href' ? '#x' : null) },
      { tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'button' : null) },
      { tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'option' : null) },
    ]) {
      let prevented = false;
      h.fire('keydown', { key: ' ', target, preventDefault: () => { prevented = true; } });
      expect(prevented, `Space on ${JSON.stringify(target)}`).toBe(false);
    }
  });

  it('still claims Space for the pan gesture everywhere else', () => {
    // The other half: a fix that simply stopped claiming Space would take the
    // space-drag pan away from the mouse user who never focused anything.
    const { h } = selected();
    let prevented = false;
    h.fire('keydown', { key: ' ', target: h.doc.getElementById('board-scroll'), preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });

  it('cycles within the artboard, and Escape is the documented way out', () => {
    // Tab CYCLES between the artboard's elements by design — so without an exit
    // a keyboard user who entered the board could never get back to the
    // toolbar. `role="application"` widgets conventionally leave on Escape.
    const { h, controller } = selected();
    const viewport = h.doc.getElementById('board-scroll') as unknown as { blur?: () => void; blurred?: boolean };
    let blurred = false;
    viewport.blur = () => { blurred = true; };

    for (let i = 0; i < 12; i++) { h.fire('keydown', { key: 'Tab', target: viewport }); }
    expect(controller.selection.mids.length).toBe(1);   // still walking, never stuck

    h.fire('keydown', { key: 'Escape', target: viewport });   // 1st: clear selection
    expect(controller.selection.mids).toEqual([]);
    expect(blurred).toBe(false);

    h.fire('keydown', { key: 'Escape', target: viewport });   // 2nd: leave the widget
    expect(blurred).toBe(true);
  });

  it('arrow keys emit el.setStyle ops and never mutate the artifact locally', () => {
    const { h, controller, art } = selected();
    const before = JSON.stringify(art);
    h.fire('keydown', { key: 'ArrowRight' });
    expect(h.ops).toHaveLength(1);
    expect(h.ops[0]).toEqual([{
      op: 'el.setStyle', pageId: 'p1', mid: 'bbbbbbbbbb',
      style: { transform: 'translate(1px, 0px)' },
    }]);
    h.fire('keydown', { key: 'ArrowDown', shiftKey: true });
    expect(h.ops[1][0]).toMatchObject({ style: { transform: 'translate(0px, 10px)' } });
    expect(JSON.stringify(art)).toBe(before);
    expect(controller.selection.mids).toEqual(['bbbbbbbbbb']);
  });

  it('keeps its hands off a text field the human is typing in', () => {
    const { h, controller } = selected();
    h.fire('keydown', { key: 'ArrowRight', target: { tagName: 'INPUT' } });
    h.fire('keydown', { key: 'Escape', target: { isContentEditable: true } });
    expect(h.ops).toHaveLength(0);
    expect(controller.selection.mids).toEqual(['bbbbbbbbbb']);
  });

  it('leaves Cmd+Z to the undo stack and takes only the zoom accelerators', () => {
    const { h, controller } = selected();
    h.fire('keydown', { key: 'z', metaKey: true });
    expect(controller.transform.zoom).toBe(1);
    h.fire('keydown', { key: '=', metaKey: true });
    expect(controller.transform.zoom).toBe(1.5);
    h.fire('keydown', { key: '-', ctrlKey: true });
    expect(controller.transform.zoom).toBe(1);
  });

  it('does nothing with arrows when nothing is selected', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    h.fire('keydown', { key: 'ArrowRight' });
    expect(h.ops).toHaveLength(0);
    expect(controller.selection.mids).toEqual([]);
  });
});

describe('an agent edit cannot steal the view (§3.5 / §4 row 9)', () => {
  function selectedAndPanned() {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1'), page('p2', 1600)]);
    goLive(h, controller, art);
    h.channels[0].port1.deliver({ t: 'hit', mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 10, h: 10 }, modifiers: {} });
    h.viewport.fire('wheel', { deltaX: 100, deltaY: 50 });
    return { h, controller, art };
  }

  it('leaves selection, pan and zoom untouched when ops arrive', () => {
    const { h, controller, art } = selectedAndPanned();
    const transform = controller.transform;
    const selection = controller.selection;
    const changes = h.selections.length;

    art.pages[0].doc.children![0].text = 'edited';
    controller.applyPlan(planRender([v2({ op: 'el.setText', pageId: 'p1', mid: 'aaaaaaaaaa', text: 'edited' })]));

    expect(controller.transform).toEqual(transform);
    expect(controller.selection).toEqual(selection);
    expect(h.selections).toHaveLength(changes);
    expect(h.views.length).toBeGreaterThan(0);       // only the human's own pan
  });

  it('does not jump to (or select) a newly added artboard', () => {
    const { h, controller, art } = selectedAndPanned();
    const transform = controller.transform;
    art.pages.push(page('p3', 3200));
    controller.applyPlan(planRender([v2({ op: 'page.add', page: { doc: art.pages[2].doc } })]));
    expect(controller.boardIds()).toEqual(['p1', 'p2', 'p3']);
    expect(controller.selection.pageId).toBe('p1');
    expect(controller.transform).toEqual(transform);
    expect(h.focused).toEqual([]);
  });

  it('prunes a selection whose node the agent deleted, and nothing more', () => {
    const { h, controller, art } = selectedAndPanned();
    h.channels[0].port1.deliver({ t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: { shift: true } });
    expect(controller.selection.mids).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa']);
    art.pages[0].doc.children = art.pages[0].doc.children!.filter(n => n.mid !== 'bbbbbbbbbb');
    controller.applyPlan(planRender([v2({ op: 'el.remove', pageId: 'p1', mid: 'bbbbbbbbbb' })]));
    expect(controller.selection).toEqual({ pageId: 'p1', mids: ['aaaaaaaaaa'] });
  });

  it('ignores a stale view echo from the app, but honours a deliberate change', () => {
    const h = makeHarness();
    const controller = board(h);
    const view = initialViewState();
    controller.setArtifact(artifact([page('p1')]), view);
    h.viewport.fire('wheel', { deltaX: 100, deltaY: 0 });
    expect(controller.transform.pan.x).toBe(-100);
    // The app hands its own copy back on an unrelated interaction (a device
    // switch, a rail click, a resync). It has NOT adopted the pan, so honouring
    // it verbatim would snap the viewport back under the human's hand.
    controller.setView({ ...view, focusedPageId: 'p1' });
    expect(controller.transform.pan.x).toBe(-100);
    // A deliberate change from the app still wins, and leaves pan alone.
    controller.setView({ ...view, zoom: 0.5 });
    expect(controller.transform.zoom).toBe(0.5);
    expect(controller.transform.pan.x).toBe(-100);
  });

  it('clears the selection when the whole artboard is removed', () => {
    const { controller, art } = selectedAndPanned();
    art.pages = art.pages.filter(p => p.id !== 'p1');
    controller.applyPlan(planRender([v2({ op: 'page.remove', pageId: 'p1' })]));
    expect(controller.selection).toEqual({ pageId: null, mids: [] });
    expect(controller.rectsFor('p1').size).toBe(0);
  });
});

describe('lifecycle', () => {
  it('goes inert after dispose instead of throwing on late events', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]));
    controller.dispose();
    expect(() => {
      h.viewport.fire('wheel', { deltaY: 10 });
      h.viewport.fire('pointerdown', { button: 0, ...at(0, 0) });
      h.fire('pointermove', at(50, 50));
      h.fire('keydown', { key: 'ArrowRight' });
      h.viewport.fire('click', { target: stub({ 'data-page-id': 'p1' }) });
    }).not.toThrow();
    expect(h.overlay.children.every(c => c.hidden)).toBe(true);
  });

  it('fits the whole design on the first artifact when asked to', () => {
    const h = makeHarness();
    const controller = new BoardController({
      env: h.env,
      world: h.world as unknown as DomElement,
      measureViewport: () => ({ width: 800, height: 600 }),
    });
    controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    const first = controller.transform.zoom;
    expect(first).toBeLessThan(1);
    // ...and only once: a later resync must not yank the human's zoom back.
    controller.setZoom(2);
    controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), { ...initialViewState(), zoom: 2 });
    expect(controller.transform.zoom).toBe(2);
  });
});
