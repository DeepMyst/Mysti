/**
 * Plan 18 4.7a — GeminiProvider.discoverModels used to put the API key in the
 * URL query string (`?key=...`), leaking it into logs/proxies/history. The key
 * must travel in the `x-goog-api-key` header instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestableGeminiProvider } from '../../helpers/providerFactory';

describe('GeminiProvider.discoverModels (Plan 18 4.7a)', () => {
  let provider: TestableGeminiProvider;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    provider = new TestableGeminiProvider();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: 'models/gemini-2.5-pro',
            displayName: 'Gemini 2.5 Pro',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/embedding-001',
            displayName: 'Embedding 001',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('sends the API key in the x-goog-api-key header, never in the URL', async () => {
    process.env.GEMINI_API_KEY = 'secret-key-123';
    const models = await provider.discoverModels(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).not.toContain('key=');
    expect(String(url)).not.toContain('secret-key-123');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key-123');

    // Still parses the catalog: generateContent-only, "models/" prefix stripped.
    expect(models).toEqual([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576 },
    ]);
  });

  it('honors GOOGLE_API_KEY as the fallback key source', async () => {
    process.env.GOOGLE_API_KEY = 'google-key-456';
    await provider.discoverModels(1000);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).not.toContain('google-key-456');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('google-key-456');
  });

  it('returns null without any API key (no fetch attempted)', async () => {
    expect(await provider.discoverModels(1000)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a non-ok response', async () => {
    process.env.GEMINI_API_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: false });
    expect(await provider.discoverModels(1000)).toBeNull();
  });

  it('returns null on fetch failure (never throws)', async () => {
    process.env.GEMINI_API_KEY = 'k';
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await provider.discoverModels(1000)).toBeNull();
  });
});
