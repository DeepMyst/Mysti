import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import type { Settings, StreamChunk } from '../../../src/types';

const settings = { provider: 'github-copilot', model: 'auto', mode: 'quick-plan',
  accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' } as Settings;
const credential = 'synthetic-owned-copilot-secret-value';
const providers: TestableCopilotProvider[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  providers.splice(0).forEach(provider => provider.dispose());
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function request(stderr: string, exitCode: number, split = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-copilot-stderr-'));
  const folders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  cleanups.push(() => {
    (vscode.workspace as any).workspaceFolders = folders;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('MYSTI_COPILOT_TEST_TOKEN', credential);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const provider = new TestableCopilotProvider();
  providers.push(provider);
  const source = `
const message=${JSON.stringify(stderr)};
process.stdout.write(JSON.stringify({type:'assistant.message_delta',data:{deltaContent:'Useful partial.'}})+'\\n');
process.stdin.once('data',()=>{
  process.stdin.destroy();
  const finish=()=>{process.exitCode=${exitCode};};
  if(${split}) {
    const cut=message.indexOf(${JSON.stringify(credential)})+16;
    process.stderr.write(message.slice(0,cut),()=>setTimeout(()=>process.stderr.write(message.slice(cut),finish),25));
  } else process.stderr.write(message,finish);
});`;
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildCliArgs').mockReturnValue(['-e', source, '--']);
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('owned fixture');
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  const tracker = {
    registerProcess: (_panel: string, proc: ChildProcess) => {
      child = proc;
      closed = new Promise<void>(resolve => proc.once('close', () => resolve()));
    },
    clearProcess: () => {},
  };
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage('owned fixture', [], settings, null, undefined, 'owned-redaction', tracker)) {
    chunks.push(chunk);
    if (chunk.type === 'text') {
      vi.stubEnv('MYSTI_COPILOT_TEST_TOKEN', 'synthetic-replacement-credential');
      child!.stdin!.end('continue');
    }
  }
  await closed;
  return { chunks, logs: JSON.stringify([...log.mock.calls, ...error.mock.calls]) };
}

describe('Copilot stderr diagnostics', () => {
  it('redacts complete credentials from process logs as well as public errors', async () => {
    const { chunks, logs } = await request(`Owned request failed: ${credential}`, 1);
    expect(logs).not.toContain(credential);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([
      { type: 'error', content: 'Owned request failed: [REDACTED]' },
    ]);
  });

  it('does not log credential fragments or repeat the raw authentication error', async () => {
    const { chunks, logs } = await request(`Authentication failed: ${credential}`, 1, true);
    expect(logs).not.toContain(credential.slice(0, 16));
    expect(logs).not.toContain(credential.slice(16));
    expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([
      { type: 'auth_error', content: 'Authentication failed: [REDACTED]', authCommand: 'copilot', providerName: 'GitHub Copilot' },
    ]);
  });

  it('still reports a redacted stderr authentication error after an otherwise successful exit', async () => {
    const { chunks, logs } = await request(`Authentication failed: ${credential}`, 0);
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(['Useful partial.']);
    expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([
      { type: 'auth_error', content: 'Authentication failed: [REDACTED]', authCommand: 'copilot', providerName: 'GitHub Copilot' },
    ]);
    expect(logs).not.toContain(credential);
    expect(chunks.some(chunk => chunk.type === 'done')).toBe(false);
  });
});
