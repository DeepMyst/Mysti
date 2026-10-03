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
 *
 * ## Plan 22 Phase 6 — the chips tell the truth
 *
 * The canvas chrome used to hardcode its fal/Stitch/Figma chips to `off`, so a
 * connected capability looked broken and a disconnected one looked available
 * until it failed mid-run. {@link CanvasCapabilityRegistry.chips} produces the
 * typed `CapChip[]` the `canvas/caps` protocol message carries, and
 * {@link CanvasCapabilityRegistry.refusal} produces the single refusal shape —
 * message plus `<<<MYSTI_CONNECT:slug>>>` marker — that every gated affordance
 * hands back when it is asked for while off. A disconnected capability is
 * therefore hidden as an affordance and *offered as a connect card* when
 * requested, instead of failing obscurely at the call site.
 */

import type { CapChip } from '../canvas/protocol';

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
  /** Short name for the top-bar chip; falls back to {@link label}. */
  chipLabel?: string;
  /**
   * The service slug the in-chat connect card is opened with — i.e. what goes
   * inside `<<<MYSTI_CONNECT:…>>>`.
   *
   * NOT the capability slug: the connect flow resolves a slug against the
   * user's DeepMyst connection names, and no connection is ever called
   * "canvas-image", so emitting the capability slug produced a card that could
   * never resolve and fell back to the generic hub. It is also not
   * {@link hubConnection}, whose value is a broker id (`neversight/stitch`).
   */
  connectSlug?: string;
}

/** Verified backend mapping (Plan 05 §9, research 2026-06-14). */
export const CAPABILITY_DEFS: readonly CapabilityDef[] = [
  { slug: 'canvas-image', label: 'Image generation', chipLabel: 'fal', hubConnection: 'fal_ai', localKey: 'openai', commands: ['generate', 'image'], connectSlug: 'fal' },
  { slug: 'canvas-video', label: 'Video generation', chipLabel: 'fal video', hubConnection: 'fal_ai', localKey: 'fal', commands: ['video'], connectSlug: 'fal' },
  { slug: 'canvas-media-edit', label: 'Media editing', chipLabel: 'fal edit', hubConnection: 'fal_ai', localKey: 'fal', commands: ['upscale', 'remove-bg', 'inpaint'], connectSlug: 'fal' },
  { slug: 'canvas-screens', label: 'Screen generation (Stitch)', chipLabel: 'Stitch', hubConnection: 'neversight/stitch', localKey: 'stitch', commands: ['screen', 'design'], connectSlug: 'stitch' },
  { slug: 'canvas-code', label: 'Component code export', chipLabel: 'Code', localAlways: true, commands: ['code'] },
  { slug: 'figma', label: 'Figma', chipLabel: 'Figma', hubConnection: 'figma', commands: ['figma'], connectSlug: 'figma' },
  { slug: 'canva', label: 'Canva', chipLabel: 'Canva', hubConnection: 'canva', commands: ['canva'], connectSlug: 'canva' },
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

/**
 * The chips the canvas top bar shows, in order. A deliberate subset: every
 * capability has a status, but a bar of seven chips is noise — `canvas-video`
 * and `canvas-media-edit` share fal's connection with `canvas-image`, and
 * `canvas-code` is always on.
 */
export const CANVAS_CHIP_SLUGS: readonly CanvasCapabilitySlug[] = ['canvas-image', 'canvas-screens', 'figma'];

/**
 * `hubConnection` → the needle the DeepMyst connection list is matched on.
 * Derived from {@link CAPABILITY_DEFS} so the caller that probes hub status
 * cannot hold a second, drifting copy of this table.
 */
export const HUB_NEEDLE_BY_CONNECTION: Readonly<Record<string, string>> = Object.freeze(
  CAPABILITY_DEFS.reduce<Record<string, string>>((acc, d) => {
    if (d.hubConnection && d.connectSlug) { acc[d.hubConnection] = d.connectSlug; }
    return acc;
  }, {}),
);

/** What a gated affordance hands back when its capability is off. */
export interface CapabilityRefusal {
  slug: CanvasCapabilitySlug;
  label: string;
  /** Service slug for the connect card, when there is a hub route at all. */
  connectSlug?: string;
  /** `<<<MYSTI_CONNECT:slug>>>`, when there is a hub route. */
  marker?: string;
  /** Human-readable reason. */
  error: string;
  /** `error` plus the marker — the exact text a tool result should carry. */
  text: string;
}

/**
 * The in-chat connect marker for a service slug. One definition, so a caller
 * cannot emit `<<<MYSTI_CONNECT:canvas-image>>>` — a marker whose slug matches
 * no DeepMyst connection and silently degrades to the generic hub.
 */
export function connectMarkerFor(connectSlug: string): string {
  return `<<<MYSTI_CONNECT:${connectSlug}>>>`;
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

  /** True when a verb's capability is on (an affordance may be shown at all). */
  isCommandAvailable(command: string): boolean {
    const slug = this.capabilityForCommand(command);
    return slug ? this.isEnabled(slug) : false;
  }

  /**
   * The typed chips for `canvas/caps` — real status, and for a disabled one the
   * slug the "Connect" affordance should open.
   *
   * `connectSlug` is present ONLY when the capability is both off and actually
   * connectable: offering "Connect" for `canvas-code` (which has no hub route)
   * would be a button that cannot do anything.
   */
  chips(slugs: readonly CanvasCapabilitySlug[] = CANVAS_CHIP_SLUGS): CapChip[] {
    return slugs.map(slug => {
      const def = DEF_BY_SLUG.get(slug)!;
      const status = this.resolve(slug);
      const chip: CapChip = { ...status, label: def.chipLabel ?? def.label };
      if (!status.enabled && def.connectSlug) { chip.connectSlug = def.connectSlug; }
      return chip;
    });
  }

  /**
   * Turn "this capability is off" into one refusal every transport can render:
   * a sentence for the user and a `<<<MYSTI_CONNECT:slug>>>` marker the chat
   * turns into a one-click connect card. Callers must not compose their own —
   * the obscure failures this replaces were each a bespoke string.
   */
  refusal(slug: CanvasCapabilitySlug, opts: { verb?: string } = {}): CapabilityRefusal {
    const def = DEF_BY_SLUG.get(slug)!;
    const what = opts.verb ?? def.label.toLowerCase();
    const connectSlug = def.connectSlug;
    const error = connectSlug
      ? `${what} is not connected. Connect ${connectSlug} via DeepMyst${def.localKey ? `, or add a local ${def.localKey} API key` : ''}.`
      : `${what} is not available.`;
    const marker = connectSlug ? connectMarkerFor(connectSlug) : undefined;
    return {
      slug,
      label: def.label,
      connectSlug,
      marker,
      error,
      text: marker ? `${error} ${marker}` : error,
    };
  }

  /** `null` when the capability is usable, a refusal when it is not. */
  require(slug: CanvasCapabilitySlug, opts: { verb?: string } = {}): CapabilityRefusal | null {
    return this.isEnabled(slug) ? null : this.refusal(slug, opts);
  }

  static getDef(slug: CanvasCapabilitySlug): CapabilityDef | undefined {
    return DEF_BY_SLUG.get(slug);
  }
}
