/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as marked from 'marked';
import createDOMPurify from 'dompurify';
import { loadMarkdownRenderer, type MermaidClient, type MarkdownRenderer } from '../helpers/markdownRenderer';

const open: Array<{ dom: JSDOM; renderer: MarkdownRenderer }> = [];
afterEach(() => {
  for (const entry of open.splice(0)) { entry.renderer.dispose(); entry.dom.window.close(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(source = 'flowchart LR\nA-->B') {
  const dom = new JSDOM('<!doctype html><body><div class="mermaid-pending"></div></body>', { runScripts: 'outside-only' });
  const document = dom.window.document;
  const block = document.querySelector('div')!;
  block.textContent = source;
  const engine = {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, _source: string) => ({ svg: '<svg><text>complete</text></svg>' })),
  };
  let loaded: MermaidClient | undefined = engine;
  const purify = createDOMPurify(dom.window as unknown as Window & typeof globalThis);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const renderer = loadMarkdownRenderer(dom.window).create({
    document, marked, sanitize: (html, options) => String(purify.sanitize(html, options)),
    mermaidUri: 'https://mysti.test/mermaid.min.js', getMermaid: () => loaded, logger,
  });
  open.push({ dom, renderer });
  const script = () => document.querySelector('script')!;
  const load = () => script().dispatchEvent(new dom.window.Event('load'));
  const fail = () => script().dispatchEvent(new dom.window.Event('error'));
  return { dom, document, block, engine, renderer, logger, script, load, fail, unavailable: () => { loaded = undefined; } };
}

describe('standalone Markdown rendering', () => {
  it('preserves code fences and escapes language attributes', () => {
    const { renderer } = setup();
    expect(renderer.renderMarkdown('```ts\nconst value = "<unsafe>";\n```')).toContain('class="language-ts"');
    expect(renderer.renderMarkdown('```ts\nconst value = "<unsafe>";\n```')).toContain('&lt;unsafe&gt;');
    expect(renderer.renderMarkdown('```ts" onmouseover="alert(1)\nhello\n```')).not.toContain('onmouseover="alert');
  });

  it('keeps diagram fences inert until the diagram renderer runs', () => {
    const { renderer, document, engine } = setup();
    const output = renderer.renderMarkdown('```mermaid\nflowchart LR\nA-->B\n```');
    expect(output).toContain('mermaid-pending');
    expect(output).toContain('flowchart LR');
    expect(document.querySelector('script')).toBeNull();
    expect(engine.render).not.toHaveBeenCalled();
  });

  it('preserves diff cards and their escaped source metadata', () => {
    const { renderer } = setup();
    const output = renderer.renderMarkdown('```diff\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n```');
    expect(output).toContain('file-edit-card');
    expect(output).toContain('data-file-path="test.ts"');
    expect(output).toContain('file-edit-line-content">new');
    expect(output).toContain('data-full-diff=');
  });

  it('does not change the shared Marked parser configuration', () => {
    const code = '```mermaid\nA-->B\n```';
    const before = marked.parse(code);
    const { renderer } = setup();
    renderer.renderMarkdown(code);
    expect(marked.parse(code)).toBe(before);
  });
});

describe('diagram lifecycle', () => {
  it('shares a lazy load and renders each pending block once across concurrent requests', async () => {
    const h = setup();
    const second = h.block.cloneNode(true);
    h.document.body.appendChild(second);
    const a = h.renderer.renderDiagrams();
    const b = h.renderer.renderDiagrams();
    expect(h.document.querySelectorAll('script')).toHaveLength(1);
    h.load();
    await Promise.all([a, b]);
    expect(h.engine.initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
    expect(h.engine.render).toHaveBeenCalledTimes(2);
    expect(new Set(h.engine.render.mock.calls.map(call => call[0])).size).toBe(2);
    expect(h.document.querySelectorAll('.mermaid-rendered')).toHaveLength(2);
  });

  it('retries a failed library load without retaining a rejected promise', async () => {
    const h = setup();
    const first = h.renderer.renderDiagrams();
    h.fail();
    await first;
    expect(h.block.classList.contains('mermaid-error')).toBe(true);
    expect(h.document.querySelector('script')).toBeNull();
    const retry = h.renderer.renderDiagrams();
    h.load();
    await retry;
    expect(h.block.classList.contains('mermaid-rendered')).toBe(true);
    expect(h.block.classList.contains('mermaid-error')).toBe(false);
  });

  it('settles and reports a loaded script that never exposed the library', async () => {
    const h = setup();
    h.unavailable();
    const task = h.renderer.renderDiagrams();
    h.load();
    await task;
    expect(h.block.classList.contains('mermaid-error')).toBe(true);
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('settles pending loads on disposal and never modifies the closed document', async () => {
    const h = setup();
    const task = h.renderer.renderDiagrams();
    h.renderer.dispose();
    await task;
    expect(h.document.querySelector('script')).toBeNull();
    expect(h.engine.render).not.toHaveBeenCalled();
    expect(h.block.textContent).toContain('flowchart');
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('does not insert a completed diagram after disposal', async () => {
    const h = setup();
    const work = deferred<{ svg: string }>();
    h.engine.render.mockReturnValueOnce(work.promise);
    const task = h.renderer.renderDiagrams();
    h.load();
    await vi.waitFor(() => expect(h.engine.render).toHaveBeenCalledOnce());
    h.renderer.dispose();
    work.resolve({ svg: '<svg><text>stale</text></svg>' });
    await task;
    expect(h.block.querySelector('svg')).toBeNull();
  });

  it('skips a detached block and can render it if the owner reconnects it', async () => {
    const h = setup();
    const task = h.renderer.renderDiagrams();
    h.block.remove();
    h.load();
    await task;
    expect(h.engine.render).not.toHaveBeenCalled();
    expect(h.block.querySelector('svg')).toBeNull();
    h.document.body.appendChild(h.block);
    await h.renderer.renderDiagrams();
    expect(h.engine.render).toHaveBeenCalledOnce();
    expect(h.block.classList.contains('mermaid-rendered')).toBe(true);
  });

  it('ignores an older result after the same block receives new source', async () => {
    const h = setup();
    const old = deferred<{ svg: string }>();
    h.engine.render.mockReturnValueOnce(old.promise);
    const first = h.renderer.renderDiagrams();
    h.load();
    await vi.waitFor(() => expect(h.engine.render).toHaveBeenCalledOnce());
    h.block.textContent = 'flowchart LR\nNew-->Source';
    await h.renderer.renderDiagrams();
    old.resolve({ svg: '<svg><text>stale</text></svg>' });
    await first;
    expect(h.block.textContent).toBe('complete');
    expect(h.engine.render).toHaveBeenCalledTimes(2);
  });
});
