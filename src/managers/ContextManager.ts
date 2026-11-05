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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ContextItem } from '../types';
import { formatContextReferences } from '../utils/contextReference';
import { contextFileFailure, readContextFileText, type ContextFileFailure } from '../services/ContextFileReader';

/** workspaceState key prefix for a panel's persisted context (Plan 07 A5). */
const CONTEXT_KEY_PREFIX = 'mysti.context:';

/**
 * Panel ids that survive a reload and therefore keep their persisted context:
 * the sidebar view (ChatViewProvider `_sidebarId`) and the no-panel fallback
 * every `panelId?` parameter defaults to. Every other id is minted per open
 * (`panel_<uuid>`, `canvas-<Date.now()>`, …) and is never seen again
 * once its webview is gone, so its key is an orphan.
 */
const STABLE_PANEL_IDS: ReadonlySet<string> = new Set(['sidebar', 'default']);

/**
 * Upper bound on orphan keys deleted per activation. Keeps the sweep O(1)-ish
 * on a store that leaked for months; the remainder goes on the next reload.
 */
export const CONTEXT_SWEEP_LIMIT = 500;

const CONTEXT_FOLDER_FILE_LIMIT = 20;

export interface FolderContextResult {
  items: ContextItem[];
  filesConsidered: number;
  fileLimit: number;
  limitReached: boolean;
  unreadableFiles: string[];
  fileFailures: ContextFileFailure[];
  unreadableFolders: string[];
  scan: {
    directoryLimit: number;
    entryLimit: number;
    directoriesVisited: number;
    entriesRead: number;
    directoryLimitReached: boolean;
    entryLimitReached: boolean;
  };
}

export type ContextSendPreparation = (isCurrent: () => boolean) => Promise<{
  items: ContextItem[];
  failures: ContextFileFailure[];
  changed: boolean;
} | undefined>;

export class ContextManager {
  private _panelContexts: Map<string, ContextItem[]> = new Map();
  private _panelRestores: Map<string, object> = new Map();
  private _autoContext: boolean = true;
  private _extensionContext: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._autoContext = vscode.workspace.getConfiguration('mysti').get('autoContext', true);
    this._sweepOrphanedPersistedContext();
  }

  /**
   * Get the context array for a specific panel, creating if needed
   */
  private _getPanelContext(panelId: string): ContextItem[] {
    let ctx = this._panelContexts.get(panelId);
    if (!ctx) {
      ctx = [];
      this._panelContexts.set(panelId, ctx);
    }
    return ctx;
  }

  public getContext(panelId?: string): ContextItem[] {
    const id = panelId || 'default';
    return [...this._getPanelContext(id)];
  }

  /** Keep an asynchronous picker or batch attached to its original context. */
  public captureContextGuard(panelId?: string): () => boolean {
    const id = panelId || 'default';
    const context = this._getPanelContext(id);
    return () => this._panelContexts.get(id) === context;
  }

  /**
   * Capture the submitted list before preparation waits. Only live, panel-owned
   * file entries are refreshed; supplied task/selection snapshots stay private
   * to the turn. Reads commit together, so a revoked turn cannot partly update
   * the panel or remove files from a successor's context.
   */
  public captureContextForSend(items: ContextItem[], panelId: string): ContextSendPreparation {
    const bucket = this._getPanelContext(panelId);
    const entries = items.map(item => ({
      item: { ...item },
      source: item.type === 'file' ? bucket.find(existing => existing.id === item.id
        && existing.path === item.path && existing.type === 'file') : undefined,
    }));
    return async isCurrent => {
      const current = () => isCurrent() && this._panelContexts.get(panelId) === bucket;
      const refreshed = new Map<ContextItem, { content?: string; failure?: ContextFileFailure }>();
      for (const { item, source } of entries) {
        if (!current()) { return undefined; }
        if (!source || item.enabled === false || refreshed.has(source)) { continue; }
        const result: { content?: string; failure?: ContextFileFailure } = {};
        refreshed.set(source, result);
        if (source.enabled === false) { continue; }
        const canRead = () => current() && source.enabled !== false;
        try {
          result.content = await readContextFileText(source.path, canRead);
        } catch (error) {
          if (canRead()) { result.failure = contextFileFailure(source.path, error); }
        }
      }
      if (!current()) { return undefined; }
      const removed = new Set<ContextItem>();
      const failures: ContextFileFailure[] = [];
      let changed = false;
      const snapshot: ContextItem[] = [];
      for (const { item, source } of entries) {
        if (!source || item.enabled === false) { snapshot.push(item); continue; }
        const result = refreshed.get(source)!;
        if (source.enabled === false || (!result.failure && result.content === undefined)) {
          // A toggle during reading revokes these bytes for this turn, even if
          // the user enables the file again before the remaining reads finish.
          snapshot.push({ ...item, enabled: false });
        } else if (result.failure) {
          if (!removed.has(source)) { failures.push(result.failure); removed.add(source); }
        } else {
          changed ||= source.content !== result.content;
          source.content = result.content!;
          snapshot.push({ ...item, content: result.content! });
        }
      }
      if (removed.size) {
        this._panelContexts.set(panelId, bucket.filter(item => !removed.has(item)));
        changed = true;
      }
      if (changed) { this._persist(panelId); }
      return { items: snapshot, failures, changed };
    };
  }

  public isAutoContextEnabled(): boolean {
    return this._autoContext;
  }

  public setAutoContext(enabled: boolean) {
    this._autoContext = enabled;
  }

  public async addFileToContext(filePath: string, panelId?: string, isCurrent?: () => boolean, onFailure?: (failure: ContextFileFailure) => void): Promise<ContextItem | null> {
    if (isCurrent && !isCurrent()) { return null; }
    const id = panelId || 'default';
    const ctx = this._getPanelContext(id);
    const canRead = () => this._panelContexts.get(id) === ctx && (!isCurrent || isCurrent());
    // Explicit additions supersede a background restore even when this new
    // file's read finishes after the restore's read.
    this._panelRestores.delete(id);

    // Check if file already exists in context
    if (ctx.find((c: ContextItem) => c.path === filePath && c.type === 'file')) {
      return null;
    }

    try {
      const content = await readContextFileText(filePath, canRead);
      // Clear/close replaces or removes this bucket. A caller can additionally
      // revoke the read when its chat navigates while the filesystem is busy.
      if (content === undefined || !canRead()) { return null; }
      if (ctx.some(item => item.path === filePath && item.type === 'file')) { return null; }
      const language = this._getLanguageFromPath(filePath);

      const item: ContextItem = {
        id: this._generateId(),
        type: 'file',
        path: filePath,
        content,
        language,
        enabled: true
      };

      ctx.push(item);
      this._persist(id);
      return item;
    } catch (error) {
      if (canRead()) {
        onFailure?.(contextFileFailure(filePath, error));
        console.error(`Failed to read file: ${filePath}`, error);
      }
      return null;
    }
  }

  public async addSelectionToContext(
    filePath: string,
    content: string,
    startLine: number,
    endLine: number,
    language?: string,
    panelId?: string,
    endCharacter?: number
  ): Promise<ContextItem> {
    const id = panelId || 'default';
    const ctx = this._getPanelContext(id);
    this._panelRestores.delete(id);

    const item: ContextItem = {
      id: this._generateId(),
      type: 'selection',
      path: filePath,
      content,
      startLine,
      endLine,
      ...(endCharacter !== undefined ? { endCharacter } : {}),
      language: language || this._getLanguageFromPath(filePath),
      enabled: true
    };

    ctx.push(item);
    this._persist(id);
    return item;
  }

  public async addFolderToContext(folderPath: string, panelId?: string, isCurrent?: () => boolean): Promise<ContextItem[]> {
    return (await this.addFolderToContextWithReport(folderPath, panelId, isCurrent)).items;
  }

  public async addFolderToContextWithReport(folderPath: string, panelId?: string, isCurrent?: () => boolean): Promise<FolderContextResult> {
    const result: FolderContextResult = {
      items: [], filesConsidered: 0, fileLimit: CONTEXT_FOLDER_FILE_LIMIT, limitReached: false,
      unreadableFiles: [], fileFailures: [], unreadableFolders: [],
      scan: { directoryLimit: 200, entryLimit: 10_000, directoriesVisited: 0, entriesRead: 0,
        directoryLimitReached: false, entryLimitReached: false },
    };
    if (isCurrent && !isCurrent()) { return result; }
    const id = panelId || 'default';
    const ownsContext = this.captureContextGuard(id);
    const canAdd = () => ownsContext() && (!isCurrent || isCurrent());
    // The explicit folder action supersedes restoration before enumeration,
    // just as a file addition does before reading its contents.
    this._panelRestores.delete(id);
    const { files, unreadableFolders } = await this._getFilesInFolder(folderPath, canAdd, result.scan);
    result.filesConsidered = files.length;
    result.limitReached = files.length === CONTEXT_FOLDER_FILE_LIMIT;
    result.unreadableFolders = unreadableFolders;

    for (const file of files) {
      if (!canAdd()) { return { ...result, items: [] }; }
      const item = await this.addFileToContext(file, id, canAdd, failure => result.fileFailures.push(failure));
      if (!canAdd()) { return { ...result, items: [] }; }
      if (item) {
        result.items.push(item);
      } else if (!this._getPanelContext(id).some(existing => existing.type === 'file' && existing.path === file)) {
        result.unreadableFiles.push(file);
      }
    }

    return result;
  }

  public removeFromContext(id: string, panelId?: string) {
    const pid = panelId || 'default';
    this._panelRestores.delete(pid);
    const ctx = this._getPanelContext(pid);
    const filtered = ctx.filter((c: ContextItem) => c.id !== id);
    this._panelContexts.set(pid, filtered);
    this._persist(pid);
  }

  /**
   * Plan 07: activate/deactivate a context item without removing it. A disabled
   * item stays in the list (and panel) but is excluded from the prompt.
   * Returns the new enabled state, or null if the item wasn't found.
   */
  public setItemEnabled(id: string, enabled: boolean, panelId?: string): boolean | null {
    const ctx = this._getPanelContext(panelId || 'default');
    const item = ctx.find((c: ContextItem) => c.id === id);
    if (!item) { return null; }
    item.enabled = enabled;
    this._persist(panelId || 'default');
    return enabled;
  }

  /** Toggle a context item's active state. Returns the new state, or null. */
  public toggleItem(id: string, panelId?: string): boolean | null {
    const pid = panelId || 'default';
    const ctx = this._getPanelContext(pid);
    const item = ctx.find((c: ContextItem) => c.id === id);
    if (!item) { return null; }
    item.enabled = item.enabled === false; // false -> true, true/undefined -> false
    this._persist(pid);
    return item.enabled;
  }

  // ── Persistence (Plan 07 A5) ─────────────────────────────────────────────
  // Per-panel context survives reloads (workspace-scoped). We persist the LIST
  // + enabled flags but re-read file content on restore so it's never stale.
  // (Selections keep their snapshot content — they aren't re-readable by range.)

  private _persistKey(panelId: string): string {
    return `${CONTEXT_KEY_PREFIX}${panelId}`;
  }

  /** Delete a panel's persisted key. Never throws, never leaves a rejection unhandled. */
  private _forgetPersisted(key: string): void {
    try {
      const pending = this._extensionContext.workspaceState.update(key, undefined);
      if (pending && typeof (pending as Thenable<void>).then === 'function') {
        (pending as Thenable<void>).then(undefined, (err) => {
          console.log('[Mysti] context key delete failed:', err);
        });
      }
    } catch (err) {
      console.log('[Mysti] context key delete failed:', err);
    }
  }

  /**
   * Tab panels get a fresh id every time they are opened and `onDidDispose`
   * does not reliably fire on a window reload, so the dispose path alone
   * cannot keep the store clean. On construction, delete (bounded) every
   * context key whose panel id cannot come back. Runs once, never throws.
   */
  private _sweepOrphanedPersistedContext(): void {
    try {
      const ws = this._extensionContext.workspaceState as { keys?: () => readonly string[] };
      if (typeof ws.keys !== 'function') { return; }
      let swept = 0;
      for (const key of ws.keys()) {
        if (!key.startsWith(CONTEXT_KEY_PREFIX)) { continue; }
        if (STABLE_PANEL_IDS.has(key.slice(CONTEXT_KEY_PREFIX.length))) { continue; }
        if (swept >= CONTEXT_SWEEP_LIMIT) { break; }
        this._forgetPersisted(key);
        swept++;
      }
      if (swept > 0) {
        console.log(`[Mysti] context: swept ${swept} orphaned panel context key(s)`);
      }
    } catch (err) {
      console.log('[Mysti] context sweep failed:', err);
    }
  }

  private _persist(panelId: string): void {
    try {
      const items = this._getPanelContext(panelId).map((c) =>
        c.type === 'selection'
          ? c // selections keep their content snapshot
          : { ...c, content: undefined }, // files: drop content, re-read on restore
      );
      // Never let a failed write become an unhandled rejection: the in-memory
      // list stays authoritative and the loss is logged, nothing more.
      const pending = this._extensionContext.workspaceState.update(this._persistKey(panelId), items);
      if (pending && typeof (pending as Thenable<void>).then === 'function') {
        (pending as Thenable<void>).then(undefined, (err) => {
          console.log('[Mysti] context persist failed:', err);
        });
      }
    } catch (err) {
      console.log('[Mysti] context persist failed:', err);
    }
  }

  /**
   * Load a panel's persisted context (if any) and re-read file content. No-op if
   * the panel already has in-memory context (don't clobber a live session).
   * Returns the (possibly empty) restored list.
   */
  public async restorePanelContext(panelId: string, onFailures?: (failures: ContextFileFailure[]) => void): Promise<ContextItem[]> {
    const existing = this._getPanelContext(panelId);
    if (existing.length > 0) { return [...existing]; }

    const owner = {};
    this._panelRestores.set(panelId, owner);
    const isCurrent = () => this._panelRestores.get(panelId) === owner
      && this._panelContexts.get(panelId) === existing && existing.length === 0;
    // Do not create a new bucket when a disposed panel's read finally settles.
    const currentContext = () => [...(this._panelContexts.get(panelId) ?? [])];
    try {
      let saved: ContextItem[] | undefined;
      try {
        saved = this._extensionContext.workspaceState.get<ContextItem[]>(this._persistKey(panelId));
      } catch { saved = undefined; }
      if (!saved || saved.length === 0) { return currentContext(); }

      const restored: ContextItem[] = [];
      const failures: ContextFileFailure[] = [];
      for (const savedItem of saved) {
        if (!isCurrent()) { return currentContext(); }
        const item = { ...savedItem };
        if (item.type === 'file') {
          try {
            const content = await readContextFileText(item.path, isCurrent);
            if (content === undefined || !isCurrent()) { return currentContext(); }
            item.content = content;
            restored.push(item);
          } catch (error) {
            if (!isCurrent()) { return currentContext(); }
            failures.push(contextFileFailure(item.path, error));
          }
        } else {
          restored.push(item); // selections/symbols keep their snapshot
        }
      }
      if (!isCurrent()) { return currentContext(); }
      // Restoration fills this same context, so a pending picker remains valid.
      // Clear/remove/dispose still revoke it by replacing or deleting the bucket.
      existing.push(...restored);
      this._persist(panelId); // re-persist the pruned set
      if (failures.length) { onFailures?.(failures); }
      return [...restored];
    } finally {
      if (this._panelRestores.get(panelId) === owner) { this._panelRestores.delete(panelId); }
    }
  }

  public clearContext(panelId?: string) {
    const id = panelId || 'default';
    this._panelRestores.delete(id);
    this._panelContexts.set(id, []);
    this._persist(id);
  }

  /**
   * Clean up all context for a panel (called on panel dispose)
   */
  public clearPanelContext(panelId: string) {
    this._panelRestores.delete(panelId);
    this._panelContexts.delete(panelId);
    // The panel id is minted per open and never reused, so its persisted key
    // would otherwise outlive the tab forever.
    this._forgetPersisted(this._persistKey(panelId));
  }

  public async refreshContext(panelId?: string, onFailures?: (failures: ContextFileFailure[]) => void) {
    const id = panelId || 'default';
    let ctx = this._getPanelContext(id);
    const isCurrent = () => this._panelContexts.get(id) === ctx;
    const failures: ContextFileFailure[] = [];
    // Refresh content for all enabled file items (skip deactivated ones).
    for (const item of [...ctx]) {
      if (!isCurrent()) { return; }
      if (item.type === 'file' && item.enabled !== false) {
        const canRefreshItem = () => isCurrent() && item.enabled !== false;
        try {
          const content = await readContextFileText(item.path, canRefreshItem);
          if (!isCurrent()) { return; }
          if (content !== undefined && canRefreshItem()) { item.content = content; }
        } catch (error) {
          if (!isCurrent()) { return; }
          if (!canRefreshItem()) { continue; }
          failures.push(contextFileFailure(item.path, error));
          this.removeFromContext(item.id, id);
          // Our own removal replaces this bucket; other removals still cancel.
          ctx = this._panelContexts.get(id)!;
        }
      }
    }
    if (isCurrent()) {
      this._persist(id);
      if (failures.length) { onFailures?.(failures); }
    }
  }

  public formatContextForPrompt(panelId?: string): string {
    const id = panelId || 'default';
    return formatContextReferences(this._getPanelContext(id), 'panel');
  }

  private _generateId(): string {
    return `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private _getLanguageFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.rb': 'ruby',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.cs': 'csharp',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.r': 'r',
      '.sql': 'sql',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.less': 'less',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.xml': 'xml',
      '.md': 'markdown',
      '.sh': 'bash',
      '.bash': 'bash',
      '.zsh': 'bash',
      '.ps1': 'powershell',
      '.dockerfile': 'dockerfile',
      '.vue': 'vue',
      '.svelte': 'svelte'
    };

    return languageMap[ext] || '';
  }

  private async _getFilesInFolder(folderPath: string, isCurrent: () => boolean, scan: FolderContextResult['scan']): Promise<{ files: string[]; unreadableFolders: string[] }> {
    const files: string[] = [];
    const unreadableFolders: string[] = [];
    const ignorePatterns = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'];

    async function walk(dir: string) {
      if (!isCurrent() || files.length >= CONTEXT_FOLDER_FILE_LIMIT) { return; }
      if (scan.directoriesVisited >= scan.directoryLimit) { scan.directoryLimitReached = true; return; }
      if (scan.entriesRead >= scan.entryLimit) { scan.entryLimitReached = true; return; }
      scan.directoriesVisited++;
      const entries: fs.Dirent[] = [];
      try {
        // Bound the native buffer and total retained entries, including sparse
        // trees where the first-20 file cap would never stop enumeration.
        const handle = await fs.promises.opendir(dir, { bufferSize: 32 });
        try {
          while (isCurrent()) {
            if (scan.entriesRead >= scan.entryLimit) { scan.entryLimitReached = true; break; }
            const entry = await handle.read();
            if (!isCurrent()) { return; }
            if (!entry) { break; }
            scan.entriesRead++;
            entries.push(entry);
          }
        } finally {
          // Also closes handles whose open/read completed after cancellation.
          // Close before descending, so recursion holds at most one handle.
          await handle.close();
        }
      } catch (error) {
        if (isCurrent()) {
          unreadableFolders.push(dir);
          console.error(`Failed to read folder: ${dir}`, error);
        }
        // Keep any entries already read and let the parent visit siblings.
      }
      if (!isCurrent()) { return; }

      // Streaming order is filesystem-dependent. Match the UTF-8 filename
      // ordering of the previous bulk listing for complete, bounded listings.
      // When a budget interrupts a listing, only observed entries are available.
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));

      for (const entry of entries) {
        // Preserve the original depth-first first-20 selection, without
        // enumerating the rest of the tree after that prefix is complete.
        if (!isCurrent() || files.length >= CONTEXT_FOLDER_FILE_LIMIT) { return; }
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!ignorePatterns.includes(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    await walk(folderPath);

    return { files, unreadableFolders };
  }
}
