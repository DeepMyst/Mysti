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
 * DeskDispatch (Plan 21 Phase 1, invariants I10/I11) — the single inbound
 * entry point for a served Desk request.
 *
 * ── The security claim is an import list ───────────────────────────────────
 *
 * This module, and everything reachable from it, must never import
 * `MystiLocalExec`, `MystiSandbox`, `CollaboratorPool`, `McpClient`,
 * `McpConfigManager`, `DevServerManager`, `child_process`, or a writing `fs`
 * API. That is asserted mechanically by
 * `tests/services/desk/importGraph.test.ts` over the transitive module graph,
 * so "a remote request cannot write, spawn, or reach the network" is a
 * property you verify by reading a list — not by reasoning about what a model
 * might decide to do.
 *
 * ── Authorization-scoped discovery ─────────────────────────────────────────
 *
 * An ungranted verb is INVISIBLE, not refused: `listVerbs` omits it and
 * `dispatch` answers `unknown verb` — byte-identical to a genuinely unknown
 * one. A caller must not be able to enumerate the capabilities it was denied,
 * because that map is exactly what an attacker needs to choose a target.
 *
 * ── Phase 1 scope ──────────────────────────────────────────────────────────
 *
 * Only `status` and `locate` are served here: the two verbs that need no model
 * turn and disclose no content. `consult`/`review` need the sealed serving
 * turn (Phase 4) and are deliberately absent rather than stubbed, so there is
 * no half-built path to a model.
 */

import type { DeskCallResult, DeskScopeSpec, DeskVerb, PeerGrant } from '../../types';
import { DESK_VERBS, validateCall } from './DeskContract';
import { DeskIndex } from './DeskIndex';

/** Owner-typed availability. Every field is written by the LOCAL human. */
export interface DeskStatus {
  availability: 'available' | 'busy' | 'dnd' | 'offline';
  /** Free text the owner typed, e.g. "auth refresh rewrite". Never a path. */
  focus: string | null;
}

/** Everything the dispatcher is allowed to know. No process, no socket. */
export interface DispatchContext {
  /** The resolved read boundary for this request. */
  scope: DeskScopeSpec;
  /** Index built for `scope`; rebuilt when `scopeVersion` moves. */
  index: DeskIndex;
  /** The calling peer's grant, already verified by the transport. */
  grant: PeerGrant;
  /** Owner-typed status, or null when the owner published none. */
  status: DeskStatus | null;
  /** Milliseconds since epoch. Injected so expiry is testable. */
  now: number;
}

/** Verbs this phase can actually serve. */
const IMPLEMENTED: ReadonlySet<DeskVerb> = new Set<DeskVerb>(['status', 'locate']);

function denied(error: string): DeskCallResult {
  return { ok: false, error };
}

/**
 * Is this verb both granted AND live?
 *
 * An expired grant behaves exactly like an absent one — same message, same
 * shape — so grant lifetime cannot be probed by watching the error change.
 */
function isGranted(grant: PeerGrant, verb: DeskVerb, now: number): boolean {
  if (grant.expiresAt <= now) { return false; }
  return grant.verbs.includes(verb);
}

/**
 * The verbs this peer may see. Everything else is not merely refused — it is
 * absent from discovery entirely.
 */
export function listVerbs(grant: PeerGrant, now: number): DeskVerb[] {
  return (Object.keys(DESK_VERBS) as DeskVerb[])
    .filter(v => IMPLEMENTED.has(v) && isGranted(grant, v, now));
}

/**
 * Serve one request.
 *
 * Pure: same inputs, same output, no I/O of its own. Everything privileged —
 * reading files, resolving the scope, verifying a signature — happened before
 * this was called, and the results arrive as plain data on `ctx`.
 */
export function dispatch(
  verb: unknown,
  args: unknown,
  ctx: DispatchContext,
): DeskCallResult {
  // 1. Shape. An unknown verb and an ungranted one are indistinguishable.
  const call = validateCall(verb, args);
  if (!call.ok) {
    // `unknown verb` is passed through verbatim; an argument error names the
    // field, which is safe — the caller supplied it and already knows it.
    return denied(call.error);
  }

  // 2. Authorization, BEFORE any work. Note the identical message.
  if (!IMPLEMENTED.has(call.value.verb) || !isGranted(ctx.grant, call.value.verb, ctx.now)) {
    return denied('unknown verb');
  }

  switch (call.value.verb) {
    case 'status':
      return serveStatus(ctx);
    case 'locate':
      return serveLocate(call.value.args as { token: string; kind: 'symbol' | 'path' }, ctx);
    default:
      // Unreachable while IMPLEMENTED holds two verbs; kept so adding one to
      // the table without adding a case here fails loudly rather than serving
      // an empty result.
      return denied('unknown verb');
  }
}

/**
 * `status` — owner-typed strings only.
 *
 * Never a filesystem path, a repository URL, or a file name. Every field was
 * typed by the owner for publication, so there is nothing here to redact.
 */
function serveStatus(ctx: DispatchContext): DeskCallResult {
  if (!ctx.status) {
    // Constant shape: "published nothing" and "is offline" look the same.
    return { ok: true, payload: { availability: 'offline', focus: null } };
  }
  return {
    ok: true,
    payload: { availability: ctx.status.availability, focus: ctx.status.focus },
  };
}

/**
 * `locate` — coordinates only.
 *
 * The response is constant-shape and count-free. A miss returns an empty hit
 * list, identical whether the scope is empty, the token is absent, or the
 * repository is enormous — there is no signal to differentiate.
 */
function serveLocate(
  args: { token: string; kind: 'symbol' | 'path' },
  ctx: DispatchContext,
): DeskCallResult {
  // The index was built for a scope; if the scope has since moved, refuse
  // rather than answer from a stale boundary that may be wider than the
  // current one.
  if (ctx.index.scopeVersion !== ctx.scope.scopeVersion) {
    return denied('scope-changed');
  }

  const hits = ctx.index.lookup(args.token, args.kind);
  return {
    ok: true,
    payload: {
      // Path, line and the echoed symbol. No content, no counts, no totals.
      hits: hits.map(h => ({ path: h.path, line: h.line, ...(h.symbol ? { symbol: h.symbol } : {}) })),
    },
  };
}
