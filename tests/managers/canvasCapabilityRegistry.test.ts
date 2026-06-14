/**
 * CanvasCapabilityRegistry tests — resolving each capability's {enabled, source}
 * from injected hub-connection / local-key / preference inputs, per the verified
 * 2026-06-14 backend mapping (fal/Figma/Canva = Composio, Stitch = Smithery).
 */
import { describe, it, expect } from 'vitest';
import {
  CanvasCapabilityRegistry,
  CAPABILITY_DEFS,
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
