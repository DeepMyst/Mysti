/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * SPDX-License-Identifier: Apache-2.0
 */

//@ts-check
'use strict';

const path = require('path');

/**
 * Both bundles compile the same `tsconfig.json`, which is what lets the canvas
 * webview import `src/canvas/**` and `src/managers/CanvasSandbox` directly
 * instead of hand-mirroring them in untyped JS (Plan 22 §2.9).
 *
 * @param {string} instance ts-loader keeps one TS program per instance name;
 *   two configs sharing one would fight over it.
 * @param {object} [compilerOptions] per-bundle overrides.
 */
function tsRule(instance, compilerOptions) {
  return {
    test: /\.ts$/,
    exclude: /node_modules/,
    use: [{ loader: 'ts-loader', options: { instance, ...(compilerOptions ? { compilerOptions } : {}) } }],
  };
}

/** The extension host bundle. @type {import('webpack').Configuration} */
const extensionConfig = {
  name: 'extension',
  target: 'node',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode',
    bufferutil: 'commonjs bufferutil',
    'utf-8-validate': 'commonjs utf-8-validate',
    playwright: 'commonjs playwright'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [tsRule('extension')]
  }
};

/**
 * The canvas webview bundle (Plan 22 Phase 2).
 *
 * `target: 'web'` — this runs inside the webview, not the extension host, so it
 * must never resolve `vscode` or any node builtin. It has no `externals` for
 * the same reason: anything it imports has to be real, bundled code, which is
 * exactly the constraint that keeps the renderer honest about what it shares
 * with the host (`CanvasSandbox`, `protocol.ts`, `DocPatch`) instead of
 * re-implementing it.
 *
 * @type {import('webpack').Configuration}
 */
const canvasWebviewConfig = {
  name: 'canvasWebview',
  target: 'web',
  entry: './src/webview/canvas/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'canvasWebview.js',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  devtool: 'source-map',
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    // `module: 'esnext'` (the repo default is `commonjs`) is what lets webpack
    // see real ESM imports and tree-shake. It matters concretely here: the
    // shared `CanvasSandbox` reaches `pageMigration`, which reaches
    // `PageCompiler`, which reaches `@babel/parser` — 470 KB the webview never
    // executes, because a document-model page is already parsed. With CommonJS
    // output webpack cannot prove that and bundles the whole parser.
    // `declaration: false` keeps the webview bundle from re-emitting the
    // extension's .d.ts tree as webpack assets.
    // `moduleResolution: 'node'` must ride along: TypeScript defaults to the
    // legacy 'classic' resolver for any non-commonjs `module`, which cannot
    // find `@babel/parser` (or anything else) in node_modules.
    rules: [tsRule('canvasWebview', {
      module: 'esnext', moduleResolution: 'node', declaration: false, declarationMap: false,
    })]
  }
};

module.exports = [extensionConfig, canvasWebviewConfig];
