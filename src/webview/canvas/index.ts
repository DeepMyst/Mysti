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
 * Plan 22 3.4 - entry point for `dist/canvasWebview.js` (webpack `target:'web'`).
 *
 * This is the file that replaces `media/canvas/canvas.js`: 297 untyped lines
 * that hand-mirrored `CanvasSandbox.ts`, rebuilt every iframe on every update
 * (and on every window resize), mutated device/theme locally and posted
 * nothing, and were exercised by exactly one test - a `new Function(js)` parse
 * check, because nothing could import them.
 *
 * Everything with a decision in it lives in a typed, unit-tested module, and
 * the wiring between them lives in `app.ts` - which takes its DOM by injection
 * and is therefore covered headlessly too. What is left here is the bootstrap:
 * read the boot payload, acquire the VS Code API, start the app. It is the only
 * part a test cannot reach, so it is the only part kept this thin.
 */

import { readBoot } from './boot';
import { realEnv } from './dom';
import { CanvasApp } from './app';

interface VsCodeApi { postMessage(message: unknown): void }

declare function acquireVsCodeApi(): VsCodeApi;

function main(): void {
  const boot = readBoot(globalThis);
  if (!boot) {
    console.warn('[Mysti] canvas: no boot payload; the shell was not rendered by canvasContent.ts');
    return;
  }
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  if (!api) {
    console.warn('[Mysti] canvas: no VS Code API; running inert');
    return;
  }
  new CanvasApp({ boot, env: realEnv(), post: m => api.postMessage(m) }).start();
}

main();
