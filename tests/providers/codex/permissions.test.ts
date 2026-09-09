import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { createCodexSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'openai-codex', ...overrides,
  };
}

describe('Codex permission flag mapping', () => {
  let provider: TestableCodexProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCodexProvider();
  });

  // Plan modes → --sandbox read-only
  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should use --sandbox read-only for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createCodexSession());
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('should use --sandbox read-only for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createCodexSession());
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
  });

  it('should use --dangerously-bypass-approvals-and-sandbox for edit-automatically + full-access', () => {
    const args = provider.buildCliArgs(s({ mode: 'edit-automatically', accessLevel: 'full-access' }), createCodexSession());
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('--sandbox');
  });

  it('uses workspace-write for default + full-access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'full-access' }), createCodexSession());
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'workspace-write']);
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('uses workspace-write for default + ask-permission', () => {
    const args = provider.buildCliArgs(s(), createCodexSession());
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'workspace-write']);
    expect(args).not.toContain('--full-auto');
  });

  it('uses workspace-write for ask-before-edit + ask-permission', () => {
    const args = provider.buildCliArgs(s({ mode: 'ask-before-edit' }), createCodexSession());
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'workspace-write']);
    expect(args).not.toContain('--full-auto');
  });
});
