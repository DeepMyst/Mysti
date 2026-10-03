/**
 * The webview half of Plan 22 Phase 5: ghosts, agent cursor, staged rail,
 * frame-error cards.
 *
 * The repo ships no jsdom, so this drives the same structural fake DOM the rest
 * of the canvas webview tests use (`FakeElement.innerHTML` throws on read AND
 * write, which is what keeps the "no `innerHTML` anywhere near model-authored
 * content" rule enforceable rather than aspirational).
 *
 * What is actually asserted is the logic, not pixels: the job reducer, the
 * elapsed formatter, ghost/cursor geometry through the board transform, the
 * op→row model behind the accept/reject rail (including that "after" comes from
 * the SAME `applyOp` the executor runs), and the exact client messages every
 * affordance posts.
 */
import { describe, it, expect } from 'vitest';
import {
  CURSOR_CLASS,
  ERROR_CARD_CLASS,
  GHOST_CLASS,
  GHOST_DEFAULT_SIZE,
  LivenessLayer,
  acceptSpeculative,
  applyJobEvent,
  cancelJobBody,
  clampText,
  decideBody,
  describeOp,
  fixWithAiBody,
  formatElapsed,
  ghostWorldRect,
  mountLiveness,
  previewMidFor,
  readGhost,
  readSpeculative,
  readStagedRecord,
  stagedRows,
  type LiveJob,
  type LivenessOptions,
} from '../../src/webview/canvas/liveness';
import type { CanvasJobEvent } from '../../src/types';
import type { CanvasOp } from '../../src/canvas/CanvasOps';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import type { CanvasEnv, DomDocument, DomElement } from '../../src/webview/canvas/dom';
import type { CanvasClientBody } from '../../src/webview/canvas/protocolClient';
import { FakeDocument, FakeElement } from '../webview/canvasFakeDom';

/* --------------------------------- fixtures --------------------------------- */

const DOC: DocNode = {
  mid: 'rootaaaaaa',
  tag: 'UI.Screen',
  children: [
    { mid: 'headaaaaaa', tag: 'UI.Heading', text: 'Sign in' },
    {
      mid: 'cardaaaaaa',
      tag: 'UI.Card',
      children: [{ mid: 'textaaaaaa', tag: 'UI.Text', text: 'Email' }],
    },
  ],
};

const PAGES = [{ id: 'p1', doc: DOC }];

function started(over: Partial<CanvasJobEvent> & Record<string, unknown> = {}): CanvasJobEvent {
  return { jobId: 'j1', type: 'started', label: 'Designing', ...over } as CanvasJobEvent;
}

interface Harness {
  layer: LivenessLayer;
  doc: FakeDocument;
  world: FakeElement;
  overlay: FakeElement;
  rail: FakeElement;
  sent: CanvasClientBody[];
  applied: unknown[];
}

function makeLayer(over: Partial<LivenessOptions> = {}): Harness {
  const doc = new FakeDocument();
  const world = new FakeElement('div');
  const overlay = new FakeElement('div');
  const rail = new FakeElement('div');
  const sent: CanvasClientBody[] = [];
  const applied: unknown[] = [];
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
      world: world as unknown as DomElement,
      overlay: overlay as unknown as DomElement,
      rail: rail as unknown as DomElement,
    },
    send: body => sent.push(body),
    transform: () => ({ zoom: 1, pan: { x: 0, y: 0 } }),
    pageGeometry: pageId => (pageId === 'p1' ? { boardPos: { x: 100, y: 50 }, size: { w: 400, h: 300 } } : null),
    pages: () => PAGES,
    applySpeculative: p => applied.push(p),
    ...over,
  });
  return { layer, doc, world, overlay, rail, sent, applied };
}

function find(el: FakeElement, className: string): FakeElement | null {
  return el.find(e => e.className === className);
}

function findAll(el: FakeElement, className: string): FakeElement[] {
  return el.findAll(e => e.className === className);
}

/* ------------------------------- pure: jobs ------------------------------- */

describe('readGhost', () => {
  it('reads label, page and placement off a started event', () => {
    const ghost = readGhost(started({ pageId: 'p1', boardPos: { x: 10, y: 20 }, size: { w: 800, h: 600 } }));
    expect(ghost).toEqual({
      jobId: 'j1', label: 'Designing', pageId: 'p1',
      boardPos: { x: 10, y: 20 }, size: { w: 800, h: 600 }, elapsedSeconds: 0,
    });
  });

  it('refuses anything that is not a started event', () => {
    expect(readGhost({ jobId: 'j1', type: 'heartbeat' } as CanvasJobEvent)).toBeNull();
    expect(readGhost({ type: 'started' } as CanvasJobEvent)).toBeNull();
  });

  it('falls back rather than trusting broken geometry from an older host', () => {
    const ghost = readGhost(started({ boardPos: { x: Number.NaN, y: 4 }, size: { w: 0, h: -3 } }));
    expect(ghost?.boardPos).toBeUndefined();
    expect(ghost?.size).toBeUndefined();
    expect(ghostWorldRect(ghost as LiveJob)).toEqual({ x: 0, y: 0, ...GHOST_DEFAULT_SIZE });
  });

  it('labels an unlabelled job rather than drawing an empty box', () => {
    expect(readGhost(started({ label: '' }))?.label).toBe('Working…');
  });
});

describe('applyJobEvent', () => {
  it('adds on started, updates on heartbeat, and REMOVES on any terminal event', () => {
    let jobs = applyJobEvent(new Map(), started({ pageId: 'p1' }));
    expect(jobs.size).toBe(1);

    jobs = applyJobEvent(jobs, { jobId: 'j1', type: 'heartbeat', elapsedSeconds: 12 } as CanvasJobEvent);
    expect(jobs.get('j1')?.elapsedSeconds).toBe(12);

    jobs = applyJobEvent(jobs, { jobId: 'j1', type: 'done', result: { cancelled: true } } as CanvasJobEvent);
    expect(jobs.size).toBe(0);
  });

  it('an error is terminal too — a failed job leaves no ghost behind', () => {
    const jobs = applyJobEvent(applyJobEvent(new Map(), started()), { jobId: 'j1', type: 'error', error: 'x' } as CanvasJobEvent);
    expect(jobs.size).toBe(0);
  });

  it('ignores a heartbeat for a job it never saw start', () => {
    expect(applyJobEvent(new Map(), { jobId: 'ghost', type: 'heartbeat', elapsedSeconds: 4 } as CanvasJobEvent).size).toBe(0);
  });

  it('is pure — the input map is never mutated', () => {
    const before = applyJobEvent(new Map(), started());
    const after = applyJobEvent(before, { jobId: 'j1', type: 'done' } as CanvasJobEvent);
    expect(before.size).toBe(1);
    expect(after.size).toBe(0);
  });

  it('clamps a progress fraction and keeps the last good elapsed', () => {
    let jobs = applyJobEvent(new Map(), started());
    jobs = applyJobEvent(jobs, { jobId: 'j1', type: 'heartbeat', elapsedSeconds: 6 } as CanvasJobEvent);
    jobs = applyJobEvent(jobs, { jobId: 'j1', type: 'progress', progress: 9 } as CanvasJobEvent);
    expect(jobs.get('j1')).toMatchObject({ progress: 1, elapsedSeconds: 6 });
    jobs = applyJobEvent(jobs, { jobId: 'j1', type: 'heartbeat', elapsedSeconds: Number.NaN } as CanvasJobEvent);
    expect(jobs.get('j1')?.elapsedSeconds).toBe(6);
  });
});

describe('formatElapsed', () => {
  it('renders m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7)).toBe('0:07');
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(727)).toBe('12:07');
  });

  it('never renders NaN or a negative clock', () => {
    expect(formatElapsed(-5)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
    expect(formatElapsed(undefined)).toBe('0:00');
  });
});

/* ---------------------------- pure: speculative ---------------------------- */

describe('readSpeculative', () => {
  const patch = { pageId: 'p1', seq: 3, sealed: false, ops: [{ op: 'el.setText', pageId: 'p1', mid: 'm', text: 'x' }] };

  it('reads a well-formed patch off a progress event', () => {
    const read = readSpeculative({ jobId: 'j', type: 'progress', spec: patch } as unknown as CanvasJobEvent);
    expect(read).toEqual(patch);
  });

  it('refuses a batch containing anything that is not an op', () => {
    const bad = { ...patch, ops: [...patch.ops, { op: 'shell.exec', cmd: 'rm -rf /' }] };
    expect(readSpeculative({ jobId: 'j', type: 'progress', spec: bad } as unknown as CanvasJobEvent)).toBeNull();
  });

  it('refuses a patch with no page or no sequence', () => {
    expect(readSpeculative({ jobId: 'j', type: 'progress', spec: { ...patch, pageId: '' } } as unknown as CanvasJobEvent)).toBeNull();
    expect(readSpeculative({ jobId: 'j', type: 'progress', spec: { ...patch, seq: 'x' } } as unknown as CanvasJobEvent)).toBeNull();
  });

  it('is not fooled by a heartbeat carrying a spec', () => {
    expect(readSpeculative({ jobId: 'j', type: 'heartbeat', spec: patch } as unknown as CanvasJobEvent)).toBeNull();
  });
});

describe('acceptSpeculative', () => {
  const patch = (seq: number, ops = 1) => ({
    pageId: 'p1', seq, sealed: false,
    ops: Array.from({ length: ops }, () => ({ op: 'el.setText', pageId: 'p1', mid: 'm', text: 'x' }) as CanvasOp),
  });

  it('accepts the first patch and every increase', () => {
    expect(acceptSpeculative(undefined, patch(1))).toBe(true);
    expect(acceptSpeculative(1, patch(2))).toBe(true);
  });

  it('drops duplicates and out-of-order patches', () => {
    expect(acceptSpeculative(4, patch(4))).toBe(false);
    expect(acceptSpeculative(4, patch(2))).toBe(false);
  });

  it('drops an empty batch — a repaint for nothing is still a repaint', () => {
    expect(acceptSpeculative(undefined, patch(9, 0))).toBe(false);
  });
});

/* -------------------------- pure: message bodies -------------------------- */

describe('client message bodies', () => {
  it('cancel routes to the job router by id', () => {
    expect(cancelJobBody('j1')).toEqual({ t: 'canvas/cancelJob', jobId: 'j1' });
  });

  it('a decision is one typed message for N ops', () => {
    expect(decideBody(['a', 'b'], true)).toEqual({ t: 'canvas/decide', opIds: ['a', 'b'], accept: true });
  });

  it('"Fix with AI" travels as a COMMENT — data, not a private channel', () => {
    const body = fixWithAiBody('p1', 'x is not a function', 'cardaaaaaa') as {
      t: string; pageId: string; mid?: string; text: string;
    };
    expect(body.t).toBe('canvas/comment');
    expect(body.pageId).toBe('p1');
    expect(body.mid).toBe('cardaaaaaa');
    expect(body.text).toContain('x is not a function');
  });

  it('clamps a hostile error message instead of forwarding a megabyte', () => {
    const body = fixWithAiBody('p1', 'y'.repeat(50_000)) as { text: string };
    expect(body.text.length).toBeLessThan(600);
    expect(clampText('a\n\n   b', 99)).toBe('a b');
  });
});

/* ----------------------------- pure: staged rail ----------------------------- */

describe('readStagedRecord', () => {
  const op: CanvasOp = { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: 'Welcome' };

  it('reads the V2 journal record', () => {
    expect(readStagedRecord({ opId: 'o1', op })).toEqual({ opId: 'o1', op, pageId: 'p1', mid: 'headaaaaaa' });
  });

  it('reads the legacy record the executor still emits (`proposedValue`)', () => {
    expect(readStagedRecord({ opId: 'o1', kind: 'edit_page', proposedValue: op }))
      .toEqual({ opId: 'o1', op, pageId: 'p1', mid: 'headaaaaaa' });
  });

  it('refuses records with no id or no recognizable op', () => {
    expect(readStagedRecord({ op })).toBeNull();
    expect(readStagedRecord({ opId: 'o1', op: { op: 'shell.exec' } })).toBeNull();
    expect(readStagedRecord(null)).toBeNull();
    expect(readStagedRecord('op')).toBeNull();
  });
});

describe('describeOp', () => {
  it('names every scope in words a human recognizes', () => {
    expect(describeOp({ op: 'el.setText', pageId: 'p1', mid: 'm', text: 'Get started' })).toBe('Text → "Get started"');
    expect(describeOp({ op: 'el.setStyle', pageId: 'p1', mid: 'm', style: { color: 'red', gap: '4px' } }))
      .toBe('Style: color, gap');
    expect(describeOp({ op: 'el.insert', pageId: 'p1', parentMid: 'm', before: 'end', node: { tag: 'UI.Card' } }))
      .toBe('Insert <UI.Card>');
    expect(describeOp({ op: 'page.reorder', orderedIds: [] })).toBe('Reorder artboards');
    expect(describeOp({ op: 'theme.setToken', path: 'color.text', value: '#fff' }))
      .toBe('Theme token color.text → #fff');
  });

  it('clamps a hostile label instead of rendering a paragraph into the rail', () => {
    const title = describeOp({ op: 'el.setText', pageId: 'p1', mid: 'm', text: 'z'.repeat(500) });
    expect(title.length).toBeLessThan(60);
  });
});

describe('previewMidFor', () => {
  it('previews the PARENT for a removal or a move — the target disappears', () => {
    expect(previewMidFor({ op: 'el.remove', pageId: 'p1', mid: 'cardaaaaaa' }, DOC)).toBe('rootaaaaaa');
    expect(previewMidFor({ op: 'el.move', pageId: 'p1', mid: 'textaaaaaa', newParentMid: 'rootaaaaaa', before: 'end' }, DOC))
      .toBe('cardaaaaaa');
  });

  it('previews the parent for an insert, the node itself for a cell edit', () => {
    expect(previewMidFor({ op: 'el.insert', pageId: 'p1', parentMid: 'cardaaaaaa', before: 'end', node: { tag: 'div' } }, DOC))
      .toBe('cardaaaaaa');
    expect(previewMidFor({ op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: 'x' }, DOC)).toBe('headaaaaaa');
  });

  it('has nothing to preview for an artifact-scope op', () => {
    expect(previewMidFor({ op: 'theme.setToken', path: 'a', value: 'b' }, DOC)).toBeNull();
  });
});

describe('stagedRows', () => {
  it('renders before/after from the SAME applyOp the executor runs', () => {
    const rows = stagedRows(
      [{ opId: 'o1', op: { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: 'Welcome back' }, pageId: 'p1', mid: 'headaaaaaa' }],
      PAGES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].before?.text).toBe('Sign in');
    expect(rows[0].after?.text).toBe('Welcome back');
    expect(rows[0].error).toBeUndefined();
  });

  it('shows a removal as a parent-level before/after', () => {
    const rows = stagedRows(
      [{ opId: 'o1', op: { op: 'el.remove', pageId: 'p1', mid: 'cardaaaaaa' }, pageId: 'p1', mid: 'cardaaaaaa' }],
      PAGES,
    );
    expect(rows[0].before?.children.length).toBe(2);
    expect(rows[0].after?.children.length).toBe(1);
  });

  it('never mutates the page it previews', () => {
    const snapshot = JSON.stringify(DOC);
    stagedRows(
      [{ opId: 'o1', op: { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: 'changed' }, pageId: 'p1', mid: 'headaaaaaa' }],
      PAGES,
    );
    expect(JSON.stringify(DOC)).toBe(snapshot);
  });

  it('keeps the row (so it can still be rejected) when the op cannot apply', () => {
    const rows = stagedRows(
      [{ opId: 'o1', op: { op: 'el.setText', pageId: 'p1', mid: 'gonegonego', text: 'x' }, pageId: 'p1', mid: 'gonegonego' }],
      PAGES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toBeNull();
    expect(rows[0].error).toBeTruthy();
  });

  it('titles an artifact-scope op with no preview at all', () => {
    const rows = stagedRows([{ opId: 'o1', op: { op: 'theme.setToken', path: 'color.bg', value: '#111' }, pageId: null, mid: null }], PAGES);
    expect(rows[0].title).toContain('Theme token');
    expect(rows[0].before).toBeNull();
    expect(rows[0].after).toBeNull();
  });

  it('renders nothing for a page the client does not have', () => {
    const rows = stagedRows([{ opId: 'o1', op: { op: 'el.setText', pageId: 'zz', mid: 'm', text: 'x' }, pageId: 'zz', mid: 'm' }], PAGES);
    expect(rows[0].before).toBeNull();
  });
});

/* ------------------------------- the layer ------------------------------- */

describe('LivenessLayer — ghost artboards', () => {
  it('draws a ghost in WORLD space at the target position, with a working Cancel', () => {
    const h = makeLayer();
    h.layer.onJob(started({ boardPos: { x: 120, y: -40 }, size: { w: 800, h: 600 } }));

    const ghost = find(h.world, GHOST_CLASS);
    expect(ghost).not.toBeNull();
    expect(ghost?.style.get('left')).toBe('120px');
    expect(ghost?.style.get('top')).toBe('-40px');
    expect(ghost?.style.get('width')).toBe('800px');
    expect(find(h.world, 'ghost-shimmer')).not.toBeNull();

    find(h.world, 'ghost-cancel')?.fire('click');
    expect(h.sent).toEqual([{ t: 'canvas/cancelJob', jobId: 'j1' }]);
  });

  it('parks a ghost at the artboard it names, when there is one', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    expect(find(h.world, GHOST_CLASS)?.style.get('left')).toBe('100px');
  });

  it('ticks the elapsed timer off heartbeats', () => {
    const h = makeLayer();
    h.layer.onJob(started());
    h.layer.onJob({ jobId: 'j1', type: 'heartbeat', elapsedSeconds: 65 } as CanvasJobEvent);
    expect(find(h.world, 'ghost-elapsed')?.textContent).toBe('1:05');
  });

  it('removes the ghost on the terminal event — no leaked spinner', () => {
    const h = makeLayer();
    h.layer.onJob(started());
    expect(h.layer.ghostCount).toBe(1);
    h.layer.onJob({ jobId: 'j1', type: 'done', result: { cancelled: true } } as CanvasJobEvent);
    expect(h.layer.ghostCount).toBe(0);
    expect(find(h.world, GHOST_CLASS)).toBeNull();
  });

  it('keeps two concurrent ghosts apart instead of stacking them', () => {
    const h = makeLayer();
    h.layer.onJob(started({ jobId: 'a' }));
    h.layer.onJob(started({ jobId: 'b' }));
    const lefts = findAll(h.world, GHOST_CLASS).map(g => g.style.get('left'));
    expect(new Set(lefts).size).toBe(2);
  });
});

describe('LivenessLayer — speculative patches', () => {
  const spec = (seq: number, sealed = false) => ({
    jobId: 'j1', type: 'progress',
    spec: { pageId: 'p1', seq, sealed, ops: [{ op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: `v${seq}` }] },
  } as unknown as CanvasJobEvent);

  it('forwards accepted patches once, in order, and marks the artboard "writing"', () => {
    const h = makeLayer();
    h.layer.onJob(spec(1));
    h.layer.onJob(spec(2));
    h.layer.onJob(spec(2));                     // duplicate
    h.layer.onJob(spec(1));                     // out of order

    expect(h.applied).toHaveLength(2);
    expect(h.layer.writingPages()).toEqual(['p1']);
    expect(h.world.attrs.get('data-writing')).toBe('p1');
  });

  it('lifts the writing treatment when the structure seals', () => {
    const h = makeLayer();
    h.layer.onJob(spec(1));
    h.layer.onJob(spec(2, true));
    expect(h.layer.writingPages()).toEqual([]);
    expect(h.world.attrs.has('data-writing')).toBe(false);
  });

  it('never routes a speculative patch anywhere but the render sink', () => {
    const h = makeLayer();
    h.layer.onJob(spec(1));
    // No client traffic: a speculative patch is not a submission and must
    // never reach `canvas/submit`.
    expect(h.sent).toEqual([]);
  });
});

describe('LivenessLayer — agent cursor', () => {
  it('draws the element rect when a live frame reported one', () => {
    const h = makeLayer({ rectsFor: () => new Map([['headaaaaaa', { x: 10, y: 20, w: 50, h: 12 }]]) });
    h.layer.onAgentCursor({ pageId: 'p1', mid: 'headaaaaaa', label: 'Mysti is editing' });

    const cursor = find(h.overlay, CURSOR_CLASS);
    expect(cursor).not.toBeNull();
    expect(cursor?.style.get('left')).toBe('110px');   // boardPos.x + rect.x at zoom 1
    expect(cursor?.style.get('top')).toBe('70px');
    expect(find(h.overlay, 'agent-cursor-label')?.textContent).toBe('Mysti is editing');
  });

  it('falls back to the whole artboard when the tile is a static preview', () => {
    const h = makeLayer();
    h.layer.onAgentCursor({ pageId: 'p1', mid: 'headaaaaaa', label: 'Mysti' });
    const cursor = find(h.overlay, CURSOR_CLASS);
    expect(cursor?.style.get('width')).toBe('400px');
  });

  it('follows the board transform', () => {
    let zoom = 1;
    const h = makeLayer({ transform: () => ({ zoom, pan: { x: 5, y: 5 } }) });
    h.layer.onAgentCursor({ pageId: 'p1', label: 'Mysti' });
    expect(find(h.overlay, CURSOR_CLASS)?.style.get('left')).toBe('105px');
    zoom = 2;
    h.layer.setTransform();
    expect(find(h.overlay, CURSOR_CLASS)?.style.get('left')).toBe('205px');
  });

  it('an empty label retracts it', () => {
    const h = makeLayer();
    h.layer.onAgentCursor({ pageId: 'p1', label: 'Mysti' });
    h.layer.onAgentCursor({ pageId: 'p1', label: '' });
    expect(find(h.overlay, CURSOR_CLASS)).toBeNull();
  });

  it('hides rather than mis-places a cursor on an unknown page', () => {
    const h = makeLayer();
    h.layer.onAgentCursor({ pageId: 'nope', label: 'Mysti' });
    expect(find(h.overlay, CURSOR_CLASS)?.hidden).toBe(true);
  });
});

describe('LivenessLayer — staged suggestions rail', () => {
  const record = (opId: string, text: string) => ({
    opId, kind: 'edit_page', status: 'pending', author: 'agent',
    proposedValue: { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text },
  });

  it('renders one row per suggestion with before/after previews', () => {
    const h = makeLayer();
    h.layer.onStaged([record('o1', 'Welcome'), record('o2', 'Hello')]);

    expect(h.layer.stagedCount).toBe(2);
    expect(findAll(h.rail, 'staged-row')).toHaveLength(2);
    expect(find(h.rail, 'staged-toggle')?.textContent).toBe('2 suggestions');
    expect(find(h.rail, 'staged-count')?.textContent).toBe('2');
    const before = find(h.rail, 'sr-before');
    expect(before?.allText()).toContain('Sign in');
    expect(find(h.rail, 'sr-after')?.allText()).toContain('Welcome');
  });

  it('accepts one op as a typed canvas/decide and drops that row', () => {
    const h = makeLayer();
    h.layer.onStaged([record('o1', 'Welcome'), record('o2', 'Hello')]);

    findAll(h.rail, 'sr-accept')[0].fire('click');

    expect(h.sent).toEqual([{ t: 'canvas/decide', opIds: ['o1'], accept: true }]);
    expect(h.layer.stagedCount).toBe(1);
  });

  it('rejects in bulk', () => {
    const h = makeLayer();
    h.layer.onStaged([record('o1', 'a'), record('o2', 'b')]);

    find(h.rail, 'staged-reject-all')?.fire('click');

    expect(h.sent).toEqual([{ t: 'canvas/decide', opIds: ['o1', 'o2'], accept: false }]);
    expect(h.layer.stagedCount).toBe(0);
    expect(h.rail.hidden).toBe(true);
  });

  it('takes an op_staged job event as one more suggestion', () => {
    const h = makeLayer();
    h.layer.onJob({ jobId: 'j1', type: 'op_staged', op: record('o9', 'From a job') } as unknown as CanvasJobEvent);
    expect(h.layer.stagedCount).toBe(1);
    expect(find(h.rail, 'sr-title')?.textContent).toContain('From a job');
  });

  it('re-staging the same opId updates the row instead of duplicating it', () => {
    const h = makeLayer();
    h.layer.onStaged([record('o1', 'first')]);
    h.layer.onStaged([record('o1', 'second')]);
    expect(h.layer.stagedCount).toBe(1);
    expect(find(h.rail, 'sr-title')?.textContent).toContain('second');
  });

  it('drops unreadable records rather than rendering a broken row', () => {
    const h = makeLayer();
    h.layer.onStaged([{ opId: 'o1' }, null, { proposedValue: { op: 'el.setText' } }]);
    expect(h.layer.stagedCount).toBe(0);
  });
});

describe('LivenessLayer — frame error cards', () => {
  it('draws a card with the message as TEXT, never as markup', () => {
    const h = makeLayer();
    h.layer.onFrameError('p1', '<img src=x onerror=alert(1)> is not a function', 'cardaaaaaa');

    const card = find(h.overlay, ERROR_CARD_CLASS);
    expect(card).not.toBeNull();
    expect(find(h.overlay, 'fec-message')?.textContent).toContain('<img src=x onerror=alert(1)>');
    // FakeElement.innerHTML throws on access, so reaching this line at all
    // proves the renderer never touched it.
    expect(card?.attrs.get('data-page-id')).toBe('p1');
  });

  it('"Fix with AI" routes the message back into the run and closes the card', () => {
    const h = makeLayer();
    h.layer.onFrameError('p1', 'x is not a function', 'cardaaaaaa');

    find(h.overlay, 'fec-fix')?.fire('click');

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ t: 'canvas/comment', pageId: 'p1', mid: 'cardaaaaaa' });
    expect((h.sent[0] as { text: string }).text).toContain('x is not a function');
    expect(h.layer.errorCount).toBe(0);
  });

  it('collapses a render loop into ONE card per element', () => {
    const h = makeLayer();
    for (let i = 0; i < 50; i++) { h.layer.onFrameError('p1', 'boom', 'cardaaaaaa'); }
    expect(h.layer.errorCount).toBe(1);
    expect(findAll(h.overlay, ERROR_CARD_CLASS)).toHaveLength(1);
  });

  it('dismiss removes the card without saying anything to the run', () => {
    const h = makeLayer();
    h.layer.onFrameError('p1', 'boom');
    find(h.overlay, 'fec-dismiss')?.fire('click');
    expect(h.layer.errorCount).toBe(0);
    expect(h.sent).toEqual([]);
  });
});

describe('LivenessLayer — lifecycle', () => {
  it('dispose clears every surface and stops responding', () => {
    const h = makeLayer();
    h.layer.onJob(started());
    h.layer.onAgentCursor({ pageId: 'p1', label: 'Mysti' });
    h.layer.onFrameError('p1', 'boom');
    h.layer.onStaged([{ opId: 'o1', op: { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: 'x' } }]);

    h.layer.dispose();

    expect(h.layer.ghostCount).toBe(0);
    expect(h.layer.errorCount).toBe(0);
    expect(h.layer.stagedCount).toBe(0);
    expect(h.world.children).toHaveLength(0);
    expect(h.overlay.children).toHaveLength(0);

    h.layer.onJob(started({ jobId: 'j2' }));
    expect(h.layer.ghostCount).toBe(0);
  });

  it('works with no hosts at all (a shell that has not rendered yet)', () => {
    const h = makeLayer({ hosts: { world: null, overlay: null, rail: null } });
    expect(() => {
      h.layer.onJob(started());
      h.layer.onAgentCursor({ pageId: 'p1', label: 'x' });
      h.layer.onFrameError('p1', 'boom');
      h.layer.onStaged([{ opId: 'o1', op: { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: 'x' } }]);
      h.layer.refresh();
    }).not.toThrow();
  });
});
