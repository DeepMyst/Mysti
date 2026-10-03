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
 * deskTools (Plan 21 Phase 2) — the NATIVE tool-calling encoding of the Desk
 * verbs, and the parser that turns one back into a typed, AUTHORIZED call.
 *
 * ── One computation decides both what is offered and what is accepted ──────
 *
 * `deskToolSchemas` and `toolCallToDeskCall` both derive their answer from
 * {@link deskSurface}, which maps a verb to the exact aliases allowed to
 * receive it. The parser accepts a call only for a `(verb, alias)` pair that
 * the surface contains, so the model can call exactly what it was offered —
 * nothing more.
 *
 * This is the correction of an earlier shape in which the parser was a PURE
 * function with no roster and its docstring deferred the grant check to an
 * unwritten caller ("the caller re-resolves the alias"). That is a promise, not
 * a control: a `toolCallToDeskCall` that returns a call for `peer:'nobody'`
 * hands the integrator something named like a validated Desk call, and the
 * first integrator who trusts the name ships bytes to an unauthorized address.
 * The roster is therefore a REQUIRED argument — omitting it is a `tsc` error,
 * not a review finding.
 *
 * The caller still re-resolves at send time (`DeskPeerBook.getGrant(peerId)`),
 * because a grant can die between parse and send. That is defence in depth over
 * a check that exists, not a substitute for one.
 *
 * ── Why the peer is an argument, not part of the tool name ─────────────────
 *
 * plans/21 §3.8 sketched `desk__<alias>__<verb>`. That is rejected here: it
 * puts a human-typed alias into the tool NAMESPACE, where it shares a flat
 * string space with every built-in (`read`, `bash`, `canvas_*`, `mcp__*`).
 * An alias is typed by the local human under time pressure during pairing, and
 * `desk__mcp__gmail__send` or an alias that reads as another tool's suffix is a
 * name collision waiting to happen — with a tool-selection bug as the payoff.
 * Keeping the peer in the ARGUMENTS means the namespace is `desk__` plus a
 * closed enum of verbs, and an alias can never spell a tool name.
 *
 * It also collapses N peers x M verbs schemas into M, which matters: tool
 * definitions live at the cached prompt prefix, where size is permanent.
 *
 * The address is not free-form: `peer` carries an `enum` of exactly the aliases
 * that granted THAT verb. The enum is an advisory hint to the model; the same
 * list re-checked in the parser is the enforcement.
 *
 * ── Absent, not present-and-refused ────────────────────────────────────────
 *
 * A verb nobody granted has NO schema, and a peer that granted only `status`
 * appears in no other verb's enum. Advertising a capability that always answers
 * "denied" teaches the model to retry it and burns the run's turn budget on a
 * refusal — the same failure `CANVAS_REFUSED_TOOLS` exists to document. It also
 * discloses the shape of the grant we declined to give.
 *
 * The same argument bounds the surface from OUR side: see
 * {@link DESK_SENDABLE_VERBS}.
 *
 * ── What this module discloses, and to whom (accepted risk) ────────────────
 *
 * The emitted schemas write the pairing graph — every peer alias and its exact
 * granted-verb set — into the cached prompt prefix, which is sent to a
 * third-party model provider (OpenRouter / the DeepMyst gateway). Aliases are
 * human-typed and plausibly carry employer or colleague names. This is inherent
 * to putting the address in the arguments (the per-alias function name of §3.8
 * discloses the same thing) and is accepted, NOT mitigated — but it is why the
 * gate is a required argument rather than an assumed caller obligation: with no
 * peers, or with the gate shut, the disclosure is `[]`.
 *
 * ── Namespace: `desk__` here, `desk.` on the wire (deliberate) ─────────────
 *
 * `DeskMcpBridge.TOOL_PREFIX` is `desk.`. The two are NOT a drift: a native
 * function name must match `^[A-Za-z0-9_-]{1,64}$` for the OpenAI-compatible
 * tool schema, which excludes `.`, while the MCP tool namespace conventionally
 * uses it. A reviewer grepping one prefix therefore sees one half of the
 * protocol on purpose; `deskTools.test.ts` pins that the divergence is forced
 * by the character class and not an accident.
 *
 * ── Purity ────────────────────────────────────────────────────────────────
 *
 * This module is inside `src/services/desk/`, so `importGraph.test.ts` asserts
 * it can reach no exec, no socket, and no editor API. The one import outside
 * the directory is TYPE-ONLY and therefore erased at compile time; if a future
 * edit drops the `type` keyword, that test fails with the chain printed. The
 * roster arrives as plain data for the same reason: importing `DeskPeerBook`
 * to look a peer up would pull a manager (and its store) into a sealed module.
 */

import type { DeskVerb } from '../../types';
// Type-only: reusing the coordinator's schema shape keeps the two arrays
// concatenable without a cast and makes a shape change fail `tsc` here.
// A runtime import would drag in CanvasToolDispatch -> vscode.
import type { CoordinatorTool } from '../coordinatorTools';
import { DESK_VERBS, LIMITS, validateAlias, validateCall } from './DeskContract';

/** The schema shape emitted here — identical to a coordinator function tool. */
export type DeskToolSchema = CoordinatorTool;

/** Every Desk function is namespaced so it can never collide with a built-in. */
export const DESK_TOOL_PREFIX = 'desk__';

/**
 * Upper bound on aliases in one `peer` enum.
 *
 * Rosters are human-sized, so this should never bind. It exists because the
 * enum is remote-influenced in length (a peer roster grows with pairings) and
 * sits at the cached prefix. Beyond the cap, aliases are dropped in sorted
 * order so the prompt prefix stays STABLE across calls — an unstable tool array
 * invalidates the cache on every turn, which costs more than the peers do.
 *
 * Dropping fails safe, and that is now literally true rather than argued: the
 * parser authorizes against the SAME capped list, so a dropped peer is not
 * merely un-advertised, it is unreachable on the native lane.
 */
export const DESK_MAX_PEERS_PER_VERB = 32;

/**
 * The verbs THIS machine is willing to emit, regardless of what a peer says it
 * grants.
 *
 * Two independent reasons, either sufficient:
 *
 * 1. Nothing can serve the others yet. `DeskDispatch.IMPLEMENTED` is
 *    `{status, locate}`; `consult`/`review` need the sealed serving turn of
 *    Phase 4 and are deliberately absent rather than stubbed. Advertising
 *    `assign` today means the model spends a turn — and up to `LIMITS.detail`
 *    (20,000) characters of egress — on a request whose only possible answer is
 *    `unknown verb`. That is exactly the present-and-refused failure the
 *    section above forbids.
 * 2. `DeskToolPeer.verbs` is a grant the REMOTE side proposed at pairing. A
 *    local ceiling on what we will ever send means a hostile or compromised
 *    peer cannot widen our outbound surface by claiming to grant more.
 *
 * WIDEN THIS DELIBERATELY, in the same commit that makes the verb servable:
 * add the verb here, and `deskTools.test.ts` will require that
 * `DeskDispatch.dispatch` actually serves it (the twin-drift test). The
 * per-verb argument schemas below stay complete for all seven, so widening is
 * one line and no schema archaeology.
 */
export const DESK_SENDABLE_VERBS: readonly DeskVerb[] = Object.freeze(['status', 'locate'] as DeskVerb[]);

/**
 * The three preconditions a Desk call has, as named booleans.
 *
 * They are parameters, not a lookup, because this module is sealed (no
 * `vscode`, no settings reader) — and because a precondition the caller can
 * forget is not a precondition. Each must be exactly `true`; anything else,
 * including a truthy non-boolean, closes the surface. Mirrors
 * `_mystiMcpToolsEnabled`.
 */
export interface DeskGate {
  /** Machine-scoped `mysti.desk.enabled`. A workspace may not turn Desk on. */
  settingEnabled: boolean;
  /** `vscode.workspace.isTrusted`. An untrusted folder addresses no peer. */
  workspaceTrusted: boolean;
  /**
   * False in plan / read-only mode. A Desk call sends bytes off this machine,
   * which is an effect: it is not a read and must not survive a read-only mode
   * the way `look` does.
   */
  effectsAllowed: boolean;
}

/**
 * A paired peer as the tool surface sees it.
 *
 * Every field is LOCAL state, projected from `DeskPeerBook.getGrant(peerId)`:
 * `alias` from the record the local human typed (I12), `verbs` and `expiresAt`
 * from the `PeerGrant` this machine recorded. Nothing here is read off the
 * wire at call time — a peer cannot re-declare its own grant into our prompt.
 */
export interface DeskToolPeer {
  /** The LOCAL alias. Never remote-supplied (I12). */
  alias: string;
  /** `PeerGrant.verbs`. Still filtered: the store is a file on disk. */
  verbs: string[];
  /**
   * `PeerGrant.expiresAt` — absolute epoch ms. REQUIRED, and required as a
   * finite number: an optional expiry is an immortal grant, and a `NaN` one is
   * worse (`now >= NaN` is false, so the expiry check silently stops
   * expiring). A missing or non-finite value drops the peer.
   */
  expiresAt: number;
}

/**
 * Everything the surface is computed from. One object for both functions, so a
 * caller cannot advertise against one roster and parse against another.
 */
export interface DeskToolContext {
  gate: DeskGate;
  /** The live roster, freshly projected from `DeskPeerBook`. */
  peers: DeskToolPeer[];
  /**
   * `Date.now()` at the moment of the call. Injected so expiry is testable,
   * and validated: a non-finite `now` closes the surface rather than making
   * every `now >= expiresAt` comparison false.
   */
  now: number;
}

/** A native `desk__<verb>` call, parsed, validated and authorized. */
export interface DeskToolCall {
  peerAlias: string;
  /** Narrowed, not widened: the integrator indexes a dispatch map with this. */
  verb: DeskVerb;
  args: Record<string, unknown>;
}

const str = (description: string, maxLength?: number) =>
  (maxLength === undefined ? { type: 'string', description } : { type: 'string', description, maxLength });

/**
 * Freeze an object graph, not just its top level.
 *
 * The shallow `Object.freeze` this replaces protected `VERB_PARAMS.locate` but
 * not `VERB_PARAMS.locate.properties.kind.enum`, so a caller that reached two
 * levels into a returned schema could rewrite the table every LATER call is
 * built from — permanently, invisibly, at the cached prompt prefix. Freezing is
 * the backstop; {@link deepCopy} is the actual fix, and both are kept because
 * either one alone is one refactor away from silence.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as unknown as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The per-verb argument schema, MINUS `peer` (which every verb carries and
 * which is injected with a peer-specific enum below).
 *
 * These mirror the `validate` functions in `DeskContract`. They are advisory —
 * the validator is the authority and rejects anything these permit — so the
 * only cost of drift is a wasted call, never an unchecked one. The bounds are
 * read from `LIMITS` rather than restated, so a limit change moves both.
 *
 * Exhaustive over `DeskVerb`: adding a verb to the contract without adding it
 * here fails `tsc`. Kept complete even for verbs outside
 * {@link DESK_SENDABLE_VERBS}, so making one sendable is a one-line change.
 */
const VERB_PARAMS: Readonly<Record<DeskVerb, { properties: Record<string, unknown>; required: string[] }>> = deepFreeze({
  status: { properties: {}, required: [] },
  locate: {
    properties: {
      token: str('the EXACT symbol or path to find. A literal only — regex, globs and wildcards are rejected, not interpreted.', LIMITS.token),
      kind: { type: 'string', enum: ['symbol', 'path'], description: 'what the token names (default symbol)' },
    },
    required: ['token'],
  },
  consult: {
    properties: { question: str('a self-contained question answerable from their codebase. They see this verbatim.', LIMITS.question) },
    required: ['question'],
  },
  review: {
    properties: {
      baseSha: str('the 40-hex commit the diff is anchored to'),
      paths: { type: 'array', maxItems: LIMITS.arrayItems, items: str('workspace-relative POSIX path', LIMITS.path), description: 'the files to review' },
    },
    required: ['baseSha', 'paths'],
  },
  handoff: {
    properties: {
      title: str('one line naming the work being handed over', LIMITS.title),
      baseSha: str('the 40-hex commit the artifact is anchored to'),
    },
    required: ['title', 'baseSha'],
  },
  assign: {
    properties: {
      title: str('one line naming the proposed task', LIMITS.title),
      detail: str('everything the teammate needs to decide. They see this verbatim.', LIMITS.detail),
      proposalId: str('an id you choose for this proposal, so you can follow it up', LIMITS.id),
    },
    required: ['title', 'detail', 'proposalId'],
  },
  followup: {
    properties: { cursor: str('the cursor from a previous followup page', LIMITS.id) },
    required: [],
  },
});

/** What each verb is FOR, in the caller's voice. */
const VERB_ACTION: Readonly<Record<DeskVerb, string>> = Object.freeze({
  status: 'ask whether a paired teammate is available to be interrupted.',
  locate: 'ask where an exact symbol or path lives in a teammate’s repository.',
  consult: 'ask a teammate’s agent a question answered from their own codebase.',
  review: 'ask a teammate to review a set of files against a base commit.',
  handoff: 'hand work to a teammate as an artifact anchored at a base commit.',
  assign: 'propose a task to a teammate. It records a proposal and raises a card on their machine — it never starts work there.',
  followup: 'check the status of proposals you already sent.',
});

/**
 * The description the model reads.
 *
 * It leads with the fact that the call CROSSES A MACHINE BOUNDARY and names
 * what comes back, quoting `DESK_VERBS[verb].discloses` rather than restating
 * it — the disclosure sentence is written once, next to the validator that
 * enforces it, and is what a reviewer audits.
 */
function describe(verb: DeskVerb): string {
  return `Desk ${verb} — ${VERB_ACTION[verb]} This leaves THIS machine: your arguments are sent to the named teammate’s machine as one signed request the user must approve. What comes back from them: ${DESK_VERBS[verb].discloses}.`;
}

/** Every precondition must be exactly `true`. A truthy string is not consent. */
function gateIsOpen(gate: unknown): boolean {
  if (!gate || typeof gate !== 'object') { return false; }
  const g = gate as Record<string, unknown>;
  return g.settingEnabled === true && g.workspaceTrusted === true && g.effectsAllowed === true;
}

/**
 * The authoritative `verb -> allowed aliases` map. Empty means no Desk surface.
 *
 * Computed fresh on every call rather than cached: the cached PROMPT prefix may
 * legitimately be stale (rebuilding it every turn costs more than the peers
 * do), but authorization must not be. A grant revoked or expired mid-session
 * therefore keeps its stale advertisement and stops being callable, which is
 * the safe half of that trade — the alternative, trusting a stale cache at the
 * moment of send, is the TOCTOU this split exists to remove.
 *
 * Hostile input is dropped, not repaired: an alias that fails `validateAlias`
 * (wrong case, too long, a path fragment, a bidi override) is simply not a peer
 * as far as this surface is concerned. Repairing it would mint an address the
 * roster does not contain.
 */
function deskSurface(ctx: DeskToolContext): Map<string, string[]> {
  const surface = new Map<string, string[]>();
  if (!ctx || typeof ctx !== 'object') { return surface; }
  if (!gateIsOpen(ctx.gate)) { return surface; }

  // Fail CLOSED on an unusable clock. `now >= expiresAt` is false for NaN, so
  // an unvalidated `now` would not merely mis-expire — it would disable expiry
  // entirely while every other check kept passing.
  const now = ctx.now;
  if (typeof now !== 'number' || !Number.isFinite(now)) { return surface; }

  const peers = ctx.peers;
  if (!Array.isArray(peers) || peers.length === 0) { return surface; }

  // ONE pass over the roster, and each field read ONCE into a local. A getter
  // or Proxy `verbs` that returns an array to `Array.isArray` and something
  // else to `.some` would otherwise throw out of the middle of tool assembly.
  const granted = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  for (const p of peers) {
    if (!p || typeof p !== 'object') { continue; }
    const alias = validateAlias(p.alias);
    if (!alias.ok) { continue; }
    const verbs = p.verbs;
    if (!Array.isArray(verbs)) { continue; }
    const expiresAt = p.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) { continue; }
    // Mirrors `DeskPeerBook.getGrant`: an expired grant is not a grant.
    if (now >= expiresAt) { continue; }
    if (granted.has(alias.value)) {
      // Two live records claiming one alias means the store was edited or a
      // pairing raced. Routing is now ambiguous, so BOTH are dropped rather
      // than resolved by array order — first-wins would make a re-ordering of
      // the roster file an authorization change.
      ambiguous.add(alias.value);
      continue;
    }
    const set = new Set<string>();
    for (const v of verbs) { if (typeof v === 'string') { set.add(v); } }
    granted.set(alias.value, set);
  }
  for (const a of ambiguous) { granted.delete(a); }

  // Iterating the CLOSED sendable table is what confines the namespace: a verb
  // name that is not in this list is never asked about, so a roster entry
  // granting `toString`, `constructor` or `bash` reaches nothing. (An earlier
  // `isDeskVerb(v)` filter on the roster side claimed this property; it was
  // removed rather than kept, because it was strictly shadowed by this loop and
  // an unkillable guard makes the suite certify safety it does not enforce.)
  for (const verb of DESK_SENDABLE_VERBS) {
    const aliases: string[] = [];
    for (const [alias, verbSet] of granted) {
      if (verbSet.has(verb)) { aliases.push(alias); }
    }
    if (aliases.length === 0) { continue; }
    // Sorted BEFORE the cap so the same roster always yields the same prefix,
    // and so the cap drops a deterministic tail rather than whoever loaded last.
    surface.set(verb, aliases.sort().slice(0, DESK_MAX_PEERS_PER_VERB));
  }
  return surface;
}

/**
 * The Desk tool schemas for the peers and verbs actually available.
 *
 * Returns `[]` when nothing is reachable — no gate, no peers, nothing granted,
 * an unusable clock — so a coordinator in any of those states sees no Desk
 * surface at all, not an empty category it will try to use.
 *
 * Typed `unknown[]` on purpose: the caller splices these into the coordinator's
 * tool array and this module must not become the place that owns that array's
 * type. Every entry is a {@link DeskToolSchema}; {@link isDeskToolSchema} is
 * exported so the splice site can narrow without a cast.
 */
export function deskToolSchemas(ctx: DeskToolContext): unknown[] {
  const surface = deskSurface(ctx);
  if (surface.size === 0) { return []; }

  const tools: DeskToolSchema[] = [];
  for (const verb of DESK_SENDABLE_VERBS) {
    const aliases = surface.get(verb);
    if (!aliases || aliases.length === 0) { continue; }

    const spec = VERB_PARAMS[verb];
    tools.push({
      type: 'function',
      function: {
        name: `${DESK_TOOL_PREFIX}${verb}`,
        description: describe(verb),
        parameters: {
          type: 'object',
          properties: {
            // First, so the model reads the address before the payload.
            peer: { type: 'string', enum: [...aliases], description: 'which paired teammate to ask (local alias). Only the listed values exist.' },
            // Deep-copied per call: a caller that mutates a returned schema at
            // ANY depth must not be able to rewrite the table every later call
            // is built from.
            ...(deepCopy(spec.properties) as Record<string, unknown>),
          },
          required: ['peer', ...spec.required],
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

/**
 * Narrow one entry of {@link deskToolSchemas}' return value.
 *
 * Exported so the integrator gets the type back without writing the cast this
 * module refused to make for it — a cast at the splice site is the one place a
 * shape change would not be a compile error.
 */
export function isDeskToolSchema(v: unknown): v is DeskToolSchema {
  if (!v || typeof v !== 'object') { return false; }
  const t = v as { type?: unknown; function?: { name?: unknown } };
  return t.type === 'function'
    && !!t.function
    && typeof t.function.name === 'string'
    && t.function.name.startsWith(DESK_TOOL_PREFIX);
}

/**
 * Copy an object graph to any depth.
 *
 * The predecessor copied ONE level and returned arrays by reference, so
 * `schema.properties.kind.enum.push('regex')` and
 * `schema.properties.paths.items.maxLength = 999999` both wrote straight
 * through to the module table. Input is a module-owned frozen literal, so there
 * are no cycles, no class instances and no `__proto__` key to worry about.
 */
function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(deepCopy); }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out[k] = deepCopy(v); }
    return out;
  }
  return value;
}

/** Own-property read. A value reachable only through the prototype is absent. */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/**
 * Keys that must never appear as OWN properties of a model-supplied argument
 * object. `JSON.parse` makes `__proto__` an own key, so an args blob can carry
 * one; copying it into a fresh object with `[k] = v` would then set that
 * object's prototype. Rejecting is cheaper to reason about than filtering, and
 * matches the contract's drop-do-not-repair rule.
 *
 * `constructor` and `prototype` are load-bearing for any verb whose validator
 * IGNORES unknown keys (`locate` normalises to `{token, kind}` and would
 * happily accept a call carrying either); only `status` is protected by its
 * own no-arguments rule. Tests cover them through `locate` for that reason.
 */
const POISON_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Parse a native tool call into an AUTHORIZED Desk call, or null.
 *
 * Null, never a repaired call: the coordinator's dispatch treats a `null` as
 * "not a Desk tool" and falls through to its existing handling, which answers
 * the model with an error it can act on. Guessing an argument here would mean
 * sending a request across a machine boundary that the model did not write.
 *
 * What a non-null return now means, in order:
 *   1. the name is `desk__` + a verb in {@link DESK_SENDABLE_VERBS};
 *   2. the gate was open and the clock usable;
 *   3. `peer` is a well-formed alias that is UNAMBIGUOUSLY in the roster, with
 *      a live grant, that granted THIS verb, and that survived the enum cap —
 *      i.e. exactly the address the model was offered;
 *   4. the arguments passed `DeskContract`'s validator and are returned
 *      NORMALIZED, so unknown keys are gone.
 *
 * What it still does NOT mean: that the grant is live at the moment of SEND.
 * The dispatch site re-resolves through `DeskPeerBook.getGrant(peerId)` and
 * re-checks `grant.verbs.includes(verb)` immediately before transmitting,
 * because this roster is a snapshot and a revoke can land between the two.
 */
export function toolCallToDeskCall(name: string, args: unknown, ctx: DeskToolContext): DeskToolCall | null {
  if (typeof name !== 'string' || !name.startsWith(DESK_TOOL_PREFIX)) { return null; }

  // Exactly one segment after the prefix. `desk__locate__alice` (the shape
  // plans/21 first sketched) is NOT accepted: it would let an alias ride in the
  // namespace, which is the collision this design removed. It is rejected by
  // the surface lookup below — `'locate__alice'` is not a key — rather than by
  // a separate `isDeskVerb` guard that `validateCall` would only re-run.
  const verb = name.slice(DESK_TOOL_PREFIX.length);

  // THE authorization step. Unknown verb, un-sendable verb, shut gate, unusable
  // clock, empty roster and ungranted verb all collapse to the same `null`, so
  // a model cannot tell which of them refused it and cannot enumerate the
  // grants it does not have (mirrors `DeskDispatch`'s single `unknown verb`).
  const allowedAliases = deskSurface(ctx).get(verb);
  if (!allowedAliases) { return null; }

  if (args === null || typeof args !== 'object' || Array.isArray(args)) { return null; }
  const o = args as Record<string, unknown>;
  if (POISON_KEYS.some(k => Object.prototype.hasOwnProperty.call(o, k))) { return null; }

  const alias = validateAlias(own(o, 'peer'));
  if (!alias.ok) { return null; }
  if (!allowedAliases.includes(alias.value)) { return null; }

  // `peer` is addressing, not payload, and several verbs reject unknown keys
  // (`status` takes no arguments at all), so it is removed before validation
  // rather than tolerated inside it.
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'peer') { continue; }
    rest[k] = v;
  }

  const call = validateCall(verb, rest);
  if (!call.ok) { return null; }

  // The NORMALIZED args, not the model's: every field here came back out of a
  // validator, so unknown keys are already gone.
  return { peerAlias: alias.value, verb: call.value.verb, args: call.value.args };
}
