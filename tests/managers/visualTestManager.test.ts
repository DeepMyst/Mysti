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
 * VisualSessionManager — the warm dev-server + browser session.
 *
 * This replaces the old `VisualTestManager.startVisualTest` suite. That method
 * drove its OWN `providerManager.sendMessage` under a synthetic panel id and
 * consumed the resulting `tool_use` chunks only to render display strings, so
 * `_shouldGateToolUse` — the extension's only stream-level permission gate —
 * never saw the stream and every write/bash it performed was ungated. The loop
 * is gone; visual testing is now a perception primitive.
 *
 * The dev-server OWNERSHIP contract pinned by the old suite is preserved and
 * re-pinned here: a server this session started is stopped on close; a server
 * that was already running is the user's and is left alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VisualSessionManager } from '../../src/managers/VisualSessionManager';
import { VisualTestManager } from '../../src/managers/VisualTestManager';
import type { VisualResolution } from '../../src/services/visualTestPolicy';

function resolution(overrides: Partial<VisualResolution> = {}): VisualResolution {
  return {
    config: {
      url: 'http://localhost:3000',
      requirements: '',
      maxIterations: 5,
      screenshotMode: 'viewport',
      browser: 'chromium',
      headless: true,
      viewportWidth: 1280,
      viewportHeight: 720,
      interactionsEnabled: false,
    },
    allowedOrigins: ['http://localhost'],
    devCommandSource: 'none',
    interactionPolicy: 'off',
    denials: [],
    ...overrides,
  };
}

function makeManager(opts: { approveDevServer?: boolean } = {}) {
  const approveDevServer = vi.fn().mockResolvedValue(opts.approveDevServer ?? true);
  const mgr = new VisualSessionManager({
    approveDevServer,
    storageDir: () => '/tmp/mysti-test',
    workspaceRoot: () => '/repo',
    readyPattern: () => undefined,
  });

  const page = {
    url: vi.fn().mockReturnValue('http://localhost:3000'),
    on: vi.fn(),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    accessibility: { snapshot: vi.fn().mockResolvedValue(null) },
    evaluate: vi.fn().mockResolvedValue([]),
  };
  const devServer = {
    isRunning: vi.fn().mockReturnValue(false),
    start: vi.fn().mockResolvedValue({ url: 'http://localhost:3000', pid: 1 }),
    stop: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    probe: vi.fn().mockResolvedValue({ module: true, browser: true }),
    launch: vi.fn().mockResolvedValue(page),
    getPage: vi.fn().mockReturnValue(page),
    isOpen: vi.fn().mockReturnValue(true),
    navigate: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const screenshot = {
    capture: vi.fn().mockResolvedValue({ id: 's1', filePath: '/tmp/s1.png', base64Data: 'AA' }),
    getDomSnapshot: vi.fn().mockResolvedValue('<div id="app"></div>'),
  };

  const inject = (k: string, v: unknown) => { (mgr as unknown as Record<string, unknown>)[k] = v; };
  inject('_devServer', devServer);
  inject('_browser', browser);
  inject('_screenshot', screenshot);

  return { mgr, devServer, browser, screenshot, page, approveDevServer };
}

describe('the ungated inner agent is gone for good', () => {
  it('VisualSessionManager never references a provider stream', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/managers/VisualSessionManager.ts', 'utf8'));
    // A regression here would re-open the CRITICAL permission-gate bypass.
    expect(src).not.toMatch(/providerManager/);
    expect(src).not.toMatch(/sendMessage/);
  });

  it('VisualTestManager no longer exposes the loop entry point', () => {
    const mgr = new VisualTestManager({} as never);
    expect((mgr as unknown as Record<string, unknown>).startVisualTest).toBeUndefined();
    expect((mgr as unknown as Record<string, unknown>).buildAgentFeedbackSummary).toBeUndefined();
  });
});

describe('warm session reuse', () => {
  let h: ReturnType<typeof makeManager>;
  beforeEach(() => { h = makeManager(); });

  it('starts the dev server and launches the browser exactly ONCE across two looks', async () => {
    const r = resolution({ devCommand: 'npm run dev', devCommandSource: 'settings' });
    await h.mgr.look('p1', r);
    await h.mgr.look('p1', r);

    expect(h.devServer.start).toHaveBeenCalledTimes(1);
    expect(h.browser.launch).toHaveBeenCalledTimes(1);
    // Only the first look pays startup; the second is a reload + capture.
    expect(h.screenshot.capture).toHaveBeenCalledTimes(2);
  });

  it('asks for dev-server approval only once per session', async () => {
    const r = resolution({ devCommand: 'npm run dev', devCommandSource: 'settings' });
    await h.mgr.look('p1', r);
    await h.mgr.look('p1', r);
    expect(h.approveDevServer).toHaveBeenCalledTimes(1);
  });

  it('reloads on a repeat look so a code fix is actually observed', async () => {
    const r = resolution();
    await h.mgr.look('p1', r);
    await h.mgr.look('p1', r);
    expect(h.browser.reload).toHaveBeenCalled();
  });

  it('a bare look STAYS on the current page instead of navigating to the app root', async () => {
    // `look` with no path is documented as "show me where we are". Falling back
    // to the resolved base URL would yank the session back to `/` and quietly
    // undo whatever an earlier `act` had navigated to.
    h.page.url.mockReturnValue('http://localhost:3000/settings');
    await h.mgr.look('p1', resolution());
    await h.mgr.look('p1', resolution());
    expect(h.browser.navigate).not.toHaveBeenCalled();
    expect(h.browser.reload).toHaveBeenCalled();
  });

  it('navigates when — and only when — a destination was named', async () => {
    h.page.url.mockReturnValue('http://localhost:3000/settings');
    await h.mgr.look('p1', resolution());
    await h.mgr.look('p1', resolution(), { url: 'http://localhost:3000/billing' });
    expect(h.browser.navigate).toHaveBeenCalledWith('p1', 'http://localhost:3000/billing');
  });

  it('increments the sequence number per look', async () => {
    const r = resolution();
    const a = await h.mgr.look('p1', r);
    const b = await h.mgr.look('p1', r);
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
  });
});

describe('dev-server ownership contract', () => {
  it('STOPS a server this session started', async () => {
    const h = makeManager();
    await h.mgr.look('p1', resolution({ devCommand: 'npm run dev', devCommandSource: 'settings' }));
    await h.mgr.close('p1');
    expect(h.devServer.stop).toHaveBeenCalledWith('p1');
  });

  it('LEAVES a server that was already running before the session', async () => {
    const h = makeManager();
    h.devServer.isRunning.mockReturnValue(true);
    await h.mgr.look('p1', resolution({ devCommandSource: 'already-running' }));
    await h.mgr.close('p1');
    expect(h.devServer.start).not.toHaveBeenCalled();
    expect(h.devServer.stop).not.toHaveBeenCalled();
  });

  it('never touches the dev server when no command is configured', async () => {
    const h = makeManager();
    await h.mgr.look('p1', resolution());
    expect(h.devServer.start).not.toHaveBeenCalled();
  });

  it('aborts the look when the user declines the dev server', async () => {
    const h = makeManager({ approveDevServer: false });
    await expect(
      h.mgr.look('p1', resolution({ devCommand: 'npm run dev', devCommandSource: 'settings' }))
    ).rejects.toThrow(/declined/i);
    expect(h.devServer.start).not.toHaveBeenCalled();
    expect(h.browser.launch).not.toHaveBeenCalled();
  });
});

describe('Playwright availability is probed before anything is spawned', () => {
  it('refuses without starting a dev server when the browser binary is missing', async () => {
    const h = makeManager();
    h.browser.probe.mockResolvedValue({ module: true, browser: false, hint: 'Run: npx playwright install chromium' });
    await expect(
      h.mgr.look('p1', resolution({ devCommand: 'npm run dev', devCommandSource: 'settings' }))
    ).rejects.toThrow(/npx playwright install/);
    expect(h.devServer.start).not.toHaveBeenCalled();
  });
});

describe('interactions', () => {
  it('fails CLOSED when no approver is supplied', async () => {
    const h = makeManager();
    const obs = await h.mgr.look('p1', resolution({ interactionPolicy: 'safe' }), {
      actions: [{ action: 'click', target: '#save' }],
    });
    expect(obs.actionsPerformed).toBeUndefined();
    expect(obs.denials?.join(' ')).toMatch(/declined/i);
  });

  it('does not run interactions when the policy is off', async () => {
    const h = makeManager();
    const approve = vi.fn().mockResolvedValue(true);
    const obs = await h.mgr.look('p1', resolution({ interactionPolicy: 'off' }), {
      actions: [{ action: 'click', target: '#save' }],
      approveInteractions: approve,
    });
    expect(approve).not.toHaveBeenCalled();
    expect(obs.denials?.join(' ')).toMatch(/disabled/i);
  });

  it('reports unrecognised actions instead of executing them', async () => {
    const h = makeManager();
    const approve = vi.fn().mockResolvedValue(true);
    const obs = await h.mgr.look('p1', resolution({ interactionPolicy: 'safe' }), {
      actions: [{ action: 'evaluate', value: 'alert(1)' }],
      approveInteractions: approve,
    });
    // Nothing valid survived normalization, so approval is never even sought.
    expect(approve).not.toHaveBeenCalled();
    expect(obs.denials?.join(' ')).toMatch(/unrecognised action/i);
  });

  it('caps the action batch', async () => {
    const h = makeManager();
    const approve = vi.fn().mockResolvedValue(true);
    const many = Array.from({ length: 20 }, () => ({ action: 'hover', target: '#x' }));
    const obs = await h.mgr.look('p1', resolution({ interactionPolicy: 'safe' }), {
      actions: many,
      approveInteractions: approve,
    });
    expect(approve.mock.calls[0][0]).toHaveLength(8);
    expect(obs.denials?.join(' ')).toMatch(/first 8 actions/i);
  });
});

describe('single-flight', () => {
  it('refuses a concurrent look on the same key rather than closing the first browser', async () => {
    const h = makeManager();
    let release: () => void = () => {};
    h.screenshot.capture.mockImplementation(() => new Promise(res => {
      release = () => res({ id: 's', filePath: '/tmp/s.png', base64Data: '' });
    }));

    const first = h.mgr.look('p1', resolution());
    await new Promise(r => setTimeout(r, 5));
    await expect(h.mgr.look('p1', resolution())).rejects.toThrow(/already in progress/i);
    release();
    await first;
  });
});

describe('disposal', () => {
  it('closing a panel closes its sessions', async () => {
    const h = makeManager();
    await h.mgr.look('mysti:p1', resolution({ devCommand: 'npm run dev', devCommandSource: 'settings' }));
    await h.mgr.closeForPanel('mysti:p1');
    expect(h.browser.close).toHaveBeenCalledWith('mysti:p1');
  });

  it('VisualTestManager.dispose cascades to the attached session manager', async () => {
    const vtm = new VisualTestManager({} as never);
    const sessions = {
      dispose: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      closeForPanel: vi.fn().mockResolvedValue(undefined),
      isDevServerRunning: vi.fn().mockReturnValue(false),
    };
    vtm.attachSessionManager(sessions);
    await vtm.dispose();
    expect(sessions.dispose).toHaveBeenCalled();
  });
});
