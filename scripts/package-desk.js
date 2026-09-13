#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'resources/desk-native');
const targets = { 'darwin-arm64': 'darwin-arm64', 'linux-x64': 'linux-x64-gnu', 'win32-x64': 'win32-x64-msvc' };

function prepare() {
  const target = `${process.platform}-${process.arch}`;
  const suffix = targets[target];
  if (!suffix) { throw new Error('This Desk native package target has not been accepted'); }
  const name = `@number0/iroh-${suffix}`;
  const metadata = require(`${name}/package.json`);
  const locked = require('../package-lock.json').packages[`node_modules/${name}`];
  // The published platform package omits its version inside package.json;
  // npm's integrity-verified lock entry is the version authority.
  if (metadata.name !== name || metadata.main !== `iroh.${suffix}.node`
    || locked.version !== '1.1.0' || !locked.integrity) { throw new Error('Desk native dependency is not pinned'); }
  const source = require.resolve(name);
  const data = fs.readFileSync(source);
  if (!fs.lstatSync(source).isFile() || data.length > 32 * 1024 * 1024) { throw new Error('Desk native binary invalid'); }
  fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'binding.node'), data);
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ target, package: name, version: '1.1.0',
    integrity: locked.integrity, sha256: crypto.createHash('sha256').update(data).digest('hex') }, null, 2) + '\n');
  return target;
}

const args = process.argv.slice(2);
if (args[0] === '--universal') {
  // npm run package must never inherit a native binary from a previous build.
  fs.rmSync(dest, { recursive: true, force: true });
} else {
  const target = prepare();
  if (args[0] !== '--prepare-only') {
    if (args.some(arg => ['--target', '-t', '--no-dependencies'].includes(arg) || arg.startsWith('--target='))) {
      throw new Error('Desk packaging chooses the actual host target and requires dependencies');
    }
    execFileSync(process.execPath, [path.join(root, 'node_modules/@vscode/vsce/vsce'), 'package', '--dependencies', '--target', target, ...args], { cwd: root, stdio: 'inherit' });
  }
}
