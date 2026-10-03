/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan 32 H2/H5: a coordinator delegation names its card on the child's
 * permission cards, and carries the child's measured usage back to the card.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { CollaboratorChunk, CollaboratorDispatchOptions, CollaboratorSpec, Settings } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

interface DelegationHost {
  _runMystiDelegations(
    requests: Array<{ agentId: string; task: string; collaboratorId: string; readOnly: boolean; fold: boolean; parentToolId?: string }>,
    settings: Settings, panelId: string, runId: string, cancelKey: string, isCancelled: () => boolean,
  ): Promise<Array<{ text: string; hasError: boolean; usage?: unknown }>>;
}

describe('coordinator delegation metadata', () => {
  it('threads the delegate card id into each child gate and returns the child usage', async () => {
    const usage = { input_tokens: 120, output_tokens: 9, normalized: true };
    const gate = vi.fn(async () => true);
    const specs: CollaboratorSpec[] = [];
    const host = Object.assign(Object.create(ChatViewProvider.prototype), {
      _mystiActiveDelegationRuns: new Map(),
      _providerManager: { getProvider: () => undefined },
      _createSubAgentQuestionCallback: () => undefined,
      _shouldGateToolUse: () => true,
      _buildDelegationPrompt: (task: string) => task,
      _requestCollaboratorPermission: gate,
      _collaboratorPool: {
        async *dispatch(batch: CollaboratorSpec[], options: CollaboratorDispatchOptions): AsyncGenerator<CollaboratorChunk> {
          specs.push(...batch);
          for (const spec of batch) {
            await options.onGate!(spec, { id: `tc-${spec.collaboratorId}`, name: 'Write', input: {} });
            yield {
              type: 'collab_complete', collaboratorId: spec.collaboratorId, agentId: spec.agentId, responseText: 'ok',
              ...(spec.collaboratorId === 'c1' ? { usage } : {}),
            };
          }
        },
      },
    }) as DelegationHost;

    const settings = { provider: 'claude-code', mode: 'default', accessLevel: 'ask-permission' } as Settings;
    const results = await host._runMystiDelegations([
      { agentId: 'openai-codex', task: 'a', collaboratorId: 'c1', readOnly: false, fold: false, parentToolId: 'mysti-deleg-r-0' },
      { agentId: 'google-gemini', task: 'b', collaboratorId: 'c2', readOnly: true, fold: false, parentToolId: 'mysti-deleg-r-1' },
    ], settings, 'a', 'r', 'a', () => false);

    expect(gate.mock.calls.map(call => [(call[0] as CollaboratorSpec).collaboratorId, call[5]])).toEqual([
      ['c1', 'mysti-deleg-r-0'],
      ['c2', 'mysti-deleg-r-1'],
    ]);
    expect(specs.map(s => s.access)).toEqual(['gated-write', 'read-only']);
    expect(results[0].usage).toEqual(usage);
    expect(results[1].usage).toBeUndefined();
  });
});
