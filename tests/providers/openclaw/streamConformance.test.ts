/**
 * OpenClaw NDJSON stream-conformance fixture (Plan 02 Phase 3).
 * Covers the conformance fix: parser-level done removed (done/complete/end
 * events are swallowed; _sendViaCli/_sendViaGateway emit the single done).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('OpenClawProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableOpenClawProvider;
  let session: ReturnType<typeof createOpenClawSession>;

  const FIXTURE = [
    { type: 'text', content: 'Editing the config, then verifying.' },
    // Tool 1: edit (gateway-style lowercase name)
    { type: 'tool_call', id: 'owtool_01', name: 'edit', input: { path: '/src/config.ts' }, status: 'started' },
    { type: 'tool_call', id: 'owtool_01', name: 'edit', status: 'completed', output: 'edited' },
    // Tool 2: bash
    { type: 'tool_call', id: 'owtool_02', name: 'bash', input: { command: 'npm run lint' }, status: 'started' },
    { type: 'tool_call', id: 'owtool_02', name: 'bash', status: 'completed', output: 'clean' },
    // Usage + terminal events — parser must yield NOTHING for done/complete/end
    { type: 'usage', input_tokens: 350, output_tokens: 80 },
    { type: 'done' },
    { type: 'complete' },
    { type: 'end' },
  ];

  beforeEach(() => {
    provider = new TestableOpenClawProvider();
    session = createOpenClawSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('stamps semantic kinds for gateway-style lowercase names', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expect(toolUsesById(chunks, 'owtool_01').every((c) => c.toolCall?.kind === 'edit')).toBe(true);
    expect(toolUsesById(chunks, 'owtool_01').length).toBeGreaterThan(0);
    expect(toolUsesById(chunks, 'owtool_02').every((c) => c.toolCall?.kind === 'execute')).toBe(true);
    expect(toolUsesById(chunks, 'owtool_02').length).toBeGreaterThan(0);
  });

  it('emits zero parser-level done chunks for done/complete/end events', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);
  });
});
