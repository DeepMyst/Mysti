import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { ContextItem, Settings, StreamChunk } from '../../../src/types';

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }));
vi.mock('../../../src/utils/platform', async original => ({ ...await original<typeof import('../../../src/utils/platform')>(), readOpenClawToken: () => undefined }));
const settings = { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'auto' } as Settings;
const manual: ContextItem = { id: 'manual', type: 'file', path: '/manual.ts', content: 'MANUAL_BYTES', enabled: true };
const automatic: ContextItem = { id: 'auto', type: 'file', path: '/editor.ts', content: 'AUTOMATIC_BYTES', enabled: true };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function collect(stream: AsyncGenerator<StreamChunk>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
const providers: TestableOpenClawProvider[] = [];
function fixture(transport: 'gateway' | 'cli', stage?: 'instructions' | 'connect') {
  setMockConfig('openclawUseGateway', transport === 'gateway');
  const provider = new TestableOpenClawProvider(); providers.push(provider);
  const gateway = (provider as any)._gateway, gate = deferred(), entered = deferred();
  const hold = async (at: typeof stage) => { if (stage === at) { entered.resolve(); await gate.promise; } };
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockImplementation(async () => { await hold('instructions'); return 'TRUSTED_ROLE'; });
  let connected = stage !== 'connect';
  vi.spyOn(gateway, 'isConnected').mockImplementation(() => connected);
  vi.spyOn(gateway, 'connect').mockImplementation(async () => { await hold('connect'); connected = true; return true; });
  const frames: any[] = [], files: string[] = [], delivered: string[] = [];
  // Keep the production sendAgentMessage and JSON frame serialization. Only the
  // socket is local; its final response settles the real pending request.
  gateway._ws = { readyState: 1, send: (json: string) => {
    const frame = JSON.parse(json); frames.push(frame);
    queueMicrotask(() => gateway._pendingRequests.get(frame.id)?.resolve({ type: 'res', id: frame.id, ok: true, payload: { text: 'owned response' } }));
  }, removeAllListeners() {}, close() {} };
  const child = Object.assign(new EventEmitter(), { pid: 74002, exitCode: 0, signalCode: null, stdout: new EventEmitter(),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) });
  vi.mocked(spawn).mockImplementation((_command, args: any) => {
    const file = args[args.indexOf('--message-file') + 1]; files.push(file); delivered.push(fs.readFileSync(file, 'utf8')); return child as any;
  });
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/owned/fixture/openclaw');
  vi.spyOn(provider as any, 'processStream').mockImplementation(async function* () { yield { type: 'text', content: 'owned response' }; });
  let enabled = true, current = true;
  const resolveInput = () => current ? { content: enabled ? 'DYNAMIC_AUTO' : 'DYNAMIC_MANUAL', context: enabled ? [manual, automatic] : [manual] } : undefined;
  const start = (dynamic = true, s = settings) => (provider.sendMessage as any)('STATIC_QUESTION', [manual], s, null, undefined, 'panel', undefined, undefined, undefined, dynamic ? resolveInput : undefined) as AsyncGenerator<StreamChunk>;
  return { provider, gateway, gate, entered, frames, files, delivered, start, disable: () => { enabled = false; }, revoke: () => { current = false; },
    prompt: () => transport === 'gateway' ? frames.find(f => f.method === 'agent')?.params.message : delivered[0] };
}
beforeEach(() => { clearMockConfig(); vi.clearAllMocks(); });
afterEach(() => { providers.splice(0).forEach(p => p.dispose()); vi.restoreAllMocks(); clearMockConfig(); });
describe('OpenClaw final request input', () => {
  for (const transport of ['gateway', 'cli'] as const) for (const action of ['disable', 'revoke'] as const) {
    const stages = transport === 'gateway' ? ['instructions', 'connect', 'yield'] as const : ['instructions'] as const;
    for (const stage of stages) it(`${transport} honors ${action} during ${stage}`, async () => {
      const h = fixture(transport, stage === 'yield' ? undefined : stage), stream = h.start();
      let pending: Promise<unknown> | undefined;
      try {
        if (stage === 'yield') { expect((await stream.next()).value).toMatchObject({ type: 'session_active' }); h[action](); pending = collect(stream); }
        else { pending = collect(stream); await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Preparation gate not reached'); })]); h[action](); h.gate.resolve(); }
        await pending;
        if (action === 'revoke') { expect(h.prompt()).toBeUndefined(); expect(h.files).toEqual([]); }
        else {
          expect(h.prompt()).toContain('DYNAMIC_MANUAL'); expect(h.prompt()).toContain('MANUAL_BYTES'); expect(h.prompt()).toContain('TRUSTED_ROLE');
          expect(h.prompt()).not.toContain('AUTOMATIC_BYTES'); expect(h.prompt()).not.toContain('DYNAMIC_AUTO');
          for (const file of h.files) expect(fs.existsSync(file)).toBe(false);
          if (transport === 'gateway') expect(h.frames[0].params.thinking).toBe('low');
        }
      } finally { h.gate.resolve(); await pending; await stream.return(undefined as never); }
    });
  }
  for (const transport of ['gateway', 'cli'] as const) {
    it(`${transport} includes enabled dynamic context`, async () => {
      const h = fixture(transport); await collect(h.start()); expect(h.prompt()).toContain('DYNAMIC_AUTO'); expect(h.prompt()).toContain('AUTOMATIC_BYTES');
      expect(h.prompt()).toContain('MANUAL_BYTES'); expect(automatic.content).toBe('AUTOMATIC_BYTES');
    });
    it(`${transport} preserves static callers`, async () => {
      const h = fixture(transport); await collect(h.start(false)); expect(h.prompt()).toContain('STATIC_QUESTION'); expect(h.prompt()).toContain('MANUAL_BYTES'); expect(h.prompt()).not.toContain('AUTOMATIC_BYTES');
    });
    it(`${transport} leaves an existing turn alone when input is already obsolete`, async () => {
      const h = fixture(transport), previous = new AbortController();
      (h.provider as any)._requestControllers.set('panel', previous); h.revoke();
      expect(await collect(h.start())).toEqual([]); expect(previous.signal.aborted).toBe(false); expect(h.prompt()).toBeUndefined();
    });
    it(`${transport} keeps approval restrictions`, async () => {
      const h = fixture(transport); const result = await collect(h.start(true, { ...settings, accessLevel: 'read-only' }));
      expect(result.map(c => c.type)).toEqual(['error', 'done']); expect(h.prompt()).toBeUndefined();
    });
  }
});
