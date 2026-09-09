#!/usr/bin/env node
/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
'use strict';

// Use the locked build toolchain, then execute out-test/runtime/minimum.cjs
// with Node 18.17.1. The output is isolated from release bundles in dist/.
const path = require('node:path');
const { builtinModules } = require('node:module');
const webpack = require('webpack');
const extension = require('../webpack.config')[0];

const root = path.resolve(__dirname, '..');
const compiler = webpack({
  ...extension,
  context: root,
  name: 'minimum-runtime',
  mode: 'production',
  entry: path.join(root, 'tests-runtime/minimum.cjs'),
  output: {
    ...extension.output,
    path: path.join(root, 'out-test/runtime'),
    filename: 'minimum.cjs',
    clean: true,
  },
  devtool: false,
  module: {
    ...extension.module,
    rules: extension.module.rules.map(rule => rule.use ? {
      ...rule,
      use: rule.use.map(use => ({
        ...use,
        options: {
          ...use.options,
          instance: 'minimum-runtime',
          compilerOptions: { declaration: false, declarationMap: false },
        },
      })),
    } : rule),
  },
});

compiler.run((error, stats) => {
  compiler.close(closeError => {
    if (error || closeError || !stats || stats.hasErrors()) {
      console.error(error || closeError || stats?.toString({ all: false, errors: true }));
      process.exitCode = 1;
      return;
    }
    // The old runtime must execute the bundle without loading the build-time
    // node_modules graph (whose packages can legitimately need newer Node).
    const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
    const unexpected = [...stats.compilation.modules].filter(module =>
      module.constructor.name === 'ExternalModule' &&
      (typeof module.request !== 'string' || !builtins.has(module.request.replace(/^node:/, ''))));
    if (unexpected.length) {
      console.error('Minimum-runtime fixture has non-builtin externals:', unexpected.map(module => module.request));
      process.exitCode = 1;
      return;
    }
    console.log(stats.toString({ all: false, assets: true, timings: true, warnings: true }));
  });
});
