import * as vscode from 'vscode';
import { DeskLocalStatus } from './DeskLocalStatus';
import { DeskIdentity } from './desk/DeskIdentity';
import { DeskPeerBook } from '../managers/DeskPeerBook';
import type { DeskStatus } from './desk/DeskDispatch';

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
      if (event.affectsConfiguration('mysti.desk')) { refresh(); }
    }),
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
  );
  refresh();
}
