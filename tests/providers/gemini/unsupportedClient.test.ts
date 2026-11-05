import type { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import { TestableGeminiProvider } from '../../helpers/providerFactory';
import { createGeminiSession } from '../../helpers/sessionFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';

const native = vi.hoisted(() => ({ spawn: vi.fn(() => { throw new Error('No native process allowed in this test'); }) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<typeof import('child_process')>('child_process'), spawn: native.spawn }));

class ErrorPipelineProvider extends TestableGeminiProvider {
  public processStream(stderr: { output: string }, session: PanelSessionState) { return super.processStream(stderr, session); }
  public handleError(error: unknown, proc?: ChildProcess) { return super.handleError(error, proc); }
  protected async waitForProcess() { return this.exitCode; }
  exitCode = 1;
}

// Observed PB03 service failure, with terminal presentation noise kept to exercise
// the real Base stderr cleanup and classification before Gemini's explanation.
const unsupported = `Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google
  ineligibleTiers: [
    {
      reasonCode: 'UNSUPPORTED_CLIENT',
      reasonMessage: 'This client is no longer supported for Gemini Code Assist for individuals.',
      tierId: 'free-tier'
    }
  ]`;
const guidance = 'Google rejected this Gemini CLI as unsupported for Gemini Code Assist for individuals (UNSUPPORTED_CLIENT). The service recommends migrating to Antigravity: https://antigravity.google';
let provider: ErrorPipelineProvider;
beforeEach(() => {
  provider = new ErrorPipelineProvider(); native.spawn.mockClear();
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  expect(native.spawn).not.toHaveBeenCalled();
  provider.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig(); clearConfigurationListeners();
});
async function collect(stderr: string, stdout = '', exitCode = 1) {
  const session = createGeminiSession(); const output = new PassThrough(); output.end(stdout);
  session.process = { stdout: output, signalCode: null } as ChildProcess; provider.exitCode = exitCode;
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.processStream({ output: stderr }, session)) chunks.push(chunk);
  return chunks;
}
function expectGuidance(chunk: StreamChunk) {
  expect(chunk).toEqual({ type: 'error', content: guidance });
  expect(chunk).not.toHaveProperty('authCommand'); expect(chunk).not.toHaveProperty('providerName');
}

describe('Gemini unsupported-client service guidance', () => {
  it('explains the observed nonzero stderr failure without terminal noise or a sign-in action', async () => {
    const chunks = await collect(`Warning: Basic terminal detected (TERM=dumb).\n\u001b[31m${unsupported}\u001b[0m\n    at loadCodeAssist (/synthetic/cli.js:10:2)`);
    expect(chunks).toHaveLength(1); expectGuidance(chunks[0]);
  });

  it('explains a structured native error without discarding earlier assistant text', async () => {
    const stdout = [
      { type: 'message', role: 'assistant', content: 'Partial answer' },
      { type: 'error', error: { name: 'IneligibleTierError', ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    const chunks = await collect('', stdout, 0);
    expect(chunks).toHaveLength(2); expect(chunks[0]).toEqual({ type: 'text', content: 'Partial answer' }); expectGuidance(chunks[1]);
  });

  it('removes the sign-in fields when generic auth classification overlaps the exact service error', async () => {
    const chunks = await collect('Authentication failed: ' + unsupported);
    expect(chunks).toHaveLength(1); expectGuidance(chunks[0]);
  });

  it('explains thrown unsupported-client errors through the existing redacting error pipeline', () => {
    vi.stubEnv('GEMINI_API_KEY', 'synthetic-secret-never-display');
    expectGuidance(provider.handleError(new Error(unsupported + '\nsynthetic-secret-never-display')));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('synthetic-secret-never-display');
  });

  it.each([
    "IneligibleTierError: reasonCode: 'ACCOUNT_NOT_ELIGIBLE'",
    "IneligibleTierError: reasonCode: 'UNSUPPORTED_CLIENT_VERSION'",
    'IneligibleTierError: reasonCode: UNSUPPORTED_CLIENT',
    'IneligibleTierError: log mentions UNSUPPORTED_CLIENT without a reason code',
    "GeneralError: reasonCode: 'UNSUPPORTED_CLIENT'",
    'This client is no longer supported for Gemini Code Assist for individuals.',
    'HTTP 403: model entitlement missing for this subscription',
    'Model overloaded',
  ])('preserves other or malformed errors: %s', async message => {
    expect(await collect(message)).toEqual([{ type: 'error', content: message }]);
    expect(provider.handleError(new Error(message))).toEqual({ type: 'error', content: message });
  });

  it.each(['invalid_api_key', 'HTTP 401 Unauthorized', 'Authentication failed: token expired'])('keeps genuine credential failure classified for sign-in: %s', async message => {
    const chunks = await collect(message);
    expect(chunks).toEqual([{ type: 'auth_error', content: message, authCommand: 'gemini', providerName: 'Gemini' }]);
    expect(provider.handleError(new Error(message))).toEqual(chunks[0]);
  });

  it('preserves ordinary assistant text that quotes the unsupported-client diagnostic', async () => {
    expect(await collect('', JSON.stringify({ type: 'message', role: 'assistant', content: unsupported }) + '\n', 0))
      .toEqual([{ type: 'text', content: unsupported }]);
  });

  it('returns the base stdout iterator when its consumer stops after a streamed chunk', async () => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const next = vi.fn(async () => ({ done: false as const, value: Buffer.from(JSON.stringify({ type: 'message', role: 'assistant', content: 'First chunk' }) + '\n') }));
    const session = createGeminiSession();
    session.process = { stdout: { [Symbol.asyncIterator]: () => ({ next, return: returned }) }, signalCode: null } as unknown as ChildProcess;
    const stream = provider.processStream({ output: '' }, session);
    expect((await stream.next()).value).toEqual({ type: 'text', content: 'First chunk' });
    await stream.return(undefined);
    expect(returned).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1);
  });
});
