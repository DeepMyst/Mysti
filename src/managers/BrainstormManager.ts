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
   * Get the current brainstorm session for a panel
   * @param panelId Optional panel ID (defaults to 'default')
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

  /**
   * Start a new brainstorm session
   * @param panelId Optional panel ID for per-panel session tracking
   */
  public async *startBrainstormSession(
    query: string,
    context: ContextItem[],
    settings: Settings,
    panelId?: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const sessionId = panelId || 'default';
    const brainstormConfig = this._getConfig();
    const agentConfigs = this._buildAgentConfigs(brainstormConfig.agents);

    // Create new session for this panel
    const session: BrainstormSession = {
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

    this._panelSessions.set(sessionId, session);

    console.log('[Mysti] Brainstorm: Starting session', session.id, 'for panel', sessionId);

    try {
      // Phase 1: Individual Analysis (parallel)
      yield { type: 'phase_change', phase: 'individual' };
      session.phase = 'individual';
      yield* this._runIndividualPhase(query, context, settings, sessionId);

      // Phase 2: Discussion (only in full mode)
      if (brainstormConfig.discussionMode === 'full') {
        yield { type: 'phase_change', phase: 'discussion' };
        session.phase = 'discussion';
        yield* this._runDiscussionPhase(context, settings, brainstormConfig.discussionRounds, sessionId);
      }

      // Phase 3: Synthesis
      yield { type: 'phase_change', phase: 'synthesis' };
      session.phase = 'synthesis';
      yield* this._runSynthesisPhase(context, settings, brainstormConfig.synthesisAgent, sessionId);

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
    settings: Settings,
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const agentResponse = session.agentResponses.get(agent.id)!;
    agentResponse.status = 'streaming';

    try {
      // Pass sessionId for per-panel process tracking
      const stream = this._providerManager.sendMessageToProvider(
        agent.id,
        query,
        context,
        { ...settings, provider: agent.id, model: this._providerManager.getProviderDefaultModel(agent.id) },
        null,
        agent.persona,
        sessionId
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
    rounds: number,
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const agents = session.agents;

    for (let round = 1; round <= rounds; round++) {
      console.log(`[Mysti] Brainstorm: Discussion round ${round}`);

      const contributions = new Map<AgentType, string>();

      for (const agent of agents) {
        // Build review prompt with other agents' responses
        const reviewPrompt = this._buildReviewPrompt(agent.id, round, sessionId);

        const stream = this._providerManager.sendMessageToProvider(
          agent.id,
          reviewPrompt,
          context,
          { ...settings, provider: agent.id, model: this._providerManager.getProviderDefaultModel(agent.id) },
          null,
          agent.persona,
          sessionId
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

      session.discussionRounds.push({
        roundNumber: round,
        contributions
      });
    }
  }

  /**
   * Build a review prompt for an agent to review others' responses
   */
  private _buildReviewPrompt(agentId: AgentType, round: number, sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;
    const otherResponses = Array.from(session.agentResponses.entries())
      .filter(([id]) => id !== agentId)
      .map(([id, response]) => {
        const agent = session.agents.find(a => a.id === id);
        return `## ${agent?.displayName || id}'s Analysis\n\n${response.content}`;
      })
      .join('\n\n---\n\n');

    const previousRounds = session.discussionRounds
      .filter(r => r.roundNumber < round)
      .map(r => {
        const contributions = Array.from(r.contributions.entries())
          .map(([id, content]) => {
            const agent = session.agents.find(a => a.id === id);
            return `**${agent?.displayName || id}:** ${content}`;
          })
          .join('\n\n');
        return `### Round ${r.roundNumber}\n\n${contributions}`;
      })
      .join('\n\n');

    let prompt = `# Discussion Round ${round}\n\n`;
    prompt += `You are participating in a collaborative brainstorm session. `;
    prompt += `Review the following analyses from other agents and provide your thoughts, agreements, disagreements, or additional insights.\n\n`;
    prompt += `## Original Query\n\n${session.query}\n\n`;
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
    synthesisAgentId: AgentType,
    sessionId: string
  ): AsyncGenerator<BrainstormStreamChunk> {
    const session = this._panelSessions.get(sessionId)!;
    const synthesisPrompt = this._buildSynthesisPrompt(sessionId);

    console.log(`[Mysti] Brainstorm: Synthesis by ${synthesisAgentId}`);

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
  }

  /**
   * Build the synthesis prompt from all agent responses and discussions
   */
  private _buildSynthesisPrompt(sessionId: string): string {
    const session = this._panelSessions.get(sessionId)!;
    const agentAnalyses = Array.from(session.agentResponses.entries())
      .map(([id, response]) => {
        const agent = session.agents.find(a => a.id === id);
        return `## ${agent?.displayName || id}'s Analysis\n\n${response.content}`;
      })
      .join('\n\n---\n\n');

    const discussions = session.discussionRounds
      .map(round => {
        const contributions = Array.from(round.contributions.entries())
          .map(([id, content]) => {
            const agent = session.agents.find(a => a.id === id);
            return `**${agent?.displayName || id}:** ${content}`;
          })
          .join('\n\n');
        return `### Discussion Round ${round.roundNumber}\n\n${contributions}`;
      })
      .join('\n\n');

    let prompt = `# Synthesis Task\n\n`;
    prompt += `You are synthesizing the results of a multi-agent brainstorm session. `;
    prompt += `Create a unified solution that incorporates the best ideas from all agents.\n\n`;
    prompt += `## Original Query\n\n${session.query}\n\n`;
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
   * Fixed: Track pending promises to avoid losing chunks when Promise.race returns
   */
  private async *_interleaveGenerators(
    generators: AsyncGenerator<BrainstormStreamChunk>[]
  ): AsyncGenerator<BrainstormStreamChunk> {
    type IteratorType = AsyncIterator<BrainstormStreamChunk>;
    type PromiseType = Promise<{ iterator: IteratorType; result: IteratorResult<BrainstormStreamChunk> }>;

    const iterators = generators.map(g => g[Symbol.asyncIterator]());
    const active = new Set<IteratorType>(iterators);
    const pending = new Map<IteratorType, PromiseType>();

    // Initialize pending promises for all iterators
    for (const iterator of iterators) {
      pending.set(iterator, iterator.next().then(result => ({ iterator, result })));
    }

    while (active.size > 0) {
      // Only race on active iterators that have pending promises
      const activePending = Array.from(active)
        .filter(it => pending.has(it))
        .map(it => pending.get(it)!);

      if (activePending.length === 0) break;

      const { iterator, result } = await Promise.race(activePending);

      // Remove from pending since it completed
      pending.delete(iterator);

      if (result.done) {
        active.delete(iterator);
      } else {
        yield result.value;
        // Create new pending promise for this iterator
        pending.set(iterator, iterator.next().then(r => ({ iterator, result: r })));
      }
    }
  }

  /**
   * Cancel the brainstorm session for a specific panel
   * @param panelId Optional panel ID (defaults to 'default')
   */
  public cancelSession(panelId?: string): void {
    const sessionId = panelId || 'default';
    const session = this._panelSessions.get(sessionId);
    if (session) {
      console.log('[Mysti] Brainstorm: Cancelling session for panel', sessionId);
      // Cancel the request for this specific panel
      this._providerManager.cancelRequest(sessionId);
      session.phase = 'complete';
    }
  }

  /**
   * Clear the session for a specific panel
   * @param panelId Optional panel ID (defaults to 'default')
   */
  public clearSession(panelId?: string): void {
    const sessionId = panelId || 'default';
    this._panelSessions.delete(sessionId);
  }
}
