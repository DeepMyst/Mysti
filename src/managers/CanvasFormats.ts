/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CanvasFormatSpec } from '../types';

/**
 * Canvas format catalog (Plan 05 §4). Every format normalizes its **longer
 * edge to 1920 design px** so the `UI.*` primitives and prompt personas stay
 * tuned across aspect ratios (DeepMyst's `configurable_canvas_formats` convention).
 * Print formats additionally carry bleed + safe-margin in design px and draw
 * trim/safe guides (Phase 4). Each format contributes a prompt-persona paragraph
 * that steers the design sub-agent's layout for that aspect ratio.
 */

export const DEFAULT_FORMAT_ID = 'deck-16x9';

/** Longer-edge design-px target (DeepMyst convention). */
export const DESIGN_LONG_EDGE = 1920;

/**
 * Catalog. Dimensions are pre-normalized to a 1920 longer edge. Print bleed /
 * safe-margin are expressed in design px (derived from physical 3mm bleed and a
 * ~12.7mm / 0.5in safe margin at the format's design scale).
 */
export const CANVAS_FORMATS: readonly CanvasFormatSpec[] = [
  // Decks / social (design-normalized: longer edge = 1920).
  { formatId: 'deck-16x9', kind: 'screen', width: 1920, height: 1080 },
  { formatId: 'deck-4x3', kind: 'screen', width: 1920, height: 1440 },
  { formatId: 'square-1x1', kind: 'screen', width: 1920, height: 1920 },
  { formatId: 'portrait-4x5', kind: 'screen', width: 1536, height: 1920 },
  { formatId: 'story-9x16', kind: 'screen', width: 1080, height: 1920 },
  { formatId: 'landscape-1.91x1', kind: 'screen', width: 1920, height: 1005 },
  // App / web UI designs — REAL device CSS px (not 1920-normalized) so a screen
  // looks like an actual phone / tablet / desktop. Used by `screens` artifacts.
  { formatId: 'mobile', kind: 'screen', width: 390, height: 844 },
  { formatId: 'mobile-android', kind: 'screen', width: 360, height: 800 },
  { formatId: 'tablet', kind: 'screen', width: 768, height: 1024 },
  { formatId: 'desktop', kind: 'screen', width: 1440, height: 900 },
  { formatId: 'web', kind: 'screen', width: 1280, height: 800 },
  // Print (design-normalized + physical bleed/safe-margin).
  { formatId: 'a4-portrait', kind: 'print', width: 1358, height: 1920, dpi: 96, bleed: 19, safeMargin: 82 },
  { formatId: 'a4-landscape', kind: 'print', width: 1920, height: 1358, dpi: 96, bleed: 19, safeMargin: 82 },
  { formatId: 'us-letter', kind: 'print', width: 1484, height: 1920, dpi: 96, bleed: 22, safeMargin: 87 },
] as const;

/** App/web UI formats that render at real device px (exempt from 1920 normalization). */
export const DEVICE_FORMAT_IDS: ReadonlySet<string> = new Set([
  'mobile', 'mobile-android', 'tablet', 'desktop', 'web',
]);

export function isDeviceFormat(spec: CanvasFormatSpec): boolean {
  return DEVICE_FORMAT_IDS.has(spec.formatId);
}

/** Look up a catalog format by id. */
export function getFormat(formatId: string): CanvasFormatSpec | undefined {
  return CANVAS_FORMATS.find(f => f.formatId === formatId);
}

/** The default deck format (deep-cloned so callers can mutate freely). */
export function getDefaultFormat(): CanvasFormatSpec {
  return { ...getFormat(DEFAULT_FORMAT_ID)! };
}

/** Sensible default format for a new artifact of the given kind. */
export function getDefaultFormatForKind(kind: 'deck' | 'document' | 'screens' | 'board'): CanvasFormatSpec {
  switch (kind) {
    case 'screens': return { ...getFormat('desktop')! };   // app/web UI → desktop frame
    case 'document': return { ...getFormat('a4-portrait')! };
    default: return getDefaultFormat();                     // deck / board → 16:9
  }
}

export function listFormats(): CanvasFormatSpec[] {
  return CANVAS_FORMATS.map(f => ({ ...f }));
}

export function isPrint(spec: CanvasFormatSpec): boolean {
  return spec.kind === 'print';
}

/**
 * Scale arbitrary dimensions so the longer edge is `target` (default 1920),
 * preserving aspect ratio. Used to normalize `custom` formats into the same
 * design-px space as the catalog.
 */
export function normalizeLongerEdge(
  width: number,
  height: number,
  target = DESIGN_LONG_EDGE,
): { width: number; height: number } {
  const longer = Math.max(width, height);
  if (longer <= 0) { return { width: target, height: target }; }
  const scale = target / longer;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Build a normalized `custom` format from raw dimensions. */
export function makeCustomFormat(width: number, height: number): CanvasFormatSpec {
  const norm = normalizeLongerEdge(width, height);
  return { formatId: 'custom', kind: 'screen', width: norm.width, height: norm.height };
}

/**
 * Resolve a format request to a concrete spec: a catalog id, or `custom` with
 * explicit dimensions. Returns the default when nothing matches.
 */
export function resolveFormat(req: { formatId?: string; width?: number; height?: number }): CanvasFormatSpec {
  if (req.formatId === 'custom' && req.width && req.height) {
    return makeCustomFormat(req.width, req.height);
  }
  if (req.formatId) {
    const found = getFormat(req.formatId);
    if (found) { return { ...found }; }
  }
  return getDefaultFormat();
}

/** Named anchor points (in design px) for placing content within a format. */
export interface FormatAnchors {
  width: number;
  height: number;
  center: { x: number; y: number };
  /** Rule-of-thirds intersection points. */
  thirds: Array<{ x: number; y: number }>;
  /** Content-safe rectangle (inset by safeMargin for print, else 0). */
  safeRect: { x: number; y: number; width: number; height: number };
}

/** Compute anchor geometry for a format (used by the `page_coordinates` tool). */
export function computeAnchors(spec: CanvasFormatSpec): FormatAnchors {
  const m = spec.safeMargin ?? 0;
  const thirdsX = [spec.width / 3, (spec.width * 2) / 3];
  const thirdsY = [spec.height / 3, (spec.height * 2) / 3];
  return {
    width: spec.width,
    height: spec.height,
    center: { x: Math.round(spec.width / 2), y: Math.round(spec.height / 2) },
    thirds: thirdsX.flatMap(x => thirdsY.map(y => ({ x: Math.round(x), y: Math.round(y) }))),
    safeRect: {
      x: m,
      y: m,
      width: Math.max(0, spec.width - 2 * m),
      height: Math.max(0, spec.height - 2 * m),
    },
  };
}

/**
 * A prompt-persona paragraph for the design sub-agent, steering layout to the
 * format's aspect ratio (Plan 05 §4 / §10).
 */
export function buildFormatPersona(spec: CanvasFormatSpec): string {
  const ar = spec.width / spec.height;
  const dims = `${spec.width}×${spec.height} design px`;
  if (isDeviceFormat(spec)) {
    return buildDevicePersona(spec, dims);
  }
  if (spec.kind === 'print') {
    return (
      `Format: ${spec.formatId} (${dims}, PRINT). Design for paper: generous margins, ` +
      `keep all text and key elements inside the safe area (inset ${spec.safeMargin}px); ` +
      `extend backgrounds to the bleed edge (${spec.bleed}px); no animation, no hover states, ` +
      `print-legible type sizes and high contrast.`
    );
  }
  if (ar > 1.6) {
    return (
      `Format: ${spec.formatId} (${dims}, wide landscape). Favor horizontal composition: ` +
      `multi-column layouts, a dominant left/right focal split, charts that breathe across the width. ` +
      `Anchor a clear title zone; avoid tall stacked content.`
    );
  }
  if (ar < 0.7) {
    return (
      `Format: ${spec.formatId} (${dims}, tall portrait/story). Stack vertically — one idea per ` +
      `vertical band, large focal element top, supporting content below; NO 3-column layouts; ` +
      `thumb-reachable spacing for mobile.`
    );
  }
  if (Math.abs(ar - 1) < 0.1) {
    return (
      `Format: ${spec.formatId} (${dims}, square). Center a single focal block with balanced ` +
      `negative space on all sides; one headline + one supporting element; social-feed legible.`
    );
  }
  return (
    `Format: ${spec.formatId} (${dims}). Balanced composition with a clear visual hierarchy, ` +
    `intentional whitespace, and a single dominant focal point per page.`
  );
}

/**
 * App/web UI persona — this page is a real screen at device px, not a slide.
 * Steers the agent to native UI patterns for the target device.
 */
function buildDevicePersona(spec: CanvasFormatSpec, dims: string): string {
  switch (spec.formatId) {
    case 'mobile':
    case 'mobile-android':
      return (
        `Format: ${spec.formatId} (${dims}, MOBILE APP SCREEN). Design a real phone UI: a single ` +
        `column, generous touch targets (≥44px), a top status/app bar and a bottom tab/nav bar, ` +
        `primary actions in the thumb zone, system safe-area insets respected. No desktop multi-column ` +
        `layouts, no hover-only affordances.`
      );
    case 'tablet':
      return (
        `Format: ${spec.formatId} (${dims}, TABLET SCREEN). Adaptive layout: a master/detail or ` +
        `two-pane split where it helps, larger type and spacing than mobile, touch-first targets.`
      );
    case 'desktop':
      return (
        `Format: ${spec.formatId} (${dims}, DESKTOP APP). Use an app shell — a left sidebar/nav and a ` +
        `top bar, a dense but organized content area (dashboards, tables, multi-pane), clear information ` +
        `hierarchy; hover/focus states are fine.`
      );
    case 'web':
    default:
      return (
        `Format: ${spec.formatId} (${dims}, WEB PAGE). A marketing/landing layout: a strong hero, ` +
        `sectioned vertical scroll, clear CTAs, responsive section composition; the height is a fold ` +
        `guide — content may scroll beyond it.`
      );
  }
}
