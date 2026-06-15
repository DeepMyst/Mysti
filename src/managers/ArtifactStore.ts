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

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DesignSpecManager } from './DesignSpecManager';
import { getDefaultFormat, getDefaultFormatForKind } from './CanvasFormats';
import type {
  CanvasArtifact,
  ArtifactPage,
  CanvasOp,
  CanvasAssetRecord,
  CanvasFormatSpec,
  DesignTheme,
} from '../types';

/**
 * Default deck format. Sourced from the {@link CanvasFormats} catalog; kept as a
 * named export for back-compat with earlier Phase 1 importers.
 */
export const DEFAULT_CANVAS_FORMAT: CanvasFormatSpec = getDefaultFormat();

/** Lightweight listing entry (avoids loading every artifact's pages). */
export interface ArtifactSummary {
  id: string;
  name: string;
  kind: CanvasArtifact['kind'];
  pageCount: number;
  updatedAt: number;
}

export interface ArtifactStoreOptions {
  /**
   * Resolves the workspace root that hosts `.mysti/canvas/`. Defaults to the
   * first workspace folder. Injectable so unit tests can target a temp dir
   * without mocking `vscode.workspace.fs`.
   */
  getRoot?: () => string | null;
}

/**
 * The persisted source of truth for canvas artifacts (Plan 05). Owns CRUD for
 * `.mysti/canvas/<artifactId>/artifact.json` plus the per-artifact
 * content-addressed `assets/` dir, and provides the pure data-mutation
 * primitives (page/theme/format/asset/op-log) that `CanvasOpExecutor` drives.
 *
 * Structural mutations bump the affected page's `version` and the artifact's
 * `version` so agent base-version checks and op-log undo stay coherent.
 */
export class ArtifactStore {
  private _getRoot: () => string | null;
  private _designSpec = new DesignSpecManager();

  constructor(opts: ArtifactStoreOptions = {}) {
    this._getRoot = opts.getRoot ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null);
  }

  // ========================================================================
  // Creation
  // ========================================================================

  createArtifact(opts: {
    name: string;
    kind?: CanvasArtifact['kind'];
    format?: CanvasFormatSpec;
    theme?: DesignTheme;
  }): CanvasArtifact {
    const now = Date.now();
    const kind = opts.kind ?? 'deck';
    return {
      id: crypto.randomUUID(),
      version: 1,
      kind,
      name: opts.name,
      // Default format follows the kind (screens → desktop, document → A4, …).
      format: opts.format ?? getDefaultFormatForKind(kind),
      theme: opts.theme ?? DesignSpecManager.getDefaultTheme(),
      pages: [],
      assets: [],
      opLog: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  // ========================================================================
  // Persistence (atomic write tmp+rename)
  // ========================================================================

  /** Absolute dir for an artifact, or null when no workspace is open. */
  artifactDir(artifactId: string): string | null {
    const root = this._getRoot();
    if (!root) { return null; }
    return path.join(root, '.mysti', 'canvas', artifactId);
  }

  async save(artifact: CanvasArtifact): Promise<void> {
    const dir = this.artifactDir(artifact.id);
    if (!dir) { return; }
    artifact.updatedAt = Date.now();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'artifact.json');
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(artifact, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  async load(artifactId: string): Promise<CanvasArtifact | null> {
    const dir = this.artifactDir(artifactId);
    if (!dir) { return null; }
    try {
      const raw = await fs.readFile(path.join(dir, 'artifact.json'), 'utf-8');
      return JSON.parse(raw) as CanvasArtifact;
    } catch {
      return null;
    }
  }

  async list(): Promise<ArtifactSummary[]> {
    const root = this._getRoot();
    if (!root) { return []; }
    const canvasDir = path.join(root, '.mysti', 'canvas');
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(canvasDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries: ArtifactSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const artifact = await this.load(entry.name);
      if (artifact) {
        summaries.push({
          id: artifact.id,
          name: artifact.name,
          kind: artifact.kind,
          pageCount: artifact.pages.length,
          updatedAt: artifact.updatedAt,
        });
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(artifactId: string): Promise<void> {
    const dir = this.artifactDir(artifactId);
    if (!dir) { return; }
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.log('[Mysti] ArtifactStore: delete failed:', err);
    }
  }

  // ========================================================================
  // Page primitives — bump page + artifact versions on mutation
  // ========================================================================

  getPage(artifact: CanvasArtifact, pageId: string): ArtifactPage | undefined {
    return artifact.pages.find(p => p.id === pageId);
  }

  /** Build a fresh page (version 1, generated id when absent). */
  makePage(partial: Partial<ArtifactPage> & Pick<ArtifactPage, 'mode'>): ArtifactPage {
    return {
      id: partial.id ?? crypto.randomUUID(),
      version: 1,
      mode: partial.mode,
      htmlSource: partial.htmlSource,
      jsxSource: partial.jsxSource,
      nodes: partial.nodes,
      actionTitle: partial.actionTitle,
      notes: partial.notes,
      source: partial.source,
      elementOverrides: partial.elementOverrides,
      droppedAssets: partial.droppedAssets,
      stitchRef: partial.stitchRef,
      previewAsset: partial.previewAsset,
    };
  }

  /** Insert a page (optionally at `index`); bumps artifact version. */
  insertPage(artifact: CanvasArtifact, page: ArtifactPage, index?: number): ArtifactPage {
    if (typeof index === 'number' && index >= 0 && index <= artifact.pages.length) {
      artifact.pages.splice(index, 0, page);
    } else {
      artifact.pages.push(page);
    }
    this._touch(artifact);
    return page;
  }

  /**
   * Apply a partial patch to a page's content fields. Bumps the page version
   * and artifact version. Returns the updated page, or undefined if not found.
   */
  updatePage(artifact: CanvasArtifact, pageId: string, patch: Partial<ArtifactPage>): ArtifactPage | undefined {
    const page = this.getPage(artifact, pageId);
    if (!page) { return undefined; }
    // Never let a patch overwrite identity / version bookkeeping.
    const safe: Partial<ArtifactPage> = { ...patch };
    delete safe.id;
    delete safe.version;
    Object.assign(page, safe);
    page.version += 1;
    this._touch(artifact);
    return page;
  }

  deletePage(artifact: CanvasArtifact, pageId: string): ArtifactPage | undefined {
    const idx = artifact.pages.findIndex(p => p.id === pageId);
    if (idx === -1) { return undefined; }
    const [removed] = artifact.pages.splice(idx, 1);
    this._touch(artifact);
    return removed;
  }

  /** Reorder pages to match `orderedIds`; missing ids are appended in place. */
  reorderPages(artifact: CanvasArtifact, orderedIds: string[]): void {
    const byId = new Map(artifact.pages.map(p => [p.id, p]));
    const next: ArtifactPage[] = [];
    for (const id of orderedIds) {
      const p = byId.get(id);
      if (p) { next.push(p); byId.delete(id); }
    }
    // Append any pages not named in orderedIds, preserving their relative order.
    for (const p of artifact.pages) {
      if (byId.has(p.id)) { next.push(p); }
    }
    artifact.pages = next;
    this._touch(artifact);
  }

  // ========================================================================
  // Theme / format
  // ========================================================================

  setTheme(artifact: CanvasArtifact, theme: DesignTheme): void {
    artifact.theme = theme;
    this._touch(artifact);
  }

  setFormat(artifact: CanvasArtifact, format: CanvasFormatSpec): void {
    artifact.format = format;
    this._touch(artifact);
  }

  // ========================================================================
  // Op log
  // ========================================================================

  appendOp(artifact: CanvasArtifact, op: CanvasOp): void {
    artifact.opLog.push(op);
    artifact.updatedAt = Date.now();
  }

  findOp(artifact: CanvasArtifact, opId: string): CanvasOp | undefined {
    return artifact.opLog.find(o => o.opId === opId);
  }

  // ========================================================================
  // Asset registry — per-artifact content-addressed store
  // ========================================================================

  /**
   * Write raw bytes into the artifact's `assets/` dir (content-addressed,
   * deduped by sha-256) and register a {@link CanvasAssetRecord}. Returns the
   * record whose `ref` is an `asset://<artifactId>/assets/<hash>.<ext>` token.
   */
  async addAsset(
    artifact: CanvasArtifact,
    base64: string,
    mimeType: string,
    meta: Omit<CanvasAssetRecord, 'id' | 'ref' | 'ts'>
  ): Promise<CanvasAssetRecord | null> {
    const dir = this.artifactDir(artifact.id);
    if (!dir) { return null; }
    const assetsDir = path.join(dir, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });

    const buffer = Buffer.from(base64, 'base64');
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    const ext = ArtifactStore._extForMime(mimeType);
    const fileName = `${hash}.${ext}`;
    const filePath = path.join(assetsDir, fileName);
    try {
      await fs.access(filePath); // dedup: already written
    } catch {
      await fs.writeFile(filePath, buffer);
    }

    const record: CanvasAssetRecord = {
      id: crypto.randomUUID(),
      ref: `asset://${artifact.id}/assets/${fileName}`,
      ts: Date.now(),
      ...meta,
    };
    artifact.assets.push(record);
    this._touch(artifact);
    return record;
  }

  getAsset(artifact: CanvasArtifact, assetId: string): CanvasAssetRecord | undefined {
    return artifact.assets.find(a => a.id === assetId);
  }

  /** Resolve an `asset://<artifactId>/assets/<file>` ref to an absolute path. */
  resolveAssetPath(ref: string): string | null {
    const m = ref.match(/^asset:\/\/([^/]+)\/assets\/(.+)$/);
    if (!m) { return null; }
    const dir = this.artifactDir(m[1]);
    if (!dir) { return null; }
    return path.join(dir, 'assets', m[2]);
  }

  // ========================================================================
  // Private
  // ========================================================================

  private _touch(artifact: CanvasArtifact): void {
    artifact.version += 1;
    artifact.updatedAt = Date.now();
  }

  private static _extForMime(mimeType: string): string {
    if (mimeType.includes('png')) { return 'png'; }
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) { return 'jpg'; }
    if (mimeType.includes('svg')) { return 'svg'; }
    if (mimeType.includes('webp')) { return 'webp'; }
    if (mimeType.includes('mp4')) { return 'mp4'; }
    if (mimeType.includes('webm')) { return 'webm'; }
    return 'bin';
  }
}
