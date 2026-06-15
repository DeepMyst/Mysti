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

import type { ArtifactStore } from './ArtifactStore';
import type { CanvasOpExecutor, CanvasApprovalMode } from './CanvasOpExecutor';
import { computeAnchors, resolveFormat } from './CanvasFormats';
import { validatePage } from './CanvasValidator';
import { getScaffold, listScaffolds } from './CanvasScaffolds';
import type { ScaffoldDevice } from './CanvasScaffolds';
import type { CanvasArtifact, CanvasOp, ArtifactPage } from '../types';

/**
 * The transport-agnostic `mysti-canvas` tool contract (Plan 05 §2 / Phase 2.2).
 * These are the artifact-editing / read tools that must run **in-process**
 * against the local `ArtifactStore` + `CanvasOpExecutor` — the stdio MCP server
 * (Phase 2.2) and the design sub-agent's fenced-op fallback both wrap this
 * dispatch, so the tool surface is defined and tested here once.
 *
 * Generation/render/QA tools (`generate_visual`, `render_page_preview`, …)
 * live in the capability/render layer (Phases 4/6) and are not dispatched here.
 */

export type CanvasToolAccess = 'read-only' | 'write';

export interface CanvasToolDef {
  name: string;
  access: CanvasToolAccess;
  /** Prefixed `READ-ONLY (...)` / `WRITE (stages an edit) ...` per DeepMyst's contract. */
  description: string;
  /** JSON-schema-ish shape the MCP server exposes to the CLI. */
  inputSchema: Record<string, unknown>;
}

export interface CanvasToolContext {
  artifact: CanvasArtifact;
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  /** Job the resulting events are emitted under. */
  jobId: string;
  /** Chat turn / run id that authored these ops. */
  runId: string;
  approvalMode: CanvasApprovalMode;
}

export interface CanvasToolResult {
  ok: boolean;
  /** Payload for READ-ONLY tools. */
  data?: unknown;
  /** Resulting op for WRITE tools (null when the executor rejected it). */
  op?: CanvasOp | null;
  error?: string;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required });

/** The full artifact-editing tool catalog. */
export const CANVAS_TOOLS: readonly CanvasToolDef[] = [
  {
    name: 'list_pages',
    access: 'read-only',
    description: 'READ-ONLY (list the artifact\'s pages with id, mode, version, and title).',
    inputSchema: obj({}),
  },
  {
    name: 'read_page',
    access: 'read-only',
    description: 'READ-ONLY (read one page in full; returns its current version — pass it back as baseVersion when editing).',
    inputSchema: obj({ pageId: { type: 'string' } }, ['pageId']),
  },
  {
    name: 'list_assets',
    access: 'read-only',
    description: 'READ-ONLY (list provenance-tracked media assets in the artifact).',
    inputSchema: obj({}),
  },
  {
    name: 'get_artifact_index',
    access: 'read-only',
    description: 'READ-ONLY (compact one-line-per-page index of the whole artifact for orientation).',
    inputSchema: obj({}),
  },
  {
    name: 'page_coordinates',
    access: 'read-only',
    description: 'READ-ONLY (anchor geometry — center, rule-of-thirds points, safe rect — for the artifact\'s format).',
    inputSchema: obj({}),
  },
  {
    name: 'validate_page',
    access: 'read-only',
    description: 'READ-ONLY (static design checks — empty page, missing actionTitle, raw hex, unresolved asset refs, overflow). The cheap sibling of render_page_preview; run it after every edit.',
    inputSchema: obj({ pageId: { type: 'string' }, reportedContentHeight: { type: 'number' } }, ['pageId']),
  },
  {
    name: 'list_scaffolds',
    access: 'read-only',
    description: 'READ-ONLY (list curated app/web page scaffolds — login, dashboard, mobile-home, settings, landing — optionally filtered by device). Start a screen from one instead of a blank page.',
    inputSchema: obj({ device: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'web'] } }),
  },
  {
    name: 'scaffold_page',
    access: 'write',
    description: 'WRITE (stages an edit): insert a new page seeded from a scaffold id (see list_scaffolds), then refine it.',
    inputSchema: obj({ scaffold: { type: 'string' }, actionTitle: { type: 'string' }, index: { type: 'number' } }, ['scaffold']),
  },
  {
    name: 'insert_page',
    access: 'write',
    description: 'WRITE (stages an edit): insert a new page. Provide page.mode (html|jsx|structured) and its source.',
    inputSchema: obj({ page: { type: 'object' }, index: { type: 'number' } }, ['page']),
  },
  {
    name: 'edit_page',
    access: 'write',
    description: 'WRITE (stages an edit): patch fields of an existing page. Pass baseVersion from read_page to avoid clobbering.',
    inputSchema: obj({ pageId: { type: 'string' }, patch: { type: 'object' }, baseVersion: { type: 'number' } }, ['pageId', 'patch']),
  },
  {
    name: 'write_page_jsx',
    access: 'write',
    description: 'WRITE (stages an edit): set a page\'s JSX (a single function Page() component; no imports). Creates the page when pageId is omitted.',
    inputSchema: obj({ pageId: { type: 'string' }, jsx: { type: 'string' }, actionTitle: { type: 'string' }, baseVersion: { type: 'number' } }, ['jsx']),
  },
  {
    name: 'delete_page',
    access: 'write',
    description: 'WRITE (stages an edit): delete a page (undoable).',
    inputSchema: obj({ pageId: { type: 'string' }, baseVersion: { type: 'number' } }, ['pageId']),
  },
  {
    name: 'reorder_pages',
    access: 'write',
    description: 'WRITE (stages an edit): reorder pages to match the given list of page ids.',
    inputSchema: obj({ orderedIds: { type: 'array', items: { type: 'string' } } }, ['orderedIds']),
  },
  {
    name: 'set_theme',
    access: 'write',
    description: 'WRITE (stages an edit): replace the artifact\'s design theme.',
    inputSchema: obj({ theme: { type: 'object' } }, ['theme']),
  },
  {
    name: 'set_format',
    access: 'write',
    description: 'WRITE (stages an edit): switch the artifact format (catalog id, or custom with width/height).',
    inputSchema: obj({ formatId: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, ['formatId']),
  },
  {
    name: 'edit_element',
    access: 'write',
    description: 'WRITE (stages an edit): set a durable element override (by DOM index path) on a page.',
    inputSchema: obj({ pageId: { type: 'string' }, path: { type: 'string' }, override: { type: 'object' }, baseVersion: { type: 'number' } }, ['pageId', 'path', 'override']),
  },
  {
    name: 'add_asset',
    access: 'write',
    description: 'WRITE (stages an edit): register a provenance-tracked asset record into the artifact.',
    inputSchema: obj({ asset: { type: 'object' } }, ['asset']),
  },
] as const;

const TOOL_BY_NAME = new Map(CANVAS_TOOLS.map(t => [t.name, t]));

export function getCanvasTool(name: string): CanvasToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

/** Compact one-line-per-page index for the system prompt (Plan 05 §2). */
export function buildArtifactIndex(artifact: CanvasArtifact): string {
  const header = `artifact "${artifact.name}" — kind=${artifact.kind} format=${artifact.format.formatId} pages=${artifact.pages.length}`;
  const lines = artifact.pages.map(
    (p, i) => `#${i} id=${p.id} mode=${p.mode} v=${p.version}${p.actionTitle ? ` — ${p.actionTitle}` : ''}`,
  );
  return [header, ...lines].join('\n');
}

type Args = Record<string, unknown>;

/**
 * Execute a tool call against the artifact. READ-ONLY tools read from the store;
 * WRITE tools route through `CanvasOpExecutor.submit` (so validation, staging,
 * versioning, and events are uniform regardless of transport).
 */
export function dispatchCanvasTool(name: string, args: Args, ctx: CanvasToolContext): CanvasToolResult {
  const def = TOOL_BY_NAME.get(name);
  if (!def) { return { ok: false, error: `unknown canvas tool: ${name}` }; }
  const { artifact, store, executor, jobId, runId, approvalMode } = ctx;

  const submit = (kind: Parameters<CanvasOpExecutor['submit']>[1]['kind'], extra: Partial<Parameters<CanvasOpExecutor['submit']>[1]>): CanvasToolResult => {
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

  switch (name) {
    case 'list_pages':
      return {
        ok: true,
        data: artifact.pages.map((p, i) => ({ index: i, id: p.id, mode: p.mode, version: p.version, actionTitle: p.actionTitle })),
      };

    case 'read_page': {
      const page = store.getPage(artifact, String(args.pageId));
      if (!page) { return { ok: false, error: `page ${String(args.pageId)} not found` }; }
      return { ok: true, data: { ...page, baseVersion: page.version } };
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

    case 'scaffold_page': {
      const scaffold = getScaffold(String(args.scaffold));
      if (!scaffold) { return { ok: false, error: `unknown scaffold: ${String(args.scaffold)}` }; }
      const cleaned = cleanJsx(scaffold.jsx);          // scaffolds must be valid JSX pages
      if (!cleaned.ok) { return { ok: false, error: `scaffold ${scaffold.id} is invalid: ${cleaned.error}` }; }
      const page: Partial<ArtifactPage> & { mode: 'jsx'; index?: number } = {
        mode: 'jsx',
        jsxSource: cleaned.source,
        actionTitle: typeof args.actionTitle === 'string' ? args.actionTitle : scaffold.name,
      };
      if (typeof args.index === 'number') { page.index = args.index; }
      return submit('insert_page', { proposedValue: page });
    }

    case 'insert_page': {
      const page = args.page;
      if (!page || typeof page !== 'object' || !(page as ArtifactPage).mode) {
        return { ok: false, error: 'insert_page requires a page object with a mode' };
      }
      const proposed = typeof args.index === 'number' ? { ...(page as object), index: args.index } : page;
      return submit('insert_page', { proposedValue: proposed });
    }

    case 'edit_page':
      if (!args.patch || typeof args.patch !== 'object') {
        return { ok: false, error: 'edit_page requires a patch object' };
      }
      return submit('edit_page', { targetPageId: String(args.pageId), baseVersion: numOrUndef(args.baseVersion), proposedValue: args.patch });

    case 'write_page_jsx': {
      const cleaned = cleanJsx(args.jsx);
      if (!cleaned.ok) { return { ok: false, error: cleaned.error }; }
      const jsxSource = cleaned.source;
      if (args.pageId) {
        const patch: Partial<ArtifactPage> = { mode: 'jsx', jsxSource };
        if (typeof args.actionTitle === 'string') { patch.actionTitle = args.actionTitle; }
        return submit('edit_page', { targetPageId: String(args.pageId), baseVersion: numOrUndef(args.baseVersion), proposedValue: patch });
      }
      const page: Partial<ArtifactPage> & { mode: 'jsx' } = { mode: 'jsx', jsxSource };
      if (typeof args.actionTitle === 'string') { page.actionTitle = args.actionTitle; }
      return submit('insert_page', { proposedValue: page });
    }

    case 'delete_page':
      return submit('delete_page', { targetPageId: String(args.pageId), baseVersion: numOrUndef(args.baseVersion), proposedValue: {} });

    case 'reorder_pages':
      if (!Array.isArray(args.orderedIds)) { return { ok: false, error: 'reorder_pages requires orderedIds: string[]' }; }
      return submit('reorder', { proposedValue: args.orderedIds });

    case 'set_theme':
      if (!args.theme || typeof args.theme !== 'object') { return { ok: false, error: 'set_theme requires a theme object' }; }
      return submit('set_theme', { proposedValue: args.theme });

    case 'set_format': {
      const spec = resolveFormat({ formatId: String(args.formatId), width: numOrUndef(args.width), height: numOrUndef(args.height) });
      return submit('set_format', { proposedValue: spec });
    }

    case 'edit_element': {
      if (typeof args.path !== 'string' || !args.override || typeof args.override !== 'object') {
        return { ok: false, error: 'edit_element requires path: string and override: object' };
      }
      return submit('edit_element', {
        targetPageId: String(args.pageId),
        baseVersion: numOrUndef(args.baseVersion),
        proposedValue: { path: args.path, override: args.override },
      });
    }

    case 'add_asset':
      if (!args.asset || typeof args.asset !== 'object') { return { ok: false, error: 'add_asset requires an asset record' }; }
      return submit('add_asset', { proposedValue: args.asset });

    default:
      return { ok: false, error: `unhandled canvas tool: ${name}` };
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * Validate + normalize an agent-supplied JSX page: strip code fences, require a
 * single `function Page()` component, and reject top-level imports/require (the
 * sandbox preloads React/UI.* — pages must not import).
 */
function cleanJsx(raw: unknown): { ok: true; source: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) { return { ok: false, error: 'write_page_jsx requires non-empty jsx' }; }
  let src = raw.trim();
  // Strip a surrounding ```jsx / ```tsx / ``` fence if present.
  const fence = src.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) { src = fence[1].trim(); }
  if (/^\s*import\s/m.test(src) || /\brequire\s*\(/.test(src)) {
    return { ok: false, error: 'JSX pages must not import/require — React and UI.* are preloaded by the sandbox' };
  }
  if (!/function\s+Page\s*\(/.test(src)) {
    return { ok: false, error: 'JSX page must define a single `function Page()` component' };
  }
  return { ok: true, source: src };
}
