/**
 * Plan 23 B2 — model output is rendered as HTML, so it must be sanitized.
 *
 * Two halves, and the split matters:
 *
 *  1. STRUCTURAL — assertions about the SHIPPED files. That every render site
 *     routes through the helper, that the helper fails closed, and that the CSP
 *     carries the directives that do not fall back to `default-src`.
 *
 *  2. BEHAVIOURAL — real DOMPurify, run against the option object PARSED OUT OF
 *     `chat.js` rather than restated here. A mirrored copy of a sanitizer config
 *     would pass forever while the shipped one was weakened, which is the one
 *     thing a security test must not do.
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
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const ROOT = path.resolve(__dirname, '..', '..');
const chatJs = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'index.html'), 'utf8');

describe('structural: every render site is sanitized', () => {
  it('no direct marked.parse outside the helper', () => {
    // One occurrence only — the call inside renderMarkdownSafe itself.
    expect((chatJs.match(/marked\.parse\(/g) || []).length).toBe(1);
    const helperStart = chatJs.indexOf('function renderMarkdownSafe');
    expect(helperStart).toBeGreaterThan(-1);
    expect(chatJs.indexOf('marked.parse(')).toBeGreaterThan(helperStart);
  });

  it('the render sites call the helper', () => {
    expect((chatJs.match(/renderMarkdownSafe\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('the helper fails CLOSED when DOMPurify is absent', () => {
    // Showing raw HTML because a library failed to load would be the worst
    // possible fallback, so the helper degrades to plain text instead.
    const helper = chatJs.slice(chatJs.indexOf('function renderMarkdownSafe'));
    const body = helper.slice(0, helper.indexOf('\n      }') + 8);
    expect(body).toContain("typeof DOMPurify === 'undefined'");
    expect(body).toContain('textContent');
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

describe('behavioural: real DOMPurify with the SHIPPED options', () => {
  /**
   * Parse the option object out of chat.js so this test is bound to what
   * actually ships. If someone widens FORBID_TAGS or drops the config, these
   * assertions fail rather than continuing to pass against a stale copy.
   */
  function shippedOptions(): Record<string, unknown> {
    const call = chatJs.slice(chatJs.indexOf('DOMPurify.sanitize(raw, {'));
    const body = call.slice(call.indexOf('{'), call.indexOf('});') + 1);
    const list = (key: string): string[] => {
      const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(body);
      return m ? (m[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, '')) : [];
    };
    return { ADD_ATTR: list('ADD_ATTR'), FORBID_TAGS: list('FORBID_TAGS'), FORBID_ATTR: list('FORBID_ATTR') };
  }

  const purify = createDOMPurify(new JSDOM('').window as unknown as Window & typeof globalThis);
  const clean = (html: string): string => String(purify.sanitize(html, shippedOptions()));

  it('parsed the real options rather than a restated copy', () => {
    const opts = shippedOptions();
    expect((opts.FORBID_TAGS as string[]).length).toBeGreaterThan(0);
    expect(opts.FORBID_TAGS).toContain('iframe');
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
