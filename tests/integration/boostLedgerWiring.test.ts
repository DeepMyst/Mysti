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
 * Plan 24 Phase 1 — the Boost ledger WIRING, not the ledger's arithmetic.
 *
 * boostManager.test.ts pins recordTurn's behaviour against a hand-built record.
 * This file pins the thing that unit test cannot see: that the real
 * ChatViewProvider actually CALLS it, once per turn, with the right numbers,
 * from the CLI `done` path — the review flagged this whole call site as
 * untested, and a ledger that is silently never invoked looks identical to one
 * that reports zero.
 *
 * Drives the real `_handleSendMessage` with a scripted provider stream, using
 * the harness shape established in chatViewMessagePersistence.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real PlanOptionManager constructs a ResponseClassifier, which spawns warm
// Claude CLI processes — never acceptable in a unit test run.
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() {
      return { questions: [], planOptions: [], context: '' };
    }
  },
}));

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { BoostManager } from '../../src/managers/BoostManager';
import { clearMockConfig, setMockConfig, Uri } from '../helpers/mockVscode';
import type { Settings, StreamChunk, WebviewMessage, BoostTurnRecord } from '../../src/types';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';

const SETTINGS: Settings = {
  mode: 'edit-automatically',
  thinkingLevel: 'medium',
  accessLevel: 'full-access',
  contextMode: 'manual',
  model: 'claude-opus-4-6',
  provider: 'claude-code',
};

interface Harness {
  provider: ChatViewProvider;
  records: BoostTurnRecord[];
  boost: BoostManager;
  /** How many times the real compaction path ran (Phase 5 proof). */
  nativeCompactions(): number;
  setStream(chunks: StreamChunk[]): void;
  /** Force the compaction evaluator to say "compact now". */
  setCompactionActs(act: boolean): void;
  dispose(): void;
}

function createHarness(): Harness {
  const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;
  const store = new Map<string, unknown>();
  const extensionContext = {
    globalState: {
      get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
      update: async (key: string, value: unknown) => { store.set(key, value); },
    },
    workspaceState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist',
    extensionUri,
    extension: { packageJSON: { version: '0.0.0' } },
  } as any;

  const permissionManager = new PermissionManager('ask-permission');
  let streamChunks: StreamChunk[] = [];
  let compactionActs = false;
  let nativeCompactions = 0;

  const conversationManager = {
    getCurrentConversation: () => null,
    getConversation: () => null,
    getAgentConfig: () => undefined,
    isFirstUserMessage: () => false,
    addMessageToConversation: vi.fn((...args: any[]) => {
      const [, role, content] = args;
      return { id: 'msg-1', role, content, timestamp: Date.now() };
    }),
  } as any;

  const providerManager = {
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
    getProvider: () => undefined,
    getProviderInstance: () => ({ capabilities: { supportsImages: true, thinkingStyle: 'streamed' } }),
    getModelContextWindow: () => 200000,
    setChannelSystemContext: () => undefined,
    cancelRequest: () => undefined,
    sendMessage: vi.fn(async function* () {
      for (const chunk of streamChunks) { yield chunk; }
    }),
  } as any;

  const compactionManager = {
    shouldCompact: () => false,
    recordUsage: () => undefined,
    appendHistory: () => undefined,
    isSmartActive: () => false,
    evaluateCompaction: () => ({ act: compactionActs, smart: false }),
    getThreshold: () => 75,
    // Reached only in the compaction-acts case below; 'native-cli' with a
    // provider that reports no compact support makes _executeCompaction a
    // clean no-op instead of an unhandled rejection.
    getStrategy: () => 'native-cli',
    executeSmartSummarization: async () => null,
    markCompacted: () => undefined,
    updateUsageAfterCompaction: () => undefined,
    // Phase 5 drives the real _executeCompaction before the send; the native
    // path consumes this stream. Counting invocations is how we prove the
    // interception actually compacted rather than just flipping a flag.
    executeNativeCompaction: (..._a: unknown[]) => {
      nativeCompactions++;
      return (async function* () {
        yield { type: 'done', usage: { input_tokens: 1_000, output_tokens: 0 } };
      })();
    },
  } as any;

  const noop = {} as any;
  const provider = new ChatViewProvider({
    extensionUri,
    extensionContext,
    contextManager: { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined } as any,
    conversationManager,
    providerManager,
    suggestionManager: { generateSuggestions: async () => [] } as any,
    brainstormManager: noop,
    permissionManager,
    setupManager: {
      getWizardStatus: async () => ({ anyReady: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
      getWizardStatusCached: () => ({ anyReady: true, complete: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
      ensureProviderStatusFresh: async () => undefined,
      refreshWizardStatus: async () => ({ anyReady: true }),
      invalidateProviderStatus: () => undefined,
      onWizardStatusUpdated: () => ({ dispose: () => {} }),
    } as any,
    telemetryManager: noop,
    autonomousManager: { isActive: () => false } as any,
    memoryManager: {
      learnFromPermissionDecision: () => undefined,
      getProjectMemoryContent: () => '',
      recordProjectLearning: () => undefined,
    } as any,
    compactionManager,
    lifecycleManager: {
      onLifecycleEvent: () => undefined, touchSession: () => undefined,
      markBusy: () => undefined, markIdle: () => undefined, registerSession: () => undefined,
    } as any,
    slashCommandManager: noop,
    activeModeManager: {
      onStatusChanged: () => undefined, onChannelChanged: () => undefined, onActivity: () => undefined,
      subscribeToChannelEvents: () => () => undefined, isConnected: () => false,
      isInstalled: () => false, isIntegrationEnabled: () => false,
    } as any,
    engagementManager: {
      trackCustomPersonaCreated: () => undefined, trackCustomSkillCreated: () => undefined,
      trackMessageSent: () => [], trackSuccessfulResponse: () => undefined,
    } as any,
    projectContextManager: { readRules: () => '', getMystiMdContent: () => '', getCrossVendorInstructions: () => [] } as any,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub() as any,
    checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null } as any
  });

  // Record every ledger call while still exercising the REAL BoostManager, so a
  // signature drift between the call site and the manager fails here.
  const boost = new BoostManager(extensionContext);
  const records: BoostTurnRecord[] = [];
  const realRecord = boost.recordTurn.bind(boost);
  boost.recordTurn = (rec: BoostTurnRecord) => { records.push(rec); realRecord(rec); };
  provider.setBoostManager(boost);

  (provider as any)._panelStates.set('sidebar', {
    id: 'sidebar',
    webview: { postMessage: (_m: WebviewMessage) => Promise.resolve(true) },
    currentConversationId: null,
    isSidebar: true,
  });

  return {
    provider, records, boost,
    nativeCompactions: () => nativeCompactions,
    setStream(chunks) { streamChunks = chunks; },
    setCompactionActs(act) { compactionActs = act; },
    dispose() {
      (provider as any)._channelBridge?.dispose?.();
      permissionManager.dispose();
      boost.dispose();
    },
  };
}

async function send(h: Harness, content = 'do the thing'): Promise<void> {
  await (h.provider as any)._handleSendMessage(
    { content, context: [], settings: { ...SETTINGS } },
    'sidebar',
  );
}

describe('Boost ledger wiring on the CLI path (Plan 24 Phase 1)', () => {
  let h: Harness;
  beforeEach(() => { clearMockConfig(); h = createHarness(); });
  afterEach(() => { h.dispose(); });

  it('records exactly one turn per done chunk, with context = every prompt bucket', async () => {
    h.setStream([
      { type: 'text', content: 'ok' },
      {
        type: 'done',
        usage: {
          input_tokens: 1_000, output_tokens: 250,
          cache_read_input_tokens: 99_000, cache_creation_input_tokens: 4_000,
        },
      },
    ]);
    await send(h);

    expect(h.records).toHaveLength(1);
    const r = h.records[0];
    expect(r.kind).toBe('cli');
    expect(r.provider).toBe('claude-code');
    expect(r.model).toBe('claude-opus-4-6');
    // The CompactionManager fill convention: for an Anthropic-convention backend
    // the three prompt buckets are DISJOINT, so fill is the sum of all three —
    // 1_000 uncached + 99_000 cache-read + 4_000 cache-CREATION. This used to
    // assert 100_000, dropping cache-creation, which is the bug that made a cold
    // turn (where the whole prefix lands in cache-creation) look nearly empty.
    expect(r.contextTokens).toBe(104_000);
    expect(r.outputTokens).toBe(250);
    expect(r.cacheReadTokens).toBe(99_000);
    expect(r.cacheCreationTokens).toBe(4_000);
    expect(r.roundTrips).toBe(1);
    expect(r.estimated).toBe(false);
    expect(h.boost.snapshot().session.turns).toBe(1);
  });

  it('still records when compaction fires (the record must not sit in the else branch)', async () => {
    h.setCompactionActs(true);
    h.setStream([
      { type: 'text', content: 'ok' },
      { type: 'done', usage: { input_tokens: 500, output_tokens: 10 } },
    ]);
    await send(h);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].contextTokens).toBe(500);
  });

  it('honors a provider that flags its own usage as synthesized', async () => {
    // LocalAI's SSE-counting fallback sets this; booking it as measured would
    // let a fabricated figure into the persisted lifetime totals.
    h.setStream([
      { type: 'done', usage: { input_tokens: 0, output_tokens: 42, estimated: true } },
    ]);
    await send(h);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].estimated).toBe(true);
    expect(h.boost.snapshot().estimated).toBe(true);
  });

  it('books a defaulted-zero context as UNKNOWN, not as a measured zero', async () => {
    // cursor/hermes/kimi/ollama default a missing field to 0 rather than
    // omitting usage, so zero input AND zero cache-read means "the provider
    // told us nothing" — no real turn has zero context.
    h.setStream([{ type: 'done', usage: { input_tokens: 0, output_tokens: 120 } }]);
    await send(h);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].contextTokens).toBeUndefined();
    expect(h.records[0].estimated).toBe(true);
    // Output is still a real reported figure, so it is still counted.
    expect(h.records[0].outputTokens).toBe(120);
    // ...and an unknown context contributes no mean.
    expect(h.boost.snapshot().sessionMeanContextTokens).toBe(0);
  });

  it('counts a cache-only turn as known context', async () => {
    // A fully cache-hit turn legitimately reports input_tokens 0.
    h.setStream([{
      type: 'done',
      usage: { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 88_000 },
    }]);
    await send(h);
    expect(h.records[0].contextTokens).toBe(88_000);
    expect(h.records[0].estimated).toBe(false);
  });

  it('records nothing when the provider omits usage entirely', async () => {
    // Providers legitimately send a bare done (native /compact returns zero
    // usage) — the ledger must stay silent rather than book a phantom turn.
    h.setStream([{ type: 'text', content: 'ok' }, { type: 'done' }]);
    await send(h);
    expect(h.records).toHaveLength(0);
    expect(h.boost.snapshot().session.turns).toBe(0);
  });

  it('works when no BoostManager is wired at all (optional-chained call site)', async () => {
    const bare = createHarness();
    (bare.provider as any)._boostManager = undefined;
    bare.setStream([{ type: 'done', usage: { input_tokens: 1, output_tokens: 1 } }]);
    await expect(send(bare)).resolves.toBeUndefined();
    expect(bare.records).toHaveLength(0);
    bare.dispose();
  });
});

describe('Boost cold-resume interception (Plan 24 Phase 5)', () => {
  const HOUR = 60 * 60 * 1000;
  let h: Harness;
  let clock: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearMockConfig();
    clock = 1_000_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    h = createHarness();
  });
  afterEach(() => { nowSpy.mockRestore(); h.dispose(); });

  /** One turn that leaves the panel holding a large context. */
  async function bigTurn(): Promise<void> {
    h.setStream([{ type: 'done', usage: { input_tokens: 150_000, output_tokens: 100 } }]);
    await send(h);
  }

  it('does nothing while Boost is off, however long the gap', async () => {
    await bigTurn();
    clock += 6 * HOUR;
    await bigTurn();
    expect(h.nativeCompactions()).toBe(0);
    expect(h.records.every(r => !r.coldResumeIntercepted)).toBe(true);
  });

  it('compacts before the send when a big session resumes cold', async () => {
    setMockConfig('boost.enabled', true);
    await bigTurn();
    expect(h.nativeCompactions()).toBe(0);

    clock += 2 * HOUR;
    await bigTurn();

    expect(h.nativeCompactions()).toBe(1);
    const last = h.records[h.records.length - 1];
    expect(last.coldResumeIntercepted).toBe(true);
    expect(h.boost.snapshot().session.coldResumesIntercepted).toBe(1);
  });

  it('does not fire twice off the same stale reading', async () => {
    setMockConfig('boost.enabled', true);
    await bigTurn();
    clock += 2 * HOUR;
    await bigTurn();            // intercepts, and re-arms from THIS turn
    await bigTurn();            // immediately after — still warm
    expect(h.nativeCompactions()).toBe(1);
  });

  it('leaves a warm session alone', async () => {
    setMockConfig('boost.enabled', true);
    await bigTurn();
    clock += 5 * 60_000;
    await bigTurn();
    expect(h.nativeCompactions()).toBe(0);
  });

  it('leaves a small idle session alone', async () => {
    setMockConfig('boost.enabled', true);
    h.setStream([{ type: 'done', usage: { input_tokens: 2_000, output_tokens: 10 } }]);
    await send(h);
    clock += 6 * HOUR;
    await send(h);
    expect(h.nativeCompactions()).toBe(0);
  });

  it('still sends when the pre-send compaction throws', async () => {
    // An optimisation must never cost the user their turn.
    setMockConfig('boost.enabled', true);
    await bigTurn();
    clock += 2 * HOUR;
    const spy = vi.spyOn(h.provider as never as { _executeCompaction: () => Promise<void> }, '_executeCompaction')
      .mockRejectedValue(new Error('compaction exploded'));
    await expect(bigTurn()).resolves.toBeUndefined();
    spy.mockRestore();
    const last = h.records[h.records.length - 1];
    expect(last.coldResumeIntercepted).toBeUndefined();
  });
});
