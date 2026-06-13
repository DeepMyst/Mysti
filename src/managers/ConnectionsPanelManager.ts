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
import { McpConfigManager } from '../services/McpConfigManager';
import type { McpServerSpec, McpApplyResult } from '../services/McpConfigManager';
import { getConnectionsContent } from '../webview/connectionsContent';

/** globalState key: agent slugs the user enabled for the local CLIs. */
const ENABLED_AGENTS_KEY = 'mysti.deepmyst.enabledAgents';

interface ConnectionsState {
  signedIn: boolean;
  webUrl: string;
  agents: Array<{ slug: string; name: string; description?: string }>;
  connections: Array<{ id: string; name: string; type?: string; status?: string }>;
  enabledAgents: string[];
  mcpProviders: string[];
  mcpStatus: McpApplyResult[];
  agentsAvailable: boolean;
  connectionsAvailable: boolean;
  loading: boolean;
  error?: string;
}

export class ConnectionsPanelManager implements vscode.Disposable {
  private _panel: vscode.WebviewPanel | null = null;
  private readonly _disposables: vscode.Disposable[] = [];
  private _lastMcpStatus: McpApplyResult[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _auth: DeepMystAuthManager,
    private readonly _mcpConfig: McpConfigManager,
    private readonly _context: vscode.ExtensionContext,
  ) {
    // On any auth change: reconcile the CLI MCP configs (apply enabled agents
    // when signed in, strip them on sign-out) and re-render if the panel is open.
    this._disposables.push(
      this._auth.onDidChangeAuth(() => {
        void this._reconcileMcpConfig().finally(() => {
          if (this._panel) { void this._refresh(); }
        });
      }),
    );
  }

  /**
   * Reconcile CLI MCP configs to the current auth + enabled-agents state. Call
   * once at activation (after auth.initialize) so a returning signed-in user's
   * configs are kept in sync without opening the panel.
   */
  async reconcileMcpConfig(): Promise<void> {
    await this._reconcileMcpConfig();
  }

  /** Build the DeepMyst MCP server specs for the currently-enabled agents. */
  private _buildSpecs(): McpServerSpec[] {
    const key = this._auth.getApiKey();
    if (!this._auth.isSignedIn() || !key) {
      return [];
    }
    return this._enabledAgents().map((slug) => ({
      id: `deepmyst-${slug}`,
      url: this._auth.client.getMcpEndpointUrl(slug),
      headers: { Authorization: `Bearer ${key}` },
    }));
  }

  private _enabledAgents(): string[] {
    return this._context.globalState.get<string[]>(ENABLED_AGENTS_KEY, []);
  }

  private async _setEnabledAgents(slugs: string[]): Promise<void> {
    await this._context.globalState.update(ENABLED_AGENTS_KEY, slugs);
  }

  private async _reconcileMcpConfig(): Promise<void> {
    try {
      const specs = this._buildSpecs();
      this._lastMcpStatus = specs.length > 0 || this._auth.isSignedIn()
        ? await this._mcpConfig.applyAll(specs)
        : await this._mcpConfig.removeAll();
    } catch (err) {
      console.log('[Mysti] MCP config reconcile error:', err);
    }
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
      case 'toggleAgent':
        await this._toggleAgent(msg as { slug?: string; enabled?: boolean });
        break;
      default:
        break;
    }
  }

  /** Enable/disable an agent's tools in the local CLIs (writes MCP config). */
  private async _toggleAgent(msg: { slug?: string; enabled?: boolean }): Promise<void> {
    if (!msg.slug) { return; }
    const set = new Set(this._enabledAgents());
    if (msg.enabled) { set.add(msg.slug); } else { set.delete(msg.slug); }
    await this._setEnabledAgents([...set]);
    await this._reconcileMcpConfig();
    await this._refresh();
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
    const mcpProviders = McpConfigManager.supportedProviders();

    if (!signedIn) {
      this._post({
        signedIn: false, webUrl, agents: [], connections: [],
        enabledAgents: [], mcpProviders, mcpStatus: this._lastMcpStatus,
        agentsAvailable: true, connectionsAvailable: true, loading: false,
      });
      return;
    }

    // Signed in: show a loading state, then fetch agents + connections.
    this._post({
      signedIn: true, webUrl, agents: [], connections: [],
      enabledAgents: this._enabledAgents(), mcpProviders, mcpStatus: this._lastMcpStatus,
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
      enabledAgents: this._enabledAgents(),
      mcpProviders,
      mcpStatus: this._lastMcpStatus,
      agentsAvailable: agentsRes.available,
      connectionsAvailable: connsRes.available,
      loading: false,
    });
  }
}
