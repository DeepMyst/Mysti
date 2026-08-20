/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — the canvas panel reacts to its own size.
 *
 * Before this, `board.ts` contained no `ResizeObserver` and no `matchMedia`,
 * and the shell it replaced did `window.addEventListener('resize', renderBoard)`
 * — which rebuilt every iframe from scratch, re-inlining 3,144,476 bytes of
 * runtime per artboard and killing scroll, focus, hover and animation on every
 * drag of the editor separator. The panel's own layout was
 * `grid-template-columns: 220px 1fr 280px` with no `@media` and no `minmax()`,
 * so 500px of chrome came off the top of a panel that is routinely dragged to
 * 400.
 *
 * Three claims are tested here, and all three are falsifiable:
 *
 * 1. A resize costs ZERO frame builds. (`buildCount` is the regression guard.)
 * 2. The viewport does not jump: while the board is still auto-fitting it
 *    re-frames the design, and once the human has zoomed it keeps the world
 *    point under the centre exactly where it was.
 * 3. The width→mode decision is pure, tabulated, and sticky enough that a drag
 *    parked on a breakpoint cannot make the layout flap.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  BoardController, DEFAULT_LIVE_ZOOM, type BoardLayout, type ResizeEntryLike,
  type ResizeObserverLike,
} from '../../src/webview/canvas/board';
import {
  INSPECTOR_COLLAPSED_CLASS,
  LAYOUT_HYSTERESIS_PX,
  LAYOUT_MEDIUM_MIN_PX,
  LAYOUT_WIDE_MIN_PX,
  MIN_LEGIBLE_ZOOM,
  MIN_ZOOM,
  RAIL_COLLAPSED_CLASS,
  carryOverride,
  decideLayoutMode,
  defaultPanes,
  paneIsDocked,
  fitMinZoom,
  layoutClasses,
  preserveCenter,
  resolvePanes,
  screenToWorld,
  stepIndex,
  type BoardTransform,
  type LayoutMode,
} from '../../src/webview/canvas/boardMath';
import { CanvasApp } from '../../src/webview/canvas/app';
import type { CanvasBoot } from '../../src/webview/canvas/boot';
import { initialViewState, type CanvasViewState } from '../../src/webview/canvas/state';
import type {
  CanvasEnv, DomDocument, DomElement, MessageChannelLike,
} from '../../src/webview/canvas/dom';
import type { CanvasHostMessage, WireArtifact } from '../../src/canvas/protocol';
import type { ArtifactPage, DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import {
  FakeChannel, FakeDocument, FakeElement, FakeIntersectionObserver,
} from './canvasFakeDom';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP = getFormat('desktop')!;
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

function page(id: string, x = 0): ArtifactPage {
  return {
    id, version: 1, boardPos: { x, y: 0 }, actionTitle: id,
    doc: { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: id }] },
  };
}

function artifact(pages: ArtifactPage[]): WireArtifact {
  return {
    id: 'art1', version: 1, kind: 'screens', name: 'Acme', format: DESKTOP,
    theme: THEME, pages, assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

/* ══════════════════════ 1. the pure decisions ══════════════════════ */

describe('decideLayoutMode: a table of widths, not a guess', () => {
  it('classifies exactly when there is no previous mode to be sticky about', () => {
    const rows: Array<[number, LayoutMode]> = [
      [0, 'narrow'],
      [320, 'narrow'],
      [639, 'narrow'],
      [LAYOUT_MEDIUM_MIN_PX - 1, 'narrow'],
      [LAYOUT_MEDIUM_MIN_PX, 'medium'],
      [800, 'medium'],
      [LAYOUT_WIDE_MIN_PX - 1, 'medium'],
      [LAYOUT_WIDE_MIN_PX, 'wide'],
      [2400, 'wide'],
    ];
    for (const [width, mode] of rows) {
      expect(decideLayoutMode(width, null), `width ${width}`).toBe(mode);
    }
  });

  it('treats a non-finite or negative width as the smallest layout', () => {
    expect(decideLayoutMode(Number.NaN, null)).toBe('narrow');
    expect(decideLayoutMode(Number.POSITIVE_INFINITY, null)).toBe('narrow');
    expect(decideLayoutMode(-4000, null)).toBe('narrow');
    expect(decideLayoutMode(undefined, null)).toBe('narrow');
  });

  it('classifies the SAME way whatever mode it is coming from (CANVAS-W2)', () => {
    // The shipped decision must not carry a dead band, because the stylesheet's
    // ladder has none. 48px of JS hysteresis put the wide↔medium flip at 984
    // going up and 936 coming down while `@container canvas-shell` flipped at
    // 960 — and inside those bands `paneIsDocked` named the WRONG switch of the
    // pair, so `[`, `]`, `\` and Escape wrote a checkbox the stylesheet ignores
    // and the panes stopped answering the keyboard entirely.
    const cssMode = (w: number): LayoutMode =>
      w >= LAYOUT_WIDE_MIN_PX ? 'wide' : w >= LAYOUT_MEDIUM_MIN_PX ? 'medium' : 'narrow';
    const previous: Array<LayoutMode | null> = [null, 'narrow', 'medium', 'wide'];
    for (const w of [0, 320, 639, 640, 641, 700, 900, 935, 936, 937, 950,
      959, 960, 961, 970, 983, 984, 1000, 1200, 2000]) {
      for (const prev of previous) {
        expect(decideLayoutMode(w, prev), `width ${w} arriving from ${prev}`).toBe(cssMode(w));
      }
    }
    expect(LAYOUT_HYSTERESIS_PX, 'the shipped dead band must be zero').toBe(0);
  });

  it('can still be given a dead band explicitly, for a caller that owns both authorities', () => {
    // The algorithm is intact and tested; it is the DEFAULT that must be 0 for
    // as long as the CSS ladder is the other authority.
    const half = 24;
    expect(decideLayoutMode(LAYOUT_MEDIUM_MIN_PX + half - 1, 'narrow', 48)).toBe('narrow');
    expect(decideLayoutMode(LAYOUT_MEDIUM_MIN_PX + half, 'narrow', 48)).toBe('medium');
    expect(decideLayoutMode(LAYOUT_MEDIUM_MIN_PX - 1, 'medium', 48)).toBe('medium');
    expect(decideLayoutMode(LAYOUT_MEDIUM_MIN_PX - half - 1, 'medium', 48)).toBe('narrow');
    expect(decideLayoutMode(LAYOUT_WIDE_MIN_PX + half, 'medium', 48)).toBe('wide');
    expect(decideLayoutMode(LAYOUT_WIDE_MIN_PX - half - 1, 'wide', 48)).toBe('medium');
  });

  it('agrees with the container-query ladder in canvas.css §5', () => {
    // The stylesheet collapses the inspector at `max-width: 959.98px` and the
    // rail at `max-width: 639.98px`. If these ever diverge, a toggle reports a
    // pane open that the stylesheet has docked shut.
    expect(LAYOUT_WIDE_MIN_PX).toBe(960);
    expect(LAYOUT_MEDIUM_MIN_PX).toBe(640);
    expect(decideLayoutMode(959.98, null)).toBe('medium');
    expect(decideLayoutMode(960, null)).toBe('wide');
    expect(decideLayoutMode(639.98, null)).toBe('narrow');
    expect(decideLayoutMode(640, null)).toBe('medium');
  });

  it('can skip a rank when the panel jumps (a maximise, not a drag)', () => {
    expect(decideLayoutMode(2000, 'narrow')).toBe('wide');
    expect(decideLayoutMode(200, 'wide')).toBe('narrow');
  });
});

describe('pane visibility: chrome earns its space', () => {
  it('drops the inspector first and the rail second', () => {
    expect(defaultPanes('wide')).toEqual({ rail: true, inspector: true });
    expect(defaultPanes('medium')).toEqual({ rail: true, inspector: false });
    expect(defaultPanes('narrow')).toEqual({ rail: false, inspector: false });
  });

  it('lets a human override one pane without disturbing the other', () => {
    expect(resolvePanes('medium', { inspector: true })).toEqual({ rail: true, inspector: true });
    expect(resolvePanes('wide', { rail: false })).toEqual({ rail: false, inspector: true });
    expect(resolvePanes('narrow', null)).toEqual({ rail: false, inspector: false });
    expect(resolvePanes('narrow', {})).toEqual({ rail: false, inspector: false });
  });

  it('knows which pane is a docked column and which is a modal overlay', () => {
    // The shell drives a docked pane from its `…-hidden` switch and an overlay
    // from its `…-shown` one; picking the wrong one is a silent no-op.
    expect(paneIsDocked('wide', 'rail')).toBe(true);
    expect(paneIsDocked('medium', 'rail')).toBe(true);
    expect(paneIsDocked('narrow', 'rail')).toBe(false);
    expect(paneIsDocked('wide', 'inspector')).toBe(true);
    expect(paneIsDocked('medium', 'inspector')).toBe(false);
    expect(paneIsDocked('narrow', 'inspector')).toBe(false);
  });

  it('carries a human override only across a mode change that did not move that pane', () => {
    // wide → medium moves the INSPECTOR; "I hid the rail" is still live — and
    // so is "I hid the inspector" (see the round-trip test below).
    expect(carryOverride('wide', 'medium', { rail: false, inspector: false }))
      .toEqual({ rail: false, inspector: false });
    // medium → narrow moves the RAIL; "I opened the inspector" is still live.
    expect(carryOverride('medium', 'narrow', { rail: true, inspector: true }))
      .toEqual({ inspector: true });
    // wide → narrow moves both, so neither "open" survives — but the close does.
    expect(carryOverride('wide', 'narrow', { rail: false, inspector: true }))
      .toEqual({ rail: false });
    expect(carryOverride('wide', 'narrow', { rail: true, inspector: true })).toBeNull();
    expect(carryOverride('wide', 'wide', { rail: false })).toEqual({ rail: false });
    expect(carryOverride('wide', 'narrow', null)).toBeNull();
  });

  it('keeps an explicit CLOSE across a breakpoint round-trip (R2)', () => {
    // At 1200px the human closes the Inspector for more board. They drag the
    // editor splitter to ~900px and back. Dropping the close on the way down
    // left nothing to restore on the way up, so the Inspector re-opened by
    // itself and took 264px of board with it — with no user action and no
    // visible cause. The stale-OPEN hazard the rule exists for (an overlay
    // covering the board at a narrower width) is one-directional; a close
    // cannot cover anything.
    const closed: PaneOverride = { inspector: false };
    const atMedium = carryOverride('wide', 'medium', closed);
    expect(resolvePanes('medium', atMedium).inspector).toBe(false);
    const backAtWide = carryOverride('medium', 'wide', atMedium);
    expect(resolvePanes('wide', backAtWide).inspector).toBe(false);
    // The rail survives the same round trip through narrow.
    const railClosed = carryOverride('narrow', 'medium', carryOverride('medium', 'narrow', { rail: false }));
    expect(resolvePanes('medium', railClosed).rail).toBe(false);
  });

  it('still drops a stale OPEN when that pane becomes an overlay', () => {
    // The hazard the rule was written for: an override that says "open" at a
    // width where the pane is a modal overlay would boot the panel with the
    // board covered.
    expect(carryOverride('wide', 'medium', { inspector: true })).toBeNull();
    expect(carryOverride('medium', 'narrow', { rail: true })).toBeNull();
  });

  it('emits exactly the classes the stylesheet contracts for', () => {
    expect(layoutClasses('wide', { rail: true, inspector: true })).toEqual(['layout-wide']);
    expect(layoutClasses('medium', { rail: true, inspector: false }))
      .toEqual(['layout-medium', INSPECTOR_COLLAPSED_CLASS]);
    expect(layoutClasses('narrow', { rail: false, inspector: false }))
      .toEqual(['layout-narrow', RAIL_COLLAPSED_CLASS, INSPECTOR_COLLAPSED_CLASS]);
  });
});

describe('preserveCenter: the viewport does not jump', () => {
  const t: BoardTransform = { zoom: 0.5, pan: { x: 120, y: -40 } };

  it('keeps the world point under the centre under the centre', () => {
    const before = { width: 1000, height: 800 };
    const after = { width: 500, height: 900 };
    const wasCentred = screenToWorld({ x: before.width / 2, y: before.height / 2 }, t);
    const next = preserveCenter(t, before, after);
    const nowCentred = screenToWorld({ x: after.width / 2, y: after.height / 2 }, next);
    expect(nowCentred.x).toBeCloseTo(wasCentred.x, 9);
    expect(nowCentred.y).toBeCloseTo(wasCentred.y, 9);
    expect(next.zoom).toBe(t.zoom);
  });

  it('returns the transform untouched for a collapsed or unmeasured viewport', () => {
    expect(preserveCenter(t, { width: 0, height: 800 }, { width: 500, height: 500 })).toEqual(t);
    expect(preserveCenter(t, { width: 500, height: 500 }, { width: 0, height: 0 })).toEqual(t);
  });

  it('never returns a non-finite transform', () => {
    const bad = preserveCenter(
      { zoom: Number.NaN, pan: { x: Number.NaN, y: 3 } },
      { width: Number.NaN, height: 10 },
      { width: 400, height: 400 },
    );
    expect(Number.isFinite(bad.zoom)).toBe(true);
    expect(Number.isFinite(bad.pan.x)).toBe(true);
    expect(Number.isFinite(bad.pan.y)).toBe(true);
  });
});

describe('fitMinZoom + stepIndex', () => {
  it('floors a single-artboard fit at a legible zoom and lets a design fit whole', () => {
    expect(fitMinZoom(1)).toBe(MIN_LEGIBLE_ZOOM);
    expect(fitMinZoom(0)).toBe(MIN_LEGIBLE_ZOOM);
    expect(fitMinZoom(2)).toBe(MIN_ZOOM);
    expect(fitMinZoom(20)).toBe(MIN_ZOOM);
  });

  it('wraps, and enters from either end when nothing is focused', () => {
    expect(stepIndex(3, 0, 1)).toBe(1);
    expect(stepIndex(3, 2, 1)).toBe(0);
    expect(stepIndex(3, 0, -1)).toBe(2);
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, -1, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
    expect(stepIndex(3, 99, 1)).toBe(0);
    expect(stepIndex(Number.NaN, Number.NaN, Number.NaN)).toBe(-1);
  });
});

/* ══════════════════════ 2. the board actually resizing ══════════════════════ */

class FakeResizeObserver implements ResizeObserverLike {
  readonly observed: DomElement[] = [];
  disconnected = false;
  constructor(readonly callback: (entries: readonly ResizeEntryLike[]) => void) {}
  observe(target: DomElement): void { this.observed.push(target); }
  unobserve(target: DomElement): void {
    const i = this.observed.indexOf(target);
    if (i >= 0) { this.observed.splice(i, 1); }
  }
  disconnect(): void { this.disconnected = true; }
  /** Drive it by hand, as the browser would after a layout pass. */
  fire(): void { this.callback(this.observed.map(target => ({ target }))); }
}

interface BoardRig {
  controller: BoardController;
  doc: FakeDocument;
  world: FakeElement;
  observer(): FakeIntersectionObserver | null;
  resizer(): FakeResizeObserver | null;
  resizerCount: () => number;
  scheduledCount: () => number;
  layouts: BoardLayout[];
  focused: string[];
  fireKey(ev: Record<string, unknown>): void;
  /** Run every rAF callback the board queued. */
  flush(): void;
  viewport: { width: number; height: number };
  panelWidth: { value: number };
  viewportHost: FakeElement;
  layoutHost: FakeElement;
}

function boardRig(opts: {
  viewport?: { width: number; height: number };
  panelWidth?: number;
} = {}): BoardRig {
  const doc = new FakeDocument();
  const world = new FakeElement('div');
  const viewportHost = new FakeElement('div');
  const layoutHost = new FakeElement('div');
  const viewport = { ...(opts.viewport ?? { width: 1600, height: 1000 }) };
  const panelWidth = { value: opts.panelWidth ?? 1600 };
  const windowListeners = new Map<string, Array<(ev: unknown) => void>>();
  const frames: Array<() => void> = [];
  let scheduled = 0;
  const layouts: BoardLayout[] = [];
  const focused: string[] = [];
  let intersection: FakeIntersectionObserver | null = null;
  let resizer: FakeResizeObserver | null = null;
  let resizerCount = 0;

  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: {
      addEventListener: (type, listener) => {
        const list = windowListeners.get(type);
        if (list) { list.push(listener); } else { windowListeners.set(type, [listener]); }
      },
    },
    createIntersectionObserver: cb => {
      intersection = new FakeIntersectionObserver(
        cb as unknown as (e: readonly { target: unknown; isIntersecting: boolean }[]) => void,
      );
      return intersection as unknown as ReturnType<NonNullable<CanvasEnv['createIntersectionObserver']>>;
    },
    createMessageChannel: () => new FakeChannel() as unknown as MessageChannelLike,
    fetchText: async () => '',
    now: () => 0,
    warn: () => { /* silent */ },
  };

  const controller = new BoardController({
    env,
    world: world as unknown as DomElement,
    viewportHost: viewportHost as unknown as DomElement,
    layoutHost: layoutHost as unknown as DomElement,
    liveZoomThreshold: DEFAULT_LIVE_ZOOM,
    measureViewport: () => ({ width: viewport.width, height: viewport.height }),
    measureLayoutWidth: () => panelWidth.value,
    createResizeObserver: cb => {
      resizerCount++;
      resizer = new FakeResizeObserver(cb);
      return resizer;
    },
    scheduleFrame: cb => { scheduled++; frames.push(cb); },
    callbacks: {
      onLayoutChange: layout => { layouts.push(layout); },
      onFocusPage: pageId => { focused.push(pageId); },
    },
  });

  return {
    controller, doc, world, layouts, focused, viewport, panelWidth, viewportHost, layoutHost,
    observer: () => intersection,
    resizer: () => resizer,
    resizerCount: () => resizerCount,
    scheduledCount: () => scheduled,
    fireKey: ev => { for (const l of windowListeners.get('keydown') ?? []) { l(ev); } },
    flush: () => {
      // Drain, because a flush can schedule the next one (a pane toggle does).
      for (let guard = 0; guard < 8 && frames.length > 0; guard++) {
        const queued = frames.splice(0, frames.length);
        for (const cb of queued) { cb(); }
      }
    },
  };
}

function goLive(rig: BoardRig, art: WireArtifact, view: CanvasViewState = initialViewState()): void {
  rig.controller.setArtifact(art, view);
  rig.controller.setRuntime({ scripts: ['/* react */'], harness: '/* harness */' });
  rig.observer()?.emit(rig.world.children.map(target => ({ target, isIntersecting: true })));
  for (const frame of rig.doc.created.filter(e => e.tag === 'iframe')) { frame.fire('load'); }
}

describe('one ResizeObserver, two hosts, zero frame rebuilds', () => {
  it('observes the board AND the panel root with a single observer', () => {
    const rig = boardRig();
    expect(rig.resizerCount()).toBe(1);
    expect(rig.resizer()!.observed).toEqual([rig.viewportHost, rig.layoutHost]);
  });

  it('disconnects the observer on dispose', () => {
    const rig = boardRig();
    rig.controller.dispose();
    expect(rig.resizer()!.disconnected).toBe(true);
  });

  it('coalesces a storm of resize records into ONE scheduled frame', () => {
    const rig = boardRig();
    const base = rig.scheduledCount();
    // A separator drag fires a record per observed element per layout pass.
    for (let i = 0; i < 25; i++) { rig.resizer()!.fire(); }
    expect(rig.scheduledCount() - base).toBe(1);
    rig.flush();
    // …and the flag resets, so the NEXT storm gets its own single frame.
    for (let i = 0; i < 10; i++) { rig.resizer()!.fire(); }
    expect(rig.scheduledCount() - base).toBe(2);
  });

  it('refits on resize without building a single new frame', () => {
    const rig = boardRig();
    goLive(rig, artifact([page('p1'), page('p2', 1600)]));
    const builds = rig.controller.buildCount;
    const live = rig.controller.liveCount;
    expect(builds).toBeGreaterThan(0);

    rig.viewport.width = 1400;
    rig.viewport.height = 900;
    rig.resizer()!.fire();
    rig.flush();

    // THE regression guard: `window.addEventListener('resize', renderBoard)`
    // used to make this number climb by one per artboard per resize.
    expect(rig.controller.buildCount).toBe(builds);
    // And the frames did not merely avoid a REBUILD - they are still live, so
    // scroll, focus, hover and animation inside them survived the drag.
    expect(rig.controller.liveCount).toBe(live);
  });

  it('drops to static previews rather than rebuilding when a resize zooms out past the live threshold', () => {
    const rig = boardRig();
    goLive(rig, artifact([page('p1'), page('p2', 1600)]));
    const builds = rig.controller.buildCount;

    rig.viewport.width = 700;                          // fits ~0.2x: thumbnails
    rig.viewport.height = 500;
    rig.resizer()!.fire();
    rig.flush();

    expect(rig.controller.transform.zoom).toBeLessThan(DEFAULT_LIVE_ZOOM);
    expect(rig.controller.liveCount).toBe(0);
    expect(rig.controller.buildCount).toBe(builds);    // unmounted, not rebuilt
  });

  it('also reacts to a window resize on hosts with no ResizeObserver', () => {
    const doc = new FakeDocument();
    const world = new FakeElement('div');
    const viewport = { width: 1200, height: 900 };
    const windowListeners = new Map<string, Array<(ev: unknown) => void>>();
    const frames: Array<() => void> = [];
    const env: CanvasEnv = {
      doc: doc as unknown as DomDocument,
      self: {
        addEventListener: (type, listener) => {
          const list = windowListeners.get(type);
          if (list) { list.push(listener); } else { windowListeners.set(type, [listener]); }
        },
      },
      createIntersectionObserver: null,
      createMessageChannel: () => new FakeChannel() as unknown as MessageChannelLike,
      fetchText: async () => '',
      now: () => 0,
      warn: () => { /* silent */ },
    };
    const controller = new BoardController({
      env,
      world: world as unknown as DomElement,
      createResizeObserver: null,
      scheduleFrame: cb => { frames.push(cb); },
      measureViewport: () => ({ width: viewport.width, height: viewport.height }),
      measureLayoutWidth: () => 1200,
    });
    controller.setArtifact(artifact([page('p1')]), initialViewState());
    const zoomed = controller.transform.zoom;
    viewport.width = 400;
    for (const l of windowListeners.get('resize') ?? []) { l({}); }
    for (const cb of frames.splice(0, frames.length)) { cb(); }
    expect(controller.transform.zoom).not.toBe(zoomed);
    expect(Number.isFinite(controller.transform.pan.x)).toBe(true);
  });
});

describe('auto-fit until the human takes the wheel', () => {
  it('re-frames the design on every resize while still auto-fitting', () => {
    const rig = boardRig({ viewport: { width: 2000, height: 1400 } });
    rig.controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    expect(rig.controller.autoFitting).toBe(true);
    const wide = rig.controller.transform.zoom;

    rig.viewport.width = 700;
    rig.viewport.height = 500;
    rig.resizer()!.fire();
    rig.flush();

    expect(rig.controller.transform.zoom).toBeLessThan(wide);
    expect(rig.controller.autoFitting).toBe(true);
  });

  it('preserves the world point under the centre once the human has zoomed', () => {
    const rig = boardRig({ viewport: { width: 1600, height: 1000 } });
    rig.controller.setArtifact(artifact([page('p1')]), initialViewState());
    rig.controller.zoomIn();
    expect(rig.controller.autoFitting).toBe(false);
    const zoom = rig.controller.transform.zoom;
    const centredBefore = screenToWorld({ x: 800, y: 500 }, rig.controller.transform);

    rig.viewport.width = 600;
    rig.viewport.height = 1300;
    rig.resizer()!.fire();
    rig.flush();

    expect(rig.controller.transform.zoom).toBe(zoom);            // no re-fit
    const centredAfter = screenToWorld({ x: 300, y: 650 }, rig.controller.transform);
    expect(centredAfter.x).toBeCloseTo(centredBefore.x, 6);
    expect(centredAfter.y).toBeCloseTo(centredBefore.y, 6);
  });

  it('hands control back on zoom-to-fit', () => {
    const rig = boardRig();
    rig.controller.setArtifact(artifact([page('p1')]), initialViewState());
    rig.controller.zoomIn();
    expect(rig.controller.autoFitting).toBe(false);
    rig.controller.zoomToFit();
    expect(rig.controller.autoFitting).toBe(true);
  });

  it('never shrinks a lone artboard below the legible floor', () => {
    const rig = boardRig({ viewport: { width: 220, height: 180 }, panelWidth: 220 });
    rig.controller.setArtifact(artifact([page('p1')]), initialViewState());
    rig.resizer()!.fire();
    rig.flush();
    // 1440px of artboard in a 220px panel fits at ~0.09x — a grey rectangle.
    expect(rig.controller.transform.zoom).toBe(MIN_LEGIBLE_ZOOM);
  });

  it('still fits a whole multi-artboard design below that floor', () => {
    const rig = boardRig({ viewport: { width: 300, height: 260 }, panelWidth: 300 });
    rig.controller.setArtifact(
      artifact([page('p1'), page('p2', 3000), page('p3', 6000), page('p4', 9000)]),
      initialViewState(),
    );
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.controller.transform.zoom).toBeLessThan(MIN_LEGIBLE_ZOOM);
    expect(rig.controller.transform.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  });

  it('cannot be driven to a non-finite transform by a hostile viewport', () => {
    const rig = boardRig();
    rig.controller.setArtifact(artifact([page('p1')]), initialViewState());
    rig.controller.zoomIn();
    rig.viewport.width = Number.NaN;
    rig.viewport.height = Number.NEGATIVE_INFINITY;
    rig.resizer()!.fire();
    rig.flush();
    const t = rig.controller.transform;
    expect(Number.isFinite(t.zoom)).toBe(true);
    expect(Number.isFinite(t.pan.x)).toBe(true);
    expect(Number.isFinite(t.pan.y)).toBe(true);
  });
});

describe('breakpoints reach the shell', () => {
  it('publishes the mode and its panes as the panel narrows', () => {
    const rig = boardRig({ panelWidth: 1600 });
    rig.controller.refreshLayout();
    expect(rig.layouts.at(-1)).toEqual({ mode: 'wide', panes: { rail: true, inspector: true } });

    rig.panelWidth.value = 900;
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.layouts.at(-1)).toEqual({ mode: 'medium', panes: { rail: true, inspector: false } });

    rig.panelWidth.value = 420;
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.layouts.at(-1)).toEqual({ mode: 'narrow', panes: { rail: false, inspector: false } });
    expect(rig.controller.layoutMode).toBe('narrow');
  });

  it('publishes nothing when a resize does not cross a breakpoint', () => {
    const rig = boardRig({ panelWidth: 1600 });
    rig.controller.refreshLayout();
    const seen = rig.layouts.length;
    rig.panelWidth.value = 1400;
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.layouts.length).toBe(seen);
  });

  it('ignores an unmeasured panel rather than guessing narrow', () => {
    const rig = boardRig({ panelWidth: 0 });
    rig.controller.refreshLayout();
    expect(rig.controller.layoutMode).toBe('wide');
    expect(rig.layouts.at(-1)!.mode).toBe('wide');
  });

  it('carries an override across a mode change that did not move that pane', () => {
    const rig = boardRig({ panelWidth: 1600 });
    rig.controller.refreshLayout();
    rig.controller.togglePane('rail');                 // "I hid the pages rail"
    expect(rig.controller.layout.panes.rail).toBe(false);

    // wide → medium moves only the inspector, so the rail stays hidden.
    rig.panelWidth.value = 800;
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.controller.layout).toEqual({ mode: 'medium', panes: { rail: false, inspector: false } });

    // medium → narrow turns the rail into an overlay: that intent no longer
    // applies, and the mode's own default takes over.
    rig.panelWidth.value = 420;
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.controller.layout).toEqual({ mode: 'narrow', panes: { rail: false, inspector: false } });
    rig.controller.togglePane('rail');
    expect(rig.controller.layout.panes.rail).toBe(true);
  });

  it('yields a key the shell already claimed', () => {
    const rig = boardRig();
    rig.controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    rig.controller.select('p1', ['bbbbbbbbbb']);
    rig.fireKey({ key: 'Escape', defaultPrevented: true });
    expect(rig.controller.selection.mids).toHaveLength(1);
    rig.fireKey({ key: 'PageDown', defaultPrevented: true });
    expect(rig.focused).toEqual([]);
  });

  it('keeps a human pane override inside a mode, and drops it on a mode change', () => {
    const rig = boardRig({ panelWidth: 1600 });
    rig.controller.refreshLayout();
    rig.controller.togglePane('inspector');
    expect(rig.controller.layout.panes).toEqual({ rail: true, inspector: false });

    // Another resize inside `wide` must not undo the human's choice.
    rig.viewport.width = 1500;
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.controller.layout.panes).toEqual({ rail: true, inspector: false });

    // Crossing into `medium` re-applies that mode's defaults…
    rig.panelWidth.value = 800;
    rig.resizer()!.fire();
    rig.flush();
    expect(rig.controller.layout).toEqual({ mode: 'medium', panes: { rail: true, inspector: false } });

    // …and the human can still open it back up at this width.
    rig.controller.setPaneVisible('inspector', true);
    expect(rig.controller.layout.panes).toEqual({ rail: true, inspector: true });
  });

  it('refits after a pane toggle, because the board just changed width', () => {
    const rig = boardRig({ panelWidth: 1600 });
    rig.controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    rig.controller.refreshLayout();
    rig.flush();
    const builds = rig.controller.buildCount;
    rig.controller.togglePane('rail');
    rig.viewport.width = 1820;                          // the rail's 220px came back
    rig.flush();
    expect(rig.controller.buildCount).toBe(builds);     // still zero rebuilds
    expect(Number.isFinite(rig.controller.transform.zoom)).toBe(true);
  });
});

describe('the board is operable from the keyboard', () => {
  const pages = () => artifact([page('p1'), page('p2', 1600), page('p3', 3200)]);

  it('steps artboards with Alt+Arrow, wrapping at both ends', () => {
    const rig = boardRig();
    rig.controller.setArtifact(pages(), initialViewState());
    rig.fireKey({ key: 'ArrowRight', altKey: true });
    rig.fireKey({ key: 'ArrowRight', altKey: true });
    rig.fireKey({ key: 'ArrowRight', altKey: true });
    rig.fireKey({ key: 'ArrowRight', altKey: true });
    expect(rig.focused).toEqual(['p1', 'p2', 'p3', 'p1']);
    rig.fireKey({ key: 'ArrowLeft', altKey: true });
    expect(rig.focused.at(-1)).toBe('p3');
  });

  it('accepts PageDown/PageUp for the same move', () => {
    const rig = boardRig();
    rig.controller.setArtifact(pages(), initialViewState());
    rig.fireKey({ key: 'PageDown' });
    rig.fireKey({ key: 'PageDown' });
    rig.fireKey({ key: 'PageUp' });
    expect(rig.focused).toEqual(['p1', 'p2', 'p1']);
  });

  it('jumps to the first and last artboard with Home/End', () => {
    const rig = boardRig();
    rig.controller.setArtifact(pages(), initialViewState());
    rig.fireKey({ key: 'End' });
    rig.fireKey({ key: 'Home' });
    expect(rig.focused).toEqual(['p3', 'p1']);
  });

  it('centres the artboard it navigates to, without changing zoom', () => {
    const rig = boardRig({ viewport: { width: 1600, height: 1000 } });
    rig.controller.setArtifact(pages(), initialViewState());
    rig.controller.setZoom(0.5);
    const zoom = rig.controller.transform.zoom;
    rig.fireKey({ key: 'PageDown' });                    // p1, centred
    rig.fireKey({ key: 'PageDown' });                    // p2 at x=1600
    expect(rig.controller.transform.zoom).toBe(zoom);
    const centre = screenToWorld({ x: 800, y: 500 }, rig.controller.transform);
    expect(centre.x).toBeCloseTo(1600 + DESKTOP.width / 2, 6);
  });

  it('leaves plain arrows to the nudge and ignores keys aimed at a text field', () => {
    const rig = boardRig();
    rig.controller.setArtifact(pages(), initialViewState());
    rig.fireKey({ key: 'ArrowRight' });                  // no Alt → not navigation
    rig.fireKey({ key: 'PageDown', target: { tagName: 'INPUT' } });
    rig.fireKey({ key: 'ArrowRight', altKey: true, target: { isContentEditable: true } });
    expect(rig.focused).toEqual([]);
  });

  it('zooms with Cmd+= / Cmd+- and fits with Cmd+0', () => {
    const rig = boardRig();
    rig.controller.setArtifact(artifact([page('p1')]), initialViewState());
    let prevented = 0;
    const key = (k: string) => rig.fireKey({ key: k, metaKey: true, preventDefault: () => { prevented++; } });
    key('=');
    const zoomedIn = rig.controller.transform.zoom;
    expect(rig.controller.autoFitting).toBe(false);
    key('-');
    expect(rig.controller.transform.zoom).toBeLessThan(zoomedIn);
    key('0');
    expect(rig.controller.autoFitting).toBe(true);
    expect(prevented).toBe(3);
  });

  it('clears the selection on Escape', () => {
    const rig = boardRig();
    rig.controller.setArtifact(pages(), initialViewState());
    rig.controller.select('p1', ['bbbbbbbbbb']);
    expect(rig.controller.selection.mids).toHaveLength(1);
    rig.fireKey({ key: 'Escape' });
    expect(rig.controller.selection.mids).toHaveLength(0);
    expect(rig.controller.selection.pageId).toBeNull();
  });
});

/* ══════════════════════ 3. the shell actually collapses ══════════════════════ */

const SHELL_IDS = [
  'app', 'page-stage', 'board-scroll', 'board-overlay', 'board-empty',
  'zoom-level', 'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit',
  'rail-list', 'staged-rail', 'insp-body', 'version-timeline', 'history-toolbar',
  'artifact-name', 'agent-activity', 'capability-chips', 'scaffold-menu',
  'btn-present', 'btn-export', 'btn-add-page', 'onboarding', 'onboarding-dismiss',
  'empty-templates', 'pages-rail', 'inspector',
  // The shell's pane state machine — real checkboxes, so the collapse keeps
  // working if this bundle never loads (`canvas.css` §5).
  'rail-hidden', 'rail-shown', 'inspector-hidden', 'inspector-shown',
];

/** The shell's switches are `<input type=checkbox>`; `checked` is a property. */
type Switch = FakeElement & { checked?: boolean };

interface AppRig {
  app: CanvasApp;
  doc: FakeDocument;
  root: FakeElement;
  deliver(message: CanvasHostMessage): void;
  fireKey(ev: Record<string, unknown>): void;
  sw(id: string): Switch;
  flush(): void;
}

const globalPatch = globalThis as unknown as {
  innerWidth?: number;
  requestAnimationFrame?: (cb: () => void) => number;
};
const savedWidth = globalPatch.innerWidth;
const savedRaf = globalPatch.requestAnimationFrame;
afterEach(() => {
  globalPatch.innerWidth = savedWidth;
  globalPatch.requestAnimationFrame = savedRaf;
});

function appRig(panelWidth: number): AppRig {
  const doc = new FakeDocument();
  for (const id of SHELL_IDS) { doc.seed(id); }
  doc.getElementById('app')!.className = 'app';
  const windowListeners = new Map<string, Array<(ev: unknown) => void>>();
  const frames: Array<() => void> = [];
  // `app.ts` builds its own BoardController, so the panel width has to arrive
  // the way it does in the browser: through the globals the board falls back to.
  globalPatch.innerWidth = panelWidth;
  globalPatch.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };

  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: {
      addEventListener: (type, listener) => {
        const list = windowListeners.get(type);
        if (list) { list.push(listener); } else { windowListeners.set(type, [listener]); }
      },
    },
    createIntersectionObserver: cb => new FakeIntersectionObserver(
      cb as unknown as (e: readonly { target: unknown; isIntersecting: boolean }[]) => void,
    ) as unknown as ReturnType<NonNullable<CanvasEnv['createIntersectionObserver']>>,
    createMessageChannel: () => new FakeChannel() as unknown as MessageChannelLike,
    fetchText: async () => '',
    now: () => 0,
    warn: () => { /* silent */ },
  };
  const bootPayload: CanvasBoot = {
    viewToken: TOKEN,
    runtimeUris: [], harnessUri: '', babelUri: '', innerCsp: '',
    devices: [], themes: [], scaffolds: [],
  };
  const app = new CanvasApp({ boot: bootPayload, env, post: () => { /* ignored */ } });
  app.start();
  const fire = (type: string, ev: unknown) => {
    for (const l of windowListeners.get(type) ?? []) { l(ev); }
  };
  return {
    app, doc,
    root: doc.getElementById('app')!,
    sw: id => doc.getElementById(id)! as Switch,
    deliver: message => fire('message', { data: message, source: null }),
    fireKey: ev => fire('keydown', ev),
    flush: () => { for (const cb of frames.splice(0, frames.length)) { cb(); } },
  };
}

describe('the shell root carries the layout contract', () => {
  it('paints the wide layout and keeps the shell class it already had', () => {
    const rig = appRig(1500);
    expect(rig.root.className.split(' ')).toEqual(['app', 'layout-wide']);
    expect(rig.root.attrs.get('data-layout-mode')).toBe('wide');
  });

  it('collapses both panes on a narrow panel', () => {
    const rig = appRig(420);
    const classes = rig.root.className.split(' ');
    expect(classes).toContain('app');
    expect(classes).toContain('layout-narrow');
    expect(classes).toContain(RAIL_COLLAPSED_CLASS);
    expect(classes).toContain(INSPECTOR_COLLAPSED_CLASS);
    expect(rig.app.layoutMode).toBe('narrow');
  });

  it('collapses only the inspector at medium width', () => {
    const rig = appRig(900);
    const classes = rig.root.className.split(' ');
    expect(classes).toContain('layout-medium');
    expect(classes).not.toContain(RAIL_COLLAPSED_CLASS);
    expect(classes).toContain(INSPECTOR_COLLAPSED_CLASS);
  });

  it('drives the shell switch that is actually live at this width', () => {
    const wide = appRig(1500);
    // Wide: both panes are docked columns, so the "hide" switches are the live
    // pair and neither is checked.
    expect(wide.sw('rail-hidden').checked).toBe(false);
    expect(wide.sw('inspector-hidden').checked).toBe(false);
    wide.fireKey({ key: '[' });
    expect(wide.sw('rail-hidden').checked).toBe(true);
    expect(wide.sw('rail-shown').checked).toBe(false);

    // Narrow: both panes are overlays, so the "show" switches are the live pair
    // and a stale "hide" from a wider layout must be cleared, or the pane would
    // silently re-collapse the moment the panel is widened again.
    const narrow = appRig(420);
    expect(narrow.sw('rail-shown').checked).toBe(false);
    expect(narrow.sw('rail-hidden').checked).toBe(false);
    narrow.fireKey({ key: '[' });
    expect(narrow.sw('rail-shown').checked).toBe(true);
    expect(narrow.sw('rail-hidden').checked).toBe(false);
  });

  it('folds a switch the human flipped directly back into the layout', () => {
    const rig = appRig(1500);
    // The in-pane close button and the scrim are `<label for=…>`; they reach no
    // click handler of ours, only the checkbox.
    const railSwitch = rig.sw('rail-hidden');
    railSwitch.checked = true;
    railSwitch.fire('change');
    expect(rig.app.layout.panes.rail).toBe(false);
    expect(rig.root.className).toContain(RAIL_COLLAPSED_CLASS);

    railSwitch.checked = false;
    railSwitch.fire('change');
    expect(rig.app.layout.panes.rail).toBe(true);
  });

  it('closes an overlay pane on Escape, and tells the board the key is spent', () => {
    const rig = appRig(420);                       // narrow: both panes overlay
    rig.fireKey({ key: ']' });
    expect(rig.app.layout.panes.inspector).toBe(true);

    let prevented = false;
    rig.fireKey({ key: 'Escape', preventDefault: () => { prevented = true; } });
    expect(rig.app.layout.panes.inspector).toBe(false);
    expect(prevented).toBe(true);

    // With nothing overlaying the board, Escape is the board's again.
    let stillOurs = false;
    rig.fireKey({ key: 'Escape', preventDefault: () => { stillOurs = true; } });
    expect(stillOurs).toBe(false);
  });

  it('toggles panes from the keyboard, and never while the human is typing', () => {
    const rig = appRig(1500);
    rig.fireKey({ key: '[' });
    expect(rig.root.className).toContain(RAIL_COLLAPSED_CLASS);
    rig.fireKey({ key: ']' });
    expect(rig.root.className).toContain(INSPECTOR_COLLAPSED_CLASS);

    // Backslash is "show me the board" / "give it all back".
    rig.fireKey({ key: '\\' });
    expect(rig.app.layout.panes).toEqual({ rail: true, inspector: true });
    rig.fireKey({ key: '\\' });
    expect(rig.app.layout.panes).toEqual({ rail: false, inspector: false });

    const before = rig.root.className;
    rig.fireKey({ key: '[', target: { tagName: 'INPUT' } });
    rig.fireKey({ key: '[', metaKey: true });
    expect(rig.root.className).toBe(before);
  });

  it('lets Escape close the pane WITHOUT also clearing the selection', () => {
    const rig = appRig(420);
    rig.deliver({
      t: 'canvas/hello', artifactId: 'art1', artifact: artifact([page('p1')]),
      viewToken: TOKEN, caps: [],
    });
    rig.app.board.select('p1', ['bbbbbbbbbb']);
    rig.fireKey({ key: ']' });
    expect(rig.app.layout.panes.inspector).toBe(true);

    // A real event: `preventDefault()` sets `defaultPrevented`, which is how the
    // board learns the press was spent. Listener order (shell before board) is
    // what makes this observable at all.
    const ev: Record<string, unknown> = { key: 'Escape', defaultPrevented: false };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    rig.fireKey(ev);

    expect(rig.app.layout.panes.inspector).toBe(false);
    expect(rig.app.board.selection.mids).toHaveLength(1);
  });

  it('exposes the mode as view state the rest of the app can read', () => {
    const rig = appRig(900);
    expect(rig.app.layout).toEqual({ mode: 'medium', panes: { rail: true, inspector: false } });
    // A copy, not the live object — the same rule zoom and selection follow.
    rig.app.layout.panes.rail = false;
    expect(rig.app.layout.panes.rail).toBe(true);
  });
});
