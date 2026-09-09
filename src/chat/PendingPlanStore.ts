/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PlanOption } from '../types';

export interface PendingPlanData {
  options: PlanOption[];
  messageId: string;
  originalQuery: string;
}

interface PendingPlan {
  data: PendingPlanData;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns pending plan data and deadlines independently for each chat panel. */
export class PendingPlanStore {
  private readonly _panels = new Map<string, Map<string, PendingPlan>>();
  private readonly _scopes = new Map<string, symbol>();
  private _disposed = false;

  /** Capture the current turn before starting asynchronous classification. */
  public capture(panelId: string): () => boolean {
    if (this._disposed) { return () => false; }
    let scope = this._scopes.get(panelId);
    if (!scope) {
      scope = Symbol(panelId);
      this._scopes.set(panelId, scope);
    }
    return () => !this._disposed && this._scopes.get(panelId) === scope;
  }

  public set(panelId: string, planId: string, data: PendingPlanData): void {
    if (this._disposed) { return; }
    this.take(panelId, planId);
    let plans = this._panels.get(panelId);
    if (!plans) {
      plans = new Map();
      this._panels.set(panelId, plans);
    }
    plans.set(planId, { data });
  }

  public schedule(panelId: string, planId: string, delayMs: number, onTimeout: () => void): void {
    const plan = this._panels.get(panelId)?.get(planId);
    if (!plan) { return; }
    if (plan.timer !== undefined) { clearTimeout(plan.timer); }
    const timer = setTimeout(() => {
      // The selection may have been replaced or removed after this callback
      // was queued. Only the entry that owns this timer can act on its data.
      if (this._panels.get(panelId)?.get(planId) !== plan || plan.timer !== timer) { return; }
      plan.timer = undefined;
      onTimeout();
    }, delayMs);
    plan.timer = timer;
  }

  public take(panelId: string, planId: string): PendingPlanData | undefined {
    const plans = this._panels.get(panelId);
    if (!plans) { return undefined; }
    const plan = plans.get(planId);
    if (!plan) { return undefined; }
    if (plan.timer !== undefined) { clearTimeout(plan.timer); }
    plans.delete(planId);
    if (plans.size === 0) { this._panels.delete(panelId); }
    return plan.data;
  }

  public clearPanel(panelId: string): void {
    // Invalidate work even if classification has not produced a plan yet.
    this._scopes.delete(panelId);
    const plans = this._panels.get(panelId);
    if (!plans) { return; }
    for (const plan of plans.values()) {
      if (plan.timer !== undefined) { clearTimeout(plan.timer); }
    }
    this._panels.delete(panelId);
  }

  public dispose(): void {
    this._disposed = true;
    this._scopes.clear();
    for (const panelId of this._panels.keys()) { this.clearPanel(panelId); }
  }
}
