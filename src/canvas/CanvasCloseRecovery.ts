/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ARTIFACT_SCHEMA_VERSION, ArtifactStore } from '../managers/ArtifactStore';
import type { CanvasArtifact } from '../types';

const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

const RECOVERY_DIR = 'canvas-recovery';
const RESTORED_DIR = 'restored';
/** Top-level key of a recovery copy; stripped before the copy is validated. */
const META_KEY = 'mystiRecovery';

/** The on-disk design a recovery copy would replace: `null` absent, `'unknown'` unreadable. */
type RecoveryBase = { version: number; updatedAt: number } | null | 'unknown';

interface RecoveryMeta {
  /** Resolved root of the workspace whose store failed to save. */
  workspace: string;
  base: RecoveryBase;
  retainedAt: number;
}

export interface CanvasRecoveryCopy {
  file: string;
  artifactId: string;
  name: string;
  retainedAt: number;
}

export type CanvasRecoveryOutcome =
  | { ok: true; mode: 'in-place' | 'new'; artifactId: string; name: string; retireError?: string }
  | { ok: false; reason: 'invalid' | 'foreign' | 'declined' | 'failed'; detail: string };

/** Workspace identity: resolved root path, case-insensitive where the filesystem is. */
export function sameWorkspace(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isBase(value: unknown): value is RecoveryBase {
  if (value === null || value === 'unknown') { return true; }
  const v = value as { version?: unknown; updatedAt?: unknown } | undefined;
  return typeof v === 'object' && typeof v.version === 'number' && typeof v.updatedAt === 'number';
}

function readMeta(value: unknown): RecoveryMeta | null {
  const meta = (value as Record<string, unknown> | null)?.[META_KEY] as Partial<RecoveryMeta> | undefined;
  if (!meta || typeof meta.workspace !== 'string' || typeof meta.retainedAt !== 'number' || !isBase(meta.base)) {
    return null;
  }
  return meta as RecoveryMeta;
}

/**
 * A closing Canvas could not save its design and the view's in-memory copy is
 * going away. Write a never-overwriting recovery copy, in `artifact.json`
 * format, outside the workspace (whose save just failed). Returns the truthful
 * user-facing outcome: where the copy is, or that the edits were lost.
 *
 * The design is serialized before the first await, so the copy is exactly the
 * state close failed to persist. The copy also records which workspace it
 * belongs to and the on-disk design it would replace, which is what lets
 * {@link restoreCanvasRecoveryCopy} refuse to overwrite anything newer. It is
 * never restored automatically.
 */
export async function retainUnsavedCanvasDesign(
  storageDir: string | undefined, store: ArtifactStore, artifact: CanvasArtifact, cause: unknown, now = Date.now(),
): Promise<string> {
  const name = artifact.name || 'Untitled design';
  const reason = cause === undefined ? 'unknown error' : detail(cause);
  try {
    const copy = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    if (!storageDir) { throw new Error('no extension storage is available'); }
    // Without a workspace the copy is still kept, but only for manual recovery.
    const workspace = store.workspaceRoot();
    if (workspace) {
      let base: RecoveryBase;
      try {
        const disk = await store.load(artifact.id);
        base = disk ? { version: disk.version, updatedAt: disk.updatedAt } : null;
      } catch { base = 'unknown'; }
      copy[META_KEY] = { workspace, base, retainedAt: now } satisfies RecoveryMeta;
    }
    const serialized = JSON.stringify({ ...copy, schemaVersion: ARTIFACT_SCHEMA_VERSION }, null, 2);
    const dir = path.join(storageDir, RECOVERY_DIR);
    const file = path.join(dir, `${String(artifact.id).replace(/[^A-Za-z0-9_-]/g, '_')}-${now}.json`);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, serialized, { encoding: 'utf8', flag: 'wx' });
    return `Mysti Canvas could not save "${name}" when it closed (${reason}). `
      + `Your unsaved changes were kept in a recovery copy: ${file}. `
      + 'Run "Mysti: Restore Canvas Recovery Copy" to restore it.';
  } catch (error) {
    return `Mysti Canvas could not save "${name}" when it closed (${reason}), `
      + `and a recovery copy could not be written (${detail(error)}). Its unsaved changes were lost.`;
  }
}

/**
 * Recovery copies written for THIS store's workspace, newest first. Copies from
 * other workspaces, unparseable files and copies written before workspace
 * identity was recorded are never offered: nothing proves they belong here.
 */
export async function listCanvasRecoveryCopies(
  storageDir: string | undefined, store: ArtifactStore,
): Promise<CanvasRecoveryCopy[]> {
  const workspace = store.workspaceRoot();
  if (!storageDir || !workspace) { return []; }
  const dir = path.join(storageDir, RECOVERY_DIR);
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const copies: CanvasRecoveryCopy[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
    const file = path.join(dir, entry.name);
    try {
      const value = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
      const meta = readMeta(value);
      if (!meta || !sameWorkspace(meta.workspace, workspace)) { continue; }
      copies.push({ file, artifactId: String(value.id), name: String(value.name || 'Untitled design'), retainedAt: meta.retainedAt });
    } catch { /* unreadable: not attributable to this workspace */ }
  }
  return copies.sort((a, b) => b.retainedAt - a.retainedAt);
}

/** Copy the old design's content-addressed assets and point every ref at the new id. */
async function asNewDesign(store: ArtifactStore, artifact: CanvasArtifact, now: number): Promise<CanvasArtifact> {
  const id = crypto.randomUUID();
  const from = store.artifactDir(artifact.id);
  const to = store.artifactDir(id);
  if (!from || !to) { throw new Error('no workspace is open'); }
  let assets: string[] = [];
  try {
    // Skip in-flight media temps (`.media-*.tmp`); only finished content-addressed files move.
    assets = (await fs.promises.readdir(path.join(from, 'assets'), { withFileTypes: true }))
      .filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name);
  } catch { /* deleted with its design */ }
  if (assets.length) { await fs.promises.mkdir(path.join(to, 'assets'), { recursive: true }); }
  for (const asset of assets) {
    await fs.promises.copyFile(path.join(from, 'assets', asset), path.join(to, 'assets', asset), fs.constants.COPYFILE_EXCL);
  }
  const moved = JSON.parse(JSON.stringify(artifact).split(`asset://${artifact.id}/`).join(`asset://${id}/`)) as CanvasArtifact;
  return { ...moved, id, name: `${artifact.name || 'Untitled design'} (recovered)`, createdAt: now };
}

/**
 * Restore one recovery copy, always as an explicit user action.
 *
 * - The copy must name this store's workspace and pass the store's own load
 *   validation/migration; otherwise it is rejected and left in place.
 * - In place only when the design on disk is still exactly the one the copy was
 *   made over (i.e. this completes the save that failed) AND it is not open in
 *   a live view, whose in-memory copy would otherwise overwrite the restore.
 *   The compare-and-write runs in the store's mutation queue.
 * - Anything newer, unreadable, or open: restored as a NEW design.
 * - Deleted since the copy was made: `confirmResurrect` decides; yes restores
 *   it as a new design.
 * - Success moves the copy to `restored/`; failure leaves it where it is.
 */
export async function restoreCanvasRecoveryCopy(
  file: string, store: ArtifactStore,
  opts: { isOpen(artifactId: string): boolean; confirmResurrect(name: string): Promise<boolean>; now?: number },
): Promise<CanvasRecoveryOutcome> {
  let value: Record<string, unknown>;
  try { value = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>; }
  catch (error) { return { ok: false, reason: 'invalid', detail: detail(error) }; }
  const meta = readMeta(value);
  const workspace = store.workspaceRoot();
  if (!meta || !workspace || !sameWorkspace(meta.workspace, workspace)) {
    return { ok: false, reason: 'foreign', detail: 'the recovery copy does not belong to this workspace' };
  }
  delete value[META_KEY];
  const validated = ArtifactStore.validateArtifact(value);
  if (!validated.ok) { return { ok: false, reason: 'invalid', detail: validated.detail }; }
  const artifact = validated.artifact;
  if (!store.artifactDir(artifact.id)) { return { ok: false, reason: 'invalid', detail: 'the design identifier is not valid' }; }
  const now = opts.now ?? Date.now();

  try {
    let disk: CanvasArtifact | null | undefined;
    try { disk = await store.load(artifact.id); } catch { disk = undefined; }
    let restored: CanvasArtifact | null = null;
    if (disk === null && meta.base !== null) {
      if (!await opts.confirmResurrect(artifact.name || 'Untitled design')) {
        return { ok: false, reason: 'declined', detail: 'the recovery copy was left in place' };
      }
    } else if (meta.base !== 'unknown' && !opts.isOpen(artifact.id)
      && (disk === null || (disk && meta.base && disk.version === meta.base.version && disk.updatedAt === meta.base.updatedAt))
      && await store.replaceIfUnchanged(artifact, meta.base)) {
      restored = artifact;
    }
    const mode = restored ? 'in-place' : 'new';
    if (!restored) {
      const fresh = restored = await asNewDesign(store, artifact, now);
      await store.save(fresh).catch(async error => {
        await fs.promises.rm(store.artifactDir(fresh.id)!, { recursive: true, force: true }).catch(() => {});
        throw error;
      });
    }
    let retireError: string | undefined;
    try {
      const retired = path.join(path.dirname(file), RESTORED_DIR);
      await fs.promises.mkdir(retired, { recursive: true });
      await fs.promises.rename(file, path.join(retired, path.basename(file)));
    } catch (error) { retireError = detail(error); }
    return { ok: true, mode, artifactId: restored.id, name: restored.name, ...(retireError ? { retireError } : {}) };
  } catch (error) {
    return { ok: false, reason: 'failed', detail: detail(error) };
  }
}

/** The command: pick a copy for this workspace, restore it, say exactly what happened. */
export async function promptCanvasRecoveryRestore(
  storageDir: string | undefined, store: ArtifactStore, isOpen: (artifactId: string) => boolean,
): Promise<CanvasRecoveryOutcome | undefined> {
  const copies = await listCanvasRecoveryCopies(storageDir, store);
  if (!copies.length) {
    void vscode.window.showInformationMessage('Mysti Canvas has no recovery copies for this workspace.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(copies.map(copy => ({
    label: copy.name, description: `kept ${new Date(copy.retainedAt).toLocaleString()}`, detail: copy.file, copy,
  })), { title: 'Restore a Canvas recovery copy', placeHolder: 'Unsaved Canvas edits kept when a save failed' });
  if (!picked) { return undefined; }
  const outcome = await restoreCanvasRecoveryCopy(picked.copy.file, store, {
    isOpen,
    confirmResurrect: async name => await vscode.window.showWarningMessage(
      `The design "${name}" was deleted after this recovery copy was made. Restore it as a new design? `
      + 'Images stored only with the deleted design cannot be recovered.',
      { modal: true }, 'Restore as new design',
    ) === 'Restore as new design',
  });
  if (outcome.ok) {
    const where = outcome.mode === 'in-place' ? 'restored' : `restored as a new design "${outcome.name}"`;
    const retired = outcome.retireError
      ? ` The recovery copy could not be moved aside (${outcome.retireError}) and is still at ${picked.copy.file}.`
      : '';
    void vscode.window.showInformationMessage(`Mysti Canvas ${where} "${picked.copy.name}".${retired}`);
  } else if (outcome.reason !== 'declined') {
    void vscode.window.showWarningMessage(
      `Mysti Canvas could not restore "${picked.copy.name}" (${outcome.detail}). The recovery copy is unchanged at ${picked.copy.file}.`,
    );
  }
  return outcome;
}

/** On Canvas open: mention recovery copies for this workspace. Restoring stays a click away, never automatic. */
export async function offerCanvasRecovery(
  storageDir: string | undefined, store: ArtifactStore, restore: () => Promise<unknown>,
): Promise<void> {
  const copies = await listCanvasRecoveryCopies(storageDir, store);
  if (!copies.length) { return; }
  const choice = await vscode.window.showInformationMessage(
    copies.length === 1
      ? `Mysti Canvas kept unsaved edits to "${copies[0].name}" when a save failed.`
      : `Mysti Canvas kept unsaved edits to ${copies.length} designs when saves failed.`,
    'Restore…',
  );
  if (choice === 'Restore…') { await restore(); }
}
