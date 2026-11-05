import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableQwenProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

const settings = (overrides: Partial<Settings> = {}): Settings => ({ provider: 'qwen-code', model: '',
  mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual', ...overrides });
const diagnostic = /Qwen Code CLI cannot enforce Plan, Read Only, or approval-based modes safely/;
let provider: TestableQwenProvider;
let directory: string;
let evidence: Record<string, unknown>;
const children: Array<{ child: ChildProcess; closed: boolean; code: number | null; signal: string | null }> = [];

beforeEach(() => {
  clearMockConfig();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-qwen-preflight-'));
  provider = new TestableQwenProvider();
  evidence = {};
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
  provider.dispose();
  for (const row of children) if (!row.closed && row.child.exitCode === null && row.child.signalCode === null) row.child.kill('SIGKILL');
  try {
    await vi.waitFor(() => expect(children.every(row => row.closed), 'All owned handles must close before fixture deletion').toBe(true), { timeout: 5000 });
    fs.rmSync(directory, { recursive: true, force: true });
  } finally {
    const receipt = process.env.PB09_QWEN_PREFLIGHT_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ test: expect.getState().currentTestName, ...evidence,
      children: children.map(({ child, ...row }) => ({ pid: child.pid, ...row })) }) + '\n');
    children.length = 0; vi.restoreAllMocks(); clearMockConfig();
  }
});

function fixture() {
  const script = path.join(directory, 'fixture.cjs'), marker = path.join(directory, 'invoked.json');
  fs.writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));
process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'owned fixture completed'})+'\\n');});`);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
  const build = provider.buildCliArgs.bind(provider);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((options, session) => [script, ...build(options, session)]);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('owned prompt');
  // A positive attachment is supplied without allowing a failing baseline to
  // write into the shared mock workspace. The boundary must not call this at all.
  const attachments = vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(null);
  const tracker = { registerProcess(_panel: string, child: ChildProcess) {
    const row = { child, closed: false, code: null as number | null, signal: null as string | null }; children.push(row);
    child.once('close', (code, signal) => { row.closed = true; row.code = code; row.signal = signal; });
  }, clearProcess() {} };
  const send = async (options: Settings) => {
    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of provider.sendMessage('owned request', [], options, null, undefined, 'panel', tracker, undefined,
        [{ id: 'owned-file', type: 'file', fileName: 'owned.txt', mimeType: 'text/plain', base64Data: 'b3duZWQ=', size: 5 }])) chunks.push(chunk);
      return chunks;
    } finally {
      evidence = { ...evidence, promptCalls: prompt.mock.calls.length, attachmentCalls: attachments.mock.calls.length,
        invocation: fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null,
        chunkTypes: chunks.map(chunk => chunk.type) };
    }
  };
  return { marker, prompt, attachments, send };
}

describe('Qwen CLI authority preflight', () => {
  it.each([
    { mode: 'quick-plan', accessLevel: 'full-access' },
    { mode: 'detailed-plan', accessLevel: 'full-access' },
    { mode: 'default', accessLevel: 'read-only' },
    { mode: 'ask-before-edit', accessLevel: 'ask-permission' },
    { mode: 'ask-before-edit', accessLevel: 'full-access' },
    { mode: 'default', accessLevel: 'ask-permission' },
    { mode: 'edit-automatically', accessLevel: 'ask-permission' },
  ] as const)('refuses $mode/$accessLevel before session, prompt, attachments or child creation', async overrides => {
    const h = fixture();
    const prior = (provider as any)._getSession('panel');
    prior.sessionId = 'existing-native-session'; prior.cancelled = true; prior.autonomousMode = true;
    const getSession = vi.spyOn(provider as any, '_getSession');
    await expect(h.send(settings(overrides))).rejects.toThrow(diagnostic);
    expect(getSession).not.toHaveBeenCalled();
    expect(prior).toMatchObject({ sessionId: 'existing-native-session', cancelled: true, autonomousMode: true });
    expect(h.prompt).not.toHaveBeenCalled(); expect(h.attachments).not.toHaveBeenCalled();
    expect(children).toHaveLength(0); expect(fs.existsSync(h.marker)).toBe(false);
    expect(provider.capabilities).toMatchObject({ supportsReadOnly: false, supportsAskPermission: false, planMode: 'none' });
  });

  it('preserves explicit unrestricted dispatch through the actual argument builder and closes its owned child', async () => {
    const h = fixture(); const chunks = await h.send(settings());
    expect(JSON.parse(fs.readFileSync(h.marker, 'utf8'))).toEqual(['--output-format', 'stream-json', '--include-partial-messages', '--approval-mode', 'yolo']);
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('owned fixture completed');
    expect(chunks.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
    expect(h.prompt).toHaveBeenCalledOnce(); expect(children).toHaveLength(1);
    await vi.waitFor(() => expect(children[0]).toMatchObject({ closed: true, code: 0, signal: null }));
  });

  it('recovers on the same panel only after an explicit unrestricted choice, preserving its prior resume ID', async () => {
    const h = fixture(); const prior = (provider as any)._getSession('panel'); prior.sessionId = 'owned-resume';
    await expect(h.send(settings({ mode: 'quick-plan', accessLevel: 'read-only' }))).rejects.toThrow(diagnostic);
    expect(children).toHaveLength(0); expect(h.prompt).not.toHaveBeenCalled();
    const chunks = await h.send(settings());
    expect(JSON.parse(fs.readFileSync(h.marker, 'utf8'))).toEqual(['--output-format', 'stream-json', '--include-partial-messages', '--approval-mode', 'yolo', '--resume', 'owned-resume']);
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('owned fixture completed');
    expect(children).toHaveLength(1);
    await vi.waitFor(() => expect(children[0]).toMatchObject({ closed: true, code: 0, signal: null }));
  });
});
