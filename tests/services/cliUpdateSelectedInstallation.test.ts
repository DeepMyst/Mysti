import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ExtensionContext } from 'vscode';
import { CliUpdateService, type CliVersionSource } from '../../src/services/CliUpdateService';
import { createMockMemento } from '../helpers/mockVscode';

const exec = promisify(execFile);
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc02-updates-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function executable(file: string, source: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'win32' && !file.endsWith('.js')) {
    fs.writeFileSync(`${file}.cjs`, source);
    fs.writeFileSync(`${file}.cmd`, `@ECHO OFF\r\n"${process.execPath}" "${file}.cjs" %*\r\n`);
    return `${file}.cmd`;
  }
  fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return file;
}
function npmExecutable(source: string): string {
  if (process.platform !== 'win32') { return executable(path.join(root, 'npm fixture'), source); }
  const prefix = path.join(root, 'npm fixture');
  const packageRoot = path.join(prefix, 'node_modules', 'npm');
  executable(path.join(packageRoot, 'bin', 'npm-cli.js'), source);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
  const shim = path.join(prefix, 'npm.cmd');
  fs.writeFileSync(shim, '@ECHO OFF\r\nSET "NODE_EXE=node"\r\n"%NODE_EXE%" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
  return shim;
}
function shellCommand(command: string, env = process.env) {
  return process.platform === 'win32'
    ? exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { env, windowsVerbatimArguments: true })
    : exec('/bin/bash', ['-c', command], { env });
}
function shellWord(value: string): string {
  return process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'"'"'`)}'`;
}
function runLauncher(file: string, args: string[]) {
  return process.platform === 'win32' ? shellCommand([file, ...args].map(shellWord).join(' ')) : exec(file, args);
}
function npmInstall(name: string, version: string) {
  const prefix = path.join(root, name);
  const packageRoot = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@openai', 'codex');
  const versionFile = path.join(prefix, 'version.txt');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const target = executable(path.join(packageRoot, 'bin', 'codex.js'), `process.stdout.write(require('fs').readFileSync(${JSON.stringify(versionFile)}, 'utf8'))`);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version, bin: { codex: 'bin/codex.js' } }));
  const cli = process.platform === 'win32' ? path.join(prefix, 'codex.cmd') : path.join(prefix, 'bin', 'codex');
  if (process.platform === 'win32') {
    fs.writeFileSync(cli, `@ECHO OFF\r\n"${process.execPath}" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
  } else { fs.symlinkSync(target, cli); }
  fs.writeFileSync(versionFile, version);
  return { prefix, cli, versionFile, packageRoot };
}
function service(providerId: string, cli: string, npm: string, version = '0.100.0') {
  const status = { providerId, found: true, path: cli, version };
  const versions: CliVersionSource = { getAllStatuses: async () => [status], peekStatus: () => status };
  return new CliUpdateService({ globalState: createMockMemento() } as unknown as ExtensionContext, versions, { getNpmPath: () => npm });
}

describe('PC-02 updates preserve the selected CLI installation', () => {
  it('installs the advertised version even if the registry changes between the offer and update', async () => {
    const selected = npmInstall('selected prefix', '0.140.0');
    const registry = path.join(root, 'registry-version.txt');
    fs.writeFileSync(registry, '0.159.3');
    // Read-only discovery and installation both use the disposable executable.
    // Its moving latest tag reproduces a registry publish after the card appears.
    const npm = npmExecutable(`
      const fs = require('fs'), path = require('path');
      const args = process.argv.slice(2);
      const latest = fs.readFileSync(${JSON.stringify(registry)}, 'utf8');
      if (args[0] === 'view') {
        process.stdout.write(JSON.stringify({ version: latest, 'engines.node': '>=18' }));
      } else if (args[0] === 'install') {
        const requested = args.at(-1).split('@').at(-1);
        const prefix = args[args.indexOf('--prefix') + 1];
        fs.writeFileSync(path.join(prefix, 'version.txt'), requested === 'latest' ? latest : requested);
      } else { throw new Error('Unexpected npm command'); }
    `);
    const svc = service('openai-codex', selected.cli, npm, '0.140.0');
    try {
      const [offer] = await svc.checkAll();
      expect(offer.installable).toBe('0.159.3');
      fs.writeFileSync(registry, '0.162.0');
      await shellCommand(svc.getUpdateCommand('openai-codex')!);
      expect((await runLauncher(selected.cli, ['--version'])).stdout).toBe(offer.installable);
    } finally { svc.dispose(); }
  });

  it.each(['openai-codex', 'claude-code'])('requires a detected path before updating %s instead of falling back to global/PATH', providerId => {
    const svc = service(providerId, '', '/unused/npm');
    try {
      expect(svc.getUpdateCommand(providerId)).toBeUndefined();
      expect(svc.getUpdateError(providerId)).toContain('selected CLI installation path');
      expect(() => svc.getModelUpgradePlan(providerId, '2.1.280')).toThrow('selected CLI installation path');
    } finally { svc.dispose(); }
  });
  it('updates the selected npm prefix while leaving an older PATH/global installation unchanged', async () => {
    const older = npmInstall('old PATH prefix', '0.100.0');
    const selected = npmInstall("selected prefix's tree", '0.140.0');
    // A disposable npm executable records the real argv and modifies only its
    // requested prefix. Omitting --prefix reproduces the wrong-global-install
    // bug without touching any real package or running a package manager.
    const argvFile = path.join(root, 'npm-argv.json');
    const npm = npmExecutable(`
      const fs = require('fs'), path = require('path');
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
      const index = args.indexOf('--prefix');
      const prefix = index >= 0 ? args[index + 1] : ${JSON.stringify(older.prefix)};
      fs.writeFileSync(path.join(prefix, 'version.txt'), '0.153.1');
    `);
    const svc = service('openai-codex', selected.cli, npm);
    try {
      const plan = svc.getModelUpgradePlan('openai-codex', '0.153.1', selected.cli);
      // Model upgrades use vscode.ShellExecution(executable, args), including
      // .cmd launchers on Windows; exercise the same native shell contract.
      await shellCommand([plan.executable, ...plan.args].map(shellWord).join(' '), { ...process.env, PATH: `${path.dirname(older.cli)}${path.delimiter}${process.env.PATH}` });
      expect((await runLauncher(selected.cli, ['--version'])).stdout).toBe('0.153.1');
      expect((await runLauncher(older.cli, ['--version'])).stdout).toBe('0.100.0');
      expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toEqual(['install', '-g', '--prefix', fs.realpathSync(selected.prefix), '@openai/codex@0.153.1']);
      // The ordinary update action uses the same installation, with shell
      // quoting tested by the apostrophe and spaces in this selected prefix.
      fs.writeFileSync(selected.versionFile, '0.140.0');
      await shellCommand(svc.getUpdateCommand('openai-codex')!);
      expect(fs.readFileSync(selected.versionFile, 'utf8')).toBe('0.153.1');
      expect(fs.readFileSync(older.versionFile, 'utf8')).toBe('0.100.0');
    } finally { svc.dispose(); }
  });

  it('ordinary native updates execute the selected custom path rather than the first PATH binary', async () => {
    const olderVersion = path.join(root, 'older-version.txt');
    const selectedVersion = path.join(root, 'selected-version.txt');
    fs.writeFileSync(olderVersion, '2.1.278');
    fs.writeFileSync(selectedVersion, '2.1.278');
    const makeCli = (folder: string, file: string) => executable(path.join(root, folder, 'claude'), `
      const fs = require('fs');
      if (process.argv.slice(2).join(' ') !== 'install latest') throw new Error('Unexpected command');
      fs.writeFileSync(${JSON.stringify(file)}, '2.1.286');
    `);
    const older = makeCli('older PATH', olderVersion);
    const selected = makeCli("selected user's CLI", selectedVersion);
    const svc = service('claude-code', selected, '/unused/npm');
    try {
      const command = svc.getUpdateCommand('claude-code');
      expect(command).toBeDefined();
      await shellCommand(command!, { ...process.env, PATH: `${path.dirname(older)}${path.delimiter}${process.env.PATH}` });
      expect(fs.readFileSync(selectedVersion, 'utf8')).toBe('2.1.286');
      expect(fs.readFileSync(olderVersion, 'utf8')).toBe('2.1.278');
    } finally { svc.dispose(); }
  });

  it('refuses to update an unrecognized custom binary through an unrelated global npm install', () => {
    const cli = executable(path.join(root, 'custom', 'codex'), "process.stdout.write('0.140.0')");
    const svc = service('openai-codex', cli, '/unused/npm');
    try {
      expect(() => svc.getModelUpgradePlan('openai-codex', '0.153.1', cli)).toThrow(/selected|manual|installation/i);
      expect(svc.getUpdateCommand('openai-codex')).toBeUndefined();
      expect(svc.getUpdateError('openai-codex')).toContain(cli);
      expect(svc.getUpdateError('openai-codex')).toContain('manually');
    } finally { svc.dispose(); }
  });

  it('refuses a known npm package whose selected launcher is not its declared bin', () => {
    const selected = npmInstall('selected', '0.140.0');
    const other = executable(path.join(selected.packageRoot, 'tools', 'unrelated.js'), "process.stdout.write('0.140.0')");
    const svc = service('openai-codex', other, '/unused/npm');
    try {
      expect(() => svc.getModelUpgradePlan('openai-codex', '0.153.1', other)).toThrow(/selected|manual|installation/i);
    } finally { svc.dispose(); }
  });

  it('recognizes npm Windows cmd shim layout without executing a Windows installer', () => {
    const prefix = path.join(root, 'windows prefix');
    const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex');
    executable(path.join(packageRoot, 'bin', 'codex.js'), '');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    const cli = path.join(prefix, 'codex.cmd');
    fs.writeFileSync(cli, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const svc = service('openai-codex', cli, '/fixture/npm.cmd');
    try {
      expect(svc.getModelUpgradePlan('openai-codex', '0.153.1', cli)).toEqual({
        executable: '/fixture/npm.cmd', args: ['install', '-g', '--prefix', fs.realpathSync(prefix), '@openai/codex@0.153.1'],
      });
      expect(svc.getUpdateError('openai-codex')).toBeUndefined();
    } finally { svc.dispose(); }
  });

  it('does not infer an npm prefix merely from a similarly named custom Windows launcher', () => {
    const prefix = path.join(root, 'windows prefix');
    const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex');
    executable(path.join(packageRoot, 'bin', 'codex.js'), '');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    const cli = path.join(prefix, 'codex.cmd');
    fs.writeFileSync(cli, '@ECHO off\r\nC:\\unrelated\\codex.exe %*\r\n');
    const svc = service('openai-codex', cli, '/fixture/npm.cmd');
    try {
      expect(() => svc.getModelUpgradePlan('openai-codex', '0.153.1', cli)).toThrow('manually');
      expect(svc.getUpdateCommand('openai-codex')).toBeUndefined();
    } finally { svc.dispose(); }
  });
});
