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
 * Plan 27 lane M (§21.6c #8) — a SYNCHRONOUS Chromium availability probe for
 * the real-browser suites (`tests/webview/*Browser*.test.ts`).
 *
 * `it.skipIf(cond)` evaluates at collection time, before any `beforeAll`, so
 * the probe cannot be "try to launch". It asks Playwright where the browser
 * it would launch lives and checks the filesystem:
 *
 *  - `chromium.executablePath()` names the FULL Chromium build
 *    (`<cache>/chromium-<rev>/…`).
 *  - `chromium.launch()` in headless mode — the default; none of these suites
 *    pass `channel` — runs the separate "chromium headless shell" build that
 *    is installed beside it as `<cache>/chromium_headless_shell-<rev>/…`.
 *    https://playwright.dev/docs/browsers#chromium-headless-shell — "Playwright
 *    ships a regular Chromium build for headed operations and a separate
 *    chromium headless shell for headless mode."
 *
 * So the directory that must exist is the headless shell's, derived from the
 * revision in the executable path; where the layout is not the standard cache
 * layout we fall back to checking the executable itself. Missing => the suite
 * is SKIPPED locally (vitest counts it). CI sets MYSTI_REQUIRE_CHROMIUM=1
 * so missing browsers fail collection. Present-but-broken =>
 * the launch throws in `beforeAll`, a real failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

/** `<cache>/chromium_headless_shell-<rev>` for a `<cache>/chromium-<rev>/…` executable, else null. */
export function expectedHeadlessShellDir(executablePath: string): string | null {
  const m = /^(.*)[\\/]chromium-(\d+)[\\/]/.exec(executablePath);
  if (!m) { return null; }
  return path.join(m[1], `chromium_headless_shell-${m[2]}`);
}

/** Why Chromium cannot be launched here, or null when it can. */
export function chromiumUnavailableReason(): string | null {
  let exe: string;
  try {
    exe = chromium.executablePath();
  } catch (err) {
    return `playwright could not resolve a Chromium executable: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!exe) { return 'playwright reported no Chromium executable'; }
  const shellDir = expectedHeadlessShellDir(exe);
  if (shellDir) {
    if (fs.existsSync(shellDir)) { return null; }
    return `Chromium headless shell missing at ${shellDir} — run: npx playwright install chromium`;
  }
  if (fs.existsSync(exe)) { return null; }
  return `Chromium missing at ${exe} — run: npx playwright install chromium`;
}

/** CI requires browser coverage; local contributors may run without a browser. */
export function enforceChromiumRequirement(reason: string | null, required = process.env.MYSTI_REQUIRE_CHROMIUM): void {
  if (reason && required === '1') {
    throw new Error(`[Mysti] Chromium is required for this test run: ${reason}`);
  }
}

/** Non-null reason when the browser suites must skip; probed once at module load. */
export const CHROMIUM_UNAVAILABLE: string | null = chromiumUnavailableReason();

enforceChromiumRequirement(CHROMIUM_UNAVAILABLE);

if (CHROMIUM_UNAVAILABLE) {
  console.warn(`[Mysti] browser suites SKIPPED — ${CHROMIUM_UNAVAILABLE}`);
}
