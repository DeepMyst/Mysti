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
 * Plan 25 — coordinator failure classification.
 *
 * The classifier decides WHICH BUTTONS a failed Mysti turn shows. Two things
 * matter and are pinned here:
 *   1. A 401 is not always DeepMyst's fault. On the OpenRouter opt-in path the
 *      old message told the user to "sign in to DeepMyst again", advice that
 *      fixes nothing.
 *   2. "No credential" (signin) and "credential rejected" (auth-rejected) are
 *      different actions — the second has to DROP the stale key first.
 */
import { describe, it, expect } from 'vitest';
import { classifyCoordinatorFailure } from '../../src/services/CoordinatorModelClient';

const SIGNED_IN = { hasDeepMystKey: true, usingOpenRouter: false };
const SIGNED_OUT = { hasDeepMystKey: false, usingOpenRouter: false };
const OPENROUTER = { hasDeepMystKey: false, usingOpenRouter: true };

describe('classifyCoordinatorFailure (Plan 25)', () => {
  it('maps a 401/403 with a stored key to auth-rejected (the key went stale)', () => {
    expect(classifyCoordinatorFailure('HTTP 401 Unauthorized', SIGNED_IN)).toBe('auth-rejected');
    expect(classifyCoordinatorFailure('403 forbidden', SIGNED_IN)).toBe('auth-rejected');
    expect(classifyCoordinatorFailure('invalid api key', SIGNED_IN)).toBe('auth-rejected');
  });

  it('maps the same failure with NO stored key to signin', () => {
    expect(classifyCoordinatorFailure('HTTP 401 Unauthorized', SIGNED_OUT)).toBe('signin');
    expect(classifyCoordinatorFailure('no auth credentials found', SIGNED_OUT)).toBe('signin');
  });

  it('blames OpenRouter when the run used the OpenRouter opt-in path', () => {
    // The regression this exists for: a rejected `sk-or-…` key used to be
    // reported as a DeepMyst sign-in problem.
    expect(classifyCoordinatorFailure('HTTP 401 Unauthorized', OPENROUTER)).toBe('openrouter-rejected');
    expect(
      classifyCoordinatorFailure('401 invalid api key', { hasDeepMystKey: true, usingOpenRouter: true }),
    ).toBe('openrouter-rejected');
  });

  it('treats payment failures as credits, whichever credential is in play', () => {
    expect(classifyCoordinatorFailure('HTTP 402 payment required', SIGNED_IN)).toBe('credits');
    expect(classifyCoordinatorFailure('insufficient credits', SIGNED_IN)).toBe('credits');
    expect(classifyCoordinatorFailure('you are out of credits', OPENROUTER)).toBe('credits');
  });

  it('prefers credits over auth when a 402 body also mentions the key', () => {
    // Gateway 402 bodies routinely name the account/key; "top up" and "sign in
    // again" are different buttons, and the wrong one wastes the user's time.
    expect(
      classifyCoordinatorFailure('402 payment required: api key has insufficient balance', SIGNED_IN),
    ).toBe('credits');
  });

  it('leaves everything else as an ordinary error', () => {
    expect(classifyCoordinatorFailure('429 rate limited', SIGNED_IN)).toBe('other');
    expect(classifyCoordinatorFailure('502 provider returned error', SIGNED_IN)).toBe('other');
    expect(classifyCoordinatorFailure('fetch failed', SIGNED_IN)).toBe('other');
    expect(classifyCoordinatorFailure('context length exceeded', SIGNED_IN)).toBe('other');
    expect(classifyCoordinatorFailure('', SIGNED_IN)).toBe('other');
  });

  it('does not mistake a 400/404 for an auth failure', () => {
    expect(classifyCoordinatorFailure('400 bad request', SIGNED_IN)).toBe('other');
    expect(classifyCoordinatorFailure('404 model not found', SIGNED_IN)).toBe('other');
  });
});
