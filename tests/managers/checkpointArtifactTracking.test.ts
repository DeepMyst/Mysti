/**
 * Plan 20 Phase 0 — agent artifacts must be rewindable.
 *
 * `SHADOW_EXCLUDE` used to contain a bare `.mysti/`, which meant the shadow repo
 * never snapshotted anything under it — including the agent personas/skills
 * tree. The gating story for agent-authored capabilities leans on "a bad write
 * is checkpointed, so it is undoable"; that was simply false.
 *
 * The fix is a gitignore negation, which is easy to get subtly wrong: git will
 * not descend into an excluded DIRECTORY, so `.mysti/` + `!.mysti/agents/`
 * silently does nothing. These tests run real git rather than trusting the
 * pattern by inspection, and also cover the second half of the problem — the
 * user's own .gitignore, which `git add -A` honors independently.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SHADOW_EXCLUDE, CHECKPOINT_FORCED_PATHS } from '../../src/managers/CheckpointManager';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('shadow-repo excludes track agent artifacts', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ckpt-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), SHADOW_EXCLUDE);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('tracks .mysti/agents while still ignoring the rest of .mysti', () => {
    write(path.join(repo, '.mysti', 'agents', 'skills', 'mine.md'), '# mine');
    write(path.join(repo, '.mysti', 'skills.staged', 'draft', 'SKILL.md'), '# draft');
    write(path.join(repo, '.mysti', 'compaction', 'cache.json'), '{}');
    write(path.join(repo, '.mysti', 'scratch.txt'), 'noise');
    write(path.join(repo, 'src', 'app.ts'), 'export {};');

    git(repo, ['add', '-A']);
    const staged = git(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();

    expect(staged).toContain('.mysti/agents/skills/mine.md');
    expect(staged).toContain('.mysti/skills.staged/draft/SKILL.md');
    expect(staged).toContain('src/app.ts');
    // Everything else under .mysti/ stays out of the shadow repo.
    expect(staged).not.toContain('.mysti/compaction/cache.json');
    expect(staged).not.toContain('.mysti/scratch.txt');
  });

  it('still excludes the heavy directories', () => {
    write(path.join(repo, 'node_modules', 'pkg', 'index.js'), '//');
    write(path.join(repo, 'dist', 'bundle.js'), '//');
    git(repo, ['add', '-A']);
    const staged = git(repo, ['diff', '--cached', '--name-only']);
    expect(staged).not.toContain('node_modules');
    expect(staged).not.toContain('dist/bundle.js');
  });

  it('a user .gitignore of .mysti/ defeats `add -A` — force-add is what rescues it', () => {
    // This is why CHECKPOINT_FORCED_PATHS exists: info/exclude and the user's
    // .gitignore are consulted independently, and most projects ignore .mysti/.
    write(path.join(repo, '.gitignore'), '.mysti/\n');
    write(path.join(repo, '.mysti', 'agents', 'skills', 'mine.md'), '# mine');

    git(repo, ['add', '-A']);
    expect(git(repo, ['diff', '--cached', '--name-only'])).not.toContain('.mysti/agents');

    for (const p of CHECKPOINT_FORCED_PATHS) {
      try { git(repo, ['add', '-A', '-f', '--', p]); } catch { /* absent path */ }
    }
    expect(git(repo, ['diff', '--cached', '--name-only'])).toContain('.mysti/agents/skills/mine.md');
  });

  it('force-adding an absent artifact path is survivable', () => {
    // The common case: neither directory exists yet. `git add` errors on an
    // unmatched pathspec, so the snapshot loop must tolerate it.
    let threw = false;
    for (const p of CHECKPOINT_FORCED_PATHS) {
      try { git(repo, ['add', '-A', '-f', '--', p]); } catch { threw = true; }
    }
    expect(threw).toBe(true); // ...which is exactly why the caller uses non-throwing _runGit
  });

  it('a snapshotted artifact can be rewound', () => {
    const artifact = path.join(repo, '.mysti', 'agents', 'skills', 'mine.md');
    write(artifact, '# good version');
    git(repo, ['add', '-A', '-f', '--', '.mysti/agents']);
    git(repo, ['commit', '-q', '-m', 'checkpoint']);

    fs.writeFileSync(artifact, '# poisoned by an injected turn');
    expect(fs.readFileSync(artifact, 'utf8')).toContain('poisoned');

    git(repo, ['checkout', 'HEAD', '--', '.mysti/agents']);
    expect(fs.readFileSync(artifact, 'utf8')).toBe('# good version');
  });
});
