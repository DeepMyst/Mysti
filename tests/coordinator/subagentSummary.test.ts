import { describe, it, expect } from 'vitest';
import { extractSubagentSummary, SUMMARY_INSTRUCTIONS, ADVISOR_INSTRUCTIONS } from '../../src/coordinator/subagentSummary';

describe('extractSubagentSummary', () => {
  it('returns only the final report', () => {
    const text = 'I looked around a lot…\n'.repeat(200) + '## Result\nAuth lives in src/auth.ts\n## Evidence\nsrc/auth.ts:12\n## Changes\nnone\n## Open questions\nnone';
    expect(extractSubagentSummary(text)).toBe('## Result\nAuth lives in src/auth.ts\n## Evidence\nsrc/auth.ts:12\n## Changes\nnone\n## Open questions\nnone');
  });
  it('accepts an advisor verdict', () => {
    expect(extractSubagentSummary('thinking\n## Verdict\nShip it\n## Plan\n1\n## Risks\nnone')).toMatch(/^## Verdict/);
  });
  it('clamps a report-less output to the cap', () => {
    const out = extractSubagentSummary('z'.repeat(50_000));
    expect(out.length).toBeLessThan(6_200);
    expect(out).toContain('clamped');
  });
  it('tells children the exact headings', () => {
    for (const h of ['## Result', '## Evidence', '## Changes', '## Open questions']) { expect(SUMMARY_INSTRUCTIONS).toContain(h); }
    for (const h of ['## Verdict', '## Plan', '## Risks']) { expect(ADVISOR_INSTRUCTIONS).toContain(h); }
  });
});
