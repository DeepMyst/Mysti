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
 * DeepMyst authentication (Plan 04 — DeepMyst-brokered MCP connections).
 *
 * Sign-in flow:
 *   1. User clicks "Sign in to DeepMyst" → we open the DeepMyst web app
 *      (Clerk sign-up / sign-in) in the browser.
 *   2. The user signs in and either (a) is deep-linked back to
 *      `vscode://DeepMyst.mysti/deepmyst-auth?key=dm_...` (handled by the
 *      extension's UriHandler → completeSignIn), or (b) copies a `dm_` API key
 *      from the DeepMyst dashboard and pastes it into the input box we show.
 *   3. We validate the key against DeepMyst and store it in SecretStorage.
 *
 * The `dm_` key is the only credential Mysti holds; DeepMyst keeps every
 * third-party connection credential server-side.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  DeepMystClient,
  isPlausibleDeepMystKey,
  DEEPMYST_KEY_PREFIX,
  DEEPMYST_DEFAULT_API_URL,
  DEEPMYST_DEFAULT_WEB_URL,
} from '../services/DeepMystClient';
import type { EntitlementState } from '../types';
import { SMART_GATEWAY_DEFAULT_URL, SMART_ENTITLEMENT_TTL_MS, SMART_ENTITLEMENT_ERROR_TTL_MS } from '../constants';

/** SecretStorage key under which the DeepMyst API key is stored. */
const SECRET_KEY = 'mysti.deepmyst.apiKey';

export interface DeepMystAuthState {
  signedIn: boolean;
  apiUrl: string;
  webUrl: string;
}

/**
 * Outcome handed to an in-flight `signIn()` waiter: the `dm_` key from the
 * link-back, `null` (cancelled / timed out), `'superseded'` when a different
 * tab/attempt completed the sign-in first, or `'failed'` when the page reported
 * an error (both yield silently, no manual fallback).
 */
type SignInResult = string | null | 'superseded' | 'failed';

export class DeepMystAuthManager implements vscode.Disposable {
  private readonly _onDidChangeAuth = new vscode.EventEmitter<DeepMystAuthState>();
  /** Fires whenever sign-in state changes (sign in / sign out / key replaced). */
  readonly onDidChangeAuth = this._onDidChangeAuth.event;

  private readonly _client: DeepMystClient;
  private _cachedKey: string | undefined;
  /** Cached entitlement (tier + free-monthly allowance) for smart compaction. */
  private _entitlement: EntitlementState | undefined;
  private _entitlementRefresh: Promise<EntitlementState> | undefined;
  /**
   * In-flight browser sign-ins, keyed by their CSRF `state` → resolver. A user
   * may click "Sign in" several times (e.g. while the browser/Clerk is slow),
   * opening several tabs each with its own `state`. We track every attempt so a
   * link-back from ANY of those tabs completes the flow and supersedes the rest
   * — instead of the old single-slot model, where each new click overwrote the
   * previous state and a link-back from an earlier tab was rejected as a
   * mismatch (leaving every "Waiting…" notification stuck forever).
   */
  private readonly _pending = new Map<string, (result: SignInResult) => void>();

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._client = new DeepMystClient(
      () => this._cachedKey,
      () => this.getApiUrl(),
    );
  }

  /** Load the stored key into memory. Call once during activation. */
  async initialize(): Promise<void> {
    this._cachedKey = await this._context.secrets.get(SECRET_KEY);
  }

  dispose(): void {
    this._onDidChangeAuth.dispose();
  }

  // ── Config ────────────────────────────────────────────────────────────────

  getApiUrl(): string {
    const v = vscode.workspace.getConfiguration('mysti').get<string>('deepmyst.apiUrl', '').trim();
    return v || DEEPMYST_DEFAULT_API_URL;
  }

  getWebUrl(): string {
    const v = vscode.workspace.getConfiguration('mysti').get<string>('deepmyst.webUrl', '').trim();
    return v || DEEPMYST_DEFAULT_WEB_URL;
  }

  /** The DeepMyst LLM gateway base URL (smart compaction; distinct from the MCP/REST apiUrl). */
  getGatewayUrl(): string {
    const v = vscode.workspace.getConfiguration('mysti').get<string>('deepmyst.gatewayUrl', '').trim();
    return v || SMART_GATEWAY_DEFAULT_URL;
  }

  /** The shared API client (key + URL injected). */
  get client(): DeepMystClient {
    return this._client;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  isSignedIn(): boolean {
    return isPlausibleDeepMystKey(this._cachedKey);
  }

  /** The current API key, or undefined when signed out. */
  getApiKey(): string | undefined {
    return this._cachedKey;
  }

  getState(): DeepMystAuthState {
    return { signedIn: this.isSignedIn(), apiUrl: this.getApiUrl(), webUrl: this.getWebUrl() };
  }

  // ── Entitlement (Plan 08 smart compaction) ──────────────────────────────────

  /** The last-checked entitlement snapshot (for the savings UI), if any. */
  getEntitlement(): EntitlementState | undefined {
    return this._entitlement;
  }

  /**
   * Synchronous gate for premium features. FAILS CLOSED: true only when the
   * DeepMyst endpoint itself said so. With no answer yet, or only a failed
   * check, it is false and a background refresh is started. A stale server
   * answer is still honored while that refresh runs, so an entitled user is
   * not flipped off every TTL. The gateway has no credit check of its own, so
   * this is the only gate in front of platform-key spend.
   */
  hasEntitlement(): boolean {
    if (!this.isSignedIn()) { return false; }
    const e = this._entitlement;
    if (!e || !this._isEntitlementFresh(e)) {
      this._entitlementRefresh ??= this.ensureActiveAccount().finally(() => { this._entitlementRefresh = undefined; });
    }
    return !!e && e.source === 'endpoint' && e.entitled;
  }

  private _isEntitlementFresh(e: EntitlementState): boolean {
    const ttl = e.source === 'endpoint' ? SMART_ENTITLEMENT_TTL_MS : SMART_ENTITLEMENT_ERROR_TTL_MS;
    return Date.now() - e.checkedAt < ttl;
  }

  /**
   * Check the user's entitlement against DeepMyst (GET /api/v1/me/entitlement).
   * A server answer is cached for SMART_ENTITLEMENT_TTL_MS. Anything else — a
   * 404, a 5xx, a timeout, a network error — is NOT entitled (source
   * 'fallback') and is retried after SMART_ENTITLEMENT_ERROR_TTL_MS. Never throws.
   */
  async ensureActiveAccount(force = false): Promise<EntitlementState> {
    if (!this.isSignedIn()) {
      this._entitlement = { entitled: false, tier: 'signed-out', source: 'fallback', checkedAt: Date.now() };
      return this._entitlement;
    }
    if (!force && this._entitlement && this._isEntitlementFresh(this._entitlement)) {
      return this._entitlement;
    }
    const key = this._cachedKey as string;
    const base = this.getApiUrl().replace(/\/+$/, '');
    // Never send the dm_ key to a non-DeepMyst host (a workspace could try to
    // override apiUrl). On an untrusted host, deny rather than leak the key.
    if (!isDeepMystHost(base)) {
      this._entitlement = { entitled: false, tier: 'untrusted-host', source: 'fallback', checkedAt: Date.now() };
      return this._entitlement;
    }
    try {
      const res = await fetch(`${base}/api/v1/me/entitlement`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const o = await res.json() as Record<string, unknown>;
        const tier = typeof o.tier === 'string' ? o.tier : 'free';
        const freeRemaining = numOrUndef(o.free_remaining ?? o.freeRemaining);
        const freeLimit = numOrUndef(o.free_limit ?? o.freeLimit);
        // Prefer the server's explicit `entitled`; otherwise derive (paid tier
        // OR a positive credit balance). A missing balance is not a yes.
        const entitled = typeof o.entitled === 'boolean'
          ? o.entitled
          : ((tier !== 'free' && tier !== 'signed-out') || (freeRemaining !== undefined && freeRemaining > 0));
        this._entitlement = {
          entitled,
          tier,
          freeRemaining,
          freeLimit,
          source: 'endpoint',
          checkedAt: Date.now(),
        };
      } else if (res.status === 401 || res.status === 403) {
        // Hard DENY on an auth failure — the key is invalid/unentitled. Never
        // fail-open on a rejected key (only on a not-deployed / unreachable endpoint).
        this._entitlement = { entitled: false, tier: 'unauthorized', source: 'endpoint', checkedAt: Date.now() };
      } else {
        // 404 / 5xx: no answer, so no entitlement. Retried after the error TTL.
        this._entitlement = { entitled: false, tier: 'unavailable', source: 'fallback', checkedAt: Date.now() };
      }
    } catch {
      this._entitlement = { entitled: false, tier: 'unavailable', source: 'fallback', checkedAt: Date.now() };
    }
    this._onDidChangeAuth.fire(this.getState());
    return this._entitlement;
  }

  // ── Sign-in / sign-out ──────────────────────────────────────────────────────

  /**
   * Interactive sign-in — Claude-Code-style browser flow with automatic
   * link-back (no manual key copy/paste in the happy path):
   *   1. We build a callback URI that routes back to this extension's URI
   *      handler (via vscode.env.asExternalUri, so it works in desktop AND
   *      remote/web VS Code) and a random `state` nonce (CSRF guard).
   *   2. We open `${webUrl}/connect/vscode?redirect_uri=...&state=...`. DeepMyst
   *      authenticates the user with Clerk, mints a `dm_` API key for them, and
   *      redirects to the callback with `?key=dm_...&state=...`.
   *   3. The URI handler calls completeSignIn(key, state); we match the state,
   *      validate the key against DeepMyst, and store it.
   * If the browser round-trip doesn't complete (e.g. the connect page isn't
   * deployed yet, or the user cancels), we fall back to manual key entry.
   * Returns true on success. Never throws.
   */
  async signIn(): Promise<boolean> {
    const webUrl = this.getWebUrl().replace(/\/+$/, '');

    // Callback URI back into this extension (desktop + remote safe).
    let redirectUri: vscode.Uri;
    try {
      redirectUri = await vscode.env.asExternalUri(
        vscode.Uri.parse(`${vscode.env.uriScheme}://DeepMyst.mysti/deepmyst-auth`),
      );
    } catch {
      // asExternalUri can fail in odd hosts; fall back to the static scheme.
      redirectUri = vscode.Uri.parse('vscode://DeepMyst.mysti/deepmyst-auth');
    }

    const state = crypto.randomBytes(16).toString('hex');
    const connectUrl =
      `${webUrl}/connect/vscode?redirect_uri=${encodeURIComponent(redirectUri.toString(true))}&state=${state}`;

    // Arm THIS attempt's callback BEFORE opening the browser. Multiple concurrent
    // attempts coexist in the map; the link-back from any of them completes.
    let resolveKey!: (result: SignInResult) => void;
    const keyPromise = new Promise<SignInResult>((resolve) => { resolveKey = resolve; });
    this._pending.set(state, resolveKey);
    console.log(`[Mysti] DeepMyst sign-in armed: state=${state.slice(0, 8)}… redirect=${redirectUri.toString(true)} (in-flight=${this._pending.size})`);

    const opened = await vscode.env.openExternal(vscode.Uri.parse(connectUrl));
    if (!opened) {
      this._pending.delete(state);
      return this._manualKeyFallback('Could not open the browser. Paste your DeepMyst API key instead.');
    }

    // Wait for the link-back (cancellable; times out after 5 minutes).
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const key = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
        title: 'Waiting for DeepMyst sign-in in your browser…',
      },
      (_progress, token) => Promise.race<SignInResult>([
        keyPromise,
        new Promise<null>((resolve) => token.onCancellationRequested(() => resolve(null))),
        new Promise<null>((resolve) => { timeoutTimer = setTimeout(() => resolve(null), 5 * 60 * 1000); }),
      ]),
    );
    if (timeoutTimer) { clearTimeout(timeoutTimer); }
    this._pending.delete(state);

    if (key === 'superseded' || key === 'failed') {
      // Another tab completed sign-in, or failSignIn already told the user why;
      // close this notification silently.
      console.log(`[Mysti] DeepMyst sign-in: attempt state=${state.slice(0, 8)}… ${key}.`);
      return this.isSignedIn();
    }
    if (!key) {
      // Cancelled / timed out. If another attempt is still mid-flight, don't pop
      // a manual-entry box on top of it; otherwise offer manual entry.
      if (this._pending.size > 0 || this.isSignedIn()) { return this.isSignedIn(); }
      return this._manualKeyFallback();
    }
    return this._storeValidatedKey(key.trim());
  }

  /**
   * Complete sign-in from the browser link-back
   * (`<scheme>://DeepMyst.mysti/deepmyst-auth?key=dm_...&state=...`). When a
   * browser flow is in progress it must carry the matching `state` (CSRF
   * guard); an unsolicited deep link with a valid key is still honored.
   */
  async completeSignIn(key: string, state?: string): Promise<boolean> {
    if (this._pending.size > 0) {
      // Accept the callback only if its `state` matches one of OUR in-flight
      // attempts (CSRF guard) — but match ANY of them, since the user may have
      // clicked "Sign in" several times and completed an earlier tab. Without
      // this, a link-back from any tab but the most recent was rejected and the
      // sign-in hung indefinitely.
      const matched = state && this._pending.has(state) ? state : undefined;
      if (!matched) {
        console.warn(`[Mysti] DeepMyst callback state=${(state ?? '∅').slice(0, 8)}… matched none of ${this._pending.size} in-flight attempt(s) — ignoring (stale tab or CSRF).`);
        return false;
      }
      const resolve = this._pending.get(matched)!;
      // Supersede the other in-flight attempts so their "Waiting…" notifications
      // close cleanly (no manual-entry prompt for the abandoned tabs).
      for (const [s, r] of this._pending) {
        if (s !== matched) { r('superseded'); }
      }
      this._pending.clear();
      console.log(`[Mysti] DeepMyst callback accepted: state=${matched.slice(0, 8)}….`);
      resolve(key);
      return true;
    }
    // No active flow (e.g. a manual/unsolicited deep link) — validate + store.
    console.log('[Mysti] DeepMyst callback with no in-flight attempt — validating directly.');
    return this._storeValidatedKey(key.trim());
  }

  /**
   * The browser page reported a failure (`?error=...&state=...`). Show it and
   * end the matching attempt now — otherwise "Waiting…" spins for 5 minutes and
   * then asks for a key the same account could not mint either. An unmatched
   * state only shows the message (CSRF guard, as in completeSignIn).
   */
  failSignIn(error: string, state?: string): void {
    vscode.window.showErrorMessage(`DeepMyst sign-in failed: ${error}`);
    if (state) { this._pending.get(state)?.('failed'); }
  }

  /** Manual key entry (the "enter a key manually" affordance). */
  enterApiKeyManually(): Promise<boolean> {
    return this._manualKeyFallback();
  }

  /** Manual key entry — fallback when the browser link-back can't complete. */
  private async _manualKeyFallback(message?: string): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: 'DeepMyst API key',
      prompt: message
        ?? `Paste your DeepMyst API key (starts with "${DEEPMYST_KEY_PREFIX}"). Create one in the DeepMyst dashboard under API Keys.`,
      placeHolder: `${DEEPMYST_KEY_PREFIX}...`,
      ignoreFocusOut: true,
      password: true,
      validateInput: (value) => {
        const v = value.trim();
        if (!v) { return 'Enter your DeepMyst API key.'; }
        if (!isPlausibleDeepMystKey(v)) { return `Key must start with "${DEEPMYST_KEY_PREFIX}".`; }
        return undefined;
      },
    });
    if (!key) {
      return false;
    }
    return this._storeValidatedKey(key.trim());
  }

  async signOut(): Promise<void> {
    await this._context.secrets.delete(SECRET_KEY);
    this._cachedKey = undefined;
    this._entitlement = undefined;
    this._onDidChangeAuth.fire(this.getState());
    vscode.window.showInformationMessage('Signed out of DeepMyst.');
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async _storeValidatedKey(key: string): Promise<boolean> {
    if (!isPlausibleDeepMystKey(key)) {
      vscode.window.showErrorMessage(`That doesn't look like a DeepMyst key (expected "${DEEPMYST_KEY_PREFIX}…").`);
      return false;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Verifying DeepMyst key…' },
      () => this._client.validateKey(key),
    );
    if (!result.valid) {
      vscode.window.showErrorMessage(`DeepMyst sign-in failed: ${result.error ?? 'invalid key'}`);
      return false;
    }
    await this._context.secrets.store(SECRET_KEY, key);
    this._cachedKey = key;
    this._entitlement = undefined;   // re-check entitlement for the new key
    this._onDidChangeAuth.fire(this.getState());
    vscode.window.showInformationMessage('Signed in to DeepMyst. Your connected MCP tools are now available.');
    return true;
  }
}

/** Narrow an unknown JSON value to a finite number, else undefined. */
function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Only send the dm_ key to DeepMyst (or localhost for dev). */
function isDeepMystHost(urlStr: string): boolean {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return h === 'deepmyst.com' || h.endsWith('.deepmyst.com') || h === 'localhost' || h === '127.0.0.1';
  } catch {
    return false;
  }
}
