import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import * as vscode from 'vscode';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(),
  readOpenClawToken: () => undefined,
  getEnrichedEnv: () => ({ PATH: process.env.PATH || '', MYSTI_OPENCLAW_TEST_TOKEN: process.env.MYSTI_OPENCLAW_TEST_TOKEN }),
}));
const OLD = 'synthetic_openclaw_original_credential_5c91';
const NEW = 'synthetic_openclaw_replacement_credential_8d63';
const PRIVATE_ARG = 'PRIVATE_OPENCLAW_ARGUMENT';
const settings = { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings;
type Scenario = { stderr?: string; stdout?: string; records?: unknown[]; code?: number; split?: boolean; hang?: boolean; stopDiagnostic?: boolean; stderrByteSplit?: number; stdoutByteSplit?: number };
let directory: string, previousFolders: typeof vscode.workspace.workspaceFolders;
let provider: TestableOpenClawProvider, logSpies: ReturnType<typeof vi.spyOn>[];
const children: Array<{ proc: ChildProcess; close?: unknown; closed: Promise<void>; args: string[] }> = [];
const streams: AsyncGenerator<StreamChunk>[] = [];
const pending: Promise<unknown>[] = [];
let onSpawn: ((proc: ChildProcess) => void) | undefined;
const logged = () => inspect(logSpies.flatMap(spy => spy.mock.calls), { depth: null });
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned privacy fixture deadline')), 6000); })]); }
  finally { clearTimeout(timer); }
}
function workspace(cwd: string) { (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(cwd), name: 'owned', index: 0 }]; }
const childSource = `
const fs=require('fs'),cfg=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for(const record of cfg.records||[])emit(record);
if(cfg.stdout){
 const bytes=Buffer.from(cfg.stdout);
 if(cfg.stdoutByteSplit){process.stdout.write(bytes.subarray(0,cfg.stdoutByteSplit));setTimeout(()=>process.stdout.write(bytes.subarray(cfg.stdoutByteSplit)),30)}
 else process.stdout.write(bytes);
}
if(cfg.stopDiagnostic){
 process.on('SIGTERM',()=>{process.stdout.write(JSON.stringify({type:'error',message:'Stopped worker: '+process.env.MYSTI_OPENCLAW_TEST_TOKEN})+'\\n',()=>process.exit(0))});
 fs.writeFileSync(process.argv[1]+'.ready','ready');setTimeout(()=>process.exit(93),4000);
}else if(cfg.hang){setTimeout(()=>process.exit(93),4000)}else{
 const message=cfg.stderr||'',finish=()=>{process.exitCode=cfg.code??0};
 if(cfg.stderrByteSplit){const bytes=Buffer.from(message);process.stderr.write(bytes.subarray(0,cfg.stderrByteSplit));setTimeout(()=>process.stderr.write(bytes.subarray(cfg.stderrByteSplit),finish),30)}
 else if(cfg.split){const cut=Math.floor(message.length/2);process.stderr.write(message.slice(0,cut));setTimeout(()=>process.stderr.write(message.slice(cut),finish),30)}
 else process.stderr.write(message,finish);
}
`;
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-privacy-')));
  previousFolders = vscode.workspace.workspaceFolders; workspace(directory);
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
  vi.stubEnv('MYSTI_OPENCLAW_TEST_TOKEN', OLD); onSpawn = undefined;
  logSpies = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  provider = new TestableOpenClawProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Owned private prompt content');
});
afterEach(async () => {
  provider.dispose();
  for (const row of children) if (row.proc.exitCode === null && row.proc.signalCode === null) row.proc.kill('SIGKILL');
  await bounded(Promise.all(children.map(row => row.closed)));
  await bounded(Promise.allSettled(pending.splice(0)));
  for (const stream of streams.splice(0)) await bounded(stream.return(undefined as never));
  const receipt = process.env.PB07_OPENCLAW_PRIVACY_RECEIPT;
  if (receipt) fs.appendFileSync(receipt, JSON.stringify({ children: children.map(({ proc, close }) => ({ pid: proc.pid, close })),
    allChildrenClosed: children.every(row => row.close !== undefined), nativeProviderCliInvocations: 0, paidRequests: 0 }) + '\n');
  children.splice(0); vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig();
  (vscode.workspace as any).workspaceFolders = previousFolders;
  fs.rmSync(directory, { recursive: true, force: true });
});
async function send(scenario: Scenario = {}) {
  const file = path.join(directory, `case-${children.length}.json`); fs.writeFileSync(file, JSON.stringify(scenario));
  const args = ['-e', childSource, '--', file, 'agent', '--json', '--session-key', 'owned-session', PRIVATE_ARG];
  vi.spyOn(provider, 'buildCliArgs').mockReturnValue(args);
  const tracker = { registerProcess: (_panel: string, proc: ChildProcess) => {
    const row = { proc, args: [...proc.spawnargs], close: undefined as unknown, closed: Promise.resolve() };
    row.closed = new Promise(resolve => proc.once('close', (code, signal) => { row.close = { code, signal }; resolve(); }));
    children.push(row);
    // The child has inherited OLD; all public handling now sees NEW.
    vi.stubEnv('MYSTI_OPENCLAW_TEST_TOKEN', NEW); onSpawn?.(proc);
  }, clearProcess() {} };
  const stream = provider.sendMessage('Owned private prompt content', [], settings, null, undefined, 'owned-privacy', tracker);
  streams.push(stream); const chunks: StreamChunk[] = [];
  const operation = (async () => { for await (const chunk of stream) chunks.push(chunk); })(); pending.push(operation);
  await bounded(operation); await bounded(children.at(-1)!.closed); return chunks;
}
function expectPrivate(chunks: StreamChunk[]) {
  const diagnostics = logged() + JSON.stringify(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error' || chunk.toolCall?.status === 'failed'));
  expect(diagnostics).not.toContain(OLD); expect(diagnostics).not.toContain(NEW); expect(logged()).not.toContain(PRIVATE_ARG);
}
const errors = (chunks: StreamChunk[]) => chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error');

it('correlates and releases interleaved standalone results through a real owned CLI child', async () => {
  const chunks = await send({ records: [
    { type: 'tool_call', status: 'started', id: 'read-id', name: 'read', input: { path: 'owned.txt' } },
    { type: 'tool_call', status: 'started', id: 'edit-id', name: 'edit', input: { path: 'other.txt' } },
    { type: 'tool_result', tool_id: 'edit-id', content: 'Edited' },
    { type: 'tool_result', tool_call_id: 'read-id', content: `Failed ${OLD}`, success: false },
    { type: 'text', content: 'Owned final reply' },
  ] });
  const results = chunks.filter(c => c.type === 'tool_result').map(c => c.toolCall);
  expect(results).toMatchObject([
    { id: 'edit-id', name: 'edit', input: { path: 'other.txt' }, status: 'completed', output: 'Edited' },
    { id: 'read-id', name: 'read', input: { path: 'owned.txt' }, status: 'failed', output: 'Failed [REDACTED]' },
  ]);
  expect((provider as any)._panelSessions.get('owned-privacy').activeToolCalls.size).toBe(0);
  expect(chunks).toContainEqual({ type: 'text', content: 'Owned final reply' });
  expectPrivate(chunks);
});


it('identifies a crashed process when native stderr only contains routine progress and recovers', async () => {
  const chunks = await send({ stderr: `[provider-transport-fetch] response status=200 key=${OLD}\n`, code: 1 });
  expectPrivate(chunks); expect(errors(chunks)).toHaveLength(1);
  expect(errors(chunks)[0]).toMatchObject({ type: 'error', content: `OpenClaw exited with code 1.\n[provider-transport-fetch] response status=200 key=[REDACTED]\n` });
  expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
  expect(chunks.filter(c => c.type === 'text')).toHaveLength(0);
  const recovered = await send({ records: [{ type: 'text', content: 'Recovered after process failure' }] });
  expect(errors(recovered)).toHaveLength(0); expect(recovered).toContainEqual({ type: 'text', content: 'Recovered after process failure' });
});
it('retains native authentication classification with an explicit process exit reason', async () => {
  const chunks = await send({ stderr: `FailoverError: 401 rejected ${OLD}\n`, code: 7 });
  expectPrivate(chunks); expect(errors(chunks)).toHaveLength(1);
  expect(errors(chunks)[0]).toMatchObject({ type: 'auth_error', content: 'OpenClaw exited with code 7.\nFailoverError: 401 rejected [REDACTED]\n', authCommand: 'openclaw onboard' });
});
it('preserves a partial reply alongside the explicit process exit reason', async () => {
  const chunks = await send({ records: [{ type: 'text', content: 'Useful before crash' }], stderr: `Routine native progress ${OLD}\n`, code: 8 });
  expectPrivate(chunks); expect(errors(chunks)).toHaveLength(1);
  expect(errors(chunks)[0].content).toBe('OpenClaw exited with code 8.\nRoutine native progress [REDACTED]\n');
  expect(chunks).toContainEqual({ type: 'text', content: 'Useful before crash' });
  expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
});

describe('OpenClaw issuing-process diagnostic privacy', () => {
  it.each(['Worker failed', 'HTTP 401 Unauthorized'])('redacts %s stderr after credentials rotate', async prefix => {
    const chunks = await send({ stderr: `${prefix}: ${OLD}; current ${NEW}\n`, code: 7 });
    expectPrivate(chunks); expect(errors(chunks)).toHaveLength(1);
    expect(errors(chunks)[0]).toMatchObject({ type: prefix.includes('401') ? 'auth_error' : 'error', content: expect.stringContaining('[REDACTED]') });
  });
  it('never logs partial credential fragments from split stderr', async () => {
    const chunks = await send({ stderr: OLD, split: true, code: 7 });
    expect(logged()).not.toContain(OLD.slice(0, Math.floor(OLD.length / 2)));
    expect(logged()).not.toContain(OLD.slice(Math.floor(OLD.length / 2))); expectPrivate(chunks);
    expect(errors(chunks)[0].content).toBe('OpenClaw exited with code 7.\n[REDACTED]');
  });
  it('redacts stderr warnings after a successful reply', async () => {
    const stderr = `Warning: ${OLD}`, cut = Math.floor(stderr.length / 2) - 'Warning: '.length;
    const chunks = await send({ records: [{ type: 'text', content: 'Useful reply' }], stderr, code: 0, split: true });
    expect(logged()).not.toContain(OLD.slice(0, cut)); expect(logged()).not.toContain(OLD.slice(cut));
    expectPrivate(chunks); expect(chunks).toContainEqual({ type: 'text', content: 'Useful reply' });
  });
  it('redacts empty-success diagnostics', async () => {
    const chunks = await send({ stderr: `No response: ${OLD}`, code: 0 });
    expectPrivate(chunks); expect(errors(chunks)[0].content).toContain('No response');
  });
  it.each(['message', 'error', 'object'])('normalizes and redacts a structured %s error', async format => {
    const message = `HTTP 401 Unauthorized: ${OLD}; ${NEW}`;
    const event = format === 'object' ? { type: 'error', error: { message, code: 'AUTH_FAILURE' } } : { type: 'error', [format]: message };
    const chunks = await send({ records: [event], code: 0 });
    expectPrivate(chunks); expect(errors(chunks)).toHaveLength(1); expect(errors(chunks)[0].type).toBe('auth_error');
    expect(typeof errors(chunks)[0].content).toBe('string');
  });
  it('preserves a partial reply and reports one redacted terminal protocol error', async () => {
    const chunks = await send({ records: [{ type: 'text', content: 'Useful partial reply' }, { type: 'error', message: `Worker failed: ${OLD}` }], code: 7 });
    expectPrivate(chunks); expect(chunks).toContainEqual({ type: 'text', content: 'Useful partial reply' }); expect(errors(chunks)).toHaveLength(1);
  });
  it('treats failed plain stdout as a redacted diagnostic rather than reply text', async () => {
    const chunks = await send({ stdout: `HTTP 401 Unauthorized: ${OLD}`, code: 7 });
    expectPrivate(chunks); expect(chunks.some(chunk => chunk.type === 'text')).toBe(false);
    expect(errors(chunks)[0]).toMatchObject({ type: 'auth_error', content: 'OpenClaw exited with code 7.\nHTTP 401 Unauthorized: [REDACTED]' });
  });
  it.each(['standalone', 'completed', 'failed'])('redacts %s failed tool output and preserves tool identity', async kind => {
    const start = { type: 'tool_call', id: 'owned-tool', name: 'shell', input: { command: 'owned-command' }, status: 'started' };
    const result = kind === 'standalone' ? { type: 'tool_result', tool_use_id: 'owned-tool', tool_name: 'shell', content: `Failed: ${OLD}`, is_error: true }
      : { type: 'tool_call', id: 'owned-tool', status: kind, output: `Failed: ${OLD}`, success: false };
    const chunks = await send({ records: [start, result], code: 0 });
    expectPrivate(chunks); expect(chunks.find(chunk => chunk.type === 'tool_result')?.toolCall).toMatchObject({
      id: 'owned-tool', name: 'shell', status: 'failed', output: 'Failed: [REDACTED]',
    });
  });
  it('keeps regular text and successful tool output intact without logging it', async () => {
    const chunks = await send({ records: [{ type: 'text', content: `Requested content: ${OLD}` },
      { type: 'tool_result', tool_use_id: 'owned-success', content: `Successful content: ${OLD}`, is_error: false }] });
    expect(chunks).toContainEqual({ type: 'text', content: `Requested content: ${OLD}` });
    expect(chunks.find(chunk => chunk.type === 'tool_result')?.toolCall?.output).toBe(`Successful content: ${OLD}`);
    expect(logged()).not.toContain(OLD);
  });
  it('does not log raw spawn error properties or a rotated credential', async () => {
    onSpawn = proc => proc.emit('error', Object.assign(new Error(`Owned spawn failure: ${OLD}`), { spawnargs: [PRIVATE_ARG] }));
    const chunks = await send({ code: 7 }); expectPrivate(chunks); expect(errors(chunks)[0].content).toContain('[REDACTED]');
  });
  it('redacts a stream exception against its issuing child', async () => {
    onSpawn = proc => setTimeout(() => proc.stdout!.destroy(new Error(`Authentication failed: ${OLD}`)), 35);
    const chunks = await send({ hang: true }); expectPrivate(chunks);
    expect(errors(chunks)[0]).toMatchObject({ type: 'auth_error', content: 'Authentication failed: [REDACTED]' });
  });
  it.each(['executable', 'cwd'])('keeps real missing-%s spawn diagnostics private and recovers', async kind => {
    const missing = path.join(directory, OLD, 'missing');
    if (kind === 'executable') vi.mocked(provider.getCliPath).mockReturnValue(missing); else workspace(missing);
    const chunks = await send(); expectPrivate(chunks);
    expect(errors(chunks).some(chunk => chunk.content?.includes('ENOENT'))).toBe(true);
    vi.mocked(provider.getCliPath).mockReturnValue(process.execPath); workspace(directory);
    const recovered = await send({ records: [{ type: 'text', content: 'Recovered reply' }] });
    expect(recovered).toContainEqual({ type: 'text', content: 'Recovered reply' }); expect(children).toHaveLength(2);
  });
  it('does not log unknown protocol payloads', async () => {
    const chunks = await send({ records: [{ type: 'diagnostic', details: OLD }, { type: 'text', content: 'Valid reply' }] });
    expectPrivate(chunks); expect(chunks).toContainEqual({ type: 'text', content: 'Valid reply' });
  });
  it('keeps credential-like session ids out of logs without altering their protocol identity', async () => {
    const chunks = await send({ records: [{ type: 'system', session_id: OLD }, { type: 'text', content: 'Valid reply' }] });
    expect(logged()).not.toContain(OLD); expect(chunks).toContainEqual({ type: 'session_active', sessionId: OLD });
  });
  it('redacts late diagnostics after Stop clears the session process reference', async () => {
    const result = send({ stopDiagnostic: true });
    await bounded((async () => { while (!fs.existsSync(path.join(directory, 'case-0.json.ready'))) await new Promise(resolve => setTimeout(resolve, 5)); })());
    provider.cancelCurrentRequest('owned-privacy');
    const chunks = await result; expectPrivate(chunks); expect(errors(chunks)).toEqual([]);
  });
  it.each(['stderr', 'stdout'])('redacts Unicode credentials split within a UTF-8 character on %s', async channel => {
    const unicode = 'synthetic_ключ_凭据_🌟_credential';
    vi.stubEnv('MYSTI_OPENCLAW_TEST_TOKEN', unicode);
    const split = Buffer.from(unicode).indexOf(Buffer.from('🌟')) + 1;
    const chunks = await send(channel === 'stderr' ? { stderr: unicode, stderrByteSplit: split, code: 7 }
      : { stdout: unicode, stdoutByteSplit: split, code: 7 });
    expect(errors(chunks)).toEqual([{ type: 'error', content: 'OpenClaw exited with code 7.\n[REDACTED]' }]);
    expect(logged()).not.toContain('synthetic_ключ'); expect(logged()).not.toContain('_credential');
  });
  it('preserves Unicode assistant text split within a UTF-8 character', async () => {
    const content = 'Valid reply: أهلاً 🌟', stdout = JSON.stringify({ type: 'text', content }) + '\n';
    const split = Buffer.from(stdout).indexOf(Buffer.from('🌟')) + 1;
    const chunks = await send({ stdout, stdoutByteSplit: split });
    expect(chunks).toContainEqual({ type: 'text', content });
  });
});
