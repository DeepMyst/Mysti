/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 02 Phase 2 — webview side of the provider manifest.
 *
 * The webview renders from state.providerManifest (capabilities + display
 * metadata), never from provider-name literals. These tests extract the REAL
 * functions from the generated webview script (same approach as
 * tests/webview/wizardPanelId.test.ts) and execute them, so they cannot
 * drift from the shipped artifact:
 *
 *   - getManifestEntry / getManifestProviderIds / getThinkingStyle
 *   - getEntryLogo (theme-aware logo resolution, W7)
 *   - getAgentDisplay (identity fallback for unknown ids)
 *   - updateThinkingSectionVisibility (W1: hide for thinkingStyle 'none',
 *     advisory hint when thinkingLevelEffective === false)
 *   - getProviderMessage (W8: tolerant full-id/shortId suggestion matching)
 *   - defaultBrainstormPair (W10: first two manifest providers)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PROVIDER_MANIFEST_SCHEMA_VERSION } from '../../src/providers/base/ProviderManifest';

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Extract a top-level `function name(...) { ... }` declaration from JS source by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

let html: string;

beforeAll(() => {
  // The chat script was extracted to media/chat/chat.js (Plan 03 Phase 3c
  // Step 1); read it directly as the function-extraction source.
  html = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
});

// ---------------------------------------------------------------------------
// Fixture manifest (shape per ProviderManifestEntry)
// ---------------------------------------------------------------------------

function fixtureManifest() {
  return {
    schemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION,
    providers: [
      {
        id: 'claude-code', displayName: 'Claude', shortId: 'claude', color: '#8B5CF6',
        icon: 'icons/Claude.png',
        capabilities: { thinkingStyle: 'streamed', thinkingLevelEffective: true },
        models: [], defaultModel: 'm', customModelSettingKey: 'claudeCodeModel', settingsSections: []
      },
      {
        id: 'openai-codex', displayName: 'Codex', shortId: 'codex', color: '#10B981',
        icon: 'icons/openai.svg', iconDark: 'icons/openai_white.png', themeAwareLogo: true,
        capabilities: { thinkingStyle: 'complete-blocks', thinkingLevelEffective: false },
        models: [], defaultModel: 'm', customModelSettingKey: 'codexModel', settingsSections: []
      },
      {
        id: 'google-gemini', displayName: 'Gemini', shortId: 'gemini', color: '#4285F4',
        icon: 'icons/gemini.png.webp',
        capabilities: { thinkingStyle: 'none', thinkingLevelEffective: false },
        models: [], defaultModel: 'm', customModelSettingKey: 'geminiModel', settingsSections: []
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// getManifestEntry / getManifestProviderIds / getThinkingStyle
// ---------------------------------------------------------------------------

describe('webview getManifestEntry', () => {
  function run(state: any, id: string): any {
    const src = extractFunction(html, 'getManifestEntry');
    const fn = new Function('state', 'id', `${src}\nreturn getManifestEntry(id);`);
    return fn(state, id);
  }

  it('returns the entry for a known provider id', () => {
    const state = { providerManifest: fixtureManifest() };
    const entry = run(state, 'openai-codex');
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe('Codex');
    expect(entry.themeAwareLogo).toBe(true);
  });

  it('returns undefined for unknown ids (brainstorm pseudo-agent)', () => {
    const state = { providerManifest: fixtureManifest() };
    expect(run(state, 'brainstorm')).toBeUndefined();
  });

  it('returns undefined before the manifest arrives', () => {
    expect(run({ providerManifest: null }, 'claude-code')).toBeUndefined();
    expect(run({}, 'claude-code')).toBeUndefined();
  });
});

describe('webview getManifestProviderIds', () => {
  function run(state: any): string[] {
    const src = extractFunction(html, 'getManifestProviderIds');
    const fn = new Function('state', `${src}\nreturn getManifestProviderIds();`);
    return fn(state);
  }

  it('returns manifest provider ids in manifest order', () => {
    const state = { providerManifest: fixtureManifest() };
    expect(run(state)).toEqual(['claude-code', 'openai-codex', 'google-gemini']);
  });

  it('falls back to providerAvailability keys pre-manifest (wizard mode)', () => {
    const state = {
      providerManifest: null,
      providerAvailability: { 'claude-code': { available: true }, 'cursor': { available: false } }
    };
    expect(run(state)).toEqual(['claude-code', 'cursor']);
  });

  it('returns [] when neither manifest nor availability exists', () => {
    expect(run({})).toEqual([]);
  });
});

describe('webview getThinkingStyle', () => {
  function run(state: any, id: string): string | undefined {
    const src = extractFunction(html, 'getManifestEntry') + '\n' + extractFunction(html, 'getThinkingStyle');
    const fn = new Function('state', 'id', `${src}\nreturn getThinkingStyle(id);`);
    return fn(state, id);
  }

  it('returns the declared thinking style', () => {
    const state = { providerManifest: fixtureManifest() };
    expect(run(state, 'claude-code')).toBe('streamed');
    expect(run(state, 'openai-codex')).toBe('complete-blocks');
    expect(run(state, 'google-gemini')).toBe('none');
  });

  it('returns undefined for unknown ids / missing manifest', () => {
    expect(run({ providerManifest: fixtureManifest() }, 'nope')).toBeUndefined();
    expect(run({}, 'claude-code')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getEntryLogo (W7 — theme-aware logo resolution)
// ---------------------------------------------------------------------------

describe('webview getEntryLogo (W7)', () => {
  function run(entry: any, dark: boolean, logoMap: Record<string, string>): string {
    const src = extractFunction(html, 'getEntryLogo');
    const fn = new Function(
      'LOGO_BY_ICON_PATH', 'isDarkTheme', 'entry',
      `${src}\nreturn getEntryLogo(entry);`
    );
    return fn(logoMap, () => dark, entry);
  }

  const logoMap = {
    'icons/openai.svg': 'uri-light',
    'icons/openai_white.png': 'uri-dark',
    'icons/Claude.png': 'uri-claude'
  };

  it('uses iconDark in dark themes for themeAwareLogo entries', () => {
    const entry = fixtureManifest().providers[1];
    expect(run(entry, true, logoMap)).toBe('uri-dark');
  });

  it('uses icon in light themes for themeAwareLogo entries', () => {
    const entry = fixtureManifest().providers[1];
    expect(run(entry, false, logoMap)).toBe('uri-light');
  });

  it('ignores theme for non-theme-aware entries', () => {
    const entry = fixtureManifest().providers[0];
    expect(run(entry, true, logoMap)).toBe('uri-claude');
  });

  it('returns empty string for missing entries or unknown icon paths', () => {
    expect(run(undefined, false, logoMap)).toBe('');
    expect(run({ icon: 'icons/unknown.png' }, false, logoMap)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getAgentDisplay (identity fallback)
// ---------------------------------------------------------------------------

describe('webview getAgentDisplay', () => {
  function run(state: any, id: string, logoMap: Record<string, string>): any {
    const src = [
      extractFunction(html, 'getManifestEntry'),
      extractFunction(html, 'getEntryLogo'),
      extractFunction(html, 'getAgentDisplay')
    ].join('\n');
    const fn = new Function(
      'state', 'LOGO_BY_ICON_PATH', 'isDarkTheme', 'id',
      `${src}\nreturn getAgentDisplay(id);`
    );
    return fn(state, logoMap, () => false, id);
  }

  it('builds identity from the manifest entry', () => {
    const state = { providerManifest: fixtureManifest() };
    const display = run(state, 'claude-code', { 'icons/Claude.png': 'uri-claude' });
    expect(display).toEqual({ name: 'Claude', shortId: 'claude', color: '#8B5CF6', logo: 'uri-claude' });
  });

  it('falls back to the raw id for unknown agents', () => {
    const state = { providerManifest: fixtureManifest() };
    const display = run(state, 'mystery-agent', {});
    expect(display).toEqual({ name: 'mystery-agent', shortId: 'mystery-agent', color: '#888', logo: '' });
  });
});

// ---------------------------------------------------------------------------
// updateThinkingSectionVisibility (W1)
// ---------------------------------------------------------------------------

describe('webview updateThinkingSectionVisibility (W1)', () => {
  function run(state: any, provider: string) {
    const section: any = { style: { display: '' } };
    const hint: any = {
      hiddenState: null as boolean | null,
      classList: {
        toggle(cls: string, force: boolean) {
          if (cls === 'hidden') { hint.hiddenState = force; }
        }
      }
    };
    const fakeDocument = {
      getElementById(id: string) {
        if (id === 'thinking-section') { return section; }
        if (id === 'thinking-advisory-hint') { return hint; }
        return null;
      }
    };
    const src = extractFunction(html, 'getManifestEntry') + '\n' +
      extractFunction(html, 'updateThinkingSectionVisibility');
    const fn = new Function(
      'state', 'document', 'provider',
      `${src}\nupdateThinkingSectionVisibility(provider);`
    );
    fn(state, fakeDocument, provider);
    return { section, hint };
  }

  it('hides the selector when thinkingStyle is none (gemini & co.)', () => {
    const state = { providerManifest: fixtureManifest() };
    const { section } = run(state, 'google-gemini');
    expect(section.style.display).toBe('none');
  });

  it('shows the selector without advisory when levels are effective (claude)', () => {
    const state = { providerManifest: fixtureManifest() };
    const { section, hint } = run(state, 'claude-code');
    expect(section.style.display).toBe('block');
    expect(hint.hiddenState).toBe(true); // advisory hint hidden
  });

  it('shows the selector WITH the advisory hint when levels are not effective (codex)', () => {
    const state = { providerManifest: fixtureManifest() };
    const { section, hint } = run(state, 'openai-codex');
    expect(section.style.display).toBe('block');
    expect(hint.hiddenState).toBe(false); // advisory hint shown
  });

  it('keeps the selector visible for unknown ids (brainstorm, pre-manifest)', () => {
    const { section, hint } = run({ providerManifest: fixtureManifest() }, 'brainstorm');
    expect(section.style.display).toBe('block');
    expect(hint.hiddenState).toBe(true);

    const pre = run({ providerManifest: null }, 'claude-code');
    expect(pre.section.style.display).toBe('block');
  });
});

// ---------------------------------------------------------------------------
// getProviderMessage (W8 — tolerant suggestion matching)
// ---------------------------------------------------------------------------

describe('webview getProviderMessage (W8)', () => {
  function run(state: any, suggestion: any, provider: string): string {
    const src = extractFunction(html, 'getManifestEntry') + '\n' +
      extractFunction(html, 'getProviderMessage');
    const fn = new Function(
      'state', 'suggestion', 'provider',
      `${src}\nreturn getProviderMessage(suggestion, provider);`
    );
    return fn(state, suggestion, provider);
  }

  const suggestion = {
    messages: [
      { provider: 'claude', message: 'claude-msg' },
      { provider: 'codex', message: 'codex-msg' },
      { provider: 'qwen-code', message: 'qwen-msg' }
    ]
  };

  it('matches legacy shortId-keyed suggestion entries via the manifest', () => {
    const state = { providerManifest: fixtureManifest() };
    expect(run(state, suggestion, 'claude-code')).toBe('claude-msg');
    expect(run(state, suggestion, 'openai-codex')).toBe('codex-msg');
  });

  it('matches full provider ids directly (no manifest entry required)', () => {
    expect(run({ providerManifest: null }, suggestion, 'qwen-code')).toBe('qwen-msg');
  });

  it('falls back to the first message when nothing matches', () => {
    const state = { providerManifest: fixtureManifest() };
    expect(run(state, suggestion, 'google-gemini')).toBe('claude-msg');
  });

  it('supports the legacy single-message shape', () => {
    expect(run({}, { message: 'single' }, 'claude-code')).toBe('single');
  });
});

// ---------------------------------------------------------------------------
// defaultBrainstormPair (W10)
// ---------------------------------------------------------------------------

describe('webview defaultBrainstormPair (W10)', () => {
  function run(state: any): string[] {
    const src = extractFunction(html, 'getManifestProviderIds') + '\n' +
      extractFunction(html, 'defaultBrainstormPair');
    const fn = new Function('state', `${src}\nreturn defaultBrainstormPair();`);
    return fn(state);
  }

  it('returns the first two manifest providers', () => {
    const state = { providerManifest: fixtureManifest() };
    expect(run(state)).toEqual(['claude-code', 'openai-codex']);
  });

  it('degrades to fewer/zero entries without a manifest', () => {
    expect(run({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Generated-script invariants
// ---------------------------------------------------------------------------

describe('webview manifest wiring invariants', () => {
  it('handles the manifestUpdated message type', () => {
    expect(html).toContain("case 'manifestUpdated':");
  });

  it('wires the manifest schema version from the extension through the boot object', () => {
    // Post-extraction (Plan 03 Phase 3c Step 1) chat.js sources the expected
    // version from the bootstrap object instead of a baked-in literal...
    expect(html).toContain('EXPECTED_MANIFEST_SCHEMA_VERSION = window.__MYSTI_BOOT__.manifestSchemaVersion');
    // ...and the loader embeds the version the extension actually ships.
    const loader = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'webviewContent.ts'), 'utf8');
    expect(loader).toContain('manifestSchemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION');
    expect(PROVIDER_MANIFEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('renders provider settings sections declaratively (W4)', () => {
    expect(html).toContain('function renderProviderSettingsSections(');
    // the mount point lives in the extracted markup (media/chat/index.html)
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'index.html'), 'utf8');
    expect(indexHtml).toContain('id="provider-settings-sections"');
    // the old hard-coded codex section is gone (markup + toggle logic)
    expect(indexHtml).not.toContain('id="codex-settings-section"');
    expect(html).not.toContain('codexSettingsSection.classList');
  });

  it('no longer ships the three provider display registries (W5/W6/W7)', () => {
    expect(html).not.toContain('var AGENT_DISPLAY');
    expect(html).not.toContain('var agentNames');
    expect(html).not.toContain('var agentLogos');
    expect(html).not.toContain('getOpenAILogo');
  });
});
