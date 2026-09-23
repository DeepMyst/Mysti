/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'crypto';
import type { ContextItem, Mention, Settings } from '../types';
import { validForegroundRequestId } from './ForegroundRequest';

export interface MentionTurn {
  content: string;
  mentions: Mention[];
  context: ContextItem[];
  settings: Settings;
  conversationId: string | null | undefined;
}

// ponytail: a fixed window per panel; a card older than this gets the stale
// notice. Raise it if people retry cards many turns back.
const TURNS_PER_PANEL = 8;

/**
 * Mention turns a sub-agent card can still retry, keyed by a host-issued id
 * the card carries. A click names its turn; nothing resolves "the latest".
 */
export class MentionRetryStore {
  private readonly _panels = new Map<string, Map<string, MentionTurn>>();

  public record(panelId: string, turn: MentionTurn): string {
    const id = crypto.randomUUID();
    let turns = this._panels.get(panelId);
    if (!turns) {
      turns = new Map();
      this._panels.set(panelId, turns);
    }
    turns.set(id, turn);
    if (turns.size > TURNS_PER_PANEL) { turns.delete(turns.keys().next().value as string); }
    return id;
  }

  /**
   * Resolve a Retry click to the turn its card came from and the single agent
   * mention to re-run. The turn must still be retained and belong to the
   * conversation the panel shows now. Not single use: the retried card carries
   * the same id, so a second failure can be retried again.
   */
  public claim(panelId: string, payload: unknown, conversationId: string | null | undefined):
    { id: string; turn: MentionTurn; mention: Mention } | undefined {
    if (!payload || typeof payload !== 'object') { return undefined; }
    const { retryId, agentId } = payload as { retryId?: unknown; agentId?: unknown };
    if (!validForegroundRequestId(retryId) || typeof agentId !== 'string') { return undefined; }
    const turn = this._panels.get(panelId)?.get(retryId);
    if (!turn || (turn.conversationId ?? null) !== (conversationId ?? null)) { return undefined; }
    const mention = turn.mentions.find(m => m.type === 'agent' && m.value === agentId);
    return mention ? { id: retryId, turn, mention } : undefined;
  }

  public clearPanel(panelId: string): void { this._panels.delete(panelId); }

  public clear(): void { this._panels.clear(); }
}
