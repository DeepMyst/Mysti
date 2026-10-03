/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — the staged-suggestion transport, both ends.
 *
 * Two defects this file exists to keep dead, both of which survived a fully
 * green suite because nothing ever asserted the *removal* half of the contract:
 *
 *  1. **P3 — the shipped default staged into a place no wire message reached.**
 *     `resolveCanvasApproval` returns `'staged'` for the shipped defaults
 *     (`mysti.accessLevel: 'ask-permission'`), and in `staged` mode the legacy
 *     kind-based `submit()` leaves the op `pending` in `artifact.opLog` and
 *     pushes NO journal entry. `CanvasBridge._flushStaged` read the journal
 *     only, so `insert_page` / `edit_page` / `delete_page` / `set_theme` / …
 *     produced no board change, no suggestion card and no error — the agent
 *     appeared to do nothing at all. And if such an id did reach
 *     `canvas/decide`, the accept branch fell through to `rejectOp`: accept
 *     meant reject.
 *  2. **P4 — `canvas/staged` was a set on the host and a merge on the client.**
 *     The host computes the COMPLETE current staged set; the client folded it
 *     in additively and dropped an empty batch on the floor, so a suggestion
 *     retracted host-side left a live Accept/Reject card in the rail forever.
 *     `_baseline` made it worse: it reset `_sentStaged` to `''`, so the empty
 *     set that was supposed to clear the rail hit the "unchanged" early return.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { CanvasBridge, type CanvasBridgeSession } from '../../src/canvas/CanvasBridge';
import { resolveCanvasApproval } from '../../src/canvas/resolveCanvasApproval';
import type { CanvasHostMessage, CanvasHostMessageTag } from '../../src/canvas/protocol';
import type { CanvasOp as CanvasOpV2 } from '../../src/canvas/CanvasOps';
import { LivenessLayer, describeStaged, mountLiveness, readStagedRecord, stagedRows } from '../../src/webview/canvas/liveness';
import type { LivenessOptions } from '../../src/webview/canvas/liveness';
import type { CanvasEnv, DomDocument, DomElement } from '../../src/webview/canvas/dom';
import type { CanvasClientBody } from '../../src/webview/canvas/protocolClient';
import type { ArtifactPage, CanvasArtifact } from '../../src/types';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import { FakeDocument, FakeElement } from '../webview/canvasFakeDom';

const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

/* --------------------------------- host --------------------------------- */

interface HostHarness {
  bridge: CanvasBridge;
  posted: CanvasHostMessage[];
  artifact: CanvasArtifact;
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  page: ArtifactPage;
  sent(tag: CanvasHostMessageTag): CanvasHostMessage[];
  last(tag: CanvasHostMessageTag): any;
}

function seedDoc(): DocNode {
  return {
    mid: 'rootaaaaaa',
    tag: 'UI.Screen',
    children: [{ mid: 'headaaaaaa', tag: 'UI.Heading', text: 'Sign in' }],
  };
}

function host(): HostHarness {
  const posted: CanvasHostMessage[] = [];
  const store = new ArtifactStore({ getRoot: () => null });
  const artifact = store.createArtifact({ name: 'Design' });
  const page = store.insertPage(artifact, store.makePage({ doc: seedDoc(), actionTitle: 'Login' }));

  let bridge!: CanvasBridge;
  const router = new CanvasJobRouter(e => bridge.onJobEvent(e));
  const executor = new CanvasOpExecutor(store, router);
  const history = new CanvasHistory(artifact, executor, { jobId: 'job-1' });
  const session: CanvasBridgeSession = { artifact, store, executor, history, jobRouter: router };

  bridge = new CanvasBridge({
    post: m => posted.push(m),
    session: () => session,
    viewToken: () => TOKEN,
    // The SHIPPED DEFAULT. `mysti.accessLevel` defaults to `ask-permission`,
    // and `resolveCanvasApproval` maps anything but `full-access` to `staged`.
    approvalMode: () => 'staged',
    caps: () => [],
    log: () => { /* quiet */ },
  });

  return {
    bridge, posted, artifact, store, executor, page,
    sent: tag => posted.filter(m => m.t === tag),
    last: tag => [...posted].reverse().find(m => m.t === tag),
  };
}

const ready = () => ({ t: 'canvas/ready', viewToken: TOKEN });
const decide = (opIds: string[], accept: boolean) => ({ t: 'canvas/decide', opIds, accept, viewToken: TOKEN });

/* -------------------------------- client -------------------------------- */

const CLIENT_DOC: DocNode = {
  mid: 'rootaaaaaa',
  tag: 'UI.Screen',
  children: [{ mid: 'headaaaaaa', tag: 'UI.Heading', text: 'Sign in' }],
};

interface ClientHarness {
  layer: LivenessLayer;
  rail: FakeElement;
  sent: CanvasClientBody[];
}

function client(over: Partial<LivenessOptions> = {}): ClientHarness {
  const doc = new FakeDocument();
  const rail = new FakeElement('div');
  const sent: CanvasClientBody[] = [];
  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: { addEventListener: () => undefined },
    createIntersectionObserver: null,
    createMessageChannel: () => ({ port1: null, port2: null } as never),
    fetchText: async () => '',
    now: () => 0,
    warn: () => undefined,
  };
  const layer = mountLiveness({
    env,
    hosts: {
      world: new FakeElement('div') as unknown as DomElement,
      overlay: new FakeElement('div') as unknown as DomElement,
      rail: rail as unknown as DomElement,
    },
    send: body => sent.push(body),
    pages: () => [{ id: 'p1', doc: CLIENT_DOC }],
    ...over,
  });
  return { layer, rail, sent };
}

/** A V2 journal record as `_flushStaged` ships it. */
const v2Record = (opId: string, text: string) => ({
  opId, txnId: opId, runId: 'r', author: 'agent', actorId: 'agent', status: 'staged', ts: 0,
  op: { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text } as CanvasOpV2,
});

const rows = (rail: FakeElement) => rail.findAll(e => e.className === 'staged-row');

/* ========================================================================= */

describe('resolveCanvasApproval — the shipped default is `staged` (P3 premise)', () => {
  it('returns `staged` for the shipped defaults, so this is the DEFAULT path', () => {
    // package.json: `mysti.accessLevel` default is `ask-permission`, and
    // ChatViewProvider reads `config.get('accessLevel', 'ask-permission')`.
    expect(resolveCanvasApproval({ accessLevel: 'ask-permission', mode: 'default' })).toBe('staged');
    expect(resolveCanvasApproval({ accessLevel: 'ask-permission', mode: 'ask-before-edit' })).toBe('staged');
  });
});

describe('P3 — a legacy-kind staged op must reach the wire and be decidable', () => {
  let h: HostHarness;
  beforeEach(() => { h = host(); });

  /** Exactly what `scaffold_page` / an agent `add_page` does under the default. */
  function stageInsertPage(): string {
    const op = h.executor.submit(
      h.artifact,
      { kind: 'insert_page', runId: 'run-1', author: 'agent', proposedValue: { mode: 'jsx', jsxSource: 'function Page(){ return null; }' } },
      'job-scaffold',
      'staged',
    );
    expect(op).not.toBeNull();
    return op!.opId;
  }

  it('the op really does live only in artifact.opLog, never in the V2 journal', () => {
    const opId = stageInsertPage();
    expect(h.executor.journal(h.artifact.id)).toHaveLength(0);
    expect(h.artifact.opLog.find(o => o.opId === opId)?.status).toBe('pending');
  });

  it('ships the pending opLog entry on canvas/staged', async () => {
    await h.bridge.handle(ready());
    const opId = stageInsertPage();

    const staged = h.last('canvas/staged');
    expect(staged, 'no canvas/staged was ever posted for a legacy staged op').toBeTruthy();
    expect(staged.records.map((r: any) => r.opId)).toContain(opId);
  });

  it('includes it in the authoritative snapshot sent by hello()', async () => {
    const opId = stageInsertPage();
    await h.bridge.handle(ready());
    expect(h.last('canvas/staged').records.map((r: any) => r.opId)).toContain(opId);
  });

  it('the shipped record is READABLE by the client, so a card can render', async () => {
    await h.bridge.handle(ready());
    const opId = stageInsertPage();
    const record = h.last('canvas/staged').records.find((r: any) => r.opId === opId);

    const entry = readStagedRecord(record);
    expect(entry, 'readStagedRecord refused the legacy record').not.toBeNull();
    expect(entry!.opId).toBe(opId);
    expect(stagedRows([entry!], [])[0].title).toMatch(/artboard/i);
  });

  it('ACCEPT applies it — it must not fall through to rejectOp', async () => {
    await h.bridge.handle(ready());
    const opId = stageInsertPage();
    const pagesBefore = h.artifact.pages.length;

    await h.bridge.handle(decide([opId], true));

    expect(h.artifact.opLog.find(o => o.opId === opId)?.status).toBe('applied');
    expect(h.artifact.pages.length).toBe(pagesBefore + 1);
  });

  it('REJECT still rejects it', async () => {
    await h.bridge.handle(ready());
    const opId = stageInsertPage();
    const pagesBefore = h.artifact.pages.length;

    await h.bridge.handle(decide([opId], false));

    expect(h.artifact.opLog.find(o => o.opId === opId)?.status).toBe('rejected');
    expect(h.artifact.pages.length).toBe(pagesBefore);
  });

  it('an accepted legacy op leaves the staged snapshot', async () => {
    await h.bridge.handle(ready());
    const opId = stageInsertPage();
    await h.bridge.handle(decide([opId], true));
    expect(h.last('canvas/staged').records.map((r: any) => r.opId)).not.toContain(opId);
  });

  it('a legacy edit_element stages, ships and applies through the same path', async () => {
    await h.bridge.handle(ready());
    const op = h.executor.submit(
      h.artifact,
      {
        kind: 'edit_element', runId: 'run-2', author: 'agent', targetPageId: h.page.id,
        proposedValue: { mid: 'headaaaaaa', text: 'Welcome back' },
      },
      'job-el',
      'staged',
    );
    expect(op).not.toBeNull();
    expect(h.last('canvas/staged').records.map((r: any) => r.opId)).toContain(op!.opId);

    await h.bridge.handle(decide([op!.opId], true));
    expect(h.store.getPage(h.artifact, h.page.id)!.doc.children![0].text).toBe('Welcome back');
  });
});

describe('P3 — the legacy decode is fixed-label and prototype-safe', () => {
  it('refuses a record whose kind is a prototype key rather than a real op kind', () => {
    expect(readStagedRecord({ opId: 'o1', kind: '__proto__', proposedValue: {} })).toBeNull();
    expect(readStagedRecord({ opId: 'o1', kind: 'constructor', proposedValue: {} })).toBeNull();
    expect(readStagedRecord({ opId: 'o1', kind: 'not_a_kind', proposedValue: {} })).toBeNull();
  });

  it('never prints a model-chosen string as the row title', () => {
    const entry = readStagedRecord({ opId: 'o1', kind: 'delete_page', targetPageId: 'p1', proposedValue: {} });
    expect(entry).not.toBeNull();
    expect(describeStaged(entry!)).toBe('Remove artboard');
    // Hand-made entries (not produced by readStagedRecord) still yield a string.
    expect(describeStaged({ opId: 'x', op: null, kind: '__proto__', pageId: null, mid: null })).toBe('Canvas edit');
  });

  it('a legacy row renders a title and Accept/Reject, honestly without previews', () => {
    const c = client();
    c.layer.onStaged([{ opId: 'o1', kind: 'insert_page', status: 'pending', proposedValue: { mode: 'jsx' } }]);
    expect(c.layer.stagedCount).toBe(1);
    expect(c.rail.find(e => e.className === 'sr-title')?.textContent).toBe('Add artboard');
    expect(c.rail.findAll(e => e.className === 'sr-accept')).toHaveLength(1);

    c.rail.findAll(e => e.className === 'sr-reject')[0].fire('click');
    expect(c.sent).toEqual([{ t: 'canvas/decide', opIds: ['o1'], accept: false }]);
  });
});

describe('P4 — canvas/staged is a SNAPSHOT, not a delta', () => {
  it('host: hello() posts the authoritative (possibly empty) staged set', async () => {
    const h = host();
    await h.bridge.handle(ready());
    const staged = h.sent('canvas/staged');
    expect(staged.length, 'hello() sent no canvas/staged, so a stale rail can never be cleared').toBe(1);
    expect((staged[0] as any).records).toEqual([]);
  });

  it('host: a resync re-asserts the empty set even after a baseline reset', async () => {
    const h = host();
    await h.bridge.handle(ready());
    h.bridge.resync();
    expect(h.sent('canvas/staged').length).toBe(2);
    expect((h.last('canvas/staged') as any).records).toEqual([]);
  });

  it('client: a shrunken batch REMOVES the rows it no longer names', () => {
    const c = client();
    c.layer.onStaged([v2Record('o1', 'A'), v2Record('o2', 'B')]);
    expect(c.layer.stagedCount).toBe(2);

    c.layer.onStaged([v2Record('o1', 'A')]);

    expect(c.layer.stagedCount).toBe(1);
    expect(rows(c.rail).map(r => r.attrs.get('data-op-id'))).toEqual(['o1']);
  });

  it('client: an EMPTY batch clears the rail', () => {
    const c = client();
    c.layer.onStaged([v2Record('o1', 'A')]);
    expect(c.layer.stagedCount).toBe(1);

    c.layer.onStaged([]);

    expect(c.layer.stagedCount).toBe(0);
    expect(c.rail.hidden).toBe(true);
  });

  it('client: an op_staged JOB event is still incremental (it is a delta, not a set)', () => {
    const c = client();
    c.layer.onStaged([v2Record('o1', 'A')]);
    c.layer.onJob({ jobId: 'j', type: 'op_staged', op: v2Record('o2', 'B') } as never);
    expect(c.layer.stagedCount).toBe(2);
  });

  it('end to end: a suggestion retracted host-side disappears from the rail', async () => {
    const h = host();
    const c = client();
    await h.bridge.handle(ready());

    const a = h.executor.submitOp(
      h.artifact, { op: { op: 'el.setText', pageId: h.page.id, mid: 'headaaaaaa', text: 'A' }, runId: 'r1', author: 'agent' }, 'j1', 'staged',
    );
    const b = h.executor.submitOp(
      h.artifact, { op: { op: 'el.setText', pageId: h.page.id, mid: 'headaaaaaa', text: 'B' }, runId: 'r2', author: 'agent' }, 'j2', 'staged',
    );
    c.layer.onStaged((h.last('canvas/staged') as any).records);
    expect(c.layer.stagedCount).toBe(2);

    // The host resolves one of them WITHOUT the view asking (a lock release
    // flush, an accept from another surface, a supersession).
    h.executor.applyStagedOp(h.artifact, a.opId, 'j3');
    c.layer.onStaged((h.last('canvas/staged') as any).records);

    expect(c.layer.stagedCount).toBe(1);
    expect(rows(c.rail).map(r => r.attrs.get('data-op-id'))).toEqual([b.opId]);
  });
});
