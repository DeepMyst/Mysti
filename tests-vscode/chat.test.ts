import * as QUnit from 'qunit';
import { test, timeout } from './acceptance';
/** Real editor chat acceptance through a loopback Ollama fixture; no model account. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Locator } from 'playwright';

interface RequestRecord { marker: string; prompt: string; closed: boolean }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

QUnit.module('Mysti Chat — real VS Code host and loopback provider', hooks => {
  timeout(hooks, 90_000);
  let browser: Browser;
  let endpointUrl: string;
  let sidebar: Frame;
  let testFailed = false;
  QUnit.testStart(() => { testFailed = false; });
  QUnit.log(result => { if (!result.result) { testFailed = true; } });
  async function requests(): Promise<RequestRecord[]> {
    const response = await fetch(`${endpointUrl}/__fixture/requests`);
    assert.strictEqual(response.status, 200);
    return await response.json() as RequestRecord[];
  }

  async function isClosed(marker: string): Promise<boolean> {
    return (await requests()).find(request => request.marker === marker)?.closed === true;
  }

  async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { if (await check()) { return; } await pause(100); }
    assert.fail(message);
  }

  async function chatFrames(): Promise<Frame[]> {
    const frames: Frame[] = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          if (await frame.locator('#message-input').count()) { frames.push(frame); }
        }
      }
    }
    return frames;
  }

  async function click(frame: Frame, target: string | Locator): Promise<void> {
    await frame.page().bringToFront();
    // Editor notifications can cover a webview's composer, especially after
    // opening its second panel. Use the real workbench dismiss command before
    // the ordinary pointer action, so Playwright still checks hit targeting.
    await vscode.commands.executeCommand('notifications.hideToasts');
    await frame.page().locator('.notifications-toasts.visible').waitFor({ state: 'hidden' });
    await (typeof target === 'string' ? frame.locator(target) : target).click();
  }

  async function selectOllama(frame: Frame): Promise<void> {
    await frame.locator('#init-loading-overlay').waitFor({ state: 'hidden' });
    // The fresh profile selects Ollama. Wait for the host's initial state;
    // opening a menu during that update races its intentional re-render.
    try {
      await until(async () => (await frame.locator('#agent-name').innerText()).includes('Ollama'), 'The configured Ollama selection did not reach the webview');
    } catch (error) {
      console.log('[Mysti chat setup failure]', await frame.evaluate(() => ({
        agent: document.getElementById('agent-name')?.textContent,
        provider: (document.getElementById('provider-select') as HTMLSelectElement)?.value,
        trace: (window as unknown as { __mystiAcceptanceTrace?: unknown[] }).__mystiAcceptanceTrace?.slice(-30),
        messages: document.getElementById('messages')?.textContent?.slice(-1500),
        overlay: document.getElementById('init-loading-overlay')?.outerHTML,
      })));
      throw error;
    }
    // A fresh profile can show onboarding when its discovery snapshot has no
    // ready provider, even though the configured loopback service is now up.
    // Complete that ordinary UI flow before exercising the composer. Never
    // force clicks through the wizard or hide it by mutating the DOM.
    const wizard = frame.locator('#setup-wizard');
    if (await wizard.isVisible()) {
      await click(frame, wizard.locator('.wizard-skip-btn'));
      await wizard.waitFor({ state: 'hidden' });
    }
  }

  async function send(frame: Frame, marker: string): Promise<RequestRecord> {
    // A native click focuses the actual editor webview before composing. A
    // programmatic fill alone can leave macOS's first click as activation only.
    await click(frame, '#message-input');
    await frame.locator('#message-input').fill(`MYSTI_FIXTURE:${marker}`);
    await click(frame, '#send-btn');
    await until(async () => (await requests()).some(request => request.marker === marker), `No provider request for ${marker}`);
    return (await requests()).find(request => request.marker === marker)!;
  }

  hooks.before(async () => {
    const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
    assert.ok(profile, 'chat acceptance requires the fresh profile created by .vscode-test.mjs');
    endpointUrl = process.env.MYSTI_TEST_OLLAMA_ENDPOINT!;
    assert.match(endpointUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'the runner must start an isolated loopback model fixture');
    await fetch(`${endpointUrl}/__fixture/reset`, { method: 'POST' });
    await vscode.extensions.getExtension('DeepMyst.mysti')!.activate();
    const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    // Inspect the editor's existing context without changing its download or
    // emulation settings. Electron 27 does not implement context management.
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`, { noDefaults: true });
    await vscode.commands.executeCommand('mysti.openChat');
    await until(async () => (await chatFrames()).length > 0, 'Chat webview did not open');
    sidebar = (await chatFrames())[0];
    await sidebar.evaluate(() => {
      const trace: unknown[] = [];
      (window as unknown as { __mystiAcceptanceTrace: unknown[] }).__mystiAcceptanceTrace = trace;
      window.addEventListener('message', event => trace.push({ type: event.data?.type }));
      document.getElementById('send-btn')!.addEventListener('click', () => trace.push({
        type: 'send-click', value: (document.getElementById('message-input') as HTMLTextAreaElement).value,
      }), true);
    });
    await selectOllama(sidebar);
  });

  hooks.afterEach(async function () {
    try {
      if (testFailed && sidebar && !sidebar.isDetached()) {
        console.log('[Mysti chat acceptance failure]', await sidebar.evaluate(() => ({
          trace: (window as unknown as { __mystiAcceptanceTrace?: unknown[] }).__mystiAcceptanceTrace?.slice(-30),
          agent: document.getElementById('agent-name')?.textContent,
          messages: document.getElementById('messages')?.textContent?.slice(-1500),
          input: (document.getElementById('message-input') as HTMLTextAreaElement)?.value,
        })));
      }
    } finally {
      if (browser && endpointUrl) {
        const frames = await chatFrames();
        try {
          if (testFailed) {
            for (const frame of frames) {
              if (await frame.locator('#stop-btn').isVisible()) { await click(frame, '#stop-btn'); }
            }
          }
          // Successful cases must settle themselves; do not let fixture reset
          // turn an unfinished request into an apparently successful test.
          await until(async () => (await requests()).every(request => request.closed), 'Chat case left a provider connection open');
          for (const frame of frames) {
            await until(async () => await frame.locator('#send-btn').isVisible() && await frame.locator('#send-btn').isEnabled(), 'Chat case left its composer busy');
          }
        } finally {
          // Even when a failed pointer action prevents Stop, release every
          // held fixture response so that the next case cannot inherit it.
          const response = await fetch(`${endpointUrl}/__fixture/reset`, { method: 'POST' });
          assert.strictEqual(response.status, 200);
          for (const frame of frames) {
            if (frame.isDetached()) { continue; }
            await until(async () => await frame.locator('#send-btn').isVisible() && await frame.locator('#send-btn').isEnabled(), 'Fixture cleanup did not release the composer');
          }
        }
      }
    }
  });

  hooks.after(async () => {
    if (endpointUrl) { await fetch(`${endpointUrl}/__fixture/reset`, { method: 'POST' }); }
    await browser?.close();
  });

  test('streams a normal response through the chat webview', async () => {
    await send(sidebar, 'first');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer first.'), 'Streamed answer was not rendered');
    await until(async () => await sidebar.locator('#send-btn').isEnabled(), 'The completed turn did not release Send');
  });

  test('replays history and Stop closes the active HTTP stream', async () => {
    const request = await send(sidebar, 'hold-stop');
    assert.ok(request.prompt.includes('Fixture answer first.'), 'prior assistant history was omitted');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer hold-stop.'), 'Partial answer was not rendered');
    assert.strictEqual(await isClosed(request.marker), false);
    await click(sidebar, '#stop-btn');
    await until(() => isClosed(request.marker), 'Stop left the provider connection open');
  });

  test('restores a saved conversation through the history picker', async () => {
    await click(sidebar, '#new-conversation-btn');
    await until(async () => !(await sidebar.locator('#messages').innerText()).includes('Fixture answer first.'), 'New conversation retained the old timeline');
    await click(sidebar, '#history-btn');
    await click(sidebar, sidebar.locator('.history-item').filter({ hasText: 'MYSTI_FIXTURE:first' }));
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer first.'), 'History did not restore the saved answer');
  });

  test('keeps two panels independent when one stream is stopped', async () => {
    const first = await send(sidebar, 'hold-sidebar');
    await vscode.commands.executeCommand('mysti.openInNewTab');
    await until(async () => (await chatFrames()).some(frame => frame !== sidebar), 'Second chat panel did not open');
    const tab = (await chatFrames()).find(frame => frame !== sidebar)!;
    await selectOllama(tab);
    const second = await send(tab, 'hold-tab');
    assert.strictEqual(await isClosed(first.marker), false, 'Opening another panel cancelled the first');
    assert.strictEqual(await isClosed(second.marker), false);
    await click(tab, '#stop-btn');
    await until(() => isClosed(second.marker), 'Second panel Stop left its stream open');
    assert.strictEqual(await isClosed(first.marker), false, 'Second panel Stop cancelled the first panel');
    await click(sidebar, '#stop-btn');
    await until(() => isClosed(first.marker), 'First panel Stop left its stream open');
  });

  test('recovers from a provider error without leaving the composer locked', async () => {
    await send(sidebar, 'service-error');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture service unavailable'), 'Provider failure was not shown');
    await until(async () => await sidebar.locator('#send-btn').isVisible(), 'Provider failure left Send hidden');
    await send(sidebar, 'recovered');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer recovered.'), 'The next turn did not recover');
  });
});
