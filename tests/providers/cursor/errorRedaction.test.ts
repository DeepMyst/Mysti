import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), env: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../../src/utils/platform', async () => ({ ...await vi.importActual<any>('../../../src/utils/platform'), getEnrichedEnv: mocks.env }));
vi.mock('../../../src/utils/processKill', async () => ({ ...await vi.importActual<any>('../../../src/utils/processKill'), killProcessTree: mocks.kill }));

const OLD_KEY = 'synthetic_cursor_old_credential_7f4a912e';
const NEW_KEY = 'synthetic_cursor_new_credential_28103bd9';
const settings = { provider: 'cursor', mode: 'quick-plan', accessLevel: 'read-only', model: 'auto' } as Settings;
let provider: TestableCursorProvider;
let logs: ReturnType<typeof vi.spyOn>[];
function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 990001, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    killed: false, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  });
}
const logged = () => inspect(logs.flatMap(log => log.mock.calls), { depth: null });
async function collect(iterator: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}
async function start() {
  const proc = fakeProcess(); mocks.spawn.mockReturnValueOnce(proc);
  const iterator = provider.sendMessage('Owned test prompt', [], settings, null, undefined, 'owned-panel');
  expect((await iterator.next()).value).toMatchObject({ type: 'session_active' });
  expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({ CURSOR_API_KEY: OLD_KEY });
  return { proc, iterator };
}
async function finish(proc: ReturnType<typeof fakeProcess>, iterator: AsyncGenerator<StreamChunk>, code = 1) {
  proc.exitCode = code; proc.stdout.end(); proc.stderr.end();
  proc.emit('exit', code, null); proc.emit('close', code, null);
  return collect(iterator);
}
beforeEach(() => {
  clearMockConfig(); mocks.spawn.mockReset(); mocks.env.mockReset(); mocks.kill.mockClear();
  vi.stubEnv('CURSOR_API_KEY', OLD_KEY);
  mocks.env.mockImplementation(() => ({ CURSOR_API_KEY: process.env.CURSOR_API_KEY }));
  logs = ['log', 'error', 'warn'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  provider = new TestableCursorProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/synthetic/cursor-agent');
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Owned test prompt');
});
afterEach(() => { provider.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig(); });

describe('Cursor diagnostic privacy', () => {
  it.each(['Worker failed', 'HTTP 401 Unauthorized'])('redacts %s stderr after the environment changes', async prefix => {
    const { proc, iterator } = await start(); vi.stubEnv('CURSOR_API_KEY', NEW_KEY);
    proc.stderr.write(`${prefix}: ${OLD_KEY}; current ${NEW_KEY}\n`);
    const immediate = logged(), chunks = await finish(proc, iterator);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: prefix.includes('401') ? 'auth_error' : 'error', content: expect.stringContaining('[REDACTED]'),
    }));
    for (const key of [OLD_KEY, NEW_KEY]) expect(immediate + logged() + JSON.stringify(chunks)).not.toContain(key);
  });

  it('does not log split secret fragments', async () => {
    const { proc, iterator } = await start();
    proc.stderr.write(`Worker failed: ${OLD_KEY.slice(0, 18)}`);
    const immediate = logged(); proc.stderr.write(`${OLD_KEY.slice(18)}\n`);
    const chunks = await finish(proc, iterator);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'error', content: 'Worker failed: [REDACTED]' }));
    expect(immediate + logged()).not.toContain(OLD_KEY.slice(0, 18));
    expect(logged()).not.toContain(OLD_KEY.slice(18));
  });

  it('does not log raw spawn errors with credentials and prompt arguments', async () => {
    const { proc, iterator } = await start(); vi.stubEnv('CURSOR_API_KEY', NEW_KEY);
    proc.emit('error', Object.assign(new Error(`Synthetic spawn failed: ${OLD_KEY}`), {
      spawnargs: ['-p', 'PRIVATE_CURSOR_PROMPT'],
    }));
    const immediate = logged(), chunks = await finish(proc, iterator);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'error', content: expect.stringContaining('[REDACTED]') }));
    expect(immediate + logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
    expect(logged()).not.toContain('PRIVATE_CURSOR_PROMPT');
  });

  it('redacts a stream exception against the issuing process after key rotation', async () => {
    const { proc, iterator } = await start(); vi.stubEnv('CURSOR_API_KEY', NEW_KEY);
    const complete = collect(iterator); await Promise.resolve();
    const error = new Error(`Authentication failed: ${OLD_KEY}`);
    proc.stdout.destroy(error); proc.stderr.end(); proc.exitCode = 1;
    proc.emit('exit', 1, null); proc.emit('close', 1, null);
    const chunks = await complete;
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'auth_error', content: 'Authentication failed: [REDACTED]' }));
    expect(logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
  });

  it('does not print an unknown protocol payload before credential redaction', async () => {
    const { proc, iterator } = await start();
    proc.stdout.write(JSON.stringify({ type: 'diagnostic', message: `Worker note: ${OLD_KEY}` }) + '\n');
    proc.stdout.write(JSON.stringify({ type: 'assistant', content: 'Useful answer.' }) + '\n');
    const chunks = await finish(proc, iterator, 0);
    expect(chunks).toContainEqual({ type: 'text', content: 'Useful answer.' });
    expect(logged()).not.toContain(OLD_KEY);
  });

  it('retains redaction of a structured native error', async () => {
    const { proc, iterator } = await start(); vi.stubEnv('CURSOR_API_KEY', NEW_KEY);
    proc.stdout.write(JSON.stringify({ type: 'error', message: `HTTP 401 Unauthorized: ${OLD_KEY}` }) + '\n');
    const chunks = await finish(proc, iterator, 0);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'auth_error', content: 'HTTP 401 Unauthorized: [REDACTED]' }));
    expect(logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
  });

  it('passes the prompt-enhancement API key only through the environment', async () => {
    const proc = fakeProcess(); mocks.spawn.mockReturnValueOnce(proc);
    const result = provider.enhancePrompt('Improve this prompt');
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    const [, args, options] = mocks.spawn.mock.calls[0];
    proc.stdout.end('Improved prompt'); proc.exitCode = 0; proc.emit('close', 0, null);
    expect(await result).toBe('Improved prompt');
    expect(options.env.CURSOR_API_KEY).toBe(OLD_KEY);
    expect(args).not.toContain('--api-key'); expect(args).not.toContain(OLD_KEY);
  });
});
