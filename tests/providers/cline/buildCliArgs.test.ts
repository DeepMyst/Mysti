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

describe('ClineProvider.buildCliArgs', () => {
  let provider: TestableClineProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableClineProvider();
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
