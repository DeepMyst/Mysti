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
 * Two reported bugs: "the chat keeps switching back" and "tagging other agents
 * is not working". Both were real, and they share a theme — the panel changing
 * who is answering without the user asking, and without being told.
 *
 * These are source-level guards. The send path they protect lives inside an
 * 8k-line method that needs a live webview, a provider registry and a
 * conversation store to enter; a DOM test of it would test the harness. What
 * matters here is the ORDER of two branches and the SCOPE of two writes, and
 * both are visible in the shipped bytes.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/providers/ChatViewProvider.ts'), 'utf8');

describe('an explicit @mention outranks the Mysti coordinator', () => {
  it('the coordinator branch yields when another agent is named', () => {
    // The branch takes the whole message as a brief and returns, and the
    // mention router is BELOW it — so without this, tagging did nothing.
    expect(SRC).toContain('const mentionOutranksCoordinator = namesAnotherAgent && !mystiMatch;');
    expect(SRC).toMatch(
      /if \(\(mystiSelected \|\| mystiMatch\) && !mentionOutranksCoordinator/
    );
  });

  it('"@mysti" written explicitly still wins — it names the coordinator', () => {
    const at = SRC.indexOf('const namesAnotherAgent');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 400);
    expect(body).toContain("(m.value as string) !== 'mysti'");
    expect(SRC).toContain('namesAnotherAgent && !mystiMatch');
  });

  it('the coordinator is never left as the spawnable provider for the fallthrough', () => {
    // Two or more mention tasks fall through to the "main agent", and `mysti`
    // is a pseudo-agent with no backend.
    const at = SRC.indexOf('if (mentionOutranksCoordinator && mystiSelected)');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 500)).toContain('this._getPanelProvider(panelId)');
  });

  it('the coordinator branch still precedes the mention router in the file', () => {
    // If this ever inverts, the guard above is dead weight rather than wrong —
    // and the reader should know which shape they are looking at.
    expect(SRC.indexOf('const mystiSelected')).toBeLessThan(SRC.indexOf('if (legacyMentions.length > 0)'));
  });
});

describe('nothing changes the saved agent behind the user', () => {
  it('a "switch provider" mention writes per-panel, never to global settings', () => {
    const at = SRC.indexOf("chunk.taskDescription === 'switch provider'");
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 900);
    // One "use @qwen" used to rewrite mysti.defaultProvider for every window
    // and every workspace, permanently, with nothing said.
    expect(body).not.toContain("config.update('defaultProvider'");
    expect(body).toContain('settingsOverrides');
  });

  it('a demotion to an installed backend is announced', () => {
    const at = SRC.indexOf('let demotedFrom: string | undefined;');
    expect(at).toBeGreaterThan(-1);
    expect(SRC).toContain("if (demotedFrom && demotedFrom !== selectedProvider)");
    const notice = SRC.indexOf('if (demotedFrom && demotedFrom !== selectedProvider)');
    expect(SRC.slice(notice, notice + 900)).toContain("type: 'systemNotice'");
  });

  it('the demotion notice says the saved choice is untouched', () => {
    const at = SRC.indexOf('if (demotedFrom && demotedFrom !== selectedProvider)');
    const body = SRC.slice(at, at + 900);
    expect(body).toContain('Your saved choice is unchanged');
  });
});
