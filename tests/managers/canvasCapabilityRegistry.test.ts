/**
 * CanvasCapabilityRegistry tests — resolving each capability's {enabled, source}
 * from injected hub-connection / local-key / preference inputs, per the verified
 * 2026-06-14 backend mapping (fal/Figma/Canva = Composio, Stitch = Smithery).
 */
import { describe, it, expect } from 'vitest';
import {
  CanvasCapabilityRegistry,
  CAPABILITY_DEFS,
  CANVAS_CHIP_SLUGS,
  HUB_NEEDLE_BY_CONNECTION,
  connectMarkerFor,
} from '../../src/managers/CanvasCapabilityRegistry';
import type {
  CapabilityInputs,
  CanvasCapabilitySlug,
  CapabilityPreference,
} from '../../src/managers/CanvasCapabilityRegistry';

function makeInputs(over: Partial<{
  hubConnected: string[];
  localKeys: string[];
  prefs: Partial<Record<CanvasCapabilitySlug, CapabilityPreference>>;
}> = {}): CapabilityInputs {
  const hub = new Set(over.hubConnected ?? []);
  const keys = new Set(over.localKeys ?? []);
  const prefs = over.prefs ?? {};
  return {
    isHubConnected: (slug) => hub.has(slug),
    hasLocalKey: (name) => keys.has(name),
    getPreference: (slug) => prefs[slug] ?? 'auto',
  };
}

describe('CanvasCapabilityRegistry', () => {
  it('encodes the verified backend mapping', () => {
    const bySlug = Object.fromEntries(CAPABILITY_DEFS.map(d => [d.slug, d]));
    expect(bySlug['canvas-image'].hubConnection).toBe('fal_ai');
    expect(bySlug['canvas-video'].hubConnection).toBe('fal_ai');
    expect(bySlug['canvas-media-edit'].hubConnection).toBe('fal_ai');
    expect(bySlug['canvas-screens'].hubConnection).toBe('neversight/stitch');
    expect(bySlug['figma'].hubConnection).toBe('figma');
    expect(bySlug['canva'].hubConnection).toBe('canva');
    expect(bySlug['canvas-code'].localAlways).toBe(true);
  });

  describe('auto resolution (prefers hub, then local, then off)', () => {
    it('uses the hub when the connection is active', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['fal_ai'] }));
      expect(reg.resolve('canvas-image')).toMatchObject({ enabled: true, source: 'deepmyst' });
    });
    it('falls back to a local key when the hub is not connected', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs({ localKeys: ['openai'] }));
      expect(reg.resolve('canvas-image')).toMatchObject({ enabled: true, source: 'local' });
    });
    it('is off when neither is available', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs());
      expect(reg.resolve('canvas-image')).toMatchObject({ enabled: false, source: 'off' });
    });
    it('canvas-code (localAlways) is always enabled as local', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs());
      expect(reg.resolve('canvas-code')).toMatchObject({ enabled: true, source: 'local' });
    });
  });

  describe('explicit preferences', () => {
    it("'off' forces off even when available", () => {
      const reg = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['fal_ai'], prefs: { 'canvas-image': 'off' } }));
      expect(reg.resolve('canvas-image').enabled).toBe(false);
    });
    it("'deepmyst' requires the hub (off if not connected)", () => {
      const reg = new CanvasCapabilityRegistry(makeInputs({ localKeys: ['openai'], prefs: { 'canvas-image': 'deepmyst' } }));
      expect(reg.resolve('canvas-image').source).toBe('off');
    });
    it("'local' requires a key (off if absent), ignores the hub", () => {
      const reg = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['fal_ai'], prefs: { 'canvas-image': 'local' } }));
      expect(reg.resolve('canvas-image').source).toBe('off');
      const reg2 = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['fal_ai'], localKeys: ['openai'], prefs: { 'canvas-image': 'local' } }));
      expect(reg2.resolve('canvas-image').source).toBe('local');
    });
  });

  describe('aggregate helpers', () => {
    it('disabledSlugs lists everything off', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs()); // only canvas-code on
      const disabled = reg.disabledSlugs();
      expect(disabled).toContain('canvas-image');
      expect(disabled).not.toContain('canvas-code');
    });
    it('availableCommands reflects enabled capabilities', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['figma'] }));
      expect(reg.availableCommands()).toContain('figma');
      expect(reg.availableCommands()).not.toContain('video');
    });
    it('capabilityForCommand maps a verb to its slug', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs());
      expect(reg.capabilityForCommand('video')).toBe('canvas-video');
      expect(reg.capabilityForCommand('nope')).toBeUndefined();
    });
    it('all() returns one status per capability', () => {
      const reg = new CanvasCapabilityRegistry(makeInputs());
      expect(reg.all()).toHaveLength(CAPABILITY_DEFS.length);
    });
  });
});

/**
 * Plan 22 Phase 6 — the chips tell the truth, and a capability that is off
 * offers a connect card instead of failing obscurely at the call site.
 */
describe('capability chips (canvas/caps)', () => {
  it('reports real status for the top-bar chips, in order', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['fal_ai'] }));
    expect(reg.chips().map(c => [c.label, c.enabled, c.source])).toEqual([
      ['fal', true, 'deepmyst'],
      ['Stitch', false, 'off'],
      ['Figma', false, 'off'],
    ]);
    expect(CANVAS_CHIP_SLUGS).toEqual(['canvas-image', 'canvas-screens', 'figma']);
  });

  it('a disabled chip carries the slug the connect card is opened with', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs());
    const bySlug = Object.fromEntries(reg.chips().map(c => [c.slug, c]));
    expect(bySlug['canvas-image'].connectSlug).toBe('fal');
    expect(bySlug['canvas-screens'].connectSlug).toBe('stitch');
    expect(bySlug['figma'].connectSlug).toBe('figma');
  });

  it('an ENABLED chip never carries a connect slug (nothing to connect)', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['fal_ai', 'figma'] }));
    for (const chip of reg.chips()) {
      if (chip.enabled) { expect(chip.connectSlug).toBeUndefined(); }
    }
  });

  it('offers no connect affordance for a capability with no hub route', () => {
    // canvas-code is localAlways with no hubConnection: a "Connect" button
    // there would be a button that cannot do anything.
    const reg = new CanvasCapabilityRegistry(makeInputs({ prefs: { 'canvas-code': 'off' } }));
    const [chip] = reg.chips(['canvas-code']);
    expect(chip.enabled).toBe(false);
    expect(chip.connectSlug).toBeUndefined();
  });

  it('chips can be requested for any subset without changing resolution', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs({ localKeys: ['fal'] }));
    expect(reg.chips(['canvas-video'])).toEqual([
      { slug: 'canvas-video', label: 'fal video', enabled: true, source: 'local' },
    ]);
  });
});

describe('connect refusals', () => {
  it('never emits the CAPABILITY slug as a connect slug — no connection is called "canvas-image"', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs());
    const refusal = reg.refusal('canvas-image');
    expect(refusal.marker).toBe('<<<MYSTI_CONNECT:fal>>>');
    expect(refusal.marker).not.toContain('canvas-image');
    expect(refusal.text).toContain(refusal.error);
    expect(refusal.text).toContain('<<<MYSTI_CONNECT:fal>>>');
  });

  it('mentions the local BYO-key alternative only when there is one', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs());
    expect(reg.refusal('canvas-image').error).toMatch(/local openai API key/);
    expect(reg.refusal('figma').error).not.toMatch(/API key/);
  });

  it('takes the caller`s verb so the message names what was actually asked for', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs());
    expect(reg.refusal('canvas-video', { verb: 'video generation' }).error).toMatch(/^video generation is not connected/);
  });

  it('has no marker at all when the capability cannot be connected', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs({ prefs: { 'canvas-code': 'off' } }));
    const refusal = reg.refusal('canvas-code');
    expect(refusal.marker).toBeUndefined();
    expect(refusal.text).toBe(refusal.error);
    expect(refusal.text).not.toContain('MYSTI_CONNECT');
  });

  it('require() is null while the capability works and a refusal the moment it does not', () => {
    const on = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['fal_ai'] }));
    expect(on.require('canvas-image')).toBeNull();
    const off = new CanvasCapabilityRegistry(makeInputs());
    expect(off.require('canvas-image')?.marker).toBe('<<<MYSTI_CONNECT:fal>>>');
  });

  it('isCommandAvailable hides a verb whose capability is off', () => {
    const reg = new CanvasCapabilityRegistry(makeInputs({ hubConnected: ['figma'] }));
    expect(reg.isCommandAvailable('figma')).toBe(true);
    expect(reg.isCommandAvailable('video')).toBe(false);
    expect(reg.isCommandAvailable('not-a-verb')).toBe(false);
  });

  it('connectMarkerFor is the one marker spelling', () => {
    expect(connectMarkerFor('stitch')).toBe('<<<MYSTI_CONNECT:stitch>>>');
  });
});

describe('hub needles', () => {
  it('are derived from the defs, so the probe cannot hold a drifting copy', () => {
    expect(HUB_NEEDLE_BY_CONNECTION).toEqual({
      'fal_ai': 'fal',
      'neversight/stitch': 'stitch',
      'figma': 'figma',
      'canva': 'canva',
    });
    // Every brokerable capability has a needle; the local-only one does not.
    for (const def of CAPABILITY_DEFS) {
      if (def.hubConnection) { expect(HUB_NEEDLE_BY_CONNECTION[def.hubConnection]).toBe(def.connectSlug); }
      else { expect(def.connectSlug).toBeUndefined(); }
    }
  });
});
