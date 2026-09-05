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
 *
 * Prompt enhancement resolution.
 *
 * Only some backends implement `enhancePrompt()`. `ProviderManager.enhancePrompt`
 * used to end in a bare `return prompt`, so with any of the other backends
 * active the webview got back byte-identical text, cleared its spinner, and
 * looked broken — a silent no-op indistinguishable from success. These tests
 * pin the replacement contract: use the active provider, else fall back to an
 * INSTALLED capable one (and say so), else throw a typed error the UI can turn
 * into a disabled button with a reason. Never silently hand back the input.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ProviderManager, PromptEnhancementUnsupportedError } from '../../src/managers/ProviderManager';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import type { ICliProvider } from '../../src/providers/base/IProvider';
import { setMockConfig, clearMockConfig, clearConfigurationListeners } from '../helpers/mockVscode';

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [], setKeysForSync: () => {} },
    workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    extensionPath: '/mock/extension',
    extensionUri: vscode.Uri.file('/mock/extension'),
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global-storage'),
    logUri: vscode.Uri.file('/mock/logs'),
    extensionMode: 1,
    extension: {} as never,
    environmentVariableCollection: {} as never,
    secrets: {} as never,
    languageModelAccessInformation: {} as never,
  } as unknown as vscode.ExtensionContext;
}

interface FakeOpts {
  id: string;
  /** undefined => the provider does not implement enhancePrompt at all */
  enhance?: (prompt: string) => Promise<string>;
  installed?: boolean;
  /** Lets a test decouple the flag from the method to prove the drift guard. */
  capabilityOverride?: boolean;
}

function fakeProvider(opts: FakeOpts): ICliProvider {
  const supports = opts.capabilityOverride ?? typeof opts.enhance === 'function';
  const provider: Record<string, unknown> = {
    id: opts.id,
    displayName: opts.id.toUpperCase(),
    capabilities: { supportsPromptEnhancement: supports },
    discoverCli: async () => ({ found: opts.installed !== false, path: `/bin/${opts.id}` }),
  };
  if (opts.enhance) { provider.enhancePrompt = opts.enhance; }
  return provider as unknown as ICliProvider;
}

function buildManager(defaultId: string, providers: ICliProvider[]): ProviderManager {
  const byId = new Map(providers.map((p) => [p.id, p]));
  setMockConfig('defaultProvider', defaultId);
  const manager = new ProviderManager(createMockContext());
  (manager as unknown as { _registry: unknown })._registry = {
    get: (id: string) => byId.get(id),
    getAll: () => Array.from(byId.values()),
  };
  return manager;
}

describe('ProviderManager.enhancePrompt', () => {
  beforeEach(() => clearMockConfig());
  afterEach(() => {
    clearMockConfig();
    clearConfigurationListeners();
    vi.restoreAllMocks();
  });

  it('uses the active provider when it can enhance, and does not report a fallback', async () => {
    const manager = buildManager('able', [
      fakeProvider({ id: 'able', enhance: async (p) => `${p} (enhanced)` }),
    ]);

    const result = await manager.enhancePrompt('fix the bug');

    expect(result).toEqual({
      prompt: 'fix the bug (enhanced)',
      enhancedBy: 'ABLE',
      enhancedById: 'able',
      fallback: false,
      changed: true,
    });
  });

  it('falls back to an installed capable backend when the active one cannot enhance', async () => {
    // The shipped default: mysti.defaultProvider = qwen-code, which has no
    // enhancePrompt. Before the fix this returned the prompt untouched.
    const manager = buildManager('qwen-code', [
      fakeProvider({ id: 'qwen-code' }),
      fakeProvider({ id: 'claude-code', enhance: async (p) => `${p} — with acceptance criteria` }),
    ]);

    const result = await manager.enhancePrompt('add a retry');

    expect(result.changed).toBe(true);
    expect(result.prompt).toBe('add a retry — with acceptance criteria');
    // Routing the prompt to a DIFFERENT local CLI is reported, never silent.
    expect(result.fallback).toBe(true);
    expect(result.enhancedById).toBe('claude-code');
    expect(result.enhancedBy).toBe('CLAUDE-CODE');
  });

  it('skips capable backends whose CLI is not installed', async () => {
    const notInstalled = vi.fn(async (p: string) => `${p} nope`);
    const installed = vi.fn(async (p: string) => `${p} yes`);
    const manager = buildManager('qwen-code', [
      fakeProvider({ id: 'qwen-code' }),
      fakeProvider({ id: 'cursor', enhance: notInstalled, installed: false }),
      fakeProvider({ id: 'cline', enhance: installed }),
    ]);

    const result = await manager.enhancePrompt('hello');

    expect(notInstalled).not.toHaveBeenCalled();
    expect(installed).toHaveBeenCalledOnce();
    expect(result.enhancedById).toBe('cline');
  });

  it('throws a typed error when nothing installed can enhance — never a silent pass-through', async () => {
    const manager = buildManager('qwen-code', [
      fakeProvider({ id: 'qwen-code' }),
      fakeProvider({ id: 'ollama' }),
      fakeProvider({ id: 'cursor', enhance: async (p) => p, installed: false }),
    ]);

    await expect(manager.enhancePrompt('hello')).rejects.toBeInstanceOf(PromptEnhancementUnsupportedError);
    await expect(manager.enhancePrompt('hello')).rejects.toThrow(/QWEN-CODE does not support prompt enhancement/);
  });

  it('reports changed=false when the CLI failed and echoed the original back', async () => {
    // Every real implementation resolves the ORIGINAL prompt on CLI failure.
    // That is a no-op, not a success, and the UI must be able to tell.
    const manager = buildManager('able', [
      fakeProvider({ id: 'able', enhance: async (p) => p }),
    ]);

    const result = await manager.enhancePrompt('  unchanged  ');

    expect(result.changed).toBe(false);
    expect(result.prompt).toBe('  unchanged  ');
  });

  it('treats an empty CLI response as no change rather than wiping the input', async () => {
    const manager = buildManager('able', [
      fakeProvider({ id: 'able', enhance: async () => '   ' }),
    ]);

    const result = await manager.enhancePrompt('keep me');

    expect(result.changed).toBe(false);
    expect(result.prompt).toBe('keep me');
  });

  it('ignores a provider that claims the capability but has no method', async () => {
    // Guards the fallback loop against a manifest/implementation mismatch.
    const manager = buildManager('qwen-code', [
      fakeProvider({ id: 'qwen-code' }),
      fakeProvider({ id: 'liar', capabilityOverride: true }),
    ]);

    await expect(manager.enhancePrompt('hello')).rejects.toBeInstanceOf(PromptEnhancementUnsupportedError);
  });

  it('survives a provider whose discovery throws', async () => {
    const manager = buildManager('qwen-code', [
      fakeProvider({ id: 'qwen-code' }),
      {
        id: 'broken',
        displayName: 'BROKEN',
        capabilities: { supportsPromptEnhancement: true },
        enhancePrompt: async (p: string) => p,
        discoverCli: async () => { throw new Error('discovery blew up'); },
      } as unknown as ICliProvider,
      fakeProvider({ id: 'cline', enhance: async (p) => `${p}!` }),
    ]);

    const result = await manager.enhancePrompt('hi');
    expect(result.enhancedById).toBe('cline');
  });
});

describe('supportsPromptEnhancement capability (drift guard)', () => {
  it('matches the actual enhancePrompt implementation on every registered provider', () => {
    // The webview disables the button off this flag. If the two ever diverge,
    // a live button silently no-ops (flag true, no method) or a working
    // backend looks incapable (flag false, method present).
    const registry = new ProviderRegistry(createMockContext());
    const providers = registry.getAll();
    expect(providers.length).toBeGreaterThan(10);

    for (const provider of providers) {
      expect(
        provider.capabilities.supportsPromptEnhancement,
        `${provider.id}: capabilities.supportsPromptEnhancement disagrees with enhancePrompt()`
      ).toBe(typeof (provider as { enhancePrompt?: unknown }).enhancePrompt === 'function');
    }
  });

  it('at least one registered provider can enhance, so the feature is reachable', () => {
    const registry = new ProviderRegistry(createMockContext());
    expect(registry.getAll().some(p => p.capabilities.supportsPromptEnhancement)).toBe(true);
  });
});
