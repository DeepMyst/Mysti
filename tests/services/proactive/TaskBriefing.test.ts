import { describe, expect, it } from 'vitest';
import { taskBriefing } from '../../../src/services/proactive/TaskBriefing';
import type { CloudState } from '../../../src/services/proactive/ProactiveClient';
const now = new Date('2026-10-03T10:00:00Z');
const cloud = (): CloudState => ({ available: true, read_only: false, connections: [], responsibilities: [
  { id: 'r', title: 'Payments', source: 'github', resource: 'org/repo', keywords: ['payment'], state: 'active', revision: 1, health: 'Partial coverage', last_checked_at: now.toISOString(), next_check_at: now.toISOString() },
], insights: ['checkout', 'billing'].map((title, n) => ({ id: String(n), responsibility_id: 'r', title, summary: 'Related terms', state: 'read', created_at: now.toISOString(), evidence: { excerpt: title, url: 'https://github.com/org/repo/pull/1', matched_terms: ['payment'], source: 'github', resource: 'org/repo', version: 'v1' } })) });
describe('task context evidence', () => {
  it('isolates the selected responsibility and ranks locally without changing evidence', () => {
    const state = cloud(); state.insights.push({ ...state.insights[0], id: 'other', responsibility_id: 'other' });
    const original = JSON.stringify(state);
    const result = taskBriefing(state, 'r', 'billing', now);
    expect(result.insights.map(i => i.id)).toEqual(['1', '0']);
    expect(JSON.stringify(state)).toBe(original);
    expect(result.notices.join(' ')).toContain('do not establish task ownership');
    expect(result.notices).toContain('Partial coverage');
  });
  it('labels paused, stale, missing evidence without declaring work unowned', () => {
    const state = cloud(); state.responsibilities[0].state = 'paused'; state.responsibilities[0].last_checked_at = null; state.insights = [];
    const result = taskBriefing(state, 'r', '', now);
    expect(result.notices.join(' ')).toContain('paused');
    expect(result.notices.join(' ')).toContain('stale');
    expect(result.notices.join(' ')).toContain('does not establish that nobody else');
  });
  it('rejects deleted responsibilities and oversized summaries', () => {
    expect(() => taskBriefing(cloud(), 'deleted')).toThrow('current responsibility');
    expect(() => taskBriefing(cloud(), 'r', 'x'.repeat(2001))).toThrow('2,000');
  });
});
