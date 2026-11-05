import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

describe('streaming transcript scroll ownership in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const history = Array.from({ length: 40 }, (_, index) => `History paragraph ${index}.`).join('\n\n');
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = [];
    page = await browser.newPage({ viewport: { width: 700, height: 700 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent(composeChatHtml());
    await page.evaluate(initial => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'initialState', payload: initial },
    })), { ...INITIAL_STATE, panelId: 'scroll-owner', conversation: { id: 'original', messages: [] } });
    await page.evaluate(() => {
      const messages = document.getElementById('messages')!;
      const nativeHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!.get!;
      const probe = {
        reads: 0,
        measuredHeights: [] as number[],
        emit(type: string, payload?: unknown) {
          window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
        },
        reset() { this.reads = 0; this.measuredHeights = []; },
        frame: () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())),
        // Assertion reads call the native getter directly, so they never count
        // as an application measurement. No fake clock or speed threshold.
        position: () => ({ top: messages.scrollTop, height: nativeHeight.call(messages), client: messages.clientHeight }),
      };
      Object.defineProperty(messages, 'scrollHeight', { configurable: true, get() {
        const height = nativeHeight.call(this);
        probe.reads++;
        probe.measuredHeights.push(height);
        return height;
      } });
      (window as any).__scrollProbe = probe;
    });
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('coalesces text bursts while every chunk immediately updates the Markdown DOM', async () => {
    const result = await page.evaluate(async () => {
      const p = (window as any).__scrollProbe;
      p.emit('responseStarted', { provider: 'openai-codex' });
      p.reset();
      let content = '', immediate = true;
      for (let index = 0; index < 40; index++) {
        const chunk = `**Paragraph ${index}**\n\n`;
        content += chunk;
        p.emit('responseChunk', { type: 'text', content: chunk });
        const segment = document.querySelector('.message.streaming .message-content') as any;
        immediate = immediate && segment?._markdownSource === content &&
          segment.querySelectorAll('strong').length === index + 1;
      }
      const before = { reads: p.reads, immediate };
      await p.frame();
      const first = { reads: p.reads, position: p.position() };
      p.reset();
      p.emit('responseChunk', { type: 'text', content: '**Next frame**\n\n' });
      const nextImmediate = document.querySelector('.message.streaming .message-content')!.textContent!.includes('Next frame');
      const secondBefore = p.reads;
      await p.frame();
      const second = { reads: p.reads, position: p.position() };
      await p.frame();
      return { before, first, nextImmediate, secondBefore, second, settledReads: p.reads };
    });
    expect(result.before).toEqual({ reads: 0, immediate: true });
    expect(result.first.reads).toBe(1);
    expect(result.first.position.height).toBeGreaterThan(result.first.position.client);
    expect(result.first.position.top).toBeCloseTo(result.first.position.height - result.first.position.client, 0);
    expect(result.nextImmediate).toBe(true);
    expect(result.secondBefore).toBe(0);
    expect(result.second.reads).toBe(1);
    expect(result.second.position.top).toBeCloseTo(result.second.position.height - result.second.position.client, 0);
    expect(result.settledReads).toBe(1);
  });

  for (const terminal of ['responseComplete', 'requestCancelled', 'payloadless cancellation']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${terminal}: flushes the owned final DOM once and leaves no late scroll`, async () => {
      const result = await page.evaluate(async ({ terminal, history }) => {
        const p = (window as any).__scrollProbe;
        p.emit('responseStarted', { provider: 'openai-codex' });
        p.reset();
        const partial = terminal === 'payloadless cancellation' ? history : 'Short partial.';
        p.emit('responseChunk', { type: 'text', content: partial });
        const before = p.reads;
        if (terminal !== 'responseComplete') (document.getElementById('stop-btn') as HTMLButtonElement).click();
        const afterStop = p.reads;
        const final = { id: 'final', role: 'assistant', provider: 'openai-codex', content: history + '\n\n**Final suffix**' };
        p.emit(terminal === 'payloadless cancellation' ? 'requestCancelled' : terminal,
          terminal === 'payloadless cancellation' ? undefined : { message: final });
        const immediate = { reads: p.reads, measuredHeights: p.measuredHeights.slice(), position: p.position(),
          streaming: document.querySelectorAll('.message.streaming').length,
          content: document.querySelector('.message.assistant .message-body')!.textContent!,
          stopHidden: document.getElementById('stop-btn')!.style.display === 'none' };
        await p.frame();
        const afterFrame = p.reads;
        // A terminal scroll must not later pull a reader back down the page.
        document.getElementById('messages')!.scrollTop = 0;
        await p.frame();
        return { before, afterStop, immediate, afterFrame, finalTop: p.position().top,
          cancelPosted: (window as any).__posted.some((entry: any) => entry.type === 'cancelRequest') };
      }, { terminal, history });
      expect(result.before).toBe(0);
      expect(result.afterStop).toBe(0);
      expect(result.immediate.reads).toBe(1);
      expect(result.immediate.measuredHeights).toEqual([result.immediate.position.height]);
      expect(result.immediate.position.height).toBeGreaterThan(result.immediate.position.client);
      expect(result.immediate.position.top).toBeCloseTo(result.immediate.position.height - result.immediate.position.client, 0);
      expect(result.immediate.streaming).toBe(0);
      expect(result.immediate.stopHidden).toBe(true);
      expect(result.immediate.content).toContain(terminal === 'payloadless cancellation' ? 'History paragraph 39.' : 'Final suffix');
      expect(result.cancelPosted).toBe(terminal !== 'responseComplete');
      expect(result.afterFrame).toBe(1);
      expect(result.finalTop).toBe(0);
    });
  }

  for (const transition of ['conversationChanged', 'initialState']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${transition}: a queued old bubble cannot scroll the replacement transcript`, async () => {
      const result = await page.evaluate(async ({ transition, history, initial }) => {
        const p = (window as any).__scrollProbe;
        p.emit('responseStarted', { provider: 'openai-codex' });
        p.emit('responseChunk', { type: 'text', content: 'Old pending answer.' });
        const old = document.querySelector('.message.streaming')!;
        // Reusing the conversation id also covers authoritative same-chat reload.
        const conversation = { id: transition === 'initialState' ? 'original' : 'replacement', messages: [
          { id: 'restored', role: 'assistant', provider: 'openai-codex', content: history },
        ] };
        p.emit(transition, transition === 'initialState' ? { ...initial, panelId: 'rebound-owner', conversation } : conversation);
        const messages = document.getElementById('messages')!;
        messages.scrollTop = 0;
        p.reset();
        await p.frame();
        return { reads: p.reads, position: p.position(), oldConnected: old.isConnected,
          restored: document.querySelector('[data-id="restored"]')!.textContent!.includes('History paragraph 39.') };
      }, { transition, history, initial: INITIAL_STATE });
      expect(result.reads).toBe(0);
      expect(result.position.height).toBeGreaterThan(result.position.client);
      expect(result.position.top).toBe(0);
      expect(result.oldConnected).toBe(false);
      expect(result.restored).toBe(true);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('a new turn invalidates a still-connected old bubble and owns its own later scroll', async () => {
    const result = await page.evaluate(async history => {
      const p = (window as any).__scrollProbe;
      p.emit('responseStarted', { provider: 'openai-codex' });
      p.emit('responseChunk', { type: 'text', content: history });
      const old = document.querySelector('.message.streaming')!;
      p.emit('responseStarted', { provider: 'openai-codex' });
      document.getElementById('messages')!.scrollTop = 0;
      p.reset();
      await p.frame();
      const beforeNewText = { reads: p.reads, top: p.position().top, oldConnected: old.isConnected,
        oldStreaming: old.classList.contains('streaming') };
      p.emit('responseChunk', { type: 'text', content: '**New turn**' });
      const newBubble = document.querySelector('.message.streaming')!;
      await p.frame();
      return { beforeNewText, distinctOwner: newBubble !== old, reads: p.reads, position: p.position(),
        newContent: newBubble.textContent!.includes('New turn') };
    }, history);
    expect(result.beforeNewText).toEqual({ reads: 0, top: 0, oldConnected: true, oldStreaming: false });
    expect(result.distinctOwner).toBe(true);
    expect(result.newContent).toBe(true);
    expect(result.reads).toBe(1);
    expect(result.position.top).toBeCloseTo(result.position.height - result.position.client, 0);
  });

  for (const terminal of ['error', 'authError']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${terminal}: the existing terminal-card scroll consumes the pending text scroll`, async () => {
      const result = await page.evaluate(async ({ terminal, history }) => {
        const p = (window as any).__scrollProbe;
        p.emit('responseStarted', { provider: 'openai-codex' });
        p.emit('responseChunk', { type: 'text', content: history });
        p.reset();
        const message = { id: 'partial', role: 'assistant', provider: 'openai-codex', content: history };
        p.emit(terminal, terminal === 'error' ? { error: 'Controlled failure', message } :
          { providerId: 'openai-codex', providerName: 'Codex', authCommand: 'codex login', message });
        const immediate = { reads: p.reads, position: p.position() };
        document.getElementById('messages')!.scrollTop = 0;
        await p.frame();
        return { immediate, reads: p.reads, top: p.position().top };
      }, { terminal, history });
      expect(result.immediate.reads).toBe(1);
      expect(result.immediate.position.top).toBeCloseTo(result.immediate.position.height - result.immediate.position.client, 0);
      expect(result.reads).toBe(1);
      expect(result.top).toBe(0);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('a disposed page cancels its pending scroll', async () => {
    const result = await page.evaluate(async history => {
      const p = (window as any).__scrollProbe;
      p.emit('responseStarted', { provider: 'openai-codex' });
      p.emit('responseChunk', { type: 'text', content: history });
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      document.getElementById('messages')!.scrollTop = 0;
      p.reset();
      await p.frame();
      return { reads: p.reads, top: p.position().top };
    }, history);
    expect(result).toEqual({ reads: 0, top: 0 });
  });
});
