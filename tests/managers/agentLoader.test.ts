/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for AgentLoader: flat + SKILL.md directory layouts, id
 * derivation, source-priority dedup (workspace over core), and the
 * three-tier loading against real files on disk.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import { AgentLoader } from '../../src/managers/AgentLoader';

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const PERSONA_MD = `---
id: architect
name: Architect
description: Designs the big picture
icon: architecture
category: design
activationTriggers:
  - architecture
  - system design
---

# Key Characteristics

Focus on scalable, modular systems.

## Communication Style

Think in components.

## Priorities

1. Scalability
2. Boundaries

## Best Practices

- Draw diagrams first

## Anti-Patterns to Avoid

- God objects
`;

describe('AgentLoader', () => {
  let tmp: string;
  let coreDir: string;
  let workspaceDir: string;
  let loader: AgentLoader;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-agents-'));
    coreDir = path.join(tmp, 'core');
    workspaceDir = path.join(tmp, 'workspace');
    loader = new AgentLoader(
      { extensionPath: tmp } as unknown as vscode.ExtensionContext,
      [
        { path: coreDir, source: 'core' },
        { path: workspaceDir, source: 'workspace' }
      ]
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loads flat persona and skill files', async () => {
    write(path.join(coreDir, 'personas', 'architect.md'), PERSONA_MD);
    write(path.join(coreDir, 'skills', 'concise.md'), '---\nid: concise\nname: Concise\ndescription: Short answers\n---\n\n## Instructions\n\nBe brief.\n');

    const { personas, skills } = await loader.loadAllMetadata();
    expect(personas.map(p => p.id)).toEqual(['architect']);
    expect(skills.map(s => s.id)).toEqual(['concise']);
    expect(loader.getAgentType('architect')).toBe('persona');
    expect(loader.getAgentType('concise')).toBe('skill');
  });

  it('discovers SKILL.md directory-format skills (gstack convention)', async () => {
    write(
      path.join(coreDir, 'skills', 'office-hours', 'SKILL.md'),
      '---\nname: office-hours\ndescription: Six forcing questions\n---\n\n## Instructions\n\nAsk the questions.\n'
    );

    const { skills } = await loader.loadAllMetadata();
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('office-hours');
    expect(skills[0].description).toBe('Six forcing questions');
  });

  it('derives the id from the directory name when frontmatter has no id or name', async () => {
    write(path.join(coreDir, 'skills', 'my-skill', 'skills.md'), '---\ndescription: No name given\n---\n\nJust content.\n');

    const { skills } = await loader.loadAllMetadata();
    expect(skills.map(s => s.id)).toEqual(['my-skill']);
  });

  it('maps third-party `triggers` frontmatter to activationTriggers (gstack compat)', async () => {
    write(
      path.join(coreDir, 'skills', 'careful', 'SKILL.md'),
      '---\nname: careful\ndescription: Safety guardrails\ntriggers:\n  - be careful\n  - safety mode\n---\n\nBody.\n'
    );

    const { skills } = await loader.loadAllMetadata();
    expect(skills[0].activationTriggers).toEqual(['be careful', 'safety mode']);
  });

  it('slugifies unsafe frontmatter ids', async () => {
    write(path.join(coreDir, 'skills', 'weird.md'), '---\nid: Weird Skill!\nname: Weird\ndescription: x\n---\n\nBody.\n');

    const { skills } = await loader.loadAllMetadata();
    expect(skills.map(s => s.id)).toEqual(['weird-skill']);
  });

  it('later sources override earlier ones by id (workspace beats core)', async () => {
    write(path.join(coreDir, 'personas', 'architect.md'), PERSONA_MD);
    write(
      path.join(workspaceDir, 'personas', 'architect.md'),
      '---\nid: architect\nname: Architect (Team)\ndescription: Team-tuned architect\n---\n\n## Key Characteristics\n\nTeam version.\n'
    );

    const { personas } = await loader.loadAllMetadata();
    expect(personas).toHaveLength(1);
    expect(personas[0].name).toBe('Architect (Team)');
    expect(personas[0].source).toBe('workspace');
  });

  it('ignores hidden directories and non-markdown files', async () => {
    write(path.join(coreDir, 'skills', '.hidden', 'SKILL.md'), '---\nid: hidden\n---\nx');
    write(path.join(coreDir, 'skills', 'notes.txt'), 'not markdown');
    write(path.join(coreDir, 'skills', 'real.md'), '---\nid: real\nname: Real\ndescription: x\n---\n\nBody.\n');

    const { skills } = await loader.loadAllMetadata();
    expect(skills.map(s => s.id)).toEqual(['real']);
  });

  it('never loads README-style documentation files as agents', async () => {
    write(path.join(coreDir, 'skills', 'README.md'), '# About this folder\n\nConventions for the team.\n');
    write(path.join(coreDir, 'skills', 'real.md'), '---\nid: real\nname: Real\ndescription: x\n---\n\nBody.\n');

    const { skills } = await loader.loadAllMetadata();
    expect(skills.map(s => s.id)).toEqual(['real']);
  });

  it('reports built-in ids shadowed by workspace files', async () => {
    write(path.join(coreDir, 'personas', 'security.md'), PERSONA_MD.replace(/architect/g, 'security'));
    write(
      path.join(workspaceDir, 'personas', 'security.md'),
      '---\nid: security\nname: Security\ndescription: repo-supplied override\n---\n\n## Key Characteristics\n\nDo repo things.\n'
    );
    write(
      path.join(workspaceDir, 'personas', 'team-own.md'),
      '---\nid: team-own\nname: Team Own\ndescription: workspace-only persona\n---\n\n## Key Characteristics\n\nFine.\n'
    );

    await loader.loadAllMetadata();
    expect(loader.getWorkspaceShadowedIds()).toEqual(['security']);
  });

  it('loadInstructions extracts H1 legacy sections correctly (not the heading text)', async () => {
    write(path.join(coreDir, 'personas', 'architect.md'), PERSONA_MD);
    await loader.loadAllMetadata();

    const instructions = await loader.loadInstructions('architect');
    expect(instructions).not.toBeNull();
    expect(instructions!.instructions).toBe('Focus on scalable, modular systems.');
    expect(instructions!.instructions.startsWith('#')).toBe(false);
    expect(instructions!.communicationStyle).toBe('Think in components.');
    expect(instructions!.priorities).toEqual(['Scalability', 'Boundaries']);
    expect(instructions!.bestPractices).toEqual(['Draw diagrams first']);
    expect(instructions!.antiPatterns).toEqual(['God objects']);
  });

  it('reload picks up newly added files', async () => {
    write(path.join(coreDir, 'skills', 'first.md'), '---\nid: first\nname: First\ndescription: x\n---\n\nBody.\n');
    await loader.loadAllMetadata();
    expect(loader.getSkills()).toHaveLength(1);

    write(path.join(coreDir, 'skills', 'second.md'), '---\nid: second\nname: Second\ndescription: x\n---\n\nBody.\n');
    await loader.reload();
    expect(loader.getSkills().map(s => s.id).sort()).toEqual(['first', 'second']);
  });

  it('returns empty lists for missing source directories', async () => {
    const { personas, skills } = await loader.loadAllMetadata();
    expect(personas).toEqual([]);
    expect(skills).toEqual([]);
  });
});
