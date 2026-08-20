/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 */

import type { ArtifactStore, PageInit } from './ArtifactStore';
import type { CanvasOpExecutor, CanvasApprovalMode } from './CanvasOpExecutor';
import { computeAnchors, resolveFormat } from './CanvasFormats';
import { validatePage } from './CanvasValidator';
import { getScaffold, listScaffolds } from './CanvasScaffolds';
import type { ScaffoldDevice } from './CanvasScaffolds';
import { getThemePreset, listThemePresets } from './CanvasThemePresets';
import { importFigmaPayload } from './FigmaImport';
import { emptyDoc, pageMode, pageWire } from '../canvas/pageMigration';
import {
  CANVAS_TOOL_SURFACE,
  LEGACY_KIND_FOR_OP,
  type CanvasToolSpec,
  type CanvasToolAccess as SurfaceToolAccess,
} from '../canvas/CanvasToolSurface';
import { opMid, opPageId, type CanvasOp as CanvasOpV2, type CanvasOpKindV2, type CanvasOpReceiptV2 } from '../canvas/CanvasOps';
import { compile } from '../canvas/doc/PageCompiler';
import { emit, emitElement, PIN_MARKER } from '../canvas/doc/DocEmitter';
import { reconcile } from '../canvas/doc/Reconciler';
import { diffDocs, type DroppedIntent } from '../canvas/doc/TreeDiffer';
import { sanitizeNodeInput } from '../canvas/doc/DocPatch';
import { findNode, isMid, pinnedCells, putOwn, walk, type DocNode, type DocNodeInput, type Mid, type PinCell, type PinRecord } from '../canvas/doc/DocNode';
import type { CanvasHistory } from '../canvas/CanvasHistory';
import type { ArtifactPage, CanvasArtifact, CanvasOp } from '../types';

/**
 * The transport-agnostic `mysti-canvas` tool contract.
 *
 * Plan 22 Phase 4 re-points this dispatcher at the §3.2 **element** ops while
 * keeping its signature, so every transport — the stdio MCP server, the
 * coordinator's `<canvas:NONCE>` / native `canvas_*` lanes, and the fenced CLI
 * lane — lands on ONE write path with one authority.
 *
 * The catalog itself lives in `src/canvas/CanvasToolSurface.ts`, generated from
 * the op algebra plus a read set. Nothing here declares a tool: this module is
 * the *executor* of the surface, which is what makes the conformance test
 * ("every op variant has a tool, a gesture, and a round-tripping example")
 * meaningful rather than circular.
 *
 * Generation/render/QA tools (`generate_visual`, `render_page_preview`, …) live
 * in the capability/render layer and are not dispatched here.
 */

export type CanvasToolAccess = SurfaceToolAccess;

/** A tool descriptor as the MCP server and the native lane consume it. */
export type CanvasToolDef = CanvasToolSpec;

export interface CanvasToolContext {
  artifact: CanvasArtifact;
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  /** Job the resulting events are emitted under. */
  jobId: string;
  /** Chat turn / run id that authored these ops. */
  runId: string;
  approvalMode: CanvasApprovalMode;
  /**
   * The artifact's undo/version cursor. Required only by `checkpoint`; every
   * other tool works without it, so a transport that has not wired history yet
   * degrades to one honest error instead of a broken surface.
   */
  history?: CanvasHistory;
}

/** Why an intent the writer expressed never became a committed op. */
export interface CanvasDroppedIntent {
  /** The element the intent targeted, when it had one. */
  mid?: string;
  /** `'text' | 'style.<prop>' | 'props.<name>'`. Absent for whole-node intents. */
  cell?: string;
  reason: 'pinned-by-human' | 'node-vanished' | 'refused' | 'stale';
  op?: CanvasOpKindV2;
  detail?: string;
}

export interface CanvasToolResult {
  ok: boolean;
  /** Payload for READ-ONLY tools, and the {applied, dropped} report for `write_page`. */
  data?: unknown;
  /**
   * Legacy op view for WRITE tools (null when the executor refused it).
   *
   * Kept because it is the field every shipped transport already keys off — a
   * defined `op` means "the artifact may have changed, repaint and save".
   */
  op?: CanvasOp | null;
  /** The Plan 22 receipt, for tools that submit through the op algebra. */
  receipt?: CanvasOpReceiptV2;
  /** The op variants this call committed (or attempted). */
  ops?: CanvasOpV2[];
  /** Intents that could not be honored. Never silent — this reaches the model. */
  dropped?: CanvasDroppedIntent[];
  error?: string;
}

/**
 * The full artifact-editing tool catalog.
 *
 * Structurally a `CanvasToolDef[]`; the entries carry Phase-4 metadata
 * (`tier`, `produces`, `nativeExcluded`) that older consumers simply ignore.
 */
export const CANVAS_TOOLS: readonly CanvasToolDef[] = CANVAS_TOOL_SURFACE;

const TOOL_BY_NAME = new Map(CANVAS_TOOLS.map(t => [t.name, t]));

export function getCanvasTool(name: string): CanvasToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

/** Compact one-line-per-page index for the system prompt (Plan 05 §2). */
export function buildArtifactIndex(artifact: CanvasArtifact): string {
  const header = `artifact "${artifact.name}" — kind=${artifact.kind} format=${artifact.format.formatId} pages=${artifact.pages.length}`;
  const lines = artifact.pages.map(
    (p, i) => `#${i} id=${p.id} mode=${pageMode(p)} v=${p.version}${p.legacy ? ' [code page]' : ''}${p.actionTitle ? ` — ${p.actionTitle}` : ''}`,
  );
  return [header, ...lines].join('\n');
}

type Args = Record<string, unknown>;

/** Results per element-op batch before the writer sees them. */
const MAX_FIND_RESULTS = 500;
const DEFAULT_FIND_RESULTS = 50;

/* ───────────────────────── read clamps (principle 8) ───────────────────── */

/**
 * Plan 22 first principle 8: a canvas read re-entering a model is fenced **and
 * clamped**. The fence is `_fenceLocalToolResult`; the clamp has to be here,
 * because every transport serializes `data` verbatim and none of them knows
 * that an imported or accumulated artboard can be a megabyte of JSX.
 *
 * `find_nodes` has always been capped ({@link MAX_FIND_RESULTS}) and every Plan
 * 19 local tool caps its output; the document reads were the outlier. The
 * budget is deliberately the SAME as `MystiLocalTools.read` — the closest
 * precedent for "read a whole document" — so the two cannot drift apart by
 * accident. For scale: the largest shipped scaffold emits ~2.8k chars, so a
 * genuine artboard is returned whole and only a pathological one is cut.
 */
const READ_HEAD_CHARS = 18_000;
const READ_TAIL_CHARS = 6_000;
/** One text / notes cell. A leaf string is never legitimately larger. */
const CELL_HEAD_CHARS = 4_000;
const CELL_TAIL_CHARS = 1_000;
/** Serialized budget for one value in a props/style map, and for the map. */
const MAP_VALUE_CHARS = 2_000;
const MAP_TOTAL_CHARS = 8_000;

const CLAMP_HINT = 'use find_nodes/get_node to page through';
/**
 * The marker a clamped read leaves in the source it returns.
 *
 * A clamp creates a hazard the un-clamped read did not have: a model that
 * echoes a clamped artboard back into `write_page` would be diffed against the
 * REAL document, and everything the clamp cut would come back as `el.remove`.
 * So the marker is also a tripwire — {@link containsClampMarker} refuses any
 * source carrying it, before the compiler ever sees it.
 */
const CLAMP_SENTINEL = '[clamped —';

/** True when a writer is echoing back source it only partly saw. */
function containsClampMarker(src: string): boolean {
  return src.includes(CLAMP_SENTINEL);
}

/**
 * Round-4 R4-3: the same tripwire, at the BOUNDARY rather than at two callers.
 *
 * `ClampLog.cell` clamps `text` and `notes` in `get_node`/`read_page`, so the
 * marker reaches the model on the CELL writers too — and `set_text` with the
 * string it was just shown truncated the human's copy to the clamped length and
 * wrote "[clamped — …]" into the artboard as document content, with `ok:true`.
 * Anything model-supplied that becomes document content is checked here.
 */
function carriesClampMarker(value: unknown): boolean {
  if (typeof value === 'string') { return containsClampMarker(value); }
  if (!value || typeof value !== 'object') { return false; }
  try { return (JSON.stringify(value) ?? '').includes(CLAMP_SENTINEL); } catch { return false; }
}

/** The refusal a clamped echo gets, or null when the value is genuinely whole. */
function clampEchoRefusal(value: unknown, tool: string, what: string): CanvasToolResult | null {
  if (!carriesClampMarker(value)) { return null; }
  return {
    ok: false,
    // The message deliberately spells the marker WITHOUT the sentinel, so an
    // error the model quotes back cannot trip the guard a second time.
    error: `${tool}: ${what} still carries a "… [clamped …] …" marker, so it is the value you were SHOWN, `
      + 'not the value that exists — writing it back would delete everything the clamp cut. Send the replacement '
      + 'content you actually mean (a value with no clamp marker in it), or leave this cell to the user.',
  };
}

/** High/low surrogate halves, so a clamp never cuts an astral character in two. */
function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

/**
 * Collects what a read had to cut, so the payload can SAY it was cut.
 *
 * A clamp the model cannot see is worse than no clamp: it would reason about a
 * partial artboard believing it had the whole one.
 */
class ClampLog {
  readonly notes: string[] = [];

  /** Head/tail clamp with an explicit, model-readable marker. */
  text(value: string | undefined, what: string, head = READ_HEAD_CHARS, tail = READ_TAIL_CHARS): string | undefined {
    if (value === undefined || value.length <= head + tail) { return value; }
    this.notes.push(`${what} (${value.length} chars)`);
    // Round-4 R4-3 (minor): `slice` counts UTF-16 code units, so a boundary
    // landing inside an astral character used to emit a LONE surrogate — not
    // valid text, and unrecoverable once it reaches the transport.
    const headEnd = isHighSurrogate(value.charCodeAt(head - 1)) ? head - 1 : head;
    const tailStart = isLowSurrogate(value.charCodeAt(value.length - tail))
      ? value.length - tail + 1
      : value.length - tail;
    return `${value.slice(0, headEnd)}\n… [clamped — ${value.length} chars total; ${CLAMP_HINT}] …\n${value.slice(tailStart)}`;
  }

  /** One text/notes cell — a much smaller budget than a whole document. */
  cell(value: string | undefined, what: string): string | undefined {
    return this.text(value, what, CELL_HEAD_CHARS, CELL_TAIL_CHARS);
  }

  /**
   * A props/style map: over-budget VALUES are replaced, the keys survive.
   * Keeping the key list intact is the point — the model still learns which
   * props exist, and only the one 20k-row `items` array is elided.
   */
  map<T>(value: Record<string, T> | undefined, what: string): Record<string, unknown> | undefined {
    if (!value) { return value; }
    const out: Record<string, unknown> = {};
    let spent = 0;
    let cut = 0;
    for (const [k, v] of Object.entries(value)) {
      let json: string;
      try { json = JSON.stringify(v) ?? 'null'; } catch { json = '"[unserializable]"'; }
      if (json.length > MAP_VALUE_CHARS || spent + json.length > MAP_TOTAL_CHARS) {
        cut++;
        putOwn(out, k, `… [clamped — ${json.length} chars; ${CLAMP_HINT}] …`);
        continue;
      }
      spent += json.length;
      putOwn(out, k, v);
    }
    if (cut > 0) { this.notes.push(`${cut} ${what} value(s)`); }
    return out;
  }

  /** The fields a clamped payload carries. Absent when nothing was cut. */
  marker(): { clamped: true; clampNote: string } | Record<string, never> {
    if (this.notes.length === 0) { return {}; }
    return {
      clamped: true,
      clampNote: `this read was clamped (${this.notes.join('; ')}) — you did NOT see the whole thing; ${CLAMP_HINT}. `
        + 'A clamped value cannot be written back: sending it as text, a prop, notes or jsx is refused, because it '
        + 'would delete everything the clamp cut.',
    };
  }
}

/**
 * Execute a tool call against the artifact.
 *
 * READ-ONLY tools read from the store; WRITE tools route through
 * `CanvasOpExecutor` — `submitOp` for the Plan 22 op algebra, `submit` for the
 * legacy kinds still on the wire — so validation, pins, subtree locks,
 * staging, versioning and events are uniform regardless of transport.
 */
export function dispatchCanvasTool(name: string, args: Args, ctx: CanvasToolContext): CanvasToolResult {
  const def = TOOL_BY_NAME.get(name);
  if (!def) { return { ok: false, error: `unknown canvas tool: ${name}` }; }
  const { artifact, store, executor, jobId, runId, approvalMode } = ctx;

  /** Legacy kind-based submission (the pre-Plan-22 transports' own path). */
  const submit = (
    kind: Parameters<CanvasOpExecutor['submit']>[1]['kind'],
    extra: Partial<Parameters<CanvasOpExecutor['submit']>[1]>,
  ): CanvasToolResult => {
    const op = executor.submit(
      artifact,
      { kind, runId, author: 'agent', proposedValue: extra.proposedValue, targetPageId: extra.targetPageId, baseVersion: extra.baseVersion },
      jobId,
      approvalMode,
    );
    return op
      ? { ok: true, op }
      : { ok: false, op: null, error: executor.lastSubmitError() ?? `op rejected (${kind})` };
  };

  /** Plan 22 §3.2 submission. Always yields a receipt — a refusal is data. */
  const submitV2 = (
    op: CanvasOpV2,
    extra: { baseVersion?: number; force?: PinCell[]; txnId?: string } = {},
  ): CanvasToolResult => {
    const receipt = executor.submitOp(
      artifact,
      { op, runId, author: 'agent', txnId: extra.txnId, baseVersion: extra.baseVersion, force: extra.force },
      jobId,
      approvalMode,
    );
    const ok = !receipt.error && receipt.status !== 'rejected';
    const result: CanvasToolResult = {
      ok,
      op: legacyView(op, receipt, runId),
      receipt,
      ops: [op],
    };
    const dropped = droppedFromReceipt(op, receipt);
    if (dropped.length) { result.dropped = dropped; }
    if (!ok) { result.error = receipt.error ?? `op refused (${op.op})`; }
    return result;
  };

  switch (name) {
    /* ─────────────────────────────── reads ─────────────────────────────── */

    case 'list_pages':
      return {
        ok: true,
        data: artifact.pages.map((p, i) => ({ index: i, id: p.id, mode: pageMode(p), version: p.version, actionTitle: p.actionTitle })),
      };

    case 'read_page': {
      const page = store.getPage(artifact, String(args.pageId));
      if (!page) { return { ok: false, error: `page ${String(args.pageId)} not found` }; }
      // Plan 22 §3.1 mid stability tier 1: what comes back is the emitted,
      // mid-annotated JSX, so a model that echoes the attributes it does not
      // understand keeps exact element identity for free.
      const clamp = new ClampLog();
      const wire: Record<string, unknown> & { jsxSource?: string; htmlSource?: string } = { ...pageWire(page) };
      if (typeof wire.jsxSource === 'string') { wire.jsxSource = clamp.text(wire.jsxSource, 'the artboard source'); }
      if (typeof wire.htmlSource === 'string') { wire.htmlSource = clamp.text(wire.htmlSource, 'the artboard source'); }
      return {
        ok: true,
        data: { ...wire, notes: clamp.cell(page.notes, 'the artboard notes'), baseVersion: page.version, ...clamp.marker() },
      };
    }

    case 'get_page_jsx': {
      const page = store.getPage(artifact, String(args.pageId));
      if (!page) { return { ok: false, error: `page ${String(args.pageId)} not found` }; }
      const clamp = new ClampLog();
      if (page.legacy) {
        return {
          ok: true,
          data: {
            pageId: page.id,
            version: page.version,
            baseVersion: page.version,
            actionTitle: page.actionTitle,
            legacy: true,
            mode: page.legacy.mode,
            source: clamp.text(page.legacy.source, 'the artboard source'),
            compileError: page.compileError,
            note: 'code page — its elements are not addressable. Rewrite it with write_page to make it editable.',
            ...clamp.marker(),
          },
        };
      }
      // Plan 22 §3.5 rule 4 — mids so the model can address one element, and
      // the ⟂user-set markers so it can see what it must not overwrite.
      return {
        ok: true,
        data: {
          pageId: page.id,
          version: page.version,
          baseVersion: page.version,
          actionTitle: page.actionTitle,
          notes: clamp.cell(page.notes, 'the artboard notes'),
          format: page.format,
          jsx: clamp.text(emit(page.doc, { mids: true, pins: true }), 'the artboard JSX'),
          pinMarker: PIN_MARKER,
          ...clamp.marker(),
        },
      };
    }

    case 'get_node': {
      const page = store.getPage(artifact, String(args.pageId));
      if (!page) { return { ok: false, error: `page ${String(args.pageId)} not found` }; }
      const mid = String(args.mid ?? '');
      const node = mid ? findNode(page.doc, mid) : null;
      if (!node) { return { ok: false, error: `element ${mid || '(none)'} is not on page ${page.id}` }; }
      const clamp = new ClampLog();
      return {
        ok: true,
        data: {
          pageId: page.id,
          version: page.version,
          baseVersion: page.version,
          mid: node.mid,
          tag: node.tag,
          props: clamp.map(node.props, 'prop'),
          style: clamp.map(node.style, 'style'),
          text: clamp.cell(node.text, 'the element text'),
          childCount: node.children?.length ?? 0,
          pinned: pinnedCells(node),
          jsx: clamp.text(emitElement(node, { mids: true, pins: true }), 'the element JSX'),
          ...clamp.marker(),
        },
      };
    }

    case 'find_nodes': {
      const wantTag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : null;
      const wantText = typeof args.text === 'string' && args.text.trim() ? args.text.trim().toLowerCase() : null;
      if (!wantTag && !wantText) { return { ok: false, error: 'find_nodes requires `tag` and/or `text`' }; }
      const limit = clampInt(args.limit, DEFAULT_FIND_RESULTS, 1, MAX_FIND_RESULTS);
      const pages = typeof args.pageId === 'string' && args.pageId.trim()
        ? [store.getPage(artifact, args.pageId.trim())].filter((p): p is ArtifactPage => !!p)
        : artifact.pages;
      if (typeof args.pageId === 'string' && args.pageId.trim() && pages.length === 0) {
        return { ok: false, error: `page ${args.pageId.trim()} not found` };
      }
      const hits: Array<{ pageId: string; mid: Mid; tag: string; text?: string; pinned?: PinCell[] }> = [];
      for (const page of pages) {
        if (page.legacy) { continue; }
        for (const node of walk(page.doc)) {
          if (hits.length >= limit) { break; }
          if (wantTag && node.tag !== wantTag) { continue; }
          if (wantText && !(node.text ?? '').toLowerCase().includes(wantText)) { continue; }
          const pins = pinnedCells(node);
          hits.push({ pageId: page.id, mid: node.mid, tag: node.tag, text: node.text, ...(pins.length ? { pinned: pins } : {}) });
        }
        if (hits.length >= limit) { break; }
      }
      return { ok: true, data: { matches: hits, truncated: hits.length >= limit } };
    }

    case 'list_assets':
      return { ok: true, data: artifact.assets };

    case 'get_artifact_index':
      return { ok: true, data: buildArtifactIndex(artifact) };

    case 'page_coordinates':
      return { ok: true, data: computeAnchors(artifact.format) };

    case 'validate_page': {
      const page = store.getPage(artifact, String(args.pageId));
      if (!page) { return { ok: false, error: `page ${String(args.pageId)} not found` }; }
      const issues = validatePage(artifact, page, { reportedContentHeight: numOrUndef(args.reportedContentHeight) });
      return { ok: true, data: { issues, ok: issues.every(i => i.severity !== 'error') } };
    }

    case 'list_scaffolds':
      return { ok: true, data: listScaffolds(args.device as ScaffoldDevice | undefined) };

    case 'list_theme_presets':
      return { ok: true, data: listThemePresets() };

    /* ─────────────────────────── artboard writes ────────────────────────── */

    case 'add_page': {
      const echoed = clampEchoRefusal(args.notes, 'add_page', 'the notes');
      if (echoed) { return echoed; }
      const seeded = seedDocFor(args);
      if (!seeded.ok) { return { ok: false, error: seeded.error }; }
      const spec: Extract<CanvasOpV2, { op: 'page.add' }>['page'] = { doc: seeded.doc };
      const title = typeof args.actionTitle === 'string' ? args.actionTitle : seeded.defaultTitle;
      if (title) { spec.actionTitle = title; }
      if (typeof args.notes === 'string') { spec.notes = args.notes; }
      const op: CanvasOpV2 = typeof args.index === 'number'
        ? { op: 'page.add', page: spec, index: args.index }
        : { op: 'page.add', page: spec };
      return submitV2(op);
    }

    case 'remove_page':
      return submitV2({ op: 'page.remove', pageId: String(args.pageId) }, { baseVersion: numOrUndef(args.baseVersion) });

    case 'duplicate_page': {
      const pageId = String(args.pageId);
      const variantOf = typeof args.variantOf === 'string' && args.variantOf.trim() ? args.variantOf.trim() : undefined;
      return submitV2(variantOf
        ? { op: 'page.duplicate', pageId, variantOf }
        : { op: 'page.duplicate', pageId });
    }

    case 'set_page_meta': {
      const echoed = clampEchoRefusal(args.notes, 'set_page_meta', 'the notes');
      if (echoed) { return echoed; }
      const patch: Extract<CanvasOpV2, { op: 'page.setMeta' }>['patch'] = {};
      if (typeof args.actionTitle === 'string') { patch.actionTitle = args.actionTitle; }
      if (typeof args.notes === 'string') { patch.notes = args.notes; }
      if (typeof args.formatId === 'string' && args.formatId.trim()) {
        const requested = args.formatId.trim();
        const format = resolveFormat({ formatId: requested, width: numOrUndef(args.width), height: numOrUndef(args.height) });
        // `resolveFormat` falls back to the default for an id it does not know.
        // Silently reframing the artboard to something the model did not ask
        // for is the exact class of quiet failure Plan 22 exists to remove.
        if (format.formatId !== requested) {
          return { ok: false, error: `unknown format "${requested}" — pass a catalog id, or "custom" with width and height` };
        }
        patch.format = format;
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: 'set_page_meta needs at least one of actionTitle, notes or formatId' };
      }
      return submitV2({ op: 'page.setMeta', pageId: String(args.pageId), patch }, { baseVersion: numOrUndef(args.baseVersion) });
    }

    case 'move_page': {
      const x = numOrUndef(args.x);
      const y = numOrUndef(args.y);
      if (x === undefined || y === undefined) { return { ok: false, error: 'move_page requires numeric x and y' }; }
      return submitV2({ op: 'page.move', pageId: String(args.pageId), boardPos: { x, y } });
    }

    case 'reorder_pages':
      if (!Array.isArray(args.orderedIds)) { return { ok: false, error: 'reorder_pages requires orderedIds: string[]' }; }
      return submit('reorder', { proposedValue: args.orderedIds });

    case 'write_page':
    case 'write_page_jsx':
      return writePage(args, ctx, submit, submitV2);

    /* ──────────────────────────── element writes ───────────────────────── */

    case 'set_text': {
      const mid = requireMid(args.mid, 'set_text');
      if (typeof mid !== 'string') { return mid; }
      if (typeof args.text !== 'string') { return { ok: false, error: 'set_text requires text: string' }; }
      const echoed = clampEchoRefusal(args.text, 'set_text', 'the text you sent');
      if (echoed) { return echoed; }
      return submitV2(
        { op: 'el.setText', pageId: String(args.pageId), mid, text: args.text },
        { baseVersion: numOrUndef(args.baseVersion), force: parseForce(args.force) },
      );
    }

    case 'set_style': {
      const mid = requireMid(args.mid, 'set_style');
      if (typeof mid !== 'string') { return mid; }
      const style = parseStyleMap(args.style);
      if (!style.ok) { return { ok: false, error: style.error }; }
      const echoed = clampEchoRefusal(style.value, 'set_style', 'a style value');
      if (echoed) { return echoed; }
      return submitV2(
        { op: 'el.setStyle', pageId: String(args.pageId), mid, style: style.value },
        { baseVersion: numOrUndef(args.baseVersion), force: parseForce(args.force) },
      );
    }

    case 'set_prop': {
      const mid = requireMid(args.mid, 'set_prop');
      if (typeof mid !== 'string') { return mid; }
      const propName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!propName) { return { ok: false, error: 'set_prop requires name: string' }; }
      const echoed = clampEchoRefusal(args.value, 'set_prop', `the value for "${propName}"`);
      if (echoed) { return echoed; }
      const value = args.value === undefined ? null : (args.value as Extract<CanvasOpV2, { op: 'el.setProp' }>['value']);
      return submitV2(
        { op: 'el.setProp', pageId: String(args.pageId), mid, name: propName, value },
        { baseVersion: numOrUndef(args.baseVersion), force: parseForce(args.force) },
      );
    }

    case 'insert_element': {
      const parentMid = requireMid(args.parentMid, 'insert_element');
      if (typeof parentMid !== 'string') { return parentMid; }
      const node = nodeInputFrom(args, 'insert_element');
      if (!node.ok) { return { ok: false, error: node.error }; }
      const op: Extract<CanvasOpV2, { op: 'el.insert' }> = {
        op: 'el.insert',
        pageId: String(args.pageId),
        parentMid,
        before: parseAnchor(args.before),
        node: node.node,
      };
      const slot = typeof args.slot === 'string' && args.slot.trim() ? args.slot.trim() : undefined;
      if (slot) { op.slot = slot; }
      return submitV2(op, { baseVersion: numOrUndef(args.baseVersion) });
    }

    case 'remove_element': {
      const mid = requireMid(args.mid, 'remove_element');
      if (typeof mid !== 'string') { return mid; }
      return submitV2({ op: 'el.remove', pageId: String(args.pageId), mid }, { baseVersion: numOrUndef(args.baseVersion) });
    }

    case 'move_element': {
      const mid = requireMid(args.mid, 'move_element');
      if (typeof mid !== 'string') { return mid; }
      const newParentMid = requireMid(args.newParentMid, 'move_element');
      if (typeof newParentMid !== 'string') { return newParentMid; }
      const op: Extract<CanvasOpV2, { op: 'el.move' }> = {
        op: 'el.move',
        pageId: String(args.pageId),
        mid,
        newParentMid,
        before: parseAnchor(args.before),
      };
      const slot = typeof args.slot === 'string' && args.slot.trim() ? args.slot.trim() : undefined;
      if (slot) { op.slot = slot; }
      return submitV2(op, { baseVersion: numOrUndef(args.baseVersion) });
    }

    case 'replace_element': {
      const mid = requireMid(args.mid, 'replace_element');
      if (typeof mid !== 'string') { return mid; }
      const node = nodeInputFrom(args, 'replace_element');
      if (!node.ok) { return { ok: false, error: node.error }; }
      // Review R4-1: `el.replace` is not cell-scoped, so `opCells` is null and
      // the executor's pin gate returns zero conflicts — exactly the hole
      // review F3 closed for `page.setDoc`, left open on the PRIMARY,
      // model-taught tool next to it. This is the layer that holds both the
      // live subtree and the replacement, so the check belongs here.
      const guarded = guardReplacePins(ctx, String(args.pageId), mid, node.node, args.force);
      if (!guarded.ok) { return guarded.result; }
      return submitV2(
        { op: 'el.replace', pageId: String(args.pageId), mid, node: guarded.node },
        { baseVersion: numOrUndef(args.baseVersion) },
      );
    }

    /* ─────────────────────────── artifact writes ───────────────────────── */

    case 'set_theme': {
      if (typeof args.preset === 'string' && args.preset.trim()) {
        const preset = getThemePreset(args.preset.trim());
        if (!preset) { return { ok: false, error: `unknown theme preset: ${args.preset.trim()}` }; }
        return submit('set_theme', { proposedValue: preset.theme });
      }
      if (!args.theme || typeof args.theme !== 'object') { return { ok: false, error: 'set_theme requires a theme object (or a preset id)' }; }
      return submit('set_theme', { proposedValue: args.theme });
    }

    case 'set_theme_token': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) { return { ok: false, error: 'set_theme_token requires path: string' }; }
      if (typeof args.value !== 'string') { return { ok: false, error: 'set_theme_token requires value: string' }; }
      return submitV2({ op: 'theme.setToken', path, value: args.value }, { baseVersion: numOrUndef(args.baseVersion) });
    }

    case 'set_format': {
      const spec = resolveFormat({ formatId: String(args.formatId), width: numOrUndef(args.width), height: numOrUndef(args.height) });
      return submit('set_format', { proposedValue: spec });
    }

    case 'checkpoint': {
      const label = typeof args.label === 'string' ? args.label.trim() : '';
      if (!label) { return { ok: false, error: 'checkpoint requires label: string' }; }
      if (!ctx.history) {
        return { ok: false, error: 'version history is not available on this canvas session yet — the edit itself still applied' };
      }
      const ref = ctx.history.checkpoint(label.slice(0, 200));
      return { ok: true, data: { checkpoint: { id: ref.id, label: ref.label, artifactVersion: ref.artifactVersion } } };
    }

    /* ───────────────────────────── extras ──────────────────────────────── */

    case 'add_asset':
      if (!args.asset || typeof args.asset !== 'object') { return { ok: false, error: 'add_asset requires an asset record' }; }
      return submit('add_asset', { proposedValue: args.asset });

    case 'import_design': {
      if (args.source !== 'figma') { return { ok: false, error: `unsupported import source: ${String(args.source)} (figma supported)` }; }
      const spec = importFigmaPayload(args.payload);
      if (!spec) { return { ok: false, error: 'could not find a frame in the figma payload' }; }
      const page: PageInit & { index?: number } = {
        mode: 'html',
        htmlSource: spec.htmlSource,
        actionTitle: typeof args.actionTitle === 'string' ? args.actionTitle : spec.actionTitle,
        source: 'figma',
      };
      if (typeof args.index === 'number') { page.index = args.index; }
      return submit('insert_page', { proposedValue: page });
    }

    /* ─────────────────────── compat (never taught) ─────────────────────── */

    case 'apply_theme_preset': {
      const preset = getThemePreset(String(args.preset));
      if (!preset) { return { ok: false, error: `unknown theme preset: ${String(args.preset)}` }; }
      return submit('set_theme', { proposedValue: preset.theme });
    }

    case 'scaffold_page': {
      const scaffold = getScaffold(String(args.scaffold));
      if (!scaffold) { return { ok: false, error: `unknown scaffold: ${String(args.scaffold)}` }; }
      const cleaned = cleanJsx(scaffold.jsx);          // scaffolds must be valid JSX pages
      if (!cleaned.ok) { return { ok: false, error: `scaffold ${scaffold.id} is invalid: ${cleaned.error}` }; }
      const page: PageInit & { index?: number } = {
        mode: 'jsx',
        jsxSource: cleaned.source,
        actionTitle: typeof args.actionTitle === 'string' ? args.actionTitle : scaffold.name,
      };
      if (typeof args.index === 'number') { page.index = args.index; }
      return submit('insert_page', { proposedValue: page });
    }

    case 'insert_page': {
      const page = args.page;
      const spec = page as { mode?: unknown; doc?: unknown } | null;
      if (!spec || typeof spec !== 'object' || (!spec.mode && !spec.doc)) {
        return { ok: false, error: 'insert_page requires a page object with a mode (or a doc)' };
      }
      const proposed = typeof args.index === 'number' ? { ...(page as object), index: args.index } : page;
      return submit('insert_page', { proposedValue: proposed });
    }

    case 'edit_page':
      if (!args.patch || typeof args.patch !== 'object') {
        return { ok: false, error: 'edit_page requires a patch object' };
      }
      return submit('edit_page', { targetPageId: String(args.pageId), baseVersion: numOrUndef(args.baseVersion), proposedValue: args.patch });

    case 'delete_page':
      return submit('delete_page', { targetPageId: String(args.pageId), baseVersion: numOrUndef(args.baseVersion), proposedValue: {} });

    case 'edit_element': {
      if (typeof args.mid !== 'string' || !args.mid) {
        return { ok: false, error: 'edit_element requires mid: string (the id get_page_jsx returned for the element)' };
      }
      const cell: Record<string, unknown> = { mid: args.mid };
      if (args.text !== undefined) { cell.text = args.text; }
      if (args.style !== undefined) { cell.style = args.style; }
      if (args.prop !== undefined) { cell.prop = args.prop; }
      const echoed = clampEchoRefusal(cell, 'edit_element', 'this edit');
      if (echoed) { return echoed; }
      return submit('edit_element', {
        targetPageId: String(args.pageId),
        baseVersion: numOrUndef(args.baseVersion),
        proposedValue: cell,
      });
    }

    default:
      return { ok: false, error: `unhandled canvas tool: ${name}` };
  }
}

/* ──────────────────────────── write_page ──────────────────────────────── */

/**
 * Plan 22 §3.5 "whole-page rewrites": compile → **reconcile** (matched nodes
 * inherit mids) → **diff with pinned cells excluded** → element ops.
 *
 * Three shapes, and the split is structural rather than a heuristic:
 *
 *  - **no `pageId`** — a brand-new artboard. There is no previous document to
 *    diff against and no cell a human can own yet, so this rides the legacy
 *    insert path unchanged: same op log entry, same undo, same receipt the
 *    `<canvaspage:NONCE>` lane has always produced.
 *  - **a `legacy` (uncompilable) page, or `replace: true`** — nothing is
 *    addressable, so the honest op is `page.setDoc`, which also promotes the
 *    page out of `legacy` and makes it editable from then on.
 *  - **anything else** — the element-op path, reporting `{applied, dropped}`
 *    so a pinned-cell refusal reaches the model instead of dying silently.
 */
function writePage(
  args: Args,
  ctx: CanvasToolContext,
  submit: (kind: Parameters<CanvasOpExecutor['submit']>[1]['kind'], extra: Partial<Parameters<CanvasOpExecutor['submit']>[1]>) => CanvasToolResult,
  submitV2: (op: CanvasOpV2, extra?: { baseVersion?: number; force?: PinCell[]; txnId?: string }) => CanvasToolResult,
): CanvasToolResult {
  const cleaned = cleanJsx(args.jsx);
  if (!cleaned.ok) { return { ok: false, error: cleaned.error }; }

  const pageId = typeof args.pageId === 'string' && args.pageId.trim() ? args.pageId.trim() : '';
  const actionTitle = typeof args.actionTitle === 'string' ? args.actionTitle : undefined;

  // ── new artboard ──────────────────────────────────────────────────────
  if (!pageId) {
    const page: PageInit = { mode: 'jsx', jsxSource: cleaned.source };
    if (actionTitle !== undefined) { page.actionTitle = actionTitle; }
    const res = submit('insert_page', { proposedValue: page });
    if (!res.ok) { return res; }
    return { ...res, data: { created: true, pageId: res.op?.targetPageId, applied: 1, dropped: [] } };
  }

  const page = ctx.store.getPage(ctx.artifact, pageId);
  if (!page) { return { ok: false, error: `page ${pageId} not found` }; }

  const baseVersion = numOrUndef(args.baseVersion);
  if (baseVersion !== undefined && baseVersion !== page.version) {
    return {
      ok: false,
      error: `stale write: you read page ${pageId} at v${baseVersion} but it is now v${page.version}. `
        + 'Re-read it with get_page_jsx and re-apply only what you still want to change.',
    };
  }

  const compiled = compile(cleaned.source);
  if (!compiled.ok) {
    return { ok: false, error: `the page source is outside the supported JSX subset: ${compiled.error}` };
  }

  // Review F2: a whole-artboard rewrite is the ONE caller whose `force` is not
  // already scoped by the op it rides on, so here — and only here — the writer
  // must name the element as well as the cell.
  const parsedForce = parseScopedForce(args.force);
  if (!parsedForce.ok) { return { ok: false, error: parsedForce.error }; }
  const force = parsedForce.index;
  const titleOp: CanvasOpV2 | null = actionTitle !== undefined && actionTitle !== page.actionTitle
    ? { op: 'page.setMeta', pageId, patch: { actionTitle } }
    : null;

  // ── uncompilable page, or an explicit wholesale replace ────────────────
  if (page.legacy || args.replace === true) {
    // Review F3: `page.setDoc` is not cell-scoped, so `opCells` returns null
    // and the executor's pin gate sees zero conflicts — a wholesale replace
    // would sail past the one control that makes human intent outrank agent
    // intent, and take the page's whole pin RECORD with it. This is the only
    // layer that holds both documents, so the check belongs here.
    const carry = pinsAcrossReplace(page.doc, incomingIndex(compiled.doc), force, 'page.setDoc');
    if (carry.conflicts.length > 0) {
      return {
        ok: false,
        error: `replace refused: ${carry.conflicts.length} cell(s) on this artboard are user-set and this document would `
          + `change or destroy them (${carry.conflicts.map(c => `${c.mid}:${c.cell}`).join(', ')}). `
          + 'Drop `replace` so the rewrite is diffed against the current document and the human\'s cells are preserved — '
          + 'or, only if the user asked for those specific changes, name them in force as "<mid>:<cell>".',
        dropped: carry.conflicts,
      };
    }
    // Surviving pins ride along: the human still owns the cell after a
    // wholesale write, so the next agent turn is still refused.
    graftPins(compiled.doc, carry.keep);
    const res = submitV2({ op: 'page.setDoc', pageId, doc: compiled.doc });
    if (titleOp && res.ok) { submitV2(titleOp); }
    if (!res.ok) { return res; }
    return {
      ...res,
      data: { pageId, replaced: true, applied: 1, dropped: res.dropped ?? [], version: ctx.store.getPage(ctx.artifact, pageId)?.version },
    };
  }

  // ── the element-op path ───────────────────────────────────────────────
  const claimedMids = claimedMidsIn(cleaned.source);
  const rec = reconcile(page.doc, compiled.doc);
  // Review F2: `respectPins` is now ALWAYS on. It used to be switched off
  // whenever `force` was non-empty, which turned "override this one cell" into
  // "every pinned cell on this artboard is a diff candidate", and the executor
  // — which matches a forced cell by NAME — then applied all of them. The
  // forced cells are recovered below from the differ's own `dropped` report,
  // which carries the mid, so the override lands on exactly the named element.
  const diff = diffDocs(page.doc, rec.doc, { pageId, respectPins: true, claimedMids });

  const ops: Array<{ op: CanvasOpV2; force?: PinCell[] }> = diff.ops.map(op => ({ op }));
  const dropped: CanvasDroppedIntent[] = [];
  for (const d of diff.dropped) {
    const forced = d.cell !== undefined && d.reason === 'pinned-by-human' && force.has(d.mid, d.cell)
      ? forcedOpFor(pageId, d)
      : null;
    if (forced) { ops.push({ op: forced, force: [d.cell as PinCell] }); continue; }
    dropped.push(fromDifferDrop(d));
  }
  if (titleOp) { ops.push({ op: titleOp }); }

  if (ops.length === 0) {
    return {
      ok: true,
      data: {
        pageId,
        version: page.version,
        applied: 0,
        dropped,
        note: dropped.length
          ? 'nothing was applied — every difference targeted a cell the human owns'
          : 'the artboard already matches the source you sent',
      },
    };
  }

  const txnId = `write_page:${ctx.runId}:${pageId}:${Date.now()}`;
  const applied: CanvasOpV2[] = [];
  let last: CanvasToolResult | null = null;
  for (const { op, force: opForce } of ops) {
    const res = submitV2(op, { force: opForce, txnId });
    last = res;
    if (res.ok) { applied.push(op); }
    if (res.dropped?.length) { dropped.push(...res.dropped); }
    else if (!res.ok) { dropped.push({ mid: opMid(op) ?? undefined, op: op.op, reason: 'refused', detail: res.error }); }
  }

  for (const p of rec.droppedPins) {
    dropped.push({
      mid: p.nowMid ?? p.prevMid,
      reason: p.reason === 'removed' ? 'node-vanished' : 'pinned-by-human',
      detail: `the human owned ${p.cells.join(', ')} on this element and the rewrite did not preserve its identity`,
    });
  }

  const current = ctx.store.getPage(ctx.artifact, pageId);
  return {
    ok: applied.length > 0,
    op: last?.op ?? null,
    receipt: last?.receipt,
    ops: applied,
    dropped: dropped.length ? dropped : undefined,
    error: applied.length > 0 ? undefined : 'no part of the rewrite could be applied',
    data: {
      pageId,
      version: current?.version,
      applied: applied.length,
      attempted: ops.length,
      opKinds: applied.map(o => o.op),
      dropped,
      newMids: rec.newMids,
    },
  };
}

/* ─────────────────────── model-facing receipt shape ───────────────────── */

/**
 * The JSON a transport hands back to the model for ONE tool call.
 *
 * Lives here, not in the coordinator, because "what a writer learns from a
 * write" is part of the tool contract: `ok` means the document changed, and
 * `dropped` is how a pinned-cell refusal reaches the model instead of dying in
 * a `console.warn`.
 */
export function canvasToolPayload(res: CanvasToolResult, approvalMode: CanvasApprovalMode): Record<string, unknown> {
  if (res.op === undefined) {
    if (res.ok) { return { ok: true, data: res.data }; }
    // A refusal that never reached the executor still has to say WHAT it
    // refused: `write_page { replace: true }` and `replace_element` report the
    // human-owned cells they would have destroyed, and the model only sees
    // them if the payload carries them.
    return res.dropped?.length
      ? { ok: false, error: res.error, dropped: res.dropped }
      : { ok: false, error: res.error };
  }
  const payload: Record<string, unknown> = {
    ok: res.ok && res.op?.status === 'applied',
    approvalMode,
  };
  if (res.op) {
    payload.op = { opId: res.op.opId, kind: res.op.kind, status: res.op.status, targetPageId: res.op.targetPageId };
  }
  if (res.receipt) {
    payload.receipt = {
      status: res.receipt.status,
      pageVersion: res.receipt.pageVersion,
      artifactVersion: res.receipt.artifactVersion,
      ...(res.receipt.rebased ? { rebased: true } : {}),
      ...(res.receipt.pinned?.length ? { pinned: res.receipt.pinned } : {}),
      ...(res.receipt.newMids && Object.keys(res.receipt.newMids).length ? { newMids: res.receipt.newMids } : {}),
    };
  }
  if (res.dropped?.length) { payload.dropped = res.dropped; }
  if (res.data !== undefined) { payload.data = res.data; }
  if (res.error) { payload.error = res.error; }
  return payload;
}

/* ──────────────────────────────── helpers ─────────────────────────────── */

/**
 * The legacy `CanvasOp` view of a V2 submission.
 *
 * Every shipped transport keys "did the artifact maybe change?" off a defined
 * `op`, so a V2 tool must still produce one. The kind mapping comes from
 * {@link LEGACY_KIND_FOR_OP}, whose agreement with the executor's own emitted
 * kind is asserted in `tests/canvas/canvasToolSurface.test.ts`.
 */
function legacyView(op: CanvasOpV2, receipt: CanvasOpReceiptV2, runId: string): CanvasOp {
  return {
    opId: receipt.opId,
    runId,
    kind: LEGACY_KIND_FOR_OP[op.op],
    targetPageId: receipt.pageId ?? opPageId(op) ?? undefined,
    proposedValue: op,
    status: receipt.status === 'staged' ? 'pending' : (receipt.status === 'undone' ? 'rejected' : receipt.status),
    author: 'agent',
    ts: Date.now(),
  };
}

function droppedFromReceipt(op: CanvasOpV2, receipt: CanvasOpReceiptV2): CanvasDroppedIntent[] {
  const out: CanvasDroppedIntent[] = [];
  for (const cell of receipt.pinned ?? []) {
    out.push({ mid: opMid(op) ?? undefined, cell, op: op.op, reason: 'pinned-by-human' });
  }
  if (out.length === 0 && receipt.status === 'stale') {
    out.push({ mid: opMid(op) ?? undefined, op: op.op, reason: 'stale', detail: receipt.error });
  }
  return out;
}

function fromDifferDrop(d: DroppedIntent): CanvasDroppedIntent {
  return { mid: d.mid, cell: d.cell, reason: d.reason, detail: d.wanted === undefined ? undefined : JSON.stringify(d.wanted) };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** `mid` is required and must be a non-empty string. Returns the error result otherwise. */
function requireMid(v: unknown, tool: string): string | CanvasToolResult {
  if (typeof v === 'string' && v.trim()) { return v.trim(); }
  return { ok: false, error: `${tool} requires a mid — the id get_page_jsx returned for the element` };
}

function parseAnchor(v: unknown): Mid | 'end' {
  if (typeof v === 'string' && v.trim() && v.trim() !== 'end') { return v.trim(); }
  return 'end';
}

/** Pin cells the writer explicitly overrides. `true` is not accepted: naming is the point. */
function parseForce(v: unknown): PinCell[] {
  if (!Array.isArray(v)) { return []; }
  return v.filter((c): c is string => typeof c === 'string' && !!c.trim()).map(c => c.trim());
}

/* ─────────────────── force, scoped to an element (review F2) ───────────── */

/**
 * A `force` list for a WHOLE-ARTBOARD write.
 *
 * `set_text` / `set_style` / `set_prop` each name one `mid`, so a bare cell
 * name on those is unambiguous. `write_page` names none, and the executor's pin
 * gate matches a forced cell by NAME alone — so a bare `force: ['text']` there
 * meant "overwrite the human's text on every element of this artboard", in one
 * transaction, with the collateral unreported and undo reverting the whole
 * rewrite rather than just the collateral. Naming the element is therefore
 * mandatory on this one tool.
 */
interface ForceIndex {
  has(mid: Mid, cell: PinCell): boolean;
  readonly size: number;
}

const EMPTY_FORCE: ForceIndex = { has: () => false, size: 0 };

function parseScopedForce(v: unknown, tool = 'write_page'): { ok: true; index: ForceIndex } | { ok: false; error: string } {
  if (v === undefined || v === null) { return { ok: true, index: EMPTY_FORCE }; }
  if (!Array.isArray(v)) {
    return { ok: false, error: `${tool}: force must be an array of "<mid>:<cell>" strings, e.g. ["k7f2xq6b3m:text"]` };
  }
  const byMid = new Map<Mid, Set<PinCell>>();
  for (const raw of v) {
    if (typeof raw !== 'string' || !raw.trim()) { continue; }
    const entry = raw.trim();
    const at = entry.indexOf(':');
    const mid = at > 0 ? entry.slice(0, at) : '';
    const cell = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!isMid(mid) || !cell) {
      return {
        ok: false,
        error: `${tool}: force entry "${entry}" must name the element too — "<mid>:<cell>", e.g. "k7f2xq6b3m:text". `
          + 'A bare cell name can only ever be applied to every element this write covers, which would silently revert '
          + 'the human\'s edits on all the others. Use get_page_jsx to read the mid of the element the user asked you to change.',
      };
    }
    const set = byMid.get(mid) ?? new Set<PinCell>();
    set.add(cell);
    byMid.set(mid, set);
  }
  return { ok: true, index: { has: (mid, cell) => byMid.get(mid)?.has(cell) === true, size: byMid.size } };
}

/**
 * Rebuild the op a forced cell needs from the differ's own refusal record.
 *
 * The differ refuses a pinned cell by REPORTING it (`{mid, cell, wanted}`)
 * rather than by emitting an op, which is strictly stronger — there is no
 * window in which the human's value is not the value. Re-emitting exactly the
 * refused intents the writer named is what makes a scoped override possible
 * without ever handing a page-wide `force` to the executor.
 */
function forcedOpFor(pageId: string, d: DroppedIntent): CanvasOpV2 | null {
  const cell = d.cell;
  if (!cell || d.wanted === undefined) { return null; }
  if (cell === 'text') {
    return { op: 'el.setText', pageId, mid: d.mid, text: typeof d.wanted === 'string' ? d.wanted : String(d.wanted ?? '') };
  }
  if (cell.startsWith('style.')) {
    const key = cell.slice('style.'.length);
    if (!key) { return null; }
    const style: Record<string, string | null> = {};
    putOwn(style, key, d.wanted === null ? null : String(d.wanted));
    return { op: 'el.setStyle', pageId, mid: d.mid, style };
  }
  if (cell.startsWith('props.')) {
    const name = cell.slice('props.'.length);
    if (!name) { return null; }
    return { op: 'el.setProp', pageId, mid: d.mid, name, value: d.wanted };
  }
  return null;
}

/* ────── pins across a wholesale replace (reviews F3, R4-1, R4-2) ───────── */

/** What a `page.setDoc` / `el.replace` would do to the cells a human owns. */
interface PinCarry {
  /** Pins to graft back onto the incoming node of the same mid. */
  keep: Map<Mid, Record<PinCell, PinRecord>>;
  /** Human-owned cells this document would change or destroy, unforced. */
  conflicts: CanvasDroppedIntent[];
}

/** Own-property read — a `pins`/`props` key can be `__proto__` on a hostile doc. */
function ownValue(map: Record<string, unknown> | undefined, key: string): unknown {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * The shape both sides of a pin comparison need: the live tree holds `DocNode`s,
 * the incoming one holds `DocNodeInput`s (a `node` payload's descendants may
 * carry no mid at all), and `tag` is on both — which is what makes the identity
 * check possible.
 */
interface CellHost {
  tag: string;
  text?: string;
  style?: Record<string, string>;
  props?: Record<string, unknown>;
}

/** The value of one addressed cell on a node, or `undefined` when it is absent. */
function cellValue(node: CellHost, cell: PinCell): unknown {
  if (cell === 'text') { return node.text; }
  if (cell.startsWith('style.')) { return ownValue(node.style, cell.slice('style.'.length)); }
  if (cell.startsWith('props.')) { return ownValue(node.props, cell.slice('props.'.length)); }
  return undefined;
}

/** Every node of a payload tree, parents before children (slots included). */
function* walkInput<T extends { children?: T[]; slots?: Record<string, T[]> }>(root: T): Generator<T> {
  yield root;
  for (const child of root.children ?? []) { yield* walkInput(child); }
  for (const list of Object.values(root.slots ?? {})) {
    for (const child of list) { yield* walkInput(child); }
  }
}

/**
 * Index an incoming tree by the mid each node will actually END UP with.
 *
 * `DocPatch._replace` pins the payload ROOT to the op's target mid whatever the
 * writer claimed (`_materialize(..., op.mid)`), so `rootMid` mirrors that — the
 * comparison has to be against the tree that will exist, not the one that was
 * typed. First occurrence wins, matching `_resolveMid`, which re-mints a mid a
 * later node in the same payload tries to reuse.
 */
function incomingIndex(root: DocNodeInput, rootMid?: Mid): Map<Mid, CellHost> {
  const out = new Map<Mid, CellHost>();
  let first = true;
  for (const n of walkInput(root)) {
    const mid = first && rootMid !== undefined ? rootMid : n.mid;
    first = false;
    if (typeof mid === 'string' && mid && !out.has(mid)) { out.set(mid, n); }
  }
  return out;
}

function cellEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === undefined || b === undefined) { return false; }
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * Compare the pinned cells of the CURRENT subtree against the incoming one.
 *
 * Matching is by `mid` **and `tag`** — review R4-2. A mid a model sends is a
 * matching HINT, never an authority, and the Reconciler (which the diff path
 * uses) has always refused a claimed mid whose tag differs
 * (`Reconciler.ts:383`, tier-1 contract "exists + same tag"). Matching on the
 * mid alone made the replace path strictly weaker than the path it mirrors: a
 * rebrand that reuses mids while restructuring could graft a human's ownership
 * onto an element they never touched, which
 * `plans/22-canvas-document-first.md:497` names the worst failure mode
 * precisely because it is invisible. A previous node with no structurally
 * compatible counterpart is a DESTROYED cell, not an untouched one.
 */
function pinsAcrossReplace(
  prev: DocNode,
  byMid: ReadonlyMap<Mid, CellHost>,
  force: ForceIndex,
  op: 'page.setDoc' | 'el.replace',
): PinCarry {
  const carry: PinCarry = { keep: new Map(), conflicts: [] };

  for (const p of walk(prev)) {
    const cells = pinnedCells(p);
    if (cells.length === 0) { continue; }
    const claimed = byMid.get(p.mid);
    // Same mid, different element type ⇒ not the same element.
    const incoming = claimed && claimed.tag === p.tag ? claimed : undefined;
    for (const cell of cells) {
      const record = ownValue(p.pins, cell) as PinRecord | undefined;
      const allowed = force.has(p.mid, cell);
      if (!incoming) {
        if (!allowed) {
          carry.conflicts.push({
            mid: p.mid,
            cell,
            op,
            reason: 'node-vanished',
            detail: claimed
              ? `the human owns this cell on a <${p.tag}> and the replacement puts a <${claimed.tag}> on that mid — `
                + 'a reused id does not make it the same element'
              : 'the human owns this cell and the replacement has no element with this mid',
          });
        }
        // Forced or not, ownership does NOT travel to a different element.
        continue;
      }
      if (!cellEqual(cellValue(p, cell), cellValue(incoming, cell)) && !allowed) {
        carry.conflicts.push({
          mid: p.mid,
          cell,
          op,
          reason: 'pinned-by-human',
          detail: JSON.stringify(cellValue(incoming, cell) ?? null),
        });
        continue;
      }
      // Applied or forced, the human keeps ownership of the cell.
      if (record) {
        const kept = carry.keep.get(p.mid) ?? {};
        putOwn(kept, cell, record);
        carry.keep.set(p.mid, kept);
      }
    }
  }
  return carry;
}

/** A payload node the host may stamp pins onto before it is materialized. */
type PinnableInput = DocNodeInput & { pins?: Record<PinCell, PinRecord> };

/**
 * Write the surviving pin records onto the incoming tree, first match only.
 *
 * `rootMid` mirrors `DocPatch._replace`'s forced root identity, exactly as
 * {@link incomingIndex} does, so the two always address the same node.
 */
function graftPins(next: PinnableInput, keep: Map<Mid, Record<PinCell, PinRecord>>, rootMid?: Mid): void {
  if (keep.size === 0) { return; }
  const done = new Set<Mid>();
  let first = true;
  for (const n of walkInput<PinnableInput>(next)) {
    const mid = first && rootMid !== undefined ? rootMid : n.mid;
    first = false;
    if (typeof mid !== 'string' || !mid) { continue; }
    const pins = keep.get(mid);
    if (!pins || done.has(mid)) { continue; }
    done.add(mid);
    const merged: Record<PinCell, PinRecord> = {};
    for (const [cell, rec] of Object.entries(n.pins ?? {})) { putOwn(merged, cell, rec); }
    for (const [cell, rec] of Object.entries(pins)) { putOwn(merged, cell, rec); }
    n.pins = merged;
  }
}

/**
 * The pin gate for `replace_element` (review R4-1).
 *
 * `el.replace` materializes a whole new subtree onto the target's mid, so it
 * overwrites both the human's VALUES and the pin RECORDS that protect them —
 * and it is the tool a model reaches for the moment `set_text` refuses. The
 * comparison is the same one `write_page { replace: true }` runs, scoped to the
 * subtree, and `force` is scoped the same way (`"<mid>:<cell>"`) because a
 * subtree can hold many elements.
 */
function guardReplacePins(
  ctx: CanvasToolContext,
  pageId: string,
  mid: Mid,
  node: DocNodeInput,
  rawForce: unknown,
): { ok: true; node: DocNodeInput } | { ok: false; result: CanvasToolResult } {
  const page = ctx.store.getPage(ctx.artifact, pageId);
  const target = page ? findNode(page.doc, mid) : null;
  // No page or no such element: the executor owns that error, not this gate.
  if (!target) { return { ok: true, node }; }
  let pinned = false;
  for (const n of walk(target)) { if (pinnedCells(n).length > 0) { pinned = true; break; } }
  if (!pinned) { return { ok: true, node }; }

  const parsed = parseScopedForce(rawForce, 'replace_element');
  if (!parsed.ok) { return { ok: false, result: { ok: false, error: parsed.error } }; }

  const carry = pinsAcrossReplace(target, incomingIndex(node, mid), parsed.index, 'el.replace');
  if (carry.conflicts.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        error: `replace refused: ${carry.conflicts.length} cell(s) in this subtree are user-set and this replacement `
          + `would change or destroy them (${carry.conflicts.map(c => `${c.mid}:${c.cell}`).join(', ')}). `
          + 'Edit the parts you mean with set_text/set_style/set_prop instead — or, only if the user asked for those '
          + 'specific changes, name them in force as "<mid>:<cell>".',
        dropped: carry.conflicts,
      },
    };
  }
  // Surviving pins ride along: the human still owns the cell afterwards.
  graftPins(node, carry.keep, mid);
  return { ok: true, node };
}

function parseStyleMap(v: unknown): { ok: true; value: Record<string, string | null> } | { ok: false; error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: 'set_style requires a style object, e.g. {"background":"var(--color-primary)"}' };
  }
  const out: Record<string, string | null> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === null) { putOwn(out, k, null); continue; }
    if (typeof raw === 'string' || typeof raw === 'number') { putOwn(out, k, String(raw)); continue; }
    return { ok: false, error: `set_style: value for "${k}" must be a string, a number, or null` };
  }
  if (Object.keys(out).length === 0) { return { ok: false, error: 'set_style: the style object was empty' }; }
  return { ok: true, value: out };
}

/**
 * A new element, from `jsx` (one element) or from a `node` object.
 *
 * A JSX-supplied element goes through the SAME compiler front door as a whole
 * page — there is no second, less-validated parser — and then has its
 * compiler-minted ids stripped, so `DocPatch` mints them and reports them back
 * in `newMids`. A `node` object keeps whatever `mid` the writer claimed: the
 * host verifies it, and a forged one gains nothing because pin enforcement is
 * on the target cell, not on the claimed identity.
 */
function nodeInputFrom(args: Args, tool: string): { ok: true; node: DocNodeInput } | { ok: false; error: string } {
  if (args.node && typeof args.node === 'object' && !Array.isArray(args.node)) {
    const raw = args.node as { tag?: unknown };
    if (typeof raw.tag !== 'string' || !raw.tag.trim()) {
      return { ok: false, error: `${tool}: node requires a tag, e.g. {"tag":"UI.Button","props":{"label":"Save"}}` };
    }
    // The `jsx` branch has always been guarded; a `node` object carries the
    // same clamped strings in `text` and `props` and became the way around it.
    const echoed = clampEchoRefusal(args.node, tool, 'this node');
    if (echoed) { return { ok: false, error: echoed.error ?? 'clamped node' }; }
    return { ok: true, node: sanitizeNodeInput(args.node as DocNodeInput) };
  }
  if (typeof args.jsx === 'string' && args.jsx.trim()) {
    const src = stripFence(args.jsx.trim());
    if (containsClampMarker(src)) {
      return { ok: false, error: `${tool}: this jsx still carries a "… [clamped …] …" marker — it is only part of the element you read.` };
    }
    const compiled = compile(`function Page() {\n  return (\n${src}\n  );\n}`);
    if (!compiled.ok) { return { ok: false, error: `${tool}: could not parse jsx — ${compiled.error}` }; }
    return { ok: true, node: stripMids(sanitizeNodeInput(compiled.doc)) };
  }
  return { ok: false, error: `${tool} requires \`jsx\` (one element) or a \`node\` object {tag, props?, style?, text?, children?}` };
}

function stripMids(node: DocNodeInput): DocNodeInput {
  const out: DocNodeInput = { ...node };
  delete out.mid;
  if (out.children) { out.children = out.children.map(stripMids); }
  if (out.slots) {
    const slots: Record<string, DocNodeInput[]> = {};
    for (const [k, list] of Object.entries(out.slots)) { putOwn(slots, k, list.map(stripMids)); }
    out.slots = slots;
  }
  return out;
}

/**
 * The mids the INCOMING source claimed, read from the text rather than from the
 * compiled tree — the compiler mints an id for every node that lacks one, so by
 * the time it returns, an echoed id and a fresh id are indistinguishable.
 */
function claimedMidsIn(source: string): Mid[] {
  const out = new Set<Mid>();
  const patterns = [/\bmid\s*=\s*"([^"]{1,64})"/g, /\bmid\s*=\s*\{\s*['"]([^'"]{1,64})['"]\s*\}/g];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      if (isMid(m[1])) { out.add(m[1]); }
    }
  }
  return [...out];
}

/** The seed document for `add_page`: a scaffold, supplied JSX, or a blank artboard. */
function seedDocFor(args: Args): { ok: true; doc: DocNode; defaultTitle?: string } | { ok: false; error: string } {
  if (typeof args.scaffold === 'string' && args.scaffold.trim()) {
    const scaffold = getScaffold(args.scaffold.trim());
    if (!scaffold) { return { ok: false, error: `unknown scaffold: ${args.scaffold.trim()} (see list_scaffolds)` }; }
    const compiled = compile(scaffold.jsx);
    if (!compiled.ok) { return { ok: false, error: `scaffold ${scaffold.id} is invalid: ${compiled.error}` }; }
    return { ok: true, doc: compiled.doc, defaultTitle: scaffold.name };
  }
  if (typeof args.jsx === 'string' && args.jsx.trim()) {
    const cleaned = cleanJsx(args.jsx);
    if (!cleaned.ok) { return { ok: false, error: cleaned.error }; }
    const compiled = compile(cleaned.source);
    if (!compiled.ok) { return { ok: false, error: `the page source is outside the supported JSX subset: ${compiled.error}` }; }
    return { ok: true, doc: compiled.doc };
  }
  return { ok: true, doc: emptyDoc() };
}

function stripFence(src: string): string {
  const fence = src.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return fence ? fence[1].trim() : src;
}

/**
 * Validate + normalize an agent-supplied JSX page: strip code fences, require a
 * single `function Page()` component, and reject top-level imports/require (the
 * sandbox preloads React/UI.* — pages must not import).
 */
function cleanJsx(raw: unknown): { ok: true; source: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) { return { ok: false, error: 'write_page requires non-empty jsx' }; }
  const src = stripFence(raw.trim());
  if (/^\s*import\s/m.test(src) || /\brequire\s*\(/.test(src)) {
    return { ok: false, error: 'JSX pages must not import/require — React and UI.* are preloaded by the sandbox' };
  }
  if (!/function\s+Page\s*\(/.test(src)) {
    return { ok: false, error: 'JSX page must define a single `function Page()` component' };
  }
  if (containsClampMarker(src)) {
    return {
      ok: false,
      error: 'this source still carries a "… [clamped …] …" marker, so it is the artboard you were shown, not the '
        + 'artboard that exists — writing it back would delete everything the clamp cut. Use find_nodes/get_node to '
        + 'work on the part you mean, and set_text/set_style/set_prop to change it.',
    };
  }
  return { ok: true, source: src };
}
