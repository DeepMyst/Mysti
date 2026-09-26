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
 * Memoized NVM directory walk — the versions-dir listing is the expensive part
 * of CLI discovery and is identical for every provider, so it is computed once
 * per process lifetime (invalidated via resetPlatformCache()).
 */
interface NvmWalkResult {
  nvmDir: string;
  exists: boolean;
  /** `bin` directories of installed node versions, latest first */
  versionBinDirs: string[];
}

let _cachedNvmWalk: NvmWalkResult | null = null;
let _nvmWalkCount = 0;
let _nodeDirWalkCount = 0;

function _walkNvmDirs(): NvmWalkResult {
  if (_cachedNvmWalk) {
    return _cachedNvmWalk;
  }
  _nvmWalkCount++;

  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const exists = fs.existsSync(nvmDir);
  const versionBinDirs: string[] = [];

  if (exists) {
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      try {
        const versions = fs.readdirSync(versionsDir)
          .filter(v => v.startsWith('v'))
          .sort()
          .reverse();
        for (const version of versions) {
          versionBinDirs.push(path.join(versionsDir, version, 'bin'));
        }
      } catch { /* ignore directory read errors */ }
    }
  }

  _cachedNvmWalk = { nvmDir, exists, versionBinDirs };
  return _cachedNvmWalk;
}

/**
 * Walk counts for the memoized directory probes — exposed so tests can assert
 * that repeated discovery calls hit the cache instead of re-walking the disk.
 */
export function getPlatformWalkCounts(): { nvmWalks: number; nodeDirWalks: number } {
  return { nvmWalks: _nvmWalkCount, nodeDirWalks: _nodeDirWalkCount };
}

/**
 * Reset every module-level platform cache (platform info, NVM walk, resolved
 * node dir, enriched env) and the walk counters. Intended for tests and for
 * invalidation after a node/npm install changes the filesystem.
 */
export function resetPlatformCache(): void {
  _cachedPlatformInfo = null;
  _cachedNvmWalk = null;
  _resolvedNodeDir = null;
  _baseEnrichedEnv = null;
  _nvmWalkCount = 0;
  _nodeDirWalkCount = 0;
}

/**
 * Get platform information (cached for session)
 */
export async function getPlatformInfo(): Promise<PlatformInfo> {
  if (_cachedPlatformInfo) {
    return _cachedPlatformInfo;
  }

  const platform = process.platform as 'darwin' | 'linux' | 'win32';
  const nvm = _walkNvmDirs();
  const nvmDir = nvm.nvmDir;
  const hasNvm = nvm.exists;

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
    // Mysti local-prefix fallback (permission-denied global install): on Windows,
    // `npm install --prefix X` drops the shim directly in the prefix root
    // (X\<cmd>.cmd), NOT in a bin/ subdir as on Unix — so the Unix-shaped localBin
    // added above never matches. Add the Windows-shaped variants here.
    const localPrefix = path.join(homeDir, LOCAL_CLI_PREFIX);
    addPath(path.join(localPrefix, winCmd));
    addPath(path.join(localPrefix, commandName));
    // npm global (default prefix)
    addPath(path.join(appData, 'npm', winCmd));
    addPath(path.join(appData, 'npm', commandName));
  } else {
    // 4. NVM-managed paths (memoized walk — shared across all providers)
    const nvm = _walkNvmDirs();
    if (nvm.exists) {
      // Current symlink (most common)
      addPath(path.join(nvm.nvmDir, 'current', 'bin', commandName));

      // Versioned paths (latest first)
      for (const binDir of nvm.versionBinDirs) {
        addPath(path.join(binDir, commandName));
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
  const nvm = _walkNvmDirs();
  const paths: string[] = [];

  if (!nvm.exists) {
    return paths;
  }

  // Current symlink
  paths.push(path.join(nvm.nvmDir, 'current', 'bin', binaryName));

  // Versioned paths (latest first, from the memoized walk)
  for (const binDir of nvm.versionBinDirs) {
    paths.push(path.join(binDir, binaryName));
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
 * Environment for RESOLVING which binary to run, as opposed to spawning one.
 *
 * `getEnrichedEnv()` PREPENDS /usr/local/bin (and Homebrew, and node's dir) so a
 * `#!/usr/bin/env node` shebang resolves in a GUI-launched host with a stripped
 * PATH. That is right for spawning and wrong for resolution: prepending inverts
 * the user's own PATH order, so a stale `npm i -g` copy in /usr/local/bin beats
 * the current install their shell actually runs. On the machine this was found,
 * the enriched PATH resolved `claude` to 2.0.71 while the user's PATH resolved
 * 2.1.263 — silently defeating the whole point of probing PATH first.
 *
 * So: the user's PATH order is kept intact, and the enrichment directories are
 * APPENDED as fallbacks for the thin-PATH case they exist for.
 */
export function getResolutionEnv(): Record<string, string | undefined> {
  const env = getEnrichedEnv();
  const sep = process.platform === 'win32' ? ';' : ':';
  const userPath = (process.env.PATH || '').split(sep).filter(Boolean);
  const enriched = (env.PATH || '').split(sep).filter(Boolean);

  // First occurrence wins, which is what a PATH lookup does anyway — a real
  // PATH routinely repeats entries and the duplicates only slow the search.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const dir of [...userPath, ...enriched]) {
    if (seen.has(dir)) { continue; }
    seen.add(dir);
    ordered.push(dir);
  }
  env.PATH = ordered.join(sep);
  return env;
}

/**
 * Resolve a command to the absolute path the user's shell would run, or null.
 *
 * Uses the ENRICHED env, so a VS Code launched from Finder — which inherits a
 * minimal PATH and is the reason the hard-coded fallback list exists at all —
 * still resolves the same binary a terminal would.
 *
 * `where` on Windows can return several lines; the first is the winner, exactly
 * as the shell would pick it.
 */
export function resolveCommandOnPath(
  command: string,
  /**
   * Search environment. Defaults to `getResolutionEnv()`, which keeps the
   * user's PATH order ahead of Mysti's fallback directories; the parameter
   * exists so a test can pin that ordering.
   */
  env: Record<string, string | undefined> = getResolutionEnv(),
): Promise<string | null> {
  // A path, not a bare name: there is nothing for PATH to resolve.
  if (command.includes('/') || command.includes('\\')) {
    return Promise.resolve(null);
  }
  const checkCmd = process.platform === 'win32' ? 'where' : 'which';

  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(checkCmd, [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    proc.stdout?.on('data', (chunk) => { out += String(chunk); });
    proc.on('close', (code) => {
      if (code !== 0) { return resolve(null); }
      const first = out.split(/\r?\n/).map(l => l.trim()).find(Boolean);
      resolve(first || null);
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * The paths that outrank the user's PATH: an explicitly configured path, and
 * provider-specific locations a provider declares (e.g. the CLI bundled inside
 * Codex.app). Everything else in `getCommonSearchPaths` is a GUESS and must
 * come AFTER whatever the shell actually resolves — see _discoverCliCommon.
 */
export function getPriorityCliPaths(config: CliSearchConfig): string[] {
  const { commandName, configuredPath, additionalPaths } = config;
  const paths: string[] = [];
  if (configuredPath && configuredPath !== commandName) {
    paths.push(configuredPath);
  }
  if (additionalPaths) {
    paths.push(...additionalPaths);
  }
  return paths;
}

/**
 * Ask a CLI its version. Returns the raw first line, or undefined.
 *
 * Shell-free (argv array), time-boxed, and tolerant: a CLI that has no
 * `--version`, is slow, or prints something unrecognisable simply yields
 * undefined, which every caller already treats as "unknown".
 *
 * The output is DECORATED in practice — "2.1.263 (Claude Code)", "codex-cli
 * 0.153.4", "v1.2.3" — so callers parse it loosely rather than expecting a bare
 * semver.
 */
export function probeCliVersion(cliPath: string, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v?: string) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const proc = spawn(cliPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: getEnrichedEnv(),
      });
      let out = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } done(); }, timeoutMs);
      proc.stdout?.on('data', (chunk) => {
        out += String(chunk);
        // A CLI that keeps talking is not answering a version question.
        if (out.length > 4096) { try { proc.kill(); } catch { /* already gone */ } }
      });
      proc.on('close', () => {
        clearTimeout(timer);
        done(out.split(/\r?\n/).map(l => l.trim()).find(Boolean));
      });
      proc.on('error', () => { clearTimeout(timer); done(); });
    } catch {
      done();
    }
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
 * Build the candidate directories for the `node` binary, in priority order.
 * Kept as a standalone builder so new candidates are a one-line addition.
 */
function _buildNodeDirCandidates(): string[] {
  const homeDir = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    // Windows (issue #27): node.exe ships in Program Files; nvm-windows symlinks
    // a "current" dir; the npm global dir (%APPDATA%\npm) also holds node shims.
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    candidates.push(path.join(programFiles, 'nodejs'));
    candidates.push(path.join(programFilesX86, 'nodejs'));
    // nvm-windows: NVM_SYMLINK points at the active version; NVM_HOME holds versions
    if (process.env.NVM_SYMLINK) { candidates.push(process.env.NVM_SYMLINK); }
    if (process.env.NVM_HOME) { candidates.push(process.env.NVM_HOME); }
    candidates.push(path.join(appData, 'npm'));
    candidates.push(path.join(localAppData, 'Programs', 'nodejs'));
    return candidates;
  }

  // NVM current symlink (highest priority — user's selected version)
  const nvm = _walkNvmDirs();
  candidates.push(path.join(nvm.nvmDir, 'current', 'bin'));

  // NVM versioned paths (latest first, from the memoized walk)
  candidates.push(...nvm.versionBinDirs);

  // Standard system locations
  candidates.push('/usr/local/bin');
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin');
  }
  candidates.push('/usr/bin');

  // npm global user paths
  candidates.push(path.join(homeDir, '.npm-global', 'bin'));
  candidates.push(path.join(homeDir, '.local', 'bin'));

  return candidates;
}

/** The node binary's filename for the current platform. */
function _nodeBinaryName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * Find the directory containing the actual `node` binary.
 * Checks common locations since process.execPath in VSCode points to Electron, not node.
 * Memoized at module level — the directory walk runs once per process lifetime
 * (reset via resetPlatformCache()).
 */
function findNodeDir(): string | null {
  if (_resolvedNodeDir !== null) { return _resolvedNodeDir || null; }

  _nodeDirWalkCount++;
  const candidates = _buildNodeDirCandidates();
  const nodeBin = _nodeBinaryName();

  for (const dir of candidates) {
    const nodePath = path.join(dir, nodeBin);
    try {
      // X_OK is meaningless on Windows (everything reports executable); F_OK
      // (existence) is the correct check there.
      fs.accessSync(nodePath, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      _resolvedNodeDir = dir;
      console.log('[Mysti] Resolved node directory:', dir);
      return dir;
    } catch { /* continue */ }
  }

  // Fallback: process.execPath dirname (works in standalone node, not VSCode)
  const execDir = path.dirname(process.execPath);
  try {
    fs.accessSync(path.join(execDir, nodeBin), process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
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
 * Filter a provider's install methods down to those applicable to the current OS
 * (or the supplied platform), sorted by ascending priority. A method with no
 * `platform` (or `platform: 'all'`) applies everywhere. Centralized here so both
 * BaseCliProvider (deriving getInstallCommand) and ChatViewProvider (what the
 * install modal renders) agree on which commands a given OS should ever see — the
 * webview can't reliably know the host OS, so this gate must run extension-side.
 */
export function filterInstallMethodsForOS<T extends { platform?: 'darwin' | 'linux' | 'win32' | 'all'; priority?: number }>(
  methods: T[],
  platform: NodeJS.Platform = process.platform
): T[] {
  return methods
    .filter(m => !m.platform || m.platform === 'all' || m.platform === platform)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
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
