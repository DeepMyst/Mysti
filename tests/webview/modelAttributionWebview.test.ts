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
 * The webview half of "the model a panel reports is the model it runs".
 *
 * Two things were making a Codex turn present as "MYSTI / Qwen3 Coder":
 *
 *  - The assistant role label is the PRODUCT name and reads "Mysti" on every
 *    message whichever backend answered, so the chip beside it was the only
 *    per-message statement of who replied — and it named the model alone.
 *  - `select.value = id` for an id the picker has no <option> for is a silent
 *    no-op, so the control kept showing whatever it had.
 *
 * Functions are extracted from media/chat/chat.js so this tests the shipped
 * source rather than a mirror of it.
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

/**
 * A <select> stand-in with the DOM surface selectModelOption uses:
 * options, value (which ignores an unknown id, exactly like the real one),
 * querySelector('option[value="…"]') and insertBefore.
 */
function fakeSelect(optionIds: string[]) {
  const select: any = {
    options: optionIds.map(id => ({ value: id, textContent: id })),
    _value: optionIds[0] ?? '',
    get value() { return this._value; },
    set value(v: string) {
      if (this.options.some((o: any) => o.value === v)) { this._value = v; }
    },
    querySelector(sel: string) {
      const m = /^option\[value="(.*)"\]$/.exec(sel);
      if (!m) { return null; }
      return this.options.find((o: any) => o.value === m[1]) ?? null;
    },
    insertBefore(node: any, ref: any) {
      const at = ref ? this.options.indexOf(ref) : -1;
      if (at === -1) { this.options.push(node); } else { this.options.splice(at, 0, node); }
      return node;
    },
  };
  return select;
}

function makeSelectHarness(optionIds: string[]) {
  const modelSelect = fakeSelect(optionIds);
  const documentStub = {
    createElement: () => ({ value: '', textContent: '' }),
  };
  const factory = new Function(
    'modelSelect', 'document',
    `${extractFunction(chatJs, 'selectModelOption')}\nreturn selectModelOption;`
  );
  return { modelSelect, selectModelOption: factory(modelSelect, documentStub) };
}

function makeLabelHarness(manifest: Array<{ id: string; displayName: string }>, models: Record<string, string> = {}) {
  const src = [
    extractFunction(chatJs, 'getAgentDisplayName'),
    extractFunction(chatJs, 'formatAttributionLabel'),
  ].join('\n');
  const factory = new Function(
    'getManifestEntry', 'getModelDisplayName',
    `${src}\nreturn { getAgentDisplayName: getAgentDisplayName, formatAttributionLabel: formatAttributionLabel };`
  );
  return factory(
    (id: string) => manifest.find(e => e.id === id),
    (id: string) => models[id] ?? id ?? ''
  );
}

const MANIFEST = [
  { id: 'openai-codex', displayName: 'Codex' },
  { id: 'qwen-code', displayName: 'Qwen Code' },
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'ollama', displayName: 'Ollama' },
];

describe('webview: the message header names who answered', () => {
  it('the reported case reads as Codex, not as an unattributed Qwen model', () => {
    const api = makeLabelHarness(MANIFEST, { 'gpt-6-astra': 'GPT-6 Astra' });
    expect(api.formatAttributionLabel({ provider: 'openai-codex', model: 'gpt-6-astra' }))
      .toBe('Codex · GPT-6 Astra');
  });

  it('names the Mysti coordinator explicitly — it has no manifest entry', () => {
    const api = makeLabelHarness(MANIFEST, { 'qwen/qwen3-coder': 'Qwen3 Coder' });
    // When the coordinator genuinely answers, saying so is the honest label.
    expect(api.formatAttributionLabel({ provider: 'mysti', model: 'qwen/qwen3-coder' }))
      .toBe('Mysti · Qwen3 Coder');
    expect(api.getAgentDisplayName('brainstorm')).toBe('Brainstorm');
  });

  it('falls back to the model alone for an agent the manifest does not know', () => {
    const api = makeLabelHarness(MANIFEST, { 'sonnet-5': 'Sonnet 5' });
    expect(api.formatAttributionLabel({ provider: 'not-a-provider', model: 'sonnet-5' }))
      .toBe('Sonnet 5');
  });

  it('shows the agent alone when the model is not knowable yet', () => {
    // responseStarted for a pseudo-agent carries no model: the coordinator only
    // reports the model it ran from inside the stream. Better a short label than
    // a wrong one.
    const api = makeLabelHarness(MANIFEST);
    expect(api.formatAttributionLabel({ provider: 'mysti', model: '' })).toBe('Mysti');
  });

  it('does not repeat itself when the agent name IS the model name', () => {
    const api = makeLabelHarness(MANIFEST, { ollama: 'Ollama' });
    expect(api.formatAttributionLabel({ provider: 'ollama', model: 'ollama' })).toBe('Ollama');
  });
});

describe('webview: the picker can be pointed at any settled model', () => {
  it('selects a model the list already carries', () => {
    const h = makeSelectHarness(['gpt-5-codex', 'gpt-6-astra', '__custom__']);
    expect(h.selectModelOption('gpt-6-astra')).toBe(true);
    expect(h.modelSelect.value).toBe('gpt-6-astra');
  });

  it('adds an unlisted model rather than silently ignoring it', () => {
    // The extension is allowed to settle on a hand-typed model (#39 keeps
    // those). Before, `select.value = id` just did nothing and the control kept
    // naming the previous one.
    const h = makeSelectHarness(['gpt-5-codex', '__custom__']);
    expect(h.selectModelOption('some-unreleased-preview-42')).toBe(true);
    expect(h.modelSelect.value).toBe('some-unreleased-preview-42');
    expect(h.modelSelect.options.map((o: any) => o.value))
      .toEqual(['gpt-5-codex', 'some-unreleased-preview-42', '__custom__']);
  });

  it('keeps "Custom..." last when it inserts', () => {
    const h = makeSelectHarness(['a', '__custom__']);
    h.selectModelOption('b');
    expect(h.modelSelect.options[h.modelSelect.options.length - 1].value).toBe('__custom__');
  });

  it('is a no-op for an empty model id', () => {
    const h = makeSelectHarness(['a', '__custom__']);
    expect(h.selectModelOption('')).toBe(false);
    expect(h.modelSelect.options).toHaveLength(2);
  });
});

describe('webview: the model picker is no longer chosen locally on a switch', () => {
  it('updateModelsForProvider does not post its own updateSettings model message', () => {
    // It used to post `updateSettings {model}` BEFORE its caller posted
    // `updateSettings {provider}` — two messages resolved against two different
    // providers, racing to write one field. The extension answers every
    // provider change with modelChanged, so the choice is its call.
    const fn = extractFunction(chatJs, 'updateModelsForProvider');
    expect(fn).not.toMatch(/payload:\s*\{\s*model:/);
    expect(fn).toContain('selectModelOption');
  });

  it('modelChanged is applied to state, not just to the picker', () => {
    const handler = chatJs.slice(chatJs.indexOf("case 'modelChanged':"), chatJs.indexOf("case 'modeChanged':"));
    expect(handler).toContain('state.settings.model = message.payload.model');
    expect(handler).toContain('selectModelOption');
    // A custom-model override owns the picker; don't yank it off "Custom…".
    expect(handler).toContain("'__custom__'");
    expect(handler).toContain('applyCustomModelState');
  });
});

describe('webview: a per-provider custom model owns the picker', () => {
  function makeCustomHarness(currentModel: string, optionIds: string[]) {
    const modelSelect = fakeSelect(optionIds);
    const state: any = { settings: { model: currentModel }, providerSettings: {} };
    const customModelSection = {
      classes: new Set<string>(['hidden']),
      classList: {
        add(c: string) { customModelSection.classes.add(c); },
        remove(c: string) { customModelSection.classes.delete(c); },
      },
    };
    const customModelInput = { value: '' };
    const documentStub = { createElement: () => ({ value: '', textContent: '' }) };
    const src = [
      extractFunction(chatJs, 'selectModelOption'),
      extractFunction(chatJs, 'applyCustomModelState'),
    ].join('\n');
    const factory = new Function(
      'modelSelect', 'state', 'customModelSection', 'customModelInput', 'document',
      `${src}\nreturn applyCustomModelState;`
    );
    return {
      applyCustomModelState: factory(modelSelect, state, customModelSection, customModelInput, documentStub),
      modelSelect, state, customModelSection, customModelInput,
    };
  }

  it('switching onto a backend with mysti.<provider>Model shows Custom…', () => {
    // Picker would otherwise name gpt-5-codex while the CLI runs gpt-6-astra.
    const h = makeCustomHarness('gpt-5-codex', ['gpt-5-codex', 'gpt-6-astra', '__custom__']);
    h.applyCustomModelState('gpt-6-astra');
    expect(h.modelSelect.value).toBe('__custom__');
    expect(h.customModelInput.value).toBe('gpt-6-astra');
    expect(h.customModelSection.classes.has('hidden')).toBe(false);
    expect(h.state.providerSettings.customModel).toBe('gpt-6-astra');
  });

  it('switching off one clears it and returns to the settled model', () => {
    const h = makeCustomHarness('claude-sonnet-5', ['claude-sonnet-5', '__custom__']);
    h.applyCustomModelState('gpt-6-astra');
    h.applyCustomModelState('');
    expect(h.modelSelect.value).toBe('claude-sonnet-5');
    expect(h.customModelInput.value).toBe('');
    expect(h.customModelSection.classes.has('hidden')).toBe(true);
    expect(h.state.providerSettings.customModel).toBe('');
  });
});
