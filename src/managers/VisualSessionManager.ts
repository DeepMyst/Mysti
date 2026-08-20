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
  /**
   * Approve starting a dev server. Called at most once per session, only when a
   * server actually needs spawning. Returning false aborts the look.
   */
  approveDevServer(command: string, source: string): Promise<boolean>;
  /** Where screenshots are written (extension global storage, not the workspace). */
  storageDir(): string;
  /** Workspace root for the dev-server cwd. */
  workspaceRoot(): string;
  /** Ready pattern for dev-server startup detection. */
  readyPattern(): string | undefined;
}

export class VisualSessionManager {
  private _devServer = new DevServerManager();
  private _browser = new BrowserManager();
  private _screenshot = new ScreenshotService();
  private _interaction = new BrowserInteractionService();
  private _sessions = new Map<string, VisualSession>();
  private _idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly _host: SessionHostCallbacks) {}

  /** Is Playwright usable? Probed before anything is spawned. */
  async probe(browser: 'chromium' | 'firefox' | 'webkit' = 'chromium') {
    return this._browser.probe(browser);
  }

  /** The live base URL for a session, if any — pins the origin in the policy resolver. */
  getBaseUrl(key: string): string | undefined {
    return this._sessions.get(key)?.baseUrl;
  }

  hasSession(key: string): boolean {
    return this._sessions.has(key);
  }

  isDevServerRunning(key: string): boolean {
    return this._devServer.isRunning(key);
  }

  /**
   * Look at the app: ensure a warm session, optionally act, then observe.
   *
   * Single-flight per key — a second concurrent look would close the first's
   * browser out from under it (the old manager had no re-entrancy guard at all).
   */
  async look(key: string, resolution: VisualResolution, opts: LookOptions = {}): Promise<VisualObservation> {
    const existing = this._sessions.get(key);
    if (existing?.busy) {
      throw new Error('A visual observation is already in progress for this panel. Wait for it to finish.');
    }

    const probe = await this._browser.probe(resolution.config.browser);
    if (!probe.module || !probe.browser) {
      throw new Error(probe.hint || 'A browser is not available for visual testing.');
    }

    const session = await this._ensureSession(key, resolution);
    session.busy = true;
    const started = Date.now();
    const denials = [...(opts.denials || []), ...resolution.denials];

    try {
      const page = this._browser.getPage(key);
      if (!page) { throw new Error('The browser session was closed unexpectedly.'); }

      // Fresh console/network window for THIS look.
      session.observation.reset();

      // ── Navigate / reload ──
      // `opts.url` is set ONLY when the caller actually named a destination.
      // Falling back to `resolution.config.url` here would silently navigate a
      // bare `look` (documented as "stay on the current page") back to the app
      // root — and would undo an `act` that had just navigated somewhere.
      const targetUrl = opts.url;
      const currentUrl = String(page.url() || '');
      if (targetUrl && this._normalize(currentUrl) !== this._normalize(targetUrl)) {
        if (!isAllowedOrigin(targetUrl, session.allowedOrigins)) {
          throw new Error(`Refusing to open "${targetUrl}" — outside the allowed origins.`);
        }
        await this._browser.navigate(key, targetUrl);
      } else if (opts.reload !== false) {
        // Default to reloading: the caller has almost always just edited code,
        // and a non-HMR server would otherwise re-serve the stale render forever.
        await this._browser.reload(key);
      }

      if (opts.waitFor) {
        await page.waitForSelector(opts.waitFor, { timeout: 10000 })
          .catch(() => { denials.push(`Timed out waiting for "${opts.waitFor}" — captured anyway.`); });
      }

      // ── Optional interactions, then observe the result ──
      const actionsPerformed: string[] = [];
      if (opts.actions && opts.actions.length > 0) {
        await this._runActions(key, session, opts.actions, opts.approveInteractions, actionsPerformed, denials);
      }

      // ── Observe ──
      session.sequence++;
      const selector = opts.selector || resolution.config.elementSelector;
      const mode = opts.mode || resolution.config.screenshotMode;

      const [layout, accessibility, domOutline] = await Promise.all([
        session.observation.probeLayout(page, selector),
        session.observation.accessibilityOutline(page),
        this._screenshot.getDomSnapshot(page).catch(() => ''),
      ]);

      let screenshotPath: string | undefined;
      let screenshotBase64: string | undefined;
      try {
        const shot = await this._screenshot.capture(page, {
          mode,
          elementSelector: selector,
          iteration: session.sequence,
          label: `look-${session.sequence}`,
          outputDir: session.screenshotDir,
        });
        screenshotPath = shot.filePath;
        if (opts.wantImage) { screenshotBase64 = shot.base64Data; }
      } catch (err) {
        denials.push(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      session.lastUsed = Date.now();

      return {
        sequence: session.sequence,
        url: String(page.url() || targetUrl || session.baseUrl),
        browser: session.browser,
        viewport: session.viewport,
        focus: opts.focus,
        selector,
        console: session.observation.consoleEntries,
        network: session.observation.networkFailures,
        layout,
        accessibility: accessibility || undefined,
        domOutline: domOutline || undefined,
        screenshotPath,
        screenshotBase64,
        screenshotAttached: !!screenshotBase64,
        actionsPerformed: actionsPerformed.length ? actionsPerformed : undefined,
        denials: denials.length ? denials : undefined,
        durationMs: Date.now() - started,
        serverReused: !session.ownsDevServer || session.sequence > 1,
      };
    } finally {
      session.busy = false;
      this._armIdleTimer();
    }
  }

  /** Validate, gate and execute a batch of caller-requested interactions. */
  private async _runActions(
    key: string,
    session: VisualSession,
    raw: unknown[],
    approve: ((actions: VisualTestInteraction[]) => Promise<boolean>) | undefined,
    performed: string[],
    denials: string[],
  ): Promise<void> {
    if (session.interactionPolicy === 'off') {
      denials.push('Page interactions are disabled by the user\'s settings.');
      return;
    }

    const normalized: VisualTestInteraction[] = [];
    for (const item of raw.slice(0, VISUAL_MAX_ACTIONS_PER_ACT)) {
      const n = normalizeInteraction(item);
      if (n) { normalized.push(n); }
      else { denials.push(`Ignored an unrecognised action: ${JSON.stringify(item).slice(0, 100)}`); }
    }
    if (raw.length > VISUAL_MAX_ACTIONS_PER_ACT) {
      denials.push(`Only the first ${VISUAL_MAX_ACTIONS_PER_ACT} actions were considered.`);
    }
    if (normalized.length === 0) { return; }

    // No approver supplied means nobody can consent — fail CLOSED.
    const approved = approve ? await approve(normalized) : false;
    if (!approved) {
      denials.push('The user declined the requested page interactions.');
      return;
    }

    const page = this._browser.getPage(key);
    if (!page) { throw new Error('The browser session was closed unexpectedly.'); }
    const ctx: InteractionContext = {
      policy: session.interactionPolicy,
      allowedOrigins: session.allowedOrigins,
      baseUrl: session.baseUrl,
    };

    for (const action of normalized) {
      try {
        await this._interaction.execute(page, action, ctx);
        performed.push(`${action.action}${action.target ? ` ${action.target}` : ''}${action.value ? ` = ${String(action.value).slice(0, 40)}` : ''}`);
      } catch (err) {
        denials.push(`${action.action}${action.target ? ` ${action.target}` : ''} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Get or build the warm session for a key. */
  private async _ensureSession(key: string, resolution: VisualResolution): Promise<VisualSession> {
    const existing = this._sessions.get(key);
    if (existing && this._browser.isOpen(key)) {
      existing.lastUsed = Date.now();
      return existing;
    }
    // A half-dead session (browser gone, entry left behind) must be rebuilt.
    if (existing) { await this.close(key); }

    // ── Dev server ──
    let ownsDevServer = false;
    if (resolution.devCommand && !this._devServer.isRunning(key)) {
      const approved = await this._host.approveDevServer(resolution.devCommand, resolution.devCommandSource);
      if (!approved) {
        throw new Error('Starting the dev server was declined, so there is nothing to look at.');
      }
      const { url } = await this._devServer.start(
        key,
        resolution.devCommand,
        this._host.workspaceRoot(),
        this._host.readyPattern(),
        resolution.config.url,
      );
      ownsDevServer = true;
      // The server may have picked a different port than configured. Honour it,
      // but only if it is still inside the allowlist.
      if (url && url !== resolution.config.url && isAllowedOrigin(url, resolution.allowedOrigins)) {
        const wanted = new URL(resolution.config.url);
        const actual = new URL(url);
        actual.pathname = wanted.pathname;
        actual.search = wanted.search;
        resolution.config.url = actual.toString();
      }
    }

    // ── Browser ──
    await this._browser.launch(key, resolution.config, resolution.allowedOrigins);
    const page = this._browser.getPage(key);

    const observation = new PageObservationService();
    observation.attach(page);

    const session: VisualSession = {
      key,
      baseUrl: new URL(resolution.config.url).origin,
      allowedOrigins: resolution.allowedOrigins,
      interactionPolicy: resolution.interactionPolicy,
      observation,
      ownsDevServer,
      browser: resolution.config.browser,
      viewport: { width: resolution.config.viewportWidth, height: resolution.config.viewportHeight },
      screenshotDir: path.join(this._host.storageDir(), 'visual', this._safeKey(key)),
      sequence: 0,
      lastUsed: Date.now(),
      busy: false,
    };
    this._sessions.set(key, session);
    this._armIdleTimer();
    return session;
  }

  /** Session keys become directory names — never let one escape the storage dir. */
  private _safeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'session';
  }

  /** Compare URLs ignoring a trailing slash, so `/x` and `/x/` don't force a nav. */
  private _normalize(u: string): string {
    try {
      const p = new URL(u);
      return `${p.origin}${p.pathname.replace(/\/$/, '')}${p.search}`;
    } catch {
      return u;
    }
  }

  /**
   * Close a session. A dev server this session started is stopped; one that was
   * already running when we arrived is the user's and is left alone.
   */
  async close(key: string): Promise<void> {
    const session = this._sessions.get(key);
    this._sessions.delete(key);
    await this._browser.close(key).catch(() => { /* best effort */ });
    if (session?.ownsDevServer) {
      await this._devServer.stop(key).catch((err) => {
        console.warn(`[Mysti] Failed to stop visual dev server for ${key}: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  /** Close every session whose key starts with `prefix` (used on panel dispose). */
  async closeForPanel(panelId: string): Promise<void> {
    const keys = Array.from(this._sessions.keys()).filter(k => k === panelId || k.startsWith(`${panelId}:`));
    await Promise.all(keys.map(k => this.close(k)));
  }

  /** Reap idle sessions so a forgotten browser + dev server don't live forever. */
  private _armIdleTimer(): void {
    if (this._idleTimer) { return; }
    this._idleTimer = setInterval(() => {
      const now = Date.now();
      const stale = Array.from(this._sessions.values())
        .filter(s => !s.busy && now - s.lastUsed > VISUAL_SESSION_IDLE_MS)
        .map(s => s.key);
      for (const key of stale) {
        console.log(`[Mysti] Closing idle visual session ${key}`);
        void this.close(key);
      }
      if (this._sessions.size === 0 && this._idleTimer) {
        clearInterval(this._idleTimer);
        this._idleTimer = undefined;
      }
    }, 60_000);
    // Never hold the extension host open for this.
    this._idleTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = undefined;
    }
    await Promise.all(Array.from(this._sessions.keys()).map(k => this.close(k)));
    await this._browser.dispose().catch(() => { /* best effort */ });
    await this._devServer.dispose().catch(() => { /* best effort */ });
    this._sessions.clear();
  }
}
