/**
 * Cline NDJSON stream-conformance fixture (Plan 02 Phase 3).
 * Cline forwards its own pre-shaped toolCall events; kinds are stamped from
 * the (heuristically bucketed) native names, the parser stores usage from the
 * CLI's done event but never emits a parser-level done.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('ClineProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableClineProvider;
  let session: ReturnType<typeof createClineSession>;

  const FIXTURE = [
    { type: 'text', content: 'Creating the file, then running the command.' },
    // Tool 1: write_to_file (Cline-native name)
    { type: 'tool_use', toolCall: { id: 'cltool_01', name: 'write_to_file', input: { path: '/src/new.ts', content: 'x' }, status: 'running' } },
    { type: 'tool_result', toolCall: { id: 'cltool_01', name: 'write_to_file', output: 'ok', status: 'completed' } },
    // Tool 2: execute_command
    { type: 'tool_use', toolCall: { id: 'cltool_02', name: 'execute_command', input: { command: 'npm test' }, status: 'running' } },
    { type: 'tool_result', toolCall: { id: 'cltool_02', name: 'execute_command', output: 'passed', status: 'completed' } },
    // CLI terminal event — parser stores usage, yields nothing
    { type: 'done', usage: { input_tokens: 400, output_tokens: 90 } },
  ];

  beforeEach(() => {
    provider = new TestableClineProvider();
    session = createClineSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('stamps semantic kinds for Cline-native names', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expect(toolUsesById(chunks, 'cltool_01').every((c) => c.toolCall?.kind === 'edit')).toBe(true);
    expect(toolUsesById(chunks, 'cltool_01').length).toBeGreaterThan(0);
    expect(toolUsesById(chunks, 'cltool_02').every((c) => c.toolCall?.kind === 'execute')).toBe(true);
    expect(toolUsesById(chunks, 'cltool_02').length).toBeGreaterThan(0);
  });

  it('stores usage from the CLI done event without emitting done', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);
    expect(session.lastUsageStats).toEqual({
      input_tokens: 400,
      output_tokens: 90,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    });
  });
});
