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
 * DeskPeerBook (Plan 21 Phase 2) — the roster and the authorization state.
 *
 * ── Why this lives in managers/ and not services/desk/ ─────────────────────
 *
 * Everything under `src/services/desk/` is asserted pure by
 * `tests/services/desk/importGraph.test.ts`, and this module has to persist.
 * Rather than weaken that assertion, the vscode surface is reduced to the
 * two-method `PeerStore` interface below and the module sits outside the
 * scanned directory. The dispatcher therefore never imports it; the caller
 * resolves authorization here first and hands the dispatcher a decided grant.
 *
 * ── The one idea ───────────────────────────────────────────────────────────
 *
 * Every number that bounds a peer is computed on THIS machine (I17). Nothing
 * in this file reads a limit, a counter, a deadline, or a budget out of
 * anything a peer sent. The only peer-supplied byte that reaches storage is
 * the public key, and even that is not trusted as an identity: `peerId` is
 * re-derived from it on every add and on every load, so a tampered store
 * cannot slide a new key under a pinned identity.
 *
 * "Computed on this machine" is only worth something if the numbers it is
 * computed FROM are themselves checked. `DeskPeerLimits` arrives from
 * machine-scoped configuration, and `vscode.workspace.getConfiguration()
 * .get<number>('unset.key')` returns `undefined` — which, object-spread over a
 * default, DELETES the default. Every field is therefore validated one at a
 * time in `resolveDeskPeerLimits` (never spread), because a single `undefined`
 * or `0` used to be enough to turn the rate limiter off silently and for good:
 * `NaN < 1` is false, `now >= NaN` is false, `bytes > NaN` is false. A limit
 * that stops limiting without saying so is the worst failure mode in the file.
 *
 * The injected clock gets the same treatment (`_nowMs`): a clock that returns
 * NaN would make every deadline comparison false, i.e. every peer immortal.
 *
 * ── Fail-closed everywhere ─────────────────────────────────────────────────
 *
 * Unknown peer, revoked peer, expired peer, corrupt stored record, exhausted
 * budget, exhausted call ceiling: all of them produce "no", never a default
 * "yes". Stored records that do not validate are DROPPED, not repaired —
 * the same discipline `DeskContract` uses at the wire boundary, for the same
 * reason: a repaired record teaches an attacker the shape of the filter.
 *
 * ── Persistence tells the truth ────────────────────────────────────────────
 *
 * A write failure propagates to the caller. `revoke()` that resolves without
 * having written anything is worse than no revocation at all: the human is
 * told the stolen key is dead and it is not. Mutations that GRANT authority
 * (pairing, TTL renewal) roll their in-memory effect back when the write
 * fails; mutations that CONSUME authority (revoke, spend) keep it, because
 * the in-memory state is then the stricter of the two.
 *
 * And the store is shared: a second VSCode window is a second extension host
 * over one `globalState`. Each queued write therefore re-reads and MERGES
 * before it snapshots, so two books cannot delete each other's tombstones.
 */

import type { DeskPeer, PeerGrant, DeskVerb } from '../types';
import {
  LIMITS,
  hasUnsafeChars,
  isDeskVerb,
  validateAlias,
  validatePath,
  validateText,
} from '../services/desk/DeskContract';
import { peerIdFor } from '../services/desk/DeskEnvelope';

// ---------------------------------------------------------------------------
// Injected surfaces
// ---------------------------------------------------------------------------

/**
 * The persistence surface. Structurally a `vscode.Memento` minus `keys()` and
 * minus `setKeysForSync` — Desk state is machine-local by construction and
 * must never ride settings sync to another device (I6).
 */
export interface PeerStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/** The answer `checkRate` gives. `retryAfterMs` is 0 exactly when allowed. */
export interface RateBucket {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Receiver-side bounds. Every field here comes from machine-scoped local
 * configuration; none of it is negotiable by a peer, which is why they are
 * constructor-injected rather than read from a request or from the grant
 * alone.
 *
 * Pass values through `resolveDeskPeerLimits` — the constructor does it for
 * you — rather than spreading a partial over the defaults.
 */
export interface DeskPeerLimits {
  /** Sliding peer lifetime, renewed only by local outbound activity. 60 d. */
  ttlMs: number;
  /**
   * The ceiling nothing can raise. Measured from `pairedAt`, so a peer that
   * keeps being talked to still dies and has to be re-paired by a human.
   */
  absoluteMaxLifetimeMs: number;
  /** Token-bucket size: the largest burst one peer may land. 0 = serve none. */
  rateCapacity: number;
  /** Time to refill the bucket from empty to `rateCapacity`. */
  rateRefillWindowMs: number;
  /**
   * The machine-wide serving pool, USD per UTC day. Default 0: serving costs
   * money, so the safe default is that nothing may be served until a human
   * funds it. `mysti.desk.servingBudgetUsdPerDay`.
   */
  servingBudgetUsdPerDay: number;
}

export const DESK_PEER_DEFAULT_LIMITS: Readonly<DeskPeerLimits> = Object.freeze({
  ttlMs: 60 * 24 * 60 * 60 * 1000,
  absoluteMaxLifetimeMs: 180 * 24 * 60 * 60 * 1000,
  rateCapacity: 20,
  rateRefillWindowMs: 60_000,
  servingBudgetUsdPerDay: 0,
});

/** A revocation tombstone. Kept forever: a revoked identity never returns. */
export interface DeskRevocation {
  peerId: string;
  reason: string;
  at: number;
}

/** Roster metadata that is NOT part of the wire identity. */
export interface DeskPeerRecord {
  peer: DeskPeer;
  grant: PeerGrant;
  /**
   * Display hint only (I13). Set when a peer re-registers with a new key. It
   * never transfers a pin, a grant, a budget, or a history — it exists so the
   * roster can say "this is the third alice-shaped identity you have seen".
   */
  rotatedFrom?: string;
  /** 1 for the first holder of an alias family, 2 for the next, … */
  aliasOrdinal: number;
  /** Base alias for the family, used to render "alice (2)". */
  aliasBase: string;
}

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

const STORE_KEY = 'mysti.desk.peerBook.v1';

interface LedgerRow {
  /** UTC day key, `YYYY-MM-DD`. */
  day: string;
  /** USD spent serving this peer on `day`. */
  usdToday: number;
  /** Calls served for this peer over the life of the grant. */
  callsLifetime: number;
}

interface PersistedBook {
  peers: Record<string, DeskPeerRecord>;
  revoked: Record<string, DeskRevocation>;
  ledger: Record<string, LedgerRow>;
}

/** The in-memory result of reading one stored blob. */
interface ParsedBook {
  peers: Map<string, DeskPeerRecord>;
  revoked: Map<string, DeskRevocation>;
  ledger: Map<string, LedgerRow>;
}

const RETENTION_CLASSES: readonly PeerGrant['minRetentionClass'][] =
  ['zero-retention', 'logged', 'training-permitted'];

/**
 * A locally-assigned secrets domain ("acme.com", "personal"). Locally typed,
 * but still constrained: it is rendered on every card and gates whether a git
 * ref may cross (I15).
 */
const TRUST_DOMAIN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The exact shape `peerIdFor` produces: `p_` + 16 base32 characters. Anything
 * else is not an identity this machine ever derived, so it may not be used as
 * a map key, a tombstone key or a ledger key. Without this, `revoke()` — which
 * the module documents as accepting an unknown peerId, i.e. one that can come
 * straight off the wire — would store an attacker-chosen 5 KB string with a
 * bidi override in it and hand it to the roster UI verbatim.
 */
const PEER_ID_RE = /^p_[a-z2-7]{16}$/;

/**
 * How far ahead of the local clock a stored `pairedAt` may sit before the
 * record is treated as tampered. `pairedAt` anchors the absolute-lifetime
 * ceiling, so a forward-dated one buys unlimited life; the only legitimate
 * reason for a small positive skew is the clock being corrected between the
 * write and the read.
 */
const PAIRED_AT_SKEW_MS = 60_000;

/** Substituted when a revocation reason cannot be rendered safely. */
const UNSAFE_REASON = 'reason withheld: unrenderable characters';

// ---------------------------------------------------------------------------
// Validation of anything that comes back off disk (or in through addPeer)
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPeerId(v: unknown): v is string {
  return typeof v === 'string' && PEER_ID_RE.test(v);
}

/** A limit that must be strictly positive; anything else falls back. */
function positiveOr(v: unknown, fallback: number): number {
  return isFiniteNumber(v) && v > 0 ? v : fallback;
}

/**
 * A limit where 0 is meaningful ("serve nothing"). A negative value is
 * nonsense, and the fail-closed reading of nonsense is 0, not the default —
 * defaulting would turn a typo into a widened bound.
 */
function nonNegativeOr(v: unknown, fallback: number): number {
  if (!isFiniteNumber(v)) { return fallback; }
  return v < 0 ? 0 : v;
}

/**
 * Turn a caller's partial limits into a complete, usable `DeskPeerLimits`.
 *
 * Field-by-field on purpose. `{ ...DEFAULTS, ...partial }` is the bug this
 * function exists to prevent: an explicit `undefined` — exactly what an unset
 * `cfg.get<number>('mysti.desk.…')` yields — overwrites the default, and the
 * `NaN` that follows makes every subsequent comparison false, i.e. every bound
 * stop bounding with no error and no log line.
 */
export function resolveDeskPeerLimits(partial?: Partial<DeskPeerLimits>): DeskPeerLimits {
  const p = partial ?? {};
  return {
    ttlMs: positiveOr(p.ttlMs, DESK_PEER_DEFAULT_LIMITS.ttlMs),
    absoluteMaxLifetimeMs: positiveOr(
      p.absoluteMaxLifetimeMs, DESK_PEER_DEFAULT_LIMITS.absoluteMaxLifetimeMs),
    // 0 means "refuse every inbound call", which is a legitimate local choice.
    rateCapacity: nonNegativeOr(p.rateCapacity, DESK_PEER_DEFAULT_LIMITS.rateCapacity),
    // 0 would make `capacity / window` Infinity, then `elapsed * Infinity`
    // NaN, then `NaN < 1` false: the bucket would allow everything forever.
    rateRefillWindowMs: positiveOr(
      p.rateRefillWindowMs, DESK_PEER_DEFAULT_LIMITS.rateRefillWindowMs),
    servingBudgetUsdPerDay: nonNegativeOr(
      p.servingBudgetUsdPerDay, DESK_PEER_DEFAULT_LIMITS.servingBudgetUsdPerDay),
  };
}

/**
 * Validate a peer. Returns null on anything wrong.
 *
 * The `peerIdFor` re-derivation is the load-bearing line: identity is the key
 * fingerprint (I12), so a record whose `peerId` does not follow from its
 * `publicKey` is either corrupt or an attempt to inherit another identity's
 * pin, and both answers are "drop it".
 *
 * `nowMs` is required because `pairedAt` is not merely a display field: it is
 * the anchor of the absolute-lifetime ceiling (`pairedAt + absoluteMax`), so a
 * record that claims to have been paired in the year 3000 clamps to nothing
 * and lives forever. Bounding it here is the actual defence the load-time
 * re-clamp was believed to be.
 */
function validatePeer(v: unknown, nowMs: number): DeskPeer | null {
  if (typeof v !== 'object' || v === null) { return null; }
  const p = v as Record<string, unknown>;
  const alias = validateAlias(p.alias);
  if (!alias.ok) { return null; }
  if (typeof p.publicKey !== 'string' || p.publicKey.length === 0 || p.publicKey.length > 2048) { return null; }
  if (hasUnsafeChars(p.publicKey) || !/^[A-Za-z0-9+/=]+$/.test(p.publicKey)) { return null; }
  // Canonical base64 only. `Buffer.from` ignores padding errors and trailing
  // junk, so without this many distinct strings denote one key: the pinned
  // string that gets rendered and re-exported could carry padding noise the
  // peer chose, and `addRotatedPeer`'s "must be a different key" guard — a
  // string comparison — would be comparing spellings rather than keys.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(p.publicKey, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.toString('base64') !== p.publicKey) { return null; }
  if (!isPeerId(p.peerId)) { return null; }

  let derived: string;
  try {
    derived = peerIdFor(p.publicKey);
  } catch {
    return null;
  }
  if (derived !== p.peerId) { return null; }

  // Not `validateText`: that permits newlines (legitimate in a question body,
  // fatal in a one-line roster row and in a fence header).
  if (typeof p.trustDomain !== 'string' || !TRUST_DOMAIN_RE.test(p.trustDomain)) { return null; }
  if (!isFiniteNumber(p.pairedAt) || p.pairedAt < 0) { return null; }
  // A FUTURE `pairedAt` is deliberately NOT dropped here.
  //
  // It used to be, and that was destructive: `_parse` feeds both `_load` and
  // the pre-write merge in `_persist`, so a benign backwards clock step — a
  // suspend/resume, a VM snapshot restore, an NTP correction — made every
  // record fail this check, and the next unrelated write then persisted a
  // roster without them. Pairings that took a two-sided human ceremony were
  // gone permanently, and anyone able to nudge the host clock had a cheap
  // way to force it.
  //
  // Refusing to AUTHORIZE under a suspect clock is the security property, and
  // `getGrant` already does exactly that — so dropping the row bought nothing
  // and cost the roster. Data is preserved; authority is denied.
  if (!isFiniteNumber(p.expiresAt)) { return null; }

  return {
    peerId: p.peerId,
    alias: alias.value,
    publicKey: p.publicKey,
    trustDomain: p.trustDomain,
    pairedAt: p.pairedAt,
    expiresAt: p.expiresAt,
  };
}

function validateGrant(v: unknown, peerId: string): PeerGrant | null {
  if (typeof v !== 'object' || v === null) { return null; }
  const g = v as Record<string, unknown>;
  // A grant that names a different peer is not a grant for this peer. Binding
  // it anyway is precisely how a confused-deputy grant swap would work.
  if (g.peerId !== peerId) { return null; }

  if (!Array.isArray(g.verbs) || g.verbs.length > LIMITS.arrayItems) { return null; }
  const verbs: DeskVerb[] = [];
  for (const raw of g.verbs) {
    if (!isDeskVerb(raw)) { return null; }
    if (!verbs.includes(raw)) { verbs.push(raw); }
  }

  if (!Array.isArray(g.scope) || g.scope.length > LIMITS.arrayItems) { return null; }
  const scope: string[] = [];
  for (const raw of g.scope) {
    const r = validatePath(raw, 'scope');
    if (!r.ok) { return null; }
    scope.push(r.value);
  }

  if (!isFiniteNumber(g.expiresAt)) { return null; }
  if (!isFiniteNumber(g.budgetUsd) || g.budgetUsd < 0) { return null; }
  if (!isFiniteNumber(g.maxCalls) || g.maxCalls < 0 || !Number.isInteger(g.maxCalls)) { return null; }
  if (typeof g.minRetentionClass !== 'string') { return null; }
  if (!RETENTION_CLASSES.includes(g.minRetentionClass as PeerGrant['minRetentionClass'])) { return null; }

  return {
    peerId,
    verbs,
    scope,
    expiresAt: g.expiresAt,
    budgetUsd: g.budgetUsd,
    maxCalls: g.maxCalls,
    minRetentionClass: g.minRetentionClass as PeerGrant['minRetentionClass'],
  };
}

/** UTC, not local time: a DST boundary would otherwise mint a 23- or 25-hour budget day. */
function utcDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// DeskPeerBook
// ---------------------------------------------------------------------------

interface Bucket {
  /** Fractional tokens remaining. */
  tokens: number;
  /** Last instant the bucket was refilled, on the clamped clock. */
  lastMs: number;
}

export class DeskPeerBook {
  private readonly _store: PeerStore;
  private readonly _now: () => number;
  private readonly _limits: DeskPeerLimits;

  private _peers = new Map<string, DeskPeerRecord>();
  private _revoked = new Map<string, DeskRevocation>();
  private _ledger = new Map<string, LedgerRow>();

  /**
   * Rate state is deliberately memory-only. Persisting a token bucket would
   * mean a disk write on every inbound call, and the bucket is a burst
   * smoother, not the spend control — the currency ledger below is persisted
   * and is the hard stop. A host restart therefore hands every peer a fresh
   * burst allowance, which a peer cannot trigger.
   */
  private _buckets = new Map<string, Bucket>();

  /**
   * Serializes writes WITHIN this instance. Without it, two overlapping
   * mutations can land out of order and the older snapshot wins; each queued
   * step re-snapshots from the in-memory state after re-reading the store, so
   * the last write is always the newest state.
   */
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(store: PeerStore, now: () => number = Date.now, limits?: Partial<DeskPeerLimits>) {
    this._store = store;
    this._now = now;
    this._limits = resolveDeskPeerLimits(limits);
    this._load();
  }

  /**
   * The clock, forced finite.
   *
   * An injected clock that returns NaN or Infinity would poison every
   * comparison in this file — `now >= expiresAt` is FALSE for NaN, so every
   * peer would be immortal and every bucket bottomless. A clock that cannot be
   * read is therefore treated as "past every deadline", which denies.
   *
   * Rejected alternative: throwing. `getGrant` is a synchronous authorization
   * chokepoint; an exception there is indistinguishable upstream from an
   * outage, and an outage that someone catches would read as "no answer yet"
   * rather than "no". Deny is the only answer that is still safe when ignored.
   */
  private _nowMs(): number {
    const t = this._now();
    return isFiniteNumber(t) ? t : Number.MAX_SAFE_INTEGER;
  }

  // -- loading ------------------------------------------------------------

  private _load(): void {
    let raw: unknown;
    try {
      raw = this._store.get<PersistedBook>(STORE_KEY);
    } catch (err) {
      console.error('[Mysti] DeskPeerBook: store read failed, starting empty', err);
      return;
    }
    const parsed = this._parse(raw, this._nowMs());
    this._peers = parsed.peers;
    this._revoked = parsed.revoked;
    this._ledger = parsed.ledger;
  }

  /**
   * Read one stored blob into validated state. Used by `_load` AND by every
   * queued write (which re-reads before it snapshots), so there is exactly one
   * place that decides what a stored row is allowed to mean.
   *
   * Typed as unknown-valued maps, not as `PersistedBook`: this data came off
   * disk and may have been edited, so the persisted TYPE is a claim, not a
   * fact. Every row is re-validated here.
   */
  private _parse(raw: unknown, nowMs: number): ParsedBook {
    const out: ParsedBook = { peers: new Map(), revoked: new Map(), ledger: new Map() };
    if (typeof raw !== 'object' || raw === null) { return out; }
    const book = raw as { peers?: unknown; revoked?: unknown; ledger?: unknown };

    if (typeof book.revoked === 'object' && book.revoked !== null) {
      for (const [peerId, row] of Object.entries(book.revoked as Record<string, unknown>)) {
        // A key that is not a derived peerId can never match a real identity,
        // so admitting it only gets an attacker-shaped string onto the roster.
        if (!isPeerId(peerId)) { continue; }
        if (typeof row !== 'object' || row === null) { continue; }
        const r = row as Record<string, unknown>;
        // `hasUnsafeChars` covers tab/newline/CR as well as bidi and
        // zero-width, which is why it is used here instead of `validateText`.
        const reason = typeof r.reason === 'string' && !hasUnsafeChars(r.reason)
          ? r.reason.slice(0, LIMITS.title)
          : UNSAFE_REASON;
        out.revoked.set(peerId, {
          peerId,
          reason,
          at: isFiniteNumber(r.at) ? r.at : 0,
        });
      }
    }

    const seenAliases = new Set<string>();
    if (typeof book.peers === 'object' && book.peers !== null) {
      for (const [peerId, row] of Object.entries(book.peers as Record<string, unknown>)) {
        if (!isPeerId(peerId)) { continue; }
        // Tombstones are consulted BEFORE any record is admitted, so a revoked
        // identity cannot return through the store and — just as important —
        // its alias is free again for the human to re-pair with a fresh key.
        if (out.revoked.has(peerId)) { continue; }
        if (typeof row !== 'object' || row === null) { continue; }
        const rec = row as Record<string, unknown>;
        const peer = validatePeer(rec.peer, nowMs);
        // The map KEY is what every lookup uses; a record filed under someone
        // else's key would answer `getGrant(bob)` with alice's pinned key.
        if (!peer || peer.peerId !== peerId) { continue; }
        const grant = validateGrant(rec.grant, peerId);
        if (!grant) { continue; }
        // Two records claiming one alias means the store was edited. Both are
        // now ambiguous for routing, so neither is honoured after the first.
        if (seenAliases.has(peer.alias)) { continue; }

        // `aliasBase`/`aliasOrdinal` are what the ROSTER renders, while
        // `peer.alias` is what ROUTES. Every other field here is
        // drop-don't-repair and cross-checked; these used to be
        // repaired-with-a-fallback and never reconciled, which put the display
        // name under store control — an operator approving a card for "alice"
        // approving a request from "bob". They must reconstruct the alias
        // exactly as `addPeer`/`addRotatedPeer` built it, or the record goes.
        const base = typeof rec.aliasBase === 'string' ? rec.aliasBase : '';
        const ordinal = isFiniteNumber(rec.aliasOrdinal) ? Math.floor(rec.aliasOrdinal) : 0;
        if (ordinal < 1 || !validateAlias(base).ok) { continue; }
        if ((ordinal <= 1 ? base : `${base}-${ordinal}`) !== peer.alias) { continue; }

        seenAliases.add(peer.alias);
        out.peers.set(peerId, {
          // Re-clamp on load: a store edited to push `expiresAt` past the
          // absolute maximum must not buy the peer a longer life. This is only
          // sound because `validatePeer` has already refused a forward-dated
          // `pairedAt` — the ceiling is measured from it.
          peer: { ...peer, expiresAt: this._clampExpiry(peer.pairedAt, peer.expiresAt) },
          grant,
          rotatedFrom: isPeerId(rec.rotatedFrom) ? rec.rotatedFrom : undefined,
          aliasOrdinal: ordinal,
          aliasBase: base,
        });
      }
    }

    if (typeof book.ledger === 'object' && book.ledger !== null) {
      for (const [peerId, row] of Object.entries(book.ledger as Record<string, unknown>)) {
        if (!isPeerId(peerId)) { continue; }
        if (typeof row !== 'object' || row === null) { continue; }
        const l = row as Record<string, unknown>;
        // A negative or non-finite stored spend would read as budget the peer
        // has not used — the wallet-refill shape of the denial-of-wallet
        // attack — so an unreadable row is treated as "spent nothing today",
        // never as credit. The same applies to `callsLifetime`: a negative one
        // would reset the lifetime call ceiling `grant.maxCalls` enforces.
        out.ledger.set(peerId, {
          day: typeof l.day === 'string' ? l.day : '',
          usdToday: isFiniteNumber(l.usdToday) && l.usdToday > 0 ? l.usdToday : 0,
          callsLifetime: isFiniteNumber(l.callsLifetime) && l.callsLifetime > 0
            ? Math.floor(l.callsLifetime)
            : 0,
        });
      }
    }

    return out;
  }

  /**
   * Fold another instance's state (re-read from the store) into ours, then
   * keep the union. Called inside the queued write, immediately before the
   * snapshot.
   *
   * The rule everywhere is "take the stricter side": tombstones union (a
   * revocation is never undone by a merge), ledger rows take the maximum (more
   * spend recorded means less serving), and a peer record only arrives if we
   * do not already have one for that id, it is not revoked, and its alias is
   * free. Peers are never DELETED by a merge, because this class has no delete
   * operation whose intent a union could undo.
   *
   * Rejected alternative: a module-level singleton keyed by the store. It
   * cannot see the second extension host — two VSCode windows share one
   * `globalState` across two processes — so it would hide the race rather than
   * fix it.
   */
  private _mergeFrom(other: ParsedBook): void {
    for (const [peerId, row] of other.revoked) {
      if (!this._revoked.has(peerId)) { this._revoked.set(peerId, row); }
    }

    const aliases = new Set<string>();
    for (const rec of this._peers.values()) { aliases.add(rec.peer.alias); }
    for (const [peerId, rec] of other.peers) {
      if (this._peers.has(peerId) || this._revoked.has(peerId)) { continue; }
      if (aliases.has(rec.peer.alias)) { continue; }
      aliases.add(rec.peer.alias);
      this._peers.set(peerId, rec);
    }

    for (const [peerId, theirs] of other.ledger) {
      const ours = this._ledger.get(peerId);
      if (!ours) { this._ledger.set(peerId, theirs); continue; }
      // Day keys are `YYYY-MM-DD`, so a lexicographic comparison is a date
      // comparison; the older day's spend is not carried into the newer day.
      const day = ours.day >= theirs.day ? ours.day : theirs.day;
      this._ledger.set(peerId, {
        day,
        usdToday: Math.max(
          ours.day === day ? ours.usdToday : 0,
          theirs.day === day ? theirs.usdToday : 0,
        ),
        callsLifetime: Math.max(ours.callsLifetime, theirs.callsLifetime),
      });
    }
  }

  /**
   * Snapshot the whole book and write it, one write at a time.
   *
   * The returned promise REJECTS when the store write fails. It used to be
   * `.catch(console.error)`, which meant `revoke()` resolved successfully
   * having persisted nothing: the human is told the stolen key is dead, and on
   * the next restart it is alive again with a ledger reset to zero.
   */
  private _persist(): Promise<void> {
    const step = this._writeQueue.then(async () => {
      let stored: unknown;
      try {
        stored = this._store.get<PersistedBook>(STORE_KEY);
      } catch (err) {
        // A failed READ must not throw away state we hold; write ours as-is.
        console.error('[Mysti] DeskPeerBook: pre-write read failed, writing local state', err);
        stored = undefined;
      }
      if (typeof stored === 'object' && stored !== null) {
        this._mergeFrom(this._parse(stored, this._nowMs()));
      }
      const snapshot: PersistedBook = {
        peers: Object.fromEntries(this._peers),
        revoked: Object.fromEntries(this._revoked),
        ledger: Object.fromEntries(this._ledger),
      };
      await this._store.update(STORE_KEY, snapshot);
    });
    // The QUEUE must survive a failed write — one storage hiccup would
    // otherwise poison every later write — but the CALLER must still see the
    // failure. So the queue chains the swallowed copy and the caller gets the
    // real promise.
    this._writeQueue = step.catch(() => undefined);
    return step;
  }

  // -- lifetime -----------------------------------------------------------

  private _clampExpiry(pairedAt: number, wanted: number): number {
    const ceiling = pairedAt + this._limits.absoluteMaxLifetimeMs;
    return Math.min(wanted, ceiling);
  }

  // -- roster -------------------------------------------------------------

  /**
   * Pin a new peer.
   *
   * Refuses (throws) rather than overwriting on: an alias already in use, a
   * peerId already pinned, a peerId that has ever been revoked, a `peerId`
   * that does not follow from the `publicKey`, and any malformed field. A
   * silent overwrite here is a roster takeover — the human typed that alias,
   * and it is the only routing key there is (I12).
   *
   * Throws too when the pairing could not be PERSISTED, and un-pins it: a peer
   * that is authorized in memory but absent from disk is a grant nobody can
   * revoke durably and nobody can see after a reload.
   */
  async addPeer(peer: DeskPeer, grant: PeerGrant): Promise<void> {
    const now = this._nowMs();
    const clean = validatePeer(peer, now);
    if (!clean) { throw new Error('DeskPeerBook: peer failed validation'); }
    const cleanGrant = validateGrant(grant, clean.peerId);
    if (!cleanGrant) { throw new Error('DeskPeerBook: grant failed validation'); }
    if (this._revoked.has(clean.peerId)) {
      throw new Error(`DeskPeerBook: ${clean.peerId} is revoked and cannot be re-added`);
    }
    if (this._peers.has(clean.peerId)) {
      throw new Error(`DeskPeerBook: ${clean.peerId} is already paired`);
    }
    for (const rec of this._peers.values()) {
      // A revoked record still occupies `_peers` until the next load, but it
      // no longer owns its alias: the moment a human most needs to re-pair
      // "alice" is right after revoking the stolen alice, and the roster does
      // not even show the record that would refuse them.
      if (this._revoked.has(rec.peer.peerId)) { continue; }
      if (rec.peer.alias === clean.alias) {
        throw new Error(`DeskPeerBook: alias '${clean.alias}' is already in use`);
      }
    }

    const pairedAt = now;
    this._peers.set(clean.peerId, {
      // `pairedAt` is set here, not taken from the caller: a peer's readable
      // history begins at ITS OWN pairing event (I13), and a back-dated
      // pairing would widen that window.
      peer: {
        ...clean,
        pairedAt,
        expiresAt: this._clampExpiry(pairedAt, pairedAt + this._limits.ttlMs),
      },
      grant: cleanGrant,
      aliasOrdinal: 1,
      aliasBase: clean.alias,
    });
    try {
      await this._persist();
    } catch (err) {
      this._peers.delete(clean.peerId);
      throw err;
    }
  }

  /**
   * Pin a peer that presents a NEW key for an identity already in the roster.
   *
   * This is a fresh TOFU event, not a renewal (I13). It inherits nothing: new
   * peerId, new `pairedAt` (so history starts now), a caller-supplied grant
   * that this method refuses to copy from the old one, an empty ledger, and an
   * empty rate bucket. `rotatedFrom` is recorded for display only.
   *
   * Rejected alternative: mutating the existing record's `publicKey`. That is
   * exactly the key-laundering path A7 describes — the new key would silently
   * inherit the old pin, the old budget and the old task ownership.
   */
  async addRotatedPeer(previousPeerId: string, peer: DeskPeer, grant: PeerGrant): Promise<void> {
    const previous = this._peers.get(previousPeerId);
    if (!previous) { throw new Error(`DeskPeerBook: unknown previous peer ${previousPeerId}`); }
    // A revoked identity has no successor, only a fresh `addPeer`. Rotating
    // off it would mint a live grant whose roster row reads as continuity with
    // a key the human declared compromised — the A7 display that must not
    // exist.
    if (this._revoked.has(previousPeerId)) {
      throw new Error(`DeskPeerBook: ${previousPeerId} is revoked and cannot be rotated from`);
    }
    const now = this._nowMs();
    const clean = validatePeer(peer, now);
    if (!clean) { throw new Error('DeskPeerBook: peer failed validation'); }
    // Both halves compare KEYS, not spellings: `publicKey` is canonical base64
    // by validation, and `peerId` is its fingerprint.
    if (clean.publicKey === previous.peer.publicKey || clean.peerId === previous.peer.peerId) {
      throw new Error('DeskPeerBook: rotation requires a different key');
    }

    const base = previous.aliasBase;
    let ordinal = 1;
    for (const rec of this._peers.values()) {
      if (rec.aliasBase === base) { ordinal = Math.max(ordinal, rec.aliasOrdinal + 1); }
    }
    const alias = `${base}-${ordinal}`;
    const aliasCheck = validateAlias(alias);
    if (!aliasCheck.ok) {
      // A base alias close to the 32-char cap can push the suffixed form over
      // it. Refuse and make the human type a shorter name rather than trim,
      // which could silently collide with an existing alias.
      throw new Error(`DeskPeerBook: rotated alias '${alias}' is not a valid alias`);
    }
    const cleanGrant = validateGrant(grant, clean.peerId);
    if (!cleanGrant) { throw new Error('DeskPeerBook: grant failed validation'); }
    if (this._revoked.has(clean.peerId)) {
      throw new Error(`DeskPeerBook: ${clean.peerId} is revoked and cannot be re-added`);
    }
    if (this._peers.has(clean.peerId)) {
      throw new Error(`DeskPeerBook: ${clean.peerId} is already paired`);
    }
    for (const rec of this._peers.values()) {
      if (this._revoked.has(rec.peer.peerId)) { continue; }
      // Reachable: a peer pinned DIRECTLY as "alice-2" does not raise the
      // alias family's ordinal (its own base is "alice-2"), so the computed
      // rotated alias can collide with it and two records would share one
      // routing alias.
      if (rec.peer.alias === alias) {
        throw new Error(`DeskPeerBook: alias '${alias}' is already in use`);
      }
    }

    const pairedAt = now;
    this._peers.set(clean.peerId, {
      peer: {
        ...clean,
        alias,
        pairedAt,
        expiresAt: this._clampExpiry(pairedAt, pairedAt + this._limits.ttlMs),
      },
      grant: cleanGrant,
      rotatedFrom: previousPeerId,
      aliasOrdinal: ordinal,
      aliasBase: base,
    });
    try {
      await this._persist();
    } catch (err) {
      this._peers.delete(clean.peerId);
      throw err;
    }
  }

  /**
   * How the roster and every card must render this peer: `alice` for the
   * original pin, `alice (2)` for the next identity that claimed the name.
   * The parenthesised form is display-only — it is never a routing key,
   * because it is not a valid alias.
   *
   * Null for a revoked peer: nothing revoked is rendered anywhere.
   */
  renderAlias(peerId: string): string | null {
    if (this._revoked.has(peerId)) { return null; }
    const rec = this._peers.get(peerId);
    if (!rec) { return null; }
    return rec.aliasOrdinal <= 1 ? rec.aliasBase : `${rec.aliasBase} (${rec.aliasOrdinal})`;
  }

  /** Display hint only; never transfers a pin. */
  rotatedFrom(peerId: string): string | null {
    if (this._revoked.has(peerId)) { return null; }
    return this._peers.get(peerId)?.rotatedFrom ?? null;
  }

  getPeerByAlias(alias: string): DeskPeer | null {
    const check = validateAlias(alias);
    if (!check.ok) { return null; }
    for (const rec of this._peers.values()) {
      // A revoked record keeps its slot in `_peers` until the next load, but
      // it no longer owns the NAME: returning null on it would hide the live
      // peer a human re-paired under the same alias moments later.
      if (this._revoked.has(rec.peer.peerId)) { continue; }
      if (rec.peer.alias === check.value) { return { ...rec.peer }; }
    }
    return null;
  }

  getPeerById(peerId: string): DeskPeer | null {
    if (this._revoked.has(peerId)) { return null; }
    const rec = this._peers.get(peerId);
    return rec ? { ...rec.peer } : null;
  }

  /**
   * The roster. Expired peers ARE listed — the human needs to see "expired,
   * re-pair" rather than have the entry vanish — but `getGrant` refuses them,
   * so listing is never authorization. Revoked peers are not listed; see
   * `listRevoked`.
   */
  listPeers(): DeskPeer[] {
    const out: DeskPeer[] = [];
    for (const rec of this._peers.values()) {
      if (this._revoked.has(rec.peer.peerId)) { continue; }
      out.push({ ...rec.peer });
    }
    return out;
  }

  listRevoked(): DeskRevocation[] {
    return [...this._revoked.values()].map(r => ({ ...r }));
  }

  /**
   * THE authorization chokepoint. A non-null return means: pinned, not
   * revoked, peer lifetime not expired, grant not expired, and the lifetime
   * call ceiling not yet reached. Every other accessor on this class is for
   * display; this one is for decisions.
   */
  getGrant(peerId: string): PeerGrant | null {
    if (this._revoked.has(peerId)) { return null; }
    const rec = this._peers.get(peerId);
    if (!rec) { return null; }
    const now = this._nowMs();
    // `pairedAt` anchors the absolute-lifetime ceiling, so a record whose
    // pairing is in the future would have an unbounded life. This is the ONLY
    // place that refusal lives: `_parse` deliberately preserves such a record
    // rather than dropping it, because dropping destroyed rosters on a benign
    // backwards clock step. Deny authority, keep the data — a clock that comes
    // back restores the peer, where a deleted row needed a human ceremony.
    if (rec.peer.pairedAt > now + PAIRED_AT_SKEW_MS) { return null; }
    // Belt and braces, deliberately kept although it is UNREACHABLE: every
    // writer of `expiresAt` (both add paths, `touchOutbound`, `_parse`) clamps
    // already, so no test can turn this line red. It is not claimed as a
    // tested boundary — it is here so that a fifth writer added later fails
    // closed instead of minting an immortal peer.
    if (now >= this._clampExpiry(rec.peer.pairedAt, rec.peer.expiresAt)) { return null; }
    if (now >= rec.grant.expiresAt) { return null; }
    if (this.callsUsed(peerId) >= rec.grant.maxCalls) { return null; }
    return { ...rec.grant, verbs: [...rec.grant.verbs], scope: [...rec.grant.scope] };
  }

  /**
   * Revocation of a well-formed peerId always succeeds.
   *
   * An unsafe reason string is replaced, never rejected: refusing to revoke a
   * peer because the human's typed reason contained a control character would
   * be a security own-goal. Revoking a peerId that is not on the roster still
   * writes the tombstone, so a revoke-then-pair race cannot resurrect the
   * identity.
   *
   * A peerId that is not `p_` + 16 base32 characters is not a revocation of
   * anything — no key derives to it — so it throws rather than storing an
   * attacker-shaped string that `listRevoked()` would hand to the roster UI.
   *
   * Throws when the tombstone could not be persisted. The in-memory tombstone
   * is deliberately KEPT in that case: it is the stricter of the two states,
   * and the caller has been told the durable record failed.
   */
  async revoke(peerId: string, reason: string): Promise<void> {
    if (!isPeerId(peerId)) {
      throw new Error('DeskPeerBook: revoke requires a derived peerId');
    }
    // Stricter than `validateText`, which allows newlines: a revocation
    // reason is a single rendered line on the roster and in the audit row.
    const checked = validateText(reason, LIMITS.title, 'reason');
    const safe = checked.ok && !hasUnsafeChars(checked.value);
    this._revoked.set(peerId, {
      peerId,
      reason: safe ? checked.value : UNSAFE_REASON,
      at: this._nowMs(),
    });
    // Drop the burst allowance immediately; the tombstone alone would leave a
    // stale in-memory bucket around for a re-pair that must not happen anyway.
    this._buckets.delete(peerId);
    await this._persist();
  }

  /** Cheap and synchronous by design: I13 requires this before signature verification. */
  isRevoked(peerId: string): boolean {
    return this._revoked.has(peerId);
  }

  /**
   * Renew the peer's TTL. Call this ONLY from a locally-originated outbound
   * request to that peer.
   *
   * No inbound path in this class touches `expiresAt` — not `checkRate`, not
   * `spend`, not `getGrant`. That is the whole of I13's "a peer cannot renew
   * itself": traffic arriving from the peer you are trying to let expire must
   * not keep it alive. The invariant is enforced by there being exactly one
   * writer, and by a test that asserts inbound calls leave `expiresAt` alone.
   *
   * Renewal never resurrects: an already-expired or revoked peer stays dead
   * and must be re-paired by a human. Throws — and rolls the renewal back —
   * when it could not be persisted, because an extension of life that only
   * exists in memory is the fail-open half of a failed write.
   */
  async touchOutbound(peerId: string): Promise<void> {
    if (this._revoked.has(peerId)) { return; }
    const rec = this._peers.get(peerId);
    if (!rec) { return; }
    const now = this._nowMs();
    if (now >= rec.peer.expiresAt) { return; }
    const renewed = this._clampExpiry(rec.peer.pairedAt, now + this._limits.ttlMs);
    if (renewed <= rec.peer.expiresAt) { return; }
    const previous = rec.peer;
    rec.peer = { ...rec.peer, expiresAt: renewed };
    try {
      await this._persist();
    } catch (err) {
      rec.peer = previous;
      throw err;
    }
  }

  // -- rate ---------------------------------------------------------------

  /**
   * Consume one token from this peer's receiver-computed bucket.
   *
   * Named `check` to match the call site's intent, but it CONSUMES: a
   * non-consuming check would be advisory, and an advisory rate limit is not
   * one. Capacity and refill come from local limits only — there is no field
   * on the wire that can widen them (I17), and no unvalidated field in local
   * config that can turn them off (see `resolveDeskPeerLimits`).
   *
   * `nowMs` is clamped to the injected clock's upper bound: a caller passing a
   * far-future timestamp would otherwise refill the bucket for free. A past
   * timestamp is left alone because it can only be more restrictive.
   */
  checkRate(peerId: string, nowMs: number): RateBucket {
    const ceiling = this._nowMs();
    const now = isFiniteNumber(nowMs) ? Math.min(nowMs, ceiling) : ceiling;

    // `rateRefillWindowMs` is guaranteed finite and > 0, so `perMs` is finite;
    // it is 0 exactly when capacity is 0, which the next guard turns into a
    // flat refusal.
    const perMs = this._limits.rateCapacity / this._limits.rateRefillWindowMs;
    const denied = (): RateBucket => ({
      allowed: false,
      retryAfterMs: perMs > 0 ? Math.ceil(1 / perMs) : this._limits.rateRefillWindowMs,
    });

    // Unknown, revoked, expired or ungranted peers are refused here too, so a
    // caller that forgets `getGrant` still cannot be pumped for free work.
    if (!this.getGrant(peerId)) { return denied(); }
    // Zero capacity is "serve nobody". Without this the deficit maths divides
    // by zero and hands the caller `retryAfterMs: Infinity`.
    if (this._limits.rateCapacity <= 0) { return denied(); }

    let bucket = this._buckets.get(peerId);
    if (!bucket) {
      bucket = { tokens: this._limits.rateCapacity, lastMs: now };
      this._buckets.set(peerId, bucket);
    }

    // A backwards `now` must not mint tokens, and must not drive the balance
    // negative either: an unfloored elapsed makes `retryAfterMs` grow without
    // bound from a timestamp the caller chose.
    const elapsed = Math.max(0, now - bucket.lastMs);
    bucket.tokens = Math.min(this._limits.rateCapacity, bucket.tokens + elapsed * perMs);
    bucket.lastMs = Math.max(bucket.lastMs, now);

    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      return { allowed: false, retryAfterMs: Math.ceil(deficit / perMs) };
    }
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  // -- currency -----------------------------------------------------------

  private _row(peerId: string): LedgerRow {
    const today = utcDayKey(this._nowMs());
    const row = this._ledger.get(peerId);
    if (!row) { return { day: today, usdToday: 0, callsLifetime: 0 }; }
    // Rollover is lazy: the daily figure is only meaningful for `day`, so a
    // stale row reads as zero spent today without needing a timer.
    if (row.day !== today) { return { day: today, usdToday: 0, callsLifetime: row.callsLifetime }; }
    return row;
  }

  /** A peer this book has ever known: pinned now, or pinned and revoked. */
  private _known(peerId: string): boolean {
    return this._peers.has(peerId) || this._revoked.has(peerId);
  }

  /**
   * Atomically test both ceilings and debit — the ONLY safe way to charge for
   * a call that has not run yet.
   *
   * `budgetRemaining()` is a read, so "check then dispatch then spend" is
   * check-then-act: the rate bucket makes a concurrent burst the normal case,
   * and N callers each reading the same headroom each spend it. The check and
   * the debit here are in one synchronous block — JavaScript does not preempt
   * inside one, and the `await` comes strictly after the debit — so N
   * concurrent callers see N different balances.
   *
   * Returns false (having debited nothing) when the peer is not authorized or
   * the amount does not fit. Record any overage afterwards with `spend`, which
   * never refuses: the ledger must never forget money that was actually spent.
   */
  async trySpend(peerId: string, usd: number): Promise<boolean> {
    if (!isFiniteNumber(usd) || usd < 0) {
      throw new Error('DeskPeerBook: spend amount must be a finite, non-negative number');
    }
    const grant = this.getGrant(peerId);
    if (!grant) { return false; }
    const row = this._row(peerId);
    const perPeer = grant.budgetUsd - row.usdToday;
    const machine = this._limits.servingBudgetUsdPerDay - this.spentTodayAll();
    if (usd > Math.max(0, Math.min(perPeer, machine))) { return false; }
    this._ledger.set(peerId, {
      day: row.day,
      usdToday: row.usdToday + usd,
      callsLifetime: row.callsLifetime + 1,
    });
    await this._persist();
    return true;
  }

  /**
   * Record the cost of one served call. Must be called exactly once per served
   * call even when `usd` is 0, because this is also the lifetime call counter
   * that `grant.maxCalls` is checked against.
   *
   * A negative or non-finite amount throws: silently ignoring it would let a
   * bug (or a cost estimate signed by nothing) refund the budget, which is the
   * denial-of-wallet attack from the other direction. An unknown peerId throws
   * too — a ledger row keyed by a caller-supplied string is unbounded, and
   * every row makes the next whole-blob write more expensive. Revoked peers
   * are still chargeable: the call happened before the tombstone landed.
   *
   * Throws when the row could not be persisted, and does NOT roll back: the
   * in-memory debit is the stricter state.
   */
  async spend(peerId: string, usd: number): Promise<void> {
    if (!isFiniteNumber(usd) || usd < 0) {
      throw new Error('DeskPeerBook: spend amount must be a finite, non-negative number');
    }
    if (!this._known(peerId)) {
      throw new Error(`DeskPeerBook: cannot charge unknown peer ${peerId}`);
    }
    const row = this._row(peerId);
    this._ledger.set(peerId, {
      day: row.day,
      usdToday: row.usdToday + usd,
      callsLifetime: row.callsLifetime + 1,
    });
    await this._persist();
  }

  spentToday(peerId: string): number {
    return this._row(peerId).usdToday;
  }

  /** Machine-wide spend for the current UTC day, across every peer. */
  spentTodayAll(): number {
    const today = utcDayKey(this._nowMs());
    let total = 0;
    for (const row of this._ledger.values()) {
      if (row.day === today) { total += row.usdToday; }
    }
    return total;
  }

  callsUsed(peerId: string): number {
    return this._ledger.get(peerId)?.callsLifetime ?? 0;
  }

  /**
   * USD this peer may still be served today. Zero is a hard stop, checked
   * BEFORE dispatch (I17).
   *
   * Two ceilings, both local: the per-peer grant a human set at pairing, and
   * the machine-wide daily pool. The pool term is what stops N peers each
   * inside their own grant from together emptying the wallet.
   *
   * This is a READ — it reserves nothing. Anything that decides whether to
   * dispatch must go through `trySpend`, which debits atomically; using this
   * value as a go/no-go under concurrency is the check-then-act bug it cannot
   * fix on its own.
   */
  budgetRemaining(peerId: string): number {
    const grant = this.getGrant(peerId);
    if (!grant) { return 0; }
    const perPeer = grant.budgetUsd - this.spentToday(peerId);
    const machine = this._limits.servingBudgetUsdPerDay - this.spentTodayAll();
    return Math.max(0, Math.min(perPeer, machine));
  }
}
