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
 * Plan 02 Phase 2 — CI guard for provider-id literals in the webview.
 *
 * Unit-tests scripts/check-provider-literals.js (the scanner wired into
 * `npm run lint`) and asserts the invariant on the REAL webview source:
 * zero provider-id literals outside allowlisted bootstrap blocks.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../scripts/check-provider-literals.js');

const { scanSource, PROVIDER_IDS, ALLOW_START, ALLOW_END, ALLOW_LINE } = guard;

describe('check-provider-literals scanner', () => {
  it('flags quoted provider-id literals outside allowlisted regions', () => {
    const src = [
      "var x = provider === 'openai-codex';",
      'var y = "claude-code";',
      'var z = `qwen-code`;'
    ].join('\n');
    const result = scanSource(src);
    expect(result.violations).toHaveLength(3);
    expect(result.violations[0]).toMatchObject({ line: 1, id: 'openai-codex' });
    expect(result.violations[1]).toMatchObject({ line: 2, id: 'claude-code' });
    expect(result.violations[2]).toMatchObject({ line: 3, id: 'qwen-code' });
  });

  it('only matches literals that are the ENTIRE quoted string', () => {
    const src = [
      'cursor: pointer;', // CSS — unquoted
      "var icon = 'icons/cursor.png';", // asset path — not exact
      "el.className = 'claude-thinking';", // class name — not a provider id
      "var cls = 'cursor-logo';"
    ].join('\n');
    expect(scanSource(src).violations).toHaveLength(0);
  });

  it('covers all 12 provider ids including dormant manus', () => {
    expect(PROVIDER_IDS).toHaveLength(12);
    for (const id of PROVIDER_IDS) {
      const result = scanSource(`var p = '${id}';`);
      expect(result.violations, id).toHaveLength(1);
    }
  });

  it('skips literals inside allow blocks and counts them', () => {
    const src = [
      `<!-- ${ALLOW_START} bootstrap markup -->`,
      '<div data-agent="claude-code"></div>',
      '<div data-agent="cursor"></div>',
      `<!-- ${ALLOW_END} -->`,
      "var bad = 'openclaw';"
    ].join('\n');
    const result = scanSource(src);
    expect(result.allowedCount).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].id).toBe('openclaw');
  });

  it('skips lines tagged with the allow-line marker', () => {
    const src = `provider: 'claude-code' // ${ALLOW_LINE} — bootstrap default`;
    const result = scanSource(src);
    expect(result.violations).toHaveLength(0);
    expect(result.allowedCount).toBe(1);
  });

  it('reports unclosed and unmatched markers', () => {
    const unclosed = scanSource(`// ${ALLOW_START}\nvar a = 1;`);
    expect(unclosed.markerErrors).toHaveLength(1);
    expect(unclosed.markerErrors[0]).toContain('never closed');

    const unmatched = scanSource(`// ${ALLOW_END}`);
    expect(unmatched.markerErrors).toHaveLength(1);

    const nested = scanSource([`// ${ALLOW_START}`, `// ${ALLOW_START}`, `// ${ALLOW_END}`].join('\n'));
    expect(nested.markerErrors).toHaveLength(1);
    expect(nested.markerErrors[0]).toContain('nested');
  });
});

describe('webviewContent.ts provider-literal invariant', () => {
  it('has zero provider-id literals outside allowlisted bootstrap blocks', () => {
    const file = path.join(__dirname, '..', '..', 'src', 'webview', 'webviewContent.ts');
    const source = fs.readFileSync(file, 'utf8');
    const result = scanSource(source);
    expect(result.markerErrors).toEqual([]);
    expect(
      result.violations.map((v: { line: number; text: string }) => `${v.line}: ${v.text}`)
    ).toEqual([]);
  });
});
