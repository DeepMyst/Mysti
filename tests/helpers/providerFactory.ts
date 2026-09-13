/**
 * Testable provider subclasses that expose protected methods for testing.
 * Each wraps the real provider, exposing parseStreamLine and buildCliArgs as public.
 */
import * as vscode from 'vscode';
import type { PanelSessionState } from '../../src/providers/base/BaseCliProvider';
import type { Settings, StreamChunk } from '../../src/types';
import { ClaudeCodeProvider } from '../../src/providers/claude/ClaudeCodeProvider';
import { CodexProvider } from '../../src/providers/codex/CodexProvider';
import { GeminiProvider } from '../../src/providers/gemini/GeminiProvider';
import { ClineProvider } from '../../src/providers/cline/ClineProvider';
import { CopilotProvider } from '../../src/providers/copilot/CopilotProvider';
import { CursorProvider } from '../../src/providers/cursor/CursorProvider';
import { OpenClawProvider } from '../../src/providers/openclaw/OpenClawProvider';
import { OpenCodeProvider } from '../../src/providers/opencode/OpenCodeProvider';
import { QwenCodeProvider } from '../../src/providers/qwen/QwenCodeProvider';
import { HermesProvider } from '../../src/providers/hermes/HermesProvider';
import { ContinueProvider } from '../../src/providers/continue/ContinueProvider';
import { OpenRouterProvider } from '../../src/providers/openrouter/OpenRouterProvider';
import { KimiCodeProvider } from '../../src/providers/kimi/KimiCodeProvider';
import type { OpenRouterClient } from '../../src/services/OpenRouterClient';

import * as path from 'node:path';

// Mock extension context for provider constructors
export function createMockContext(): vscode.ExtensionContext {
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
    extensionPath: path.resolve('/mock/extension'),
    extensionUri: vscode.Uri.file(path.resolve('/mock/extension')),
    storagePath: '/mock/storage',
    globalStoragePath: '/mock/global-storage',
    logPath: '/mock/logs',
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global-storage'),
    logUri: vscode.Uri.file('/mock/logs'),
    extensionMode: 1,
    extension: {} as any,
    environmentVariableCollection: {} as any,
    secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve(), onDidChange: () => ({ dispose: () => {} }) } as any,
    languageModelAccessInformation: {} as any,
  } as unknown as vscode.ExtensionContext;
}

// ============================================================================
// Testable subclasses
// ============================================================================

export class TestableClaudeProvider extends ClaudeCodeProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
  public getExtraSpawnEnv(settings: Settings): Record<string, string> {
    return super.getExtraSpawnEnv(settings);
  }
}

export class TestableCodexProvider extends CodexProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableGeminiProvider extends GeminiProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableClineProvider extends ClineProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableCopilotProvider extends CopilotProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableCursorProvider extends CursorProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableOpenClawProvider extends OpenClawProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
  /** `openclaw agent` reads the prompt from a file, not stdin — see _deliverPrompt. */
  public deliverPrompt(
    proc: Parameters<OpenClawProvider['_deliverPromptForTest']>[0],
    prompt: string,
    session: PanelSessionState
  ): Promise<void> {
    return this._deliverPromptForTest(proc, prompt, session);
  }
}

export class TestableOpenCodeProvider extends OpenCodeProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableQwenProvider extends QwenCodeProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableContinueProvider extends ContinueProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
}

export class TestableOpenRouterProvider extends OpenRouterProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
  /** Inject a mock OpenRouterClient (with a stubbed fetch) for sendMessage tests. */
  public setClient(client: OpenRouterClient): void {
    this._client = client;
  }
}

export class TestableHermesProvider extends HermesProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
  public buildPersistentCliArgs(settings: Settings, session: PanelSessionState): string[] | null {
    return super.buildPersistentCliArgs(settings, session);
  }
  public formatPersistentInput(prompt: string, session: PanelSessionState): string {
    return super._formatPersistentInput(prompt, session);
  }
  public isResponseBoundary(line: string): boolean {
    return super._isResponseBoundary(line);
  }
  public interruptPersistentProcess(session: PanelSessionState): void {
    super._interruptPersistentProcess(session);
  }
  public persistentSettingsMatch(session: PanelSessionState, settings: Settings): boolean {
    return super._persistentSettingsMatch(session, settings);
  }
}

export class TestableKimiProvider extends KimiCodeProvider {
  constructor() { super(createMockContext()); }
  public parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return super.parseStreamLine(line, session);
  }
  public buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    return super.buildCliArgs(settings, session);
  }
  public buildPersistentCliArgs(settings: Settings, session: PanelSessionState): string[] | null {
    return super.buildPersistentCliArgs(settings, session);
  }
  public formatPersistentInput(prompt: string, session: PanelSessionState): string {
    return super._formatPersistentInput(prompt, session);
  }
  public isResponseBoundary(line: string): boolean {
    return super._isResponseBoundary(line);
  }
  public interruptPersistentProcess(session: PanelSessionState): void {
    super._interruptPersistentProcess(session);
  }
  public persistentSettingsMatch(session: PanelSessionState, settings: Settings): boolean {
    return super._persistentSettingsMatch(session, settings);
  }
  public getExtraSpawnEnv(settings: Settings): Record<string, string> {
    return super.getExtraSpawnEnv(settings);
  }
}
