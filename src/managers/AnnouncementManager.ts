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
import type { DeepMystAuthManager } from './DeepMystAuthManager';
import type { InAppMessage, InAppMessageEvent } from '../services/DeepMystClient';

/**
 * AnnouncementManager — fetches the dynamic in-app messages DeepMyst targets at
 * the current user (GET /api/v1/me/announcements) and records their
 * interactions back (shown / dismissed / clicked / responded).
 *
 * Design:
 *  - A no-op when signed out (no `dm_` key), so anonymous users see nothing and
 *    no network call is made.
 *  - Results are cached in-memory for ~5 min so opening several panels doesn't
 *    refetch on every session open.
 *  - `frequency=once` messages the user dismissed/responded to are remembered in
 *    globalState (`mysti.dismissedMessages`) for *instant* client-side
 *    suppression, complementing the server-side filter (which is authoritative
 *    but only reflects after the next fetch). `every_session` messages are never
 *    persisted — they reappear next session by design.
 *  - Every method is best-effort and never throws into the caller.
 */
export class AnnouncementManager {
  private static readonly _dismissedKey = 'mysti.dismissedMessages';
  private static readonly _cacheTtlMs = 5 * 60 * 1000;

  private _cache: { items: InAppMessage[]; at: number } | null = null;

  constructor(
    private readonly _auth: DeepMystAuthManager,
    private readonly _globalState: vscode.Memento,
  ) {}

  /**
   * Return the messages to render for this session, freshest-priority first.
   * Empty when signed out or on any failure. Filters out locally-suppressed
   * (`once` already dismissed/responded) ids.
   */
  async getSessionMessages(): Promise<InAppMessage[]> {
    if (!this._auth.isSignedIn()) {
      return [];
    }

    const now = Date.now();
    let items: InAppMessage[];
    if (this._cache && now - this._cache.at < AnnouncementManager._cacheTtlMs) {
      items = this._cache.items;
    } else {
      try {
        const result = await this._auth.client.listAnnouncements();
        items = result.items;
        this._cache = { items, at: now };
      } catch (err) {
        console.warn(`[Mysti] AnnouncementManager fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    }

    const suppressed = this._getDismissed();
    return items.filter(m => !suppressed.has(m.id));
  }

  /** Record that a batch of messages was shown to the user (analytics). */
  async markShown(ids: string[]): Promise<void> {
    await Promise.all(ids.map(id => this._record(id, 'shown')));
  }

  /**
   * User dismissed a message (× button). Suppress `once` messages permanently;
   * for `every_session` just drop the cached copy so it isn't re-served from
   * cache this session.
   */
  async markDismissed(message: InAppMessage): Promise<void> {
    if (message.frequency !== 'every_session') {
      await this._addDismissed(message.id);
    }
    this._dropFromCache(message.id);
    await this._record(message.id, 'dismissed');
  }

  /** User clicked an announcement CTA. */
  async markClicked(id: string): Promise<void> {
    await this._record(id, 'clicked');
  }

  /**
   * User answered a feedback message. Treated like a dismissal for re-show
   * purposes (a `once` survey shouldn't reappear once answered).
   */
  async markResponded(message: InAppMessage, value: string): Promise<void> {
    if (message.frequency !== 'every_session') {
      await this._addDismissed(message.id);
    }
    this._dropFromCache(message.id);
    await this._record(message.id, 'responded', value);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async _record(id: string, event: InAppMessageEvent, value?: string): Promise<void> {
    if (!this._auth.isSignedIn()) {
      return;
    }
    try {
      await this._auth.client.recordAnnouncementEvent(id, event, value);
    } catch {
      // best-effort; analytics gap is acceptable
    }
  }

  private _getDismissed(): Set<string> {
    const stored = this._globalState.get<string[]>(AnnouncementManager._dismissedKey, []);
    return new Set(Array.isArray(stored) ? stored : []);
  }

  private async _addDismissed(id: string): Promise<void> {
    const set = this._getDismissed();
    if (set.has(id)) {
      return;
    }
    set.add(id);
    await this._globalState.update(AnnouncementManager._dismissedKey, Array.from(set));
  }

  private _dropFromCache(id: string): void {
    if (this._cache) {
      this._cache.items = this._cache.items.filter(m => m.id !== id);
    }
  }
}
