/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HUB_INBOUND_TYPES, HUB_MIRROR_TYPES, HUB_UNBOUND_TYPES, isHubSection } from '../../src/chat/settingsHub';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Plan 31 — what the Mysti tab may say for its chat', () => {
  it('is exactly what the four panels send', () => {
    expect([...HUB_INBOUND_TYPES].sort()).toEqual([
      'createAgent', 'getBadgeShareText', 'importSkills', 'openConnections', 'openExternal',
      'openSettingKey', 'requestAgentLists', 'requestBadges', 'requestModels',
      'updateAgentConfig', 'updateSettings',
    ]);
  });

  it.each([
    'sendMessage', 'permissionResponse', 'cancelRequest', 'newConversation', 'autonomyLevelChanged',
    'uiReady', 'openSettingsHub', 'toggleAutonomous', 'confirmAutonomousActivation', 'askUserQuestionResponse',
  ])('never includes %s', (type) => {
    expect(HUB_INBOUND_TYPES.has(type)).toBe(false);
  });

  it('keeps only chat-free types once the chat is gone', () => {
    expect([...HUB_UNBOUND_TYPES].sort()).toEqual(['openConnections', 'openExternal', 'openSettingKey']);
    for (const t of HUB_UNBOUND_TYPES) { expect(HUB_INBOUND_TYPES.has(t)).toBe(true); }
  });

  it('lists only types the host handles and the webview really sends', () => {
    const host = read('src/providers/ChatViewProvider.ts');
    const web = read('media/chat/chat.js');
    for (const t of HUB_INBOUND_TYPES) {
      expect(host, `host has no case for ${t}`).toContain(`case '${t}'`);
      expect(web, `chat.js never sends ${t}`).toContain(`type: '${t}'`);
    }
  });
});

describe('Plan 31 — what the Mysti tab hears from its chat', () => {
  it('is panel data only', () => {
    expect([...HUB_MIRROR_TYPES].sort()).toEqual([
      'agentChanged', 'agentConfigUpdated', 'agentsUpdated', 'badgeShareCopied', 'badgesUpdate',
      'manifestUpdated', 'modelChanged', 'modelsUpdated', 'providerAvailability', 'providerSwitched',
      'settingsError',
    ]);
  });

  it.each(['responseChunk', 'messageAdded', 'permissionRequest', 'initialState', 'responseStarted', 'settingsSync'])(
    'never copies %s', (type) => { expect(HUB_MIRROR_TYPES.has(type)).toBe(false); },
  );
});

describe('isHubSection', () => {
  it.each(['settings', 'agents', 'badges', 'about'])('accepts %s', (s) => { expect(isHubSection(s)).toBe(true); });
  it.each(['connections', '', 'SETTINGS', null, undefined, 1, {}])('rejects %j', (s) => { expect(isHubSection(s)).toBe(false); });
});
