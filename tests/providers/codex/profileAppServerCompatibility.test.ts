import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: mocks.kill,
}));
const providers: TestableCodexProvider[] = [];
afterEach(() => { providers.splice(0).forEach(provider => provider.dispose()); vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners(); });
const settings: Settings = { provider: 'openai-codex', model: 'gpt-5.6-sol', effortLevel: 'medium',
  mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
// Exact diagnostic observed from pinned Codex 0.162.0 before initialize responds.
const restriction = 'Error: --profile only applies to runtime commands and `codex mcp`: `codex`, `codex exec`, `codex review`, `codex resume`, `codex queue`, `codex archive`, `codex delete`, `codex unarchive`, `codex fork`, `codex mcp`, `codex sandbox`, and `codex debug prompt-input`.';
const actionable = "This Codex CLI cannot use named profiles with Mysti's app-server connection. Clear mysti.codexProfile in Settings and retry to use your base Codex configuration. No model request was submitted.";
type Rpc = { id: number; method: string; params?: Record<string, any> };
type Behavior = { diagnostic?: string; failAfterTurn?: boolean; beforeReject?: () => void; split?: boolean };
function harness(behaviors: Behavior[]) {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  const provider = new TestableCodexProvider(); providers.push(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/codex');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => String(content));
  vi.spyOn(provider as any, 'takeReportedContextWindow').mockReturnValue(undefined);
  const fallback = vi.spyOn(provider, 'buildCliArgs');
  const children: Array<{ args: string[]; frames: Rpc[] }> = [];
  mocks.spawn.mockImplementation((_executable: string, args: string[]) => {
    const behavior = behaviors[children.length] || {};
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 188000 + children.length,
      exitCode: null, signalCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess;
    const child = { args, frames: [] as Rpc[] }; children.push(child);
    const emit = (value: unknown) => { stdout.write(JSON.stringify(value) + '\n'); };
    const reject = () => {
      behavior.beforeReject?.();
      const text = behavior.diagnostic || restriction;
      if (behavior.split) { stderr.write(text.slice(0, 35)); stderr.write(text.slice(35)); }
      else { stderr.write(text); }
      Object.assign(process, { exitCode: 1 }); stdout.end(); stderr.end(); process.emit('close', 1, null);
    };
    let buffer = '';
    stdin.on('data', bytes => {
      buffer += bytes.toString(); let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const rpc: Rpc = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); child.frames.push(rpc);
        setImmediate(() => {
          if (rpc.method === 'initialize') {
            if (behavior.diagnostic && !behavior.failAfterTurn) { reject(); }
            else { emit({ id: rpc.id, result: {} }); }
          } else if (rpc.method === 'config/read') { emit({ id: rpc.id, result: { config: {} } }); }
          else if (rpc.method === 'thread/start' || rpc.method === 'thread/resume') { emit({ id: rpc.id, result: { thread: { id: 'owned-thread' } } }); }
          else if (rpc.method === 'turn/start') {
            emit({ id: rpc.id, result: { turn: { id: 'owned-turn' } } });
            emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned-thread', turnId: 'owned-turn', itemId: 'text', delta: 'CONTROLLED_REPLY' } });
            if (behavior.failAfterTurn) { reject(); }
            else { emit({ method: 'turn/completed', params: { threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'completed' } } }); }
          }
        });
      }
    });
    return process;
  });
  const send = async (content = 'The actual requested prompt.') => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage(content, [], settings, null, undefined, 'panel')) { chunks.push(chunk); }
    return chunks;
  };
  return { provider, children, fallback, send };
}
function rejectedBeforeModel(chunks: StreamChunk[]) {
  expect(chunks).toEqual([{ type: 'error', content: actionable }, { type: 'done' }]);
}

describe('PB02-D11 app-server profile incompatibility is actionable without fallback', () => {
  it.each([false, true])('explains actual startup rejection with one terminal error (split stderr=%s)', async split => {
    const h = harness([{ diagnostic: restriction, split }]); setMockConfig('codexProfile', ' owned-profile ');
    rejectedBeforeModel(await h.send());
    expect(h.children).toHaveLength(1); expect(h.children[0].args).toEqual(['--profile', 'owned-profile', 'app-server']);
    expect(h.children[0].frames.map(r => r.method)).toEqual(['initialize']); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('retries only after the user explicitly clears the profile, without replaying the rejected prompt', async () => {
    const h = harness([{ diagnostic: restriction }, {}]); setMockConfig('codexProfile', 'owned-profile');
    rejectedBeforeModel(await h.send('Rejected original prompt.'));
    setMockConfig('codexProfile', ''); const chunks = await h.send('Explicit recovery prompt.');
    expect(chunks.filter(c => c.type === 'error')).toEqual([]); expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    expect(h.children).toHaveLength(2); expect(h.children[1].args).toEqual(['app-server']);
    expect(h.children[0].frames.some(r => r.method === 'turn/start')).toBe(false);
    expect(h.children[1].frames.filter(r => r.method === 'turn/start')).toEqual([expect.objectContaining({ params: expect.objectContaining({ input: [{ type: 'text', text: 'Explicit recovery prompt.', text_elements: [] }] }) })]);
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it('does not silently retry the default while the named profile remains selected', async () => {
    const h = harness([{ diagnostic: restriction }, { diagnostic: restriction }]); setMockConfig('codexProfile', 'owned-profile');
    rejectedBeforeModel(await h.send()); rejectedBeforeModel(await h.send());
    expect(h.children).toHaveLength(2); expect(h.children.every(c => c.args.includes('owned-profile'))).toBe(true);
    expect(h.children.flatMap(c => c.frames).filter(r => r.method === 'turn/start')).toEqual([]); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('uses the issuing profile snapshot if Settings change while its startup failure is arriving', async () => {
    const h = harness([{ diagnostic: restriction, beforeReject: () => setMockConfig('codexProfile', '') }]);
    setMockConfig('codexProfile', 'owned-profile'); rejectedBeforeModel(await h.send());
    expect(h.children[0].frames.map(r => r.method)).toEqual(['initialize']);
  });
  it('preserves named-profile behavior for a compatible CLI transport', async () => {
    const h = harness([{}]); setMockConfig('codexProfile', 'compatible-profile');
    const chunks = await h.send();
    expect(chunks.filter(c => c.type === 'error')).toEqual([]); expect(chunks.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'CONTROLLED_REPLY' }]);
    expect(h.children[0].args).toEqual(['--profile', 'compatible-profile', 'app-server']);
    expect(h.children[0].frames.filter(r => r.method === 'turn/start')).toHaveLength(1);
  });
  it('does not translate unrelated startup failures into a profile compatibility error', async () => {
    const h = harness([{ diagnostic: 'Error: failed to load configuration.' }]); setMockConfig('codexProfile', 'owned-profile');
    const errors = (await h.send()).filter(c => c.type === 'error'); expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain('failed to load configuration'); expect(errors[0].content).not.toContain(actionable);
  });
  it('does not claim no model submission when the process crashes after a turn starts', async () => {
    const h = harness([{ diagnostic: restriction, failAfterTurn: true }]); setMockConfig('codexProfile', 'owned-profile');
    const chunks = await h.send(), errors = chunks.filter(c => c.type === 'error');
    expect(h.children[0].frames.filter(r => r.method === 'turn/start')).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'CONTROLLED_REPLY' }]);
    expect(errors).toHaveLength(1); expect(errors[0].content).toContain('incomplete'); expect(errors[0].content).not.toContain('No model request was submitted');
  });
  it('does not translate the diagnostic without an explicitly selected profile', async () => {
    const h = harness([{ diagnostic: restriction }]);
    const errors = (await h.send()).filter(c => c.type === 'error'); expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain('incomplete'); expect(errors[0].content).not.toContain(actionable);
  });
});
