/**
 * DeskProposalStore - Plan 21 Phase 6 (invariants I18, I19, I20).
 *
 * Written against the ATTACKS, not the API. Each block names the thing that
 * must not happen: a peer reading another peer's queue through `followup`, a
 * peer squatting an id to keep another peer's work out of the queue, a
 * declined proposal walking back into the human's queue on a generation bump,
 * a re-delivery renewing a lease forever, a sender-chosen duration outliving
 * the local bound, one window resurrecting another window's decision, a failed
 * write leaving disk claiming a durability memory disclaimed.
 *
 * Every security branch in the module has a test here that goes red if the
 * branch is deleted - that is the point of the file, not coverage. Where a
 * branch is structurally unreachable (and therefore unpinnable), the module
 * says so in a comment instead of pretending a test covers it.
 *
 * Hostile characters appear as escape sequences on purpose: a literal bidi
 * override in a source file reorders the file for the next reader, which is
 * the very attack under test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeskProposalStore,
  DESK_PROPOSAL_DEFAULT_LIMITS,
  DESK_PROPOSAL_LEASE_HARD_CEILING_MS,
  resolveDeskProposalLimits,
  isProposalState,
  type ProposalStore,
  type StoredProposal,
  type DeskProposalLimits,
} from '../../src/managers/DeskProposalStore';
import { LAMPORT_MAX_JUMP } from '../../src/services/desk/DeskBoard';

const STORE_KEY = 'mysti.desk.proposals.v1';
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Two well-formed peer ids of the exact shape `peerIdFor` emits. */
const ALICE = 'p_aaaaaaaaaaaaaaaa';
const BOB = 'p_bbbbbbbbbbbbbbbb';

/** The storage key of a record: author first, so no peer can name another's row. */
const K = (peerId: string, proposalId: string) => `${peerId}/${proposalId}`;

class FakeStore implements ProposalStore {
  data = new Map<string, unknown>();
  writes = 0;
  failWrites = false;
  /** Fail exactly the Nth write (1-based), so one of two overlapping
   *  mutations can fail while the other succeeds. */
  failWriteNumber: number | null = null;
  /** When set, `get` throws: a store that exists but cannot be read. */
  failReads = false;

  get<T>(key: string): T | undefined {
    if (this.failReads) { throw new Error('store unreadable'); }
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.writes++;
    if (this.failWrites || this.writes === this.failWriteNumber) { throw new Error('storage full'); }
    // Round-trip through JSON so no test can accidentally assert against a
    // live object the store still holds.
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

let clock = T0;
const now = () => clock;

/** Small, legible bounds so a lease can be outlived in a few lines. */
const LIMITS: DeskProposalLimits = {
  minLeaseMs: 1_000,
  maxLeaseMs: 100_000,
  defaultLeaseMs: 10_000,
  maxPerPeer: 4,
  pageSize: 2,
};

function make(store: FakeStore, limits: Partial<DeskProposalLimits> = LIMITS): DeskProposalStore {
  return new DeskProposalStore(store, now, limits);
}

function msg(over: Partial<Omit<StoredProposal, 'receivedAt' | 'state'>> = {}) {
  return {
    proposalId: 'p001',
    fromPeerId: ALICE,
    title: 'Wire the webhook retry',
    detail: 'Retries drop the idempotency key on the second attempt.',
    generation: 1,
    lamport: 1,
    leaseMs: 5_000,
    ...over,
  };
}

/** A well-formed stored record, for hand-built (i.e. tampered) store blobs. */
function stored(over: Partial<StoredProposal> = {}): StoredProposal {
  return {
    proposalId: 'p001',
    fromPeerId: ALICE,
    title: 't',
    detail: 'd',
    state: 'proposed',
    generation: 1,
    lamport: 1,
    leaseMs: 5_000,
    receivedAt: T0,
    ...over,
  };
}

function rawItems(store: FakeStore): Record<string, StoredProposal> {
  const blob = store.data.get(STORE_KEY) as { items: Record<string, StoredProposal> } | undefined;
  return blob?.items ?? {};
}

beforeEach(() => { clock = T0; });

// ---------------------------------------------------------------------------
describe('receive: generation monotonicity (I20)', () => {
  it('accepts a new proposal, then supersedes only on a HIGHER generation', async () => {
    const s = make(new FakeStore());
    expect(await s.receive(msg({ generation: 3, lamport: 3 }))).toBe('accepted-new');
    expect(await s.receive(msg({ generation: 4, lamport: 4, title: 'Newer' }))).toBe('superseded');
    expect(s.list()[0].title).toBe('Newer');
  });

  it('makes a LATE LOWER generation inert, not authoritative', async () => {
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg({ generation: 5, lamport: 5, title: 'Current' }));
    const writesBefore = store.writes;

    expect(await s.receive(msg({ generation: 2, lamport: 6, title: 'Stale rollback' })))
      .toBe('stale-ignored');

    expect(s.list()[0].title).toBe('Current');
    expect(s.list()[0].generation).toBe(5);
    // Inert means inert: no write, so a replay storm cannot even churn disk.
    expect(store.writes).toBe(writesBefore);
  });

  it('treats an EQUAL generation with different content as equivocation and drops it', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ generation: 2, lamport: 2, detail: 'The body the human read.' }));
    expect(await s.receive(msg({ generation: 2, lamport: 9, detail: 'A different body, same generation.' })))
      .toBe('stale-ignored');
    expect(s.list()[0].detail).toBe('The body the human read.');
  });

  it('drops a supersession whose lamport regresses', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ generation: 1, lamport: 20, title: 'Held' }));
    expect(await s.receive(msg({ generation: 2, lamport: 19, title: 'Reordered' })))
      .toBe('stale-ignored');
    expect(s.list()[0].title).toBe('Held');
  });
});

// ---------------------------------------------------------------------------
describe('receive: the wire can never set state', () => {
  it('does not revive a DECLINED proposal on a higher generation', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ generation: 1, lamport: 1 }));
    await s.setState(ALICE, 'p001', 'declined');

    expect(await s.receive(msg({ generation: 2, lamport: 2, title: 'Please reconsider' })))
      .toBe('superseded');

    const rec = s.list()[0];
    // Content moved; the human's answer did not.
    expect(rec.title).toBe('Please reconsider');
    expect(rec.state).toBe('declined');
  });

  it('does not revive an EXPIRED proposal on a higher generation', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ generation: 1, lamport: 1, leaseMs: 2_000 }));
    clock = T0 + 3_000;
    expect(await s.expireLeases()).toBe(1);

    await s.receive(msg({ generation: 2, lamport: 2 }));
    expect(s.list()[0].state).toBe('expired');
  });

  it('keeps the local decision when the pre-write merge cannot read the store', async () => {
    // Isolates the carry-over from the cross-window merge. With reads failing
    // there is no disk record to repair a state the wire tried to reset, so
    // this test is the one that goes red if `state: existing.state` is lost.
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg({ generation: 1, lamport: 1 }));
    await s.setState(ALICE, 'p001', 'declined');

    store.failReads = true;
    await s.receive(msg({ generation: 2, lamport: 2, title: 'Reconsider' }));

    expect(s.list()[0].state).toBe('declined');
    expect(rawItems(store)[K(ALICE, 'p001')].state).toBe('declined');
    expect(rawItems(store)[K(ALICE, 'p001')].title).toBe('Reconsider');
  });

  it('ignores a state field smuggled into the received object', async () => {
    const s = make(new FakeStore());
    const smuggled = { ...msg(), state: 'accepted' } as unknown as Parameters<DeskProposalStore['receive']>[0];
    await s.receive(smuggled);
    expect(s.list()[0].state).toBe('proposed');
  });
});

// ---------------------------------------------------------------------------
describe('a proposal id belongs to its author, not to the store', () => {
  it('gives two peers using the same id two separate rows, with no cross-talk', async () => {
    const s = make(new FakeStore());
    expect(await s.receive(msg({ fromPeerId: ALICE, generation: 1, lamport: 1, detail: 'Alice wrote this.' })))
      .toBe('accepted-new');
    // Bob reuses Alice's id, with a much higher generation - the shape of a
    // hijack. It must land in Bob's own row and touch nothing of Alice's.
    expect(await s.receive(msg({ fromPeerId: BOB, generation: 9, lamport: 9, detail: 'Bob overwrote it.' })))
      .toBe('accepted-new');

    const alice = s.list().find(r => r.fromPeerId === ALICE)!;
    expect(alice.detail).toBe('Alice wrote this.');
    expect(alice.generation).toBe(1);

    expect(s.followupFor(ALICE).items.map(i => i.detail)).toEqual(['Alice wrote this.']);
    expect(s.followupFor(BOB).items.map(i => i.detail)).toEqual(['Bob overwrote it.']);
  });

  it('cannot be squatted: pre-registering an id does not keep the other peer out of the queue', async () => {
    // The denial this keying prevents. Bob mints ids from a predictable
    // scheme first; every one of Alice's proposals must still reach the human.
    const s = make(new FakeStore(), { ...LIMITS, maxPerPeer: 10 });
    for (const id of ['p001', 'p002', 'p003']) {
      await s.receive(msg({ proposalId: id, fromPeerId: BOB, lamport: 1 }));
    }
    for (const id of ['p001', 'p002', 'p003']) {
      expect(await s.receive(msg({ proposalId: id, fromPeerId: ALICE, lamport: 1, detail: 'Alice needs this seen.' })))
        .toBe('accepted-new');
    }
    expect(s.followupFor(ALICE).items.map(i => i.proposalId)).toEqual(['p001', 'p002']);
    expect(s.list().filter(r => r.fromPeerId === ALICE)).toHaveLength(3);
  });

  it('is not an existence oracle: the outcome is the same whether or not another peer holds the id', async () => {
    // Bob probes one id he has never used. If "taken by someone else" and
    // "free" gave different answers, he could enumerate Alice's ids one probe
    // at a time - exactly the disclosure `followupFor` is built to prevent.
    const held = make(new FakeStore());
    await held.receive(msg({ proposalId: 'secret1', fromPeerId: ALICE, lamport: 1 }));
    const free = make(new FakeStore());

    const probeHeld = await held.receive(msg({ proposalId: 'secret1', fromPeerId: BOB, lamport: 1 }));
    const probeFree = await free.receive(msg({ proposalId: 'secret1', fromPeerId: BOB, lamport: 1 }));
    expect(probeHeld).toBe(probeFree);
    expect(probeHeld).toBe('accepted-new');
  });

  it('keys storage by author, so a peer-chosen id is never a bare object key', async () => {
    // `__proto__` is a legal proposalId under the wire contract's ID_RE. It
    // must not be able to become a key of the persisted blob.
    const store = new FakeStore();
    const s = make(store);
    expect(await s.receive(msg({ proposalId: '__proto__' }))).toBe('accepted-new');
    expect(Object.keys(rawItems(store))).toEqual([K(ALICE, '__proto__')]);
    expect(Object.keys(rawItems(store))).not.toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(make(store).list().map(r => r.proposalId)).toEqual(['__proto__']);
  });
});

// ---------------------------------------------------------------------------
describe('leases are receiver-computed durations (I18)', () => {
  it('clamps a sender-chosen 100-year lease to the local ceiling', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ leaseMs: 100 * 365 * 24 * 60 * 60 * 1000 }));
    expect(s.list()[0].leaseMs).toBe(LIMITS.maxLeaseMs);

    clock = T0 + LIMITS.maxLeaseMs + 1;
    expect(await s.expireLeases()).toBe(1);
    expect(s.list()[0].state).toBe('expired');
  });

  it('clamps a lease below the floor rather than expiring instantly', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ leaseMs: 1 }));
    expect(s.list()[0].leaseMs).toBe(LIMITS.minLeaseMs);
  });

  it('substitutes the default for a non-finite lease instead of an immortal one', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ leaseMs: Number.NaN }));
    expect(s.list()[0].leaseMs).toBe(LIMITS.defaultLeaseMs);
    clock = T0 + LIMITS.defaultLeaseMs;
    expect(await s.expireLeases()).toBe(1);
  });

  it('does NOT restart the lease when the same generation is re-delivered', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ generation: 1, lamport: 1, leaseMs: 5_000 }));

    // At-least-once delivery: the same message four times, each 4 s apart.
    for (let i = 1; i <= 4; i++) {
      clock = T0 + i * 4_000;
      expect(await s.receive(msg({ generation: 1, lamport: 1, leaseMs: 5_000 }))).toBe('stale-ignored');
    }

    // The anchor is still the FIRST observation, so the lease is long gone.
    expect(await s.expireLeases()).toBe(1);
    expect(s.list()[0].receivedAt).toBe(T0);
  });

  it('anchors a new lease on the local clock when a generation supersedes', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ generation: 1, lamport: 1, leaseMs: 5_000 }));
    clock = T0 + 4_000;
    await s.receive(msg({ generation: 2, lamport: 2, leaseMs: 5_000 }));

    clock = T0 + 6_000; // past the FIRST lease, inside the second
    expect(await s.expireLeases()).toBe(0);
    clock = T0 + 9_001;
    expect(await s.expireLeases()).toBe(1);
  });

  it('orders the local queue the same way in every window', async () => {
    // Two peers may both use `p001`, and two windows may observe them in
    // opposite orders. Falling back to insertion order would render one human
    // queue two different ways.
    const one = make(new FakeStore());
    await one.receive(msg({ proposalId: 'p001', fromPeerId: BOB, lamport: 1 }));
    await one.receive(msg({ proposalId: 'p001', fromPeerId: ALICE, lamport: 1 }));

    const other = make(new FakeStore());
    await other.receive(msg({ proposalId: 'p001', fromPeerId: ALICE, lamport: 1 }));
    await other.receive(msg({ proposalId: 'p001', fromPeerId: BOB, lamport: 1 }));

    expect(one.list().map(r => r.fromPeerId)).toEqual(other.list().map(r => r.fromPeerId));
  });

  it('never expires a terminal record and reports the count it changed', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ proposalId: 'p001', leaseMs: 1_000 }));
    await s.receive(msg({ proposalId: 'p002', lamport: 2, leaseMs: 1_000 }));
    await s.receive(msg({ proposalId: 'p003', lamport: 3, leaseMs: 1_000 }));
    await s.setState(ALICE, 'p003', 'done');

    clock = T0 + 5_000;
    expect(await s.expireLeases()).toBe(2);
    expect(await s.expireLeases()).toBe(0);
    expect(s.list().find(r => r.proposalId === 'p003')!.state).toBe('done');
  });

  it('never reaps a proposal a human ACCEPTED, however long the work takes', async () => {
    // `accepted` outranks nothing but `proposed` in the merge order, so a
    // rank-based reaper overwrites it with `expired` - and because both the
    // merge and setState are forward-only, the human can then never restore
    // their own decision and is told nothing about why.
    const s = make(new FakeStore());
    await s.receive(msg({ leaseMs: 1_000 }));
    await s.setState(ALICE, 'p001', 'accepted');

    clock = T0 + 10 * 24 * 60 * 60 * 1000; // ten days into the work
    expect(await s.expireLeases()).toBe(0);
    expect(s.list()[0].state).toBe('accepted');

    // And the decision is still the human's to move forward.
    await s.setState(ALICE, 'p001', 'done');
    expect(s.list()[0].state).toBe('done');
  });
});

// ---------------------------------------------------------------------------
describe('lamport bounds are receiver-computed (I19)', () => {
  it('rejects a jump beyond maxSeen + LAMPORT_MAX_JUMP', async () => {
    const s = make(new FakeStore());
    await expect(s.receive(msg({ lamport: LAMPORT_MAX_JUMP + 1 }))).rejects.toThrow(/lamport jump/);
    expect(s.list()).toHaveLength(0);
  });

  it('accepts a jump exactly at the bound, then re-bases the ceiling', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ proposalId: 'p001', lamport: LAMPORT_MAX_JUMP }));
    await s.receive(msg({ proposalId: 'p002', lamport: LAMPORT_MAX_JUMP * 2 }));
    await expect(s.receive(msg({ proposalId: 'p003', lamport: LAMPORT_MAX_JUMP * 3 + 1 })))
      .rejects.toThrow(/lamport jump/);
  });

  it('keeps each peer on its OWN ceiling', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ proposalId: 'p001', fromPeerId: ALICE, lamport: LAMPORT_MAX_JUMP }));
    // Bob has sent nothing, so his ceiling is still 0 regardless of Alice.
    await expect(s.receive(msg({ proposalId: 'p002', fromPeerId: BOB, lamport: LAMPORT_MAX_JUMP + 1 })))
      .rejects.toThrow(/lamport jump/);
  });

  it('persists the ceiling so pruning cannot lock out a well-behaved peer', async () => {
    const store = new FakeStore();
    const a = make(store);
    await a.receive(msg({ proposalId: 'p001', lamport: LAMPORT_MAX_JUMP }));

    // A fresh instance over the same storage: the ceiling must survive, or a
    // peer legitimately at lamport 64 is rejected forever after a reload.
    const b = make(store);
    await expect(b.receive(msg({ proposalId: 'p002', lamport: LAMPORT_MAX_JUMP * 2 })))
      .resolves.toBe('accepted-new');
  });

  it('gives back the ceiling raise when the write it belonged to failed', async () => {
    // The raise is not durable if the record is not, so memory must not keep
    // it either - otherwise a failed write silently widens the window the next
    // message is measured against.
    const store = new FakeStore();
    const s = make(store);
    store.failWrites = true;
    await expect(s.receive(msg({ lamport: LAMPORT_MAX_JUMP }))).rejects.toThrow(/storage full/);
    store.failWrites = false;
    await expect(s.receive(msg({ proposalId: 'p002', lamport: LAMPORT_MAX_JUMP * 2 })))
      .rejects.toThrow(/lamport jump/);
  });
});

// ---------------------------------------------------------------------------
describe('followupFor is a disclosure boundary, not a filter', () => {
  async function seeded(): Promise<DeskProposalStore> {
    const s = make(new FakeStore(), { ...LIMITS, maxPerPeer: 20, pageSize: 2 });
    await s.receive(msg({ proposalId: 'a1', fromPeerId: ALICE, lamport: 1 }));
    await s.receive(msg({ proposalId: 'a2', fromPeerId: ALICE, lamport: 2 }));
    await s.receive(msg({ proposalId: 'a3', fromPeerId: ALICE, lamport: 3 }));
    await s.receive(msg({ proposalId: 'b1', fromPeerId: BOB, lamport: 1, detail: 'Bob secret detail.' }));
    await s.receive(msg({ proposalId: 'b2', fromPeerId: BOB, lamport: 2, detail: 'Bob secret detail.' }));
    return s;
  }

  it('never returns another peer proposal, across every page', async () => {
    const s = await seeded();
    const all: string[] = [];
    let page = s.followupFor(ALICE);
    for (;;) {
      expect(page.items.every(i => i.fromPeerId === ALICE)).toBe(true);
      all.push(...page.items.map(i => i.proposalId));
      if (!page.nextCursor) { break; }
      page = s.followupFor(ALICE, page.nextCursor);
    }
    expect(all).toEqual(['a1', 'a2', 'a3']);
    expect(JSON.stringify(all)).not.toContain('b1');
  });

  it('cannot be walked into another peer items with their cursor', async () => {
    const s = await seeded();
    // Bob hands one of his own ids in as Alice's cursor. It must position
    // inside ALICE's list only, and reveal nothing about Bob's.
    const page = s.followupFor(ALICE, 'b1');
    expect(page.items.map(i => i.proposalId)).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('answers an unknown peer exactly like a peer with nothing, so there is no oracle', async () => {
    const s = await seeded();
    expect(s.followupFor('p_cccccccccccccccc')).toEqual({ items: [] });
    expect(s.followupFor('../../etc/passwd')).toEqual({ items: [] });
    expect(s.followupFor(ALICE, 'zzzz')).toEqual({ items: [] });
  });

  it('refuses a malformed cursor rather than falling back to page one', async () => {
    const s = await seeded();
    // Falling back to the start on a bad cursor is the tempting shortcut, and
    // it is a disclosure: a caller that cannot form a cursor gets a full page.
    // Alice HAS records here, so page one is a non-empty answer and the two
    // behaviours are distinguishable - the empty page must come from the
    // refusal, not from `'a1' > undefined` happening to be false.
    expect(s.followupFor(ALICE).items).toHaveLength(2);
    expect(s.followupFor(ALICE, 'a1\u202Eb1')).toEqual({ items: [] });
    expect(s.followupFor(ALICE, 'x'.repeat(65))).toEqual({ items: [] });
    expect(s.followupFor(ALICE, 'has spaces')).toEqual({ items: [] });
  });

  it('pages stably: every item exactly once, even as a supersession lands mid-walk', async () => {
    const s = await seeded();
    const first = s.followupFor(ALICE);
    expect(first.items.map(i => i.proposalId)).toEqual(['a1', 'a2']);
    expect(first.nextCursor).toBe('a2');

    // a1 is superseded between pages. Because ordering is by immutable id, it
    // cannot jump ahead of the cursor and cause a2/a3 to be skipped.
    await s.receive(msg({ proposalId: 'a1', fromPeerId: ALICE, generation: 2, lamport: 4 }));

    const second = s.followupFor(ALICE, first.nextCursor);
    expect(second.items.map(i => i.proposalId)).toEqual(['a3']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('honours the configured page size', async () => {
    const s = await seeded();
    expect(s.followupFor(ALICE).items).toHaveLength(2);
  });

  it('returns clones, so a caller cannot mutate the store through its answer', async () => {
    const s = await seeded();
    const item = s.followupFor(ALICE).items[0];
    item.state = 'done';
    item.detail = 'tampered';
    const stored = s.list().find(r => r.proposalId === 'a1')!;
    expect(stored.state).toBe('proposed');
    expect(stored.detail).not.toBe('tampered');
  });
});

// ---------------------------------------------------------------------------
describe('list() is a copy, not a handle on the store', () => {
  it('cannot be used to forge a decision or lift a lease past the ceiling', async () => {
    // The local board and the local UI read through list(). Handing out live
    // records would let any caller flip `state` to a human decision nobody
    // made, or raise `leaseMs` past the clamp - which never runs again on an
    // object already in the map.
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg({ leaseMs: 5_000 }));

    const leaked = s.list()[0];
    leaked.state = 'accepted';
    leaked.leaseMs = 1e18;
    leaked.title = 'tampered';

    const after = s.list()[0];
    expect(after.state).toBe('proposed');
    expect(after.leaseMs).toBe(5_000);
    expect(after.title).not.toBe('tampered');

    // And the lease still runs out on the value the receiver computed.
    clock = T0 + 5_001;
    expect(await s.expireLeases()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('setState is forward-only, enum-closed and author-scoped', () => {
  it('refuses a state that is not in the enum', async () => {
    const s = make(new FakeStore());
    await s.receive(msg());
    await expect(s.setState(ALICE, 'p001', 'PROPOSED' as StoredProposal['state'])).rejects.toThrow(/unknown proposal state/);
    await expect(s.setState(ALICE, 'p001', '__proto__' as StoredProposal['state'])).rejects.toThrow(/unknown proposal state/);
    await expect(s.setState(ALICE, 'p001', 'toString' as StoredProposal['state'])).rejects.toThrow(/unknown proposal state/);
    expect(s.list()[0].state).toBe('proposed');
  });

  it('refuses an unknown or malformed proposal id, and a peer id it did not derive', async () => {
    const s = make(new FakeStore());
    await expect(s.setState(ALICE, 'nope', 'done')).rejects.toThrow(/unknown proposal/);
    await expect(s.setState(ALICE, 'a/../b', 'done')).rejects.toThrow(/proposalId/);
    await expect(s.setState('alice', 'p001', 'done')).rejects.toThrow(/peer id/);
  });

  it('decides one author record, never the other peer row of the same id', async () => {
    const s = make(new FakeStore());
    await s.receive(msg({ proposalId: 'p001', fromPeerId: ALICE, lamport: 1 }));
    await s.receive(msg({ proposalId: 'p001', fromPeerId: BOB, lamport: 1 }));

    await s.setState(ALICE, 'p001', 'declined');

    expect(s.followupFor(ALICE).items[0].proposalId).toBe('p001');
    expect(s.list().find(r => r.fromPeerId === ALICE)!.state).toBe('declined');
    expect(s.list().find(r => r.fromPeerId === BOB)!.state).toBe('proposed');
  });

  it('never walks a decision backwards', async () => {
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg());
    await s.setState(ALICE, 'p001', 'done');
    const writes = store.writes;
    await s.setState(ALICE, 'p001', 'proposed');
    await s.setState(ALICE, 'p001', 'accepted');
    await s.setState(ALICE, 'p001', 'done');
    expect(s.list()[0].state).toBe('done');
    // A no-op transition writes nothing.
    expect(store.writes).toBe(writes);
  });
});

// ---------------------------------------------------------------------------
describe('two windows over one globalState', () => {
  it('does not resurrect a declined proposal when the other window supersedes it', async () => {
    const store = new FakeStore();
    const a = make(store);
    await a.receive(msg({ generation: 1, lamport: 1 }));

    // b loads the proposal while it is still undecided.
    const b = make(store);
    expect(b.list()[0].state).toBe('proposed');

    await a.setState(ALICE, 'p001', 'declined');
    // b now takes generation 2 and writes: the pre-write merge must see a's
    // terminal decision on disk and keep it.
    expect(await b.receive(msg({ generation: 2, lamport: 2, title: 'Reconsider' }))).toBe('superseded');

    expect(b.list()[0].state).toBe('declined');
    expect(rawItems(store)[K(ALICE, 'p001')].state).toBe('declined');
    expect(rawItems(store)[K(ALICE, 'p001')].title).toBe('Reconsider');
    expect(rawItems(store)[K(ALICE, 'p001')].generation).toBe(2);
  });

  it('does not let a stale window roll a generation back on disk', async () => {
    const store = new FakeStore();
    const a = make(store);
    const b = make(store);
    await a.receive(msg({ generation: 5, lamport: 5, title: 'Fresh' }));
    // b holds nothing for p001; it receives an OLD generation and writes.
    await b.receive(msg({ generation: 1, lamport: 1, title: 'Ancient' }));
    expect(rawItems(store)[K(ALICE, 'p001')].generation).toBe(5);
    expect(rawItems(store)[K(ALICE, 'p001')].title).toBe('Fresh');
    expect(b.list()[0].title).toBe('Fresh');
  });

  it('keeps the earlier lease anchor when both windows hold the same generation', async () => {
    const store = new FakeStore();
    const a = make(store);
    const b = make(store);
    await a.receive(msg({ generation: 1, lamport: 1, leaseMs: 5_000 }));

    clock = T0 + 4_000;
    // The same message reaches the second window later. A merge that took the
    // newer receivedAt would extend the lease every time a window re-reads.
    await b.receive(msg({ generation: 1, lamport: 1, leaseMs: 5_000 }));
    expect(rawItems(store)[K(ALICE, 'p001')].receivedAt).toBe(T0);
    expect(b.list()[0].receivedAt).toBe(T0);
  });

  it('converges on equivocated content at an identical generation AND millisecond', async () => {
    // The tie-break must be a rule both windows compute the same way. "Prefer
    // the disk copy" is not: disk is the OTHER window's record seen from
    // either side, so the two swap content on every write, forever.
    const store = new FakeStore();
    const key = K(ALICE, 'p001');
    const bodyA = stored({ title: 'AAA', leaseMs: 100_000 });
    const bodyB = stored({ title: 'BBB', leaseMs: 100_000 });

    store.data.set(STORE_KEY, { items: { [key]: bodyA }, lamportCeiling: {} });
    const a = make(store);
    store.data.set(STORE_KEY, { items: { [key]: bodyB }, lamportCeiling: {} });
    const b = make(store);

    // a reconciles against B-on-disk; b reconciles against A-on-disk.
    await a.expireLeases();
    store.data.set(STORE_KEY, { items: { [key]: bodyA }, lamportCeiling: {} });
    await b.expireLeases();

    expect(a.list()[0].title).toBe(b.list()[0].title);
  });
});

// ---------------------------------------------------------------------------
describe('storage is validated, never repaired', () => {
  it('drops records that a tampered store invented', async () => {
    const store = new FakeStore();
    store.data.set(STORE_KEY, {
      items: {
        [K(ALICE, 'ok')]: stored({ proposalId: 'ok' }),
        [K(ALICE, 'badstate')]: stored({ proposalId: 'badstate', state: 'approved' as StoredProposal['state'] }),
        [K(ALICE, 'badpeer')]: stored({ proposalId: 'badpeer', fromPeerId: 'alice' }),
        [K(ALICE, 'mismatch')]: stored({ proposalId: 'other' }),
        [K(ALICE, 'badgen')]: stored({ proposalId: 'badgen', generation: -1 }),
        [K(ALICE, 'badnum')]: stored({ proposalId: 'badnum', receivedAt: 'soon' as unknown as number }),
      },
      lamportCeiling: { [ALICE]: 4, alice: 999_999, [BOB]: 'lots' },
    });
    const s = make(store);
    expect(s.list().map(r => r.proposalId)).toEqual(['ok']);
    // The malformed ceiling entries were dropped, so Bob is measured from 0.
    await expect(s.receive(msg({ proposalId: 'z1', fromPeerId: BOB, lamport: LAMPORT_MAX_JUMP + 1 })))
      .rejects.toThrow(/lamport jump/);
  });

  it('drops a record whose key claims an author the record does not', async () => {
    // The key is a claim, not evidence. A record filed under Alice but signed
    // by Bob would otherwise be served to whichever peer the code happened to
    // read the author from - and `followupFor` is a disclosure boundary.
    const store = new FakeStore();
    store.data.set(STORE_KEY, {
      items: { [K(ALICE, 'x1')]: stored({ proposalId: 'x1', fromPeerId: BOB, detail: 'Filed under Alice.' }) },
      lamportCeiling: {},
    });
    const s = make(store);
    expect(s.list()).toEqual([]);
    expect(s.followupFor(ALICE).items).toEqual([]);
    expect(s.followupFor(BOB).items).toEqual([]);
  });

  it('drops a stored proposalId that is malformed even when the key agrees with it', async () => {
    // The key/id agreement check cannot stand in for validating the id: in a
    // tampered store BOTH are attacker-chosen. An unvalidated id is served
    // back out through followupFor and toWire.
    const store = new FakeStore();
    const evil = '../../etc/passwd';
    const long = 'x'.repeat(500);
    const bidi = 'a\u202Eb';
    store.data.set(STORE_KEY, {
      items: {
        [K(ALICE, evil)]: stored({ proposalId: evil }),
        [K(ALICE, long)]: stored({ proposalId: long }),
        [K(ALICE, bidi)]: stored({ proposalId: bidi }),
        [K(ALICE, 'good')]: stored({ proposalId: 'good' }),
      },
      lamportCeiling: {},
    });
    expect(make(store).list().map(r => r.proposalId)).toEqual(['good']);
  });

  it('drops stored title/detail that would reach the webview unsafely', async () => {
    // The same characters the receive() path refuses. A store is a file a
    // human (or anything running as the human) can edit, so the load path
    // needs its own copy of the check - a bidi override in a title reorders
    // the rendered card, which is the trojan-source attack in a queue.
    const store = new FakeStore();
    store.data.set(STORE_KEY, {
      items: {
        [K(ALICE, 'bidititle')]: stored({ proposalId: 'bidititle', title: 'ship \u202Egnihton' }),
        [K(ALICE, 'ctldetail')]: stored({ proposalId: 'ctldetail', detail: 'ring \u0007 the bell' }),
        [K(ALICE, 'hugedetail')]: stored({ proposalId: 'hugedetail', detail: 'x'.repeat(50_000) }),
        [K(ALICE, 'emptytitle')]: stored({ proposalId: 'emptytitle', title: '   ' }),
        [K(ALICE, 'numtitle')]: stored({ proposalId: 'numtitle', title: 7 as unknown as string }),
        [K(ALICE, 'good')]: stored({ proposalId: 'good' }),
      },
      lamportCeiling: {},
    });
    const s = make(store);
    expect(s.list().map(r => r.proposalId)).toEqual(['good']);
    expect(JSON.stringify(s.followupFor(ALICE).items)).not.toContain('\u202E');
  });

  it('re-clamps a hand-edited immortal lease on load', () => {
    const store = new FakeStore();
    store.data.set(STORE_KEY, {
      items: { [K(ALICE, 'p001')]: stored({ leaseMs: 1e18 }) },
      lamportCeiling: {},
    });
    const s = make(store);
    expect(s.list()[0].leaseMs).toBe(LIMITS.maxLeaseMs);
  });

  it('bounds the lease ANCHOR too, so the immortal card cannot move one field over', async () => {
    // Clamping leaseMs alone is defeated by editing receivedAt instead: at
    // 1e18 the deadline is past the end of representable time and the card
    // never expires, however tightly the duration is bounded.
    const store = new FakeStore();
    store.data.set(STORE_KEY, {
      items: { [K(ALICE, 'p001')]: stored({ leaseMs: 1e18, receivedAt: 1e18 }) },
      lamportCeiling: {},
    });
    const s = make(store);
    expect(s.list()).toEqual([]);

    clock = 8.64e15;
    expect(await s.expireLeases()).toBe(0);
  });

  it('re-anchors a slightly future record instead of deleting a real queue', async () => {
    // The failure mode the bound must NOT have: a machine whose clock stepped
    // backwards (NTP) legitimately holds records dated ahead of `now`, and a
    // filter that dropped them would empty a human's queue on a healthy
    // machine. Re-anchoring costs only the skew.
    const store = new FakeStore();
    store.data.set(STORE_KEY, {
      items: { [K(ALICE, 'p001')]: stored({ receivedAt: T0 + 60_000, leaseMs: 5_000 }) },
      lamportCeiling: {},
    });
    const s = make(store);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].receivedAt).toBe(T0);

    expect(await s.expireLeases()).toBe(0);
    clock = T0 + 5_001;
    expect(await s.expireLeases()).toBe(1);
  });

  it('starts empty when the store cannot be read at all', () => {
    const store = new FakeStore();
    store.failReads = true;
    expect(make(store).list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('a failed write never leaves a phantom record', () => {
  it('rolls back a new proposal the store refused to persist', async () => {
    const store = new FakeStore();
    const s = make(store);
    store.failWrites = true;
    await expect(s.receive(msg())).rejects.toThrow(/storage full/);
    expect(s.list()).toEqual([]);
  });

  it('rolls back a supersession the store refused to persist', async () => {
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg({ generation: 1, lamport: 1, title: 'Durable' }));
    store.failWrites = true;
    await expect(s.receive(msg({ generation: 2, lamport: 2, title: 'Lost' }))).rejects.toThrow();
    expect(s.list()[0].title).toBe('Durable');
    expect(s.list()[0].generation).toBe(1);
  });

  it('rolls back a local decision the store refused to persist', async () => {
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg());
    store.failWrites = true;
    await expect(s.setState(ALICE, 'p001', 'accepted')).rejects.toThrow();
    expect(s.list()[0].state).toBe('proposed');
  });

  it('keeps serving writes after one storage hiccup', async () => {
    const store = new FakeStore();
    const s = make(store);
    store.failWrites = true;
    await expect(s.receive(msg())).rejects.toThrow();
    store.failWrites = false;
    await expect(s.receive(msg())).resolves.toBe('accepted-new');
    expect(rawItems(store)[K(ALICE, 'p001')]).toBeDefined();
  });

  it('does not let a NEIGHBOURING write publish the record it just refused', async () => {
    // Two receives overlap, because a network dispatcher drives them. The
    // second one's write fails and its caller is told so - therefore the
    // second record must not be durable. Snapshotting shared memory inside a
    // queued step publishes it anyway on the FIRST write, and the rollback
    // then only edits memory: the card comes back on the next reload, which
    // is the inverse of the invariant and the worse direction of it.
    const store = new FakeStore();
    const s = make(store);
    store.failWriteNumber = 2;

    const first = s.receive(msg({ proposalId: 'r1', lamport: 1 }));
    const second = s.receive(msg({ proposalId: 'r2', lamport: 2 }));

    await expect(first).resolves.toBe('accepted-new');
    await expect(second).rejects.toThrow(/storage full/);

    expect(Object.keys(rawItems(store))).toEqual([K(ALICE, 'r1')]);
    expect(s.list().map(r => r.proposalId)).toEqual(['r1']);
    // The reload is where a phantom would show up as a live card.
    expect(make(store).list().map(r => r.proposalId)).toEqual(['r1']);
  });

  it('does not let a neighbouring write publish a decision it refused either', async () => {
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg({ proposalId: 'r1', lamport: 1 }));
    await s.receive(msg({ proposalId: 'r2', lamport: 2 }));
    store.failWriteNumber = 4; // the second of the two overlapping decisions

    const first = s.setState(ALICE, 'r1', 'done');
    const second = s.setState(ALICE, 'r2', 'declined');

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(/storage full/);

    expect(rawItems(store)[K(ALICE, 'r2')].state).toBe('proposed');
    expect(make(store).list().find(r => r.proposalId === 'r2')!.state).toBe('proposed');
  });

  it('puts back the records a refused write had shed under quota', async () => {
    const store = new FakeStore();
    const s = make(store, { ...LIMITS, maxPerPeer: 2 });
    await s.receive(msg({ proposalId: 'a1', lamport: 1 }));
    await s.receive(msg({ proposalId: 'a2', lamport: 2 }));
    await s.setState(ALICE, 'a1', 'done');

    store.failWrites = true;
    await expect(s.receive(msg({ proposalId: 'a3', lamport: 3 }))).rejects.toThrow(/storage full/);

    // The shed never became durable, so memory must not act as if it had.
    expect(s.list().map(r => r.proposalId).sort()).toEqual(['a1', 'a2']);
    expect(Object.keys(rawItems(store)).sort()).toEqual([K(ALICE, 'a1'), K(ALICE, 'a2')]);
  });
});

// ---------------------------------------------------------------------------
describe('input validation at the boundary', () => {
  it('refuses a bidi override in a title and a control character in a detail', async () => {
    const s = make(new FakeStore());
    await expect(s.receive(msg({ title: 'ship \u202Egnihton' }))).rejects.toThrow(/bidi/);
    await expect(s.receive(msg({ detail: 'ring \u0007 the bell' }))).rejects.toThrow(/control/);
    expect(s.list()).toEqual([]);
  });

  it('refuses an over-long title or detail rather than truncating it (I21)', async () => {
    const s = make(new FakeStore());
    await expect(s.receive(msg({ title: 'x'.repeat(201) }))).rejects.toThrow(/exceeds/);
    await expect(s.receive(msg({ detail: 'x'.repeat(20_001) }))).rejects.toThrow(/exceeds/);
    expect(s.list()).toEqual([]);
  });

  it('refuses a peer id this machine did not derive', async () => {
    const s = make(new FakeStore());
    await expect(s.receive(msg({ fromPeerId: 'p_UPPERCASE1234567' }))).rejects.toThrow(/peer id/);
    await expect(s.receive(msg({ fromPeerId: `p_${'a'.repeat(4000)}` }))).rejects.toThrow(/peer id/);
    await expect(s.receive(msg({ fromPeerId: '' }))).rejects.toThrow(/peer id/);
    // A peerId carrying the key separator would otherwise let one message
    // name another peer's row.
    await expect(s.receive(msg({ fromPeerId: `${ALICE}/x` }))).rejects.toThrow(/peer id/);
  });

  it('refuses a malformed proposal id, generation or lamport, and writes nothing', async () => {
    const store = new FakeStore();
    const s = make(store);
    await expect(s.receive(msg({ proposalId: '../../evil' }))).rejects.toThrow(/proposalId/);
    await expect(s.receive(msg({ generation: 1.5 }))).rejects.toThrow(/generation/);
    await expect(s.receive(msg({ generation: -1 }))).rejects.toThrow(/generation/);
    await expect(s.receive(msg({ lamport: Number.NaN }))).rejects.toThrow(/lamport/);
    await expect(s.receive(msg({ lamport: Number.POSITIVE_INFINITY }))).rejects.toThrow(/lamport/);
    expect(store.writes).toBe(0);
  });

  it('refuses a non-object entirely, and says so', async () => {
    const s = make(new FakeStore());
    type Inbound = Parameters<DeskProposalStore['receive']>[0];
    // The message pattern matters: without it, the raw TypeError that
    // `validateId` throws on `null.proposalId` satisfies a bare toThrow(), and
    // the guard can be deleted with the suite still green. The non-null cases
    // never reach a TypeError at all - they would sail past a missing guard
    // into `validateId`, which is not where a shape refusal belongs.
    await expect(s.receive(null as unknown as Inbound)).rejects.toThrow(/must be an object/);
    await expect(s.receive(undefined as unknown as Inbound)).rejects.toThrow(/must be an object/);
    await expect(s.receive('p001' as unknown as Inbound)).rejects.toThrow(/must be an object/);
    await expect(s.receive(7 as unknown as Inbound)).rejects.toThrow(/must be an object/);
    await expect(s.receive(true as unknown as Inbound)).rejects.toThrow(/must be an object/);
    expect(s.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('an unreadable clock fails closed', () => {
  it('refuses to anchor a lease it cannot date', async () => {
    const s = new DeskProposalStore(new FakeStore(), () => Number.NaN, LIMITS);
    await expect(s.receive(msg())).rejects.toThrow(/clock unreadable/);
    expect(s.list()).toEqual([]);
  });

  it('treats an unreadable clock as past every deadline when expiring', async () => {
    let broken = false;
    const s = new DeskProposalStore(new FakeStore(), () => (broken ? Number.NaN : clock), LIMITS);
    await s.receive(msg({ leaseMs: 100_000 }));
    broken = true;
    expect(await s.expireLeases()).toBe(1);
    expect(s.list()[0].state).toBe('expired');
  });

  it('treats a clock that THROWS the same as one returning NaN', async () => {
    // A clock is an injected `() => number`. A wrapped or instrumented one is
    // at least as likely to throw as to return NaN, and an uncaught throw
    // fails OPEN: expireLeases rejects and nothing is ever expired.
    let broken = false;
    const clocks = () => {
      if (broken) { throw new Error('clock source gone'); }
      return clock;
    };
    const s = new DeskProposalStore(new FakeStore(), clocks, LIMITS);
    await s.receive(msg({ leaseMs: 100_000 }));
    broken = true;

    await expect(s.expireLeases()).resolves.toBe(1);
    expect(s.list()[0].state).toBe('expired');

    const fresh = new DeskProposalStore(new FakeStore(), () => { throw new Error('clock source gone'); }, LIMITS);
    await expect(fresh.receive(msg())).rejects.toThrow(/clock unreadable/);
    expect(fresh.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('expiry is a conclusion, not a transaction', () => {
  it('still reports what it expired when the write fails', async () => {
    // Expiry is recomputable, so memory keeps the stricter state - but a
    // caller that only learns "it threw" retries, gets 0 (memory has already
    // expired them) and never finds out how many cards left the queue.
    const store = new FakeStore();
    const s = make(store);
    await s.receive(msg({ proposalId: 'a1', lamport: 1, leaseMs: 1_000 }));
    await s.receive(msg({ proposalId: 'a2', lamport: 2, leaseMs: 1_000 }));

    store.failWrites = true;
    clock = T0 + 5_000;
    await expect(s.expireLeases()).resolves.toBe(2);
    expect(s.list().every(r => r.state === 'expired')).toBe(true);
    // Disk is behind, on the safe side, and says so on the next reload.
    expect(rawItems(store)[K(ALICE, 'a1')].state).toBe('proposed');
  });
});

// ---------------------------------------------------------------------------
describe('the per-peer quota cannot become cross-peer eviction', () => {
  it('sheds a peer own FINISHED records to make room', async () => {
    const store = new FakeStore();
    const s = make(store, { ...LIMITS, maxPerPeer: 2 });
    await s.receive(msg({ proposalId: 'a1', lamport: 1 }));
    await s.receive(msg({ proposalId: 'a2', lamport: 2 }));
    await s.setState(ALICE, 'a1', 'done');

    await expect(s.receive(msg({ proposalId: 'a3', lamport: 3 }))).resolves.toBe('accepted-new');
    expect(s.list().map(r => r.proposalId).sort()).toEqual(['a2', 'a3']);
    // The prune reached disk; the pre-write merge must not re-adopt it.
    expect(Object.keys(rawItems(store)).sort()).toEqual([K(ALICE, 'a2'), K(ALICE, 'a3')]);
  });

  it('counts the cap per peer, so one peer arriving cannot shed another finished work', async () => {
    // The trim runs on the ARRIVING peer's own records. Counting globally
    // would make an unrelated peer's first proposal evict Bob's history, which
    // is a cross-peer eviction primitive dressed up as a storage bound.
    const s = make(new FakeStore(), { ...LIMITS, maxPerPeer: 2 });
    await s.receive(msg({ proposalId: 'b1', fromPeerId: BOB, lamport: 1 }));
    await s.receive(msg({ proposalId: 'b2', fromPeerId: BOB, lamport: 2 }));
    await s.setState(BOB, 'b1', 'done');

    await s.receive(msg({ proposalId: 'a1', fromPeerId: ALICE, lamport: 1 }));

    expect(s.followupFor(BOB).items.map(i => i.proposalId)).toEqual(['b1', 'b2']);
  });

  it('refuses a flood rather than shedding LIVE records', async () => {
    const s = make(new FakeStore(), { ...LIMITS, maxPerPeer: 2 });
    await s.receive(msg({ proposalId: 'a1', lamport: 1 }));
    await s.receive(msg({ proposalId: 'a2', lamport: 2 }));
    await expect(s.receive(msg({ proposalId: 'a3', lamport: 3 }))).rejects.toThrow(/quota/);
    expect(s.list().map(r => r.proposalId).sort()).toEqual(['a1', 'a2']);
  });

  it('counts an ACCEPTED record as live, so accepted work is never shed', async () => {
    const s = make(new FakeStore(), { ...LIMITS, maxPerPeer: 2 });
    await s.receive(msg({ proposalId: 'a1', lamport: 1 }));
    await s.receive(msg({ proposalId: 'a2', lamport: 2 }));
    await s.setState(ALICE, 'a1', 'accepted');
    await expect(s.receive(msg({ proposalId: 'a3', lamport: 3 }))).rejects.toThrow(/quota/);
    expect(s.list().find(r => r.proposalId === 'a1')!.state).toBe('accepted');
  });

  it('never evicts another peer records', async () => {
    const s = make(new FakeStore(), { ...LIMITS, maxPerPeer: 2 });
    await s.receive(msg({ proposalId: 'b1', fromPeerId: BOB, lamport: 1 }));
    await s.receive(msg({ proposalId: 'a1', fromPeerId: ALICE, lamport: 1 }));
    await s.receive(msg({ proposalId: 'a2', fromPeerId: ALICE, lamport: 2 }));
    await expect(s.receive(msg({ proposalId: 'a3', fromPeerId: ALICE, lamport: 3 }))).rejects.toThrow(/quota/);
    expect(s.followupFor(BOB).items.map(i => i.proposalId)).toEqual(['b1']);
  });
});

// ---------------------------------------------------------------------------
describe('limits are clamped at the constructor boundary', () => {
  it('survives the explicit-undefined spread bug', () => {
    // This is exactly what `cfg.get<number>('unset.key')` yields for every
    // field, and what `{ ...DEFAULTS, ...opts }` would turn into NaN.
    expect(resolveDeskProposalLimits({
      minLeaseMs: undefined,
      maxLeaseMs: undefined,
      defaultLeaseMs: undefined,
      maxPerPeer: undefined,
      pageSize: undefined,
    })).toEqual(DESK_PROPOSAL_DEFAULT_LIMITS);
  });

  it('rejects NaN, Infinity, zero, negatives and non-numbers', () => {
    expect(resolveDeskProposalLimits({
      minLeaseMs: Number.NaN,
      maxLeaseMs: Number.POSITIVE_INFINITY,
      defaultLeaseMs: 0,
      maxPerPeer: -5,
      pageSize: '50' as unknown as number,
    })).toEqual(DESK_PROPOSAL_DEFAULT_LIMITS);
  });

  it('repairs a jointly nonsensical min/max by LOWERING the floor, never raising the ceiling', async () => {
    // Direction is the whole point. `min > max` is ambiguous, and resolving it
    // upwards turns one mistyped floor into an unbounded ceiling - a typo in
    // the field that bounds nothing switching off the field that bounds
    // everything.
    const resolved = resolveDeskProposalLimits({ minLeaseMs: 90_000, maxLeaseMs: 1_000, defaultLeaseMs: 10 });
    expect(resolved.maxLeaseMs).toBe(1_000);
    expect(resolved.minLeaseMs).toBe(1_000);
    expect(resolved.defaultLeaseMs).toBe(1_000);

    const huge = resolveDeskProposalLimits({ minLeaseMs: 1e15 });
    expect(huge.maxLeaseMs).toBe(DESK_PROPOSAL_DEFAULT_LIMITS.maxLeaseMs);
    expect(huge.minLeaseMs).toBe(DESK_PROPOSAL_DEFAULT_LIMITS.maxLeaseMs);

    // ...and no configuration produces an immortal card.
    const store = new FakeStore();
    const s = new DeskProposalStore(store, now, { minLeaseMs: 1e15 });
    await s.receive(msg({ leaseMs: 1 }));
    expect(s.list()[0].leaseMs).toBeLessThanOrEqual(DESK_PROPOSAL_LEASE_HARD_CEILING_MS);
    clock = T0 + DESK_PROPOSAL_LEASE_HARD_CEILING_MS + 1;
    expect(await s.expireLeases()).toBe(1);
  });

  it('caps even an explicitly configured ceiling', () => {
    expect(resolveDeskProposalLimits({ maxLeaseMs: 1e15 }).maxLeaseMs).toBe(DESK_PROPOSAL_LEASE_HARD_CEILING_MS);
    expect(resolveDeskProposalLimits({ maxLeaseMs: 1e15, defaultLeaseMs: 1e15 }).defaultLeaseMs)
      .toBe(DESK_PROPOSAL_LEASE_HARD_CEILING_MS);
  });

  it('floors a fractional count, but never to zero', () => {
    expect(resolveDeskProposalLimits({ maxPerPeer: 2.9 }).maxPerPeer).toBe(2);
    expect(resolveDeskProposalLimits({ pageSize: 1.9 }).pageSize).toBe(1);
    // Below one is the case that changes the program rather than trimming it:
    // pageSize 0 indexes page[-1] for a cursor, and maxPerPeer 0 refuses every
    // proposal from every peer forever.
    expect(resolveDeskProposalLimits({ pageSize: 0.9 }).pageSize).toBe(1);
    expect(resolveDeskProposalLimits({ maxPerPeer: 0.9 }).maxPerPeer).toBe(1);
  });

  it('answers a followup under a sub-one page size instead of throwing at the peer', async () => {
    const s = make(new FakeStore(), { ...LIMITS, pageSize: 0.9, maxPerPeer: 0.9 });
    expect(await s.receive(msg({ proposalId: 'a1', lamport: 1 }))).toBe('accepted-new');
    const page = s.followupFor(ALICE);
    expect(page.items.map(i => i.proposalId)).toEqual(['a1']);
    expect(page.nextCursor).toBeUndefined();
    expect(s.followupFor(BOB)).toEqual({ items: [] });
  });

  it('keeps limiting when a NaN limit reaches the constructor', async () => {
    const s = new DeskProposalStore(new FakeStore(), now, { maxLeaseMs: Number.NaN, pageSize: Number.NaN });
    await s.receive(msg({ leaseMs: 1e18 }));
    // Clamped to the DEFAULT ceiling, not left unbounded.
    expect(s.list()[0].leaseMs).toBe(DESK_PROPOSAL_DEFAULT_LIMITS.maxLeaseMs);
  });
});

// ---------------------------------------------------------------------------
describe('helpers', () => {
  it('isProposalState refuses prototype keys and near-misses', () => {
    expect(isProposalState('proposed')).toBe(true);
    expect(isProposalState('expired')).toBe(true);
    expect(isProposalState('constructor')).toBe(false);
    expect(isProposalState('hasOwnProperty')).toBe(false);
    expect(isProposalState(undefined)).toBe(false);
  });

  it('toWire carries no local decision across the boundary', async () => {
    const s = make(new FakeStore());
    await s.receive(msg());
    await s.setState(ALICE, 'p001', 'declined');
    const wire = DeskProposalStore.toWire(s.list()[0]) as Record<string, unknown>;
    expect(wire.state).toBeUndefined();
    expect(wire.createdAt).toBe(T0);
  });

  it('coarsens the arrival time it sends back, so a peer cannot time the expiry', async () => {
    // `createdAt` is this machine's Date.now() at arrival: a skew fingerprint
    // and the exact lease anchor. With the clamped duration - which the sender
    // proposed and can read back - the precise local expiry instant follows.
    const s = make(new FakeStore());
    clock = T0 + 1_234_567;
    await s.receive(msg({ leaseMs: 5_000 }));
    const rec = s.list()[0];
    expect(rec.receivedAt).toBe(T0 + 1_234_567);
    expect(DeskProposalStore.toWire(rec).createdAt).toBe(T0);
    expect(DeskProposalStore.toWire(rec).createdAt).not.toBe(rec.receivedAt);
  });
});
