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
import type { ModelEntry } from '../types';
import {
  MODEL_SEEN_MAX_PER_PROVIDER,
  MODEL_ANNOUNCE_MAX_PENDING,
  MODEL_ANNOUNCE_FRESH_WINDOW_MS,
} from '../constants';

/** One model the user has not been told about yet. */
export interface AnnouncedModel {
  providerId: string;
  modelId: string;
  /** Display name at announce time (the picker is the source of truth later). */
  name: string;
  /** Epoch ms the announcement was raised. */
  announcedAt: number;
}

/**
 * Persisted shape under MODEL_ANNOUNCEMENTS_KEY.
 *
 * `seen` is the suppression set: every model id we have ever observed for a
 * provider, whether or not the user acted on it. `pending` is the display set:
 * announcements raised but not yet selected or dismissed. They are separate
 * because they answer different questions — "should this ever be announced
 * again?" (no, once seen) versus "is there a card on screen right now?".
 * Collapsing them into one list would make a dismissed model re-announce on the
 * next refresh.
 */
interface AnnouncementState {
  seen: Record<string, string[]>;
  pending: AnnouncedModel[];
}

export const MODEL_ANNOUNCEMENTS_KEY = 'mysti.modelAnnouncements.v1';

/**
 * ModelAnnouncementService — decides which models are NEW to this user and
 * keeps the resulting notification cards durable across reloads.
 *
 * The rule that makes this safe to run on every refresh is the silent baseline:
 * the FIRST time a provider is reconciled, its entire list is recorded as seen
 * and nothing is announced. Without it, a fresh install (or a provider whose
 * discovery just came online) would fire a card for every model it has ever
 * offered. Only ids that appear AFTER a baseline exists are announcements —
 * which is exactly the two cases worth interrupting the user for: a backend
 * published a new model, or a Mysti upgrade added one to the curated list.
 *
 * The service never selects a model and never writes a provider setting. It
 * reports what is new; acting on it is the user's click.
 */
export class ModelAnnouncementService implements vscode.Disposable {
  private readonly _context: vscode.ExtensionContext;
  private _state: AnnouncementState;

  private readonly _onDidAnnounce = new vscode.EventEmitter<AnnouncedModel[]>();
  /** Fires with the models newly announced by a reconcile (never with an empty array). */
  public readonly onDidAnnounce = this._onDidAnnounce.event;

  private readonly _onDidChangePending = new vscode.EventEmitter<void>();
  /** Fires whenever the pending set changes (announce, select, dismiss). */
  public readonly onDidChangePending = this._onDidChangePending.event;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._state = this._load();
  }

  // ---------------------------------------------------------------------------
  // Reconcile
  // ---------------------------------------------------------------------------

  /**
   * Compare a provider's current model list against what this user has already
   * seen, recording and returning anything new.
   *
   * Returns [] (and records a silent baseline) on the provider's first-ever
   * reconcile. Returns [] for an empty list without recording anything — an
   * empty result means "we do not know this provider's models yet", and
   * baselining on it would announce the real list as brand new the moment it
   * arrives.
   *
   * Persistence is fire-and-forget: the caller is a background refresh and must
   * not be made to await globalState I/O.
   */
  public reconcile(providerId: string, models: ReadonlyArray<Pick<ModelEntry, 'id' | 'name' | 'releasedAt'>>): AnnouncedModel[] {
    if (!providerId || !Array.isArray(models) || models.length === 0) {
      return [];
    }

    // De-dupe defensively: the merged registry view should already be unique by
    // id, but a duplicate here would announce the same model twice.
    const currentIds: string[] = [];
    const currentSeen = new Set<string>();
    for (const m of models) {
      const id = typeof m?.id === 'string' ? m.id : '';
      if (id && !currentSeen.has(id)) {
        currentSeen.add(id);
        currentIds.push(id);
      }
    }
    if (currentIds.length === 0) {
      return [];
    }

    const byId = new Map(models.map(m => [m.id, m] as const));
    const previous = this._state.seen[providerId];

    // Baseline — first sight of this provider. Silent, EXCEPT for models whose
    // releasedAt is inside the freshness window.
    //
    // Without that exception this feature could never announce the release it
    // was built for: the build that introduces announcements is also the build
    // that takes everyone's first baseline, so a model already sitting in the
    // curated list would be absorbed silently for every existing user.
    const isBaseline = !Array.isArray(previous);
    const previousSet = new Set(previous ?? []);

    const fresh = isBaseline
      ? currentIds.filter(id => this._isRecentRelease(byId.get(id)?.releasedAt))
      : currentIds.filter(id => !previousSet.has(id));

    // Always absorb the full current list into `seen`, even the ids that get
    // dropped from `pending` by the cap below. Anything recorded as seen is
    // suppressed forever, which is what stops a large catalog from re-announcing
    // on every single refresh.
    this._state.seen[providerId] = this._capSeen(currentIds, previous ?? []);

    if (fresh.length === 0) {
      void this._persist();
      return [];
    }

    const now = Date.now();
    const announced: AnnouncedModel[] = fresh.map(id => ({
      providerId,
      modelId: id,
      name: byId.get(id)?.name || id,
      announcedAt: now,
    }));

    // Newest first, capped. Existing pending entries for the same (provider,
    // model) are replaced so a repeat never stacks duplicate cards.
    const key = (a: AnnouncedModel) => `${a.providerId}::${a.modelId}`;
    const announcedKeys = new Set(announced.map(key));
    this._state.pending = [
      ...announced,
      ...this._state.pending.filter(p => !announcedKeys.has(key(p))),
    ].slice(0, MODEL_ANNOUNCE_MAX_PENDING);

    void this._persist();
    this._onDidAnnounce.fire(announced);
    this._onDidChangePending.fire();
    return announced;
  }

  // ---------------------------------------------------------------------------
  // Pending set
  // ---------------------------------------------------------------------------

  /** Current announcement cards, newest first. Never throws. */
  public getPending(): AnnouncedModel[] {
    return [...this._state.pending];
  }

  /** Pending announcements for one provider, newest first. */
  public getPendingFor(providerId: string): AnnouncedModel[] {
    return this._state.pending.filter(p => p.providerId === providerId);
  }

  /**
   * Drop one announcement card. The model stays in `seen`, so dismissing is
   * permanent for that id — it will not come back on the next refresh.
   */
  public async dismiss(providerId: string, modelId: string): Promise<void> {
    const before = this._state.pending.length;
    this._state.pending = this._state.pending.filter(
      p => !(p.providerId === providerId && p.modelId === modelId)
    );
    if (this._state.pending.length === before) {
      return;
    }
    await this._persist();
    this._onDidChangePending.fire();
  }

  /** Drop every announcement card (the "dismiss all" affordance). */
  public async dismissAll(): Promise<void> {
    if (this._state.pending.length === 0) {
      return;
    }
    this._state.pending = [];
    await this._persist();
    this._onDidChangePending.fire();
  }

  /**
   * Test/diagnostic seam: whether a provider has a baseline yet. Callers use it
   * to distinguish "nothing new" from "never looked".
   */
  public hasBaseline(providerId: string): boolean {
    return Array.isArray(this._state.seen[providerId]);
  }

  /** Reset everything (used by a full-state reset; not wired to any UI action). */
  public async reset(): Promise<void> {
    this._state = { seen: {}, pending: [] };
    await this._persist();
    this._onDidChangePending.fire();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Bound the seen-set. Current ids are kept in full and take priority; older
   * ids fill whatever room is left. Trimming is what would let a rotated-out id
   * look new again, so the current list is never the part that gets dropped.
   */
  private _capSeen(currentIds: string[], previous: readonly string[] = []): string[] {
    const merged: string[] = [...currentIds];
    const have = new Set(currentIds);
    for (const id of previous) {
      if (merged.length >= MODEL_SEEN_MAX_PER_PROVIDER) {
        break;
      }
      if (!have.has(id)) {
        have.add(id);
        merged.push(id);
      }
    }
    return merged.slice(0, MODEL_SEEN_MAX_PER_PROVIDER);
  }

  /**
   * Whether a curated `releasedAt` is recent enough to announce through a
   * baseline. Missing, malformed, or future-dated values are NOT recent — a
   * typo'd date must fail closed (silent), never announce forever.
   */
  private _isRecentRelease(releasedAt: string | undefined): boolean {
    if (typeof releasedAt !== 'string' || releasedAt.length === 0) {
      return false;
    }
    const ts = Date.parse(releasedAt);
    if (Number.isNaN(ts)) {
      return false;
    }
    const age = Date.now() - ts;
    return age >= 0 && age <= MODEL_ANNOUNCE_FRESH_WINDOW_MS;
  }

  /** Read persisted state, tolerating any shape (corrupt state must not break activation). */
  private _load(): AnnouncementState {
    const empty: AnnouncementState = { seen: {}, pending: [] };
    try {
      const raw = this._context.globalState.get<unknown>(MODEL_ANNOUNCEMENTS_KEY);
      if (!raw || typeof raw !== 'object') {
        return empty;
      }
      const obj = raw as Partial<AnnouncementState>;
      const seen: Record<string, string[]> = {};
      if (obj.seen && typeof obj.seen === 'object') {
        for (const [providerId, ids] of Object.entries(obj.seen)) {
          if (Array.isArray(ids)) {
            seen[providerId] = ids.filter((i): i is string => typeof i === 'string');
          }
        }
      }
      const pending = Array.isArray(obj.pending)
        ? obj.pending.filter((p): p is AnnouncedModel =>
            !!p && typeof p === 'object'
            && typeof (p as AnnouncedModel).providerId === 'string'
            && typeof (p as AnnouncedModel).modelId === 'string')
            .slice(0, MODEL_ANNOUNCE_MAX_PENDING)
        : [];
      return { seen, pending };
    } catch (err) {
      console.warn(`[Mysti] ModelAnnouncement: failed to read state, starting empty: ${String(err)}`);
      return empty;
    }
  }

  private async _persist(): Promise<void> {
    try {
      await this._context.globalState.update(MODEL_ANNOUNCEMENTS_KEY, this._state);
    } catch (err) {
      console.warn(`[Mysti] ModelAnnouncement: failed to persist state: ${String(err)}`);
    }
  }

  public dispose(): void {
    this._onDidAnnounce.dispose();
    this._onDidChangePending.dispose();
  }
}
