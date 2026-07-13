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
 * Reasoning-effort helpers (Plan 16). The canonical Mysti scale is Claude Code's
 * `low·medium·high·xhigh·max`. Each backend declares the tiers it actually honors
 * (ProviderCapabilities.effortLevels); this module clamps a requested tier to the
 * nearest supported one so a backend that tops out at `xhigh` (Codex/Copilot) or
 * `high` (LocalAI/Ollama-boolean) degrades gracefully instead of erroring.
 */
import type { EffortLevel } from '../types';

/** Canonical low→high ordering of the effort scale. */
export const EFFORT_ORDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Clamp a requested effort tier to the nearest tier a backend supports.
 * - Returns undefined when there is nothing to apply (no request, or the backend
 *   declares no effort control).
 * - If the exact tier is supported, returns it.
 * - Otherwise returns the highest supported tier at or below the request
 *   (mirrors Claude Code's own fallback). If the request is below every
 *   supported tier, returns the lowest supported tier.
 */
export function clampEffort(
  requested: EffortLevel | undefined,
  allowed: readonly EffortLevel[] | undefined,
): EffortLevel | undefined {
  if (!requested || !allowed || allowed.length === 0) {
    return undefined;
  }
  if (allowed.includes(requested)) {
    return requested;
  }
  const reqIdx = EFFORT_ORDER.indexOf(requested);
  // Highest allowed tier at or below the requested one.
  let best: EffortLevel | undefined;
  let bestIdx = -1;
  for (const tier of allowed) {
    const idx = EFFORT_ORDER.indexOf(tier);
    if (idx <= reqIdx && idx > bestIdx) {
      best = tier;
      bestIdx = idx;
    }
  }
  if (best) {
    return best;
  }
  // Request is below every supported tier — use the lowest supported.
  return [...allowed].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0];
}
