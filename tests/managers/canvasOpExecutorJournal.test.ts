/**
 * Plan 22 — the executor journal must record what actually happened
 * (OPLOG-3), undo must restore what a `NewPageSpec` cannot express (OPLOG-4),
 * and a pin must not outlive the op that set it (OPLOG-5).
 *
 * The journal is not an internal log: `CanvasBridge.pushOps` ships it verbatim
 * as the `canvas/ops` delta and `since[]` hands it to the next agent write. A
 * record that describes an edit that did not happen desynchronises the board
 * silently — the version arithmetic still lines up, so nothing asks to resync.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { CanvasStore as ClientStore } from '../../src/webview/canvas/state';
import { toWireArtifact } from '../../src/canvas/protocol';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { findNode } from '../../src/canvas/doc/DocNode';
import type { ApplyOutcome } from '../../src/webview/canvas/state';
import type { ArtifactPage, CanvasArtifact, CanvasAssetRecord } from '../../src/types';

const JOB = 'job-1';
const JSX_ONE = 'function Page(){ return <UI.Screen><UI.Heading>One</UI.Heading></UI.Screen>; }';
const JSX_TWO = 'function Page(){ return <UI.Screen><UI.Heading>Two</UI.Heading></UI.Screen>; }';
/** Outside the doc subset: parks as an uncompilable `legacy` page. */
const JSX_BAD = 'function Page(){ const s = `a ``` b`; return <UI.Screen>{s}</UI.Screen>; }';

/** True when the client was told it cannot reconstruct the host state alone. */
function needsResync(outcome: ApplyOutcome): boolean {
  return outcome.ok === false ? outcome.reason === 'gap' : outcome.plan.resync;
}

describe('CanvasOpExecutor journal + restore + pins', () => {
  let store: ArtifactStore;
  let executor: CanvasOpExecutor;
  let history: CanvasHistory;
  let artifact: CanvasArtifact;
  let page: ArtifactPage;

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
    artifact = store.createArtifact({ name: 'Journal', kind: 'screens' });
    page = store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: JSX_ONE, actionTitle: 'First' }));
    history = new CanvasHistory(artifact, executor, { jobId: JOB });
  });

  /** A client cache loaded with the host artifact exactly as `canvas/hello` ships it. */
  function client(): ClientStore {
    const c = new ClientStore();
    c.load(JSON.parse(JSON.stringify(toWireArtifact(artifact, { approvalMode: 'auto' }))));
    return c;
  }

  function lastOp(): Record<string, unknown> {
    return executor.journal(artifact.id).at(-1)!.op as unknown as Record<string, unknown>;
  }

  // ======================================================================
  // OPLOG-3 — no fabricated `page.setMeta {}` records
  // ======================================================================

  describe('OPLOG-3 — a legacy op journals the edit it actually made', () => {
    it('a delete_page reaches the client as page.remove, so the artboard goes away', () => {
      const second = store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: JSX_TWO, actionTitle: 'Second' }));
      const c = client();
      executor.submit(artifact, { kind: 'delete_page', runId: 'r1', author: 'agent', targetPageId: second.id, proposedValue: {} }, JOB, 'auto');

      expect(lastOp().op).toBe('page.remove');
      const outcome = c.applyOps(executor.journal(artifact.id), artifact.version);
      expect(outcome.ok).toBe(true);
      expect(c.artifact!.pages.map(p => p.id)).toEqual([page.id]);
    });

    it('an edit_page rewrite reaches the client as the new document', () => {
      const c = client();
      executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r1', author: 'agent', targetPageId: page.id, proposedValue: { mode: 'jsx', jsxSource: JSX_TWO } },
        JOB,
        'auto',
      );

      expect(lastOp().op).toBe('page.setDoc');
      const outcome = c.applyOps(executor.journal(artifact.id), artifact.version);
      expect(outcome.ok).toBe(true);
      expect(c.page(page.id)!.doc.children![0].text).toBe('Two');
    });

    it('a set_theme reaches the client as theme.set', () => {
      const c = client();
      const theme = getThemePreset('midnight')!.theme;
      executor.submit(artifact, { kind: 'set_theme', runId: 'r1', author: 'agent', proposedValue: theme }, JOB, 'auto');

      expect(lastOp().op).toBe('theme.set');
      const outcome = c.applyOps(executor.journal(artifact.id), artifact.version);
      expect(outcome.ok).toBe(true);
      expect(c.artifact!.theme.colors.background).toBe(theme.colors.background);
    });

    it('an insert_page journals a page.add, not a patch of an unrelated page', () => {
      executor.submit(
        artifact,
        { kind: 'insert_page', runId: 'r1', author: 'agent', proposedValue: { mode: 'jsx', jsxSource: JSX_TWO, actionTitle: 'New' } },
        JOB,
        'auto',
      );
      expect(lastOp().op).toBe('page.add');
    });

    it('an edit that the algebra cannot express makes the client ask for the whole thing', () => {
      const legacy = store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: JSX_BAD, actionTitle: 'Legacy' }));
      expect(legacy.legacy).toBeDefined();
      const c = client();

      executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r1', author: 'agent', targetPageId: legacy.id, proposedValue: { mode: 'jsx', jsxSource: JSX_BAD.replace('a ```', 'z ```') } },
        JOB,
        'auto',
      );

      // The uncompilable source is the page's real content; a doc patch would tell
      // the client the artboard changed while its rendered source stayed stale.
      const outcome = c.applyOps(executor.journal(artifact.id), artifact.version);
      expect(needsResync(outcome)).toBe(true);
    });

    it('repairing an uncompilable page into a document makes the client resync', () => {
      const legacy = store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: JSX_BAD, actionTitle: 'Legacy' }));
      const c = client();
      expect(c.page(legacy.id)!.legacy).toBeDefined();

      executor.submit(
        artifact,
        { kind: 'edit_page', runId: 'r1', author: 'agent', targetPageId: legacy.id, proposedValue: { mode: 'jsx', jsxSource: JSX_TWO } },
        JOB,
        'auto',
      );
      expect(store.getPage(artifact, legacy.id)!.legacy).toBeUndefined();

      // A bare doc patch would leave the client's `legacy` source in place —
      // the board would keep rendering the code the host just replaced.
      const outcome = c.applyOps(executor.journal(artifact.id), artifact.version);
      expect(needsResync(outcome)).toBe(true);
    });
  });

  // ======================================================================
  // OPLOG-4 — restore hints must survive the op-log mirror
  // ======================================================================

  describe('OPLOG-4 — undo restores what NewPageSpec cannot carry', () => {
    it('undoing page.remove on a code page brings the source back', () => {
      const legacy = store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: JSX_BAD, actionTitle: 'Legacy' }));
      const index = artifact.pages.findIndex(p => p.id === legacy.id);
      executor.submitOp(artifact, { op: { op: 'page.remove', pageId: legacy.id }, runId: 'r1', author: 'agent', actorId: 'agent' }, JOB, 'auto');
      expect(artifact.pages.find(p => p.id === legacy.id)).toBeUndefined();

      history.undo();

      const back = artifact.pages.find(p => p.id === legacy.id);
      expect(back).toBeDefined();
      expect(back!.legacy).toEqual({ mode: 'jsx', source: JSX_BAD });
      expect(artifact.pages.indexOf(back!)).toBe(index);
    });

    it('keeps the source across undo → redo → undo', () => {
      const legacy = store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: JSX_BAD, actionTitle: 'Legacy' }));
      executor.submitOp(artifact, { op: { op: 'page.remove', pageId: legacy.id }, runId: 'r1', author: 'agent', actorId: 'agent' }, JOB, 'auto');

      history.undo();
      history.redo();
      expect(artifact.pages.find(p => p.id === legacy.id)).toBeUndefined();
      history.undo();

      expect(artifact.pages.find(p => p.id === legacy.id)?.legacy).toEqual({ mode: 'jsx', source: JSX_BAD });
    });

    it('undoing asset.add removes the asset', () => {
      const asset: CanvasAssetRecord = { id: 'as1', role: 'image', ref: 'asset://a/assets/x.png', ts: Date.now() };
      executor.submitOp(artifact, { op: { op: 'asset.add', asset }, runId: 'r1', author: 'agent', actorId: 'agent' }, JOB, 'auto');
      expect(artifact.assets.map(a => a.id)).toEqual(['as1']);

      history.undo();

      expect(artifact.assets.map(a => a.id)).toEqual([]);
    });
  });

  // ======================================================================
  // OPLOG-5 — pin lifetime follows the op that set it
  // ======================================================================

  describe('OPLOG-5 — a pin does not outlive its op', () => {
    const mid = () => store.getPage(artifact, page.id)!.doc.children![0].mid;
    const pins = () => findNode(store.getPage(artifact, page.id)!.doc, mid())!.pins;

    function humanText(text: string, runId: string) {
      return executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: mid(), text }, runId, author: 'user', actorId: 'canvas-view' },
        JOB,
        'auto',
      );
    }

    it('undoing the human edit releases the cell back to the agent', () => {
      humanText('MINE', 'h1');
      expect(pins()!.text).toBeDefined();

      history.undo();

      expect(pins()?.text).toBeUndefined();
      const agent = executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: mid(), text: 'AGENT' }, runId: 'a1', author: 'agent', actorId: 'agent' },
        JOB,
        'auto',
      );
      expect(agent.status).toBe('applied');
      expect(store.getPage(artifact, page.id)!.doc.children![0].text).toBe('AGENT');
    });

    it('leaves an EARLIER human pin on the cell in place', () => {
      const first = humanText('ONE', 'h1');
      const second = humanText('TWO', 'h2');
      expect(pins()!.text.opId).toBe(second.opId);

      history.undo();

      expect(pins()!.text.opId).toBe(first.opId);
    });

    it('re-stamps the pin when the human edit is redone', () => {
      const first = humanText('MINE', 'h1');
      history.undo();
      history.redo();

      expect(pins()!.text).toBeDefined();
      expect(pins()!.text.opId).toBe(first.opId);
      const agent = executor.submitOp(
        artifact,
        { op: { op: 'el.setText', pageId: page.id, mid: mid(), text: 'AGENT' }, runId: 'a1', author: 'agent', actorId: 'agent' },
        JOB,
        'auto',
      );
      expect(agent.status).toBe('rejected');
      expect(agent.pinned).toEqual(['text']);
    });
  });
});
