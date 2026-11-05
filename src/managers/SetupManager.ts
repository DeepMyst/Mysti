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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { ProviderManager } from './ProviderManager';
import type { ICliProvider } from '../providers/base/IProvider';
import { showAuthenticationInput } from '../providers/base/authenticationInput';
import type { CliDiscoveryService, CliStatus } from '../services/CliDiscoveryService';
import type {
  ProviderSetupStatus,
  SetupResult,
  InstallResult,
  InstallErrorCategory,
  AuthStatus,
  WizardProviderStatus,
  AuthOption,
  AuthMethodType,
  DiagnosticResult
} from '../types';
import {
  INSTALL_TIMEOUT_MS,
  INSTALL_MAX_RETRIES,
  INSTALL_RETRY_DELAY_MS,
  NPM_CACHE_TTL_MS,
  NETWORK_CHECK_TIMEOUT_MS,
  MIN_NODE_VERSION,
  LOCAL_CLI_PREFIX
} from '../constants';
import { killProcessTree } from '../utils/processKill';
import { quoteSetupExecutable } from '../utils/installerShell';
import { getPlatformInfo, canWriteNpmGlobalDir, resetPlatformInfoCache, probeCliOutput, resolveCommandOnPath } from '../utils/platform';

/** Cancellation stops subsequent setup stages; completed installs/writes are not rolled back. */
function throwIfSetupCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) { return; }
  const error = new Error('Setup cancelled.');
  error.name = 'AbortError';
  throw error;
}

/**
 * Wizard status for all providers (returned by getWizardStatus and
 * emitted by onWizardStatusUpdated).
 */
export interface WizardStatusResult {
  providers: WizardProviderStatus[];
  npmAvailable: boolean;
  nodeVersion?: string;
  anyReady: boolean;
}

/**
 * Immediately-available wizard status (Plan 03 Phase 3a). `complete` is true
 * only when every provider had a fresh (non-expired) discovery cache entry —
 * when false, a background refresh has been kicked off and
 * onWizardStatusUpdated will fire once it settles.
 */
export interface CachedWizardStatusResult extends WizardStatusResult {
  complete: boolean;
}

/**
 * SetupManager orchestrates the CLI setup flow for AI providers.
 *
 * Responsibilities:
 * - Check if any provider CLI is installed and ready
 * - Auto-install CLI via npm when possible (with permission fallback)
 * - Classify install errors and suggest fixes
 * - Retry transient failures (network, timeout)
 * - Guide users through authentication
 * - Provide diagnostics for troubleshooting
 */
export class SetupManager {
  private _extensionContext: vscode.ExtensionContext;
  private _providerManager: ProviderManager;
  private _npmAvailable: boolean | null = null;
  private _npmPath: string | null = null;
  private _npmUsesLoginShell = false;
  private _npmCacheExpiry: number = 0;
  /** Plan 03 Phase 3a: cached CLI discovery — single prober for wizard status. */
  private _discoveryService: CliDiscoveryService | undefined;
  /** Last node --version result (reused by getWizardStatusCached's zero-exec path). */
  private _lastNodeVersion: string | undefined;
  private readonly _installWatchers = new Map<string, () => void>();
  private readonly _installRuns = new Map<string, {
    promise: Promise<InstallResult>;
    controller: AbortController;
    callers: Set<AbortSignal | undefined>;
  }>();

  /** Single-flight guard for the background wizard status refresh. */
  private _backgroundWizardRefresh: Promise<void> | null = null;

  private readonly _onWizardStatusUpdatedEmitter = new vscode.EventEmitter<WizardStatusResult>();
  /**
   * Fires when a background wizard status refresh (kicked off by
   * getWizardStatusCached on cache miss/expiry) completes. Consumers (e.g.
   * ChatViewProvider) push the updated provider availability to webviews.
   */
  public readonly onWizardStatusUpdated: vscode.Event<WizardStatusResult> =
    this._onWizardStatusUpdatedEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    providerManager: ProviderManager,
    discoveryService?: CliDiscoveryService
  ) {
    this._extensionContext = context;
    context.subscriptions?.push({ dispose: () => { for (const stop of this._installWatchers.values()) { stop(); } } });
    this._providerManager = providerManager;
    this._discoveryService = discoveryService;
    // An install or sign-in that flips a CLI's state reaches every panel now,
    // on the same event the background refresh uses — the agent menu used to
    // keep "Not Installed" until some unrelated read refreshed it.
    // Publishing one provider's new facts must not start probes for siblings.
    // The explicit cached-first read still owns the startup background refresh.
    discoveryService?.onDidChange(() => this._onWizardStatusUpdatedEmitter.fire(this._buildCachedWizardStatus()));
  }

  // ============================================================================
  // npm Detection (multi-method, TTL-cached)
  // ============================================================================

  /**
   * Check if npm is available on the system.
   * Uses multiple detection methods to handle NVM and other non-standard installs.
   * Result is cached with TTL to avoid repeated checks while allowing recovery.
   */
  async checkNpmAvailable(): Promise<boolean> {
    if (this._npmAvailable !== null && Date.now() < this._npmCacheExpiry) {
      return this._npmAvailable;
    }

    // Method 1: Direct exec (works for standard PATH-based installs)
    if (await this._checkNpmDirect()) {
      this._npmAvailable = true;
      this._npmPath = 'npm';
      this._npmCacheExpiry = Date.now() + NPM_CACHE_TTL_MS;
      console.log('[Mysti] SetupManager: npm found via direct exec');
      return true;
    }

    // Method 2: Check common NVM paths directly
    const nvmPath = await this._checkNpmInNvmPaths();
    if (nvmPath) {
      this._npmAvailable = true;
      this._npmPath = nvmPath;
      this._npmCacheExpiry = Date.now() + NPM_CACHE_TTL_MS;
      console.log(`[Mysti] SetupManager: npm found at: ${nvmPath}`);
      return true;
    }

    // Method 3: Login shell execution (inherits .bashrc/.zshrc initialization)
    if (await this._checkNpmViaLoginShell()) {
      this._npmAvailable = true;
      this._npmPath = 'npm'; // Will use login shell for execution
      this._npmCacheExpiry = Date.now() + NPM_CACHE_TTL_MS;
      console.log('[Mysti] SetupManager: npm found via login shell');
      return true;
    }

    this._npmAvailable = false;
    this._npmCacheExpiry = Date.now() + NPM_CACHE_TTL_MS;
    console.log('[Mysti] SetupManager: npm not available');
    return false;
  }

  /**
   * Get the npm executable path (useful for running npm commands)
   */
  getNpmPath(): string | null {
    return this._npmPath;
  }

  private async _checkNpmDirect(): Promise<boolean> {
    const output = await probeCliOutput(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], 5000, process.env);
    const found = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/m.test(output?.trim() ?? '');
    if (found) { this._npmUsesLoginShell = false; }
    return found;
  }

  private async _checkNpmInNvmPaths(): Promise<string | null> {
    const homeDir = os.homedir();
    const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
    const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const deadline = Date.now() + 10_000;

    const pathsToCheck = [
      path.join(nvmDir, 'current', 'bin', npmName),
      path.join(homeDir, '.npm-global', 'bin', npmName),
      path.join(homeDir, '.local', 'bin', npmName),
      '/usr/local/bin/npm',
      '/opt/homebrew/bin/npm',
    ];

    // Check NVM versions directory for installed Node versions
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      try {
        const versions = fs.readdirSync(versionsDir)
          .filter(v => v.startsWith('v'))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

        for (const version of versions) {
          pathsToCheck.push(path.join(versionsDir, version, 'bin', npmName));
        }
      } catch {
        // Ignore directory read errors
      }
    }

    for (const npmPath of pathsToCheck) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { break; }
      try {
        fs.accessSync(npmPath, fs.constants.X_OK);
        const env = { ...process.env };
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
        env[pathKey] = path.dirname(npmPath) + path.delimiter + (env[pathKey] || '');
        const output = await probeCliOutput(npmPath, ['--version'], Math.min(5000, remaining), env);
        if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/m.test(output?.trim() ?? '')) { continue; }
        this._npmUsesLoginShell = false;
        console.log(`[Mysti] SetupManager: Found npm at ${npmPath}`);
        return npmPath;
      } catch { /* Continue to the next candidate within the shared deadline. */ }
    }

    return null;
  }

  private async _checkNpmViaLoginShell(): Promise<boolean> {
    if (process.platform === 'win32') {
      return false;
    }

    const shell = process.env.SHELL || '/bin/bash';
    const output = await probeCliOutput(shell, ['-l', '-c', 'npm --version'], 10_000, process.env);
    this._npmUsesLoginShell = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/m.test(output?.trim() ?? '');
    return this._npmUsesLoginShell;
  }

  // ============================================================================
  // Error Classification & Suggested Fixes
  // ============================================================================

  /**
   * Classify an install error based on stderr output and exit code
   */
  private _classifyError(stderr: string, exitCode: number | null): InstallErrorCategory {
    if (/EACCES|permission denied|EPERM|ENOTEMPTY.*permission/i.test(stderr)) {
      return 'permission';
    }
    if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network|fetch failed|socket hang up|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(stderr)) {
      return 'network';
    }
    if (/engine.*node|requires.*node|minimum.*version|Unsupported.*engine|EBADENGINE/i.test(stderr)) {
      return 'version';
    }
    if (/ENOENT|command not found|is not recognized/i.test(stderr)) { return 'not-found'; }
    if (exitCode === null) {
      return 'timeout';
    }
    return 'command-failed';
  }

  /**
   * Get user-facing suggested fix for an error category
   */
  private _getSuggestedFix(category: InstallErrorCategory, installCommand: string): string {
    const fixes: Record<InstallErrorCategory, string> = {
      'permission': 'The global and user-local installation attempts failed. Choose a writable npm prefix or install manually. See https://docs.npmjs.com/resolving-eacces-permissions-errors',
      'network': 'Check your internet connection and proxy settings. If behind a firewall, try: npm config list to verify proxy settings.',
      'version': 'This CLI requires a newer or supported Node.js version. Check the required version in the error details and install a compatible LTS release from nodejs.org.',
      'not-found': 'npm is not installed. Install Node.js from nodejs.org or use nvm (https://github.com/nvm-sh/nvm).',
      'command-failed': `Installation failed. Try running the install command manually in a terminal: ${installCommand}`,
      'timeout': 'Installation timed out. Check your network speed and try again.',
      'unknown': `An unexpected error occurred. Try running manually: ${installCommand}`
    };
    return fixes[category];
  }

  // ============================================================================
  // Node.js Version Check
  // ============================================================================

  /**
   * Check if Node.js version meets minimum requirements
   */
  private async _checkNodeVersion(): Promise<{ meets: boolean; version?: string; error?: string }> {
    try {
      // The prerequisite runtime must be the one npm will resolve during install.
      if (this._npmPath === null) { await this.checkNpmAvailable(); }
      const env = { ...process.env };
      if (this._npmPath && path.isAbsolute(this._npmPath)) {
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
        env[pathKey] = path.dirname(this._npmPath) + path.delimiter + (env[pathKey] || '');
      }
      const output = this._npmUsesLoginShell && process.platform !== 'win32'
        ? await probeCliOutput(process.env.SHELL || '/bin/bash', ['-l', '-c', 'node --version'], 5000, env)
        : await probeCliOutput('node', ['--version'], 5000, env);
      const version = output?.trim() ?? '';
      // Parse major version from "v18.17.0" format
      const match = version.match(/^v?(\d+)\.\d+\.\d+(?:-[\w.-]+)?$/);
      if (match) {
        const major = parseInt(match[1], 10);
        if (major < MIN_NODE_VERSION) {
          return {
            meets: false,
            version,
            error: vscode.l10n.t('Node.js {0}+ required, found {1}', MIN_NODE_VERSION, version)
          };
        }
        return { meets: true, version };
      }
      return { meets: false, error: vscode.l10n.t('Unable to determine the Node.js version. Check the selected npm runtime and retry.') };
    } catch {
      return { meets: false, error: vscode.l10n.t('Node.js is not installed') };
    }
  }

  // ============================================================================
  // Network Connectivity Check
  // ============================================================================

  /**
   * Check if npm registry is reachable
   */
  async checkNetworkConnectivity(): Promise<boolean> {
    const env = { ...process.env };
    if (this._npmPath && path.isAbsolute(this._npmPath)) {
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = path.dirname(this._npmPath) + path.delimiter + (env[pathKey] || '');
    }
    const npm = this._npmPath && path.isAbsolute(this._npmPath)
      ? this._npmPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const output = this._npmUsesLoginShell && process.platform !== 'win32'
      ? await probeCliOutput(process.env.SHELL || '/bin/bash', ['-l', '-c', 'npm ping'], NETWORK_CHECK_TIMEOUT_MS, env)
      : await probeCliOutput(npm, ['ping'], NETWORK_CHECK_TIMEOUT_MS, env);
    return output !== undefined;
  }

  // ============================================================================
  // Retryable Install Logic
  // ============================================================================

  /**
   * Run an install command with retry logic for transient failures.
   * Only retries on network or timeout errors.
   */
  private async _retryableInstall(
    command: string,
    useLoginShell: boolean,
    onProgress?: (step: string, message: string, progress?: number) => void,
    signal?: AbortSignal
  ): Promise<InstallResult> {
    for (let attempt = 1; attempt <= INSTALL_MAX_RETRIES; attempt++) {
      throwIfSetupCancelled(signal);
      const result = await this._runCommand(command, INSTALL_TIMEOUT_MS, useLoginShell);
      throwIfSetupCancelled(signal);

      if (result.success) {
        return { success: true, attemptNumber: attempt };
      }

      const category = this._classifyError(result.error || '', result.exitCode ?? null);

      // Only retry transient failures
      if (!['network', 'timeout'].includes(category) || attempt >= INSTALL_MAX_RETRIES) {
        return {
          success: false,
          error: result.error ? vscode.l10n.t(result.error) : vscode.l10n.t('Installation failed'),
          errorCategory: category,
          errorDetails: result.error,
          retryable: ['network', 'timeout'].includes(category),
          attemptNumber: attempt
        };
      }

      console.log(`[Mysti] SetupManager: Attempt ${attempt} failed (${category}), retrying in ${INSTALL_RETRY_DELAY_MS / 1000}s...`);
      onProgress?.('installing', vscode.l10n.t('Attempt {0} failed, retrying...', attempt), 35);
      await this._delay(INSTALL_RETRY_DELAY_MS);
    }

    return {
      success: false,
      error: vscode.l10n.t('Installation failed after multiple attempts'),
      errorCategory: 'unknown',
      retryable: false
    };
  }

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================================
  // Setup Status & Readiness
  // ============================================================================

  /**
   * Check if any provider is ready (installed and authenticated)
   */
  async checkReady(): Promise<boolean> {
    const statuses = await this.getSetupStatus();
    return statuses.some(s => s.installed && s.authenticated);
  }

  /**
   * Get setup status for all providers
   */
  async getSetupStatus(): Promise<ProviderSetupStatus[]> {
    // Recovery must retain healthy siblings when another provider's login
    // probe fails or stalls. Reuse diagnostics' bounded, isolated live reads;
    // stale cached authentication cannot establish that recovery succeeded.
    return Promise.all(this._providerManager.getAllProviders().map(async provider => {
      const status = await this._diagnoseProvider(provider);
      return {
        providerId: status.id,
        displayName: status.displayName,
        installed: status.installed,
        authenticated: status.authenticated,
        ...(status.error ? { error: status.error } : {}),
      };
    }));
  }

  // ============================================================================
  // Main Setup Flow (improved with all new features)
  // ============================================================================

  /**
   * Run the full setup flow for a provider.
   * Includes Node version check, network check, retryable install with
   * permission fallback, and structured error reporting.
   */
  async setupProvider(
    providerId: string,
    onProgress?: (step: string, message: string, progress?: number) => void,
    signal?: AbortSignal
  ): Promise<SetupResult> {
    throwIfSetupCancelled(signal);
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        success: false,
        installed: false,
        authenticated: false,
        error: vscode.l10n.t('Provider "{0}" not found', providerId)
      };
    }

    // Check installation before requiring any npm prerequisites.
    onProgress?.('checking', 'Checking CLI installation...', 10);
    const discovery = await provider.discoverCli();
    throwIfSetupCancelled(signal);

    if (!discovery.found) {
      // Native CLIs and HTTP providers do not require Node merely to connect.
      if (provider.capabilities.supportsAutoInstall) {
        // Check the npm runtime before a new installation.
        onProgress?.('checking', 'Checking system requirements...', 15);
        const nodeCheck = await this._checkNodeVersion();
        throwIfSetupCancelled(signal);
        if (!nodeCheck.meets) {
          const suggestedFix = this._getSuggestedFix('version', provider.getInstallCommand());
          return {
            success: false,
            installed: false,
            authenticated: false,
            error: nodeCheck.error || `Node.js ${MIN_NODE_VERSION}+ required`,
            errorCategory: 'version',
            suggestedFix
          };
        }

      }

      // Step 3: Try to auto-install
      onProgress?.('installing', vscode.l10n.t('Installing {0} CLI...', provider.displayName), 20);
      const installResult = await this.autoInstallCli(providerId, onProgress, signal);
      throwIfSetupCancelled(signal);

      if (!installResult.success) {
        return {
          success: false,
          installed: false,
          authenticated: false,
          error: installResult.error,
          requiresManualStep: 'install',
          errorCategory: installResult.errorCategory,
          suggestedFix: installResult.suggestedFix
        };
      }
    }

    // Step 4: Check authentication
    onProgress?.('authenticating', vscode.l10n.t('Checking authentication...'), 80);
    const authStatus = await provider.checkAuthentication();
    throwIfSetupCancelled(signal);

    if (!authStatus.authenticated) {
      return {
        success: false,
        installed: true,
        authenticated: false,
        error: authStatus.error,
        requiresManualStep: 'auth'
      };
    }

    onProgress?.('ready', vscode.l10n.t('{0} is ready!', provider.displayName), 100);
    return {
      success: true,
      installed: true,
      authenticated: true
    };
  }

  /**
   * Auto-install CLI via npm with permission fallback and retry logic
   */
  async autoInstallCli(
    providerId: string,
    onProgress?: (step: string, message: string, progress?: number) => void,
    signal?: AbortSignal
  ): Promise<InstallResult> {
    throwIfSetupCancelled(signal);
    let run = this._installRuns.get(providerId);
    if (run?.controller.signal.aborted) {
      // Do not overlap a new installer with a cancelled owner's running command.
      // Wait for it to settle, then allow a fresh request to retry normally.
      try { await run.promise; } catch { /* the abandoned run has its own caller */ }
      throwIfSetupCancelled(signal);
      return this.autoInstallCli(providerId, onProgress, signal);
    }
    if (!run) {
      const controller = new AbortController();
      const created = { controller, callers: new Set<AbortSignal | undefined>(), promise: undefined as unknown as Promise<InstallResult> };
      // Register before starting the first async stage, including progress callbacks.
      created.promise = Promise.resolve().then(() => this._autoInstallCli(providerId, onProgress, controller.signal))
        .finally(() => { if (this._installRuns.get(providerId) === created) { this._installRuns.delete(providerId); } });
      this._installRuns.set(providerId, created);
      run = created;
    }
    const shared = run;
    shared.callers.add(signal);
    const onAbort = () => {
      // One panel's Skip must not cancel an installation another panel still needs.
      if ([...shared.callers].every(caller => caller?.aborted === true)) { shared.controller.abort(); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await shared.promise;
      throwIfSetupCancelled(signal);
      return result;
    } finally { signal?.removeEventListener('abort', onAbort); }
  }

  private async _autoInstallCli(
    providerId: string,
    onProgress?: (step: string, message: string, progress?: number) => void,
    signal?: AbortSignal
  ): Promise<InstallResult> {
    throwIfSetupCancelled(signal);
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        success: false,
        error: vscode.l10n.t('Provider "{0}" not found', providerId),
        errorCategory: 'unknown'
      };
    }

    // Guard: reject auto-install for providers that require interactive setup
    if (!provider.capabilities.supportsAutoInstall) {
      console.log(`[Mysti] SetupManager: Provider "${providerId}" does not support auto-install, requires manual setup`);
      return {
        success: false,
        error: vscode.l10n.t('{0} requires interactive setup and cannot be installed automatically. Please use the manual installation instructions.', provider.displayName),
        requiresManual: true,
        errorCategory: 'command-failed'
      };
    }

    const installCommand = provider.getInstallCommand();

    // Check npm availability
    onProgress?.('installing', vscode.l10n.t('Verifying npm availability...'), 15);
    const npmAvailable = await this.checkNpmAvailable();
    throwIfSetupCancelled(signal);
    if (!npmAvailable) {
      const suggestedFix = this._getSuggestedFix('not-found', installCommand);
      return {
        success: false,
        error: vscode.l10n.t('npm is not available. Install Node.js from nodejs.org or use nvm.'),
        requiresManual: true,
        errorCategory: 'not-found',
        suggestedFix
      };
    }

    // Check network connectivity
    onProgress?.('installing', vscode.l10n.t('Verifying network connectivity...'), 20);
    const networkOk = await this.checkNetworkConnectivity();
    throwIfSetupCancelled(signal);
    if (!networkOk) {
      const suggestedFix = this._getSuggestedFix('network', installCommand);
      return {
        success: false,
        error: vscode.l10n.t('Cannot reach npm registry. Check your internet connection.'),
        requiresManual: false,
        errorCategory: 'network',
        suggestedFix,
        retryable: true
      };
    }

    console.log(`[Mysti] SetupManager: Running install command: ${installCommand}`);

    try {
      const useLoginShell = this._npmPath === 'npm' && !(await this._checkNpmDirect());
      throwIfSetupCancelled(signal);

      // Pre-flight permission check: detect if npm global dir is writable BEFORE attempting install
      onProgress?.('installing', vscode.l10n.t('Checking write permissions to npm global directory...'), 25);
      const hasGlobalWriteAccess = await canWriteNpmGlobalDir();
      throwIfSetupCancelled(signal);

      if (!hasGlobalWriteAccess) {
        // Skip global install entirely — go straight to local install (saves 2-120s)
        console.log('[Mysti] SetupManager: No write access to npm global directory, installing locally');
        onProgress?.('installing', vscode.l10n.t('No global write permissions — installing to user directory (~/.mysti/cli)...'), 30);

        const localResult = await this._installToLocalPrefix(installCommand, useLoginShell, signal);
        throwIfSetupCancelled(signal);
        if (localResult.success) {
          onProgress?.('installing', vscode.l10n.t('Verifying local installation...'), 65);

          const localDiscovery = await provider.discoverCli(true);
          throwIfSetupCancelled(signal);
          if (localDiscovery.found) {
            await this._recordInstall(providerId);
            return { success: true };
          }
        }

        // Local installation failed too; report recovery without claiming success.
        const suggestedFix = this._getSuggestedFix('permission', installCommand);
        return {
          success: false,
          error: vscode.l10n.t('No write permission to npm global directory and local install failed.'),
          requiresManual: true,
          errorCategory: 'permission',
          suggestedFix,
          errorDetails: localResult.error
        };
      }

      // Has global write access — proceed with normal global install
      onProgress?.('installing', vscode.l10n.t('Installing globally: {0}', installCommand), 30);
      const result = await this._retryableInstall(installCommand, useLoginShell, onProgress, signal);
      throwIfSetupCancelled(signal);

      if (!result.success) {
        // Permission error at runtime (edge case: pre-check passed but install still failed)
        if (result.errorCategory === 'permission') {
          console.log('[Mysti] SetupManager: Permission denied at runtime, trying user-local install...');
          onProgress?.('installing', vscode.l10n.t('Permission issue detected — installing to user directory...'), 50);

          const localResult = await this._installToLocalPrefix(installCommand, useLoginShell, signal);
          throwIfSetupCancelled(signal);
          if (localResult.success) {
            onProgress?.('installing', vscode.l10n.t('Verifying local installation...'), 65);

            const localDiscovery = await provider.discoverCli(true);
            throwIfSetupCancelled(signal);
            if (localDiscovery.found) {
              await this._recordInstall(providerId);
              return { success: true, attemptNumber: result.attemptNumber };
            }
          }
        }

        // Attach suggested fix
        result.suggestedFix = this._getSuggestedFix(
          result.errorCategory || 'command-failed',
          installCommand
        );
        result.requiresManual = true;
        return result;
      }

      onProgress?.('installing', vscode.l10n.t('Verifying installation...'), 70);

      // Verify installation
      const discovery = await provider.discoverCli(true);
      throwIfSetupCancelled(signal);
      if (!discovery.found) {
        return {
          success: false,
          error: vscode.l10n.t('Installation completed but CLI not found. You may need to restart your terminal or VS Code.'),
          requiresManual: true,
          errorCategory: 'command-failed',
          suggestedFix: vscode.l10n.t('Try restarting VS Code, or run the install command in a terminal and verify with: {0} --version', installCommand.split(' ').pop() || '')
        };
      }

      await this._recordInstall(providerId);
      return { success: true };
    } catch (error) {
      throwIfSetupCancelled(signal);
      const errorMessage = error instanceof Error ? error.message : vscode.l10n.t('Unknown error');
      return {
        success: false,
        error: vscode.l10n.t('Installation failed: {0}', errorMessage),
        requiresManual: true,
        errorCategory: 'unknown',
        suggestedFix: this._getSuggestedFix('unknown', installCommand)
      };
    }
  }

  /**
   * Attempt a user-local npm install as fallback when global install fails with permission error.
   * Installs to ~/.mysti/cli which is included in the shared search paths.
   */
  private async _installToLocalPrefix(
    originalCommand: string,
    useLoginShell: boolean,
    signal?: AbortSignal
  ): Promise<InstallResult> {
    throwIfSetupCancelled(signal);
    const homeDir = os.homedir();
    const localPrefix = path.join(homeDir, LOCAL_CLI_PREFIX);

    // Ensure the prefix directory exists
    try {
      fs.mkdirSync(localPrefix, { recursive: true });
    } catch (error) {
      return {
        success: false,
        error: `Cannot create directory ${localPrefix}: ${error instanceof Error ? error.message : 'unknown error'}`,
        errorCategory: 'permission'
      };
    }

    // Keep the global layout, but place it in the user's writable prefix.
    // Some CLIs (including Cline) do not expose a launcher in a local install.
    const quotedPrefix = process.platform === 'win32'
      ? `"${localPrefix}"`
      : "'" + localPrefix.replace(/'/g, "'\"'\"'") + "'";
    const localCommand = originalCommand.replace(/^(npm\s+(?:install|i))\s+/, `$1 --prefix ${quotedPrefix} `);

    console.log(`[Mysti] SetupManager: Trying local install: ${localCommand}`);

    const result = await this._runCommand(localCommand, INSTALL_TIMEOUT_MS, useLoginShell);

    if (result.success) {
      console.log(`[Mysti] SetupManager: Local install succeeded at ${localPrefix}`);
      return { success: true };
    }

    const category = this._classifyError(result.error || '', result.exitCode ?? null);
    return {
      success: false,
      error: result.error || 'Local installation failed',
      errorCategory: category,
      errorDetails: result.error
    };
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  /**
   * Run authentication command for a provider.
   * Opens a terminal for the user to complete auth interactively.
   */
  async authenticateProvider(providerId: string, signal?: AbortSignal): Promise<AuthStatus> {
    throwIfSetupCancelled(signal);
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        authenticated: false,
        error: vscode.l10n.t('Provider "{0}" not found', providerId)
      };
    }

    if (provider.configureAuthentication) {
      try {
        const result = await provider.configureAuthentication(signal);
        throwIfSetupCancelled(signal);
        return result;
      } finally {
        // A provider can commit credentials before validation fails or its
        // owner cancels. Never keep the previous account's cached status.
        this._discoveryService?.invalidate(providerId);
      }
    }

    if (providerId === 'openrouter' || providerId === 'localai') {
      await vscode.commands.executeCommand('workbench.action.openSettings', providerId === 'openrouter' ? 'mysti.openrouter.apiKey' : 'mysti.localaiEndpoint');
      throwIfSetupCancelled(signal);
      return { authenticated: false, error: 'Configure the provider connection in Settings, then refresh detection.' };
    }

    let authCommand = provider.getAuthCommand();
    const discovery = await provider.discoverCli();
    throwIfSetupCancelled(signal);
    if (discovery.path && path.isAbsolute(discovery.path)) {
      authCommand = authCommand.replace(/^\S+/, quoteSetupExecutable(discovery.path));
    }
    const executableDirs = [discovery.path, this._npmPath].filter((file): file is string => !!file && path.isAbsolute(file)).map(file => path.dirname(file));
    console.log(`[Mysti] SetupManager: Running auth command: ${authCommand}`);

    const terminal = vscode.window.createTerminal({
      name: `${provider.displayName} Authentication`,
      env: executableDirs.length ? { PATH: [...executableDirs, process.env.PATH || process.env.Path || ''].join(path.delimiter) } : undefined,
      shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
    });

    terminal.show();
    terminal.sendText(authCommand);

    // Auth state will change out-of-band (user completes the flow in the
    // terminal) — drop the cached status so subsequent reads re-probe.
    this._discoveryService?.invalidate(providerId);

    return {
      authenticated: false,
      error: vscode.l10n.t('Please complete authentication in the terminal window')
    };
  }

  /**
   * Authenticate with a specific method (for providers with multiple auth options)
   */
  async authenticateWithMethod(
    providerId: string,
    method: AuthMethodType,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<AuthStatus> {
    throwIfSetupCancelled(signal);
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        authenticated: false,
        error: vscode.l10n.t('Provider "{0}" not found', providerId)
      };
    }

    if (!this.getAuthOptions(providerId).some(option => option.action === method)) {
      return { authenticated: false, error: 'This authentication method is not supported by this provider.' };
    }
    if (method === 'api-key') {
      apiKey = apiKey?.trim() || (await showAuthenticationInput({
        title: `${provider.displayName} API key`, password: true, ignoreFocusOut: true,
        prompt: 'Enter your API key. This connection lasts until VS Code restarts.',
        validateInput: value => value.trim() ? undefined : 'Enter an API key.'
      }, signal))?.trim();
      throwIfSetupCancelled(signal);
      if (!apiKey) { return { authenticated: false, error: 'API-key entry cancelled. Choose a sign-in method to try again.' }; }
    }

    // Handle API key method
    if (method === 'api-key' && apiKey) {
      if (providerId === 'cursor') {
        // Save to VS Code settings for persistence + set env var for immediate use
        const config = vscode.workspace.getConfiguration('mysti');
        await config.update('cursorApiKey', apiKey, vscode.ConfigurationTarget.Global);
        throwIfSetupCancelled(signal);
        process.env['CURSOR_API_KEY'] = apiKey;
        console.log('[Mysti] SetupManager: Saved Cursor API key to settings and env');
      } else if (providerId === 'google-gemini') {
        process.env['GEMINI_API_KEY'] = apiKey;
        console.log('[Mysti] SetupManager: Set GEMINI_API_KEY for this session');
      } else {
        process.env['OPENAI_API_KEY'] = apiKey;
        console.log('[Mysti] SetupManager: Set OPENAI_API_KEY for this session');
      }

      // Auth mutation — drop the cached status so subsequent reads re-probe
      this._discoveryService?.invalidate(providerId);

      const authStatus = await provider.checkAuthentication();
      throwIfSetupCancelled(signal);
      return authStatus;
    }

    // For OAuth/CLI login, use the standard flow
    return this.authenticateProvider(providerId, signal);
  }

  // ============================================================================
  // Provider Setup Info & Auth Options
  // ============================================================================

  /**
   * Get provider info for manual setup instructions
   */
  getProviderSetupInfo(providerId: string): {
    installCommand: string;
    authCommand: string;
    authInstructions: string[];
    docsUrl?: string;
  } | null {
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return null;
    }

    const providerConfigs: Record<string, {
      docsUrl: string;
      authInstructions: string[];
    }> = {
      'openrouter': {
        docsUrl: 'https://openrouter.ai/keys',
        authInstructions: ['Create an OpenRouter API key, then enter it in Mysti settings: mysti.openrouter.apiKey.', 'No local CLI installation is required. Refresh detection after saving.']
      },
      'ollama': {
        docsUrl: 'https://ollama.com/download',
        authInstructions: ['Start Ollama and pull a model before chatting: ollama pull <model>', 'For a remote server, configure mysti.ollamaEndpoint in Settings. No account sign-in is required.']
      },
      'localai': {
        docsUrl: 'https://github.com/mudler/LocalAI/releases/latest',
        authInstructions: ['Start LocalAI using your chosen installation method and load a model.', 'Configure mysti.localaiEndpoint and, if required, mysti.localaiApiKey in Settings, then refresh detection.']
      },
      'claude-code': {
        docsUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
        authInstructions: [
          vscode.l10n.t('Run "claude auth login" in your terminal'),
          vscode.l10n.t('A browser window will open for authentication'),
          vscode.l10n.t('Sign in with your Anthropic account'),
          vscode.l10n.t('Return to VS Code once complete')
        ]
      },
      'openai-codex': {
        docsUrl: 'https://developers.openai.com/codex/cli',
        authInstructions: [
          'Option 1: Run "codex login" to sign in with ChatGPT account',
          'Option 2: Set OPENAI_API_KEY environment variable',
          'Requires ChatGPT Plus/Pro subscription or API credits'
        ]
      },
      'google-gemini': {
        docsUrl: 'https://geminicli.com/docs/get-started/authentication/',
        authInstructions: [
          'Option 1: Run "gemini" and sign in with your Google account',
          'Option 2: Set GEMINI_API_KEY environment variable',
          'Option 3: Configure Google Cloud credentials, GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION, then select Vertex AI in Gemini'
        ]
      },
      'cursor': {
        docsUrl: 'https://cursor.com/docs/cli/headless',
        authInstructions: [
          vscode.l10n.t('Option 1 (recommended): Run "agent login" to sign in with your Cursor account'),
          vscode.l10n.t('Option 2: Set CURSOR_API_KEY in VS Code settings (mysti.cursorApiKey) or as environment variable'),
          vscode.l10n.t('Get API keys at cursor.com/dashboard')
        ]
      }
    };

    const config = providerConfigs[providerId] || {
      docsUrl: undefined,
      authInstructions: [providerId === 'openrouter' ? provider.getAuthCommand() : `After installation, run: ${provider.getAuthCommand()}`]
    };

    return {
      installCommand: provider.getInstallCommand(),
      authCommand: provider.getAuthCommand(),
      authInstructions: config.authInstructions,
      docsUrl: config.docsUrl
    };
  }

  /**
   * Get auth options for providers with multiple authentication methods
   */
  getAuthOptions(providerId: string): AuthOption[] {
    if (providerId === 'google-gemini') {
      return [
        {
          id: 'oauth',
          label: vscode.l10n.t('Sign in with Google'),
          description: vscode.l10n.t('Use your Google account (recommended)'),
          icon: '🔐',
          action: 'oauth'
        },
        {
          id: 'api-key',
          label: vscode.l10n.t('API Key'),
          description: vscode.l10n.t('Use a Gemini API key from Google AI Studio'),
          icon: '🔑',
          action: 'api-key'
        },
        {
          id: 'vertex-ai',
          label: 'Vertex AI / Google Cloud',
          description: 'Configure Cloud credentials, project and location first, then select Vertex AI in the CLI',
          icon: '☁️',
          action: 'cli-login'
        }
      ];
    }

    if (providerId === 'openai-codex') {
      return [
        {
          id: 'oauth',
          label: vscode.l10n.t('Sign in with ChatGPT'),
          description: vscode.l10n.t('Use your ChatGPT Plus/Pro account'),
          icon: '🔐',
          action: 'oauth'
        },
        {
          id: 'api-key',
          label: vscode.l10n.t('API Key'),
          description: vscode.l10n.t('Use an OpenAI API key'),
          icon: '🔑',
          action: 'api-key'
        }
      ];
    }

    if (providerId === 'cursor') {
      return [
        {
          id: 'cli-login',
          label: vscode.l10n.t('Sign in with Cursor'),
          description: vscode.l10n.t('Use your Cursor account (recommended)'),
          icon: '🔷',
          action: 'cli-login'
        },
        {
          id: 'api-key',
          label: vscode.l10n.t('API Key'),
          description: vscode.l10n.t('Use a Cursor API key from cursor.com/dashboard'),
          icon: '🔑',
          action: 'api-key'
        }
      ];
    }

    return [];
  }

  // ============================================================================
  // Wizard Status
  // ============================================================================

  /**
   * Get detailed wizard status for all providers (enhanced for setup wizard).
   *
   * Plan 03 Phase 3a: reads through CliDiscoveryService — only stale/missing
   * cache entries are probed (in parallel). Falls back to direct serial
   * probing when no discovery service was injected (legacy/tests).
   */
  async getWizardStatus(): Promise<WizardStatusResult> {
    // Plan 03 Phase 2: provider init is backgrounded at activation. Wait for
    // it to settle so wizard status doesn't race the startup discovery probes.
    // Resolves immediately once background init has completed.
    await this._providerManager.whenReady;

    const npmAvailable = await this.checkNpmAvailable();
    const nodeVersion = await this._getNodeVersion();
    const providers: WizardProviderStatus[] = [];

    const statusById = new Map<string, CliStatus>();
    if (this._discoveryService) {
      for (const status of await this._discoveryService.getAllStatuses()) {
        statusById.set(status.providerId, status);
      }
    }

    for (const provider of this._providerManager.getAllProviders()) {
      const cached = statusById.get(provider.id);
      let installed: boolean;
      let authenticated: boolean;
      let cliVersion: string | undefined;

      if (cached) {
        installed = cached.found;
        authenticated = cached.authenticated;
        cliVersion = cached.version;
      } else {
        // Legacy path (no discovery service): probe directly.
        const discovery = await provider.discoverCli();
        installed = discovery.found;
        cliVersion = discovery.version;
        authenticated = false;
        if (discovery.found) {
          authenticated = (await provider.checkAuthentication()).authenticated;
        }
      }

      providers.push(this._toWizardProviderStatus(provider, installed, authenticated, cliVersion));
    }

    const anyReady = providers.some(p => p.installed);

    return {
      providers,
      npmAvailable,
      nodeVersion,
      anyReady
    };
  }

  /**
   * Immediately-available wizard status from the discovery cache — no
   * probing, no exec, no awaiting whenReady (Plan 03 Phase 3a). Stale cache
   * entries are served as-is (better than nothing); when any entry is
   * missing or expired, a single-flight background refresh is kicked off and
   * onWizardStatusUpdated fires once it completes.
   */
  getWizardStatusCached(): CachedWizardStatusResult {
    const status = this._buildCachedWizardStatus();
    if (!status.complete) {
      this._kickBackgroundWizardRefresh();
    }
    return status;
  }

  /** Read the retained status without scheduling discovery or tool probes. */
  private _buildCachedWizardStatus(): CachedWizardStatusResult {
    const providers: WizardProviderStatus[] = [];
    let complete = this._discoveryService !== undefined;

    for (const provider of this._providerManager.getAllProviders()) {
      const status = this._discoveryService?.peekStatus(provider.id);
      if (!status || !this._discoveryService?.isFresh(status)) {
        complete = false;
      }
      providers.push(this._toWizardProviderStatus(
        provider,
        status?.found ?? false,
        status?.authenticated ?? false,
        status?.version
      ));
    }

    return {
      providers,
      // Last-known values: never exec from this path. Defaults are optimistic
      // (npm assumed present) — the background refresh corrects them.
      npmAvailable: this._npmAvailable ?? true,
      nodeVersion: this._lastNodeVersion,
      anyReady: providers.some(p => p.installed),
      complete
    };
  }

  /**
   * Ensure one provider's discovery status is fresh — probes only that
   * provider on cache miss/expiry. Used for the active provider when a panel
   * opens (everything else rides the cache + background refresh).
   */
  async ensureProviderStatusFresh(providerId: string): Promise<CliStatus | undefined> {
    if (!this._discoveryService) {
      return undefined;
    }
    try {
      return await this._discoveryService.getStatus(providerId);
    } catch (error) {
      console.warn(`[Mysti] SetupManager: status probe failed for ${providerId}:`, error);
      return undefined;
    }
  }

  /** A post-upgrade check must bypass both discovery and provider probe caches. */
  async refreshProviderStatus(providerId: string): Promise<CliStatus | undefined> {
    const statuses = await this._discoveryService?.refresh(providerId);
    return statuses?.find(status => status.providerId === providerId);
  }

  /**
   * Force a full re-probe of every provider (manual refresh button). Resets
   * the npm cache, bypasses the discovery cache (and provider-side
   * probe-failure TTLs via force), then returns the rebuilt wizard status.
   */
  async refreshWizardStatus(): Promise<WizardStatusResult> {
    this.resetNpmCache();
    await this._discoveryService?.refresh();
    return this.getWizardStatus();
  }

  /**
   * Invalidate cached discovery status (one provider or all). Called from
   * install/auth mutation paths so the next read re-probes.
   */
  invalidateProviderStatus(providerId?: string): void {
    this._discoveryService?.invalidate(providerId);
  }

  private _toWizardProviderStatus(
    provider: ICliProvider,
    installed: boolean,
    authenticated: boolean,
    cliVersion?: string
  ): WizardProviderStatus {
    const setupInfo = this.getProviderSetupInfo(provider.id);
    return {
      providerId: provider.id,
      displayName: provider.displayName,
      installed,
      authenticated,
      cliVersion,
      installCommand: setupInfo?.installCommand || provider.getInstallCommand(),
      authCommand: setupInfo?.authCommand || provider.getAuthCommand(),
      authInstructions: setupInfo?.authInstructions || [],
      docsUrl: setupInfo?.docsUrl,
      supportsAutoInstall: provider.capabilities.supportsAutoInstall
    };
  }

  private _kickBackgroundWizardRefresh(): void {
    if (this._backgroundWizardRefresh) {
      return;
    }
    this._backgroundWizardRefresh = (async () => {
      try {
        // getWizardStatus awaits whenReady, then probes only stale/missing
        // entries through the discovery service.
        const status = await this.getWizardStatus();
        this._onWizardStatusUpdatedEmitter.fire(status);
      } catch (error) {
        console.error('[Mysti] SetupManager: background wizard status refresh failed:', error);
      } finally {
        this._backgroundWizardRefresh = null;
      }
    })();
  }

  private async _getNodeVersion(): Promise<string | undefined> {
    this._lastNodeVersion = (await this._checkNodeVersion()).version;
    return this._lastNodeVersion;
  }

  // ============================================================================
  // Diagnostics
  // ============================================================================

  private _diagnosticRun?: Promise<DiagnosticResult>;

  private async _diagnosticProbe<T>(task: Promise<T>, label: string, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out. Refresh detection or retry diagnostics after checking the provider.`)), Math.max(1, deadline - Date.now()));
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private async _diagnoseProvider(provider: ICliProvider): Promise<DiagnosticResult['providers'][number]> {
    const result: DiagnosticResult['providers'][number] = {
      id: provider.id, displayName: provider.displayName, installed: false, authenticated: false,
    };
    // A broken backend must not hold the entire diagnostic report indefinitely.
    // These reads do not own provider processes; the timeout only bounds waiting.
    const deadline = Date.now() + 15_000;
    try {
      const discovery = await this._diagnosticProbe(provider.discoverCli(), `${provider.displayName} discovery`, deadline);
      result.installed = discovery.found;
      result.path = discovery.path;
      result.version = discovery.version;
      if (discovery.found) {
        const auth = await this._diagnosticProbe(provider.checkAuthentication(), `${provider.displayName} authentication`, deadline);
        result.authenticated = auth.authenticated;
        if (!auth.authenticated) { result.error = auth.error; }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  /**
   * Run comprehensive diagnostics for troubleshooting install issues.
   * Collects platform info, npm/node status, provider statuses, and network check.
   */
  async runDiagnostics(): Promise<DiagnosticResult> {
    if (!this._diagnosticRun) {
      const run = this._runDiagnostics().finally(() => {
        if (this._diagnosticRun === run) { this._diagnosticRun = undefined; }
      });
      this._diagnosticRun = run;
    }
    return this._diagnosticRun;
  }

  private async _runDiagnostics(): Promise<DiagnosticResult> {
    const platformTask = getPlatformInfo();
    // Provider checks are independent of npm and already carry a shared per-provider deadline.
    const providersTask = Promise.all(this._providerManager.getAllProviders()
      .map(provider => this._diagnoseProvider(provider)));
    const npmAvailable = await this.checkNpmAvailable();
    const env = { ...process.env };
    const npm = this._npmPath && path.isAbsolute(this._npmPath)
      ? this._npmPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (path.isAbsolute(npm)) {
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = path.dirname(npm) + path.delimiter + (env[pathKey] || '');
    }
    const loginShell = this._npmUsesLoginShell && process.platform !== 'win32';
    const shell = process.env.SHELL || '/bin/bash';
    const probeNpm = (args: string[]) => !npmAvailable ? Promise.resolve(undefined)
      : loginShell ? probeCliOutput(shell, ['-l', '-c', `npm ${args.join(' ')}`], 5000, env)
      : probeCliOutput(npm, args, 5000, env);
    const npmPathTask = !npmAvailable ? Promise.resolve(undefined)
      : path.isAbsolute(npm) ? Promise.resolve(npm)
      : loginShell ? probeCliOutput(shell, ['-l', '-c', 'command -v npm'], 5000, env)
      : resolveCommandOnPath(npm, env);
    const [platformInfo, providers, versionOutput, prefixOutput, npmPath, nodeCheck, networkReachable] = await Promise.all([
      platformTask, providersTask, probeNpm(['--version']), probeNpm(['config', 'get', 'prefix']), npmPathTask,
      this._checkNodeVersion(), npmAvailable ? this.checkNetworkConnectivity() : Promise.resolve(false),
    ]);
    const npmVersion = versionOutput?.split(/\r?\n/).map(line => line.trim())
      .find(line => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(line));
    const npmPrefix = prefixOutput?.split(/\r?\n/).map(line => line.trim()).find(line => path.isAbsolute(line));
    let npmWritable = false;
    if (npmPrefix) {
      try {
        const globalDir = process.platform === 'win32'
          ? path.join(npmPrefix, 'node_modules') : path.join(npmPrefix, 'lib', 'node_modules');
        fs.accessSync(fs.existsSync(globalDir) ? globalDir : npmPrefix, fs.constants.W_OK);
        npmWritable = true;
      } catch { /* Preserve a failed selected-prefix permission check in the report. */ }
    }

    // Generate recommendations
    const recommendations: string[] = [];

    if (!nodeCheck.meets) {
      recommendations.push(vscode.l10n.t('Install Node.js {0}+ from nodejs.org', MIN_NODE_VERSION));
    }
    if (!npmAvailable) {
      recommendations.push(vscode.l10n.t('Install npm (comes with Node.js from nodejs.org)'));
    }
    if (npmAvailable && !npmWritable) {
      recommendations.push(vscode.l10n.t('Fix npm permissions: npm config set prefix ~/.npm-global'));
    }
    if (!networkReachable) {
      recommendations.push(vscode.l10n.t('Check internet connection - cannot reach npm registry'));
    }
    if (providers.every(p => !p.installed && !p.error)) {
      recommendations.push(vscode.l10n.t('No CLI providers installed. Install at least one to get started.'));
    }
    if (providers.some(p => p.installed && !p.authenticated)) {
      const unauthenticated = providers
        .filter(p => p.installed && !p.authenticated)
        .map(p => p.displayName);
      recommendations.push(vscode.l10n.t('Authenticate: {0}', unauthenticated.join(', ')));
    }

    return {
      timestamp: Date.now(),
      platform: {
        os: platformInfo.os,
        arch: platformInfo.arch,
        shell: platformInfo.shell,
        hasNvm: platformInfo.hasNvm,
      },
      npmStatus: {
        available: npmAvailable,
        path: npmPath?.trim() || undefined,
        version: npmVersion,
        prefix: npmPrefix || undefined,
        canWriteGlobalDir: npmWritable,
      },
      nodeStatus: {
        available: !!nodeCheck.version,
        version: nodeCheck.version,
        meetsMinimum: nodeCheck.meets,
      },
      providers,
      networkReachable,
      recommendations,
    };
  }

  // ============================================================================
  // Internal Helpers
  // ============================================================================

  /**
   * Run a command and return the result
   */
  private async _runCommand(
    command: string,
    timeout: number = 60000,
    useLoginShell: boolean = false
  ): Promise<{ success: boolean; output?: string; error?: string; exitCode?: number }> {
    return new Promise((resolve) => {
      let proc;
      // GUI-launched editors may discover npm outside PATH. Include its sibling
      // node binary too: npm's shebang uses /usr/bin/env node on Unix.
      const env = { ...process.env, npm_config_engine_strict: 'true' } as NodeJS.ProcessEnv;
      if (this._npmPath && path.isAbsolute(this._npmPath)) {
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
        env[pathKey] = path.dirname(this._npmPath) + path.delimiter + (env[pathKey] || '');
      }

      if (useLoginShell && process.platform !== 'win32') {
        const shell = process.env.SHELL || '/bin/bash';
        proc = spawn(shell, ['-l', '-c', command], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          env
        });
        console.log(`[Mysti] SetupManager: Running command with login shell: ${command}`);
      } else {
        proc = spawn(command, [], {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          env
        });
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      proc.stdout?.on('data', (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-1024 * 1024);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-1024 * 1024);
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        // Finish stopping npm and its lifecycle-script children before a retry.
        void killProcessTree(proc, 1000, { label: 'Installer', useProcessGroup: process.platform !== 'win32', initialSignal: 'SIGKILL' }).finally(() => {
          resolve({ success: false, error: 'Command timed out', exitCode: undefined });
        });
      }, timeout);

      proc.on('close', (code: number | null) => {
        clearTimeout(timeoutId);
        if (timedOut) { return; }
        if (code === 0) {
          resolve({ success: true, output: stdout, exitCode: 0 });
        } else {
          resolve({
            success: false,
            error: stderr || `Command exited with code ${code}`,
            exitCode: code ?? undefined
          });
        }
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: err.message,
          exitCode: undefined
        });
      });
    });
  }

  /**
   * Install mutated CLI state: drop the cached status (so an older in-flight
   * probe cannot write "not found" over it), then re-probe at once — that
   * probe flipping the status is what tells the panels. Merely invalidating
   * waited for someone else's read.
   */
  private async _recordInstall(providerId: string): Promise<void> {
    this._discoveryService?.invalidate(providerId);
    await this._discoveryService?.refresh(providerId);
  }

  /**
   * An install the user runs in a terminal (or a download page) ends where
   * Mysti cannot see it, so re-probe that one CLI until it appears; the probe
   * flipping it is what updates the panels. Stops once found, when the
   * terminal closes (after one last look), or after ten minutes. A not-found
   * probe is a PATH lookup — it skips the auth check.
   * ponytail: fixed 5s poll; VS Code's onDidEndTerminalShellExecution could
   * replace it once the engine floor reaches 1.93.
   */
  watchForInstall(providerId: string, terminal?: vscode.Terminal, intervalMs = 5000, timeoutMs = 10 * 60_000): void {
    this._installWatchers.get(providerId)?.();
    const discovery = this._discoveryService;
    if (!discovery) { return; }
    const deadline = Date.now() + timeoutMs;
    let busy = false, stopped = false;
    const check = async (): Promise<void> => {
      if (busy || stopped) { return; }
      busy = true;
      try {
        const [status] = await discovery.refresh(providerId).catch(() => []);
        if (status?.found || Date.now() > deadline) { stop(); }
      } finally { busy = false; }
    };
    const timer = setInterval(() => { void check(); }, intervalMs);
    const closed = vscode.window.onDidCloseTerminal((t) => {
      if (terminal && t === terminal) { stop(); void discovery.refresh(providerId).catch(() => []); }
    });
    const stop = (): void => {
      stopped = true;
      clearInterval(timer);
      closed.dispose();
      if (this._installWatchers.get(providerId) === stop) { this._installWatchers.delete(providerId); }
    };
    this._installWatchers.set(providerId, stop);
  }

  /**
   * Reset npm availability cache (for refresh detection).
   * Also invalidates the CLI discovery cache so the next status read
   * re-probes every provider (manual refresh semantics).
   */
  resetNpmCache(): void {
    this._npmAvailable = null;
    this._npmPath = null;
    this._npmCacheExpiry = 0;
    resetPlatformInfoCache();
    this._discoveryService?.invalidate();
  }
}
