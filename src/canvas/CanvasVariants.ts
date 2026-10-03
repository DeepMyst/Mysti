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
 * Plan 22 §4 "Beyond parity" / Phase 6 — **variants, in one field**.
 *
 * "Show me three directions for this screen, then keep the second one" is the
 * single most-asked-for thing a design tool does that a chat window cannot. On
 * the document model it costs a grouping rule and two op planners, because
 * everything it needs already exists:
 *
 * - `ArtifactPage.variantGroupId` (`src/types.ts`) — the one field;
 * - `{op:'page.duplicate', pageId, variantOf}` — the executor already writes
 *   `variantGroupId = op.variantOf ?? page.variantGroupId` and mints FRESH mids
 *   for the copy (`CanvasOpExecutor._applyV2`), so two variants are never one
 *   artboard wearing two hats;
 * - `{op:'page.remove', pageId}` — "use this one" is deleting the losers, and
 *   it is undoable like every other op because `page.remove`'s inverse is a
 *   full `page.add` of the snapshot.
 *
 * So this module plans ops and never touches state. Nothing here mutates an
 * artifact, calls the executor, or knows about receipts — the ops it returns go
 * through `CanvasOpExecutor.submit()` like a human's drag would, which is what
 * makes variants undoable, auditable and available to the agent for free.
 *
 * ## The group id is the origin page's id
 *
 * `page.setMeta` cannot write `variantGroupId` (its patch covers
 * `actionTitle`/`notes`/`format` only), so "start a variant group" must not
 * require mutating the original. It doesn't: the group id **is** the origin
 * page's id, and the origin is an implicit member of its own group. Members are
 * therefore:
 *
 *   `page.variantGroupId === G`  ∪  `page.id === G` (when at least one other
 *   page names `G`)
 *
 * which means generating variants is N `page.duplicate` ops and zero writes to
 * the page the user already has. A group whose origin was later adopted-away
 * keeps working — `originId` simply goes null and the survivors stay grouped.
 */

import type { ArtifactPage, CanvasArtifact } from '../types';
import type { CanvasOp } from './CanvasOps';
import { CANVAS_MAX_VARIANTS } from '../constants';
import { BOARD_COLUMN_PITCH } from './pageMigration';

/** One row of side-by-side directions. */
export interface VariantGroup {
  groupId: string;
  /** Members in artifact page order. Always length ≥ 1. */
  pages: ArtifactPage[];
  /** The page the group grew out of (`id === groupId`), or null if it is gone. */
  originId: string | null;
}

/** Gap between artboards laid out as a variant row, in design px. */
export const VARIANT_ROW_GAP_PX = 160;

/**
 * The group id to use when asking for more variants of `page`: its existing
 * group when it already belongs to one, otherwise its own id.
 */
export function variantGroupIdFor(page: ArtifactPage): string {
  return page.variantGroupId ?? page.id;
}

/**
 * Every variant group in the artifact, in first-member order.
 *
 * A group needs **two** members to exist: a lone page whose `variantGroupId`
 * happens to equal its own id is not a "row of directions", and rendering a
 * one-artboard variant row would be chrome that means nothing. Adopting a
 * variant therefore also dissolves its group, with no cleanup op required.
 */
export function variantGroups(pages: readonly ArtifactPage[]): VariantGroup[] {
  const named = new Set<string>();
  for (const p of pages) {
    if (p.variantGroupId) { named.add(p.variantGroupId); }
  }

  const order: string[] = [];
  const members = new Map<string, ArtifactPage[]>();
  for (const page of pages) {
    const groupId = page.variantGroupId ?? (named.has(page.id) ? page.id : null);
    if (!groupId) { continue; }
    let list = members.get(groupId);
    if (!list) { list = []; members.set(groupId, list); order.push(groupId); }
    list.push(page);
  }

  const out: VariantGroup[] = [];
  for (const groupId of order) {
    const list = members.get(groupId)!;
    if (list.length < 2) { continue; }
    out.push({ groupId, pages: list, originId: list.some(p => p.id === groupId) ? groupId : null });
  }
  return out;
}

/** The group `pageId` belongs to, or null when it is not part of a row. */
export function variantGroupOf(
  pages: readonly ArtifactPage[],
  pageId: string,
): VariantGroup | null {
  if (!pageId) { return null; }
  return variantGroups(pages).find(g => g.pages.some(p => p.id === pageId)) ?? null;
}

/** The siblings of `pageId` in its row (the row minus the page itself). */
export function variantSiblings(
  pages: readonly ArtifactPage[],
  pageId: string,
): ArtifactPage[] {
  const group = variantGroupOf(pages, pageId);
  if (!group) { return []; }
  return group.pages.filter(p => p.id !== pageId);
}

export interface PlanVariantsOptions {
  /**
   * How many directions to generate. Clamped to
   * `[1, CANVAS_MAX_VARIANTS]` — a model that asks for 200 directions gets 4,
   * because every one of them is a full artboard the user has to look at.
   */
  count?: number;
}

/**
 * Generate N side-by-side directions from one artboard.
 *
 * Deliberately **just duplicates**: the ops that make each copy *different*
 * (`el.setStyle`, `theme.setToken`, `page.setDoc`, …) are the ordinary op
 * algebra, applied to the ids the receipts hand back. Variants add no second
 * write path, which is the whole reason they cost one field.
 */
export function planVariants(page: ArtifactPage, opts: PlanVariantsOptions = {}): CanvasOp[] {
  const variantOf = variantGroupIdFor(page);
  const raw = Math.floor(Number(opts.count ?? 2));
  const count = Number.isFinite(raw) ? Math.min(CANVAS_MAX_VARIANTS, Math.max(1, raw)) : 1;
  const ops: CanvasOp[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({ op: 'page.duplicate', pageId: page.id, variantOf });
  }
  return ops;
}

/**
 * Title the artboards a `planVariants` run produced.
 *
 * Separate from {@link planVariants} because the new page ids only exist once
 * the duplicates have been applied — they arrive in `CanvasOpReceiptV2.pageId`.
 * `baseTitle` is normally the origin's `actionTitle`.
 */
export function planVariantLabels(
  newPageIds: readonly string[],
  baseTitle: string | undefined,
  startAt = 1,
): CanvasOp[] {
  const base = (baseTitle ?? '').trim();
  return newPageIds
    .filter(id => typeof id === 'string' && id.length > 0)
    .map((pageId, i) => ({
      op: 'page.setMeta' as const,
      pageId,
      patch: { actionTitle: variantTitle(base, startAt + i) },
    }));
}

/** `"Login" → "Login · B"` (A is the origin, so numbering starts at B). */
export function variantTitle(baseTitle: string, index: number): string {
  const letter = variantLetter(index);
  const base = baseTitle.trim().replace(/\s*·\s*[A-Z]{1,3}$/, '');
  return base ? `${base} · ${letter}` : `Variant ${letter}`;
}

/** 0→A, 1→B, … 25→Z, 26→AA. Bounded so a hostile index cannot loop forever. */
export function variantLetter(index: number): string {
  let i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  let out = '';
  for (let guard = 0; guard < 4; guard++) {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
    if (i < 0) { break; }
  }
  return out;
}

/**
 * "Use this one" — remove every other artboard in the row.
 *
 * Fails **closed** in both directions that matter: an unknown page (or one that
 * is not in a group) plans nothing rather than deleting something adjacent, and
 * the keeper is never in the returned ops, so this can never empty a design.
 * The survivor keeps its now-dangling `variantGroupId`; a one-member group is
 * not a group ({@link variantGroups}), so the row disappears from the UI with
 * no cleanup op — and `page.remove`'s inverse means Cmd+Z brings the losers
 * back.
 */
export function planAdoptVariant(
  pages: readonly ArtifactPage[],
  keepPageId: string,
): CanvasOp[] {
  const group = variantGroupOf(pages, keepPageId);
  if (!group) { return []; }
  if (!group.pages.some(p => p.id === keepPageId)) { return []; }
  return group.pages
    .filter(p => p.id !== keepPageId)
    .map(p => ({ op: 'page.remove' as const, pageId: p.id }));
}

export interface VariantLayoutOptions {
  /** Gap between artboards in the row (design px). */
  gap?: number;
  /** Anchor the row here instead of at the first member's current position. */
  origin?: { x: number; y: number };
}

/**
 * Lay a variant row out left-to-right so the directions are actually
 * side-by-side (the executor drops a duplicate at `boardPosForIndex(pageCount)`,
 * which wraps every 4 artboards and is wrong for a comparison row).
 *
 * Emits `page.move` ops ONLY for artboards that are not already where they
 * belong: a receipt per no-op move would be noise in the journal, in undo and
 * in the agent's `since[]`.
 */
export function planVariantLayout(
  artifact: Pick<CanvasArtifact, 'pages' | 'format'>,
  groupId: string,
  opts: VariantLayoutOptions = {},
): CanvasOp[] {
  const group = variantGroups(artifact.pages).find(g => g.groupId === groupId);
  if (!group) { return []; }

  const gap = numberOr(opts.gap, VARIANT_ROW_GAP_PX);
  const anchor = opts.origin ?? group.pages[0].boardPos;
  const x0 = numberOr(anchor?.x, 0);
  const y0 = numberOr(anchor?.y, 0);

  const ops: CanvasOp[] = [];
  let x = x0;
  for (const page of group.pages) {
    if (page.boardPos.x !== x || page.boardPos.y !== y0) {
      ops.push({ op: 'page.move', pageId: page.id, boardPos: { x, y: y0 } });
    }
    const width = numberOr(page.format?.width ?? artifact.format?.width, BOARD_COLUMN_PITCH);
    x += Math.max(1, width) + gap;
  }
  return ops;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
