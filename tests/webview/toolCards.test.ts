import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, '../../media/chat/toolCards.js'), 'utf8');
const windows: JSDOM[] = [];
interface Cards {
  build(tool: unknown): HTMLElement;
  summary(tool: unknown): string;
  use(tool: unknown): void;
  result(tool: unknown): void;
  begin(): void;
  end(): void;
  reset(): void;
  dispose(): void;
}
interface Result { element: HTMLElement; name: string; input: Record<string, unknown>; toolCall: unknown }
function harness() {
  const dom = new JSDOM('<main id="messages"><div class="message-body"></div></main>', { runScripts: 'outside-only' });
  windows.push(dom);
  const document = dom.window.document;
  const messages = document.getElementById('messages')!;
  const body = messages.firstElementChild!;
  const scroll = vi.fn();
  const onResult = vi.fn<(result: Result) => void>();
  const getStreamingBody = vi.fn(() => body);
  const ports = { document, getMessagesElement: () => messages, getStreamingBody,
    cleanPathsInString: (value: string) => value.replace('/workspace/', ''),
    makeRelativePath: (value: string) => value.replace('/workspace/', ''), scroll, onResult };
  dom.window.eval(source);
  const factory = (dom.window as unknown as { MystiToolCards: { create(ports: unknown): Cards } }).MystiToolCards;
  const cards = factory.create(ports);
  cards.begin();
  return { cards, factory, ports, document, messages, body, getStreamingBody, scroll, onResult,
    card: (index = 0) => body.querySelectorAll<HTMLElement>('.tool-call')[index] };
}
const tool = (id = 'call', input: Record<string, unknown> = { path: '/workspace/a.ts' }) => ({ id, name: 'Read', kind: 'read', input });
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); });

describe('main tool-card owner', () => {
  it('interleaves new cards with text and keeps updates in place without advancing the segment cursor', () => {
    const h = harness();
    h.body.appendChild(h.document.createTextNode('before'));
    h.cards.use(tool());
    h.body.appendChild(h.document.createTextNode('after'));
    h.cards.use(tool('call', { path: '/workspace/updated.ts' }));
    expect(h.body.childNodes).toHaveLength(3);
    expect(h.body.childNodes[0].textContent).toBe('before');
    expect(h.body.childNodes[2].textContent).toBe('after');
    expect(h.getStreamingBody).toHaveBeenCalledTimes(1);
    expect(h.card().dataset.summary).toBe('updated.ts');
    expect(h.card().querySelector('.tool-call-content')?.textContent).toContain('/workspace/updated.ts');
  });

  it('uses the same card DOM for live terminal results and restored messages', () => {
    const h = harness();
    h.cards.use(tool());
    h.cards.result({ id: 'call', status: 'completed', output: 'body' });
    const restored = h.cards.build({ ...tool(), status: 'completed', output: 'body' });
    expect(h.card().outerHTML).toBe(restored.outerHTML);
    expect(restored.querySelector('.tool-call-copy')).not.toBeNull();
    expect(restored.querySelector('.tool-call-chevron')).not.toBeNull();
    expect(restored.querySelector('.tool-call-details')).not.toBeNull();
  });

  it.each(['__proto__', 'constructor', 'x"] .tool-call, [data-id="y', '<img src=x onerror=alert(1)>'])('treats arbitrary IDs as exact keys: %s', id => {
    const h = harness();
    h.cards.use(tool('unrelated'));
    h.cards.use(tool(id));
    expect(() => h.cards.result({ id, status: 'failed', output: '<img src=x onerror=alert(1)>' })).not.toThrow();
    expect(h.card(0).classList.contains('running')).toBe(true);
    expect(h.card(1).classList.contains('failed')).toBe(true);
    expect(h.card(1).dataset.id).toBe(id);
    expect(h.messages.querySelector('img')).toBeNull();
  });

  it('renders all tool-controlled strings as data, including forged status markup and JSON input', () => {
    const h = harness();
    const attack = '"><img src=x onerror=alert(1)>';
    h.cards.use({ id: attack, name: attack, status: attack, input: { path: attack } });
    h.cards.result({ id: attack, status: attack, output: attack });
    expect(h.card().className).toBe('tool-call failed');
    expect(h.card().querySelector('.tool-call-name')?.textContent).toBe(attack);
    expect(h.card().querySelector('.tool-call-summary')?.textContent).toBe(attack);
    expect(h.card().querySelector('.tool-call-status')?.textContent).toBe('failed');
    expect(h.card().querySelector('.tool-call-output-content')?.textContent).toBe(attack);
    expect(h.card().querySelectorAll('img, script, [onerror], [onclick]')).toHaveLength(0);
  });

  it.each(['pending', 'running', 'completed', 'failed'])('preserves the supported %s restored status', status => {
    const h = harness();
    const card = h.cards.build({ ...tool(), status });
    expect(card.classList.contains(status)).toBe(true);
    expect(card.querySelector('.tool-call-status')?.textContent).toBe(status);
  });

  it('removes prior pending/running classes while settling a terminal result', () => {
    const h = harness();
    h.cards.use({ ...tool(), status: 'pending' });
    h.cards.result({ id: 'call', status: 'running' });
    expect(h.card().className).toBe('tool-call running');
    h.cards.result({ id: 'call', status: 'completed' });
    expect(h.card().className).toBe('tool-call completed');
  });

  it('retains the latest meaningful streamed input through repeated empty start frames', () => {
    const h = harness();
    h.cards.use({ id: 'call', name: 'Edit', input: {} });
    h.cards.use({ id: 'call', name: 'Edit', input: { file_path: 'a', old_string: 'old', new_string: 'new' } });
    h.cards.use({ id: 'call', name: 'Edit', input: {} });
    h.cards.result({ id: 'call', status: 'completed', output: 'edited' });
    expect(h.onResult).toHaveBeenCalledTimes(1);
    expect(h.onResult.mock.calls[0][0]).toMatchObject({ name: 'Edit', input: { file_path: 'a', old_string: 'old', new_string: 'new' } });
    expect(h.getStreamingBody).toHaveBeenCalledTimes(1);
  });

  it('does not let repeated terminal frames duplicate host edit/Todo effects or overwrite explicit failure', () => {
    const h = harness();
    h.cards.use(tool());
    h.cards.result({ id: 'call', status: 'failed', output: 'failed first' });
    h.cards.result({ id: 'call', status: 'completed', output: 'late duplicate' });
    expect(h.onResult).toHaveBeenCalledTimes(1);
    expect(h.card().className).toBe('tool-call failed');
    expect(h.card().querySelector('.tool-call-output-content')?.textContent).toBe('failed first');
  });

  it('keeps restored cards outside live lookup even when a provider reuses their ID', () => {
    const h = harness();
    const restored = h.cards.build({ ...tool(), status: 'failed', output: 'history' });
    h.body.appendChild(restored);
    h.cards.use(tool());
    h.cards.result({ id: 'call', status: 'completed', output: 'new run' });
    expect(restored.classList.contains('failed')).toBe(true);
    expect(restored.querySelector('.tool-call-output-content')?.textContent).toBe('history');
    expect(h.card(1).querySelector('.tool-call-output-content')?.textContent).toBe('new run');
  });

  it('reset forgets old input/IDs, ignores stale results, and allows the same ID in a new turn', () => {
    const h = harness();
    h.cards.use({ id: 'call', name: 'Edit', input: { file_path: 'old' } });
    h.cards.reset();
    h.cards.result({ id: 'call', status: 'failed' });
    expect(h.onResult).not.toHaveBeenCalled();
    h.cards.begin();
    h.cards.use(tool());
    h.cards.result({ id: 'call', status: 'completed' });
    expect(h.body.querySelectorAll('.tool-call')).toHaveLength(2);
    expect(h.onResult.mock.calls[0][0].input).toEqual({ path: '/workspace/a.ts' });
  });

  it('does not update a removed card or perform its host effects', () => {
    const h = harness();
    h.cards.use(tool());
    h.card().remove();
    h.cards.result({ id: 'call', status: 'completed' });
    expect(h.onResult).not.toHaveBeenCalled();
    h.cards.use(tool());
    expect(h.body.querySelectorAll('.tool-call')).toHaveLength(1);
  });

  it('isolates instances sharing one message container', () => {
    const h = harness();
    const second = h.factory.create(h.ports);
    second.begin();
    h.cards.use(tool());
    second.use(tool());
    h.cards.result({ id: 'call', status: 'failed' });
    expect(h.card(0).classList.contains('failed')).toBe(true);
    expect(h.card(1).classList.contains('running')).toBe(true);
    second.result({ id: 'call', status: 'completed' });
    expect(h.card(1).classList.contains('completed')).toBe(true);
  });

  it('disposal drops pending inputs and prevents later live updates', () => {
    const h = harness();
    h.cards.use(tool());
    h.cards.dispose();
    h.cards.dispose();
    h.cards.begin();
    h.cards.result({ id: 'call', status: 'completed' });
    h.cards.use(tool('late'));
    expect(h.onResult).not.toHaveBeenCalled();
    expect(h.body.querySelectorAll('.tool-call')).toHaveLength(1);
  });

  it.each(['end', 'reset'] as const)('%s closes intake until an explicit new turn while restored cards remain usable', terminal => {
    const h = harness();
    h.cards.use(tool());
    h.cards[terminal]();
    const stopped = h.card().outerHTML;
    h.cards.use(tool('call', { path: '/workspace/late.ts' }));
    h.cards.use(tool('late-new-id'));
    h.cards.result({ id: 'call', status: 'completed', output: 'late output' });
    expect(h.body.querySelectorAll('.tool-call')).toHaveLength(1);
    expect(h.card().outerHTML).toBe(stopped);
    expect(h.getStreamingBody).toHaveBeenCalledOnce();
    expect(h.onResult).not.toHaveBeenCalled();
    const restored = h.cards.build({ ...tool('history'), status: 'completed', output: 'saved' });
    expect(restored.textContent).toContain('saved');
    h.cards.begin();
    h.cards.use(tool());
    h.cards.result({ id: 'call', status: 'completed' });
    expect(h.body.querySelectorAll('.tool-call')).toHaveLength(2);
    expect(h.onResult).toHaveBeenCalledOnce();
  });

  it('starts with closed intake but supports standalone restored cards and summaries', () => {
    const h = harness();
    const cards = h.factory.create(h.ports);
    cards.use(tool());
    cards.result({ id: 'call', status: 'completed' });
    expect(h.body.querySelectorAll('.tool-call')).toHaveLength(0);
    expect(cards.summary(tool())).toBe('a.ts');
    expect(cards.build({ ...tool(), status: 'completed' }).classList.contains('completed')).toBe(true);
  });

  it('keeps truncation disclosure and bounds displayed output without changing the host result', () => {
    const h = harness();
    const output = 'x'.repeat(1500);
    h.cards.use({ ...tool(), truncated: true });
    h.cards.result({ id: 'call', status: 'completed', output });
    expect(h.card().querySelector('.tool-call-note')?.textContent).toBe('truncated');
    expect(h.card().querySelector('.tool-call-output-content')?.textContent).toBe('x'.repeat(1000) + '...');
    expect(h.onResult.mock.calls[0][0].toolCall).toEqual({ id: 'call', status: 'completed', output });
  });

  it('does not break the stream over malformed objects or cyclic diagnostic input', () => {
    const h = harness();
    for (const payload of [null, [], 1, 'tool', {}, { id: 2 }]) { h.cards.use(payload); h.cards.result(payload); }
    const input: Record<string, unknown> = {};
    input.circular = input;
    expect(() => h.cards.use(tool('cycle', input))).not.toThrow();
    expect(h.card().querySelector('.tool-call-content')?.textContent).toBe('[Unserializable input]');
    expect(h.cards.summary({ name: 42, input: { path: 'safe' } })).toBe('safe');
  });
});
