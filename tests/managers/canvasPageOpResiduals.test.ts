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
 * Plan 27 lane J — the residuals lane E's verifier confirmed on the canvas's
 * page-level compat ops and left open.
 *
 *  - **J-1** `delete_page` had NO pin enforcement: the whole-artboard
 *    destruction `edit_page` now refuses was one ungated op away, on both
 *    vocabularies (legacy `delete_page`, V2 `page.remove` = MCP `remove_page`).
 *  - **J-2** `regraftPins` re-attached a human pin by mid + tag alone, so a
 *    staged rewrite accepted after the human retyped the cell landed the
 *    human's pin on the AGENT's value — false ownership that then refused
 *    every later agent edit "on the human's behalf".
 *  - **J-3** `_apply` refreshed `jsxCache` unconditionally after `edit_page`,
 *    replacing the verbatim source `updatePage` had just preserved for a
 *    `legacy` outcome with an emit of the empty placeholder doc.
 *  - **J-4** the E-1 refusal pointed the model at `write_page`, an MCP-only
 *    tool the fenced `canvas-op` lane (13 of 14 backends) cannot emit.
 *  - **J-5** `SANDBOX_INNER_CSP` carried no `form-action` and no `base-uri`,
 *    neither of which falls back to `default-src`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool, type CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import {
  DOC_SANDBOX_INNER_CSP,
  SANDBOX_INNER_CSP,
  buildPageDocument,
} from '../../src/managers/CanvasSandbox';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { findNode, pinnedCells, walk, type DocNode, type Mid } from '../../src/canvas/doc/DocNode';
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
    </UI.Screen>
  );
}`;

/** Outside the compilable subset on purpose — `migratePage` parks it as legacy jsx. */
const BROKEN_JSX = 'function Page(){ return (<UI.Screen>';

interface Harness {
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  artifact: CanvasArtifact;
  ctx: CanvasToolContext;
}

function harness(approvalMode: CanvasToolContext['approvalMode'] = 'auto'): Harness {
  const store = new ArtifactStore({ getRoot: () => null });
  const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
  const artifact = store.createArtifact({ name: 'Design' });
  return {
    store, executor, artifact,
    ctx: { artifact, store, executor, jobId: 'job-1', runId: 'run-1', approvalMode },
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

/* ══════════════════════════════════ J-1 ═══════════════════════════════ */

describe('J-1 — delete_page is pin-checked like edit_page, on both vocabularies', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('refuses a legacy delete_page that would destroy a human-owned cell, naming the pins', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool('delete_page', { pageId }, h.ctx);

    expect(res.ok).toBe(false);
    expect(res.error).toContain(`${hero}:text`);
    // Same shape as the edit_page refusal: rejected, receipt carries `pinned`.
    expect(h.executor.lastReceipt()?.status).toBe('rejected');
    expect(h.executor.lastReceipt()?.pinned).toEqual([`${hero}:text`]);
    // And the artboard is still there, hand edit intact.
    expect(h.artifact.pages).toHaveLength(1);
    expect(findNode(doc(h, pageId), hero)?.text).toBe('HUMAN COPY');
  });

  it('refuses the V2 page.remove (MCP remove_page) the same way — the supported vocabulary is not a bypass', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool('remove_page', { pageId }, h.ctx);

    expect(res.ok).toBe(false);
    expect(res.receipt?.status).toBe('rejected');
    expect(res.receipt?.pinned).toEqual([`${hero}:text`]);
    expect(res.error).toContain(`${hero}:text`);
    expect(h.artifact.pages).toHaveLength(1);
  });

  it('the three page-level ops agree: the edit_page and delete_page refusals name the same address', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const edit = dispatchCanvasTool('edit_page', { pageId, patch: { mode: 'jsx', jsxSource: REWRITE_SRC } }, h.ctx);
    const editPinned = h.executor.lastReceipt()?.pinned;
    const del = dispatchCanvasTool('delete_page', { pageId }, h.ctx);
    const delPinned = h.executor.lastReceipt()?.pinned;
    expect(edit.ok).toBe(false);
    expect(del.ok).toBe(false);
    expect(delPinned).toEqual(editPinned);
  });

  it('still deletes an unpinned page, on both vocabularies', () => {
    const a = seedPage(h);
    const b = seedPage(h);
    expect(dispatchCanvasTool('delete_page', { pageId: a }, h.ctx).ok).toBe(true);
    expect(dispatchCanvasTool('remove_page', { pageId: b }, h.ctx).ok).toBe(true);
    expect(h.artifact.pages).toHaveLength(0);
  });

  it('a HUMAN may delete a page they pinned — the gate is for agents only', () => {
    const pageId = seedPage(h);
    humanSetText(h, pageId, firstTextMid(h, pageId), 'HUMAN COPY');

    const legacy = h.executor.submit(
      h.artifact,
      { kind: 'delete_page', targetPageId: pageId, runId: 'human', author: 'user', proposedValue: {} },
      'job-1',
      'auto',
    );
    expect(legacy?.status).toBe('applied');
    expect(h.artifact.pages).toHaveLength(0);

    const pageId2 = seedPage(h);
    humanSetText(h, pageId2, firstTextMid(h, pageId2), 'HUMAN COPY');
    const v2 = h.executor.submitOp(
      h.artifact,
      { op: { op: 'page.remove', pageId: pageId2 }, runId: 'human', author: 'user' },
      'job-1',
      'auto',
    );
    expect(v2.status).toBe('applied');
    expect(h.artifact.pages).toHaveLength(0);
  });

  it('undo of an agent delete_page on an UNpinned page is unaffected', () => {
    const pageId = seedPage(h);
    expect(dispatchCanvasTool('delete_page', { pageId }, h.ctx).ok).toBe(true);
    expect(h.artifact.pages).toHaveLength(0);
    h.executor.undoLastApplied(h.artifact, 'job-1');
    expect(h.artifact.pages.map(p => p.id)).toEqual([pageId]);
  });
});

/* ══════════════════════════════════ J-2 ═══════════════════════════════ */

describe('J-2 — a regrafted pin lands only on the value the human actually wrote', () => {
  it('a staged rewrite accepted after the human retyped the cell does not carry the pin onto the agent text', () => {
    const h = harness('staged');
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);

    // Agent stages a doc patch that keeps every mid but changes the hero text.
    const next: DocNode = JSON.parse(JSON.stringify(doc(h, pageId)));
    findNode(next, hero)!.text = 'AGENT';
    const staged = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    expect(staged.ok).toBe(true);
    expect(staged.op?.status).toBe('pending');

    // Human hand-edits that very cell while the card is up — which pins it.
    humanSetText(h, pageId, hero, 'HUMAN');
    expect(pinnedCells(findNode(doc(h, pageId), hero)!)).toEqual(['text']);

    // Human accepts the card. The pin check is submit-time (a known residual,
    // out of this lane), so the agent's value lands — but the HUMAN'S pin must
    // not be grafted onto it: that would be a human ownership claim on text
    // the human never wrote, refusing every later agent edit on their behalf.
    h.executor.applyOp(h.artifact, staged.op!.opId, 'job-1');
    const node = findNode(doc(h, pageId), hero)!;
    expect(node.text === 'HUMAN' || pinnedCells(node).length === 0).toBe(true);
    expect(pinnedCells(node)).toEqual([]);
  });

  it('a staged patch that preserved the cell, accepted after the human retyped it, does not certify the stale value', () => {
    const h = harness('staged');
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN v1');

    // Agent stages a patch that carries the human's node forward unchanged.
    const next: DocNode = JSON.parse(JSON.stringify(doc(h, pageId)));
    for (const n of walk(next)) { delete n.pins; }
    const staged = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    expect(staged.ok).toBe(true);

    // Human retypes the same cell before accepting.
    humanSetText(h, pageId, hero, 'HUMAN v2');

    h.executor.applyOp(h.artifact, staged.op!.opId, 'job-1');
    const node = findNode(doc(h, pageId), hero)!;
    // The reverted value is not something the human wrote in the pre-op tree,
    // so no pin may sit on it.
    if (node.text !== 'HUMAN v2') { expect(pinnedCells(node)).toEqual([]); }
  });

  it('still regrafts when the value really did survive (the E-1 property)', () => {
    const h = harness();
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');
    const next: DocNode = JSON.parse(JSON.stringify(doc(h, pageId)));
    for (const n of walk(next)) { delete n.pins; }
    expect(dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx).ok).toBe(true);
    const node = findNode(doc(h, pageId), hero)!;
    expect(node.text).toBe('HUMAN COPY');
    expect(pinnedCells(node)).toEqual(['text']);
  });
});

/* ══════════════════════════════════ J-3 ═══════════════════════════════ */

describe('J-3 — a legacy edit_page outcome keeps the source view updatePage preserved', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('html: jsxCache stays the empty string, not an emit of the placeholder doc', () => {
    const pageId = seedPage(h);
    const res = dispatchCanvasTool('edit_page', { pageId, patch: { mode: 'html', htmlSource: '<div>hi</div>' } }, h.ctx);
    expect(res.ok).toBe(true);
    const page = h.store.getPage(h.artifact, pageId)!;
    expect(page.legacy).toEqual({ mode: 'html', source: '<div>hi</div>' });
    expect(page.jsxCache).toBe('');
  });

  it('uncompilable jsx: jsxCache stays the verbatim source', () => {
    const pageId = seedPage(h);
    const res = dispatchCanvasTool('edit_page', { pageId, patch: { mode: 'jsx', jsxSource: BROKEN_JSX } }, h.ctx);
    expect(res.ok).toBe(true);
    const page = h.store.getPage(h.artifact, pageId)!;
    expect(page.legacy?.mode).toBe('jsx');
    expect(page.jsxCache).toBe(BROKEN_JSX);
  });

  it('a compiled outcome is still re-emitted (the refresh the E-1 regraft depends on)', () => {
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');
    const next: DocNode = JSON.parse(JSON.stringify(doc(h, pageId)));
    for (const n of walk(next)) { delete n.pins; }
    expect(dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx).ok).toBe(true);
    const page = h.store.getPage(h.artifact, pageId)!;
    expect(page.legacy).toBeUndefined();
    expect(page.jsxCache).toContain('HUMAN COPY');
  });
});

/* ══════════════════════════════════ J-4 ═══════════════════════════════ */

describe('J-4 — the refusal points at an op the fenced lane can emit', () => {
  it('names edit_element (addressed by mid) and does not send the model to an MCP-only tool as its remedy', () => {
    const h = harness();
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool('edit_page', { pageId, patch: { mode: 'jsx', jsxSource: REWRITE_SRC } }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('edit_element');
    expect(res.error).toMatch(/\bmid\b/);
    // The fenced `canvas-op` lane (13 of 14 backends) has no write_page: that
    // tool may be mentioned as an MCP alternative, never as THE remedy.
    expect(res.error).not.toContain('Use write_page');
    expect(res.error).toMatch(/canvas-op|fenced/);
  });

  it('the delete_page refusal is equally actionable', () => {
    const h = harness();
    const pageId = seedPage(h);
    const hero = firstTextMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool('delete_page', { pageId }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('edit_element');
    expect(res.error).not.toContain('Use write_page');
  });
});

/* ══════════════════════════════════ J-5 ═══════════════════════════════ */

describe('J-5 — the legacy inner CSP closes the two directives default-src does not cover', () => {
  const theme = getThemePreset('clean-saas')!.theme;
  const format = getFormat('desktop')!;

  it("carries form-action 'none' and base-uri 'none'", () => {
    expect(SANDBOX_INNER_CSP).toContain("form-action 'none';");
    expect(SANDBOX_INNER_CSP).toContain("base-uri 'none';");
  });

  it('the doc policy is still strictly tighter, and the two now agree on both directives', () => {
    expect(DOC_SANDBOX_INNER_CSP).toContain("form-action 'none';");
    expect(DOC_SANDBOX_INNER_CSP).toContain("base-uri 'none';");
    expect(DOC_SANDBOX_INNER_CSP).not.toContain("'unsafe-eval'");
    expect(SANDBOX_INNER_CSP).toContain("'unsafe-eval'");
  });

  it('defaultCspFor still widens script-src / img-src by string replacement AND keeps the new directives', () => {
    const store = new ArtifactStore({ getRoot: () => null });
    store.createArtifact({ name: 'x', kind: 'screens', theme });
    const page = store.makePage({ mode: 'html', htmlSource: '<img src="asset://a/x.png">' } as never);

    const built = buildPageDocument({
      page, theme, format,
      runtime: { headScriptSrcs: ['./react.js'], harnessSrc: './harness.js' },
      imgSources: ['https://*.vscode-resource.vscode-cdn.net'],
    });
    const csp = /content="([^"]+)"/.exec(built)![1];
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' 'self' file:;");
    expect(csp).toContain('img-src data: blob: https://*.vscode-resource.vscode-cdn.net file:;');
    expect(csp).toContain("form-action 'none';");
    expect(csp).toContain("base-uri 'none';");
    expect(csp).not.toContain('img-src data: blob:;');
  });
});
