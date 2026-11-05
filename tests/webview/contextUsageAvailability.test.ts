import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the shipped responseComplete context branch and its DOM update helper.
// AST selection avoids copying their logic into a test implementation.
const source = ts.createSourceFile('chat.js', readFileSync(join(__dirname, '../../media/chat/chat.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function extract(predicate: (node: ts.Node) => boolean): string {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) { if (predicate(node)) result = node; else ts.forEachChild(node, visit); }
  visit(source); if (!result) throw new Error('Missing shipped context handler');
  return result.getText(source);
}
const branch = extract(node => ts.isIfStatement(node) && node.expression.getText(source) === 'responsePayload.usageUnavailable');
const helper = extract(node => ts.isFunctionDeclaration(node) && node.name?.text === 'setContextUsageUnavailable');

function deliver(payload: object) {
  const state = { contextUsage: { unavailable: false, usedTokens: 288885, percentage: 100 } };
  const elements = new Map<string, any>([
    ['context-pie-fill', { setAttribute: vi.fn() }],
    ['context-usage-text', { textContent: '100%' }],
    ['context-usage', { title: 'old usage', classList: { remove: vi.fn() } }],
  ]);
  const update = vi.fn();
  new Function('responsePayload', 'state', 'document', 'updateContextUsage', `${helper}\n${branch}`)(payload, state, { getElementById: (id: string) => elements.get(id) }, update);
  return { state, elements, update };
}

describe('latest context can be unknown while turn totals remain available', () => {
  it('clears the previous pie without claiming the backend reports no usage', () => {
    const payload = { usage: { input_tokens: 95797, output_tokens: 311 }, contextUsageUnavailable: true };
    const { state, elements, update } = deliver(payload);
    expect(state.contextUsage).toEqual({ unavailable: true, usedTokens: 0, percentage: 0 });
    expect(elements.get('context-usage-text').textContent).toBe('n/a');
    expect(elements.get('context-pie-fill').setAttribute).toHaveBeenCalledWith('d', '');
    expect(elements.get('context-usage').title).toContain('reported turn totals');
    expect(elements.get('context-usage').title).toContain('latest model call');
    expect(payload.usage).toEqual({ input_tokens: 95797, output_tokens: 311 });
    expect(update).not.toHaveBeenCalled();
  });

  it('uses the host latest-call measurement instead of recalculating from totals', () => {
    const { update } = deliver({ usage: { input_tokens: 95797, output_tokens: 311, cache_read_input_tokens: 193088, contextTokens: 96623 } });
    expect(update).toHaveBeenCalledWith(96623, null);
  });

  it('accepts a standalone context measurement without needing footer totals', () => {
    const { update } = deliver({ contextTokens: 96623 });
    expect(update).toHaveBeenCalledWith(96623, null);
  });

  it('does not claim totals were reported when both measurements are absent', () => {
    const { elements } = deliver({ contextUsageUnavailable: true });
    expect(elements.get('context-usage-text').textContent).toBe('n/a');
    expect(elements.get('context-usage').title).toContain('latest model call');
    expect(elements.get('context-usage').title).not.toContain('reported turn totals');
  });

  it('preserves the existing no-usage capability message', () => {
    const { elements } = deliver({ usageUnavailable: true });
    expect(elements.get('context-usage').title).toContain('does not report token usage');
  });
});
