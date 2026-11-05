import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

type Event = { type: string; data: Record<string, unknown>; agentId?: string };
type Scenario = { events: Event[]; exitCode: number; stderr?: string; pauseAfterFirstEvent?: boolean };
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearMockConfig();
});

const settings: Settings = { provider: 'github-copilot', model: 'auto', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
const text = (content: string): Event => ({ type: 'assistant.message_delta', data: { messageId: 'answer', deltaContent: content } });
const failure = (errorType: string, message: string): Event => ({ type: 'session.error', data: { errorType, message } });
const errors = (chunks: StreamChunk[]) => chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error');

function fixture(scenarios: Scenario[]) {
  clearMockConfig();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-copilot-session-errors-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  cleanups.push(() => { (vscode.workspace as any).workspaceFolders = oldFolders; });
  const receipt = path.join(directory, 'requests.jsonl');
  // Only this Node fixture runs. The event schema and terminal classification
  // match pinned Copilot 1.0.94: JSON stdout carries session.error; stderr may
  // be empty. model_call and subagent errors do not fail the parent request.
  const source = `const fs=require('node:fs');
const receipt=${JSON.stringify(receipt)}, scenarios=${JSON.stringify(scenarios)};
const prior=fs.existsSync(receipt)?fs.readFileSync(receipt,'utf8').trim().split('\\n').length:0;
fs.appendFileSync(receipt,JSON.stringify({pid:process.pid,args:process.argv.slice(1)})+'\\n');
const scenario=scenarios[prior];
if(!scenario)throw new Error('Unexpected extra fixture request');
const emit=event=>process.stdout.write(JSON.stringify(event)+'\\n');
const finish=()=>{scenario.events.slice(scenario.pauseAfterFirstEvent?1:0).forEach(emit);
if(scenario.stderr)process.stderr.write(scenario.stderr);process.exitCode=scenario.exitCode;};
if(scenario.pauseAfterFirstEvent){emit(scenario.events[0]);process.stdin.once('data',()=>{finish();process.stdin.destroy();});}
else finish();`;
  const provider = new TestableCopilotProvider();
  cleanups.push(() => provider.dispose());
  (provider as any)._cachedCliVersion = '1.0.94';
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  const build = provider.buildCliArgs.bind(provider);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((configuration, session) => ['-e', source, '--', ...build(configuration, session)]);
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: string) => content);
  let processHandle: ChildProcess | undefined;
  const tracker = {
    registerProcess: (_panel: string, proc: ChildProcess) => { processHandle = proc; },
    clearProcess: (_panel: string, proc: ChildProcess) => { if (processHandle === proc) { processHandle = undefined; } },
  };
  return {
    async send(onChunk?: (chunk: StreamChunk, proc: ChildProcess) => void) {
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.sendMessage('Owned protocol fixture.', [], settings, null, undefined, 'owned-panel', tracker)) {
        chunks.push(chunk);
        if (processHandle) { onChunk?.(chunk, processHandle); }
      }
      return chunks;
    },
    requests: () => fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

describe('Copilot modern session errors through public sends', () => {
  it('retains a terminal JSON diagnostic once with partial output, then starts fresh requests', async () => {
    const h = fixture([
      { events: [text('Useful partial review.'), failure('quota', 'Owned session quota exhausted; retry after reset.')], exitCode: 1 },
      { events: [text('Second partial review.')], exitCode: 7 },
      { events: [text('Fresh request succeeded.')], exitCode: 0 },
    ]);
    const failed = await h.send();
    expect(failed.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('Useful partial review.');
    expect(errors(failed)).toEqual([{ type: 'error', content: 'Owned session quota exhausted; retry after reset.' }]);
    expect(errors(await h.send())).toEqual([{ type: 'error', content: 'GitHub Copilot exited with code 7' }]);
    const recovered = await h.send();
    expect(errors(recovered)).toEqual([]);
    expect(recovered.some(chunk => chunk.type === 'text' && chunk.content === 'Fresh request succeeded.')).toBe(true);
    expect(h.requests()).toHaveLength(3);
  });

  it('retains terminal event failure even if the wrapper reports exit zero', async () => {
    const h = fixture([{ events: [failure('context_limit', 'Owned context budget exceeded.')], exitCode: 0 }]);
    expect(errors(await h.send())).toEqual([{ type: 'error', content: 'Owned context budget exceeded.' }]);
  });

  it('allows a transient model_call error to recover without marking the response failed', async () => {
    const h = fixture([{ events: [failure('model_call', 'Transient upstream attempt failed.'), text('Native retry succeeded.')], exitCode: 0 }]);
    const chunks = await h.send();
    expect(errors(chunks)).toEqual([]);
    expect(chunks.some(chunk => chunk.type === 'text' && chunk.content === 'Native retry succeeded.')).toBe(true);
    expect(h.requests()).toHaveLength(1);
  });

  it.each(['agentId', 'data.agentId', 'data.parentToolCallId'])('does not fail a successful parent for a child error attributed by %s', async field => {
    const event = failure('query', 'Child task could not finish.');
    if (field === 'agentId') { event.agentId = 'owned-child'; }
    else { event.data[field.slice('data.'.length)] = 'owned-child'; }
    const h = fixture([{ events: [event, text('Parent handled the child failure.')], exitCode: 0 }]);
    expect(errors(await h.send())).toEqual([]);
  });

  it('still reports a process failure after a transient event with no successful recovery', async () => {
    const h = fixture([{ events: [text('Partial.'), failure('model_call', 'Transient attempt.')], exitCode: 9 }]);
    expect(errors(await h.send())).toEqual([{ type: 'error', content: 'GitHub Copilot exited with code 9' }]);
  });

  it('preserves a distinct stderr failure after a structured terminal error', async () => {
    const h = fixture([{ events: [failure('authorization', 'Owned model is unavailable for this plan.')],
      stderr: 'Owned shutdown failed while saving the session.', exitCode: 1 }]);
    expect(errors(await h.send())).toEqual([
      { type: 'error', content: 'Owned model is unavailable for this plan.' },
      { type: 'error', content: 'Owned shutdown failed while saving the session.' },
    ]);
  });

  it('uses the authentication category and redacts the issuing process credential after environment rotation', async () => {
    const credential = 'synthetic-pb05-issuing-credential';
    vi.stubEnv('MYSTI_PB05_ERROR_TOKEN', credential);
    const h = fixture([{ events: [text('Before credential rotation.'), failure('authentication', `Credential rejected: ${credential}`)],
      pauseAfterFirstEvent: true, exitCode: 1 }]);
    const chunks = await h.send((chunk, proc) => {
      if (chunk.type === 'text') {
        vi.stubEnv('MYSTI_PB05_ERROR_TOKEN', 'synthetic-pb05-replacement-credential');
        proc.stdin!.end('continue');
      }
    });
    expect(errors(chunks)).toEqual([{ type: 'auth_error', content: 'Credential rejected: [REDACTED]',
      authCommand: 'copilot', providerName: 'GitHub Copilot' }]);
    expect(JSON.stringify(chunks)).not.toContain(credential);
  });
});
