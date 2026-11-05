import * as vscode from 'vscode';

/** Close a host credential prompt when its owning setup attempt is cancelled. */
export async function showAuthenticationInput(
  options: vscode.InputBoxOptions,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) { return undefined; }
  if (!signal) { return vscode.window.showInputBox(options); }

  const cancellation = new vscode.CancellationTokenSource();
  const abort = () => cancellation.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    // Guard registration too: cancellation must never leave an orphan prompt.
    if (signal.aborted) { cancellation.cancel(); }
    return await vscode.window.showInputBox(options, cancellation.token);
  } finally {
    signal.removeEventListener('abort', abort);
    cancellation.dispose();
  }
}
