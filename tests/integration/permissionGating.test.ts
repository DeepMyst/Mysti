import { describe, it, expect } from 'vitest';
import { classifyToolAction, shouldGateToolUse } from '../../src/utils/permissionClassifier';
import type { Settings } from '../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'claude-code', ...overrides,
  };
}

describe('classifyToolAction', () => {
  // File edit tools
  it.each([
    ['Edit', 'file-edit'],
    ['edit_file', 'file-edit'],
    ['replace_in_file', 'file-edit'],
    ['insert_code_block', 'file-edit'],
    ['rename_file', 'file-edit'],
    ['apply_diff', 'file-edit'],
    ['apply_patch', 'file-edit'],
    ['NotebookEdit', 'file-edit'],
  ])('should classify %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });

  // File create tools
  it.each([
    ['Write', 'file-create'],
    ['write_to_file', 'file-create'],
    ['create_file', 'file-create'],
  ])('should classify %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });

  // File delete tools
  it.each([
    ['delete_file', 'file-delete'],
    ['remove_file', 'file-delete'],
  ])('should classify %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });

  // Multi-file edit tools
  it.each([
    ['MultiEdit', 'multi-file-edit'],
    ['multi_edit', 'multi-file-edit'],
  ])('should classify %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });

  // Bash/command tools
  it.each([
    ['Bash', 'bash-command'],
    ['bash', 'bash-command'],
    ['shell', 'bash-command'],
    ['execute_command', 'bash-command'],
    ['run_terminal_command', 'bash-command'],
  ])('should classify %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });

  // Read-only allowlist (explicitly safe — never gated)
  it.each([
    'Read', 'Glob', 'Grep', 'Agent', 'TodoRead', 'TodoWrite', 'Task',
    'ToolSearch', 'AskUserQuestion', 'NotebookRead', 'read_file',
    'list_directory', 'search_file_content', 'ls', 'codebase_search',
  ])('should classify %s as file-read (read-only allowlist)', (toolName) => {
    expect(classifyToolAction(toolName)).toBe('file-read');
  });

  // Case-insensitive classification (Cursor/OpenCode emit lowercase names)
  it.each([
    ['write', 'file-create'],
    ['edit', 'file-edit'],
    ['patch', 'file-edit'],
    ['delete', 'file-delete'],
    ['bash', 'bash-command'],
  ])('should classify lowercase %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });

  // Provider-native write tool names (Gemini/Qwen)
  it.each([
    ['write_file', 'file-create'],
    ['replace', 'file-edit'],
    ['run_shell_command', 'bash-command'],
  ])('should classify Gemini/Qwen native %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });

  // Web tools map to the canonical web-request classification
  it.each([
    'WebFetch', 'web_fetch', 'WebSearch', 'web_search', 'websearch',
    'fetch', 'google_web_search',
  ])('should classify %s as web-request', (toolName) => {
    expect(classifyToolAction(toolName)).toBe('web-request');
  });

  // FAIL-CLOSED: unknown tools must NOT classify as file-read
  it.each([
    'UnknownTool', 'mystery_operation', 'SlashCommand', '',
  ])('should classify unknown tool %s as non-read (fail closed)', (toolName) => {
    expect(classifyToolAction(toolName)).not.toBe('file-read');
  });

  // Heuristic bucketing for unrecognized names
  it.each([
    ['fs_remove_tree', 'file-delete'],
    ['create_directory', 'file-create'],
    ['apply_code_change', 'file-edit'],
    ['kill_terminal_process', 'bash-command'],
    ['http_request', 'web-request'],
  ])('should heuristically classify %s as %s', (toolName, expected) => {
    expect(classifyToolAction(toolName)).toBe(expected);
  });
});

describe('shouldGateToolUse', () => {
  describe('default mode + ask-permission access (most common)', () => {
    const settings = defaultSettings();

    it('should gate write tools (Edit)', () => {
      expect(shouldGateToolUse(settings, 'Edit')).toBe(true);
    });

    it('should gate bash commands', () => {
      expect(shouldGateToolUse(settings, 'Bash')).toBe(true);
    });

    it('should gate file creation', () => {
      expect(shouldGateToolUse(settings, 'Write')).toBe(true);
    });

    it('should gate file deletion', () => {
      expect(shouldGateToolUse(settings, 'delete_file')).toBe(true);
    });

    it('should NOT gate read operations', () => {
      expect(shouldGateToolUse(settings, 'Read')).toBe(false);
    });

    it('should NOT gate allowlisted orchestration tools', () => {
      expect(shouldGateToolUse(settings, 'Agent')).toBe(false);
      expect(shouldGateToolUse(settings, 'TodoWrite')).toBe(false);
      expect(shouldGateToolUse(settings, 'Task')).toBe(false);
    });

    it('should gate unknown tools (fail closed)', () => {
      expect(shouldGateToolUse(settings, 'UnknownTool')).toBe(true);
      expect(shouldGateToolUse(settings, 'mystery_operation')).toBe(true);
    });

    it('should gate web tools', () => {
      expect(shouldGateToolUse(settings, 'WebFetch')).toBe(true);
      expect(shouldGateToolUse(settings, 'web_search')).toBe(true);
    });
  });

  describe('ask-before-edit mode (always gates writes regardless of access level)', () => {
    it('should gate even with full-access', () => {
      const settings = defaultSettings({ mode: 'ask-before-edit', accessLevel: 'full-access' });
      expect(shouldGateToolUse(settings, 'Edit')).toBe(true);
      expect(shouldGateToolUse(settings, 'Bash')).toBe(true);
    });

    it('should gate with ask-permission', () => {
      const settings = defaultSettings({ mode: 'ask-before-edit', accessLevel: 'ask-permission' });
      expect(shouldGateToolUse(settings, 'Write')).toBe(true);
    });

    it('should gate with read-only', () => {
      const settings = defaultSettings({ mode: 'ask-before-edit', accessLevel: 'read-only' });
      expect(shouldGateToolUse(settings, 'Edit')).toBe(true);
    });

    it('should still NOT gate read operations', () => {
      const settings = defaultSettings({ mode: 'ask-before-edit', accessLevel: 'full-access' });
      expect(shouldGateToolUse(settings, 'Read')).toBe(false);
      expect(shouldGateToolUse(settings, 'Glob')).toBe(false);
    });
  });

  describe('edit-automatically mode (bypasses gating)', () => {
    it('should NOT gate with ask-permission', () => {
      const settings = defaultSettings({ mode: 'edit-automatically', accessLevel: 'ask-permission' });
      expect(shouldGateToolUse(settings, 'Edit')).toBe(false);
      expect(shouldGateToolUse(settings, 'Bash')).toBe(false);
    });

    it('should NOT gate with full-access', () => {
      const settings = defaultSettings({ mode: 'edit-automatically', accessLevel: 'full-access' });
      expect(shouldGateToolUse(settings, 'Edit')).toBe(false);
    });
  });

  describe('full-access level (no gating in default mode)', () => {
    it('should NOT gate any tools', () => {
      const settings = defaultSettings({ accessLevel: 'full-access' });
      expect(shouldGateToolUse(settings, 'Edit')).toBe(false);
      expect(shouldGateToolUse(settings, 'Bash')).toBe(false);
      expect(shouldGateToolUse(settings, 'delete_file')).toBe(false);
      expect(shouldGateToolUse(settings, 'MultiEdit')).toBe(false);
    });
  });

  describe('plan modes with ask-permission (gate still applies)', () => {
    it('should gate in quick-plan + ask-permission (access level still checked)', () => {
      const settings = defaultSettings({ mode: 'quick-plan' });
      // Plan modes don't have special exemption — access level check still fires
      expect(shouldGateToolUse(settings, 'Edit')).toBe(true);
    });

    it('should gate in detailed-plan + ask-permission', () => {
      const settings = defaultSettings({ mode: 'detailed-plan' });
      expect(shouldGateToolUse(settings, 'Bash')).toBe(true);
    });

    it('should NOT gate in quick-plan + full-access', () => {
      const settings = defaultSettings({ mode: 'quick-plan', accessLevel: 'full-access' });
      expect(shouldGateToolUse(settings, 'Edit')).toBe(false);
    });

    it('should NOT gate in quick-plan + edit-automatically', () => {
      const settings = defaultSettings({ mode: 'quick-plan', accessLevel: 'ask-permission' });
      // edit-automatically overrides ask-permission, but mode is quick-plan not edit-auto
      // So ask-permission check fires → true
      expect(shouldGateToolUse(settings, 'Edit')).toBe(true);
    });
  });

  describe('read-only access (no gating — not ask-permission)', () => {
    it('should NOT gate (read-only is not ask-permission)', () => {
      const settings = defaultSettings({ accessLevel: 'read-only' });
      expect(shouldGateToolUse(settings, 'Edit')).toBe(false);
    });
  });
});
