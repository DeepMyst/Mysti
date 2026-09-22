/** Actual installed Chromium, loopback-only document, private screenshot storage. */
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { AddressInfo, Socket } from 'net';
import type { Page } from 'playwright';
import { VisualSessionManager, type LookOptions } from '../../src/managers/VisualSessionManager';
import { BrowserManager } from '../../src/services/BrowserManager';
import { ScreenshotService } from '../../src/services/ScreenshotService';
import { VisualOperationCancelled } from '../../src/services/VisualOperation';
import type { VisualResolution } from '../../src/services/visualTestPolicy';
import { CHROMIUM_UNAVAILABLE } from '../webview/chromiumAvailability';

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() }; }
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]).sort();
}
async function fixture() {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Connection': 'close' });
    response.end('<!doctype html><html><body><h1 id="ready">Owned local fixture</h1></body></html>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const directory = mkdtempSync(path.join(tmpdir(), 'mysti-visual-browser-'));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = new VisualSessionManager({ storageDir: () => directory, readyPattern: () => undefined });
  const resolution: VisualResolution = {
    config: { url, requirements: '', maxIterations: 1, screenshotMode: 'viewport', browser: 'chromium', headless: true,
      viewportWidth: 200, viewportHeight: 100, interactionsEnabled: false },
    allowedOrigins: [url], devCommandSource: 'none', interactionPolicy: 'off', denials: [],
  };
  const internal = manager as unknown as {
    _browser: BrowserManager; _screenshot: ScreenshotService; _sessions: Map<string, { resourceKey: string }>;
  };
  const run = (panel: string, id: string, overrides: Partial<LookOptions> = {}) => {
    const abort = new AbortController();
    const target = { cacheKey: `mysti:${panel}`, panelId: panel, ownerKey: id };
    const options: LookOptions = {
      operation: { id, panelId: panel, ownerKey: id, workspaceRoot: directory, workspaceIdentity: 'fixed-local-policy',
        signal: abort.signal, isCurrent: () => !abort.signal.aborted },
      approveDevServer: async () => { throw new Error('The fixture never starts a dev server'); }, reload: false, ...overrides,
    };
    return { abort, target, options, look: () => manager.look(target, resolution, options) };
  };
  return { manager, internal, resolution, directory, run,
    page: (panel: string): Page => internal._browser.getPage(internal._sessions.get(`mysti:${panel}`)!.resourceKey),
    async dispose() {
      try { await manager.dispose(); }
      finally {
        for (const socket of sockets) { socket.destroy(); }
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

describe('active visual cancellation in installed Chromium', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE).each(['selector', 'screenshot'] as const)(
    'closes the captured browser during %s, preserves its sibling, and refuses a stale screenshot commit', async boundary => {
      const h = await fixture(); const entered = deferred();
      let pending: Promise<unknown> | undefined;
      try {
        const first = h.run('a', 'first');
        const positive = await first.look();
        expect(positive.screenshotPath).toBeTruthy(); expect(positive.sequence).toBe(1);
        await h.run('b', 'sibling').look();
        const ownedPage = h.page('a'); const siblingPage = h.page('b');
        const before = files(h.directory);
        const next = h.run('a', 'second', boundary === 'selector' ? { waitFor: '#never-appears' } : {});
        if (boundary === 'selector') {
          const actual = ownedPage.waitForSelector.bind(ownedPage);
          vi.spyOn(ownedPage, 'waitForSelector').mockImplementation((...args) => { entered.resolve(); return actual(...args); });
        } else {
          const actual = h.internal._screenshot.capture.bind(h.internal._screenshot);
          vi.spyOn(h.internal._screenshot, 'capture').mockImplementation((...args) => { entered.resolve(); return actual(...args); });
        }
        pending = next.look();
        const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }));
        await Promise.race([entered.promise, outcome.then(result => {
          if ('error' in result) { throw result.error; }
          throw new Error('Observation completed before the intended cancellation boundary');
        })]);
        first.abort.abort(); // The completed parent's old lease cannot kill reuse.
        expect(ownedPage.isClosed()).toBe(false);
        const stoppedAt = Date.now(); next.abort.abort();
        expect(await outcome).toMatchObject({ error: expect.any(VisualOperationCancelled) });
        expect(Date.now() - stoppedAt).toBeLessThan(5000);
        expect(ownedPage.isClosed()).toBe(true);
        expect(ownedPage.context().browser()?.isConnected()).toBe(false);
        expect(h.manager.hasSession('mysti:a')).toBe(false);
        expect(files(h.directory)).toEqual(before);
        expect(siblingPage.isClosed()).toBe(false);
        expect(await siblingPage.locator('#ready').textContent()).toBe('Owned local fixture');
        expect(h.manager.hasSession('mysti:b')).toBe(true);
      } finally { await h.dispose(); await Promise.allSettled(pending ? [pending] : []); vi.restoreAllMocks(); }
    }, 30_000,
  );
});
