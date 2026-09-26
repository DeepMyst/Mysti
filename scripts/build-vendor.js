#!/usr/bin/env node
/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
'use strict';

// Rebuild Mermaid from the lockfile so its sanitizer follows our audited graph.
// Run `npm ci && npm run build:vendor` after updating Mermaid or its dependencies.
// The upstream prebuilt 11.17.2 asset embeds an older DOMPurify release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webpack = require('webpack');

const root = path.resolve(__dirname, '..');
const lock = require('../package-lock.json');
const output = path.join(root, 'resources');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function recordBuildTool(packagePath, records = {}) {
  if (records[packagePath]) { return records; }
  const record = lock.packages[packagePath];
  records[packagePath] = { version: record.version, integrity: record.integrity };
  for (const name of Object.keys({ ...record.dependencies, ...record.optionalDependencies })) {
    let dir = packagePath;
    while (true) {
      const candidate = path.posix.join(dir, 'node_modules', name);
      if (lock.packages[candidate]) { recordBuildTool(candidate, records); break; }
      if (dir === '.') { break; }
      dir = path.posix.dirname(dir);
    }
  }
  return records;
}

const compiler = webpack({
  context: root,
  mode: 'production',
  target: ['web', 'es2022'],
  entry: require.resolve('mermaid'),
  output: {
    path: output,
    filename: 'mermaid.min.js',
    library: { name: 'mermaid', type: 'var', export: 'default' },
  },
  // Mermaid must share our explicitly audited sanitizer, including lazy diagrams.
  resolve: { alias: { dompurify: require.resolve('dompurify') } },
  plugins: [new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })],
  devtool: false,
  performance: { hints: false },
});

compiler.run((error, stats) => {
  compiler.close(() => {});
  if (error || !stats || stats.hasErrors()) {
    console.error(error || stats?.toString({ all: false, errors: true }));
    process.exitCode = 1;
    return;
  }
  const packages = {};
  for (const file of stats.compilation.fileDependencies) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const packagePath = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(rel)?.[1];
    const record = packagePath && lock.packages[packagePath];
    if (record?.version) {
      packages[packagePath] = { version: record.version, integrity: record.integrity };
    }
  }
  if (!packages['node_modules/mermaid'] || !packages['node_modules/dompurify']) {
    throw new Error('Mermaid and the audited DOMPurify must both be included in the vendor build');
  }
  const assets = Object.fromEntries(Object.keys(stats.compilation.assets).sort().map(name => [name, hash(path.join(output, name))]));
  const manifest = {
    source: `https://github.com/mermaid-js/mermaid/tree/mermaid%40${packages['node_modules/mermaid'].version}`,
    build: 'npm ci && npm run build:vendor',
    buildScriptSha256: hash(__filename),
    webpackVersion: webpack.version,
    buildPackages: Object.fromEntries(Object.entries(recordBuildTool('node_modules/webpack')).sort(([a], [b]) => a.localeCompare(b))),
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
    assets,
  };
  fs.writeFileSync(path.join(output, 'mermaid.provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[vendor] Built Mermaid ${packages['node_modules/mermaid'].version} with DOMPurify ${packages['node_modules/dompurify'].version}; ${Object.keys(packages).length} dependency packages recorded.`);
});
