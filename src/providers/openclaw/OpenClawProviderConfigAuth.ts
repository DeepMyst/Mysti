/** Offline configured-provider credential eligibility; native OpenClaw validates credentials. */
import { resolveOpenClawSecretValue } from '../../utils/openClawGatewayToken';
import { selectedProviders } from './OpenClawBackendEnvironment';

// Qualified built-in marker names from OpenClaw 2026.6.34. Marker names are not secrets.
const envMarkers = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'AZURE_API_KEY', 'AZURE_OPENAI_API_KEY',
  'AZURE_SPEECH_API_KEY', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'BYTEPLUS_API_KEY',
  'BYTEPLUS_SEED_SPEECH_API_KEY', 'CEREBRAS_API_KEY', 'CODEX_API_KEY', 'COHERE_API_KEY',
  'COMFY_API_KEY', 'COMFY_CLOUD_API_KEY', 'COPILOT_GITHUB_TOKEN', 'DASHSCOPE_API_KEY',
  'DEEPGRAM_API_KEY', 'DEEPSEEK_API_KEY', 'ELEVENLABS_API_KEY', 'FAL_API_KEY',
  'FAL_KEY', 'FIREWORKS_API_KEY', 'GEMINI_API_KEY', 'GH_TOKEN',
  'GITHUB_TOKEN', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY', 'HF_TOKEN',
  'HUGGINGFACE_HUB_TOKEN', 'LITELLM_API_KEY', 'LM_API_TOKEN', 'MINIMAX_API_KEY',
  'MINIMAX_CODE_PLAN_KEY', 'MINIMAX_CODING_API_KEY', 'MINIMAX_OAUTH_TOKEN', 'MISTRAL_API_KEY',
  'MODELSTUDIO_API_KEY', 'NOVITA_API_KEY', 'NVIDIA_API_KEY', 'OLLAMA_API_KEY',
  'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY', 'OPENROUTER_API_KEY',
  'PERPLEXITY_API_KEY', 'QWEN_API_KEY', 'RUNWAYML_API_SECRET', 'RUNWAY_API_KEY',
  'SENSEAUDIO_API_KEY', 'SGLANG_API_KEY', 'SPEECH_KEY', 'SPEECH_REGION',
  'SYNTHETIC_API_KEY', 'TOGETHER_API_KEY', 'VLLM_API_KEY', 'VOLCANO_ENGINE_API_KEY',
  'VOLCENGINE_TTS_API_KEY', 'VOLCENGINE_TTS_APPID', 'VOLCENGINE_TTS_TOKEN', 'VOYAGE_API_KEY',
  'VYDRA_API_KEY', 'XAI_API_KEY', 'XIAOMI_API_KEY', 'XIAOMI_TOKEN_PLAN_API_KEY',
  'XI_API_KEY',
]);
const nonSecretMarkers = new Set([
  'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'codex-app-server',
  'custom-local', 'gcp-vertex-credentials', 'lmstudio-local', 'minimax-oauth',
  'ollama-local', 'secretref-managed',
]);

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = (value: unknown): string => typeof value === 'string' ? value.replace(/[^\x20-\x7e\xa0-\xff]/g, '').trim() : '';
function localUrl(value: unknown): boolean {
  if (typeof value !== 'string') { return false; }
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '::ffff:7f00:1', '::ffff:127.0.0.1',
      'docker.orb.internal', 'host.docker.internal', 'host.orb.internal'].includes(host) || host.endsWith('.local')) { return true; }
    const parts = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : [];
    return parts.length === 4 && parts.every(n => n >= 0 && n <= 255)
      && (parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168);
  } catch { return false; }
}

/** Native treats literal profile ids as bindings before trying alternate auth. */
export function openClawProviderProfileBinding(configuration: unknown, provider: string, profiles: Record<string, unknown>): string | undefined {
  const models = record(configuration) && record(configuration.models) ? configuration.models : {};
  const providers = record(models.providers) ? models.providers : {};
  const entry = Object.entries(providers).find(([key]) => key.trim().toLowerCase() === provider)?.[1];
  const raw = record(entry) ? entry.apiKey : undefined;
  if (typeof raw !== 'string' || /^(?:\$\{?[A-Z][A-Z0-9_]*\}?|(?:secretref-env:|__env__:)[A-Z][A-Z0-9_]*)$/.test(raw.trim())) { return undefined; }
  const key = normalized(raw);
  return key && !envMarkers.has(key) && !nonSecretMarkers.has(key) && !key.startsWith('oauth:') && Object.hasOwn(profiles, key) ? key : undefined;
}

export function hasOpenClawProviderConfigCredentials(configuration: unknown, profiles: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!record(configuration)) { return false; }
  const models = record(configuration.models) ? configuration.models : {};
  const providers = record(models.providers) ? models.providers : {};
  return selectedProviders(configuration).some(provider => {
    if (!provider) { return false; }
    const entry = Object.entries(providers).find(([key]) => key.trim().toLowerCase() === provider)?.[1];
    if (!record(entry) || entry.auth !== undefined && entry.auth !== 'api-key') { return false; }
    const raw = entry.apiKey;
    const local = typeof entry.api === 'string' && !!entry.api.trim() && Array.isArray(entry.models)
      && entry.models.length > 0 && localUrl(entry.baseUrl);
    const value = normalized(resolveOpenClawSecretValue(raw, configuration, env));
    const reference = record(raw) || typeof raw === 'string' && /^(?:\$\{?[A-Z][A-Z0-9_]*\}?|(?:secretref-env:|__env__:)[A-Z][A-Z0-9_]*)$/.test(raw.trim());
    // Explicit unavailable refs must not silently become no-auth local configs.
    if (reference) { return !!value; }
    if (!value) { return typeof raw === 'string' && normalized(raw) ? false : local; }
    if (envMarkers.has(value)) { return !!normalized(env[value]); }
    if (value.startsWith('oauth:') || nonSecretMarkers.has(value)) {
      return local && (entry.api === 'openai-completions' || entry.api === 'ollama');
    }
    // Native treats a string equal to an existing profile id as a binding.
    // Existing store eligibility handles profiles; never revive a removed or
    // expired credential by counting its profile id as a literal API key.
    return !Object.hasOwn(profiles, value);
  });
}
