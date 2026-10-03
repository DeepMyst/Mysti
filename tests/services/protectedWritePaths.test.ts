/**
 * Plan 20 Phase 2 (invariant I4) — an agent may not write instruction surfaces.
 *
 * These are the files that tell an agent how to behave next session. A write
 * here is not an edit; it converts a one-shot prompt injection into
 * persistence, and it escapes review because nobody reads a `.cursorrules`
 * diff the way they read a source diff.
 */
import { describe, it, expect } from 'vitest';
import { protectedWriteReason, SKILL_STAGING_DIR } from '../../src/services/MystiLocalTools';

describe('protected instruction surfaces', () => {
  it('refuses Mysti live agent definitions and names the staging path', () => {
    const reason = protectedWriteReason('.mysti/agents/personas/architect.md');
    expect(reason).toBeTruthy();
    expect(reason).toContain(SKILL_STAGING_DIR);
  });

  it('refuses other assistants\' instruction files', () => {
    for (const p of [
      '.claude/settings.json',
      '.claude/skills/x/SKILL.md',
      '.cursor/rules/main.mdc',
      '.cursorrules',
      '.github/copilot-instructions.md',
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.aider.conf.yml',
      '.mysti/mysti.md',
      '.mysti/rules',
    ]) {
      expect(protectedWriteReason(p), `expected ${p} to be refused`).toBeTruthy();
    }
  });

  it('refuses MCP wiring and VSCode files that execute on open', () => {
    // `.mcp.json` redirects where tool calls actually go; tasks/launch run
    // commands, and settings.json can point the toolchain at another binary.
    expect(protectedWriteReason('.mcp.json')).toBeTruthy();
    expect(protectedWriteReason('.vscode/tasks.json')).toBeTruthy();
    expect(protectedWriteReason('.vscode/launch.json')).toBeTruthy();
    expect(protectedWriteReason('.vscode/settings.json')).toBeTruthy();
  });

  it('ALLOWS the staging tree — that is the writable authoring path', () => {
    expect(protectedWriteReason(`${SKILL_STAGING_DIR}/my-skill/SKILL.md`)).toBeNull();
    expect(protectedWriteReason(`${SKILL_STAGING_DIR}/my-skill/scripts/run.sh`)).toBeNull();
  });

  it('ALLOWS ordinary project work, including config', () => {
    // A general "config is protected" rule would break normal work; only
    // instruction surfaces are special.
    for (const p of [
      'src/index.ts',
      'package.json',
      'tsconfig.json',
      '.github/workflows/ci.yml',
      'docs/CLAUDE-integration.md',
      'src/claude/client.ts',
      '.vscode/extensions.json',
      'README.md',
    ]) {
      expect(protectedWriteReason(p), `expected ${p} to be allowed`).toBeNull();
    }
  });

  it('is not fooled by a leading ./ or by casing', () => {
    expect(protectedWriteReason('./.cursorrules')).toBeTruthy();
    expect(protectedWriteReason('claude.md')).toBeTruthy();
    expect(protectedWriteReason('.MYSTI/agents/personas/x.md')).toBeTruthy();
  });

  it('does not match a lookalike nested deeper in the tree', () => {
    // Only the repo-root instruction surfaces are protected; a vendored copy
    // inside a fixture directory is ordinary content.
    expect(protectedWriteReason('tests/fixtures/.cursorrules')).toBeNull();
    expect(protectedWriteReason('vendor/pkg/CLAUDE.md')).toBeNull();
  });
});
