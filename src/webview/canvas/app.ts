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
 * Plan 22 §3.4 — the canvas webview's wiring layer.
 *
 * Every decision in this subsystem lives in a typed, unit-tested module:
 * `protocolClient.ts` (the exhaustive wire switch), `state.ts` (delta-vs-reload
 * and the view/artifact split), `board.ts` (the transformed world, the frame
 * ports and the parent-drawn selection), `rail.ts`, `inspector.ts`,
 * `textEdit.ts`, `historyUi.ts`, `liveness.ts`. What is left here is the seam
 * between them — and the seams are where this subsystem has historically
 * rotted, so they are *imported and wired*, never re-implemented (§2.9: "one
 * implementation per seam").
 *
 * Three properties this file is responsible for:
 *
 * 1. **Selection is reported as it is.** The board owns multi-select (shift,
 *    marquee, Tab); the app mirrors `onSelectionChange` verbatim instead of
 *    reconstructing a single mid from a hit, and reports a cleared selection as
 *    an explicit empty `mids` rather than as silence.
 * 2. **One transaction minter.** A drag on an inspector slider, an inline text
 *    commit and an arrow-nudge all carry a `txnId` produced HERE and put on the
 *    wire unchanged — that id is what `CanvasHistory` groups on, so minting a
 *    second one at the transport would split one gesture into 60 undo steps.
 * 3. **Every gesture leaves through `canvas/submit`.** No component writes the
 *    artifact locally; the board waits for the op to come back as a record.
 *
 * `index.ts` is the bootstrap that hands this class the real DOM; this class
 * takes {@link CanvasEnv} by injection, so the whole wiring is drivable from
 * the fake DOM in `tests/webview/canvasFakeDom.ts`.
 */

import { assetCspSource, makeAssetResolver, type CanvasBoot, type CanvasThemeOption } from './boot';
import { asValueElement, type CanvasEnv, type DomElement } from './dom';
import { BOARD_OVERLAY_ID, BoardController, isTextEntryTarget, type BoardLayout } from './board';
import {
  INSPECTOR_COLLAPSED_CLASS,
  LAYOUT_MODE_CLASS,
  RAIL_COLLAPSED_CLASS,
  layoutClasses,
  paneIsDocked,
  type LayoutMode,
} from './boardMath';
import { CanvasProtocolClient, type CanvasClientBody } from './protocolClient';
import { HistoryUi, detectPlatform } from './historyUi';
import { InspectorPanel } from './inspector';
import { InlineTextEditor } from './textEdit';
import { RailController } from './rail';
import { mountLiveness, type LivenessLayer } from './liveness';
import type { OpSubmission } from './controls';
import type { FrameRuntime } from './sandboxDoc';
import {
  CanvasStore,
  changeDevice,
  changeTheme,
  effectiveFormat,
  initialViewState,
  pageDoc,
  type CanvasViewState,
} from './state';
import type { CanvasOp } from '../../canvas/CanvasOps';
import { findNode, type DocNode, type Mid } from '../../canvas/doc/DocNode';
import type { CanvasFormatSpec } from '../../types';
import type { CapChip } from '../../canvas/protocol';

/** The transformed world every artboard is positioned inside. */
const WORLD_ID = 'page-stage';
/** Where `liveness.ts` renders the staged-suggestions rail. */
const STAGED_RAIL_ID = 'staged-rail';
/** Undo / redo / save-version buttons, built by {@link HistoryUi}. */
const HISTORY_TOOLBAR_ID = 'history-toolbar';
/** The named-checkpoint timeline, with parent-rendered thumbnails. */
const VERSION_TIMELINE_ID = 'version-timeline';
/** The pages rail's list container, owned by {@link RailController}. */
const RAIL_LIST_ID = 'rail-list';
/** The inspector's body, owned by {@link InspectorPanel}. */
const INSPECTOR_BODY_ID = 'insp-body';
/** The shell's `role="alert"` banner over the board, and its text node. */
const BOARD_ERROR_ID = 'board-error';
const BOARD_ERROR_TEXT_ID = 'board-error-text';
/** The "add a page from a template" disclosure: its button and its list. */
const ADD_PAGE_ID = 'btn-add-page';
const SCAFFOLD_MENU_ID = 'scaffold-menu';
/** The capability chips — in the Activity tab, beside the agent they describe. */
const CAPABILITY_CHIPS_ID = 'capability-chips';
/** The dock's two tabs, their panels, and the count that interrupts. */
const TAB_IDS = { inspector: 'tab-inspector', activity: 'tab-activity' } as const;
const PANEL_IDS = { inspector: 'insp-panel-inspector', activity: 'activity-body' } as const;
const ACTIVITY_BADGE_ID = 'activity-badge';
/** The focused artboard's name, in the top bar's identity zone. */
const PAGE_CHIP_ID = 'page-chip';
/**
 * How long a transient notice (a rejected op, an unwired intent) stays in the
 * alert region. A failed RUNTIME fetch is deliberately not transient: nothing
 * retries it, so the panel would go back to claiming everything is fine.
 */
const NOTICE_MS = 8000;
/**
 * The shell root the responsive classes land on. See the class contract on
 * {@link CanvasApp._applyLayout}.
 */
const LAYOUT_ROOT_ID = 'app';
/**
 * The shell's pane state machine (`media/canvas/index.html`, `canvas.css` §5).
 *
 * Two real checkboxes per pane, not one: at dock widths the available action is
 * "hide", at overlay widths it is "show", and a single control whose checked
 * state means "open" at one width and "closed" at another lies to a screen
 * reader. Exactly one of each pair is rendered at a time, and
 * {@link paneIsDocked} is how this module knows which.
 *
 * They are the mechanism, and they work with no JavaScript at all - which is
 * why this file DRIVES them rather than reimplementing the collapse. What the
 * JS adds is the keyboard shortcuts, and a mode the rest of the app can read.
 */
const PANE_SWITCH_IDS: Readonly<Record<'rail' | 'inspector', { docked: string; overlay: string }>> = {
  rail: { docked: 'rail-hidden', overlay: 'rail-shown' },
  inspector: { docked: 'inspector-hidden', overlay: 'inspector-shown' },
};

/** Classes this module owns on the layout root; anything else there survives. */
const MANAGED_LAYOUT_CLASSES: ReadonlySet<string> = new Set<string>([
  ...Object.values(LAYOUT_MODE_CLASS), RAIL_COLLAPSED_CLASS, INSPECTOR_COLLAPSED_CLASS,
]);

export interface CanvasAppOptions {
  boot: CanvasBoot;
  env: CanvasEnv;
  /** `acquireVsCodeApi().postMessage`. */
  post: (message: unknown) => void;
}

export class CanvasApp {
  private readonly _boot: CanvasBoot;
  private readonly _env: CanvasEnv;
  private readonly _store = new CanvasStore();
  private readonly _client: CanvasProtocolClient;
  private readonly _board: BoardController;
  private readonly _rail: RailController | null;
  private readonly _inspector: InspectorPanel | null;
  private readonly _text: InlineTextEditor;
  private readonly _history: HistoryUi;
  private readonly _live: LivenessLayer;
  private readonly _resolveAsset: (ref: string) => string | null;
  private _view: CanvasViewState = initialViewState();
  private _artifactId: string | null = null;
  /**
   * The page the last non-empty selection was on. A cleared selection carries
   * no page, and the host still has to be told WHICH artboard was deselected.
   */
  private _selectionPageId: string | null = null;
  private _txnSeq = 0;
  /** Signature of the last render report, so it re-reports on CHANGE. */
  private _diagSig = '';
  private _helloTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wait before re-asking for state, and how many times. */
  private static readonly _helloTimeoutMs = 1500;
  private static readonly _helloRetries = 2;
  /** Responsive view state. Local and sovereign, exactly like zoom and pan. */
  private _layout: BoardLayout = { mode: 'wide', panes: { rail: true, inspector: true } };
  /** The published frame runtime, kept so the Babel slot can be filled later. */
  private _runtime: FrameRuntime | null = null;
  private _babelState: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle';
  /**
   * A pane repaint that was withheld because the human had focus inside it.
   * Flushed when focus leaves - never dropped, or the panel would keep showing
   * a value the store no longer holds.
   */
  private _pendingRender: { rail: boolean; inspector: boolean } = { rail: false, inspector: false };
  /** Whether the template disclosure is open. The DOM mirrors this, not vice versa. */
  private _scaffoldsOpen = false;
  /** Which dock tab is showing. The human's choice; nothing auto-switches it. */
  private _dockTab: 'inspector' | 'activity' = 'inspector';

  constructor(opts: CanvasAppOptions) {
    const { boot, env, post } = opts;
    this._boot = boot;
    this._env = env;
    this._resolveAsset = makeAssetResolver(boot.assetBaseUri);

    // BEFORE the board, deliberately: window listeners fire in registration
    // order, and the shell has to be able to claim a key the board also wants.
    // Escape is the case that matters - it must dismiss an overlay pane that is
    // covering the board rather than clear a selection the human cannot see.
    env.self.addEventListener('keydown', ev => this._onKeyDown(ev));

    this._client = new CanvasProtocolClient({
      post,
      viewToken: boot.viewToken,
      warn: env.warn,
      handlers: {
        hello: m => {
          this._artifactId = m.artifactId;
          this._client.setViewToken(m.viewToken);
          this._store.load(m.artifact);
          // `approvalMode` and `caps` ride on `hello` and were both discarded
          // here: the review queue then hid its own empty state (the SHIPPED
          // default is `staged`), and the chips only ever appeared if a later
          // `canvas/caps` happened to arrive.
          this._live.setApprovalMode(m.artifact.approvalMode);
          this._applyCaps(m.caps);
          this._renderAll();
          this._ensureBabel();
        },
        caps: m => this._applyCaps(m.caps),
        ops: m => {
          const outcome = this._store.applyOps(m.records, m.artifactVersion);
          if (!outcome.ok) {
            if (outcome.reason === 'gap' || outcome.reason === 'no-artifact') { this._requestResync(); }
            return;
          }
          if (outcome.plan.resync) { this._requestResync(); }
          this._board.applyPlan(outcome.plan);
          // Deferred while the human is inside the pane: both renders are a
          // `replaceChildren()`, and an agent op landing mid-keystroke used to
          // take the focused control, its uncommitted value and the caret with
          // it. See {@link _renderInspector}.
          //
          // A STRUCTURAL plan is the exception: pages were added, removed or
          // reordered, so holding the old rows back would leave rows pointing
          // at artboards that no longer exist. Correct beats undisturbed.
          this._renderRail({ deferWhileFocused: !outcome.plan.structure });
          // The selection's nodes just changed underneath the panel, and an
          // artboard may have moved - both are pure redraws off the store.
          this._renderInspector({ deferWhileFocused: true });
          this._live.refresh();
          // The format select READS BACK a document property now, so an agent
          // reformatting an artboard has to move it. Left out, the control
          // would keep showing the last format a human picked while the board
          // showed a different one — the preview/property conflation this
          // redesign removed, growing back in the other direction.
          this._syncArtboardProps();
          // A structural op can introduce a `legacy` artboard, which needs a
          // JSX compiler the boot-time fetch had no way to know about.
          this._ensureBabel();
        },
        staged: m => { this._live.onStaged(m.records); this._syncActivityBadge(); },
        receipt: m => {
          this._store.noteReceipt(m.receipt);
          // The shell ships a `role="alert"` banner for exactly this. The toast
          // it replaces wrote the liveness layer's own status label and then
          // hid it, taking the status pill and its state dot with it.
          if (m.receipt.error) { this._showBoardNotice(m.receipt.error.slice(0, 120), NOTICE_MS); }
        },
        job: m => { this._live.onJob(m.event); this._syncActivityBadge(); },
        agentCursor: m => this._live.onAgentCursor({ pageId: m.pageId, mid: m.mid, label: m.label }),
        // The undo stack is decided host-side over the real op log (ops arrive
        // from transports this webview never sees), so it is pushed, never
        // mirrored.
        history: m => this._history.setStatus(m.status),
        resync: m => {
          this._store.load(m.artifact, m.artifactVersion);
          this._live.setApprovalMode(m.artifact.approvalMode);
          this._renderAll();
          this._ensureBabel();
        },
        artifacts: () => { /* Phase 6 - the artifact picker. */ },
      },
    });

    const world = env.doc.getElementById(WORLD_ID);
    const assetSource = assetCspSource(boot.assetBaseUri);
    this._board = new BoardController({
      env,
      world: world ?? env.doc.createElement('div'),
      resolveAsset: this._resolveAsset,
      // A doc frame's hardened `img-src` is `data: blob:` only; without the
      // webview's own origin, a resolved `asset://` image is blocked by the
      // frame's CSP rather than by any decision of ours.
      imgSources: assetSource ? [assetSource] : [],
      // A `srcdoc` artboard inherits THIS webview's CSP, whose script-src is
      // nonce-based with no `'unsafe-inline'`. Without the nonce every script
      // in the frame is refused, the harness never runs, no MessagePort binds,
      // and the artboard paints blank over its own static preview.
      frameNonce: boot.frameNonce,
      callbacks: {
        onFrameError: (pageId, message, mid) => {
          // Both: an on-artboard card the human can act on, and a report the
          // host folds into the run's steering inbox.
          this._live.onFrameError(pageId, message, mid);
          this._client.send({ t: 'canvas/frameError', pageId, mid, message });
        },
        // NOT `onHit`: a hit is one element, and shift-click, marquee, Tab and
        // Escape all change the selection without producing one. Mirroring the
        // board's selection verbatim is what makes multi-select reportable.
        onSelectionChange: sel => {
          this._view = { ...this._view, selection: { pageId: sel.pageId, mids: [...sel.mids] } };
          const pageId = sel.pageId ?? this._selectionPageId;
          if (sel.pageId) { this._selectionPageId = sel.pageId; }
          if (pageId) {
            this._client.send({ t: 'canvas/selection', pageId, mids: [...sel.mids] });
          }
          this._renderInspector();
        },
        onViewChange: view => {
          this._view = view;
          // Ghosts live in the world and move with it; the cursor and the error
          // cards are screen-space and have to be re-placed.
          this._live.setTransform();
        },
        onOps: ops => this._submitOps(ops),
      // A completed pan/zoom is new information about how the panel actually
      // performs in THIS host — push it so the doctor can report real numbers.
      onGestureStats: () => this._reportRendered(),
        onFocusPage: pageId => {
          this._view = { ...this._view, focusedPageId: pageId };
          this._renderRail();
        },
        onBeginTextEdit: (pageId, mid) => this._beginTextEdit(pageId, mid),
        onTextCommit: (pageId, mid, text) => {
          this._text.commit(pageId, mid, text, this._node(pageId, mid));
        },
        onLayoutChange: layout => this._applyLayout(layout),
      },
    });
    this._board.setView(this._view);

    const railList = this._el(RAIL_LIST_ID);
    this._rail = railList
      ? new RailController({
        env,
        list: railList,
        resolveAsset: this._resolveAsset,
        deviceLabels: new Map(boot.devices.map(d => [d.formatId, d.label])),
        callbacks: {
          submit: ops => this._submitOps(ops),
          select: pageId => {
            this._view = { ...this._view, focusedPageId: pageId };
            this._renderRail();
            // And actually GO there. A rail that highlights an artboard sitting
            // off screen in a panned world has selected nothing the human can
            // see; `focusPage` centres it without touching their zoom.
            this._board.focusPage(pageId);
          },
        },
      })
      : null;

    const inspectorBody = this._el(INSPECTOR_BODY_ID);
    this._inspector = inspectorBody
      ? new InspectorPanel({
        env,
        host: inspectorBody,
        // One minter for every producer, so a drag cannot collide with a text
        // commit inside the same millisecond.
        newTxnId: () => this._newTxnId(),
        callbacks: {
          submit: submission => this._submit(submission),
          unpin: intent => {
            // Unpinning is a human intent the HOST fulfils (the op algebra has
            // no inverse for a pin), and no client variant carries it yet.
            // Reported honestly rather than silently dropped.
            this._env.warn('canvas: unpin has no host wire yet', intent.scope, intent.targets.length);
            this._showBoardNotice('Unpinning is not wired to the host yet.', NOTICE_MS);
          },
          beginTextEdit: (pageId, mid) => this._beginTextEdit(pageId, mid),
          // "Click an element, say what you want changed" — the inspector hands
          // the element to the ONE composer rather than growing a second one.
          // Without this callback `InspectorPanel` draws no button at all.
          comment: (pageId, mid, label) => this._live.focusComment(pageId, mid, label),
        },
      })
      : null;

    this._text = new InlineTextEditor({
      // The board owns the frame ports; the editor reaches ONE artboard through
      // the board rather than opening a second channel to it.
      sendToFrame: (pageId, message) => this._board.sendToPage(pageId, message),
      submit: submission => this._submit(submission),
      onEditingChange: (pageId, mids, editing) => {
        this._client.send({ t: 'canvas/editing', pageId, mids, editing });
      },
      newTxnId: () => this._newTxnId(),
      now: () => this._env.now(),
      warn: env.warn,
    });

    this._history = new HistoryUi({
      env,
      send: body => this._client.send(body),
      toolbar: this._el(HISTORY_TOOLBAR_ID),
      timeline: this._el(VERSION_TIMELINE_ID),
      platform: detectPlatform(
        (globalThis as { navigator?: { platform?: unknown; userAgent?: unknown } }).navigator,
      ),
      resolveAsset: this._resolveAsset,
    });

    this._live = mountLiveness({
      env,
      hosts: {
        world: world ?? null,
        overlay: this._el(BOARD_OVERLAY_ID),
        rail: this._el(STAGED_RAIL_ID),
      },
      // "N to review" must open the thing it names, and the queue now lives one
      // level deeper than a pane: it is in the inspector's Activity TAB. A
      // switch alone would reveal the dock still showing the Inspector tab —
      // the button would open a panel that does not contain what it counted.
      revealReview: () => {
        this._showPane('inspector');
        this._setDockTab('activity');
      },
      send: body => this._client.send(body),
      transform: () => this._board.transform,
      pageGeometry: pageId => this._pageGeometry(pageId),
      rectsFor: pageId => this._board.rectsFor(pageId),
      // `title` is what turns "Artboard 3" into "Login" in the status line, the
      // review rows and the composer's picker. It is on the page already.
      pages: () => (this._store.artifact?.pages ?? []).map(p => ({
        id: p.id, doc: pageDoc(p), ...(p.actionTitle ? { title: p.actionTitle } : {}),
      })),
      // The review queue draws the DESIGN, so its Before/After panes need the
      // design's own `--theme-*` — the rail tiles and the artboard roots carry
      // them, a pane in the staged rail inherits them from nothing.
      theme: () => this._store.artifact?.theme ?? null,
      // The board's live selection IS the composer's target: a note about the
      // heading a person just clicked must not silently become a note about
      // whichever artboard a dropdown happens to show.
      commentTarget: () => {
        const { pageId, mids } = this._view.selection;
        if (!pageId) { return null; }
        return { pageId, ...(mids.length === 1 ? { mid: mids[0] } : {}) };
      },
      // A review row that cannot show you what it is about is a row you cannot
      // decide. `focusPage` centres the artboard without touching the zoom.
      revealTarget: pageId => {
        this._view = { ...this._view, focusedPageId: pageId };
        this._board.focusPage(pageId);
        this._renderRail();
      },
      // A speculative patch is a delta down the SAME path a committed op takes,
      // minus the journal: one artboard, no reload, no structural change.
      applySpeculative: patch => this._board.applyPlan({
        patches: new Map([[patch.pageId, patch.ops]]),
        reload: new Set<string>(),
        structure: false,
        theme: false,
        resync: false,
      }),
    });
  }

  start(): void {
    this._wireChrome();
    // `globalThis.parent` is the VS Code `vscode-webview://` shell that relays
    // extension messages into this nested frame; without it in the allowlist
    // every host message is dropped and the board never receives an artifact.
    const selfWin: unknown = globalThis;
    const parentWin: unknown = (globalThis as { parent?: unknown }).parent;
    this._env.self.addEventListener('message', ev => {
      this._client.receive(ev as { data: unknown; source?: unknown }, selfWin, parentWin);
    });
    this._client.send({ t: 'canvas/ready' });
    this._awaitHello();
    // Measure the panel and paint the layout classes before the first artifact
    // lands, so the board is never fitted against chrome that is about to
    // collapse.
    this._board.refreshLayout();
    void this._loadRuntime();
  }

  /**
   * Re-ask for state if `canvas/hello` does not arrive, and SAY SO if it never does.
   *
   * The loading state is inferred in CSS from "no artboards yet AND no empty
   * state yet", so a single lost `ready` or `hello` left the user staring at
   * "Loading your designs…" forever, with the failure invisible from inside the
   * webview. That happened in production twice, for two different reasons. The
   * handshake is one message each way and both ends are idempotent, so a retry
   * costs nothing and removes the whole class of stuck boot.
   */
  private _awaitHello(attempt = 0): void {
    if (this._helloTimer !== null) { clearTimeout(this._helloTimer); }
    this._helloTimer = setTimeout(() => {
      this._helloTimer = null;
      if (this._store.artifact) { return; }          // hello landed
      if (attempt < CanvasApp._helloRetries) {
        this._env.warn(`canvas: no reply from the extension; re-asking (attempt ${attempt + 2})`);
        this._client.send({ t: 'canvas/ready' });
        this._awaitHello(attempt + 1);
        return;
      }
      this._showBootFailure();
    }, CanvasApp._helloTimeoutMs);
  }

  /** Replace the indefinite spinner with a stated failure and a way forward. */
  private _showBootFailure(): void {
    this._env.warn('canvas: the extension never answered canvas/ready');
    const host = this._el('board-loading');
    if (!host) { return; }
    host.replaceChildren();
    const title = this._env.doc.createElement('div');
    title.className = 'empty-title';
    title.textContent = 'Could not reach the Mysti extension';
    const sub = this._env.doc.createElement('div');
    sub.className = 'empty-sub';
    sub.textContent = 'The panel loaded but the extension did not reply. Reload the window '
      + '(Developer: Reload Window); if it persists, the webview developer tools console will say why.';
    host.appendChild(title);
    host.appendChild(sub);
    host.setAttribute('data-boot-failed', 'true');
  }

  /* -------------------------------- seams -------------------------------- */

  /** The board, for the bootstrap and for tests. */
  get board(): BoardController { return this._board; }
  /** The live view state (zoom, pan, selection, focus). Never on the wire. */
  get view(): CanvasViewState { return this._view; }
  /**
   * The live responsive state.
   *
   * It is view state in the §3.5 sense - local, sovereign, never posted - but
   * it is NOT on {@link CanvasViewState}: that type is shared with `state.ts`
   * and the host, and a breakpoint is a property of this window's chrome, not
   * of the document. Read it here.
   */
  get layout(): BoardLayout { return { mode: this._layout.mode, panes: { ...this._layout.panes } }; }
  get layoutMode(): LayoutMode { return this._layout.mode; }
  get history(): HistoryUi { return this._history; }
  get liveness(): LivenessLayer { return this._live; }
  get textEditor(): InlineTextEditor { return this._text; }
  get inspector(): InspectorPanel | null { return this._inspector; }
  get rail(): RailController | null { return this._rail; }

  /* ------------------------------- runtime ------------------------------- */

  /**
   * Fetch the frame runtime lazily. Previews are already on screen by the time
   * this resolves, and Babel - 2.98 MB of it - is fetched only if some artboard
   * is actually legacy, which {@link _ensureBabel} decides against the artifact
   * rather than against whatever had arrived when this started.
   */
  private async _loadRuntime(): Promise<void> {
    try {
      const scripts = await Promise.all(this._boot.runtimeUris.map(u => this._env.fetchText(u)));
      const harness = this._boot.harnessUri ? await this._env.fetchText(this._boot.harnessUri) : '';
      const runtime: FrameRuntime = { scripts, harness };
      this._runtime = runtime;
      this._board.setRuntime(runtime);
      // AFTER publishing the base runtime, and re-checked on every artifact
      // change: which pages are legacy is not knowable here (see below).
      this._ensureBabel();
    } catch (err) {
      this._env.warn('canvas: runtime unavailable, staying on static previews', err);
      // `#board-error` is the alert region the shell ships for precisely this,
      // and nothing referenced it. A webview console is not a user surface: the
      // whole board silently stayed non-interactive with no explanation.
      this._showBoardNotice('Interactive preview is unavailable — showing static previews.');
    }
  }

  /**
   * Fetch the JSX compiler when — and only when — a `legacy` artboard exists.
   *
   * It cannot be decided once at boot. `_loadRuntime` starts before
   * `canvas/hello` can have answered (and `CanvasBridge` defers `hello` until
   * the artifact has been read from disk), so on a cold open the artifact is
   * still empty when the runtime resolves; a legacy page arriving afterwards —
   * on `hello`, on a `resync`, or as a `page.add` from an import — got a live
   * frame with no compiler, which the harness answers by rendering nothing at
   * all. That artboard is a plain white rectangle with no error anywhere,
   * because a legacy frame is deliberately denied a MessagePort.
   *
   * Re-entrant by design and idempotent: at most one fetch per view.
   */
  private _ensureBabel(): void {
    if (this._babelState !== 'idle' || !this._boot.babelUri) { return; }
    const runtime = this._runtime;
    if (!runtime) { return; }                      // the base runtime failed
    if (!this._legacyPageIds().length) { return; }
    this._babelState = 'loading';
    void (async () => {
      try {
        const babel = await this._env.fetchText(this._boot.babelUri);
        // A new object rather than a mutation of the one the board already
        // holds: the runtime is shared state, and "the same object sometimes
        // grows a field" is exactly the kind of aliasing this subsystem's
        // seams exist to avoid.
        const next: FrameRuntime = { ...runtime, babel };
        this._babelState = 'loaded';
        this._runtime = next;
        this._board.setRuntime(next);
        // ONLY the legacy artboards are reloaded. A document-model frame keeps
        // its port and its state: the compiler it never needed arriving is not
        // a reason to rebuild it (§3.4 — a live frame outlives edits).
        this._board.applyPlan({
          patches: new Map(),
          // Recomputed AFTER the fetch: a legacy page that arrived while it was
          // in flight mounted without a compiler too.
          reload: new Set(this._legacyPageIds()),
          structure: false,
          theme: false,
          resync: false,
        });
      } catch (err) {
        // `failed`, not `idle`: ops arrive in bursts, and retrying per op would
        // turn one dead URL into a fetch storm.
        this._babelState = 'failed';
        this._env.warn('canvas: JSX compiler unavailable; legacy artboards stay static', err);
        this._showBoardNotice('A code artboard needs the JSX compiler, which failed to load.', NOTICE_MS);
      }
    })();
  }

  private _legacyPageIds(): string[] {
    return (this._store.artifact?.pages ?? []).filter(p => !!p.legacy).map(p => p.id);
  }

  private _requestResync(): void {
    this._client.send({
      t: 'canvas/ready',
      artifactId: this._artifactId ?? undefined,
      haveVersion: this._store.version,
    });
  }

  /* -------------------------------- chrome -------------------------------- */

  private _el(id: string): DomElement | null { return this._env.doc.getElementById(id); }

  private _wireChrome(): void {
    // The format IS the artboard's, so picking one writes it — scope
    // `'artboard'`, never `'preview'`. The dropdown used to mean BOTH ("show me
    // this on mobile" and "this artboard is a mobile screen") and the only thing
    // telling them apart was a button called Apply; until you pressed it the
    // board was showing something the artboard was not, which is a mode. Undo
    // is the safety net here exactly as it is for every other edit.
    const device = this._el('device-select');
    if (device) {
      const select = asValueElement(device);
      this._fillOptions(select, this._boot.devices.map(d => ({ value: d.formatId, label: d.label })));
      select.addEventListener('change', () => this._onDevice(select.value, 'artboard'));
    }
    const theme = this._el('theme-select');
    if (theme) {
      const select = asValueElement(theme);
      this._fillOptions(select, this._boot.themes.map(t => ({ value: t.id, label: t.name })));
      if (this._boot.activeThemeId) { select.value = this._boot.activeThemeId; }
      select.addEventListener('change', () => this._onTheme(select.value));
    }
    // The dock's tabs. Inspector is the selection; Activity is the agent — all
    // of it, in one place, instead of a status pill, a queue inside the pages
    // rail, a composer and a timeline that never agreed with each other.
    for (const tab of ['inspector', 'activity'] as const) {
      this._el(TAB_IDS[tab])?.addEventListener('click', () => this._setDockTab(tab));
    }
    this._setDockTab(this._dockTab);
    this._el('btn-present')?.addEventListener('click', () => {
      this._client.send({ t: 'canvas/present', pageId: this._view.focusedPageId ?? undefined });
    });
    this._el('btn-export')?.addEventListener('click', () => {
      this._client.send({ t: 'canvas/export' });
    });
    this._el('onboarding-dismiss')?.addEventListener('click', () => {
      this._view = { ...this._view, onboardingDismissed: true };
      const node = this._el('onboarding');
      if (node) { node.hidden = true; }
    });
    // A DISCLOSURE, not a popup: `canvas.css` renders `.scaffold-menu` as an
    // in-flow block inside the rail, so `aria-haspopup` would announce
    // something that does not exist. What was missing is the state itself —
    // the button never said it was expanded, and Escape (the universal
    // dismissal, handled for overlay panes two lines below) left it open.
    const addPage = this._el(ADD_PAGE_ID);
    const menu = this._el(SCAFFOLD_MENU_ID);
    if (addPage && menu) {
      addPage.setAttribute('aria-controls', SCAFFOLD_MENU_ID);
      // The DOM starts in the state this class believes it is in, rather than
      // whatever a shell happened to ship.
      this._setScaffoldsOpen(false);
      addPage.addEventListener('click', () => this._setScaffoldsOpen(!this._scaffoldsOpen, { moveFocus: true }));
    }
    // A withheld repaint is flushed the moment the human's focus leaves the
    // pane, which is also the moment their uncommitted value has been committed
    // (or abandoned) by the control's own `change` handler.
    for (const id of [RAIL_LIST_ID, INSPECTOR_BODY_ID]) {
      this._el(id)?.addEventListener('focusout', ev => this._onPaneFocusOut(id, ev));
    }
    // A human can also flip the switches directly - the label in the top bar,
    // the in-pane close button, or the scrim, all of which are `<label for=…>`
    // and therefore never reach a click handler of ours. Listening for `change`
    // is what keeps the board's idea of the layout equal to the stylesheet's.
    for (const pane of ['rail', 'inspector'] as const) {
      for (const id of [PANE_SWITCH_IDS[pane].docked, PANE_SWITCH_IDS[pane].overlay]) {
        this._el(id)?.addEventListener('change', () => this._onSwitchChanged(pane));
      }
    }
  }

  /**
   * Force one side pane visible, whichever switch is live at this width.
   *
   * `_writeSwitch` is the painting half of the layout contract and answers to
   * `BoardLayout`; this is the imperative half, for the one case where a
   * control has to open a pane the human closed. It goes through the same
   * `change` event a human's click fires, so `CanvasApp`'s own listener updates
   * the second authority (the `*-collapsed` class on `#app`) rather than the
   * pane staying `display: none` under a checked switch.
   */
  private _showPane(pane: 'rail' | 'inspector'): void {
    const ids = PANE_SWITCH_IDS[pane];
    const docked = paneIsDocked(this._layout.mode, pane);
    // A docked switch means "hide me"; an overlay switch means "show me". Only
    // the one that is live at this width is written — a stale `hidden:checked`
    // left over from a wider layout would silently re-collapse the pane the
    // moment the panel is widened again.
    this._setChecked(docked ? ids.docked : ids.overlay, docked ? false : true);
    this._setChecked(docked ? ids.overlay : ids.docked, false);
    // The switches are one authority; `CanvasApp`'s `*-collapsed` class on
    // `#app` is the other, and it only learns about a flip through this
    // handler. Calling it directly rather than synthesising a `change` keeps
    // that in one code path instead of depending on a DOM event constructor.
    this._onSwitchChanged(pane);
  }

  /**
   * Show one dock tab.
   *
   * Deliberately NOT called from any agent path. A staged change raises the
   * badge and stops there: yanking the panel to Activity while someone is
   * editing a padding value is the same interruption the old shell committed
   * by pushing the staged queue into the pages rail, one layer further in.
   */
  private _setDockTab(tab: 'inspector' | 'activity'): void {
    this._dockTab = tab;
    for (const name of ['inspector', 'activity'] as const) {
      const on = name === tab;
      const button = this._el(TAB_IDS[name]);
      if (button) {
        const kept = (button.className || '').split(' ').filter(c => c && c !== 'active');
        button.className = on ? [...kept, 'active'].join(' ') : kept.join(' ');
        button.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      const panel = this._el(PANEL_IDS[name]);
      if (panel) { panel.hidden = !on; }
    }
  }

  /**
   * The count of staged changes waiting on a human, on the Activity tab.
   *
   * This is the ONLY thing in the shell that interrupts on the agent's behalf,
   * which is why it is a number and not a panel. Zero hides it: a badge reading
   * "0" is an interruption that says nothing.
   */
  private _syncActivityBadge(): void {
    const badge = this._el(ACTIVITY_BADGE_ID);
    if (!badge) { return; }
    const count = this._live?.stagedCount ?? 0;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  /**
   * Put the focused artboard's own values on the two controls that write them.
   *
   * The device select is a DOCUMENT property now, so it has to read back as
   * one: left unsynced it would keep showing the last format anyone picked
   * while the board showed a different artboard — the same conflation, moved
   * one pane over.
   */
  private _syncArtboardProps(): void {
    const artifact = this._store.artifact;
    const page = this._view.focusedPageId ? this._store.page(this._view.focusedPageId) : null;
    const chip = this._el(PAGE_CHIP_ID);
    if (chip) { chip.textContent = page?.actionTitle?.trim() || ''; }
    const device = this._el('device-select');
    if (device && artifact) {
      const format = page?.format ?? artifact.format;
      const select = asValueElement(device);
      // Only when the catalog actually has it: a custom size is not in the
      // dropdown, and writing an unknown value silently blanks a <select>.
      if (this._boot.devices.some(d => d.formatId === format.formatId)) {
        select.value = format.formatId;
      }
    }
    const props = this._el('artboard-props');
    if (props) { props.hidden = !artifact || artifact.pages.length === 0; }
  }

  /* ------------------------------ responsive ------------------------------ */

  /**
   * THE class contract with `media/canvas/canvas.css`.
   *
   * The layout root (`#app`) carries exactly one mode class -
   * `layout-narrow` | `layout-medium` | `layout-wide` - plus
   * `rail-collapsed` / `inspector-collapsed` for whichever side pane is not on
   * screen, plus `data-layout-mode` for anything that would rather match an
   * attribute. Nothing else is implied and nothing else is written: classes the
   * shell put there itself are preserved verbatim, because this is a webview
   * whose HTML another author owns.
   *
   * The board decides (width, with hysteresis, in `boardMath.ts`); this only
   * paints. That split is what keeps the decision unit-testable without a DOM
   * and the DOM write in one place instead of five.
   */
  private _applyLayout(layout: BoardLayout): void {
    this._layout = { mode: layout.mode, panes: { ...layout.panes } };
    this._writeSwitch('rail', layout);
    this._writeSwitch('inspector', layout);
    const root = this._el(LAYOUT_ROOT_ID);
    if (root) {
      // Re-derive the shell's own classes from what is on the element RIGHT NOW
      // rather than caching them once: another module may add a class to the
      // root later, and a cached baseline would silently delete it on the next
      // breakpoint. Only the names this module owns are ever removed.
      const kept = (root.className || '')
        .split(' ')
        .filter(name => name && !MANAGED_LAYOUT_CLASSES.has(name));
      root.className = [...kept, ...layoutClasses(layout.mode, layout.panes)].join(' ');
      root.setAttribute('data-layout-mode', layout.mode);
    }
  }

  /**
   * Put one pane's visibility onto whichever switch is live at this width, and
   * clear the other.
   *
   * Clearing matters: a `rail-hidden` left checked from a wide layout is inert
   * while the rail is an overlay, and would silently re-hide it the moment the
   * panel is widened again - a collapse with no cause the human can see.
   */
  private _writeSwitch(pane: 'rail' | 'inspector', layout: BoardLayout): void {
    const ids = PANE_SWITCH_IDS[pane];
    const docked = paneIsDocked(layout.mode, pane);
    const visible = layout.panes[pane];
    // A docked switch means "hide me"; an overlay switch means "show me".
    this._setChecked(docked ? ids.docked : ids.overlay, docked ? !visible : visible);
    this._setChecked(docked ? ids.overlay : ids.docked, false);
  }

  /**
   * `DomElement` deliberately declares only what the renderer writes, and
   * `checked` is a live property rather than an attribute (`setAttribute` would
   * set `defaultChecked` and leave the rendered control alone). This is the one
   * place the shell's form controls are touched, so the cast lives here.
   */
  private _setChecked(id: string, checked: boolean): void {
    const node = this._el(id) as (DomElement & { checked?: boolean }) | null;
    if (node) { node.checked = checked; }
  }

  private _isChecked(id: string): boolean {
    return (this._el(id) as (DomElement & { checked?: boolean }) | null)?.checked === true;
  }

  /** A switch the human flipped directly. Fold it back into the board. */
  private _onSwitchChanged(pane: 'rail' | 'inspector'): void {
    const ids = PANE_SWITCH_IDS[pane];
    const docked = paneIsDocked(this._layout.mode, pane);
    const visible = docked ? !this._isChecked(ids.docked) : this._isChecked(ids.overlay);
    if (visible === this._layout.panes[pane]) { return; }   // our own write echoing back
    this._board.setPaneVisible(pane, visible);
  }

  /**
   * Shell-level keys. The board owns zoom, selection and artboard navigation;
   * what is left is the chrome, and it has to be reachable without a mouse
   * because in narrow mode the toggle buttons may be the only way back to a
   * pane the breakpoint collapsed.
   *
   * Unmodified letters are deliberately avoided: `[`, `]` and `\` are the
   * design-tool idiom and cannot collide with a VS Code chord, and every one of
   * them is skipped while the human is typing.
   */
  private _onKeyDown(raw: unknown): void {
    const ev = raw as {
      key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean;
      target?: unknown; preventDefault?: () => void;
    };
    if (isTextEntryTarget(ev?.target)) { return; }
    if (ev?.metaKey === true || ev?.ctrlKey === true || ev?.altKey === true) { return; }
    const key = typeof ev?.key === 'string' ? ev.key : '';
    // An overlay pane covers the board, so Escape must close it before it means
    // anything else. `preventDefault` is how the board is told the key is spent
    // (it yields on `defaultPrevented`), so one press does one thing.
    if (key === 'Escape') {
      // The disclosure first: it is the most recently opened thing on screen,
      // and it is INSIDE the rail, so dismissing the pane under it would leave
      // the menu open and unreachable.
      if (this._scaffoldsOpen) {
        ev?.preventDefault?.();
        this._setScaffoldsOpen(false, { moveFocus: true });
        return;
      }
      for (const pane of ['inspector', 'rail'] as const) {
        if (!paneIsDocked(this._layout.mode, pane) && this._layout.panes[pane]) {
          ev?.preventDefault?.();
          this._board.setPaneVisible(pane, false);
          return;
        }
      }
      return;
    }
    if (key === '[') { ev?.preventDefault?.(); this._board.togglePane('rail'); return; }
    if (key === ']') { ev?.preventDefault?.(); this._board.togglePane('inspector'); return; }
    if (key === '\\') {
      ev?.preventDefault?.();
      const anyOpen = this._layout.panes.rail || this._layout.panes.inspector;
      if (anyOpen) {
        this._board.setPaneVisible('rail', false);
        this._board.setPaneVisible('inspector', false);
        return;
      }
      // Opening both is only meaningful where both are COLUMNS. As overlays
      // they are absolutely positioned over the same grid area at the same
      // z-index, and `min(280px,82%)` + `min(340px,86%)` cannot fit side by
      // side - so the later one in DOM order (the inspector) buried all but the
      // leftmost ~60px of the rail, including every row title, every per-row
      // action and the rail's own close control. Open the rail alone there: it
      // is the navigation surface, and `]` is one keystroke away.
      const bothOverlay = !paneIsDocked(this._layout.mode, 'rail')
        && !paneIsDocked(this._layout.mode, 'inspector');
      this._board.setPaneVisible('rail', true);
      if (!bothOverlay) { this._board.setPaneVisible('inspector', true); }
    }
  }

  private _fillOptions(select: DomElement, items: Array<{ value: string; label: string }>): void {
    select.replaceChildren();
    for (const item of items) {
      const option = this._env.doc.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    }
  }

  private _onDevice(formatId: string, scope: 'preview' | 'artboard'): void {
    const device = this._boot.devices.find(d => d.formatId === formatId);
    if (!device) { return; }
    const format: CanvasFormatSpec = {
      formatId: device.formatId, kind: device.kind, width: device.width, height: device.height,
    };
    const intent = changeDevice(this._view, scope, format, this._view.focusedPageId);
    this._view = intent.view;
    this._board.setView(this._view);
    this._submitOps(intent.ops);
  }

  private _onTheme(presetId: string): void {
    const preset: CanvasThemeOption | undefined = this._boot.themes.find(t => t.id === presetId);
    if (!preset) { return; }
    this._submitOps(changeTheme(preset.theme));
  }

  /* ------------------------------ submission ------------------------------ */

  /**
   * Every human gesture leaves through here - the same chokepoint an agent op
   * takes. `author` is stamped host-side, so this cannot claim to be anything.
   *
   * The submission's `txnId` goes on the wire UNCHANGED: it is what
   * `CanvasHistory` groups on, so re-minting one here would turn a 60-frame
   * slider drag into 60 undo steps and defeat the coalescing entirely.
   */
  private _submit(submission: OpSubmission): void {
    const artifact = this._store.artifact;
    if (!artifact || submission.ops.length === 0) { return; }
    const baseVersions: Record<string, number> = { [artifact.id]: this._store.version };
    for (const page of artifact.pages) { baseVersions[page.id] = page.version; }
    this._client.send({
      t: 'canvas/submit',
      txnId: submission.txnId,
      ops: submission.ops,
      baseVersions,
    });
  }

  /** A gesture with no transaction of its own (a nudge, a rail action). */
  private _submitOps(ops: readonly CanvasOp[]): void {
    if (ops.length === 0) { return; }
    this._submit({ txnId: this._newTxnId(), ops: [...ops] });
  }

  /**
   * Monotonic within the view. `Date.now()` alone collides for two gestures in
   * the same millisecond, which would merge two unrelated edits into one undo
   * step - the exact failure the sequence suffix exists to prevent.
   */
  private _newTxnId(): string {
    return `txn-${this._env.now().toString(36)}-${(this._txnSeq++).toString(36)}`;
  }

  /* ------------------------------ text editing ------------------------------ */

  private _beginTextEdit(pageId: string, mid: Mid): void {
    this._text.begin(pageId, mid, this._node(pageId, mid));
  }

  /** The store is the authority on what exists - never the frame that reported it. */
  private _node(pageId: string, mid: Mid): DocNode | null {
    const page = this._store.page(pageId);
    return page ? findNode(pageDoc(page), mid) : null;
  }

  /* ------------------------------- rendering ------------------------------- */

  /**
   * Report ONE successful paint back to the host.
   *
   * The only positive signal that the handshake completed in whatever host we
   * are actually running in. Twice this panel sat on "Loading your designs…"
   * with no way to tell from the extension side whether the client had booted,
   * received `hello`, or silently dropped it — because success was never
   * reported, only failure was (and not always).
   */
  private _reportRendered(): void {
    const artifact = this._store.artifact;
    const pages = artifact ? artifact.pages.length : 0;
    const live = this._board.liveFrameCount?.() ?? 0;
    // Re-report whenever what is ON SCREEN changes, not just once. A one-shot
    // report taken at boot says "0 artboards, 0 live frames" forever, which is
    // indistinguishable from a panel that later broke — and a diagnostic whose
    // answer is permanently stale is worse than none.
    const stats = this._board.gestureStats;
    const sig = `${pages}|${live}|${this._layout.mode}|${stats ? `${stats.p50}/${stats.p95}/${stats.dropped}` : ''}`;
    if (sig === this._diagSig) { return; }
    this._diagSig = sig;
    this._client.send({
      t: 'canvas/diag', pages, layoutMode: this._layout.mode, liveFrames: live,
      ...(stats ? { gestureP50: stats.p50, gestureP95: stats.p95, gestureDropped: stats.dropped } : {}),
    });
  }

  private _renderAll(): void {
    const artifact = this._store.artifact;
    if (!artifact) { return; }
    const name = this._el('artifact-name');
    if (name) { name.textContent = artifact.name; }
    if (!this._view.focusedPageId && artifact.pages.length > 0) {
      this._view = { ...this._view, focusedPageId: artifact.pages[0].id };
    }
    this._board.setArtifact(artifact, this._view);
    this._renderRail();
    this._renderInspector();
    this._live.refresh();
    this._syncArtboardProps();
    this._syncActivityBadge();
    const empty = this._el('board-empty');
    const isEmpty = artifact.pages.length === 0;
    if (empty) { empty.hidden = !isEmpty; }
    // The empty state promises "…or start from a template:" and then owns the
    // ONLY discoverable way to make a first artboard, because a fresh workspace
    // has no `.mysti/canvas/` and therefore no pages. The port from canvas.js
    // dropped `renderTemplateButtons(el('empty-templates'), …)`, so the panel
    // rendered that sentence above an empty div — the canvas looked broken on
    // first open, which is exactly when it must not.
    const templates = this._el('empty-templates');
    if (templates && isEmpty) { this._renderScaffolds(templates, 'tpl-btn'); }
    if (this._store.artifact) { this._reportRendered(); }
  }

  /**
   * The shipped rail: live thumbnails, device/legacy badges, drag-reorder.
   *
   * `deferWhileFocused` is for repaints the AGENT caused. `RailController
   * .render` is a `replaceChildren()`, so an op landing while a person is
   * arrow-keying the rail destroys the row that has focus and drops them onto
   * `<body>` — where the next arrow key nudges the selected ELEMENT on the
   * canvas instead. A human's own gesture always repaints immediately.
   */
  private _renderRail(opts?: { deferWhileFocused?: boolean }): void {
    const artifact = this._store.artifact;
    if (!artifact) { return; }
    if (opts?.deferWhileFocused && this._focusInside(RAIL_LIST_ID)) {
      this._pendingRender.rail = true;
      return;
    }
    this._pendingRender.rail = false;
    this._rail?.render(artifact, this._view);
  }

  /**
   * Repaint the properties panel.
   *
   * Same contract as {@link _renderRail}, and here it also protects DATA: the
   * inspector's text and number widgets commit on `change`, so a rebuild while
   * someone is part-way through typing "24" discards the "2" and the "4" with
   * no trace. `InspectorPanel` already defers a repaint for a slider drag; this
   * is the same rule for the keyboard.
   */
  private _renderInspector(opts?: { deferWhileFocused?: boolean }): void {
    const panel = this._inspector;
    if (!panel) { return; }
    if (opts?.deferWhileFocused && this._focusInside(INSPECTOR_BODY_ID)) {
      this._pendingRender.inspector = true;
      return;
    }
    this._pendingRender.inspector = false;
    const artifact = this._store.artifact;
    const { pageId, mids } = this._view.selection;
    const page = pageId ? this._store.page(pageId) : null;
    const doc = page ? pageDoc(page) : null;
    const nodes: DocNode[] = [];
    if (doc) {
      for (const mid of mids) {
        const node = findNode(doc, mid);
        if (node) { nodes.push(node); }
      }
    }
    panel.render({
      pageId: page ? pageId : null,
      mids: [...mids],
      nodes,
      doc,
      theme: artifact?.theme ?? null,
      legacy: !!page?.legacy,
    });
  }

  private _pageGeometry(pageId: string): { boardPos: { x: number; y: number }; size: { w: number; h: number } } | null {
    const artifact = this._store.artifact;
    const page = artifact?.pages.find(p => p.id === pageId);
    if (!artifact || !page) { return null; }
    const format = effectiveFormat(artifact, page, this._view);
    return { boardPos: page.boardPos, size: { w: format.width, h: format.height } };
  }

  /**
   * The capability chips, and the status line's honest count of what is off.
   *
   * `hello` carries caps too, and used to drop them on the floor - the chips
   * then appeared only if a later `canvas/caps` happened to arrive.
   */
  private _applyCaps(caps: readonly CapChip[]): void {
    const list = Array.isArray(caps) ? caps : [];
    this._live.setCaps(list);
    this._renderCaps(list);
  }

  /**
   * One chip per capability, connected or not.
   *
   * The difference used to be a CSS class and nothing else, inside a container
   * whose tooltip read "Connected capabilities" - so assistive tech announced
   * an unreachable Figma exactly like a live one, and in high contrast (where
   * `--accent-soft` is forced transparent and the HC border rule outranks
   * `.chip.on`) the two were near-indistinguishable visually as well. The name
   * and the glyph carry the state; colour is now the third cue, not the only.
   */
  private _renderCaps(caps: readonly CapChip[]): void {
    const host = this._el(CAPABILITY_CHIPS_ID);
    if (!host) { return; }
    // The container claimed every chip in it was connected.
    host.setAttribute('title', 'Capabilities');
    host.replaceChildren();
    for (const cap of caps) {
      const on = cap.enabled === true;
      const chip = this._env.doc.createElement('span');
      chip.className = on ? 'chip on' : 'chip';
      chip.setAttribute('data-on', on ? 'true' : 'false');
      chip.setAttribute('aria-label', `${cap.label} — ${on ? 'connected' : 'not connected'}`);
      chip.setAttribute('title', `${cap.label} — ${on ? 'connected' : 'not connected'}`);
      const mark = this._env.doc.createElement('span');
      mark.className = 'chip-mark';
      // Redundant to the accessible name, so it is hidden from the reader and
      // exists purely as the non-colour cue.
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = on ? '✓' : '–';
      chip.appendChild(mark);
      // A real text node, not a padded string: `.chip` is a flex ITEM whose own
      // children are inline boxes, and two adjacent spans with nothing between
      // them render as "✓fal.ai".
      chip.appendChild(this._env.doc.createTextNode(' '));
      const text = this._env.doc.createElement('span');
      text.className = 'chip-text';
      text.textContent = cap.label;
      chip.appendChild(text);
      host.appendChild(chip);
    }
  }

  /** @returns the first button built, so the caller can put focus on it. */
  private _renderScaffolds(
    menu: DomElement,
    className = 'sm-item',
    onChosen?: () => void,
  ): DomElement | null {
    menu.replaceChildren();
    let first: DomElement | null = null;
    for (const scaffold of this._boot.scaffolds) {
      const button = this._env.doc.createElement('button');
      button.className = className;
      button.setAttribute('type', 'button');
      button.textContent = scaffold.name;
      // `title` is not on the deliberately narrow DomElement seam; the attribute
      // form is, and gives the same hover hint.
      if (scaffold.description) { button.setAttribute('title', scaffold.description); }
      button.addEventListener('click', () => {
        this._client.send({ t: 'canvas/addScaffold', scaffold: scaffold.id });
        if (onChosen) { onChosen(); } else { menu.hidden = true; }
      });
      menu.appendChild(button);
      first = first ?? button;
    }
    return first;
  }

  /**
   * Open or close the template disclosure, and SAY so.
   *
   * `moveFocus` is for keyboard-driven opens and closes: on open the first
   * template takes focus, on close it goes back to the button that owns the
   * state - otherwise activating a template leaves focus on a node that has
   * just been hidden, i.e. on `<body>`.
   */
  private _setScaffoldsOpen(open: boolean, opts?: { moveFocus?: boolean }): void {
    const menu = this._el(SCAFFOLD_MENU_ID);
    const button = this._el(ADD_PAGE_ID);
    if (!menu) { return; }
    this._scaffoldsOpen = open;
    let first: DomElement | null = null;
    if (open) {
      first = this._renderScaffolds(menu, 'sm-item', () => this._setScaffoldsOpen(false, { moveFocus: true }));
    }
    menu.hidden = !open;
    button?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!opts?.moveFocus) { return; }
    focusElement(open ? first : button);
  }

  /* -------------------------------- notices -------------------------------- */

  /**
   * Put a failure in front of the human, in the region the shell ships for it.
   *
   * This replaces `_flash`, which wrote `#agent-activity` — the element the
   * liveness layer adopts as its permanent status label — and hid it 1.8 s
   * later, taking the status pill and its state dot with it (`canvas.css`
   * hangs both off `.agent-status:has(> .agent-activity:not([hidden]))`). The
   * one message that had nowhere else to go, a rejected op, now lands in
   * `#board-error`, which is `role="alert"` and stays put.
   *
   * @param autoClearMs transient notices only. A failed runtime fetch has no
   *   retry behind it, so it is left on screen rather than quietly withdrawn.
   */
  private _showBoardNotice(text: string, autoClearMs?: number): void {
    const banner = this._el(BOARD_ERROR_ID);
    if (!banner) { return; }
    const label = this._el(BOARD_ERROR_TEXT_ID) ?? banner;
    label.textContent = text;
    banner.hidden = false;
    this._clearNoticeTimer();
    if (autoClearMs === undefined) { return; }
    const handle = setTimeout(() => { this._noticeTimer = null; this._clearBoardNotice(); }, autoClearMs);
    // Node's timer would keep a test process alive; a browser has no `unref`.
    const maybe = handle as unknown as { unref?: () => void };
    if (typeof maybe.unref === 'function') { maybe.unref(); }
    this._noticeTimer = handle;
  }

  private _clearBoardNotice(): void {
    const banner = this._el(BOARD_ERROR_ID);
    if (!banner) { return; }
    const label = this._el(BOARD_ERROR_TEXT_ID) ?? banner;
    label.textContent = '';
    banner.hidden = true;
  }

  private _clearNoticeTimer(): void {
    if (this._noticeTimer === null) { return; }
    clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
  }

  private _noticeTimer: ReturnType<typeof setTimeout> | null = null;

  /* --------------------------------- focus --------------------------------- */

  /** True when the human's focus is inside the element with this id. */
  private _focusInside(hostId: string): boolean {
    const host = this._el(hostId);
    if (!host) { return false; }
    return containsNode(host, (this._env.doc as { activeElement?: unknown }).activeElement ?? null);
  }

  /**
   * Focus left a pane. Flush whatever repaint was withheld while it was there.
   *
   * `relatedTarget` (where focus is GOING) is the fact that matters: `focusout`
   * also fires when moving between two controls of the same pane, and
   * repainting then would yank focus off the control the human just reached.
   */
  private _onPaneFocusOut(hostId: string, ev: unknown): void {
    const host = this._el(hostId);
    const next = (ev as { relatedTarget?: unknown } | null | undefined)?.relatedTarget ?? null;
    if (host && next && containsNode(host, next)) { return; }
    if (hostId === RAIL_LIST_ID) {
      if (this._pendingRender.rail) { this._renderRail(); }
      return;
    }
    if (this._pendingRender.inspector) { this._renderInspector(); }
  }
}

interface FocusableLike { focus?: unknown }

/**
 * `DomElement` declares no `focus()` (see `dom.ts`), so this reaches it
 * structurally — the same way `rail.ts` does — and is a no-op where the host
 * DOM has none.
 */
function focusElement(el: DomElement | null): void {
  if (!el) { return; }
  const source = el as unknown as FocusableLike;
  if (typeof source.focus === 'function') { (source.focus as () => void).call(source); }
}

/**
 * Ancestor test across both DOMs this bundle runs in.
 *
 * A browser element has `contains`; the fake DOM the tests drive has a `parent`
 * chain instead. Neither is on the {@link DomElement} seam, which declares only
 * what the renderer WRITES, so this asks structurally and answers `false` when
 * it can do neither — the safe direction: the repaint simply happens.
 */
function containsNode(host: unknown, node: unknown): boolean {
  if (!host || !node) { return false; }
  const withContains = host as { contains?: unknown };
  if (typeof withContains.contains === 'function') {
    return (withContains.contains as (n: unknown) => boolean).call(host, node) === true;
  }
  let current: unknown = node;
  // Bounded: a cycle in a mocked parent chain must not hang the panel.
  for (let depth = 0; current && depth < 64; depth++) {
    if (current === host) { return true; }
    const step = current as { parentElement?: unknown; parentNode?: unknown; parent?: unknown };
    current = step.parentElement ?? step.parentNode ?? step.parent ?? null;
  }
  return false;
}

/** Re-exported so the bootstrap and tests share one name for the wire body. */
export type { CanvasClientBody };
