/**
 * CanvasThemePresets tests — the curated design-system presets and the
 * list_theme_presets / apply_theme_preset tools. Verifies each preset is a
 * complete, valid DesignTheme, dark presets are actually dark, and the tools
 * surface + apply them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { THEME_PRESETS, getThemePreset, listThemePresets } from '../../src/managers/CanvasThemePresets';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { dispatchCanvasTool } from '../../src/managers/CanvasToolDispatch';
import type { CanvasToolContext } from '../../src/managers/CanvasToolDispatch';
import type { CanvasArtifact } from '../../src/types';

const COLOR_ROLES = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'textSecondary', 'border', 'error', 'success'];

/** Rough perceived luminance (0..255) of a #rrggbb color. */
function luminance(hex: string): number {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

describe('CanvasThemePresets', () => {
  describe('the catalog', () => {
    it('every preset is a complete, valid DesignTheme', () => {
      for (const p of THEME_PRESETS) {
        for (const role of COLOR_ROLES) {
          expect(p.theme.colors[role], `${p.id}.${role}`).toMatch(/^#|rgb|hsl/);
        }
        expect(p.theme.typography.fontFamily).toBeTruthy();
        expect(p.theme.typography.scale.length).toBeGreaterThan(0);
        expect(p.theme.radii).toMatchObject({ sm: expect.any(Number), md: expect.any(Number), lg: expect.any(Number), full: expect.any(Number) });
        expect(p.theme.shadows).toMatchObject({ sm: expect.any(String), md: expect.any(String), lg: expect.any(String) });
      }
    });

    it('dark presets have a dark background, light presets a light one', () => {
      for (const p of THEME_PRESETS) {
        const lum = luminance(p.theme.colors.background);
        if (p.dark) { expect(lum, `${p.id} bg should be dark`).toBeLessThan(80); }
        else { expect(lum, `${p.id} bg should be light`).toBeGreaterThan(180); }
      }
    });

    it('dark presets keep readable contrast (light text on dark bg)', () => {
      for (const p of THEME_PRESETS.filter(p => p.dark)) {
        expect(luminance(p.theme.colors.text)).toBeGreaterThan(luminance(p.theme.colors.background) + 100);
      }
    });

    it('presets have distinct primary colors', () => {
      const primaries = THEME_PRESETS.map(p => p.theme.colors.primary.toLowerCase());
      expect(new Set(primaries).size).toBe(primaries.length);
    });

    it('getThemePreset / listThemePresets (swatch, no full theme)', () => {
      expect(getThemePreset('midnight')!.dark).toBe(true);
      expect(getThemePreset('nope')).toBeUndefined();
      const list = listThemePresets();
      expect(list.length).toBe(THEME_PRESETS.length);
      expect((list[0] as any).theme).toBeUndefined();
      expect(list[0].swatch.primary).toBeTruthy();
    });
  });

  describe('tools', () => {
    let store: ArtifactStore;
    let artifact: CanvasArtifact;
    let ctx: CanvasToolContext;

    beforeEach(() => {
      store = new ArtifactStore({ getRoot: () => null });
      const executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
      artifact = store.createArtifact({ name: 'App' });
      ctx = { artifact, store, executor, jobId: 'j', runId: 'r', approvalMode: 'auto' };
    });

    it('list_theme_presets returns the catalog with swatches', () => {
      const r = dispatchCanvasTool('list_theme_presets', {}, ctx);
      expect(r.ok).toBe(true);
      const ids = (r.data as any[]).map(p => p.id);
      expect(ids).toContain('midnight');
      expect((r.data as any[])[0].swatch).toBeTruthy();
    });

    it('apply_theme_preset sets the artifact theme', () => {
      const r = dispatchCanvasTool('apply_theme_preset', { preset: 'midnight' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.op!.status).toBe('applied');
      expect(artifact.theme.colors.background).toBe('#0B1020');
      expect(artifact.theme.colors.primary).toBe('#8B5CF6');
    });

    it('apply_theme_preset rejects an unknown preset', () => {
      const r = dispatchCanvasTool('apply_theme_preset', { preset: 'nope' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('unknown theme preset');
    });
  });
});
