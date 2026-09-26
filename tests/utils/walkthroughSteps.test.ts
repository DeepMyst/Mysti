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
 * Plan 32 — the Get Started walkthrough. The old one sent "Set up a provider"
 * to Settings, and its "Send your first message" step completed on the same
 * event as "Open the panel", so it ticked itself.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ext = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
const steps: Array<{ id: string; description: string; completionEvents?: string[]; media: { svg?: string } }> =
  pkg.contributes.walkthroughs[0].steps;
const contributed = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));

describe('the Get Started walkthrough', () => {
  it('every command link names a command Mysti contributes and registers', () => {
    const links = steps.flatMap((s) => [...s.description.matchAll(/\(command:([\w.]+)/g)].map((m) => [s.id, m[1]]));
    expect(links.length).toBeGreaterThanOrEqual(steps.length);
    for (const [step, id] of links) {
      expect(contributed.has(id), `${step} links to ${id}, which package.json does not contribute`).toBe(true);
      expect(ext, `${id} is never registered`).toContain(`registerCommand('${id}'`);
    }
  });

  it('no two steps complete on the same event', () => {
    const seen = new Map<string, string>();
    for (const s of steps) {
      for (const e of s.completionEvents ?? []) {
        expect(seen.get(e), `${s.id} and ${seen.get(e)} both complete on ${e}`).toBeUndefined();
        seen.set(e, s.id);
      }
    }
  });

  it('connecting completes on the readiness key the host sets', () => {
    const connect = steps.find((s) => s.id === 'mysti.walkthrough.connect');
    expect(connect?.completionEvents).toEqual(['onContext:mysti.agentReady']);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'ChatViewProvider.ts'), 'utf8');
    expect(src).toContain("'setContext', 'mysti.agentReady'");
  });

  it('the mode step opens the wizard on the mode step', () => {
    const mode = steps.find((s) => s.id === 'mysti.walkthrough.mode');
    expect(mode?.description).toContain('command:mysti.getStarted?%5B%22mode%22%5D');
  });

  it('uses theme-aware SVG media and is no longer a marketing funnel', () => {
    for (const s of steps) { expect(s.media.svg, `${s.id} media`).toMatch(/^media\/walkthrough\/[a-z]+\.svg$/); }
    expect(steps.map((s) => s.id)).not.toContain('mysti.walkthrough.star');
    for (const s of steps) {
      const svg = fs.readFileSync(path.join(ROOT, s.media.svg!), 'utf8');
      expect(svg, `${s.media.svg} hardcodes a colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
      expect(svg).toContain('var(--vscode-');
    }
  });
});
