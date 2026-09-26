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
 * Plan 22 Phase 5 — watch and steer: the webview half.
 *
 * Seven surfaces, one module, because they share exactly one thing: they are
 * everything the board draws that is *not* the design itself.
 *
 * 0. **The persistent agent status.** The one surface that answers *"is Mysti
 *    working right now, on what, for how long, and how do I stop it"*. Driven
 *    by the real `canvas/job` stream — `started` / `heartbeat {elapsedSeconds}`
 *    / `progress` / `done` / `error` — and NOT by a timer: the thing it
 *    replaces was a `<span>` that flashed for 1.8 s and then said nothing,
 *    which is indistinguishable from a dead agent. Idle recedes to a named,
 *    visible state ("Idle · last change 2m ago") rather than vanishing, and the
 *    Cancel reads the LIVE job set at click time so it can never stop a job
 *    that already finished while missing the one that is running.
 *
 * 1. **Ghost artboards** for `started`/`heartbeat` job events — a dashed
 *    placeholder with a shimmer at the target board position, a live elapsed
 *    timer, and a Cancel that posts `canvas/cancelJob` (which reaches the job's
 *    real `AbortSignal`, so it stops the generation rather than just hiding the
 *    spinner). Ghosts live in the **transformed world**: they are artboard-sized
 *    things standing in for artboards, so they belong in artboard space and get
 *    pan/zoom for free.
 * 2. **The agent cursor** — a labelled ghost highlight on the node being
 *    edited, drawn in the **screen-space overlay**, by the same layer that
 *    draws human selection, for the same three reasons (`selection.ts`): it
 *    survives frame repaints, it works over a static preview, and a
 *    model-authored page cannot imitate or hide it.
 * 3. **The staged suggestions rail** — per-op accept/reject plus bulk, with
 *    before/after previews rendered by the parent-side `preview.ts`. No
 *    iframes: a suggestion preview is a *thumbnail of a hypothesis*, and
 *    mounting two sandboxed frames per pending op to draw one would be absurd.
 *    "After" is computed with the pure `applyOp` — the same function the
 *    executor applies for real — so the preview cannot disagree with the edit.
 * 4. **Frame error cards** — the harness error boundary reports
 *    `error {message, stack, mid}`; this draws it on the artboard with a
 *    **Fix with AI** action that posts the message back into the run as a
 *    `canvas/comment`, i.e. as DATA, through the per-run inbox.
 * 5. **Change highlights.** `op_applied` already carries the cell that just
 *    changed and already reaches this module, so "what did it just do?" needs
 *    no new wire — only a brief, bounded outline drawn by the same screen-space
 *    layer as the cursor, and `prefers-reduced-motion` reported on the element
 *    rather than animated over.
 * 6. **The steering composer.** Click an element, say what you want changed,
 *    and it reaches the running turn as `canvas/comment`. Human text arriving
 *    through a webview is DATA: it lands in the per-run inbox and enters a
 *    model only inside `_fenceLocalToolResult`. The outbox states where a note
 *    WENT (queued for the next step / handed to the running one) and never that
 *    it was read — `CanvasBridge._onComment` enqueues and answers nothing, so
 *    there is no receipt to report and inventing one would be the exact
 *    comfortable lie this surface exists to remove.
 *
 * ## What the layer refuses to claim
 *
 * `setBinding(null)` — the default — is *not reported*, and renders as neither
 * connected nor disconnected. The webview never learns which provider the chat
 * panel is on, so a guess here would be confidently wrong in precisely the
 * situation a person is trying to work out why nothing is happening.
 *
 * ## Why this is a separate module with a mount function
 *
 * `board.ts` owns artboards, frames and selection. Liveness chrome is drawn
 * over the same two hosts but has an entirely separate lifecycle (jobs come and
 * go without any artifact change) and is the one part of the canvas that must
 * keep working when nothing has been committed yet — there is no page to hang
 * it off. Keeping it here means the board never grows a job model, and this
 * file never grows a frame.
 *
 * Everything with a decision in it is a pure exported function; the class at the
 * bottom is placement and event wiring only.
 */

import type { CanvasJobEvent, DesignTheme } from '../../types';
// Type-only: importing values from `CanvasLiveness.ts` would drag `@babel/parser`
// into the `target:'web'` bundle. The shapes are shared; the code is not.
import type {
  BoardPos,
  BoardSize,
  CanvasLivenessEvent,
  SpeculativePatch,
} from '../../canvas/CanvasLiveness';
import type { CanvasOp } from '../../canvas/CanvasOps';
import { opMid, opPageId } from '../../canvas/CanvasOps';
import { findNode, findParent, type DocNode, type Mid } from '../../canvas/doc/DocNode';
import { applyOp } from '../../canvas/doc/DocPatch';
import type { CapChip } from '../../canvas/protocol';
import { isCanvasOpKind } from './state';
import { rectToScreen, type BoardTransform, type Rect } from './boardMath';
import { elementScreenRect } from './boardMath';
import { asValueElement, type CanvasEnv, type DomElement, type DomValueElement } from './dom';
import { formatAge } from './historyUi';
import { mountPreview, renderPreview, type PreviewNode, type PreviewOptions } from './preview';
import { themeCssVars } from './sandboxDoc';
import type { CanvasClientBody } from './protocolClient';

/* ────────────────────────────── ids & defaults ────────────────────────────── */

export const GHOST_CLASS = 'ghost-artboard';
export const CURSOR_CLASS = 'agent-cursor';
export const ERROR_CARD_CLASS = 'frame-error-card';
export const STAGED_RAIL_CLASS = 'staged-rail';

/** A ghost with no size hint still has to be a rectangle a human can see. */
export const GHOST_DEFAULT_SIZE: BoardSize = { w: 960, h: 640 };

/** Rail previews are thumbnails; the full caps would render a whole page twice per row. */
export const STAGED_PREVIEW_OPTIONS: PreviewOptions = { maxNodes: 240, maxDepth: 12, maxTextLength: 200 };

/** Frame error text is model-adjacent and can be enormous. */
export const ERROR_MESSAGE_MAX = 400;

/* ─────────────────────── shell ids this module mounts into ─────────────────────── */

/**
 * The persistent agent-status surface in the top bar.
 *
 * Resolved from the shell rather than passed in, so the whole watch-and-steer
 * chrome mounts itself: the surface that answers *"is Mysti working, on what,
 * for how long, and how do I stop it"* must not depend on a wiring line
 * somewhere else being remembered. When the shell has no such element the layer
 * simply draws no status — it never falls back to the 1.8-second
 * `#agent-activity` toast this replaces, because a status that disappears is
 * the bug.
 */
export const AGENT_STATUS_ID = 'agent-status';
/** Review queue for staged suggestions. Falls back to {@link LivenessHosts.rail}. */
export const REVIEW_QUEUE_ID = 'review-queue';
/** The "tell Mysti what to change" dock. Absent ⇒ no composer, no dead chrome. */
export const AGENT_COMMENT_ID = 'agent-comment';
/** The pages rail's list. Stamped with per-page agent activity; never rewritten. */
export const RAIL_LIST_ID = 'rail-list';

/**
 * The shell's rail switches, so the top-bar review button can reveal the pane
 * the review queue lives inside.
 *
 * The queue is rendered into `#staged-rail`, a child of the collapsible
 * `<aside id="pages-rail">`. Toggling `_reviewOpen` therefore did nothing
 * observable whenever the pane holding it was collapsed (the human's shortcut,
 * or the narrow breakpoint) — the button reported a count, announced
 * `aria-expanded="true"` and revealed a `display:none` subtree. A control must
 * open the thing it names, so the reveal is part of the click.
 *
 * The queue lives in the INSPECTOR's Activity tab, not the pages rail: a review
 * action is about the board, and putting it inside navigation meant the agent
 * shoved the page list every time it produced work. So these are the inspector's
 * switches. `CanvasApp` owns pane state AND the tab, so it should pass
 * {@link LivenessOptions.revealReview} — which also selects the tab, something
 * a switch alone cannot do; these ids are the fallback for a shell that has not
 * wired it.
 */
export const REVIEW_HIDE_SWITCH_ID = 'inspector-hidden';
export const REVIEW_SHOW_SWITCH_ID = 'inspector-shown';

/**
 * The generated stylesheet that gives the rail/artboard activity attributes a
 * consumer.
 *
 * {@link LivenessLayer} stamps `data-working` / `data-staged` / `data-cursor` /
 * `data-writing` as space-separated page-id lists on `#rail-list` and on the
 * world, on the documented assumption that a rule like
 * `#rail-list[data-working~="p1"] .thumb[data-id="p1"]` lights up the matching
 * row. No such rule existed anywhere in the shipped CSS — "which artboard is
 * Mysti on" was computed, written to the DOM, and invisible.
 *
 * It cannot be written statically, because the ids are arbitrary. So the layer
 * generates it. That keeps the container-attribute mechanism (which is what
 * survives the rail rebuilding itself from the store on every artifact change,
 * and what keeps this module out of board-owned DOM) and gives it the consumer
 * it always assumed.
 */
export const ACTIVITY_STYLE_ID = 'agent-activity-style';

/**
 * Page ids allowed into a generated selector.
 *
 * The host mints these, so this is not a trust boundary — it is a *blast
 * radius* one: a stylesheet is a string, and an id that is not a plain token
 * would let a malformed artifact rewrite rules it does not own. Anything
 * outside the character set is simply not highlighted.
 */
const ACTIVITY_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The four activity sets, as the stylesheet sees them. */
export interface ActivitySets {
  working: ReadonlySet<string>;
  staged: ReadonlySet<string>;
  cursor: ReadonlySet<string>;
  writing: ReadonlySet<string>;
}

/**
 * The CSS text for one activity snapshot. Pure, so the rules are unit-testable
 * without a browser and the id filter is provable.
 *
 * Treatments are deliberately non-animated (`prefers-reduced-motion` is
 * reported on the status host, not compensated for here) and drawn with
 * `outline`/`box-shadow` so they cost no layout and cannot shift a thumbnail.
 */
export function activityStyleText(sets: ActivitySets): string {
  const rules: string[] = [];
  const ids = (set: ReadonlySet<string>): string[] =>
    [...set].filter(id => typeof id === 'string' && ACTIVITY_ID_RE.test(id));
  for (const id of ids(sets.staged)) {
    rules.push(`#${RAIL_LIST_ID}[data-staged~="${id}"] .thumb[data-id="${id}"]{box-shadow:inset 3px 0 0 var(--warn);}`);
  }
  for (const id of ids(sets.working)) {
    rules.push(`#${RAIL_LIST_ID}[data-working~="${id}"] .thumb[data-id="${id}"]{box-shadow:inset 3px 0 0 var(--accent);}`);
  }
  for (const id of ids(sets.cursor)) {
    rules.push(`#${RAIL_LIST_ID}[data-cursor~="${id}"] .thumb[data-id="${id}"]{outline:1px solid var(--accent);outline-offset:-1px;}`);
  }
  for (const id of ids(sets.writing)) {
    rules.push(`#${RAIL_LIST_ID}[data-writing~="${id}"] .thumb[data-id="${id}"]{box-shadow:inset 3px 0 0 var(--accent);}`);
    rules.push(`[data-writing~="${id}"] .artboard[data-page-id="${id}"] .artboard-surface{outline:2px dashed var(--accent);outline-offset:2px;}`);
  }
  return rules.join('\n');
}

/**
 * Where the steering composer lands when the shell ships no `#agent-comment`.
 *
 * The inspector pane, appended to — never replacing its children. "Select an
 * element, say what you want changed" is an inspector gesture, and putting the
 * composer there means the loop back to chat exists even in a shell that has
 * not been told about it.
 */
export const AGENT_COMMENT_FALLBACK_ID = 'inspector';

export const AGENT_STATUS_CLASS = 'agent-status';
export const AGENT_COMMENT_CLASS = 'agent-comment';
export const CHANGE_FLASH_CLASS = 'change-flash';

/** The shell's own status parts, adopted when present rather than replaced. */
export const AGENT_LABEL_ID = 'agent-activity';
export const AGENT_ELAPSED_ID = 'agent-elapsed';
export const AGENT_CANCEL_ID = 'btn-agent-cancel';
export const AGENT_DOT_CLASS = 'agent-dot';

/**
 * The status label this layer OWNS, marked by an attribute rather than a class.
 *
 * It used to adopt the shell's `#agent-activity`. That element is also the
 * target of `CanvasApp._flash`, a 1.8-second toast that overwrites it and then
 * sets `hidden = true` — so every `started`/`progress` event replaced the real
 * job label with the literal string "Designing…", and a `_flash` on a path that
 * triggers no liveness redraw (a `canvas/receipt` error, the inspector's
 * `unpin`) blanked the status *permanently*, taking the pill chrome and the
 * state dot with it via `.agent-status:has(> .agent-activity:not([hidden]))`.
 *
 * A persistent status cannot share its element with a transient toast, so this
 * layer now creates its own. It keeps the `agent-activity` CLASS (that is the
 * stylesheet's contract for the pill, the dot and the flex order) and is found
 * by {@link STATUS_LABEL_ATTR} — which means no new class, no CSS change, and
 * no way for a foreign writer to reach it.
 */
export const STATUS_LABEL_ATTR = 'data-status-label';
/** The one small polite live region — see {@link STATUS_LIVE_ATTR}. */
export const STATUS_LIVE_ATTR = 'data-status-live';

/**
 * Idle ticks the status clock keeps running after the last event.
 *
 * The clock has to outlive the last EVENT, not just the last render: a notice
 * pushed by the host (`op_error`) expires on a timer, and the elapsed display
 * would otherwise freeze between the 2 s heartbeats. It then stops, so an idle
 * canvas costs nothing.
 *
 * (It no longer exists to out-wait `CanvasApp._flash`: the status owns its own
 * label now, so a toast on a shared element cannot blank it.)
 */
export const STATUS_IDLE_TICKS = 4;

/** How long a host-pushed notice (`op_error`) stays on the status line. */
export const STATUS_NOTICE_MS = 8000;

/** How long a just-changed element keeps its highlight. */
export const CHANGE_FLASH_MS = 1400;
/** Concurrent highlights. A whole-page rewrite must not paint 400 outlines. */
export const CHANGE_FLASH_MAX = 12;
/** Status redraw cadence while a job is live, so elapsed advances between 2 s heartbeats. */
export const STATUS_TICK_MS = 1000;
/** Comment rows kept in the outbox. */
export const OUTBOX_MAX = 6;
/** A steering comment is one line of intent, not an essay. */
export const COMMENT_MAX = 1000;

/* ──────────────────────────── job model (pure) ──────────────────────────── */

export interface LiveJob {
  jobId: string;
  label: string;
  pageId?: string;
  boardPos?: BoardPos;
  size?: BoardSize;
  elapsedSeconds: number;
  progress?: number;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoardPos(raw: unknown): BoardPos | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const x = finite((raw as { x?: unknown }).x);
  const y = finite((raw as { y?: unknown }).y);
  return x === null || y === null ? undefined : { x, y };
}

function readSize(raw: unknown): BoardSize | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const w = finite((raw as { w?: unknown }).w);
  const h = finite((raw as { h?: unknown }).h);
  if (w === null || h === null || w <= 0 || h <= 0) { return undefined; }
  return { w, h };
}

/**
 * Read a `started` event as a ghost.
 *
 * The host is the trusted end of this channel, so this is not a security
 * boundary — it is a *version* boundary. `boardPos`/`size` ride
 * `CanvasJobEvent` as extension fields, so an older host simply does not send
 * them and the ghost falls back to a default rectangle rather than to `NaN`
 * geometry that silently disappears off the board.
 */
export function readGhost(event: CanvasJobEvent): LiveJob | null {
  if (!event || event.type !== 'started' || typeof event.jobId !== 'string' || !event.jobId) { return null; }
  const ext = event as CanvasLivenessEvent;
  const job: LiveJob = {
    jobId: event.jobId,
    label: typeof event.label === 'string' && event.label ? event.label : 'Working…',
    elapsedSeconds: 0,
  };
  if (typeof event.pageId === 'string' && event.pageId) { job.pageId = event.pageId; }
  const pos = readBoardPos(ext.boardPos);
  if (pos) { job.boardPos = pos; }
  const size = readSize(ext.size);
  if (size) { job.size = size; }
  return job;
}

/** Read a speculative patch off a `progress` event, or null when it is not one. */
export function readSpeculative(event: CanvasJobEvent): SpeculativePatch | null {
  if (!event || event.type !== 'progress') { return null; }
  const spec = (event as CanvasLivenessEvent).spec;
  if (!spec || typeof spec !== 'object') { return null; }
  const pageId = (spec as { pageId?: unknown }).pageId;
  const seq = finite((spec as { seq?: unknown }).seq);
  const ops = (spec as { ops?: unknown }).ops;
  if (typeof pageId !== 'string' || !pageId || seq === null || !Array.isArray(ops)) { return null; }
  const valid = ops.filter((op): op is CanvasOp =>
    !!op && typeof op === 'object' && isCanvasOpKind((op as { op?: unknown }).op));
  if (valid.length !== ops.length) { return null; }
  return { pageId, seq, ops: valid, sealed: (spec as { sealed?: unknown }).sealed === true };
}

/**
 * Fold one job event into the live-job map. Pure: returns a new map.
 *
 * `done` and `error` REMOVE the job — including the `done {cancelled}` the
 * router emits from `cancel()`. That is the whole leaked-spinner fix: a ghost
 * can only disappear via a terminal event, and a terminal event always removes
 * it, so "the overlay outlived its job" is not a reachable state.
 */
export function applyJobEvent(
  jobs: ReadonlyMap<string, LiveJob>,
  event: CanvasJobEvent,
): Map<string, LiveJob> {
  const next = new Map(jobs);
  if (!event || typeof event.jobId !== 'string' || !event.jobId) { return next; }
  switch (event.type) {
    case 'started': {
      const ghost = readGhost(event);
      if (ghost) { next.set(ghost.jobId, ghost); }
      return next;
    }
    case 'heartbeat': {
      const job = next.get(event.jobId);
      if (!job) { return next; }
      const elapsed = finite(event.elapsedSeconds);
      next.set(job.jobId, {
        ...job,
        elapsedSeconds: elapsed === null ? job.elapsedSeconds : Math.max(0, Math.round(elapsed)),
        ...(typeof event.label === 'string' && event.label ? { label: event.label } : {}),
        ...(typeof event.pageId === 'string' && event.pageId ? { pageId: event.pageId } : {}),
      });
      return next;
    }
    case 'progress': {
      const job = next.get(event.jobId);
      if (!job) { return next; }
      const p = finite(event.progress);
      next.set(job.jobId, {
        ...job,
        ...(p === null ? {} : { progress: Math.min(1, Math.max(0, p)) }),
        ...(typeof event.label === 'string' && event.label ? { label: event.label } : {}),
        ...(typeof event.pageId === 'string' && event.pageId ? { pageId: event.pageId } : {}),
      });
      return next;
    }
    case 'done':
    case 'error':
      next.delete(event.jobId);
      return next;
    default:
      return next;
  }
}

/** `0:07`, `1:05`, `12:07`. Negative and non-finite input reads as `0:00`. */
export function formatElapsed(seconds: unknown): string {
  const s = finite(seconds);
  const total = s === null || s < 0 ? 0 : Math.floor(s);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

/* ──────────────────────── agent status model (pure) ──────────────────────── */

/**
 * What the top bar is saying about the agent right now.
 *
 * Four states, and the order below is the priority order — `offline` wins over
 * everything because a surface that reads "idle" while nothing can drive the
 * canvas is worse than one that reads nothing at all.
 */
export type AgentState = 'offline' | 'working' | 'review' | 'idle';

/**
 * Whether an agent capable of driving THIS canvas is bound to the chat panel.
 *
 * Pushed by the host (it is the only end that knows which provider the panel is
 * on and whether that provider has a canvas transport). `null` means *not
 * reported*, which renders as neither "connected" nor "disconnected": the
 * chrome never invents a connection claim it cannot substantiate.
 */
export interface AgentBinding {
  /** Display name of the bound agent, e.g. `Mysti` or `Claude Code`. */
  agent: string;
  /** False when the backend has no way to drive the canvas at all. */
  canDrive: boolean;
  /** Host-authored explanation, shown verbatim when {@link canDrive} is false. */
  reason?: string;
}

export interface AgentStatusModel {
  state: AgentState;
  /** The one line a person reads first. */
  label: string;
  /** `0:07` while working; empty otherwise. */
  elapsed: string;
  /** Second line: where, how many, what is waiting. */
  detail: string;
  /** 0..1 when the job reports it, else null. */
  progress: number | null;
  /** Everything Cancel would stop. Empty ⇒ no Cancel button is drawn. */
  cancelJobIds: string[];
  stagedCount: number;
  /** Drives `aria-busy` and the dot's animation. */
  busy: boolean;
}

export interface AgentStatusInput {
  jobs: ReadonlyMap<string, LiveJob>;
  stagedCount: number;
  binding?: AgentBinding | null;
  caps?: readonly CapChip[] | null;
  approvalMode?: 'auto' | 'staged' | null;
  /** Human name for an artboard; `null` when the page is unknown. */
  pageLabel?: (pageId: string) => string | null;
  now?: number;
  /** Wall-clock start per job, for the between-heartbeat interpolation. */
  startedAt?: ReadonlyMap<string, number>;
  /** When the layer last saw the agent do anything. `null` ⇒ never. */
  lastActivityAt?: number | null;
}

/**
 * Elapsed seconds for one job.
 *
 * `heartbeat` carries the authoritative number but only every 2 s, and a timer
 * that visibly freezes for two seconds at a time reads as a hung agent. So the
 * local clock interpolates BETWEEN heartbeats and the heartbeat wins whenever
 * it is ahead — the display can run at most one second optimistic, and can
 * never claim less progress than the host reported.
 */
export function jobElapsedSeconds(
  job: LiveJob,
  startedAt: number | undefined,
  now: number | undefined,
): number {
  const base = Math.max(0, Math.floor(job.elapsedSeconds));
  if (startedAt === undefined || now === undefined) { return base; }
  const local = Math.floor(Math.max(0, now - startedAt) / 1000);
  return Math.max(base, local);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Capability chips that are off — the honest half of "connected capabilities". */
export function offCapabilities(caps: readonly CapChip[] | null | undefined): string[] {
  if (!Array.isArray(caps)) { return []; }
  return caps.filter(c => c && c.enabled !== true && typeof c.label === 'string').map(c => c.label);
}

/**
 * The whole top-bar status, as data.
 *
 * Pure and total: every branch produces a label, so there is no input that
 * renders an empty status bar. That is the point — the previous surface was a
 * span that flashed for 1.8 s and then said nothing at all, which is
 * indistinguishable from "the agent died".
 */
export function agentStatusModel(input: AgentStatusInput): AgentStatusModel {
  const jobs = input.jobs ?? new Map<string, LiveJob>();
  const staged = Math.max(0, Math.floor(input.stagedCount ?? 0));
  const now = input.now;
  const binding = input.binding ?? null;
  const offCaps = offCapabilities(input.caps);

  if (binding && binding.canDrive === false) {
    const reason = typeof binding.reason === 'string' && binding.reason.trim()
      ? clampText(binding.reason, 140)
      : `${clampText(binding.agent, 40)} cannot drive the canvas.`;
    return {
      state: 'offline',
      label: 'No canvas-capable agent',
      elapsed: '',
      detail: `${reason} Design edits will not arrive.`,
      progress: null,
      cancelJobIds: [],
      stagedCount: staged,
      busy: false,
    };
  }

  if (jobs.size > 0) {
    const list = [...jobs.values()];
    const primary = list[0];
    const seconds = jobElapsedSeconds(primary, input.startedAt?.get(primary.jobId), now);
    const parts: string[] = [];
    const where = primary.pageId ? input.pageLabel?.(primary.pageId) ?? null : null;
    if (where) { parts.push(`on ${clampText(where, 40)}`); }
    if (list.length > 1) { parts.push(`+${list.length - 1} more running`); }
    if (staged > 0) { parts.push(`${staged} waiting for you`); }
    return {
      state: 'working',
      label: clampText(primary.label, 60) || 'Working…',
      elapsed: formatElapsed(seconds),
      detail: parts.join(' · '),
      progress: typeof primary.progress === 'number' ? primary.progress : null,
      cancelJobIds: list.map(j => j.jobId),
      stagedCount: staged,
      busy: true,
    };
  }

  if (staged > 0) {
    return {
      state: 'review',
      label: `${staged} ${plural(staged, 'suggestion', 'suggestions')} to review`,
      elapsed: '',
      detail: 'Mysti is waiting on you',
      progress: null,
      cancelJobIds: [],
      stagedCount: staged,
      busy: false,
    };
  }

  const detail: string[] = [];
  if (typeof input.lastActivityAt === 'number' && now !== undefined) {
    detail.push(`last change ${formatAge(input.lastActivityAt, now)}`);
  } else if (input.approvalMode === 'staged') {
    detail.push('Mysti\u2019s edits will arrive here as suggestions');
  } else if (binding) {
    detail.push(`${clampText(binding.agent, 40)} connected`);
  } else {
    detail.push('No agent activity yet');
  }
  if (offCaps.length > 0) {
    detail.push(`${offCaps.length} ${plural(offCaps.length, 'service', 'services')} not connected`);
  }
  return {
    state: 'idle',
    label: 'Idle',
    elapsed: '',
    detail: detail.join(' · '),
    progress: null,
    cancelJobIds: [],
    stagedCount: staged,
    busy: false,
  };
}

/**
 * The one sentence a screen reader hears when something changes.
 *
 * The status bar used to BE the live region: `#agent-status` carries
 * `role="status" aria-live="polite"` and wraps the elapsed clock, the detail
 * line, the progressbar's `aria-valuenow` and the Stop button — while a 1 Hz
 * ticker rewrites the clock for as long as a job is live. NVDA/VoiceOver
 * therefore read "0:01", "0:02", "0:03" … for the whole run (routinely
 * minutes), and the polite queue never drained, so nothing else the person
 * navigated to could be heard. The one requirement the surface exists for
 * became actively hostile in the modality that needs it most.
 *
 * So the announcement is built here, deliberately excluding everything that
 * ticks or ages:
 *  - elapsed seconds and progress percent are never in it;
 *  - the idle detail is dropped entirely, because `last change 2m ago` re-reads
 *    itself every minute for a canvas nobody is touching;
 *  - it is written only when the STRING changes, so a redraw is silent.
 *
 * `terminal` is the one-shot transition ("… finished" / "… failed" / "… was
 * cancelled"), folded into the same sentence so a job ending is one
 * announcement rather than two.
 */
export function statusAnnouncement(model: AgentStatusModel, terminal?: string | null): string {
  const parts: string[] = [];
  if (typeof terminal === 'string' && terminal.trim()) { parts.push(clampText(terminal, 160)); }
  switch (model.state) {
    case 'offline':
      parts.push(model.detail ? `${model.label}. ${model.detail}` : model.label);
      break;
    case 'working':
      parts.push(model.detail ? `Working: ${model.label} — ${model.detail}` : `Working: ${model.label}`);
      break;
    case 'review':
      parts.push(model.label);
      break;
    default:
      // Deliberately NOT `model.detail`: it carries `last change 2m ago`, which
      // changes on its own and would re-announce an idle canvas forever.
      parts.push('Idle');
      break;
  }
  return parts.join('. ');
}

/**
 * How a terminal job event reads out loud.
 *
 * `done {result:{cancelled:true}}` is what `CanvasJobRouter.cancel` emits, so
 * "the human stopped it" and "it finished" are distinguishable — and a job that
 * ends because it FAILED must not be announced as completion.
 */
export function terminalAnnouncement(event: CanvasJobEvent, label: string): string | null {
  const name = clampText(label, 60) || 'The canvas job';
  if (event.type === 'error') {
    const detail = typeof event.error === 'string' && event.error.trim()
      ? `: ${clampText(event.error, 100)}`
      : '';
    return `${name} failed${detail}`;
  }
  if (event.type !== 'done') { return null; }
  const result = event.result as { cancelled?: unknown } | undefined;
  return result && result.cancelled === true ? `${name} was cancelled` : `${name} finished`;
}

/* ────────────────────────── steering outbox (pure) ────────────────────────── */

/**
 * How far a comment has got.
 *
 * Deliberately TWO states, not three. The host has no acknowledgement wire for
 * `canvas/comment` (see `CanvasBridge._onComment`: it enqueues and answers
 * nothing), so the view can honestly say *where it went* and never *that it was
 * read*. `with-run` means a job was live when it left, so it joins that run's
 * inbox; `queued` means nothing was running, so it waits under
 * `CANVAS_PENDING_RUN` for Mysti's next step. Claiming "delivered" without a
 * receipt is exactly the kind of comfortable lie this surface exists to remove.
 */
export type OutboxState = 'queued' | 'with-run';

export interface OutboxEntry {
  id: string;
  text: string;
  pageId: string;
  mid?: Mid;
  at: number;
  state: OutboxState;
}

export interface OutboxRow {
  /** Short status word for the row's badge. */
  status: string;
  /** The honest long form, for the row's title attribute. */
  hint: string;
}

/**
 * @param reachable What the HOST says about whether anything drains the queue.
 *   `false` means it told us nothing will; `null`/omitted means it did not say,
 *   and the row falls back to naming the precondition instead of assuming it.
 *
 * The old `queued` hint read *"Mysti reads it when its next step starts"*,
 * which a person on Claude Code (or Codex, or Gemini) reasonably heard as "the
 * agent I am talking to". It is not: `CANVAS_PENDING_RUN` is drained in exactly
 * one place, the coordinator loop, so on every other backend the note — and
 * every accept/reject outcome behind it — reached no model at all while the row
 * said **Queued**. This is the module's own stated failure mode: a receipt it
 * cannot substantiate.
 */
export function describeOutbox(entry: OutboxEntry, now: number, reachable?: boolean | null): OutboxRow {
  const age = formatAge(entry.at, now);
  if (reachable === false) {
    return {
      status: 'Not delivered',
      hint: `Held ${age}. This chat is on a backend that does not read canvas notes — only the Mysti agent drains them. Send “@mysti” in chat, or switch this chat to Mysti, and it will be picked up.`,
    };
  }
  return entry.state === 'with-run'
    ? {
      status: 'Sent',
      hint: `Handed to the running step ${age}. Mysti reads it at the top of its next step.`,
    }
    : {
      status: 'Queued',
      hint: `Queued ${age}. Nothing is running — the Mysti agent reads canvas notes when its next step starts; other backends do not read them.`,
    };
}

/** The `canvas/comment` body for a steering note. Text is clamped, never trusted. */
export function commentBody(pageId: string, text: string, mid?: Mid): CanvasClientBody | null {
  const clean = clampText(text, COMMENT_MAX);
  if (!pageId || !clean) { return null; }
  return { t: 'canvas/comment', pageId, ...(mid ? { mid } : {}), text: clean };
}

/** The ghost's rectangle in WORLD space. */
export function ghostWorldRect(job: LiveJob, fallback: BoardPos = { x: 0, y: 0 }): Rect {
  const pos = job.boardPos ?? fallback;
  const size = job.size ?? GHOST_DEFAULT_SIZE;
  return { x: pos.x, y: pos.y, w: size.w, h: size.h };
}

/** Monotonic-sequence gate: a duplicate or out-of-order patch is dropped. */
export function acceptSpeculative(lastSeq: number | undefined, patch: SpeculativePatch): boolean {
  if (!patch || patch.ops.length === 0) { return false; }
  if (lastSeq === undefined) { return true; }
  return patch.seq > lastSeq;
}

/* ───────────────────────── outbound message bodies ───────────────────────── */

export function cancelJobBody(jobId: string): CanvasClientBody {
  return { t: 'canvas/cancelJob', jobId };
}

export function decideBody(opIds: readonly string[], accept: boolean): CanvasClientBody {
  return { t: 'canvas/decide', opIds: [...opIds], accept };
}

/**
 * "Fix with AI" — the render error, routed back into the run as a comment.
 *
 * A comment, not a private channel: it lands in the per-run inbox next to the
 * human's own words, gets fenced as UNTRUSTED with everything else, and is
 * therefore incapable of instructing the model however hostile the page's
 * thrown message is.
 */
export function fixWithAiBody(pageId: string, message: string, mid?: Mid): CanvasClientBody {
  const clean = clampText(message, ERROR_MESSAGE_MAX);
  const where = mid ? ` (element ${mid})` : '';
  return {
    t: 'canvas/comment',
    pageId,
    ...(mid ? { mid } : {}),
    text: `This artboard failed to render${where}. The error was: ${clean}. Please fix the page.`,
  };
}

export function clampText(raw: unknown, max: number): string {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/* ──────────────────────────── staged suggestions ──────────────────────────── */

export interface StagedEntry {
  opId: string;
  /**
   * The V2 op, when the record carries one.
   *
   * `null` for a legacy kind-based record: those hold a `PageInit`, a page
   * patch or a `DesignTheme` under `proposedValue`, which is not an op and
   * cannot be run through `applyOp` for a preview. A row still renders and
   * still accepts/rejects — the host routes the decision by op id, not by
   * anything the view reconstructs.
   */
  op: CanvasOp | null;
  /** Set instead of {@link op} for a legacy record; one of {@link LEGACY_KIND_LABELS}. */
  kind?: string;
  pageId: string | null;
  mid: Mid | null;
}

/**
 * Titles for the legacy kind-based half of the wire.
 *
 * Deliberately a fixed map rather than an interpolation of `record.kind`: the
 * record is model-adjacent, and a rail row must never print a string an agent
 * chose. An unrecognized kind is not rendered at all (see
 * {@link readStagedRecord}), so there is no fallthrough to guard.
 */
export const LEGACY_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  insert_page: 'Add artboard',
  edit_page: 'Rewrite artboard',
  delete_page: 'Remove artboard',
  reorder: 'Reorder artboards',
  set_theme: 'Change the theme',
  set_format: 'Change the device format',
  edit_element: 'Edit an element',
  add_asset: 'Add an asset',
});

/**
 * Read one staged record off the wire.
 *
 * Tolerant of both eras by design, not by accident. Three shapes arrive here:
 *
 *  - a V2 journal record, whose op is under `op`;
 *  - a legacy *event* record minted by `CanvasOpExecutor._emitLegacy` for a V2
 *    op, whose op is under `proposedValue`;
 *  - a genuinely legacy `{kind, proposedValue}` op out of `artifact.opLog` —
 *    which is where the shipped default (`ask-permission` ⇒ `staged`) parks
 *    every `insert_page` / `edit_page` / `delete_page` / `set_theme` /
 *    `edit_element`. Refusing this third shape is what made a whole tool family
 *    silently do nothing: the op was staged, and no card could ever render it.
 *
 * Reading the field rather than the era is the same trick `state.ts` uses, and
 * it means neither end needs a flag day.
 */
export function readStagedRecord(raw: unknown): StagedEntry | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const opId = (raw as { opId?: unknown }).opId;
  if (typeof opId !== 'string' || !opId) { return null; }
  const candidates = [(raw as { op?: unknown }).op, (raw as { proposedValue?: unknown }).proposedValue];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') { continue; }
    if (!isCanvasOpKind((candidate as { op?: unknown }).op)) { continue; }
    const op = candidate as CanvasOp;
    return { opId, op, pageId: opPageId(op), mid: opMid(op) };
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(LEGACY_KIND_LABELS, kind)) { return null; }
  const targetPageId = (raw as { targetPageId?: unknown }).targetPageId;
  const proposed = (raw as { proposedValue?: unknown }).proposedValue;
  const mid = proposed && typeof proposed === 'object' ? (proposed as { mid?: unknown }).mid : undefined;
  return {
    opId,
    op: null,
    kind,
    pageId: typeof targetPageId === 'string' && targetPageId ? targetPageId : null,
    mid: typeof mid === 'string' && mid ? mid : null,
  };
}

/**
 * The rail's title for one entry, whichever half of the wire it came from.
 *
 * The label lookup goes through `hasOwnProperty` rather than `?? fallback`
 * because `LEGACY_KIND_LABELS['__proto__']` resolves to `Object.prototype` —
 * an object, not `undefined` — and would put a non-string in `textContent`.
 * `readStagedRecord` already refuses such a kind; this keeps the exported
 * function safe for a caller that did not go through it.
 */
export function describeStaged(entry: StagedEntry): string {
  if (entry.op) { return describeOp(entry.op); }
  const kind = entry.kind ?? '';
  return Object.prototype.hasOwnProperty.call(LEGACY_KIND_LABELS, kind)
    ? LEGACY_KIND_LABELS[kind]
    : 'Canvas edit';
}

/** Human label for one op. Exhaustive: a new op variant is a `tsc` failure. */
export function describeOp(op: CanvasOp): string {
  switch (op.op) {
    case 'page.add': return `Add artboard "${clampText(op.page?.actionTitle ?? 'Untitled', 40)}"`;
    case 'page.remove': return `Remove artboard ${op.pageId}`;
    case 'page.duplicate': return `Duplicate artboard ${op.pageId}`;
    case 'page.setMeta': return `Update artboard settings on ${op.pageId}`;
    case 'page.move': return `Move artboard ${op.pageId}`;
    case 'page.reorder': return 'Reorder artboards';
    case 'page.setDoc': return `Rewrite artboard ${op.pageId}`;
    case 'el.setText': return `Text → "${clampText(op.text, 40)}"`;
    case 'el.setStyle': return `Style: ${Object.keys(op.style ?? {}).slice(0, 4).join(', ') || '(none)'}`;
    case 'el.setProp': return `Set ${op.name} = ${clampText(JSON.stringify(op.value ?? null), 40)}`;
    case 'el.insert': return `Insert <${op.node?.tag ?? 'element'}>`;
    case 'el.remove': return `Remove element ${op.mid}`;
    case 'el.move': return `Move element ${op.mid}`;
    case 'el.replace': return `Replace element ${op.mid}`;
    case 'theme.set': return 'Change the theme';
    case 'theme.setToken': return `Theme token ${op.path} → ${clampText(op.value, 24)}`;
    case 'artifact.setFormat': return `Set format ${op.format?.formatId ?? ''}`.trim();
    case 'asset.add': return 'Add an asset';
    default: {
      const never: never = op;
      return String((never as { op?: string }).op ?? 'edit');
    }
  }
}

/**
 * The subtree worth previewing for an op.
 *
 * For a removal or a move the target itself is the thing that disappears, so
 * previewing it would show "a card" then "nothing" — the PARENT is where the
 * change reads. For an insert the parent is the only node that exists in both
 * trees. Everything else previews itself.
 */
export function previewMidFor(op: CanvasOp, doc: DocNode): Mid | null {
  switch (op.op) {
    case 'el.insert': return op.parentMid;
    case 'el.remove':
    case 'el.move': return findParent(doc, op.mid)?.parent.mid ?? doc.mid;
    case 'el.setText':
    case 'el.setStyle':
    case 'el.setProp':
    case 'el.replace': return op.mid;
    case 'page.setDoc': return doc.mid;
    default: return null;
  }
}

export interface StagedRow {
  opId: string;
  title: string;
  pageId: string | null;
  mid: Mid | null;
  before: PreviewNode | null;
  after: PreviewNode | null;
  /** Set when the "after" could not be computed — the row still accepts/rejects. */
  error?: string;
}

/**
 * Build the rail's rows: title plus before/after previews.
 *
 * "After" comes from the pure `applyOp` against a COPY of the current doc — the
 * identical function `CanvasOpExecutor` runs when the human accepts. There is
 * no second implementation of "what this op would do", which is the one thing
 * that could make an accept/reject rail actively harmful.
 */
export function stagedRows(
  entries: readonly StagedEntry[],
  pages: ReadonlyArray<{ id: string; doc: DocNode }>,
  opts: { preview?: PreviewOptions } = {},
): StagedRow[] {
  const previewOpts = opts.preview ?? STAGED_PREVIEW_OPTIONS;
  const byId = new Map<string, DocNode>();
  for (const page of pages) { if (page && typeof page.id === 'string') { byId.set(page.id, page.doc); } }

  const rows: StagedRow[] = [];
  for (const entry of entries) {
    const row: StagedRow = {
      opId: entry.opId,
      title: describeStaged(entry),
      pageId: entry.pageId,
      mid: entry.mid,
      before: null,
      after: null,
    };
    const doc = entry.pageId ? byId.get(entry.pageId) ?? null : null;
    // No V2 op ⇒ a legacy record: there is no pure function that says what it
    // would do, and inventing one here would be a second implementation of the
    // executor. The row is a title plus Accept/Reject, honestly previewless.
    if (!entry.op || !doc) { rows.push(row); continue; }
    const stagedOp = entry.op;
    const mid = previewMidFor(stagedOp, doc);
    if (!mid) { rows.push(row); continue; }

    const beforeNode = findNode(doc, mid);
    if (beforeNode) { row.before = renderPreview(beforeNode, previewOpts).root; }
    try {
      const next = applyOp(doc, stagedOp).doc;
      const afterNode = findNode(next, mid);
      if (afterNode) { row.after = renderPreview(afterNode, previewOpts).root; }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    rows.push(row);
  }
  return rows;
}

/* ─────────────────────────────── the layer ─────────────────────────────── */

export interface PageGeometry {
  boardPos: BoardPos;
  size: BoardSize;
}

export interface LivenessHosts {
  /** The transformed world. Ghost artboards are appended here. */
  world: DomElement | null;
  /** The untransformed overlay. Cursor + error cards are appended here. */
  overlay: DomElement | null;
  /** Where the suggestions rail is rendered. */
  rail: DomElement | null;
  /**
   * The persistent top-bar status. Omitted ⇒ resolved from
   * {@link AGENT_STATUS_ID}, so the shell can supply it without any wiring.
   */
  status?: DomElement | null;
  /** The review queue. Omitted ⇒ {@link REVIEW_QUEUE_ID}, then {@link rail}. */
  review?: DomElement | null;
  /** The steering composer. Omitted ⇒ {@link AGENT_COMMENT_ID}; absent ⇒ no composer. */
  comment?: DomElement | null;
  /** The pages rail's list — stamped with activity attributes, never rewritten. */
  railList?: DomElement | null;
}

export interface LivenessOptions {
  env: CanvasEnv;
  hosts: LivenessHosts;
  /** Post a client message (the app stamps the view token). */
  send(body: CanvasClientBody): void;
  /** Current board transform, for the screen-space chrome. */
  transform?: () => BoardTransform;
  /** Artboard geometry, for cursor and error-card placement. */
  pageGeometry?: (pageId: string) => PageGeometry | null;
  /** Element rects in PAGE coordinates, as reported by a live frame. */
  rectsFor?: (pageId: string) => ReadonlyMap<Mid, Rect>;
  /**
   * Page docs, for the staged before/after previews.
   *
   * `title` is optional and additive: a caller that supplies it gets artboards
   * named in the status line and the review rows; one that does not gets
   * positional names derived from this same array, never a raw page id.
   */
  pages?: () => ReadonlyArray<{ id: string; doc: DocNode; title?: string }>;
  /** Where an accepted speculative patch goes (the board's `applyPlan`). */
  applySpeculative?: (patch: SpeculativePatch) => void;
  previewOptions?: PreviewOptions;
  /**
   * The artifact's theme, for the review queue's Before/After panes.
   *
   * `preview.ts` emits every colour, border, radius and shadow as
   * `var(--theme-*)`, and those custom properties live on whatever element
   * mounts the preview - which for a pane in the rail has no `.artboard`
   * ancestor to inherit them from. Without them the panes fell back to the
   * renderer's neutral last resort, so a staged `el.setStyle` that swaps one
   * theme token for another rendered two IDENTICAL pictures and the human
   * pressed Accept or Reject on a difference they could not see. Absent, the
   * panes still render - in the fallback palette, honestly degraded.
   */
  theme?: () => DesignTheme | null;
  /**
   * The board's current click target, for the steering composer.
   *
   * Absent ⇒ the composer targets a whole artboard chosen in its own picker,
   * which is the honest degradation: a comment still reaches the run, it is
   * just page-scoped rather than element-scoped.
   */
  commentTarget?: () => { pageId: string; mid?: Mid; label?: string } | null;
  /** Scroll/zoom the board to a target. Absent ⇒ the review rows draw no "Show". */
  revealTarget?: (pageId: string, mid?: Mid) => void;
  /**
   * Make the pane holding the review queue visible.
   *
   * `CanvasApp` owns pane state (`BoardController.setPaneVisible` is the
   * authority, and the stylesheet's switch pair depends on the layout mode), so
   * it should supply this. Absent ⇒ the layer flips the shell's own rail
   * switches, which is what a human clicking "Show the pages panel" does — less
   * precise, but strictly better than a button that names a queue it cannot
   * reveal.
   */
  revealReview?: () => void;
  /**
   * `(prefers-reduced-motion: reduce)`.
   *
   * Read once per draw rather than at construction, because a VS Code webview
   * survives an OS accessibility setting changing under it.
   */
  reducedMotion?: () => boolean;
}

export interface AgentCursorMessage {
  pageId: string;
  mid?: Mid;
  label: string;
}

const IDENTITY: BoardTransform = { zoom: 1, pan: { x: 0, y: 0 } };

/**
 * Placement and wiring for every liveness surface. All decisions above; this
 * only paints.
 */
export class LivenessLayer {
  private readonly _env: CanvasEnv;
  private readonly _hosts: LivenessHosts;
  private readonly _send: (body: CanvasClientBody) => void;
  private readonly _transform: () => BoardTransform;
  private readonly _pageGeometry: (pageId: string) => PageGeometry | null;
  private readonly _rectsFor: (pageId: string) => ReadonlyMap<Mid, Rect>;
  private readonly _pages: () => ReadonlyArray<{ id: string; doc: DocNode; title?: string }>;
  private readonly _applySpeculative: ((patch: SpeculativePatch) => void) | undefined;
  private readonly _previewOptions: PreviewOptions | undefined;
  private readonly _theme: (() => DesignTheme | null) | undefined;
  private readonly _commentTarget: (() => { pageId: string; mid?: Mid; label?: string } | null) | undefined;
  private readonly _revealTarget: ((pageId: string, mid?: Mid) => void) | undefined;
  private readonly _revealReview: (() => void) | undefined;
  private readonly _reducedMotion: () => boolean;

  private _jobs: ReadonlyMap<string, LiveJob> = new Map();
  private readonly _ghosts = new Map<string, DomElement>();
  private readonly _specSeq = new Map<string, number>();
  private readonly _writing = new Set<string>();
  private _cursor: { message: AgentCursorMessage; el: DomElement } | null = null;
  private readonly _errors = new Map<string, { pageId: string; mid?: Mid; message: string; el: DomElement }>();
  private _staged: StagedEntry[] = [];
  private _disposed = false;

  /* --- the watch-and-steer surfaces --- */

  /** Wall-clock start per job, so elapsed advances between 2 s heartbeats. */
  private readonly _jobStartedAt = new Map<string, number>();
  private _binding: AgentBinding | null = null;
  private _caps: readonly CapChip[] | null = null;
  private _approvalMode: 'auto' | 'staged' | null = null;
  private _lastActivityAt: number | null = null;
  private _reviewOpen = true;
  private _outbox: OutboxEntry[] = [];
  private _outboxSeq = 0;
  private _statusEls: StatusElements | null = null;
  private _commentInput: DomValueElement | null = null;
  private _commentPicker: DomValueElement | null = null;
  private _outboxHost: DomElement | null = null;
  private readonly _flashes = new Map<string, { pageId: string; mid?: Mid; el: DomElement; timer: unknown }>();
  private _tickHandle: unknown = null;
  private _idleTicks = 0;
  /** Status parts this layer created (as opposed to adopted from the shell). */
  private _createdStatusEls: DomElement[] = [];
  /** The generated activity stylesheet, created on first stamp. */
  private _activityStyle: DomElement | null = null;
  private _activityStyleText = '';
  /** Last string written to the polite live region — a redraw must be silent. */
  private _announced = '';
  /** One-shot transition sentence, consumed by the next render. */
  private _pendingTerminal: string | null = null;
  /** A host-pushed notice (`op_error`) and when it expires. */
  private _notice: string | null = null;
  private _noticeUntil = 0;
  /** What the host says about steering delivery. `null` ⇒ it did not say. */
  private _steeringReachable: boolean | null = null;
  /** True when the composer lives in a container we appended to someone else's pane. */
  private _commentBorrowed = false;
  /** An element target chosen elsewhere (inspector / board click). */
  private _pendingTarget: { pageId: string; mid?: Mid; label?: string } | null = null;

  constructor(opts: LivenessOptions) {
    this._env = opts.env;
    // Copied: the layer resolves its own optional hosts below, and doing that
    // through the caller's object would mutate a value it still owns.
    this._hosts = { ...opts.hosts };
    this._send = opts.send;
    this._transform = opts.transform ?? (() => IDENTITY);
    this._pageGeometry = opts.pageGeometry ?? (() => null);
    this._rectsFor = opts.rectsFor ?? (() => new Map<Mid, Rect>());
    this._pages = opts.pages ?? (() => []);
    this._applySpeculative = opts.applySpeculative;
    this._previewOptions = opts.previewOptions;
    this._theme = opts.theme;
    this._commentTarget = opts.commentTarget;
    this._revealTarget = opts.revealTarget;
    this._revealReview = opts.revealReview;
    this._reducedMotion = opts.reducedMotion ?? defaultReducedMotion;
    // Resolved, not required: the status bar, the review queue and the steering
    // composer are how a person answers "is Mysti working, on what, for how
    // long, and how do I stop it", and that must not hinge on a caller
    // remembering to pass three more hosts.
    this._hosts.status = opts.hosts.status ?? this._env.doc.getElementById(AGENT_STATUS_ID);
    this._hosts.review = opts.hosts.review
      ?? this._env.doc.getElementById(REVIEW_QUEUE_ID)
      ?? opts.hosts.rail;
    const dedicatedComment = opts.hosts.comment ?? this._env.doc.getElementById(AGENT_COMMENT_ID);
    // A borrowed pane keeps everything it already had: the composer becomes one
    // more child of it, never a replacement for its contents.
    this._hosts.comment = dedicatedComment
      ?? borrowedChild(this._env, this._env.doc.getElementById(AGENT_COMMENT_FALLBACK_ID));
    this._commentBorrowed = !dedicatedComment && !!this._hosts.comment;
    this._hosts.railList = opts.hosts.railList ?? this._env.doc.getElementById(RAIL_LIST_ID);
    this._buildComment();
    this._drawRail();
    this._drawStatus();
  }

  /** Live jobs, keyed by id. Read by the tests and by the chrome. */
  get jobs(): ReadonlyMap<string, LiveJob> { return this._jobs; }
  /** Staged suggestions currently in the rail. */
  get stagedCount(): number { return this._staged.length; }
  /** Ghost elements currently on the board. */
  get ghostCount(): number { return this._ghosts.size; }
  /** Error cards currently on the board. */
  get errorCount(): number { return this._errors.size; }

  /* --------------------------------- jobs --------------------------------- */

  onJob(event: CanvasJobEvent): void {
    if (this._disposed || !event) { return; }
    if (event.type === 'op_staged') {
      const entry = readStagedRecord(event.op);
      if (entry) { this._addStaged([entry]); }
      this._noteActivity();
      this._drawStatus();
      return;
    }
    // `op_applied` is the ONLY signal that says which cell just changed, and it
    // already reaches this method (`CanvasBridge.pushJob` posts every event).
    // So "show me what changed" needs no new wire and no new host callback —
    // the board silently differing under a human's eyes was never a missing
    // feature, it was an unread event.
    if (event.type === 'op_applied' || event.type === 'page_updated') {
      this._noteApplied(event);
      this._noteActivity();
      this._drawStatus();
      this._stampRail();
      return;
    }
    // `op_error` is the host saying an edit (or a steering note) did NOT land.
    // It reached this method and was dropped on the floor — which is how a
    // refused fenced op, and a comment queued for a lane that never drains,
    // both ended as silence. It is a notice, not a job, so it does not touch
    // the job map: it shows on the status line and is announced once.
    if (event.type === 'op_error') {
      this._setNotice(typeof event.error === 'string' ? event.error : '');
      this._drawStatus();
      return;
    }
    // A job ENDING is a transition a screen reader has to hear, and "finished",
    // "failed" and "was cancelled" are three different outcomes the job map
    // cannot distinguish after the fact — it just loses the entry.
    if (event.type === 'done' || event.type === 'error') {
      const ending = this._jobs.get(event.jobId);
      if (ending) { this._pendingTerminal = terminalAnnouncement(event, ending.label); }
    }
    const patch = readSpeculative(event);
    if (patch) { this._speculative(patch); }
    const before = this._jobs;
    this._jobs = applyJobEvent(this._jobs, event);
    this._trackJobClock(before, this._jobs);
    if (this._jobs.size > 0) { this._noteActivity(); }
    this._drawGhosts();
    this._drawStatus();
    this._stampRail();
  }

  /**
   * `canvas/staged` — the host's COMPLETE current staged set, as a snapshot.
   *
   * Not a merge. The host computes the whole set and pushes it whenever it
   * changes (and once per baseline, so a `hello`/`resync` can clear the rail),
   * which means an op that left the set — accepted elsewhere, rejected,
   * superseded, flushed by a lock release, restored over — is expressed by its
   * ABSENCE. Folding batches in additively left those cards live forever, and
   * clicking Accept/Reject on one then asked the host to decide an op that was
   * already resolved. An empty batch therefore clears the rail; it does not
   * mean "nothing to say".
   */
  onStaged(records: readonly unknown[]): void {
    if (this._disposed || !Array.isArray(records)) { return; }
    const entries: StagedEntry[] = [];
    for (const record of records) {
      const entry = readStagedRecord(record);
      if (entry) { entries.push(entry); }
    }
    this._staged = entries;
    this._drawRail();
    this._drawStatus();
    this._stampRail();
  }

  private _speculative(patch: SpeculativePatch): void {
    if (!acceptSpeculative(this._specSeq.get(patch.pageId), patch)) { return; }
    this._specSeq.set(patch.pageId, patch.seq);
    this._applySpeculative?.(patch);
    // A sealed patch retires the "writing" treatment for that artboard: the
    // top-level structure stopped moving, so what is on screen is layout the
    // human can trust rather than a half-arrived tree (risk 4).
    this._markWriting(patch.pageId, !patch.sealed);
  }

  /** Board-transform change: only the screen-space chrome needs redrawing. */
  setTransform(): void {
    this._drawCursor();
    this._drawErrors();
    this._drawFlashes();
  }

  /** Redraw everything (an artifact update moved artboards). */
  refresh(): void {
    this._drawGhosts();
    this._drawCursor();
    this._drawErrors();
    this._drawFlashes();
    this._drawRail();
    this._drawStatus();
    this._drawComment();
    this._stampRail();
  }

  /**
   * One tick of the status clock. Public so a test drives elapsed time without
   * a real timer, and so the layer can be ticked by a host that owns its own
   * animation frame.
   */
  tick(): void {
    if (this._disposed) { return; }
    // A live notice counts as "busy" for the clock's purposes: it expires on a
    // timer, and a stopped ticker would leave it on screen forever.
    const working = this._jobs.size > 0 || this._noticeLive();
    this._idleTicks = working ? 0 : this._idleTicks + 1;
    this._renderStatus();
    this._drawOutbox();
    if (!working && this._idleTicks > STATUS_IDLE_TICKS) { this._stopTicker(); }
  }

  /* ------------------------- connection & approval truth ------------------------- */

  /**
   * Which agent is bound to this canvas, as the HOST sees it.
   *
   * `null` is "not reported" and renders as neither connected nor disconnected.
   * The view cannot derive this: it never learns which provider the chat panel
   * is on, and a webview that guesses would be confidently wrong exactly when a
   * person is trying to work out why nothing is happening.
   */
  setBinding(binding: AgentBinding | null): void {
    this._binding = binding && typeof binding.agent === 'string' ? binding : null;
    this._drawStatus();
  }

  /** The capability chips, so the status line can name what is NOT connected. */
  setCaps(caps: readonly CapChip[] | null): void {
    this._caps = Array.isArray(caps) ? caps : null;
    this._drawStatus();
  }

  /**
   * `WireArtifact.approvalMode`.
   *
   * Under the SHIPPED defaults (`mode: ask-before-edit`, `accessLevel:
   * ask-permission`) `resolveCanvasApproval` returns `staged`, so the review
   * queue is the default experience rather than an edge case — which is why an
   * empty queue in `staged` mode says so instead of hiding.
   */
  setApprovalMode(mode: 'auto' | 'staged' | null): void {
    this._approvalMode = mode === 'auto' || mode === 'staged' ? mode : null;
    this._drawRail();
    this._drawStatus();
  }

  /** The status as data. The renderer's only source, and the tests'. */
  status(): AgentStatusModel {
    return agentStatusModel({
      jobs: this._jobs,
      stagedCount: this._staged.length,
      binding: this._binding,
      caps: this._caps,
      approvalMode: this._approvalMode,
      pageLabel: pageId => this._pageLabel(pageId),
      now: this._env.now(),
      startedAt: this._jobStartedAt,
      lastActivityAt: this._lastActivityAt,
    });
  }

  /** Whether the review queue is expanded. Progressive disclosure, remembered. */
  get reviewOpen(): boolean { return this._reviewOpen; }

  /**
   * @param reveal Also make the pane holding the queue visible.
   *
   * The top-bar button passes `true`, because it lives OUTSIDE the pane the
   * queue is rendered into: expanding a subtree inside a `display:none` aside
   * is a state change with nothing observable behind it, and the button was
   * simultaneously announcing `aria-expanded="true"`. The in-rail toggle passes
   * nothing — that pane is on screen by definition.
   */
  setReviewOpen(open: boolean, reveal = false): void {
    this._reviewOpen = !!open;
    if (this._reviewOpen && reveal) { this._revealReviewPane(); }
    this._drawRail();
  }

  /**
   * What the host says about whether a steering note can reach a model.
   *
   * `null` is "not reported" and keeps the honest-but-general wording. `false`
   * is the host stating that nothing on this lane drains the queue, and it is
   * the only thing that lets the outbox stop calling an undeliverable note
   * "Queued".
   */
  setSteeringReachable(reachable: boolean | null): void {
    this._steeringReachable = reachable === true || reachable === false ? reachable : null;
    this._drawOutbox();
  }

  /** Comments sent from this view, newest last. */
  get outbox(): readonly OutboxEntry[] { return this._outbox; }

  /** The live host notice, or `null`. Test seam and render source. */
  notice(): string | null {
    return this._noticeLive() ? this._notice : null;
  }

  private _noticeLive(): boolean {
    return this._notice !== null && this._env.now() < this._noticeUntil;
  }

  private _setNotice(text: string): void {
    const clean = clampText(text, 200);
    if (!clean) { return; }
    this._notice = clean;
    this._noticeUntil = this._env.now() + STATUS_NOTICE_MS;
    this._pendingTerminal = clean;
  }

  /**
   * Reveal the pane the review queue lives in.
   *
   * The wired callback is authoritative (`CanvasApp` owns pane state and the
   * layout mode decides WHICH switch is live). The fallback flips both rail
   * switches, which reveals the rail whether it is docked or an overlay:
   * `#rail-hidden` unchecked restores `--rail-dock-display`, and `#rail-shown`
   * checked resolves `--rail-over-display` at narrow widths and falls back to
   * the docked display at wide ones.
   */
  private _revealReviewPane(): void {
    if (this._revealReview) { this._revealReview(); return; }
    const doc = this._env.doc;
    const set = (id: string, checked: boolean): void => {
      const node = doc.getElementById(id) as
        (DomElement & { checked?: boolean; dispatchEvent?: (ev: unknown) => boolean }) | null;
      if (!node || node.checked === checked) { return; }
      // `checked` is a live property, not an attribute: `setAttribute` would
      // write `defaultChecked` and leave the rendered control alone.
      node.checked = checked;
      // …and the switch alone is not enough. `CanvasApp` owns a SECOND
      // authority — the `rail-collapsed` class on `#app`, which also sets
      // `--rail-dock-display: none` — and it only learns about a flip from the
      // `change` event a human's click on the shell's `<label for=…>` fires.
      // Without this the pane stays `display:none` and the button is still
      // announcing a reveal that did not happen.
      const Ctor = (globalThis as {
        Event?: new (type: string, opts?: { bubbles?: boolean }) => unknown;
      }).Event;
      if (typeof node.dispatchEvent === 'function' && typeof Ctor === 'function') {
        node.dispatchEvent(new Ctor('change', { bubbles: true }));
      }
    };
    set(REVIEW_HIDE_SWITCH_ID, false);
    set(REVIEW_SHOW_SWITCH_ID, true);
  }

  /**
   * Point the steering composer at one element (the board's selection).
   *
   * Exposed so the inspector's "Ask Mysti about this element" and a board
   * click land in the SAME composer rather than each growing their own.
   */
  focusComment(pageId: string, mid?: Mid, label?: string): void {
    if (this._disposed || typeof pageId !== 'string' || !pageId) { return; }
    this._pendingTarget = { pageId, ...(mid ? { mid } : {}), ...(label ? { label } : {}) };
    this._drawComment();
  }

  dispose(): void {
    this._disposed = true;
    this._stopTicker();
    for (const el of this._ghosts.values()) { el.remove(); }
    this._ghosts.clear();
    this._cursor?.el.remove();
    this._cursor = null;
    for (const entry of this._errors.values()) { entry.el.remove(); }
    this._errors.clear();
    for (const flash of this._flashes.values()) {
      clearTimer(flash.timer);
      flash.el.remove();
    }
    this._flashes.clear();
    this._staged = [];
    this._hosts.rail?.replaceChildren();
    this._hosts.review?.replaceChildren();
    // The status bar is the SHELL's element with the shell's own children
    // inside it: tear down only what this layer added, and blank what it
    // adopted. `replaceChildren` here would leave the stylesheet pointing at
    // elements that no longer exist.
    for (const el of this._createdStatusEls) { el.remove(); }
    this._createdStatusEls = [];
    if (this._statusEls) {
      this._statusEls.label.textContent = '';
      this._statusEls.label.hidden = true;
      this._statusEls.elapsed.textContent = '';
      this._statusEls.elapsed.hidden = true;
      this._statusEls.cancel.hidden = true;
    }
    if (this._commentBorrowed) { this._hosts.comment?.remove(); }
    else { this._hosts.comment?.replaceChildren(); }
    this._statusEls = null;
    this._commentInput = null;
    this._commentPicker = null;
    this._outboxHost = null;
    this._outbox = [];
    this._jobs = new Map();
    this._jobStartedAt.clear();
    this._specSeq.clear();
    this._writing.clear();
    this._notice = null;
    this._pendingTerminal = null;
    this._announced = '';
    this._hosts.world?.removeAttribute('data-writing');
    const railList = this._hosts.railList;
    if (railList) {
      for (const attr of RAIL_ACTIVITY_ATTRS) { railList.removeAttribute(attr); }
    }
    this._activityStyle?.remove();
    this._activityStyle = null;
    this._activityStyleText = '';
  }

  /* -------------------------------- ghosts -------------------------------- */

  private _drawGhosts(): void {
    const world = this._hosts.world;
    if (!world) { return; }
    for (const [jobId, el] of [...this._ghosts]) {
      if (!this._jobs.has(jobId)) { el.remove(); this._ghosts.delete(jobId); }
    }
    let index = 0;
    for (const job of this._jobs.values()) {
      // A job with no position rides beside whatever came before it, so two
      // concurrent generations do not stack into one illegible rectangle.
      const fallback: BoardPos = { x: index * (GHOST_DEFAULT_SIZE.w + 64), y: -(GHOST_DEFAULT_SIZE.h + 96) };
      const rect = ghostWorldRect(job, this._pageForJob(job) ?? fallback);
      let el = this._ghosts.get(job.jobId);
      if (!el) {
        el = this._buildGhost(job);
        this._ghosts.set(job.jobId, el);
        world.appendChild(el);
      }
      el.style.setProperty('left', `${Math.round(rect.x)}px`);
      el.style.setProperty('top', `${Math.round(rect.y)}px`);
      el.style.setProperty('width', `${Math.round(rect.w)}px`);
      el.style.setProperty('height', `${Math.round(rect.h)}px`);
      this._updateGhostText(el, job);
      index++;
    }
  }

  private _pageForJob(job: LiveJob): BoardPos | null {
    if (!job.pageId) { return null; }
    return this._pageGeometry(job.pageId)?.boardPos ?? null;
  }

  private _buildGhost(job: LiveJob): DomElement {
    const doc = this._env.doc;
    const root = doc.createElement('div');
    root.className = GHOST_CLASS;
    root.setAttribute('data-job-id', job.jobId);

    const shimmer = doc.createElement('div');
    shimmer.className = 'ghost-shimmer';
    root.appendChild(shimmer);

    const meta = doc.createElement('div');
    meta.className = 'ghost-meta';
    const label = doc.createElement('span');
    label.className = 'ghost-label';
    meta.appendChild(label);
    const elapsed = doc.createElement('span');
    elapsed.className = 'ghost-elapsed';
    meta.appendChild(elapsed);
    const cancel = doc.createElement('button');
    cancel.className = 'ghost-cancel';
    cancel.textContent = 'Cancel';
    cancel.setAttribute('type', 'button');
    cancel.addEventListener('click', () => this._send(cancelJobBody(job.jobId)));
    meta.appendChild(cancel);
    root.appendChild(meta);
    return root;
  }

  private _updateGhostText(el: DomElement, job: LiveJob): void {
    for (const child of childrenOf(el)) {
      if (child.className === 'ghost-meta') {
        for (const leaf of childrenOf(child)) {
          if (leaf.className === 'ghost-label') { leaf.textContent = clampText(job.label, 60); }
          if (leaf.className === 'ghost-elapsed') { leaf.textContent = formatElapsed(job.elapsedSeconds); }
        }
      }
    }
  }

  /**
   * Flag an artboard as still being written (Tier 2's "writing" treatment).
   *
   * The flag rides the WORLD host as a space-separated id list, so a stylesheet
   * targets `[data-writing~="p1"] .artboard[data-page-id="p1"]` and this module
   * never reaches into board-owned DOM. Concurrent streams therefore do not
   * clobber each other's treatment, which a single-id attribute would.
   */
  private _markWriting(pageId: string, writing: boolean): void {
    const world = this._hosts.world;
    if (!world) { return; }
    if (writing) { this._writing.add(pageId); } else { this._writing.delete(pageId); }
    if (this._writing.size === 0) { world.removeAttribute('data-writing'); }
    else { world.setAttribute('data-writing', [...this._writing].join(' ')); }
    this._stampRail();
  }

  /** Artboards currently under the "writing" treatment. */
  writingPages(): string[] { return [...this._writing]; }

  /* -------------------------------- cursor -------------------------------- */

  onAgentCursor(message: AgentCursorMessage): void {
    if (this._disposed || !message || typeof message.pageId !== 'string') { return; }
    // An empty label retracts the cursor — the host's `clearCursor`.
    if (!message.label) {
      this._cursor?.el.remove();
      this._cursor = null;
      this._stampRail();
      return;
    }
    const host = this._hosts.overlay;
    if (!host) { return; }
    if (!this._cursor) {
      const el = this._env.doc.createElement('div');
      el.className = CURSOR_CLASS;
      const label = this._env.doc.createElement('span');
      label.className = 'agent-cursor-label';
      el.appendChild(label);
      host.appendChild(el);
      this._cursor = { message, el };
    } else {
      this._cursor = { message, el: this._cursor.el };
    }
    this._drawCursor();
    this._stampRail();
  }

  private _drawCursor(): void {
    const cursor = this._cursor;
    if (!cursor) { return; }
    const rect = this.cursorRect(cursor.message);
    if (!rect) { cursor.el.hidden = true; return; }
    cursor.el.hidden = false;
    cursor.el.setAttribute('data-page-id', cursor.message.pageId);
    if (cursor.message.mid) { cursor.el.setAttribute('data-mid', cursor.message.mid); }
    else { cursor.el.removeAttribute('data-mid'); }
    place(cursor.el, rect);
    for (const child of childrenOf(cursor.el)) {
      if (child.className === 'agent-cursor-label') { child.textContent = clampText(cursor.message.label, 48); }
    }
  }

  /**
   * Screen rect for the agent cursor.
   *
   * The element's own rect when a live frame has reported one; otherwise the
   * whole artboard, because a preview tile reports no geometry and "somewhere
   * on this artboard" is strictly more honest than nothing.
   */
  cursorRect(message: AgentCursorMessage): Rect | null {
    return this._targetRect(message.pageId, message.mid);
  }

  /**
   * Screen rect for one (page, mid) target — the cursor and the change
   * highlights draw through the SAME function, so they can never disagree about
   * where an element is.
   */
  private _targetRect(pageId: string, mid?: Mid): Rect | null {
    const geometry = this._pageGeometry(pageId);
    if (!geometry) { return null; }
    const transform = this._transform();
    if (mid) {
      const rect = this._rectsFor(pageId).get(mid);
      if (rect) { return elementScreenRect(rect, geometry.boardPos, transform); }
    }
    return rectToScreen(
      { x: geometry.boardPos.x, y: geometry.boardPos.y, w: geometry.size.w, h: geometry.size.h },
      transform,
    );
  }

  /* ------------------------------ error cards ------------------------------ */

  /**
   * The harness error boundary fired. One card per (page, mid) — a page that
   * throws on every render must not stack a thousand cards.
   */
  onFrameError(pageId: string, message: string, mid?: Mid): void {
    if (this._disposed || typeof pageId !== 'string' || !pageId) { return; }
    const host = this._hosts.overlay;
    if (!host) { return; }
    const key = `${pageId}::${mid ?? ''}`;
    const clean = clampText(message, ERROR_MESSAGE_MAX);
    const existing = this._errors.get(key);
    if (existing) {
      existing.message = clean;
      this._fillErrorCard(existing.el, pageId, clean, mid);
      this._drawErrors();
      return;
    }
    const el = this._env.doc.createElement('div');
    el.className = ERROR_CARD_CLASS;
    host.appendChild(el);
    this._errors.set(key, { pageId, message: clean, el, ...(mid ? { mid } : {}) });
    this._fillErrorCard(el, pageId, clean, mid, key);
    this._drawErrors();
  }

  private _fillErrorCard(el: DomElement, pageId: string, message: string, mid?: Mid, key?: string): void {
    const doc = this._env.doc;
    el.replaceChildren();
    el.setAttribute('data-page-id', pageId);
    if (mid) { el.setAttribute('data-mid', mid); }

    const title = doc.createElement('div');
    title.className = 'fec-title';
    title.textContent = 'This artboard failed to render';
    el.appendChild(title);

    const body = doc.createElement('div');
    body.className = 'fec-message';
    // `textContent` only — the message is produced by model-authored code.
    body.textContent = message;
    el.appendChild(body);

    const actions = doc.createElement('div');
    actions.className = 'fec-actions';
    const fix = doc.createElement('button');
    fix.className = 'fec-fix';
    fix.setAttribute('type', 'button');
    fix.textContent = 'Fix with AI';
    fix.addEventListener('click', () => {
      this._send(fixWithAiBody(pageId, message, mid));
      this._dismissError(key ?? `${pageId}::${mid ?? ''}`);
    });
    actions.appendChild(fix);
    const dismiss = doc.createElement('button');
    dismiss.className = 'fec-dismiss';
    dismiss.setAttribute('type', 'button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => this._dismissError(key ?? `${pageId}::${mid ?? ''}`));
    actions.appendChild(dismiss);
    el.appendChild(actions);
  }

  private _dismissError(key: string): void {
    const entry = this._errors.get(key);
    if (!entry) { return; }
    entry.el.remove();
    this._errors.delete(key);
  }

  private _drawErrors(): void {
    for (const entry of this._errors.values()) {
      const geometry = this._pageGeometry(entry.pageId);
      if (!geometry) { entry.el.hidden = true; continue; }
      entry.el.hidden = false;
      const rect = rectToScreen(
        { x: geometry.boardPos.x, y: geometry.boardPos.y, w: geometry.size.w, h: geometry.size.h },
        this._transform(),
      );
      entry.el.style.setProperty('left', `${Math.round(rect.x)}px`);
      entry.el.style.setProperty('top', `${Math.round(rect.y)}px`);
    }
  }

  /* --------------------------------- rail --------------------------------- */

  /**
   * The INCREMENTAL path — `canvas/job` `op_staged` only.
   *
   * A job event announces one new proposal and says nothing about the rest, so
   * merging is correct here and only here; {@link onStaged} owns the set.
   */
  private _addStaged(entries: readonly StagedEntry[]): void {
    if (entries.length === 0) { return; }
    for (const entry of entries) {
      const at = this._staged.findIndex(e => e.opId === entry.opId);
      if (at >= 0) { this._staged[at] = entry; } else { this._staged.push(entry); }
    }
    this._drawRail();
  }

  /** A decision was taken (locally or by the host): drop those rows. */
  clearStaged(opIds: readonly string[]): void {
    const drop = new Set(opIds);
    this._staged = this._staged.filter(e => !drop.has(e.opId));
    this._drawRail();
  }

  private _decide(opIds: readonly string[], accept: boolean): void {
    if (opIds.length === 0) { return; }
    this._send(decideBody(opIds, accept));
    this.clearStaged(opIds);
    this._drawStatus();
    this._stampRail();
  }

  /**
   * The review queue.
   *
   * Under the SHIPPED defaults this is not an edge case: `mysti.defaultMode`
   * ships as `ask-before-edit` and `mysti.accessLevel` as `ask-permission`, and
   * `resolveCanvasApproval` maps either of those to `staged` — so every agent
   * edit lands HERE first. That is why it is a real review surface (bulk +
   * per-op decisions, before/after, a route back to the artboard, an honest
   * empty state) rather than a list of titles tucked under the pages rail.
   *
   * A full rebuild per change is deliberate: the set is host-authoritative and
   * small, and rebuilding removes the whole "a row survived its op" class of
   * bug. The collapse state is view state and survives the rebuild.
   */
  private _drawRail(): void {
    const host = this._hosts.review ?? this._hosts.rail;
    if (!host) { return; }
    host.replaceChildren();
    // Additive: a shell that gave the queue its own class keeps it. Only the
    // CONTENTS of this element are owned here.
    if (!host.className.split(/\s+/).includes(STAGED_RAIL_CLASS)) {
      host.className = host.className ? `${host.className} ${STAGED_RAIL_CLASS}` : STAGED_RAIL_CLASS;
    }
    host.setAttribute('data-count', String(this._staged.length));
    host.setAttribute('aria-label', 'Suggestions from Mysti');

    if (this._staged.length === 0) {
      // `staged` is the default approval mode, so an empty queue is a *state*
      // worth naming — hiding it entirely is what made a whole tool family look
      // like it silently did nothing.
      const explain = this._approvalMode === 'staged';
      host.hidden = !explain;
      host.setAttribute('data-open', 'false');
      if (explain) {
        const empty = this._env.doc.createElement('div');
        empty.className = 'staged-empty';
        empty.textContent = 'No suggestions yet. Mysti\u2019s edits arrive here for you to accept or reject.';
        host.appendChild(empty);
      }
      return;
    }

    host.hidden = false;
    host.setAttribute('data-open', this._reviewOpen ? 'true' : 'false');
    const doc = this._env.doc;
    const rows = stagedRows(this._staged, this._pages(), this._previewOptions ? { preview: this._previewOptions } : {});
    const allIds = rows.map(r => r.opId);

    const head = doc.createElement('div');
    head.className = 'staged-head';
    const toggle = this._button(
      'staged-toggle',
      `${rows.length} suggestion${rows.length === 1 ? '' : 's'}`,
      () => this.setReviewOpen(!this._reviewOpen),
    );
    toggle.setAttribute('aria-expanded', this._reviewOpen ? 'true' : 'false');
    toggle.setAttribute(
      'aria-label',
      `${this._reviewOpen ? 'Collapse' : 'Expand'} ${rows.length} pending ${rows.length === 1 ? 'suggestion' : 'suggestions'}`,
    );
    head.appendChild(toggle);
    const count = doc.createElement('span');
    count.className = 'staged-count';
    count.textContent = String(rows.length);
    count.setAttribute('aria-hidden', 'true');
    head.appendChild(count);
    const acceptAll = this._button('staged-accept-all', 'Accept all', () => this._decide(allIds, true));
    acceptAll.setAttribute('aria-label', `Accept all ${rows.length} suggestions`);
    head.appendChild(acceptAll);
    const rejectAll = this._button('staged-reject-all', 'Reject all', () => this._decide(allIds, false));
    rejectAll.setAttribute('aria-label', `Reject all ${rows.length} suggestions`);
    head.appendChild(rejectAll);
    host.appendChild(head);

    const list = doc.createElement('div');
    list.className = 'staged-list';
    list.setAttribute('role', 'list');
    // Collapsed hides the ROWS, never the header: the count and the bulk
    // actions are exactly what a collapsed queue still has to offer.
    list.hidden = !this._reviewOpen;
    host.appendChild(list);

    // Computed once per render, not once per pane: `themeCssVars` sanitizes
    // every token, and a queue of 20 suggestions would otherwise pay for that
    // 40 times.
    const theme = this._theme?.() ?? null;
    const themeVars = theme ? themeCssVars(theme) : null;

    for (const row of rows) {
      const el = doc.createElement('div');
      el.className = 'staged-row';
      el.setAttribute('role', 'listitem');
      el.setAttribute('data-op-id', row.opId);
      if (row.pageId) { el.setAttribute('data-page-id', row.pageId); }
      if (row.mid) { el.setAttribute('data-mid', row.mid); }

      const head2 = doc.createElement('div');
      head2.className = 'sr-head';
      const title = doc.createElement('div');
      title.className = 'sr-title';
      title.textContent = row.title;
      head2.appendChild(title);
      const where = row.pageId ? this._pageLabel(row.pageId) : null;
      if (where) {
        const label = doc.createElement('span');
        label.className = 'sr-where';
        label.textContent = where;
        head2.appendChild(label);
      }
      el.appendChild(head2);

      const previews = doc.createElement('div');
      previews.className = 'sr-previews';
      previews.appendChild(this._previewPane('sr-before', 'Before', row.before, themeVars));
      previews.appendChild(this._previewPane('sr-after', 'After', row.after, themeVars));
      el.appendChild(previews);

      if (row.error) {
        const err = doc.createElement('div');
        err.className = 'sr-error';
        err.textContent = clampText(row.error, 160);
        el.appendChild(err);
      }

      const actions = doc.createElement('div');
      actions.className = 'sr-actions';
      const reveal = this._revealTarget;
      if (reveal && row.pageId) {
        const pageId = row.pageId;
        const mid = row.mid ?? undefined;
        const show = this._button('sr-reveal', 'Show', () => reveal(pageId, mid));
        show.setAttribute('aria-label', `Show ${row.title} on the canvas`);
        actions.appendChild(show);
      }
      const accept = this._button('sr-accept', 'Accept', () => this._decide([row.opId], true));
      accept.setAttribute('aria-label', `Accept: ${row.title}`);
      actions.appendChild(accept);
      const reject = this._button('sr-reject', 'Reject', () => this._decide([row.opId], false));
      reject.setAttribute('aria-label', `Reject: ${row.title}`);
      actions.appendChild(reject);
      el.appendChild(actions);
      list.appendChild(el);
    }
  }

  private _previewPane(
    className: string,
    label: string,
    node: PreviewNode | null,
    themeVars: Record<string, string> | null,
  ): DomElement {
    const doc = this._env.doc;
    const pane = doc.createElement('div');
    pane.className = className;
    const caption = doc.createElement('div');
    caption.className = 'sr-caption';
    caption.textContent = label;
    pane.appendChild(caption);
    const body = doc.createElement('div');
    body.className = 'sr-preview';
    // The design's OWN theme, on the pane that draws the design. See
    // {@link LivenessOptions.theme}: an undefined `--theme-*` makes every
    // declaration referencing it invalid at computed-value time, which is how
    // a restyle rendered a Before and an After that were byte-identical.
    if (themeVars) {
      for (const [name, value] of Object.entries(themeVars)) { body.style.setProperty(name, value); }
    }
    if (node) { mountPreview(body, node, doc); }
    else { body.textContent = '—'; }
    pane.appendChild(body);
    return pane;
  }

  private _button(className: string, label: string, onClick: () => void): DomElement {
    const button = this._env.doc.createElement('button');
    button.className = className;
    button.setAttribute('type', 'button');
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  /** An icon-only control. The glyph is CSS's job; the NAME is not optional. */
  private _iconButton(className: string, ariaLabel: string, onClick: () => void): DomElement {
    const button = this._env.doc.createElement('button');
    button.className = className;
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', ariaLabel);
    button.setAttribute('title', ariaLabel);
    button.addEventListener('click', onClick);
    return button;
  }

  /* ------------------------------ status bar ------------------------------ */

  /**
   * Build the status bar ONCE and patch it thereafter.
   *
   * A rebuild-per-tick would blow away keyboard focus on Cancel every second —
   * i.e. the one control a person reaches for while the agent is running would
   * be unusable by keyboard exactly while it matters.
   */
  private _buildStatus(): StatusElements | null {
    const host = this._hosts.status;
    if (!host) { return null; }
    const doc = this._env.doc;
    // ADOPT, never replace. The shell already ships `#agent-activity`,
    // `#agent-elapsed` and `#btn-agent-cancel` inside `#agent-status` and
    // styles them; blowing those away would leave the stylesheet pointing at
    // elements that no longer exist and would silently orphan the toast
    // `CanvasApp._flash` still writes into. Anything the shell does NOT ship is
    // created and appended, so this works in a bare shell too.
    const existing = childrenOf(host);
    const byId = (id: string): DomElement | null => doc.getElementById(id);

    const dot = existing.find(c => c.className === AGENT_DOT_CLASS)
      ?? this._appendChild(host, 'span', AGENT_DOT_CLASS, { 'aria-hidden': 'true' });

    // OWNED, not adopted — see {@link STATUS_LABEL_ATTR}. It keeps the shell's
    // `agent-activity` class (the stylesheet hangs the pill chrome and the dot
    // off `.agent-status:has(> .agent-activity:not([hidden]))`, and the flex
    // order off the same class), so nothing in the CSS changes; what changes is
    // that `CanvasApp._flash` can no longer reach it.
    const label = this._appendChild(host, 'span', 'agent-activity', { [STATUS_LABEL_ATTR]: '1' });
    const elapsed = byId(AGENT_ELAPSED_ID) ?? this._appendChild(host, 'span', 'agent-elapsed');

    const detail = this._appendChild(host, 'span', 'agent-detail');
    const progress = this._appendChild(host, 'span', 'agent-progress', {
      role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
    });
    const fill = this._appendChild(progress, 'span', 'agent-progress-fill', { 'aria-hidden': 'true' });

    const review = this._appendChild(host, 'button', 'agent-review', { type: 'button' });
    // An ACTION, not a disclosure toggle. It lives outside the pane the queue
    // is rendered into, so it cannot honestly report that pane's state — and a
    // "collapse" from out here is indistinguishable from "nothing happened"
    // whenever the pane is off screen, which is the whole defect. Collapsing
    // stays with the in-rail `.staged-toggle`, which is visible when it applies.
    review.addEventListener('click', () => this.setReviewOpen(true, true));

    const cancel = byId(AGENT_CANCEL_ID) ?? this._appendChild(host, 'button', 'agent-cancel', { type: 'button' });
    // Reads the LIVE model at click time: a closure over the ids that existed
    // when the bar was built would cancel a job that already finished and miss
    // the one actually running.
    cancel.addEventListener('click', () => {
      for (const jobId of this.status().cancelJobIds) { this._send(cancelJobBody(jobId)); }
    });

    // THE live region is the small child below — never this host.
    //
    // `#agent-status` ships `role="status" aria-live="polite"` and wraps the
    // elapsed clock, the progressbar's `aria-valuenow`, the detail line and two
    // buttons whose labels change. With a 1 Hz ticker rewriting the clock, a
    // screen reader announced the run once per second for its whole duration
    // and the polite queue never drained. `aria-live="off"` here (which
    // overrides the implicit `polite` that `role="status"` would carry, and the
    // role is dropped as well so there is nothing left to imply it) makes every
    // ticking part silent, and the one sentence worth hearing is written into
    // the dedicated region exactly when it changes.
    host.removeAttribute('role');
    host.setAttribute('aria-live', 'off');
    for (const el of [elapsed, detail, progress]) { el.setAttribute('aria-live', 'off'); }
    const live = this._appendChild(host, 'span', 'sr-only', {
      [STATUS_LIVE_ATTR]: '1', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true',
    });
    if (!host.className) { host.className = AGENT_STATUS_CLASS; }

    return { host, dot, label, detail, elapsed, progress, fill, review, cancel, live };
  }

  private _appendChild(
    host: DomElement,
    tag: string,
    className: string,
    attrs: Record<string, string> = {},
  ): DomElement {
    const el = this._env.doc.createElement(tag);
    el.className = className;
    for (const [name, value] of Object.entries(attrs)) { el.setAttribute(name, value); }
    host.appendChild(el);
    this._createdStatusEls.push(el);
    return el;
  }

  /**
   * An EVENT happened: redraw and restart the clock's grace period.
   *
   * Split from {@link _renderStatus} so the clock's own ticks cannot keep
   * resetting the countdown they are supposed to be running down.
   */
  private _drawStatus(): void {
    if (this._disposed) { return; }
    this._idleTicks = 0;
    this._renderStatus();
    this._startTicker();
  }

  private _renderStatus(): void {
    if (this._disposed) { return; }
    if (!this._statusEls) { this._statusEls = this._buildStatus(); }
    const els = this._statusEls;
    if (!els) { return; }
    const model = this.status();

    els.host.setAttribute('data-state', model.state);
    // The dot carries the state too, so a stylesheet can colour/animate it
    // without a `:has()` on the label's hidden attribute — which no longer
    // toggles, because the status is persistent.
    els.dot.setAttribute('data-state', model.state);
    els.host.setAttribute('aria-busy', model.busy ? 'true' : 'false');
    els.host.setAttribute('data-motion', this._reducedMotion() ? 'reduced' : 'full');
    els.label.textContent = model.label;
    // Unhidden on every draw: the stylesheet hangs the pill and the dot off
    // `.agent-status:has(> .agent-activity:not([hidden]))`, and the status is
    // persistent by policy. Nothing else writes this element any more.
    els.label.hidden = false;
    // A host notice ("that edit did not land", "nothing reads canvas notes")
    // outranks the derived detail while it is live: it is the answer to the
    // question the person is asking at that moment.
    const notice = this._noticeLive() ? this._notice : null;
    if (!this._noticeLive()) { this._notice = null; }
    els.host.setAttribute('data-notice', notice ? 'true' : 'false');
    const detail = notice ?? model.detail;
    els.detail.textContent = detail;
    els.detail.hidden = detail.length === 0;
    els.elapsed.textContent = model.elapsed;
    els.elapsed.hidden = model.elapsed.length === 0;

    const pct = model.progress === null ? null : Math.round(Math.min(1, Math.max(0, model.progress)) * 100);
    els.progress.hidden = pct === null;
    if (pct === null) {
      els.progress.removeAttribute('aria-valuenow');
    } else {
      els.progress.setAttribute('aria-valuenow', String(pct));
      els.fill.style.setProperty('width', `${pct}%`);
    }

    els.review.hidden = model.stagedCount === 0;
    els.review.textContent = `${model.stagedCount} to review`;
    // No `aria-expanded`: see the click handler. It named a disclosure state it
    // could neither honour nor observe — announcing "expanded" while the queue
    // sat inside a `display:none` aside.
    els.review.removeAttribute('aria-expanded');
    els.review.setAttribute(
      'aria-label',
      `Review ${model.stagedCount} pending ${model.stagedCount === 1 ? 'suggestion' : 'suggestions'} from Mysti`,
    );

    els.cancel.hidden = model.cancelJobIds.length === 0;
    els.cancel.setAttribute(
      'aria-label',
      model.cancelJobIds.length > 1 ? `Stop Mysti (${model.cancelJobIds.length} running)` : 'Stop Mysti',
    );

    // The ONE announcement, written only when the sentence actually changes —
    // this method runs once a second while a job is live.
    const terminal = this._pendingTerminal;
    this._pendingTerminal = null;
    const sentence = statusAnnouncement(model, terminal);
    // A transition is announced even when the resulting sentence repeats (two
    // jobs ending back to back both read "… finished. Idle"); a plain redraw is
    // announced only when the words changed.
    if (terminal || sentence !== this._announced) {
      this._announced = sentence;
      els.live.textContent = sentence;
    }
  }

  /** Wall-clock start per job, kept out of {@link LiveJob} so `readGhost` stays pure. */
  private _trackJobClock(before: ReadonlyMap<string, LiveJob>, after: ReadonlyMap<string, LiveJob>): void {
    for (const jobId of after.keys()) {
      if (!this._jobStartedAt.has(jobId)) { this._jobStartedAt.set(jobId, this._env.now()); }
    }
    for (const jobId of before.keys()) {
      if (!after.has(jobId)) { this._jobStartedAt.delete(jobId); }
    }
  }

  private _noteActivity(): void { this._lastActivityAt = this._env.now(); }

  private _startTicker(): void {
    if (this._tickHandle !== null || this._disposed) { return; }
    const g = globalThis as { setInterval?: (cb: () => void, ms: number) => unknown };
    if (typeof g.setInterval !== 'function') { return; }
    const handle = g.setInterval(() => this.tick(), STATUS_TICK_MS);
    // Node's timer keeps a vitest process alive otherwise; a browser has no
    // `unref` and needs none.
    const maybe = handle as { unref?: () => void } | null;
    if (maybe && typeof maybe.unref === 'function') { maybe.unref(); }
    this._tickHandle = handle;
  }

  private _stopTicker(): void {
    if (this._tickHandle === null) { return; }
    const g = globalThis as { clearInterval?: (handle: unknown) => void };
    g.clearInterval?.(this._tickHandle);
    this._tickHandle = null;
  }

  /** Positional artboard name. Never a raw page id — that is an internal token. */
  private _pageLabel(pageId: string): string | null {
    const pages = this._pages();
    const index = pages.findIndex(p => p && p.id === pageId);
    if (index < 0) { return null; }
    const title = pages[index].title;
    return typeof title === 'string' && title.trim() ? clampText(title, 40) : `Artboard ${index + 1}`;
  }

  /* --------------------------- change highlights --------------------------- */

  /**
   * A just-applied op, drawn as a brief highlight on the node it touched.
   *
   * Screen-space, like the cursor and for the same reasons: it survives a frame
   * repaint and it works over a static preview tile. Bounded at
   * {@link CHANGE_FLASH_MAX} because a whole-page rewrite emits one event per
   * cell and 400 outlines is not "legible", it is a strobe.
   */
  private _noteApplied(event: CanvasJobEvent): void {
    // `CanvasJobEvent.op` is typed as the LEGACY op union; the V2 executor puts
    // a V2 op in the same slot. Read the field, not the era — the same trick
    // `readStagedRecord` uses, and the reason neither end needs a flag day.
    const raw: unknown = event.op;
    const op = raw && typeof raw === 'object' && isCanvasOpKind((raw as { op?: unknown }).op)
      ? raw as CanvasOp
      : null;
    const pageId = (op ? opPageId(op) : null) ?? (typeof event.pageId === 'string' ? event.pageId : null);
    if (!pageId) { return; }
    const mid = op ? opMid(op) : null;
    this._flash(pageId, mid ?? undefined);
  }

  private _flash(pageId: string, mid?: Mid): void {
    const host = this._hosts.overlay;
    if (!host) { return; }
    const key = `${pageId}::${mid ?? ''}`;
    const existing = this._flashes.get(key);
    if (existing) {
      clearTimer(existing.timer);
      existing.timer = this._scheduleFlashClear(key);
      this._drawFlashes();
      return;
    }
    if (this._flashes.size >= CHANGE_FLASH_MAX) {
      const oldest = this._flashes.keys().next();
      if (!oldest.done) { this._clearFlash(oldest.value); }
    }
    const el = this._env.doc.createElement('div');
    el.className = CHANGE_FLASH_CLASS;
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('data-page-id', pageId);
    el.setAttribute('data-motion', this._reducedMotion() ? 'reduced' : 'full');
    if (mid) { el.setAttribute('data-mid', mid); }
    host.appendChild(el);
    this._flashes.set(key, { pageId, el, timer: this._scheduleFlashClear(key), ...(mid ? { mid } : {}) });
    this._drawFlashes();
  }

  private _scheduleFlashClear(key: string): unknown {
    const g = globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown };
    if (typeof g.setTimeout !== 'function') { return null; }
    const handle = g.setTimeout(() => this._clearFlash(key), CHANGE_FLASH_MS);
    const maybe = handle as { unref?: () => void } | null;
    if (maybe && typeof maybe.unref === 'function') { maybe.unref(); }
    return handle;
  }

  private _clearFlash(key: string): void {
    const flash = this._flashes.get(key);
    if (!flash) { return; }
    clearTimer(flash.timer);
    flash.el.remove();
    this._flashes.delete(key);
  }

  /** Highlights currently on the board. Test seam. */
  get flashCount(): number { return this._flashes.size; }

  private _drawFlashes(): void {
    for (const flash of this._flashes.values()) {
      const rect = this._targetRect(flash.pageId, flash.mid);
      if (!rect) { flash.el.hidden = true; continue; }
      flash.el.hidden = false;
      place(flash.el, rect);
    }
  }

  /* ------------------------------ rail stamping ------------------------------ */

  /**
   * Per-artboard agent activity, written onto the rail's LIST as attributes.
   *
   * Deliberately attributes on a container rather than a call into
   * `RailController`: the rail re-renders from the store whenever the artifact
   * changes and would drop any class this module set on a row, whereas a
   * space-separated id list on the stable list element survives every rebuild
   * and lets one stylesheet rule light up the right rows
   * (`#rail-list[data-working~="p1"] .thumb[data-id="p1"]`). It is the same
   * mechanism {@link _markWriting} already uses on the world.
   */
  private _stampRail(): void {
    const working = new Set<string>();
    for (const job of this._jobs.values()) { if (job.pageId) { working.add(job.pageId); } }
    const staged = new Set<string>();
    for (const entry of this._staged) { if (entry.pageId) { staged.add(entry.pageId); } }
    const cursor = this._cursor?.message.pageId;
    const sets: ActivitySets = {
      working,
      staged,
      cursor: cursor ? new Set([cursor]) : new Set<string>(),
      writing: new Set(this._writing),
    };
    const host = this._hosts.railList;
    if (host) {
      stampIds(host, 'data-working', sets.working);
      stampIds(host, 'data-staged', sets.staged);
      stampIds(host, 'data-cursor', sets.cursor);
      stampIds(host, 'data-writing', sets.writing);
    }
    // The attributes are only half the mechanism; without this the whole
    // "which artboard is Mysti on" surface is computed and invisible.
    this._syncActivityStyle(sets);
  }

  /**
   * Keep the generated activity stylesheet equal to the current sets.
   *
   * One `<style>` node, rewritten only when the text actually changes, so a
   * per-second status tick does not re-parse CSS. It is appended to a host this
   * layer already owns rather than to `<head>` (the {@link CanvasEnv} DOM seam
   * exposes `getElementById` and nothing else); a `<style>` element applies
   * document-wide wherever it sits.
   */
  private _syncActivityStyle(sets: ActivitySets): void {
    const text = activityStyleText(sets);
    if (text === this._activityStyleText && (this._activityStyle || !text)) { return; }
    this._activityStyleText = text;
    if (!this._activityStyle) {
      const anchor = this._hosts.overlay ?? this._hosts.status ?? this._hosts.railList ?? this._hosts.world;
      if (!anchor) { return; }
      const el = this._env.doc.createElement('style');
      el.setAttribute('id', ACTIVITY_STYLE_ID);
      anchor.appendChild(el);
      this._activityStyle = el;
    }
    this._activityStyle.textContent = text;
  }

  /* --------------------------- steering composer --------------------------- */

  /**
   * "Tell Mysti what to change" — the loop back into the run.
   *
   * The text is human, arrives through a webview and therefore is DATA: it goes
   * out as `canvas/comment`, lands in the per-run inbox, and reaches a model
   * only inside `_fenceLocalToolResult`. Nothing here formats it into anything
   * that could read as an instruction, and the clamp is applied on this side as
   * well as the host's.
   */
  private _buildComment(): void {
    const host = this._hosts.comment;
    if (!host) { return; }
    const doc = this._env.doc;
    host.replaceChildren();
    host.className = AGENT_COMMENT_CLASS;

    const head = doc.createElement('div');
    head.className = 'ac-head';
    const title = doc.createElement('span');
    title.className = 'ac-title';
    title.textContent = 'Ask Mysti to change this';
    head.appendChild(title);
    host.appendChild(head);

    const row = doc.createElement('div');
    row.className = 'ac-row';

    const picker = asValueElement(doc.createElement('select'));
    picker.className = 'ac-target';
    picker.setAttribute('aria-label', 'Artboard this note is about');
    row.appendChild(picker);
    this._commentPicker = picker;

    const input = asValueElement(doc.createElement('input'));
    input.className = 'ac-input';
    input.setAttribute('type', 'text');
    input.setAttribute('aria-label', 'What should Mysti change?');
    input.setAttribute('placeholder', 'e.g. make this heading lighter');
    input.setAttribute('maxlength', String(COMMENT_MAX));
    input.addEventListener('keydown', ev => {
      const key = (ev as { key?: unknown }).key;
      const shift = (ev as { shiftKey?: unknown }).shiftKey === true;
      if (key === 'Enter' && !shift) {
        const e = ev as { preventDefault?: unknown };
        if (typeof e.preventDefault === 'function') { (e.preventDefault as () => void).call(e); }
        this._sendComment();
      }
    });
    row.appendChild(input);
    this._commentInput = input;

    row.appendChild(this._button('ac-send', 'Send to Mysti', () => this._sendComment()));
    host.appendChild(row);

    const outbox = doc.createElement('div');
    outbox.className = 'ac-outbox';
    outbox.setAttribute('role', 'list');
    // Steering state changes without the human looking at it; announce politely.
    outbox.setAttribute('aria-live', 'polite');
    host.appendChild(outbox);
    this._outboxHost = outbox;

    this._drawComment();
  }

  /** The artboard a comment would go to right now, and how it is named. */
  commentTarget(): { pageId: string; mid?: Mid; label: string } | null {
    const explicit = this._pendingTarget ?? this._commentTarget?.() ?? null;
    if (explicit && typeof explicit.pageId === 'string' && explicit.pageId) {
      const label = explicit.label
        ?? (explicit.mid ? `${this._pageLabel(explicit.pageId) ?? 'Artboard'} · element` : this._pageLabel(explicit.pageId))
        ?? 'Artboard';
      return { pageId: explicit.pageId, ...(explicit.mid ? { mid: explicit.mid } : {}), label };
    }
    const chosen = this._commentPicker?.value;
    const pages = this._pages();
    const page = pages.find(p => p && p.id === chosen) ?? pages[0];
    if (!page) { return null; }
    return { pageId: page.id, label: this._pageLabel(page.id) ?? 'Artboard' };
  }

  private _drawComment(): void {
    const host = this._hosts.comment;
    const picker = this._commentPicker;
    if (!host || !picker) { return; }
    const pages = this._pages();
    const target = this.commentTarget();
    const pinned = !!(this._pendingTarget ?? this._commentTarget?.());

    picker.replaceChildren();
    for (const page of pages) {
      const option = asValueElement(this._env.doc.createElement('option'));
      option.value = page.id;
      option.textContent = this._pageLabel(page.id) ?? page.id;
      picker.appendChild(option);
    }
    if (target) { picker.value = target.pageId; }
    // An explicit element target owns the destination; the picker would only
    // offer a way to silently retarget the note to a different artboard.
    picker.hidden = pinned || pages.length === 0;

    host.setAttribute('data-target', target ? target.label : 'none');
    host.hidden = pages.length === 0 && !target;
    this._drawOutbox();
  }

  private _sendComment(): void {
    const input = this._commentInput;
    const target = this.commentTarget();
    if (!input || !target) { return; }
    const body = commentBody(target.pageId, input.value, target.mid);
    if (!body) { return; }
    this._send(body);
    input.value = '';
    const entry: OutboxEntry = {
      id: `c${++this._outboxSeq}`,
      text: clampText(body.t === 'canvas/comment' ? body.text : '', 120),
      pageId: target.pageId,
      at: this._env.now(),
      // The one fact the view actually has: was anything running when it left.
      state: this._jobs.size > 0 ? 'with-run' : 'queued',
      ...(target.mid ? { mid: target.mid } : {}),
    };
    this._outbox.push(entry);
    while (this._outbox.length > OUTBOX_MAX) { this._outbox.shift(); }
    // The element target is consumed: the next note is about whatever the human
    // picks next, not silently still about the node they clicked five minutes ago.
    this._pendingTarget = null;
    this._drawComment();
  }

  private _drawOutbox(): void {
    const host = this._outboxHost;
    if (!host) { return; }
    host.replaceChildren();
    if (this._outbox.length === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const now = this._env.now();
    const doc = this._env.doc;
    for (let i = this._outbox.length - 1; i >= 0; i--) {
      const entry = this._outbox[i];
      const row = doc.createElement('div');
      row.className = 'ac-item';
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-state', entry.state);
      const text = doc.createElement('span');
      text.className = 'ac-item-text';
      text.textContent = entry.text;
      row.appendChild(text);
      const described = describeOutbox(entry, now, this._steeringReachable);
      const status = doc.createElement('span');
      status.className = 'ac-item-status';
      status.textContent = described.status;
      status.setAttribute('title', described.hint);
      row.appendChild(status);
      host.appendChild(row);
    }
  }
}

/** The status bar's parts, built once so focus survives every redraw. */
interface StatusElements {
  host: DomElement;
  dot: DomElement;
  label: DomElement;
  detail: DomElement;
  elapsed: DomElement;
  progress: DomElement;
  fill: DomElement;
  review: DomElement;
  cancel: DomElement;
  /** The only polite live region — see {@link statusAnnouncement}. */
  live: DomElement;
}

/** Activity attributes this module owns on the rail list. */
export const RAIL_ACTIVITY_ATTRS: readonly string[] =
  ['data-working', 'data-staged', 'data-cursor', 'data-writing'];

/**
 * A container appended to a pane this module does not own.
 *
 * Returns `null` when there is no pane, so the composer is simply absent rather
 * than half-built somewhere unexpected.
 */
function borrowedChild(env: CanvasEnv, host: DomElement | null): DomElement | null {
  if (!host) { return null; }
  const child = env.doc.createElement('div');
  host.appendChild(child);
  return child;
}

function stampIds(host: DomElement, attr: string, ids: ReadonlySet<string>): void {
  if (ids.size === 0) { host.removeAttribute(attr); return; }
  host.setAttribute(attr, [...ids].join(' '));
}

function clearTimer(handle: unknown): void {
  if (handle === null || handle === undefined) { return; }
  const g = globalThis as { clearTimeout?: (h: unknown) => void };
  g.clearTimeout?.(handle);
}

/**
 * `(prefers-reduced-motion: reduce)` when the host exposes `matchMedia`.
 *
 * Defaults to "full motion" rather than throwing when it does not: a VS Code
 * webview always has it, and the fake DOM in the tests never does.
 */
export function defaultReducedMotion(): boolean {
  const g = globalThis as { matchMedia?: (q: string) => { matches?: boolean } | null };
  try {
    return g.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

/**
 * Mount the liveness layer. The one entry point `board.ts` / `index.ts` calls.
 */
export function mountLiveness(opts: LivenessOptions): LivenessLayer {
  return new LivenessLayer(opts);
}

/* -------------------------------- helpers -------------------------------- */

function place(el: DomElement, rect: Rect): void {
  el.style.setProperty('left', `${Math.round(rect.x)}px`);
  el.style.setProperty('top', `${Math.round(rect.y)}px`);
  el.style.setProperty('width', `${Math.max(0, Math.round(rect.w))}px`);
  el.style.setProperty('height', `${Math.max(0, Math.round(rect.h))}px`);
}

/**
 * `DomElement` deliberately exposes no `children` (see `dom.ts`), so the layer
 * reads them structurally where a fake DOM and a real one agree.
 */
function childrenOf(el: DomElement): DomElement[] {
  const kids = (el as unknown as { children?: unknown }).children;
  if (Array.isArray(kids)) { return kids as DomElement[]; }
  if (kids && typeof (kids as { length?: unknown }).length === 'number') {
    const list = kids as { length: number; [index: number]: DomElement };
    const out: DomElement[] = [];
    for (let i = 0; i < list.length; i++) { out.push(list[i]); }
    return out;
  }
  return [];
}
