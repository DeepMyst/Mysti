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
 * DeskIdentity (Plan 21 Phase 3, invariants I12/I13) — this device's long-term
 * Ed25519 identity, and the human-readable safety number two people compare
 * out of band before they pin each other.
 *
 * ── What this module adds over DeskEnvelope ────────────────────────────────
 *
 * Keygen and fingerprint derivation already exist in `DeskEnvelope`
 * (`generateKeyPair`, `peerIdFor`) and are reused verbatim. What is new here
 * is (a) durable storage behind an interface, so the sealed Desk set never
 * imports `vscode` just to reach `SecretStorage`, and (b) a rendering of a
 * two-party fingerprint that a human can actually read aloud.
 *
 * ── Why the private key lives in a WeakMap, not a field ────────────────────
 *
 * A `private _privateKey: string` field is a compile-time fiction: TypeScript
 * erases the modifier, and the property survives into `JSON.stringify(this)`,
 * `console.log(this)`, `util.inspect`, structured error serializers and any
 * telemetry that walks an object graph. One incidental log of the manager
 * would print the device's signing key. A module-scoped `WeakMap` keyed by the
 * instance makes the key genuinely unreachable from the object, so those
 * accidents cannot happen. Rejected alternative: an ES `#private` field, which
 * is equally unreachable but reads badly against this repo's leading-underscore
 * convention and cannot be shared with the module-level helpers below.
 *
 * ── Why corruption is fatal ────────────────────────────────────────────────
 *
 * The obvious recovery from an unreadable vault entry is "generate a new one".
 * That is the worst possible behaviour here: `peerId` IS the key fingerprint
 * (I12), so a new key is a new identity (I13) that inherits no pin. Silently
 * minting one would invalidate every peer that pinned this device, at a moment
 * nobody chose, with no message anywhere. So a vault that returns something
 * this module cannot use is a hard error that leaves the stored bytes exactly
 * as they were — recoverable by a human, or discardable by an explicit
 * `reset()`. Fail closed, never fail convenient.
 *
 * ── Why error messages are rewritten ───────────────────────────────────────
 *
 * `JSON.parse` embeds a snippet of its input in the thrown message on modern
 * V8 ("Unexpected token 'x', \"<your key here>\"... is not valid JSON").
 * Propagating that would print stored key material into whatever catches it.
 * Every failure path below therefore throws a message this module authored,
 * with no `cause` chain and no interpolation of the stored value.
 *
 * That applies to the WRITE paths too, and they are the sharper edge: the
 * `store()` call is the one place the freshly generated PRIVATE key is handed
 * to caller-supplied foreign code. A vault that echoes its argument in its
 * rejection — an ordinary shape for a quota or serialization error — would
 * carry the device signing key out of this module inside an error nobody
 * downstream expects to be sensitive. So `store()` and `delete()` failures are
 * swallowed whole and re-thrown as `vault-unwritable`, with no cause, no
 * borrowed message and no borrowed stack.
 *
 * ── Why reset() serializes against an in-flight ensure() ───────────────────
 *
 * `reset()` used to null the in-flight promise and delete the slot. Both halves
 * were wrong. The load it abandoned kept running, so its `store()` landed AFTER
 * the delete and put the identity straight back — a user who reset because they
 * suspected a compromise went on signing with the key they believed was gone.
 * And nulling the memo let the next `ensure()` start a SECOND concurrent
 * generate-and-store, which is the exact race the memo exists to prevent.
 *
 * So `reset()` raises a generation counter synchronously (an already-running
 * load refuses to mint or adopt under it, and an already-running `sign()` that
 * is past its `await ensure()` finds no key rather than signing with a
 * destroyed one), then WAITS OUT the in-flight load before deleting, and
 * `ensure()` defers to a reset in flight instead of racing its delete. The
 * accepted cost is liveness on a wedged vault: if `get()` never settles,
 * `reset()` waits with it. That is the right trade — a `reset()` that returns
 * while the identity is still recoverable is worse than one that does not
 * return — and any vault that can hang `get()` would hang `delete()` too.
 *
 * There are no numeric options on this class, deliberately: no constructor
 * `{...DEFAULTS, ...opts}` merge means no path by which an explicit
 * `undefined` from `cfg.get<number>()` can NaN out a limit.
 */

import * as crypto from 'crypto';
import { generateKeyPair, peerIdFor } from './DeskEnvelope';

/**
 * The storage indirection. `vscode.ExtensionContext.secrets` satisfies this
 * structurally, so the wiring layer passes it directly and this module — which
 * lives inside the sealed Desk set — never imports the editor API.
 */
export interface SecretVault {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The single vault slot this device's identity occupies. */
export const DESK_DEVICE_KEY = 'mysti.desk.deviceKey';

/** The public half. There is deliberately no private field on this type. */
export interface DeviceIdentity {
  peerId: string;
  publicKey: string;
}

/**
 * Failure codes a caller can branch on to choose the right modal.
 *
 * Each one implies a DIFFERENT remedy, which is why none of them is reused for
 * a second condition: `vault-unreadable` means "unlock the keychain and retry",
 * `vault-unwritable` means "storage refused the write", `not-initialized` means
 * a wiring bug no end user can act on, and `identity-reset` means "you reset
 * mid-flight; just ask again". A code that covers two remedies makes the caller
 * offer a retry that cannot work.
 */
export type DeskIdentityFailure =
  | 'vault-unreadable'
  | 'vault-unwritable'
  | 'stored-identity-corrupt'
  | 'stored-identity-mismatched'
  | 'invalid-public-key'
  | 'identity-reset'
  | 'not-initialized';

/** Carries a code, never key material. */
export class DeskIdentityError extends Error {
  constructor(public readonly code: DeskIdentityFailure, message: string) {
    super(message);
    this.name = 'DeskIdentityError';
  }
}

/**
 * A stored blob larger than this is refused before `JSON.parse` sees it. The
 * real record is a few hundred bytes; anything larger is corruption or an
 * attempt to make parsing expensive, and neither deserves the CPU.
 *
 * Measured in UTF-8 BYTES, not `String.length`: a string of astral-plane
 * characters is two UTF-16 code units and four bytes each, so comparing
 * `.length` would let a blob four times this size through the guard that
 * exists to bound parse cost.
 */
const MAX_STORED_BYTES = 4096;

/** Bumped only for a format change; an unknown version is fatal, not ignored. */
const STORED_VERSION = 1;

/**
 * Everything that could reveal key material, keyed by instance and therefore
 * unreachable from the object itself. See the header for why the signing key
 * lives here; the VAULT is here for the same reason one step removed —
 * `util.inspect(deskIdentity)` on an instance that merely HOLDS a vault walks
 * into whatever that vault keeps in memory, and the point of this indirection
 * is that no serialization of a DeskIdentity reaches a key regardless of which
 * vault implementation the wiring layer supplied.
 */
const _secrets = new WeakMap<DeskIdentity, { vault: SecretVault; privateKey?: string }>();

/** Throws rather than returning undefined: a missing vault is a wiring bug. */
function _secretsOf(self: DeskIdentity): { vault: SecretVault; privateKey?: string } {
  const s = _secrets.get(self);
  if (!s) {
    // Deliberately NOT `vault-unreadable`. That code tells the caller "the
    // keychain is locked, ask the user to unlock it and retry", and no amount
    // of retrying fixes an instance that never ran its constructor. Sharing
    // one code between the two would put a retry button in front of a user for
    // a condition only a code change can clear.
    throw new DeskIdentityError('not-initialized', 'Desk identity has no secret storage attached');
  }
  return s;
}

interface StoredIdentity {
  v: number;
  publicKey: string;
  privateKey: string;
}

/** Import an Ed25519 SPKI public key, refusing every other key type. */
function _importPublic(base64: string): crypto.KeyObject {
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new DeskIdentityError('invalid-public-key', 'Desk public key is missing or not a string');
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    // No `cause`: OpenSSL's message is harmless today, but the input is not,
    // and a future node could start echoing it.
    throw new DeskIdentityError('invalid-public-key', 'Desk public key is not a valid SPKI DER key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    // An X25519 or RSA SPKI blob parses cleanly here. Accepting one would let
    // two sides derive a "safety number" over a key that can never sign, so
    // the ceremony would succeed and every later call would fail.
    throw new DeskIdentityError('invalid-public-key', 'Desk public key is not Ed25519');
  }
  return key;
}

/** Import an Ed25519 PKCS8 private key, refusing every other key type. */
function _importPrivate(base64: string, code: DeskIdentityFailure): crypto.KeyObject {
  // Mirrors `_importPublic`'s opening guard on purpose. `Buffer.from` happens
  // to throw on a non-string today, so this looks redundant — but that makes
  // the private path's type safety an accident of another function's
  // behaviour, and it is the path where the alternative to rejecting is
  // signing with something unexamined. State the check where it belongs.
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new DeskIdentityError(code, 'Stored Desk device key is missing or not a string');
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new DeskIdentityError(code, 'Stored Desk device key is not a valid PKCS8 DER key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    // Without this, an X25519 or RSA PKCS8 key is caught two steps later by
    // the keypair probe, which reports `stored-identity-mismatched` — telling
    // the user their key halves disagree when the truth is that the stored key
    // is the wrong algorithm entirely.
    throw new DeskIdentityError(code, 'Stored Desk device key is not Ed25519');
  }
  return key;
}

/**
 * Canonical key bytes. Hashing the DER rather than the base64 text means
 * padding and whitespace variations in transit cannot produce two different
 * safety numbers for the same key — and it matches what `peerIdFor` hashes.
 */
function _publicDer(base64: string): Buffer {
  return _importPublic(base64).export({ type: 'spki', format: 'der' });
}

const SAFETY_DOMAIN = 'mysti.desk/safety-number/1';
/**
 * Iteration count, matching Signal's. It is not about entropy — the digest
 * already has plenty — it is about making each attempt to grind out a key
 * whose displayed digits collide with a target cost 5200 hashes instead of one.
 */
const SAFETY_ITERATIONS = 5200;
const SAFETY_GROUPS_PER_KEY = 6;
const SAFETY_GROUP_DIGITS = 5;
/**
 * Digest bytes consumed per displayed group. 5 bytes is 2^40, comfortably
 * inside the exact-integer range of a double (so the arithmetic below needs no
 * BigInt) and comfortably above the 10^5 modulus (so every group uses its full
 * width). Every other appearance of the group geometry is DERIVED from these
 * three constants rather than written out again: a named constant that a
 * hard-coded 5 elsewhere silently overrules is worse than no constant, because
 * changing it produces a wrong-but-well-formed safety number.
 */
const SAFETY_GROUP_BYTES = 5;
const SAFETY_GROUP_MODULUS = 10 ** SAFETY_GROUP_DIGITS;
const SAFETY_DIGITS_PER_KEY = SAFETY_GROUPS_PER_KEY * SAFETY_GROUP_DIGITS;

/** 30 decimal digits derived from one public key. */
function _fingerprintDigits(der: Buffer): string {
  // The domain string is mixed in once so this digest can never coincide with
  // any other sha512-over-a-Desk-key computed elsewhere in the codebase.
  let h = crypto.createHash('sha512').update(SAFETY_DOMAIN, 'utf8').update(der).digest();
  for (let i = 0; i < SAFETY_ITERATIONS; i++) {
    h = crypto.createHash('sha512').update(h).update(der).digest();
  }
  if (h.length < SAFETY_GROUPS_PER_KEY * SAFETY_GROUP_BYTES) {
    // Unreachable with sha512 (64 bytes covering 30). Asserting beats reading
    // past the end: `h[i]` would be `undefined`, `String(NaN % 100000)` is
    // 'NaN', and `padStart` renders it '00NaN' — a fingerprint-shaped string
    // that a ceremony would compare and accept.
    throw new DeskIdentityError('invalid-public-key', 'Desk safety digest is too short to render');
  }
  let out = '';
  for (let g = 0; g < SAFETY_GROUPS_PER_KEY; g++) {
    let n = 0;
    for (let b = 0; b < SAFETY_GROUP_BYTES; b++) { n = n * 256 + h[g * SAFETY_GROUP_BYTES + b]; }
    out += String(n % SAFETY_GROUP_MODULUS).padStart(SAFETY_GROUP_DIGITS, '0');
  }
  return out;
}

/**
 * Grouped safety number for a two-sided fingerprint ceremony: 12 groups of 5
 * digits, identical on both machines.
 *
 * Symmetry is the whole point. Two people reading this aloud must see the same
 * string regardless of who initiated pairing, so the two halves are ordered by
 * their own digits rather than by caller argument order. A number that depended
 * on who called first would make every honest comparison fail, and people who
 * learn that a mismatch is normal stop treating a mismatch as an attack.
 *
 * Digits, not hex: `b` / `8` / `6` and `0` / `d` are read aloud wrong often
 * enough that a hex ceremony measurably fails to detect a substituted key.
 *
 * The exact digits are pinned by a golden vector in the test file. Everything
 * this function mixes in — the domain string, the iteration count, the group
 * geometry, the ordering rule — is a WIRE format between two independently
 * built copies of Mysti: change any of it and the two sides read different
 * numbers for the same key pair, which presents to the user as an attack.
 */
export function safetyNumber(publicKeyA: string, publicKeyB: string): string {
  const a = _fingerprintDigits(_publicDer(publicKeyA));
  const b = _fingerprintDigits(_publicDer(publicKeyB));
  const joined = a <= b ? a + b : b + a;
  if (joined.length !== SAFETY_DIGITS_PER_KEY * 2) {
    // The previous rendering was `(joined.match(/.{5}/g) ?? []).join(' ')`,
    // which FAILS OPEN in the worst possible way for a comparison ceremony:
    // a short digit string yields '' on both machines, and two people who
    // compare '' to '' complete the ceremony having verified nothing. A
    // remainder that is not a whole group was silently dropped for the same
    // reason. Assert the shape instead of defaulting around it.
    throw new DeskIdentityError('invalid-public-key', 'Desk safety number came out the wrong length');
  }
  const groups: string[] = [];
  for (let i = 0; i < joined.length; i += SAFETY_GROUP_DIGITS) {
    groups.push(joined.slice(i, i + SAFETY_GROUP_DIGITS));
  }
  return groups.join(' ');
}

export class DeskIdentity {
  private _current: DeviceIdentity | null = null;
  /**
   * The in-flight `ensure()`. Memoizing the PROMISE (not a boolean flag) is
   * what makes concurrent calls safe: a flag would still let two callers pass
   * the check before either awaited, and two generated keypairs means the
   * second overwrites the first — after peers may already have pinned it.
   */
  private _pending: Promise<DeviceIdentity> | null = null;
  /**
   * The in-flight `reset()`. `ensure()` waits on it rather than racing its
   * delete, and a second `reset()` joins it rather than issuing a second one.
   */
  private _resetting: Promise<void> | null = null;
  /**
   * Raised synchronously by `reset()`. A load that began under an older
   * generation refuses to mint or to hand back an identity the user has since
   * destroyed, so "I reset it" cannot be quietly undone by work already in
   * flight. A counter rather than a boolean: reset/ensure/reset/ensure has to
   * be distinguishable from no reset at all.
   */
  private _generation = 0;

  constructor(vault: SecretVault) {
    if (!vault || typeof vault.get !== 'function' || typeof vault.store !== 'function'
      || typeof vault.delete !== 'function') {
      // Fail at construction rather than at the first pairing attempt: a
      // half-implemented vault that silently drops `store` would mint a new
      // identity on every window open. This is a wiring bug, not a locked
      // keychain, so it carries the code that says so.
      throw new DeskIdentityError('not-initialized', 'Desk secret storage is missing a required method');
    }
    _secrets.set(this, { vault });
  }

  /** Load, or generate-and-store on first use. Never returns the private key. */
  ensure(): Promise<DeviceIdentity> {
    if (this._current) { return Promise.resolve({ ...this._current }); }

    const resetting = this._resetting;
    if (resetting) {
      // A reset is about to empty the slot. Starting a load now would race its
      // delete and could leave a freshly minted identity sitting in a vault
      // the user just asked to be cleared. Wait it out, then start clean.
      // Its rejection belongs to whoever called `reset()`; this caller retries
      // against the vault and raises its own error if the vault is still bad.
      return resetting.catch(() => undefined).then(() => this.ensure());
    }

    const generation = this._generation;
    if (!this._pending) {
      this._pending = this._load(generation).finally(() => { this._pending = null; });
    }
    // Each caller gets its own copy, so one caller mutating the result cannot
    // corrupt another's view or the cached record.
    return this._pending.then(id => {
      if (this._generation !== generation) {
        // A reset landed between this call and its answer. Handing back the
        // identity anyway would give the caller a peerId it is about to
        // advertise to a peer, for a key that no longer exists here.
        throw new DeskIdentityError('identity-reset',
          'Desk device identity was reset while it was being loaded');
      }
      return { ...id };
    });
  }

  private async _load(generation: number): Promise<DeviceIdentity> {
    const existing = await this._read();
    if (existing) { return this._adopt(existing); }

    if (this._generation !== generation) {
      // `reset()` ran while we were reading an empty slot. Minting now would
      // write a brand-new identity into a vault the user asked to be emptied,
      // and — because `reset()` waits for us — the write would land first and
      // then be deleted, burning a keypair for nothing. Refuse instead; the
      // caller's `ensure()` rejects with `identity-reset` and can retry.
      throw new DeskIdentityError('identity-reset',
        'Desk device identity was reset while it was being loaded');
    }

    const fresh = generateKeyPair();
    await this._store(fresh);

    // Read back and adopt whatever the vault now holds. Two editor windows
    // share one SecretStorage and it has no compare-and-swap, so both can find
    // the slot empty and both can write. Re-reading makes them converge on the
    // last write instead of each holding a private key the other overwrote.
    // It does not eliminate the race — a peer pinned in the losing window
    // between the two writes is still orphaned — and no vault-level fix exists
    // here; pairing is human-paced, so the window is effectively unreachable.
    const settled = await this._read();
    if (settled && settled.publicKey !== fresh.publicKey) {
      // Under the stated threat model SecretStorage is trusted, so this is a
      // benign lost race rather than a substitution — but the two are
      // indistinguishable from in here, and adopting a record we did not write
      // without saying so leaves no trace of either. peerIds only: they are
      // public fingerprints, never key material.
      console.warn('[Mysti] Desk identity slot was written by someone else; adopting the stored record'
        + ` (wrote ${peerIdFor(fresh.publicKey)}, found ${peerIdFor(settled.publicKey)})`);
    }
    return this._adopt(settled ?? { v: STORED_VERSION, ...fresh });
  }

  /**
   * Persist a freshly generated identity.
   *
   * Split out from `_load` for one reason: this is the only call in the module
   * that hands the PRIVATE key to caller-supplied code, so it is the only one
   * whose rejection could carry the key back out. Nothing from the vault's
   * error crosses this boundary — not the message, not the stack, not a
   * `cause`. The cost is that a genuine storage fault arrives here without its
   * detail; that is the deliberate trade this module makes everywhere else too.
   */
  private async _store(fresh: { publicKey: string; privateKey: string }): Promise<void> {
    const blob = JSON.stringify({
      v: STORED_VERSION, publicKey: fresh.publicKey, privateKey: fresh.privateKey,
    } satisfies StoredIdentity);
    const vault = _secretsOf(this).vault;
    try {
      await vault.store(DESK_DEVICE_KEY, blob);
    } catch {
      throw new DeskIdentityError('vault-unwritable', 'Desk secret storage could not be written');
    }
  }

  /** Read and structurally validate the vault slot. `undefined` = empty. */
  private async _read(): Promise<StoredIdentity | undefined> {
    // Resolved OUTSIDE the try: a missing WeakMap entry is a wiring bug, and
    // catching it here would relabel it 'vault-unreadable' — the very code
    // collision this module went out of its way to avoid.
    const vault = _secretsOf(this).vault;
    let raw: string | undefined;
    try {
      raw = await vault.get(DESK_DEVICE_KEY);
    } catch {
      // A vault that throws is NOT an empty vault. Treating it as empty is the
      // silent-regeneration bug this module exists to prevent.
      throw new DeskIdentityError('vault-unreadable', 'Desk secret storage could not be read');
    }
    if (raw === undefined || raw === null) { return undefined; }
    if (typeof raw !== 'string') {
      throw new DeskIdentityError('stored-identity-corrupt', 'Stored Desk device key is not a string');
    }
    if (raw.length === 0) { return undefined; }
    if (Buffer.byteLength(raw, 'utf8') > MAX_STORED_BYTES) {
      throw new DeskIdentityError('stored-identity-corrupt', 'Stored Desk device key is implausibly large');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Deliberately swallowing the parse error: V8 quotes the input in it.
      throw new DeskIdentityError('stored-identity-corrupt', 'Stored Desk device key is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DeskIdentityError('stored-identity-corrupt', 'Stored Desk device key is not an object');
    }
    const o = parsed as Record<string, unknown>;
    if (o.v !== STORED_VERSION) {
      throw new DeskIdentityError('stored-identity-corrupt', 'Stored Desk device key has an unknown format version');
    }
    if (typeof o.publicKey !== 'string' || typeof o.privateKey !== 'string'
      || o.publicKey.length === 0 || o.privateKey.length === 0) {
      throw new DeskIdentityError('stored-identity-corrupt', 'Stored Desk device key is missing a key half');
    }
    // Rebuilt field by field rather than spread: whatever else the stored blob
    // carries stops here, so no later code can reach for a field the vault
    // supplied. `peerId` in particular is DERIVED in `_adopt` and never read
    // from storage (I12) — a stored record claiming its own peerId is data,
    // not identity.
    return { v: STORED_VERSION, publicKey: o.publicKey, privateKey: o.privateKey };
  }

  /** Cryptographically validate a record, then install it. */
  private _adopt(stored: StoredIdentity): DeviceIdentity {
    let publicKey: crypto.KeyObject;
    try {
      publicKey = _importPublic(stored.publicKey);
    } catch {
      throw new DeskIdentityError('stored-identity-corrupt', 'Stored Desk public key is not a usable Ed25519 key');
    }
    const privateKey = _importPrivate(stored.privateKey, 'stored-identity-corrupt');

    // Prove the halves belong together. A tampered or half-written record can
    // pair a real public key with someone else's private key; without this
    // check the device would advertise a fingerprint it cannot sign for, and
    // the symptom would be every peer rejecting every call for no stated
    // reason. One signature is a cheap price for a legible failure.
    const probe = Buffer.from('mysti.desk/keypair-probe/1', 'utf8');
    let paired = false;
    try {
      paired = crypto.verify(null, probe, publicKey, crypto.sign(null, probe, privateKey));
    } catch {
      paired = false;
    }
    if (!paired) {
      throw new DeskIdentityError('stored-identity-mismatched',
        'Stored Desk key halves do not belong to the same identity');
    }

    // I12: `peerId` is DERIVED from the public key, never read from the record.
    // A stored blob is input like any other, and a `peerId` field in it is a
    // claim; deriving it makes identity impossible to assert and only possible
    // to demonstrate.
    const identity: DeviceIdentity = { peerId: peerIdFor(stored.publicKey), publicKey: stored.publicKey };
    this._current = identity;
    _secretsOf(this).privateKey = stored.privateKey;
    console.log(`[Mysti] Desk device identity ready: ${identity.peerId}`);
    return identity;
  }

  /** Sign on behalf of this device. The private key never leaves this class. */
  async sign(bytesUtf8: string): Promise<string> {
    await this.ensure();
    const priv = _secretsOf(this).privateKey;
    if (!priv) {
      // Reachable: a `reset()` between this call's `await ensure()` and this
      // line destroys the key underneath it. Signing must fail closed there —
      // an unsigned or stale-key request is worse than a legible error.
      throw new DeskIdentityError('stored-identity-corrupt', 'Desk device key is unavailable for signing');
    }
    return crypto.sign(null, Buffer.from(bytesUtf8, 'utf8'),
      _importPrivate(priv, 'stored-identity-corrupt')).toString('base64');
  }

  current(): DeviceIdentity | null {
    return this._current ? { ...this._current } : null;
  }

  /**
   * Forget the cached identity WITHOUT touching the vault, so the next
   * `ensure()` re-reads the slot.
   *
   * Why this exists: the identity is cached for the life of the process by
   * design (re-reading the keychain on every `sign()` is slow and, on some
   * platforms, a prompt storm), so once a window has adopted it never looks at
   * the vault again. Two editor windows share one SecretStorage, so a window
   * that was open when another window called `reset()` would go on signing
   * with a key its peers have already dropped, with no local signal at all —
   * every request refused for no stated reason. The wiring layer calls this
   * when it observes a SecretStorage change; without such a call, rotation
   * requires a window reload.
   *
   * Two things it deliberately does NOT do. It does not drop `_pending`:
   * that would let the next caller start a second concurrent
   * generate-and-store, the one race the promise memo exists to prevent, and
   * an in-flight load has already read the vault so joining it produces
   * exactly what a re-read would. And it does not drop the signing key: unlike
   * `reset()` this is not a destroy — the key is merely possibly superseded —
   * and clearing it would make a concurrent `sign()` fail for a condition that
   * is not a compromise.
   */
  invalidate(): void {
    this._current = null;
  }

  /**
   * Destroy the device identity. Every peer must re-pair.
   *
   * See the header for why this waits out an in-flight `ensure()` instead of
   * abandoning it. Post-condition once the returned promise resolves: the
   * vault slot is empty, `current()` is null, no signing key is held, and no
   * work that was in flight can put any of it back.
   */
  async reset(): Promise<void> {
    // `async` purely so a wiring-bug throw from `_secretsOf` below arrives as a
    // rejection like every other failure here; the body has no `await` before
    // `_resetting` is installed, so everything the race depends on still runs
    // synchronously on the call, exactly as if this were a plain function.
    //
    // A second reset while one is running is the same reset. Issuing another
    // delete would be harmless but re-entering the wait would not: the second
    // caller would observe an intermediate state as if it were final.
    if (this._resetting) { return this._resetting; }

    // Synchronously, before anything can await between these lines: raise the
    // generation so an in-flight load cannot mint or return under the old
    // identity, and drop the signing key so a `sign()` already past its
    // `await ensure()` finds nothing rather than signing with a key the user
    // just destroyed. Both are repeated after the wait below, because an
    // in-flight `_adopt` may reinstate them in between.
    this._generation++;
    this._current = null;
    delete _secretsOf(this).privateKey;

    const tracked = this._finishReset();
    this._resetting = tracked;
    // Cleared when it settles, either way. The `.catch` is what keeps a
    // fire-and-forget `reset()` whose delete failed from surfacing as an
    // unhandled rejection; the error itself still reaches anyone who awaited.
    void tracked.catch(() => undefined).finally(() => {
      if (this._resetting === tracked) { this._resetting = null; }
    });
    return tracked;
  }

  private async _finishReset(): Promise<void> {
    // Wait out the load that was already running, and only then delete. The
    // old implementation nulled `_pending` and deleted immediately, so the
    // abandoned load's `store()` resolved AFTER the delete and restored the
    // identity the user asked to destroy. A load that fails has nothing to
    // restore, and its error belongs to the `ensure()` caller, not here.
    const inflight = this._pending;
    if (inflight) { await inflight.catch(() => undefined); }

    // `_pending` is deliberately left alone: the load's own `finally` clears
    // it. Nulling it here is exactly how the second concurrent generate-and-
    // store got in — it is the one code path that could walk around the memo.
    this._current = null;
    delete _secretsOf(this).privateKey;

    const vault = _secretsOf(this).vault;
    try {
      await vault.delete(DESK_DEVICE_KEY);
    } catch {
      // In-memory state is already cleared, so this instance holds nothing —
      // but the vault still does, and the next `ensure()` will load it back.
      // Say so with a code the caller can act on rather than leaking the
      // vault's own error object.
      throw new DeskIdentityError('vault-unwritable', 'Desk secret storage could not be cleared');
    }
    // The destroyed peerId is deliberately NOT logged. It is public and
    // derived, so it is not key material — but writing the identity a user
    // just destroyed into a persistent extension log is the opposite of what
    // they asked for.
    console.log('[Mysti] Desk device identity reset');
  }
}
