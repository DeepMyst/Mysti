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
 * DeskBoard (Plan 21, invariants I18/I19/I20/I32) — the shared work state, as
 * a pure fold over signed events.
 *
 * ── Why a fold and not a database ──────────────────────────────────────────
 *
 * Every machine folds the same event set into the same state, so there is no
 * sequencer, no leader, and no shared mutable store to keep consistent. Two
 * people can point at the same sentence in a standup and know it derives from
 * the same signed events.
 *
 * The fold is PERMUTATION-INVARIANT: events may arrive in any order, be
 * duplicated, or be missing, and the result for the events you do hold is
 * identical. That is what makes an unreliable transport acceptable — a lost
 * message degrades completeness, never correctness.
 *
 * ── Ordering without trusting the sender ───────────────────────────────────
 *
 * Claims are arbitrated by sorting on `(generation, lamport, peerId, eventId)`
 * and letting the last event win. Ordering the input is what makes the fold
 * permutation-invariant STRUCTURALLY, rather than leaving it to depend on a
 * comparison function being a correct total order. The first draft carried
 * both a sort and a `beats()` comparison; with the sort in place the
 * comparison was unreachable, so it is gone.
 *
 * A lamport arrives from a peer, so it cannot be believed unconditionally: a
 * member could send `2^40` and win every future race with a perfectly valid
 * signature. Accepted values are therefore CLAMPED to
 * `maxSeen + LAMPORT_MAX_JUMP`; a larger jump is treated exactly like a
 * regression — flagged and dropped.
 *
 * ── Leases expire on the observer's clock ──────────────────────────────────
 *
 * A lease carries a DURATION, never an absolute epoch, and each observer
 * expires it against its own clock from locally-observed arrival. Absolute
 * timestamps would make a peer with a skewed clock able to hold a claim
 * indefinitely, and would make the board disagree across machines.
 *
 * This module imports NOTHING. Zero dependencies is not an aesthetic choice:
 * it is what lets the import-graph test prove that shared work state can never
 * reach a capability.
 */

/** Claim arbitration cannot accept an unbounded jump — see the header. */
export const LAMPORT_MAX_JUMP = 64;

export type TaskState = 'open' | 'claimed' | 'done' | 'failed';

/** One signed board event. `receivedAt` is stamped LOCALLY on arrival. */
export interface BoardEvent {
  eventId: string;
  taskId: string;
  peerId: string;
  kind: 'propose' | 'claim' | 'complete' | 'fail' | 'release';
  lamport: number;
  /** Monotonic per task; only the highest generation is authoritative. */
  generation: number;
  /** Duration for a claim, in ms. Ignored for other kinds. */
  leaseMs?: number;
  /** Human-facing title, carried on `propose`. */
  title?: string;
  /** When THIS machine saw the event. Never taken from the payload. */
  receivedAt: number;
}

export interface TaskView {
  taskId: string;
  title: string;
  state: TaskState;
  /** Who holds it, when claimed. */
  owner: string | null;
  /** Absolute local expiry, computed from receivedAt + leaseMs. */
  leaseExpiresAt: number | null;
  generation: number;
  lamport: number;
}

export interface BoardState {
  tasks: TaskView[];
  /** Events dropped by a rule, with the reason. Surfaced, never silent. */
  rejected: { eventId: string; reason: string }[];
}

interface Internal {
  taskId: string;
  title: string;
  state: TaskState;
  owner: string | null;
  claimedAt: number | null;
  leaseMs: number | null;
  generation: number;
  lamport: number;
  /** The winning event id, for deterministic tie-breaks. */
  eventId: string;
}

function stateFor(kind: BoardEvent['kind']): TaskState {
  switch (kind) {
    case 'claim': return 'claimed';
    case 'complete': return 'done';
    case 'fail': return 'failed';
    case 'release': return 'open';
    default: return 'open';
  }
}

/**
 * Fold events into board state.
 *
 * `now` is the observer's clock, used only to expire leases. Pure: no I/O, no
 * ambient time, no randomness — so two machines holding the same events and
 * asking at the same instant compute byte-identical output.
 */
export function fold(events: BoardEvent[], now: number): BoardState {
  const tasks = new Map<string, Internal>();
  const rejected: BoardState['rejected'] = [];
  const seen = new Set<string>();

  // Sorting first is what makes this fold permutation-invariant. Everything
  // downstream can then assume non-decreasing order per task.
  const ordered = [...events].sort((a, b) =>
    a.generation - b.generation
    || a.lamport - b.lamport
    || (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0)
    || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));

  let maxSeen = 0;
  for (const e of ordered) {
    // Duplicates are inert, not an error: at-least-once delivery is expected.
    if (seen.has(e.eventId)) { continue; }
    seen.add(e.eventId);

    if (!Number.isFinite(e.lamport) || e.lamport < 0) {
      rejected.push({ eventId: e.eventId, reason: 'lamport-invalid' });
      continue;
    }
    if (e.lamport > maxSeen + LAMPORT_MAX_JUMP) {
      // Inflation: a valid signature over an absurd clock would otherwise win
      // every future race forever.
      rejected.push({ eventId: e.eventId, reason: 'lamport-jump' });
      continue;
    }
    maxSeen = Math.max(maxSeen, e.lamport);

    const current = tasks.get(e.taskId);
    if (!current) {
      tasks.set(e.taskId, {
        taskId: e.taskId,
        title: e.title ?? e.taskId,
        state: stateFor(e.kind),
        owner: e.kind === 'claim' ? e.peerId : null,
        claimedAt: e.kind === 'claim' ? e.receivedAt : null,
        leaseMs: e.kind === 'claim' ? (e.leaseMs ?? null) : null,
        generation: e.generation,
        lamport: e.lamport,
        eventId: e.eventId,
      });
      continue;
    }

    // Events arrive here in non-decreasing (generation, lamport, peerId,
    // eventId) order, so the later event simply wins — no comparison needed.
    // A rival claim that is about to be overwritten is recorded, because "two
    // people claimed this" is real information for a standup rather than noise.
    if (current.state === 'claimed' && e.kind === 'claim' && current.owner !== e.peerId) {
      rejected.push({ eventId: current.eventId, reason: 'lost-arbitration' });
    }

    current.state = stateFor(e.kind);
    current.owner = e.kind === 'claim' ? e.peerId : null;
    current.claimedAt = e.kind === 'claim' ? e.receivedAt : null;
    current.leaseMs = e.kind === 'claim' ? (e.leaseMs ?? null) : null;
    current.generation = e.generation;
    current.lamport = e.lamport;
    current.eventId = e.eventId;
    if (e.title) { current.title = e.title; }
  }

  const views: TaskView[] = [];
  for (const t of tasks.values()) {
    const leaseExpiresAt = t.claimedAt !== null && t.leaseMs !== null ? t.claimedAt + t.leaseMs : null;
    // An expired lease frees the task with NO reaper and no heartbeat: every
    // observer reaches the same conclusion from its own clock. This is what
    // stops a dead participant blocking the frontier forever.
    const expired = t.state === 'claimed' && leaseExpiresAt !== null && now >= leaseExpiresAt;
    views.push({
      taskId: t.taskId,
      title: t.title,
      state: expired ? 'failed' : t.state,
      owner: expired ? null : t.owner,
      leaseExpiresAt,
      generation: t.generation,
      lamport: t.lamport,
    });
  }

  views.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  rejected.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  return { tasks: views, rejected };
}

/**
 * Render a standup.
 *
 * Deterministic and model-free by design: byte-identical on every machine,
 * costs nothing, and works while everyone is asleep. A generated summary would
 * be none of those things, and two people could not point at the same sentence
 * and know it derives from the same events.
 */
export function renderStandup(state: BoardState, now: number): string {
  const lines: string[] = [];
  const by = (s: TaskState) => state.tasks.filter(t => t.state === s);

  lines.push('## Standup');
  lines.push('');

  const done = by('done');
  lines.push(`### Done (${done.length})`);
  for (const t of done) { lines.push(`- ${t.title}`); }
  if (done.length === 0) { lines.push('- nothing yet'); }
  lines.push('');

  const claimed = by('claimed');
  lines.push(`### In progress (${claimed.length})`);
  for (const t of claimed) {
    const left = t.leaseExpiresAt !== null ? Math.max(0, Math.round((t.leaseExpiresAt - now) / 60_000)) : null;
    lines.push(`- ${t.title} — ${t.owner ?? 'unknown'}${left !== null ? ` (lease ${left}m left)` : ''}`);
  }
  if (claimed.length === 0) { lines.push('- nothing in flight'); }
  lines.push('');

  const open = by('open');
  lines.push(`### Open (${open.length})`);
  for (const t of open) { lines.push(`- ${t.title}`); }
  if (open.length === 0) { lines.push('- nothing open'); }

  const failed = by('failed');
  if (failed.length > 0) {
    lines.push('');
    lines.push(`### Needs attention (${failed.length})`);
    for (const t of failed) { lines.push(`- ${t.title}`); }
  }

  if (state.rejected.length > 0) {
    lines.push('');
    // Surfaced rather than hidden: a dropped event is information about the
    // network or about a misbehaving peer, and silently discarding it is how
    // a divergence goes unnoticed.
    lines.push(`_${state.rejected.length} event(s) dropped: ` +
      `${[...new Set(state.rejected.map(r => r.reason))].sort().join(', ')}_`);
  }

  return lines.join('\n');
}
