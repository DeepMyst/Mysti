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
 * Round-4 review — the seams the round-3 hardening created on the agent's
 * write path.
 *
 *  - R4-1 `replace_element`: `el.replace` is not cell-scoped, so `opCells`
 *    returns null and the executor's pin gate returns zero conflicts. Round 3
 *    closed exactly this hole for `page.setDoc`; its element-level twin — a
 *    PRIMARY, model-taught tool — was left open, so one call overwrote a
 *    human-owned cell AND erased the pin record, with `ok:true` and an empty
 *    `dropped`.
 *  - R4-2 `pinsAcrossReplace` matched a previous node to an incoming one by
 *    `mid` ALONE, so a rebrand that reused a mid on a different element type
 *    grafted the human's ownership onto an element they never touched — the
 *    invisible failure `plans/22-canvas-document-first.md:497` calls the worst
 *    one. The Reconciler's tier-1 rule (`Reconciler.ts:383`) is "exists + same
 *    tag"; the replace path is now the same.
 *  - R4-3 the read clamp's own tripwire (`containsClampMarker`) guarded only
 *    `write_page` and the `jsx` branch of `nodeInputFrom`. Echoing a clamped
 *    `get_node` back through `set_text` / `set_prop` / `set_page_meta` / a
 *    `node` object truncated the human's content and wrote the clamp marker
 *    into the artboard as document content.
 *  - R4-4 `write_page_jsx` published the BARE `force` spelling that its own
 *    shared dispatcher hard-refuses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { canvasToolPayload, dispatchCanvasTool, type CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
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

function humanSetStyle(h: Harness, pageId: string, mid: Mid, style: Record<string, string>): void {
  const r = h.executor.submitOp(
    h.artifact,
    { op: { op: 'el.setStyle', pageId, mid, style }, runId: 'human', author: 'user' },
    'job-1',
    'auto',
  );
  expect(r.status).toBe('applied');
}

/* ══════════════════════════════════ R4-1 ═══════════════════════════════ */

describe('R4-1 — replace_element is pin-checked like every other agent write', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('refuses to overwrite a human-owned cell, and names it', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'HUMAN COPY');
    humanSetStyle(h, pageId, hero, { color: '#ff0000' });

    // Baseline: the same intent through the cell op is refused today.
    const viaCell = dispatchCanvasTool('set_text', { pageId, mid: hero, text: 'AGENT COPY' }, h.ctx);
    expect(viaCell.ok).toBe(false);
    expect(viaCell.receipt?.pinned).toEqual(['text']);

    // …so reaching for the structural tool must not be the way around it.
    // Same tag, so this is purely "the agent wants the human's value gone".
    const res = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: hero, node: { tag: 'UI.Heading', text: 'AGENT COPY' } },
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.dropped?.some(d => d.mid === hero && d.cell === 'text' && d.reason === 'pinned-by-human')).toBe(true);
    expect(res.dropped?.some(d => d.mid === hero && d.cell === 'style.color')).toBe(true);

    const node = findNode(doc(h, pageId), hero)!;
    expect(node.text).toBe('HUMAN COPY');
    expect(node.style?.color).toBe('#ff0000');
    // The pin RECORD survives too — otherwise the next agent write is unguarded.
    expect(pinnedCells(node)).toEqual(['style.color', 'text']);
  });

  it('a jsx replacement cannot launder the pins away either', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool('replace_element', { pageId, mid: hero, jsx: '<UI.Text>AGENT COPY</UI.Text>' }, h.ctx);
    expect(res.ok).toBe(false);
    expect(findNode(doc(h, pageId), hero)!.text).toBe('HUMAN COPY');
    expect(pinnedCells(findNode(doc(h, pageId), hero)!)).toEqual(['text']);
  });

  it('naming the cell in force is the way through — and it is scoped to that element', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const bare = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: hero, node: { tag: 'UI.Heading', text: 'AGENT COPY' }, force: ['text'] },
      h.ctx,
    );
    expect(bare.ok).toBe(false);
    expect(bare.error).toContain('<mid>:<cell>');
    expect(findNode(doc(h, pageId), hero)!.text).toBe('HUMAN COPY');

    const scoped = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: hero, node: { tag: 'UI.Heading', text: 'AGENT COPY' }, force: [`${hero}:text`] },
      h.ctx,
    );
    expect(scoped.ok, scoped.error).toBe(true);
    const after = findNode(doc(h, pageId), hero)!;
    expect(after.text).toBe('AGENT COPY');
    // Forced or not, the human still owns the cell afterwards.
    expect(pinnedCells(after)).toEqual(['text']);
  });

  it('a replacement that leaves the human cell alone applies AND keeps the pin record', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetStyle(h, pageId, hero, { color: '#ff0000' });

    const res = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: hero, node: { tag: 'UI.Heading', text: 'Hero headline', style: { color: '#ff0000', margin: '8px' } } },
      h.ctx,
    );
    expect(res.ok, res.error).toBe(true);

    const node = findNode(doc(h, pageId), hero)!;
    expect(node.style?.margin).toBe('8px');
    expect(pinnedCells(node)).toEqual(['style.color']);
  });

  it('the model-facing payload carries the refused cells, not just prose', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, hero, 'HUMAN COPY');

    const res = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: hero, node: { tag: 'UI.Heading', text: 'AGENT COPY' } },
      h.ctx,
    );
    const payload = canvasToolPayload(res, 'auto');
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload)).toContain('pinned-by-human');
    expect((payload.dropped as Array<{ mid?: string }>).some(d => d.mid === hero)).toBe(true);
  });

  it('an unpinned element is still freely replaceable — the gate costs nothing', () => {
    const pageId = seedPage(h);
    const body = textLeaves(h, pageId)[1].mid;
    const res = dispatchCanvasTool('replace_element', { pageId, mid: body, jsx: '<UI.Badge>NEW</UI.Badge>' }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(findNode(doc(h, pageId), body)!.tag).toBe('UI.Badge');
  });

  it('a pinned DESCENDANT of the replaced subtree is protected too', () => {
    const pageId = seedPage(h, `function Page() {
  return (
    <UI.Screen>
      <UI.Card>
        <UI.Text>Card copy</UI.Text>
      </UI.Card>
    </UI.Screen>
  );
}`);
    const card = [...walk(doc(h, pageId))].find(n => n.tag === 'UI.Card')!.mid;
    const inner = textLeaves(h, pageId)[0].mid;
    humanSetText(h, pageId, inner, 'HUMAN CARD COPY');

    const res = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: card, jsx: '<UI.Card><UI.Text>AGENT CARD COPY</UI.Text></UI.Card>' },
      h.ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.dropped?.some(d => d.mid === inner)).toBe(true);
    expect(findNode(doc(h, pageId), inner)!.text).toBe('HUMAN CARD COPY');
  });
});

/* ══════════════════════════════════ R4-2 ═══════════════════════════════ */

describe('R4-2 — a pin only travels to an element of the SAME tag', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('a reused mid on a different tag is a conflict, never a graft', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetStyle(h, pageId, hero, { color: '#ff0000' });

    // The rebrand shape: the mid is reused on a brand-new element that happens
    // to carry the same value for the pinned cell.
    const src = `function Page() {
  return (
    <UI.Screen>
      <UI.Badge mid="${hero}" style={{color:'#ff0000'}}>NEW</UI.Badge>
      <UI.Text>Fresh body</UI.Text>
    </UI.Screen>
  );
}`;
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, replace: true }, h.ctx);

    expect(res.ok).toBe(false);
    expect(res.dropped?.some(d => d.mid === hero && d.cell === 'style.color' && d.reason === 'node-vanished')).toBe(true);
    // The human's element is still there, still theirs.
    const node = findNode(doc(h, pageId), hero)!;
    expect(node.tag).toBe('UI.Heading');
    expect(pinnedCells(node)).toEqual(['style.color']);
  });

  it('the same mid on the same tag still carries the pin — identity is preserved, not blocked', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetStyle(h, pageId, hero, { color: '#ff0000' });

    const src = emit(doc(h, pageId), { mids: true }).replace('Footer copy', 'AGENT footer');
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, replace: true }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(pinnedCells(findNode(doc(h, pageId), hero)!)).toEqual(['style.color']);
  });

  it('forcing a tag change destroys the element WITHOUT moving the pin to the impostor', () => {
    const pageId = seedPage(h);
    const hero = textLeaves(h, pageId)[0].mid;
    humanSetStyle(h, pageId, hero, { color: '#ff0000' });

    const src = `function Page() {
  return (
    <UI.Screen>
      <UI.Badge mid="${hero}" style={{color:'#00ff00'}}>NEW</UI.Badge>
    </UI.Screen>
  );
}`;
    const res = dispatchCanvasTool('write_page', { pageId, jsx: src, replace: true, force: [`${hero}:style.color`] }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    const node = findNode(doc(h, pageId), hero)!;
    expect(node.tag).toBe('UI.Badge');
    // The human never customised THIS element, so it must not read as theirs.
    expect(pinnedCells(node)).toEqual([]);
  });
});

/* ══════════════════════════════════ R4-3 ═══════════════════════════════ */

describe('R4-3 — a clamped read cannot be echoed back into the document', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  /** A cell big enough that `get_node` has to clamp it. */
  const LONG = 'the quick brown fox jumps over the lazy dog. '.repeat(200);

  function clampedCell(pageId: string, mid: Mid): string {
    dispatchCanvasTool('set_text', { pageId, mid, text: LONG }, h.ctx);
    const read = dispatchCanvasTool('get_node', { pageId, mid }, h.ctx);
    const data = read.data as { text: string; clamped?: boolean };
    expect(data.clamped).toBe(true);
    expect(data.text).toContain('[clamped —');
    return data.text;
  }

  it('set_text refuses the clamped string instead of truncating the human\'s copy', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    const partial = clampedCell(pageId, mid);

    const res = dispatchCanvasTool('set_text', { pageId, mid, text: `${partial} EDITED` }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clamped');
    const stored = findNode(doc(h, pageId), mid)!.text!;
    expect(stored.length).toBe(LONG.length);
    expect(stored).not.toContain('[clamped —');
  });

  it('set_prop refuses it too — a prop value is document content as much as text is', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    const partial = clampedCell(pageId, mid);

    const res = dispatchCanvasTool('set_prop', { pageId, mid, name: 'label', value: partial }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clamped');
    expect(findNode(doc(h, pageId), mid)!.props?.label).toBeUndefined();
  });

  it('set_style refuses it too', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    const partial = clampedCell(pageId, mid);

    const res = dispatchCanvasTool('set_style', { pageId, mid, style: { content: partial } }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clamped');
  });

  it('set_page_meta notes refuse it — the notes field is clamped on the way out', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    const partial = clampedCell(pageId, mid);

    const res = dispatchCanvasTool('set_page_meta', { pageId, notes: partial }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clamped');
    expect(h.store.getPage(h.artifact, pageId)!.notes).toBeUndefined();
  });

  it('a `node` object carrying the marker is refused on insert_element and replace_element', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    const partial = clampedCell(pageId, mid);
    const root = doc(h, pageId).mid;
    const before = [...walk(doc(h, pageId))].length;

    const ins = dispatchCanvasTool(
      'insert_element',
      { pageId, parentMid: root, node: { tag: 'UI.Text', text: partial } },
      h.ctx,
    );
    expect(ins.ok).toBe(false);
    expect(ins.error).toContain('clamped');

    const rep = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: textLeaves(h, pageId)[1].mid, node: { tag: 'UI.Text', props: { label: partial } } },
      h.ctx,
    );
    expect(rep.ok).toBe(false);
    expect(rep.error).toContain('clamped');
    expect([...walk(doc(h, pageId))].length).toBe(before);
  });

  it('add_page notes are guarded on the way in as well', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    const partial = clampedCell(pageId, mid);
    const pages = h.artifact.pages.length;

    const res = dispatchCanvasTool('add_page', { notes: partial }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clamped');
    expect(h.artifact.pages.length).toBe(pages);
  });

  it('ordinary content that merely mentions clamping is untouched — the guard is the marker, not the word', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    const res = dispatchCanvasTool('set_text', { pageId, mid, text: 'Cable clamped to the mast' }, h.ctx);
    expect(res.ok, res.error).toBe(true);
  });

  it('the clamp never cuts a surrogate pair in half', () => {
    const pageId = seedPage(h);
    const mid = textLeaves(h, pageId)[0].mid;
    // An odd-length prefix puts the head boundary INSIDE an astral character.
    dispatchCanvasTool('set_text', { pageId, mid, text: `x${'\u{1F600}'.repeat(4000)}` }, h.ctx);

    const read = dispatchCanvasTool('get_node', { pageId, mid }, h.ctx);
    const text = (read.data as { text: string; clamped?: boolean }).text;
    expect((read.data as { clamped?: boolean }).clamped).toBe(true);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(text), 'the clamped read carries a lone surrogate').toBe(false);
  });
});
