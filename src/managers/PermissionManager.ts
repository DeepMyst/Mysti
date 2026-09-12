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
/**
 * Plan 21 Phase 0 — how long an "always allow" upgrade survives.
 *
 * It used to survive forever: a single click set one process-wide field and
 * every later request in every panel was auto-approved for the life of the
 * window. An upgrade granted for one task must not silently authorise an
 * unrelated one an hour later, so it now expires.
 */
const SESSION_UPGRADE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * One "don't ask again" grant, Plan 27 §25.
 *
 * BEFORE: `always-allow` set the whole scope to `full-access` for an hour, so
 * approving one file edit silently authorised `bash-command`, `file-delete`,
 * `web-request` and `delegate` too — while the button only said "don't ask
 * again this session". That was a consent MISMATCH, not merely a coarse grant:
 * the permission card is the one surface that must not understate what it asks
 * for.
 *
 * NOW: a grant is per ACTION TYPE (§25 option A), and for `bash-command` it is
 * further keyed on the command's leading token (§25 option B) — approving `npm`
 * never approves `curl`. Anything with no recorded grant raises a card.
 */
interface SessionGrant {
  expiresAt: number;
  /**
   * `bash-command` only: the approved leading tokens. A grant with an empty set
   * matches nothing, so the type can never be blanket-approved by accident.
   */
  tokens?: Set<string>;
}

/**
 * The leading token of a shell command — the binary being run.
 *
 * Deliberately conservative: anything that is not a bare `[A-Za-z0-9._/-]+`
 * word returns null, and a null token is NEVER granted and never matches a
 * grant. So a compound command (`npm test && curl evil`), a quoted or
 * substituted binary, or an env-prefixed invocation all fall back to asking.
 * The classifier that decides whether a command is safe at all is
 * SafetyClassifier's job and is unchanged; this only decides whether a card the
 * user already answered can be skipped.
 */
export function bashGrantToken(command: string | undefined): string | null {
  const raw = (command ?? '').trim();
  if (!raw) { return null; }
  // Any shell metacharacter means "more than one thing is happening here".
  if (/[|&;<>(){}$`\\!*?~\n]/.test(raw)) { return null; }
  const first = raw.split(/\s+/)[0];
  if (!first || !/^[A-Za-z0-9._/-]+$/.test(first)) { return null; }
  // `FOO=bar cmd` — an assignment is not a binary.
  if (first.includes('=')) { return null; }
  return first;
}

export class PermissionManager {
  private _disposed = false;
  private _pendingRequests: Map<string, PermissionRequest> = new Map();
  private _resolvers: Map<string, (approved: boolean) => void> = new Map();
  private _timeoutHandles: Map<string, NodeJS.Timeout> = new Map();
  /** The user's configured floor. Upgrades layer on top, per scope. */
  private _baseAccessLevel: AccessLevel;
  /**
   * Per-scope "always allow" upgrades, keyed by the request's `ownerKey`
   * (a panelId for a foreground turn, a jobId for a background one). Scoping
   * this was the fix for an upgrade in one panel authorising writes in every
   * other panel — and for a remote-origin task inheriting an approval the user
   * gave an hour earlier for unrelated local work.
   */
  /** scope -> action type -> grant. Plan 27 §25. */
  private _sessionGrants: Map<string, Map<PermissionActionType, SessionGrant>> = new Map();
  private _config: PermissionConfig;
  private _onSemiAutonomousTimeout: ((requestId: string, postToWebview: (msg: unknown) => void) => void) | null = null;

  /** Scope used when a caller supplies no ownerKey. */
  private static readonly _globalScope = '__global__';

  constructor(initialAccessLevel: AccessLevel) {
    this._baseAccessLevel = initialAccessLevel;
    this._config = this._loadConfig();
  }

  private _scopeKey(ownerKey?: string): string {
    return ownerKey ?? PermissionManager._globalScope;
  }

  /**
   * The access level in force for one scope, expiring a stale upgrade lazily so
   * there is no reaper timer to leak.
   */
  private _effectiveAccessLevel(scope: string): AccessLevel {
    // Session grants are per-action-type now (Plan 27 §25) and no longer raise
    // the scope's access LEVEL. The user's own configured level is the only
    // thing this reports; `_isGranted` answers the per-type question.
    void scope;
    return this._baseAccessLevel;
  }

  /**
   * Has the user already said "don't ask again" for THIS action, in this scope?
   *
   * Expiry is lazy, so there is no reaper timer to leak — the same discipline
   * the scope-wide upgrade used.
   */
  private _isGranted(scope: string, actionType: PermissionActionType, details?: PermissionDetails): boolean {
    const byType = this._sessionGrants.get(scope);
    const grant = byType?.get(actionType);
    if (!grant) { return false; }
    if (Date.now() >= grant.expiresAt) {
      byType?.delete(actionType);
      console.log('[Mysti] PermissionManager: grant expired', scope, actionType);
      return false;
    }
    // §25 option B — a bash grant covers only the binaries already approved.
    if (grant.tokens) {
      const token = bashGrantToken(details?.command);
      return token !== null && grant.tokens.has(token);
    }
    return true;
  }

  /**
   * Drop any upgrade for a scope (all scopes when omitted). Called when a new
   * conversation starts: consent given in a previous conversation is not
   * consent for this one.
   */
  clearSessionUpgrade(ownerKey?: string): void {
    if (ownerKey === undefined) {
      this._sessionGrants.clear();
      return;
    }
    this._sessionGrants.delete(this._scopeKey(ownerKey));
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
    return this._effectiveAccessLevel(PermissionManager._globalScope);
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
    toolCallId?: string,
    ownerKey?: string,
    forceInteractive = false,
    remoteOrigin = false
  ): Promise<boolean> {
    if (this._disposed) { return false; }
    // Plan 21 Phase 0 (I14): a run whose root input contains bytes authored off
    // this machine can never be auto-approved. Folded into forceInteractive so
    // it defeats the session upgrade, the autonomous branch, the
    // semi-autonomous auto-path AND timeout auto-accept in one place — there is
    // no second switch to forget.
    if (remoteOrigin) { forceInteractive = true; }

    // Check if this SCOPE has been upgraded to full-access. Plan 19: a caller
    // may FORCE an interactive card (a non-safe coordinator `bash`) that must
    // be confirmed even under session full-access — the session upgrade grants
    // authority for CLI-backend tools, not for the coordinator's own shell.
    // Two distinct things auto-approve, and conflating them was the bug this
    // replaced. The user's OWN configured access level is a standing choice and
    // still short-circuits everything. A session GRANT is a per-card "don't ask
    // again", and after Plan 27 §25 it covers only the action type the card was
    // about (and, for bash, only that binary).
    if (!forceInteractive) {
      const scope = this._scopeKey(ownerKey);
      if (this._effectiveAccessLevel(scope) === 'full-access') {
        console.log('[Mysti] PermissionManager: Auto-approved (configured full-access)');
        return true;
      }
      if (this._isGranted(scope, actionType, details)) {
        console.log('[Mysti] PermissionManager: Auto-approved (grant for', actionType + ')');
        return true;
      }
    }

    // Ordinary reads need no card; an explicit native approval still does.
    if (actionType === 'file-read' && !forceInteractive) {
      return true;
    }

    // Plan 20 §3.6: reading the canvas is never a privileged act, so a
    // `canvas-read` never raises a card. Guarded by !forceInteractive so this
    // can never become a way around the Plan 19 forced-card invariant.
    if (actionType === 'canvas-read' && !forceInteractive) {
      console.log('[Mysti] PermissionManager: Auto-approved (canvas read)');
      return true;
    }

    // Create permission request
    const now = Date.now();
    const isSemiAutonomous = this._config.timeoutBehavior === 'semi-autonomous';
    const effectiveTimeout = isSemiAutonomous
      ? this._config.semiAutonomousTimeout
      : this._config.timeout;
    const expiresAt = effectiveTimeout > 0 && this._config.timeoutBehavior !== 'require-action'
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
      semiAutonomous: isSemiAutonomous,
      ownerKey,
      forceInteractive,
      remoteOrigin,
    };

    this._pendingRequests.set(request.id, request);

    // Install settlement and cleanup before publishing. Delivery can
    // synchronously answer, cancel, or dispose this request.
    return new Promise((resolve) => {
      this._resolvers.set(request.id, resolve);

      // Set up timeout if configured
      if (effectiveTimeout > 0 && this._config.timeoutBehavior !== 'require-action') {
        const timeoutHandle = setTimeout(() => {
          // Plan 19: a forceInteractive card must never be auto-approved by a
          // timeout — route it through _handleTimeout (which auto-DENIES it),
          // never the semi-autonomous auto-approver.
          if (isSemiAutonomous && !request.forceInteractive && this._onSemiAutonomousTimeout) {
            this._onSemiAutonomousTimeout(request.id, postToWebview);
          } else {
            this._handleTimeout(request.id, postToWebview);
          }
        }, effectiveTimeout * 1000);
        this._timeoutHandles.set(request.id, timeoutHandle);
      }

      try {
        postToWebview({ type: 'permissionRequest', payload: request });
        console.log('[Mysti] PermissionManager: Permission requested:', request.id, title,
          isSemiAutonomous ? '(semi-autonomous)' : '');
      } catch {
        this.cancelRequest(request.id);
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

    // Handle "always-allow" — upgrade THIS SCOPE only, and only for a while.
    // A remote-origin request can never reach here as an always-allow that
    // matters (it was forced interactive), but the guard is explicit so the
    // property does not depend on that reasoning holding elsewhere.
    if (response.decision === 'always-allow' && !request.remoteOrigin && !request.forceInteractive) {
      const scope = this._scopeKey(request.ownerKey);
      const type = request.actionType;

      // §25 option B: a bash grant is keyed on the binary. A command whose
      // leading token cannot be read conservatively (compound, quoted,
      // substituted, env-prefixed) records NOTHING — the user approved this one
      // run, and the next one asks again.
      let tokens: Set<string> | undefined;
      let record = true;
      if (type === 'bash-command') {
        const token = bashGrantToken(request.details?.command);
        if (token === null) {
          // Not a single plain binary. This run stays approved — the user said
          // yes — but nothing is remembered, so the next one asks again.
          record = false;
          console.log('[Mysti] PermissionManager: always-allow not recorded — command is not a single plain binary');
        } else {
          const existing = this._sessionGrants.get(scope)?.get(type);
          tokens = new Set(existing?.tokens ?? []);
          tokens.add(token);
        }
      }

      if (record) {
        let byType = this._sessionGrants.get(scope);
        if (!byType) { byType = new Map(); this._sessionGrants.set(scope, byType); }
        byType.set(type, { expiresAt: Date.now() + SESSION_UPGRADE_TTL_MS, tokens });
        console.log('[Mysti] PermissionManager: granted', type, tokens ? `for ${[...tokens].join(', ')}` : '', 'in scope', scope);
      }
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

    // Determine result based on timeout behavior. Plan 19: a forceInteractive
    // card (un-undoable coordinator side effect) NEVER auto-approves on timeout —
    // it auto-DENIES regardless of timeoutBehavior, so an unattended external
    // tool call / non-safe bash can only run on an explicit user click.
    const approved = !request.forceInteractive && this._config.timeoutBehavior === 'auto-accept';

    // Resolve the promise
    const resolver = this._resolvers.get(requestId);
    if (resolver) {
      resolver(approved);
      this._resolvers.delete(requestId);
      // Log the decision ACTUALLY taken. This previously reported from
      // `timeoutBehavior` alone and so printed "auto-approved" for a forced
      // card that was in fact auto-denied — an audit line that stated the
      // opposite of what happened.
      console.log('[Mysti] PermissionManager: Timeout:', requestId,
        approved ? 'auto-approved' : 'auto-rejected',
        request.forceInteractive ? '(forced card — denied regardless of timeoutBehavior)' : '');
    }

    // Settlement is independent of a webview surviving until the deadline.
    try {
      postToWebview({
        type: 'permissionExpired',
        payload: { requestId, behavior: this._config.timeoutBehavior, approved },
      });
    } catch { /* The owning panel may have closed. */ }
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
   * Cancel only the pending requests owned by `ownerKey` (a panelId for a
   * foreground turn, a jobId for a background Mysti job). Returns the ids of the
   * requests that were cancelled so the caller can dismiss exactly those cards —
   * so Stopping one job / superseding one turn never denies a concurrent job's
   * pending gate. Requests with no ownerKey are left untouched.
   */
  cancelRequestsByOwner(ownerKey: string): string[] {
    const ids: string[] = [];
    for (const [requestId, request] of this._pendingRequests) {
      if (request.ownerKey === ownerKey) {
        ids.push(requestId);
      }
    }
    for (const id of ids) {
      this.cancelRequest(id);
    }
    return ids;
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
    this._baseAccessLevel = level;
    // An explicit reset drops every outstanding upgrade — otherwise lowering
    // the floor would leave a prior "always allow" still auto-approving above it.
    this._sessionGrants.clear();
    console.log('[Mysti] PermissionManager: Session access level reset to:', level);
  }

  /**
   * Classify risk level based on action type
   */
  static classifyRisk(actionType: PermissionActionType): PermissionRiskLevel {
    switch (actionType) {
      // Plan 20 §3.6: canvas ops write `.mysti/canvas/<id>/` only, are fully
      // invertible through the op log, and reach neither a shell nor the
      // network — a design edit is not a source-tree edit, so it does not
      // inherit the source-tree risk labels.
      case 'file-read':
      case 'canvas-read':
      case 'canvas-edit':
        return 'low';
      case 'file-create':
      case 'file-edit':
      case 'web-request':
        return 'medium';
      case 'file-delete':
      case 'bash-command':
      case 'multi-file-edit':
      case 'delegate':
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
      case 'delegate':
        return 'Delegate to a sub-agent';
      case 'canvas-read':
        return 'Read the canvas';
      case 'canvas-edit':
        return 'Edit the canvas';
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
    if (this._disposed) { return; }
    this._disposed = true;
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
    this._sessionGrants.clear();
    this._onSemiAutonomousTimeout = null;
  }

  private _generateId(): string {
    return 'perm_' + randomUUID();
  }
}
