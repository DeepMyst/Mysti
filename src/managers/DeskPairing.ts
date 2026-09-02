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
 * DeskPairing (Plan 21 Phase 3, invariants I12/I13) — the `desk://pair?...`
 * invite: minting it, parsing one, and the review a human must complete
 * before a key is pinned.
 *
 * ── THE INVITE IS NOT A CREDENTIAL ─────────────────────────────────────────
 *
 * Read that again, because every reader assumes the opposite: a link that
 * "adds you to the team" is normally a bearer token, and treating this one
 * that way is the mistake this comment exists to prevent.
 *
 * The invite carries a PUBLIC key and a nonce. Nothing in it authorizes
 * anything. Holding it does not let you call a verb, does not create a grant,
 * and does not make you a peer. Its whole job is to move a public key and a
 * correlation id across whatever chat the team already uses, so the receiving
 * human can look at a safety number and decide. Authority is created later,
 * locally, by that human typing an alias and writing a `PeerGrant` — see
 * DeskPeerBook. That is why the link may be pasted into Slack without leaking
 * authority, and why interception of the link is a spoofing risk (an attacker
 * can substitute THEIR key) but never a theft risk.
 *
 * Consequently the interesting failure is substitution, and the only defence
 * against substitution is the out-of-band safety-number comparison — which is
 * why `review()` returns one and why it must be shown to BOTH sides.
 *
 * ── Three steps, and why they are three ────────────────────────────────────
 *
 *   review(url, ownKey)  →  hold(url, ownKey)  →  consume(inviteId, publicKey)
 *   ─────────────────────   ───────────────────   ────────────────────────────
 *   pure, cheap to refuse,  records that a HUMAN   the pin. Refuses an id that
 *   writes NOTHING          is now looking at it   was never held, and refuses
 *                                                  a key other than the held one
 *
 * An earlier shape had `review()` itself record the invite. That was wrong in
 * two ways that only show up under a hostile sender:
 *
 *  1. `review()` is reachable from inbound bytes (a `desk://pair` URL handler),
 *     and it runs the safety-number chain — two 5200-round SHA-512 chains,
 *     ~13 ms — on wholly attacker-chosen keys. Recording as well meant every
 *     hostile link consumed a slot in a 512-entry table.
 *  2. The table is bounded, so a full table evicted something. Evicting "the
 *     unconsumed entry expiring soonest" let a flood of links whose `issuedAt`
 *     sat just inside the skew window evict the entry a human was at that
 *     moment comparing digits for. The human approved; the pin then failed
 *     silently, because the record of their consent had been evicted.
 *
 * So: `review()` is now read-only and rate-budgeted, `hold()` is the only
 * inbound-invite path that writes, and `hold()` is reached by a human clicking
 * — not by bytes arriving. The table never evicts anything; expiry is what
 * reclaims space. Refusing a mint while the table is genuinely full is a
 * ten-minute inconvenience; dropping a live consent record is a silent failure
 * of the ceremony, and only one of those is recoverable.
 *
 * ── What binds the key to the id ───────────────────────────────────────────
 *
 * `review()` reports the `inviteId`, the `nonce` and the `publicKey` together,
 * `hold()` stores all three, and `consume()` takes the id AND the key and
 * refuses a mismatch. Without that pair, "you cannot pin a key you never
 * looked at" degrades to "you cannot pin an ID you never looked at" — and two
 * links can share one id while carrying different keys.
 *
 * ── Why the expiry is receiver-computed ────────────────────────────────────
 *
 * `expiresAt` travels on the wire, so the sender chooses it, so it is not
 * trustworthy. `review()` clamps the window to `issuedAt + PAIR_INVITE_TTL_MS`
 * and separately refuses an `issuedAt` far in the receiver's future, because
 * otherwise "issued in the year 3000, expires ten minutes later" is a link
 * that never ages out. Same discipline as I17/I18: every bound is computed by
 * the side that has to live with it. `_parseInvite` is a protected seam purely
 * so that clamp can be tested WITHOUT relying on the parser's own refusal —
 * a layer that can only be exercised through the layer above it is not a
 * second layer.
 *
 * ── Placement ──────────────────────────────────────────────────────────────
 *
 * In `managers/` because invite lifecycle is stateful and editor-adjacent, but
 * it imports no `vscode`: the clock and the id source are injected, so the
 * whole ceremony is testable and so a webview command layer can supply the
 * real ones.
 */

import * as crypto from 'crypto';
import { validateId, hasUnsafeChars } from '../services/desk/DeskContract';
import { CLOCK_SKEW_MS, peerIdFor } from '../services/desk/DeskEnvelope';
// Imported, never re-derived. Two implementations of a safety number means the
// two sides of a ceremony can render different digits, which turns the only
// defence against a substituted key into decoration — so DeskIdentity owns the
// one definition and this module only shows what it produced.
import { safetyNumber } from '../services/desk/DeskIdentity';

/** Ten minutes. An invite outlives the message it was pasted into, nothing more. */
export const PAIR_INVITE_TTL_MS = 10 * 60 * 1000;

/**
 * Minimum length for the invite nonce.
 *
 * 22 base64url characters is 128 bits. The nonce is not a secret, but it is
 * the correlation value both sides quote in an audit row, and a two-character
 * "nonce" produced by a lazy id source would make distinct pairing ceremonies
 * indistinguishable in the log. Enforced when minting AND when parsing, so a
 * remote party cannot hand us a degenerate one either — and returned by
 * `review()`/`hold()` and stored alongside the invite, so the value the audit
 * row quotes is the value this module actually saw.
 */
const NONCE_MIN_CHARS = 22;

/** Longest invite URL accepted, before any parsing work happens. */
const MAX_URL_CHARS = 2048;

/**
 * How many invites this instance tracks at once.
 *
 * Bounded because the table is memory. Only two things write to it now — a
 * local mint and a human-initiated `hold()` — so it cannot be filled from the
 * network. When it is full `_admit` refuses; it never evicts. See the header.
 */
export const PAIR_INVITE_MAX_TRACKED = 512;

/**
 * Budget for the expensive half of `review()`.
 *
 * `safetyNumber()` is two 5200-round SHA-512 chains over keys the sender
 * chose, and `review()` is reachable from a URL handler. MEASURED on a 2026
 * developer laptop: 193 ms per call, not the ~13 ms an earlier note guessed —
 * so a few hundred pasted links is a minute and a half of blocked extension
 * host, on input nobody asked for.
 *
 * Eight per minute is therefore the cap. It is chosen against the cost (8 x
 * 193 ms = 1.5 s of CPU per minute, worst case) rather than against a guess at
 * human throughput, and it is still far above any real ceremony: pairing is a
 * two-people-on-a-call ritual, not a bulk import.
 *
 * What a refusal costs is the reason this is safe to set low:
 *  - `review()` writes NOTHING, so a refusal destroys no consent record.
 *  - `hold()` is deliberately NOT charged, so a flood cannot stop a human from
 *    FINISHING a pairing they already reviewed — only from starting a new one.
 *  - The window is 60 s, so the worst case is "try again in under a minute".
 * Only reviews that reach the expensive step are charged: a malformed, self-,
 * expired or already-used link is refused for microseconds and costs nothing,
 * so cheap garbage cannot exhaust an honest user's window either.
 */
export const PAIR_REVIEW_WINDOW_MS = 60 * 1000;
export const PAIR_REVIEW_MAX_PER_WINDOW = 8;

/** Wire shape of one invite. Every field is public; none of it is secret. */
export interface PairInvite {
  /** Correlation id, and the single-use key for `consume`. */
  inviteId: string;
  /** The issuer's Ed25519 public key, base64 SPKI DER — the thing being offered. */
  publicKey: string;
  /** Freshness/correlation value. Public, not a token. */
  nonce: string;
  /** Issuer's clock at mint time. Advisory: the receiver clamps against it. */
  issuedAt: number;
  /** Issuer's declared expiry. Never trusted beyond `issuedAt + TTL`. */
  expiresAt: number;
}

/** Clock and id source. Injected so the ceremony has no ambient dependencies. */
export interface PairingDeps {
  now(): number;
  newId(): string;
}

/** What `review()` and `hold()` report when the invite is usable. */
export interface PairReviewOk {
  ok: true;
  /**
   * The id `consume()` takes. Returned so the caller never re-parses the URL
   * to find it: a second parse is a second chance to disagree about which
   * invite the human approved.
   */
  inviteId: string;
  /** The correlation value both sides quote in an audit row. */
  nonce: string;
  /** Derived from the key, never asserted by the sender (I12). */
  peerId: string;
  /** The key `consume()` must be given back. This is what the human approved. */
  publicKey: string;
  /** Sixty digits both humans must compare out of band before pinning. */
  safetyNumber: string;
  /**
   * Receiver-computed effective expiry, already reconciled with anything this
   * instance previously recorded for the same id — so `review()` cannot say
   * "usable" about a window `consume()` will refuse.
   */
  expiresAt: number;
}

export interface PairReviewFailure {
  ok: false;
  /** Machine-readable; the UI maps it to prose. */
  reason: PairReviewReason;
}

export type PairReviewReason =
  | 'malformed'          // the URL did not survive validation; dropped, never repaired
  | 'bad-local-key'      // our own key argument is not a usable Ed25519 public key
  | 'self-invite'        // the invite offers our own key back to us
  | 'expired'            // past the receiver-computed expiry
  | 'not-yet-valid'      // issued beyond the tolerated clock skew in our future
  | 'already-used'       // this inviteId was consumed
  | 'id-reused'          // this inviteId is already held for a DIFFERENT key
  | 'bad-clock'          // deps.now() returned something that is not a finite time
  | 'rate-limited'       // too many reviews this window; retry, nothing was lost
  | 'busy';              // invite table full of live entries

export type PairReviewResult = PairReviewOk | PairReviewFailure;

/** What the instance remembers about one invite id. */
interface TrackedInvite {
  /** Receiver-computed expiry; the sender's number is already clamped in. */
  expiresAt: number;
  /**
   * The key that was reviewed under this id. `consume` refuses any other, so
   * an id cannot be held for one key and consumed for another.
   */
  publicKey: string;
  /** Correlation value, kept so the audit row quotes what we saw. */
  nonce: string;
  consumed: boolean;
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/**
 * Decode a base64 Ed25519 SPKI public key, or null.
 *
 * The canonical-spelling round trip is the whole check: `Buffer.from(x,
 * 'base64')` silently ignores junk, accepts the URL-safe alphabet, and
 * tolerates missing padding, so without it many strings denote one key. That
 * matters here because `review()` decides "is this my own key?" and a peer
 * store elsewhere keys on the STRING. Then `createPublicKey` proves it really
 * is an Ed25519 key rather than 44 arbitrary bytes — rejected here so a
 * malformed key can never reach the point where a human is asked to trust it.
 *
 * A length cap and a charset pre-check stood here and were removed: both were
 * unfirable behind the round trip (every string they refused, it refuses), and
 * the input is already bounded by `MAX_URL_CHARS`. Same reasoning as the port
 * check in `parseInviteUrl` — a guard that cannot be observed to fire reads
 * like protection that is not there, and the tests said so.
 */
function decodeEd25519PublicKey(base64: string): Buffer | null {
  if (typeof base64 !== 'string' || base64.length === 0) { return null; }
  let der: Buffer;
  try {
    der = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (der.length === 0 || der.toString('base64') !== base64) { return null; }
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') { return null; }
  } catch {
    return null;
  }
  return der;
}

// ---------------------------------------------------------------------------
// URL form
// ---------------------------------------------------------------------------

/** Exactly the query keys an invite carries. An unknown key is a rejection. */
const INVITE_PARAMS = ['v', 'id', 'k', 'n', 't', 'x'] as const;

function isSafeInteger(v: number): boolean {
  return Number.isFinite(v) && Number.isSafeInteger(v);
}

/** True when this is a structurally valid invite, whatever the clock says. */
function inviteWellFormed(i: PairInvite): boolean {
  if (!validateId(i.inviteId, 'inviteId').ok) { return false; }
  if (!validateId(i.nonce, 'nonce').ok || i.nonce.length < NONCE_MIN_CHARS) { return false; }
  if (!decodeEd25519PublicKey(i.publicKey)) { return false; }
  if (!isSafeInteger(i.issuedAt) || i.issuedAt <= 0) { return false; }
  if (!isSafeInteger(i.expiresAt) || i.expiresAt <= i.issuedAt) { return false; }
  // A sender-chosen window wider than the policy is refused outright rather
  // than clamped at build time, so `buildInviteUrl` can never be the thing
  // that launders an over-long invite into a well-formed URL.
  if (i.expiresAt - i.issuedAt > PAIR_INVITE_TTL_MS) { return false; }
  return true;
}

/**
 * Render an invite as `desk://pair?...`.
 *
 * Throws on a malformed invite. A builder that emitted a URL its own parser
 * refuses would be a silent interoperability bug, and the caller here is
 * always local code, so throwing is the right severity.
 */
export function buildInviteUrl(invite: PairInvite): string {
  if (invite === null || typeof invite !== 'object' || !inviteWellFormed(invite)) {
    throw new Error('buildInviteUrl: malformed invite');
  }
  // URLSearchParams percent-encodes `+`, `/` and `=`, which matters: a raw `+`
  // in a query string decodes back as a SPACE, silently corrupting one byte in
  // 64 of a base64 key. Hand-built strings get this wrong; this class does not.
  const params = new URLSearchParams();
  params.set('v', '1');
  params.set('id', invite.inviteId);
  params.set('k', invite.publicKey);
  params.set('n', invite.nonce);
  params.set('t', String(invite.issuedAt));
  params.set('x', String(invite.expiresAt));
  return `desk://pair?${params.toString()}`;
}

/**
 * Parse an invite URL. Returns null on ANYTHING malformed.
 *
 * Drop, never repair: no trimming, no case folding, no "helpfully" supplying a
 * missing expiry. A repaired invite is one whose rendered form differs from
 * what the sender signed off on, and the whole point of the ceremony is that
 * both humans are looking at the same thing.
 *
 * The last check makes that total: whatever survives field validation must
 * re-render to the byte-identical string. Field-by-field canonicality left
 * gaps — `id=%69d...`, a trailing `&`, an empty `#` — each of which is a
 * DIFFERENT string shown to a human for the SAME single-use invite. The
 * re-render check is the rule those individual checks were approximating.
 *
 * Freshness is NOT decided here — this function has no clock. `review()` owns
 * expiry so that the receiver's clock is the only one that counts.
 */
export function parseInviteUrl(url: string): PairInvite | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_CHARS) { return null; }
  if (hasUnsafeChars(url)) { return null; }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'desk:') { return null; }
  // `host` includes any port, so this one comparison refuses both `desk://PAIR`
  // (opaque-host schemes are not lowercased, so the spelling arrives as written)
  // and `desk://pair:8080`. A separate `parsed.port` check was written here
  // first and removed: it could never fire, and an unfirable guard reads like
  // protection that is not there.
  if (parsed.host !== 'pair') { return null; }
  if (parsed.pathname !== '' && parsed.pathname !== '/') { return null; }
  if (parsed.username !== '' || parsed.password !== '') { return null; }
  if (parsed.hash !== '') { return null; }

  const q = parsed.searchParams;
  for (const key of [...new Set(q.keys())]) {
    if (!(INVITE_PARAMS as readonly string[]).includes(key)) { return null; }
  }
  for (const key of INVITE_PARAMS) {
    // Exactly one of each. A duplicate is refused rather than resolved by
    // first-wins, because "which one did the human see?" has no answer when
    // the renderer and the parser can disagree about that.
    if (q.getAll(key).length !== 1) { return null; }
  }
  if (q.get('v') !== '1') { return null; }

  // `Number('')` is 0, `Number(' 1 ')` is 1, `Number('1e3')` is 1000 and
  // `Number('0x10')` is 16. Require the exact canonical decimal spelling so
  // that one invite has one URL: two spellings of one timestamp would be two
  // strings a human could be shown for the same single-use `inviteId`.
  const tRaw = q.get('t') as string;
  const xRaw = q.get('x') as string;
  if (!/^[1-9]\d{0,14}$/.test(tRaw) || !/^[1-9]\d{0,14}$/.test(xRaw)) { return null; }
  const issuedAt = Number(tRaw);
  const expiresAt = Number(xRaw);

  const invite: PairInvite = {
    inviteId: q.get('id') as string,
    publicKey: q.get('k') as string,
    nonce: q.get('n') as string,
    issuedAt,
    expiresAt,
  };
  if (!inviteWellFormed(invite)) { return null; }
  // One invite, one URL. `buildInviteUrl` cannot throw here: `inviteWellFormed`
  // is the same predicate it checks.
  if (buildInviteUrl(invite) !== url) { return null; }
  return invite;
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

export class DeskPairing {
  private readonly _deps: PairingDeps;
  private readonly _invites = new Map<string, TrackedInvite>();
  private _budgetWindowStart = 0;
  private _budgetSpent = 0;

  constructor(deps: PairingDeps) {
    // Validated rather than defaulted: there is no sensible fallback clock or
    // fallback id source, and a partially-wired instance that silently used
    // `Date.now` would hide the wiring bug until an invite failed to expire.
    if (deps === null || typeof deps !== 'object'
      || typeof deps.now !== 'function' || typeof deps.newId !== 'function') {
      throw new Error('DeskPairing: deps must supply now() and newId()');
    }
    this._deps = deps;
  }

  /**
   * Mint an invite for our own public key.
   *
   * Throws if the injected id source produces something unusable — a short,
   * malformed, or repeated id. A constant `newId` would otherwise make every
   * invite share one single-use slot, so the first `consume` anywhere would
   * kill every subsequent pairing. Repetition is checked against the TABLE and
   * not merely within one call: an id source that cycles with period two
   * passes an `inviteId !== nonce` comparison, and would then adopt an
   * existing — possibly already-consumed — slot and hand back a fresh-looking
   * invite that can never be consumed.
   */
  createInvite(ownPublicKey: string): PairInvite {
    if (!decodeEd25519PublicKey(ownPublicKey)) {
      throw new Error('createInvite: ownPublicKey must be an Ed25519 SPKI public key');
    }
    const now = this._clock();
    if (now === null) { throw new Error('createInvite: deps.now() must return a finite epoch'); }

    const inviteId = this._deps.newId();
    const nonce = this._deps.newId();
    for (const [label, value] of [['inviteId', inviteId], ['nonce', nonce]] as const) {
      if (!validateId(value, label).ok || value.length < NONCE_MIN_CHARS) {
        throw new Error(`createInvite: deps.newId() produced an unusable ${label}`);
      }
    }
    if (inviteId === nonce) {
      throw new Error('createInvite: deps.newId() is not producing distinct values');
    }
    // Prune first so a stale, expired entry is not mistaken for a live
    // collision — that would turn a normal ten-minute-old id into a hard error.
    this._prune(now);
    if (this._invites.has(inviteId)) {
      throw new Error('createInvite: deps.newId() repeated a live inviteId');
    }

    const invite: PairInvite = {
      inviteId,
      publicKey: ownPublicKey,
      nonce,
      issuedAt: now,
      expiresAt: now + PAIR_INVITE_TTL_MS,
    };
    // A mint that returns something `buildInviteUrl` would refuse is a bug
    // reported one call away from its cause. Assert it here instead.
    if (!inviteWellFormed(invite)) {
      throw new Error('createInvite: produced a malformed invite');
    }
    if (this._admit(invite, invite.expiresAt, now) !== null) {
      throw new Error('createInvite: invite table is full of live single-use entries');
    }
    return invite;
  }

  /**
   * Look at an invite. Returns what the human must confirm before pinning.
   *
   * Records NOTHING — not the id, not the key, not a rate-limit refusal that
   * some later call could inherit. That is deliberate: this is the method
   * inbound bytes can reach, so anything it wrote would be attacker-controlled
   * state, and the state in question is the table that remembers consents.
   *
   * It also does not consume the invite: the pinning decision belongs to a
   * human who has compared the safety number, and a function that both showed
   * and decided would make the modal decorative.
   */
  review(url: string, ownPublicKey: string): PairReviewResult {
    return this._review(url, ownPublicKey, /* record */ false);
  }

  /**
   * Same checks as `review()`, plus: remember this invite so it can be
   * consumed. Call it when a human is actually looking at the safety number.
   *
   * This is the only path by which an invite that arrived from outside enters
   * the table, and it is reached by a click rather than by bytes. It is not
   * charged against the review budget for exactly that reason — a flood must
   * not be able to block the completion of a pairing the human already began.
   */
  hold(url: string, ownPublicKey: string): PairReviewResult {
    return this._review(url, ownPublicKey, /* record */ true);
  }

  /**
   * Consume an invite id exactly once, for the key that was held under it.
   *
   * True only on the first call for an invite this instance minted or held,
   * that has not expired, and whose key matches. An UNKNOWN id returns false,
   * which is the ordering rule stated as code: you cannot consume — and
   * therefore cannot pin — a key you never looked at.
   *
   * The key argument is what makes that sentence true about a KEY rather than
   * merely about an id. Two links can carry one id and different keys; without
   * this comparison, consuming the id would say nothing about which of them
   * the human approved.
   */
  consume(inviteId: string, publicKey: string): boolean {
    const now = this._clock();
    if (now === null) { return false; }
    // No id-shape validation here. Every key in the table passed `validateId`
    // on the way in, so a malformed id is a Map miss and refusing it early
    // could not change the answer — an unobservable guard, removed rather than
    // left implying a protection it does not independently provide. The table
    // must stay a Map for that to hold; a plain object would reintroduce
    // `__proto__` as a key.
    //
    // Looked up BEFORE pruning, deliberately. `_prune` exists to bound memory,
    // and if the lookup came after it the expiry rule would be enforced only as
    // a side effect of that sweep — delete or weaken the sweep and invites
    // would silently become immortal, with no test able to see it. Reading
    // first makes the expiry check below the thing that actually refuses.
    const tracked = this._invites.get(inviteId);
    this._prune(now);
    if (!tracked) { return false; }
    if (tracked.consumed) { return false; }
    if (now >= tracked.expiresAt) { return false; }
    // Plain string comparison: both sides are already forced into one
    // canonical base64 spelling by `decodeEd25519PublicKey`, and the key is
    // public, so there is nothing here for a timing side channel to leak.
    if (typeof publicKey !== 'string' || tracked.publicKey !== publicKey) { return false; }
    tracked.consumed = true;
    return true;
  }

  /** How many invites are currently tracked. Test/diagnostic surface only. */
  get trackedCount(): number { return this._invites.size; }

  /**
   * Parsing seam. Overridden in tests ONLY, so that `review()`'s own expiry
   * clamp can be exercised against an invite the parser would have refused.
   * A second layer that can only be reached through the first is decorative;
   * this seam is what makes it possible to prove it is not.
   */
  protected _parseInvite(url: string): PairInvite | null {
    return parseInviteUrl(url);
  }

  private _review(url: string, ownPublicKey: string, record: boolean): PairReviewResult {
    const now = this._clock();
    if (now === null) { return { ok: false, reason: 'bad-clock' }; }

    const invite = this._parseInvite(url);
    if (!invite) { return { ok: false, reason: 'malformed' }; }

    const ownDer = decodeEd25519PublicKey(ownPublicKey);
    if (!ownDer) { return { ok: false, reason: 'bad-local-key' }; }

    const theirDer = decodeEd25519PublicKey(invite.publicKey);
    // Re-decoded rather than assumed: `_parseInvite` is overridable, so this
    // method must not trust that the invite it was handed already passed
    // `inviteWellFormed`.
    if (!theirDer) { return { ok: false, reason: 'malformed' }; }
    // Compared as decoded bytes, not as strings: a reflected invite that came
    // back with different-but-equivalent base64 spelling must still be caught.
    // (`decodeEd25519PublicKey` already forces canonical spelling, so this is
    // belt-and-braces — but the belt is the one that fails silently.)
    if (ownDer.length === theirDer.length && ownDer.equals(theirDer)) {
      return { ok: false, reason: 'self-invite' };
    }

    // An invite from the future would otherwise carry its whole TTL forward
    // from an arbitrary epoch. Skew tolerance matches the envelope's.
    if (invite.issuedAt > now + CLOCK_SKEW_MS) { return { ok: false, reason: 'not-yet-valid' }; }

    // Recomputed rather than taken from the wire. `parseInviteUrl` also
    // refuses a window wider than the TTL, and that is the point: review's
    // expiry must not DEPEND on that check staying where it is, because the
    // sender picked both numbers. See `_parseInvite` for how this is proven
    // independently.
    let expiresAt = Math.min(invite.expiresAt, invite.issuedAt + PAIR_INVITE_TTL_MS);

    // An entry past its own expiry is treated as absent, not as a refusal.
    // It is about to be pruned, `consume` would refuse it anyway, and reading
    // it would let a ten-minute-old record veto a fresh invite that happens to
    // reuse its id — a link nobody could then pair with, for no live reason.
    const stale = this._invites.get(invite.inviteId);
    const tracked = stale && now < stale.expiresAt ? stale : undefined;
    // The READ path answers from the table; the WRITE path lets `_admit`
    // answer, and reports whatever `_admit` recorded. Each of the three rules
    // below — consumed, key, window — therefore has exactly ONE reachable
    // owner per path. Stating them in both places sounds safer and is not: the
    // second copy becomes unreachable, and an unreachable guard is one no test
    // can prove still works, which is how this module ended up with four of
    // them.
    if (!record && tracked) {
      if (tracked.consumed) { return { ok: false, reason: 'already-used' }; }
      // An id already held for a different key is ambiguous, and ambiguity
      // in this ceremony is exactly the substitution attack.
      if (tracked.publicKey !== invite.publicKey) { return { ok: false, reason: 'id-reused' }; }
      // Report the window `consume` will actually enforce. Reporting the
      // freshly-computed one instead let `review` say "usable" about a link
      // whose id had already been recorded with an earlier expiry.
      expiresAt = Math.min(expiresAt, tracked.expiresAt);
    }
    if (now >= expiresAt) { return { ok: false, reason: 'expired' }; }

    // Everything above is microseconds. Everything below is not, so the budget
    // is charged here: cheap garbage is refused for free, and only work that
    // is about to become expensive counts against the window.
    if (!record && !this._chargeReview(now)) { return { ok: false, reason: 'rate-limited' }; }

    if (record) {
      const refusal = this._admit(invite, expiresAt, now);
      if (refusal) { return { ok: false, reason: refusal }; }
      // The table is the authority on the recorded window, so report what it
      // holds rather than what was offered to it. This is what keeps `hold`
      // and `consume` from ever disagreeing.
      expiresAt = (this._invites.get(invite.inviteId) as TrackedInvite).expiresAt;
    }

    return {
      ok: true,
      inviteId: invite.inviteId,
      nonce: invite.nonce,
      peerId: peerIdFor(invite.publicKey),
      publicKey: invite.publicKey,
      safetyNumber: safetyNumber(ownPublicKey, invite.publicKey),
      expiresAt,
    };
  }

  /**
   * Fixed-window budget for the safety-number chain. True when there was room.
   *
   * A window that resets on a backwards clock step is intentional: the clock is
   * injected and may jump, and the failure mode of resetting early (a few extra
   * hashes) is smaller than the failure mode of never resetting (pairing dead
   * until the process restarts).
   */
  private _chargeReview(now: number): boolean {
    if (now < this._budgetWindowStart || now - this._budgetWindowStart >= PAIR_REVIEW_WINDOW_MS) {
      this._budgetWindowStart = now;
      this._budgetSpent = 0;
    }
    if (this._budgetSpent >= PAIR_REVIEW_MAX_PER_WINDOW) { return false; }
    this._budgetSpent += 1;
    return true;
  }

  /**
   * Record an invite, pruning first. False when there is no room.
   *
   * Nothing is ever evicted. Every entry here is either a local mint or an
   * invite a human is looking at, so there is no junk to reclaim and no
   * attacker-driven pressure to reclaim it under; expiry is what frees space.
   * Evicting a live entry would silently destroy either the record of a
   * consumption (single-use becomes multi-use) or the record of a consent in
   * progress (the human approves and the pin fails). Refusing while genuinely
   * full is a ten-minute inconvenience, and only one of those is recoverable.
   */
  private _admit(invite: PairInvite, expiresAt: number, now: number): PairReviewReason | null {
    this._prune(now);
    const existing = this._invites.get(invite.inviteId);
    if (existing) {
      // Never let a re-seen id resurrect or extend itself. A consumed slot
      // stays consumed, the key first held under an id stays that id's key,
      // and the window only ever shrinks. Resetting any of the three is a
      // single-use defeat, and this is the only place that could do it.
      if (existing.consumed) { return 'already-used'; }
      if (existing.publicKey !== invite.publicKey) { return 'id-reused'; }
      // Shortest window ever seen wins, in both directions: a later expiry
      // cannot extend a live record, and an earlier one does shrink it. The
      // caller deliberately does NOT pre-clamp on this path, so this line is
      // the only thing deciding what gets stored.
      existing.expiresAt = Math.min(existing.expiresAt, expiresAt);
      return null;
    }
    if (this._invites.size >= PAIR_INVITE_MAX_TRACKED) { return 'busy'; }
    this._invites.set(invite.inviteId, {
      expiresAt,
      publicKey: invite.publicKey,
      nonce: invite.nonce,
      consumed: false,
    });
    return null;
  }

  /** Forget invites past their expiry; after expiry both paths refuse anyway. */
  private _prune(now: number): void {
    for (const [id, entry] of this._invites) {
      if (now >= entry.expiresAt) { this._invites.delete(id); }
    }
  }

  /** `deps.now()` as a usable epoch, or null. Never trusted blind. */
  private _clock(): number | null {
    let t: unknown;
    try {
      t = this._deps.now();
    } catch {
      return null;
    }
    // NaN is the dangerous case, not a throw: every comparison against NaN is
    // false, so an unchecked NaN clock makes "expired" and "already used"
    // permanently untrue. This is the exact shape of the limiter bug this plan
    // has already hit twice.
    //
    // Integrality is required for the same reason `inviteWellFormed` requires
    // it: a fractional epoch produced an `issuedAt` that this module's OWN
    // builder then refused, so `createInvite` returned a dead invite and the
    // error surfaced a call later, at `buildInviteUrl`. Failing closed at the
    // clock puts the complaint where the cause is.
    if (typeof t !== 'number' || !Number.isFinite(t) || !Number.isSafeInteger(t) || t <= 0) {
      return null;
    }
    return t;
  }
}
