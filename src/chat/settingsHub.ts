/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 31 — the Mysti tab is the chat webview in a hub layout, acting for the
 * chat that opened it. These lists are the whole boundary between the two:
 * what the tab may say on the chat's behalf, and what the chat is told that
 * the tab also needs to hear.
 */

export type HubSection = 'settings' | 'agents' | 'badges' | 'about';

const HUB_SECTIONS: ReadonlySet<string> = new Set<HubSection>(['settings', 'agents', 'badges', 'about']);

/**
 * Webview → host types the tab may send; each is re-bound to the origin chat.
 * A type belongs here only if a control inside one of the four panels sends
 * it. Everything else — sendMessage, permissionResponse, autonomyLevelChanged
 * (posted by initializeState itself), uiReady, openSettingKey (the chat-output
 * refusal card's button) — is dropped, so a hidden card or a boot side effect
 * in the tab can never act for the chat.
 */
export const HUB_INBOUND_TYPES: ReadonlySet<string> = new Set([
  'updateSettings', 'requestModels', 'updateAgentConfig', 'requestAgentLists',
  'createAgent', 'importSkills', 'requestBadges', 'getBadgeShareText',
  'openExternal', 'openConnections',
]);

/** The subset that needs no chat, still honoured after the origin chat closes. */
export const HUB_UNBOUND_TYPES: ReadonlySet<string> = new Set(['openExternal', 'openConnections']);

/** Host → origin-chat types the tab also receives. Chat output never is. */
export const HUB_MIRROR_TYPES: ReadonlySet<string> = new Set([
  'modelsUpdated', 'providerAvailability', 'manifestUpdated', 'agentConfigUpdated',
  'agentsUpdated', 'badgesUpdate', 'badgeShareCopied', 'settingsError',
  'providerSwitched', 'agentChanged', 'modelChanged',
]);

export function isHubSection(value: unknown): value is HubSection {
  return typeof value === 'string' && HUB_SECTIONS.has(value);
}
