/** Mysti — SPDX-License-Identifier: Apache-2.0 */

/**
 * Retired automatic suggestions, verified 2026-09-20. Explicit user custom
 * IDs remain available because a private gateway may implement those aliases.
 * https://learn.chatgpt.com/docs/changelog (2026-09-14)
 * https://ai.google.dev/gemini-api/docs/deprecations (2026-03-09)
 */
const RETIRED_MODELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'openai-codex': Object.freeze(['gpt-5.3-codex-spark']),
  'google-gemini': Object.freeze(['gemini-3-pro-preview']),
});

export function isRetiredProviderModel(providerId: string, modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_MODELS, providerId)
    && RETIRED_MODELS[providerId].includes(modelId);
}
