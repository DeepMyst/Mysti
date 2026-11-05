import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const providers: TestableCopilotProvider[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  providers.splice(0).forEach(provider => provider.dispose());
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearMockConfig();
});

function provider() {
  const value = new TestableCopilotProvider();
  providers.push(value);
  return value;
}

// Copilot 1.0.94 schema: failed completion data needs toolCallId/success;
// error.message is required inside error, while result is optional. toolName
// belongs on the start event, not on ToolExecutionCompleteData.
const event = (type: string, data: Record<string, unknown>) => ({
  id: randomUUID(), timestamp: '2026-10-18T12:00:00.000Z', parentId: null, type, data,
});
const start = (id: string, file: string) => event('tool.execution_start', {
  toolCallId: id, toolName: 'view', arguments: { path: file },
});
const complete = (data: Record<string, unknown>) => event('tool.execution_complete', data);

describe('Copilot failed tool diagnostics', () => {
  it('retains error.message and the started tool identity when failure has no result', () => {
    const p = provider(), session = createCopilotSession();
    p.parseStreamLine(JSON.stringify(start('missing-file', '/owned/missing.txt')), session);
    expect(p.parseStreamLine(JSON.stringify(complete({
      toolCallId: 'missing-file', success: false,
      error: { message: 'File /owned/missing.txt does not exist.', code: 'ENOENT' },
    })), session)).toEqual({
      type: 'tool_result', toolCall: {
        id: 'missing-file', name: 'view', input: { path: '/owned/missing.txt' },
        output: 'File /owned/missing.txt does not exist.', status: 'failed',
      },
    });
    expect(session.activeToolCalls.size).toBe(0);
  });

  it('preserves existing result content on failed and successful completions', () => {
    const p = provider(), session = createCopilotSession();
    for (const success of [false, true]) {
      const id = `existing-${success}`;
      p.parseStreamLine(JSON.stringify(start(id, '/owned/existing.txt')), session);
      expect(p.parseStreamLine(JSON.stringify(complete({
        toolCallId: id, success, result: { content: 'Existing result content.' },
        error: { message: 'Supplemental diagnostic.' },
      })), session)).toEqual({
        type: 'tool_result', toolCall: {
          id, name: 'view', input: { path: '/owned/existing.txt' },
          output: 'Existing result content.', status: success ? 'completed' : 'failed',
        },
      });
    }
    expect(session.activeToolCalls.size).toBe(0);
  });

  it('redacts the issuing request diagnostic without promoting a failed tool to a chat error', async () => {
    const credential = 'synthetic-owned-copilot-tool-credential';
    vi.stubEnv('MYSTI_COPILOT_TOOL_TOKEN', credential);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-copilot-tool-error-'));
    const folders = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
    cleanups.push(() => {
      (vscode.workspace as any).workspaceFolders = folders;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const failedPath = path.join(directory, 'missing.txt'), successPath = path.join(directory, 'existing.txt');
    const successfulContent = `Successful tool content remains verbatim: ${credential}`;
    const existingFailedContent = `Existing failed result content remains verbatim: ${credential}`;
    const events = [
      event('assistant.message_delta', { messageId: 'before', deltaContent: 'Before the tool failure.' }),
      start('failed-view', failedPath),
      complete({ toolCallId: 'failed-view', success: false,
        error: { message: `Authentication failed inside this tool: ${credential}`, code: 'TOOL_AUTH' } }),
      start('failed-with-result', successPath),
      complete({ toolCallId: 'failed-with-result', success: false,
        result: { content: existingFailedContent }, error: { message: 'Supplemental failure.' } }),
      start('successful-view', successPath),
      complete({ toolCallId: 'successful-view', success: true, result: { content: successfulContent } }),
      event('assistant.message_delta', { messageId: 'after', deltaContent: 'The parent response continued.' }),
    ];
    // An owned Node child emits the schema-valid protocol. No Copilot process,
    // account, filesystem tool, or network action is invoked by this fixture.
    const source = `const events=${JSON.stringify(events)};
const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');
const safety=setTimeout(()=>process.exit(92),5000);
emit(events[0]);
process.stdin.once('data',()=>{events.slice(1).forEach(emit);clearTimeout(safety);process.stdin.destroy();});`;
    const p = provider();
    (p as any)._cachedCliVersion = '1.0.94';
    vi.spyOn(p, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(p, 'buildCliArgs').mockReturnValue(['-e', source, '--']);
    vi.spyOn(p as any, 'buildPromptAsync').mockResolvedValue('Owned tool protocol fixture.');
    let child: ChildProcess | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let closed: Promise<void> | undefined;
    const tracker = {
      registerProcess: (_panel: string, proc: ChildProcess) => {
        child = proc;
        proc.once('exit', (code, signal) => { exit = { code, signal }; });
        closed = new Promise<void>(resolve => proc.once('close', (code, signal) => {
          close = { code, signal }; resolve();
        }));
      },
      clearProcess: () => {},
    };
    const settings: Settings = { provider: 'github-copilot', model: 'auto', mode: 'quick-plan',
      accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' };
    const chunks: StreamChunk[] = [];
    for await (const chunk of p.sendMessage('Owned tool protocol fixture.', [], settings, null, undefined, 'tool-diagnostic', tracker)) {
      chunks.push(chunk);
      if (chunk.type === 'text' && chunk.content === 'Before the tool failure.') {
        vi.stubEnv('MYSTI_COPILOT_TOOL_TOKEN', 'synthetic-replacement-copilot-tool-credential');
        child!.stdin!.end('continue');
      }
    }
    await closed;
    expect(child?.pid).toBeGreaterThan(0);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(close).toEqual({ code: 0, signal: null });
    expect(chunks.filter(chunk => chunk.type === 'tool_result').map(chunk => chunk.toolCall)).toEqual([
      { id: 'failed-view', name: 'view', input: { path: failedPath },
        output: 'Authentication failed inside this tool: [REDACTED]', status: 'failed' },
      { id: 'failed-with-result', name: 'view', input: { path: successPath },
        output: existingFailedContent, status: 'failed' },
      { id: 'successful-view', name: 'view', input: { path: successPath },
        output: successfulContent, status: 'completed' },
    ]);
    expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([]);
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual([
      'Before the tool failure.', 'The parent response continued.',
    ]);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  });
});
