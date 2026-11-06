import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { buildReferences } = require('../../scripts/docs-reference.cjs');
const { headingIds, settingTableErrors } = require('../../scripts/check-docs.cjs');

function fixture(defaultValue: unknown) {
  return {
    version: '1.0.0',
    contributes: {
      configuration: { properties: {
        'mysti.visualTest.serverReadyPattern': { type: 'string', default: defaultValue, description: '%pattern%' },
      } },
      commands: [],
    },
  };
}

describe('documentation integrity', () => {
  it('keeps copied configuration values exact through GFM table rendering', () => {
    const pattern = '(ready|listening): `localhost`';
    const outputs: Map<string, string> = buildReferences(fixture(pattern), { pattern: 'Server readiness pattern.' }, { documents: [] });
    const dom = new JSDOM(marked.parse(outputs.get('docs/SETTINGS.md')!) as string);
    const defaultCell = dom.window.document.querySelector('tbody tr td:nth-child(2) code');
    expect(defaultCell?.textContent).toBe(JSON.stringify(pattern));
    dom.window.close();
  });

  it('fails on missing English labels instead of publishing localization placeholders', () => {
    expect(() => buildReferences(fixture('ready'), {}, { documents: [] })).toThrow('Missing English localization: pattern');
  });

  it('changes both human and machine references when a declared default changes', () => {
    const before: Map<string, string> = buildReferences(fixture('before'), { pattern: 'Pattern' }, { documents: [] });
    const after: Map<string, string> = buildReferences(fixture('after'), { pattern: 'Pattern' }, { documents: [] });
    expect(after.get('docs/SETTINGS.md')).not.toBe(before.get('docs/SETTINGS.md'));
    expect(JSON.parse(after.get('docs/reference/settings.json')!).settings['mysti.visualTest.serverReadyPattern'].default).toBe('after');
    expect(JSON.parse(after.get('docs/reference/settings.json')!).sourceSha256)
      .not.toBe(JSON.parse(before.get('docs/reference/settings.json')!).sourceSha256);
  });

  it('does not accept a heading that only appears inside an example code fence', () => {
    const tokens = marked.lexer('# Start\n\n```md\n## Fake destination\n```\n\n## Start\n\n## Start-1\n');
    expect([...headingIds(tokens, marked)]).toEqual(['start', 'start-1', 'start-1-1']);
    expect(headingIds(tokens, marked).has('fake-destination')).toBe(false);
  });

  it('rejects obsolete setting keys and wrong literal defaults in reference tables', () => {
    const tokens = marked.lexer('| Setting | Default |\n| --- | --- |\n| `mysti.oldModel` | `sonnet` |\n| `mysti.rounds` | `3` |\n');
    const errors = settingTableErrors(tokens, marked, { 'mysti.rounds': { default: 2 } });
    expect(errors).toContain('Undeclared setting mysti.oldModel');
    expect(errors.some((error: string) => error.includes('documented default 3 differs from manifest 2'))).toBe(true);
  });

  it('accepts correct string, array and numeric defaults without treating storage prose as settings', () => {
    const tokens = marked.lexer('| Setting | Default |\n| --- | --- |\n| `mysti.model` | `` |\n| `mysti.agents` | `["a", "b"]` |\n| `mysti.rounds` | `2` |\n\nStorage key: `mysti.conversations`.');
    expect(settingTableErrors(tokens, marked, {
      'mysti.model': { default: '' }, 'mysti.agents': { default: ['a', 'b'] }, 'mysti.rounds': { default: 2 },
    })).toEqual([]);
  });
});
