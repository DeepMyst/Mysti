/**
 * Provider Manifest tests (Plan 02 Phase 1).
 *
 * Verifies that buildProviderManifest() produces one fully-populated,
 * serializable entry per registered provider: capability fields present,
 * display identity merged in, custom-model setting keys complete (C1 drift
 * fix), and declarative settingsSections shaped as the webview expects.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as vscode from 'vscode';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import {
  buildProviderManifest,
  buildProviderManifestPayload,
  getCustomModelSettingKey,
  getManifestAffectingSettingKeys,
  getProviderDisplayMeta,
  getProviderDisplayName,
  PROVIDER_MANIFEST_SCHEMA_VERSION,
  PROVIDER_NPM_PACKAGES,
  getProviderNpmPackage
} from '../../src/providers/base/ProviderManifest';
import type { ProviderManifestEntry } from '../../src/providers/base/IProvider';

// Minimal mock extension context for provider constructors
function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
      setKeysForSync: () => {},
    },
    workspaceState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
    },
    extensionPath: '/mock/extension',
    extensionUri: vscode.Uri.file('/mock/extension'),
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global-storage'),
    logUri: vscode.Uri.file('/mock/logs'),
    extensionMode: 1,
    extension: {} as never,
    environmentVariableCollection: {} as never,
    secrets: {} as never,
    languageModelAccessInformation: {} as never,
  } as unknown as vscode.ExtensionContext;
}

const ALL_PROVIDER_IDS = [
  'claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot',
  'cursor', 'openclaw', 'opencode', 'ollama', 'localai', 'qwen-code', 'hermes', 'continue', 'openrouter', 'kimi-code'
];

describe('buildProviderManifest', () => {
  let registry: ProviderRegistry;
  let manifest: ProviderManifestEntry[];
  let byId: Map<string, ProviderManifestEntry>;

  beforeAll(() => {
    registry = new ProviderRegistry(createMockContext());
    manifest = buildProviderManifest(registry);
    byId = new Map(manifest.map((e) => [e.id, e]));
  });

  it('contains one entry per registered provider (all 15)', () => {
    expect(manifest.length).toBe(registry.getIds().length);
    for (const id of ALL_PROVIDER_IDS) {
      expect(byId.has(id), `missing manifest entry for ${id}`).toBe(true);
    }
  });

  it('populates display identity and model data on every entry', () => {
    for (const entry of manifest) {
      expect(entry.displayName, `${entry.id} displayName`).toBeTruthy();
      expect(entry.shortId, `${entry.id} shortId`).toBeTruthy();
      expect(entry.color, `${entry.id} color`).toMatch(/^#/);
      expect(entry.icon, `${entry.id} icon`).toBeTruthy();
      expect(Array.isArray(entry.models), `${entry.id} models`).toBe(true);
      expect(entry.defaultModel, `${entry.id} defaultModel`).toBeTruthy();
      expect(Array.isArray(entry.settingsSections), `${entry.id} settingsSections`).toBe(true);
    }
  });

  it('populates every Plan 02 capability field on every entry', () => {
    const thinkingStyles = ['streamed', 'complete-blocks', 'none'];
    const planModes = ['native', 'detected', 'none'];
    const sessionKinds = ['cli-resume', 'prompt-history', 'none'];
    const modelSelections = ['full', 'custom-only', 'none'];
    const usageConventions = ['anthropic', 'openai', 'none', 'auto'];

    for (const entry of manifest) {
      const c = entry.capabilities;
      expect(thinkingStyles, `${entry.id} thinkingStyle`).toContain(c.thinkingStyle);
      expect(typeof c.thinkingLevelEffective, `${entry.id} thinkingLevelEffective`).toBe('boolean');
      expect(planModes, `${entry.id} planMode`).toContain(c.planMode);
      expect(sessionKinds, `${entry.id} sessionKind`).toContain(c.sessionKind);
      expect(typeof c.emitsToolResults, `${entry.id} emitsToolResults`).toBe('boolean');
      expect(typeof c.emitsUsage, `${entry.id} emitsUsage`).toBe('boolean');
      // A backend that cannot report usage has no convention to speak, so it
      // must declare 'none' — anything else claims a cache signal that will
      // never arrive, and the compaction economics would act on it.
      expect(usageConventions, `${entry.id} usageConvention`).toContain(c.usageConvention);
      if (!c.emitsUsage) {
        expect(c.usageConvention, `${entry.id} declares emitsUsage:false`).toBe('none');
      }
      expect(modelSelections, `${entry.id} modelSelection`).toContain(c.modelSelection);
    }
  });

  it('declares a token-accounting convention per backend, not one shared guess', () => {
    // Anthropic's prompt buckets are DISJOINT; OpenAI reports cached tokens as a
    // SUBSET of input. A single shared fill formula is wrong for one of them in
    // whichever direction it is written, so each backend names its own.
    // See src/services/TokenAccounting.ts.
    expect(byId.get('claude-code')!.capabilities.usageConvention).toBe('anthropic');
    expect(byId.get('openai-codex')!.capabilities.usageConvention).toBe('openai');
    // Backends that front other vendors resolve per-turn from the model id.
    expect(byId.get('cline')!.capabilities.usageConvention).toBe('none');
    expect(byId.get('openrouter')!.capabilities.usageConvention).toBe('auto');
    expect(byId.get('localai')!.capabilities.usageConvention).toBe('auto');
    // No cache accounting on the transport Mysti drives.
    expect(byId.get('google-gemini')!.capabilities.usageConvention).toBe('none');
    expect(byId.get('hermes')!.capabilities.usageConvention).toBe('none');
    expect(byId.get('kimi-code')!.capabilities.usageConvention).toBe('none');
  });

  it('matches the verified capability matrix (spot checks)', () => {
    const claude = byId.get('claude-code')!.capabilities;
    expect(claude.thinkingStyle).toBe('streamed');
    expect(claude.thinkingLevelEffective).toBe(true);
    expect(claude.planMode).toBe('native');
    expect(claude.sessionKind).toBe('cli-resume');

    const codex = byId.get('openai-codex')!.capabilities;
    expect(codex.thinkingStyle).toBe('complete-blocks');
    expect(codex.sessionKind).toBe('prompt-history');

    const gemini = byId.get('google-gemini')!.capabilities;
    expect(gemini.thinkingStyle).toBe('none');
    expect(gemini.sessionKind).toBe('prompt-history');

    const cline = byId.get('cline')!.capabilities;
    expect(cline.thinkingStyle).toBe('complete-blocks');
    expect(cline.thinkingLevelEffective).toBe(false);
    expect(cline.sessionKind).toBe('prompt-history');
    expect(cline.modelSelection).toBe('full');

    // The pinned ACP bridge reports tools, but this release exposes no
    // token usage. Fresh native sessions receive prompt history.
    const copilotUsage = byId.get('github-copilot')!.capabilities;
    expect(copilotUsage.emitsUsage).toBe(false);

    const copilot = byId.get('github-copilot')!.capabilities;
    expect(copilot.supportsToolUse).toBe(true);
    expect(copilot.emitsToolResults).toBe(true);
    expect(copilot.sessionKind).toBe('prompt-history');

    const cursor = byId.get('cursor')!.capabilities;
    expect(cursor.sessionKind).toBe('prompt-history');

    const openclaw = byId.get('openclaw')!.capabilities;
    expect(openclaw.emitsUsage).toBe(false);
    expect(openclaw.modelSelection).toBe('none');
    expect(openclaw.supportsChannels).toBe(true);

    const opencode = byId.get('opencode')!.capabilities;
    expect(opencode.sessionKind).toBe('prompt-history');
    expect(opencode.modelSelection).toBe('custom-only');

    const qwen = byId.get('qwen-code')!.capabilities;
    expect(qwen.thinkingStyle).toBe('complete-blocks');
    expect(qwen.sessionKind).toBe('prompt-history');

    // Hermes: ACP persistent transport; model chosen inside hermes itself
    const hermes = byId.get('hermes')!.capabilities;
    expect(hermes.supportsPersistentProcess).toBe(true);
    expect(hermes.modelSelection).toBe('none');
    expect(hermes.sessionKind).toBe('cli-resume');
    expect(hermes.emitsToolResults).toBe(true);

    // Continue: headless final-text output — no tool events, no usage
    const continueCaps = byId.get('continue')!.capabilities;
    expect(continueCaps.supportsToolUse).toBe(false);
    expect(continueCaps.emitsToolResults).toBe(false);
    expect(continueCaps.emitsUsage).toBe(false);
    expect(continueCaps.sessionKind).toBe('prompt-history');
    expect(continueCaps.modelSelection).toBe('custom-only');

    // Lying flag corrected: Ollama attachments are dropped today
    const ollama = byId.get('ollama')!.capabilities;
    expect(ollama.supportsImages).toBe(false);
    expect(ollama.emitsToolResults).toBe(false);
    expect(ollama.sessionKind).toBe('prompt-history');
    expect(ollama.modelSelection).toBe('custom-only');

    const localai = byId.get('localai')!.capabilities;
    expect(localai.emitsToolResults).toBe(false);
    expect(localai.sessionKind).toBe('prompt-history');
    expect(localai.modelSelection).toBe('custom-only');
  });

  it('distinguishes native execution, proposals and chat across every registered backend', () => {
    for (const entry of manifest) {
      const expected = ['ollama', 'localai'].includes(entry.id) ? 'proposal-only' : entry.id === 'openrouter' ? 'none' : 'native';
      expect(entry.capabilities.toolExecution, entry.id).toBe(expected);
    }
    expect(byId.get('cursor')!.capabilities.planMode).toBe('none');
    expect(byId.get('continue')!.capabilities.planMode).toBe('none');
    expect(byId.get('cursor')!.capabilities.supportsPromptEnhancement).toBe(false);
  });

  it('carries a complete customModelSettingKey map (C1 qwen-code drift fix)', () => {
    const expected: Record<string, string> = {
      'claude-code': 'claudeCodeModel',
      'openai-codex': 'codexModel',
      'google-gemini': 'geminiModel',
      'cline': 'clineModel',
      'github-copilot': 'copilotModel',
      'cursor': 'cursorModel',
      'openclaw': 'openclawModel',
      'opencode': 'opencodeModel',
      'ollama': 'ollamaModel',
      'localai': 'localaiModel',
      'qwen-code': 'qwenCodeModel'
    };
    for (const [id, key] of Object.entries(expected)) {
      expect(byId.get(id)!.customModelSettingKey, id).toBe(key);
      expect(getCustomModelSettingKey(id), id).toBe(key);
    }
  });

  it('declares the expected settingsSections shapes', () => {
    const codexSections = byId.get('openai-codex')!.settingsSections;
    expect(codexSections).toHaveLength(1);
    expect(codexSections[0]).toMatchObject({ type: 'text', settingKey: 'codexProfile' });

    const ollamaSections = byId.get('ollama')!.settingsSections;
    expect(ollamaSections.some((s) => s.type === 'text' && s.settingKey === 'ollamaEndpoint')).toBe(true);

    const localaiSections = byId.get('localai')!.settingsSections;
    expect(localaiSections.some((s) => s.type === 'text' && s.settingKey === 'localaiEndpoint')).toBe(true);

    const openclawSections = byId.get('openclaw')!.settingsSections;
    expect(openclawSections.some((s) => s.type === 'text' && s.settingKey === 'openclawGatewayUrl')).toBe(true);

    const cursorSections = byId.get('cursor')!.settingsSections;
    expect(cursorSections.some((s) => s.type === 'note' && s.settingKey === 'cursorApiKey')).toBe(true);

    // Every declared section is well-formed
    for (const entry of manifest) {
      for (const section of entry.settingsSections) {
        expect(section.id, `${entry.id} section id`).toBeTruthy();
        expect(section.label, `${entry.id} section label`).toBeTruthy();
        expect(['text', 'number', 'select', 'note']).toContain(section.type);
      }
    }
  });

  it('flags the theme-aware OpenAI logo case', () => {
    const codex = byId.get('openai-codex')!;
    expect(codex.themeAwareLogo).toBe(true);
    expect(codex.iconDark).toBeTruthy();
    // No other provider needs theme-aware logos today
    for (const entry of manifest) {
      if (entry.id !== 'openai-codex') {
        expect(entry.themeAwareLogo, entry.id).toBeUndefined();
      }
    }
  });

  it('builds a versioned payload for the webview messages', () => {
    const payload = buildProviderManifestPayload(registry);
    expect(payload.schemaVersion).toBe(PROVIDER_MANIFEST_SCHEMA_VERSION);
    expect(payload.providers.length).toBe(manifest.length);
    // Must survive postMessage serialization
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('exposes display helpers used by BrainstormManager/MentionRouter', () => {
    expect(getProviderDisplayMeta('qwen-code')?.displayName).toBe('Qwen');
    expect(getProviderDisplayMeta('not-a-provider')).toBeUndefined();
    expect(getProviderDisplayName('opencode')).toBe('OpenCode');
    expect(getProviderDisplayName('unknown-id')).toBe('unknown-id');
  });

  it('reports the manifest-affecting setting keys for change listeners', () => {
    const keys = getManifestAffectingSettingKeys();
    for (const expected of ['codexProfile', 'ollamaEndpoint', 'localaiEndpoint', 'openclawGatewayUrl', 'cursorApiKey']) {
      expect(keys).toContain(expected);
    }
  });

  it('falls back gracefully for providers without display metadata', () => {
    const fakeRegistry = {
      getAll: () => [
        {
          id: 'provider-13',
          displayName: 'Provider Thirteen',
          capabilities: byId.get('claude-code')!.capabilities,
          config: { name: 'provider-13', displayName: 'Provider Thirteen', models: [], defaultModel: 'p13-default' }
        }
      ]
    } as never;
    const entries = buildProviderManifest(fakeRegistry);
    expect(entries).toHaveLength(1);
    expect(entries[0].displayName).toBe('Provider Thirteen');
    expect(entries[0].shortId).toBe('provider-13');
    expect(entries[0].color).toBe('#888888');
    expect(entries[0].customModelSettingKey).toBe('');
    expect(entries[0].settingsSections).toEqual([]);
  });
});

/**
 * PROVIDER_NPM_PACKAGES backs the CLI update checker. It is a TOTAL Record, so
 * a new provider cannot be added without declaring a package or an explicit
 * null — but totality alone does not stop a WRONG name, and a wrong name means
 * either a silent no-op or an update card pointing at somebody else's package.
 * These tests tie the map to what each provider actually tells users to install.
 */
describe('PROVIDER_NPM_PACKAGES', () => {
  let registry: ProviderRegistry;

  beforeAll(() => {
    registry = new ProviderRegistry(createMockContext());
  });

  it('declares an entry for every provider id', () => {
    for (const id of ALL_PROVIDER_IDS) {
      expect(
        Object.prototype.hasOwnProperty.call(PROVIDER_NPM_PACKAGES, id),
        `${id} has no PROVIDER_NPM_PACKAGES entry`
      ).toBe(true);
    }
  });

  it('names a package only for providers whose install command is an npm install', () => {
    for (const provider of registry.getAll()) {
      const declared = getProviderNpmPackage(provider.id);
      let installCommand = '';
      try {
        installCommand = provider.getInstallCommand() || '';
      } catch {
        installCommand = '';
      }
      // A provider whose recommended install is a script may still publish the
      // same CLI on npm and offer it as a wizard method (Kimi Code 2.x); that
      // npm method is then what the declared package must match.
      const npmMethod = (provider.getInstallMethods?.() ?? [])
        .map(method => method.command)
        .find(command => /\bnpm\s+(install|i)\s+-g\b/.test(command));
      if (npmMethod && !/\bnpm\s+(install|i)\s+-g\b/.test(installCommand)) { installCommand = npmMethod; }
      const isNpmInstall = /\bnpm\s+(install|i)\s+-g\b/.test(installCommand);

      if (declared) {
        expect(
          isNpmInstall,
          `${provider.id} declares npm package "${declared}" but its install command is not an npm -g install: ${installCommand}`
        ).toBe(true);
        expect(
          installCommand.includes(declared),
          `${provider.id} declares "${declared}" but installs something else: ${installCommand}`
        ).toBe(true);
      } else if (isNpmInstall) {
        throw new Error(
          `${provider.id} installs from npm (${installCommand}) but declares null — it will never be update-checked`
        );
      }
    }
  });

  it('stores bare package names, with no @latest dist-tag baked in', () => {
    for (const pkg of Object.values(PROVIDER_NPM_PACKAGES)) {
      if (pkg === null) { continue; }
      expect(pkg, `"${pkg}" must not carry a dist-tag`).not.toMatch(/@latest$/);
      // A shell metacharacter here would end up in an update command.
      expect(pkg, `"${pkg}" is not a plain package name`).toMatch(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
    }
  });

  it('getProviderNpmPackage returns undefined for null and unknown ids', () => {
    expect(getProviderNpmPackage('cursor')).toBeUndefined();
    expect(getProviderNpmPackage('not-a-provider')).toBeUndefined();
    expect(getProviderNpmPackage('openai-codex')).toBe('@openai/codex');
  });
});

/**
 * The curated catalogue is the ONLY delivery path for a model a backend hides
 * from its own discovery. GPT-6 Astra is exactly that case (Codex CLI 0.153.1
 * supports it but keeps it out of the model picker), and Codex implements no
 * discoverModels at all — so if this entry regresses, the model becomes
 * unreachable in Mysti with no other test noticing.
 */
describe('curated catalogue: GPT-6 Astra (Codex)', () => {
  let codex: { config: { models: Array<{ id: string; name: string; contextWindow?: number; releasedAt?: string }>; defaultModel: string } };

  beforeAll(() => {
    const registry = new ProviderRegistry(createMockContext());
    codex = registry.getAll().find(p => p.id === 'openai-codex') as never;
  });

  it('is present with its real context window', () => {
    const astra = codex.config.models.find(m => m.id === 'gpt-6-astra');
    expect(astra, 'gpt-6-astra missing from the Codex catalogue').toBeDefined();
    expect(astra!.name).toBe('GPT-6 Astra');
    expect(astra!.contextWindow).toBe(1050000);
  });

  it('carries a parseable, non-future releasedAt so it can announce through a baseline', () => {
    const astra = codex.config.models.find(m => m.id === 'gpt-6-astra')!;
    expect(astra.releasedAt, 'without releasedAt it can never be announced on a first baseline').toBeTruthy();
    const ts = Date.parse(astra.releasedAt!);
    expect(Number.isNaN(ts), `releasedAt "${astra.releasedAt}" is not a date`).toBe(false);
    // A future date fails the freshness check closed and would never announce.
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('is NOT the default model — it is Trusted-Access + CLI-version gated', () => {
    // Defaulting to it would break every user without Trusted Access or on a
    // Codex CLI older than 0.153.1.
    expect(codex.config.defaultModel).not.toBe('gpt-6-astra');
  });
});
