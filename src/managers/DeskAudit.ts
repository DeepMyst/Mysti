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
 * DeskAudit (Plan 21, invariant I22) — the join key and the split-retention
 * audit trail.
 *
 * ── Why one originId ───────────────────────────────────────────────────────
 *
 * The review's P4-7 finding was that the audit has no join key: an inbound
 * call, the permission decision it provoked, the checkpoint label, the
 * background job and the consumed-effects entry each land in a different
 * store, and nothing relates them. One `originId`, minted at the FIRST
 * cross-machine hop and stamped on every downstream row, is the whole fix —
 * `mysti.exportDeskAudit --origin=<id>` then yields a single causal chain.
 *
 * ── Why retention has THREE classes, not two ───────────────────────────────
 *
 * A `status` poll every minute would bury the one row that matters, so
 * something has to age out. But the rows that matter are exactly the ones a
 * naive "keep the last N" would evict first — they are the oldest. Retention
 * is therefore split by CONSEQUENCE:
 *
 *   permanent — the row asserts a filesystem or egress effect (or is one of
 *               this module's own integrity markers). NEVER aged out, NEVER
 *               evicted by any ceiling, even when permanent rows alone exceed
 *               every cap. This is I22, and it outranks every bound here.
 *   volatile  — inbound/outbound, effect-free, and a read-only high-frequency
 *               verb. Ages out at AUDIT_RETENTION_MS and is capped at
 *               AUDIT_MAX_VOLATILE_ROWS.
 *   retained  — everything else: an unknown verb, an unknown kind, a malformed
 *               effect block. Never ages out on time, but IS evictable at the
 *               AUDIT_MAX_ROWS ceiling, oldest first, and an eviction is
 *               recorded in the trail itself.
 *
 * The third class exists because the first version had only two, and the
 * fail-closed rule ("anything unrecognised is retained") therefore guaranteed
 * that hostile input landed on the *unbounded* side: a peer sending an
 * unrecognised verb produced a row that was never aged out, never counted
 * against the volatile cap and never evicted. 3000 such rows measured at
 * 909 KB of globalState and 1.36 GB written cumulatively, because every
 * `record()` re-serialises the whole array. Fail-closed retention is right;
 * fail-closed retention with no ceiling is a remote storage-exhaustion and
 * extension-host-stall primitive. Bounding the retained class — loudly, with a
 * marker row that admits the trail is incomplete — keeps the property that a
 * peer cannot make its own rows disappear quietly.
 *
 * The alternative considered and REJECTED was to drop rows whose verb failed
 * `DeskContract.validateCall`. A rejected call is exactly the thing worth
 * auditing, so dropping it hands an attacker the erasure it was denied.
 *
 * ── Why a row is frozen ────────────────────────────────────────────────────
 *
 * An audit row that can be edited after the fact is not an audit row. Rows are
 * deep-frozen on write and the caller's object is copied, never captured, so
 * neither the recorder nor a later reader can rewrite history in place.
 *
 * ── Why every field is sanitized but no row is ever dropped ────────────────
 *
 * `peerId`, `verb`, `detail` and the effect paths all originate on another
 * machine. They are clamped and stripped of control/bidi characters (so
 * `cat`ing an export cannot be used to spoof a terminal), but a hostile value
 * NEVER causes the row to be discarded — that would hand an attacker a way to
 * suppress their own audit trail by sending garbage.
 *
 * Critically, sanitization NEVER changes a row's retention class. The first
 * version decided retention from what survived scrubbing, which meant a peer
 * could send an effect whose paths were all bidi marks (they scrub to the
 * empty string, the effect block vanishes, the row becomes volatile) or a
 * `bytesOut` of -4096 (clamped to 0, egress fact erased, row becomes
 * volatile). Retention is now decided from what the CALLER ASSERTED, recorded
 * once in `effectAsserted` before anything is scrubbed or clamped.
 *
 * ── Why rejections are structural fields, not `detail` prefixes ────────────
 *
 * A rejected `originId` or `kind` used to be reported by prefixing the row's
 * `detail` with `origin-rejected:<value>`. `detail` is peer-controlled, so a
 * peer could author that exact string and plant a fabricated provenance claim
 * pointing at somebody else's chain. Rejections now live in `rejectedOrigin` /
 * `rejectedKind`, which `record()`'s parameter type does not accept and which
 * are only ever written inside `_sanitize`.
 *
 * This module deliberately holds no `vscode` import: the store is injected as
 * a two-method interface, which is what makes the fail-closed branches
 * testable without a window. The only non-type import is `crypto`.
 */

import { randomUUID } from 'crypto';
import type { DeskProtocolVerb, DeskVerb } from '../types';

export type AuditKind = 'inbound' | 'outbound' | 'permission' | 'effect' | 'refusal';

/** Which peer-supplied fields this module had to clip. See `truncated`. */
export const TRUNCATION_FIELDS = ['peerId', 'verb', 'detail', 'effect.path', 'effect.paths'] as const;
export type TruncatedField = (typeof TRUNCATION_FIELDS)[number];

export interface AuditRow {
  originId: string;
  kind: AuditKind;
  at: number;
  peerId: string;
  verb: string;
  /** Paths written or bytes out — the EFFECT, not just the decision. */
  effect?: { paths?: string[]; pathsTotal?: number; bytesOut?: number; sha256?: string };
  detail?: string;

  // ── fields written ONLY by DeskAudit itself ──────────────────────────────
  // None of these are accepted from `record()`: see `AuditRecord`. They are
  // the row's retention class and the record of what sanitizing had to do, so
  // a peer that could set them could choose its own retention.

  /**
   * The caller asserted a filesystem or egress effect, whether or not any of
   * it survived sanitizing. THIS, not the sanitized effect block, is what
   * makes a row permanent (I22).
   */
  effectAsserted?: true;
  /** The `kind` the caller supplied, when it was not a recognised kind. */
  rejectedKind?: string;
  /** The `originId` the caller supplied, when it was out of charset. */
  rejectedOrigin?: string;
  /** Peer-supplied fields this module clipped. Sorted, for byte-stability. */
  truncated?: TruncatedField[];
  /** This row is DeskAudit's own record of an audit-integrity event. */
  integrity?: true;
  /** On an integrity row: how many rows have been evicted, cumulatively. */
  evicted?: number;
}

/**
 * What a caller may record. The structural fields above are absent on purpose:
 * `record()` must not be able to be handed its own retention class, and a
 * caller must not be able to forge a rejection note.
 */
export type AuditRecord = Omit<
  AuditRow,
  'at' | 'effectAsserted' | 'rejectedKind' | 'rejectedOrigin' | 'truncated' | 'integrity' | 'evicted'
>;

/** The slice of `vscode.Memento` this needs. Injected so tests need no window. */
export interface AuditStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

export const DESK_AUDIT_KEY = 'mysti.desk.audit.rows';

/** Volatile rows older than this are eligible for pruning. 30 days. */
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on RETAINED VOLATILE rows only. Effect-bearing rows are never
 * counted against it and never dropped by it — a cap that could evict them
 * would silently defeat I22, which is the failure mode this constant exists
 * to prevent, not to cause.
 */
export const AUDIT_MAX_VOLATILE_ROWS = 2000;

/**
 * Hard ceiling on the TOTAL number of non-permanent rows held. Permanent rows
 * (I22) are exempt and may exceed it; everything else is evicted oldest-first
 * once the array grows past it, and the eviction is recorded.
 *
 * 5000 rather than something generous: every `record()` re-serialises the
 * whole array into globalState (a Memento has no append), so the ceiling is
 * also the bound on the cost of a single write. A larger ceiling would trade a
 * storage bound we need for a write cost we cannot afford.
 */
export const AUDIT_MAX_ROWS = 5000;

/** The chain id this module files its own integrity rows under. */
export const AUDIT_INTEGRITY_ORIGIN = 'o_audit';

/**
 * Verbs whose rows may age out. Read-only, content-free, high frequency.
 *
 * Typed as `ReadonlySet<DeskVerb | DeskProtocolVerb>` rather than
 * `Set<string>` so retention and the wire contract are checked against each
 * other by tsc: rename a verb in `src/types.ts` and this stops compiling.
 * Retention is exactly the policy that must not drift silently.
 *
 * `followup` and `consult` were considered and REJECTED: `followup` reveals
 * which proposals a peer was tracking and `consult` puts codebase-derived
 * prose on the wire, so both are consequential enough to keep. `cancel` is a
 * protocol verb but is likewise kept: "who cancelled whose run, and when" is
 * evidence. `hello` ages out — a handshake is effect-free and high-frequency.
 */
export const PRUNABLE_VERBS: ReadonlySet<DeskVerb | DeskProtocolVerb> =
  new Set<DeskVerb | DeskProtocolVerb>(['status', 'locate', 'hello']);

const KINDS = new Set<AuditKind>(['inbound', 'outbound', 'permission', 'effect', 'refusal']);

const MAX_DETAIL_CHARS = 2000;
const MAX_PATHS = 64;
const MAX_PATH_CHARS = 512;
const MAX_ID_CHARS = 128;
const MAX_ORIGIN_CHARS = 64;

/**
 * Stands in for a path that scrubbed away to nothing. A placeholder rather
 * than a dropped entry: dropping it would shorten the path list, and an empty
 * list is what used to flip an effect row to prunable.
 */
const UNPRINTABLE_PATH = '<unprintable>';

/** Lowercase hex, exactly 32 bytes. Anything else is not a sha256. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * An originId reaches a CLI flag (`--origin=<id>`) and a checkpoint label, so
 * its charset is constrained rather than merely escaped.
 */
const ORIGIN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * C0/C1 controls except tab and newline, plus the bidi overrides and marks.
 * Written as \uXXXX escapes on purpose: a literal control character in a
 * source file makes git treat the file as binary.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_TEXT_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * An unpaired surrogate — a high one not followed by a low, or a low one not
 * preceded by a high. Removed because a lone surrogate is not encodable as
 * UTF-8: it survives JSON.stringify as `\ud83d`, and a consumer writing an
 * export with a strict encoder either throws or silently mangles it, which
 * breaks the "two copies of one chain diff clean" guarantee.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A high surrogate left dangling by the length clamp itself. */
const TRAILING_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/;

function scrub(value: unknown, maxChars: number, field?: TruncatedField, marks?: Set<TruncatedField>): string {
  if (typeof value !== 'string') { return ''; }
  const clean = value.replace(UNSAFE_TEXT_RE, '').replace(LONE_SURROGATE_RE, '');
  if (clean.length <= maxChars) { return clean; }
  if (field && marks) { marks.add(field); }
  // Clamping can split a surrogate pair; drop the orphaned half.
  return clean.slice(0, maxChars).replace(TRAILING_HIGH_SURROGATE_RE, '');
}

/**
 * Describe a value that was rejected, so the reader sees what was sent rather
 * than only that something was. Non-strings are described by type: a caller
 * that sent `{}` where an id belongs is a different bug from one that sent a
 * bad string, and both are worth distinguishing from "sent nothing".
 */
function describeRejected(value: unknown, maxChars: number): string {
  if (value === undefined) { return '<missing>'; }
  if (value === null) { return '<null>'; }
  if (typeof value !== 'string') { return `<${typeof value}>`; }
  if (value.length === 0) { return '<empty>'; }
  return scrub(value, maxChars) || '<unprintable>';
}

/**
 * Did the CALLER assert a filesystem or egress effect? Answered from the RAW
 * block, before any scrubbing or clamping, because this decides the row's
 * retention class and sanitization must never be able to change that.
 *
 * Fail-closed throughout: an effect block we do not recognise counts as an
 * assertion, because "we could not parse what it claimed to have done" is not
 * a reason to let the row age out.
 */
function assertsEffect(raw: unknown): boolean {
  if (raw === undefined || raw === null) { return false; }
  // A string, a number, an array-with-properties: unrecognised, so retain.
  if (typeof raw !== 'object' || Array.isArray(raw)) { return true; }
  const src = raw as { paths?: unknown; bytesOut?: unknown; sha256?: unknown };
  if (Array.isArray(src.paths)) {
    if (src.paths.length > 0) { return true; }
  } else if (src.paths !== undefined) {
    return true;
  }
  // Any non-zero bytesOut, INCLUDING one that will clamp to 0 (-4096, 0.9) or
  // that is not finite. An honest literal 0 is not an egress.
  if (src.bytesOut !== undefined && src.bytesOut !== 0) { return true; }
  if (src.sha256 !== undefined) { return true; }
  return false;
}

function sanitizeEffect(raw: unknown, marks: Set<TruncatedField>): AuditRow['effect'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
  const src = raw as { paths?: unknown; bytesOut?: unknown; sha256?: unknown };
  const out: NonNullable<AuditRow['effect']> = {};

  if (Array.isArray(src.paths)) {
    // Slice BEFORE scrubbing. The other order runs the control/bidi regex over
    // every one of N peer-supplied strings at full length to keep 64 of them —
    // 200k paths x 2000 chars measured at 1.25 s inside one synchronous
    // record(), i.e. a cheap extension-host stall primitive.
    const kept = src.paths
      .slice(0, MAX_PATHS)
      // A path that scrubs to nothing becomes a placeholder rather than being
      // filtered out: dropping it could empty the list, which used to erase
      // the effect and silently flip the row to prunable.
      .map(p => scrub(p, MAX_PATH_CHARS, 'effect.path', marks) || UNPRINTABLE_PATH);
    if (kept.length > 0) { out.paths = kept; }
    if (src.paths.length > MAX_PATHS) {
      // "64 of N", not a bare 64: an investigator counting paths in an export
      // must not conclude a 1000-file handoff touched 64 files.
      out.pathsTotal = src.paths.length;
      marks.add('effect.paths');
    }
  }

  if (typeof src.bytesOut === 'number' && Number.isFinite(src.bytesOut)) {
    // Clamped, not rejected: a negative or fractional byte count is a caller
    // bug, and losing the FACT that bytes left the machine is worse than
    // recording a rounded number. The fact itself is carried by
    // `effectAsserted`, which is computed before this clamp.
    out.bytesOut = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(src.bytesOut)));
  }

  // A malformed digest is dropped rather than stored: an audit trail carrying
  // a hash that cannot be verified is worse than one that admits it has none.
  // The row still stays permanent — `assertsEffect` saw the field.
  const sha = typeof src.sha256 === 'string' ? src.sha256.toLowerCase() : '';
  if (SHA256_RE.test(sha)) { out.sha256 = sha; }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * True when this row's SANITIZED effect block still shows disk or wire.
 *
 * Kept as a fallback for rows built by hand (the predicate is exported and
 * callers pass literals); rows that went through `record()` carry
 * `effectAsserted`, which is authoritative. Fail-closed on anything odd: a
 * bytesOut that is not exactly 0 counts, so NaN or a negative literal retains.
 */
function hasEffect(effect: AuditRow['effect']): boolean {
  if (!effect) { return false; }
  return (effect.paths?.length ?? 0) > 0
    || (effect.bytesOut !== undefined && effect.bytesOut !== 0)
    || typeof effect.sha256 === 'string';
}

/**
 * Permanent rows are exempt from BOTH the age-out and every ceiling (I22).
 */
export function isPermanent(row: AuditRow): boolean {
  return row.integrity === true || row.effectAsserted === true || hasEffect(row.effect);
}

/**
 * Prunable iff PROVEN inconsequential. Every unrecognised shape falls through
 * to `false` (retain), which is the direction that cannot be weaponised.
 */
export function isVolatile(row: AuditRow): boolean {
  if (row.integrity === true) { return false; }
  if (row.kind !== 'inbound' && row.kind !== 'outbound') { return false; }
  if (row.effectAsserted === true) { return false; }
  if (hasEffect(row.effect)) { return false; }
  return PRUNABLE_VERBS.has(row.verb as DeskVerb | DeskProtocolVerb);
}

function freezeRow(row: AuditRow): AuditRow {
  if (row.effect) {
    if (row.effect.paths) { Object.freeze(row.effect.paths); }
    Object.freeze(row.effect);
  }
  if (row.truncated) { Object.freeze(row.truncated); }
  return Object.freeze(row);
}

interface CapResult {
  rows: AuditRow[];
  droppedVolatile: number;
  droppedRetained: number;
  volatileCount: number;
}

export class DeskAudit {
  private readonly _store: AuditStore;
  private readonly _now: () => number;
  private _rows: AuditRow[] = [];
  /**
   * Maintained incrementally. Recomputing it per write made `record()` O(n)
   * on the common path on top of the O(n) serialise, which is where the
   * quadratic blow-up came from.
   */
  private _volatile = 0;

  constructor(store: AuditStore, now: () => number = Date.now) {
    this._store = store;
    this._now = now;
    this._load();
  }

  /**
   * Mint the join key for a new causal chain. Called at the FIRST cross-machine
   * hop; every downstream row reuses the value.
   *
   * `crypto.randomUUID` rather than `Math.random`: the id ends up in a
   * user-facing export and a checkpoint label, and a guessable one would let a
   * peer stamp its rows into somebody else's chain. The v4 shape this produces
   * (version nibble, variant bits) is asserted in the tests, so swapping in a
   * PRNG fails loudly rather than passing a uniqueness check.
   */
  mintOriginId(): string {
    return `o_${randomUUID().replace(/-/g, '')}`;
  }

  /**
   * Append one row. `at` is stamped from the LOCAL clock — the parameter type
   * omits it precisely so a peer-supplied timestamp cannot be threaded in and
   * used to age a row out early, or to keep it forever.
   */
  async record(row: AuditRecord): Promise<void> {
    const now = this._clock();
    const stamped = this._sanitize({ ...row, at: now }, now, false);
    this._rows.push(stamped);
    if (isVolatile(stamped)) { this._volatile++; }

    // Enforce both ceilings inline. Unlike the first version this does not
    // delegate to prune(): prune() also ages rows out, and a write should not
    // silently perform a time-based deletion the caller did not ask for.
    if (this._volatile > AUDIT_MAX_VOLATILE_ROWS || this._rows.length > AUDIT_MAX_ROWS) {
      this._enforceCaps(now);
    }
    await this._persist();
  }

  /** Every row in this causal chain, in the order it was recorded. */
  chain(originId: string): AuditRow[] {
    // Validated, not merely truthy: every stored originId matched ORIGIN_RE at
    // write time, so an unmatchable query can only ever return []. ONE shared
    // predicate with exportChain, deliberately: two copies of this check meant
    // the copy here could be deleted without any test noticing, because the
    // other copy still refused. The filter key and the reported key must never
    // be able to diverge, so they must not be able to disagree either.
    if (!DeskAudit._queryable(originId)) { return []; }
    // Insertion order, NOT a sort on `at`: a clock that steps backwards (NTP,
    // suspend/resume) would otherwise reorder a chain whose causality we
    // already know from the order in which the rows arrived.
    return this._rows.filter(r => r.originId === originId);
  }

  all(): AuditRow[] {
    return this._rows.slice();
  }

  /**
   * Split retention: permanent rows are append-only and NEVER pruned.
   * Returns the number of rows dropped.
   */
  async prune(): Promise<number> {
    const now = this._clock();
    const kept: AuditRow[] = [];
    let agedOut = 0;
    for (const row of this._rows) {
      if (!isVolatile(row)) { kept.push(row); continue; }
      const age = now - row.at;
      // A future `at` (skewed clock) yields a negative age and is kept. A NaN
      // age — an unusable clock — keeps the row too: `NaN <= X` is false, so
      // the naive comparison alone would DELETE every volatile row the moment
      // the clock went bad. Age-out must fail closed.
      if (!Number.isFinite(age) || age <= AUDIT_RETENTION_MS) { kept.push(row); continue; }
      agedOut++;
    }
    this._rows = kept;

    const capped = this._enforceCaps(now);
    const dropped = agedOut + capped.droppedVolatile + capped.droppedRetained;
    if (agedOut > 0 || capped.droppedVolatile > 0) {
      console.log(`[Mysti] DeskAudit: pruned ${agedOut + capped.droppedVolatile} volatile row(s); ${this._rows.length} retained`);
    }
    if (dropped > 0) {
      await this._persist();
    } else {
      this._volatile = DeskAudit._countVolatile(this._rows);
    }
    return dropped;
  }

  /**
   * A canonical, byte-stable rendering of one chain.
   *
   * Deliberately carries NO generation timestamp and no host details: two
   * exports of the same chain must compare equal byte-for-byte, so a teammate
   * can diff the copy they were sent against the copy on the machine that
   * produced it. An "exportedAt" field was considered and rejected for exactly
   * that reason.
   */
  exportChain(originId: string): string {
    if (!DeskAudit._queryable(originId)) {
      // Refuse rather than scrub. Scrubbing the header meant `exportChain` of a
      // hostile id emitted `"originId": "o_a"` with zero rows — byte-identical
      // to a genuine export of an empty chain o_a, while the rows of the real
      // o_a were never queried. The filter key and the reported key must never
      // diverge; a document that names no chain and says why cannot be
      // mistaken for one that does.
      const rejected = {
        protocol: 'mysti.desk/1',
        originId: null,
        rejectedQuery: describeRejected(originId, MAX_ORIGIN_CHARS),
        rows: [],
      };
      return `${JSON.stringify(rejected, null, 2)}\n`;
    }

    const rows = this.chain(originId).map(r => {
      // Fixed key order, built explicitly — object key order is otherwise an
      // artifact of how each row happened to be constructed, which would make
      // two semantically identical exports differ.
      const out: Record<string, unknown> = {
        at: r.at,
        kind: r.kind,
        peerId: r.peerId,
        verb: r.verb,
      };
      if (r.effect) {
        const e: Record<string, unknown> = {};
        if (r.effect.paths) { e.paths = r.effect.paths; }
        if (r.effect.pathsTotal !== undefined) { e.pathsTotal = r.effect.pathsTotal; }
        if (r.effect.bytesOut !== undefined) { e.bytesOut = r.effect.bytesOut; }
        if (r.effect.sha256 !== undefined) { e.sha256 = r.effect.sha256; }
        out.effect = e;
      }
      // Everything the reader needs in order to distrust the row correctly.
      if (r.effectAsserted) { out.effectAsserted = true; }
      if (r.rejectedKind !== undefined) { out.rejectedKind = r.rejectedKind; }
      if (r.rejectedOrigin !== undefined) { out.rejectedOrigin = r.rejectedOrigin; }
      if (r.truncated) { out.truncated = r.truncated; }
      if (r.integrity) { out.integrity = true; }
      if (r.evicted !== undefined) { out.evicted = r.evicted; }
      if (r.detail !== undefined) { out.detail = r.detail; }
      return out;
    });
    const doc = { protocol: 'mysti.desk/1', originId, rows };
    return `${JSON.stringify(doc, null, 2)}\n`;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The local clock, guarded. An injected clock that returns NaN/Infinity
   * would otherwise poison every `at`, and a NaN `at` makes every arithmetic
   * comparison in prune() false — which is the fail-OPEN direction (rows get
   * deleted). Falling back to the real clock keeps rows dateable.
   */
  private _clock(): number {
    const t = this._now();
    if (typeof t === 'number' && Number.isFinite(t)) { return t; }
    const real = Date.now();
    return Number.isFinite(real) ? real : 0;
  }

  /**
   * Is this a chain id we could actually have stored? The single decision
   * point for both `chain()` and `exportChain()`.
   */
  private static _queryable(originId: unknown): originId is string {
    return typeof originId === 'string' && ORIGIN_RE.test(originId);
  }

  private static _countVolatile(rows: AuditRow[]): number {
    let n = 0;
    for (const row of rows) { if (isVolatile(row)) { n++; } }
    return n;
  }

  /**
   * Trim to both ceilings and record what that cost. Permanent rows are copied
   * through untouched even when they alone exceed AUDIT_MAX_ROWS — I22
   * outranks the ceiling.
   */
  private static _applyCaps(rows: AuditRow[]): CapResult {
    const volatileCount = DeskAudit._countVolatile(rows);
    let volatileExcess = Math.max(0, volatileCount - AUDIT_MAX_VOLATILE_ROWS);
    let totalExcess = Math.max(0, rows.length - AUDIT_MAX_ROWS);
    if (volatileExcess === 0 && totalExcess === 0) {
      return { rows, droppedVolatile: 0, droppedRetained: 0, volatileCount };
    }

    const out: AuditRow[] = [];
    let droppedVolatile = 0;
    let droppedRetained = 0;
    for (const row of rows) {
      const vol = isVolatile(row);
      if (vol && volatileExcess > 0) {
        volatileExcess--;
        if (totalExcess > 0) { totalExcess--; }
        droppedVolatile++;
        continue;
      }
      // Volatile rows are spent first at the total ceiling too: they are the
      // ones the policy already says may be lost.
      if (totalExcess > 0 && !isPermanent(row)) {
        totalExcess--;
        if (vol) { droppedVolatile++; } else { droppedRetained++; }
        continue;
      }
      out.push(row);
    }
    return { rows: out, droppedVolatile, droppedRetained, volatileCount: DeskAudit._countVolatile(out) };
  }

  private _enforceCaps(now: number): CapResult {
    const result = DeskAudit._applyCaps(this._rows);
    this._rows = result.rows;
    this._volatile = result.volatileCount;
    if (result.droppedRetained > 0) {
      // Volatile eviction is announced policy and only logged. Evicting a
      // RETAINED row is the trail admitting it is incomplete, so it goes into
      // the trail itself, where an export will show it.
      this._noteEviction(result.droppedRetained, now);
    }
    return result;
  }

  /**
   * Record cumulative retained-row eviction in a single marker row held at
   * index 0.
   *
   * One coalesced marker, not one per event: a peer that can drive eviction
   * can drive it once per `record()`, and a marker per event would recreate
   * the unbounded growth the ceiling exists to stop. The marker is permanent,
   * so it is never itself evicted and its index never moves.
   */
  private _noteEviction(dropped: number, now: number): void {
    const head = this._rows[0];
    const prior = head?.integrity === true ? (head.evicted ?? 0) : 0;
    const total = prior + dropped;
    const marker = freezeRow({
      originId: AUDIT_INTEGRITY_ORIGIN,
      kind: 'refusal',
      at: now,
      peerId: '',
      verb: 'audit.evicted',
      detail: `audit-truncated: ${total} non-permanent row(s) evicted at the ${AUDIT_MAX_ROWS}-row ceiling`,
      integrity: true,
      evicted: total,
    });
    if (head?.integrity === true) { this._rows[0] = marker; } else { this._rows.unshift(marker); }
    console.log(`[Mysti] DeskAudit: evicted ${dropped} retained row(s) at the ${AUDIT_MAX_ROWS}-row ceiling; ${total} cumulative`);
  }

  /**
   * @param fromStore true only on the load path. The structural fields
   * (`effectAsserted`, `rejectedOrigin`, `integrity`, …) are honoured only
   * then: on the store round trip they are this module's own output and losing
   * them would silently downgrade a row's retention class, whereas on the
   * record path the object is peer-influenced and must not be able to choose
   * its own class. A local attacker with globalState write access is out of
   * scope here — the threat this module defends against is a remote peer.
   */
  private _sanitize(raw: Partial<AuditRow> & { at: number }, fallbackAt: number, fromStore: boolean): AuditRow {
    const marks = new Set<TruncatedField>();

    // An unrecognised kind becomes `refusal` rather than a read-only kind: the
    // fallback must land on the retained side of `isVolatile`. It is no longer
    // SILENT — a fabricated "we refused this peer" that a defender reads as a
    // block we issued is a worse audit failure than a missing row.
    const kindOk = KINDS.has(raw.kind as AuditKind);
    const kind = kindOk ? raw.kind as AuditKind : 'refusal';
    const detail = scrub(raw.detail, MAX_DETAIL_CHARS, 'detail', marks);

    // A rejected originId neither loses the row nor collapses several bad ids
    // into one shared chain: the row gets a freshly minted id of its own and
    // the offending value is preserved in `rejectedOrigin`. NOT in `detail` —
    // `detail` is peer-authored, so a prefix convention there is forgeable.
    let originId = typeof raw.originId === 'string' ? raw.originId : '';
    let rejectedOrigin: string | undefined;
    if (!ORIGIN_RE.test(originId)) {
      rejectedOrigin = describeRejected(raw.originId, MAX_ORIGIN_CHARS);
      originId = this.mintOriginId();
    } else if (fromStore && typeof raw.rejectedOrigin === 'string' && raw.rejectedOrigin.length > 0) {
      rejectedOrigin = scrub(raw.rejectedOrigin, MAX_ORIGIN_CHARS) || undefined;
    }

    const at = typeof raw.at === 'number' && Number.isFinite(raw.at)
      ? raw.at
      : (Number.isFinite(fallbackAt) ? fallbackAt : 0);

    const row: AuditRow = {
      originId,
      kind,
      at,
      peerId: scrub(raw.peerId, MAX_ID_CHARS, 'peerId', marks),
      verb: scrub(raw.verb, MAX_ID_CHARS, 'verb', marks),
    };
    const effect = sanitizeEffect(raw.effect, marks);
    if (effect) { row.effect = effect; }
    if (assertsEffect(raw.effect) || (fromStore && raw.effectAsserted === true)) {
      row.effectAsserted = true;
    }
    if (!kindOk) { row.rejectedKind = describeRejected(raw.kind, MAX_ID_CHARS); }
    if (rejectedOrigin !== undefined) { row.rejectedOrigin = rejectedOrigin; }
    if (marks.size > 0) {
      // Emitted in the declared order, not insertion order, so the export of
      // one row is byte-identical however the row was assembled.
      row.truncated = TRUNCATION_FIELDS.filter(f => marks.has(f));
    }
    if (fromStore && raw.integrity === true) {
      row.integrity = true;
      const evicted = raw.evicted;
      row.evicted = typeof evicted === 'number' && Number.isFinite(evicted) && evicted >= 0
        ? Math.floor(evicted)
        : 0;
    }
    if (detail) { row.detail = detail; }
    return freezeRow(row);
  }

  private _load(): void {
    let stored: unknown;
    try {
      stored = this._store.get<unknown>(DESK_AUDIT_KEY);
    } catch (err) {
      console.log(`[Mysti] DeskAudit: store read failed, starting empty: ${err}`);
      return;
    }
    if (!Array.isArray(stored)) { return; }

    const rows: AuditRow[] = [];
    for (const entry of stored) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { continue; }
      const partial = entry as Partial<AuditRow>;
      // A persisted row with no usable `at` is dated 0, not "now": dating
      // unknown garbage to the present would make it un-prunable for another
      // 30 days.
      rows.push(this._sanitize({ ...partial, at: partial.at as number }, 0, true));
    }

    this._rows = rows;
    this._volatile = DeskAudit._countVolatile(rows);
    const capped = this._enforceCaps(this._clock());
    const dropped = capped.droppedVolatile + capped.droppedRetained;
    if (dropped > 0) {
      // Announced AND written back. Silently dropping rows at construction
      // left the store holding rows memory no longer had, so the next write
      // deleted them with no log line and nothing to attribute the loss to.
      console.log(`[Mysti] DeskAudit: dropped ${dropped} over-cap row(s) while loading; ${this._rows.length} retained`);
      // Floating on purpose: a constructor cannot await, and _persist() never
      // rejects — it logs and keeps the rows in memory.
      void this._persist();
    }
  }

  private async _persist(): Promise<void> {
    try {
      await this._store.update(DESK_AUDIT_KEY, this._rows);
    } catch (err) {
      // A failed write must not throw into the caller's request path and must
      // not lose the in-memory row: the trail stays complete for this session
      // and the next successful write re-persists the whole array.
      console.log(`[Mysti] DeskAudit: persist failed (${err}); ${this._rows.length} row(s) held in memory`);
    }
  }
}
