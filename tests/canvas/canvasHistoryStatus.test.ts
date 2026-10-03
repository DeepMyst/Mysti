/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 rows 5 and 6, host side — the snapshot the canvas chrome renders,
 * and the transaction-boundary semantics it reports.
 *
 * These run through the REAL `CanvasHistory` over the REAL executor and store,
 * because the claim being made is not "the UI has buttons" but "**one** shared
 * stack, where one human drag is one restore point and one agent turn is one
 * restore point". That is a property of the cursor, not of the chrome, and it
 * is only falsifiable here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { pageHtml } from '../../src/canvas/pageMigration';
import { renderPreview } from '../../src/webview/canvas/preview';
import { historyButtonState, txnSummary } from '../../src/webview/canvas/historyUi';
import type { ArtifactPage, CanvasArtifact, CanvasOp } from '../../src/types';

const JOB = 'job-status';

describe('CanvasHistory.status', () => {
  let store: ArtifactStore;
  let executor: CanvasOpExecutor;
  let artifact: CanvasArtifact;
  let history: CanvasHistory;

  function addPage(html: string, title = 'Page'): ArtifactPage {
    return store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: html, actionTitle: title }));
  }

  function edit(pageId: string, html: string, runId = 'r1', author: 'user' | 'agent' = 'agent'): CanvasOp {
    return executor.submit(
      artifact,
      { kind: 'edit_page', runId, author, targetPageId: pageId, proposedValue: { htmlSource: html } },
      JOB,
      'auto',
    )!;
  }

  function html(pageId: string): string | undefined {
    const page = store.getPage(artifact, pageId);
    return page ? pageHtml(page) : undefined;
  }

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    const router = new CanvasJobRouter(() => { /* drop */ });
    executor = new CanvasOpExecutor(store, router);
    artifact = store.createArtifact({ name: 'Test' });
    history = new CanvasHistory(artifact, executor, { jobId: JOB });
  });

  // ======================================================================
  // The snapshot
  // ======================================================================

  it('reports an empty stack on a fresh artifact', () => {
    const status = history.status();
    expect(status).toMatchObject({ canUndo: false, canRedo: false, position: 0 });
    expect(status.undo).toBeUndefined();
    expect(status.redo).toBeUndefined();
    expect(status.transactions).toEqual([]);
    expect(status.versions).toEqual([]);
  });

  it('names the step Cmd+Z would revert and the one Cmd+Shift+Z would replay', () => {
    const page = addPage('v0');
    edit(page.id, 'v1', 'turn-1');
    edit(page.id, 'v2', 'turn-2');

    let status = history.status();
    expect(status.canUndo).toBe(true);
    expect(status.canRedo).toBe(false);
    // `addPage` seeds through the store, not the executor, so only the two
    // agent turns are op-log transactions.
    expect(status.position).toBe(2);
    expect(status.undo?.runId).toBe('turn-2');
    expect(status.undo?.kinds).toEqual(['edit_page']);

    history.undo();
    status = history.status();
    expect(status.canUndo).toBe(true);
    expect(status.canRedo).toBe(true);
    expect(status.undo?.runId).toBe('turn-1');
    expect(status.redo?.runId).toBe('turn-2');
    expect(status.position).toBe(1);
  });

  it('flags exactly the in-effect transactions, so the timeline can draw the cursor', () => {
    const page = addPage('v0');
    edit(page.id, 'v1', 't1');
    edit(page.id, 'v2', 't2');
    history.undo();
    expect(history.status().transactions.map(t => t.inEffect)).toEqual([true, false]);
    history.undo();
    expect(history.status().transactions.map(t => t.inEffect)).toEqual([false, false]);
  });

  it('feeds the webview button state directly — one source of truth for both', () => {
    const page = addPage('v0');
    edit(page.id, 'v1', 'design-pass');
    const enabled = historyButtonState(history.status(), 'mac');
    expect(enabled.undoDisabled).toBe(false);
    expect(enabled.undoTitle).toContain('Mysti');

    history.undo();
    history.undo();                              // also undo the page insert
    const empty = historyButtonState(history.status(), 'mac');
    expect(empty.undoDisabled).toBe(true);
    expect(empty.redoDisabled).toBe(false);
  });

  // ======================================================================
  // Txn boundaries — the design commitment
  // ======================================================================

  it('ONE agent turn is ONE restore point, keyed by runId', () => {
    const p1 = addPage('a1');
    const p2 = addPage('b1');
    edit(p1.id, 'a2', 'design-pass');
    edit(p2.id, 'b2', 'design-pass');
    edit(p1.id, 'a3', 'design-pass');

    const status = history.status();
    expect(status.undo?.opCount).toBe(3);
    expect(status.undo?.author).toBe('agent');
    expect(status.undo?.runId).toBe('design-pass');
    expect(txnSummary(status.undo)).toBe('Mysti · edited an artboard · 3 ops');

    // One Cmd+Z reverts the WHOLE pass, not its last element op.
    history.undo();
    expect(html(p1.id)).toBe('a1');
    expect(html(p2.id)).toBe('b1');
  });

  it('ONE human drag is ONE restore point, and keeps its label', () => {
    const p1 = addPage('a1');
    const p2 = addPage('b1');
    history.beginTxn({ author: 'user', label: 'reorder artboards' });
    edit(p1.id, 'a2', 'gesture', 'user');
    edit(p2.id, 'b2', 'gesture', 'user');
    history.endTxn();

    const status = history.status();
    expect(status.undo?.opCount).toBe(2);
    expect(status.undo?.label).toBe('reorder artboards');
    expect(txnSummary(status.undo)).toBe('You · reorder artboards · 2 ops');
  });

  it('is ONE shared stack: Cmd+Z reverts the last thing that happened, whoever did it', () => {
    const page = addPage('v0');
    edit(page.id, 'agent-1', 'agent-turn', 'agent');
    edit(page.id, 'human-1', 'human-gesture', 'user');

    // Newest first — the human's own edit goes before the agent's.
    expect(history.status().undo?.author).toBe('user');
    history.undo();
    expect(html(page.id)).toBe('agent-1');

    expect(history.status().undo?.author).toBe('agent');
    history.undo();
    expect(html(page.id)).toBe('v0');
  });

  it('a new edit while rewound truncates the redo tail, and status says so', () => {
    const page = addPage('v0');
    edit(page.id, 'v1', 't1');
    history.undo();
    expect(history.status().canRedo).toBe(true);
    edit(page.id, 'v2', 't2');
    const status = history.status();
    expect(status.canRedo).toBe(false);
    expect(status.undo?.runId).toBe('t2');
  });

  // ======================================================================
  // Versions
  // ======================================================================

  it('carries the page count and a drawable thumbnail per checkpoint', () => {
    addPage('<h1>Sign in</h1>', 'Login');
    addPage('<h1>Home</h1>', 'Home');
    const ref = history.checkpoint('before rebrand');

    const [view] = history.versionViews();
    expect(view.id).toBe(ref.id);
    expect(view.label).toBe('before rebrand');
    expect(view.pageCount).toBe(2);
    expect(view.thumbDoc).toBeTruthy();
    expect(view.thumbFormat?.width).toBeGreaterThan(0);

    // The thumbnail is renderable by the parent-side, script-free renderer —
    // which is the only kind of thumbnail a `allow-scripts`-only frame permits.
    const preview = renderPreview(view.thumbDoc!, {});
    expect(preview.stats.nodes).toBeGreaterThan(0);
  });

  it('a checkpoint thumbnail is a COPY — a consumer cannot corrupt the restore', () => {
    const page = addPage('<h1>Sign in</h1>', 'Login');
    const ref = history.checkpoint('v0');
    const view = history.versionViews()[0];

    // The webview caches this object; mutating it must not reach the snapshot.
    view.thumbDoc!.tag = 'UI.Vandalised';
    view.label = 'renamed by a buggy consumer';

    edit(page.id, '<h1>Changed</h1>');
    history.restore(ref);
    expect(html(page.id)).toContain('Sign in');
    expect(history.versions()[0].label).toBe('v0');
  });

  it('later edits never leak into an existing checkpoint view', () => {
    addPage('one');
    const first = history.checkpoint('one page');
    addPage('two');
    const second = history.checkpoint('two pages');
    const views = history.versionViews();
    expect(views.map(v => v.pageCount)).toEqual([1, 2]);
    expect(views.map(v => v.id)).toEqual([first.id, second.id]);
  });

  // ======================================================================
  // Restore by id — what `canvas/restore` carries on the wire
  // ======================================================================

  it('restores by id string and emits OPS rather than assigning the snapshot back', () => {
    const page = addPage('checkpointed');
    const ref = history.checkpoint('v0');
    edit(page.id, 'wandered off', 'agent-turn');
    expect(html(page.id)).toBe('wandered off');

    const before = artifact.opLog.length;
    history.restore(ref.id);                    // ← the wire form
    expect(html(page.id)).toBe('checkpointed');

    const emitted = artifact.opLog.slice(before);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every(o => o.runId === `restore-${ref.id}`)).toBe(true);
    expect(emitted.every(o => o.status === 'applied')).toBe(true);
  });

  it('a restore is itself one undoable transaction', () => {
    const page = addPage('checkpointed');
    const ref = history.checkpoint('v0');
    edit(page.id, 'wandered off', 'agent-turn');
    const steps = history.status().transactions.length;

    history.restore(ref.id);
    expect(history.status().transactions).toHaveLength(steps + 1);
    expect(history.status().undo?.label).toBe('Restore "v0"');

    history.undo();
    expect(html(page.id)).toBe('wandered off');  // back to the pre-restore state
  });

  it('an unknown ref is a logged no-op, not a throw and not an op', () => {
    const page = addPage('stable');
    const before = artifact.opLog.length;
    expect(() => history.restore('no-such-version')).not.toThrow();
    expect(artifact.opLog.length).toBe(before);
    expect(html(page.id)).toBe('stable');
    expect(history.versionById('no-such-version')).toBeNull();
  });

  it('versionById round-trips a real checkpoint', () => {
    const ref = history.checkpoint('named');
    expect(history.versionById(ref.id)).toEqual(ref);
  });
});
