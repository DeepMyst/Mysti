/**
 * DeskEnvelope tests (Plan 21, invariant I12).
 *
 * A signature proves authorship, never freshness. The tests that matter here
 * are the ones about what a signature does NOT buy you: a captured request
 * must age out, a replay inside the window must still be refused, and a
 * reordered document must not verify against a signature made for a different
 * arrangement of the same keys.
 */
import { describe, it, expect } from 'vitest';
import {
  CLOCK_SKEW_MS,
  ReplayCache,
  canonicalize,
  generateKeyPair,
  newChallenge,
  peerIdFor,
  sign,
  verify,
} from '../../../src/services/desk/DeskEnvelope';
import type { DeskEnvelope } from '../../../src/services/desk/DeskEnvelope';

const NOW = 1_800_000_000_000;
const keys = generateKeyPair();
const other = generateKeyPair();

function envelopeOf(over: Partial<DeskEnvelope> = {}): DeskEnvelope {
  return {
    protocol: 'mysti.desk/1',
    callId: 'call-0001',
    verb: 'locate',
    args: { token: 'backoffSchedule', kind: 'symbol' },
    issuedAt: NOW,
    challenge: 'chal-0001',
    deadlineMs: 30_000,
    ...over,
  };
}

const baseOpts = { publicKey: keys.publicKey, expectedChallenge: 'chal-0001', now: NOW };

describe('canonicalize', () => {
  it('is stable regardless of key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalize({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('emits no incidental whitespace', () => {
    expect(canonicalize({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  it('refuses values JSON cannot round-trip faithfully', () => {
    // Signing a document whose shape depends on stringify's quirks means the
    // signature covers less than it appears to.
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize({ a: NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(() => canonicalize({ a: () => 1 })).toThrow();
    expect(() => canonicalize({ a: 1n })).toThrow();
  });

  it('handles null and empty containers', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });
});

describe('peerIdFor', () => {
  it('is derived from the key, so identity cannot be claimed', () => {
    expect(peerIdFor(keys.publicKey)).toBe(peerIdFor(keys.publicKey));
    expect(peerIdFor(keys.publicKey)).not.toBe(peerIdFor(other.publicKey));
  });

  it('has a stable, readable shape', () => {
    expect(peerIdFor(keys.publicKey)).toMatch(/^p_[a-z2-7]{16}$/);
  });
});

describe('verify — the happy path', () => {
  it('accepts a correctly signed, fresh, challenged envelope', () => {
    const signed = sign(envelopeOf(), keys.privateKey);
    const res = verify(signed, baseOpts);
    expect(res.ok).toBe(true);
    expect(res.ok && res.envelope.verb).toBe('locate');
  });

  it('accepts regardless of the key order the sender happened to use', () => {
    const signed = sign(envelopeOf(), keys.privateKey);
    // Re-materialise the envelope with a different property order.
    const reordered = JSON.parse(JSON.stringify({
      deadlineMs: signed.envelope.deadlineMs,
      challenge: signed.envelope.challenge,
      issuedAt: signed.envelope.issuedAt,
      args: signed.envelope.args,
      verb: signed.envelope.verb,
      callId: signed.envelope.callId,
      protocol: signed.envelope.protocol,
    }));
    expect(verify({ envelope: reordered, signature: signed.signature }, baseOpts).ok).toBe(true);
  });
});

describe('verify — forgery and tampering', () => {
  it('refuses a signature from a different key', () => {
    const signed = sign(envelopeOf(), other.privateKey);
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses when any signed field is altered', () => {
    for (const mutate of [
      (e: DeskEnvelope) => { e.verb = 'consult'; },
      (e: DeskEnvelope) => { e.args = { token: 'other', kind: 'symbol' }; },
      (e: DeskEnvelope) => { e.callId = 'call-0002'; },
      (e: DeskEnvelope) => { e.deadlineMs = 999_999; },
    ]) {
      const signed = sign(envelopeOf(), keys.privateKey);
      mutate(signed.envelope);
      expect(verify(signed, baseOpts).ok, 'tampering must not verify').toBe(false);
    }
  });

  it('refuses a garbage or truncated signature', () => {
    const signed = sign(envelopeOf(), keys.privateKey);
    expect(verify({ ...signed, signature: 'not-base64!!' }, baseOpts).ok).toBe(false);
    expect(verify({ ...signed, signature: signed.signature.slice(0, 20) }, baseOpts).ok).toBe(false);
    expect(verify({ ...signed, signature: '' }, baseOpts).ok).toBe(false);
  });

  it('refuses a wrong protocol version', () => {
    const signed = sign(envelopeOf({ protocol: 'mysti.desk/2' as 'mysti.desk/1' }), keys.privateKey);
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'bad-protocol' });
  });

  it('refuses malformed shapes before doing any crypto', () => {
    for (const bad of [null, 'string', 42, {}, { signature: 'x' }, { envelope: {}, signature: 'x' }]) {
      expect(verify(bad, baseOpts)).toEqual({ ok: false, reason: 'bad-shape' });
    }
  });

  it('refuses an envelope with a non-object args', () => {
    const signed = sign(envelopeOf(), keys.privateKey);
    (signed.envelope as unknown as Record<string, unknown>).args = 'nope';
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'bad-shape' });
  });

  it('refuses a non-positive deadline', () => {
    const signed = sign(envelopeOf({ deadlineMs: 0 }), keys.privateKey);
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'bad-shape' });
  });
});

describe('verify — freshness', () => {
  it('refuses a request older than the skew window', () => {
    const signed = sign(envelopeOf({ issuedAt: NOW - CLOCK_SKEW_MS - 1 }), keys.privateKey);
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a FUTURE-dated request rather than tolerating it', () => {
    // Accepting one would let a sender mint a request that outlives its
    // natural window.
    const signed = sign(envelopeOf({ issuedAt: NOW + CLOCK_SKEW_MS + 1 }), keys.privateKey);
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'future' });
  });

  it('accepts modest skew in both directions', () => {
    for (const delta of [-CLOCK_SKEW_MS + 1000, 0, CLOCK_SKEW_MS - 1000]) {
      const signed = sign(envelopeOf({ issuedAt: NOW + delta }), keys.privateKey);
      expect(verify(signed, baseOpts).ok, `skew ${delta} should verify`).toBe(true);
    }
  });
});

describe('verify — challenge binding', () => {
  it('refuses an envelope echoing the wrong challenge', () => {
    const signed = sign(envelopeOf({ challenge: 'chal-9999' }), keys.privateKey);
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'bad-challenge' });
  });

  it('refuses when the challenge differs only in length', () => {
    const signed = sign(envelopeOf({ challenge: 'chal-0001x' }), keys.privateKey);
    expect(verify(signed, baseOpts)).toEqual({ ok: false, reason: 'bad-challenge' });
  });

  it('newChallenge is unpredictable and id-shaped', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newChallenge()));
    expect(seen.size).toBe(50);
    for (const c of seen) { expect(c).toMatch(/^[A-Za-z0-9_-]{1,64}$/); }
  });
});

describe('verify — replay', () => {
  it('accepts a callId once and refuses it thereafter', () => {
    const replay = new ReplayCache();
    const signed = sign(envelopeOf(), keys.privateKey);
    expect(verify(signed, { ...baseOpts, replay }).ok).toBe(true);
    expect(verify(signed, { ...baseOpts, replay })).toEqual({ ok: false, reason: 'replay' });
  });

  it('admits distinct callIds', () => {
    const replay = new ReplayCache();
    for (const id of ['call-a', 'call-b', 'call-c']) {
      const signed = sign(envelopeOf({ callId: id }), keys.privateKey);
      expect(verify(signed, { ...baseOpts, replay }).ok).toBe(true);
    }
  });

  it('does NOT record a callId whose signature failed', () => {
    // Otherwise an attacker could poison the cache with forged callIds and
    // deny a legitimate request that later uses one.
    const replay = new ReplayCache();
    const forged = sign(envelopeOf({ callId: 'call-victim' }), other.privateKey);
    expect(verify(forged, { ...baseOpts, replay }).reason).toBe('bad-signature');

    const genuine = sign(envelopeOf({ callId: 'call-victim' }), keys.privateKey);
    expect(verify(genuine, { ...baseOpts, replay }).ok).toBe(true);
  });

  it('does NOT record a callId that failed the challenge check', () => {
    const replay = new ReplayCache();
    const wrongChallenge = sign(envelopeOf({ callId: 'call-x', challenge: 'nope' }), keys.privateKey);
    expect(verify(wrongChallenge, { ...baseOpts, replay }).reason).toBe('bad-challenge');
    const good = sign(envelopeOf({ callId: 'call-x' }), keys.privateKey);
    expect(verify(good, { ...baseOpts, replay }).ok).toBe(true);
  });

  it('evicts entries once they age past the window, so it stays bounded', () => {
    const replay = new ReplayCache(1000);
    replay.admit('old', NOW);
    expect(replay.size).toBe(1);
    replay.admit('new', NOW + 5000);
    expect(replay.size).toBe(1); // 'old' evicted
  });
});
