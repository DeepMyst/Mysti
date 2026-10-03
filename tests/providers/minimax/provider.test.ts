import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { MiniMaxProvider } from '../../../src/providers/minimax/MiniMaxProvider';
import { clearMockConfig, setMockConfig, createMockSecretStorage, window } from '../../helpers/mockVscode';
import { createMockSettings as createSettings } from '../../helpers/brainstormFactory';
import type { StreamChunk } from '../../../src/types';

class Provider extends MiniMaxProvider {
  protected async buildPromptAsync(content: string): Promise<string> { return content; }
}
const collect = async (stream: AsyncGenerator<StreamChunk>) => { const out: StreamChunk[] = []; for await (const chunk of stream) out.push(chunk); return out; };
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const answer = frame({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }) + 'data:[DONE]\n';
let provider: Provider, secrets: ReturnType<typeof createMockSecretStorage>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearMockConfig(); vi.stubEnv('MINIMAX_API_KEY', ''); secrets = createMockSecretStorage();
  provider = new Provider({ subscriptions: [], secrets } as unknown as vscode.ExtensionContext);
  fetchMock = vi.fn(async () => new Response(answer)); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { provider.dispose(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const settings = () => createSettings({ provider: 'minimax', model: 'MiniMax-M2.7' });
const send = (panel = 'a') => provider.sendMessage('hello', [], settings(), null, undefined, panel);

describe('MiniMax API provider', () => {
  it('is available without a CLI, but reports absent credentials separately', async () => {
    expect((await provider.discoverCli()).found).toBe(true);
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
    expect((await collect(send()))[0].type).toBe('auth_error'); expect(fetchMock).not.toHaveBeenCalled();
    expect(provider.getInstallMethods()).toEqual([]); expect(provider.getSlashCommands()).toEqual([]);
  });
  it('stores setup credentials in the host secret store', async () => {
    vi.spyOn(window, 'showInputBox').mockResolvedValue(' new-key ');
    expect((await provider.configureAuthentication()).authenticated).toBe(true);
    expect(await secrets.get('mysti.minimax.apiKey')).toBe('new-key');
  });
  it('honors the selected and routed models and rejects redirect credential forwarding', async () => {
    await secrets.store('mysti.minimax.apiKey', 'key');
    await collect(provider.sendMessage('hello', [], { ...settings(), model: 'MiniMax-M2.7-highspeed' }, null));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('MiniMax-M2.7-highspeed');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    setMockConfig('minimaxModel', 'MiniMax-M2.7');
    await collect(provider.sendMessage('hello', [], { ...settings(), routedModel: 'MiniMax-M2.7-highspeed' }, null));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('MiniMax-M2.7-highspeed');
  });
  it('streams split UTF-8, reasoning and usage-only final frames', async () => {
    await secrets.store('mysti.minimax.apiKey', 'key');
    const bytes = new TextEncoder().encode(frame({ choices: [{ delta: { reasoning_content: 'reason' } }] }) + frame({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] }) + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 31, completion_tokens: 9 } }));
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } })));
    const out = await collect(send());
    expect(out.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('你好');
    expect(out.find(c => c.type === 'thinking')?.content).toBe('reason');
    expect(out.filter(c => c.type === 'done')).toEqual([{ type: 'done', usage: { input_tokens: 31, output_tokens: 9 }, contextWindow: 204800 }]);
  });
  it.each([401, 403, 429, 500])('surfaces HTTP %i without claiming successful completion', async status => {
    await secrets.store('mysti.minimax.apiKey', 'key'); fetchMock.mockResolvedValue(new Response('error', { status }));
    const out = await collect(send()); expect(out.some(c => c.type === 'done')).toBe(false);
    expect(out[0].type).toBe(status === 401 || status === 403 ? 'auth_error' : 'error');
  });
  it('rejects an unrelated endpoint before sending credentials', async () => {
    await secrets.store('mysti.minimax.apiKey', 'key'); setMockConfig('minimaxBaseUrl', 'https://evil.test/v1');
    expect((await collect(send()))[0].type).toBe('error'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects malformed or prematurely closed streams', async () => {
    await secrets.store('mysti.minimax.apiKey', 'key');
    for (const data of ['data: {bad}\n', frame({ choices: [{ delta: { content: 'partial' } }] })]) {
      fetchMock.mockResolvedValue(new Response(data));
      const out = await collect(send()); expect(out.at(-1)?.type).toBe('error'); expect(out.some(c => c.type === 'done')).toBe(false);
    }
  });
  it('aborts abandoned streams and isolates panel cancellation', async () => {
    await secrets.store('mysti.minimax.apiKey', 'key');
    const a = send('a'), b = send('b'); await a.next(); await b.next();
    const aSignal = fetchMock.mock.calls[0][1].signal, bSignal = fetchMock.mock.calls[1][1].signal;
    provider.cancelCurrentRequest('a'); expect(aSignal.aborted).toBe(true); expect(bSignal.aborted).toBe(false);
    await a.return(undefined); await b.return(undefined); expect(bSignal.aborted).toBe(true);
  });
  it('an old turn cannot clear or cancel the replacement turn controller', async () => {
    await secrets.store('mysti.minimax.apiKey', 'key');
    const old = send(), next = send(); await old.next(); await next.next();
    const signal = fetchMock.mock.calls[1][1].signal;
    await old.return(undefined); expect(signal.aborted).toBe(false);
    provider.cancelCurrentRequest('a'); expect(signal.aborted).toBe(true); await next.return(undefined);
  });
});
