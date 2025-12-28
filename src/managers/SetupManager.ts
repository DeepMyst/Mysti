/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
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
  AuthStatus,
  WizardProviderStatus,
  AuthOption,
  AuthMethodType
} from '../types';

const execAsync = promisify(exec);

/**
 * SetupManager orchestrates the CLI setup flow for AI providers.
 *
 * Responsibilities:
 * - Check if any provider CLI is installed and ready
 * - Auto-install CLI via npm when possible
 * - Guide users through authentication
 * - Provide fallback manual instructions when needed
 */
export class SetupManager {
  private _extensionContext: vscode.ExtensionContext;
  private _providerManager: ProviderManager;
  private _npmAvailable: boolean | null = null;
  private _npmPath: string | null = null;

  constructor(context: vscode.ExtensionContext, providerManager: ProviderManager) {
    this._extensionContext = context;
    this._providerManager = providerManager;
  }

  /**
   * Check if npm is available on the system
   * Uses multiple detection methods to handle NVM and other non-standard installs
   */
  async checkNpmAvailable(): Promise<boolean> {
    if (this._npmAvailable !== null) {
      return this._npmAvailable;
    }

    // Method 1: Direct exec (works for standard PATH-based installs)
    if (await this._checkNpmDirect()) {
      this._npmAvailable = true;
      this._npmPath = 'npm';
      console.log('[Mysti] SetupManager: npm found via direct exec');
      return true;
    }

    // Method 2: Check common NVM paths directly
    const nvmPath = await this._checkNpmInNvmPaths();
    if (nvmPath) {
      this._npmAvailable = true;
      this._npmPath = nvmPath;
      console.log(`[Mysti] SetupManager: npm found at: ${nvmPath}`);
      return true;
    }

    // Method 3: Login shell execution (inherits .bashrc/.zshrc initialization)
    if (await this._checkNpmViaLoginShell()) {
      this._npmAvailable = true;
      this._npmPath = 'npm'; // Will use login shell for execution
      console.log('[Mysti] SetupManager: npm found via login shell');
      return true;
    }

    this._npmAvailable = false;
    console.log('[Mysti] SetupManager: npm not available');
    return false;
  }

  /**
   * Get the npm executable path (useful for running npm commands)
   */
  getNpmPath(): string | null {
    return this._npmPath;
  }

  /**
   * Direct npm --version check (original method, fast path)
   */
  private async _checkNpmDirect(): Promise<boolean> {
    try {
      await execAsync('npm --version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check common NVM installation paths directly
   */
  private async _checkNpmInNvmPaths(): Promise<string | null> {
    const homeDir = os.homedir();
    const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');

    // Check paths in order of likelihood
    const pathsToCheck = [
      // NVM current symlink (most common)
      path.join(nvmDir, 'current', 'bin', 'npm'),
      // Common user-local paths
      path.join(homeDir, '.npm-global', 'bin', 'npm'),
      path.join(homeDir, '.local', 'bin', 'npm'),
      // System paths
      '/usr/local/bin/npm',
      '/opt/homebrew/bin/npm',
    ];

    for (const npmPath of pathsToCheck) {
      try {
        fs.accessSync(npmPath, fs.constants.X_OK);
        // Verify it actually works
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
          .reverse(); // Latest first

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

  /**
   * Check npm via login shell (inherits NVM initialization from shell rc files)
   */
  private async _checkNpmViaLoginShell(): Promise<boolean> {
    if (process.platform === 'win32') {
      // Windows doesn't have the same shell initialization issues
      return false;
    }

    try {
      // Determine user's default shell
      const shell = process.env.SHELL || '/bin/bash';

      // Use login shell (-l) to load initialization files (.bashrc, .zshrc, etc.)
      // These files typically contain NVM initialization
      const command = `${shell} -l -c "npm --version"`;

      await execAsync(command, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

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

  /**
   * Run the full setup flow for a provider
   * Returns immediately if provider is already ready
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

    // Step 1: Check if already installed
    onProgress?.('checking', 'Checking CLI installation...', 10);
    const discovery = await provider.discoverCli();

    if (!discovery.found) {
      // Step 2: Try to auto-install
      onProgress?.('installing', `Installing ${provider.displayName} CLI...`, 30);
      const installResult = await this.autoInstallCli(providerId, onProgress);

      if (!installResult.success) {
        return {
          success: false,
          installed: false,
          authenticated: false,
          error: installResult.error,
          requiresManualStep: 'install'
        };
      }
    }

    // Step 3: Check authentication
    onProgress?.('authenticating', 'Checking authentication...', 70);
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
   * Auto-install CLI via npm
   */
  async autoInstallCli(
    providerId: string,
    onProgress?: (step: string, message: string, progress?: number) => void
  ): Promise<InstallResult> {
    // Check npm availability
    const npmAvailable = await this.checkNpmAvailable();
    if (!npmAvailable) {
      return {
        success: false,
        error: 'npm is not available. This may be because npm is installed via NVM and not accessible from VSCode. Try: 1) Open a terminal and run the install command manually, or 2) Install Node.js from nodejs.org',
        requiresManual: true
      };
    }

    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      return {
        success: false,
        error: `Provider "${providerId}" not found`
      };
    }

    const installCommand = provider.getInstallCommand();
    console.log(`[Mysti] SetupManager: Running install command: ${installCommand}`);

    onProgress?.('installing', `Running: ${installCommand}`, 40);

    try {
      // Determine if we need to use login shell (npm found via login shell check)
      const useLoginShell = this._npmPath === 'npm' && !(await this._checkNpmDirect());

      // Run npm install with timeout and optional login shell
      const result = await this._runCommand(installCommand, 120000, useLoginShell);

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Installation failed',
          requiresManual: true
        };
      }

      onProgress?.('installing', 'Verifying installation...', 60);

      // Verify installation
      const discovery = await provider.discoverCli();
      if (!discovery.found) {
        return {
          success: false,
          error: 'Installation completed but CLI not found. You may need to restart your terminal or VS Code.',
          requiresManual: true
        };
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Installation failed: ${errorMessage}`,
        requiresManual: true
      };
    }
  }

  /**
   * Run authentication command for a provider
   * This opens a terminal or browser for the user to complete auth
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

    // Create a terminal for the user to complete authentication
    const terminal = vscode.window.createTerminal({
      name: `${provider.displayName} Authentication`,
      shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
    });

    terminal.show();
    terminal.sendText(authCommand);

    // Return pending - the user needs to complete auth in the terminal
    // The webview will poll for auth status
    return {
      authenticated: false,
      error: 'Please complete authentication in the terminal window'
    };
  }

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
        docsUrl: setupInfo?.docsUrl
      });
    }

    // Only require installed (not authenticated) - auth errors handled inline during chat
    const anyReady = providers.some(p => p.installed);

    return {
      providers,
      npmAvailable,
      nodeVersion,
      anyReady
    };
  }

  /**
   * Get Node.js version if available
   */
  private async _getNodeVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('node --version');
      return stdout.trim();
    } catch {
      return undefined;
    }
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

    // Claude Code only has one auth method
    return [];
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
      // Set the environment variable for the current process
      process.env['GOOGLE_GENAI_USE_GCA'] = 'true';
      console.log('[Mysti] SetupManager: Set GOOGLE_GENAI_USE_GCA=true');

      // Also suggest adding to shell profile
      const terminal = vscode.window.createTerminal({
        name: 'Gemini GCA Setup',
        shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
      });
      terminal.show();
      terminal.sendText('echo "Adding GOOGLE_GENAI_USE_GCA=true to your shell profile..."');
      terminal.sendText('echo \'export GOOGLE_GENAI_USE_GCA=true\' >> ~/.zshrc');
      terminal.sendText('echo "Done! Run \'source ~/.zshrc\' or restart your terminal."');

      // Check if auth works now
      const authStatus = await provider.checkAuthentication();
      return authStatus;
    }

    // Handle API key method
    if (method === 'api-key' && apiKey) {
      const envVar = providerId === 'google-gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
      process.env[envVar] = apiKey;
      console.log(`[Mysti] SetupManager: Set ${envVar} for this session`);

      // Verify it works
      const authStatus = await provider.checkAuthentication();
      return authStatus;
    }

    // For OAuth/CLI login, use the standard flow
    return this.authenticateProvider(providerId);
  }

  /**
   * Run a command and return the result
   * @param command The command to run
   * @param timeout Timeout in milliseconds
   * @param useLoginShell Whether to run in a login shell (for npm commands with NVM)
   */
  private async _runCommand(
    command: string,
    timeout: number = 60000,
    useLoginShell: boolean = false
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return new Promise((resolve) => {
      let proc;

      // For npm commands, optionally use login shell to inherit NVM environment
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

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        proc.kill();
        resolve({
          success: false,
          error: 'Command timed out'
        });
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({
            success: false,
            error: stderr || `Command exited with code ${code}`
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: err.message
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
  }
}
