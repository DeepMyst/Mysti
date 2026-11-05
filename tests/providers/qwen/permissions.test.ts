import { describe, it, expect, beforeEach } from 'vitest';
import { TestableQwenProvider } from '../../helpers/providerFactory';
import { createQwenSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'qwen-code', ...overrides,
  };
}

describe('Qwen permission flag mapping', () => {
  let provider: TestableQwenProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableQwenProvider();
  });

  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('rejects unsupported %s mode before constructing CLI arguments', (mode) => {
    expect(() => provider.buildCliArgs(s({ mode }), createQwenSession())).toThrow(/Qwen Code CLI cannot enforce Plan, Read Only/);
  });

  it('rejects unsupported read-only access before constructing CLI arguments', () => {
    expect(() => provider.buildCliArgs(s({ accessLevel: 'read-only' }), createQwenSession())).toThrow(/Qwen Code CLI cannot enforce Plan, Read Only/);
  });

  it('should use --approval-mode yolo for edit-automatically + full-access', () => {
    const args = provider.buildCliArgs(s({ mode: 'edit-automatically', accessLevel: 'full-access' }), createQwenSession());
    expect(args).toContain('--approval-mode');
    expect(args).toContain('yolo');
  });

  it.each([
    { mode: 'default' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
  ])('honors or explicitly rejects mode=$mode access=$accessLevel', ({ mode, accessLevel }) => {
    if (accessLevel !== 'full-access') {
      expect(() => provider.buildCliArgs(s({ mode, accessLevel }), createQwenSession())).toThrow(/native approvals/);
      return;
    }
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createQwenSession());
    expect(args).toContain('--approval-mode');
    expect(args).toContain('yolo');
  });
});
