import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, '../../media/chat/streamingTimeline.js'), 'utf8');
const windows: JSDOM[] = [];
interface Message { type: string; requestId?: string; scope?: string; payload?: Record<string, unknown> }
interface Timeline {
  prepare(): string;
  reserveCommand(): string;
  admit(message: Message): { accepted: boolean; terminal?: boolean; foreground?: boolean; element?: HTMLElement };
  append(chunk: { type: string; content: string }): boolean;
  beforeTool(): HTMLElement | null;
  thinkingFor(element: HTMLElement): string;
  synthesis(content: string): void;
  finish(message: Record<string, unknown>): HTMLElement | null;
  currentElement(): HTMLElement | null;
  currentRequestId(): string | null;
  capture(): unknown;
  isCurrent(capture: unknown): boolean;
  reset(): void;
  dispose(): void;
}
function harness() {
  const dom = new JSDOM('<main id="messages"></main>', { runScripts: 'outside-only' });
  windows.push(dom);
  const document = dom.window.document;
  const messages = document.getElementById('messages')!;
  const fallback = { provider: 'selected', model: 'picker' };
  const formatContent = (value: string) => { const p = document.createElement('p'); p.textContent = value; return p.outerHTML; };
  const appendFinal = vi.fn((msg: Record<string, unknown>) => {
    const element = document.createElement('div'); element.className = 'message assistant';
    element.innerHTML = '<div class="message-model-info"></div><div class="message-body"><div class="message-content"></div></div>';
    element.querySelector('.message-content')!.innerHTML = formatContent(String(msg.content || ''));
    messages.appendChild(element); return element;
  });
  const renderThinkingZone = vi.fn((body: HTMLElement, style: string, text: string) => {
    let zone = body.querySelector<HTMLElement>('.thinking-zone');
    if (!zone) { zone = document.createElement('div'); zone.className = 'thinking-zone'; body.appendChild(zone); }
    zone.dataset.style = style; zone.textContent += text;
  });
  const ports = { document, getMessagesElement: () => messages, fallbackAttribution: () => fallback,
    formatAttributionLabel: (a: typeof fallback) => `${a.provider} / ${a.model || ''}`,
    formatContent, stripChannelMarkers: (s: string) => s.replace('[[channel]]', ''),
    renderThinkingZone, getThinkingStyle: (provider: string) => provider,
    updateMessageAttributionChip: (el: HTMLElement, msg: Record<string, unknown>) => {
      if (msg.model) { el.querySelector('.message-model-info')!.textContent = String(msg.model); }
    }, appendFinal, scroll: vi.fn() };
  dom.window.eval(source);
  const timeline = (dom.window as unknown as { MystiStreamingTimeline: { create(ports: unknown): Timeline } }).MystiStreamingTimeline.create(ports);
  const pending = (id: string, sequence = 1) => timeline.admit({ type: 'responsePending', requestId: id, payload: { sequence } });
  const begin = (id: string, payload = { provider: 'actual', model: 'resolved' }) => timeline.admit({ type: 'responseStarted', requestId: id, payload });
  const active = () => { const id = timeline.prepare(); expect(pending(id).accepted).toBe(true); expect(begin(id).accepted).toBe(true); return id; };
  const frame = (type: string, id?: string, payload?: Record<string, unknown>) => timeline.admit({ type, requestId: id, payload });
  return { timeline, document, messages, fallback, appendFinal, renderThinkingZone, pending, begin, active, frame };
}
afterEach(() => windows.splice(0).forEach(dom => dom.window.close()));

describe('foreground streaming timeline owner', () => {
  it.each(['visualTestMiniStatus', 'visualTestDashboardUpdate'])(
    'admits %s only with captured visual scope and a current eligible parent', type => {
      const h = harness(); const id = h.active();
      const visual = (requestId?: string, scope?: string) => h.timeline.admit({ type, requestId, scope });
      expect(visual(id).accepted).toBe(false);
      expect(visual(undefined, 'accessory').accepted).toBe(false);
      expect(visual(id, 'accessory')).toEqual({ accepted: true, foreground: false });
      h.frame('responseComplete', id);
      expect(visual(id, 'accessory')).toEqual({ accepted: true, foreground: false });
      const next = h.timeline.prepare();
      expect(visual(id, 'accessory').accepted).toBe(false);
      // A dedicated human operation remains independent of the new chat turn.
      expect(visual(undefined, 'notice')).toEqual({ accepted: true, foreground: false });
      expect(h.timeline.currentRequestId()).toBe(next);
      h.timeline.reset();
      expect(visual(next, 'accessory').accepted).toBe(false);
      expect(visual(undefined).accepted).toBe(false);
    },
  );
  it.each(['requestCancelled', 'error', 'authError', 'jobStarted', 'mystiUnavailable', 'mystiSignInRequired', 'mystiActionRequired'])(
    'refuses visual accessories after %s without reviving the parent', terminal => {
      const h = harness(); const id = h.active();
      h.frame(terminal, id, { terminal: true });
      expect(h.frame('responseComplete', id).accepted).toBe(false);
      for (const type of ['visualTestMiniStatus', 'visualTestDashboardUpdate']) {
        expect(h.timeline.admit({ type, requestId: id, scope: 'accessory' }).accepted).toBe(false);
      }
      expect(h.messages.children).toHaveLength(0);
    },
  );
  it('keeps local intent ahead of unrelated pending without poisoning its sequence', () => {
    const h = harness(); const id = h.timeline.prepare();
    expect(h.pending('unrelated', 99).accepted).toBe(false);
    expect(h.pending(id, 1).accepted).toBe(true);
    expect(h.begin(id).accepted).toBe(true);
    expect(h.timeline.currentRequestId()).toBe(id);
  });
  it('admits fresh host followups by increasing sequence but never repeated pending/start', () => {
    const h = harness(); expect(h.pending('host-a').accepted).toBe(true); h.begin('host-a');
    expect(h.frame('responseComplete', 'host-a').accepted).toBe(true);
    expect(h.pending('host-a').accepted).toBe(false);
    expect(h.pending('host-a', 2).accepted).toBe(false);
    expect(h.begin('host-a').accepted).toBe(false);
    expect(h.pending('host-b', 2).accepted).toBe(true);
    expect(h.pending('host-a', 1).accepted).toBe(false);
  });
  it('reserves slash correlation without replacing active output or claiming the composer', () => {
    const h = harness(); const id = h.active(); const command = h.timeline.reserveCommand();
    expect(h.timeline.currentRequestId()).toBe(id);
    expect(h.frame('responseChunk', id).accepted).toBe(true);
    expect(h.pending(command, 2).accepted).toBe(true);
    expect(h.timeline.currentRequestId()).toBe(command);
  });
  it.each(['responseChunk', 'toolUse', 'toolResult', 'responseComplete', 'error', 'authError', 'requestCancelled', 'responseStarted'])(
    'rejects untagged %s during a correlated response', type => {
      const h = harness(); const id = h.active();
      expect(h.frame(type).accepted).toBe(false); expect(h.timeline.currentRequestId()).toBe(id);
    });
  it.each(['responseComplete', 'requestCancelled', 'error', 'authError'])(
    'closes %s once before a queued successor is acknowledged', terminal => {
      const h = harness(); const first = h.active();
      h.timeline.append({ type: 'text', content: 'partial' }); const el = h.timeline.currentElement();
      expect(h.frame(terminal, first).accepted).toBe(true);
      expect(el!.classList.contains('streaming')).toBe(false);
      const second = h.timeline.prepare();
      for (const type of ['responseComplete', 'responseChunk', 'toolUse', 'toolResult', 'responseStarted', 'error']) {
        expect(h.frame(type, first).accepted).toBe(false);
      }
      expect(h.timeline.currentRequestId()).toBe(second);
      expect(h.frame('error', second).accepted).toBe(true);
      expect(h.frame('error', second).accepted).toBe(false);
      expect(h.messages.textContent).toBe('Mystiactual / resolvedpartial');
    });
  it('reset retires both acknowledged and still-unacknowledged local intents', () => {
    const h = harness(); const first = h.active(); h.timeline.reset();
    expect(h.pending(first, 2).accepted).toBe(false); expect(h.begin(first).accepted).toBe(false);
    const second = h.timeline.prepare(); h.timeline.reset();
    expect(h.pending(second, 3).accepted).toBe(false); expect(h.frame('error', second).accepted).toBe(false);
    expect(h.pending('new-host', 4).accepted).toBe(true);
  });
  it('keeps terminal accessory delivery until the next local intent, never reopening', () => {
    const h = harness(); const id = h.active(); h.frame('responseComplete', id);
    expect(h.frame('suggestionsReady', id).accepted).toBe(true);
    expect(h.frame('connectionRequired', id).accepted).toBe(true);
    expect(h.frame('responseChunk', id).accepted).toBe(false);
    h.timeline.prepare(); expect(h.frame('suggestionsReady', id).accepted).toBe(false);
    expect(h.timeline.admit({ type: 'compactionStatus', scope: 'notice', payload: {} }).accepted).toBe(true);
  });
  it('never detaches a successor for an older background job or action card', () => {
    const h = harness(); const first = h.active();
    expect(h.frame('jobStarted', first).terminal).toBe(true);
    const second = h.timeline.prepare();
    expect(h.frame('jobStarted', first)).toMatchObject({ accepted: true, foreground: false, terminal: false });
    expect(h.frame('mystiActionRequired', undefined, { scope: 'background', terminal: true })).toMatchObject({ accepted: true, foreground: false });
    expect(h.timeline.currentRequestId()).toBe(second);
    expect(h.frame('error', second).accepted).toBe(true);
  });
  it('keeps normal orchestration progress open through synthesis and completion', () => {
    const h = harness(); const id = h.active();
    expect(h.frame('mystiComplete', id).terminal).not.toBe(true);
    h.timeline.synthesis('answer'); const el = h.timeline.currentElement()!;
    expect(el.dataset.mystiSynthesis).toBe('pending');
    expect(h.frame('responseComplete', id).accepted).toBe(true);
    expect(h.timeline.finish({ id: 'persisted', content: 'answer', model: 'actual model' })).toBe(el);
    expect(el.dataset.id).toBe('persisted'); expect(el.textContent).toContain('actual model');
    expect(h.messages.children).toHaveLength(1);
  });
  it('captures attribution and text/tool order with one thinking zone', () => {
    const h = harness(); const id = h.active(); h.fallback.provider = 'changed';
    h.timeline.append({ type: 'text', content: 'before [[channel]]' });
    h.timeline.append({ type: 'thinking', content: 'reason' });
    const body = h.timeline.beforeTool()!; const tool = h.document.createElement('aside'); tool.textContent = 'tool'; body.appendChild(tool);
    h.timeline.append({ type: 'text', content: 'after' }); h.timeline.append({ type: 'thinking', content: ' more' });
    expect([...body.children].map(el => el.textContent)).toEqual(['before ', 'reason more', 'tool', 'after']);
    expect(h.timeline.thinkingFor(tool)).toBe('reason more'); expect(h.timeline.thinkingFor(h.document.createElement('aside'))).toBe('');
    expect(h.renderThinkingZone.mock.calls[0][1]).toBe('actual');
    h.frame('responseComplete', id); h.timeline.finish({ content: 'combined' });
    expect([...body.children].map(el => el.textContent)).toEqual(['before ', 'reason more', 'tool', 'after']);
  });
  it('honors a model-less announcement without filling from the picker', () => {
    const h = harness(); const id = h.timeline.prepare(); h.pending(id); h.begin(id, { provider: 'mysti', model: '' });
    h.timeline.append({ type: 'text', content: 'answer' });
    expect(h.timeline.currentElement()!.querySelector('.message-model-info')!.textContent).toBe('mysti / ');
  });
  it.each(['empty', 'thinking', 'tool'])('renders a final-only answer once after %s streaming', prior => {
    const h = harness(); const id = h.active();
    if (prior === 'thinking') { h.timeline.append({ type: 'thinking', content: 'reason' }); }
    if (prior === 'tool') { const body = h.timeline.beforeTool()!; body.appendChild(h.document.createElement('aside')); }
    h.frame('responseComplete', id); const element = h.timeline.finish({ id: 'saved', content: '<script>answer</script>' })!;
    expect(element.querySelector('.message-content')!.textContent).toBe('<script>answer</script>');
    expect(element.querySelector('script')).toBeNull(); expect(element.dataset.id).toBe('saved');
    expect(h.timeline.finish({ content: 'duplicate' })).toBeNull(); expect(h.messages.children).toHaveLength(1);
  });
  it('empty pre-start control completion creates no assistant bubble', () => {
    const h = harness(); const id = h.timeline.prepare();
    expect(h.frame('responseComplete', id).accepted).toBe(true);
    expect(h.timeline.finish({})).toBeNull(); expect(h.messages.children).toHaveLength(0);
  });
  it('never borrows a brainstorm or restored element and invalidates captured callbacks on reset/dispose', () => {
    const h = harness(); const history = h.document.createElement('div'); history.className = 'message assistant streaming'; history.dataset.brainstormSynthesis = 'true'; h.messages.appendChild(history);
    const id = h.active(); const captured = h.timeline.capture(); h.timeline.append({ type: 'text', content: 'new' });
    expect(h.timeline.currentElement()).not.toBe(history); expect(h.timeline.isCurrent(captured)).toBe(true);
    h.timeline.reset(); expect(h.timeline.isCurrent(captured)).toBe(false);
    h.timeline.dispose(); expect(h.pending('host', 2).accepted).toBe(false); expect(h.begin(id).accepted).toBe(false);
  });
  it('does not admit stale stream frames disguised as notices or accessories', () => {
    const h = harness(); h.active();
    for (const type of ['responseChunk', 'toolUse', 'responseComplete', 'requestCancelled']) {
      for (const scope of ['notice', 'background', 'accessory']) {
        expect(h.timeline.admit({ type, requestId: 'old', scope, payload: { scope } }).accepted).toBe(false);
      }
    }
    expect(h.timeline.admit({ type: 'toolResult', scope: 'accessory', payload: { id: 'question' } }).accepted).toBe(false);
    expect(h.timeline.admit({ type: 'mystiActionRequired', requestId: 'old', payload: { scope: 'notice', terminal: false } }).accepted).toBe(false);
  });

  it('copies announced attribution and prefers an explicit persisted stamp at completion', () => {
    const h = harness(); const id = h.timeline.prepare(); h.pending(id);
    const attribution = { provider: 'announced', model: 'announced-model' };
    h.begin(id, attribution); attribution.model = 'mutated'; h.fallback.model = 'changed picker';
    h.timeline.append({ type: 'text', content: 'answer' });
    expect(h.timeline.currentElement()!.textContent).toContain('announced-model');
    h.frame('responseComplete', id); h.timeline.finish({ content: 'answer', model: 'persisted-model' });
    expect(h.timeline.currentElement()!.textContent).toContain('persisted-model');
  });

  it('refuses a deferred first-paint report after its captured response is replaced', () => {
    const posted: unknown[] = [];
    const callbacks: Array<() => void> = [];
    const original = {};
    let current = original;
    const chat = fs.readFileSync(path.resolve(__dirname, '../../media/chat/chat.js'), 'utf8');
    const start = chat.indexOf('      function perfPostFirstChunkRendered(sentAt) {');
    const end = chat.indexOf('      // Coarse panel.timeToUsable:', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const run = new Function('postMessageWithPanelId', 'requestAnimationFrame', 'streamingTimeline',
      `${chat.slice(start, end)}\nperfPostFirstChunkRendered(42);`);
    run((message: unknown) => posted.push(message), (callback: () => void) => callbacks.push(callback), {
      capture: () => original, isCurrent: (captured: object) => current === captured,
    });
    current = {};
    callbacks[0]();
    expect(posted).toEqual([]);
  });


});
