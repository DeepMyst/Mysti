/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SubAgentAnswer {
  answers: Record<string, string | string[]>;
}

interface PendingQuestion {
  promise: Promise<SubAgentAnswer | null>;
  resolve: (answer: SubAgentAnswer | null) => void;
}

/** Owns pending answers independently of VS Code and the chat renderer. */
export class SubAgentQuestionBroker {
  private readonly _panels = new Map<string, Map<string, Map<string, PendingQuestion>>>();
  private readonly _scopes = new Map<string, object>();
  private _disposed = false;

  /** A callback captured by an old turn cannot reopen questions after cancellation. */
  public captureScope(panelId: string): () => boolean {
    if (this._disposed) { return () => false; }
    let scope = this._scopes.get(panelId);
    if (!scope) { scope = {}; this._scopes.set(panelId, scope); }
    return () => !this._disposed && this._scopes.get(panelId) === scope;
  }

  public wait(panelId: string, agentId: string, toolCallId: string): Promise<SubAgentAnswer | null> {
    if (this._disposed) { return Promise.resolve(null); }
    let agents = this._panels.get(panelId);
    if (!agents) { agents = new Map(); this._panels.set(panelId, agents); }
    let questions = agents.get(agentId);
    if (!questions) { questions = new Map(); agents.set(agentId, questions); }
    const existing = questions.get(toolCallId);
    // Repeated delivery must not replace a resolver and strand its caller.
    if (existing) { return existing.promise; }
    let resolve!: PendingQuestion['resolve'];
    const promise = new Promise<SubAgentAnswer | null>(settle => { resolve = settle; });
    questions.set(toolCallId, { promise, resolve });
    return promise;
  }

  public answer(panelId: string, agentId: string, toolCallId: string, answer: SubAgentAnswer | null): boolean {
    const agents = this._panels.get(panelId);
    const questions = agents?.get(agentId);
    const pending = questions?.get(toolCallId);
    if (!agents || !questions || !pending) { return false; }
    questions.delete(toolCallId);
    if (questions.size === 0) { agents.delete(agentId); }
    if (agents.size === 0) { this._panels.delete(panelId); }
    pending.resolve(answer);
    return true;
  }

  public cancelPanel(panelId: string): void {
    this._scopes.delete(panelId);
    const agents = this._panels.get(panelId);
    this._panels.delete(panelId);
    for (const questions of agents?.values() ?? []) {
      for (const pending of questions.values()) { pending.resolve(null); }
    }
  }

  public dispose(): void {
    this._disposed = true;
    this._scopes.clear();
    for (const panelId of this._panels.keys()) { this.cancelPanel(panelId); }
  }
}

/** The renderer is a runtime boundary; TypeScript assertions do not validate it. */
export function parseSubAgentResponse(payload: unknown, skipped: boolean): {
  agentId: string; toolCallId: string; answer: SubAgentAnswer | null;
} | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { return null; }
  const raw = payload as Record<string, unknown>;
  if (typeof raw.agentId !== 'string' || !raw.agentId || typeof raw.toolCallId !== 'string' || !raw.toolCallId) {
    return null;
  }
  if (skipped) { return { agentId: raw.agentId, toolCallId: raw.toolCallId, answer: null }; }
  if (!raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)) { return null; }
  const entries = Object.entries(raw.answers);
  if (!entries.every(([, value]) => typeof value === 'string' ||
      (Array.isArray(value) && value.every(item => typeof item === 'string')))) { return null; }
  return {
    agentId: raw.agentId,
    toolCallId: raw.toolCallId,
    answer: { answers: Object.fromEntries(entries) as SubAgentAnswer['answers'] },
  };
}
