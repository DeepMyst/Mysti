/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 Phase 5 — "fully synced with the main Mysti agent", asserted.
 *
 * The panel's only ambient agent signal used to be a `<span>` that flashed for
 * 1.8 s and then said nothing, which is indistinguishable from a dead agent.
 * These tests pin the replacement, and deliberately pin the *honesty* of it as
 * much as the presence of it:
 *
 *  - the status is a total function of the job map (there is no input that
 *    renders an empty bar), and it never claims a connection it cannot
 *    substantiate — `binding: null` reads as "not reported", never "connected";
 *  - Cancel stops the jobs that are live AT CLICK TIME, not the ones that
 *    existed when the bar was built;
 *  - a steering comment reports where it went (`queued` vs `with-run`) and
 *    never that it was read, because the host ships no acknowledgement for
 *    `canvas/comment`;
 *  - the review queue is the DEFAULT experience under the shipped settings, so
 *    an empty queue in `staged` mode explains itself instead of hiding.
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_CANCEL_ID,
  AGENT_COMMENT_FALLBACK_ID,
  AGENT_COMMENT_ID,
  AGENT_ELAPSED_ID,
  AGENT_LABEL_ID,
  AGENT_STATUS_ID,
  CHANGE_FLASH_CLASS,
  CHANGE_FLASH_MAX,
  ACTIVITY_STYLE_ID,
  RAIL_ACTIVITY_ATTRS,
  RAIL_HIDE_SWITCH_ID,
  RAIL_LIST_ID,
  RAIL_SHOW_SWITCH_ID,
  REVIEW_QUEUE_ID,
  STATUS_IDLE_TICKS,
  STATUS_LABEL_ATTR,
  STATUS_LIVE_ATTR,
  STATUS_NOTICE_MS,
  activityStyleText,
  agentStatusModel,
  commentBody,
  describeOutbox,
  jobElapsedSeconds,
  mountLiveness,
  offCapabilities,
  statusAnnouncement,
  terminalAnnouncement,
  type ActivitySets,
  type AgentStatusInput,
  type LiveJob,
  type LivenessLayer,
  type LivenessOptions,
  type OutboxEntry,
} from '../../src/webview/canvas/liveness';
import {
  RailController,
  railKeyIntent,
  railNudgeOps,
  railRowLabel,
  railRows,
} from '../../src/webview/canvas/rail';
import { HistoryUi, lastChangeSummary } from '../../src/webview/canvas/historyUi';
import { InspectorPanel } from '../../src/webview/canvas/inspector';
import type { CanvasHistoryStatus, CanvasHistoryTxnView } from '../../src/canvas/CanvasHistory';
import type { CanvasJobEvent } from '../../src/types';
import type { CanvasOp } from '../../src/canvas/CanvasOps';
import type { CapChip } from '../../src/canvas/protocol';
import type { WireArtifact } from '../../src/canvas/protocol';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import type { CanvasEnv, DomDocument, DomElement } from '../../src/webview/canvas/dom';
import type { CanvasClientBody } from '../../src/webview/canvas/protocolClient';
import type { ArtifactPage, CanvasFormatSpec, DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import { FakeChannel, FakeDocument, FakeElement } from './canvasFakeDom';

/* ================================ fixtures ================================ */

const DOC: DocNode = {
  mid: 'rootaaaaaa',
  tag: 'UI.Screen',
  children: [
    { mid: 'headaaaaaa', tag: 'UI.Heading', text: 'Sign in' },
    { mid: 'textaaaaaa', tag: 'UI.Text', text: 'Email' },
  ],
};

const PAGES = [{ id: 'p1', doc: DOC, title: 'Settings' }, { id: 'p2', doc: DOC }];

function job(over: Partial<LiveJob> = {}): LiveJob {
  return { jobId: 'j1', label: 'Designing Settings', elapsedSeconds: 0, ...over };
}

function jobs(...list: LiveJob[]): Map<string, LiveJob> {
  return new Map(list.map(j => [j.jobId, j]));
}

function statusInput(over: Partial<AgentStatusInput> = {}): AgentStatusInput {
  return { jobs: new Map(), stagedCount: 0, now: 100_000, ...over };
}

function started(over: Partial<CanvasJobEvent> & Record<string, unknown> = {}): CanvasJobEvent {
  return { jobId: 'j1', type: 'started', label: 'Designing Settings', ...over } as CanvasJobEvent;
}

interface Harness {
  layer: LivenessLayer;
  doc: FakeDocument;
  world: FakeElement;
  overlay: FakeElement;
  rail: FakeElement;
  status: FakeElement;
  review: FakeElement;
  comment: FakeElement;
  railList: FakeElement;
  sent: CanvasClientBody[];
  now: { value: number };
}

/** A shell with the real ids the template ships, so adoption is exercised. */
function seedShell(doc: FakeDocument): {
  status: FakeElement; review: FakeElement; comment: FakeElement; railList: FakeElement;
} {
  const status = doc.seed(AGENT_STATUS_ID);
  const label = new FakeElement('span');
  label.className = 'agent-activity';
  label.hidden = true;
  doc.byId.set(AGENT_LABEL_ID, label);
  status.appendChild(label);
  const elapsed = new FakeElement('span');
  elapsed.className = 'agent-elapsed';
  doc.byId.set(AGENT_ELAPSED_ID, elapsed);
  status.appendChild(elapsed);
  const cancel = new FakeElement('button');
  cancel.className = 'agent-cancel';
  doc.byId.set(AGENT_CANCEL_ID, cancel);
  status.appendChild(cancel);
  return {
    status,
    review: doc.seed(REVIEW_QUEUE_ID),
    comment: doc.seed(AGENT_COMMENT_ID),
    railList: doc.seed(RAIL_LIST_ID),
  };
}

function makeLayer(over: Partial<LivenessOptions> = {}, seed = true): Harness {
  const doc = new FakeDocument();
  const world = new FakeElement('div');
  const overlay = new FakeElement('div');
  const rail = new FakeElement('div');
  const shell = seed
    ? seedShell(doc)
    : { status: new FakeElement('div'), review: new FakeElement('div'), comment: new FakeElement('div'), railList: new FakeElement('div') };
  const sent: CanvasClientBody[] = [];
  const now = { value: 100_000 };
  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: { addEventListener: () => undefined },
    createIntersectionObserver: null,
    createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
    fetchText: async () => '',
    now: () => now.value,
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
    rectsFor: () => new Map([['headaaaaaa', { x: 10, y: 20, w: 50, h: 12 }]]),
    pages: () => PAGES,
    reducedMotion: () => false,
    ...over,
  });
  return { layer, doc, world, overlay, rail, sent, now, ...shell };
}

function find(el: FakeElement, className: string): FakeElement | null {
  return el.find(e => e.className === className);
}

/** The status label the layer OWNS (never the shell's toast `#agent-activity`). */
function statusLabel(h: Harness): FakeElement | null {
  return h.status.find(e => e.attrs.get(STATUS_LABEL_ATTR) === '1');
}

/** The one polite live region — the only element allowed to announce. */
function statusLive(h: Harness): FakeElement | null {
  return h.status.find(e => e.attrs.get(STATUS_LIVE_ATTR) === '1');
}

function findAll(el: FakeElement, className: string): FakeElement[] {
  return el.findAll(e => e.className === className);
}

/* ============================ pure: agent status ============================ */

describe('jobElapsedSeconds', () => {
  it('interpolates between heartbeats but never claims less than the host reported', () => {
    const j = job({ elapsedSeconds: 4 });
    expect(jobElapsedSeconds(j, 100_000, 106_500)).toBe(6);
    // The host is ahead (a heartbeat landed late): trust the host.
    expect(jobElapsedSeconds(job({ elapsedSeconds: 12 }), 100_000, 101_000)).toBe(12);
    // No local clock at all: the heartbeat is all there is.
    expect(jobElapsedSeconds(j, undefined, undefined)).toBe(4);
  });
});

describe('agentStatusModel', () => {
  it('reports the running job, its artboard, its clock and a cancel target', () => {
    const model = agentStatusModel(statusInput({
      jobs: jobs(job({ pageId: 'p1', elapsedSeconds: 7, progress: 0.5 })),
      startedAt: new Map([['j1', 100_000]]),
      pageLabel: id => (id === 'p1' ? 'Settings' : null),
    }));
    expect(model.state).toBe('working');
    expect(model.label).toBe('Designing Settings');
    expect(model.elapsed).toBe('0:07');
    expect(model.detail).toBe('on Settings');
    expect(model.progress).toBe(0.5);
    expect(model.cancelJobIds).toEqual(['j1']);
    expect(model.busy).toBe(true);
  });

  it('names the other running jobs and the review backlog without hiding either', () => {
    const model = agentStatusModel(statusInput({
      jobs: jobs(job({ pageId: 'p1' }), job({ jobId: 'j2', label: 'Rendering' })),
      stagedCount: 3,
      pageLabel: () => 'Settings',
    }));
    expect(model.detail).toBe('on Settings · +1 more running · 3 waiting for you');
    expect(model.cancelJobIds).toEqual(['j1', 'j2']);
  });

  it('falls to review when nothing is running but suggestions are waiting', () => {
    const model = agentStatusModel(statusInput({ stagedCount: 1 }));
    expect(model.state).toBe('review');
    expect(model.label).toBe('1 suggestion to review');
    expect(model.cancelJobIds).toEqual([]);
  });

  it('recedes to idle with a reason rather than going blank', () => {
    expect(agentStatusModel(statusInput()).detail).toBe('No agent activity yet');
    expect(agentStatusModel(statusInput({ approvalMode: 'staged' })).detail)
      .toContain('arrive here as suggestions');
    expect(agentStatusModel(statusInput({ lastActivityAt: 100_000 - 120_000 })).detail)
      .toBe('last change 2m ago');
    const model = agentStatusModel(statusInput());
    expect(model.state).toBe('idle');
    expect(model.label).toBe('Idle');
  });

  it('never claims a connection it cannot substantiate', () => {
    // `binding: null` is "not reported" — it must not read as connected.
    expect(agentStatusModel(statusInput()).detail).not.toContain('connected');
    expect(agentStatusModel(statusInput({ binding: { agent: 'Mysti', canDrive: true } })).detail)
      .toBe('Mysti connected');
  });

  it('an unbound backend outranks everything, including a running job', () => {
    const model = agentStatusModel(statusInput({
      jobs: jobs(job()),
      binding: { agent: 'Cursor', canDrive: false, reason: 'No canvas transport for this backend.' },
    }));
    expect(model.state).toBe('offline');
    expect(model.label).toBe('No canvas-capable agent');
    expect(model.detail).toContain('No canvas transport');
    expect(model.detail).toContain('will not arrive');
    expect(model.cancelJobIds).toEqual([]);
  });

  it('counts the design services that are off, and only those', () => {
    const caps: CapChip[] = [
      { slug: 'canvas-image', label: 'Image generation', enabled: false, source: 'none' },
      { slug: 'figma', label: 'Figma', enabled: true, source: 'hub' },
    ] as unknown as CapChip[];
    expect(offCapabilities(caps)).toEqual(['Image generation']);
    expect(offCapabilities(null)).toEqual([]);
    expect(agentStatusModel(statusInput({ caps })).detail).toContain('1 service not connected');
  });

  it('is total: every input renders a label', () => {
    for (const input of [
      statusInput(),
      statusInput({ jobs: jobs(job({ label: '' })) }),
      statusInput({ stagedCount: 9 }),
      statusInput({ binding: { agent: '', canDrive: false } }),
    ]) {
      expect(agentStatusModel(input).label.length).toBeGreaterThan(0);
    }
  });
});

/* ============================== pure: outbox ============================== */

describe('describeOutbox', () => {
  const base: OutboxEntry = { id: 'c1', text: 'lighter', pageId: 'p1', at: 100_000, state: 'queued' };

  it('says where a note went and never that it was read', () => {
    const queued = describeOutbox(base, 100_000);
    expect(queued.status).toBe('Queued');
    expect(queued.hint).toContain('Nothing is running');
    const sent = describeOutbox({ ...base, state: 'with-run' }, 100_000);
    expect(sent.status).toBe('Sent');
    expect(sent.hint).toContain('running step');
    // The honest boundary: no state claims delivery/receipt.
    expect(`${queued.status}${queued.hint}${sent.status}${sent.hint}`.toLowerCase())
      .not.toContain('delivered');
  });
});

describe('commentBody', () => {
  it('clamps, flattens and refuses to send nothing', () => {
    expect(commentBody('p1', '   ')).toBeNull();
    expect(commentBody('', 'hello')).toBeNull();
    const body = commentBody('p1', 'make\n\n  this   lighter', 'headaaaaaa');
    expect(body).toEqual({ t: 'canvas/comment', pageId: 'p1', mid: 'headaaaaaa', text: 'make this lighter' });
    const long = commentBody('p1', 'x'.repeat(4000));
    expect(long && long.t === 'canvas/comment' && long.text.length).toBeLessThanOrEqual(1001);
  });
});

/* ============ SYNC-2 / SYNC-6 — pure halves of the honesty fixes ============ */

describe('describeOutbox — an undeliverable note (SYNC-2)', () => {
  const base: OutboxEntry = { id: 'c1', text: 'lighter', pageId: 'p1', at: 100_000, state: 'queued' };

  it('stops calling a note “Queued” when the host says nothing drains the queue', () => {
    // `CANVAS_PENDING_RUN` is drained ONLY by the coordinator loop. On every
    // other backend the note reached no model, while the row said Queued and
    // the tooltip said "Mysti reads it when its next step starts".
    const row = describeOutbox(base, 100_000, false);
    expect(row.status).toBe('Not delivered');
    expect(row.hint).toContain('does not read canvas notes');
    // Actionable, not fatalistic: `@mysti` opens a run from any provider.
    expect(row.hint).toContain('@mysti');
    // Still never claims receipt.
    expect(`${row.status} ${row.hint}`.toLowerCase()).not.toContain('was read');
  });

  it('names the precondition even when the host has not reported', () => {
    const queued = describeOutbox(base, 100_000);
    expect(queued.status).toBe('Queued');
    // The old wording implied "the agent you are chatting with".
    expect(queued.hint).toContain('the Mysti agent');
    expect(queued.hint).toContain('other backends do not read them');
  });
});

describe('activityStyleText (SYNC-6)', () => {
  const empty: ActivitySets = {
    working: new Set(), staged: new Set(), cursor: new Set(), writing: new Set(),
  };

  it('gives every stamped attribute a real selector', () => {
    const css = activityStyleText({
      ...empty,
      working: new Set(['p1']),
      staged: new Set(['p2']),
      cursor: new Set(['p3']),
      writing: new Set(['p4']),
    });
    expect(css).toContain('#rail-list[data-working~="p1"] .thumb[data-id="p1"]');
    expect(css).toContain('#rail-list[data-staged~="p2"] .thumb[data-id="p2"]');
    expect(css).toContain('#rail-list[data-cursor~="p3"] .thumb[data-id="p3"]');
    // The artboard treatment rides the world's own attribute.
    expect(css).toContain('[data-writing~="p4"] .artboard[data-page-id="p4"]');
    expect(activityStyleText(empty)).toBe('');
  });

  it('refuses to interpolate anything that is not a plain id', () => {
    const css = activityStyleText({ ...empty, working: new Set(['p"] {} body{display:none}//']) });
    expect(css).toBe('');
  });
});

describe('statusAnnouncement / terminalAnnouncement (A11Y-3)', () => {
  it('never carries anything that ticks or ages', () => {
    const working = agentStatusModel(statusInput({
      jobs: jobs(job({ pageId: 'p1', elapsedSeconds: 42, progress: 0.5 })),
    }));
    const said = statusAnnouncement(working);
    expect(said).toContain('Working: Designing Settings');
    expect(said).not.toContain('0:42');
    expect(said).not.toContain('50');

    // Idle detail is `last change 2m ago`, which changes on its own.
    const idle = agentStatusModel(statusInput({ lastActivityAt: 40_000 }));
    expect(idle.detail).toContain('last change');
    expect(statusAnnouncement(idle)).toBe('Idle');
  });

  it('distinguishes finished from cancelled from failed', () => {
    expect(terminalAnnouncement({ jobId: 'j1', type: 'done' } as CanvasJobEvent, 'Designing'))
      .toBe('Designing finished');
    expect(terminalAnnouncement(
      { jobId: 'j1', type: 'done', result: { cancelled: true } } as CanvasJobEvent, 'Designing',
    )).toBe('Designing was cancelled');
    expect(terminalAnnouncement(
      { jobId: 'j1', type: 'error', error: 'compile failed' } as CanvasJobEvent, 'Designing',
    )).toBe('Designing failed: compile failed');
  });
});

/* ============================ the status surface ============================ */

describe('LivenessLayer — persistent agent status', () => {
  it('keeps the shell\u2019s own status parts and owns its label outright', () => {
    const h = makeLayer();
    // The shell's elements survive; the layer only ADDS what is missing...
    expect(h.doc.getElementById(AGENT_LABEL_ID)?.parent).toBe(h.status);
    expect(h.doc.getElementById(AGENT_ELAPSED_ID)?.parent).toBe(h.status);
    expect(h.doc.getElementById(AGENT_CANCEL_ID)?.parent).toBe(h.status);
    expect(find(h.status, 'agent-detail')).toBeTruthy();
    expect(find(h.status, 'agent-progress')).toBeTruthy();
    // ...and the label is one of them: `#agent-activity` is also
    // `CanvasApp._flash`'s toast target, so the persistent status cannot share
    // it. It keeps the class (the pill and dot hang off `.agent-activity`).
    const label = statusLabel(h)!;
    expect(label).toBeTruthy();
    expect(label).not.toBe(h.doc.getElementById(AGENT_LABEL_ID));
    expect(label.className).toContain('agent-activity');
    expect(label.parent).toBe(h.status);
  });

  it('shows what is running, on what, and for how long — and keeps showing it', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    h.layer.onJob({ jobId: 'j1', type: 'heartbeat', elapsedSeconds: 7 } as CanvasJobEvent);
    const label = statusLabel(h)!;
    expect(label.textContent).toBe('Designing Settings');
    expect(h.doc.getElementById(AGENT_ELAPSED_ID)?.textContent).toBe('0:07');
    expect(h.status.attrs.get('data-state')).toBe('working');
    expect(h.status.attrs.get('aria-busy')).toBe('true');
    expect(find(h.status, 'agent-detail')?.textContent).toBe('on Settings');
    // The old surface hid itself after 1.8s; this one is persistent.
    expect(label.hidden).toBe(false);
  });

  it('is untouched when the legacy toast overwrites and hides #agent-activity', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    const toast = h.doc.getElementById(AGENT_LABEL_ID)!;
    const label = statusLabel(h)!;
    // Exactly what `CanvasApp._flash` does, then what it does 1.8 s later.
    toast.textContent = 'Designing...';
    toast.hidden = false;
    expect(label.textContent).toBe('Designing Settings');
    toast.hidden = true;
    // No tick, no liveness event: the status must not depend on being redrawn.
    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe('Designing Settings');
  });

  it('goes idle — visible, named, not blank — when the job ends', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    h.layer.onJob({ jobId: 'j1', type: 'done' } as CanvasJobEvent);
    expect(h.status.attrs.get('data-state')).toBe('idle');
    expect(statusLabel(h)?.textContent).toBe('Idle');
    expect(find(h.status, 'agent-detail')?.textContent).toContain('last change');
    expect(h.doc.getElementById(AGENT_CANCEL_ID)?.hidden).toBe(true);
  });

  it('cancels the jobs live AT CLICK TIME, not the ones the bar was built with', () => {
    const h = makeLayer();
    h.layer.onJob(started());
    h.layer.onJob(started({ jobId: 'j2', label: 'Rendering' }));
    h.layer.onJob({ jobId: 'j1', type: 'done' } as CanvasJobEvent);
    h.doc.getElementById(AGENT_CANCEL_ID)!.fire('click');
    expect(h.sent).toEqual([{ t: 'canvas/cancelJob', jobId: 'j2' }]);
  });

  it('keeps the status correct for a grace period after the last event', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    h.layer.onJob({ jobId: 'j1', type: 'done' } as CanvasJobEvent);
    const label = statusLabel(h)!;
    for (let i = 0; i < STATUS_IDLE_TICKS; i++) {
      h.layer.tick();
      expect(label.hidden).toBe(false);
      expect(label.textContent).toBe('Idle');
    }
  });

  it('stops ticking once the canvas has been idle for a while', () => {
    const h = makeLayer();
    h.layer.onJob(started());
    h.layer.onJob({ jobId: 'j1', type: 'done' } as CanvasJobEvent);
    for (let i = 0; i <= STATUS_IDLE_TICKS + 1; i++) { h.layer.tick(); }
    // Still correct after the clock parks itself.
    expect(statusLabel(h)?.textContent).toBe('Idle');
  });

  it('reports connection truth in the chrome when the host says the backend cannot drive', () => {
    const h = makeLayer();
    h.layer.setBinding({ agent: 'Cursor', canDrive: false, reason: 'No canvas transport.' });
    expect(h.status.attrs.get('data-state')).toBe('offline');
    expect(statusLabel(h)?.textContent).toBe('No canvas-capable agent');
  });
});

/* ================ A11Y-3 / SYNC-2 / SYNC-3 / SYNC-5 / SYNC-6 ================ */

describe('LivenessLayer — the status is announced once, not once a second (A11Y-3)', () => {
  it('takes the whole status host out of the live region', () => {
    const h = makeLayer();
    // `index.html` ships role="status" aria-live="polite" on `#agent-status`,
    // which wraps the 1 Hz clock, the progressbar and two relabelling buttons.
    expect(h.status.attrs.get('aria-live')).toBe('off');
    expect(h.status.attrs.has('role')).toBe(false);
    for (const cls of ['agent-elapsed', 'agent-detail', 'agent-progress']) {
      const el = h.status.find(e => e.className === cls);
      expect(el?.attrs.get('aria-live'), cls).toBe('off');
    }
    // …and puts a small dedicated one in its place.
    const live = statusLive(h)!;
    expect(live.attrs.get('role')).toBe('status');
    expect(live.attrs.get('aria-live')).toBe('polite');
    expect(live.attrs.get('aria-atomic')).toBe('true');
    expect(live.className).toContain('sr-only');
  });

  it('says nothing new while only the clock moves', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    const live = statusLive(h)!;
    const first = live.textContent;
    expect(first).toContain('Working: Designing Settings');

    let writes = 0;
    for (let i = 1; i <= 5; i++) {
      h.now.value += 1000;
      h.layer.onJob({ jobId: 'j1', type: 'heartbeat', elapsedSeconds: i } as CanvasJobEvent);
      h.layer.tick();
      if (live.textContent !== first) { writes++; }
    }
    // The elapsed display DID advance — it just is not in the live region.
    expect(h.doc.getElementById(AGENT_ELAPSED_ID)?.textContent).toBe('0:05');
    expect(writes, 'the polite queue must not get one message per second').toBe(0);
  });

  it('announces the transitions a screen reader would otherwise miss', () => {
    const h = makeLayer();
    const live = statusLive(h)!;
    h.layer.onJob(started({ pageId: 'p1' }));
    expect(live.textContent).toContain('Working');
    h.layer.onJob({ jobId: 'j1', type: 'done', result: { cancelled: true } } as CanvasJobEvent);
    expect(live.textContent).toContain('was cancelled');

    h.layer.onJob(started({ jobId: 'j2', label: 'Rendering' }));
    h.layer.onJob({ jobId: 'j2', type: 'error', error: 'boom' } as CanvasJobEvent);
    expect(live.textContent).toContain('Rendering failed: boom');
  });
});

describe('LivenessLayer — a host notice reaches the human (SYNC-2)', () => {
  it('renders an op_error instead of dropping it, and announces it once', () => {
    const h = makeLayer();
    // Exactly what `_reportCanvasOpProblem` and `_warnUnreachableSteering` emit.
    h.layer.onJob({
      jobId: 'canvas-steering', type: 'op_error',
      error: 'This chat is on a backend that does not read canvas notes.',
    } as CanvasJobEvent);
    expect(h.layer.notice()).toContain('does not read canvas notes');
    expect(find(h.status, 'agent-detail')?.textContent).toContain('does not read canvas notes');
    expect(h.status.attrs.get('data-notice')).toBe('true');
    expect(statusLive(h)?.textContent).toContain('does not read canvas notes');
    // It is a notice, not a job: no ghost, no Stop, no busy state.
    expect(h.layer.ghostCount).toBe(0);
    expect(h.status.attrs.get('aria-busy')).toBe('false');
  });

  it('expires the notice, and keeps ticking until it has', () => {
    const h = makeLayer();
    h.layer.onJob({ jobId: 'x', type: 'op_error', error: 'nope' } as CanvasJobEvent);
    h.now.value += STATUS_NOTICE_MS + 1;
    h.layer.tick();
    expect(h.layer.notice()).toBeNull();
    expect(h.status.attrs.get('data-notice')).toBe('false');
  });

  it('marks the outbox undeliverable once the host reports it', () => {
    const h = makeLayer();
    h.layer.focusComment('p1', 'headaaaaaa', 'Heading');
    const input = h.comment.find(e => e.className === 'ac-input')!;
    input.value = 'make this lighter';
    h.comment.find(e => e.className === 'ac-send')!.fire('click');
    expect(h.comment.find(e => e.className === 'ac-item-status')?.textContent).toBe('Queued');

    h.layer.setSteeringReachable(false);
    expect(h.comment.find(e => e.className === 'ac-item-status')?.textContent).toBe('Not delivered');
  });
});

describe('LivenessLayer — the status label is not shared (SYNC-3)', () => {
  it('survives the legacy toast writing and hiding #agent-activity', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    const toast = h.doc.getElementById(AGENT_LABEL_ID)!;
    const label = statusLabel(h)!;
    expect(label).not.toBe(toast);

    // `CanvasApp._flash('Designing...')`, then its 1.8 s timer — on a path that
    // triggers NO liveness redraw (a `canvas/receipt` error, `unpin`).
    toast.textContent = 'Designing...';
    toast.hidden = false;
    toast.hidden = true;

    expect(label.textContent).toBe('Designing Settings');
    expect(label.hidden).toBe(false);
    // The pill and the state dot hang off `.agent-activity:not([hidden])`, and
    // the layer's own label is a direct child that is never hidden.
    expect(label.className).toContain('agent-activity');
    expect(label.parent).toBe(h.status);
  });
});

describe('LivenessLayer — the review button opens the queue it names (SYNC-5)', () => {
  function reviewButton(h: Harness) {
    return h.status.find(e => e.className === 'agent-review')!;
  }

  it('asks the host to reveal the pane the queue lives in', () => {
    let revealed = 0;
    const h = makeLayer({ revealReview: () => { revealed++; } });
    h.layer.setReviewOpen(false);
    reviewButton(h).fire('click');
    expect(h.layer.reviewOpen).toBe(true);
    expect(revealed).toBe(1);
    // It is an action, not a disclosure: pressing it again reveals again
    // rather than collapsing a queue this button cannot see.
    reviewButton(h).fire('click');
    expect(h.layer.reviewOpen).toBe(true);
    expect(revealed).toBe(2);
    // …and it therefore claims no expanded state.
    expect(reviewButton(h).attrs.has('aria-expanded')).toBe(false);
    expect(reviewButton(h).attrs.get('aria-label')).toContain('Review');
  });

  it('falls back to the shell’s own rail switches when nothing is wired', () => {
    const h = makeLayer();
    const hidden = h.doc.seed(RAIL_HIDE_SWITCH_ID) as FakeElement & { checked?: boolean };
    const shown = h.doc.seed(RAIL_SHOW_SWITCH_ID) as FakeElement & { checked?: boolean };
    hidden.checked = true;               // the human pressed `[`
    shown.checked = false;
    h.layer.setReviewOpen(false);
    reviewButton(h).fire('click');
    // Both switches, because which one is live depends on the layout mode.
    expect(hidden.checked).toBe(false);
    expect(shown.checked).toBe(true);
  });
});

describe('LivenessLayer — the activity attributes have a consumer (SYNC-6)', () => {
  it('emits a stylesheet whose selectors match the stamped ids', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    h.layer.onStaged([stagedRecord('o1', SET_TEXT)]);
    h.layer.onAgentCursor({ pageId: 'p2', label: 'Mysti' });
    const style = h.doc.created.find(e => e.tag === 'style' && e.attrs.get('id') === ACTIVITY_STYLE_ID);
    expect(style, 'no generated stylesheet: the stamps are invisible').toBeTruthy();
    expect(style!.textContent).toContain('#rail-list[data-working~="p1"] .thumb[data-id="p1"]');
    expect(style!.textContent).toContain('#rail-list[data-staged~="p1"] .thumb[data-id="p1"]');
    expect(style!.textContent).toContain('#rail-list[data-cursor~="p2"] .thumb[data-id="p2"]');
    // It is attached, not orphaned.
    expect(style!.parent).toBeTruthy();
  });

  it('keeps the sheet equal to the live sets, and drops it on dispose', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    const style = h.doc.created.find(e => e.tag === 'style' && e.attrs.get('id') === ACTIVITY_STYLE_ID)!;
    h.layer.onJob({ jobId: 'j1', type: 'done' } as CanvasJobEvent);
    expect(style.textContent).toBe('');
    h.layer.dispose();
    expect(style.parent).toBeNull();
  });
});

/* ============================= the review queue ============================= */

function stagedRecord(opId: string, op: CanvasOp, pageId = 'p1'): Record<string, unknown> {
  return { opId, op, targetPageId: pageId };
}

const SET_TEXT: CanvasOp = { op: 'el.setText', pageId: 'p1', mid: 'headaaaaaa', text: 'Welcome' };

describe('LivenessLayer — the review queue', () => {
  it('renders into the dedicated queue host, not the pages rail', () => {
    const h = makeLayer();
    h.layer.onStaged([stagedRecord('o1', SET_TEXT)]);
    expect(findAll(h.review, 'staged-row')).toHaveLength(1);
    expect(findAll(h.rail, 'staged-row')).toHaveLength(0);
  });

  it('names the artboard each suggestion targets', () => {
    const h = makeLayer();
    h.layer.onStaged([stagedRecord('o1', SET_TEXT)]);
    expect(find(h.review, 'sr-where')?.textContent).toBe('Settings');
  });

  it('collapses the rows but never the count or the bulk actions', () => {
    const h = makeLayer();
    h.layer.onStaged([stagedRecord('o1', SET_TEXT), stagedRecord('o2', SET_TEXT)]);
    expect(find(h.review, 'staged-list')?.hidden).toBe(false);
    h.layer.setReviewOpen(false);
    expect(h.layer.reviewOpen).toBe(false);
    expect(find(h.review, 'staged-list')?.hidden).toBe(true);
    expect(find(h.review, 'staged-toggle')?.textContent).toBe('2 suggestions');
    expect(find(h.review, 'staged-accept-all')).toBeTruthy();
    expect(h.review.attrs.get('data-open')).toBe('false');
  });

  it('explains an empty queue in staged mode — the SHIPPED default — instead of hiding', () => {
    const h = makeLayer();
    h.layer.setApprovalMode('staged');
    expect(h.review.hidden).toBe(false);
    expect(find(h.review, 'staged-empty')?.textContent).toContain('accept or reject');
    // With no reported mode there is nothing honest to say, so it stays hidden.
    const other = makeLayer();
    expect(other.review.hidden).toBe(true);
  });

  it('names every decision button for a screen reader', () => {
    const h = makeLayer();
    h.layer.onStaged([stagedRecord('o1', SET_TEXT)]);
    expect(find(h.review, 'sr-accept')?.attrs.get('aria-label')).toContain('Accept: ');
    expect(find(h.review, 'staged-reject-all')?.attrs.get('aria-label')).toBe('Reject all 1 suggestions');
    expect(find(h.review, 'staged-row')?.attrs.get('role')).toBe('listitem');
  });

  it('offers "Show on the canvas" only when a caller can actually reveal it', () => {
    const revealed: Array<[string, string | undefined]> = [];
    const h = makeLayer({ revealTarget: (pageId, mid) => revealed.push([pageId, mid]) });
    h.layer.onStaged([stagedRecord('o1', SET_TEXT)]);
    find(h.review, 'sr-reveal')!.fire('click');
    expect(revealed).toEqual([['p1', 'headaaaaaa']]);
    expect(find(makeLayer().review, 'sr-reveal')).toBeNull();
  });
});

/* =========================== change highlights =========================== */

describe('LivenessLayer — the agent’s edits are legible as they land', () => {
  const applied = (mid: string): CanvasJobEvent => ({
    jobId: 'j1', type: 'op_applied', op: { op: 'el.setText', pageId: 'p1', mid, text: 'x' },
  } as unknown as CanvasJobEvent);

  it('highlights the element an applied op touched, placed through the board transform', () => {
    const h = makeLayer();
    h.layer.onJob(applied('headaaaaaa'));
    const flash = find(h.overlay, CHANGE_FLASH_CLASS)!;
    expect(flash.attrs.get('data-mid')).toBe('headaaaaaa');
    // boardPos {100,50} + element rect {10,20} at zoom 1.
    expect(flash.style.get('left')).toBe('110px');
    expect(flash.style.get('top')).toBe('70px');
  });

  it('falls back to the whole artboard when the element has no reported rect', () => {
    const h = makeLayer();
    h.layer.onJob({ jobId: 'j1', type: 'page_updated', pageId: 'p1' } as CanvasJobEvent);
    expect(find(h.overlay, CHANGE_FLASH_CLASS)?.style.get('width')).toBe('400px');
  });

  it('caps the highlights so a whole-page rewrite is a signal, not a strobe', () => {
    const h = makeLayer();
    for (let i = 0; i < CHANGE_FLASH_MAX + 6; i++) { h.layer.onJob(applied(`mid${i}`)); }
    expect(h.layer.flashCount).toBe(CHANGE_FLASH_MAX);
  });

  it('marks the motion preference on the element rather than animating regardless', () => {
    const h = makeLayer({ reducedMotion: () => true });
    h.layer.onJob(applied('headaaaaaa'));
    expect(find(h.overlay, CHANGE_FLASH_CLASS)?.attrs.get('data-motion')).toBe('reduced');
    expect(h.status.attrs.get('data-motion')).toBe('reduced');
  });
});

/* ============================== rail stamping ============================== */

describe('LivenessLayer — per-artboard activity on the pages rail', () => {
  it('stamps the rail list so one stylesheet rule can light up the right rows', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    h.layer.onStaged([stagedRecord('o1', SET_TEXT)]);
    h.layer.onAgentCursor({ pageId: 'p2', label: 'Mysti' });
    expect(h.railList.attrs.get('data-working')).toBe('p1');
    expect(h.railList.attrs.get('data-staged')).toBe('p1');
    expect(h.railList.attrs.get('data-cursor')).toBe('p2');
  });

  it('clears every stamp it owns on dispose', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    h.layer.dispose();
    for (const attr of RAIL_ACTIVITY_ATTRS) { expect(h.railList.attrs.has(attr)).toBe(false); }
  });
});

/* ============================ steering composer ============================ */

describe('LivenessLayer — closing the loop back to chat', () => {
  it('sends a comment and records where it went', () => {
    const h = makeLayer();
    const input = find(h.comment, 'ac-input')!;
    input.value = 'make this lighter';
    find(h.comment, 'ac-send')!.fire('click');
    expect(h.sent).toEqual([{ t: 'canvas/comment', pageId: 'p1', text: 'make this lighter' }]);
    expect(h.layer.outbox[0].state).toBe('queued');
    expect(find(h.comment, 'ac-item-status')?.textContent).toBe('Queued');
    expect(input.value).toBe('');
  });

  it('says the note joined the RUNNING step when something was running', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    const input = find(h.comment, 'ac-input')!;
    input.value = 'try a lighter header';
    find(h.comment, 'ac-send')!.fire('click');
    expect(h.layer.outbox[0].state).toBe('with-run');
    expect(find(h.comment, 'ac-item-status')?.textContent).toBe('Sent');
  });

  it('sends on Enter and ignores Shift+Enter', () => {
    const h = makeLayer();
    const input = find(h.comment, 'ac-input')!;
    input.value = 'hello';
    input.fire('keydown', { key: 'Enter', shiftKey: true });
    expect(h.sent).toHaveLength(0);
    input.fire('keydown', { key: 'Enter' });
    expect(h.sent).toHaveLength(1);
  });

  it('targets a clicked element when one is focused, then releases it', () => {
    const h = makeLayer();
    h.layer.focusComment('p1', 'headaaaaaa', 'Heading');
    expect(h.layer.commentTarget()).toEqual({ pageId: 'p1', mid: 'headaaaaaa', label: 'Heading' });
    // A pinned element target must not offer a silent retarget.
    expect(find(h.comment, 'ac-target')?.hidden).toBe(true);
    const input = find(h.comment, 'ac-input')!;
    input.value = 'lighter';
    find(h.comment, 'ac-send')!.fire('click');
    expect(h.sent[0]).toEqual({ t: 'canvas/comment', pageId: 'p1', mid: 'headaaaaaa', text: 'lighter' });
    expect(h.layer.commentTarget()?.mid).toBeUndefined();
  });

  it('offers an artboard picker when nothing is selected', () => {
    const h = makeLayer();
    const picker = find(h.comment, 'ac-target')!;
    expect(picker.children.map(c => c.textContent)).toEqual(['Settings', 'Artboard 2']);
    picker.value = 'p2';
    find(h.comment, 'ac-input')!.value = 'tighten this';
    find(h.comment, 'ac-send')!.fire('click');
    expect(h.sent[0]).toMatchObject({ pageId: 'p2' });
  });

  it('keeps only the most recent notes', () => {
    const h = makeLayer();
    for (let i = 0; i < 12; i++) {
      find(h.comment, 'ac-input')!.value = `note ${i}`;
      find(h.comment, 'ac-send')!.fire('click');
    }
    expect(h.layer.outbox).toHaveLength(6);
    expect(h.layer.outbox[5].text).toBe('note 11');
  });

  it('falls back to the inspector pane when the shell ships no composer host', () => {
    const doc = new FakeDocument();
    const inspector = doc.seed(AGENT_COMMENT_FALLBACK_ID);
    const env: CanvasEnv = {
      doc: doc as unknown as DomDocument,
      self: { addEventListener: () => undefined },
      createIntersectionObserver: null,
      createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
      fetchText: async () => '',
      now: () => 0,
      warn: () => undefined,
    };
    const existing = new FakeElement('div');
    inspector.appendChild(existing);
    mountLiveness({
      env,
      hosts: { world: null, overlay: null, rail: null },
      send: () => undefined,
      pages: () => PAGES,
    });
    // Appended, never replacing the pane's own children.
    expect(inspector.children[0]).toBe(existing);
    expect(inspector.find(e => e.className === 'ac-input')).toBeTruthy();
  });
});

/* ============================ rail: keyboard ============================ */

describe('railKeyIntent', () => {
  it('maps browse, select and Alt-reorder, and leaves everything else alone', () => {
    expect(railKeyIntent({ key: 'Enter' })).toEqual({ kind: 'select' });
    expect(railKeyIntent({ key: ' ' })).toEqual({ kind: 'select' });
    expect(railKeyIntent({ key: 'ArrowDown' })).toEqual({ kind: 'focus', delta: 1 });
    expect(railKeyIntent({ key: 'ArrowUp', altKey: true })).toEqual({ kind: 'move', delta: -1 });
    expect(railKeyIntent({ key: 'Home' })).toEqual({ kind: 'edge', to: 'first' });
    expect(railKeyIntent({ key: 'End' })).toEqual({ kind: 'edge', to: 'last' });
    expect(railKeyIntent({ key: 'a' })).toBeNull();
    // Cmd/Ctrl+Arrow belongs to the editor, not to us.
    expect(railKeyIntent({ key: 'ArrowDown', metaKey: true })).toEqual({ kind: 'focus', delta: 1 });
  });
});

describe('railNudgeOps', () => {
  it('emits ONE reorder carrying the final order, and nothing at an edge', () => {
    expect(railNudgeOps(['a', 'b', 'c'], 'a', 1)).toEqual([{ op: 'page.reorder', orderedIds: ['b', 'a', 'c'] }]);
    expect(railNudgeOps(['a', 'b', 'c'], 'a', -1)).toEqual([]);
    expect(railNudgeOps(['a', 'b', 'c'], 'c', 1)).toEqual([]);
    expect(railNudgeOps(['a', 'b'], 'zz', 1)).toEqual([]);
  });
});

/* ============================ rail: controller ============================ */

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const DESKTOP: CanvasFormatSpec = getFormat('desktop')!;

function railPage(id: string, extra: Partial<ArtifactPage> = {}): ArtifactPage {
  return {
    id, version: 1, boardPos: { x: 0, y: 0 }, actionTitle: id.toUpperCase(),
    doc: { mid: `mid-${id}`, tag: 'UI.Screen', children: [] },
    ...extra,
  };
}

function railArtifact(pages: ArtifactPage[]): WireArtifact {
  return {
    id: 'art1', version: 3, kind: 'screens', name: 'Acme', format: DESKTOP,
    theme: THEME, pages, assets: [], updatedAt: 0, approvalMode: 'staged',
  };
}

function railHarness(pages: ArtifactPage[], focusedPageId: string | null = null) {
  const doc = new FakeDocument();
  const list = new FakeElement('div');
  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: { addEventListener: () => undefined },
    createIntersectionObserver: null,
    createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
    fetchText: async () => '',
    now: () => 0,
    warn: () => undefined,
  };
  const submitted: CanvasOp[][] = [];
  const selected: string[] = [];
  const rail = new RailController({
    env,
    list: list as unknown as DomElement,
    callbacks: { submit: ops => submitted.push(ops), select: id => selected.push(id) },
    measure: (_el, pageId, index) => ({ pageId, top: index * 100, height: 100 }),
  });
  rail.render(railArtifact(pages), { focusedPageId });
  return { rail, list, submitted, selected };
}

describe('RailController — operable without a mouse', () => {
  it('is one listbox with one tab stop, and the stop follows the selection', () => {
    const h = railHarness([railPage('a'), railPage('b'), railPage('c')], 'b');
    expect(h.list.attrs.get('role')).toBe('listbox');
    expect(h.list.children.map(c => c.attrs.get('role'))).toEqual(['option', 'option', 'option']);
    expect(h.list.children.map(c => c.attrs.get('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(h.list.children[1].attrs.get('aria-selected')).toBe('true');
    expect(h.rail.focusIndex).toBe(1);
  });

  it('Enter selects and Alt+Arrow reorders with one op', () => {
    const h = railHarness([railPage('a'), railPage('b')], 'a');
    h.list.children[0].fire('keydown', { key: 'Enter' });
    expect(h.selected).toEqual(['a']);
    h.list.children[0].fire('keydown', { key: 'ArrowDown', altKey: true });
    expect(h.submitted).toEqual([[{ op: 'page.reorder', orderedIds: ['b', 'a'] }]]);
  });

  it('keeps focus on the artboard being moved across the rebuild', () => {
    const h = railHarness([railPage('a'), railPage('b'), railPage('c')], 'a');
    h.list.children[0].fire('keydown', { key: 'ArrowDown', altKey: true });
    // The host answers by re-rendering in the new order; focus must follow 'a'.
    h.rail.render(
      railArtifact([railPage('b'), railPage('a'), railPage('c')]),
      { focusedPageId: 'a' },
    );
    expect(h.rail.focusIndex).toBe(1);
    expect(h.list.children[1].attrs.get('data-id')).toBe('a');
    // A second nudge therefore works — the "keyboard reorder works once" bug.
    h.list.children[1].fire('keydown', { key: 'ArrowDown', altKey: true });
    expect(h.submitted[1]).toEqual([{ op: 'page.reorder', orderedIds: ['b', 'c', 'a'] }]);
  });

  it('arrows move the tab stop without touching the design', () => {
    const h = railHarness([railPage('a'), railPage('b'), railPage('c')], 'a');
    h.list.children[0].fire('keydown', { key: 'End' });
    expect(h.rail.focusIndex).toBe(2);
    expect(h.list.children.map(c => c.attrs.get('tabindex'))).toEqual(['-1', '-1', '0']);
    expect(h.submitted).toEqual([]);
  });

  it('names every row and every row action', () => {
    const h = railHarness([railPage('a', { legacy: true })]);
    expect(h.list.children[0].attrs.get('aria-label')).toContain('A, artboard 1');
    const actions = findAll(h.list, 'thumb-action');
    expect(actions.map(a => a.attrs.get('data-icon'))).toEqual(['add', 'duplicate', 'delete']);
    for (const action of actions) {
      expect(action.attrs.get('aria-label')?.length).toBeGreaterThan(0);
      expect(action.attrs.get('type')).toBe('button');
      // The word survives for an unstyled shell; CSS hides it once it draws an icon.
      expect(find(action, 'btn-label')?.textContent).toBeTruthy();
    }
  });

  it('railRowLabel states the device and the honest legacy badge', () => {
    const rows = railRows(railArtifact([railPage('a', { legacy: true })]), { focusedPageId: null });
    expect(railRowLabel(rows[0])).toContain('code page');
  });
});

/* =============================== historyUi =============================== */

function txn(over: Partial<CanvasHistoryTxnView> = {}): CanvasHistoryTxnView {
  return {
    txnId: 't1', author: 'agent', kinds: ['edit_page'], opCount: 4, ts: 0, inEffect: true, ...over,
  };
}

function historyStatus(over: Partial<CanvasHistoryStatus> = {}): CanvasHistoryStatus {
  return { canUndo: true, canRedo: false, position: 1, transactions: [], versions: [], ...over };
}

describe('lastChangeSummary', () => {
  it('attributes the last change, or says nothing at all', () => {
    expect(lastChangeSummary(null)).toBeNull();
    expect(lastChangeSummary(historyStatus())).toBeNull();
    expect(lastChangeSummary(historyStatus({ undo: txn() })))
      .toEqual({ text: 'Mysti · edited an artboard · 4 ops', author: 'agent' });
    expect(lastChangeSummary(historyStatus({ undo: txn({ author: 'user', opCount: 1 }) })))
      .toEqual({ text: 'You · edited an artboard', author: 'user' });
  });
});

describe('HistoryUi — attribution and naming', () => {
  function historyHarness() {
    const doc = new FakeDocument();
    const toolbar = new FakeElement('div');
    const timeline = new FakeElement('div');
    const env: CanvasEnv = {
      doc: doc as unknown as DomDocument,
      self: { addEventListener: () => undefined },
      createIntersectionObserver: null,
      createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
      fetchText: async () => '',
      now: () => 0,
      warn: () => undefined,
    };
    const ui = new HistoryUi({
      env,
      send: () => undefined,
      toolbar: toolbar as unknown as DomElement,
      timeline: timeline as unknown as DomElement,
      platform: 'mac',
    });
    return { ui, toolbar, timeline };
  }

  it('keeps a persistent "what just happened" line, hidden only when there is nothing to say', () => {
    const h = historyHarness();
    const last = find(h.toolbar, 'history-last')!;
    expect(last.hidden).toBe(true);
    h.ui.setStatus(historyStatus({ undo: txn() }));
    expect(last.hidden).toBe(false);
    expect(last.textContent).toBe('Mysti · edited an artboard · 4 ops');
    expect(last.attrs.get('data-author')).toBe('agent');
  });

  it('names its icon buttons and advertises their chords', () => {
    const h = historyHarness();
    const [undo, redo, save] = h.toolbar.children;
    expect(undo.attrs.get('aria-label')).toBe('Undo');
    expect(undo.attrs.get('data-icon')).toBe('undo');
    expect(undo.attrs.get('aria-keyshortcuts')).toBe('Meta+Z');
    expect(redo.attrs.get('aria-keyshortcuts')).toBe('Meta+Shift+Z');
    expect(save.attrs.get('type')).toBe('button');
    // The readable word survives for a shell that has not styled the icon yet.
    expect(find(undo, 'btn-label')?.textContent).toBe('Undo');
    expect(h.toolbar.attrs.get('role')).toBe('group');
  });
});

/* =============================== inspector =============================== */

describe('InspectorPanel — asking the agent about what you clicked', () => {
  function inspectorHarness(comment?: (pageId: string, mid: string, label: string) => void) {
    const doc = new FakeDocument();
    const host = new FakeElement('div');
    const env: CanvasEnv = {
      doc: doc as unknown as DomDocument,
      self: { addEventListener: () => undefined },
      createIntersectionObserver: null,
      createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
      fetchText: async () => '',
      now: () => 0,
      warn: () => undefined,
    };
    const panel = new InspectorPanel({
      env,
      host: host as unknown as DomElement,
      callbacks: { submit: () => undefined, unpin: () => undefined, ...(comment ? { comment } : {}) },
    });
    panel.render({
      pageId: 'p1',
      mids: ['headaaaaaa'],
      nodes: [{ mid: 'headaaaaaa', tag: 'UI.Heading', text: 'Sign in' }],
      doc: DOC,
    });
    return { panel, host };
  }

  it('draws the affordance only when a caller can act on it', () => {
    expect(find(inspectorHarness().host, 'insp-ask')).toBeNull();
    const seen: Array<[string, string, string]> = [];
    const h = inspectorHarness((pageId, mid, label) => seen.push([pageId, mid, label]));
    const ask = find(h.host, 'insp-ask')!;
    expect(ask.attrs.get('aria-label')).toContain('Ask Mysti');
    ask.fire('click');
    expect(seen).toEqual([['p1', 'headaaaaaa', 'UI.Heading']]);
  });

  it('names its icon-only controls and says nothing to a screen reader in glyphs', () => {
    const h = inspectorHarness();
    const clear = find(h.host, 'ctl-clear');
    expect(clear?.attrs.get('aria-label')).toContain('Reset');
    expect(clear?.attrs.get('type')).toBe('button');
    expect(find(clear!, 'btn-glyph')?.attrs.get('aria-hidden')).toBe('true');
  });

  it('states an empty selection instead of showing a blank pane', () => {
    const h = inspectorHarness();
    h.panel.render({ pageId: null, mids: [], nodes: [] });
    expect(h.host.attrs.get('data-empty')).toBe('no-selection');
    expect(find(h.host, 'insp-empty')?.attrs.get('role')).toBe('note');
  });
});

/* ============================== teardown ============================== */

describe('LivenessLayer — dispose', () => {
  it('tears down only what it added, leaving the shell’s own status parts in place', () => {
    const h = makeLayer();
    h.layer.onJob(started({ pageId: 'p1' }));
    expect(find(h.status, 'agent-detail')).toBeTruthy();
    h.layer.dispose();
    // The shell's three elements survive a dispose; ours do not.
    expect(h.doc.getElementById(AGENT_LABEL_ID)?.parent).toBe(h.status);
    expect(h.doc.getElementById(AGENT_CANCEL_ID)?.parent).toBe(h.status);
    expect(find(h.status, 'agent-detail')).toBeNull();
    expect(find(h.status, 'agent-progress')).toBeNull();
    expect(h.doc.getElementById(AGENT_LABEL_ID)?.hidden).toBe(true);
  });

  it('removes a borrowed composer container rather than emptying the pane', () => {
    const doc = new FakeDocument();
    const inspector = doc.seed(AGENT_COMMENT_FALLBACK_ID);
    const existing = new FakeElement('div');
    inspector.appendChild(existing);
    const env: CanvasEnv = {
      doc: doc as unknown as DomDocument,
      self: { addEventListener: () => undefined },
      createIntersectionObserver: null,
      createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
      fetchText: async () => '',
      now: () => 0,
      warn: () => undefined,
    };
    const layer = mountLiveness({
      env, hosts: { world: null, overlay: null, rail: null }, send: () => undefined, pages: () => PAGES,
    });
    expect(inspector.children).toHaveLength(2);
    layer.dispose();
    expect(inspector.children).toEqual([existing]);
  });
});
