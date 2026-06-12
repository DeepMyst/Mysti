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
import type { ICliProvider } from './base/IProvider';
import { PerfTracker } from '../utils/PerfTracker';
import { ClaudeCodeProvider } from './claude/ClaudeCodeProvider';
import { CodexProvider } from './codex/CodexProvider';
import { GeminiProvider } from './gemini/GeminiProvider';
import { ClineProvider } from './cline/ClineProvider';
import { CopilotProvider } from './copilot/CopilotProvider';
import { CursorProvider } from './cursor/CursorProvider';
import { OpenClawProvider } from './openclaw/OpenClawProvider';
import { OpenCodeProvider } from './opencode/OpenCodeProvider';
import { OllamaProvider } from './ollama/OllamaProvider';
import { LocalAIProvider } from './localai/LocalAIProvider';
import { QwenCodeProvider } from './qwen/QwenCodeProvider';

/**
 * Registry for managing CLI providers
 * Handles provider lifecycle and lookup
 */
export class ProviderRegistry {
  private _providers: Map<string, ICliProvider> = new Map();
  private _extensionContext: vscode.ExtensionContext;
  /** Single-flight guard: concurrent/repeat initializeAll() calls share this promise. */
  private _initPromise: Promise<void> | undefined;
  private _whenReadyResolve!: () => void;

  /**
   * Resolved when initializeAll() settles — even if some (or all) provider
   * initializations failed. Call paths that require discovery results
   * (e.g., wizard status) await this instead of blocking activation
   * (Plan 03 Phase 2: provider init runs in the background).
   */
  public readonly whenReady: Promise<void> = new Promise<void>((resolve) => {
    this._whenReadyResolve = resolve;
  });

  private readonly _onProviderReadyEmitter = new vscode.EventEmitter<string>();
  /**
   * Fires each provider's id as its initialize() settles (success or
   * failure), in settle order — for incremental consumers that want to
   * update UI per provider instead of waiting for whenReady.
   */
  public readonly onProviderReady: vscode.Event<string> = this._onProviderReadyEmitter.event;

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

    // Register Cline
    const cline = new ClineProvider(this._extensionContext);
    this._providers.set(cline.id, cline);
    console.log(`[Mysti] Registered provider: ${cline.displayName}`);

    // Register GitHub Copilot
    const copilot = new CopilotProvider(this._extensionContext);
    this._providers.set(copilot.id, copilot);
    console.log(`[Mysti] Registered provider: ${copilot.displayName}`);

    // Register Cursor
    const cursor = new CursorProvider(this._extensionContext);
    this._providers.set(cursor.id, cursor);
    console.log(`[Mysti] Registered provider: ${cursor.displayName}`);

    // Register OpenClaw
    const openclaw = new OpenClawProvider(this._extensionContext);
    this._providers.set(openclaw.id, openclaw);
    console.log(`[Mysti] Registered provider: ${openclaw.displayName}`);

    // Register OpenCode
    const opencode = new OpenCodeProvider(this._extensionContext);
    this._providers.set(opencode.id, opencode);
    console.log(`[Mysti] Registered provider: ${opencode.displayName}`);

    // Register Ollama
    const ollama = new OllamaProvider(this._extensionContext);
    this._providers.set(ollama.id, ollama);
    console.log(`[Mysti] Registered provider: ${ollama.displayName}`);

    // Register LocalAI
    const localai = new LocalAIProvider(this._extensionContext);
    this._providers.set(localai.id, localai);
    console.log(`[Mysti] Registered provider: ${localai.displayName}`);

    // Register Qwen Code
    const qwen = new QwenCodeProvider(this._extensionContext);
    this._providers.set(qwen.id, qwen);
    console.log(`[Mysti] Registered provider: ${qwen.displayName}`);

  }

  /**
   * Initialize all registered providers.
   *
   * Plan 03 Phase 2: all provider initialize() calls run in parallel via
   * Promise.allSettled, so one slow/unreachable CLI (e.g., an Ollama
   * endpoint hitting its fetch timeout) no longer blocks the rest.
   * Single-flight: concurrent and repeat calls share one promise.
   */
  public initializeAll(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._initializeAllInternal();
    }
    return this._initPromise;
  }

  private async _initializeAllInternal(): Promise<void> {
    try {
      console.log('[Mysti] Initializing all providers...');

      // Per-provider init timing — gated so the disabled path does no extra work
      const perfEnabled = PerfTracker.isEnabled();
      const initDurations: Array<{ id: string; ms: number }> | undefined =
        perfEnabled ? [] : undefined;

      await Promise.allSettled(
        Array.from(this._providers.values()).map(async (provider) => {
          // Each provider is timed inside its own closure so the per-provider
          // duration samples stay accurate under parallel execution.
          const startedAt = perfEnabled ? Date.now() : 0;
          try {
            await provider.initialize();
            console.log(`[Mysti] Initialized provider: ${provider.displayName}`);
          } catch (error) {
            console.error(`[Mysti] Failed to initialize provider ${provider.displayName}:`, error);
          }
          if (initDurations) {
            const ms = Date.now() - startedAt;
            PerfTracker.sample(`provider.init.${provider.id}`, ms);
            initDurations.push({ id: provider.id, ms });
          }
          this._onProviderReadyEmitter.fire(provider.id);
        })
      );

      if (initDurations && initDurations.length > 0) {
        const slowest = [...initDurations]
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 3)
          .map((d) => `${d.id}=${d.ms.toFixed(1)}ms`)
          .join(', ');
        console.log(`[Mysti][perf] provider.init slowest: ${slowest}`);
      }
    } finally {
      // Resolve even when provider initializations failed: whenReady means
      // "background discovery has settled", not "all providers are usable".
      this._whenReadyResolve();
    }
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
    // Allow re-initialization after dispose (matches previous `_initialized`
    // reset). Note: whenReady stays resolved once the first init settled.
    this._initPromise = undefined;
  }
}
