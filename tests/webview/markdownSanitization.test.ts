/**
 * Plan 23 B2 — model output is rendered as HTML, so it must be sanitized.
 *
 * Two halves, and the split matters:
 *
 *  1. STRUCTURAL — assertions about the SHIPPED files. That every render site
 *     routes through the helper, that the helper fails closed, and that the CSP
 *     carries the directives that do not fall back to `default-src`.
 *
 *  2. BEHAVIOURAL — run the standalone renderer with real Marked and DOMPurify.
 *     Tests exercise the shipped sanitizer options without copying their values.
 *
 * On what is and is not being defended: the webview CSP already blocks the
 * code-execution half (nonce'd `script-src` kills inline `onerror`, and
 * `img-src` omits http(s) so injected markup cannot beacon out). What CSP does
 * not stop is UI SPOOFING — and this is the surface where the user approves
 * permission cards, so markup that merely LOOKS like Mysti's own chrome is the
 * realistic attack.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import * as marked from 'marked';
import type * as vscode from 'vscode';
import { loadMarkdownRenderer } from '../helpers/markdownRenderer';
import { getWebviewContent } from '../../src/webview/webviewContent';

const ROOT = path.resolve(__dirname, '..', '..');
const chatJs = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'index.html'), 'utf8');

describe('structural: every render site is sanitized', () => {
  it('chat render sites route through the standalone renderer', () => {
    expect(chatJs).not.toContain('marked.parse(');
    expect(chatJs).not.toContain('DOMPurify.sanitize(');
    expect(chatJs).toContain('window.MystiMarkdownRenderer.create(');
    expect(chatJs).toContain('markdownRenderer.renderMarkdown(value)');
    expect(chatJs).toContain('renderMarkdownSafe(content)');
    expect(chatJs).toContain('renderMarkdown: renderMarkdownSafe');
    expect(indexHtml.indexOf('{{markdownRendererJsUri}}')).toBeLessThan(indexHtml.indexOf('{{chatJsUri}}'));
  });

  it('emits the renderer resource before chat with a nonce and a fresh asset URI', () => {
    const webview = {
      cspSource: 'vscode-resource://test',
      asWebviewUri: (uri: vscode.Uri) => ({ toString: () => 'vscode-resource://test' + uri.fsPath }),
    } as vscode.Webview;
    const html = getWebviewContent(webview, { fsPath: ROOT, path: ROOT } as vscode.Uri, '1.2.3');
    const dom = new JSDOM(html);
    try {
      const scripts = [...dom.window.document.querySelectorAll('script[src]')];
      const rendererIndex = scripts.findIndex(script => script.getAttribute('src')?.includes('/markdownRenderer.js?'));
      const chatIndex = scripts.findIndex(script => script.getAttribute('src')?.includes('/chat.js?'));
      expect(rendererIndex).toBeGreaterThan(-1);
      expect(rendererIndex).toBeLessThan(chatIndex);
      expect(scripts[rendererIndex].getAttribute('nonce')).toHaveLength(32);
      expect(scripts[rendererIndex].getAttribute('src')).toContain(
        '?v=' + fs.statSync(path.join(ROOT, 'media/chat/markdownRenderer.js')).mtimeMs,
      );
      expect(html).not.toContain('{{markdownRendererJsUri}}');
    } finally { dom.window.close(); }
  });

  it('fails closed when the sanitizer is unavailable', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    try {
      const renderer = loadMarkdownRenderer(dom.window).create({
        document: dom.window.document, marked, getMermaid: () => undefined,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(renderer.renderMarkdown('<img src=x onerror=alert(1)>'))
        .toBe('&lt;img src=x onerror=alert(1)&gt;');
    } finally { dom.window.close(); }
  });

  it('DOMPurify is loaded before marked, from a local resource', () => {
    const purifyAt = indexHtml.indexOf('dompurify.min.js');
    const markedAt = indexHtml.indexOf('marked.min.js');
    expect(purifyAt).toBeGreaterThan(-1);
    expect(purifyAt).toBeLessThan(markedAt);
    // Vendored, never a CDN — a remote script would be blocked by CSP anyway,
    // and would be a supply-chain dependency at render time.
    expect(indexHtml).not.toMatch(/src="https?:\/\/[^"]*(purify|marked)/i);
    expect(fs.existsSync(path.join(ROOT, 'resources', 'dompurify.min.js'))).toBe(true);
  });
});

describe('structural: CSP covers what default-src does not', () => {
  const csp = /content="([^"]*default-src[^"]*)"/.exec(indexHtml)?.[1] ?? '';

  it('has a CSP at all', () => {
    expect(csp).toContain("default-src 'none'");
  });

  it("sets form-action and base-uri, which do NOT inherit from default-src", () => {
    // Without these, injected markup could POST a form to a remote origin, or
    // rewrite every relative URL on the page with a single <base> tag.
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('does not allow remote images, so injected markup cannot beacon out', () => {
    const imgSrc = /img-src ([^;]*)/.exec(csp)?.[1] ?? '';
    expect(imgSrc).not.toMatch(/https?:/);
  });

  it('does not allow unsafe-inline scripts', () => {
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).toContain('nonce-');
    expect(scriptSrc).not.toContain('unsafe-inline');
  });
});

describe('behavioural: shipped renderer with real Marked and DOMPurify', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const purify = createDOMPurify(dom.window as unknown as Window & typeof globalThis);
  const renderer = loadMarkdownRenderer(dom.window).create({
    document: dom.window.document, marked,
    sanitize: (html, options) => String(purify.sanitize(html, options)),
    getMermaid: () => undefined,
  });
  const clean = (html: string) => renderer.renderMarkdown(html);
  afterAll(() => { renderer.dispose(); dom.window.close(); });

  it('parses ordinary Markdown through the configured renderer', () => {
    expect(clean('## Title\n\n**bold**')).toContain('<h2>Title</h2>');
    expect(clean('## Title\n\n**bold**')).toContain('<strong>bold</strong>');
  });

  it('strips inline event handlers', () => {
    expect(clean('<img src=x onerror="alert(1)">')).not.toContain('onerror');
    expect(clean('<div onclick="steal()">hi</div>')).not.toContain('onclick');
  });

  it('strips javascript: URLs', () => {
    expect(clean('<a href="javascript:alert(1)">click</a>').toLowerCase()).not.toContain('javascript:');
  });

  it('removes the tags that spoof Mysti chrome', () => {
    // The realistic attack on a chat surface: markup that looks like a real
    // permission card with a real approve button.
    const spoof = '<form action="https://evil.test"><button>Approve</button><input name="x"></form>';
    const out = clean(spoof);
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('<input');
  });

  it('removes iframes, objects and embeds', () => {
    expect(clean('<iframe src="data:text/html,hi"></iframe>')).not.toContain('<iframe');
    expect(clean('<object data="x"></object>')).not.toContain('<object');
    expect(clean('<embed src="x">')).not.toContain('<embed');
  });

  it('removes <base> and <meta>, which can rewrite or redirect the page', () => {
    expect(clean('<base href="https://evil.test/">')).not.toContain('<base');
    expect(clean('<meta http-equiv="refresh" content="0;url=https://evil.test">')).not.toContain('<meta');
  });

  it('strips formaction and srcdoc', () => {
    expect(clean('<button formaction="https://evil.test">x</button>')).not.toContain('formaction');
    expect(clean('<iframe srcdoc="<script>x</script>"></iframe>')).not.toContain('srcdoc');
  });

  it('KEEPS ordinary rendered markdown intact', () => {
    // A sanitizer that mangles normal output gets turned off, so this matters
    // as much as the refusals.
    const out = clean('<h2>Title</h2><p><strong>bold</strong> and <em>italic</em></p>'
      + '<pre><code class="language-ts">const x = 1;</code></pre>'
      + '<ul><li>one</li></ul><a href="https://example.com">link</a>');
    expect(out).toContain('<h2>');
    expect(out).toContain('<strong>');
    expect(out).toContain('class="language-ts"');   // Prism hook survives
    expect(out).toContain('<li>');
    expect(out).toContain('href="https://example.com"');
  });

  it('keeps the attributes Prism and Mermaid need', () => {
    expect(clean('<code class="language-mermaid">graph TD;</code>')).toContain('language-mermaid');
  });
});
