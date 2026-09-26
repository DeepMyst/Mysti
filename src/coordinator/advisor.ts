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

/**
 * Plan 30 §3 — who answers `delegate agent="advisor"`. A subscription CLI the
 * user already pays for first (no per-token bill), then a paid API model under
 * the per-turn spend guard, else nobody.
 */
export const ADVISOR_DEFAULT_AGENTS: readonly string[] = ['claude-code', 'openai-codex'];
export const ADVISOR_DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
export const ADVISOR_MAX_CALLS = 2;

/**
 * The subscription CLIs to try, in the user's order. "Available" means
 * installed, not signed in, so the caller walks the whole list and falls back
 * to the paid model only after every one fails to start.
 */
export function advisorCandidates(preferred: readonly string[], available: readonly string[]): string[] {
  return preferred.filter((a, i) => available.includes(a) && preferred.indexOf(a) === i);
}
