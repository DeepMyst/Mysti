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
 */

/**
 * perf-sizes — bundle/package size report and CI guard (Plan 03, Phase 1/8).
 *
 * Prints byte sizes (and human-readable MB) for:
 *   - dist/extension.js
 *   - the newest *.vsix in the repo root (if any)
 *   - resources/ total
 *   - resources/icons total
 *
 * Usage:
 *   node scripts/perf-sizes.js [--max-extension-kb <n>] [--max-vsix-mb <n>]
 *
 * Exits 1 when a provided limit is exceeded (CI guard). No dependencies.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const opts = { maxExtensionKb: null, maxVsixMb: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let key = arg;
    let value = null;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      key = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
    }
    if (key === '--max-extension-kb' || key === '--max-vsix-mb') {
      if (value === null || value === '' || isNaN(Number(value))) {
        console.error(`[perf-sizes] Invalid value for ${key}: ${value}`);
        process.exit(2);
      }
      if (eq === -1) { i++; } // consumed the next token
      if (key === '--max-extension-kb') { opts.maxExtensionKb = Number(value); }
      else { opts.maxVsixMb = Number(value); }
    } else if (key.startsWith('--')) {
      console.error(`[perf-sizes] Unknown option: ${key}`);
      console.error('Usage: node scripts/perf-sizes.js [--max-extension-kb <n>] [--max-vsix-mb <n>]');
      process.exit(2);
    }
  }
  return opts;
}

function fileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function dirSize(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) { continue; }
    if (entry.isDirectory()) {
      const sub = dirSize(full);
      if (sub !== null) { total += sub; }
    } else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* ignore */ }
    }
  }
  return total;
}

function newestVsix(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith('.vsix')) { continue; }
    const full = path.join(dirPath, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) { continue; }
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { name, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }
  return newest;
}

function humanMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const extensionJs = fileSize(path.join(ROOT, 'dist', 'extension.js'));
  const vsix = newestVsix(ROOT);
  const resourcesTotal = dirSize(path.join(ROOT, 'resources'));
  const iconsTotal = dirSize(path.join(ROOT, 'resources', 'icons'));

  const rows = [
    ['dist/extension.js', extensionJs],
    [vsix ? `vsix (${vsix.name})` : 'vsix (none found)', vsix ? vsix.size : null],
    ['resources/ total', resourcesTotal],
    ['resources/icons total', iconsTotal],
  ];

  const nameWidth = Math.max(...rows.map((r) => r[0].length)) + 2;
  console.log('Target'.padEnd(nameWidth) + 'Bytes'.padStart(14) + '  Human');
  for (const [label, bytes] of rows) {
    const bytesStr = bytes === null ? 'n/a' : String(bytes);
    const humanStr = bytes === null ? 'n/a' : humanMb(bytes);
    console.log(label.padEnd(nameWidth) + bytesStr.padStart(14) + '  ' + humanStr);
  }

  const failures = [];
  if (opts.maxExtensionKb !== null && extensionJs !== null && extensionJs > opts.maxExtensionKb * 1024) {
    failures.push(`dist/extension.js ${extensionJs} bytes exceeds --max-extension-kb ${opts.maxExtensionKb} (${opts.maxExtensionKb * 1024} bytes)`);
  }
  if (opts.maxVsixMb !== null && vsix && vsix.size > opts.maxVsixMb * 1024 * 1024) {
    failures.push(`${vsix.name} ${vsix.size} bytes exceeds --max-vsix-mb ${opts.maxVsixMb} (${opts.maxVsixMb * 1024 * 1024} bytes)`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error('[perf-sizes] FAIL: ' + failure);
    }
    process.exit(1);
  }
  console.log('[perf-sizes] OK');
}

main();
