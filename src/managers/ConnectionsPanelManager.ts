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
 * DeepMyst Connections panel (Plan 04 Phase 2).
 *
 * A standalone editor tab showing DeepMyst auth status, the user's connected
 * data sources and agents (each agent exposes an MCP endpoint), and links to
 * manage connections on the DeepMyst web dashboard. It is the surface the user
 * uses to sign in/out and see what tools will be brokered into the local CLIs.
 *
 * The actual MCP-config wiring into each backend CLI is Phase 3; this panel is
 * display + auth + manage-links + refresh.
 */

import * as vscode from 'vscode';
import type { DeepMystAuthManager } from './DeepMystAuthManager';
import { getConnectionsContent } from '../webview/connectionsContent';

interface ConnectionsState {
  signedIn: boolean;
  webUrl: string;
  agents: Array<{ slug: string; name: string; description?: string }>;
  connections: Array<{ id: string; name: string; type?: string; status?: string }>;
  agentsAvailable: boolean;
  connectionsAvailable: boolean;
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
    // Re-render whenever auth state changes (sign in / out from anywhere).
    this._disposables.push(
      this._auth.onDidChangeAuth(() => {
        if (this._panel) {
          void this._refresh();
        }
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
      default:
        break;
    }
  }

  private _connectionsUrl(): string {
    return `${this._auth.getWebUrl().replace(/\/+$/, '')}/connections`;
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
      this._post({
        signedIn: false, webUrl, agents: [], connections: [],
        agentsAvailable: true, connectionsAvailable: true, loading: false,
      });
      return;
    }

    // Signed in: show a loading state, then fetch agents + connections.
    this._post({
      signedIn: true, webUrl, agents: [], connections: [],
      agentsAvailable: true, connectionsAvailable: true, loading: true,
    });

    const client = this._auth.client;
    const [agentsRes, connsRes] = await Promise.all([
      client.listAgents(),
      client.listConnections(),
    ]);

    this._post({
      signedIn: true,
      webUrl,
      agents: agentsRes.items,
      connections: connsRes.items,
      agentsAvailable: agentsRes.available,
      connectionsAvailable: connsRes.available,
      loading: false,
    });
  }
}
