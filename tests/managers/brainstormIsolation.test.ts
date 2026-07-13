/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Brainstorm child isolation + permission floor (Plan 18 Wave 1, S1/S2/S4/S7).
 *
 * S2: brainstorm children must be dispatched READ-ONLY — the stream-level
 *     tool-use gate is not wired on the brainstorm path, so the CLI permission
 *     mode (driven by accessLevel) is the only enforcement.
 * S1: children must run under composite `${panelId}-brainstorm-${agentId}`
 *     panel keys so cancelSession's composite cancels reach real processes.
 *     The old B9 test asserted cancelRequest CALLS against a string-recording
 *     mock — it could not see that the real ProviderManager no-opped on keys
 *     nothing was registered under. The integration test here goes through the
 *     REAL ProviderManager to pin the full chain.
 * S4: composite keys also stop brainstorm from resuming the panel's main chat
 *     session when an agent equals the panel's provider.
 * S7: session teardown must dispose the children's provider-side sessions and
 *     compaction keys.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { clearMockConfig, clearConfigurationListeners, setMockConfig } from '../helpers/mockVscode';
import { MockProviderManager } from '../helpers/mockProviderManager';
import {
  createTestBrainstormManager,
  configureBrainstorm,
  createMockSettings,
  makeTextChunks,
  collectChunks
} from '../helpers/brainstormFactory';
import { BrainstormManager } from '../../src/managers/BrainstormManager';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { CompactionManager } from '../../src/managers/CompactionManager';
import type { ICliProvider } from '../../src/providers/base/IProvider';
import type { StreamChunk, Settings } from '../../src/types';
import * as vscode from 'vscode';

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [], setKeysForSync: () => {} },
    workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    extensionPath: '/mock/extension',
    extensionUri: vscode.Uri.file('/mock/extension'),
    extensionMode: 1,
  } as unknown as vscode.ExtensionContext;
}

describe('Brainstorm child isolation (S1/S2/S4/S7)', () => {
  let mockPM: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    mockPM = new MockProviderManager();
  });

  afterEach(() => {
    clearMockConfig();
    clearConfigurationListeners();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // S2 + S4: children dispatch read-only, under composite panel keys
  // =========================================================================
  it('dispatches every child (agents + synthesis) read-only under composite panel ids', async () => {
    const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
    configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
    pm.setProviderAvailable('claude-code');
    pm.setProviderAvailable('google-gemini');
    pm.setProviderChunks('claude-code', makeTextChunks(['Claude says hi.']));
    pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini says hi.']));

    // The user's own settings are permissive — children must NOT inherit that.
    const settings = createMockSettings({ accessLevel: 'full-access' } as Partial<Settings>);
    await collectChunks(manager.startBrainstormSession('q', [], settings, 'panel-iso'));

    expect(pm.sendCalls.length).toBeGreaterThanOrEqual(3); // 2 agents + synthesis
    for (const call of pm.sendCalls) {
      expect(call.panelId).toBe(`panel-iso-brainstorm-${call.providerId}`);
      expect(call.settings.accessLevel).toBe('read-only');
      expect(call.settings.provider).toBe(call.providerId);
    }
    // Synthesis went out under the synthesis agent's own composite key
    expect(pm.sendCalls.some(c => c.panelId === 'panel-iso-brainstorm-claude-code')).toBe(true);
    expect(pm.sendCalls.some(c => c.panelId === 'panel-iso-brainstorm-google-gemini')).toBe(true);
  });

  // =========================================================================
  // S2 visibility: tool_use chunks surface instead of being dropped
  // =========================================================================
  it('surfaces child tool_use activity on the thinking channel, not into synthesis content', async () => {
    const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
    configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
    pm.setProviderAvailable('claude-code');
    pm.setProviderAvailable('google-gemini');
    const withTool: StreamChunk[] = [
      { type: 'tool_use', toolCall: { id: 't1', name: 'Read', input: {}, status: 'running' } } as StreamChunk,
      ...makeTextChunks(['Analysis after reading.'])
    ];
    pm.setProviderChunks('claude-code', withTool);
    pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini analysis.']));

    const chunks = await collectChunks(manager.startBrainstormSession('q', [], createMockSettings(), 'panel-tool'));

    const toolLines = chunks.filter(c => c.type === 'agent_thinking' && c.content?.includes('[tool] Read'));
    expect(toolLines.length).toBe(1);
    expect(toolLines[0].agentId).toBe('claude-code');
    // Tool activity must not leak into the agent's synthesized content
    const session = manager.getCurrentSession('panel-tool');
    expect(session?.agentResponses.get('claude-code')?.content).not.toContain('[tool]');
  });

  // =========================================================================
  // S7: clearSession disposes each child's provider-side session
  // =========================================================================
  it('clearSession fully evicts child provider sessions by provider id', async () => {
    const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
    configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
    pm.setProviderAvailable('claude-code');
    pm.setProviderAvailable('google-gemini');
    pm.setProviderChunks('claude-code', makeTextChunks(['a']));
    pm.setProviderChunks('google-gemini', makeTextChunks(['b']));

    await collectChunks(manager.startBrainstormSession('q', [], createMockSettings(), 'panel-clear'));
    manager.clearSession('panel-clear');

    const disposed = new Set(pm.disposedChildren.map(d => `${d.providerId}:${d.panelId}`));
    expect(disposed.has('claude-code:panel-clear-brainstorm-claude-code')).toBe(true);
    expect(disposed.has('google-gemini:panel-clear-brainstorm-google-gemini')).toBe(true);
    expect(manager.getCurrentSession('panel-clear')).toBeFalsy();
    // Idempotent — a second clear must not double-dispose
    const count = pm.disposedChildren.length;
    manager.clearSession('panel-clear');
    expect(pm.disposedChildren.length).toBe(count);
  });

  // =========================================================================
  // S4 on Stop: cancelSession retires child sessions (unclean end) while a
  // clean `done` deliberately keeps them for cross-turn continuity.
  // =========================================================================
  it('cancelSession disposes child sessions; a clean run leaves them for continuity', async () => {
    const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
    configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
    pm.setProviderAvailable('claude-code');
    pm.setProviderAvailable('google-gemini');
    pm.setProviderChunks('claude-code', makeTextChunks(['a']));
    pm.setProviderChunks('google-gemini', makeTextChunks(['b']));

    // Clean completion: children must SURVIVE (composite keys already isolate
    // them from the main chat; continuity across brainstorm turns is a feature).
    await collectChunks(manager.startBrainstormSession('q', [], createMockSettings(), 'panel-stop'));
    expect(pm.disposedChildren.length).toBe(0);

    // Stop: unclean end — children must be retired so the next brainstorm
    // can't --resume a mid-kill session.
    manager.cancelSession('panel-stop');
    const disposed = new Set(pm.disposedChildren.map(d => d.providerId));
    expect(disposed.has('claude-code')).toBe(true);
    expect(disposed.has('google-gemini')).toBe(true);
  });

  // =========================================================================
  // S7: compaction child keys are swept by resetUsage
  // =========================================================================
  it('CompactionManager.resetUsage sweeps -brainstorm- child keys', () => {
    const cm = new CompactionManager(createMockContext());
    cm.recordUsage('panel-x', { input_tokens: 100, output_tokens: 50 }, 200000);
    cm.recordUsage('panel-x-brainstorm-claude-code', { input_tokens: 10, output_tokens: 5 }, 200000);
    cm.recordUsage('panel-x-brainstorm-google-gemini', { input_tokens: 10, output_tokens: 5 }, 200000);
    // A DIFFERENT panel's keys must survive
    cm.recordUsage('panel-y-brainstorm-claude-code', { input_tokens: 7, output_tokens: 3 }, 200000);

    cm.resetUsage('panel-x');

    expect(cm.getUsage('panel-x')).toBeNull();
    expect(cm.getUsage('panel-x-brainstorm-claude-code')).toBeNull();
    expect(cm.getUsage('panel-x-brainstorm-google-gemini')).toBeNull();
    expect(cm.getUsage('panel-y-brainstorm-claude-code')).not.toBeNull();
  });

  // =========================================================================
  // S1 INTEGRATION: cancel through the REAL ProviderManager reaches BOTH
  // children. (The legacy B9 test asserted against a string-recording mock,
  // which could not detect that composite cancels no-opped in production.)
  // =========================================================================
  it('cancelSession through the real ProviderManager cancels both children on their composite panels', async () => {
    interface SpyChild {
      provider: ICliProvider;
      cancelCurrentRequest: ReturnType<typeof vi.fn>;
      started: Promise<void>;
      release: () => void;
    }

    function spyChild(id: string): SpyChild {
      let releaseFn: () => void = () => {};
      let startedFn: () => void = () => {};
      const started = new Promise<void>(r => { startedFn = r; });
      const parked = new Promise<void>(r => { releaseFn = r; });
      let firstCall = true;
      const cancelCurrentRequest = vi.fn((_panelId?: string) => { releaseFn(); });
      const provider = {
        id,
        displayName: id,
        config: { name: id, displayName: id, models: [], defaultModel: `${id}-model` },
        capabilities: {},
        async *sendMessage(): AsyncGenerator<StreamChunk> {
          yield { type: 'text', content: `${id} partial` } as StreamChunk;
          if (firstCall) {
            firstCall = false;
            startedFn();
            await parked; // park until cancelled/released — simulates a long-running CLI
          }
          yield { type: 'done' } as StreamChunk;
        },
        cancelCurrentRequest,
        suspendProcess: vi.fn(() => false),
        resumeProcess: vi.fn(() => false),
        clearSession: vi.fn(),
        disposePersistentProcess: vi.fn(),
        hasSession: () => false,
        getSessionId: () => null,
      } as unknown as ICliProvider;
      return { provider, cancelCurrentRequest, started, release: () => releaseFn() };
    }

    const claude = spyChild('claude-code');
    const gemini = spyChild('google-gemini');
    const byId = new Map<string, ICliProvider>([
      ['claude-code', claude.provider],
      ['google-gemini', gemini.provider],
    ]);

    setMockConfig('defaultProvider', 'claude-code');
    configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });

    const pm = new ProviderManager(createMockContext());
    (pm as unknown as {
      _registry: {
        get(id: string): ICliProvider | undefined;
        getAll(): ICliProvider[];
        getProviderStatus(id: string): Promise<{ found: boolean; authenticated: boolean; path: string }>;
      };
    })._registry = {
      get: (id: string) => byId.get(id),
      getAll: () => Array.from(byId.values()),
      getProviderStatus: async () => ({ found: true, authenticated: true, path: '/mock/bin' }),
    };

    const manager = new BrainstormManager(createMockContext(), pm);

    const collecting = collectChunks(
      manager.startBrainstormSession('q', [], createMockSettings(), 'panel-int')
    );

    // Wait until BOTH children have actually started streaming (their
    // panel→provider registrations exist), then hit Stop.
    await Promise.all([claude.started, gemini.started]);
    manager.cancelSession('panel-int');

    expect(claude.cancelCurrentRequest).toHaveBeenCalledWith('panel-int-brainstorm-claude-code');
    expect(gemini.cancelCurrentRequest).toHaveBeenCalledWith('panel-int-brainstorm-google-gemini');
    // The non-default child must be reached ONLY via its composite key — under
    // the old plain-panelId dispatch it was the process Stop orphaned (S1).
    // (The parent-panel cancel legitimately falls back to the default
    // provider, so no equivalent assertion for claude.)
    expect(gemini.cancelCurrentRequest).not.toHaveBeenCalledWith('panel-int');

    // Let the parked generators unwind so the session completes cleanly.
    claude.release();
    gemini.release();
    await collecting;
  });
});
