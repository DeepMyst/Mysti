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
 * Plan 39 — Manage Plugins: the editor tab that lists, installs, toggles,
 * updates and removes plugins for each backend through its own CLI.
 *
 * The webview is untrusted input. Every id, scope, name and source it sends is
 * checked against what the CLI last reported before anything spawns, and the
 * install gate is a NATIVE modal the webview cannot answer. Only a human
 * clicking in this tab reaches a mutation — no chat, directive or tool does.
 */

import * as vscode from 'vscode';
import type { ICliProvider } from '../providers/base/IProvider';
import type { ProviderType } from '../types';
import { PLUGIN_ADAPTERS, PluginCliError, isAdapter, runCli } from '../services/plugins/PluginAdapters';
import type {
  Approval, CatalogPlugin, CodeParts, Marketplace, PluginAdapter, PluginBackend,
  PluginListing, PluginScope, Run, RunResult,
} from '../services/plugins/PluginAdapters';
import { getPluginsContent } from '../webview/pluginsContent';

export interface PluginsViewState {
  backends: { id: string; name: string; status: 'ok' | 'note' | 'none' | 'missing'; note?: string; version?: string }[];
  selected: string;
  note?: string;
  scopes: PluginScope[];
  can: { toggle: boolean; update: boolean; uninstall: boolean; details: boolean; marketplaces: boolean; search: boolean };
  trusted: boolean;
  loading: boolean;
  listing?: PluginListing;
  search?: { query: string; results: CatalogPlugin[] };
  markets?: Marketplace[];
  /** Keyed by plugin id, or `mkt:<name>` for a marketplace row. */
  busy: Record<string, string>;
  rowErrors: Record<string, string>;
  banner?: string;
  error?: string;
  details?: { id: string; text: string };
}

interface ProviderSource {
  getProviderInstance(id: string): ICliProvider | undefined;
  getAllProviderIds(): ProviderType[];
}

type CliRunner = (cliPath: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<RunResult>;

type Msg = { type?: unknown; [key: string]: unknown };

const SCOPE_PHRASE: Record<PluginScope, string> = { user: 'for you', project: 'for this project', local: 'for you in this repo' };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PluginsPanelManager implements vscode.Disposable {
  /** Every posted state also goes here (tests read it). */
  public onState?: (state: PluginsViewState) => void;

  private _panel: vscode.WebviewPanel | null = null;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _adapters: Record<string, PluginBackend>;
  private readonly _runCli: CliRunner;
  private _selected = '';

  // Per backend: what its CLI last said.
  private readonly _listing = new Map<string, PluginListing>();
  private readonly _markets = new Map<string, Marketplace[]>();
  private readonly _search = new Map<string, { query: string; results: CatalogPlugin[] }>();
  private readonly _errors = new Map<string, string>();
  private readonly _missing = new Set<string>();
  private readonly _loading = new Set<string>();
  /** One mutation at a time per backend: two installs write the same state files. */
  private readonly _queue = new Map<string, Promise<void>>();
  // Keyed `${backend}\n${rowKey}`.
  private readonly _busy = new Map<string, string>();
  private readonly _rowErrors = new Map<string, string>();
  private _banner?: string;
  private _details?: { backend: string; id: string; text: string };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _providers: ProviderSource,
    deps: { adapters?: Record<string, PluginBackend>; run?: CliRunner } = {},
  ) {
    this._adapters = deps.adapters ?? PLUGIN_ADAPTERS;
    this._runCli = deps.run ?? runCli;
  }

  /** Open (or reveal) the tab, on `backend` when it has plugins Mysti can manage. */
  open(backend?: string): void {
    if (backend && this._adapterFor(backend)) { this._selected = backend; }
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Active);
      void this.handleMessage({ type: 'refresh' });
      return;
    }
    this._panel = vscode.window.createWebviewPanel(
      'mysti.plugins', 'Manage Plugins', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media', 'plugins')], retainContextWhenHidden: true },
    );
    this._panel.webview.html = getPluginsContent(this._panel.webview, this._extensionUri);
    this._panel.webview.onDidReceiveMessage((m) => this.handleMessage(m as Msg), undefined, this._disposables);
    this._panel.onDidDispose(() => { this._panel = null; }, undefined, this._disposables);
  }

  dispose(): void {
    this._panel?.dispose();
    this._panel = null;
    for (const d of this._disposables) { d.dispose(); }
    this._disposables.length = 0;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async handleMessage(msg: Msg): Promise<void> {
    const type = text(msg?.type);
    this._ensureSelected();
    const backend = this._selected;
    if (type !== 'ready' && type !== 'refresh') { this._errors.delete(backend); }
    try {
      switch (type) {
        case 'ready':
        case 'refresh':
          this._banner = undefined;
          await this._checkClis();
          await this._load(backend);
          return;
        case 'select': return await this._select(text(msg.backend));
        case 'search': return await this._searchCatalog(backend, text(msg.query));
        case 'install': return await this._install(backend, text(msg.id), text(msg.scope));
        case 'uninstall': return await this._onInstalled(backend, msg, 'uninstall');
        case 'setEnabled': return await this._onInstalled(backend, msg, 'setEnabled');
        case 'update': return await this._onInstalled(backend, msg, 'update');
        case 'details': return await this._onInstalled(backend, msg, 'details');
        case 'addMarketplace': return await this._addMarketplace(backend, text(msg.source));
        case 'removeMarketplace': return await this._onMarketplace(backend, text(msg.name), 'remove');
        case 'refreshMarketplace': return await this._onMarketplace(backend, text(msg.name), 'refresh');
        default: return;
      }
    } catch (e) {
      this._fail(backend, errorText(e));
    }
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  private async _select(id: string): Promise<void> {
    if (!this._providers.getAllProviderIds().includes(id as ProviderType)) { return; }
    this._selected = id;
    this._banner = undefined;
    this._details = undefined;
    if (this._adapterFor(id)) { await this._load(id); } else { this._post(); }
  }

  /** Which plugin-capable CLIs are actually installed (cached discovery). */
  private async _checkClis(): Promise<void> {
    await Promise.all(this._ids().filter((id) => this._adapterFor(id)).map(async (id) => {
      const found = await this._providers.getProviderInstance(id)?.discoverCli().then((r) => r.found, () => false);
      if (found) { this._missing.delete(id); } else { this._missing.add(id); }
    }));
  }

  private _load(backend: string): Promise<void> {
    const adapter = this._adapterFor(backend);
    if (!adapter || this._missing.has(backend)) { this._post(); return Promise.resolve(); }
    this._loading.add(backend);
    this._post();
    return this._enqueue(backend, () => this._relist(backend, adapter));
  }

  /** Re-read everything from the CLI. A failure is an error, never an empty list. */
  private async _relist(backend: string, adapter: PluginAdapter): Promise<void> {
    const run = this._runFor(backend);
    try {
      this._listing.set(backend, await adapter.list(run));
    } catch (e) {
      this._listing.delete(backend);
      this._errors.set(backend, errorText(e));
    }
    if (adapter.marketplaces) {
      try { this._markets.set(backend, await adapter.marketplaces.list(run)); } catch { this._markets.delete(backend); }
    }
    this._loading.delete(backend);
    this._post();
  }

  private async _searchCatalog(backend: string, query: string): Promise<void> {
    const adapter = this._adapterFor(backend);
    if (!adapter?.search) { return; }
    if (!query) { this._search.delete(backend); this._post(); return; }
    if (query.length > 100 || query.startsWith('-')) { this._fail(backend, 'Search for a plugin name or word.'); return; }
    const results = await adapter.search(this._runFor(backend), query);
    this._search.set(backend, { query, results });
    this._post();
  }

  // ── Install: the gate ─────────────────────────────────────────────────────

  private async _install(backend: string, id: string, scope: string): Promise<void> {
    const adapter = this._adapterFor(backend);
    if (!adapter) { return; }
    const entry = this._catalog(backend).find((e) => e.id === id);
    if (!entry) { this._fail(backend, 'That plugin is no longer in the list. Refresh and try again.'); return; }
    if (!adapter.scopes.includes(scope as PluginScope)) { this._fail(backend, `${this._name(backend)} can't install plugins for that scope.`); return; }
    const where = scope as PluginScope;
    if (where !== 'user' && vscode.workspace.isTrusted !== true) {
      this._fail(backend, 'Installing for this project needs a trusted workspace.');
      return;
    }
    const run = this._runFor(backend);
    const parts: CodeParts = entry.codeParts ?? await adapter.inspect(run, entry).catch(() => 'unknown' as const);
    if ((parts === 'unknown' || parts.length > 0) && !(await this._confirmInstall(backend, entry, parts, where))) { return; }

    await this._mutate(backend, entry.id, 'Installing…', true, `Installed ${entry.name} ${SCOPE_PHRASE[where]}.`, async () => {
      let approval: Approval | undefined;
      for (;;) {
        try {
          await adapter.install(run, entry.id, where, approval);
          return;
        } catch (e) {
          if (!approval && e instanceof PluginCliError && e.acceptCommand && await this._confirmCommand(backend, entry, e.acceptCommand)) {
            approval = { acceptCommandSha: e.acceptCommand.sha };
            continue;
          }
          throw e;
        }
      }
    });
  }

  private async _confirmInstall(backend: string, entry: CatalogPlugin, parts: CodeParts, scope: PluginScope): Promise<boolean> {
    const name = this._name(backend);
    const from = `From ${entry.marketplace ?? name}. Installs ${SCOPE_PHRASE[scope]}.`;
    const outside = `run inside ${name}, outside Mysti's per-tool approval, even in read-only mode.`;
    const [message, detail, button] = parts === 'unknown'
      ? [
        `Install ${entry.name}?`,
        `Mysti can't see what ${entry.name} contains until it is installed. It may add hooks or servers, which ${outside}\n\n${from}`,
        'Install anyway',
      ]
      : [
        `Install ${entry.name}? It runs code on your machine.`,
        `${entry.name} adds: ${parts.join(', ')}. These ${outside}\n\n${from}`,
        'Install',
      ];
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  private async _confirmCommand(backend: string, entry: CatalogPlugin, cmd: { command: string; sha: string }): Promise<boolean> {
    const button = 'Run it and install';
    const detail = `${cmd.command}\n\nSHA-256 ${cmd.sha}\n\nApproving pins this exact command. If the marketplace changes it, the install stops and asks again.`;
    const message = `${entry.marketplace ?? this._name(backend)} runs a command to install ${entry.name}. Approve it?`;
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  // ── Installed plugins ─────────────────────────────────────────────────────

  private async _onInstalled(backend: string, msg: Msg, op: 'uninstall' | 'setEnabled' | 'update' | 'details'): Promise<void> {
    const adapter = this._adapterFor(backend);
    const p = this._listing.get(backend)?.installed.find((x) => x.id === text(msg.id) && x.scope === text(msg.scope));
    if (!adapter || !p) { this._fail(backend, 'That plugin is no longer in the list. Refresh and try again.'); return; }
    const run = this._runFor(backend);
    if (op === 'details') {
      if (!adapter.details) { return; }
      this._details = { backend, id: p.id, text: await adapter.details(run, p) };
      this._post();
      return;
    }
    if (op === 'uninstall') {
      if (!adapter.uninstall || p.scope === 'bundled' || p.scope === 'managed') { this._fail(backend, `${p.name} can't be removed here.`); return; }
      await this._mutate(backend, p.id, 'Uninstalling…', true, `Uninstalled ${p.name}.`, () => adapter.uninstall!(run, p));
    } else if (op === 'setEnabled') {
      if (!adapter.setEnabled) { return; }
      const on = msg.on === true;
      await this._mutate(backend, p.id, on ? 'Turning on…' : 'Turning off…', true, `Turned ${on ? 'on' : 'off'} ${p.name}.`, () => adapter.setEnabled!(run, p, on));
    } else {
      if (!adapter.update) { return; }
      await this._mutate(backend, p.id, 'Updating…', true, `Updated ${p.name}.`, () => adapter.update!(run, p));
    }
  }

  // ── Marketplaces ──────────────────────────────────────────────────────────

  private async _addMarketplace(backend: string, source: string): Promise<void> {
    const m = this._adapterFor(backend)?.marketplaces;
    if (!m) { return; }
    // eslint-disable-next-line no-control-regex
    if (!source || source.length > 500 || source.startsWith('-') || /[\u0000-\u001f]/.test(source)) {
      this._fail(backend, 'Enter a marketplace as owner/repo, a git URL, or a local path.');
      return;
    }
    const button = 'Add marketplace';
    const answer = await vscode.window.showWarningMessage(`Add the marketplace ${source} to ${this._name(backend)}?`, {
      modal: true,
      detail: 'Its plugins become installable here. Installing any of them still asks first when it runs code.',
    }, button);
    if (answer !== button) { return; }
    await this._mutate(backend, `mkt:${source}`, 'Adding…', false, `Added ${source}.`, () => m.add(this._runFor(backend), source));
  }

  private async _onMarketplace(backend: string, name: string, op: 'remove' | 'refresh'): Promise<void> {
    const m = this._adapterFor(backend)?.marketplaces;
    const market = this._markets.get(backend)?.find((x) => x.name === name);
    if (!m || !market) { this._fail(backend, 'That marketplace is no longer in the list. Refresh and try again.'); return; }
    const run = this._runFor(backend);
    if (op === 'refresh') {
      await this._mutate(backend, `mkt:${name}`, 'Refreshing…', false, `Refreshed ${name}.`, () => m.refresh(run, name));
      return;
    }
    if (market.builtin) { this._fail(backend, `${name} is built into ${this._name(backend)}.`); return; }
    const fromIt = (this._listing.get(backend)?.installed ?? []).filter((p) => p.marketplace === name).map((p) => p.name);
    const button = 'Remove';
    const answer = await vscode.window.showWarningMessage(`Remove the marketplace ${name}?`, {
      modal: true,
      detail: fromIt.length
        ? `Plugins installed from it may be uninstalled too: ${fromIt.join(', ')}.`
        : 'Its plugins stop showing here.',
    }, button);
    if (answer !== button) { return; }
    await this._mutate(backend, `mkt:${name}`, 'Removing…', true, `Removed ${name}.`, () => m.remove(run, name));
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /**
   * Run one mutation in the backend's queue, show it on its row, re-list from
   * the CLI afterwards, and on success tell the provider so open chats pick up
   * the change on their next message.
   */
  private _mutate(backend: string, rowKey: string, busyText: string, changesPlugins: boolean, done: string, fn: () => Promise<void>): Promise<void> {
    const key = `${backend}\n${rowKey}`;
    this._busy.set(key, busyText);
    this._rowErrors.delete(key);
    this._post();
    return this._enqueue(backend, async () => {
      try {
        await fn();
        if (changesPlugins) { this._providers.getProviderInstance(backend)?.markPluginsChanged?.(); }
        this._banner = changesPlugins ? `${done} It applies from your next message in ${this._name(backend)} chats.` : done;
      } catch (e) {
        this._rowErrors.set(key, errorText(e));
      } finally {
        this._busy.delete(key);
      }
      const adapter = this._adapterFor(backend);
      if (adapter) { await this._relist(backend, adapter); }
    });
  }

  private _enqueue(backend: string, fn: () => Promise<void>): Promise<void> {
    const next = (this._queue.get(backend) ?? Promise.resolve()).then(fn, fn);
    this._queue.set(backend, next.catch(() => undefined));
    return next;
  }

  private _runFor(backend: string): Run {
    const cliPath = this._providers.getProviderInstance(backend)?.getCliPath() ?? '';
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return (args, opts) => this._runCli(cliPath, args, { timeoutMs: opts?.timeoutMs, cwd });
  }

  private _catalog(backend: string): CatalogPlugin[] {
    return [...(this._listing.get(backend)?.available ?? []), ...(this._search.get(backend)?.results ?? [])];
  }

  private _ids(): string[] {
    return this._providers.getAllProviderIds();
  }

  private _ensureSelected(): void {
    if (this._selected) { return; }
    this._selected = this._ids().find((id) => this._adapterFor(id)) ?? this._ids()[0] ?? '';
  }

  private _adapterFor(id: string): PluginAdapter | undefined {
    const b = this._adapters[id];
    return b && isAdapter(b) ? b : undefined;
  }

  private _name(id: string): string {
    return this._providers.getProviderInstance(id)?.displayName ?? id;
  }

  private _fail(backend: string, message: string): void {
    this._errors.set(backend, message);
    this._post();
  }

  private _rows(map: Map<string, string>, backend: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of map) {
      if (k.startsWith(`${backend}\n`)) { out[k.slice(backend.length + 1)] = v; }
    }
    return out;
  }

  private _post(): void {
    const b = this._selected;
    const adapter = this._adapterFor(b);
    const entry = this._adapters[b];
    const state: PluginsViewState = {
      backends: this._ids().map((id) => {
        const be = this._adapters[id];
        const provider = this._providers.getProviderInstance(id) as (ICliProvider & { getCachedCliVersion?(): string | null }) | undefined;
        return {
          id,
          name: provider?.displayName ?? id,
          status: !be ? 'none' : !isAdapter(be) ? 'note' : this._missing.has(id) ? 'missing' : 'ok',
          note: be && !isAdapter(be) ? be.note : undefined,
          version: provider?.getCachedCliVersion?.() ?? undefined,
        };
      }),
      selected: b,
      note: entry && !isAdapter(entry) ? entry.note : undefined,
      scopes: adapter?.scopes ?? [],
      can: {
        toggle: !!adapter?.setEnabled, update: !!adapter?.update, uninstall: !!adapter?.uninstall,
        details: !!adapter?.details, marketplaces: !!adapter?.marketplaces, search: !!adapter?.search,
      },
      trusted: vscode.workspace.isTrusted === true,
      loading: this._loading.has(b),
      listing: this._listing.get(b),
      search: this._search.get(b),
      markets: this._markets.get(b),
      busy: this._rows(this._busy, b),
      rowErrors: this._rows(this._rowErrors, b),
      banner: this._banner,
      error: this._errors.get(b) ?? (this._missing.has(b) ? `${this._name(b)}'s CLI wasn't found. Install it from the setup screen, then refresh.` : undefined),
      details: this._details?.backend === b ? { id: this._details.id, text: this._details.text } : undefined,
    };
    this.onState?.(state);
    void this._panel?.webview.postMessage({ type: 'state', state });
  }
}

