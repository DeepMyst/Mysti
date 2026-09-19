/* Compile the shipped host entry graphs against the minimum editor runtime. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript-minimum');

const normalizePath = file => file.replace(/\\/g, '/');

function validateProjectRoots(config, bundles, root, paths = path) {
  const files = new Set(config.fileNames.map(normalizePath));
  for (const bundle of bundles.filter(bundle => bundle.target === 'node')) {
    if (typeof bundle.entry !== 'string' || !files.has(normalizePath(paths.resolve(root, bundle.entry)))) {
      throw new Error(`Minimum types omit host bundle ${bundle.name}`);
    }
  }
  const required = ['types/minimum-node/globals.d.ts', 'tests-runtime/minimum-node-types.ts'];
  if (required.some(file => !files.has(normalizePath(paths.resolve(root, file)))) || !config.options.noEmit) {
    throw new Error('Minimum type project must include its Web API declarations and canaries, and emit no runtime files');
  }
}

function checkMinimumNodeTypes() {
  const root = path.resolve(__dirname, '..');
  const nodeTypes = path.dirname(require.resolve('node18-types/package.json'));
  const vendor = path.join(root, 'types/minimum-node');
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'vendor.json'), 'utf8'));
  const pinned = require('node18-types/package.json');
  if (pinned.version !== '18.17.19' || ts.version !== '5.6.3') {
    throw new Error('Minimum runtime declarations/compiler changed without compatibility review');
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, 'undici', name))).digest('hex');
    if (actual !== expected) { throw new Error(`Minimum fetch declaration changed: ${name}`); }
  }
  const configFile = path.join(root, 'tsconfig.minimum-node.json');
  const raw = ts.readConfigFile(configFile, ts.sys.readFile);
  if (raw.error) { throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n')); }
  const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, root, undefined, configFile);
  const configs = require('../webpack.config.js');
  validateProjectRoots(config, configs, root);
  const host = ts.createCompilerHost(config.options);
  // Every transitive /// <reference types="node"> must resolve to the pinned
  // minimum declarations too, including references from SDK and ws typings.
  host.resolveTypeReferenceDirectives = (refs, file, redirect, options) => refs.map(ref => {
    const name = typeof ref === 'string' ? ref : ref.fileName;
    return name === 'node'
      ? { resolvedFileName: path.join(nodeTypes, 'index.d.ts'), primary: true }
      : ts.resolveTypeReferenceDirective(name, file, options, host, redirect).resolvedTypeReferenceDirective;
  });
  const program = ts.createProgram(config.fileNames, config.options, host);
  const sources = program.getSourceFiles();
  for (const source of sources) {
    const name = normalizePath(source.fileName);
    if (name.includes('/@types/node/') || /\/lib\.dom(?:\.iterable)?\.d\.ts$/.test(name)) {
      throw new Error(`Minimum host project included newer Node or browser globals: ${name}`);
    }
  }
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
    }));
    process.exitCode = 1;
  } else {
    const prefix = normalizePath(path.join(root, 'src')) + '/';
    const hostSources = sources.filter(source => normalizePath(source.fileName).startsWith(prefix));
    console.log(`[minimum-node-types] Node 18.17.1: ${hostSources.length} host source files pass; newer Node/browser canaries rejected.`);
  }
}

module.exports = { validateProjectRoots };
if (require.main === module) { checkMinimumNodeTypes(); }
