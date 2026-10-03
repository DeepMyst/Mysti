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
 * Plan 22 §3.3 / Phase 4 — the agent's tool surface, GENERATED FROM the op
 * algebra rather than hand-maintained beside it.
 *
 * The premise of §2.3 is "one op algebra, N producers": the set of ops the
 * agent can perform is exactly the set the UI performs. That property only
 * survives if it is *derived and asserted* rather than written down twice, so
 * this module carries, in one place:
 *
 *  - {@link CANVAS_TOOL_SURFACE} — every tool, each declaring which
 *    {@link CanvasOpKindV2} variants a successful call can produce;
 *  - {@link CANVAS_OP_PRODUCERS} — the inverse index, typed
 *    `Record<CanvasOpKindV2, …>` so adding a variant to the algebra without
 *    giving it a tool is a `tsc` failure, not a runtime surprise;
 *  - {@link CANVAS_UI_GESTURES} — the human gesture that produces each variant,
 *    named by module, so "the agent is one more editor" is checkable;
 *  - {@link CANVAS_PROMPT_EXAMPLES} — the worked examples the system prompt
 *    shows, in machine-readable form, so every example the model is taught can
 *    be round-tripped back through the real parser + dispatcher in a test.
 *
 * That last one is not decoration. The shipped bug this replaces was a single
 * worked example teaching `scaffold_page` as a FENCED op kind that
 * `CanvasOpParser.VALID_KINDS` rejected — and the rejection died in a
 * `console.warn` invisible to both the model and the user.
 */

import type { CanvasOpKindV2 } from './CanvasOps';
import type { CanvasOpKind } from '../types';

/* ────────────────────────────── tool specs ────────────────────────────── */

export type CanvasToolAccess = 'read-only' | 'write';

/**
 * How prominently a tool is offered.
 *
 * - `primary` — the Plan 22 §3.3 surface: taught in the system prompt and
 *   offered as native `canvas_*` function schemas.
 * - `extra` — real capability outside the element-editing core (scaffolds,
 *   theme presets, imports, assets). Offered natively, mentioned in one line.
 * - `compat` — a superseded name kept dispatchable so an older prompt, a
 *   replayed transcript or a model reaching for the previous vocabulary still
 *   lands on the SAME write path. Never taught, never offered natively.
 */
export type CanvasToolTier = 'primary' | 'extra' | 'compat';

export interface CanvasToolSpec {
  name: string;
  access: CanvasToolAccess;
  tier: CanvasToolTier;
  /** Prefixed `READ-ONLY (...)` / `WRITE (...)` per the transport contract. */
  description: string;
  /** JSON-schema-ish shape the MCP server and the native lane expose. */
  inputSchema: Record<string, unknown>;
  /**
   * The op variants a SUCCESSFUL call can commit. Empty for reads and for the
   * two write tools that mutate history rather than the document
   * (`checkpoint`) — an honest empty, not an omission.
   */
  produces: readonly CanvasOpKindV2[];
  /**
   * Excluded from native `tool_calls`. True only for tools whose argument is a
   * whole artboard: the coordinator generates under a token cap and both
   * length-continuation branches are skipped on a tool-call turn, so a cut
   * lands mid-JSON and the model burns its budget re-truncating. Those ride the
   * `<canvaspage:NONCE>` TEXT directive instead, where the scanner is carried
   * across the cut.
   */
  nativeExcluded?: boolean;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required });

const MID_ARG = { type: 'string', description: 'element id, exactly as get_page_jsx returned it' };
const PAGE_ARG = { type: 'string', description: 'artboard id' };
const BASE_VERSION_ARG = { type: 'number', description: 'the version you read; omit if you did not read one' };
const FORCE_ARG = {
  type: 'array',
  items: { type: 'string' },
  description: 'cells marked ⟂user-set that this edit is allowed to overwrite (only when the user asked for that specific change)',
};
/**
 * `force` for the ONE tool that does not already name an element.
 *
 * The pin gate matches a forced cell by NAME, so a bare `"text"` on a
 * whole-artboard rewrite means "overwrite the human's text everywhere on this
 * artboard" — which silently reverted every other string the user had typed.
 * `write_page` therefore requires the element too, and refuses the bare form
 * with a message naming this spelling.
 */
export const SCOPED_FORCE_ARG = {
  type: 'array',
  items: { type: 'string' },
  description: '"<mid>:<cell>" entries the user asked you to overwrite, e.g. ["k7f2xq6b3m:text"]. '
    + 'A bare cell name is refused — it could only ever apply to every element on the artboard.',
};

/**
 * `write_page`'s arguments, shared verbatim with its alias.
 *
 * Round-4 R4-4: `write_page_jsx` had drifted onto the bare {@link FORCE_ARG}
 * while both names dispatch to the same `writePage()` — which runs
 * `parseScopedForce` and hard-refuses a bare cell name. `listMcpTools()`
 * publishes the whole catalog, compat tier included, so an MCP-connected CLI
 * agent was handed a schema whose documented spelling could never land. One
 * object, one truth: the alias cannot drift again.
 */
const WRITE_PAGE_SCHEMA = obj({
  pageId: PAGE_ARG,
  jsx: { type: 'string', description: 'a complete function Page() component' },
  actionTitle: { type: 'string' },
  baseVersion: BASE_VERSION_ARG,
  replace: {
    type: 'boolean',
    description: 'replace the document wholesale instead of diffing (drops element identity). '
      + 'Refused when it would change or destroy a ⟂user-set cell — keep the mids and drop this flag so the rewrite is diffed instead.',
  },
  force: SCOPED_FORCE_ARG,
}, ['jsx']);

/* ───────────────────────────── the catalog ───────────────────────────── */

/**
 * Every canvas tool, in the order they are offered.
 *
 * Reads first — orientation is cheap and the model should pay for it before it
 * writes — then the element-editing writes, then the extras, then the compat
 * names nothing is taught.
 */
export const CANVAS_TOOL_SURFACE: readonly CanvasToolSpec[] = [
  /* ── reads ── */
  {
    name: 'get_artifact_index',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (compact one-line-per-page index of the whole artifact). Your first call in any design turn — it is the cheapest way to know what exists.',
    inputSchema: obj({}),
    produces: [],
  },
  {
    name: 'list_pages',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (list the artboards with id, mode, version and title).',
    inputSchema: obj({}),
    produces: [],
  },
  {
    name: 'get_page_jsx',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (the artboard as JSX, every element carrying its mid="…" and every human-owned cell marked /* ⟂user-set: … */). Read this before editing: the mids are how you address a single element, and the ⟂user-set marks are what you must not overwrite.',
    inputSchema: obj({ pageId: PAGE_ARG }, ['pageId']),
    produces: [],
  },
  {
    name: 'get_node',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (one element subtree by mid — tag, props, style, pinned cells and its JSX). Far cheaper than re-reading a whole artboard to check one card.',
    inputSchema: obj({ pageId: PAGE_ARG, mid: MID_ARG }, ['pageId', 'mid']),
    produces: [],
  },
  {
    name: 'find_nodes',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (find elements by tag and/or text substring, across one artboard or all of them; returns mid + tag + text). Use it to turn "the sign-in button" into a mid.',
    inputSchema: obj({
      pageId: PAGE_ARG,
      tag: { type: 'string', description: 'exact tag, e.g. "UI.Button" or "h1"' },
      text: { type: 'string', description: 'case-insensitive substring of the element text' },
      limit: { type: 'number', description: 'max results (default 50)' },
    }),
    produces: [],
  },
  {
    name: 'page_coordinates',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (anchor geometry — center, rule-of-thirds points, safe rect — for the artifact format).',
    inputSchema: obj({}),
    produces: [],
  },
  {
    name: 'validate_page',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (static design checks — empty page, missing actionTitle, raw hex, unresolved asset refs, overflow). Run it after every edit and fix what it reports before declaring the page done.',
    inputSchema: obj({ pageId: PAGE_ARG, reportedContentHeight: { type: 'number' } }, ['pageId']),
    produces: [],
  },
  {
    name: 'list_scaffolds',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (curated app/web page scaffolds — login, dashboard, mobile-home, settings, landing — optionally filtered by device). Start a screen from one with add_page instead of from a blank artboard.',
    inputSchema: obj({ device: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'web'] } }),
    produces: [],
  },
  {
    name: 'list_theme_presets',
    access: 'read-only',
    tier: 'primary',
    description: 'READ-ONLY (curated design-system presets — clean-saas, midnight, editorial, playful, minimal-mono, forest — with swatches). Feed one to set_theme.',
    inputSchema: obj({}),
    produces: [],
  },

  /* ── writes: artboards ── */
  {
    name: 'add_page',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: add an artboard. Seed it from a scaffold id (see list_scaffolds), from `jsx` (a single function Page() component), or from neither for a blank one.',
    inputSchema: obj({
      scaffold: { type: 'string', description: 'scaffold id from list_scaffolds' },
      jsx: { type: 'string', description: 'a complete function Page() component; no imports' },
      actionTitle: { type: 'string' },
      index: { type: 'number', description: 'position in the rail (default: last)' },
      notes: { type: 'string' },
    }),
    produces: ['page.add'],
  },
  {
    name: 'remove_page',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: delete an artboard (undoable).',
    inputSchema: obj({ pageId: PAGE_ARG, baseVersion: BASE_VERSION_ARG }, ['pageId']),
    produces: ['page.remove'],
  },
  {
    name: 'duplicate_page',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: copy an artboard. Pass variantOf to group the copy with its source as a design variant the user can compare and adopt.',
    inputSchema: obj({ pageId: PAGE_ARG, variantOf: { type: 'string', description: 'artboard id this is a variant of (default: pageId)' } }, ['pageId']),
    produces: ['page.duplicate'],
  },
  {
    name: 'set_page_meta',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: retitle an artboard, attach notes, or give it its own device format ("this screen is a phone").',
    inputSchema: obj({
      pageId: PAGE_ARG,
      actionTitle: { type: 'string' },
      notes: { type: 'string' },
      formatId: { type: 'string', description: 'catalog format id for THIS artboard only' },
      width: { type: 'number' },
      height: { type: 'number' },
      baseVersion: BASE_VERSION_ARG,
    }, ['pageId']),
    produces: ['page.setMeta'],
  },
  {
    name: 'move_page',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: place an artboard on the board at (x, y). Use it to lay a flow out left-to-right instead of leaving artboards stacked.',
    inputSchema: obj({ pageId: PAGE_ARG, x: { type: 'number' }, y: { type: 'number' } }, ['pageId', 'x', 'y']),
    produces: ['page.move'],
  },
  {
    name: 'reorder_pages',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: reorder the artboards to match the given list of ids.',
    inputSchema: obj({ orderedIds: { type: 'array', items: { type: 'string' } } }, ['orderedIds']),
    produces: ['page.reorder'],
  },
  {
    name: 'write_page',
    access: 'write',
    tier: 'primary',
    nativeExcluded: true,
    description: 'WRITE: create or rewrite a whole artboard from JSX (a single function Page() component; no imports). On an existing artboard the source is diffed down to element edits, so untouched elements keep their identity and human-owned cells are preserved — the receipt reports {applied, dropped}. Prefer set_text/set_style/set_prop for small changes.',
    inputSchema: WRITE_PAGE_SCHEMA,
    produces: ['page.add', 'page.setDoc', 'el.setText', 'el.setStyle', 'el.setProp', 'el.insert', 'el.remove', 'el.move', 'el.replace'],
  },

  /* ── writes: elements ── */
  {
    name: 'set_text',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: set the text of ONE element, addressed by mid.',
    inputSchema: obj({ pageId: PAGE_ARG, mid: MID_ARG, text: { type: 'string' }, baseVersion: BASE_VERSION_ARG, force: FORCE_ARG }, ['pageId', 'mid', 'text']),
    produces: ['el.setText'],
  },
  {
    name: 'set_style',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: set CSS properties on ONE element. Values are camelCase-or-kebab CSS; null clears a property. Prefer theme tokens (var(--color-primary)) over raw hex.',
    inputSchema: obj({
      pageId: PAGE_ARG,
      mid: MID_ARG,
      style: { type: 'object', description: 'e.g. {"background":"var(--color-primary)","padding":"24px"}; null clears' },
      baseVersion: BASE_VERSION_ARG,
      force: FORCE_ARG,
    }, ['pageId', 'mid', 'style']),
    produces: ['el.setStyle'],
  },
  {
    name: 'set_prop',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: set ONE literal prop on ONE element (variant, label, gap, items, …). null removes the prop.',
    inputSchema: obj({
      pageId: PAGE_ARG,
      mid: MID_ARG,
      name: { type: 'string', description: 'prop name' },
      value: { description: 'JSON value; null removes the prop' },
      baseVersion: BASE_VERSION_ARG,
      force: FORCE_ARG,
    }, ['pageId', 'mid', 'name']),
    produces: ['el.setProp'],
  },
  {
    name: 'insert_element',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: insert a new element under parentMid, before an existing sibling mid or at "end". Give the element as `jsx` (one element) or as a `node` object {tag, props, style, text, children}.',
    inputSchema: obj({
      pageId: PAGE_ARG,
      parentMid: { type: 'string', description: 'mid of the element to insert into' },
      before: { type: 'string', description: 'sibling mid to insert before, or "end" (default)' },
      jsx: { type: 'string', description: 'one JSX element, e.g. <UI.Button label="Save"/>' },
      node: { type: 'object', description: 'element object {tag, props?, style?, text?, children?}' },
      slot: { type: 'string', description: 'JSX-valued prop to insert into (e.g. "actions") instead of children' },
    }, ['pageId', 'parentMid']),
    produces: ['el.insert'],
  },
  {
    name: 'remove_element',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: delete ONE element and its subtree (undoable).',
    inputSchema: obj({ pageId: PAGE_ARG, mid: MID_ARG, baseVersion: BASE_VERSION_ARG }, ['pageId', 'mid']),
    produces: ['el.remove'],
  },
  {
    name: 'move_element',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: move ONE element (with its subtree) under a new parent, before a sibling mid or at "end". Reparenting keeps the element identity, so its pins and comments follow it.',
    inputSchema: obj({
      pageId: PAGE_ARG,
      mid: MID_ARG,
      newParentMid: { type: 'string', description: 'mid of the new parent' },
      before: { type: 'string', description: 'sibling mid to insert before, or "end" (default)' },
      slot: { type: 'string' },
      baseVersion: BASE_VERSION_ARG,
    }, ['pageId', 'mid', 'newParentMid']),
    produces: ['el.move'],
  },
  {
    name: 'replace_element',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: swap ONE element for a different one, in place. Give the replacement as `jsx` (one element) or as a `node` object. '
      + 'Refused when the replacement would change or destroy a ⟂user-set cell anywhere in that subtree — prefer set_text/set_style/set_prop, or name the cells in force.',
    inputSchema: obj({
      pageId: PAGE_ARG,
      mid: MID_ARG,
      jsx: { type: 'string', description: 'one JSX element' },
      node: { type: 'object', description: 'element object {tag, props?, style?, text?, children?}' },
      baseVersion: BASE_VERSION_ARG,
      // The replacement covers a whole SUBTREE, so — as on write_page — a bare
      // cell name could not say which element it meant.
      force: SCOPED_FORCE_ARG,
    }, ['pageId', 'mid']),
    produces: ['el.replace'],
  },

  /* ── writes: artifact ── */
  {
    name: 'set_theme',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: replace the artifact design theme so every artboard restyles coherently. Pass `preset` (see list_theme_presets) or a full `theme` object.',
    inputSchema: obj({ preset: { type: 'string' }, theme: { type: 'object' } }),
    produces: ['theme.set'],
  },
  {
    name: 'set_theme_token',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: change ONE theme token by dotted path, e.g. path "colors.primary". Cheaper and far less destructive than replacing the whole theme for a single colour change.',
    inputSchema: obj({
      path: { type: 'string', description: 'dotted token path, e.g. colors.primary or radii.md' },
      value: { type: 'string' },
      baseVersion: BASE_VERSION_ARG,
    }, ['path', 'value']),
    produces: ['theme.setToken'],
  },
  {
    name: 'set_format',
    access: 'write',
    tier: 'primary',
    description: 'WRITE: switch the artifact-wide artboard format (a catalog id, or custom with width/height). For one artboard only, use set_page_meta.',
    inputSchema: obj({ formatId: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, ['formatId']),
    produces: ['artifact.setFormat'],
  },
  {
    name: 'checkpoint',
    access: 'write',
    tier: 'primary',
    description: 'WRITE (versions): save a named restore point of the whole artifact so the user can compare or roll back. Cheap — take one before any multi-page redesign.',
    inputSchema: obj({ label: { type: 'string', description: 'short label, e.g. "before dark theme"' } }, ['label']),
    produces: [],
  },

  /* ── extras: real capability outside the element-editing core ── */
  {
    name: 'list_assets',
    access: 'read-only',
    tier: 'extra',
    description: 'READ-ONLY (list provenance-tracked media assets in the artifact).',
    inputSchema: obj({}),
    produces: [],
  },
  {
    name: 'add_asset',
    access: 'write',
    tier: 'extra',
    description: 'WRITE: register a provenance-tracked asset record into the artifact.',
    inputSchema: obj({ asset: { type: 'object' } }, ['asset']),
    produces: ['asset.add'],
  },
  {
    name: 'import_design',
    access: 'write',
    tier: 'extra',
    description: 'WRITE: import a design frame as a new artboard. Fetch it from the connected source MCP first (e.g. Figma get_design_data), then pass source:"figma" + the node JSON as payload.',
    inputSchema: obj({ source: { type: 'string', enum: ['figma'] }, payload: { type: 'object' }, actionTitle: { type: 'string' }, index: { type: 'number' } }, ['source', 'payload']),
    produces: ['page.add'],
  },

  /* ── compat: superseded names, still dispatchable, never taught ── */
  {
    name: 'read_page',
    access: 'read-only',
    tier: 'compat',
    description: 'READ-ONLY (superseded by get_page_jsx): read one artboard in full; returns its current version.',
    inputSchema: obj({ pageId: PAGE_ARG }, ['pageId']),
    produces: [],
  },
  {
    name: 'scaffold_page',
    access: 'write',
    tier: 'compat',
    description: 'WRITE (superseded by add_page with `scaffold`): insert an artboard seeded from a scaffold id.',
    inputSchema: obj({ scaffold: { type: 'string' }, actionTitle: { type: 'string' }, index: { type: 'number' } }, ['scaffold']),
    produces: ['page.add'],
  },
  {
    name: 'apply_theme_preset',
    access: 'write',
    tier: 'compat',
    description: 'WRITE (superseded by set_theme with `preset`): set the artifact theme to a curated preset.',
    inputSchema: obj({ preset: { type: 'string' } }, ['preset']),
    produces: ['theme.set'],
  },
  {
    name: 'insert_page',
    access: 'write',
    tier: 'compat',
    description: 'WRITE (superseded by add_page): insert an artboard from a raw page payload.',
    inputSchema: obj({ page: { type: 'object' }, index: { type: 'number' } }, ['page']),
    produces: ['page.add'],
  },
  {
    name: 'edit_page',
    access: 'write',
    tier: 'compat',
    description: 'WRITE (superseded by set_page_meta / write_page): patch fields of an existing artboard.',
    inputSchema: obj({ pageId: PAGE_ARG, patch: { type: 'object' }, baseVersion: BASE_VERSION_ARG }, ['pageId', 'patch']),
    produces: ['page.setMeta'],
  },
  {
    name: 'write_page_jsx',
    access: 'write',
    tier: 'compat',
    nativeExcluded: true,
    description: 'WRITE (superseded by write_page, and identical to it): set an artboard\'s JSX. Creates the artboard when pageId is omitted.',
    // The SAME schema object — identical dispatcher, identical contract.
    inputSchema: WRITE_PAGE_SCHEMA,
    produces: ['page.add', 'page.setDoc', 'el.setText', 'el.setStyle', 'el.setProp', 'el.insert', 'el.remove', 'el.move', 'el.replace'],
  },
  {
    name: 'delete_page',
    access: 'write',
    tier: 'compat',
    description: 'WRITE (superseded by remove_page): delete an artboard.',
    inputSchema: obj({ pageId: PAGE_ARG, baseVersion: BASE_VERSION_ARG }, ['pageId']),
    produces: ['page.remove'],
  },
  {
    name: 'edit_element',
    access: 'write',
    tier: 'compat',
    description: 'WRITE (superseded by set_text / set_style / set_prop): change ONE cell of ONE element. Pass exactly one of text, style or prop.',
    inputSchema: obj({
      pageId: PAGE_ARG,
      mid: MID_ARG,
      text: { type: 'string' },
      style: { type: 'object' },
      prop: { type: 'object' },
      baseVersion: BASE_VERSION_ARG,
    }, ['pageId', 'mid']),
    produces: ['el.setText', 'el.setStyle', 'el.setProp'],
  },
] as const;

const SPEC_BY_NAME: ReadonlyMap<string, CanvasToolSpec> =
  new Map(CANVAS_TOOL_SURFACE.map(t => [t.name, t]));

export function canvasToolSpec(name: string): CanvasToolSpec | undefined {
  return SPEC_BY_NAME.get(name);
}

/** Tools taught in the prompt and offered as native `canvas_*` schemas. */
export function offeredCanvasTools(): CanvasToolSpec[] {
  return CANVAS_TOOL_SURFACE.filter(t => t.tier !== 'compat');
}

/** Names by access, for the permission registration in `src/utils/toolNames.ts`. */
export const CANVAS_SURFACE_READ_NAMES: readonly string[] =
  CANVAS_TOOL_SURFACE.filter(t => t.access === 'read-only').map(t => t.name);
export const CANVAS_SURFACE_WRITE_NAMES: readonly string[] =
  CANVAS_TOOL_SURFACE.filter(t => t.access === 'write').map(t => t.name);

/* ─────────────────────── the algebra ⇄ surface index ─────────────────── */

/**
 * Every op variant → the tools that can produce it.
 *
 * Seeded as a `Record<CanvasOpKindV2, string[]>` LITERAL so a new variant in
 * `CanvasOps.ts` fails `tsc` here until it is given a producer, then filled by
 * inverting {@link CanvasToolSpec.produces} so the two can never disagree.
 */
function buildProducerIndex(): Record<CanvasOpKindV2, string[]> {
  const index: Record<CanvasOpKindV2, string[]> = {
    'page.add': [],
    'page.remove': [],
    'page.duplicate': [],
    'page.setMeta': [],
    'page.move': [],
    'page.reorder': [],
    'page.setDoc': [],
    'el.setText': [],
    'el.setStyle': [],
    'el.setProp': [],
    'el.insert': [],
    'el.remove': [],
    'el.move': [],
    'el.replace': [],
    'theme.set': [],
    'theme.setToken': [],
    'artifact.setFormat': [],
    'asset.add': [],
  };
  for (const tool of CANVAS_TOOL_SURFACE) {
    for (const kind of tool.produces) { index[kind].push(tool.name); }
  }
  return index;
}

export const CANVAS_OP_PRODUCERS: Readonly<Record<CanvasOpKindV2, readonly string[]>> =
  Object.freeze(buildProducerIndex());

/**
 * The legacy `CanvasOpKind` a V2 op reports as on the pre-Plan-22 event and
 * result surfaces (`CanvasToolResult.op`, `CanvasJobEvent`).
 *
 * This mirrors `CanvasOpExecutor`'s own private `legacyKindFor`. The
 * duplication is deliberate and *tested*: `tests/canvas/canvasToolSurface.test.ts`
 * submits one op of every variant and asserts the executor's emitted legacy
 * kind equals this table, so a drift is a red test rather than a silent
 * mislabelled card in the canvas.
 */
export const LEGACY_KIND_FOR_OP: Readonly<Record<CanvasOpKindV2, CanvasOpKind>> = Object.freeze({
  'page.add': 'insert_page',
  'page.duplicate': 'insert_page',
  'page.remove': 'delete_page',
  'page.reorder': 'reorder',
  'theme.set': 'set_theme',
  'theme.setToken': 'set_theme',
  'artifact.setFormat': 'set_format',
  'asset.add': 'add_asset',
  'page.setMeta': 'edit_page',
  'page.move': 'edit_page',
  'page.setDoc': 'edit_page',
  'el.setText': 'edit_element',
  'el.setStyle': 'edit_element',
  'el.setProp': 'edit_element',
  'el.insert': 'edit_element',
  'el.remove': 'edit_element',
  'el.move': 'edit_element',
  'el.replace': 'edit_element',
} as const);

/* ──────────────────────────── UI gesture index ───────────────────────── */

export interface CanvasUiGesture {
  /** What the human does. */
  gesture: string;
  /** The webview module that constructs the op. */
  module: string;
  /**
   * `shipped` — a `{ op: '<kind>' }` literal exists in that module today and the
   * conformance test asserts it. `pending` — the gesture is Phase 3 board work
   * that has not landed; the test does NOT assert it (asserting its absence
   * would break the moment it lands) and the gap is reported instead.
   */
  status: 'shipped' | 'pending';
}

/**
 * Plan 22 §2.3 — "the set of ops the agent can perform is exactly the set the
 * UI performs". Typed `Record<CanvasOpKindV2, …>` so a new variant must declare
 * its human gesture, even if only to declare it pending.
 */
export const CANVAS_UI_GESTURES: Readonly<Record<CanvasOpKindV2, CanvasUiGesture>> = Object.freeze({
  'page.add': { gesture: 'rail “+ artboard”', module: 'src/webview/canvas/rail.ts', status: 'shipped' },
  'page.remove': { gesture: 'rail delete', module: 'src/webview/canvas/rail.ts', status: 'shipped' },
  'page.duplicate': { gesture: 'rail duplicate', module: 'src/webview/canvas/rail.ts', status: 'shipped' },
  'page.setMeta': { gesture: 'device picker scoped to the artboard', module: 'src/webview/canvas/state.ts', status: 'shipped' },
  'page.reorder': { gesture: 'rail drag-reorder', module: 'src/webview/canvas/rail.ts', status: 'shipped' },
  'el.setText': { gesture: 'inline text edit / inspector text field', module: 'src/webview/canvas/textEdit.ts', status: 'shipped' },
  'el.setStyle': { gesture: 'inspector style control / arrow-nudge', module: 'src/webview/canvas/controls.ts', status: 'shipped' },
  'el.setProp': { gesture: 'inspector prop control', module: 'src/webview/canvas/controls.ts', status: 'shipped' },
  'theme.set': { gesture: 'theme picker', module: 'src/webview/canvas/state.ts', status: 'shipped' },
  'page.move': { gesture: 'drag an artboard on the board', module: 'src/webview/canvas/board.ts', status: 'pending' },
  'page.setDoc': { gesture: 'paste-replace an artboard', module: 'src/webview/canvas/board.ts', status: 'pending' },
  'el.insert': { gesture: 'drop a primitive from the palette', module: 'src/webview/canvas/board.ts', status: 'pending' },
  'el.remove': { gesture: 'select + Delete', module: 'src/webview/canvas/board.ts', status: 'pending' },
  'el.move': { gesture: 'drag an element to a new parent', module: 'src/webview/canvas/board.ts', status: 'pending' },
  'el.replace': { gesture: 'swap primitive from the inspector', module: 'src/webview/canvas/inspector.ts', status: 'pending' },
  'theme.setToken': { gesture: 'token swatch edit', module: 'src/webview/canvas/inspector.ts', status: 'pending' },
  'artifact.setFormat': { gesture: 'artifact-wide device picker', module: 'src/webview/canvas/state.ts', status: 'pending' },
  'asset.add': { gesture: 'drop an image onto an artboard', module: 'src/webview/canvas/board.ts', status: 'pending' },
} as const);

/* ────────────────────────── prompt examples ──────────────────────────── */

/**
 * A worked example the system prompt shows the model.
 *
 * Machine-readable on purpose: the conformance test renders the prompt, pulls
 * these back OUT of the rendered text with the same regex a reader's eye would
 * use, and drives each one through the real parser → directive → dispatcher.
 * An example that does not round-trip fails the build.
 */
export interface CanvasPromptExample {
  /** `canvas` = `<canvas:NONCE tool="…">{json}</canvas>`; `canvaspage` = whole artboard. */
  encoding: 'canvas' | 'canvaspage';
  tool: string;
  args: Record<string, unknown>;
  /** One-line reason the example exists. Rendered as a trailing comment. */
  note: string;
}

/** A syntactically valid mid (`[a-z2-7]{10}`) for the examples. */
const EXAMPLE_MID = 'k7f2xq6b3m';

export const CANVAS_PROMPT_EXAMPLES: readonly CanvasPromptExample[] = Object.freeze([
  {
    encoding: 'canvas',
    tool: 'get_page_jsx',
    args: { pageId: 'p1' },
    note: 'read first — the reply carries every mid and every ⟂user-set mark',
  },
  {
    encoding: 'canvas',
    tool: 'set_text',
    args: { pageId: 'p1', mid: EXAMPLE_MID, text: 'Get started' },
    note: 'one element, one cell — the smallest edit that can land',
  },
  {
    encoding: 'canvas',
    tool: 'set_style',
    args: { pageId: 'p1', mid: EXAMPLE_MID, style: { background: 'var(--color-primary)' } },
    note: 'theme tokens, not raw hex',
  },
  {
    encoding: 'canvas',
    tool: 'insert_element',
    args: { pageId: 'p1', parentMid: EXAMPLE_MID, before: 'end', jsx: '<UI.Button label="Sign in" variant="primary"/>' },
    note: 'anchor-relative insertion — "end", or the mid to insert before',
  },
  {
    encoding: 'canvas',
    tool: 'add_page',
    args: { scaffold: 'login', actionTitle: 'Sign in' },
    note: 'start a screen from a scaffold rather than from nothing',
  },
  {
    encoding: 'canvaspage',
    tool: 'write_page',
    args: { pageId: 'p1', actionTitle: 'Sign in', jsx: 'function Page() {\n  return <UI.Screen><UI.Heading>Sign in</UI.Heading></UI.Screen>;\n}' },
    note: 'a WHOLE artboard rides this tag, never a tool call — it will not fit in one',
  },
] as const);

/**
 * Plan 22 §3.5 rule 4 — the sentence the model is held to about pins.
 * Exported so the prompt and the conformance test quote the SAME string.
 */
export const CANVAS_PIN_RULE =
  'Cells marked /* ⟂user-set: … */ in get_page_jsx belong to the human. Never overwrite one '
  + 'unless the user\'s message asks for that specific change — and when it does, name the cell '
  + 'in `force` so the override is recorded: on set_text/set_style/set_prop the cell alone '
  + '(force: ["style.background"]), and on write_page / replace_element the element too '
  + '(force: ["k7f2xq6b3m:style.background"]), because a bare cell name on a write that covers '
  + 'more than one element would overwrite that cell on EVERY one of them. An unforced write to a '
  + 'user-set cell is refused and reported back to you as `pinned`, and write_page reports every '
  + 'cell it had to drop.';
