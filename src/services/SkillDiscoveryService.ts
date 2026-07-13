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
 * SkillDiscoveryService — discovers agent skills published as SKILL.md
 * files in GitHub repositories (the Anthropic Agent Skills / gstack
 * convention) and installs selected ones into a Mysti agents directory
 * (~/.mysti/agents or <workspace>/.mysti/agents), where AgentLoader
 * picks them up.
 *
 * Sources are configured via `mysti.agents.skillSources` as
 * `owner/repo[/path][@branch]` specs, e.g. `garrytan/gstack` or
 * `anthropics/skills@main`.
 *
 * Security note: skill content is untrusted third-party text that gets
 * injected into AI prompts. The interactive flow (AgentStudio) requires
 * explicit per-skill selection and a confirmation step; this service
 * never installs anything on its own.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  isSafeAgentId,
  parseAgentMarkdown,
  slugifyAgentId
} from '../managers/agentMarkdown';

/** Parsed `owner/repo[/path][@branch]` source spec. */
export interface SkillSourceSpec {
  owner: string;
  repo: string;
  /** Optional subdirectory to search within the repo. */
  pathPrefix?: string;
  /** Branch or ref; resolved to the repo's default branch when omitted. */
  branch?: string;
  /** The raw spec string as configured. */
  raw: string;
}

/** A skill found in a remote source, with its full content prefetched. */
export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  /** Path of the SKILL.md file within the repository. */
  path: string;
  /** `owner/repo` of the source. */
  repo: string;
  branch: string;
  content: string;
}

export interface DiscoverOptions {
  /** Maximum number of skill files to fetch (default 60). */
  limit?: number;
}

export interface DiscoveryResult {
  skills: DiscoveredSkill[];
  /** Number of matching files skipped due to the fetch limit. */
  truncated: number;
  /**
   * True when GitHub's tree listing itself was truncated (very large
   * repos) — some skills may exist that were never listed.
   */
  treeTruncated: boolean;
}

const DEFAULT_FETCH_LIMIT = 60;
const FETCH_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15000;
/** Skip pathological files — skills are prompt text, not datasets. */
const MAX_SKILL_FILE_BYTES = 128 * 1024;

const SKILL_BASENAMES = ['skill.md', 'skills.md'];

/**
 * Parse a `owner/repo[/path][@branch]` spec. Returns null when malformed.
 */
export function parseSkillSourceSpec(raw: string): SkillSourceSpec | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Split off @branch from the end (branch names may not contain '@' here)
  let branch: string | undefined;
  let rest = trimmed;
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex > 0) {
    branch = trimmed.slice(atIndex + 1) || undefined;
    rest = trimmed.slice(0, atIndex);
  }

  const segments = rest.split('/').filter(s => s.length > 0);
  if (segments.length < 2) {
    return null;
  }

  const [owner, repo, ...pathSegments] = segments;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  // Dot segments would be URL-normalized into requests against
  // unintended API endpoints — reject them outright
  if ([owner, repo, ...pathSegments].some(s => s === '.' || s === '..')) {
    return null;
  }

  return {
    owner,
    repo,
    pathPrefix: pathSegments.length > 0 ? pathSegments.join('/') : undefined,
    branch,
    raw: trimmed
  };
}

interface GitTreeEntry {
  path: string;
  type: string;
  size?: number;
}

export class SkillDiscoveryService {
  private readonly _fetch: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    // Bind to globalThis so V8 doesn't reject an unbound fetch reference
    this._fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Discover SKILL.md skills in a GitHub repository.
   */
  public async discoverSkills(spec: SkillSourceSpec, options?: DiscoverOptions): Promise<DiscoveryResult> {
    const limit = options?.limit ?? DEFAULT_FETCH_LIMIT;
    const branch = spec.branch || (await this._resolveDefaultBranch(spec));

    const tree = await this._fetchJson<{ tree?: GitTreeEntry[]; truncated?: boolean }>(
      `https://api.github.com/repos/${spec.owner}/${spec.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );

    const entries = (tree.tree || []).filter(entry => {
      if (entry.type !== 'blob') {
        return false;
      }
      const baseName = entry.path.split('/').pop() || '';
      if (!SKILL_BASENAMES.includes(baseName.toLowerCase())) {
        return false;
      }
      if (spec.pathPrefix && !entry.path.startsWith(`${spec.pathPrefix}/`) && entry.path !== spec.pathPrefix) {
        return false;
      }
      if (typeof entry.size === 'number' && entry.size > MAX_SKILL_FILE_BYTES) {
        return false;
      }
      return true;
    });

    const toFetch = entries.slice(0, limit);
    const truncated = entries.length - toFetch.length;

    const skills: DiscoveredSkill[] = [];
    for (let i = 0; i < toFetch.length; i += FETCH_CONCURRENCY) {
      const batch = toFetch.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(entry => this._fetchSkill(spec, branch, entry).catch(error => {
          console.warn(`[Mysti] Failed to fetch skill ${entry.path} from ${spec.owner}/${spec.repo}:`, error);
          return null;
        }))
      );
      for (const skill of results) {
        if (skill) {
          skills.push(skill);
        }
      }
    }

    // Dedupe by id (first occurrence wins — repo order)
    const seen = new Set<string>();
    const deduped = skills.filter(s => {
      if (seen.has(s.id)) {
        return false;
      }
      seen.add(s.id);
      return true;
    });

    return { skills: deduped, truncated, treeTruncated: tree.truncated === true };
  }

  /**
   * Install a discovered skill under `<baseDir>/skills/<id>/SKILL.md`.
   * Returns the absolute path of the written file.
   */
  public async installSkill(skill: DiscoveredSkill, baseDir: string): Promise<string> {
    if (!isSafeAgentId(skill.id)) {
      throw new Error(`Unsafe skill id: ${skill.id}`);
    }

    const skillDir = path.join(baseDir, 'skills', skill.id);
    // Defense in depth against path traversal ids
    const resolved = path.resolve(skillDir);
    if (!resolved.startsWith(path.resolve(baseDir, 'skills') + path.sep)) {
      throw new Error(`Skill install path escapes target directory: ${skill.id}`);
    }

    await fs.promises.mkdir(skillDir, { recursive: true });
    const filePath = path.join(skillDir, 'SKILL.md');
    await fs.promises.writeFile(filePath, this._withProvenance(skill), 'utf-8');
    return filePath;
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private async _resolveDefaultBranch(spec: SkillSourceSpec): Promise<string> {
    try {
      const repo = await this._fetchJson<{ default_branch?: string }>(
        `https://api.github.com/repos/${spec.owner}/${spec.repo}`
      );
      return repo.default_branch || 'main';
    } catch {
      return 'main';
    }
  }

  private async _fetchSkill(spec: SkillSourceSpec, branch: string, entry: GitTreeEntry): Promise<DiscoveredSkill | null> {
    // Encode per segment — paths containing '#' or '?' would otherwise
    // truncate the URL and 404
    const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
    const rawUrl = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${encodeURIComponent(branch)}/${encodedPath}`;
    const response = await this._fetch(rawUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mysti-Skill-Discovery' }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const content = await response.text();

    const parsed = parseAgentMarkdown(content);
    const dirName = entry.path.split('/').slice(-2, -1)[0] || '';
    const id = parsed.frontmatter.id
      ? slugifyAgentId(String(parsed.frontmatter.id))
      : slugifyAgentId(String(parsed.frontmatter.name || '') || dirName);

    if (!id) {
      return null;
    }

    const name = String(parsed.frontmatter.name || id);
    let description = String(parsed.frontmatter.description || '');
    if (!description) {
      // First prose line as a fallback description
      const firstLine = parsed.body
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0 && !l.startsWith('#'));
      description = (firstLine || '').slice(0, 200);
    }

    return {
      id,
      name,
      description,
      path: entry.path,
      repo: `${spec.owner}/${spec.repo}`,
      branch,
      content
    };
  }

  /**
   * Ensure installed content has frontmatter AgentLoader can read, and
   * record where the skill came from.
   */
  private _withProvenance(skill: DiscoveredSkill): string {
    const provenance = `<!-- Imported by Mysti from https://github.com/${skill.repo}/blob/${skill.branch}/${skill.path} -->\n`;

    const frontmatterMatch = skill.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (frontmatterMatch) {
      // Frontmatter must stay first for parsing — provenance goes after it
      const frontmatterBlock = frontmatterMatch[0];
      return frontmatterBlock + provenance + skill.content.slice(frontmatterBlock.length);
    }

    // No frontmatter at all — synthesize the minimum AgentLoader needs
    const frontmatter = [
      '---',
      `id: ${skill.id}`,
      `name: ${skill.name}`,
      `description: ${skill.description.replace(/\n/g, ' ')}`,
      'category: imported',
      '---',
      ''
    ].join('\n');
    return frontmatter + provenance + skill.content;
  }

  private async _fetchJson<T>(url: string): Promise<T> {
    const response = await this._fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mysti-Skill-Discovery',
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('GitHub API rate limit exceeded — try again in a few minutes.');
      }
      if (response.status === 404) {
        throw new Error('Repository or branch not found.');
      }
      throw new Error(`GitHub API error: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
