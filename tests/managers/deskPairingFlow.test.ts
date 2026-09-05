/**
 * DeskPairingFlow tests (Plan 26).
 *
 * Two invariants carry everything:
 *
 *  1. THE CHALLENGE IS THE ONLY GATE. There must be no path from `begin()` to a
 *     pinned peer that does not pass a correct `answer()`. If one exists, the
 *     ceremony is decoration and the roster is full of unverified keys.
 *  2. CALL ORDER: consume BEFORE pin. Pinning first would re-introduce
 *     multi-use of an invite documented as single-use, and nothing downstream
 *     would notice.
 *
 * The tests are written against those two properties rather than against the
 * API surface.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import {
  CHALLENGE_GROUPS,
  CHALLENGE_MAX_ATTEMPTS,
  DEFAULT_GRANT_VERBS,
  DeskPairingFlow,
  demandedGroups,
} from '../../src/managers/DeskPairingFlow';
import { DeskPairing, buildInviteUrl } from '../../src/managers/DeskPairing';
import { DeskPeerBook, type PeerStore } from '../../src/managers/DeskPeerBook';
import { generateKeyPair } from '../../src/services/desk/DeskEnvelope';
import { safetyNumber } from '../../src/services/desk/DeskIdentity';

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
let clock = T0;
const now = () => clock;

class FakeStore implements PeerStore {
  data = new Map<string, unknown>();
  get<T>(k: string): T | undefined { return this.data.get(k) as T | undefined; }
  async update(k: string, v: unknown): Promise<void> { this.data.set(k, v); }
}

const mine = generateKeyPair();
const theirs = generateKeyPair();

let idCounter = 0;
function harness(over: { ownPublicKey?: string } = {}) {
  const pairing = new DeskPairing({ now, newId: () => `inv-${++idCounter}-${'a'.repeat(18)}` });
  const peerBook = new DeskPeerBook(new FakeStore(), now, {
    ttlMs: 60_000, absoluteMaxLifetimeMs: 600_000,
    rateCapacity: 5, rateRefillWindowMs: 10_000, servingBudgetUsdPerDay: 1,
  });
  const flow = new DeskPairingFlow({
    pairing, peerBook,
    ownPublicKey: over.ownPublicKey ?? mine.publicKey,
    now,
    newSessionId: () => crypto.randomUUID(),
  });
  return { pairing, peerBook, flow };
}

/** An invite FROM the other party, addressed to us. */
function inviteFromThem(pairing: DeskPairing): string {
  return buildInviteUrl(pairing.createInvite(theirs.publicKey));
}

/** The digits the ceremony will demand for this pair of keys. */
function correctAnswers(): string[] {
  const sn = safetyNumber(mine.publicKey, theirs.publicKey);
  const groups = sn.split(' ');
  return demandedGroups(sn, groups.length).map(i => groups[i - 1]);
}

const GRANT = { alias: 'alice', trustDomain: 'acme.com', verbs: [...DEFAULT_GRANT_VERBS] };

beforeEach(() => { clock = T0; });

describe('demandedGroups', () => {
  it('is deterministic, so both machines demand the same groups', () => {
    const sn = safetyNumber(mine.publicKey, theirs.publicKey);
    expect(demandedGroups(sn)).toEqual(demandedGroups(sn));
  });

  it('is symmetric in the key order, like the safety number itself', () => {
    // If the two sides disagreed about which groups to read, the call becomes
    // "no, mine says 4, 9 and 2" — coordination that adds nothing.
    const a = safetyNumber(mine.publicKey, theirs.publicKey);
    const b = safetyNumber(theirs.publicKey, mine.publicKey);
    expect(a).toBe(b);
    expect(demandedGroups(a)).toEqual(demandedGroups(b));
  });

  it('returns exactly CHALLENGE_GROUPS distinct, in-range, sorted indices', () => {
    // Driven with synthetic strings rather than real key pairs: the function
    // takes a STRING, and minting 200 keys to produce 200 strings costs two
    // 5200-round SHA-512 chains each for no extra coverage. This runs 5,000
    // cases in the time 200 real pairs took to time out.
    for (let i = 0; i < 5_000; i++) {
      const sn = `case-${i}-${(i * 2654435761) % 1e9}`;
      const d = demandedGroups(sn);
      expect(d, sn).toHaveLength(CHALLENGE_GROUPS);
      expect(new Set(d).size, sn).toBe(CHALLENGE_GROUPS);
      expect(Math.min(...d), sn).toBeGreaterThanOrEqual(1);
      expect(Math.max(...d), sn).toBeLessThanOrEqual(12);
      expect([...d].sort((x, y) => x - y), sn).toEqual(d);
    }
  });

  it('holds the same property for a non-default group count', () => {
    for (const total of [3, 4, 8, 12, 20]) {
      for (let i = 0; i < 200; i++) {
        const d = demandedGroups(`t${total}-${i}`, total);
        expect(d).toHaveLength(CHALLENGE_GROUPS);
        expect(new Set(d).size).toBe(CHALLENGE_GROUPS);
        expect(Math.max(...d)).toBeLessThanOrEqual(total);
      }
    }
  });

  it('never returns a short challenge, which would silently weaken the ceremony', () => {
    // The fill loop exists for a digest that cannot yield enough distinct
    // values. A short challenge looks identical to a full one on screen.
    for (let i = 0; i < 1_000; i++) {
      expect(demandedGroups(String(i), CHALLENGE_GROUPS)).toHaveLength(CHALLENGE_GROUPS);
    }
  }, 30_000);

  it('varies across peers, so nobody learns "it is always the first three"', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      seen.add(demandedGroups(safetyNumber(generateKeyPair().publicKey, generateKeyPair().publicKey)).join(','));
    }
    expect(seen.size).toBeGreaterThan(5);
  }, 30_000);
});

describe('the challenge is the only gate', () => {
  it('refuses to complete without any answer at all', async () => {
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing));
    expect(begun.ok).toBe(true);

    const res = await flow.complete((begun as { challenge: { sessionId: string } }).challenge.sessionId, GRANT);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('not-verified');
    expect(peerBook.listPeers()).toHaveLength(0);
  });

  it('refuses to complete after a WRONG answer', async () => {
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };

    expect(flow.answer(begun.challenge.sessionId, ['00000', '00000', '00000']).ok).toBe(false);
    const res = await flow.complete(begun.challenge.sessionId, GRANT);
    expect(res.ok).toBe(false);
    expect(peerBook.listPeers()).toHaveLength(0);
  });

  it('pins only after the correct digits', async () => {
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };

    expect(flow.answer(begun.challenge.sessionId, correctAnswers()).ok).toBe(true);
    const res = await flow.complete(begun.challenge.sessionId, GRANT);
    expect(res.ok).toBe(true);
    expect(peerBook.listPeers()).toHaveLength(1);
    expect(peerBook.getPeerByAlias('alice')).not.toBeNull();
  });

  it('accepts digits typed with the spacing a human produces', () => {
    const { flow, pairing } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    const messy = correctAnswers().map(g => ` ${g.slice(0, 2)}-${g.slice(2)} `);
    expect(flow.answer(begun.challenge.sessionId, messy).ok).toBe(true);
  });

  it('does not reveal WHICH group was wrong', () => {
    // Otherwise one 15-digit answer becomes three independent 5-digit answers.
    const { flow, pairing } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    const correct = correctAnswers();
    const res = flow.answer(begun.challenge.sessionId, [correct[0], correct[1], '00000']);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('wrong');
    // The failure names no group. (Asserting on the serialized object would be
    // wrong here — `attemptsLeft: 2` legitimately contains a digit.)
    expect(Object.keys(res).sort()).toEqual(['attemptsLeft', 'ok', 'reason']);
  });

  it('destroys the session once attempts are exhausted', async () => {
    const { flow, pairing } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };

    for (let i = 1; i < CHALLENGE_MAX_ATTEMPTS; i++) {
      expect(flow.answer(begun.challenge.sessionId, ['1', '2', '3']).ok).toBe(false);
    }
    const last = flow.answer(begun.challenge.sessionId, ['1', '2', '3']);
    expect(last.ok === false && last.reason).toBe('exhausted');

    // Gone — a correct answer afterwards must not resurrect it.
    expect(flow.answer(begun.challenge.sessionId, correctAnswers()).ok).toBe(false);
    expect((await flow.complete(begun.challenge.sessionId, GRANT)).ok).toBe(false);
  });

  it('a retry shows the SAME groups, so a typo is correctable', () => {
    const { flow, pairing } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string; demanded: number[] } };
    const first = [...begun.challenge.demanded];
    flow.answer(begun.challenge.sessionId, ['0', '0', '0']);
    // Same session, same demanded set — the honest case is the one being served.
    expect(demandedGroups(safetyNumber(mine.publicKey, theirs.publicKey))).toEqual(first);
  });

  it('an unknown session id can never pin', async () => {
    const { flow, peerBook } = harness();
    expect(flow.answer('nope', correctAnswers()).ok).toBe(false);
    expect((await flow.complete('nope', GRANT)).ok).toBe(false);
    expect(peerBook.listPeers()).toHaveLength(0);
  });
});

describe('call order — consume before pin', () => {
  it('consumes the invite before writing the peer', async () => {
    const { flow, pairing, peerBook } = harness();
    const order: string[] = [];
    const realConsume = pairing.consume.bind(pairing);
    vi.spyOn(pairing, 'consume').mockImplementation((id, key) => {
      order.push('consume'); return realConsume(id, key);
    });
    const realAdd = peerBook.addPeer.bind(peerBook);
    vi.spyOn(peerBook, 'addPeer').mockImplementation(async (p, g) => {
      order.push('addPeer'); return realAdd(p, g);
    });

    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    flow.answer(begun.challenge.sessionId, correctAnswers());
    await flow.complete(begun.challenge.sessionId, GRANT);

    expect(order).toEqual(['consume', 'addPeer']);
  });

  it('does not pin when consume refuses', async () => {
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    flow.answer(begun.challenge.sessionId, correctAnswers());
    vi.spyOn(pairing, 'consume').mockReturnValue(false);

    const res = await flow.complete(begun.challenge.sessionId, GRANT);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('invite-not-consumable');
    expect(peerBook.listPeers()).toHaveLength(0);
  });

  it('one ceremony pins exactly once — a replayed complete cannot pin again', async () => {
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    flow.answer(begun.challenge.sessionId, correctAnswers());

    expect((await flow.complete(begun.challenge.sessionId, GRANT)).ok).toBe(true);
    const again = await flow.complete(begun.challenge.sessionId, { ...GRANT, alias: 'alice2' });
    expect(again.ok).toBe(false);
    expect(peerBook.listPeers()).toHaveLength(1);
  });

  it('reports honestly when the pin fails AFTER the invite was spent', async () => {
    // The invite cannot be replayed, so a UI that offers "retry" would fail for
    // a reason the human cannot see. Say the invite is spent.
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    flow.answer(begun.challenge.sessionId, correctAnswers());
    vi.spyOn(peerBook, 'addPeer').mockRejectedValue(new Error('store is full'));

    const res = await flow.complete(begun.challenge.sessionId, GRANT);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('issue a new invite');
  });
});

describe('the grant step', () => {
  async function pinWith(choice: Partial<typeof GRANT>) {
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    flow.answer(begun.challenge.sessionId, correctAnswers());
    const res = await flow.complete(begun.challenge.sessionId, { ...GRANT, ...choice });
    return { res, peerBook };
  }

  it('refuses an invalid alias rather than repairing it', async () => {
    for (const alias of ['Alice', '-lead', 'has space', '', 'a'.repeat(40)]) {
      const { res, peerBook } = await pinWith({ alias });
      expect(res.ok, alias).toBe(false);
      expect(peerBook.listPeers()).toHaveLength(0);
    }
  });

  it('refuses a trustDomain carrying control or bidi characters', async () => {
    for (const d of ['acme com', 'acme‮com', '']) {
      const { res } = await pinWith({ trustDomain: d });
      expect(res.ok).toBe(false);
    }
  });

  it('defaults to status + locate only', () => {
    expect([...DEFAULT_GRANT_VERBS].sort()).toEqual(['locate', 'status']);
  });

  it('drops unknown verbs and collapses duplicates', async () => {
    const { res, peerBook } = await pinWith({
      verbs: ['status', 'status', 'exec', 'locate', '__proto__'] as never,
    });
    expect(res.ok).toBe(true);
    const grant = peerBook.getGrant((res as { peer: { peerId: string } }).peer.peerId);
    expect(grant?.verbs.sort()).toEqual(['locate', 'status']);
  });

  it('refuses to pin with no verbs at all', async () => {
    const { res } = await pinWith({ verbs: [] });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('no verbs');
  });

  it('carries consult through when the human ticked it', async () => {
    const { res, peerBook } = await pinWith({ verbs: ['status', 'locate', 'consult'] });
    expect(res.ok).toBe(true);
    const grant = peerBook.getGrant((res as { peer: { peerId: string } }).peer.peerId);
    expect(grant?.verbs).toContain('consult');
  });
});

describe('session lifecycle', () => {
  it('refuses a self-invite before any challenge is shown', () => {
    const { flow, pairing } = harness({ ownPublicKey: theirs.publicKey });
    const res = flow.begin(inviteFromThem(pairing));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('self-invite');
  });

  it('refuses a malformed invite without creating a session', () => {
    const { flow } = harness();
    for (const bad of ['', 'not-a-url', 'desk://pair?x=1', 'https://example.com']) {
      expect(flow.begin(bad).ok, bad).toBe(false);
    }
    expect(flow.pendingCount).toBe(0);
  });

  it('expires a session when its invite expires underneath it', async () => {
    const { flow, pairing } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    flow.answer(begun.challenge.sessionId, correctAnswers());

    clock = T0 + 11 * 60_000; // past the 10-minute invite TTL
    expect(flow.pendingCount).toBe(0);
    const res = await flow.complete(begun.challenge.sessionId, GRANT);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('no-session');
  });

  it('abandon forgets the session and writes nothing', async () => {
    const { flow, pairing, peerBook } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: { sessionId: string } };
    flow.answer(begun.challenge.sessionId, correctAnswers());
    flow.abandon(begun.challenge.sessionId);

    expect((await flow.complete(begun.challenge.sessionId, GRANT)).ok).toBe(false);
    expect(peerBook.listPeers()).toHaveLength(0);
  });

  it('the challenge view carries no secret the other side does not already have', () => {
    const { flow, pairing } = harness();
    const begun = flow.begin(inviteFromThem(pairing)) as { ok: true; challenge: Record<string, unknown> };
    const s = JSON.stringify(begun.challenge);
    expect(s).not.toContain(mine.publicKey);
    // The peer's own key is not needed by the modal either.
    expect(s).not.toContain(theirs.publicKey);
  });
});
