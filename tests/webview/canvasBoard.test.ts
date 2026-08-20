/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — "a renderer that doesn't reload".
 *
 * The headline claim of Phase 2 is falsifiable, so it is tested as such: after
 * an artboard is live, applying an edit must post a message down its port and
 * build ZERO new frame documents. `media/canvas/canvas.js` failed exactly this
 * — `renderBoard()` did `stage.innerHTML = ''` and re-inlined 3,144,476 bytes
 * of runtime on every artifact update and every window resize.
 */
import { describe, it, expect } from 'vitest';
import { BoardController, decideMode, DEFAULT_LIVE_ZOOM } from '../../src/webview/canvas/board';
import { initialViewState, planRender, type CanvasViewState } from '../../src/webview/canvas/state';
import type { CanvasEnv, DomDocument, DomElement, MessageChannelLike } from '../../src/webview/canvas/dom';
import type { CanvasOpRecord, WireArtifact } from '../../src/canvas/protocol';
import type { CanvasOp } from '../../src/canvas/CanvasOps';
import type { ArtifactPage, DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import {
  FakeChannel, FakeDocument, FakeElement, FakeIntersectionObserver,
} from './canvasFakeDom';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP = getFormat('desktop')!;

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

function v2(op: CanvasOp): CanvasOpRecord {
  return { opId: 'o1', txnId: 't', runId: 'r', author: 'agent', actorId: 'a', op, status: 'applied', ts: 0 } as unknown as CanvasOpRecord;
}

function legacyRecord(pageId: string): CanvasOpRecord {
  return { opId: 'l1', runId: 'r', kind: 'edit_page', targetPageId: pageId, proposedValue: {}, status: 'applied', author: 'agent', ts: 0 } as unknown as CanvasOpRecord;
}

interface Harness {
  env: CanvasEnv;
  doc: FakeDocument;
  world: FakeElement;
  channels: FakeChannel[];
  observer(): FakeIntersectionObserver | null;
  warnings: unknown[][];
}

function makeHarness(): Harness {
  const doc = new FakeDocument();
  const world = new FakeElement('div');
  const channels: FakeChannel[] = [];
  const warnings: unknown[][] = [];
  let observer: FakeIntersectionObserver | null = null;
  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: { addEventListener: () => { /* unused here */ } },
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
    warn: (...args) => { warnings.push(args); },
  };
  return { env, doc, world, channels, observer: () => observer, warnings };
}

function board(h: Harness, view: CanvasViewState = initialViewState()): BoardController {
  return new BoardController({
    env: h.env,
    world: h.world as unknown as DomElement,
    liveZoomThreshold: DEFAULT_LIVE_ZOOM,
  });
}

/** Bring every artboard live and open its port, as the browser would. */
function goLive(h: Harness, controller: BoardController, art: WireArtifact, view: CanvasViewState): void {
  controller.setArtifact(art, view);
  controller.setRuntime({ scripts: ['/* react */'], harness: '/* harness */' });
  const roots = h.world.children;
  h.observer()?.emit(roots.map(target => ({ target, isIntersecting: true })));
  for (const frame of h.doc.created.filter(e => e.tag === 'iframe')) { frame.fire('load'); }
}

describe('decideMode: virtualization is conservative', () => {
  const base = { intersecting: true, zoom: 1, liveZoomThreshold: 0.35, liveCount: 0, maxLive: 8, runtimeReady: true };
  it('goes live only when everything says yes', () => {
    expect(decideMode(base)).toBe('live');
    expect(decideMode({ ...base, intersecting: false })).toBe('preview');
    expect(decideMode({ ...base, zoom: 0.2 })).toBe('preview');
    expect(decideMode({ ...base, runtimeReady: false })).toBe('preview');
    expect(decideMode({ ...base, liveCount: 8 })).toBe('preview');
  });
});

describe('artboards mount lazily and stay static until they earn a frame', () => {
  it('renders previews with NO iframe before the runtime lands', () => {
    const h = makeHarness();
    const controller = board(h);
    controller.setArtifact(artifact([page('p1'), page('p2', 1600)]), initialViewState());
    expect(h.world.children).toHaveLength(2);
    expect(h.doc.countTag('iframe')).toBe(0);
    // ...and the static preview is real content, drawn by the parent.
    expect(h.world.allText()).toContain('p1');
    expect(h.world.allText()).toContain('p2');
  });

  it('mounts a frame only for artboards that intersect the viewport', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1'), page('p2', 1600)]);
    controller.setArtifact(art, initialViewState());
    controller.setRuntime({ scripts: [], harness: '' });
    h.observer()!.emit([
      { target: h.world.children[0], isIntersecting: true },
      { target: h.world.children[1], isIntersecting: false },
    ]);
    expect(h.doc.countTag('iframe')).toBe(1);
    expect(controller.liveCount).toBe(1);
  });

  it('drops back to static previews when the human zooms out', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    goLive(h, controller, art, initialViewState());
    expect(controller.liveCount).toBe(1);
    controller.setView({ ...initialViewState(), zoom: 0.1 });
    expect(controller.liveCount).toBe(0);
    expect(h.world.allText()).toContain('p1');   // the tile is still drawn
  });

  it('sandboxes every frame with allow-scripts and no same-origin', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    const frame = h.doc.created.find(e => e.tag === 'iframe')!;
    expect(frame.attrs.get('sandbox')).toBe('allow-scripts');
    expect(frame.attrs.get('sandbox')).not.toContain('allow-same-origin');
    expect(frame.srcdoc).toContain('<!doctype html>');
  });

  it('never inlines Babel into a document-model frame', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    const frame = h.doc.created.find(e => e.tag === 'iframe')!;
    expect(frame.srcdoc).not.toContain('BABEL_SENTINEL');
    // The bootstrap tree the doc-interpreting harness mounts from IS present.
    expect(frame.srcdoc).toContain('__mysti_page_doc');
    expect(frame.srcdoc).toContain('data-mode="doc"');
  });
});

describe('THE claim: an edit is a message, not a rebuild', () => {
  it('posts patch down the port and builds no new frame document', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    goLive(h, controller, art, initialViewState());

    const iframesBefore = h.doc.countTag('iframe');
    const buildsBefore = controller.buildCount;
    const port = h.channels[0].port1;
    const postsBefore = port.posted.length;

    // The store has already folded the op into the doc; the board only routes.
    art.pages[0].doc.children![0].text = 'Get started';
    controller.applyPlan(planRender([
      v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'Get started' }),
    ]));

    expect(h.doc.countTag('iframe')).toBe(iframesBefore);
    expect(controller.buildCount).toBe(buildsBefore);
    const patch = port.posted.slice(postsBefore).find(m => (m as { t: string }).t === 'patch');
    expect(patch).toBeDefined();
    expect((patch as { ops: CanvasOp[] }).ops).toHaveLength(1);
    // ...and the static preview underneath is refreshed from the same doc.
    expect(h.world.allText()).toContain('Get started');
  });

  it('mounts the doc down the port when the frame finishes loading', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    const mount = h.channels[0].port1.posted.find(m => (m as { t: string }).t === 'mount');
    expect(mount).toBeDefined();
    expect((mount as { doc: { tag: string } }).doc.tag).toBe('UI.Screen');
    expect((mount as { themeTokens: Record<string, string> }).themeTokens['color-primary']).toBeDefined();
    // The port itself was transferred INTO the frame, not left on window.
    const frame = h.doc.created.find(e => e.tag === 'iframe')!;
    expect(frame.contentWindow!.posts[0].transfer).toHaveLength(1);
  });

  it('rebuilds ONLY on an explicit reload, and reuses the same element', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    const iframesBefore = h.doc.countTag('iframe');
    const buildsBefore = controller.buildCount;
    controller.applyPlan(planRender([legacyRecord('p1')]));
    expect(controller.buildCount).toBe(buildsBefore + 1);
    expect(h.doc.countTag('iframe')).toBe(iframesBefore);   // no element churn
  });

  it('pushes a theme change down every port instead of rebuilding', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    const buildsBefore = controller.buildCount;
    const port = h.channels[0].port1;
    const before = port.posted.length;
    controller.applyPlan(planRender([v2({ op: 'theme.setToken', path: 'colors.primary', value: '#f00' })]));
    expect(controller.buildCount).toBe(buildsBefore);
    // A theme swap is a ~1 KB `mount` with fresh tokens, not a frame rebuild.
    const themed = port.posted.slice(before).find(m => (m as { t: string }).t === 'mount');
    expect(themed).toBeDefined();
    expect((themed as { themeTokens: Record<string, string> }).themeTokens['color-primary']).toBeDefined();
    // ...and the PARENT tile gets the same tokens as CSS custom properties.
    expect(h.world.children[0].style.get('--theme-color-primary')).toBeDefined();
  });

  it('ignores patches for artboards it does not have', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    expect(() => controller.applyPlan(planRender([
      v2({ op: 'el.setText', pageId: 'ghost', mid: 'bbbbbbbbbb', text: 'x' }),
    ]))).not.toThrow();
  });
});

/* ══════════════ R4-1 / R4-4 — a mount and a patch must never describe the
 * same op, and the label must follow the page ══════════════════════════════
 *
 * `CanvasStore.applyOps` folds the WHOLE batch into `page.doc` before the
 * board ever sees it (app.ts), so any message that carries a doc after that
 * point carries the POST-op tree. A theme/format re-mount that also carried the
 * doc therefore described the same `el.insert` the patch loop was about to
 * send, and the harness applies both: two nodes with one mid, `findNode` stops
 * at the first, and `plan.resync` is false so nothing repairs it.
 */
describe('R4-1 · a re-mount and a patch never describe the same op', () => {
  /** Everything the port was told since `from`, tagged. */
  function since(port: { posted: unknown[] }, from: number): Array<Record<string, unknown>> {
    return port.posted.slice(from) as Array<Record<string, unknown>>;
  }

  it('does not re-send an element op that rode the same batch as a theme op', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    goLive(h, controller, art, initialViewState());
    const port = h.channels[0].port1;
    const before = port.posted.length;
    const buildsBefore = controller.buildCount;

    // Exactly what the store does first: the insert is already in the doc.
    art.pages[0].doc.children!.push({ mid: 'cccccccccc', tag: 'UI.Text', text: 'new' });
    controller.applyPlan(planRender([
      v2({
        op: 'el.insert', pageId: 'p1', parentMid: 'aaaaaaaaaa', before: 'end',
        node: { mid: 'cccccccccc', tag: 'UI.Text', text: 'new' },
      }),
      v2({ op: 'theme.set', theme: THEME }),
    ]));

    const sent = since(port, before);
    // The theme still reaches the frame...
    const mounts = sent.filter(m => m.t === 'mount');
    expect(mounts).toHaveLength(1);
    expect((mounts[0].themeTokens as Record<string, string>)['color-primary']).toBeDefined();
    // ...and the frame is not rebuilt for it.
    expect(controller.buildCount).toBe(buildsBefore);
    // The insert is described EXACTLY ONCE. Before the fix the mount carried
    // the post-op doc and the patch applied the same insert on top of it, so
    // the live frame painted `cccccccccc` twice.
    expect(mounts[0].doc, 'the theme re-mount re-sent the whole post-op document').toBeUndefined();
    const patches = sent.filter(m => m.t === 'patch');
    expect(patches).toHaveLength(1);
    expect((patches[0].ops as CanvasOp[])).toHaveLength(1);
  });

  it('does not re-send an element op that rode the same batch as a format change', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    goLive(h, controller, art, initialViewState());
    const port = h.channels[0].port1;
    const before = port.posted.length;
    const buildsBefore = controller.buildCount;

    const mobile = getFormat('mobile')!;
    art.pages[0].doc.children![0].text = 'Get started';
    art.pages[0].format = mobile;
    controller.applyPlan(planRender([
      v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'Get started' }),
      v2({ op: 'page.setMeta', pageId: 'p1', patch: { format: mobile } }),
    ]));

    const sent = since(port, before);
    const mounts = sent.filter(m => m.t === 'mount');
    expect(mounts).toHaveLength(1);
    // The device change still reaches the DOCUMENT, not just the iframe box...
    expect((mounts[0].format as { width: number }).width).toBe(mobile.width);
    // ...without a rebuild, and without re-describing the text edit.
    expect(controller.buildCount).toBe(buildsBefore);
    expect(mounts[0].doc, 'the format re-mount re-sent the whole post-op document').toBeUndefined();
    expect(sent.filter(m => m.t === 'patch')).toHaveLength(1);
  });

  it('treats the port-open mount as authoritative for ops that arrived while the frame loaded', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    controller.setArtifact(art, initialViewState());
    controller.setRuntime({ scripts: [], harness: '' });
    h.observer()!.emit([{ target: h.world.children[0], isIntersecting: true }]);

    // The frame element exists but has NOT loaded, so there is no port yet.
    expect(h.channels).toHaveLength(0);
    art.pages[0].doc.children![0].text = 'A';
    controller.applyPlan(planRender([v2({ op: 'el.setText', pageId: 'p1', mid: 'bbbbbbbbbb', text: 'A' })]));

    h.doc.created.find(e => e.tag === 'iframe')!.fire('load');
    const posted = h.channels[0].port1.posted as Array<Record<string, unknown>>;
    const mount = posted.find(m => m.t === 'mount');
    // The mount is a full state transfer off the CURRENT doc, so it already
    // carries the edit...
    expect(((mount!.doc as { children: Array<{ text: string }> }).children[0]).text).toBe('A');
    // ...and replaying the queue on top of it would apply the same op twice.
    expect(posted.filter(m => m.t === 'patch'), 'the mount and a patch described the same op').toHaveLength(0);
  });
});

describe('R4-4 · the artboard label follows the page', () => {
  it('rewrites the label and the frame’s accessible name on a rename', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1')]);
    goLive(h, controller, art, initialViewState());
    const label = (): string => {
      const root = h.world.children[0];
      return root.children.find(c => c.className === 'artboard-label')?.textContent ?? '';
    };
    expect(label()).toBe('p1');

    art.pages[0].actionTitle = 'Sign in';
    controller.applyPlan(planRender([
      v2({ op: 'page.setMeta', pageId: 'p1', patch: { actionTitle: 'Sign in' } }),
    ]));

    // Before the fix `.artboard-label` was written once in `_createBoard` and
    // `_layout` never re-read the page, so the rail said "Sign in" and the
    // label sitting directly above the artboard still said "p1".
    expect(label(), 'the label above the artboard is stale').toBe('Sign in');
    const frame = h.doc.created.find(e => e.tag === 'iframe')!;
    expect(frame.attrs.get('title'), 'a screen reader entering the frame still hears the old name')
      .toBe('Sign in');
  });
});

describe('artboard lifecycle', () => {
  it('adds and removes artboard elements when the page list changes', () => {
    const h = makeHarness();
    const controller = board(h);
    const art = artifact([page('p1'), page('p2', 1600)]);
    controller.setArtifact(art, initialViewState());
    expect(controller.boardIds()).toEqual(['p1', 'p2']);
    art.pages = [art.pages[1]];
    controller.applyPlan(planRender([v2({ op: 'page.remove', pageId: 'p1' })]));
    expect(controller.boardIds()).toEqual(['p2']);
    expect(h.world.children).toHaveLength(1);
  });

  it('tears every frame and port down on dispose', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    controller.dispose();
    expect(h.world.children).toHaveLength(0);
    expect(h.channels[0].port1.closed).toBe(true);
    expect(h.observer()!.observed.size).toBe(0);
  });
});

describe('frame messages are untrusted data', () => {
  it('clamps an error message and refuses a forged mid', () => {
    const h = makeHarness();
    const seen: Array<{ pageId: string; message: string; mid?: string }> = [];
    const controller = new BoardController({
      env: h.env,
      world: h.world as unknown as DomElement,
      callbacks: { onFrameError: (pageId, message, mid) => seen.push({ pageId, message, mid }) },
    });
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    h.channels[0].port1.deliver({ t: 'error', message: 'x'.repeat(50000), mid: '<script>' });
    expect(seen).toHaveLength(1);
    // Capped by the SHARED validator in CanvasSandbox, not by a local guess.
    expect(seen[0].message.length).toBeLessThanOrEqual(4000);
    expect(seen[0].mid).toBeUndefined();
  });

  it('ignores junk from the frame without throwing', () => {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    // `hit` without a rect and `size` with Infinity are refused by the shared
    // validator, so a hostile frame cannot get a half-valid message acted on.
    for (const junk of [null, 42, 'ready', { t: 'unknown' }, { t: 'hit' }, { t: 'size', w: Infinity, h: 1 }]) {
      expect(() => h.channels[0].port1.deliver(junk)).not.toThrow();
    }
  });
});

describe('input over a live artboard (frames swallow events)', () => {
  // The reported bug: with the cursor over a frame, zoom and pan stopped
  // working entirely. An iframe receives wheel and pointer events in ITS OWN
  // document — a sandboxed opaque origin the parent cannot listen inside — so
  // the board never saw them. The frame now forwards them over its port.
  function liveBoard(): { controller: BoardController; port: FakeChannel['port1'] } {
    const h = makeHarness();
    const controller = board(h);
    goLive(h, controller, artifact([page('p1')]), initialViewState());
    expect(h.channels.length).toBeGreaterThan(0);
    return { controller, port: h.channels[0].port1 };
  }

  it('zooms from a wheel the frame forwards', () => {
    const { controller, port } = liveBoard();
    const before = controller.transform.zoom;
    port.deliver({
      t: 'wheel', deltaX: 0, deltaY: -240, deltaMode: 0,
      ctrlKey: true, metaKey: false, x: 200, y: 150,
    });
    expect(controller.transform.zoom, 'a forwarded ctrl-wheel must zoom the board').toBeGreaterThan(before);
  });

  it('pans from a forwarded wheel with no modifier', () => {
    const { controller, port } = liveBoard();
    const before = { ...controller.transform.pan };
    port.deliver({
      t: 'wheel', deltaX: 30, deltaY: 60, deltaMode: 0,
      ctrlKey: false, metaKey: false, x: 10, y: 10,
    });
    expect(controller.transform.pan, 'a forwarded bare wheel must pan the board').not.toEqual(before);
  });

  it('ignores a non-finite delta a hostile frame could send', () => {
    const { controller, port } = liveBoard();
    const before = JSON.stringify(controller.transform);
    port.deliver({
      t: 'wheel', deltaX: Number.NaN, deltaY: Number.POSITIVE_INFINITY, deltaMode: 0,
      ctrlKey: true, metaKey: false, x: 0, y: 0,
    });
    expect(JSON.stringify(controller.transform)).toBe(before);
  });
});
