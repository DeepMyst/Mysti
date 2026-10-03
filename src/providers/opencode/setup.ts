import * as vscode from 'vscode';
import type { ProviderManager } from '../../managers/ProviderManager';
import { remoteConnection } from './OpenCodeRemote';

export function registerOpenCodeRemoteSetup(context: vscode.ExtensionContext, manager: ProviderManager): void {
  const test = async () => {
    if (!vscode.workspace.getConfiguration('mysti').get<string>('opencodeEndpoint', '').trim()) {
      await vscode.window.showInformationMessage('Configure an OpenCode remote endpoint first.'); return;
    }
    const provider = manager.getProviderInstance('opencode');
    if (!provider) { throw new Error('OpenCode provider is not ready.'); }
    const status = await provider.checkAuthentication();
    if (status.authenticated) { await vscode.window.showInformationMessage(`Connected: ${status.user}`); }
    else { await vscode.window.showErrorMessage(status.error ?? 'OpenCode connection failed.'); }
  };
  const wrap = (action: () => Promise<void>) => async () => {
    try { await action(); } catch (error) { await vscode.window.showErrorMessage(`OpenCode setup: ${error instanceof Error ? error.message : String(error)}`); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.testOpenCodeConnection', wrap(test)),
    vscode.commands.registerCommand('mysti.configureOpenCodeRemote', wrap(async () => {
      const config = vscode.workspace.getConfiguration('mysti');
      const endpoint = await vscode.window.showInputBox({ title: 'OpenCode remote server',
        value: config.get<string>('opencodeEndpoint', '') || 'http://localhost:4096',
        prompt: 'Enter the server URL. Clear it to use the local CLI.',
        validateInput: value => { if (!value.trim()) { return undefined; } try { remoteConnection(value.trim()); } catch (error) { return String(error); } return undefined; } });
      if (endpoint === undefined) { return; }
      if (!endpoint.trim()) { await config.update('opencodeEndpoint', '', vscode.ConfigurationTarget.Global); return; }
      const directory = await vscode.window.showInputBox({ title: 'OpenCode server project directory',
        value: config.get<string>('opencodeRemoteDirectory', ''), prompt: 'Absolute path on the server, not the local Windows path. Empty uses the server default.' });
      if (directory === undefined) { return; }
      await config.update('opencodeRemoteDirectory', directory, vscode.ConfigurationTarget.Global);
      await config.update('opencodeEndpoint', remoteConnection(endpoint.trim()).endpoint, vscode.ConfigurationTarget.Global);
      const provider = manager.getProviderInstance('opencode');
      if (!provider?.configureAuthentication) { throw new Error('OpenCode provider is not ready. Retry setup after activation.'); }
      const status = await provider.configureAuthentication();
      if (status.authenticated) { await vscode.window.showInformationMessage(`Connected: ${status.user}`); }
      else { await vscode.window.showErrorMessage(status.error ?? 'OpenCode connection failed.'); }
    })),
  );
}
