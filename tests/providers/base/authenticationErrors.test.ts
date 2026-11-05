import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async () => ({ ...await vi.importActual<any>('../../../src/utils/processKill'), killProcessTree: mocks.kill }));
let provider: TestableCodexProvider;
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  provider = new TestableCodexProvider();
  logs = ['log', 'error', 'warn'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-secret-do-not-display');
});
afterEach(() => { provider.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig(); clearConfigurationListeners(); });
function logged() { return JSON.stringify(logs.flatMap(log => log.mock.calls)); }
async function collect(gen: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = []; for await (const chunk of gen) { chunks.push(chunk); } return chunks;
}

describe('PC-03 CLI authentication errors stay actionable without exposing credentials', () => {
  it('redacts nonzero authentication stderr before logging or delivering it', async () => {
    const internal = provider as any; const session = internal._getSession('panel');
    const stdout = new PassThrough(); stdout.end();
    session.process = { stdout, signalCode: null };
    vi.spyOn(internal, 'waitForProcess').mockResolvedValue(1);
    const chunks = await collect(internal.processStream({ output: '401 Unauthorized: invalid API key synthetic-secret-do-not-display' }, session));
    expect(chunks).toHaveLength(1); expect(chunks[0].type).toBe('auth_error');
    expect(JSON.stringify(chunks) + logged()).not.toContain('synthetic-secret-do-not-display');
    expect(chunks[0].content).toContain('[REDACTED]');
  });

  it('redacts and classifies a thrown native authentication error', () => {
    const chunk = (provider as any).handleError(new Error('Authentication failed: synthetic-secret-do-not-display'));
    expect(chunk.type).toBe('auth_error');
    expect(JSON.stringify(chunk) + logged()).not.toContain('synthetic-secret-do-not-display');
  });

  it('classifies a structured CLI error while preserving partial answer text', async () => {
    const internal = provider as any; const session = internal._getSession('panel');
    const stdout = new PassThrough();
    stdout.end(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial answer' } }) + '\n'
      + JSON.stringify({ type: 'error', message: '401 Unauthorized: synthetic-secret-do-not-display' }) + '\n');
    session.process = { stdout, signalCode: null };
    vi.spyOn(internal, 'waitForProcess').mockResolvedValue(0);
    const chunks = await collect(internal.processStream({ output: '' }, session));
    expect(chunks).toHaveLength(2); expect(chunks[0]).toMatchObject({ type: 'text', content: 'partial answer' });
    expect(chunks[1].type).toBe('auth_error');
    expect(JSON.stringify(chunks)).not.toContain('synthetic-secret-do-not-display');
  });

  it('classifies a real Codex app-server thread-start failure at the persistent response boundary', async () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 6601, exitCode: null, signalCode: null, killed: false });
    mocks.spawn.mockReturnValue(proc); vi.spyOn(provider, 'getCliPath').mockReturnValue('/fixture/codex');
    await provider.preSpawnPersistentProcess('panel', { model: 'gpt-5.4' } as Settings);
    const internal = provider as any; const session = internal._getSession('panel'); session.process = proc;
    session.appServer.requests.set(1, 'thread/start');
    const complete = collect(internal._readUntilBoundary(proc, session));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, error: {
      message: 'Missing bearer or basic authentication in header: synthetic-secret-do-not-display',
    } }) + '\n'));
    const chunks = await complete;
    expect(chunks).toHaveLength(1); expect(chunks[0]).toMatchObject({ type: 'auth_error', authCommand: 'codex login' });
    expect(JSON.stringify(chunks) + logged()).not.toContain('synthetic-secret-do-not-display');
  });

  it('waits through native retry progress and delivers only the final turn authentication error', async () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 6602, exitCode: null, signalCode: null, killed: false });
    mocks.spawn.mockReturnValue(proc); vi.spyOn(provider, 'getCliPath').mockReturnValue('/fixture/codex');
    await provider.preSpawnPersistentProcess('panel', { model: 'gpt-5.4' } as Settings);
    const internal = provider as any; const session = internal._getSession('panel'); session.process = proc;
    session.appServer.threadId = 'thread'; session.appServer.turnId = 'turn';
    const complete = collect(internal._readUntilBoundary(proc, session));
    for (let attempt = 2; attempt <= 5; attempt++) {
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'error', params: {
        threadId: 'thread', turnId: 'turn', willRetry: true, error: { message: `Reconnecting... ${attempt}/5` },
      } }) + '\n'));
    }
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'turn/completed', params: {
      threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'HTTP 401 Unauthorized' } },
    } }) + '\n'));
    expect(await complete).toEqual([expect.objectContaining({ type: 'auth_error', content: 'Codex turn failed: HTTP 401 Unauthorized' })]);
  });

  it('redacts the issuing process credential when it fails after the host has rotated its key', async () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 6603, exitCode: null, signalCode: null, killed: false });
    mocks.spawn.mockReturnValue(proc); vi.spyOn(provider, 'getCliPath').mockReturnValue('/fixture/codex');
    await provider.preSpawnPersistentProcess('panel', { model: 'gpt-5.4' } as Settings);
    const internal = provider as any; const session = internal._getSession('panel'); session.process = proc;
    session.appServer.requests.set(1, 'thread/start');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-rotated-replacement');
    const complete = collect(internal._readUntilBoundary(proc, session));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, error: {
      message: 'Authentication failed for credential synthetic-secret-do-not-display',
    } }) + '\n'));
    const chunks = await complete;
    expect(chunks).toHaveLength(1); expect(chunks[0].type).toBe('auth_error');
    expect(JSON.stringify(chunks) + logged()).not.toContain('synthetic-secret-do-not-display');
    expect(JSON.stringify(session.persistentSettings)).not.toMatch(/synthetic-(secret|rotated)/);
  });

  it('does not log raw persistent stderr fragments that split a key across chunks', async () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 6600, exitCode: null, signalCode: null, killed: false });
    mocks.spawn.mockReturnValue(proc); vi.spyOn(provider, 'getCliPath').mockReturnValue('/fixture/codex');
    await provider.preSpawnPersistentProcess('panel', { model: 'gpt-5.4' } as Settings);
    proc.stderr.emit('data', Buffer.from('Authentication failed: synthetic-secret-'));
    proc.stderr.emit('data', Buffer.from('do-not-display\n'));
    expect(logged()).not.toContain('synthetic-secret-');
    expect(logged()).not.toContain('do-not-display');
  });

  it.each([
    'EACCES: access denied opening workspace/src/index.ts',
    'HTTP 403: model entitlement missing for this subscription',
    'Unknown option GEMINI_API_KEY in project configuration',
    'Assertion failed at workspace/src/index.ts:401',
  ])('does not misdiagnose a permission, entitlement or configuration error: %s', message => {
    expect((provider as any).isAuthenticationError(message)).toBe(false);
  });

  it.each(['Missing bearer or basic authentication in header', 'token expired; sign in again', 'HTTP 401 Unauthorized', 'Incorrect API key provided', 'invalid_api_key'])('recognizes credential failures: %s', message => {
    expect((provider as any).isAuthenticationError(message)).toBe(true);
  });
});
