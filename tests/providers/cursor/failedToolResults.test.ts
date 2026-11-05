// Result variants from the installed Cursor 2026.02.13 protobuf schema.
// All subprocesses below are owned Node fixtures; no Cursor account is used.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { createCursorSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const failures = [
  ['readToolCall', 'error', { path: '/owned/file', error: 'Read failed' }],
  ['readToolCall', 'fileNotFound', { path: '/owned/missing' }],
  ['readToolCall', 'permissionDenied', { path: '/owned/private' }],
  ['readToolCall', 'invalidFile', { path: '/owned/directory' }],
  ['shellToolCall', 'failure', { command: 'owned-test', exitCode: 2, stderr: 'Test failed' }],
  ['shellToolCall', 'timeout', { command: 'owned-test', timeoutMs: 50 }],
  ['shellToolCall', 'spawnError', { command: 'owned-test', error: 'Executable missing' }],
  ['shellToolCall', 'permissionDenied', { command: 'owned-test', error: 'Denied by policy' }],
  ['editToolCall', 'readPermissionDenied', { path: '/owned/file' }],
  ['editToolCall', 'writePermissionDenied', { path: '/owned/file', error: 'Cannot write' }],
  ['deleteToolCall', 'notFile', { path: '/owned/directory' }],
  ['deleteToolCall', 'fileBusy', { path: '/owned/busy' }],
  ['writeToolCall', 'noSpace', { path: '/owned/file' }],
  ['readToolCall', 'file_not_found', { path: '/owned/missing' }],
] as const;
const event = (id: string, type: string, subtype: string, data: object) => ({
  type: 'tool_call', subtype, call_id: id, tool_call: { [type]: data },
});
const providers: TestableCursorProvider[] = [];
function provider() { const p = new TestableCursorProvider(); providers.push(p); return p; }
afterEach(() => {
  providers.splice(0).forEach(p => p.dispose());
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig();
});

describe('Cursor failed tool outcomes', () => {
  it.each(failures)('retains %s %s as a failed tool with its diagnostic', (type, key, detail) => {
    const p = provider(), session = createCursorSession();
    const input = { path: '/owned/original' };
    const started = p.parseStreamLine(JSON.stringify(event('owned-call', type, 'started', { args: input })), session);
    const result = p.parseStreamLine(JSON.stringify(event('owned-call', type, 'completed', {
      result: { [key]: detail },
    })), session);
    expect(result).toMatchObject({ type: 'tool_result', toolCall: {
      id: 'owned-call', name: started!.toolCall!.name, input, status: 'failed',
    } });
    expect(JSON.parse(result!.toolCall!.output!)).toEqual({ [key]: detail });
    expect(session.activeToolCalls.size).toBe(0);
  });

  it('keeps successful content and existing rejected diagnostics intact', () => {
    const p = provider(), session = createCursorSession();
    for (const success of ['', 'Success mentions an error', { content: 'File content' }]) {
      expect(p.parseStreamLine(JSON.stringify(event('success', 'readToolCall', 'completed', {
        result: { success },
      })), session)?.toolCall).toMatchObject({ status: 'completed',
        output: typeof success === 'string' ? success : JSON.stringify(success, null, 2) });
    }
    expect(p.parseStreamLine(JSON.stringify(event('rejected', 'writeToolCall', 'completed', {
      result: { rejected: 'User rejected the edit' },
    })), session)?.toolCall).toMatchObject({ status: 'failed', output: 'User rejected the edit' });
  });

  it('preserves parent output, redacts failed diagnostics against the issuing child and recovers', async () => {
    clearMockConfig();
    const credential = 'synthetic-owned-cursor-tool-credential';
    vi.stubEnv('MYSTI_CURSOR_TOOL_TOKEN', credential);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cursor-tool-'));
    const release = path.join(directory, 'release');
    const folders = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
    const events = failures.flatMap(([type, key, detail], index) => [
      event(`failure-${index}`, type, 'started', { args: { path: '/owned/original' } }),
      event(`failure-${index}`, type, 'completed', { result: { [key]: detail } }),
    ]);
    events.push(event('private-error', 'readToolCall', 'completed', {
      result: { error: { error: `Authentication failed inside this tool: ${credential}` } },
    }), event('success', 'readToolCall', 'completed', {
      result: { success: `Successful content remains verbatim: ${credential}` },
    }));
    const source = `const fs=require('node:fs');
const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');
const safety=setTimeout(()=>process.exit(92),5000);
emit({type:'assistant',content:'Before the tool failure.'});
const gate=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;
 clearInterval(gate);${JSON.stringify(events)}.forEach(emit);
 emit({type:'assistant',content:'The parent response continued.'});
 emit({type:'result',subtype:'success',is_error:false});clearTimeout(safety);
},10);`;
    const p = provider();
    vi.spyOn(p, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(p, 'buildCliArgs').mockReturnValue(['-e', source, '--']);
    vi.spyOn(p as any, 'buildPromptAsync').mockResolvedValue('Owned tool protocol fixture.');
    const children: Array<{ child: ChildProcess; exit?: unknown; close?: unknown; closed: Promise<void> }> = [];
    const tracker = { registerProcess(_panel: string, child: ChildProcess) {
      const row = { child, closed: Promise.resolve() } as (typeof children)[number];
      row.closed = new Promise(resolve => child.once('close', (code, signal) => { row.close = { code, signal }; resolve(); }));
      child.once('exit', (code, signal) => { row.exit = { code, signal }; }); children.push(row);
    }, clearProcess() {} };
    const settings: Settings = { provider: 'cursor', model: 'auto', mode: 'quick-plan',
      accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' };
    const responses: StreamChunk[][] = [];
    try {
      for (let request = 0; request < 2; request++) {
        const chunks: StreamChunk[] = []; responses.push(chunks);
        for await (const chunk of p.sendMessage('Owned tool fixture.', [], settings, null, undefined, 'same-panel', tracker)) {
          chunks.push(chunk);
          if (chunk.type === 'text' && chunk.content === 'Before the tool failure.') {
            vi.stubEnv('MYSTI_CURSOR_TOOL_TOKEN', 'synthetic-replacement-cursor-credential');
            fs.writeFileSync(release, 'continue');
          }
        }
        await children.at(-1)!.closed;
        expect(chunks.filter(c => c.type === 'text').map(c => c.content)).toEqual([
          'Before the tool failure.', 'The parent response continued.',
        ]);
        expect(chunks.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([]);
        expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
        const tools = chunks.filter(c => c.type === 'tool_result').map(c => c.toolCall!);
        expect(tools.slice(0, failures.length).map(t => t.status)).toEqual(failures.map(() => 'failed'));
        expect(tools.find(t => t.id === 'private-error')).toMatchObject({ status: 'failed',
          output: JSON.stringify({ error: { error: 'Authentication failed inside this tool: [REDACTED]' } }, null, 2) });
        expect(tools.find(t => t.id === 'success')).toMatchObject({ status: 'completed',
          output: `Successful content remains verbatim: ${credential}` });
        vi.stubEnv('MYSTI_CURSOR_TOOL_TOKEN', credential);
        fs.unlinkSync(release);
      }
      expect(children).toHaveLength(2);
      for (const child of children) expect(child).toMatchObject({ exit: { code: 0, signal: null }, close: { code: 0, signal: null } });
    } finally {
      for (const row of children) {
        if (row.child.exitCode === null && row.child.signalCode === null) row.child.kill('SIGKILL');
        await row.closed;
      }
      const receipt = process.env.PB06_CURSOR_TOOL_RECEIPT;
      if (receipt) fs.appendFileSync(receipt, JSON.stringify({
        children: children.map(({ child, exit, close }) => ({ pid: child.pid, exit, close })),
        responses, nativeCursorInvocations: 0,
      }) + '\n');
      (vscode.workspace as any).workspaceFolders = folders;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
