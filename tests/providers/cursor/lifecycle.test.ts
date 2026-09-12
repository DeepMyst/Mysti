import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorProvider } from '../../../src/providers/cursor/CursorProvider';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Conversation, Settings, StreamChunk } from '../../../src/types';

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }));
vi.mock('../../../src/utils/processKill', async original => ({ ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: vi.fn(async () => {}) }));
const settings: Settings = { provider: 'cursor', mode: 'default', accessLevel: 'full-access', contextMode: 'auto', model: 'auto', thinkingLevel: 'none' };
const providers: CursorProvider[] = [];
beforeEach(() => { clearMockConfig(); vi.clearAllMocks(); });
afterEach(() => { providers.splice(0).forEach(p => p.dispose()); vi.restoreAllMocks(); });
function harness() {
  const provider = new TestableCursorProvider(); providers.push(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/inert/cursor-agent');
  const child = Object.assign(new EventEmitter(), {
    pid: 3456, exitCode: 0, signalCode: null, kill: vi.fn(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }), stdout: new EventEmitter(), stderr: new EventEmitter(),
  }) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('question');
  vi.spyOn(provider as any, 'processStream').mockImplementation(async function* () { yield { type: 'text', content: 'answer' }; });
  const send = (conversation: Conversation | null = null, panel = 'panel') => provider.sendMessage('question', [], settings, conversation, undefined, panel);
  return { provider, child, prompt, send };
}
async function collect(stream: AsyncGenerator<StreamChunk>) { const out = []; for await (const chunk of stream) { out.push(chunk); } return out; }

describe('Cursor uses the owned single-shot lifecycle', () => {
  it('retains conversation history and passes prose literally with credentials only in env', async () => {
    const h = harness();
    setMockConfig('cursorApiKey', 'inert-test-key');
    h.prompt.mockResolvedValue('/mode agent\n$(touch should-not-execute)');
    const history = { id: 'history', messages: [{ role: 'user', content: 'earlier context' }] } as Conversation;
    await collect(h.send(history));
    expect(h.prompt.mock.calls[0][2]).toBe(history);
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(args).toContain('Mysti user request:\n\n/mode agent\n$(touch should-not-execute)');
    expect(args).not.toContain('inert-test-key');
    expect(options).toMatchObject({ shell: false, env: { CURSOR_API_KEY: 'inert-test-key' } });
    expect(h.child.stdin!.write).not.toHaveBeenCalled();
    expect(h.child.stdin!.end).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'supersede'] as const)('%s during prompt preparation cannot launch the old turn', async mode => {
    const h = harness();
    let finish!: (prompt: string) => void;
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    h.prompt.mockImplementationOnce(() => { entered(); return new Promise<string>(resolve => { finish = resolve; }); });
    const old = collect(h.send());
    await preparing;
    if (mode === 'stop') { h.provider.cancelCurrentRequest('panel'); }
    else { await collect(h.send()); }
    finish('stale prompt');
    expect(await old).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(mode === 'stop' ? 0 : 1);
    expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain('stale prompt');
  });
});
