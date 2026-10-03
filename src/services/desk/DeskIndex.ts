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
 * DeskIndex (Plan 21 Phase 1, invariant I4) — exact-token coordinate lookup
 * over the shared scope.
 *
 * ── Why this is an index and not a search ──────────────────────────────────
 *
 * A search verb that accepts a pattern is a blind oracle. Ask for
 * `AKIA[A-Z0-9]{16}`, read back "1 match", then binary-search the secret out
 * one character class at a time — with zero file content ever returned and
 * zero approval cards ever raised. Rate limiting does not fix it; it only
 * changes how long it takes.
 *
 * So the caller supplies a LITERAL, and it is looked up in a Map. There is no
 * code path from caller input to a `RegExp` constructor, to a glob, or to a
 * substring scan of local bytes.
 *
 * The regexes in this file run at INDEX time over our own files, never over
 * anything a caller sent. That distinction is the whole of I4: patterns over
 * local bytes are fine, patterns *chosen by a remote party* are not.
 *
 * ── Constant shape, no counts ──────────────────────────────────────────────
 *
 * A response never reveals how much was searched. "0 matches in 312 files" is
 * itself disclosure: the file count is a fingerprint of a private repository,
 * and a differential between two queries leaks structure. Results are capped
 * and carry no totals.
 */

import type { DeskScopeSpec } from '../../types';
import { isInScope } from './DeskScope';

/** One coordinate. Never any file content. */
export interface LocateHit {
  path: string;
  /** 1-based line number, or 0 for a path-only hit. */
  line: number;
  /** The matched symbol, echoed so the caller can confirm what was found. */
  symbol?: string;
}

/** Where the index gets its bytes. Injected so this module needs no fs. */
export interface IndexSource {
  /** Candidate workspace-relative paths. Filtered against the scope here. */
  paths: string[];
  /** Return a file's text, or null when it cannot be read or is binary. */
  readText(path: string): string | null;
}

/** Hard cap on hits returned for one lookup — a fan-out bound, not a UI one. */
export const MAX_HITS = 20;

/** Files worth extracting symbols from. Anything else is path-indexed only. */
const INDEXABLE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|c|h|cc|cpp|hpp|m|mm)$/i;

/** Skip a file that is almost certainly generated or vendored. */
const SKIP_PATH_RE = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__)(\/|$)/;

/** Don't index a file larger than this; a bundle contributes noise, not signal. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Declaration forms we extract, applied to OUR OWN source at index time.
 *
 * Deliberately shallow: this is a coordinate index, not a parser. A missed
 * symbol costs a caller one unnecessary `consult`; a wrong one costs nothing
 * but a stale coordinate they can see is stale. Neither justifies a tree-sitter
 * dependency here.
 */
const DECL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /\bdef\s+([A-Za-z_][\w]*)/,          // python
  /\bfunc\s+([A-Za-z_][\w]*)/,         // go
  /\bfn\s+([A-Za-z_][\w]*)/,           // rust
  /\bstruct\s+([A-Za-z_][\w]*)/,
];

/**
 * An exact-token index over the shared scope.
 *
 * Build it once per scope version and reuse it; `scopeVersion` is what tells a
 * caller whether a cached index is still valid.
 */
export class DeskIndex {
  private readonly _symbols = new Map<string, LocateHit[]>();
  private readonly _paths = new Map<string, LocateHit[]>();
  public readonly scopeVersion: string;

  private constructor(scopeVersion: string) {
    this.scopeVersion = scopeVersion;
  }

  /**
   * Build an index for `scope` from `source`.
   *
   * Out-of-scope paths are dropped BEFORE any read, so the index cannot hold a
   * coordinate the scope would not permit disclosing — the read boundary and
   * the index boundary are the same boundary.
   */
  static build(scope: DeskScopeSpec, source: IndexSource): DeskIndex {
    const index = new DeskIndex(scope.scopeVersion);
    if (scope.allow.length === 0) { return index; }

    for (const path of source.paths) {
      if (SKIP_PATH_RE.test(path)) { continue; }
      if (!isInScope(scope, path)) { continue; }

      index._addPathTokens(path);

      if (!INDEXABLE_EXT_RE.test(path)) { continue; }
      const text = source.readText(path);
      if (text === null || text.length > MAX_FILE_BYTES) { continue; }
      index._addSymbols(path, text);
    }
    return index;
  }

  /** Index the path's own segments and basename, so `locate` can find files. */
  private _addPathTokens(path: string): void {
    const segments = path.split('/');
    const basename = segments[segments.length - 1];
    const stem = basename.replace(/\.[^.]+$/, '');
    for (const token of new Set([basename, stem, ...segments])) {
      if (!token) { continue; }
      this._push(this._paths, token, { path, line: 0 });
    }
  }

  private _addSymbols(path: string, text: string): void {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Cheap pre-filter: a very long line is minified, not source.
      if (line.length > 500) { continue; }
      for (const pattern of DECL_PATTERNS) {
        const m = pattern.exec(line);
        if (m && m[1]) {
          this._push(this._symbols, m[1], { path, line: i + 1, symbol: m[1] });
        }
      }
    }
  }

  private _push(map: Map<string, LocateHit[]>, key: string, hit: LocateHit): void {
    let hits = map.get(key);
    if (!hits) { hits = []; map.set(key, hits); }
    // Bound per-token growth so one popular identifier cannot dominate memory.
    if (hits.length >= MAX_HITS) { return; }
    if (hits.some(h => h.path === hit.path && h.line === hit.line)) { return; }
    hits.push(hit);
  }

  /**
   * Look up a literal token.
   *
   * `token` is used ONLY as a Map key. It is never compiled, never concatenated
   * into a pattern, and never compared by substring.
   */
  lookup(token: string, kind: 'symbol' | 'path'): LocateHit[] {
    const map = kind === 'symbol' ? this._symbols : this._paths;
    const hits = map.get(token);
    // A fresh array so a caller cannot mutate the index through its result.
    return hits ? hits.slice(0, MAX_HITS) : [];
  }

  /**
   * Index size, for diagnostics on THIS machine only.
   *
   * Never include this in a response: a repository's symbol count is a
   * fingerprint, and a differential between two queries leaks structure.
   */
  localStats(): { symbols: number; paths: number } {
    return { symbols: this._symbols.size, paths: this._paths.size };
  }
}
