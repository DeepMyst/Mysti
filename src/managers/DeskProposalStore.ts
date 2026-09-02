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
 * DeskProposalStore (Plan 21 Phase 6, invariants I18/I19/I20/I21) - the
 * durable inbox of `assign` proposals, merged monotonically.
 *
 * -- Why this lives in managers/ and not services/desk/ --------------------
 *
 * `tests/services/desk/importGraph.test.ts` asserts that everything under
 * `src/services/desk/` reaches no capability. This module persists, so it
 * takes the same escape hatch `DeskPeerBook` takes: the vscode surface is
 * reduced to the two-method `ProposalStore` interface and the module sits
 * outside the scanned directory. The dispatcher never imports it.
 *
 * -- What a proposal is, and therefore what this file must not do ----------
 *
 * A proposal is paperwork: an item in a human's queue. It cannot execute, and
 * the maximum authority a peer has over this machine is causing a card. Two
 * consequences drive the whole design:
 *
 *   1. `state` is LOCAL. It is not in `receive`'s argument type and is never
 *      read off the wire. A peer proposes; a human (or lease expiry) decides.
 *      A remote message can only ever move a record's CONTENT forward.
 *   2. Nothing regresses. Not the generation, not the state, not across a
 *      second extension host sharing one `globalState`.
 *
 * -- A record is keyed by (author, proposalId), never by proposalId alone ---
 *
 * `proposalId` is a string a PEER chose. A store keyed on it alone puts every
 * peer in one namespace, and that single fact is two vulnerabilities:
 *
 *   - an ORACLE: "your id collided" and "your id was fresh" are different
 *     answers, so a peer can probe one id at a time for the existence of
 *     another peer's records - precisely the disclosure `followupFor` is
 *     built to prevent;
 *   - a DENIAL: a peer that registers an id first owns it, so pre-registering
 *     ids from a predictable scheme keeps another peer's proposals out of the
 *     human's queue entirely, with no card and no distinguishable error.
 *
 * So the map key is `${fromPeerId}/${proposalId}`. Neither component can
 * contain `/` (one is `PEER_ID_RE`, the other `validateId`), so the composite
 * is unambiguous, two peers can never contend for one row, and `followupFor`
 * becomes an isolation rather than a filter. It also means no attacker-chosen
 * string is ever an object key on the persistence path: every key begins with
 * a locally-derived `p_.../`, so `__proto__` as a proposalId is inert by
 * construction rather than by luck.
 *
 * -- Monotonic merge, copied from BackgroundJobManager._mergeJob -----------
 *
 * Two VSCode windows are two extension hosts over one store, so every write
 * re-reads and reconciles before it snapshots. The reconciliation is
 * FIELD-WISE monotonic rather than whole-record "newest wins", and that
 * distinction is load-bearing: window A declines a proposal (a terminal local
 * decision) while window B receives generation+1 of the same proposal. A
 * whole-record merge keyed on generation hands the win to B and resurrects a
 * declined proposal into the human's queue. Merging generation and state
 * independently - each by its own monotone rule - cannot.
 *
 * -- One mutation at a time (why there is a lock, not just a write queue) --
 *
 * `receive` is driven by a network dispatcher, so two of them overlapping is
 * the normal case. An earlier shape of this file queued only the WRITE and
 * snapshotted the shared `_items` inside the queued step: two overlapping
 * receives then shared one snapshot, the first step published BOTH records,
 * and when the second step's write failed the second caller rolled its record
 * out of memory and threw - while the record stayed durable on disk and came
 * back as a live card on the next reload. That inverts the invariant into its
 * worse direction: disk claiming a durability memory explicitly disclaimed.
 *
 * So the unit of serialization is the whole mutation - reconcile, decide,
 * mutate, write - not the write alone (`_serialize`). Every mutating entry
 * point runs inside it, which buys three things at once: a snapshot can only
 * ever contain the mutation it was taken for, the pre-write reconcile now
 * happens BEFORE the decision (so a stale window decides against fresh
 * facts), and a rollback restores exactly the state the disk still holds.
 *
 * -- Why the DeskBoard fold is not reused here -----------------------------
 *
 * `DeskBoard.fold` arbitrates CLAIMS over an append-only event log and is
 * permutation-invariant by sorting its whole input. That is the right shape
 * for contended task ownership and the wrong shape for a durable per-record
 * inbox: there is no event log to re-fold (the log would grow without bound
 * in `globalState`), and the authoritative `state` here is produced locally,
 * not derivable from remote events at all. What IS reused is the arbitration
 * discipline: `LAMPORT_MAX_JUMP` is imported rather than re-declared, leases
 * are durations expired on the observer's clock, a regression is dropped
 * rather than applied, and every tie is broken by a rule both windows compute
 * identically instead of by "whichever side I am reading from".
 *
 * -- Bounds are receiver-computed (I17) ------------------------------------
 *
 * `leaseMs` arrives from a peer, so it is clamped into a locally-configured
 * range; a sender-chosen 100-year lease is a proposal that never leaves the
 * queue. Every limit passes through `resolveDeskProposalLimits`, field by
 * field, never `{ ...DEFAULTS, ...opts }`: an explicit `undefined` (exactly
 * what an unset `cfg.get<number>()` yields) deletes the default, and the NaN
 * that follows makes `now >= receivedAt + leaseMs` false forever - a limit
 * that stops limiting with no error and no log line. The LOCAL configuration
 * is bounded too: no combination of settings may produce an immortal card or
 * a zero-sized count, because a limit that can be misconfigured into "no
 * limit" is not a limit.
 */

import type { DeskProposal } from '../types';
import { LIMITS, validateId, validateText } from '../services/desk/DeskContract';
import { LAMPORT_MAX_JUMP } from '../services/desk/DeskBoard';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One proposal as this machine holds it.
 *
 * `receivedAt` is the LOCAL arrival time of the authoritative generation and
 * is the only lease anchor - no absolute epoch from a sender is ever stored,
 * so a peer with a skewed or hostile clock cannot extend or shorten anything
 * (I18).
 */
export interface StoredProposal {
  proposalId: string;
  fromPeerId: string;
  title: string;
  detail: string;
  state: 'proposed' | 'accepted' | 'declined' | 'done' | 'expired';
  generation: number;
  lamport: number;
  leaseMs: number;
  receivedAt: number;
}

/**
 * Persistence surface: structurally a `vscode.Memento` minus `keys()` and
 * minus `setKeysForSync`. Desk state is machine-local by construction and
 * must never ride settings sync to another device (I6).
 */
export interface ProposalStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/** What `receive` did with a message. There is no "rejected" - that throws. */
export type ReceiveOutcome = 'accepted-new' | 'superseded' | 'stale-ignored';

/** Receiver-computed bounds. Nothing here is negotiable by a peer. */
export interface DeskProposalLimits {
  /** Floor for a clamped lease. Below this a proposal expires before it renders. */
  minLeaseMs: number;
  /** Ceiling for a clamped lease - the real defence against an immortal card. */
  maxLeaseMs: number;
  /** Used when a peer sends no usable duration at all. */
  defaultLeaseMs: number;
  /** Live records one peer may occupy. A per-peer cap, deliberately not global. */
  maxPerPeer: number;
  /** Items one `followupFor` page returns. */
  pageSize: number;
}

export const DESK_PROPOSAL_DEFAULT_LIMITS: Readonly<DeskProposalLimits> = Object.freeze({
  minLeaseMs: 60_000,
  maxLeaseMs: 7 * 24 * 60 * 60 * 1000,
  defaultLeaseMs: 24 * 60 * 60 * 1000,
  maxPerPeer: 200,
  pageSize: 50,
});

/**
 * The longest lease any LOCAL configuration may produce, whatever it asks for.
 *
 * `maxLeaseMs` is the only thing that eventually clears an undecided proposal,
 * so it needs a bound of its own: without one, a single mistyped `minLeaseMs`
 * (see `resolveDeskProposalLimits`) turns the ceiling into a floor of the same
 * absurd size and every card becomes immortal. Thirty days is far past any
 * plausible "I will get to it next month" and far short of forever.
 */
export const DESK_PROPOSAL_LEASE_HARD_CEILING_MS = 30 * 24 * 60 * 60 * 1000;

const STORE_KEY = 'mysti.desk.proposals.v1';

/**
 * The largest value `Date.now()` can ever return (the ECMA-262 time-value
 * range). Anything past it is a hand-edited store, not a clock reading.
 */
const MAX_TIMESTAMP = 8.64e15;

/**
 * The exact shape `peerIdFor` produces. `fromPeerId` is the key of a
 * DISCLOSURE boundary (`followupFor`) and half of every storage key, so it may
 * only ever be an identity this machine derived itself - never a free-form
 * string that arrived with a message and could be a 5 KB blob with a bidi
 * override in it.
 */
const PEER_ID_RE = /^p_[a-z2-7]{16}$/;

/**
 * The storage key of a record: author first, so a peer's rows sort together
 * and a peer's chosen id can never name another peer's row. `PEER_ID_RE` and
 * `validateId` both exclude `/`, so the two halves cannot be confused.
 */
function keyFor(fromPeerId: string, proposalId: string): string {
  return `${fromPeerId}/${proposalId}`;
}

function keyOf(r: StoredProposal): string {
  return keyFor(r.fromPeerId, r.proposalId);
}

/**
 * Merge and workflow order in one map.
 *
 * The security property is only that nothing returns to `proposed` or
 * `accepted`; the ordering AMONG terminal states exists so that two windows
 * reconciling `declined` against `done` reach the same answer instead of each
 * keeping its own (which is a permanent divergence, not a transient one).
 * `expired` sits below both human decisions on purpose: a mechanical
 * conclusion must not overwrite a human one.
 */
const STATE_RANK: Readonly<Record<StoredProposal['state'], number>> = Object.freeze({
  proposed: 0,
  accepted: 1,
  expired: 2,
  declined: 3,
  done: 4,
});

/** Rank at or above which a record is FINISHED and may be shed under quota. */
const TERMINAL_RANK = STATE_RANK.expired;

/**
 * Whether a record's lease is still running.
 *
 * Deliberately NOT `STATE_RANK[state] < TERMINAL_RANK`. The merge rank puts
 * `accepted` (1) below `expired` (2) so that a mechanical expiry can never
 * overwrite a human decision across two windows - but read as a lease
 * predicate that same ordering says an accepted proposal is still waiting for
 * an answer, and the reaper then overwrites the human's Accept with `expired`.
 * Because both `setState` and the merge are forward-only, that is not a
 * transient glitch: rank 1 can never climb back over rank 2, so the human's
 * own Accept becomes silently unrepeatable on the one state where work may
 * actually be in flight. Only an UNDECIDED proposal holds a lease.
 */
function holdsLease(state: StoredProposal['state']): boolean {
  return state === 'proposed';
}

interface PersistedProposals {
  items: Record<string, StoredProposal>;
  /**
   * Highest lamport ever accepted from each peer. Persisted rather than
   * recomputed from `items`, because pruning a peer's records would otherwise
   * lower its ceiling and start rejecting that peer's perfectly ordered
   * traffic forever.
   */
  lamportCeiling: Record<string, number>;
}

interface ParsedProposals {
  items: Map<string, StoredProposal>;
  lamportCeiling: Map<string, number>;
}

/** One inbound message after shape validation, before any state is consulted. */
interface ValidatedInbound {
  proposalId: string;
  fromPeerId: string;
  title: string;
  detail: string;
  generation: number;
  lamport: number;
  leaseMs: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isCounter(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isPeerId(v: unknown): v is string {
  return typeof v === 'string' && PEER_ID_RE.test(v);
}

export function isProposalState(v: unknown): v is StoredProposal['state'] {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATE_RANK, v);
}

/** A limit that must be strictly positive; anything else falls back. */
function positiveOr(v: unknown, fallback: number): number {
  return isFiniteNumber(v) && v > 0 ? v : fallback;
}

/**
 * A COUNT limit: a whole number, and never zero.
 *
 * Flooring alone is not enough. A configured 0.9 floors to 0, and zero is not
 * a smaller limit - it is a different program: `pageSize` 0 makes every page
 * empty and then indexes `page[-1]` for a cursor (an unhandled throw on a
 * peer-facing path), and `maxPerPeer` 0 refuses every proposal from every peer
 * forever. Neither is a configuration anyone means, so one is the floor.
 */
function countOr(v: unknown, fallback: number): number {
  return Math.max(1, Math.floor(positiveOr(v, fallback)));
}

/**
 * Complete a caller's partial limits, field by field.
 *
 * Rejected alternative: `{ ...DESK_PROPOSAL_DEFAULT_LIMITS, ...partial }`.
 * That form is why this function exists - see the file header. Ordering is
 * repaired too, because two individually valid numbers can still be jointly
 * nonsense - and the DIRECTION of that repair is a security decision, not a
 * coin flip. `min > max` is resolved by lowering the floor, never by raising
 * the ceiling: raising it would let a mistyped `minLeaseMs: 1e15` silently
 * become a 31,000-year ceiling, i.e. one typo in the field that bounds nothing
 * turning off the field that bounds everything. Lowering the floor can at
 * worst make cards expire sooner than intended, which is visible and
 * recoverable; raising the ceiling is neither.
 */
export function resolveDeskProposalLimits(partial?: Partial<DeskProposalLimits>): DeskProposalLimits {
  const p = partial ?? {};
  const d = DESK_PROPOSAL_DEFAULT_LIMITS;
  const maxLeaseMs = Math.min(DESK_PROPOSAL_LEASE_HARD_CEILING_MS, positiveOr(p.maxLeaseMs, d.maxLeaseMs));
  const minLeaseMs = Math.min(maxLeaseMs, positiveOr(p.minLeaseMs, d.minLeaseMs));
  const defaultLeaseMs = Math.min(maxLeaseMs, Math.max(minLeaseMs, positiveOr(p.defaultLeaseMs, d.defaultLeaseMs)));
  return {
    minLeaseMs,
    maxLeaseMs,
    defaultLeaseMs,
    maxPerPeer: countOr(p.maxPerPeer, d.maxPerPeer),
    pageSize: countOr(p.pageSize, d.pageSize),
  };
}

/**
 * Validate a record coming back off disk. Returns null on anything wrong.
 *
 * DROPPED, never repaired - the same discipline `DeskContract` uses at the
 * wire boundary. A repaired record teaches an attacker the shape of the
 * filter, and a repaired `state` in particular would let a hand-edited store
 * invent a value that no branch in this file handles.
 *
 * The two exceptions are the two halves of the LEASE, and they are exceptions
 * for the same reason: the store is a file a human (or anything running as the
 * human) can edit, the lease is the only thing that eventually clears an
 * undecided proposal, and dropping a record over a lease field would let one
 * edited number delete a real proposal out of the human's queue. So the lease
 * is re-bounded instead. `leaseMs` is re-clamped into the local range, and
 * `receivedAt` - which is the lease ANCHOR, and therefore exactly as good a
 * place to hand-edit an immortal card - is re-anchored to now when it sits in
 * the future. Note RE-ANCHORED, not dropped: a benign backwards clock step
 * (NTP) legitimately leaves stored records slightly ahead of `now`, and a
 * filter that deleted them would empty a real queue on a healthy machine.
 * Re-anchoring costs only the difference between the two clock readings.
 */
function validateStored(v: unknown, limits: DeskProposalLimits, now: number | null): StoredProposal | null {
  if (typeof v !== 'object' || v === null) { return null; }
  const r = v as Record<string, unknown>;
  const id = validateId(r.proposalId, 'proposalId');
  if (!id.ok) { return null; }
  if (!isPeerId(r.fromPeerId)) { return null; }
  const title = validateText(r.title, LIMITS.title, 'title');
  if (!title.ok) { return null; }
  const detail = validateText(r.detail, LIMITS.detail, 'detail');
  if (!detail.ok) { return null; }
  if (!isProposalState(r.state)) { return null; }
  if (!isCounter(r.generation) || !isCounter(r.lamport)) { return null; }
  // Past the time-value range there is no clock reading to reconcile against,
  // so this one IS a drop: it cannot be a skewed machine, only an edited file.
  if (!isFiniteNumber(r.receivedAt) || r.receivedAt < 0 || r.receivedAt > MAX_TIMESTAMP) { return null; }
  const receivedAt = now === null ? r.receivedAt : Math.min(r.receivedAt, now);
  const leaseMs = isFiniteNumber(r.leaseMs)
    ? Math.min(limits.maxLeaseMs, Math.max(limits.minLeaseMs, r.leaseMs))
    : limits.defaultLeaseMs;
  return {
    proposalId: id.value,
    fromPeerId: r.fromPeerId,
    title: title.value,
    detail: detail.value,
    state: r.state,
    generation: r.generation,
    lamport: r.lamport,
    leaseMs,
    receivedAt,
  };
}

/**
 * The content half of a record, as one comparable string.
 *
 * Used only to break an exact generation+receivedAt tie deterministically, so
 * that two windows reconciling equivocated content at the identical
 * millisecond reach the SAME answer. The natural-looking `disk <= mem ? disk :
 * mem` does not: "disk" is the OTHER window's record seen from either side, so
 * each window adopts the other's copy and the two swap forever.
 */
function contentKey(r: StoredProposal): string {
  return `${r.title.length}:${r.title}|${r.detail}`;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class DeskProposalStore {
  private readonly _store: ProposalStore;
  private readonly _now: () => number;
  private readonly _limits: DeskProposalLimits;
  /** Keyed by `keyFor(fromPeerId, proposalId)` - never by proposalId alone. */
  private _items = new Map<string, StoredProposal>();
  private _lamportCeiling = new Map<string, number>();
  /**
   * Tail of the mutation chain. Everything that changes `_items` runs on it,
   * one at a time - see "One mutation at a time" in the file header.
   */
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(store: ProposalStore, now: () => number = Date.now, limits?: Partial<DeskProposalLimits>) {
    this._store = store;
    this._now = now;
    this._limits = resolveDeskProposalLimits(limits);
    this._load();
  }

  // -- clock ---------------------------------------------------------------

  /**
   * The clock, or null when it cannot be read.
   *
   * A NaN clock poisons every comparison in this file: `now >= receivedAt +
   * leaseMs` is false for NaN, so nothing ever expires. Callers split on the
   * two answers deliberately - `expireLeases` treats an unreadable clock as
   * "past every deadline" (fail closed), while `receive` REFUSES, because a
   * record whose lease anchor is nonsense would be immortal no matter what
   * later readers do. A single sentinel cannot achieve both: any constant
   * that makes stored records expire also stamps new ones with itself, and
   * `c >= c + leaseMs` is false for every finite c.
   *
   * A clock is an injected `() => number`, so "unreadable" has two shapes and
   * both must arrive here as null. A THROWING clock (a wrapped or instrumented
   * one is at least as likely to throw as to return NaN) would otherwise
   * propagate straight out of `expireLeases` and expire NOTHING - the exact
   * inverse of the fail-closed behaviour documented above.
   */
  private _nowOrNull(): number | null {
    let t: unknown;
    try {
      t = this._now();
    } catch (err) {
      console.error('[Mysti] DeskProposalStore: clock threw, treating it as unreadable', err);
      return null;
    }
    return isFiniteNumber(t) ? t : null;
  }

  // -- loading -------------------------------------------------------------

  private _load(): void {
    let raw: unknown;
    try {
      raw = this._store.get<PersistedProposals>(STORE_KEY);
    } catch (err) {
      console.error('[Mysti] DeskProposalStore: store read failed, starting empty', err);
      return;
    }
    const parsed = this._parse(raw);
    this._items = parsed.items;
    this._lamportCeiling = parsed.lamportCeiling;
  }

  private _parse(raw: unknown): ParsedProposals {
    const items = new Map<string, StoredProposal>();
    const lamportCeiling = new Map<string, number>();
    if (typeof raw !== 'object' || raw === null) { return { items, lamportCeiling }; }
    const now = this._nowOrNull();
    const blob = raw as Partial<PersistedProposals>;
    const rows = blob.items;
    if (typeof rows === 'object' && rows !== null) {
      for (const [key, value] of Object.entries(rows)) {
        const rec = validateStored(value, this._limits, now);
        // The map key is not evidence, it is a CLAIM checked against the
        // record: a key that disagrees with the record's own author or id
        // could otherwise make one record answer to two ids, or file a record
        // under a peer that never sent it - which is precisely what
        // `followupFor` discloses on.
        if (!rec || keyOf(rec) !== key) {
          console.warn('[Mysti] DeskProposalStore: dropping unreadable stored proposal');
          continue;
        }
        items.set(key, rec);
      }
    }
    const ceilings = blob.lamportCeiling;
    if (typeof ceilings === 'object' && ceilings !== null) {
      for (const [key, value] of Object.entries(ceilings)) {
        if (!isPeerId(key) || !isCounter(value)) { continue; }
        lamportCeiling.set(key, value);
      }
    }
    return { items, lamportCeiling };
  }

  // -- persistence ---------------------------------------------------------

  /**
   * Run one mutation - reconcile, decide, mutate, write - with nothing else
   * touching `_items` in between. See the file header for what overlapping
   * mutations did to the durability invariant before this existed.
   *
   * The chain must survive a failure (one storage hiccup would otherwise
   * poison every later mutation), but the CALLER must still see it: the queue
   * keeps the swallowed copy and the caller gets the real promise.
   */
  private _serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this._writeQueue.then(work);
    this._writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Reconcile one disk record with our in-memory candidate, FIELD-WISE
   * monotonic (see the file header for why whole-record "newest wins" is
   * wrong here).
   *
   * Content follows the higher generation; on a tie the EARLIER observation
   * wins, so a re-delivery of a generation we already hold can never restart
   * a lease; on an exact tie of both, a content comparison that both windows
   * compute identically decides. State takes the higher rank independently, so
   * no window can resurrect another's terminal decision.
   *
   * There is deliberately no author check here: `_parse` binds every key to
   * the record's own `fromPeerId` and `_items` is only ever keyed by `keyOf`,
   * so two records under one key necessarily share an author. Re-checking it
   * would be a branch no input can reach and no test can pin.
   */
  private _mergeRecord(disk: StoredProposal, mem: StoredProposal): StoredProposal {
    const content = disk.generation > mem.generation ? disk
      : mem.generation > disk.generation ? mem
        : disk.receivedAt < mem.receivedAt ? disk
          : mem.receivedAt < disk.receivedAt ? mem
            : (contentKey(disk) <= contentKey(mem) ? disk : mem);
    const state = STATE_RANK[disk.state] > STATE_RANK[mem.state] ? disk.state : mem.state;
    return {
      ...content,
      state,
      generation: Math.max(disk.generation, mem.generation),
      lamport: Math.max(disk.lamport, mem.lamport),
    };
  }

  private _mergeFrom(parsed: ParsedProposals): void {
    // No "recently pruned" exception list is needed here, and that is a
    // consequence of the ordering rather than an oversight: a reconcile only
    // ever runs at the TOP of a mutation, before that mutation's own trim, and
    // a trim whose write fails is put back by `_unshed`. So a shed record is
    // either gone from disk already (nothing to re-adopt) or still legitimately
    // on it (and re-adopting is the honest answer - the shed was not durable).
    // Moving `_refresh` after the trim would reintroduce the need for one.
    for (const [key, rec] of parsed.items) {
      const mine = this._items.get(key);
      this._items.set(key, mine ? this._mergeRecord(rec, mine) : rec);
    }
    for (const [peerId, ceiling] of parsed.lamportCeiling) {
      this._lamportCeiling.set(peerId, Math.max(ceiling, this._lamportCeiling.get(peerId) ?? 0));
    }
  }

  /**
   * Fold whatever the other window has written into memory. Runs BEFORE the
   * decision, not merely before the write, so a stale window's `receive` is
   * judged against the facts that are actually durable.
   */
  private _refresh(): void {
    let stored: unknown;
    try {
      stored = this._store.get<PersistedProposals>(STORE_KEY);
    } catch (err) {
      // A failed READ must not throw away state we hold; keep ours as-is.
      console.error('[Mysti] DeskProposalStore: pre-write read failed, keeping local state', err);
      return;
    }
    if (typeof stored === 'object' && stored !== null) { this._mergeFrom(this._parse(stored)); }
  }

  /** Snapshot memory to disk. Only ever called from inside `_serialize`. */
  private async _writeSnapshot(): Promise<void> {
    const snapshot: PersistedProposals = {
      items: Object.fromEntries(this._items),
      lamportCeiling: Object.fromEntries(this._lamportCeiling),
    };
    await this._store.update(STORE_KEY, snapshot);
  }

  // -- quota ---------------------------------------------------------------

  /**
   * Shed finished records for ONE peer, oldest first, until it is under cap.
   * Returns what it shed, so a failed write can put it back.
   *
   * Rejected alternative: a global LRU like `BackgroundJobManager`'s
   * `MAX_PERSISTED`. Records here are attributable to a peer, so a global cap
   * is a cross-peer eviction primitive: one chatty peer would silently delete
   * another peer's proposals out of the human's queue. Live records - which
   * includes `accepted`, where work may be in flight - are never shed at all;
   * a peer at its cap is refused instead, which is visible.
   */
  private _trimPeer(peerId: string): StoredProposal[] {
    const mine = [...this._items.values()].filter(r => r.fromPeerId === peerId);
    // A pure readability guard: the loop below breaks immediately under cap.
    if (mine.length < this._limits.maxPerPeer) { return []; }
    const finished = mine
      .filter(r => STATE_RANK[r.state] >= TERMINAL_RANK)
      .sort((a, b) => a.receivedAt - b.receivedAt
        || (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0));
    const shed: StoredProposal[] = [];
    let live = mine.length;
    for (const rec of finished) {
      if (live < this._limits.maxPerPeer) { break; }
      this._items.delete(keyOf(rec));
      shed.push(rec);
      live--;
    }
    return shed;
  }

  /** Undo a trim whose write never landed, so memory matches disk again. */
  private _unshed(shed: StoredProposal[]): void {
    for (const rec of shed) { this._items.set(keyOf(rec), rec); }
  }

  // -- receive -------------------------------------------------------------

  /**
   * Take one inbound `assign` message.
   *
   * Throws on anything malformed or protocol-violating; the three returned
   * outcomes all mean "well-formed". Callers upstream have already run
   * `DESK_VERBS.assign.validate`, so a throw here is defence in depth against
   * a second call site that forgets to.
   *
   * Note what is NOT a parameter: `state`. A peer cannot set, and cannot
   * restore, the local decision on its own proposal. And note what a peer
   * cannot LEARN: rows are keyed by (author, id), so every outcome here is
   * computed from that peer's own records alone and no answer distinguishes
   * "this id was free" from "another peer already holds it".
   */
  async receive(p: Omit<StoredProposal, 'receivedAt' | 'state'>): Promise<ReceiveOutcome> {
    // Shape validation touches no shared state, so it stays outside the lock:
    // a malformed message is refused without queueing behind a slow write, and
    // still writes nothing.
    if (typeof p !== 'object' || p === null) { throw new Error('DeskProposalStore: proposal must be an object'); }
    const id = validateId(p.proposalId, 'proposalId');
    if (!id.ok) { throw new Error(`DeskProposalStore: ${id.error}`); }
    if (!isPeerId(p.fromPeerId)) { throw new Error('DeskProposalStore: fromPeerId is not a derived peer id'); }
    const title = validateText(p.title, LIMITS.title, 'title');
    if (!title.ok) { throw new Error(`DeskProposalStore: ${title.error}`); }
    const detail = validateText(p.detail, LIMITS.detail, 'detail');
    if (!detail.ok) { throw new Error(`DeskProposalStore: ${detail.error}`); }
    if (!isCounter(p.generation)) { throw new Error('DeskProposalStore: generation must be a non-negative safe integer'); }
    if (!isCounter(p.lamport)) { throw new Error('DeskProposalStore: lamport must be a non-negative safe integer'); }

    const inbound: ValidatedInbound = {
      proposalId: id.value,
      fromPeerId: p.fromPeerId,
      title: title.value,
      detail: detail.value,
      generation: p.generation,
      lamport: p.lamport,
      leaseMs: isFiniteNumber(p.leaseMs)
        ? Math.min(this._limits.maxLeaseMs, Math.max(this._limits.minLeaseMs, p.leaseMs))
        : this._limits.defaultLeaseMs,
    };
    return this._serialize(() => this._receiveLocked(inbound));
  }

  private async _receiveLocked(v: ValidatedInbound): Promise<ReceiveOutcome> {
    const now = this._nowOrNull();
    // No new durable state under an unreadable clock: `receivedAt` is the
    // lease anchor, and a proposal anchored to NaN never expires.
    if (now === null) { throw new Error('DeskProposalStore: local clock unreadable, refusing to anchor a lease'); }

    this._refresh();

    // I19: a lamport is a number a peer chose, so it is bounded against the
    // highest this machine has accepted FROM THAT PEER. Per-peer rather than
    // global, so one peer's clock cannot raise the ceiling another peer is
    // measured against.
    const hadCeiling = this._lamportCeiling.has(v.fromPeerId);
    const ceiling = this._lamportCeiling.get(v.fromPeerId) ?? 0;
    if (v.lamport > ceiling + LAMPORT_MAX_JUMP) {
      throw new Error('DeskProposalStore: lamport jump exceeds the accepted bound');
    }

    const key = keyFor(v.fromPeerId, v.proposalId);
    const existing = this._items.get(key);
    let outcome: ReceiveOutcome;
    let rollback: () => void;

    if (!existing) {
      const shed = this._trimPeer(v.fromPeerId);
      const mine = [...this._items.values()].filter(r => r.fromPeerId === v.fromPeerId).length;
      if (mine >= this._limits.maxPerPeer) {
        this._unshed(shed);
        throw new Error('DeskProposalStore: peer proposal quota exhausted');
      }
      this._items.set(key, {
        proposalId: v.proposalId,
        fromPeerId: v.fromPeerId,
        title: v.title,
        detail: v.detail,
        state: 'proposed',
        generation: v.generation,
        lamport: v.lamport,
        leaseMs: v.leaseMs,
        receivedAt: now,
      });
      rollback = () => { this._items.delete(key); this._unshed(shed); };
      outcome = 'accepted-new';
    } else if (v.generation > existing.generation && v.lamport >= existing.lamport) {
      const before = existing;
      this._items.set(key, {
        ...existing,
        title: v.title,
        detail: v.detail,
        generation: v.generation,
        lamport: v.lamport,
        leaseMs: v.leaseMs,
        // A new generation is a new lease, anchored now on OUR clock.
        receivedAt: now,
        // `state` is deliberately carried over, not reset. Reviving a
        // declined or expired proposal on a higher generation would be an
        // unbounded retry loop back into the human's queue, and the two are
        // indistinguishable to the sender, so it cannot even be limited to
        // the "harmless" one.
        state: existing.state,
      });
      rollback = () => { this._items.set(key, before); };
      outcome = 'superseded';
    } else {
      // Equal or lower generation, or a lamport regression: inert. Equal
      // generations are NOT tie-broken by lamport - two different bodies at
      // one generation is equivocation, and accepting the later arrival would
      // make the record depend on delivery order, which is exactly the
      // property `DeskBoard`'s fold refuses to give up. First observation
      // wins, and a real edit is a generation bump.
      return 'stale-ignored';
    }

    this._lamportCeiling.set(v.fromPeerId, Math.max(ceiling, v.lamport));
    try {
      await this._writeSnapshot();
    } catch (err) {
      // Memory must not claim a durability it does not have, and - the
      // costlier direction - disk must not claim one memory disclaimed. Both
      // hold because nothing else mutated `_items` between the snapshot and
      // here, so this restores exactly what the disk still holds.
      rollback();
      if (hadCeiling) { this._lamportCeiling.set(v.fromPeerId, ceiling); }
      else { this._lamportCeiling.delete(v.fromPeerId); }
      throw err;
    }
    return outcome;
  }

  // -- local decisions -----------------------------------------------------

  /**
   * Record the local decision on one peer's proposal.
   *
   * Takes the author as well as the id because a proposal id is a string a
   * PEER chose: two peers may legitimately both use `p001`, and the human's
   * Accept belongs to exactly one of the two cards in front of them.
   *
   * Forward-only. A non-advancing transition is a no-op rather than an error
   * (double-clicking Accept is not a fault), but an unknown id and an
   * out-of-enum state both throw: a state this file has no branch for must
   * never reach storage, which is how a non-enum value once fell through a
   * permission gate in this codebase.
   */
  async setState(fromPeerId: string, proposalId: string, state: StoredProposal['state']): Promise<void> {
    if (!isProposalState(state)) { throw new Error('DeskProposalStore: unknown proposal state'); }
    if (!isPeerId(fromPeerId)) { throw new Error('DeskProposalStore: fromPeerId is not a derived peer id'); }
    const id = validateId(proposalId, 'proposalId');
    if (!id.ok) { throw new Error(`DeskProposalStore: ${id.error}`); }
    const key = keyFor(fromPeerId, id.value);
    return this._serialize(async () => {
      this._refresh();
      const existing = this._items.get(key);
      if (!existing) { throw new Error(`DeskProposalStore: unknown proposal ${id.value}`); }
      if (STATE_RANK[state] <= STATE_RANK[existing.state]) { return; }
      this._items.set(key, { ...existing, state });
      try {
        await this._writeSnapshot();
      } catch (err) {
        this._items.set(key, existing);
        throw err;
      }
    });
  }

  /**
   * Expire every lease that has run out on THIS machine's clock, and return
   * how many changed.
   *
   * There is no reaper and no heartbeat protocol: every observer reaches the
   * same conclusion from `receivedAt + leaseMs` against its own clock (I18),
   * which is what stops a dead participant holding a queue slot forever.
   *
   * Only UNDECIDED proposals are reaped (`holdsLease`) - a human's Accept is
   * not something a timer gets to overwrite.
   *
   * An unreadable clock expires everything, and the in-memory result is kept
   * even if the write fails - unlike `receive`/`setState`, expiry is a
   * recomputable conclusion, and holding the STRICTER of the two states is
   * the safe side of a storage failure. That is also why the count is
   * RETURNED rather than lost to the rejection: a caller told only "it threw"
   * retries, gets 0 (memory has already expired them), and the number of cards
   * that just left the human's queue is gone for good.
   */
  async expireLeases(): Promise<number> {
    return this._serialize(async () => {
      const now = this._nowOrNull() ?? Number.MAX_SAFE_INTEGER;
      this._refresh();
      let changed = 0;
      for (const [key, rec] of this._items) {
        if (!holdsLease(rec.state)) { continue; }
        if (now >= rec.receivedAt + rec.leaseMs) {
          this._items.set(key, { ...rec, state: 'expired' });
          changed++;
        }
      }
      if (changed > 0) {
        try {
          await this._writeSnapshot();
        } catch (err) {
          console.error('[Mysti] DeskProposalStore: expiry held in memory only, write failed', err);
        }
      }
      return changed;
    });
  }

  // -- reads ---------------------------------------------------------------

  private static _clone(r: StoredProposal): StoredProposal { return { ...r }; }

  /**
   * The proposals a given peer SENT, paged.
   *
   * This is the `followup` verb's whole answer, so it is a disclosure
   * boundary rather than a convenience filter: the peer filter runs FIRST,
   * before the cursor is even looked at, so no cursor value can position into
   * another peer's records and no reply can reveal that another peer's
   * records exist.
   *
   * An invalid `peerId` or an invalid `cursor` returns the same empty page a
   * peer with no proposals gets. Deliberately not an error: a distinguishable
   * response is an oracle for probing which ids are well-formed. The
   * `isPeerId` guard is redundant with the filter below - nothing can make the
   * two disagree, so no test can tell them apart - and is kept only so that a
   * later edit to the filter cannot silently widen the boundary.
   *
   * Order is by `proposalId` ascending, which is immutable per record, so
   * paging cannot skip an item that a supersession moved. Rejected
   * alternative: ordering by `receivedAt`, which changes under supersession
   * and would need a composite cursor the wire contract (`validateId`) does
   * not carry. The cost is that a peer minting an id below its own cursor
   * will not see that item until it re-pages from the start - self-inflicted,
   * and it reaches nobody else's data.
   */
  followupFor(peerId: string, cursor?: string): { items: StoredProposal[]; nextCursor?: string } {
    if (!isPeerId(peerId)) { return { items: [] }; }
    // `undefined` is the sentinel and the branch below tests for it
    // explicitly. Using `null` and letting a rejected cursor fall through as
    // `undefined` would ALSO return an empty page - but by the accident of
    // `'a1' > undefined` being false, not by the refusal, so deleting the
    // refusal would read as correct while actually meaning "page one".
    let after: string | undefined;
    if (cursor !== undefined) {
      const c = validateId(cursor, 'cursor');
      if (!c.ok) { return { items: [] }; }
      after = c.value;
    }
    const from = after;
    const mine = [...this._items.values()]
      .filter(r => r.fromPeerId === peerId)
      .sort((a, b) => (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0));
    const rest = from === undefined ? mine : mine.filter(r => r.proposalId > from);
    const page = rest.slice(0, this._limits.pageSize).map(DeskProposalStore._clone);
    // `page.at(-1)` rather than `page[page.length - 1]`: an empty page must
    // yield no cursor, not a property read on `undefined`.
    const last = page.at(-1);
    const nextCursor = last !== undefined && rest.length > page.length ? last.proposalId : undefined;
    return nextCursor === undefined ? { items: page } : { items: page, nextCursor };
  }

  /**
   * Every proposal, for the local board and the local UI.
   *
   * CLONES, exactly as `followupFor` does. The local reader is not the trusted
   * one here: a live record handed out by reference lets any caller flip
   * `state` to `accepted` (forging a decision no human made) or raise
   * `leaseMs` past the ceiling - the clamp runs at receive and at load, never
   * again on an object already in the map.
   */
  list(): StoredProposal[] {
    return [...this._items.values()]
      .sort((a, b) => a.receivedAt - b.receivedAt
        || (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0)
        // The author breaks the last tie, because a proposalId is a string a
        // PEER chose: two peers may both use `p001` at the same millisecond,
        // and without this the order is insertion order - which differs
        // between two windows rendering one queue.
        || (a.fromPeerId < b.fromPeerId ? -1 : a.fromPeerId > b.fromPeerId ? 1 : 0))
      .map(DeskProposalStore._clone);
  }

  /**
   * Project one record onto the wire type. Kept here so the two shapes cannot
   * drift apart silently: `DeskProposal` carries no `state`, because a
   * caller's view of its own proposal is not this machine's decision record.
   *
   * `createdAt` is the one field travelling the OTHER way - outward, to the
   * peer - and it is coarsened to the hour on the way out. The precise value
   * is this machine's `Date.now()` at the moment of arrival, which is both a
   * clock-skew fingerprint and the exact lease anchor: a sender that knows the
   * anchor and the duration (it proposed the duration and can read the clamped
   * one back in the same record) knows the precise instant the card expires
   * here, and can time a re-delivery or a generation bump against it. An hour
   * is enough to order cards and not enough to schedule against one. The name
   * is the wire contract's, not this file's: it is an ARRIVAL time.
   */
  static toWire(r: StoredProposal): DeskProposal {
    const HOUR_MS = 60 * 60 * 1000;
    return {
      proposalId: r.proposalId,
      fromPeerId: r.fromPeerId,
      title: r.title,
      detail: r.detail,
      lamport: r.lamport,
      generation: r.generation,
      leaseMs: r.leaseMs,
      createdAt: Math.floor(r.receivedAt / HOUR_MS) * HOUR_MS,
    };
  }
}
