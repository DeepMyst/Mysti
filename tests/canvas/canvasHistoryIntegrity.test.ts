/**
 * Plan 22 — history/document agreement (OPLOG-2, OPLOG-6).
 *
 * The canvas keeps TWO records of what happened: `CanvasOpExecutor`'s journal
 * (what `since[]` and the `canvas/ops` delta read) and `artifact.opLog` (what
 * `CanvasHistory` ingests). These tests pin the two places they disagreed:
 *
 * - OPLOG-2: a transaction whose redo throws part-way left the document
 *   half-re-applied while the cursor stayed put, so history reported the
 *   transaction as undone while its first ops were in effect.
 * - OPLOG-6: truncating the redo tail flipped the op-log mirror to
 *   `superseded` and left the journal entry `applied`, so discarded ops kept
 *   being advertised to the agent in `since[]`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { collectMids } from '../../src/canvas/doc/DocNode';
import type { ArtifactPage, CanvasArtifact } from '../../src/types';

const JOB = 'j1';
const JSX_ONE = 'function Page(){ return <UI.Screen><UI.Heading>One</UI.Heading></UI.Screen>; }';
const JSX_TWO = 'function Page(){ return <UI.Screen><UI.Heading>Two</UI.Heading></UI.Screen>; }';

describe('canvas history integrity', () => {
  let store: ArtifactStore;
  let executor: CanvasOpExecutor;
  let history: CanvasHistory;
  let artifact: CanvasArtifact;
  let page: ArtifactPage;

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
    artifact = store.createArtifact({ name: 'History', kind: 'screens' });
    page = store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: JSX_ONE, actionTitle: 'P' }));
    history = new CanvasHistory(artifact, executor, { jobId: JOB });
  });

  const doc = () => store.getPage(artifact, page.id)!.doc;
  const heading = () => doc().children![0];

  describe('OPLOG-2 — a redo that throws part-way must not half-apply', () => {
    /**
     * One agent turn that (1) rewrites the whole artboard and (2) tweaks an
     * element inside the freshly-compiled tree. Re-compiling mints FRESH mids,
     * so replaying the turn makes the element op's target vanish — a real,
     * two-op transaction whose second op throws on redo.
     */
    function agentTurnThatFailsOnRedo(): void {
      executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r1', author: 'agent', targetPageId: page.id, proposedValue: { mode: 'jsx', jsxSource: JSX_TWO } },
        JOB,
        'auto',
      );
      const mid = heading().mid;
      executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid, text: 'Tweaked' }, runId: 'r1', author: 'agent', actorId: 'agent' },
        JOB,
        'auto',
      );
    }

    it('rolls the whole transaction back and leaves the cursor honest', () => {
      agentTurnThatFailsOnRedo();
      expect(heading().text).toBe('Tweaked');

      history.undo();
      expect(heading().text).toBe('One');
      expect(history.position()).toBe(0);
      const undoneMids = [...collectMids(doc())].sort();

      // The bug: this threw, having already re-applied the page rewrite.
      expect(() => history.redo()).not.toThrow();

      // Either the whole transaction is in effect and the cursor moved, or
      // nothing is — never "document changed, cursor did not".
      if (history.position() === 0) {
        expect(heading().text).toBe('One');
        expect([...collectMids(doc())].sort()).toEqual(undoneMids);
      } else {
        expect(heading().text).toBe('Tweaked');
      }
    });

    it('does not strand the pre-transaction document behind a second undo', () => {
      agentTurnThatFailsOnRedo();
      history.undo();
      try { history.redo(); } catch { /* pre-fix behaviour */ }
      // Whatever redo did, undoing back to zero must restore the original.
      while (history.canUndo()) { history.undo(); }
      expect(history.position()).toBe(0);
      expect(heading().text).toBe('One');
    });

    it('rolls an undo back when reverting an op throws part-way', () => {
      executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: heading().mid, text: 'A' }, runId: 'r9', author: 'agent', actorId: 'agent' },
        JOB,
        'auto',
      );
      executor.submitOp(
        artifact,
        { op: { op: 'page.setMeta', pageId: page.id, patch: { actionTitle: 'Renamed' } }, runId: 'r9', author: 'agent', actorId: 'agent' },
        JOB,
        'auto',
      );
      expect(heading().text).toBe('A');

      // Second revert of the transaction blows up (a store write that fails,
      // an inverse the algebra cannot express).
      const real = executor.revertApplied.bind(executor);
      let calls = 0;
      executor.revertApplied = (a, op, jobId) => {
        calls += 1;
        if (calls === 2) { throw new Error('boom'); }
        return real(a, op, jobId);
      };

      expect(() => history.undo()).not.toThrow();
      executor.revertApplied = real;

      // Nothing half-undone: either the txn is fully reverted (cursor moved)
      // or fully in effect (cursor did not).
      if (history.position() === 0) {
        expect(heading().text).toBe('One');
      } else {
        expect(heading().text).toBe('A');
        expect(store.getPage(artifact, page.id)!.actionTitle).toBe('Renamed');
      }
    });
  });

  describe('OPLOG-6 — truncating the redo tail must retire the journal entry too', () => {
    it('marks a discarded op superseded in the journal, not just the op log', () => {
      const receipt = executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: heading().mid, text: 'Agent' }, runId: 'agent-1', author: 'agent', actorId: 'agent' },
        JOB,
        'auto',
      );
      expect(receipt.status).toBe('applied');

      history.undo();
      // A new edit while the cursor is rewound truncates the redo tail.
      executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: heading().mid, text: 'Human' }, runId: 'human-1', author: 'user', actorId: 'canvas-view' },
        JOB,
        'auto',
      );
      history.position(); // force ingestion

      const mirror = artifact.opLog.find(o => o.opId === receipt.opId)!;
      expect(mirror.status).toBe('superseded');
      const entry = executor.journal(artifact.id).find(e => e.opId === receipt.opId)!;
      expect(entry.status).toBe('superseded');
    });

    it('stops advertising a discarded op to the next writer in since[]', () => {
      const stale = executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: heading().mid, text: 'Agent' }, runId: 'agent-1', author: 'agent', actorId: 'agent' },
        JOB,
        'auto',
      );
      const baseVersion = store.getPage(artifact, page.id)!.version;
      history.undo();
      executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: heading().mid, text: 'Human' }, runId: 'human-1', author: 'user', actorId: 'canvas-view' },
        JOB,
        'auto',
      );
      history.position();

      const next = executor.submitOp(
        artifact,
        { op: { op: 'el.setStyle', pageId: page.id, mid: heading().mid, style: { color: 'red' } }, runId: 'agent-2', author: 'agent', actorId: 'agent', baseVersion: baseVersion - 1, force: ['style.color', 'text'] },
        JOB,
        'auto',
      );
      const advertised = (next.since ?? []).map(r => r.opId);
      expect(advertised).not.toContain(stale.opId);
    });
  });
});
