/**
 * Plan 22 — redo of a V2 op must not run through the LEGACY apply switch.
 *
 * `_mirrorToOpLog` stores a V2 op as `proposedValue` under a lossy legacy
 * `kind` so `CanvasHistory` (which ingests the op log) can see element ops.
 * Redo then replayed that record through the legacy switch, which read the op
 * ENVELOPE as a legacy payload: `theme.set` overwrote `artifact.theme` with
 * `{op:'theme.set', theme:{…}}` — and that corrupted object is what the next
 * save persists, so every colour read goes undefined and the design renders
 * unstyled. Undo was always correct (it prefers `record.inverse`); only redo
 * was wrong, and no existing test drove the V2 submit surface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import { CanvasJobRouter } from '../../src/managers/CanvasJobRouter';
import { CanvasOpExecutor } from '../../src/managers/CanvasOpExecutor';
import { CanvasHistory } from '../../src/canvas/CanvasHistory';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import type { CanvasArtifact } from '../../src/types';

describe('redo of a V2 op (OPLOG-1)', () => {
  let store: ArtifactStore;
  let executor: CanvasOpExecutor;
  let history: CanvasHistory;
  let artifact: CanvasArtifact;

  beforeEach(() => {
    store = new ArtifactStore({ getRoot: () => null });
    executor = new CanvasOpExecutor(store, new CanvasJobRouter(() => {}));
    artifact = store.createArtifact({ name: 'Redo', kind: 'screens' });
    history = new CanvasHistory(artifact, executor, { jobId: 'j1' });
  });

  function submit(op: Parameters<CanvasOpExecutor['submitOp']>[1]) {
    return executor.submitOp(artifact, op, 'j1', 'auto');
  }

  it('restores a real theme object, not the op envelope', () => {
    const theme = getThemePreset('midnight')!.theme;
    submit({ op: { op: 'theme.set', theme }, runId: 'r1', author: 'user', actorId: 'test' });
    expect(artifact.theme.colors.background).toBe(theme.colors.background);

    history.undo();
    history.redo();

    // The bug produced `{ op: 'theme.set', theme: {...} }` here.
    expect((artifact.theme as unknown as Record<string, unknown>).op).toBeUndefined();
    expect(artifact.theme.colors.background).toBe(theme.colors.background);
  });

  it('restores an added artboard with its document intact, not blank', () => {
    const doc = { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Sign in' }] };
    submit({ op: { op: 'page.add', page: { doc, actionTitle: 'Login' } }, runId: 'r1', author: 'user', actorId: 'test' });
    const pageId = artifact.pages[0].id;

    history.undo();
    expect(artifact.pages).toHaveLength(0);

    history.redo();
    expect(artifact.pages).toHaveLength(1);
    expect(artifact.pages[0].id).toBe(pageId);
    expect(artifact.pages[0].actionTitle).toBe('Login');
    // The bug returned a freshly-minted blank {mid, tag:'UI.Screen'}.
    expect(artifact.pages[0].doc.children ?? []).toHaveLength(1);
  });

  it('redoes an element op instead of throwing', () => {
    const doc = { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Button', props: { label: 'Go' } }] };
    submit({ op: { op: 'page.add', page: { doc, actionTitle: 'P' } }, runId: 'r1', author: 'user', actorId: 'test' });
    const pageId = artifact.pages[0].id;

    submit({ op: { op: 'el.setProp', pageId, mid: 'bbbbbbbbbb', name: 'label', value: 'Continue' }, runId: 'r2', author: 'user', actorId: 'test' });
    const read = () => (artifact.pages[0].doc.children![0].props as Record<string, unknown>).label;
    expect(read()).toBe('Continue');

    history.undo();
    expect(read()).toBe('Go');

    expect(() => history.redo()).not.toThrow();
    expect(read()).toBe('Continue');
  });

  it('stays exact across undo → redo → undo', () => {
    const doc = { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'One' }] };
    submit({ op: { op: 'page.add', page: { doc, actionTitle: 'P' } }, runId: 'r1', author: 'user', actorId: 'test' });
    const pageId = artifact.pages[0].id;
    submit({ op: { op: 'el.setText', pageId, mid: 'bbbbbbbbbb', text: 'Two' }, runId: 'r2', author: 'user', actorId: 'test' });

    const text = () => artifact.pages[0].doc.children![0].text;
    history.undo(); expect(text()).toBe('One');
    history.redo(); expect(text()).toBe('Two');
    // The re-captured inverse must make the SECOND undo correct too.
    history.undo(); expect(text()).toBe('One');
  });
});
