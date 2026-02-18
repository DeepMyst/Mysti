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
import {
  AskUserQuestionData,
  AutonomousConfig,
  AutonomousContinuationMode,
  AutonomousDecision,
  AutonomousDecisionType,
  AutonomousSessionStats,
  PermissionRequest,
  SafetyLevel,
} from '../types';
import {
  AUTONOMOUS_AUDIT_LOG_MAX_ENTRIES,
  AUTONOMOUS_HEARTBEAT_INTERVAL_MS,
  AUTONOMOUS_MAX_SESSION_HOURS,
  AUTONOMOUS_MIN_CONFIDENCE_THRESHOLD,
} from '../constants';
import { MemoryManager } from './MemoryManager';
import { SafetyClassifier } from './SafetyClassifier';

export class AutonomousManager {
  private _active = false;
  private _activationTimestamp: number | null = null;
  private _auditLog: AutonomousDecision[] = [];
  private _memoryManager: MemoryManager;
  private _safetyClassifier: SafetyClassifier;
  private _heartbeatInterval: NodeJS.Timeout | null = null;
  private _config: AutonomousConfig;

  // Task continuation state
  private _continuationMode: AutonomousContinuationMode = 'goal';
  private _goal: string | null = null;
  private _taskQueue: string[] = [];
  private _completedTasks: string[] = [];
  private _currentTaskIndex = 0;

  // Session stats
  private _stats: AutonomousSessionStats = this._createEmptyStats();

  // Callback to notify ChatViewProvider
  private _onStateChange: ((active: boolean) => void) | null = null;
  private _onDecision: ((decision: AutonomousDecision) => void) | null = null;

  constructor(
    _context: vscode.ExtensionContext,
    memoryManager: MemoryManager,
  ) {
    this._memoryManager = memoryManager;
    this._config = this._loadConfig();
    this._safetyClassifier = new SafetyClassifier(this._config);

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mysti.autonomous')) {
        this._config = this._loadConfig();
        this._safetyClassifier.updateConfig(this._config);
      }
    });
  }

  // ---- Activation / Deactivation ----

  /**
   * Activate autonomous mode. Session-only (not persisted across restarts).
   */
  activate(params?: { goal?: string; tasks?: string[] }): boolean {
    if (this._active) {
      console.log('[Mysti] AutonomousManager: Already active');
      return true;
    }

    this._active = true;
    this._activationTimestamp = Date.now();
    this._stats = this._createEmptyStats();
    this._auditLog = [];

    // Set continuation mode
    if (params?.tasks && params.tasks.length > 0) {
      this._continuationMode = 'task-queue';
      this._taskQueue = [...params.tasks];
      this._currentTaskIndex = 0;
      this._completedTasks = [];
      this._goal = null;
    } else if (params?.goal) {
      this._continuationMode = 'goal';
      this._goal = params.goal;
      this._taskQueue = [];
      this._completedTasks = [];
    }

    this._startHeartbeat();

    console.log(`[Mysti] AutonomousManager: Activated (mode: ${this._continuationMode}, safety: ${this._config.safetyMode})`);
    this._onStateChange?.(true);

    return true;
  }

  /**
   * Deactivate autonomous mode and return session stats.
   */
  deactivate(): AutonomousSessionStats {
    if (!this._active) {
      return this._stats;
    }

    this._active = false;
    this._stopHeartbeat();

    this._stats.duration = this._activationTimestamp
      ? Date.now() - this._activationTimestamp
      : 0;

    const stats = { ...this._stats };

    console.log(`[Mysti] AutonomousManager: Deactivated after ${Math.round(stats.duration / 1000)}s, ${stats.totalDecisions} decisions`);
    this._onStateChange?.(false);

    // Reset continuation state
    this._goal = null;
    this._taskQueue = [];
    this._completedTasks = [];
    this._activationTimestamp = null;

    return stats;
  }

  isActive(): boolean {
    return this._active;
  }

  getConfig(): AutonomousConfig {
    return { ...this._config };
  }

  // ---- Decision Making: Permissions ----

  /**
   * Decide whether to auto-approve a permission request.
   * Returns an AutonomousDecision. If safetyLevel is 'blocked', the caller
   * should fall through to the normal user UI.
   */
  shouldAutoApprovePermission(request: PermissionRequest): AutonomousDecision {
    const classification = this._safetyClassifier.classifyPermission(request);

    // Blocked: always deny
    if (classification.level === 'blocked') {
      const decision = this._createDecision(
        'action-blocked',
        'blocked',
        `Blocked: ${request.title}`,
        classification.reason,
        'denied',
      );
      this._stats.actionsBlocked++;
      return decision;
    }

    // Safe: auto-approve
    if (classification.recommendation === 'auto-approve') {
      const decision = this._createDecision(
        'permission-approve',
        'safe',
        `Auto-approved: ${request.title}`,
        classification.reason,
        'approved',
      );
      this._stats.permissionsApproved++;
      return decision;
    }

    // Caution: check memory for learned preference
    if (classification.level === 'caution') {
      const memoryResults = this._memoryManager.query(
        `${request.actionType} ${request.title} ${request.description}`,
        3
      );

      // Find a matching permission preference with sufficient confidence
      const matchingPref = memoryResults.find(
        r => r.entry.category === 'permission-preference'
          && r.relevanceScore > 0
          && r.entry.confidence >= AUTONOMOUS_MIN_CONFIDENCE_THRESHOLD
      );

      if (matchingPref) {
        const wasApproved = matchingPref.entry.content.includes('approved');
        const type: AutonomousDecisionType = wasApproved ? 'permission-approve' : 'permission-deny';

        const decision = this._createDecision(
          type,
          'caution',
          `${wasApproved ? 'Auto-approved' : 'Auto-denied'} (from memory): ${request.title}`,
          `Learned from past user behavior: ${matchingPref.entry.content}`,
          wasApproved ? 'approved' : 'denied',
          [matchingPref.entry.id],
        );

        if (wasApproved) {
          this._stats.permissionsApproved++;
        } else {
          this._stats.permissionsDenied++;
        }
        return decision;
      }

      // No memory match for caution - signal that user should be asked
      // Return a 'caution' decision that ChatViewProvider interprets as "fall through to UI"
      return this._createDecision(
        'permission-approve', // type doesn't matter for caution/require-user
        'caution',
        `Needs user input: ${request.title}`,
        'No learned preference found for this action type',
        'require-user',
      );
    }

    // Default: require user
    return this._createDecision(
      'permission-approve',
      'caution',
      `Needs user input: ${request.title}`,
      'Default: requires user confirmation',
      'require-user',
    );
  }

  // ---- Decision Making: Questions ----

  /**
   * Try to auto-answer an AskUserQuestion.
   * Returns answers object if confident, or null if user should be asked.
   */
  generateAutoAnswer(question: AskUserQuestionData): { answers: Record<string, string | string[]>; decision: AutonomousDecision } | null {
    const answers: Record<string, string | string[]> = {};
    const memoryIds: string[] = [];
    let allAnswered = true;

    for (const q of question.questions) {
      // 1. Check memory for similar past answers
      const queryText = `${q.header} ${q.question} ${q.options.map(o => o.label).join(' ')}`;
      const memoryResults = this._memoryManager.query(queryText, 3);

      const matchingAnswer = memoryResults.find(
        r => r.entry.category === 'question-preference'
          && r.entry.confidence >= AUTONOMOUS_MIN_CONFIDENCE_THRESHOLD
      );

      if (matchingAnswer) {
        // Try to extract the answer from memory
        const extracted = this._extractAnswerFromMemory(matchingAnswer.entry.content, q.options.map(o => o.label));
        if (extracted) {
          answers[q.header] = q.multiSelect ? [extracted] : extracted;
          memoryIds.push(matchingAnswer.entry.id);
          continue;
        }
      }

      // 2. Heuristic: simple confirmation questions
      const confirmAnswer = this._tryConfirmationHeuristic(q.question, q.options.map(o => o.label));
      if (confirmAnswer) {
        answers[q.header] = q.multiSelect ? [confirmAnswer] : confirmAnswer;
        continue;
      }

      // 3. Can't answer this question
      allAnswered = false;
      break;
    }

    if (!allAnswered) {
      return null;
    }

    const decision = this._createDecision(
      'question-answer',
      'safe',
      `Auto-answered: ${question.questions.map(q => q.header).join(', ')}`,
      `Answered ${question.questions.length} question(s) using memory and heuristics`,
      JSON.stringify(answers),
      memoryIds,
    );
    this._stats.questionsAnswered++;

    return { answers, decision };
  }

  // ---- Task Continuation ----

  /**
   * Determine if the agent should continue working after a response completes.
   * Returns a follow-up message string, or null if the task is done.
   */
  shouldContinue(lastResponse: string): string | null {
    if (!this._active) { return null; }

    // Check session duration limit
    if (this._isSessionExpired()) {
      console.log('[Mysti] AutonomousManager: Session duration limit reached');
      this.deactivate();
      return null;
    }

    if (this._continuationMode === 'task-queue') {
      return this._continueTaskQueue(lastResponse);
    }

    if (this._continuationMode === 'goal') {
      return this._continueGoal(lastResponse);
    }

    return null;
  }

  /**
   * Get the initial message to send when autonomous mode starts.
   * For task-queue mode, returns the first task. For goal mode, returns the goal.
   */
  getInitialMessage(): string | null {
    if (this._continuationMode === 'task-queue' && this._taskQueue.length > 0) {
      return `Task 1/${this._taskQueue.length}: ${this._taskQueue[0]}`;
    }
    if (this._continuationMode === 'goal' && this._goal) {
      return this._goal;
    }
    return null;
  }

  // ---- Audit & Stats ----

  getAuditLog(): AutonomousDecision[] {
    return [...this._auditLog];
  }

  getSessionStats(): AutonomousSessionStats {
    if (this._active && this._activationTimestamp) {
      return {
        ...this._stats,
        startTime: this._activationTimestamp,
        duration: Date.now() - this._activationTimestamp,
      };
    }
    return { ...this._stats };
  }

  getGoal(): string | null {
    return this._goal;
  }

  getTaskQueue(): string[] {
    return [...this._taskQueue];
  }

  getCompletedTasks(): string[] {
    return [...this._completedTasks];
  }

  getCurrentTaskIndex(): number {
    return this._currentTaskIndex;
  }

  // ---- Event Callbacks ----

  onStateChange(callback: (active: boolean) => void): void {
    this._onStateChange = callback;
  }

  onDecision(callback: (decision: AutonomousDecision) => void): void {
    this._onDecision = callback;
  }

  dispose(): void {
    this._stopHeartbeat();
    if (this._active) {
      this.deactivate();
    }
  }

  // ---- Private: Continuation Logic ----

  private _continueTaskQueue(_lastResponse: string): string | null {
    // Mark current task as completed
    if (this._currentTaskIndex < this._taskQueue.length) {
      this._completedTasks.push(this._taskQueue[this._currentTaskIndex]);
      this._currentTaskIndex++;
      this._stats.tasksCompleted++;
    }

    // Check if there are more tasks
    if (this._currentTaskIndex >= this._taskQueue.length) {
      console.log('[Mysti] AutonomousManager: All tasks completed');
      return null; // All done
    }

    const nextTask = this._taskQueue[this._currentTaskIndex];
    const progress = `Task ${this._currentTaskIndex + 1}/${this._taskQueue.length}`;
    return `${progress}: ${nextTask}\n\nPrevious task completed. Please proceed with the next task above.`;
  }

  private _continueGoal(lastResponse: string): string | null {
    // Check for completion signals in the response
    const completionSignals = [
      'all tasks completed',
      'project is complete',
      'implementation is complete',
      'everything is set up',
      'all done',
      'finished implementing',
      'the project is ready',
    ];

    const responseLower = lastResponse.toLowerCase();
    const isComplete = completionSignals.some(signal => responseLower.includes(signal));

    if (isComplete) {
      console.log('[Mysti] AutonomousManager: Goal appears complete');
      this._stats.tasksCompleted++;
      return null;
    }

    // Check for error signals that need addressing
    const hasErrors = /\b(error|failed|exception|crash|broken)\b/i.test(lastResponse);

    if (hasErrors) {
      return `Continue working on the goal: "${this._goal}"\n\nIt looks like there were some errors in the last step. Please fix them and continue.`;
    }

    // Continue with the goal
    return `Continue working on the goal: "${this._goal}"\n\nPlease continue from where you left off. If the goal is fully complete, say "all tasks completed".`;
  }

  // ---- Private: Heuristics ----

  private _tryConfirmationHeuristic(question: string, options: string[]): string | null {
    const questionLower = question.toLowerCase();

    // Common confirmation patterns
    const confirmPatterns = [
      /\bcontinue\b/,
      /\bproceed\b/,
      /\bready\b/,
      /\bshould (i|we) (go ahead|proceed|continue)\b/,
      /\bdo you want (me )?to\b/,
      /\bshall (i|we)\b/,
      /\bwould you like\b/,
    ];

    const isConfirmation = confirmPatterns.some(p => p.test(questionLower));
    if (!isConfirmation) { return null; }

    // Find the affirmative option
    const affirmativePatterns = [/^yes$/i, /^continue$/i, /^proceed$/i, /^go ahead$/i, /^confirm$/i, /^ok$/i];
    for (const opt of options) {
      if (affirmativePatterns.some(p => p.test(opt.trim()))) {
        return opt;
      }
    }

    // If first option looks affirmative by position (common pattern)
    if (options.length >= 2) {
      const firstLower = options[0].toLowerCase();
      if (firstLower.includes('yes') || firstLower.includes('continue') || firstLower.includes('proceed')) {
        return options[0];
      }
    }

    return null;
  }

  private _extractAnswerFromMemory(memoryContent: string, availableOptions: string[]): string | null {
    // Memory format: 'Q: "..." -> A: "answer"'
    const answerMatch = memoryContent.match(/-> A: "([^"]+)"/);
    if (!answerMatch) { return null; }

    const rememberedAnswer = answerMatch[1].toLowerCase();

    // Check if any current option matches the remembered answer
    for (const opt of availableOptions) {
      if (opt.toLowerCase() === rememberedAnswer || opt.toLowerCase().includes(rememberedAnswer)) {
        return opt;
      }
    }

    return null;
  }

  // ---- Private: Heartbeat ----

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      if (this._isSessionExpired()) {
        console.log('[Mysti] AutonomousManager: Session expired via heartbeat');
        this.deactivate();
      }
    }, AUTONOMOUS_HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  private _isSessionExpired(): boolean {
    if (!this._activationTimestamp || this._config.maxSessionDuration <= 0) {
      return false;
    }
    const elapsed = Date.now() - this._activationTimestamp;
    const maxMs = this._config.maxSessionDuration * 60 * 60 * 1000;
    return elapsed >= maxMs;
  }

  // ---- Private: Helpers ----

  private _createDecision(
    type: AutonomousDecisionType,
    safetyLevel: SafetyLevel,
    description: string,
    reasoning: string,
    decision: string,
    memoryUsed: string[] = [],
  ): AutonomousDecision {
    const d: AutonomousDecision = {
      id: `ad_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      type,
      safetyLevel,
      description,
      reasoning,
      decision,
      memoryUsed,
    };

    this._auditLog.push(d);
    if (this._auditLog.length > AUTONOMOUS_AUDIT_LOG_MAX_ENTRIES) {
      this._auditLog = this._auditLog.slice(-AUTONOMOUS_AUDIT_LOG_MAX_ENTRIES);
    }

    this._stats.totalDecisions++;
    this._onDecision?.(d);

    console.log(`[Mysti] Autonomous decision: [${safetyLevel}] ${description}`);
    return d;
  }

  private _createEmptyStats(): AutonomousSessionStats {
    return {
      startTime: 0,
      duration: 0,
      permissionsApproved: 0,
      permissionsDenied: 0,
      questionsAnswered: 0,
      actionsBlocked: 0,
      tasksCompleted: 0,
      totalDecisions: 0,
    };
  }

  private _loadConfig(): AutonomousConfig {
    const config = vscode.workspace.getConfiguration('mysti');
    return {
      safetyMode: config.get('autonomous.safetyMode', 'balanced') as AutonomousConfig['safetyMode'],
      maxSessionDuration: config.get('autonomous.maxSessionDuration', AUTONOMOUS_MAX_SESSION_HOURS),
      allowFileCreation: config.get('autonomous.allowFileCreation', true),
      allowFileEdit: config.get('autonomous.allowFileEdit', true),
      allowBashCommands: config.get('autonomous.allowBashCommands', true),
      blockPatterns: config.get('autonomous.blockPatterns', []),
      continuationMode: config.get('autonomous.continuationMode', 'goal') as AutonomousContinuationMode,
    };
  }
}
