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
 * DeepMyst Connections panel (Plan 04).
 *
 * A standalone editor tab that mirrors DeepMyst's "My Connections" hub: the
 * user's authorized MCP connections (Smithery / Composio, …) with status,
 * "Finish authorizing" for pending OAuth, and Disconnect. Sign in once with a
 * `dm_` key; DeepMyst holds every third-party credential.
 *
 * NOTE: local-CLI wiring is intentionally NOT done here. A user's MCP
 * connections are only reachable by a CLI through an agent broker
 * (/api/v1/mcp/{slug}); there is no per-user CLI-reachable MCP endpoint yet.
 * Rather than auto-provision a hidden agent bridge, this panel is a read +
 * manage surface. McpConfigManager stays in the tree (dormant) for when a
 * first-class per-user broker exists.
 */

import * as vscode from 'vscode';
import type { DeepMystAuthManager } from './DeepMystAuthManager';
import type { McpUserConnection } from '../services/DeepMystClient';
import { getConnectionsContent } from '../webview/connectionsContent';

interface ConnectionsState {
  signedIn: boolean;
  webUrl: string;
  connections: McpUserConnection[];
  connectionsAvailable: boolean;
  /** Set when the list call returned a non-200, non-404 status (auth/principal
   *  problem) so the UI can prompt a re-sign-in rather than show "empty". */
  connectionsError?: string;
  loading: boolean;
  error?: string;
}

export class ConnectionsPanelManager implements vscode.Disposable {
  private _panel: vscode.WebviewPanel | null = null;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _auth: DeepMystAuthManager,
  ) {
    // Re-render on any auth change (sign in/out/key replaced).
    this._disposables.push(
      this._auth.onDidChangeAuth(() => {
        if (this._panel) { void this._refresh(); }
      }),
    );
  }

  /** Open (or reveal) the Connections panel. */
  open(): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    this._panel = vscode.window.createWebviewPanel(
      'mysti.connections',
      'DeepMyst Connections',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [this._extensionUri], retainContextWhenHidden: true },
    );
    this._panel.webview.html = getConnectionsContent(this._panel.webview, this._extensionUri);

    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      undefined,
      this._disposables,
    );
    this._panel.onDidDispose(() => { this._panel = null; }, undefined, this._disposables);

    // Push initial state once the webview signals it is ready (uiReady), with a
    // fallback in case the message is missed.
    void this._refresh();
  }

  dispose(): void {
    this._panel?.dispose();
    this._panel = null;
    for (const d of this._disposables) { d.dispose(); }
    this._disposables.length = 0;
  }

  // ── Messages ────────────────────────────────────────────────────────────────

  private async _handleMessage(msg: { type?: string }): Promise<void> {
    switch (msg?.type) {
      case 'uiReady':
      case 'refresh':
        await this._refresh();
        break;
      case 'signIn':
        await this._auth.signIn();
        // onDidChangeAuth triggers a refresh on success.
        break;
      case 'signOut':
        await this._auth.signOut();
        break;
      case 'manageConnections':
        await vscode.env.openExternal(vscode.Uri.parse(this._connectionsUrl()));
        break;
      case 'createKey':
        // "Enter an API key manually" — fallback to the paste flow.
        await this._auth.enterApiKeyManually();
        break;
      case 'finishAuth':
        await this._finishAuth(msg as { setupUrl?: string });
        break;
      case 'disconnectConnection':
        await this._disconnectConnection(msg as { id?: string; name?: string });
        break;
      default:
        break;
    }
  }

  /** Open a pending connection's OAuth setup URL so the user can authorize it. */
  private async _finishAuth(msg: { setupUrl?: string }): Promise<void> {
    const url = (msg.setupUrl || '').trim();
    // Only open https:// setup URLs (guards against a null/non-HTTPS value).
    if (!/^https:\/\//i.test(url)) {
      await vscode.env.openExternal(vscode.Uri.parse(this._connectionsUrl()));
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Disconnect a user MCP connection (revokes upstream + deletes the row). */
  private async _disconnectConnection(msg: { id?: string; name?: string }): Promise<void> {
    if (!msg.id) { return; }
    const label = msg.name || 'this connection';
    const pick = await vscode.window.showWarningMessage(
      `Disconnect ${label}? This revokes it on the provider and removes it from your DeepMyst account.`,
      { modal: true },
      'Disconnect',
    );
    if (pick !== 'Disconnect') { return; }
    const ok = await this._auth.client.disconnectMcp(msg.id);
    if (!ok) {
      // Read-only / agent-scoped key, or network error — fall back to the web hub.
      vscode.window.showWarningMessage('Could not disconnect from here. Opening DeepMyst to manage it on the web.');
      await vscode.env.openExternal(vscode.Uri.parse(this._connectionsUrl()));
    }
    await this._refresh();
  }

  private _connectionsUrl(): string {
    // DeepMyst's "My Connections" hub (McpConnectionsSettingsPage) lives at
    // /settings/connections — NOT /connections (which 404s).
    return `${this._auth.getWebUrl().replace(/\/+$/, '')}/settings/connections`;
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  private _post(state: ConnectionsState): void {
    this._panel?.webview.postMessage({ type: 'state', payload: state });
  }

  private async _refresh(): Promise<void> {
    if (!this._panel) { return; }

    const signedIn = this._auth.isSignedIn();
    const webUrl = this._auth.getWebUrl();

    if (!signedIn) {
      this._post({ signedIn: false, webUrl, connections: [], connectionsAvailable: true, loading: false });
      return;
    }

    // Signed in: show a loading state, then fetch the user's MCP connections.
    this._post({ signedIn: true, webUrl, connections: [], connectionsAvailable: true, loading: true });

    const res = await this._auth.client.listMcpConnections();
    // A non-200, non-404 status means the key authenticated to the wrong
    // principal or was rejected — surface it so the user re-signs-in rather than
    // mistaking it for an empty account. (A NULL-bound key returns 200+[], which
    // we can't distinguish here; the empty-state copy covers that case.)
    const connectionsError = (res.status && res.status !== 200 && res.status !== 404)
      ? `HTTP ${res.status}`
      : undefined;

    this._post({
      signedIn: true,
      webUrl,
      connections: res.items.filter((c) => c.status !== 'revoked'),
      connectionsAvailable: res.available,
      connectionsError,
      loading: false,
    });
  }
}
