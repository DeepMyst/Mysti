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
 */

/**
 * Provider Manifest (Plan 02 Phase 1)
 *
 * Single source of truth for provider display identity (name/color/icon/
 * shortId) and the serializable per-provider record shipped to the webview.
 * Replaces (Phase 2 deletes) the triplicated webview display registries
 * (webviewContent.ts seams W5/W6/W7), and is consumed by
 * BrainstormManager/MentionRouter for display identity.
 *
 * Render rule: the webview renders from `capabilities`, never from provider
 * names. A provider id only selects logo + accent color from this registry.
 */

import type { ICliProvider, ProviderManifestEntry, ProviderSettingsSection } from './IProvider';
import type { ProviderManifestPayload, ProviderType } from '../../types';

/**
 * Bump when the ProviderManifestEntry shape changes incompatibly — a cached
 * webview (retainContextWhenHidden) compares this before trusting a payload.
 */
export const PROVIDER_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Structural slice of ProviderRegistry that the manifest builder needs.
 * Keeps the module testable without constructing the full registry.
 */
export interface ProviderRegistryLike {
  getAll(): ICliProvider[];
}

/** Display identity for one provider (logo paths are relative to resources/) */
export interface ProviderDisplayMeta {
  displayName: string;
  shortId: string;
  color: string;
  icon: string;
  iconDark?: string;
  themeAwareLogo?: boolean;
}

/**
 * Display metadata — values copied out of the webview registries
 * (webviewContent.ts AGENT_DISPLAY / agentNames / agentLogos maps); the
 * webview copies are deleted in Plan 02 Phase 2. Icon paths point into the
 * extension's `resources/` folder (same assets the webview already loads).
 */
export const PROVIDER_DISPLAY_META: Record<ProviderType, ProviderDisplayMeta> = {
  'claude-code': { displayName: 'Claude', shortId: 'claude', color: '#8B5CF6', icon: 'icons/Claude.png' },
  'openai-codex': {
    displayName: 'Codex',
    shortId: 'codex',
    color: '#10B981',
    icon: 'icons/openai.svg',
    iconDark: 'icons/openai_white.png',
    themeAwareLogo: true
  },
  'google-gemini': { displayName: 'Gemini', shortId: 'gemini', color: '#4285F4', icon: 'icons/gemini.png.webp' },
  'cline': { displayName: 'Cline', shortId: 'cline', color: '#F59E0B', icon: 'icons/cline.png' },
  'github-copilot': { displayName: 'Copilot', shortId: 'copilot', color: '#6366F1', icon: 'icons/copilot.png' },
  'cursor': { displayName: 'Cursor', shortId: 'cursor', color: '#00A3FF', icon: 'icons/cursor.png' },
  'openclaw': { displayName: 'OpenClaw', shortId: 'openclaw', color: '#E11D48', icon: 'icons/openclaw.png' },
  'opencode': { displayName: 'OpenCode', shortId: 'opencode', color: '#22C55E', icon: 'icons/opencode.png' },
  'ollama': { displayName: 'Ollama', shortId: 'ollama', color: '#FFFFFF', icon: 'icons/ollama.png' },
  'localai': { displayName: 'LocalAI', shortId: 'localai', color: '#06B6D4', icon: 'icons/localai.png' },
  'qwen-code': { displayName: 'Qwen', shortId: 'qwen', color: '#6C5CE7', icon: 'icons/qwen.png' }
};

/**
 * Per-provider custom-model setting keys (under the `mysti.` namespace).
 * Single source replacing the duplicated `providerModelKeys` maps in
 * ChatViewProvider (C1 — the write-side copy silently dropped 'qwen-code').
 */
export const PROVIDER_CUSTOM_MODEL_SETTING_KEYS: Record<ProviderType, string> = {
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

/**
 * Declarative provider-specific settings sections (replaces the hard-coded
 * codexSettingsSection in the webview — seam W4 — in Phase 2).
 */
const PROVIDER_SETTINGS_SECTIONS: Partial<Record<ProviderType, ProviderSettingsSection[]>> = {
  'openai-codex': [
    {
      id: 'codexProfile',
      label: 'Codex Profile',
      type: 'text',
      settingKey: 'codexProfile',
      placeholder: 'default',
      description: 'Codex profile from ~/.codex/config.toml. Leave empty to use the default profile.'
    }
  ],
  'openclaw': [
    {
      id: 'openclawGatewayUrl',
      label: 'Gateway URL',
      type: 'text',
      settingKey: 'openclawGatewayUrl',
      placeholder: 'ws://127.0.0.1:18789',
      description: 'URL of the OpenClaw Gateway WebSocket server.'
    }
  ],
  'ollama': [
    {
      id: 'ollamaEndpoint',
      label: 'Ollama Endpoint',
      type: 'text',
      settingKey: 'ollamaEndpoint',
      placeholder: 'http://localhost:11434',
      description: 'Ollama API server URL (host and port).'
    }
  ],
  'localai': [
    {
      id: 'localaiEndpoint',
      label: 'LocalAI Endpoint',
      type: 'text',
      settingKey: 'localaiEndpoint',
      placeholder: 'http://localhost:8080',
      description: 'LocalAI API server URL (host and port).'
    }
  ],
  'cursor': [
    {
      id: 'cursorApiKeyNote',
      label: 'API Key',
      type: 'note',
      settingKey: 'cursorApiKey',
      description: 'Authenticate by running "agent login" in a terminal, or set mysti.cursorApiKey in VS Code settings (used as CURSOR_API_KEY).'
    }
  ]
};

/** Fallback identity for providers registered without display metadata */
const FALLBACK_COLOR = '#888888';

/**
 * Get display identity for a provider id (undefined for unknown ids —
 * BrainstormManager uses this to validate selected agents).
 */
export function getProviderDisplayMeta(providerId: string): ProviderDisplayMeta | undefined {
  return (PROVIDER_DISPLAY_META as Record<string, ProviderDisplayMeta>)[providerId];
}

/** Display name for a provider id, falling back to the raw id */
export function getProviderDisplayName(providerId: string): string {
  return getProviderDisplayMeta(providerId)?.displayName ?? providerId;
}

/** Custom-model setting key (under `mysti.`) for a provider id, if any */
export function getCustomModelSettingKey(providerId: string): string | undefined {
  return (PROVIDER_CUSTOM_MODEL_SETTING_KEYS as Record<string, string>)[providerId];
}

/**
 * Setting keys (under `mysti.`) whose changes should re-broadcast the
 * manifest to open webviews — the keys backing declared settings sections.
 */
export function getManifestAffectingSettingKeys(): string[] {
  const keys = new Set<string>();
  for (const sections of Object.values(PROVIDER_SETTINGS_SECTIONS)) {
    for (const section of sections ?? []) {
      if (section.settingKey) {
        keys.add(section.settingKey);
      }
    }
  }
  return Array.from(keys);
}

/**
 * Build one serializable manifest entry per registered provider, merging
 * registry config (models/defaultModel), capabilities, display metadata,
 * the custom-model setting key, and declarative settings sections.
 *
 * `models` is intentionally "whatever the registry returns" so Plan 01's
 * dynamic model discovery can swap static arrays for runtime lists without
 * webview changes.
 */
export function buildProviderManifest(registry: ProviderRegistryLike): ProviderManifestEntry[] {
  return registry.getAll().map((provider) => {
    const id = provider.id as ProviderType;
    const meta = getProviderDisplayMeta(provider.id);
    const entry: ProviderManifestEntry = {
      id,
      displayName: meta?.displayName ?? provider.displayName,
      shortId: meta?.shortId ?? provider.id,
      color: meta?.color ?? FALLBACK_COLOR,
      icon: meta?.icon ?? '',
      capabilities: provider.capabilities,
      models: provider.config.models,
      defaultModel: provider.config.defaultModel,
      customModelSettingKey: getCustomModelSettingKey(provider.id) ?? '',
      settingsSections: PROVIDER_SETTINGS_SECTIONS[id] ?? []
    };
    if (meta?.iconDark) {
      entry.iconDark = meta.iconDark;
    }
    if (meta?.themeAwareLogo) {
      entry.themeAwareLogo = true;
    }
    return entry;
  });
}

/**
 * Build the versioned payload posted to the webview (initialState's
 * `providerManifest` field and the `manifestUpdated` message payload).
 */
export function buildProviderManifestPayload(registry: ProviderRegistryLike): ProviderManifestPayload {
  return {
    schemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION,
    providers: buildProviderManifest(registry)
  };
}
