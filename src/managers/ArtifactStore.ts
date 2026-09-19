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
import {
  boardPosForIndex,
  migrateArtifactPages,
  migratePage,
  refreshJsxCache,
  type LegacyPageFields,
  type MigrationReport,
} from '../canvas/pageMigration';
import type { DocNode } from '../canvas/doc/DocNode';
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

/**
 * Schema version stamped into every persisted `artifact.json` (Plan 20 §3.1).
 * A file carrying a HIGHER version was written by a newer Mysti: it is refused
 * loudly rather than half-read, because a silent partial read of a design the
 * user can still see on disk is the worst possible outcome.
 *
 * A file carrying NO `schemaVersion` predates Plan 20 Phase 0 and is accepted
 * as version 1 — the shape is unchanged, only the stamp is new.
 */
export const ARTIFACT_SCHEMA_VERSION = 1;

const ARTIFACT_FILE = 'artifact.json';
/** Previous known-good `artifact.json`, refreshed before every overwrite. */
const ARTIFACT_BACKUP_FILE = 'artifact.json.bak';
/** Where a corrupt primary is parked when a backup is promoted over it. */
const ARTIFACT_CORRUPT_FILE = 'artifact.json.corrupt';
/** Workspace-level listing cache (never a source of truth — see {@link ArtifactStore.list}). */
const INDEX_FILE = 'index.json';
const ASSETS_DIR = 'assets';

const ARTIFACT_KINDS: ReadonlyArray<CanvasArtifact['kind']> = ['deck', 'document', 'screens', 'board'];

/** Disambiguates concurrent atomic writes inside one extension host process. */
let _tmpCounter = 0;

/** Lightweight listing entry (avoids loading every artifact's pages). */
export interface ArtifactSummary {
  id: string;
  name: string;
  kind: CanvasArtifact['kind'];
  pageCount: number;
  updatedAt: number;
  /**
   * Set when the artifact exists on disk but could not be parsed. Such a row is
   * still listed — a corrupt design must never silently vanish from the picker
   * (the user would "create a new one" on top of a design that still exists).
   * Its `name`/`pageCount` come from the last known-good index row when there
   * is one, so the entry stays recognisable.
   */
  corrupt?: boolean;
}

// ==========================================================================
// Load failures — absent vs corrupt
// ==========================================================================

/** Why an `artifact.json` (or its `.bak`) could not be turned into an artifact. */
export type ArtifactLoadProblem =
  /** Present but unreadable (EACCES/EISDIR/…), or absent when a backup proves otherwise. */
  | 'unreadable'
  /** Present but not valid JSON. */
  | 'unparseable'
  /** Parses, but is not a `CanvasArtifact` (missing id, pages not an array, …). */
  | 'invalid-shape'
  /** Written by a newer Mysti than this one understands. */
  | 'schema-too-new';

/** What is (or is not) recoverable from the `.bak` next to a corrupt artifact. */
export interface ArtifactBackupReport {
  /** Absolute path of the `.bak` file. */
  path: string;
  /** True when the backup itself parses and validates. */
  valid: boolean;
  /** The parsed backup — only when {@link valid}. */
  artifact: CanvasArtifact | null;
  /** The backup's `updatedAt`, so a caller can say "restore the copy from 14:02". */
  savedAt: number | null;
  /** Why the backup is unusable, when it is not valid. */
  problem: ArtifactLoadProblem | null;
}

/**
 * Thrown by {@link ArtifactStore.load} when an artifact EXISTS on disk but
 * cannot be read back.
 *
 * The distinction matters: before Plan 20 Phase 0 a malformed `artifact.json`
 * degraded to `null`, indistinguishable from "no such design", so the caller
 * cheerfully created a brand-new empty design and the debounced autosave then
 * overwrote the user's real work. Absent still yields `null`; corrupt throws
 * this, carrying the path and the backup report so the caller can offer
 * "open the file / restore the backup / start fresh" instead of guessing.
 */
export class ArtifactCorruptError extends Error {
  readonly artifactId: string;
  readonly filePath: string;
  readonly problem: ArtifactLoadProblem;
  readonly detail: string;
  readonly backup: ArtifactBackupReport | null;

  constructor(init: {
    artifactId: string;
    filePath: string;
    problem: ArtifactLoadProblem;
    detail: string;
    backup?: ArtifactBackupReport | null;
    cause?: unknown;
  }) {
    super(
      `[Mysti] ArtifactStore: design "${init.artifactId}" failed to load (${init.problem}): ${init.detail}`,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'ArtifactCorruptError';
    this.artifactId = init.artifactId;
    this.filePath = init.filePath;
    this.problem = init.problem;
    this.detail = init.detail;
    this.backup = init.backup ?? null;
  }

  /** True when a valid `.bak` sits next to the corrupt file. */
  get restorable(): boolean {
    return this.backup?.valid === true;
  }

  /** Name-based guard so a cross-bundle instance still classifies correctly. */
  static is(err: unknown): err is ArtifactCorruptError {
    if (err instanceof ArtifactCorruptError) { return true; }
    return typeof err === 'object' && err !== null
      && (err as { name?: unknown }).name === 'ArtifactCorruptError';
  }
}

// ==========================================================================
// Validation — a parse is not a read
// ==========================================================================

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ValidationResult =
  | { ok: true; artifact: CanvasArtifact }
  | { ok: false; problem: 'invalid-shape' | 'schema-too-new'; detail: string };

function invalid(detail: string): ValidationResult {
  return { ok: false, problem: 'invalid-shape', detail };
}

/**
 * Validate a parsed `artifact.json` against the {@link CanvasArtifact} contract.
 *
 * Deliberately structural rather than exhaustive: everything a consumer indexes
 * blindly (`id`, `pages[].id`, `pages[].mode`, `format.width`, `theme.colors`)
 * is checked, while forward-compatible extras are preserved untouched — the
 * `schemaVersion` gate is what protects against genuinely new shapes, so this
 * function must never strip fields it does not recognise.
 */
function validatePersistedArtifact(value: unknown): ValidationResult {
  if (!isRecord(value)) { return invalid('top level is not a JSON object'); }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== undefined) {
    if (!isFiniteNumber(schemaVersion) || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      return invalid(`schemaVersion is not a positive integer (${JSON.stringify(schemaVersion)})`);
    }
    if (schemaVersion > ARTIFACT_SCHEMA_VERSION) {
      return {
        ok: false,
        problem: 'schema-too-new',
        detail: `written by a newer Mysti (schemaVersion ${schemaVersion} > ${ARTIFACT_SCHEMA_VERSION})`,
      };
    }
  }

  if (!isNonEmptyString(value.id)) { return invalid('missing or empty "id"'); }
  if (typeof value.name !== 'string') { return invalid('"name" is not a string'); }
  if (!ARTIFACT_KINDS.includes(value.kind as CanvasArtifact['kind'])) {
    return invalid(`unknown "kind" ${JSON.stringify(value.kind)}`);
  }
  if (!isFiniteNumber(value.version)) { return invalid('"version" is not a number'); }
  if (!isFiniteNumber(value.createdAt)) { return invalid('"createdAt" is not a number'); }
  if (!isFiniteNumber(value.updatedAt)) { return invalid('"updatedAt" is not a number'); }

  const format = value.format;
  if (!isRecord(format)) { return invalid('missing "format"'); }
  if (!isNonEmptyString(format.formatId)) { return invalid('"format.formatId" is missing'); }
  if (!isFiniteNumber(format.width) || !isFiniteNumber(format.height)) {
    return invalid('"format.width"/"format.height" are not numbers');
  }

  const theme = value.theme;
  if (!isRecord(theme) || !isRecord(theme.colors)) { return invalid('missing "theme.colors"'); }

  if (!Array.isArray(value.pages)) { return invalid('"pages" is not an array'); }
  const seenPageIds = new Set<string>();
  for (let i = 0; i < value.pages.length; i++) {
    const page: unknown = value.pages[i];
    if (!isRecord(page)) { return invalid(`pages[${i}] is not an object`); }
    if (!isNonEmptyString(page.id)) { return invalid(`pages[${i}] has no "id"`); }
    if (seenPageIds.has(page.id)) { return invalid(`duplicate page id "${page.id}" at pages[${i}]`); }
    seenPageIds.add(page.id);
    if (!isFiniteNumber(page.version)) { return invalid(`pages[${i}].version is not a number`); }
    // Content shape is checked loosely on purpose: a page written by ANY Mysti
    // at this schema version — document-first (`doc`) or pre-Phase-2
    // (`mode`+source) — must load, because `pageMigration` upgrades it right
    // after this returns. What must still be rejected is a page carrying
    // neither, or carrying a source field of the wrong type, since that means
    // the file is corrupt rather than merely old.
    if (page.doc !== undefined && !isRecord(page.doc)) {
      return invalid(`pages[${i}].doc is not an object`);
    }
    if (page.htmlSource !== undefined && typeof page.htmlSource !== 'string') {
      return invalid(`pages[${i}].htmlSource is not a string`);
    }
    if (page.jsxSource !== undefined && typeof page.jsxSource !== 'string') {
      return invalid(`pages[${i}].jsxSource is not a string`);
    }
    if (page.doc === undefined && page.htmlSource === undefined && page.jsxSource === undefined
      && page.legacy === undefined && !Array.isArray(page.nodes)) {
      return invalid(`pages[${i}] has no document and no legacy source`);
    }
  }

  // Collections that a caller pushes into: present-but-wrong is corruption,
  // absent is an older/hand-edited file we can safely normalise.
  if (value.assets === undefined) { value.assets = []; }
  else if (!Array.isArray(value.assets)) { return invalid('"assets" is not an array'); }
  if (value.opLog === undefined) { value.opLog = []; }
  else if (!Array.isArray(value.opLog)) { return invalid('"opLog" is not an array'); }

  // The stamp is persistence metadata, not part of the in-memory artifact:
  // strip it so the next save always re-stamps the CURRENT version.
  delete value.schemaVersion;
  return { ok: true, artifact: value as unknown as CanvasArtifact };
}

// ==========================================================================
// Listing index (cache)
// ==========================================================================

/** One `index.json` row: a summary plus the stat fingerprint that validates it. */
interface ArtifactIndexEntry extends ArtifactSummary {
  mtimeMs: number;
  size: number;
}

function summaryOf(artifact: CanvasArtifact): ArtifactSummary {
  return {
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    pageCount: artifact.pages.length,
    updatedAt: artifact.updatedAt,
  };
}

function summaryOfEntry(entry: ArtifactIndexEntry): ArtifactSummary {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    pageCount: entry.pageCount,
    updatedAt: entry.updatedAt,
  };
}

function isIndexEntry(value: unknown): value is ArtifactIndexEntry {
  if (!isRecord(value)) { return false; }
  return isNonEmptyString(value.id)
    && typeof value.name === 'string'
    && ARTIFACT_KINDS.includes(value.kind as CanvasArtifact['kind'])
    && isFiniteNumber(value.pageCount)
    && isFiniteNumber(value.updatedAt)
    && isFiniteNumber(value.mtimeMs)
    && isFiniteNumber(value.size);
}

/**
 * What a caller may hand {@link ArtifactStore.makePage}.
 *
 * The document-first fields plus the pre-Phase-2 wire fields, which are
 * ACCEPTED but never STORED: `makePage` normalizes them through
 * `pageMigration.migratePage`, so `{ mode: 'jsx', jsxSource }` from an MCP tool
 * call and a page read back from an old `artifact.json` take the identical
 * compile path.
 */
export type PageInit = Partial<ArtifactPage> & LegacyPageFields;

/** What {@link ArtifactStore.updatePage} accepts — same deal, minus identity. */
export type PagePatch = Partial<ArtifactPage> & LegacyPageFields;

export interface ArtifactStoreOptions {
  /**
   * Resolves the workspace root that hosts `.mysti/canvas/`. Defaults to the
   * first workspace folder. Injectable so unit tests can target a temp dir
   * without mocking `vscode.workspace.fs`.
   */
  getRoot?: () => string | null;
}

/**
 * The persisted source of truth for canvas artifacts (Plan 05, hardened in
 * Plan 20 Phase 0). Owns CRUD for `.mysti/canvas/<artifactId>/artifact.json`
 * plus the per-artifact content-addressed `assets/` dir, and provides the pure
 * data-mutation primitives (page/theme/format/asset/op-log) that
 * `CanvasOpExecutor` drives.
 *
 * Structural mutations bump the affected page's `version` and the artifact's
 * `version` so agent base-version checks and op-log undo stay coherent.
 *
 * Durability contract:
 * - every write is tmp+rename (atomic within a filesystem);
 * - the previous known-good `artifact.json` is kept as `artifact.json.bak`;
 * - `load()` distinguishes absent (`null`) from corrupt ({@link ArtifactCorruptError});
 * - `index.json` is a listing CACHE, rebuilt from disk whenever it disagrees.
 */
export class ArtifactStore {
  // A new view constructs a new store while the previous view may still be
  // saving. Share in-process mutation ordering, keyed by the absolute artifact
  // file; independent workspaces/designs retain independent write queues.
  private static readonly _pendingWrites = new Map<string, Promise<unknown>>();
  private _getRoot: () => string | null;
  private _designSpec = new DesignSpecManager();
  /**
   * Serializes read-modify-write cycles on `index.json` within this instance.
   * Other instances/processes can race this cache; {@link list} rebuilds rows
   * from the authoritative artifact files when the cache disagrees.
   */
  private _indexOps: Promise<void> = Promise.resolve();

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
    // App & website design is the primary use; a new artifact defaults to
    // `screens` (→ desktop frame) unless a caller asks for deck/document/board.
    const kind = opts.kind ?? 'screens';
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

  /**
   * Absolute dir for an artifact, or null when no workspace is open OR the id
   * is not usable as a single path segment. Artifact ids reach this method from
   * JSON on disk and from tool payloads, so the containment check lives here —
   * one guard, shared by {@link load}, {@link save} and {@link resolveAssetPath}.
   */
  artifactDir(artifactId: string): string | null {
    if (!ArtifactStore._isSafeArtifactId(artifactId)) { return null; }
    const canvasDir = this._canvasDir();
    if (!canvasDir) { return null; }
    return path.join(canvasDir, artifactId);
  }

  /**
   * Resolves only after persistence; unavailable destinations are failures.
   * A live session can supply its mutation revision so the entire dirty flush
   * occupies one queue slot. Readers/delete/restore must not pass between its
   * revisions. The getter must be synchronous and have no side effects.
   */
  async save(artifact: CanvasArtifact, currentRevision?: () => number): Promise<void> {
    const dir = this.artifactDir(artifact.id);
    if (!dir) {
      throw new Error(ArtifactStore._isSafeArtifactId(artifact.id)
        ? 'Open a workspace folder before saving Canvas designs.'
        : 'Cannot save a Canvas design with an invalid identifier.');
    }
    const filePath = path.join(dir, ARTIFACT_FILE);
    // `schemaVersion` first for human readability, re-assigned afterwards so a
    // stale stamp riding on the in-memory object can never win. Capture bytes
    // and summary NOW: a queued write must not borrow a later mutation of the
    // live artifact while waiting for the previous store instance to finish.
    const capture = () => {
      artifact.updatedAt = Date.now();
      const revision = currentRevision?.();
      const payload: JsonRecord = { schemaVersion: ARTIFACT_SCHEMA_VERSION, ...artifact };
      payload.schemaVersion = ARTIFACT_SCHEMA_VERSION;
      return { revision, serialized: JSON.stringify(payload, null, 2), summary: summaryOf(artifact) };
    };
    let snapshot = capture();
    return ArtifactStore._queueArtifactWrite(filePath, async () => {
      await fs.mkdir(dir, { recursive: true });
      for (;;) {
        // Back up the previous completed write, not a competing writer's old head.
        await this._refreshBackup(dir, filePath);
        await ArtifactStore._writeFileAtomic(filePath, snapshot.serialized);
        await this._updateIndexEntry(snapshot.summary, filePath);
        if (!currentRevision || snapshot.revision === currentRevision()) { return; }
        snapshot = capture();
      }
    });
  }

  private static _queueArtifactWrite<T>(filePath: string, write: () => Promise<T>): Promise<T> {
    const key = path.resolve(filePath);
    const previous = this._pendingWrites.get(key) ?? Promise.resolve();
    const next = previous.catch(() => { /* a failed mutation cannot poison a retry */ }).then(write);
    const tracked = next.finally(() => {
      if (this._pendingWrites.get(key) === tracked) { this._pendingWrites.delete(key); }
    });
    // Registration is synchronous, before the first filesystem operation.
    this._pendingWrites.set(key, tracked);
    return tracked;
  }

  private static async _waitForWrites(matches: (filePath: string) => boolean): Promise<void> {
    for (;;) {
      const pending = [...this._pendingWrites].filter(([filePath]) => matches(filePath)).map(([, writing]) => writing);
      if (!pending.length) { return; }
      await Promise.allSettled(pending);
      // Include a replacement mutation queued while the earlier one was pending.
      // Failure means read the last good disk state, not a permanently stuck queue.
    }
  }

  /**
   * Read an artifact back.
   *
   * @returns the artifact, or `null` when it genuinely does not exist.
   * @throws {@link ArtifactCorruptError} when the artifact EXISTS but cannot be
   * read back (bad JSON, wrong shape, newer schema, unreadable file, or a
   * missing primary with a still-valid `.bak`). Callers must not treat this as
   * "no design" — that is how a real design gets replaced by an empty one.
   */
  async load(artifactId: string): Promise<CanvasArtifact | null> {
    const dir = this.artifactDir(artifactId);
    if (!dir) { return null; }
    const filePath = path.join(dir, ARTIFACT_FILE);
    await ArtifactStore._waitForWrites(file => file === path.resolve(filePath));
    const res = await this._readAndValidate(filePath);
    if (res.ok) { return res.artifact; }

    const backup = await this._readBackup(dir);
    if (res.missing) {
      // Absent primary is the ordinary "no such design" case — unless a valid
      // backup proves the design does exist and only lost its head file.
      if (!backup?.valid) { return null; }
      throw new ArtifactCorruptError({
        artifactId, filePath, problem: 'unreadable',
        detail: 'artifact.json is missing but a valid backup is present',
        backup,
      });
    }
    throw new ArtifactCorruptError({
      artifactId, filePath, problem: res.problem, detail: res.detail, backup, cause: res.cause,
    });
  }

  /**
   * Promote `artifact.json.bak` over a corrupt primary — the "restore backup"
   * branch of the corruption modal. Never called implicitly: swapping files
   * under a user who has not chosen to is exactly the silent behaviour this
   * whole path exists to remove.
   *
   * The corrupt primary is parked as `artifact.json.corrupt` (not deleted) so
   * it can still be inspected or hand-repaired.
   *
   * @returns the restored artifact, or `null` when there is no usable backup.
   */
  async restoreFromBackup(artifactId: string): Promise<CanvasArtifact | null> {
    const dir = this.artifactDir(artifactId);
    if (!dir) { return null; }
    const filePath = path.join(dir, ARTIFACT_FILE);
    return ArtifactStore._queueArtifactWrite(filePath, async () => {
      // Use private validation inside this queue: public load/list wait on the
      // pending mutation, which would make this operation wait on itself.
      const bakPath = path.join(dir, ARTIFACT_BACKUP_FILE);
      const res = await this._readAndValidate(bakPath);
      if (!res.ok) {
        console.log(`[Mysti] ArtifactStore: no usable backup for ${artifactId} (${res.problem})`);
        return null;
      }
      try {
        // Preserve the primary before replacement; a failed recovery copy must
        // leave it untouched. Repeated restores retain earlier recovery copies.
        try {
          await fs.copyFile(filePath, path.join(dir, ARTIFACT_CORRUPT_FILE), fsSync.constants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
          await fs.copyFile(filePath, path.join(dir, `${ARTIFACT_CORRUPT_FILE}.${crypto.randomUUID()}`), fsSync.constants.COPYFILE_EXCL);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        // A missing primary needs no recovery copy.
      }
      await ArtifactStore._writeFileAtomic(filePath, res.raw);
      await this._updateIndexEntry(summaryOf(res.artifact), filePath);
      console.log(`[Mysti] ArtifactStore: restored ${artifactId} from backup`);
      return res.artifact;
    });
  }

  /**
   * Saved designs, newest first.
   *
   * `index.json` makes this O(readdir + stat) instead of parsing every design's
   * page sources, but it is a CACHE and is treated as one: the directory
   * listing is always authoritative, every row is re-validated against the
   * file's `(mtime, size)` fingerprint, unknown directories are parsed and
   * folded in, and vanished ones are dropped. A stale or hand-deleted index can
   * therefore never hide a real artifact — at worst it costs one extra parse.
   *
   * An artifact that fails to load is reported with `corrupt: true` rather than
   * omitted, for the same reason.
   */
  async list(): Promise<ArtifactSummary[]> {
    const canvasDir = this._canvasDir();
    if (!canvasDir) { return []; }
    // The closing view's first save may not have created its directory yet.
    // Wait before listing so reopening cannot mistake that design for absence.
    await ArtifactStore._waitForWrites(file => path.dirname(path.dirname(file)) === path.resolve(canvasDir));
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(canvasDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const cachedIndex = await this._readIndex();
    const nextIndex = new Map<string, ArtifactIndexEntry>();
    const summaries: ArtifactSummary[] = [];
    let rebuilt = false;

    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const dirName = entry.name;
      const filePath = path.join(canvasDir, dirName, ARTIFACT_FILE);
      let stat: fsSync.Stats | null = null;
      try {
        stat = await fs.stat(filePath);
      } catch {
        stat = null;   // no head file — either not a design, or corrupt (below)
      }

      const cached = cachedIndex.get(dirName);
      if (stat && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        nextIndex.set(dirName, cached);
        summaries.push(summaryOfEntry(cached));
        continue;
      }

      rebuilt = true;
      try {
        const artifact = await this.load(dirName);
        if (!artifact) { continue; }
        const summary = summaryOf(artifact);
        if (stat) {
          nextIndex.set(dirName, { ...summary, mtimeMs: stat.mtimeMs, size: stat.size });
        }
        summaries.push(summary);
      } catch (err) {
        // Corrupt: keep it visible, keep whatever we last knew about it, and do
        // NOT fingerprint the corrupt bytes (so a repair is detected as change).
        console.log(`[Mysti] ArtifactStore: ${dirName} is unreadable:`, describe(err));
        if (cached) { nextIndex.set(dirName, cached); }
        summaries.push({
          id: cached?.id ?? dirName,
          name: cached?.name ?? dirName,
          kind: cached?.kind ?? 'screens',
          pageCount: cached?.pageCount ?? 0,
          updatedAt: cached?.updatedAt ?? stat?.mtimeMs ?? 0,
          corrupt: true,
        });
      }
    }

    if (rebuilt || nextIndex.size !== cachedIndex.size) {
      await this._queueIndexOp(() => this._writeIndex(nextIndex));
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(artifactId: string): Promise<void> {
    const dir = this.artifactDir(artifactId);
    if (!dir) { return; }
    return ArtifactStore._queueArtifactWrite(path.join(dir, ARTIFACT_FILE), async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.log('[Mysti] ArtifactStore: delete failed:', err);
      }
      await this._queueIndexOp(async () => {
        try {
          const index = await this._readIndex();
          if (index.delete(artifactId)) { await this._writeIndex(index); }
        } catch (err) {
          console.log('[Mysti] ArtifactStore: index prune failed (non-fatal):', err);
        }
      });
    });
  }

  // ========================================================================
  // Page primitives — bump page + artifact versions on mutation
  // ========================================================================

  getPage(artifact: CanvasArtifact, pageId: string): ArtifactPage | undefined {
    return artifact.pages.find(p => p.id === pageId);
  }

  /**
   * Build a fresh page (version 1, generated id when absent).
   *
   * Accepts BOTH shapes on input: the document-first one and the pre-Phase-2
   * `{ mode, htmlSource | jsxSource | nodes }` one that every existing
   * transport (MCP `insert_page`, the fenced `canvas-op` payload, the Stitch
   * recorder) still speaks on the wire. Whatever arrives, what is STORED is
   * document-first — {@link migratePage} is the single normalizer, so a page
   * born from a tool payload and a page read back from disk go through exactly
   * the same compile → `doc` / `legacy` decision.
   */
  makePage(partial: PageInit = {}): ArtifactPage {
    const { page } = migratePage(
      { ...partial, id: partial.id ?? crypto.randomUUID(), version: 1 },
      { index: 0 },
    );
    page.version = 1;
    return page;
  }

  /** Insert a page (optionally at `index`); bumps artifact version. */
  insertPage(artifact: CanvasArtifact, page: ArtifactPage, index?: number): ArtifactPage {
    if (typeof index === 'number' && index >= 0 && index <= artifact.pages.length) {
      artifact.pages.splice(index, 0, page);
    } else {
      artifact.pages.push(page);
    }
    // A page that never had a board position gets the next free slot rather
    // than stacking on top of the first artboard at (0, 0).
    if (!page.boardPos || (page.boardPos.x === 0 && page.boardPos.y === 0 && artifact.pages.length > 1)) {
      const at = artifact.pages.indexOf(page);
      if (at > 0) { page.boardPos = boardPosForIndex(at); }
    }
    this._touch(artifact);
    return page;
  }

  /**
   * Apply a partial patch to a page's content fields. Bumps the page version
   * and artifact version. Returns the updated page, or undefined if not found.
   *
   * Legacy source fields in the patch (`mode` / `jsxSource` / `htmlSource`) are
   * normalized through {@link migratePage} exactly as they are on insert, so an
   * old-shape `edit_page` payload lands as `doc` + `jsxCache`, never as a
   * second, competing representation of the page's content.
   */
  updatePage(artifact: CanvasArtifact, pageId: string, patch: PagePatch): ArtifactPage | undefined {
    const page = this.getPage(artifact, pageId);
    if (!page) { return undefined; }
    const safe: PagePatch = { ...patch };
    // Never let a patch overwrite identity / version bookkeeping.
    delete safe.id;
    delete (safe as { version?: number }).version;

    const legacy = safe as LegacyPageFields;
    const rewritesContent = legacy.jsxSource !== undefined
      || legacy.htmlSource !== undefined
      || Array.isArray(legacy.nodes)
      || safe.doc !== undefined;
    if (rewritesContent) {
      const { page: normalized } = migratePage(
        { ...legacy, doc: safe.doc, id: page.id, version: page.version, boardPos: page.boardPos },
      );
      page.doc = normalized.doc;
      page.jsxCache = normalized.jsxCache;
      if (normalized.legacy) { page.legacy = normalized.legacy; } else { delete page.legacy; }
      if (normalized.compileError) { page.compileError = normalized.compileError; }
      else { delete page.compileError; }
    }
    const meta = page as unknown as Record<string, unknown>;
    for (const key of ['actionTitle', 'notes', 'source', 'format', 'variantGroupId', 'boardPos'] as const) {
      if (safe[key] !== undefined) { meta[key] = safe[key]; }
    }
    page.version += 1;
    this._touch(artifact);
    return page;
  }

  /**
   * Replace a page's document (Plan 22 §3.2) and refresh its derived JSX.
   *
   * The one write path for `doc`: keeping `jsxCache` beside every mutation is
   * what lets `read_page` stay a pure read instead of re-emitting the whole
   * tree on each agent turn.
   */
  setPageDoc(artifact: CanvasArtifact, pageId: string, doc: DocNode): ArtifactPage | undefined {
    const page = this.getPage(artifact, pageId);
    if (!page) { return undefined; }
    page.doc = doc;
    // A real document supersedes whatever uncompilable source preceded it.
    delete page.legacy;
    delete page.compileError;
    refreshJsxCache(page);
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
   *
   * The destination path is produced by {@link resolveAssetPath}, so the write
   * goes through the same containment guard as every read: a hostile artifact
   * id (from a corrupt file or a tool payload) yields `null`, never a write
   * outside `.mysti/canvas/<id>/assets/`.
   */
  async addAsset(
    artifact: CanvasArtifact,
    base64: string,
    mimeType: string,
    meta: Omit<CanvasAssetRecord, 'id' | 'ref' | 'ts'>
  ): Promise<CanvasAssetRecord | null> {
    const buffer = Buffer.from(base64, 'base64');
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    const ext = ArtifactStore._extForMime(mimeType);
    const ref = `asset://${artifact.id}/${ASSETS_DIR}/${hash}.${ext}`;
    const filePath = this.resolveAssetPath(ref);
    if (!filePath) {
      console.log('[Mysti] ArtifactStore: refusing to write an asset outside the artifact:', ref);
      return null;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.access(filePath); // dedup: already written
    } catch {
      await fs.writeFile(filePath, buffer);
    }

    const record: CanvasAssetRecord = {
      id: crypto.randomUUID(),
      ref,
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

  /**
   * Absolute path of a registered asset, by {@link CanvasAssetRecord.id}.
   * Routes through {@link resolveAssetPath}, so an asset id is never a way to
   * reach a path the ref form could not.
   */
  resolveAssetPathForId(artifact: CanvasArtifact, assetId: string): string | null {
    const record = this.getAsset(artifact, assetId);
    if (!record) { return null; }
    return this.resolveAssetPath(record.ref);
  }

  /**
   * Read the bytes behind an `asset://…` ref. The single safe entry point for
   * consumers that today rebuild asset paths by hand (export bundling, webview
   * rehydration, preview capture) — those must call this instead of joining
   * `assets/` onto a workspace path themselves.
   *
   * @returns the bytes, or `null` when the ref is rejected by the guard or the
   * file does not exist.
   */
  async readAssetBytes(ref: string): Promise<Buffer | null> {
    const filePath = this.resolveAssetPath(ref);
    if (!filePath) { return null; }
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Resolve an `asset://<artifactId>/assets/<file>` ref to an absolute path.
   * Hardened (Plan 18 W4 6.4b): both captured segments are normalized and the
   * result is confined to the artifact's `assets/` dir — refs that escape it
   * (`..` in the id or file segment) return null.
   */
  resolveAssetPath(ref: string): string | null {
    const m = ref.match(/^asset:\/\/([^/]+)\/assets\/(.+)$/);
    if (!m) { return null; }
    // `artifactDir` rejects dot-segments, separators and NUL in the id.
    const dir = this.artifactDir(m[1]);
    if (!dir) { return null; }
    // `path.resolve` happily carries a NUL through; every fs call then throws
    // ERR_INVALID_ARG_VALUE at a caller that expected a path or null.
    if (m[2].includes('\0')) { return null; }
    const assetsDir = path.resolve(dir, ASSETS_DIR);
    const resolved = path.resolve(assetsDir, m[2]);
    if (!resolved.startsWith(assetsDir + path.sep)) { return null; }
    return resolved;
  }

  // ========================================================================
  // Private
  // ========================================================================

  private _touch(artifact: CanvasArtifact): void {
    artifact.version += 1;
    artifact.updatedAt = Date.now();
  }

  /** `<root>/.mysti/canvas`, or null when no workspace is open. */
  private _canvasDir(): string | null {
    const root = this._getRoot();
    if (!root) { return null; }
    return path.join(root, '.mysti', 'canvas');
  }

  /** An artifact id must be usable as exactly one path segment. */
  private static _isSafeArtifactId(artifactId: string): boolean {
    if (typeof artifactId !== 'string' || artifactId.length === 0) { return false; }
    if (artifactId === '.' || artifactId === '..') { return false; }
    if (artifactId.includes('/') || artifactId.includes('\\') || artifactId.includes('\0')) { return false; }
    return path.basename(artifactId) === artifactId;
  }

  /** Write via `tmp` + `rename` so readers never observe a partial file. */
  private static async _writeFileAtomic(filePath: string, data: string): Promise<void> {
    const tmpPath = `${filePath}.${process.pid}.${_tmpCounter++}.tmp`;
    try {
      await fs.writeFile(tmpPath, data, 'utf-8');
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmpPath, filePath);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windows readers/scanners can briefly deny replacement even after
          // our write handle closes. Retry the SAME atomic rename, never
          // unlink the last good destination or fall back to a partial copy.
          // Six attempts wait at most 775 ms; permanent errors still surface.
          if (process.platform !== 'win32' || attempt >= 5
            || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) { throw error; }
          await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
      throw err;
    }
  }

  /**
   * Copy the current `artifact.json` to `artifact.json.bak` — but only when it
   * still parses. Backing up bytes we already know are corrupt would destroy
   * the one good copy left, which is the opposite of the point.
   */
  private async _refreshBackup(dir: string, filePath: string): Promise<void> {
    const res = await this._readAndValidate(filePath);
    if (!res.ok) {
      if (!res.missing) {
        console.log(`[Mysti] ArtifactStore: keeping the older backup — current artifact.json is ${res.problem}`);
      }
      return;
    }
    try {
      await ArtifactStore._writeFileAtomic(path.join(dir, ARTIFACT_BACKUP_FILE), res.raw);
    } catch (err) {
      console.log('[Mysti] ArtifactStore: backup write failed (non-fatal):', err);
    }
  }

  /** Describe the `.bak` beside a corrupt primary, or null when there is none. */
  private async _readBackup(dir: string): Promise<ArtifactBackupReport | null> {
    const bakPath = path.join(dir, ARTIFACT_BACKUP_FILE);
    const res = await this._readAndValidate(bakPath);
    if (!res.ok) {
      if (res.missing) { return null; }
      return { path: bakPath, valid: false, artifact: null, savedAt: null, problem: res.problem };
    }
    return { path: bakPath, valid: true, artifact: res.artifact, savedAt: res.artifact.updatedAt, problem: null };
  }

  /** Read + JSON.parse + shape-validate one artifact file. */
  private async _readAndValidate(filePath: string): Promise<
    | { ok: true; raw: string; artifact: CanvasArtifact; migration: MigrationReport }
    | { ok: false; problem: ArtifactLoadProblem; detail: string; missing: boolean; cause?: unknown }
  > {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      return {
        ok: false,
        problem: 'unreadable',
        detail: missing ? 'file does not exist' : `read failed: ${describe(err)}`,
        missing,
        cause: err,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, problem: 'unparseable', detail: `not valid JSON: ${describe(err)}`, missing: false, cause: err };
    }
    const validated = validatePersistedArtifact(parsed);
    if (!validated.ok) {
      return { ok: false, problem: validated.problem, detail: validated.detail, missing: false };
    }
    // Plan 22 §3.1: upgrade pre-document-model pages the moment they come off
    // disk, so no consumer above this line ever sees two page shapes. It is
    // idempotent, total and non-throwing — a design that already migrated pays
    // only an `isDocNode` walk, and one bad page can never fail the whole load.
    const migration = migrateArtifactPages(validated.artifact);
    return { ok: true, raw, artifact: validated.artifact, migration };
  }

  // ---- listing index ----

  private async _readIndex(): Promise<Map<string, ArtifactIndexEntry>> {
    const result = new Map<string, ArtifactIndexEntry>();
    const canvasDir = this._canvasDir();
    if (!canvasDir) { return result; }
    let raw: string;
    try {
      raw = await fs.readFile(path.join(canvasDir, INDEX_FILE), 'utf-8');
    } catch {
      return result;   // missing index → full rebuild, never an error
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.log('[Mysti] ArtifactStore: index.json is unparseable — rebuilding from disk');
      return result;
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== ARTIFACT_SCHEMA_VERSION || !isRecord(parsed.entries)) {
      return result;
    }
    for (const [dirName, entry] of Object.entries(parsed.entries)) {
      // A row that fails validation is simply dropped: the directory walk will
      // re-derive it, so a mangled index costs a parse, never an artifact.
      if (isIndexEntry(entry)) { result.set(dirName, entry); }
    }
    return result;
  }

  private async _writeIndex(entries: Map<string, ArtifactIndexEntry>): Promise<void> {
    const canvasDir = this._canvasDir();
    if (!canvasDir) { return; }
    try {
      await fs.mkdir(canvasDir, { recursive: true });
      await ArtifactStore._writeFileAtomic(
        path.join(canvasDir, INDEX_FILE),
        JSON.stringify({
          schemaVersion: ARTIFACT_SCHEMA_VERSION,
          updatedAt: Date.now(),
          entries: Object.fromEntries(entries),
        }, null, 2),
      );
    } catch (err) {
      console.log('[Mysti] ArtifactStore: index write failed (non-fatal):', err);
    }
  }

  /** Upsert one row after a save/restore. Best-effort — `list()` self-heals. */
  private async _updateIndexEntry(summary: ArtifactSummary, filePath: string): Promise<void> {
    if (!this._canvasDir()) { return; }
    await this._queueIndexOp(async () => {
      try {
        const stat = await fs.stat(filePath);
        const entries = await this._readIndex();
        entries.set(summary.id, { ...summary, mtimeMs: stat.mtimeMs, size: stat.size });
        await this._writeIndex(entries);
      } catch (err) {
        console.log('[Mysti] ArtifactStore: index update failed (non-fatal):', err);
      }
    });
  }

  /** Run `fn` after every previously queued index op, failures included. */
  private _queueIndexOp(fn: () => Promise<void>): Promise<void> {
    const next = this._indexOps.catch(() => { /* prior failure is not ours */ }).then(fn);
    this._indexOps = next.catch(() => { /* keep the chain alive */ });
    return next;
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
