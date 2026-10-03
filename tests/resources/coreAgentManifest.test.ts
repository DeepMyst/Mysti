/**
 * Plan 20 Phase 0 — the core integrity manifest must stay in sync with the
 * bundled agent content.
 *
 * Without this guard the failure is silent and backwards: editing a bundled
 * skill without regenerating the manifest does not break the build, it makes
 * that skill UNTRUSTED at runtime — so it quietly stops reaching the system
 * prompt and starts arriving fenced. The suite is the enforcement point,
 * because `npm run lint` is not currently green in this repo.
 */
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { CORE_AGENT_HASHES, CORE_AGENT_FILE_COUNT } from '../../src/generated/coreAgentManifest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('core agent integrity manifest', () => {
  it('is up to date with resources/agents/core', () => {
    // Runs the real generator in --check mode: any content edit, added file or
    // removed file fails here with the regeneration command.
    expect(() => {
      execFileSync('node', ['scripts/generate-core-agent-manifest.js', '--check'], {
        cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    }).not.toThrow();
  });

  it('covers a non-trivial number of files and agrees with its own count', () => {
    const keys = Object.keys(CORE_AGENT_HASHES);
    expect(keys.length).toBe(CORE_AGENT_FILE_COUNT);
    expect(keys.length).toBeGreaterThanOrEqual(40);
  });

  it('holds well-formed sha256 hex digests keyed by POSIX-relative paths', () => {
    for (const [rel, hash] of Object.entries(CORE_AGENT_HASHES)) {
      expect(rel, 'manifest keys must be POSIX-relative').not.toContain('\\');
      expect(rel).not.toMatch(/^([a-zA-Z]:)?[/\\]/);
      expect(rel).not.toContain('..');
      expect(rel).toMatch(/\.md$/);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is frozen, so nothing can mutate the hashes at runtime', () => {
    expect(Object.isFrozen(CORE_AGENT_HASHES)).toBe(true);
  });
});
