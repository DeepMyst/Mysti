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
 * Unit tests for VisualTestManager dev-server lifecycle (Plan 18 Wave 4 item 1.2).
 *
 * The old startVisualTest deliberately never stopped the dev server it spawned
 * ("Don't auto-stop dev server"), and the model-triggered HEADLESS flow has no
 * UI affordance to stop it — so servers piled up over a session. These tests
 * pin the fix:
 *   - a dev server the TEST started (config.devServerCommand, none tracked for
 *     the panel beforehand) is stopped in the finally when the test completes
 *   - a server that was ALREADY running before the test (user-started) is left
 *     running
 *   - no devServerCommand → the dev server manager is never touched
 *   - a half-started server (spawned but never became ready) is cleaned up on
 *     the startup-failure path too
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VisualTestManager } from '../../src/managers/VisualTestManager';
import type { VisualTestConfig, VisualTestStreamChunk, Settings, StreamChunk } from '../../src/types';

function makeConfig(overrides: Partial<VisualTestConfig> = {}): VisualTestConfig {
  return {
    url: 'http://localhost:3000',
    requirements: 'The page renders correctly',
    maxIterations: 1,
    screenshotMode: 'viewport',
    browser: 'chromium',
    headless: true,
    viewportWidth: 1280,
    viewportHeight: 720,
    interactionsEnabled: false,
    ...overrides,
  };
}

/** Provider manager whose AI immediately passes the test (single iteration). */
function makeProviderManager() {
  return {
    getProviderInstance: vi.fn().mockReturnValue({ capabilities: { supportsImages: false } }),
    async *sendMessage(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', content: 'Looks correct.\n```verdict\npass\n```' } as StreamChunk;
    },
  };
}

function makeManager() {
  const mgr = new VisualTestManager({} as never);

  const devServer = {
    isRunning: vi.fn().mockReturnValue(false),
    getUrl: vi.fn().mockReturnValue('http://localhost:3000'),
    start: vi.fn().mockResolvedValue({ url: 'http://localhost:3000', pid: 1 }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    launch: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockReturnValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const screenshot = {
    capture: vi.fn().mockResolvedValue({ id: 'shot-1', base64Data: '' }),
    getDomSnapshot: vi.fn().mockResolvedValue('<div id="app"></div>'),
  };

  // Replace the internally-constructed collaborators with fakes.
  (mgr as unknown as { _devServer: unknown })._devServer = devServer;
  (mgr as unknown as { _browser: unknown })._browser = browser;
  (mgr as unknown as { _screenshot: unknown })._screenshot = screenshot;

  return { mgr, devServer, browser, screenshot };
}

async function runTest(
  mgr: VisualTestManager,
  panelId: string,
  config: VisualTestConfig
): Promise<VisualTestStreamChunk[]> {
  const providerManager = makeProviderManager();
  const settings = { provider: 'claude-code' } as Settings;
  const chunks: VisualTestStreamChunk[] = [];
  for await (const chunk of mgr.startVisualTest(panelId, config, providerManager as never, settings)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('VisualTestManager dev-server lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the dev server it started when the test completes (headless orphan fix)', async () => {
    const { mgr, devServer, browser } = makeManager();
    devServer.isRunning.mockReturnValue(false); // nothing running before the test

    const chunks = await runTest(mgr, 'vt-headless-1', makeConfig({ devServerCommand: 'npm run dev' }));

    expect(devServer.start).toHaveBeenCalledTimes(1);
    // The server the test spawned must be stopped at completion.
    expect(devServer.stop).toHaveBeenCalledWith('vt-headless-1');
    expect(browser.close).toHaveBeenCalledWith('vt-headless-1');
    expect(chunks.at(-1)?.type).toBe('visual_test_complete');
    expect(chunks.at(-1)?.report?.summary.verdict).toBe('pass');
  });

  it('leaves a dev server that was already running before the test (user-started)', async () => {
    const { mgr, devServer } = makeManager();
    devServer.isRunning.mockReturnValue(true); // pre-existing server for this panel

    const chunks = await runTest(mgr, 'vt-dashboard-1', makeConfig({ devServerCommand: 'npm run dev' }));

    // Existing behaviour preserved: the pre-existing server is NOT auto-stopped.
    expect(devServer.stop).not.toHaveBeenCalled();
    // W4 review: a user-started server is REUSED, never replaced by start().
    expect(devServer.start).not.toHaveBeenCalled();
    expect(chunks.at(-1)?.type).toBe('visual_test_complete');
  });

  it('never touches the dev server when no devServerCommand is configured', async () => {
    const { mgr, devServer } = makeManager();

    const chunks = await runTest(mgr, 'vt-headless-2', makeConfig());

    expect(devServer.start).not.toHaveBeenCalled();
    expect(devServer.stop).not.toHaveBeenCalled();
    expect(chunks.at(-1)?.type).toBe('visual_test_complete');
  });

  it('cleans up a half-started server when startup fails (never became ready)', async () => {
    const { mgr, devServer, browser } = makeManager();
    devServer.isRunning.mockReturnValue(false);
    devServer.start.mockRejectedValue(new Error('Dev server did not become ready within 30s'));

    const chunks = await runTest(mgr, 'vt-headless-3', makeConfig({ devServerCommand: 'npm run dev' }));

    expect(chunks.some((c) => c.type === 'visual_test_error')).toBe(true);
    // The spawned-but-never-ready process is test-owned → stopped.
    expect(devServer.stop).toHaveBeenCalledWith('vt-headless-3');
    expect(browser.close).toHaveBeenCalledWith('vt-headless-3');
  });

  it('does not fail the test when stopping the test-owned server throws', async () => {
    const { mgr, devServer } = makeManager();
    devServer.isRunning.mockReturnValue(false);
    devServer.stop.mockRejectedValue(new Error('kill failed'));

    const chunks = await runTest(mgr, 'vt-headless-4', makeConfig({ devServerCommand: 'npm run dev' }));

    expect(devServer.stop).toHaveBeenCalledWith('vt-headless-4');
    expect(chunks.at(-1)?.type).toBe('visual_test_complete');
  });
});
