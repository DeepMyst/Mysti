/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 row 1 — the board's arithmetic.
 *
 * This is the half of a pan/zoom canvas that goes wrong invisibly: a zoom that
 * drifts under the cursor, a fit that divides by a collapsed viewport, a
 * marquee rect inverted when you drag up-left, a `NaN` pan that blanks the
 * board with no error anywhere. None of that is observable in a DOM test, all
 * of it is observable here, which is why `boardMath.ts` is pure.
 */
import { describe, it, expect } from 'vitest';
import {
  FIT_MAX_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_PRESETS,
  centerOn, clampZoom, contentBounds, elementScreenRect, finiteOr, fitTransform,
  identityTransform, inflateRect, isVisible, normalizeTransform, normalizedRect,
  panBy, pointInRect, rectContains, rectToScreen, rectToWorld, rectsIntersect,
  screenToWorld, viewportWorldRect, wheelIntent, worldToScreen, zoomAbout, zoomBy,
  zoomPresetStep,
  type BoardTransform, type Rect,
} from '../../src/webview/canvas/boardMath';

const T = (zoom: number, x: number, y: number): BoardTransform => ({ zoom, pan: { x, y } });

describe('world <-> screen', () => {
  it('round-trips through any transform', () => {
    for (const t of [identityTransform(), T(0.25, -300, 120), T(3.5, 40, -900)]) {
      const p = { x: 137.5, y: -42.25 };
      const back = screenToWorld(worldToScreen(p, t), t);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('scales sizes but not just positions', () => {
    const screen = rectToScreen({ x: 10, y: 20, w: 100, h: 50 }, T(2, 5, 5));
    expect(screen).toEqual({ x: 25, y: 45, w: 200, h: 100 });
    const world = rectToWorld(screen, T(2, 5, 5));
    expect(world).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it('composes an element rect with its artboard position (the overlay line)', () => {
    // The frame reports page coordinates; the artboard sits at boardPos.
    const rect = elementScreenRect({ x: 24, y: 80, w: 200, h: 40 }, { x: 1600, y: 0 }, T(0.5, 100, 10));
    expect(rect).toEqual({ x: 100 + (1600 + 24) * 0.5, y: 10 + 80 * 0.5, w: 100, h: 20 });
  });

  it('treats a missing boardPos or rect as the origin instead of producing NaN', () => {
    const rect = elementScreenRect(
      { x: NaN, y: 0, w: 10, h: 10 },
      { x: undefined as unknown as number, y: 0 },
      identityTransform(),
    );
    expect(Number.isFinite(rect.x)).toBe(true);
    expect(Number.isFinite(rect.y)).toBe(true);
  });
});

describe('numerics fail safe', () => {
  it('finiteOr rejects NaN, Infinity and non-numbers', () => {
    expect(finiteOr(5, 0)).toBe(5);
    expect(finiteOr(NaN, 7)).toBe(7);
    expect(finiteOr(Infinity, 7)).toBe(7);
    expect(finiteOr('12' as unknown, 7)).toBe(7);
    expect(finiteOr(undefined, 7)).toBe(7);
  });

  it('clamps zoom into a renderable band', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-4)).toBe(MIN_ZOOM);
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
  });

  it('never lets a poisoned transform reach the CSS', () => {
    const t = normalizeTransform({ zoom: NaN, pan: { x: Infinity, y: NaN } });
    expect(t).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
    const p = worldToScreen({ x: 10, y: 10 }, { zoom: 0, pan: { x: NaN, y: 0 } });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('cannot divide by a zero zoom', () => {
    const w = screenToWorld({ x: 100, y: 100 }, T(0, 0, 0));
    expect(Number.isFinite(w.x)).toBe(true);
    expect(w.x).toBeCloseTo(100 / MIN_ZOOM, 6);
  });
});

describe('zoomAbout keeps the anchor pinned', () => {
  it('holds the world point under the cursor across a zoom', () => {
    const before = T(1, 0, 0);
    const anchor = { x: 640, y: 360 };
    const worldBefore = screenToWorld(anchor, before);
    for (const zoom of [0.4, 2.3, 7]) {
      const after = zoomAbout(before, zoom, anchor);
      const worldAfter = screenToWorld(anchor, after);
      expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
      expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
    }
  });

  it('still pins the anchor when the requested zoom is clamped', () => {
    const before = T(4, -120, 60);
    const anchor = { x: 300, y: 200 };
    const worldBefore = screenToWorld(anchor, before);
    const after = zoomAbout(before, 1e6, anchor);
    expect(after.zoom).toBe(MAX_ZOOM);
    expect(screenToWorld(anchor, after).x).toBeCloseTo(worldBefore.x, 6);
  });

  it('zoomBy multiplies and panBy translates in screen px', () => {
    expect(zoomBy(T(1, 0, 0), 2, { x: 0, y: 0 }).zoom).toBe(2);
    expect(panBy(T(2, 10, 10), 5, -5).pan).toEqual({ x: 15, y: 5 });
    expect(panBy(T(2, 10, 10), NaN, 0).pan).toEqual({ x: 10, y: 10 });
  });
});

describe('zoom presets step monotonically', () => {
  it('moves off an exact preset instead of stalling on it', () => {
    expect(zoomPresetStep(1, 1)).toBe(1.5);
    expect(zoomPresetStep(1, -1)).toBe(0.75);
    expect(zoomPresetStep(0.8, 1)).toBe(1);
    expect(zoomPresetStep(0.8, -1)).toBe(0.75);
  });

  it('keeps moving past the ends of the preset list', () => {
    const top = ZOOM_PRESETS[ZOOM_PRESETS.length - 1];
    expect(zoomPresetStep(top, 1)).toBeGreaterThan(top);
    expect(zoomPresetStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(zoomPresetStep(ZOOM_PRESETS[0], -1)).toBeLessThan(ZOOM_PRESETS[0]);
    expect(zoomPresetStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe('rect algebra', () => {
  it('normalizes a drag in every direction', () => {
    const expected = { x: 10, y: 20, w: 90, h: 80 };
    expect(normalizedRect({ x: 10, y: 20 }, { x: 100, y: 100 })).toEqual(expected);
    expect(normalizedRect({ x: 100, y: 100 }, { x: 10, y: 20 })).toEqual(expected);
    expect(normalizedRect({ x: 100, y: 20 }, { x: 10, y: 100 })).toEqual(expected);
    expect(normalizedRect({ x: 10, y: 100 }, { x: 100, y: 20 })).toEqual(expected);
  });

  it('does not count a flush edge as an intersection', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: 9.9, y: 0, w: 10, h: 10 })).toBe(true);
  });

  it('containment is inclusive of the boundary', () => {
    const outer = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectContains(outer, { x: 0, y: 0, w: 100, h: 100 })).toBe(true);
    expect(rectContains(outer, { x: 0, y: 0, w: 100.1, h: 100 })).toBe(false);
    expect(pointInRect({ x: 100, y: 100 }, outer)).toBe(true);
    expect(pointInRect({ x: 101, y: 0 }, outer)).toBe(false);
  });

  it('inflate never produces a negative extent', () => {
    expect(inflateRect({ x: 0, y: 0, w: 4, h: 4 }, -10)).toEqual({ x: 10, y: 10, w: 0, h: 0 });
  });

  it('unions content and ignores unusable entries', () => {
    expect(contentBounds([])).toBeNull();
    expect(contentBounds([{ x: NaN, y: 0, w: 1, h: 1 }])).toBeNull();
    expect(contentBounds([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 200, y: -30, w: 100, h: 50 },
    ])).toEqual({ x: 0, y: -30, w: 300, h: 80 });
    // A negative extent contributes its origin, never a reversed box.
    expect(contentBounds([{ x: 10, y: 10, w: -50, h: -50 }])).toEqual({ x: 10, y: 10, w: 0, h: 0 });
  });
});

describe('viewport visibility', () => {
  it('reports the world slice on screen', () => {
    expect(viewportWorldRect({ width: 800, height: 600 }, T(2, -100, -50)))
      .toEqual({ x: 50, y: 25, w: 400, h: 300 });
  });

  it('keeps the pre-mount margin constant in SCREEN px, not world px', () => {
    const viewport = { width: 1000, height: 800 };
    const justOffscreen: Rect = { x: 1000 + 2000, y: 0, w: 100, h: 100 };
    // At 0.1x, 256 screen px is 2560 world px - the artboard is inside the ring.
    expect(isVisible(justOffscreen, viewport, T(0.1, 0, 0), 256)).toBe(true);
    // The same artboard at 1x is far outside a 256px ring.
    expect(isVisible({ x: 1500, y: 0, w: 100, h: 100 }, viewport, T(1, 0, 0), 256)).toBe(false);
    expect(isVisible({ x: 100, y: 100, w: 100, h: 100 }, viewport, T(1, 0, 0), 0)).toBe(true);
  });
});

describe('fit-to-content', () => {
  const viewport = { width: 1200, height: 800 };

  it('frames content inside the viewport with padding', () => {
    const content = { x: -400, y: 0, w: 6000, h: 2000 };
    const t = fitTransform(content, viewport, { padding: 48 });
    const onScreen = rectToScreen(content, t);
    expect(onScreen.w).toBeLessThanOrEqual(viewport.width - 96 + 0.001);
    expect(onScreen.h).toBeLessThanOrEqual(viewport.height - 96 + 0.001);
    // ...and centred: equal slack on both sides.
    expect(onScreen.x).toBeCloseTo(viewport.width - (onScreen.x + onScreen.w), 6);
    expect(onScreen.y).toBeCloseTo(viewport.height - (onScreen.y + onScreen.h), 6);
  });

  it('never magnifies a small design past 1x', () => {
    const t = fitTransform({ x: 0, y: 0, w: 100, h: 100 }, viewport);
    expect(t.zoom).toBe(FIT_MAX_ZOOM);
  });

  it('has a defined answer for every degenerate input', () => {
    expect(fitTransform(null, viewport)).toEqual(identityTransform());
    expect(fitTransform({ x: 0, y: 0, w: 500, h: 500 }, { width: 0, height: 0 })).toEqual(identityTransform());
    const zero = fitTransform({ x: 0, y: 0, w: 0, h: 0 }, viewport);
    expect(Number.isFinite(zero.zoom) && Number.isFinite(zero.pan.x)).toBe(true);
    const nan = fitTransform({ x: NaN, y: NaN, w: NaN, h: NaN }, viewport);
    expect(Number.isFinite(nan.zoom) && Number.isFinite(nan.pan.x) && Number.isFinite(nan.pan.y)).toBe(true);
  });

  it('honours a padding larger than the viewport without inverting', () => {
    const t = fitTransform({ x: 0, y: 0, w: 500, h: 500 }, { width: 100, height: 100 }, { padding: 5000 });
    expect(t.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(t.zoom).toBeLessThanOrEqual(FIT_MAX_ZOOM);
  });

  it('centers an artboard without touching zoom', () => {
    const t = centerOn({ x: 0, y: 0, w: 1440, h: 1024 }, { width: 1200, height: 800 }, T(0.5, 0, 0));
    expect(t.zoom).toBe(0.5);
    expect(t.pan.x).toBeCloseTo(600 - 720 * 0.5, 6);
  });
});

describe('wheel semantics', () => {
  it('pans on a bare wheel, opposite the scroll direction', () => {
    expect(wheelIntent({ deltaX: 30, deltaY: -20 })).toEqual({ kind: 'pan', dx: -30, dy: 20 });
  });

  it('zooms on ctrl (which is how a trackpad pinch arrives) and on cmd', () => {
    const zoomIn = wheelIntent({ deltaY: -100, ctrlKey: true });
    expect(zoomIn.kind).toBe('zoom');
    if (zoomIn.kind === 'zoom') { expect(zoomIn.factor).toBeGreaterThan(1); }
    const zoomOut = wheelIntent({ deltaY: 100, metaKey: true });
    if (zoomOut.kind === 'zoom') { expect(zoomOut.factor).toBeLessThan(1); }
  });

  it('normalizes deltaMode so a Windows mouse notch is not a 3px pan', () => {
    expect(wheelIntent({ deltaY: 3, deltaMode: 1 })).toEqual({ kind: 'pan', dx: -0, dy: -48 });
    expect(wheelIntent({ deltaY: 1, deltaMode: 2 })).toEqual({ kind: 'pan', dx: -0, dy: -400 });
  });

  it('clamps an absurd pinch delta to a sane per-event factor', () => {
    const huge = wheelIntent({ deltaY: -100000, ctrlKey: true });
    if (huge.kind === 'zoom') { expect(huge.factor).toBeLessThanOrEqual(2); }
    const negative = wheelIntent({ deltaY: 100000, ctrlKey: true });
    if (negative.kind === 'zoom') { expect(negative.factor).toBeGreaterThanOrEqual(0.5); }
  });

  it('survives an event with nothing on it', () => {
    expect(wheelIntent({})).toEqual({ kind: 'pan', dx: -0, dy: -0 });
    expect(wheelIntent({ deltaY: NaN, deltaX: NaN })).toEqual({ kind: 'pan', dx: -0, dy: -0 });
  });
});
