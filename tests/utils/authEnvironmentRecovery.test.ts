import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnrichedEnv, resetPlatformCache } from '../../src/utils/platform';

beforeEach(() => resetPlatformCache());
afterEach(() => { vi.unstubAllEnvs(); resetPlatformCache(); });

describe('PC-03 spawn environment follows credential changes', () => {
  it('uses a replacement key after initial discovery or spawn warmed the PATH cache', () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-expired-key');
    const initial = getEnrichedEnv();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-replacement-key');
    expect(getEnrichedEnv().OPENAI_API_KEY).toBe('synthetic-replacement-key');
    expect(initial.OPENAI_API_KEY).toBe('synthetic-expired-key');
  });

  it('does not resurrect a removed key from the cached spawn environment', () => {
    vi.stubEnv('GEMINI_API_KEY', 'synthetic-removed-key'); getEnrichedEnv();
    vi.stubEnv('GEMINI_API_KEY', undefined);
    expect(getEnrichedEnv().GEMINI_API_KEY).toBeUndefined();
  });

  it('keeps per-spawn overrides local while newly added credentials reach the next spawn', () => {
    vi.stubEnv('MOONSHOT_API_KEY', undefined); getEnrichedEnv();
    vi.stubEnv('MOONSHOT_API_KEY', 'synthetic-added-key');
    expect(getEnrichedEnv({ MOONSHOT_API_KEY: 'synthetic-override-key' }).MOONSHOT_API_KEY).toBe('synthetic-override-key');
    expect(getEnrichedEnv().MOONSHOT_API_KEY).toBe('synthetic-added-key');
  });
});
