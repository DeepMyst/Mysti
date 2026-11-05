/**
 * Tests for the canonical @-mention role grammar (Plan 14).
 */
import { describe, it, expect } from 'vitest';
import { parseAgentRoleMentions, parseQuotedFileMentions } from '../../src/utils/mentionParser';

describe('parseAgentRoleMentions', () => {
  it('parses a plain agent mention with no role', () => {
    const [m] = parseAgentRoleMentions('hey @gemini look at this');
    expect(m.name).toBe('gemini');
    expect(m.role).toBeUndefined();
    expect(m.raw).toBe('@gemini');
  });

  it('parses an agent:role mention', () => {
    const [m] = parseAgentRoleMentions('@google-gemini:critic here is my plan');
    expect(m.name).toBe('google-gemini');
    expect(m.role).toBe('critic');
    expect(m.raw).toBe('@google-gemini:critic');
    expect(m.startIndex).toBe(0);
    expect(m.endIndex).toBe('@google-gemini:critic'.length);
  });

  it('parses multiple role mentions in one message', () => {
    const parsed = parseAgentRoleMentions('@gemini:critic @codex:reviewer weigh in');
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toMatchObject({ name: 'gemini', role: 'critic' });
    expect(parsed[1]).toMatchObject({ name: 'codex', role: 'reviewer' });
  });

  it('lowercases name and role', () => {
    const [m] = parseAgentRoleMentions('@Gemini:Critic');
    expect(m.name).toBe('gemini');
    expect(m.role).toBe('critic');
  });

  it('treats a trailing colon with no role as no role', () => {
    const [m] = parseAgentRoleMentions('@gemini: what do you think');
    expect(m.name).toBe('gemini');
    expect(m.role).toBeUndefined();
  });

  it('leaves file-path mentions without a role', () => {
    const [m] = parseAgentRoleMentions('check @src/auth.ts please');
    expect(m.name).toBe('src/auth.ts');
    expect(m.role).toBeUndefined();
  });

  it('handles hyphenated role ids', () => {
    const [m] = parseAgentRoleMentions('@claude:second-opinion');
    expect(m.name).toBe('claude');
    expect(m.role).toBe('second-opinion');
  });

  it('returns an empty array when there are no mentions', () => {
    expect(parseAgentRoleMentions('no mentions here')).toEqual([]);
  });

  for (const path of [
    '/workspace/team @claude notes.ts',
    '/workspace/@gemini:critic.ts',
    '/workspace/日本語 @codex 👩🏽‍💻.ts',
    '/workspace/a "quote" and \\slash @claude.md',
  ]) {
    it(`does not route agent text inside the quoted file ${JSON.stringify(path)}`, () => {
      const file = '@' + JSON.stringify(path);
      const content = `Review ${file} with @gemini:critic`;
      expect(parseAgentRoleMentions(content)).toEqual([{
        name: 'gemini', role: 'critic', raw: '@gemini:critic',
        startIndex: content.lastIndexOf('@gemini:critic'), endIndex: content.length,
      }]);
    });
  }

  it('does not reinterpret an invalid quoted path as agent assignments', () => {
    const content = String.raw`@"/workspace/bad\q @claude file.ts" @gemini`;
    expect(parseAgentRoleMentions(content).map(token => token.raw)).toEqual(['@gemini']);
  });

  it('suppresses agents inside an unfinished quoted file only until the next line', () => {
    expect(parseAgentRoleMentions('@"/workspace/unfinished @claude\n@gemini').map(token => token.raw)).toEqual(['@gemini']);
  });
});

describe('parseQuotedFileMentions', () => {
  for (const path of [
    '/workspace/Package One/MixedCase.ts',
    '/workspace/日本語/العربية 👩🏽‍💻.ts',
    '/workspace/a "quote" and \\slash @claude:critic.ts',
    'C:\\workspace\\two files\\File.ts',
    './relative/path with spaces.ts',
  ]) {
    it(`round-trips the exact visible path ${JSON.stringify(path)}`, () => {
      const raw = '@' + JSON.stringify(path), content = `🧪 review ${raw}, then @gemini:critic`;
      const startIndex = content.indexOf(raw);
      expect(parseQuotedFileMentions(content)).toEqual([{ path, raw, startIndex, endIndex: startIndex + raw.length }]);
      expect(content.slice(startIndex, startIndex + raw.length)).toBe(raw);
      expect(parseAgentRoleMentions(content).map(token => token.raw)).toEqual(['@gemini:critic']);
    });
  }

  for (const content of [
    '`@"/workspace/file.ts"`',
    '```ts\n@"/workspace/file.ts"\n```',
    '~~~text\n@"/workspace/file.ts"\n~~~',
    '```unclosed\n@"/workspace/file.ts"',
    'mail@"/workspace/file.ts"',
    '名字@"/workspace/file.ts"',
    '𐐀@"/workspace/file.ts"',
    '𝟘@"/workspace/file.ts"',
    '/@"/workspace/file.ts"',
    String.raw`\@"/workspace/file.ts"`,
  ]) {
    it(`ignores code, embedded or escaped marker ${JSON.stringify(content)}`, () => {
      expect(parseQuotedFileMentions(content)).toEqual([]);
    });
  }

  for (const content of [
    '@""', '@"unfinished', '@"raw\nnewline"', '@"raw\rnewline"',
    String.raw`@"bad\q path"`, String.raw`@"bad\uZZZZ path"`,
    String.raw`@"bad\u0000name"`,
  ]) {
    it(`does not emit a partial or malformed path ${JSON.stringify(content)}`, () => {
      expect(parseQuotedFileMentions(content)).toEqual([]);
    });
  }

  it('keeps exact offsets across two quoted files and a role mention', () => {
    const paths = ['/workspace/A one.ts', '/workspace/B @claude "two".ts'];
    const tokens = paths.map(path => '@' + JSON.stringify(path));
    const content = tokens.join(' and ') + ' @codex:reviewer';
    expect(parseQuotedFileMentions(content).map(token => [token.path, content.slice(token.startIndex, token.endIndex)]))
      .toEqual(paths.map((path, index) => [path, tokens[index]]));
    expect(parseAgentRoleMentions(content).map(token => token.raw)).toEqual(['@codex:reviewer']);
  });

  it('keeps backticks inside a quoted filename opaque before a real file and code span', () => {
    const paths = ['/workspace/a`file.ts', '/workspace/b.ts'];
    const content = paths.map(path => '@' + JSON.stringify(path)).join(' ') + ' `@claude` @gemini';
    expect(parseQuotedFileMentions(content).map(token => token.path)).toEqual(paths);
  });

  it('does not let an unfinished quote inside code swallow a later file or agent', () => {
    const content = '`@"unfinished` @gemini @"/workspace/real.ts"';
    expect(parseQuotedFileMentions(content).map(token => token.path)).toEqual(['/workspace/real.ts']);
    expect(parseAgentRoleMentions(content).map(token => token.raw)).toEqual(['@gemini']);
  });

  it('ends unmatched inline-code syntax at a carriage return before a real quoted file', () => {
    expect(parseQuotedFileMentions('`example\r@"/workspace/real.ts" `later`').map(token => token.path))
      .toEqual(['/workspace/real.ts']);
  });

  it('recognizes an unescaped marker after a literal escaped backslash', () => {
    expect(parseQuotedFileMentions(String.raw`\\@"path.ts"`).map(token => token.path)).toEqual(['path.ts']);
  });

  it('leaves the legacy unquoted parser case and role behavior unchanged', () => {
    expect(parseAgentRoleMentions('@Src/File.ts @Gemini:Critic').map(token => [token.name, token.role]))
      .toEqual([['src/file.ts', undefined], ['gemini', 'critic']]);
    expect(parseQuotedFileMentions('@src/file.ts @gemini:critic')).toEqual([]);
  });
});
