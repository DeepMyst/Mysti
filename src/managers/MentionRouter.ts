/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProviderManager } from './ProviderManager';
import { SUBAGENT_TIMEOUT_MS, SUBAGENT_MAX_RETRIES } from '../constants';
import type {
  ContextItem,
  Settings,
  Conversation,
  Mention,
  MentionStreamChunk,
  MentionTask,
  MentionTaskList,
  SubAgentResponse,
  AgentType,
  AskUserQuestionData,
  SubAgentQuestionCallback
} from '../types';

/**
 * Agent display names for prompts and UI
 */
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude',
  'openai-codex': 'Codex',
  'google-gemini': 'Gemini',
  'cline': 'Cline',
  'github-copilot': 'Copilot',
  'cursor': 'Cursor',
  'openclaw': 'OpenClaw'
};

/**
 * MentionRouter - Handles @-mention parsing, task list generation, and sequential task execution
 *
 * Responsibilities:
 * 1. Resolve @file mentions into transient ContextItems
 * 2. Generate an ordered task list from @-mentions (heuristic + AI fallback)
 * 3. Execute tasks sequentially, each assigned to an agent (including the main provider)
 * 4. Yield MentionStreamChunk events for UI updates (task progress, tool_use/tool_result)
 * 5. Format sub-agent responses as context for the main agent
 */
export class MentionRouter {
  private _providerManager: ProviderManager;

  constructor(providerManager: ProviderManager) {
    this._providerManager = providerManager;
  }

  /**
   * Process all mentions in a message: resolve files, generate task list, execute tasks
   */
  public async *processMentions(
    content: string,
    mentions: Mention[],
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    panelId: string,
    onSubAgentQuestion?: SubAgentQuestionCallback
  ): AsyncGenerator<MentionStreamChunk> {
    // 1. Resolve file mentions into transient ContextItems
    const fileMentions = mentions.filter(m => m.type === 'file');
    const resolvedFiles = await this._resolveFileMentions(fileMentions);

    if (resolvedFiles.length > 0) {
      yield { type: 'files_resolved', resolvedFiles };
    }

    // 2. Generate task list for agent mentions
    const agentMentions = mentions.filter(m => m.type === 'agent');
    if (agentMentions.length === 0) {
      yield { type: 'main_start' };
      return;
    }

    let taskList = this._generateTaskListHeuristic(content, agentMentions, settings);
    if (!taskList || taskList.confidence < 0.7) {
      console.log('[Mysti] MentionRouter: Heuristic uncertain, falling back to AI task list generation');
      taskList = await this._generateTaskListWithAI(content, agentMentions, settings, panelId);
    }

    console.log(`[Mysti] MentionRouter: Generated ${taskList.tasks.length} task(s) (confidence: ${taskList.confidence})`);
    for (const task of taskList.tasks) {
      const displayName = AGENT_DISPLAY_NAMES[task.agent] || task.agent;
      console.log(`[Mysti]   Task ${task.order}: [${displayName}] ${task.taskType} - ${task.task}`);
    }

    // 3. Partition tasks: current provider tasks go to main agent, others are sub-agents
    const mainProviderTasks = taskList.tasks.filter(t => t.agent === settings.provider);
    const subAgentTasks = taskList.tasks.filter(t => t.agent !== settings.provider);

    if (mainProviderTasks.length > 0) {
      console.log(`[Mysti] MentionRouter: ${mainProviderTasks.length} task(s) for current provider (${settings.provider}) — will fold into main agent prompt`);
    }

    // Only show task list UI if there are sub-agent tasks
    if (subAgentTasks.length > 0) {
      yield { type: 'task_list_generated', taskList: { ...taskList, tasks: subAgentTasks } };
    }

    // 4. Execute sub-agent tasks in order
    const completedResponses = new Map<string, string>();

    for (const task of subAgentTasks.sort((a, b) => a.order - b.order)) {
      yield {
        type: 'task_started',
        taskIndex: task.order,
        agentId: task.agent,
        taskDescription: task.task
      };

      if (task.taskType === 'switch') {
        // Switch is handled inline by ChatViewProvider
        yield { type: 'task_complete', taskIndex: task.order, agentId: task.agent };
        yield { type: 'main_start' };
        return;
      }

      // Execute task
      try {
        yield* this._executeTask(
          task,
          [...context, ...resolvedFiles],
          settings,
          conversation,
          panelId,
          completedResponses,
          onSubAgentQuestion
        );
      } catch (error) {
        yield {
          type: 'subagent_error',
          agentId: task.agent,
          content: error instanceof Error ? error.message : 'Unknown error'
        };
        yield { type: 'subagent_complete', agentId: task.agent, hasError: true };
      }

      yield { type: 'task_complete', taskIndex: task.order, agentId: task.agent };
    }

    // 5. Yield main-provider tasks for the main agent to handle
    if (mainProviderTasks.length > 0) {
      yield { type: 'main_tasks', mainProviderTasks };
    }

    yield { type: 'main_start' };
  }

  /**
   * Format sub-agent responses as context for the main agent prompt
   */
  public formatSubAgentContext(responses: Map<AgentType, SubAgentResponse>): string {
    let contextBlock = '';
    const failedAgents: string[] = [];

    for (const [agentId, response] of responses) {
      if (response.status === 'complete' && response.content) {
        const displayName = AGENT_DISPLAY_NAMES[agentId] || agentId;
        contextBlock += `\n--- Sub-agent response from ${displayName} ---\n`;
        contextBlock += response.content;
        contextBlock += `\n--- End ${displayName} response ---\n`;
      } else if (response.status === 'error') {
        failedAgents.push(AGENT_DISPLAY_NAMES[agentId] || agentId);
      }
    }

    if (failedAgents.length > 0) {
      contextBlock += `\n[Note: ${failedAgents.join(', ')} sub-agent(s) failed. Please proceed with available information.]\n`;
    }

    return contextBlock;
  }

  /**
   * Strip @mention tokens from message content
   */
  public stripMentions(content: string, mentions: Mention[]): string {
    let result = content;
    const sorted = [...mentions].sort((a, b) => b.startIndex - a.startIndex);

    for (const m of sorted) {
      result = result.substring(0, m.startIndex) + result.substring(m.endIndex);
    }

    return result.replace(/\s+/g, ' ').trim();
  }

  /**
   * Cancel any running sub-agent processes for a panel
   */
  public cancelSubAgents(panelId: string, agentIds: AgentType[]): void {
    for (const agentId of agentIds) {
      const subAgentPanelId = `${panelId}-subagent-${agentId}`;
      this._providerManager.cancelRequest(subAgentPanelId);
    }
  }

  // ===========================================================================
  // Task List Generation
  // ===========================================================================

  /**
   * Fast heuristic-based task list generation (no AI call needed).
   * Returns null if uncertain — caller falls back to AI generation.
   */
  private _generateTaskListHeuristic(
    content: string,
    agentMentions: Mention[],
    settings: Settings
  ): MentionTaskList | null {
    const stripped = this.stripMentions(content, agentMentions).trim();
    const lowerStripped = stripped.toLowerCase();

    // Multiple agents → fall through to AI (needs decomposition)
    if (agentMentions.length >= 2) {
      return null;
    }

    const agentId = agentMentions[0].value as AgentType;

    // SWITCH patterns: "switch to @agent", "use @agent" (with no task)
    if (/^(switch\s+to|use)\s*$/i.test(stripped) ||
        /^(switch|change)\s+(to|the\s+provider)/i.test(lowerStripped)) {
      return {
        tasks: [{ agent: agentId, task: 'switch provider', taskType: 'switch', order: 0, dependsOnPrevious: false }],
        confidence: 0.95,
        originalContent: content,
        strippedContent: stripped
      };
    }

    // INFORMATIONAL patterns: "can @agent do X?" → route to main provider
    if (/^(can|does|is|will|would|could|should|what|how)\s/i.test(lowerStripped) &&
        stripped.endsWith('?')) {
      return {
        tasks: [{ agent: settings.provider as AgentType, task: stripped, taskType: 'execute', order: 0, dependsOnPrevious: false }],
        confidence: 0.85,
        originalContent: content,
        strippedContent: stripped
      };
    }

    // Single @agent with imperative content → direct execute
    const mentionAtStart = content.trimStart().startsWith('@');
    if (mentionAtStart && stripped.length > 0) {
      return {
        tasks: [{ agent: agentId, task: stripped, taskType: 'execute', order: 0, dependsOnPrevious: false }],
        confidence: 0.8,
        originalContent: content,
        strippedContent: stripped
      };
    }

    // Directive verbs: "ask @agent to...", "call @agent to..."
    const directVerbs = /^(ask|tell|have|get|let|call|invoke|run)\s/i;
    if (directVerbs.test(content.toLowerCase().replace(/@\S+\s*/g, '').trim())) {
      return {
        tasks: [{ agent: agentId, task: stripped, taskType: 'execute', order: 0, dependsOnPrevious: false }],
        confidence: 0.85,
        originalContent: content,
        strippedContent: stripped
      };
    }

    return null;
  }

  /**
   * AI-powered task list generation fallback.
   * Generates an ordered task list from the user message, potentially including
   * tasks for the current/main provider alongside tagged agents.
   */
  private async _generateTaskListWithAI(
    content: string,
    agentMentions: Mention[],
    settings: Settings,
    panelId: string
  ): Promise<MentionTaskList> {
    const mentionedAgents = agentMentions.map(m => {
      const displayName = AGENT_DISPLAY_NAMES[m.value] || m.value;
      return `${m.value} (${displayName})`;
    }).join(', ');

    const mainProvider = settings.provider;
    const mainDisplayName = AGENT_DISPLAY_NAMES[mainProvider] || mainProvider;

    const prompt = [
      'Generate an ordered task list for this user message containing @-mentions.',
      '',
      `Mentioned agents: ${mentionedAgents}`,
      `Current/main provider: ${mainProvider} (${mainDisplayName})`,
      `Message: "${content}"`,
      '',
      'Return ONLY a JSON array of tasks:',
      '[{"agent":"<agent-id>","task":"<task description>","taskType":"execute"|"switch","dependsOnPrevious":true|false}]',
      '',
      'Rules:',
      '- "execute": Agent performs the described task',
      '- "switch": Change active provider (only when user says "switch to" or "use X" with no task)',
      '- You may assign tasks to the current provider — use it for analysis, synthesis, implementation, or any step not specific to a tagged agent',
      '- Set dependsOnPrevious=true when a later task needs output from an earlier one',
      '- For questions ABOUT an agent (not tasking it), route to the current provider',
      '- Order tasks logically: analysis before improvement, review before refactor',
      '- Each task description should be self-contained and clear',
      '',
      `Available agent IDs: ${mainProvider}, ${agentMentions.map(m => m.value).join(', ')}`,
      'Return ONLY the JSON array:'
    ].join('\n');

    const taskGenPanelId = `${panelId}-taskgen`;
    let rawOutput = '';

    try {
      const stream = this._providerManager.sendMessageToProvider(
        settings.provider, prompt, [], settings, null, undefined, taskGenPanelId
      );
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) { rawOutput += chunk.content; }
        if (chunk.type === 'error') { break; }
      }

      const jsonMatch = rawOutput.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          agent: string;
          task: string;
          taskType: string;
          dependsOnPrevious?: boolean;
        }>;

        if (Array.isArray(parsed) && parsed.length > 0) {
          const stripped = this.stripMentions(content, agentMentions);
          return {
            tasks: parsed.map((item, index) => ({
              agent: item.agent as AgentType,
              task: item.task,
              taskType: (item.taskType === 'switch' ? 'switch' : 'execute') as 'execute' | 'switch',
              order: index,
              dependsOnPrevious: Boolean(item.dependsOnPrevious)
            })),
            confidence: 0.85,
            originalContent: content,
            strippedContent: stripped
          };
        }
      }
    } catch (error) {
      console.warn('[Mysti] MentionRouter: AI task list generation failed, using fallback', error);
    }

    // Fallback: single execute task to first mentioned agent
    const stripped = this.stripMentions(content, agentMentions);
    return {
      tasks: [{
        agent: agentMentions[0].value as AgentType,
        task: stripped,
        taskType: 'execute',
        order: 0,
        dependsOnPrevious: false
      }],
      confidence: 0.5,
      originalContent: content,
      strippedContent: stripped
    };
  }

  // ===========================================================================
  // Task Execution
  // ===========================================================================

  /**
   * Execute a single task: dispatch to the assigned agent with retry/timeout.
   * Yields streaming chunks for real-time UI updates.
   */
  private async *_executeTask(
    task: MentionTask,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    panelId: string,
    priorResponses: Map<string, string>,
    onSubAgentQuestion?: SubAgentQuestionCallback
  ): AsyncGenerator<MentionStreamChunk> {
    const agentId = task.agent;

    yield { type: 'subagent_started', agentId };

    // Check provider availability
    const providerStatus = await this._providerManager.getProviderStatus(agentId);
    if (providerStatus && !providerStatus.found) {
      const displayName = AGENT_DISPLAY_NAMES[agentId] || agentId;
      yield {
        type: 'subagent_error',
        agentId,
        content: `${displayName} CLI is not installed. ${providerStatus.installCommand ? 'Install with: ' + providerStatus.installCommand : 'See provider documentation.'}`
      };
      yield { type: 'subagent_complete', agentId, hasError: true };
      return;
    }

    // Build prompt from task description + prior context
    const promptParts: string[] = [];
    if (task.dependsOnPrevious && priorResponses.size > 0) {
      promptParts.push(this._formatPriorResponses(priorResponses));
    }
    if (conversation) {
      const summary = this._buildConversationSummary(conversation);
      if (summary) { promptParts.push(summary); }
    }
    promptParts.push(`Task: ${task.task}`);
    const fullPrompt = promptParts.join('\n\n---\n\n');

    // Dispatch with auto-retry and timeout
    const { responseText, hasError } = yield* this._dispatchWithRetry(
      agentId, fullPrompt, context, settings, panelId, onSubAgentQuestion
    );

    if (responseText) {
      priorResponses.set(agentId, responseText);
    }

    yield { type: 'subagent_complete', agentId, hasError };
  }

  /**
   * Dispatch a message to a sub-agent with timeout and auto-retry.
   * Yields streaming chunks (text, thinking, tool_use, tool_result, error).
   * Returns the accumulated response text and error state.
   */
  private async *_dispatchWithRetry(
    agentId: AgentType,
    prompt: string,
    context: ContextItem[],
    settings: Settings,
    panelId: string,
    onSubAgentQuestion?: SubAgentQuestionCallback
  ): AsyncGenerator<MentionStreamChunk, { responseText: string; hasError: boolean }> {
    let attempt = 0;
    let lastError: string | undefined;

    while (attempt <= SUBAGENT_MAX_RETRIES) {
      let hasError = false;
      let responseText = '';

      if (attempt > 0) {
        console.log(`[Mysti] MentionRouter: Retrying sub-agent ${agentId} (attempt ${attempt + 1})`);
        yield { type: 'subagent_retry', agentId, retryCount: attempt };
      }

      const subAgentPanelId = `${panelId}-subagent-${agentId}${attempt > 0 ? `-retry${attempt}` : ''}`;
      const subAgentSettings: Settings = {
        ...settings,
        provider: agentId,
        model: this._providerManager.getProviderDefaultModel(agentId)
      };

      try {
        const stream = this._providerManager.sendMessageToProvider(
          agentId,
          prompt,
          context,
          subAgentSettings,
          null,
          undefined,
          subAgentPanelId
        );

        // Set up timeout
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          this._providerManager.cancelRequest(subAgentPanelId);
        }, SUBAGENT_TIMEOUT_MS);

        try {
          for await (const chunk of stream) {
            if (timedOut) {
              hasError = true;
              lastError = `Sub-agent timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`;
              yield { type: 'subagent_error', agentId, content: lastError };
              break;
            }

            if (chunk.type === 'text' && chunk.content) {
              responseText += chunk.content;
              yield { type: 'subagent_text', agentId, content: chunk.content };
            } else if (chunk.type === 'thinking' && chunk.content) {
              yield { type: 'subagent_thinking', agentId, content: chunk.content };
            } else if (chunk.type === 'tool_use' && chunk.toolCall) {
              yield { type: 'subagent_tool_use', agentId, toolCall: chunk.toolCall };
            } else if (chunk.type === 'tool_result' && chunk.toolCall) {
              yield { type: 'subagent_tool_result', agentId, toolCall: chunk.toolCall };
            } else if (chunk.type === 'ask_user_question' && chunk.askUserQuestion) {
              if (onSubAgentQuestion) {
                // Yield question to UI so the sub-agent card shows "Waiting for answer..."
                yield {
                  type: 'subagent_ask_user_question',
                  agentId,
                  askUserQuestion: chunk.askUserQuestion
                };

                // Cancel the current process (CLI uses single-shot stdin, can't send answer back)
                clearTimeout(timeoutHandle);
                this._providerManager.cancelRequest(subAgentPanelId);

                // Wait for user's answer
                console.log(`[Mysti] MentionRouter: Sub-agent ${agentId} asked a question, waiting for user answer`);
                const userResponse = await onSubAgentQuestion(agentId, chunk.askUserQuestion);

                if (userResponse) {
                  // Format the answer and spawn a NEW sub-agent process with original task + answer
                  const answerText = this._formatQuestionAnswer(userResponse.answers);
                  const followUpPrompt = `${prompt}\n\n---\n\nUser answered your questions:\n${answerText}\n\nPlease continue with the task.`;
                  const followUpPanelId = `${subAgentPanelId}-followup`;

                  console.log(`[Mysti] MentionRouter: Resuming sub-agent ${agentId} with user's answers`);
                  const followUpStream = this._providerManager.sendMessageToProvider(
                    agentId, followUpPrompt, context, subAgentSettings, null, undefined, followUpPanelId
                  );

                  // Stream follow-up response
                  for await (const fChunk of followUpStream) {
                    if (fChunk.type === 'text' && fChunk.content) {
                      responseText += fChunk.content;
                      yield { type: 'subagent_text', agentId, content: fChunk.content };
                    } else if (fChunk.type === 'thinking' && fChunk.content) {
                      yield { type: 'subagent_thinking', agentId, content: fChunk.content };
                    } else if (fChunk.type === 'tool_use' && fChunk.toolCall) {
                      yield { type: 'subagent_tool_use', agentId, toolCall: fChunk.toolCall };
                    } else if (fChunk.type === 'tool_result' && fChunk.toolCall) {
                      yield { type: 'subagent_tool_result', agentId, toolCall: fChunk.toolCall };
                    } else if (fChunk.type === 'error') {
                      hasError = true;
                      yield { type: 'subagent_error', agentId, content: fChunk.content };
                      break;
                    }
                  }
                } else {
                  // User skipped the question
                  responseText += '\n[User skipped the question]\n';
                  yield { type: 'subagent_text', agentId, content: '\n[User skipped the question]\n' };
                }

                // We already handled the follow-up — return from this attempt
                return { responseText, hasError };
              } else {
                // No callback — fallback to auto-skip (backward compat)
                console.log(`[Mysti] MentionRouter: Sub-agent ${agentId} tried to ask user a question, auto-skipping`);
                const questions = chunk.askUserQuestion?.questions || [];
                const questionSummary = questions.map((q: { question?: string }) => q.question || '').join('; ');
                yield {
                  type: 'subagent_text',
                  agentId,
                  content: `\n[Sub-agent wanted to ask: ${questionSummary || 'a question'} — auto-skipped]\n`
                };
                responseText += `\n[Skipped question: ${questionSummary}]\n`;
              }
            } else if (chunk.type === 'error') {
              hasError = true;
              lastError = chunk.content;
              yield { type: 'subagent_error', agentId, content: chunk.content };
              break;
            }
          }
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (!hasError) {
          return { responseText, hasError: false };
        }
      } catch (error) {
        hasError = true;
        lastError = error instanceof Error ? error.message : 'Unknown error';
        yield { type: 'subagent_error', agentId, content: lastError };
      }

      attempt++;
    }

    // All retries exhausted
    return { responseText: '', hasError: true };
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Format user answers from a sub-agent question into readable text
   */
  private _formatQuestionAnswer(answers: Record<string, string | string[]>): string {
    const parts: string[] = [];
    for (const [header, answer] of Object.entries(answers)) {
      const formatted = Array.isArray(answer) ? answer.join(', ') : answer;
      parts.push(`**${header}**: ${formatted}`);
    }
    return parts.join('\n');
  }

  /**
   * Build a brief conversation summary for sub-agent context
   */
  private _buildConversationSummary(conversation: Conversation | null): string {
    if (!conversation || conversation.messages.length === 0) {
      return '';
    }

    const recentMessages = conversation.messages.slice(-4);
    const summary = recentMessages.map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const content = m.content.length > 300
        ? m.content.substring(0, 300) + '...'
        : m.content;
      return `${role}: ${content}`;
    }).join('\n\n');

    return `## Recent conversation context\n\n${summary}`;
  }

  /**
   * Format prior sub-agent responses as context for downstream agents
   */
  private _formatPriorResponses(responses: Map<string, string>): string {
    if (responses.size === 0) { return ''; }

    let formatted = '## Prior sub-agent outputs\n\n';
    formatted += 'The following agents have already completed their tasks. Use their output if your task depends on it.\n\n';

    for (const [agentId, content] of responses) {
      const displayName = AGENT_DISPLAY_NAMES[agentId] || agentId;
      formatted += `### ${displayName} output\n\n${content}\n\n`;
    }

    return formatted;
  }

  // ===========================================================================
  // File Resolution
  // ===========================================================================

  /**
   * Resolve @file mentions to transient ContextItems (not added to persistent context)
   */
  private async _resolveFileMentions(fileMentions: Mention[]): Promise<ContextItem[]> {
    const items: ContextItem[] = [];

    for (const mention of fileMentions) {
      const filePath = mention.value;

      try {
        let resolvedPath = filePath;
        if (!path.isAbsolute(filePath)) {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            resolvedPath = path.join(workspaceFolders[0].uri.fsPath, filePath);
          }
        }

        const content = await fs.promises.readFile(resolvedPath, 'utf-8');
        const ext = path.extname(resolvedPath).toLowerCase();
        const language = this._getLanguageFromExtension(ext);

        items.push({
          id: `mention_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'file',
          path: resolvedPath,
          content,
          language
        });
      } catch (error) {
        console.warn(`[Mysti] Failed to resolve file mention: ${filePath}`, error);
      }
    }

    return items;
  }

  private _getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.rb': 'ruby',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.cs': 'csharp',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.md': 'markdown',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.sh': 'bash',
      '.sql': 'sql',
      '.xml': 'xml'
    };

    return languageMap[ext] || '';
  }
}
