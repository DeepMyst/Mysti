import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ContextManager } from '../../src/managers/ContextManager';
import { TestableGeminiProvider } from '../helpers/providerFactory';
import { contextRangeCases, contextRangeItem } from '../helpers/contextRangeCases';
import type { ContextItem } from '../../src/types';

function manager() {
  const saved = new Map<string, unknown>();
  const context = { workspaceState: {
    keys: () => [...saved.keys()], get: (key: string) => saved.get(key),
    update: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
  } } as unknown as vscode.ExtensionContext;
  return { value: new ContextManager(context), context, saved };
}

describe('human-facing context range labels', () => {
  for (const [index, testCase] of contextRangeCases.entries()) {
    it(`${testCase.name}: prompt renderers agree without rewriting selected bytes or coordinates`, async () => {
      const { value } = manager();
      const item = contextRangeItem(testCase, index);
      const captured = await (value.addSelectionToContext as (...args: unknown[]) => Promise<ContextItem>)(
        item.path, item.content, item.startLine, item.endLine, item.language, 'sidebar',
        'endCharacter' in testCase ? testCase.endCharacter : undefined,
      );
      const expected = `## Selection from ${item.path}${testCase.label ? ` (lines ${testCase.label})` : ''}\n`;
      const provider = new TestableGeminiProvider();
      try {
        for (const rendered of [value.formatContextForPrompt('sidebar'), (provider as any).formatContext([item]) as string]) {
          expect(rendered).toContain(expected);
          expect(rendered).toContain(`\`\`\`typescript\n${item.content}\n\`\`\``);
        }
        expect({ ...captured, id: item.id }).toEqual(item);
      } finally { provider.dispose(); }
    });
  }

  it('persists and restores the raw exclusive endpoint and exact selection snapshot', async () => {
    const { value, context, saved } = manager();
    const item = await (value.addSelectionToContext as any)('/workspace/one.ts', 'one\r\n', 0, 1, 'typescript', 'sidebar', 0);
    expect(saved.get('mysti.context:sidebar')).toEqual([expect.objectContaining({ startLine: 0, endLine: 1, endCharacter: 0, content: 'one\r\n' })]);
    const restored = new ContextManager(context);
    expect(await restored.restorePanelContext('sidebar')).toEqual([item]);
    expect(restored.formatContextForPrompt('sidebar')).toContain('(lines 1-1)');
  });

  it('keeps ordinary files unchanged and disabled selections excluded', async () => {
    const { value } = manager();
    const item = await value.addSelectionToContext('/workspace/hidden.ts', 'private', 0, 0, 'typescript', 'sidebar');
    value.setItemEnabled(item.id, false, 'sidebar');
    expect(value.formatContextForPrompt('sidebar')).toBe('');
    const provider = new TestableGeminiProvider();
    try {
      const rendered = (provider as any).formatContext([{ ...item, enabled: false }, { id: 'file', type: 'file', path: '/workspace/file.ts', content: 'file bytes' }]);
      expect(rendered).toContain('## /workspace/file.ts\n```\nfile bytes\n```');
      expect(rendered).toContain('UNTRUSTED DATA');
      expect(rendered).not.toContain('private');
    } finally { provider.dispose(); }
  });
});
