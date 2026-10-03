import { describe, it, expect } from 'vitest';
import { advisorCandidates, ADVISOR_DEFAULT_AGENTS } from '../../src/coordinator/advisor';

describe('advisorCandidates', () => {
  it('keeps every installed subscription CLI, in the configured order', () => {
    expect(advisorCandidates(ADVISOR_DEFAULT_AGENTS, ['openai-codex', 'claude-code'])).toEqual(['claude-code', 'openai-codex']);
    expect(advisorCandidates(ADVISOR_DEFAULT_AGENTS, ['openai-codex'])).toEqual(['openai-codex']);
  });
  it('is empty when none is installed, and never repeats one', () => {
    expect(advisorCandidates(ADVISOR_DEFAULT_AGENTS, ['google-gemini'])).toEqual([]);
    expect(advisorCandidates(['claude-code', 'claude-code'], ['claude-code'])).toEqual(['claude-code']);
  });
});
