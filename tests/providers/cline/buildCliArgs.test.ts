import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'cline', ...overrides,
  };
}

describe('Cline native ACP launch arguments', () => {
  beforeEach(() => clearMockConfig());
  it.each(['1.0.8', '3.0.61', null])('never falls back to auto-approved legacy execution for %s', version => {
    const provider = new TestableClineProvider();
    (provider as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = version;
    expect(provider.buildCliArgs(defaultSettings(), createClineSession())).toEqual(['--acp', '--auto-approve', 'false']);
  });
});
