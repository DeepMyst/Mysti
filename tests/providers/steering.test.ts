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
 * Plan 28 Phase 2 — steering is capability-gated, and nothing has the capability.
 *
 * "Steering" is Codex's sense of the word: sending a NEW instruction into a
 * turn that is already streaming. Plan 28 Phase 2 gives the composer `Tab` to
 * queue (which needs no backend support) and `Enter` to steer (which needs a
 * great deal). This file pins the finding that made queueing the whole of
 * Phase 2's shipped behaviour:
 *
 *   - The single-shot path writes the prompt and calls `stdin.end()`. There is
 *     no pipe left to write into.
 *   - The persistent path leaves stdin open, but every persistent backend
 *     speaks a STRUCTURED protocol on it — Claude Code's `--input-format
 *     stream-json` (NDJSON), Hermes/Kimi's ACP (JSON-RPC over stdio). An
 *     unsolicited mid-turn write is not an interrupt there; it is one more
 *     token in a stream nobody is reading, and it corrupts the NEXT message.
 *     `BaseCliProvider._interruptPersistentProcess` records the same finding —
 *     it is why cancelling tears the process down instead of writing a byte.
 *
 * So `supportsSteering` is false everywhere. This is not a TODO: it is the
 * honest state, and the test exists so that flipping the flag requires
 * deleting an assertion and reading why it was there. Declaring it without a
 * real mid-turn input path would give the user a key that silently eats what
 * they typed — the "lying capability flag" class the Plan 27 audit found ten
 * of, and the same class `supportsPromptEnhancement` was introduced to close.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as vscode from 'vscode';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import type { ICliProvider } from '../../src/providers/base/IProvider';

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

describe('Plan 28 Phase 2 — steering capability', () => {
  let registry: ProviderRegistry;
  let providers: ICliProvider[];

  beforeAll(() => {
    registry = new ProviderRegistry(createMockContext());
    providers = registry.getIds()
      .map((id) => registry.get(id))
      .filter((p): p is ICliProvider => !!p);
  });

  it('covers every registered provider', () => {
    expect(providers.length).toBe(registry.getIds().length);
    expect(providers.length).toBeGreaterThanOrEqual(15);
  });

  it('no backend claims it can be steered mid-turn', () => {
    const claiming = providers
      .filter((p) => p.capabilities?.supportsSteering === true)
      .map((p) => p.id);
    // If this fails, a provider declared the flag. That is allowed ONLY if it
    // also implements a real mid-turn input path — see the header. Update the
    // composer's Enter branch in media/chat/chat.js in the same change, or the
    // key will be offered and do nothing.
    expect(claiming, `declared supportsSteering without a mid-turn input path: ${claiming.join(', ')}`)
      .toEqual([]);
  });

  it('the single-shot send path still closes stdin, which is why', () => {
    // The structural reason, asserted rather than described. If stdin ever stops
    // being closed, mid-turn input becomes possible on the one-shot path and
    // this whole file should be revisited.
    //
    // The close moved out of the send path and into `_deliverPrompt`, the hook
    // OpenClaw overrides because `openclaw agent` reads its prompt from
    // --message-file and ignores the pipe entirely. It still ends the pipe.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/providers/base/BaseCliProvider.ts'), 'utf8');

    const hook = src.slice(src.indexOf('protected async _deliverPrompt'));
    expect(hook, 'the _deliverPrompt hook is gone — where does the prompt go now?')
      .toContain('proc.stdin.end()');

    // …and the send path still routes through it rather than writing its own.
    expect(src).toContain('await this._deliverPrompt(proc, fullPrompt, session)');
  });

  /**
   * A provider that overrides prompt delivery must still close stdin: an open
   * pipe holds the child forever, and a half-open one would quietly reintroduce
   * the mid-turn input path this file exists to rule out.
   */
  it('every _deliverPrompt override ends stdin too', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const dir = path.resolve(__dirname, '../../src/providers');

    const offenders: string[] = [];
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) { continue; }
      for (const file of fs.readdirSync(path.join(dir, sub.name))) {
        if (!file.endsWith('.ts')) { continue; }
        const full = path.join(dir, sub.name, file);
        const src = fs.readFileSync(full, 'utf8');
        const at = src.indexOf('_deliverPrompt(');
        if (at === -1 || !src.includes('override async _deliverPrompt')) { continue; }
        const body = src.slice(at, at + 1400);
        if (!/stdin\?\.end\(\)|stdin\.end\(\)/.test(body)) {
          offenders.push(`${sub.name}/${file}`);
        }
      }
    }
    expect(offenders, 'these override prompt delivery without closing stdin').toEqual([]);
  });
});

describe('Plan 28 Phase 2 — the composer queues instead', () => {
  const CHAT_JS = (() => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    return fs.readFileSync(path.resolve(__dirname, '../../media/chat/chat.js'), 'utf8');
  })();

  it('Tab and Enter both queue while a turn is in flight', () => {
    expect(CHAT_JS).toContain("if (state.isLoading && !e.shiftKey && (e.key === 'Tab' || e.key === 'Enter'))");
    expect(CHAT_JS).toContain('enqueueMessage(inputEl.value)');
  });

  it('drains on responseComplete and NOT on cancel', () => {
    // Firing the next queued message at the backend right after the user
    // pressed Escape is the opposite of what Escape meant.
    const complete = CHAT_JS.indexOf("case 'responseComplete':");
    const cancelled = CHAT_JS.indexOf("case 'requestCancelled':");
    const drain = CHAT_JS.indexOf('drainQueue();', complete);
    expect(complete).toBeGreaterThan(-1);
    expect(cancelled).toBeGreaterThan(complete);
    expect(drain).toBeGreaterThan(complete);
    expect(drain).toBeLessThan(cancelled);
    expect(CHAT_JS.slice(cancelled, cancelled + 1200)).not.toContain('drainQueue()');
  });

  it('never disables the composer input', () => {
    // The whole point of the phase: the input stays live for the length of a turn.
    expect(CHAT_JS).not.toMatch(/inputEl\.disabled\s*=\s*(true|on)\b/);
  });
});
