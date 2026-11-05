/** Offline credential-shape checks for OpenClaw's persisted auth stores. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Recognize configured references without reading files or running resolvers. */
function isSecretRef(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^(?:\$[A-Z][A-Z0-9_]{0,127}|\$\{[A-Z][A-Z0-9_]{0,127}\}|(?:secretref-env:|__env__:)[A-Z][A-Z0-9_]{0,127})$/.test(value.trim());
  }
  if (!isRecord(value) || (value.source !== 'env' && value.source !== 'file' && value.source !== 'exec') || !hasText(value.id)) {
    return false;
  }
  // Older references omit the provider alias; OpenClaw supplies "default".
  return value.provider === undefined || (Object.keys(value).length === 3 && hasText(value.provider));
}

function hasCredential(value: unknown): boolean {
  if (!isRecord(value) || !hasText(value.provider)) { return false; }
  const type = 'type' in value ? value.type : value.mode;
  if (type === 'api_key' || type === 'apiKey') {
    // A configured reference takes precedence over a literal/legacy key.
    if (isSecretRef(value.keyRef) || (typeof value.key !== 'string' && isSecretRef(value.key))) {
      return true;
    }
    const key = 'key' in value ? value.key : value.apiKey;
    return hasText(key) && !/^openclaw\s+onboard(?:\s+.*)?\s+--auth-choice(?:\s|=|$)/i.test(key.trim());
  }
  if (type === 'token') {
    if (!hasText(value.token) && !isSecretRef(value.tokenRef) && !isSecretRef(value.token)) { return false; }
    const expires = value.expires;
    return expires === undefined || (typeof expires === 'number' && Number.isFinite(expires)
      && expires > Date.now() && expires <= 8.64e15);
  }
  // OAuth can refresh an expired access token. Native OpenClaw owns refresh and
  // service validation; metadata or an unresolved legacy oauthRef alone is not
  // credential material.
  return type === 'oauth' && (hasText(value.access) || hasText(value.refresh));
}

/**
 * A readiness hint, not a verified login: OpenClaw resolves secret references
 * and validates the selected backend when it runs. Keep the modern profile
 * envelope separate from auth.json's legacy provider map, just as its loader does.
 */
export function hasOpenClawStoredCredentials(value: unknown, legacy = false): boolean {
  return Object.values(getOpenClawStoredProfiles(value, legacy)).some(hasCredential);
}

/** Keep schema-valid entries, including expired/empty ones that shadow inherited profiles. */
export function getOpenClawStoredProfiles(value: unknown, legacy = false): Record<string, unknown> {
  if (!isRecord(value) || (legacy && 'profiles' in value)) { return {}; }
  const profiles = legacy ? value : value.profiles;
  if (!isRecord(profiles)) { return {}; }
  return Object.fromEntries(Object.entries(profiles).flatMap(([id, entry]) => {
    if (!isRecord(entry) || !hasText(entry.provider)) { return []; }
    const rawType = 'type' in entry ? entry.type : entry.mode;
    const type = rawType === 'apiKey' ? 'api_key' : rawType;
    if (type !== 'api_key' && type !== 'token' && type !== 'oauth') { return []; }
    return [[legacy ? `${id}:default` : id, { ...entry, type, provider: entry.provider.trim().toLowerCase() }]];
  }));
}
