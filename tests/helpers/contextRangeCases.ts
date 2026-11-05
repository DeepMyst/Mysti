import type { ContextItem } from '../../src/types';

// Selected bytes and exclusive end columns agree with each line span.
export const contextRangeCases = [
  { name: 'first line', startLine: 0, endLine: 0, endCharacter: 5, content: 'hello', label: '1-1' },
  { name: 'partial final line', startLine: 4, endLine: 7, endCharacter: 2, content: 'five\nsix\nseven\nei', label: '5-8' },
  { name: 'exclusive empty final line', startLine: 4, endLine: 7, endCharacter: 0, content: 'five\nsix\nseven\n', label: '5-7' },
  { name: 'CRLF first line with Unicode', startLine: 0, endLine: 1, endCharacter: 0, content: 'العربية 👩🏽‍💻\r\n', label: '1-1' },
  { name: 'empty same-line range', startLine: 0, endLine: 0, endCharacter: 0, content: '', label: '1-1' },
  { name: 'legacy endpoint fallback despite trailing newline', startLine: 0, endLine: 1, content: 'legacy\n', label: '1-2' },
  { name: 'missing endpoints', content: 'preserved', label: undefined },
  { name: 'negative start', startLine: -1, endLine: 2, content: 'preserved', label: undefined },
  { name: 'fractional end', startLine: 0, endLine: 1.5, content: 'preserved', label: undefined },
  { name: 'reversed endpoints', startLine: 2, endLine: 1, content: 'preserved', label: undefined },
  { name: 'unsafe display endpoint', startLine: 0, endLine: Number.MAX_SAFE_INTEGER, content: 'preserved', label: undefined },
  { name: 'invalid end column', startLine: 0, endLine: 1, endCharacter: -1, content: 'preserved', label: undefined },
] as const;

export function contextRangeItem(value: typeof contextRangeCases[number], index = 0): ContextItem {
  const { name: _name, label: _label, ...range } = value;
  return { id: `range-${index}`, type: 'selection', path: `/workspace/selection-${index}.ts`, language: 'typescript', enabled: true, ...range };
}
