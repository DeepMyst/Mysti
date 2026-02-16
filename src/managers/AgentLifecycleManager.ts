/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as vscode from 'vscode';
import {
  AgentSessionStatus,
  AgentSessionInfo,
  LifecycleEvent,
  LifecycleEventType,
  ShutdownResult,
  ProviderType,
} from '../types';
import {
  LIFECYCLE_CHECK_INTERVAL_MS,
} from '../constants';
import { getChildPids, isProcessAlive } from '../utils/processTree';

interface AgentSessionState {
  panelId: string;
  providerId: ProviderType;
  sessionId: string | null;
  status: AgentSessionStatus;
  lastActivityTimestamp: number;
  createdAt: number;
  lastKnownPid: number | null;
  trackedChildPids: Set<number>;
  idleTimer: NodeJS.Timeout | null;
}

interface LifecycleConfig {
  enabled: boolean;
  idleTimeoutMs: number;
  processTreeTracking: boolean;
  protectActiveChildren: boolean;
  checkIntervalMs: number;
}

export class AgentLifecycleManager {
  private _sessions = new Map<string, AgentSessionState>();
  private _config: LifecycleConfig;
  private _processCheckInterval: NodeJS.Timeout | null = null;
  private _configDisposable: vscode.Disposable;
  private _eventCallbacks: ((event: LifecycleEvent) => void)[] = [];

  constructor(_context: vscode.ExtensionContext) {
    this._config = this._loadConfig();

    this._configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mysti.lifecycle')) {
        const oldEnabled = this._config.enabled;
        this._config = this._loadConfig();
        if (this._config.enabled && !oldEnabled) {
          this._startProcessCheckInterval();
        } else if (!this._config.enabled && oldEnabled) {
          this._stopProcessCheckInterval();
        }
      }
    });

    if (this._config.enabled) {
      this._startProcessCheckInterval();
    }

    console.log('[Mysti] AgentLifecycleManager: Initialized', {
      enabled: this._config.enabled,
      idleTimeoutMin: Math.round(this._config.idleTimeoutMs / 60000),
      processTreeTracking: this._config.processTreeTracking,
    });
  }

  // ---- Public API ----

  registerSession(panelId: string, providerId: ProviderType, sessionId: string | null): void {
    if (!this._config.enabled) { return; }

    const existing = this._sessions.get(panelId);
    if (existing) {
      existing.providerId = providerId;
      existing.sessionId = sessionId;
      existing.lastActivityTimestamp = Date.now();
      console.log(`[Mysti] AgentLifecycleManager: Session updated for panel ${panelId}`);
      return;
    }

    const session: AgentSessionState = {
      panelId,
      providerId,
      sessionId,
      status: 'active',
      lastActivityTimestamp: Date.now(),
      createdAt: Date.now(),
      lastKnownPid: null,
      trackedChildPids: new Set(),
      idleTimer: null,
    };

    this._sessions.set(panelId, session);
    this._emitEvent('session-started', panelId, providerId);
    console.log(`[Mysti] AgentLifecycleManager: Session registered for panel ${panelId} (provider: ${providerId})`);
  }

  touchSession(panelId: string): void {
    const session = this._sessions.get(panelId);
    if (!session) { return; }
    session.lastActivityTimestamp = Date.now();
    this._resetIdleTimer(session);
  }

  markBusy(panelId: string): void {
    const session = this._sessions.get(panelId);
    if (!session) { return; }
    session.status = 'busy';
    session.lastActivityTimestamp = Date.now();
    this._clearIdleTimer(session);
  }

  markIdle(panelId: string): void {
    const session = this._sessions.get(panelId);
    if (!session) { return; }
    session.status = 'idle';
    session.lastActivityTimestamp = Date.now();
    this._startIdleTimer(session);
    this._emitEvent('session-idle', panelId, session.providerId);
  }

  removeSession(panelId: string): void {
    const session = this._sessions.get(panelId);
    if (!session) { return; }
    this._clearIdleTimer(session);
    this._sessions.delete(panelId);
    console.log(`[Mysti] AgentLifecycleManager: Session removed for panel ${panelId}`);
  }

  getSession(panelId: string): AgentSessionInfo | null {
    const session = this._sessions.get(panelId);
    if (!session) { return null; }
    return this._toSessionInfo(session);
  }

  getAllSessions(): AgentSessionInfo[] {
    return Array.from(this._sessions.values()).map(s => this._toSessionInfo(s));
  }

  async requestShutdown(panelId: string, force = false): Promise<ShutdownResult> {
    const session = this._sessions.get(panelId);
    if (!session) {
      return { success: false, blocked: false, reason: 'Session not found' };
    }

    if (!force && this._config.protectActiveChildren) {
      const childPids = await this._scanChildren(session);
      if (childPids.length > 0) {
        this._emitEvent('shutdown-blocked', panelId, session.providerId, `${childPids.length} active child process(es)`, childPids);
        return { success: false, blocked: true, reason: 'Active child processes detected', childPids };
      }
    }

    session.status = 'shutting-down';
    this._clearIdleTimer(session);
    this._emitEvent('session-shutdown', panelId, session.providerId);
    this._sessions.delete(panelId);

    console.log(`[Mysti] AgentLifecycleManager: Session shut down for panel ${panelId} (force: ${force})`);
    return { success: true, blocked: false };
  }

  async shutdownAll(force = false): Promise<void> {
    const panelIds = Array.from(this._sessions.keys());
    for (const panelId of panelIds) {
      await this.requestShutdown(panelId, force);
    }
  }

  registerProcessPid(panelId: string, pid: number): void {
    const session = this._sessions.get(panelId);
    if (!session) { return; }
    session.lastKnownPid = pid;
  }

  clearProcessPid(panelId: string): void {
    const session = this._sessions.get(panelId);
    if (!session) { return; }
    session.lastKnownPid = null;
  }

  async hasActiveChildren(panelId: string): Promise<boolean> {
    const session = this._sessions.get(panelId);
    if (!session) { return false; }
    const children = await this._scanChildren(session);
    return children.length > 0;
  }

  onLifecycleEvent(callback: (event: LifecycleEvent) => void): vscode.Disposable {
    this._eventCallbacks.push(callback);
    return new vscode.Disposable(() => {
      const idx = this._eventCallbacks.indexOf(callback);
      if (idx >= 0) { this._eventCallbacks.splice(idx, 1); }
    });
  }

  dispose(): void {
    this._stopProcessCheckInterval();
    for (const session of this._sessions.values()) {
      this._clearIdleTimer(session);
    }
    this._sessions.clear();
    this._eventCallbacks.length = 0;
    this._configDisposable.dispose();
    console.log('[Mysti] AgentLifecycleManager: Disposed');
  }

  // ---- Private: Idle Timer ----

  private _startIdleTimer(session: AgentSessionState): void {
    this._clearIdleTimer(session);
    if (!this._config.enabled) { return; }

    session.idleTimer = setTimeout(async () => {
      session.idleTimer = null;
      await this._handleIdleTimeout(session);
    }, this._config.idleTimeoutMs);
  }

  private _resetIdleTimer(session: AgentSessionState): void {
    if (session.status === 'idle') {
      this._startIdleTimer(session);
    }
  }

  private _clearIdleTimer(session: AgentSessionState): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  private async _handleIdleTimeout(session: AgentSessionState): Promise<void> {
    // Session may have been removed or reactivated while timer was pending
    if (!this._sessions.has(session.panelId) || session.status !== 'idle') {
      return;
    }

    if (this._config.protectActiveChildren && this._config.processTreeTracking) {
      const childPids = await this._scanChildren(session);
      if (childPids.length > 0) {
        console.log(`[Mysti] AgentLifecycleManager: Idle timeout blocked for ${session.panelId} — ${childPids.length} active children`);
        this._emitEvent('shutdown-blocked', session.panelId, session.providerId, `${childPids.length} active child process(es)`, childPids);
        // Reschedule check in 30s
        session.idleTimer = setTimeout(async () => {
          session.idleTimer = null;
          await this._handleIdleTimeout(session);
        }, LIFECYCLE_CHECK_INTERVAL_MS);
        return;
      }
    }

    console.log(`[Mysti] AgentLifecycleManager: Session expired for ${session.panelId} (idle timeout)`);
    this._emitEvent('session-expired', session.panelId, session.providerId);
    this._sessions.delete(session.panelId);
  }

  // ---- Private: Process Tree Scanning ----

  private async _scanChildren(session: AgentSessionState): Promise<number[]> {
    if (!this._config.processTreeTracking) { return []; }

    const allChildPids: number[] = [];

    // Scan children of lastKnownPid
    if (session.lastKnownPid !== null) {
      try {
        const children = await getChildPids(session.lastKnownPid);
        allChildPids.push(...children);
      } catch {
        // pgrep/wmic may fail, treat as no children
      }
    }

    // Check if tracked child PIDs are still alive
    const aliveTracked: number[] = [];
    for (const pid of session.trackedChildPids) {
      try {
        if (await isProcessAlive(pid)) {
          aliveTracked.push(pid);
        }
      } catch {
        // Process check failed, assume dead
      }
    }

    // Update tracked set
    session.trackedChildPids = new Set([...allChildPids, ...aliveTracked]);

    const combinedPids = Array.from(session.trackedChildPids);

    // Emit events for child state changes
    const hadChildren = session.trackedChildPids.size > 0;
    if (combinedPids.length > 0 && !hadChildren) {
      this._emitEvent('children-detected', session.panelId, session.providerId, undefined, combinedPids);
    } else if (combinedPids.length === 0 && hadChildren) {
      this._emitEvent('children-cleared', session.panelId, session.providerId);
    }

    return combinedPids;
  }

  private _startProcessCheckInterval(): void {
    this._stopProcessCheckInterval();
    this._processCheckInterval = setInterval(async () => {
      for (const session of this._sessions.values()) {
        if (session.status === 'idle' && session.lastKnownPid !== null) {
          await this._scanChildren(session);
        }
      }
    }, this._config.checkIntervalMs);
  }

  private _stopProcessCheckInterval(): void {
    if (this._processCheckInterval) {
      clearInterval(this._processCheckInterval);
      this._processCheckInterval = null;
    }
  }

  // ---- Private: Helpers ----

  private _emitEvent(
    type: LifecycleEventType,
    panelId: string,
    providerId: ProviderType,
    detail?: string,
    childPids?: number[],
  ): void {
    const event: LifecycleEvent = { type, panelId, providerId, detail, childPids };
    for (const cb of this._eventCallbacks) {
      try {
        cb(event);
      } catch (err) {
        console.error('[Mysti] AgentLifecycleManager: Event callback error:', err);
      }
    }
  }

  private _toSessionInfo(session: AgentSessionState): AgentSessionInfo {
    const now = Date.now();
    let idleRemainingMs = 0;

    if (session.status === 'idle') {
      const elapsed = now - session.lastActivityTimestamp;
      idleRemainingMs = Math.max(0, this._config.idleTimeoutMs - elapsed);
    }

    return {
      panelId: session.panelId,
      providerId: session.providerId,
      sessionId: session.sessionId,
      status: session.status,
      lastActivityTimestamp: session.lastActivityTimestamp,
      createdAt: session.createdAt,
      hasActiveChildren: session.trackedChildPids.size > 0,
      childPids: Array.from(session.trackedChildPids),
      idleRemainingMs,
    };
  }

  private _loadConfig(): LifecycleConfig {
    const config = vscode.workspace.getConfiguration('mysti');
    const idleMinutes = config.get<number>('lifecycle.idleTimeoutMinutes', 60);
    const checkSeconds = config.get<number>('lifecycle.checkIntervalSeconds', 30);

    return {
      enabled: config.get<boolean>('lifecycle.enabled', true),
      idleTimeoutMs: Math.max(60000, idleMinutes * 60 * 1000), // min 1 minute
      processTreeTracking: config.get<boolean>('lifecycle.processTreeTracking', true),
      protectActiveChildren: config.get<boolean>('lifecycle.protectActiveChildren', true),
      checkIntervalMs: Math.max(10000, checkSeconds * 1000), // min 10 seconds
    };
  }
}
