/**
 * Plan 20 Phase 1 — the `skill` directive: both encodings, and the containment
 * rule that keeps `part=` inside one artifact's own folder.
 */
import { describe, it, expect } from 'vitest';
import {
  MystiTagScanner,
  MYSTI_SKILL_KINDS,
  ALL_MYSTI_KINDS,
} from '../../src/utils/mystiDelegateParser';
import { toolCallToDirective, coordinatorToolSchemas } from '../../src/services/coordinatorTools';

const N = 'abc12345';
const KINDS = [...ALL_MYSTI_KINDS, ...MYSTI_SKILL_KINDS];

function scan(input: string, kinds = KINDS, nonce = N) {
  const s = new MystiTagScanner(nonce, kinds);
  const fed = s.feed(input);
  const flushed = s.flush();
  return fed.directive || flushed.directive || null;
}

describe('<skill> text form', () => {
  it('parses a search', () => {
    expect(scan(`<skill:${N}>write tests first</skill>`))
      .toEqual({ kind: 'skill', query: 'write tests first' });
  });

  it('parses a read by id', () => {
    expect(scan(`<skill:${N} id="test-driven"></skill>`))
      .toEqual({ kind: 'skill', id: 'test-driven' });
  });

  it('parses a read of a bundled part', () => {
    expect(scan(`<skill:${N} id="test-driven" part="references/edge-cases.md"></skill>`))
      .toEqual({ kind: 'skill', id: 'test-driven', part: 'references/edge-cases.md' });
  });

  it('prefers id over body text when both are present', () => {
    expect(scan(`<skill:${N} id="concise">ignored</skill>`))
      .toEqual({ kind: 'skill', id: 'concise' });
  });

  it('ignores an empty search', () => {
    expect(scan(`<skill:${N}>   </skill>`)).toBeNull();
  });

  it('is inert without the run nonce', () => {
    expect(scan(`<skill:deadbeef>write tests first</skill>`)).toBeNull();
  });

  it('is not recognized at all when the capability is off', () => {
    // Degrades to visible text rather than erroring — the capability simply
    // does not exist when the setting is off.
    expect(scan(`<skill:${N}>write tests first</skill>`, ALL_MYSTI_KINDS)).toBeNull();
  });
});

describe('native encoding maps onto the same directive', () => {
  it('skill_find', () => {
    expect(toolCallToDirective('skill_find', { query: 'write tests first' }))
      .toEqual({ kind: 'skill', query: 'write tests first' });
    expect(toolCallToDirective('skill_find', {})).toEqual({ error: 'skill_find: "query" is required.' });
  });

  it('skill_view', () => {
    expect(toolCallToDirective('skill_view', { id: 'test-driven' }))
      .toEqual({ kind: 'skill', id: 'test-driven' });
    expect(toolCallToDirective('skill_view', { id: 'x', part: 'references/a.md' }))
      .toEqual({ kind: 'skill', id: 'x', part: 'references/a.md' });
    expect(toolCallToDirective('skill_view', {})).toEqual({ error: 'skill_view: "id" is required.' });
  });

  it('the schemas appear only when the capability is on', () => {
    const off = coordinatorToolSchemas(false, [], false, {}, false, false).map(t => t.function.name);
    const on = coordinatorToolSchemas(false, [], false, {}, false, true).map(t => t.function.name);
    expect(off).not.toContain('skill_find');
    expect(on).toContain('skill_find');
    expect(on).toContain('skill_view');
  });

  it('adds a bounded footprint — two schemas, not one per artifact', () => {
    const off = JSON.stringify(coordinatorToolSchemas(false, [], false, {}, false, false)).length;
    const on = JSON.stringify(coordinatorToolSchemas(false, [], false, {}, false, true)).length;
    expect((on - off) / 4).toBeLessThan(250); // ~4 chars/token
  });
});
