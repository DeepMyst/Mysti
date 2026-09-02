/**
 * DeskPairing tests (Plan 21 Phase 3, invariants I12/I13).
 *
 * The invite is the one place in Desk where a human is asked to make a trust
 * decision from a link that arrived over an untrusted channel, so the tests
 * that matter are about what an attacker who CONTROLS that link can achieve:
 * substituting a key, reflecting ours back, minting a link that never expires,
 * spelling one invite two ways, replaying a link that was already used, or
 * spending the receiver's CPU and table space to knock out a pairing a human
 * is in the middle of.
 *
 * ── About mutation coverage ────────────────────────────────────────────────
 *
 * An earlier version of this header claimed every security branch had been
 * checked by deleting it and watching a named test go red. That claim was
 * false for nine branches, which is worse than making no claim at all: it
 * tells the next reviewer not to re-check. The claim is now narrower and it is
 * true — each `MUTATION:` note below names the edit that was actually applied
 * to `src/managers/DeskPairing.ts` and the test that actually went red.
 *
 * Guards with no `MUTATION:` note are not claimed to be independently
 * observable. Three were deleted during this pass rather than left unprovable
 * (a key length cap and a base64 charset pre-check, both unfirable behind the
 * canonical round trip; and `consume`'s id-shape validation, unfirable behind
 * Map lookup semantics).
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  DeskPairing,
  PAIR_INVITE_MAX_TRACKED,
  PAIR_INVITE_TTL_MS,
  PAIR_REVIEW_MAX_PER_WINDOW,
  PAIR_REVIEW_WINDOW_MS,
  buildInviteUrl,
  parseInviteUrl,
} from '../../src/managers/DeskPairing';
import type { PairInvite, PairReviewOk, PairingDeps } from '../../src/managers/DeskPairing';
import { CLOCK_SKEW_MS, generateKeyPair, peerIdFor } from '../../src/services/desk/DeskEnvelope';
// Imported from DeskIdentity on purpose: asserting review() returns exactly
// this proves the ceremony has ONE definition of the number, not two.
import { safetyNumber } from '../../src/services/desk/DeskIdentity';

const NOW = 1_800_000_000_000;

const alice = generateKeyPair();
const bob = generateKeyPair();
const carol = generateKeyPair();

/** A base64 SPKI key that is genuinely not Ed25519 — proves the key-type check bites. */
const x25519Pub = crypto
  .generateKeyPairSync('x25519')
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64');

/** Deterministic, distinct ids of a realistic length (26 chars, ULID-shaped). */
function makeDeps(startAt = NOW): PairingDeps & { at: number; n: number } {
  const deps = {
    at: startAt,
    n: 0,
    now(): number { return deps.at; },
    newId(): string { deps.n += 1; return `id${String(deps.n).padStart(24, '0')}`; },
  };
  return deps;
}

function validInvite(over: Partial<PairInvite> = {}): PairInvite {
  return {
    inviteId: 'id000000000000000000000001',
    publicKey: alice.publicKey,
    nonce: 'nonce00000000000000000001',
    issuedAt: NOW,
    expiresAt: NOW + PAIR_INVITE_TTL_MS,
    ...over,
  };
}

/** Rebuild an invite URL with one raw query parameter overridden or injected. */
function urlWith(mutate: (p: URLSearchParams) => void): string {
  const p = new URLSearchParams(new URL(buildInviteUrl(validInvite())).search);
  mutate(p);
  return `desk://pair?${p.toString()}`;
}

/** An invite from bob, ready to be reviewed on alice's machine. */
function fromBob(over: Partial<PairInvite> = {}): PairInvite {
  return validInvite({ publicKey: bob.publicKey, ...over });
}

function ok(result: { ok: boolean }): PairReviewOk {
  expect(result.ok).toBe(true);
  return result as PairReviewOk;
}

/** Hold an invite and return the window the receiver decided to enforce. */
function pairingHoldExpiry(pairing: DeskPairing, invite: PairInvite): number {
  return ok(pairing.hold(buildInviteUrl(invite), alice.publicKey)).expiresAt;
}

/**
 * A DeskPairing whose parser is replaced, so `review()`'s own expiry clamp can
 * be exercised against invites `parseInviteUrl` would have refused outright.
 * Without this seam the clamp is only ever reached behind a check that already
 * refuses the same input — i.e. it could be deleted with no test noticing.
 */
class SeamPairing extends DeskPairing {
  private readonly _forced: PairInvite | null;
  constructor(deps: PairingDeps, forced: PairInvite | null) {
    super(deps);
    this._forced = forced;
  }
  protected _parseInvite(): PairInvite | null { return this._forced; }
}

describe('invite URL round trip', () => {
  it('parses back exactly what was built, with no extra fields', () => {
    const invite = validInvite();
    const back = parseInviteUrl(buildInviteUrl(invite));
    expect(back).toEqual(invite);
    expect(Object.keys(back as object).sort())
      .toEqual(['expiresAt', 'inviteId', 'issuedAt', 'nonce', 'publicKey']);
  });

  it('survives a base64 key containing "+" (a raw + would decode back as a space)', () => {
    // Not hypothetical: a hand-built query string turns one `+` into one space
    // and corrupts a single byte of the key, which then fails to verify a
    // signature much later, far from the cause.
    let key = '';
    for (let i = 0; i < 500 && !key.includes('+'); i++) {
      key = generateKeyPair().publicKey;
    }
    expect(key).toMatch(/\+/);
    const url = buildInviteUrl(validInvite({ publicKey: key }));
    expect(url).not.toContain('+');
    expect(parseInviteUrl(url)?.publicKey).toBe(key);
  });

  it('refuses to build an invite whose window is wider than the TTL', () => {
    expect(() => buildInviteUrl(validInvite({ expiresAt: NOW + PAIR_INVITE_TTL_MS + 1 })))
      .toThrow(/malformed/);
  });

  it('refuses to build from a short nonce, a bad key, or a non-integer clock', () => {
    expect(() => buildInviteUrl(validInvite({ nonce: 'short' }))).toThrow();
    expect(() => buildInviteUrl(validInvite({ publicKey: x25519Pub }))).toThrow();
    expect(() => buildInviteUrl(validInvite({ issuedAt: NOW + 0.5 }))).toThrow();
  });
});

describe('parseInviteUrl drops, never repairs', () => {
  const cases: [string, string][] = [
    ['wrong scheme', urlWith(() => {}).replace('desk://', 'https://')],
    ['uppercase host', urlWith(() => {}).replace('desk://pair', 'desk://PAIR')],
    ['a path segment', urlWith(() => {}).replace('desk://pair?', 'desk://pair/join?')],
    ['userinfo', urlWith(() => {}).replace('desk://pair?', 'desk://mallory@pair?')],
    // A port is refused by the same host comparison — `URL.host` carries it.
    ['a port', urlWith(() => {}).replace('desk://pair?', 'desk://pair:8080?')],
    ['a fragment', `${urlWith(() => {})}#anything`],
    ['an unknown parameter', urlWith(p => p.set('grant', 'all'))],
    ['a duplicate parameter', `${urlWith(() => {})}&k=${encodeURIComponent(bob.publicKey)}`],
    ['a missing parameter', urlWith(p => p.delete('n'))],
    ['an unexpected version', urlWith(p => p.set('v', '2'))],
    ['a leading-zero timestamp', urlWith(p => p.set('t', `0${NOW}`))],
    ['an exponent timestamp', urlWith(p => p.set('t', '1.8e12'))],
    ['a padded timestamp', urlWith(p => p.set('t', ` ${NOW}`))],
    ['a hex timestamp', urlWith(p => p.set('t', '0x1a2b3c4d5e6f'))],
    ['expiry at or before issue', urlWith(p => p.set('x', String(NOW)))],
    ['a window wider than the TTL', urlWith(p => p.set('x', String(NOW + PAIR_INVITE_TTL_MS + 1)))],
    ['a short nonce', urlWith(p => p.set('n', 'abc'))],
    ['an out-of-charset id', urlWith(p => p.set('id', 'has spaces here 0000000000'))],
    // base64url of the same key bytes: the url-safe alphabet plus stripped
    // padding, so this rejects deterministically even for a key whose standard
    // base64 happens to contain no "+" or "/".
    ['a url-safe-base64 key',
      urlWith(p => p.set('k', Buffer.from(alice.publicKey, 'base64').toString('base64url')))],
    ['a whitespace-padded key', urlWith(p => p.set('k', ` ${alice.publicKey}`))],
    // Padding stripped, standard alphabet: Node's base64 decoder accepts it and
    // yields the SAME key bytes, so only the canonical-spelling round-trip
    // refuses it. One key must have exactly one spelling — a peer store keyed
    // on the string would otherwise hold two records for one identity.
    ['an unpadded key', urlWith(p => p.set('k', alice.publicKey.replace(/=+$/, '')))],
    ['a non-Ed25519 key', urlWith(p => p.set('k', x25519Pub))],
    ['a truncated key', urlWith(p => p.set('k', alice.publicKey.slice(0, 40)))],
    // The 512-char cap that used to sit in decodeEd25519PublicKey is gone; this
    // pins that an oversized key is still refused by the checks that remain.
    ['an oversized key', urlWith(p => p.set('k', 'A'.repeat(600)))],
    ['a tab character', `${urlWith(() => {})}\u0009`],
    ['a NUL character', `${urlWith(() => {})}\u0000`],
    // Trojan-source: a bidi override makes a rendered id read as something
    // other than what it resolves to, and the roster renders these.
    ['a bidi override in the id', urlWith(p => p.set('id', 'id\u202Eaaaaaaaaaaaaaaaaaaaaaa'))],
    ['a zero-width character in the nonce', urlWith(p => p.set('n', 'nonce\u200B000000000000000000'))],
  ];

  for (const [label, url] of cases) {
    it(`returns null for ${label}`, () => {
      expect(parseInviteUrl(url)).toBeNull();
    });
  }

  it('returns null for a non-string, an empty string, and an oversized URL', () => {
    expect(parseInviteUrl(undefined as unknown as string)).toBeNull();
    expect(parseInviteUrl('')).toBeNull();
    expect(parseInviteUrl(`${urlWith(() => {})}${'&'.repeat(4000)}`)).toBeNull();
  });

  it('returns null for garbage that is not a URL at all', () => {
    expect(parseInviteUrl('desk://pair')).toBeNull();
    expect(parseInviteUrl('not a url')).toBeNull();
    expect(parseInviteUrl('desk:pair?v=1')).toBeNull();
  });

  // MUTATION: delete `if (buildInviteUrl(invite) !== url) { return null; }` in
  // parseInviteUrl → all four of these go red. Field-by-field canonicality let
  // one invite have many URL spellings, which is precisely what the ceremony
  // cannot afford: the human is asked to compare a string.
  describe('one invite has exactly one URL spelling', () => {
    const canonical = buildInviteUrl(validInvite());
    const spellings: [string, string][] = [
      ['a percent-encoded unreserved character', canonical.replace('id=id', 'id=%69d')],
      ['a trailing separator', `${canonical}&`],
      // `URL.hash` is '' for a bare '#', so the fragment check cannot see this.
      ['an empty fragment', `${canonical}#`],
      ['reordered parameters', (() => {
        const i = validInvite();
        return `desk://pair?id=${i.inviteId}&v=1&k=${encodeURIComponent(i.publicKey)}`
          + `&n=${i.nonce}&t=${i.issuedAt}&x=${i.expiresAt}`;
      })()],
    ];
    for (const [label, url] of spellings) {
      it(`returns null for ${label}, which decodes to the same invite`, () => {
        expect(url).not.toBe(canonical);
        expect(parseInviteUrl(url)).toBeNull();
      });
    }
  });
});

describe('the safety number this ceremony shows', () => {
  it('is the shared DeskIdentity rendering, symmetric across the two sides', () => {
    // If it were H(mine || theirs) the two humans would read different digits
    // and the comparison ceremony would confirm nothing.
    expect(safetyNumber(alice.publicKey, bob.publicKey))
      .toBe(safetyNumber(bob.publicKey, alice.publicKey));
    expect(safetyNumber(alice.publicKey, bob.publicKey)).toMatch(/^(\d{5} ){11}\d{5}$/);
  });

  it('is what BOTH sides see: each machine reviews the other and reads the same digits', () => {
    const bobsLink = buildInviteUrl(new DeskPairing(makeDeps()).createInvite(bob.publicKey));
    const alicesLink = buildInviteUrl(new DeskPairing(makeDeps()).createInvite(alice.publicKey));
    const onAlicesMachine = new DeskPairing(makeDeps()).review(bobsLink, alice.publicKey);
    const onBobsMachine = new DeskPairing(makeDeps()).review(alicesLink, bob.publicKey);
    expect(ok(onAlicesMachine).safetyNumber).toBe(ok(onBobsMachine).safetyNumber);
  });

  it('differs when either key differs', () => {
    const base = safetyNumber(alice.publicKey, bob.publicKey);
    expect(safetyNumber(alice.publicKey, carol.publicKey)).not.toBe(base);
    expect(safetyNumber(carol.publicKey, bob.publicKey)).not.toBe(base);
  });
});

describe('createInvite', () => {
  it('mints a parseable, TTL-bounded invite for our own key', () => {
    const invite = new DeskPairing(makeDeps()).createInvite(alice.publicKey);
    expect(invite.publicKey).toBe(alice.publicKey);
    expect(invite.expiresAt - invite.issuedAt).toBe(PAIR_INVITE_TTL_MS);
    expect(parseInviteUrl(buildInviteUrl(invite))).toEqual(invite);
  });

  it('carries no secret: the URL contains the public key and nothing else of ours', () => {
    const invite = new DeskPairing(makeDeps()).createInvite(alice.publicKey);
    const url = buildInviteUrl(invite);
    // The private key is the only secret in the neighbourhood; assert no
    // prefix of it, at any length, leaked into the link.
    for (let n = 16; n <= alice.privateKey.length; n += 16) {
      expect(url).not.toContain(alice.privateKey.slice(0, n));
    }
    expect(url).toContain(encodeURIComponent(alice.publicKey));
  });

  it('refuses a key that is not an Ed25519 public key', () => {
    expect(() => new DeskPairing(makeDeps()).createInvite(x25519Pub)).toThrow();
    expect(() => new DeskPairing(makeDeps()).createInvite('')).toThrow();
  });

  it('refuses an id source that returns one constant value', () => {
    // A constant newId would put every invite in one single-use slot: the
    // first consume anywhere would kill every future pairing.
    const deps: PairingDeps = { now: () => NOW, newId: () => 'constant00000000000000000' };
    expect(() => new DeskPairing(deps).createInvite(alice.publicKey)).toThrow(/distinct/);
  });

  // MUTATION: delete `if (this._invites.has(inviteId)) { throw ... }` in
  // createInvite → red. The inviteId !== nonce comparison sees only ONE call,
  // so a period-2 id source slipped past it, adopted the existing (already
  // consumed) slot via _admit, and handed back a fresh-looking invite that
  // could never be consumed — silently, with no error anywhere.
  it('refuses an id source that repeats a live id across calls', () => {
    const ids = ['aaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbb'];
    let n = 0;
    const deps: PairingDeps = { now: () => NOW, newId: () => ids[n++ % 2] };
    const pairing = new DeskPairing(deps);
    const first = pairing.createInvite(alice.publicKey);
    expect(pairing.consume(first.inviteId, alice.publicKey)).toBe(true);
    // Second call: newId yields 'aaa…' again for the id (and 'bbb…' for the
    // nonce), so the intra-call distinctness check is satisfied.
    expect(() => pairing.createInvite(alice.publicKey)).toThrow(/repeated a live inviteId/);
  });

  it('mints again once the colliding id has expired — a stale id is not a permanent block', () => {
    const ids = ['aaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbb'];
    let n = 0;
    const deps = { at: NOW, now: () => deps.at, newId: () => ids[n++ % 2] };
    const pairing = new DeskPairing(deps);
    pairing.createInvite(alice.publicKey);
    deps.at = NOW + PAIR_INVITE_TTL_MS;
    expect(pairing.createInvite(alice.publicKey).inviteId).toBe(ids[0]);
  });

  it('refuses an id source that produces a low-entropy id', () => {
    let n = 0;
    const deps: PairingDeps = { now: () => NOW, newId: () => `x${n++}` };
    expect(() => new DeskPairing(deps).createInvite(alice.publicKey)).toThrow(/unusable/);
  });

  // MUTATION: delete `if (!inviteWellFormed(invite)) { throw ... }` in
  // createInvite → red (createInvite returns an invite instead of throwing).
  // Without it, a mint whose arithmetic leaves the safe-integer range returns
  // a value whose failure surfaces one call later, inside buildInviteUrl.
  it('throws rather than returning an invite its own builder would refuse', () => {
    let n = 0;
    const deps: PairingDeps = {
      now: () => Number.MAX_SAFE_INTEGER,
      newId: () => `id${String(++n).padStart(24, '0')}`,
    };
    expect(() => new DeskPairing(deps).createInvite(alice.publicKey))
      .toThrow(/malformed invite/);
  });
});

describe('review', () => {
  it('reports the id, the nonce, the derived peerId, the window and the digits', () => {
    const invite = new DeskPairing(makeDeps()).createInvite(bob.publicKey);
    expect(new DeskPairing(makeDeps()).review(buildInviteUrl(invite), alice.publicKey)).toEqual({
      ok: true,
      inviteId: invite.inviteId,
      nonce: invite.nonce,
      peerId: peerIdFor(bob.publicKey),
      publicKey: bob.publicKey,
      safetyNumber: safetyNumber(alice.publicKey, bob.publicKey),
      expiresAt: invite.expiresAt,
    });
  });

  // MUTATION: change `review()` to call `this._review(url, ownPublicKey, true)`
  // → red on trackedCount. review() must not write: it is the method inbound
  // bytes reach, and the table it would write to is the table that remembers
  // human consent.
  it('records nothing at all — looking is not holding', () => {
    const pairing = new DeskPairing(makeDeps());
    const invite = fromBob();
    expect(pairing.review(buildInviteUrl(invite), alice.publicKey).ok).toBe(true);
    expect(pairing.trackedCount).toBe(0);
    expect(pairing.consume(invite.inviteId, bob.publicKey)).toBe(false);
  });

  it('refuses an invite carrying our own key (reflected invite)', () => {
    // Bounce our own link back at us and we would pair with ourselves, which
    // makes every later "is this peer me?" check meaningless.
    const own = buildInviteUrl(new DeskPairing(makeDeps()).createInvite(alice.publicKey));
    expect(new DeskPairing(makeDeps()).review(own, alice.publicKey))
      .toEqual({ ok: false, reason: 'self-invite' });
  });

  it('refuses a malformed URL without inspecting anything else', () => {
    expect(new DeskPairing(makeDeps()).review('desk://pair?v=9', alice.publicKey))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses when our own key argument is unusable', () => {
    const url = buildInviteUrl(fromBob());
    expect(new DeskPairing(makeDeps()).review(url, 'garbage'))
      .toEqual({ ok: false, reason: 'bad-local-key' });
  });

  it('expires against the receiver clock, at the boundary', () => {
    const url = buildInviteUrl(fromBob());
    expect(new DeskPairing(makeDeps(NOW + PAIR_INVITE_TTL_MS - 1)).review(url, alice.publicKey).ok)
      .toBe(true);
    expect(new DeskPairing(makeDeps(NOW + PAIR_INVITE_TTL_MS)).review(url, alice.publicKey))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an invite issued beyond tolerated skew in our future', () => {
    // Without this, "issued in the year 3000, expires ten minutes later" is a
    // link that is never expired by anyone's clock but the sender's.
    const far = NOW + 365 * 24 * 60 * 60 * 1000;
    const url = buildInviteUrl(fromBob({ issuedAt: far, expiresAt: far + PAIR_INVITE_TTL_MS }));
    expect(new DeskPairing(makeDeps()).review(url, alice.publicKey))
      .toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('tolerates a clock inside the skew window', () => {
    const near = NOW + CLOCK_SKEW_MS - 1000;
    const url = buildInviteUrl(fromBob({ issuedAt: near, expiresAt: near + PAIR_INVITE_TTL_MS }));
    expect(new DeskPairing(makeDeps()).review(url, alice.publicKey).ok).toBe(true);
  });

  it('does not consume the invite — showing is not deciding', () => {
    const pairing = new DeskPairing(makeDeps());
    const url = buildInviteUrl(fromBob());
    expect(pairing.hold(url, alice.publicKey).ok).toBe(true);
    expect(pairing.review(url, alice.publicKey).ok).toBe(true);
    expect(pairing.review(url, alice.publicKey).ok).toBe(true);
  });

  // MUTATION: delete the `if (tracked.consumed)` arm of the `if (!record)`
  // block in _review → red. This is the READ path's own copy; _admit owns the
  // write path's (see the 'hold' suite).
  it('refuses an invite id that was already consumed', () => {
    const pairing = new DeskPairing(makeDeps());
    const invite = fromBob();
    const url = buildInviteUrl(invite);
    expect(pairing.hold(url, alice.publicKey).ok).toBe(true);
    expect(pairing.consume(invite.inviteId, bob.publicKey)).toBe(true);
    expect(pairing.review(url, alice.publicKey)).toEqual({ ok: false, reason: 'already-used' });
  });

  // MUTATION: delete the `if (tracked.publicKey !== invite.publicKey)` arm of
  // the `if (!record)` block in _review → red. Two links sharing one id and
  // carrying different keys must never both be shown as reviewable: which key
  // the human approved would then be undecidable.
  it('refuses a second key offered under an id already held for another', () => {
    const pairing = new DeskPairing(makeDeps());
    const held = fromBob();
    expect(pairing.hold(buildInviteUrl(held), alice.publicKey).ok).toBe(true);
    const substituted = validInvite({ inviteId: held.inviteId, publicKey: carol.publicKey });
    expect(pairing.review(buildInviteUrl(substituted), alice.publicKey))
      .toEqual({ ok: false, reason: 'id-reused' });
  });

  // MUTATION: delete `expiresAt = Math.min(expiresAt, tracked.expiresAt);` in
  // _review → red. Without it review() reports (and blesses) a window that
  // consume() will not honour: the human sees an approved invite that cannot
  // be pinned, with nothing to distinguish it from a bug.
  it('reports the window consume will actually enforce, not the link own claim', () => {
    const deps = makeDeps();
    const pairing = new DeskPairing(deps);
    const short = fromBob({ expiresAt: NOW + 60_000 });
    expect(pairing.hold(buildInviteUrl(short), alice.publicKey).ok).toBe(true);
    // A second link: same id, same key, but claiming the full ten minutes.
    deps.at = NOW + 5_000;
    const long = fromBob({ issuedAt: NOW, expiresAt: NOW + PAIR_INVITE_TTL_MS });
    expect(ok(pairing.review(buildInviteUrl(long), alice.publicKey)).expiresAt)
      .toBe(NOW + 60_000);
    // And that reported window is the one that actually bites, on both sides
    // of its edge — review and consume cannot disagree about a live record.
    deps.at = NOW + 59_999;
    expect(pairing.review(buildInviteUrl(long), alice.publicKey).ok).toBe(true);
    expect(pairing.consume(short.inviteId, bob.publicKey)).toBe(true);
  });

  // MUTATION: change the stale check in _review to `const tracked = stale;` →
  // red. An expired record is about to be pruned and refuses nothing that
  // `consume` would not refuse anyway; letting it veto a live link would make
  // a reused id unpairable for no live reason — the shape of the earlier fix
  // in this plan that dropped whole rosters on a benign clock step.
  it('does not let an expired record veto a live link that reuses its id', () => {
    const deps = makeDeps();
    const pairing = new DeskPairing(deps);
    const short = fromBob({ expiresAt: NOW + 60_000 });
    expect(pairing.hold(buildInviteUrl(short), alice.publicKey).ok).toBe(true);
    deps.at = NOW + 60_000;
    // Nothing may call consume() first here: consume prunes, and a pruned
    // table cannot show whether the stale entry would have vetoed anything.
    const fresh = fromBob({ issuedAt: deps.at, expiresAt: deps.at + PAIR_INVITE_TTL_MS });
    expect(ok(pairing.review(buildInviteUrl(fresh), alice.publicKey)).expiresAt)
      .toBe(deps.at + PAIR_INVITE_TTL_MS);
    expect(pairing.hold(buildInviteUrl(fresh), alice.publicKey).ok).toBe(true);
    expect(pairing.consume(fresh.inviteId, bob.publicKey)).toBe(true);
  });
});

describe('the receiver computes the window, independently of the parser', () => {
  // MUTATION: replace the clamp in _review with
  // `let expiresAt = invite.expiresAt;` → the second expectation goes red.
  //
  // This is the point of the _parseInvite seam. parseInviteUrl already refuses
  // a window wider than the TTL, so with the real parser in place the clamp is
  // unreachable and deleting it changes nothing observable. The header claims
  // the clamp is a SECOND layer that does not depend on the first; a claim
  // like that is only worth making if it can be tested with the first layer
  // out of the way.
  const forged = fromBob({ expiresAt: NOW + 10 * PAIR_INVITE_TTL_MS });

  it('clamps a sender-chosen window to issuedAt + TTL even when the parser lets it through', () => {
    // The real parser would never produce `forged` — that is the premise.
    expect(parseInviteUrl(`desk://pair?v=1&id=${forged.inviteId}`)).toBeNull();
    const justInside = new SeamPairing(makeDeps(NOW + PAIR_INVITE_TTL_MS - 1), forged);
    expect(ok(justInside.review('desk://anything', alice.publicKey)).expiresAt)
      .toBe(NOW + PAIR_INVITE_TTL_MS);
    const justOutside = new SeamPairing(makeDeps(NOW + PAIR_INVITE_TTL_MS), forged);
    expect(justOutside.review('desk://anything', alice.publicKey))
      .toEqual({ ok: false, reason: 'expired' });
  });

  // MUTATION: delete `if (!theirDer) { return { ok: false, reason: 'malformed' }; }`
  // in _review → red (a TypeError escapes instead of a refusal). _parseInvite
  // is overridable, so _review may not assume what it is handed was validated.
  it('re-checks the offered key rather than trusting the parser', () => {
    const junk = new SeamPairing(makeDeps(), fromBob({ publicKey: x25519Pub }));
    expect(junk.review('desk://anything', alice.publicKey))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses when the parser yields nothing', () => {
    expect(new SeamPairing(makeDeps(), null).review('desk://anything', alice.publicKey))
      .toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('hold is the only way an outside invite enters the table', () => {
  it('records the id, the key and the nonce, so consume can bind them', () => {
    const pairing = new DeskPairing(makeDeps());
    const invite = fromBob();
    const held = ok(pairing.hold(buildInviteUrl(invite), alice.publicKey));
    expect(held.inviteId).toBe(invite.inviteId);
    expect(held.nonce).toBe(invite.nonce);
    expect(pairing.trackedCount).toBe(1);
    expect(pairing.consume(invite.inviteId, bob.publicKey)).toBe(true);
  });

  // MUTATION: delete `if (existing.consumed) { return 'already-used'; }` in
  // _admit → red. That line is the whole of single-use on the write path; the
  // read path's copy is deliberately not reached here (see the `!record` gate
  // in _review) so that this one can be proven to work.
  it('refuses to re-hold a consumed id, and does not reset it', () => {
    const pairing = new DeskPairing(makeDeps());
    const invite = fromBob();
    const url = buildInviteUrl(invite);
    expect(pairing.hold(url, alice.publicKey).ok).toBe(true);
    expect(pairing.consume(invite.inviteId, bob.publicKey)).toBe(true);
    expect(pairing.hold(url, alice.publicKey)).toEqual({ ok: false, reason: 'already-used' });
    expect(pairing.consume(invite.inviteId, bob.publicKey)).toBe(false);
  });

  // MUTATION: delete `if (existing.publicKey !== invite.publicKey) { return 'id-reused'; }`
  // in _admit → red. Without it a second key can be held under an id already
  // held for another, and the stored key silently wins a decision the human
  // never made.
  it('refuses to hold a different key under an id already held', () => {
    const pairing = new DeskPairing(makeDeps());
    const held = fromBob();
    expect(pairing.hold(buildInviteUrl(held), alice.publicKey).ok).toBe(true);
    const substituted = validInvite({ inviteId: held.inviteId, publicKey: carol.publicKey });
    expect(pairing.hold(buildInviteUrl(substituted), alice.publicKey))
      .toEqual({ ok: false, reason: 'id-reused' });
    expect(pairing.consume(held.inviteId, carol.publicKey)).toBe(false);
    expect(pairing.consume(held.inviteId, bob.publicKey)).toBe(true);
  });

  // A re-held id keeps the SHORTEST window ever recorded for it. Both halves
  // are needed to pin one line, and each catches a different edit:
  //
  //   MUTATION: `existing.expiresAt = expiresAt;` (drop the Math.min) → the
  //   first half goes red — a re-held id extends itself, which is a link that
  //   outlives the window the receiver computed for it.
  //
  //   MUTATION: delete the assignment entirely → the second half goes red.
  //   (Deleting it does NOT fail the first half: never assigning also never
  //   extends. That is why the earlier single-direction test was inadequate.)
  it('keeps the shortest window a re-held id was ever seen with', () => {
    const shortFirst = makeDeps();
    const a = new DeskPairing(shortFirst);
    const short = fromBob({ expiresAt: NOW + 60_000 });
    expect(pairingHoldExpiry(a, short)).toBe(NOW + 60_000);
    shortFirst.at = NOW + 30_000;
    const long = fromBob({ expiresAt: NOW + PAIR_INVITE_TTL_MS });
    expect(pairingHoldExpiry(a, long)).toBe(NOW + 60_000);
    shortFirst.at = NOW + 61_000;
    expect(a.consume(short.inviteId, bob.publicKey)).toBe(false);

    const longFirst = makeDeps();
    const b = new DeskPairing(longFirst);
    expect(pairingHoldExpiry(b, long)).toBe(NOW + PAIR_INVITE_TTL_MS);
    longFirst.at = NOW + 30_000;
    expect(pairingHoldExpiry(b, short)).toBe(NOW + 60_000);
    longFirst.at = NOW + 61_000;
    expect(b.consume(short.inviteId, bob.publicKey)).toBe(false);
  });
});

describe('consume is exactly once, for the key that was held', () => {
  it('is true once and false forever after for a minted invite', () => {
    const pairing = new DeskPairing(makeDeps());
    const invite = pairing.createInvite(alice.publicKey);
    expect(pairing.consume(invite.inviteId, alice.publicKey)).toBe(true);
    expect(pairing.consume(invite.inviteId, alice.publicKey)).toBe(false);
    expect(pairing.consume(invite.inviteId, alice.publicKey)).toBe(false);
  });

  // MUTATION: delete `if (typeof publicKey !== 'string' || tracked.publicKey !== publicKey)`
  // in consume → red. Without it, consume says only "this id was looked at",
  // which is not the property the ceremony needs: an id can be offered with
  // two different keys, and only one of them is the one a human approved.
  it('refuses a key other than the one held under the id, without spending it', () => {
    const pairing = new DeskPairing(makeDeps());
    const invite = fromBob();
    expect(pairing.hold(buildInviteUrl(invite), alice.publicKey).ok).toBe(true);
    expect(pairing.consume(invite.inviteId, carol.publicKey)).toBe(false);
    expect(pairing.consume(invite.inviteId, undefined as unknown as string)).toBe(false);
    // A refused key must not burn the invite: the human's real approval is
    // still pending, and this is exactly where a wrong answer becomes a DoS.
    expect(pairing.consume(invite.inviteId, bob.publicKey)).toBe(true);
  });

  it('refuses an id this instance never minted or held', () => {
    // You cannot pin a key you never looked at: consume is that ordering rule.
    const pairing = new DeskPairing(makeDeps());
    expect(pairing.consume('id000000000000000000000999', bob.publicKey)).toBe(false);
    // Ids that could never have been recorded at all. This asserts the Map-miss
    // behaviour, not a validator — consume's id-shape check was removed during
    // hardening precisely because it could not be observed to fire.
    expect(pairing.consume('../../etc/passwd', bob.publicKey)).toBe(false);
    expect(pairing.consume(undefined as unknown as string, bob.publicKey)).toBe(false);
    expect(pairing.consume('__proto__', bob.publicKey)).toBe(false);
  });

  it('refuses after expiry even though the invite was held while live', () => {
    const deps = makeDeps();
    const pairing = new DeskPairing(deps);
    const invite = fromBob();
    expect(pairing.hold(buildInviteUrl(invite), alice.publicKey).ok).toBe(true);
    deps.at = NOW + PAIR_INVITE_TTL_MS;
    expect(pairing.consume(invite.inviteId, bob.publicKey)).toBe(false);
  });
});

describe('a flood of links cannot spend the receiver, or evict a pending consent', () => {
  // MUTATION: delete `if (!record && !this._chargeReview(now)) { ... }` in
  // _review → red. safetyNumber() is two 5200-round SHA-512 chains over keys
  // the sender chose; unbudgeted, a few hundred links is seconds of blocked
  // extension host, on input nobody asked for.
  it('budgets the expensive half of review, and recovers when the window turns', () => {
    const deps = makeDeps();
    const pairing = new DeskPairing(deps);
    const url = buildInviteUrl(fromBob());
    for (let i = 0; i < PAIR_REVIEW_MAX_PER_WINDOW; i++) {
      expect(pairing.review(url, alice.publicKey).ok).toBe(true);
    }
    expect(pairing.review(url, alice.publicKey)).toEqual({ ok: false, reason: 'rate-limited' });
    deps.at = NOW + PAIR_REVIEW_WINDOW_MS;
    expect(pairing.review(url, alice.publicKey).ok).toBe(true);
  }, 30_000);

  it('charges nothing for links it refuses cheaply', () => {
    const pairing = new DeskPairing(makeDeps());
    for (let i = 0; i < 60; i++) {
      expect(pairing.review(`desk://pair?v=1&junk=${i}`, alice.publicKey).ok).toBe(false);
      expect(pairing.review(buildInviteUrl(validInvite()), alice.publicKey))
        .toEqual({ ok: false, reason: 'self-invite' });
    }
    expect(pairing.review(buildInviteUrl(fromBob()), alice.publicKey).ok).toBe(true);
  }, 30_000);

  // MUTATION: charge hold() as well (drop the `!record &&` from the budget
  // condition) → red. An attacker must not be able to spend a budget the human
  // needs in order to FINISH a pairing they have already reviewed.
  it('never lets a flood block a hold the human has already decided on', () => {
    const pairing = new DeskPairing(makeDeps());
    const good = fromBob();
    for (let i = 0; i <= PAIR_REVIEW_MAX_PER_WINDOW; i++) {
      pairing.review(
        buildInviteUrl(fromBob({ inviteId: `flood${String(i).padStart(20, '0')}` })),
        alice.publicKey,
      );
    }
    expect(pairing.hold(buildInviteUrl(good), alice.publicKey).ok).toBe(true);
    expect(pairing.consume(good.inviteId, bob.publicKey)).toBe(true);
  }, 30_000);

  // MUTATION: make review() record (call _review with record=true) → red on
  // trackedCount. This is the attack the module was rebuilt around: 500+ links
  // whose issuedAt sits just inside the skew window have LATER expiries than
  // the human's pending invite, so an eviction rule that drops the
  // soonest-expiring unconsumed entry drops exactly the one a human is at that
  // moment comparing digits for. They approve; the pin fails, silently.
  it('keeps the pending invite through a flood of later-expiring links', () => {
    const pairing = new DeskPairing(makeDeps());
    const pending = fromBob();
    expect(pairing.hold(buildInviteUrl(pending), alice.publicKey).ok).toBe(true);
    const skewed = NOW + CLOCK_SKEW_MS - 1000;
    for (let i = 0; i < PAIR_INVITE_MAX_TRACKED + 8; i++) {
      pairing.review(buildInviteUrl(fromBob({
        inviteId: `flood${String(i).padStart(20, '0')}`,
        issuedAt: skewed,
        expiresAt: skewed + PAIR_INVITE_TTL_MS,
      })), alice.publicKey);
    }
    expect(pairing.trackedCount).toBe(1);
    expect(pairing.consume(pending.inviteId, bob.publicKey)).toBe(true);
  }, 60_000);
});

describe('a hostile clock', () => {
  const bad: [string, number][] = [
    ['NaN', NaN], ['Infinity', Infinity], ['zero', 0], ['negative', -1],
    // MUTATION: drop `!Number.isSafeInteger(t)` from _clock → this row goes
    // red. A fractional epoch used to mint an invite that this module's OWN
    // builder then rejected, so the complaint arrived one call away from the
    // cause and createInvite's contract was broken by a return value.
    ['fractional', NOW + 0.5],
    ['beyond the safe range', Number.MAX_SAFE_INTEGER + 4],
  ];
  for (const [label, value] of bad) {
    it(`refuses to mint, review, hold or consume when now() is ${label}`, () => {
      const deps = makeDeps();
      const pairing = new DeskPairing(deps);
      const invite = pairing.createInvite(alice.publicKey);
      const url = buildInviteUrl(fromBob());
      deps.at = value;
      // NaN is the dangerous one: every comparison against it is false, so an
      // unchecked NaN clock makes "expired" and "already used" both untrue.
      expect(pairing.review(url, alice.publicKey)).toEqual({ ok: false, reason: 'bad-clock' });
      expect(pairing.hold(url, alice.publicKey)).toEqual({ ok: false, reason: 'bad-clock' });
      expect(pairing.consume(invite.inviteId, alice.publicKey)).toBe(false);
      // MUTATION: delete createInvite's `if (now === null) { throw ... }` →
      // this goes red. Every case above minted BEFORE breaking the clock, so
      // the mint path's own guard was previously untested.
      expect(() => pairing.createInvite(alice.publicKey)).toThrow(/finite epoch/);
    });
  }

  it('refuses a clock that throws', () => {
    const pairing = new DeskPairing({
      now: () => { throw new Error('no clock'); },
      newId: () => 'x'.repeat(26),
    });
    expect(pairing.review(buildInviteUrl(fromBob()), alice.publicKey))
      .toEqual({ ok: false, reason: 'bad-clock' });
    expect(pairing.consume('id000000000000000000000001', bob.publicKey)).toBe(false);
    expect(() => pairing.createInvite(alice.publicKey)).toThrow(/finite epoch/);
  });

  it('refuses a non-numeric clock', () => {
    const deps = { now: () => '1800000000000' as unknown as number, newId: () => 'x'.repeat(26) };
    expect(new DeskPairing(deps).review(buildInviteUrl(fromBob()), alice.publicKey))
      .toEqual({ ok: false, reason: 'bad-clock' });
  });
});

describe('the invite table is bounded without forgetting anything live', () => {
  /** Fill the table with live consumed entries, returning their ids. */
  function fillWithConsumed(pairing: DeskPairing): string[] {
    const ids: string[] = [];
    for (let i = 0; i < PAIR_INVITE_MAX_TRACKED; i++) {
      const invite = pairing.createInvite(alice.publicKey);
      ids.push(invite.inviteId);
      expect(pairing.consume(invite.inviteId, alice.publicKey)).toBe(true);
    }
    expect(pairing.trackedCount).toBe(PAIR_INVITE_MAX_TRACKED);
    return ids;
  }

  // MUTATION: delete `if (this._invites.size >= PAIR_INVITE_MAX_TRACKED) { return 'busy'; }`
  // in _admit → both expectations go red (the table grows past its bound).
  it('refuses to hold rather than evicting a live consumed entry', () => {
    const pairing = new DeskPairing(makeDeps());
    const ids = fillWithConsumed(pairing);
    // A fresh id, not one of the minted ones: this asserts "no room", not
    // "already used".
    const fresh = buildInviteUrl(fromBob({ inviteId: 'freshaaaaaaaaaaaaaaaaaaaa1' }));
    expect(pairing.hold(fresh, alice.publicKey)).toEqual({ ok: false, reason: 'busy' });
    expect(pairing.consume(ids[0], alice.publicKey)).toBe(false);
  });

  // MUTATION: delete `if (this._admit(...) !== null) { throw ... }` in
  // createInvite (ignore the return value) → red. The mint side had no
  // equivalent of the 'busy' path that review was tested for, so an untracked
  // and permanently unconsumable invite could be handed back with no error.
  it('refuses to MINT into a full table rather than returning a dead invite', () => {
    const pairing = new DeskPairing(makeDeps());
    fillWithConsumed(pairing);
    expect(() => pairing.createInvite(alice.publicKey)).toThrow(/full/);
  });

  it('drops entries once they expire', () => {
    const deps = makeDeps();
    const pairing = new DeskPairing(deps);
    pairing.createInvite(alice.publicKey);
    expect(pairing.trackedCount).toBe(1);
    deps.at = NOW + PAIR_INVITE_TTL_MS;
    pairing.consume('id000000000000000000000999', alice.publicKey);
    expect(pairing.trackedCount).toBe(0);
  });

  // MUTATION: delete `this._prune(now);` from the top of _admit → red. hold()
  // is the one path where _admit's sweep is the ONLY sweep, so this is the
  // only place that can show the difference between "the table reclaims space"
  // and "consume happens to reclaim space on the way past".
  it('reclaims expired space on the hold path, where nothing else sweeps', () => {
    const deps = makeDeps();
    const pairing = new DeskPairing(deps);
    fillWithConsumed(pairing);
    deps.at = NOW + PAIR_INVITE_TTL_MS;
    const fresh = fromBob({ issuedAt: deps.at, expiresAt: deps.at + PAIR_INVITE_TTL_MS });
    expect(pairing.hold(buildInviteUrl(fresh), alice.publicKey).ok).toBe(true);
    expect(pairing.trackedCount).toBe(1);
    expect(pairing.consume(fresh.inviteId, bob.publicKey)).toBe(true);
  }, 30_000);
});

describe('construction', () => {
  it('refuses a half-wired deps object instead of defaulting to a real clock', () => {
    expect(() => new DeskPairing({} as PairingDeps)).toThrow();
    expect(() => new DeskPairing({ now: () => NOW } as PairingDeps)).toThrow();
    expect(() => new DeskPairing(null as unknown as PairingDeps)).toThrow();
  });
});
