import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import type { DeepMystAuthManager } from './DeepMystAuthManager';
import { observeRepository, repositoryInsights, mayNotify, type RepositorySnapshot, type LocalInsight } from '../services/proactive/LocalRepository';
import { ProactiveClient, type CloudState } from '../services/proactive/ProactiveClient';
import { taskBriefing, type TaskBriefing } from '../services/proactive/TaskBriefing';

interface LocalWatch {
  root: string; name: string; active: boolean; health: string; snapshot?: RepositorySnapshot; insights: LocalInsight[];
}
interface StoredState { watches: LocalWatch[]; notifications: boolean; daily: { day: string; count: number }; notified: string[] }
const STORAGE = 'mysti.proactive.v1';

/** Local monitoring remains local. Cloud responsibilities run on DeepMyst after explicit creation. */
export class ProactiveManager implements vscode.Disposable {
  private _panel?: vscode.WebviewPanel;
  private _state: StoredState;
  private _cloud?: CloudState;
  private _cloudError = '';
  private _briefing?: TaskBriefing;
  private _busy = false;
  private _acting = false;
  private _refreshPromise?: Promise<void>;
  private _disposed = false;
  private _authEpoch = 0;
  private _timer: ReturnType<typeof setInterval>;
  private _authListener: vscode.Disposable;
  private _queue: Promise<void> = Promise.resolve();

  constructor(private readonly _context: vscode.ExtensionContext, private readonly _auth: DeepMystAuthManager) {
    this._state = _context.workspaceState.get<StoredState>(STORAGE) ?? { watches: [], notifications: false, daily: { day: '', count: 0 }, notified: [] };
    this._authListener = _auth.onDidChangeAuth(() => { this._authEpoch++; this._cloud = undefined; this._briefing = undefined; this._cloudError = ''; this._post(); void this._refresh().catch(() => { this._cloudError = 'Unable to save or refresh the inbox. Please retry.'; this._post(); }); });
    this._timer = setInterval(() => { void this._refresh().catch(() => { this._cloudError = 'Unable to save or refresh the inbox. Please retry.'; this._post(); }); }, 60_000);
    void this._refresh().catch(() => { this._cloudError = 'Unable to save or refresh the inbox. Please retry.'; this._post(); });
  }

  open(): void {
    if (this._panel) { this._panel.reveal(); return; }
    const root = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'proactive');
    this._panel = vscode.window.createWebviewPanel('mysti.proactive', 'Mysti Proactive', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [root] });
    const view = this._panel.webview;
    let html = readFileSync(vscode.Uri.joinPath(root, 'index.html').fsPath, 'utf8');
    for (const [key, value] of Object.entries({ nonce: randomBytes(20).toString('hex'), cspSource: view.cspSource,
      scriptUri: view.asWebviewUri(vscode.Uri.joinPath(root, 'proactive.js')).toString(),
      styleUri: view.asWebviewUri(vscode.Uri.joinPath(root, 'proactive.css')).toString() })) {
      html = html.split(`{{${key}}}`).join(value);
    }
    view.html = html;
    const messages = view.onDidReceiveMessage(msg => {
      this._queue = this._queue.then(() => this._handle(msg)).catch(() => {
        this._panel?.webview.postMessage({ type: 'error', message: 'Could not complete the action. Refresh and try again.' });
      });
    });
    this._panel.onDidDispose(() => { messages.dispose(); this._panel = undefined; });
    this._post();
    void this._refresh().catch(() => { this._cloudError = 'Unable to save or refresh the inbox. Please retry.'; this._post(); });
  }

  dispose(): void { this._disposed = true; clearInterval(this._timer); this._authListener.dispose(); this._panel?.dispose(); }

  private _client(): ProactiveClient {
    const key = this._auth.getApiKey();
    if (!key || !this._auth.isSignedIn()) { throw new Error('Sign in to DeepMyst first.'); }
    return new ProactiveClient(this._auth.getApiUrl(), key);
  }
  private async _save(): Promise<void> { await this._context.workspaceState.update(STORAGE, this._state); }
  private _post(): void {
    if (this._disposed) { return; }
    void this._panel?.webview.postMessage({ type: 'state', local: this._state, cloud: this._cloud, cloudError: this._cloudError, briefing: this._briefing, signedIn: this._auth.isSignedIn(), busy: this._busy, pending: this._acting });
  }
  private _refresh(): Promise<void> {
    if (this._disposed) { return Promise.resolve(); }
    if (this._refreshPromise) { return this._refreshPromise; }
    this._refreshPromise = this._performRefresh().finally(() => { this._refreshPromise = undefined; });
    return this._refreshPromise;
  }
  private async _performRefresh(): Promise<void> {
    this._briefing = undefined; // Never retain a briefing across permission/evidence refreshes.
    this._busy = true; this._post();
    try {
      for (const watch of this._state.watches) {
        if (!watch.active) { continue; }
        if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.some(f => f.uri.scheme === 'file' && f.uri.fsPath === watch.root)) {
          watch.health = 'Unavailable: open the trusted repository workspace to resume'; continue;
        }
        try {
          const snapshot = await observeRepository(watch.root);
          if (!watch.active || !this._state.watches.includes(watch) || this._disposed) { continue; }
          for (const insight of repositoryInsights(snapshot, watch.snapshot)) {
            if (!watch.insights.some(i => i.id === insight.id)) { watch.insights.unshift(insight); }
          }
          watch.insights = watch.insights.slice(0, 100);
          watch.snapshot = snapshot;
          watch.health = snapshot.upstream ? 'Checked local refs; remote freshness depends on your last fetch' : 'Checked local repository; no upstream configured';
        } catch {
          watch.health = 'Cannot read this repository. Check Git installation, repository root, and that it has a commit.';
        }
      }
      const epoch = this._authEpoch;
      if (this._auth.isSignedIn()) {
        try {
          const cloud = await this._client().request<CloudState>();
          if (epoch === this._authEpoch && !this._disposed) { this._cloud = cloud; this._cloudError = ''; }
        } catch (err) {
          if (epoch === this._authEpoch) { this._cloud = undefined; this._cloudError = err instanceof Error ? err.message : 'DeepMyst unavailable'; }
        }
      } else { this._cloud = undefined; }
      await this._save();
      await this._notify();
    } finally { this._busy = false; this._post(); }
  }

  private async _notify(): Promise<void> {
    const now = new Date();
    if (this._disposed || !mayNotify(this._state.notifications, now, this._state.daily)) { return; }
    const freshLocal = this._state.watches.filter(w => w.active).flatMap(w => w.insights.filter(i => i.state === 'unread').map(i => ({ id: `${w.root}:${i.id}`, created: i.createdAt })));
    const active = new Set(this._cloud?.responsibilities.filter(r => r.state === 'active').map(r => r.id));
    const freshCloud = (this._cloud?.insights ?? []).filter(i => active.has(i.responsibility_id) && i.state === 'unread').map(i => ({ id: i.id, created: i.created_at }));
    const fresh = [...freshLocal, ...freshCloud].filter(i => !this._state.notified.includes(i.id) && now.getTime() - Date.parse(i.created) < 24 * 3600_000);
    if (!fresh.length) { return; }
    const day = now.toLocaleDateString('en-CA');
    this._state.daily = { day, count: this._state.daily.day === day ? this._state.daily.count + 1 : 1 };
    this._state.notified = [...this._state.notified, ...fresh.map(i => i.id)].slice(-500);
    await this._save(); // reserve before delivery so restart cannot repeat the toast
    void vscode.window.showInformationMessage(`Mysti has ${fresh.length} new proactive insight(s).`, 'Open inbox').then(action => { if (action && !this._disposed) { this.open(); } });
  }

  private async _handle(msg: Record<string, unknown>): Promise<void> {
    if (this._disposed || !msg || typeof msg.type !== 'string') { return; }
    this._acting = !['ready', 'refresh'].includes(msg.type); this._post();
    try {
      if (this._refreshPromise && !['ready', 'localState', 'removeLocal'].includes(msg.type)) { await this._refreshPromise; }
      switch (msg.type) {
        case 'ready': this._post(); return;
        case 'refresh': await this._refresh(); return;
        case 'taskBriefing': {
          if (!Number.isSafeInteger(msg.requestId) || typeof msg.id !== 'string' || typeof msg.summary !== 'string' || msg.summary.length > 2000) { throw new Error('Choose a responsibility and use a summary under 2,000 characters.'); }
          const epoch = this._authEpoch;
          await this._refresh();
          if (epoch !== this._authEpoch || !this._auth.isSignedIn() || !this._cloud) { throw new Error('Refresh your DeepMyst connection before checking task context.'); }
          this._briefing = { ...taskBriefing(this._cloud, msg.id, msg.summary), requestId: msg.requestId as number };
          return;
        }
        case 'clearBriefing': this._briefing = undefined; return;
        case 'signIn': await vscode.commands.executeCommand('mysti.deepmyst.signIn'); return;
        case 'connections': await vscode.commands.executeCommand('mysti.openConnections'); return;
        case 'addLocal': {
          if (this._state.watches.length >= 10) { throw new Error('Remove an unused watch before adding more (limit 10 per workspace).'); }
          if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before enabling local monitoring.'); }
          const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file') ?? [];
          if (!folders.length) { throw new Error('Open a local repository folder first.'); }
          const pick = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })), { title: 'Watch a local repository (stays on this machine)' });
          if (!pick) { return; }
          if (this._state.watches.some(w => w.root === pick.folder.uri.fsPath)) { throw new Error('This repository is already watched.'); }
          const snapshot = await observeRepository(pick.folder.uri.fsPath);
          this._state.watches.push({ root: pick.folder.uri.fsPath, name: pick.label, active: true, snapshot, health: 'Watching local refs', insights: repositoryInsights(snapshot) });
          break;
        }
        case 'localState': {
          const watch = this._state.watches.find(w => w.root === msg.id);
          if (watch && typeof msg.active === 'boolean') { watch.active = msg.active; watch.health = watch.active ? 'Waiting for next check' : 'Paused by you'; }
          break;
        }
        case 'removeLocal': this._state.watches = this._state.watches.filter(w => w.root !== msg.id); break;
        case 'markLocal': {
          const insight = this._state.watches.find(w => w.root === msg.root)?.insights.find(i => i.id === msg.id);
          if (insight && (msg.state === 'read' || msg.state === 'dismissed')) { insight.state = msg.state; }
          break;
        }
        case 'notifications': this._state.notifications = msg.enabled === true; break;
        case 'addCloud': {
          if (!this._cloud?.available || this._cloud.read_only) { throw new Error('Cloud monitoring is unavailable for this account.'); }
          const connection = this._cloud.connections.find(c => c.id === msg.connectionId && c.supported);
          if (!connection || typeof msg.title !== 'string' || typeof msg.resource !== 'string' || typeof msg.keywords !== 'string') { throw new Error('Choose a supported connection and complete the form.'); }
          await this._client().request('/responsibilities', 'POST', { title: msg.title.trim(), source: connection.source, connection_id: connection.id, resource: msg.resource.trim(), keywords: msg.keywords.split(',').map(k => k.trim()).filter(Boolean) });
          await this._refresh(); return;
        }
        case 'cloudState': {
          const row = this._cloud?.responsibilities.find(r => r.id === msg.id);
          if (row && (msg.state === 'active' || msg.state === 'paused')) { await this._client().request(`/responsibilities/${row.id}`, 'PATCH', { state: msg.state, revision: row.revision }); }
          await this._refresh(); return;
        }
        case 'removeCloud': {
          const row = this._cloud?.responsibilities.find(r => r.id === msg.id);
          if (row) { await this._client().request(`/responsibilities/${row.id}`, 'DELETE'); }
          await this._refresh(); return;
        }
        case 'markCloud': {
          const row = this._cloud?.insights.find(r => r.id === msg.id);
          if (row && (msg.state === 'read' || msg.state === 'dismissed')) { await this._client().request(`/insights/${row.id}`, 'PATCH', { state: msg.state }); }
          await this._refresh(); return;
        }
        case 'evidence': {
          const row = this._cloud?.insights.find(i => i.id === msg.id);
          if (row) {
            const url = new URL(row.evidence.url);
            if (url.protocol === 'https:' && !url.username && !url.password && ['github.com', 'slack.com'].includes(url.hostname)) { await vscode.env.openExternal(vscode.Uri.parse(url.href)); }
          }
          return;
        }
        default: return;
      }
      await this._save(); this._post();
    } catch (err) { void this._panel?.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'Action failed. Please retry.' }); }
    finally { this._acting = false; this._post(); }
  }
}
