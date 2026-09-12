/** Real editor chat acceptance through a loopback Ollama fixture; no model account. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame } from 'playwright';

interface RequestRecord { marker: string; prompt: string; closed: boolean }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('Mysti Chat — real VS Code host and loopback provider', function () {
  this.timeout(90_000);
  let browser: Browser;
  let endpointUrl: string;
  let sidebar: Frame;
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
  }

  async function send(frame: Frame, marker: string): Promise<RequestRecord> {
    // A native click focuses the actual editor webview before composing. A
    // programmatic fill alone can leave macOS's first click as activation only.
    await frame.page().bringToFront();
    await frame.locator('#message-input').click();
    await frame.locator('#message-input').fill(`MYSTI_FIXTURE:${marker}`);
    await frame.locator('#send-btn').click();
    await until(async () => (await requests()).some(request => request.marker === marker), `No provider request for ${marker}`);
    return (await requests()).find(request => request.marker === marker)!;
  }

  before(async () => {
    const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
    assert.ok(profile, 'chat acceptance requires the fresh profile created by .vscode-test.mjs');
    endpointUrl = process.env.MYSTI_TEST_OLLAMA_ENDPOINT!;
    assert.match(endpointUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'the runner must start an isolated loopback model fixture');
    await fetch(`${endpointUrl}/__fixture/reset`, { method: 'POST' });
    await vscode.extensions.getExtension('DeepMyst.mysti')!.activate();
    const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
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

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed' || !sidebar) { return; }
    console.log('[Mysti chat acceptance failure]', await sidebar.evaluate(() => ({
      trace: (window as unknown as { __mystiAcceptanceTrace?: unknown[] }).__mystiAcceptanceTrace?.slice(-30),
      agent: document.getElementById('agent-name')?.textContent,
      messages: document.getElementById('messages')?.textContent?.slice(-1500),
      input: (document.getElementById('message-input') as HTMLTextAreaElement)?.value,
    })));
  });

  after(async () => {
    if (endpointUrl) { await fetch(`${endpointUrl}/__fixture/reset`, { method: 'POST' }); }
    await browser?.close();
  });

  it('streams a normal response through the chat webview', async () => {
    await send(sidebar, 'first');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer first.'), 'Streamed answer was not rendered');
    await until(async () => await sidebar.locator('#send-btn').isEnabled(), 'The completed turn did not release Send');
  });

  it('replays history and Stop closes the active HTTP stream', async () => {
    const request = await send(sidebar, 'hold-stop');
    assert.ok(request.prompt.includes('Fixture answer first.'), 'prior assistant history was omitted');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer hold-stop.'), 'Partial answer was not rendered');
    assert.strictEqual(await isClosed(request.marker), false);
    await sidebar.locator('#stop-btn').click();
    await until(() => isClosed(request.marker), 'Stop left the provider connection open');
  });

  it('restores a saved conversation through the history picker', async () => {
    await sidebar.locator('#new-conversation-btn').click();
    await until(async () => !(await sidebar.locator('#messages').innerText()).includes('Fixture answer first.'), 'New conversation retained the old timeline');
    await sidebar.locator('#history-btn').click();
    await sidebar.locator('.history-item').filter({ hasText: 'MYSTI_FIXTURE:first' }).click();
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer first.'), 'History did not restore the saved answer');
  });

  it('keeps two panels independent when one stream is stopped', async () => {
    const first = await send(sidebar, 'hold-sidebar');
    await vscode.commands.executeCommand('mysti.openInNewTab');
    await until(async () => (await chatFrames()).some(frame => frame !== sidebar), 'Second chat panel did not open');
    const tab = (await chatFrames()).find(frame => frame !== sidebar)!;
    await selectOllama(tab);
    const second = await send(tab, 'hold-tab');
    assert.strictEqual(await isClosed(first.marker), false, 'Opening another panel cancelled the first');
    assert.strictEqual(await isClosed(second.marker), false);
    await tab.locator('#stop-btn').click();
    await until(() => isClosed(second.marker), 'Second panel Stop left its stream open');
    assert.strictEqual(await isClosed(first.marker), false, 'Second panel Stop cancelled the first panel');
    await sidebar.locator('#stop-btn').click();
    await until(() => isClosed(first.marker), 'First panel Stop left its stream open');
  });

  it('recovers from a provider error without leaving the composer locked', async () => {
    await send(sidebar, 'service-error');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture service unavailable'), 'Provider failure was not shown');
    await until(async () => await sidebar.locator('#send-btn').isVisible(), 'Provider failure left Send hidden');
    await send(sidebar, 'recovered');
    await until(async () => (await sidebar.locator('#messages').innerText()).includes('Fixture answer recovered.'), 'The next turn did not recover');
  });
});
