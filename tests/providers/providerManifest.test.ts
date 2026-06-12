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
  PROVIDER_MANIFEST_SCHEMA_VERSION
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
  'cursor', 'openclaw', 'opencode', 'ollama', 'localai', 'qwen-code'
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

  it('contains one entry per registered provider (all 11)', () => {
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

    for (const entry of manifest) {
      const c = entry.capabilities;
      expect(thinkingStyles, `${entry.id} thinkingStyle`).toContain(c.thinkingStyle);
      expect(typeof c.thinkingLevelEffective, `${entry.id} thinkingLevelEffective`).toBe('boolean');
      expect(planModes, `${entry.id} planMode`).toContain(c.planMode);
      expect(sessionKinds, `${entry.id} sessionKind`).toContain(c.sessionKind);
      expect(typeof c.emitsToolResults, `${entry.id} emitsToolResults`).toBe('boolean');
      expect(typeof c.emitsUsage, `${entry.id} emitsUsage`).toBe('boolean');
      expect(modelSelections, `${entry.id} modelSelection`).toContain(c.modelSelection);
    }
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
    expect(gemini.sessionKind).toBe('cli-resume');

    const cline = byId.get('cline')!.capabilities;
    expect(cline.thinkingStyle).toBe('complete-blocks');
    expect(cline.thinkingLevelEffective).toBe(true);
    expect(cline.sessionKind).toBe('prompt-history');
    expect(cline.modelSelection).toBe('none');

    // Lying flags corrected: Copilot CLI emits plain text — no tool events
    const copilot = byId.get('github-copilot')!.capabilities;
    expect(copilot.supportsToolUse).toBe(false);
    expect(copilot.emitsToolResults).toBe(false);
    expect(copilot.sessionKind).toBe('prompt-history');

    const cursor = byId.get('cursor')!.capabilities;
    expect(cursor.sessionKind).toBe('none');

    const openclaw = byId.get('openclaw')!.capabilities;
    expect(openclaw.emitsUsage).toBe(false);
    expect(openclaw.modelSelection).toBe('none');
    expect(openclaw.supportsChannels).toBe(true);

    const opencode = byId.get('opencode')!.capabilities;
    expect(opencode.sessionKind).toBe('cli-resume');
    expect(opencode.modelSelection).toBe('custom-only');

    const qwen = byId.get('qwen-code')!.capabilities;
    expect(qwen.thinkingStyle).toBe('complete-blocks');
    expect(qwen.sessionKind).toBe('cli-resume');

    // Lying flag corrected: Ollama attachments are dropped today
    const ollama = byId.get('ollama')!.capabilities;
    expect(ollama.supportsImages).toBe(false);
    expect(ollama.emitsToolResults).toBe(false);
    expect(ollama.sessionKind).toBe('none');
    expect(ollama.modelSelection).toBe('custom-only');

    const localai = byId.get('localai')!.capabilities;
    expect(localai.emitsToolResults).toBe(false);
    expect(localai.sessionKind).toBe('none');
    expect(localai.modelSelection).toBe('custom-only');
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
