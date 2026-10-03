/**
 * `CanvasSandbox` — the ONE builder for a page's iframe document, plus the
 * host ⇄ frame port contract it defines.
 *
 * Two things are being defended here:
 *
 * 1. **Mode discipline.** A document-first page must ship no Babel and get the
 *    hardened CSP; a `legacy` page must still render exactly as before. Getting
 *    that backwards either re-adds 2.98 MB to every frame or silently breaks
 *    every pre-Phase-2 design, and both are invisible until a user opens a
 *    canvas.
 * 2. **Untrusted-in-both-directions.** The bootstrap payload is model-authored
 *    (it must not be able to close its own `<script>`), and everything the
 *    frame posts back is model-influenced (it must not be able to hand the host
 *    an `Infinity` rect, a 50 MB string, or a forged mid).
 */
import { describe, it, expect } from 'vitest';
import {
  buildThemeCssVars,
  themeTokenMap,
  rewriteAssetTokens,
  buildPageDocument,
  pageRenderMode,
  parseFrameUpMessage,
  frameHandshakeMessage,
  PAGE_ROOT_ID,
  PAGE_JSX_SCRIPT_ID,
  PAGE_DOC_SCRIPT_ID,
  SANDBOX_INNER_CSP,
  DOC_SANDBOX_INNER_CSP,
  FRAME_PROTOCOL_VERSION,
  FRAME_HOST_SOURCE,
  FRAME_PAGE_SOURCE,
} from '../../src/managers/CanvasSandbox';
import type { SandboxRuntime } from '../../src/managers/CanvasSandbox';
import { DesignSpecManager } from '../../src/managers/DesignSpecManager';
import { getFormat } from '../../src/managers/CanvasFormats';
import type { ArtifactPage } from '../../src/types';
import type { DocNode } from '../../src/canvas/doc/DocNode';

const theme = DesignSpecManager.getDefaultTheme();
const desktop = getFormat('desktop')!;
const mobile = getFormat('mobile')!;

const runtime: SandboxRuntime = {
  headScripts: ['/*react*/window.React={};', '/*recharts*/window.Recharts={};'],
  harness: '/*harness*/console.log("mount");',
  css: '.u-flex{display:flex}',
};

const BABEL = '/*BABEL-STANDALONE*/window.Babel={};';

function doc(over: Partial<DocNode> = {}): DocNode {
  return {
    mid: 'aaaaaaaaaa',
    tag: 'UI.Screen',
    children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Welcome' }],
    ...over,
  };
}

function docPage(over: Partial<ArtifactPage> = {}): ArtifactPage {
  return { id: 'p1', version: 1, doc: doc(), boardPos: { x: 0, y: 0 }, ...over };
}

function legacyJsxPage(source: string): ArtifactPage {
  return docPage({ legacy: { mode: 'jsx', source }, jsxCache: source, compileError: 'unsupported syntax' });
}

function legacyHtmlPage(source: string): ArtifactPage {
  return docPage({ legacy: { mode: 'html', source }, jsxCache: '' });
}

describe('CanvasSandbox — theme tokens', () => {
  it('buildThemeCssVars emits --theme-* custom properties for colors, type, radii, shadows', () => {
    const css = buildThemeCssVars(theme);
    expect(css).toContain('--theme-color-primary:');
    expect(css).toContain('--theme-color-text-secondary:'); // camelCase → kebab
    expect(css).toContain('--theme-font-body:');
    expect(css).toContain('--theme-radius-md:');
    expect(css).toContain('--theme-shadow-sm:');
    expect(css.trim().startsWith(':root {')).toBe(true);
  });

  it('themeTokenMap is the SAME source the baked CSS is derived from', () => {
    const css = buildThemeCssVars(theme);
    const map = themeTokenMap(theme);
    for (const [name, value] of Object.entries(map)) {
      expect(css).toContain(`--theme-${name}: ${value};`);
    }
    // …and nothing is in the CSS that is not in the map.
    const declared = [...css.matchAll(/--theme-([a-z0-9-]+):/g)].map(m => m[1]);
    expect(declared.slice().sort()).toEqual(Object.keys(map).slice().sort());
  });

  it('numeric radii become px and weights stay unitless', () => {
    const map = themeTokenMap(theme);
    expect(map['radius-md']).toMatch(/px$/);
    expect(map['space-unit']).toMatch(/px$/);
    expect(map['weight-bold']).toMatch(/^\d+$/);
  });
});

describe('CanvasSandbox — rewriteAssetTokens', () => {
  it('replaces asset:// refs via the resolver', () => {
    const out = rewriteAssetTokens('<img src="asset://a/assets/x.png">', r => `https://host/${r.slice(8)}`);
    expect(out).toContain('https://host/a/assets/x.png');
    expect(out).not.toContain('asset://');
  });

  it('leaves the source unchanged with no resolver', () => {
    const src = 'asset://a/assets/x.png';
    expect(rewriteAssetTokens(src)).toBe(src);
  });
});

describe('CanvasSandbox — render modes', () => {
  it('a document-first page is doc mode; legacy pages keep their own mode', () => {
    expect(pageRenderMode(docPage())).toBe('doc');
    expect(pageRenderMode(legacyJsxPage('function Page(){}'))).toBe('jsx');
    expect(pageRenderMode(legacyHtmlPage('<h1>x</h1>'))).toBe('html');
  });

  it('an explicit doc override forces doc mode even for a legacy page', () => {
    expect(pageRenderMode(legacyJsxPage('function Page(){}'), doc())).toBe('doc');
  });
});

describe('CanvasSandbox — doc mode', () => {
  const built = buildPageDocument({ page: docPage(), theme, format: mobile, runtime });

  it('marks the document as doc mode and ships an empty root', () => {
    expect(built).toContain('data-mode="doc"');
    expect(built).toContain(`<div id="${PAGE_ROOT_ID}"></div>`);
    expect(built).toContain('data-format="mobile"');
    expect(built).toContain(`#${PAGE_ROOT_ID} { width: 390px`);
  });

  it('bakes the doc as a NON-EXECUTED application/json bootstrap', () => {
    expect(built).toContain(`<script type="application/json" id="${PAGE_DOC_SCRIPT_ID}">`);
    expect(built).toContain('"tag":"UI.Screen"');
    expect(built).toContain('"mid":"bbbbbbbbbb"');
    expect(built).not.toContain(PAGE_JSX_SCRIPT_ID);
  });

  it('ships the theme as tokens so the frame can swap it without a rebuild', () => {
    expect(built).toContain('"themeTokens"');
    expect(built).toContain('"color-primary"');
  });

  it('carries only the format fields the frame needs', () => {
    expect(built).toContain('"format":{"formatId":"mobile","width":390,"height":844}');
  });

  it('NEVER emits Babel, even when the runtime carries it', () => {
    const withBabel = buildPageDocument({ page: docPage(), theme, format: desktop, runtime: { ...runtime, babel: BABEL } });
    expect(withBabel).not.toContain('BABEL-STANDALONE');
    const withBabelSrc = buildPageDocument({
      page: docPage(), theme, format: desktop,
      runtime: { headScriptSrcs: ['./react.js'], babelSrc: './babel.min.js', harnessSrc: './harness.js' },
    });
    expect(withBabelSrc).not.toContain('babel.min.js');
  });

  it('resolves asset:// refs inside the bootstrap payload', () => {
    const page = docPage({ doc: doc({ children: [{ mid: 'cccccccccc', tag: 'img', props: { src: 'asset://d/assets/y.png' } }] }) });
    const out = buildPageDocument({ page, theme, format: desktop, runtime, resolveAsset: r => `vscode-webview://${r.slice(8)}` });
    expect(out).toContain('vscode-webview://d/assets/y.png');
    expect(out).not.toContain('asset://');
  });

  it('an explicit doc renders instead of the page (speculative streaming path)', () => {
    const out = buildPageDocument({
      page: legacyJsxPage('function Page(){ return <div/>; }'),
      theme, format: desktop, runtime,
      doc: doc({ mid: 'dddddddddd' }),
    });
    expect(out).toContain('data-mode="doc"');
    expect(out).toContain('"mid":"dddddddddd"');
    expect(out).not.toContain('function Page()');
  });

  describe('bootstrap escaping', () => {
    it('a model-authored </script> in the doc cannot close the bootstrap block', () => {
      const page = docPage({ doc: doc({ children: [{ mid: 'cccccccccc', tag: 'div', text: '</script><img src=x onerror=alert(1)>' }] }) });
      const out = buildPageDocument({ page, theme, format: desktop, runtime });
      // The `<` is what terminates a <script> element, whatever its type, so
      // the block itself must contain no literal `</script` at all.
      const open = `<script type="application/json" id="${PAGE_DOC_SCRIPT_ID}">`;
      const block = out.slice(out.indexOf(open) + open.length);
      const body = block.slice(0, block.indexOf('</script>'));
      expect(body).toContain('onerror');            // the payload really is in there
      expect(body).not.toContain('</script');
      expect(body).not.toContain('<img');
      expect(body).toContain('\\u003c/script>');
    });

    it('a model-authored <!-- cannot open an HTML comment', () => {
      const page = docPage({ doc: doc({ children: [{ mid: 'cccccccccc', tag: 'div', text: '<!--' }] }) });
      const out = buildPageDocument({ page, theme, format: desktop, runtime });
      expect(out).not.toContain('<!--');
    });

    it('a cyclic doc degrades to null rather than throwing', () => {
      const cyclic = doc() as DocNode & { self?: unknown };
      cyclic.self = cyclic;
      const out = buildPageDocument({ page: docPage({ doc: cyclic }), theme, format: desktop, runtime });
      expect(out).toContain(`id="${PAGE_DOC_SCRIPT_ID}">null<`);
    });
  });

  describe('CSP', () => {
    it('uses the hardened doc policy: no eval, no remote images, no forms', () => {
      expect(built).toContain(`content="${DOC_SANDBOX_INNER_CSP.replace(/"/g, '&quot;')}"`);
      expect(built).not.toContain("'unsafe-eval'");
      expect(built).toContain('img-src data: blob:;');
      expect(built).toContain("form-action 'none'");
      expect(built).toContain("base-uri 'none'");
      expect(built).toContain("object-src 'none'");
      expect(built).toContain("connect-src 'none'");
    });

    it('appends caller-supplied img sources (the webview cspSource)', () => {
      const out = buildPageDocument({
        page: docPage(), theme, format: desktop, runtime,
        imgSources: ['vscode-webview://abc123'],
      });
      expect(out).toContain('img-src data: blob: vscode-webview://abc123;');
    });

    it('DROPS an img source carrying CSP-structural characters', () => {
      const out = buildPageDocument({
        page: docPage(), theme, format: desktop, runtime,
        imgSources: ["https://ok.example", "x; script-src 'unsafe-eval'", 'has space', '"quoted"'],
      });
      expect(out).toContain('img-src data: blob: https://ok.example;');
      expect(out).not.toContain("script-src 'unsafe-eval'");
    });

    it("widens script-src with 'self'/file: for a src-loaded runtime, and img-src with file:", () => {
      const out = buildPageDocument({
        page: docPage(), theme, format: desktop,
        runtime: { headScriptSrcs: ['../runtime/react.js'], harnessSrc: '../runtime/harness.js' },
      });
      expect(out).toContain("script-src 'unsafe-inline' 'self' file:");
      expect(out).toContain('img-src data: blob: file:');
      expect(out).not.toContain("'unsafe-eval'");
    });

    it('widens script-src with data: for the PNG capture path', () => {
      const out = buildPageDocument({
        page: docPage(), theme, format: desktop,
        runtime: { headScriptSrcs: ['data:text/javascript;base64,QQ=='], harnessSrc: 'data:text/javascript;base64,QQ==' },
      });
      expect(out).toContain("script-src 'unsafe-inline' data:");
      expect(out).not.toContain("'self'");
    });
  });
});

describe('CanvasSandbox — legacy jsx mode', () => {
  const source = 'function Page(){return <div/>;}';
  const built = buildPageDocument({
    page: legacyJsxPage(source), theme, format: desktop,
    runtime: { ...runtime, babel: BABEL },
  });

  it('embeds the JSX as a non-executed text/plain script', () => {
    expect(built).toContain('data-mode="jsx"');
    expect(built).toContain(`id="${PAGE_JSX_SCRIPT_ID}"`);
    expect(built).toContain('type="text/plain"');
    expect(built).toContain(source);
    expect(built).not.toContain(PAGE_DOC_SCRIPT_ID);
  });

  it('injects Babel into THIS frame only, after the rest of the runtime', () => {
    expect(built).toContain('BABEL-STANDALONE');
    expect(built.indexOf('BABEL-STANDALONE')).toBeGreaterThan(built.indexOf('/*react*/'));
  });

  it('keeps unsafe-eval (Babel needs it) but NOT the remote-image wildcard', () => {
    expect(built).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    // E-2: `img-src … https:` used to be here, justified as "old pages may use
    // remote images". It is gone: `mode:'html'` is a shape a MODEL can author.
    expect(built).toContain('img-src data: blob:;');
    expect(built).toContain('font-src data:;');
  });

  it('omits Babel when the caller supplied none (the harness then says so)', () => {
    const out = buildPageDocument({ page: legacyJsxPage(source), theme, format: desktop, runtime });
    expect(out).not.toContain('BABEL-STANDALONE');
    expect(out).toContain(source);
  });

  it('neutralizes a closing-script sequence inside the page source', () => {
    const out = buildPageDocument({
      page: legacyJsxPage('function Page(){return <div>x</script></div>;}'),
      theme, format: desktop, runtime,
    });
    expect(out).not.toContain('x</script></div>');
    expect(out).toContain('<\\/script');
  });

  it('rewrites asset tokens inside JSX', () => {
    const out = buildPageDocument({
      page: legacyJsxPage('function Page(){return <img src="asset://d/assets/y.png"/>;}'),
      theme, format: desktop, runtime,
      resolveAsset: r => `vscode-webview://${r.slice(8)}`,
    });
    expect(out).toContain('vscode-webview://d/assets/y.png');
    expect(out).not.toContain('asset://');
  });
});

describe('CanvasSandbox — legacy html mode', () => {
  const built = buildPageDocument({ page: legacyHtmlPage('<h1>Home</h1>'), theme, format: mobile, runtime: { ...runtime, babel: BABEL } });

  it('inlines the html into the page root and sets device-px size', () => {
    expect(built).toContain(`<div id="${PAGE_ROOT_ID}"><h1>Home</h1></div>`);
    expect(built).toContain(`#${PAGE_ROOT_ID} { width: 390px`);
    expect(built).toContain('data-mode="html"');
  });

  it('never ships Babel — html needs no compiler', () => {
    expect(built).not.toContain('BABEL-STANDALONE');
  });

  it('injects theme vars + runtime scripts + harness, all inlined', () => {
    expect(built).toContain('--theme-color-primary:');
    expect(built).toContain('window.React=');
    expect(built).toContain('/*harness*/');
    expect(built).toContain('.u-flex{display:flex}');
  });

  it('loads no external scripts (sandbox=allow-scripts only, no network)', () => {
    expect(built).not.toMatch(/<script[^>]+src=/i);
  });
});

describe('CanvasSandbox — CSP overrides and the mirror constant', () => {
  const base = { page: docPage(), theme, format: desktop, runtime };

  it('csp: false omits the meta; a custom string is used verbatim', () => {
    expect(buildPageDocument({ ...base, csp: false })).not.toContain('Content-Security-Policy');
    expect(buildPageDocument({ ...base, csp: "default-src 'self';" })).toContain(`content="default-src 'self';"`);
  });

  it('exports the mirror CSP constant unchanged (media/canvas/canvas.js via canvasContent)', () => {
    expect(SANDBOX_INNER_CSP).toContain("default-src 'none'");
    expect(SANDBOX_INNER_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(SANDBOX_INNER_CSP).toContain("connect-src 'none'");
  });

  it('the doc policy is strictly tighter than the legacy one', () => {
    expect(DOC_SANDBOX_INNER_CSP).not.toContain("'unsafe-eval'");
    expect(DOC_SANDBOX_INNER_CSP).not.toContain('https:');
    expect(SANDBOX_INNER_CSP).toContain("'unsafe-eval'");
  });
});

describe('CanvasSandbox — frame port protocol', () => {
  it('the handshake names the host source and carries no payload', () => {
    expect(frameHandshakeMessage()).toEqual({ source: FRAME_HOST_SOURCE, t: 'port' });
    expect(FRAME_HOST_SOURCE).toBe('mysti-canvas-host');
    expect(FRAME_PAGE_SOURCE).toBe('mysti-canvas-page');
    expect(FRAME_PROTOCOL_VERSION).toBe(1);
  });

  describe('parseFrameUpMessage', () => {
    it('accepts ready', () => {
      expect(parseFrameUpMessage({ t: 'ready', protocol: 1 })).toEqual({ t: 'ready', protocol: 1 });
      expect(parseFrameUpMessage({ t: 'ready' })).toEqual({ t: 'ready', protocol: 0 });
    });

    it('accepts and rounds size, clamping negatives', () => {
      expect(parseFrameUpMessage({ t: 'size', w: 390.4, h: 844.6 })).toEqual({ t: 'size', w: 390, h: 845 });
      expect(parseFrameUpMessage({ t: 'size', w: -5, h: 10 })).toEqual({ t: 'size', w: 0, h: 10 });
      expect(parseFrameUpMessage({ t: 'size', w: Infinity, h: 10 })).toBeNull();
      expect(parseFrameUpMessage({ t: 'size', w: '390', h: 10 })).toBeNull();
    });

    it('accepts rects, dropping malformed entries instead of the whole message', () => {
      const out = parseFrameUpMessage({
        t: 'rects',
        rects: {
          aaaaaaaaaa: { x: 1, y: 2, w: 3, h: 4 },
          bbbbbbbbbb: { x: 1, y: 2, w: Infinity, h: 4 },
          'not a mid': { x: 1, y: 2, w: 3, h: 4 },
          cccccccccc: 'nope',
        },
      });
      expect(out).toEqual({ t: 'rects', rects: { aaaaaaaaaa: { x: 1, y: 2, w: 3, h: 4 } } });
    });

    it('caps how many rects a frame can push at the host', () => {
      const rects: Record<string, unknown> = {};
      for (let i = 0; i < 5000; i++) { rects[`m${String(i).padStart(6, '0')}`] = { x: 0, y: 0, w: 1, h: 1 }; }
      const out = parseFrameUpMessage({ t: 'rects', rects }) as { rects: Record<string, unknown> };
      expect(Object.keys(out.rects)).toHaveLength(4000);
    });

    it('keeps a rect keyed __proto__ as a real own property', () => {
      // JSON.parse, not a literal: `{ __proto__: … }` in source sets the
      // prototype and would never reach the parser as a key at all.
      const rects = JSON.parse('{"__proto__":{"x":1,"y":2,"w":3,"h":4}}') as Record<string, unknown>;
      const out = parseFrameUpMessage({ t: 'rects', rects }) as { rects: Record<string, unknown> };
      // A plain `out[mid] = rect` would hit the prototype setter and the entry
      // would vanish from Object.entries — the element becomes unselectable.
      expect(Object.keys(out.rects)).toEqual(['__proto__']);
      expect(Object.prototype.hasOwnProperty.call(out.rects, '__proto__')).toBe(true);
    });

    it('rejects rects that is not an object', () => {
      expect(parseFrameUpMessage({ t: 'rects', rects: [1, 2] })).toBeNull();
      expect(parseFrameUpMessage({ t: 'rects' })).toBeNull();
    });

    it('accepts a hit and normalizes missing modifiers to false', () => {
      expect(parseFrameUpMessage({ t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 } })).toEqual({
        t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 },
        modifiers: { alt: false, ctrl: false, meta: false, shift: false }, double: false,
      });
    });

    it('coerces truthy-but-not-true modifier values to false', () => {
      const out = parseFrameUpMessage({
        t: 'hit', mid: 'aaaaaaaaaa', rect: { x: 0, y: 0, w: 1, h: 1 },
        modifiers: { alt: 'yes', shift: 1 }, double: 'yes',
      }) as { modifiers: Record<string, boolean>; double: boolean };
      expect(out.modifiers).toEqual({ alt: false, ctrl: false, meta: false, shift: false });
      expect(out.double).toBe(false);
    });

    it('rejects a hit with a forged or oversized mid, or no rect', () => {
      expect(parseFrameUpMessage({ t: 'hit', mid: 'a'.repeat(200), rect: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull();
      expect(parseFrameUpMessage({ t: 'hit', mid: 'has space', rect: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull();
      expect(parseFrameUpMessage({ t: 'hit', mid: 'aaaaaaaaaa' })).toBeNull();
      expect(parseFrameUpMessage({ t: 'hit', rect: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull();
    });

    it('accepts textCommit and clamps a runaway payload', () => {
      expect(parseFrameUpMessage({ t: 'textCommit', mid: 'aaaaaaaaaa', text: 'hi' }))
        .toEqual({ t: 'textCommit', mid: 'aaaaaaaaaa', text: 'hi' });
      const big = parseFrameUpMessage({ t: 'textCommit', mid: 'aaaaaaaaaa', text: 'x'.repeat(1_000_000) }) as { text: string };
      expect(big.text).toHaveLength(20000);
      expect(parseFrameUpMessage({ t: 'textCommit', mid: 'aaaaaaaaaa', text: 42 })).toBeNull();
    });

    it('accepts an error, dropping a bad mid rather than the message', () => {
      expect(parseFrameUpMessage({ t: 'error', message: 'boom', stack: 'at x', mid: 'aaaaaaaaaa' }))
        .toEqual({ t: 'error', message: 'boom', stack: 'at x', mid: 'aaaaaaaaaa' });
      expect(parseFrameUpMessage({ t: 'error', message: 'boom', mid: '../../etc/passwd' }))
        .toEqual({ t: 'error', message: 'boom' });
      const big = parseFrameUpMessage({ t: 'error', message: 'x'.repeat(100000) }) as { message: string };
      expect(big.message).toHaveLength(4000);
    });

    it('rejects anything it does not recognize — never a partial object', () => {
      expect(parseFrameUpMessage(null)).toBeNull();
      expect(parseFrameUpMessage('ready')).toBeNull();
      expect(parseFrameUpMessage([{ t: 'ready' }])).toBeNull();
      expect(parseFrameUpMessage({ t: 'canvas/submit', ops: [] })).toBeNull();
      expect(parseFrameUpMessage({ t: 'mount', doc: {} })).toBeNull();   // a down-tag is not an up-tag
      expect(parseFrameUpMessage({})).toBeNull();
    });

    it('a frame cannot smuggle extra fields through a valid message', () => {
      const out = parseFrameUpMessage({ t: 'size', w: 10, h: 20, author: 'user', viewToken: 'stolen' });
      expect(out).toEqual({ t: 'size', w: 10, h: 20 });
    });
  });
});
