/** Offline auth selection. Never refresh native profiles or execute secret providers. */
import { hasOpenClawStoredCredentials } from './OpenClawAuth';
import type { OpenClawAuthStore } from './OpenClawAuthStore';
import { hasOpenClawEnvironmentCredentials, openClawAuthProvider, selectedOpenClawModels } from './OpenClawBackendEnvironment';
import { hasOpenClawProviderConfigCredentials, openClawProviderProfileBinding } from './OpenClawProviderConfigAuth';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => record(value) ? value : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const normalizedEntry = (entries: Record<string, unknown>, key: string): unknown =>
  entries[key] ?? Object.entries(entries).find(([name]) => name.trim().toLowerCase() === key)?.[1];
const orderList = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : undefined;

function baseUrl(value: unknown): string | undefined {
  const url = text(value);
  if (!url) { return undefined; }
  try {
    const parsed = new URL(url); parsed.hash = ''; parsed.search = ''; parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch { return url.toLowerCase().replace(/\/+$/, ''); }
}

export function hasOpenClawLocalCredentials(configuration: unknown, store: OpenClawAuthStore, env: NodeJS.ProcessEnv = process.env): boolean {
  const config = object(configuration), profiles = store.profiles;
  const providerConfigs = object(object(config.models).providers), auth = object(config.auth), profileConfigs = object(auth.profiles);
  return selectedOpenClawModels(config).some(selection => {
    const provider = selection.provider;
    const entry = object(provider ? normalizedEntry(providerConfigs, provider) : undefined);
    const row = Array.isArray(entry.models) ? entry.models.find(row => record(row) && row.id === selection.model) : undefined;
    const api = text(object(row).api) ?? text(entry.api);
    const compatible = (credential: Record<string, unknown>) => typeof credential.provider === 'string'
      && openClawAuthProvider(credential.provider) === openClawAuthProvider(provider ?? '');
    const eligible = (id: string): boolean => {
      const credential = object(profiles[id]);
      if (!hasOpenClawStoredCredentials({ profiles: { [id]: credential } })) { return false; }
      const declared = profileConfigs[id];
      // Native profile resolution enforces the declaration against the stored
      // credential even for a deliberately pinned cross-provider profile.
      if (record(declared) && (declared.provider !== credential.provider
        || declared.mode !== credential.type && !(declared.mode === 'oauth' && credential.type === 'token'))) { return false; }
      return provider !== 'openai' || api === undefined || api.toLowerCase() === 'openai-chatgpt-responses' || credential.type === 'api_key';
    };
    // Explicit profile selection is authoritative; env/config alternatives do
    // not rescue a missing, expired or incompatible selected profile.
    if (selection.profileId) { return eligible(selection.profileId); }
    if (provider === undefined) {
      return hasOpenClawStoredCredentials({ profiles }) || hasOpenClawEnvironmentCredentials(config, env);
    }
    if (!provider) { return false; }
    const binding = openClawProviderProfileBinding(config, provider, profiles);
    if (binding) {
      const credential = object(profiles[binding]);
      if (!['api_key', 'token'].includes(String(credential.type)) || !eligible(binding)) { return false; }
      const other = object(typeof credential.provider === 'string' ? normalizedEntry(providerConfigs, credential.provider) : undefined);
      const ownUrl = baseUrl(entry.baseUrl), otherUrl = baseUrl(other.baseUrl);
      return compatible(credential) || !!ownUrl && ownUrl === otherUrl;
    }
    const authProvider = openClawAuthProvider(provider);
    const storedOrder = orderList(normalizedEntry(store.order, authProvider)) ?? orderList(normalizedEntry(store.order, provider));
    const configuredOrder = orderList(normalizedEntry(object(auth.order), authProvider)) ?? orderList(normalizedEntry(object(auth.order), provider));
    const declaredIds = Object.entries(profileConfigs).filter(([, value]) => record(value) && typeof value.provider === 'string'
      && openClawAuthProvider(value.provider) === authProvider).map(([id]) => id);
    const storedIds = Object.entries(profiles).filter(([, value]) => compatible(object(value))).map(([id]) => id);
    const candidates = storedOrder ?? configuredOrder ?? (declaredIds.length ? declaredIds : storedIds);
    const usable = (id: string) => compatible(object(profiles[id])) && eligible(id);
    if (candidates.some(usable)) { return true; }
    // Native repairs stale stored orders and stale declarations only when every
    // listed profile is missing. An existing unusable profile remains explicit.
    if (candidates.length && candidates.every(id => !Object.hasOwn(profiles, id))
      && (storedOrder !== undefined || declaredIds.length > 0) && storedIds.some(usable)) { return true; }
    const selectedConfig = { ...config, agents: { defaults: { model: `${provider}/${selection.model ?? 'selected'}` } } };
    return hasOpenClawEnvironmentCredentials(selectedConfig, env) || hasOpenClawProviderConfigCredentials(selectedConfig, profiles, env);
  });
}
