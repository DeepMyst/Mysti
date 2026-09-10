import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../../../src/providers/codex/CodexProvider';
import { createMockContext } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk, Attachment } from '../../../src/types';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';

const config = vi.hoisted(() => ({ capture: vi.fn(async () => ({ assertUnchanged: vi.fn(async () => {}) })), validate: vi.fn() }));
vi.mock('../../../src/providers/codex/CodexNativeConfig', () => ({ captureCodexNativeConfig: config.capture, assertCodexServerConfigSafe: config.validate, CODEX_NATIVE_CONFIG_OVERRIDES: ['sandbox_mode="read-only"', 'approval_policy="on-request"', 'approvals_reviewer="user"', 'notify=[]'] }));
const fixture = path.resolve(__dirname, '../../fixtures/codex/appServer.mjs');
const dirs: string[] = [];
const providers: FixtureProvider[] = [];
class FixtureProvider extends CodexProvider {
  mode = 'command';
  launches: string[][] = [];
  prepared: Attachment[] | undefined;
  cleanupCount = 0;
  preparation: Promise<void> | undefined;
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-codex-turn-'));
  readonly marker = path.join(this.dir, 'effect');
  constructor() { super(createMockContext()); dirs.push(this.dir); providers.push(this); }
  override getCliPath(): string { return '/inert/codex'; }
  seedPreviousUsage(): void { (this._getSession('panel') as import('../../../src/providers/codex/CodexProvider').CodexSessionState).lastUsageStats = { input_tokens: 999, output_tokens: 55 }; }
  protected override _spawnCliProcess(args: string[]): ChildProcess {
    this.launches.push(args);
    return spawn(process.execPath, [fixture, this.mode, this.marker], { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  protected override async prepareAttachments(attachments: Attachment[] | undefined): Promise<() => Promise<void>> {
    await this.preparation; this.prepared = attachments;
    return async () => { this.cleanupCount++; };
  }
}
const settings = (): Settings => ({ mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto', model: 'gpt-5.6-sol', provider: 'openai-codex' });
async function drain(provider: FixtureProvider, s = settings(), panel = 'panel', attachments?: Attachment[]) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage('Update the test', [], s, null, undefined, panel, undefined, undefined, attachments)) { chunks.push(chunk); }
  return chunks;
}
beforeEach(() => { clearMockConfig(); config.capture.mockClear(); config.validate.mockClear(); });
afterEach(() => { for (const provider of providers.splice(0)) { provider.dispose(); } for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });
describe('Codex public native turn lifecycle', () => {
  it('runs only app-server, delivers native approval, and releases attachments before final done', async () => {
    const provider = new FixtureProvider(); provider.setNativeApprovalHost({ handlerForPanel: () => async () => true });
    const attachment: Attachment = { id: 'img', type: 'image', fileName: 'image.png', filePath: '/fixture/image.png', mimeType: 'image/png', size: 1 };
    const chunks = await drain(provider, settings(), 'panel', [attachment]);
    expect(provider.launches).toHaveLength(1); expect(provider.launches[0][0]).toBe('app-server');
    expect(provider.prepared?.[0]).not.toBe(attachment);
    expect(fs.readFileSync(provider.marker, 'utf8')).toBe('effect\n');
    expect(provider.cleanupCount).toBe(1);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', usage: { input_tokens: 10, output_tokens: 4 } });
    expect(config.capture).toHaveBeenCalledOnce(); expect(config.validate).toHaveBeenCalledTimes(2);
  });
  it('captures the handler and restrictive settings before async preparation', async () => {
    const provider = new FixtureProvider(); let release!: () => void;
    provider.preparation = new Promise(resolve => { release = resolve; });
    const oldHandler = vi.fn(async () => false); const replacement = vi.fn(async () => true);
    provider.setNativeApprovalHost({ handlerForPanel: () => oldHandler });
    const state = settings(); const pending = drain(provider, state);
    state.mode = 'edit-automatically'; state.accessLevel = 'full-access';
    provider.setNativeApprovalHost({ handlerForPanel: () => replacement }); release();
    await pending; expect(oldHandler).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
    expect(oldHandler.mock.calls[0][0].defaultDecision).toBe('ask'); expect(fs.existsSync(provider.marker)).toBe(false);
  });
  it('does not attribute retired-turn usage to a new preflight failure', async () => {
    const provider = new FixtureProvider(); provider.seedPreviousUsage();
    config.capture.mockRejectedValueOnce(new Error('unsupported config'));
    const chunks = await drain(provider);
    expect(provider.launches).toHaveLength(0);
    expect(chunks.at(-1)).toEqual({ type: 'done' });
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(true);
  });
  it('never retries through raw exec when native setup fails', async () => {
    const provider = new FixtureProvider(); provider.mode = 'version';
    const chunks = await drain(provider);
    expect(provider.launches).toHaveLength(1); expect(chunks.some(chunk => chunk.type === 'error')).toBe(true);
    expect(provider.cleanupCount).toBe(1); expect(fs.existsSync(provider.marker)).toBe(false);
  });
  it('Stop revokes a pending card and cannot run a late accepted command', async () => {
    const provider = new FixtureProvider(); let allow!: (value: boolean) => void; let request: NativeApprovalRequest | undefined;
    provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(resolve => { allow = resolve; }); } });
    const pending = drain(provider); await vi.waitFor(() => expect(request).toBeDefined());
    provider.cancelCurrentRequest('panel'); allow(true); await pending;
    expect(request?.signal.aborted).toBe(true); expect(fs.existsSync(provider.marker)).toBe(false); expect(provider.cleanupCount).toBe(1);
  });
});
