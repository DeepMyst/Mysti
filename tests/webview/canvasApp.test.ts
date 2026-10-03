/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — the wiring seams between the canvas webview's modules.
 *
 * Every module below this one is already tested in isolation. This file tests
 * the joins, because the joins are what shipped broken: a board that reported a
 * multi-select as a single mid, an inspector whose `txnId` was thrown away and
 * re-minted at the transport (so a 60-frame slider drag became 60 undo steps),
 * arrow-nudge ops with no `onOps` handler at all, and a `canvas/history` push
 * with nowhere to land.
 *
 * `app.ts` takes its DOM by injection precisely so these are assertable without
 * a browser: the fake document below IS the shell, seeded with the same ids
 * `media/canvas/index.html` provides.
 */
import { describe, it, expect } from 'vitest';
import { CanvasApp } from '../../src/webview/canvas/app';
import type { CanvasBoot } from '../../src/webview/canvas/boot';
import type { CanvasEnv, DomDocument, MessageChannelLike } from '../../src/webview/canvas/dom';
import type { CanvasHostMessage, WireArtifact } from '../../src/canvas/protocol';
import type { ArtifactPage, DesignTheme } from '../../src/types';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import {
  FakeChannel, FakeDocument, FakeElement, FakeIntersectionObserver,
} from './canvasFakeDom';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP = getFormat('desktop')!;
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

/** Every id `media/canvas/index.html` provides that `app.ts` looks up. */
const SHELL_IDS = [
  'page-stage', 'board-scroll', 'board-overlay', 'board-empty',
  'zoom-level', 'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit',
  'rail-list', 'staged-rail', 'insp-body', 'version-timeline', 'history-toolbar',
  'artifact-name', 'agent-activity', 'capability-chips', 'scaffold-menu',
  'btn-present', 'btn-export', 'btn-add-page', 'onboarding', 'onboarding-dismiss',
  'empty-templates',
  // The shell's alert region and the steering dock. Both are shipped by
  // `index.html`; leaving them out of the rig hid two whole surfaces from the
  // seam tests (a failed runtime fetch reported nowhere, and a composer that
  // never mounted).
  'board-error', 'board-error-text', 'agent-comment',
];

const HEADING: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Heading', text: 'Welcome' };
const BUTTON: DocNode = {
  mid: 'bbbbbbbbbb', tag: 'UI.Button', props: { label: 'Sign in', variant: 'primary' },
};
const STACK: DocNode = { mid: 'cccccccccc', tag: 'UI.Stack', props: { gap: 12 } };

function page(id: string, x = 0): ArtifactPage {
  return {
    id, version: 2, boardPos: { x, y: 0 }, actionTitle: id,
    doc: { mid: 'root000000', tag: 'UI.Screen', children: [HEADING, BUTTON, STACK] },
  };
}

function artifact(pages: ArtifactPage[] = [page('p1'), page('p2', 1600)]): WireArtifact {
  return {
    id: 'art1', version: 7, kind: 'screens', name: 'Acme', format: DESKTOP,
    theme: THEME, pages, assets: [], updatedAt: 0, approvalMode: 'auto',
  };
}

function boot(): CanvasBoot {
  return {
    viewToken: TOKEN,
    runtimeUris: [], harnessUri: '', babelUri: '', innerCsp: '',
    devices: [{ formatId: DESKTOP.formatId, width: DESKTOP.width, height: DESKTOP.height, kind: DESKTOP.kind, label: 'Desktop' }],
    themes: [],
    scaffolds: [
      { id: 'login', name: 'Login', description: 'Email + password' },
      { id: 'dashboard', name: 'Dashboard', description: 'Sidebar + stats' },
    ],
  };
}

interface Rig {
  app: CanvasApp;
  doc: FakeDocument;
  posted: Array<Record<string, unknown>>;
  el(id: string): FakeElement;
  /** Fire a window-level listener (keydown, message, …). */
  fire(type: string, ev?: unknown): void;
  deliver(message: CanvasHostMessage): void;
  tick(ms: number): void;
  /** Posted messages of one tag, newest last. */
  sent(tag: string): Array<Record<string, unknown>>;
  warnings: unknown[][];
  /**
   * What the human's focus is on.
   *
   * `FakeDocument` has no focus model, so the rig owns one: `document
   * .activeElement` is the single fact `app.ts` reads to decide whether a pane
   * is being worked in. Real focus semantics are proved in the browser harness
   * (`canvasAppBrowser.test.ts`); this is the wiring decision.
   */
  focus(el: FakeElement | null): void;
  /** Runtime URLs the app actually fetched, in order. */
  fetched: string[];
}

interface RigOptions {
  boot?: Partial<CanvasBoot>;
  /** Resolve/reject per URL. Defaults to an immediate empty body. */
  fetchText?: (url: string) => Promise<string>;
}

function rig(options: RigOptions = {}): Rig {
  const doc = new FakeDocument();
  for (const id of SHELL_IDS) { doc.seed(id); }
  const posted: Array<Record<string, unknown>> = [];
  const warnings: unknown[][] = [];
  const fetched: string[] = [];
  const windowListeners = new Map<string, Array<(ev: unknown) => void>>();
  let clock = 0;

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
    fetchText: async (url: string) => {
      fetched.push(url);
      return options.fetchText ? options.fetchText(url) : '';
    },
    now: () => clock,
    warn: (...args) => { warnings.push(args); },
  };

  const app = new CanvasApp({
    boot: { ...boot(), ...options.boot },
    env,
    post: m => posted.push(m as Record<string, unknown>),
  });
  app.start();

  const fire = (type: string, ev: unknown = {}) => {
    for (const l of windowListeners.get(type) ?? []) { l(ev); }
  };
  return {
    app, doc, posted, warnings, fetched,
    el: id => doc.getElementById(id)!,
    fire,
    // Through the REAL intake path: source guard, shape guard, exhaustive switch.
    deliver: message => fire('message', { data: message, source: null }),
    tick: ms => { clock += ms; },
    sent: tag => posted.filter(m => m.t === tag),
    focus: el => { (doc as unknown as { activeElement: unknown }).activeElement = el; },
  };
}

function hello(r: Rig, art = artifact()): void {
  r.deliver({ t: 'canvas/hello', artifactId: art.id, artifact: art, viewToken: TOKEN, caps: [] });
}

/* ─────────────────────── seam 1 — board → host wiring ─────────────────────── */

describe('selection is reported as the board actually has it', () => {
  it('sends EVERY selected mid, not just the last hit', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [HEADING.mid, BUTTON.mid]);

    const selections = r.sent('canvas/selection');
    expect(selections).toHaveLength(1);
    expect(selections[0].pageId).toBe('p1');
    expect(selections[0].mids).toEqual([HEADING.mid, BUTTON.mid]);
    // The auth envelope is stamped by the transport, never by the caller.
    expect(selections[0].viewToken).toBe(TOKEN);
  });

  it('mirrors the selection into the app view state', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p2', [BUTTON.mid]);
    expect(r.app.view.selection).toEqual({ pageId: 'p2', mids: [BUTTON.mid] });
  });

  it('reports a CLEARED selection as an explicit empty on the page it left', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [HEADING.mid]);
    r.app.board.clearSelection();

    const selections = r.sent('canvas/selection');
    expect(selections).toHaveLength(2);
    expect(selections[1].pageId).toBe('p1');
    expect(selections[1].mids).toEqual([]);
    expect(r.app.view.selection.pageId).toBeNull();
  });

  it('says nothing when a clear arrives before anything was ever selected', () => {
    const r = rig();
    hello(r);
    r.app.board.clearSelection();
    expect(r.sent('canvas/selection')).toHaveLength(0);
  });
});

describe('pan/zoom keeps the app mirror in step', () => {
  it('adopts the board transform instead of drifting from it', () => {
    const r = rig();
    hello(r);
    r.app.board.setZoom(0.5);
    expect(r.app.view.zoom).toBeCloseTo(r.app.board.transform.zoom, 6);
    expect(r.app.view.zoom).toBeCloseTo(0.5, 6);
    expect(r.app.view.pan).toEqual(r.app.board.transform.pan);
  });
});

describe('arrow-nudge ops reach the wire', () => {
  it('submits the el.setStyle the board produced', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [BUTTON.mid]);
    r.fire('keydown', { key: 'ArrowRight', preventDefault: () => { /* noop */ } });

    const submits = r.sent('canvas/submit');
    expect(submits).toHaveLength(1);
    expect((submits[0].ops as Array<{ op: string; mid: string }>)[0].op).toBe('el.setStyle');
    expect((submits[0].ops as Array<{ op: string; mid: string }>)[0].mid).toBe(BUTTON.mid);
    // Base versions cover the artifact AND every page: the host decides
    // staleness per scope (§3.2), so both have to be on the wire.
    expect(submits[0].baseVersions).toEqual({ art1: 7, p1: 2, p2: 2 });
  });
});

describe('focus follows the human', () => {
  it('records the focused artboard so a device switch knows what it targets', () => {
    const r = rig();
    hello(r);
    expect(r.app.view.focusedPageId).toBe('p1');
    r.app.rail!.render(artifact(), r.app.view);
    // The rail's own select callback is the same seam the board's onFocusPage
    // uses; drive it through the rendered row.
    const row = r.el('rail-list').children.find(c => c.attrs.get('data-id') === 'p2')!;
    row.fire('click');
    expect(r.app.view.focusedPageId).toBe('p2');
  });
});

/* ──────────────── seam 2 — inline text + inspector submission ──────────────── */

describe('the submitted txnId is the producer’s, not a fresh one', () => {
  it('keeps a whole slider drag inside ONE transaction', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [STACK.mid]);

    const gapRow = r.el('insp-body').find(el => el.attrs.get('data-control') === 'prop:gap')!;
    const slider = gapRow.find(el => el.tag === 'input')!;
    for (let i = 0; i < 20; i++) {
      slider.value = String(i);
      slider.fire('input');
      r.tick(16);
    }
    slider.value = '40';
    slider.fire('change');

    const submits = r.sent('canvas/submit');
    expect(submits.length).toBeGreaterThan(1);
    expect(new Set(submits.map(s => s.txnId as string)).size).toBe(1);
    expect(submits[submits.length - 1].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: STACK.mid, name: 'gap', value: 40 },
    ]);
  });

  it('mints DISTINCT ids for two gestures inside the same millisecond', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [BUTTON.mid]);
    r.fire('keydown', { key: 'ArrowRight', preventDefault: () => { /* noop */ } });
    r.fire('keydown', { key: 'ArrowLeft', preventDefault: () => { /* noop */ } });

    const ids = r.sent('canvas/submit').map(s => s.txnId as string);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);          // `Date.now()` alone collides here
  });
});

describe('inline text editing is routed through the editor', () => {
  it('reaches the frame port, reports editing, and commits el.setText', () => {
    const r = rig();
    hello(r);
    // The board hands the app (pageId, mid); the app resolves the node from the
    // STORE, which is the authority on what exists.
    r.app.textEditor.begin('p1', HEADING.mid, HEADING);
    expect(r.app.textEditor.active).toEqual({ pageId: 'p1', mid: HEADING.mid, startedAt: 0 });

    const editing = r.sent('canvas/editing');
    expect(editing).toHaveLength(1);
    expect(editing[0]).toMatchObject({ pageId: 'p1', mids: [HEADING.mid], editing: true });

    const outcome = r.app.textEditor.commit('p1', HEADING.mid, 'Get started', HEADING);
    expect(outcome.ok).toBe(true);
    const submits = r.sent('canvas/submit');
    expect(submits).toHaveLength(1);
    expect(submits[0].ops).toEqual([
      { op: 'el.setText', pageId: 'p1', mid: HEADING.mid, text: 'Get started' },
    ]);
    expect(typeof submits[0].txnId).toBe('string');
  });

  it('refuses to open on a node the doc does not have', () => {
    const r = rig();
    hello(r);
    expect(r.app.textEditor.begin('p1', 'zzzzzzzzzz', null)).toBe(false);
    expect(r.sent('canvas/editing')).toHaveLength(0);
  });
});

/* ────────────────────── seam 3 — canvas/history + the rail ────────────────────── */

describe('canvas/history lands in the history UI', () => {
  it('routes the host snapshot into HistoryUi rather than mirroring a stack', () => {
    const r = rig();
    hello(r);
    r.deliver({
      t: 'canvas/history',
      status: {
        canUndo: true, canRedo: false, position: 3,
        undo: { txnId: 't3', label: 'set text', author: 'agent', ops: 1, kinds: ['edit_element'], ts: 0 },
        transactions: [], versions: [],
      },
    } as CanvasHostMessage);

    expect(r.app.history.status()?.canUndo).toBe(true);
    expect(r.app.history.status()?.position).toBe(3);
    const undo = r.el('history-toolbar').find(el => el.className === 'history-btn undo')!;
    expect(undo.attrs.get('disabled')).toBeUndefined();
    const redo = r.el('history-toolbar').find(el => el.className === 'history-btn redo')!;
    expect(redo.attrs.get('disabled')).toBe('true');

    undo.fire('click');
    expect(r.sent('canvas/undo')).toHaveLength(1);
  });
});

describe('the rail is the shipped rail', () => {
  it('renders a row per artboard with its device badge and actions', () => {
    const r = rig();
    hello(r);
    const rows = r.el('rail-list').children;
    expect(rows).toHaveLength(2);
    expect(rows[0].attrs.get('data-id')).toBe('p1');
    expect(rows[0].find(el => el.className === 'thumb-badge device')?.textContent)
      .toContain('Desktop');
    // Three actions per row (insert / duplicate / delete) — the inline rail this
    // replaced had none of them.
    expect(rows[0].findAll(el => el.className === 'thumb-action')).toHaveLength(3);
  });

  it('submits a real op when a row action is used', () => {
    const r = rig();
    hello(r);
    const duplicate = r.el('rail-list').children[0]
      .findAll(el => el.className === 'thumb-action')[1];
    duplicate.fire('click', { preventDefault: () => { /* noop */ }, stopPropagation: () => { /* noop */ } });

    const submits = r.sent('canvas/submit');
    expect(submits).toHaveLength(1);
    expect(submits[0].ops).toEqual([{ op: 'page.duplicate', pageId: 'p1' }]);
  });
});

/* ───────────────────────── seam 4 — liveness routing ───────────────────────── */

describe('liveness is fed from the wire', () => {
  it('turns canvas/job into a ghost artboard with a working Cancel', () => {
    const r = rig();
    hello(r);
    r.deliver({
      t: 'canvas/job',
      event: { jobId: 'j1', type: 'started', label: 'Designing settings' } as never,
    });
    expect(r.app.liveness.jobs.size).toBe(1);
    expect(r.app.liveness.ghostCount).toBe(1);

    const ghost = r.el('page-stage').find(el => el.className === 'ghost-artboard')!;
    ghost.find(el => el.className === 'ghost-cancel')!.fire('click');
    expect(r.sent('canvas/cancelJob')[0]).toMatchObject({ jobId: 'j1' });
  });

  it('routes canvas/staged into the suggestions rail', () => {
    const r = rig();
    hello(r);
    r.deliver({
      t: 'canvas/staged',
      records: [{
        opId: 'o1', txnId: 't1', runId: 'r1', author: 'agent', actorId: 'mysti',
        op: { op: 'el.setText', pageId: 'p1', mid: HEADING.mid, text: 'Hello' },
        status: 'staged', ts: 0,
      }] as never,
    });
    expect(r.app.liveness.stagedCount).toBe(1);
    expect(r.el('staged-rail').hidden).toBe(false);
  });

  it('draws an agent cursor from canvas/agentCursor', () => {
    const r = rig();
    hello(r);
    r.deliver({ t: 'canvas/agentCursor', pageId: 'p1', mid: BUTTON.mid, label: 'mysti' });
    const cursor = r.el('board-overlay').find(el => el.className === 'agent-cursor');
    expect(cursor).not.toBeNull();
    expect(cursor!.find(el => el.className === 'agent-cursor-label')?.textContent).toBe('mysti');
  });

  it('forwards a frame error to BOTH the on-artboard card and the host', () => {
    const r = rig();
    hello(r);
    // The board's frame-error callback is the app's; drive it as a frame would.
    r.app.liveness.onFrameError('p1', 'boom', BUTTON.mid);
    expect(r.app.liveness.errorCount).toBe(1);
    expect(r.el('board-overlay').find(el => el.className === 'frame-error-card')).not.toBeNull();
  });

  it('shares the overlay and the world with the board without either wiping the other', () => {
    const r = rig();
    hello(r);
    r.deliver({ t: 'canvas/agentCursor', pageId: 'p1', mid: BUTTON.mid, label: 'mysti' });
    r.deliver({ t: 'canvas/job', event: { jobId: 'j1', type: 'started', label: 'Designing' } as never });

    // A human selection redraws the overlay; a resync re-syncs the world. Both
    // hosts are shared with the liveness layer, so neither may clear them.
    r.app.board.select('p1', [HEADING.mid]);
    r.deliver({ t: 'canvas/resync', artifact: artifact(), artifactVersion: 8 });

    expect(r.el('board-overlay').find(el => el.className === 'agent-cursor')).not.toBeNull();
    expect(r.el('page-stage').find(el => el.className === 'ghost-artboard')).not.toBeNull();
  });

  it('applies a speculative patch as a board delta, never as a reload', () => {
    const r = rig();
    hello(r);
    const before = r.app.board.buildCount;
    r.deliver({
      t: 'canvas/job',
      event: {
        jobId: 'j2', type: 'progress',
        spec: { pageId: 'p1', seq: 1, ops: [{ op: 'el.setText', pageId: 'p1', mid: HEADING.mid, text: 'Draft' }] },
      } as never,
    });
    expect(r.app.board.buildCount).toBe(before);
  });
});

/* ──────────────────────────── the shell contract ──────────────────────────── */

describe('the shell provides every host the app mounts into', () => {
  it('boots, says canvas/ready, and paints the artifact name', () => {
    const r = rig();
    expect(r.sent('canvas/ready')).toHaveLength(1);
    hello(r);
    expect(r.el('artifact-name').textContent).toBe('Acme');
    expect(r.el('board-empty').hidden).toBe(true);
  });

  it('asks for a resync when records skip a version instead of guessing', () => {
    const r = rig();
    hello(r);
    r.deliver({ t: 'canvas/ops', records: [], artifactVersion: 99 });
    const ready = r.sent('canvas/ready');
    expect(ready).toHaveLength(2);
    expect(ready[1]).toMatchObject({ artifactId: 'art1', haveVersion: 7 });
  });
});

/* ───────────── the empty state — the only way in on a fresh workspace ───────────── */

describe('the empty state offers a first artboard', () => {
  // A fresh workspace has no `.mysti/canvas/`, so the artifact is legitimately
  // empty and this is the user's ONLY discoverable path to a first page. The
  // port from canvas.js dropped `renderTemplateButtons(el('empty-templates'))`,
  // so the panel rendered "…or start from a template:" above an empty div — the
  // canvas looked broken at exactly the moment it must not.
  it('renders a quick-start button per scaffold', () => {
    const r = rig();
    hello(r, artifact([]));
    expect(r.el('board-empty').hidden).toBe(false);
    expect(r.el('empty-templates').children.map(c => c.textContent)).toEqual(['Login', 'Dashboard']);
  });

  it('a quick-start button asks the host to add that scaffold', () => {
    const r = rig();
    hello(r, artifact([]));
    r.el('empty-templates').children[0].fire('click');
    expect(r.sent('canvas/addScaffold')).toContainEqual(
      expect.objectContaining({ t: 'canvas/addScaffold', scaffold: 'login' }),
    );
  });

  it('hides the empty state once a page exists', () => {
    const r = rig();
    hello(r);
    expect(r.el('board-empty').hidden).toBe(true);
  });
});

/* ═══════════════ the wiring seams the UI review found leaking ═══════════════ */

/** One committed agent op, delivered exactly as `CanvasBridge` pushes it. */
function agentEdit(r: Rig, version = 8, text = 'Agent wrote this'): void {
  r.deliver({
    t: 'canvas/ops',
    records: [{
      opId: `o${version}`, txnId: `t${version}`, runId: 'r1', author: 'agent', actorId: 'mysti',
      op: { op: 'el.setText', pageId: 'p1', mid: HEADING.mid, text },
      status: 'applied', ts: 0,
    }] as never,
    artifactVersion: version,
  });
}

/** Let a chain of already-resolved promises inside the app settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) { await Promise.resolve(); }
}

/* ───────── A11Y-4 — an agent op must not destroy focus or in-progress typing ───────── */

describe('an agent op leaves the pane the human is working in alone', () => {
  it('does not rebuild the inspector out from under a half-typed value', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [STACK.mid]);
    const body = r.el('insp-body');
    const gapRow = body.find(el => el.attrs.get('data-control') === 'prop:gap')!;
    const slider = gapRow.find(el => el.tag === 'input')!;
    // Typed, NOT committed: the inspector's widgets only emit on `change`.
    slider.value = '24';
    r.focus(slider);

    agentEdit(r);

    expect(body.find(el => el === slider), 'the focused control survived the agent op').not.toBeNull();
    expect(slider.value).toBe('24');
  });

  it('repaints the inspector as soon as focus leaves it', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [STACK.mid]);
    const body = r.el('insp-body');
    const slider = body.find(el => el.attrs.get('data-control') === 'prop:gap')!.find(el => el.tag === 'input')!;
    r.focus(slider);
    agentEdit(r);
    expect(body.find(el => el === slider), 'the repaint was deferred, not skipped').not.toBeNull();

    r.focus(null);
    body.fire('focusout', { relatedTarget: null });
    expect(body.find(el => el === slider), 'the deferred repaint ran on blur').toBeNull();
    expect(body.find(el => el.attrs.get('data-control') === 'prop:gap')).not.toBeNull();
  });

  it('does not repaint while focus only moves between two controls of the same pane', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [STACK.mid]);
    const body = r.el('insp-body');
    const inputs = body.findAll(el => el.tag === 'input');
    r.focus(inputs[0]);
    agentEdit(r);

    body.fire('focusout', { relatedTarget: inputs[1] });
    expect(body.find(el => el === inputs[0])).not.toBeNull();
  });

  it('keeps a focused rail row alive across an agent op', () => {
    const r = rig();
    hello(r);
    const row = r.el('rail-list').children[0];
    r.focus(row);

    agentEdit(r);

    expect(r.el('rail-list').children[0]).toBe(row);
  });

  it('still repaints both panes when the human is not in either', () => {
    const r = rig();
    hello(r);
    const row = r.el('rail-list').children[0];
    agentEdit(r, 8, 'Rewritten');

    expect(r.el('rail-list').children[0]).not.toBe(row);
    expect(r.el('rail-list').children).toHaveLength(2);
  });
});

/* ───────── A11Y-6 — the template disclosure has to say what it does ───────── */

describe('the “add a page from a template” disclosure', () => {
  it('reports its expanded state and what it controls', () => {
    const r = rig();
    hello(r);
    const button = r.el('btn-add-page');
    expect(button.attrs.get('aria-expanded')).toBe('false');
    expect(button.attrs.get('aria-controls')).toBe('scaffold-menu');

    button.fire('click');
    expect(r.el('scaffold-menu').hidden).toBe(false);
    expect(button.attrs.get('aria-expanded')).toBe('true');

    button.fire('click');
    expect(r.el('scaffold-menu').hidden).toBe(true);
    expect(button.attrs.get('aria-expanded')).toBe('false');
  });

  it('closes on Escape — the universal dismissal', () => {
    const r = rig();
    hello(r);
    const button = r.el('btn-add-page');
    button.fire('click');

    r.fire('keydown', { key: 'Escape', preventDefault: () => { /* noop */ } });

    expect(r.el('scaffold-menu').hidden).toBe(true);
    expect(button.attrs.get('aria-expanded')).toBe('false');
  });

  it('closes once a template is chosen, and still asks the host for it', () => {
    const r = rig();
    hello(r);
    const button = r.el('btn-add-page');
    button.fire('click');
    r.el('scaffold-menu').children[0].fire('click');

    expect(r.sent('canvas/addScaffold')).toHaveLength(1);
    expect(r.el('scaffold-menu').hidden).toBe(true);
    expect(button.attrs.get('aria-expanded')).toBe('false');
  });

  it('claims Escape only while it is open, so the board keeps the key otherwise', () => {
    const r = rig();
    hello(r);
    let prevented = false;
    r.fire('keydown', { key: 'Escape', preventDefault: () => { prevented = true; } });
    expect(prevented, 'a closed disclosure must not swallow Escape').toBe(false);

    r.el('btn-add-page').fire('click');
    r.fire('keydown', { key: 'Escape', preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });
});

/* ───────── CANVAS-W3 / CANVAS-W6 — the status label and the alert region ───────── */

describe('failures land in the shell’s alert region, not in a vanishing toast', () => {
  it('reports a failed runtime fetch instead of only warning the console', async () => {
    const r = rig({
      boot: { runtimeUris: ['react.js'], harnessUri: 'harness.js' },
      fetchText: async () => { throw new Error('404'); },
    });
    await settle();

    expect(r.el('board-error').hidden).toBe(false);
    expect(r.el('board-error-text').textContent ?? '').toContain('static previews');
  });

  it('reports a rejected op there too', () => {
    const r = rig();
    hello(r);
    r.deliver({
      t: 'canvas/receipt',
      receipt: { opId: 'o1', status: 'rejected', artifactVersion: 7, error: 'a pinned cell refused it' } as never,
    });
    expect(r.el('board-error').hidden).toBe(false);
    expect(r.el('board-error-text').textContent ?? '').toContain('pinned cell');
  });

  it('never writes the persistent status label the liveness layer owns', () => {
    const r = rig();
    hello(r);
    agentEdit(r);
    r.deliver({ t: 'canvas/job', event: { jobId: 'j1', type: 'started', label: 'Designing settings' } as never });
    r.deliver({ t: 'canvas/agentCursor', pageId: 'p1', mid: BUTTON.mid, label: 'mysti' });

    // `#agent-activity` is `LivenessLayer`'s label. The app writing it is what
    // blanked the whole status pill 1.8 s later.
    expect(r.el('agent-activity').textContent).toBeNull();
  });
});

/* ───────── CANVAS-W4 — Babel is needed by whichever pages actually exist ───────── */

describe('the JSX compiler follows the artifact, not the boot order', () => {
  it('fetches it when a legacy artboard arrives after the runtime settled', async () => {
    const r = rig({
      boot: { runtimeUris: ['react.js'], harnessUri: 'harness.js', babelUri: 'babel.js' },
    });
    await settle();
    expect(r.fetched).not.toContain('babel.js');

    const legacy: ArtifactPage = { ...page('p1'), legacy: { mode: 'jsx', source: 'function Page(){}' } };
    hello(r, artifact([legacy]));
    await settle();

    expect(r.fetched).toContain('babel.js');
  });

  it('fetches it exactly once, however many ops follow', async () => {
    const r = rig({
      boot: { runtimeUris: ['react.js'], harnessUri: 'harness.js', babelUri: 'babel.js' },
    });
    await settle();
    const legacy: ArtifactPage = { ...page('p1'), legacy: { mode: 'jsx', source: 'function Page(){}' } };
    hello(r, artifact([legacy, page('p2', 1600)]));
    await settle();
    agentEdit(r, 8);
    await settle();

    expect(r.fetched.filter(u => u === 'babel.js')).toHaveLength(1);
  });

  it('does not fetch it for a design with no legacy artboard', async () => {
    const r = rig({
      boot: { runtimeUris: ['react.js'], harnessUri: 'harness.js', babelUri: 'babel.js' },
    });
    await settle();
    hello(r);
    await settle();
    expect(r.fetched).not.toContain('babel.js');
  });
});

/* ───────── CANVAS-W5 / SYNC-7 — the steering seams that had no call sites ───────── */

describe('element-scoped steering is actually wired', () => {
  it('offers “Ask Mysti” on a single-element selection and points the composer at it', () => {
    const r = rig();
    hello(r);
    r.app.board.select('p1', [HEADING.mid]);

    const ask = r.el('insp-body').find(el => el.className === 'insp-ask');
    expect(ask, 'the inspector draws Ask Mysti when the seam is wired').not.toBeNull();
    ask!.fire('click');

    expect(r.app.liveness.commentTarget()).toMatchObject({ pageId: 'p1', mid: HEADING.mid });
  });

  it('names artboards by their title in the status line', () => {
    const r = rig();
    hello(r, artifact([{ ...page('p1'), actionTitle: 'Login' }, page('p2', 1600)]));
    r.deliver({
      t: 'canvas/job',
      event: { jobId: 'j1', type: 'started', label: 'Designing', pageId: 'p1' } as never,
    });
    expect(r.app.liveness.status().detail).toContain('Login');
  });

  it('draws “Show” on a staged row and jumps the board to that artboard', () => {
    const r = rig();
    hello(r);
    r.deliver({
      t: 'canvas/staged',
      records: [{
        opId: 'o1', txnId: 't1', runId: 'r1', author: 'agent', actorId: 'mysti',
        op: { op: 'el.setText', pageId: 'p2', mid: HEADING.mid, text: 'Hello' },
        status: 'staged', ts: 0,
      }] as never,
    });

    const show = r.el('staged-rail').find(el => el.className === 'sr-reveal');
    expect(show, 'a review row can point at what it is about').not.toBeNull();
    show!.fire('click');
    expect(r.app.view.focusedPageId).toBe('p2');
  });

  it('says an empty review queue is where suggestions will land', () => {
    const r = rig();
    hello(r, { ...artifact(), approvalMode: 'staged' });
    expect(r.el('staged-rail').hidden).toBe(false);
    expect(r.el('staged-rail').allText()).toContain('arrive here');
  });

  it('renders the capability chips that arrive with hello, not only a later push', () => {
    const r = rig();
    r.deliver({
      t: 'canvas/hello',
      artifactId: 'art1',
      artifact: artifact(),
      viewToken: TOKEN,
      caps: [{ slug: 'image', label: 'fal.ai', enabled: false, source: 'off' }] as never,
    });
    expect(r.el('capability-chips').children).toHaveLength(1);
    expect(r.app.liveness.status().detail).toContain('not connected');
  });
});

/* ───────── SYNC-8 — a chip must say whether it is connected ───────── */

describe('capability chips are honest without colour', () => {
  it('names each chip connected / not connected', () => {
    const r = rig();
    r.deliver({
      t: 'canvas/caps',
      caps: [
        { slug: 'image', label: 'fal.ai', enabled: false, source: 'off' },
        { slug: 'figma', label: 'Figma', enabled: true, source: 'deepmyst' },
      ] as never,
    });
    const chips = r.el('capability-chips').children;
    expect(chips[0].attrs.get('aria-label')).toBe('fal.ai — not connected');
    expect(chips[1].attrs.get('aria-label')).toBe('Figma — connected');
    // The container's tooltip claimed every chip in it was connected.
    expect(r.el('capability-chips').attrs.get('title')).toBe('Capabilities');
  });

  it('carries a non-colour cue for the off state', () => {
    const r = rig();
    r.deliver({
      t: 'canvas/caps',
      caps: [
        { slug: 'image', label: 'fal.ai', enabled: false, source: 'off' },
        { slug: 'figma', label: 'Figma', enabled: true, source: 'deepmyst' },
      ] as never,
    });
    const chips = r.el('capability-chips').children;
    const mark = (chip: FakeElement): string | null =>
      chip.find(el => el.className === 'chip-mark')?.textContent ?? null;
    expect(mark(chips[0])).not.toBeNull();
    expect(mark(chips[0])).not.toBe(mark(chips[1]));
    expect(chips[0].attrs.get('data-on')).toBe('false');
    expect(chips[1].attrs.get('data-on')).toBe('true');
  });
});

/* A structural op is the one repaint the rail may not withhold. */
describe('a deferred rail repaint never outlives the rows it is about', () => {
  it('repaints immediately when pages were added or removed, focus or not', () => {
    const r = rig();
    hello(r);
    const row = r.el('rail-list').children[0];
    r.focus(row);

    r.deliver({
      t: 'canvas/ops',
      records: [{
        opId: 'o8', txnId: 't8', runId: 'r1', author: 'agent', actorId: 'mysti',
        op: { op: 'page.remove', pageId: 'p2' },
        status: 'applied', ts: 0,
      }] as never,
      artifactVersion: 8,
    });

    // A row for a page that no longer exists is worse than a lost tab stop:
    // clicking it would submit ops against nothing.
    expect(r.el('rail-list').children).toHaveLength(1);
    expect(r.el('rail-list').children[0].attrs.get('data-id')).toBe('p1');
  });
});
