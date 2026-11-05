import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableClineProvider, TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

const settings: Settings = {
  provider: 'cline', model: '', mode: 'default', accessLevel: 'full-access',
  thinkingLevel: 'none', contextMode: 'manual',
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  try { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig(); clearConfigurationListeners(); }
});

function fixture(version = '3.0.61') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cline-update-')));
  const cli = path.join(directory, 'custom agent wrapper');
  const receipts = path.join(directory, 'invocations.jsonl');
  const updateAttempt = path.join(directory, 'update-attempt');
  const previousFolders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    value: [{ uri: vscode.Uri.file(directory), name: 'owned fixture', index: 0 }], configurable: true,
  });
  // Cline 3.0.61 starts its updater before parsing --version and honors exactly
  // CLINE_NO_AUTO_UPDATE=1. This harmless executable uses the same guard, replacing
  // the registry/package-manager operation with a short owned child and canary.
  // There is no Cline binary, network, credential/config access or global install.
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'), { spawn } = require('node:child_process');
(async () => {
  const args = process.argv.slice(2);
  const explicit = args.includes('--explicit-update');
  if (explicit || process.env.CLINE_NO_AUTO_UPDATE !== '1') {
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(updateAttempt)}, 'update route reached')`)}], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('fixture child failed'))); });
  }
  fs.appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({
    kind: args.includes('--version') ? 'probe' : explicit ? 'explicit-update' : 'request',
    flag: process.env.CLINE_NO_AUTO_UPDATE ?? null,
    sentinel: process.env.MYSTI_CLINE_ENV_SENTINEL, args,
  }) + '\\n');
  if (args.includes('--version')) process.stdout.write(${JSON.stringify(version + '\n')});
  else if (!explicit) process.stdout.write(JSON.stringify(${JSON.stringify(version.startsWith('1.')
    ? { type: 'say', say: 'completion_result', text: 'Fixture response.' }
    : { type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: 'Fixture response.' } })}) + '\\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
`, { mode: 0o700 });
  const provider = new TestableClineProvider();
  setMockConfig('clinePath', cli);
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Harmless fixture prompt');
  cleanups.push(() => {
    provider.dispose();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: previousFolders, configurable: true });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const records = () => fs.readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const send = async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('fixture', [], settings, null, undefined, 'owned-panel')) chunks.push(chunk);
    return chunks;
  };
  return { provider, cli, updateAttempt, records, send };
}

describe.skipIf(process.platform === 'win32')('Cline managed child update isolation', () => {
  it.each([undefined, '0', '1'])('probes a custom wrapper without automatic updates (inherited=%s)', async inherited => {
    vi.stubEnv('CLINE_NO_AUTO_UPDATE', inherited);
    vi.stubEnv('MYSTI_CLINE_ENV_SENTINEL', 'preserve probe environment');
    const h = fixture();
    expect(await h.provider.discoverCli()).toEqual({ found: true, path: h.cli, version: '3.0.61' });
    expect(h.records()).toEqual([{
      kind: 'probe', flag: '1', sentinel: 'preserve probe environment', args: ['--version'],
    }]);
    expect(fs.existsSync(h.updateAttempt)).toBe(false);
    expect(process.env.CLINE_NO_AUTO_UPDATE).toBe(inherited);
  });

  it.each([undefined, '0', '1'])('preserves streamed answers without automatic updates (inherited=%s)', async inherited => {
    vi.stubEnv('CLINE_NO_AUTO_UPDATE', inherited);
    vi.stubEnv('MYSTI_CLINE_ENV_SENTINEL', 'preserve request environment');
    const h = fixture();
    const chunks = await h.send();
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('Fixture response.');
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);
    expect(h.records()).toEqual([expect.objectContaining({ kind: 'request', flag: '1', sentinel: 'preserve request environment' })]);
    expect(fs.existsSync(h.updateAttempt)).toBe(false);
    expect(process.env.CLINE_NO_AUTO_UPDATE).toBe(inherited);
  });

  it('keeps the legacy CLI flags and answer path with the child-only environment guard', async () => {
    vi.stubEnv('CLINE_NO_AUTO_UPDATE', '0');
    const h = fixture('1.0.8');
    expect((await h.provider.discoverCli()).version).toBe('1.0.8');
    const chunks = await h.send();
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('Fixture response.');
    expect(h.records()[1].args).toEqual(expect.arrayContaining(['--output-format', 'json', '--mode', 'act', '--yolo']));
    expect(h.records().map(record => record.flag)).toEqual(['1', '1']);
    expect(fs.existsSync(h.updateAttempt)).toBe(false);
    expect(process.env.CLINE_NO_AUTO_UPDATE).toBe('0');
  });

  it('preserves another provider\'s inherited probe environment and exercises the positive update control', async () => {
    vi.stubEnv('CLINE_NO_AUTO_UPDATE', '0');
    vi.stubEnv('MYSTI_CLINE_ENV_SENTINEL', 'other provider environment');
    const h = fixture();
    const other = new TestableCodexProvider();
    cleanups.push(() => other.dispose());
    setMockConfig('codexPath', h.cli);
    expect((await other.discoverCli()).version).toBe('3.0.61');
    expect(h.records()).toEqual([{
      kind: 'probe', flag: '0', sentinel: 'other provider environment', args: ['--version'],
    }]);
    expect(fs.readFileSync(h.updateAttempt, 'utf8')).toBe('update route reached');
    expect(process.env.CLINE_NO_AUTO_UPDATE).toBe('0');
  });

  it('does not change the explicit install command or disable an explicit fixture update', () => {
    const h = fixture();
    expect(h.provider.getInstallCommand()).toBe('npm install -g cline');
    execFileSync(h.cli, ['--explicit-update'], {
      env: { ...process.env, CLINE_NO_AUTO_UPDATE: '1' }, timeout: 3000, stdio: 'ignore',
    });
    expect(h.records()).toEqual([expect.objectContaining({ kind: 'explicit-update', flag: '1' })]);
    expect(fs.readFileSync(h.updateAttempt, 'utf8')).toBe('update route reached');
  });
});
