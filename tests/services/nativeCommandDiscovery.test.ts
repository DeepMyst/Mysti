/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Discovery of the commands a user (or their repo) authored for a backend.
 *
 * This is the half of the feature a curated catalog cannot do: `/design` is a
 * Claude Code SKILL, and a team's `/deploy-staging` lives in their repo. Both
 * change without a Mysti release, so they have to be read off disk.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import {
  NativeCommandDiscovery,
  frontmatterDescription,
  tomlDescription,
  stripFrontmatter,
  type NativeCommandFs,
} from '../../src/services/NativeCommandDiscovery';

const HOME = '/home/dev';
const WORKSPACE = '/repo';

/** In-memory tree: absolute path -> file contents. Directories are implied. */
function fakeFs(files: Record<string, string>): NativeCommandFs {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    readdirSync(dir) {
      const base = norm(dir) + '/';
      const seen = new Map<string, { name: string; dir: boolean }>();
      for (const full of Object.keys(files)) {
        if (!full.startsWith(base)) { continue; }
        const rest = full.slice(base.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (!name) { continue; }
        if (!seen.has(name)) { seen.set(name, { name, dir: slash !== -1 }); }
      }
      if (seen.size === 0) { throw new Error(`ENOENT: ${dir}`); }
      return [...seen.values()].map((e) => ({
        name: e.name,
        isDirectory: () => e.dir,
        isFile: () => !e.dir,
      }));
    },
    readFileSync(file) {
      const content = files[norm(file)];
      if (content === undefined) { throw new Error(`ENOENT: ${file}`); }
      return content;
    },
    statSize(file) {
      const content = files[norm(file)];
      if (content === undefined) { throw new Error(`ENOENT: ${file}`); }
      return Buffer.byteLength(content);
    },
  };
}

/**
 * `workspace` is passed positionally rather than defaulted: an explicit
 * `undefined` argument would fall back to a default value, so the "no folder
 * open" case would silently test the opposite of what it claims.
 */
function makeDiscovery(files: Record<string, string>, workspace: string | null = WORKSPACE) {
  return new NativeCommandDiscovery({
    fs: fakeFs(files),
    homeDir: HOME,
    getWorkspaceRoot: () => workspace ?? undefined,
    ttlMs: 0,
  });
}

describe('NativeCommandDiscovery — Claude Code', () => {
  const files = {
    [`${WORKSPACE}/.claude/commands/deploy.md`]:
      '---\nname: deploy\ndescription: Ship the current branch to staging\n---\n\nDeploy $ARGUMENTS to staging.\n',
    [`${WORKSPACE}/.claude/commands/frontend/audit.md`]:
      '---\ndescription: Audit the frontend bundle\n---\n\nAudit it.\n',
    [`${HOME}/.claude/commands/notes.md`]:
      '---\ndescription: Personal scratch command\n---\n\nTake notes.\n',
    [`${HOME}/.claude/skills/design/SKILL.md`]:
      '---\nname: design\ndescription: Create a design canvas\n---\n\nDesign things.\n',
  };

  let discovery: NativeCommandDiscovery;
  beforeEach(async () => {
    discovery = makeDiscovery(files);
    await discovery.refresh('claude-code');
  });

  it('finds project commands, user commands and skills together', () => {
    const names = discovery.getCached('claude-code').map((c) => c.name);
    expect(names).toEqual(['deploy', 'design', 'frontend:audit', 'notes']);
  });

  /** The case that motivated the feature: /design is a skill, not a built-in. */
  it('surfaces a skill by its directory name, reading SKILL.md for the description', () => {
    const design = discovery.getCached('claude-code').find((c) => c.name === 'design');
    expect(design?.description).toBe('Create a design canvas');
    expect(design?.origin).toBe('user');
    expect(design?.execution).toEqual({ kind: 'passthrough' });
  });

  it('namespaces a nested command directory the way the CLI does', () => {
    const audit = discovery.getCached('claude-code').find((c) => c.name === 'frontend:audit');
    expect(audit?.description).toBe('Audit the frontend bundle');
    expect(audit?.origin).toBe('project');
  });

  it('lets the repo win a name collision with the home directory', async () => {
    const d = makeDiscovery({
      [`${WORKSPACE}/.claude/commands/deploy.md`]: '---\ndescription: Repo version\n---\nbody',
      [`${HOME}/.claude/commands/deploy.md`]: '---\ndescription: Home version\n---\nbody',
    });
    await d.refresh('claude-code');
    const found = d.getCached('claude-code');
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe('Repo version');
    expect(found[0].origin).toBe('project');
  });
});

describe('NativeCommandDiscovery — other backends', () => {
  it('reads Gemini TOML commands and passes them through', async () => {
    const d = makeDiscovery({
      [`${WORKSPACE}/.gemini/commands/plan.toml`]:
        'description = "Draft an implementation plan"\nprompt = "Plan {{args}}"\n',
    });
    await d.refresh('google-gemini');
    expect(d.getCached('google-gemini')).toEqual([
      expect.objectContaining({
        name: 'plan',
        description: 'Draft an implementation plan',
        execution: { kind: 'passthrough' },
      }),
    ]);
  });

  /**
   * `codex exec` has no slash parser, so a Codex prompt file has to be sent as
   * its own text. Marking it `passthrough` would send a literal `/name`.
   */
  it('marks Codex prompts for local expansion, not pass-through', async () => {
    const d = makeDiscovery({
      [`${HOME}/.codex/prompts/refactor.md`]: 'Refactor $ARGUMENTS carefully.',
    });
    await d.refresh('openai-codex');
    const [cmd] = d.getCached('openai-codex');
    expect(cmd.name).toBe('refactor');
    expect(cmd.execution).toEqual({ kind: 'expand' });
  });

  it('does not treat a subdirectory as a namespace for CLIs that have none', async () => {
    const d = makeDiscovery({
      [`${WORKSPACE}/.cursor/commands/top.md`]: 'top',
      [`${WORKSPACE}/.cursor/commands/nested/deep.md`]: 'deep',
    });
    await d.refresh('cursor');
    expect(d.getCached('cursor').map((c) => c.name)).toEqual(['top']);
  });

  /**
   * A filename is untrusted input. POSIX allows whitespace and newlines in one,
   * and this name becomes `/name` inside the prompt sent to the backend — a
   * newline would put a second line there. Such a file is DROPPED rather than
   * cleaned up: sanitizing it would address a different command than the file.
   */
  it('drops a command whose filename could not be addressed as /name', async () => {
    const d = makeDiscovery({
      [`${HOME}/.codex/prompts/two words.md`]: 'body',
      [`${HOME}/.codex/prompts/line\nbreak.md`]: 'body',
      [`${HOME}/.codex/prompts/-leading-dash.md`]: 'body',
      [`${HOME}/.codex/prompts/ok-one.md`]: 'body',
    });
    await d.refresh('openai-codex');
    expect(d.getCached('openai-codex').map((c) => c.name)).toEqual(['ok-one']);
  });

  it('drops an unaddressable skill folder and namespace directory too', async () => {
    const d = makeDiscovery({
      [`${HOME}/.claude/skills/bad name/SKILL.md`]: '---\ndescription: d\n---\nbody',
      [`${HOME}/.claude/skills/good/SKILL.md`]: '---\ndescription: d\n---\nbody',
      [`${WORKSPACE}/.claude/commands/bad dir/cmd.md`]: '---\ndescription: d\n---\nbody',
    });
    await d.refresh('claude-code');
    expect(d.getCached('claude-code').map((c) => c.name)).toEqual(['good']);
  });

  it('returns nothing for a provider with no command directories', async () => {
    const d = makeDiscovery({});
    await d.refresh('ollama');
    expect(d.getCached('ollama')).toEqual([]);
  });

  it('skips project directories entirely when no folder is open', async () => {
    const d = makeDiscovery({
      [`${WORKSPACE}/.claude/commands/deploy.md`]: '---\ndescription: d\n---\nbody',
      [`${HOME}/.claude/commands/notes.md`]: '---\ndescription: n\n---\nbody',
    }, null);
    await d.refresh('claude-code');
    expect(d.getCached('claude-code').map((c) => c.name)).toEqual(['notes']);
  });
});

describe('NativeCommandDiscovery — caching', () => {
  it('reads are synchronous and empty until a refresh has run', () => {
    const d = makeDiscovery({ [`${HOME}/.codex/prompts/x.md`]: 'body' });
    expect(d.getCached('openai-codex')).toEqual([]);
    expect(d.isStale('openai-codex')).toBe(true);
  });

  /** Re-posting the menu on every keystroke is the thing to avoid. */
  it('reports change only when the visible set actually differs', async () => {
    const files: Record<string, string> = {
      [`${HOME}/.codex/prompts/x.md`]: '---\ndescription: X\n---\nbody',
    };
    const d = new NativeCommandDiscovery({
      fs: fakeFs(files),
      homeDir: HOME,
      getWorkspaceRoot: () => WORKSPACE,
      ttlMs: 0,
    });
    expect(await d.refreshIfStale('openai-codex')).toBe(true);
    expect(await d.refreshIfStale('openai-codex')).toBe(false);
  });

  it('honours the TTL rather than hitting disk on every menu open', async () => {
    const d = new NativeCommandDiscovery({
      fs: fakeFs({ [`${HOME}/.codex/prompts/x.md`]: 'body' }),
      homeDir: HOME,
      ttlMs: 60_000,
    });
    await d.refresh('openai-codex');
    expect(d.isStale('openai-codex')).toBe(false);
    expect(await d.refreshIfStale('openai-codex')).toBe(false);
    d.invalidate('openai-codex');
    expect(d.isStale('openai-codex')).toBe(true);
  });

  it('survives an unreadable command directory', async () => {
    const throwingFs: NativeCommandFs = {
      readdirSync() { throw new Error('EACCES'); },
      readFileSync() { throw new Error('EACCES'); },
      statSize() { throw new Error('EACCES'); },
    };
    const d = new NativeCommandDiscovery({ fs: throwingFs, homeDir: HOME, ttlMs: 0 });
    await expect(d.refresh('claude-code')).resolves.toEqual([]);
  });
});

describe('NativeCommandDiscovery — template expansion', () => {
  const file = `${HOME}/.codex/prompts/refactor.md`;

  it('substitutes $ARGUMENTS and drops the frontmatter', () => {
    const d = makeDiscovery({
      [file]: '---\ndescription: Refactor\n---\nRefactor $ARGUMENTS carefully.',
    });
    expect(d.expandTemplate(file, 'src/app.ts')).toBe('Refactor src/app.ts carefully.');
  });

  it('substitutes the {{args}} form Cline workflows use', () => {
    const d = makeDiscovery({ [file]: 'Review {{args}} now.' });
    expect(d.expandTemplate(file, 'the diff')).toBe('Review the diff now.');
  });

  it('appends arguments when the template has no placeholder', () => {
    const d = makeDiscovery({ [file]: 'Do the thing.' });
    expect(d.expandTemplate(file, 'to src/')).toBe('Do the thing.\n\nto src/');
    expect(d.expandTemplate(file, '')).toBe('Do the thing.');
  });

  /**
   * Returning null makes the caller report a failure. Returning `/name` instead
   * would send a literal slash command to a CLI that cannot expand one, which
   * looks like the command ran and quietly did something else.
   */
  it('returns null for a missing or empty template', () => {
    const d = makeDiscovery({ [file]: '---\ndescription: only frontmatter\n---\n' });
    expect(d.expandTemplate(file, '')).toBeNull();
    expect(d.expandTemplate(`${HOME}/.codex/prompts/gone.md`, '')).toBeNull();
  });
});

describe('description parsing', () => {
  it('reads quoted, unquoted and folded frontmatter descriptions', () => {
    expect(frontmatterDescription('---\ndescription: Plain text\n---\nbody')).toBe('Plain text');
    expect(frontmatterDescription('---\ndescription: "Quoted"\n---\nbody')).toBe('Quoted');
    expect(frontmatterDescription("---\ndescription: 'Single'\n---\nbody")).toBe('Single');
    expect(frontmatterDescription('---\ndescription: >\n  folded over\n  two lines\n---\nbody'))
      .toBe('folded over two lines');
  });

  /**
   * A prompt template's BODY is markdown full of `---` rules and colons. Only
   * the leading frontmatter block counts.
   */
  it('ignores a description that appears in the body', () => {
    expect(frontmatterDescription('# Title\n\ndescription: not frontmatter\n')).toBeUndefined();
    expect(frontmatterDescription('---\nname: x\n---\ndescription: in the body\n')).toBeUndefined();
  });

  it('reads TOML descriptions including the triple-quoted form', () => {
    expect(tomlDescription('description = "A command"\nprompt = "x"')).toBe('A command');
    expect(tomlDescription('description = """\nmulti line\n"""')).toBe('multi line');
    expect(tomlDescription('prompt = "x"')).toBeUndefined();
  });

  it('strips only a leading frontmatter block', () => {
    expect(stripFrontmatter('---\na: 1\n---\nbody here')).toBe('body here');
    expect(stripFrontmatter('no frontmatter')).toBe('no frontmatter');
    expect(stripFrontmatter('---\nunterminated\nbody')).toBe('---\nunterminated\nbody');
  });
});

describe('the fixture filesystem itself', () => {
  /** A broken fake would make every assertion above vacuously pass. */
  it('lists files and directories the way node does', () => {
    const fsx = fakeFs({ '/a/b.md': 'x', '/a/sub/c.md': 'y' });
    const entries = fsx.readdirSync('/a');
    expect(entries.map((e) => e.name).sort()).toEqual(['b.md', 'sub']);
    expect(entries.find((e) => e.name === 'sub')!.isDirectory()).toBe(true);
    expect(entries.find((e) => e.name === 'b.md')!.isFile()).toBe(true);
    expect(() => fsx.readdirSync('/missing')).toThrow();
    expect(fsx.readFileSync(path.posix.join('/a', 'b.md'))).toBe('x');
  });
});
