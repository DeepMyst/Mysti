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
 * Round-3 review, findings F2 / F3 / F4 — the agent's WRITE SURFACE and its
 * READ surface, both of which were unscoped.
 *
 *  - F2: `write_page`'s `force` carried bare cell names and the executor's pin
 *    gate matches on cell NAME alone, so forcing one element's `text` reverted
 *    the human's text on EVERY element of the artboard, in one transaction, and
 *    the collateral was not reported.
 *  - F3: `write_page { replace: true }` commits `page.setDoc`, whose `opCells`
 *    is `null`, so the executor's pin gate returns zero conflicts and the whole
 *    artboard — every human-owned cell AND the pin record itself — is erased
 *    with `ok: true` and an empty `dropped`.
 *  - F4: `get_page_jsx` / `get_node` / `read_page` returned the whole document,
 *    so one orienting read could push a megabyte into the coordinator's
 *    context. Plan 22 first principle 8 requires fenced AND clamped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool, type CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import { emit } from '../../src/canvas/doc/DocEmitter';
import { findNode, pinnedCells, walk, type DocNode, type Mid } from '../../src/canvas/doc/DocNode';
import type { CanvasArtifact } from '../../src/types';

const PAGE_SRC = `function Page() {
  return (
    <UI.Screen>
      <UI.Heading>Hero headline</UI.Heading>
      <UI.Text>Body copy</UI.Text>
      <UI.Text>Footer copy</UI.Text>
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
  return { store, executor, artifact, ctx: { artifact, store, executor, jobId: 'job-1', runId: 'run-1', approvalMode: 'auto' } };
}

function seedPage(h: Harness, src = PAGE_SRC): string {
  return h.store.insertPage(h.artifact, h.store.makePage({ mode: 'jsx', jsxSource: src })).id;
}

function doc(h: Harness, pageId: string): DocNode {
  return h.store.getPage(h.artifact, pageId)!.doc;
}

function textLeaves(h: Harness, pageId: string): DocNode[] {
  return [...walk(doc(h, pageId))].filter(n => n.text !== undefined);
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

/* ══════════════════════════════════ F2 ═════════════════════════════════ */

describe('F2 — write_page `force` is scoped to an element, never to the artboard', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('forcing ONE element does not revert the human\'s edits on the others', () => {
    const pageId = seedPage(h);
    const leaves = textLeaves(h, pageId);
    expect(leaves).toHaveLength(3);
    const [hero, body, footer] = leaves.map(n => n.mid);

    humanSetText(h, pageId, hero, 'MY headline');
    humanSetText(h, pageId, body, 'MY body');
    humanSetText(h, pageId, footer, 'MY footer');

    // The user asked for the HERO to change and said "yes, override my edit".
    const src = emit(doc(h, pageId), { mids: true })
      .replace('MY headline', 'AGENT headline')
      .replace('MY body', 'AGENT body')
      .replace('MY footer', 'AGENT footer');

    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, force: [`${hero}:text`] }, h.ctx);
    expect(res.ok, res.error).toBe(true);

    const after = doc(h, pageId);
    expect(findNode(after, hero)!.text).toBe('AGENT headline');
    // The collateral the old page-wide force silently took:
    expect(findNode(after, body)!.text).toBe('MY body');
    expect(findNode(after, footer)!.text).toBe('MY footer');

    // …and the two refusals REACH the model rather than dying silently.
    const dropped = (res.data as { dropped: Array<{ mid?: string; cell?: string; reason: string }> }).dropped;
    expect(dropped.filter(d => d.reason === 'pinned-by-human').map(d => d.mid).sort())
      .toEqual([body, footer].sort());
  });

  it('a bare cell name is refused with the scoped spelling — it can only be page-wide', () => {
    const pageId = seedPage(h);
    const [hero, body, footer] = textLeaves(h, pageId).map(n => n.mid);
    humanSetText(h, pageId, hero, 'MY headline');
    humanSetText(h, pageId, body, 'MY body');
    humanSetText(h, pageId, footer, 'MY footer');

    const src = emit(doc(h, pageId), { mids: true })
      .replace('MY headline', 'AGENT headline')
      .replace('MY body', 'AGENT body')
      .replace('MY footer', 'AGENT footer');
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, force: ['text'] }, h.ctx);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('<mid>:<cell>');
    // The whole artboard is untouched — this is the transaction that used to
    // revert three human edits when the model forced one.
    const after = doc(h, pageId);
    expect([hero, body, footer].map(m => findNode(after, m)!.text))
      .toEqual(['MY headline', 'MY body', 'MY footer']);
  });

  it('the single-element tools keep the bare cell spelling — they already name one mid', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'MY headline');
    const res = dispatchCanvasTool('set_text', { pageId, mid: hero, text: 'AGENT headline', force: ['text'] }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(findNode(doc(h, pageId), hero)!.text).toBe('AGENT headline');
  });
});

/* ══════════════════════════════════ F3 ═════════════════════════════════ */

describe('F3 — write_page { replace: true } is pin-checked like every other write', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('refuses to erase a human-owned cell, and says which one', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'HUMAN WROTE THIS');

    // Baseline: the SAME intent through the element op is refused today.
    const viaOp = dispatchCanvasTool('set_text', { pageId, mid: hero, text: 'AGENT OVERWROTE IT' }, h.ctx);
    expect(viaOp.ok).toBe(false);
    expect(viaOp.receipt?.pinned).toEqual(['text']);

    // …so one documented boolean must not be a way around it.
    const src = emit(doc(h, pageId), { mids: true }).replace('HUMAN WROTE THIS', 'AGENT OVERWROTE IT');
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, replace: true }, h.ctx);

    expect(res.ok).toBe(false);
    expect(res.dropped?.some(d => d.mid === hero && d.cell === 'text' && d.reason === 'pinned-by-human')).toBe(true);
    const node = findNode(doc(h, pageId), hero)!;
    expect(node.text).toBe('HUMAN WROTE THIS');
    expect(pinnedCells(node)).toEqual(['text']);
  });

  it('a replace that drops element identity cannot launder the pins away either', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'HUMAN WROTE THIS');

    // No mids at all — the shape a model produces when it rewrites from scratch.
    const res = dispatchCanvasTool('write_page', { pageId, jsx: PAGE_SRC, replace: true }, h.ctx);
    expect(res.ok).toBe(false);
    expect(findNode(doc(h, pageId), hero)!.text).toBe('HUMAN WROTE THIS');
  });

  it('a replace that leaves every human cell alone applies AND keeps the pin record', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'HUMAN WROTE THIS');

    const src = emit(doc(h, pageId), { mids: true }).replace('Footer copy', 'AGENT footer');
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, replace: true }, h.ctx);
    expect(res.ok, res.error).toBe(true);

    const node = findNode(doc(h, pageId), hero)!;
    expect(node.text).toBe('HUMAN WROTE THIS');
    // The whole point: ownership survives a wholesale write.
    expect(pinnedCells(node)).toEqual(['text']);
  });

  it('naming the cell in force is still the way through — scoped to that element', () => {
    const pageId = seedPage(h);
    const [hero, , footer] = textLeaves(h, pageId).map(n => n.mid);
    humanSetText(h, pageId, hero, 'MY headline');
    humanSetText(h, pageId, footer, 'MY footer');

    const src = emit(doc(h, pageId), { mids: true })
      .replace('MY headline', 'AGENT headline')
      .replace('MY footer', 'AGENT footer');

    // Forcing only the hero must not carry the footer along.
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, replace: true, force: [`${hero}:text`] }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.dropped?.some(d => d.mid === footer)).toBe(true);

    const both = dispatchCanvasTool(
      'write_page',
      { pageId, jsx: src, replace: true, force: [`${hero}:text`, `${footer}:text`] },
      h.ctx,
    );
    expect(both.ok, both.error).toBe(true);
    expect(findNode(doc(h, pageId), hero)!.text).toBe('AGENT headline');
    expect(findNode(doc(h, pageId), footer)!.text).toBe('AGENT footer');
  });

  it('a code page — which has no addressable cells to own — still replaces cleanly', () => {
    const page = h.store.insertPage(h.artifact, h.store.makePage({ mode: 'html', htmlSource: '<h1>old</h1>' }));
    expect(page.legacy).toBeDefined();
    const res = dispatchCanvasTool('write_page', { pageId: page.id, jsx: PAGE_SRC }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(h.store.getPage(h.artifact, page.id)!.legacy).toBeUndefined();
  });
});

/* ══════════════════════════════════ F4 ═════════════════════════════════ */

describe('F4 — canvas reads are clamped, not just fenced', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  /** The shape an imported design (or an accumulated multi-turn build) produces. */
  function hugePage(leaves = 4000): string {
    const rows = Array.from({ length: leaves }, (_, i) => `      <UI.Text>row ${i} of a very large imported artboard</UI.Text>`).join('\n');
    return seedPage(h, `function Page() {\n  return (\n    <UI.Screen>\n${rows}\n    </UI.Screen>\n  );\n}`);
  }

  const size = (v: unknown): number => JSON.stringify(v).length;

  it('get_page_jsx cannot push an unbounded artboard into the model turn', () => {
    const pageId = hugePage();
    const res = dispatchCanvasTool('get_page_jsx', { pageId }, h.ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { jsx: string; clamped?: boolean; clampNote?: string };
    expect(size(res.data)).toBeLessThan(40_000);
    expect(data.clamped).toBe(true);
    expect(data.jsx).toContain('[clamped —');
    expect(data.clampNote).toBeTruthy();
  });

  it('get_node cannot either — subtree jsx, text and prop values are all bounded', () => {
    const pageId = hugePage();
    const rootMid = doc(h, pageId).mid;
    const res = dispatchCanvasTool('get_node', { pageId, mid: rootMid }, h.ctx);
    expect(res.ok).toBe(true);
    expect(size(res.data)).toBeLessThan(40_000);
    expect((res.data as { clamped?: boolean }).clamped).toBe(true);
  });

  it('a giant single prop value is clamped without losing the other props', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    dispatchCanvasTool('set_prop', { pageId, mid, name: 'items', value: Array.from({ length: 20_000 }, (_, i) => ({ label: `row ${i}` })) }, h.ctx);
    dispatchCanvasTool('set_prop', { pageId, mid, name: 'variant', value: 'secondary' }, h.ctx);

    const res = dispatchCanvasTool('get_node', { pageId, mid }, h.ctx);
    expect(res.ok).toBe(true);
    expect(size(res.data)).toBeLessThan(40_000);
    const props = (res.data as { props?: Record<string, unknown> }).props!;
    expect(String(props.items)).toContain('[clamped —');
    expect(props.variant).toBe('secondary');
  });

  it('read_page — the compat name an older prompt still reaches for — is clamped too', () => {
    const pageId = hugePage();
    const res = dispatchCanvasTool('read_page', { pageId }, h.ctx);
    expect(res.ok).toBe(true);
    expect(size(res.data)).toBeLessThan(40_000);
  });

  it('a clamped read cannot be echoed back as a rewrite — that would delete what the clamp cut', () => {
    const pageId = hugePage();
    const read = dispatchCanvasTool('get_page_jsx', { pageId }, h.ctx);
    const jsx = (read.data as { jsx: string }).jsx;
    const before = [...walk(doc(h, pageId))].length;

    // Exactly what a model that missed the `clamped` flag would send back.
    const res = dispatchCanvasTool('write_page', { pageId, jsx: `function Page() {\n  return (\n${jsx}\n  );\n}` }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clamped');
    expect([...walk(doc(h, pageId))].length).toBe(before);
  });

  it('a real artboard is returned WHOLE — the clamp is a ceiling, not a haircut', () => {
    const pageId = seedPage(h);
    const res = dispatchCanvasTool('get_page_jsx', { pageId }, h.ctx);
    const data = res.data as { jsx: string; clamped?: boolean };
    expect(data.clamped).toBeUndefined();
    expect(data.jsx).not.toContain('[clamped');
    expect(data.jsx).toContain('Hero headline');
    expect(data.jsx).toContain('Footer copy');
  });
});
