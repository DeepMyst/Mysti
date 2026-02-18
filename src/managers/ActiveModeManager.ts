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
import {
  OpenClawGateway,
  type GatewayStatus,
  type ChannelInfo,
  type ChannelEvent,
  type ActivityEntry,
  type ChannelConnectResult,
  type SessionInfo,
  type SessionMessage,
} from '../providers/openclaw/OpenClawGateway';
import { getCommonSearchPaths, validateCliPath, checkCommandExists, getEnrichedEnv, readOpenClawToken } from '../utils/platform';

const ACTIVITY_LOG_MAX = 100;
const RECONNECT_INTERVAL_MS = 60_000;

/**
 * Provider-independent manager for the OpenClaw daemon connection.
 *
 * Always initialized at extension activation — connects to the OpenClaw
 * Gateway regardless of which chat provider is selected. Surfaces daemon
 * status, channel management, and cross-channel activity to the webview.
 */
export class ActiveModeManager {
  private _gateway: OpenClawGateway;
  private _installed = false;
  private _daemonStatus: GatewayStatus | null = null;
  private _channels: ChannelInfo[] = [];
  private _activityLog: ActivityEntry[] = [];
  private _cachedSkills: { name: string; emoji: string; description: string }[] = [];
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _channelEventCleanup: (() => void) | null = null;
  private _disposed = false;
  private _integrationEnabled = true;

  // VSCode event emitters
  private _onStatusChangedEmitter = new vscode.EventEmitter<GatewayStatus | null>();
  readonly onStatusChanged = this._onStatusChangedEmitter.event;

  private _onChannelChangedEmitter = new vscode.EventEmitter<ChannelInfo[]>();
  readonly onChannelChanged = this._onChannelChangedEmitter.event;

  private _onActivityEmitter = new vscode.EventEmitter<ActivityEntry>();
  readonly onActivity = this._onActivityEmitter.event;

  constructor(private _context: vscode.ExtensionContext) {
    const gatewayUrl = vscode.workspace.getConfiguration('mysti').get<string>(
      'openclawGatewayUrl', 'ws://127.0.0.1:18789'
    );
    const token = readOpenClawToken();
    this._gateway = new OpenClawGateway(gatewayUrl, token);
  }

  // --- Lifecycle ---

  /**
   * Detect OpenClaw CLI, connect to daemon, start polling.
   * Non-blocking: resolves quickly even if daemon is unavailable.
   */
  async initialize(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('mysti').get<boolean>('activeMode.enabled', true);
    if (!enabled) {
      console.log('[Mysti] ActiveMode: Disabled by setting');
      return;
    }

    this._installed = await this._detectCli();
    if (!this._installed) {
      console.log('[Mysti] ActiveMode: OpenClaw CLI not found, hiding active mode');
      this._onStatusChangedEmitter.fire(null);
      return;
    }

    // Fetch available skills (non-blocking, cached)
    this._fetchSkills();

    const gatewayUrl = vscode.workspace.getConfiguration('mysti').get<string>(
      'openclawGatewayUrl', 'ws://127.0.0.1:18789'
    );
    console.log('[Mysti] ActiveMode: OpenClaw CLI detected, connecting to daemon at', gatewayUrl);
    await this._connectAndStartPolling();
  }

  dispose(): void {
    this._disposed = true;
    this._stopPolling();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._channelEventCleanup) {
      this._channelEventCleanup();
      this._channelEventCleanup = null;
    }
    this._gateway.disconnect();
    this._onStatusChangedEmitter.dispose();
    this._onChannelChangedEmitter.dispose();
    this._onActivityEmitter.dispose();
  }

  // --- State ---

  isInstalled(): boolean {
    return this._installed;
  }

  isConnected(): boolean {
    return this._gateway.isConnected();
  }

  isIntegrationEnabled(): boolean {
    return this._integrationEnabled;
  }

  setIntegrationEnabled(enabled: boolean): void {
    this._integrationEnabled = enabled;
    console.log(`[Mysti] ActiveMode: Integration ${enabled ? 'enabled' : 'disabled'}`);
  }

  getDaemonStatus(): GatewayStatus | null {
    return this._daemonStatus;
  }

  getChannels(): ChannelInfo[] {
    return this._channels;
  }

  getActivityLog(): ActivityEntry[] {
    return this._activityLog;
  }

  getSkills(): { name: string; emoji: string; description: string }[] {
    return this._cachedSkills;
  }

  /**
   * Send a message to a channel via the Gateway.
   * If target is provided, sends to that specific recipient.
   * Otherwise, sends to the channel's self-chat target.
   */
  async sendToChannel(channelId: string, message: string, target?: string): Promise<boolean> {
    return this._gateway.sendToChannel(channelId, message, target);
  }

  /**
   * Delegate a task to the OpenClaw agent via `chat.send`.
   * The agent can use its tools (message, exec, browse) and resolve fuzzy contacts.
   */
  async sendAgentTask(prompt: string, sessionKey?: string): Promise<boolean> {
    return this._gateway.sendAgentTask(prompt, sessionKey);
  }

  /**
   * Subscribe to raw channel events from the Gateway.
   * Returns a cleanup function.
   */
  subscribeToChannelEvents(handler: (event: ChannelEvent) => void): () => void {
    return this._gateway.subscribeToChannelEvents(handler);
  }

  /**
   * List active sessions from the Gateway (for inbound message polling).
   */
  async listSessions(): Promise<SessionInfo[]> {
    return this._gateway.listSessions();
  }

  /**
   * Fetch session history from the Gateway (for inbound message polling).
   */
  async getSessionHistory(sessionKey: string, after?: number, limit?: number): Promise<SessionMessage[]> {
    return this._gateway.getSessionHistory(sessionKey, after, limit);
  }

  // --- Actions ---

  async connectChannel(type: string, config: Record<string, unknown> = {}): Promise<ChannelConnectResult> {
    const result = await this._gateway.connectChannel(type, config);
    if (result.success) {
      this._addActivity('system', `Connecting ${type} channel...`);
      // Refresh channels after a short delay to pick up new channel
      setTimeout(() => this._refreshChannels(), 2000);
    }
    return result;
  }

  async disconnectChannel(channelId: string): Promise<void> {
    const channel = this._channels.find(c => c.id === channelId);
    const name = channel ? `${channel.type} (${channel.name})` : channelId;
    const success = await this._gateway.disconnectChannel(channelId);
    if (success) {
      this._addActivity('system', `Disconnected ${name}`);
      await this._refreshChannels();
    }
  }

  async refreshStatus(): Promise<void> {
    // If not connected, try reconnecting before polling
    if (!this._gateway.isConnected()) {
      console.log('[Mysti] ActiveMode: Not connected, attempting reconnect...');
      const connected = await this._gateway.connect();
      if (connected) {
        console.log('[Mysti] ActiveMode: Reconnected to daemon');
        this._subscribeToChannelEvents();
        this._startPolling();
      }
    }
    await this._pollStatus();
    await this._refreshChannels();
  }

  /**
   * Attempt to start the OpenClaw daemon if it's not running.
   */
  async startDaemon(): Promise<boolean> {
    try {
      const { exec } = await import('child_process');
      const env = getEnrichedEnv();
      return new Promise<boolean>((resolve) => {
        exec('openclaw gateway --detach', { timeout: 10000, env }, (error) => {
          if (error) {
            console.log('[Mysti] ActiveMode: Failed to start daemon:', error.message);
            resolve(false);
          } else {
            console.log('[Mysti] ActiveMode: Daemon start command issued');
            // Give daemon a moment to boot, then try connecting
            setTimeout(async () => {
              await this._connectAndStartPolling();
              resolve(this._gateway.isConnected());
            }, 3000);
          }
        });
      });
    } catch {
      return false;
    }
  }

  // --- Private: CLI Detection ---

  private async _detectCli(): Promise<boolean> {
    // Use the same search strategy as BaseCliProvider._discoverCliCommon()
    const configuredPath = vscode.workspace.getConfiguration('mysti').get<string>('openclawPath', 'openclaw');
    const searchPaths = getCommonSearchPaths({
      commandName: 'openclaw',
      configuredPath: configuredPath !== 'openclaw' ? configuredPath : undefined,
    });

    // Check known installation paths first
    for (const searchPath of searchPaths) {
      if (await validateCliPath(searchPath)) {
        console.log('[Mysti] ActiveMode: Found OpenClaw CLI at:', searchPath);
        return true;
      }
    }

    // Fall back to PATH lookup
    if (await checkCommandExists('openclaw')) {
      console.log('[Mysti] ActiveMode: Found OpenClaw CLI via PATH');
      return true;
    }

    return false;
  }

  /**
   * Fetch available skills from OpenClaw CLI (non-blocking).
   * Runs `openclaw skills list --json` and caches the ready (eligible) skills.
   */
  private _fetchSkills(): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { exec } = require('child_process') as typeof import('child_process');
    const env = getEnrichedEnv();
    exec('openclaw skills list --json', { timeout: 15000, env, maxBuffer: 1024 * 512 }, (error: Error | null, stdout: string) => {
      if (error) {
        console.log('[Mysti] ActiveMode: Failed to fetch skills:', error.message);
        return;
      }
      try {
        const data = JSON.parse(stdout) as { skills?: Array<{ name: string; emoji?: string; description?: string; eligible?: boolean }> };
        const allSkills = data.skills || [];
        this._cachedSkills = allSkills
          .filter(s => s.eligible)
          .map(s => ({
            name: s.name,
            emoji: s.emoji || '',
            description: s.description || '',
          }));
        console.log(`[Mysti] ActiveMode: Cached ${this._cachedSkills.length} ready skills (of ${allSkills.length} total)`);
      } catch (err) {
        console.log('[Mysti] ActiveMode: Failed to parse skills JSON:', err);
      }
    });
  }

  // --- Private: Connection & Polling ---

  private async _connectAndStartPolling(): Promise<void> {
    const connected = await this._gateway.connect();
    if (connected) {
      console.log('[Mysti] ActiveMode: Connected to daemon');
      this._subscribeToChannelEvents();
      await this._pollStatus();
      await this._refreshChannels();
      await this._loadInitialActivity();
      this._startPolling();
    } else {
      console.log('[Mysti] ActiveMode: Daemon not reachable, will retry');
      this._daemonStatus = null;
      this._onStatusChangedEmitter.fire(null);
      this._scheduleReconnect();
    }
  }

  private _startPolling(): void {
    this._stopPolling();
    const interval = vscode.workspace.getConfiguration('mysti').get<number>(
      'activeMode.pollInterval', 30
    ) * 1000;
    this._pollTimer = setInterval(() => this._pollStatus(), interval);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectTimer) { return; }
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._disposed) {
        await this._connectAndStartPolling();
      }
    }, RECONNECT_INTERVAL_MS);
  }

  private async _pollStatus(): Promise<void> {
    if (!this._gateway.isConnected()) {
      if (this._daemonStatus !== null) {
        this._daemonStatus = null;
        this._onStatusChangedEmitter.fire(null);
        this._stopPolling();
        this._scheduleReconnect();
      }
      return;
    }

    const status = await this._gateway.getGatewayStatus();
    if (status) {
      const changed = !this._daemonStatus ||
        this._daemonStatus.channelCount !== status.channelCount ||
        this._daemonStatus.version !== status.version;
      this._daemonStatus = status;
      if (changed) {
        this._onStatusChangedEmitter.fire(status);
      }
      // Always refresh channels — connection status can change independently of gateway status
      await this._refreshChannels();
    } else {
      // Gateway connected but status query failed — daemon may be shutting down
      if (this._daemonStatus !== null) {
        this._daemonStatus = null;
        this._onStatusChangedEmitter.fire(null);
      }
    }
  }

  private async _refreshChannels(): Promise<void> {
    const channels = await this._gateway.listChannels();
    this._channels = channels;
    this._onChannelChangedEmitter.fire(channels);
  }

  private async _loadInitialActivity(): Promise<void> {
    const limit = vscode.workspace.getConfiguration('mysti').get<number>(
      'activeMode.activityLimit', 50
    );
    this._activityLog = await this._gateway.getActivityLog(limit);
  }

  // --- Private: Channel Events ---

  private _subscribeToChannelEvents(): void {
    if (this._channelEventCleanup) {
      this._channelEventCleanup();
    }
    this._channelEventCleanup = this._gateway.subscribeToChannelEvents((event: ChannelEvent) => {
      this._handleChannelEvent(event);
    });
  }

  private _handleChannelEvent(event: ChannelEvent): void {
    // Build activity entry from event
    let action = '';
    switch (event.eventType) {
      case 'message_received':
        action = event.content
          ? `Message: "${event.content.substring(0, 80)}${event.content.length > 80 ? '...' : ''}"`
          : 'Message received';
        break;
      case 'message_sent':
        action = 'Agent responded';
        break;
      case 'connected':
        action = 'Channel connected';
        this._refreshChannels();
        break;
      case 'disconnected':
        action = 'Channel disconnected';
        this._refreshChannels();
        break;
      case 'pairing':
        action = 'Pairing in progress...';
        break;
    }

    const source = event.channelType || 'channel';
    this._addActivity(source, action, event.sender ? `From: ${event.sender}` : undefined);
  }

  private _addActivity(source: string, action: string, details?: string): void {
    const entry: ActivityEntry = {
      timestamp: Date.now(),
      source,
      action,
      details,
    };
    this._activityLog.unshift(entry);
    if (this._activityLog.length > ACTIVITY_LOG_MAX) {
      this._activityLog.pop();
    }
    this._onActivityEmitter.fire(entry);
  }
}
