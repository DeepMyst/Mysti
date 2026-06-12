/**
 * Platform helper memoization tests (Plan 03 Phase 2, task 4):
 * the NVM directory walk and node-dir resolution are expensive fs probes
 * shared by every provider's discovery — they must run once per process
 * lifetime, with resetPlatformCache() as the explicit invalidation point.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCommonSearchPaths,
  getNvmPaths,
  getEnrichedEnv,
  getPlatformWalkCounts,
  resetPlatformCache,
} from '../../src/utils/platform';

describe('platform memoization', () => {
  beforeEach(() => {
    resetPlatformCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetPlatformCache();
    vi.restoreAllMocks();
  });

  describe('NVM directory walk', () => {
    it('walks once across repeated getCommonSearchPaths calls', () => {
      getCommonSearchPaths({ commandName: 'claude' });
      getCommonSearchPaths({ commandName: 'codex' });
      getCommonSearchPaths({ commandName: 'gemini' });

      expect(getPlatformWalkCounts().nvmWalks).toBeLessThanOrEqual(1);
    });

    it('walks once across mixed getCommonSearchPaths + getNvmPaths calls', () => {
      getCommonSearchPaths({ commandName: 'claude' });
      getNvmPaths('claude');
      getNvmPaths('codex');

      expect(getPlatformWalkCounts().nvmWalks).toBeLessThanOrEqual(1);
    });

    it('re-walks after resetPlatformCache()', () => {
      getNvmPaths('claude');
      const before = getPlatformWalkCounts().nvmWalks;

      resetPlatformCache();
      expect(getPlatformWalkCounts().nvmWalks).toBe(0);

      getNvmPaths('claude');
      expect(getPlatformWalkCounts().nvmWalks).toBe(before);
    });

    it('produces identical search paths from cached and fresh walks', () => {
      const first = getCommonSearchPaths({ commandName: 'claude' });
      const cached = getCommonSearchPaths({ commandName: 'claude' });
      resetPlatformCache();
      const fresh = getCommonSearchPaths({ commandName: 'claude' });

      expect(cached).toEqual(first);
      expect(fresh).toEqual(first);
    });
  });

  describe('getEnrichedEnv', () => {
    it('resolves the node directory at most once across repeated calls', () => {
      getEnrichedEnv();
      getEnrichedEnv();
      getEnrichedEnv({ FOO: 'bar' });

      expect(getPlatformWalkCounts().nodeDirWalks).toBeLessThanOrEqual(1);
      expect(getPlatformWalkCounts().nvmWalks).toBeLessThanOrEqual(1);
    });

    it('merges extras per call without mutating the cached base env', () => {
      const withExtra = getEnrichedEnv({ MYSTI_TEST_EXTRA: 'yes' });
      const plain = getEnrichedEnv();

      expect(withExtra.MYSTI_TEST_EXTRA).toBe('yes');
      expect(plain.MYSTI_TEST_EXTRA).toBeUndefined();
      expect(plain.PATH).toBe(withExtra.PATH);
    });

    it('returns a fresh object per call (callers may mutate safely)', () => {
      const a = getEnrichedEnv();
      const b = getEnrichedEnv();

      expect(a).not.toBe(b);
      a.MUTATED = 'true';
      expect(getEnrichedEnv().MUTATED).toBeUndefined();
    });
  });
});
