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
 * SPDX-License-Identifier: Apache-2.0
 *
 * P0#2 / H-1 — "you approve edits you cannot see", the webview half.
 *
 * Round 1 wired the diff renderer onto the permission card, but the card's
 * only wire source was `details.command = JSON.stringify(input).slice(0, 500)`
 * and the renderer needs a SUCCESSFUL `JSON.parse`. A realistic 3-line Edit
 * serialises to ~570 chars, so most real edits still approved blind. The
 * extension now sends a structurally intact `details.toolInput` (see
 * tests/integration/chatViewTrustAndGate.test.ts for the producer half); this
 * file pins the consumer:
 *
 *  1. `toolInput` is preferred, `command` remains the fallback.
 *  2. `parseFileEditInfo` runs ONCE per card (it ran twice).
 *  3. Diff-row generation is capped at the preview limit (a 50k-line Write
 *     built 50,000 row objects, twice, synchronously on the render path) while
 *     the line counts stay exact and the footer states the omitted total.
 *  4. Every value interpolated into the card is escaped.
 *  5. The keyboard model is intact.
 *
 * These tests execute the REAL functions extracted from media/chat/chat.js.
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

interface RequestLike {
  id: string;
  title: string;
  description: string;
  expiresAt: number;
  semiAutonomous?: boolean;
  forceInteractive?: boolean;
  remoteOrigin?: boolean;
  details: Record<string, unknown>;
}

interface EditInfo {
  diffLines: Array<{ type: string; content: string; lineNum: number }>;
  diffLinesOmitted: number;
  linesAdded: number;
  linesRemoved: number;
  filePath: string;
}

interface FakeCard {
  className: string;
  dataset: Record<string, string>;
  tabIndex: number;
  innerHTML: string;
}

interface Rig {
  renderPermissionCard(request: RequestLike): FakeCard;
  renderPermissionDetails(request: RequestLike, precomputed?: unknown): string;
  permissionEditInfo(request: RequestLike): EditInfo | null;
  permissionEditInput(request: RequestLike): { toolName: string; input: Record<string, unknown> } | null;
  parseFileEditInfo(tool: string, input: Record<string, unknown>, output: string, cap?: number): EditInfo;
  renderEditReportCard(info: unknown, thinking: string): string;
  parseCalls(): number;
  resetParseCalls(): void;
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
    'renderPermissionDetails', 'buildPermissionQuestion', 'formatTimeRemaining',
    // Plan 27 §25 — the card's always-allow label is computed, because it now
    // has to state the exact grant (per action type, per binary for bash).
    'alwaysAllowLabel',
    // Plan 28 Phase 7 — the card now also states what saying yes DOES, and
    // which way the clock falls.
    'cssAttr', 'permissionEffects', 'permissionTimerText',
    'renderPermissionCard',
  ];
  const capMatch = /var EDIT_DIFF_PREVIEW_LINES = (\d+);/.exec(chatJs);
  expect(capMatch).toBeTruthy();
  const src = names.map(n => extractFunction(chatJs, n)).join('\n\n');

  // A DOM just large enough for renderPermissionCard: the card's listeners are
  // attached via querySelectorAll/querySelector, which return nothing here, so
  // handlePermissionAction / postMessageWithPanelId are never reached.
  const fakeDocument = {
    createElement: () => ({ className: '', dataset: {}, tabIndex: -1, innerHTML: '',
      querySelectorAll: () => [], querySelector: () => null }),
    // `permissionTimerText` reads the timeout-behaviour select. Absent here, so
    // it falls back to the safe default — which is exactly what it must do.
    getElementById: () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  // alwaysAllowLabel reads this map; extractFunction only pulls functions.
  const nounsMatch = /var ALWAYS_ALLOW_NOUNS = \{[\s\S]*?\};/.exec(chatJs);
  expect(nounsMatch, 'ALWAYS_ALLOW_NOUNS not found in chat.js').toBeTruthy();
  rig = new Function('state', 'document', `
    var EDIT_DIFF_PREVIEW_LINES = ${capMatch![1]};
    ${nounsMatch![0]}
    ${src}
    // Count the differ's entries. A function declaration is a mutable binding,
    // so the wrapped name is what every extracted caller resolves.
    var __calls = 0;
    var __realParse = parseFileEditInfo;
    parseFileEditInfo = function() { __calls++; return __realParse.apply(this, arguments); };
    return {
      renderPermissionCard: renderPermissionCard,
      renderPermissionDetails: renderPermissionDetails,
      permissionEditInfo: permissionEditInfo,
      permissionEditInput: permissionEditInput,
      parseFileEditInfo: function() { return __realParse.apply(this, arguments); },
      renderEditReportCard: renderEditReportCard,
      parseCalls: function() { return __calls; },
      resetParseCalls: function() { __calls = 0; },
      previewCap: EDIT_DIFF_PREVIEW_LINES
    };
  `)({ workspacePath: '/repo' }, fakeDocument) as Rig;
});

/** Exactly the shape the extension gate posts: 500-char preview PLUS the intact input. */
function wire(toolName: string, input: Record<string, unknown>, opts: { toolInput?: boolean } = {}): RequestLike {
  const details: Record<string, unknown> = {
    command: JSON.stringify(input, null, 2).slice(0, 500),
    riskLevel: 'medium',
    suspended: true,
  };
  if (opts.toolInput !== false) {
    details.toolName = toolName;
    details.toolInput = JSON.parse(JSON.stringify(input));
  }
  return { id: 'perm_00000000-0000-4000-8000-000000000000', title: toolName,
    description: `Mysti wants to: ${toolName}`, expiresAt: 0, details };
}

/** The gate's own measured case: a realistic 3-line Edit that serialises past 500 chars. */
const REALISTIC_EDIT = {
  file_path: '/repo/src/providers/ChatViewProvider.ts',
  old_string: '    const preview = JSON.stringify(toolCall.input || {}, null, 2).slice(0, 500);\n' +
    '    const riskLevel = PermissionManager.classifyRisk(action);\n' +
    '    return this.requestPermissionInline(',
  new_string: '    const preview = JSON.stringify(toolCall.input || {}, null, 2).slice(0, 500);\n' +
    '    const riskLevel = PermissionManager.classifyRisk(action);\n' +
    '    const toolInput = this._permissionToolInput(toolCall.input);\n' +
    '    return this.requestPermissionInline(',
};

describe('H-1 (1): the realistic 3-line Edit — the case that approved blind', () => {
  it('serialises past 500 chars, so the sliced `command` cannot parse', () => {
    const serialised = JSON.stringify(REALISTIC_EDIT, null, 2);
    expect(serialised.length).toBeGreaterThan(500);
    expect(() => JSON.parse(serialised.slice(0, 500))).toThrow();
  });

  it('BEFORE (command only): no diff — the user approved this edit blind', () => {
    const req = wire('Edit', REALISTIC_EDIT, { toolInput: false });
    expect(rig.permissionEditInfo(req)).toBeNull();
    const html = rig.renderPermissionDetails(req);
    expect(html).not.toContain('permission-diff');
  });

  it('AFTER (toolInput on the wire): the headline names the file', () => {
    // The gate sets no `details.filePath`, so the headline read "Allow file
    // write?" even once the diff was on the card.
    const card = rig.renderPermissionCard(wire('Edit', REALISTIC_EDIT));
    expect(card.innerHTML).toContain('Allow write to src/providers/ChatViewProvider.ts?');
    const before = rig.renderPermissionCard(wire('Edit', REALISTIC_EDIT, { toolInput: false }));
    expect(before.innerHTML).toContain('Allow file write?');
  });

  it('AFTER (toolInput on the wire): the added line is on the card', () => {
    const req = wire('Edit', REALISTIC_EDIT);
    const info = rig.permissionEditInfo(req)!;
    expect(info).not.toBeNull();
    expect(info.linesAdded).toBe(1);
    expect(info.linesRemoved).toBe(0);
    const html = rig.renderPermissionDetails(req);
    expect(html).toContain('permission-diff');
    expect(html).toContain('edit-report-diff-line addition');
    expect(html).toContain('this._permissionToolInput(toolCall.input);');
    expect(html).toContain('src/providers/ChatViewProvider.ts');
    // The raw JSON blob is dropped once a diff is shown.
    expect(html).not.toContain('Command:');
  });

  it('prefers toolInput over a command blob that disagrees with it', () => {
    const req = wire('Write', { file_path: '/repo/a.ts', content: 'from command' });
    req.details.toolInput = { file_path: '/repo/a.ts', content: 'from toolInput' };
    const html = rig.renderPermissionDetails(req);
    expect(html).toContain('from toolInput');
    expect(html).not.toContain('from command');
  });

  it('falls back to parsing `command` when toolInput is absent (older producers)', () => {
    const req = wire('Write', { file_path: '/repo/a.ts', content: 'small enough' }, { toolInput: false });
    expect(rig.permissionEditInput(req)).toEqual({ toolName: 'Write', input: { file_path: '/repo/a.ts', content: 'small enough' } });
    expect(rig.renderPermissionDetails(req)).toContain('small enough');
  });

  it('ignores a non-object toolInput (array / string) and falls back', () => {
    const req = wire('Write', { file_path: '/repo/a.ts', content: 'ok' }, { toolInput: false });
    req.details.toolInput = ['not', 'an', 'object'];
    expect(rig.permissionEditInput(req)!.input).toEqual({ file_path: '/repo/a.ts', content: 'ok' });
    req.details.toolInput = 'nope';
    expect(rig.permissionEditInput(req)!.input).toEqual({ file_path: '/repo/a.ts', content: 'ok' });
  });
});

describe('H-1 (2): the differ runs once per card', () => {
  it('renderPermissionCard parses once and hands the result to renderPermissionDetails', () => {
    rig.resetParseCalls();
    const card = rig.renderPermissionCard(wire('Edit', REALISTIC_EDIT));
    expect(rig.parseCalls()).toBe(1);
    // And the single parse produced a visible, expanded diff.
    expect(card.innerHTML).toContain('permission-diff');
    expect(card.innerHTML).toContain('class="permission-details expanded"');
    expect(card.innerHTML).toContain('Hide details');
  });

  it('a non-diff card also parses at most once', () => {
    rig.resetParseCalls();
    const card = rig.renderPermissionCard(wire('Bash', { command: 'ls -la' }));
    expect(rig.parseCalls()).toBe(1);
    expect(card.innerHTML).not.toContain('permission-diff');
    expect(card.innerHTML).toContain('ls -la');
    expect(card.innerHTML).toContain('Show details');
  });

  it('is pinned in the source, not only in behaviour', () => {
    const card = extractFunction(chatJs, 'renderPermissionCard');
    expect(card.match(/permissionEditInfo\(request\)/g)).toHaveLength(1);
    expect(card).toContain('buildPermissionQuestion(request, editInfo)');
    expect(card).toContain('renderPermissionDetails(request, editInfo)');
    const details = extractFunction(chatJs, 'renderPermissionDetails');
    expect(details).toContain('precomputedEditInfo === undefined ? permissionEditInfo(request) : precomputedEditInfo');
  });
});

describe('H-1 (3): diff-row generation is capped at the preview, counts stay exact', () => {
  const bigContent = Array.from({ length: 50000 }, (_, i) => `line ${i}`).join('\n');

  it('a 50k-line Write builds only the preview rows, and the footer states the rest', () => {
    const req = wire('Write', { file_path: '/repo/big.txt', content: bigContent });
    const info = rig.permissionEditInfo(req)!;
    expect(info.diffLines).toHaveLength(rig.previewCap);
    expect(info.diffLinesOmitted).toBe(50000 - rig.previewCap);
    expect(info.linesAdded).toBe(50000);
    const html = rig.renderPermissionDetails(req, info);
    expect(html).toContain(`${50000 - rig.previewCap} more lines not shown`);
    expect(html).toContain('+50000 lines');
    expect((html.match(/class="edit-report-diff-line /g) || []).length).toBe(rig.previewCap);
  });

  it('a large Edit keeps exact add/remove counts under the cap', () => {
    const oldStr = Array.from({ length: 300 }, (_, i) => `old ${i}`).join('\n');
    const newStr = Array.from({ length: 500 }, (_, i) => `new ${i}`).join('\n');
    const info = rig.permissionEditInfo(wire('Edit', { file_path: '/repo/e.ts', old_string: oldStr, new_string: newStr }))!;
    expect(info.diffLines).toHaveLength(rig.previewCap);
    expect(info.linesRemoved).toBe(300);
    expect(info.linesAdded).toBe(500);
    expect(info.diffLinesOmitted).toBe(800 - rig.previewCap);
  });

  it('a MultiEdit shares the cap across hunks and still counts every hunk', () => {
    const edits = Array.from({ length: 3 }, (_, e) => ({
      old_string: Array.from({ length: 10 }, (_, i) => `o${e}.${i}`).join('\n'),
      new_string: Array.from({ length: 15 }, (_, i) => `n${e}.${i}`).join('\n'),
    }));
    const info = rig.permissionEditInfo(wire('MultiEdit', { file_path: '/repo/m.ts', edits }))!;
    expect(info.diffLines).toHaveLength(rig.previewCap);
    expect(info.linesRemoved).toBe(30);
    expect(info.linesAdded).toBe(45);
    expect(info.diffLinesOmitted).toBe(75 - rig.previewCap);
  });

  it('a Notebook edit is capped the same way', () => {
    const info = rig.permissionEditInfo(wire('NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: bigContent }))!;
    expect(info.diffLines).toHaveLength(rig.previewCap);
    expect(info.linesAdded).toBe(50000);
  });

  it('the post-hoc report card is UNCAPPED — its expander still carries the full diff', () => {
    const content = Array.from({ length: 200 }, (_, i) => `r${i}`).join('\n');
    const info = rig.parseFileEditInfo('Write', { file_path: '/repo/r.ts', content }, '');
    expect(info.diffLines).toHaveLength(200);
    expect(info.diffLinesOmitted).toBe(0);
    const infoEdit = rig.parseFileEditInfo('Edit', { file_path: '/repo/r.ts', old_string: 'a\nb\nc', new_string: 'a\nx\nc' }, '');
    expect(infoEdit.linesAdded).toBe(1);
    expect(infoEdit.linesRemoved).toBe(1);
    expect(infoEdit.diffLines.map(l => l.type)).toEqual(['context', 'deletion', 'addition', 'context']);
    const html = rig.renderEditReportCard(info, '');
    expect(html).toContain('edit-report-show-more');
    expect(html).toContain(`... ${200 - rig.previewCap} more lines`);
    expect(html).toContain('Added 200 lines');
  });

  it('the cap is applied inside the parser, before any row array is built', () => {
    const parse = extractFunction(chatJs, 'parseFileEditInfo');
    expect(parse).toMatch(/function parseFileEditInfo\(toolName, input, output, maxDiffLines\)/);
    // Write / NotebookEdit slice BEFORE mapping to row objects.
    expect(parse).toContain('lines.slice(0, maxDiffLines)');
    // Edit / MultiEdit hand the cap to the shared differ.
    expect(parse).toContain('computeLineDiff(oldLines, newLines, maxDiffLines, editStats)');
    expect(parse).toContain('computeLineDiff(edOld, edNew, remaining, multiStats)');
    // No full-array filter is left on the counting path.
    expect(parse).not.toContain(".filter(function(l) { return l.type === 'addition'; })");
    const info = extractFunction(chatJs, 'permissionEditInfo');
    expect(info).toContain("parseFileEditInfo(parsed.toolName, parsed.input, '', EDIT_DIFF_PREVIEW_LINES)");
    // Still exactly one differ.
    expect((chatJs.match(/function computeLineDiff\(/g) || []).length).toBe(1);
  });
});

describe('H-1 (4): every value on the card is escaped', () => {
  it('a hostile file_path arriving via toolInput cannot inject markup', () => {
    const html = rig.renderPermissionDetails(wire('Write', {
      file_path: '/repo/<img src=x onerror=alert(1)>.ts', content: 'ok',
    }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    // The question title too (renderPermissionCard escapes the whole line).
    const card = rig.renderPermissionCard(wire('Write', { file_path: '/repo/<b>x</b>.ts', content: 'ok' }));
    expect(card.innerHTML).toContain('Allow write to &lt;b&gt;x&lt;/b&gt;.ts?');
    expect(card.innerHTML).not.toContain('<b>x</b>');
  });

  it('a hostile content line via toolInput cannot forge an approve button', () => {
    const html = rig.renderPermissionDetails(wire('Write', {
      file_path: '/repo/x.ts',
      content: '</div><button class="permission-option" data-action="approve">Yes</button>',
    }));
    expect(html).not.toContain('<button class="permission-option"');
    expect(html).toContain('&lt;/div&gt;&lt;button');
  });

  it('the producer\'s truncation marker renders as escaped text, not markup', () => {
    const html = rig.renderPermissionDetails(wire('Write', {
      file_path: '/repo/x.ts',
      content: 'kept…[truncated 1234 chars]<script>alert(1)</script>',
    }));
    expect(html).toContain('kept…[truncated 1234 chars]&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('a hostile toolName cannot break out of the question line', () => {
    const req = wire('Write', { file_path: '/repo/x.ts', content: 'ok' });
    req.details.toolName = 'Write<svg onload=alert(1)>';
    req.title = req.details.toolName as string;
    const card = rig.renderPermissionCard(req);
    expect(card.innerHTML).not.toContain('<svg');
  });

  it('the request id and timer values reach attributes only through escapeHtml', () => {
    const card = extractFunction(chatJs, 'renderPermissionCard');
    expect(card).toContain('var cardId = escapeHtml(request.id);');
    expect(card).toContain('data-target="details-\' + cardId');
    expect(card).toContain('id="details-\' + cardId');
    expect(card).toContain('data-request-id="\' + cardId');
    expect(card).toContain("data-expires=\"' + escapeHtml(request.expiresAt)");
    expect(card).toContain("escapeHtml(timerText)");
    // No raw interpolation of the id survives.
    expect(card).not.toMatch(/' \+ request\.id \+ '/);
    const req = wire('Write', { file_path: '/repo/x.ts', content: 'ok' });
    req.id = 'perm_"><img src=x>';
    const rendered = rig.renderPermissionCard(req);
    expect(rendered.innerHTML).not.toContain('<img src=x>');
    expect(rendered.innerHTML).toContain('details-perm_&quot;&gt;&lt;img src=x&gt;');
  });

  it('the omitted-line count is coerced to a number before interpolation', () => {
    const info = rig.permissionEditInfo(wire('Write', { file_path: '/repo/x.ts', content: 'a\nb' }))!;
    (info as unknown as { diffLinesOmitted: unknown }).diffLinesOmitted = '<b>9</b>';
    const html = rig.renderPermissionDetails(wire('Write', { file_path: '/repo/x.ts', content: 'a\nb' }), info);
    expect(html).not.toContain('<b>9</b>');
    expect(html).not.toContain('more line');
  });
});

describe('H-1 (5): the card keyboard model is intact', () => {
  it.each(['forceInteractive', 'remoteOrigin'] as const)('omits a session grant when %s requires an individual decision', flag => {
    const request = { ...wire('Edit', REALISTIC_EDIT), [flag]: true };
    const html = rig.renderPermissionCard(request).innerHTML;
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
    expect(html).not.toContain('data-action="always-allow"');
  });

  it('numbered options match their labels, in order', () => {
    const card = rig.renderPermissionCard(wire('Edit', REALISTIC_EDIT));
    const html = card.innerHTML;
    const one = html.indexOf('<span class="option-number">1</span>');
    const two = html.indexOf('<span class="option-number">2</span>');
    const three = html.indexOf('<span class="option-number">3</span>');
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    expect(html.slice(one, two)).toContain('<span>Yes</span>');
    // Plan 27 §25: option 2's text is now computed and names the exact grant,
    // so this asserts the SHAPE (a scoped "don't ask again"), not a fixed
    // string. tests/managers/permissionGrantScoping.test.ts pins the semantics
    // the label describes.
    expect(html.slice(two, three)).toMatch(/Yes, and don\u2019t ask again for .+ this session/);
    expect(html.slice(three)).toContain('<span>No</span>');
    expect(html.slice(one - 80, one)).toContain('data-action="approve"');
    expect(html.slice(two - 80, two)).toContain('data-action="always-allow"');
    expect(html.slice(three - 80, three)).toContain('data-action="deny"');
  });

  it('footer shortcuts, focusability and the custom-instruction input survive', () => {
    const card = rig.renderPermissionCard(wire('Edit', REALISTIC_EDIT));
    expect(card.tabIndex).toBe(0);
    expect(card.dataset.id).toBe('perm_00000000-0000-4000-8000-000000000000');
    expect(card.className).toContain('permission-card pending');
    expect(card.innerHTML).toContain('<div class="permission-footer">');
    expect(card.innerHTML).toContain('Esc to cancel');
    expect(card.innerHTML).toContain('Paused');
    expect(card.innerHTML).toContain('placeholder="Tell Mysti what to do instead..."');
  });

  it('render focuses the card and shortcuts are suppressed while typing', () => {
    const onRequest = extractFunction(chatJs, 'handlePermissionRequest');
    expect(onRequest).toContain('card.focus()');
    expect(onRequest).toContain('state.focusedPermissionId = request.id;');
    const card = extractFunction(chatJs, 'renderPermissionCard');
    expect(card).toContain("customInput.addEventListener('keydown', function(e) {\n            e.stopPropagation();");
    const handler = extractFunction(chatJs, 'handlePermissionKeyboard');
    expect(handler).toContain(".closest('.permission-custom-input')");
    for (const key of ["case '1':", "case '2':", "case '3':", "case 'Enter':", "case 'Escape':"]) {
      expect(handler).toContain(key);
    }
  });
});

describe('Plan 28 Phase 7 — the card states what yes does', () => {
  /** `wire` predates actionType; real cards always carry it (PermissionRequest). */
  function typed(req: RequestLike, actionType: string): RequestLike {
    (req as unknown as { actionType: string }).actionType = actionType;
    return req;
  }

  it('lists the effect of a write before the buttons', () => {
    const card = rig.renderPermissionCard(typed(
      wire('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }, { toolInput: true }), 'file-edit'));
    expect(card.innerHTML).toContain('permission-effects');
    expect(card.innerHTML).toContain('writes');
    expect(card.innerHTML).toContain('src/a.ts');
  });

  it('calls a command a command, and a delete a delete', () => {
    const bash = rig.renderPermissionCard(typed(wire('Bash', { command: 'rm -rf build' }), 'bash-command'));
    expect(bash.innerHTML).toContain('runs');
    expect(bash.innerHTML).toContain('a command on this machine');
  });

  it('says which way the clock falls, not just how long is left', () => {
    const req = typed(wire('Bash', { command: 'npm test' }), 'bash-command');
    req.expiresAt = Date.now() + 25000;
    // No timeout-behaviour control in this rig, so the safe default stands.
    expect(rig.renderPermissionCard(req).innerHTML).toContain('auto-denies in');
  });

  it('a forced card auto-DENIES whatever the timeout setting says', () => {
    const req = typed(wire('Bash', { command: 'curl https://example.com' }), 'bash-command');
    req.expiresAt = Date.now() + 25000;
    (req as unknown as { forceInteractive: boolean }).forceInteractive = true;
    expect(rig.renderPermissionCard(req).innerHTML).toContain('auto-denies in');
  });

  it('does not invent an effect for a plain read', () => {
    const read = rig.renderPermissionCard(typed(wire('Read', { file_path: '/repo/src/a.ts' }), 'file-read'));
    expect(read.innerHTML).not.toContain('permission-effects');
  });
});
