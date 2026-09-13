import * as vscode from 'vscode';
import { DeskLocalStatus } from './DeskLocalStatus';
import { DeskIdentity } from './desk/DeskIdentity';
import { DeskPeerBook } from '../managers/DeskPeerBook';
import type { DeskStatus } from './desk/DeskDispatch';
import { DeskWorkspaceLookup } from './DeskWorkspaceLookup';
import { validateCall, validatePath } from './desk/DeskContract';
import { hasControlCharacters } from '../utils/controlCharacters';

/** Editor ownership stays outside the sealed dispatcher and the chat renderer. */
export function registerDeskLocalStatus(
  context: vscode.ExtensionContext, identity: DeskIdentity, peerBook: DeskPeerBook,
): void {
  const runtime = new DeskLocalStatus({
    identity, peerBook, now: Date.now,
    enabled: () => vscode.workspace.getConfiguration('mysti').get<boolean>('desk.enabled', false),
    serving: () => vscode.workspace.getConfiguration('mysti').get<boolean>('desk.serve', false),
    trusted: () => vscode.workspace.isTrusted,
  });
  const refresh = () => {
    void runtime.refresh().catch(() => {
      void vscode.window.showErrorMessage('Mysti Desk: local status could not start. Check Desk settings and secret storage availability.');
    });
  };
  context.subscriptions.push(runtime,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('mysti.desk')) { runtime.invalidateLookups(); refresh(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => runtime.invalidateLookups()),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
    vscode.commands.registerCommand('mysti.deskShareLocalStatus', async () => {
      const peers = peerBook.listPeers().filter(peer => peerBook.getGrant(peer.peerId)?.verbs.includes('status'));
      if (peers.length === 0) {
        void vscode.window.showInformationMessage('Mysti Desk: first pair another editor profile and grant status permission.');
        return;
      }
      const selected = await vscode.window.showQuickPick(peers.map(peer => ({ label: peer.alias, peerId: peer.peerId })), {
        title: 'Share status with a paired profile on this computer', ignoreFocusOut: true,
      });
      if (!selected) { return; }
      const status = await vscode.window.showQuickPick(['available', 'busy', 'dnd', 'offline'], {
        title: 'Status to publish to your paired local profiles', ignoreFocusOut: true,
      });
      if (!status) { return; }
      try {
        const link = await runtime.share(selected.peerId, status as DeskStatus['availability']);
        await vscode.env.clipboard.writeText(link);
        void vscode.window.showInformationMessage('Mysti Desk: local status link copied. Paste it into “Desk: Check local status” in the paired profile on this computer. It expires within 10 minutes; creating another link replaces this one.');
      } catch {
        void vscode.window.showErrorMessage('Mysti Desk: could not share local status. Enable mysti.desk.enabled and mysti.desk.serve in a trusted window with a live status grant.');
      }
    }),
    vscode.commands.registerCommand('mysti.deskCheckLocalStatus', async () => {
      const link = await vscode.window.showInputBox({
        title: 'Check a paired profile’s local status',
        prompt: 'Paste its temporary desk://local-status/ link. Both profiles must be on this computer.',
        password: true, ignoreFocusOut: true,
      });
      if (!link) { return; }
      const result = await runtime.check(link.trim());
      const availability = result.ok ? result.payload.availability : undefined;
      // Render only this fixed vocabulary, even from a correctly signed peer.
      if (typeof availability === 'string' && ['available', 'busy', 'dnd', 'offline'].includes(availability)) {
        void vscode.window.showInformationMessage(`Mysti Desk: verified local status — ${availability}.`);
      } else {
        void vscode.window.showErrorMessage('Mysti Desk: local status could not be verified. Check pairing, Desk settings, and link expiry.');
      }
    }),
    vscode.commands.registerCommand('mysti.deskShareLocalLookup', async () => {
      const peers = peerBook.listPeers().filter(peer => peerBook.getGrant(peer.peerId)?.verbs.includes('locate'));
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
      if (!peers.length || !folders.length) {
        void vscode.window.showInformationMessage('Mysti Desk: open a local workspace and pair a profile with locate permission first.');
        return;
      }
      const selected = await vscode.window.showQuickPick(peers.map(peer => ({ label: peer.alias, peerId: peer.peerId })), {
        title: 'Share workspace coordinates with a paired profile on this computer', ignoreFocusOut: true,
      });
      if (!selected) { return; }
      const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), {
        title: 'Workspace to share within its Desk scope', ignoreFocusOut: true,
      });
      if (!choice) { return; }
      const uri = choice.folder.uri.toString();
      const workspace = new DeskWorkspaceLookup({
        root: choice.folder.uri.fsPath,
        // inspect().globalValue deliberately excludes repository overrides,
        // including malformed manually inserted workspace settings.
        ceiling: () => vscode.workspace.getConfiguration('mysti').inspect<string[]>('desk.shareCeiling')?.globalValue ?? [],
        active: () => vscode.workspace.isTrusted
          && !!vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === uri),
      });
      try {
        const link = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing Desk workspace coordinates' },
          () => runtime.shareLookup(selected.peerId, workspace));
        await vscode.env.clipboard.writeText(link);
        void vscode.window.showInformationMessage('Mysti Desk: workspace lookup link copied. Paste it into “Desk: Look up shared workspace” in the paired profile. It expires within 10 minutes. File or scope changes require a new link.');
      } catch {
        void vscode.window.showErrorMessage('Mysti Desk: could not prepare workspace lookup. Enable Desk serving, set mysti.desk.shareCeiling in User Settings, and add .mysti/desk-share.json with an allow list intersecting the peer grant. Share a smaller scope if it exceeds the snapshot limits.');
      }
    }),
    vscode.commands.registerCommand('mysti.deskLocateLocal', async () => {
      const link = await vscode.window.showInputBox({ title: 'Look up a paired profile’s shared workspace',
        prompt: 'Paste its temporary desk://local-lookup/ link from this computer.', password: true, ignoreFocusOut: true });
      if (!link) { return; }
      const kind = await vscode.window.showQuickPick(['symbol', 'path'] as const, { title: 'Exact lookup type', ignoreFocusOut: true });
      if (!kind) { return; }
      const token = await vscode.window.showInputBox({ title: 'Exact symbol or path component',
        prompt: 'Enter a literal declaration name, filename, or path component. Patterns are not supported.', ignoreFocusOut: true,
        validateInput: value => validateCall('locate', { token: value, kind }).ok ? undefined : 'Enter a valid literal lookup token.' });
      if (!token) { return; }
      const result = await runtime.locate(link.trim(), token, kind as 'symbol' | 'path');
      const hits = result.ok ? result.payload.hits : undefined;
      if (!Array.isArray(hits) || hits.length > 20 || !hits.every(hit => hit && typeof hit === 'object'
        && typeof hit.path === 'string' && validatePath(hit.path, 'path').ok && !hasControlCharacters(hit.path)
        && Number.isInteger(hit.line) && hit.line >= 0)) {
        void vscode.window.showErrorMessage('Mysti Desk: lookup could not be verified. Check pairing, scope, and link expiry; changed files require a new sharing link.');
        return;
      }
      if (!hits.length) { void vscode.window.showInformationMessage('Mysti Desk: no shared coordinates for that exact token.'); return; }
      // Display peer-relative coordinates as text. They never select a local
      // file, command, Markdown target, or model instruction.
      await vscode.window.showQuickPick(hits.map(hit => ({ label: hit.path.replace(/\$\(/g, '$ ('),
        description: hit.line ? `Line ${hit.line}` : 'File' })), { title: 'Verified shared workspace coordinates', ignoreFocusOut: true });
    }),
  );
  refresh();
}
