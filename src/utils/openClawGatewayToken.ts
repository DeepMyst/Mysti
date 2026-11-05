/** Resolve exported environment credentials without invoking native secret providers. */
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const envId = /^[A-Z][A-Z0-9_]{0,127}$/;
const providerId = /^[a-z][a-z0-9_-]{0,63}$/;

function interpolate(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const resolved = value.replace(/\$\$?\{([A-Z_][A-Z0-9_]*)\}/g, (token, name: string) => {
    if (token.startsWith('$$')) { return '${' + name + '}'; }
    const part = env[name];
    if (part === undefined || part === '') { missing = true; return ''; }
    return part;
  });
  // Never send a partially expanded credential as a literal token.
  return missing ? undefined : resolved;
}

/**
 * Config token first, then OPENCLAW_GATEWAY_TOKEN, as in native token resolution.
 * Only exported env refs are evaluated here. File/exec/plugin secret providers
 * remain native-owned; reading readiness must not execute a resolver or migrate
 * an account store. Config env injection, includes and dotenv are separate.
 */
export function resolveOpenClawGatewayToken(config: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const gateway = record(config) && record(config.gateway) ? config.gateway : undefined;
  const auth = record(gateway?.auth) ? gateway.auth : undefined;
  return resolveOpenClawSecretValue(auth?.token, config, env) ?? text(env.OPENCLAW_GATEWAY_TOKEN);
}

/** Literal/interpolated/env-ref value only, with no gateway credential fallback. */
export function resolveOpenClawSecretValue(value: unknown, configuration: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fallback = undefined;
  const config = record(configuration) ? configuration : {};
  const secrets = record(config.secrets) ? config.secrets : undefined;
  const defaults = record(secrets?.defaults) ? secrets.defaults : undefined;
  const defaultProvider = text(defaults?.env) ?? 'default';
  if (typeof value === 'string') { value = interpolate(value, env); }

  let ref: { source: unknown; provider: unknown; id: unknown } | undefined;
  if (typeof value === 'string') {
    const candidate = value.trim();
    const match = /^(?:\$\{([A-Z][A-Z0-9_]{0,127})\}|\$([A-Z][A-Z0-9_]{0,127})|(?:secretref-env:|__env__:)([A-Z][A-Z0-9_]{0,127}))$/.exec(candidate);
    if (match) { ref = { source: 'env', provider: defaultProvider, id: match[1] || match[2] || match[3] }; }
    else { return text(value) ?? fallback; }
  } else if (record(value) && ['env', 'file', 'exec'].includes(String(value.source)) && text(value.id)
    && (value.provider === undefined || (Object.keys(value).length === 3 && text(value.provider)))) {
    ref = { source: value.source, provider: value.provider ?? (defaults?.env ?? 'default'), id: value.id };
  }
  if (!ref || ref.source !== 'env' || typeof ref.provider !== 'string' || !providerId.test(ref.provider)
    || typeof ref.id !== 'string' || !envId.test(ref.id.trim())) { return fallback; }
  const id = ref.id.trim();
  const providers = record(secrets?.providers) ? secrets.providers : undefined;
  const configured = providers && Object.hasOwn(providers, ref.provider) ? providers[ref.provider] : undefined;
  if (configured !== undefined) {
    if (!record(configured) || configured.source !== 'env') { return fallback; }
    if (configured.allowlist !== undefined
      && (!Array.isArray(configured.allowlist) || !configured.allowlist.includes(id))) { return fallback; }
  } else if (ref.provider !== defaultProvider) { return fallback; }
  return text(env[id]) ?? fallback;
}
