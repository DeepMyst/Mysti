import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import { OpenCodeProvider } from '../../../src/providers/opencode/OpenCodeProvider';
import { clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';
import type { ContextItem, Settings, StreamChunk } from '../../../src/types';

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }));

const settings = { provider: 'opencode', model: 'vendor/model', mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'auto' } as Settings;
const manual: ContextItem = { id: 'manual', type: 'file', path: '/manual.ts', content: 'MANUAL_BYTES', enabled: true };
const automatic: ContextItem = { id: 'auto', type: 'file', path: '/editor.ts', content: 'AUTOMATIC_BYTES', enabled: true };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function collect(stream: AsyncGenerator<StreamChunk>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
const providers: OpenCodeProvider[] = [];
function fixture(stage?: 'instructions' | 'session' | 'events' | 'password', extraReplyPart = false) {
  setMockConfig('opencodeEndpoint', 'http://localhost:4096'); setMockConfig('opencodeDirectory', '/owned/project');
  const secrets = createMockSecretStorage();
  const provider = new OpenCodeProvider({ subscriptions: [], secrets } as any); providers.push(provider);
  const gate = deferred(), entered = deferred(); let passwords = 0;
  const hold = async (at: typeof stage) => { if (stage === at) { entered.resolve(); await gate.promise; } };
  vi.spyOn(secrets, 'get').mockImplementation(async () => { if (++passwords === 3) await hold('password'); return 'owned-password'; });
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockImplementation(async () => { await hold('instructions'); return 'TRUSTED_ROLE'; });
  const requests: Array<{ route: string; method: string; body: any; headers: any; directory: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    const route = url.pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ route, method: init.method!, body, headers: init.headers, directory: url.searchParams.get('directory') });
    if (route === '/session') { await hold('session'); return Response.json({ id: 'owned', permission: body.permission }); }
    if (route === '/event') { await hold('events'); return new Response(new ReadableStream()); }
    if (route.endsWith('/message')) return Response.json({ parts: [{ id: 'answer', type: 'text', text: 'owned answer' },
      ...(extraReplyPart ? [{ id: 'second', type: 'text', text: 'obsolete second part' }] : [])] });
    return Response.json({});
  }));
  let enabled = true, current = true;
  const resolveInput = () => current ? { content: enabled ? 'DYNAMIC_AUTO' : 'DYNAMIC_MANUAL', context: enabled ? [manual, automatic] : [manual] } : undefined;
  const send = (dynamic = true) => collect((provider.sendMessage as any)('STATIC_QUESTION', [manual], settings, null, undefined, 'panel', undefined, undefined, undefined, dynamic ? resolveInput : undefined));
  return { provider, gate, entered, requests, send, disable: () => { enabled = false; }, revoke: () => { current = false; } };
}
beforeEach(() => { clearMockConfig(); });
afterEach(() => { providers.splice(0).forEach(p => p.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); });
describe('OpenCode final request input', () => {
  it('suppresses remaining reply parts and done after Stop at a public text yield', async () => {
    const h = fixture(undefined, true);
    const stream = h.provider.sendMessage('QUESTION', [manual], settings, null, undefined, 'panel');
    try {
      expect((await stream.next()).value).toEqual({ type: 'text', content: 'owned answer' });
      h.provider.cancelCurrentRequest('panel');
      expect(await collect(stream)).toEqual([]);
      expect(h.requests.some(r => r.method === 'DELETE')).toBe(true);
    } finally { await stream.return(undefined); }
  });
  for (const action of ['disable', 'revoke', 'enabled', 'static'] as const) it(`local CLI ${action} reaches the shared stdin boundary`, async () => {
    const h = fixture('instructions'); setMockConfig('opencodeEndpoint', '');
    const writes: string[] = [];
    const child = Object.assign(new EventEmitter(), { pid: 74003, exitCode: 0, signalCode: null,
      stdin: Object.assign(new EventEmitter(), { writable: true, write: (data: string) => { writes.push(String(data)); return true; }, end: vi.fn() }),
      stdout: new EventEmitter(), stderr: new EventEmitter() });
    vi.mocked(spawn).mockReturnValue(child as any);
    vi.spyOn(h.provider, 'getCliPath').mockReturnValue('/owned/fixture/opencode');
    vi.spyOn(h.provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
    vi.spyOn(h.provider as any, 'processStream').mockImplementation(async function* () { yield { type: 'text', content: 'owned response' }; });
    let enabled = true, current = true;
    const input = () => current ? { content: enabled ? 'DYNAMIC_AUTO' : 'DYNAMIC_MANUAL', context: enabled ? [manual, automatic] : [manual] } : undefined;
    const pending = collect((h.provider.sendMessage as any)('STATIC_QUESTION', [manual], { ...settings, mode: 'edit-automatically', accessLevel: 'full-access' }, null,
      undefined, 'panel', undefined, undefined, undefined, action === 'static' ? undefined : input));
    try {
      await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Local preparation gate not reached'); })]);
      if (action === 'disable') enabled = false; if (action === 'revoke') current = false;
      h.gate.resolve(); await pending;
      if (action === 'revoke') expect(writes).toEqual([]);
      else {
        expect(writes).toHaveLength(1); expect(writes[0]).toContain('MANUAL_BYTES');
        expect(writes[0]).toContain(action === 'static' ? 'STATIC_QUESTION' : action === 'enabled' ? 'DYNAMIC_AUTO' : 'DYNAMIC_MANUAL');
        if (action === 'enabled') expect(writes[0]).toContain('AUTOMATIC_BYTES'); else expect(writes[0]).not.toContain('AUTOMATIC_BYTES');
      }
    } finally { h.gate.resolve(); await pending; }
  });
  it('includes enabled dynamic context in the remote request without changing canonical input', async () => {
    const h = fixture(); await h.send();
    const message = h.requests.find(r => r.route.endsWith('/message'))!;
    expect(message.body.parts[0].text).toContain('DYNAMIC_AUTO'); expect(message.body.parts[0].text).toContain('AUTOMATIC_BYTES');
    expect(manual.content).toBe('MANUAL_BYTES'); expect(automatic.content).toBe('AUTOMATIC_BYTES');
  });
  for (const stage of ['instructions', 'session', 'events', 'password'] as const) {
    for (const action of ['disable', 'revoke'] as const) it(`${action} during ${stage} is honored in actual message JSON`, async () => {
      const h = fixture(stage), pending = h.send();
      try {
        await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Preparation gate not reached'); })]);
        h[action](); h.gate.resolve(); const chunks = await pending;
        const messages = h.requests.filter(r => r.route.endsWith('/message'));
        if (action === 'revoke') { expect(messages).toEqual([]); expect(chunks).toEqual([]); }
        else {
          expect(messages).toHaveLength(1); const request = messages[0];
          expect(request.body.parts[0].text).toContain('DYNAMIC_MANUAL'); expect(request.body.parts[0].text).toContain('MANUAL_BYTES');
          expect(request.body.parts[0].text).toContain('TRUSTED_ROLE'); expect(request.body.parts[0].text).not.toContain('AUTOMATIC_BYTES');
          expect(request.body.model).toEqual({ providerID: 'vendor', modelID: 'model' }); expect(request.body.agent).toBe('plan');
          expect(request.headers.Authorization).toBe('Basic ' + Buffer.from('opencode:owned-password').toString('base64'));
          expect(chunks.map(c => c.type)).toEqual(['text', 'done']);
        }
        expect(h.requests.some(r => r.route === '/session/owned/abort')).toBe(true);
        expect(h.requests.some(r => r.method === 'DELETE')).toBe(true);
      } finally { h.gate.resolve(); await pending; }
    });
  }
  it('keeps static callers and permissions intact', async () => {
    const h = fixture(); await h.send(false);
    const session = h.requests.find(r => r.route === '/session')!;
    expect(session.body.permission[0]).toEqual({ permission: '*', pattern: '*', action: 'deny' });
    const message = h.requests.find(r => r.route.endsWith('/message'))!;
    expect(message.body.parts[0].text).toContain('STATIC_QUESTION'); expect(message.body.parts[0].text).toContain('MANUAL_BYTES');
    expect(message.body.parts[0].text).not.toContain('DYNAMIC_AUTO');
  });
  it('does not cancel an active remote request for an already obsolete input', async () => {
    const h = fixture(); const cancel = vi.spyOn((h.provider as any)._remote, 'cancel'); h.revoke();
    expect(await h.send()).toEqual([]); expect(cancel).not.toHaveBeenCalled(); expect(h.requests).toEqual([]);
  });
});
