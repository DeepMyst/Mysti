/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the shared agent markdown parsing helpers: frontmatter
 * parsing, section extraction (H1–H4 tolerant), instruction fallbacks,
 * and id slugification/safety.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAgentMarkdown,
  extractAgentSection,
  extractAgentList,
  extractAgentInstructions,
  slugifyAgentId,
  isSafeAgentId,
  AGENT_FILE_BASENAMES
} from '../../src/managers/agentMarkdown';

describe('parseAgentMarkdown', () => {
  it('parses key-value frontmatter and body', () => {
    const { frontmatter, body } = parseAgentMarkdown('---\nid: test\nname: Test Agent\n---\n\nBody text');
    expect(frontmatter.id).toBe('test');
    expect(frontmatter.name).toBe('Test Agent');
    expect(body.trim()).toBe('Body text');
  });

  it('strips quotes from values', () => {
    const { frontmatter } = parseAgentMarkdown('---\nname: "Quoted Name"\ndescription: \'single\'\n---\nx');
    expect(frontmatter.name).toBe('Quoted Name');
    expect(frontmatter.description).toBe('single');
  });

  it('parses block arrays', () => {
    const { frontmatter } = parseAgentMarkdown('---\nactivationTriggers:\n  - one\n  - two\n---\nx');
    expect(frontmatter.activationTriggers).toEqual(['one', 'two']);
  });

  it('parses inline arrays', () => {
    const { frontmatter } = parseAgentMarkdown('---\ntags: [a, b, "c"]\n---\nx');
    expect(frontmatter.tags).toEqual(['a', 'b', 'c']);
  });

  it('handles CRLF line endings', () => {
    const { frontmatter, body } = parseAgentMarkdown('---\r\nid: crlf\r\n---\r\nBody');
    expect(frontmatter.id).toBe('crlf');
    expect(body).toContain('Body');
  });

  it('returns empty frontmatter when none present', () => {
    const { frontmatter, body } = parseAgentMarkdown('# Just a doc\n\nContent');
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toContain('Just a doc');
  });

  it('handles values containing colons', () => {
    const { frontmatter } = parseAgentMarkdown('---\ndescription: Use x: y patterns\n---\nx');
    expect(frontmatter.description).toBe('Use x: y patterns');
  });

  it('skips YAML block-scalar indicators instead of storing a literal ">"', () => {
    const { frontmatter } = parseAgentMarkdown('---\ndescription: >-\n  folded text line\nname: x\n---\nbody');
    expect(frontmatter.description).toBeUndefined();
    expect(frontmatter.name).toBe('x');
  });
});

describe('extractAgentSection', () => {
  it('extracts an H2 section', () => {
    const body = '## Instructions\n\nDo the thing.\n\n## Other\n\nNope';
    expect(extractAgentSection(body, 'Instructions')).toBe('Do the thing.');
  });

  it('extracts an H1 section (legacy core files)', () => {
    const body = '# Key Characteristics\n\nFocus on scalable systems.\n\n## Communication Style\n\nClear.';
    expect(extractAgentSection(body, 'Key Characteristics')).toBe('Focus on scalable systems.');
  });

  it('keeps H3 subsections inside the section', () => {
    const body = '## Code Examples\n\n### Example A\n\ncode here\n\n## Next\n\nx';
    const section = extractAgentSection(body, 'Code Examples');
    expect(section).toContain('### Example A');
    expect(section).toContain('code here');
    expect(section).not.toContain('Next');
  });

  it('is case-insensitive and escapes regex metacharacters', () => {
    const body = '## Anti-Patterns to Avoid\n\n- bad thing\n';
    expect(extractAgentSection(body, 'anti-patterns to avoid')).toContain('bad thing');
    expect(extractAgentSection(body, 'Checklist (before done)')).toBeUndefined();
  });

  it('returns undefined for missing sections', () => {
    expect(extractAgentSection('## A\n\nx', 'Missing')).toBeUndefined();
  });

  it('does not terminate at # comment lines inside code fences', () => {
    const body = [
      '## Instructions',
      '',
      'Run the setup:',
      '',
      '```bash',
      '# install deps',
      'npm install',
      '```',
      '',
      'Then continue.',
      '',
      '## Next Section',
      'other'
    ].join('\n');
    const section = extractAgentSection(body, 'Instructions')!;
    expect(section).toContain('# install deps');
    expect(section).toContain('npm install');
    expect(section).toContain('Then continue.');
    expect(section).not.toContain('other');
    // balanced fences — nothing truncated mid-block
    expect((section.match(/```/g) || []).length % 2).toBe(0);
  });

  it('handles ~~~ fences and headings that follow a closed fence', () => {
    const body = '## Code Examples\n\n~~~python\n# comment\nprint(1)\n~~~\n\n## After\nx';
    const section = extractAgentSection(body, 'Code Examples')!;
    expect(section).toContain('# comment');
    expect(section).not.toContain('After');
  });

  it('terminates an H3-started section at the next H3 heading', () => {
    const body = '### Priorities\n\n1. First\n2. Second\n\n### Best Practices\n\n- BP one\n- BP two\n';
    expect(extractAgentList(body, 'Priorities')).toEqual(['First', 'Second']);
    expect(extractAgentList(body, 'Best Practices')).toEqual(['BP one', 'BP two']);
  });
});

describe('extractAgentList', () => {
  it('extracts bullets and numbered items', () => {
    const body = '## Priorities\n\n1. First\n2. Second\n\n## Best Practices\n\n- One\n* Two\n';
    expect(extractAgentList(body, 'Priorities')).toEqual(['First', 'Second']);
    expect(extractAgentList(body, 'Best Practices')).toEqual(['One', 'Two']);
  });

  it('returns undefined for prose-only sections', () => {
    expect(extractAgentList('## Notes\n\nJust prose.', 'Notes')).toBeUndefined();
  });
});

describe('extractAgentInstructions', () => {
  it('prefers Key Characteristics', () => {
    const body = '# Key Characteristics\n\nBe an architect.\n\n## Instructions\n\nIgnored.';
    expect(extractAgentInstructions(body)).toBe('Be an architect.');
  });

  it('falls back to Instructions', () => {
    const body = '## Instructions\n\nWrite tests.\n\n## Other\n\nx';
    expect(extractAgentInstructions(body)).toBe('Write tests.');
  });

  it('falls back to first prose paragraph, never a bare heading', () => {
    const body = '# Some Title\n\nActual prose content here.\n\nMore.';
    const result = extractAgentInstructions(body);
    expect(result).toBe('Actual prose content here.');
    expect(result.startsWith('#')).toBe(false);
  });

  it('skips heading-only paragraphs in the fallback', () => {
    // The pre-fix behavior returned "# Key Characteristics" verbatim when
    // the heading and prose were in the same paragraph split — guard it
    const body = '# Overview\n## Sub\n\nReal text.';
    expect(extractAgentInstructions(body)).toBe('Real text.');
  });
});

describe('slugifyAgentId / isSafeAgentId', () => {
  it('slugifies display names', () => {
    expect(slugifyAgentId('API Designer')).toBe('api-designer');
    expect(slugifyAgentId('  Weird!! Name__ ')).toBe('weird-name');
    expect(slugifyAgentId('SKILL.md')).toBe('skill');
  });

  it('returns null when nothing remains', () => {
    expect(slugifyAgentId('!!!')).toBeNull();
    expect(slugifyAgentId('')).toBeNull();
  });

  it('validates safe ids', () => {
    expect(isSafeAgentId('test-driven')).toBe(true);
    expect(isSafeAgentId('a')).toBe(true);
    expect(isSafeAgentId('../evil')).toBe(false);
    expect(isSafeAgentId('UPPER')).toBe(false);
    expect(isSafeAgentId('-leading')).toBe(false);
    expect(isSafeAgentId('has space')).toBe(false);
    expect(isSafeAgentId('')).toBe(false);
  });

  it('exposes the canonical per-directory basenames', () => {
    expect(AGENT_FILE_BASENAMES).toContain('skill.md');
    expect(AGENT_FILE_BASENAMES).toContain('skills.md');
  });
});
