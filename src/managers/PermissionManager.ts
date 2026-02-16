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
import { randomUUID } from 'crypto';
import type {
  AccessLevel,
  PermissionActionType,
  PermissionConfig,
  PermissionDetails,
  PermissionRequest,
  PermissionResponse,
  PermissionRiskLevel,
  PermissionTimeoutBehavior
} from '../types';
import { SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S } from '../constants';

/**
 * Manages permission requests for tool operations
 * Handles configurable timeouts and session-level access upgrades
 */
export class PermissionManager {
  private _pendingRequests: Map<string, PermissionRequest> = new Map();
  private _resolvers: Map<string, (approved: boolean) => void> = new Map();
  private _timeoutHandles: Map<string, NodeJS.Timeout> = new Map();
  private _sessionAccessLevel: AccessLevel;
  private _config: PermissionConfig;
  private _onSemiAutonomousTimeout: ((requestId: string, postToWebview: (msg: unknown) => void) => void) | null = null;

  constructor(initialAccessLevel: AccessLevel) {
    this._sessionAccessLevel = initialAccessLevel;
    this._config = this._loadConfig();
  }

  /**
   * Load permission configuration from VSCode settings
   */
  private _loadConfig(): PermissionConfig {
    const config = vscode.workspace.getConfiguration('mysti');
    return {
      timeout: config.get<number>('permission.timeout', 30),
      timeoutBehavior: config.get<PermissionTimeoutBehavior>('permission.timeoutBehavior', 'auto-reject'),
      semiAutonomousTimeout: config.get<number>('semiAutonomous.timeout', SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S)
    };
  }

  /**
   * Refresh configuration (call when settings change)
   */
  refreshConfig(): void {
    this._config = this._loadConfig();
  }

  /**
   * Get current session access level
   */
  get sessionAccessLevel(): AccessLevel {
    return this._sessionAccessLevel;
  }

  /**
   * Request permission for an action
   * Returns a promise that resolves when user responds or times out
   */
  async requestPermission(
    actionType: PermissionActionType,
    title: string,
    description: string,
    details: PermissionDetails,
    postToWebview: (message: unknown) => void,
    toolCallId?: string
  ): Promise<boolean> {
    // Check if session has been upgraded to full-access
    if (this._sessionAccessLevel === 'full-access') {
      console.log('[Mysti] PermissionManager: Auto-approved (session full-access)');
      return true;
    }

    // Read-only operations are always allowed
    if (actionType === 'file-read') {
      return true;
    }

    // Create permission request
    const now = Date.now();
    const isSemiAutonomous = this._config.timeoutBehavior === 'semi-autonomous';
    const effectiveTimeout = isSemiAutonomous
      ? this._config.semiAutonomousTimeout
      : this._config.timeout;
    const expiresAt = effectiveTimeout > 0
      ? now + (effectiveTimeout * 1000)
      : 0; // 0 = no expiry

    const request: PermissionRequest = {
      id: this._generateId(),
      actionType,
      title,
      description,
      details,
      status: 'pending',
      createdAt: now,
      expiresAt,
      toolCallId,
      semiAutonomous: isSemiAutonomous
    };

    this._pendingRequests.set(request.id, request);

    // Send to webview
    postToWebview({
      type: 'permissionRequest',
      payload: request
    });

    console.log('[Mysti] PermissionManager: Permission requested:', request.id, title,
      isSemiAutonomous ? '(semi-autonomous)' : '');

    // Return promise that resolves when user responds or timeout occurs
    return new Promise((resolve) => {
      this._resolvers.set(request.id, resolve);

      // Set up timeout if configured
      if (effectiveTimeout > 0 && this._config.timeoutBehavior !== 'require-action') {
        const timeoutHandle = setTimeout(() => {
          if (isSemiAutonomous && this._onSemiAutonomousTimeout) {
            this._onSemiAutonomousTimeout(request.id, postToWebview);
          } else {
            this._handleTimeout(request.id, postToWebview);
          }
        }, effectiveTimeout * 1000);
        this._timeoutHandles.set(request.id, timeoutHandle);
      }
    });
  }

  /**
   * Handle user response to permission request
   */
  handleResponse(response: PermissionResponse): void {
    const request = this._pendingRequests.get(response.requestId);
    if (!request) {
      console.log('[Mysti] PermissionManager: No pending request for:', response.requestId);
      return;
    }

    // Clear timeout if set
    const timeoutHandle = this._timeoutHandles.get(response.requestId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this._timeoutHandles.delete(response.requestId);
    }

    // Update request status
    request.status = response.decision === 'deny' ? 'denied' : 'approved';
    this._pendingRequests.delete(response.requestId);

    // Handle "always-allow" - upgrade session access level
    if (response.decision === 'always-allow') {
      this._sessionAccessLevel = 'full-access';
      console.log('[Mysti] PermissionManager: Session upgraded to full-access');
    }

    // Resolve the promise
    const resolver = this._resolvers.get(response.requestId);
    if (resolver) {
      const approved = response.decision !== 'deny';
      resolver(approved);
      this._resolvers.delete(response.requestId);
      console.log('[Mysti] PermissionManager: Response handled:', response.requestId, approved ? 'approved' : 'denied');
    }
  }

  /**
   * Handle timeout for a permission request
   */
  private _handleTimeout(requestId: string, postToWebview: (message: unknown) => void): void {
    const request = this._pendingRequests.get(requestId);
    if (!request || request.status !== 'pending') {
      return;
    }

    // Update status
    request.status = 'expired';
    this._pendingRequests.delete(requestId);
    this._timeoutHandles.delete(requestId);

    // Determine result based on timeout behavior
    const approved = this._config.timeoutBehavior === 'auto-accept';

    // Notify webview
    postToWebview({
      type: 'permissionExpired',
      payload: {
        requestId,
        behavior: this._config.timeoutBehavior,
        approved
      }
    });

    // Resolve the promise
    const resolver = this._resolvers.get(requestId);
    if (resolver) {
      resolver(approved);
      this._resolvers.delete(requestId);
      console.log('[Mysti] PermissionManager: Timeout:', requestId,
        this._config.timeoutBehavior === 'auto-accept' ? 'auto-approved' : 'auto-rejected');
    }
  }

  /**
   * Cancel a pending permission request
   */
  cancelRequest(requestId: string): void {
    const request = this._pendingRequests.get(requestId);
    if (request) {
      request.status = 'denied';
      this._pendingRequests.delete(requestId);
    }

    const timeoutHandle = this._timeoutHandles.get(requestId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this._timeoutHandles.delete(requestId);
    }

    const resolver = this._resolvers.get(requestId);
    if (resolver) {
      resolver(false);
      this._resolvers.delete(requestId);
    }
  }

  /**
   * Cancel all pending permission requests
   */
  cancelAllRequests(): void {
    for (const requestId of this._pendingRequests.keys()) {
      this.cancelRequest(requestId);
    }
  }

  /**
   * Get count of pending permission requests
   */
  getPendingCount(): number {
    return this._pendingRequests.size;
  }

  /**
   * Get all pending requests
   */
  getPendingRequests(): PermissionRequest[] {
    return Array.from(this._pendingRequests.values());
  }

  /**
   * Get a specific pending request by ID (for autonomous mode inspection)
   */
  getPendingRequest(requestId: string): PermissionRequest | undefined {
    return this._pendingRequests.get(requestId);
  }

  /**
   * Reset session access level to initial value
   */
  resetSessionAccessLevel(level: AccessLevel): void {
    this._sessionAccessLevel = level;
    console.log('[Mysti] PermissionManager: Session access level reset to:', level);
  }

  /**
   * Classify risk level based on action type
   */
  static classifyRisk(actionType: PermissionActionType): PermissionRiskLevel {
    switch (actionType) {
      case 'file-read':
        return 'low';
      case 'file-create':
      case 'file-edit':
      case 'web-request':
        return 'medium';
      case 'file-delete':
      case 'bash-command':
      case 'multi-file-edit':
        return 'high';
      default:
        return 'medium';
    }
  }

  /**
   * Get display title for action type
   */
  static getActionTitle(actionType: PermissionActionType): string {
    switch (actionType) {
      case 'file-read':
        return 'Read file';
      case 'file-create':
        return 'Create file';
      case 'file-edit':
        return 'Edit file';
      case 'file-delete':
        return 'Delete file';
      case 'bash-command':
        return 'Run command';
      case 'web-request':
        return 'Web request';
      case 'multi-file-edit':
        return 'Edit multiple files';
      default:
        return 'Perform action';
    }
  }

  /**
   * Register callback for semi-autonomous timeout handling.
   * Called by ChatViewProvider to wire up AutonomousManager decision-making.
   */
  onSemiAutonomousTimeout(
    callback: (requestId: string, postToWebview: (msg: unknown) => void) => void
  ): void {
    this._onSemiAutonomousTimeout = callback;
  }

  /**
   * Resolve a pending permission request after semi-autonomous AI decision.
   * Called by ChatViewProvider after AutonomousManager makes a decision.
   */
  resolveSemiAutonomous(requestId: string, approved: boolean): void {
    const request = this._pendingRequests.get(requestId);
    if (request) {
      request.status = approved ? 'approved' : 'denied';
      this._pendingRequests.delete(requestId);
    }

    const timeoutHandle = this._timeoutHandles.get(requestId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this._timeoutHandles.delete(requestId);
    }

    const resolver = this._resolvers.get(requestId);
    if (resolver) {
      resolver(approved);
      this._resolvers.delete(requestId);
      console.log('[Mysti] PermissionManager: Semi-autonomous resolved:', requestId, approved ? 'approved' : 'denied');
    }
  }

  /**
   * Dispose the manager and clean up all resources
   * Critical: Prevents pending timeouts from firing after deactivation
   */
  dispose(): void {
    console.log('[Mysti] PermissionManager: Disposing and cleaning up resources');

    // Clear all timeout handles
    for (const handle of this._timeoutHandles.values()) {
      clearTimeout(handle);
    }
    this._timeoutHandles.clear();

    // Reject all pending promises
    for (const [, resolver] of this._resolvers) {
      resolver(false);
    }
    this._resolvers.clear();
    this._pendingRequests.clear();
  }

  private _generateId(): string {
    return 'perm_' + randomUUID();
  }
}
