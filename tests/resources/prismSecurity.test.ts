/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const bundle = fs.readFileSync(path.resolve(__dirname, '../../resources/prism-bundle.js'), 'utf8');

describe('vendored Prism security', () => {
  it('does not trust a DOM-clobbered document.currentScript', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    try {
      const image = dom.window.document.createElement('img');
      image.src = 'https://attacker.invalid/prism.js';
      Object.defineProperty(dom.window.document, 'currentScript', { value: image, configurable: true });
      dom.window.eval(bundle);
      expect(dom.window.Prism.util.currentScript()).toBeNull();
      expect(dom.window.Prism.filename).toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it('preserves JavaScript syntax highlighting after updating the core', () => {
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    try {
      dom.window.eval(bundle);
      const prism = dom.window.Prism;
      expect(prism.highlight('const answer = 42;', prism.languages.javascript, 'javascript'))
        .toContain('<span class="token keyword">const</span>');
    } finally {
      dom.window.close();
    }
  });
});
