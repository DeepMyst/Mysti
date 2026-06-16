/**
 * FigmaImport tests — converting a Figma frame node into an html page
 * (positions relative to the frame, fills, text styles), wrapper-shape
 * detection, and the import_design tool path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  figmaColorToCss,
  fillToCss,
  findFigmaFrame,
  figmaFrameToPageSpec,
  importFigmaPayload,
} from '../../src/managers/FigmaImport';
import type { FigmaNode } from '../../src/managers/FigmaImport';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool } from '../../src/managers/CanvasToolDispatch';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

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
      expect(artifact.pages[0].mode).toBe('html');
      expect(artifact.pages[0].source).toBe('figma');
      expect(artifact.pages[0].htmlSource).toContain('Welcome back');
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
  });
});
