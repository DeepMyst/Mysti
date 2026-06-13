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
  /** Resolver for a pending deep-link callback, if signIn() is awaiting one. */
  private _pendingCallback: ((key: string) => void) | null = null;

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
   * Interactive sign-in. Opens the DeepMyst web app for Clerk sign-in/sign-up,
   * then accepts the `dm_` key via either the deep-link callback or a paste box.
   * Returns true on success. Never throws.
   */
  async signIn(): Promise<boolean> {
    const webUrl = this.getWebUrl();
    const signInUrl = `${webUrl.replace(/\/+$/, '')}/sign-in`;

    const choice = await vscode.window.showInformationMessage(
      'Sign in to DeepMyst to connect MCP tools. We\'ll open DeepMyst in your browser — sign in (or sign up), then create an API key and paste it here. DeepMyst keeps your connection credentials; Mysti only stores the key.',
      { modal: true },
      'Open DeepMyst & continue',
    );
    if (choice !== 'Open DeepMyst & continue') {
      return false;
    }

    await vscode.env.openExternal(vscode.Uri.parse(signInUrl));

    const key = await vscode.window.showInputBox({
      title: 'DeepMyst API key',
      prompt: `Paste your DeepMyst API key (starts with "${DEEPMYST_KEY_PREFIX}"). Create one in the DeepMyst dashboard under API Keys.`,
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

  /**
   * Complete sign-in from a deep-link callback
   * (`vscode://DeepMyst.mysti/deepmyst-auth?key=dm_...`). Validates + stores.
   */
  async completeSignIn(key: string): Promise<boolean> {
    // Resolve any pending signIn() awaiter first so its flow short-circuits.
    if (this._pendingCallback) {
      this._pendingCallback(key);
      this._pendingCallback = null;
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
