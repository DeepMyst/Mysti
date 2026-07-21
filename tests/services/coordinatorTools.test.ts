/**
 * Native tool-calling foundation (Plan 19 Phase 4) — the tool schemas, the
 * conservative capability check, and the tool_call→MystiDirective converter that
 * lets a native tool_call reuse the coordinator's existing (gated) dispatch.
 */
import { describe, it, expect } from 'vitest';
import { coordinatorToolSchemas, modelSupportsToolCalls, toolCallToDirective } from '../../src/services/coordinatorTools';

describe('coordinatorToolSchemas', () => {
  it('offers read-only tools always; exec tools only when enabled', () => {
    const ro = coordinatorToolSchemas(false).map(t => t.function.name);
    expect(ro).toEqual(['read', 'ls', 'grep', 'diag', 'remember', 'delegate']);
    const full = coordinatorToolSchemas(true).map(t => t.function.name);
    expect(full).toContain('write');
    expect(full).toContain('bash');
    expect(full).toContain('patch');
    // Every schema is a well-formed function tool.
    for (const t of coordinatorToolSchemas(true)) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(t.function.parameters).toHaveProperty('type', 'object');
    }
  });
  it('offers connect only when enabled, and exposes MCP tools as mcp__ functions (Phase 6)', () => {
    const none = coordinatorToolSchemas(false).map(t => t.function.name);
    expect(none).not.toContain('connect');
    const withConnect = coordinatorToolSchemas(false, [], true).map(t => t.function.name);
    expect(withConnect).toContain('connect');
    const withMcp = coordinatorToolSchemas(false, [{ name: 'GMAIL_SEND', description: 'Send mail' }, { name: 'TRELLO_CREATE' }], true).map(t => t.function.name);
    expect(withMcp).toContain('mcp__GMAIL_SEND');
    expect(withMcp).toContain('mcp__TRELLO_CREATE');
    expect(withMcp).toContain('connect');
  });
});

describe('modelSupportsToolCalls', () => {
  it('is true for known-capable models, false for unknown (→ text fallback)', () => {
    for (const m of ['openrouter/openai/gpt-oss-120b:free', 'claude-haiku-4-5', 'google/gemma-4-31b-it', 'nvidia/nemotron-3', 'qwen3-coder', 'claude-sonnet-4-6']) {
      expect(modelSupportsToolCalls(m), m).toBe(true);
    }
    expect(modelSupportsToolCalls('some/unknown-tiny-model')).toBe(false);
    expect(modelSupportsToolCalls(undefined)).toBe(false);
    expect(modelSupportsToolCalls('')).toBe(false);
  });
});

describe('toolCallToDirective', () => {
  it('maps read/ls/grep/diag/remember/delegate', () => {
    expect(toolCallToDirective('read', { path: 'a.ts', start_line: 10, end_line: 20 })).toEqual({ kind: 'read', path: 'a.ts', startLine: 10, endLine: 20 });
    expect(toolCallToDirective('ls', {})).toEqual({ kind: 'ls', path: '.' });
    expect(toolCallToDirective('grep', { pattern: 'foo', include: 'src/**' })).toEqual({ kind: 'grep', pattern: 'foo', include: 'src/**' });
    expect(toolCallToDirective('diag', {})).toEqual({ kind: 'diag', target: 'all' });
    expect(toolCallToDirective('remember', { fact: 'x' })).toEqual({ kind: 'remember', fact: 'x' });
    expect(toolCallToDirective('delegate', { agent: 'claude-code', task: 't', tier: 'strong' })).toEqual({ kind: 'delegate', agent: 'claude-code', task: 't', tier: 'strong' });
    expect(toolCallToDirective('delegate', { agent: 'x', task: 't', tier: 'weird' })).toEqual({ kind: 'delegate', agent: 'x', task: 't' });
  });
  it('maps write/edit/patch/bash', () => {
    expect(toolCallToDirective('write', { path: 'a.ts', content: 'x' })).toEqual({ kind: 'write', path: 'a.ts', content: 'x' });
    expect(toolCallToDirective('edit', { path: 'a.ts', old_string: 'o', new_string: 'n', replace_all: true })).toEqual({ kind: 'edit', path: 'a.ts', oldString: 'o', newString: 'n', replaceAll: true });
    expect(toolCallToDirective('patch', { patch: '*** Delete: a.ts' })).toEqual({ kind: 'patch', patchText: '*** Delete: a.ts' });
    expect(toolCallToDirective('bash', { command: 'npm test' })).toEqual({ kind: 'bash', command: 'npm test' });
  });
  it('maps connect + namespaced mcp__ tools (Phase 6)', () => {
    expect(toolCallToDirective('connect', { service: 'Gmail' })).toEqual({ kind: 'connect', service: 'gmail' });
    expect(toolCallToDirective('connect', { service: '../evil' })).toMatchObject({ error: expect.stringContaining('service') });
    expect(toolCallToDirective('mcp__GMAIL_SEND', { to: 'a@b.com' })).toEqual({ kind: 'mcptool', tool: 'GMAIL_SEND', args: { to: 'a@b.com' } });
    expect(toolCallToDirective('mcp__T', {})).toEqual({ kind: 'mcptool', tool: 'T', args: {} });
  });
  it('returns an error for unknown tools and missing required args', () => {
    expect(toolCallToDirective('nope', {})).toMatchObject({ error: expect.stringContaining('Unknown tool') });
    expect(toolCallToDirective('read', {})).toMatchObject({ error: expect.stringContaining('path') });
    expect(toolCallToDirective('write', { path: 'a.ts' })).toMatchObject({ error: expect.any(String) });
    expect(toolCallToDirective('edit', { path: 'a.ts', new_string: 'n' })).toMatchObject({ error: expect.stringContaining('old_string') });
    expect(toolCallToDirective('bash', { command: '  ' })).toMatchObject({ error: expect.stringContaining('command') });
  });
});
