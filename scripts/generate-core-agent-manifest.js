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
 * Core agent integrity manifest generator (Plan 20 Phase 0).
 *
 * WHY THIS EXISTS
 * ---------------
 * `AgentLoader` decides an agent's trust tier from the DIRECTORY it was found
 * in: anything under `resources/agents/core` is treated as bundled-with-the-
 * extension and its instructions are concatenated straight into the system
 * prompt. But nothing enforces that the directory still holds the bytes we
 * shipped. A delegated CLI backend runs with no sandbox around it and can write
 * any path on disk, and so can any other local process or extension. One such
 * write buys unfenced system-tier injection in every workspace, forever.
 *
 * So trust is moved from LOCATION to INTEGRITY: this script records the SHA-256
 * of every bundled agent file, and `AgentLoader` re-computes it at load. A file
 * whose hash is unknown still loads — it is simply not trusted, and its
 * instructions get fenced as untrusted data like any user-authored file.
 *
 * WHY IT EMITS TYPESCRIPT AND NOT JSON
 * ------------------------------------
 * A manifest shipped as a sibling JSON file is writable by exactly the attacker
 * it defends against — rewriting `core-manifest.json` is no harder than
 * rewriting `core/skills/secure-coding.md`. Emitting a .ts module means the
 * hashes are compiled into `dist/extension.js`; forging them requires editing
 * the extension's own code, at which point hashes are moot anyway.
 *
 * LINE ENDINGS
 * ------------
 * `.gitattributes` sets `* text=auto`, so a Windows checkout can materialize
 * these files with CRLF. Hashes are therefore computed over content normalized
 * to LF, making the manifest identical on every platform.
 *
 * USAGE
 *   node scripts/generate-core-agent-manifest.js            # write the manifest
 *   node scripts/generate-core-agent-manifest.js --check    # verify, exit 1 on drift
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(REPO_ROOT, 'resources', 'agents', 'core');
const OUT_FILE = path.join(REPO_ROOT, 'src', 'generated', 'coreAgentManifest.ts');

/** Hash markdown content the same way on every platform (LF-normalized). */
function hashContent(buffer) {
  const normalized = buffer.toString('utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Every .md file under the core dir, as POSIX paths relative to it, sorted. */
function collectCoreFiles(dir, relBase = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) { continue; }
      out.push(...collectCoreFiles(abs, rel));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push({ rel, abs });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function buildManifest() {
  const files = collectCoreFiles(CORE_DIR);
  const entries = files.map(f => [f.rel, hashContent(fs.readFileSync(f.abs))]);
  return { count: entries.length, entries };
}

function render({ count, entries }) {
  const rows = entries.map(([rel, hash]) => `  '${rel}': '${hash}',`).join('\n');
  return `/**
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
 * GENERATED FILE — DO NOT EDIT BY HAND.
 * Regenerate with: npm run build:core-manifest
 *
 * SHA-256 of every bundled agent file under resources/agents/core, hashed over
 * LF-normalized content. Compiled into dist/extension.js so the hashes cannot be
 * rewritten by whoever rewrites the agent files (Plan 20 Phase 0 / invariant I1).
 *
 * A file missing from this map, or whose content no longer matches, still loads
 * — it is simply NOT integrity-verified, so its instructions are fenced as
 * untrusted data instead of entering the system prompt.
 */

/** Relative POSIX path under resources/agents/core → SHA-256 of LF-normalized content. */
export const CORE_AGENT_HASHES: Readonly<Record<string, string>> = Object.freeze({
${rows}
});

/** Number of bundled agent files at build time (drift canary for tests). */
export const CORE_AGENT_FILE_COUNT = ${count};
`;
}

function main() {
  const check = process.argv.includes('--check');
  const manifest = buildManifest();

  if (manifest.count === 0) {
    console.error(`[core-manifest] No agent files found under ${CORE_DIR}. Refusing to write an empty manifest.`);
    process.exit(1);
  }

  const rendered = render(manifest);

  if (check) {
    let existing = null;
    try { existing = fs.readFileSync(OUT_FILE, 'utf8'); } catch { /* missing */ }
    if (existing !== rendered) {
      console.error('[core-manifest] Manifest is out of date. Run: npm run build:core-manifest');
      process.exit(1);
    }
    console.log(`[core-manifest] Up to date (${manifest.count} files).`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, rendered, 'utf8');
  console.log(`[core-manifest] Wrote ${manifest.count} hashes → ${path.relative(REPO_ROOT, OUT_FILE)}`);
}

main();
