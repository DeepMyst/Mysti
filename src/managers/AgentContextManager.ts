/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as vscode from 'vscode';
import {
  AgentLoader,
  type AgentMetadata,
  type AgentInstructions,
  type AgentFull,
  type AgentType
} from './AgentLoader';
import type { AgentConfiguration, DeveloperPersonaId, SkillId } from '../types';

// ============================================================================
// Agent Recommendation Types
// ============================================================================

/**
 * Recommendation confidence level
 */
export type RecommendationConfidence = 'high' | 'medium' | 'low';

/**
 * Agent recommendation with context
 */
export interface AgentRecommendation {
  agent: AgentMetadata;
  type: AgentType;
  confidence: RecommendationConfidence;
  matchedTriggers: string[];
  reason: string;
}

/**
 * Built prompt context with token estimation
 */
export interface AgentPromptContext {
  systemPrompt: string;
  estimatedTokens: number;
  includedPersona: AgentInstructions | null;
  includedSkills: AgentInstructions[];
  warnings: string[];
}

// ============================================================================
// AgentContextManager - Progressive loading and context building
// ============================================================================

export class AgentContextManager {
  private _agentLoader: AgentLoader;
  private _extensionContext: vscode.ExtensionContext;

  // Configuration
  private _tokensPerChar: number = 0.25;   // Rough estimate: 4 chars per token

  constructor(context: vscode.ExtensionContext, agentLoader: AgentLoader) {
    this._extensionContext = context;
    this._agentLoader = agentLoader;
  }

  /**
   * Get the max token budget from settings
   */
  private _getMaxTokenBudget(): number {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<number>('agents.maxTokenBudget', 2000);
  }

  /**
   * Check if auto-suggest is enabled in settings
   */
  public isAutoSuggestEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<boolean>('agents.autoSuggest', false);
  }

  /**
   * Get agent recommendations based on user query
   * Uses activation triggers from agent metadata
   */
  public getRecommendations(query: string, limit: number = 3): AgentRecommendation[] {
    const queryLower = query.toLowerCase();
    const recommendations: AgentRecommendation[] = [];

    // Get all cached metadata
    const allAgents = this._agentLoader.getAllMetadata();

    for (const agent of allAgents) {
      const agentType = this._agentLoader.getAgentType(agent.id);
      if (!agentType) {continue;}

      const matchedTriggers: string[] = [];
      let confidence: RecommendationConfidence = 'low';

      // Check activation triggers
      if (agent.activationTriggers) {
        for (const trigger of agent.activationTriggers) {
          const triggerLower = trigger.toLowerCase();
          if (queryLower.includes(triggerLower)) {
            matchedTriggers.push(trigger);
          }
        }
      }

      // Determine confidence based on matches
      if (matchedTriggers.length >= 2) {
        confidence = 'high';
      } else if (matchedTriggers.length === 1) {
        confidence = 'medium';
      } else {
        // Check name/description match
        if (queryLower.includes(agent.name.toLowerCase())) {
          matchedTriggers.push(agent.name);
          confidence = 'medium';
        } else if (this._fuzzyMatch(queryLower, agent.description)) {
          confidence = 'low';
        } else {
          continue; // No match, skip this agent
        }
      }

      const reason = matchedTriggers.length > 0
        ? `Matched: ${matchedTriggers.join(', ')}`
        : `Related to: ${agent.description.slice(0, 50)}...`;

      recommendations.push({
        agent,
        type: agentType,
        confidence,
        matchedTriggers,
        reason
      });
    }

    // Sort by confidence and limit
    return recommendations
      .sort((a, b) => {
        const confOrder = { high: 0, medium: 1, low: 2 };
        return confOrder[a.confidence] - confOrder[b.confidence];
      })
      .slice(0, limit);
  }

  /**
   * Build agent context for prompt injection
   * Uses progressive loading to stay within token budget
   */
  public async buildPromptContext(config: AgentConfiguration): Promise<AgentPromptContext> {
    const warnings: string[] = [];
    const maxTokenBudget = this._getMaxTokenBudget();
    let totalTokens = 0;
    let systemPrompt = '';
    let includedPersona: AgentInstructions | null = null;
    const includedSkills: AgentInstructions[] = [];

    // Load persona instructions if selected
    if (config.personaId) {
      const persona = await this._agentLoader.loadInstructions(config.personaId);

      if (persona) {
        const personaPrompt = this._buildPersonaPrompt(persona);
        const personaTokens = this._estimateTokens(personaPrompt);

        // maxTokenBudget === 0 means unlimited (no budget enforcement)
        if (maxTokenBudget === 0 || totalTokens + personaTokens <= maxTokenBudget) {
          systemPrompt += personaPrompt;
          totalTokens += personaTokens;
          includedPersona = persona;
        } else {
          warnings.push(`Persona '${persona.name}' exceeded token budget, using condensed version`);
          // Use condensed version (just key characteristics)
          const condensed = this._buildCondensedPersonaPrompt(persona);
          systemPrompt += condensed;
          totalTokens += this._estimateTokens(condensed);
          includedPersona = persona;
        }
      }
    }

    // Load skill instructions for enabled skills
    for (const skillId of config.enabledSkills) {
      const skill = await this._agentLoader.loadInstructions(skillId);

      if (skill) {
        const skillPrompt = this._buildSkillPrompt(skill);
        const skillTokens = this._estimateTokens(skillPrompt);

        // maxTokenBudget === 0 means unlimited (no budget enforcement)
        if (maxTokenBudget === 0 || totalTokens + skillTokens <= maxTokenBudget) {
          systemPrompt += skillPrompt;
          totalTokens += skillTokens;
          includedSkills.push(skill);
        } else {
          warnings.push(`Skill '${skill.name}' exceeded remaining token budget`);
        }
      }
    }

    return {
      systemPrompt,
      estimatedTokens: totalTokens,
      includedPersona,
      includedSkills,
      warnings
    };
  }

  /**
   * Get quick context for UI display (metadata only)
   */
  public getPersonaMetadata(personaId: DeveloperPersonaId): AgentMetadata | null {
    const personas = this._agentLoader.getPersonas();
    return personas.find(p => p.id === personaId) || null;
  }

  /**
   * Get skill metadata for UI display
   */
  public getSkillMetadata(skillId: SkillId): AgentMetadata | null {
    const skills = this._agentLoader.getSkills();
    return skills.find(s => s.id === skillId) || null;
  }

  /**
   * Get all available personas for UI
   */
  public getAllPersonas(): AgentMetadata[] {
    return this._agentLoader.getPersonas();
  }

  /**
   * Get all available skills for UI
   */
  public getAllSkills(): AgentMetadata[] {
    return this._agentLoader.getSkills();
  }

  /**
   * Load full agent content (Tier 3) for detailed view
   */
  public async getAgentDetails(agentId: string): Promise<AgentFull | null> {
    return this._agentLoader.loadFull(agentId);
  }

  /**
   * Set token budget for agent context (updates VSCode settings)
   */
  public async setTokenBudget(maxTokens: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('mysti');
    await config.update('agents.maxTokenBudget', maxTokens, vscode.ConfigurationTarget.Global);
  }

  /**
   * Get current token budget from settings
   */
  public getTokenBudget(): number {
    return this._getMaxTokenBudget();
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Build persona prompt for injection
   */
  private _buildPersonaPrompt(persona: AgentInstructions): string {
    let prompt = `\n[Agent Persona: ${persona.name}]\n`;
    prompt += `${persona.description}\n\n`;
    prompt += `Key Characteristics:\n${persona.instructions}\n`;

    if (persona.communicationStyle) {
      prompt += `\nCommunication Style: ${persona.communicationStyle}\n`;
    }

    if (persona.priorities && persona.priorities.length > 0) {
      prompt += `\nPriorities:\n`;
      persona.priorities.forEach((p, i) => {
        prompt += `${i + 1}. ${p}\n`;
      });
    }

    if (persona.bestPractices && persona.bestPractices.length > 0) {
      prompt += `\nBest Practices:\n`;
      persona.bestPractices.forEach(bp => {
        prompt += `- ${bp}\n`;
      });
    }

    if (persona.antiPatterns && persona.antiPatterns.length > 0) {
      prompt += `\nAvoid:\n`;
      persona.antiPatterns.forEach(ap => {
        prompt += `- ${ap}\n`;
      });
    }

    return prompt + '\n';
  }

  /**
   * Build condensed persona prompt (for token budget constraints)
   */
  private _buildCondensedPersonaPrompt(persona: AgentInstructions): string {
    let prompt = `[Persona: ${persona.name}] `;
    prompt += persona.description + '. ';
    prompt += persona.instructions.split('.').slice(0, 2).join('.') + '.';
    return prompt + '\n\n';
  }

  /**
   * Build skill prompt for injection
   */
  private _buildSkillPrompt(skill: AgentInstructions): string {
    let prompt = `[Skill: ${skill.name}]\n`;
    prompt += skill.instructions + '\n\n';
    return prompt;
  }

  /**
   * Estimate token count from text
   */
  private _estimateTokens(text: string): number {
    return Math.ceil(text.length * this._tokensPerChar);
  }

  /**
   * Simple fuzzy matching for description search
   */
  private _fuzzyMatch(query: string, text: string): boolean {
    const textLower = text.toLowerCase();
    const words = query.split(/\s+/).filter(w => w.length > 3);

    let matchCount = 0;
    for (const word of words) {
      if (textLower.includes(word)) {
        matchCount++;
      }
    }

    // Match if at least 30% of words match
    return words.length > 0 && matchCount / words.length >= 0.3;
  }
}
