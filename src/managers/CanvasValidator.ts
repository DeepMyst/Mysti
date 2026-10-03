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
 */

import { pageSource } from '../canvas/pageMigration';
import { walk } from '../canvas/doc/DocNode';
import type { CanvasArtifact, ArtifactPage } from '../types';

/**
 * The cheap, static sibling of `render_page_preview` (Plan 05 §6 / Phase 4.2):
 * a rule engine that catches common design defects without rendering. The
 * design sub-agent runs `validate_page` continuously and `render_page_preview`
 * (vision) only before declaring a page done.
 */

export interface PageValidationIssue {
  pageId: string;
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

export interface ValidatePageOptions {
  /** Rendered content height in design px, from the webview size reporter. */
  reportedContentHeight?: number;
}

/** Match `asset://...` references (stops at quote/paren/whitespace/angle bracket). */
const ASSET_REF_RE = /asset:\/\/[^\s"'`)<>]+/g;
/** Raw hex colors (3/4/6/8 digits) — theme tokens should be used instead. */
const RAW_HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Validate a single page against the static rules. Pure — no I/O, no rendering.
 */
export function validatePage(
  artifact: CanvasArtifact,
  page: ArtifactPage,
  opts: ValidatePageOptions = {},
): PageValidationIssue[] {
  const issues: PageValidationIssue[] = [];
  const add = (severity: PageValidationIssue['severity'], rule: string, message: string) =>
    issues.push({ pageId: page.id, severity, rule, message });

  // Plan 22 §3.1: the document is the truth, so "empty" is a doc question, not
  // a string-length question. The source view is still what the text rules
  // (hex colors, asset refs) read — a legacy page has one and a compiled page
  // gets its emitted JSX.
  const source = pageSource(page);
  const docNodes = countDocNodes(page.doc);

  // 1. Empty page.
  if (!source.trim() && docNodes <= 1) {
    add('error', 'empty-page', 'page has no document content and no legacy source');
    return issues; // nothing else to check
  }

  // 1b. A page whose source could not be compiled is not editable element-wise.
  if (page.compileError) {
    add('warning', 'legacy-page', `page source is outside the JSX subset (${page.compileError}) — it renders, but elements cannot be addressed`);
  }

  // 2. Missing action title on a deck page.
  if (artifact.kind === 'deck' && !page.actionTitle?.trim()) {
    add('warning', 'missing-action-title', 'deck page has no actionTitle (the slide\'s one-line takeaway)');
  }

  if (source) {
    // 3. Raw hex colors instead of theme tokens.
    const hexes = source.match(RAW_HEX_RE);
    if (hexes && hexes.length > 0) {
      add('warning', 'raw-hex', `${hexes.length} raw hex color(s) — use theme tokens for brand coherence`);
    }

    // 4. Unresolved asset:// references (not registered in the artifact).
    const registered = new Set(artifact.assets.map(a => a.ref));
    const refs = source.match(ASSET_REF_RE) ?? [];
    const unresolved = [...new Set(refs)].filter(r => !registered.has(r));
    for (const ref of unresolved) {
      add('error', 'unresolved-asset', `asset reference not registered in the artifact: ${ref}`);
    }
  }

  // 5. Content overflow (only when the webview reported a measured height).
  if (typeof opts.reportedContentHeight === 'number' && opts.reportedContentHeight > artifact.format.height) {
    add(
      'error',
      'overflow',
      `content height ${opts.reportedContentHeight}px exceeds the ${artifact.format.formatId} page height ${artifact.format.height}px`,
    );
  }

  return issues;
}

/** Node count for a page document, capped so a hostile tree cannot spin here. */
function countDocNodes(doc: ArtifactPage['doc']): number {
  if (!doc) { return 0; }
  let n = 0;
  for (const _node of walk(doc)) {
    void _node;
    if (++n > 4096) { break; }
  }
  return n;
}

/** Validate every page; returns a flat issue list across the artifact. */
export function validateArtifact(artifact: CanvasArtifact): PageValidationIssue[] {
  return artifact.pages.flatMap(p => validatePage(artifact, p));
}
