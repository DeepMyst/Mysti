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
 * Plan 22 3.4 / 3.5 - the canvas webview's state, and the two rules that make
 * a co-edited canvas survive contact with an agent.
 *
 * ## Rule 1: view state is sovereign, artifact state is op-mediated
 *
 * `media/canvas/canvas.js:212-219` changed the device by mutating local state
 * and posting NOTHING, then `:274` `Object.assign`ed the next agent update
 * straight over it. So the one human affordance in the canvas was both LOST on
 * the next edit and, while it lasted, a silent divergence between what the
 * human saw and what the agent was editing.
 *
 * 3.5 splits the two cases that were conflated:
 *
 * | artifact state (shared, persisted, op-mediated) | view state (local, sovereign) |
 * |---|---|
 * | theme, tokens, per-artboard format, docs, board positions, page order | selection, hover, zoom, pan, focused artboard, *previewed* device, inspector tab |
 *
 * "Switch to mobile to check this layout" is {@link changeDevice} with scope
 * `'preview'`: local, never posted, never overwritten by an incoming artifact.
 * "This artboard IS a mobile screen" is scope `'artboard'`: a `page.setMeta`
 * op down the same chokepoint every agent write uses. Both are one function so
 * the distinction cannot be forgotten at a call site.
 *
 * ## Rule 2: steady state is deltas, not re-renders
 *
 * {@link planRender} is the decision the whole phase turns on. Given the
 * records on a `canvas/ops` message it decides, per artboard, between pushing
 * ops down a live frame's port (cheap, preserves scroll/focus/hover/animation)
 * and rebuilding the frame (expensive, destroys all four). It is a pure
 * function precisely so that decision is unit-testable without a DOM.
 *
 * It reads records **structurally** rather than assuming an era: a record
 * carrying a `CanvasOp` under `op` is a delta; a pre-Phase-2 `{kind,
 * proposedValue}` record is an honest page reload. So the delta path lights up
 * the moment `protocol.ts` re-points its `CanvasOpRecord` alias, with no
 * flag-day and no second copy of the wire type here.
 */

import type {
  CanvasOpReceipt,
  CanvasOpRecord,
  LegacyCanvasOpWireRecord,
  WireArtifact,
} from '../../canvas/protocol';
import { isLegacyCanvasOpRecord } from '../../canvas/protocol';
import type { CanvasOp } from '../../canvas/CanvasOps';
import { isCanvasOpKind, opPageId } from '../../canvas/CanvasOps';
import { applyOp, isDocScopedOp } from '../../canvas/doc/DocPatch';
import type { DocNode, Mid } from '../../canvas/doc/DocNode';
import type { ArtifactPage, CanvasFormatSpec, DesignTheme } from '../../types';

/* ------------------------------- view state ------------------------------- */

export interface CanvasViewState {
  /** Board zoom. 1 = 100%. */
  zoom: number;
  pan: { x: number; y: number };
  selection: { pageId: string | null; mids: Mid[] };
  hover: { pageId: string | null; mid: Mid | null };
  focusedPageId: string | null;
  /**
   * A device the human is *previewing*. Local and sovereign: it overrides the
   * artboard's own format for rendering only, is never posted, and survives
   * every incoming artifact. `null` = show each artboard at its real format.
   */
  previewFormat: CanvasFormatSpec | null;
  inspectorTab: 'page' | 'theme';
  onboardingDismissed: boolean;
}

export function initialViewState(): CanvasViewState {
  return {
    zoom: 1,
    pan: { x: 0, y: 0 },
    selection: { pageId: null, mids: [] },
    hover: { pageId: null, mid: null },
    focusedPageId: null,
    previewFormat: null,
    inspectorTab: 'page',
    onboardingDismissed: false,
  };
}

/** What a device switch means. See the module docs. */
export type DeviceScope = 'preview' | 'artboard';

export interface ViewIntent {
  /** The next view state. Always returned, even when nothing changed. */
  view: CanvasViewState;
  /** Ops to submit. EMPTY for a pure view change - that is the whole point. */
  ops: CanvasOp[];
}

/**
 * Change device. `'preview'` mutates only view state and emits no op;
 * `'artboard'` emits `page.setMeta` and clears the preview override so the
 * human immediately sees the artboard's real, now-shared format.
 */
export function changeDevice(
  view: CanvasViewState,
  scope: DeviceScope,
  format: CanvasFormatSpec,
  targetPageId: string | null,
): ViewIntent {
  if (scope === 'preview') {
    return { view: { ...view, previewFormat: format }, ops: [] };
  }
  if (!targetPageId) {
    // Nothing selected: refuse to guess which artboard the human meant, and
    // degrade to a preview rather than writing the format onto every page.
    return { view: { ...view, previewFormat: format }, ops: [] };
  }
  return {
    view: { ...view, previewFormat: null },
    ops: [{ op: 'page.setMeta', pageId: targetPageId, patch: { format } }],
  };
}

/**
 * Theme is artifact state with no view-state twin: there is no such thing as
 * "preview a theme locally" that would not immediately mislead, because the
 * agent's next edit is authored against the shared theme.
 */
export function changeTheme(theme: DesignTheme): CanvasOp[] {
  return [{ op: 'theme.set', theme }];
}

/** The format an artboard renders at: preview override, else its own, else the artifact's. */
export function effectiveFormat(
  artifact: WireArtifact,
  page: ArtifactPage,
  view: CanvasViewState,
): CanvasFormatSpec {
  return view.previewFormat ?? page.format ?? artifact.format;
}

/* ---------------------------- record normalizing ---------------------------- */

/**
 * The op-kind guard, re-exported from the algebra rather than re-declared.
 *
 * It used to be a second `Record<CanvasOpKindV2, true>` here. Two copies of the
 * same TS-enforced table is exactly the drift this subsystem died of three
 * times over (§2.9), so the table lives in `CanvasOps.ts` — next to the union
 * it enumerates — and both ends import it.
 */
export { isCanvasOpKind };

/**
 * The `CanvasOp` a wire record carries, or `null` for a pre-Phase-2 record.
 *
 * Structural on purpose: `protocol.ts` still aliases `CanvasOpRecord` at the
 * legacy `{kind, proposedValue}` record while the executor migrates. Reading
 * the field rather than the era means neither end needs a flag day, and means
 * this module never declares a competing copy of the wire type.
 */
export function recordOp(record: CanvasOpRecord): CanvasOp | null {
  if (!record || typeof record !== 'object' || !('op' in record)) { return null; }
  const candidate = (record as { op?: unknown }).op;
  if (!candidate || typeof candidate !== 'object') { return null; }
  const kind = (candidate as { op?: unknown }).op;
  return isCanvasOpKind(kind) ? (candidate as CanvasOp) : null;
}

/** Records that did not change the document are not render input. */
function isCommitted(record: CanvasOpRecord): boolean {
  return record.status === 'applied';
}

/* ------------------------------- render plan ------------------------------- */

export interface RenderPlan {
  /** Ops to post down each MOUNTED artboard's port. The steady state. */
  patches: Map<string, CanvasOp[]>;
  /** Artboards whose frame must be rebuilt - a legacy record, nothing finer. */
  reload: Set<string>;
  /** The artboard list changed (add / remove / reorder / move). */
  structure: boolean;
  /** Theme or artifact format changed - re-inject CSS vars into every frame. */
  theme: boolean;
  /** The client cannot reconstruct state locally; ask the host to resend. */
  resync: boolean;
}

export function emptyPlan(): RenderPlan {
  return { patches: new Map(), reload: new Set(), structure: false, theme: false, resync: false };
}

/** True when nothing in the plan requires any DOM work. */
export function planIsNoop(plan: RenderPlan): boolean {
  return plan.patches.size === 0 && plan.reload.size === 0
    && !plan.structure && !plan.theme && !plan.resync;
}

function addPatch(plan: RenderPlan, pageId: string, op: CanvasOp): void {
  const list = plan.patches.get(pageId);
  if (list) { list.push(op); } else { plan.patches.set(pageId, [op]); }
}

/**
 * Decide, per artboard, between a delta and a rebuild.
 *
 * The property that matters and is asserted in the tests: a run of element ops
 * on a mounted page produces `patches` only - `reload` stays empty and
 * `structure`/`theme` stay false, so the iframe is never touched and React
 * reconciliation keeps scroll, focus, hover, input values and animation.
 */
export function planRender(records: readonly CanvasOpRecord[]): RenderPlan {
  const plan = emptyPlan();
  for (const record of records) {
    if (!isCommitted(record)) { continue; }
    const op = recordOp(record);
    if (op) { planForOp(plan, op); }
    else if (isLegacyCanvasOpRecord(record)) { planForLegacy(plan, record); }
    // A v2 record whose `op` we could not read is a record from a NEWER host:
    // do not guess what it did, ask for the whole thing.
    else { plan.resync = true; }
  }
  return plan;
}

function planForOp(plan: RenderPlan, op: CanvasOp): void {
  switch (op.op) {
    // Doc-scoped: the frame patches in place. THE steady state.
    case 'el.setText': case 'el.setStyle': case 'el.setProp':
    case 'el.insert': case 'el.remove': case 'el.move': case 'el.replace':
    case 'page.setDoc': {
      const pageId = opPageId(op);
      if (pageId) { addPatch(plan, pageId, op); } else { plan.resync = true; }
      return;
    }
    // Board layout: reposition/reorder the artboard element, never remount it.
    case 'page.move': case 'page.reorder':
      plan.structure = true;
      return;
    case 'page.setMeta':
      // A format change resizes the frame box; content is untouched.
      plan.structure = true;
      return;
    // A new artboard's id is minted host-side, so the client cannot invent it.
    case 'page.add': case 'page.duplicate':
      plan.structure = true;
      plan.resync = true;
      return;
    case 'page.remove':
      plan.structure = true;
      return;
    // `artifact.format` is a LAYOUT input, not a theme one: `effectiveFormat`
    // falls back to it for every artboard that declares no format of its own,
    // and only `_layout` reads it. Grouped with the theme ops it was answered
    // by `_pushTheme()` - custom properties, a re-`mount`, a preview redraw -
    // which re-laid-out nothing, so `set_format` left every artboard element at
    // its old desktop box while the rail thumbnails reflowed beside them. It is
    // the same class of change as `page.setMeta{format}` above.
    case 'artifact.setFormat':
      plan.structure = true;
      return;
    case 'theme.set': case 'theme.setToken':
      plan.theme = true;
      return;
    case 'asset.add':
      // Assets are content-addressed; a page referencing one re-renders when
      // its own op arrives. Nothing to do here.
      return;
    default: {
      const never: never = op;
      void never;
      plan.resync = true;
    }
  }
}

/**
 * Pre-Phase-2 records carry a page-sized `proposedValue` and no element
 * identity, so the honest render is a frame rebuild for the affected page -
 * flicker, stated plainly, rather than a delta that would silently drop edits.
 */
function planForLegacy(plan: RenderPlan, record: LegacyCanvasOpWireRecord): void {
  const pageId = typeof record.targetPageId === 'string' ? record.targetPageId : null;
  switch (record.kind) {
    case 'edit_page': case 'edit_element':
      if (pageId) { plan.reload.add(pageId); } else { plan.resync = true; }
      return;
    case 'insert_page': case 'delete_page': case 'reorder':
      plan.structure = true;
      plan.resync = true;
      return;
    case 'set_theme': case 'set_format':
      plan.theme = true;
      plan.resync = true;
      return;
    case 'add_asset':
      return;
    default:
      plan.resync = true;
  }
}

/* --------------------------------- store --------------------------------- */

export type ApplyOutcome =
  | { ok: true; plan: RenderPlan }
  /** Records predate what we already have - a duplicate delivery. Ignore. */
  | { ok: false; reason: 'stale' }
  /** Versions skipped: some records never arrived. Ask for `canvas/resync`. */
  | { ok: false; reason: 'gap' }
  | { ok: false; reason: 'no-artifact' };

/** Prototype-pollution guard for `theme.setToken`'s dotted path. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * The webview's copy of the artifact.
 *
 * It exists so the parent can draw a static preview of any artboard without a
 * round-trip; it is a CACHE, never an authority. Whenever it cannot faithfully
 * reproduce what the host did (a minted page id, an op kind it does not model),
 * it says so and the caller asks for `canvas/resync` rather than guessing -
 * that is the difference between a cache and a second writer.
 */
export class CanvasStore {
  private _artifact: WireArtifact | null = null;
  private _version = 0;
  private _lastReceipt: CanvasOpReceipt | null = null;

  get artifact(): WireArtifact | null { return this._artifact; }
  get version(): number { return this._version; }
  get lastReceipt(): CanvasOpReceipt | null { return this._lastReceipt; }

  /** `canvas/hello` and `canvas/resync` are both authoritative full transfers. */
  load(artifact: WireArtifact, version?: number): void {
    this._artifact = artifact;
    this._version = typeof version === 'number' ? version : artifact.version;
  }

  noteReceipt(receipt: CanvasOpReceipt): void {
    this._lastReceipt = receipt;
    // A receipt is not a state transfer; it only ever moves the version
    // FORWARD, and only when the caller has already seen the matching records.
    if (typeof receipt.artifactVersion === 'number' && receipt.artifactVersion > this._version) {
      this._version = receipt.artifactVersion;
    }
  }

  page(pageId: string): ArtifactPage | null {
    return this._artifact?.pages.find(p => p.id === pageId) ?? null;
  }

  /**
   * Fold a `canvas/ops` message into the cached artifact.
   *
   * The gap check is what makes a dropped message visible instead of silently
   * desynchronising the board: the host bumps `artifact.version` once per
   * applied op, so more version than records means we missed some.
   */
  applyOps(records: readonly CanvasOpRecord[], artifactVersion: number): ApplyOutcome {
    if (!this._artifact) { return { ok: false, reason: 'no-artifact' }; }
    if (typeof artifactVersion !== 'number' || !Number.isFinite(artifactVersion)) {
      return { ok: false, reason: 'gap' };
    }
    if (artifactVersion < this._version) { return { ok: false, reason: 'stale' }; }
    const committed = records.filter(isCommitted).length;
    if (artifactVersion > this._version + committed) { return { ok: false, reason: 'gap' }; }

    const plan = planRender(records);
    for (const record of records) {
      if (!isCommitted(record)) { continue; }
      const op = recordOp(record);
      if (!op) { continue; }                     // legacy record: plan says reload
      if (!this._applyToArtifact(op)) { plan.resync = true; }
    }
    this._version = artifactVersion;
    this._artifact.version = artifactVersion;
    return { ok: true, plan };
  }

  /** @returns false when the client could not faithfully apply the op. */
  private _applyToArtifact(op: CanvasOp): boolean {
    const artifact = this._artifact;
    if (!artifact) { return false; }

    if (isDocScopedOp(op)) {
      const pageId = opPageId(op);
      const page = pageId ? this.page(pageId) : null;
      if (!page) { return false; }
      try {
        const result = applyOp(page.doc, op);
        // A minted mid is a DIVERGENCE, never an apply. `applyOp` invents an id
        // for every node the writer sent without one (the shape `stripMids`
        // deliberately produces for `insert_element` / `replace_element` /
        // `write_page`), and the mint is `Math.random()`-backed. The host ran
        // the same pure function first and got a DIFFERENT id, and it never
        // rewrites `record.op` with what it minted - `newMids` rides only on
        // the receipt, which this client discards. Committing this would give
        // one element two identities: every later op addressed to the host's id
        // would miss here, and the preview/rail/inspector would hit-test a mid
        // that exists nowhere else. So refuse, and let the caller ask for the
        // truth - that is the difference between a cache and a second writer.
        if (mintedAny(result.newMids)) { return false; }
        page.doc = result.doc;
        page.version += 1;
        // `jsxCache` is derived host-side by DocEmitter; a stale cache in the
        // webview's copy would be a second source of truth, so drop it.
        page.jsxCache = undefined;
        return true;
      } catch {
        return false;                            // vanished mid: resync
      }
    }

    switch (op.op) {
      case 'page.setMeta': {
        const page = this.page(op.pageId);
        if (!page) { return false; }
        if (op.patch.actionTitle !== undefined) { page.actionTitle = op.patch.actionTitle; }
        if (op.patch.notes !== undefined) { page.notes = op.patch.notes; }
        if (op.patch.format !== undefined) { page.format = op.patch.format; }
        return true;
      }
      case 'page.move': {
        const page = this.page(op.pageId);
        if (!page) { return false; }
        page.boardPos = { x: op.boardPos.x, y: op.boardPos.y };
        return true;
      }
      case 'page.remove': {
        const before = artifact.pages.length;
        artifact.pages = artifact.pages.filter(p => p.id !== op.pageId);
        return artifact.pages.length < before;
      }
      case 'page.reorder': {
        const byId = new Map(artifact.pages.map(p => [p.id, p]));
        const ordered: ArtifactPage[] = [];
        for (const id of op.orderedIds) {
          const page = byId.get(id);
          if (page && !ordered.includes(page)) { ordered.push(page); }
        }
        if (ordered.length !== artifact.pages.length) { return false; }
        artifact.pages = ordered;
        return true;
      }
      case 'theme.set':
        artifact.theme = op.theme;
        return true;
      case 'theme.setToken':
        return setThemeToken(artifact.theme, op.path, op.value);
      case 'artifact.setFormat':
        artifact.format = op.format;
        return true;
      case 'asset.add':
        artifact.assets = [...artifact.assets, op.asset];
        return true;
      // Host mints the id; the client must not invent one.
      case 'page.add': case 'page.duplicate':
        return false;
      default:
        return false;
    }
  }
}

/** True when {@link applyOp} had to invent an id for this payload. */
function mintedAny(newMids: Record<string, Mid> | undefined): boolean {
  return !!newMids && Object.keys(newMids).length > 0;
}

/**
 * Set a dotted theme token path (`colors.primary`).
 *
 * Refuses `__proto__`/`prototype`/`constructor` at every segment: the path
 * arrives from a model-authored op, and a `theme.setToken` with path
 * `__proto__.polluted` would otherwise poison every object in the webview.
 */
export function setThemeToken(theme: DesignTheme, path: string, value: string): boolean {
  if (typeof path !== 'string' || typeof value !== 'string') { return false; }
  const segments = path.split('.');
  if (segments.length === 0 || segments.length > 6) { return false; }
  let cursor: Record<string, unknown> = theme as unknown as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (!key || UNSAFE_KEYS.has(key)) { return false; }
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) { return false; }
    cursor = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (!leaf || UNSAFE_KEYS.has(leaf)) { return false; }
  cursor[leaf] = value;
  return true;
}

/** The doc an artboard renders from. */
export function pageDoc(page: ArtifactPage): DocNode {
  return page.doc;
}
