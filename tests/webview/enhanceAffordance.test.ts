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
 * Webview side of prompt enhancement.
 *
 * The "Enhance prompt" button used to stay live for every backend, including
 * the majority that have no enhancePrompt() implementation: clicking it
 * round-tripped to the extension and repainted byte-identical text. The button
 * is now capability-driven off the provider manifest.
 *
 * These extract and execute the REAL functions from media/chat/chat.js (same
 * approach as providerManifestWebview.test.ts) so they cannot drift from the
 * shipped artifact.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** Extract a top-level `function name(...) { ... }` declaration by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) { return source.slice(start, i + 1); }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

let chatJs: string;
beforeAll(() => {
  chatJs = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
});

function entry(id: string, supportsPromptEnhancement: boolean) {
  return { id, displayName: id.toUpperCase(), capabilities: { supportsPromptEnhancement } };
}

interface ResolveState {
  providerManifest?: { providers: unknown[] } | null;
  providerAvailability?: Record<string, { available: boolean }>;
  settings?: { provider?: string };
}

function resolve(state: ResolveState): Record<string, unknown> | null {
  const src = extractFunction(chatJs, 'resolveEnhanceProvider');
  const fn = new Function('state', `${src}\nreturn resolveEnhanceProvider();`);
  return fn(state);
}

describe('resolveEnhanceProvider', () => {
  it('picks the active provider when it can enhance itself', () => {
    const result = resolve({
      providerManifest: { providers: [entry('claude-code', true), entry('qwen-code', false)] },
      providerAvailability: { 'claude-code': { available: true } },
      settings: { provider: 'claude-code' },
    });
    expect(result).toEqual({ id: 'claude-code', name: 'CLAUDE-CODE', fallback: false });
  });

  it('offers an installed capable backend when the active one cannot enhance', () => {
    // The shipped default (qwen-code) is one of the many that cannot.
    const result = resolve({
      providerManifest: { providers: [entry('claude-code', true), entry('qwen-code', false)] },
      providerAvailability: { 'claude-code': { available: true }, 'qwen-code': { available: true } },
      settings: { provider: 'qwen-code' },
    });
    expect(result).toEqual({ id: 'claude-code', name: 'CLAUDE-CODE', fallback: true });
  });

  it('does not offer a capable backend that is not installed', () => {
    const result = resolve({
      providerManifest: { providers: [entry('cursor', true), entry('qwen-code', false)] },
      providerAvailability: { 'cursor': { available: false }, 'qwen-code': { available: true } },
      settings: { provider: 'qwen-code' },
    });
    expect(result).toMatchObject({ unavailable: true, name: 'QWEN-CODE' });
  });

  it('marks the feature unavailable when no capable backend exists at all', () => {
    const result = resolve({
      providerManifest: { providers: [entry('qwen-code', false), entry('ollama', false)] },
      providerAvailability: { 'qwen-code': { available: true }, 'ollama': { available: true } },
      settings: { provider: 'qwen-code' },
    });
    expect(result).toMatchObject({ unavailable: true });
  });

  it('defers to the extension before the manifest arrives', () => {
    // Disabling the button on missing data would break the feature on a cold
    // webview; null means "leave it enabled, the extension decides".
    expect(resolve({ providerManifest: null, settings: { provider: 'claude-code' } })).toBeNull();
    expect(resolve({ providerManifest: { providers: [] }, settings: { provider: 'claude-code' } })).toBeNull();
  });

  it('defers for pseudo-agents, which the extension resolves server-side', () => {
    // brainstorm/mysti have no manifest entry; the extension maps them onto
    // mysti.defaultProvider, so the webview must not pre-judge them.
    const manifest = { providers: [entry('claude-code', true), entry('qwen-code', false)] };
    expect(resolve({ providerManifest: manifest, settings: { provider: 'brainstorm' } })).toBeNull();
    expect(resolve({ providerManifest: manifest, settings: { provider: 'mysti' } })).toBeNull();
  });

  it('tolerates a missing providerAvailability map', () => {
    const result = resolve({
      providerManifest: { providers: [entry('claude-code', true), entry('qwen-code', false)] },
      settings: { provider: 'qwen-code' },
    });
    // Nothing is known to be installed, so nothing is offered.
    expect(result).toMatchObject({ unavailable: true });
  });
});

describe('updateEnhanceAffordance', () => {
  function run(state: ResolveState, button: Record<string, unknown>): Record<string, unknown> {
    const src = [
      extractFunction(chatJs, 'resolveEnhanceProvider'),
      extractFunction(chatJs, 'updateEnhanceAffordance'),
    ].join('\n');
    const fn = new Function('state', 'enhanceBtn', `${src}\nupdateEnhanceAffordance();\nreturn enhanceBtn;`);
    return fn(state, button);
  }

  const fakeButton = (classes: string[] = []) => ({
    disabled: false,
    title: 'Enhance prompt',
    classList: { contains: (c: string) => classes.includes(c) },
  });

  it('disables the button with the reason when nothing can enhance', () => {
    const btn = run({
      providerManifest: { providers: [entry('qwen-code', false)] },
      providerAvailability: { 'qwen-code': { available: true } },
      settings: { provider: 'qwen-code' },
    }, fakeButton());

    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('QWEN-CODE cannot enhance prompts');
  });

  it('attributes a fallback in the tooltip instead of routing silently', () => {
    const btn = run({
      providerManifest: { providers: [entry('claude-code', true), entry('qwen-code', false)] },
      providerAvailability: { 'claude-code': { available: true } },
      settings: { provider: 'qwen-code' },
    }, fakeButton());

    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe('Enhance prompt (via CLAUDE-CODE)');
  });

  it('re-enables when switching back to a capable provider', () => {
    const btn = run({
      providerManifest: { providers: [entry('claude-code', true)] },
      providerAvailability: { 'claude-code': { available: true } },
      settings: { provider: 'claude-code' },
    }, { ...fakeButton(), disabled: true, title: 'stale reason' });

    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe('Enhance prompt');
  });

  it('leaves a request in flight alone', () => {
    const btn = run({
      providerManifest: { providers: [entry('qwen-code', false)] },
      providerAvailability: { 'qwen-code': { available: true } },
      settings: { provider: 'qwen-code' },
    }, fakeButton(['enhancing']));

    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe('Enhance prompt');
  });

  it('is a no-op when the button is absent', () => {
    const src = [
      extractFunction(chatJs, 'resolveEnhanceProvider'),
      extractFunction(chatJs, 'updateEnhanceAffordance'),
    ].join('\n');
    const fn = new Function('state', 'enhanceBtn', `${src}\nupdateEnhanceAffordance();\nreturn true;`);
    expect(fn({}, null)).toBe(true);
  });
});

describe('chat.js enhance wiring', () => {
  it('re-resolves the affordance on every provider change and availability update', () => {
    // updateAgentMenuSelection runs at all provider-change sites;
    // updateProviderAvailability runs on manifest + discovery updates.
    for (const host of ['updateAgentMenuSelection', 'updateProviderAvailability']) {
      expect(extractFunction(chatJs, host), host).toContain('updateEnhanceAffordance()');
    }
  });

  it('handles the promptEnhanceUnavailable message the extension now sends', () => {
    expect(chatJs).toContain("case 'promptEnhanceUnavailable':");
  });

  it('ignores clicks while the button is disabled', () => {
    expect(chatJs).toContain('if (enhanceBtn.disabled) { return; }');
  });
});
