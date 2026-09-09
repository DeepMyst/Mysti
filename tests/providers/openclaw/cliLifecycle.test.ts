/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Attachment, Settings, StreamChunk } from '../../../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function collect(stream: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  return chunks;
}

const settings: Settings = {
  provider: 'openclaw', mode: 'default', accessLevel: 'full-access',
  model: '', thinkingLevel: 'none', contextMode: 'auto',
};

describe('OpenClaw CLI uses the shared request lifecycle', () => {
  let provider: TestableOpenClawProvider;
  let directory: string;
  let folders: typeof vscode.workspace.workspaceFolders;
  beforeEach(() => {
    clearMockConfig();
    setMockConfig('openclawUseGateway', false);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-cli-test-'));
    folders = vscode.workspace.workspaceFolders;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: [{ uri: vscode.Uri.file(directory), name: 'fixture', index: 0 }], configurable: true,
    });
    provider = new TestableOpenClawProvider();
  });
  afterEach(() => {
    provider.dispose();
    vi.restoreAllMocks();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: folders });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function harness(script: string) {
    const args = provider.buildCliArgs.bind(provider);
    vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(provider, 'buildCliArgs').mockImplementation((config, session) => ['-e', script, '--', ...args(config, session)]);
    const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('complete prompt');
    const active = new Map<string, ChildProcess>();
    const spawned: ChildProcess[] = [];
    const tracker = {
      registerProcess: vi.fn((panel: string, proc: ChildProcess) => { active.set(panel, proc); spawned.push(proc); }),
      clearProcess: vi.fn((panel: string, proc: ChildProcess) => { if (active.get(panel) === proc) { active.delete(panel); } }),
    };
    const send = (panel = 'panel', attachments?: Attachment[]): AsyncGenerator<StreamChunk> => provider.sendMessage(
      'hello', [], settings, null, undefined, panel, tracker, undefined, attachments,
    );
    return { send, prompt, tracker, spawned, active };
  }

  const readPrompt = "const fs = require('node:fs'); const argv = process.argv; const file = argv[argv.indexOf('--message-file') + 1]; const prompt = fs.readFileSync(file, 'utf8');";

  it('the child reads its prepared prompt immediately and receives materialized attachments', async () => {
    const h = harness(readPrompt + "console.log(JSON.stringify({type:'text',content:JSON.stringify({prompt,file,argv})}));");
    let attachmentPath = '';
    h.prompt.mockImplementation(async (...args: unknown[]) => {
      attachmentPath = (args[6] as Attachment[])[0].filePath!;
      expect(fs.readFileSync(attachmentPath, 'utf8')).toBe('abc');
      return 'user task';
    });
    const attachment: Attachment = {
      id: 'shared', type: 'file', fileName: 'note.txt', mimeType: 'text/plain', size: 3, base64Data: 'YWJj',
    };
    const chunks = await collect(h.send('panel', [attachment]));
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    const response = JSON.parse(chunks.find(chunk => chunk.type === 'text')!.content!);
    expect(response.prompt).toContain('user task');
    expect(response.prompt).toContain(`File "note.txt": ${JSON.stringify(attachmentPath)}`);
    expect(response.argv.filter((arg: string) => arg === '--message-file')).toHaveLength(1);
    expect(response.argv).not.toContain('--message');
    expect(response.argv).not.toContain('--session-id');
    expect(fs.existsSync(response.file)).toBe(false);
    expect(fs.existsSync(attachmentPath)).toBe(false);
    expect(attachment.filePath).toBeUndefined();
    expect(h.active.size).toBe(0);
  });

  it('pretty JSON retains payloads and usage and emits exactly one done', async () => {
    const h = harness("process.stdout.write(JSON.stringify({payloads:[{text:'first'},{text:'second'}],meta:{agentMeta:{usage:{input:7,output:3},sessionId:'cli-session'}}},null,2));");
    expect(await collect(h.send())).toEqual([
      { type: 'text', content: 'first' }, { type: 'text', content: 'second' },
      { type: 'done', usage: { input_tokens: 7, output_tokens: 3 } },
    ]);
  });

  it('silent nonzero exit has one error and one done', async () => {
    const h = harness('process.exit(9);');
    expect(await collect(h.send())).toEqual([
      { type: 'error', content: 'OpenClaw exited with code 9' }, { type: 'done' },
    ]);
  });

  it('spawn failure releases the prompt file and still emits one done', async () => {
    const h = harness('');
    vi.mocked(provider.getCliPath).mockReturnValue(path.join(directory, 'missing-executable'));
    const chunks = await collect(h.send());
    expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
    expect((provider as any)._messageFiles.size).toBe(0);
    expect(h.active.size).toBe(0);
  });

  it('Stop wakes a silent read and cleans the captured child and prompt', async () => {
    const h = harness("console.log(JSON.stringify({type:'text',content:'ready'})); setInterval(() => {}, 1000);");
    const stream = h.send();
    expect((await stream.next()).value).toEqual({ type: 'text', content: 'ready' });
    const proc = h.spawned[0];
    const exited = new Promise(resolve => proc.once('close', resolve));
    const pending = stream.next();
    provider.cancelCurrentRequest('panel');
    expect((await pending).done).toBe(true);
    await exited;
    expect((provider as any)._messageFiles.size).toBe(0);
    expect(h.active.size).toBe(0);
  });

  it('a cancelled pre-spawn write cannot spawn or delete its replacement prompt', async () => {
    const h = harness(readPrompt + "console.log(JSON.stringify({type:'text',content:prompt})); setInterval(() => {}, 1000);");
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const written = deferred<string>();
    const release = deferred<void>();
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (...args) => {
      await writeFile(...args);
      written.resolve(String(args[0]));
      await release.promise;
    });
    const first = collect(h.send());
    const firstFile = await written.promise;
    provider.cancelCurrentRequest('panel');
    const replacement = h.send();
    expect((await replacement.next()).value).toMatchObject({ type: 'text' });
    const replacementDirectory = [...(provider as any)._messageFiles.get('panel') as Set<string>]
      .find(dir => dir !== path.dirname(firstFile))!;
    release.resolve();
    await first;
    expect(h.spawned).toHaveLength(1);
    expect(fs.existsSync(firstFile)).toBe(false);
    expect(fs.readFileSync(path.join(replacementDirectory, 'message.txt'), 'utf8')).toBe('complete prompt');
    expect(h.active.get('panel')).toBe(h.spawned[0]);
    const exited = new Promise(resolve => h.spawned[0].once('close', resolve));
    await replacement.return(undefined);
    await exited;
    expect(fs.existsSync(replacementDirectory)).toBe(false);
  });
});
