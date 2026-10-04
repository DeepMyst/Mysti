import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProactiveClient } from '../../../src/services/proactive/ProactiveClient';
afterEach(() => vi.unstubAllGlobals());
describe('proactive cloud transport', () => {
  it.each(['http://api.deepmyst.com', 'https://deepmyst.com.evil.test', 'https://user:pass@api.deepmyst.com', 'file:///tmp/key'])('never sends credentials to %s', async base => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(new ProactiveClient(base, 'secret').request()).rejects.toThrow('trusted HTTPS');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 500])('reports status %s without exposing response contents', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive upstream details', { status })));
    await expect(new ProactiveClient('https://api.v2.deepmyst.com', 'key').request()).rejects.not.toThrow('sensitive');
  });
  it('uses a bounded non-redirecting request and handles 204', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher);
    await new ProactiveClient('http://localhost:8100', 'key').request('/responsibilities/id', 'DELETE');
    expect(fetcher).toHaveBeenCalledWith(new URL('http://localhost:8100/api/v1/me/proactive/responsibilities/id'), expect.objectContaining({ method: 'DELETE', redirect: 'error', signal: expect.any(AbortSignal) }));
  });
});
