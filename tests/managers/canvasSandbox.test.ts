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
