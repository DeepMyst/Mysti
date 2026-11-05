import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { inspect } from 'node:util';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';

// The owned Node fixture receives synthetic credentials only; no installed CLI,
// native configuration, account or network access is involved.
vi.mock('../../../src/utils/platform', async () => ({
  ...await vi.importActual<any>('../../../src/utils/platform'),
  getEnrichedEnv: (extra: NodeJS.ProcessEnv) => ({ ...extra, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }),
}));
const OLD_KEY = 'pb04_terminal_old_synthetic_credential_001';
const NEW_KEY = 'pb04_terminal_new_synthetic_credential_002';
const INVALID_MODEL = 'mysti-validation-invalid/model-does-not-exist-41ba16d26132c0b83b7ecbed';
const DIAGNOSTIC = `${INVALID_MODEL} is not a valid model ID`;
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 };
// Actual N10 terminal envelope, retaining its diagnostic/usage/model fields.
const capturedDone = { type: 'agent_event', event: { type: 'done', reason: 'error', text: DIAGNOSTIC, iterations: 1, usage } };
const capturedResult = { type: 'run_result', finishReason: 'error', iterations: 1, usage, aggregateUsage: usage, durationMs: 875, text: DIAGNOSTIC, model: { id: INVALID_MODEL, provider: 'openrouter' } };
let provider: TestableClineProvider;
let directory: string | undefined;
let previousFolders: typeof vscode.workspace.workspaceFolders;
let logs: ReturnType<typeof vi.spyOn>[];
const owned: Array<{ proc: ChildProcess; closed: Promise<void>; didClose: boolean }> = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  clearMockConfig();
  previousFolders = vscode.workspace.workspaceFolders;
  vi.stubEnv('OPENROUTER_API_KEY', OLD_KEY);
  logs = ['log', 'error', 'warn'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  provider = new TestableClineProvider();
});
afterEach(async () => {
  provider.dispose();
  try {
    for (const child of owned.splice(0)) {
      await Promise.race([child.closed, pause(1500)]);
      const emergency = !child.didClose;
      if (emergency) { child.proc.kill('SIGKILL'); await child.closed; }
      expect(emergency, 'Provider cleanup must close the actual owned fixture handle').toBe(false);
    }
  } finally {
    if (directory) { fs.rmSync(directory, { recursive: true, force: true }); directory = undefined; }
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: previousFolders, configurable: true });
    vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig(); clearConfigurationListeners();
  }
});
function parse(value: unknown, session = createClineSession()) {
  return provider.parseStreamLine(JSON.stringify(value), session);
}
function fixture() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-terminal-'));
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: [{ uri: vscode.Uri.file(directory), name: 'owned terminal fixture', index: 0 }], configurable: true });
  const script = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(script, `
'use strict';
const kind = process.argv[2];
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdout.on('error', error => { if (error.code !== 'EPIPE') throw error; });
process.on('SIGTERM', () => process.exit(0));
if (kind === 'success') {
  emit({type:'agent_event',event:{type:'content_start',contentType:'text',text:'Fresh successful reply.'}});
  emit({type:'agent_event',event:{type:'done',reason:'completed',text:'Fresh successful reply.'}});
  emit({type:'run_result',finishReason:'completed',text:'Fresh successful reply.'});
} else if (kind === 'partial-auth') {
  emit({type:'agent_event',event:{type:'content_start',contentType:'text',text:'Retained partial.\\n\\n\\n'}});
  const text = 'HTTP 401 Unauthorized for ' + process.env.OPENROUTER_API_KEY + ' and ${NEW_KEY}';
  emit({type:'agent_event',event:{type:'done',reason:'error',text}});
  emit({type:'run_result',finishReason:'error',text});
} else {
  if (kind !== 'result-only') emit(${JSON.stringify(capturedDone)});
  if (kind !== 'done-only') emit(${JSON.stringify(capturedResult)});
}
// Leave a short real process lifetime after output so early consumer return also
// exercises the existing issuing-process cleanup without a synthetic close.
setTimeout(() => process.exit(0), 60);
`);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation(settings => [script, settings.model]);
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Owned terminal fixture request');
  (provider as any)._cachedCliVersion = '3.0.61';
  const tracker = {
    registerProcess(_panel: string, proc: ChildProcess) {
      const row = { proc, didClose: false, closed: Promise.resolve() };
      row.closed = new Promise<void>(resolve => proc.once('close', () => { row.didClose = true; resolve(); }));
      owned.push(row);
    },
    clearProcess() {},
  };
  const send = async (kind: string, rotate = false) => {
    const chunks: StreamChunk[] = [];
    const settings = { mode: 'default', accessLevel: 'full-access', model: kind } as Settings;
    for await (const chunk of provider.sendMessage('Owned terminal fixture request', [], settings, null, undefined, 'same-panel', tracker)) {
      chunks.push(chunk);
      if (rotate && chunk.type === 'text') { vi.stubEnv('OPENROUTER_API_KEY', NEW_KEY); }
      // ChatViewProvider ends the stream on its first failure. It persists any
      // preceding partial separately and does not consume a later done chunk.
      if (chunk.type === 'error' || chunk.type === 'auth_error') { break; }
    }
    expect(owned.at(-1)?.proc.pid, 'An actual owned fixture process must spawn').toBeGreaterThan(0);
    return chunks;
  };
  return { send };
}

describe('Cline terminal failure diagnostics', () => {
  it.each(['paired', 'done-only', 'result-only'])('preserves native model error through public send (%s) and recovers on the same panel', async kind => {
    const h = fixture();
    const chunks = await h.send(kind);
    expect(chunks.filter(c => c.type === 'error')).toEqual([{ type: 'error', content: DIAGNOSTIC }]);
    expect(chunks.some(c => ['text', 'tool_use', 'tool_result', 'done'].includes(c.type))).toBe(false);
    const recovered = await h.send('success');
    expect(recovered.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'Fresh successful reply.' }]);
    expect(recovered.some(c => ['error', 'auth_error'].includes(c.type))).toBe(false);
    expect(recovered.filter(c => c.type === 'done')).toHaveLength(1);
  });

  it('preserves the partial and redacts issuing/current credentials before auth classification', async () => {
    const h = fixture();
    const chunks = await h.send('partial-auth', true);
    expect(chunks.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'Retained partial.\n\n\n' }]);
    expect(chunks.filter(c => c.type === 'auth_error')).toEqual([expect.objectContaining({ content: 'HTTP 401 Unauthorized for [REDACTED] and [REDACTED]', authCommand: 'cline auth' })]);
    const output = JSON.stringify(chunks) + logs.flatMap(log => log.mock.calls).map(args => args.map(arg => inspect(arg)).join(' ')).join('\n');
    for (const secret of [OLD_KEY, NEW_KEY]) expect(output).not.toContain(secret);
    expect((await h.send('success')).some(c => ['error', 'auth_error'].includes(c.type))).toBe(false);
  });

  it('emits the paired terminal failure once per request without swallowing a later request', () => {
    const first = createClineSession('same-panel');
    expect(parse(capturedDone, first)).toEqual({ type: 'error', content: DIAGNOSTIC });
    expect(parse(capturedResult, first)).toBeNull();
    expect(parse(capturedDone, first)).toBeNull();
    expect(first.lastUsageStats).toMatchObject({ input_tokens: 0, output_tokens: 0, normalized: true });
    expect(parse(capturedResult, createClineSession('same-panel'))).toEqual({ type: 'error', content: DIAGNOSTIC });
  });

  it.each([undefined, '', '   ', { message: 'not plain diagnostic text' }])('retains the reason fallback for absent/unusable terminal text (%j)', text => {
    expect(parse({ type: 'run_result', finishReason: 'error', text })).toEqual({ type: 'error', content: 'Cline stopped: error' });
    expect(parse({ type: 'agent_event', event: { type: 'done', reason: 'error', text } })).toEqual({ type: 'error', content: 'Cline stopped: error' });
  });

  it('keeps completed summaries suppressed and non-error stopping reasons actionable', () => {
    expect(parse({ type: 'agent_event', event: { type: 'done', reason: 'completed', text: 'Already streamed.' } })).toBeNull();
    expect(parse({ type: 'run_result', finishReason: 'completed', text: 'Already streamed.' })).toBeNull();
    expect(parse({ type: 'run_result', finishReason: 'max_iterations', text: 'Partial answer summary.' })).toEqual({ type: 'error', content: 'Cline stopped: max_iterations' });
  });
});
