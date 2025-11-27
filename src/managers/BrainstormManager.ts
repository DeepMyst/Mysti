import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { ProviderManager } from './ProviderManager';
import type { PersonaConfig } from '../providers/base/IProvider';
import type {
  ContextItem,
  Settings,
  AgentType,
  AgentConfig,
  AgentResponse,
  BrainstormSession,
  BrainstormStreamChunk,
  BrainstormPhase,
  DiscussionMode,
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
  }
};

/**
 * BrainstormManager - Orchestrates multi-agent collaboration
 */
export class BrainstormManager {
  private _extensionContext: vscode.ExtensionContext;
  private _providerManager: ProviderManager;
  private _currentSession: BrainstormSession | null = null;

  constructor(context: vscode.ExtensionContext, providerManager: ProviderManager) {
    this._extensionContext = context;
    this._providerManager = providerManager;
  }

  /**
   * Get brainstorm configuration from settings
   */
  private _getConfig(): {
    discussionMode: DiscussionMode;
    discussionRounds: number;
    synthesisAgent: AgentType;
    agents: AgentType[];
  } {
    const config = vscode.workspace.getConfiguration('mysti');
    return {
      discussionMode: config.get<DiscussionMode>('brainstorm.discussionMode', 'quick'),
      discussionRounds: config.get<number>('brainstorm.discussionRounds', 1),
      synthesisAgent: config.get<AgentType>('brainstorm.synthesisAgent', 'claude-code'),
      agents: ['claude-code', 'openai-codex'] as AgentType[] // Default to both agents
    };
  }

  /**
   * Get persona configuration for an agent
   */
  private _getPersonaConfig(agentId: AgentType): PersonaConfig {
    const config = vscode.workspace.getConfiguration('mysti');
    const agentKey = agentId === 'claude-code' ? 'claude' : 'codex';

    const personaType = config.get<PersonaType>(`agents.${agentKey}Persona`, 'neutral');
    const customPrompt = config.get<string>(`agents.${agentKey}CustomPrompt`, '');

    return {
      type: personaType,
      customPrompt: personaType === 'custom' ? customPrompt : undefined
    };
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
   * Get the current brainstorm session
   */
  public getCurrentSession(): BrainstormSession | null {
    return this._currentSession;
  }

  /**
   * Check if a brainstorm session is active
   */
  public isSessionActive(): boolean {
    return this._currentSession !== null &&
           this._currentSession.phase !== 'complete';
  }

  /**
   * Start a new brainstorm session
   */
  public async *startBrainstormSession(
    query: string,
    context: ContextItem[],
    settings: Settings
  ): AsyncGenerator<BrainstormStreamChunk> {
    const brainstormConfig = this._getConfig();
    const agentConfigs = this._buildAgentConfigs(brainstormConfig.agents);

    // Create new session
    this._currentSession = {
      id: uuidv4(),
      query,
      phase: 'initial',
      agents: agentConfigs,
      agentResponses: new Map(),
      discussionRounds: [],
      unifiedSolution: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    console.log('[Mysti] Brainstorm: Starting session', this._currentSession.id);

    try {
      // Phase 1: Individual Analysis (parallel)
      yield { type: 'phase_change', phase: 'individual' };
      this._currentSession.phase = 'individual';
      yield* this._runIndividualPhase(query, context, settings);

      // Phase 2: Discussion (only in full mode)
      if (brainstormConfig.discussionMode === 'full') {
        yield { type: 'phase_change', phase: 'discussion' };
        this._currentSession.phase = 'discussion';
        yield* this._runDiscussionPhase(context, settings, brainstormConfig.discussionRounds);
      }

      // Phase 3: Synthesis
      yield { type: 'phase_change', phase: 'synthesis' };
      this._currentSession.phase = 'synthesis';
      yield* this._runSynthesisPhase(context, settings, brainstormConfig.synthesisAgent);

      // Complete
      yield { type: 'phase_change', phase: 'complete' };
      this._currentSession.phase = 'complete';
      yield { type: 'done' };

    } catch (error) {
      console.error('[Mysti] Brainstorm: Error in session', error);
      yield {
        type: 'agent_error',
        content: error instanceof Error ? error.message : 'Unknown error in brainstorm session'
      };
    }
  }

  /**
   * Run the individual analysis phase - agents analyze in parallel
   */
  private async *_runIndividualPhase(
    query: string,
    context: ContextItem[],
    settings: Settings
  ): AsyncGenerator<BrainstormStreamChunk> {
    const agents = this._currentSession!.agents;

    // Create response tracking for each agent
    for (const agent of agents) {
      this._currentSession!.agentResponses.set(agent.id, {
        agentId: agent.id,
        content: '',
        status: 'pending',
        timestamp: Date.now()
      });
    }

    // Run agents in parallel using interleaved streaming
    const generators = agents.map(agent =>
      this._streamAgentResponse(agent, query, context, settings)
    );

    // Interleave responses from all agents
    yield* this._interleaveGenerators(generators);
  }

  /**
   * Stream response from a single agent
   */
  private async *_streamAgentResponse(
    agent: AgentConfig,
    query: string,
    context: ContextItem[],
    settings: Settings
  ): AsyncGenerator<BrainstormStreamChunk> {
    const agentResponse = this._currentSession!.agentResponses.get(agent.id)!;
    agentResponse.status = 'streaming';

    try {
      const stream = this._providerManager.sendMessageToProvider(
        agent.id,
        query,
        context,
        { ...settings, provider: agent.id },
        null,
        agent.persona
      );

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
        agentId: agent.id
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
   * Run the discussion phase - agents review each other's responses
   */
  private async *_runDiscussionPhase(
    context: ContextItem[],
    settings: Settings,
    rounds: number
  ): AsyncGenerator<BrainstormStreamChunk> {
    const agents = this._currentSession!.agents;

    for (let round = 1; round <= rounds; round++) {
      console.log(`[Mysti] Brainstorm: Discussion round ${round}`);

      const contributions = new Map<AgentType, string>();

      for (const agent of agents) {
        // Build review prompt with other agents' responses
        const reviewPrompt = this._buildReviewPrompt(agent.id, round);

        const stream = this._providerManager.sendMessageToProvider(
          agent.id,
          reviewPrompt,
          context,
          { ...settings, provider: agent.id },
          null,
          agent.persona
        );

        let contribution = '';
        for await (const chunk of stream) {
          if (chunk.type === 'text' && chunk.content) {
            contribution += chunk.content;
            yield {
              type: 'discussion_text',
              agentId: agent.id,
              content: chunk.content
            };
          }
        }

        contributions.set(agent.id, contribution);
      }

      this._currentSession!.discussionRounds.push({
        roundNumber: round,
        contributions
      });
    }
  }

  /**
   * Build a review prompt for an agent to review others' responses
   */
  private _buildReviewPrompt(agentId: AgentType, round: number): string {
    const otherResponses = Array.from(this._currentSession!.agentResponses.entries())
      .filter(([id]) => id !== agentId)
      .map(([id, response]) => {
        const agent = this._currentSession!.agents.find(a => a.id === id);
        return `## ${agent?.displayName || id}'s Analysis\n\n${response.content}`;
      })
      .join('\n\n---\n\n');

    const previousRounds = this._currentSession!.discussionRounds
      .filter(r => r.roundNumber < round)
      .map(r => {
        const contributions = Array.from(r.contributions.entries())
          .map(([id, content]) => {
            const agent = this._currentSession!.agents.find(a => a.id === id);
            return `**${agent?.displayName || id}:** ${content}`;
          })
          .join('\n\n');
        return `### Round ${r.roundNumber}\n\n${contributions}`;
      })
      .join('\n\n');

    let prompt = `# Discussion Round ${round}\n\n`;
    prompt += `You are participating in a collaborative brainstorm session. `;
    prompt += `Review the following analyses from other agents and provide your thoughts, agreements, disagreements, or additional insights.\n\n`;
    prompt += `## Original Query\n\n${this._currentSession!.query}\n\n`;
    prompt += `## Other Agents' Analyses\n\n${otherResponses}\n\n`;

    if (previousRounds) {
      prompt += `## Previous Discussion\n\n${previousRounds}\n\n`;
    }

    prompt += `Please provide your review and any additional insights. Be constructive and focus on synthesizing the best ideas.`;

    return prompt;
  }

  /**
   * Run the synthesis phase - combine all responses into a unified solution
   */
  private async *_runSynthesisPhase(
    context: ContextItem[],
    settings: Settings,
    synthesisAgentId: AgentType
  ): AsyncGenerator<BrainstormStreamChunk> {
    const synthesisPrompt = this._buildSynthesisPrompt();

    console.log(`[Mysti] Brainstorm: Synthesis by ${synthesisAgentId}`);

    const stream = this._providerManager.sendMessageToProvider(
      synthesisAgentId,
      synthesisPrompt,
      context,
      { ...settings, provider: synthesisAgentId },
      null
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

    this._currentSession!.unifiedSolution = synthesis;
  }

  /**
   * Build the synthesis prompt from all agent responses and discussions
   */
  private _buildSynthesisPrompt(): string {
    const agentAnalyses = Array.from(this._currentSession!.agentResponses.entries())
      .map(([id, response]) => {
        const agent = this._currentSession!.agents.find(a => a.id === id);
        return `## ${agent?.displayName || id}'s Analysis\n\n${response.content}`;
      })
      .join('\n\n---\n\n');

    const discussions = this._currentSession!.discussionRounds
      .map(round => {
        const contributions = Array.from(round.contributions.entries())
          .map(([id, content]) => {
            const agent = this._currentSession!.agents.find(a => a.id === id);
            return `**${agent?.displayName || id}:** ${content}`;
          })
          .join('\n\n');
        return `### Discussion Round ${round.roundNumber}\n\n${contributions}`;
      })
      .join('\n\n');

    let prompt = `# Synthesis Task\n\n`;
    prompt += `You are synthesizing the results of a multi-agent brainstorm session. `;
    prompt += `Create a unified solution that incorporates the best ideas from all agents.\n\n`;
    prompt += `## Original Query\n\n${this._currentSession!.query}\n\n`;
    prompt += `## Agent Analyses\n\n${agentAnalyses}\n\n`;

    if (discussions) {
      prompt += `## Discussion\n\n${discussions}\n\n`;
    }

    prompt += `## Your Task\n\n`;
    prompt += `Create a unified, comprehensive solution that:\n`;
    prompt += `1. Incorporates the strongest ideas from each agent\n`;
    prompt += `2. Addresses any conflicts or disagreements thoughtfully\n`;
    prompt += `3. Provides a clear, actionable recommendation\n\n`;
    prompt += `Present your unified solution:`;

    return prompt;
  }

  /**
   * Interleave chunks from multiple async generators
   */
  private async *_interleaveGenerators(
    generators: AsyncGenerator<BrainstormStreamChunk>[]
  ): AsyncGenerator<BrainstormStreamChunk> {
    const iterators = generators.map(g => g[Symbol.asyncIterator]());
    const active = new Set(iterators);

    while (active.size > 0) {
      // Create promises for the next value from each active iterator
      const promises = Array.from(active).map(async (iterator) => {
        const result = await iterator.next();
        return { iterator, result };
      });

      // Wait for any one to complete
      const { iterator, result } = await Promise.race(promises);

      if (result.done) {
        active.delete(iterator);
      } else {
        yield result.value;
      }
    }
  }

  /**
   * Cancel the current brainstorm session
   */
  public cancelSession(): void {
    if (this._currentSession) {
      console.log('[Mysti] Brainstorm: Cancelling session', this._currentSession.id);
      this._providerManager.cancelCurrentRequest();
      this._currentSession.phase = 'complete';
    }
  }

  /**
   * Clear the current session
   */
  public clearSession(): void {
    this._currentSession = null;
  }
}
