/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * P1 / P2 — authorship is a property of the CHANNEL, never of the payload.
 *
 * `protocol.ts` states the trust model as: model-authored page source "can
 * neither read the token nor reach postMessage on the host channel. So a
 * prompt-injected page cannot forge canvas/submit and have its op stamped
 * author: 'user'." That held only for a `doc` artboard.
 *
 * A **legacy** artboard executes model-authored JavaScript INSIDE the sandbox
 * frame, in the same realm and same window as `harness.js`, under
 * `SANDBOX_INNER_CSP` (`script-src 'unsafe-inline' 'unsafe-eval'`). The board
 * transferred the frame's `MessageChannel` port through that frame's `window`,
 * so any script in it could read `ev.ports[0]` off the handshake event — and for
 * `html` mode the page's own inline script is parsed BEFORE the harness tag, so
 * it could register first and `stopImmediatePropagation()` the handshake,
 * binding the port exclusively. From there `{t:'hit', double:true}` followed by
 * `{t:'textCommit'}` produced an `el.setText` that `CanvasBridge` stamps
 * `author:'user'` with `'auto'` approval — applied even in `staged` mode,
 * written into the shared undo stack as a human "Canvas edit", and pinned by
 * `_writePins` so no later agent op could touch it. A model-authored page
 * claiming to be the human collapses the entire pin/co-edit model.
 *
 * The fix is structural: a frame that runs model-authored script is never handed
 * a port at all, and nothing a frame says is accepted from an untrusted channel.
 * P2 is the same reasoning one level down — the frame must not be the sole
 * witness to its own authorisation, so a `textCommit` is honoured only for a
 * node the PARENT opened an edit on.
 */
import { describe, it, expect } from 'vitest';
import { BoardController, DEFAULT_LIVE_ZOOM } from '../../src/webview/canvas/board';
import { initialViewState, type CanvasViewState } from '../../src/webview/canvas/state';
import type { CanvasEnv, DomDocument, DomElement, MessageChannelLike } from '../../src/webview/canvas/dom';
import type { WireArtifact } from '../../src/canvas/protocol';
import type { ArtifactPage, DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import {
  FakeChannel, FakeDocument, FakeElement, FakeIntersectionObserver,
} from './canvasFakeDom';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP = getFormat('desktop')!;

function docPage(id: string, x = 0): ArtifactPage {
  return {
    id, version: 1, boardPos: { x, y: 0 }, actionTitle: id,
    doc: { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: id }] },
  };
}

/** The escape hatch: a page whose source the compiler could not accept. */
function legacyHtmlPage(id: string, x = 0): ArtifactPage {
  return {
    ...docPage(id, x),
    legacy: { mode: 'html', source: '<div>hi</div><script>/* model-authored */</script>' },
  };
}

function legacyJsxPage(id: string, x = 0): ArtifactPage {
  return { ...docPage(id, x), legacy: { mode: 'jsx', source: 'function Page(){ return null; }' } };
}

function artifact(pages: ArtifactPage[]): WireArtifact {
  return {
    id: 'art1', version: 1, kind: 'screens', name: 'Acme', format: DESKTOP,
    theme: THEME, pages, assets: [], updatedAt: 0, approvalMode: 'auto',
  };
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

interface Seen {
  hits: Array<{ pageId: string; mid: string }>;
  edits: Array<{ pageId: string; mid: string }>;
  commits: Array<{ pageId: string; mid: string; text: string }>;
  sizes: Array<{ pageId: string; w: number; h: number }>;
}

function board(h: Harness, seen: Seen): BoardController {
  return new BoardController({
    env: h.env,
    world: h.world as unknown as DomElement,
    liveZoomThreshold: DEFAULT_LIVE_ZOOM,
    callbacks: {
      onHit: (pageId, mid) => seen.hits.push({ pageId, mid }),
      onBeginTextEdit: (pageId, mid) => seen.edits.push({ pageId, mid }),
      onTextCommit: (pageId, mid, text) => seen.commits.push({ pageId, mid, text }),
      onSize: (pageId, size) => seen.sizes.push({ pageId, w: size.w, h: size.h }),
    },
  });
}

function emptySeen(): Seen { return { hits: [], edits: [], commits: [], sizes: [] }; }

function goLive(h: Harness, controller: BoardController, art: WireArtifact, view: CanvasViewState = initialViewState()): void {
  controller.setArtifact(art, view);
  controller.setRuntime({ scripts: ['/* react */'], harness: '/* harness */' });
  h.observer()?.emit(h.world.children.map(target => ({ target, isIntersecting: true })));
  for (const frame of h.doc.created.filter(e => e.tag === 'iframe')) { frame.fire('load'); }
}

function frames(h: Harness): FakeElement[] {
  return h.doc.created.filter(e => e.tag === 'iframe');
}

describe('P1: a legacy artboard never receives the privileged port', () => {
  it('mounts a legacy html frame but transfers NO MessagePort into it', () => {
    const h = makeHarness();
    const seen = emptySeen();
    const controller = board(h, seen);
    goLive(h, controller, artifact([legacyHtmlPage('p1')]));

    // The artboard still renders — degradation is visible, not silent.
    expect(frames(h)).toHaveLength(1);
    expect(controller.liveCount).toBe(1);
    // …but no channel was ever created, so there is nothing for page script to
    // steal off the handshake event.
    expect(h.channels).toHaveLength(0);
    expect(frames(h)[0].contentWindow!.posts).toHaveLength(0);
  });

  it('does the same for a legacy jsx frame (Babel + new Function runs model source)', () => {
    const h = makeHarness();
    const controller = board(h, emptySeen());
    goLive(h, controller, artifact([legacyJsxPage('p1')]));
    expect(frames(h)).toHaveLength(1);
    expect(h.channels).toHaveLength(0);
    expect(frames(h)[0].contentWindow!.posts).toHaveLength(0);
  });

  it('still gives a document-first artboard its port — the fix is scoped to legacy', () => {
    const h = makeHarness();
    const controller = board(h, emptySeen());
    goLive(h, controller, artifact([docPage('p1')]));
    expect(h.channels).toHaveLength(1);
    expect(frames(h)[0].contentWindow!.posts).toHaveLength(1);
  });

  it('mixes correctly: only the doc artboard gets a channel', () => {
    const h = makeHarness();
    const controller = board(h, emptySeen());
    goLive(h, controller, artifact([docPage('p1'), legacyHtmlPage('p2', 1600)]));
    expect(frames(h)).toHaveLength(2);
    expect(h.channels).toHaveLength(1);
  });

  it('drops hit/textCommit from a channel whose page became legacy after mount', () => {
    // Defence in depth: trust is re-read from the CURRENT page on every inbound
    // message, so a page that turns legacy cannot keep speaking through a port
    // it was granted while it was still document-first.
    const h = makeHarness();
    const seen = emptySeen();
    const controller = board(h, seen);
    goLive(h, controller, artifact([docPage('p1')]));
    expect(h.channels).toHaveLength(1);

    controller.setArtifact(artifact([legacyHtmlPage('p1')]), initialViewState());
    const port = h.channels[0].port1;
    port.deliver({ t: 'hit', mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: {}, double: true });
    port.deliver({ t: 'textCommit', mid: 'bbbbbbbbbb', text: 'transfer to acct 9912' });

    expect(seen.hits).toEqual([]);
    expect(seen.edits).toEqual([]);
    expect(seen.commits).toEqual([]);
  });
});

describe('P2: the frame is not the sole witness to its own authorisation', () => {
  it('refuses a textCommit for a node the parent never opened an edit on', () => {
    const h = makeHarness();
    const seen = emptySeen();
    const controller = board(h, seen);
    goLive(h, controller, artifact([docPage('p1')]));
    const port = h.channels[0].port1;

    // The whole forgery sequence: claim a double-click, then commit.
    port.deliver({ t: 'hit', mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 1, h: 1 }, modifiers: {}, double: true });
    port.deliver({ t: 'textCommit', mid: 'bbbbbbbbbb', text: 'transfer to acct 9912' });

    expect(seen.commits).toEqual([]);
  });

  it('accepts a textCommit once the PARENT has sent beginTextEdit for that node', () => {
    const h = makeHarness();
    const seen = emptySeen();
    const controller = board(h, seen);
    goLive(h, controller, artifact([docPage('p1')]));
    const port = h.channels[0].port1;

    controller.sendToPage('p1', { t: 'beginTextEdit', mid: 'bbbbbbbbbb' });
    port.deliver({ t: 'textCommit', mid: 'bbbbbbbbbb', text: 'Get started' });

    expect(seen.commits).toEqual([{ pageId: 'p1', mid: 'bbbbbbbbbb', text: 'Get started' }]);
  });

  it('an authorised edit on one node does not authorise a commit on another', () => {
    const h = makeHarness();
    const seen = emptySeen();
    const controller = board(h, seen);
    goLive(h, controller, artifact([docPage('p1')]));
    const port = h.channels[0].port1;

    controller.sendToPage('p1', { t: 'beginTextEdit', mid: 'bbbbbbbbbb' });
    port.deliver({ t: 'textCommit', mid: 'aaaaaaaaaa', text: 'not mine' });

    expect(seen.commits).toEqual([]);
  });

  it('keeps a short tail so the harness can flush the PREVIOUS edit when a new one opens', () => {
    // Real flow: the human edits A, then double-clicks B. The harness closes A
    // itself and posts `textCommit{A}` after the parent has already sent
    // `beginTextEdit{B}`. Dropping that would lose a genuine human edit.
    const h = makeHarness();
    const seen = emptySeen();
    const controller = board(h, seen);
    const page = docPage('p1');
    page.doc.children = [
      { mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'A' },
      { mid: 'cccccccccc', tag: 'UI.Text', text: 'B' },
    ];
    goLive(h, controller, artifact([page]));
    const port = h.channels[0].port1;

    controller.sendToPage('p1', { t: 'beginTextEdit', mid: 'bbbbbbbbbb' });
    controller.sendToPage('p1', { t: 'beginTextEdit', mid: 'cccccccccc' });
    port.deliver({ t: 'textCommit', mid: 'bbbbbbbbbb', text: 'A edited' });

    expect(seen.commits).toEqual([{ pageId: 'p1', mid: 'bbbbbbbbbb', text: 'A edited' }]);
  });

  it('still lets a trusted frame select and report geometry — only authorship is gated', () => {
    const h = makeHarness();
    const seen = emptySeen();
    const controller = board(h, seen);
    goLive(h, controller, artifact([docPage('p1')]));
    const port = h.channels[0].port1;

    port.deliver({ t: 'hit', mid: 'bbbbbbbbbb', rect: { x: 0, y: 0, w: 10, h: 10 }, modifiers: {}, double: false });
    port.deliver({ t: 'size', w: 1440, h: 2000 });

    expect(seen.hits).toEqual([{ pageId: 'p1', mid: 'bbbbbbbbbb' }]);
    expect(controller.selection).toEqual({ pageId: 'p1', mids: ['bbbbbbbbbb'] });
    expect(seen.sizes).toEqual([{ pageId: 'p1', w: 1440, h: 2000 }]);
  });
});
