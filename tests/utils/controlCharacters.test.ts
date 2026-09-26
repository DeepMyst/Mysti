import { describe, expect, it } from 'vitest';
import { hasControlCharacters, replaceAsciiControlCharacters } from '../../src/utils/controlCharacters';
import { hasUnsafeChars, validateText } from '../../src/services/desk/DeskContract';
import { sanitizeMcpInputSchema } from '../../src/services/coordinatorTools';

describe('control characters at Desk and MCP boundaries', () => {
  it('rejects every C0/C1 control in Desk identifiers', () => {
    const controls = [...Array(32).keys(), ...Array.from({ length: 33 }, (_, i) => i + 127)];
    for (const code of controls) {
      const input = `a${String.fromCharCode(code)}b`;
      expect(hasUnsafeChars(input), `control ${code}`).toBe(true);
      expect(hasControlCharacters(input), `control ${code}`).toBe(true);
    }
  });

  it('allows only tab, newline and carriage return when screening prose controls', () => {
    for (let code = 0; code < 32; code++) {
      const input = `a${String.fromCharCode(code)}b`;
      const permitted = [9, 10, 13].includes(code);
      expect(hasControlCharacters(input, { allowTextWhitespace: true }), `control ${code}`).toBe(!permitted);
      expect(validateText(input, 100).ok, `control ${code}`).toBe(permitted);
    }
  });

  it('preserves the separate C1 policy for legacy free text', () => {
    const input = 'a\u0085b';
    expect(hasControlCharacters(input, { allowTextWhitespace: true })).toBe(true);
    expect(hasControlCharacters(input, { includeC1: false })).toBe(false);
    expect(validateText(input, 100).ok).toBe(true);
  });

  it('normalizes every ASCII control in MCP descriptions and retains Unicode prose', () => {
    const controls = [...Array(32).keys(), 127].map(code => String.fromCharCode(code)).join('');
    expect(sanitizeMcpInputSchema({ description: ` Read${controls}文件 🧪 ` }))
      .toEqual({ description: 'Read 文件 🧪' });
    expect(replaceAsciiControlCharacters('hello\u0085世界 🧪', ' ')).toBe('hello\u0085世界 🧪');
    expect(hasControlCharacters('hello 世界 🧪')).toBe(false);
  });
});
