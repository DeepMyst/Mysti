/**
 * CanvasOpExecutor tests.
 *
 * Part 1 is the Plan 05 Phase 2 write contract, unchanged in intent:
 * validation/cross-artifact guard, base-version → stale, staged vs auto apply,
 * supersession, inline-edit lock queueing, and op-log undo (agent and user ops
 * alike) — now expressed against document-first pages.
 *
 * Part 2 is the Plan 22 §3.2 op algebra: document mutations through
 * `DocPatch.applyOp` with an exact `inverse` instead of a page snapshot,
 * scope-correct staleness, semantic rebase, per-cell pins, subtree locks and
 * `since[]`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { pageHtml, pageJsx } from '../../src/canvas/pageMigration';
import { findNode, walk } from '../../src/canvas/doc/DocNode';
import type { CanvasOp as CanvasOpV2 } from '../../src/canvas/CanvasOps';
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

  /** Legacy html content, read through the doc-first accessor. */
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
      expect(html(page.id)).toBe('old'); // not yet applied
      expect(types()).toEqual(['op_staged']);

      executor.applyOp(artifact, op.opId, JOB);
      expect(html(page.id)).toBe('new');
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
      expect(html(page.id)).toBe('keep');
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
      expect(html(page.id)).toBe('v2'); // untouched
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
      expect(html(page.id)).toBe('ok');
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
      expect(html(page.id)).toBe('base');

      executor.setPageEditing(artifact, page.id, false, JOB); // unlock → flush
      expect(store.findOp(artifact, op.opId)!.status).toBe('applied');
      expect(html(page.id)).toBe('queued');
    });
  });

  describe('op-log undo', () => {
    it('undo of an applied edit restores the previous content', () => {
      const page = addPage('original');
      const op = executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r', targetPageId: page.id, proposedValue: { htmlSource: 'changed' } },
        JOB,
        'auto',
      )!;
      expect(html(page.id)).toBe('changed');
      const undone = executor.undoLastApplied(artifact, JOB);
      expect(undone!.opId).toBe(op.opId);
      expect(html(page.id)).toBe('original');
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
      expect(html(page.id)).toBe('agent-edit');
      executor.undoLastApplied(artifact, JOB); // undo agent edit
      expect(html(page.id)).toBe('user-edit');
      executor.undoLastApplied(artifact, JOB); // undo user edit
      expect(html(page.id)).toBe('start');
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

  // ======================================================================
  // Plan 22 §3.2 — the op algebra
  // ======================================================================

  describe('Plan 22 — document ops', () => {
    const TWO_BRANCHES =
      'function Page(){ return <UI.Screen>'
      + '<UI.Card><UI.Text>inside</UI.Text></UI.Card>'
      + '<UI.Text>outside</UI.Text>'
      + '</UI.Screen>; }';

    function addJsx(jsx = TWO_BRANCHES, title = 'Screen'): ArtifactPage {
      return store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: jsx, actionTitle: title }));
    }

    /** The mid of the first node whose text equals `text`. */
    function midOf(pageId: string, text: string): string {
      const page = store.getPage(artifact, pageId)!;
      for (const n of walk(page.doc)) { if (n.text === text) { return n.mid; } }
      throw new Error(`no node with text "${text}"`);
    }

    function midOfTag(pageId: string, tag: string): string {
      const page = store.getPage(artifact, pageId)!;
      for (const n of walk(page.doc)) { if (n.tag === tag) { return n.mid; } }
      throw new Error(`no node with tag "${tag}"`);
    }

    function textOf(pageId: string, mid: string): string | undefined {
      return findNode(store.getPage(artifact, pageId)!.doc, mid)?.text;
    }

    describe('applyOp + inverse (no page snapshots)', () => {
      it('applies an element op and records an inverse that exactly undoes it', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid, text: 'changed' }, runId: 'r' },
          JOB,
          'auto',
        );
        expect(r.status).toBe('applied');
        expect(textOf(page.id, mid)).toBe('changed');

        const record = executor.journal(artifact.id).find(e => e.opId === r.opId)!;
        expect(record.inverse).toEqual({ op: 'el.setText', pageId: page.id, mid, text: 'outside' });

        executor.submitOp(artifact, { op: record.inverse as CanvasOpV2, runId: 'undo' }, JOB, 'auto');
        expect(textOf(page.id, mid)).toBe('outside');
      });

      it('a whole-artboard write inverts to the previous document, not a source string', () => {
        const page = addJsx();
        const before = JSON.parse(JSON.stringify(page.doc));
        const r = executor.submitOp(
          artifact,
          { op: { op: 'page.setDoc', pageId: page.id, doc: { mid: 'zzzzzzzzzz', tag: 'UI.Screen', text: 'wiped' } }, runId: 'r' },
          JOB,
          'auto',
        );
        expect(r.status).toBe('applied');
        expect(store.getPage(artifact, page.id)!.doc.text).toBe('wiped');

        const inverse = executor.journal(artifact.id).find(e => e.opId === r.opId)!.inverse!;
        executor.submitOp(artifact, { op: inverse, runId: 'undo' }, JOB, 'auto');
        expect(store.getPage(artifact, page.id)!.doc).toEqual(before);
      });

      it('page.add / page.remove / page.duplicate round-trip through their inverses', () => {
        const page = addJsx();
        const dup = executor.submitOp(artifact, { op: { op: 'page.duplicate', pageId: page.id }, runId: 'r' }, JOB, 'auto');
        expect(artifact.pages).toHaveLength(2);
        // A duplicate must NOT share mids, or two artboards become one element-wise.
        const a = new Set([...walk(artifact.pages[0].doc)].map(n => n.mid));
        const b = [...walk(artifact.pages[1].doc)].map(n => n.mid);
        expect(b.some(m => a.has(m))).toBe(false);

        const undoDup = executor.journal(artifact.id).find(e => e.opId === dup.opId)!.inverse!;
        executor.submitOp(artifact, { op: undoDup, runId: 'undo' }, JOB, 'auto');
        expect(artifact.pages).toHaveLength(1);

        const removed = executor.submitOp(artifact, { op: { op: 'page.remove', pageId: page.id }, runId: 'r' }, JOB, 'auto');
        expect(artifact.pages).toHaveLength(0);
        const undoRemove = executor.journal(artifact.id).find(e => e.opId === removed.opId)!.inverse!;
        executor.submitOp(artifact, { op: undoRemove, runId: 'undo' }, JOB, 'auto');
        // The SAME id comes back — an undo that re-ids would orphan every pin,
        // comment and staged op that addresses the artboard.
        expect(artifact.pages.map(p => p.id)).toEqual([page.id]);
        expect(pageJsx(artifact.pages[0])).toContain('inside');
      });

      it('a vanished mid is a typed stale receipt, never a receipt claiming success', () => {
        const page = addJsx();
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: 'aaaaaaaaaa', text: 'x' }, runId: 'r' },
          JOB,
          'auto',
        );
        expect(r.status).toBe('stale');
        expect(r.error).toContain('not in this document');
      });
    });

    describe('scope-correct staleness', () => {
      it('an artifact-scoped op checks artifact.version, not some page version', () => {
        addJsx();
        const at = artifact.version;
        const fresh = executor.submitOp(
          artifact,
          { op: { op: 'artifact.setFormat', format: { formatId: 'story-9x16', kind: 'screen', width: 1080, height: 1920 } }, runId: 'r', baseVersion: at },
          JOB, 'auto',
        );
        expect(fresh.status).toBe('applied');

        const stale = executor.submitOp(
          artifact,
          { op: { op: 'theme.set', theme: artifact.theme }, runId: 'r', baseVersion: at },
          JOB, 'auto',
        );
        expect(stale.status).toBe('stale');
      });

      it('a page op still checks page.version — an unrelated artifact bump is not a conflict', () => {
        const page = addJsx();
        const v = page.version;
        executor.submitOp(artifact, { op: { op: 'theme.setToken', path: 'colors.primary', value: '#123456' }, runId: 'r' }, JOB, 'auto');
        expect(artifact.version).toBeGreaterThan(v);
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'outside'), text: 'ok' }, runId: 'r', baseVersion: v },
          JOB, 'auto',
        );
        expect(r.status).toBe('applied');
        expect(r.rebased).toBeUndefined();
      });

      it('legacy artifact-scoped kinds are checked against artifact.version too', () => {
        const at = artifact.version;
        store.setTheme(artifact, artifact.theme);              // someone else moved
        const op = executor.submit(
          artifact,
          { kind: 'set_theme', runId: 'r', baseVersion: at, proposedValue: artifact.theme },
          JOB, 'auto',
        )!;
        expect(op.status).toBe('stale');
      });
    });

    describe('semantic rebase', () => {
      it('re-applies a stale element op whose mid survived and says so', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        const v = page.version;
        // Someone else edits a DIFFERENT element, bumping the page version.
        executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'inside'), text: 'moved' }, runId: 'other' },
          JOB, 'auto',
        );
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid, text: 'late' }, runId: 'r', baseVersion: v },
          JOB, 'auto',
        );
        expect(r.status).toBe('applied');
        expect(r.rebased).toBe(true);
        expect(textOf(page.id, mid)).toBe('late');
        expect(textOf(page.id, midOf(page.id, 'moved'))).toBe('moved');   // not clobbered
      });

      it('does not rebase when the target element is gone', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        const v = page.version;
        executor.submitOp(artifact, { op: { op: 'el.remove', pageId: page.id, mid }, runId: 'other' }, JOB, 'auto');
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid, text: 'late' }, runId: 'r', baseVersion: v },
          JOB, 'auto',
        );
        expect(r.status).toBe('stale');
        expect(r.rebased).toBeUndefined();
      });

      it('page.setMeta inverts exactly, including back to "no title at all"', () => {
        const page = addJsx();
        expect(page.actionTitle).toBe('Screen');
        const set = executor.submitOp(artifact, { op: { op: 'page.setMeta', pageId: page.id, patch: { actionTitle: 'Renamed', notes: 'n' } }, runId: 'r' }, JOB, 'auto');
        expect(store.getPage(artifact, page.id)!.actionTitle).toBe('Renamed');
        const inverse = executor.journal(artifact.id).find(e => e.opId === set.opId)!.inverse!;
        executor.submitOp(artifact, { op: inverse, runId: 'undo' }, JOB, 'auto');
        const back = store.getPage(artifact, page.id)!;
        expect(back.actionTitle).toBe('Screen');
        // `notes` had no prior value, so the undo must REMOVE it, not keep it.
        expect('notes' in back).toBe(false);
      });

      it('a page-scoped op with a stale base is stale — it has no element to rebase on', () => {
        const page = addJsx();
        const v = page.version;
        executor.submitOp(artifact, { op: { op: 'page.setMeta', pageId: page.id, patch: { actionTitle: 'A' } }, runId: 'o' }, JOB, 'auto');
        const r = executor.submitOp(
          artifact,
          { op: { op: 'page.setMeta', pageId: page.id, patch: { actionTitle: 'B' } }, runId: 'r', baseVersion: v },
          JOB, 'auto',
        );
        expect(r.status).toBe('stale');
        expect(store.getPage(artifact, page.id)!.actionTitle).toBe('A');
      });
    });

    describe('pins (§3.5)', () => {
      function userSetsText(pageId: string, mid: string, text: string) {
        return executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId, mid, text }, runId: 'human', author: 'user' },
          JOB, 'auto',
        );
      }

      it('a committed user op pins the cells it wrote, and the emitted JSX shows it', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        userSetsText(page.id, mid, 'mine');
        const node = findNode(store.getPage(artifact, page.id)!.doc, mid)!;
        expect(Object.keys(node.pins ?? {})).toEqual(['text']);
        expect(pageJsx(store.getPage(artifact, page.id)!)).toContain('user-set: text');
      });

      it('an unforced agent write to a pinned cell is refused, naming the cell', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        userSetsText(page.id, mid, 'mine');
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid, text: 'agent' }, runId: 'a', author: 'agent' },
          JOB, 'auto',
        );
        expect(r.status).toBe('rejected');
        expect(r.pinned).toEqual(['text']);
        expect(textOf(page.id, mid)).toBe('mine');
      });

      it('pins are per CELL, not per node — the agent may still restyle a pinned node', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        userSetsText(page.id, mid, 'mine');
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setStyle', pageId: page.id, mid, style: { color: 'red' } }, runId: 'a' },
          JOB, 'auto',
        );
        expect(r.status).toBe('applied');
        expect(findNode(store.getPage(artifact, page.id)!.doc, mid)!.style).toEqual({ color: 'red' });
      });

      it('a force list overrides exactly the cells it names', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        userSetsText(page.id, mid, 'mine');
        const forced = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid, text: 'agent' }, runId: 'a', force: ['text'] },
          JOB, 'auto',
        );
        expect(forced.status).toBe('applied');
        expect(textOf(page.id, mid)).toBe('agent');

        // A force naming a DIFFERENT cell does not unlock this one.
        userSetsText(page.id, mid, 'mine again');
        const wrong = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid, text: 'nope' }, runId: 'a', force: ['style.color'] },
          JOB, 'auto',
        );
        expect(wrong.status).toBe('rejected');
        expect(wrong.pinned).toEqual(['text']);
      });

      it('a user op is never blocked by another user’s pin — pins bind the agent', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        userSetsText(page.id, mid, 'first');
        expect(userSetsText(page.id, mid, 'second').status).toBe('applied');
      });

      it('forging author on the payload cannot bypass a pin — author is stamped host-side', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        userSetsText(page.id, mid, 'mine');
        // A model-authored payload claiming `author: 'user'` inside the OP is
        // ignored: the executor only ever reads the submission's stamped author.
        const hostile = { op: 'el.setText', pageId: page.id, mid, text: 'agent', author: 'user' } as unknown as CanvasOpV2;
        const r = executor.submitOp(artifact, { op: hostile, runId: 'a', author: 'agent' }, JOB, 'auto');
        expect(r.status).toBe('rejected');
        expect(r.pinned).toEqual(['text']);
      });
    });

    describe('subtree locks', () => {
      it('parks an agent op INSIDE the locked subtree but applies one elsewhere on the same page', () => {
        const page = addJsx();
        const card = midOfTag(page.id, 'UI.Card');
        const inside = midOf(page.id, 'inside');
        const outside = midOf(page.id, 'outside');
        executor.setSubtreeEditing(artifact, page.id, card, true, JOB);

        const parked = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: inside, text: 'agent-inside' }, runId: 'a' },
          JOB, 'auto',
        );
        expect(parked.status).toBe('staged');
        expect(textOf(page.id, inside)).toBe('inside');

        const applied = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: outside, text: 'agent-outside' }, runId: 'a' },
          JOB, 'auto',
        );
        expect(applied.status).toBe('applied');
        expect(textOf(page.id, outside)).toBe('agent-outside');
      });

      it('parks an op on an ANCESTOR of the locked subtree — it could delete the live edit', () => {
        const page = addJsx();
        const card = midOfTag(page.id, 'UI.Card');
        const screen = midOfTag(page.id, 'UI.Screen');
        executor.setSubtreeEditing(artifact, page.id, card, true, JOB);
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setStyle', pageId: page.id, mid: screen, style: { gap: '4px' } }, runId: 'a' },
          JOB, 'auto',
        );
        expect(r.status).toBe('staged');
      });

      it('flushes parked ops when the last lock on the page lifts', () => {
        const page = addJsx();
        const card = midOfTag(page.id, 'UI.Card');
        const inside = midOf(page.id, 'inside');
        executor.setSubtreeEditing(artifact, page.id, card, true, JOB);
        const parked = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: inside, text: 'later' }, runId: 'a' },
          JOB, 'auto',
        );
        expect(parked.status).toBe('staged');

        // A second lock elsewhere on the page must NOT let the flush happen early.
        executor.setSubtreeEditing(artifact, page.id, midOf(page.id, 'outside'), true, JOB);
        executor.setSubtreeEditing(artifact, page.id, card, false, JOB);
        expect(textOf(page.id, inside)).toBe('inside');

        executor.setSubtreeEditing(artifact, page.id, midOf(page.id, 'outside'), false, JOB);
        expect(textOf(page.id, inside)).toBe('later');
        expect(executor.isPageLocked(page.id)).toBe(false);
      });

      it('setPageEditing still locks the whole artboard', () => {
        const page = addJsx();
        executor.setPageEditing(artifact, page.id, true, JOB);
        expect(executor.lockedSubtrees(page.id)).toEqual(['*']);
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'outside'), text: 'x' }, runId: 'a' },
          JOB, 'auto',
        );
        expect(r.status).toBe('staged');
      });

      it('a lock on one page never parks an op on another', () => {
        const locked = addJsx();
        const free = addJsx(TWO_BRANCHES, 'Other');
        executor.setPageEditing(artifact, locked.id, true, JOB);
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: free.id, mid: midOf(free.id, 'outside'), text: 'ok' }, runId: 'a' },
          JOB, 'auto',
        );
        expect(r.status).toBe('applied');
      });
    });

    describe('receipts carry since[]', () => {
      it('reports the ops committed after the writer’s baseVersion, so a chain needs ONE read', () => {
        const page = addJsx();
        const v = page.version;
        const first = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'inside'), text: 'one' }, runId: 'a', baseVersion: v },
          JOB, 'auto',
        );
        expect(first.since).toBeUndefined();       // nothing missed yet

        const second = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'outside'), text: 'two' }, runId: 'a', baseVersion: v },
          JOB, 'auto',
        );
        expect(second.since!.map(r => r.opId)).toEqual([first.opId]);
        expect(second.since![0].op).toMatchObject({ op: 'el.setText', text: 'one' });
      });

      it('never leaks executor bookkeeping into a record handed to a writer', () => {
        const page = addJsx();
        const v = page.version;
        executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'inside'), text: 'one' }, runId: 'a', baseVersion: v }, JOB, 'auto');
        const r = executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'outside'), text: 'two' }, runId: 'a', baseVersion: v }, JOB, 'auto');
        const record = r.since![0] as Record<string, unknown>;
        expect(record.committedArtifactVersion).toBeUndefined();
        expect(record.committedPageVersion).toBeUndefined();
        expect(record.restore).toBeUndefined();
      });

      it('scopes since[] to the page a page-op targets', () => {
        const a = addJsx();
        const b = addJsx(TWO_BRANCHES, 'Other');
        const v = b.version;
        executor.submitOp(artifact, { op: { op: 'el.setText', pageId: a.id, mid: midOf(a.id, 'inside'), text: 'elsewhere' }, runId: 'x' }, JOB, 'auto');
        const r = executor.submitOp(
          artifact,
          { op: { op: 'el.setText', pageId: b.id, mid: midOf(b.id, 'inside'), text: 'here' }, runId: 'y', baseVersion: v },
          JOB, 'auto',
        );
        expect(r.since).toBeUndefined();
      });

      it('omits since[] entirely when the writer supplied no baseVersion', () => {
        const page = addJsx();
        executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'inside'), text: '1' }, runId: 'a' }, JOB, 'auto');
        const r = executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'outside'), text: '2' }, runId: 'a' }, JOB, 'auto');
        expect(r.since).toBeUndefined();
      });
    });

    describe('staged mode + acceptance', () => {
      it('a staged op does not touch the document until it is accepted', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        const r = executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid, text: 'proposed' }, runId: 'a' }, JOB);
        expect(r.status).toBe('staged');
        expect(textOf(page.id, mid)).toBe('outside');

        const accepted = executor.applyStagedOp(artifact, r.opId, JOB)!;
        expect(accepted.status).toBe('applied');
        expect(textOf(page.id, mid)).toBe('proposed');
      });

      it('accepting a staged op whose target vanished reports stale rather than applying', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        const r = executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid, text: 'proposed' }, runId: 'a', baseVersion: page.version }, JOB);
        executor.submitOp(artifact, { op: { op: 'el.remove', pageId: page.id, mid }, runId: 'human', author: 'user' }, JOB, 'auto');
        const accepted = executor.applyStagedOp(artifact, r.opId, JOB)!;
        expect(accepted.status).toBe('stale');
      });
    });

    describe('theme tokens', () => {
      it('sets and inverts one token', () => {
        const before = artifact.theme.colors.primary;
        const r = executor.submitOp(artifact, { op: { op: 'theme.setToken', path: 'colors.primary', value: '#abcdef' }, runId: 'r' }, JOB, 'auto');
        expect(artifact.theme.colors.primary).toBe('#abcdef');
        const inverse = executor.journal(artifact.id).find(e => e.opId === r.opId)!.inverse!;
        executor.submitOp(artifact, { op: inverse, runId: 'undo' }, JOB, 'auto');
        expect(artifact.theme.colors.primary).toBe(before);
      });

      it('refuses a token path that would reach the prototype chain', () => {
        for (const path of ['__proto__.polluted', 'colors.constructor', 'colors.__proto__.x', '', 'a..b']) {
          const r = executor.submitOp(artifact, { op: { op: 'theme.setToken', path, value: 'x' }, runId: 'r' }, JOB, 'auto');
          expect(r.status, path).toBe('rejected');
        }
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      });
    });

    describe('legacy edit_element rides the same document path', () => {
      it('edits by mid, records an inverse, and stores no page snapshot', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        const op = executor.submit(
          artifact,
          { kind: 'edit_element', runId: 'r', targetPageId: page.id, proposedValue: { mid, text: 'via legacy' } },
          JOB, 'auto',
        )!;
        expect(op.status).toBe('applied');
        expect(textOf(page.id, mid)).toBe('via legacy');
        expect(op.previousValue).toBeUndefined();
        expect(op.inverse).toEqual({ op: 'el.setText', pageId: page.id, mid, text: 'outside' });

        executor.undoLastApplied(artifact, JOB);
        expect(textOf(page.id, mid)).toBe('outside');
      });

      it('rejects the deleted DOM-index-path payload', () => {
        const page = addJsx();
        const op = executor.submit(
          artifact,
          { kind: 'edit_element', runId: 'r', targetPageId: page.id, proposedValue: { path: '0/1', override: { innerHtml: 'x' } } },
          JOB, 'auto',
        );
        expect(op).toBeNull();
        expect(executor.lastSubmitError()).toContain('mid');
      });

      it('enforces pins on the legacy surface too', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid, text: 'mine' }, runId: 'h', author: 'user' }, JOB, 'auto');
        const op = executor.submit(
          artifact,
          { kind: 'edit_element', runId: 'r', author: 'agent', targetPageId: page.id, proposedValue: { mid, text: 'agent' } },
          JOB, 'auto',
        );
        expect(op).toBeNull();
        expect(executor.lastReceipt()!.pinned).toEqual(['text']);
        expect(textOf(page.id, mid)).toBe('mine');
      });

      it('rebases a stale legacy element op whose mid survived', () => {
        const page = addJsx();
        const mid = midOf(page.id, 'outside');
        const v = page.version;
        executor.submitOp(artifact, { op: { op: 'el.setText', pageId: page.id, mid: midOf(page.id, 'inside'), text: 'moved' }, runId: 'o' }, JOB, 'auto');
        const op = executor.submit(
          artifact,
          { kind: 'edit_element', runId: 'r', targetPageId: page.id, baseVersion: v, proposedValue: { mid, text: 'late' } },
          JOB, 'auto',
        )!;
        expect(op.status).toBe('applied');
        expect(executor.lastReceipt()!.rebased).toBe(true);
        expect(textOf(page.id, mid)).toBe('late');
      });
    });
  });
});
