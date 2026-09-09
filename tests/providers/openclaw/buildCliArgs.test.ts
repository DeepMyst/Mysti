import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';

describe('OpenClaw raw agent bypass prevention', () => {
  let provider: TestableOpenClawProvider;
  beforeEach(() => { provider = new TestableOpenClawProvider(); });
  afterEach(() => provider.dispose());
  it.each(['none', 'low', 'medium', 'high'] as const)('rejects raw agent arguments at thinking level %s', thinkingLevel => {
    const settings: Settings = { provider: 'openclaw', mode: 'default', accessLevel: 'full-access',
      thinkingLevel, contextMode: 'auto', model: '' };
    expect(() => provider.buildCliArgs(settings, createOpenClawSession())).toThrow('Unguarded CLI fallback is disabled');
  });
});
