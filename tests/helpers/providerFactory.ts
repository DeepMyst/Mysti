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

// Mock extension context for provider constructors
function createMockContext(): vscode.ExtensionContext {
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
    extensionPath: '/mock/extension',
    extensionUri: vscode.Uri.file('/mock/extension'),
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
