import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';

vi.mock('vscode', async () => {
  const base = await vi.importActual<any>('../helpers/mockVscode');
  const nativePath = await import('path');
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: Position, public end: Position) {} }
  class WorkspaceEdit {
    edits: any[] = [];
    replace(uri: any, range: any, text: string) { this.edits.push({ uri, range, text }); }
  }
  return { ...base, Position, Range, Selection: Range, WorkspaceEdit,
    // VS Code file URIs expose native separators through fsPath.
    Uri: { ...base.Uri, joinPath: (uri: any, ...segments: string[]) => base.Uri.file(nativePath.join(uri.fsPath, ...segments)) },
    workspace: { ...base.workspace, openTextDocument: vi.fn(), applyEdit: vi.fn() },
    window: { ...base.window, showTextDocument: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
    commands: { ...base.commands, executeCommand: vi.fn(async () => undefined) },
    env: { ...base.env, clipboard: { writeText: vi.fn(async () => {}) } },
  };
});

let root: string;
let host: any;
let posted: any[];
let editor: any;
const documents = new Map<string, any>();
function textDocument(file: string) {
  if (documents.has(file)) { return documents.get(file); }
  const doc = {
    uri: vscode.Uri.file(file), version: 1,
    getText: (range?: any) => { const text = fs.readFileSync(file, 'utf8'); return range ? text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)) : text; },
    get lineCount() { return doc.getText().split('\n').length; },
    lineAt: (line: number) => ({ text: doc.getText().split('\n')[line].replace(/\r$/, '') }),
    positionAt: (offset: number) => { const prefix = doc.getText().slice(0, offset).split('\n'); return new vscode.Position(prefix.length - 1, prefix.at(-1)!.length); },
    offsetAt: (position: any) => { const lines = doc.getText().split('\n'); return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character; },
  };
  documents.set(file, doc); return doc;
}
function write(relative: string, content: string) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function completedEdit(file: string, oldText: string, newText: string, id = 'edit-a') {
  return { id, name: 'Edit', status: 'completed', input: { file_path: file, old_string: oldText, new_string: newText } };
}
function conversation(toolCalls: any[]) { host._conversationManager.getConversation.mockReturnValue({ id: 'conversation-a', messages: [{ id: 'answer', role: 'assistant', toolCalls }] }); }
async function action(type: string, payload: any, panelId = 'a') { await host._handleMessage({ type, payload, panelId }); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc05-files-'));
  documents.clear(); vi.clearAllMocks(); posted = [];
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'project', index: 0 }];
  editor = { revealRange: vi.fn(), selection: undefined };
  vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor);
  vi.mocked(vscode.workspace.openTextDocument).mockImplementation(async (uri: any) => textDocument(uri.fsPath));
  vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: any) => {
    for (const replacement of edit.edits) {
      const doc = textDocument(replacement.uri.fsPath); const before = doc.getText();
      fs.writeFileSync(replacement.uri.fsPath, before.slice(0, doc.offsetAt(replacement.range.start)) + replacement.text + before.slice(doc.offsetAt(replacement.range.end)));
      doc.version++;
    }
    return true;
  });
  host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _sidebarId: 'a', _panelStates: new Map([['a', { currentConversationId: 'conversation-a' }], ['b', { currentConversationId: 'conversation-b' }]]),
    _conversationManager: { getConversation: vi.fn().mockReturnValue({ messages: [] }), exportMessageToMarkdown: vi.fn(() => 'original **Markdown**\n\n```ts\nconst café = "😀";\n```\n') },
    _postToPanel: (panelId: string, message: any) => posted.push({ panelId, ...message }),
  });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('PC-05 chat file actions against disposable files', () => {
  it('copies code bytes and uses only the requesting conversation for Markdown', async () => {
    const code = '\ufeffconst café = "😀";\r\n\t// tail\r\n';
    await action('copyToClipboard', code);
    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith(code);
    await action('copyMessageMarkdown', { messageId: 'answer' });
    expect(host._conversationManager.exportMessageToMarkdown).toHaveBeenCalledWith('conversation-a', 'answer');
    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith('original **Markdown**\n\n```ts\nconst café = "😀";\n```\n');
  });

  it('refuses an imported historical Edit before reading or modifying workspace files', async () => {
    const file = write('imported.ts', 'new\n');
    conversation([{ ...completedEdit(file, 'old\n', 'new\n'), historicalOnly: true }]);
    await action('revertFileEdit', { path: file, toolCallId: 'edit-a' });
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: 'fileReverted', payload: { success: false, error: expect.stringMatching(/import|histor/i) } });
  });

  it('refuses a proposal-only Edit even when its supplied status claims completion', async () => {
    const file = write('proposal.ts', 'new\n');
    conversation([{ ...completedEdit(file, 'old\n', 'new\n'), proposalOnly: true }]);
    await action('revertFileEdit', { path: file, toolCallId: 'edit-a' });
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: 'fileReverted', payload: { success: false, error: expect.stringMatching(/propos/i) } });
  });

  it.each(['ollama', 'localai'])('refuses a legacy %s proposal recorded as completed before proposal provenance existed', async provider => {
    const file = write('legacy-proposal.ts', 'new\n');
    host._conversationManager.getConversation.mockReturnValue({ id: 'conversation-a', provider: 'claude-code', messages: [{ id: 'legacy', role: 'assistant', provider, toolCalls: [completedEdit(file, 'old\n', 'new\n')] }] });
    host._providerManager = { getProviderInstance: (id: string) => ({ capabilities: { toolCallsAreProposals: id === provider } }) };
    await action('revertFileEdit', { path: file, toolCallId: 'edit-a' });
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(posted.at(-1).payload.success).toBe(false);
  });

  it('opens the exact spaced Unicode path and zero-based source line', async () => {
    const file = write('src/spaced café.ts', 'first\nsecond\nthird\n');
    await action('openFile', { path: 'src/spaced café.ts', line: 1 });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: file }));
    expect(editor.selection.start.line).toBe(1);
  });

  it('returns the actual replacement line separately for two edits in the same quoted path', async () => {
    const filePath = "src/quoted 'café'.ts";
    write(filePath, '// heading\r\nconst first = "new one";\r\n// unchanged\r\nconst second = "new two";\r\n');
    for (const [toolCallId, searchText, lineNumber] of [['edit-first', 'const first = "new one";', 2], ['edit-second', 'const second = "new two";', 4]] as const) {
      // Mirrors the live producer's legacy top-level message fields.
      await host._handleMessage({ type: 'getFileLineNumber', panelId: 'a', filePath, searchText, toolCallId });
      expect(posted.at(-1)).toEqual({ panelId: 'a', type: 'fileLineNumber', payload: { filePath, toolCallId, lineNumber } });
    }
  });

  it('preserves edit identity for nested source-location requests and missing-file fallback', async () => {
    await action('getFileLineNumber', { filePath: 'missing.ts', searchText: 'new text', toolCallId: 'missing-edit' });
    expect(posted.at(-1)).toEqual({ panelId: 'a', type: 'fileLineNumber', payload: { filePath: 'missing.ts', toolCallId: 'missing-edit', lineNumber: 1 } });
  });

  it('applies an exact CRLF/Unicode range without replacing unrelated file bytes', async () => {
    const file = write('range.ts', '\ufeff// user preface\r\nconst café = "old";\r\n// user tail\r\n');
    await action('applyEdit', { path: 'range.ts', content: 'const café = "😀";', startLine: 1, endLine: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe('\ufeff// user preface\r\nconst café = "😀";\r\n// user tail\r\n');
    expect(posted.at(-1).payload.success).toBe(true);
  });

  it('does not report Apply success when the editor rejects the edit', async () => {
    const file = write('rejected.ts', 'original\n'); vi.mocked(vscode.workspace.applyEdit).mockResolvedValueOnce(false);
    await action('applyEdit', { path: 'rejected.ts', content: 'replacement\n' });
    expect(fs.readFileSync(file, 'utf8')).toBe('original\n');
    expect(posted.at(-1)).toMatchObject({ type: 'editApplied', payload: { success: false } });
  });

  it('reverts only the identified tool replacement and retains prior and subsequent user edits', async () => {
    const file = write('revert.ts', '\ufeff// prior user edit\r\nconst café = "😀";\r\n// subsequent user edit\r\n');
    conversation([completedEdit(file, 'const café = "old";', 'const café = "😀";')]);
    await action('revertFileEdit', { path: 'revert.ts', toolCallId: 'edit-a' });
    expect(fs.readFileSync(file, 'utf8')).toBe('\ufeff// prior user edit\r\nconst café = "old";\r\n// subsequent user edit\r\n');
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: 'fileReverted', payload: { toolCallId: 'edit-a', success: true } });
  });

  for (const reason of ['missing-id', 'other-conversation', 'ambiguous', 'modified', 'failed-tool']) {
    it(`refuses ${reason} revert without changing bytes or invoking whole-file Git commands`, async () => {
      const content = reason === 'ambiguous' ? 'new\nnew\n' : reason === 'modified' ? 'new plus user change\n' : 'new\n';
      const file = write('safe.ts', content);
      const tool = completedEdit(file, 'old\n', 'new\n');
      if (reason === 'failed-tool') { tool.status = 'failed'; }
      conversation([tool]);
      if (reason === 'other-conversation') { host._conversationManager.getConversation.mockImplementation((id: string) => ({ messages: id === 'conversation-a' ? [{ toolCalls: [tool] }] : [] })); }
      await action('revertFileEdit', { path: 'safe.ts', toolCallId: reason === 'missing-id' ? undefined : 'edit-a' }, reason === 'other-conversation' ? 'b' : 'a');
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
      expect(posted.at(-1)).toMatchObject({ type: 'fileReverted', payload: { success: false } });
    });
  }

  it('rejects absolute and symlink edit targets outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc05-outside-'));
    try {
      const file = path.join(outside, 'outside.ts'); fs.writeFileSync(file, 'user data'); fs.symlinkSync(outside, path.join(root, 'linked'));
      for (const target of [file, 'linked/outside.ts']) {
        await action('applyEdit', { path: target, content: 'overwritten' });
        expect(fs.readFileSync(file, 'utf8')).toBe('user data');
        expect(posted.at(-1)).toMatchObject({ type: 'editApplied', payload: { success: false } });
      }
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('accepts ordinary filenames containing two dots inside the workspace', async () => {
    const file = write('notes..ts', 'original');
    await action('applyEdit', { path: 'notes..ts', content: 'replacement' });
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });

  for (const type of ['applyEdit', 'revertFileEdit']) {
    for (const change of ['user edit', 'conversation switch']) {
      it(`rejects a pending ${type} after a ${change}`, async () => {
        const file = write('pending.ts', 'agent change\n');
        conversation([completedEdit(file, 'original\n', 'agent change\n')]);
        vi.mocked(vscode.window.showTextDocument).mockImplementationOnce(async () => {
          if (change === 'user edit') { fs.writeFileSync(file, '// saved by user\nagent change\n'); textDocument(file).version++; }
          else { host._panelStates.get('a').currentConversationId = 'replacement-conversation'; }
          return editor;
        });
        await action(type, { path: 'pending.ts', content: 'replacement\n', toolCallId: 'edit-a' });
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
        expect(fs.readFileSync(file, 'utf8')).toBe(change === 'user edit' ? '// saved by user\nagent change\n' : 'agent change\n');
        expect(posted.at(-1).payload.success).toBe(false);
      });
    }
  }

  it('rejects a competing write while a revert waits, then permits recovery', async () => {
    const file = write('serialized.ts', 'new A\nnew B\n');
    conversation([completedEdit(file, 'old A', 'new A'), completedEdit(file, 'old B', 'new B', 'edit-b')]);
    let finish!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(vscode.window.showTextDocument).mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); return editor; });
    const pending = action('revertFileEdit', { path: 'serialized.ts', toolCallId: 'edit-a' }); await ready;
    await action('revertFileEdit', { path: 'serialized.ts', toolCallId: 'edit-b' });
    expect(posted.at(-1).payload.success).toBe(false);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled(); finish(); await pending;
    await action('revertFileEdit', { path: 'serialized.ts', toolCallId: 'edit-b' });
    expect(fs.readFileSync(file, 'utf8')).toBe('old A\nold B\n');
    expect(posted.at(-1).payload.success).toBe(true);
  });

  it('refuses a tool ID targeting a different file', async () => {
    const actual = write('actual.ts', 'new\n'); const other = write('other.ts', 'new\n');
    conversation([completedEdit(actual, 'old\n', 'new\n')]);
    await action('revertFileEdit', { path: 'other.ts', toolCallId: 'edit-a' });
    expect(fs.readFileSync(actual, 'utf8')).toBe('new\n'); expect(fs.readFileSync(other, 'utf8')).toBe('new\n');
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled(); expect(posted.at(-1).payload.success).toBe(false);
  });

  for (const kind of ['truncated', 'write', 'deletion', 'replace-all', 'running', 'duplicate-id']) {
    it(`refuses an unsupported ${kind} tool edit without guessing its inverse`, async () => {
      const file = write('unsupported.ts', 'new\n'); const tool: any = completedEdit(file, 'old\n', 'new\n');
      if (kind === 'truncated') { tool.truncated = true; }
      if (kind === 'write') { tool.name = 'Write'; tool.input.content = 'new\n'; }
      if (kind === 'deletion') { tool.input.new_string = ''; }
      if (kind === 'replace-all') { tool.input.replace_all = true; }
      if (kind === 'running') { tool.status = 'running'; }
      conversation(kind === 'duplicate-id' ? [tool, { ...tool }] : [tool]);
      await action('revertFileEdit', { path: 'unsupported.ts', toolCallId: 'edit-a' });
      expect(fs.readFileSync(file, 'utf8')).toBe('new\n'); expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
      expect(posted.at(-1).payload.success).toBe(false);
    });
  }

  for (const original of ['foobar', 'prefix foo']) {
  it(`refuses a second inverse when the original ${original} contains the replacement`, async () => {
    const file = write('repeat.ts', 'const value = foo;\n');
    conversation([completedEdit(file, original, 'foo')]);
    await action('revertFileEdit', { path: 'repeat.ts', toolCallId: 'edit-a' });
    expect(fs.readFileSync(file, 'utf8')).toBe(`const value = ${original};\n`);
    await action('revertFileEdit', { path: 'repeat.ts', toolCallId: 'edit-a' });
    expect(fs.readFileSync(file, 'utf8')).toBe(`const value = ${original};\n`); expect(posted.at(-1).payload.success).toBe(false);
  });
  }

  it('rejects an incomplete or out-of-bounds range rather than replacing the entire file', async () => {
    const file = write('bounds.ts', 'untouched\n');
    for (const range of [{ startLine: 0 }, { startLine: -1, endLine: 0 }, { startLine: 0, endLine: 99 }]) {
      await action('applyEdit', { path: 'bounds.ts', content: 'replacement', ...range });
      expect(fs.readFileSync(file, 'utf8')).toBe('untouched\n'); expect(posted.at(-1).payload.success).toBe(false);
    }
  });
});
