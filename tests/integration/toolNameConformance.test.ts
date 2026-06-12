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
 * Tool-name conformance test: for EVERY provider that emits tool_use chunks,
 * assert that the emitted (normalized) tool names produce the expected
 * permission classification, and that unknown tool names are GATED (fail
 * closed), never silently allowed.
 *
 * Background (B1/B6): every CLI provider runs with its native permission
 * prompts bypassed (--yolo, --force, --approval-mode, --allow-all-tools), so
 * the stream-level gate keyed on toolCall.name is the SOLE enforcement point.
 * A provider emitting a name the classifier does not recognize must fail
 * closed, and known write/shell/web tools must classify to the right action.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { classifyToolAction, shouldGateToolUse, normalizeToolName } from '../../src/utils/permissionClassifier';
import {
  TestableClaudeProvider,
  TestableCodexProvider,
  TestableGeminiProvider,
  TestableClineProvider,
  TestableCursorProvider,
  TestableOpenClawProvider,
  TestableOpenCodeProvider,
  TestableQwenProvider,
} from '../helpers/providerFactory';
import {
  createClaudeSession,
  createCodexSession,
  createGeminiSession,
  createClineSession,
  createCursorSession,
  createOpenClawSession,
  createOpenCodeSession,
  createQwenSession,
} from '../helpers/sessionFactory';
import type { PermissionActionType, Settings } from '../../src/types';

/** ask-before-edit is the shipped default mode — the gate MUST fire here. */
function askSettings(): Settings {
  return {
    mode: 'ask-before-edit', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'claude-code',
  };
}

/** Assert an emitted tool name classifies and gates as expected. */
function expectClassification(emittedName: string, expected: PermissionActionType): void {
  expect(classifyToolAction(emittedName)).toBe(expected);
  const gated = shouldGateToolUse(askSettings(), emittedName);
  if (expected === 'file-read') {
    expect(gated).toBe(false);
  } else {
    expect(gated).toBe(true);
  }
}

// ============================================================================
// Claude Code — canonical names pass through unchanged
// ============================================================================
describe('Claude Code tool-name conformance', () => {
  let provider: TestableClaudeProvider;
  let session: ReturnType<typeof createClaudeSession>;

  beforeEach(() => {
    provider = new TestableClaudeProvider();
    session = createClaudeSession();
  });

  function emit(name: string): string {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: `toolu_${name}`, name },
      },
    });
    const chunk = provider.parseStreamLine(line, session);
    expect(chunk?.type).toBe('tool_use');
    return chunk!.toolCall!.name;
  }

  it.each([
    ['Edit', 'file-edit'],
    ['Write', 'file-create'],
    ['MultiEdit', 'multi-file-edit'],
    ['NotebookEdit', 'file-edit'],
    ['Bash', 'bash-command'],
    ['WebFetch', 'web-request'],
    ['WebSearch', 'web-request'],
    ['Read', 'file-read'],
    ['Grep', 'file-read'],
    ['Glob', 'file-read'],
  ] as Array<[string, PermissionActionType]>)('emitted %s classifies as %s', (name, expected) => {
    expectClassification(emit(name), expected);
  });

  it('gates unknown tool names (fail closed)', () => {
    const emitted = emit('SomeBrandNewTool');
    expect(shouldGateToolUse(askSettings(), emitted)).toBe(true);
  });
});

// ============================================================================
// Codex — normalizes to Bash/Write/Edit at the parser; web_search native
// ============================================================================
describe('Codex tool-name conformance', () => {
  let provider: TestableCodexProvider;
  let session: ReturnType<typeof createCodexSession>;

  beforeEach(() => {
    provider = new TestableCodexProvider();
    session = createCodexSession();
  });

  it('command_execution emits Bash (bash-command, gated)', () => {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd_1', command: 'rm -rf /tmp/x' },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    expectClassification(chunk!.toolCall!.name, 'bash-command');
  });

  it('write item emits Write (file-create, gated)', () => {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'write', id: 'file_1', file_path: '/src/new.ts', content: 'x' },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    expectClassification(chunk!.toolCall!.name, 'file-create');
  });

  it('edit item emits Edit (file-edit, gated)', () => {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'edit', id: 'file_2', file_path: '/src/main.ts', old_content: 'a', new_content: 'b' },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    expectClassification(chunk!.toolCall!.name, 'file-edit');
  });

  it('web_search item classifies as web-request (gated)', () => {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'web_search', id: 'search_1', query: 'vitest docs' },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    expectClassification(chunk!.toolCall!.name, 'web-request');
  });

  it('gates unknown mcp tool names (fail closed)', () => {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'mcp_tool_call', id: 'mcp_1', name: 'some_mcp_tool', arguments: { a: 1 } },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    expect(shouldGateToolUse(askSettings(), chunk!.toolCall!.name)).toBe(true);
  });
});

// ============================================================================
// Gemini — native names (write_file, replace, run_shell_command, ...) must be
// normalized at emission; the CLI runs under --yolo (B1)
// ============================================================================
describe('Gemini tool-name conformance', () => {
  let provider: TestableGeminiProvider;
  let session: ReturnType<typeof createGeminiSession>;

  beforeEach(() => {
    provider = new TestableGeminiProvider();
    session = createGeminiSession();
  });

  function emit(nativeName: string): string {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'tool_use',
      tool_id: `tool_${nativeName}`,
      tool_name: nativeName,
      parameters: { file_path: '/src/main.ts', command: 'ls' },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    return chunk!.toolCall!.name;
  }

  it.each([
    ['write_file', 'Write', 'file-create'],
    ['replace', 'Edit', 'file-edit'],
    ['run_shell_command', 'Bash', 'bash-command'],
    ['web_fetch', 'WebFetch', 'web-request'],
    ['google_web_search', 'WebSearch', 'web-request'],
    ['read_file', 'Read', 'file-read'],
    ['read_many_files', 'Read', 'file-read'],
    ['list_directory', 'LS', 'file-read'],
    ['search_file_content', 'Grep', 'file-read'],
    ['glob', 'Glob', 'file-read'],
  ] as Array<[string, string, PermissionActionType]>)(
    'native %s emits %s and classifies as %s', (nativeName, expectedEmitted, expectedAction) => {
      const emitted = emit(nativeName);
      expect(emitted).toBe(expectedEmitted);
      expectClassification(emitted, expectedAction);
    }
  );

  it('gates unknown native tool names (fail closed)', () => {
    const emitted = emit('save_memory');
    expect(shouldGateToolUse(askSettings(), emitted)).toBe(true);
  });
});

// ============================================================================
// Qwen — gemini-cli fork with Anthropic-style stream events; native names
// must normalize at all tool_use emission points (B1)
// ============================================================================
describe('Qwen tool-name conformance', () => {
  let provider: TestableQwenProvider;
  let session: ReturnType<typeof createQwenSession>;

  beforeEach(() => {
    provider = new TestableQwenProvider();
    session = createQwenSession();
  });

  function emitFromBlockStart(nativeName: string, index: number): string {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: `tool_${nativeName}`, name: nativeName },
      },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    return chunk!.toolCall!.name;
  }

  it.each([
    ['write_file', 'Write', 'file-create'],
    ['replace', 'Edit', 'file-edit'],
    ['edit', 'Edit', 'file-edit'],
    ['run_shell_command', 'Bash', 'bash-command'],
    ['web_fetch', 'WebFetch', 'web-request'],
    ['read_file', 'Read', 'file-read'],
    ['glob', 'Glob', 'file-read'],
  ] as Array<[string, string, PermissionActionType]>)(
    'content_block_start native %s emits %s and classifies as %s', (nativeName, expectedEmitted, expectedAction) => {
      const emitted = emitFromBlockStart(nativeName, 1);
      expect(emitted).toBe(expectedEmitted);
      expectClassification(emitted, expectedAction);
    }
  );

  it('assistant-message tool_use blocks are normalized too', () => {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool_a1', name: 'run_shell_command', input: { command: 'ls' } },
        ],
      },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    expect(chunk!.toolCall!.name).toBe('Bash');
    expectClassification(chunk!.toolCall!.name, 'bash-command');
  });

  it('gates unknown native tool names (fail closed)', () => {
    const emitted = emitFromBlockStart('brand_new_tool', 2);
    expect(shouldGateToolUse(askSettings(), emitted)).toBe(true);
  });
});

// ============================================================================
// Cursor — ToolCall-key map must produce canonical names; CLI runs --force
// ============================================================================
describe('Cursor tool-name conformance', () => {
  let provider: TestableCursorProvider;
  let session: ReturnType<typeof createCursorSession>;

  beforeEach(() => {
    provider = new TestableCursorProvider();
    session = createCursorSession();
  });

  function emit(toolCallKey: string): string {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: `tc_${toolCallKey}`,
      tool_call: { [toolCallKey]: { args: { path: '/src/main.ts' } } },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    return chunk!.toolCall!.name;
  }

  it.each([
    ['writeToolCall', 'Write', 'file-create'],
    ['editToolCall', 'Edit', 'file-edit'],
    ['shellToolCall', 'Bash', 'bash-command'],
    ['deleteToolCall', 'Delete', 'file-delete'],
    ['readToolCall', 'Read', 'file-read'],
    ['grepToolCall', 'Grep', 'file-read'],
    ['globToolCall', 'Glob', 'file-read'],
    ['lsToolCall', 'LS', 'file-read'],
    ['todoToolCall', 'TodoWrite', 'file-read'],
  ] as Array<[string, string, PermissionActionType]>)(
    '%s emits %s and classifies as %s', (key, expectedEmitted, expectedAction) => {
      const emitted = emit(key);
      expect(emitted).toBe(expectedEmitted);
      expectClassification(emitted, expectedAction);
    }
  );

  it('gates unmapped ToolCall keys (fail closed)', () => {
    const emitted = emit('mysteriousToolCall');
    expect(shouldGateToolUse(askSettings(), emitted)).toBe(true);
  });
});

// ============================================================================
// OpenCode — lowercase native names (bash/edit/write/patch) must normalize
// ============================================================================
describe('OpenCode tool-name conformance', () => {
  let provider: TestableOpenCodeProvider;
  let session: ReturnType<typeof createOpenCodeSession>;

  beforeEach(() => {
    provider = new TestableOpenCodeProvider();
    session = createOpenCodeSession();
  });

  function emit(nativeName: string): string {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'message.part.updated',
      part: {
        type: 'tool',
        id: `tool_${nativeName}`,
        name: nativeName,
        state: 'running',
        input: { command: 'ls', filePath: '/src/main.ts' },
      },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    return chunk!.toolCall!.name;
  }

  it.each([
    ['bash', 'Bash', 'bash-command'],
    ['write', 'Write', 'file-create'],
    ['edit', 'Edit', 'file-edit'],
    ['patch', 'Edit', 'file-edit'],
    ['webfetch', 'WebFetch', 'web-request'],
    ['read', 'Read', 'file-read'],
    ['grep', 'Grep', 'file-read'],
    ['glob', 'Glob', 'file-read'],
    ['list', 'LS', 'file-read'],
  ] as Array<[string, string, PermissionActionType]>)(
    'native %s emits %s and classifies as %s', (nativeName, expectedEmitted, expectedAction) => {
      const emitted = emit(nativeName);
      expect(emitted).toBe(expectedEmitted);
      expectClassification(emitted, expectedAction);
    }
  );

  it('gates unknown native tool names (fail closed)', () => {
    const emitted = emit('unknown_oc_tool');
    expect(shouldGateToolUse(askSettings(), emitted)).toBe(true);
  });
});

// ============================================================================
// Cline — passes its own names through; they are in the classifier map
// ============================================================================
describe('Cline tool-name conformance', () => {
  let provider: TestableClineProvider;
  let session: ReturnType<typeof createClineSession>;

  beforeEach(() => {
    provider = new TestableClineProvider();
    session = createClineSession();
  });

  function emit(name: string): string {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'tool_use',
      toolCall: { id: `tool_${name}`, name, input: { path: '/src/main.ts' }, status: 'running' },
    }), session);
    expect(chunk?.type).toBe('tool_use');
    return chunk!.toolCall!.name;
  }

  it.each([
    ['write_to_file', 'file-create'],
    ['replace_in_file', 'file-edit'],
    ['execute_command', 'bash-command'],
    ['read_file', 'file-read'],
    ['list_files', 'file-read'],
  ] as Array<[string, PermissionActionType]>)('emitted %s classifies as %s', (name, expected) => {
    expectClassification(emit(name), expected);
  });

  it('gates unknown tool names (fail closed)', () => {
    const emitted = emit('use_mcp_tool');
    expect(shouldGateToolUse(askSettings(), emitted)).toBe(true);
  });
});

// ============================================================================
// OpenClaw — gateway passes lowercase names through; the case-insensitive
// classifier must still classify them correctly
// ============================================================================
describe('OpenClaw tool-name conformance', () => {
  let provider: TestableOpenClawProvider;
  let session: ReturnType<typeof createOpenClawSession>;

  beforeEach(() => {
    provider = new TestableOpenClawProvider();
    session = createOpenClawSession();
  });

  function emit(name: string): string {
    const chunk = provider.parseStreamLine(JSON.stringify({
      type: 'tool_call',
      id: `tool_${name}`,
      name,
      input: { path: '/src/main.ts' },
      status: 'started',
    }), session);
    expect(chunk?.type).toBe('tool_use');
    return chunk!.toolCall!.name;
  }

  it.each([
    ['write', 'file-create'],
    ['edit', 'file-edit'],
    ['bash', 'bash-command'],
    ['read', 'file-read'],
  ] as Array<[string, PermissionActionType]>)('emitted %s classifies as %s', (name, expected) => {
    expectClassification(emit(name), expected);
  });

  it('gates unknown tool names (fail closed)', () => {
    const emitted = emit('gateway_custom_tool');
    expect(shouldGateToolUse(askSettings(), emitted)).toBe(true);
  });
});

// ============================================================================
// normalizeToolName unit behavior
// ============================================================================
describe('normalizeToolName', () => {
  it('is idempotent for canonical names', () => {
    for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
      expect(normalizeToolName(name)).toBe(name);
    }
  });

  it('leaves unknown names unchanged (classifier fail-closes them)', () => {
    expect(normalizeToolName('save_memory')).toBe('save_memory');
    expect(normalizeToolName('')).toBe('');
  });

  it('maps provider-native names to canonical names', () => {
    expect(normalizeToolName('write_file')).toBe('Write');
    expect(normalizeToolName('replace')).toBe('Edit');
    expect(normalizeToolName('run_shell_command')).toBe('Bash');
    expect(normalizeToolName('web_fetch')).toBe('WebFetch');
    expect(normalizeToolName('google_web_search')).toBe('WebSearch');
  });
});
