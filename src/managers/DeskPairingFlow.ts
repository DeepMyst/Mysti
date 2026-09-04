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
 * DeskPairingFlow (Plan 26) — the pairing ceremony, orchestrated.
 *
 * `DeskPairing` owns invite lifecycle and `DeskPeerBook` owns the pin. This
 * module owns the thing between them that decides whether a human actually
 * verified anything, and it exists because that decision must not live in the
 * webview: a renderer that reports "the user confirmed" is a renderer that can
 * be made to report it.
 *
 * ── Why a typed challenge and not a Confirm button ─────────────────────────
 *
 * A fingerprint modal with a Confirm button does not produce verification. It
 * produces the FEELING of verification, which is strictly worse than nothing:
 * it manufactures confidence that no comparison happened. Signal has shipped
 * safety numbers for a decade and most users have never compared one.
 *
 * So completing the ceremony requires typing digits that can only be known by
 * having read them off the other person's screen. The button cannot be clicked
 * past; there is no code path from `begin()` to a pin that skips `answer()`.
 *
 * ── Why the friction is affordable HERE ────────────────────────────────────
 *
 * Plan 21 §13.1 established that per-event approval cards habituate almost
 * immediately, which is why the consult path is being pushed toward fewer,
 * batched decisions. Pairing is the opposite shape: it happens once per
 * teammate ever, and it is the root of every later disclosure to that peer.
 * Friction spent here is spent once and protects everything downstream.
 *
 * ── Why both machines demand the SAME groups ───────────────────────────────
 *
 * The demanded indices are derived from the safety number, not drawn at
 * random. Random indices would mean the two humans first have to agree WHICH
 * groups to read ("mine says 4, 9 and 2") — a coordination step that adds no
 * security and gives people a reason to abandon. Deriving them means both
 * screens independently highlight the same three, so the call is just: read me
 * groups 3, 7 and 12.
 *
 * It also makes a retry show the same groups, so a typo is correctable.
 * Guessing is ~1-in-10^15; the realistic failure is a mistyped digit, not a
 * brute force, and re-randomising would punish only the honest case.
 */

import * as crypto from 'crypto';
import { DeskPairing } from './DeskPairing';
import type { PairReviewOk } from './DeskPairing';
import { DeskPeerBook } from './DeskPeerBook';
import { validateAlias, validateText, LIMITS } from '../services/desk/DeskContract';
import type { DeskPeer, DeskVerb, PeerGrant } from '../types';

/** How many groups of the safety number the human must type. */
export const CHALLENGE_GROUPS = 3;

/**
 * Attempts before the session is destroyed and the invite must be re-issued.
 *
 * Three, because the realistic failure is a mistyped digit and one attempt
 * would make an honest ceremony feel like a trap. Not unlimited, because an
 * unlimited retry against a 15-digit answer is still a worse posture than a
 * bounded one for no benefit.
 */
export const CHALLENGE_MAX_ATTEMPTS = 3;

/** Total groups the safety number is rendered in. Mirrors DeskIdentity. */
const SAFETY_GROUPS = 12;

/** Verbs granted by default at pairing: the two that cost the owner nothing. */
export const DEFAULT_GRANT_VERBS: readonly DeskVerb[] = Object.freeze(['status', 'locate']);

export interface PairingFlowDeps {
  pairing: DeskPairing;
  peerBook: DeskPeerBook;
  /** This device's public key, from DeskIdentity.ensure(). */
  ownPublicKey: string;
  now(): number;
  /** Session ids. Must be unpredictable; crypto.randomUUID qualifies. */
  newSessionId(): string;
  /** Default grant lifetime. Machine-scoped setting at the call site. */
  grantTtlMs?: number;
  /**
   * Lifetime call ceiling and daily spend ceiling written into a new grant.
   *
   * These MUST be non-zero, and the defaults below exist because zero is not a
   * safe default here — it is a broken one. `DeskPeerBook.getGrant` refuses when
   * `callsUsed >= maxCalls`, so a grant minted with `maxCalls: 0` is dead on
   * arrival: the ceremony succeeds, the roster shows a peer, and every request
   * is refused with the same message an unpaired peer gets. That reads as "Desk
   * is broken", which is how a security feature gets switched off.
   *
   * The call site should pass `mysti.desk.servingBudgetUsdPerDay`.
   */
  grantMaxCalls?: number;
  grantBudgetUsd?: number;
}

/** What the modal renders. Carries no secret: both humans see all of it. */
export interface ChallengeView {
  sessionId: string;
  peerId: string;
  /** All twelve groups, in order, for display. */
  groups: string[];
  /** 1-based indices the human must type. Identical on both machines. */
  demanded: number[];
  attemptsLeft: number;
}

export type BeginResult =
  | { ok: true; challenge: ChallengeView }
  | { ok: false; reason: string };

export type AnswerResult =
  | { ok: true }
  | { ok: false; reason: 'wrong' | 'no-session' | 'exhausted'; attemptsLeft: number };

export type CompleteResult =
  | { ok: true; peer: DeskPeer }
  | { ok: false; reason: string };

export interface GrantChoice {
  alias: string;
  trustDomain: string;
  verbs: DeskVerb[];
}

interface Session {
  review: PairReviewOk;
  groups: string[];
  demanded: number[];
  attemptsLeft: number;
  /** Set only by a correct answer. The single gate on `complete()`. */
  verified: boolean;
  expiresAt: number;
}

const DEFAULT_GRANT_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/**
 * Generous but bounded. `status` and `locate` cost the owner nothing and are
 * the point of pairing, so a tight call cap would expire a working relationship
 * for no security gain — the meaningful bounds are the per-day currency ledger
 * and the receiver-computed rate bucket, both of which live in DeskPeerBook and
 * both of which keep applying underneath this number.
 */
const DEFAULT_GRANT_MAX_CALLS = 10_000;

/** Matches the `mysti.desk.servingBudgetUsdPerDay` default. */
const DEFAULT_GRANT_BUDGET_USD = 0.5;

/**
 * Pick {@link CHALLENGE_GROUPS} distinct 1-based indices from the safety
 * number itself, so both machines agree without exchanging anything.
 *
 * Derived from a hash rather than from the digits directly: taking, say, the
 * first digits as indices would make the demanded groups correlate with the
 * content of the number, and a peer who can influence their own key could bias
 * which groups are ever checked.
 */
export function demandedGroups(safetyNumber: string, total = SAFETY_GROUPS): number[] {
  const digest = crypto.createHash('sha256').update(safetyNumber, 'utf8').digest();
  const picked: number[] = [];
  for (let i = 0; i < digest.length && picked.length < CHALLENGE_GROUPS; i++) {
    const candidate = (digest[i] % total) + 1;
    if (!picked.includes(candidate)) { picked.push(candidate); }
  }
  // A pathological digest could fail to yield enough distinct values; fill
  // deterministically rather than returning a short challenge, because a short
  // challenge is a weaker ceremony that nobody would notice.
  for (let n = 1; picked.length < CHALLENGE_GROUPS && n <= total; n++) {
    if (!picked.includes(n)) { picked.push(n); }
  }
  return picked.sort((a, b) => a - b);
}

/** Digits only. A human reading aloud produces spaces, dashes and hesitation. */
function normalizeAnswer(raw: unknown): string {
  if (typeof raw !== 'string') { return ''; }
  return raw.replace(/[^0-9]/g, '');
}

/**
 * Constant-time compare of the typed answer against the expected digits.
 *
 * The safety number is not a secret — both parties display it — so this is not
 * defending a credential. It is here because an early-exit comparison over a
 * value an attacker can partly influence is a habit worth not forming, and the
 * cost is nil.
 */
function answersMatch(expected: string[], got: string[]): boolean {
  if (expected.length !== got.length) { return false; }
  const a = Buffer.from(expected.join('|'), 'utf8');
  const b = Buffer.from(got.join('|'), 'utf8');
  if (a.length !== b.length) { return false; }
  return crypto.timingSafeEqual(a, b);
}

export class DeskPairingFlow {
  private readonly _sessions = new Map<string, Session>();

  constructor(private readonly _deps: PairingFlowDeps) {}

  /**
   * Step 1 — the human pasted an invite and is now looking at it.
   *
   * Uses `hold()` rather than `review()`: holding is the step that records a
   * human is present, and `consume()` refuses an id that was never held. See
   * DeskPairing's header for why review is read-only.
   */
  begin(inviteUrl: string): BeginResult {
    const held = this._deps.pairing.hold(inviteUrl, this._deps.ownPublicKey);
    if (!held.ok) { return { ok: false, reason: held.reason }; }

    const groups = held.safetyNumber.split(' ').filter(g => g.length > 0);
    if (groups.length !== SAFETY_GROUPS) {
      // The number came out the wrong shape. Refuse rather than challenge on a
      // partial number: a ceremony over fewer groups than expected is a weaker
      // ceremony that presents as a normal one.
      return { ok: false, reason: 'bad-safety-number' };
    }

    const sessionId = this._deps.newSessionId();
    const session: Session = {
      review: held,
      groups,
      demanded: demandedGroups(held.safetyNumber, groups.length),
      attemptsLeft: CHALLENGE_MAX_ATTEMPTS,
      verified: false,
      // The ceremony cannot outlive the invite it is verifying.
      expiresAt: held.expiresAt,
    };
    this._sessions.set(sessionId, session);

    return { ok: true, challenge: this._view(sessionId, session) };
  }

  /** Step 2 — the human typed the demanded groups. */
  answer(sessionId: string, answers: unknown[]): AnswerResult {
    const session = this._get(sessionId);
    if (!session) { return { ok: false, reason: 'no-session', attemptsLeft: 0 }; }

    const expected = session.demanded.map(i => session.groups[i - 1]);
    const got = (Array.isArray(answers) ? answers : []).map(normalizeAnswer);

    if (answersMatch(expected, got)) {
      session.verified = true;
      return { ok: true };
    }

    session.attemptsLeft -= 1;
    if (session.attemptsLeft <= 0) {
      // Destroy rather than lock: a session that lingers after its attempts are
      // gone is a session someone can come back to and guess at again.
      this._sessions.delete(sessionId);
      return { ok: false, reason: 'exhausted', attemptsLeft: 0 };
    }
    // Deliberately does NOT report WHICH group was wrong. That would turn one
    // 15-digit answer into three independent 5-digit answers.
    return { ok: false, reason: 'wrong', attemptsLeft: session.attemptsLeft };
  }

  /**
   * Step 3 — the human named the peer and chose what it may ask.
   *
   * CALL ORDER IS THE INVARIANT: consume first, pin second. Pinning before
   * consuming re-introduces multi-use of an invite that is documented as
   * single-use, and nothing downstream would notice.
   */
  async complete(sessionId: string, choice: GrantChoice): Promise<CompleteResult> {
    const session = this._get(sessionId);
    if (!session) { return { ok: false, reason: 'no-session' }; }

    // The single gate. There is no other path to a pin in this class.
    if (!session.verified) { return { ok: false, reason: 'not-verified' }; }

    const alias = validateAlias(choice?.alias);
    if (!alias.ok) { return { ok: false, reason: `alias: ${alias.error}` }; }

    const domain = validateText(choice?.trustDomain, LIMITS.alias, 'trustDomain');
    if (!domain.ok) { return { ok: false, reason: `trustDomain: ${domain.error}` }; }

    const verbs = this._cleanVerbs(choice?.verbs);
    if (verbs.length === 0) { return { ok: false, reason: 'no verbs granted' }; }

    // Consume BEFORE pinning. A refusal here means the invite was already used,
    // expired, or held for a different key — none of which may result in a peer.
    if (!this._deps.pairing.consume(session.review.inviteId, session.review.publicKey)) {
      this._sessions.delete(sessionId);
      return { ok: false, reason: 'invite-not-consumable' };
    }

    const now = this._deps.now();
    const peer: DeskPeer = {
      peerId: session.review.peerId,
      alias: alias.value,
      publicKey: session.review.publicKey,
      trustDomain: domain.value,
      pairedAt: now,
      // Overwritten by addPeer from local limits; supplied so the shape is whole.
      expiresAt: now + (this._deps.grantTtlMs ?? DEFAULT_GRANT_TTL_MS),
    };
    const grant: PeerGrant = {
      peerId: session.review.peerId,
      verbs,
      scope: [],
      expiresAt: now + (this._deps.grantTtlMs ?? DEFAULT_GRANT_TTL_MS),
      budgetUsd: this._deps.grantBudgetUsd ?? DEFAULT_GRANT_BUDGET_USD,
      maxCalls: this._deps.grantMaxCalls ?? DEFAULT_GRANT_MAX_CALLS,
      minRetentionClass: 'zero-retention',
    };

    try {
      await this._deps.peerBook.addPeer(peer, grant);
    } catch (err) {
      // The invite is spent either way — it was consumed above and cannot be
      // replayed. Say so, rather than letting the UI offer a retry that will
      // fail for a reason the human cannot see.
      this._sessions.delete(sessionId);
      return {
        ok: false,
        reason: `pin failed after the invite was consumed (${err instanceof Error ? err.message : 'unknown'}) — issue a new invite`,
      };
    }

    this._sessions.delete(sessionId);
    return { ok: true, peer };
  }

  /** The human closed the modal. Nothing was written; nothing needs undoing. */
  abandon(sessionId: string): void {
    this._sessions.delete(sessionId);
  }

  /** Live sessions, for a disposal sweep. Never rendered. */
  get pendingCount(): number {
    this._sweep();
    return this._sessions.size;
  }

  private _view(sessionId: string, s: Session): ChallengeView {
    return {
      sessionId,
      peerId: s.review.peerId,
      groups: [...s.groups],
      demanded: [...s.demanded],
      attemptsLeft: s.attemptsLeft,
    };
  }

  private _get(sessionId: string): Session | null {
    this._sweep();
    if (typeof sessionId !== 'string' || sessionId.length === 0) { return null; }
    return this._sessions.get(sessionId) ?? null;
  }

  /** Drop sessions whose invite has expired underneath them. */
  private _sweep(): void {
    const now = this._deps.now();
    if (!Number.isFinite(now)) { return; }
    for (const [id, s] of this._sessions) {
      if (now >= s.expiresAt) { this._sessions.delete(id); }
    }
  }

  /**
   * Narrow a caller-supplied verb list to the closed set.
   *
   * Drops unknown entries rather than throwing: the list comes from a webview
   * checkbox group, and a value that is not a verb is a UI bug, not an attack.
   * Duplicates collapse so a grant cannot be inflated by repetition.
   */
  private _cleanVerbs(raw: unknown): DeskVerb[] {
    const allowed: readonly string[] = ['status', 'locate', 'consult', 'review', 'handoff', 'assign', 'followup'];
    if (!Array.isArray(raw)) { return [...DEFAULT_GRANT_VERBS]; }
    const out: DeskVerb[] = [];
    for (const v of raw) {
      if (typeof v === 'string' && allowed.includes(v) && !out.includes(v as DeskVerb)) {
        out.push(v as DeskVerb);
      }
    }
    return out;
  }
}
