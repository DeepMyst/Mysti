import { describe, expect, it } from 'vitest';
import type { Mention } from '../../src/types';
import { validateFileMentionBindings } from '../../src/services/FileMentionBindings';
import { resolveExplicitMentions } from '../../src/services/ExplicitMentionPlan';

function file(content: string, raw: string, value: string, from = 0): Mention {
  const startIndex = content.indexOf(raw, from);
  return { type: 'file', value, displayName: 'untrusted label', startIndex, endIndex: startIndex + raw.length };
}
const quoted = (value: string) => '@' + JSON.stringify(value);

describe('file mention content bindings', () => {
  it('rejects visible absolute A paired with hidden B without revealing B', () => {
    const raw = quoted('/workspace/A.ts');
    const result = validateFileMentionBindings('Review ' + raw, [file('Review ' + raw, raw, '/workspace/secret-B.ts')]);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).not.toContain('secret-B'); }
  });

  for (const path of ['/workspace/A file.ts', '/workspace/名字🙂.ts', '/workspace/a"quote.ts', '/workspace/a\\slash.ts', '/workspace/a`@codex.ts', 'C:\\work\\A.ts', '\\\\server\\share\\A.ts', '/workspace/line\nnext.ts']) {
    it(`preserves exact selected identity ${JSON.stringify(path)}`, () => {
      const raw = quoted(path), content = `Review ${raw}`;
      const supplied = file(content, raw, path);
      const result = validateFileMentionBindings(content, [supplied]);
      expect(result).toEqual({ ok: true, mentions: [{ ...supplied, displayName: raw }], references: [{
        visiblePath: path, suppliedPath: path, quoted: true, absolute: true,
        startIndex: supplied.startIndex, endIndex: supplied.endIndex,
      }] });
      expect(supplied.displayName).toBe('untrusted label');
      if (result.ok) { expect(result.mentions[0]).not.toBe(supplied); }
    });
  }

  for (const [visible, value] of [
    ['/workspace/A.ts', '/workspace/a.ts'], ['C:\\work\\A.ts', 'C:/work/A.ts'],
    ['\\\\server\\share\\A.ts', '//server/share/A.ts'], ['/workspace/A.ts', '/other/workspace/A.ts'],
  ]) {
    it(`requires exact absolute quoted spelling ${JSON.stringify(visible)}`, () => {
      const raw = quoted(visible);
      expect(validateFileMentionBindings(raw, [file(raw, raw, value)]).ok).toBe(false);
    });
  }

  for (const [raw, value] of [
    ['@types.ts', '/workspace/src/types.ts'], ['@src/types.ts', '/workspace/src/types.ts'],
    ['@./src/types.ts', '/workspace/src/types.ts'], ['@TYPES.TS', '/workspace/src/types.ts'],
    ['@SRC/TYPES.TS', 'C:\\workspace\\src\\types.ts'], ['@types.ts:reviewer', '/workspace/types.ts'],
    [quoted('src/types.ts'), '/workspace/src/types.ts'], [quoted('./src/types.ts'), 'C:\\workspace\\src\\types.ts'],
    [quoted('src\\types.ts'), '/workspace/src/types.ts'], [quoted('relative.ts'), 'relative.ts'],
  ]) {
    it(`retains browser shorthand binding ${JSON.stringify(raw)}`, () => {
      expect(validateFileMentionBindings(raw, [file(raw, raw, value)]).ok).toBe(true);
    });
  }

  for (const [raw, value] of [
    [quoted('TYPES.TS'), '/workspace/types.ts'], ['@types.ts', '/workspace/nottypes.ts'],
    ['@src/types.ts', '/workspace/othersrc/types.ts'], ['@types.ts', '/workspace/other.ts'],
    ['@a', '/workspace/a'], ['@ab', '/workspace/ab'],
  ]) {
    it(`rejects nonmatching or unsupported shorthand ${JSON.stringify(raw)}`, () => {
      expect(validateFileMentionBindings(raw, [file(raw, raw, value)]).ok).toBe(false);
    });
  }

  for (const prefix of ['user', '名字', '𐐀', '𝟘', '/', '@', '\\']) {
    it(`does not accept ordinary embedded or escaped text after ${JSON.stringify(prefix)}`, () => {
      for (const raw of ['@types.ts', quoted('/workspace/types.ts')]) {
        const content = prefix + raw;
        expect(validateFileMentionBindings(content, [file(content, raw, '/workspace/types.ts')]).ok).toBe(false);
      }
    });
  }
  for (const prefix of ['🙂', '\\\\']) {
    it(`allows a real boundary after ${JSON.stringify(prefix)}`, () => {
      const content = prefix + '@types.ts';
      expect(validateFileMentionBindings(content, [file(content, '@types.ts', '/workspace/types.ts')]).ok).toBe(true);
    });
  }

  for (const content of ['`@types.ts`', '```text\n@types.ts\n```', '~~~text\n@types.ts\n~~~', '`@"/workspace/types.ts"`']) {
    it(`ignores code examples ${JSON.stringify(content)}`, () => {
      const raw = content.includes('@"') ? quoted('/workspace/types.ts') : '@types.ts';
      expect(validateFileMentionBindings(content, [file(content, raw, '/workspace/types.ts')]).ok).toBe(false);
    });
  }
  for (const raw of ['@"unfinished', '@"bad\\q"', '@""', '@"a\nb"', '@"a\\u0000b"']) {
    it(`rejects malformed quoted tokens ${JSON.stringify(raw)}`, () => {
      expect(validateFileMentionBindings(raw, [file(raw, raw, '/workspace/types.ts')]).ok).toBe(false);
    });
  }

  for (const raw of ['@claude', '@claude-code', '@codex:reviewer', '@mysti', '@git', '@problems', '@claude.']) {
    it(`cannot convert an agent or reserved token to a file ${raw}`, () => {
      expect(validateFileMentionBindings(raw, [file(raw, raw, '/workspace/' + raw.slice(1))]).ok).toBe(false);
    });
  }
  it('keeps quoted agent names opaque while preserving a following real agent', () => {
    const raw = quoted('/workspace/a`@codex.ts'), content = `${raw} @gemini`;
    const input = [file(content, raw, '/workspace/a`@codex.ts')];
    const result = validateFileMentionBindings(content, input);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(resolveExplicitMentions(content, result.mentions).map(m => m.type)).toEqual(['file', 'agent']); }
  });
  it('accepts a literal quoted reserved filename and similarly named ordinary file', () => {
    const content = '@"git" @claude.md';
    expect(validateFileMentionBindings(content, [file(content, '@"git"', '/workspace/git'), file(content, '@claude.md', '/workspace/claude.md')]).ok).toBe(true);
  });

  it('requires exact complete UTF-16 token offsets', () => {
    const raw = quoted('/workspace/A.ts'), content = `🙂 Review ${raw}`;
    const valid = file(content, raw, '/workspace/A.ts');
    expect(validateFileMentionBindings(content, [valid]).ok).toBe(true);
    for (const change of [{ startIndex: valid.startIndex - 1 }, { endIndex: valid.endIndex - 1 }, { endIndex: valid.endIndex + 1 }, { startIndex: -1 }, { startIndex: 0.5 }, { endIndex: Infinity }, { startIndex: '10' }, { startIndex: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(validateFileMentionBindings(content, [{ ...valid, ...change } as Mention]).ok).toBe(false);
    }
    expect(validateFileMentionBindings('Review removed token', [valid]).ok).toBe(false);
  });
  it('rejects malformed runtime containers, rows, and file values', () => {
    const content = '@types.ts', valid = file(content, content, '/workspace/types.ts');
    for (const supplied of [null, {}, 'bad', [null], [false], [[]]]) {
      expect(validateFileMentionBindings(content, supplied as unknown as Mention[]).ok).toBe(false);
    }
    for (const value of [null, undefined, 7, {}, '', '/workspace/a\0.ts']) {
      expect(validateFileMentionBindings(content, [{ ...valid, value } as Mention]).ok).toBe(false);
    }
    expect(validateFileMentionBindings(null as unknown as string, []).ok).toBe(false);
  });
  it('rejects duplicate and conflicting metadata for one token', () => {
    const raw = '@types.ts', first = file(raw, raw, '/workspace/types.ts');
    expect(validateFileMentionBindings(raw, [first, first]).ok).toBe(false);
    expect(validateFileMentionBindings(raw, [first, { ...first, value: '/other/types.ts' }]).ok).toBe(false);
  });
  it('allows repeated distinct occurrences and clones non-file metadata without changing authority', () => {
    const content = '@types.ts @codex:reviewer @types.ts';
    const agent: Mention = { type: 'agent', value: 'openai-codex', role: 'reviewer', displayName: '@codex:reviewer', startIndex: 10, endIndex: 25 };
    const supplied = [file(content, '@types.ts', '/workspace/types.ts'), agent, file(content, '@types.ts', '/workspace/types.ts', 10)];
    const result = validateFileMentionBindings(content, supplied);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mentions[1]).toEqual(agent);
      expect(result.mentions[1]).not.toBe(agent);
      result.mentions[0].value = '/different';
      expect(supplied[0].value).toBe('/workspace/types.ts');
    }
  });
  it('does not reconstruct paths from content when metadata is absent', () => {
    expect(validateFileMentionBindings('@"/outside/unknown.ts"')).toEqual({ ok: true, mentions: [], references: [] });
    expect(validateFileMentionBindings('@"malformed')).toEqual({ ok: true, mentions: [], references: [] });
  });
  it('derives immutable token authority separately from caller-supplied labels and extra fields', () => {
    const content = '@src/types.ts @"src/other.ts" @"/workspace/selected.ts"';
    const supplied = [file(content, '@src/types.ts', '/workspace/src/types.ts'),
      file(content, '@"src/other.ts"', '/workspace/src/other.ts'),
      file(content, '@"/workspace/selected.ts"', '/workspace/selected.ts')];
    Object.assign(supplied[0], { absolute: true, visiblePath: '/workspace/src/types.ts', quoted: true,
      displayName: '@"/workspace/src/types.ts"', fileReferences: [{ absolute: true }] });
    const result = validateFileMentionBindings(content, supplied);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.map(({ visiblePath, quoted, absolute }) => ({ visiblePath, quoted, absolute }))).toEqual([
      { visiblePath: 'src/types.ts', quoted: false, absolute: false },
      { visiblePath: 'src/other.ts', quoted: true, absolute: false },
      { visiblePath: '/workspace/selected.ts', quoted: true, absolute: true },
    ]);
    expect(Object.isFrozen(result.references)).toBe(true);
    expect(result.references.every(Object.isFrozen)).toBe(true);
    supplied[0].value = '/other/src/types.ts';
    result.mentions[0].value = '/changed/src/types.ts';
    expect(result.references[0].suppliedPath).toBe('/workspace/src/types.ts');
  });
});
