/**
 * Factory functions to create typed session state objects for each provider.
 */
import type { PanelSessionState } from '../../src/providers/base/BaseCliProvider';
import type { ClaudeSessionState } from '../../src/providers/claude/ClaudeCodeProvider';
import type { QwenSessionState } from '../../src/providers/qwen/QwenCodeProvider';
import type { HermesSessionState } from '../../src/providers/hermes/HermesProvider';
import type { ContinueSessionState } from '../../src/providers/continue/ContinueProvider';
import type { OpenRouterSessionState } from '../../src/providers/openrouter/OpenRouterProvider';

// Re-export session state types for provider-specific fields
// Some providers don't export their session type, so we define compatible objects inline.

function baseSession(panelId: string): PanelSessionState {
  return {
    panelId,
    process: null,
    sessionId: null,
    autonomousMode: false,
    persistentProcess: null,
    persistentReady: false,
    lastHealthCheck: 0,
    suspended: false,
  };
}

export function createClaudeSession(panelId = 'test-panel'): ClaudeSessionState {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map(),
    lastUsageStats: null,
    hasStreamedText: false,
    awaitingCompactSummary: false,
  };
}

export function createQwenSession(panelId = 'test-panel'): QwenSessionState {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map(),
    lastUsageStats: null,
    hasStreamedText: false,
  };
}

export function createCodexSession(panelId = 'test-panel') {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map<string, { id: string; name: string; inputJson: string; status: string }>(),
    completedToolCalls: new Set<string>(),
    lastUsageStats: null,
  };
}

export function createGeminiSession(panelId = 'test-panel') {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map<string, { id: string; name: string; input: Record<string, unknown> }>(),
    lastUsageStats: null,
  };
}

export function createClineSession(panelId = 'test-panel') {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map<string, { id: string; name: string; inputJson: string }>(),
    completedToolCalls: new Set<string>(),
    lastUsageStats: null,
    lastUserInput: '',
    askReceived: false,
    jsonBuffer: [] as string[],
    clineruleBackup: null as string | null,
    clineruleWritten: false,
  };
}

export function createCopilotSession(panelId = 'test-panel') {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map<string, { id: string; name: string; input: Record<string, unknown> }>(),
    lastUsageStats: null,
  };
}

export function createCursorSession(panelId = 'test-panel') {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map<string, { id: string; name: string; inputJson: string }>(),
    lastUsageStats: null,
    streamedTextLength: 0,
  };
}

export function createOpenClawSession(panelId = 'test-panel') {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map<string, { id: string; name: string; inputJson: string }>(),
    lastUsageStats: null,
  };
}

export function createOpenCodeSession(panelId = 'test-panel') {
  return {
    ...baseSession(panelId),
    activeToolCalls: new Map<string, { id: string; name: string; input: Record<string, unknown> }>(),
    completedToolCalls: new Set<string>(),
    lastUsageStats: null,
  };
}

export function createContinueSession(panelId = 'test-panel'): ContinueSessionState {
  return {
    ...baseSession(panelId),
    inThinkBlock: false,
  };
}

export function createOpenRouterSession(panelId = 'test-panel'): OpenRouterSessionState {
  return {
    ...baseSession(panelId),
    abortController: null,
    lastUsage: null,
  };
}

export function createHermesSession(panelId = 'test-panel'): HermesSessionState {
  return {
    ...baseSession(panelId),
    rpcId: 0,
    initializeId: null,
    sessionNewId: null,
    promptId: null,
    acpSessionId: null,
    pendingPrompt: null,
    acpAccessLevel: 'ask-permission',
    fallbackDiagnostics: false,
    fallbackErrorEmitted: false,
    activeToolCalls: new Map<string, { id: string; name: string; input: Record<string, unknown> }>(),
    lastUsageStats: null,
  };
}
