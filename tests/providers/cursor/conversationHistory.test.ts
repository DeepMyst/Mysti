import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Conversation, Settings, StreamChunk } from '../../../src/types';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); clearMockConfig(); });
const settings: Settings = { provider: 'cursor', model: 'auto', mode: 'quick-plan', accessLevel: 'read-only',
  thinkingLevel: 'none', contextMode: 'manual' };
const history: Conversation = { id: 'h', title: 'Owned task', createdAt: 1, updatedAt: 1, provider: 'cursor', model: 'auto', mode: 'quick-plan',
  messages: [{ id: 'u1', role: 'user', content: 'Remember OWNED_HISTORY_CURSOR.', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'Noted: only open issues count.', timestamp: 2, provider: 'cursor', model: 'auto' }] };

// A stand-in cursor-agent: records argv and emits the documented stream-json
// vocabulary (thinking delta/completed, assistant block, result).
function fixture() {
  clearMockConfig();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cursor-history-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  cleanups.push(() => { (vscode.workspace as any).workspaceFolders = oldFolders; });
  const receipt = path.join(directory, 'requests.jsonl'), executable = path.join(directory, 'cursor-agent fixture.cjs');
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({args,prompt:args[args.indexOf('-p')+1]})+'\\n');
const out=o=>console.log(JSON.stringify({session_id:'real-cursor-chat',...o}));
out({type:'system',subtype:'init',model:'auto'});
out({type:'thinking',subtype:'delta',text:'Checking the ',timestamp_ms:1});
out({type:'thinking',subtype:'delta',text:'history.',timestamp_ms:2});
out({type:'thinking',subtype:'completed',timestamp_ms:3});
out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Fixture answer.'}]}});
out({type:'result',subtype:'success',is_error:false,duration_ms:5,result:'Fixture answer.'});
`, { mode: 0o700 });
  const provider = new TestableCursorProvider(); cleanups.push(() => provider.dispose());
  vi.spyOn(provider, 'getCliPath').mockReturnValue(executable);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { provider, requests: () => fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
async function send(provider: TestableCursorProvider, content: string, conversation: Conversation | null) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage(content, [], settings, conversation, undefined, 'panel')) chunks.push(chunk);
  return chunks;
}

describe.skipIf(process.platform === 'win32')('Cursor prompt-history continuity', () => {
  it('replays the supplied conversation into the prompt and never claims a native resume', async () => {
    const h = fixture();
    await send(h.provider, 'Now review the triaged case.', history);
    const [request] = h.requests();
    expect(request.prompt).toContain('OWNED_HISTORY_CURSOR');
    expect(request.prompt).toContain('Noted: only open issues count.');
    expect(request.prompt).toContain('Now review the triaged case.');
    expect(request.args).not.toContain('--resume');
    expect(h.provider.capabilities.sessionKind).toBe('prompt-history');
    expect(h.provider.capabilities.sendsNoHistory).not.toBe(true);
  });

  it('sends a fresh conversation without history', async () => {
    const h = fixture();
    await send(h.provider, 'A fresh conversation.', null);
    expect(h.requests()[0].prompt).not.toContain('conversation history');
  });

  it('streams thinking deltas end to end and declares them', async () => {
    const h = fixture();
    const chunks = await send(h.provider, 'Think first.', null);
    expect(chunks.filter(c => c.type === 'thinking').map(c => c.content).join('')).toBe('Checking the history.');
    expect(chunks.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('Fixture answer.');
    expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    expect(h.provider.capabilities.supportsThinking).toBe(true);
    expect(h.provider.capabilities.thinkingStyle).toBe('streamed');
  });
});
