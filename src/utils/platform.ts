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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import { LOCAL_CLI_PREFIX } from '../constants';

const execAsync = promisify(exec);

/**
 * Platform information cached for the session
 */
export interface PlatformInfo {
  os: 'darwin' | 'linux' | 'win32';
  arch: string;
  shell: string;
  hasNvm: boolean;
  nvmDir: string | null;
  nodeVersion: string | null;
  npmVersion: string | null;
}

/**
 * Configuration for CLI search path generation
 */
export interface CliSearchConfig {
  commandName: string;         // e.g. 'claude', 'codex', 'gemini'
  configuredPath?: string;     // from VSCode settings (if non-default)
  windowsCmd?: string;         // e.g. 'claude.cmd' for Windows npm installs
  additionalPaths?: string[];  // provider-specific extra locations
}

let _cachedPlatformInfo: PlatformInfo | null = null;

/**
 * Get platform information (cached for session)
 */
export async function getPlatformInfo(): Promise<PlatformInfo> {
  if (_cachedPlatformInfo) {
    return _cachedPlatformInfo;
  }

  const platform = process.platform as 'darwin' | 'linux' | 'win32';
  const homeDir = os.homedir();
  const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
  const hasNvm = fs.existsSync(nvmDir);

  let nodeVersion: string | null = null;
  let npmVersion: string | null = null;

  try {
    const { stdout } = await execAsync('node --version', { timeout: 5000 });
    nodeVersion = stdout.trim();
  } catch { /* not available */ }

  try {
    const { stdout } = await execAsync('npm --version', { timeout: 5000 });
    npmVersion = stdout.trim();
  } catch { /* not available */ }

  _cachedPlatformInfo = {
    os: platform,
    arch: process.arch,
    shell: process.env.SHELL || (platform === 'win32' ? 'cmd.exe' : '/bin/bash'),
    hasNvm,
    nvmDir: hasNvm ? nvmDir : null,
    nodeVersion,
    npmVersion,
  };

  return _cachedPlatformInfo;
}

/**
 * Reset the cached platform info (useful after installing node/npm)
 */
export function resetPlatformInfoCache(): void {
  _cachedPlatformInfo = null;
}

/**
 * Get ordered, deduplicated search paths for a CLI binary.
 *
 * Priority order:
 * 1. User-configured path (from VSCode settings)
 * 2. Provider-specific additional paths
 * 3. Mysti local install prefix (~/.mysti/cli/bin)
 * 4. NVM-managed paths (current symlink + versioned paths)
 * 5. Standard system paths (Homebrew, /usr/local/bin, etc.)
 * 6. npm global user paths (~/.npm-global/bin, ~/.local/bin)
 * 7. Windows AppData paths
 * 8. Bare command fallback (relies on PATH)
 */
export function getCommonSearchPaths(config: CliSearchConfig): string[] {
  const { commandName, configuredPath, windowsCmd, additionalPaths } = config;
  const homeDir = os.homedir();
  const seen = new Set<string>();
  const paths: string[] = [];

  const addPath = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };

  // 1. User-configured path (if non-default)
  if (configuredPath && configuredPath !== commandName) {
    addPath(configuredPath);
  }

  // 2. Provider-specific additional paths
  if (additionalPaths) {
    for (const p of additionalPaths) {
      addPath(p);
    }
  }

  // 3. Mysti local install prefix (fallback from permission errors)
  const localBin = path.join(homeDir, LOCAL_CLI_PREFIX, 'bin', commandName);
  addPath(localBin);

  if (process.platform === 'win32') {
    // Windows paths
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const winCmd = windowsCmd || `${commandName}.cmd`;
    addPath(path.join(appData, 'npm', winCmd));
    addPath(path.join(appData, 'npm', commandName));
  } else {
    // 4. NVM-managed paths
    const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
    if (fs.existsSync(nvmDir)) {
      // Current symlink (most common)
      addPath(path.join(nvmDir, 'current', 'bin', commandName));

      // Versioned paths (latest first)
      const versionsDir = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(versionsDir)) {
        try {
          const versions = fs.readdirSync(versionsDir)
            .filter(v => v.startsWith('v'))
            .sort()
            .reverse();
          for (const version of versions) {
            addPath(path.join(versionsDir, version, 'bin', commandName));
          }
        } catch { /* ignore directory read errors */ }
      }
    }

    // 5. Standard system paths
    addPath(`/usr/local/bin/${commandName}`);
    if (process.platform === 'darwin') {
      addPath(`/opt/homebrew/bin/${commandName}`);  // Homebrew Apple Silicon
    }
    addPath(`/usr/bin/${commandName}`);

    // 6. npm global user paths
    addPath(path.join(homeDir, '.npm-global', 'bin', commandName));
    addPath(path.join(homeDir, '.local', 'bin', commandName));
    addPath(path.join(homeDir, 'node_modules', '.bin', commandName));
  }

  // 7. Bare command fallback (relies on PATH)
  addPath(commandName);

  return paths;
}

/**
 * Get NVM-managed paths for a given binary name.
 * Returns paths in order: current symlink first, then versioned (latest first).
 */
export function getNvmPaths(binaryName: string): string[] {
  const homeDir = os.homedir();
  const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
  const paths: string[] = [];

  if (!fs.existsSync(nvmDir)) {
    return paths;
  }

  // Current symlink
  const currentPath = path.join(nvmDir, 'current', 'bin', binaryName);
  paths.push(currentPath);

  // Versioned paths
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(versionsDir)) {
    try {
      const versions = fs.readdirSync(versionsDir)
        .filter(v => v.startsWith('v'))
        .sort()
        .reverse();
      for (const version of versions) {
        paths.push(path.join(versionsDir, version, 'bin', binaryName));
      }
    } catch { /* ignore */ }
  }

  return paths;
}

/**
 * Validate that a CLI path exists and is executable.
 * For absolute paths, checks filesystem access.
 * For bare commands, checks PATH via which/where.
 */
export async function validateCliPath(cliPath: string): Promise<boolean> {
  try {
    // For absolute or relative paths, check filesystem directly
    if (cliPath.includes(path.sep) || cliPath.startsWith('/')) {
      fs.accessSync(cliPath, fs.constants.X_OK);
      return true;
    }

    // For bare commands, fall back to PATH lookup
    return checkCommandExists(cliPath);
  } catch {
    return false;
  }
}

/**
 * Check if a bare command name exists on the system PATH.
 * Uses `which` on Unix or `where` on Windows.
 */
export function checkCommandExists(command: string): Promise<boolean> {
  const checkCmd = process.platform === 'win32' ? 'where' : 'which';

  return new Promise((resolve) => {
    const proc = spawn(checkCmd, [command], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Validate a CLI path by running it with --version.
 * Useful for providers that need to verify the binary actually works.
 */
export async function validateCliWithVersion(cliPath: string): Promise<boolean> {
  try {
    if (cliPath.includes(path.sep) || cliPath.startsWith('/')) {
      fs.accessSync(cliPath, fs.constants.X_OK);
      return true;
    }

    const { execSync } = await import('child_process');
    execSync(`${cliPath} --version`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we can write to the npm global directory.
 * Returns false if npm is not available or the directory is not writable.
 */
export async function canWriteNpmGlobalDir(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('npm config get prefix', { timeout: 5000 });
    const prefix = stdout.trim();
    const globalDir = path.join(prefix, 'lib', 'node_modules');

    // Check if the directory exists and is writable
    if (fs.existsSync(globalDir)) {
      fs.accessSync(globalDir, fs.constants.W_OK);
      return true;
    }

    // If dir doesn't exist, check parent
    fs.accessSync(prefix, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cached resolved node directory — computed once at first use.
 */
let _resolvedNodeDir: string | null = null;

/**
 * Find the directory containing the actual `node` binary.
 * Checks common locations since process.execPath in VSCode points to Electron, not node.
 */
function findNodeDir(): string | null {
  if (_resolvedNodeDir !== null) { return _resolvedNodeDir; }

  const homeDir = os.homedir();
  const candidates: string[] = [];

  // NVM current symlink (highest priority — user's selected version)
  const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
  const nvmCurrent = path.join(nvmDir, 'current', 'bin');
  candidates.push(nvmCurrent);

  // NVM versioned paths (latest first)
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(versionsDir)) {
    try {
      const versions = fs.readdirSync(versionsDir)
        .filter(v => v.startsWith('v'))
        .sort()
        .reverse();
      for (const version of versions) {
        candidates.push(path.join(versionsDir, version, 'bin'));
      }
    } catch { /* ignore */ }
  }

  // Standard system locations
  candidates.push('/usr/local/bin');
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin');
  }
  candidates.push('/usr/bin');

  // npm global user paths
  candidates.push(path.join(homeDir, '.npm-global', 'bin'));
  candidates.push(path.join(homeDir, '.local', 'bin'));

  for (const dir of candidates) {
    const nodePath = path.join(dir, 'node');
    try {
      fs.accessSync(nodePath, fs.constants.X_OK);
      _resolvedNodeDir = dir;
      console.log('[Mysti] Resolved node directory:', dir);
      return dir;
    } catch { /* continue */ }
  }

  // Fallback: process.execPath dirname (works in standalone node, not VSCode)
  const execDir = path.dirname(process.execPath);
  try {
    fs.accessSync(path.join(execDir, 'node'), fs.constants.X_OK);
    _resolvedNodeDir = execDir;
    return execDir;
  } catch { /* not there either */ }

  console.warn('[Mysti] Could not find node binary in any standard location');
  _resolvedNodeDir = '';
  return null;
}

/**
 * Cached base enriched environment — computed once, reused for all spawns.
 */
let _baseEnrichedEnv: Record<string, string | undefined> | null = null;

/**
 * Build the base enriched environment (without extras). Called once and cached.
 */
function _buildBaseEnrichedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const currentPath = env.PATH || '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const parts = currentPath.split(pathSep);

  // Always prepend critical directories (even if already present — move to front)
  const prependDirs: string[] = [];

  // 1. Node binary directory (critical for #!/usr/bin/env node)
  const nodeDir = findNodeDir();
  if (nodeDir) { prependDirs.push(nodeDir); }

  // 2. Common CLI install locations
  prependDirs.push('/usr/local/bin');
  if (process.platform === 'darwin') {
    prependDirs.push('/opt/homebrew/bin');
  }

  // 3. NVM current symlink
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const nvmCurrent = path.join(nvmDir, 'current', 'bin');
  if (fs.existsSync(nvmCurrent) && !prependDirs.includes(nvmCurrent)) {
    prependDirs.push(nvmCurrent);
  }

  // Remove duplicates from existing path, then prepend our dirs
  const filtered = parts.filter(p => !prependDirs.includes(p));
  const finalParts = [...prependDirs, ...filtered];

  env.PATH = finalParts.join(pathSep);
  return env;
}

/**
 * Build a process environment with PATH enriched to include node's directory
 * and common CLI install locations. This ensures `#!/usr/bin/env node` shebangs
 * resolve correctly even when VSCode's extension host has a stripped-down PATH.
 * The base environment is cached; only extras are merged per-call.
 */
export function getEnrichedEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!_baseEnrichedEnv) {
    _baseEnrichedEnv = _buildBaseEnrichedEnv();
  }
  return extra ? { ..._baseEnrichedEnv, ...extra } : { ..._baseEnrichedEnv };
}

/**
 * Reset the cached enriched environment (useful after installing node/npm).
 */
export function resetEnrichedEnvCache(): void {
  _baseEnrichedEnv = null;
}

/**
 * Get the npm global prefix path
 */
export async function getNpmPrefix(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('npm config get prefix', { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Read the OpenClaw Gateway auth token.
 * Priority: ~/.openclaw/openclaw.json -> gateway.auth.token, then env OPENCLAW_GATEWAY_TOKEN.
 * Returns undefined if no token is found.
 */
export function readOpenClawToken(): string | undefined {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      // Strip single-line comments and trailing commas for JSON5 compat
      const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
      const config = JSON.parse(cleaned);
      const token = config?.gateway?.auth?.token;
      if (typeof token === 'string' && token.length > 0) {
        return token;
      }
    }
  } catch {
    // Config unreadable or unparseable — fall through to env
  }

  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  return (typeof envToken === 'string' && envToken.length > 0) ? envToken : undefined;
}
