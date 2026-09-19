import { useAcpNativeWorkspace } from '../../helpers/acpNativeWorkspace';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpNativeProvider } from '../../../src/providers/base/AcpNativeProvider';
import type { AcpNativeLaunch, AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import type { ProviderCapabilities } from '../../../src/providers/base/IProvider';
import type { Attachment, Settings, StreamChunk, UsageStats } from '../../../src/types';
import { createMockContext } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
useAcpNativeWorkspace();
const fixture = path.resolve(__dirname, '../../fixtures/acpNativeAgent.cjs');
const providers: FixtureProvider[] = [];
class FixtureProvider extends AcpNativeProvider {
  readonly id = 'inert-acp';
  readonly displayName = 'Inert ACP';
  readonly config = { name: 'inert-acp', displayName: 'Inert ACP', models: [], defaultModel: '' };
  readonly capabilities: ProviderCapabilities = { supportsStreaming: true, supportsThinking: false, supportsToolUse: true, supportsNativeApproval: true, supportsSessions: false, supportsPersistentProcess: true };
  readonly events: string[] = [];
  readonly children: ChildProcess[] = [];
  readonly closed: Promise<void>[] = [];
  readonly prepared = deferred<AcpNativeLaunchContext>();
  readonly cleanupStarted = deferred<void>();
  readonly pipeClosePending = deferred<void>();
  releasePipeClose?: Promise<void>;
  readonly launches: Array<{ path: string; env: NodeJS.ProcessEnv }> = [];
  preparation?: Promise<void>;
  finishCleanup?: Promise<void>;
  failPreparation = false;
  failDiscovery = false;
  failAttachmentCleanup = false;
  authorityCheck?: () => Promise<void>;
  beforePromptBuilt?: () => Promise<void>;
  cliPath = '/inert/original';
  scenario = 'normal';
  dir = '';
  constructor() { super(createMockContext()); providers.push(this); }
  async discoverCli() { return { found: true, path: this.cliPath }; }
  getCliPath() { if (this.failDiscovery) { throw new Error('CLI discovery failed'); } return this.cliPath; }
  inspectVersion(cliPath: string) { return this._probeCliVersion(cliPath); }
  async getAuthConfig() { return { type: 'none' as const, isAuthenticated: true }; }
  async checkAuthentication() { return { authenticated: true }; }
  getAuthCommand() { return ''; }
  getInstallCommand() { return ''; }
  protected buildCliArgs(_settings: Settings, _session: PanelSessionState) { throw new Error('Legacy execution must be unreachable'); }
  protected getThinkingTokens() { return undefined; }
  protected parseStreamLine(): StreamChunk | null { return null; }
  protected override async buildPromptAsync(content: string) { await this.beforePromptBuilt?.(); return content; }
  seedUsage() { (this._getSession('panel') as PanelSessionState & { lastUsageStats: UsageStats }).lastUsageStats = { input_tokens: 999, output_tokens: 999 }; }
  protected async _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch> {
    this.prepared.resolve(context); await this.preparation;
    if (this.failPreparation) { throw new Error('Native preflight rejected'); }
    return {
      args: ['native-only'], expectedAgentInfo: { name: 'fixture', version: '1.0.0' },
      assertUnchanged: this.authorityCheck,
      decodePermission(params) {
        const tool = params.toolCall as { toolCallId: string; rawInput: Record<string, unknown> };
        return { id: tool.toolCallId, name: 'Edit', input: tool.rawInput, status: 'running' };
      },
      decodeUsage(result) {
        const usage = result.usage as { inputTokens: number; outputTokens: number } | undefined;
        return usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : undefined;
      },
      cleanup: async () => { this.events.push('launch-cleanup-start'); this.cleanupStarted.resolve(); await this.finishCleanup; this.events.push('launch-cleanup-end'); },
    };
  }
  protected override _spawnCliProcess(_args: string[], _cwd: string, env: NodeJS.ProcessEnv, cliPath: string): ChildProcess {
    this.launches.push({ path: cliPath, env }); this.events.push('spawn');
    const child = spawn(process.execPath, [fixture, this.dir, this.scenario], { cwd: this.dir, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.push(child);
    this.closed.push(new Promise(resolve => child.once('close', () => resolve())));
    if (this.releasePipeClose) {
      const emit = child.emit.bind(child);
      child.emit = (event, ...args) => {
        if (event !== 'close') { return emit(event, ...args); }
        this.pipeClosePending.resolve();
        void this.releasePipeClose!.then(() => emit(event, ...args));
        return true;
      };
    }
    child.once('exit', () => { this.events.push('child-exit'); });
    return child;
  }
  protected override async prepareAttachments(_attachments: Attachment[] | undefined): Promise<() => Promise<void>> {
    return async () => { this.events.push('attachment-cleanup'); if (this.failAttachmentCleanup) { throw new Error('Attachment cleanup failed'); } };
  }
}
const settings = (): Settings => ({ provider: 'inert-acp', mode: 'ask-before-edit', accessLevel: 'ask-permission', model: 'fixture', contextMode: 'auto', thinkingLevel: 'none' });
async function harness() {
  const provider = new FixtureProvider(); provider.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-acp-public-'));
  provider.setNativeApprovalHost({ handlerForPanel: () => async () => false });
  return provider;
}
async function collect(provider: FixtureProvider, state = settings(), content = 'inert task') {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage(content, [], state, null, undefined, 'panel')) { chunks.push(chunk); if (chunk.type === 'done') { provider.events.push('done'); } }
  return chunks;
}
const envKey = 'MYSTI_ACP_CAPTURE_FIXTURE';
let savedEnv: string | undefined;
beforeEach(() => { clearMockConfig(); savedEnv = process.env[envKey]; });
afterEach(async () => {
  for (const provider of providers.splice(0)) {
    provider.dispose();
    for (const child of provider.children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
    }
    await Promise.all(provider.closed);
    if (provider.dir) { await fs.rm(provider.dir, { recursive: true, force: true }); }
  }
  if (savedEnv === undefined) { delete process.env[envKey]; } else { process.env[envKey] = savedEnv; }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('shared ACP public provider lifecycle', () => {
  it('reads installation versions without executing a bootstrap wrapper', async () => {
    const provider = await harness();
    const entry = path.join(provider.dir, 'cli.cjs');
    const marker = path.join(provider.dir, 'discovery-effect');
    await fs.writeFile(entry, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`, { mode: 0o700 });
    await fs.writeFile(path.join(provider.dir, 'package.json'), '{"version":"1.2.3"}');
    expect(await provider.inspectVersion(entry)).toBe('1.2.3');
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('captures executable and environment before awaiting preparation and prefixes slash text', async () => {
    const provider = await harness(); const gate = deferred<void>(); provider.preparation = gate.promise;
    process.env[envKey] = 'original'; const pending = collect(provider, settings(), '  /allow-all');
    await provider.prepared.promise;
    provider.cliPath = '/inert/replacement'; process.env[envKey] = 'replacement'; gate.resolve();
    const chunks = await pending;
    expect(provider.launches).toHaveLength(1);
    expect(provider.launches[0].path).toBe('/inert/original'); expect(provider.launches[0].env[envKey]).toBe('original');
    const prompt = JSON.parse(await fs.readFile(path.join(provider.dir, 'prompt.json'), 'utf8'));
    expect(prompt.prompt[0].text).toBe('Mysti user request:\n\n  /allow-all');
    expect(chunks.at(-1)).toMatchObject({ type: 'done', usage: { input_tokens: 12, output_tokens: 3 } });
  });

  it.each(['preparation', 'CLI discovery'] as const)('clears prior usage before %s failure and never falls back', async failure => {
    const provider = await harness(); provider.seedUsage();
    if (failure === 'preparation') { provider.failPreparation = true; } else { provider.failDiscovery = true; }
    const legacy = vi.spyOn(provider as unknown as { _sendSingleShot(): AsyncGenerator<StreamChunk> }, '_sendSingleShot');
    const persistent = vi.spyOn(provider as unknown as { _sendViaPersistentProcess(): AsyncGenerator<StreamChunk> }, '_sendViaPersistentProcess');
    const chunks = await collect(provider);
    expect(chunks.at(-1)).toEqual({ type: 'done' }); expect(chunks.filter(chunk => chunk.type === 'error')).toHaveLength(1);
    expect(provider.launches).toHaveLength(0); expect(legacy).not.toHaveBeenCalled(); expect(persistent).not.toHaveBeenCalled();
  });

  it('waits for child shutdown and both cleanup stages before publishing final done', async () => {
    const provider = await harness(); const cleanup = deferred<void>(); provider.finishCleanup = cleanup.promise;
    const pending = collect(provider); await provider.cleanupStarted.promise;
    expect(provider.events).toEqual(['spawn', 'child-exit', 'attachment-cleanup', 'launch-cleanup-start']);
    cleanup.resolve(); await pending;
    expect(provider.events).toEqual(['spawn', 'child-exit', 'attachment-cleanup', 'launch-cleanup-start', 'launch-cleanup-end', 'done']);
  });

  it('rechecks native authority after asynchronous prompt setup before spawning a child', async () => {
    const provider = await harness();
    const authority = path.join(provider.dir, 'unowned-configuration');
    provider.beforePromptBuilt = () => fs.writeFile(authority, 'unowned');
    provider.authorityCheck = async () => {
      await fs.access(authority); throw new Error('Native authority changed before spawn');
    };
    const chunks = await collect(provider);
    expect(provider.launches).toHaveLength(0);
    expect(chunks.some(chunk => chunk.type === 'error' && chunk.content?.includes('authority changed'))).toBe(true);
    expect(provider.events).toEqual(['attachment-cleanup', 'launch-cleanup-start', 'launch-cleanup-end', 'done']);
  });

  it('releases native state even if attachment cleanup throws', async () => {
    const provider = await harness(); provider.failAttachmentCleanup = true;
    const chunks = await collect(provider);
    expect(provider.events).toContain('launch-cleanup-end'); expect(provider.events.at(-1)).toBe('done');
    expect(chunks.some(chunk => chunk.type === 'error' && chunk.content === 'Attachment cleanup failed')).toBe(true);
  });

  it('keeps private state until pipes close after the launcher exits', async () => {
    const provider = await harness(); const pipes = deferred<void>(); provider.releasePipeClose = pipes.promise;
    const pending = collect(provider); await provider.pipeClosePending.promise;
    expect(provider.events).toEqual(['spawn', 'child-exit']);
    pipes.resolve(); await pending;
    expect(provider.events).toEqual(['spawn', 'child-exit', 'attachment-cleanup', 'launch-cleanup-start', 'launch-cleanup-end', 'done']);
  });

  it('reports unverified shutdown and retains private state when pipes never close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = await harness(); const pipes = deferred<void>(); provider.releasePipeClose = pipes.promise;
    const pending = collect(provider); await provider.pipeClosePending.promise;
    await vi.advanceTimersByTimeAsync(5000);
    const chunks = await pending;
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([expect.objectContaining({ content: expect.stringContaining('private state retained') })]);
    expect(provider.events).toEqual(['spawn', 'child-exit', 'done']);
    pipes.resolve();
  });

  it('cleans an asynchronously returned launch after Stop without spawning', async () => {
    const provider = await harness(); const gate = deferred<void>(); provider.preparation = gate.promise;
    const pending = collect(provider); await provider.prepared.promise; provider.cancelCurrentRequest('panel'); gate.resolve(); await pending;
    expect(provider.launches).toHaveLength(0); expect(provider.events).toEqual(['launch-cleanup-start', 'launch-cleanup-end', 'done']);
  });

  it('drains verbose native stderr without blocking initialization', async () => {
    const provider = await harness(); provider.scenario = 'stderr-flood';
    const chunks = await collect(provider);
    expect(chunks.filter(chunk => chunk.type === 'error')).toHaveLength(0);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', usage: { input_tokens: 12, output_tokens: 3 } });
  });
});
