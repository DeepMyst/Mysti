/**
 * Unit tests for src/utils/toolNames.ts — the single tool-name/kind authority
 * (Plan 02 Phase 3). normalizeToolName behavior is also covered by the
 * 8-provider conformance suite (tests/integration/toolNameConformance.test.ts);
 * here we pin the toolKind() vocabulary the renderer codes against.
 */
import { describe, it, expect } from 'vitest';
import { normalizeToolName, parseToolName, toolKind } from '../../src/utils/toolNames';
import { normalizeToolName as reExported } from '../../src/utils/permissionClassifier';

describe('toolNames module', () => {
  it('permissionClassifier re-exports the same normalizeToolName', () => {
    expect(reExported).toBe(normalizeToolName);
  });

  describe('toolKind', () => {
    it.each([
      // Canonical names
      ['Read', 'read'],
      ['Grep', 'search'],
      ['Glob', 'search'],
      ['LS', 'search'],
      ['Edit', 'edit'],
      ['MultiEdit', 'edit'],
      ['Write', 'edit'],
      ['NotebookEdit', 'edit'],
      ['Delete', 'delete'],
      ['Bash', 'execute'],
      ['WebFetch', 'fetch'],
      ['WebSearch', 'fetch'],
      ['TodoWrite', 'think'],
      ['ExitPlanMode', 'think'],
      ['Task', 'other'],
      ['AskUserQuestion', 'other'],
      // Provider-native names (normalized first)
      ['write_file', 'edit'],
      ['replace', 'edit'],
      ['run_shell_command', 'execute'],
      ['google_web_search', 'fetch'],
      ['web_search', 'fetch'],
      ['read_many_files', 'read'],
      ['search_file_content', 'search'],
      ['list_directory', 'search'],
      // Cline-native names (heuristic/explicit buckets)
      ['write_to_file', 'edit'],
      ['replace_in_file', 'edit'],
      ['execute_command', 'execute'],
      ['read_file', 'read'],
      ['rename_file', 'move'],
      ['delete_file', 'delete'],
    ])('toolKind(%s) === %s', (name, expected) => {
      expect(toolKind(name)).toBe(expected);
    });

    it('returns other for unknown and empty names (rendering only — the gate still fail-closes)', () => {
      expect(toolKind('')).toBe('other');
      expect(toolKind('SomeBrandNewTool')).toBe('other');
      expect(toolKind('save_memory')).toBe('other');
    });

    it('heuristically buckets unknown names that look actionable', () => {
      expect(toolKind('mcp_delete_branch')).toBe('delete');
      expect(toolKind('create_pull_request')).toBe('edit');
      expect(toolKind('run_in_terminal')).toBe('execute');
      expect(toolKind('http_request')).toBe('fetch');
      expect(toolKind('find_references')).toBe('search');
    });

    it('is case-insensitive', () => {
      expect(toolKind('BASH')).toBe('execute');
      expect(toolKind('webfetch')).toBe('fetch');
      expect(toolKind('Replace')).toBe('edit');
    });

    // Plan 20 §3.6 — the renderer must bucket canvas tools by what they do to
    // the design, and must see through the `mcp__<server>__` namespace (before
    // the strip, every MCP canvas call rendered as the generic 'other' card).
    it.each([
      ['list_pages', 'search'],
      ['read_page', 'read'],
      ['get_artifact_index', 'read'],
      ['validate_page', 'read'],
      ['edit_page', 'edit'],
      ['write_page_jsx', 'edit'],
      ['scaffold_page', 'edit'],
      ['set_theme', 'edit'],
      ['edit_element', 'edit'],
      ['delete_page', 'delete'],
      ['mcp__mysti-canvas__list_pages', 'search'],
      ['mcp__mysti-canvas__read_page', 'read'],
      ['mcp__mysti-canvas__edit_page', 'edit'],
    ])('toolKind(%s) === %s', (name, expected) => {
      expect(toolKind(name)).toBe(expected);
    });
  });

  // Plan 20 §3.6 — normalizeToolName strips the MCP namespace; parseToolName
  // is the variant that keeps the provenance the classifier needs.
  describe('parseToolName / normalizeToolName MCP namespace', () => {
    it('strips one mcp__<server>__ segment and reports the server', () => {
      expect(normalizeToolName('mcp__mysti-canvas__list_pages')).toBe('list_pages');
      expect(parseToolName('mcp__mysti-canvas__list_pages').mcpServer).toBe('mysti-canvas');
    });

    it('still aliases the stripped name to the canonical vocabulary', () => {
      expect(normalizeToolName('mcp__anything__write_file')).toBe('Write');
      expect(normalizeToolName('mcp__anything__run_shell_command')).toBe('Bash');
    });

    it('leaves bare and malformed names exactly as they were', () => {
      expect(normalizeToolName('Read')).toBe('Read');
      expect(normalizeToolName('save_memory')).toBe('save_memory');
      expect(normalizeToolName('mcp__srv__')).toBe('mcp__srv__');
      expect(normalizeToolName('mcp____tool')).toBe('mcp____tool');
      expect(normalizeToolName('')).toBe('');
    });
  });
});
