import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const credential = 'synthetic-cursor-spawn-credential';
const privatePrompt = `PRIVATE_SPAWN_PROMPT: review the unreleased feature using ${credential}.`;
const settings: Settings = { provider: 'cursor', model: 'auto', mode: 'quick-plan',
  accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' };
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearMockConfig();
});

describe('Cursor spawn failure privacy through public sends', () => {
  it.each(['missing executable', 'missing working directory'])('%s reports ENOENT without logging argv and recovers on the same panel', async fault => {
    clearMockConfig();
    vi.stubEnv('MYSTI_CURSOR_SPAWN_TOKEN', credential);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cursor-spawn-privacy-'));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const previousFolders = vscode.workspace.workspaceFolders;
    const setWorkspace = (cwd: string) => {
      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(cwd), name: 'owned', index: 0 }];
    };
    cleanups.push(() => { (vscode.workspace as any).workspaceFolders = previousFolders; });
    setWorkspace(fault === 'missing working directory' ? path.join(directory, 'missing-workspace') : directory);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new TestableCursorProvider();
    cleanups.push(() => provider.dispose());
    const executable = vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
    if (fault === 'missing executable') { executable.mockReturnValueOnce(path.join(directory, `missing-${credential}`)); }
    // The only successful executable is this disposable Node protocol fixture.
    // Keep the real spawn/error/stream/cleanup paths, including prompt argv.
    vi.spyOn(provider, 'buildCliArgs').mockReturnValue(['-e',
      "process.stdout.write(JSON.stringify({type:'assistant',content:'Owned recovery succeeded.'})+'\\n');", '--']);
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: string) => content);
    const attempts: Array<{ process: ChildProcess; errorCode?: string; closed: Promise<void> }> = [];
    const tracker = {
      registerProcess: (_panel: string, proc: ChildProcess) => {
        const attempt = { process: proc, errorCode: undefined as string | undefined,
          closed: new Promise<void>(resolve => proc.once('close', () => resolve())) };
        proc.on('error', (err: NodeJS.ErrnoException) => { attempt.errorCode = err.code; });
        attempts.push(attempt);
      },
      clearProcess: () => {},
    };
    const send = async (prompt: string, rotateCredential = false) => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.sendMessage(prompt, [], settings, null, undefined, 'owned-panel', tracker)) {
        chunks.push(chunk);
        if (rotateCredential && chunk.type === 'session_active') {
          vi.stubEnv('MYSTI_CURSOR_SPAWN_TOKEN', 'synthetic-cursor-replacement-credential');
        }
      }
      await attempts.at(-1)?.closed;
      return chunks;
    };

    const failed = await send(privatePrompt, true);
    setWorkspace(directory);
    const recovered = await send('Owned recovery request.');
    expect(attempts).toHaveLength(2);
    expect(attempts[0].errorCode).toBe('ENOENT');
    expect(attempts[0].process.pid).toBeUndefined();
    expect(attempts[1].errorCode).toBeUndefined();
    expect(typeof attempts[1].process.pid).toBe('number');
    const failures = failed.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error');
    expect(failures).toHaveLength(1);
    expect(failures[0].content).toContain('ENOENT');
    if (fault === 'missing executable') { expect(failures[0].content).toContain('[REDACTED]'); }
    expect(JSON.stringify(failures)).not.toContain(credential);
    expect(JSON.stringify(failures)).not.toContain('PRIVATE_SPAWN_PROMPT');
    expect(recovered.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([]);
    expect(recovered.some(chunk => chunk.type === 'text' && chunk.content === 'Owned recovery succeeded.')).toBe(true);

    // console.error(Error) inspects enumerable spawnargs, including -p and the
    // complete prompt. Check the actual inspected logger arguments, not String(Error).
    const logs = inspect([...log.mock.calls, ...error.mock.calls], { depth: null });
    expect(logs).not.toContain('PRIVATE_SPAWN_PROMPT');
    expect(logs).not.toContain(credential);
    expect(logs).not.toContain('spawnargs');
    expect(logs).toContain('ENOENT');
  });
});
