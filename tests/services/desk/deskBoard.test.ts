/**
 * DeskBoard tests (Plan 21, invariants I18/I19/I20).
 *
 * The headline property is PERMUTATION INVARIANCE: the same events in any
 * order produce the same state. That is what makes an unreliable transport
 * acceptable — a reordered or duplicated delivery degrades nothing.
 *
 * The second is that a lamport arriving from a peer is not believed
 * unconditionally. A member sending 2^40 would otherwise win every future race
 * with a perfectly valid signature.
 */
import { describe, it, expect } from 'vitest';
import {
  LAMPORT_MAX_JUMP,
  LEASE_DEFAULT_MS,
  LEASE_MAX_MS,
  fold,
  renderStandup,
} from '../../../src/services/desk/DeskBoard';
import type { BoardEvent } from '../../../src/services/desk/DeskBoard';

const NOW = 1_800_000_000_000;

function ev(over: Partial<BoardEvent> & Pick<BoardEvent, 'eventId' | 'taskId' | 'kind'>): BoardEvent {
  return {
    peerId: 'p_alice',
    lamport: 1,
    generation: 0,
    receivedAt: NOW,
    ...over,
  } as BoardEvent;
}

/** Every permutation of a small array. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) { return [items]; }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) { out.push([items[i], ...p]); }
  }
  return out;
}

describe('fold — permutation invariance', () => {
  const events = [
    ev({ eventId: 'e1', taskId: 't1', kind: 'propose', lamport: 1, title: 'Migrate billing' }),
    ev({ eventId: 'e2', taskId: 't1', kind: 'claim', lamport: 2, peerId: 'p_bob', leaseMs: 60_000 }),
    ev({ eventId: 'e3', taskId: 't2', kind: 'propose', lamport: 2, title: 'Update docs' }),
    ev({ eventId: 'e4', taskId: 't1', kind: 'complete', lamport: 3, peerId: 'p_bob' }),
  ];

  it('produces identical state for all 24 orderings', () => {
    const canonical = JSON.stringify(fold(events, NOW));
    for (const perm of permutations(events)) {
      expect(JSON.stringify(fold(perm, NOW))).toBe(canonical);
    }
  });

  it('is unaffected by duplicates — at-least-once delivery is expected', () => {
    const once = fold(events, NOW);
    const twice = fold([...events, ...events], NOW);
    expect(twice.tasks).toEqual(once.tasks);
  });

  it('a missing event degrades completeness, never correctness', () => {
    const partial = fold(events.filter(e => e.eventId !== 'e4'), NOW);
    expect(partial.tasks.find(t => t.taskId === 't1')?.state).toBe('claimed');
    // Still a coherent board, just an earlier one.
    expect(partial.rejected).toEqual([]);
  });

  it('output ordering is deterministic, not insertion-dependent', () => {
    const a = fold([events[2], events[0]], NOW).tasks.map(t => t.taskId);
    const b = fold([events[0], events[2]], NOW).tasks.map(t => t.taskId);
    expect(a).toEqual(['t1', 't2']);
    expect(b).toEqual(['t1', 't2']);
  });
});

describe('fold — lamport is not believed unconditionally', () => {
  it('drops an inflated lamport rather than letting it win forever', () => {
    const state = fold([
      ev({ eventId: 'e1', taskId: 't1', kind: 'propose', lamport: 1, title: 'Real' }),
      ev({ eventId: 'e2', taskId: 't1', kind: 'claim', lamport: 2 ** 40, peerId: 'p_evil' }),
    ], NOW);
    expect(state.tasks[0].state).toBe('open');
    expect(state.rejected.map(r => r.reason)).toContain('lamport-jump');
  });

  it('accepts a jump exactly at the cap and drops one past it', () => {
    const atCap = fold([
      ev({ eventId: 'e1', taskId: 't1', kind: 'propose', lamport: 0, title: 'T' }),
      ev({ eventId: 'e2', taskId: 't1', kind: 'claim', lamport: LAMPORT_MAX_JUMP, peerId: 'p_b' }),
    ], NOW);
    expect(atCap.rejected).toEqual([]);

    const pastCap = fold([
      ev({ eventId: 'e1', taskId: 't1', kind: 'propose', lamport: 0, title: 'T' }),
      ev({ eventId: 'e2', taskId: 't1', kind: 'claim', lamport: LAMPORT_MAX_JUMP + 1, peerId: 'p_b' }),
    ], NOW);
    expect(pastCap.rejected.map(r => r.reason)).toContain('lamport-jump');
  });

  it('rejects a negative or non-finite lamport', () => {
    const state = fold([
      ev({ eventId: 'e1', taskId: 't1', kind: 'propose', lamport: -1 }),
      ev({ eventId: 'e2', taskId: 't2', kind: 'propose', lamport: NaN }),
    ], NOW);
    expect(state.rejected.map(r => r.reason)).toEqual(['lamport-invalid', 'lamport-invalid']);
  });

  it('surfaces every drop rather than discarding it silently', () => {
    const state = fold([
      ev({ eventId: 'e1', taskId: 't1', kind: 'propose', lamport: 1 }),
      ev({ eventId: 'e2', taskId: 't1', kind: 'claim', lamport: 99_999 }),
    ], NOW);
    expect(state.rejected).toHaveLength(1);
    expect(state.rejected[0].eventId).toBe('e2');
  });
});

describe('fold — claim arbitration converges', () => {
  it('two peers claiming the same task yield one deterministic winner', () => {
    const a = ev({ eventId: 'e-a', taskId: 't1', kind: 'claim', lamport: 5, peerId: 'p_alice' });
    const b = ev({ eventId: 'e-b', taskId: 't1', kind: 'claim', lamport: 5, peerId: 'p_bob' });

    const one = fold([a, b], NOW).tasks[0].owner;
    const two = fold([b, a], NOW).tasks[0].owner;
    expect(one).toBe(two);
    expect(one).toBe('p_bob'); // lexicographic tie-break on peerId
  });

  it('a higher lamport wins regardless of order', () => {
    const lo = ev({ eventId: 'e1', taskId: 't1', kind: 'claim', lamport: 3, peerId: 'p_alice' });
    const hi = ev({ eventId: 'e2', taskId: 't1', kind: 'claim', lamport: 4, peerId: 'p_bob' });
    expect(fold([lo, hi], NOW).tasks[0].owner).toBe('p_bob');
    expect(fold([hi, lo], NOW).tasks[0].owner).toBe('p_bob');
  });

  it('a higher generation supersedes regardless of lamport', () => {
    const old = ev({ eventId: 'e1', taskId: 't1', kind: 'claim', lamport: 100, generation: 0, peerId: 'p_a' });
    const neu = ev({ eventId: 'e2', taskId: 't1', kind: 'release', lamport: 1, generation: 1, peerId: 'p_b' });
    expect(fold([old, neu], NOW).tasks[0].state).toBe('open');
    expect(fold([neu, old], NOW).tasks[0].state).toBe('open');
  });

  it('records a claim that lost to a rival claim', () => {
    // Not an error — "two people claimed this" is real information for a
    // standup. The winner is deterministic; the loser is reported.
    const state = fold([
      ev({ eventId: 'e-a', taskId: 't1', kind: 'claim', lamport: 5, peerId: 'p_alice' }),
      ev({ eventId: 'e-b', taskId: 't1', kind: 'claim', lamport: 6, peerId: 'p_bob' }),
    ], NOW);
    expect(state.tasks[0].owner).toBe('p_bob');
    expect(state.rejected).toEqual([{ eventId: 'e-a', reason: 'lost-arbitration' }]);
  });

  it('does not report a peer re-claiming its own task as a loss', () => {
    const state = fold([
      ev({ eventId: 'e-a', taskId: 't1', kind: 'claim', lamport: 5, peerId: 'p_alice' }),
      ev({ eventId: 'e-b', taskId: 't1', kind: 'claim', lamport: 6, peerId: 'p_alice' }),
    ], NOW);
    expect(state.rejected).toEqual([]);
  });
});

describe('fold — leases expire on the observer clock', () => {
  const claim = ev({
    eventId: 'e1', taskId: 't1', kind: 'claim',
    peerId: 'p_bob', leaseMs: 60_000, receivedAt: NOW, title: 'Long task',
  });

  it('holds the claim while the lease is live', () => {
    const state = fold([claim], NOW + 30_000);
    expect(state.tasks[0].state).toBe('claimed');
    expect(state.tasks[0].owner).toBe('p_bob');
  });

  it('frees the task once the lease elapses — no reaper, no heartbeat', () => {
    const state = fold([claim], NOW + 60_001);
    expect(state.tasks[0].state).toBe('failed');
    expect(state.tasks[0].owner).toBeNull();
  });

  it('expires at the boundary inclusively', () => {
    expect(fold([claim], NOW + 60_000).tasks[0].state).toBe('failed');
    expect(fold([claim], NOW + 59_999).tasks[0].state).toBe('claimed');
  });

  it('computes expiry from LOCAL arrival, not a sender-chosen epoch', () => {
    // The same event observed later expires later: a peer with a skewed clock
    // cannot hold a claim indefinitely.
    const late = { ...claim, receivedAt: NOW + 100_000 };
    expect(fold([late], NOW + 120_000).tasks[0].state).toBe('claimed');
  });

  it('a completed task is not affected by lease expiry', () => {
    const done = ev({ eventId: 'e2', taskId: 't1', kind: 'complete', lamport: 2, peerId: 'p_bob' });
    expect(fold([claim, done], NOW + 999_999).tasks[0].state).toBe('done');
  });
});

describe('renderStandup — deterministic and model-free', () => {
  const events = [
    ev({ eventId: 'e1', taskId: 't1', kind: 'complete', lamport: 2, title: 'Ship retry fix' }),
    ev({ eventId: 'e2', taskId: 't2', kind: 'claim', lamport: 2, peerId: 'p_bob', leaseMs: 600_000, title: 'Migrate billing' }),
    ev({ eventId: 'e3', taskId: 't3', kind: 'propose', lamport: 1, title: 'Update docs' }),
  ];

  it('is byte-identical across runs and orderings', () => {
    const a = renderStandup(fold(events, NOW), NOW);
    const b = renderStandup(fold([...events].reverse(), NOW), NOW);
    expect(a).toBe(b);
  });

  it('groups by state with counts', () => {
    const out = renderStandup(fold(events, NOW), NOW);
    expect(out).toContain('### Done (1)');
    expect(out).toContain('Ship retry fix');
    expect(out).toContain('### In progress (1)');
    expect(out).toContain('Migrate billing');
    expect(out).toContain('### Open (1)');
    expect(out).toContain('Update docs');
  });

  it('shows remaining lease time for in-flight work', () => {
    expect(renderStandup(fold(events, NOW), NOW)).toContain('lease 10m left');
  });

  it('reads sensibly with no events at all', () => {
    const out = renderStandup(fold([], NOW), NOW);
    expect(out).toContain('nothing yet');
    expect(out).toContain('nothing in flight');
    expect(out).toContain('nothing open');
  });

  it('surfaces dropped events instead of hiding them', () => {
    const state = fold([
      ev({ eventId: 'e1', taskId: 't1', kind: 'propose', lamport: 1, title: 'T' }),
      ev({ eventId: 'e2', taskId: 't1', kind: 'claim', lamport: 2 ** 40 }),
    ], NOW);
    expect(renderStandup(state, NOW)).toContain('1 event(s) dropped');
    expect(renderStandup(state, NOW)).toContain('lamport-jump');
  });

  it('calls out work that needs attention', () => {
    const stale = ev({ eventId: 'e1', taskId: 't1', kind: 'claim', leaseMs: 1000, title: 'Stalled' });
    expect(renderStandup(fold([stale], NOW + 5000), NOW + 5000)).toContain('### Needs attention (1)');
  });
});

// ---------------------------------------------------------------------------
// `leaseMs` arrives on the wire, so it is a sender-chosen number — and I17 says
// a sender-chosen number must never bound anything. Infinity and NaN both made
// the expiry test (`now >= claimedAt + leaseMs`) false forever, so a peer could
// hold a task permanently with one field: the blocked-frontier failure leases
// exist to prevent.
// ---------------------------------------------------------------------------
describe('fold — a wire-supplied lease cannot buy an immortal claim', () => {
  const hostile = (leaseMs: number | undefined) => ev({
    eventId: 'e1', taskId: 't1', kind: 'claim',
    peerId: 'p_bob', title: 'Held forever', receivedAt: NOW,
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });

  for (const [label, value] of [
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -1],
    ['absurdly long', Number.MAX_SAFE_INTEGER],
  ] as Array<[string, number]>) {
    it(`expires a claim whose lease is ${label}`, () => {
      const state = fold([hostile(value)], NOW + LEASE_MAX_MS + 1);
      expect(state.tasks[0].state, `${label} must not hold the task`).toBe('failed');
      expect(state.tasks[0].owner).toBeNull();
    });
  }

  it('gives a MALFORMED lease the short default, never the ceiling', () => {
    // Falling back to the maximum would mean nonsense input buys MORE hold
    // than well-formed input.
    for (const bad of [NaN, 0, -1, Infinity * 0]) {
      const state = fold([hostile(bad)], NOW);
      expect(state.tasks[0].leaseExpiresAt, String(bad)).toBe(NOW + LEASE_DEFAULT_MS);
    }
  });

  it('caps an over-long lease at the ceiling rather than honouring it', () => {
    const state = fold([hostile(LEASE_MAX_MS * 100)], NOW);
    expect(state.tasks[0].leaseExpiresAt).toBe(NOW + LEASE_MAX_MS);
  });

  it('honours an ordinary lease unchanged', () => {
    const state = fold([hostile(60_000)], NOW);
    expect(state.tasks[0].leaseExpiresAt).toBe(NOW + 60_000);
  });

  it('CLAMPS rather than drops, so a malformed claim cannot delete a rival one', () => {
    // Dropping the event would hand a peer a way to erase a legitimate claim by
    // following it with a malformed one.
    const state = fold([hostile(Infinity)], NOW);
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].state).toBe('claimed');
    expect(state.tasks[0].owner).toBe('p_bob');
  });
});
