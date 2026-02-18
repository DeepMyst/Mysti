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
 */

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { ProviderManager } from './ProviderManager';
import type { PersonaConfig } from '../providers/base/IProvider';
import type {
  ContextItem,
  Settings,
  AgentType,
  AgentConfig,
  BrainstormSession,
  BrainstormStreamChunk,
  CollaborationStrategy,
  ConvergenceMetrics,
  DiscussionRole,
  PersonaType
} from '../types';

/**
 * Agent color and icon definitions
 */
const AGENT_STYLES: Record<AgentType, { color: string; icon: string; displayName: string }> = {
  'claude-code': {
    color: '#8B5CF6', // Purple
    icon: '🟣',
    displayName: 'Claude'
  },
  'openai-codex': {
    color: '#10B981', // Green
    icon: '🟢',
    displayName: 'Codex'
  },
  'google-gemini': {
    color: '#4285F4', // Google Blue
    icon: '🔵',
    displayName: 'Gemini'
  },
  'cline': {
    color: '#F59E0B', // Amber
    icon: '🟠',
    displayName: 'Cline'
  },
  'github-copilot': {
    color: '#6366F1', // Indigo
    icon: '🟡',
    displayName: 'Copilot'
  },
  'cursor': {
    color: '#00A3FF', // Cursor Blue
    icon: '🔷',
    displayName: 'Cursor'
  },
  'openclaw': {
    color: '#E11D48', // Rose
    icon: '🔴',
    displayName: 'OpenClaw'
  }
};

/**
 * BrainstormManager - Orchestrates multi-agent team collaboration
 * using structured reasoning frameworks (Debate, Red Team, Perspectives, Delphi).
 */
export class BrainstormManager {
  private _extensionContext: vscode.ExtensionContext;
  private _providerManager: ProviderManager;
  // Per-panel session tracking for isolated brainstorm sessions
  private _panelSessions: Map<string, BrainstormSession> = new Map();

  constructor(context: vscode.ExtensionContext, providerManager: ProviderManager) {
    this._extensionContext = context;
    this._providerManager = providerManager;
  }

  /**
   * Get brainstorm configuration from settings
   */
  private _getConfig(): {
    strategy: CollaborationStrategy;
    maxDiscussionRounds: number;
    autoConverge: boolean;
    synthesisAgent: AgentType;
    agents: AgentType[];
  } {
    const config = vscode.workspace.getConfiguration('mysti');
    // Read user-selected agents from settings (pick 2 of 7)
    const selectedAgents = config.get<AgentType[]>('brainstorm.agents', ['claude-code', 'openai-codex']);
    // Ensure we have exactly 2 valid agents
    const validAgents = selectedAgents.filter(a => AGENT_STYLES[a]).slice(0, 2);
    const agents = validAgents.length === 2 ? validAgents : ['claude-code', 'openai-codex'] as AgentType[];

    // Support new strategy setting with backward compat for old discussionMode
    let strategy = config.get<CollaborationStrategy>('brainstorm.strategy', 'quick');
    // Backward compat: map old 'full' discussionMode to 'debate'
    const legacyMode = config.get<string>('brainstorm.discussionMode');
    if (!config.get<string>('brainstorm.strategy') && legacyMode === 'full') {
      strategy = 'debate';
    }

    return {
      strategy,
      maxDiscussionRounds: config.get<number>('brainstorm.maxDiscussionRounds',
        config.get<number>('brainstorm.discussionRounds', 2)),
      autoConverge: config.get<boolean>('brainstorm.autoConverge', true),
      synthesisAgent: config.get<AgentType>('brainstorm.synthesisAgent', 'claude-code'),
      agents
    };
  }

  /**
   * Get persona configuration for an agent
   */
  private _getPersonaConfig(agentId: AgentType): PersonaConfig {
    const config = vscode.workspace.getConfiguration('mysti');
    const agentKeyMap: Record<AgentType, string> = {
      'claude-code': 'claude',
      'openai-codex': 'codex',
      'google-gemini': 'gemini',
      'cline': 'cline',
      'github-copilot': 'copilot',
      'cursor': 'cursor',
      'openclaw': 'openclaw'
    };
    const agentKey = agentKeyMap[agentId] || 'claude';

    const personaType = config.get<PersonaType>(`agents.${agentKey}Persona`, 'neutral');
    const customPrompt = config.get<string>(`agents.${agentKey}CustomPrompt`, '');

    return {
      type: personaType,
      customPrompt: personaType === 'custom' ? customPrompt : undefined
    };
  }

  /**
   * Validate that selected providers are available
   */
  private async _validateProviderAvailability(
    selectedProviders: AgentType[]
  ): Promise<{ available: AgentType[]; unavailable: AgentType[] }> {
    const available: AgentType[] = [];
    const unavailable: AgentType[] = [];

    const availableProviders = await this._providerManager.getAvailableProviders();
    const availableNames = new Set(availableProviders.map(p => p.name));

    for (const providerId of selectedProviders) {
      if (availableNames.has(providerId)) {
        available.push(providerId);
      } else {
        unavailable.push(providerId);
      }
    }

    return { available, unavailable };
  }

  /**
   * Build agent configurations for the session
   */
  private _buildAgentConfigs(agentIds: AgentType[]): AgentConfig[] {
    return agentIds.map(id => ({
      id,
      displayName: AGENT_STYLES[id].displayName,
      color: AGENT_STYLES[id].color,
      icon: AGENT_STYLES[id].icon,
      persona: this._getPersonaConfig(id)
    }));
  }

  /**
   * Get the current brainstorm session for a panel
   */
  public getCurrentSession(panelId?: string): BrainstormSession | null {
    const sessionId = panelId || 'default';
    return this._panelSessions.get(sessionId) || null;
  }

  /**
   * Check if a brainstorm session is active for a panel
   */
  public isSessionActive(panelId?: string): boolean {
    const session = this.getCurrentSession(panelId);
    return session !== null && session.phase !== 'complete';
  }

  // ============================================================================
  // Main Entry Point
  // ============================================================================

  /**
   * Start a new brainstorm session with the selected collaboration strategy
   */
  public async *startBrainstormSession(
    query: string,
    context: ContextItem[],
    settings: Settings,
    panelId?: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const sessionId = panelId || 'default';
    const brainstormConfig = this._getConfig();

    // Validate provider availability
    const { available, unavailable } = await this._validateProviderAvailability(brainstormConfig.agents);

    if (unavailable.length > 0) {
      console.warn(`[Mysti] Brainstorm: Unavailable providers: ${unavailable.join(', ')}`);
    }

    if (available.length < 2) {
      yield {
        type: 'agent_error',
        content: `Brainstorm mode requires at least 2 available providers. Currently available: ${available.length}. Unavailable: ${unavailable.join(', ')}.`
      };
      yield { type: 'done' };
      return;
    }

    const validatedConfig = {
      ...brainstormConfig,
      agents: available.slice(0, 2) as [AgentType, AgentType]
    };

    // Validate synthesis agent
    const synthesisAvailable = await this._validateProviderAvailability([brainstormConfig.synthesisAgent]);
    if (synthesisAvailable.unavailable.length > 0) {
      console.warn(`[Mysti] Brainstorm: Synthesis agent ${brainstormConfig.synthesisAgent} unavailable, using ${available[0]}`);
      validatedConfig.synthesisAgent = available[0];
    }

    const agentConfigs = this._buildAgentConfigs(validatedConfig.agents);

    const session: BrainstormSession = {
      id: uuidv4(),
      query,
      phase: 'initial',
      strategy: validatedConfig.strategy,
      agents: agentConfigs,
      agentResponses: new Map(),
      discussionRounds: [],
      convergenceHistory: [],
      unifiedSolution: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this._panelSessions.set(sessionId, session);
    console.log(`[Mysti] Brainstorm: Starting ${validatedConfig.strategy} session ${session.id} for panel ${sessionId}`);

    try {
      // Dispatch to strategy-specific orchestration
      switch (validatedConfig.strategy) {
        case 'debate':
          yield* this._runDebateStrategy(query, context, settings, validatedConfig, sessionId);
          break;
        case 'red-team':
          yield* this._runRedTeamStrategy(query, context, settings, validatedConfig, sessionId);
          break;
        case 'perspectives':
          yield* this._runPerspectivesStrategy(query, context, settings, validatedConfig, sessionId);
          break;
        case 'delphi':
          yield* this._runDelphiStrategy(query, context, settings, validatedConfig, sessionId);
          break;
        case 'quick':
        default:
          yield* this._runQuickStrategy(query, context, settings, validatedConfig, sessionId);
          break;
      }

      // Complete
      yield { type: 'phase_change', phase: 'complete' };
      session.phase = 'complete';
      yield { type: 'done' };

    } catch (error) {
      console.error('[Mysti] Brainstorm: Error in session', error);
      yield {
        type: 'agent_error',
        content: error instanceof Error ? error.message : 'Unknown error in brainstorm session'
      };
    }
  }

  // ============================================================================
  // Strategy Implementations
  // ============================================================================

  /**
   * Quick strategy: Individual analysis -> Direct synthesis (no discussion)
   */
  private async *_runQuickStrategy(
    query: string,
    context: ContextItem[],
    settings: Settings,
    config: { synthesisAgent: AgentType; agents: [AgentType, AgentType] },
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;

    // Phase 1: Individual analysis
    yield { type: 'phase_change', phase: 'individual', strategy: 'quick' };
    session.phase = 'individual';
    yield* this._runIndividualPhase(query, context, settings, sessionId);

    // Phase 2: Direct synthesis
    yield { type: 'phase_change', phase: 'synthesis' };
    session.phase = 'synthesis';
    yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
  }

  /**
   * Debate strategy: Individual -> Parallel Critique -> Rebuttal -> Synthesis
   * Inspired by Multi-Agent Debate + Devil's Advocate
   */
  private async *_runDebateStrategy(
    query: string,
    context: ContextItem[],
    settings: Settings,
    config: { maxDiscussionRounds: number; autoConverge: boolean; synthesisAgent: AgentType; agents: [AgentType, AgentType] },
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;

    // Phase 1: Individual analysis
    yield { type: 'phase_change', phase: 'individual', strategy: 'debate' };
    session.phase = 'individual';
    yield* this._runIndividualPhase(query, context, settings, sessionId);

    // Check if we have at least one complete response to discuss
    const completeAgents = this._getCompleteAgents(sessionId);
    if (completeAgents.length < 2) {
      console.warn('[Mysti] Brainstorm: Not enough complete responses for discussion, skipping to synthesis');
      yield { type: 'phase_change', phase: 'synthesis' };
      session.phase = 'synthesis';
      yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
      return;
    }

    // Phase 2: Discussion rounds (critique + rebuttal)
    yield { type: 'phase_change', phase: 'discussion' };
    session.phase = 'discussion';

    for (let round = 1; round <= config.maxDiscussionRounds; round++) {
      const roleName: DiscussionRole = round === 1 ? 'critic' : 'defender';
      const roleAssignments = new Map<AgentType, DiscussionRole>();

      // Assign roles: both agents critique in parallel
      for (const agent of session.agents) {
        roleAssignments.set(agent.id, roleName);
      }

      yield {
        type: 'discussion_round_start',
        roundNumber: round,
        discussionRole: roleName,
        content: round === 1 ? 'Critique Phase' : 'Rebuttal Phase'
      };

      // Run critique/rebuttal in parallel
      const generators = session.agents
        .filter(a => completeAgents.includes(a.id))
        .map(agent => {
          const prompt = round === 1
            ? this._buildDebateCritiquePrompt(agent.id, sessionId)
            : this._buildDebateRebuttalPrompt(agent.id, round, sessionId);
          return this._streamDiscussionResponse(agent, prompt, context, settings, sessionId, roleName, round);
        });

      const contributions = new Map<AgentType, string>();
      for await (const chunk of this._interleaveGenerators(generators)) {
        yield chunk;
        // Accumulate contributions from discussion_text chunks
        if (chunk.type === 'discussion_text' && chunk.agentId && chunk.content) {
          const existing = contributions.get(chunk.agentId) || '';
          contributions.set(chunk.agentId, existing + chunk.content);
        }
      }

      session.discussionRounds.push({
        roundNumber: round,
        contributions,
        roleAssignments
      });

      // Assess convergence
      if (config.autoConverge && round < config.maxDiscussionRounds) {
        const convergence = this._assessConvergence(sessionId, round);
        session.convergenceHistory.push(convergence);
        yield { type: 'convergence_update', convergence, roundNumber: round };

        if (convergence.recommendation === 'converged' || convergence.recommendation === 'stalled') {
          console.log(`[Mysti] Brainstorm: Discussion ${convergence.recommendation} at round ${round}`);
          break;
        }
      }
    }

    // Phase 3: Synthesis
    yield { type: 'phase_change', phase: 'synthesis' };
    session.phase = 'synthesis';
    yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
  }

  /**
   * Red Team strategy: Propose -> Challenge -> Defend -> Synthesis
   * One agent proposes, the other stress-tests, then defense round
   */
  private async *_runRedTeamStrategy(
    query: string,
    context: ContextItem[],
    settings: Settings,
    config: { synthesisAgent: AgentType; agents: [AgentType, AgentType] },
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const [proposerAgent, challengerAgent] = session.agents;

    // Phase 1: Proposer creates solution
    yield { type: 'phase_change', phase: 'individual', strategy: 'red-team' };
    session.phase = 'individual';

    // Initialize response tracking
    for (const agent of session.agents) {
      session.agentResponses.set(agent.id, {
        agentId: agent.id,
        content: '',
        status: 'pending',
        timestamp: Date.now()
      });
    }

    // Only the proposer responds in phase 1
    const proposerGen = this._streamAgentResponse(proposerAgent, query, context, settings, sessionId);
    for await (const chunk of proposerGen) {
      yield chunk;
    }

    // Check if proposer succeeded
    const proposerResponse = session.agentResponses.get(proposerAgent.id);
    if (!proposerResponse || proposerResponse.status === 'error') {
      console.warn('[Mysti] Brainstorm: Proposer failed, skipping to synthesis');
      yield { type: 'phase_change', phase: 'synthesis' };
      session.phase = 'synthesis';
      yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
      return;
    }

    // Phase 2: Discussion - Challenge then Defend
    yield { type: 'phase_change', phase: 'discussion' };
    session.phase = 'discussion';

    // Round 1: Challenger stress-tests the proposal
    const challengeRoleAssignments = new Map<AgentType, DiscussionRole>();
    challengeRoleAssignments.set(challengerAgent.id, 'challenger');

    yield {
      type: 'discussion_round_start',
      roundNumber: 1,
      discussionRole: 'challenger',
      content: 'Challenge Phase',
      agentId: challengerAgent.id
    };

    const challengePrompt = this._buildRedTeamChallengePrompt(proposerAgent.id, sessionId);
    const challengeContributions = new Map<AgentType, string>();
    const challengeGen = this._streamDiscussionResponse(
      challengerAgent, challengePrompt, context, settings, sessionId, 'challenger', 1
    );
    for await (const chunk of challengeGen) {
      yield chunk;
      if (chunk.type === 'discussion_text' && chunk.agentId && chunk.content) {
        const existing = challengeContributions.get(chunk.agentId) || '';
        challengeContributions.set(chunk.agentId, existing + chunk.content);
      }
    }

    session.discussionRounds.push({
      roundNumber: 1,
      contributions: challengeContributions,
      roleAssignments: challengeRoleAssignments
    });

    // Round 2: Proposer defends and revises
    const defendRoleAssignments = new Map<AgentType, DiscussionRole>();
    defendRoleAssignments.set(proposerAgent.id, 'defender');

    yield {
      type: 'discussion_round_start',
      roundNumber: 2,
      discussionRole: 'defender',
      content: 'Defense Phase',
      agentId: proposerAgent.id
    };

    const defendPrompt = this._buildRedTeamDefensePrompt(proposerAgent.id, challengerAgent.id, sessionId);
    const defendContributions = new Map<AgentType, string>();
    const defendGen = this._streamDiscussionResponse(
      proposerAgent, defendPrompt, context, settings, sessionId, 'defender', 2
    );
    for await (const chunk of defendGen) {
      yield chunk;
      if (chunk.type === 'discussion_text' && chunk.agentId && chunk.content) {
        const existing = defendContributions.get(chunk.agentId) || '';
        defendContributions.set(chunk.agentId, existing + chunk.content);
      }
    }

    session.discussionRounds.push({
      roundNumber: 2,
      contributions: defendContributions,
      roleAssignments: defendRoleAssignments
    });

    // Phase 3: Synthesis
    yield { type: 'phase_change', phase: 'synthesis' };
    session.phase = 'synthesis';
    yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
  }

  /**
   * Perspectives strategy: Risk lens + Opportunity lens -> Cross-review -> Synthesis
   * Inspired by Six Thinking Hats (simplified to 2 complementary perspectives)
   */
  private async *_runPerspectivesStrategy(
    query: string,
    context: ContextItem[],
    settings: Settings,
    config: { synthesisAgent: AgentType; agents: [AgentType, AgentType] },
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const [riskAgent, innovatorAgent] = session.agents;

    // Phase 1: Lens-specific individual analysis (parallel)
    yield { type: 'phase_change', phase: 'individual', strategy: 'perspectives' };
    session.phase = 'individual';

    // Initialize response tracking
    for (const agent of session.agents) {
      session.agentResponses.set(agent.id, {
        agentId: agent.id,
        content: '',
        status: 'pending',
        timestamp: Date.now()
      });
    }

    // Each agent gets a different lens prompt
    const riskPrompt = this._buildPerspectivesRiskPrompt(query);
    const innovatorPrompt = this._buildPerspectivesInnovatorPrompt(query);

    const generators = [
      this._streamAgentResponse(riskAgent, riskPrompt, context, settings, sessionId),
      this._streamAgentResponse(innovatorAgent, innovatorPrompt, context, settings, sessionId)
    ];

    yield* this._interleaveGenerators(generators);

    // Check if we have responses to cross-review
    const completeAgents = this._getCompleteAgents(sessionId);
    if (completeAgents.length < 2) {
      yield { type: 'phase_change', phase: 'synthesis' };
      session.phase = 'synthesis';
      yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
      return;
    }

    // Phase 2: Cross-review (parallel)
    yield { type: 'phase_change', phase: 'discussion' };
    session.phase = 'discussion';

    const roleAssignments = new Map<AgentType, DiscussionRole>();
    roleAssignments.set(riskAgent.id, 'risk-analyst');
    roleAssignments.set(innovatorAgent.id, 'innovator');

    yield {
      type: 'discussion_round_start',
      roundNumber: 1,
      content: 'Cross-Review: Balancing Risk and Opportunity'
    };

    // Each agent reviews the other's perspective
    const crossReviewGens = [
      this._streamDiscussionResponse(
        riskAgent,
        this._buildPerspectivesCrossReviewPrompt(riskAgent.id, innovatorAgent.id, 'risk-analyst', sessionId),
        context, settings, sessionId, 'risk-analyst', 1
      ),
      this._streamDiscussionResponse(
        innovatorAgent,
        this._buildPerspectivesCrossReviewPrompt(innovatorAgent.id, riskAgent.id, 'innovator', sessionId),
        context, settings, sessionId, 'innovator', 1
      )
    ];

    const contributions = new Map<AgentType, string>();
    for await (const chunk of this._interleaveGenerators(crossReviewGens)) {
      yield chunk;
      if (chunk.type === 'discussion_text' && chunk.agentId && chunk.content) {
        const existing = contributions.get(chunk.agentId) || '';
        contributions.set(chunk.agentId, existing + chunk.content);
      }
    }

    session.discussionRounds.push({
      roundNumber: 1,
      contributions,
      roleAssignments
    });

    // Phase 3: Synthesis
    yield { type: 'phase_change', phase: 'synthesis' };
    session.phase = 'synthesis';
    yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
  }

  /**
   * Delphi strategy: Individual -> Facilitator Summary -> Refinement -> Synthesis
   * Inspired by the Delphi Method for consensus-building
   */
  private async *_runDelphiStrategy(
    query: string,
    context: ContextItem[],
    settings: Settings,
    config: { maxDiscussionRounds: number; autoConverge: boolean; synthesisAgent: AgentType; agents: [AgentType, AgentType] },
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;

    // Phase 1: Independent individual analysis
    yield { type: 'phase_change', phase: 'individual', strategy: 'delphi' };
    session.phase = 'individual';
    yield* this._runIndividualPhase(query, context, settings, sessionId);

    const completeAgents = this._getCompleteAgents(sessionId);
    if (completeAgents.length < 2) {
      yield { type: 'phase_change', phase: 'synthesis' };
      session.phase = 'synthesis';
      yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
      return;
    }

    // Phase 2: Facilitator-mediated discussion rounds
    yield { type: 'phase_change', phase: 'discussion' };
    session.phase = 'discussion';

    for (let round = 1; round <= config.maxDiscussionRounds; round++) {
      // Step A: Facilitator produces anonymous summary
      const facilitatorRoleAssignments = new Map<AgentType, DiscussionRole>();
      facilitatorRoleAssignments.set(config.synthesisAgent, 'facilitator');

      yield {
        type: 'discussion_round_start',
        roundNumber: round,
        discussionRole: 'facilitator',
        content: `Round ${round}: Facilitator Summary`
      };

      const facilitatorPrompt = this._buildDelphiFacilitatorPrompt(round, sessionId);
      let facilitatorSummary = '';
      const facilitatorAgent = session.agents.find(a => a.id === config.synthesisAgent)
        || session.agents[0];

      const facGen = this._streamDiscussionResponse(
        facilitatorAgent, facilitatorPrompt, context, settings, sessionId, 'facilitator', round
      );
      for await (const chunk of facGen) {
        yield chunk;
        if (chunk.type === 'discussion_text' && chunk.content) {
          facilitatorSummary += chunk.content;
        }
      }

      const facilitatorContributions = new Map<AgentType, string>();
      facilitatorContributions.set(facilitatorAgent.id, facilitatorSummary);

      session.discussionRounds.push({
        roundNumber: round * 2 - 1, // Odd rounds are facilitator summaries
        contributions: facilitatorContributions,
        roleAssignments: facilitatorRoleAssignments
      });

      // Step B: Both agents refine based on facilitator summary (parallel)
      const refinerRoleAssignments = new Map<AgentType, DiscussionRole>();
      for (const agent of session.agents) {
        refinerRoleAssignments.set(agent.id, 'refiner');
      }

      yield {
        type: 'discussion_round_start',
        roundNumber: round,
        discussionRole: 'refiner',
        content: `Round ${round}: Agent Refinement`
      };

      const refinerGens = session.agents
        .filter(a => completeAgents.includes(a.id))
        .map(agent => {
          const refinePrompt = this._buildDelphiRefinePrompt(agent.id, facilitatorSummary, round, sessionId);
          return this._streamDiscussionResponse(agent, refinePrompt, context, settings, sessionId, 'refiner', round);
        });

      const refinerContributions = new Map<AgentType, string>();
      for await (const chunk of this._interleaveGenerators(refinerGens)) {
        yield chunk;
        if (chunk.type === 'discussion_text' && chunk.agentId && chunk.content) {
          const existing = refinerContributions.get(chunk.agentId) || '';
          refinerContributions.set(chunk.agentId, existing + chunk.content);
        }
      }

      session.discussionRounds.push({
        roundNumber: round * 2, // Even rounds are refinements
        contributions: refinerContributions,
        roleAssignments: refinerRoleAssignments
      });

      // Parse convergence score from facilitator summary
      if (config.autoConverge) {
        const convergence = this._assessConvergence(sessionId, round);
        // Try to extract facilitator's convergence score
        const scoreMatch = facilitatorSummary.match(/Convergence Score:\s*(\d+)\s*\/\s*10/i);
        if (scoreMatch) {
          convergence.overallConvergence = parseInt(scoreMatch[1], 10) / 10;
          if (convergence.overallConvergence >= 0.7) {
            convergence.recommendation = 'converged';
          }
        }
        session.convergenceHistory.push(convergence);
        yield { type: 'convergence_update', convergence, roundNumber: round };

        if (convergence.recommendation === 'converged') {
          console.log(`[Mysti] Brainstorm: Delphi converged at round ${round}`);
          break;
        }
      }
    }

    // Phase 3: Synthesis
    yield { type: 'phase_change', phase: 'synthesis' };
    session.phase = 'synthesis';
    yield* this._runSynthesisPhase(context, settings, config.synthesisAgent, sessionId);
  }

  // ============================================================================
  // Shared Phase Runners
  // ============================================================================

  /**
   * Run the individual analysis phase - agents analyze in parallel
   */
  private async *_runIndividualPhase(
    query: string,
    context: ContextItem[],
    settings: Settings,
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const agents = session.agents;

    // Create response tracking for each agent
    for (const agent of agents) {
      session.agentResponses.set(agent.id, {
        agentId: agent.id,
        content: '',
        status: 'pending',
        timestamp: Date.now()
      });
    }

    // Run agents in parallel using interleaved streaming
    const generators = agents.map(agent =>
      this._streamAgentResponse(agent, query, context, settings, sessionId)
    );

    yield* this._interleaveGenerators(generators);
  }

  /**
   * Stream response from a single agent
   */
  private async *_streamAgentResponse(
    agent: AgentConfig,
    query: string,
    context: ContextItem[],
    settings: Settings,
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const agentResponse = session.agentResponses.get(agent.id)!;
    agentResponse.status = 'streaming';

    try {
      const stream = this._providerManager.sendMessageToProvider(
        agent.id,
        query,
        context,
        { ...settings, provider: agent.id, model: this._providerManager.getProviderDefaultModel(agent.id) },
        null,
        agent.persona,
        sessionId
      );

      let agentUsage: import('../types').UsageStats | undefined;
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) {
          agentResponse.content += chunk.content;
          yield {
            type: 'agent_text',
            agentId: agent.id,
            content: chunk.content
          };
        } else if (chunk.type === 'thinking' && chunk.content) {
          agentResponse.thinking = (agentResponse.thinking || '') + chunk.content;
          yield {
            type: 'agent_thinking',
            agentId: agent.id,
            content: chunk.content
          };
        } else if (chunk.type === 'done' && chunk.usage) {
          agentUsage = chunk.usage;
        } else if (chunk.type === 'error') {
          agentResponse.status = 'error';
          yield {
            type: 'agent_error',
            agentId: agent.id,
            content: chunk.content
          };
          return;
        }
      }

      agentResponse.status = 'complete';
      yield {
        type: 'agent_complete',
        agentId: agent.id,
        usage: agentUsage
      };

    } catch (error) {
      agentResponse.status = 'error';
      yield {
        type: 'agent_error',
        agentId: agent.id,
        content: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Stream a discussion response from an agent with role context
   */
  private async *_streamDiscussionResponse(
    agent: AgentConfig,
    prompt: string,
    context: ContextItem[],
    settings: Settings,
    sessionId: string,
    role: DiscussionRole,
    roundNumber: number
  ): AsyncGenerator<BrainstormStreamChunk> {
    try {
      const stream = this._providerManager.sendMessageToProvider(
        agent.id,
        prompt,
        context,
        { ...settings, provider: agent.id, model: this._providerManager.getProviderDefaultModel(agent.id) },
        null,
        agent.persona,
        sessionId
      );

      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) {
          yield {
            type: 'discussion_text',
            agentId: agent.id,
            content: chunk.content,
            discussionRole: role,
            roundNumber
          };
        }
      }

    } catch (error) {
      yield {
        type: 'discussion_error',
        agentId: agent.id,
        content: error instanceof Error ? error.message : 'Discussion error',
        discussionRole: role,
        roundNumber
      };
    }
  }

  /**
   * Run the synthesis phase with strategy-aware prompt
   */
  private async *_runSynthesisPhase(
    context: ContextItem[],
    settings: Settings,
    synthesisAgentId: AgentType,
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const synthesisPrompt = this._buildSynthesisPrompt(sessionId);

    console.log(`[Mysti] Brainstorm: Synthesis by ${synthesisAgentId}`);

    try {
      const stream = this._providerManager.sendMessageToProvider(
        synthesisAgentId,
        synthesisPrompt,
        context,
        { ...settings, provider: synthesisAgentId, model: this._providerManager.getProviderDefaultModel(synthesisAgentId) },
        null,
        undefined,
        sessionId
      );

      let synthesis = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) {
          synthesis += chunk.content;
          yield {
            type: 'synthesis_text',
            content: chunk.content
          };
        }
      }

      session.unifiedSolution = synthesis;
    } catch (error) {
      // Synthesis fallback: try the other agent
      console.warn(`[Mysti] Brainstorm: Synthesis agent ${synthesisAgentId} failed, trying fallback`);
      const fallbackAgent = session.agents.find(a => a.id !== synthesisAgentId);
      if (fallbackAgent) {
        try {
          const fallbackStream = this._providerManager.sendMessageToProvider(
            fallbackAgent.id,
            synthesisPrompt,
            context,
            { ...settings, provider: fallbackAgent.id, model: this._providerManager.getProviderDefaultModel(fallbackAgent.id) },
            null,
            undefined,
            sessionId
          );

          let synthesis = '';
          for await (const chunk of fallbackStream) {
            if (chunk.type === 'text' && chunk.content) {
              synthesis += chunk.content;
              yield { type: 'synthesis_text', content: chunk.content };
            }
          }
          session.unifiedSolution = synthesis;
          return;
        } catch {
          // Both failed
        }
      }

      // Last resort: concatenate individual analyses
      const analyses = Array.from(session.agentResponses.entries())
        .filter(([, r]) => r.status === 'complete')
        .map(([id, r]) => {
          const agent = session.agents.find(a => a.id === id);
          return `## ${agent?.displayName || id}'s Analysis\n\n${r.content}`;
        })
        .join('\n\n---\n\n');

      const fallbackContent = `*Synthesis unavailable — individual analyses below:*\n\n${analyses}`;
      session.unifiedSolution = fallbackContent;
      yield { type: 'synthesis_text', content: fallbackContent };
    }
  }

  // ============================================================================
  // Structured Prompt Builders
  // ============================================================================

  /**
   * Debate: Structured critique prompt
   */
  private _buildDebateCritiquePrompt(agentId: AgentType, sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;
    const otherResponses = Array.from(session.agentResponses.entries())
      .filter(([id]) => id !== agentId)
      .map(([id, response]) => {
        const agent = session.agents.find(a => a.id === id);
        return `## ${agent?.displayName || id}'s Analysis\n\n${response.content}`;
      })
      .join('\n\n---\n\n');

    return `# Structured Critique

You are reviewing another agent's analysis of a coding/technical problem. Your task is NOT to generally "provide thoughts" but to perform a focused, structured critique that drives toward a better solution.

## Original Query

${session.query}

## Analysis to Critique

${otherResponses}

## Required Response Format

### Points of Agreement
For each point you agree with, state WHY it is correct and what evidence or reasoning supports it. Be specific.

### Points of Disagreement
For each point you disagree with:
1. Quote the specific claim
2. Explain why it is wrong, incomplete, or suboptimal
3. Provide your alternative with reasoning

### Unexamined Assumptions
List assumptions the analysis makes without justification. For each, explain why it matters.

### Missing Considerations
Important aspects of the original query that were not addressed.

### Revised Recommendation
Given your critique, provide your updated recommendation. Be concrete and actionable.`;
  }

  /**
   * Debate: Rebuttal prompt (respond to critique)
   */
  private _buildDebateRebuttalPrompt(agentId: AgentType, round: number, sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;
    const lastRound = session.discussionRounds[session.discussionRounds.length - 1];
    const otherCritiques = Array.from(lastRound.contributions.entries())
      .filter(([id]) => id !== agentId)
      .map(([id, content]) => {
        const agent = session.agents.find(a => a.id === id);
        return `## ${agent?.displayName || id}'s Critique\n\n${content}`;
      })
      .join('\n\n---\n\n');

    const myOriginal = session.agentResponses.get(agentId);

    return `# Rebuttal - Round ${round}

You previously provided an analysis that was critiqued by another agent. Review their critique and respond.

## Original Query

${session.query}

## Your Original Analysis

${myOriginal?.content || '(not available)'}

## Critique Received

${otherCritiques}

## Required Response Format

### Conceded Points
Points from the critique you accept. For each, explain how your recommendation changes.

### Defended Points
Points you maintain are correct. Provide additional evidence or reasoning.

### Refined Recommendation
Your updated recommendation incorporating valid critique points. Be concrete.`;
  }

  /**
   * Red Team: Challenger prompt
   */
  private _buildRedTeamChallengePrompt(proposerAgentId: AgentType, sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;
    const proposerResponse = session.agentResponses.get(proposerAgentId);
    const proposerAgent = session.agents.find(a => a.id === proposerAgentId);

    return `# Red Team Challenge

Your role is to find every flaw, risk, and weakness in the proposed solution. You are NOT providing an alternative — you are stress-testing this one.

## Original Query

${session.query}

## ${proposerAgent?.displayName || proposerAgentId}'s Proposed Solution

${proposerResponse?.content || '(not available)'}

## Required Response Format

### Security & Safety Risks
Identify security vulnerabilities, data exposure risks, or safety issues.

### Edge Cases & Failure Modes
What inputs, states, or conditions would break this solution?

### Scalability Concerns
What happens at 10x or 100x scale?

### Maintenance Burden
What will be painful to maintain, test, or debug over time?

### Missing Requirements
What did the original query ask for that this solution does not address?

### Issue Summary
For each issue found, rate severity:
- **CRITICAL** — Must fix before proceeding
- **MAJOR** — Should fix, significant risk
- **MINOR** — Nice to fix, low risk`;
  }

  /**
   * Red Team: Defense prompt
   */
  private _buildRedTeamDefensePrompt(proposerAgentId: AgentType, challengerAgentId: AgentType, sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;
    const proposerResponse = session.agentResponses.get(proposerAgentId);
    const challengeRound = session.discussionRounds[session.discussionRounds.length - 1];
    const challengeContent = challengeRound?.contributions.get(challengerAgentId) || '';
    const challengerAgent = session.agents.find(a => a.id === challengerAgentId);

    return `# Defense & Revision

Your proposed solution was challenged. Address each challenge point and revise your solution where the challenger has valid concerns.

## Original Query

${session.query}

## Your Original Solution

${proposerResponse?.content || '(not available)'}

## ${challengerAgent?.displayName || challengerAgentId}'s Challenges

${challengeContent}

## Required Response Format

### Accepted Challenges
For each valid challenge, explain how you'll address it in the revised solution.

### Rejected Challenges
For each challenge you believe is invalid, explain why with evidence.

### Revised Solution
Your updated solution incorporating the valid challenges. Mark what changed from the original.`;
  }

  /**
   * Perspectives: Risk analysis lens prompt
   */
  private _buildPerspectivesRiskPrompt(query: string): string {
    return `# Risk & Correctness Analysis

Analyze the following query through the lens of **what could go wrong**. Your job is to be the team's safety net — identify every risk, edge case, and potential failure mode.

## Query

${query}

## Focus Areas

Analyze each area that applies:
- **Error handling and edge cases** — What inputs or states could cause failures?
- **Security implications** — Are there vulnerabilities, injection risks, or data exposure?
- **Performance bottlenecks** — What operations could be slow at scale?
- **Backward compatibility risks** — Could this break existing functionality?
- **Testing gaps** — What's hard to test or likely to be missed?
- **Operational concerns** — Deployment risks, monitoring needs, rollback strategies

## Required Format

For each risk identified:
1. **Risk**: Clear description
2. **Severity**: High / Medium / Low
3. **Likelihood**: High / Medium / Low
4. **Mitigation**: How to address it

End with a **Risk Summary** ranking the top 3 risks by severity.`;
  }

  /**
   * Perspectives: Innovation/opportunity lens prompt
   */
  private _buildPerspectivesInnovatorPrompt(query: string): string {
    return `# Opportunity & Innovation Analysis

Analyze the following query through the lens of **maximum value and creative solutions**. Your job is to push the team toward the best possible outcome — find novel approaches, quick wins, and future-proofing opportunities.

## Query

${query}

## Focus Areas

Explore each area that applies:
- **Novel approaches** — Simpler or more elegant ways to solve the problem
- **Extensibility** — How to design for easy future changes
- **Developer experience** — How to make this pleasant to work with
- **Performance optimizations** — Opportunities to make it faster or more efficient
- **Patterns from other domains** — Solutions from elsewhere that apply here
- **Quick wins** — High-impact changes with low effort

## Required Format

For each opportunity identified:
1. **Opportunity**: Clear description
2. **Impact**: High / Medium / Low
3. **Effort**: High / Medium / Low
4. **Approach**: How to implement it

End with a **Recommendation** highlighting the top 3 opportunities by impact-to-effort ratio.`;
  }

  /**
   * Perspectives: Cross-review prompt
   */
  private _buildPerspectivesCrossReviewPrompt(
    reviewerAgentId: AgentType,
    otherAgentId: AgentType,
    role: DiscussionRole,
    sessionId: string
  ): string {
    const session = this._panelSessions.get(sessionId)!;
    const otherResponse = session.agentResponses.get(otherAgentId);
    const otherAgent = session.agents.find(a => a.id === otherAgentId);
    const myResponse = session.agentResponses.get(reviewerAgentId);

    const perspective = role === 'risk-analyst'
      ? 'You focused on risks. Now review the opportunity analysis and identify where innovation ideas should be tempered by risk concerns, or where risks you identified are already mitigated by the proposed approaches.'
      : 'You focused on opportunities. Now review the risk analysis and identify where risks are overstated, where your proposed approaches already mitigate concerns, or where risk concerns reveal important constraints for your recommendations.';

    return `# Cross-Review: ${role === 'risk-analyst' ? 'Risk Analyst Reviews Opportunities' : 'Innovator Reviews Risks'}

${perspective}

## Original Query

${session.query}

## Your Analysis

${myResponse?.content || '(not available)'}

## ${otherAgent?.displayName || otherAgentId}'s Analysis

${otherResponse?.content || '(not available)'}

## Required Response Format

### Where Their Analysis Strengthens Yours
Points from the other perspective that complement or validate your findings.

### Where Risk and Opportunity Conflict
Tensions between risk concerns and innovation ideas. For each, suggest a balanced path.

### Revised Priorities
Your updated top 3 priorities considering both perspectives.`;
  }

  /**
   * Delphi: Facilitator summary prompt
   */
  private _buildDelphiFacilitatorPrompt(round: number, sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;

    // For round 1, summarize individual responses. For later rounds, summarize refinements.
    let analysesToSummarize: string;
    if (round === 1) {
      analysesToSummarize = Array.from(session.agentResponses.entries())
        .filter(([, r]) => r.status === 'complete')
        .map(([, r]) => r.content)
        .join('\n\n---\n\n');
    } else {
      // Use latest refinement round
      const lastRefinement = session.discussionRounds[session.discussionRounds.length - 1];
      analysesToSummarize = lastRefinement
        ? Array.from(lastRefinement.contributions.values()).join('\n\n---\n\n')
        : '';
    }

    return `# Facilitator Summary - Round ${round}

You are an impartial facilitator summarizing the team's analyses. Do NOT add your own opinion or recommendations. Your job is to clearly identify where the team agrees, where they diverge, and what questions remain.

## Original Query

${session.query}

## Team Analyses

${analysesToSummarize}

## Required Response Format

### Consensus Points
What do both agents agree on? For each point, rate confidence:
- **Strong** — Both agents explicitly agree with similar reasoning
- **Moderate** — Both suggest similar approaches but with different rationale
- **Tentative** — Implied agreement, not explicitly stated

### Divergence Points
Where do the agents disagree? For each:
1. **Position A**: ...
2. **Position B**: ...
3. **Key tension**: Why this disagreement matters

### Open Questions
Questions that, if answered, would help resolve the divergences.

### Convergence Score: ?/10
Rate how aligned the agents are (1 = completely opposed, 10 = near-identical).`;
  }

  /**
   * Delphi: Agent refinement prompt
   */
  private _buildDelphiRefinePrompt(
    agentId: AgentType,
    facilitatorSummary: string,
    round: number,
    sessionId: string
  ): string {
    const session = this._panelSessions.get(sessionId)!;
    const myResponse = session.agentResponses.get(agentId);

    return `# Refinement - Round ${round}

A facilitator has summarized the team's analyses. Review the summary and refine your recommendation. You should move toward consensus where the facilitator identified strong agreement, and clarify your position where divergences exist.

## Original Query

${session.query}

## Your Previous Analysis

${myResponse?.content || '(not available)'}

## Facilitator Summary

${facilitatorSummary}

## Required Response Format

### Position Changes
For each point where you changed your position, explain what convinced you.

### Maintained Positions
For divergences where you maintain your position, provide additional reasoning.

### Refined Recommendation
Your updated recommendation incorporating insights from the facilitator summary.`;
  }

  /**
   * Build the strategy-aware synthesis prompt
   */
  private _buildSynthesisPrompt(sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;
    const agentAnalyses = Array.from(session.agentResponses.entries())
      .filter(([, r]) => r.status === 'complete')
      .map(([id, response]) => {
        const agent = session.agents.find(a => a.id === id);
        return `## ${agent?.displayName || id}'s Analysis\n\n${response.content}`;
      })
      .join('\n\n---\n\n');

    const discussions = session.discussionRounds
      .map(round => {
        const roleInfo = round.roleAssignments.size > 0
          ? Array.from(round.roleAssignments.entries())
              .map(([id, role]) => {
                const agent = session.agents.find(a => a.id === id);
                return `${agent?.displayName || id}: ${role}`;
              })
              .join(', ')
          : '';

        const contributions = Array.from(round.contributions.entries())
          .map(([id, content]) => {
            const agent = session.agents.find(a => a.id === id);
            const role = round.roleAssignments.get(id);
            const roleLabel = role ? ` (${role})` : '';
            return `**${agent?.displayName || id}${roleLabel}:**\n\n${content}`;
          })
          .join('\n\n');
        return `### Round ${round.roundNumber}${roleInfo ? ` — ${roleInfo}` : ''}\n\n${contributions}`;
      })
      .join('\n\n');

    // Convergence status
    let convergenceInfo = '';
    if (session.convergenceHistory.length > 0) {
      const latest = session.convergenceHistory[session.convergenceHistory.length - 1];
      convergenceInfo = `\n## Convergence Status: ${latest.recommendation.toUpperCase()}\nOverall convergence: ${Math.round(latest.overallConvergence * 100)}%\n`;
      if (latest.recommendation === 'stalled') {
        convergenceInfo += `The agents were unable to reach full consensus. Pay special attention to unresolved disagreements.\n`;
      }
    }

    // Strategy-specific synthesis instructions
    const strategyLabel: Record<CollaborationStrategy, string> = {
      'quick': 'Quick Synthesis',
      'debate': 'Structured Debate',
      'red-team': 'Red Team Analysis',
      'perspectives': 'Dual Perspective Analysis',
      'delphi': 'Delphi Convergence'
    };

    let prompt = `# Synthesis: Final Team Recommendation\n\n`;
    prompt += `You are synthesizing a **${strategyLabel[session.strategy]}** multi-agent collaboration session. `;
    prompt += `Your job is not merely to merge — it is to produce a recommendation BETTER than any individual agent's.\n\n`;
    prompt += `## Original Query\n\n${session.query}\n\n`;
    prompt += `## Agent Analyses\n\n${agentAnalyses}\n\n`;

    if (discussions) {
      prompt += `## Team Discussion\n\n${discussions}\n\n`;
    }

    if (convergenceInfo) {
      prompt += convergenceInfo + '\n';
    }

    prompt += `## Required Response Format\n\n`;
    prompt += `### Executive Summary\nOne paragraph: what should be done and why.\n\n`;
    prompt += `### Agreed Approach\nWhat the team converged on. Reference specific points from both agents.\n\n`;
    prompt += `### Resolved Disagreements\nFor each disagreement resolved during discussion:\n`;
    prompt += `- The tension\n- Resolution\n- Why this resolution is correct\n\n`;
    prompt += `### Unresolved Disagreements\nFor each persistent disagreement:\n`;
    prompt += `- Both positions\n- Recommended path with explicit tradeoff acknowledgment\n\n`;
    prompt += `### Implementation Plan\nConcrete steps, ordered by priority.\n\n`;
    prompt += `### Risk Mitigations\nKey risks identified during discussion and how to address them.`;

    return prompt;
  }

  // ============================================================================
  // Convergence Assessment
  // ============================================================================

  /**
   * Assess convergence after a discussion round using heuristic analysis
   */
  private _assessConvergence(sessionId: string, round: number): ConvergenceMetrics {
    const session = this._panelSessions.get(sessionId)!;
    const lastRound = session.discussionRounds[session.discussionRounds.length - 1];

    let agreementCount = 0;
    let disagreementCount = 0;
    const positionStability = new Map<AgentType, number>();

    if (lastRound) {
      for (const [agentId, contribution] of lastRound.contributions.entries()) {
        const lower = contribution.toLowerCase();

        // Count agreement/disagreement signals
        const agreePatterns = [/\bagree\b/g, /\bconcede\b/g, /\bvalid point\b/g, /\bcorrect\b/g, /\baccept\b/g, /\bwell-taken\b/g];
        const disagreePatterns = [/\bdisagree\b/g, /\bhowever\b/g, /\bincorrect\b/g, /\bwrong\b/g, /\breject\b/g, /\bmaintain\b/g, /\bdefend\b/g];

        for (const pattern of agreePatterns) {
          const matches = lower.match(pattern);
          if (matches) {agreementCount += matches.length;}
        }
        for (const pattern of disagreePatterns) {
          const matches = lower.match(pattern);
          if (matches) {disagreementCount += matches.length;}
        }

        // Position stability: compare with previous round contribution
        if (session.discussionRounds.length >= 2) {
          const prevRound = session.discussionRounds[session.discussionRounds.length - 2];
          const prevContribution = prevRound.contributions.get(agentId);
          if (prevContribution) {
            positionStability.set(agentId, this._calculateTextSimilarity(prevContribution, contribution));
          }
        }
      }
    }

    const total = agreementCount + disagreementCount;
    const agreementRatio = total > 0 ? agreementCount / total : 0.5;

    const stabilityValues = Array.from(positionStability.values());
    const avgStability = stabilityValues.length > 0
      ? stabilityValues.reduce((a, b) => a + b, 0) / stabilityValues.length
      : 0.5;

    const overallConvergence = (agreementRatio * 0.6) + (avgStability * 0.4);

    let recommendation: 'continue' | 'converged' | 'stalled' = 'continue';
    if (agreementRatio >= 0.7 && avgStability >= 0.8) {
      recommendation = 'converged';
    } else if (session.convergenceHistory.length >= 2) {
      const prevConvergence = session.convergenceHistory[session.convergenceHistory.length - 1];
      if (prevConvergence.overallConvergence >= overallConvergence && avgStability < 0.3) {
        recommendation = 'stalled';
      }
    }

    return {
      round,
      agreementCount,
      disagreementCount,
      agreementRatio,
      positionStability,
      overallConvergence,
      recommendation
    };
  }

  /**
   * Simple text similarity using word overlap (Jaccard-like)
   */
  private _calculateTextSimilarity(textA: string, textB: string): number {
    const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    if (wordsA.size === 0 && wordsB.size === 0) {return 1;}
    if (wordsA.size === 0 || wordsB.size === 0) {return 0;}

    let intersection = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) {intersection++;}
    }

    return intersection / Math.max(wordsA.size, wordsB.size);
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Get list of agents that completed the individual phase successfully
   */
  private _getCompleteAgents(sessionId: string): AgentType[] {
    const session = this._panelSessions.get(sessionId)!;
    return Array.from(session.agentResponses.entries())
      .filter(([, r]) => r.status === 'complete')
      .map(([id]) => id);
  }

  /**
   * Interleave chunks from multiple async generators
   * Uses result queue to capture all completions and prevent race condition data loss
   */
  private async *_interleaveGenerators(
    generators: AsyncGenerator<BrainstormStreamChunk>[]
  ): AsyncGenerator<BrainstormStreamChunk> {
    type IteratorType = AsyncIterator<BrainstormStreamChunk>;
    type ResultType = { iterator: IteratorType; result: IteratorResult<BrainstormStreamChunk> };

    const iterators = generators.map(g => g[Symbol.asyncIterator]());
    const active = new Set<IteratorType>(iterators);

    // Queue to store completed results (prevents race condition data loss)
    const resultQueue: ResultType[] = [];

    // Start all iterators
    const pending = new Map<IteratorType, Promise<ResultType>>();
    for (const iterator of iterators) {
      const promise = iterator.next()
        .then(result => ({ iterator, result }))
        .then(r => {
          resultQueue.push(r);
          return r;
        });
      pending.set(iterator, promise);
    }

    while (active.size > 0) {
      const activePending = Array.from(active)
        .filter(it => pending.has(it))
        .map(it => pending.get(it)!);

      if (activePending.length === 0) {break;}

      await Promise.race(activePending);

      while (resultQueue.length > 0) {
        const { iterator, result } = resultQueue.shift()!;
        pending.delete(iterator);

        if (result.done) {
          active.delete(iterator);
        } else {
          yield result.value;
          const promise = iterator.next()
            .then(r => ({ iterator, result: r }))
            .then(r => {
              resultQueue.push(r);
              return r;
            });
          pending.set(iterator, promise);
        }
      }
    }
  }

  /**
   * Cancel the brainstorm session for a specific panel
   */
  public cancelSession(panelId?: string): void {
    const sessionId = panelId || 'default';
    const session = this._panelSessions.get(sessionId);
    if (session) {
      console.log('[Mysti] Brainstorm: Cancelling session for panel', sessionId);
      this._providerManager.cancelRequest(sessionId);
      session.phase = 'complete';
    }
  }

  /**
   * Clear the session for a specific panel
   */
  public clearSession(panelId?: string): void {
    const sessionId = panelId || 'default';
    this._panelSessions.delete(sessionId);
  }
}
