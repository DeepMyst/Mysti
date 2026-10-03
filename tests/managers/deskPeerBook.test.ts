/**
 * DeskPeerBook — Plan 21 Phase 2 (invariants I13, I17, I36).
 *
 * These tests are written against the ATTACKS, not the API. Each block names
 * the thing that must not happen: a peer keeping itself alive with its own
 * traffic, a rotated key inheriting a pin, a tampered store minting budget or
 * lifetime, a sender-chosen number widening a receiver-computed bound.
 *
 * Every security branch in the module has a test here that goes red if the
 * branch is deleted — that is the point of the file, not coverage.
 *
 * Hostile characters appear as \uXXXX escapes on purpose: a literal bidi
 * override in a source file reorders the file for the next reader, which is
 * the very attack under test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import type { DeskPeer, PeerGrant } from '../../src/types';
import {
  DeskPeerBook,
  DESK_PEER_DEFAULT_LIMITS,
  type PeerStore,
  type DeskPeerLimits,
} from '../../src/managers/DeskPeerBook';
import { peerIdFor } from '../../src/services/desk/DeskEnvelope';

const STORE_KEY = 'mysti.desk.peerBook.v1';
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class FakeStore implements PeerStore {
  data = new Map<string, unknown>();
  /** Per-call artificial latency, shifted off the front on each update. */
  delays: number[] = [];
  writes = 0;
  /** When set, `update` rejects: a store that is present but cannot write. */
  failWrites = false;

  get<T>(key: string): T | undefined { return this.data.get(key) as T | undefined; }

  async update(key: string, value: unknown): Promise<void> {
    this.writes++;
    const d = this.delays.shift() ?? 0;
    if (d > 0) { await new Promise(r => setTimeout(r, d)); }
    if (this.failWrites) { throw new Error('storage full'); }
    // Round-trip through JSON so a test can never accidentally assert against
    // a live object reference the book still holds.
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

let clock = T0;
const now = () => clock;

/** Small, legible bounds so a test can outlive a lifetime in a few lines. */
const LIMITS: DeskPeerLimits = {
  ttlMs: 1_000,
  absoluteMaxLifetimeMs: 2_500,
  rateCapacity: 3,
  rateRefillWindowMs: 3_000,
  servingBudgetUsdPerDay: 10,
};

function newKey(): string {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

function makePeer(alias: string, publicKey = newKey()): DeskPeer {
  return {
    peerId: peerIdFor(publicKey),
    alias,
    publicKey,
    trustDomain: 'acme.com',
    // Both are overwritten by addPeer; supplied to prove they are ignored.
    pairedAt: 0,
    expiresAt: 0,
  };
}

function makeGrant(peerId: string, over: Partial<PeerGrant> = {}): PeerGrant {
  return {
    peerId,
    verbs: ['status', 'locate'],
    scope: ['src'],
    expiresAt: T0 + 10_000_000,
    budgetUsd: 5,
    maxCalls: 1_000,
    minRetentionClass: 'zero-retention',
    ...over,
  };
}

function book(store: PeerStore, limits: Partial<DeskPeerLimits> = LIMITS): DeskPeerBook {
  return new DeskPeerBook(store, now, limits);
}

async function pair(b: DeskPeerBook, alias: string, over: Partial<PeerGrant> = {}): Promise<DeskPeer> {
  const p = makePeer(alias);
  await b.addPeer(p, makeGrant(p.peerId, over));
  return p;
}

beforeEach(() => { clock = T0; });

// ---------------------------------------------------------------------------

describe('DeskPeerBook — roster admission', () => {
  it('pins a peer and derives its lifetime from local limits, not from the caller', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    const stored = b.getPeerById(p.peerId)!;
    expect(stored.pairedAt).toBe(T0);
    expect(stored.expiresAt).toBe(T0 + LIMITS.ttlMs);
    expect(b.getGrant(p.peerId)).not.toBeNull();
  });

  it('refuses a duplicate alias instead of overwriting the pinned peer', async () => {
    const b = book(new FakeStore());
    const first = await pair(b, 'alice');
    const impostor = makePeer('alice');
    await expect(b.addPeer(impostor, makeGrant(impostor.peerId))).rejects.toThrow(/already in use/);
    // The original pin is untouched, and the alias still routes to it.
    expect(b.getPeerByAlias('alice')!.peerId).toBe(first.peerId);
    expect(b.getPeerById(impostor.peerId)).toBeNull();
  });

  it('refuses re-adding a peerId that is already pinned', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    const again: DeskPeer = { ...p, alias: 'alice2' };
    await expect(b.addPeer(again, makeGrant(p.peerId))).rejects.toThrow(/already paired/);
  });

  it('refuses a peerId that does not follow from the public key', async () => {
    const b = book(new FakeStore());
    const victim = makePeer('alice');
    const forged: DeskPeer = { ...victim, publicKey: newKey() };
    await expect(b.addPeer(forged, makeGrant(forged.peerId))).rejects.toThrow(/validation/);
  });

  it('refuses a grant that names a different peer', async () => {
    const b = book(new FakeStore());
    const alice = makePeer('alice');
    const other = makePeer('bob');
    await expect(b.addPeer(alice, makeGrant(other.peerId))).rejects.toThrow(/grant failed/);
  });

  it.each([
    ['uppercase alias', 'Alice'],
    ['leading dash', '-alice'],
    ['bidi override', 'ali\u202Ece'],
    ['zero width', 'ali\u200Bce'],
    ['whitespace', 'ali ce'],
    ['too long', 'a'.repeat(33)],
  ])('refuses a malformed alias (%s)', async (_label, alias) => {
    const b = book(new FakeStore());
    const p = makePeer(alias);
    await expect(b.addPeer(p, makeGrant(p.peerId))).rejects.toThrow(/peer failed/);
  });

  it('refuses a grant carrying an unknown verb or an escaping scope', async () => {
    const b = book(new FakeStore());
    const p = makePeer('alice');
    await expect(
      b.addPeer(p, makeGrant(p.peerId, { verbs: ['write' as never] })),
    ).rejects.toThrow(/grant failed/);
    const q = makePeer('bob');
    await expect(
      b.addPeer(q, makeGrant(q.peerId, { scope: ['../../etc'] })),
    ).rejects.toThrow(/grant failed/);
  });

  it('refuses a trustDomain carrying a newline (it is rendered on a one-line card)', async () => {
    const b = book(new FakeStore());
    const p: DeskPeer = { ...makePeer('alice'), trustDomain: 'acme.com\nadmin' };
    await expect(b.addPeer(p, makeGrant(p.peerId))).rejects.toThrow(/peer failed/);
  });

  it('hands out copies, so a caller cannot widen a grant it was given', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    const g = b.getGrant(p.peerId)!;
    g.scope.push('..');
    g.verbs.push('consult');
    expect(b.getGrant(p.peerId)!.scope).toEqual(['src']);
    expect(b.getGrant(p.peerId)!.verbs).toEqual(['status', 'locate']);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — revocation (I13)', () => {
  it('rejects a revoked peer everywhere, cheaply and before anything else runs', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    await b.revoke(p.peerId, 'laptop stolen');

    expect(b.isRevoked(p.peerId)).toBe(true);
    expect(b.getGrant(p.peerId)).toBeNull();
    expect(b.getPeerById(p.peerId)).toBeNull();
    expect(b.getPeerByAlias('alice')).toBeNull();
    expect(b.listPeers()).toHaveLength(0);
    expect(b.checkRate(p.peerId, clock).allowed).toBe(false);
    expect(b.budgetRemaining(p.peerId)).toBe(0);
    expect(b.listRevoked().map(r => r.reason)).toEqual(['laptop stolen']);
  });

  it('revokes even when the reason is unrenderable, substituting the text', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    // A refused revocation would be the security own-goal: the reason string
    // must never be able to keep a compromised key alive.
    await b.revoke(p.peerId, 'compromised\u202Ekey');
    expect(b.isRevoked(p.peerId)).toBe(true);
    expect(b.listRevoked()[0].reason).toMatch(/withheld/);

    const q = await pair(b, 'bob');
    await b.revoke(q.peerId, 'line one\nline two');
    expect(b.isRevoked(q.peerId)).toBe(true);
    expect(b.listRevoked()[1].reason).toMatch(/withheld/);
  });

  it('tombstones an unknown peerId, so revoke-then-pair cannot resurrect it', async () => {
    const b = book(new FakeStore());
    const p = makePeer('alice');
    await b.revoke(p.peerId, 'pre-emptive');
    await expect(b.addPeer(p, makeGrant(p.peerId))).rejects.toThrow(/revoked/);
  });

  it('keeps the tombstone across a reload', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');
    await b1.revoke(p.peerId, 'gone');

    const b2 = book(store);
    expect(b2.isRevoked(p.peerId)).toBe(true);
    expect(b2.getGrant(p.peerId)).toBeNull();
    await expect(b2.addPeer(p, makeGrant(p.peerId))).rejects.toThrow(/revoked/);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — TTL is renewed only from the outside (I13)', () => {
  it('does not renew on inbound traffic, and lets the peer expire under load', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    const before = b.getPeerById(p.peerId)!.expiresAt;

    // Everything an inbound request can touch.
    for (let i = 0; i < 5; i++) {
      clock += 100;
      b.checkRate(p.peerId, clock);
      await b.spend(p.peerId, 0.01);
      b.getGrant(p.peerId);
      b.isRevoked(p.peerId);
      b.budgetRemaining(p.peerId);
    }
    expect(b.getPeerById(p.peerId)!.expiresAt).toBe(before);

    clock = T0 + LIMITS.ttlMs;
    b.checkRate(p.peerId, clock);
    await b.spend(p.peerId, 0.01);
    expect(b.getGrant(p.peerId)).toBeNull();
  });

  it('renews on locally-originated outbound activity', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    clock = T0 + 900;
    await b.touchOutbound(p.peerId);
    expect(b.getPeerById(p.peerId)!.expiresAt).toBe(T0 + 900 + LIMITS.ttlMs);
    clock = T0 + LIMITS.ttlMs + 500;
    expect(b.getGrant(p.peerId)).not.toBeNull();
  });

  it('cannot push a peer past its absolute maximum lifetime, however often it is touched', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    const ceiling = T0 + LIMITS.absoluteMaxLifetimeMs;

    for (let t = 500; t < LIMITS.absoluteMaxLifetimeMs; t += 250) {
      clock = T0 + t;
      await b.touchOutbound(p.peerId);
      expect(b.getPeerById(p.peerId)!.expiresAt).toBeLessThanOrEqual(ceiling);
    }
    clock = ceiling;
    expect(b.getGrant(p.peerId)).toBeNull();
    await b.touchOutbound(p.peerId);
    expect(b.getGrant(p.peerId)).toBeNull();
  });

  it('never resurrects an expired or revoked peer via touchOutbound', async () => {
    const store = new FakeStore();
    const b = book(store);
    const expired = await pair(b, 'alice');
    const revoked = await pair(b, 'bob');
    await b.revoke(revoked.peerId, 'x');

    // The revoked peer is deliberately still INSIDE its TTL here: at
    // T0 + ttl + 1 the expiry guard would return first and the revocation
    // guard would never be the reason anything held.
    clock = T0 + 500;
    const writesBefore = store.writes;
    await b.touchOutbound(revoked.peerId);
    // Asserting through getGrant would prove nothing — getGrant checks
    // revocation itself. The stored record is the honest channel: a renewal
    // that happened would have written one.
    expect(store.writes).toBe(writesBefore);
    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { peer: DeskPeer }> };
    expect(raw.peers[revoked.peerId].peer.expiresAt).toBe(T0 + LIMITS.ttlMs);

    clock = T0 + LIMITS.ttlMs + 1;
    await b.touchOutbound(expired.peerId);
    expect(b.getGrant(expired.peerId)).toBeNull();
    expect(b.getGrant(revoked.peerId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — key rotation is a new identity (I13 / A7)', () => {
  it('gives the rotated key a distinct peerId, a distinct alias and a fresh history', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    await b.spend(alice.peerId, 3);

    const rotated = makePeer('ignored-alias');
    await b.addRotatedPeer(alice.peerId, rotated, makeGrant(rotated.peerId));

    expect(rotated.peerId).not.toBe(alice.peerId);
    expect(b.getPeerById(rotated.peerId)!.alias).toBe('alice-2');
    expect(b.renderAlias(rotated.peerId)).toBe('alice (2)');
    expect(b.rotatedFrom(rotated.peerId)).toBe(alice.peerId);
    // Inherits no history: visibility begins at its own pairing event.
    expect(b.spentToday(rotated.peerId)).toBe(0);
    expect(b.callsUsed(rotated.peerId)).toBe(0);
    // And the old identity is untouched — rotation is not revocation.
    expect(b.getPeerByAlias('alice')!.peerId).toBe(alice.peerId);
    expect(b.spentToday(alice.peerId)).toBe(3);
  });

  it('starts the rotated peer at the current clock, not the original pairing', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    clock = T0 + 400;
    const rotated = makePeer('x');
    await b.addRotatedPeer(alice.peerId, rotated, makeGrant(rotated.peerId));
    expect(b.getPeerById(rotated.peerId)!.pairedAt).toBe(T0 + 400);
    expect(b.getPeerById(rotated.peerId)!.expiresAt).toBe(T0 + 400 + LIMITS.ttlMs);
  });

  it('refuses a "rotation" that reuses the same key', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    const same = makePeer('alice2', alice.publicKey);
    await expect(b.addRotatedPeer(alice.peerId, same, makeGrant(same.peerId)))
      .rejects.toThrow(/different key/);
  });

  it('numbers a third identity (3) rather than colliding with the second', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    const two = makePeer('x');
    await b.addRotatedPeer(alice.peerId, two, makeGrant(two.peerId));
    const three = makePeer('y');
    await b.addRotatedPeer(two.peerId, three, makeGrant(three.peerId));
    expect(b.getPeerById(three.peerId)!.alias).toBe('alice-3');
    expect(b.renderAlias(three.peerId)).toBe('alice (3)');
  });

  it('refuses rather than truncating when the suffixed alias will not fit', async () => {
    const b = book(new FakeStore());
    const long = await pair(b, 'a'.repeat(31));
    const rotated = makePeer('x');
    await expect(b.addRotatedPeer(long.peerId, rotated, makeGrant(rotated.peerId)))
      .rejects.toThrow(/not a valid alias/);
  });

  it('refuses to rotate from an unknown peer', async () => {
    const b = book(new FakeStore());
    const p = makePeer('x');
    await expect(b.addRotatedPeer('p_nosuchpeer00000', p, makeGrant(p.peerId)))
      .rejects.toThrow(/unknown previous peer/);
  });

  it('refuses a rotated identity that has been revoked', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    const rotated = makePeer('x');
    await b.revoke(rotated.peerId, 'known-bad key');
    await expect(b.addRotatedPeer(alice.peerId, rotated, makeGrant(rotated.peerId)))
      .rejects.toThrow(/revoked/);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — receiver-computed rate bucket (I17)', () => {
  // Rate is orthogonal to lifetime, so these cases run with a peer that
  // comfortably outlives the refill window — otherwise "the bucket refilled"
  // and "the peer expired" are indistinguishable in the assertion.
  const RATE: DeskPeerLimits = { ...LIMITS, ttlMs: 10_000_000, absoluteMaxLifetimeMs: 10_000_000 };

  it('allows a burst up to capacity, then refuses with a real retry hint', async () => {
    const b = book(new FakeStore(), RATE);
    const p = await pair(b, 'alice');
    for (let i = 0; i < LIMITS.rateCapacity; i++) {
      expect(b.checkRate(p.peerId, clock)).toEqual({ allowed: true, retryAfterMs: 0 });
    }
    const denied = b.checkRate(p.peerId, clock);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1_000);
  });

  it('refills over time', async () => {
    const b = book(new FakeStore(), RATE);
    const p = await pair(b, 'alice');
    for (let i = 0; i < LIMITS.rateCapacity; i++) { b.checkRate(p.peerId, clock); }
    expect(b.checkRate(p.peerId, clock).allowed).toBe(false);

    clock += 1_000; // one token's worth
    expect(b.checkRate(p.peerId, clock).allowed).toBe(true);
    expect(b.checkRate(p.peerId, clock).allowed).toBe(false);
  });

  it('never exceeds capacity however long the peer is idle', async () => {
    const b = book(new FakeStore(), RATE);
    const p = await pair(b, 'alice');
    b.checkRate(p.peerId, clock);
    clock += LIMITS.rateRefillWindowMs * 100;
    let allowed = 0;
    for (let i = 0; i < 50; i++) { if (b.checkRate(p.peerId, clock).allowed) { allowed++; } }
    expect(allowed).toBe(LIMITS.rateCapacity);
  });

  it('cannot be refilled by a caller passing a far-future timestamp', async () => {
    const b = book(new FakeStore(), RATE);
    const p = await pair(b, 'alice');
    for (let i = 0; i < LIMITS.rateCapacity; i++) { b.checkRate(p.peerId, clock); }
    // The clock is the authority; the argument is only ever clamped downwards.
    expect(b.checkRate(p.peerId, clock + 10_000_000).allowed).toBe(false);
    expect(b.checkRate(p.peerId, Number.POSITIVE_INFINITY).allowed).toBe(false);
    expect(b.checkRate(p.peerId, Number.NaN).allowed).toBe(false);
  });

  it('does not mint tokens from a timestamp that runs backwards', async () => {
    const b = book(new FakeStore(), RATE);
    const p = await pair(b, 'alice');
    for (let i = 0; i < LIMITS.rateCapacity; i++) { b.checkRate(p.peerId, clock); }
    const back = b.checkRate(p.peerId, clock - 60_000);
    expect(back.allowed).toBe(false);
    // `allowed` alone is not enough: without the floor on elapsed the balance
    // goes far negative and the retry hint inflates without bound from a
    // timestamp the CALLER chose, while `allowed` stays false either way.
    // One token's worth of refill is 1000ms at capacity 3 over 3000ms.
    expect(back.retryAfterMs).toBe(1_000);
    // The backwards call must not have rewound `lastMs` either, or the next
    // honest call would be credited with the gap.
    const next = b.checkRate(p.peerId, clock);
    expect(next.allowed).toBe(false);
    expect(next.retryAfterMs).toBe(1_000);
  });

  it('refuses an unknown, expired or ungranted peer without a bucket', async () => {
    const b = book(new FakeStore());
    expect(b.checkRate('p_unknown00000000', clock).allowed).toBe(false);
    const p = await pair(b, 'alice');
    clock = T0 + LIMITS.ttlMs;
    expect(b.checkRate(p.peerId, clock).allowed).toBe(false);
  });

  it('refuses everything when capacity is configured to zero', async () => {
    const b = book(new FakeStore(), { ...LIMITS, rateCapacity: 0 });
    const p = await pair(b, 'alice');
    const r = b.checkRate(p.peerId, clock);
    expect(r.allowed).toBe(false);
    // Without the zero-capacity gate the deficit maths divides by zero and
    // hands the caller `Infinity`, which `allowed` alone never notices.
    expect(Number.isFinite(r.retryAfterMs)).toBe(true);
    expect(r.retryAfterMs).toBe(LIMITS.rateRefillWindowMs);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — currency budget is a hard stop (I17)', () => {
  it('defaults to zero serving budget, so nothing is served until a human funds it', async () => {
    const b = new DeskPeerBook(new FakeStore(), now); // no limits override
    const p = await pair(b, 'alice');
    expect(b.budgetRemaining(p.peerId)).toBe(0);
  });

  it('draws down to exactly zero and never below', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice', { budgetUsd: 0.5 });
    expect(b.budgetRemaining(p.peerId)).toBeCloseTo(0.5, 10);
    await b.spend(p.peerId, 0.4);
    expect(b.budgetRemaining(p.peerId)).toBeCloseTo(0.1, 10);
    await b.spend(p.peerId, 5);
    expect(b.budgetRemaining(p.peerId)).toBe(0);
    expect(b.spentToday(p.peerId)).toBeCloseTo(5.4, 10);
  });

  it('caps the machine-wide pool across peers, not just each peer against its own grant', async () => {
    const b = book(new FakeStore(), { ...LIMITS, servingBudgetUsdPerDay: 1.2 });
    const a = await pair(b, 'alice', { budgetUsd: 1 });
    const c = await pair(b, 'bob', { budgetUsd: 1 });
    await b.spend(a.peerId, 1);
    expect(b.budgetRemaining(a.peerId)).toBe(0);
    // bob is well inside his own grant, and still bounded by the shared pool.
    expect(b.budgetRemaining(c.peerId)).toBeCloseTo(0.2, 10);
  });

  it('refuses a negative or non-finite spend rather than crediting the wallet', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice', { budgetUsd: 1 });
    await b.spend(p.peerId, 1);
    await expect(b.spend(p.peerId, -5)).rejects.toThrow(/non-negative/);
    await expect(b.spend(p.peerId, Number.NaN)).rejects.toThrow(/finite/);
    await expect(b.spend(p.peerId, Number.POSITIVE_INFINITY)).rejects.toThrow(/finite/);
    expect(b.budgetRemaining(p.peerId)).toBe(0);
  });

  it('rolls the daily figure over in UTC while the lifetime call count survives', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice', { budgetUsd: 5 });
    await b.spend(p.peerId, 2);
    expect(b.spentToday(p.peerId)).toBe(2);
    expect(b.callsUsed(p.peerId)).toBe(1);

    clock = T0 + 25 * 60 * 60 * 1000;
    await b.touchOutbound(p.peerId);
    expect(b.spentToday(p.peerId)).toBe(0);
    expect(b.spentTodayAll()).toBe(0);
    expect(b.callsUsed(p.peerId)).toBe(1);
  });

  it('kills the grant when the lifetime call ceiling is reached', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice', { maxCalls: 2 });
    await b.spend(p.peerId, 0);
    expect(b.getGrant(p.peerId)).not.toBeNull();
    await b.spend(p.peerId, 0);
    expect(b.getGrant(p.peerId)).toBeNull();
    expect(b.checkRate(p.peerId, clock).allowed).toBe(false);
    expect(b.budgetRemaining(p.peerId)).toBe(0);
  });

  it('stops serving once the grant itself expires, independently of the peer TTL', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice', { expiresAt: T0 + 300 });
    expect(b.getGrant(p.peerId)).not.toBeNull();
    clock = T0 + 300;
    expect(b.getGrant(p.peerId)).toBeNull();
    expect(b.getPeerById(p.peerId)).not.toBeNull(); // still on the roster, visibly dead
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — persistence and a hostile store', () => {
  it('round-trips the roster, the ledger and the tombstones', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const a = await pair(b1, 'alice', { budgetUsd: 4, verbs: ['status', 'consult'], scope: ['src', 'docs'] });
    const c = await pair(b1, 'bob');
    await b1.spend(a.peerId, 1.25);
    await b1.revoke(c.peerId, 'left the team');
    clock = T0 + 400;
    await b1.touchOutbound(a.peerId);

    const b2 = book(store);
    expect(b2.listPeers().map(p => p.alias)).toEqual(['alice']);
    expect(b2.getPeerById(a.peerId)!.expiresAt).toBe(T0 + 400 + LIMITS.ttlMs);
    expect(b2.getGrant(a.peerId)!.verbs).toEqual(['status', 'consult']);
    expect(b2.getGrant(a.peerId)!.scope).toEqual(['src', 'docs']);
    expect(b2.spentToday(a.peerId)).toBe(1.25);
    expect(b2.callsUsed(a.peerId)).toBe(1);
    expect(b2.isRevoked(c.peerId)).toBe(true);
  });

  it('serialises overlapping writes so a slow one cannot clobber a newer state', async () => {
    // The hazard is a snapshot taken BEFORE a later mutation, landing AFTER
    // that mutation's own write. Two back-to-back spends do NOT reproduce it —
    // both mutate memory before either snapshot is built, so both snapshots
    // agree and the write order stops mattering. That is exactly why the
    // previous version of this test stayed green with the queue deleted.
    //
    // Two ingredients are needed. (1) The slow write must TAKE ITS SNAPSHOT
    // before the second mutation exists — hence the tick. (2) The field must
    // be one the snapshot really copies: `Object.fromEntries` is shallow, and
    // `touchOutbound` REPLACES `rec.peer` on a record the snapshot still
    // points at, so an expiry renewal leaks into an in-flight write and hides
    // the bug. Ledger rows are replaced in the map, so they are honest.
    const store = new FakeStore();
    store.delays = [0, 50, 0]; // the pairing write, then a slow one, then a fast one
    const b1 = book(store);
    const p = await pair(b1, 'alice', { budgetUsd: 10 });

    const slow = b1.spend(p.peerId, 1);
    await Promise.resolve(); // the slow write snapshots {usd: 1} here
    const fast = b1.spend(p.peerId, 2);
    await Promise.all([slow, fast]);

    const b2 = book(store);
    // Without the queue the fast write lands first and the slow, older
    // snapshot overwrites it: 1, not 3.
    expect(b2.spentToday(p.peerId)).toBe(3);
    expect(b2.callsUsed(p.peerId)).toBe(2);
  });

  it('drops a stored record whose peerId was swapped onto another key', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const victim = await pair(b1, 'alice');

    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { peer: DeskPeer }> };
    raw.peers[victim.peerId].peer.publicKey = newKey(); // pin transfer attempt
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    expect(b2.listPeers()).toHaveLength(0);
    expect(b2.getGrant(victim.peerId)).toBeNull();
    expect(b2.getPeerByAlias('alice')).toBeNull();
  });

  it('re-clamps a stored expiry that was pushed past the absolute maximum', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');

    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { peer: DeskPeer }> };
    raw.peers[p.peerId].peer.expiresAt = T0 + 10 * 365 * 24 * 60 * 60 * 1000;
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    // This is the LOAD-time clamp, and the roster figure is the honest channel
    // for it: the card the human reads must not say "expires in ten years"
    // while authorization quietly refuses. `getGrant`'s own re-clamp is
    // unreachable belt-and-braces (every writer of `expiresAt` clamps first),
    // so it is deliberately NOT claimed as tested here.
    expect(b2.getPeerById(p.peerId)!.expiresAt).toBe(T0 + LIMITS.absoluteMaxLifetimeMs);
    expect(b2.listPeers()[0].expiresAt).toBe(T0 + LIMITS.absoluteMaxLifetimeMs);
    clock = T0 + LIMITS.absoluteMaxLifetimeMs;
    expect(b2.getGrant(p.peerId)).toBeNull();
  });

  it('drops a stored grant that was widened to name another peer', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');

    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { grant: PeerGrant }> };
    raw.peers[p.peerId].grant.peerId = 'p_someoneelse0000';
    store.data.set(STORE_KEY, raw);

    expect(book(store).getGrant(p.peerId)).toBeNull();
  });

  it('drops a stored grant carrying a verb that is not in the table', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');

    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { grant: PeerGrant }> };
    raw.peers[p.peerId].grant.verbs = ['status', 'exec' as never];
    store.data.set(STORE_KEY, raw);

    expect(book(store).getGrant(p.peerId)).toBeNull();
  });

  it('reads a negative stored spend as zero rather than as credit', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice', { budgetUsd: 1 });
    await b1.spend(p.peerId, 1);

    const raw = store.data.get(STORE_KEY) as { ledger: Record<string, { usdToday: number }> };
    raw.ledger[p.peerId].usdToday = -1_000_000;
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    expect(b2.spentToday(p.peerId)).toBe(0);
    // The refill did not happen: the ceiling is still the grant, not the lie.
    expect(b2.budgetRemaining(p.peerId)).toBe(1);
  });

  it('honours only the first of two stored records claiming one alias', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const a = await pair(b1, 'alice');
    const c = await pair(b1, 'bob');

    const raw = store.data.get(STORE_KEY) as {
      peers: Record<string, { peer: DeskPeer; aliasBase: string }>;
    };
    // Both halves moved, or the alias-reconciliation check would drop this
    // record first and the dedupe below would never be the reason anything
    // held.
    raw.peers[c.peerId].peer.alias = 'alice';
    raw.peers[c.peerId].aliasBase = 'alice';
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    expect(b2.listPeers()).toHaveLength(1);
    expect(b2.getPeerByAlias('alice')!.peerId).toBe(a.peerId);
  });

  it('starts empty rather than throwing when the store holds garbage', () => {
    const store = new FakeStore();
    for (const junk of ['not an object', 42, [], null, { peers: 'nope', revoked: 7, ledger: [] }]) {
      store.data.set(STORE_KEY, junk);
      const b = book(store);
      expect(b.listPeers()).toEqual([]);
      expect(b.getGrant('p_anything00000000')).toBeNull();
    }
  });

  it('survives a store whose read throws', () => {
    const throwing: PeerStore = {
      get() { throw new Error('storage unavailable'); },
      async update() { /* no-op */ },
    };
    const b = new DeskPeerBook(throwing, now, LIMITS);
    expect(b.listPeers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — limits are validated, not spread (I17)', () => {
  // `{ ...DEFAULTS, ...partial }` lets an explicit `undefined` — exactly what
  // `cfg.get<number>('mysti.desk.…')` returns for a setting the user never
  // set — DELETE a default. What follows is NaN, and NaN loses every
  // comparison: `NaN < 1` is false, `now >= NaN` is false. Each case below
  // used to produce a book with no rate limit at all, silently and for good.
  const LONG_LIVED = { ttlMs: 10_000_000, absoluteMaxLifetimeMs: 10_000_000 };
  const hostile: Array<[string, Partial<DeskPeerLimits>]> = [
    ['zero refill window', { rateRefillWindowMs: 0 }],
    ['negative refill window', { rateRefillWindowMs: -1 }],
    ['NaN refill window', { rateRefillWindowMs: Number.NaN }],
    ['undefined capacity', { rateCapacity: undefined }],
    ['NaN capacity', { rateCapacity: Number.NaN }],
    ['infinite capacity', { rateCapacity: Number.POSITIVE_INFINITY }],
  ];

  it.each(hostile)('still caps a burst (%s)', async (_label, over) => {
    const b = book(new FakeStore(), { ...LIMITS, ...LONG_LIVED, ...over });
    const p = await pair(b, 'alice');
    let allowed = 0;
    for (let i = 0; i < 500; i++) { if (b.checkRate(p.peerId, clock).allowed) { allowed++; } }
    expect(allowed).toBeGreaterThan(0);
    // Either the configured capacity (3) or the default fallback (20) — never
    // "all 500 of them".
    expect(allowed).toBeLessThanOrEqual(DESK_PEER_DEFAULT_LIMITS.rateCapacity);
  });

  it('falls back to a real TTL rather than minting a NaN deadline', async () => {
    const b = book(new FakeStore(), { ...LIMITS, ttlMs: undefined });
    const p = await pair(b, 'alice');
    const stored = b.getPeerById(p.peerId)!;
    expect(Number.isFinite(stored.expiresAt)).toBe(true);
    // The default TTL is 60 days, so the absolute maximum is what binds.
    expect(stored.expiresAt).toBe(T0 + LIMITS.absoluteMaxLifetimeMs);
    clock = T0 + LIMITS.absoluteMaxLifetimeMs;
    expect(b.getGrant(p.peerId)).toBeNull();
  });

  it('falls back to a real absolute maximum rather than an unbounded lifetime', async () => {
    for (const bad of [undefined, Number.NaN, 0, -1]) {
      clock = T0;
      const b = book(new FakeStore(), { ...LIMITS, absoluteMaxLifetimeMs: bad });
      const p = await pair(b, 'alice');
      expect(b.getPeerById(p.peerId)!.expiresAt).toBe(T0 + LIMITS.ttlMs);
      clock = T0 + LIMITS.ttlMs;
      expect(b.getGrant(p.peerId)).toBeNull();
    }
  });

  it('reads an unset or nonsensical serving budget as zero, never as unlimited', async () => {
    for (const bad of [undefined, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      clock = T0;
      const b = book(new FakeStore(), { ...LIMITS, servingBudgetUsdPerDay: bad });
      const p = await pair(b, 'alice', { budgetUsd: 5 });
      expect(b.budgetRemaining(p.peerId)).toBe(0);
      expect(await b.trySpend(p.peerId, 0.01)).toBe(false);
    }
  });

  it('denies everything when the injected clock stops being a number', async () => {
    // A clock that returns NaN would make every deadline comparison false,
    // i.e. every peer immortal and every bucket bottomless.
    const b = book(new FakeStore(), { ...LIMITS, servingBudgetUsdPerDay: 10 });
    const p = await pair(b, 'alice', { budgetUsd: 5 });
    expect(b.getGrant(p.peerId)).not.toBeNull();

    clock = Number.NaN;
    expect(b.getGrant(p.peerId)).toBeNull();
    expect(b.checkRate(p.peerId, T0).allowed).toBe(false);
    expect(b.budgetRemaining(p.peerId)).toBe(0);
    expect(await b.trySpend(p.peerId, 0.01)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — a store that cannot write says so', () => {
  it('rejects a revocation it could not durably record', async () => {
    const store = new FakeStore();
    const b = book(store);
    const p = await pair(b, 'alice');

    store.failWrites = true;
    // A resolved `revoke()` that persisted nothing tells a human the stolen
    // key is dead when it is not — the worst lie in the module.
    await expect(b.revoke(p.peerId, 'key compromised')).rejects.toThrow(/storage full/);
    // The in-memory tombstone is deliberately KEPT: it is the stricter state.
    expect(b.isRevoked(p.peerId)).toBe(true);
    expect(b.getGrant(p.peerId)).toBeNull();

    // And this is the loss the caller was told about, spelled out.
    store.failWrites = false;
    expect(book(store).isRevoked(p.peerId)).toBe(false);
  });

  it('rejects and un-pins a pairing it could not persist', async () => {
    const store = new FakeStore();
    const b = book(store);
    store.failWrites = true;
    const p = makePeer('alice');
    await expect(b.addPeer(p, makeGrant(p.peerId))).rejects.toThrow(/storage full/);
    // A peer authorized in memory but absent from disk is a grant nobody can
    // revoke durably and nobody sees after a reload.
    expect(b.getGrant(p.peerId)).toBeNull();
    expect(b.listPeers()).toEqual([]);

    store.failWrites = false;
    await b.addPeer(p, makeGrant(p.peerId));
    expect(b.getGrant(p.peerId)).not.toBeNull();
  });

  it('rolls back a TTL renewal it could not persist', async () => {
    const store = new FakeStore();
    const b = book(store);
    const p = await pair(b, 'alice');
    store.failWrites = true;
    clock = T0 + 400;
    await expect(b.touchOutbound(p.peerId)).rejects.toThrow(/storage full/);
    expect(b.getPeerById(p.peerId)!.expiresAt).toBe(T0 + LIMITS.ttlMs);
  });

  it('rejects a spend it could not record, and keeps the debit in memory', async () => {
    const store = new FakeStore();
    const b = book(store);
    const p = await pair(b, 'alice', { budgetUsd: 5 });
    store.failWrites = true;
    await expect(b.spend(p.peerId, 2)).rejects.toThrow(/storage full/);
    // Rolling a spend back would refund the wallet — the denial-of-wallet
    // attack from the other direction.
    expect(b.spentToday(p.peerId)).toBe(2);
  });

  it('keeps the write queue usable after a failed write', async () => {
    const store = new FakeStore();
    const b = book(store);
    const p = await pair(b, 'alice', { budgetUsd: 5 });
    store.failWrites = true;
    await expect(b.spend(p.peerId, 1)).rejects.toThrow();
    store.failWrites = false;
    await b.spend(p.peerId, 2);
    // One storage hiccup must not poison every later write.
    expect(book(store).spentToday(p.peerId)).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — two books over one store', () => {
  it('does not let a stale instance overwrite the other instance revocation', async () => {
    const store = new FakeStore();
    const a = book(store);
    const alice = await pair(a, 'alice');

    const b = book(store); // a second window, the same globalState
    await b.revoke(alice.peerId, 'key compromised');

    // A's snapshot is built from A's stale maps, which never saw the tombstone.
    await a.spend(alice.peerId, 1);

    const c = book(store);
    expect(c.isRevoked(alice.peerId)).toBe(true);
    expect(c.getGrant(alice.peerId)).toBeNull();
  });

  it('adopts a peer the other instance pinned instead of deleting it', async () => {
    const store = new FakeStore();
    const a = book(store);
    const alice = await pair(a, 'alice');
    const b = book(store);
    await pair(b, 'bob');

    await a.spend(alice.peerId, 1);

    expect(book(store).listPeers().map(p => p.alias).sort()).toEqual(['alice', 'bob']);
  });

  it('keeps the larger of two ledgers rather than the last writer', async () => {
    const store = new FakeStore();
    const a = book(store);
    const p = await pair(a, 'alice', { budgetUsd: 10 });
    const b = book(store);
    await b.spend(p.peerId, 4);
    await a.spend(p.peerId, 1); // A knew nothing about B's 4

    expect(book(store).spentToday(p.peerId)).toBe(4);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — revocation releases the name, never the identity', () => {
  it('refuses a peerId no key could derive to, rather than tombstoning it', async () => {
    const b = book(new FakeStore());
    // `revoke` accepts an unknown peerId by design, so the id can come off the
    // wire; `listRevoked()` then hands it to the roster UI verbatim.
    const hostile = `p_\u202Eevil\ndrop-${'A'.repeat(5_000)}`;
    await expect(b.revoke(hostile, 'unknown caller')).rejects.toThrow(/derived peerId/);
    expect(b.listRevoked()).toEqual([]);
    expect(b.isRevoked(hostile)).toBe(false);
  });

  it('frees the alias immediately, so a human can re-pair after a theft', async () => {
    const b = book(new FakeStore());
    const stolen = await pair(b, 'alice');
    await b.revoke(stolen.peerId, 'laptop stolen');
    expect(b.listPeers()).toEqual([]);

    // Refusing the alias here would contradict a roster that shows nothing.
    const fresh = makePeer('alice');
    await b.addPeer(fresh, makeGrant(fresh.peerId));
    expect(b.getPeerByAlias('alice')!.peerId).toBe(fresh.peerId);
    // The tombstone still blocks the peerId itself.
    expect(b.isRevoked(stolen.peerId)).toBe(true);
    await expect(b.addPeer(stolen, makeGrant(stolen.peerId))).rejects.toThrow(/revoked/);
  });

  it('does not re-admit a revoked record from the store on the next load', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');
    await b1.revoke(p.peerId, 'gone');
    // The write that carried the tombstone still carried the record.
    let raw = store.data.get(STORE_KEY) as { peers: Record<string, unknown> };
    expect(Object.keys(raw.peers)).toContain(p.peerId);

    const b2 = book(store);
    await pair(b2, 'bob'); // any write re-snapshots exactly what b2 admitted
    raw = store.data.get(STORE_KEY) as { peers: Record<string, unknown> };
    expect(Object.keys(raw.peers)).not.toContain(p.peerId);
    expect(b2.isRevoked(p.peerId)).toBe(true);
  });

  it('stops rendering a revoked peer anywhere', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    const rotated = makePeer('x');
    await b.addRotatedPeer(alice.peerId, rotated, makeGrant(rotated.peerId));
    expect(b.renderAlias(rotated.peerId)).toBe('alice (2)');

    await b.revoke(rotated.peerId, 'stolen');
    expect(b.renderAlias(rotated.peerId)).toBeNull();
    expect(b.rotatedFrom(rotated.peerId)).toBeNull();
  });

  it('refuses to rotate OFF a revoked identity', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    await b.revoke(alice.peerId, 'stolen');
    const rotated = makePeer('x');
    // A roster row reading as continuity with a key the human declared
    // compromised is the A7 display that must not exist.
    await expect(b.addRotatedPeer(alice.peerId, rotated, makeGrant(rotated.peerId)))
      .rejects.toThrow(/revoked/);
    expect(b.getPeerById(rotated.peerId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — identity is the key, spelled one way', () => {
  it('refuses a public key carrying characters base64 decoding would ignore', async () => {
    const b = book(new FakeStore());
    const key = newKey();
    const smuggled = `${key.slice(0, 8)}\u202E${key.slice(8)}`;
    // `Buffer.from` ignores non-base64 characters, so this string derives the
    // SAME peerId — and it is what the pairing card would render.
    expect(peerIdFor(smuggled)).toBe(peerIdFor(key));
    const p: DeskPeer = { ...makePeer('alice', key), publicKey: smuggled };
    await expect(b.addPeer(p, makeGrant(p.peerId))).rejects.toThrow(/peer failed/);
  });

  it('refuses a non-canonical spelling of a key', async () => {
    const b = book(new FakeStore());
    const key = newKey();
    const unpadded = key.replace(/=+$/, '');
    expect(unpadded).not.toBe(key);
    expect(peerIdFor(unpadded)).toBe(peerIdFor(key));
    const p: DeskPeer = { ...makePeer('alice', key), publicKey: unpadded };
    // Many spellings of one key means `addRotatedPeer`'s "different key" guard
    // compares spellings, not keys.
    await expect(b.addPeer(p, makeGrant(p.peerId))).rejects.toThrow(/peer failed/);
  });

  it('drops a record filed under another peer map key', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const alice = await pair(b1, 'alice');
    const bob = await pair(b1, 'bob');

    const raw = store.data.get(STORE_KEY) as {
      peers: Record<string, { peer: DeskPeer; grant: PeerGrant }>;
    };
    // Alice's pinned key filed under bob's id, with the grant re-pointed so
    // the grant/peerId binding alone would not notice.
    raw.peers[bob.peerId] = JSON.parse(JSON.stringify(raw.peers[alice.peerId]));
    raw.peers[bob.peerId].grant.peerId = bob.peerId;
    delete raw.peers[alice.peerId];
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    expect(b2.getGrant(bob.peerId)).toBeNull();
    expect(b2.listPeers()).toEqual([]);
  });

  it('drops a record whose rendered alias was decoupled from its routing alias', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const alice = await pair(b1, 'alice');
    const bob = await pair(b1, 'bob');

    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { aliasBase: string }> };
    raw.peers[bob.peerId].aliasBase = 'alice'; // renders as alice, routes as bob
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    // An operator approving a card for "alice" would be approving a request
    // from "bob".
    expect(b2.renderAlias(bob.peerId)).toBeNull();
    expect(b2.getPeerById(bob.peerId)).toBeNull();
    expect(b2.getPeerByAlias('alice')!.peerId).toBe(alice.peerId);
  });

  it('round-trips an alias that itself ends in a dash and a number', async () => {
    // The reconciliation above must not misread a legitimately-pinned name.
    const store = new FakeStore();
    const p = await pair(book(store), 'bot-2');
    const b2 = book(store);
    expect(b2.getPeerByAlias('bot-2')!.peerId).toBe(p.peerId);
    expect(b2.renderAlias(p.peerId)).toBe('bot-2');
  });

  it('refuses a rotation whose computed alias collides with a directly-pinned one', async () => {
    const b = book(new FakeStore());
    const alice = await pair(b, 'alice');
    await pair(b, 'alice-2'); // a human pinned this name directly
    const rotated = makePeer('x');
    await expect(b.addRotatedPeer(alice.peerId, rotated, makeGrant(rotated.peerId)))
      .rejects.toThrow(/already in use/);
    expect(b.getPeerById(rotated.peerId)).toBeNull();
    expect(b.listPeers()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — a tampered store buys nothing', () => {
  it('never authorizes a record whose pairing was forward-dated to buy unlimited lifetime', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');

    // The absolute ceiling is measured FROM `pairedAt`, so sliding it forward
    // slides the ceiling with it — the re-clamp then clamps nothing.
    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { peer: DeskPeer }> };
    raw.peers[p.peerId].peer.pairedAt = T0 + 1e12;
    raw.peers[p.peerId].peer.expiresAt = T0 + 1e12 + LIMITS.ttlMs;
    store.data.set(STORE_KEY, raw);

    // This asserts DENIAL, not deletion. An earlier version dropped the record
    // at parse time, which also destroyed every honest roster on a backwards
    // clock step — see 'a backwards clock step is survivable'. The security
    // property is that the tampered record can never authorize, at any clock.
    const b2 = book(store);
    expect(b2.getGrant(p.peerId)).toBeNull();
    clock = T0 + LIMITS.absoluteMaxLifetimeMs * 1_000;
    expect(b2.getGrant(p.peerId)).toBeNull();
    clock = T0 + 1e12 + 1;
    expect(b2.getGrant(p.peerId), 'not even once its forged pairing date arrives').toBeNull();
  });

  it('drops a record whose pairing was back-dated below zero', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');
    const raw = store.data.get(STORE_KEY) as { peers: Record<string, { peer: DeskPeer }> };
    raw.peers[p.peerId].peer.pairedAt = -1;
    store.data.set(STORE_KEY, raw);
    expect(book(store).listPeers()).toEqual([]);
  });

  it('refuses a grant when the clock has run backwards past the pairing', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice');
    // Every bound in the file is measured against this clock; if it has moved
    // behind the pairing event, none of them mean anything.
    clock = T0 - 10 * 60 * 1_000;
    expect(b.getGrant(p.peerId)).toBeNull();
    clock = T0 + 1;
    expect(b.getGrant(p.peerId)).not.toBeNull();
  });

  it('reads a negative stored call count as zero rather than a refilled ceiling', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice', { maxCalls: 2 });
    await b1.spend(p.peerId, 0);
    await b1.spend(p.peerId, 0);
    expect(b1.getGrant(p.peerId)).toBeNull();

    const raw = store.data.get(STORE_KEY) as { ledger: Record<string, { callsLifetime: number }> };
    raw.ledger[p.peerId].callsLifetime = -1_000_000;
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    expect(b2.callsUsed(p.peerId)).toBe(0);
    // The lifetime ceiling still binds after exactly two more calls.
    await b2.spend(p.peerId, 0);
    expect(b2.getGrant(p.peerId)).not.toBeNull();
    await b2.spend(p.peerId, 0);
    expect(b2.getGrant(p.peerId)).toBeNull();
  });

  it('drops rows whose key is not a derived peerId', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const p = await pair(b1, 'alice');
    const raw = store.data.get(STORE_KEY) as {
      peers: Record<string, unknown>;
      revoked: Record<string, unknown>;
      ledger: Record<string, unknown>;
    };
    const hostile = `p_\u202Ewide-${'A'.repeat(200)}`;
    raw.revoked[hostile] = { peerId: hostile, reason: 'x', at: T0 };
    raw.ledger[hostile] = { day: '2026-01-15', usdToday: 1, callsLifetime: 1 };
    raw.peers[hostile] = raw.peers[p.peerId];
    store.data.set(STORE_KEY, raw);

    const b2 = book(store);
    expect(b2.listRevoked()).toEqual([]);
    expect(b2.listPeers().map(x => x.alias)).toEqual(['alice']);
    expect(b2.spentTodayAll()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('DeskPeerBook — the currency stop is atomic (I17, A3)', () => {
  it('refuses a grant with a negative budget, a negative ceiling, or an off-table class', async () => {
    const b = book(new FakeStore());
    const p = makePeer('alice');
    await expect(b.addPeer(p, makeGrant(p.peerId, { budgetUsd: -5 })))
      .rejects.toThrow(/grant failed/);
    await expect(b.addPeer(p, makeGrant(p.peerId, { maxCalls: -1 })))
      .rejects.toThrow(/grant failed/);
    // An arbitrary string would flow out of getGrant as the retention class,
    // into a downstream policy comparison and onto a card.
    await expect(b.addPeer(p, makeGrant(p.peerId, { minRetentionClass: 'anything' as never })))
      .rejects.toThrow(/grant failed/);
    expect(b.listPeers()).toEqual([]);
  });

  it('refuses to open a ledger row for a peer that was never pinned', async () => {
    const b = book(new FakeStore());
    const ghost = makePeer('ghost');
    // globalState is one JSON blob rewritten in full on every spend; rows
    // keyed by a caller-supplied string grow without bound.
    await expect(b.spend(ghost.peerId, 0)).rejects.toThrow(/unknown peer/);
    expect(b.callsUsed(ghost.peerId)).toBe(0);

    // A revoked peer is still chargeable: the call happened before the
    // tombstone landed, and forgetting it would refund the wallet.
    const p = await pair(b, 'alice');
    await b.revoke(p.peerId, 'x');
    await b.spend(p.peerId, 0.5);
    expect(b.spentToday(p.peerId)).toBe(0.5);
  });

  it('debits atomically, so a concurrent burst cannot spend the pool twice', async () => {
    const b = book(new FakeStore(), { ...LIMITS, servingBudgetUsdPerDay: 1 });
    const a = await pair(b, 'alice', { budgetUsd: 1 });
    const c = await pair(b, 'bob', { budgetUsd: 1 });
    // `budgetRemaining()` is a read: 20 callers each see the same headroom and
    // each spend it. `trySpend` closes the window by debiting before it yields.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => b.trySpend(i % 2 === 0 ? a.peerId : c.peerId, 0.5)),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(b.spentTodayAll()).toBe(1);
    expect(b.budgetRemaining(a.peerId)).toBe(0);
    expect(b.budgetRemaining(c.peerId)).toBe(0);
  });

  it('refuses a trySpend that does not fit, without debiting or counting it', async () => {
    const b = book(new FakeStore());
    const p = await pair(b, 'alice', { budgetUsd: 0.5 });
    expect(await b.trySpend(p.peerId, 0.6)).toBe(false);
    expect(b.spentToday(p.peerId)).toBe(0);
    expect(b.callsUsed(p.peerId)).toBe(0);

    expect(await b.trySpend(p.peerId, 0.5)).toBe(true);
    expect(await b.trySpend(p.peerId, 0.01)).toBe(false);
    expect(b.spentToday(p.peerId)).toBe(0.5);
    expect(b.callsUsed(p.peerId)).toBe(1);
  });

  it('refuses a trySpend for a revoked, expired or unknown peer', async () => {
    const b = book(new FakeStore(), { ...LIMITS, servingBudgetUsdPerDay: 10 });
    const revoked = await pair(b, 'alice', { budgetUsd: 5 });
    const expired = await pair(b, 'bob', { budgetUsd: 5 });
    await b.revoke(revoked.peerId, 'x');
    expect(await b.trySpend(revoked.peerId, 0.1)).toBe(false);
    expect(await b.trySpend('p_notapeer2345677', 0.1)).toBe(false);
    clock = T0 + LIMITS.ttlMs;
    expect(await b.trySpend(expired.peerId, 0.1)).toBe(false);
  });

  it('clamps the pairing expiry to the absolute maximum when the TTL is longer', async () => {
    const b = book(new FakeStore(), { ...LIMITS, ttlMs: 5_000 });
    const p = await pair(b, 'alice');
    expect(b.getPeerById(p.peerId)!.expiresAt).toBe(T0 + LIMITS.absoluteMaxLifetimeMs);
    clock = T0 + LIMITS.absoluteMaxLifetimeMs;
    expect(b.getGrant(p.peerId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A backwards clock step must deny authority WITHOUT destroying the roster.
//
// A previous hardening pass dropped future-`pairedAt` records at PARSE time.
// `_parse` feeds both `_load` and the pre-write merge in `_persist`, so a
// benign backwards step — suspend/resume, a VM snapshot restore, an NTP
// correction — made every record fail the check, and the next unrelated write
// then persisted a roster without them. Pairings that cost a two-sided human
// ceremony were gone permanently, and anyone able to nudge the host clock had
// a cheap way to force it.
//
// Denying AUTHORITY under a suspect clock is the security property. Deleting
// the DATA was never part of it.
// ---------------------------------------------------------------------------
describe('DeskPeerBook — a backwards clock step is survivable', () => {
  it('denies authority while the clock is wrong, and restores it when the clock returns', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const alice = await pair(b1, 'alice');
    expect(b1.getGrant(alice.peerId)).not.toBeNull();

    // The host clock steps 10 minutes backwards — far beyond the skew allowance.
    clock = T0 - 10 * 60_000;
    const b2 = book(store);

    // Authority is denied…
    expect(b2.getGrant(alice.peerId)).toBeNull();
    // …but the pairing still EXISTS.
    expect(b2.getPeerById(alice.peerId)).not.toBeNull();
    expect(b2.listPeers().map(p => p.alias)).toContain('alice');

    // The clock comes back. The peer is usable again with no human ceremony.
    clock = T0;
    expect(book(store).getGrant(alice.peerId)).not.toBeNull();
  });

  it('an unrelated write under a wrong clock does not erase the roster from the store', async () => {
    const store = new FakeStore();
    const b1 = book(store);
    const alice = await pair(b1, 'alice');
    const bob = await pair(b1, 'bob');

    clock = T0 - 10 * 60_000;
    const b2 = book(store);
    // Any write at all — this is the step that used to persist `peers: {}`.
    await b2.revoke(bob.peerId, 'housekeeping');

    clock = T0;
    const b3 = book(store);
    expect(b3.getPeerById(alice.peerId), 'alice must survive an unrelated write').not.toBeNull();
    expect(b3.getGrant(alice.peerId)).not.toBeNull();
    // The deliberate revocation still stands.
    expect(b3.isRevoked(bob.peerId)).toBe(true);
  });

  it('still refuses a record whose pairing is genuinely in the future', async () => {
    // The clock is fine; the STORE claims a pairing that has not happened yet,
    // which would otherwise buy an unbounded absolute lifetime.
    const store = new FakeStore();
    const b1 = book(store);
    const alice = await pair(b1, 'alice');

    const raw = store.get<Record<string, unknown>>(STORE_KEY) as {
      peers: Record<string, { peer: { pairedAt: number } }>;
    };
    raw.peers[alice.peerId].peer.pairedAt = T0 + 60 * 60_000;
    await store.update(STORE_KEY, raw);

    expect(book(store).getGrant(alice.peerId), 'a future pairing must not authorize').toBeNull();
  });
});
