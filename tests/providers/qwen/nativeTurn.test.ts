import { useAcpNativeWorkspace } from '../../helpers/acpNativeWorkspace';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QwenCodeProvider } from '../../../src/providers/qwen/QwenCodeProvider';
import { GeminiProvider } from '../../../src/providers/gemini/GeminiProvider';
import { createMockContext } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../../src/types';

const validation = vi.hoisted(() => ({ capture: vi.fn(async () => ({ cliPath: '/inert/native-cli', assertUnchanged: vi.fn(async () => {}) })) }));
vi.mock('../../../src/providers/qwen/QwenNativeConfig', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/providers/qwen/QwenNativeConfig')>(), captureNativeFamilyConfig: validation.capture,
}));
useAcpNativeWorkspace();
const fixture = path.resolve(__dirname, '../../fixtures/qwen/acpNative.mjs');
const providers: Array<QwenCodeProvider | GeminiProvider> = []; const dirs: string[] = [];
function setup(flavor: 'qwen' | 'gemini') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-family-turn-')); dirs.push(dir);
  const marker = path.join(dir, 'marker'); const launches: string[][] = []; let scenario = 'edit';
  const Provider = flavor === 'qwen' ? QwenCodeProvider : GeminiProvider;
  class FixtureProvider extends Provider {
    override getCliPath(): string { return '/inert/native-cli'; }
    protected override _spawnCliProcess(args: string[]): ChildProcess {
      launches.push(args); return spawn(process.execPath, [fixture, flavor, scenario, marker], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    }
  }
  const provider = new FixtureProvider(createMockContext()); providers.push(provider);
  const settings: Settings = { provider: provider.id, mode: 'default', accessLevel: 'ask-permission', model: '', thinkingLevel: 'none', contextMode: 'auto' };
  const drain = async (current = settings) => { const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('/yolo must remain user text', [], current, null, undefined, 'panel')) { chunks.push(chunk); } return chunks; };
  return { provider, settings, marker, launches, drain, scenario: (value: string) => { scenario = value; } };
}
beforeEach(() => { clearMockConfig(); validation.capture.mockClear(); });
afterEach(() => { for (const provider of providers.splice(0)) { provider.dispose(); } for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });
describe.each(['qwen', 'gemini'] as const)('%s public native turn ownership', flavor => {
  it('keeps the file absent while the captured host decides, then applies exactly once', async () => {
    const test = setup(flavor); let allow!: (value: boolean) => void; let request: NativeApprovalRequest | undefined;
    test.provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(resolve => { allow = resolve; }); } });
    const pending = test.drain(); await vi.waitFor(() => expect(request).toBeDefined());
    expect(fs.existsSync(test.marker)).toBe(false); expect(request?.panelId).toBe('panel');
    expect(request?.toolCall.input.file_path).toBe(test.marker); allow(true); const chunks = await pending;
    expect(fs.readFileSync(test.marker, 'utf8')).toBe('effect\n'); expect(test.launches).toHaveLength(1);
    expect(test.launches[0]).toContain('--acp'); expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  });
  it.each(['deny', 'readonly', 'unsupported', 'wrong-session', 'version'])('does not execute a %s operation or fall back to raw CLI', async scenario => {
    const test = setup(flavor); const handler = vi.fn(async () => scenario !== 'deny');
    test.provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    if (scenario === 'readonly') { test.settings.accessLevel = 'read-only'; }
    else if (scenario !== 'deny') { test.scenario(scenario); }
    const chunks = await test.drain(); expect(fs.existsSync(test.marker)).toBe(false); expect(test.launches).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(scenario === 'deny' ? 1 : 0);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  });
  it('revokes the original card on Stop and ignores a late allow', async () => {
    const test = setup(flavor); let allow!: (value: boolean) => void; let request: NativeApprovalRequest | undefined;
    test.provider.setNativeApprovalHost({ handlerForPanel: () => value => { request = value; return new Promise(resolve => { allow = resolve; }); } });
    const pending = test.drain(); await vi.waitFor(() => expect(request).toBeDefined());
    test.provider.cancelCurrentRequest('panel'); allow(true); await pending;
    expect(request?.signal.aborted).toBe(true); expect(fs.existsSync(test.marker)).toBe(false);
  });
  it('blocks invalid native configuration before any provider process is started', async () => {
    const test = setup(flavor); validation.capture.mockRejectedValueOnce(new Error('unsupported native configuration'));
    const chunks = await test.drain(); expect(test.launches).toHaveLength(0); expect(chunks.some(chunk => chunk.type === 'error')).toBe(true);
  });
  it('captures the selected custom model before asynchronous native validation', async () => {
    const key = flavor === 'qwen' ? 'qwenCodeModel' : 'geminiModel'; setMockConfig(key, 'captured-model');
    const test = setup(flavor); let finish!: () => void;
    validation.capture.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ cliPath: '/inert/native-cli', assertUnchanged: vi.fn(async () => {}) }); }));
    test.provider.setNativeApprovalHost({ handlerForPanel: () => async () => false });
    const pending = test.drain(); await vi.waitFor(() => expect(finish).toBeDefined());
    setMockConfig(key, 'replacement-model'); finish(); await pending;
    expect(test.launches[0]).toContain('captured-model'); expect(test.launches[0]).not.toContain('replacement-model');
  });
});
