import { useAcpNativeWorkspace } from '../../helpers/acpNativeWorkspace';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClineProvider } from '../../../src/providers/cline/ClineProvider';
import { CopilotProvider } from '../../../src/providers/copilot/CopilotProvider';
import type { AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import { createMockContext } from '../../helpers/providerFactory';
import type { Settings, StreamChunk } from '../../../src/types';

useAcpNativeWorkspace();
const fixture = path.resolve(__dirname, '../../fixtures/copilot/acp.mjs');
const dirs: string[] = [];
const childClosures: Promise<void>[] = [];
const settings = (provider: string): Settings => ({ provider, mode: 'default', accessLevel: 'ask-permission', model: '', thinkingLevel: 'none', contextMode: 'auto' });
const rootForCase = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-acp-provider-')); dirs.push(dir); return dir; };
class ClineFixture extends ClineProvider {
  readonly dir = rootForCase(); readonly marker = path.join(this.dir, 'effect'); launches = 0; scenario = 'normal';
  constructor() { super(createMockContext()); }
  protected override _prepareAcpLaunch(context: AcpNativeLaunchContext) { return super._prepareAcpLaunch({ ...context, cwd: this.dir, env: { PATH: process.env.PATH, CLINE_API_KEY: 'fixture-only' } }); }
  protected override _spawnCliProcess(args: string[]): ChildProcess {
    this.launches++; expect(args).toContain('--acp');
    const child = spawn(process.execPath, [fixture, 'cline', this.scenario, this.marker], { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    childClosures.push(new Promise(resolve => child.once('close', () => resolve())));
    return child;
  }
}
class CopilotFixture extends CopilotProvider {
  readonly dir = rootForCase(); readonly marker = path.join(this.dir, 'effect'); launches = 0; scenario = 'normal';
  constructor() { super(createMockContext()); }
  protected override _prepareAcpLaunch(context: AcpNativeLaunchContext) { return super._prepareAcpLaunch({ ...context, cwd: this.dir, env: { PATH: process.env.PATH, COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1' } }); }
  protected override _spawnCliProcess(args: string[]): ChildProcess {
    this.launches++; expect(args).toContain('--acp');
    const child = spawn(process.execPath, [fixture, 'copilot', this.scenario, this.marker], { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    childClosures.push(new Promise(resolve => child.once('close', () => resolve())));
    return child;
  }
}
async function drain(provider: ClineFixture | CopilotFixture) { const chunks: StreamChunk[] = []; for await (const chunk of provider.sendMessage('/allow-all on', [], settings(provider.id), null, undefined, 'panel')) { chunks.push(chunk); } return chunks; }
// Production refuses Copilot native approvals on Windows before launch.
const refusedOnWindows = async (name: string, provider: ClineFixture | CopilotFixture, handler: () => unknown) => {
  if (name !== 'Copilot' || process.platform !== 'win32') { return false; }
  const chunks = await drain(provider);
  expect(chunks.some(chunk => chunk.type === 'error')).toBe(true);
  expect(handler).not.toHaveBeenCalled(); expect(provider.launches).toBe(0); expect(fs.existsSync(provider.marker)).toBe(false);
  return true;
};
afterEach(async () => {
  await Promise.all(childClosures.splice(0));
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});
describe.each([['Cline', ClineFixture], ['Copilot', CopilotFixture]] as const)('%s public native turn', (_name, Fixture) => {
  it('enforces its verified operation boundary before any effect', async () => {
    const provider = new Fixture(); let resolve!: (allow: boolean) => void;
    const handler = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    try {
      if (await refusedOnWindows(_name, provider, handler)) { return; }
      const pending = drain(provider); await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      expect(fs.existsSync(provider.marker)).toBe(false); resolve(true);
      const chunks = await pending; expect(fs.readFileSync(provider.marker, 'utf8')).toBe('effect\n');
      expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1); expect(provider.launches).toBe(1);
    } finally { provider.dispose(); }
  });
  it('never performs a denied effect', async () => {
    const provider = new Fixture(); provider.setNativeApprovalHost({ handlerForPanel: () => async () => false });
    try { await drain(provider); expect(fs.existsSync(provider.marker)).toBe(false); } finally { provider.dispose(); }
  });
  it('never retries an unverified runtime through legacy execution', async () => {
    const provider = new Fixture(); provider.scenario = 'wrong-version';
    try { const chunks = await drain(provider); expect(chunks.some(chunk => chunk.type === 'error')).toBe(true); expect(provider.launches).toBe(_name === 'Copilot' && process.platform === 'win32' ? 0 : 1); expect(fs.existsSync(provider.marker)).toBe(false); } finally { provider.dispose(); }
  });
  it('Stop prevents a late effect', async () => {
    const provider = new Fixture(); let resolve!: (allow: boolean) => void;
    const handler = vi.fn(() => new Promise<boolean>(done => { resolve = done; })); provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    try { if (await refusedOnWindows(_name, provider, handler)) { return; } const pending = drain(provider); await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce()); provider.cancelCurrentRequest('panel'); resolve(true); await pending; expect(fs.existsSync(provider.marker)).toBe(false); } finally { provider.dispose(); }
  });
});
