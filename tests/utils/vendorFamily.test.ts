/**
 * Cross-vendor reviewer selection (Plan 17 P2.1) — the reviewer must be a
 * DIFFERENT model vendor than the writer, preferring the flagship three.
 */
import { describe, it, expect } from 'vitest';
import { vendorFamily, pickCrossVendorReviewer } from '../../src/utils/vendorFamily';

describe('pickCrossVendorReviewer', () => {
  it('picks a different-vendor reviewer, preferring the flagship three', () => {
    // claude wrote → prefer codex (openai) over cursor
    expect(pickCrossVendorReviewer('claude-code', ['claude-code', 'openai-codex', 'cursor'])).toBe('openai-codex');
    // codex wrote → prefer claude
    expect(pickCrossVendorReviewer('openai-codex', ['openai-codex', 'claude-code', 'google-gemini'])).toBe('claude-code');
    // gemini wrote, only claude+gemini available → claude
    expect(pickCrossVendorReviewer('google-gemini', ['google-gemini', 'claude-code'])).toBe('claude-code');
  });

  it('returns null when no different-vendor backend exists', () => {
    expect(pickCrossVendorReviewer('claude-code', ['claude-code'])).toBeNull();
    // same family (both map to 'local') is not a valid cross-vendor reviewer
    expect(pickCrossVendorReviewer('ollama', ['ollama', 'localai'])).toBeNull();
  });

  it('falls back to a non-flagship different-vendor reviewer when no flagship is present', () => {
    expect(pickCrossVendorReviewer('claude-code', ['claude-code', 'cursor', 'qwen-code'])).toBe('cursor');
  });

  it('vendorFamily maps the flagship three and defaults unknown to the id', () => {
    expect(vendorFamily('claude-code')).toBe('anthropic');
    expect(vendorFamily('openai-codex')).toBe('openai');
    expect(vendorFamily('google-gemini')).toBe('google');
    expect(vendorFamily('ollama')).toBe('local');
    expect(vendorFamily('localai')).toBe('local');
  });
});
