/** Offline exported environment eligibility for OpenClaw backends. */
// Built-in auth candidates/aliases qualified against OpenClaw 2026.6.34.
// Native runtime plugins, local-file auth evidence and key validation stay native-owned.
const candidates: Readonly<Record<string, readonly string[]>> = {
  'alibaba': ['MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  'anthropic': ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'anthropic-openai': ['ANTHROPIC_API_KEY'],
  'byteplus': ['BYTEPLUS_API_KEY'],
  'cerebras': ['CEREBRAS_API_KEY'],
  'cohere': ['COHERE_API_KEY'],
  'comfy': ['COMFY_API_KEY', 'COMFY_CLOUD_API_KEY'],
  'fal': ['FAL_KEY', 'FAL_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'google': ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  'huggingface': ['HUGGINGFACE_HUB_TOKEN', 'HF_TOKEN'],
  'litellm': ['LITELLM_API_KEY'],
  'lmstudio': ['LM_API_TOKEN'],
  'microsoft-foundry': ['AZURE_OPENAI_API_KEY'],
  'minimax': ['MINIMAX_CODE_PLAN_KEY', 'MINIMAX_CODING_API_KEY', 'MINIMAX_API_KEY'],
  'minimax-portal': ['MINIMAX_OAUTH_TOKEN', 'MINIMAX_API_KEY'],
  'mistral': ['MISTRAL_API_KEY'],
  'novita': ['NOVITA_API_KEY'],
  'nvidia': ['NVIDIA_API_KEY'],
  'ollama': ['OLLAMA_API_KEY'],
  'ollama-cloud': ['OLLAMA_API_KEY'],
  'openai': ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  'opencode': ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
  'openrouter': ['OPENROUTER_API_KEY'],
  'qwen-dashscope': ['DASHSCOPE_API_KEY'],
  'sglang': ['SGLANG_API_KEY'],
  'synthetic': ['SYNTHETIC_API_KEY'],
  'together': ['TOGETHER_API_KEY'],
  'vllm': ['VLLM_API_KEY'],
  'volcengine': ['VOLCANO_ENGINE_API_KEY'],
  'voyage': ['VOYAGE_API_KEY'],
  'vydra': ['VYDRA_API_KEY'],
  'xai': ['XAI_API_KEY'],
  'xiaomi': ['XIAOMI_API_KEY'],
  'xiaomi-token-plan': ['XIAOMI_TOKEN_PLAN_API_KEY'],
};
const aliases: Readonly<Record<string, string>> = {
  'byteplus-plan': 'byteplus',
  'claude-cli': 'anthropic',
  'minimax': 'minimax',
  'minimax-api': 'minimax',
  'minimax-api-key-cn': 'minimax',
  'minimax-api-lightning': 'minimax',
  'minimax-cloud': 'minimax',
  'minimax-cn': 'minimax',
  'minimax-portal-cn': 'minimax-portal',
  'novita-ai': 'novita',
  'novitaai': 'novita',
  'volcengine-plan': 'volcengine',
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const primary = (value: unknown): string | undefined => text(record(value) ? value.primary : value);
const agentId = (value: unknown): string => {
  const id = text(value)?.toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ? id : id.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'main';
};

export const openClawAuthProvider = (provider: string): string => aliases[provider.trim().toLowerCase()] ?? provider.trim().toLowerCase();

export interface OpenClawModelSelection { provider?: string; model?: string; profileId?: string }

/** Native model versions and local quantizations can contain @ without pinning auth. */
export function splitOpenClawAuthProfile(raw: string): { model: string; profileId?: string } {
  const model = raw.trim();
  let delimiter = model.indexOf('@', model.lastIndexOf('/') + 1);
  if (delimiter <= 0) { return { model }; }
  if (/^\d{8}(?:@|$)/.test(model.slice(delimiter + 1))) {
    delimiter = model.indexOf('@', delimiter + 9);
    if (delimiter < 0) { return { model }; }
  }
  if (/^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i.test(model.slice(delimiter + 1))) {
    delimiter = model.indexOf('@', delimiter + 1);
    if (delimiter < 0) { return { model }; }
  }
  const ref = model.slice(0, delimiter).trim(), profileId = model.slice(delimiter + 1).trim();
  return ref && profileId ? { model: ref, profileId } : { model };
}

/** Undefined means selection cannot be resolved offline, not every backend. */
export function selectedProviders(config: unknown): Array<string | undefined> {
  return selectedOpenClawModels(config).map(model => model.profileId ? '' : model.provider);
}

export function selectedOpenClawModels(config: unknown): OpenClawModelSelection[] {
  const cfg = record(config) ? config : {};
  const agents = record(cfg.agents) ? cfg.agents : {};
  const defaults = record(agents.defaults) ? agents.defaults : {};
  const entries = Array.isArray(agents.list) ? agents.list.filter(record) : [];
  const selectedId = agentId((entries.find(entry => entry.default) ?? entries[0])?.id);
  const selected = entries.find(entry => agentId(entry.id) === selectedId)?.model;
  const defaultModel = defaults.model;
  let fallbacks: unknown[] | undefined;
  if (text(selected)) { fallbacks = []; }
  else if (record(selected)) {
    if (Object.hasOwn(selected, 'fallbacks')) { fallbacks = Array.isArray(selected.fallbacks) ? selected.fallbacks : undefined; }
    else if (Object.hasOwn(selected, 'primary') && primary(selected)) { fallbacks = []; }
  }
  fallbacks ??= record(defaultModel) && Array.isArray(defaultModel.fallbacks) ? defaultModel.fallbacks : [];
  const configuredModels = record(defaults.models) ? defaults.models : {};
  const modelConfig = record(cfg.models) ? cfg.models : {};
  const providerConfig = record(modelConfig.providers) ? modelConfig.providers : {};

  const resolve = (value: unknown): OpenClawModelSelection => {
    const raw = text(value);
    if (!raw) { return {}; }
    const split = splitOpenClawAuthProfile(raw);
    let model = split.model;
    const exactRow = Object.entries(providerConfig).some(([provider, config]) => record(config) && Array.isArray(config.models)
      && config.models.some(row => record(row) && `${provider}/${row.id}`.toLowerCase() === model!.toLowerCase()));
    if (!exactRow) {
      const alias = Object.entries(configuredModels).find(([, entry]) => record(entry) && text(entry.alias)?.toLowerCase() === model!.toLowerCase());
      if (alias) { model = alias[0]; }
    }
    if (splitOpenClawAuthProfile(model).profileId) { return { provider: '' }; }
    const slash = model.indexOf('/');
    if (slash > 0 && model.slice(slash + 1).trim()) { return { provider: model.slice(0, slash).trim().toLowerCase(), model: model.slice(slash + 1).trim(), profileId: split.profileId }; }
    if (slash >= 0) { return { provider: '' }; }
    const inferred = Object.entries(providerConfig).filter(([, config]) => record(config) && Array.isArray(config.models)
      && config.models.some(row => record(row) && text(row.id)?.toLowerCase() === model!.toLowerCase())).map(([provider]) => provider.trim().toLowerCase());
    return { provider: inferred.length === 1 ? inferred[0] : undefined, model, profileId: split.profileId };
  };
  return [resolve(primary(selected) ?? primary(defaultModel)),
    ...fallbacks.filter(value => !!text(value)).map(value => { const model = resolve(value); return { ...model, provider: model.provider ?? '' }; })];
}

/** A readiness hint only. No plugin execution, account mutation or secret resolution. */
export function hasOpenClawEnvironmentCredentials(config: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const providers = selectedProviders(config);
  return providers.some(provider => {
    // Preserve the existing generic Anthropic hint and recognize core OpenAI
    // credentials when no explicit backend can be established. Other provider
    // keys, including ambient GitHub tokens, require a configured selection.
    const names = provider === undefined ? [...candidates.anthropic, ...candidates.openai]
      : Object.hasOwn(candidates, aliases[provider] ?? provider) ? candidates[aliases[provider] ?? provider] : [];
    // Native normalization removes control/non-Latin1 characters before its
    // presence check. Readiness must reject values that normalize to nothing.
    return names.some(name => !!env[name]?.replace(/[^\x20-\x7e\xa0-\xff]/g, '').trim());
  });
}
