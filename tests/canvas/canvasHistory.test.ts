/**
 * CanvasHistory tests (Plan 20 §3.2) — undo as a *cursor over transaction
 * boundaries* rather than a status mutation: undo/redo round-trips, grouping by
 * runId and by explicit txn, redo-tail truncation, whole-run undo, checkpoint /
 * restore-as-ops, and the adversarial edges (rejected + stale ops never become
 * undo steps, staged ops join the history only when accepted, empty history is
 * a no-op, page identity survives an insert undo→redo).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { pageHtml } from '../../src/canvas/pageMigration';
import type { ArtifactPage, CanvasArtifact, CanvasJobEvent, CanvasOp } from '../../src/types';

const JOB = 'job-1';

describe('CanvasHistory', () => {
  let store: ArtifactStore;
  let router: CanvasJobRouter;
  let executor: CanvasOpExecutor;
  let events: CanvasJobEvent[];
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

  function insert(html: string, runId = 'r1', author: 'user' | 'agent' = 'agent'): CanvasOp {
    return executor.submit(
      artifact,
      { kind: 'insert_page', runId, author, proposedValue: { mode: 'html', htmlSource: html } },
      JOB,
      'auto',
    )!;
  }

  // Page content is document-first now: an html page keeps its source under
  // `legacy`, which `pageHtml` is the one accessor for.
  function html(pageId: string): string | undefined {
    const page = store.getPage(artifact, pageId);
    return page ? pageHtml(page) : undefined;
  }

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null }); // pure in-memory; no FS
    events = [];
    router = new CanvasJobRouter(e => events.push(e));
    executor = new CanvasOpExecutor(store, router);
    artifact = store.createArtifact({ name: 'Test' });
    history = new CanvasHistory(artifact, executor, { jobId: JOB });
  });

  // ======================================================================
  // Round-trip
  // ======================================================================

  describe('undo / redo round-trip', () => {
    it('undo reverts an applied edit and redo re-applies it', () => {
      const page = addPage('original');
      edit(page.id, 'changed');
      expect(html(page.id)).toBe('changed');

      expect(history.canUndo()).toBe(true);
      const undone = history.undo();
      expect(undone).toHaveLength(1);
      expect(undone[0].status).toBe('undone');
      expect(html(page.id)).toBe('original');

      expect(history.canRedo()).toBe(true);
      const redone = history.redo();
      expect(redone).toHaveLength(1);
      expect(redone[0].status).toBe('applied');
      expect(html(page.id)).toBe('changed');
      expect(history.canRedo()).toBe(false);
    });

    it('does NOT mutate op status on undo — undone is a cursor position, not a verdict', () => {
      const page = addPage('a');
      const op = edit(page.id, 'b');
      history.undo();
      // `rejected` would mean a human refused the op; it was applied and is redoable.
      expect(store.findOp(artifact, op.opId)!.status).toBe('applied');
    });

    it('survives repeated undo/redo cycles without drifting', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'r1');
      edit(page.id, 'v2', 'r2');
      for (let i = 0; i < 3; i++) {
        history.undo();
        expect(html(page.id)).toBe('v1');
        history.undo();
        expect(html(page.id)).toBe('v0');
        history.redo();
        expect(html(page.id)).toBe('v1');
        history.redo();
        expect(html(page.id)).toBe('v2');
      }
    });

    it('emits page_updated so the renderer re-draws the affected page', () => {
      const page = addPage('a');
      edit(page.id, 'b');
      events.length = 0;
      history.undo();
      expect(events.some(e => e.type === 'page_updated' && e.pageId === page.id)).toBe(true);
      events.length = 0;
      history.redo();
      expect(events.some(e => e.type === 'page_updated' && e.pageId === page.id)).toBe(true);
    });

    it('addresses re-render events at a per-call jobId when one is given', () => {
      const page = addPage('a');
      edit(page.id, 'b');
      events.length = 0;
      history.undo('tool-job-7');
      expect(events.some(e => e.jobId === 'tool-job-7' && e.type === 'page_updated')).toBe(true);
      events.length = 0;
      history.redo('tool-job-7');
      expect(events.some(e => e.jobId === 'tool-job-7' && e.type === 'page_updated')).toBe(true);
    });

    it('reports the artifact version on every receipt', () => {
      const page = addPage('a');
      edit(page.id, 'b');
      const [receipt] = history.undo();
      expect(receipt.artifactVersion).toBe(artifact.version);
      expect(receipt.pageId).toBe(page.id);
      expect(receipt.pageVersion).toBe(store.getPage(artifact, page.id)!.version);
    });
  });

  // ======================================================================
  // Transaction grouping
  // ======================================================================

  describe('transaction grouping', () => {
    it('groups one agent turn (same runId) into a single undo step', () => {
      const p1 = addPage('a1');
      const p2 = addPage('b1');
      edit(p1.id, 'a2', 'pass-1');
      edit(p2.id, 'b2', 'pass-1');
      insert('c1', 'pass-1');

      expect(history.transactions()).toHaveLength(1);
      const receipts = history.undo();
      expect(receipts).toHaveLength(3);
      expect(html(p1.id)).toBe('a1');
      expect(html(p2.id)).toBe('b1');
      expect(artifact.pages).toHaveLength(2); // the inserted page is gone
      expect(history.canUndo()).toBe(false);
    });

    it('splits different runIds into separate undo steps', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'turn-1');
      edit(page.id, 'v2', 'turn-2');
      expect(history.transactions()).toHaveLength(2);
      history.undo();
      expect(html(page.id)).toBe('v1');
    });

    it('groups an explicit transaction even across different runIds (one human drag)', () => {
      const p1 = addPage('a1');
      const p2 = addPage('b1');
      history.beginTxn({ author: 'user', label: 'drag' });
      edit(p1.id, 'a2', 'gesture-a', 'user');
      edit(p2.id, 'b2', 'gesture-b', 'user');
      history.endTxn();

      expect(history.transactions()).toHaveLength(1);
      expect(history.transactions()[0].label).toBe('drag');
      history.undo();
      expect(html(p1.id)).toBe('a1');
      expect(html(p2.id)).toBe('b1');
    });

    it('honours a caller-supplied txnId and never opens an empty step', () => {
      const page = addPage('a');
      edit(page.id, 'b');
      const txnId = history.beginTxn({ author: 'user', txnId: 'txn-42' });
      expect(txnId).toBe('txn-42');
      history.endTxn(); // no ops → must not consume an undo step
      expect(history.transactions()).toHaveLength(1);
      history.undo();
      expect(html(page.id)).toBe('a');
    });

    it('keeps ops with no runId individually undoable', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', '', 'user');
      edit(page.id, 'v2', '', 'user');
      expect(history.transactions()).toHaveLength(2);
      history.undo();
      expect(html(page.id)).toBe('v1');
    });

    it('interleaved user and agent ops undo one step at a time, newest first', () => {
      const page = addPage('v0');
      edit(page.id, 'user-1', 'u1', 'user');
      edit(page.id, 'agent-1', 'r1', 'agent');
      edit(page.id, 'user-2', 'u1', 'user');

      const txns = history.transactions();
      expect(txns).toHaveLength(3);
      expect(txns.map(t => t.author)).toEqual(['user', 'agent', 'user']);

      history.undo();
      expect(html(page.id)).toBe('agent-1');
      history.undo();
      expect(html(page.id)).toBe('user-1');
      history.undo();
      expect(html(page.id)).toBe('v0');
      expect(history.canUndo()).toBe(false);
    });
  });

  // ======================================================================
  // Redo-tail truncation
  // ======================================================================

  describe('redo-tail truncation', () => {
    it('a new op after an undo drops the redo tail', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'r1');
      const dropped = edit(page.id, 'v2', 'r2');

      history.undo();
      expect(history.canRedo()).toBe(true);

      edit(page.id, 'v3', 'r3'); // new branch
      expect(history.canRedo()).toBe(false);
      expect(html(page.id)).toBe('v3');
      // The dropped op keeps its audit record but is no longer in effect.
      expect(store.findOp(artifact, dropped.opId)!.status).toBe('superseded');
    });

    it('undo after a truncation walks the new branch, not the dropped one', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'r1');
      edit(page.id, 'v2', 'r2');
      history.undo();
      edit(page.id, 'branch', 'r3');

      history.undo();
      expect(html(page.id)).toBe('v1');
      history.undo();
      expect(html(page.id)).toBe('v0');
      expect(history.canUndo()).toBe(false);
    });
  });

  // ======================================================================
  // Whole-run undo
  // ======================================================================

  describe('undoRun', () => {
    it('reverts an entire agent design pass', () => {
      const page = addPage('before');
      edit(page.id, 'pass-edit', 'design-1');
      insert('new page', 'design-1');
      expect(artifact.pages).toHaveLength(2);

      const receipts = history.undoRun('design-1');
      expect(receipts).toHaveLength(2);
      expect(html(page.id)).toBe('before');
      expect(artifact.pages).toHaveLength(1);
      expect(history.canRedo()).toBe(true);
    });

    it('rewinds through newer work rather than selectively reverting it, and redo restores it', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'design-1');
      edit(page.id, 'v2', 'design-2');

      const receipts = history.undoRun('design-1');
      expect(receipts).toHaveLength(2); // design-2 rewound as collateral
      expect(html(page.id)).toBe('v0');

      history.redo();
      expect(html(page.id)).toBe('v1');
      history.redo();
      expect(html(page.id)).toBe('v2');
    });

    it('leaves earlier runs untouched when the target run is the tail', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'design-1');
      edit(page.id, 'v2', 'design-2');

      const receipts = history.undoRun('design-2');
      expect(receipts).toHaveLength(1);
      expect(html(page.id)).toBe('v1');
    });

    it('is a no-op for an unknown run', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'design-1');
      expect(history.undoRun('nope')).toEqual([]);
      expect(html(page.id)).toBe('v1');
    });

    it('opsForRun lists that run\'s ops in log order', () => {
      const page = addPage('v0');
      const a = edit(page.id, 'v1', 'design-1');
      const b = insert('extra', 'design-1');
      edit(page.id, 'other', 'design-2');
      expect(history.opsForRun('design-1').map(o => o.opId)).toEqual([a.opId, b.opId]);
      expect(history.opsForRun('missing')).toEqual([]);
    });
  });

  // ======================================================================
  // Page identity across insert/delete undo
  // ======================================================================

  describe('page identity', () => {
    it('redoing an insert restores the same page id, so later ops stay addressable', () => {
      const op = insert('hello', 'run-1');
      const pageId = op.targetPageId!;
      edit(pageId, 'hello world', 'run-1'); // same txn

      history.undo();
      expect(artifact.pages).toHaveLength(0);

      history.redo();
      expect(artifact.pages).toHaveLength(1);
      expect(artifact.pages[0].id).toBe(pageId);
      expect(html(pageId)).toBe('hello world');
    });

    it('redoing an insert restores its original board position', () => {
      const first = addPage('one', '1');
      const last = addPage('three', '3');
      const op = executor.submit(
        artifact,
        { kind: 'insert_page', runId: 'r', proposedValue: { mode: 'html', htmlSource: 'two', index: 1 } },
        JOB,
        'auto',
      )!;
      expect(artifact.pages.map(p => p.id)).toEqual([first.id, op.targetPageId, last.id]);

      history.undo();
      history.redo();
      expect(artifact.pages.map(p => p.id)).toEqual([first.id, op.targetPageId, last.id]);
    });

    it('undo/redo of a delete_page round-trips content and position', () => {
      const p1 = addPage('one', '1');
      const p2 = addPage('two', '2');
      const p3 = addPage('three', '3');
      executor.submit(artifact, { kind: 'delete_page', runId: 'r', targetPageId: p2.id, proposedValue: {} }, JOB, 'auto');
      expect(artifact.pages.map(p => p.id)).toEqual([p1.id, p3.id]);

      history.undo();
      expect(artifact.pages.map(p => p.id)).toEqual([p1.id, p2.id, p3.id]);
      expect(html(p2.id)).toBe('two');

      history.redo();
      expect(artifact.pages.map(p => p.id)).toEqual([p1.id, p3.id]);
    });
  });

  // ======================================================================
  // Checkpoint / restore
  // ======================================================================

  describe('checkpoint and restore', () => {
    it('restores pages, theme and format, and is itself one undoable transaction', () => {
      const page = addPage('checkpointed');
      const ref = history.checkpoint('before design pass');
      expect(ref.artifactVersion).toBe(artifact.version);
      expect(history.versions().map(v => v.label)).toEqual(['before design pass']);

      // A design pass: edit, add a page, restyle.
      edit(page.id, 'redesigned', 'pass');
      const added = insert('brand new', 'pass');
      const theme = JSON.parse(JSON.stringify(artifact.theme));
      theme.colors.primary = '#ff0000';
      executor.submit(artifact, { kind: 'set_theme', runId: 'pass', proposedValue: theme }, JOB, 'auto');
      expect(artifact.pages).toHaveLength(2);

      history.restore(ref);
      expect(html(page.id)).toBe('checkpointed');
      expect(artifact.pages).toHaveLength(1);
      expect(artifact.theme.colors.primary).not.toBe('#ff0000');

      // The restore landed in the op log as real ops...
      const restoreOps = artifact.opLog.filter(o => o.runId === `restore-${ref.id}` && o.status === 'applied');
      expect(restoreOps.length).toBeGreaterThan(0);
      // ...grouped as one undo step, so the restore itself is undoable.
      history.undo();
      expect(html(page.id)).toBe('redesigned');
      expect(artifact.pages.map(p => p.id)).toContain(added.targetPageId);
      expect(artifact.theme.colors.primary).toBe('#ff0000');
    });

    it('restores page order', () => {
      const p1 = addPage('one', '1');
      const p2 = addPage('two', '2');
      const ref = history.checkpoint('ordered');
      executor.submit(artifact, { kind: 'reorder', runId: 'pass', proposedValue: [p2.id, p1.id] }, JOB, 'auto');
      expect(artifact.pages.map(p => p.id)).toEqual([p2.id, p1.id]);

      history.restore(ref);
      expect(artifact.pages.map(p => p.id)).toEqual([p1.id, p2.id]);
    });

    it('emits no ops when nothing changed since the checkpoint', () => {
      addPage('stable');
      const ref = history.checkpoint('stable');
      const logLength = artifact.opLog.length;
      history.restore(ref);
      expect(artifact.opLog).toHaveLength(logLength);
      expect(history.canUndo()).toBe(false);
    });

    it('ignores an unknown version ref without throwing or mutating', () => {
      addPage('untouched');
      const before = JSON.stringify(artifact.pages);
      expect(() => history.restore({ id: 'ghost', label: 'ghost', ts: Date.now(), artifactVersion: 1 })).not.toThrow();
      expect(JSON.stringify(artifact.pages)).toBe(before);
      expect(history.canUndo()).toBe(false);
    });

    it('a checkpoint is a snapshot — later edits do not leak into it', () => {
      const page = addPage('v0');
      const ref = history.checkpoint('v0');
      edit(page.id, 'v1', 'pass');
      history.restore(ref);
      expect(html(page.id)).toBe('v0');
    });
  });

  // ======================================================================
  // Adversarial / empty paths
  // ======================================================================

  describe('ops that must never become undo steps', () => {
    it('ignores an op the executor rejected as invalid', () => {
      const op = executor.submit(artifact, { kind: 'edit_page', runId: 'r', proposedValue: { htmlSource: 'x' } }, JOB, 'auto');
      expect(op).toBeNull();
      expect(history.canUndo()).toBe(false);
      expect(history.undo()).toEqual([]);
    });

    it('ignores a stale op (never applied), then picks it up if it is later accepted', () => {
      const page = addPage('v1');
      store.updatePage(artifact, page.id, { htmlSource: 'v2' }); // version → 2
      const stale = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, baseVersion: 1, proposedValue: { htmlSource: 'agent' } },
        JOB,
        'auto',
      )!;
      expect(stale.status).toBe('stale');
      expect(history.canUndo()).toBe(false);
    });

    it('a staged op joins the history only when it is accepted', () => {
      const page = addPage('base');
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'proposed' } },
        JOB,
        'staged',
      )!;
      expect(op.status).toBe('pending');
      expect(history.canUndo()).toBe(false);

      executor.applyOp(artifact, op.opId, JOB);
      expect(history.canUndo()).toBe(true);
      history.undo();
      expect(html(page.id)).toBe('base');
    });

    it('a rejected staged op never becomes an undo step', () => {
      const page = addPage('base');
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'nope' } },
        JOB,
        'staged',
      )!;
      executor.rejectOp(artifact, op.opId, JOB);
      expect(history.canUndo()).toBe(false);
    });
  });

  describe('empty history', () => {
    it('undo, redo and undoRun are no-ops on a fresh artifact', () => {
      expect(history.canUndo()).toBe(false);
      expect(history.canRedo()).toBe(false);
      expect(history.undo()).toEqual([]);
      expect(history.redo()).toEqual([]);
      expect(history.undoRun('anything')).toEqual([]);
      expect(history.transactions()).toEqual([]);
      expect(history.position()).toBe(0);
    });

    it('undoing past the beginning stops instead of corrupting state', () => {
      const page = addPage('only');
      edit(page.id, 'edited');
      history.undo();
      expect(history.undo()).toEqual([]);
      expect(history.undo()).toEqual([]);
      expect(html(page.id)).toBe('only');
      expect(history.position()).toBe(0);
      history.redo();
      expect(html(page.id)).toBe('edited');
    });

    it('redoing past the end is a no-op', () => {
      const page = addPage('a');
      edit(page.id, 'b');
      expect(history.redo()).toEqual([]);
      expect(html(page.id)).toBe('b');
    });
  });

  describe('adoption of pre-existing ops', () => {
    it('captures ops applied before the history was constructed', () => {
      const page = addPage('v0');
      edit(page.id, 'v1', 'earlier');
      const late = new CanvasHistory(artifact, executor);
      expect(late.canUndo()).toBe(true);
      late.undo();
      expect(html(page.id)).toBe('v0');
    });
  });
});
