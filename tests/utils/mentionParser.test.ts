/**
 * Tests for the canonical @-mention role grammar (Plan 14).
 */
import { describe, it, expect } from 'vitest';
import { parseAgentRoleMentions } from '../../src/utils/mentionParser';

describe('parseAgentRoleMentions', () => {
  it('parses a plain agent mention with no role', () => {
    const [m] = parseAgentRoleMentions('hey @gemini look at this');
    expect(m.name).toBe('gemini');
    expect(m.role).toBeUndefined();
    expect(m.raw).toBe('@gemini');
  });

  it('parses an agent:role mention', () => {
    const [m] = parseAgentRoleMentions('@google-gemini:critic here is my plan');
    expect(m.name).toBe('google-gemini');
    expect(m.role).toBe('critic');
    expect(m.raw).toBe('@google-gemini:critic');
    expect(m.startIndex).toBe(0);
    expect(m.endIndex).toBe('@google-gemini:critic'.length);
  });

  it('parses multiple role mentions in one message', () => {
    const parsed = parseAgentRoleMentions('@gemini:critic @codex:reviewer weigh in');
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toMatchObject({ name: 'gemini', role: 'critic' });
    expect(parsed[1]).toMatchObject({ name: 'codex', role: 'reviewer' });
  });

  it('lowercases name and role', () => {
    const [m] = parseAgentRoleMentions('@Gemini:Critic');
    expect(m.name).toBe('gemini');
    expect(m.role).toBe('critic');
  });

  it('treats a trailing colon with no role as no role', () => {
    const [m] = parseAgentRoleMentions('@gemini: what do you think');
    expect(m.name).toBe('gemini');
    expect(m.role).toBeUndefined();
  });

  it('leaves file-path mentions without a role', () => {
    const [m] = parseAgentRoleMentions('check @src/auth.ts please');
    expect(m.name).toBe('src/auth.ts');
    expect(m.role).toBeUndefined();
  });

  it('handles hyphenated role ids', () => {
    const [m] = parseAgentRoleMentions('@claude:second-opinion');
    expect(m.name).toBe('claude');
    expect(m.role).toBe('second-opinion');
  });

  it('returns an empty array when there are no mentions', () => {
    expect(parseAgentRoleMentions('no mentions here')).toEqual([]);
  });
});
