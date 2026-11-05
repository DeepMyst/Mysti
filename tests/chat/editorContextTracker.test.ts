/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { EditorContextTracker, type EditorContextOwner } from '../../src/chat/EditorContextTracker';

function editor(name: string, scheme = 'file') {
  const state = { whole: `unsaved ${name}`, selected: 'selected العربية 👩🏽‍💻\nnext line' };
  const document = {
    uri: { scheme, fsPath: `/workspace/${name}`, toString: () => `${scheme}:${name}` },
    languageId: 'typescript', isClosed: false,
    getText: vi.fn((range?: unknown) => range ? state.selected : state.whole),
  };
  const value = { document, selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  return { value, editor: value as unknown as vscode.TextEditor, state, document };
}

function environment(initial?: vscode.TextEditor, visible: vscode.TextEditor[] = initial ? [initial] : []) {
  let listener: ((editor: vscode.TextEditor | undefined) => void) | undefined;
  const dispose = vi.fn(() => { listener = undefined; });
  const window = {
    activeTextEditor: initial,
    visibleTextEditors: visible,
    onDidChangeActiveTextEditor: vi.fn((next: (editor: vscode.TextEditor | undefined) => void) => {
      listener = next; return { dispose };
    }),
  };
  return {
    window, dispose,
    activate(next?: vscode.TextEditor) { window.activeTextEditor = next; listener?.(next); },
  };
}

describe('EditorContextTracker', () => {
  it('hands code activity to one chat and preserves each chat when only chat focus changes', () => {
    const a = editor('a.ts'), b = editor('b.ts');
    const env = environment(a.editor, [a.editor, b.editor]);
    const tracker = new EditorContextTracker(env.window);
    const chatA = {}, chatB = {};
    env.activate(); tracker.focusPanel(chatA);
    expect(tracker.snapshot(chatA)?.path).toBe('/workspace/a.ts');
    tracker.focusPanel(chatB);
    expect(tracker.snapshot(chatB)).toBeUndefined();
    env.activate(b.editor); env.activate(); tracker.focusPanel(chatB);
    tracker.focusPanel(chatA);
    expect(tracker.snapshot(chatA)?.path).toBe('/workspace/a.ts');
    expect(tracker.snapshot(chatB)?.path).toBe('/workspace/b.ts');
  });

  it('snapshot does not silently consume unclaimed code activity', () => {
    const a = editor('a.ts'), env = environment(a.editor);
    const tracker = new EditorContextTracker(env.window);
    expect(tracker.snapshot({})).toBeUndefined();
    const owner = {}; tracker.focusPanel(owner);
    expect(tracker.snapshot(owner)?.path).toBe('/workspace/a.ts');
  });

  it('captures a new panel editor before focus shifts and permits an explicit same-editor refresh', () => {
    const a = editor('a.ts'), env = environment(a.editor);
    const tracker = new EditorContextTracker(env.window);
    const owner = { currentConversationId: 'first', navigationRevision: 0 };
    env.activate(); tracker.focusPanel(owner, a.editor);
    expect(tracker.snapshot(owner)?.content).toBe('unsaved a.ts');
    owner.currentConversationId = 'second';
    expect(tracker.snapshot(owner)).toBeUndefined();
    // Same editor can remain active without another identity-change event.
    env.window.activeTextEditor = a.editor;
    tracker.focusPanel(owner, env.window.activeTextEditor);
    expect(tracker.snapshot(owner)?.content).toBe('unsaved a.ts');
    const other = {}; tracker.focusPanel(other);
    expect(tracker.snapshot(other)).toBeUndefined();
  });

  for (const change of ['conversation', 'navigation'] as const) {
    it(`${change} invalidates fallback without binding it to the successor scope`, () => {
      const a = editor('a.ts'), env = environment(a.editor);
      const tracker = new EditorContextTracker(env.window);
      const owner: EditorContextOwner = { currentConversationId: null };
      tracker.focusPanel(owner); env.activate();
      if (change === 'conversation') owner.currentConversationId = 'new';
      else owner.navigationRevision = 1;
      tracker.focusPanel(owner);
      expect(tracker.snapshot(owner)).toBeUndefined();
      tracker.focusPanel(owner);
      expect(tracker.snapshot(owner)).toBeUndefined();
      env.activate(a.editor); tracker.focusPanel(owner);
      expect(tracker.snapshot(owner)?.path).toBe('/workspace/a.ts');
    });
  }

  it('does not transfer context to a replacement owner with the same scope values', () => {
    const a = editor('a.ts'), env = environment(a.editor);
    const tracker = new EditorContextTracker(env.window);
    const original = { currentConversationId: 'same', navigationRevision: 0 };
    tracker.focusPanel(original);
    const replacement = { ...original }; tracker.focusPanel(replacement);
    expect(tracker.snapshot(replacement)).toBeUndefined();
    expect(tracker.snapshot(original)?.path).toBe('/workspace/a.ts');
  });

  for (const invalidation of ['closed', 'hidden', 'replaced editor with same URI'] as const) {
    it(`drops a ${invalidation} candidate rather than retaining bytes`, () => {
      const a = editor('a.ts'), env = environment(a.editor);
      const tracker = new EditorContextTracker(env.window), owner = {};
      tracker.focusPanel(owner);
      if (invalidation === 'closed') a.document.isClosed = true;
      else env.window.visibleTextEditors = invalidation === 'hidden' ? [] : [editor('a.ts').editor];
      expect(tracker.snapshot(owner)).toBeUndefined();
      expect(a.document.getText).not.toHaveBeenCalled();
      a.document.isClosed = false; env.window.visibleTextEditors = [a.editor];
      expect(tracker.snapshot(owner)).toBeUndefined();
    });
  }

  it('rejects a pending editor superseded by a different current editor', () => {
    const a = editor('a.ts'), b = editor('b.ts'), env = environment(a.editor, [a.editor, b.editor]);
    const tracker = new EditorContextTracker(env.window), owner = {};
    env.window.activeTextEditor = b.editor;
    tracker.focusPanel(owner);
    expect(tracker.snapshot(owner)).toBeUndefined();
    tracker.focusPanel(owner, b.editor);
    expect(tracker.snapshot(owner)?.path).toBe('/workspace/b.ts');
  });

  it('rejects an explicit stale capture when a different code editor is currently active', () => {
    const a = editor('a.ts'), b = editor('b.ts'), env = environment(a.editor, [a.editor, b.editor]);
    const tracker = new EditorContextTracker(env.window), owner = {};
    env.activate(b.editor);
    tracker.focusPanel(owner, a.editor);
    expect(tracker.snapshot(owner)).toBeUndefined();
    expect(a.document.getText).not.toHaveBeenCalled();
    tracker.focusPanel(owner, b.editor);
    expect(tracker.snapshot(owner)?.path).toBe('/workspace/b.ts');
  });

  it('reads the exact current selection and then whole unsaved bytes only at snapshot time', () => {
    const a = editor('a.ts'), env = environment(a.editor);
    const tracker = new EditorContextTracker(env.window), owner = {};
    tracker.focusPanel(owner);
    expect(a.document.getText).not.toHaveBeenCalled();
    a.value.selection = { isEmpty: false, start: { line: 3, character: 2 }, end: { line: 4, character: 9 } };
    expect(tracker.snapshot(owner)).toEqual({ type: 'selection', path: '/workspace/a.ts', content: a.state.selected,
      language: 'typescript', startLine: 3, endLine: 4, endCharacter: 9 });
    expect(a.document.getText).toHaveBeenLastCalledWith(a.value.selection);
    a.state.whole = 'new unsaved full document\r\n日本語 🧪'; a.value.selection.isEmpty = true;
    expect(tracker.snapshot(owner)).toEqual({ type: 'file', path: '/workspace/a.ts', content: a.state.whole, language: 'typescript' });
    expect(a.document.getText).toHaveBeenLastCalledWith(undefined);
    expect(a.document.getText).toHaveBeenCalledTimes(2);
  });

  it('keeps the untitled URI instead of inventing a filesystem path', () => {
    const a = editor('Untitled-1', 'untitled'), env = environment(a.editor);
    const tracker = new EditorContextTracker(env.window), owner = {};
    tracker.focusPanel(owner);
    expect(tracker.snapshot(owner)).toEqual({ type: 'file', path: 'untitled:Untitled-1', content: 'unsaved Untitled-1', language: 'typescript' });
  });

  it('captures an exclusive next-line column zero without changing CRLF selection bytes', () => {
    const a = editor('a.ts'), env = environment(a.editor);
    const text = 'first العربية 👩🏽‍💻\r\nsecond line\r\nthird';
    a.document.getText.mockImplementation((range?: unknown) => range ? text.slice(0, text.indexOf('second')) : text);
    a.value.selection = { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
    const tracker = new EditorContextTracker(env.window), owner = {};
    tracker.focusPanel(owner);
    expect(tracker.snapshot(owner)).toEqual({ type: 'selection', path: '/workspace/a.ts',
      language: 'typescript', content: 'first العربية 👩🏽‍💻\r\n', startLine: 0, endLine: 1, endCharacter: 0 });
    expect(a.document.getText).toHaveBeenCalledExactlyOnceWith(a.value.selection);
    expect(a.value.selection.end).toEqual({ line: 1, character: 0 });
  });

  it('omits unreadable live documents without throwing or reusing an earlier snapshot', () => {
    const a = editor('a.ts'), b = editor('b.ts'), env = environment(a.editor, [a.editor, b.editor]);
    const tracker = new EditorContextTracker(env.window), owner = {};
    tracker.focusPanel(owner);
    expect(tracker.snapshot(owner)?.content).toBe('unsaved a.ts');
    a.document.getText.mockImplementationOnce(() => { throw new Error('document disposed during read'); });
    expect(tracker.snapshot(owner)).toBeUndefined();
    expect(tracker.snapshot(owner)).toBeUndefined();
    env.activate(b.editor); tracker.focusPanel(owner);
    expect(tracker.snapshot(owner)?.content).toBe('unsaved b.ts');
  });

  it('requires a visible open editor and tolerates missing optional window facilities', () => {
    const a = editor('a.ts'), owner = {};
    const noEvents = new EditorContextTracker({ activeTextEditor: a.editor });
    noEvents.focusPanel(owner, a.editor);
    expect(noEvents.snapshot(owner)).toBeUndefined();
    noEvents.dispose();
    const closed = environment(a.editor); a.document.isClosed = true;
    const tracker = new EditorContextTracker(closed.window);
    tracker.focusPanel(owner);
    expect(tracker.snapshot(owner)).toBeUndefined();
  });

  it('disposes its listener and all candidates without allowing later claims', () => {
    const a = editor('a.ts'), env = environment(a.editor);
    const tracker = new EditorContextTracker(env.window), owner = {};
    tracker.focusPanel(owner);
    tracker.dispose(); tracker.dispose();
    env.activate(a.editor); tracker.focusPanel(owner, a.editor);
    expect(env.dispose).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot(owner)).toBeUndefined();
    expect(a.document.getText).not.toHaveBeenCalled();
  });
});
