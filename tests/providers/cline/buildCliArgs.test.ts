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

/**
 * Cline 1.x flags. Cline 2.0 renamed all of them, so these assertions only hold
 * when the installed CLI really is 1.x — pinned explicitly here. The 2.x+ shape
 * (and the "version unknown" default) lives in modernCliCompat.test.ts.
 */
function pinLegacyVersion(provider: TestableClineProvider) {
  (provider as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = '1.0.8';
}

describe('ClineProvider.buildCliArgs (Cline 1.x)', () => {
  let provider: TestableClineProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableClineProvider();
    pinLegacyVersion(provider);
  });

  it('should include --output-format json', () => {
    const args = provider.buildCliArgs(defaultSettings(), createClineSession());
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
  });

  it('should use plan mode for read-only', () => {
    const args = provider.buildCliArgs(defaultSettings({ accessLevel: 'read-only' }), createClineSession());
    expect(args).toContain('--mode');
    expect(args).toContain('plan');
  });

  it('should use act + yolo mode for default', () => {
    const args = provider.buildCliArgs(defaultSettings(), createClineSession());
    expect(args).toContain('--mode');
    expect(args).toContain('act');
    expect(args).toContain('--yolo');
  });
});
