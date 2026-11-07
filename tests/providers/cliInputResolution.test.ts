import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClineProvider } from '../../src/providers/cline/ClineProvider';
import { CopilotProvider } from '../../src/providers/copilot/CopilotProvider';
import { CursorProvider } from '../../src/providers/cursor/CursorProvider';
import type { ProviderInputResolver } from '../../src/providers/base/IProvider';
import type { ContextItem, Conversation, Settings, StreamChunk } from '../../src/types';
import { clearMockConfig } from '../helpers/mockVscode';
import { killProcessTree } from '../../src/utils/processKill';

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }));
vi.mock('../../src/utils/processKill', async original => ({ ...await original<typeof import('../../src/utils/processKill')>(),
  killProcessTree: vi.fn(async () => undefined), markOwnedProcessGroup: vi.fn(),
}));
vi.mock('../../src/utils/platform', async original => ({ ...await original<typeof import('../../src/utils/platform')>(), getEnrichedEnv: () => ({ PATH: '/owned/fixture' }) }));
const MANUAL = 'MANUAL_REFERENCE_RETAIN';
const AUTO = 'CAPTURED_EDITOR_BYTES';
const manual: ContextItem = { id: 'manual', type: 'file', path: '/manual.ts', content: MANUAL, enabled: true };
const automatic: ContextItem = { id: 'automatic', type: 'file', path: '/captured.ts', content: AUTO, enabled: true };
const classes = { cline: ClineProvider, copilot: CopilotProvider, cursor: CursorProvider };
type Name = keyof typeof classes;
const subscriptions: Array<{ dispose(): void }> = [];
const providers: Array<ClineProvider | CopilotProvider | CursorProvider> = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function drain(iterator: AsyncGenerator<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of iterator) chunks.push(chunk); return chunks; }
function fakeChild() {
  return Object.assign(new EventEmitter(), { pid: 970001, exitCode: null, signalCode: null, killed: false,
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), writable: true }),
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}
function fixture(name: Name, hold = false) {
  const provider = new classes[name]({ subscriptions } as any); providers.push(provider);
  const settings = { provider: provider.id, model: 'auto', mode: 'default', accessLevel: name === 'cline' ? 'full-access' : 'read-only', contextMode: 'auto', thinkingLevel: 'none' } as Settings;
  const entered = deferred(), release = deferred();
  const instructions = vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockImplementationOnce(async () => {
    entered.resolve(); if (hold) await release.promise; return 'TRUSTED_INSTRUCTIONS';
  }).mockResolvedValue('TRUSTED_INSTRUCTIONS');
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/owned/fixture/cli');
  if (name === 'cursor') vi.spyOn(provider as any, '_resolveApiKey').mockReturnValue(undefined);
  (provider as any)._cachedCliVersion = name === 'cline' ? '3.0.61' : '1.0.94';
  const children: ChildProcess[] = [];
  vi.mocked(spawn).mockImplementation(() => { const child = fakeChild(); children.push(child); return child; });
  vi.spyOn(provider as any, 'processStream').mockImplementation(async function* () { yield { type: 'text', content: 'Healthy answer' }; });
  const tracker = { registerProcess: vi.fn(), clearProcess: vi.fn() };
  const send = (resolver?: ProviderInputResolver, content = 'MANUAL_REQUEST', context = [manual], conversation: Conversation | null = null) =>
    (provider.sendMessage as any)(content, context, settings, conversation, undefined, 'panel', tracker, undefined, undefined, resolver) as AsyncGenerator<StreamChunk>;
  const wire = (index = 0): string => {
    const args = vi.mocked(spawn).mock.calls[index][1] as string[];
    if (name === 'cline') return args.at(-1) === '-' ? vi.mocked(children[index].stdin!.write).mock.calls.map(c => String(c[0])).join('') : args.at(-1)!;
    return args[args.lastIndexOf('-p') + 1];
  };
  return { provider, settings, entered, release, instructions, children, tracker, send, wire };
}
beforeEach(() => { clearMockConfig(); vi.clearAllMocks(); });
afterEach(() => { for (const p of providers.splice(0)) p.dispose(); for (const item of subscriptions.splice(0)) item.dispose(); vi.restoreAllMocks(); clearMockConfig(); });

for (const name of Object.keys(classes) as Name[]) {
  describe(`${name} request input at actual CLI delivery`, () => {
    it('delivers enabled captured bytes without modifying the manual request baseline', async () => {
      const h = fixture(name); const baseline = [manual];
      const chunks = await drain(h.send(() => ({ content: 'CURRENT_REQUEST', context: [manual, automatic] }), 'MANUAL_REQUEST', baseline));
      expect(spawn).toHaveBeenCalledOnce(); expect(h.wire()).toContain(AUTO); expect(h.wire()).toContain(MANUAL);
      expect(h.wire()).toContain('CURRENT_REQUEST'); expect(h.wire()).not.toContain('MANUAL_REQUEST');
      expect(baseline).toEqual([manual]); expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    });
    it('resolves after held instruction preparation so disabling removes only automatic bytes', async () => {
      const h = fixture(name, true); let enabled = true;
      const pending = drain(h.send(() => ({ content: 'CURRENT_REQUEST', context: enabled ? [manual, automatic] : [manual] })));
      try { await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Request did not enter setup'); })]); enabled = false; h.release.resolve(); await pending; }
      finally { h.release.resolve(); await pending; }
      expect(spawn).toHaveBeenCalledOnce(); expect(h.wire()).not.toContain(AUTO); expect(h.wire()).toContain(MANUAL);
      expect(h.wire()).toContain('CURRENT_REQUEST'); expect(h.wire()).toContain('TRUSTED_INSTRUCTIONS');
    });
    it('delivers no input or completion after ownership expires during preparation', async () => {
      const h = fixture(name, true); let current = true;
      const pending = drain(h.send(() => current ? { content: 'CURRENT_REQUEST', context: [manual, automatic] } : undefined));
      try { await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Request ended before setup'); })]); current = false; h.release.resolve(); expect(await pending).toEqual([]); }
      finally { h.release.resolve(); await pending; }
      expect(spawn).not.toHaveBeenCalled(); expect(h.tracker.clearProcess).not.toHaveBeenCalled();
    });
    it('rejects an already obsolete callback without cancelling a running predecessor', async () => {
      const h = fixture(name); const previous = (h.provider as any)._getSession('panel'); const child = fakeChild(); previous.process = child;
      const cancel = vi.spyOn(h.provider, 'cancelCurrentRequest');
      expect(await drain(h.send(() => undefined))).toEqual([]);
      expect(spawn).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(killProcessTree).not.toHaveBeenCalled();
      expect((h.provider as any)._getSession('panel').process).toBe(child); expect(h.instructions).not.toHaveBeenCalled();
    });
    it('honors Stop while instructions await without spawning or clearing another child', async () => {
      const h = fixture(name, true); const pending = drain(h.send(() => ({ content: 'CURRENT_REQUEST', context: [manual, automatic] })));
      try { await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Request ended before setup'); })]); h.provider.cancelCurrentRequest('panel'); h.release.resolve(); expect(await pending).toEqual([]); }
      finally { h.release.resolve(); await pending; }
      expect(spawn).not.toHaveBeenCalled(); expect(h.tracker.clearProcess).not.toHaveBeenCalled();
    });
    it('a late old preparation cannot spawn or kill the healthy same-panel successor', async () => {
      const h = fixture(name, true); const old = drain(h.send(() => ({ content: 'OLD_REQUEST', context: [manual, automatic] })));
      await Promise.race([h.entered.promise, old.then(() => { throw new Error('Request ended before setup'); })]);
      const next = h.send(undefined, 'SUCCESSOR');
      try {
        expect((await next.next()).value).toMatchObject({ type: 'session_active' });
        const successor = h.children[0]; expect(successor).toBeDefined();
        h.release.resolve(); expect(await old).toEqual([]);
        expect(spawn).toHaveBeenCalledOnce(); expect(h.wire()).toContain('SUCCESSOR');
        expect((h.provider as any)._getSession('panel').process).toBe(successor);
        expect(killProcessTree).not.toHaveBeenCalledWith(successor, expect.anything(), expect.anything());
        expect(h.tracker.clearProcess).not.toHaveBeenCalled();
        const chunks = await drain(next); expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
        expect(h.tracker.clearProcess).toHaveBeenCalledWith('panel', successor);
      } finally { h.release.resolve(); await old; await next.return(undefined); }
    });
    it('an older yielded stream cannot clear or kill a newer same-panel child', async () => {
      const h = fixture(name); const old = h.send(undefined, 'OLD_DELIVERED');
      expect((await old.next()).value).toMatchObject({ type: 'session_active' });
      const oldChild = h.children[0]; const next = h.send(undefined, 'SUCCESSOR');
      try {
        expect((await next.next()).value).toMatchObject({ type: 'session_active' });
        const successor = h.children[1]; expect(successor).toBeDefined();
        expect(await drain(old)).toEqual([]);
        expect((h.provider as any)._getSession('panel').process).toBe(successor);
        expect(killProcessTree).not.toHaveBeenCalledWith(successor, expect.anything(), expect.anything());
        expect(h.tracker.clearProcess).toHaveBeenCalledWith('panel', oldChild);
        expect(h.tracker.clearProcess).not.toHaveBeenCalledWith('panel', successor);
        expect((await drain(next)).filter(c => c.type === 'done')).toHaveLength(1);
      } finally { await old.return(undefined); await next.return(undefined); }
    });
    it('preserves permission refusal before cancelling a running predecessor', async () => {
      const h = fixture(name); h.settings.accessLevel = 'ask-permission';
      const previous = (h.provider as any)._getSession('panel'); const child = fakeChild(); previous.process = child;
      const cancel = vi.spyOn(h.provider, 'cancelCurrentRequest');
      let diagnostic = '';
      try { diagnostic = JSON.stringify(await drain(h.send(() => ({ content: 'REQUEST', context: [manual] })))); }
      catch (error) { diagnostic = String(error); }
      expect(diagnostic).toContain('cannot request approval');
      expect(spawn).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
      expect((h.provider as any)._getSession('panel').process).toBe(child);
      expect(killProcessTree).not.toHaveBeenCalled();
    });
    it('preserves no-resolver manual context, provider history policy, permission args and one terminal', async () => {
      const h = fixture(name);
      const history = { id: 'history', messages: [{ id: 'prior', role: 'user', content: 'PRIOR_HISTORY', timestamp: Date.now() }] } as Conversation;
      const chunks = await drain(h.send(undefined, 'MANUAL_REQUEST', [manual], history));
      expect(spawn).toHaveBeenCalledOnce(); expect(h.wire()).toContain('MANUAL_REQUEST'); expect(h.wire()).toContain(MANUAL); expect(h.wire()).not.toContain(AUTO);
      expect(h.wire()).toContain('PRIOR_HISTORY');
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).not.toContain('--allow-all-tools'); expect(args).not.toContain('--yolo');
      expect(chunks.filter(c => c.type === 'done')).toHaveLength(1); expect(chunks.some(c => c.type === 'error')).toBe(false);
      expect(h.tracker.clearProcess).toHaveBeenCalledWith('panel', h.children[0]);
    });
  });
}

describe('Cline final prompt transport limits', () => {
  it('uses legacy stdin for the final large resolved prompt', async () => {
    const h = fixture('cline'); (h.provider as any)._cachedCliVersion = '1.0.0';
    await drain(h.send(() => ({ content: 'L'.repeat(200_100), context: [manual] })));
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.at(-1)).toBe('-'); expect(h.wire()).toContain('L'.repeat(200_100));
    expect(h.children[0].stdin!.write).toHaveBeenCalledOnce(); expect(h.children[0].stdin!.end).toHaveBeenCalledOnce();
  });
  it('applies the modern argv limit to the final resolved prompt', async () => {
    const h = fixture('cline');
    const chunks = await drain(h.send(() => ({ content: 'L'.repeat(200_100), context: [manual] })));
    expect(spawn).not.toHaveBeenCalled(); expect(chunks).toEqual([expect.objectContaining({ type: 'error', content: expect.stringContaining('too large') })]);
  });
  it('drops revoked oversized context before deciding whether modern argv is too large', async () => {
    const h = fixture('cline', true); let enabled = true;
    const pending = drain(h.send(() => ({ content: 'SMALL_REQUEST', context: enabled ? [manual, { ...automatic, content: 'L'.repeat(200_100) }] : [manual] })));
    try { await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Request ended before setup'); })]); enabled = false; h.release.resolve(); await pending; }
    finally { h.release.resolve(); await pending; }
    expect(spawn).toHaveBeenCalledOnce(); expect(h.wire()).toContain('SMALL_REQUEST'); expect(h.wire()).toContain(MANUAL); expect(h.wire().length).toBeLessThan(200_000);
  });
});


describe('Cursor final input after asynchronous imports', () => {
  for (const cancel of [false, true]) {
    it(`resolves after environment lookup for ${cancel ? 'obsolete ownership' : 'disabled automatic context'}`, async () => {
      const h = fixture('cursor'); let changed = false;
      vi.mocked((h.provider as any)._resolveApiKey).mockImplementation(() => { changed = true; return undefined; });
      const chunks = await drain(h.send(() => changed && cancel ? undefined : {
        content: 'CURRENT_REQUEST', context: changed ? [manual] : [manual, automatic],
      }));
      expect(changed).toBe(true);
      if (cancel) { expect(chunks).toEqual([]); expect(spawn).not.toHaveBeenCalled(); }
      else { expect(spawn).toHaveBeenCalledOnce(); expect(h.wire()).toContain(MANUAL); expect(h.wire()).not.toContain(AUTO); }
    });
  }
});

it('keeps modern Cline read-only refusal unchanged with a live resolver', async () => {
  const h = fixture('cline'); h.settings.accessLevel = 'read-only';
  await expect(drain(h.send(() => ({ content: 'REQUEST', context: [manual] })))).rejects.toThrow('cannot use Plan or Read Only safely');
  expect(spawn).not.toHaveBeenCalled(); expect(h.instructions).not.toHaveBeenCalled();
});
