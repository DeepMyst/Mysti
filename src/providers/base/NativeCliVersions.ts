/** Mysti — SPDX-License-Identifier: Apache-2.0 */

/**
 * Native execution contracts verified by Mysti. A newer upstream release is
 * not an executable update target until its approval and startup policy have
 * been reviewed. Keep transport attestation and installer targets together.
 */
export const VERIFIED_NATIVE_CLI_VERSIONS = Object.freeze({
  'claude-code': '2.1.266',
  'openai-codex': '0.153.4',
  'google-gemini': '0.58.0',
  'github-copilot': '1.0.83',
  'opencode': '1.18.29',
  'cline': '3.0.61',
  'qwen-code': '0.23.0',
  'openclaw': '2026.6.34',
} as const);

export function getVerifiedNativeCliVersion(providerId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(VERIFIED_NATIVE_CLI_VERSIONS, providerId)
    ? VERIFIED_NATIVE_CLI_VERSIONS[providerId as keyof typeof VERIFIED_NATIVE_CLI_VERSIONS]
    : undefined;
}
