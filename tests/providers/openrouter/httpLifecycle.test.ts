import { createServer, type ServerResponse } from 'node:http';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenRouterClient } from '../../../src/services/OpenRouterClient';
import { TestableOpenRouterProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const collect = async <T>(stream: AsyncIterable<T>) => { const result: T[] = []; for await (const event of stream) { result.push(event); } return result; };
async function fixture(run: (client: OpenRouterClient, replies: { response: ServerResponse; closed: ReturnType<typeof deferred> }[]) => Promise<void>) {
  const replies: { response: ServerResponse; closed: ReturnType<typeof deferred> }[] = [];
  const server = createServer((request, response) => {
    request.resume();
    const closed = deferred(); replies.push({ response, closed });
    response.on('close', closed.resolve);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') { throw new Error('Missing fixture address'); }
  const client = new OpenRouterClient(() => 'inert-loopback-key', {
    // Preserve fetch/AbortSignal/body behavior; only destination is the private fixture.
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}/inert`, init),
  });
  try { await run(client, replies); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const params = { model: 'inert/model', messages: [] };
afterEach(() => clearMockConfig());

describe('OpenRouter real loopback HTTP lifecycle', () => {
  it.each(['Stop', 'timeout', 'return'] as const)('%s closes the owned streaming connection and releases listeners', async action => {
    await fixture(async (client, replies) => {
      const owner = new AbortController();
      const stream = client.streamChat({ ...params, signal: owner.signal, timeoutMs: action === 'timeout' ? 1000 : 5000 });
      expect((await stream.next()).value).toEqual({ text: 'first' });
      if (action === 'return') { await stream.return(undefined); }
      else {
        const remaining = collect(stream);
        if (action === 'Stop') { owner.abort(new Error('owned Stop')); }
        const events = await remaining;
        expect(events.some(event => event.done || event.toolCalls || event.text)).toBe(false);
        expect(events.at(-1)?.error).toMatch(action === 'Stop' ? /owned Stop/ : /timeout/i);
      }
      await replies[0].closed.promise;
      expect(replies[0].response.destroyed).toBe(true);
      expect(getEventListeners(owner.signal, 'abort')).toEqual([]);
    });
  });

  it('replacement and old finally close only their own HTTP connection while sibling completes', async () => {
    await fixture(async (client, replies) => {
      setMockConfig('openrouter.apiKey', 'inert-loopback-key');
      const provider = new TestableOpenRouterProvider(); provider.setClient(client);
      const settings: Settings = { provider: 'openrouter', model: 'inert/model', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' };
      const send = (panel: string) => provider.sendMessage('fixture', [], settings, null, undefined, panel);
      const old = send('panel'); const sibling = send('sibling');
      try {
        await old.next(); await sibling.next();
        const replacement = send('panel'); await replacement.next();
        await replies[0].closed.promise;
        await old.return(undefined);
        expect(replies[1].response.destroyed).toBe(false); expect(replies[2].response.destroyed).toBe(false);
        provider.clearSession('panel');
        expect(await collect(replacement)).toEqual([]); await replies[2].closed.promise;
        expect(replies[1].response.destroyed).toBe(false);
        replies[1].response.end('data: {"choices":[{"delta":{"content":"sibling finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        expect(await collect(sibling)).toEqual([{ type: 'text', content: 'sibling finished' }, { type: 'done' }]);
      } finally { provider.dispose(); await old.return(undefined); await sibling.return(undefined); }
    });
  });
});
