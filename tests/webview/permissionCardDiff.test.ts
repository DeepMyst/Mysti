/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * P0#2 — you approve edits you cannot see.
 *
 * `parseFileEditInfo` has always built a full `diffLines` array from the tool
 * INPUT alone, and `renderEditReportCard` has always rendered it with line
 * numbers, +/- prefixes and syntax highlighting — but only AFTER the write
 * happened. The permission card, which receives the same input fields, showed
 * a file path and a truncated JSON blob. The user approved a change nobody had
 * shown them.
 *
 * These tests execute the REAL functions extracted from media/chat/chat.js, so
 * they cannot drift from the shipped artifact, and they pin the three things
 * that must not regress: the diff appears, it is bounded, and every value on
 * the card is escaped.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CHAT_JS = path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js');

/** Extract a top-level `function name(...) { ... }` declaration by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) { return source.slice(start, i + 1); }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

interface PermissionRequestLike {
  id: string;
  title: string;
  description: string;
  details: Record<string, unknown>;
}

interface Rig {
  renderPermissionDetails(request: PermissionRequestLike): string;
  permissionEditInfo(request: PermissionRequestLike): { diffLines: unknown[]; filePath: string } | null;
  parseFileEditInfo(tool: string, input: Record<string, unknown>, output: string): {
    diffLines: Array<{ type: string; content: string }>;
    linesAdded: number;
    linesRemoved: number;
    filePath: string;
  };
  renderEditReportCard(info: unknown, thinking: string): string;
  previewCap: number;
}

let chatJs: string;
let rig: Rig;

beforeAll(() => {
  chatJs = fs.readFileSync(CHAT_JS, 'utf8');

  const names = [
    'escapeHtml', 'makeRelativePath', 'splitLines', 'computeLineDiff',
    'getLanguageFromPath', 'highlightCode', 'parseFileEditInfo',
    'renderDiffRowsHtml', 'renderEditReportCard',
    'permissionEditInput', 'permissionEditInfo', 'renderPermissionDiffHtml',
    'renderPermissionDetails',
  ];
  const capMatch = /var EDIT_DIFF_PREVIEW_LINES = (\d+);/.exec(chatJs);
  expect(capMatch, 'EDIT_DIFF_PREVIEW_LINES must be a shared constant').toBeTruthy();

  const src = names.map(n => extractFunction(chatJs, n)).join('\n\n');
  // `state` is only read by makeRelativePath; Prism is deliberately absent so
  // highlightCode takes its escapeHtml() fallback path.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const built = new Function('state', `
    var EDIT_DIFF_PREVIEW_LINES = ${capMatch![1]};
    ${src}
    return {
      renderPermissionDetails: renderPermissionDetails,
      permissionEditInfo: permissionEditInfo,
      parseFileEditInfo: parseFileEditInfo,
      renderEditReportCard: renderEditReportCard,
      previewCap: EDIT_DIFF_PREVIEW_LINES
    };
  `)({ workspacePath: '/repo' }) as Rig;
  rig = built;
});

/** The shape the CLI tool_use gate actually posts today. */
function gateRequest(toolName: string, input: Record<string, unknown>): PermissionRequestLike {
  return {
    id: 'perm_00000000-0000-4000-8000-000000000000',
    title: toolName,
    description: `Mysti wants to: ${toolName}`,
    details: {
      command: JSON.stringify(input, null, 2).slice(0, 500),
      riskLevel: 'medium',
      suspended: true,
    },
  };
}

describe('P0#2: the permission card shows the diff being approved', () => {
  it('a Write shows every added line, not just a path', () => {
    const html = rig.renderPermissionDetails(gateRequest('Write', {
      file_path: '/repo/src/hello.ts',
      content: 'const a = 1;\nconst b = 2;\n',
    }));

    expect(html).toContain('permission-diff');
    expect(html).toContain('src/hello.ts');
    expect(html).toContain('const a = 1;');
    expect(html).toContain('const b = 2;');
    // The diff rows reuse the edit-report line markup so they inherit its styling.
    expect(html).toContain('edit-report-diff-line addition');
    // Stats are derived when the extension does not send them.
    expect(html).toContain('+3 lines');
  });

  it('an Edit shows the removed AND added lines', () => {
    const html = rig.renderPermissionDetails(gateRequest('Edit', {
      file_path: '/repo/src/app.ts',
      old_string: 'const timeout = 30;',
      new_string: 'const timeout = 300;',
    }));

    expect(html).toContain('edit-report-diff-line deletion');
    expect(html).toContain('edit-report-diff-line addition');
    expect(html).toContain('const timeout = 30;');
    expect(html).toContain('const timeout = 300;');
    expect(html).toContain('+1 lines');
    expect(html).toContain('-1 lines');
  });

  it('a MultiEdit shows every hunk (it used to show nothing at all)', () => {
    const info = rig.parseFileEditInfo('MultiEdit', {
      file_path: '/repo/src/app.ts',
      edits: [
        { old_string: 'let x = 1;', new_string: 'let x = 2;' },
        { old_string: 'let y = 3;', new_string: 'let y = 4;' },
      ],
    }, '');
    expect(info.linesAdded).toBe(2);
    expect(info.linesRemoved).toBe(2);

    const html = rig.renderPermissionDetails(gateRequest('MultiEdit', {
      file_path: '/repo/src/app.ts',
      edits: [
        { old_string: 'let x = 1;', new_string: 'let x = 2;' },
        { old_string: 'let y = 3;', new_string: 'let y = 4;' },
      ],
    }));
    expect(html).toContain('let x = 2;');
    expect(html).toContain('let y = 4;');
  });

  it('a huge diff cannot blow up the card — it respects the shared preview cap', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    // Via `toolInput`, because the gate's own 500-char `command` truncation
    // would otherwise refuse the diff before the cap is ever exercised.
    const req = gateRequest('Write', { file_path: '/repo/big.txt', content: '' });
    req.details.toolInput = { file_path: '/repo/big.txt', content: big };
    const html = rig.renderPermissionDetails(req);

    // `edit-report-diff-line ` with the trailing space — `-linenum` shares the prefix.
    const rows = html.split('class="edit-report-diff-line ').length - 1;
    expect(rows).toBe(rig.previewCap);
    expect(html).toContain('more lines not shown');
    // No expander on an approval prompt: the card stays a fixed size.
    expect(html).not.toContain('edit-report-show-more');
    // And it must not reuse the wrapper that is `max-height: 0` outside an
    // expanded edit-report card, or the diff would render invisible.
    expect(html).not.toContain('class="edit-report-diff"');
  });

  it('non-file tools are untouched — the old text card still renders', () => {
    const html = rig.renderPermissionDetails(gateRequest('Bash', { command: 'rm -rf /tmp/x' }));
    expect(html).not.toContain('permission-diff');
    expect(html).toContain('Command:');
    expect(html).toContain('rm -rf /tmp/x');
  });

  it('a truncated input yields NO diff rather than a half-diff', () => {
    // The gate slices the input JSON at 500 chars; a half-diff on an approval
    // prompt would be worse than none.
    const req = gateRequest('Write', {
      file_path: '/repo/src/hello.ts',
      content: 'x'.repeat(2000),
    });
    expect((req.details.command as string).length).toBe(500);
    expect(rig.permissionEditInfo(req)).toBeNull();
    const html = rig.renderPermissionDetails(req);
    expect(html).not.toContain('permission-diff');
    expect(html).toContain('Command:');
  });

  it('prefers a structured details.toolInput when the extension supplies one', () => {
    // The handoff: with the untruncated input on the wire, large edits get a
    // diff too. The webview already accepts it.
    const req = gateRequest('Write', { file_path: '/repo/a.ts', content: 'x'.repeat(2000) });
    req.details.toolInput = { file_path: '/repo/a.ts', content: 'const ok = true;' };
    req.details.toolName = 'Write';
    const html = rig.renderPermissionDetails(req);
    expect(html).toContain('const ok = true;');
  });
});

describe('P0#2 security: nothing on the permission card can be spoofed', () => {
  it('escapes model-supplied file paths (this row was raw HTML)', () => {
    // Exercised through `details.filePath`, the field the File row has always
    // read: it was interpolated with makeRelativePath() and NO escapeHtml(),
    // on the one card in this webview that must not be spoofable.
    const req = gateRequest('Write', { file_path: '/repo/x.ts', content: 'ok' });
    req.details.filePath = '/repo/<img src=x onerror=alert(1)>.ts';
    const html = rig.renderPermissionDetails(req);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes a path that arrives only via the tool input', () => {
    const html = rig.renderPermissionDetails(gateRequest('Write', {
      file_path: '/repo/<img src=y onerror=alert(1)>.ts',
      content: 'ok',
    }));
    expect(html).not.toContain('<img src=y');
    expect(html).toContain('&lt;img src=y');
  });

  it('escapes model-supplied file CONTENT in the diff rows', () => {
    const html = rig.renderPermissionDetails(gateRequest('Write', {
      file_path: '/repo/x.ts',
      content: '</span><button class="permission-option" data-action="approve">Yes</button>',
    }));
    // A crafted line must not be able to forge an approve button.
    expect(html).not.toContain('<button class="permission-option"');
    expect(html).toContain('&lt;/span&gt;');
  });

  it('a file path cannot walk Object.prototype out of the language table', () => {
    // `langMap[ext]` with ext = "constructor" returned a FUNCTION, which
    // renderEditReportCard interpolated raw into data-language="..." — an
    // attribute breakout driven entirely by a model-supplied file_path.
    const info = rig.parseFileEditInfo('Write', {
      file_path: '/repo/pwn.constructor',
      content: Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n'),
    }, '');
    const html = rig.renderEditReportCard(info, '');
    expect(html).toContain('data-language="javascript"');
    expect(html).not.toContain('native code');
    expect(html).not.toMatch(/data-language="function/i);
  });

  it('escapes a hostile diff line type before it reaches a class attribute', () => {
    const rows = /function renderDiffRowsHtml[\s\S]*?\n {6}\}/.exec(chatJs)![0];
    expect(rows).toContain('escapeHtml(line.type)');
    expect(rows).toContain('escapeHtml(lineNum)');
  });
});

describe('P0#2: the card keyboard model is intact', () => {
  it('the diff is visible on arrival, not hidden behind "Show details"', () => {
    const card = extractFunction(chatJs, 'renderPermissionCard');
    // H-1: parsed once, then handed to renderPermissionDetails (see permissionCardToolInput.test.ts).
    expect(card).toContain('var editInfo = permissionEditInfo(request);');
    expect(card).toContain('var hasDiff = !!editInfo;');
    expect(card).toContain("(hasDiff ? 'Hide details' : 'Show details')");
    expect(card).toContain("'<div class=\"permission-details' + (hasDiff ? ' expanded' : '') +");
  });

  it('numbered options, focusability and the custom-input escape hatch survive', () => {
    const card = extractFunction(chatJs, 'renderPermissionCard');
    expect(card).toContain('card.tabIndex = 0;');
    expect(card).toContain('<span class="option-number">1</span>');
    expect(card).toContain('<span class="option-number">2</span>');
    expect(card).toContain('<span class="option-number">3</span>');
    // Card-level shortcuts must stay suppressed while typing an instruction.
    expect(card).toContain('e.stopPropagation();');

    const handler = extractFunction(chatJs, 'handlePermissionKeyboard');
    expect(handler).toContain(".closest('.permission-custom-input')");
    for (const key of ["case '1':", "case '2':", "case '3':", "case 'Enter':", "case 'Escape':"]) {
      expect(handler).toContain(key);
    }

    const onRequest = extractFunction(chatJs, 'handlePermissionRequest');
    expect(onRequest).toContain('card.focus()');
  });
});

describe('P0#2: there is still exactly one differ', () => {
  it('the report card and the permission card share the row renderer', () => {
    const report = extractFunction(chatJs, 'renderEditReportCard');
    const permission = extractFunction(chatJs, 'renderPermissionDiffHtml');
    expect(report).toContain('renderDiffRowsHtml(');
    expect(permission).toContain('renderDiffRowsHtml(');
    // Only the shared helper may emit a diff row.
    expect(chatJs.match(/edit-report-diff-line ' \+/g) || []).toHaveLength(1);
  });

  it('the shared cap is assigned at IIFE top level, before any card can render', () => {
    // D-2 was a scope bug; this is the same class of trap. `var` hoists the
    // BINDING but not the value, so the constant must be assigned while the
    // IIFE body runs (six-space indent = IIFE top level) and not inside a
    // later block. Every card render is driven by a postMessage, which cannot
    // run until the IIFE has returned.
    const decls = chatJs.split('\n').filter(l => /EDIT_DIFF_PREVIEW_LINES\s*=/.test(l));
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatch(/^ {6}var EDIT_DIFF_PREVIEW_LINES = \d+;$/);
  });

  it('the report card still renders the same diff it always did', () => {
    const info = rig.parseFileEditInfo('Write', {
      file_path: '/repo/src/x.ts',
      content: 'alpha\nbeta',
    }, '');
    const html = rig.renderEditReportCard(info, '');
    expect(html).toContain('edit-report-card');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    expect(html).toContain('Added 2 lines');
  });
});
