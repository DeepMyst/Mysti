#!/usr/bin/env node
/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'resources/mermaid.provenance.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (!manifest.packages?.['node_modules/mermaid'] || !manifest.packages?.['node_modules/dompurify']
      || !manifest.buildPackages?.['node_modules/webpack'] || !manifest.buildPackages?.['node_modules/terser-webpack-plugin']
      || !manifest.assets?.['mermaid.min.js'] || !manifest.assets?.['mermaid.min.js.LICENSE.txt']) {
    throw new Error('Vendor provenance is incomplete');
  }
  if (hash(path.join(__dirname, 'build-vendor.js')) !== manifest.buildScriptSha256) {
    throw new Error('Vendor build configuration changed');
  }
  if (lock.packages['node_modules/webpack'].version !== manifest.webpackVersion) {
    throw new Error('Vendor webpack version changed');
  }
  for (const [dependency, expected] of Object.entries({ ...manifest.packages, ...manifest.buildPackages })) {
    const actual = lock.packages[dependency];
    if (!actual || actual.version !== expected.version || actual.integrity !== expected.integrity) {
      throw new Error(`Bundled dependency changed: ${dependency}`);
    }
  }
  for (const [asset, expected] of Object.entries(manifest.assets)) {
    if (hash(path.join(root, 'resources', asset)) !== expected) {
      throw new Error(`Vendored asset changed: ${asset}`);
    }
  }
  console.log('[vendor] Committed Mermaid assets match their recorded build and locked dependencies.');
} catch (error) {
  console.error(`[vendor] ${error.message}. Run npm run build:vendor and review the asset/NOTICE changes.`);
  process.exitCode = 1;
}
