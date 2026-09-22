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
 * The WARM visual session: a dev server + browser + page kept alive between looks.
 *
 * This is what makes the agent loop viable rather than theoretical. A cold look
 * costs 5-30s (spawn the server, wait for ready, launch Chromium, navigate); a
 * warm one is a reload plus a capture, ~1s. An agent will iterate against a 1s
 * tool and will not against a 30s one, so the session is a correctness property
 * of the feature, not an optimisation.
 *
 * What this class deliberately does NOT do: call a model. The old
 * `VisualTestManager.startVisualTest` drove its own provider stream and consumed
 * `tool_use` chunks itself, which put file edits outside `_shouldGateToolUse` —
 * the extension's only stream-level permission gate. Here the session only ever
 * OBSERVES and hands the observation back to the caller, who fixes things with
 * its own already-gated tools. Deleting the second agent removes the escalation
 * instead of adding another chokepoint to it.
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import { createAbortScope } from '../utils/abortScope';
import { assertVisualOperation, awaitVisualOperation, VisualOperationCancelled, type VisualOperationContext, type VisualSessionTarget } from '../services/VisualOperation';
import { DevServerManager } from './DevServerManager';
import { BrowserManager } from '../services/BrowserManager';
import { ScreenshotService } from '../services/ScreenshotService';
import { BrowserInteractionService, normalizeInteraction, type InteractionContext } from '../services/BrowserInteractionService';
import { PageObservationService } from '../services/PageObservationService';
import { isAllowedOrigin, type InteractionPolicy, type VisualResolution } from '../services/visualTestPolicy';
import {
  VISUAL_SESSION_IDLE_MS,
  VISUAL_MAX_ACTIONS_PER_ACT,
} from '../constants';
import type { VisualObservation, VisualTestInteraction } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface VisualSession {
  key: string;
  resourceKey: string;
  panelId: string;
  ownerKey: string;
  workspaceIdentity: string;
  policyKey: string;
  closing?: Promise<void>;
  baseUrl: string;
  allowedOrigins: string[];
  interactionPolicy: InteractionPolicy;
  observation: PageObservationService;
  /** True when THIS session spawned the dev server (so only it may stop it). */
  ownsDevServer: boolean;
  browser: string;
  viewport: { width: number; height: number };
  screenshotDir: string;
  sequence: number;
  lastUsed: number;
  /** Single-flight guard: a session may only be doing one thing at a time. */
  busy: boolean;
}

export interface LookOptions {
  readonly operation: VisualOperationContext;
  approveDevServer(command: string, source: string): Promise<boolean>;
  /** Absolute URL to show. Must already be policy-resolved and allowlisted. */
  url?: string;
  selector?: string;
  mode?: 'viewport' | 'full-page' | 'element';
  waitFor?: string;
  reload?: boolean;
  focus?: string;
  /** Interactions to perform BEFORE capturing (the `act` path). */
  actions?: unknown[];
  /**
   * Approve the (validated, normalized) interaction batch. Supplied per call,
   * not per session, because the permission card must be posted to the ORIGIN
   * chat panel of THIS request — a session outlives any one turn.
   */
  approveInteractions?: (actions: VisualTestInteraction[]) => Promise<boolean>;
  /** Include the base64 image in the observation (only when the model has vision). */
  wantImage?: boolean;
  denials?: string[];
}

export interface SessionHostCallbacks {
  /** Where screenshots are written (extension global storage, not the workspace). */
  storageDir(): string;
  /** Ready pattern for dev-server startup detection. */
  readyPattern(): string | undefined;
}

interface VisualLease {
  target: VisualSessionTarget;
  operation: VisualOperationContext;
  abort: AbortController;
  session?: VisualSession;
  cleanup?: Promise<void>;
}

export class VisualSessionManager {
  private _devServer = new DevServerManager();
  private _browser = new BrowserManager();
  private _screenshot = new ScreenshotService();
  private _interaction = new BrowserInteractionService();
  private _sessions = new Map<string, VisualSession>();
  private _pendingCleanup = new Set<VisualSession>();
  private _operations = new Map<string, VisualLease>();
  private _idleTimer: NodeJS.Timeout | undefined;
  private _disposed = false;

  constructor(private readonly _host: SessionHostCallbacks) {}

  async probe(browser: 'chromium' | 'firefox' | 'webkit' = 'chromium') { return this._browser.probe(browser); }
  getBaseUrl(key: string, workspaceIdentity?: string): string | undefined {
    const session = this._sessions.get(key);
    return session && (workspaceIdentity === undefined || session.workspaceIdentity === workspaceIdentity) ? session.baseUrl : undefined;
  }
  hasSession(key: string): boolean { return this._sessions.has(key); }
  isDevServerRunning(key: string, workspaceIdentity?: string): boolean {
    const session = this._sessions.get(key);
    return !!session && (workspaceIdentity === undefined || session.workspaceIdentity === workspaceIdentity) && this._devServer.isRunning(session.resourceKey);
  }

  /** Reserve before any await; every resource and late continuation belongs to this exact lease. */
  async look(target: VisualSessionTarget, resolved: VisualResolution, options: LookOptions): Promise<VisualObservation> {
    const supplied = options.operation;
    const parent = supplied && { ...supplied, isCurrent: supplied.isCurrent.bind(supplied) };
    target = { ...target };
    if (!parent || target.panelId !== parent.panelId || target.ownerKey !== parent.ownerKey) {
      throw new Error('Visual session target does not match its captured operation.');
    }
    assertVisualOperation(parent);
    if (this._disposed) { throw new VisualOperationCancelled(); }
    if (this._operations.has(target.cacheKey)) {
      throw new Error('A visual observation is already in progress for this panel. Wait for it to finish.');
    }
    const resolution = structuredClone(resolved);
    const opts = { ...options, actions: options.actions ? structuredClone(options.actions) : undefined };
    const abort = new AbortController();
    const scope = createAbortScope([parent.signal, abort.signal]);
    const lease: VisualLease = {
      target: { ...target }, abort,
      operation: { ...parent, signal: scope.signal,
        isCurrent: () => !this._disposed && parent.isCurrent() && this._operations.get(target.cacheKey) === lease },
    };
    this._operations.set(target.cacheKey, lease);
    const control = lease.operation;
    const onAbort = () => {
      if (lease.session) {
        lease.cleanup ??= this._closeSession(lease.session);
        void lease.cleanup.catch(() => {});
      }
    };
    control.signal.addEventListener('abort', onAbort, { once: true });
    let completed = false;
    try {
      const probe = await awaitVisualOperation(control, () => this._browser.probe(resolution.config.browser));
      if (!probe.module || !probe.browser) { throw new Error(probe.hint || 'A browser is not available for visual testing.'); }
      const session = await this._ensureSession(lease, resolution, opts.approveDevServer);
      assertVisualOperation(control);
      session.busy = true;
      const started = Date.now();
      const denials = [...(opts.denials || []), ...resolution.denials];
      const page = this._browser.getPage(session.resourceKey);
      if (!page) { throw new Error('The browser session was closed unexpectedly.'); }
      session.observation.reset();
      const targetUrl = opts.url;
      if (targetUrl && this._normalize(String(page.url() || '')) !== this._normalize(targetUrl)) {
        if (!isAllowedOrigin(targetUrl, resolution.allowedOrigins)) { throw new Error(`Refusing to open "${targetUrl}" — outside the allowed origins.`); }
        await awaitVisualOperation(control, () => this._browser.navigate(session.resourceKey, targetUrl));
      } else if (opts.reload !== false) {
        await awaitVisualOperation(control, () => this._browser.reload(session.resourceKey));
      }
      if (opts.waitFor) {
        try { await awaitVisualOperation(control, () => page.waitForSelector(opts.waitFor, { timeout: 10000 })); }
        catch (error) {
          assertVisualOperation(control);
          if (error instanceof VisualOperationCancelled) { throw error; }
          denials.push(`Timed out waiting for "${opts.waitFor}" — captured anyway.`);
        }
      }
      const actionsPerformed: string[] = [];
      if (opts.actions?.length) {
        await this._runActions(lease, session, resolution, opts.actions, opts.approveInteractions, actionsPerformed, denials);
      }
      const sequence = session.sequence + 1;
      const selector = opts.selector || resolution.config.elementSelector;
      const mode = opts.mode || resolution.config.screenshotMode;
      const [layout, accessibility, domOutline] = await awaitVisualOperation(control, () => Promise.all([
        session.observation.probeLayout(page, selector), session.observation.accessibilityOutline(page),
        this._screenshot.getDomSnapshot(page).catch(() => ''),
      ]));
      let screenshotPath: string | undefined;
      let screenshotBase64: string | undefined;
      try {
        const shot = await awaitVisualOperation(control, () => this._screenshot.capture(page, {
          mode, elementSelector: selector, iteration: sequence, label: `look-${sequence}`,
          outputDir: session.screenshotDir, control,
        }));
        screenshotPath = shot.filePath;
        if (opts.wantImage) { screenshotBase64 = shot.base64Data; }
      } catch (error) {
        assertVisualOperation(control);
        if (error instanceof VisualOperationCancelled) { throw error; }
        denials.push(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      assertVisualOperation(control);
      session.sequence = sequence;
      session.lastUsed = Date.now();
      completed = true;
      return {
        sequence, url: String(page.url() || targetUrl || session.baseUrl), browser: session.browser,
        viewport: { ...session.viewport }, focus: opts.focus, selector,
        console: [...session.observation.consoleEntries], network: [...session.observation.networkFailures], layout,
        accessibility: accessibility || undefined, domOutline: domOutline || undefined,
        screenshotPath, screenshotBase64, screenshotAttached: !!screenshotBase64,
        actionsPerformed: actionsPerformed.length ? actionsPerformed : undefined,
        denials: denials.length ? denials : undefined, durationMs: Date.now() - started,
        serverReused: !session.ownsDevServer || sequence > 1,
      };
    } catch (error) {
      if (lease.session) { lease.cleanup ??= this._closeSession(lease.session); }
      try { await lease.cleanup; }
      catch (cleanupError) {
        if (error instanceof VisualOperationCancelled || control.signal.aborted) { throw new VisualOperationCancelled(true); }
        throw cleanupError;
      }
      if (error instanceof VisualOperationCancelled && error.cleanupIncomplete) { throw error; }
      assertVisualOperation(control);
      throw error;
    } finally {
      // Remove old parent's kill capability before making a warm session reusable.
      control.signal.removeEventListener('abort', onAbort);
      scope.dispose();
      if (this._operations.get(target.cacheKey) === lease) { this._operations.delete(target.cacheKey); }
      if (completed && lease.session && this._sessions.get(target.cacheKey) === lease.session) { lease.session.busy = false; }
      this._armIdleTimer();
    }
  }

  private async _runActions(
    lease: VisualLease, session: VisualSession, resolution: VisualResolution, raw: unknown[],
    approve: ((actions: VisualTestInteraction[]) => Promise<boolean>) | undefined,
    performed: string[], denials: string[],
  ): Promise<void> {
    const control = lease.operation;
    assertVisualOperation(control);
    if (resolution.interactionPolicy === 'off') { denials.push('Page interactions are disabled by the user\'s settings.'); return; }
    const normalized: VisualTestInteraction[] = [];
    for (const item of raw.slice(0, VISUAL_MAX_ACTIONS_PER_ACT)) {
      const action = normalizeInteraction(item);
      if (action) { normalized.push(action); }
      else { denials.push(`Ignored an unrecognised action: ${JSON.stringify(item).slice(0, 100)}`); }
    }
    if (raw.length > VISUAL_MAX_ACTIONS_PER_ACT) { denials.push(`Only the first ${VISUAL_MAX_ACTIONS_PER_ACT} actions were considered.`); }
    if (!normalized.length) { return; }
    const approved = approve ? await awaitVisualOperation(control, () => approve(structuredClone(normalized))) : false;
    if (!approved) { denials.push('The user declined the requested page interactions.'); return; }
    const page = this._browser.getPage(session.resourceKey);
    if (!page) { throw new Error('The browser session was closed unexpectedly.'); }
    const ctx: InteractionContext = { policy: resolution.interactionPolicy, allowedOrigins: resolution.allowedOrigins, baseUrl: session.baseUrl };
    for (const action of normalized) {
      try {
        await awaitVisualOperation(control, () => this._interaction.execute(page, action, ctx));
        performed.push(`${action.action}${action.target ? ` ${action.target}` : ''}${action.value ? ` = ${String(action.value).slice(0, 40)}` : ''}`);
      } catch (error) {
        assertVisualOperation(control);
        if (error instanceof VisualOperationCancelled) { throw error; }
        denials.push(`${action.action}${action.target ? ` ${action.target}` : ''} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async _ensureSession(lease: VisualLease, resolution: VisualResolution, approve: LookOptions['approveDevServer']): Promise<VisualSession> {
    const { target, operation: control } = lease;
    const policyKey = JSON.stringify([control.workspaceIdentity, control.workspaceRoot, resolution.allowedOrigins,
      resolution.interactionPolicy, resolution.config.browser, resolution.config.headless,
      resolution.config.viewportWidth, resolution.config.viewportHeight]);
    const existing = this._sessions.get(target.cacheKey);
    if (existing && existing.panelId === target.panelId && existing.policyKey === policyKey && this._browser.isOpen(existing.resourceKey)) {
      lease.session = existing;
      existing.ownerKey = target.ownerKey;
      return existing;
    }
    if (existing) { await awaitVisualOperation(control, () => this._closeSession(existing)); }
    assertVisualOperation(control);
    const session: VisualSession = {
      key: target.cacheKey, resourceKey: `visual-resource-${randomUUID()}`, panelId: target.panelId, ownerKey: target.ownerKey,
      workspaceIdentity: control.workspaceIdentity, policyKey,
      baseUrl: new URL(resolution.config.url).origin, allowedOrigins: [...resolution.allowedOrigins],
      interactionPolicy: resolution.interactionPolicy, observation: new PageObservationService(), ownsDevServer: false,
      browser: resolution.config.browser, viewport: { width: resolution.config.viewportWidth, height: resolution.config.viewportHeight },
      screenshotDir: path.join(this._host.storageDir(), 'visual', this._safeKey(target.cacheKey)),
      sequence: 0, lastUsed: Date.now(), busy: true,
    };
    lease.session = session;
    const readyPattern = this._host.readyPattern();
    if (resolution.devCommand && resolution.devCommandSource !== 'already-running') {
      const approved = await awaitVisualOperation(control, () => approve(resolution.devCommand!, resolution.devCommandSource));
      if (!approved) { throw new Error('Starting the dev server was declined, so there is nothing to look at.'); }
      session.ownsDevServer = true;
      const { url } = await awaitVisualOperation(control, () => this._devServer.start(session.resourceKey, resolution.devCommand!,
        control.workspaceRoot, readyPattern, resolution.config.url, control), () => this._devServer.stop(session.resourceKey));
      assertVisualOperation(control);
      if (url && url !== resolution.config.url && isAllowedOrigin(url, resolution.allowedOrigins)) {
        const wanted = new URL(resolution.config.url); const actual = new URL(url);
        actual.pathname = wanted.pathname; actual.search = wanted.search; resolution.config.url = actual.toString();
      }
    }
    await awaitVisualOperation(control, () => this._browser.launch(session.resourceKey, resolution.config, resolution.allowedOrigins, control),
      () => this._browser.close(session.resourceKey));
    assertVisualOperation(control);
    session.baseUrl = new URL(resolution.config.url).origin;
    session.observation.attach(this._browser.getPage(session.resourceKey));
    this._sessions.set(target.cacheKey, session);
    return session;
  }

  private _safeKey(key: string): string { return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'session'; }
  private _normalize(url: string): string {
    try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`; }
    catch { return url; }
  }

  private _closeSession(session: VisualSession): Promise<void> {
    if (session.closing) { return session.closing; }
    if (this._sessions.get(session.key) === session) { this._sessions.delete(session.key); }
    this._pendingCleanup.add(session);
    session.closing = Promise.all([
      this._browser.close(session.resourceKey),
      session.ownsDevServer ? this._devServer.stop(session.resourceKey) : Promise.resolve(),
    ]).then(() => { this._pendingCleanup.delete(session); }, error => {
      session.closing = undefined;
      throw error;
    });
    return session.closing;
  }

  async cancelOwner(ownerKey: string): Promise<void> {
    const leases = [...this._operations.values()].filter(lease => lease.target.ownerKey === ownerKey);
    const warm = [...new Set([...this._sessions.values(), ...this._pendingCleanup])].filter(session => session.ownerKey === ownerKey
      && (!this._operations.has(session.key) || this._operations.get(session.key)?.target.ownerKey === ownerKey));
    for (const lease of leases) { lease.abort.abort(); }
    await Promise.all([...leases.map(lease => lease.cleanup), ...warm.map(session => this._closeSession(session))]);
  }

  async close(key: string): Promise<void> {
    const lease = this._operations.get(key);
    lease?.abort.abort();
    const sessions = new Set([...this._pendingCleanup].filter(session => session.key === key));
    const session = this._sessions.get(key);
    if (session) { sessions.add(session); }
    await Promise.all([lease?.cleanup, ...[...sessions].map(value => this._closeSession(value))]);
  }

  async closeForPanel(panelId: string): Promise<void> {
    const keys = new Set([
      ...[...this._operations.values()].filter(lease => lease.target.panelId === panelId).map(lease => lease.target.cacheKey),
      ...[...this._sessions.values(), ...this._pendingCleanup].filter(session => session.panelId === panelId).map(session => session.key),
    ]);
    await Promise.all([...keys].map(key => this.close(key)));
  }

  private _armIdleTimer(): void {
    if (this._idleTimer || this._disposed || !this._sessions.size) { return; }
    this._idleTimer = setInterval(() => {
      const now = Date.now();
      for (const session of this._sessions.values()) {
        if (!this._operations.has(session.key) && now - session.lastUsed > VISUAL_SESSION_IDLE_MS) {
          void this._closeSession(session).catch(error => console.warn('[Mysti] Visual idle cleanup failed:', error));
        }
      }
      if (!this._sessions.size && this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = undefined; }
    }, 60_000);
    this._idleTimer.unref?.();
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = undefined; }
    const keys = new Set([...this._operations.keys(), ...this._sessions.keys(), ...[...this._pendingCleanup].map(session => session.key)]);
    const closed = await Promise.allSettled([...keys].map(key => this.close(key)));
    // A browser may return only after its aborted lease was released. Its
    // runtime manager owns that late handle even when no warm session exists.
    const runtimes = await Promise.allSettled([this._browser.dispose(), this._devServer.dispose()]);
    const failed = [...closed, ...runtimes].find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') { throw failed.reason; }
  }
}
