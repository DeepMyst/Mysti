import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mention } from '../../src/types';
import { observeFileHandleReads } from '../helpers/fileHandleReads';
import { agentMention, collectMentionChunks, createMentionSettings, createTestMentionRouter, fileMention } from '../helpers/mentionFactory';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

let directory: string;
let workspaceDescriptor: PropertyDescriptor | undefined;
let first: string;
let second: string;
let fixture: ReturnType<typeof createTestMentionRouter>;
const firstText = 'export const first = "FILE_CONTEXT_α";\n';
const secondText = 'export const second = "FILE_CONTEXT_β";\n';

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-file-resolution-')));
  workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [
    { uri: vscode.Uri.file(directory), name: 'owned', index: 0 },
  ] });
  first = path.join(directory, 'first.ts');
  second = path.join(directory, 'second.ts');
  fs.writeFileSync(first, firstText);
  fs.writeFileSync(second, secondText);
  fixture = createTestMentionRouter();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (workspaceDescriptor) { Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceDescriptor); }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('file mention resolution cancellation through the existing router', () => {
  it('does not let a stale generator entry cancel an existing run or capture approval', async () => {
    const readPaths: string[] = [];
    observeFileHandleReads(async (file, read) => { readPaths.push(file); return read(); });
    const active = fixture.router.processMentions('Current request', [fileMention(first)], [], createMentionSettings(), null, 'owned');
    try {
      expect((await active.next()).value?.type).toBe('files_resolved');
      const runs = (fixture.router as unknown as { _activeRuns: Map<string, { controller: AbortController }> })._activeRuns;
      const current = runs.get('owned');
      expect(current).toBeDefined();
      const captured = [...fixture.mockPM.capturedApprovalPanels];
      const stale = fixture.router.processMentions('Stale request', [fileMention(second)], [], createMentionSettings(), null, 'owned', undefined, () => true);
      expect(await collectMentionChunks(stale)).toEqual([]);
      expect(runs.get('owned')).toBe(current);
      expect(current!.controller.signal.aborted).toBe(false);
      expect(fixture.mockPM.capturedApprovalPanels).toEqual(captured);
      expect(fixture.mockPM.cancelledPanelIds).toEqual([]);
      expect(fixture.mockPM.disposedChildren).toEqual([]);
      expect(readPaths).toEqual([first]);
      expect((await active.next()).value?.type).toBe('main_start');
    } finally { await active.return(undefined); }
  });

  it('does no warning or workspace-state work after cancellation at the files_resolved yield', async () => {
    let cancelled = false;
    const diagnostics = vi.spyOn(vscode.languages, 'getDiagnostics');
    const extensionLookup = vi.spyOn(vscode.extensions, 'getExtension');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = path.join(directory, 'missing.ts');
    const mentions: Mention[] = [fileMention(first), fileMention(missing),
      { type: 'problems', value: 'problems', displayName: '@problems', startIndex: 0, endIndex: 9 },
      { type: 'git', value: 'git', displayName: '@git', startIndex: 10, endIndex: 14 }];
    const stream = fixture.router.processMentions('Review files and state', mentions, [], createMentionSettings(), null, 'owned', undefined, () => cancelled);
    try {
      const next = await stream.next();
      expect(next.value?.type).toBe('files_resolved');
      expect(next.value?.resolvedFiles?.map(item => item.content)).toEqual([firstText]);
      cancelled = true;
      expect(await collectMentionChunks(stream)).toEqual([]);
      expect(diagnostics).not.toHaveBeenCalled();
      expect(extensionLookup).not.toHaveBeenCalled();
      expect(fixture.mockPM.sendCalls).toEqual([]);
    } finally { await stream.return(undefined); }
  });

  it('retains exact file bytes and ordinary main_start without agent dispatch', async () => {
    const chunks = await collectMentionChunks(fixture.router.processMentions(
      'Review these files', [fileMention(first), fileMention(second)], [], createMentionSettings(), null, 'owned'));
    expect(chunks.map(chunk => chunk.type)).toEqual(['files_resolved', 'main_start']);
    expect(chunks[0].resolvedFiles?.map(item => [item.path, item.content, item.language]))
      .toEqual([[first, firstText, 'typescript'], [second, secondText, 'typescript']]);
    expect(fixture.mockPM.sendCalls).toEqual([]);
  });

  for (const rejectRead of [false, true]) {
    it(`does not read the next file after Stop while the first read ${rejectRead ? 'rejects' : 'resolves'}`, async () => {
      const entered = deferred();
      const release = deferred();
      const readPaths: string[] = [];
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      observeFileHandleReads(async (file, read) => {
        readPaths.push(file);
        if (file === first) {
          entered.resolve();
          await release.promise;
          if (rejectRead) { throw new Error('Owned first-read rejection after Stop'); }
        }
        return read();
      });
      const pending = collectMentionChunks(fixture.router.processMentions(
        'Review these files', [fileMention(first), fileMention(second)], [], createMentionSettings(), null, 'owned'));
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Router ended before the held read'); })]);
        fixture.router.cancelSubAgents('owned', []);
        release.resolve();
        expect(await pending).toEqual([]);
        expect(readPaths).toEqual([first]);
        expect(warning).not.toHaveBeenCalled();
        expect(fixture.mockPM.sendCalls).toEqual([]);
      } finally { release.resolve(); await pending; }
    });
  }
});

describe('file-only context resolution without agent lifecycle side effects', () => {
  it('filters non-file mentions and preserves an already active run and approval registration', async () => {
    const stream = fixture.router.processMentions('Review', [fileMention(first)], [], createMentionSettings(), null, 'existing');
    try {
      expect((await stream.next()).value?.type).toBe('files_resolved');
      const runs = (fixture.router as unknown as { _activeRuns: Map<string, { controller: AbortController }> })._activeRuns;
      const active = runs.get('existing');
      expect(active).toBeDefined();
      const before = [...runs.entries()];
      const approval = async () => false;
      fixture.mockPM.nativeApprovalPanels.set('existing-child', approval);
      const input: readonly Mention[] = Object.freeze([
        Object.freeze(agentMention('claude', 'claude-code')),
        Object.freeze({ type: 'git' as const, value: 'git', displayName: '@git', startIndex: 8, endIndex: 12 }),
        Object.freeze(fileMention(second)),
      ]);
      const original = structuredClone(input);
      const readPaths: string[] = [];
      observeFileHandleReads(async (file, read) => { readPaths.push(file); return read(); });
      const result = await fixture.router.resolveFileContext(input);
      expect(result?.items.map(item => [item.path, item.content])).toEqual([[second, secondText]]);
      expect(result?.failedFiles).toEqual([]);
      expect(readPaths).toEqual([second]);
      expect(input).toEqual(original);
      expect([...runs.entries()]).toEqual(before);
      expect(runs.get('existing')).toBe(active);
      expect(active!.controller.signal.aborted).toBe(false);
      expect(fixture.mockPM.capturedApprovalPanels).toEqual(['existing']);
      expect([...fixture.mockPM.nativeApprovalPanels.entries()]).toEqual([['existing-child', approval]]);
      expect(fixture.mockPM.sendCalls).toEqual([]);
      expect(fixture.mockPM.cancelledPanelIds).toEqual([]);
      expect(fixture.mockPM.disposedChildren).toEqual([]);
    } finally { await stream.return(undefined); }
  });

  it('returns an empty result for no file references without filesystem or provider work', async () => {
    const read = vi.spyOn(fs.promises, 'open');
    expect(await fixture.router.resolveFileContext([agentMention('claude', 'claude-code')]))
      .toEqual({ items: [], failedFiles: [] });
    expect(read).not.toHaveBeenCalled();
    expect(fixture.mockPM.capturedApprovalPanels).toEqual([]);
    expect(fixture.mockPM.sendCalls).toEqual([]);
  });

  it('returns undefined when already cancelled, before any file read', async () => {
    const read = vi.spyOn(fs.promises, 'open');
    expect(await fixture.router.resolveFileContext([fileMention(first)], () => true)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(fixture.mockPM.capturedApprovalPanels).toEqual([]);
  });

  it('preserves ordinary failed-file reporting and continues to the next readable file', async () => {
    const missing = path.join(directory, 'missing.ts');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await fixture.router.resolveFileContext([fileMention(missing), fileMention(first)]);
    expect(result?.failedFiles).toEqual([missing]);
    expect(result?.items.map(item => [item.path, item.content])).toEqual([[first, firstText]]);
    expect(warning).toHaveBeenCalledOnce();
    expect(fixture.mockPM.sendCalls).toEqual([]);
  });

  it('preserves the existing first-workspace-root relative-path policy', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [
      { uri: vscode.Uri.file(directory), name: 'owned', index: 0 },
    ] });
    try {
      const result = await fixture.router.resolveFileContext([fileMention('first.ts')]);
      expect(result?.items.map(item => [item.path, item.content])).toEqual([[first, firstText]]);
      expect(result?.failedFiles).toEqual([]);
    } finally {
      if (descriptor) { Object.defineProperty(vscode.workspace, 'workspaceFolders', descriptor); }
    }
  });

  for (const rejectRead of [false, true]) {
    it(`discards a cancelled helper result and stops enumeration when a held read ${rejectRead ? 'rejects' : 'resolves'}`, async () => {
      const entered = deferred();
      const release = deferred();
      let cancelled = false;
      const readPaths: string[] = [];
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      observeFileHandleReads(async (file, read) => {
        readPaths.push(file);
        if (file === first) {
          entered.resolve(); await release.promise;
          if (rejectRead) { throw new Error('Owned cancelled helper read'); }
        }
        return read();
      });
      const pending = fixture.router.resolveFileContext([fileMention(first), fileMention(second)], () => cancelled);
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Resolver ended before the held read'); })]);
        cancelled = true; release.resolve();
        expect(await pending).toBeUndefined();
        expect(readPaths).toEqual([first]);
        expect(warning).not.toHaveBeenCalled();
        expect(fixture.mockPM.capturedApprovalPanels).toEqual([]);
        expect(fixture.mockPM.sendCalls).toEqual([]);
      } finally { release.resolve(); await pending; }
    });
  }

  it('does not cancel an independent helper call when another owner is revoked', async () => {
    const entered = deferred();
    const release = deferred();
    let cancelled = false;
    observeFileHandleReads(async (file, read) => {
      if (file === first) { entered.resolve(); await release.promise; }
      return read();
    });
    const pending = fixture.router.resolveFileContext([fileMention(first)], () => cancelled);
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Resolver ended before the held read'); })]);
      const current = await fixture.router.resolveFileContext([fileMention(second)]);
      cancelled = true; release.resolve();
      expect(await pending).toBeUndefined();
      expect(current?.items.map(item => [item.path, item.content])).toEqual([[second, secondText]]);
      expect(fixture.mockPM.capturedApprovalPanels).toEqual([]);
      expect(fixture.mockPM.cancelledPanelIds).toEqual([]);
    } finally { release.resolve(); await pending; }
  });

  for (const heldFile of ['first', 'second'] as const) {
    for (const change of ['remove', 'replace'] as const) {
      it(`discards all file context when workspace roots ${change} during the ${heldFile} read`, async () => {
        const entered = deferred(), release = deferred();
        const readPaths: string[] = [];
        observeFileHandleReads(async (file, read) => {
          readPaths.push(file);
          if (file === (heldFile === 'first' ? first : second)) { entered.resolve(); await release.promise; }
          return read();
        });
        const pending = fixture.router.resolveFileContext([fileMention(first), fileMention(second)]);
        try {
          expect(await Promise.race([entered.promise.then(() => true), pending.then(() => false)])).toBe(true);
          Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: change === 'remove' ? [] : [
            { uri: vscode.Uri.file(path.join(directory, 'different')), name: 'replacement', index: 0 },
          ] });
          release.resolve();
          expect(await pending).toEqual({ items: [], failedFiles: [first, second] });
          expect(readPaths).toEqual(heldFile === 'first' ? [first] : [first, second]);
          expect(fixture.mockPM.sendCalls).toEqual([]);
          expect(fixture.mockPM.cancelledPanelIds).toEqual([]);
        } finally { release.resolve(); await pending; }
      });
    }
  }

  it('keeps an observed workspace revocation when roots are restored during handle close', async () => {
    const originalOpen = fs.promises.open.bind(fs.promises);
    const enteredClose = deferred(), releaseClose = deferred();
    const readPaths: string[] = [];
    let closed = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      let firstPositiveRead = true;
      vi.spyOn(handle, 'read').mockImplementation(async (...options) => {
        const result = await read(...options);
        if (result.bytesRead > 0 && firstPositiveRead) {
          firstPositiveRead = false;
          readPaths.push(String(args[0]));
          Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [] });
        }
        return result;
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close(); closed++; enteredClose.resolve(); await releaseClose.promise;
      });
      return handle;
    });
    const pending = fixture.router.resolveFileContext([fileMention(first), fileMention(second)], () => false);
    try {
      expect(await Promise.race([enteredClose.promise.then(() => true), pending.then(() => false)])).toBe(true);
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [
        { uri: vscode.Uri.file(directory), name: 'owned', index: 0 },
      ] });
      releaseClose.resolve();
      expect(await pending).toEqual({ items: [], failedFiles: [first, second] });
      expect(readPaths).toEqual([first]); expect(closed).toBe(1);
      expect(fixture.mockPM.cancelledPanelIds).toEqual([]);
    } finally { releaseClose.resolve(); await pending; }
  });
});
