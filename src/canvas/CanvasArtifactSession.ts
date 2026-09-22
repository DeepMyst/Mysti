/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ArtifactStore } from '../managers/ArtifactStore';
import type { CanvasOpExecutor } from '../managers/CanvasOpExecutor';
import type { CanvasArtifact } from '../types';
import type { CanvasHistory } from './CanvasHistory';

export interface CanvasArtifactSnapshot {
  readonly artifact: CanvasArtifact;
  readonly history: CanvasHistory;
}

/** A captured async operation may never follow a selection or reopened view. */
export interface CanvasArtifactMediaScope {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export type CanvasArtifactFailure = 'initial-load' | 'load' | 'render' | 'save' | 'relink' | 'close';

export interface CanvasArtifactSessionPorts {
  createEmpty(name?: string): CanvasArtifact;
  createHistory(artifact: CanvasArtifact, executor: CanvasOpExecutor): CanvasHistory;
  /** Synchronous shell replacement, including the selected design's asset base. */
  render(snapshot: CanvasArtifactSnapshot): void;
  ready(reason: 'initial' | 'selection'): void;
  /** The existing MCP owner revokes the previous bearer before reconnecting. */
  relink(artifactId: string): Promise<void>;
  closeTransport(): Promise<void>;
  /**
   * Close dropped the view's only in-memory copy and its final save failed while
   * edits were unsaved. Copy the design before the first await (nothing may
   * mutate it afterwards) and report where it went, or that it was lost.
   */
  retainUnsaved(artifact: CanvasArtifact, cause: unknown): Promise<void>;
  onError(stage: CanvasArtifactFailure, error: unknown): void;
}

interface SaveState {
  revision: number;
  /** Highest revision known to be on disk. */
  saved: number;
  failure?: unknown;
  pending?: Promise<boolean>;
}

/**
 * One opened view's authoritative design/history and persistence lifecycle.
 * Captured resources never change; a reopened view gets a different owner.
 * The artifact remains mutable through the existing executor/history APIs.
 */
export class CanvasArtifactSession {
  private _snapshot: CanvasArtifactSnapshot | null = null;
  private _generation = 0;
  private _closed = false;
  private _initializing?: Promise<void>;
  private _closing?: Promise<void>;
  private _saveTimer: ReturnType<typeof setTimeout> | undefined;
  private _mediaController = new AbortController();
  private _mediaSelecting = false;
  private readonly _saves = new WeakMap<CanvasArtifact, SaveState>();

  public constructor(
    public readonly store: ArtifactStore,
    public readonly executor: CanvasOpExecutor,
    private readonly _ports: CanvasArtifactSessionPorts,
    private readonly _defaultName?: string,
  ) {}

  public get snapshot(): CanvasArtifactSnapshot | null { return this._snapshot; }
  public get closed(): boolean { return this._closed; }

  public captureMediaScope(): CanvasArtifactMediaScope | null {
    const snapshot = this._snapshot;
    const controller = this._mediaController;
    if (this._closed || this._mediaSelecting || !snapshot) { return null; }
    return Object.freeze({ signal: controller.signal,
      isCurrent: () => !this._closed && !this._mediaSelecting && !controller.signal.aborted
        && this._mediaController === controller && this._snapshot === snapshot });
  }

  /** Most recent saved design, or a new empty design; an explicit choice wins. */
  public initialize(): Promise<void> {
    if (this._closed || this._snapshot) { return Promise.resolve(); }
    this._initializing ??= this._initialize();
    return this._initializing;
  }

  private async _initialize(): Promise<void> {
    let artifact: CanvasArtifact | null = null;
    try {
      const summaries = await this.store.list();
      if (this._closed || this._snapshot) { return; }
      if (summaries.length) { artifact = await this.store.load(summaries[0].id); }
    } catch (error) {
      if (this._closed || this._snapshot) { return; }
      this._report('initial-load', error);
    }
    // A failed explicit choice must not strand a cold-open view with no design.
    // Initial loading may fill an empty view while a selection is pending, but
    // can never replace a design already published by a successful selection.
    if (this._closed || this._snapshot) { return; }
    artifact ??= this._ports.createEmpty(this._defaultName);
    const generation = this._generation;
    this._publish(artifact);
    if (this._owns(generation)) { this._ports.ready('initial'); }
  }

  /** Failed/absent loads leave the current design and its pending save intact. */
  public async select(artifactId: string | null, name?: string): Promise<void> {
    if (this._closed) { return; }
    const generation = ++this._generation;
    // Revoke before loading/flushing. No new media may attach to the outgoing
    // snapshot while a selection is waiting to persist and replace it.
    this._mediaSelecting = true;
    const previousMedia = this._mediaController;
    this._mediaController = new AbortController();
    previousMedia.abort();
    if (!this._owns(generation)) { return; }
    try {
      // The live design can contain unsaved edits. Loading its disk copy before
      // flushing would replace those edits and reset history. A current-design
      // selection also cancels any older pending switch without losing its save.
      if (artifactId && this._snapshot?.artifact.id === artifactId) { return; }
      let next: CanvasArtifact | null;
      try {
        next = artifactId
          ? await this.store.load(artifactId)
          : this._ports.createEmpty(name || this._defaultName);
      } catch (error) {
        if (this._owns(generation)) { this._report('load', error); }
        return;
      }
      if (!next || !this._owns(generation)) { return; }
      this._cancelSaveTimer();
      const outgoing = this._snapshot?.artifact;
      // A save failure keeps the only in-memory copy and its undo history alive.
      // A later edit, selection or close can retry; do not publish its replacement.
      if (outgoing && !await this._flush(outgoing)) { return; }
      if (!this._owns(generation)) { return; }
      this._publish(next);
      // Rendering is non-fatal: it must not skip revocation of the old bearer.
      if (!this._owns(generation)) { return; }
      await this.refreshTransport();
      if (this._owns(generation)) { this._ports.ready('selection'); }
    } finally {
      if (this._owns(generation)) { this._mediaSelecting = false; }
    }
  }

  /** Capability discovery calls this later, using the design selected NOW. */
  public async refreshTransport(): Promise<void> {
    const snapshot = this._snapshot;
    if (this._closed || !snapshot) { return; }
    const generation = this._generation;
    try { await this._ports.relink(snapshot.artifact.id); }
    catch (error) { if (this._owns(generation)) { this._report('relink', error); } }
  }

  /** Every mutation requests persistence of this captured design, never a successor. */
  public scheduleSave(): void {
    const artifact = this._snapshot?.artifact;
    if (this._closed || !artifact) { return; }
    this._saveState(artifact).revision++;
    this._cancelSaveTimer();
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined;
      if (!this._closed && this._snapshot?.artifact === artifact) { void this._flush(artifact); }
    }, 800);
  }

  /** Invalidates synchronously; only the captured outgoing design may finish saving. */
  public close(): Promise<void> {
    if (this._closed) { return this._closing ?? Promise.resolve(); }
    const outgoing = this._snapshot?.artifact;
    this._closed = true;
    ++this._generation;
    this._snapshot = null;
    this._mediaSelecting = true;
    this._mediaController.abort();
    this._cancelSaveTimer();
    let transport: Promise<void>;
    try { transport = this._ports.closeTransport(); }
    catch (error) { this._report('close', error); transport = Promise.resolve(); }
    this._closing = Promise.all([
      transport.catch(error => this._report('close', error)),
      outgoing ? this._flush(outgoing).then(saved => saved ? undefined : this._retain(outgoing)) : Promise.resolve(),
    ]).then(() => {});
    return this._closing;
  }

  private _owns(generation: number): boolean {
    return !this._closed && this._generation === generation;
  }

  private _publish(artifact: CanvasArtifact): void {
    const snapshot = Object.freeze({ artifact, history: this._ports.createHistory(artifact, this.executor) });
    this._snapshot = snapshot;
    try { this._ports.render(snapshot); }
    catch (error) { this._report('render', error); }
  }

  private _cancelSaveTimer(): void {
    if (this._saveTimer !== undefined) { clearTimeout(this._saveTimer); this._saveTimer = undefined; }
  }

  private _saveState(artifact: CanvasArtifact): SaveState {
    let state = this._saves.get(artifact);
    if (!state) { state = { revision: 0, saved: 0 }; this._saves.set(artifact, state); }
    return state;
  }

  private _flush(artifact: CanvasArtifact): Promise<boolean> {
    const state = this._saveState(artifact);
    if (state.pending) { return state.pending; }
    // Coalesce timer/switch/close flushes. The store holds one mutation queue
    // slot across dirty revisions, so readers/delete/restore cannot pass between
    // the first snapshot and a final edit that arrived during its async write.
    let settle!: (saved: boolean) => void;
    const pending = new Promise<boolean>(resolve => { settle = resolve; });
    state.pending = pending;
    // Invoke save before returning from close: a newly opened store must see
    // this pending write before it starts its own initial list/load.
    void (async () => {
      // The store's last revision read is the one its completed write holds.
      let written = state.revision;
      try {
        await this.store.save(artifact, () => (written = state.revision));
        state.saved = Math.max(state.saved, written);
        return true;
      } catch (error) { state.failure = error; this._report('save', error); return false; }
      finally { state.pending = undefined; }
    })().then(settle);
    return pending;
  }

  /** Nothing to recover when every edit already reached disk (or none was made). */
  private async _retain(artifact: CanvasArtifact): Promise<void> {
    const state = this._saveState(artifact);
    if (state.revision <= state.saved) { return; }
    try { await this._ports.retainUnsaved(artifact, state.failure); }
    catch (error) { this._report('close', error); }
  }

  private _report(stage: CanvasArtifactFailure, error: unknown): void {
    try { this._ports.onError(stage, error); } catch { /* diagnostics cannot break teardown */ }
  }
}
