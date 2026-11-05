import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from '../../../src/managers/ProviderManager';
import { TestableClaudeProvider, TestableGeminiProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { ContextItem, Settings } from '../../../src/types';

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn(),
}));
vi.mock('../../../src/utils/processKill', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/processKill')>(),
  killProcessTree: vi.fn(async () => undefined), markOwnedProcessGroup: vi.fn(),
}));

const settings = { provider: 'claude-code', model: 'claude-opus-4-6', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'auto' } as Settings;
const manual: ContextItem = { id: 'manual', type: 'file', path: '/manual.ts', content: 'MANUAL_BYTES', enabled: true };
const automatic: ContextItem = { id: 'automatic', type: 'file', path: '/editor.ts', content: 'AUTO_BYTES', enabled: true };
type Input = { content: string; context: ContextItem[] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function drain(gen: AsyncGenerator<unknown>) { const chunks = []; for await (const c of gen) chunks.push(c); return chunks; }
const providers: Array<TestableClaudeProvider | TestableGeminiProvider> = [];
function harness(persistent: boolean, wait?: 'attachments' | 'instructions') {
  const provider = persistent ? new TestableClaudeProvider() : new TestableGeminiProvider(); providers.push(provider);
  Object.defineProperty(provider, 'capabilities', { value: { ...provider.capabilities, supportsPersistentProcess: persistent } });
  const write = vi.fn(() => true), end = vi.fn();
  const child = Object.assign(new EventEmitter(), { pid: 74001, exitCode: null, signalCode: null,
    stdin: Object.assign(new EventEmitter(), { writable: true, write, end }),
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  const gate = deferred(), entered = deferred(), cleanup = vi.fn(async () => undefined);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/owned-fixture/claude');
  vi.spyOn(provider, 'buildCliArgs').mockReturnValue([]);
  vi.spyOn(provider as any, 'prepareAttachments').mockImplementation(async () => {
    if (wait === 'attachments') { entered.resolve(); await gate.promise; }
    return cleanup;
  });
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockImplementation(async () => {
    if (wait === 'instructions') { entered.resolve(); await gate.promise; }
    return 'TRUSTED_ROLE';
  });
  vi.spyOn(provider as any, 'processStream').mockImplementation(async function* () {
    child.exitCode = 0; yield { type: 'text', content: 'local response' };
  });
  vi.spyOn(provider as any, '_getOrSpawnPersistentProcess').mockImplementation(async (session: any) => {
    session.persistentProcess = child; session.persistentReady = true; return child;
  });
  vi.spyOn(provider as any, '_readUntilBoundary').mockImplementation(async function* (_proc: unknown, session: any) {
    session.process = null; yield { type: 'text', content: 'local response' };
  });
  const send = (resolveInput?: () => Input | undefined, baseline: Input = { content: 'QUESTION_WITH_AUTO', context: [manual, automatic] }) =>
    drain((provider.sendMessage as any)(baseline.content, baseline.context, settings, null, undefined, 'panel', undefined, undefined, undefined, resolveInput));
  return { provider, write, end, gate, entered, cleanup, send,
    delivered: () => write.mock.calls.map(call => String(call[0])).join('\n') };
}

describe('trusted request input at the base CLI delivery boundary', () => {
  beforeEach(() => { clearMockConfig(); vi.clearAllMocks(); });
  afterEach(() => { for (const provider of providers.splice(0)) provider.dispose(); vi.restoreAllMocks(); clearMockConfig(); });

  for (const persistent of [false, true]) {
    const mode = persistent ? 'persistent' : 'single-shot';
    for (const wait of ['attachments', 'instructions'] as const) {
      it(`${mode} refreshes prompt and context after ${wait} while retaining the manual request`, async () => {
        const h = harness(persistent, wait); let enabled = true;
        const resolveInput = () => ({ content: enabled ? 'QUESTION_WITH_AUTO' : 'QUESTION_WITHOUT_AUTO', context: enabled ? [manual, automatic] : [manual] });
        const pending = h.send(resolveInput);
        try { await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Request ended before preparation gate'); })]); enabled = false; h.gate.resolve(); await pending; }
        finally { h.gate.resolve(); await pending; }
        expect(h.delivered()).toContain('QUESTION_WITHOUT_AUTO'); expect(h.delivered()).toContain('MANUAL_BYTES');
        expect(h.delivered()).toContain('TRUSTED_ROLE'); expect(h.delivered()).not.toContain('AUTO_BYTES');
        expect(h.delivered()).not.toContain('QUESTION_WITH_AUTO'); expect(h.write).toHaveBeenCalledOnce();
        expect(h.cleanup).toHaveBeenCalledOnce(); expect(automatic.content).toBe('AUTO_BYTES');
      });

      it(`${mode} never delivers or falls back when ownership expires during ${wait}`, async () => {
        const h = harness(persistent, wait); let current = true;
        const pending = h.send(() => current ? { content: 'QUESTION_WITH_AUTO', context: [manual, automatic] } : undefined);
        try { await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Request ended before preparation gate'); })]); current = false; h.gate.resolve(); await pending; }
        finally { h.gate.resolve(); await pending; }
        expect(h.write).not.toHaveBeenCalled(); expect(h.cleanup).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledTimes(persistent || wait === 'attachments' ? 0 : 1);
      });
    }

    it(`${mode} includes enabled dynamic input without changing the manual baseline`, async () => {
      const h = harness(persistent); const baseline = { content: 'MANUAL_QUESTION', context: [manual] };
      await h.send(() => ({ content: 'DYNAMIC_QUESTION', context: [manual, automatic] }), baseline);
      expect(h.delivered()).toContain('DYNAMIC_QUESTION'); expect(h.delivered()).toContain('AUTO_BYTES');
      expect(h.delivered()).toContain('MANUAL_BYTES'); expect(h.write).toHaveBeenCalledOnce();
      expect(baseline).toEqual({ content: 'MANUAL_QUESTION', context: [manual] });
    });

    it(`${mode} skips an already obsolete request without allocating a child or attachments`, async () => {
      const h = harness(persistent); await h.send(() => undefined);
      expect(h.write).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(h.cleanup).not.toHaveBeenCalled();
      expect((h.provider as any).prepareAttachments).not.toHaveBeenCalled();
    });
  }

  for (const explicit of [false, true]) {
    it(`ProviderManager forwards a request-local resolver through the ${explicit ? 'explicit' : 'active'} route`, async () => {
      const calls: any[][] = [];
      const provider = { id: 'claude-code', async *sendMessage(...args: any[]) { calls.push(args); yield { type: 'done' }; } };
      const manager = Object.assign(Object.create(ProviderManager.prototype), { _registry: { get: () => provider }, _panelProviders: new Map() });
      const resolveInput = () => ({ content: 'CURRENT_PROMPT', context: [manual] });
      const gen = explicit
        ? manager.sendMessageToProvider('claude-code', 'OLD_PROMPT', [], settings, null, undefined, 'panel', resolveInput)
        : manager.sendMessage('OLD_PROMPT', [], settings, null, undefined, 'panel', undefined, undefined, resolveInput);
      await drain(gen);
      expect(calls).toHaveLength(1); expect(calls[0][0]).toBe('CURRENT_PROMPT'); expect(calls[0][1]).toEqual([manual]);
      expect(calls[0][9]).toBe(resolveInput); expect(settings).not.toHaveProperty('resolveInput');
    });
  }

  it('preserves Claude attachment paths and excludes duplicate CLI system context on both prompt APIs', async () => {
    const h = harness(true);
    const attachments = [{ id: 'file', type: 'file', fileName: 'example.txt', filePath: '/owned/example.txt' }];
    const legacy = await (h.provider as any).buildPromptAsync('QUESTION', [manual], null, settings, undefined, undefined, attachments, 'CLI_SYSTEM_ALREADY_SENT');
    const render = await (h.provider as any).preparePromptRenderer(null, settings, undefined, undefined, attachments, 'CLI_SYSTEM_ALREADY_SENT');
    // Each rendering chooses a fresh data-frame marker. Compare every byte of
    // the actual payload and surrounding instructions, excluding only the two
    // generated delimiter lines.
    const withoutFrameMarker = (prompt: string) => {
      const frame = /^<<<UNTRUSTED ([^\n]+)\n([\s\S]*?)\n\1 UNTRUSTED>>>/m.exec(prompt);
      expect(frame).not.toBeNull();
      return prompt.slice(0, frame!.index) + '<reference>\n' + frame![2] + '\n</reference>'
        + prompt.slice(frame!.index + frame![0].length);
    };
    expect(withoutFrameMarker(render('QUESTION', [manual]))).toBe(withoutFrameMarker(legacy));
    expect(legacy.match(/\/owned\/example.txt/g)).toHaveLength(1);
    expect(legacy).toContain('MANUAL_BYTES'); expect(legacy).not.toContain('CLI_SYSTEM_ALREADY_SENT');
    expect(legacy).toContain('[Planning Mode]');
  });

  it('preserves no-resolver slash commands and their Claude attachment references without loading agent instructions', async () => {
    const h = harness(true);
    const prompt = await (h.provider as any).buildPromptAsync(' /compact ', [automatic], null, settings, undefined, undefined,
      [{ id: 'file', type: 'file', fileName: 'example.txt', filePath: '/owned/example.txt' }]);
    expect(prompt).toContain('/compact'); expect(prompt).toContain('/owned/example.txt');
    expect(prompt).not.toContain('AUTO_BYTES'); expect(prompt).not.toContain('[Planning Mode]');
    expect((h.provider as any).buildAgentInstructionsAsync).not.toHaveBeenCalled();
  });
});
