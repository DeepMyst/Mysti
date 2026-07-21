/**
 * CanvasSandbox tests — the iframe srcdoc builder: theme→CSS vars, asset:// token
 * rewrite, device-px page box, JSX vs HTML assembly, and sandbox safety (no
 * external script src; closing-script sequences neutralized).
 */
import { describe, it, expect } from 'vitest';
import {
  buildThemeCssVars,
  rewriteAssetTokens,
  buildPageDocument,
  PAGE_ROOT_ID,
  PAGE_JSX_SCRIPT_ID,
  SANDBOX_INNER_CSP,
} from '../../src/managers/CanvasSandbox';
import type { SandboxRuntime } from '../../src/managers/CanvasSandbox';
import { DesignSpecManager } from '../../src/managers/DesignSpecManager';
import { getFormat } from '../../src/managers/CanvasFormats';
import type { ArtifactPage } from '../../src/types';

const theme = DesignSpecManager.getDefaultTheme();
const runtime: SandboxRuntime = {
  headScripts: ['/*react*/window.React={};', '/*recharts*/window.Recharts={};'],
  harness: '/*harness*/console.log("mount");',
  css: '.u-flex{display:flex}',
};

function page(p: Partial<ArtifactPage> & Pick<ArtifactPage, 'mode'>): ArtifactPage {
  return { id: 'p1', version: 1, ...p };
}

describe('CanvasSandbox', () => {
  describe('buildThemeCssVars', () => {
    it('emits --theme-* custom properties for colors, type, radii, shadows', () => {
      const css = buildThemeCssVars(theme);
      expect(css).toContain('--theme-color-primary:');
      expect(css).toContain('--theme-color-text-secondary:'); // camelCase → kebab
      expect(css).toContain('--theme-font-body:');
      expect(css).toContain('--theme-radius-md:');
      expect(css).toContain('--theme-shadow-sm:');
      expect(css.trim().startsWith(':root {')).toBe(true);
    });
  });

  describe('rewriteAssetTokens', () => {
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

  describe('buildPageDocument — HTML mode', () => {
    const doc = buildPageDocument({
      page: page({ mode: 'html', htmlSource: '<h1>Home</h1>' }),
      theme,
      format: getFormat('mobile')!,
      runtime,
    });

    it('inlines the html into the page root and sets device-px size', () => {
      expect(doc).toContain(`<div id="${PAGE_ROOT_ID}"><h1>Home</h1></div>`);
      expect(doc).toContain(`#${PAGE_ROOT_ID} { width: 390px`); // mobile real px
      expect(doc).toContain('data-mode="html"');
      expect(doc).toContain('data-format="mobile"');
    });

    it('injects theme vars + runtime scripts + harness, all inlined', () => {
      expect(doc).toContain('--theme-color-primary:');
      expect(doc).toContain('window.React=');
      expect(doc).toContain('/*harness*/');
      expect(doc).toContain('.u-flex{display:flex}');
    });

    it('loads no external scripts (sandbox=allow-scripts only, no network)', () => {
      expect(doc).not.toMatch(/<script[^>]+src=/i);
    });
  });

  describe('buildPageDocument — JSX mode', () => {
    it('embeds the JSX as a non-executed text/plain script', () => {
      const doc = buildPageDocument({
        page: page({ mode: 'jsx', jsxSource: 'function Page(){return <div/>;}' }),
        theme,
        format: getFormat('desktop')!,
        runtime,
      });
      expect(doc).toContain('data-mode="jsx"');
      expect(doc).toContain(`id="${PAGE_JSX_SCRIPT_ID}"`);
      expect(doc).toContain('type="text/plain"');
      expect(doc).toContain('function Page(){return <div/>;}');
      expect(doc).toContain(`#${PAGE_ROOT_ID} { width: 1440px`); // desktop
    });

    it('neutralizes a closing-script sequence inside the page source', () => {
      const doc = buildPageDocument({
        page: page({ mode: 'jsx', jsxSource: 'function Page(){return <div>x</script></div>;}' }),
        theme,
        format: getFormat('desktop')!,
        runtime,
      });
      expect(doc).not.toContain('x</script></div>'); // the </script was escaped
      expect(doc).toContain('<\\/script');
    });

    it('supports src-referenced runtime scripts (webview/preview mode)', () => {
      const doc = buildPageDocument({
        page: page({ mode: 'jsx', jsxSource: 'function Page(){return <div/>;}' }),
        theme,
        format: getFormat('desktop')!,
        runtime: { headScriptSrcs: ['./react.js', './babel.js'], harnessSrc: './harness.js', css: '' },
      });
      expect(doc).toContain('<script src="./react.js"></script>');
      expect(doc).toContain('<script src="./babel.js"></script>');
      expect(doc).toContain('<script src="./harness.js"></script>');
    });

    it('carries the sandbox CSP meta by default (6.2 — inlined runtime = exact webview mirror)', () => {
      const doc = buildPageDocument({
        page: page({ mode: 'html', htmlSource: '<h1>Hi</h1>' }),
        theme,
        format: getFormat('desktop')!,
        runtime,
      });
      expect(doc).toContain('<meta http-equiv="Content-Security-Policy"');
      expect(doc).toContain("default-src 'none'");
      expect(doc).toContain("connect-src 'none'");
      expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
      // Inlined runtime needs no script source-list entries.
      expect(doc).not.toContain("script-src 'unsafe-inline' 'unsafe-eval' 'self'");
    });

    it("widens script-src with 'self' for src-loaded runtimes (export bundle)", () => {
      const doc = buildPageDocument({
        page: page({ mode: 'html', htmlSource: '<h1>Hi</h1>' }),
        theme,
        format: getFormat('desktop')!,
        runtime: { headScriptSrcs: ['../runtime/react.js'], harnessSrc: '../runtime/harness.js' },
      });
      expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval' 'self'");
      expect(doc).toContain("default-src 'none'");
    });

    it('widens script-src with data: for data-URI runtimes (PNG capture path)', () => {
      const doc = buildPageDocument({
        page: page({ mode: 'html', htmlSource: '<h1>Hi</h1>' }),
        theme,
        format: getFormat('desktop')!,
        runtime: { headScriptSrcs: ['data:text/javascript;base64,QQ=='], harnessSrc: 'data:text/javascript;base64,QQ==' },
      });
      expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval' data:");
      expect(doc).not.toContain("'self'");
    });

    it('csp: false omits the meta; a custom string is used verbatim', () => {
      const base = {
        page: page({ mode: 'html', htmlSource: '<h1>Hi</h1>' }),
        theme,
        format: getFormat('desktop')!,
        runtime,
      };
      const noCsp = buildPageDocument({ ...base, csp: false });
      expect(noCsp).not.toContain('Content-Security-Policy');
      const custom = buildPageDocument({ ...base, csp: "default-src 'self';" });
      expect(custom).toContain(`content="default-src 'self';"`);
    });

    it('exports the mirror CSP constant (must match media/canvas/canvas.js via canvasContent)', () => {
      expect(SANDBOX_INNER_CSP).toContain("default-src 'none'");
      expect(SANDBOX_INNER_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
      expect(SANDBOX_INNER_CSP).toContain("connect-src 'none'");
    });

    it('rewrites asset tokens inside JSX', () => {
      const doc = buildPageDocument({
        page: page({ mode: 'jsx', jsxSource: 'function Page(){return <img src="asset://d/assets/y.png"/>;}' }),
        theme,
        format: getFormat('desktop')!,
        runtime,
        resolveAsset: r => `vscode-webview://${r.slice(8)}`,
      });
      expect(doc).toContain('vscode-webview://d/assets/y.png');
      expect(doc).not.toContain('asset://');
    });
  });
});
