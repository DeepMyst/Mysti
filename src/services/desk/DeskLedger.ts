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
 * DeskLedger (Plan 21 Phase 5, invariant I20) — the consumed-effects ledger.
 *
 * ── The attack this exists to kill ─────────────────────────────────────────
 *
 * Delivery is at-least-once and applying a patch is not idempotent. P4-4: a
 * handoff arrives, the human approves it, the write lands; the carrier
 * redelivers on reconnect, or the human clicks Apply on a stale card, or a
 * second window replays the same artifact — and the patch goes down a SECOND
 * time, on top of edits the human made in between. Nothing about a signature,
 * a nonce window or a dedupe cache fixes that: a dedupe window forgets, and
 * the whole point of the attack is to come back after it has.
 *
 * So consumption is DURABLE and it is never forgotten. An effect this machine
 * has already applied is refused forever, and the refusal does not consult a
 * TTL, a window, or a counter.
 *
 * ── Why the third key field is baseSha, and why drift is a separate reason ─
 *
 * Refusing a replay is not enough on its own, because the interesting case is
 * not "identical write twice" — it is "write again against a tree that has
 * moved". `(peerId, effectId)` says WHAT was consumed; `baseSha` says WHAT IT
 * WAS CONSUMED AGAINST. When a re-apply is attempted at the same base, that is
 * a duplicate delivery and there is nothing for a human to decide: drop it.
 * When it is attempted at a DIFFERENT base, the tree has moved since — the
 * human has edited, or another effect landed — and re-applying would produce
 * a result nobody has reviewed. That needs a person, so it gets its own reason
 * and its own detail line.
 *
 * What this module deliberately will NOT do is rebase. Auto-rebasing a remote
 * patch onto a moved tree is a silent three-way merge of somebody else's
 * bytes into a human's uncommitted work, decided by a machine that cannot see
 * the diff. `base-drift` is a REFUSAL that names the recorded base, so the
 * decision surfaces on a card.
 *
 * Both branches are refusals, so I20 holds either way ("an already-consumed
 * effectId is refused, never re-applied, regardless of dedupe-window state").
 * The reason only tells the human which decision they are looking at.
 *
 * ── The contract for the caller ────────────────────────────────────────────
 *
 * The order is `check` -> gate + checkpoint + apply -> `record`, and a row
 * exists only for an effect this machine ACTUALLY APPLIED. So an unknown
 * (peerId, effectId) is `{ok:true}` — this ledger says nothing about whether
 * an artifact is well-formed, in scope, or approved; those are other gates,
 * and `ok:true` here means only "not consumed before".
 *
 * `check` IS A RESERVATION, not a query. An `{ok:true}` marks the key in
 * flight, and a second `check` for the same key refuses with `in-flight`
 * until the caller either `record`s it (consumed forever) or `release`s it
 * (the apply never happened). This is what closes the redelivery BURST: two
 * deliveries racing between `check` and `record` both used to be admitted,
 * and the append-only throw on the second `record` is damage reporting after
 * both patches have already landed. Callers must therefore treat `check` as
 * taking a lock, and must `release` on every path that does not apply.
 *
 * The consequence is that `base-drift` is measured against a RECORDED base,
 * never against a base a peer declared. The alternative — writing a pending
 * row at receive time carrying the sender's `baseSha`, so drift could be
 * detected for a never-applied effect — was rejected twice over: it makes an
 * inbound message write durable state (a remote storage-growth primitive
 * where there is currently none), and it makes a number the SENDER chose into
 * a stored bound, which is exactly what I17 forbids. What the tree is at right
 * now is the caller's own observation, and it is the only base this file will
 * compare against.
 *
 * ── Why check() re-reads the store, and why it refuses when it cannot ──────
 *
 * A second VSCode window is a second extension host over one `globalState`.
 * If `check` answered from memory alone, window A could apply an effect and
 * window B would still say "fresh" — the exact double-apply this file exists
 * to prevent, reachable without any hostile peer at all. `check` is therefore
 * synchronous over a synchronous store read, and merges what it finds before
 * deciding.
 *
 * A ledger that cannot READ its own store cannot prove an effect is
 * unconsumed, and "cannot prove" must not read as "fresh". Every unreadable
 * state below therefore fails CLOSED (`check` refuses everything, `record`
 * throws) rather than degrading to whatever happens to be in memory — after a
 * restart, "whatever is in memory" is nothing at all:
 *
 *   - the store read threw;
 *   - the stored blob is a shape this build does not recognise (an unknown
 *     `v`, an unknown top-level key, a non-object `entries`);
 *   - merging the stored blob threw;
 *   - more unreadable rows are held than this build will carry.
 *
 * The same rule governs WRITES, and that is the sharper half: a snapshot is
 * only ever written from a map that provably holds everything the store held.
 * The write here is a full replacement, so persisting from a partial map —
 * which is exactly what an in-memory map is after a swallowed read failure —
 * would not degrade the ledger, it would ERASE it, permanently, and hand back
 * every replay it had ever refused. `_persist` therefore re-reads and REJECTS
 * rather than writing whenever the state above is not provably complete.
 *
 * ── Why nothing is ever evicted ────────────────────────────────────────────
 *
 * Every row here asserts a filesystem effect, and I22 says effect-bearing rows
 * are append-only and never pruned. Eviction would not be a storage
 * optimisation — it would silently restore replayability for the oldest
 * effects, which is precisely the window an attacker waits for. Unbounded
 * growth is acceptable for PARSED rows (unlike in `DeskAudit`, which learned
 * this the hard way) because such a row is only ever created by a LOCAL HUMAN
 * approving an apply. There is no remote path that grows this store.
 *
 * `_unparsed` has no such argument — its rows come from whatever is in the
 * blob — so it is capped, and exceeding the cap is a REFUSAL rather than a
 * silent drop. Dropping would be the replay hole; growing without bound would
 * be the exhaustion primitive; refusing is the only option that is neither.
 *
 * Re-parsing every row on every call is avoided with a write STAMP: each write
 * carries a fresh per-instance-random token, and a read whose stamp matches
 * the last one this instance merged is known to hold nothing new. The token is
 * random rather than a counter on purpose — two windows would both mint
 * counter 5, and a collision there is a skipped merge, which is a double-apply.
 *
 * This module is pure: no vscode, no fs, no network. Persistence arrives as
 * the two-method `LedgerStore` below, exactly as `DeskPeerBook` does it, so
 * `tests/services/desk/importGraph.test.ts` keeps holding over this file.
 */

import {
  LIMITS,
  validateId,
  validateSha1,
  validateSha256,
} from './DeskContract';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One consumed effect. Written once, never updated, never deleted. */
export interface LedgerEntry {
  peerId: string;
  effectId: string;
  /** The tree state the effect was applied against (git sha1 or sha256). */
  baseSha: string;
  appliedAt: number;
  /** The checkpoint label, which must carry `desk:<peerId>:<effectId>`. */
  label: string;
}

/**
 * The persistence surface. Structurally a `vscode.Memento` minus `keys()` and
 * minus `setKeysForSync` — consumed-effects state is machine-local by
 * construction and must never ride settings sync to another device (I6): a
 * ledger synced from another machine would claim effects THIS tree never
 * applied, and refuse them.
 */
export interface LedgerStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/**
 * The answer `check` gives. There is no third "ok but…" case on purpose:
 * a partial or conditional yes is how a caller ends up applying anyway.
 *
 * `label` is a SEPARATE field rather than part of `detail` because `detail`
 * is rendered and logged as one line: a stored label is only lightly bounded
 * text, and interpolating it into the sentence a human reads is how a refusal
 * message becomes the forgery surface it exists to prevent.
 */
export type ApplyDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'replayed' | 'base-drift' | 'in-flight';
      detail: string;
      /** The recorded checkpoint label, when there is a readable row. */
      label?: string;
    };

const STORE_KEY = 'mysti.desk.ledger.v1';

/** The shape version this build writes and is willing to read. */
const LEDGER_VERSION = 1;

/**
 * The complete top-level key set. Anything else means a build that knew
 * something this one does not, so the blob is quarantined rather than
 * rewritten without it. A newer build MUST bump `v`.
 */
const ALLOWED_TOP_KEYS = new Set(['v', 'stamp', 'entries']);

/**
 * How many unreadable rows, and how many serialised bytes of them, this build
 * will carry. Reaching either is a hard refusal (see the header).
 */
const MAX_UNPARSED_ROWS = 1_000;
const MAX_UNPARSED_BYTES = 256 * 1024;

/**
 * Field separator inside the composite key. `|` is safe because `validateId`
 * admits only `[A-Za-z0-9_-]`, so neither half can contain it and the key is
 * unambiguous. A control character (the other obvious separator) is banned
 * outright by the house rules, and for good reason: a NUL in a persisted key
 * turns files binary and gets them dropped from review.
 */
const KEY_SEP = '|';

/** Keys that must never be written into a plain object map. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Persisted blob shape. Rows are self-describing; the key is derived. */
interface PersistedLedger {
  v: number;
  stamp: string;
  entries: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A git object id, accepting both sha1 and sha256 repositories.
 *
 * Uppercase hex is REFUSED rather than lowercased. Normalising would create
 * two spellings of one base, and this value is half of a lookup key — two
 * spellings means a replay slips through by changing case. `DeskContract`
 * refuses at the boundary for exactly this reason; the same rule applies here.
 */
function validateBaseSha(v: unknown): string | null {
  const asSha1 = validateSha1(v, 'baseSha');
  if (asSha1.ok) { return asSha1.value; }
  const asSha256 = validateSha256(v, 'baseSha');
  if (asSha256.ok) { return asSha256.value; }
  return null;
}

/**
 * The characters a checkpoint label may contain.
 *
 * An ALLOWLIST, not a denylist. The denylist this used to share with
 * `DeskContract` covers C0/C1, bidi and the common zero-widths, and misses a
 * long tail that matters precisely here: U+2028 and U+2029 are real line
 * breaks in JS and HTML (this string lands in a ONE-LINE checkpoint row, and a
 * line break there is the fence-header forgery), and U+2060, U+FE0F, U+00AD,
 * U+3164, U+2800 and the U+E0000 tag block are invisible carriers. Enumerating
 * that tail is a losing race; enumerating what a label legitimately needs is
 * not, because this value is MACHINE-GENERATED (`labelFor`) and only lightly
 * decorated with an alias or a task id, both of which are already ASCII.
 *
 * The cost is real and accepted: a label cannot carry non-ASCII text, so a
 * caller must not build one out of free-form human prose.
 */
const LABEL_CHARS_RE = /^[A-Za-z0-9 _.:@#/-]+$/;

/**
 * The canonical core every label must carry: `desk:<peerId>:<effectId>`.
 *
 * Requiring only the effectId (what this did before) is not addressability —
 * two peers may legitimately mint the SAME opaque effectId, so a label of
 * "undo handoff e_01JD7" resolves to two different checkpoints and "undo
 * bob's handoff" can rewind alice's. The peer half is not decoration.
 */
function canonicalLabel(peerId: string, effectId: string): string {
  return `desk:${peerId}:${effectId}`;
}

/**
 * A checkpoint label. A caller may decorate the canonical form — a prefix, a
 * suffix, an alias, a task id — but may not drop either half of it.
 */
function validateLabel(v: unknown, peerId: string, effectId: string): string | null {
  if (typeof v !== 'string') { return null; }
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > LIMITS.title) { return null; }
  if (!LABEL_CHARS_RE.test(trimmed)) { return null; }
  if (!trimmed.includes(canonicalLabel(peerId, effectId))) { return null; }
  return trimmed;
}

function keyFor(peerId: string, effectId: string): string {
  return `${peerId}${KEY_SEP}${effectId}`;
}

/**
 * The complete field set of a row. A row carrying anything else came from a
 * build that knew something this one does not, so it is held VERBATIM rather
 * than parsed — parsing it would silently trim the field the newer build
 * added, and the next write would persist the trimmed copy. Same rule as the
 * blob's top-level key set, one level down.
 */
const ROW_FIELDS = new Set(['peerId', 'effectId', 'baseSha', 'appliedAt', 'label']);

/** Parse one stored row, or null when it cannot be trusted as a row. */
function parseEntry(key: string, raw: unknown): LedgerEntry | null {
  if (!isPlainObject(raw)) { return null; }
  const r = raw;
  for (const field of Object.keys(r)) {
    if (!ROW_FIELDS.has(field)) { return null; }
  }

  const peerId = validateId(r.peerId, 'peerId');
  if (!peerId.ok) { return null; }
  const effectId = validateId(r.effectId, 'effectId');
  if (!effectId.ok) { return null; }
  const baseSha = validateBaseSha(r.baseSha);
  if (baseSha === null) { return null; }
  const label = validateLabel(r.label, peerId.value, effectId.value);
  if (label === null) { return null; }
  if (!isFiniteNumber(r.appliedAt) || r.appliedAt < 0) { return null; }

  // The row's own fields are authoritative; a key that does not follow from
  // them means the blob was hand-edited or corrupted. Re-keying instead would
  // silently merge two rows into one and lose a consumed effect.
  if (key !== keyFor(peerId.value, effectId.value)) { return null; }

  return Object.freeze({
    peerId: peerId.value,
    effectId: effectId.value,
    baseSha,
    appliedAt: r.appliedAt,
    label,
  });
}

/** Serialised size of one retained row, or null when it cannot be measured. */
function rowBytes(key: string, value: unknown): number | null {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== 'string') { return null; }
    return key.length + s.length;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DeskLedger
// ---------------------------------------------------------------------------

export class DeskLedger {
  private readonly _store: LedgerStore;
  private readonly _now: () => number;

  private _entries = new Map<string, LedgerEntry>();

  /**
   * Rows this build could not parse, kept verbatim and written back.
   *
   * Dropping them would be a downgrade-shaped replay hole: an older extension
   * loading a newer row shape would fail to parse it, omit it from its next
   * snapshot, and thereby FORGET a consumed effect — which is the one thing
   * this file must never do. They are inert (they can never match a parsed
   * row's fields) but they survive a write, they make `check` fail closed for
   * their key, and they OUT-RANK a parsed row at the same key on write: the
   * stored shape may be newer than anything this build can produce, and
   * replacing it with the older shape is the narrow case this map exists for.
   */
  private _unparsed = new Map<string, unknown>();
  private _unparsedBytes = 0;

  /**
   * Keys where a stored row and an in-memory row disagree on baseSha or label.
   *
   * The merge does NOT pick a winner by timestamp. A clamped clock produces
   * `appliedAt` 0, so "earliest wins" hands the merge to whichever window has
   * the most broken clock — and the thing being replaced is the checkpoint a
   * human may already be looking at. A disagreement is a fault: keep what is
   * held, and make `check` route the key to a person.
   */
  private _conflicts = new Set<string>();

  /**
   * Keys admitted by `check` and not yet recorded or released. In-process
   * only: this closes the redelivery burst inside one extension host, which
   * is the shape the threat model actually describes. Two hosts racing the
   * same millisecond is not closable over a `Memento` without a lock the
   * store does not offer, and is bounded by the cross-window re-read.
   */
  private _pending = new Set<string>();

  /** Non-null when the persisted state is not provably complete. */
  private _loadDetail: string | null = null;

  private _writeQueue: Promise<void> = Promise.resolve();

  /** The stamp of the last write this instance merged, or null for unknown. */
  private _seenStamp: string | null = null;
  private readonly _instanceTag: string;
  private _writeSeq = 0;

  constructor(store: LedgerStore, now?: () => number) {
    this._store = store;
    // `now` arrives as an option, and an explicit `undefined` — what a config
    // read of an unset key hands you — must land on the default rather than
    // on a `TypeError` at the first call.
    this._now = typeof now === 'function' ? now : Date.now;
    this._instanceTag =
      `${Math.floor(Math.random() * 0xffffffff).toString(36)}` +
      `${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
    this._refresh();
  }

  // -- clock ----------------------------------------------------------------

  /**
   * A timestamp that is always a finite, non-negative number.
   *
   * `appliedAt` bounds nothing — no expiry, no eviction, no window — so a
   * hostile clock cannot buy a replay here. It is display and ordering
   * metadata, and clamping it keeps a NaN out of the persisted blob (where it
   * would serialise to `null` through JSON and then fail `parseEntry`,
   * dropping a consumed effect on the next load).
   */
  private _nowMs(): number {
    let t: number;
    try {
      t = this._now();
    } catch (err) {
      console.error('[Mysti] DeskLedger: clock threw, recording appliedAt 0', err);
      return 0;
    }
    if (!isFiniteNumber(t) || t < 0) { return 0; }
    return t;
  }

  // -- persistence ----------------------------------------------------------

  /**
   * Why this ledger is not currently trustworthy, or null when it is.
   *
   * Every caller-facing method routes through this, so there is one place that
   * decides what "cannot prove" means and one sentence a human reads for it.
   */
  private _blockedReason(): string | null {
    if (this._loadDetail !== null) { return this._loadDetail; }
    if (this._unparsed.size > MAX_UNPARSED_ROWS || this._unparsedBytes > MAX_UNPARSED_BYTES) {
      return 'the consumed-effects ledger holds more unreadable rows than this build will carry, so it can neither prove nor preserve what it contains';
    }
    return null;
  }

  /**
   * Read the store and union whatever is there into memory. Never deletes.
   *
   * Returns false — and leaves `_loadDetail` set — when the stored state could
   * not be loaded. The caller must then refuse rather than proceed from
   * memory, because memory is a SUBSET of the truth and after a restart it is
   * the empty subset.
   */
  private _refresh(): boolean {
    let raw: unknown;
    try {
      raw = this._store.get<unknown>(STORE_KEY);
    } catch (err) {
      console.error('[Mysti] DeskLedger: store read failed', err);
      this._loadDetail = 'the consumed-effects ledger could not be read from storage, so this machine cannot prove the effect is unconsumed';
      return false;
    }
    // `_merge` walks attacker-adjacent JSON. It is inside the try because the
    // documented failure mode is a loud log and a refusal, and a throw
    // escaping here would instead propagate out of the constructor.
    try {
      return this._merge(raw);
    } catch (err) {
      console.error('[Mysti] DeskLedger: merging the stored ledger threw', err);
      this._loadDetail = 'the consumed-effects ledger could not be parsed, so this machine cannot prove the effect is unconsumed';
      return false;
    }
  }

  private _quarantine(what: string): false {
    console.error(`[Mysti] DeskLedger: refusing to use or overwrite the stored ledger — ${what}`);
    this._loadDetail = `the consumed-effects ledger is stored in a shape this build does not recognise (${what}); a newer build may have written it, so it will not be read from or written over`;
    return false;
  }

  /**
   * Union the stored blob into memory.
   *
   * The BLOB gets the same treatment as a row: an unrecognised container is
   * quarantined, not skipped. Skipping it made every row inside invisible AND
   * let the next write replace the whole thing — the downgrade hole the row
   * level was hardened against, one level up from where the guard sat.
   */
  private _merge(raw: unknown): boolean {
    // Absent (never written) and null (cleared) are an EMPTY ledger, not an
    // unreadable one. Refusing here would brick a machine that has simply
    // never applied a handoff.
    if (raw === undefined || raw === null) {
      this._loadDetail = null;
      this._seenStamp = null;
      return true;
    }
    if (!isPlainObject(raw)) { return this._quarantine('the stored value is not an object'); }
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_TOP_KEYS.has(key)) { return this._quarantine('the stored value carries an unknown top-level field'); }
    }
    const version = raw.v;
    if (version !== undefined && version !== LEDGER_VERSION) {
      return this._quarantine('the stored value carries an unknown version');
    }
    const entries = raw.entries;
    if (!isPlainObject(entries)) { return this._quarantine('the stored value has no readable entries map'); }

    // A stamp this instance has already merged means the blob has not changed
    // since; re-parsing every row would be the same answer at O(ledger) cost.
    // Only an EXACT match skips, and stamps carry per-instance randomness, so
    // another window's write can never be mistaken for our own.
    const stamp = typeof raw.stamp === 'string' ? raw.stamp : null;
    if (stamp !== null && this._seenStamp === stamp) {
      this._loadDetail = null;
      return true;
    }

    for (const [key, value] of Object.entries(entries)) {
      if (DANGEROUS_KEYS.has(key)) { continue; }
      const parsed = parseEntry(key, value);
      if (parsed === null) {
        // Retained even when a parsed row is held at the same key: the stored
        // shape may be NEWER than anything this build can write, and the write
        // path prefers this copy so a downgrade cannot flatten it.
        this._retainUnparsed(key, value);
        continue;
      }
      this._dropUnparsed(key);
      const existing = this._entries.get(key);
      if (!existing) {
        this._entries.set(key, parsed);
        continue;
      }
      if (existing.baseSha !== parsed.baseSha || existing.label !== parsed.label) {
        // Two rows for one consumed effect that do not agree on what was
        // applied or where the checkpoint is. Keep what is held and surface it.
        if (!this._conflicts.has(key)) {
          console.error(`[Mysti] DeskLedger: stored and in-memory rows disagree for ${key}; keeping the in-memory row and routing the key to a human`);
        }
        this._conflicts.add(key);
        continue;
      }
      // Identical rows: keep the earliest timestamp for a stable display
      // order. Nothing a human addresses depends on this branch.
      if (parsed.appliedAt < existing.appliedAt) { this._entries.set(key, parsed); }
    }
    this._seenStamp = stamp;
    this._loadDetail = null;
    return true;
  }

  private _retainUnparsed(key: string, value: unknown): void {
    this._dropUnparsed(key);
    const size = rowBytes(key, value);
    // An unmeasurable row is treated as over-cap rather than dropped: dropping
    // is the replay hole, and refusing is recoverable.
    this._unparsedBytes += size === null ? MAX_UNPARSED_BYTES + 1 : size;
    this._unparsed.set(key, value);
  }

  private _dropUnparsed(key: string): void {
    if (!this._unparsed.has(key)) { return; }
    const size = rowBytes(key, this._unparsed.get(key));
    this._unparsedBytes -= size === null ? MAX_UNPARSED_BYTES + 1 : size;
    if (this._unparsedBytes < 0) { this._unparsedBytes = 0; }
    this._unparsed.delete(key);
  }

  private _nextStamp(): string {
    this._writeSeq += 1;
    return `${this._writeSeq}.${this._instanceTag}`;
  }

  /**
   * Snapshot and write, one write at a time, re-reading first.
   *
   * The returned promise REJECTS on a store failure, and REFUSES TO WRITE AT
   * ALL when the re-read did not succeed. Both matter and for opposite
   * reasons. A `record()` that resolves without having written is the worst
   * outcome available: the caller believes the effect is consumed, the next
   * restart disagrees, and the patch applies a second time over whatever the
   * human did in between. A write from a map that could not be reconciled
   * with the store is worse still: this is a full-replacement write, so it
   * would delete every row this instance never managed to see.
   */
  private _persist(): Promise<void> {
    const step = this._writeQueue.then(async () => {
      this._refresh();
      const blocked = this._blockedReason();
      if (blocked !== null) {
        throw new Error(`[Mysti] DeskLedger: refusing to write — ${blocked}. Writing now would replace rows this build cannot see.`);
      }
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, entry] of this._entries) { out[key] = { ...entry }; }
      // Last, so an unreadable (possibly newer-shaped) row wins its key.
      for (const [key, value] of this._unparsed) { out[key] = value; }
      const stamp = this._nextStamp();
      const snapshot: PersistedLedger = { v: LEDGER_VERSION, stamp, entries: out };
      await this._store.update(STORE_KEY, snapshot);
      // Only after the write lands: a failed write leaves the store on some
      // other stamp, and claiming to have seen it would skip a real merge.
      this._seenStamp = stamp;
    });
    // The queue must survive a failed write (one hiccup would otherwise poison
    // every later write) while the CALLER still sees the failure, so the queue
    // chains a swallowed copy and the caller gets the real promise.
    this._writeQueue = step.catch(() => undefined);
    return step;
  }

  // -- the gate -------------------------------------------------------------

  /**
   * Check BEFORE applying, and RESERVE the key on the way through. Keyed by
   * (peerId, effectId, baseSha).
   *
   * `currentBaseSha` is the tree state the caller is about to apply against.
   * Fails closed on every malformed input: if the arguments cannot be keyed,
   * this ledger cannot prove the effect is unconsumed, and "cannot prove" must
   * not read as "fresh".
   *
   * An `{ok:true}` is a lock. Call `record` (the apply landed) or `release`
   * (it did not) — a caller that does neither cannot re-check that effect
   * until the window is reloaded.
   */
  check(peerId: string, effectId: string, currentBaseSha: string): ApplyDecision {
    const peer = validateId(peerId, 'peerId');
    const effect = validateId(effectId, 'effectId');
    const base = validateBaseSha(currentBaseSha);
    if (!peer.ok || !effect.ok || base === null) {
      // The field name is named; the VALUE never is. These arguments carry
      // remote-origin bytes, and this string is rendered on a card and written
      // to a log — echoing an unvalidated value there is how a refusal message
      // becomes the injection surface.
      const bad = [!peer.ok ? 'peerId' : null, !effect.ok ? 'effectId' : null, base === null ? 'baseSha' : null]
        .filter(Boolean).join(', ');
      return {
        ok: false,
        reason: 'replayed',
        // Deliberately 'replayed' and not 'base-drift' for malformed input:
        // 'base-drift' is an invitation to a human rebase decision, and
        // inviting a rebase on unparsable input is worse than a flat no.
        detail: `refused: malformed ${bad}; cannot key the consumed-effects ledger`,
      };
    }

    // Another window may have consumed this effect since we loaded.
    this._refresh();

    // A ledger that cannot read itself proves nothing, so it admits nothing.
    const blocked = this._blockedReason();
    if (blocked !== null) {
      return { ok: false, reason: 'base-drift', detail: `${blocked}; a human must decide` };
    }

    const key = keyFor(peer.value, effect.value);

    // A row we cannot read is still a row. It says this effect was consumed;
    // it just will not say at which base. Returning ok here would be the
    // downgrade-shaped replay hole `_unparsed` exists to close, so it fails
    // closed to the branch that puts a human in the loop.
    if (this._unparsed.has(key)) {
      return {
        ok: false,
        reason: 'base-drift',
        detail: `effect ${effect.value} from ${peer.value} has an unreadable ledger row; this machine cannot prove which base it was applied at, so a human must decide`,
      };
    }

    if (this._conflicts.has(key)) {
      return {
        ok: false,
        reason: 'base-drift',
        detail: `effect ${effect.value} from ${peer.value} has two disagreeing ledger rows; this machine cannot prove which base it was applied at, so a human must decide`,
      };
    }

    const prior = this._entries.get(key);
    if (prior) {
      if (prior.baseSha === base) {
        return {
          ok: false,
          reason: 'replayed',
          detail: `effect ${effect.value} from ${peer.value} was already applied at base ${prior.baseSha}`,
          label: prior.label,
        };
      }
      return {
        ok: false,
        reason: 'base-drift',
        detail: `effect ${effect.value} from ${peer.value} was applied at base ${prior.baseSha}, but the tree is now at ${base}; a human must decide`,
        label: prior.label,
      };
    }

    // The burst case: a redelivery that arrives while the first copy is still
    // between `check` and `record`. Without this, both are admitted and both
    // patches land; the append-only throw on the second `record` only reports
    // the damage afterwards.
    if (this._pending.has(key)) {
      return {
        ok: false,
        reason: 'in-flight',
        detail: `effect ${effect.value} from ${peer.value} is already being applied on this machine; the ledger will not admit it twice`,
      };
    }

    this._pending.add(key);
    return { ok: true };
  }

  /**
   * Give back a reservation `check` handed out, for the path where the apply
   * did NOT happen. A no-op for a key that is not reserved, and it never
   * touches a recorded row — releasing cannot resurrect a consumed effect.
   */
  release(peerId: string, effectId: string): void {
    const peer = validateId(peerId, 'peerId');
    const effect = validateId(effectId, 'effectId');
    if (!peer.ok || !effect.ok) { return; }
    this._pending.delete(keyFor(peer.value, effect.value));
  }

  /**
   * Append one consumed effect.
   *
   * Throws — rather than overwriting — when the key is already present. An
   * overwrite would move the recorded base and label out from under a rewind
   * that is already addressable, and it would hide the fact that something
   * applied an effect `check` had refused. A silent no-op was the other
   * option and is worse: it makes a double-apply bug invisible.
   *
   * Rejects when the write fails, or when the stored state cannot be read.
   * The in-memory entry is KEPT on the failed-write path: it is the stricter
   * of the two states (every later `check` in this session refuses), and the
   * caller sees the rejection and can rewind its checkpoint.
   */
  async record(entry: Omit<LedgerEntry, 'appliedAt'>): Promise<void> {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('[Mysti] DeskLedger.record: entry must be an object');
    }
    const peer = validateId(entry.peerId, 'peerId');
    if (!peer.ok) { throw new Error(`[Mysti] DeskLedger.record: ${peer.error}`); }
    const effect = validateId(entry.effectId, 'effectId');
    if (!effect.ok) { throw new Error(`[Mysti] DeskLedger.record: ${effect.error}`); }
    const base = validateBaseSha(entry.baseSha);
    if (base === null) {
      throw new Error('[Mysti] DeskLedger.record: baseSha must be 40 or 64 lowercase hex chars');
    }
    const label = validateLabel(entry.label, peer.value, effect.value);
    if (label === null) {
      throw new Error(
        `[Mysti] DeskLedger.record: label must be 1-${LIMITS.title} chars of [A-Za-z0-9 _.:@#/-] and must contain ${canonicalLabel(peer.value, effect.value)}`,
      );
    }

    const key = keyFor(peer.value, effect.value);
    this._refresh();
    // Refuse BEFORE mutating memory. Recording into a map that cannot be
    // reconciled with the store would leave the caller holding a row that the
    // write path is then obliged to refuse to persist.
    const blocked = this._blockedReason();
    if (blocked !== null) {
      throw new Error(`[Mysti] DeskLedger.record: ${blocked}`);
    }
    // `_unparsed` and a conflict count as recorded for the same reason `check`
    // refuses on them: overwriting a row this build merely failed to
    // understand would erase a consumption.
    if (this._entries.has(key) || this._unparsed.has(key) || this._conflicts.has(key)) {
      this._pending.delete(key);
      throw new Error(
        `[Mysti] DeskLedger.record: effect ${effect.value} from ${peer.value} is already recorded; the ledger is append-only`,
      );
    }

    this._entries.set(key, Object.freeze({
      peerId: peer.value,
      effectId: effect.value,
      baseSha: base,
      appliedAt: this._nowMs(),
      label,
    }));
    // The reservation has served its purpose: the row now refuses forever.
    this._pending.delete(key);
    await this._persist();
  }

  /**
   * Every effect consumed from one peer, oldest first.
   *
   * A malformed peerId yields an empty list rather than throwing: this is a
   * display surface, and `check` — never this — is the gate. Nothing may be
   * authorised from an empty result here, including when the store is
   * unreadable and this returns only what memory happens to hold.
   */
  entriesFor(peerId: string): LedgerEntry[] {
    const peer = validateId(peerId, 'peerId');
    if (!peer.ok) { return []; }
    // A second window's rows belong in this list too; a stale roster is how a
    // human ends up rewinding a checkpoint that is not the one they see.
    this._refresh();
    const out: LedgerEntry[] = [];
    for (const entry of this._entries.values()) {
      if (entry.peerId === peer.value) { out.push(Object.freeze({ ...entry })); }
    }
    // effectId breaks ties so the order is stable under a coarse or stopped
    // clock; two rows written in the same millisecond must not swap places
    // between two renders of the same list.
    out.sort((a, b) => (a.appliedAt - b.appliedAt) || a.effectId.localeCompare(b.effectId));
    return out;
  }

  /**
   * The canonical checkpoint label for one effect.
   *
   * Derived from the peerId AND the effectId — never from a position, an
   * index, or a timestamp — so "undo «bob»'s T-14 handoff" resolves to exactly
   * one checkpoint even after five more landed on top of it, and even when
   * another peer minted the same opaque effectId.
   *
   * Throws on a malformed id rather than returning a best-effort string: the
   * return value is written into a checkpoint label and rendered in a card,
   * and a label built from unvalidated remote bytes is a forgery surface.
   */
  labelFor(peerId: string, effectId: string): string {
    const peer = validateId(peerId, 'peerId');
    if (!peer.ok) { throw new Error(`[Mysti] DeskLedger.labelFor: ${peer.error}`); }
    const effect = validateId(effectId, 'effectId');
    if (!effect.ok) { throw new Error(`[Mysti] DeskLedger.labelFor: ${effect.error}`); }
    return canonicalLabel(peer.value, effect.value);
  }
}
