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

/**
 * Model name validation
 *
 * Allowed: letters, digits, dots, hyphens, underscores, colons, slashes.
 * Must start with a letter or digit.
 * Covers all known model ID formats:
 *   claude-sonnet-4-5-20250929, gpt-5.2, gemini-3-pro,
 *   org/model:variant, openrouter:anthropic/claude
 *
 * Excludes shell metacharacters (; | & ` $ ( ) { } < > " ' \ ! # ~ * ? spaces newlines)
 * to prevent injection when BaseCliProvider runs with shell:true.
 */
export const MODEL_NAME_MAX_LENGTH = 128;
export const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-:/]*$/;

export function validateModelName(model: string): { valid: boolean; error?: string } {
  if (!model || model.trim().length === 0) {
    return { valid: false, error: 'Model name cannot be empty' };
  }
  const trimmed = model.trim();
  if (trimmed.length > MODEL_NAME_MAX_LENGTH) {
    return { valid: false, error: `Model name too long (max ${MODEL_NAME_MAX_LENGTH} characters)` };
  }
  if (!MODEL_NAME_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Model name contains invalid characters. Use only letters, numbers, dots, hyphens, underscores, colons, and slashes.' };
  }
  return { valid: true };
}

/**
 * Profile name validation (Codex profile from ~/.codex/config.toml)
 * More restrictive: no colons or slashes.
 */
export const PROFILE_NAME_MAX_LENGTH = 64;
export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validateProfileName(profile: string): { valid: boolean; error?: string } {
  if (!profile || profile.trim().length === 0) {
    return { valid: false, error: 'Profile name cannot be empty' };
  }
  const trimmed = profile.trim();
  if (trimmed.length > PROFILE_NAME_MAX_LENGTH) {
    return { valid: false, error: `Profile name too long (max ${PROFILE_NAME_MAX_LENGTH} characters)` };
  }
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Profile name contains invalid characters. Use only letters, numbers, dots, hyphens, and underscores.' };
  }
  return { valid: true };
}
