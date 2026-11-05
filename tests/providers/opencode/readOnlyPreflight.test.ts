import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableOpenCodeProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

const settings = (overrides: Partial<Settings> = {}): Settings => ({ provider: 'opencode', model: '',
  mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual', ...overrides });
let provider: TestableOpenCodeProvider;
let directory: string;
const children: Array<{ child: ChildProcess; closed: boolean; code: number | null; signal: string | null }> = [];

beforeEach(() => {
  clearMockConfig();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-opencode-preflight-'));
  provider = new TestableOpenCodeProvider();
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
  provider.dispose();
  for (const row of children) if (!row.closed && row.child.exitCode === null && row.child.signalCode === null) row.child.kill('SIGKILL');
  try {
    await vi.waitFor(() => expect(children.every(row => row.closed), 'All owned handles must close before fixture deletion').toBe(true), { timeout: 5000 });
    fs.rmSync(directory, { recursive: true, force: true });
  } finally { children.length = 0; vi.restoreAllMocks(); clearMockConfig(); }
});

function fixture() {
  const script = path.join(directory, 'fixture.cjs'), marker = path.join(directory, 'invoked.json');
  fs.writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));
process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'text',part:{text:'owned fixture completed'}})+'\\n');});`);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
  const build = provider.buildCliArgs.bind(provider);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((options, session) => [script, ...build(options, session)]);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('owned prompt');
  const attachments = vi.spyOn(provider as any, 'prepareAttachments');
  const tracker = { registerProcess(_panel: string, child: ChildProcess) {
    const row = { child, closed: false, code: null as number | null, signal: null as string | null }; children.push(row);
    child.once('close', (code, signal) => { row.closed = true; row.code = code; row.signal = signal; });
  }, clearProcess() {} };
  const send = async (options: Settings) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('owned request', [], options, null, undefined, 'panel', tracker)) chunks.push(chunk);
    return chunks;
  };
  return { marker, prompt, attachments, send };
}

describe('OpenCode CLI authority preflight', () => {
  it.each([
    { mode: 'quick-plan', accessLevel: 'full-access' },
    { mode: 'detailed-plan', accessLevel: 'full-access' },
    { mode: 'default', accessLevel: 'read-only' },
    { mode: 'ask-before-edit', accessLevel: 'ask-permission' },
    { mode: 'ask-before-edit', accessLevel: 'full-access' },
    { mode: 'edit-automatically', accessLevel: 'ask-permission' },
  ] as const)('refuses $mode/$accessLevel before prompt, attachments, session replacement or child creation', async overrides => {
    const h = fixture();
    const prior = (provider as any)._getSession('panel');
    prior.sessionId = 'existing-native-session'; prior.cancelled = true; prior.autonomousMode = true;
    const getSession = vi.spyOn(provider as any, '_getSession');
    await expect(h.send(settings(overrides))).rejects.toThrow(/OpenCode CLI cannot enforce.*native approvals/);
    expect(getSession).not.toHaveBeenCalled();
    expect(prior).toMatchObject({ sessionId: 'existing-native-session', cancelled: true, autonomousMode: true });
    expect(h.prompt).not.toHaveBeenCalled(); expect(h.attachments).not.toHaveBeenCalled();
    expect(children).toHaveLength(0); expect(fs.existsSync(h.marker)).toBe(false);
    expect(provider.capabilities).toMatchObject({ supportsReadOnly: false, supportsAskPermission: false, planMode: 'none' });
  });

  it('preserves explicitly unrestricted CLI dispatch and closes its real owned child', async () => {
    const h = fixture(); const chunks = await h.send(settings());
    expect(JSON.parse(fs.readFileSync(h.marker, 'utf8'))).toEqual(['run', '--format', 'json', '--thinking', '--agent', 'build']);
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('owned fixture completed');
    expect(h.prompt).toHaveBeenCalledOnce(); expect(children).toHaveLength(1);
    await vi.waitFor(() => expect(children[0]).toMatchObject({ closed: true, code: 0, signal: null }));
  });

  it('preserves remote Plan/Ask dispatch and restores local restrictions when the endpoint is removed', async () => {
    const h = fixture();
    const remote = vi.spyOn((provider as any)._remote, 'send').mockImplementation(async function* () {
      yield { type: 'text', content: 'controlled remote boundary' };
    });
    setMockConfig('opencodeEndpoint', 'http://127.0.0.1:4096');
    expect(provider.capabilities).toMatchObject({ supportsReadOnly: true, supportsAskPermission: true, supportsNativeApproval: true, planMode: 'detected' });
    for (const options of [settings({ mode: 'quick-plan', accessLevel: 'read-only' }), settings({ mode: 'ask-before-edit', accessLevel: 'ask-permission' })]) {
      expect(await h.send(options)).toEqual([{ type: 'text', content: 'controlled remote boundary' }]);
      expect(remote.mock.calls.at(-1)?.[2]).toBe(options);
    }
    expect(remote).toHaveBeenCalledTimes(2); expect(children).toHaveLength(0); expect(h.prompt).not.toHaveBeenCalled();
    setMockConfig('opencodeEndpoint', '');
    expect(provider.capabilities).toMatchObject({ supportsReadOnly: false, supportsAskPermission: false, planMode: 'none' });
    await expect(h.send(settings({ mode: 'quick-plan', accessLevel: 'read-only' }))).rejects.toThrow(/OpenCode CLI cannot enforce/);
    expect(remote).toHaveBeenCalledTimes(2); expect(children).toHaveLength(0);
  });
});
