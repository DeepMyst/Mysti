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
 * DeskScope (Plan 21 Phase 1, invariant I3) — the read boundary for a served
 * request.
 *
 * ── Enforced at the READ boundary, not at egress ───────────────────────────
 *
 * The scope is resolved once per request and passed into the serving turn's
 * read tools. A path outside it returns not-found, so out-of-scope bytes never
 * enter the serving model's context at all. That ordering is the whole point:
 * once a byte is in the context, no amount of "summarise, don't quote"
 * instruction can be relied on to keep it from coming back out in paraphrase.
 * Egress screening is the SECOND line, never the first.
 *
 * ── Intersection, so a repository can only narrow ──────────────────────────
 *
 * The effective scope is the workspace's `.mysti/desk-share.json` INTERSECTED
 * with the machine-scoped `mysti.desk.shareCeiling`. A cloned repository can
 * therefore share less than the ceiling but never more — the same
 * only-lower-authority rule `settingsClamp` applies to modes and access
 * levels, expressed here as set intersection because paths have no ordering
 * to clamp against.
 *
 * This module has no vscode and no fs import: both the ceiling and the share
 * file arrive as plain data, so the resolver is a pure function and the
 * privileged reads stay at the caller's boundary.
 */

import type { DeskScopeSpec } from '../../types';
import { validatePath } from './DeskContract';

/** Raw inputs to scope resolution — all plain data, all already read. */
export interface ScopeInputs {
  /** Machine-scoped ceiling. `undefined` means "no ceiling configured". */
  ceiling?: string[];
  /** Parsed `.mysti/desk-share.json` contents, if the file exists. */
  share?: { allow?: unknown; version?: unknown };
}

/** Nothing shared. The safe default whenever anything is missing or malformed. */
export const EMPTY_SCOPE: DeskScopeSpec = Object.freeze({
  allow: Object.freeze([]) as unknown as string[],
  scopeVersion: 'empty',
});

/**
 * A scope prefix: a workspace-relative directory path, or `*` meaning "the
 * whole workspace". Validated with the same path rules as everything else,
 * so a share file cannot smuggle a traversal into the read boundary.
 */
function normalizePrefix(raw: unknown): string | null {
  if (raw === '*') { return '*'; }
  if (typeof raw !== 'string') { return null; }
  // Tolerate a trailing slash in hand-written config, then validate strictly.
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) { return null; }
  const v = validatePath(trimmed, 'scope');
  return v.ok ? v.value : null;
}

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) { return []; }
  const out: string[] = [];
  for (const entry of raw) {
    const p = normalizePrefix(entry);
    // Drop, don't repair: an unparseable entry narrows the scope rather than
    // being guessed at.
    if (p !== null && !out.includes(p)) { out.push(p); }
  }
  return out;
}

/** Is `path` inside (or equal to) the directory prefix `prefix`? */
function underPrefix(path: string, prefix: string): boolean {
  if (prefix === '*') { return true; }
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Intersect two prefix lists.
 *
 * A prefix survives when it is inside the other list — so `src/billing` ∩
 * `src` is `src/billing` (the NARROWER of the two), never `src`. Widening is
 * unrepresentable by construction rather than checked for.
 */
function intersect(a: string[], b: string[]): string[] {
  if (a.includes('*')) { return [...b]; }
  if (b.includes('*')) { return [...a]; }
  const out: string[] = [];
  for (const p of a) {
    if (b.some(q => underPrefix(p, q)) && !out.includes(p)) { out.push(p); }
  }
  for (const q of b) {
    if (a.some(p => underPrefix(q, p)) && !out.includes(q)) { out.push(q); }
  }
  return out;
}

/**
 * Resolve the effective scope.
 *
 * Fails closed in every ambiguous case: no ceiling configured, no share file,
 * a malformed share file, or an empty intersection all yield {@link EMPTY_SCOPE}.
 * "Nothing configured" must never mean "everything shared".
 */
export function resolveScope(inputs: ScopeInputs): DeskScopeSpec {
  const ceiling = normalizeList(inputs.ceiling);
  const share = normalizeList(inputs.share?.allow);

  // An unset ceiling is not an open door.
  if (ceiling.length === 0 || share.length === 0) { return EMPTY_SCOPE; }

  const allow = intersect(share, ceiling);
  if (allow.length === 0) { return EMPTY_SCOPE; }

  const version = typeof inputs.share?.version === 'string' && inputs.share.version.length <= 64
    ? inputs.share.version
    : 'v0';

  // scopeVersion keys the approved-disclosure cache (I35): it must change
  // whenever the shared SET changes, or a cached answer could outlive the
  // permission that produced it. Derived from the resolved list, not just the
  // declared version, so editing the share file cannot forget to bump it.
  const scopeVersion = `${version}:${[...allow].sort().join(',')}`;

  return { allow, scopeVersion };
}

/**
 * Is a workspace-relative path readable under this scope?
 *
 * The path is re-validated here rather than trusted from the caller, so this
 * predicate is safe to use as the last check before a read even if a future
 * call site forgets to validate.
 */
export function isInScope(scope: DeskScopeSpec, path: string): boolean {
  if (scope.allow.length === 0) { return false; }
  const v = validatePath(path, 'path');
  if (!v.ok) { return false; }
  return scope.allow.some(prefix => underPrefix(v.value, prefix));
}

/** Filter a list of paths to those in scope. Order preserved. */
export function filterInScope(scope: DeskScopeSpec, paths: string[]): string[] {
  return paths.filter(p => isInScope(scope, p));
}
