/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, '../../media/chat/subAgentCards.js'), 'utf8');
const windows: JSDOM[] = [];
type EventName = 'started' | 'chunk' | 'complete' | 'error' | 'toolUse' | 'toolResult' | 'retry' | 'askUserQuestion' | 'status';
type Cards = Record<EventName, (payload: unknown) => void> & Record<'stop' | 'reset' | 'dispose', () => void>;

function harness() {
  const dom = new JSDOM('<div id="messages"></div>', { runScripts: 'outside-only', url: 'https://mysti.test/' });
  windows.push(dom);
  const { document } = dom.window;
  dom.window.eval(source);
  let sequence = 0;
  const timers = new Map<number, () => void>();
  const scheduled: Array<() => void> = [];
  const postMessage = vi.fn();
  const renderMarkdown = vi.fn((value: string) => {
    const text = document.createElement('p');
    text.textContent = value;
    return text.outerHTML;
  });
  const renderDiagrams = vi.fn();
  const highlight = vi.fn();
  const renderQuestion = vi.fn(() => {
    const container = document.createElement('div');
    container.className = 'ask-user-question-container';
    container.innerHTML = '<input type="radio" name="auq_0" value="Yes">' +
      '<input type="radio" name="auq_0" value="No">' +
      '<button class="auq-submit-btn">Submit</button><button class="auq-skip-btn">Skip</button>';
    return container;
  });
  const ports = {
    document,
    getMessagesElement: () => document.getElementById('messages'),
    getAgentDisplay: () => ({ name: '<img src=x onerror=alert(1)>', shortId: 'same' }),
    renderMarkdown, renderDiagrams, highlight, renderQuestion, postMessage,
    setTimeout: (callback: () => void) => { const id = ++sequence; timers.set(id, callback); scheduled.push(callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  const factory = (dom.window as unknown as { MystiSubAgentCards: { create(ports: unknown): Cards } }).MystiSubAgentCards;
  const cards = factory.create(ports);
  return {
    cards, document, postMessage, renderMarkdown, renderDiagrams, highlight, renderQuestion, timers, scheduled,
    other: () => factory.create(ports),
    flush: () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    card: (index = 0) => document.querySelectorAll<HTMLElement>('.subagent-card')[index],
    question: () => document.querySelector<HTMLElement>('.ask-user-question-container')!,
  };
}
function question(agentId = 'agent', toolCallId = 'delivery') {
  return { agentId, questionData: { toolCallId, questions: [{ question: 'Continue?', header: 'Choice', options: [{ label: 'Yes' }] }] } };
}
const text = (agentId: string, content: unknown) => ({ agentId, chunkType: 'text', content });
afterEach(() => { for (const dom of windows.splice(0)) { dom.window.close(); } });

describe('sub-agent cards own each attempt and its rendering', () => {
  it('throttles text, preserves thinking/tools, and flushes complete output before the timer', () => {
    const h = harness();
    h.cards.started({ agentId: 'agent' });
    h.cards.chunk(text('agent', 'Hello '));
    h.cards.chunk(text('agent', 'world'));
    h.cards.chunk({ agentId: 'agent', chunkType: 'thinking', content: '<script>thought</script>' });
    h.cards.toolUse({ agentId: 'agent', toolCall: { id: 'tool', name: 'Read', input: { path: '/src' } } });
    expect(h.timers.size).toBe(1);
    expect(h.renderMarkdown).not.toHaveBeenCalled();
    h.cards.complete({ agentId: 'agent', hasError: true });
    expect(h.renderMarkdown).toHaveBeenCalledWith('Hello world');
    expect(h.card().querySelector('.subagent-status')?.textContent).toBe('Partial');
    expect(h.card().querySelector('.subagent-thinking-text')?.textContent).toBe('<script>thought</script>');
    expect(h.card().querySelectorAll('.subagent-tool-call')).toHaveLength(1);
    expect(h.card().querySelector('script, img')).toBeNull();
    expect(h.renderDiagrams).toHaveBeenCalledWith(h.card().querySelector('.subagent-content'));
    expect(h.timers.size).toBe(0);
    h.cards.chunk(text('agent', 'late'));
    h.cards.status({ agentId: 'agent', status: 'Working...' });
    expect(h.card().textContent).not.toContain('late');
    expect(h.card().querySelector('.subagent-status')?.textContent).toBe('Partial');
  });

  it('isolates full agent IDs, repeated starts and module instances with identical display IDs', () => {
    const h = harness();
    const other = h.other();
    h.cards.started({ agentId: '__proto__' });
    h.cards.started({ agentId: 'constructor' });
    other.started({ agentId: '__proto__' });
    h.cards.chunk(text('__proto__', 'first'));
    h.cards.chunk(text('constructor', 'second'));
    other.chunk(text('__proto__', 'another panel'));
    h.flush();
    h.cards.started({ agentId: '__proto__' });
    h.cards.chunk(text('__proto__', 'new attempt'));
    h.flush();
    expect([0, 1, 2, 3].map(index => h.card(index).querySelector('.subagent-text-output')?.textContent))
      .toEqual(['first', 'second', 'another panel', 'new attempt']);
    expect(new Set([0, 1, 2, 3].map(index => h.card(index).id)).size).toBe(4);
    h.cards.stop();
    other.chunk(text('__proto__', ' continues'));
    h.flush();
    expect(h.card(2).querySelector('.subagent-text-output')?.textContent).toBe('another panel continues');
  });

  it('retry drops old text and invalidates even a render callback already dequeued by the browser', () => {
    const h = harness();
    h.cards.started({ agentId: 'agent' });
    h.cards.chunk(text('agent', 'old response'));
    const staleRender = h.scheduled[0];
    h.cards.retry({ agentId: 'agent' });
    h.cards.chunk(text('agent', 'new response'));
    staleRender();
    expect(h.renderMarkdown).not.toHaveBeenCalled();
    h.flush();
    expect(h.renderMarkdown.mock.calls.map(call => call[0])).toEqual(['new response']);
    expect(h.card().textContent).not.toContain('old response');
  });

  it.each(['error', 'reset', 'stop', 'dispose'] as const)('%s cancels pending rendering and makes old callbacks inert', action => {
    const h = harness();
    h.cards.started({ agentId: 'agent' });
    h.cards.chunk(text('agent', 'unfinished'));
    const callback = h.scheduled[0];
    if (action === 'error') { h.cards.error({ agentId: 'agent', error: '<script>bad</script>' }); }
    else { h.cards[action](); }
    const rendered = h.renderMarkdown.mock.calls.length;
    callback();
    expect(h.renderMarkdown).toHaveBeenCalledTimes(rendered);
    expect(h.timers.size).toBe(0);
    h.cards.chunk(text('agent', 'late response'));
    expect(h.timers.size).toBe(0);
    if (action === 'dispose') {
      h.cards.started({ agentId: 'new' });
      expect(h.document.querySelectorAll('.subagent-card')).toHaveLength(1);
    }
  });

  it('stop preserves visible output and settles running tools without allowing a delayed retry', () => {
    const h = harness();
    h.cards.started({ agentId: 'agent' });
    h.cards.chunk(text('agent', 'partial output'));
    h.cards.toolUse({ agentId: 'agent', toolCall: { id: 't', name: 'Read' } });
    h.cards.stop();
    h.cards.retry({ agentId: 'agent' });
    h.cards.chunk(text('agent', 'revived'));
    expect(h.card().querySelector('.subagent-text-output')?.textContent).toBe('partial output');
    expect(h.card().querySelector('.subagent-status')?.textContent).toBe('Stopped');
    expect(h.card().querySelector('.subagent-tool-call')?.classList.contains('failed')).toBe(true);
    expect(h.card().querySelector('.subagent-tool-spinner')).toBeNull();
    expect(h.timers.size).toBe(0);
  });

  it('renders plain text if a renderer fails and permits one retry request for the current error', () => {
    const h = harness();
    h.renderMarkdown.mockImplementation(() => { throw new Error('parser unavailable'); });
    h.cards.started({ agentId: 'agent' });
    h.cards.chunk(text('agent', '<strong>plain</strong>'));
    h.flush();
    expect(h.card().querySelector('.subagent-text-output')?.textContent).toBe('<strong>plain</strong>');
    h.cards.error({ agentId: 'agent', error: 'failed' });
    const button = h.card().querySelector<HTMLButtonElement>('.subagent-retry-btn')!;
    button.click(); button.click();
    expect(h.postMessage.mock.calls.map(call => call[0])).toEqual([{ type: 'retrySubAgent', payload: { agentId: 'agent' } }]);
    h.cards.retry({ agentId: 'agent' });
    button.disabled = false;
    button.click();
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });

  it('treats opaque tool IDs as data and displays cyclic or falsy outputs safely', () => {
    const h = harness();
    h.cards.started({ agentId: 'agent' });
    const id = 'tool"] , [data-id="other';
    h.cards.toolUse({ agentId: 'agent', toolCall: { id, name: '<b>Read</b>', input: { path: '<img src=x>' } } });
    h.cards.toolUse({ agentId: 'agent', toolCall: { id: 'other', name: 'Other' } });
    h.cards.toolResult({ agentId: 'agent', toolCall: { id, output: false } });
    const tools = h.card().querySelectorAll('.subagent-tool-call');
    expect(tools[0].querySelector('.subagent-tool-output-code')?.textContent).toBe('false');
    expect(tools[1].classList.contains('running')).toBe(true);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => h.cards.toolResult({ agentId: 'agent', toolCall: { id, output: circular, status: 'failed' } })).not.toThrow();
    expect(tools[0].querySelector('.subagent-tool-output-code')?.textContent).toBe('[Unserializable value]');
    expect(tools[0].querySelectorAll('img, b')).toHaveLength(0);
    h.cards.toolResult({ agentId: 'agent', toolCall: { id, output: 'x'.repeat(3000) } });
    expect(tools[0].querySelector('.subagent-tool-output-code')?.textContent).toHaveLength(2016);
  });

  it('ignores malformed payloads without mutating a live card', () => {
    const h = harness();
    h.cards.started({ agentId: 'agent' });
    const before = h.card().outerHTML;
    const malformed = [undefined, null, 1, 'agent', [], {}, { agentId: {} }, { agentId: '' }];
    const events: EventName[] = ['started', 'chunk', 'complete', 'error', 'toolUse', 'toolResult', 'retry', 'askUserQuestion', 'status'];
    for (const event of events) {
      for (const payload of malformed) { expect(() => h.cards[event](payload), event).not.toThrow(); }
    }
    h.cards.chunk(text('agent', { unexpected: true }));
    h.cards.toolUse({ agentId: 'agent', toolCall: { id: {}, name: 'Read' } });
    h.cards.askUserQuestion({ agentId: 'agent', questionData: { toolCallId: 'q', questions: [null] } });
    h.cards.askUserQuestion({ agentId: 'agent', questionData: { toolCallId: 'q', questions: [{ question: 'q', options: ['bad'] }] } });
    h.cards.status({ agentId: 'agent', status: {} });
    expect(h.card().outerHTML).toBe(before);
    expect(h.timers.size).toBe(0);
  });
});

describe('sub-agent question deliveries', () => {
  it('isolates radio groups and sends the existing answer and skip contracts once', () => {
    const h = harness();
    h.cards.started({ agentId: 'first' }); h.cards.started({ agentId: 'second' });
    h.cards.askUserQuestion(question('first', 'q1')); h.cards.askUserQuestion(question('second', 'q2'));
    const first = h.card(0).querySelector('.ask-user-question-container')!;
    const second = h.card(1).querySelector('.ask-user-question-container')!;
    const radio1 = first.querySelector<HTMLInputElement>('input')!;
    const radio2 = second.querySelector<HTMLInputElement>('input')!;
    radio1.click(); radio2.click();
    expect(radio1.checked && radio2.checked).toBe(true);
    const submit = first.querySelector<HTMLButtonElement>('.auq-submit-btn')!;
    (first as unknown as { _answers: Record<string, unknown> })._answers.Choice = ['Yes'];
    submit.click(); submit.click();
    const skip = second.querySelector<HTMLButtonElement>('.auq-skip-btn')!;
    skip.click(); skip.click();
    expect(h.postMessage.mock.calls.map(call => call[0])).toEqual([
      { type: 'subAgentQuestionResponse', payload: { agentId: 'first', toolCallId: 'q1', answers: { Choice: ['Yes'] } } },
      { type: 'subAgentQuestionSkipped', payload: { agentId: 'second', toolCallId: 'q2' } },
    ]);
    h.flush();
    expect(h.document.querySelector('.ask-user-question-container')).toBeNull();
  });

  it.each(['retry', 'complete', 'error', 'started', 'reset', 'stop', 'dispose'] as const)('%s invalidates pending question handlers', action => {
    const h = harness();
    h.cards.started({ agentId: 'agent' });
    h.cards.askUserQuestion(question());
    const submit = h.question().querySelector<HTMLButtonElement>('.auq-submit-btn')!;
    const skip = h.question().querySelector<HTMLButtonElement>('.auq-skip-btn')!;
    if (action === 'reset' || action === 'stop' || action === 'dispose') { h.cards[action](); }
    else { h.cards[action]({ agentId: 'agent' }); }
    submit.click(); skip.click();
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(h.document.querySelector('.ask-user-question-container')).toBeNull();
  });

  it('a replaced delivery rejects the detached old submit callback', () => {
    const h = harness(); h.cards.started({ agentId: 'agent' });
    h.cards.askUserQuestion(question());
    const old = h.question().querySelector<HTMLButtonElement>('.auq-submit-btn')!;
    h.cards.askUserQuestion(question());
    old.click();
    expect(h.postMessage).not.toHaveBeenCalled();
    h.question().querySelector<HTMLButtonElement>('.auq-skip-btn')!.click();
    expect(h.postMessage).toHaveBeenCalledOnce();
  });

  it('completion removes submitted feedback even when its delayed removal is cancelled', () => {
    const h = harness(); h.cards.started({ agentId: 'agent' });
    h.cards.askUserQuestion(question());
    h.question().querySelector<HTMLButtonElement>('.auq-submit-btn')!.click();
    expect(h.timers.size).toBe(1);
    h.cards.complete({ agentId: 'agent' });
    expect(h.timers.size).toBe(0);
    expect(h.document.querySelector('.ask-user-question-container')).toBeNull();
  });
});
