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
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import type { ProviderManager } from './ProviderManager';
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
import { getPlatformInfo, canWriteNpmGlobalDir, getNpmPrefix, resetPlatformInfoCache } from '../utils/platform';

const execAsync = promisify(exec);

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
  private _npmCacheExpiry: number = 0;

  constructor(context: vscode.ExtensionContext, providerManager: ProviderManager) {
    this._extensionContext = context;
    this._providerManager = providerManager;
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
    try {
      await execAsync('npm --version');
      return true;
    } catch {
      return false;
    }
  }

  private async _checkNpmInNvmPaths(): Promise<string | null> {
    const homeDir = os.homedir();
    const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');

    const pathsToCheck = [
      path.join(nvmDir, 'current', 'bin', 'npm'),
      path.join(homeDir, '.npm-global', 'bin', 'npm'),
      path.join(homeDir, '.local', 'bin', 'npm'),
      '/usr/local/bin/npm',
      '/opt/homebrew/bin/npm',
    ];

    for (const npmPath of pathsToCheck) {
      try {
        fs.accessSync(npmPath, fs.constants.X_OK);
        await execAsync(`"${npmPath}" --version`);
        console.log(`[Mysti] SetupManager: Found npm at ${npmPath}`);
        return npmPath;
      } catch {
        // Continue to next path
      }
    }

    // Check NVM versions directory for installed Node versions
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      try {
        const versions = fs.readdirSync(versionsDir)
          .filter(v => v.startsWith('v'))
          .sort()
          .reverse();

        for (const version of versions) {
          const npmPath = path.join(versionsDir, version, 'bin', 'npm');
          try {
            fs.accessSync(npmPath, fs.constants.X_OK);
            await execAsync(`"${npmPath}" --version`);
            console.log(`[Mysti] SetupManager: Found npm in NVM version ${version}`);
            return npmPath;
          } catch {
            // Continue to next version
          }
        }
      } catch {
        // Ignore directory read errors
      }
    }

    return null;
  }

  private async _checkNpmViaLoginShell(): Promise<boolean> {
    if (process.platform === 'win32') {
      return false;
    }

    try {
      const shell = process.env.SHELL || '/bin/bash';
      const command = `${shell} -l -c "npm --version"`;
      await execAsync(command, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
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
      'permission': `No write permission to npm global directory. Mysti installed to ~/.mysti/cli instead.\n\nTo install globally, either:\n\u2022 Run with sudo: sudo ${installCommand}\n\u2022 Fix npm permissions: npm config set prefix ~/.npm-global\n\u2022 See https://docs.npmjs.com/resolving-eacces-permissions-errors`,
      'network': 'Check your internet connection and proxy settings. If behind a firewall, try: npm config list to verify proxy settings.',
      'version': `Node.js ${MIN_NODE_VERSION}+ is required. Visit nodejs.org to install the latest LTS version, or run: nvm install --lts`,
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
      const { stdout } = await execAsync('node --version');
      const version = stdout.trim();
      // Parse major version from "v18.17.0" format
      const match = version.match(/^v?(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        if (major < MIN_NODE_VERSION) {
          return {
            meets: false,
            version,
            error: `Node.js ${MIN_NODE_VERSION}+ required, found ${version}`
          };
        }
        return { meets: true, version };
      }
      return { meets: true, version };
    } catch {
      return { meets: false, error: 'Node.js is not installed' };
    }
  }

  // ============================================================================
  // Network Connectivity Check
  // ============================================================================

  /**
   * Check if npm registry is reachable
   */
  async checkNetworkConnectivity(): Promise<boolean> {
    try {
      await execAsync('npm ping', { timeout: NETWORK_CHECK_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
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
    onProgress?: (step: string, message: string, progress?: number) => void
  ): Promise<InstallResult> {
    for (let attempt = 1; attempt <= INSTALL_MAX_RETRIES; attempt++) {
      const result = await this._runCommand(command, INSTALL_TIMEOUT_MS, useLoginShell);

      if (result.success) {
        return { success: true, attemptNumber: attempt };
      }

      const category = this._classifyError(result.error || '', result.exitCode ?? null);

      // Only retry transient failures
      if (!['network', 'timeout'].includes(category) || attempt >= INSTALL_MAX_RETRIES) {
        return {
          success: false,
          error: result.error || 'Installation failed',
          errorCategory: category,
          errorDetails: result.error,
          retryable: ['network', 'timeout'].includes(category),
          attemptNumber: attempt
        };
      }

      console.log(`[Mysti] SetupManager: Attempt ${attempt} failed (${category}), retrying in ${INSTALL_RETRY_DELAY_MS / 1000}s...`);
      onProgress?.('installing', `Attempt ${attempt} failed, retrying...`, 35);
      await this._delay(INSTALL_RETRY_DELAY_MS);
    }

    return {
      success: false,
      error: 'Installation failed after multiple attempts',
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
    const statuses: ProviderSetupStatus[] = [];

    for (const provider of this._providerManager.getAllProviders()) {
      const discovery = await provider.discoverCli();
      let authenticated = false;

      if (discovery.found) {
        const authStatus = await provider.checkAuthentication();
        authenticated = authStatus.authenticated;
      }

      statuses.push({
        providerId: provider.id,
        displayName: provider.displayName,
        installed: discovery.found,
        authenticated
      });
    }

    return statuses;
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
    onProgress?: (step: string, message: string, progress?: number) => void
  ): Promise<SetupResult> {
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        success: false,
        installed: false,
        authenticated: false,
        error: `Provider "${providerId}" not found`
      };
    }

    // Step 1: Check Node.js version
    onProgress?.('checking', 'Checking system requirements...', 5);
    const nodeCheck = await this._checkNodeVersion();
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

    // Step 2: Check if already installed
    onProgress?.('checking', 'Checking CLI installation...', 10);
    const discovery = await provider.discoverCli();

    if (!discovery.found) {
      // Step 3: Try to auto-install
      onProgress?.('installing', `Installing ${provider.displayName} CLI...`, 20);
      const installResult = await this.autoInstallCli(providerId, onProgress);

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
    onProgress?.('authenticating', 'Checking authentication...', 80);
    const authStatus = await provider.checkAuthentication();

    if (!authStatus.authenticated) {
      return {
        success: false,
        installed: true,
        authenticated: false,
        error: authStatus.error,
        requiresManualStep: 'auth'
      };
    }

    onProgress?.('ready', `${provider.displayName} is ready!`, 100);
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
    onProgress?: (step: string, message: string, progress?: number) => void
  ): Promise<InstallResult> {
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        success: false,
        error: `Provider "${providerId}" not found`,
        errorCategory: 'unknown'
      };
    }

    // Guard: reject auto-install for providers that require interactive setup
    if (!provider.capabilities.supportsAutoInstall) {
      console.log(`[Mysti] SetupManager: Provider "${providerId}" does not support auto-install, requires manual setup`);
      return {
        success: false,
        error: `${provider.displayName} requires interactive setup and cannot be installed automatically. Please use the manual installation instructions.`,
        requiresManual: true,
        errorCategory: 'command-failed'
      };
    }

    const installCommand = provider.getInstallCommand();

    // Check npm availability
    onProgress?.('installing', 'Verifying npm availability...', 15);
    const npmAvailable = await this.checkNpmAvailable();
    if (!npmAvailable) {
      const suggestedFix = this._getSuggestedFix('not-found', installCommand);
      return {
        success: false,
        error: 'npm is not available. Install Node.js from nodejs.org or use nvm.',
        requiresManual: true,
        errorCategory: 'not-found',
        suggestedFix
      };
    }

    // Check network connectivity
    onProgress?.('installing', 'Verifying network connectivity...', 20);
    const networkOk = await this.checkNetworkConnectivity();
    if (!networkOk) {
      const suggestedFix = this._getSuggestedFix('network', installCommand);
      return {
        success: false,
        error: 'Cannot reach npm registry. Check your internet connection.',
        requiresManual: false,
        errorCategory: 'network',
        suggestedFix,
        retryable: true
      };
    }

    console.log(`[Mysti] SetupManager: Running install command: ${installCommand}`);

    try {
      const useLoginShell = this._npmPath === 'npm' && !(await this._checkNpmDirect());

      // Pre-flight permission check: detect if npm global dir is writable BEFORE attempting install
      onProgress?.('installing', 'Checking write permissions to npm global directory...', 25);
      const hasGlobalWriteAccess = await canWriteNpmGlobalDir();

      if (!hasGlobalWriteAccess) {
        // Skip global install entirely — go straight to local install (saves 2-120s)
        console.log('[Mysti] SetupManager: No write access to npm global directory, installing locally');
        onProgress?.('installing', 'No global write permissions \u2014 installing to user directory (~/.mysti/cli)...', 30);

        const localResult = await this._installToLocalPrefix(installCommand, useLoginShell);
        if (localResult.success) {
          onProgress?.('installing', 'Verifying local installation...', 65);

          const localDiscovery = await provider.discoverCli();
          if (localDiscovery.found) {
            return { success: true };
          }
        }

        // Local install failed too — show error with sudo instructions
        const suggestedFix = this._getSuggestedFix('permission', installCommand);
        return {
          success: false,
          error: 'No write permission to npm global directory and local install failed.',
          requiresManual: true,
          errorCategory: 'permission',
          suggestedFix,
          errorDetails: localResult.error
        };
      }

      // Has global write access — proceed with normal global install
      onProgress?.('installing', `Installing globally: ${installCommand}`, 30);
      const result = await this._retryableInstall(installCommand, useLoginShell, onProgress);

      if (!result.success) {
        // Permission error at runtime (edge case: pre-check passed but install still failed)
        if (result.errorCategory === 'permission') {
          console.log('[Mysti] SetupManager: Permission denied at runtime, trying user-local install...');
          onProgress?.('installing', 'Permission issue detected \u2014 installing to user directory...', 50);

          const localResult = await this._installToLocalPrefix(installCommand, useLoginShell);
          if (localResult.success) {
            onProgress?.('installing', 'Verifying local installation...', 65);

            const localDiscovery = await provider.discoverCli();
            if (localDiscovery.found) {
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

      onProgress?.('installing', 'Verifying installation...', 70);

      // Verify installation
      const discovery = await provider.discoverCli();
      if (!discovery.found) {
        return {
          success: false,
          error: 'Installation completed but CLI not found. You may need to restart your terminal or VS Code.',
          requiresManual: true,
          errorCategory: 'command-failed',
          suggestedFix: 'Try restarting VS Code, or run the install command in a terminal and verify with: ' + installCommand.split(' ').pop() + ' --version'
        };
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Installation failed: ${errorMessage}`,
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
    useLoginShell: boolean
  ): Promise<InstallResult> {
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

    // Transform "npm install -g <pkg>" -> "npm install --prefix ~/.mysti/cli <pkg>"
    const localCommand = originalCommand
      .replace(/\s+-g\s+/, ` --prefix "${localPrefix}" `)
      .replace(/\s+--global\s+/, ` --prefix "${localPrefix}" `);

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
  async authenticateProvider(providerId: string): Promise<AuthStatus> {
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        authenticated: false,
        error: `Provider "${providerId}" not found`
      };
    }

    const authCommand = provider.getAuthCommand();
    console.log(`[Mysti] SetupManager: Running auth command: ${authCommand}`);

    const terminal = vscode.window.createTerminal({
      name: `${provider.displayName} Authentication`,
      shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
    });

    terminal.show();
    terminal.sendText(authCommand);

    return {
      authenticated: false,
      error: 'Please complete authentication in the terminal window'
    };
  }

  /**
   * Authenticate with a specific method (for providers with multiple auth options)
   */
  async authenticateWithMethod(
    providerId: string,
    method: AuthMethodType,
    apiKey?: string
  ): Promise<AuthStatus> {
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        authenticated: false,
        error: `Provider "${providerId}" not found`
      };
    }

    // Handle GCA method for Gemini
    if (method === 'gca' && providerId === 'google-gemini') {
      process.env['GOOGLE_GENAI_USE_GCA'] = 'true';
      console.log('[Mysti] SetupManager: Set GOOGLE_GENAI_USE_GCA=true');

      const terminal = vscode.window.createTerminal({
        name: 'Gemini GCA Setup',
        shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
      });
      terminal.show();
      terminal.sendText('echo "Adding GOOGLE_GENAI_USE_GCA=true to your shell profile..."');
      terminal.sendText('echo \'export GOOGLE_GENAI_USE_GCA=true\' >> ~/.zshrc');
      terminal.sendText('echo "Done! Run \'source ~/.zshrc\' or restart your terminal."');

      const authStatus = await provider.checkAuthentication();
      return authStatus;
    }

    // Handle API key method
    if (method === 'api-key' && apiKey) {
      if (providerId === 'cursor') {
        // Save to VS Code settings for persistence + set env var for immediate use
        const config = vscode.workspace.getConfiguration('mysti');
        await config.update('cursorApiKey', apiKey, vscode.ConfigurationTarget.Global);
        process.env['CURSOR_API_KEY'] = apiKey;
        console.log('[Mysti] SetupManager: Saved Cursor API key to settings and env');
      } else if (providerId === 'google-gemini') {
        process.env['GEMINI_API_KEY'] = apiKey;
        console.log('[Mysti] SetupManager: Set GEMINI_API_KEY for this session');
      } else {
        process.env['OPENAI_API_KEY'] = apiKey;
        console.log('[Mysti] SetupManager: Set OPENAI_API_KEY for this session');
      }

      const authStatus = await provider.checkAuthentication();
      return authStatus;
    }

    // For OAuth/CLI login, use the standard flow
    return this.authenticateProvider(providerId);
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
      'claude-code': {
        docsUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
        authInstructions: [
          'Run "claude auth login" in your terminal',
          'A browser window will open for authentication',
          'Sign in with your Anthropic account',
          'Return to VS Code once complete'
        ]
      },
      'openai-codex': {
        docsUrl: 'https://platform.openai.com/docs/guides/codex',
        authInstructions: [
          'Option 1: Run "codex auth login" to sign in with ChatGPT account',
          'Option 2: Set OPENAI_API_KEY environment variable',
          'Requires ChatGPT Plus/Pro subscription or API credits'
        ]
      },
      'google-gemini': {
        docsUrl: 'https://ai.google.dev/gemini-api/docs/aistudio-quickstart',
        authInstructions: [
          'Option 1: Run "gemini" and sign in with your Google account',
          'Option 2: Set GEMINI_API_KEY environment variable',
          'Option 3: Set GOOGLE_GENAI_USE_GCA=true for Google Cloud subscribers'
        ]
      },
      'cursor': {
        docsUrl: 'https://cursor.com/docs/cli/headless',
        authInstructions: [
          'Option 1 (recommended): Run "agent login" to sign in with your Cursor account',
          'Option 2: Set CURSOR_API_KEY in VS Code settings (mysti.cursorApiKey) or as environment variable',
          'Get API keys at cursor.com/dashboard'
        ]
      }
    };

    const config = providerConfigs[providerId] || {
      docsUrl: undefined,
      authInstructions: ['Run the authentication command shown above']
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
          label: 'Sign in with Google',
          description: 'Use your Google account (recommended)',
          icon: '🔐',
          action: 'oauth'
        },
        {
          id: 'api-key',
          label: 'API Key',
          description: 'Use a Gemini API key from Google AI Studio',
          icon: '🔑',
          action: 'api-key'
        },
        {
          id: 'gca',
          label: 'Google Cloud Auth (GCA)',
          description: 'Use Application Default Credentials for Cloud subscribers',
          icon: '☁️',
          action: 'gca'
        }
      ];
    }

    if (providerId === 'openai-codex') {
      return [
        {
          id: 'oauth',
          label: 'Sign in with ChatGPT',
          description: 'Use your ChatGPT Plus/Pro account',
          icon: '🔐',
          action: 'oauth'
        },
        {
          id: 'api-key',
          label: 'API Key',
          description: 'Use an OpenAI API key',
          icon: '🔑',
          action: 'api-key'
        }
      ];
    }

    if (providerId === 'cursor') {
      return [
        {
          id: 'cli-login',
          label: 'Sign in with Cursor',
          description: 'Use your Cursor account (recommended)',
          icon: '🔷',
          action: 'cli-login'
        },
        {
          id: 'api-key',
          label: 'API Key',
          description: 'Use a Cursor API key from cursor.com/dashboard',
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
   * Get detailed wizard status for all providers (enhanced for setup wizard)
   */
  async getWizardStatus(): Promise<{
    providers: WizardProviderStatus[];
    npmAvailable: boolean;
    nodeVersion?: string;
    anyReady: boolean;
  }> {
    const npmAvailable = await this.checkNpmAvailable();
    const nodeVersion = await this._getNodeVersion();
    const providers: WizardProviderStatus[] = [];

    for (const provider of this._providerManager.getAllProviders()) {
      const discovery = await provider.discoverCli();
      let authenticated = false;

      if (discovery.found) {
        const authStatus = await provider.checkAuthentication();
        authenticated = authStatus.authenticated;
      }

      const setupInfo = this.getProviderSetupInfo(provider.id);

      providers.push({
        providerId: provider.id,
        displayName: provider.displayName,
        installed: discovery.found,
        authenticated,
        cliVersion: discovery.version,
        installCommand: setupInfo?.installCommand || provider.getInstallCommand(),
        authCommand: setupInfo?.authCommand || provider.getAuthCommand(),
        authInstructions: setupInfo?.authInstructions || [],
        docsUrl: setupInfo?.docsUrl,
        supportsAutoInstall: provider.capabilities.supportsAutoInstall
      });
    }

    const anyReady = providers.some(p => p.installed);

    return {
      providers,
      npmAvailable,
      nodeVersion,
      anyReady
    };
  }

  private async _getNodeVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('node --version');
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  // ============================================================================
  // Diagnostics
  // ============================================================================

  /**
   * Run comprehensive diagnostics for troubleshooting install issues.
   * Collects platform info, npm/node status, provider statuses, and network check.
   */
  async runDiagnostics(): Promise<DiagnosticResult> {
    const platformInfo = await getPlatformInfo();
    const npmAvailable = await this.checkNpmAvailable();
    const npmPrefix = await getNpmPrefix();
    const npmWritable = await canWriteNpmGlobalDir();

    const nodeCheck = await this._checkNodeVersion();
    const networkReachable = await this.checkNetworkConnectivity();

    // Check all providers
    const providers: DiagnosticResult['providers'] = [];
    for (const provider of this._providerManager.getAllProviders()) {
      const discovery = await provider.discoverCli();
      let authenticated = false;
      let authError: string | undefined;

      if (discovery.found) {
        const authStatus = await provider.checkAuthentication();
        authenticated = authStatus.authenticated;
        if (!authenticated) {
          authError = authStatus.error;
        }
      }

      providers.push({
        id: provider.id,
        displayName: provider.displayName,
        installed: discovery.found,
        version: discovery.version,
        authenticated,
        error: authError
      });
    }

    // Generate recommendations
    const recommendations: string[] = [];

    if (!nodeCheck.meets) {
      recommendations.push(`Install Node.js ${MIN_NODE_VERSION}+ from nodejs.org`);
    }
    if (!npmAvailable) {
      recommendations.push('Install npm (comes with Node.js from nodejs.org)');
    }
    if (npmAvailable && !npmWritable) {
      recommendations.push('Fix npm permissions: npm config set prefix ~/.npm-global');
    }
    if (!networkReachable) {
      recommendations.push('Check internet connection - cannot reach npm registry');
    }
    if (providers.every(p => !p.installed)) {
      recommendations.push('No CLI providers installed. Install at least one to get started.');
    }
    if (providers.some(p => p.installed && !p.authenticated)) {
      const unauthenticated = providers
        .filter(p => p.installed && !p.authenticated)
        .map(p => p.displayName);
      recommendations.push(`Authenticate: ${unauthenticated.join(', ')}`);
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
        version: platformInfo.npmVersion || undefined,
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

      if (useLoginShell && process.platform !== 'win32') {
        const shell = process.env.SHELL || '/bin/bash';
        proc = spawn(shell, ['-l', '-c', command], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        console.log(`[Mysti] SetupManager: Running command with login shell: ${command}`);
      } else {
        proc = spawn(command, [], {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      }

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        proc.kill();
        resolve({
          success: false,
          error: 'Command timed out',
          exitCode: undefined
        });
      }, timeout);

      proc.on('close', (code: number | null) => {
        clearTimeout(timeoutId);
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
   * Reset npm availability cache (for refresh detection)
   */
  resetNpmCache(): void {
    this._npmAvailable = null;
    this._npmPath = null;
    this._npmCacheExpiry = 0;
    resetPlatformInfoCache();
  }
}
