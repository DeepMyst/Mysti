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
 * deskTools tests (Plan 21 Phase 2).
 *
 * The surface under test is the ONE place a coordinator model can address
 * another machine on the native lane, so the tests are written against the
 * failure modes, not the feature: an ungranted verb must be absent rather than
 * refused, a hostile alias must not survive into an address, a malformed
 * argument must produce `null` rather than a repaired call, and a
 * prototype-shaped name or key must reach nothing.
 *
 * ── The rule these tests are held to ───────────────────────────────────────
 *
 * Every security-relevant branch has a case here that FAILS WHEN THE BRANCH IS
 * DELETED. A test that still passes with its guard commented out is worse than
 * no test: it certifies safety that does not exist. Where a guard turned out to
 * be strictly shadowed by a stronger one (an `isDeskVerb` filter behind a loop
 * over the closed verb table), the guard was DELETED from the module and the
 * claim re-pointed at the line that enforces it, rather than pinned by a test
 * that could never fail.
 *
 * Three earlier tests in this file are gone on purpose, because they pinned
 * behaviour that is now refused:
 *   - `toolCallToDeskCall('desk__consult', {peer:'nobody', …})` returning a
 *     call. That documented "the parser deliberately does not check the
 *     roster". It does now; it is required to.
 *   - the `consult` / `review` / `assign` / `handoff` / `followup` argument
 *     round-trips. Those verbs are outside `DESK_SENDABLE_VERBS` and are
 *     refused wholesale; their validators are covered by deskContract.test.ts.
 *   - `['alice']` as an args array. An array with no own `peer` is refused by
 *     the alias check whether or not `Array.isArray` is there, so it proved
 *     nothing; it is replaced by an array that DOES carry an own `peer`.
 */

import { describe, it, expect } from 'vitest';
import {
  DESK_TOOL_PREFIX,
  DESK_MAX_PEERS_PER_VERB,
  DESK_SENDABLE_VERBS,
  deskToolSchemas,
  isDeskToolSchema,
  toolCallToDeskCall,
  type DeskGate,
  type DeskToolContext,
  type DeskToolPeer,
  type DeskToolSchema,
} from '../../../src/services/desk/deskTools';
import { DESK_VERBS, DESK_VERB_NAMES } from '../../../src/services/desk/DeskContract';
import { listVerbs } from '../../../src/services/desk/DeskDispatch';
import { TOOL_PREFIX as MCP_TOOL_PREFIX } from '../../../src/services/desk/DeskMcpBridge';
import type { DeskVerb, PeerGrant } from '../../../src/types';

const NOW = 1_800_000_000_000;
const LATER = NOW + 60_000;

const OPEN: DeskGate = { settingEnabled: true, workspaceTrusted: true, effectsAllowed: true };

/** A roster entry, defaulting to a live grant. */
function peer(alias: string, verbs: string[], expiresAt: number = LATER): DeskToolPeer {
  return { alias, verbs, expiresAt };
}

/** The context both exported functions take. */
function ctx(peers: DeskToolPeer[], over: Partial<DeskToolContext> = {}): DeskToolContext {
  return { gate: OPEN, peers, now: NOW, ...over };
}

/** The roster used by most tests: one peer that granted every sendable verb. */
function alice(): DeskToolContext {
  return ctx([peer('alice', [...DESK_SENDABLE_VERBS])]);
}

function schemas(c: DeskToolContext): DeskToolSchema[] {
  return deskToolSchemas(c) as DeskToolSchema[];
}
function names(c: DeskToolContext): string[] {
  return schemas(c).map(t => t.function.name);
}
function paramsOf(tool: DeskToolSchema): Record<string, unknown> {
  return tool.function.parameters;
}
function peerEnum(tool: DeskToolSchema): string[] {
  const props = paramsOf(tool).properties as Record<string, { enum?: string[] }>;
  return props.peer.enum ?? [];
}
function toolNamed(c: DeskToolContext, verb: string): DeskToolSchema | undefined {
  return schemas(c).find(t => t.function.name === `${DESK_TOOL_PREFIX}${verb}`);
}

// ---------------------------------------------------------------------------
// The gate. Three named preconditions, each of which must be exactly `true`.
// ---------------------------------------------------------------------------

describe('the gate is a required argument, not an assumed caller obligation', () => {
  const KEYS: (keyof DeskGate)[] = ['settingEnabled', 'workspaceTrusted', 'effectsAllowed'];

  for (const key of KEYS) {
    it(`emits no surface when ${key} is false`, () => {
      const c = ctx([peer('alice', ['status'])], { gate: { ...OPEN, [key]: false } });
      expect(deskToolSchemas(c)).toEqual([]);
      expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).toBeNull();
    });

    it(`treats a truthy non-boolean ${key} as shut — a string is not consent`, () => {
      for (const truthy of ['yes', 1, {}]) {
        const c = ctx([peer('alice', ['status'])], {
          gate: { ...OPEN, [key]: truthy } as unknown as DeskGate,
        });
        expect(deskToolSchemas(c)).toEqual([]);
        expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).toBeNull();
      }
    });
  }

  it('is shut when the gate object itself is missing', () => {
    for (const gate of [undefined, null, 'open', true]) {
      const c = ctx([peer('alice', ['status'])], { gate: gate as unknown as DeskGate });
      expect(deskToolSchemas(c)).toEqual([]);
      expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).toBeNull();
    }
  });

  it('is shut when the whole context is missing', () => {
    const nothing = undefined as unknown as DeskToolContext;
    expect(deskToolSchemas(nothing)).toEqual([]);
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, nothing)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The clock. This is the fail-open-on-unvalidated-number class: `now >= NaN` is
// false, so an unchecked clock does not mis-expire — it stops expiring.
// ---------------------------------------------------------------------------

describe('an unusable clock closes the surface instead of disabling expiry', () => {
  for (const [label, now] of [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['undefined', undefined],
    ['a numeric string', '1800000000000'],
    ['null', null],
  ] as [string, unknown][]) {
    it(`emits nothing and parses nothing when now is ${label}`, () => {
      const c = ctx([peer('alice', ['status'])], { now: now as number });
      expect(deskToolSchemas(c)).toEqual([]);
      expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).toBeNull();
    });
  }

  it('drops a peer whose grant has expired, on both halves of the surface', () => {
    const c = ctx([peer('alice', ['status'], NOW - 1)]);
    expect(deskToolSchemas(c)).toEqual([]);
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).toBeNull();
  });

  it('treats expiry as inclusive: expiresAt === now is dead', () => {
    const c = ctx([peer('alice', ['status'], NOW)]);
    expect(deskToolSchemas(c)).toEqual([]);
  });

  it('keeps a peer whose grant is still live', () => {
    const c = ctx([peer('alice', ['status'], NOW + 1)]);
    expect(names(c)).toEqual([`${DESK_TOOL_PREFIX}status`]);
  });

  for (const [label, expiresAt] of [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['missing', undefined],
    ['a string', String(LATER)],
  ] as [string, unknown][]) {
    it(`drops a peer whose expiresAt is ${label} — an immortal grant is not a grant`, () => {
      const c = ctx([{ alias: 'alice', verbs: ['status'], expiresAt } as unknown as DeskToolPeer]);
      expect(deskToolSchemas(c)).toEqual([]);
      expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// No peers, no surface.
// ---------------------------------------------------------------------------

describe('deskToolSchemas — no peers, no surface', () => {
  it('returns [] for an empty roster', () => {
    expect(deskToolSchemas(ctx([]))).toEqual([]);
  });

  it('returns [] for a roster whose peers granted nothing', () => {
    expect(deskToolSchemas(ctx([peer('alice', [])]))).toEqual([]);
  });

  it('returns [] for a non-array roster (defensive: the caller may hand us anything)', () => {
    for (const peers of [undefined, null, 'alice', 42]) {
      expect(deskToolSchemas(ctx(peers as unknown as DeskToolPeer[]))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The local send ceiling.
// ---------------------------------------------------------------------------

describe('DESK_SENDABLE_VERBS — a local ceiling on what may ever leave', () => {
  it('is a strict subset of the closed contract table', () => {
    for (const v of DESK_SENDABLE_VERBS) {
      expect(DESK_VERB_NAMES).toContain(v);
    }
    expect(DESK_SENDABLE_VERBS.length).toBeLessThan(DESK_VERB_NAMES.length);
  });

  it('tracks what DeskDispatch can actually serve (the twin-drift check)', () => {
    // If this fails, the two halves have drifted: either a verb became
    // servable and nothing widened the send ceiling (the model can never use
    // it), or the ceiling widened past what any peer can answer (every call
    // burns a turn on `unknown verb`). Both are the failure the module's
    // absent-not-present-and-refused doctrine forbids.
    const everything: PeerGrant = {
      peerId: 'p_abc',
      verbs: [...DESK_VERB_NAMES] as DeskVerb[],
      scope: ['src'],
      expiresAt: LATER,
      budgetUsd: 1,
      maxCalls: 10,
      minRetentionClass: 'zero-retention',
    };
    expect([...listVerbs(everything, NOW)].sort()).toEqual([...DESK_SENDABLE_VERBS].sort());
  });

  it('emits no schema for a verb outside the ceiling, however widely granted', () => {
    const all = ctx([peer('alice', [...DESK_VERB_NAMES])]);
    const emitted = names(all).map(n => n.slice(DESK_TOOL_PREFIX.length));
    expect(emitted.sort()).toEqual([...DESK_SENDABLE_VERBS].sort());
    for (const verb of DESK_VERB_NAMES) {
      if (DESK_SENDABLE_VERBS.includes(verb)) { continue; }
      expect(emitted).not.toContain(verb);
    }
  });

  it('refuses a call to an un-sendable verb even with a granting peer and valid arguments', () => {
    // The cached prompt prefix can outlive a narrowing of the ceiling, so the
    // parser must refuse on its own rather than trust what was advertised.
    const all = ctx([peer('alice', [...DESK_VERB_NAMES])]);
    const SHA = 'a'.repeat(40);
    const VALID: Record<string, Record<string, unknown>> = {
      consult: { peer: 'alice', question: 'where is the token rotated?' },
      review: { peer: 'alice', baseSha: SHA, paths: ['src/a.ts'] },
      handoff: { peer: 'alice', title: 'Rotate keys', baseSha: SHA },
      assign: { peer: 'alice', title: 'Rotate keys', detail: 'The refresh path needs a rotation step.', proposalId: 'p-1' },
      followup: { peer: 'alice' },
    };
    for (const [verb, args] of Object.entries(VALID)) {
      expect(DESK_VERB_NAMES).toContain(verb as DeskVerb);
      expect(toolCallToDeskCall(`${DESK_TOOL_PREFIX}${verb}`, args, all)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Ungranted is absent.
// ---------------------------------------------------------------------------

describe('deskToolSchemas — an ungranted verb is ABSENT, not present-and-refused', () => {
  it('emits only the verbs some peer granted', () => {
    const got = names(ctx([peer('alice', ['status'])]));
    expect(got).toEqual([`${DESK_TOOL_PREFIX}status`]);
    expect(got).not.toContain(`${DESK_TOOL_PREFIX}locate`);
  });

  it('confines each peer to the enum of the verbs it granted', () => {
    const c = ctx([peer('alice', ['locate']), peer('bob', ['status'])]);
    expect(peerEnum(toolNamed(c, 'locate')!)).toEqual(['alice']);
    expect(peerEnum(toolNamed(c, 'status')!)).toEqual(['bob']);
    // The whole point: bob is not an address for `locate`.
    expect(peerEnum(toolNamed(c, 'locate')!)).not.toContain('bob');
  });

  it('emits nothing for verb names outside the closed contract table', () => {
    // NOTE what this pins and what it does not. There is no membership FILTER
    // to delete any more: the surface is built by iterating the closed
    // `DESK_SENDABLE_VERBS` table and asking whether the roster granted each
    // one, so a roster naming `bash` is never asked about. This test pins that
    // structural property; the branch that used to claim it (`isDeskVerb(v)`
    // over the roster) was deleted because no input could make it matter.
    const got = names(ctx([peer('alice', ['bash', 'write', 'read', 'grep', 'hello', 'cancel'])]));
    expect(got).toEqual([]);
  });

  it('does not treat inherited Object members as granted verbs', () => {
    for (const poison of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(deskToolSchemas(ctx([peer('alice', [poison])]))).toEqual([]);
      expect(toolCallToDeskCall(`${DESK_TOOL_PREFIX}${poison}`, { peer: 'alice' }, ctx([peer('alice', [poison])])))
        .toBeNull();
    }
  });

  it('ignores non-string entries in a verb list rather than throwing', () => {
    const c = ctx([{ alias: 'alice', verbs: [null, 7, {}, 'status'] as unknown as string[], expiresAt: LATER }]);
    expect(names(c)).toEqual([`${DESK_TOOL_PREFIX}status`]);
  });
});

// ---------------------------------------------------------------------------
// The alias.
// ---------------------------------------------------------------------------

describe('deskToolSchemas — the alias is validated before it becomes an address', () => {
  const HOSTILE: [string, string][] = [
    ['uppercase', 'Alice'],
    ['leading dash', '-alice'],
    ['too long', 'a'.repeat(33)],
    ['empty', ''],
    ['path traversal', '../alice'],
    ['slash', 'team/alice'],
    ['space', 'alice bob'],
    ['newline', 'alice\nbob'],
    ['NUL', 'alice\u0000'],
    ['bidi override', 'ali\u202Ece'],
    ['zero width', 'ali\u200Bce'],
    ['dot', 'alice.bob'],
    ['at sign', 'alice@host'],
  ];

  for (const [label, alias] of HOSTILE) {
    it(`drops a peer whose alias is ${label}`, () => {
      expect(deskToolSchemas(ctx([peer(alias, ['status'])]))).toEqual([]);
    });
  }

  it('drops only the bad peer, keeping the good one addressable', () => {
    const c = ctx([peer('Alice', ['status']), peer('bob', ['status'])]);
    const tools = schemas(c);
    expect(tools).toHaveLength(1);
    expect(peerEnum(tools[0])).toEqual(['bob']);
  });

  it('drops a non-object roster entry rather than throwing', () => {
    const c = ctx([
      null as unknown as DeskToolPeer,
      'alice' as unknown as DeskToolPeer,
      peer('bob', ['status']),
    ]);
    expect(peerEnum(schemas(c)[0])).toEqual(['bob']);
  });

  it('drops a peer whose verbs field is not an array', () => {
    // A string was the old case here and it proved nothing: iterating
    // `'status'` yields characters, so the peer was dropped whether or not the
    // `Array.isArray` guard existed. A non-array ITERABLE is what separates
    // "must be an array" from "must be truthy" — weaken the guard to `!verbs`
    // and the Set below becomes an addressable peer.
    expect(deskToolSchemas(ctx([peer('alice', 'status' as unknown as string[])]))).toEqual([]);
    expect(deskToolSchemas(ctx([peer('alice', new Set(['status']) as unknown as string[])]))).toEqual([]);
    expect(toolCallToDeskCall(
      'desk__status',
      { peer: 'alice' },
      ctx([peer('alice', new Set(['status']) as unknown as string[])]),
    )).toBeNull();
    // Sanity: the same verb in a real array IS addressable, so the two
    // assertions above fail for the reason they claim.
    expect(names(ctx([peer('alice', ['status'])]))).toEqual([`${DESK_TOOL_PREFIX}status`]);
  });

  it('reads each roster field exactly once, so a getter cannot change its answer', () => {
    // The predecessor checked `Array.isArray(p.verbs)` and then iterated
    // `p.verbs` — two reads of a field the caller supplies. The second read is
    // deliberately made unusable here: re-introduce the check-then-use pattern
    // and the `for…of` throws an uncaught TypeError out of the middle of tool
    // assembly, with no try/catch anywhere above it.
    let reads = 0;
    const shifty = {
      alias: 'alice',
      expiresAt: LATER,
      get verbs(): string[] {
        reads++;
        return (reads === 1 ? ['status'] : null) as unknown as string[];
      },
    } as DeskToolPeer;
    let tools: DeskToolSchema[] = [];
    expect(() => { tools = schemas(ctx([shifty])); }).not.toThrow();
    // …and the ONE read was actually used: the peer is addressable, so the
    // assertion above is not passing because the entry was quietly skipped.
    expect(reads).toBe(1);
    expect(peerEnum(tools[0])).toEqual(['alice']);
  });
});

describe('an ambiguous alias addresses nobody', () => {
  it('drops BOTH records when two live entries claim one alias', () => {
    // Not first-wins: with two records the routing target is genuinely
    // unknown, and resolving by array order would make re-ordering the roster
    // file an authorization change.
    const c = ctx([peer('alice', ['status']), peer('alice', ['status', 'locate'])]);
    expect(deskToolSchemas(c)).toEqual([]);
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).toBeNull();
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token: 'x' }, c)).toBeNull();
  });

  it('is not confused by a dead duplicate: one live record still routes', () => {
    const c = ctx([peer('alice', ['status'], NOW - 1), peer('alice', ['status'])]);
    expect(names(c)).toEqual([`${DESK_TOOL_PREFIX}status`]);
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c))
      .toEqual({ peerAlias: 'alice', verb: 'status', args: {} });
  });

  it('drops only the ambiguous alias, not the whole roster', () => {
    const c = ctx([peer('alice', ['status']), peer('alice', ['status']), peer('bob', ['status'])]);
    expect(peerEnum(schemas(c)[0])).toEqual(['bob']);
  });
});

// ---------------------------------------------------------------------------
// Shape.
// ---------------------------------------------------------------------------

describe('deskToolSchemas — shape', () => {
  it('requires `peer` on every verb, including the argument-free one', () => {
    const tools = schemas(alice());
    expect(tools).toHaveLength(DESK_SENDABLE_VERBS.length);
    for (const t of tools) {
      const p = paramsOf(t);
      expect(p.type).toBe('object');
      expect(p.additionalProperties).toBe(false);
      expect(p.required as string[]).toContain('peer');
      expect(Object.keys(p.properties as object)[0]).toBe('peer');
    }
  });

  it('namespaces every tool under the desk__ prefix and nothing else', () => {
    for (const n of names(alice())) {
      expect(n.startsWith(DESK_TOOL_PREFIX)).toBe(true);
      // Exactly one segment after the prefix: a peer alias can never sit in
      // the namespace, so it can never collide with another tool name.
      expect(n.slice(DESK_TOOL_PREFIX.length)).not.toContain('__');
    }
  });

  it('uses a prefix legal in a native function name, which is why the MCP one differs', () => {
    // The two spellings of the namespace are forced, not drifted: an
    // OpenAI-compatible tool name may not contain `.`, and DeskMcpBridge's
    // wire namespace conventionally does.
    expect(DESK_TOOL_PREFIX).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(MCP_TOOL_PREFIX).not.toMatch(/^[A-Za-z0-9_-]+$/);
    expect(MCP_TOOL_PREFIX.replace(/[^A-Za-z0-9_-]/g, '')).toBe(DESK_TOOL_PREFIX.replace(/_+$/, ''));
  });

  it('states what leaves the machine, quoting the contract disclosure', () => {
    for (const t of schemas(alice())) {
      const verb = t.function.name.slice(DESK_TOOL_PREFIX.length) as keyof typeof DESK_VERBS;
      expect(t.function.description).toContain(DESK_VERBS[verb].discloses);
      expect(t.function.description.toLowerCase()).toContain('machine');
    }
  });

  it('narrows its own return type without a cast at the splice site', () => {
    const raw: unknown[] = deskToolSchemas(alice());
    expect(raw.every(isDeskToolSchema)).toBe(true);
    for (const decoy of [null, 42, {}, { type: 'function' }, { type: 'function', function: { name: 'read' } }]) {
      expect(isDeskToolSchema(decoy)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The shared property table.
// ---------------------------------------------------------------------------

describe('deskToolSchemas — a returned schema shares nothing with the module table', () => {
  it('does not leak a mutable reference at depth 1', () => {
    const first = schemas(ctx([peer('alice', ['locate'])]))[0];
    (paramsOf(first).properties as Record<string, Record<string, unknown>>).token.maxLength = 999999;
    const second = schemas(ctx([peer('alice', ['locate'])]))[0];
    expect((paramsOf(second).properties as Record<string, Record<string, unknown>>).token.maxLength)
      .not.toBe(999999);
  });

  it('does not leak a mutable reference at depth 2 — the nested enum array', () => {
    // The predecessor returned arrays BY REFERENCE, so this push rewrote the
    // module table for the lifetime of the process, at the cached prompt
    // prefix, invisibly: every later call advertised `kind: [symbol, path,
    // regex]`. The depth-1 test above passes either way, which is exactly why
    // this one exists.
    const first = schemas(ctx([peer('alice', ['locate'])]))[0];
    const props = paramsOf(first).properties as Record<string, { enum?: string[]; description?: string }>;
    props.kind.enum!.push('regex');
    props.kind.description = 'ANY kind is fine';

    const second = schemas(ctx([peer('alice', ['locate'])]))[0];
    const fresh = paramsOf(second).properties as Record<string, { enum?: string[]; description?: string }>;
    expect(fresh.kind.enum).toEqual(['symbol', 'path']);
    expect(fresh.kind.description).not.toContain('ANY');
  });

  it('does not leak the peer enum array between calls', () => {
    const first = schemas(ctx([peer('alice', ['status'])]))[0];
    peerEnum(first).push('mallory');
    expect(peerEnum(schemas(ctx([peer('alice', ['status'])]))[0])).toEqual(['alice']);
  });
});

// ---------------------------------------------------------------------------
// The enum bound.
// ---------------------------------------------------------------------------

describe('deskToolSchemas — the peer enum is bounded and stable', () => {
  it('dedupes nothing by accident: one alias appears once', () => {
    const c = ctx([peer('alice', ['status']), peer('bob', ['status'])]);
    expect(peerEnum(schemas(c)[0])).toEqual(['alice', 'bob']);
  });

  it('sorts aliases so the cached tool prefix does not churn between calls', () => {
    const a = schemas(ctx([peer('zoe', ['status']), peer('alice', ['status'])]));
    const b = schemas(ctx([peer('alice', ['status']), peer('zoe', ['status'])]));
    expect(peerEnum(a[0])).toEqual(['alice', 'zoe']);
    expect(peerEnum(a[0])).toEqual(peerEnum(b[0]));
  });

  it('caps the enum, and a capped-out peer is UNREACHABLE, not just unadvertised', () => {
    const many: DeskToolPeer[] = Array.from({ length: DESK_MAX_PEERS_PER_VERB + 8 }, (_, i) =>
      peer(`peer${String(i).padStart(3, '0')}`, ['status']));
    const c = ctx(many);
    const e = peerEnum(schemas(c)[0]);
    expect(e).toHaveLength(DESK_MAX_PEERS_PER_VERB);
    expect(e[0]).toBe('peer000');

    const dropped = many[many.length - 1].alias;
    expect(e).not.toContain(dropped);
    // "Dropping fails safe" is a claim about the PARSER, not only the enum:
    // advertisement and authorization are the same computation.
    expect(toolCallToDeskCall('desk__status', { peer: dropped }, c)).toBeNull();
    expect(toolCallToDeskCall('desk__status', { peer: 'peer000' }, c)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The parser: not ours.
// ---------------------------------------------------------------------------

describe('toolCallToDeskCall — not ours', () => {
  const NOT_OURS = [
    'read', 'bash', 'delegate', 'mcp__gmail_send', 'canvas_open', '', 'desk_', 'desk',
    // Six characters of something else followed by a real verb: this is what
    // kills the `startsWith` mutant. Without the prefix check, `slice(6)`
    // yields `status` and the call is accepted.
    'Desk__status', 'xxxxxxstatus', 'DESK__STATUS', ' desk__status', 'mcp__status',
  ];
  for (const n of NOT_OURS) {
    it(`returns null for "${n}"`, () => {
      expect(toolCallToDeskCall(n, { peer: 'alice' }, alice())).toBeNull();
    });
  }

  it('returns null for a non-string name', () => {
    for (const n of [undefined, 42, null, {}]) {
      expect(toolCallToDeskCall(n as unknown as string, { peer: 'alice' }, alice())).toBeNull();
    }
  });

  it('returns null for the bare prefix with no verb', () => {
    expect(toolCallToDeskCall('desk__', { peer: 'alice' }, alice())).toBeNull();
  });

  it('rejects the alias-in-the-namespace shape plans/21 first sketched', () => {
    expect(toolCallToDeskCall('desk__alice__status', {}, alice())).toBeNull();
    expect(toolCallToDeskCall('desk__status__alice', { peer: 'alice' }, alice())).toBeNull();
  });

  it('rejects prototype-shaped verb names', () => {
    for (const n of ['desk____proto__', 'desk__constructor', 'desk__toString', 'desk__hasOwnProperty', 'desk__valueOf']) {
      expect(toolCallToDeskCall(n, { peer: 'alice' }, alice())).toBeNull();
    }
  });

  it('rejects protocol verbs, which are not grantable capabilities', () => {
    expect(toolCallToDeskCall('desk__hello', { peer: 'alice' }, alice())).toBeNull();
    expect(toolCallToDeskCall('desk__cancel', { peer: 'alice' }, alice())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The parser: the args object itself.
// ---------------------------------------------------------------------------

describe('toolCallToDeskCall — the args object itself', () => {
  it('returns null for a non-object args value', () => {
    for (const bad of [null, undefined, 'peer=alice', 42, true]) {
      expect(toolCallToDeskCall('desk__status', bad, alice())).toBeNull();
    }
  });

  it('rejects an ARRAY carrying an own `peer` property', () => {
    // The old case (`['alice']`) proved nothing: a bare array has no own
    // `peer`, so the alias check refused it whether or not `Array.isArray` was
    // there. This one does have one — delete the `Array.isArray` guard and the
    // call is accepted, because `Object.entries` of an array with a named
    // property yields exactly `peer`.
    const arrayWithPeer = Object.assign([], { peer: 'alice' }) as unknown;
    expect(toolCallToDeskCall('desk__status', arrayWithPeer, alice())).toBeNull();

    const indexedArray = Object.assign(['x'], { peer: 'alice', token: 'y' }) as unknown;
    expect(toolCallToDeskCall('desk__locate', indexedArray, alice())).toBeNull();
  });

  it('rejects an args object carrying a prototype-poisoning own key', () => {
    // Driven through `locate`, NOT `status`. `status` refuses any argument at
    // all, so it would pass with POISON_KEYS emptied; `locate` normalises and
    // DROPS unknown keys, so only the poison check can refuse these.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const hostile = JSON.parse(`{"peer":"alice","token":"x","${key}":{"polluted":true}}`);
      expect(toolCallToDeskCall('desk__locate', hostile, alice())).toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Sanity: the same call without the poison key is accepted, so the test
    // above is failing for the reason it claims.
    expect(toolCallToDeskCall('desk__locate', JSON.parse('{"peer":"alice","token":"x"}'), alice()))
      .not.toBeNull();
  });

  it('does not read `peer` off the prototype chain', () => {
    const viaProto = Object.create({ peer: 'alice' }) as Record<string, unknown>;
    expect(toolCallToDeskCall('desk__status', viaProto, alice())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The parser: the address. THIS is the finding that mattered.
// ---------------------------------------------------------------------------

describe('toolCallToDeskCall — the address is authorized here, not somewhere else', () => {
  it('accepts a well-formed alias that the roster actually grants', () => {
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, alice()))
      .toEqual({ peerAlias: 'alice', verb: 'status', args: {} });
  });

  it('refuses an alias that is not in the roster', () => {
    // The predecessor RETURNED A CALL here and deferred the roster check to an
    // unwritten caller. A model — or an instruction injected into an untrusted
    // result re-entering the coordinator — could name any address it liked.
    expect(toolCallToDeskCall('desk__status', { peer: 'nobody' }, alice())).toBeNull();
    expect(toolCallToDeskCall('desk__locate', { peer: 'mallory', token: 'x' }, alice())).toBeNull();
  });

  it('refuses a real peer for a verb it did not grant', () => {
    const c = ctx([peer('alice', ['status']), peer('bob', ['locate'])]);
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token: 'x' }, c)).toBeNull();
    expect(toolCallToDeskCall('desk__status', { peer: 'bob' }, c)).toBeNull();
    // …and each is reachable for the verb it DID grant, so the refusals above
    // are about the grant rather than about the peers being broken.
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, c)).not.toBeNull();
    expect(toolCallToDeskCall('desk__locate', { peer: 'bob', token: 'x' }, c)).not.toBeNull();
  });

  it('refuses an alias whose grant expired between advertisement and call', () => {
    const roster = [peer('alice', ['status'], NOW + 10)];
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, ctx(roster))).not.toBeNull();
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, ctx(roster, { now: NOW + 11 }))).toBeNull();
  });

  const HOSTILE_PEERS: [string, unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['number', 7],
    ['object', { toString: () => 'alice' }],
    ['array', ['alice']],
    ['uppercase', 'Alice'],
    ['too long', 'a'.repeat(33)],
    ['empty', ''],
    ['traversal', '../alice'],
    ['newline', 'alice\nbob'],
    ['NUL', 'alice\u0000'],
    ['bidi', 'ali\u202Ece'],
    ['zero width', 'ali\u200Bce'],
    ['leading space', ' alice'],
    ['trailing space', 'alice '],
  ];
  for (const [label, p] of HOSTILE_PEERS) {
    it(`returns null when peer is ${label}`, () => {
      expect(toolCallToDeskCall('desk__status', p === undefined ? {} : { peer: p }, alice())).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// The parser: arguments.
// ---------------------------------------------------------------------------

describe('toolCallToDeskCall — arguments go through the contract validators', () => {
  it('status takes no arguments at all', () => {
    expect(toolCallToDeskCall('desk__status', { peer: 'alice' }, alice())).not.toBeNull();
    expect(toolCallToDeskCall('desk__status', { peer: 'alice', focus: 'auth' }, alice())).toBeNull();
  });

  it('locate defaults kind and echoes the literal token', () => {
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token: 'refreshToken' }, alice()))
      .toEqual({ peerAlias: 'alice', verb: 'locate', args: { token: 'refreshToken', kind: 'symbol' } });
  });

  it('locate refuses a pattern — the blind-oracle class (I4)', () => {
    for (const token of ['refresh*', 'refresh?', 'a|b', '[a-z]+', '(secret)', 'a{2}', 'x\\y', '^tok', 'tok$']) {
      expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token }, alice())).toBeNull();
    }
  });

  it('locate refuses an unknown kind rather than falling back to a default', () => {
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token: 'x', kind: 'regex' }, alice())).toBeNull();
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token: 'x', kind: 'content' }, alice())).toBeNull();
  });

  it('locate refuses a token carrying control, bidi or zero-width characters', () => {
    for (const token of ['tok\u0000en', 'tok\u202Een', 'tok\u200Ben', 'tok\nen']) {
      expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token }, alice())).toBeNull();
    }
  });

  it('locate refuses a missing token rather than sending a half-formed request', () => {
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice' }, alice())).toBeNull();
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token: '' }, alice())).toBeNull();
    expect(toolCallToDeskCall('desk__locate', { peer: 'alice', token: 'x'.repeat(129) }, alice())).toBeNull();
  });

  it('returns the NORMALIZED args, dropping keys the validator did not produce', () => {
    const call = toolCallToDeskCall('desk__locate', {
      peer: 'alice',
      token: 'refreshToken',
      // A model can attach anything; none of it may ride along off-machine.
      scope: '/etc',
      depth: 99,
    }, alice());
    expect(call).not.toBeNull();
    expect(Object.keys(call!.args).sort()).toEqual(['kind', 'token']);
    expect(call!.args).not.toHaveProperty('scope');
  });

  it('never carries `peer` into the payload sent to the peer', () => {
    const call = toolCallToDeskCall('desk__locate', { peer: 'alice', token: 'x' }, alice());
    expect(call!.args).not.toHaveProperty('peer');
  });

  it('hands back a verb narrowed to the closed table, not a bare string', () => {
    const call = toolCallToDeskCall('desk__status', { peer: 'alice' }, alice());
    // Compile-time: `verb` is `DeskVerb`, so this assignment is the assertion.
    const verb: DeskVerb = call!.verb;
    expect(DESK_VERB_NAMES).toContain(verb);
  });
});
