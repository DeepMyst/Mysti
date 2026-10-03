import { describe, it, expect } from 'vitest';
import { clampEffort, EFFORT_ORDER } from '../../src/utils/effort';
import type { EffortLevel } from '../../src/types';

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('clampEffort', () => {
  it('returns undefined when nothing to apply', () => {
    expect(clampEffort(undefined, ALL)).toBeUndefined();
    expect(clampEffort('high', undefined)).toBeUndefined();
    expect(clampEffort('high', [])).toBeUndefined();
  });

  it('passes through an exactly-supported tier', () => {
    expect(clampEffort('high', ALL)).toBe('high');
    expect(clampEffort('max', ALL)).toBe('max');
    expect(clampEffort('low', ['low', 'medium'])).toBe('low');
  });

  it('clamps DOWN to the highest supported tier at or below the request', () => {
    // Codex/Copilot cap at xhigh → max clamps to xhigh
    expect(clampEffort('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    // LocalAI caps at high → xhigh and max clamp to high
    expect(clampEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
    expect(clampEffort('max', ['low', 'medium', 'high'])).toBe('high');
    // Ollama has no xhigh → xhigh falls to high (its next-lower supported)
    expect(clampEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
  });

  it('clamps UP to the lowest supported tier when the request is below all', () => {
    expect(clampEffort('low', ['high', 'max'])).toBe('high');
    expect(clampEffort('medium', ['xhigh'])).toBe('xhigh');
  });

  it('EFFORT_ORDER is the canonical low→high scale', () => {
    expect([...EFFORT_ORDER]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
