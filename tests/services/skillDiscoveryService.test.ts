/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for SkillDiscoveryService: source-spec parsing, GitHub tree
 * discovery of SKILL.md files, and safe installation into an agents
 * directory (path-traversal rejection, provenance/frontmatter handling).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SkillDiscoveryService,
  parseSkillSourceSpec,
  type DiscoveredSkill
} from '../../src/services/SkillDiscoveryService';
import { parseAgentMarkdown } from '../../src/managers/agentMarkdown';

describe('parseSkillSourceSpec', () => {
  it('parses owner/repo', () => {
    expect(parseSkillSourceSpec('garrytan/gstack')).toMatchObject({ owner: 'garrytan', repo: 'gstack' });
  });

  it('parses branch suffix', () => {
    expect(parseSkillSourceSpec('anthropics/skills@main')).toMatchObject({ owner: 'anthropics', repo: 'skills', branch: 'main' });
  });

  it('parses a path prefix with branch', () => {
    expect(parseSkillSourceSpec('a/b/sub/dir@dev')).toMatchObject({
      owner: 'a', repo: 'b', pathPrefix: 'sub/dir', branch: 'dev'
    });
  });

  it('rejects malformed specs', () => {
    expect(parseSkillSourceSpec('')).toBeNull();
    expect(parseSkillSourceSpec('just-owner')).toBeNull();
    expect(parseSkillSourceSpec('bad owner/repo')).toBeNull();
  });

  it('rejects dot-segment owner/repo/path (URL traversal)', () => {
    expect(parseSkillSourceSpec('../rate_limit')).toBeNull();
    expect(parseSkillSourceSpec('./repo')).toBeNull();
    expect(parseSkillSourceSpec('owner/..')).toBeNull();
    expect(parseSkillSourceSpec('owner/repo/../secrets')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const SKILL_CONTENT = `---
name: office-hours
description: Six forcing questions
---

## Instructions

Ask the questions.
`;

const NO_FRONTMATTER_CONTENT = `# investigate

Dig into the root cause before proposing fixes.
`;

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const key = String(url);
    for (const [pattern, value] of Object.entries(routes)) {
      if (key.includes(pattern)) {
        const isText = typeof value === 'string';
        return {
          ok: true,
          status: 200,
          text: async () => (isText ? value : JSON.stringify(value)),
          json: async () => value
        } as Response;
      }
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as Response;
  }) as typeof fetch;
}

describe('SkillDiscoveryService.discoverSkills', () => {
  const spec = { owner: 'garrytan', repo: 'gstack', raw: 'garrytan/gstack' };

  it('finds SKILL.md blobs, resolves the default branch, and parses metadata', async () => {
    const service = new SkillDiscoveryService(fakeFetch({
      'api.github.com/repos/garrytan/gstack/git/trees': {
        tree: [
          { path: 'skills/office-hours/SKILL.md', type: 'blob', size: 500 },
          { path: 'skills/investigate/skill.md', type: 'blob', size: 300 },
          { path: 'README.md', type: 'blob', size: 100 },
          { path: 'skills/huge/SKILL.md', type: 'blob', size: 10_000_000 },
          { path: 'skills', type: 'tree' }
        ]
      },
      'api.github.com/repos/garrytan/gstack': { default_branch: 'trunk' },
      'raw.githubusercontent.com/garrytan/gstack/trunk/skills/office-hours/SKILL.md': SKILL_CONTENT,
      'raw.githubusercontent.com/garrytan/gstack/trunk/skills/investigate/skill.md': NO_FRONTMATTER_CONTENT
    }));

    const result = await service.discoverSkills(spec);
    expect(result.truncated).toBe(0);
    expect(result.skills.map(s => s.id).sort()).toEqual(['investigate', 'office-hours']);

    const officeHours = result.skills.find(s => s.id === 'office-hours')!;
    expect(officeHours.name).toBe('office-hours');
    expect(officeHours.description).toBe('Six forcing questions');
    expect(officeHours.branch).toBe('trunk');

    // Frontmatter-less file falls back to dir name + first prose line
    const investigate = result.skills.find(s => s.id === 'investigate')!;
    expect(investigate.description).toContain('root cause');
  });

  it('respects the pathPrefix filter', async () => {
    const service = new SkillDiscoveryService(fakeFetch({
      'git/trees': {
        tree: [
          { path: 'skills/a/SKILL.md', type: 'blob', size: 10 },
          { path: 'other/b/SKILL.md', type: 'blob', size: 10 }
        ]
      },
      'raw.githubusercontent.com': SKILL_CONTENT
    }));

    const result = await service.discoverSkills({ ...spec, branch: 'main', pathPrefix: 'skills' });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].path).toBe('skills/a/SKILL.md');
  });

  it('reports truncation when over the fetch limit', async () => {
    const tree = Array.from({ length: 5 }, (_, i) => ({ path: `skills/s${i}/SKILL.md`, type: 'blob', size: 10 }));
    const service = new SkillDiscoveryService(fakeFetch({
      'git/trees': { tree },
      'raw.githubusercontent.com': SKILL_CONTENT
    }));

    const result = await service.discoverSkills({ ...spec, branch: 'main' }, { limit: 2 });
    expect(result.truncated).toBe(3);
  });

  it('percent-encodes raw-content path segments (# and ? safe)', async () => {
    const requested: string[] = [];
    const routing = fakeFetch({
      'git/trees': { tree: [{ path: 'c# skills/analyzer/SKILL.md', type: 'blob', size: 10 }] },
      'raw.githubusercontent.com': SKILL_CONTENT
    });
    const service = new SkillDiscoveryService((async (url: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(url));
      return routing(url, init);
    }) as typeof fetch);

    await service.discoverSkills({ ...spec, branch: 'main' });
    const rawRequest = requested.find(u => u.includes('raw.githubusercontent.com'))!;
    expect(rawRequest).toContain('c%23%20skills/analyzer/SKILL.md');
    expect(rawRequest).not.toContain('c# ');
  });

  it('propagates the GitHub tree-truncated flag', async () => {
    const service = new SkillDiscoveryService(fakeFetch({
      'git/trees': { tree: [{ path: 'skills/a/SKILL.md', type: 'blob', size: 10 }], truncated: true },
      'raw.githubusercontent.com': SKILL_CONTENT
    }));
    const result = await service.discoverSkills({ ...spec, branch: 'main' });
    expect(result.treeTruncated).toBe(true);
  });

  it('surfaces rate-limit errors with a friendly message', async () => {
    const service = new SkillDiscoveryService((async () => ({
      ok: false, status: 403, text: async () => '', json: async () => ({})
    })) as unknown as typeof fetch);

    await expect(service.discoverSkills({ ...spec, branch: 'main' })).rejects.toThrow(/rate limit/i);
  });
});

describe('SkillDiscoveryService.installSkill', () => {
  let tmp: string;
  const service = new SkillDiscoveryService(fakeFetch({}));

  const baseSkill: DiscoveredSkill = {
    id: 'office-hours',
    name: 'office-hours',
    description: 'Six forcing questions',
    path: 'skills/office-hours/SKILL.md',
    repo: 'garrytan/gstack',
    branch: 'main',
    content: SKILL_CONTENT
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-skill-install-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes <base>/skills/<id>/SKILL.md with provenance after the frontmatter', async () => {
    const installed = await service.installSkill(baseSkill, tmp);
    expect(installed).toBe(path.join(tmp, 'skills', 'office-hours', 'SKILL.md'));

    const written = fs.readFileSync(installed, 'utf-8');
    expect(written).toContain('Imported by Mysti from https://github.com/garrytan/gstack');

    // Frontmatter must still parse (provenance must not precede ---)
    const parsed = parseAgentMarkdown(written);
    expect(parsed.frontmatter.name).toBe('office-hours');
  });

  it('synthesizes frontmatter for frontmatter-less skills', async () => {
    const installed = await service.installSkill(
      { ...baseSkill, id: 'investigate', name: 'investigate', content: NO_FRONTMATTER_CONTENT },
      tmp
    );
    const parsed = parseAgentMarkdown(fs.readFileSync(installed, 'utf-8'));
    expect(parsed.frontmatter.id).toBe('investigate');
    expect(parsed.frontmatter.category).toBe('imported');
  });

  it('rejects unsafe ids (path traversal)', async () => {
    await expect(service.installSkill({ ...baseSkill, id: '../evil' }, tmp)).rejects.toThrow(/unsafe/i);
    expect(fs.existsSync(path.join(tmp, '..', 'evil'))).toBe(false);
  });
});
