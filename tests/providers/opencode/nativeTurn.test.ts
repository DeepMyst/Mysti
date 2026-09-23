import { useAcpNativeWorkspace } from '../../helpers/acpNativeWorkspace';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeProvider } from '../../../src/providers/opencode/OpenCodeProvider';
import { openCodeShellEnabled, prepareOpenCodeNativeLaunch } from '../../../src/providers/opencode/OpenCodeNative';
import { createMockContext } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { AcpNativeLaunch, AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import type { Attachment, Settings, StreamChunk } from '../../../src/types';

useAcpNativeWorkspace();
const fixture = path.resolve(__dirname, '../../fixtures/opencode/acp.mjs');
const providers: FixtureProvider[] = [];
const childClosures: Promise<void>[] = [];
class FixtureProvider extends OpenCodeProvider {
  mode = 'write';
  launches: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-opencode-turn-'));
  readonly marker = path.join(this.dir, 'marker');
  readonly trace = path.join(this.dir, 'trace');
  preparation?: Promise<void>;
  preparedModel?: string;
  cleanupCount = 0;
  constructor() { super(createMockContext()); providers.push(this); }
  override getCliPath(): string { return '/inert/opencode'; }
  // The shell gate path (macOS policy) runs on every OS against the fixture's
  // emulated plugin bootstrap; the platform choice itself is tested separately.
  platform: NodeJS.Platform = 'darwin';
  protected override async _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch> {
    await this.preparation;
    const launch = await prepareOpenCodeNativeLaunch({ ...context, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'inert-fixture' } },
      this._getEffectiveModel(context.settings), this.platform);
    this.preparedModel = launch.model;
    return launch;
  }
  protected override _spawnCliProcess(args: string[], _cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
    this.launches.push({ args, env });
    const child = spawn(process.execPath, [fixture, this.mode, this.marker, this.trace], { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: env?.OPENCODE_CONFIG_CONTENT ?? '' } });
    childClosures.push(new Promise(resolve => child.once('close', () => resolve())));
    return child;
  }
  protected override async prepareAttachments(_attachments: Attachment[] | undefined): Promise<() => Promise<void>> {
    return async () => { this.cleanupCount++; };
  }
}
const settings = (): Settings => ({ provider: 'opencode', model: 'anthropic/claude-sonnet-4-5', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' });
async function drain(provider: FixtureProvider, state = settings(), panel = 'panel', attachments?: Attachment[], text = 'Update the file'): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage(text, [], state, null, undefined, panel, undefined, undefined, attachments)) { chunks.push(chunk); }
  return chunks;
}
type WireFrame = { id?: string | number; method?: string; params: Record<string, unknown> & { prompt: Array<Record<string, unknown>> }; result?: { outcome?: unknown } };
function trace(provider: FixtureProvider): WireFrame[] { return fs.existsSync(provider.trace) ? fs.readFileSync(provider.trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; }
beforeEach(() => {
  clearMockConfig();
  // Fixture lifecycle is independent of real-user managed settings. Dedicated
  // policy tests exercise detection; the actual native suite uses OS isolation.
  vi.spyOn(promises, 'lstat').mockRejectedValue(Object.assign(new Error('inert authority absent'), { code: 'ENOENT' }));
});
afterEach(async () => {
  const finished = providers.splice(0);
  for (const provider of finished) { provider.dispose(); }
  await Promise.all(childClosures.splice(0));
  for (const provider of finished) { await promises.rm(provider.dir, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

// Each case spawns a real fixture process; a loaded machine exceeds the 5 s default.
describe('OpenCode public ACP native turn', { timeout: 30_000 }, () => {
  it('holds a file effect until the captured handler allows once, preserving model/image/usage', async () => {
    const provider = new FixtureProvider(); let request: NativeApprovalRequest | undefined; let allow!: (value: boolean) => void;
    provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(resolve => { allow = resolve; }); } });
    const image: Attachment = { id: 'img', type: 'image', fileName: 'fixture.png', mimeType: 'image/png', size: 3, base64Data: 'aW1n' };
    const pending = drain(provider, settings(), 'panel', [image], '/init');
    await vi.waitFor(() => expect(request).toBeDefined(), { timeout: 10000 });
    expect(fs.existsSync(provider.marker)).toBe(false); expect(request?.toolCall.input).toHaveProperty('diff');
    allow(true); const chunks = await pending;
    expect(fs.readFileSync(provider.marker, 'utf8')).toBe('effect\n');
    expect(provider.launches).toHaveLength(1); expect(provider.launches[0].args[0]).toBe('acp');
    const frames = trace(provider);
    expect(frames.find(frame => frame.method === 'session/set_model')?.params.modelId).toBe(settings().model);
    expect(frames.find(frame => frame.method === 'session/new')?.params.mcpServers).toEqual([]);
    const prompt = frames.find(frame => frame.method === 'session/prompt')!.params.prompt;
    expect(prompt[0].text).toMatch(/^Mysti user request:/); expect(prompt[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'aW1n' });
    expect(frames.find(frame => frame.id === 7)?.result?.outcome).toEqual({ outcome: 'selected', optionId: 'once' });
    expect(provider.cleanupCount).toBe(1); expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', usage: { input_tokens: 17, output_tokens: 4 } });
    expect(fs.existsSync(path.dirname(provider.launches[0].env!.XDG_DATA_HOME!))).toBe(false);
  });
  it('captures settings and handler before asynchronous preparation', async () => {
    const provider = new FixtureProvider(); let release!: () => void;
    provider.preparation = new Promise(resolve => { release = resolve; });
    const old = vi.fn(async () => false); const replacement = vi.fn(async () => true);
    provider.setNativeApprovalHost({ handlerForPanel: () => old });
    const state = settings(); const pending = drain(provider, state);
    state.accessLevel = 'full-access'; state.model = 'openai/gpt-4.1'; provider.setNativeApprovalHost({ handlerForPanel: () => replacement });
    release(); await pending;
    expect(old).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled(); expect(provider.preparedModel).toBe(settings().model);
    expect(fs.existsSync(provider.marker)).toBe(false);
  });
  it.each(['version', 'wrong-mode', 'incomplete'])('fails closed on %s without falling back to legacy run', async mode => {
    const provider = new FixtureProvider(); provider.mode = mode;
    const handler = vi.fn(async () => true); provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    const chunks = await drain(provider);
    expect(provider.launches).toHaveLength(1); expect(provider.launches[0].args[0]).toBe('acp');
    expect(handler).not.toHaveBeenCalled(); expect(fs.existsSync(provider.marker)).toBe(false);
    if (mode !== 'incomplete') { expect(chunks.some(chunk => chunk.type === 'error')).toBe(true); }
  });
  it.each(['stop', 'replacement', 'crash'] as const)('revokes a pending approval on %s, so late allow cannot act', async mode => {
    const provider = new FixtureProvider(); if (mode === 'crash') { provider.mode = 'crash'; }
    let request: NativeApprovalRequest | undefined; let allow!: (value: boolean) => void;
    provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(resolve => { allow = resolve; }); } });
    const first = drain(provider);
    await vi.waitFor(() => expect(request).toBeDefined(), { timeout: 10000 });
    if (mode === 'replacement') {
      provider.setNativeApprovalHost({ handlerForPanel: () => async () => false });
      const second = drain(provider); allow(true); await Promise.all([first, second]);
    } else if (mode === 'stop') { provider.cancelCurrentRequest('panel'); allow(true); await first; }
    else { fs.writeFileSync(`${provider.marker}.crash`, ''); await first; allow(true); }
    expect(request?.signal.aborted).toBe(true); expect(fs.existsSync(provider.marker)).toBe(false);
  });
  it.each(['no-plugin', 'extra-plugin', 'other-directory'])('refuses the turn before the prompt when the shell gate attestation shows %s', async mode => {
    const provider = new FixtureProvider(); provider.mode = mode;
    const handler = vi.fn(async () => true); provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    const chunks = await drain(provider);
    expect(chunks.some(chunk => chunk.type === 'error' && chunk.content?.includes('did not attest'))).toBe(true);
    expect(trace(provider).some(frame => frame.method === 'session/prompt')).toBe(false);
    expect(handler).not.toHaveBeenCalled(); expect(fs.existsSync(provider.marker)).toBe(false);
  });
  it('Stop lets the shell-enabled agent cancel its own tools before teardown', async () => {
    const provider = new FixtureProvider(); let request: NativeApprovalRequest | undefined;
    provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(() => {}); } });
    const pending = drain(provider);
    await vi.waitFor(() => expect(request).toBeDefined(), { timeout: 10000 });
    provider.cancelCurrentRequest('panel');
    const chunks = await pending;
    expect(trace(provider).some(frame => frame.method === 'session/cancel')).toBe(true);
    expect(request?.signal.aborted).toBe(true); expect(fs.existsSync(provider.marker)).toBe(false);
    expect(chunks.at(-1)?.type).toBe('done'); expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);
  });
  it('Stop kills a running approved tool at once, not after the agent reacts', async () => {
    if (process.platform === 'win32') {
      // Tool processes are only reachable here on POSIX; Windows never enables the graced shell path.
      expect(openCodeShellEnabled(settings(), 'win32')).toBe(false); return;
    }
    const provider = new FixtureProvider(); provider.mode = 'tool-ignores-cancel'; let request: NativeApprovalRequest | undefined;
    provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(() => {}); } });
    const pending = drain(provider);
    await vi.waitFor(() => { expect(request).toBeDefined(); expect(fs.existsSync(`${provider.marker}.started`)).toBe(true); }, { timeout: 10000 });
    provider.cancelCurrentRequest('panel');
    // The agent never answers the cancel, so its 5 s grace is still running when the tool would write.
    await new Promise(resolve => setTimeout(resolve, 3500));
    expect(fs.existsSync(provider.marker)).toBe(false);
    await pending;
  }, 20000);
  it('sends a leading slash request as ordinary prefixed text, never a native command', async () => {
    const provider = new FixtureProvider(); provider.setNativeApprovalHost({ handlerForPanel: () => async () => false });
    for await (const _chunk of provider.sendMessage('/review !`printf x > injected`', [], settings(), null, undefined, 'panel')) { /* drain */ }
    const prompt = trace(provider).find(frame => frame.method === 'session/prompt') as { params?: { prompt?: Array<{ text?: string }> } } | undefined;
    expect(prompt?.params?.prompt?.[0]?.text).toMatch(/^Mysti user request:\n\n/);
    expect(fs.existsSync(path.join(provider.dir, 'injected'))).toBe(false);
  });
  it('dispose during the Stop grace kills the agent at once instead of waiting it out', async () => {
    if (process.platform === 'win32') {
      // The graced Stop exists only where shell is enabled; Windows never enables it.
      expect(openCodeShellEnabled(settings(), 'win32')).toBe(false); return;
    }
    const provider = new FixtureProvider(); provider.mode = 'tool-ignores-cancel'; let request: NativeApprovalRequest | undefined;
    provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(() => {}); } });
    const pending = drain(provider);
    await vi.waitFor(() => expect(request).toBeDefined(), { timeout: 10000 });
    const closed = childClosures.at(-1)!;
    // The agent never answers the cancel, so only the 5 s grace would end it.
    provider.cancelCurrentRequest('panel');
    let exited = false; void closed.then(() => { exited = true; });
    await new Promise(resolve => setTimeout(resolve, 500)); expect(exited).toBe(false);
    const disposedAt = Date.now(); provider.dispose();
    await closed; expect(Date.now() - disposedAt).toBeLessThan(3000);
    await pending;
  });
  it('platforms without verified shell run pure with no plugin', async () => {
    const provider = new FixtureProvider(); provider.platform = 'linux';
    provider.setNativeApprovalHost({ handlerForPanel: () => async () => true });
    await drain(provider);
    expect(provider.launches[0].args).toContain('--pure');
    expect(JSON.parse(provider.launches[0].env!.OPENCODE_CONFIG_CONTENT!).plugin).toEqual([]);
    expect(fs.readFileSync(provider.marker, 'utf8')).toBe('effect\n');
  });
  it('read-only denies native edit even when a host would allow it', async () => {
    const provider = new FixtureProvider(); const handler = vi.fn(async () => true);
    provider.setNativeApprovalHost({ handlerForPanel: () => handler }); await drain(provider, { ...settings(), accessLevel: 'read-only' });
    expect(handler).not.toHaveBeenCalled(); expect(fs.existsSync(provider.marker)).toBe(false);
  });
});
