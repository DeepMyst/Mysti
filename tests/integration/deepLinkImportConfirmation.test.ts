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
 * Plan 27 §21.6c #11 / lane P (P-3) — the `vscode://DeepMyst.mysti/import?data=…`
 * deep link is UNAUTHENTICATED: any web page, chat message or e-mail can hand
 * the editor one. Lane G hardened what the payload can *contain*; this pins
 * that nothing is imported until the user has said so in a modal whose
 * non-confirming outcomes (Escape, Cancel, dialog dismissed, host returned
 * nothing) all deny. The handler is the exported `handleShareableImportLink`
 * that `activate()`'s UriHandler delegates to.
 *
 * `src/extension.ts` is imported for real; only `@vscode/extension-telemetry`
 * is mocked, because its CJS `require('vscode')` bypasses the vitest alias.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window } from '../helpers/mockVscode';

vi.mock('@vscode/extension-telemetry', () => ({
  default: class { sendTelemetryEvent() {} sendTelemetryErrorEvent() {} dispose() {} },
}));

import { handleShareableImportLink, SHAREABLE_IMPORT_CONFIRM } from '../../src/extension';
import type { Conversation } from '../../src/types';

const FAKE: Conversation = {
  id: 'c1', title: 'From a stranger', messages: [], createdAt: 1, updatedAt: 1,
  mode: 'ask-before-edit', model: 'unknown', provider: 'claude-code',
};

function deps() {
  return {
    importFromShareable: vi.fn<(data: string) => Conversation | null>(() => FAKE),
    onImported: vi.fn<(c: Conversation) => void>(),
  };
}

describe('deep-link import asks before importing (P-3)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shows a MODAL warning before touching the store, and the prompt names the import', async () => {
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const d = deps();
    await handleShareableImportLink('abc', d);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, options, ...items] = warn.mock.calls[0] as unknown as [string, { modal?: boolean }, ...Array<{ title: string; isCloseAffordance?: boolean }>];
    expect(options.modal).toBe(true);
    expect(message.toLowerCase()).toContain('import');
    // Cancel is the FIRST (default) button and owns the close affordance; the
    // confirming item is the only path that imports.
    expect(items[0].isCloseAffordance).toBe(true);
    expect(items.some(i => i.title === SHAREABLE_IMPORT_CONFIRM.title)).toBe(true);
    expect(items[0].title).not.toBe(SHAREABLE_IMPORT_CONFIRM.title);
    // The prompt closed with no choice (Escape / host dismissed it): nothing imported.
    expect(d.importFromShareable).not.toHaveBeenCalled();
    expect(d.onImported).not.toHaveBeenCalled();
  });

  it('Cancel denies; a foreign item denies; only the exact confirm item imports', async () => {
    const d1 = deps();
    vi.spyOn(window, 'showWarningMessage').mockImplementation((async (_m: string, _o: unknown, ...items: Array<{ title: string }>) => items[0]) as never);
    await handleShareableImportLink('abc', d1);
    expect(d1.importFromShareable).not.toHaveBeenCalled();

    const d2 = deps();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue({ title: SHAREABLE_IMPORT_CONFIRM.title } as never); // same title, different object
    await handleShareableImportLink('abc', d2);
    expect(d2.importFromShareable).not.toHaveBeenCalled();

    const d3 = deps();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(SHAREABLE_IMPORT_CONFIRM as never);
    const info = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await handleShareableImportLink('abc', d3);
    expect(d3.importFromShareable).toHaveBeenCalledWith('abc');
    expect(d3.onImported).toHaveBeenCalledWith(FAKE);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain(FAKE.title);
  });

  it('a confirmed but unparseable link reports an error and never calls onImported', async () => {
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(SHAREABLE_IMPORT_CONFIRM as never);
    const error = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const d = deps();
    d.importFromShareable.mockReturnValue(null);
    await handleShareableImportLink('garbage', d);
    expect(d.onImported).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a rejecting prompt is swallowed and logged with the [Mysti] prefix — never an unhandled rejection', async () => {
    vi.spyOn(window, 'showWarningMessage').mockRejectedValue(new Error('host gone') as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps();
    await expect(handleShareableImportLink('abc', d)).resolves.toBeUndefined();
    expect(d.importFromShareable).not.toHaveBeenCalled();
    expect(log.mock.calls.some(c => String(c[0]).startsWith('[Mysti]') && String(c.join(' ')).includes('host gone'))).toBe(true);
  });
});
