import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Conversation, Settings, StreamChunk } from '../../../src/types';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); clearMockConfig(); });
const settings = (model = 'auto'): Settings => ({ provider: 'github-copilot', model, effortLevel: 'low',
  mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' });
function conversation(content: string): Conversation {
  return { id: 'owned-history', title: 'Owned task', createdAt: 1, updatedAt: 1, provider: 'github-copilot', model: 'auto', mode: 'quick-plan',
    messages: [{ id: 'prior-user', role: 'user', content, timestamp: 1 },
      { id: 'prior-answer', role: 'assistant', content: 'Include only open issues; triaged is excluded.', timestamp: 2, provider: 'github-copilot', model: 'auto' }] };
}
function fixture() {
  clearMockConfig();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-copilot-continuity-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  cleanups.push(() => { (vscode.workspace as any).workspaceFolders = oldFolders; });
  const receipt = path.join(directory, 'requests.jsonl'), executable = path.join(directory, 'copilot fixture.cjs');
  // Recorded 1.0.94 behavior: an unknown --resume value fails before inference.
  // Output uses the installed modern event vocabulary, with synthetic answers.
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({args,prompt:value('-p')})+'\\n');
if(args.includes('--resume')){process.stderr.write("Error: No session, task, or name matched '"+value('--resume')+"'.\\n");process.exitCode=1;}
else if(value('--model')==='owned-invalid-model'){process.stderr.write('Error: Model owned-invalid-model is not supported.\\n');process.exitCode=1;}
else{if(value('--model')==='auto')console.log(JSON.stringify({type:'session.auto_mode_resolved',data:{chosenModel:'mai-code-1.1-flash'}}));
console.log(JSON.stringify({type:'assistant.message_delta',data:{deltaContent:'Owned fixture answer: open only.'}}));
console.log(JSON.stringify({type:'assistant.turn_end',data:{}}));}
`, { mode: 0o700 });
  const provider = new TestableCopilotProvider(); cleanups.push(() => provider.dispose());
  (provider as any)._cachedCliVersion = '1.0.94';
  vi.spyOn(provider, 'getCliPath').mockReturnValue(executable);
  return { provider, requests: () => fs.existsSync(receipt) ? fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}
async function send(provider: TestableCopilotProvider, panel: string, content: string, model = 'auto', history: Conversation | null = null) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage(content, [], settings(model), history, undefined, panel)) chunks.push(chunk);
  return chunks;
}
function succeeds(chunks: StreamChunk[]) {
  expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([]);
  expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toContain('Owned fixture answer');
}

describe.skipIf(process.platform === 'win32')('Copilot prompt-history continuation through actual public sends', () => {
  it.each(['auto', 'mai-code-1.1-flash'])('continues a completed Auto turn with model %s without inventing native resume authority', async model => {
    const h = fixture();
    succeeds(await send(h.provider, 'panel-A', 'Remember OWNED_HISTORY_A and diagnose the open-only filter.'));
    const history = conversation('Remember OWNED_HISTORY_A and diagnose the open-only filter.'), before = JSON.stringify(history);
    succeeds(await send(h.provider, 'panel-A', 'Now review the triaged regression case.', model, history));
    const requests = h.requests(); expect(requests).toHaveLength(2);
    expect(requests[1].args).not.toContain('--resume');
    expect(requests[1].args[requests[1].args.indexOf('--model') + 1]).toBe(model);
    expect(requests[1].prompt).toContain('OWNED_HISTORY_A');
    expect(requests[1].prompt).toContain('Include only open issues; triaged is excluded.');
    expect(requests[1].prompt).toContain('Now review the triaged regression case.');
    expect(JSON.stringify(history)).toBe(before);
    expect(h.provider.capabilities.sessionKind).toBe('prompt-history');
  });

  it('keeps panels and clear/new-chat state isolated while retaining explicitly supplied history', async () => {
    const h = fixture();
    succeeds(await send(h.provider, 'panel-A', 'OWNED_A'));
    succeeds(await send(h.provider, 'panel-B', 'OWNED_B'));
    expect(h.requests()[1].prompt).not.toContain('OWNED_A');
    (h.provider as any)._getSession('panel-A').sessionId = 'copilot-restored-stale-local-id';
    succeeds(await send(h.provider, 'panel-A', 'Continue A.', 'auto', conversation('OWNED_A')));
    h.provider.clearSession('panel-A');
    expect((h.provider as any)._getSession('panel-A').sessionId).toBeNull();
    succeeds(await send(h.provider, 'panel-A', 'Continue supplied history after runtime clear.', 'auto', conversation('OWNED_A')));
    expect(h.requests()[3].prompt).toContain('OWNED_A');
    h.provider.clearSession('panel-A');
    succeeds(await send(h.provider, 'panel-A', 'A fresh conversation.', 'auto', null));
    expect(h.requests()[4].prompt).not.toContain('OWNED_A');
    expect(h.requests()[4].prompt).not.toContain('OWNED_B');
    expect(h.requests().every(request => !request.args.includes('--resume'))).toBe(true);
  });

  it('surfaces an invalid explicit model once without hidden fallback or retry', async () => {
    const h = fixture();
    const chunks = await send(h.provider, 'panel-invalid', 'Review only.', 'owned-invalid-model', conversation('OWNED_CONTEXT'));
    expect(chunks.filter(chunk => chunk.type === 'error').map(chunk => chunk.content).join('\n')).toContain('Model owned-invalid-model is not supported');
    expect(chunks.some(chunk => chunk.type === 'text')).toBe(false);
    expect(h.requests()).toHaveLength(1);
    expect(h.requests()[0].args).toContain('owned-invalid-model');
  });
});
