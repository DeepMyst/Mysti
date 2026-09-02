/**
 * DeskStandup tests (Plan 21 Phase 6, invariants I19/I21/I12).
 *
 * The digest is a rendering surface fed entirely by untrusted strings, so the
 * tests below are adversarial rather than illustrative. Three properties carry
 * the module:
 *
 *  1. BYTE-IDENTICAL output for the same event set in any ordering - otherwise
 *     two people reading "the same" standup are not reading the same thing.
 *  2. A peer-supplied title cannot escape its line (fence escape) nor
 *     impersonate the line's own syntax (attribution spoofing).
 *  3. Every numeric boundary fails closed. A NaN `now` is the exact bug class
 *     that silently disabled limits elsewhere in this plan: every comparison
 *     against it is false, so nothing expires and nothing is capped.
 *
 * Every control, bidi and zero-width character below is written as a `\uXXXX`
 * ESCAPE, never as a literal: a literal one is invisible in review, and a
 * literal NUL makes git treat this file as binary and drop it from the diff.
 *
 * Fixtures are chosen to DISCRIMINATE, not to illustrate. Several tests below
 * carry a "guard the guard" assertion showing that the fixture would fail
 * under the mutation the test exists to catch (locale sorting, split-by-code-
 * unit iteration, a deleted dedupe) - a fixture that passes either way pins
 * nothing, however adversarial its name.
 *
 * TYPES are part of the adversary. A board event is JSON off a socket, so
 * `title: string` in the interface is a claim about honest peers and nothing
 * more; the `as unknown as` casts below are how a wire payload actually
 * arrives, not test cheating.
 */
import { describe, it, expect } from 'vitest';
import { computeStandup, renderTeamStandup } from '../../src/managers/DeskStandup';
import type { StandupInput, StandupSection } from '../../src/managers/DeskStandup';
import type { BoardEvent } from '../../src/services/desk/DeskBoard';
import { LIMITS, hasUnsafeChars } from '../../src/services/desk/DeskContract';

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

function render(inputs: StandupInput[], now = NOW): string {
  return renderTeamStandup(computeStandup(inputs, now), now);
}

describe('DeskStandup - determinism', () => {
  const alice: StandupInput = {
    peerAlias: 'alice',
    events: [
      ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'ship the parser' }),
      ev({ eventId: 'e2', taskId: 't1', kind: 'complete', generation: 1, lamport: 2 }),
      ev({ eventId: 'e3', taskId: 't2', kind: 'propose', title: 'fix lease math' }),
    ],
  };
  const bob: StandupInput = {
    peerAlias: 'bob',
    events: [
      ev({ eventId: 'e4', taskId: 't3', kind: 'propose', title: 'audit the redactor', peerId: 'p_bob' }),
      ev({
        eventId: 'e5', taskId: 't3', kind: 'claim', generation: 1, lamport: 2,
        peerId: 'p_bob', leaseMs: 600_000,
      }),
    ],
  };

  it('is byte-identical when the peers arrive in a different order', () => {
    expect(render([alice, bob])).toBe(render([bob, alice]));
  });

  it('is byte-identical when each peer events arrive in a different order', () => {
    const shuffled: StandupInput[] = [
      { peerAlias: 'bob', events: [...bob.events].reverse() },
      { peerAlias: 'alice', events: [alice.events[2], alice.events[0], alice.events[1]] },
    ];
    expect(render(shuffled)).toBe(render([alice, bob]));
  });

  it('does not read an ambient clock, by ANY spelling of one', () => {
    // Stubbing `Date.now` alone left `new Date()`, `new Date().getTime()` and
    // `performance.now()` live, so the mutation that swapped the injected
    // `now` for one of those was killed only by luck. Every ambient clock in
    // scope is moved here, and moved to two different instants.
    const RealDate = globalThis.Date;
    const realPerf = globalThis.performance;
    const install = (fake: number): void => {
      class FakeDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) { super(fake); } else { super(...(args as [number])); }
        }
        static now(): number { return fake; }
      }
      globalThis.Date = FakeDate as unknown as DateConstructor;
      globalThis.performance = { now: () => fake } as unknown as Performance;
    };
    try {
      install(1);
      const early = render([alice, bob]);
      install(9_999_999_999_999);
      expect(render([alice, bob])).toBe(early);
      // Guard the guard: the fixture must actually render a clock-sensitive
      // value, or "unchanged" would be vacuous.
      expect(early).toContain('(lease 10m left)');
    } finally {
      globalThis.Date = RealDate;
      globalThis.performance = realPerf;
    }
  });

  it('merges two inputs that carry the same alias instead of emitting two sections', () => {
    const split: StandupInput[] = [
      { peerAlias: 'alice', events: [alice.events[0]] },
      { peerAlias: 'alice', events: [alice.events[1], alice.events[2]] },
    ];
    const sections = computeStandup(split, NOW);
    expect(sections).toHaveLength(1);
    // Order-independent, because the fold deduplicates and sorts internally.
    expect(render(split)).toBe(render([{ peerAlias: 'alice', events: alice.events }]));
    expect(render([split[1], split[0]])).toBe(render(split));
  });

  it('deduplicates a re-delivered event across merged inputs', () => {
    const dup: StandupInput[] = [
      { peerAlias: 'alice', events: alice.events },
      { peerAlias: 'alice', events: [alice.events[0], alice.events[0]] },
    ];
    const [section] = computeStandup(dup, NOW);
    expect(section.done).toEqual(['"ship the parser"']);
    expect(section.open).toEqual(['"fix lease math"']);
  });

  it('sorts sections by code unit, never by locale', () => {
    // 'a-b' vs 'aaa' does NOT discriminate: ICU orders them the same way code
    // units do, so the original fixture stayed green with `localeCompare`
    // swapped in. An uppercase and a dotted alias both fail validateAlias and
    // become '!B' and '!a.', which the two orders disagree about.
    const sections = computeStandup(
      [{ peerAlias: 'zoe', events: [] }, { peerAlias: 'a.', events: [] }, { peerAlias: 'B', events: [] }],
      NOW,
    );
    expect(sections.map(s => s.peerAlias)).toEqual(['!B', '!a.', 'zoe']);
    // Guard the guard: the fixture is only a test because locale disagrees.
    expect('!B'.localeCompare('!a.')).toBeGreaterThan(0);
    expect('!B' < '!a.').toBe(true);
  });

  it('orders a bucket by the fold task order, never by the rendered title', () => {
    // The module skips a re-sort because `fold` already returns tasks ordered
    // by taskId. Titles that sort the other way are what makes that visible.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'zebra' }),
        ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'apple' }),
      ],
    }], NOW);
    expect(section.open).toEqual(['"zebra"', '"apple"']);
  });

  it('renders one canonical byte form, with no trailing blank line', () => {
    const out = render([
      {
        peerAlias: 'alice',
        events: [
          ev({ eventId: 'e1', taskId: 't2', kind: 'propose', title: 'apple' }),
          ev({ eventId: 'e2', taskId: 't1', kind: 'propose', title: 'zebra' }),
          ev({ eventId: 'e3', taskId: 't3', kind: 'propose', title: 'shipped' }),
          ev({ eventId: 'e4', taskId: 't3', kind: 'complete', generation: 1, lamport: 2 }),
        ],
      },
      {
        peerAlias: 'bob',
        events: [
          ev({ eventId: 'e5', taskId: 't4', kind: 'propose', title: 'held', peerId: 'p_bob' }),
          ev({
            eventId: 'e6', taskId: 't4', kind: 'claim', generation: 1, lamport: 2,
            peerId: 'p_bob', leaseMs: 600_000,
          }),
        ],
      },
    ]);
    // A golden: byte-identity is the module's headline claim, so exactly one
    // string is acceptable - including the absence of the trailing blank line
    // the last bucket pushes.
    expect(out).toBe([
      '## Team standup',
      '',
      '_2 peer(s)._',
      '',
      '### alice',
      '',
      '**Done (1)**',
      '- "shipped"',
      '',
      '**In progress (0)**',
      '- nothing in flight',
      '',
      '**Open (2)**',
      '- "zebra"',
      '- "apple"',
      '',
      '### bob',
      '',
      '**Done (0)**',
      '- nothing yet',
      '',
      '**In progress (1)**',
      '- "held" - "p_bob" (lease 10m left)',
      '',
      '**Open (0)**',
      '- nothing open',
    ].join('\u000A'));
    expect(out.endsWith('\u000A')).toBe(false);
  });
});

describe('DeskStandup - empty and quiet states', () => {
  it('renders a sensible digest for an empty roster', () => {
    const out = renderTeamStandup([], NOW);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('## Team standup');
    expect(out).toContain('_No peers on the roster._');
  });

  it('renders a peer with no events without inventing work', () => {
    const out = render([{ peerAlias: 'alice', events: [] }]);
    expect(out).toContain('### alice');
    expect(out).toContain('**Done (0)**');
    expect(out).toContain('- nothing yet');
    expect(out).toContain('- nothing in flight');
    expect(out).toContain('- nothing open');
    // A quiet peer must not grow an attention bucket.
    expect(out).not.toContain('Needs attention');
  });
});

describe('DeskStandup - untrusted strings cannot escape their line', () => {
  it('escapes a newline in a peer title so it cannot forge a heading or a bucket', () => {
    const out = render([{
      peerAlias: 'alice',
      events: [ev({
        eventId: 'e1', taskId: 't1', kind: 'propose',
        title: 'ok\u000A### mallory\u000A**Done (99)**\u000A- owned',
      })],
    }]);
    // The forged text survives as VISIBLE, escaped bytes on one line - that is
    // the point of escaping over dropping. What must not survive is its
    // STRUCTURE, so every assertion here is line-anchored.
    const lines = out.split('\u000A');
    expect(lines).not.toContain('### mallory');
    expect(lines).not.toContain('**Done (99)**');
    expect(lines).not.toContain('- owned');
    expect(lines.filter(l => l.startsWith('### '))).toEqual(['### alice']);
    expect(out).toContain('\\u000A');
  });

  it('escapes bidi overrides and zero-width characters', () => {
    const out = render([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'a\u202Eb\u200Bc\u2069d' })],
    }]);
    expect(out).not.toContain('\u202E');
    expect(out).not.toContain('\u200B');
    expect(out).not.toContain('\u2069');
    expect(out).toContain('\\u202E');
    expect(out).toContain('\\u200B');
    expect(out).toContain('\\u2069');
  });

  it('escapes a NUL rather than passing it through', () => {
    const [section] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'a\u0000b' })] }],
      NOW,
    );
    expect(section.open).toEqual(['"a\\u0000b"']);
  });

  it('keeps an astral character intact instead of splitting the surrogate pair', () => {
    const [section] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'x\u{1F600}y' })] }],
      NOW,
    );
    expect(section.open).toEqual(['"x\u{1F600}y"']);
  });

  it('escapes a LONE surrogate, which is what makes code-point iteration observable', () => {
    // Without this, "iteration is by code point" had no consequence: split by
    // code unit, both halves matched no unsafe class and were re-concatenated
    // byte-identically, so the invariant was decorative. A lone surrogate is
    // in the escape class, so splitting a pair now changes the output.
    const [section] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'x\uD83Dy' })] }],
      NOW,
    );
    expect(section.open).toEqual(['"x\\uD83Dy"']);
    // ...and the intact pair above must NOT be escaped, or the escape would
    // simply be swallowing every emoji.
    const [ok] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: '\u{1F600}' })] }],
      NOW,
    );
    expect(ok.open).toEqual(['"\u{1F600}"']);
  });

  it('prevents in-line attribution spoofing through a quote in the title', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'fix" - "root' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 600_000 }),
      ],
    }], NOW);
    // Exactly two quote-delimited spans on the line: the title and the owner.
    const line = section.inProgress[0];
    expect(line.split('"').length - 1).toBe(4);
    expect(line).toContain('\\u0022');
    expect(line.endsWith('"p_alice" (lease 10m left)')).toBe(true);
  });

  it('escapes a backslash so an escape sequence cannot be forged', () => {
    const [section] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'a\\u0022b' })] }],
      NOW,
    );
    // The peer wrote the literal characters backslash-u-0-0-2-2; they must not
    // render as the delimiter.
    expect(section.open).toEqual(['"a\\\\u0022b"']);
  });

  it('escapes an owner id that carries a fence character', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'a' }),
        ev({
          eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2,
          peerId: 'p\u000Aroot', leaseMs: 600_000,
        }),
      ],
    }], NOW);
    expect(section.inProgress[0]).toContain('"p\\u000Aroot"');
    expect(section.inProgress[0]).not.toContain('\u000A');
  });
});

describe('DeskStandup - aliases', () => {
  it('marks an alias that fails validateAlias and escapes it', () => {
    const [section] = computeStandup([{ peerAlias: 'Al\u000Aice', events: [] }], NOW);
    expect(section.peerAlias).toBe('!Al\\u000Aice');
    expect(renderTeamStandup([section], NOW)).toContain('### !Al\\u000Aice');
  });

  it('keeps distinct invalid aliases in distinct sections', () => {
    const sections = computeStandup(
      [{ peerAlias: 'ALICE', events: [] }, { peerAlias: 'alice.', events: [] }, { peerAlias: '!ALICE', events: [] }],
      NOW,
    );
    expect(new Set(sections.map(s => s.peerAlias)).size).toBe(3);
  });

  it('never lets a junk record merge itself into a real peer section', () => {
    const sections = computeStandup(
      [{ peerAlias: 'alice', events: [] }, { peerAlias: 'alice\u200B', events: [] }],
      NOW,
    );
    expect(sections.map(s => s.peerAlias).sort()).toEqual(['!alice\\u200B', 'alice']);
  });
});

describe('DeskStandup - truncation is an error, never a flag (I21)', () => {
  it('refuses an over-long title whole rather than trimming it', () => {
    const title = 'SECRETMARKER' + 'x'.repeat(LIMITS.title);
    const out = render([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title })],
    }]);
    // No prefix of the original is presented as if it were the title.
    expect(out).not.toContain('SECRETMARKER');
    expect(out).toContain('[title refused:');
    expect(out).toContain(`exceeds ${LIMITS.title}`);
    expect(out).toContain('"t1"');
  });

  it('refuses only the offending item, so one peer cannot deny the digest', () => {
    const out = render([
      {
        peerAlias: 'alice',
        events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'y'.repeat(LIMITS.title + 1) })],
      },
      {
        peerAlias: 'bob',
        events: [ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'real work', peerId: 'p_bob' })],
      },
    ]);
    expect(out).toContain('"real work"');
    expect(out).toContain('[title refused:');
  });

  it('accepts a title exactly at the limit', () => {
    const title = 'z'.repeat(LIMITS.title);
    const [section] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title })] }],
      NOW,
    );
    expect(section.open).toEqual([`"${title}"`]);
  });
});

describe('DeskStandup - numeric boundaries fail closed', () => {
  it('refuses a NaN now in computeStandup', () => {
    expect(() => computeStandup([{ peerAlias: 'alice', events: [] }], Number.NaN)).toThrow(/finite/);
  });

  it('refuses a NaN now in renderTeamStandup', () => {
    expect(() => renderTeamStandup([], Number.NaN)).toThrow(/finite/);
  });

  it('refuses an infinite now', () => {
    expect(() => computeStandup([], Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => renderTeamStandup([], Number.NEGATIVE_INFINITY)).toThrow(/finite/);
  });

  it('refuses an undefined now, which is what an unset setting reads as', () => {
    expect(() => computeStandup([], undefined as unknown as number)).toThrow(/finite/);
  });

  it('surfaces a claim whose lease can never expire (NaN leaseMs)', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'pinned' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: Number.NaN }),
      ],
    }], NOW + 10 * 365 * 24 * 3_600_000);
    // The fold cannot expire it, so the digest must not let it look healthy.
    expect(section.inProgress[0]).toContain('(lease invalid)');
    expect(section.needsAttention.some(s => s.startsWith('[lease] '))).toBe(true);
    expect(section.inProgress[0]).not.toContain('NaN');
  });

  it('surfaces a claim with an infinite lease the same way', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'pinned' }),
        ev({
          eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2,
          leaseMs: Number.POSITIVE_INFINITY,
        }),
      ],
    }], NOW);
    expect(section.inProgress[0]).toContain('(lease invalid)');
    expect(section.needsAttention.some(s => s.startsWith('[lease] '))).toBe(true);
    expect(section.inProgress[0]).not.toContain('Infinity');
  });

  it('surfaces a claim whose lease is finite but implausible (1e300 ms)', () => {
    // `Number.isFinite` guarded the wrong property. 1e300 ms is finite, so the
    // task rendered as healthy in-progress with an exponent-notation remainder
    // and NOTHING in needs-attention: an indefinitely pinned task, hidden from
    // the only human who can unpin it.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'pinned' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 1e300 }),
      ],
    }], NOW);
    expect(section.inProgress[0]).toBe('"pinned" - "p_alice" (lease implausible)');
    expect(section.needsAttention.some(s => s.startsWith('[lease] '))).toBe(true);
    // The rendered remainder is bounded: no exponent form, no unbounded float.
    expect(section.inProgress[0]).not.toMatch(/e\+/);
  });

  it('surfaces a 31,000-year lease, which is the shape an attacker sends', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'pinned' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 1e15 }),
      ],
    }], NOW);
    expect(section.inProgress[0]).toContain('(lease implausible)');
    expect(section.needsAttention.some(s => s.startsWith('[lease] '))).toBe(true);
  });

  it('does not flag a long but plausible lease, so the bound cannot cry wolf', () => {
    // The failure mode of a plausibility bound is a false positive on real
    // work. Six days is long for a desk lease and must still read as healthy.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'long haul' }),
        ev({
          eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2,
          leaseMs: 6 * 24 * 3_600_000,
        }),
      ],
    }], NOW);
    expect(section.inProgress[0]).toBe('"long haul" - "p_alice" (lease 8640m left)');
    expect(section.needsAttention).toEqual([]);
  });

  it('rounds a nearly-expired lease to 0m rather than going negative', () => {
    // The negative branch is unreachable through computeStandup - `fold`
    // expires a past-due claim against the SAME `now` and it lands in needs
    // attention instead - so this pins the boundary that is reachable.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'almost up' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 60_000 }),
      ],
    }], NOW + 59_999);
    expect(section.inProgress[0]).toBe('"almost up" - "p_alice" (lease 0m left)');
    expect(section.needsAttention).toEqual([]);
  });

  it('leaves an honest lease alone', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'honest' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 600_000 }),
      ],
    }], NOW);
    expect(section.inProgress[0]).toContain('(lease 10m left)');
    expect(section.needsAttention).toEqual([]);
  });
});

describe('DeskStandup - attribution and surfacing', () => {
  it('attributes each task to the peer whose board reported it', () => {
    const sections = computeStandup([
      { peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'alice work' })] },
      {
        peerAlias: 'bob',
        events: [ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'bob work', peerId: 'p_bob' })],
      },
    ], NOW);
    expect(sections[0]).toMatchObject({ peerAlias: 'alice', open: ['"alice work"'] });
    expect(sections[1]).toMatchObject({ peerAlias: 'bob', open: ['"bob work"'] });
  });

  it('moves an expired lease into needs attention', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'stalled' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 60_000 }),
      ],
    }], NOW + 3_600_000);
    expect(section.inProgress).toEqual([]);
    expect(section.needsAttention).toEqual(['"stalled"']);
  });

  it('surfaces dropped events per peer, with their reasons', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'ok' }),
        // Lamport inflation: a valid signature over an absurd clock.
        ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'inflated', lamport: 2 ** 40 }),
      ],
    }], NOW);
    const dropped = section.needsAttention.find(s => s.startsWith('[dropped] '));
    expect(dropped).toBe('[dropped] 1 event(s): lamport-jump');
    expect(section.open).toEqual(['"ok"']);
  });

  it('deduplicates and sorts the dropped reasons instead of repeating them', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'ok' }),
        ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'a', lamport: 2 ** 40 }),
        ev({ eventId: 'e3', taskId: 't3', kind: 'propose', title: 'b', lamport: 2 ** 41 }),
      ],
    }], NOW);
    // Two events, one reason: the count is the events, the reason list is a
    // SET. Dropping the dedupe would print 'lamport-jump, lamport-jump', which
    // is a different digest for the same facts.
    expect(section.needsAttention.find(s => s.startsWith('[dropped] ')))
      .toBe('[dropped] 2 event(s): lamport-jump');
  });

  it('sorts two distinct dropped reasons by code unit', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'ok' }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 600_000 }),
        ev({
          eventId: 'e3', taskId: 't1', kind: 'claim', generation: 2, lamport: 3,
          peerId: 'p_bob', leaseMs: 600_000,
        }),
        ev({ eventId: 'e4', taskId: 't2', kind: 'propose', title: 'x', lamport: 2 ** 40 }),
      ],
    }], NOW);
    expect(section.needsAttention.find(s => s.startsWith('[dropped] ')))
      .toBe('[dropped] 2 event(s): lamport-jump, lost-arbitration');
  });

  it('renders only fold reasons drawn from a closed, safe vocabulary', () => {
    // The reason is escaped before rendering, but today `fold` emits three
    // fixed literals and no peer text, so that escape has nothing to do. This
    // pins the ASSUMPTION rather than the escape: if DeskBoard ever folds an
    // eventId or a peer string into a reason, this fails and points here.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1" - "forged', taskId: 't1', kind: 'propose', title: 'x', lamport: Number.NaN }),
        ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'y', lamport: 2 ** 40 }),
        ev({ eventId: 'e3', taskId: 't3', kind: 'propose', title: 'z' }),
        ev({ eventId: 'e4', taskId: 't3', kind: 'claim', generation: 1, lamport: 2, leaseMs: 600_000 }),
        ev({
          eventId: 'e5', taskId: 't3', kind: 'claim', generation: 2, lamport: 3,
          peerId: 'p_bob', leaseMs: 600_000,
        }),
      ],
    }], NOW);
    const dropped = section.needsAttention.find(s => s.startsWith('[dropped] '));
    const reasons = (dropped ?? '').replace(/^.*: /, '').split(', ');
    expect(reasons.length).toBeGreaterThan(1);
    for (const reason of reasons) { expect(reason).toMatch(/^[a-z-]+$/); }
  });

  it('does not pool one peer dropped events into another peer section', () => {
    const sections = computeStandup([
      {
        peerAlias: 'alice',
        events: [ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'inflated', lamport: 2 ** 40 })],
      },
      {
        peerAlias: 'bob',
        events: [ev({ eventId: 'e3', taskId: 't3', kind: 'propose', title: 'fine', peerId: 'p_bob' })],
      },
    ], NOW);
    expect(sections[0].needsAttention.some(s => s.startsWith('[dropped]'))).toBe(true);
    expect(sections[1].needsAttention).toEqual([]);
  });
});

describe('DeskStandup - renderTeamStandup is a second gate', () => {
  const base: StandupSection = { peerAlias: 'alice', done: [], inProgress: [], open: [], needsAttention: [] };

  it('refuses a hand-crafted section whose alias carries a control character', () => {
    expect(() => renderTeamStandup([{ ...base, peerAlias: 'al\u000Aice' }], NOW))
      .toThrow(/control\/bidi/);
  });

  it.each(['done', 'inProgress', 'open', 'needsAttention'] as const)(
    'refuses an unescaped control character in %s',
    field => {
      expect(() => renderTeamStandup([{ ...base, [field]: ['a\u000A### forged'] }], NOW))
        .toThrow(/control\/bidi/);
    },
  );

  it('refuses an unescaped bidi override', () => {
    expect(() => renderTeamStandup([{ ...base, done: ['a\u202Eb'] }], NOW)).toThrow(/control\/bidi/);
  });

  it('refuses a non-string item', () => {
    expect(() => renderTeamStandup([{ ...base, done: [42 as unknown as string] }], NOW)).toThrow(/must be a string/);
  });

  it('accepts everything computeStandup produces, including its refusals', () => {
    // The original fixture was a well-formed string title, so it never drove
    // the paths that actually reach the gate: the refusal markers, the alias
    // marker, an implausible lease note and the malformed counter.
    const sections = computeStandup([{
      peerAlias: 'Al\u000Aice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'a\u000A\u202E\u200B\u2060\u0022\\b' }),
        ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: ['x" - "y'] as unknown as string }),
        ev({ eventId: 'e3', taskId: 't3', kind: 'propose', title: 42 as unknown as string }),
        ev({ eventId: 'e4', taskId: 't4', kind: 'propose', title: 'z'.repeat(LIMITS.title + 1) }),
        ev({ eventId: 'e5', taskId: 't5', kind: 'propose', title: 'ok' }),
        ev({ eventId: 'e6', taskId: 't5', kind: 'claim', generation: 1, lamport: 2, leaseMs: 1e300 }),
        null as unknown as BoardEvent,
      ],
    }], NOW);
    expect(() => renderTeamStandup(sections, NOW)).not.toThrow();
    const out = renderTeamStandup(sections, NOW);
    expect(out).toContain('[title refused: not a string]');
    expect(out).toContain(`[title refused: ${LIMITS.title + 1} chars exceeds ${LIMITS.title}]`);
    expect(out).toContain('[malformed] 1 event(s) discarded before folding');
    expect(out).toContain('(lease implausible)');
  });

  it('refuses a section that is not an object', () => {
    for (const bad of [null, undefined, 42, 'alice', ['alice']]) {
      expect(() => renderTeamStandup([bad as unknown as StandupSection], NOW))
        .toThrow(/each section must be an object/);
    }
  });

  it.each(['done', 'inProgress', 'open', 'needsAttention'] as const)(
    'refuses a %s that is not an array, instead of inventing items from it',
    field => {
      // A two-character string rendered as '**Done (2)**' with two forged work
      // items, because a string has a `length` and iterates. A second gate
      // that fabricates counts is worse than no second gate.
      for (const bad of ['ab', { length: 0 }, undefined, 5]) {
        expect(() => renderTeamStandup([{ ...base, [field]: bad }] as unknown as StandupSection[], NOW))
          .toThrow(new RegExp(`${field} must be an array`));
      }
    },
  );

  it('never fabricates a bucket count from a non-array', () => {
    let out = '';
    try {
      out = renderTeamStandup([{ ...base, done: 'ab' }] as unknown as StandupSection[], NOW);
    } catch { /* the refusal itself is asserted above; this pins what is NOT rendered */ }
    expect(out).toBe('');
  });

  it('re-validates the alias on the render path, as I12 claims', () => {
    // The gate only looked for control characters, so a hand-assembled
    // section could name itself anything: '### mallory' rendered as a heading
    // and an uppercase alias impersonated a real peer unchallenged.
    expect(() => renderTeamStandup([{ ...base, peerAlias: '### mallory' }], NOW))
      .toThrow(/neither valid nor marked invalid/);
    expect(() => renderTeamStandup([{ ...base, peerAlias: 'ALICE' }], NOW))
      .toThrow(/neither valid nor marked invalid/);
    // A line separator inside the alias is caught by the character class first.
    expect(() => renderTeamStandup([{ ...base, peerAlias: 'x\u2028### forged' }], NOW))
      .toThrow(/control\/bidi/);
    // An oversized marked alias cannot become an oversized heading either.
    expect(() => renderTeamStandup([{ ...base, peerAlias: '!' + 'z'.repeat(500) }], NOW))
      .toThrow(/neither valid nor marked invalid/);
    // Both forms computeStandup can emit are still accepted.
    expect(() => renderTeamStandup([{ ...base, peerAlias: 'alice' }], NOW)).not.toThrow();
    expect(() => renderTeamStandup([{ ...base, peerAlias: '!Al\\u000Aice' }], NOW)).not.toThrow();
  });
});

describe('DeskStandup - input shape', () => {
  it('refuses a non-array input', () => {
    // Asserting only `TypeError` was vacuous: deleting BOTH Array.isArray
    // guards left this green, because "null is not iterable" is a TypeError
    // too. The message is what distinguishes the guard from the crash.
    expect(() => computeStandup(null as unknown as StandupInput[], NOW))
      .toThrow(/inputs must be an array/);
    expect(() => renderTeamStandup(null as unknown as StandupSection[], NOW))
      .toThrow(/sections must be an array/);
    expect(() => computeStandup('nope' as unknown as StandupInput[], NOW))
      .toThrow(/inputs must be an array/);
  });

  it('refuses an input whose events are not an array', () => {
    expect(() => computeStandup([{ peerAlias: 'alice', events: null as unknown as BoardEvent[] }], NOW))
      .toThrow(/events array/);
  });

  it('refuses an input whose alias is not a string', () => {
    expect(() => computeStandup([{ peerAlias: 7 as unknown as string, events: [] }], NOW))
      .toThrow(/peerAlias/);
  });
});

describe('DeskStandup - a wire event is JSON, so every TYPE is untrusted', () => {
  // `title: string` in the interface is a claim about honest peers. DeskBoard
  // copies `e.title` and `e.peerId` straight off the wire and DeskContract has
  // no board-event validator, so the casts below are how a payload actually
  // arrives - not test cheating.

  it('refuses an ARRAY title instead of emitting its elements raw', () => {
    // A `for..of` over a string[] tests each ELEMENT as one unit, so no
    // element equals '"' and the whole thing was emitted RAW: the line came
    // out with SIX quotes, which is exactly the attribution spoof the header
    // says cannot happen.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: ['fix" - "root'] as unknown as string }),
        ev({ eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2, leaseMs: 600_000 }),
      ],
    }], NOW);
    const line = section.inProgress[0];
    expect(line).toBe('[title refused: not a string] task "t1" - "p_alice" (lease 10m left)');
    // Exactly two quote-delimited spans survive: the task and the owner.
    expect(line.split('"').length - 1).toBe(4);
    expect(line).not.toContain('fix');
    expect(() => renderTeamStandup([section], NOW)).not.toThrow();
  });

  it('refuses an ARRAY owner rather than composing it into the line', () => {
    // peerId is an identity field, so a non-string one is not an identity at
    // all: the event is discarded before the fold and the discard is REPORTED,
    // rather than the array being spread across the attribution.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'x' }),
        ev({
          eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2,
          peerId: ['a" - "b'] as unknown as string, leaseMs: 600_000,
        }),
      ],
    }], NOW);
    const out = renderTeamStandup([section], NOW);
    expect(out).not.toContain('"a" - "b"');
    expect(section.inProgress).toEqual([]);
    expect(section.open).toEqual(['"x"']);
    expect(section.needsAttention).toContain('[malformed] 1 event(s) discarded before folding');
  });

  it('does not let one malformed title deny the whole team its digest', () => {
    // `title: 42` reached `_quote(42)` -> `for (const ch of 42)` -> TypeError,
    // which escaped computeStandup and destroyed every peer's section. I21
    // promises refusal is per ITEM; that promise is only true if it holds for
    // a malformed TYPE and not just a malformed LENGTH.
    const out = render([
      {
        peerAlias: 'alice',
        events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 42 as unknown as string })],
      },
      {
        peerAlias: 'bob',
        events: [ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'real work', peerId: 'p_bob' })],
      },
    ]);
    expect(out).toContain('"real work"');
    expect(out).toContain('[title refused: not a string] task "t1"');
  });

  it('refuses an object that merely LOOKS like a string', () => {
    // `{length: 999}` took a third path again: it passed the length test and
    // produced a bogus refusal naming a length nobody sent.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: { length: 999 } as unknown as string })],
    }], NOW);
    expect(section.open).toEqual(['[title refused: not a string] task "t1"']);
    expect(section.open[0]).not.toContain('999');
  });

  it('never renders a lossy one-character prefix of a malformed title', () => {
    // The header calls escaping lossless. Iterating an array of one long
    // string emitted "o" - one character - and destroyed the rest.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [ev({
        eventId: 'e1', taskId: 't1', kind: 'propose',
        title: ['ok\u000A### mallory'] as unknown as string,
      })],
    }], NOW);
    expect(section.open).toEqual(['[title refused: not a string] task "t1"']);
    expect(section.open[0]).not.toBe('"o"');
  });

  it('survives a holey events array and reports the holes', () => {
    // A sparse array threw from inside fold ("cannot read eventId of
    // undefined"), which is the same whole-digest denial by another route.
    const sparse: BoardEvent[] = [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'ok' })];
    sparse[3] = ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'also ok' });
    const [section] = computeStandup([{ peerAlias: 'alice', events: sparse }], NOW);
    expect(section.open).toEqual(['"ok"', '"also ok"']);
    expect(section.needsAttention).toEqual(['[malformed] 2 event(s) discarded before folding']);
  });

  it.each([
    ['a non-object event', 'nope'],
    ['a null event', null],
    ['a non-string eventId', { eventId: 7, taskId: 't1', peerId: 'p', kind: 'propose', lamport: 1, generation: 0, receivedAt: NOW }],
    ['a non-string taskId', { eventId: 'e1', taskId: [], peerId: 'p', kind: 'propose', lamport: 1, generation: 0, receivedAt: NOW }],
    ['a non-number generation', { eventId: 'e1', taskId: 't1', peerId: 'p', kind: 'propose', lamport: 1, generation: '0', receivedAt: NOW }],
    ['a non-number leaseMs', { eventId: 'e1', taskId: 't1', peerId: 'p', kind: 'claim', lamport: 1, generation: 0, receivedAt: NOW, leaseMs: {} }],
  ])('discards %s and keeps the honest one', (_label, bad) => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [bad as unknown as BoardEvent, ev({ eventId: 'e9', taskId: 't9', kind: 'propose', title: 'honest' })],
    }], NOW);
    expect(section.open).toEqual(['"honest"']);
    expect(section.needsAttention).toEqual(['[malformed] 1 event(s) discarded before folding']);
  });

  it('keeps a NaN lamport visible as a fold rejection, not as a silent discard', () => {
    // The pre-fold shape check must not swallow what the fold already reports
    // better: "dropped, reason lamport-invalid" is more information than
    // "malformed".
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'x', lamport: Number.NaN })],
    }], NOW);
    expect(section.needsAttention).toEqual(['[dropped] 1 event(s): lamport-invalid']);
  });

  it('reports malformed events per peer instead of pooling them', () => {
    const sections = computeStandup([
      { peerAlias: 'alice', events: [null as unknown as BoardEvent] },
      { peerAlias: 'bob', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'fine', peerId: 'p_bob' })] },
    ], NOW);
    expect(sections[0].needsAttention).toEqual(['[malformed] 1 event(s) discarded before folding']);
    expect(sections[1].needsAttention).toEqual([]);
  });
});

describe('DeskStandup - the escape class is wider than the wire class', () => {
  // hasUnsafeChars is an under-approximation: a boundary that REJECTS can
  // afford one, a renderer that ESCAPES cannot. Each code point below was
  // confirmed to pass through a title unescaped AND to be accepted by the
  // second gate before this was fixed.
  const INVISIBLE: [string, number][] = [
    ['LINE SEPARATOR', 0x2028],
    ['PARAGRAPH SEPARATOR', 0x2029],
    ['WORD JOINER', 0x2060],
    ['FUNCTION APPLICATION', 0x2061],
    ['INVISIBLE SEPARATOR', 0x2063],
    ['SOFT HYPHEN', 0x00AD],
    ['MONGOLIAN VOWEL SEPARATOR', 0x180E],
    ['INTERLINEAR ANNOTATION ANCHOR', 0xFFF9],
    ['INTERLINEAR ANNOTATION TERMINATOR', 0xFFFB],
    ['LANGUAGE TAG', 0xE0001],
    ['TAG LATIN SMALL LETTER A', 0xE0061],
    ['NONCHARACTER U+FFFE', 0xFFFE],
    ['NONCHARACTER U+FDD0', 0xFDD0],
  ];

  it.each(INVISIBLE)('escapes %s rather than smuggling it into a model prompt', (_name, cp) => {
    const ch = String.fromCodePoint(cp);
    const out = render([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'a' + ch + 'b' })],
    }]);
    expect(out).not.toContain(ch);
    expect(out).toContain('\\u' + cp.toString(16).toUpperCase().padStart(4, '0'));
  });

  it.each(INVISIBLE)('refuses %s at the second gate too', (_name, cp) => {
    const ch = String.fromCodePoint(cp);
    const base: StandupSection = { peerAlias: 'alice', done: [], inProgress: [], open: [], needsAttention: [] };
    expect(() => renderTeamStandup([{ ...base, done: ['a' + ch + 'b'] }], NOW)).toThrow(/control\/bidi/);
  });

  it('emits no format, control or separator code point at all', () => {
    // A property over the whole digest rather than one character at a time:
    // whatever the fixture carries, nothing invisible reaches the output.
    const smuggled = INVISIBLE.map(([, cp]) => String.fromCodePoint(cp)).join('x');
    const out = render([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: smuggled })],
    }]);
    // Per LINE: the digest's own newlines are its structure, and the claim is
    // that nothing invisible survives INSIDE a line.
    for (const line of out.split('\u000A')) {
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
    }
  });

  it('is a UNION with the wire class, so nothing the contract refuses slips past', () => {
    const out = render([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'a\u202Eb\u200Bc\uFEFFd\u200Ee' })],
    }]);
    for (const cp of [0x202E, 0x200B, 0xFEFF, 0x200E]) {
      expect(out).not.toContain(String.fromCodePoint(cp));
    }
  });

  it('escapes EVERYTHING the wire contract refuses, so the classes cannot drift apart', () => {
    // The local class is deliberately WIDER than DeskContract's, and this is
    // the direction that must never invert: if the contract is widened later,
    // a character it refuses must still not reach the digest raw.
    const refusedByContract: string[] = [];
    for (let cp = 0; cp <= 0xFFFF; cp++) {
      const ch = String.fromCharCode(cp);
      if (hasUnsafeChars(ch)) { refusedByContract.push(ch); }
    }
    expect(refusedByContract.length).toBeGreaterThan(60);
    // Asserted on the rendered ITEM, not the whole digest: the digest's own
    // newlines are its structure, and a newline is in the contract's class.
    // Chunked so each title stays under the escaped-size cap - a refusal
    // marker would prove nothing about escaping.
    for (let i = 0; i < refusedByContract.length; i += 30) {
      const chunk = refusedByContract.slice(i, i + 30);
      const [section] = computeStandup([{
        peerAlias: 'alice',
        events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: chunk.join('') })],
      }], NOW);
      const item = section.open[0];
      expect(item.startsWith('"')).toBe(true);
      for (const ch of chunk) { expect(item.includes(ch)).toBe(false); }
    }
  });

  it('does not escape legitimate non-Latin text, which an allowlist would have', () => {
    // The failure mode of widening an escape class is mangling real titles.
    const title = '\u4F7F\u7528 \u0645\u0631\u062D\u0628\u0627 caf\u00E9';
    const [section] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title })] }],
      NOW,
    );
    expect(section.open).toEqual(['"' + title + '"']);
  });
});

describe('DeskStandup - every rendered span is bounded', () => {
  it('caps the taskId inside a refusal, so the refusal is not itself an amplifier', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [ev({
        eventId: 'e1', taskId: 'T'.repeat(5000), kind: 'propose',
        title: 'y'.repeat(LIMITS.title + 1),
      })],
    }], NOW);
    expect(section.open).toEqual([
      `[title refused: ${LIMITS.title + 1} chars exceeds ${LIMITS.title}] `
      + `task [taskId refused: 5000 chars exceeds ${LIMITS.id}]`,
    ]);
    expect(section.open[0].length).toBeLessThan(200);
  });

  it('caps the owner span', () => {
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [
        ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: 'x' }),
        ev({
          eventId: 'e2', taskId: 't1', kind: 'claim', generation: 1, lamport: 2,
          peerId: 'p'.repeat(5000), leaseMs: 600_000,
        }),
      ],
    }], NOW);
    expect(section.inProgress[0])
      .toBe(`"x" - [owner refused: 5000 chars exceeds ${LIMITS.id}] (lease 10m left)`);
  });

  it('caps an invalid alias without letting two of them collapse into one section', () => {
    // Bounded output and injectivity are in tension (pigeonhole), so the
    // truncated alias carries a fingerprint of the WHOLE original. Losing
    // injectivity would merge two corrupt roster records into one peer, which
    // is the merge the marker exists to prevent.
    const sections = computeStandup(
      [{ peerAlias: 'z'.repeat(10_000), events: [] }, { peerAlias: 'z'.repeat(10_001), events: [] }],
      NOW,
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].peerAlias).not.toBe(sections[1].peerAlias);
    for (const s of sections) { expect(s.peerAlias.length).toBeLessThanOrEqual(74); }
    const out = renderTeamStandup(sections, NOW);
    for (const line of out.split('\u000A')) { expect(line.length).toBeLessThan(120); }
  });

  it('cuts a capped alias on a code-point boundary, never mid-surrogate-pair', () => {
    // Truncating an escaped alias at a fixed number of UTF-16 units can land
    // between the halves of a pair and MANUFACTURE the very lone surrogate the
    // escape class exists to remove - which the render gate would then refuse,
    // turning a bounded alias into a thrown digest.
    const alias = 'a' + '\u{1F600}'.repeat(40);
    const [section] = computeStandup([{ peerAlias: alias, events: [] }], NOW);
    expect(section.peerAlias.length).toBeLessThanOrEqual(74);
    expect(section.peerAlias).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(section.peerAlias).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(() => renderTeamStandup([section], NOW)).not.toThrow();
  });

  it('applies the size check to the ESCAPED string, not only the raw one', () => {
    // A 200-character title of newlines is within the limit and renders as
    // 1202 characters: a 6x amplifier per item, applied per event.
    const [section] = computeStandup([{
      peerAlias: 'alice',
      events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title: '\u000A'.repeat(LIMITS.title) })],
    }], NOW);
    expect(section.open).toEqual([
      `[title refused: ${LIMITS.title * 6} escaped chars exceeds ${LIMITS.title * 2}] task "t1"`,
    ]);
  });

  it('still accepts an honest title that happens to quote something', () => {
    // The escaped-size rule must not refuse real work. Escaping expands honest
    // text barely at all.
    const title = 'ship the "fast path" rewrite';
    const [section] = computeStandup(
      [{ peerAlias: 'alice', events: [ev({ eventId: 'e1', taskId: 't1', kind: 'propose', title })] }],
      NOW,
    );
    expect(section.open[0]).toContain('\\u0022fast path\\u0022');
    expect(section.open[0].startsWith('"')).toBe(true);
  });

  it('folds a peer-sized event log without blowing the call stack', () => {
    // `bucket.push(...input.events)` spreads into an argument list, which
    // throws RangeError past ~125k arguments in V8: a whole-digest denial
    // written by whoever sends the most events. Every event names the SAME
    // task so the cost is the guard being exercised, not the fold's sort.
    const many: BoardEvent[] = [];
    for (let i = 0; i < 130_000; i++) {
      many.push(ev({ eventId: 'e' + i, taskId: 't1', kind: 'propose', title: 'w' }));
    }
    // Guard the guard: this fixture is only a test because a spread of this
    // size does throw.
    expect(() => { const sink: BoardEvent[] = []; sink.push(...many); }).toThrow(RangeError);
    const sections = computeStandup([{ peerAlias: 'alice', events: many }], NOW);
    expect(sections).toHaveLength(1);
    expect(sections[0].open).toEqual(['"w"']);
  }, 30_000);
});

describe('DeskStandup - one bad entry cannot deny the digest', () => {
  it('discards an event whose FIELD getter throws, rather than dying reading it', () => {
    // The shape check runs outside the per-peer catch, so a throwing getter on
    // an identity field would deny the digest to every peer before any fold
    // began.
    const bomb = { taskId: 't1', peerId: 'p_alice', kind: 'propose', lamport: 1, generation: 0, receivedAt: NOW };
    Object.defineProperty(bomb, 'eventId', { get() { throw new Error('boom'); }, enumerable: true });
    const sections = computeStandup([
      { peerAlias: 'alice', events: [bomb as unknown as BoardEvent] },
      { peerAlias: 'bob', events: [ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'real work', peerId: 'p_bob' })] },
    ], NOW);
    expect(sections[0].needsAttention).toEqual(['[malformed] 1 event(s) discarded before folding']);
    expect(sections[1].open).toEqual(['"real work"']);
  });

  it('degrades a peer whose log breaks the fold, and keeps every other peer', () => {
    // A property whose getter throws is the shape no shape-check can predict;
    // the per-peer catch is what turns it into one refused section instead of
    // a lost digest.
    const bomb = ev({ eventId: 'e1', taskId: 't1', kind: 'propose' });
    Object.defineProperty(bomb, 'title', { get() { throw new Error('boom'); }, enumerable: true });
    const sections = computeStandup([
      { peerAlias: 'alice', events: [bomb] },
      { peerAlias: 'bob', events: [ev({ eventId: 'e2', taskId: 't2', kind: 'propose', title: 'real work', peerId: 'p_bob' })] },
    ], NOW);
    expect(sections[0].needsAttention).toEqual(['[peer refused: 1 event(s) could not be folded]']);
    expect(sections[1].open).toEqual(['"real work"']);
    const out = renderTeamStandup(sections, NOW);
    expect(out).toContain('"real work"');
    expect(out).toContain('[peer refused:');
  });
});
