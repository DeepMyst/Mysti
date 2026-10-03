import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

export interface DictationEvent {
  requestId: string;
  state: 'opening' | 'active' | 'complete' | 'cancelled' | 'error';
  text?: string;
  error?: string;
  needsSetup?: boolean;
}
interface Session {
  panelId: string;
  requestId: string;
  document?: vscode.TextDocument;
  cancelled: boolean;
  listeners: vscode.Disposable[];
  timer?: ReturnType<typeof setTimeout>;
}
const START = 'workbench.action.editorDictation.start';
const STOP = 'workbench.action.editorDictation.stop';

/** Public editor commands bridge speech into chat without granting webviews microphone access. */
export class DictationManager implements vscode.Disposable {
  private _session?: Session;
  private _queue: Promise<void> = Promise.resolve();
  private _disposed = false;
  private readonly _controls: vscode.Disposable[] = [];
  private readonly _finishButton: vscode.StatusBarItem;
  private readonly _cancelButton: vscode.StatusBarItem;

  constructor(
    private readonly _emit: (panelId: string, event: DictationEvent) => void,
    private readonly _speechCommand: (command: string) => Thenable<unknown> = command => vscode.commands.executeCommand(command),
  ) {
    const id = randomUUID();
    this._finishButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this._cancelButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
    this._finishButton.text = '$(check) Use dictation in Mysti';
    this._cancelButton.text = '$(close) Discard dictation';
    this._finishButton.command = `mysti.dictation.finish.${id}`;
    this._cancelButton.command = `mysti.dictation.cancel.${id}`;
    this._controls.push(this._finishButton, this._cancelButton,
      vscode.commands.registerCommand(this._finishButton.command, () => this._session && this.finish(this._session.panelId, this._session.requestId)),
      vscode.commands.registerCommand(this._cancelButton.command, () => this._session && this.cancelPanel(this._session.panelId)));
  }

  private _serial(action: () => Promise<void>): Promise<void> {
    const next = this._queue.then(action);
    this._queue = next.catch(() => undefined);
    return next;
  }

  start(panelId: string, requestId: string): Promise<void> {
    if (this._disposed || typeof requestId !== 'string' || !requestId || requestId.length > 100) { return Promise.resolve(); }
    if (this._session) {
      this._emit(panelId, { requestId, state: 'error', error: 'Finish or discard the dictation already open in Mysti first.' });
      return Promise.resolve();
    }
    const session: Session = { panelId, requestId, cancelled: false, listeners: [] };
    this._session = session;
    this._emit(panelId, { requestId, state: 'opening' });
    return this._serial(async () => {
      try {
        const commands = await vscode.commands.getCommands(true);
        const builtin = vscode.workspace.getConfiguration().get<boolean>('dictation.enabled');
        const speech = vscode.extensions.getExtension('ms-vscode.vscode-speech');
        if (!commands.includes(START) || (builtin !== true && !speech)) {
          this._emit(panelId, { requestId, state: 'error', needsSetup: true,
            error: 'Enable voice dictation in your editor settings, or install VS Code Speech. Your editor handles microphone permissions and language settings.' });
          await this._close(session);
          return;
        }
        if (speech && builtin !== true) { await speech.activate(); }
        if (session.cancelled) { await this._close(session); return; }
        session.document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: '' });
        if (session.cancelled) { await this._close(session); return; }
        await vscode.window.showTextDocument(session.document, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        session.listeners.push(vscode.workspace.onDidChangeTextDocument(e => {
          if (e.document === session.document && !session.cancelled) {
            this._emit(panelId, { requestId, state: 'active', text: e.document.getText() });
          }
        }), vscode.workspace.onDidCloseTextDocument(doc => {
          if (doc === session.document && !session.cancelled) { void this.cancelPanel(panelId); }
        }));
        if (session.cancelled) { await this._close(session); return; }
        this._finishButton.show(); this._cancelButton.show();
        await this._speechCommand(START);
        if (session.cancelled) { await this._close(session); return; }
        this._emit(panelId, { requestId, state: 'active', text: session.document.getText() });
        // Bound the lifetime even if the original chat is no longer visible.
        session.timer = setTimeout(() => { void this.finish(panelId, requestId); }, 5 * 60_000);
      } catch (error) {
        this._emit(panelId, { requestId, state: 'error', text: session.document?.getText(),
          error: `Could not start editor dictation: ${error instanceof Error ? error.message : String(error)}` });
        await this._close(session);
      }
    });
  }

  finish(panelId: string, requestId: string): Promise<void> {
    const session = this._session;
    if (!session || session.panelId !== panelId || session.requestId !== requestId) { return Promise.resolve(); }
    return this._serial(async () => {
      if (this._session !== session || session.cancelled) { return; }
      const text = await this._close(session);
      this._emit(panelId, { requestId, state: 'complete', text });
    });
  }

  cancelPanel(panelId: string, requestId?: string): Promise<void> {
    const session = this._session;
    if (!session || session.panelId !== panelId || (requestId && session.requestId !== requestId)) { return Promise.resolve(); }
    session.cancelled = true;
    return this._serial(async () => {
      await this._close(session);
      this._emit(panelId, { requestId: session.requestId, state: 'cancelled' });
    });
  }

  private async _close(session: Session): Promise<string> {
    session.cancelled = true;
    if (session.timer) { clearTimeout(session.timer); }
    session.listeners.splice(0).forEach(listener => listener.dispose());
    const document = session.document;
    let text = document?.getText() || '';
    try {
      if (document && !document.isClosed) {
        await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
        await this._speechCommand(STOP);
        text = document.getText();
        // Only discard our own untitled editor, never a saved or unrelated file.
        if (document.isUntitled && vscode.window.activeTextEditor?.document === document) {
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
      }
    } catch (error) {
      // Keep a recoverable editor open if stopping or closing fails.
      void vscode.window.showWarningMessage(`Mysti could not close editor dictation. Use the editor's Stop Dictation command; your transcript remains in its editor. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this._session === session) {
        this._session = undefined;
        this._finishButton.hide(); this._cancelButton.hide();
      }
    }
    return text;
  }

  dispose(): void {
    this._disposed = true;
    if (this._session) { void this.cancelPanel(this._session.panelId); }
    this._controls.splice(0).forEach(control => control.dispose());
  }
}
