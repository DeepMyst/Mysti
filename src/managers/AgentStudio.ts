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
 * AgentStudio — interactive flows for authoring and importing agents:
 *  - Create a new persona or skill from a template (user or workspace scope)
 *  - Import skills discovered in GitHub sources (gstack, anthropics/skills, …)
 *  - Reload the agent catalog after external edits
 *
 * Pure UI orchestration: parsing lives in agentMarkdown.ts, remote
 * discovery in SkillDiscoveryService, loading in AgentLoader.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentLoader, type AgentType } from './AgentLoader';
import { isSafeAgentId, slugifyAgentId } from './agentMarkdown';
import {
  SkillDiscoveryService,
  parseSkillSourceSpec,
  type DiscoveredSkill
} from '../services/SkillDiscoveryService';

/** Default discovery sources, shown alongside user-configured ones. */
const DEFAULT_SKILL_SOURCES = ['garrytan/gstack', 'anthropics/skills'];

export class AgentStudio {
  constructor(
    private readonly _agentLoader: AgentLoader,
    private readonly _discovery: SkillDiscoveryService,
    /** Reloads the loader and pushes updated catalogs to all panels. */
    private readonly _onAgentsChanged: () => Promise<void>
  ) {}

  /**
   * Create a new persona or skill from a template, then open it.
   */
  public async createAgentInteractive(type: AgentType): Promise<void> {
    const label = type === 'persona' ? 'persona' : type === 'role' ? 'role' : 'skill';

    const name = await vscode.window.showInputBox({
      title: `New ${label}`,
      prompt: `Display name for the new ${label} (e.g. "API Designer")`,
      validateInput: value => {
        if (!value.trim()) {
          return 'Name is required';
        }
        const id = slugifyAgentId(value);
        if (!id) {
          return 'Name must contain at least one letter or number';
        }
        if (this._agentLoader.getAllMetadata().some(m => m.id === id)) {
          return `An agent with id '${id}' already exists — pick a different name`;
        }
        return null;
      }
    });
    if (!name) {
      return;
    }
    const id = slugifyAgentId(name);
    if (!id || !isSafeAgentId(id)) {
      vscode.window.showErrorMessage(`Mysti: cannot derive a valid id from "${name}"`);
      return;
    }

    const description = await vscode.window.showInputBox({
      title: `New ${label}: description`,
      prompt: 'One-line description shown in the agent picker',
      value: ''
    });
    if (description === undefined) {
      return;
    }

    const scope = await this._pickScope(`Where should this ${label} live?`);
    if (!scope) {
      return;
    }

    const baseDir = this._agentLoader.getScopeBaseDir(scope);
    if (!baseDir) {
      vscode.window.showErrorMessage('Mysti: open a folder to create workspace agents.');
      return;
    }

    // Personas and roles are flat files; skills use the SKILL.md directory format
    const filePath = type === 'persona'
      ? path.join(baseDir, 'personas', `${id}.md`)
      : type === 'role'
        ? path.join(baseDir, 'roles', `${id}.md`)
        : path.join(baseDir, 'skills', id, 'SKILL.md');

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const template = type === 'persona'
        ? this._personaTemplate(id, name.trim(), description.trim())
        : type === 'role'
          ? this._roleTemplate(id, name.trim(), description.trim())
          : this._skillTemplate(id, name.trim(), description.trim());
      await fs.promises.writeFile(filePath, template, { encoding: 'utf-8', flag: 'wx' });
    } catch (error) {
      const message = (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? `Mysti: a file already exists at ${filePath} — edit it directly or pick a different name.`
        : `Mysti: failed to create ${label} — ${(error as Error).message}`;
      vscode.window.showErrorMessage(message);
      return;
    }

    await this._onAgentsChanged();

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(
      `Mysti: created ${label} '${name.trim()}'. Saved edits are picked up automatically; "Mysti: Reload Agents" force-refreshes.`
    );
  }

  /**
   * Discover skills in a configured GitHub source and install selected ones.
   */
  public async importSkillsInteractive(): Promise<void> {
    const config = vscode.workspace.getConfiguration('mysti');
    const configured = config.get<string[]>('agents.skillSources', DEFAULT_SKILL_SOURCES);
    const sources = Array.from(new Set([...configured, ...DEFAULT_SKILL_SOURCES]));

    const CUSTOM_ITEM = '$(repo) Enter a GitHub repository…';
    const sourcePick = await vscode.window.showQuickPick(
      [...sources.map(s => ({ label: s, description: 'configured source' })), { label: CUSTOM_ITEM, description: 'owner/repo[/path][@branch]' }],
      { title: 'Import skills from', placeHolder: 'Pick a skill source (repos containing SKILL.md files)' }
    );
    if (!sourcePick) {
      return;
    }

    let rawSpec = sourcePick.label;
    if (rawSpec === CUSTOM_ITEM) {
      const entered = await vscode.window.showInputBox({
        title: 'GitHub skill source',
        prompt: 'owner/repo, optionally with /path and @branch (e.g. garrytan/gstack or anthropics/skills@main)',
        validateInput: v => (parseSkillSourceSpec(v) ? null : 'Expected owner/repo[/path][@branch]')
      });
      if (!entered) {
        return;
      }
      rawSpec = entered;
    }

    const spec = parseSkillSourceSpec(rawSpec);
    if (!spec) {
      vscode.window.showErrorMessage(`Mysti: invalid skill source '${rawSpec}'`);
      return;
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Mysti: discovering skills in ${spec.owner}/${spec.repo}…` },
      () => this._discovery.discoverSkills(spec)
    ).then(
      r => r,
      (error: Error) => {
        vscode.window.showErrorMessage(`Mysti: skill discovery failed — ${error.message}`);
        return null;
      }
    );
    if (!result) {
      return;
    }
    if (result.skills.length === 0) {
      vscode.window.showInformationMessage(`Mysti: no SKILL.md files found in ${spec.owner}/${spec.repo}.`);
      return;
    }

    const existingIds = new Set(this._agentLoader.getAllMetadata().map(m => m.id));
    const picks = await vscode.window.showQuickPick(
      result.skills.map(skill => ({
        label: skill.name,
        description: existingIds.has(skill.id) ? `${skill.id} — already installed (will overwrite)` : skill.id,
        detail: skill.description || skill.path,
        skill
      })),
      {
        title: `Skills in ${spec.owner}/${spec.repo}${result.truncated > 0 ? ` (showing first ${result.skills.length}, ${result.truncated} more skipped)` : ''}${result.treeTruncated ? ' — repo too large to list fully, some skills may be missing' : ''}`,
        placeHolder: 'Select skills to install',
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!picks || picks.length === 0) {
      return;
    }

    const scope = await this._pickScope('Install selected skills to');
    if (!scope) {
      return;
    }
    const baseDir = this._agentLoader.getScopeBaseDir(scope);
    if (!baseDir) {
      vscode.window.showErrorMessage('Mysti: open a folder to install workspace skills.');
      return;
    }

    // Skills are prompt-injected instructions — make the trust decision explicit
    const confirm = await vscode.window.showWarningMessage(
      `Install ${picks.length} skill(s) from ${spec.owner}/${spec.repo}? Their content will be injected into AI prompts when you enable them — review anything you don't trust before enabling.`,
      { modal: true },
      'Install'
    );
    if (confirm !== 'Install') {
      return;
    }

    const installed: string[] = [];
    const failed: string[] = [];
    for (const pick of picks) {
      try {
        installed.push(await this._discovery.installSkill(pick.skill as DiscoveredSkill, baseDir));
      } catch (error) {
        console.error(`[Mysti] Failed to install skill ${(pick.skill as DiscoveredSkill).id}:`, error);
        failed.push((pick.skill as DiscoveredSkill).name);
      }
    }

    await this._onAgentsChanged();

    if (installed.length > 0) {
      const action = await vscode.window.showInformationMessage(
        `Mysti: installed ${installed.length} skill(s)${failed.length > 0 ? ` (${failed.length} failed: ${failed.join(', ')})` : ''}. Enable them from the agent panel.`,
        'Open first skill'
      );
      if (action === 'Open first skill') {
        const doc = await vscode.workspace.openTextDocument(installed[0]);
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    } else {
      vscode.window.showErrorMessage(`Mysti: failed to install skills: ${failed.join(', ')}`);
    }
  }

  /**
   * Reload the agent catalog from disk and refresh all panels.
   */
  public async reloadAgents(): Promise<void> {
    await this._onAgentsChanged();
    const personas = this._agentLoader.getPersonas().length;
    const skills = this._agentLoader.getSkills().length;
    const roles = this._agentLoader.getRoles().length;
    vscode.window.showInformationMessage(`Mysti: reloaded agents — ${personas} personas, ${skills} skills, ${roles} roles.`);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private async _pickScope(title: string): Promise<'user' | 'workspace' | undefined> {
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const items: (vscode.QuickPickItem & { scope: 'user' | 'workspace' })[] = [
      { label: '$(account) User', description: '~/.mysti/agents — available in every workspace', scope: 'user' }
    ];
    if (hasWorkspace) {
      items.push({ label: '$(root-folder) Workspace', description: '.mysti/agents — shareable with your team via the repo', scope: 'workspace' });
    }
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Choose scope' });
    return pick?.scope;
  }

  private _personaTemplate(id: string, name: string, description: string): string {
    return `---
id: ${id}
name: ${name}
description: ${description || 'Describe what this persona is good at'}
icon: target
category: general
activationTriggers:
  - ${id.replace(/-/g, ' ')}
---

## Key Characteristics

Describe how the AI should behave when this persona is active. Write in
imperative voice ("Focus on…", "Prefer…"). This section is injected into
the prompt whenever the persona is selected.

## Communication Style

How should responses read? Tone, depth, structure.

## Priorities

1. First priority
2. Second priority
3. Third priority

## Best Practices

- A concrete practice this persona always follows
- Another one

## Anti-Patterns to Avoid

- Something this persona never does
`;
  }

  private _roleTemplate(id: string, name: string, description: string): string {
    const trigger = id.replace(/-/g, ' ');
    return `---
id: ${id}
name: ${name}
description: ${description || 'Describe the stance this collaboration role takes'}
icon: person
category: collaboration
access: read-only
pattern: one-shot
activationTriggers:
  - ${trigger}
  - ask a ${trigger}
  - ${trigger} on this
---

## Key Characteristics

Describe the stance this role takes when invoked as a collaborator (e.g.
"@agent:${id}"). Write in imperative voice. Set access to \`gated-write\` in
the frontmatter only if this role needs to edit files or run commands;
advisory roles stay \`read-only\`.

## Priorities

1. First priority
2. Second priority
3. Third priority

## Best Practices

- A concrete practice this role always follows
- Another one

## Anti-Patterns to Avoid

- Something this role never does

## Return Contract

Describe the shape of the response this role should return (sections,
length cap) so its output is easy to synthesize with other collaborators.
`;
  }

  private _skillTemplate(id: string, name: string, description: string): string {
    return `---
id: ${id}
name: ${name}
description: ${description || 'Describe the behavior this skill adds'}
category: general
activationTriggers:
  - ${id.replace(/-/g, ' ')}
---

## Instructions

Describe the behavior this skill adds, in imperative voice. This section
is injected into the prompt whenever the skill is enabled.

## Behavioral Guidelines

- A concrete guideline
- Another one

## Checklist

- [ ] Something to verify before finishing
`;
  }
}
