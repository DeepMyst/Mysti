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

import { tokensCostUsd, type ModelRate } from '../services/ModelPricing';

/** Upper-bound USD for one call: the whole prompt (chars/4) plus the full output allowance. */
export function estimateCallUsd(rate: ModelRate | null, promptChars: number, maxOutputTokens: number): number | undefined {
  if (!rate) { return undefined; }
  return tokensCostUsd(Math.ceil(promptChars / 4), rate.inputPerMTok) + tokensCostUsd(maxOutputTokens, rate.outputPerMTok);
}

/** OpenRouter catalog prices are USD per TOKEN; ModelRate is per million. */
export function rateFromCatalog(pricing?: { prompt: number; completion: number }): ModelRate | null {
  return pricing ? { inputPerMTok: pricing.prompt * 1e6, outputPerMTok: pricing.completion * 1e6 } : null;
}

export interface PaidCall {
  /** What is asking, for the card: "Advisor", "Subagent". */
  label: string;
  model: string;
  /** Upper-bound USD, or undefined when the price is unknown (always asks). */
  estimateUsd?: number;
  /** The estimate is not an upper bound, e.g. a multi-round subagent. */
  approximate?: boolean;
}

/**
 * Plan 30 §3: one per coordinator turn. A paid call within the turn's budget
 * proceeds; anything over it — or of unknown price — asks the user. The default
 * budget of 0 means every paid call asks, the same consent Mysti already
 * required for a paid coordinator model.
 */
export class PaidSpendGuard {
  private _spent = 0;
  private _approx = false;
  private readonly _budget: number;

  constructor(budgetUsd: number, private readonly _ask: (call: PaidCall) => Promise<boolean>) {
    this._budget = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : 0;
  }

  public get spentUsd(): number { return this._spent; }
  /** A settled call reported no actual cost, so `spentUsd` still holds its estimate. */
  public get spentApprox(): boolean { return this._approx; }

  public async approve(call: PaidCall): Promise<boolean> {
    const est = call.estimateUsd;
    const known = est !== undefined && Number.isFinite(est) && est >= 0;
    if (known && this._spent + est! <= this._budget) { this._spent += est!; return true; }
    const ok = await this._ask(call);
    if (ok && known) { this._spent += est!; }
    return ok;
  }

  /** Replace a reserved estimate with what the call actually cost. */
  public settle(estimateUsd: number | undefined, actualUsd: number | undefined): void {
    if (actualUsd === undefined || !Number.isFinite(actualUsd)) { this._approx = true; return; }
    this._spent = Math.max(0, this._spent + actualUsd - (estimateUsd ?? 0));
  }
}
