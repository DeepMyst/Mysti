/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 Phase 5 — the coordinator honours the selected persona and skills.
 *
 * `AgentContextManager.buildPromptContext` had exactly ONE caller —
 * `BaseCliProvider` — so the 20 bundled personas, 16 skills and 6 roles reached
 * the fifteen CLI backends and NOT `@mysti`, which is the DEFAULT agent. A user
 * could pick "security" in the agent panel, switch to the coordinator, and be
 * silently ignored.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'providers', 'ChatViewProvider.ts'), 'utf-8');

describe('the coordinator builds agent context', () => {
  it('calls the SAME builder the CLI path uses — not a second implementation', () => {
    expect(SRC).toContain('this._agentContextManager.buildPromptContext(agentConfig)');
  });

  it('reads the conversation the run was given, not a global', () => {
    const idx = SRC.indexOf('let agentPersonaContext');
    expect(idx).toBeGreaterThan(-1);
    expect(SRC.slice(idx, idx + 900)).toContain('getAgentConfig(conversationId)');
  });

  it('honours the two-tier contract: trusted first, untrusted appended', () => {
    const idx = SRC.indexOf('let agentPersonaContext');
    const body = SRC.slice(idx, idx + 900);
    // The untrusted block must never PREFIX the verified one.
    expect(body).toContain("(ctx.systemPrompt ?? '') + (ctx.untrustedBlock ?? '')");
  });

  it('never fails a turn over persona assembly', () => {
    const idx = SRC.indexOf('let agentPersonaContext');
    const body = SRC.slice(idx, idx + 1100);
    expect(body).toContain('catch');
    expect(body).toMatch(/continuing without it/);
  });

  it('lands AFTER the operating protocol, so a persona cannot restate the rules', () => {
    const protocol = SRC.indexOf('this._mystiAgenticSystemPrompt(');
    const persona = SRC.indexOf('agentPersonaContext ? [{ role:');
    expect(protocol).toBeGreaterThan(-1);
    expect(persona).toBeGreaterThan(protocol);
  });

  it('adds no message at all when nothing is selected', () => {
    // An empty context must not push an empty system message.
    expect(SRC).toContain("...(agentPersonaContext ? [{ role: 'system' as const, content: agentPersonaContext }] : [])");
  });
});
