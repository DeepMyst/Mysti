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

/** SecretStorage key under which the DeepMyst API key is stored. */
const SECRET_KEY = 'mysti.deepmyst.apiKey';

export interface DeepMystAuthState {
  signedIn: boolean;
  apiUrl: string;
  webUrl: string;
}

export class DeepMystAuthManager implements vscode.Disposable {
  private readonly _onDidChangeAuth = new vscode.EventEmitter<DeepMystAuthState>();
  /** Fires whenever sign-in state changes (sign in / sign out / key replaced). */
  readonly onDidChangeAuth = this._onDidChangeAuth.event;

  private readonly _client: DeepMystClient;
  private _cachedKey: string | undefined;
  /** Resolver for the in-flight browser sign-in awaiting its callback. */
  private _pendingResolve: ((key: string | null) => void) | null = null;
  /** CSRF state for the in-flight browser sign-in (must match the callback). */
  private _pendingState: string | null = null;

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

    // Arm the pending callback BEFORE opening the browser.
    const keyPromise = new Promise<string | null>((resolve) => {
      this._pendingState = state;
      this._pendingResolve = resolve;
    });

    const opened = await vscode.env.openExternal(vscode.Uri.parse(connectUrl));
    if (!opened) {
      this._clearPending();
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
      (_progress, token) => Promise.race<string | null>([
        keyPromise,
        new Promise<null>((resolve) => token.onCancellationRequested(() => resolve(null))),
        new Promise<null>((resolve) => { timeoutTimer = setTimeout(() => resolve(null), 5 * 60 * 1000); }),
      ]),
    );
    if (timeoutTimer) { clearTimeout(timeoutTimer); }
    this._clearPending();

    if (!key) {
      // Cancelled / timed out / connect page unavailable — offer manual entry.
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
    if (this._pendingResolve) {
      if (this._pendingState && state !== this._pendingState) {
        console.warn('[Mysti] DeepMyst auth callback state mismatch — ignoring.');
        return false;
      }
      // Hand the key to the in-flight signIn(), which validates + stores it.
      const resolve = this._pendingResolve;
      this._clearPending();
      resolve(key);
      return true;
    }
    // No active flow (e.g. a manual deep link) — validate + store directly.
    return this._storeValidatedKey(key.trim());
  }

  /** Manual key entry (the "enter a key manually" affordance). */
  enterApiKeyManually(): Promise<boolean> {
    return this._manualKeyFallback();
  }

  private _clearPending(): void {
    this._pendingResolve = null;
    this._pendingState = null;
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
    this._onDidChangeAuth.fire(this.getState());
    vscode.window.showInformationMessage('Signed in to DeepMyst. Your connected MCP tools are now available.');
    return true;
  }
}
