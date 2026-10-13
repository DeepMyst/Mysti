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
 * The `vscode://DeepMyst.mysti/prompt?text=…` deep link is UNAUTHENTICATED in
 * the same way `/import` is: any web page, chat message or e-mail can hand the
 * editor one. This pins what it may do — place text in the chat box, after a
 * modal whose non-confirming outcomes all deny — and what it may never do:
 * act without that answer, carry what a reader cannot see, or lose the rest of
 * a sentence at its first `&`.
 *
 * `src/extension.ts` is imported for real; only `@vscode/extension-telemetry`
 * is mocked, because its CJS `require('vscode')` bypasses the vitest alias.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window } from '../helpers/mockVscode';

vi.mock('@vscode/extension-telemetry', () => ({
  TelemetryReporter: class { sendTelemetryEvent() {} sendTelemetryErrorEvent() {} dispose() {} },
}));

import {
  cleanPromptLinkText,
  handlePromptLink,
  promptLinkText,
  PROMPT_LINK_CONFIRM,
  PROMPT_LINK_MAX_CHARS,
} from '../../src/extension';

function deps() {
  return { insertPrompt: vi.fn<(text: string) => void>() };
}

describe('deep-link prompt asks before it touches the chat box', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shows a MODAL warning that previews the text, and a dismissed prompt places nothing', async () => {
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const d = deps();
    await handlePromptLink('Fix the price on the case screen', d);

    expect(warn).toHaveBeenCalledTimes(1);
    const [, options, ...items] = warn.mock.calls[0] as unknown as [string, { modal?: boolean; detail?: string }, ...Array<{ title: string; isCloseAffordance?: boolean }>];
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('Fix the price on the case screen');
    // Cancel is the FIRST (default) button and owns the close affordance.
    expect(items[0].isCloseAffordance).toBe(true);
    expect(items[0].title).not.toBe(PROMPT_LINK_CONFIRM.title);
    expect(items.some(i => i.title === PROMPT_LINK_CONFIRM.title)).toBe(true);
    expect(d.insertPrompt).not.toHaveBeenCalled();
  });

  it('Cancel denies; a look-alike item denies; only the exact confirm item places the text, once', async () => {
    const d1 = deps();
    vi.spyOn(window, 'showWarningMessage').mockImplementation((async (_m: string, _o: unknown, ...items: Array<{ title: string }>) => items[0]) as never);
    await handlePromptLink('hello', d1);
    expect(d1.insertPrompt).not.toHaveBeenCalled();

    const d2 = deps();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue({ title: PROMPT_LINK_CONFIRM.title } as never); // same title, different object
    await handlePromptLink('hello', d2);
    expect(d2.insertPrompt).not.toHaveBeenCalled();

    const d3 = deps();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(PROMPT_LINK_CONFIRM as never);
    await handlePromptLink('  hello\nworld  ', d3);
    expect(d3.insertPrompt).toHaveBeenCalledTimes(1);
    expect(d3.insertPrompt).toHaveBeenCalledWith('hello\nworld');
  });

  it('an empty link asks nothing, and an over-long one is refused without asking', async () => {
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(PROMPT_LINK_CONFIRM as never);
    const error = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);

    const empty = deps();
    await handlePromptLink(' \n ', empty);
    expect(warn).not.toHaveBeenCalled();
    expect(empty.insertPrompt).not.toHaveBeenCalled();

    const long = deps();
    await handlePromptLink('x'.repeat(PROMPT_LINK_MAX_CHARS + 1), long);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(long.insertPrompt).not.toHaveBeenCalled();

    const atTheLimit = deps();
    await handlePromptLink('x'.repeat(PROMPT_LINK_MAX_CHARS), atTheLimit);
    expect(atTheLimit.insertPrompt).toHaveBeenCalledTimes(1);
  });

  it('what a reader cannot see is gone before the modal shows it or the box takes it', async () => {
    // Composed from code points so no invisible character sits in this file.
    const override = String.fromCodePoint(0x202e);
    const isolate = String.fromCodePoint(0x2066);
    const bell = String.fromCodePoint(0x07);
    const joiner = String.fromCodePoint(0x200d); // Arabic and Persian spell with it — kept
    expect(cleanPromptLinkText(`a${override}b${isolate}c${bell}d\te\nf${joiner}g`)).toBe(`abcd\te\nf${joiner}g`);

    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(PROMPT_LINK_CONFIRM as never);
    const d = deps();
    await handlePromptLink(`delete${override} nothing`, d);
    const [, options] = warn.mock.calls[0] as unknown as [string, { detail?: string }];
    expect(options.detail).toContain('delete nothing');
    expect(d.insertPrompt).toHaveBeenCalledWith('delete nothing');
  });

  it('a rejecting prompt is swallowed and logged with the [Mysti] prefix — never an unhandled rejection', async () => {
    vi.spyOn(window, 'showWarningMessage').mockRejectedValue(new Error('host gone') as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps();
    await expect(handlePromptLink('hello', d)).resolves.toBeUndefined();
    expect(d.insertPrompt).not.toHaveBeenCalled();
    expect(log.mock.calls.some(c => String(c[0]).startsWith('[Mysti]') && String(c.join(' ')).includes('host gone'))).toBe(true);
  });
});

describe('the text of a /prompt link survives the editor decoding its query', () => {
  it('everything after text= is the text — an & in a sentence does not end it', () => {
    // What the editor hands over for `…/prompt?text=Driver%20%26%20car%20%2B%20100%25`.
    expect(promptLinkText('text=Driver & car + 100%')).toBe('Driver & car + 100%');
    expect(promptLinkText('text=a=b&c=d')).toBe('a=b&c=d');
  });

  it('a query that is not text= carries no prompt', () => {
    expect(promptLinkText('')).toBeNull();
    expect(promptLinkText('data=abc')).toBeNull();
    expect(promptLinkText('other=1&text=late')).toBeNull();
  });
});
