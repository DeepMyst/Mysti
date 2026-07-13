/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Conformance tests for the bundled agent content in
 * resources/agents/core: every persona and skill file must parse with
 * the REAL loader helpers and yield usable prompt material. This is
 * the guardrail for content edits — if a rewrite breaks frontmatter or
 * section structure, it fails here, not silently at prompt-build time.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  parseAgentMarkdown,
  extractAgentSection,
  extractAgentList,
  extractAgentInstructions,
  isSafeAgentId,
  AGENT_FILE_BASENAMES
} from '../../src/managers/agentMarkdown';

const CORE_DIR = path.join(__dirname, '..', '..', 'resources', 'agents', 'core');

interface AgentFile {
  filePath: string;
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function collectAgentFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(path.join(dir, entry.name));
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const sub = path.join(dir, entry.name);
      const agentFile = fs.readdirSync(sub).find(n => AGENT_FILE_BASENAMES.includes(n.toLowerCase()));
      if (agentFile) {
        files.push(path.join(sub, agentFile));
      }
    }
  }
  return files;
}

function loadAll(kind: 'personas' | 'skills' | 'roles'): AgentFile[] {
  return collectAgentFiles(path.join(CORE_DIR, kind)).map(filePath => {
    const { frontmatter, body } = parseAgentMarkdown(fs.readFileSync(filePath, 'utf-8'));
    return { filePath, relPath: path.relative(CORE_DIR, filePath), frontmatter, body };
  });
}

const personas = loadAll('personas');
const skills = loadAll('skills');
const roles = loadAll('roles');

describe('core agent content — catalog shape', () => {
  it('has the expected minimum catalog size', () => {
    // 17 original + 3 added personas; 13 original + 3 added skills; 6 Plan 14 roles
    expect(personas.length).toBeGreaterThanOrEqual(17);
    expect(skills.length).toBeGreaterThanOrEqual(13);
    expect(roles.length).toBeGreaterThanOrEqual(6);
  });

  it('has globally unique ids across personas, skills, and roles', () => {
    const ids = [...personas, ...skills, ...roles].map(f => String(f.frontmatter.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each([...personas, ...skills, ...roles].map(f => [f.relPath, f] as const))('core agent %s', (_rel, file) => {
  it('has complete, safe frontmatter', () => {
    expect(file.frontmatter.id, 'id required').toBeTruthy();
    expect(isSafeAgentId(String(file.frontmatter.id)), 'id must be a kebab-case slug').toBe(true);
    expect(String(file.frontmatter.name || '').length).toBeGreaterThan(1);
    const description = String(file.frontmatter.description || '');
    expect(description.length, 'description drives the picker UI').toBeGreaterThanOrEqual(10);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(String(file.frontmatter.category || '')).not.toBe('');
    const triggers = file.frontmatter.activationTriggers;
    expect(Array.isArray(triggers), 'activationTriggers required for auto-suggest').toBe(true);
    expect((triggers as string[]).length).toBeGreaterThanOrEqual(3);
  });

  it('yields non-empty prompt instructions (not a bare heading)', () => {
    const instructions = extractAgentInstructions(file.body);
    expect(instructions.length).toBeGreaterThan(20);
    expect(instructions.startsWith('#'), 'heading leaked into instructions').toBe(false);
  });

  it('extracted sections keep code fences balanced (no mid-fence truncation)', () => {
    for (const section of ['Key Characteristics', 'Instructions', 'Code Examples']) {
      const extracted = extractAgentSection(file.body, section);
      if (extracted) {
        expect((extracted.match(/```/g) || []).length % 2, `${section} truncated mid-fence`).toBe(0);
      }
    }
  });
});

describe.each(personas.map(f => [f.relPath, f] as const))('core persona %s', (_rel, file) => {
  it('has the persona prompt sections the loader extracts', () => {
    expect(extractAgentSection(file.body, 'Key Characteristics'), 'Key Characteristics section').toBeTruthy();
    expect(extractAgentList(file.body, 'Priorities'), 'Priorities list').toBeTruthy();
    expect(extractAgentList(file.body, 'Best Practices'), 'Best Practices list').toBeTruthy();
    expect(extractAgentList(file.body, 'Anti-Patterns to Avoid'), 'Anti-Patterns list').toBeTruthy();
  });
});

describe.each(skills.map(f => [f.relPath, f] as const))('core skill %s', (_rel, file) => {
  it('has an Instructions section', () => {
    expect(extractAgentSection(file.body, 'Instructions'), 'Instructions section').toBeTruthy();
  });
});

describe.each(roles.map(f => [f.relPath, f] as const))('core role %s', (_rel, file) => {
  it('has the role prompt sections the loader extracts', () => {
    expect(extractAgentSection(file.body, 'Key Characteristics'), 'Key Characteristics section').toBeTruthy();
    expect(extractAgentList(file.body, 'Priorities'), 'Priorities list').toBeTruthy();
    expect(extractAgentList(file.body, 'Best Practices'), 'Best Practices list').toBeTruthy();
    expect(extractAgentList(file.body, 'Anti-Patterns to Avoid'), 'Anti-Patterns list').toBeTruthy();
  });

  it('declares a valid collaboration access profile', () => {
    const access = String(file.frontmatter.access || '');
    expect(['read-only', 'gated-write'], `role ${String(file.frontmatter.id)} access`).toContain(access);
  });

  it('has a Return Contract section', () => {
    expect(extractAgentSection(file.body, 'Return Contract'), 'Return Contract section').toBeTruthy();
  });
});
