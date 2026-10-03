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

import { DesignSpecManager } from './DesignSpecManager';
import type { DesignTheme } from '../types';

/**
 * Curated design-system presets for app/website design (Plan 05). Each is a
 * complete {@link DesignTheme} — colors (the named roles the `UI.*` primitives
 * read as `--theme-color-*`), typography, spacing, radii, shadows. Applying one
 * restyles every screen coherently. Surfaced via `list_theme_presets` /
 * `apply_theme_preset` and selectable in the inspector.
 */

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  dark: boolean;
  theme: DesignTheme;
}

type Colors = DesignTheme['colors'];

function makeTheme(opts: {
  colors: Colors;
  headingFamily?: string;
  fontFamily?: string;
  radii?: DesignTheme['radii'];
  shadows?: DesignTheme['shadows'];
}): DesignTheme {
  const base = DesignSpecManager.getDefaultTheme();
  return {
    colors: opts.colors,
    typography: {
      ...base.typography,
      fontFamily: opts.fontFamily ?? base.typography.fontFamily,
      headingFamily: opts.headingFamily,
    },
    spacing: base.spacing,
    radii: opts.radii ?? base.radii,
    shadows: opts.shadows ?? base.shadows,
  };
}

const SANS = 'Inter, system-ui, -apple-system, sans-serif';
const SERIF = '"Source Serif 4", Georgia, serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const ROUNDED = '"Nunito", system-ui, sans-serif';

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'clean-saas',
    name: 'Clean SaaS',
    description: 'Crisp light product UI — blue primary on neutral grays. The safe default for most apps.',
    dark: false,
    theme: makeTheme({
      colors: {
        primary: '#2563EB', secondary: '#4F46E5', accent: '#06B6D4',
        background: '#FFFFFF', surface: '#F8FAFC', text: '#0F172A', textSecondary: '#64748B',
        border: '#E2E8F0', error: '#EF4444', success: '#10B981',
      },
    }),
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Dark dashboard — deep slate surfaces, violet accent, high-contrast text. Great for analytics.',
    dark: true,
    theme: makeTheme({
      colors: {
        primary: '#8B5CF6', secondary: '#6366F1', accent: '#22D3EE',
        background: '#0B1020', surface: '#151B2E', text: '#E6EAF2', textSecondary: '#94A3B8',
        border: '#26304A', error: '#F87171', success: '#34D399',
      },
      shadows: { sm: '0 1px 2px rgba(0,0,0,0.4)', md: '0 6px 16px rgba(0,0,0,0.5)', lg: '0 16px 40px rgba(0,0,0,0.6)' },
    }),
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Refined content/marketing — serif headings, warm neutrals, generous whitespace.',
    dark: false,
    theme: makeTheme({
      headingFamily: SERIF,
      fontFamily: SANS,
      colors: {
        primary: '#1F2937', secondary: '#92400E', accent: '#B45309',
        background: '#FBFAF7', surface: '#FFFFFF', text: '#1C1917', textSecondary: '#78716C',
        border: '#E7E5E4', error: '#DC2626', success: '#15803D',
      },
      radii: { sm: 2, md: 4, lg: 8, full: 9999 },
    }),
  },
  {
    id: 'playful',
    name: 'Playful',
    description: 'Friendly consumer app — rounded corners, bright magenta primary, soft shadows.',
    dark: false,
    theme: makeTheme({
      fontFamily: ROUNDED,
      colors: {
        primary: '#EC4899', secondary: '#8B5CF6', accent: '#F59E0B',
        background: '#FFFFFF', surface: '#FDF2F8', text: '#1F2937', textSecondary: '#6B7280',
        border: '#FBCFE8', error: '#EF4444', success: '#10B981',
      },
      radii: { sm: 8, md: 14, lg: 24, full: 9999 },
      shadows: { sm: '0 2px 6px rgba(236,72,153,0.12)', md: '0 8px 20px rgba(236,72,153,0.16)', lg: '0 20px 48px rgba(236,72,153,0.2)' },
    }),
  },
  {
    id: 'minimal-mono',
    name: 'Minimal Mono',
    description: 'Sharp black-and-white with a mono accent — for tools, dev products, and brutalist UI.',
    dark: false,
    theme: makeTheme({
      fontFamily: MONO,
      colors: {
        primary: '#111111', secondary: '#374151', accent: '#2563EB',
        background: '#FFFFFF', surface: '#FAFAFA', text: '#111111', textSecondary: '#6B7280',
        border: '#111111', error: '#DC2626', success: '#16A34A',
      },
      radii: { sm: 0, md: 2, lg: 4, full: 9999 },
      shadows: { sm: 'none', md: '2px 2px 0 #111111', lg: '4px 4px 0 #111111' },
    }),
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Calm, natural — green primary on warm off-white. Good for wellness and finance.',
    dark: false,
    theme: makeTheme({
      colors: {
        primary: '#15803D', secondary: '#0F766E', accent: '#CA8A04',
        background: '#FBFDF9', surface: '#F1F7EE', text: '#14271B', textSecondary: '#5B6B5F',
        border: '#D8E5D2', error: '#DC2626', success: '#16A34A',
      },
    }),
  },
] as const;

const BY_ID = new Map(THEME_PRESETS.map(p => [p.id, p]));

export function getThemePreset(id: string): ThemePreset | undefined {
  return BY_ID.get(id);
}

/** List presets with a small swatch (excludes the full theme to save tokens). */
export function listThemePresets(): Array<{ id: string; name: string; description: string; dark: boolean; swatch: { primary: string; background: string; surface: string } }> {
  return THEME_PRESETS.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    dark: p.dark,
    swatch: { primary: p.theme.colors.primary, background: p.theme.colors.background, surface: p.theme.colors.surface },
  }));
}
