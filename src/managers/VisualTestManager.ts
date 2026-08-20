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
 * Visual-test bookkeeping: the per-panel observation log, the cancel flag, and
 * ownership of the warm `VisualSessionManager` for disposal.
 *
 * This class used to ALSO run the loop — `startVisualTest` drove its own
 * `providerManager.sendMessage` under a synthetic panel id and consumed the
 * resulting `tool_use` chunks purely to render display strings. Because
 * `_shouldGateToolUse` lives in ChatViewProvider's stream loops and never saw
 * that stream, every file write and shell command the inner agent performed was
 * UNGATED — and the synthesized settings resolved `mode` to `'default'`, the
 * exact branch that passes `--dangerously-skip-permissions` to the CLI.
 *
 * That loop is gone. Visual testing is now a perception primitive
 * (`VisualSessionManager.look`) that returns an observation to the CALLING
 * agent, which fixes what it saw using its own already-gated tools. There is no
 * second agent, so there is no second gate to forget.
 */

import * as vscode from 'vscode';
import type { VisualObservation } from '../types';

/** What a panel has observed so far, for the dashboard and `getReport`. */
export interface VisualTestLog {
  panelId: string;
  observations: VisualObservation[];
  startedAt: number;
  lastUpdatedAt: number;
}

/** The subset of VisualSessionManager this manager needs (avoids a circular import). */
interface SessionManagerLike {
  dispose(): Promise<void>;
  close(key: string): Promise<void>;
  closeForPanel(panelId: string): Promise<void>;
  isDevServerRunning(key: string): boolean;
}

export class VisualTestManager {
  private _logs: Map<string, VisualTestLog> = new Map();
  private _cancelled: Set<string> = new Set();
  private _sessions: SessionManagerLike | undefined;
  private _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  /**
   * Adopt the warm visual session manager for disposal and lifecycle queries.
   *
   * `VisualSessionManager` is built lazily by ChatViewProvider (it needs the
   * approval UI), but extension.ts already tears THIS manager down on
   * deactivate — registering it here means a browser and a dev server can never
   * outlive the extension host without threading a 23rd constructor argument.
   */
  attachSessionManager(sessions: SessionManagerLike): void {
    this._sessions = sessions;
  }

  /** Record an observation against a panel. */
  recordObservation(panelId: string, observation: VisualObservation): void {
    const now = Date.now();
    const log = this._logs.get(panelId) || { panelId, observations: [], startedAt: now, lastUpdatedAt: now };
    log.observations.push(observation);
    log.lastUpdatedAt = now;
    // Bound the log: observations carry a DOM outline and can carry base64.
    if (log.observations.length > 20) { log.observations.shift(); }
    this._logs.set(panelId, log);
  }

  /** Mark a panel's in-flight observation as cancelled. */
  cancelTest(panelId: string): void {
    this._cancelled.add(panelId);
    void this._sessions?.closeForPanel(panelId);
  }

  isCancelled(panelId: string): boolean {
    return this._cancelled.has(panelId);
  }

  clearCancel(panelId: string): void {
    this._cancelled.delete(panelId);
  }

  /** The observation log for a panel, or null. */
  getReport(panelId: string): VisualTestLog | null {
    return this._logs.get(panelId) || null;
  }

  /** Tear down a panel's warm session (dev server + browser). */
  async stopDevServer(panelId: string): Promise<void> {
    await this._sessions?.closeForPanel(panelId);
  }

  isDevServerRunning(panelId: string): boolean {
    return this._sessions?.isDevServerRunning(`mysti:${panelId}`) ?? false;
  }

  /** Drop a panel's state entirely (panel disposed). */
  async disposePanel(panelId: string): Promise<void> {
    this._logs.delete(panelId);
    this._cancelled.delete(panelId);
    await this._sessions?.closeForPanel(panelId);
  }

  /**
   * Dispose all resources. Awaited by extension.ts so a browser and a dev
   * server can never survive the extension host.
   */
  async dispose(): Promise<void> {
    await this._sessions?.dispose().catch(() => { /* best effort */ });
    this._logs.clear();
    this._cancelled.clear();
  }
}
