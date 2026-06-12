/**
 * Identity-from-manifest tests (Plan 02 Phase 1, task 5).
 *
 * BrainstormManager and MentionRouter no longer keep local display-name/color
 * registries — both derive provider identity from the Provider Manifest
 * module. These tests pin that behavior, including providers the old local
 * maps missed (MentionRouter's 7-entry map had no qwen-code/opencode/
 * ollama/localai).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { MockProviderManager } from '../helpers/mockProviderManager';
import { createTestBrainstormManager, configureBrainstorm } from '../helpers/brainstormFactory';
import {
  createTestMentionRouter,
  agentMention,
  createMentionSettings,
  collectMentionChunks
} from '../helpers/mentionFactory';
import { getProviderDisplayMeta } from '../../src/providers/base/ProviderManifest';
import type { AgentType, SubAgentResponse } from '../../src/types';

describe('BrainstormManager identity from manifest', () => {
  beforeEach(() => {
    clearMockConfig();
  });

  it('builds agent configs with manifest display names and colors', () => {
    const { manager } = createTestBrainstormManager(new MockProviderManager());
    const configs = (manager as unknown as {
      _buildAgentConfigs(ids: AgentType[]): Array<{ id: AgentType; displayName: string; color: string; icon: string }>;
    })._buildAgentConfigs(['claude-code', 'qwen-code', 'ollama']);

    for (const config of configs) {
      const meta = getProviderDisplayMeta(config.id);
      expect(meta, config.id).toBeDefined();
      expect(config.displayName).toBe(meta!.displayName);
      expect(config.color).toBe(meta!.color);
      // Brainstorm emoji badge stays local but must be present
      expect(config.icon).toBeTruthy();
    }

    // Spot-check values the old local AGENT_STYLES carried
    expect(configs[0].displayName).toBe('Claude');
    expect(configs[0].color).toBe('#8B5CF6');
    expect(configs[1].displayName).toBe('Qwen');
    expect(configs[1].color).toBe('#6C5CE7');
    expect(configs[2].displayName).toBe('Ollama');
  });

  it('validates selected agents against the manifest registry', () => {
    const { manager } = createTestBrainstormManager(new MockProviderManager());
    // One invalid agent id → falls back to the default pair
    configureBrainstorm({ agents: ['claude-code', 'not-a-provider' as AgentType], strategy: 'quick' });
    const config = (manager as unknown as { _getConfig(): { agents: AgentType[] } })._getConfig();
    expect(config.agents).toEqual(['claude-code', 'openai-codex']);
  });
});

describe('MentionRouter identity from manifest', () => {
  let mockPM: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    mockPM = new MockProviderManager();
  });

  it('formats sub-agent context with manifest display names (incl. previously missing providers)', () => {
    const { router } = createTestMentionRouter(mockPM);

    const responses = new Map<AgentType, SubAgentResponse>([
      ['opencode', { agentId: 'opencode', content: 'OpenCode result', status: 'complete' }],
      ['qwen-code', { agentId: 'qwen-code', content: '', status: 'error', error: 'boom' }]
    ]);

    const context = router.formatSubAgentContext(responses);
    // 'opencode'/'qwen-code' were absent from the old 7-entry local map and
    // rendered as raw ids — now they resolve via the manifest.
    expect(context).toContain('Sub-agent response from OpenCode');
    expect(context).toContain('Qwen sub-agent(s) failed');
    expect(context).not.toContain('opencode ---');
    expect(context).not.toContain('qwen-code sub-agent');
  });

  it('uses the manifest display name in not-installed errors', async () => {
    const { router, mockPM: pm } = createTestMentionRouter(mockPM);
    pm.setProviderNotInstalled('qwen-code', 'npm install -g @qwen-code/qwen-code@latest');

    const mentions = [agentMention('qwen', 'qwen-code', 0)];
    const settings = createMentionSettings();
    const chunks = await collectMentionChunks(
      router.processMentions('@qwen review this', mentions, [], settings, null, 'panel-qwen-identity')
    );

    const errors = chunks.filter((c) => c.type === 'subagent_error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].content).toContain('Qwen CLI is not installed');
  });
});
