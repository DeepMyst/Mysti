/**
 * CanvasOpExecutor tests — the agent-to-canvas write contract (Plan 05 Phase 2):
 * validation/cross-artifact guard, base-version → stale, staged vs auto apply,
 * supersession, inline-edit lock queueing, and op-log undo restoring
 * previousValue (agent and user ops alike).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import type { CanvasArtifact, CanvasJobEvent, ArtifactPage } from '../../src/types';

const JOB = 'job-1';

describe('CanvasOpExecutor', () => {
  let store: ArtifactStore;
  let router: CanvasJobRouter;
  let executor: CanvasOpExecutor;
  let events: CanvasJobEvent[];
  let artifact: CanvasArtifact;

  function types(): string[] {
    return events.map(e => e.type);
  }

  function addPage(html: string, title = 'Page'): ArtifactPage {
    return store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: html, actionTitle: title }));
  }

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null }); // pure in-memory; no FS
    events = [];
    router = new CanvasJobRouter(e => events.push(e));
    executor = new CanvasOpExecutor(store, router);
    artifact = store.createArtifact({ name: 'Test' });
  });

  describe('validation', () => {
    it('rejects edit_page with no targetPageId (op_error, returns null)', () => {
      const op = executor.submit(artifact, { kind: 'edit_page', runId: 'r', proposedValue: { htmlSource: 'x' } }, JOB);
      expect(op).toBeNull();
      expect(types()).toEqual(['op_error']);
    });

    it('rejects edit_page targeting a page in no artifact (cross-artifact guard)', () => {
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: 'ghost', proposedValue: { htmlSource: 'x' } },
        JOB,
      );
      expect(op).toBeNull();
      expect(events[0].error).toContain('does not belong');
    });

    it('rejects insert_page without a mode', () => {
      const op = executor.submit(artifact, { kind: 'insert_page', runId: 'r', proposedValue: { htmlSource: 'x' } }, JOB);
      expect(op).toBeNull();
      expect(types()).toEqual(['op_error']);
    });
  });

  describe('staged vs auto', () => {
    it('staged mode parks the op pending and only applies on accept', () => {
      const page = addPage('old');
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'new' } },
        JOB,
        'staged',
      )!;
      expect(op.status).toBe('pending');
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('old'); // not yet applied
      expect(types()).toEqual(['op_staged']);

      executor.applyOp(artifact, op.opId, JOB);
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('new');
      expect(types()).toContain('op_applied');
      expect(events.some(e => e.type === 'page_updated' && e.pageId === page.id)).toBe(true);
    });

    it('auto mode applies immediately', () => {
      const op = executor.submit(
        artifact,
        { kind: 'insert_page', runId: 'r', proposedValue: { mode: 'html', htmlSource: 'hi' } },
        JOB,
        'auto',
      )!;
      expect(op.status).toBe('applied');
      expect(artifact.pages).toHaveLength(1);
      expect(types()).toContain('op_applied');
    });

    it('rejectOp marks a pending op rejected without applying', () => {
      const page = addPage('keep');
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'drop' } },
        JOB,
      )!;
      executor.rejectOp(artifact, op.opId, JOB);
      expect(store.findOp(artifact, op.opId)!.status).toBe('rejected');
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('keep');
      expect(types()).toContain('op_rejected');
    });
  });

  describe('base-version staleness', () => {
    it('marks an op stale when baseVersion lags the page version', () => {
      const page = addPage('v1');
      store.updatePage(artifact, page.id, { htmlSource: 'v2' }); // page.version → 2
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, baseVersion: 1, proposedValue: { htmlSource: 'agent' } },
        JOB,
        'auto', // even in auto mode a stale op must not clobber
      )!;
      expect(op.status).toBe('stale');
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('v2'); // untouched
    });

    it('applies when baseVersion matches', () => {
      const page = addPage('v1'); // version 1
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, baseVersion: 1, proposedValue: { htmlSource: 'ok' } },
        JOB,
        'auto',
      )!;
      expect(op.status).toBe('applied');
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('ok');
    });
  });

  describe('supersession', () => {
    it('applying one op supersedes other pending ops on the same page', () => {
      const page = addPage('base');
      const a = executor.submit(artifact, { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'A' } }, JOB)!;
      const b = executor.submit(artifact, { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'B' } }, JOB)!;
      executor.applyOp(artifact, a.opId, JOB);
      expect(store.findOp(artifact, a.opId)!.status).toBe('applied');
      expect(store.findOp(artifact, b.opId)!.status).toBe('superseded');
    });
  });

  describe('inline-edit lock', () => {
    it('queues auto ops while a page is locked and flushes them on unlock', () => {
      const page = addPage('base');
      executor.setPageEditing(artifact, page.id, true, JOB);
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'queued' } },
        JOB,
        'auto',
      )!;
      expect(op.status).toBe('pending');               // parked, not applied
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('base');

      executor.setPageEditing(artifact, page.id, false, JOB); // unlock → flush
      expect(store.findOp(artifact, op.opId)!.status).toBe('applied');
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('queued');
    });
  });

  describe('op-log undo', () => {
    it('undo of an applied edit restores previousValue', () => {
      const page = addPage('original');
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'changed' } },
        JOB,
        'auto',
      )!;
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('changed');
      const undone = executor.undoLastApplied(artifact, JOB);
      expect(undone!.opId).toBe(op.opId);
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('original');
    });

    it('undo of a delete_page restores the page at its original index', () => {
      const p1 = addPage('one', '1');
      const p2 = addPage('two', '2');
      const p3 = addPage('three', '3');
      executor.submit(artifact, { kind: 'delete_page', runId: 'r', targetPageId: p2.id, proposedValue: {} }, JOB, 'auto');
      expect(artifact.pages.map(p => p.id)).toEqual([p1.id, p3.id]);
      executor.undoLastApplied(artifact, JOB);
      expect(artifact.pages.map(p => p.id)).toEqual([p1.id, p2.id, p3.id]);
    });

    it('undo of an insert_page removes the inserted page', () => {
      executor.submit(artifact, { kind: 'insert_page', runId: 'r', proposedValue: { mode: 'html', htmlSource: 'new' } }, JOB, 'auto');
      expect(artifact.pages).toHaveLength(1);
      executor.undoLastApplied(artifact, JOB);
      expect(artifact.pages).toHaveLength(0);
    });

    it('undo works across authors — undoing the most recent applied op', () => {
      const page = addPage('start');
      // user op, then agent op
      executor.submit(artifact, { kind: 'edit_page', runId: 'u', author: 'user', targetPageId: page.id, proposedValue: { htmlSource: 'user-edit' } }, JOB, 'auto');
      executor.submit(artifact, { kind: 'edit_page', runId: 'a', author: 'agent', targetPageId: page.id, proposedValue: { htmlSource: 'agent-edit' } }, JOB, 'auto');
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('agent-edit');
      executor.undoLastApplied(artifact, JOB); // undo agent edit
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('user-edit');
      executor.undoLastApplied(artifact, JOB); // undo user edit
      expect(store.getPage(artifact, page.id)!.htmlSource).toBe('start');
    });

    it('set_theme is undoable', () => {
      const original = artifact.theme.colors.primary;
      const newTheme = JSON.parse(JSON.stringify(artifact.theme));
      newTheme.colors.primary = '#000000';
      executor.submit(artifact, { kind: 'set_theme', runId: 'r', proposedValue: newTheme }, JOB, 'auto');
      expect(artifact.theme.colors.primary).toBe('#000000');
      executor.undoLastApplied(artifact, JOB);
      expect(artifact.theme.colors.primary).toBe(original);
    });
  });
});
