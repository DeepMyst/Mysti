/** Mysti — SPDX-License-Identifier: Apache-2.0 */

/**
 * Native execution contracts verified by Mysti. A newer upstream release is
 * not an executable update target until its approval and startup policy have
 * been reviewed. Keep transport attestation and installer targets together.
 */
export const VERIFIED_NATIVE_CLI_VERSIONS = Object.freeze({
  'claude-code': '2.1.266',
  'openai-codex': '0.153.4',
  'google-gemini': '0.60.0',
  'github-copilot': '1.0.83',
  'opencode': '1.18.29',
  'cline': '3.0.64',
  'qwen-code': '0.24.4',
  'openclaw': '2026.6.34',
} as const);

/**
 * Earlier contracts that stay accepted at runtime after the installer target
 * moved on. They are never offered as an install or update target; each entry
 * must keep its own evidence and any version-specific startup policy.
 */
const PREVIOUSLY_VERIFIED_NATIVE_CLI_VERSIONS: Readonly<Partial<Record<keyof typeof VERIFIED_NATIVE_CLI_VERSIONS, readonly string[]>>> = Object.freeze({
  'google-gemini': Object.freeze(['0.58.0']),
  'qwen-code': Object.freeze(['0.23.0']),
  'cline': Object.freeze(['3.0.61']),
});

/** The installer target first, then earlier verified releases. */
export function getAcceptedNativeCliVersions(providerId: keyof typeof VERIFIED_NATIVE_CLI_VERSIONS): readonly string[] {
  return [VERIFIED_NATIVE_CLI_VERSIONS[providerId], ...(PREVIOUSLY_VERIFIED_NATIVE_CLI_VERSIONS[providerId] ?? [])];
}

export function getVerifiedNativeCliVersion(providerId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(VERIFIED_NATIVE_CLI_VERSIONS, providerId)
    ? VERIFIED_NATIVE_CLI_VERSIONS[providerId as keyof typeof VERIFIED_NATIVE_CLI_VERSIONS]
    : undefined;
}
