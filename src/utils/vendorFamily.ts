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
 * Vendor families (Plan 17 P2.1) — cross-vendor review needs a reviewer whose
 * UNDERLYING model differs from the writer's so their blind spots are
 * decorrelated. The flagship three (Anthropic/OpenAI/Google) drive most of the
 * value; multi-model or configurable backends get their own family so they
 * still count as "different" from the flagship three.
 */

import type { AgentType } from '../types';

export const VENDOR_FAMILY: Partial<Record<AgentType, string>> = {
  'claude-code': 'anthropic',
  'openai-codex': 'openai',
  'google-gemini': 'google',
  'github-copilot': 'copilot',
  'cursor': 'cursor',
  'qwen-code': 'qwen',
  'cline': 'cline',
  'opencode': 'opencode',
  'openclaw': 'openclaw',
  'hermes': 'nous',
  'continue': 'continue',
  'kimi-code': 'moonshot',
  'ollama': 'local',
  'localai': 'local',
};

/** The vendor family of a backend (defaults to the id itself if unmapped). */
export function vendorFamily(agent: AgentType): string {
  return VENDOR_FAMILY[agent] || agent;
}

/**
 * Pick a review backend whose vendor family differs from the writer's,
 * preferring the strong flagship reviewers (Claude/GPT/Gemini) for review
 * quality. Returns null when no different-vendor backend is usable.
 */
export function pickCrossVendorReviewer(writer: AgentType, backends: AgentType[]): AgentType | null {
  const writerFamily = vendorFamily(writer);
  const different = backends.filter(b => b !== writer && vendorFamily(b) !== writerFamily);
  if (different.length === 0) { return null; }
  const preferred: AgentType[] = ['claude-code', 'openai-codex', 'google-gemini'];
  return preferred.find(p => different.includes(p)) ?? different[0];
}
