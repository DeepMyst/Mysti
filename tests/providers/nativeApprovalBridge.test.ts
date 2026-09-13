import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NativeApprovalRequest } from '../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../src/types';
import { TestableHermesProvider, TestableKimiProvider } from '../helpers/providerFactory';
import { STREAM_INACTIVITY_TIMEOUT_MS } from '../../src/constants';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const settings: Settings = {
  provider: 'hermes', mode: 'ask-before-edit', accessLevel: 'ask-permission',
  thinkingLevel: 'none', contextMode: 'auto', model: '',
};

async function collect(gen: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) { chunks.push(chunk); }
  return chunks;
}

describe.each([
  ['Hermes', () => new TestableHermesProvider()],
  ['Kimi', () => new TestableKimiProvider()],
] as const)('%s real ACP fixture approvals', (_name, createProvider) => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) { await cleanup(); } vi.restoreAllMocks(); });

  function harness(closeAfter = '') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-acp-test-'));
    const provider = createProvider();
    const originalFolders = vscode.workspace.workspaceFolders;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: [{ uri: vscode.Uri.file(directory), name: 'fixture', index: 0 }], writable: true, configurable: true,
    });
    const originalBuild = provider.buildPersistentCliArgs.bind(provider);
    vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((config, session) => {
      originalBuild(config, session);
      return [path.resolve(__dirname, '../fixtures/acpPermissionAgent.cjs'), directory, session.panelId, closeAfter];
    });
    vi.spyOn(provider as unknown as { buildPromptAsync(): Promise<string> }, 'buildPromptAsync').mockResolvedValue('fixture');
    const suspend = vi.spyOn(provider, 'suspendProcess');
    const owned: ChildProcess[] = [];
    const closed: Promise<void>[] = [];
    const internal = provider as unknown as { _spawnCliProcess(...args: unknown[]): ChildProcess };
    const spawn = internal._spawnCliProcess.bind(provider);
    vi.spyOn(internal, '_spawnCliProcess').mockImplementation((...args) => {
      const child = spawn(...args);
      owned.push(child);
      closed.push(new Promise(resolve => child.once('close', () => resolve())));
      return child;
    });
    cleanups.push(async () => {
      provider.dispose();
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: originalFolders });
      for (const child of owned) {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      }
      // Windows holds a child's working directory until its handles close.
      await Promise.all(closed);
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const send = (panelId: string) => collect(provider.sendMessage('fixture', [], settings, null, undefined, panelId));
    return { provider, suspend, send, marker: (panel: string) => path.join(directory, panel) };
  }

  it.each(['initialize', 'session/new'])('a closed ACP pipe after %s ends the turn with an error', async method => {
    const h = harness(method);
    const handler = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    const chunks = await h.send('closed-pipe');
    expect(chunks.some(chunk => chunk.type === 'error' && /EPIPE|broken pipe/i.test(chunk.content))).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(fs.existsSync(h.marker('closed-pipe'))).toBe(false);
  });

  it('blocks the real child side effect until approval and reuses a native ID in the next turn', async () => {
    const h = harness();
    const requested = deferred<NativeApprovalRequest>();
    const approval = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
      requested.resolve(request); return approval.promise;
    } });
    const completion = h.send('panel');
    const request = await requested.promise;
    expect(request.toolCall).toMatchObject({ id: 'fixture-tool', name: 'Bash', input: {} });
    expect(request.defaultDecision).toBe('ask');
    expect(fs.existsSync(h.marker('panel'))).toBe(false);
    expect(h.suspend).not.toHaveBeenCalled();
    approval.resolve(true);
    expect((await completion).at(-1)?.type).toBe('done');
    expect(fs.readFileSync(h.marker('panel'), 'utf8')).toBe('executed\n');

    let second!: NativeApprovalRequest;
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async value => { second = value; return true; } });
    await h.send('panel');
    expect(second.nativeRequestId).toBe(request.nativeRequestId);
    expect(second.id).not.toBe(request.id);
    expect(fs.readFileSync(h.marker('panel'), 'utf8')).toBe('executed\nexecuted\n');
  });

  it('denial and another panel approval affect only their issuing process', async () => {
    const h = harness();
    const seen = new Map<string, NativeApprovalRequest>();
    const a = deferred<boolean>(); const b = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
      seen.set(request.panelId, request);
      return request.panelId === 'a' ? a.promise : b.promise;
    } });
    const first = h.send('a'); const second = h.send('b');
    await vi.waitFor(() => expect(seen.size).toBe(2));
    expect(fs.existsSync(h.marker('a'))).toBe(false);
    expect(fs.existsSync(h.marker('b'))).toBe(false);
    a.resolve(false); await first;
    expect(fs.existsSync(h.marker('a'))).toBe(false);
    expect(seen.get('b')!.signal.aborted).toBe(false);
    b.resolve(true); await second;
    expect(fs.readFileSync(h.marker('b'), 'utf8')).toBe('executed\n');
  });

  it('Stop cancels the pending request and late approval cannot affect a replacement process', async () => {
    const h = harness();
    const seen = deferred<NativeApprovalRequest>();
    const approval = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
      seen.resolve(request); return approval.promise;
    } });
    const first = h.send('panel');
    const request = await seen.promise;
    h.provider.cancelCurrentRequest('panel');
    await first;
    expect(request.signal.aborted).toBe(true);
    expect(fs.existsSync(h.marker('panel'))).toBe(false);

    h.provider.setNativeApprovalHost({ handlerForPanel: () => async () => false });
    const replacement = h.send('panel');
    approval.resolve(true);
    await replacement;
    expect(fs.existsSync(h.marker('panel'))).toBe(false);
    expect(h.suspend).not.toHaveBeenCalled();
  });

  it('waiting for native approval does not consume the stream inactivity deadline', async () => {
    vi.useFakeTimers();
    const h = harness();
    const seen = deferred<NativeApprovalRequest>();
    const approval = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
      seen.resolve(request); return approval.promise;
    } });
    let finished = false;
    const completion = h.send('panel').then(chunks => { finished = true; return chunks; });
    const request = await seen.promise;
    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
    expect(finished).toBe(false);
    expect(request.signal.aborted).toBe(false);
    expect(fs.existsSync(h.marker('panel'))).toBe(false);
    approval.resolve(true);
    await completion;
    expect(fs.readFileSync(h.marker('panel'), 'utf8')).toBe('executed\n');
  });
});
