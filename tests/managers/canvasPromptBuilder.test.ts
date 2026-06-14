/**
 * CanvasPromptBuilder tests — the stateful canvas block injected into the design
 * sub-agent's system prompt (artifact index + format guidance + rules + tools +
 * approval mode + capability gating).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasCapabilityRegistry } from '../../src/managers/CanvasCapabilityRegistry';
import type { CapabilityInputs } from '../../src/managers/CanvasCapabilityRegistry';
import { buildCanvasContextBlock, buildCanvasToolGuide } from '../../src/managers/CanvasPromptBuilder';
import type { CanvasArtifact } from '../../src/types';

function registry(over: { hub?: string[]; keys?: string[] } = {}): CanvasCapabilityRegistry {
  const hub = new Set(over.hub ?? []);
  const keys = new Set(over.keys ?? []);
  const inputs: CapabilityInputs = {
    isHubConnected: (s) => hub.has(s),
    hasLocalKey: (k) => keys.has(k),
    getPreference: () => 'auto',
  };
  return new CanvasCapabilityRegistry(inputs);
}

describe('CanvasPromptBuilder', () => {
  let store: ArtifactStore;
  let artifact: CanvasArtifact;

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    artifact = store.createArtifact({ name: 'Pitch', kind: 'deck' });
    store.insertPage(artifact, store.makePage({ mode: 'html', htmlSource: '<h1>Hi</h1>', actionTitle: 'Cover' }));
  });

  it('buildCanvasToolGuide lists READ-ONLY and WRITE tools', () => {
    const guide = buildCanvasToolGuide();
    expect(guide).toContain('READ-ONLY tools:');
    expect(guide).toContain('read_page');
    expect(guide).toContain('WRITE tools');
    expect(guide).toContain('write_page_jsx');
  });

  it('includes the artifact index and the format layout guidance', () => {
    const block = buildCanvasContextBlock({ artifact, approvalMode: 'staged' });
    expect(block).toContain('## Canvas state');
    expect(block).toContain('pages=1');
    expect(block).toContain('Cover');
    expect(block).toContain('Layout guidance');
    expect(block).toContain('deck-16x9');
  });

  it('states the read-before-write and no-past-tense rules', () => {
    const block = buildCanvasContextBlock({ artifact, approvalMode: 'staged' });
    expect(block).toContain('read_page');
    expect(block).toContain('baseVersion');
    expect(block.toLowerCase()).toContain('past tense');
    expect(block).toContain('validate_page');
  });

  it('describes the approval mode (staged vs auto)', () => {
    expect(buildCanvasContextBlock({ artifact, approvalMode: 'staged' })).toContain('STAGED');
    expect(buildCanvasContextBlock({ artifact, approvalMode: 'auto' })).toContain('AUTO');
  });

  it('omits the tool guide when includeToolGuide is false', () => {
    const block = buildCanvasContextBlock({ artifact, approvalMode: 'auto', includeToolGuide: false });
    expect(block).not.toContain('READ-ONLY tools:');
  });

  it('gates generation guidance on the registry', () => {
    const withFal = buildCanvasContextBlock({ artifact, approvalMode: 'auto', registry: registry({ hub: ['fal_ai'] }) });
    expect(withFal).toContain('Generation capabilities available:');
    expect(withFal).toContain('generate'); // canvas-image command
    expect(withFal).toContain('Not connected'); // figma/canva etc. still off

    // canvas-code is always-on (CLI provider), so a bare registry still lists
    // 'code' as available and flags the connectable capabilities as not-connected.
    const bare = buildCanvasContextBlock({ artifact, approvalMode: 'auto', registry: registry() });
    expect(bare).toContain('Generation capabilities available:');
    expect(bare).toContain('code');
    expect(bare).toContain('Not connected');
    expect(bare).toContain('canvas-image');
  });
});
