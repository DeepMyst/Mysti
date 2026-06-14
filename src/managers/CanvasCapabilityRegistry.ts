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

/**
 * Resolves which canvas generation/source capabilities are available and how
 * they are reached (Plan 05 §9 / Phase 6.1). Each capability is a slug whose
 * candidate backends, in preference order, are:
 *
 *   1. **DeepMyst hub** — a Composio/Smithery connection enabled in the hub and
 *      reached through the broker already in every CLI's config.
 *   2. **Local** — a BYO-key service (or, for `canvas-code`, the CLI provider).
 *   3. **Off** — neither available; the tool/command is hidden and asking for it
 *      surfaces a `<<<MYSTI_CONNECT:slug>>>` connect card.
 *
 * Status is computed from three injected inputs so the registry is pure and
 * unit-testable: hub-connection status, local-key presence, and the per-slug
 * `mysti.canvas.capabilities.*` setting. The verified backend mapping (research
 * 2026-06-14) is encoded in {@link CAPABILITY_DEFS}.
 */

export type CanvasCapabilitySlug =
  | 'canvas-image'
  | 'canvas-video'
  | 'canvas-media-edit'
  | 'canvas-screens'
  | 'canvas-code'
  | 'figma'
  | 'canva';

export type CapabilitySource = 'deepmyst' | 'local' | 'off';

/** Per-slug user override (`mysti.canvas.capabilities.<slug>`). */
export type CapabilityPreference = 'auto' | 'deepmyst' | 'local' | 'off';

export interface CapabilityDef {
  slug: CanvasCapabilitySlug;
  label: string;
  /** DeepMyst hub connection slug (Composio/Smithery), if brokerable. */
  hubConnection?: string;
  /** CanvasSecrets key name for the local BYO-key backend, if any. */
  localKey?: string;
  /**
   * True when the capability is intrinsically local with no key (the CLI
   * provider) — always considered available in `local` source.
   */
  localAlways?: boolean;
  /** Prompt/affordance verbs gated by this capability. */
  commands: string[];
}

/** Verified backend mapping (Plan 05 §9, research 2026-06-14). */
export const CAPABILITY_DEFS: readonly CapabilityDef[] = [
  { slug: 'canvas-image', label: 'Image generation', hubConnection: 'fal_ai', localKey: 'openai', commands: ['generate', 'image'] },
  { slug: 'canvas-video', label: 'Video generation', hubConnection: 'fal_ai', localKey: 'fal', commands: ['video'] },
  { slug: 'canvas-media-edit', label: 'Media editing', hubConnection: 'fal_ai', localKey: 'fal', commands: ['upscale', 'remove-bg', 'inpaint'] },
  { slug: 'canvas-screens', label: 'Screen generation (Stitch)', hubConnection: 'neversight/stitch', localKey: 'stitch', commands: ['screen', 'design'] },
  { slug: 'canvas-code', label: 'Component code export', localAlways: true, commands: ['code'] },
  { slug: 'figma', label: 'Figma', hubConnection: 'figma', commands: ['figma'] },
  { slug: 'canva', label: 'Canva', hubConnection: 'canva', commands: ['canva'] },
] as const;

export interface CapabilityStatus {
  slug: CanvasCapabilitySlug;
  label: string;
  enabled: boolean;
  source: CapabilitySource;
}

/** Injected status inputs (decoupled from DeepMystAuthManager / CanvasSecrets / settings). */
export interface CapabilityInputs {
  /** True when the named hub connection is active in the DeepMyst Connections hub. */
  isHubConnected(connectionSlug: string): boolean;
  /** True when a local BYO key exists in CanvasSecrets for the given key name. */
  hasLocalKey(keyName: string): boolean;
  /** The `mysti.canvas.capabilities.<slug>` setting (default 'auto'). */
  getPreference(slug: CanvasCapabilitySlug): CapabilityPreference;
}

const DEF_BY_SLUG = new Map(CAPABILITY_DEFS.map(d => [d.slug, d]));

export class CanvasCapabilityRegistry {
  private _inputs: CapabilityInputs;

  constructor(inputs: CapabilityInputs) {
    this._inputs = inputs;
  }

  /** Resolve a capability's status given the current inputs. */
  resolve(slug: CanvasCapabilitySlug): CapabilityStatus {
    const def = DEF_BY_SLUG.get(slug)!;
    const pref = this._inputs.getPreference(slug);
    const off: CapabilityStatus = { slug, label: def.label, enabled: false, source: 'off' };
    if (pref === 'off') { return off; }

    const hubOk = !!def.hubConnection && this._inputs.isHubConnected(def.hubConnection);
    const localOk = def.localAlways === true || (!!def.localKey && this._inputs.hasLocalKey(def.localKey));

    const asDeepmyst: CapabilityStatus = { slug, label: def.label, enabled: true, source: 'deepmyst' };
    const asLocal: CapabilityStatus = { slug, label: def.label, enabled: true, source: 'local' };

    switch (pref) {
      case 'deepmyst':
        return hubOk ? asDeepmyst : off;
      case 'local':
        return localOk ? asLocal : off;
      case 'auto':
      default:
        if (hubOk) { return asDeepmyst; }
        if (localOk) { return asLocal; }
        return off;
    }
  }

  /** Resolve every capability's status. */
  all(): CapabilityStatus[] {
    return CAPABILITY_DEFS.map(d => this.resolve(d.slug));
  }

  isEnabled(slug: CanvasCapabilitySlug): boolean {
    return this.resolve(slug).enabled;
  }

  /** Slugs that are currently off (candidates for a "connect" prompt). */
  disabledSlugs(): CanvasCapabilitySlug[] {
    return this.all().filter(s => !s.enabled).map(s => s.slug);
  }

  /** Prompt/affordance verbs available given the enabled capabilities. */
  availableCommands(): string[] {
    const out: string[] = [];
    for (const d of CAPABILITY_DEFS) {
      if (this.isEnabled(d.slug)) { out.push(...d.commands); }
    }
    return out;
  }

  /** The capability whose verb matches a command, if any (for gating). */
  capabilityForCommand(command: string): CanvasCapabilitySlug | undefined {
    return CAPABILITY_DEFS.find(d => d.commands.includes(command))?.slug;
  }

  static getDef(slug: CanvasCapabilitySlug): CapabilityDef | undefined {
    return DEF_BY_SLUG.get(slug);
  }
}
