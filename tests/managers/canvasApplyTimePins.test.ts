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
 * Plan 27 lane L (§21.6c #4, #9) — the pin residuals lane J's verifier
 * confirmed and lane J deliberately left open.
 *
 *  - **L-1** the pin check was SUBMIT-time and the write APPLY-time. In the
 *    default `staged` approval mode a human can pin a cell while the card is
 *    up; accepting the card then destroyed the pinned content — on
 *    `edit_page`, `delete_page`, every element op `write_page` stages, and a
 *    parked auto-mode op flushed after the human's inline edit ended.
 *  - **L-2** an agent `edit_page {patch:{doc}}` / `insert_page {page:{doc}}`
 *    carrying `pins:{…}` was accepted verbatim: `migratePage` takes an
 *    `isDocNode` doc as-is, so the agent minted human ownership.
 *  - **L-3** `el.remove` / `el.move` / `el.replace` are not cell-scoped, so
 *    `opCells` is null and the executor's gate saw zero conflicts: MCP
 *    `remove_element {mid}` on a pinned subtree answered `ok: true`.
 *  - **L-4** V2 `page.add` honoured a colliding `id` in `_applyV2`, where the
 *    legacy `insert_page` had already learned to re-mint (E-1).
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
      <UI.Card>
        <UI.Heading>Hero headline</UI.Heading>
        <UI.Text>Body copy</UI.Text>
      </UI.Card>
      <UI.Stack>
        <UI.Text>Footer</UI.Text>
      </UI.Stack>
    </UI.Screen>
  );
}`;

interface Harness {
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  artifact: CanvasArtifact;
  ctx: CanvasToolContext;
}

function harness(approvalMode: CanvasToolContext['approvalMode'] = 'staged'): Harness {
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

function midOfTag(h: Harness, pageId: string, tag: string): Mid {
  return [...walk(doc(h, pageId))].find(n => n.tag === tag)!.mid;
}

/** The heading — the first text-bearing node. */
function heroMid(h: Harness, pageId: string): Mid {
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

function cloneDoc(d: DocNode): DocNode { return JSON.parse(JSON.stringify(d)); }

function stripPins(d: DocNode): DocNode {
  const out = cloneDoc(d);
  for (const n of walk(out)) { delete n.pins; }
  return out;
}

/* ══════════════════════════════════ L-1 ═══════════════════════════════ */

describe('L-1 — the pin check runs again at APPLY time, against the tree as it is then', () => {
  let h: Harness;
  beforeEach(() => { h = harness('staged'); });

  it('a staged edit_page accepted after the human pinned a cell is refused, with the submit-time receipt shape', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);

    // Nothing pinned yet → the submit-time gate passes and the card goes up.
    const next = cloneDoc(doc(h, pageId));
    findNode(next, hero)!.text = 'AGENT';
    const staged = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    expect(staged.ok).toBe(true);
    expect(staged.op?.status).toBe('pending');

    // The human hand-edits that very cell while the card is up.
    humanSetText(h, pageId, hero, 'HUMAN');

    // Accept. The write must NOT happen.
    const out = h.executor.applyOp(h.artifact, staged.op!.opId, 'job-1');
    expect(out?.status).toBe('rejected');
    const receipt = h.executor.lastReceipt();
    expect(receipt?.opId).toBe(staged.op!.opId);
    expect(receipt?.status).toBe('rejected');
    expect(receipt?.pinned).toEqual([`${hero}:text`]);
    expect(receipt?.error).toContain(`${hero}:text`);
    expect(h.executor.lastSubmitError()).toContain('destroy');
    const node = findNode(doc(h, pageId), hero)!;
    expect(node.text).toBe('HUMAN');
    expect(pinnedCells(node)).toEqual(['text']);
  });

  it('a staged delete_page accepted after the human pinned a cell is refused; the artboard stays', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const staged = dispatchCanvasTool('delete_page', { pageId }, h.ctx);
    expect(staged.ok).toBe(true);
    expect(staged.op?.status).toBe('pending');

    humanSetText(h, pageId, hero, 'HUMAN');

    const out = h.executor.applyOp(h.artifact, staged.op!.opId, 'job-1');
    expect(out?.status).toBe('rejected');
    expect(h.executor.lastReceipt()?.pinned).toEqual([`${hero}:text`]);
    expect(h.artifact.pages).toHaveLength(1);
    expect(findNode(doc(h, pageId), hero)?.text).toBe('HUMAN');
  });

  it('a staged V2 element op (what write_page stages) accepted after the human pinned the cell is refused', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const src = emit(doc(h, pageId), { mids: true }).replace('Hero headline', 'Agent copy');
    const staged = dispatchCanvasTool('write_page', { pageId, jsx: src }, h.ctx);
    expect(staged.ok, staged.error).toBe(true);
    const opIds = (staged.ops ?? []).length > 0 ? [staged.receipt!.opId] : [];
    expect(opIds).toHaveLength(1);

    humanSetText(h, pageId, hero, 'HUMAN');

    const receipt = h.executor.applyStagedOp(h.artifact, opIds[0], 'job-1');
    expect(receipt?.status).toBe('rejected');
    expect(receipt?.pinned).toEqual(['text']);
    expect(receipt?.error).toContain('user-set');
    expect(findNode(doc(h, pageId), hero)!.text).toBe('HUMAN');
  });

  it('a staged whole-document page.setDoc (write_page replace) accepted after the human pinned is refused', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const src = emit(doc(h, pageId), { mids: true }).replace('Hero headline', 'Agent copy');
    const staged = dispatchCanvasTool('write_page', { pageId, jsx: src, replace: true }, h.ctx);
    expect(staged.ok, staged.error).toBe(true);
    expect(staged.ops?.[0]?.op).toBe('page.setDoc');

    humanSetText(h, pageId, hero, 'HUMAN');

    const receipt = h.executor.applyStagedOp(h.artifact, staged.receipt!.opId, 'job-1');
    expect(receipt?.status).toBe('rejected');
    expect(receipt?.pinned).toEqual([`${hero}:text`]);
    expect(findNode(doc(h, pageId), hero)!.text).toBe('HUMAN');
  });

  it('a staged op the writer FORCED at submit time still honours that force at apply time', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN v1');
    // The user asked for exactly this change; the agent names the cell.
    const staged = dispatchCanvasTool('set_text', { pageId, mid: hero, text: 'AGENT', force: ['text'] }, h.ctx);
    expect(staged.ok, staged.error).toBe(true);
    expect(staged.receipt?.status).toBe('staged');

    const receipt = h.executor.applyStagedOp(h.artifact, staged.receipt!.opId, 'job-1');
    expect(receipt?.status).toBe('applied');
    expect(findNode(doc(h, pageId), hero)!.text).toBe('AGENT');
  });

  it('an auto-mode op PARKED behind a live inline edit is refused when the flush finds a cell pinned', () => {
    const auto = harness('auto');
    const pageId = seedPage(auto);
    const hero = heroMid(auto, pageId);
    const footer = midOfTag(auto, pageId, 'UI.Stack');
    // The human is typing into the footer: that subtree is locked, and a
    // page-scoped agent op parks behind ANY lock on the page.
    auto.executor.setSubtreeEditing(auto.artifact, pageId, footer, true, 'job-1');
    const next = cloneDoc(doc(auto, pageId));
    findNode(next, hero)!.text = 'AGENT';
    const parked = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, auto.ctx);
    expect(parked.ok).toBe(true);
    expect(parked.op?.status).toBe('pending');
    // Meanwhile the human edits the heading from the inspector — outside the
    // lock, so it applies at once and pins the cell.
    humanSetText(auto, pageId, hero, 'HUMAN');
    // The inline edit ends: the lock lifts and the queue flushes.
    auto.executor.setSubtreeEditing(auto.artifact, pageId, footer, false, 'job-1');

    expect(auto.store.findOp(auto.artifact, parked.op!.opId)?.status).toBe('rejected');
    expect(findNode(doc(auto, pageId), hero)!.text).toBe('HUMAN');
    expect(pinnedCells(findNode(doc(auto, pageId), hero)!)).toEqual(['text']);
  });

  it('CONTROL: a staged edit_page accepted with nothing pinned in between still applies', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const next = cloneDoc(doc(h, pageId));
    findNode(next, hero)!.text = 'AGENT';
    const staged = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    const out = h.executor.applyOp(h.artifact, staged.op!.opId, 'job-1');
    expect(out?.status).toBe('applied');
    expect(findNode(doc(h, pageId), hero)!.text).toBe('AGENT');
  });
});

/* ══════════════════════════════════ L-2 ═══════════════════════════════ */

describe('L-2 — an agent cannot mint pins inside an edit_page / insert_page doc', () => {
  let h: Harness;
  beforeEach(() => { h = harness('auto'); });

  it('pins inside an agent edit_page doc are stripped before the write', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const next = cloneDoc(doc(h, pageId));
    findNode(next, hero)!.text = 'AGENT';
    findNode(next, hero)!.pins = { text: { at: 1, opId: 'forged' } };
    const res = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    const node = findNode(doc(h, pageId), hero)!;
    expect(node.text).toBe('AGENT');
    expect(pinnedCells(node)).toEqual([]);
    // The agent's later edit of the cell it just wrote is therefore NOT refused.
    expect(dispatchCanvasTool('set_text', { pageId, mid: hero, text: 'AGENT 2' }, h.ctx).ok).toBe(true);
  });

  it('a forged pin cannot even ride on a HUMAN value the doc preserved — the regraft seeds only from the pre-op tree', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const body = midOfTag(h, pageId, 'UI.Text');
    humanSetText(h, pageId, hero, 'HUMAN');
    const next = stripPins(doc(h, pageId));
    // Keeps the human's heading; forges ownership of the (agent-authored) body.
    findNode(next, body)!.pins = { text: { at: 1, opId: 'forged' } };
    const res = dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(pinnedCells(findNode(doc(h, pageId), hero)!)).toEqual(['text']);
    expect(pinnedCells(findNode(doc(h, pageId), body)!)).toEqual([]);
  });

  it('pins inside an agent insert_page doc are stripped too', () => {
    const template = cloneDoc(doc(h, seedPage(h)));
    for (const n of walk(template)) { n.pins = { text: { at: 1, opId: 'forged' } }; }
    const res = dispatchCanvasTool('insert_page', { page: { doc: template } }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    const created = h.store.getPage(h.artifact, res.op!.targetPageId!)!;
    expect([...walk(created.doc)].every(n => pinnedCells(n).length === 0)).toBe(true);
  });

  it('a HUMAN edit_page keeps the pins it carries (undo/restore payloads are human-authored)', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const next = cloneDoc(doc(h, pageId));
    findNode(next, hero)!.pins = { text: { at: 1, opId: 'human-restore' } };
    const op = h.executor.submit(
      h.artifact,
      { kind: 'edit_page', targetPageId: pageId, runId: 'human', author: 'user', proposedValue: { doc: next } },
      'job-1',
      'auto',
    );
    expect(op?.status).toBe('applied');
    expect(pinnedCells(findNode(doc(h, pageId), hero)!)).toEqual(['text']);
  });

  it('the caller\'s payload object is not mutated by the strip', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const next = cloneDoc(doc(h, pageId));
    findNode(next, hero)!.pins = { text: { at: 1, opId: 'forged' } };
    dispatchCanvasTool('edit_page', { pageId, patch: { doc: next } }, h.ctx);
    expect(findNode(next, hero)!.pins).toEqual({ text: { at: 1, opId: 'forged' } });
  });
});

/* ══════════════════════════════════ L-3 ═══════════════════════════════ */

describe('L-3 — structural element ops over a pinned subtree are refused like a page-level op', () => {
  let h: Harness;
  beforeEach(() => { h = harness('auto'); });

  it('remove_element on a subtree holding a human-owned cell is refused, naming <mid>:<cell>; the tree is intact', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const card = midOfTag(h, pageId, 'UI.Card');
    humanSetText(h, pageId, hero, 'HUMAN');
    const versionBefore = h.store.getPage(h.artifact, pageId)!.version;

    const res = dispatchCanvasTool('remove_element', { pageId, mid: card }, h.ctx);

    expect(res.ok).toBe(false);
    expect(res.receipt?.status).toBe('rejected');
    expect(res.receipt?.pinned).toEqual([`${hero}:text`]);
    expect(res.error).toContain(`${hero}:text`);
    expect(res.dropped?.[0]).toMatchObject({ mid: hero, cell: 'text', reason: 'pinned-by-human' });
    expect(findNode(doc(h, pageId), card)).toBeTruthy();
    expect(findNode(doc(h, pageId), hero)?.text).toBe('HUMAN');
    expect(h.store.getPage(h.artifact, pageId)!.version).toBe(versionBefore);
  });

  it('remove_element on the pinned element ITSELF is refused too', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN');
    const res = dispatchCanvasTool('remove_element', { pageId, mid: hero }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.receipt?.pinned).toEqual([`${hero}:text`]);
    expect(findNode(doc(h, pageId), hero)?.text).toBe('HUMAN');
  });

  it('move_element of a subtree holding a human-owned cell is refused', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const card = midOfTag(h, pageId, 'UI.Card');
    const stack = midOfTag(h, pageId, 'UI.Stack');
    humanSetText(h, pageId, hero, 'HUMAN');
    const res = dispatchCanvasTool('move_element', { pageId, mid: card, newParentMid: stack }, h.ctx);
    expect(res.ok).toBe(false);
    expect(res.receipt?.pinned).toEqual([`${hero}:text`]);
    // Still where the human left it.
    const stackNode = findNode(doc(h, pageId), stack)!;
    expect((stackNode.children ?? []).some(c => c.mid === card)).toBe(false);
  });

  it('a raw el.replace that changes a pinned cell is refused BY THE EXECUTOR (not only by the dispatcher\'s guard)', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN');
    const r = h.executor.submitOp(
      h.artifact,
      { op: { op: 'el.replace', pageId, mid: hero, node: { tag: 'UI.Heading', text: 'AGENT' } }, runId: 'a', author: 'agent' },
      'job-1',
      'auto',
    );
    expect(r.status).toBe('rejected');
    expect(r.pinned).toEqual([`${hero}:text`]);
    expect(findNode(doc(h, pageId), hero)!.text).toBe('HUMAN');
  });

  it('a raw el.replace that PRESERVES the pinned value (same mid, tag, value) still applies', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN');
    const r = h.executor.submitOp(
      h.artifact,
      { op: { op: 'el.replace', pageId, mid: hero, node: { tag: 'UI.Heading', text: 'HUMAN', style: { color: 'red' } } }, runId: 'a', author: 'agent' },
      'job-1',
      'auto',
    );
    expect(r.status).toBe('applied');
    expect(findNode(doc(h, pageId), hero)!.style).toEqual({ color: 'red' });
  });

  it('force naming the pins as "<mid>:<cell>" lets the structural op through', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const card = midOfTag(h, pageId, 'UI.Card');
    humanSetText(h, pageId, hero, 'HUMAN');
    const res = dispatchCanvasTool('remove_element', { pageId, mid: card, force: [`${hero}:text`] }, h.ctx);
    expect(res.ok, res.error).toBe(true);
    expect(findNode(doc(h, pageId), card)).toBeNull();
  });

  it('a bare cell in force does not unlock a DESCENDANT\'s pin (the F2 ambiguity), only the target\'s own', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    const card = midOfTag(h, pageId, 'UI.Card');
    humanSetText(h, pageId, hero, 'HUMAN');
    const viaExecutor = h.executor.submitOp(
      h.artifact,
      { op: { op: 'el.remove', pageId, mid: card }, runId: 'a', author: 'agent', force: ['text'] },
      'job-1',
      'auto',
    );
    expect(viaExecutor.status).toBe('rejected');
    expect(viaExecutor.pinned).toEqual([`${hero}:text`]);
  });

  it('the replace_element tool with force still works end to end (dispatch guard + executor gate agree)', () => {
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN');
    const res = dispatchCanvasTool(
      'replace_element',
      { pageId, mid: hero, node: { tag: 'UI.Heading', text: 'AGENT' }, force: [`${hero}:text`] },
      h.ctx,
    );
    expect(res.ok, res.error).toBe(true);
    expect(findNode(doc(h, pageId), hero)!.text).toBe('AGENT');
  });

  it('unpinned structural ops are unaffected; a HUMAN may remove their own pinned element', () => {
    const pageId = seedPage(h);
    const stack = midOfTag(h, pageId, 'UI.Stack');
    expect(dispatchCanvasTool('remove_element', { pageId, mid: stack }, h.ctx).ok).toBe(true);

    const hero = heroMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN');
    const human = h.executor.submitOp(
      h.artifact,
      { op: { op: 'el.remove', pageId, mid: hero }, runId: 'human', author: 'user' },
      'job-1',
      'auto',
    );
    expect(human.status).toBe('applied');
    expect(findNode(doc(h, pageId), hero)).toBeNull();
  });

  it('a staged el.remove accepted after the human pinned inside it is refused at apply time (L-1 × L-3)', () => {
    const s = harness('staged');
    const pageId = seedPage(s);
    const hero = heroMid(s, pageId);
    const card = midOfTag(s, pageId, 'UI.Card');
    const staged = dispatchCanvasTool('remove_element', { pageId, mid: card }, s.ctx);
    expect(staged.ok).toBe(true);
    humanSetText(s, pageId, hero, 'HUMAN');
    const receipt = s.executor.applyStagedOp(s.artifact, staged.receipt!.opId, 'job-1');
    expect(receipt?.status).toBe('rejected');
    expect(receipt?.pinned).toEqual([`${hero}:text`]);
    expect(findNode(doc(s, pageId), card)).toBeTruthy();
  });
});

/* ══════════════════════════════════ L-4 ═══════════════════════════════ */

describe('L-4 — V2 page.add re-mints a colliding id, like insert_page', () => {
  it('a page.add carrying a LIVE page\'s id does not shadow that page', () => {
    const h = harness('auto');
    const pageId = seedPage(h);
    const hero = heroMid(h, pageId);
    humanSetText(h, pageId, hero, 'HUMAN');
    const template = stripPins(doc(h, pageId));
    findNode(template, hero)!.text = 'AGENT';

    const spec = { id: pageId, doc: template };
    const r = h.executor.submitOp(
      h.artifact,
      { op: { op: 'page.add', page: spec, index: 0 }, runId: 'a', author: 'agent' },
      'job-1',
      'auto',
    );
    expect(r.status).toBe('applied');
    expect(h.artifact.pages).toHaveLength(2);
    const ids = h.artifact.pages.map(p => p.id);
    expect(new Set(ids).size).toBe(2);
    // The human's artboard is still the one `getPage` resolves for its id.
    expect(findNode(h.store.getPage(h.artifact, pageId)!.doc, hero)!.text).toBe('HUMAN');
    // The op records the id that was actually minted, so redo is deterministic.
    expect(spec.id).not.toBe(pageId);
    expect(ids).toContain(spec.id);
    // (A `page.add` receipt has never carried `pageId` — `opPageId` has none to
    // read — so the mirrored op-log entry is where the minted id is recorded.)
    expect(h.store.findOp(h.artifact, r.opId)?.targetPageId).toBe(spec.id);
  });

  it('CONTROL: undo of page.remove still restores the page under its ORIGINAL id (no collision, no re-mint)', () => {
    const h = harness('auto');
    const pageId = seedPage(h);
    expect(dispatchCanvasTool('remove_page', { pageId }, h.ctx).ok).toBe(true);
    expect(h.artifact.pages).toHaveLength(0);
    h.executor.undoLastApplied(h.artifact, 'job-1');
    expect(h.artifact.pages.map(p => p.id)).toEqual([pageId]);
  });
});
