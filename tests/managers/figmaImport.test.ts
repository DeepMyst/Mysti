/**
 * FigmaImport tests — converting a Figma frame node into an html page
 * (positions relative to the frame, fills, text styles), wrapper-shape
 * detection, and the import_design tool path.
 *
 * Plan 20 §3.6 ("importers are transcoders"): the payload is third-party data
 * arriving through a model, so the second half of this suite is adversarial —
 * every field is assumed hostile and must be re-derived, never formatted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  figmaColorToCss,
  fillToCss,
  findFigmaFrame,
  figmaFrameToPageSpec,
  importFigmaPayload,
  cssColor,
  cssFontFamily,
} from '../../src/managers/FigmaImport';
import type { FigmaNode } from '../../src/managers/FigmaImport';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool } from '../../src/managers/CanvasToolDispatch';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';
import { pageHtml, pageMode } from '../../src/canvas/pageMigration';

const frame: FigmaNode = {
  id: '1:2', name: 'Login', type: 'FRAME',
  absoluteBoundingBox: { x: 100, y: 200, width: 390, height: 844 },
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
  children: [
    {
      id: '1:3', name: 'Card', type: 'RECTANGLE',
      absoluteBoundingBox: { x: 120, y: 300, width: 350, height: 200 },
      cornerRadius: 12,
      fills: [{ type: 'SOLID', color: { r: 0.95, g: 0.96, b: 0.98 } }],
    },
    {
      id: '1:4', name: 'Title', type: 'TEXT',
      absoluteBoundingBox: { x: 140, y: 320, width: 200, height: 30 },
      characters: 'Welcome back',
      style: { fontSize: 24, fontWeight: 700, fontFamily: 'Inter', textAlignHorizontal: 'CENTER' },
      fills: [{ type: 'SOLID', color: { r: 0.06, g: 0.09, b: 0.16 } }],
    },
    { id: '1:5', name: 'hidden', type: 'RECTANGLE', visible: false, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
  ],
};

/** Build a one-TEXT-child frame with a hostile style/box, and return the html. */
function textFrame(child: Record<string, unknown>): string {
  return figmaFrameToPageSpec({
    type: 'FRAME', name: 'F', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    children: [{ type: 'TEXT', characters: 'hi', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, ...child } as FigmaNode],
  }).htmlSource!;
}

describe('FigmaImport', () => {
  describe('color', () => {
    it('figmaColorToCss converts 0..1 channels to rgba', () => {
      expect(figmaColorToCss({ r: 1, g: 0, b: 0, a: 1 })).toBe('rgba(255, 0, 0, 1)');
      expect(figmaColorToCss({ r: 0, g: 0, b: 0, a: 0.5 }, 0.5)).toBe('rgba(0, 0, 0, 0.25)');
    });
    it('fillToCss picks the first visible solid fill', () => {
      expect(fillToCss([{ type: 'GRADIENT' }, { type: 'SOLID', color: { r: 0, g: 0, b: 1 } }])).toBe('rgba(0, 0, 255, 1)');
      expect(fillToCss([{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: false }])).toBeNull();
      expect(fillToCss(undefined)).toBeNull();
    });
  });

  describe('figmaFrameToPageSpec', () => {
    const spec = figmaFrameToPageSpec(frame);
    it('produces an html page titled by the frame name', () => {
      expect(spec.mode).toBe('html');
      expect(spec.actionTitle).toBe('Login');
      expect(spec.source).toBe('figma');
    });
    it('sizes the container to the frame and uses its fill', () => {
      expect(spec.htmlSource).toContain('width:390px;height:844px');
      expect(spec.htmlSource).toContain('rgba(255, 255, 255, 1)'); // frame bg
    });
    it('positions children RELATIVE to the frame origin', () => {
      // Card at (120,300) → (20,100) relative to frame (100,200)
      expect(spec.htmlSource).toContain('left:20px;top:100px');
      expect(spec.htmlSource).toContain('border-radius:12px');
    });
    it('renders text with content + style', () => {
      expect(spec.htmlSource).toContain('Welcome back');
      expect(spec.htmlSource).toContain('font-size:24px');
      expect(spec.htmlSource).toContain('text-align:center');
    });
    it('skips invisible nodes', () => {
      expect(spec.htmlSource).not.toContain('rgba(255, 0, 0'); // the hidden red rect
    });
    it('escapes text content', () => {
      const s = figmaFrameToPageSpec({ type: 'FRAME', name: 'F', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: [{ type: 'TEXT', characters: '<b>x</b>', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }] });
      expect(s.htmlSource).toContain('&lt;b&gt;x&lt;/b&gt;');
    });
  });

  describe('findFigmaFrame (wrapper shapes)', () => {
    it('unwraps a direct node', () => { expect(findFigmaFrame(frame)!.name).toBe('Login'); });
    it('unwraps { document }', () => { expect(findFigmaFrame({ document: frame })!.name).toBe('Login'); });
    it('unwraps REST { nodes: { id: { document } } }', () => {
      expect(findFigmaFrame({ nodes: { '1:2': { document: frame } } })!.name).toBe('Login');
    });
    it('returns null for junk', () => { expect(findFigmaFrame({ foo: 1 })).toBeNull(); });
    it('importFigmaPayload unwraps + converts in one step, or returns null', () => {
      expect(importFigmaPayload({ document: frame })!.actionTitle).toBe('Login');
      expect(importFigmaPayload({ foo: 1 })).toBeNull();
      expect(importFigmaPayload(null)).toBeNull();
      expect(importFigmaPayload('a string payload')).toBeNull();
    });
    it('does not blow the stack on a deeply nested wrapper', () => {
      let payload: Record<string, unknown> = { foo: 1 };
      for (let i = 0; i < 50_000; i++) { payload = { document: payload }; }
      expect(findFigmaFrame(payload)).toBeNull();
    });
  });

  // ── Plan 20 §3.6: transcoder, not formatter ──
  describe('adversarial payloads', () => {
    it('a quote-breakout font family is dropped, not quoted-and-hoped', () => {
      const html = textFrame({ style: { fontFamily: 'x" onmouseover="alert(1)' } as never });
      expect(html).not.toContain('onmouseover');
      expect(html).toContain('font-family:system-ui, sans-serif');
    });

    it('a legitimate multi-word family is quoted', () => {
      const html = textFrame({ style: { fontFamily: 'Helvetica Neue' } as never });
      expect(html).toContain('font-family:&quot;Helvetica Neue&quot;, system-ui, sans-serif');
      expect(cssFontFamily('Helvetica Neue')).toBe('"Helvetica Neue", system-ui, sans-serif');
      expect(cssFontFamily('Inter;background:url(x)')).toBe('system-ui, sans-serif');
      expect(cssFontFamily(42)).toBe('system-ui, sans-serif');
      expect(cssFontFamily('A'.repeat(65))).toBe('system-ui, sans-serif');
    });

    it('a </style> / <script> payload cannot escape the style attribute', () => {
      const html = textFrame({ style: { fontFamily: '</style><script>fetch("//evil")</script>' } as never });
      expect(html).not.toContain('<script');
      expect(html).not.toContain('</style>');
    });

    it('javascript:/expression() smuggled through a numeric field is dropped', () => {
      const html = textFrame({
        cornerRadius: '0;background:url(javascript:alert(1))' as never,
        style: { fontSize: 'expression(alert(1))', fontWeight: '400;behavior:url(#x)' } as never,
      });
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('expression(');
      expect(html).not.toContain('behavior:');
      expect(html).toContain('font-size:16px');    // fallback
      expect(html).toContain('font-weight:400');   // fallback
    });

    it('a text-align enum outside the allowlist falls back to left', () => {
      const html = textFrame({ style: { textAlignHorizontal: 'left;background:red' } as never });
      expect(html).toContain('text-align:left;');
      expect(html).not.toContain('background:red');
    });

    it('NaN / Infinity / absurd numbers never reach the markup', () => {
      const spec = figmaFrameToPageSpec({
        type: 'FRAME', name: 'F',
        absoluteBoundingBox: { x: Number.NaN, y: 0, width: Number.POSITIVE_INFINITY, height: 1e12 },
        children: [
          { type: 'RECTANGLE', absoluteBoundingBox: { x: 1e15, y: -1e15, width: Number.NaN, height: 10 }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
          { type: 'TEXT', characters: 'x', absoluteBoundingBox: { x: 0, y: 0, width: 1e9, height: 1e9 }, style: { fontSize: Number.POSITIVE_INFINITY, lineHeightPx: Number.NaN } },
        ],
      });
      expect(spec.htmlSource).not.toContain('NaN');
      expect(spec.htmlSource).not.toContain('Infinity');
      // frame falls back to the 1440x900 default when width is not finite
      expect(spec.htmlSource).toContain('width:1440px;height:100000px');
      // the NaN-width rectangle is dropped entirely
      expect(spec.htmlSource).not.toContain('rgba(255, 0, 0, 1)');
      // the giant text box is clamped, not emitted raw
      expect(spec.htmlSource).toContain('width:100000px');
      expect(spec.htmlSource).toContain('font-size:16px');
    });

    it('bounds a pathological tree (depth + node count) instead of hanging', () => {
      // 200-deep chain of 3 children each would be astronomically large unbounded.
      const child = (depth: number): FigmaNode => ({
        type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        children: depth > 0 ? [child(depth - 1), child(depth - 1)] : [],
      });
      const html = figmaFrameToPageSpec({
        type: 'FRAME', name: 'F', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        children: [child(14)],
      }).htmlSource!;
      const divs = html.match(/<div /g) ?? [];
      expect(divs.length).toBeLessThanOrEqual(5_000);
      expect(divs.length).toBeGreaterThan(100);
    });

    it('the frame name is sanitized into the page title', () => {
      expect(figmaFrameToPageSpec({ ...frame, name: 'A\u0000B\nC' }).actionTitle).toBe('A B C');
      expect(figmaFrameToPageSpec({ ...frame, name: 'x'.repeat(5_000) }).actionTitle).toHaveLength(200);
      expect(figmaFrameToPageSpec({ ...frame, name: 42 as never }).actionTitle).toBe('Imported frame');
      expect(figmaFrameToPageSpec({ ...frame, name: '   ' }).actionTitle).toBe('Imported frame');
    });

    it('text content is truncated and control characters removed', () => {
      const html = textFrame({ characters: 'a\u0000b'.padEnd(20_000, 'z') });
      expect(html).not.toContain('\u0000');
      expect(html.length).toBeLessThan(8_000);
    });

    it('cssColor accepts hex/rgb only', () => {
      expect(cssColor('#fff')).toBe('#fff');
      expect(cssColor('#AABBCCDD')).toBe('#AABBCCDD');
      expect(cssColor('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)');
      expect(cssColor('red')).toBeNull();
      expect(cssColor('url(javascript:alert(1))')).toBeNull();
      expect(cssColor('rgb(1,2,3);background:url(x)')).toBeNull();
      expect(cssColor(123)).toBeNull();
      expect(cssColor('#'.padEnd(200, 'f'))).toBeNull();
    });

    it('a non-object bounding box or fills array does not throw', () => {
      const html = figmaFrameToPageSpec({
        type: 'FRAME', name: 'F', absoluteBoundingBox: 'nope' as never,
        fills: 'nope' as never,
        children: [
          { type: 'TEXT', characters: 'x', absoluteBoundingBox: null as never },
          { type: 'RECTANGLE', absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 }, fills: [null as never] },
        ],
      }).htmlSource!;
      expect(html).toContain('width:1440px;height:900px');
      expect(html).toContain('background:#ffffff');
    });

    it('every emitted style attribute contains only transcoded CSS', () => {
      const html = figmaFrameToPageSpec(frame).htmlSource!;
      const styles = [...html.matchAll(/style="([^"]*)"/g)].map(m => m[1]);
      expect(styles.length).toBeGreaterThan(2);
      for (const s of styles) {
        expect(s).toMatch(/^[A-Za-z0-9 \t\-_.,:;#%()/]*(&quot;[A-Za-z0-9 \-_]*&quot;)?[A-Za-z0-9 \t\-_.,:;#%()/]*$/);
      }
    });
  });

  describe('import_design tool', () => {
    let store: ArtifactStore;
    let artifact: CanvasArtifact;
    let ctx: CanvasToolContext;
    beforeEach(() => {
      store = new ArtifactStore({ getRoot: () => null });
      artifact = store.createArtifact({ name: 'App' });
      ctx = { artifact, store, executor: new CanvasOpExecutor(store, new CanvasJobRouter(() => {})), jobId: 'j', runId: 'r', approvalMode: 'auto' };
    });

    it('imports a figma frame as a new html page', () => {
      const r = dispatchCanvasTool('import_design', { source: 'figma', payload: { nodes: { '1:2': { document: frame } } } }, ctx);
      expect(r.ok).toBe(true);
      expect(artifact.pages).toHaveLength(1);
      // Transcoded markup is outside the JSX subset, so it lands verbatim as
      // `legacy` content rather than as a document (Plan 22 §3.1).
      expect(pageMode(artifact.pages[0])).toBe('html');
      expect(artifact.pages[0].source).toBe('figma');
      expect(pageHtml(artifact.pages[0])).toContain('Welcome back');
    });

    it('rejects an unsupported source', () => {
      const r = dispatchCanvasTool('import_design', { source: 'sketch', payload: {} }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('unsupported import source');
    });

    it('errors when no frame is found in the payload', () => {
      const r = dispatchCanvasTool('import_design', { source: 'figma', payload: { foo: 1 } }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('could not find a frame');
    });

    it('a hostile payload lands as inert markup, not script', () => {
      const hostile = {
        type: 'FRAME', name: 'Evil', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        children: [{
          type: 'TEXT', characters: '</div><img src=x onerror=alert(1)>',
          absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
          style: { fontFamily: '";}</style><script>alert(1)</script>' },
        }],
      };
      const r = dispatchCanvasTool('import_design', { source: 'figma', payload: hostile }, ctx);
      expect(r.ok).toBe(true);
      const html = pageHtml(artifact.pages[0])!;
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<script');
      // (the escaped text still reads 'onerror=' — it is inert text, not an attribute)
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
  });
});
