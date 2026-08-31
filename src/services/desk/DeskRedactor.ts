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
 * DeskRedactor (Plan 21, invariants I5/I21) — the last check before bytes
 * leave this machine.
 *
 * ── The second line, never the first ───────────────────────────────────────
 *
 * DeskScope is what actually keeps private bytes out of a response: it bounds
 * the READ, so out-of-scope content never enters the serving model's context
 * at all. This module exists for what gets past that — a credential committed
 * inside a shared file, or a citation pointing outside the scope because an
 * index went stale.
 *
 * Treating it as the primary control would be a mistake. A scanner can only
 * catch shapes it knows, and a model asked to "describe rather than quote" can
 * paraphrase a secret into text no pattern matches.
 *
 * ── Refuse, do not redact ──────────────────────────────────────────────────
 *
 * A hit REFUSES the whole response rather than stripping the offending span.
 * Two reasons. A partially-redacted answer is exactly the "truncation as a
 * flag" failure I21 forbids: the recipient cannot tell whether what they got
 * is complete, and a model on the other side will happily reason over a
 * mutilated document. And silently removing a secret teaches the sender
 * nothing, so the credential stays in the shared file and the next request
 * leaks it through a path the scanner does not know.
 *
 * Refusal is loud, recoverable, and fixes the actual problem.
 */

import { blocksEgress, describeEgressVerdict, scanEgress } from '../EgressScanner';
import type { DeskCallResult, DeskScopeSpec } from '../../types';
import { isInScope } from './DeskScope';

export type ScreenOutcome =
  | { ok: true; result: DeskCallResult }
  | { ok: false; reason: 'secret-detected' | 'citation-out-of-scope'; detail: string };

/** A citation carried by a consult/review answer. Coordinates only. */
export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * Collect every string reachable in a value, so screening cannot be dodged by
 * nesting a credential one level deeper than the scanner looks.
 */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 12) { return; }
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) {
    for (const v of value) { collectStrings(v, out, depth + 1); }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys are screened too: a credential used as an object key would
      // otherwise ride out untouched.
      out.push(k);
      collectStrings(v, out, depth + 1);
    }
  }
}

/**
 * Screen an outbound result.
 *
 * Every string in the payload is scanned, not just a designated "content"
 * field — a field name is a convention, and conventions drift.
 */
export function screenOutbound(result: DeskCallResult): ScreenOutcome {
  if (!result.ok) { return { ok: true, result }; }

  const strings: string[] = [];
  collectStrings(result.payload ?? {}, strings);

  // One joined scan rather than per-string: a secret split across adjacent
  // fields by a model's formatting would otherwise slip between them.
  const verdict = scanEgress(strings.join('\n'));
  if (blocksEgress(verdict)) {
    return {
      ok: false,
      reason: 'secret-detected',
      // The description names detector labels and counts, never values.
      detail: describeEgressVerdict(verdict),
    };
  }
  return { ok: true, result };
}

/**
 * Verify that every citation points inside the scope that produced it.
 *
 * A stale index or a model inventing a plausible path would otherwise disclose
 * the existence and location of a file the peer was never granted. Coordinates
 * are disclosure too, which is exactly why `locate` is scope-bounded.
 */
export function screenCitations(
  citations: Citation[],
  scope: DeskScopeSpec,
): ScreenOutcome | null {
  for (const c of citations) {
    if (!isInScope(scope, c.path)) {
      return {
        ok: false,
        reason: 'citation-out-of-scope',
        // The offending path is NOT echoed: doing so would disclose the very
        // thing the check exists to withhold.
        detail: 'an answer cited a path outside the shared scope',
      };
    }
    if (!Number.isInteger(c.startLine) || !Number.isInteger(c.endLine)
      || c.startLine < 1 || c.endLine < c.startLine) {
      return { ok: false, reason: 'citation-out-of-scope', detail: 'a citation had an invalid line range' };
    }
  }
  return null;
}

/**
 * The full outbound gate: citations first (cheap, and the more specific
 * failure), then a byte scan of everything.
 */
export function screen(
  result: DeskCallResult,
  scope: DeskScopeSpec,
  citations: Citation[] = [],
): ScreenOutcome {
  const citationFailure = screenCitations(citations, scope);
  if (citationFailure) { return citationFailure; }
  return screenOutbound(result);
}

/**
 * Convert a screening failure into the result the caller receives.
 *
 * Deliberately uninformative about WHAT was found: an attacker who can see
 * which detector fired learns the shape of the filter, and can iterate until
 * a payload passes. The local audit log keeps the detail; the wire does not.
 */
export function refusalResult(_outcome: Extract<ScreenOutcome, { ok: false }>): DeskCallResult {
  // Every screening failure collapses to ONE wire error on purpose. The
  // parameter is accepted (and ignored) so call sites read naturally and so
  // the local audit path has the typed outcome available — but distinguishing
  // "a secret was found" from "a citation escaped the scope" on the wire would
  // hand an attacker a signal to iterate against.
  return { ok: false, error: 'withheld' };
}
