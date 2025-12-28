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
import type { ICliProvider } from './base/IProvider';
import { ClaudeCodeProvider } from './claude/ClaudeCodeProvider';
import { CodexProvider } from './codex/CodexProvider';
import { GeminiProvider } from './gemini/GeminiProvider';
import { CopilotProvider } from './copilot/CopilotProvider';

/**
 * Registry for managing CLI providers
 * Handles provider lifecycle and lookup
 */
export class ProviderRegistry {
  private _providers: Map<string, ICliProvider> = new Map();
  private _extensionContext: vscode.ExtensionContext;
  private _initialized: boolean = false;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._registerBuiltInProviders();
  }

  /**
   * Register built-in providers
   */
  private _registerBuiltInProviders(): void {
    // Register Claude Code
    const claude = new ClaudeCodeProvider(this._extensionContext);
    this._providers.set(claude.id, claude);
    console.log(`[Mysti] Registered provider: ${claude.displayName}`);

    // Register OpenAI Codex
    const codex = new CodexProvider(this._extensionContext);
    this._providers.set(codex.id, codex);
    console.log(`[Mysti] Registered provider: ${codex.displayName}`);

    // Register Google Gemini
    const gemini = new GeminiProvider(this._extensionContext);
    this._providers.set(gemini.id, gemini);
    console.log(`[Mysti] Registered provider: ${gemini.displayName}`);

    // Register GitHub Copilot
    const copilot = new CopilotProvider(this._extensionContext);
    this._providers.set(copilot.id, copilot);
    console.log(`[Mysti] Registered provider: ${copilot.displayName}`);
  }

  /**
   * Initialize all registered providers
   */
  public async initializeAll(): Promise<void> {
    if (this._initialized) {
      return;
    }

    console.log('[Mysti] Initializing all providers...');

    for (const provider of this._providers.values()) {
      try {
        await provider.initialize();
        console.log(`[Mysti] Initialized provider: ${provider.displayName}`);
      } catch (error) {
        console.error(`[Mysti] Failed to initialize provider ${provider.displayName}:`, error);
      }
    }

    this._initialized = true;
  }

  /**
   * Register a new provider
   */
  public register(provider: ICliProvider): void {
    if (this._providers.has(provider.id)) {
      console.warn(`[Mysti] Provider ${provider.id} already registered, replacing...`);
      this._providers.get(provider.id)?.dispose();
    }
    this._providers.set(provider.id, provider);
    console.log(`[Mysti] Registered provider: ${provider.displayName}`);
  }

  /**
   * Unregister a provider by ID
   */
  public unregister(id: string): boolean {
    const provider = this._providers.get(id);
    if (provider) {
      provider.dispose();
      this._providers.delete(id);
      console.log(`[Mysti] Unregistered provider: ${id}`);
      return true;
    }
    return false;
  }

  /**
   * Get a provider by ID
   */
  public get(id: string): ICliProvider | undefined {
    return this._providers.get(id);
  }

  /**
   * Get all registered providers
   */
  public getAll(): ICliProvider[] {
    return Array.from(this._providers.values());
  }

  /**
   * Get all provider IDs
   */
  public getIds(): string[] {
    return Array.from(this._providers.keys());
  }

  /**
   * Check if a provider is registered
   */
  public has(id: string): boolean {
    return this._providers.has(id);
  }

  /**
   * Get providers that have their CLI available
   */
  public async getAvailable(): Promise<ICliProvider[]> {
    const available: ICliProvider[] = [];

    for (const provider of this._providers.values()) {
      try {
        const discovery = await provider.discoverCli();
        if (discovery.found) {
          available.push(provider);
        }
      } catch (error) {
        console.error(`[Mysti] Error checking availability for ${provider.id}:`, error);
      }
    }

    return available;
  }

  /**
   * Get providers that are authenticated
   */
  public async getAuthenticated(): Promise<ICliProvider[]> {
    const authenticated: ICliProvider[] = [];

    for (const provider of this._providers.values()) {
      try {
        const authStatus = await provider.checkAuthentication();
        if (authStatus.authenticated) {
          authenticated.push(provider);
        }
      } catch (error) {
        console.error(`[Mysti] Error checking authentication for ${provider.id}:`, error);
      }
    }

    return authenticated;
  }

  /**
   * Get provider status information
   */
  public async getProviderStatus(id: string): Promise<{
    found: boolean;
    authenticated: boolean;
    path: string;
    installCommand?: string;
  } | null> {
    const provider = this._providers.get(id);
    if (!provider) {
      return null;
    }

    try {
      const discovery = await provider.discoverCli();
      const authStatus = await provider.checkAuthentication();

      return {
        found: discovery.found,
        authenticated: authStatus.authenticated,
        path: discovery.path,
        installCommand: discovery.installCommand
      };
    } catch (error) {
      console.error(`[Mysti] Error getting status for ${id}:`, error);
      return null;
    }
  }

  /**
   * Dispose all providers
   */
  public dispose(): void {
    console.log('[Mysti] Disposing all providers...');
    for (const provider of this._providers.values()) {
      try {
        provider.dispose();
      } catch (error) {
        console.error(`[Mysti] Error disposing provider ${provider.id}:`, error);
      }
    }
    this._providers.clear();
    this._initialized = false;
  }
}
