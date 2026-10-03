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
 * Plan 22 Phase 5 — watch and steer: the host half.
 *
 * Three mechanisms live here, in the order the plan builds them:
 *
 * 1. **Tier 1 liveness, with ZERO model cooperation** ({@link CanvasLiveness}).
 *    `CanvasJobRouter` was built well and then never called: `create`/`pipe`/
 *    `cancel`/`signal` had zero production call sites and `CanvasJobEvent`
 *    declared `started`/`progress`/`heartbeat`/`asset_ready` with **no producer
 *    for any of them**. So a 30-second generation showed nothing at all and
 *    then popped in. Opening a job the moment a canvas directive *opens* costs
 *    the model nothing — it does not have to announce anything, emit progress,
 *    or cooperate in any way — and buys a ghost artboard, a live elapsed timer
 *    and a Cancel that actually aborts, because the handle carries the job's
 *    real `AbortSignal`.
 *
 * 2. **Tier 2 speculative streaming** ({@link SpeculativeStream}). Streaming
 *    produces **ops, not documents**: compile the syntactically-complete prefix
 *    on a ~150 ms throttle, `reconcile` it against the previous partial so ids
 *    survive, `diffDocs` the two, and push the ops. Because the unit is an op,
 *    it takes the *exact* render path a committed edit takes — the frame
 *    patches, React reconciles, and nothing about the renderer knows the ops
 *    were speculative. They never enter the journal: this module cannot reach
 *    `CanvasOpExecutor`, so "speculative ops are not persisted" is a property of
 *    the module graph rather than a rule someone has to remember.
 *
 * 3. **The per-run inbox** ({@link CanvasRunInbox}). Comments, accept/reject
 *    outcomes, parked/stale/pinned notices and frame errors have to reach a
 *    *running* coordinator turn. `_runMystiAgentic` builds `messages` turn by
 *    turn with no injection point, so the queue is drained at the TOP of each
 *    `while` iteration, **before** `stream()` starts — never mid-stream, where
 *    it would race the abort-on-directive logic — and folded into ONE turn.
 *    Everything in it is DATA: a comment is human text arriving through a
 *    webview, a frame error is a message produced by model-authored code. The
 *    drained body is handed to `_fenceLocalToolResult` by the caller and is
 *    clamped and control-char scrubbed here, so neither a giant paste nor a
 *    terminal escape sequence rides into the prompt.
 *
 * Everything is injectable (clock, timers, compiler) because the whole point of
 * this file is behaviour under time — heartbeats, throttles, cancellation
 * ordering — which is untestable against real timers.
 */

import type { CanvasJobEvent } from '../types';
import type { CanvasJobRouter } from '../managers/CanvasJobRouter';
import type { CanvasHostMessage } from './protocol';
import type { CanvasOp, CanvasOpReceiptV2 } from './CanvasOps';
import type { DocNode, Mid } from './doc/DocNode';
import { compilePartial, type CompileResult } from './doc/PageCompiler';
import { reconcile } from './doc/Reconciler';
import { diffDocs } from './doc/TreeDiffer';

/* ─────────────────────────────── wire extras ─────────────────────────────── */

/** World-space position of an artboard (or of a ghost standing in for one). */
export interface BoardPos { x: number; y: number }

/** Artboard size in device px. */
export interface BoardSize { w: number; h: number }

/**
 * A speculative patch: ops computed from a partially-written page.
 *
 * `seq` is monotonic per stream so the client can drop a duplicate or an
 * out-of-order patch instead of applying a stale diff on top of a newer tree.
 * `sealed` says the top-level structure stopped moving, which is when the
 * "writing" treatment comes off (risk 4: a nav bar briefly full-width before
 * its sibling arrives should not be presented as finished layout).
 */
export interface SpeculativePatch {
  pageId: string;
  seq: number;
  ops: CanvasOp[];
  sealed: boolean;
}

/**
 * The extra fields the liveness lane rides on a {@link CanvasJobEvent}.
 *
 * Additive by interface extension rather than by widening `CanvasJobEvent`
 * itself: every existing producer and consumer keeps compiling, and a consumer
 * that does not know about ghosts simply sees a `started` event with a label.
 * The webview imports this **as a type only** and re-validates each field at
 * runtime, so the canvas bundle never pulls the compiler in.
 */
export interface CanvasLivenessEvent extends CanvasJobEvent {
  /** `started` — where to draw the ghost artboard. */
  boardPos?: BoardPos;
  /** `started` — how big to draw it. */
  size?: BoardSize;
  /** The chat run that owns this job. */
  runId?: string;
  /** `progress` — a speculative patch. NEVER a journal record. */
  spec?: SpeculativePatch;
}

/* ──────────────────────────────── constants ──────────────────────────────── */

/** Heartbeat cadence. The plan's number: a visible tick, not a busy loop. */
export const LIVENESS_HEARTBEAT_MS = 2000;

/** Speculative recompile throttle. Parsing is host-side; keep it off the hot path. */
export const SPECULATIVE_THROTTLE_MS = 150;

/**
 * Source cap for speculative compilation (risk 8). Past this the stream stops
 * recompiling and simply waits for the authoritative write — a 200 KB paste
 * must not turn every 150 ms into a parse of 200 KB.
 */
export const SPECULATIVE_MAX_SOURCE = 64_000;

/** Consecutive structurally-stable compiles before the "writing" treatment lifts. */
export const SPECULATIVE_SEAL_ROUNDS = 2;

/** Items retained per run before the oldest are dropped (and reported). */
export const INBOX_MAX_ITEMS = 32;
/** Per-item clamp. A pasted essay in a comment is still one line of steering. */
export const INBOX_MAX_ITEM_CHARS = 1000;
/** Whole-body clamp for one drained turn. */
export const INBOX_MAX_BODY_CHARS = 6000;

/* ─────────────────────────────── the inbox ─────────────────────────────── */

export type InboxKind =
  | 'comment'
  | 'decision'
  | 'parked'
  | 'stale'
  | 'pinned'
  | 'dropped'
  | 'frame-error'
  | 'cancelled';

export interface InboxItem {
  kind: InboxKind;
  at: number;
  pageId?: string;
  mid?: Mid;
  /** Already scrubbed and clamped by {@link CanvasRunInbox.enqueue}. */
  text: string;
}

/** Control characters that must never reach a prompt (tab/newline survive). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Markers that would otherwise let untrusted text *look* like the end of the
 * untrusted fence. Closing it actually requires the per-run nonce, which this
 * text cannot know, so this is belt-and-braces against confusion, not the
 * security boundary — that is `_fenceLocalToolResult`.
 */
const FENCE_MARKERS = /<<<UNTRUSTED|UNTRUSTED>>>/g;

export function scrubInboxText(raw: unknown, max = INBOX_MAX_ITEM_CHARS): string {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const flat = text.replace(CONTROL_CHARS, ' ').replace(FENCE_MARKERS, '[fence]');
  const collapsed = flat.replace(/\n{3,}/g, '\n\n').trim();
  if (collapsed.length <= max) { return collapsed; }
  return `${collapsed.slice(0, max)}… (truncated)`;
}

interface RunQueue {
  items: InboxItem[];
  dropped: number;
}

/**
 * The steering queue, one bounded FIFO per run.
 *
 * Bounded on purpose in both directions: a chatty human and a render loop that
 * throws on every frame are the same failure from the run's point of view, and
 * "the last 32 things" is more useful to a model than "the first 32 things".
 */
export class CanvasRunInbox {
  private readonly _runs = new Map<string, RunQueue>();
  private readonly _maxItems: number;
  private readonly _maxBody: number;
  private readonly _now: () => number;

  constructor(opts: { maxItems?: number; maxBodyChars?: number; now?: () => number } = {}) {
    this._maxItems = Math.max(1, opts.maxItems ?? INBOX_MAX_ITEMS);
    this._maxBody = Math.max(200, opts.maxBodyChars ?? INBOX_MAX_BODY_CHARS);
    this._now = opts.now ?? (() => Date.now());
  }

  /** Queue one notice. Returns false when the text scrubbed down to nothing. */
  enqueue(runId: string, item: Omit<InboxItem, 'at' | 'text'> & { text: string; at?: number }): boolean {
    if (typeof runId !== 'string' || runId.length === 0) { return false; }
    const text = scrubInboxText(item.text);
    if (!text) { return false; }
    const queue = this._runs.get(runId) ?? { items: [], dropped: 0 };
    const entry: InboxItem = { kind: item.kind, at: item.at ?? this._now(), text };
    if (item.pageId) { entry.pageId = item.pageId; }
    if (item.mid) { entry.mid = item.mid; }
    queue.items.push(entry);
    while (queue.items.length > this._maxItems) {
      queue.items.shift();
      queue.dropped++;
    }
    this._runs.set(runId, queue);
    return true;
  }

  hasPending(runId: string): boolean {
    const queue = this._runs.get(runId);
    return !!queue && queue.items.length > 0;
  }

  pendingCount(runId: string): number {
    return this._runs.get(runId)?.items.length ?? 0;
  }

  /** Read without consuming. Diagnostics and tests. */
  peek(runId: string): readonly InboxItem[] {
    return this._runs.get(runId)?.items ?? [];
  }

  /**
   * Take everything queued for a run and render it as ONE body.
   *
   * The caller wraps it with `_fenceLocalToolResult` and pushes a single user
   * turn — one turn, not one per item, because N adjacent user turns is both a
   * malformed transcript and an invitation to answer each one separately.
   */
  drain(runId: string): string | null {
    const queue = this._runs.get(runId);
    if (!queue || queue.items.length === 0) { return null; }
    this._runs.delete(runId);
    return renderInbox(queue.items, queue.dropped, this._maxBody);
  }

  /** Forget a run's queue (run finished / cancelled). */
  endRun(runId: string): void {
    this._runs.delete(runId);
  }

  clear(): void {
    this._runs.clear();
  }
}

const KIND_LABEL: Readonly<Record<InboxKind, string>> = {
  'comment': 'comment',
  'decision': 'decision',
  'parked': 'parked',
  'stale': 'stale',
  'pinned': 'pinned',
  'dropped': 'dropped',
  'frame-error': 'render error',
  'cancelled': 'cancelled',
};

/** Render queued items into the single body a drain produces. */
export function renderInbox(
  items: readonly InboxItem[],
  dropped = 0,
  maxBody = INBOX_MAX_BODY_CHARS,
): string | null {
  if (items.length === 0) { return null; }
  const lines: string[] = [];
  lines.push(`Canvas activity while you were working (${items.length} item${items.length === 1 ? '' : 's'}):`);
  if (dropped > 0) { lines.push(`(${dropped} earlier notice${dropped === 1 ? '' : 's'} dropped — the queue is bounded.)`); }
  let index = 1;
  for (const item of items) {
    const where = item.pageId
      ? (item.mid ? ` on page ${item.pageId}, element ${item.mid}` : ` on page ${item.pageId}`)
      : '';
    lines.push(`${index}. [${KIND_LABEL[item.kind]}]${where}: ${item.text}`);
    index++;
  }
  const body = lines.join('\n');
  if (body.length <= maxBody) { return body; }
  return `${body.slice(0, maxBody)}\n… (canvas activity truncated)`;
}

/* ────────────────────────── speculative streaming ────────────────────────── */

export interface SpeculativeStreamOptions {
  pageId: string;
  /** Injected clock so the throttle is testable. */
  now?: () => number;
  throttleMs?: number;
  /** Deterministic mids in tests. */
  rand?: () => number;
  maxSourceChars?: number;
  sealRounds?: number;
  /** Injectable compiler (tests, and a future widened evaluator). */
  compile?: (source: string, opts?: { rand?: () => number }) => CompileResult;
  /** Emitted for every patch the stream produces. */
  onPatch?: (patch: SpeculativePatch) => void;
}

/**
 * Turns a growing page source into a series of op patches.
 *
 * The three properties that make this safe to run on a streaming path:
 *
 * - **It never throws.** `compilePartial` is documented as total; every other
 *   step here is wrapped, because a parser hiccup must degrade to "no preview
 *   this tick", never to a failed generation.
 * - **It is throttled and capped.** At most one compile per `throttleMs`, and
 *   nothing at all past `maxSourceChars`.
 * - **It carries ids forward.** Each compile mints fresh mids; without
 *   `reconcile` against the previous partial, every tick would diff as "replace
 *   everything" and the frame would rebuild ~7 times a second. With it, the
 *   second tick of a page that grew by one card is one `el.insert`.
 */
export class SpeculativeStream {
  private readonly _pageId: string;
  private readonly _now: () => number;
  private readonly _throttleMs: number;
  private readonly _rand: (() => number) | undefined;
  private readonly _maxSource: number;
  private readonly _sealRounds: number;
  private readonly _compile: (source: string, opts?: { rand?: () => number }) => CompileResult;
  private readonly _onPatch: ((patch: SpeculativePatch) => void) | undefined;

  private _src = '';
  private _doc: DocNode | null = null;
  private _seq = 0;
  private _lastAt = Number.NEGATIVE_INFINITY;
  private _stable = 0;
  private _sealed = false;
  private _overflowed = false;
  private _compiles = 0;

  constructor(opts: SpeculativeStreamOptions) {
    this._pageId = opts.pageId;
    this._now = opts.now ?? (() => Date.now());
    this._throttleMs = Math.max(0, opts.throttleMs ?? SPECULATIVE_THROTTLE_MS);
    this._rand = opts.rand;
    this._maxSource = Math.max(1, opts.maxSourceChars ?? SPECULATIVE_MAX_SOURCE);
    this._sealRounds = Math.max(1, opts.sealRounds ?? SPECULATIVE_SEAL_ROUNDS);
    this._compile = opts.compile ?? ((source, o) => compilePartial(source, o ?? {}));
    this._onPatch = opts.onPatch;
  }

  /** The last speculative tree, or null if nothing has compiled yet. */
  get doc(): DocNode | null { return this._doc; }
  get seq(): number { return this._seq; }
  get sealed(): boolean { return this._sealed; }
  /** Compilations actually performed. The throttle assertion reads this. */
  get compileCount(): number { return this._compiles; }
  /** True once the source passed the cap and compilation stopped. */
  get overflowed(): boolean { return this._overflowed; }

  /** Append streamed text. Returns a patch when this tick produced one. */
  feed(chunk: string): SpeculativePatch | null {
    if (typeof chunk === 'string' && chunk.length > 0) { this._src += chunk; }
    if (this._src.length > this._maxSource) { this._overflowed = true; return null; }
    const at = this._now();
    if (at - this._lastAt < this._throttleMs) { return null; }
    this._lastAt = at;
    return this._recompute(false);
  }

  /**
   * Compile now, ignoring the throttle, and seal.
   *
   * Called when the directive closes: the final prefix is the whole page, so
   * the last patch a human sees before the authoritative write is the complete
   * speculative tree rather than whatever the throttle last let through.
   */
  flush(): SpeculativePatch | null {
    if (this._src.length > this._maxSource) { this._overflowed = true; return null; }
    this._lastAt = this._now();
    return this._recompute(true);
  }

  /**
   * Converge on the authoritative document.
   *
   * When the write path reconciled against {@link doc} (see
   * `speculativeDocFor` on {@link CanvasLiveness}), matched nodes kept their
   * speculative ids and this returns **no ops at all** — the frame is already
   * showing the committed tree and literally nothing moves. When it did not,
   * this still guarantees convergence, at the cost of a visible replace: that
   * fallback is the difference between "a jump" and "the board disagrees with
   * the file on disk", and only one of those is acceptable.
   */
  settle(authoritative: DocNode): SpeculativePatch {
    this._sealed = true;
    if (!this._doc) {
      this._doc = authoritative;
      this._seq++;
      const patch: SpeculativePatch = {
        pageId: this._pageId,
        seq: this._seq,
        ops: [{ op: 'page.setDoc', pageId: this._pageId, doc: authoritative }],
        sealed: true,
      };
      this._emit(patch);
      return patch;
    }
    let ops: CanvasOp[] = [];
    try {
      ops = diffDocs(this._doc, authoritative, { pageId: this._pageId }).ops;
    } catch {
      ops = [{ op: 'page.setDoc', pageId: this._pageId, doc: authoritative }];
    }
    this._doc = authoritative;
    this._seq++;
    const patch: SpeculativePatch = { pageId: this._pageId, seq: this._seq, ops, sealed: true };
    this._emit(patch);
    return patch;
  }

  private _recompute(seal: boolean): SpeculativePatch | null {
    let result: CompileResult;
    try {
      result = this._compile(this._src, this._rand ? { rand: this._rand } : {});
    } catch {
      return null;                        // a parser hiccup costs one tick, nothing more
    }
    this._compiles++;
    if (!result.ok) { return null; }
    const next = result.doc;

    if (!this._doc) {
      this._doc = next;
      this._seq++;
      if (seal) { this._sealed = true; }
      const patch: SpeculativePatch = {
        pageId: this._pageId,
        seq: this._seq,
        ops: [{ op: 'page.setDoc', pageId: this._pageId, doc: next }],
        sealed: this._sealed,
      };
      this._emit(patch);
      return patch;
    }

    let carried: DocNode;
    let ops: CanvasOp[];
    try {
      carried = reconcile(this._doc, next, this._rand ? { rand: this._rand } : {}).doc;
      ops = diffDocs(this._doc, carried, { pageId: this._pageId }).ops;
    } catch {
      return null;
    }

    if (ops.length === 0) {
      // Nothing changed this tick: that IS the seal signal — the tree stopped
      // moving even though more text arrived (whitespace, a closing tag).
      this._stable++;
      if (seal || this._stable >= this._sealRounds) { this._sealed = true; }
      return null;
    }

    this._stable = structurallyStable(ops, this._doc.mid) ? this._stable + 1 : 0;
    this._doc = carried;
    this._seq++;
    if (seal || this._stable >= this._sealRounds) { this._sealed = true; }
    const patch: SpeculativePatch = {
      pageId: this._pageId,
      seq: this._seq,
      ops,
      sealed: this._sealed,
    };
    this._emit(patch);
    return patch;
  }

  private _emit(patch: SpeculativePatch): void {
    try { this._onPatch?.(patch); } catch { /* a sink must not break the stream */ }
  }
}

/**
 * True when no op in the batch changes the artboard's own child list.
 *
 * That is the "top-level structure sealed" test from risk 4: text and styles
 * filling in below the fold are fine to show as final; a new section arriving
 * at the root is exactly the case where a nav bar looks full-width for a frame.
 */
export function structurallyStable(ops: readonly CanvasOp[], rootMid: Mid): boolean {
  for (const op of ops) {
    switch (op.op) {
      case 'el.insert': if (op.parentMid === rootMid) { return false; } break;
      case 'el.move': if (op.newParentMid === rootMid) { return false; } break;
      case 'el.remove': case 'el.replace': if (op.mid === rootMid) { return false; } break;
      case 'page.setDoc': return false;
      default: break;
    }
  }
  return true;
}

/* ──────────────────────────────── the jobs ──────────────────────────────── */

export type TimerHandle = unknown;

export interface LivenessJobSpec {
  /** The chat turn / background job that owns this. */
  runId: string;
  /** Human-facing: "Designing the login screen". */
  label: string;
  /** Artboard being written, when known. */
  pageId?: string;
  /** Where to park the ghost while there is no artboard yet. */
  boardPos?: BoardPos;
  size?: BoardSize;
  /** Reuse an existing job id (a directive that re-enters). */
  jobId?: string;
}

export interface LivenessJobHandle {
  readonly jobId: string;
  readonly runId: string;
  readonly label: string;
  /**
   * The job's real abort signal — this is what makes Cancel *work*.
   *
   * Captured at open and stable for the life of the handle, including after a
   * cancel has retired the job from the router.
   */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  /** True once someone cancelled this job (the run should stop writing). */
  readonly cancelled: boolean;
  /** Seconds since `started`, as the last heartbeat reported it. */
  readonly elapsedSeconds: number;
  progress(fraction?: number, label?: string): void;
  /** Push a speculative patch. Never journalled. */
  speculative(patch: SpeculativePatch): void;
  /** Open a speculative stream whose patches ride this job. */
  speculate(pageId: string, opts?: Omit<SpeculativeStreamOptions, 'pageId' | 'onPatch'>): SpeculativeStream;
  /** Move the agent cursor to the node being edited. */
  cursor(pageId: string, mid: Mid | undefined, label?: string): void;
  done(result?: unknown): void;
  fail(error: string): void;
}

export interface CanvasLivenessOptions {
  router: CanvasJobRouter;
  /** Host→webview sink for `canvas/agentCursor`. Job events ride the router. */
  post?: (message: CanvasHostMessage) => void;
  now?: () => number;
  /** Repeating timer, injected. Defaults to `setInterval`. */
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  unschedule?: (handle: TimerHandle) => void;
  heartbeatMs?: number;
  inbox?: CanvasRunInbox;
  maxInboxItems?: number;
  maxInboxChars?: number;
}

interface JobState {
  jobId: string;
  runId: string;
  label: string;
  pageId?: string;
  /**
   * Captured at open, NOT read back off the router.
   *
   * `cancel()` deletes the job as it aborts, so a handle that looked its signal
   * up lazily would return `undefined` at exactly the moment the caller needs
   * to see `aborted === true` — the run would sail on writing artboards a human
   * already cancelled.
   */
  signal: AbortSignal;
  startedAt: number;
  timer: TimerHandle | null;
  closed: boolean;
  cancelled: boolean;
  elapsedSeconds: number;
  stream: SpeculativeStream | null;
}

/**
 * The Tier-1 liveness producer and the owner of the per-run inbox.
 *
 * One instance per canvas session (it wraps that session's `CanvasJobRouter`).
 * It deliberately holds **no** reference to `CanvasOpExecutor` or the store: a
 * liveness signal must never be able to write a document, and a speculative
 * patch must never be able to reach the journal.
 */
export class CanvasLiveness {
  private readonly _router: CanvasJobRouter;
  private readonly _post: ((message: CanvasHostMessage) => void) | undefined;
  private readonly _now: () => number;
  private readonly _schedule: (fn: () => void, ms: number) => TimerHandle;
  private readonly _unschedule: (handle: TimerHandle) => void;
  private readonly _heartbeatMs: number;
  private readonly _inbox: CanvasRunInbox;
  private readonly _jobs = new Map<string, JobState>();
  private _disposed = false;

  constructor(opts: CanvasLivenessOptions) {
    this._router = opts.router;
    this._post = opts.post;
    this._now = opts.now ?? (() => Date.now());
    this._schedule = opts.schedule ?? ((fn, ms) => {
      const t = setInterval(fn, ms);
      (t as unknown as { unref?: () => void }).unref?.();
      return t;
    });
    this._unschedule = opts.unschedule ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this._heartbeatMs = Math.max(100, opts.heartbeatMs ?? LIVENESS_HEARTBEAT_MS);
    this._inbox = opts.inbox ?? new CanvasRunInbox({
      maxItems: opts.maxInboxItems,
      maxBodyChars: opts.maxInboxChars,
      now: this._now,
    });
  }

  /** The steering queue. Exposed so the chat loop can drain it directly. */
  get inbox(): CanvasRunInbox { return this._inbox; }

  /** Live job ids. */
  jobIds(): string[] { return [...this._jobs.keys()]; }

  jobsForRun(runId: string): string[] {
    const out: string[] = [];
    for (const job of this._jobs.values()) { if (job.runId === runId) { out.push(job.jobId); } }
    return out;
  }

  /**
   * Open a job as a canvas directive/tool call OPENS.
   *
   * This is the whole of "zero model cooperation": the model said nothing about
   * progress, and the human already has a ghost artboard, a running timer and a
   * Cancel button.
   */
  openJob(spec: LivenessJobSpec): LivenessJobHandle {
    // Idempotent on an echoed id. Registering twice would schedule a SECOND
    // heartbeat timer for the same job while orphaning the first one's handle —
    // i.e. a leaked interval that then beats the new state twice a period.
    if (spec.jobId) {
      const open = this._jobs.get(spec.jobId);
      if (open) { return this._handle(open); }
    }
    const job = this._router.create(spec.label, spec.jobId);
    const startedAt = this._now();
    const state: JobState = {
      jobId: job.jobId,
      runId: spec.runId,
      label: spec.label,
      signal: job.controller.signal,
      startedAt,
      timer: null,
      closed: false,
      cancelled: false,
      elapsedSeconds: 0,
      stream: null,
    };
    if (spec.pageId) { state.pageId = spec.pageId; }
    this._jobs.set(job.jobId, state);

    const started: Omit<CanvasLivenessEvent, 'jobId'> = { type: 'started', label: spec.label, runId: spec.runId };
    if (spec.pageId) { started.pageId = spec.pageId; }
    if (spec.boardPos) { started.boardPos = { x: spec.boardPos.x, y: spec.boardPos.y }; }
    if (spec.size) { started.size = { w: spec.size.w, h: spec.size.h }; }
    this._router.emit(job.jobId, started);

    if (!this._disposed) {
      state.timer = this._schedule(() => this._beat(job.jobId), this._heartbeatMs);
    }

    return this._handle(state);
  }

  /**
   * Cancel a job by id — the Cancel button on a ghost artboard.
   *
   * Order matters: the heartbeat is stopped BEFORE the router emits its
   * terminal `done`, so a timer that happens to be due cannot emit a heartbeat
   * after the job's last event (a spinner that outlives its own job is the F-4
   * bug this protocol exists to end).
   */
  cancel(jobId: string): boolean {
    const state = this._jobs.get(jobId);
    if (state) {
      this._stopTimer(state);
      state.cancelled = true;
      state.closed = true;
      this._jobs.delete(jobId);
      this._inbox.enqueue(state.runId, {
        kind: 'cancelled',
        text: `The human cancelled "${state.label}". Stop that piece of work and acknowledge it.`,
        ...(state.pageId ? { pageId: state.pageId } : {}),
      });
    }
    return this._router.cancel(jobId);
  }

  /** Cancel every job of a run. Returns how many were live. */
  cancelRun(runId: string): number {
    let n = 0;
    for (const jobId of this.jobsForRun(runId)) { if (this.cancel(jobId)) { n++; } }
    return n;
  }

  /** True when a job was cancelled (or never existed). Cheap guard for a loop. */
  isCancelled(jobId: string): boolean {
    const state = this._jobs.get(jobId);
    return !state || state.cancelled;
  }

  /**
   * Move the labelled ghost highlight to the node being edited.
   *
   * Drawn by the SAME parent overlay that draws human selection — see
   * `selection.ts` for why chrome inside a model-authored frame is not an
   * option.
   */
  cursor(pageId: string, mid: Mid | undefined, label: string): void {
    if (!this._post || typeof pageId !== 'string' || !pageId) { return; }
    const message: CanvasHostMessage = mid
      ? { t: 'canvas/agentCursor', pageId, mid, label }
      : { t: 'canvas/agentCursor', pageId, label };
    try { this._post(message); } catch { /* a dead panel must not break a run */ }
  }

  /** Retract the cursor (the agent moved on). */
  clearCursor(pageId: string): void {
    this.cursor(pageId, undefined, '');
  }

  /* ------------------------------- inbox API ------------------------------- */

  /** A human comment from `canvas/comment`. UNTRUSTED human text. */
  comment(runId: string, input: { pageId?: string; mid?: Mid; text: string }): boolean {
    return this._inbox.enqueue(runId, {
      kind: 'comment',
      text: input.text,
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...(input.mid ? { mid: input.mid } : {}),
    });
  }

  /** The outcome of `canvas/decide` — what the human accepted or rejected. */
  decision(runId: string, input: { opIds: readonly string[]; accept: boolean; pageId?: string }): boolean {
    const ids = input.opIds.filter(id => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) { return false; }
    const shown = ids.slice(0, 8).join(', ');
    const more = ids.length > 8 ? ` (+${ids.length - 8} more)` : '';
    const verb = input.accept ? 'accepted' : 'rejected';
    const advice = input.accept
      ? 'Keep building on them.'
      : 'Do not re-apply them; propose something different if the goal still stands.';
    return this._inbox.enqueue(runId, {
      kind: 'decision',
      text: `The human ${verb} ${ids.length} suggestion${ids.length === 1 ? '' : 's'}: ${shown}${more}. ${advice}`,
      ...(input.pageId ? { pageId: input.pageId } : {}),
    });
  }

  /** A parked / stale / pinned / dropped notice in the writer's own words. */
  notice(runId: string, kind: Extract<InboxKind, 'parked' | 'stale' | 'pinned' | 'dropped'>, text: string, where?: { pageId?: string; mid?: Mid }): boolean {
    return this._inbox.enqueue(runId, {
      kind,
      text,
      ...(where?.pageId ? { pageId: where.pageId } : {}),
      ...(where?.mid ? { mid: where.mid } : {}),
    });
  }

  /**
   * Fold a receipt the model did not directly await into the inbox.
   *
   * Receipts returned inline from a tool call are already in the transcript;
   * this is for the ones that arrive *later* — an op parked behind a subtree
   * lock, a pin refusal, a rebase — which today reach nobody.
   */
  noteReceipt(runId: string, receipt: CanvasOpReceiptV2): boolean {
    const where = receipt.pageId ? { pageId: receipt.pageId } : undefined;
    if (receipt.pinned && receipt.pinned.length > 0) {
      return this.notice(runId, 'pinned',
        `Your edit ${receipt.opId} was refused on cells the human owns: ${receipt.pinned.join(', ')}. Leave them alone unless the human asked for that exact change.`,
        where);
    }
    if (receipt.status === 'staged') {
      return this.notice(runId, 'parked',
        `Edit ${receipt.opId} is parked as a suggestion (the human is editing that subtree, or approval is staged). It is NOT applied yet.`,
        where);
    }
    if (receipt.status === 'stale') {
      return this.notice(runId, 'stale',
        `Edit ${receipt.opId} went stale — the node it targeted is gone. Re-read the page before writing there again.${receipt.error ? ` ${receipt.error}` : ''}`,
        where);
    }
    if (receipt.status === 'rejected') {
      return this.notice(runId, 'dropped',
        `Edit ${receipt.opId} was rejected.${receipt.error ? ` ${receipt.error}` : ''}`,
        where);
    }
    return false;
  }

  /**
   * A frame's error boundary fired.
   *
   * `enqueue` defaults to **false**: the card appears on the artboard and the
   * human decides. A render loop that throws on every frame would otherwise
   * flood a run with the same message — which is why the "Fix with AI" action
   * exists at all, and why `noteFrameError(..., true)` is what it calls.
   */
  frameError(
    runId: string,
    input: { pageId?: string; mid?: Mid; message: string },
    enqueue = false,
  ): boolean {
    if (!enqueue) { return false; }
    return this._inbox.enqueue(runId, {
      kind: 'frame-error',
      text: `An artboard failed to render: ${input.message}. Fix the page that produced it.`,
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...(input.mid ? { mid: input.mid } : {}),
    });
  }

  hasPending(runId: string): boolean { return this._inbox.hasPending(runId); }

  /** Take the queued steering for a run as ONE body. See {@link CanvasRunInbox.drain}. */
  drain(runId: string): string | null { return this._inbox.drain(runId); }

  /** The run is over: close its jobs and forget its queue. */
  endRun(runId: string): void {
    for (const jobId of this.jobsForRun(runId)) {
      const state = this._jobs.get(jobId);
      if (!state) { continue; }
      this._stopTimer(state);
      state.closed = true;
      this._jobs.delete(jobId);
      this._router.finish(jobId, { type: 'done' });
    }
    this._inbox.endRun(runId);
  }

  /**
   * Stop every heartbeat and forget every job.
   *
   * Jobs belong to the router (the workspace disposes it); this only owns the
   * timers, so disposal must not emit terminal events the router will emit
   * again from `cancelAll()`.
   */
  dispose(): void {
    this._disposed = true;
    for (const state of this._jobs.values()) { this._stopTimer(state); }
    this._jobs.clear();
    this._inbox.clear();
  }

  /* -------------------------------- internals -------------------------------- */

  /**
   * The handle a caller holds for one job.
   *
   * Arrow properties rather than method shorthands: `this` inside them is the
   * liveness instance, and the closure captures `handle` for the one place a
   * member calls a sibling — so `const { speculate } = job` keeps working
   * instead of silently dropping every patch on an undefined receiver.
   */
  private _handle(state: JobState): LivenessJobHandle {
    const handle: LivenessJobHandle = {
      get jobId() { return state.jobId; },
      get runId() { return state.runId; },
      get label() { return state.label; },
      get signal() { return state.signal; },
      get closed() { return state.closed; },
      get cancelled() { return state.cancelled; },
      get elapsedSeconds() { return state.elapsedSeconds; },
      progress: (fraction?: number, label?: string): void => {
        if (state.closed) { return; }
        const body: Omit<CanvasLivenessEvent, 'jobId'> = { type: 'progress', runId: state.runId };
        if (typeof fraction === 'number' && Number.isFinite(fraction)) {
          body.progress = Math.min(1, Math.max(0, fraction));
        }
        if (label) { body.label = label; }
        if (state.pageId) { body.pageId = state.pageId; }
        this._router.emit(state.jobId, body);
      },
      speculative: (patch: SpeculativePatch): void => {
        if (state.closed || !patch || typeof patch.pageId !== 'string') { return; }
        const body: Omit<CanvasLivenessEvent, 'jobId'> = {
          type: 'progress',
          runId: state.runId,
          pageId: patch.pageId,
          spec: patch,
        };
        this._router.emit(state.jobId, body);
      },
      speculate: (pageId, opts) => {
        const stream = new SpeculativeStream({
          ...(opts ?? {}),
          pageId,
          now: opts?.now ?? this._now,
          onPatch: patch => { handle.speculative(patch); },
        });
        state.stream = stream;
        if (!state.pageId) { state.pageId = pageId; }
        return stream;
      },
      cursor: (pageId: string, mid: Mid | undefined, label?: string): void => {
        if (state.closed) { return; }
        this.cursor(pageId, mid, label ?? state.label);
      },
      done: (result?: unknown): void => {
        if (state.closed) { return; }
        this._close(state, result === undefined ? { type: 'done' } : { type: 'done', result });
      },
      fail: (error: string): void => {
        if (state.closed) { return; }
        this._close(state, { type: 'error', error: String(error ?? 'canvas job failed') });
      },
    };
    return handle;
  }

  private _close(state: JobState, body: Omit<CanvasJobEvent, 'jobId'>): void {
    this._stopTimer(state);
    state.closed = true;
    this._jobs.delete(state.jobId);
    // `finish()` rather than `emit()`: it forgets the job as it emits, so the
    // terminal event is exactly one even if this raced a cancel. A cancel that
    // already fired dropped the job from the router, and `finish` no-ops.
    this._router.finish(state.jobId, body);
  }

  private _beat(jobId: string): void {
    const state = this._jobs.get(jobId);
    if (!state || state.closed || state.cancelled) { return; }
    // The router is the authority on liveness: a job cancelled through the
    // router directly (panel dispose, cancelAll) is gone from it, and a
    // heartbeat for it would be an event after the terminal one.
    if (!this._router.has(jobId)) { this._stopTimer(state); this._jobs.delete(jobId); return; }
    state.elapsedSeconds = Math.max(0, Math.round((this._now() - state.startedAt) / 1000));
    const body: Omit<CanvasLivenessEvent, 'jobId'> = {
      type: 'heartbeat',
      elapsedSeconds: state.elapsedSeconds,
      label: state.label,
      runId: state.runId,
    };
    if (state.pageId) { body.pageId = state.pageId; }
    this._router.emit(jobId, body);
  }

  private _stopTimer(state: JobState): void {
    if (state.timer === null) { return; }
    try { this._unschedule(state.timer); } catch { /* already cleared */ }
    state.timer = null;
  }
}
