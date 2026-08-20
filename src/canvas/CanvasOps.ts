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
 * Plan 22 §3.2 — the op algebra. ONE vocabulary, N producers.
 *
 * The set of ops an agent can perform is exactly the set the UI performs: a
 * human drag, a properties slider, an MCP `tools/call` and a `<canvas:NONCE>`
 * directive all produce the identical record and travel the identical path
 * through {@link CanvasOpExecutor}. That is the property a conformance test
 * asserts, and it is why the editor surface can be built before the agent
 * depends on it — if the human can't do it, the agent can't either.
 */

import type { DocNode, DocNodeInput, Mid, JsonValue, PinCell } from './doc/DocNode';
import type { CanvasFormatSpec, DesignTheme, CanvasAssetRecord } from '../types';

/** A new artboard. */
export interface NewPageSpec {
  /**
   * Usually absent — the host mints the id. Present when the op must recreate
   * an EXACT page: `page.remove`'s inverse is a `page.add`, and an undo that
   * restored the artboard under a different id would orphan every pin,
   * comment, selection and staged op that addresses it.
   */
  id?: string;
  doc: DocNode;
  actionTitle?: string;
  format?: CanvasFormatSpec;
  boardPos?: { x: number; y: number };
  variantGroupId?: string;
  notes?: string;
}

/**
 * Every mutation the canvas supports.
 *
 * Element ops carry a `mid`, which is what buys per-element conflict, per-cell
 * pinning and subtree locks. Page-scoped ops carry a `pageId`; artifact-scoped
 * ops carry neither and check `artifact.version` instead of `page.version`.
 */
export type CanvasOp =
  // ── artboard / board scope ──
  | { op: 'page.add'; page: NewPageSpec; index?: number }
  | { op: 'page.remove'; pageId: string }
  | { op: 'page.duplicate'; pageId: string; variantOf?: string }
  | { op: 'page.setMeta'; pageId: string; patch: { actionTitle?: string; notes?: string; format?: CanvasFormatSpec } }
  | { op: 'page.move'; pageId: string; boardPos: { x: number; y: number } }
  | { op: 'page.reorder'; orderedIds: string[] }
  /** Whole-artboard write. Coarse — the executor diffs it down to element ops. */
  | { op: 'page.setDoc'; pageId: string; doc: DocNode }
  // ── element scope: the direct-manipulation set ──
  | { op: 'el.setText'; pageId: string; mid: Mid; text: string }
  | { op: 'el.setStyle'; pageId: string; mid: Mid; style: Record<string, string | null> }
  | { op: 'el.setProp'; pageId: string; mid: Mid; name: string; value: JsonValue | null }
  | { op: 'el.insert'; pageId: string; parentMid: Mid; before: Mid | 'end'; node: DocNodeInput; slot?: string }
  | { op: 'el.remove'; pageId: string; mid: Mid }
  | { op: 'el.move'; pageId: string; mid: Mid; newParentMid: Mid; before: Mid | 'end'; slot?: string }
  | { op: 'el.replace'; pageId: string; mid: Mid; node: DocNodeInput }
  // ── artifact scope ──
  | { op: 'theme.set'; theme: DesignTheme }
  | { op: 'theme.setToken'; path: string; value: string }
  | { op: 'artifact.setFormat'; format: CanvasFormatSpec }
  | { op: 'asset.add'; asset: CanvasAssetRecord };

export type CanvasOpKindV2 = CanvasOp['op'];

/**
 * Every op kind, TS-enforced complete.
 *
 * A `Record<CanvasOpKindV2, true>` rather than an array: adding a variant to
 * the algebra without teaching the guard about it is a `tsc` failure. This is
 * the ONE copy — `src/webview/canvas/state.ts` and `src/canvas/CanvasBridge.ts`
 * both re-use it rather than each declaring their own, because a second copy of
 * this table is precisely how the three divergent canvas implementations
 * happened (§2.9).
 */
const OP_KINDS: Readonly<Record<CanvasOpKindV2, true>> = {
  'page.add': true,
  'page.remove': true,
  'page.duplicate': true,
  'page.setMeta': true,
  'page.move': true,
  'page.reorder': true,
  'page.setDoc': true,
  'el.setText': true,
  'el.setStyle': true,
  'el.setProp': true,
  'el.insert': true,
  'el.remove': true,
  'el.move': true,
  'el.replace': true,
  'theme.set': true,
  'theme.setToken': true,
  'artifact.setFormat': true,
  'asset.add': true,
};

/** Every op kind. Order is declaration order; treat it as a set. */
export const CANVAS_OP_KINDS: readonly CanvasOpKindV2[] = Object.keys(OP_KINDS) as CanvasOpKindV2[];

/** True when `value` names an op in the algebra. Hostile-key safe. */
export function isCanvasOpKind(value: unknown): value is CanvasOpKindV2 {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OP_KINDS, value);
}

/**
 * Shape guard for an op arriving from a transport (the canvas webview, a tool
 * call, a fenced directive). Only the discriminant is checked here — the
 * per-variant payload rules live in `CanvasOpExecutor._validateV2`, which is
 * the one place allowed to decide whether an op is *applicable*.
 */
export function isCanvasOpShape(value: unknown): value is CanvasOp {
  return !!value && typeof value === 'object' && isCanvasOpKind((value as { op?: unknown }).op);
}

/** Ops whose staleness is checked against `artifact.version`, not a page's. */
export const ARTIFACT_SCOPED_OPS: ReadonlySet<CanvasOpKindV2> = new Set<CanvasOpKindV2>([
  'theme.set', 'theme.setToken', 'artifact.setFormat', 'asset.add', 'page.reorder', 'page.add', 'page.remove',
]);

/** Ops that address a single element inside a page. */
export const ELEMENT_SCOPED_OPS: ReadonlySet<CanvasOpKindV2> = new Set<CanvasOpKindV2>([
  'el.setText', 'el.setStyle', 'el.setProp', 'el.insert', 'el.remove', 'el.move', 'el.replace',
]);

/** The page an op targets, or null for an artifact-scoped op. */
export function opPageId(op: CanvasOp): string | null {
  if ('pageId' in op && typeof op.pageId === 'string') { return op.pageId; }
  return null;
}

/** The element an op targets, or null. */
export function opMid(op: CanvasOp): Mid | null {
  if ('mid' in op && typeof op.mid === 'string') { return op.mid; }
  if (op.op === 'el.insert') { return op.parentMid; }
  return null;
}

/**
 * The cells an op writes on its target node — what pin enforcement checks.
 * Structural ops (insert/remove/move/replace) return `null`: they are not
 * cell-scoped, so they are governed by subtree locks rather than by pins.
 */
export function opCells(op: CanvasOp): PinCell[] | null {
  switch (op.op) {
    case 'el.setText': return ['text'];
    case 'el.setStyle': return Object.keys(op.style).map(p => `style.${p}`);
    case 'el.setProp': return [`props.${op.name}`];
    default: return null;
  }
}

/* ──────────────────────────── records & receipts ──────────────────────────── */

export type CanvasOpStatus = 'applied' | 'staged' | 'rejected' | 'stale' | 'superseded' | 'undone';

export interface CanvasOpRecordV2 {
  opId: string;
  /** One human drag = 1 txn; one agent turn = 1 txn keyed by runId. */
  txnId: string;
  /** The REAL chat turn / job id — never the literal string 'mcp'. */
  runId: string;
  /** STAMPED HOST-SIDE from the arriving channel. Never read from a payload. */
  author: 'user' | 'agent';
  actorId: string;
  op: CanvasOp;
  baseVersion?: number;
  /** Computed at apply — undo without whole-page snapshots. */
  inverse?: CanvasOp;
  status: CanvasOpStatus;
  ts: number;
}

/**
 * What a writer gets back. `ok` means the document actually changed.
 *
 * `since` is what makes a chain of edits need exactly ONE read: it carries the
 * ops committed after the writer's `baseVersion` that it has not seen, so the
 * agent does not have to re-read between every write.
 */
export interface CanvasOpReceiptV2 {
  opId: string;
  status: CanvasOpStatus;
  pageId?: string;
  pageVersion?: number;
  artifactVersion: number;
  /** Stale, but the target mid survived → re-applied against the current doc. */
  rebased?: boolean;
  /** Cells refused because a human owns them. */
  pinned?: PinCell[];
  /** Ids minted for nodes the writer sent without one. */
  newMids?: Record<string, Mid>;
  /** Ops the writer missed since its baseVersion. */
  since?: CanvasOpRecordV2[];
  error?: string;
}

/** Result of applying one op to a doc: the new tree plus how to undo it. */
export interface DocPatchResult {
  doc: DocNode;
  inverse: CanvasOp;
  newMids: Record<string, Mid>;
}
