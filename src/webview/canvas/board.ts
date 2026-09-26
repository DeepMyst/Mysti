/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 + §4 rows 1-2 - the board: ONE transformed world of N artboards,
 * live frames that OUTLIVE the edit, and a selection overlay drawn by the
 * parent.
 *
 * What this replaces: `renderBoard()` in `media/canvas/canvas.js` did
 * `stage.innerHTML = ''` and built a brand-new `<iframe>` whose `srcdoc`
 * re-inlined 3,144,476 bytes of runtime - and it ran on every artifact update
 * AND on every window resize. It showed the *selected* page only, fit-to-width,
 * capped at 1x, so a 20-page design was 19 text rows and one live frame. Scroll
 * position, focus, hover, input values and CSS animation died on each render,
 * and a 200-byte text change cost two full runtime recompiles.
 *
 * Three properties define this file:
 *
 * 1. **One world.** Every artboard is absolutely positioned at its own
 *    `page.boardPos`, sized to its own `page.format`, inside a single element
 *    carrying `translate(pan) scale(zoom)`. Wheel pans, ctrl/cmd-wheel zooms
 *    about the cursor, space-drag pans, and zoom-to-fit frames the whole design.
 *    All of the arithmetic lives in `boardMath.ts` as pure functions - this file
 *    only wires it to events.
 *
 * 2. **O(visible), not O(pages).** Frames mount only for artboards intersecting
 *    the viewport above a zoom threshold; everything else is a parent-drawn
 *    static preview (`preview.ts`) with no iframe and no scripts. Once mounted,
 *    a frame is only ever *messaged* - `canvas/ops` becomes `patch {ops}` down
 *    the artboard's own `MessageChannel` port, so React reconciles and scroll,
 *    focus, hover and animation all survive. Virtualization here is a
 *    requirement, not an optimization (risk 5).
 *
 * 3. **Selection is drawn in the parent and owned by the human.** The frame
 *    reports geometry (`hit`, `rects`) in page coordinates and nothing else;
 *    the parent composes those with `boardPos` and the board transform. An
 *    incoming `canvas/ops` never sets, moves or steals selection, and never
 *    touches pan or zoom - it can only prune mids that ceased to exist. See
 *    `selection.ts` for why the overlay cannot live inside the frame.
 *
 * The dedicated port is also what deletes the `ev.source !== window` heuristic
 * the old shell itself flagged as unverified: page traffic and host traffic are
 * now structurally different channels rather than two kinds of `window` message
 * told apart by a guess.
 */

import type {
  CanvasEnv,
  DomElement,
  DomIframe,
  IntersectionObserverLike,
  MessagePortLike,
} from './dom';
import { drawPreview, type PreviewOptions } from './preview';
import { buildFrameDocument, themeCssVars, type FrameRuntime } from './sandboxDoc';
import {
  frameHandshakeMessage,
  isTrustedFrameChannel,
  parseFrameUpMessage,
  themeTokenMap,
  type FrameDownMessage,
  type FrameUpMessage,
} from '../../managers/CanvasSandbox';
import { effectiveFormat, type CanvasViewState, type RenderPlan } from './state';
import {
  worldToScreen,
  FIT_PADDING,
  centerOn,
  clampZoom,
  contentBounds,
  carryOverride,
  decideLayoutMode,
  finiteOr,
  elementScreenRect,
  fitMinZoom,
  fitTransform,
  identityTransform,
  isVisible,
  normalizeTransform,
  normalizedRect,
  panBy,
  preserveCenter,
  resolvePanes,
  screenToWorld,
  stepIndex,
  wheelIntent,
  zoomBy,
  zoomPresetStep,
  type BoardTransform,
  type LayoutMode,
  type PaneOverride,
  type PaneVisibility,
  type Point,
  type Rect,
  type Size,
  type WheelLike,
} from './boardMath';
import {
  SelectionOverlay,
  applyHit,
  arrowDelta,
  emptySelection,
  isMarqueeGesture,
  marqueeHits,
  nudgeOps,
  pruneSelection,
  selectionAnchor,
  selectionEquals,
  setSelection as buildSelection,
  tabTarget,
  type HitModifiers,
  type MarqueeCandidate,
  type OverlayBox,
  type SelectionState,
} from './selection';
import type { WireArtifact } from '../../canvas/protocol';
import type { CanvasOp } from '../../canvas/CanvasOps';
import type { Mid } from '../../canvas/doc/DocNode';
import type { ArtifactPage } from '../../types';

/** Below this zoom an artboard is never worth a live frame. */
export const DEFAULT_LIVE_ZOOM = 0.35;
/** Hard cap on simultaneously live frames, whatever the viewport says. */
export const DEFAULT_MAX_LIVE_FRAMES = 8;
/** Screen-px ring around the viewport in which frames are pre-mounted. */
export const LIVE_PREMOUNT_MARGIN_PX = 256;

/** Shell element ids the board adopts when it is not handed them explicitly. */
export const BOARD_VIEWPORT_ID = 'board-scroll';
export const BOARD_OVERLAY_ID = 'board-overlay';
export const BOARD_ZOOM_LEVEL_ID = 'zoom-level';
export const BOARD_ZOOM_IN_ID = 'btn-zoom-in';
export const BOARD_ZOOM_OUT_ID = 'btn-zoom-out';
export const BOARD_ZOOM_FIT_ID = 'btn-zoom-fit';
/**
 * The element whose width decides the layout mode.
 *
 * It is deliberately NOT the board: collapsing a pane makes the board wider,
 * which would push the width back over the breakpoint that collapsed it - a
 * layout that oscillates every frame. The panel's own root does not move when
 * a pane collapses, so it is the only stable input to the decision.
 */
export const BOARD_LAYOUT_ROOT_ID = 'app';

/**
 * Per-page rect cache ceiling. A live frame is model-authored content and can
 * report up to 4,000 rects per message; without a ceiling a page that mutates
 * in a loop would grow this map without bound in the PARENT document.
 */
const MAX_CACHED_RECTS = 8000;

/**
 * How many parent-authorised inline edits stay committable per artboard.
 *
 * Mirrors `CLOSING_TAIL` in `textEdit.ts` and exists for the same reason: when
 * the human opens an edit on B while A is still open, the harness closes A
 * ITSELF and posts `textCommit{A}` *after* the parent has already sent
 * `beginTextEdit{B}`. A single-slot record would drop that genuine human edit.
 */
const AUTHORIZED_EDIT_TAIL = 4;

export type ArtboardMode = 'live' | 'preview';

export interface MountDecisionInput {
  intersecting: boolean;
  zoom: number;
  liveZoomThreshold: number;
  /** Live frames already mounted, this artboard excluded. */
  liveCount: number;
  maxLive: number;
  /** A runtime that has not arrived yet cannot produce a frame. */
  runtimeReady: boolean;
}

/**
 * The virtualization rule, extracted so it is testable without a DOM.
 *
 * Deliberately conservative: anything that is not clearly worth a live frame
 * falls back to the static preview, which always renders correctly. The failure
 * mode of being wrong is "this artboard is not interactive yet", never "this
 * artboard is blank".
 */
export function decideMode(input: MountDecisionInput): ArtboardMode {
  if (!input.runtimeReady) { return 'preview'; }
  if (!input.intersecting) { return 'preview'; }
  if (input.zoom < input.liveZoomThreshold) { return 'preview'; }
  if (input.liveCount >= input.maxLive) { return 'preview'; }
  return 'live';
}

/* ------------------------------ resize seam ------------------------------ */

/*
 * `dom.ts` declares the DOM structurally (the repo has no `lib.dom`), and it is
 * owned by the shell. So the two globals THIS module needs and nothing else
 * does are declared here, structurally, and injected through
 * {@link BoardOptions} - which is also what lets a headless test drive a resize
 * by hand instead of waiting on a browser that does not exist.
 */

/** One `ResizeObserverEntry`. Only `target` is read; sizes are re-measured. */
export interface ResizeEntryLike { readonly target: DomElement }

export interface ResizeObserverLike {
  observe(target: DomElement): void;
  unobserve(target: DomElement): void;
  disconnect(): void;
}

export type ResizeObserverFactory = (
  callback: (entries: readonly ResizeEntryLike[]) => void,
) => ResizeObserverLike;

/** Defer to the next paint. Injected so a test can make it synchronous. */
export type FrameScheduler = (callback: () => void) => void;

/** The panel's responsive state: which mode, and which panes it implies. */
export interface BoardLayout {
  mode: LayoutMode;
  panes: PaneVisibility;
}

function realResizeObserverFactory(): ResizeObserverFactory | null {
  const g = globalThis as {
    ResizeObserver?: new (cb: (entries: readonly ResizeEntryLike[]) => void) => ResizeObserverLike;
  };
  const RO = g.ResizeObserver;
  return RO ? (cb => new RO(cb)) : null;
}

function realFrameScheduler(): FrameScheduler {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => unknown };
  const raf = g.requestAnimationFrame;
  if (typeof raf === 'function') { return cb => { raf.call(g, cb); }; }
  return cb => { setTimeout(cb, 16); };
}

/* --------------------------- frame port protocol --------------------------- */

/*
 * The frame protocol is NOT declared here. `CanvasSandbox.ts` owns it -
 * `FrameDownMessage` / `FrameUpMessage` / `frameHandshakeMessage` /
 * `parseFrameUpMessage` - because the same module emits the harness that sits
 * on the other end. A second copy in the webview is exactly the mirror that
 * drifted three ways last time (§2.9), so this module imports and re-exports it
 * rather than restating it.
 */
export type { FrameDownMessage, FrameUpMessage };

/* ------------------------- structural event shapes ------------------------- */

/*
 * `tsconfig.json` ships `lib: ["ES2022"]` with no `lib.dom`, so DOM events are
 * declared structurally here exactly as `dom.ts` declares elements. Everything
 * below is read defensively: these objects arrive from the browser in
 * production and from a fake in tests, and neither is allowed to throw.
 */

interface PointerLike {
  clientX?: number;
  clientY?: number;
  button?: number;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

interface KeyLike {
  key?: string;
  code?: string;
  /** Set by whoever claimed the key first. The board yields to them. */
  defaultPrevented?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: unknown;
  preventDefault?: () => void;
}

/** A DOM node as the hit resolver reads it - attributes and a parent link. */
interface AttrNodeLike {
  getAttribute?(name: string): string | null;
  parentElement?: unknown;
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
}

interface MeasurableLike {
  clientWidth?: number;
  clientHeight?: number;
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
}

function modifiersOf(ev: PointerLike | KeyLike): HitModifiers {
  return {
    shift: ev?.shiftKey === true,
    meta: ev?.metaKey === true,
    ctrl: ev?.ctrlKey === true,
    alt: ev?.altKey === true,
  };
}

/** Is the event aimed at something the human is typing into? Then it is not ours. */
export function isTextEntryTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') { return false; }
  const node = target as { tagName?: unknown; isContentEditable?: unknown };
  if (node.isContentEditable === true) { return true; }
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Roles whose own keyboard contract includes Space.
 *
 * ARIA's authoring practices give every one of these Space as an activation or
 * toggle key, so a widget-level gesture must not out-rank them.
 */
const ACTIVATION_ROLES = new Set([
  'button', 'link', 'checkbox', 'switch', 'radio', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
]);

/**
 * Is the event aimed at something Space ACTIVATES? Then it is not ours either.
 *
 * The pan gesture used to claim Space from the window for any target that was
 * not a text entry, and `preventDefault()` on a Space keydown suppresses the
 * browser's native activation of a focused control — so Stop, Undo, Redo, Save
 * version, Export, Present, the zoom buttons, every Accept/Reject in the review
 * queue and every inspector toggle answered only to Enter, silently.
 *
 * Deliberately a TARGET test rather than a "does the board own focus" test:
 * space-drag panning has to keep working for the mouse user who has focused
 * nothing at all (`activeElement` is `<body>`), which is the overwhelmingly
 * common case for this gesture.
 */
export function isActivationTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') { return false; }
  const node = target as { tagName?: unknown; getAttribute?: unknown };
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  const get = typeof node.getAttribute === 'function'
    ? (node.getAttribute as (name: string) => string | null).bind(node)
    : null;
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'OPTION') { return true; }
  if (tag === 'A' && get?.('href') !== null && get?.('href') !== undefined) { return true; }
  const role = get?.('role');
  return typeof role === 'string' && ACTIVATION_ROLES.has(role.trim().toLowerCase());
}

/**
 * Walk up from an event target collecting the artboard and element it names.
 *
 * The cap is a hard stop against a cyclic or absurdly deep `parentElement`
 * chain (the preview renderer alone allows 64 levels, plus artboard chrome and
 * the shell above it), so a hostile document cannot turn one click into an
 * unbounded loop in the PARENT.
 */
function resolveDomHit(target: unknown, maxDepth = 160):
{ pageId: string | null; mid: Mid | null; node: AttrNodeLike | null } {
  let node = target as AttrNodeLike | null | undefined;
  let mid: Mid | null = null;
  let midNode: AttrNodeLike | null = null;
  let pageId: string | null = null;
  for (let depth = 0; node && depth < maxDepth; depth++) {
    const get = typeof node.getAttribute === 'function' ? node.getAttribute.bind(node) : null;
    if (get) {
      if (!mid) {
        const value = get('data-mid');
        if (typeof value === 'string' && value) { mid = value; midNode = node; }
      }
      if (!pageId) {
        const value = get('data-page-id');
        if (typeof value === 'string' && value) { pageId = value; }
      }
    }
    if (pageId) { break; }
    node = node.parentElement as AttrNodeLike | null | undefined;
  }
  return { pageId, mid: pageId ? mid : null, node: pageId ? midNode : null };
}

/* ------------------------------- callbacks ------------------------------- */

export interface BoardCallbacks {
  /** Frame stats from a completed pan/zoom. */
  onGestureStats?: (stats: { p50: number; p95: number; dropped: number }) => void;
  /** A frame reported a render error - becomes an on-artboard card + `canvas/frameError`. */
  onFrameError?(pageId: string, message: string, mid?: string): void;
  onFrameReady?(pageId: string): void;
  /**
   * An element was hit inside a live frame. Selection is drawn by the parent
   * and has ALREADY been updated when this fires; prefer
   * {@link BoardCallbacks.onSelectionChange}, which also covers preview clicks,
   * marquee, Tab and Escape.
   */
  onHit?(pageId: string, mid: string): void;
  /** An inline edit committed in the frame. The caller turns it into `el.setText`. */
  onTextCommit?(pageId: string, mid: string, text: string): void;
  /** Reported content height, which finally gives `validate_page` a real number. */
  onSize?(pageId: string, size: { w: number; h: number }): void;
  /**
   * Selection changed. VIEW state (§3.5): the app mirrors it to the host with
   * `canvas/selection` and must never let an incoming artifact overwrite it.
   */
  onSelectionChange?(selection: SelectionState): void;
  /** Pan/zoom changed from a board gesture. The app adopts it into its view state. */
  onViewChange?(view: CanvasViewState): void;
  /** The human focused an artboard (clicked its chrome). */
  onFocusPage?(pageId: string): void;
  /** Ops produced by a board gesture (arrow-nudge). Submit via `canvas/submit`. */
  onOps?(ops: CanvasOp[]): void;
  /** A double-click on an element - the entry point for inline text editing. */
  onBeginTextEdit?(pageId: string, mid: Mid): void;
  /**
   * The responsive layout changed - a new breakpoint, or a pane the human
   * toggled. The app turns it into classes on the shell root; the board does
   * not touch the shell's DOM itself.
   */
  onLayoutChange?(layout: BoardLayout): void;
}

export interface BoardOptions {
  /** The shell's CSP nonce, stamped onto each artboard frame's scripts. */
  frameNonce?: string;
  env: CanvasEnv;
  /** The transformed world element every artboard is appended to. */
  world: DomElement;
  /** Resolves `asset://` refs for both the preview and the frame. */
  resolveAsset?: (ref: string) => string | null;
  liveZoomThreshold?: number;
  maxLiveFrames?: number;
  /**
   * The webview's `cspSource`. Doc-mode frames ship a hardened `img-src` that
   * allows only `data:`/`blob:`; without this an `asset://` resolved to a
   * webview URI would be blocked by the frame's own CSP.
   */
  imgSources?: readonly string[];
  /**
   * The clipping viewport the world pans inside. Wheel, marquee and space-drag
   * bind here. Defaults to `#board-scroll` from the shell.
   */
  viewportHost?: DomElement | null;
  /**
   * Untransformed layer above the world where selection chrome is drawn.
   * Defaults to `#board-overlay`. Absent = no overlay (selection still works,
   * it is just not painted).
   */
  overlayHost?: DomElement | null;
  /** Viewport size in CSS px. Defaults to measuring {@link BoardOptions.viewportHost}. */
  measureViewport?: () => Size;
  /**
   * The element whose width picks the breakpoint. Defaults to
   * `#app` - see {@link BOARD_LAYOUT_ROOT_ID} for why it must not be the board.
   */
  layoutHost?: DomElement | null;
  /** Panel width in CSS px. Defaults to measuring {@link BoardOptions.layoutHost}. */
  measureLayoutWidth?: () => number;
  /** `ResizeObserver`. Defaults to the real one; `null` falls back to `resize`. */
  createResizeObserver?: ResizeObserverFactory | null;
  /** rAF. Defaults to the real one; a test passes a synchronous scheduler. */
  scheduleFrame?: FrameScheduler;
  /** Frame the whole design the first time an artifact arrives. Default true. */
  autoFit?: boolean;
  callbacks?: BoardCallbacks;
}

interface Artboard {
  pageId: string;
  root: DomElement;
  /**
   * The name drawn above the artboard. Held by reference because it is page
   * state: {@link BoardController._layout} rewrites it on every rename.
   */
  label: DomElement;
  /** The artboard's size, beside the name. Rewritten on every reformat. */
  formatTag: DomElement;
  surface: DomElement;
  previewHost: DomElement;
  frame: DomIframe | null;
  port: MessagePortLike | null;
  mode: ArtboardMode;
  intersecting: boolean;
  /**
   * Mids the PARENT opened an inline edit on, most recent last (P2).
   *
   * A `textCommit` is honoured only for a mid in here, so the frame stops being
   * the sole witness to its own authorisation: `InlineTextEditor._claim` used to
   * return `'active'` purely because `begin()` had run, and `begin()` was itself
   * triggered by the frame's own `hit{double:true}` — a closed loop a frame
   * could satisfy by construction.
   */
  editMids: Mid[];
  /** Frame documents built for this artboard. Non-zero means a full rebuild. */
  builds: number;
  /** Reconcile tick this artboard was last WANTED live. Drives LRU eviction. */
  lastSeen: number;
  /**
   * The format the live frame was last TOLD about (`<id>:<w>x<h>`), or `null`
   * while no port has been mounted.
   *
   * The page box lives in exactly one place - `buildBaseCss` bakes
   * `#__mysti_page { width: <format.width>px }` into the srcdoc - so resizing
   * the iframe element alone shrinks the box around an unchanged 1440px
   * document. Tracking what the frame was told is what lets {@link
   * BoardController._layout} push the new format down the EXISTING port instead
   * of rebuilding the frame, which is the Phase 2 invariant: a live frame must
   * outlive the edit AND the resize.
   */
  sentFormat: string | null;
}

/**
 * Owns the artboard elements, the board transform, the selection, and every
 * decision about live-vs-preview.
 *
 * It never re-creates an artboard for a content change: `applyPlan` is the only
 * entry that content updates take, and its delta branch touches nothing but a
 * `postMessage` and the (cheap, script-free) static preview underneath.
 */
export class BoardController {
  private readonly _env: CanvasEnv;
  private readonly _world: DomElement;
  private readonly _callbacks: BoardCallbacks;
  private readonly _liveZoom: number;
  private readonly _maxLive: number;
  private readonly _resolveAsset: (ref: string) => string | null;
  private readonly _imgSources: readonly string[];
  private readonly _frameNonce: string | undefined;
  /** Frame deltas sampled during the CURRENT gesture. Smoothness only
   *  matters while the user is dragging, so the sampler runs only then. */
  private _gestureFrames: number[] = [];
  private _gestureRaf: number | null = null;
  private _zoomRaf: number | null = null;
  private _gestureLast = 0;
  private _lastGestureStats: { p50: number; p95: number; dropped: number } | null = null;
  private readonly _autoFit: boolean;

  private readonly _boards = new Map<string, Artboard>();
  /** pageId → mid → rect in PAGE coordinates, as reported by the frame. */
  private readonly _rects = new Map<string, Map<Mid, Rect>>();
  private _observer: IntersectionObserverLike | null = null;
  private _artifact: WireArtifact | null = null;
  private _view: CanvasViewState | null = null;
  private _runtime: FrameRuntime | null = null;
  private _disposed = false;

  private _tick = 0;
  private _transform: BoardTransform = identityTransform();
  /** The last pan/zoom the APP supplied. Board gestures never touch it. */
  private _appZoom: number | null = null;
  private _appPan: Point | null = null;
  private _selection: SelectionState = emptySelection();
  private _overlay: SelectionOverlay | null = null;
  private readonly _viewportHost: DomElement | null;
  private readonly _measureViewport: () => Size;
  private _fitted = false;

  /* responsive layout + resize */
  private readonly _layoutHost: DomElement | null;
  private readonly _measureLayoutWidth: () => number;
  private readonly _scheduleFrame: FrameScheduler;
  private _resize: ResizeObserverLike | null = null;
  private _resizeScheduled = false;
  private _lastViewport: Size | null = null;
  /**
   * The full-chrome layout until something measurable says otherwise. An
   * unmeasured panel (a webview mid-boot, a headless test) is not evidence of
   * a narrow one, and guessing narrow would collapse both panes on first paint.
   */
  private _layoutMode: LayoutMode = 'wide';
  private _layoutMeasured = false;
  private _paneOverride: PaneOverride | null = null;
  private _panes: PaneVisibility = { rail: true, inspector: true };
  /**
   * Has the human taken deliberate control of the viewport?
   *
   * Until they have, the board is in AUTO-FIT: it re-frames the design on every
   * resize and every breakpoint change, which is what makes a panel dragged
   * narrow still show the whole design. The first wheel-zoom, drag-pan, zoom
   * button or artboard navigation flips this, and from then on a resize
   * preserves what they were looking at instead of overriding it. Zoom-to-fit
   * hands control back.
   */
  private _userAdjusted = false;
  /** The artboard keyboard navigation steps from. */
  private _focusedPageId: string | null = null;

  /* gesture state */
  private _spaceHeld = false;
  private _panFrom: Point | null = null;
  private _panOrigin: BoardTransform | null = null;
  private _marqueeFrom: Point | null = null;
  private _marqueeMods: HitModifiers = {};
  private _marqueeRect: Rect | null = null;
  private _marqueeActive = false;
  private _suppressClick = false;

  constructor(opts: BoardOptions) {
    this._env = opts.env;
    this._world = opts.world;
    this._callbacks = opts.callbacks ?? {};
    this._liveZoom = opts.liveZoomThreshold ?? DEFAULT_LIVE_ZOOM;
    this._maxLive = opts.maxLiveFrames ?? DEFAULT_MAX_LIVE_FRAMES;
    this._resolveAsset = opts.resolveAsset ?? (() => null);
    this._imgSources = opts.imgSources ?? [];
    this._frameNonce = opts.frameNonce;
    this._autoFit = opts.autoFit !== false;

    this._viewportHost = opts.viewportHost ?? this._env.doc.getElementById(BOARD_VIEWPORT_ID);
    const overlayHost = opts.overlayHost ?? this._env.doc.getElementById(BOARD_OVERLAY_ID);
    if (overlayHost) {
      this._overlay = new SelectionOverlay({ doc: this._env.doc, host: overlayHost });
    }
    this._measureViewport = opts.measureViewport ?? (() => this._defaultViewportSize());
    this._layoutHost = opts.layoutHost ?? this._env.doc.getElementById(BOARD_LAYOUT_ROOT_ID);
    this._measureLayoutWidth = opts.measureLayoutWidth ?? (() => this._defaultLayoutWidth());
    this._scheduleFrame = opts.scheduleFrame ?? realFrameScheduler();

    // ONE observer for the whole panel, watching the two elements whose size
    // means something: the board (refit) and the panel root (breakpoint). Both
    // funnel into a single rAF-coalesced measurement pass, so a drag that fires
    // dozens of resize records still costs one measure and one transform write
    // per frame - and never a frame rebuild, which is what the old shell's
    // `window.addEventListener('resize', renderBoard)` cost.
    const makeResize = opts.createResizeObserver === undefined
      ? realResizeObserverFactory()
      : opts.createResizeObserver;
    if (makeResize) {
      const observer = makeResize(() => this._scheduleResize());
      this._resize = observer;
      if (this._viewportHost) { observer.observe(this._viewportHost); }
      if (this._layoutHost && this._layoutHost !== this._viewportHost) {
        observer.observe(this._layoutHost);
      }
    }

    const factory = this._env.createIntersectionObserver;
    if (factory) {
      this._observer = factory(
        entries => this._onIntersect(entries),
        { rootMargin: `${LIVE_PREMOUNT_MARGIN_PX}px` },
      );
    }
    this._bindInput();
    this._applyTransform();
  }

  /** Artboards currently backed by a live iframe. */
  get liveCount(): number {
    let n = 0;
    for (const board of this._boards.values()) { if (board.mode === 'live') { n++; } }
    return n;
  }

  /** Total frame documents ever built. The regression guard for "no reload". */
  get buildCount(): number {
    let n = 0;
    for (const board of this._boards.values()) { n += board.builds; }
    return n;
  }

  boardIds(): string[] { return [...this._boards.keys()]; }

  /** The live board transform. View state - never written by an incoming op. */
  get transform(): BoardTransform { return { zoom: this._transform.zoom, pan: { ...this._transform.pan } }; }

  /** The current selection. View state - see the module docs. */
  get selection(): SelectionState { return { pageId: this._selection.pageId, mids: [...this._selection.mids] }; }

  /**
   * The runtime arrives asynchronously (it is fetched, not baked into the shell
   * HTML), so previews render immediately and frames light up when it lands.
   */
  setRuntime(runtime: FrameRuntime): void {
    this._runtime = runtime;
    this._reconcileModes();
  }

  /** Full state transfer: `canvas/hello` or `canvas/resync`. */
  setArtifact(artifact: WireArtifact, view: CanvasViewState): void {
    this._artifact = artifact;
    this._adoptView(view);
    this._applyTransform();
    this._syncPages();
    if (this._autoFit && !this._fitted && artifact.pages.length > 0) {
      this._fitted = true;
      this.zoomToFit();
    }
    this._drawOverlay();
  }

  setView(view: CanvasViewState): void {
    const before = this._transform;
    const formatChanged = !this._view || this._view.previewFormat !== view.previewFormat;
    this._adoptView(view);
    const moved = before.zoom !== this._transform.zoom
      || before.pan.x !== this._transform.pan.x
      || before.pan.y !== this._transform.pan.y;
    if (formatChanged) { this._resizeAll(); }
    if (moved) { this._applyTransform(); }
    if (moved || formatChanged) { this._reconcileModes(); }
    this._drawOverlay();
  }

  /**
   * THE steady state. Deltas go down existing ports; nothing here rebuilds a
   * frame unless the plan explicitly says a page must reload.
   *
   * Note what is absent: any write to selection, pan, zoom or focus. An agent
   * edit is not allowed to move the human's viewport or steal the cursor
   * (§4 row 9); the one concession is pruning mids that ceased to exist.
   */
  applyPlan(plan: RenderPlan): void {
    if (this._disposed) { return; }
    if (plan.structure) { this._syncPages(); }
    if (plan.theme) { this._pushTheme(); }
    // The canvas opens EMPTY and the first artboard usually arrives as an op,
    // not as a fresh artifact - so "fit on first arrival" has to be honoured
    // here too, or the agent's first design lands off screen at 100%. Both
    // guards matter: only the first artboard, and only while the human has not
    // taken the viewport (an agent edit may never move it - §4 row 9).
    if (plan.structure && this._autoFit && !this._fitted && !this._userAdjusted
      && (this._artifact?.pages.length ?? 0) > 0) {
      this._fitted = true;
      this.zoomToFit();
    }

    for (const [pageId, ops] of plan.patches) {
      const board = this._boards.get(pageId);
      if (!board) { continue; }
      // No port yet means the frame is still loading, and {@link _openPort}
      // opens with a full `mount` off the CURRENT doc - which the store folded
      // this very batch into before the board was called. Queueing the ops for
      // replay would hand the frame the same edit twice (R4-1). Nothing is
      // lost by dropping them: the mount is the authoritative transfer.
      if (board.port) { this._send(board, { t: 'patch', ops }); }
      // The static preview under every artboard is redrawn from the store's
      // already-updated doc, so an offscreen tile is as fresh as a live one.
      this._drawPreview(board);
    }

    for (const pageId of plan.reload) {
      const board = this._boards.get(pageId);
      if (!board) { continue; }
      this._drawPreview(board);
      if (board.mode === 'live') { this._rebuildFrame(board); }
    }

    this._pruneSelection();
    this._drawOverlay();
  }

  dispose(): void {
    this._disposed = true;
    this._observer?.disconnect();
    this._observer = null;
    this._resize?.disconnect();
    this._resize = null;
    for (const board of this._boards.values()) { this._teardown(board); board.root.remove(); }
    this._boards.clear();
    this._rects.clear();
    this._overlay?.dispose();
    this._overlay = null;
  }

  /* ------------------------------ viewport API ------------------------------ */

  /**
   * Frame the whole design. `Cmd+0`, the fit button, and first artifact load.
   *
   * Two things beyond the arithmetic in {@link fitTransform}:
   *
   * - It hands the viewport back to AUTO-FIT. An explicit fit is the human
   *   saying "stop, just show me the design", so from here a resize re-frames
   *   again rather than preserving a zoom they abandoned.
   * - A single artboard never fits below {@link fitMinZoom}. Fitting one 1440px
   *   artboard into a 260px-wide panel is a 0.15x grey rectangle; overflowing
   *   at a legible zoom is recoverable by scrolling, and unreadable is not.
   */
  zoomToFit(opts: { animate?: boolean } = {}): void {
    this._userAdjusted = false;
    const target = fitTransform(this._contentBounds(), this._viewport(), {
      padding: FIT_PADDING,
      minZoom: fitMinZoom(this._artifact?.pages.length ?? 0),
    });
    // Eased when the USER asked to fit (Cmd+0, the Fit button) — the jump is
    // large and instant framing loses the reader's place. NOT eased when the
    // board auto-fits (first artboard arriving, a breakpoint change), where an
    // animation would look like the layout wobbling on its own.
    if (opts.animate) { this._animateTo(target, 180); } else { this._setTransform(target); }
  }

  /** Step to the next zoom preset, anchored on the viewport centre. */
  zoomIn(): void { this._userAdjusted = true; this._zoomPreset(1); }
  zoomOut(): void { this._userAdjusted = true; this._zoomPreset(-1); }

  /** Set an absolute zoom, anchored on the viewport centre. */
  setZoom(zoom: number): void {
    this._userAdjusted = true;
    const size = this._viewport();
    const anchor = { x: size.width / 2, y: size.height / 2 };
    this._setTransform(zoomBy(
      this._transform,
      clampZoom(zoom) / this._transform.zoom,
      anchor,
    ));
  }

  /** True while the board is still re-framing itself on every resize. */
  get autoFitting(): boolean { return !this._userAdjusted; }

  /* ---------------------------- responsive API ---------------------------- */

  /** The live layout. View state: local, sovereign, never on the wire. */
  get layout(): BoardLayout {
    return { mode: this._layoutMode, panes: { ...this._panes } };
  }

  get layoutMode(): LayoutMode { return this._layoutMode; }

  /**
   * Measure the panel and publish the layout, even if it did not change.
   *
   * The app calls this once at start-up: the constructor cannot emit (the app
   * is still assigning its own fields when the board is built), and the very
   * first paint still has to put the mode classes on the shell.
   */
  refreshLayout(): void {
    if (this._disposed) { return; }
    if (!this._evaluateLayout()) { this._emitLayout(); }
    this._scheduleResize();
  }

  /**
   * Show or hide one side pane.
   *
   * The choice wins over the mode's default for as long as it still describes
   * an intent about that pane - see {@link carryOverride}, which keeps it
   * across a breakpoint that left the pane docked and drops it across one that
   * turned the pane into a modal overlay.
   */
  setPaneVisible(pane: 'rail' | 'inspector', visible: boolean): void {
    if (this._disposed) { return; }
    const override: PaneOverride = { ...(this._paneOverride ?? {}) };
    override[pane] = visible;
    this._paneOverride = override;
    this._panes = resolvePanes(this._layoutMode, override);
    this._emitLayout();
    // The pane is about to change the board's width; refit on the next frame,
    // once the shell's CSS has actually reflowed.
    this._scheduleResize();
  }

  togglePane(pane: 'rail' | 'inspector'): void {
    this.setPaneVisible(pane, !this._panes[pane]);
  }

  /* ------------------------------ navigation ------------------------------ */

  /**
   * Focus an artboard and centre it, without changing zoom.
   *
   * Zoom is deliberately preserved: "go to the next screen" must not also
   * change how large the design is, or a keyboard walk through 20 artboards
   * would rescale on every step.
   */
  focusPage(pageId: string): void {
    if (this._disposed) { return; }
    const artifact = this._artifact;
    const view = this._view;
    const page = this._page(pageId);
    if (!artifact || !view || !page) { return; }
    this._focusedPageId = pageId;
    const format = effectiveFormat(artifact, page, view);
    this._userAdjusted = true;
    this._setTransform(centerOn(
      { x: page.boardPos.x, y: page.boardPos.y, w: format.width, h: format.height },
      this._viewport(),
      this._transform,
    ));
    this._callbacks.onFocusPage?.(pageId);
  }

  /** Next (`1`) / previous (`-1`) artboard, wrapping. Alt+Arrow, PageUp/Down. */
  stepArtboard(dir: 1 | -1): void {
    const pages = this._artifact?.pages ?? [];
    if (pages.length === 0) { return; }
    const currentId = this._focusedPageId ?? this._view?.focusedPageId ?? this._selection.pageId;
    const current = currentId ? pages.findIndex(page => page.id === currentId) : -1;
    const next = stepIndex(pages.length, current, dir);
    if (next < 0) { return; }
    this.focusPage(pages[next].id);
  }

  /* ----------------------------- selection API ----------------------------- */

  /** Replace the selection from outside a gesture (a layer tree, a search hit). */
  select(pageId: string, mids: readonly Mid[]): void {
    this._setSelection(buildSelection(pageId, mids));
  }

  clearSelection(): void { this._setSelection(emptySelection()); }

  /** Element rects for a page, in PAGE coordinates. Diagnostic / test seam. */
  rectsFor(pageId: string): ReadonlyMap<Mid, Rect> {
    return this._rects.get(pageId) ?? new Map<Mid, Rect>();
  }

  /* ------------------------------- frame API ------------------------------- */

  /**
   * Post one down-message into a single artboard's frame port.
   *
   * The board owns the ports, so anything that needs to reach a frame goes
   * through here rather than opening a second channel: {@link InlineTextEditor}
   * sends `beginTextEdit`, and a caller may re-`select` or `measure`. A page
   * with no live frame is a silent no-op - the frame is a rendering detail, and
   * the op the gesture produces still travels the normal `canvas/submit` path.
   */
  sendToPage(pageId: string, message: FrameDownMessage): void {
    if (this._disposed) { return; }
    const board = this._boards.get(pageId);
    if (board) { this._send(board, message); }
  }

  /* ----------------------------- page lifecycle ----------------------------- */

  private _syncPages(): void {
    const artifact = this._artifact;
    if (!artifact) { return; }
    const seen = new Set<string>();

    for (const page of artifact.pages) {
      seen.add(page.id);
      let board = this._boards.get(page.id);
      if (!board) {
        board = this._createBoard(page);
        this._boards.set(page.id, board);
        this._world.appendChild(board.root);
        this._observer?.observe(board.root);
      }
      this._layout(board, page);
      this._drawPreview(board);
    }

    for (const [pageId, board] of [...this._boards]) {
      if (seen.has(pageId)) { continue; }
      this._observer?.unobserve(board.root);
      this._teardown(board);
      board.root.remove();
      this._boards.delete(pageId);
      this._rects.delete(pageId);
    }

    this._reconcileModes();
    this._pruneSelection();
  }

  private _createBoard(page: ArtifactPage): Artboard {
    const doc = this._env.doc;
    const root = doc.createElement('div');
    root.className = 'artboard';
    root.setAttribute('data-page-id', page.id);

    const label = doc.createElement('div');
    label.className = 'artboard-label';
    label.textContent = artboardTitle(page);
    root.appendChild(label);
    // The size, beside the name, above the artboard it describes. A separate
    // element rather than a second text node inside the label: `.artboard-label`
    // is read as a whole elsewhere, and the name is what that means.
    const formatTag = doc.createElement('div');
    formatTag.className = 'artboard-format';
    root.appendChild(formatTag);

    const surface = doc.createElement('div');
    surface.className = 'artboard-surface';
    root.appendChild(surface);

    const previewHost = doc.createElement('div');
    previewHost.className = 'artboard-preview';
    surface.appendChild(previewHost);

    return {
      pageId: page.id,
      root, label, formatTag, surface, previewHost,
      frame: null, port: null,
      mode: 'preview', intersecting: false,
      editMids: [], builds: 0, lastSeen: 0,
      sentFormat: null,
    };
  }

  private _layout(board: Artboard, page: ArtifactPage): void {
    const artifact = this._artifact;
    const view = this._view;
    if (!artifact || !view) { return; }
    const format = effectiveFormat(artifact, page, view);
    // The name is page state, not creation state: `page.setMeta{actionTitle}`
    // plans `structure`, so this runs on every rename. Written once in
    // `_createBoard`, the label above the artboard - and the frame's accessible
    // name - disagreed with the rail, the status line and the picker until the
    // panel was reloaded (R4-4).
    const title = artboardTitle(page);
    if (board.label.textContent !== title) { board.label.textContent = title; }
    board.frame?.setAttribute('title', title);
    // Same reason the title is rewritten here rather than at creation: a format
    // change is a `page.setMeta` and plans `structure`, so this is the one path
    // that runs on every reformat.
    if (board.formatTag) {
      const dims = `${Math.round(format.width)} × ${Math.round(format.height)}`;
      if (board.formatTag.textContent !== dims) { board.formatTag.textContent = dims; }
    }
    board.root.style.setProperty('position', 'absolute');
    board.root.style.setProperty('left', `${page.boardPos.x}px`);
    board.root.style.setProperty('top', `${page.boardPos.y}px`);
    board.root.style.setProperty('width', `${format.width}px`);
    board.surface.style.setProperty('width', `${format.width}px`);
    board.surface.style.setProperty('height', `${format.height}px`);
    board.surface.style.setProperty('position', 'relative');
    board.surface.style.setProperty('overflow', 'hidden');
    for (const [name, value] of Object.entries(themeCssVars(artifact.theme))) {
      board.root.style.setProperty(name, value);
    }
    if (board.frame) {
      board.frame.style.setProperty('width', `${format.width}px`);
      board.frame.style.setProperty('height', `${format.height}px`);
    }
    // The iframe ELEMENT box is only half of a device change. The page box is
    // baked into the srcdoc by `buildBaseCss`, so resizing the element alone
    // crops an unchanged 1440px document to 390px and the human concludes the
    // responsive design is broken - while the static preview tile beside it,
    // which has no baked width, reflows correctly. Push the new format down the
    // EXISTING port carrying NOTHING BUT THE FORMAT, so the frame outlives the
    // resize exactly as it outlives an edit. A `doc` here would be a second
    // description of whatever element ops rode the same batch (R4-1) and would
    // discard the human's in-flight inline edit (R4-2) - see {@link _pushTheme}.
    const key = formatKey(format);
    if (board.port && board.sentFormat !== key) {
      board.sentFormat = key;
      this._send(board, { t: 'mount', format: wireFormat(format) });
    }
  }

  private _resizeAll(): void {
    const artifact = this._artifact;
    if (!artifact) { return; }
    for (const page of artifact.pages) {
      const board = this._boards.get(page.id);
      if (board) { this._layout(board, page); }
    }
  }

  /* ------------------------------- rendering ------------------------------- */

  private _page(pageId: string): ArtifactPage | null {
    return this._artifact?.pages.find(p => p.id === pageId) ?? null;
  }

  private _previewOptions(): PreviewOptions {
    return { resolveAsset: this._resolveAsset, markMids: true };
  }

  private _drawPreview(board: Artboard): void {
    const page = this._page(board.pageId);
    if (!page) { return; }
    try {
      drawPreview(board.previewHost, page.doc, this._env.doc, this._previewOptions());
    } catch (err) {
      this._env.warn('canvas: preview render failed', board.pageId, err);
    }
  }

  /**
   * A theme change is TOKENS ONLY - never a document.
   *
   * `CanvasStore.applyOps` folds the whole `canvas/ops` batch into `page.doc`
   * before the board is called, so a `doc` sent from here would carry the
   * POST-op tree; the patch loop below then applies the same element ops on top
   * of it and the frame paints them twice, with two nodes sharing one mid and
   * `plan.resync` false, so nothing repairs it (R4-1). It would also destroy
   * the human's in-flight inline edit, because the harness's `mount` begins by
   * reverting a `contenteditable` node to its pre-edit text (R4-2).
   *
   * Neither costs anything to avoid: tokens are CSS custom properties, so the
   * frame re-paints without re-rendering, and its tree is already correct.
   */
  private _pushTheme(): void {
    const artifact = this._artifact;
    if (!artifact) { return; }
    const vars = themeCssVars(artifact.theme);
    const tokens = themeTokenMap(artifact.theme);
    for (const board of this._boards.values()) {
      for (const [name, value] of Object.entries(vars)) {
        board.root.style.setProperty(name, value);
      }
      if (board.port) { this._send(board, { t: 'mount', themeTokens: tokens }); }
      this._drawPreview(board);
    }
  }

  /* ---------------------------- live frame mount ---------------------------- */

  private _onIntersect(entries: readonly { target: DomElement; isIntersecting: boolean }[]): void {
    for (const entry of entries) {
      for (const board of this._boards.values()) {
        if (board.root === entry.target) { board.intersecting = entry.isIntersecting; }
      }
    }
    this._reconcileModes();
  }

  /**
   * Recompute live/preview for every artboard. Called on zoom, on pan, on
   * scroll (via the observer) and when the runtime lands - never as part of a
   * content edit, which is exactly why a content edit cannot cost a frame
   * rebuild.
   *
   * ## Frames are RETAINED, not churned
   *
   * A frame that scrolls out of view is NOT torn down. It stays live until its
   * slot is needed, and the coldest unwanted frame is evicted only when the
   * budget is actually exhausted ({@link _evictColdest}). That is the
   * difference between virtualization and thrashing: panning right and back
   * again must cost zero rebuilds, because a rebuild is a fresh React root -
   * scroll position, hover, focus, input values and animation all die with it,
   * which is precisely what Phase 2 existed to stop.
   *
   * The zoom gate is the one exception and is deliberately NOT retained: at 0.1x
   * an artboard is a thumbnail, and holding eight live React trees to render
   * eight thumbnails is the O(pages) cost virtualization exists to avoid. Below
   * the threshold every frame drops to a static preview immediately.
   */
  private _reconcileModes(): void {
    if (this._disposed || !this._view) { return; }
    this._tick++;
    // Deterministic order so the frame budget goes to the same artboards on
    // every pass rather than oscillating with Map iteration timing.
    const ordered = (this._artifact?.pages ?? [])
      .map(p => ({ page: p, board: this._boards.get(p.id) }))
      .filter((e): e is { page: ArtifactPage; board: Artboard } => !!e.board);

    const runtimeReady = !!this._runtime;
    if (!runtimeReady || this._transform.zoom < this._liveZoom) {
      for (const { board } of ordered) { if (board.mode === 'live') { this._unmountFrame(board); } }
      return;
    }

    const desired = new Set<Artboard>();
    for (const { page, board } of ordered) {
      const want = decideMode({
        intersecting: this._observer ? board.intersecting : this._geometryVisible(page),
        zoom: this._transform.zoom,
        liveZoomThreshold: this._liveZoom,
        liveCount: desired.size,
        maxLive: this._maxLive,
        runtimeReady,
      });
      if (want === 'live') { desired.add(board); board.lastSeen = this._tick; }
    }

    for (const board of desired) {
      if (board.mode === 'live') { continue; }
      if (this.liveCount >= this._maxLive && !this._evictColdest(desired)) { break; }
      this._mountFrame(board);
    }
    // A budget that shrank (or a burst of mounts) can leave retained frames
    // over the cap; drop the coldest until it fits.
    while (this.liveCount > this._maxLive) {
      if (!this._evictColdest(desired)) { break; }
    }
  }

  /** Unmount the least-recently-wanted live frame outside `keep`. */
  private _evictColdest(keep: ReadonlySet<Artboard>): boolean {
    let victim: Artboard | null = null;
    for (const board of this._boards.values()) {
      if (board.mode !== 'live' || keep.has(board)) { continue; }
      if (!victim || board.lastSeen < victim.lastSeen) { victim = board; }
    }
    if (!victim) { return false; }
    this._unmountFrame(victim);
    return true;
  }

  /**
   * Fallback visibility when no `IntersectionObserver` exists (older hosts,
   * and every headless test). Pure geometry through `boardMath`, so the two
   * paths cannot disagree about what "on screen" means.
   */
  private _geometryVisible(page: ArtifactPage): boolean {
    const artifact = this._artifact;
    const view = this._view;
    if (!artifact || !view) { return false; }
    const format = effectiveFormat(artifact, page, view);
    const rect: Rect = { x: page.boardPos.x, y: page.boardPos.y, w: format.width, h: format.height };
    return isVisible(rect, this._measureViewport(), this._transform, LIVE_PREMOUNT_MARGIN_PX);
  }

  private _mountFrame(board: Artboard): void {
    const page = this._page(board.pageId);
    const artifact = this._artifact;
    const view = this._view;
    if (!page || !artifact || !view || !this._runtime) { return; }

    const frame = this._env.doc.createElement('iframe');
    // No `allow-same-origin`: model-authored source must never reach this
    // document's origin, the token, or `acquireVsCodeApi`.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', artboardTitle(page));
    // An `<iframe>` is a native tab stop. Without this every mounted artboard
    // sits in sequential navigation between `#board-scroll` and the zoom
    // controls, so one Shift+Tab past the zoom buttons drops focus INSIDE a
    // sandboxed, model-authored document — where keydown fires in the frame's
    // own document and never reaches the parent, making Escape, the zoom keys
    // and the pane toggles all dead. Escaping then means Tabbing through every
    // focusable node the generated design happens to contain, per artboard,
    // with no indication of where you are. `-1` leaves sequential navigation
    // without changing anything else: the frame stays scriptable and
    // pointer-interactive, and the documented entry point remains
    // `#board-scroll` plus its element walk.
    frame.setAttribute('tabindex', '-1');
    frame.className = 'artboard-frame';
    frame.style.setProperty('border', '0');
    frame.style.setProperty('position', 'absolute');
    frame.style.setProperty('inset', '0');
    frame.addEventListener('load', () => this._openPort(board));
    board.frame = frame;
    board.mode = 'live';
    board.builds++;
    frame.srcdoc = this._frameDocument(page);
    board.surface.appendChild(frame);
    this._layout(board, page);
  }

  private _frameDocument(page: ArtifactPage): string {
    const artifact = this._artifact;
    const view = this._view;
    const runtime = this._runtime;
    if (!artifact || !view || !runtime) { return ''; }
    return buildFrameDocument({
      page,
      theme: artifact.theme,
      format: effectiveFormat(artifact, page, view),
      runtime,
      resolveAsset: ref => this._resolveAsset(ref) ?? ref,
      imgSources: this._imgSources,
      nonce: this._frameNonce,
    });
  }

  /** How many artboards currently hold a live frame. Diagnostics only. */
  liveFrameCount(): number {
    let n = 0;
    for (const board of this._boards.values()) { if (board.frame) { n++; } }
    return n;
  }

  /** A `reload` plan entry: same element, new document. No DOM churn. */
  private _rebuildFrame(board: Artboard): void {
    const page = this._page(board.pageId);
    if (!page || !board.frame) { return; }
    this._closePort(board);
    board.builds++;
    board.frame.srcdoc = this._frameDocument(page);
  }

  private _unmountFrame(board: Artboard): void {
    this._teardown(board);
    board.mode = 'preview';
    this._drawPreview(board);
  }

  private _teardown(board: Artboard): void {
    this._closePort(board);
    if (board.frame) { board.frame.remove(); board.frame = null; }
  }

  private _closePort(board: Artboard): void {
    // An authorisation is scoped to the channel it was granted on; a new port
    // starts with none, so a rebuilt frame cannot inherit a stale one. The same
    // reasoning applies to the format: a frame with no port has been told
    // nothing, so nothing may be assumed about the box it is laid out at.
    board.editMids = [];
    board.sentFormat = null;
    if (!board.port) { return; }
    board.port.onmessage = null;
    try { board.port.close(); } catch { /* already closed */ }
    board.port = null;
  }

  /**
   * Is this artboard's frame allowed to hold the privileged port?
   *
   * Read from the CURRENT page on every use rather than cached at mount, so a
   * page that becomes `legacy` after its port opened stops being trusted
   * immediately instead of keeping a grant it no longer qualifies for.
   */
  private _isTrustedChannel(board: Artboard): boolean {
    const page = this._page(board.pageId);
    return !!page && isTrustedFrameChannel(page);
  }

  /**
   * Hand the frame one end of a dedicated `MessageChannel`. From here the frame
   * has a private, structurally distinct channel: nothing it posts at `window`
   * can be confused with a host message (see `protocolClient.receive`).
   *
   * **Only a document-first artboard gets one** (P1). A `legacy` frame runs
   * model-authored script in the same realm as the harness, and the port is
   * transferred through that frame's `window`, so page script could read it off
   * the handshake event (or bind it first by cancelling the event) and then post
   * `hit{double:true}` + `textCommit` — an `el.setText` the bridge stamps
   * `author:'user'` with `'auto'` approval. Authorship is a property of the
   * channel, so the channel is simply not created. See
   * {@link isTrustedFrameChannel} for why a legacy artboard loses nothing.
   */
  private _openPort(board: Artboard): void {
    const page = this._page(board.pageId);
    if (!board.frame || !page) { return; }
    if (!isTrustedFrameChannel(page)) {
      // Tear down before refusing, so a page that turned legacy can never keep
      // a channel it was granted while it still qualified for one.
      this._closePort(board);
      this._env.warn('canvas: no frame port for a legacy artboard', board.pageId);
      return;
    }
    const target = board.frame.contentWindow;
    if (!target) { return; }
    this._closePort(board);

    const channel = this._env.createMessageChannel();
    const port = channel.port1;
    port.onmessage = ev => this._onFrameMessage(board, ev.data);
    port.start();
    board.port = port;
    target.postMessage(frameHandshakeMessage(), '*', [channel.port2]);

    const artifact = this._artifact;
    const view = this._view;
    const format = artifact && view ? effectiveFormat(artifact, page, view) : null;
    board.sentFormat = format ? formatKey(format) : null;
    // THE state transfer, and the only `mount` that carries a document: it is
    // read off the CURRENT doc, so every op that landed while the frame was
    // loading is already in it. Replaying those ops as a patch on top would be
    // a second description of the same edit (R4-1).
    this._send(board, {
      t: 'mount',
      doc: page.doc,
      themeTokens: artifact ? themeTokenMap(artifact.theme) : undefined,
      format: format ? wireFormat(format) : undefined,
    });
    // A newly mounted frame does not know what the human has selected; ask it
    // to re-measure so the parent overlay lands on the right boxes.
    if (this._selection.pageId === board.pageId && this._selection.mids.length > 0) {
      this._send(board, { t: 'select', mids: [...this._selection.mids] });
    }
  }

  private _send(board: Artboard, message: FrameDownMessage): void {
    if (!board.port) { return; }
    try { board.port.postMessage(message); }
    catch (err) { this._env.warn('canvas: frame port post failed', board.pageId, err); return; }
    // The parent opening an inline edit is the ONLY thing that makes a later
    // `textCommit` for that node committable (P2). Recorded here, at the single
    // point every down-message passes through, so no caller can bypass it.
    if (message.t === 'beginTextEdit') { this._authorizeEdit(board, message.mid); }
  }

  private _authorizeEdit(board: Artboard, mid: Mid): void {
    board.editMids = board.editMids.filter(m => m !== mid);
    board.editMids.push(mid);
    while (board.editMids.length > AUTHORIZED_EDIT_TAIL) { board.editMids.shift(); }
  }

  private _sendSelect(pageId: string, mids: readonly Mid[]): void {
    const board = this._boards.get(pageId);
    if (board?.port) { this._send(board, { t: 'select', mids: [...mids] }); }
  }

  /**
   * Frame to parent. Everything here is untrusted, model-authored data, so it
   * is normalized and capped by the SAME validator the host uses
   * ({@link parseFrameUpMessage}) before any callback sees it. Authorization -
   * does this frame own that page, does that mid exist, is that cell pinned -
   * remains the executor's job, exactly as for any other writer.
   */
  private _onFrameMessage(board: Artboard, data: unknown): void {
    const message = parseFrameUpMessage(data);
    if (!message) { return; }
    // Defence in depth behind `_openPort` (P1): a page that turned `legacy`
    // after its port opened is model-authored script holding a channel the
    // parent would never grant it now. Nothing it says is accepted.
    if (!this._isTrustedChannel(board)) {
      this._env.warn('canvas: dropped a frame message from an untrusted artboard', board.pageId, message.t);
      return;
    }
    switch (message.t) {
      case 'ready':
        this._callbacks.onFrameReady?.(board.pageId);
        return;
      case 'hit': {
        this._rememberRect(board.pageId, message.mid, message.rect);
        this._setSelection(applyHit(this._selection, board.pageId, message.mid, message.modifiers));
        if (message.double) { this._callbacks.onBeginTextEdit?.(board.pageId, message.mid); }
        this._callbacks.onHit?.(board.pageId, message.mid);
        return;
      }
      case 'textCommit':
        // P2: the frame is not the witness to its own authorisation. Only a
        // node the PARENT opened an edit on can be committed; a frame that
        // fabricates `hit{double}` + `textCommit` for an arbitrary mid gets
        // nothing, because `hit` alone never authorises a commit.
        if (!board.editMids.includes(message.mid)) {
          this._env.warn('canvas: dropped a text commit the parent never opened', board.pageId, message.mid);
          return;
        }
        this._callbacks.onTextCommit?.(board.pageId, message.mid, message.text);
        return;
      case 'size':
        this._callbacks.onSize?.(board.pageId, { w: message.w, h: message.h });
        return;
      case 'error':
        this._callbacks.onFrameError?.(board.pageId, message.message, message.mid);
        return;
      case 'rects':
        this._mergeRects(board.pageId, message.rects);
        this._drawOverlay();
        return;
      case 'wheel':
        // The pointer was over an artboard, so the frame received the wheel
        // instead of the board and forwarded it. Treat it exactly as if it had
        // landed on the viewport — same intent mapping, same anchor rules — so
        // zoom and pan behave identically wherever the cursor happens to be.
        this._onForwardedWheel(board, message);
        return;
      default: {
        const never: never = message;
        void never;
      }
    }
  }

  /* ------------------------------- geometry ------------------------------- */

  private _rectsFor(pageId: string): Map<Mid, Rect> {
    const existing = this._rects.get(pageId);
    if (existing) { return existing; }
    const created = new Map<Mid, Rect>();
    this._rects.set(pageId, created);
    return created;
  }

  private _rememberRect(pageId: string, mid: Mid, rect: Rect): void {
    const map = this._rectsFor(pageId);
    if (map.size >= MAX_CACHED_RECTS && !map.has(mid)) { map.clear(); }
    map.set(mid, rect);
  }

  /**
   * Merge, never replace: a `select`-triggered report carries ONLY the selected
   * mids, so overwriting the map would erase the geometry the marquee needs.
   * Stale entries are bounded by {@link MAX_CACHED_RECTS} and by page removal.
   */
  private _mergeRects(pageId: string, rects: Record<Mid, Rect>): void {
    const map = this._rectsFor(pageId);
    for (const [mid, rect] of Object.entries(rects)) {
      if (map.size >= MAX_CACHED_RECTS && !map.has(mid)) { map.clear(); }
      map.set(mid, rect);
    }
  }

  private _contentBounds(): Rect | null {
    const artifact = this._artifact;
    const view = this._view;
    if (!artifact || !view) { return null; }
    return contentBounds(artifact.pages.map(page => {
      const format = effectiveFormat(artifact, page, view);
      return { x: page.boardPos.x, y: page.boardPos.y, w: format.width, h: format.height };
    }));
  }

  private _defaultViewportSize(): Size {
    const host = this._viewportHost as MeasurableLike | null;
    if (host && typeof host.clientWidth === 'number' && typeof host.clientHeight === 'number'
      && host.clientWidth > 0 && host.clientHeight > 0) {
      return { width: host.clientWidth, height: host.clientHeight };
    }
    const g = globalThis as { innerWidth?: number; innerHeight?: number };
    if (typeof g.innerWidth === 'number' && typeof g.innerHeight === 'number') {
      return { width: g.innerWidth, height: g.innerHeight };
    }
    return { width: 0, height: 0 };
  }

  /**
   * Measure the board AND remember it.
   *
   * `_lastViewport` is the "before" half of {@link preserveCenter}, so every
   * measurement that precedes a transform decision has to update it - not just
   * the resize pass. Without this, the FIRST resize after a human zoomed had no
   * baseline to compare against and silently skipped the preservation, which is
   * exactly the resize where a jump is most visible.
   */
  private _viewport(): Size {
    const size = this._measureViewport();
    this._lastViewport = { width: size.width, height: size.height };
    return size;
  }

  private _defaultLayoutWidth(): number {
    const host = this._layoutHost as MeasurableLike | null;
    if (host && typeof host.clientWidth === 'number' && host.clientWidth > 0) {
      return host.clientWidth;
    }
    const g = globalThis as { innerWidth?: number };
    if (typeof g.innerWidth === 'number' && g.innerWidth > 0) { return g.innerWidth; }
    return this._measureViewport().width;
  }

  /* -------------------------------- resize -------------------------------- */

  /**
   * Coalesce every resize signal into one measurement per frame.
   *
   * `ResizeObserver` fires per observed element, a window `resize` fires
   * independently, and a pane toggle schedules one itself - a drag can produce
   * dozens per frame. They all land here, and the flag means the panel is
   * measured once and the transform written once, no matter how many arrived.
   */
  private _scheduleResize(): void {
    if (this._disposed || this._resizeScheduled) { return; }
    this._resizeScheduled = true;
    this._scheduleFrame(() => this._flushResize());
  }

  /**
   * THE resize pass. Note what it does NOT do: touch a single frame.
   *
   * The old shell rebuilt every iframe on `window.resize` - 3.14 MB of runtime
   * re-inlined per artboard, and scroll, focus, hover and animation lost with
   * it. Here a resize is a transform write plus a live/preview re-evaluation.
   * A frame outlives the resize exactly as it outlives an edit (Phase 2).
   */
  private _flushResize(): void {
    this._resizeScheduled = false;
    if (this._disposed) { return; }
    const modeChanged = this._evaluateLayout();
    const before = this._lastViewport;
    const after = this._viewport();
    const sizeChanged = !before || before.width !== after.width || before.height !== after.height;
    if (!sizeChanged && !modeChanged) { return; }

    if (!this._userAdjusted) {
      // Still auto: re-frame the design at the new size / new breakpoint.
      this.zoomToFit();
    } else if (before && sizeChanged) {
      // The human owns this viewport. Keep what is under the centre exactly
      // where it is, so a resize slides nothing out from under them.
      this._setTransform(preserveCenter(this._transform, before, after));
    }
    // A viewport that grew can reveal artboards whose transform never moved,
    // so this runs even when `_setTransform` decided nothing changed.
    this._reconcileModes();
  }

  /** Measure the panel, apply hysteresis, publish on a change. */
  private _evaluateLayout(): boolean {
    const width = this._measureLayoutWidth();
    if (!(width > 0)) { return false; }
    const next = decideLayoutMode(width, this._layoutMeasured ? this._layoutMode : null);
    this._layoutMeasured = true;
    if (next === this._layoutMode) { return false; }
    const previous = this._layoutMode;
    this._layoutMode = next;
    // A pane whose default just changed is a different kind of thing at this
    // width, so the human's toggle no longer describes an intent about it; a
    // pane that stayed put keeps their choice.
    this._paneOverride = carryOverride(previous, next, this._paneOverride);
    this._panes = resolvePanes(next, this._paneOverride);
    this._emitLayout();
    return true;
  }

  private _emitLayout(): void {
    this._callbacks.onLayoutChange?.(this.layout);
  }

  /** Screen point relative to the viewport host's top-left corner. */
  private _localPoint(ev: PointerLike): Point {
    const host = this._viewportHost as MeasurableLike | null;
    let left = 0, top = 0;
    if (host && typeof host.getBoundingClientRect === 'function') {
      try {
        const box = host.getBoundingClientRect();
        left = typeof box?.left === 'number' ? box.left : 0;
        top = typeof box?.top === 'number' ? box.top : 0;
      } catch { /* not a real element */ }
    }
    const x = typeof ev?.clientX === 'number' ? ev.clientX : 0;
    const y = typeof ev?.clientY === 'number' ? ev.clientY : 0;
    return { x: x - left, y: y - top };
  }

  /* ------------------------------- transform ------------------------------- */

  /**
   * Fold the app's view state in — WITHOUT letting a stale copy of it move the
   * viewport.
   *
   * The board is the owner of pan, zoom and selection (§3.5: view state is
   * local and sovereign). The app also holds a `CanvasViewState`, and it will
   * hand it back on every device switch, rail click and resync. If that copy
   * were adopted verbatim, every one of those unrelated interactions would
   * silently snap the human's viewport back to wherever the app last thought it
   * was — the same class of bug as `canvas.js:274` `Object.assign`ing the
   * device selection away.
   *
   * So pan/zoom are adopted only when the app actually CHANGED them, measured
   * against the last value the app itself supplied. A gesture inside the board
   * never updates that baseline, so a stale echo compares equal and is ignored,
   * while a deliberate `setZoom` from the app compares different and wins.
   * Selection is not read out of the view at all.
   */
  private _adoptView(view: CanvasViewState): void {
    const zoomIsNew = this._appZoom === null || view.zoom !== this._appZoom;
    const panIsNew = this._appPan === null
      || view.pan.x !== this._appPan.x || view.pan.y !== this._appPan.y;
    const zoom = zoomIsNew ? clampZoom(view.zoom) : this._transform.zoom;
    const pan = panIsNew
      ? { x: finiteOr(view.pan.x, 0), y: finiteOr(view.pan.y, 0) }
      : { ...this._transform.pan };
    // An app that MOVED the viewport (not merely echoed one back) is the human
    // acting through some other control, so it leaves auto-fit exactly as a
    // wheel-zoom does. Measured against the board's ACTUAL transform, not
    // against `_appZoom`: an app whose copy is stale re-supplies a value the
    // board already has, and adopting that is not a gesture. The first adopt is
    // the initial state, not a gesture either.
    const moves = (zoom !== this._transform.zoom)
      || pan.x !== this._transform.pan.x || pan.y !== this._transform.pan.y;
    if (this._appZoom !== null && moves) { this._userAdjusted = true; }
    // Remember what the app SAID, verbatim - that is the baseline a later echo
    // is compared against, and it must not be the value we clamped it to.
    this._appZoom = view.zoom;
    this._appPan = { x: view.pan.x, y: view.pan.y };
    this._transform = normalizeTransform({ zoom, pan });
    this._view = { ...view, zoom: this._transform.zoom, pan: { ...this._transform.pan } };
  }

  private _setTransform(next: BoardTransform): void {
    if (this._disposed) { return; }
    const normalized = normalizeTransform(next);
    const same = normalized.zoom === this._transform.zoom
      && normalized.pan.x === this._transform.pan.x
      && normalized.pan.y === this._transform.pan.y;
    this._transform = normalized;
    if (this._view) {
      this._view = { ...this._view, zoom: normalized.zoom, pan: { ...normalized.pan } };
    }
    this._applyTransform();
    if (same) { return; }
    this._reconcileModes();
    this._drawOverlay();
    if (this._view) { this._callbacks.onViewChange?.(this._view); }
  }

  /**
   * Sample frame times for the duration of a gesture.
   *
   * This is what turns "it feels slow" into a number the user can report and a
   * regression a test can catch — and it runs in whatever host the panel is
   * actually in, which is the environment no harness could reach. Chromium
   * measures a solid 60fps with 8 live frames; if the real editor does not,
   * this is what says so.
   */
  private _startGestureSampling(): void {
    if (this._gestureRaf !== null) { return; }
    const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number };
    if (typeof g.requestAnimationFrame !== 'function') { return; }
    this._gestureFrames = [];
    this._gestureLast = 0;
    const tick = (t: number): void => {
      if (this._gestureLast > 0) { this._gestureFrames.push(t - this._gestureLast); }
      this._gestureLast = t;
      if (this._gestureRaf === null) { return; }
      this._gestureRaf = g.requestAnimationFrame!(tick);
    };
    this._gestureRaf = g.requestAnimationFrame(tick);
  }

  private _stopGestureSampling(): void {
    const g = globalThis as { cancelAnimationFrame?: (h: number) => void };
    if (this._gestureRaf !== null && typeof g.cancelAnimationFrame === 'function') {
      g.cancelAnimationFrame(this._gestureRaf);
    }
    this._gestureRaf = null;
    const frames = this._gestureFrames;
    // Too few samples to say anything honest about.
    if (frames.length < 8) { return; }
    const sorted = [...frames].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.floor(sorted.length * q)] ?? 0;
    this._lastGestureStats = {
      p50: Math.round(at(0.5) * 10) / 10,
      p95: Math.round(at(0.95) * 10) / 10,
      dropped: frames.filter(f => f > 20).length,
    };
    this._callbacks.onGestureStats?.(this._lastGestureStats);
  }

  /** Frame stats from the last completed gesture, if there has been one. */
  get gestureStats(): { p50: number; p95: number; dropped: number } | null {
    return this._lastGestureStats;
  }

  /**
   * Reflect what the pointer can do right now.
   *
   * `grab` while space is held, `grabbing` mid-pan. The board had NO cursor
   * rule of any kind, so pan was both undiscoverable and unconfirmed — the
   * class of gap that makes an interaction feel unresponsive independently of
   * how fast it renders.
   */
  /**
   * Ease a DISCRETE zoom change instead of snapping.
   *
   * The +/- buttons, Cmd +/-/0 and zoom-to-fit all jumped instantly. A jump
   * reads as jarring rather than fast, and it also destroys the user's sense of
   * where they are on the board — Figma eases these, which is most of why its
   * zoom feels considered. Continuous gestures (wheel, pinch) are deliberately
   * NOT eased: they are already smooth by virtue of arriving continuously, and
   * easing them would add lag to the one path where lag is felt most.
   *
   * Any new gesture cancels the animation, so easing can never fight the user.
   */
  private _animateTo(target: BoardTransform, ms = 140): void {
    const g = globalThis as {
      requestAnimationFrame?: (cb: (t: number) => void) => number;
      cancelAnimationFrame?: (h: number) => void;
    };
    this._cancelAnimation();
    const from = this._transform;
    const to = normalizeTransform(target);
    if (typeof g.requestAnimationFrame !== 'function' || ms <= 0) { this._setTransform(to); return; }

    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = (now: number): void => {
      const elapsed = Math.max(0, now - start);
      const t = Math.min(1, elapsed / ms);
      // easeOutCubic: fast to start, settles gently — the shape that reads as
      // "responsive" rather than "floaty".
      const e = 1 - Math.pow(1 - t, 3);
      this._setTransform({
        zoom: from.zoom + (to.zoom - from.zoom) * e,
        pan: { x: from.pan.x + (to.pan.x - from.pan.x) * e, y: from.pan.y + (to.pan.y - from.pan.y) * e },
      });
      if (t >= 1) { this._zoomRaf = null; return; }
      this._zoomRaf = g.requestAnimationFrame!(step);
    };
    this._zoomRaf = g.requestAnimationFrame(step);
  }

  private _cancelAnimation(): void {
    const g = globalThis as { cancelAnimationFrame?: (h: number) => void };
    if (this._zoomRaf !== null && typeof g.cancelAnimationFrame === 'function') {
      g.cancelAnimationFrame(this._zoomRaf);
    }
    this._zoomRaf = null;
  }

  /**
   * Apply a wheel that a frame forwarded.
   *
   * The frame reports the position in ITS OWN css pixels (design-space, since
   * the page is laid out at the artboard's real size). Converting through the
   * artboard's world position and the board transform puts the anchor exactly
   * under the physical cursor — otherwise zooming over an artboard would drift
   * toward the viewport centre, which feels worse than not zooming at all.
   */
  private _onForwardedWheel(
    board: Artboard,
    msg: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; x: number; y: number },
  ): void {
    const page = this._page(board.pageId);
    if (!page) { return; }
    const world = { x: page.boardPos.x + msg.x, y: page.boardPos.y + msg.y };
    const anchor = worldToScreen(world, this._transform);
    const intent = wheelIntent({
      deltaX: msg.deltaX, deltaY: msg.deltaY, deltaMode: msg.deltaMode,
      ctrlKey: msg.ctrlKey, metaKey: msg.metaKey,
    });
    this._cancelAnimation();
    this._userAdjusted = true;
    if (intent.kind === 'zoom') {
      this._setTransform(zoomBy(this._transform, intent.factor, anchor));
    } else {
      this._setTransform(panBy(this._transform, intent.dx, intent.dy));
    }
  }

  private _setCursorState(): void {
    const host = this._viewportHost as unknown as {
      classList?: { toggle(name: string, on: boolean): void };
    } | null;
    const panning = this._panFrom !== null;
    if (host?.classList) {
      host.classList.toggle('panning', panning);
      host.classList.toggle('can-pan', !panning && this._spaceHeld);
      host.classList.toggle('marqueeing', this._marqueeActive);
    }
    // An artboard iframe swallows pointer events, so a space-drag that STARTED
    // over one never reached the board and panning simply did not work there.
    // Taking pointer events away from the world while space is held routes
    // every pointer event to the viewport — the same mechanism the marquee
    // already uses to cross live frames. Restored the instant space is
    // released, so clicking into a design keeps working.
    const passThrough = this._spaceHeld || panning || this._marqueeActive;
    this._world.style.setProperty('pointer-events', passThrough ? 'none' : '');
  }

  private _applyTransform(): void {
    const { zoom, pan } = this._transform;
    this._world.style.setProperty('transform-origin', '0 0');
    this._world.style.setProperty('transform', `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`);
    const label = this._env.doc.getElementById(BOARD_ZOOM_LEVEL_ID);
    if (label) { label.textContent = `${Math.round(zoom * 100)}%`; }
  }

  private _zoomPreset(dir: 1 | -1): void {
    const size = this._viewport();
    const anchor = { x: size.width / 2, y: size.height / 2 };
    const next = zoomPresetStep(this._transform.zoom, dir);
    this._animateTo(zoomBy(this._transform, next / this._transform.zoom, anchor));
  }

  /* ------------------------------- selection ------------------------------- */

  private _setSelection(next: SelectionState): void {
    if (selectionEquals(this._selection, next)) { this._drawOverlay(); return; }
    const previous = this._selection;
    this._selection = next;
    if (previous.pageId && previous.pageId !== next.pageId) { this._sendSelect(previous.pageId, []); }
    if (next.pageId) { this._sendSelect(next.pageId, next.mids); }
    this._drawOverlay();
    this._callbacks.onSelectionChange?.(this.selection);
  }

  /**
   * The ONLY effect an incoming edit may have on selection: drop mids that no
   * longer exist. It cannot select, re-target, reorder, or move the viewport.
   */
  private _pruneSelection(): void {
    const pages = this._artifact?.pages ?? [];
    const pruned = pruneSelection(this._selection, pages);
    if (selectionEquals(pruned, this._selection)) { return; }
    this._selection = pruned;
    this._callbacks.onSelectionChange?.(this.selection);
  }

  private _drawOverlay(): void {
    const overlay = this._overlay;
    if (!overlay) { return; }
    overlay.setMarquee(this._marqueeActive ? this._marqueeRect : null);
    const selection = this._selection;
    if (!selection.pageId || selection.mids.length === 0) { overlay.render([]); return; }
    const page = this._page(selection.pageId);
    const rects = this._rects.get(selection.pageId);
    if (!page || !rects) { overlay.render([]); return; }
    const anchor = selectionAnchor(selection);
    const boxes: OverlayBox[] = [];
    for (const mid of selection.mids) {
      const rect = rects.get(mid);
      if (!rect) { continue; }
      boxes.push({
        mid,
        rect: elementScreenRect(rect, page.boardPos, this._transform),
        primary: mid === anchor,
      });
    }
    overlay.render(boxes);
  }

  /** Every measured element on a page, as screen rects. Marquee input. */
  private _marqueeCandidates(pageId: string): MarqueeCandidate[] {
    const page = this._page(pageId);
    const rects = this._rects.get(pageId);
    if (!page || !rects) { return []; }
    const out: MarqueeCandidate[] = [];
    for (const [mid, rect] of rects) {
      if (mid === page.doc.mid) { continue; }        // never marquee the artboard root
      out.push({ mid, rect: elementScreenRect(rect, page.boardPos, this._transform) });
    }
    return out;
  }

  /** The artboard a screen point falls on, topmost-last wins. */
  private _pageAt(point: Point): string | null {
    const artifact = this._artifact;
    const view = this._view;
    if (!artifact || !view) { return null; }
    const world = screenToWorld(point, this._transform);
    let found: string | null = null;
    for (const page of artifact.pages) {
      const format = effectiveFormat(artifact, page, view);
      if (world.x >= page.boardPos.x && world.x <= page.boardPos.x + format.width
        && world.y >= page.boardPos.y && world.y <= page.boardPos.y + format.height) {
        found = page.id;
      }
    }
    return found;
  }

  /* --------------------------------- input --------------------------------- */

  /*
   * Listeners are bound ONCE and never removed: `dom.ts` deliberately exposes
   * no `removeEventListener` (it is the seam a fake DOM has to implement), so
   * every handler early-returns on `_disposed` instead. A disposed board is
   * inert, just not unsubscribed.
   */
  private _bindInput(): void {
    const viewport = this._viewportHost;
    if (viewport) {
      viewport.addEventListener('wheel', ev => this._onWheel(ev));
      viewport.addEventListener('pointerdown', ev => this._onPointerDown(ev));
      viewport.addEventListener('click', ev => this._onClick(ev));
      viewport.addEventListener('dblclick', ev => this._onDoubleClick(ev));
    }
    const self = this._env.self;
    self.addEventListener('pointermove', ev => this._onPointerMove(ev));
    self.addEventListener('pointerup', ev => this._onPointerUp(ev));
    self.addEventListener('pointercancel', () => this._endGesture());
    self.addEventListener('keydown', ev => this._onKeyDown(ev));
    self.addEventListener('keyup', ev => this._onKeyUp(ev));
    self.addEventListener('blur', () => { this._spaceHeld = false; this._endGesture(); });
    // A belt for hosts with no `ResizeObserver`, and harmless where there is
    // one: `_scheduleResize` coalesces both into the same frame.
    self.addEventListener('resize', () => this._scheduleResize());

    this._el(BOARD_ZOOM_IN_ID)?.addEventListener('click', () => this.zoomIn());
    this._el(BOARD_ZOOM_OUT_ID)?.addEventListener('click', () => this.zoomOut());
    this._el(BOARD_ZOOM_FIT_ID)?.addEventListener('click', () => this.zoomToFit({ animate: true }));
  }

  private _el(id: string): DomElement | null { return this._env.doc.getElementById(id); }

  private _onWheel(raw: unknown): void {
    if (this._disposed) { return; }
    const ev = raw as WheelLike & PointerLike;
    const intent = wheelIntent(ev);
    // The board owns this gesture entirely; letting it fall through would
    // scroll the shell (or the whole webview) out from under the world.
    ev?.preventDefault?.();
    this._cancelAnimation();
    this._userAdjusted = true;
    if (intent.kind === 'zoom') {
      this._setTransform(zoomBy(this._transform, intent.factor, this._localPoint(ev)));
    } else {
      this._setTransform(panBy(this._transform, intent.dx, intent.dy));
    }
  }

  private _onPointerDown(raw: unknown): void {
    this._cancelAnimation();
    this._startGestureSampling();
    if (this._disposed) { return; }
    const ev = raw as PointerLike;
    const button = typeof ev?.button === 'number' ? ev.button : 0;
    if (button === 1 || (button === 0 && this._spaceHeld)) {
      this._userAdjusted = true;
      this._panFrom = this._localPoint(ev);
      this._panOrigin = this._transform;
      this._setCursorState();
      ev?.preventDefault?.();
      return;
    }
    if (button !== 0) { return; }
    // A marquee only BEGINS here. The world keeps its pointer events until the
    // drag passes the threshold, so a plain click still reaches preview content.
    this._marqueeFrom = this._localPoint(ev);
    this._marqueeMods = modifiersOf(ev);
    this._marqueeActive = false;
    this._marqueeRect = null;
  }

  private _onPointerMove(raw: unknown): void {
    if (this._disposed) { return; }
    const ev = raw as PointerLike;
    if (this._panFrom && this._panOrigin) {
      const now = this._localPoint(ev);
      this._setTransform(panBy(this._panOrigin, now.x - this._panFrom.x, now.y - this._panFrom.y));
      return;
    }
    if (!this._marqueeFrom) { return; }
    const rect = normalizedRect(this._marqueeFrom, this._localPoint(ev));
    if (!this._marqueeActive && !isMarqueeGesture(rect)) { return; }
    if (!this._marqueeActive) {
      this._marqueeActive = true;
      this._setCursorState();
      // Now that this is definitely a drag, take pointer events away from the
      // world so the marquee can cross live iframes, which would otherwise
      // swallow every move event the moment the cursor entered one.
      this._world.style.setProperty('pointer-events', 'none');
    }
    this._marqueeRect = rect;
    this._drawOverlay();
  }

  private _onPointerUp(raw: unknown): void {
    if (this._disposed) { return; }
    if (this._panFrom) { this._endGesture(); return; }
    if (!this._marqueeFrom) { return; }
    const ev = raw as PointerLike;
    const rect = normalizedRect(this._marqueeFrom, this._localPoint(ev));
    const wasMarquee = this._marqueeActive;
    this._endGesture();
    if (!wasMarquee) { return; }
    this._suppressClick = true;                       // the click that ends a drag is not a click
    const pageId = this._pageAt({ x: rect.x, y: rect.y }) ?? this._pageAt(this._marqueeCenter(rect));
    if (!pageId) { this._setSelection(emptySelection()); return; }
    const hits = marqueeHits(this._marqueeCandidates(pageId), rect, 'contain');
    if (hits.length === 0) { this._setSelection(emptySelection()); return; }
    const additive = this._marqueeMods.shift === true && this._selection.pageId === pageId;
    const mids = additive ? [...this._selection.mids, ...hits] : hits;
    this._setSelection(buildSelection(pageId, mids));
  }

  private _marqueeCenter(rect: Rect): Point {
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }

  private _endGesture(): void {
    this._stopGestureSampling();
    this._panFrom = null;
    this._setCursorState();
    this._panFrom = null;
    this._panOrigin = null;
    this._marqueeFrom = null;
    this._marqueeActive = false;
    this._marqueeRect = null;
    this._world.style.removeProperty('pointer-events');
    this._overlay?.setMarquee(null);
  }

  /**
   * Click on a STATIC preview tile. Live frames never reach here - their clicks
   * are swallowed by the iframe and come back as a `hit` over the port - so
   * this is what makes selection behave identically on both kinds of artboard.
   */
  private _onClick(raw: unknown): void {
    if (this._disposed) { return; }
    if (this._suppressClick) { this._suppressClick = false; return; }
    const ev = raw as PointerLike;
    const hit = resolveDomHit(ev?.target);
    if (!hit.pageId) { this._setSelection(emptySelection()); return; }
    if (!hit.mid) {
      this._focusedPageId = hit.pageId;
      this._callbacks.onFocusPage?.(hit.pageId);
      this._setSelection(emptySelection());
      return;
    }
    this._capturePreviewRect(hit.pageId, hit.mid, hit.node);
    this._focusedPageId = hit.pageId;
    this._callbacks.onFocusPage?.(hit.pageId);
    this._setSelection(applyHit(this._selection, hit.pageId, hit.mid, modifiersOf(ev)));
    this._callbacks.onHit?.(hit.pageId, hit.mid);
  }

  private _onDoubleClick(raw: unknown): void {
    if (this._disposed) { return; }
    const hit = resolveDomHit((raw as PointerLike)?.target);
    if (hit.pageId && hit.mid) { this._callbacks.onBeginTextEdit?.(hit.pageId, hit.mid); }
  }

  /**
   * Measure a preview element and store it in PAGE coordinates.
   *
   * The measurement comes back in browser-viewport space (already transformed
   * by the CSS the world carries), so it is converted back through
   * `screenToWorld` minus `boardPos`. Storing page space rather than screen
   * space is what lets the overlay follow a later pan or zoom without
   * re-measuring - and it makes a preview-measured rect indistinguishable from
   * a frame-reported one, so there is exactly one overlay code path.
   */
  private _capturePreviewRect(pageId: string, mid: Mid, node: AttrNodeLike | null): void {
    const page = this._page(pageId);
    if (!page || !node || typeof node.getBoundingClientRect !== 'function') { return; }
    let box: { left: number; top: number; width: number; height: number } | null = null;
    try { box = node.getBoundingClientRect(); } catch { return; }
    if (!box || typeof box.left !== 'number' || typeof box.top !== 'number') { return; }
    const host = this._viewportHost as MeasurableLike | null;
    let originX = 0, originY = 0;
    if (host && typeof host.getBoundingClientRect === 'function') {
      try {
        const hostBox = host.getBoundingClientRect();
        originX = typeof hostBox?.left === 'number' ? hostBox.left : 0;
        originY = typeof hostBox?.top === 'number' ? hostBox.top : 0;
      } catch { /* not a real element */ }
    }
    const world = screenToWorld({ x: box.left - originX, y: box.top - originY }, this._transform);
    const zoom = this._transform.zoom;
    this._rememberRect(pageId, mid, {
      x: world.x - page.boardPos.x,
      y: world.y - page.boardPos.y,
      w: (typeof box.width === 'number' ? box.width : 0) / zoom,
      h: (typeof box.height === 'number' ? box.height : 0) / zoom,
    });
  }

  private _onKeyUp(raw: unknown): void {
    if (this._disposed) { return; }
    const ev = raw as KeyLike;
    if (ev?.key === ' ' || ev?.code === 'Space') {
      this._spaceHeld = false;
    this._setCursorState();
      this._world.style.removeProperty('cursor');
    }
  }

  private _onKeyDown(raw: unknown): void {
    if (this._disposed) { return; }
    const ev = raw as KeyLike;
    if (isTextEntryTarget(ev?.target)) { return; }
    // The shell binds first and may claim a key (Escape closing an overlay
    // pane, for one). A board that ignored that would clear the selection on
    // the same press that dismissed the panel.
    if (ev?.defaultPrevented === true) { return; }
    const key = typeof ev?.key === 'string' ? ev.key : '';
    const accel = ev?.metaKey === true || ev?.ctrlKey === true;

    if (key === ' ' || ev?.code === 'Space') {
      // Space activates a focused control; the pan gesture never outranks that.
      if (isActivationTarget(ev?.target)) { return; }
      if (!this._spaceHeld) {
        this._spaceHeld = true;
      this._setCursorState();
        this._world.style.setProperty('cursor', 'grab');
      }
      ev?.preventDefault?.();
      return;
    }
    if (accel && (key === '=' || key === '+')) { ev?.preventDefault?.(); this.zoomIn(); return; }
    if (accel && key === '-') { ev?.preventDefault?.(); this.zoomOut(); return; }
    if (accel && (key === '0' || key === '1')) { ev?.preventDefault?.(); this.zoomToFit({ animate: true }); return; }
    if (accel) { return; }                            // Cmd+Z and friends are not ours

    // Artboard navigation. Alt+Arrow is the design-tool idiom and PageUp/Down
    // is the one a screen-reader user reaches for first; both are here because
    // "reachable without a mouse" has to include the 20-artboard case, where
    // the alternative is panning a world by hand.
    const alt = ev?.altKey === true;
    if (key === 'PageDown' || (alt && key === 'ArrowRight')) {
      ev?.preventDefault?.(); this.stepArtboard(1); return;
    }
    if (key === 'PageUp' || (alt && key === 'ArrowLeft')) {
      ev?.preventDefault?.(); this.stepArtboard(-1); return;
    }
    if (key === 'Home' || key === 'End') {
      const pages = this._artifact?.pages ?? [];
      if (pages.length === 0) { return; }
      ev?.preventDefault?.();
      this.focusPage(pages[key === 'Home' ? 0 : pages.length - 1].id);
      return;
    }

    if (key === 'Escape') {
      if (this._selection.mids.length > 0) {
        ev?.preventDefault?.();
        this._setSelection(emptySelection());
        return;
      }
      // Nothing selected and the board holds focus: Escape LEAVES the widget.
      // Tab cycles between elements of the artboard by design, so without a
      // documented exit a keyboard user who entered the board could never get
      // back out to the toolbar — a trap in miniature. `role="application"`
      // widgets conventionally exit on Escape; this is that exit.
      if (this._boardOwnsFocus(ev)) {
        const host = this._viewportHost as unknown as { blur?: () => void } | null;
        if (typeof host?.blur === 'function') { ev?.preventDefault?.(); host.blur(); }
      }
      return;
    }
    if (key === 'Tab') { this._onTab(ev); return; }

    const delta = arrowDelta(key, ev?.shiftKey === true);
    if (delta) { this._onNudge(ev, delta.dx, delta.dy); }
  }

  /**
   * Element-walk on Tab — but ONLY while the board itself owns focus.
   *
   * This used to be claimed from the window for any target that was not an
   * INPUT/TEXTAREA/SELECT/contenteditable, and `preventDefault()` ran before
   * the walk was even computed. A BUTTON, a `[tabindex]` div and `<body>` all
   * fall through that check, so once focus entered the panel every Tab and
   * Shift+Tab was swallowed: the user could never reach Undo, Present, Export,
   * the pane toggles, the review queue's Accept/Reject — or the Stop button
   * that cancels a running agent job — and could never Tab back out to VS Code.
   * A keyboard trap, WCAG 2.1.2. The only test firing Tab passed no `target`
   * at all, so the fake DOM never saw a real control.
   *
   * Native focus traversal is the default now; the board takes Tab only when
   * the active element is the board viewport (a roving-tabindex widget), and
   * only when the walk actually has somewhere to go.
   */
  private _onTab(ev: KeyLike): void {
    if (!this._boardOwnsFocus(ev)) { return; }
    const pageId = this._selection.pageId ?? this._view?.focusedPageId ?? this._artifact?.pages[0]?.id ?? null;
    if (!pageId) { return; }
    const page = this._page(pageId);
    if (!page) { return; }
    const dir: 1 | -1 = ev?.shiftKey === true ? -1 : 1;
    const anchor = this._selection.pageId === pageId ? selectionAnchor(this._selection) : null;
    const next = tabTarget(page.doc, anchor, dir);
    // Consume the key only when the walk MOVES — a no-op walk must fall through
    // to native traversal rather than eating the press.
    //
    // `tabTarget` wraps modulo its pool and returns `null` only for a doc with
    // zero selectable nodes, so `!next` alone never fires on a real artboard:
    // on a single-element doc `(0 + 1 + 1) % 1 === 0` hands back the mid the
    // user is already on, and `preventDefault()` ran anyway. Tab and Shift+Tab
    // were both swallowed forever, leaving Escape — which the board's
    // accessible name does not mention — as the only exit. WCAG 2.1.2 permits a
    // non-standard exit only when the user is advised of it, and re-selecting
    // what is already selected is not a walk in any case.
    if (!next || next === anchor) { return; }
    ev?.preventDefault?.();
    this._setSelection(buildSelection(pageId, [next]));
  }

  /**
   * True when keyboard focus is inside the board viewport, so element-walking
   * is what the user means by Tab. Falls back to the event target when the
   * document exposes no `activeElement` (the fake DOM in tests).
   */
  private _boardOwnsFocus(ev: KeyLike): boolean {
    const host = this._viewportHost;
    if (!host) { return false; }
    const doc = this._env.doc as { activeElement?: unknown };
    const active = doc.activeElement ?? (ev as { target?: unknown })?.target;
    if (!active) { return false; }
    if (active === host) { return true; }
    const contains = (host as unknown as { contains?: (n: unknown) => boolean }).contains;
    return typeof contains === 'function' ? contains.call(host, active) === true : false;
  }

  /**
   * Arrow-nudge emits `el.setStyle` - the IDENTICAL op an agent's `set_style`
   * tool produces, down the identical `canvas/submit` chokepoint. The board
   * never mutates artifact state locally; it waits for the op to come back as
   * a `canvas/ops` record like any other writer's.
   */
  private _onNudge(ev: KeyLike, dx: number, dy: number): void {
    const selection = this._selection;
    if (!selection.pageId || selection.mids.length === 0) { return; }
    const page = this._page(selection.pageId);
    if (!page) { return; }
    const ops = nudgeOps(selection.pageId, page.doc, selection.mids, dx, dy);
    if (ops.length === 0) { return; }
    ev?.preventDefault?.();
    this._callbacks.onOps?.(ops);
  }
}

/**
 * The name drawn above an artboard, and the live frame's accessible name.
 *
 * One expression, used by {@link BoardController._createBoard}, by
 * {@link BoardController._layout} on every rename and by
 * {@link BoardController._mountFrame} - so the label, the frame's `title` and
 * the rail row cannot drift apart.
 */
function artboardTitle(page: { actionTitle?: string }): string {
  return page.actionTitle ?? 'Artboard';
}

function wireFormat(format: { formatId: string; width: number; height: number }):
{ formatId: string; width: number; height: number } {
  return { formatId: format.formatId, width: format.width, height: format.height };
}

/** Identity of a format as far as a FRAME is concerned: the box, not the label. */
function formatKey(format: { formatId: string; width: number; height: number }): string {
  return `${format.formatId}:${format.width}x${format.height}`;
}
