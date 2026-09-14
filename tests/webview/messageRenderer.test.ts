import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as marked from 'marked';
import createDOMPurify from 'dompurify';
import { loadMarkdownRenderer } from '../helpers/markdownRenderer';

const source = fs.readFileSync(path.resolve(__dirname, '../../media/chat/messageRenderer.js'), 'utf8');
const opened: JSDOM[] = [];
afterEach(() => { for (const dom of opened.splice(0)) { dom.window.close(); } });

function setup() {
  const dom = new JSDOM('<!doctype html><main><div class="welcome-container">Welcome</div></main>', { runScripts: 'outside-only', url: 'https://mysti.test/' });
  opened.push(dom);
  const document = dom.window.document;
  const sanitizer = createDOMPurify(dom.window as unknown as Window & typeof globalThis);
  const markdown = loadMarkdownRenderer(dom.window).create({ document, marked, sanitize: (value, options) => String(sanitizer.sanitize(value, options)), getMermaid: () => undefined });
  const tool = vi.fn((call: { id?: string; name?: string }) => {
    const node = document.createElement('div'); node.className = 'tool-call';
    node.dataset.id = call.id ?? ''; node.textContent = call.name ?? 'legacy'; return node;
  });
  const thinking = vi.fn((body: HTMLElement, style: string, value: string) => {
    let zone = body.querySelector('.thinking-zone');
    if (!zone) { zone = document.createElement('div'); zone.className = 'thinking-zone'; body.appendChild(zone); }
    zone.textContent += (zone.textContent && style === 'complete-blocks' ? '\n\n' : '') + value;
  });
  const footer = vi.fn();
  dom.window.eval(source);
  const api = (dom.window as unknown as { MystiMessageRenderer: { create(ports: unknown): {
    buildMessage(message: unknown): HTMLElement | null;
    buildRestoredMessageBody(message: unknown): HTMLElement;
    appendMessage(container: HTMLElement, message: unknown): HTMLElement | null;
  } } }).MystiMessageRenderer;
  const renderer = api.create({ document, formatContent: markdown.renderMarkdown, renderThinkingZone: thinking,
    buildToolCallElement: tool, renderMessageFooter: footer,
    getMessageAttribution: (msg: { provider?: string; model?: string }) => ({ provider: msg.provider || 'saved-provider', model: msg.model || 'saved-model' }),
    getAgentDisplayName: (provider: string) => provider,
    formatAttributionLabel: (attribution: { provider: string; model: string }) => `${attribution.provider} · ${attribution.model}`,
  });
  return { dom, document, renderer, tool, thinking, footer, container: document.querySelector('main')! };
}

describe('persisted message replay through the shipped module', () => {
  it('keeps text/tools in stream order while reasoning accumulates at its first position', () => {
    const h = setup();
    const body = h.renderer.buildRestoredMessageBody({ content: 'must not duplicate flat text', thinking: { style: 'streamed', content: 'must not duplicate flat reasoning' },
      toolCalls: [{ id: 'read', name: 'Read' }, { id: 'edit', name: 'Edit' }],
      segments: [{ type: 'text', content: 'Before' }, { type: 'thinking', content: 'First. ' }, { type: 'tool', toolCallId: 'read' },
        { type: 'text', content: 'Between' }, { type: 'thinking', content: 'Second.' }, { type: 'tool', toolCallId: 'edit' }, { type: 'text', content: 'After' }],
    });
    expect([...body.children].map(node => node.textContent?.trim())).toEqual(['Before', 'First. Second.', 'Read', 'Between', 'Edit', 'After']);
    expect(body.querySelectorAll('.thinking-zone')).toHaveLength(1);
    expect(body.querySelectorAll('.message-content')).toHaveLength(3);
    expect(h.thinking.mock.calls.map(call => call.slice(1))).toEqual([['streamed', 'First. '], ['streamed', 'Second.']]);
  });

  it('restores coordinator reasoning before text-only segments and appends unreferenced tools', () => {
    const h = setup();
    const body = h.renderer.buildRestoredMessageBody({ thinking: 'Saved reasoning.', segments: [{ type: 'text', content: 'Answer' }], toolCalls: [{ id: 'orphan', name: 'Read' }] });
    expect([...body.children].map(node => node.textContent?.trim())).toEqual(['Saved reasoning.', 'Answer', 'Read']);
  });

  it('replays legacy flat thinking, Markdown and tool lists without requiring tool IDs', () => {
    const h = setup();
    const body = h.renderer.buildRestoredMessageBody({ thinking: 'Legacy.', content: '**Answer**', toolCalls: [{ name: 'Legacy tool' }] });
    expect([...body.children].map(node => node.textContent?.trim())).toEqual(['Legacy.', 'Answer', 'Legacy tool']);
    expect(body.querySelector('strong')?.textContent).toBe('Answer');
  });

  it('handles prototype-like tool IDs and missing/duplicate references without inventing cards', () => {
    const h = setup();
    const body = h.renderer.buildRestoredMessageBody({
      toolCalls: [{ id: '__proto__', name: 'Proto tool' }, { id: 'constructor', name: 'Constructor tool' }, { id: 'unreferenced', name: 'Last tool' }],
      segments: [{ type: 'tool', toolCallId: 'toString' }, { type: 'tool', toolCallId: '__proto__' }, { type: 'tool', toolCallId: '__proto__' }, { type: 'tool', toolCallId: 'constructor' }],
    });
    expect([...body.children].map(node => (node as HTMLElement).dataset.id)).toEqual(['__proto__', 'constructor', 'unreferenced']);
    expect(h.tool).toHaveBeenCalledTimes(3);
  });

  it('keeps stored IDs, attribution and checkpoint markup as literal DOM values', () => {
    const h = setup();
    const value = '"><img class="spoof" src=x onerror="alert(1)">';
    const assistant = h.renderer.buildMessage({ id: value, role: 'assistant', provider: value, model: value, content: 'Safe' })!;
    const user = h.renderer.buildMessage({ id: value, role: 'user', checkpoint: { commit: value }, content: 'Hello' })!;
    expect(assistant.dataset.id).toBe(value);
    expect(assistant.querySelector<HTMLButtonElement>('.message-copy-btn')!.dataset.messageId).toBe(value);
    expect(user.querySelector<HTMLButtonElement>('.message-rewind-btn')!.dataset).toMatchObject({ messageId: value, commit: value });
    expect(assistant.querySelector('.message-model-info')?.textContent).toBe(`${value} · ${value}`);
    expect(assistant.querySelector('.message-model-info')?.getAttribute('title')).toBe('Generated by ' + value);
    expect(assistant.querySelector('.spoof, [onerror]')).toBeNull();
    expect(user.querySelector('.spoof, [onerror]')).toBeNull();
    expect(h.footer).toHaveBeenCalledWith(assistant, null, { provider: value, model: value }, []);
  });

  it('preserves valid image/file attachments and turns malformed image data into literal labels', () => {
    const h = setup();
    const fileName = '"><button class="spoof">Approve</button>';
    const message = h.renderer.buildMessage({ role: 'user', id: 'attachments', content: '', attachments: [
      { type: 'image', mimeType: 'image/png', base64Data: 'aGVsbG8=', fileName },
      { type: 'file', fileName: 'notes.md' },
      { type: 'image', mimeType: 'image/png" onerror="alert(1)', base64Data: 'aGVsbG8=', fileName },
      { type: 'image', mimeType: 'image/png', base64Data: 'x" onerror="alert(1)', fileName },
      { type: 'image', mimeType: 'text/html', base64Data: 'aGVsbG8=', fileName: 'not-image' },
      { type: 'image', mimeType: 'image/png', base64Data: '', fileName: 'missing.png' }, null,
    ] })!;
    const images = message.querySelectorAll('img.message-attachment-img');
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(images[0].getAttribute('alt')).toBe(fileName);
    expect(message.querySelectorAll('.message-attachment-label')).toHaveLength(5);
    expect(message.querySelector('.message-attachment-label')?.textContent).toBe('📄 notes.md');
    expect(message.querySelector('.spoof, [onerror]')).toBeNull();
  });

  it('replaces the welcome view only when a valid message is appended and tolerates malformed optional arrays', () => {
    const h = setup();
    expect(h.renderer.appendMessage(h.container, null)).toBeNull();
    expect(h.container.querySelector('.welcome-container')).not.toBeNull();
    const message = h.renderer.appendMessage(h.container, { role: 'assistant" onmouseover="alert(1)', attachments: {}, segments: {}, toolCalls: {}, thinking: { content: {} } })!;
    expect(h.container.querySelector('.welcome-container')).toBeNull();
    expect(message.className).toBe('message system');
    expect(message.querySelector('[onmouseover]')).toBeNull();
  });

  it('sends body content through the actual Markdown sanitizer without adding markup from message metadata', () => {
    const h = setup();
    const message = h.renderer.buildMessage({ id: 'markdown', role: 'assistant', content: '<script>alert(1)</script>\n**safe**\n<img src=x onerror="alert(2)">' })!;
    expect(message.querySelector('script, [onerror]')).toBeNull();
    expect(message.querySelector('strong')?.textContent).toBe('safe');
  });
});
