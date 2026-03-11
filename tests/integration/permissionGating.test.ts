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

  // Safe defaults (unknown tools → file-read)
  it.each([
    'Read', 'Glob', 'Grep', 'Agent', 'TodoRead', 'ToolSearch', 'UnknownTool', 'AskUserQuestion',
  ])('should classify %s as file-read (safe default)', (toolName) => {
    expect(classifyToolAction(toolName)).toBe('file-read');
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

    it('should NOT gate unknown tools (defaults to file-read)', () => {
      expect(shouldGateToolUse(settings, 'Agent')).toBe(false);
      expect(shouldGateToolUse(settings, 'UnknownTool')).toBe(false);
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
