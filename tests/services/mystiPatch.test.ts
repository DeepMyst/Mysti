/**
 * Patch envelope parser (Plan 19 Phase 1) — the add/update/delete/move grammar
 * plus fail-closed rejection of any malformed envelope (so the caller can void
 * the WHOLE patch rather than apply a partial).
 */
import { describe, it, expect } from 'vitest';
import { parsePatchEnvelope } from '../../src/services/mystiPatch';

describe('parsePatchEnvelope', () => {
  it('parses add / update / delete / move ops', () => {
    const text = [
      '*** Add: src/new.ts',
      'export const x = 1;',
      'export const y = 2;',
      '*** Update: src/a.ts',
      '<<<<<<< SEARCH',
      'const old = 1;',
      '=======',
      'const neu = 2;',
      '>>>>>>> REPLACE',
      '*** Delete: src/gone.ts',
      '*** Move: src/from.ts >>> src/to.ts',
      '*** End',
    ].join('\n');
    const r = parsePatchEnvelope(text);
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    expect(r.ops).toEqual([
      { op: 'add', path: 'src/new.ts', content: 'export const x = 1;\nexport const y = 2;' },
      { op: 'update', path: 'src/a.ts', search: 'const old = 1;', replace: 'const neu = 2;' },
      { op: 'delete', path: 'src/gone.ts' },
      { op: 'move', path: 'src/from.ts', dest: 'src/to.ts' },
    ]);
  });

  it('works without a trailing *** End', () => {
    const r = parsePatchEnvelope('*** Delete: a.ts');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.ops).toEqual([{ op: 'delete', path: 'a.ts' }]); }
  });

  it('rejects text before the first header', () => {
    const r = parsePatchEnvelope('hello\n*** Delete: a.ts');
    expect(r.ok).toBe(false);
  });

  it('rejects an Update whose SEARCH block is not closed', () => {
    const r = parsePatchEnvelope('*** Update: a.ts\n<<<<<<< SEARCH\nfoo\n*** End');
    expect(r.ok).toBe(false);
  });

  it('rejects an Update missing the REPLACE marker', () => {
    const r = parsePatchEnvelope('*** Update: a.ts\n<<<<<<< SEARCH\nfoo\n=======\nbar');
    expect(r.ok).toBe(false);
  });

  it('rejects a Move without src >>> dest', () => {
    expect(parsePatchEnvelope('*** Move: onlyone.ts').ok).toBe(false);
  });

  it('rejects an empty patch', () => {
    expect(parsePatchEnvelope('   \n  ').ok).toBe(false);
  });
});
