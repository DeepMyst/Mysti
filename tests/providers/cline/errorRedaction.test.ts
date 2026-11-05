import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), env: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../../src/utils/platform', async () => ({ ...await vi.importActual<any>('../../../src/utils/platform'), getEnrichedEnv: mocks.env }));
vi.mock('../../../src/utils/processKill', async () => ({ ...await vi.importActual<any>('../../../src/utils/processKill'), killProcessTree: mocks.kill }));

// Deliberately synthetic values. The mocked spawn receives no real credentials.
const OLD_KEY = 'pb04_fixture_old_credential_7f4a912e';
const NEW_KEY = 'pb04_fixture_new_credential_28103bd9';
const settings = { mode: 'default', accessLevel: 'full-access', model: 'fixture-model' } as Settings;
let provider: TestableClineProvider;
let logs: ReturnType<typeof vi.spyOn>[];

function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 990001, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    killed: false, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  });
}

function logged() {
  // JSON.stringify(Error) produces {}, concealing the raw Error logging regression.
  return logs.flatMap(log => log.mock.calls).map(args => args.map(arg => typeof arg === 'string' ? arg : inspect(arg)).join(' ')).join('\n');
}

async function collect(iterator: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) { chunks.push(chunk); }
  return chunks;
}

async function start() {
  const proc = fakeProcess();
  mocks.spawn.mockReturnValueOnce(proc);
  const iterator = provider.sendMessage('Synthetic request with no credential', [], settings, null, undefined, 'redaction-panel');
  expect((await iterator.next()).value).toMatchObject({ type: 'session_active' });
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({ OPENROUTER_API_KEY: OLD_KEY });
  return { proc, iterator };
}

async function finish(proc: ReturnType<typeof fakeProcess>, iterator: AsyncGenerator<StreamChunk>, code = 1) {
  proc.exitCode = code;
  proc.stdout.end(); proc.stderr.end();
  proc.emit('exit', code, null); proc.emit('close', code, null);
  return collect(iterator);
}

beforeEach(() => {
  clearMockConfig(); mocks.spawn.mockReset(); mocks.env.mockReset(); mocks.kill.mockClear();
  vi.stubEnv('OPENROUTER_API_KEY', OLD_KEY);
  mocks.env.mockImplementation(() => ({ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }));
  logs = ['log', 'error', 'warn'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  provider = new TestableClineProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/synthetic/cline');
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('');
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Synthetic request with no credential');
  (provider as any)._cachedCliVersion = '3.0.61';
});

afterEach(() => {
  provider.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  clearMockConfig(); clearConfigurationListeners();
});

describe('Cline public sendMessage credential redaction', () => {
  it.each([
    ['error', 'Worker failed to load context for credential'],
    ['auth_error', 'HTTP 401 Unauthorized for credential'],
  ] as const)('redacts immediate stderr logging and the displayed %s', async (type, prefix) => {
    const { proc, iterator } = await start();
    proc.stderr.write(`${prefix} ${OLD_KEY}\n`);
    const immediate = logged();
    const chunks = await finish(proc, iterator);
    expect(chunks).toContainEqual(expect.objectContaining({ type, content: expect.stringContaining('[REDACTED]') }));
    if (type === 'auth_error') { expect(chunks).toContainEqual(expect.objectContaining({ authCommand: 'cline auth' })); }
    expect(immediate + logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
  });

  it('does not log credential fragments split across stderr chunks', async () => {
    const { proc, iterator } = await start();
    const first = OLD_KEY.slice(0, 17), second = OLD_KEY.slice(17);
    proc.stderr.write(`Worker failed for credential ${first}`);
    const afterFirstChunk = logged();
    proc.stderr.write(`${second}\n`);
    const chunks = await finish(proc, iterator);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'error', content: expect.stringContaining('[REDACTED]') }));
    expect(afterFirstChunk + logged()).not.toContain(first);
    expect(logged()).not.toContain(second);
  });

  it('redacts both spawn-time and current credentials after environment rotation', async () => {
    const { proc, iterator } = await start();
    vi.stubEnv('OPENROUTER_API_KEY', NEW_KEY);
    proc.stderr.write(`HTTP 401 Unauthorized; old credential ${OLD_KEY}; current credential ${NEW_KEY}\n`);
    const chunks = await finish(proc, iterator);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'auth_error', content: expect.stringContaining('[REDACTED]') }));
    for (const secret of [OLD_KEY, NEW_KEY]) { expect(logged() + JSON.stringify(chunks)).not.toContain(secret); }
  });

  it.each([
    ['error', 'Synthetic transport failed for credential'],
    ['auth_error', 'Authentication failed for credential'],
  ] as const)('redacts the early spawn Error object and displayed %s', async (type, prefix) => {
    const { proc, iterator } = await start();
    proc.emit('error', new Error(`${prefix} ${OLD_KEY}`));
    const immediate = logged();
    const chunks = await finish(proc, iterator);
    expect(chunks).toContainEqual(expect.objectContaining({ type, content: expect.stringContaining('[REDACTED]') }));
    expect(immediate + logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
  });

  it('redacts the issuing credential when a stream exception reaches the sendMessage catch after rotation', async () => {
    const { proc, iterator } = await start();
    vi.stubEnv('OPENROUTER_API_KEY', NEW_KEY);
    const complete = collect(iterator);
    await Promise.resolve();
    const error = new Error(`Authentication failed for credential ${OLD_KEY}`);
    proc.emit('error', error);
    proc.stdout.destroy(error); proc.stderr.end();
    proc.exitCode = 1; proc.emit('exit', 1, null); proc.emit('close', 1, null);
    const chunks = await complete;
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'auth_error', content: expect.stringContaining('[REDACTED]') }));
    expect(logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
  });

  it('redacts a structured native error after the issuing environment has rotated', async () => {
    const { proc, iterator } = await start();
    vi.stubEnv('OPENROUTER_API_KEY', NEW_KEY);
    proc.stdout.write(JSON.stringify({ type: 'agent_event', event: { type: 'error', message: `HTTP 401 Unauthorized for credential ${OLD_KEY}` } }) + '\n');
    const chunks = await finish(proc, iterator, 0);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'auth_error', content: expect.stringContaining('[REDACTED]') }));
    expect(logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
  });

  it.each([
    ['say:error', (message: string) => ({ type: 'say', say: 'error', text: message })],
    ['say:api_req_started', (message: string) => ({ type: 'say', say: 'api_req_started', text: JSON.stringify({ streamingFailedMessage: JSON.stringify({ message, modelId: 'fixture-model' }) }) })],
    ['ask:api_req_failed', (message: string) => ({ type: 'ask', ask: 'api_req_failed', text: JSON.stringify({ message, modelId: 'fixture-model' }) })],
  ] as const)('does not log the legacy %s error before shared redaction', async (_format, payload) => {
    (provider as any)._cachedCliVersion = '1.0.8';
    const { proc, iterator } = await start();
    vi.stubEnv('OPENROUTER_API_KEY', NEW_KEY);
    proc.stdout.write(JSON.stringify(payload(`HTTP 401 Unauthorized for credential ${OLD_KEY}`)) + '\n');
    const chunks = await finish(proc, iterator, 0);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'auth_error', content: expect.stringContaining('[REDACTED]') }));
    expect(logged() + JSON.stringify(chunks)).not.toContain(OLD_KEY);
  });
});
