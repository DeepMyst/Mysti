/**
 * OpenCode NDJSON stream-conformance fixture (Plan 02 Phase 3).
 * Lowercase native names (bash/write) normalize at emission, kinds stamped,
 * tools resolve via message.part.updated state transitions, parser never
 * emits done (step_finish only stores usage).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenCodeProvider } from '../../helpers/providerFactory';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('OpenCodeProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableOpenCodeProvider;
  let session: ReturnType<typeof createOpenCodeSession>;

  const FIXTURE = [
    { type: 'step_start', sessionID: 'oc_sess_01' },
    { type: 'message.part.updated', part: { type: 'text', text: 'Writing the helper then running it.' } },
    // Tool 1: write
    { type: 'message.part.updated', part: { type: 'tool', id: 'octool_01', name: 'write', state: 'running', input: { filePath: '/src/helper.ts', content: 'x' } } },
    { type: 'message.part.updated', part: { type: 'tool', id: 'octool_01', name: 'write', state: 'completed', output: 'written' } },
    // Tool 2: bash
    { type: 'message.part.updated', part: { type: 'tool', id: 'octool_02', name: 'bash', state: 'running', input: { command: 'node /src/helper.ts' } } },
    { type: 'message.part.updated', part: { type: 'tool', id: 'octool_02', name: 'bash', state: 'completed', output: 'done' } },
    { type: 'step_finish', part: { tokens: { input: 600, output: 150 } } },
  ];

  beforeEach(() => {
    provider = new TestableOpenCodeProvider();
    session = createOpenCodeSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('normalizes native names and stamps kinds', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    const writeUses = toolUsesById(chunks, 'octool_01');
    const bashUses = toolUsesById(chunks, 'octool_02');
    expect(writeUses.length).toBeGreaterThan(0);
    expect(bashUses.length).toBeGreaterThan(0);
    expect(writeUses.every((c) => c.toolCall?.name === 'Write' && c.toolCall?.kind === 'edit')).toBe(true);
    expect(bashUses.every((c) => c.toolCall?.name === 'Bash' && c.toolCall?.kind === 'execute')).toBe(true);
  });
});
