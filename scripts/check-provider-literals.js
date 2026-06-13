#!/usr/bin/env node
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
 * Provider-literal CI guard (Plan 02 Phase 2).
 *
 * The webview must render from the capability manifest
 * (state.providerManifest), never from provider-name literals. This guard
 * fails `npm run lint` when a quoted provider id appears in the chat webview
 * assets (media/chat/index.html, media/chat/chat.js) or the loader
 * (src/webview/webviewContent.ts) outside an explicitly allowlisted bootstrap
 * region. (The markup/script were extracted to media/chat/ in Plan 03 Phase
 * 3c Step 1; this guard scans the extracted assets.)
 *
 * Allowlist mechanisms (markers live in comments — JS or HTML):
 *   - Block:  mysti:provider-literals:allow-start
 *             ... bootstrap markup / defaults ...
 *             mysti:provider-literals:allow-end
 *   - Line:   mysti:provider-literals:allow-line   (same-line marker)
 *
 * Every marker should explain WHY the literal is legitimate (bootstrap
 * markup rendered before the manifest exists, defaults replaced by
 * initialState, ...). Render logic must never be allowlisted.
 *
 * Usage: node scripts/check-provider-literals.js
 */

const fs = require('fs');
const path = require('path');

/** All known provider ids (including the dormant 'manus'). */
const PROVIDER_IDS = [
  'claude-code',
  'openai-codex',
  'google-gemini',
  'cline',
  'github-copilot',
  'cursor',
  'openclaw',
  'opencode',
  'qwen-code',
  'ollama',
  'localai',
  'manus'
];

const ALLOW_START = 'mysti:provider-literals:allow-start';
const ALLOW_END = 'mysti:provider-literals:allow-end';
const ALLOW_LINE = 'mysti:provider-literals:allow-line';

const TARGET_FILES = [
  path.join(__dirname, '..', 'media', 'chat', 'index.html'),
  path.join(__dirname, '..', 'media', 'chat', 'chat.js'),
  path.join(__dirname, '..', 'src', 'webview', 'webviewContent.ts'),
];

// Match a provider id only when it is the ENTIRE quoted string
// ('cursor' / "cursor" / `cursor`) — so CSS `cursor: pointer`, asset paths
// like 'icons/cursor.png', and class names like 'claude-thinking' never trip
// the guard.
const LITERAL_RE = new RegExp("['\"`](" + PROVIDER_IDS.join('|') + ")['\"`]");

/**
 * Scan source text for provider-id literals outside allowlisted regions.
 * Returns { violations: [{line, text, id}], allowedCount, markerErrors }.
 */
function scanSource(source) {
  const lines = source.split('\n');
  const violations = [];
  const markerErrors = [];
  let allowedCount = 0;
  let inAllowBlock = false;
  let blockStartLine = -1;

  lines.forEach((text, idx) => {
    const lineNo = idx + 1;

    if (text.includes(ALLOW_START)) {
      if (inAllowBlock) {
        markerErrors.push(
          `line ${lineNo}: nested ${ALLOW_START} (previous block opened at line ${blockStartLine} was never closed)`
        );
      }
      inAllowBlock = true;
      blockStartLine = lineNo;
      return;
    }
    if (text.includes(ALLOW_END)) {
      if (!inAllowBlock) {
        markerErrors.push(`line ${lineNo}: ${ALLOW_END} without a matching ${ALLOW_START}`);
      }
      inAllowBlock = false;
      return;
    }

    const match = LITERAL_RE.exec(text);
    if (!match) {
      return;
    }
    if (inAllowBlock || text.includes(ALLOW_LINE)) {
      allowedCount++;
      return;
    }
    violations.push({ line: lineNo, text: text.trim(), id: match[1] });
  });

  if (inAllowBlock) {
    markerErrors.push(`line ${blockStartLine}: ${ALLOW_START} was never closed with ${ALLOW_END}`);
  }

  return { violations, allowedCount, markerErrors };
}

function main() {
  let totalAllowed = 0;
  let hadFailure = false;

  for (const target of TARGET_FILES) {
    const rel = path.relative(process.cwd(), target);

    let source;
    try {
      source = fs.readFileSync(target, 'utf8');
    } catch (err) {
      console.error(`[check-provider-literals] Cannot read ${rel}: ${err.message}`);
      hadFailure = true;
      continue;
    }

    const { violations, allowedCount, markerErrors } = scanSource(source);
    totalAllowed += allowedCount;

    if (markerErrors.length > 0) {
      console.error(`[check-provider-literals] Malformed allowlist markers in ${rel}:`);
      for (const e of markerErrors) {
        console.error(`  ${e}`);
      }
      hadFailure = true;
    }

    if (violations.length > 0) {
      console.error(
        `[check-provider-literals] ${violations.length} provider-id literal(s) in ${rel} outside allowlisted bootstrap blocks:`
      );
      for (const v of violations) {
        console.error(`  ${rel}:${v.line}  ['${v.id}']  ${v.text}`);
      }
      hadFailure = true;
    }
  }

  if (hadFailure) {
    console.error('');
    console.error('The webview must render from state.providerManifest (capabilities +');
    console.error('display metadata), never from provider-name literals. If this literal');
    console.error('is genuinely bootstrap-only (markup/defaults that exist before the');
    console.error(`manifest arrives), wrap it with ${ALLOW_START} / ${ALLOW_END}`);
    console.error(`comment markers or tag the line with ${ALLOW_LINE} — with a reason.`);
    process.exit(1);
  }

  console.log(
    `[check-provider-literals] OK — no provider-id literals outside allowlisted blocks (${totalAllowed} allowlisted line(s) across ${TARGET_FILES.length} files).`
  );
}

module.exports = { scanSource, PROVIDER_IDS, ALLOW_START, ALLOW_END, ALLOW_LINE };

if (require.main === module) {
  main();
}
