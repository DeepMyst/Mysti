/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import type * as vscode from 'vscode';

export interface EditorContextOwner {
  currentConversationId?: string | null;
  navigationRevision?: number;
}

export interface EditorContextWindow {
  readonly activeTextEditor?: vscode.TextEditor;
  readonly visibleTextEditors?: readonly vscode.TextEditor[];
  onDidChangeActiveTextEditor?(listener: (editor: vscode.TextEditor | undefined) => void): vscode.Disposable;
}

export interface EditorContextSnapshot {
  type: 'file' | 'selection';
  path: string;
  content: string;
  language: string;
  startLine?: number;
  endLine?: number;
  endCharacter?: number;
}

interface Candidate {
  editor: vscode.TextEditor;
  conversationId: string | null | undefined;
  navigationRevision: number;
}

/** Associates live editor identities with chat owners without retaining file bytes. */
export class EditorContextTracker {
  private _owners = new WeakMap<EditorContextOwner, Candidate>();
  private _pending: vscode.TextEditor | undefined;
  private readonly _listener: vscode.Disposable | undefined;
  private _disposed = false;

  constructor(private readonly _window: EditorContextWindow) {
    this._pending = _window.activeTextEditor;
    this._listener = _window.onDidChangeActiveTextEditor?.(editor => {
      // Focusing a chat can clear the active editor before the chat claims it.
      if (!this._disposed && editor) { this._pending = editor; }
    });
  }

  /** Claim observed code activity once, or an editor captured before opening a chat. */
  public focusPanel(owner: EditorContextOwner, explicitEditor?: vscode.TextEditor): void {
    if (this._disposed) { return; }
    const previous = this._owners.get(owner);
    if (previous && !this._sameScope(owner, previous)) { this._owners.delete(owner); }
    const editor = explicitEditor ?? this._pending;
    this._pending = undefined;
    if (!editor || !this._isVisible(editor)) { return; }
    // A captured handoff must not override newer, currently active code activity.
    if (this._window.activeTextEditor && this._window.activeTextEditor !== editor) { return; }
    this._owners.set(owner, {
      editor,
      conversationId: owner.currentConversationId,
      navigationRevision: owner.navigationRevision ?? 0,
    });
  }

  /** Read the exact current selection or unsaved document contents at send time. */
  public snapshot(owner: EditorContextOwner): EditorContextSnapshot | undefined {
    if (this._disposed) { return undefined; }
    const candidate = this._owners.get(owner);
    if (!candidate) { return undefined; }
    try {
      if (!this._sameScope(owner, candidate) || !this._isVisible(candidate.editor)) {
        this._owners.delete(owner);
        return undefined;
      }
      const { document, selection } = candidate.editor;
      const selected = !selection.isEmpty;
      return {
        type: selected ? 'selection' : 'file',
        path: document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString(),
        content: document.getText(selected ? selection : undefined),
        language: document.languageId,
        ...(selected ? { startLine: selection.start.line, endLine: selection.end.line, endCharacter: selection.end.character } : {}),
      };
    } catch {
      // A closing/virtual document can reject a read; optional context must not
      // prevent the user's message from being sent or reuse older bytes.
      this._owners.delete(owner);
      return undefined;
    }
  }

  public dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    this._listener?.dispose();
    this._pending = undefined;
    this._owners = new WeakMap();
  }

  private _sameScope(owner: EditorContextOwner, candidate: Candidate): boolean {
    return owner.currentConversationId === candidate.conversationId
      && (owner.navigationRevision ?? 0) === candidate.navigationRevision;
  }

  private _isVisible(editor: vscode.TextEditor): boolean {
    return !editor.document.isClosed && this._window.visibleTextEditors?.includes(editor) === true;
  }
}
