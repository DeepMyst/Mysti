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
 * Plan 01 Phase 4 (webview half) — a background model-list refresh repaints the
 * picker WITHOUT moving the user's selection. These updates can land
 * mid-conversation, so silently switching the active model would be a real bug.
 *
 * The two functions are extracted from media/chat/chat.js and run against a
 * minimal fake <select>, so this tests the shipped source rather than a mirror.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

let chatJs: string;

beforeAll(() => {
  chatJs = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
});

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

/** A <select> stand-in: innerHTML assignment reparses <option> tags. */
function fakeSelect(initialValue = '') {
  const select: any = {
    options: [] as Array<{ value: string; textContent: string }>,
    _value: initialValue,
    get value() { return this._value; },
    set value(v: string) {
      // A real <select> ignores a value none of its options carry.
      if (this.options.some((o: any) => o.value === v)) { this._value = v; }
    },
    get innerHTML() { return this._html || ''; },
    set innerHTML(html: string) {
      this._html = html;
      this.options = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
        .map(m => ({ value: m[1], textContent: m[2] }));
      // Selection survives a repaint only if the option is still there.
      if (!this.options.some((o: any) => o.value === this._value)) { this._value = ''; }
    },
  };
  return select;
}

interface Harness {
  renderModelOptions(provider: any): void;
  applyModelsUpdate(payload: any): void;
  modelSelect: any;
  state: any;
  syncCalls: number;
}

function makeHarness(opts: { provider: string; model: string; selected?: string; providers?: any[] }): Harness {
  const src = [
    extractFunction(chatJs, 'renderModelOptions'),
    extractFunction(chatJs, 'applyModelsUpdate'),
  ].join('\n');

  const modelSelect = fakeSelect();
  const state = {
    settings: { provider: opts.provider, model: opts.model },
    providers: opts.providers ?? [
      { name: opts.provider, models: [{ id: opts.model, name: opts.model }], defaultModel: opts.model },
    ],
  };
  const counters = { syncCalls: 0 };
  const escapeHtml = (s: unknown) =>
    s === null || s === undefined || s === '' ? '' : String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const factory = new Function(
    'modelSelect', 'state', 'syncInlineSelectors', 'escapeHtml',
    `${src}\nreturn { renderModelOptions: renderModelOptions, applyModelsUpdate: applyModelsUpdate };`
  );
  const api = factory(modelSelect, state, () => { counters.syncCalls++; }, escapeHtml);

  // Paint the initial list the way initialState would have.
  api.renderModelOptions(state.providers.find((p: any) => p.name === opts.provider));
  if (opts.selected) { modelSelect.value = opts.selected; }

  return {
    renderModelOptions: api.renderModelOptions,
    applyModelsUpdate: api.applyModelsUpdate,
    modelSelect,
    state,
    get syncCalls() { return counters.syncCalls; },
  };
}

describe('webview: modelsUpdated repaints without moving the selection', () => {
  it('adds newly discovered models to the picker', () => {
    const h = makeHarness({ provider: 'claude-code', model: 'sonnet-4-5' });

    h.applyModelsUpdate({
      provider: 'claude-code',
      models: [
        { id: 'sonnet-4-5', name: 'Sonnet 4.5' },
        { id: 'opus-4-6', name: 'Opus 4.6' },
      ],
      defaultModel: 'sonnet-4-5',
    });

    expect(h.modelSelect.options.map((o: any) => o.value))
      .toEqual(['sonnet-4-5', 'opus-4-6', '__custom__']);
    expect(h.modelSelect.value).toBe('sonnet-4-5');
  });

  it('keeps the active model selectable even when the refreshed list drops it', () => {
    const h = makeHarness({ provider: 'claude-code', model: 'sonnet-4-5' });

    // A retired model: discovery no longer lists it, but the user is mid-turn on it.
    h.applyModelsUpdate({
      provider: 'claude-code',
      models: [{ id: 'opus-4-6', name: 'Opus 4.6' }],
      defaultModel: 'opus-4-6',
    });

    expect(h.modelSelect.value).toBe('sonnet-4-5');
    expect(h.modelSelect.options.map((o: any) => o.value)).toContain('sonnet-4-5');
    // The setting is untouched — a background refresh never changes the model.
    expect(h.state.settings.model).toBe('sonnet-4-5');
  });

  it('preserves an active custom-model override across a repaint', () => {
    const h = makeHarness({ provider: 'claude-code', model: 'sonnet-4-5', selected: '__custom__' });

    h.applyModelsUpdate({
      provider: 'claude-code',
      models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5' }, { id: 'opus-4-6', name: 'Opus 4.6' }],
      defaultModel: 'sonnet-4-5',
    });

    expect(h.modelSelect.value).toBe('__custom__');
  });

  it('merges into state.providers but does NOT repaint another provider', () => {
    const h = makeHarness({
      provider: 'claude-code',
      model: 'sonnet-4-5',
      providers: [
        { name: 'claude-code', models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5' }], defaultModel: 'sonnet-4-5' },
        { name: 'ollama', models: [{ id: 'llama3', name: 'llama3' }], defaultModel: 'llama3' },
      ],
    });
    const before = h.syncCalls;

    h.applyModelsUpdate({
      provider: 'ollama',
      models: [{ id: 'llama3', name: 'llama3' }, { id: 'qwen3:8b', name: 'qwen3:8b' }],
      defaultModel: 'llama3',
    });

    // Stored for the next agent switch...
    expect(h.state.providers[1].models.map((m: any) => m.id)).toEqual(['llama3', 'qwen3:8b']);
    // ...but the visible picker (claude-code) is left alone.
    expect(h.modelSelect.options.map((o: any) => o.value)).toEqual(['sonnet-4-5', '__custom__']);
    expect(h.syncCalls).toBe(before);
  });

  it('ignores malformed or unknown-provider payloads', () => {
    const h = makeHarness({ provider: 'claude-code', model: 'sonnet-4-5' });
    const optionsBefore = h.modelSelect.options.map((o: any) => o.value);

    h.applyModelsUpdate(undefined);
    h.applyModelsUpdate({ provider: 'claude-code' });
    h.applyModelsUpdate({ provider: 'nope', models: [{ id: 'x', name: 'x' }] });

    expect(h.modelSelect.options.map((o: any) => o.value)).toEqual(optionsBefore);
  });

  it('escapes model ids and names into the option markup', () => {
    const h = makeHarness({ provider: 'claude-code', model: 'sonnet-4-5' });

    h.applyModelsUpdate({
      provider: 'claude-code',
      models: [{ id: 'a"onmouseover="x', name: '<img src=x onerror=alert(1)>' }],
      defaultModel: 'sonnet-4-5',
    });

    expect(h.modelSelect.innerHTML).not.toContain('onmouseover="x');
    expect(h.modelSelect.innerHTML).not.toContain('<img');
    expect(h.modelSelect.innerHTML).toContain('&quot;');
  });
});
