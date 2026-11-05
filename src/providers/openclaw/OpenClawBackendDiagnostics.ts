/** Snapshot known backend credentials for diagnostics; never execute secret resolvers. */
import { resolveOpenClawSecretValue } from '../../utils/openClawGatewayToken';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const secretName = /(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTHORIZATION)/i;

export function openClawBackendRedactor(configuration: unknown, env: NodeJS.ProcessEnv, profiles: readonly unknown[] = []): (text: string) => string {
  const secrets = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) { return; }
    // Native API-key normalization can remove characters before sending it.
    for (const variant of [value, value.trim(), value.replace(/[^\x20-\x7e\xa0-\xff]/g, '').trim()]) {
      if (!variant) { continue; }
      secrets.add(variant);
      secrets.add(JSON.stringify(variant).slice(1, -1));
      try { secrets.add(encodeURIComponent(variant)); } catch { /* Malformed Unicode: retain the literal. */ }
    }
  };
  for (const [name, value] of Object.entries(env)) {
    if (secretName.test(name)) { add(value); }
  }
  const resolve = (raw: unknown) => {
    const value = resolveOpenClawSecretValue(raw, configuration, env);
    add(value);
    // Native configurations can name a built-in environment marker directly.
    if (value && Object.hasOwn(env, value)) { add(env[value]); }
    if (value && /^(?:Bearer|Basic)\s+/i.test(value)) { add(value.replace(/^\S+\s+/, '')); }
  };
  const providers = record(record(record(configuration).models).providers);
  for (const profile of profiles) {
    const credential = record(profile);
    for (const field of ['key', 'apiKey', 'keyRef', 'token', 'tokenRef', 'access', 'refresh']) {
      resolve(credential[field]);
    }
  }
  for (const provider of Object.values(providers)) {
    const entry = record(provider);
    resolve(entry.apiKey);
    for (const [name, value] of Object.entries(record(entry.headers))) {
      if (secretName.test(name)) { resolve(value); }
    }
    if (typeof entry.baseUrl === 'string') {
      try {
        const url = new URL(entry.baseUrl);
        for (const value of [url.username, url.password]) {
          add(value);
          try { add(decodeURIComponent(value)); } catch { /* Keep encoded material. */ }
        }
        for (const [name, value] of url.searchParams) { if (secretName.test(name)) { add(value); } }
      } catch { /* Configuration errors must not expose their raw URL. */ }
    }
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return text => {
    let safe = text;
    for (const value of values) { safe = safe.split(value).join('[REDACTED]'); }
    return safe;
  };
}
