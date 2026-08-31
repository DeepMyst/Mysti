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
 * DeskEnvelope (Plan 21, invariant I12) — canonical serialization, Ed25519
 * signing, and replay defence for one Desk request.
 *
 * ── Identity is never read from the payload ────────────────────────────────
 *
 * There is no `from` field. Who the caller is comes from the key that
 * verified the signature, resolved against a grant the RECEIVER owns. A
 * self-asserted identity in a message body is not evidence of anything, and
 * accepting one is how "agent card spoofing" works in the protocols that do.
 *
 * ── Why canonical JSON ─────────────────────────────────────────────────────
 *
 * A signature covers bytes, so sender and receiver must agree on exactly which
 * bytes. `JSON.stringify` does not guarantee key order across engines or
 * across versions of the same engine, so a naive implementation produces
 * signatures that verify on the machine that made them and fail elsewhere —
 * or, worse, lets an attacker reorder keys to produce a different meaning
 * under the same signature. Keys are sorted recursively and the output is
 * minimal.
 *
 * ── Replay ─────────────────────────────────────────────────────────────────
 *
 * A signature proves authorship, never freshness: a captured request stays
 * valid forever unless something binds it to this moment. Three bindings,
 * each closing a different gap:
 *   - a server-chosen `challenge`, so a request cannot be minted offline;
 *   - `issuedAt` within a bounded window, so a captured one ages out;
 *   - a `callId` dedupe cache, so a replay inside the window is still refused.
 *
 * The crypto here is node's built-in Ed25519. No new dependency, and the
 * module imports nothing from the rest of Mysti beyond the contract's
 * validators — see importGraph.test.ts.
 */

import * as crypto from 'crypto';
import { validateId } from './DeskContract';

/** How far apart the two clocks may be before a request is refused. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Bytes on the wire, before any interpretation. */
export interface DeskEnvelope {
  /** Wire protocol version. Refused unless exactly this. */
  protocol: 'mysti.desk/1';
  /** Unique per request; the dedupe key. */
  callId: string;
  /** The verb being invoked. Validated downstream by DeskContract. */
  verb: string;
  /** Verb arguments. Opaque here. */
  args: Record<string, unknown>;
  /** Sender's clock at send time. */
  issuedAt: number;
  /** The receiver's most recent challenge, echoed back. */
  challenge: string;
  /** How long the caller is willing to wait; the callee's abort budget. */
  deadlineMs: number;
}

export interface SignedEnvelope {
  envelope: DeskEnvelope;
  /** base64 Ed25519 signature over canonical(envelope). */
  signature: string;
}

export type VerifyFailure =
  | 'bad-protocol'
  | 'bad-shape'
  | 'bad-signature'
  | 'stale'
  | 'future'
  | 'bad-challenge'
  | 'replay';

export type VerifyResult =
  | { ok: true; envelope: DeskEnvelope }
  | { ok: false; reason: VerifyFailure };

/**
 * Deterministic JSON: object keys sorted recursively, no incidental
 * whitespace. Arrays keep their order, which is meaningful.
 *
 * Rejects values JSON cannot round-trip faithfully — `undefined`, functions,
 * NaN, Infinity — rather than letting `JSON.stringify` silently drop or
 * transform them, because a field that vanishes between signing and verifying
 * is a signature that covers less than it appears to.
 */
export function canonicalize(value: unknown): string {
  if (value === null) { return 'null'; }
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) { throw new Error('canonicalize: non-finite number'); }
    return JSON.stringify(value);
  }
  if (t === 'string' || t === 'boolean') { return JSON.stringify(value); }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(`canonicalize: unsupported type ${t}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    // An explicit `undefined` property is dropped by JSON.stringify; refuse it
    // rather than sign a document whose shape depends on that quirk.
    if (obj[k] === undefined) { throw new Error(`canonicalize: undefined value at "${k}"`); }
    parts.push(`${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/** A fresh Ed25519 keypair, exported in the form the peer store holds. */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/**
 * `peerId` IS the key fingerprint, so identity cannot be claimed — only
 * demonstrated. base32 over the first bytes of sha256(publicKey), lowercase
 * and unambiguous to read aloud during a pairing ceremony.
 */
export function peerIdFor(publicKeyBase64: string): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest();
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, acc = 0, out = '';
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 16) { break; }
  }
  return `p_${out.slice(0, 16)}`;
}

function publicKeyObject(base64: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki',
  });
}

function privateKeyObject(base64: string): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8',
  });
}

/** Sign an envelope. The signature covers the canonical bytes, nothing less. */
export function sign(envelope: DeskEnvelope, privateKeyBase64: string): SignedEnvelope {
  const bytes = Buffer.from(canonicalize(envelope), 'utf8');
  const signature = crypto.sign(null, bytes, privateKeyObject(privateKeyBase64));
  return { envelope, signature: signature.toString('base64') };
}

/** Structural check before any crypto — cheap rejection of malformed input. */
function wellFormed(e: unknown): e is DeskEnvelope {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) { return false; }
  const o = e as Record<string, unknown>;
  if (typeof o.verb !== 'string') { return false; }
  if (o.args === null || typeof o.args !== 'object' || Array.isArray(o.args)) { return false; }
  if (typeof o.issuedAt !== 'number' || !Number.isFinite(o.issuedAt)) { return false; }
  if (typeof o.deadlineMs !== 'number' || !Number.isFinite(o.deadlineMs)) { return false; }
  if (o.deadlineMs <= 0) { return false; }
  if (!validateId(o.callId, 'callId').ok) { return false; }
  if (!validateId(o.challenge, 'challenge').ok) { return false; }
  return true;
}

/**
 * Tracks recently-seen callIds so a replay inside the freshness window is
 * still refused. Bounded by the same window, so it cannot grow without limit.
 */
export class ReplayCache {
  private readonly _seen = new Map<string, number>();

  constructor(private readonly _windowMs: number = CLOCK_SKEW_MS * 2) {}

  /** True when this callId is new; records it. False means replay. */
  admit(callId: string, now: number): boolean {
    this._evict(now);
    if (this._seen.has(callId)) { return false; }
    this._seen.set(callId, now);
    return true;
  }

  private _evict(now: number): void {
    for (const [id, at] of this._seen) {
      if (now - at > this._windowMs) { this._seen.delete(id); }
    }
  }

  get size(): number { return this._seen.size; }
}

export interface VerifyOptions {
  /** The key pinned for this peer at pairing. Never taken from the payload. */
  publicKey: string;
  /** The challenge this receiver most recently issued. */
  expectedChallenge: string;
  /** Receiver's clock. */
  now: number;
  /** Replay cache; omit only in tests that are not exercising replay. */
  replay?: ReplayCache;
  /** Override the accepted clock skew. */
  skewMs?: number;
}

/**
 * Verify a signed envelope.
 *
 * Order matters: shape, then protocol, then freshness, then challenge, then
 * signature, then replay. The signature check is deliberately NOT first —
 * it is the most expensive step, and doing cheap structural rejection ahead
 * of it keeps an unauthenticated flood from costing a verify per packet.
 *
 * Replay admission runs LAST, after the signature proves authenticity, so an
 * attacker cannot poison the dedupe cache with forged callIds and thereby
 * deny a legitimate request that later uses one.
 */
export function verify(signed: unknown, opts: VerifyOptions): VerifyResult {
  if (signed === null || typeof signed !== 'object') { return { ok: false, reason: 'bad-shape' }; }
  const s = signed as Record<string, unknown>;
  if (typeof s.signature !== 'string') { return { ok: false, reason: 'bad-shape' }; }
  if (!wellFormed(s.envelope)) { return { ok: false, reason: 'bad-shape' }; }

  const envelope = s.envelope;
  if (envelope.protocol !== 'mysti.desk/1') { return { ok: false, reason: 'bad-protocol' }; }

  const skew = opts.skewMs ?? CLOCK_SKEW_MS;
  if (opts.now - envelope.issuedAt > skew) { return { ok: false, reason: 'stale' }; }
  // A future-dated request is refused rather than tolerated: accepting one
  // would let a sender mint a request that stays valid past its natural life.
  if (envelope.issuedAt - opts.now > skew) { return { ok: false, reason: 'future' }; }

  // Constant-time compare so the challenge cannot be recovered byte by byte.
  const got = Buffer.from(envelope.challenge, 'utf8');
  const want = Buffer.from(opts.expectedChallenge, 'utf8');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return { ok: false, reason: 'bad-challenge' };
  }

  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonicalize(envelope), 'utf8'),
      publicKeyObject(opts.publicKey),
      Buffer.from(s.signature, 'base64'),
    );
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!verified) { return { ok: false, reason: 'bad-signature' }; }

  if (opts.replay && !opts.replay.admit(envelope.callId, opts.now)) {
    return { ok: false, reason: 'replay' };
  }

  return { ok: true, envelope };
}

/** A fresh server-side challenge. Unpredictable, and shaped like an id. */
export function newChallenge(): string {
  return crypto.randomBytes(24).toString('base64url').slice(0, 32);
}
